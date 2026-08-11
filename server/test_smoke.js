// Smoke tests: boots the real server on a throwaway port + database and
// exercises the critical paths end-to-end. Run with `npm test` from server/.
// No test framework — plain assertions, exit 1 on any failure — so it runs
// anywhere Node runs, including a fresh clone with only `npm install` done.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TEST_PORT = 3041;
const TEST_DB = path.join(__dirname, '_smoketest.db');
const BASE = `http://localhost:${TEST_PORT}`;

// Set (not delete) every env var the server reads: dotenv loads server/.env at
// require time but never overrides variables that are already set, so explicit
// values here insulate the test from whatever the operator has in .env.
process.env.PORT = String(TEST_PORT);
process.env.DB_PATH = TEST_DB;
process.env.NODE_ENV = 'test';              // dev mode: localhost bypasses rate limits
process.env.RESEND_API_KEY = '';            // emails log to console instead of sending
process.env.OWNER_EMAIL = 'owner@test.com'; // the test's first sign-up is the owner
process.env.FIREBASE_API_KEY = 'smoke-public-api-key';
process.env.FIREBASE_AUTH_DOMAIN = 'smoke-test.firebaseapp.com';
process.env.FIREBASE_PROJECT_ID = 'smoke-test';
process.env.FIREBASE_APP_ID = '1:123:web:smoke';
process.env.PAYSTACK_SECRET_KEY = 'paystack-smoke-secret';
process.env.PAYSTACK_LEGACY_WEBHOOK_URL = 'https://legacy.example.test/paystack';
process.env.SHOP_NOTIFY_EMAIL = 'shop@test.com';

let passed = 0;
let failed = 0;
const uploadedTestFiles = [];
function check(name, cond, detail) {
    if (cond) { passed++; console.log(`  PASS  ${name}`); }
    else { failed++; console.error(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
const close = (a, b) => Math.abs(Number(a) - Number(b)) < 0.01;

function cleanupDb() {
    ['', '-wal', '-shm'].forEach(ext => {
        try { fs.unlinkSync(TEST_DB + ext); } catch (e) { /* not present */ }
    });
    uploadedTestFiles.forEach(rel => {
        try { fs.unlinkSync(path.join(__dirname, '..', rel)); } catch (e) { /* not present */ }
    });
}

// The OTP flow emails a 6-digit code; without RESEND_API_KEY the server prints
// it as "[SIGN-IN CODE] email -> 123456". Capture it from console output.
let lastOtp = '';
const origLog = console.log;
console.log = function (...args) {
    const s = args.join(' ');
    const m = /\[SIGN-IN CODE\]\s+\S+\s+->\s+(\d{6})/.exec(s);
    if (m) lastOtp = m[1];
    origLog.apply(console, args);
};

async function waitForServer(tries) {
    for (let i = 0; i < tries; i++) {
        try {
            const r = await fetch(`${BASE}/api/settings`);
            if (r.ok) return true;
        } catch (e) { /* not up yet */ }
        await new Promise(r => setTimeout(r, 500));
    }
    return false;
}

const json = (method, body, extraHeaders) => ({
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}),
    body: JSON.stringify(body)
});

async function run() {
    cleanupDb();
    const app = require('./server'); // boots on TEST_PORT against TEST_DB
    const firebaseTokens = {
        'verified-new': { uid: 'firebase-new', email: 'new.customer@test.com', email_verified: true, name: 'New Customer' },
        'verified-second': { uid: 'firebase-second', email: 'second.customer@test.com', email_verified: true, name: 'Second Customer' },
        'verified-conflict': { uid: 'firebase-conflict', email: 'new.customer@test.com', email_verified: true, name: 'Conflict' },
        'verified-legacy': { uid: 'firebase-legacy', email: 'legacy.customer@test.com', email_verified: true, name: 'Firebase Name' },
        unverified: { uid: 'firebase-unverified', email: 'unverified@test.com', email_verified: false, name: 'Unverified' }
    };
    app.set('verifyCustomerIdToken', async (token) => {
        if (token === 'expired' || token === 'malformed' || !firebaseTokens[token]) {
            const error = new Error(token === 'expired' ? 'Firebase ID token has expired' : 'Invalid Firebase ID token');
            error.code = token === 'expired' ? 'auth/id-token-expired' : 'auth/argument-error';
            throw error;
        }
        return firebaseTokens[token];
    });
    let paystackInitializePayload = null;
    let ownerPaymentEmails = 0;
    let forwardedWebhookBody = '';
    let forwardingShouldFail = false;
    app.set('paystackApiRequest', async (apiPath, method, payload) => {
        if (apiPath === '/transaction/initialize' && method === 'POST') {
            paystackInitializePayload = payload;
            return { authorization_url: `https://checkout.paystack.test/${payload.reference}`, reference: payload.reference, access_code: 'access-smoke' };
        }
        return { status: 'pending' };
    });
    app.set('sendOrderNotificationEmail', async () => { ownerPaymentEmails++; return { ok: true }; });
    app.set('forwardLegacyPaystackWebhook', async (rawBody) => {
        if (forwardingShouldFail) throw new Error('legacy unavailable');
        forwardedWebhookBody = rawBody.toString('utf8');
        return { ok: true };
    });
    const db = require('./db');
    const dbRun = (sql, params) => new Promise((resolve, reject) => db.run(sql, params || [], function(err) { err ? reject(err) : resolve(this); }));
    const dbGet = (sql, params) => new Promise((resolve, reject) => db.get(sql, params || [], (err, row) => err ? reject(err) : resolve(row)));

    async function postPaystackWebhook(event, signatureOverride) {
        const raw = JSON.stringify(event);
        const signature = signatureOverride || crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(raw).digest('hex');
        return fetch(`${BASE}/api/payments/paystack/webhook`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-paystack-signature': signature }, body: raw
        });
    }

    const up = await waitForServer(30);
    if (!up) { console.error('FATAL: server did not start'); process.exit(1); }

    // ---- fresh-database boot: seeded from the products.json snapshot ----
    const products = await (await fetch(`${BASE}/api/products`)).json();
    check('fresh DB seeds full catalogue', Array.isArray(products) && products.length >= 200, `got ${products.length}`);
    const catsWithProducts = new Set(products.map(p => p.cat));
    check('all storefront categories populated',
        ['clothing', 'shoes', 'feeding', 'gear', 'bathcare', 'bedding'].every(c => catsWithProducts.has(c)),
        `cats: ${[...catsWithProducts].join(',')}`);
    const seededSkus = products.map(p => String(p.sku || ''));
    check('fresh catalogue has no blank SKUs', seededSkus.every(Boolean));
    check('fresh catalogue SKUs are unique', new Set(seededSkus).size === seededSkus.length);
    check('SKU prefixes cover every category', products.every(p => /^(CLO|SHO|ACC|NEW|BED|ESS|FEE|GEA|BAT)-\d{4}$/.test(p.sku)), 'unexpected SKU prefix');
    const categoryAssets = ['newborn','clothing','shoes','feeding','gear','bathcare','essentials','accessories','bedding'];
    const categoryImageCount = products.filter(p => /^images\/category-fallbacks\/[a-z]+\.webp$/.test(p.img || '')).length;
    check('placeholder products reuse category artwork', categoryImageCount >= 180, `got ${categoryImageCount}`);
    check('all category fallback assets exist', categoryAssets.every(name => fs.existsSync(path.join(__dirname, '..', 'images', 'category-fallbacks', name + '.webp'))));
    const imageResolver = require('../image-resolver');
    check('all categories resolve to their matching fallback', categoryAssets.every(name => imageResolver.resolve({ cat: name, img: 'images/placeholder.svg' }).src === 'images/category-fallbacks/' + name + '.webp'));
    check('stored category artwork remains visibly labelled', categoryAssets.every(name => {
        const resolved = imageResolver.resolve({ cat: name, img: 'images/category-fallbacks/' + name + '.webp' });
        return resolved.src === 'images/category-fallbacks/' + name + '.webp' && resolved.isCategoryFallback === true && imageResolver.isGenuineImage(resolved.src) === false;
    }));
    check('legacy logo duplicates resolve as category artwork', ['product_50.jpg', 'product_66.jpg', 'product_83.jpg'].every(name => {
        const resolved = imageResolver.resolve({ cat: 'shoes', img: 'images/' + name });
        return resolved.src === 'images/category-fallbacks/shoes.webp' && resolved.isCategoryFallback === true;
    }));
    check('source catalogue contains no known logo placeholders', products.every(p => !imageResolver.isKnownLogoPlaceholder(p.img)));
    const realImage = imageResolver.resolve({ cat: 'clothing', img: 'images/product_42.jpg' });
    check('genuine product images remain unchanged', realImage.src === 'images/product_42.jpg' && realImage.isCategoryFallback === false);
    const swSource = fs.readFileSync(path.join(__dirname, '..', 'service-worker.js'), 'utf8');
    check('service worker caches category fallbacks', categoryAssets.every(name => swSource.includes('/images/category-fallbacks/' + name + '.webp')));
    check('service worker image failure returns SVG placeholder', swSource.includes("isImage ? caches.match('/images/placeholder.svg')"));

    // ---- static frontend ----
    for (const page of ['/', '/admin.html', '/track.html', '/account.html']) {
        const r = await fetch(`${BASE}${page}`);
        check(`serves ${page}`, r.status === 200, `status ${r.status}`);
    }

    let r = await fetch(`${BASE}/api/customer/auth/config`);
    const firebaseConfig = await r.json();
    check('customer auth config returns only public Firebase fields',
        r.status === 200 && Object.keys(firebaseConfig).sort().join(',') === 'apiKey,appId,authDomain,projectId' && firebaseConfig.projectId === 'smoke-test');
    check('customer API responses prohibit caching', /no-store/.test(r.headers.get('cache-control') || ''));

    r = await fetch(`${BASE}/api/auth/config`);
    const adminAuthConfig = await r.json();
    check('admin auth config reports local email-code availability',
        r.status === 200 && adminAuthConfig.emailCodeAvailable === true);

    // ---- auth: passwordless flow ----
    r = await fetch(`${BASE}/api/orders`);
    check('orders list requires auth', r.status === 401, `status ${r.status}`);

    // First sign-up bootstraps the owner and returns one-time recovery codes.
    r = await fetch(`${BASE}/api/admin/register`, json('POST', {
        full_name: 'Smoke Owner', email: 'owner@test.com', phone: '0241111111'
    }));
    const reg = await r.json();
    check('first sign-up becomes owner', r.status === 201 && reg.owner === true, `status ${r.status}`);
    check('owner receives recovery codes', Array.isArray(reg.recoveryCodes) && reg.recoveryCodes.length > 0);

    // Email OTP: request a code (captured from the console) and verify it.
    r = await fetch(`${BASE}/api/auth/request-code`, json('POST', { email: 'owner@test.com' }));
    check('request-code succeeds for active user', r.status === 200, `status ${r.status}`);
    check('sign-in code issued', /^\d{6}$/.test(lastOtp), `captured "${lastOtp}"`);

    r = await fetch(`${BASE}/api/auth/verify-code`, json('POST', { email: 'owner@test.com', code: '000000' === lastOtp ? '111111' : '000000' }));
    check('wrong code rejected', r.status === 400, `status ${r.status}`);

    r = await fetch(`${BASE}/api/auth/verify-code`, json('POST', { email: 'owner@test.com', code: lastOtp }));
    const login = await r.json();
    check('correct code issues session', r.status === 200 && !!login.accessToken, `status ${r.status}`);
    const auth = { 'Authorization': `Bearer ${login.accessToken}` };

    r = await fetch(`${BASE}/api/orders`, { headers: auth });
    check('orders list works with token', r.status === 200, `status ${r.status}`);

    // ---- deterministic SKU backfill preserves manual assignments ----
    await dbRun(`UPDATE products SET sku = 'MANUAL-KEEP' WHERE id = 1`);
    await dbRun(`UPDATE products SET sku = NULL WHERE id = 2`);
    await new Promise(resolve => db.backfillMissingProductSkus(resolve));
    const skuRows = await Promise.all([dbGet(`SELECT sku FROM products WHERE id = 1`), dbGet(`SELECT sku FROM products WHERE id = 2`)]);
    check('SKU backfill preserves manually assigned SKU', skuRows[0].sku === 'MANUAL-KEEP', skuRows[0].sku);
    check('SKU backfill deterministically fills blank SKU', /^(CLO|SHO|ACC|NEW|BED|ESS|FEE|GEA|BAT)-\d{4}$/.test(skuRows[1].sku), skuRows[1].sku);
    const firstBackfill = skuRows[1].sku;
    await new Promise(resolve => db.backfillMissingProductSkus(resolve));
    check('SKU backfill is stable on rerun', (await dbGet(`SELECT sku FROM products WHERE id = 2`)).sku === firstBackfill);

    // ---- bulk image upload + transactional mapping ----
    const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z5xkAAAAASUVORK5CYII=';
    async function uploadTiny() {
        const response = await fetch(`${BASE}/api/upload-image`, json('POST', { dataUrl: tinyPng }, auth));
        const body = await response.json();
        if (body.path) uploadedTestFiles.push(body.path);
        return { response, body };
    }
    const uploadA = await uploadTiny();
    const uploadB = await uploadTiny();
    check('product image upload returns server path', uploadA.response.status === 200 && /^images\/product_upload_/.test(uploadA.body.path || ''));
    r = await fetch(`${BASE}/api/products/bulk-images`, json('POST', { items: [{ id: 1, img: 'images/placeholder.svg' }] }, auth));
    check('bulk mapping rejects unsafe image path', r.status === 400, `status ${r.status}`);
    r = await fetch(`${BASE}/api/products/bulk-images`, json('POST', { items: [{ id: 1, img: uploadA.body.path }, { id: 1, img: uploadB.body.path }] }, auth));
    check('bulk mapping rejects duplicate IDs', r.status === 400, `status ${r.status}`);
    const imageBeforeRollback = (await dbGet(`SELECT img FROM products WHERE id = 1`)).img;
    r = await fetch(`${BASE}/api/products/bulk-images`, json('POST', { items: [{ id: 1, img: uploadA.body.path }, { id: 999999, img: uploadB.body.path }] }, auth));
    check('bulk mapping rejects unknown products', r.status === 404, `status ${r.status}`);
    check('bulk mapping rollback leaves valid product unchanged', (await dbGet(`SELECT img FROM products WHERE id = 1`)).img === imageBeforeRollback);
    r = await fetch(`${BASE}/api/products/bulk-images`, json('POST', { items: [{ id: 1, img: uploadA.body.path }] }, auth));
    const bulkMapped = await r.json();
    check('bulk mapping updates valid item', r.status === 200 && bulkMapped.updated === 1, `status ${r.status}`);
    check('bulk mapping persists image path', (await dbGet(`SELECT img FROM products WHERE id = 1`)).img === uploadA.body.path);
    r = await fetch(`${BASE}/api/products/image-health`, { headers: auth });
    const health = await r.json();
    check('image health report includes all safeguards', r.status === 200 && ['missingImages','missingSkus','duplicateSkus','invalidPaths','unusedUploads'].every(k => Array.isArray(health[k])));


    // Recovery code is a valid backup sign-in.
    r = await fetch(`${BASE}/api/auth/recovery`, json('POST', { email: 'owner@test.com', code: reg.recoveryCodes[0] }));
    const rec = await r.json();
    check('recovery code signs in', r.status === 200 && !!rec.accessToken, `status ${r.status}`);
    r = await fetch(`${BASE}/api/auth/recovery`, json('POST', { email: 'owner@test.com', code: reg.recoveryCodes[0] }));
    check('recovery code is one-time', r.status === 400, `status ${r.status}`);

    // Unknown email gets a generic answer (no account enumeration).
    r = await fetch(`${BASE}/api/auth/request-code`, json('POST', { email: 'nobody@test.com' }));
    check('unknown email not revealed', r.status === 200, `status ${r.status}`);

    // Second sign-up is a pending staff request that cannot sign in yet.
    r = await fetch(`${BASE}/api/admin/register`, json('POST', {
        full_name: 'New Staff', email: 'staff@test.com'
    }));
    const reg2 = await r.json();
    check('second sign-up is pending staff', r.status === 201 && reg2.owner === false, `status ${r.status}`);
    r = await fetch(`${BASE}/api/auth/request-code`, json('POST', { email: 'staff@test.com' }));
    check('pending staff cannot request code', r.status === 403, `status ${r.status}`);

    // Owner adds a staff member directly (passwordless) — active immediately.
    r = await fetch(`${BASE}/api/users`, json('POST', { full_name: 'Direct Staff', email: 'direct@test.com', role: 'staff' }, auth));
    const created = await r.json();
    check('owner adds staff directly', r.status === 201 && created.id > 0, `status ${r.status}`);
    r = await fetch(`${BASE}/api/auth/request-code`, json('POST', { email: 'direct@test.com' }));
    check('new staff can request a sign-in code', r.status === 200, `status ${r.status}`);

    // Sign the new staff member in for real (OTP just requested above), so we
    // can prove their session dies the moment they're deleted.
    r = await fetch(`${BASE}/api/auth/verify-code`, json('POST', { email: 'direct@test.com', code: lastOtp }));
    const staffLogin = await r.json();
    check('direct staff can sign in', r.status === 200 && !!staffLogin.accessToken, `status ${r.status}`);

    // Deleting a user must also remove their sign-in code rows (FK) — this
    // exact case used to fail with "FOREIGN KEY constraint failed".
    r = await fetch(`${BASE}/api/users/${created.id}`, { method: 'DELETE', headers: auth });
    check('staff with sign-in codes deletable', r.status === 200, `status ${r.status}`);

    // Their still-unexpired JWT must be dead immediately (per-request re-check).
    r = await fetch(`${BASE}/api/orders`, { headers: { 'Authorization': `Bearer ${staffLogin.accessToken}` } });
    check('deleted staff token revoked instantly', r.status === 403, `status ${r.status}`);

    // ---- guest checkout: retail, server-side total ----
    // Expected totals derive from the seeded product so the test tracks the
    // catalogue: managed sizes win, otherwise base price (+0 modifier size).
    const p1 = products.find(p => p.id === 1);
    let managed = null;
    try { const arr = JSON.parse(p1.sizes); if (Array.isArray(arr) && arr.length) managed = arr; } catch (e) { /* no managed sizes → base price path */ }
    const sizeLabel = managed ? managed[0].label : '6M';
    const unitRetail = managed ? (managed[0].price != null ? managed[0].price : p1.price) : p1.price;

    r = await fetch(`${BASE}/api/orders`, json('POST', {
        customer_name: 'Smoke Test', customer_phone: '0241234567',
        order_type: 'retail', items: [{ id: 1, quantity: 2, size: sizeLabel }]
    }));
    const order = await r.json();
    check('guest checkout creates order', r.status === 200 && order.success === true);
    check('order number assigned', /^ORD-\d+$/.test(order.order_number || ''), order.order_number);
    check(`retail total = unit x 2 (${unitRetail} x 2)`, close(order.total_amount, unitRetail * 2), `got ${order.total_amount}`);

    // ---- Paystack direct checkout and shared webhook router ----
    r = await fetch(`${BASE}/api/payments/paystack/config`);
    check('Paystack availability is public without exposing keys', r.status === 200 && (await r.json()).enabled === true);
    r = await fetch(`${BASE}/api/checkout/paystack`, json('POST', {
        customer_name: 'Direct Guest', customer_phone: '0249000000', customer_email: '',
        order_type: 'retail', items: [{ id: 1, quantity: 1, size: sizeLabel }]
    }));
    check('Paystack checkout requires email and full address', r.status === 400, `status ${r.status}`);

    const directPayload = {
        customer_name: 'Direct Guest', customer_phone: '0249000000', customer_email: 'direct@test.com',
        order_type: 'retail', amount: 1,
        delivery_address: { line1: '10 Test Avenue', city: 'Kasoa', region: 'Central Region', landmark: 'Near the market' },
        items: [{ id: 1, quantity: 1, size: sizeLabel }]
    };
    r = await fetch(`${BASE}/api/checkout/paystack`, json('POST', directPayload));
    const directOrder = await r.json();
    check('guest Paystack checkout initializes', r.status === 200 && /^DCK-\d+-[a-f0-9]{20}$/.test(directOrder.reference || ''));
    check('Paystack amount is server-calculated in pesewas', Number(paystackInitializePayload.amount) === Math.round(unitRetail * 100), `got ${paystackInitializePayload && paystackInitializePayload.amount}`);
    const directDbOrder = await dbGet('SELECT * FROM orders WHERE order_number = ?', [directOrder.order_number]);
    check('Paystack order stores address snapshot before payment', directDbOrder.status === 'awaiting_payment' && directDbOrder.delivery_address_line1 === '10 Test Avenue' && directDbOrder.customer_email === 'direct@test.com');

    r = await postPaystackWebhook({ event: 'charge.success', data: { reference: directOrder.reference } }, 'bad-signature');
    check('Paystack webhook rejects invalid signature', r.status === 401, `status ${r.status}`);
    r = await postPaystackWebhook({ event: 'charge.success', data: {
        id: 1001, reference: directOrder.reference, status: 'success', amount: 1, currency: 'GHS', channel: 'card',
        metadata: { source_app: 'dckids', order_number: directOrder.order_number }
    }});
    check('Paystack amount mismatch is acknowledged for manual review', r.status === 200, `status ${r.status}`);
    check('mismatched Paystack order is not marked paid', (await dbGet('SELECT status FROM orders WHERE id = ?', [directDbOrder.id])).status === 'payment_review');

    r = await fetch(`${BASE}/api/checkout/paystack`, json('POST', Object.assign({}, directPayload, { customer_email: 'paid@test.com' })));
    const paidOrder = await r.json();
    const paidDbOrder = await dbGet('SELECT * FROM orders WHERE order_number = ?', [paidOrder.order_number]);
    const stockBeforePayment = (await dbGet('SELECT stock FROM products WHERE id = 1')).stock;
    const successEvent = { event: 'charge.success', data: {
        id: 1002, reference: paidOrder.reference, status: 'success', amount: Math.round(unitRetail * 100), currency: 'GHS',
        channel: 'mobile_money', gateway_response: 'Successful', paid_at: new Date().toISOString(),
        metadata: { source_app: 'dckids', order_number: paidOrder.order_number }
    }};
    r = await postPaystackWebhook(successEvent);
    check('signed Paystack success marks the order paid', r.status === 200 && (await dbGet('SELECT status FROM orders WHERE id = ?', [paidDbOrder.id])).status === 'paid');
    const stockAfterPayment = (await dbGet('SELECT stock FROM products WHERE id = 1')).stock;
    check('successful Paystack payment deducts stock once', stockAfterPayment === Math.max(0, stockBeforePayment - 1), `${stockBeforePayment} -> ${stockAfterPayment}`);
    r = await postPaystackWebhook(successEvent);
    check('duplicate Paystack webhook is idempotent', r.status === 200 && (await dbGet('SELECT stock FROM products WHERE id = 1')).stock === stockAfterPayment);
    check('owner receives one itemized paid-order email', ownerPaymentEmails === 1, `got ${ownerPaymentEmails}`);
    r = await fetch(`${BASE}/api/payments/paystack/status/${paidOrder.reference}`);
    const paidStatus = await r.json();
    check('payment status endpoint returns no PII', r.status === 200 && paidStatus.payment_status === 'paid' && !paidStatus.customer_email && !paidStatus.items);

    const legacyEvent = { event: 'charge.success', data: { reference: 'OTHER-APP-123', status: 'success', amount: 5000, currency: 'GHS' } };
    r = await postPaystackWebhook(legacyEvent);
    check('non-DCK webhook is forwarded unchanged', r.status === 200 && forwardedWebhookBody === JSON.stringify(legacyEvent));
    forwardingShouldFail = true;
    r = await postPaystackWebhook(legacyEvent);
    check('legacy forwarding failure remains retriable', r.status === 500 || r.status === 502, `status ${r.status}`);
    forwardingShouldFail = false;

    // ---- Firebase customer identity and protected account data ----
    const customerAuth = { 'Authorization': 'Bearer verified-new' };
    const secondCustomerAuth = { 'Authorization': 'Bearer verified-second' };
    r = await fetch(`${BASE}/api/customer/me`);
    check('customer profile requires a bearer token', r.status === 401, `status ${r.status}`);
    for (const token of ['expired', 'malformed']) {
        r = await fetch(`${BASE}/api/customer/session`, json('POST', {}, { 'Authorization': `Bearer ${token}` }));
        check(`${token} Firebase token is rejected`, r.status === 401, `status ${r.status}`);
    }
    r = await fetch(`${BASE}/api/customer/session`, json('POST', {}, { 'Authorization': 'Bearer unverified' }));
    check('unverified Firebase email cannot provision an account', r.status === 403, `status ${r.status}`);

    r = await fetch(`${BASE}/api/customer/session`, json('POST', { phone: '0243333333' }, customerAuth));
    const customerSession = await r.json();
    check('verified Firebase identity provisions a customer', r.status === 200 && customerSession.created === true && customerSession.customer.email === 'new.customer@test.com');
    const customerId = customerSession.customer.id;
    r = await fetch(`${BASE}/api/customer/session`, json('POST', {}, customerAuth));
    const repeatedSession = await r.json();
    check('customer session provisioning is idempotent', r.status === 200 && repeatedSession.created === false && repeatedSession.customer.id === customerId);
    r = await fetch(`${BASE}/api/customer/session`, json('POST', {}, { 'Authorization': 'Bearer verified-conflict' }));
    check('conflicting verified identity is rejected', r.status === 409, `status ${r.status}`);

    r = await fetch(`${BASE}/api/customer/me`, { headers: customerAuth });
    const initialProfile = await r.json();
    check('verified customer can read profile', r.status === 200 && initialProfile.id === customerId);
    r = await fetch(`${BASE}/api/customer/me`, json('PUT', { name: 'Updated Customer', phone: '0244444444', email: 'changed@test.com' }, customerAuth));
    const updatedProfile = await r.json();
    check('profile updates name and phone', r.status === 200 && updatedProfile.customer.name === 'Updated Customer' && updatedProfile.customer.phone === '0244444444');
    check('profile email is immutable', updatedProfile.customer.email === 'new.customer@test.com');
    r = await fetch(`${BASE}/api/customer/me`, json('PUT', { name: 'X', phone: '024' }, customerAuth));
    check('profile validation rejects short names', r.status === 400, `status ${r.status}`);

    r = await fetch(`${BASE}/api/wishlist/merge`, json('POST', { productIds: [1, 2, 1] }, customerAuth));
    const firstMerge = await r.json();
    check('wishlist merge creates a validated union', r.status === 200 && firstMerge.productIds.includes(1) && firstMerge.productIds.includes(2));
    r = await fetch(`${BASE}/api/wishlist/merge`, json('POST', { productIds: [2, 1] }, customerAuth));
    const secondMerge = await r.json();
    check('wishlist merge is idempotent', r.status === 200 && secondMerge.productIds.length === 2);
    r = await fetch(`${BASE}/api/wishlist/merge`, json('POST', { productIds: [999999] }, customerAuth));
    check('wishlist merge rejects unknown products', r.status === 400, `status ${r.status}`);

    r = await fetch(`${BASE}/api/customer/addresses`, json('POST', {
        label: 'Home', recipient_name: 'Updated Customer', phone: '0244444444',
        address_line1: '1 Test Street', city: 'Accra', region: 'Greater Accra', is_default: true
    }, customerAuth));
    const address = await r.json();
    check('customer can save a delivery address', r.status === 200 && address.id > 0);
    r = await fetch(`${BASE}/api/customer/session`, json('POST', {}, secondCustomerAuth));
    check('second verified identity provisions separately', r.status === 200, `status ${r.status}`);
    r = await fetch(`${BASE}/api/customer/addresses/${address.id}`, { method: 'DELETE', headers: secondCustomerAuth });
    check('address ownership prevents cross-account deletion', r.status === 404, `status ${r.status}`);

    r = await fetch(`${BASE}/api/products/1/reviews`, json('POST', {
        rating: 4, title: 'Account review', body: 'Linked to the signed-in customer.'
    }, customerAuth));
    check('signed-in review is accepted', r.status === 200, `status ${r.status}`);
    r = await fetch(`${BASE}/api/customer/reviews`, { headers: customerAuth });
    const customerReviews = await r.json();
    check('signed-in review is attributed to the customer', r.status === 200 && customerReviews.some(review => review.title === 'Account review'));

    r = await fetch(`${BASE}/api/customer/orders`, { headers: customerAuth });
    const ordersBeforeCustomerCheckout = await r.json();
    check('guest order remains unowned', r.status === 200 && !ordersBeforeCustomerCheckout.some(item => item.order_number === order.order_number));
    r = await fetch(`${BASE}/api/orders`, json('POST', {
        customer_name: 'Updated Customer', customer_phone: '0244444444',
        order_type: 'retail', items: [{ id: 1, quantity: 1, size: sizeLabel }]
    }, customerAuth));
    const customerOrder = await r.json();
    check('authenticated checkout creates an order', r.status === 200 && customerOrder.success === true);
    r = await fetch(`${BASE}/api/customer/orders`, { headers: customerAuth });
    const customerOrders = await r.json();
    check('authenticated order is attached with its items', r.status === 200 && customerOrders.some(item => item.order_number === customerOrder.order_number && item.items.length === 1));
    r = await fetch(`${BASE}/api/checkout/paystack`, json('POST', {
        customer_name: 'Updated Customer', customer_phone: '0244444444', customer_email: 'spoofed@test.com',
        order_type: 'retail', delivery_address: { line1: '1 Test Street', city: 'Accra', region: 'Greater Accra' },
        items: [{ id: 1, quantity: 1, size: sizeLabel }]
    }, customerAuth));
    const signedInDirectOrder = await r.json();
    const signedInDirectDb = await dbGet('SELECT customer_account_id, customer_email FROM orders WHERE order_number = ?', [signedInDirectOrder.order_number]);
    check('signed-in Paystack order uses verified account identity', r.status === 200 && signedInDirectDb.customer_account_id === customerId && signedInDirectDb.customer_email === 'new.customer@test.com');
    const orderCountBeforeInvalidToken = (await dbGet(`SELECT COUNT(*) AS count FROM orders`)).count;
    r = await fetch(`${BASE}/api/orders`, json('POST', {
        customer_name: 'Invalid Token', customer_phone: '0245555555',
        order_type: 'retail', items: [{ id: 1, quantity: 1, size: sizeLabel }]
    }, { 'Authorization': 'Bearer malformed' }));
    check('invalid bearer token cannot downgrade to guest checkout', r.status === 401, `status ${r.status}`);
    check('invalid bearer token creates no order', (await dbGet(`SELECT COUNT(*) AS count FROM orders`)).count === orderCountBeforeInvalidToken);

    // A verified email links a legacy record once, preserving account data and
    // claiming only the historical orders that matched its stored phone then.
    const legacyInsert = await dbRun(
        `INSERT INTO customer_accounts (email, phone, name, password_hash) VALUES (?, ?, ?, ?)`,
        ['legacy.customer@test.com', '0551234567', 'Legacy Customer', 'retired-hash']
    );
    await dbRun(`INSERT INTO customer_addresses (customer_id, label, address_line1, city, is_default) VALUES (?, ?, ?, ?, 1)`, [legacyInsert.lastID, 'Legacy Home', 'Old Road', 'Kumasi']);
    await dbRun(`INSERT INTO wishlist_items (customer_id, product_id) VALUES (?, ?)`, [legacyInsert.lastID, 1]);
    await dbRun(`INSERT INTO product_reviews (product_id, customer_id, author_name, rating, body) VALUES (?, ?, ?, ?, ?)`, [1, legacyInsert.lastID, 'Legacy Customer', 5, 'Preserved legacy review']);
    r = await fetch(`${BASE}/api/orders`, json('POST', {
        customer_name: 'Legacy Customer', customer_phone: '0551234567',
        order_type: 'retail', items: [{ id: 1, quantity: 1, size: sizeLabel }]
    }));
    const legacyOrder = await r.json();
    r = await fetch(`${BASE}/api/customer/session`, json('POST', {}, { 'Authorization': 'Bearer verified-legacy' }));
    const legacySession = await r.json();
    check('verified email links its legacy account', r.status === 200 && legacySession.linkedLegacy === true && legacySession.customer.id === legacyInsert.lastID);
    r = await fetch(`${BASE}/api/customer/orders`, { headers: { 'Authorization': 'Bearer verified-legacy' } });
    const linkedLegacyOrders = await r.json();
    check('legacy order phone match is backfilled once', linkedLegacyOrders.some(item => item.order_number === legacyOrder.order_number));
    r = await fetch(`${BASE}/api/wishlist`, { headers: { 'Authorization': 'Bearer verified-legacy' } });
    check('legacy wishlist survives linking', r.status === 200 && (await r.json()).some(item => item.product_id === 1));
    r = await fetch(`${BASE}/api/customer/me`, json('PUT', { name: 'Legacy Customer', phone: '0509999999' }, { 'Authorization': 'Bearer verified-legacy' }));
    check('linked customer can later change phone', r.status === 200, `status ${r.status}`);
    r = await fetch(`${BASE}/api/orders`, json('POST', {
        customer_name: 'Someone Else', customer_phone: '0509999999',
        order_type: 'retail', items: [{ id: 1, quantity: 1, size: sizeLabel }]
    }));
    const laterPhoneOrder = await r.json();
    await fetch(`${BASE}/api/customer/session`, json('POST', {}, { 'Authorization': 'Bearer verified-legacy' }));
    r = await fetch(`${BASE}/api/customer/orders`, { headers: { 'Authorization': 'Bearer verified-legacy' } });
    check('later phone changes never claim unrelated orders', !(await r.json()).some(item => item.order_number === laterPhoneOrder.order_number));

    // ---- wholesale: per-piece discount, MOQ floor ----
    const settings = await (await fetch(`${BASE}/api/settings`)).json();
    const moq = settings.wholesale_moq;
    const disc = settings.wholesale_discount;
    const unitWs = Math.round(unitRetail * (1 - disc / 100) * 100) / 100;

    r = await fetch(`${BASE}/api/orders`, json('POST', {
        customer_name: 'Bulk Buyer', customer_phone: '0242222222',
        order_type: 'wholesale', items: [{ id: 1, quantity: moq, size: sizeLabel }]
    }));
    const wsOrder = await r.json();
    check(`wholesale total = discounted unit x MOQ (${unitWs} x ${moq})`,
        r.status === 200 && close(wsOrder.total_amount, unitWs * moq), `got ${wsOrder.total_amount}`);

    r = await fetch(`${BASE}/api/orders`, json('POST', {
        customer_name: 'Bulk Buyer', customer_phone: '0242222222',
        order_type: 'wholesale', items: [{ id: 1, quantity: moq - 1, size: sizeLabel }]
    }));
    check('wholesale below MOQ rejected', r.status === 400, `status ${r.status}`);

    // ---- checkout validation ----
    const badOrders = [
        ['negative quantity', { items: [{ id: 1, quantity: -5 }] }],
        ['huge quantity', { items: [{ id: 1, quantity: 5000 }] }],
        ['non-integer quantity', { items: [{ id: 1, quantity: 1.5 }] }],
        ['invalid product id', { items: [{ id: 'abc', quantity: 1 }] }],
        ['too many items', { items: Array.from({ length: 51 }, () => ({ id: 1, quantity: 1 })) }],
        ['empty items', { items: [] }]
    ];
    for (const [name, body] of badOrders) {
        r = await fetch(`${BASE}/api/orders`, json('POST', Object.assign({
            customer_name: 'X', customer_phone: '024', order_type: 'retail'
        }, body)));
        check(`checkout rejects ${name}`, r.status === 400, `status ${r.status}`);
    }

    // ---- order tracking ----
    r = await fetch(`${BASE}/api/orders/track`, json('POST', { order_number: order.order_number, phone: '0241234567' }));
    check('tracking works with matching phone', r.status === 200, `status ${r.status}`);
    r = await fetch(`${BASE}/api/orders/track`, json('POST', { order_number: order.order_number, phone: '0209999999' }));
    check('tracking rejects wrong phone', r.status === 403, `status ${r.status}`);

    // ---- order status whitelist ----
    const orders = await (await fetch(`${BASE}/api/orders`, { headers: auth })).json();
    const dbId = orders[0].id;
    r = await fetch(`${BASE}/api/orders/${dbId}`, json('PUT', { status: 'not-a-status' }, auth));
    check('status update rejects unknown status', r.status === 400, `status ${r.status}`);
    r = await fetch(`${BASE}/api/orders/${dbId}`, json('PUT', { status: 'paid' }, auth));
    check('status update accepts paid', r.status === 200, `status ${r.status}`);

    // ---- reviews validation ----
    r = await fetch(`${BASE}/api/products/1/reviews`, json('POST', {
        rating: 5, body: 'Great quality, my son loves it!', author_name: 'Smoke Test'
    }));
    check('review submits', r.status === 200, `status ${r.status}`);
    r = await fetch(`${BASE}/api/products/1/reviews`, json('POST', { rating: 9, body: 'rating out of range' }));
    check('review rejects rating > 5', r.status === 400, `status ${r.status}`);
    r = await fetch(`${BASE}/api/products/1/reviews`, json('POST', { rating: 5, body: 'x'.repeat(2001) }));
    check('review rejects oversized body', r.status === 400, `status ${r.status}`);

    // ---- retired local customer passwords ----
    r = await fetch(`${BASE}/api/customer/register`, json('POST', { name: 'X', email: 'x@x.com', password: 'longenough1' }));
    check('local customer register is permanently retired', r.status === 404 || r.status === 410, `status ${r.status}`);

    // ---- malformed JSON ----
    r = await fetch(`${BASE}/api/orders`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad json'
    });
    check('malformed JSON returns 400', r.status === 400, `status ${r.status}`);

    console.log(`\n${passed} passed, ${failed} failed`);
    cleanupDb();
    process.exit(failed ? 1 : 0);
}

run().catch(err => {
    console.error('FATAL:', err);
    cleanupDb();
    process.exit(1);
});
