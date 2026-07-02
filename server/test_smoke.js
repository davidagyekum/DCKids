// Smoke tests: boots the real server on a throwaway port + database and
// exercises the critical paths end-to-end. Run with `npm test` from server/.
// No test framework — plain assertions, exit 1 on any failure — so it runs
// anywhere Node runs, including a fresh clone with only `npm install` done.
const fs = require('fs');
const path = require('path');

const TEST_PORT = 3041;
const TEST_DB = path.join(__dirname, '_smoketest.db');
const BASE = `http://localhost:${TEST_PORT}`;
const ADMIN_PASSWORD = 'SmokeTest-Passw0rd!';

process.env.PORT = String(TEST_PORT);
process.env.DB_PATH = TEST_DB;
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
delete process.env.NODE_ENV; // dev mode: localhost bypasses rate limits

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
    if (cond) { passed++; console.log(`  PASS  ${name}`); }
    else { failed++; console.error(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

function cleanupDb() {
    ['', '-wal', '-shm'].forEach(ext => {
        try { fs.unlinkSync(TEST_DB + ext); } catch (e) { /* not present */ }
    });
}

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

async function run() {
    cleanupDb();
    require('./server'); // boots on TEST_PORT against TEST_DB

    const up = await waitForServer(30);
    if (!up) { console.error('FATAL: server did not start'); process.exit(1); }

    // ---- fresh-database boot ----
    const products = await (await fetch(`${BASE}/api/products`)).json();
    check('fresh DB seeds products', Array.isArray(products) && products.length >= 80, `got ${products.length}`);

    // ---- static frontend ----
    for (const page of ['/', '/admin.html', '/track.html']) {
        const r = await fetch(`${BASE}${page}`);
        check(`serves ${page}`, r.status === 200, `status ${r.status}`);
    }

    // ---- auth gates ----
    let r = await fetch(`${BASE}/api/orders`);
    check('orders list requires auth', r.status === 401, `status ${r.status}`);

    r = await fetch(`${BASE}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'wrong-password' })
    });
    check('login rejects bad password', r.status === 401, `status ${r.status}`);

    r = await fetch(`${BASE}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD })
    });
    const login = await r.json();
    check('login issues token', r.status === 200 && !!login.accessToken, `status ${r.status}`);
    const auth = { 'Authorization': `Bearer ${login.accessToken}`, 'Content-Type': 'application/json' };

    r = await fetch(`${BASE}/api/orders`, { headers: auth });
    check('orders list works with token', r.status === 200, `status ${r.status}`);

    // ---- guest checkout: valid order, server-side total ----
    r = await fetch(`${BASE}/api/orders`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            customer_name: 'Smoke Test', customer_phone: '0241234567',
            order_type: 'retail', items: [{ id: 1, quantity: 2, size: '6M' }]
        })
    });
    const order = await r.json();
    check('guest checkout creates order', r.status === 200 && order.success === true);
    check('order number assigned', /^ORD-\d+$/.test(order.order_number || ''), order.order_number);
    check('total computed server-side (85 x 2 = 170)', order.total_amount === 170, `got ${order.total_amount}`);

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
        r = await fetch(`${BASE}/api/orders`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ customer_name: 'X', customer_phone: '024', order_type: 'retail', ...body })
        });
        check(`checkout rejects ${name}`, r.status === 400, `status ${r.status}`);
    }

    // ---- order tracking ----
    r = await fetch(`${BASE}/api/orders/track`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_number: order.order_number, phone: '0241234567' })
    });
    check('tracking works with matching phone', r.status === 200, `status ${r.status}`);

    r = await fetch(`${BASE}/api/orders/track`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_number: order.order_number, phone: '0209999999' })
    });
    check('tracking rejects wrong phone', r.status === 403, `status ${r.status}`);

    // ---- order status whitelist + paid stock deduction ----
    const orders = await (await fetch(`${BASE}/api/orders`, { headers: auth })).json();
    const dbId = orders[0].id;
    r = await fetch(`${BASE}/api/orders/${dbId}`, { method: 'PUT', headers: auth, body: JSON.stringify({ status: 'not-a-status' }) });
    check('status update rejects unknown status', r.status === 400, `status ${r.status}`);
    r = await fetch(`${BASE}/api/orders/${dbId}`, { method: 'PUT', headers: auth, body: JSON.stringify({ status: 'paid' }) });
    check('status update accepts paid', r.status === 200, `status ${r.status}`);

    // ---- reviews validation ----
    r = await fetch(`${BASE}/api/products/1/reviews`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: 5, body: 'Great quality, my son loves it!', author_name: 'Smoke Test' })
    });
    check('review submits', r.status === 200, `status ${r.status}`);
    r = await fetch(`${BASE}/api/products/1/reviews`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: 9, body: 'rating out of range' })
    });
    check('review rejects rating > 5', r.status === 400, `status ${r.status}`);
    r = await fetch(`${BASE}/api/products/1/reviews`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: 5, body: 'x'.repeat(2001) })
    });
    check('review rejects oversized body', r.status === 400, `status ${r.status}`);

    // ---- customer accounts gated off by default ----
    r = await fetch(`${BASE}/api/customer/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'X', email: 'x@x.com', password: 'longenough1' })
    });
    check('customer register gated off', r.status === 404, `status ${r.status}`);

    // ---- staff access requests ----
    r = await fetch(`${BASE}/api/admin/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name: 'New Staff', email: 'staff@test.com', password: 'short' })
    });
    check('staff register rejects short password', r.status === 400, `status ${r.status}`);
    r = await fetch(`${BASE}/api/admin/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name: 'New Staff', email: 'staff@test.com', password: 'GoodPass123' })
    });
    check('staff register accepts valid request', r.status === 201, `status ${r.status}`);
    r = await fetch(`${BASE}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'staff@test.com', password: 'GoodPass123' })
    });
    check('pending staff cannot log in yet', r.status === 403, `status ${r.status}`);

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
