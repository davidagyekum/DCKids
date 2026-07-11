const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('./db');

const app = express();
app.set('trust proxy', 1); // accurate req.ip behind a reverse proxy (nginx/render/etc.)

// Keep the store up through unexpected errors. A single bad request or a stray
// async rejection must never take the whole server down — that's what made the
// entire product catalogue vanish ("No products found") until a manual restart.
// Log loudly, stay alive. Pair this with a process manager in production (see
// DEPLOYMENT.md) so the server also auto-restarts if it ever does exit.
process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', (err && err.stack) ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', (reason && reason.stack) ? reason.stack : reason);
});

const IS_PROD = process.env.NODE_ENV === 'production';
// Comma-separated allowed origins for production, e.g. "https://dckidsbrand.com,https://www.dckidsbrand.com"
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

// ----- Security headers (helmet-equivalent, zero extra deps) -----
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');           // block MIME sniffing
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');                // anti-clickjacking
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-XSS-Protection', '0');                        // modern browsers: rely on CSP, disable legacy auditor
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    if (IS_PROD) {
        // Only send HSTS in prod (over HTTPS); never on localhost http.
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
});

// ----- CORS: strict in production, open in dev -----
if (IS_PROD && ALLOWED_ORIGINS.length) {
    app.use(cors({
        origin: function (origin, cb) {
            // allow same-origin / server-to-server (no Origin header) and whitelisted origins
            if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
            return cb(new Error('Not allowed by CORS'));
        }
    }));
} else {
    app.use(cors()); // dev: allow all
}

app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ limit: '8mb', extended: true }));

// Serve the frontend static files.
// HTML, the service worker, and CSS/JS must never be cached by the browser/proxy.
// Without an explicit Cache-Control, browsers apply heuristic caching based on
// Last-Modified and can serve a stale .css/.js straight from disk cache on a
// normal reload — bypassing the service worker's network-first fetch entirely,
// since fetch() still honors the underlying HTTP cache. Images/fonts cache normally.
app.use(express.static(path.join(__dirname, '..'), {
    setHeaders: function (res, filePath) {
        if (filePath.endsWith('.html') || filePath.endsWith('service-worker.js') ||
            filePath.endsWith('.css') || filePath.endsWith('.js')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

const JWT_SECRET = process.env.JWT_SECRET || 'dckids-super-secret-key-change-in-production';

// Never run in production on the built-in fallback secret: it's public (it's in
// this file), so anyone could forge an admin token and take over. Fail fast so a
// misconfigured deploy can't start insecurely rather than silently.
if (IS_PROD && (!process.env.JWT_SECRET || JWT_SECRET === 'dckids-super-secret-key-change-in-production')) {
    console.error('FATAL: JWT_SECRET must be set to a strong, unique value in production. Refusing to start.');
    process.exit(1);
}

// Sign-in is passwordless: codes arrive by email. A production deploy without a
// Resend key can't deliver codes, which locks every admin out (the codes are
// deliberately NOT logged in production — see request-code). Google sign-in, if
// configured, is a usable fallback, so degrade to a loud warning in that case.
if (IS_PROD && !process.env.RESEND_API_KEY) {
    if ((process.env.GOOGLE_CLIENT_ID || '').trim()) {
        console.warn('WARNING: RESEND_API_KEY is not set — email sign-in codes cannot be delivered. Only "Continue with Google" will work.');
    } else {
        console.error('FATAL: RESEND_API_KEY must be set in production — sign-in codes are emailed and there is no other way in. Refusing to start.');
        process.exit(1);
    }
}

// Unexpected-failure responses: the user gets a generic message; the real error
// (raw SQLite/driver text) goes to the server log only. Driver messages leak
// schema details and mean nothing to shoppers. Deliberate 4xx validation
// messages are unaffected — they're written for users.
function serverError(res, err) {
    console.error('[server error]', (err && err.stack) ? err.stack : err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

// ---------------- Passwordless auth: email (Resend) + code helpers ----------------
const https = require('https');
const crypto = require('crypto');

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM = process.env.RESEND_FROM || 'DC Kids Admin <onboarding@resend.dev>';
const APP_URL = process.env.APP_URL || 'http://localhost:3001';

// Google Sign-In (optional). When GOOGLE_CLIENT_ID is set, the admin login page
// shows a "Continue with Google" button; when unset, the button is hidden and
// email-OTP remains the only path. The client id is public (safe to expose to
// the browser) — there is no client secret because we use the ID-token flow.
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();

// Owner allowlist: a comma-separated list of emails in OWNER_EMAIL that are
// auto-activated as owner (manager) on sign-up — e.g. your dev email now plus
// the real admin's email at deploy. Everyone else goes to 'pending' and must be
// approved. If OWNER_EMAIL is unset, we fall back to "first sign-up = owner" so
// a fresh install still bootstraps (a startup warning nudges you to set it).
const OWNER_EMAILS = (process.env.OWNER_EMAIL || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
if (OWNER_EMAILS.length === 0) {
    console.warn('[auth] OWNER_EMAIL is not set — the FIRST sign-up will auto-become owner. Set OWNER_EMAIL in server/.env to lock owner claims to specific addresses.');
}

// Send an email via Resend's REST API using only the built-in https module (no
// extra dependency). Fully graceful: a missing key or a failed send is logged
// and swallowed — email problems must never break registration or sign-in.
function sendEmail(to, subject, html) {
    return new Promise((resolve) => {
        if (!RESEND_API_KEY) {
            console.log(`[email skipped: no RESEND_API_KEY] to=${to} subject="${subject}"`);
            return resolve({ skipped: true });
        }
        const payload = JSON.stringify({ from: RESEND_FROM, to: [to], subject, html });
        const request = https.request({
            hostname: 'api.resend.com',
            path: '/emails',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + RESEND_API_KEY,
                'Content-Length': Buffer.byteLength(payload)
            }
        }, (r) => {
            let body = '';
            r.on('data', (d) => { body += d; });
            r.on('end', () => {
                if (r.statusCode >= 200 && r.statusCode < 300) resolve({ ok: true });
                else { console.error(`[email failed ${r.statusCode}] ${body}`); resolve({ ok: false }); }
            });
        });
        request.on('error', (e) => { console.error('[email error]', e.message); resolve({ ok: false }); });
        request.write(payload);
        request.end();
    });
}

function escapeHtmlServer(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function genOtp() {
    return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}
function genRecoveryPlain() {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 hex chars
    return raw.slice(0, 5) + '-' + raw.slice(5);
}
// Generate N fresh recovery codes for a user, store them hashed, return the
// plaintext once (the only time they exist unhashed).
async function generateRecoveryCodes(userId, n = 8) {
    return new Promise((resolve) => {
        db.run(`DELETE FROM recovery_codes WHERE user_id = ?`, [userId], async () => {
            const codes = [];
            for (let i = 0; i < n; i++) {
                const c = genRecoveryPlain();
                codes.push(c);
                const h = await bcrypt.hash(c, 10);
                db.run(`INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)`, [userId, h]);
            }
            resolve(codes);
        });
    });
}
function notifyManagersOfRequest(name, mail) {
    db.all(`SELECT email FROM users WHERE role = 'manager' AND status = 'active' AND email IS NOT NULL`, [], (e, rows) => {
        if (e || !rows) return;
        rows.forEach((r) => sendEmail(
            r.email,
            'New DC Kids admin access request',
            `<p><strong>${escapeHtmlServer(name)}</strong> (${escapeHtmlServer(mail)}) has requested admin access.</p>
             <p>Approve or reject it in <a href="${APP_URL}/admin.html">Manage Staff &rsaquo; Access Requests</a>.</p>`
        ));
    });
}
// Verify a Google ID token (JWT credential from Google Identity Services) via
// Google's tokeninfo endpoint — no extra dependency, matching the raw-https
// approach used for email. Returns the token payload if it is genuinely
// Google-issued, aimed at OUR client id, and carries a verified email;
// otherwise null. Volume here is a handful of admin sign-ins a day, well within
// tokeninfo's limits (local JWKS verification would be the move at high volume).
function verifyGoogleIdToken(idToken) {
    return new Promise((resolve) => {
        if (!GOOGLE_CLIENT_ID || !idToken) return resolve(null);
        const request = https.request({
            hostname: 'oauth2.googleapis.com',
            path: '/tokeninfo?id_token=' + encodeURIComponent(idToken),
            method: 'GET'
        }, (r) => {
            let body = '';
            r.on('data', (d) => { body += d; });
            r.on('end', () => {
                if (r.statusCode !== 200) return resolve(null);
                try {
                    const p = JSON.parse(body);
                    const audOk = p.aud === GOOGLE_CLIENT_ID;
                    const issOk = p.iss === 'accounts.google.com' || p.iss === 'https://accounts.google.com';
                    const emailOk = p.email && (p.email_verified === true || p.email_verified === 'true');
                    const notExpired = !p.exp || (Number(p.exp) * 1000 > Date.now());
                    if (audOk && issOk && emailOk && notExpired) return resolve(p);
                    resolve(null);
                } catch (e) { resolve(null); }
            });
        });
        request.on('error', () => resolve(null));
        request.end();
    });
}

function otpEmailHtml(code) {
    return `<div style="font-family:Inter,Arial,sans-serif;max-width:460px">
      <h2 style="margin:0 0 8px">Your sign-in code</h2>
      <p style="color:#555;margin:0 0 16px">Enter this code to sign in to the DC Kids admin dashboard. It expires in 10 minutes.</p>
      <div style="font-size:32px;font-weight:800;letter-spacing:8px;background:#f6f6f8;border-radius:12px;padding:16px 0;text-align:center">${code}</div>
      <p style="color:#999;font-size:12px;margin-top:16px">If you didn't request this, you can ignore this email.</p>
    </div>`;
}

// Basic in-memory rate limiting to prevent API abuse (disabled for localhost)
const rateLimit = {};
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
// Tight in production to blunt abuse; generous in dev for smooth iteration.
const MAX_REQUESTS_PER_WINDOW = IS_PROD ? 120 : 1000;

// Periodically drop stale entries so the in-memory map can't grow unbounded over
// the process lifetime. (Single-instance mitigation; for multiple instances move
// rate limiting to a shared store like Redis.) unref() so it never holds the
// process open on its own.
setInterval(() => {
    const now = Date.now();
    for (const ip in rateLimit) {
        if (now - rateLimit[ip].firstRequest > RATE_LIMIT_WINDOW_MS) delete rateLimit[ip];
    }
}, 5 * 60 * 1000).unref();

app.use((req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || '';
    // Skip rate limit for localhost/loopback addresses
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
        return next();
    }
    
    const now = Date.now();
    if (!rateLimit[ip]) {
        rateLimit[ip] = { count: 1, firstRequest: now };
    } else {
        if (now - rateLimit[ip].firstRequest > RATE_LIMIT_WINDOW_MS) {
            rateLimit[ip] = { count: 1, firstRequest: now };
        } else {
            rateLimit[ip].count++;
            if (rateLimit[ip].count > MAX_REQUESTS_PER_WINDOW) {
                return res.status(429).json({ error: 'Too many requests, please try again later.' });
            }
        }
    }
    next();
});

// Per-endpoint attempt limiter for abuse-sensitive routes (credential guessing,
// order-tracking enumeration, review spam). The global limiter above still
// allows ~120 req/min in production — plenty for password guessing — so these
// routes get their own much tighter buckets. Localhost is exempt, same as the
// global limiter, so development stays friction-free.
function makeAttemptLimiter(maxAttempts, windowMs, message) {
    const buckets = {};
    setInterval(() => {
        const now = Date.now();
        for (const k in buckets) if (now - buckets[k].first > windowMs) delete buckets[k];
    }, 5 * 60 * 1000).unref();
    return (req, res, next) => {
        const ip = req.ip || req.connection.remoteAddress || '';
        if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
        const now = Date.now();
        const b = buckets[ip];
        if (!b || now - b.first > windowMs) {
            buckets[ip] = { count: 1, first: now };
            return next();
        }
        b.count++;
        if (b.count > maxAttempts) return res.status(429).json({ error: message });
        next();
    };
}
const loginLimiter    = makeAttemptLimiter(10, 15 * 60 * 1000, 'Too many login attempts. Try again in 15 minutes.');
const registerLimiter = makeAttemptLimiter(5, 60 * 60 * 1000, 'Too many registration attempts. Try again later.');
const trackLimiter    = makeAttemptLimiter(30, 15 * 60 * 1000, 'Too many tracking lookups. Try again shortly.');
const reviewLimiter   = makeAttemptLimiter(10, 60 * 60 * 1000, 'Too many reviews submitted. Try again later.');

// JWT Middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    // Always answer with JSON — the admin client does res.json() on every reply,
    // and a plain-text "Unauthorized"/"Forbidden" body throws a confusing
    // "Unexpected token 'F'" parse error that masked expired sessions.
    if (token == null) return res.status(401).json({ error: 'Authentication required' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid or expired session' });
        req.user = user;
        next();
    });
};

const requireManager = (req, res, next) => {
    if (req.user.role !== 'manager') {
        return res.status(403).json({ error: 'Manager access required.' });
    }
    next();
};

// ---------------- AUTH ROUTES (passwordless: email OTP + recovery) ---------------- //

// Request access (public). Emails on the OWNER_EMAIL allowlist are auto-activated
// as owner (manager) and shown recovery codes once; everyone else is created
// 'pending' and must be approved by a manager. No passwords are collected.
app.post('/api/admin/register', registerLimiter, (req, res) => {
    const { full_name, email, phone } = req.body || {};
    const name = String(full_name || '').trim();
    const mail = String(email || '').trim().toLowerCase();
    if (name.length < 2 || name.length > 100) return res.status(400).json({ error: 'Please enter your full name' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail) || mail.length > 254) return res.status(400).json({ error: 'Please enter a valid email address' });

    db.get(`SELECT COUNT(*) AS c FROM users WHERE status = 'active' AND role = 'manager'`, [], (err, row) => {
        if (err) return serverError(res, err);
        // An email on the allowlist is always an owner. Without an allowlist,
        // fall back to "first sign-up = owner" so a fresh install bootstraps.
        const isOwner = OWNER_EMAILS.length > 0
            ? OWNER_EMAILS.includes(mail)
            : (!row || row.c === 0);
        const status = isOwner ? 'active' : 'pending';
        const role = isOwner ? 'manager' : 'staff';
        db.run(
            `INSERT INTO users (username, password_hash, role, email, full_name, phone, status, created_at)
             VALUES (?, NULL, ?, ?, ?, ?, ?, datetime('now'))`,
            [mail, role, mail, name, String(phone || '').trim() || null, status],
            async function (e2) {
                if (e2) {
                    if (String(e2.message).includes('UNIQUE')) {
                        return res.status(409).json({ error: 'An account with this email already exists' });
                    }
                    return serverError(res, e2);
                }
                const userId = this.lastID;
                if (isOwner) {
                    const recoveryCodes = await generateRecoveryCodes(userId);
                    db.run(`UPDATE users SET recovery_shown = 1 WHERE id = ?`, [userId]);
                    sendEmail(mail, 'Your DC Kids admin account is ready',
                        `<p>Hi ${escapeHtmlServer(name)}, your owner account is active.</p><p>Sign in at <a href="${APP_URL}/admin.html">${APP_URL}/admin.html</a> — we'll email you a 6-digit code each time.</p>`);
                    return res.status(201).json({
                        success: true, owner: true,
                        message: 'Your owner account is active. Save your recovery codes below, then sign in with an email code.',
                        recoveryCodes
                    });
                }
                sendEmail(mail, 'DC Kids admin access requested',
                    `<p>Hi ${escapeHtmlServer(name)}, we received your request for admin access.</p><p>A manager will review it, and you'll be able to sign in once you're approved.</p>`);
                notifyManagersOfRequest(name, mail);
                return res.status(201).json({ success: true, owner: false, message: 'Request submitted — a manager will review it.' });
            }
        );
    });
});

// Step 1 of sign-in: email a 6-digit code to an ACTIVE account.
app.post('/api/auth/request-code', loginLimiter, (req, res) => {
    const mail = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return res.status(400).json({ error: 'Enter a valid email.' });
    db.get(`SELECT * FROM users WHERE email = ?`, [mail], async (err, user) => {
        if (err) return serverError(res, err);
        // Don't reveal whether an email exists, but be clear on pending/rejected.
        if (!user) return res.json({ success: true, message: 'If that email has access, a code has been sent.' });
        if (user.status === 'pending') return res.status(403).json({ error: 'Your access request is still awaiting approval.' });
        if (user.status === 'rejected') return res.status(403).json({ error: 'Your access request was declined.' });
        if (user.status !== 'active') return res.status(403).json({ error: 'This account is not active.' });

        const code = genOtp();
        const codeHash = await bcrypt.hash(code, 10);
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
        db.run(`DELETE FROM auth_codes WHERE user_id = ?`, [user.id], () => {
            db.run(`INSERT INTO auth_codes (user_id, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0)`,
                [user.id, codeHash, expiresAt], (e2) => {
                    if (e2) return serverError(res, e2);
                    // Operator-visible in development so the flow is testable
                    // without email (and in Resend test mode, where email only
                    // delivers to your own address). NEVER in production:
                    // logging live sign-in codes would let anyone with log
                    // access take over any admin account.
                    if (!IS_PROD) console.log(`\n[SIGN-IN CODE] ${mail} -> ${code}  (valid 10 min)\n`);
                    sendEmail(mail, 'Your DC Kids admin sign-in code', otpEmailHtml(code));
                    res.json({ success: true, message: 'A 6-digit code has been sent to your email.' });
                });
        });
    });
});

// Step 2 of sign-in: verify the code and issue a session.
app.post('/api/auth/verify-code', loginLimiter, (req, res) => {
    const mail = String((req.body && req.body.email) || '').trim().toLowerCase();
    const code = String((req.body && req.body.code) || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail) || !/^\d{6}$/.test(code)) {
        return res.status(400).json({ error: 'Enter the 6-digit code.' });
    }
    db.get(
        `SELECT u.*, c.id AS code_id, c.code_hash, c.expires_at, c.attempts
         FROM users u JOIN auth_codes c ON c.user_id = u.id
         WHERE u.email = ? ORDER BY c.id DESC LIMIT 1`,
        [mail],
        async (err, row) => {
            if (err) return serverError(res, err);
            if (!row) return res.status(400).json({ error: 'No code found. Request a new one.' });
            if (row.status !== 'active') return res.status(403).json({ error: 'This account is not active.' });
            if (new Date(row.expires_at).getTime() < Date.now()) {
                db.run(`DELETE FROM auth_codes WHERE id = ?`, [row.code_id]);
                return res.status(400).json({ error: 'Code expired. Request a new one.' });
            }
            if (row.attempts >= 5) {
                db.run(`DELETE FROM auth_codes WHERE id = ?`, [row.code_id]);
                return res.status(429).json({ error: 'Too many attempts. Request a new code.' });
            }
            const ok = await bcrypt.compare(code, row.code_hash);
            if (!ok) {
                db.run(`UPDATE auth_codes SET attempts = attempts + 1 WHERE id = ?`, [row.code_id]);
                return res.status(400).json({ error: 'Incorrect code.' });
            }
            db.run(`DELETE FROM auth_codes WHERE user_id = ?`, [row.id]);
            const accessToken = jwt.sign({ id: row.id, username: row.email, role: row.role }, JWT_SECRET, { expiresIn: '12h' });
            let recoveryCodes = null;
            if (!row.recovery_shown) {
                recoveryCodes = await generateRecoveryCodes(row.id);
                db.run(`UPDATE users SET recovery_shown = 1 WHERE id = ?`, [row.id]);
            }
            res.json({ accessToken, role: row.role, recoveryCodes });
        }
    );
});

// Backup sign-in with a one-time recovery code (if email is unavailable).
app.post('/api/auth/recovery', loginLimiter, (req, res) => {
    const mail = String((req.body && req.body.email) || '').trim().toLowerCase();
    const rc = String((req.body && req.body.code) || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!mail || !rc) return res.status(400).json({ error: 'Enter your email and a recovery code.' });
    db.get(`SELECT * FROM users WHERE email = ? AND status = 'active'`, [mail], (err, user) => {
        if (err) return serverError(res, err);
        if (!user) return res.status(400).json({ error: 'Invalid email or recovery code.' });
        db.all(`SELECT id, code_hash FROM recovery_codes WHERE user_id = ? AND used_at IS NULL`, [user.id], async (e2, rows) => {
            if (e2) return serverError(res, e2);
            for (const r of (rows || [])) {
                if (await bcrypt.compare(rc, r.code_hash)) {
                    db.run(`UPDATE recovery_codes SET used_at = datetime('now') WHERE id = ?`, [r.id]);
                    const accessToken = jwt.sign({ id: user.id, username: user.email, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
                    return res.json({ accessToken, role: user.role });
                }
            }
            res.status(400).json({ error: 'Invalid email or recovery code.' });
        });
    });
});

// Public: tells the admin login page whether Google Sign-In is available (and
// with which client id). Returns null when unconfigured so the page silently
// falls back to email-OTP. The client id is not a secret.
app.get('/api/auth/config', (req, res) => {
    res.json({ googleClientId: GOOGLE_CLIENT_ID || null });
});

// Primary sign-in: "Continue with Google". Verifies the Google ID token, then
// applies the SAME access gate as the OTP flow — active signs in, pending/
// rejected are refused, and an unknown email becomes a pending access request
// (so one tap both requests access and, once approved, logs in). An allowlisted
// OWNER_EMAIL is auto-activated as owner on first sign-in, mirroring /register.
app.post('/api/auth/google', loginLimiter, async (req, res) => {
    if (!GOOGLE_CLIENT_ID) return res.status(400).json({ error: 'Google sign-in is not configured.' });
    const credential = String((req.body && req.body.credential) || '');
    const payload = await verifyGoogleIdToken(credential);
    if (!payload) return res.status(401).json({ error: 'Google sign-in failed. Please try again.' });

    const mail = String(payload.email).trim().toLowerCase();
    const name = String(payload.name || '').trim() || mail;
    const sub = payload.sub || null;

    db.get(`SELECT * FROM users WHERE email = ?`, [mail], async (err, user) => {
        if (err) return serverError(res, err);

        if (!user) {
            const isOwner = OWNER_EMAILS.includes(mail);
            const status = isOwner ? 'active' : 'pending';
            const role = isOwner ? 'manager' : 'staff';
            db.run(
                `INSERT INTO users (username, password_hash, role, email, full_name, phone, status, google_sub, created_at)
                 VALUES (?, NULL, ?, ?, ?, NULL, ?, ?, datetime('now'))`,
                [mail, role, mail, name, status, sub],
                async function (e2) {
                    if (e2) return serverError(res, e2);
                    const userId = this.lastID;
                    if (isOwner) {
                        const recoveryCodes = await generateRecoveryCodes(userId);
                        db.run(`UPDATE users SET recovery_shown = 1 WHERE id = ?`, [userId]);
                        const accessToken = jwt.sign({ id: userId, username: mail, role }, JWT_SECRET, { expiresIn: '12h' });
                        return res.json({ accessToken, role, recoveryCodes });
                    }
                    notifyManagersOfRequest(name, mail);
                    return res.status(403).json({ error: 'Access requested — an owner needs to approve your account before you can sign in.' });
                }
            );
            return;
        }

        if (user.status === 'pending') return res.status(403).json({ error: 'Your access request is still awaiting approval.' });
        if (user.status === 'rejected') return res.status(403).json({ error: 'Your access request was declined.' });
        if (user.status !== 'active') return res.status(403).json({ error: 'This account is not active.' });

        if (sub && !user.google_sub) db.run(`UPDATE users SET google_sub = ? WHERE id = ?`, [sub, user.id]);

        let recoveryCodes = null;
        if (!user.recovery_shown) {
            recoveryCodes = await generateRecoveryCodes(user.id);
            db.run(`UPDATE users SET recovery_shown = 1 WHERE id = ?`, [user.id]);
        }
        const accessToken = jwt.sign({ id: user.id, username: user.email, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
        res.json({ accessToken, role: user.role, recoveryCodes });
    });
});

// Pending access requests (owner/manager only)
app.get('/api/admin/access-requests', authenticateToken, requireManager, (req, res) => {
    db.all(
        `SELECT id, full_name, email, phone, created_at FROM users WHERE status = 'pending' ORDER BY id DESC`,
        [],
        (err, rows) => {
            if (err) return serverError(res, err);
            res.json(rows);
        }
    );
});

app.post('/api/admin/access-requests/:id/approve', authenticateToken, requireManager, (req, res) => {
    const role = (req.body && req.body.role) === 'manager' ? 'manager' : 'staff';
    db.run(
        `UPDATE users SET status = 'active', role = ? WHERE id = ? AND status = 'pending'`,
        [role, req.params.id],
        function (err) {
            if (err) return serverError(res, err);
            if (this.changes === 0) return res.status(404).json({ error: 'Request not found or already handled' });
            res.json({ success: true, role });
        }
    );
});

app.post('/api/admin/access-requests/:id/reject', authenticateToken, requireManager, (req, res) => {
    db.run(
        `UPDATE users SET status = 'rejected' WHERE id = ? AND status = 'pending'`,
        [req.params.id],
        function (err) {
            if (err) return serverError(res, err);
            if (this.changes === 0) return res.status(404).json({ error: 'Request not found or already handled' });
            res.json({ success: true });
        }
    );
});

// ---------------- PUBLIC ROUTES ---------------- //
app.get('/api/products', (req, res) => {
    // Backward-compatible: with no query params, return the full array (the storefront
    // expects this). Pass ?page= or ?limit= to opt into a paginated envelope —
    // keeps the homepage payload small once the catalogue grows large.
    const hasPaging = req.query.page !== undefined || req.query.limit !== undefined;

    if (!hasPaging) {
        return db.all(`SELECT * FROM products`, [], (err, rows) => {
            if (err) return serverError(res, err);
            res.json(rows);
        });
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const offset = (page - 1) * limit;
    const cat = req.query.cat;

    const where = cat ? 'WHERE cat = ?' : '';
    const countParams = cat ? [cat] : [];
    const pageParams = cat ? [cat, limit, offset] : [limit, offset];

    db.get(`SELECT COUNT(*) AS total FROM products ${where}`, countParams, (err, countRow) => {
        if (err) return serverError(res, err);
        db.all(`SELECT * FROM products ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, pageParams, (err2, rows) => {
            if (err2) return serverError(res, err2);
            const total = (countRow && countRow.total) || 0;
            res.json({ products: rows, total, page, limit, pages: Math.ceil(total / limit) });
        });
    });
});

app.get('/api/settings', (req, res) => {
    db.get(`SELECT * FROM store_settings WHERE id = 1`, (err, row) => {
        if (err) return serverError(res, err);
        if (!row) {
            // Provide safe defaults if for some reason the db is totally empty
            return res.json({
                whatsapp_number: '233549193805',
                wholesale_enabled: 1,
                wholesale_moq: 10,
                wholesale_discount: 20,
                banner_enabled: 1,
                banner_text: "China Pre-Order Window OPEN! Orders close May 18th — Don't miss out!"
            });
        }
        res.json(row);
    });
});

// ---------------- PROTECTED ROUTES ---------------- //

// Token validation endpoint
app.get('/api/me', authenticateToken, (req, res) => {
    res.json({ id: req.user.id, username: req.user.username, role: req.user.role });
});

// Update store settings (Manager only)
app.put('/api/settings', authenticateToken, requireManager, (req, res) => {
    const { whatsapp_number, wholesale_enabled, wholesale_moq, wholesale_discount, banner_enabled, banner_text } = req.body;
    db.run(
        `UPDATE store_settings 
         SET whatsapp_number = ?, wholesale_enabled = ?, wholesale_moq = ?, wholesale_discount = ?, banner_enabled = ?, banner_text = ? 
         WHERE id = 1`,
        [whatsapp_number, wholesale_enabled ? 1 : 0, wholesale_moq, wholesale_discount, banner_enabled ? 1 : 0, banner_text],
        function(err) {
            if (err) return serverError(res, err);
            res.json({ success: true, message: 'Settings updated successfully' });
        }
    );
});


// A SKU collided with the partial-unique index — surface a clear message
// instead of the raw SQLite "UNIQUE constraint failed" text.
const isDuplicateSku = (err) => err && /UNIQUE constraint failed: products\.sku/.test(err.message);

// Category-prefix + sequential SKU, e.g. "CLO-0001". Walks forward past any
// existing number (including gaps from deleted products or manually-typed
// SKUs) so it always lands on something genuinely free.
const SKU_PREFIXES = { clothing: 'CLO', shoes: 'SHO', accessories: 'ACC', newborn: 'NEW', bedding: 'BED', essentials: 'ESS' };
function skuPrefixFor(cat) {
    return SKU_PREFIXES[cat] || (String(cat || 'GEN').replace(/[^a-zA-Z]/g, '').slice(0, 3).toUpperCase() || 'GEN');
}
function generateSku(cat, callback) {
    const prefix = skuPrefixFor(cat);
    db.all(`SELECT sku FROM products WHERE sku LIKE ?`, [prefix + '-%'], (err, rows) => {
        if (err) return callback(err);
        let maxN = 0;
        (rows || []).forEach(r => {
            const m = /^[A-Z]+-(\d+)$/.exec(r.sku || '');
            if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
        });
        const tryNext = (n) => {
            const candidate = prefix + '-' + String(n).padStart(4, '0');
            db.get(`SELECT 1 FROM products WHERE sku = ?`, [candidate], (err2, row) => {
                if (err2) return callback(err2);
                if (row) return tryNext(n + 1);
                callback(null, candidate);
            });
        };
        tryNext(maxN + 1);
    });
}

// Preview the next auto-assigned SKU for a category, without reserving it.
app.get('/api/products/next-sku', authenticateToken, requireManager, (req, res) => {
    generateSku(req.query.cat, (err, sku) => {
        if (err) return serverError(res, err);
        res.json({ sku });
    });
});

// Admin-managed size variants are stored as a JSON string of
// [{ label, price }]. Normalize whatever the client sends (array or JSON
// string) into a clean string, or null when there are no valid rows.
function normalizeSizes(raw) {
    let arr = raw;
    if (typeof raw === 'string') {
        const t = raw.trim();
        if (!t) return null;
        try { arr = JSON.parse(t); } catch (e) { return null; }
    }
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const clean = arr.map(s => ({
        label: String(s && s.label != null ? s.label : '').trim(),
        price: (s && s.price !== '' && s.price != null && !isNaN(Number(s.price))) ? Number(s.price) : null
    })).filter(s => s.label);
    return clean.length ? JSON.stringify(clean) : null;
}
function parseSizesJson(raw) {
    if (!raw) return null;
    try { const arr = JSON.parse(raw); if (Array.isArray(arr) && arr.length) return arr; } catch (e) { /* malformed sizes JSON → fall back to legacy pricing */ }
    return null;
}

// Add new product (Manager only)
app.post('/api/products', authenticateToken, requireManager, (req, res) => {
    const { name, sku, size, price, img, cat, stock, badge, description, fulfillment_type, sizes } = req.body;
    const sizesJson = normalizeSizes(sizes);
    const insert = (finalSku) => {
        db.run(
            `INSERT INTO products (name, sku, size, price, img, cat, stock, badge, description, fulfillment_type, sizes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [name, finalSku || null, size, price, img, cat, stock, badge, description || null, fulfillment_type || 'in_stock', sizesJson],
            function (err) {
                if (isDuplicateSku(err)) return res.status(409).json({ error: 'That SKU is already in use by another product.' });
                if (err) return serverError(res, err);
                res.json({ id: this.lastID, sku: finalSku || null });
            }
        );
    };
    // Admin left SKU blank — auto-assign one rather than storing nothing.
    if (sku && String(sku).trim()) {
        insert(String(sku).trim());
    } else {
        generateSku(cat, (err, generated) => {
            if (err) return serverError(res, err);
            insert(generated);
        });
    }
});

// Update product (Manager only)
app.put('/api/products/:id', authenticateToken, requireManager, (req, res) => {
    const { name, sku, size, price, img, cat, stock, badge, description, fulfillment_type, sizes } = req.body;
    const sizesJson = normalizeSizes(sizes);
    db.run(
        `UPDATE products SET name = ?, sku = ?, size = ?, price = ?, img = ?, cat = ?, stock = ?, badge = ?, description = ?, fulfillment_type = ?, sizes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [name, sku || null, size, price, img, cat, stock, badge, description || null, fulfillment_type || 'in_stock', sizesJson, req.params.id],
        function (err) {
            if (isDuplicateSku(err)) return res.status(409).json({ error: 'That SKU is already in use by another product.' });
            if (err) return serverError(res, err);
            res.json({ changes: this.changes });
        }
    );
});

// Delete product (Manager only). Order history is untouched on purpose —
// order_items has no FK on product_id and stores its own product_name/price,
// so past orders stay intact even after the product itself is gone. Gallery
// images, reviews, and wishlist entries have no value without the product,
// so they're removed first (the FK on product_id otherwise rejects the delete).
app.delete('/api/products/:id', authenticateToken, requireManager, (req, res) => {
    const productId = req.params.id;
    db.run(`DELETE FROM product_images WHERE product_id = ?`, [productId], (err) => {
        if (err) return serverError(res, err);
        db.run(`DELETE FROM product_reviews WHERE product_id = ?`, [productId], (err2) => {
            if (err2) return serverError(res, err2);
            db.run(`DELETE FROM wishlist_items WHERE product_id = ?`, [productId], (err3) => {
                if (err3) return serverError(res, err3);
                db.run(`DELETE FROM products WHERE id = ?`, [productId], function (err4) {
                    if (err4) return serverError(res, err4);
                    res.json({ changes: this.changes });
                });
            });
        });
    });
});

// Deduct stock (Staff & Manager)
app.put('/api/products/:id/deduct', authenticateToken, (req, res) => {
    const productId = req.params.id;
    const username = req.user.username; // Get the user who is making the request
    
    // Strict Backend Validation: Check current stock first
    db.get(`SELECT stock FROM products WHERE id = ?`, [productId], (err, row) => {
        if (err) return serverError(res, err);
        if (!row) return res.status(404).json({ error: 'Product not found' });
        
        if (row.stock <= 0) {
            return res.status(400).json({ error: 'Stock is already 0. Cannot deduct further.' });
        }

        // Proceed to deduct if stock > 0
        db.run(
            `UPDATE products SET stock = stock - 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [productId],
            function (err) {
                if (err) return serverError(res, err);
                
                // Log the transaction
                db.run(
                    `INSERT INTO transactions (product_id, username, action) VALUES (?, ?, ?)`,
                    [productId, username, 'deduct'],
                    (err) => {
                        if (err) console.error("Error logging transaction:", err);
                        // We still return success even if logging fails
                        res.json({ success: true, changes: this.changes });
                    }
                );
            }
        );
    });
});

// ---------------- SUPPLIER ROUTES ---------------- //
app.get('/api/suppliers', authenticateToken, (req, res) => {
    db.all(`SELECT * FROM suppliers ORDER BY created_at DESC`, (err, suppliers) => {
        if (err) return serverError(res, err);
        res.json(suppliers);
    });
});

app.post('/api/suppliers', authenticateToken, requireManager, (req, res) => {
    const {
        supplier_name,
        contact_person,
        email,
        phone,
        business_address,
        products_supplied,
        status,
        notes,
        supplier_logo
    } = req.body;

    if (!supplier_name || !contact_person || !email || !phone || !business_address || !products_supplied) {
        return res.status(400).json({ error: 'Missing required supplier fields.' });
    }

    db.run(
        `INSERT INTO suppliers
            (supplier_name, contact_person, email, phone, business_address, products_supplied, status, notes, supplier_logo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            supplier_name.trim(),
            contact_person.trim(),
            email.trim().toLowerCase(),
            phone.trim(),
            business_address.trim(),
            products_supplied.trim(),
            status === 'inactive' ? 'inactive' : 'active',
            notes ? notes.trim() : '',
            supplier_logo || ''
        ],
        function(err) {
            if (err) {
                if (err.message && err.message.indexOf('UNIQUE') >= 0) {
                    return res.status(409).json({ error: 'A supplier with this name already exists.' });
                }
                return serverError(res, err);
            }

            db.get(`SELECT * FROM suppliers WHERE id = ?`, [this.lastID], (err, supplier) => {
                if (err) return serverError(res, err);
                res.status(201).json(supplier);
            });
        }
    );
});

app.put('/api/suppliers/:id', authenticateToken, requireManager, (req, res) => {
    const {
        supplier_name,
        contact_person,
        email,
        phone,
        business_address,
        products_supplied,
        status,
        notes,
        supplier_logo
    } = req.body;

    if (!supplier_name || !contact_person || !email || !phone || !business_address || !products_supplied) {
        return res.status(400).json({ error: 'Missing required supplier fields.' });
    }

    db.run(
        `UPDATE suppliers
         SET supplier_name = ?, contact_person = ?, email = ?, phone = ?, business_address = ?,
             products_supplied = ?, status = ?, notes = ?, supplier_logo = ?
         WHERE id = ?`,
        [
            supplier_name.trim(),
            contact_person.trim(),
            email.trim().toLowerCase(),
            phone.trim(),
            business_address.trim(),
            products_supplied.trim(),
            status === 'inactive' ? 'inactive' : 'active',
            notes ? notes.trim() : '',
            supplier_logo || '',
            req.params.id
        ],
        function(err) {
            if (err) {
                if (err.message && err.message.indexOf('UNIQUE') >= 0) {
                    return res.status(409).json({ error: 'A supplier with this name already exists.' });
                }
                return serverError(res, err);
            }
            if (this.changes === 0) return res.status(404).json({ error: 'Supplier not found.' });

            db.get(`SELECT * FROM suppliers WHERE id = ?`, [req.params.id], (err, supplier) => {
                if (err) return serverError(res, err);
                res.json(supplier);
            });
        }
    );
});

// ---------------- USER MANAGEMENT ROUTES (Manager only) ---------------- //
// List all users
app.get('/api/users', authenticateToken, requireManager, (req, res) => {
    db.all(`SELECT id, username, role, email, full_name, phone, status FROM users`, [], (err, rows) => {
        if (err) return serverError(res, err);
        res.json(rows);
    });
});

// Create new user (staff/manager). Passwordless: the account is identified by
// email and immediately active — the person signs in with an emailed 6-digit
// code (or Google), so no password is collected. This is the owner's direct
// "add my staff" path; the public register endpoint is the request/approve one.
app.post('/api/users', authenticateToken, requireManager, (req, res) => {
    const { full_name, email, role } = req.body || {};
    const mail = String(email || '').trim().toLowerCase();
    const name = String(full_name || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail) || mail.length > 254) {
        return res.status(400).json({ error: 'A valid email address is required — staff sign in with a code sent to it' });
    }
    if (name.length < 2 || name.length > 100) {
        return res.status(400).json({ error: 'Please enter the person\'s full name' });
    }
    const finalRole = role === 'manager' ? 'manager' : 'staff';
    db.run(
        `INSERT INTO users (username, password_hash, role, email, full_name, status, created_at)
         VALUES (?, NULL, ?, ?, ?, 'active', datetime('now'))`,
        [mail, finalRole, mail, name],
        function (err) {
            if (err) {
                if (err.message && err.message.indexOf('UNIQUE') >= 0) {
                    return res.status(409).json({ error: 'An account with this email already exists' });
                }
                return serverError(res, err);
            }
            sendEmail(mail, 'You now have DC Kids admin access',
                `<p>Hi ${escapeHtmlServer(name)}, you've been given ${finalRole} access to the DC Kids dashboard.</p>
                 <p>Sign in at <a href="${APP_URL}/admin.html">${APP_URL}/admin.html</a> — we'll email you a 6-digit code each time.</p>`);
            res.status(201).json({ id: this.lastID, email: mail, full_name: name, role: finalRole });
        }
    );
});

// Delete user. Their sign-in codes reference the user row (FK), so they must
// go first — every activated account has recovery codes, and deleting the user
// row alone fails with "FOREIGN KEY constraint failed".
app.delete('/api/users/:id', authenticateToken, requireManager, (req, res) => {
    const userId = req.params.id;

    // Prevent self-deletion
    if (Number(userId) === req.user.id) {
        return res.status(400).json({ error: 'Cannot delete your own logged-in user account' });
    }

    db.run(`DELETE FROM auth_codes WHERE user_id = ?`, [userId], (err) => {
        if (err) return serverError(res, err);
        db.run(`DELETE FROM recovery_codes WHERE user_id = ?`, [userId], (err2) => {
            if (err2) return serverError(res, err2);
            db.run(`DELETE FROM users WHERE id = ?`, [userId], function (err3) {
                if (err3) return serverError(res, err3);
                if (this.changes === 0) return res.status(404).json({ error: 'User not found' });
                res.json({ success: true, message: 'User deleted successfully' });
            });
        });
    });
});

// Helper for backend price calculation
function getPriceModifier(sizeLabel) {
    if (!sizeLabel) return 0;
    const s = sizeLabel.toString().trim();
    if (/^(0-3M|3-6M|6-9M|9-12M|12-18M|0M|3M|6M|9M|12M|14|15|16|17|18|19|20|21)$/i.test(s)) return 0;
    if (/^(18M|24M|1Y|2Y|22|23|24|25|26|27)$/i.test(s)) return 5;
    if (/^(3Y|4Y|5Y|28|29|30|31|32)$/i.test(s)) return 10;
    if (/^(6Y|7Y|8Y|33|34|35|36)$/i.test(s)) return 15;
    return 0;
}

// Create new order (Storefront)
app.post('/api/orders', (req, res) => {
    const { customer_name, customer_phone, order_type, items, payment_method, delivery_area, notes } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'Order must contain items' });
    }
    if (items.length > 50) {
        return res.status(400).json({ error: 'Too many items in one order (max 50)' });
    }
    // Reject bad quantities outright (negative totals) and absurd ones (abuse).
    for (const item of items) {
        if (!Number.isInteger(Number(item.id)) || Number(item.id) < 1) {
            return res.status(400).json({ error: 'Invalid product id in order' });
        }
    }
    const isWholesale = (order_type === 'wholesale');
    // Quantities are PIECES for both modes (wholesale just enforces an MOQ
    // floor below, once settings are loaded). Wholesale gets a higher cap
    // since 10× MOQ is a normal bulk purchase.
    const qtyCap = isWholesale ? 1000 : 100;
    for (const item of items) {
        if (item.quantity != null && (!Number.isInteger(Number(item.quantity)) || Number(item.quantity) < 1 || Number(item.quantity) > qtyCap)) {
            return res.status(400).json({ error: `Quantity must be a whole number between 1 and ${qtyCap}` });
        }
    }
    if (customer_name && String(customer_name).length > 100) return res.status(400).json({ error: 'Name is too long' });
    if (customer_phone && String(customer_phone).length > 30) return res.status(400).json({ error: 'Phone number is too long' });
    if (delivery_area && String(delivery_area).length > 200) return res.status(400).json({ error: 'Delivery area is too long' });
    if (notes && String(notes).length > 1000) return res.status(400).json({ error: 'Notes are too long (max 1000 characters)' });
    
    // 1. Fetch store settings for wholesale math
    db.get(`SELECT * FROM store_settings WHERE id = 1`, (err, settings) => {
        if (err) return serverError(res, err);
        
        const moq = settings ? settings.wholesale_moq : 10;
        const discount = settings ? settings.wholesale_discount : 0;

        let total_amount = 0;
        const processedItems = [];
        
        // We need to fetch product prices asynchronously
        const productPromises = items.map(item => {
            return new Promise((resolve, reject) => {
                db.get(`SELECT * FROM products WHERE id = ?`, [item.id], (err, product) => {
                    if (err) return reject(err);
                    if (!product) return reject(new Error(`Product ${item.id} not found`));
                    
                    // Determine the per-unit retail price for the chosen size.
                    // Managed sizes (admin-set absolute prices) are authoritative;
                    // otherwise fall back to the legacy base price + size modifier.
                    const managedSizes = parseSizesJson(product.sizes);
                    const sizeMatch = managedSizes
                        ? managedSizes.find(s => s.label === item.size)
                        : null;

                    // PER-PIECE pricing for both modes. The storefront sends
                    // quantity in pieces (its bulk dropdown lists "10 pcs",
                    // "20 pcs", ...), so wholesale applies the discount to the
                    // unit price and enforces the MOQ floor — it does NOT
                    // multiply by MOQ again. (The old package-based math
                    // charged a 10-piece wholesale order as 10 packages =
                    // 100 pieces: a 10× overcharge, and stock deducted 10×.)
                    let unitPrice;
                    if (sizeMatch) {
                        unitPrice = (sizeMatch.price != null) ? sizeMatch.price : (product.price || 0);
                        if (isWholesale) unitPrice = unitPrice * (1 - (discount / 100));
                    } else {
                        unitPrice = product.price || 0;
                        if (isWholesale) unitPrice = unitPrice * (1 - (discount / 100));
                        unitPrice += getPriceModifier(item.size);
                    }
                    unitPrice = Math.round(unitPrice * 100) / 100;

                    const finalQty = Number(item.quantity) || 1; // pieces
                    if (isWholesale && finalQty < moq) {
                        const e = new Error(`Wholesale orders need at least ${moq} pieces per item`);
                        e.status = 400;
                        return reject(e);
                    }

                    total_amount += unitPrice * finalQty;

                    processedItems.push({
                        product_id: product.id,
                        product_name: `${product.name} (${item.size || 'Standard'})`,
                        quantity: finalQty,
                        price_at_time: unitPrice
                    });

                    resolve();
                });
            });
        });

        Promise.all(productPromises)
            .then(() => {
                total_amount = Math.round(total_amount * 100) / 100;
                const initialStatus = order_type === 'preorder' ? 'pending_deposit' : 'pending';
                // A temporary unique placeholder satisfies the UNIQUE NOT NULL
                // column until we know the row id; the real order number is then
                // derived from that id, so two orders can never collide. (The old
                // 'ORD-' + Math.random()*9000 had just 9000 possible values.)
                const tempNumber = 'TMP-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);

                db.run(
                    `INSERT INTO orders (order_number, customer_name, customer_phone, order_type, total_amount, status, delivery_area, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [tempNumber, customer_name, customer_phone, order_type, total_amount, initialStatus, delivery_area || null, notes || null],
                    function(err) {
                        if (err) return serverError(res, err);

                        const order_id = this.lastID;
                        const order_number = 'ORD-' + String(10000 + order_id);
                        db.run(`UPDATE orders SET order_number = ? WHERE id = ?`, [order_number, order_id]);

                        const insertItemStmt = db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, quantity, price_at_time) VALUES (?, ?, ?, ?, ?)`);
                        processedItems.forEach(pi => {
                            insertItemStmt.run(order_id, pi.product_id, pi.product_name, pi.quantity, pi.price_at_time);
                        });
                        insertItemStmt.finalize();

                        db.run(
                            `INSERT OR IGNORE INTO customers (name, phone) VALUES (?, ?)`,
                            [customer_name || 'Guest Customer', customer_phone || null]
                        );

                        db.run(
                            `INSERT INTO payments (order_id, payment_method, amount, status) VALUES (?, ?, ?, ?)`,
                            [order_id, payment_method || 'Mobile Money', total_amount, initialStatus === 'pending' ? 'pending' : 'pending_deposit']
                        );

                        // Fire-and-forget WhatsApp alert to the shop owner (graceful)
                        try {
                            const notify = app.get('sendOwnerWhatsAppAlert');
                            if (typeof notify === 'function') {
                                notify({
                                    order_number, customer_name, customer_phone,
                                    order_type, total_amount, delivery_area,
                                    notes, items: processedItems
                                });
                            }
                        } catch (e) { /* never fail an order on notification error */ }

                        res.json({ success: true, order_number, total_amount });
                    }
                );
            })
            .catch(err => {
                // err.status marks a deliberate validation failure (MOQ floor,
                // unknown product) whose message is written for the shopper;
                // anything else is unexpected and stays generic.
                if (err.status) return res.status(err.status).json({ error: err.message });
                serverError(res, err);
            });
    });
});

// List orders (Admin)
app.get('/api/orders', authenticateToken, (req, res) => {
    // Optional server-side pagination keeps this fast no matter how many orders
    // accumulate over the years. Default (no params) still returns the full array
    // so the existing admin UI keeps working unchanged.
    const hasPaging = req.query.page !== undefined || req.query.limit !== undefined;
    let sql = `SELECT * FROM orders ORDER BY created_at DESC`;
    const params = [];
    if (hasPaging) {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        sql += ` LIMIT ? OFFSET ?`;
        params.push(limit, (page - 1) * limit);
    }

    db.all(sql, params, (err, orders) => {
        if (err) return serverError(res, err);
        if (!orders.length) return res.json([]);

        // Single batched query for all items instead of one query per order (N+1).
        const ids = orders.map(o => o.id);
        const placeholders = ids.map(() => '?').join(',');
        db.all(`SELECT * FROM order_items WHERE order_id IN (${placeholders})`, ids, (err2, allItems) => {
            if (err2) return serverError(res, err2);
            const byOrder = {};
            (allItems || []).forEach(it => {
                (byOrder[it.order_id] = byOrder[it.order_id] || []).push(it);
            });
            orders.forEach(o => { o.items = byOrder[o.id] || []; });
            res.json(orders);
        });
    });
});

// Get order item preview details (Admin)
app.get('/api/orders/:id/item-preview', authenticateToken, (req, res) => {
    const orderId = req.params.id;
    
    // Fetch the order
    db.get(`SELECT * FROM orders WHERE id = ?`, [orderId], (err, order) => {
        if (err) return serverError(res, err);
        if (!order) return res.status(404).json({ error: 'Order not found' });
        
        // Fetch order items
        db.all(`SELECT * FROM order_items WHERE order_id = ?`, [orderId], (err, items) => {
            if (err) return serverError(res, err);
            if (!items || items.length === 0) return res.status(404).json({ error: 'No items in this order' });
            
            // Get the first item (primary ordered item to preview)
            const primaryItem = items[0];
            
            // Fetch product details
            db.get(`SELECT * FROM products WHERE id = ?`, [primaryItem.product_id], (err, product) => {
                if (err) return serverError(res, err);
                
                // Fallback details if product doesn't exist anymore
                const pName = product ? product.name : primaryItem.product_name;
                const pImg = product ? product.img : 'images/placeholder.png';
                const pCat = product ? product.cat : 'clothing';
                const pPrice = product ? product.price : primaryItem.price_at_time;
                const pSize = product ? product.size : 'Standard';
                
                // Fetch alternate product images
                db.all(`SELECT image_url FROM product_images WHERE product_id = ?`, [primaryItem.product_id], (err, imgs) => {
                    let gallery = [];
                    if (!err && imgs && imgs.length > 0) {
                        gallery = imgs.map(row => row.image_url);
                    } else {
                        // Fallback gallery: just the main image 4 times
                        gallery = [pImg, pImg, pImg, pImg];
                    }
                    
                    // Parse size/color from order_item's product_name (e.g. "Boutique Romper (3Y)")
                    let color = 'Pink'; // Default fallback
                    let size = '3Y'; // Default fallback
                    
                    // Simple regex/parsing of the size from name
                    const nameMatch = primaryItem.product_name.match(/\(([^)]+)\)/);
                    if (nameMatch && nameMatch[1]) {
                        size = nameMatch[1];
                    } else if (product && product.size) {
                        size = product.size;
                    }
                    
                    // Fetch the image + category for every ordered product so the
                    // preview carousel can show each item, not just the first one.
                    const itemProductIds = items.map(it => it.product_id);
                    const placeholders = itemProductIds.map(() => '?').join(',');
                    db.all(`SELECT id, img, cat FROM products WHERE id IN (${placeholders})`, itemProductIds, (errP, prodRows) => {
                        const imgById = {};
                        const catById = {};
                        (prodRows || []).forEach(p => { imgById[p.id] = p.img; catById[p.id] = p.cat; });

                        // Respond with combined payload. `items` carries every line in
                        // the order (each with its own image); the top-level fields
                        // describe the primary item shown first.
                        res.json({
                            order_id: order.order_number,
                            customer_name: order.customer_name,
                            phone: order.customer_phone,
                            item_name: pName,
                            quantity: primaryItem.quantity,
                            product_image: pImg,
                            image_gallery: gallery,
                            category: pCat,
                            price: primaryItem.price_at_time,
                            size: size,
                            color: color,
                            order_date: order.created_at,
                            status: order.status,
                            product_real_id: primaryItem.product_id,
                            items: items.map(row => ({
                                product_name: row.product_name,
                                quantity: row.quantity,
                                price_at_time: row.price_at_time,
                                product_id: row.product_id,
                                image: imgById[row.product_id] || pImg || 'images/placeholder.png',
                                category: catById[row.product_id] || pCat
                            }))
                        });
                    });
                });
            });
        });
    });
});

// Update order status (Admin)
const ORDER_STATUSES = ['pending', 'pending_deposit', 'processing', 'paid', 'shipped', 'dispatched', 'delivered', 'completed', 'cancelled'];
app.put('/api/orders/:id', authenticateToken, (req, res) => {
    const { status } = req.body;
    const orderId = req.params.id;
    const normStatus = String(status || '').toLowerCase();
    if (!ORDER_STATUSES.includes(normStatus)) {
        return res.status(400).json({ error: 'Invalid status. Allowed: ' + ORDER_STATUSES.join(', ') });
    }

    db.get(`SELECT status FROM orders WHERE id = ?`, [orderId], (err, order) => {
        if (err) return serverError(res, err);
        if (!order) return res.status(404).json({ error: 'Order not found' });

        db.run(
            `UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [normStatus, orderId],
            function (err) {
                if (err) return serverError(res, err);

                // If transitioning to paid, deduct stock
                if (normStatus === 'paid' && order.status !== 'paid') {
                    db.all(`SELECT * FROM order_items WHERE order_id = ?`, [orderId], (err, items) => {
                        if (!err && items) {
                            items.forEach(item => {
                                db.run(`UPDATE products SET stock = MAX(0, stock - ?) WHERE id = ?`, [item.quantity, item.product_id]);
                            });
                        }
                    });
                }
                
                res.json({ success: true, changes: this.changes });
            }
        );
    });
});

app.delete('/api/orders/:id', authenticateToken, (req, res) => {
    const orderId = req.params.id;
    db.get(`SELECT id FROM orders WHERE id = ?`, [orderId], (err, order) => {
        if (err) return serverError(res, err);
        if (!order) return res.status(404).json({ error: 'Order not found' });
        // Remove child rows first, then the order
        db.run(`DELETE FROM order_items WHERE order_id = ?`, [orderId], (err) => {
            if (err) return serverError(res, err);
            db.run(`DELETE FROM payments WHERE order_id = ?`, [orderId], () => {
                db.run(`DELETE FROM orders WHERE id = ?`, [orderId], function(err) {
                    if (err) return serverError(res, err);
                    res.json({ success: true, deleted: orderId });
                });
            });
        });
    });
});

function dbAll(sql, params) {
    return new Promise((resolve, reject) => {
        db.all(sql, params || [], (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
}

function toDateOnly(date) {
    return date.toISOString().slice(0, 10);
}

function parseDateOrFallback(value, fallback) {
    if (!value) return fallback;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function currencyNumber(value) {
    return Math.round(Number(value || 0));
}

function growthPercent(current, previous) {
    current = Number(current || 0);
    previous = Number(previous || 0);
    if (previous === 0 && current === 0) return 0;
    if (previous === 0) return 100;
    return Number((((current - previous) / previous) * 100).toFixed(1));
}

function analyticsDateRange(query) {
    const period = query.period === 'year' ? 'year' : 'week';
    const end = parseDateOrFallback(query.end, new Date());
    end.setHours(23, 59, 59, 999);

    let start = parseDateOrFallback(query.start, null);
    if (!start) {
        start = new Date(end);
        start.setDate(start.getDate() - (period === 'year' ? 364 : 27));
    }
    start.setHours(0, 0, 0, 0);

    const spanMs = Math.max(1, end.getTime() - start.getTime());
    const previousEnd = new Date(start.getTime() - 86400000);
    const previousStart = new Date(previousEnd.getTime() - spanMs);

    return {
        period,
        start,
        end,
        previousStart,
        previousEnd,
        startDate: toDateOnly(start),
        endDate: toDateOnly(end),
        previousStartDate: toDateOnly(previousStart),
        previousEndDate: toDateOnly(previousEnd)
    };
}

function buildOrdersFromRows(rows, paymentsByOrder) {
    const orders = {};
    rows.forEach((row) => {
        if (!orders[row.order_id]) {
            orders[row.order_id] = {
                id: row.order_id,
                order_number: row.order_number,
                customer_name: row.customer_name,
                customer_phone: row.customer_phone,
                order_type: row.order_type,
                total_amount: Number(row.total_amount || 0),
                status: row.status || 'pending',
                created_at: row.created_at,
                items: [],
                payments: paymentsByOrder[row.order_id] || []
            };
        }

        if (row.product_name) {
            orders[row.order_id].items.push({
                product_id: row.product_id,
                product_name: row.product_name,
                quantity: Number(row.quantity || 0),
                price_at_time: Number(row.price_at_time || 0),
                category: row.category || 'Other'
            });
        }
    });
    return Object.values(orders);
}

function completedOrder(status) {
    return ['paid', 'delivered', 'shipped', 'completed'].indexOf(String(status || '').toLowerCase()) >= 0;
}

function revenueOrder(order) {
    return String(order.status || '').toLowerCase() !== 'cancelled';
}

function orderRevenue(order) {
    return Number(order.total_amount || 0);
}

function itemRevenue(item) {
    return Number(item.price_at_time || 0) * Math.max(1, Number(item.quantity || 1));
}

function dateLabel(date, period) {
    return period === 'year'
        ? date.toLocaleDateString('en', { month: 'short' })
        : date.toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

function buildTrend(orders, range) {
    const buckets = [];
    const byKey = {};

    if (range.period === 'year') {
        const cursor = new Date(range.start);
        cursor.setDate(1);
        while (cursor <= range.end) {
            const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
            byKey[key] = { key, label: dateLabel(cursor, range.period), revenue: 0, orders: 0 };
            buckets.push(byKey[key]);
            cursor.setMonth(cursor.getMonth() + 1);
        }

        orders.forEach((order) => {
            const d = new Date(order.created_at);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            if (byKey[key] && revenueOrder(order)) {
                byKey[key].revenue += orderRevenue(order);
                byKey[key].orders += 1;
            }
        });
        return buckets;
    }

    const cursor = new Date(range.start);
    while (cursor <= range.end) {
        const key = toDateOnly(cursor);
        byKey[key] = { key, label: dateLabel(cursor, range.period), revenue: 0, orders: 0 };
        buckets.push(byKey[key]);
        cursor.setDate(cursor.getDate() + 1);
    }

    orders.forEach((order) => {
        const key = String(order.created_at || '').slice(0, 10);
        if (byKey[key] && revenueOrder(order)) {
            byKey[key].revenue += orderRevenue(order);
            byKey[key].orders += 1;
        }
    });
    return buckets;
}

function rankProducts(orders) {
    const map = {};
    orders.filter(revenueOrder).forEach((order) => {
        order.items.forEach((item) => {
            const name = item.product_name || 'Unknown Product';
            if (!map[name]) map[name] = { name, revenue: 0, quantity: 0 };
            map[name].revenue += itemRevenue(item);
            map[name].quantity += Number(item.quantity || 0);
        });
    });
    return Object.values(map)
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 5)
        .map((item, index) => ({ rank: index + 1, name: item.name, revenue: currencyNumber(item.revenue), quantity: item.quantity }));
}

function rankCategories(orders) {
    const map = {};
    orders.filter(revenueOrder).forEach((order) => {
        order.items.forEach((item) => {
            const category = item.category || 'Other';
            if (!map[category]) map[category] = { category, revenue: 0 };
            map[category].revenue += itemRevenue(item);
        });
    });
    return Object.values(map).sort((a, b) => b.revenue - a.revenue);
}

function rankPayments(orders) {
    const map = {};
    orders.filter(revenueOrder).forEach((order) => {
        const fallback = order.payments && order.payments.length ? order.payments : [{ payment_method: 'Mobile Money', amount: orderRevenue(order) }];
        fallback.forEach((payment) => {
            const method = payment.payment_method || 'Mobile Money';
            if (!map[method]) map[method] = { method, revenue: 0 };
            map[method].revenue += Number(payment.amount || orderRevenue(order));
        });
    });
    return Object.values(map).sort((a, b) => b.revenue - a.revenue);
}

async function buildSalesAnalytics(query) {
    const range = analyticsDateRange(query || {});
    const rows = await dbAll(
        `SELECT
            o.id AS order_id, o.order_number, o.customer_name, o.customer_phone, o.order_type,
            o.total_amount, o.status, o.created_at,
            oi.product_id, oi.product_name, oi.quantity, oi.price_at_time,
            COALESCE(p.cat, 'Other') AS category
         FROM orders o
         LEFT JOIN order_items oi ON oi.order_id = o.id
         LEFT JOIN products p ON p.id = oi.product_id
         WHERE date(o.created_at) BETWEEN date(?) AND date(?)
         ORDER BY o.created_at ASC`,
        [range.previousStartDate, range.endDate]
    );

    const payments = await dbAll(
        `SELECT pay.*
         FROM payments pay
         JOIN orders o ON o.id = pay.order_id
         WHERE date(o.created_at) BETWEEN date(?) AND date(?)`,
        [range.previousStartDate, range.endDate]
    );

    const paymentsByOrder = {};
    payments.forEach((payment) => {
        if (!paymentsByOrder[payment.order_id]) paymentsByOrder[payment.order_id] = [];
        paymentsByOrder[payment.order_id].push(payment);
    });

    const allOrders = buildOrdersFromRows(rows, paymentsByOrder);
    const currentOrders = allOrders.filter((order) => {
        const d = String(order.created_at || '').slice(0, 10);
        return d >= range.startDate && d <= range.endDate;
    });
    const previousOrders = allOrders.filter((order) => {
        const d = String(order.created_at || '').slice(0, 10);
        return d >= range.previousStartDate && d <= range.previousEndDate;
    });

    const currentRevenueOrders = currentOrders.filter(revenueOrder);
    const previousRevenueOrders = previousOrders.filter(revenueOrder);
    const totalRevenue = currentRevenueOrders.reduce((sum, order) => sum + orderRevenue(order), 0);
    const previousRevenue = previousRevenueOrders.reduce((sum, order) => sum + orderRevenue(order), 0);
    const avgOrder = currentRevenueOrders.length ? totalRevenue / currentRevenueOrders.length : 0;
    const previousAvgOrder = previousRevenueOrders.length ? previousRevenue / previousRevenueOrders.length : 0;
    const conversionDenominator = currentOrders.length || 0;
    const completed = currentOrders.filter((order) => completedOrder(order.status)).length;
    const previousCompleted = previousOrders.filter((order) => completedOrder(order.status)).length;
    const conversionRate = conversionDenominator ? (completed / conversionDenominator) * 100 : 0;
    const previousConversion = previousOrders.length ? (previousCompleted / previousOrders.length) * 100 : 0;
    const trend = buildTrend(currentOrders, range);
    const topProducts = rankProducts(currentOrders);
    const categoryPerformance = rankCategories(currentOrders);
    const paymentPerformance = rankPayments(currentOrders);
    const bestDay = trend.reduce((best, point) => point.revenue > best.revenue ? point : best, { label: 'No sales yet', revenue: 0 });
    const bestCategory = categoryPerformance[0] || { category: 'No category yet', revenue: 0 };
    const topPayment = paymentPerformance[0] || { method: 'No payments yet', revenue: 0 };

    return {
        range: {
            period: range.period,
            start: range.startDate,
            end: range.endDate,
            previousStart: range.previousStartDate,
            previousEnd: range.previousEndDate
        },
        kpis: {
            totalRevenue: currencyNumber(totalRevenue),
            avgOrderValue: currencyNumber(avgOrder),
            totalOrders: currentOrders.length,
            conversionRate: Number(conversionRate.toFixed(1)),
            growth: {
                totalRevenue: growthPercent(totalRevenue, previousRevenue),
                avgOrderValue: growthPercent(avgOrder, previousAvgOrder),
                totalOrders: growthPercent(currentOrders.length, previousOrders.length),
                conversionRate: growthPercent(conversionRate, previousConversion)
            }
        },
        trend: trend.map((point) => ({ label: point.label, key: point.key, revenue: currencyNumber(point.revenue), orders: point.orders })),
        topProducts,
        categoryPerformance: categoryPerformance.map((item) => ({ category: item.category, revenue: currencyNumber(item.revenue) })),
        paymentPerformance: paymentPerformance.map((item) => ({ method: item.method, revenue: currencyNumber(item.revenue) })),
        insights: {
            bestDay: { label: bestDay.label, revenue: currencyNumber(bestDay.revenue) },
            bestCategory: {
                label: bestCategory.category,
                share: totalRevenue ? Number(((bestCategory.revenue / totalRevenue) * 100).toFixed(1)) : 0
            },
            topPayment: {
                label: topPayment.method,
                share: totalRevenue ? Number(((topPayment.revenue / totalRevenue) * 100).toFixed(1)) : 0
            }
        },
        empty: currentOrders.length === 0
    };
}

app.get('/api/analytics/sales', authenticateToken, async (req, res) => {
    try {
        const analytics = await buildSalesAnalytics(req.query);
        res.json(analytics);
    } catch (err) {
        serverError(res, err);
    }
});

app.get('/api/analytics/sales/export', authenticateToken, async (req, res) => {
    try {
        const analytics = await buildSalesAnalytics(req.query);
        const rows = [
            ['Metric', 'Value'],
            ['Total Revenue', analytics.kpis.totalRevenue],
            ['Average Order Value', analytics.kpis.avgOrderValue],
            ['Total Orders', analytics.kpis.totalOrders],
            ['Conversion Rate', analytics.kpis.conversionRate + '%'],
            ['Best Day', analytics.insights.bestDay.label],
            ['Best Day Revenue', analytics.insights.bestDay.revenue],
            ['Best Selling Category', analytics.insights.bestCategory.label],
            ['Top Payment Method', analytics.insights.topPayment.label],
            [],
            ['Date', 'Revenue', 'Orders'],
            ...analytics.trend.map((point) => [point.label, point.revenue, point.orders]),
            [],
            ['Rank', 'Product', 'Revenue', 'Quantity'],
            ...analytics.topProducts.map((product) => [product.rank, product.name, product.revenue, product.quantity])
        ];

        const csv = rows.map((row) => row.map((value) => `"${String(value || '').replace(/"/g, '""')}"`).join(',')).join('\n');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="dc-kids-sales-analytics.csv"');
        res.send(csv);
    } catch (err) {
        serverError(res, err);
    }
});

// ===========================================================================
//   CUSTOMER ACCOUNTS (storefront)
//   Separate auth from staff: JWT carries { cid, email, kind: 'customer' }.
//
//   The storefront currently has no sign-in UI (account.html was removed), so
//   the public entry points — register, login, password reset — are gated off
//   by default to close an unused write surface. Set CUSTOMER_ACCOUNTS_ENABLED=true
//   in server/.env to reopen them when the account UI returns. Token-protected
//   routes (me/addresses/wishlist) stay mounted: without login nobody can mint
//   a customer token, so they are unreachable until the flag is on.
// ===========================================================================
const CUSTOMER_ACCOUNTS_ENABLED = String(process.env.CUSTOMER_ACCOUNTS_ENABLED || '').toLowerCase() === 'true';
const requireCustomerAccountsEnabled = (req, res, next) => {
    if (!CUSTOMER_ACCOUNTS_ENABLED) return res.status(404).json({ error: 'Customer accounts are not available' });
    next();
};
const authenticateCustomer = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Not signed in' });
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err || !decoded || decoded.kind !== 'customer') return res.status(403).json({ error: 'Invalid customer session' });
        req.customer = decoded;
        next();
    });
};

app.post('/api/customer/register', requireCustomerAccountsEnabled, registerLimiter, async (req, res) => {
    try {
        const { name, email, phone, password } = req.body || {};
        if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password required' });
        if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
        const password_hash = await bcrypt.hash(password, 10);
        db.run(
            `INSERT INTO customer_accounts (email, phone, name, password_hash) VALUES (?, ?, ?, ?)`,
            [email.trim().toLowerCase(), phone || null, name.trim(), password_hash],
            function(err) {
                if (err) {
                    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'An account with that email already exists' });
                    return serverError(res, err);
                }
                const cid = this.lastID;
                const token = jwt.sign({ cid, email: email.toLowerCase(), kind: 'customer' }, JWT_SECRET, { expiresIn: '30d' });
                res.json({ success: true, token, customer: { id: cid, name, email: email.toLowerCase(), phone: phone || null } });
            }
        );
    } catch (e) { serverError(res, e); }
});

app.post('/api/customer/login', requireCustomerAccountsEnabled, loginLimiter, (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    db.get(`SELECT * FROM customer_accounts WHERE email = ?`, [email.trim().toLowerCase()], async (err, row) => {
        if (err) return serverError(res, err);
        if (!row) return res.status(401).json({ error: 'Invalid email or password' });
        const ok = await bcrypt.compare(password, row.password_hash);
        if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
        db.run(`UPDATE customer_accounts SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?`, [row.id]);
        const token = jwt.sign({ cid: row.id, email: row.email, kind: 'customer' }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ success: true, token, customer: { id: row.id, name: row.name, email: row.email, phone: row.phone } });
    });
});

// Password Recovery - Request Reset (Forgot Password)
app.post('/api/customer/forgot-password', requireCustomerAccountsEnabled, registerLimiter, (req, res) => {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email address is required' });
    
    db.get(`SELECT name FROM customer_accounts WHERE email = ?`, [email.trim().toLowerCase()], (err, user) => {
        if (err) return serverError(res, err);
        
        // Return generic success even if user not found to prevent email scanning/enumeration
        if (!user) {
            return res.json({ success: true, message: 'If that email is registered, a password recovery link has been sent.' });
        }
        
        // Generate a 1-hour secure reset token signed with the email and a reset flag
        const token = jwt.sign(
            { email: email.trim().toLowerCase(), reset: true },
            JWT_SECRET,
            { expiresIn: '1h' }
        );
        
        // Construct reset link using host header to adapt to localhost or custom domains automatically
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const resetLink = `${protocol}://${req.headers.host}/account.html?email=${encodeURIComponent(email.trim().toLowerCase())}&resetToken=${token}`;
        
        console.log(`\n[PASSWORD RECOVERY] Generated reset link for customer: ${email.trim().toLowerCase()}\nLink: ${resetLink}\n`);
        
        // NOTE: No storefront login exists — this endpoint is unused in production.
        
        res.json({ success: true, message: 'If that email is registered, a password recovery link has been sent.' });
    });
});

// Password Recovery - Reset Password (Reset Password Form Submission)
app.post('/api/customer/reset-password', requireCustomerAccountsEnabled, registerLimiter, (req, res) => {
    const { email, token, password } = req.body || {};
    if (!email || !token || !password) {
        return res.status(400).json({ error: 'Email, recovery token, and new password are required' });
    }
    if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Verify JWT signature and expiration
    jwt.verify(token, JWT_SECRET, async (err, decoded) => {
        if (err || !decoded || !decoded.reset || decoded.email !== email.trim().toLowerCase()) {
            return res.status(400).json({ error: 'Invalid or expired password reset link. Please request a new link.' });
        }

        try {
            const hash = await bcrypt.hash(password, 10);
            db.run(
                `UPDATE customer_accounts SET password_hash = ? WHERE email = ?`,
                [hash, email.trim().toLowerCase()],
                function(err) {
                    if (err) return serverError(res, err);
                    if (this.changes === 0) return res.status(404).json({ error: 'Account not found' });
                    
                    res.json({ success: true, message: 'Password has been reset successfully. You can now log in.' });
                }
            );
        } catch (e) {
            serverError(res, e);
        }
    });
});

app.get('/api/customer/me', authenticateCustomer, (req, res) => {
    db.get(`SELECT id, email, phone, name, created_at, last_login_at FROM customer_accounts WHERE id = ?`, [req.customer.cid], (err, row) => {
        if (err) return serverError(res, err);
        if (!row) return res.status(404).json({ error: 'Account not found' });
        res.json(row);
    });
});

app.put('/api/customer/me', authenticateCustomer, (req, res) => {
    const { name, phone } = req.body || {};
    db.run(`UPDATE customer_accounts SET name = COALESCE(?, name), phone = COALESCE(?, phone) WHERE id = ?`,
        [name || null, phone || null, req.customer.cid],
        function(err) {
            if (err) return serverError(res, err);
            res.json({ success: true });
        }
    );
});

// Customer's own order history (matched by phone OR by explicit links)
app.get('/api/customer/orders', authenticateCustomer, (req, res) => {
    db.get(`SELECT phone FROM customer_accounts WHERE id = ?`, [req.customer.cid], (err, acct) => {
        if (err) return serverError(res, err);
        const phone = acct && acct.phone ? acct.phone : null;
        if (!phone) return res.json([]);
        db.all(`SELECT * FROM orders WHERE customer_phone = ? ORDER BY created_at DESC`, [phone], (err, rows) => {
            if (err) return serverError(res, err);
            res.json(rows || []);
        });
    });
});

// ---- Customer addresses ----
app.get('/api/customer/addresses', authenticateCustomer, (req, res) => {
    db.all(`SELECT * FROM customer_addresses WHERE customer_id = ? ORDER BY is_default DESC, created_at DESC`, [req.customer.cid], (err, rows) => {
        if (err) return serverError(res, err);
        res.json(rows || []);
    });
});
app.post('/api/customer/addresses', authenticateCustomer, (req, res) => {
    const a = req.body || {};
    if (!a.address_line1) return res.status(400).json({ error: 'address_line1 required' });
    const setDefault = a.is_default ? 1 : 0;
    const insert = () => {
        db.run(
            `INSERT INTO customer_addresses (customer_id, label, recipient_name, phone, address_line1, address_line2, city, region, country, is_default)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.customer.cid, a.label || 'Home', a.recipient_name || null, a.phone || null, a.address_line1, a.address_line2 || null, a.city || null, a.region || null, a.country || 'Ghana', setDefault],
            function(err) {
                if (err) return serverError(res, err);
                res.json({ success: true, id: this.lastID });
            }
        );
    };
    if (setDefault) db.run(`UPDATE customer_addresses SET is_default = 0 WHERE customer_id = ?`, [req.customer.cid], insert);
    else insert();
});
app.put('/api/customer/addresses/:id', authenticateCustomer, (req, res) => {
    const a = req.body || {};
    const id = req.params.id;
    const setDefault = a.is_default ? 1 : 0;
    const update = () => {
        db.run(
            `UPDATE customer_addresses SET label = COALESCE(?, label), recipient_name = COALESCE(?, recipient_name), phone = COALESCE(?, phone),
                address_line1 = COALESCE(?, address_line1), address_line2 = COALESCE(?, address_line2), city = COALESCE(?, city),
                region = COALESCE(?, region), country = COALESCE(?, country), is_default = ?
             WHERE id = ? AND customer_id = ?`,
            [a.label || null, a.recipient_name || null, a.phone || null, a.address_line1 || null, a.address_line2 || null, a.city || null, a.region || null, a.country || null, setDefault, id, req.customer.cid],
            function(err) {
                if (err) return serverError(res, err);
                if (this.changes === 0) return res.status(404).json({ error: 'Address not found' });
                res.json({ success: true });
            }
        );
    };
    if (setDefault) db.run(`UPDATE customer_addresses SET is_default = 0 WHERE customer_id = ?`, [req.customer.cid], update);
    else update();
});
app.delete('/api/customer/addresses/:id', authenticateCustomer, (req, res) => {
    db.run(`DELETE FROM customer_addresses WHERE id = ? AND customer_id = ?`, [req.params.id, req.customer.cid], function(err) {
        if (err) return serverError(res, err);
        if (this.changes === 0) return res.status(404).json({ error: 'Address not found' });
        res.json({ success: true });
    });
});

// ===========================================================================
//   ORDER TRACKING (public — by order number + last 4 digits of phone)
// ===========================================================================
app.post('/api/orders/track', trackLimiter, (req, res) => {
    const { order_number, phone } = req.body || {};
    if (!order_number || !phone) return res.status(400).json({ error: 'order_number and phone are required' });
    const last4 = String(phone).replace(/\D/g, '').slice(-4);
    if (last4.length < 4) return res.status(400).json({ error: 'Phone must contain at least 4 digits' });

    db.get(`SELECT * FROM orders WHERE order_number = ?`, [String(order_number).trim().toUpperCase()], (err, order) => {
        if (err) return serverError(res, err);
        if (!order) return res.status(404).json({ error: 'No order found with that reference' });
        const onFile = String(order.customer_phone || '').replace(/\D/g, '').slice(-4);
        if (onFile !== last4) return res.status(403).json({ error: 'Phone does not match this order' });

        db.all(`SELECT * FROM order_items WHERE order_id = ?`, [order.id], (err, items) => {
            if (err) return serverError(res, err);
            res.json({
                order_number: order.order_number,
                status: order.status,
                order_type: order.order_type,
                total_amount: order.total_amount,
                created_at: order.created_at,
                updated_at: order.updated_at,
                customer_name: order.customer_name,
                items: items || []
            });
        });
    });
});

// ===========================================================================
//   REVIEWS & RATINGS
// ===========================================================================
app.get('/api/products/:id/reviews', (req, res) => {
    db.all(
        `SELECT id, product_id, customer_id, author_name, rating, title, body, verified_purchase, created_at
         FROM product_reviews WHERE product_id = ? AND status = 'approved' ORDER BY created_at DESC`,
        [req.params.id],
        (err, rows) => {
            if (err) return serverError(res, err);
            const total = rows.length;
            const avg = total ? (rows.reduce((s, r) => s + r.rating, 0) / total) : 0;
            res.json({ summary: { count: total, average: Math.round(avg * 10) / 10 }, reviews: rows });
        }
    );
});

// Batch rating summary for the storefront grid — one round trip for the whole
// page of cards instead of one fetch per product, so a slow connection or a
// single failed request can't leave individual cards permanently unrated.
app.get('/api/products/reviews-summary', (req, res) => {
    const ids = String(req.query.ids || '').split(',').map(s => parseInt(s, 10)).filter(Number.isInteger);
    if (!ids.length) return res.json({});
    const placeholders = ids.map(() => '?').join(',');
    db.all(
        `SELECT product_id, COUNT(*) as count, AVG(rating) as average
         FROM product_reviews WHERE product_id IN (${placeholders}) AND status = 'approved'
         GROUP BY product_id`,
        ids,
        (err, rows) => {
            if (err) return serverError(res, err);
            const summaries = {};
            ids.forEach(id => { summaries[id] = { count: 0, average: 0 }; });
            rows.forEach(r => { summaries[r.product_id] = { count: r.count, average: Math.round(r.average * 10) / 10 }; });
            res.json(summaries);
        }
    );
});

app.post('/api/products/:id/reviews', reviewLimiter, (req, res) => {
    const { rating, title, body, author_name } = req.body || {};
    const productId = req.params.id;
    const r = Number(rating);
    if (!r || r < 1 || r > 5) return res.status(400).json({ error: 'rating must be 1-5' });
    if (!body || String(body).trim().length < 4) return res.status(400).json({ error: 'Review body is too short' });
    if (String(body).length > 2000) return res.status(400).json({ error: 'Review is too long (max 2000 characters)' });
    if (title && String(title).length > 120) return res.status(400).json({ error: 'Title is too long (max 120 characters)' });
    if (author_name && String(author_name).length > 80) return res.status(400).json({ error: 'Name is too long (max 80 characters)' });

    // Optional customer auth — if a customer token is present, attribute it.
    let customer_id = null;
    let resolvedAuthor = (author_name || '').trim();
    const tryAttribute = (cb) => {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];
        if (!token) return cb();
        jwt.verify(token, JWT_SECRET, (err, decoded) => {
            if (!err && decoded && decoded.kind === 'customer') {
                customer_id = decoded.cid;
                db.get(`SELECT name FROM customer_accounts WHERE id = ?`, [customer_id], (e, row) => {
                    if (row && row.name) resolvedAuthor = resolvedAuthor || row.name;
                    cb();
                });
            } else { cb(); }
        });
    };
    tryAttribute(() => {
        if (!resolvedAuthor) resolvedAuthor = 'Anonymous';
        db.run(
            `INSERT INTO product_reviews (product_id, customer_id, author_name, rating, title, body) VALUES (?, ?, ?, ?, ?, ?)`,
            [productId, customer_id, resolvedAuthor, r, title || null, String(body).trim()],
            function(err) {
                if (err) return serverError(res, err);
                res.json({ success: true, id: this.lastID });
            }
        );
    });
});

// Admin moderation
app.get('/api/admin/reviews', authenticateToken, requireManager, (req, res) => {
    db.all(`SELECT pr.*, p.name AS product_name FROM product_reviews pr
            LEFT JOIN products p ON p.id = pr.product_id
            ORDER BY pr.created_at DESC LIMIT 200`, (err, rows) => {
        if (err) return serverError(res, err);
        res.json(rows || []);
    });
});
app.delete('/api/admin/reviews/:id', authenticateToken, requireManager, (req, res) => {
    db.run(`DELETE FROM product_reviews WHERE id = ?`, [req.params.id], function(err) {
        if (err) return serverError(res, err);
        res.json({ success: true });
    });
});

// ===========================================================================
//   WISHLIST
// ===========================================================================
app.get('/api/wishlist', authenticateCustomer, (req, res) => {
    db.all(
        `SELECT w.id AS wishlist_id, w.product_id, w.created_at, p.* FROM wishlist_items w
         JOIN products p ON p.id = w.product_id WHERE w.customer_id = ? ORDER BY w.created_at DESC`,
        [req.customer.cid],
        (err, rows) => {
            if (err) return serverError(res, err);
            res.json(rows || []);
        }
    );
});
app.post('/api/wishlist', authenticateCustomer, (req, res) => {
    const { product_id } = req.body || {};
    if (!product_id) return res.status(400).json({ error: 'product_id required' });
    db.run(`INSERT OR IGNORE INTO wishlist_items (customer_id, product_id) VALUES (?, ?)`, [req.customer.cid, product_id], function(err) {
        if (err) return serverError(res, err);
        res.json({ success: true, added: this.changes > 0 });
    });
});
app.delete('/api/wishlist/:productId', authenticateCustomer, (req, res) => {
    db.run(`DELETE FROM wishlist_items WHERE customer_id = ? AND product_id = ?`, [req.customer.cid, req.params.productId], function(err) {
        if (err) return serverError(res, err);
        res.json({ success: true });
    });
});

// ===========================================================================
//   EDIT STAFF (admin)
// ===========================================================================
// Passwordless accounts are edited by name, email (their sign-in identity —
// username is kept in sync with it), and role. No password fields exist.
app.put('/api/users/:id', authenticateToken, requireManager, (req, res) => {
    const { full_name, email, role } = req.body || {};
    const updates = [];
    const values = [];
    if (email) {
        const mail = String(email).trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail) || mail.length > 254) {
            return res.status(400).json({ error: 'Enter a valid email address' });
        }
        updates.push('email = ?', 'username = ?');
        values.push(mail, mail);
    }
    if (full_name && String(full_name).trim()) { updates.push('full_name = ?'); values.push(String(full_name).trim()); }
    if (role && ['manager', 'staff'].includes(role)) { updates.push('role = ?'); values.push(role); }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    values.push(req.params.id);
    db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values, function(err) {
        if (err) {
            if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'That email is already in use' });
            return serverError(res, err);
        }
        if (this.changes === 0) return res.status(404).json({ error: 'User not found' });
        res.json({ success: true });
    });
});

// ===========================================================================
//   TELEGRAM ORDER ALERT — DC Kids Brand (free, instant)
//   Add to server/.env:
//     TELEGRAM_BOT_TOKEN=your_bot_token
//     TELEGRAM_CHAT_ID=id1,id2,...   (one or more, comma-separated)
//   Each destination can be a personal chat id (send /start to the bot, then
//   check getUpdates) OR a channel/group id (add the bot as an admin). To add a
//   new owner, just append their id — every destination receives the alert.
// ===========================================================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_IDS  = (process.env.TELEGRAM_CHAT_ID || '')
    .split(',').map(s => s.trim()).filter(Boolean);

function sendOwnerWhatsAppAlert(order) {
    const now       = new Date();
    const time      = now.toLocaleString('en-GH', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
    const type      = (order.order_type || 'retail').charAt(0).toUpperCase() + (order.order_type || 'retail').slice(1);
    const area      = order.delivery_area ? `\n📍 *Area:* ${order.delivery_area}` : '';
    const itemLines = (order.items || [])
        .map(i => `  • ${i.quantity}× ${i.product_name} — GHS ${Number(i.price_at_time).toFixed(2)}`)
        .join('\n');

    // DC Kids branded Telegram message — bold headings, emojis, full detail
    const msg =
`🛍️ *NEW ORDER — DC Kids Brand*
━━━━━━━━━━━━━━━━━━━━
📦 *Order:* ${order.order_number}
👤 *Customer:* ${order.customer_name || 'Guest'}
📱 *Phone:* ${order.customer_phone || '—'}${area}
🏷️ *Type:* ${type}
💰 *Total:* GHS ${Number(order.total_amount).toFixed(2)}
━━━━━━━━━━━━━━━━━━━━
🛒 *Items:*
${itemLines || '  (no items)'}
━━━━━━━━━━━━━━━━━━━━
⏰ ${time}`;

    if (!TELEGRAM_BOT_TOKEN || TELEGRAM_CHAT_IDS.length === 0) {
        console.log(`\n[DC Kids Order Alert] ${order.order_number} — GHS ${order.total_amount} from ${order.customer_name || 'Guest'} (${order.customer_phone || 'no phone'})`);
        console.log(`[DC Kids Order Alert] Add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to server/.env to receive Telegram alerts.\n`);
        return;
    }

    const https = require('https');
    // Send to every configured destination (owners and/or a shared channel).
    TELEGRAM_CHAT_IDS.forEach(chatId => {
        const payload = JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'Markdown' });
        const options = {
            hostname: 'api.telegram.org',
            path:     `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            method:   'POST',
            headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        };
        const req = https.request(options, (res) => {
            res.on('data', () => {});
            res.on('end', () => console.log(`[DC Kids Order Alert] Telegram sent for ${order.order_number} to ${chatId} — status ${res.statusCode}`));
        });
        req.on('error', err => console.warn(`[DC Kids Order Alert] Telegram failed for ${order.order_number} to ${chatId}: ${err.message}`));
        req.write(payload);
        req.end();
    });
}

// Expose so the order POST handler (above) can call it without restructuring.
app.set('sendOwnerWhatsAppAlert', sendOwnerWhatsAppAlert);

// ===========================================================================
//   BULK PRODUCT ACTIONS (admin)
// ===========================================================================
app.post('/api/products/bulk-delete', authenticateToken, requireManager, (req, res) => {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' });
    const placeholders = ids.map(() => '?').join(',');
    // Same FK constraint as the single-delete route — clear dependent rows first.
    db.run(`DELETE FROM product_images WHERE product_id IN (${placeholders})`, ids, (err) => {
        if (err) return serverError(res, err);
        db.run(`DELETE FROM product_reviews WHERE product_id IN (${placeholders})`, ids, (err2) => {
            if (err2) return serverError(res, err2);
            db.run(`DELETE FROM wishlist_items WHERE product_id IN (${placeholders})`, ids, (err3) => {
                if (err3) return serverError(res, err3);
                db.run(`DELETE FROM products WHERE id IN (${placeholders})`, ids, function(err4) {
                    if (err4) return serverError(res, err4);
                    res.json({ success: true, deleted: this.changes });
                });
            });
        });
    });
});
app.post('/api/products/bulk-update', authenticateToken, requireManager, (req, res) => {
    const { ids, fields } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0 || !fields || typeof fields !== 'object') {
        return res.status(400).json({ error: 'ids array and fields object required' });
    }
    const allowed = ['cat', 'badge', 'price', 'stock', 'description', 'fulfillment_type'];
    const updates = [];
    const values = [];
    Object.keys(fields).forEach(k => { if (allowed.includes(k)) { updates.push(`${k} = ?`); values.push(fields[k]); } });
    if (updates.length === 0) return res.status(400).json({ error: 'No allowed fields supplied' });
    const placeholders = ids.map(() => '?').join(',');
    db.run(`UPDATE products SET ${updates.join(', ')} WHERE id IN (${placeholders})`, [...values, ...ids], function(err) {
        if (err) return serverError(res, err);
        res.json({ success: true, updated: this.changes });
    });
});
app.post('/api/products/bulk-import', authenticateToken, requireManager, (req, res) => {
    const { rows } = req.body || {};
    if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'rows array required' });

    const validRows = [];
    let skipped = 0;
    rows.forEach(r => { if (r && r.name && r.price != null) validRows.push(r); else skipped++; });

    // status is derived from stock at display time, so it isn't a stored column.
    const stmt = db.prepare(`INSERT INTO products (name, sku, price, stock, cat, size, badge, img, description, fulfillment_type)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let inserted = 0;
    const failures = [];

    // Rows that omit a SKU get one auto-assigned, same scheme as a manual add
    // (category prefix + sequential number). Seeding each prefix's starting
    // number once up front — rather than re-querying per row — means two
    // blank-SKU rows for the same category in one CSV don't race for the same
    // number; rows run one at a time anyway so the in-memory counter stays correct.
    const nextNumByPrefix = {};
    const seedPrefix = (prefix, cb) => {
        if (nextNumByPrefix[prefix] != null) return cb();
        db.all(`SELECT sku FROM products WHERE sku LIKE ?`, [prefix + '-%'], (err, dbRows) => {
            let maxN = 0;
            (dbRows || []).forEach(row => {
                const m = /^[A-Z]+-(\d+)$/.exec(row.sku || '');
                if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
            });
            nextNumByPrefix[prefix] = maxN;
            cb();
        });
    };

    const processRow = (idx) => {
        if (idx >= validRows.length) {
            return stmt.finalize((err) => {
                if (err) return serverError(res, err);
                res.json({ success: true, inserted, skipped, failed: failures.length, errors: failures.slice(0, 10) });
            });
        }
        const r = validRows[idx];
        const fulfillmentType = (r.fulfillment_type || '').toLowerCase() === 'preorder' ? 'preorder' : 'in_stock';
        const cat = r.cat || '';
        const insertWith = (sku) => {
            stmt.run([r.name, sku || null, Number(r.price) || 0, Number(r.stock) || 0, cat, r.size || '', r.badge || '', r.img || '', r.description || '', fulfillmentType], function (err) {
                if (isDuplicateSku(err)) failures.push({ row: idx + 1, name: r.name, error: 'Duplicate SKU "' + sku + '"' });
                else if (err) failures.push({ row: idx + 1, name: r.name, error: err.message });
                else inserted++;
                processRow(idx + 1);
            });
        };
        const explicitSku = String(r.sku || '').trim();
        if (explicitSku) {
            insertWith(explicitSku);
        } else {
            const prefix = skuPrefixFor(cat);
            seedPrefix(prefix, () => {
                nextNumByPrefix[prefix]++;
                insertWith(prefix + '-' + String(nextNumByPrefix[prefix]).padStart(4, '0'));
            });
        }
    };
    processRow(0);
});

// ===========================================================================
//   PRODUCT IMAGE UPLOAD (manager only)
//   Accepts a base64 data-URI (already resized/compressed in the browser),
//   writes it to /images as a real file, returns the path. This is the ONLY
//   sanctioned way to set a product image — it guarantees we store a file
//   PATH in the DB, never a multi-KB inline blob.
// ===========================================================================
app.post('/api/upload-image', authenticateToken, requireManager, (req, res) => {
    try {
        const { dataUrl } = req.body || {};
        if (!dataUrl || typeof dataUrl !== 'string') return res.status(400).json({ error: 'dataUrl required' });
        const m = dataUrl.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/s);
        if (!m) return res.status(400).json({ error: 'Unsupported image format (use png, jpg, or webp)' });

        const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
        const buf = Buffer.from(m[2], 'base64');

        // Hard cap AFTER browser compression — a well-compressed product photo is
        // well under this. Anything larger means client compression didn't run.
        const MAX_BYTES = 5 * 1024 * 1024;
        if (buf.length > MAX_BYTES) {
            return res.status(413).json({ error: 'Image too large after compression (max 5MB). Try a smaller photo.' });
        }

        const fs = require('fs');
        const imagesDir = path.join(__dirname, '..', 'images');
        if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });

        const fname = 'product_upload_' + Date.now() + '_' + Math.floor(Math.random() * 1e4) + '.' + ext;
        fs.writeFileSync(path.join(imagesDir, fname), buf);
        res.json({ success: true, path: 'images/' + fname, bytes: buf.length });
    } catch (e) {
        serverError(res, e);
    }
});

// Global error-handling middleware to catch JSON parsing syntax errors and other server errors
app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        console.warn(`[JSON Parse Error] ${req.method} ${req.url} - ${err.message}`);
        return res.status(400).json({ error: 'Invalid JSON payload. Please verify your formatting.' });
    }
    console.error('Unhandled Server Error:', err.stack);
    res.status(500).json({ error: 'Internal Server Error' });
});

const PORT = process.env.PORT || 3001;
// Start listening only after the database schema is ready, so requests can't
// arrive before the tables exist (which crashed a fresh clone with
// "no such table: orders"). Falls back to listening directly if whenReady
// isn't available, for safety.
if (typeof db.whenReady === 'function') {
    db.whenReady(() => {
        app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
    });
} else {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}
