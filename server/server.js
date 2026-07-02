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

// ---------------- AUTH ROUTES ---------------- //
app.post('/api/login', loginLimiter, (req, res) => {
    const { username, password } = req.body;
    // Accept username OR email — access requests register with email only.
    const ident = String(username || '').trim();
    db.get(`SELECT * FROM users WHERE username = ? OR email = ?`, [ident, ident.toLowerCase()], async (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!user) return res.status(400).json({ error: 'Cannot find user' });

        try {
            if (await bcrypt.compare(password, user.password_hash)) {
                // Status gates the access-request workflow. NULL = legacy
                // pre-migration account (the seeded admin) — treated as active.
                if (user.status === 'pending') {
                    return res.status(403).json({ error: 'Your access request is still awaiting the owner\'s approval.' });
                }
                if (user.status === 'rejected') {
                    return res.status(403).json({ error: 'Your access request was declined. Contact the owner.' });
                }
                const accessToken = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
                res.json({ accessToken, role: user.role });
            } else {
                res.status(401).json({ error: 'Not Allowed' });
            }
        } catch {
            res.status(500).send();
        }
    });
});

// Request admin access (public). Creates a PENDING account that cannot log in
// until the owner approves it from Manage Staff. Role is fixed to 'staff' here
// on purpose — requesters never choose their own role; the owner assigns it
// at approval time.
app.post('/api/admin/register', registerLimiter, async (req, res) => {
    const { full_name, email, phone, password } = req.body || {};
    const name = String(full_name || '').trim();
    const mail = String(email || '').trim().toLowerCase();
    if (name.length < 2 || name.length > 100) return res.status(400).json({ error: 'Please enter your full name' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail) || mail.length > 254) return res.status(400).json({ error: 'Please enter a valid email address' });
    if (!password || String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    try {
        const hash = await bcrypt.hash(String(password), 10);
        db.run(
            `INSERT INTO users (username, password_hash, role, email, full_name, phone, status, created_at)
             VALUES (?, ?, 'staff', ?, ?, ?, 'pending', datetime('now'))`,
            [mail, hash, mail, name, String(phone || '').trim() || null],
            function (err) {
                if (err) {
                    if (String(err.message).includes('UNIQUE')) {
                        return res.status(409).json({ error: 'An account with this email already exists' });
                    }
                    return res.status(500).json({ error: err.message });
                }
                res.status(201).json({ success: true, message: 'Request submitted — the owner will review it.' });
            }
        );
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Pending access requests (owner/manager only)
app.get('/api/admin/access-requests', authenticateToken, requireManager, (req, res) => {
    db.all(
        `SELECT id, full_name, email, phone, created_at FROM users WHERE status = 'pending' ORDER BY id DESC`,
        [],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
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
            if (err) return res.status(500).json({ error: err.message });
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
            if (err) return res.status(500).json({ error: err.message });
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
            if (err) return res.status(500).json({ error: err.message });
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
        if (err) return res.status(500).json({ error: err.message });
        db.all(`SELECT * FROM products ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, pageParams, (err2, rows) => {
            if (err2) return res.status(500).json({ error: err2.message });
            const total = (countRow && countRow.total) || 0;
            res.json({ products: rows, total, page, limit, pages: Math.ceil(total / limit) });
        });
    });
});

app.get('/api/settings', (req, res) => {
    db.get(`SELECT * FROM store_settings WHERE id = 1`, (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
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

// Change own password
app.put('/api/me/password', authenticateToken, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: 'currentPassword and newPassword are required' });
    }
    if (newPassword.length < 8) {
        return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    db.get(`SELECT * FROM users WHERE id = ?`, [req.user.id], async (err, user) => {
        if (err || !user) return res.status(500).json({ error: 'User not found' });
        const match = await bcrypt.compare(currentPassword, user.password_hash);
        if (!match) return res.status(401).json({ error: 'Current password is incorrect' });
        const hash = await bcrypt.hash(newPassword, 10);
        db.run(`UPDATE users SET password_hash = ? WHERE id = ?`, [hash, req.user.id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
    });
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
            if (err) return res.status(500).json({ error: err.message });
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
        if (err) return res.status(500).json({ error: err.message });
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
    try { const arr = JSON.parse(raw); if (Array.isArray(arr) && arr.length) return arr; } catch (e) {}
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
                if (err) return res.status(500).json({ error: err.message });
                res.json({ id: this.lastID, sku: finalSku || null });
            }
        );
    };
    // Admin left SKU blank — auto-assign one rather than storing nothing.
    if (sku && String(sku).trim()) {
        insert(String(sku).trim());
    } else {
        generateSku(cat, (err, generated) => {
            if (err) return res.status(500).json({ error: err.message });
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
            if (err) return res.status(500).json({ error: err.message });
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
        if (err) return res.status(500).json({ error: err.message });
        db.run(`DELETE FROM product_reviews WHERE product_id = ?`, [productId], (err2) => {
            if (err2) return res.status(500).json({ error: err2.message });
            db.run(`DELETE FROM wishlist_items WHERE product_id = ?`, [productId], (err3) => {
                if (err3) return res.status(500).json({ error: err3.message });
                db.run(`DELETE FROM products WHERE id = ?`, [productId], function (err4) {
                    if (err4) return res.status(500).json({ error: err4.message });
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
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Product not found' });
        
        if (row.stock <= 0) {
            return res.status(400).json({ error: 'Stock is already 0. Cannot deduct further.' });
        }

        // Proceed to deduct if stock > 0
        db.run(
            `UPDATE products SET stock = stock - 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [productId],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                
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
        if (err) return res.status(500).json({ error: err.message });
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
                return res.status(500).json({ error: err.message });
            }

            db.get(`SELECT * FROM suppliers WHERE id = ?`, [this.lastID], (err, supplier) => {
                if (err) return res.status(500).json({ error: err.message });
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
                return res.status(500).json({ error: err.message });
            }
            if (this.changes === 0) return res.status(404).json({ error: 'Supplier not found.' });

            db.get(`SELECT * FROM suppliers WHERE id = ?`, [req.params.id], (err, supplier) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json(supplier);
            });
        }
    );
});

// ---------------- USER MANAGEMENT ROUTES (Manager only) ---------------- //
// List all users
app.get('/api/users', authenticateToken, requireManager, (req, res) => {
    db.all(`SELECT id, username, role, email, full_name, phone, status FROM users`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Create new user (staff/manager)
app.post('/api/users', authenticateToken, requireManager, async (req, res) => {
    const { username, password, role } = req.body;
    if (!username || !password || !role) {
        return res.status(400).json({ error: 'Missing username, password, or role' });
    }
    if (String(password).length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    try {
        const hash = await bcrypt.hash(password, 10);
        db.run(
            `INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)`,
            [username.trim(), hash, role],
            function(err) {
                if (err) {
                    if (err.message && err.message.indexOf('UNIQUE') >= 0) {
                        return res.status(409).json({ error: 'Username already exists' });
                    }
                    return res.status(500).json({ error: err.message });
                }
                res.status(201).json({ id: this.lastID, username: username.trim(), role });
            }
        );
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Delete user
app.delete('/api/users/:id', authenticateToken, requireManager, (req, res) => {
    const userId = req.params.id;
    
    // Prevent self-deletion
    if (Number(userId) === req.user.id) {
        return res.status(400).json({ error: 'Cannot delete your own logged-in user account' });
    }
    
    db.run(`DELETE FROM users WHERE id = ?`, [userId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'User not found' });
        res.json({ success: true, message: 'User deleted successfully' });
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
        if (item.quantity != null && (!Number.isInteger(Number(item.quantity)) || Number(item.quantity) < 1 || Number(item.quantity) > 100)) {
            return res.status(400).json({ error: 'Quantity must be a whole number between 1 and 100' });
        }
    }
    if (customer_name && String(customer_name).length > 100) return res.status(400).json({ error: 'Name is too long' });
    if (customer_phone && String(customer_phone).length > 30) return res.status(400).json({ error: 'Phone number is too long' });
    if (delivery_area && String(delivery_area).length > 200) return res.status(400).json({ error: 'Delivery area is too long' });
    if (notes && String(notes).length > 1000) return res.status(400).json({ error: 'Notes are too long (max 1000 characters)' });

    const isWholesale = (order_type === 'wholesale');
    
    // 1. Fetch store settings for wholesale math
    db.get(`SELECT * FROM store_settings WHERE id = 1`, (err, settings) => {
        if (err) return res.status(500).json({ error: err.message });
        
        const moq = settings ? settings.wholesale_moq : 10;
        const discount = settings ? settings.wholesale_discount : 0;
        const qtyMultiplier = isWholesale ? moq : 1;

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

                    let basePrice, firstMod;
                    if (sizeMatch) {
                        let unit = (sizeMatch.price != null) ? sizeMatch.price : (product.price || 0);
                        if (isWholesale) unit = (unit * (1 - (discount / 100))) * moq;
                        basePrice = unit;
                        firstMod = 0; // absolute per-size price already includes any uplift
                    } else {
                        basePrice = product.price || 0;
                        if (isWholesale) {
                            basePrice = (basePrice * (1 - (discount / 100))) * moq;
                        }
                        firstMod = getPriceModifier(item.size) * qtyMultiplier;
                    }
                    const finalPrice = basePrice + firstMod;
                    const finalQty = Number(item.quantity) || 1; // Number of "packages"

                    total_amount += finalPrice * finalQty;
                    
                    processedItems.push({
                        product_id: product.id,
                        product_name: `${product.name} (${item.size || 'Standard'})`,
                        quantity: finalQty * qtyMultiplier,
                        price_at_time: finalPrice
                    });
                    
                    resolve();
                });
            });
        });

        Promise.all(productPromises)
            .then(() => {
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
                        if (err) return res.status(500).json({ error: err.message });

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
                res.status(500).json({ error: err.message });
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
        if (err) return res.status(500).json({ error: err.message });
        if (!orders.length) return res.json([]);

        // Single batched query for all items instead of one query per order (N+1).
        const ids = orders.map(o => o.id);
        const placeholders = ids.map(() => '?').join(',');
        db.all(`SELECT * FROM order_items WHERE order_id IN (${placeholders})`, ids, (err2, allItems) => {
            if (err2) return res.status(500).json({ error: err2.message });
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
        if (err) return res.status(500).json({ error: err.message });
        if (!order) return res.status(404).json({ error: 'Order not found' });
        
        // Fetch order items
        db.all(`SELECT * FROM order_items WHERE order_id = ?`, [orderId], (err, items) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!items || items.length === 0) return res.status(404).json({ error: 'No items in this order' });
            
            // Get the first item (primary ordered item to preview)
            const primaryItem = items[0];
            
            // Fetch product details
            db.get(`SELECT * FROM products WHERE id = ?`, [primaryItem.product_id], (err, product) => {
                if (err) return res.status(500).json({ error: err.message });
                
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
        if (err) return res.status(500).json({ error: err.message });
        if (!order) return res.status(404).json({ error: 'Order not found' });

        db.run(
            `UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [normStatus, orderId],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });

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
        if (err) return res.status(500).json({ error: err.message });
        if (!order) return res.status(404).json({ error: 'Order not found' });
        // Remove child rows first, then the order
        db.run(`DELETE FROM order_items WHERE order_id = ?`, [orderId], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            db.run(`DELETE FROM payments WHERE order_id = ?`, [orderId], () => {
                db.run(`DELETE FROM orders WHERE id = ?`, [orderId], function(err) {
                    if (err) return res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
                    return res.status(500).json({ error: err.message });
                }
                const cid = this.lastID;
                const token = jwt.sign({ cid, email: email.toLowerCase(), kind: 'customer' }, JWT_SECRET, { expiresIn: '30d' });
                res.json({ success: true, token, customer: { id: cid, name, email: email.toLowerCase(), phone: phone || null } });
            }
        );
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/customer/login', requireCustomerAccountsEnabled, loginLimiter, (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    db.get(`SELECT * FROM customer_accounts WHERE email = ?`, [email.trim().toLowerCase()], async (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
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
        if (err) return res.status(500).json({ error: err.message });
        
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
                    if (err) return res.status(500).json({ error: err.message });
                    if (this.changes === 0) return res.status(404).json({ error: 'Account not found' });
                    
                    res.json({ success: true, message: 'Password has been reset successfully. You can now log in.' });
                }
            );
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
});

app.get('/api/customer/me', authenticateCustomer, (req, res) => {
    db.get(`SELECT id, email, phone, name, created_at, last_login_at FROM customer_accounts WHERE id = ?`, [req.customer.cid], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Account not found' });
        res.json(row);
    });
});

app.put('/api/customer/me', authenticateCustomer, (req, res) => {
    const { name, phone } = req.body || {};
    db.run(`UPDATE customer_accounts SET name = COALESCE(?, name), phone = COALESCE(?, phone) WHERE id = ?`,
        [name || null, phone || null, req.customer.cid],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});

// Customer's own order history (matched by phone OR by explicit links)
app.get('/api/customer/orders', authenticateCustomer, (req, res) => {
    db.get(`SELECT phone FROM customer_accounts WHERE id = ?`, [req.customer.cid], (err, acct) => {
        if (err) return res.status(500).json({ error: err.message });
        const phone = acct && acct.phone ? acct.phone : null;
        if (!phone) return res.json([]);
        db.all(`SELECT * FROM orders WHERE customer_phone = ? ORDER BY created_at DESC`, [phone], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        });
    });
});

// ---- Customer addresses ----
app.get('/api/customer/addresses', authenticateCustomer, (req, res) => {
    db.all(`SELECT * FROM customer_addresses WHERE customer_id = ? ORDER BY is_default DESC, created_at DESC`, [req.customer.cid], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
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
                if (err) return res.status(500).json({ error: err.message });
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
                if (err) return res.status(500).json({ error: err.message });
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
        if (err) return res.status(500).json({ error: err.message });
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
        if (err) return res.status(500).json({ error: err.message });
        if (!order) return res.status(404).json({ error: 'No order found with that reference' });
        const onFile = String(order.customer_phone || '').replace(/\D/g, '').slice(-4);
        if (onFile !== last4) return res.status(403).json({ error: 'Phone does not match this order' });

        db.all(`SELECT * FROM order_items WHERE order_id = ?`, [order.id], (err, items) => {
            if (err) return res.status(500).json({ error: err.message });
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
            if (err) return res.status(500).json({ error: err.message });
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
            if (err) return res.status(500).json({ error: err.message });
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
                if (err) return res.status(500).json({ error: err.message });
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
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});
app.delete('/api/admin/reviews/:id', authenticateToken, requireManager, (req, res) => {
    db.run(`DELETE FROM product_reviews WHERE id = ?`, [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
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
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        }
    );
});
app.post('/api/wishlist', authenticateCustomer, (req, res) => {
    const { product_id } = req.body || {};
    if (!product_id) return res.status(400).json({ error: 'product_id required' });
    db.run(`INSERT OR IGNORE INTO wishlist_items (customer_id, product_id) VALUES (?, ?)`, [req.customer.cid, product_id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, added: this.changes > 0 });
    });
});
app.delete('/api/wishlist/:productId', authenticateCustomer, (req, res) => {
    db.run(`DELETE FROM wishlist_items WHERE customer_id = ? AND product_id = ?`, [req.customer.cid, req.params.productId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// ===========================================================================
//   EDIT STAFF (admin)
// ===========================================================================
app.put('/api/users/:id', authenticateToken, requireManager, async (req, res) => {
    const { username, role, password } = req.body || {};
    const updates = [];
    const values = [];
    if (username) { updates.push('username = ?'); values.push(username); }
    if (role && ['manager', 'staff'].includes(role)) { updates.push('role = ?'); values.push(role); }
    if (password) {
        if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
        const hash = await bcrypt.hash(password, 10);
        updates.push('password_hash = ?'); values.push(hash);
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    values.push(req.params.id);
    db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values, function(err) {
        if (err) {
            if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'Username already taken' });
            return res.status(500).json({ error: err.message });
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
        if (err) return res.status(500).json({ error: err.message });
        db.run(`DELETE FROM product_reviews WHERE product_id IN (${placeholders})`, ids, (err2) => {
            if (err2) return res.status(500).json({ error: err2.message });
            db.run(`DELETE FROM wishlist_items WHERE product_id IN (${placeholders})`, ids, (err3) => {
                if (err3) return res.status(500).json({ error: err3.message });
                db.run(`DELETE FROM products WHERE id IN (${placeholders})`, ids, function(err4) {
                    if (err4) return res.status(500).json({ error: err4.message });
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
        if (err) return res.status(500).json({ error: err.message });
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
                if (err) return res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: e.message });
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
