// Smoke tests: boots the real server on a throwaway port + database and
// exercises the critical paths end-to-end. Run with `npm test` from server/.
// No test framework — plain assertions, exit 1 on any failure — so it runs
// anywhere Node runs, including a fresh clone with only `npm install` done.
const fs = require('fs');
const path = require('path');

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

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
    if (cond) { passed++; console.log(`  PASS  ${name}`); }
    else { failed++; console.error(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
const close = (a, b) => Math.abs(Number(a) - Number(b)) < 0.01;

function cleanupDb() {
    ['', '-wal', '-shm'].forEach(ext => {
        try { fs.unlinkSync(TEST_DB + ext); } catch (e) { /* not present */ }
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
    require('./server'); // boots on TEST_PORT against TEST_DB

    const up = await waitForServer(30);
    if (!up) { console.error('FATAL: server did not start'); process.exit(1); }

    // ---- fresh-database boot: seeded from the products.json snapshot ----
    const products = await (await fetch(`${BASE}/api/products`)).json();
    check('fresh DB seeds full catalogue', Array.isArray(products) && products.length >= 200, `got ${products.length}`);
    const catsWithProducts = new Set(products.map(p => p.cat));
    check('all storefront categories populated',
        ['clothing', 'shoes', 'feeding', 'gear', 'bathcare', 'bedding'].every(c => catsWithProducts.has(c)),
        `cats: ${[...catsWithProducts].join(',')}`);

    // ---- static frontend ----
    for (const page of ['/', '/admin.html', '/track.html']) {
        const r = await fetch(`${BASE}${page}`);
        check(`serves ${page}`, r.status === 200, `status ${r.status}`);
    }

    // ---- auth: passwordless flow ----
    let r = await fetch(`${BASE}/api/orders`);
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

    // ---- guest checkout: retail, server-side total ----
    // Expected totals derive from the seeded product so the test tracks the
    // catalogue: managed sizes win, otherwise base price (+0 modifier size).
    const p1 = products.find(p => p.id === 1);
    let managed = null;
    try { const arr = JSON.parse(p1.sizes); if (Array.isArray(arr) && arr.length) managed = arr; } catch (e) {}
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

    // ---- customer accounts gated off by default ----
    r = await fetch(`${BASE}/api/customer/register`, json('POST', { name: 'X', email: 'x@x.com', password: 'longenough1' }));
    check('customer register gated off', r.status === 404, `status ${r.status}`);

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
