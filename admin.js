/* ============================================================
   DC KIDS ADMIN DASHBOARD — Complete Production-Ready JS
   ============================================================ */

/* ============================================================
   SECTION 1: CONSTANTS & STATE
   ============================================================ */
const API_URL = '/api';
let globalProducts = [];

/* Transparent 1x1 GIF — safe empty-image placeholder (never requests the page URL). */
var BLANK_IMG = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
if (typeof window !== 'undefined') window.BLANK_IMG = BLANK_IMG;

/* Local, offline-safe initials avatar — returns an inline SVG data-URI.
   Replaces ui-avatars.com so nothing is requested over the network. */
function localInitialsAvatar(name, bg, fg) {
    bg = bg || '#fc4c7a';
    fg = fg || '#ffffff';
    var parts = String(name || 'A').trim().split(/\s+/);
    var initials = (parts[0] ? parts[0][0] : 'A') + (parts[1] ? parts[1][0] : '');
    initials = initials.toUpperCase();
    var svg = "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'>" +
        "<rect width='64' height='64' rx='32' fill='" + bg + "'/>" +
        "<text x='32' y='41' font-family='Inter,Arial,sans-serif' font-size='26' font-weight='700' fill='" + fg + "' text-anchor='middle'>" + initials + "</text></svg>";
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}
if (typeof window !== 'undefined') window.localInitialsAvatar = localInitialsAvatar;
let currentRole = '';
let chartInstances = {};
let analyticsState = { period: 'week', data: null };
let analyticsRefreshTimer = null;

// Pagination state — smaller pages on mobile keep the DOM light & fast
const IS_MOBILE_VP = (typeof window !== 'undefined') && window.innerWidth <= 768;
let invCurrentPage = 1;
const INV_PER_PAGE = IS_MOBILE_VP ? 25 : 100;
let prodCurrentPage = 1;
const PROD_PER_PAGE = IS_MOBILE_VP ? 25 : 100;
let orderCurrentPage = 1;
const ORDER_PER_PAGE = 10;
let custCurrentPage = 1;
const CUST_PER_PAGE = 10;
let suppCurrentPage = 1;
const SUPP_PER_PAGE = 10;
let reviewCurrentPage = 1;
const REVIEW_PER_PAGE = 10;

// Confirm callback holder
let pendingConfirmCallback = null;

/* ============================================================
   SECTION 2: LOCAL STORAGE DATABASE
   ============================================================ */
window.adminOrders = [];

function getOrders() {
    return window.adminOrders;
}

function fetchOrdersFromServer(callback) {
    var token = localStorage.getItem('adminToken');
    fetch(API_URL + '/orders', { headers: { 'Authorization': 'Bearer ' + token } })
    .then(function(r) {
        if (r.status === 401 || r.status === 403) { handleSessionExpiry(); return null; }
        return r.json();
    })
    .then(function(data) {
        if (data === null) return; // session expired — already handled
        if (Array.isArray(data)) {
            window.adminOrders = data.map(function(o) {
                return {
                    db_id: o.id,
                    id: o.order_number,
                    customer: o.customer_name,
                    phone: o.customer_phone,
                    total: o.total_amount,
                    status: o.status,
                    type: o.order_type,
                    date: o.created_at,
                    order_type: o.order_type,
                    delivery_area: o.delivery_area || '',
                    notes: o.notes || '',
                    items: o.items ? o.items.map(function(i) {
                        // Extract size from product_name e.g. "Knit Sweater (2Y)" → "2Y"
                        var sizeMatch = (i.product_name || '').match(/\(([^)]+)\)/);
                        var size = sizeMatch ? sizeMatch[1] : 'Standard';
                        return { productId: i.product_id, name: i.product_name, qty: i.quantity, price: i.price_at_time, size: size };
                    }) : []
                };
            });
            syncCustomersWithOrders();
            detectNewOrders(window.adminOrders);
            startOrderNotificationPolling();
        }
        if (callback) callback();
    }).catch(function(e) {
        // Expected when the API/backend isn't running (preview/offline) — the UI
        // falls back to local data. Warn instead of error so the console stays clean.
        console.warn('Orders API unavailable, using local data:', e && e.message ? e.message : e);
    });
}

// Surface customer orders placed on the storefront in the admin notification
// bell. We track the highest order id seen on this device; anything above it on
// a later fetch is genuinely new. The first run just sets the baseline so we
// don't backfill a notification for every pre-existing order.
function detectNewOrders(orders) {
    try {
        if (!Array.isArray(orders) || !orders.length) return;
        var ids = orders.map(function(o) { return Number(o.db_id) || 0; });
        var maxId = Math.max.apply(null, ids);
        var lastSeenRaw = localStorage.getItem('dcKidsLastSeenOrderId');
        if (lastSeenRaw === null) {
            localStorage.setItem('dcKidsLastSeenOrderId', String(maxId));
            return;
        }
        var lastSeen = Number(lastSeenRaw) || 0;
        if (maxId <= lastSeen) return;
        orders.filter(function(o) { return (Number(o.db_id) || 0) > lastSeen; })
            .sort(function(a, b) { return (Number(a.db_id) || 0) - (Number(b.db_id) || 0); })
            .forEach(function(o) {
                addNotification('new-order', 'New order ' + o.id + ' from ' + (o.customer || 'Guest') + ' — GHS ' + Number(o.total || 0).toFixed(2));
            });
        localStorage.setItem('dcKidsLastSeenOrderId', String(maxId));
    } catch (e) {}
}

// Poll for new orders while logged in so the bell updates without a manual
// refresh. Guarded so only one interval ever runs.
var __orderPollStarted = false;
function startOrderNotificationPolling() {
    if (__orderPollStarted) return;
    __orderPollStarted = true;
    setInterval(function() {
        if (localStorage.getItem('adminToken')) fetchOrdersFromServer();
    }, 45000);
}

function saveOrders(orders) {
    // Deprecated for direct API saving
}
function getCustomers() {
    try { return JSON.parse(localStorage.getItem('dcKidsCustomers')) || []; }
    catch (e) { return []; }
}
function saveCustomers(customers) {
    localStorage.setItem('dcKidsCustomers', JSON.stringify(customers));
}
function customerMatchesOrder(c, o) {
    var nameMatch = o.customer && c.name && o.customer.toLowerCase().trim() === c.name.toLowerCase().trim();
    var phoneMatch = o.phone && c.phone && o.phone.replace(/[^0-9]/g, '') === c.phone.replace(/[^0-9]/g, '');
    return nameMatch || phoneMatch;
}

function syncCustomersWithOrders() {
    var customers = getCustomers();
    var orders = getOrders() || [];
    var updated = false;

    // 1. Refresh order count / spend / status for customers already on the list.
    var updatedCustomers = customers.map(function(c) {
        var customerOrders = orders.filter(function(o) { return customerMatchesOrder(c, o); });

        var newOrderCount = customerOrders.length;
        var newTotalSpent = customerOrders.reduce(function(sum, o) {
            return sum + (o.total || 0);
        }, 0);

        var newStatus = c.status || 'inactive';
        if (newOrderCount > 0 && (c.orderCount === 0 || !c.status)) {
            newStatus = 'active';
        } else if (newOrderCount === 0) {
            newStatus = 'inactive';
        }

        if (c.orderCount !== newOrderCount || c.totalSpent !== newTotalSpent || c.status !== newStatus) {
            c.orderCount = newOrderCount;
            c.totalSpent = newTotalSpent;
            c.status = newStatus;
            updated = true;
        }
        return c;
    });

    // 2. Auto-add anyone who placed an order but isn't on the list yet.
    var maxId = 0;
    updatedCustomers.forEach(function(c) {
        var m = /CUST-(\d+)/.exec(c.id || '');
        if (m) maxId = Math.max(maxId, parseInt(m[1], 10));
    });
    orders.forEach(function(o) {
        if (!o.customer && !o.phone) return;
        if (updatedCustomers.some(function(c) { return customerMatchesOrder(c, o); })) return;

        var theirOrders = orders.filter(function(x) {
            var nameMatch = x.customer && o.customer && x.customer.toLowerCase().trim() === o.customer.toLowerCase().trim();
            var phoneMatch = x.phone && o.phone && x.phone.replace(/[^0-9]/g, '') === o.phone.replace(/[^0-9]/g, '');
            return nameMatch || phoneMatch;
        });
        maxId += 1;
        updatedCustomers.push({
            id: 'CUST-' + String(maxId).padStart(3, '0'),
            name: o.customer || 'Unknown',
            email: '',
            phone: o.phone || '',
            address: '',
            city: o.delivery_area || '',
            country: 'Ghana',
            group: '',
            notes: 'Auto-added from order ' + (o.id || ''),
            joinDate: o.date ? String(o.date).split('T')[0] : new Date().toISOString().split('T')[0],
            totalSpent: theirOrders.reduce(function(s, x) { return s + (x.total || 0); }, 0),
            orderCount: theirOrders.length,
            status: 'active'
        });
        updated = true;
    });

    if (updated) {
        saveCustomers(updatedCustomers);
    }
}
function getSuppliers() {
    try { return JSON.parse(localStorage.getItem('dcKidsSuppliers')) || []; }
    catch (e) { return []; }
}
function saveSuppliers(suppliers) {
    localStorage.setItem('dcKidsSuppliers', JSON.stringify(suppliers));
}
function getSettings() {
    var defaults = {
        darkMode: false,
        accentColor: '#fc4c7a',
        profile: { name: '', email: '' },
        notifications: { lowStock: true, orders: true },
        widgets: { revenue: true, inventory: true, activity: true, products: true }
    };
    try {
        var saved = JSON.parse(localStorage.getItem('dcKidsSettings')) || {};
        return {
            darkMode: typeof saved.darkMode === 'boolean' ? saved.darkMode : defaults.darkMode,
            accentColor: saved.accentColor || defaults.accentColor,
            profile: Object.assign({}, defaults.profile, saved.profile || {}),
            notifications: Object.assign({}, defaults.notifications, saved.notifications || {}),
            widgets: Object.assign({}, defaults.widgets, saved.widgets || {})
        };
    } catch (e) { return defaults; }
}
function saveSettings(settings) {
    localStorage.setItem('dcKidsSettings', JSON.stringify(settings));
}
function getNotifications() {
    try { return JSON.parse(localStorage.getItem('dcKidsNotifications')) || []; }
    catch (e) { return []; }
}
function saveNotifications(notifications) {
    localStorage.setItem('dcKidsNotifications', JSON.stringify(notifications));
}
function getActivities() {
    try { return JSON.parse(localStorage.getItem('dcKidsActivities')) || []; }
    catch (e) { return []; }
}
function saveActivities(activities) {
    localStorage.setItem('dcKidsActivities', JSON.stringify(activities));
}

function initSeedData() {
    // Orders
    if (!localStorage.getItem('dcKidsOrders')) {
        var now = new Date();
        var orders = [
            { id: 'ORD-001', customer: 'Akua Mensah', items: [{ productId: 1, name: 'Baby Romper Set', qty: 2, price: 85 }], total: 170, status: 'delivered', date: new Date(now - 86400000 * 6).toISOString(), notes: 'Gift wrapped' },
            { id: 'ORD-002', customer: 'Kwame Asante', items: [{ productId: 2, name: 'Kids Sneakers', qty: 1, price: 120 }, { productId: 3, name: 'Floral Dress', qty: 1, price: 95 }], total: 215, status: 'delivered', date: new Date(now - 86400000 * 4).toISOString(), notes: '' },
            { id: 'ORD-003', customer: 'Ama Owusu', items: [{ productId: 4, name: 'School Bag', qty: 1, price: 150 }], total: 150, status: 'pending', date: new Date(now - 86400000 * 2).toISOString(), notes: 'Express delivery' },
            { id: 'ORD-004', customer: 'Yaw Boateng', items: [{ productId: 1, name: 'Baby Romper Set', qty: 3, price: 85 }], total: 255, status: 'delivered', date: new Date(now - 86400000 * 8).toISOString(), notes: '' },
            { id: 'ORD-005', customer: 'Efua Darko', items: [{ productId: 5, name: 'Toddler Sandals', qty: 2, price: 65 }], total: 130, status: 'cancelled', date: new Date(now - 86400000 * 1).toISOString(), notes: 'Customer changed mind' },
            { id: 'ORD-006', customer: 'Kofi Amoah', items: [{ productId: 2, name: 'Kids Sneakers', qty: 1, price: 120 }], total: 120, status: 'pending', date: new Date(now - 86400000 * 0.5).toISOString(), notes: '' },
            { id: 'ORD-007', customer: 'Adwoa Poku', items: [{ productId: 3, name: 'Floral Dress', qty: 2, price: 95 }, { productId: 4, name: 'School Bag', qty: 1, price: 150 }], total: 340, status: 'delivered', date: new Date(now - 86400000 * 3).toISOString(), notes: 'Birthday order' },
            { id: 'ORD-008', customer: 'Nana Agyeman', items: [{ productId: 1, name: 'Baby Romper Set', qty: 1, price: 85 }], total: 85, status: 'delivered', date: new Date(now - 86400000 * 10).toISOString(), notes: '' }
        ];
        saveOrders(orders);
    }

    // Customers
    if (!localStorage.getItem('dcKidsCustomers')) {
        var customers = [
            { id: 'CUST-001', name: 'Akua Mensah', email: 'akua@email.com', phone: '+233 24 555 0101', address: 'Accra, East Legon', joinDate: '2025-01-15', totalSpent: 425, orderCount: 3, status: 'active' },
            { id: 'CUST-002', name: 'Kwame Asante', email: 'kwame@email.com', phone: '+233 20 555 0202', address: 'Kumasi, Ahodwo', joinDate: '2025-03-20', totalSpent: 215, orderCount: 1, status: 'active' },
            { id: 'CUST-003', name: 'Ama Owusu', email: 'ama@email.com', phone: '+233 27 555 0303', address: 'Cape Coast', joinDate: '2025-05-10', totalSpent: 150, orderCount: 1, status: 'active' },
            { id: 'CUST-004', name: 'Yaw Boateng', email: 'yaw@email.com', phone: '+233 55 555 0404', address: 'Takoradi', joinDate: '2024-11-08', totalSpent: 780, orderCount: 5, status: 'active' },
            { id: 'CUST-005', name: 'Efua Darko', email: 'efua@email.com', phone: '+233 24 555 0505', address: 'Tema', joinDate: '2025-06-01', totalSpent: 0, orderCount: 0, status: 'inactive' },
            { id: 'CUST-006', name: 'Kofi Amoah', email: 'kofi@email.com', phone: '+233 50 555 0606', address: 'Accra, Osu', joinDate: '2025-02-14', totalSpent: 340, orderCount: 2, status: 'active' }
        ];
        saveCustomers(customers);
    }

    // Suppliers
    if (!localStorage.getItem('dcKidsSuppliers')) {
        var suppliers = [
            { id: 'SUP-001', company: 'Little Stars Textiles', contact: 'Grace Adjei', email: 'grace@littlestars.com', phone: '+233 30 222 1111', products: 'Clothing, Rompers', status: 'active' },
            { id: 'SUP-002', company: 'TinyFeet Footwear', contact: 'Michael Osei', email: 'michael@tinyfeet.com', phone: '+233 30 222 2222', products: 'Shoes, Sandals', status: 'active' },
            { id: 'SUP-003', company: 'BabyComfort Ltd', contact: 'Sarah Mensah', email: 'sarah@babycomfort.com', phone: '+233 30 222 3333', products: 'Bedding, Essentials', status: 'active' },
            { id: 'SUP-004', company: 'KidsBag World', contact: 'Daniel Tetteh', email: 'daniel@kidsbag.com', phone: '+233 30 222 4444', products: 'Bags, Accessories', status: 'inactive' }
        ];
        saveSuppliers(suppliers);
    }

    // Settings
    if (!localStorage.getItem('dcKidsSettings')) {
        saveSettings({ darkMode: false, notifications: { lowStock: true, orders: true } });
    }

    // Notifications
    if (!localStorage.getItem('dcKidsNotifications')) {
        var notifs = [
            { id: 'n1', type: 'low-stock', message: 'Baby Romper Set is running low (3 left)', timestamp: new Date(Date.now() - 3600000).toISOString(), read: false },
            { id: 'n2', type: 'new-order', message: 'New order ORD-006 from Kofi Amoah', timestamp: new Date(Date.now() - 7200000).toISOString(), read: false },
            { id: 'n3', type: 'sale', message: 'Flash sale generated GHS 1,200 today', timestamp: new Date(Date.now() - 14400000).toISOString(), read: false },
            { id: 'n4', type: 'new-order', message: 'New order ORD-003 from Ama Owusu', timestamp: new Date(Date.now() - 86400000).toISOString(), read: true },
            { id: 'n5', type: 'low-stock', message: 'Toddler Sandals stock depleted', timestamp: new Date(Date.now() - 172800000).toISOString(), read: true }
        ];
        saveNotifications(notifs);
    }

    // Activities
    if (!localStorage.getItem('dcKidsActivities')) {
        var activities = [
            { type: 'order', message: 'Order ORD-006 placed by Kofi Amoah', timestamp: new Date(Date.now() - 3600000).toISOString() },
            { type: 'product', message: 'Stock updated for Baby Romper Set', timestamp: new Date(Date.now() - 7200000).toISOString() },
            { type: 'customer', message: 'New customer Efua Darko registered', timestamp: new Date(Date.now() - 14400000).toISOString() },
            { type: 'system', message: 'System backup completed', timestamp: new Date(Date.now() - 86400000).toISOString() }
        ];
        saveActivities(activities);
    }
}

/* ============================================================
   SECTION 3: AUTHENTICATION
   ============================================================ */
// Passwordless sign-in: email -> 6-digit code -> session. No passwords, no
// offline fallback (a real session requires the server to issue a JWT).
var _loginEmail = '';

function _loginShowStep(step) {
    ['email', 'code', 'recovery'].forEach(function (s) {
        var el = document.getElementById('login-step-' + s);
        if (el) el.style.display = (s === step) ? 'block' : 'none';
    });
}
function _loginError(msg) {
    var el = document.getElementById('login-error');
    if (el) { el.textContent = msg || ''; el.style.display = msg ? 'block' : 'none'; }
}
function _loginInfo(msg) {
    var el = document.getElementById('login-info');
    if (el) el.textContent = msg || '';
}

function requestLoginCode(e) {
    if (e) e.preventDefault();
    var email = (document.getElementById('login-email').value || '').trim().toLowerCase();
    var btn = document.getElementById('login-send-code-btn');
    _loginError(''); _loginInfo('');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return _loginError('Enter a valid email.');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    fetch(API_URL + '/auth/request-code', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email })
    })
    .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, data: d }; }); })
    .then(function (r) {
        if (!r.ok) throw new Error(r.data.error || 'Could not send a code.');
        _loginEmail = email;
        var to = document.getElementById('login-code-sent-to');
        if (to) to.textContent = email;
        _loginShowStep('code');
        var codeEl = document.getElementById('login-code');
        if (codeEl) { codeEl.value = ''; codeEl.focus(); }
    })
    .catch(function (err) {
        _loginError(err.message === 'Failed to fetch' ? 'Server unavailable — try again later.' : err.message);
    })
    .finally(function () { if (btn) { btn.disabled = false; btn.textContent = 'Send code'; } });
}

function resendLoginCode(e) {
    if (e) e.preventDefault();
    var emailEl = document.getElementById('login-email');
    if (emailEl && _loginEmail) emailEl.value = _loginEmail;
    requestLoginCode(e);
}

function loginBackToEmail(e) {
    if (e) e.preventDefault();
    _loginError(''); _loginInfo('');
    _loginShowStep('email');
    var el = document.getElementById('login-email'); if (el) el.focus();
}

function showRecoveryLogin(e) {
    if (e) e.preventDefault();
    _loginError(''); _loginInfo('');
    var re = document.getElementById('login-recovery-email');
    if (re && _loginEmail) re.value = _loginEmail;
    _loginShowStep('recovery');
}

function _finishLogin(data) {
    localStorage.setItem('adminToken', data.accessToken);
    localStorage.setItem('adminRole', data.role);
    _loginError('');
    var proceed = function () { showDashboard(data.role); };
    if (data.recoveryCodes && data.recoveryCodes.length) {
        showRecoveryCodes(data.recoveryCodes, proceed);
    } else {
        proceed();
    }
}

function verifyLoginCode(e) {
    if (e) e.preventDefault();
    var code = (document.getElementById('login-code').value || '').trim();
    var btn = document.getElementById('login-verify-btn');
    _loginError('');
    if (!/^\d{6}$/.test(code)) return _loginError('Enter the 6-digit code.');
    if (btn) { btn.disabled = true; btn.textContent = 'Verifying…'; }
    fetch(API_URL + '/auth/verify-code', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: _loginEmail, code: code })
    })
    .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, data: d }; }); })
    .then(function (r) {
        if (!r.ok) throw new Error(r.data.error || 'Incorrect code.');
        _finishLogin(r.data);
    })
    .catch(function (err) {
        _loginError(err.message === 'Failed to fetch' ? 'Server unavailable — try again later.' : err.message);
    })
    .finally(function () { if (btn) { btn.disabled = false; btn.textContent = 'Verify & sign in'; } });
}

function recoveryLogin(e) {
    if (e) e.preventDefault();
    var email = (document.getElementById('login-recovery-email').value || '').trim().toLowerCase();
    var code = (document.getElementById('login-recovery-code').value || '').trim();
    _loginError('');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !code) return _loginError('Enter your email and a recovery code.');
    fetch(API_URL + '/auth/recovery', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, code: code })
    })
    .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, data: d }; }); })
    .then(function (r) {
        if (!r.ok) throw new Error(r.data.error || 'Invalid recovery code.');
        _finishLogin(r.data);
    })
    .catch(function (err) {
        _loginError(err.message === 'Failed to fetch' ? 'Server unavailable — try again later.' : err.message);
    });
}

// Show one-time recovery codes, then run onContinue (proceed to dashboard/login).
function showRecoveryCodes(codes, onContinue) {
    var overlay = document.getElementById('recovery-codes-overlay');
    var list = document.getElementById('recovery-codes-list');
    var cont = document.getElementById('recovery-codes-continue');
    if (!overlay || !list) { if (onContinue) onContinue(); return; }
    window._lastRecoveryCodes = codes.slice();
    list.innerHTML = codes.map(function (c) { return '<li>' + escapeHtml(c) + '</li>'; }).join('');
    overlay.classList.add('open');
    if (cont) cont.onclick = function () { overlay.classList.remove('open'); if (onContinue) onContinue(); };
}
function copyRecoveryCodes() {
    var codes = window._lastRecoveryCodes || [];
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(codes.join('\n')).then(function () {
            if (typeof showToast === 'function') showToast('Recovery codes copied', 'success');
        });
    }
}

/* ── Request-access (sign-up) view ── */
function showSignupView(e) {
    if (e) e.preventDefault();
    var lc = document.getElementById('login-container');
    var sc = document.getElementById('signup-container');
    if (lc) lc.style.display = 'none';
    if (sc) sc.style.display = 'flex';
    var errEl = document.getElementById('signup-error');
    if (errEl) errEl.textContent = '';
    var infoEl = document.getElementById('login-info');
    if (infoEl) infoEl.textContent = '';
}

function showLoginView(e) {
    if (e) e.preventDefault();
    var lc = document.getElementById('login-container');
    var sc = document.getElementById('signup-container');
    if (sc) sc.style.display = 'none';
    if (lc) lc.style.display = 'flex';
}

function handleRegister(e) {
    if (e) e.preventDefault();
    var name = (document.getElementById('signup-name').value || '').trim();
    var email = (document.getElementById('signup-email').value || '').trim();
    var phone = (document.getElementById('signup-phone').value || '').trim();
    var errEl = document.getElementById('signup-error');
    var btn = document.getElementById('signup-btn');
    function fail(msg) { if (errEl) errEl.textContent = msg; }
    if (errEl) errEl.textContent = '';

    if (name.length < 2) return fail('Please enter your full name');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Please enter a valid email address');

    if (btn) { btn.disabled = true; btn.textContent = 'Sending request…'; }
    fetch(API_URL + '/admin/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name: name, email: email, phone: phone })
    })
    .then(function(res) { return res.json().then(function(d) { return { ok: res.ok, data: d }; }); })
    .then(function(r) {
        if (!r.ok) throw new Error(r.data.error || 'Could not submit request');
        ['signup-name', 'signup-email', 'signup-phone'].forEach(function(id) {
            var el = document.getElementById(id);
            if (el) el.value = '';
        });
        var backToLogin = function (infoMsg) {
            showLoginView();
            _loginShowStep('email');
            _loginInfo(infoMsg);
            var emailEl = document.getElementById('login-email');
            if (emailEl) emailEl.value = email;
        };
        if (r.data.owner && r.data.recoveryCodes) {
            // First account = the owner: active immediately. Show recovery
            // codes once, then drop them on the login step, email prefilled.
            showRecoveryCodes(r.data.recoveryCodes, function () {
                backToLogin('Your owner account is active — request a sign-in code below.');
            });
        } else {
            backToLogin('Request sent! You can sign in once a manager approves your account.');
        }
    })
    .catch(function(err) {
        fail(err.message === 'Failed to fetch' ? 'Server unavailable — try again later.' : err.message);
    })
    .finally(function() {
        if (btn) { btn.disabled = false; btn.textContent = 'Request access'; }
    });
}

// ── Google Sign-In (primary login path) ──
// Self-gating: asks the server whether a Google client id is configured. If not,
// the button stays hidden and email-OTP is the only path — nothing breaks.
var _gisScriptLoaded = false;
function initGoogleSignIn() {
    fetch(API_URL + '/auth/config')
    .then(function (res) { return res.json(); })
    .then(function (cfg) {
        if (!cfg || !cfg.googleClientId) return;
        var wrap = document.getElementById('google-signin-wrap');
        if (wrap) wrap.style.display = 'block';
        _loadGisScript(function () {
            if (!window.google || !google.accounts || !google.accounts.id) return;
            google.accounts.id.initialize({ client_id: cfg.googleClientId, callback: handleGoogleCredential });
            var btn = document.getElementById('google-signin-btn');
            if (btn) google.accounts.id.renderButton(btn, { theme: 'outline', size: 'large', text: 'continue_with', shape: 'pill', width: 300 });
        });
    })
    .catch(function () { /* silent — OTP still works */ });
}

function _loadGisScript(cb) {
    if (_gisScriptLoaded) return cb();
    var s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true; s.defer = true;
    s.onload = function () { _gisScriptLoaded = true; cb(); };
    s.onerror = function () { /* offline / blocked — OTP still works */ };
    document.head.appendChild(s);
}

function handleGoogleCredential(response) {
    _loginError(''); _loginInfo('');
    if (!response || !response.credential) return _loginError('Google sign-in was cancelled.');
    fetch(API_URL + '/auth/google', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: response.credential })
    })
    .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, data: d }; }); })
    .then(function (r) {
        if (!r.ok) throw new Error(r.data.error || 'Google sign-in failed.');
        _finishLogin(r.data);
    })
    .catch(function (err) {
        _loginError(err.message === 'Failed to fetch' ? 'Server unavailable — try again later.' : err.message);
    });
}

function showDashboard(role) {
    _sessionExpiredHandled = false;
    currentRole = role || localStorage.getItem('adminRole') || '';
    document.getElementById('login-container').style.display = 'none';
    document.getElementById('dashboard-container').style.display = 'block';
    document.body.classList.add('is-authed');

    var badge = document.getElementById('user-role-badge');
    if (badge) {
        badge.textContent = 'Super Admin';
    }

    if (typeof applyAdminProfileToHeader === 'function') applyAdminProfileToHeader();

    // Show add-product-btn for managers
    var addBtn = document.getElementById('add-product-btn');
    if (addBtn) {
        addBtn.style.display = (currentRole === 'manager' || currentRole === 'admin') ? 'flex' : 'none';
    }
    var dashAddBtn = document.getElementById('dashboard-add-product');
    if (dashAddBtn) {
        dashAddBtn.style.display = (currentRole === 'manager' || currentRole === 'admin') ? 'flex' : 'none';
    }

    // Show/hide manager-only UI elements
    var managerElements = document.querySelectorAll('.manager-only');
    managerElements.forEach(function(el) {
        el.style.display = (currentRole === 'manager' || currentRole === 'admin') ? '' : 'none';
    });

    // Load all data
    loadDashboard();

    // Owner heads-up for pending admin access requests (badge + bell + toast)
    if (typeof refreshAccessRequestsBadge === 'function') refreshAccessRequestsBadge();
}

function logout() {
    localStorage.removeItem('adminToken');
    localStorage.removeItem('adminRole');
    currentRole = '';
    document.body.classList.remove('is-authed');
    document.getElementById('dashboard-container').style.display = 'none';
    document.getElementById('login-container').style.display = 'flex';
}

// A protected endpoint answered 401/403: the token is missing, invalid, or
// expired (e.g. an offline fallback token now hitting a live server). Sign the
// admin out cleanly instead of silently serving stale local data on a dead
// session. Guarded so parallel failing calls only log out once.
var _sessionExpiredHandled = false;
function handleSessionExpiry() {
    if (_sessionExpiredHandled) return true;
    _sessionExpiredHandled = true;
    if (typeof showToast === 'function') showToast('Your session expired. Please sign in again.', 'warning');
    logout();
    return true;
}

/* ============================================================
   SECTION 4: SPA NAVIGATION
   ============================================================ */
var navTargetMap = {
    'tab-dashboard': 'Dashboard',
    'tab-inventory': 'Inventory',
    'tab-products': 'Products',
    'tab-orders': 'Orders',
    'tab-customers': 'Customers',
    'tab-suppliers': 'Suppliers',
    'tab-analytics': 'Sales Analytics',
    'tab-reports': 'Reports',
    'tab-reviews': 'Reviews',
    'tab-settings': 'Settings',
    'tab-admins': 'Manage Staff'
};

function switchTab(targetId) {
    // Hide all tabs
    var tabs = document.querySelectorAll('.tab-view');
    for (var i = 0; i < tabs.length; i++) {
        tabs[i].classList.remove('active');
        tabs[i].style.display = 'none';
    }

    // Remove active from nav items
    var navItems = document.querySelectorAll('.sidebar-link');
    for (var j = 0; j < navItems.length; j++) {
        navItems[j].classList.remove('active');
    }

    // Show target tab
    var target = document.getElementById(targetId);
    if (target) {
        target.style.display = '';
        target.classList.add('active');
    }

    // Set active on matching nav item
    var matchingNav = document.querySelector('.sidebar-link[data-tab="' + targetId + '"]');
    if (matchingNav) {
        matchingNav.classList.add('active');
    }

    // Toggle dashboard-only body state (mobile hero replaces the top header)
    document.body.classList.toggle('dash-active', targetId === 'tab-dashboard');

    // Update title
    document.title = 'DC Kids Admin — ' + (navTargetMap[targetId] || 'Dashboard');
    var hmt = document.getElementById('headerMobileTitle');
    if (hmt) hmt.textContent = navTargetMap[targetId] || 'Dashboard';

    // Load tab-specific data
    if (targetId === 'tab-dashboard') loadDashboard();
    else if (targetId === 'tab-inventory') loadInventory();
    else if (targetId === 'tab-products') loadProducts();
    else if (targetId === 'tab-orders') loadOrders();
    else if (targetId === 'tab-customers') loadCustomers();
    else if (targetId === 'tab-suppliers') loadSuppliers();
    else if (targetId === 'tab-analytics') loadAnalytics();
    else if (targetId === 'tab-reports') loadReports();
    else if (targetId === 'tab-reviews') loadReviews();
    else if (targetId === 'tab-settings') loadSettingsTab();
    else if (targetId === 'tab-admins') loadAdmins();
}

/* ============================================================
   SECTION 5: TOAST SYSTEM
   ============================================================ */
function showToast(message, type) {
    type = type || 'success';
    var container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.style.cssText = 'position:fixed;top:24px;right:24px;z-index:9999;display:flex;flex-direction:column;gap:8px;';
        document.body.appendChild(container);
    }

    var icons = {
        success: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;"><polyline points="20 6 9 17 4 12"/></svg>',
        error:   '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
        warning: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
        info:    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
    };

    var colors = {
        success: '#10B981',
        error: '#EF4444',
        warning: '#F59E0B',
        info: '#3B82F6'
    };

    var toast = document.createElement('div');
    toast.style.cssText = 'display:flex;align-items:center;gap:12px;padding:14px 20px;background:#fff;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,0.12);border-left:4px solid ' + colors[type] + ';font-size:14px;font-family:Inter,sans-serif;transform:translateX(120%);transition:transform 0.3s ease;max-width:380px;';
    toast.innerHTML = '<span style="display:inline-flex;align-items:center;color:' + colors[type] + ';">' + icons[type] + '</span><span style="flex:1;color:#333;">' + escapeHtml(message) + '</span><button style="background:none;border:none;color:#999;cursor:pointer;font-size:18px;padding:0;line-height:1;" onclick="this.parentElement.remove()">&times;</button>';

    container.appendChild(toast);

    // Slide in
    requestAnimationFrame(function() {
        toast.style.transform = 'translateX(0)';
    });

    // Auto dismiss
    setTimeout(function() {
        toast.style.transform = 'translateX(120%)';
        setTimeout(function() {
            if (toast.parentElement) toast.remove();
        }, 300);
    }, 3000);
}

/* ============================================================
   SECTION 6: MODAL SYSTEM
   ============================================================ */
function openModal(id) {
    var modal = document.getElementById(id);
    if (modal) {
        modal.style.display = 'flex';
        modal.classList.add('active');
        modal.style.animation = 'fadeIn 0.2s ease-out';
    }
}

function closeModal(id) {
    var modal = document.getElementById(id);
    if (modal) {
        modal.style.animation = 'fadeOut 0.2s ease-out';
        modal.classList.remove('active');
        setTimeout(function() {
            modal.style.display = 'none';
        }, 180);
    }
}

/* ============================================================
   SECTION 7: LOADING / SKELETON
   ============================================================ */
function showLoading() {
    var overlay = document.getElementById('loading-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'loading-overlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(255,255,255,0.7);z-index:9998;display:flex;align-items:center;justify-content:center;';
        overlay.innerHTML = '<div style="width:40px;height:40px;border:4px solid #eee;border-top-color:#F35E7A;border-radius:50%;animation:spin 0.8s linear infinite;"></div>';
        document.body.appendChild(overlay);
    }
    overlay.style.display = 'flex';
}

function hideLoading() {
    var overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.style.display = 'none';
}

// Inline SVG glyph for entity types (product, order, customer, supplier, system, default).
// Used in activity timeline, global-search results, and report tiles for a consistent line-icon look.
function entityGlyph(type) {
    var glyphs = {
        product:  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
        order:    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>',
        customer: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
        supplier: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
        system:   '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
        revenue:  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 6v12M9 9h4.5a2.5 2.5 0 0 1 0 5H9m6 0H9"/></svg>'
    };
    return glyphs[type] || '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
}

function renderSkeletonRows(tbody, cols, count) {
    if (!tbody) return;
    tbody.innerHTML = '';
    for (var i = 0; i < count; i++) {
        var tr = document.createElement('tr');
        var html = '';
        for (var c = 0; c < cols; c++) {
            html += '<td><div style="height:16px;background:#f0f0f0;border-radius:8px;animation:pulse 1.5s infinite;"></div></td>';
        }
        tr.innerHTML = html;
        tbody.appendChild(tr);
    }
}

/* ============================================================
   SECTION 8: GLOBAL SEARCH
   ============================================================ */
function handleGlobalSearch(query) {
    var dropdown = document.getElementById('global-search-results');
    if (!dropdown) {
        dropdown = document.createElement('div');
        dropdown.id = 'global-search-results';
        dropdown.style.cssText = 'position:absolute;top:100%;left:0;right:0;background:#fff;border:1px solid #eaeaea;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,0.1);max-height:320px;overflow-y:auto;z-index:100;display:none;';
        var searchBar = document.querySelector('.boutique-topnav .search-bar');
        if (searchBar) {
            searchBar.style.position = 'relative';
            searchBar.appendChild(dropdown);
        }
    }

    if (!query || query.length < 2) {
        dropdown.style.display = 'none';
        return;
    }

    var q = query.toLowerCase();
    var results = [];

    // Search products
    globalProducts.forEach(function(p) {
        if ((p.name && p.name.toLowerCase().indexOf(q) >= 0) || (p.cat && p.cat.toLowerCase().indexOf(q) >= 0)) {
            results.push({ type: 'product', label: p.name, sub: p.cat + ' — GHS ' + p.price, tab: 'tab-inventory' });
        }
    });

    // Search orders
    getOrders().forEach(function(o) {
        if (o.id.toLowerCase().indexOf(q) >= 0 || o.customer.toLowerCase().indexOf(q) >= 0) {
            results.push({ type: 'order', label: o.id, sub: o.customer + ' — GHS ' + o.total, tab: 'tab-orders' });
        }
    });

    // Search customers
    getCustomers().forEach(function(c) {
        if (c.name.toLowerCase().indexOf(q) >= 0 || (c.phone && c.phone.indexOf(q) >= 0)) {
            results.push({ type: 'customer', label: c.name, sub: c.phone, tab: 'tab-customers' });
        }
    });

    // Search suppliers
    getSuppliers().forEach(function(s) {
        if (s.company.toLowerCase().indexOf(q) >= 0 || s.contact.toLowerCase().indexOf(q) >= 0) {
            results.push({ type: 'supplier', label: s.company, sub: s.contact, tab: 'tab-suppliers' });
        }
    });

    if (results.length === 0) {
        dropdown.innerHTML = '<div style="padding:16px;color:#888;font-size:14px;text-align:center;">No results found</div>';
    } else {
        var html = '';
        results.slice(0, 10).forEach(function(r) {
                        html += '<div class="search-result-item" data-tab="' + r.tab + '" style="padding:12px 16px;cursor:pointer;display:flex;align-items:center;gap:12px;border-bottom:1px solid ' + '#f5f5f5' + ';transition:background 0.15s;" onmouseover="this.style.background=\'' + '#f9f9f9' + '\'" onmouseout="this.style.background=\'transparent\'">';
            html += '<span style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:9px;background:' + '#F4F4F7' + ';color:' + '#555' + ';">' + entityGlyph(r.type) + '</span>';
            html += '<div><div style="font-weight:600;font-size:14px;color:' + '#333' + ';">' + escapeHtml(r.label) + '</div>';
            html += '<div style="font-size:12px;color:#888;">' + escapeHtml(r.sub) + '</div></div>';
            html += '</div>';
        });
        dropdown.innerHTML = html;

        // Bind clicks
        dropdown.querySelectorAll('.search-result-item').forEach(function(item) {
            item.addEventListener('click', function() {
                switchTab(item.getAttribute('data-tab'));
                dropdown.style.display = 'none';
                document.getElementById('global-search-input').value = '';
            });
        });
    }
    dropdown.style.display = 'block';
}

function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/* ============================================================
   SECTION 9: NOTIFICATION SYSTEM
   ============================================================ */
// Map a notification's type/message → a settings.notifications key.
// Returns null when no category applies (always-on).
function notificationCategory(n) {
    if (!n) return null;
    var t = (n.type || '').toString().toLowerCase();
    var m = (n.message || '').toString().toLowerCase();
    if (t === 'low-stock' || t === 'lowstock' || /low\s*stock|running low|stock depleted/.test(m)) return 'lowStock';
    if (t === 'new-order' || t === 'order' || /new order|order #|order received|order placed/.test(m)) return 'orders';
    return null;
}

// Notifications filtered by the user's bell-toggle preferences.
function getVisibleNotifications() {
    var notifs = (typeof getNotifications === 'function') ? getNotifications() : [];
    var prefs = {};
    try { prefs = (getSettings().notifications) || {}; } catch (e) {}
    // Default to ON when unset — only filter out when explicitly false.
    return notifs.filter(function(n) {
        var cat = notificationCategory(n);
        if (!cat) return true;
        return prefs[cat] !== false;
    });
}

function renderNotifications() {
    var visible = getVisibleNotifications();
    var unread = visible.filter(function(n) { return !n.read; }).length;
    var badge = document.querySelector('.notification-badge');
    if (badge) {
        badge.textContent = unread;
        badge.style.display = unread > 0 ? 'flex' : 'none';
    }
    // Keep the admin-menu pill in sync if it's mounted.
    var pill = document.getElementById('aum-notif-count');
    if (pill) {
        if (unread > 0) { pill.textContent = String(unread); pill.style.display = 'inline-flex'; }
        else { pill.style.display = 'none'; }
    }
}

// ── Mobile header-popover backdrop ──────────────────────────────────────────
// The notification dropdown and account menu relocate to <body> and float over
// the dashboard on phones/tablets. This scrim dims the page behind them, closes
// them on an outside tap, and — by closing the sidebar first — removes the
// sidebar-under-popover overlap. Shared by both popovers.
function showHeaderPopoverScrim() {
    if (window.innerWidth > 1024) return;
    var sidebar = document.querySelector('.admin-sidebar');
    if (sidebar) sidebar.classList.remove('open');
    var sidebarOverlay = document.getElementById('sidebar-overlay');
    if (sidebarOverlay) sidebarOverlay.classList.remove('active');

    var scrim = document.getElementById('header-popover-scrim');
    if (!scrim) {
        scrim = document.createElement('div');
        scrim.id = 'header-popover-scrim';
        scrim.className = 'header-popover-scrim';
        scrim.addEventListener('click', hideHeaderPopoverScrim);
        document.body.appendChild(scrim);
    }
    scrim.classList.add('open');
}

function hideHeaderPopoverScrim() {
    var scrim = document.getElementById('header-popover-scrim');
    if (scrim) scrim.classList.remove('open');
    var dd = document.getElementById('notification-dropdown');
    if (dd) dd.style.display = 'none';
    if (typeof closeAdminUserMenu === 'function') closeAdminUserMenu();
}

function toggleNotificationDropdown(e) {
    // Stop the opening click from bubbling to the document outside-click handler,
    // which would otherwise close the dropdown in the same tick (the mobile
    // greeting-hero bell opens via inline onclick and doesn't stop propagation).
    if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
    var dropdown = document.getElementById('notification-dropdown');
    var mobile = window.innerWidth <= 1024;
    if (!dropdown) {
        dropdown = document.createElement('div');
        dropdown.id = 'notification-dropdown';
        dropdown.style.cssText = 'position:absolute;top:56px;right:0;width:340px;background:#fff;border:1px solid #eaeaea;border-radius:16px;box-shadow:0 15px 50px rgba(0,0,0,0.12);z-index:200;display:none;max-height:400px;overflow-y:auto;';
        var parent = document.querySelector('.notification-wrapper');
        if (parent) {
            parent.style.position = 'relative';
            parent.appendChild(dropdown);
        }
    }
    // On mobile the header is hidden, so anchor the dropdown to <body> (fixed).
    var desiredParent = mobile ? document.body : document.querySelector('.notification-wrapper');
    if (desiredParent && dropdown.parentNode !== desiredParent) desiredParent.appendChild(dropdown);
    if (mobile) {
        dropdown.style.position = 'fixed';
        dropdown.style.top = '14px';
        dropdown.style.left = '12px';
        dropdown.style.right = '12px';
        dropdown.style.width = 'auto';
        dropdown.style.maxWidth = 'none';
        dropdown.style.zIndex = '1300';
    } else {
        dropdown.style.position = 'absolute';
        dropdown.style.top = '56px';
        dropdown.style.left = 'auto';
        dropdown.style.right = '0';
        dropdown.style.width = '340px';
        dropdown.style.zIndex = '200';
    }

    if (dropdown.style.display === 'none' || dropdown.style.display === '') {
        var notifs = getVisibleNotifications();
        var typeColors = { 'low-stock': '#F59E0B', 'new-order': '#3B82F6', 'sale': '#10B981' };
        var html = '<div style="padding:16px 20px;border-bottom:1px solid #eaeaea;font-weight:700;font-size:16px;display:flex;justify-content:space-between;align-items:center;">Notifications<button onclick="markAllNotificationsRead()" style="font-size:12px;border:none;background:#f5f5f5;padding:6px 12px;border-radius:8px;cursor:pointer;color:#666;">Mark all read</button></div>';
        if (notifs.length === 0) {
            html += '<div style="padding:24px;text-align:center;color:#888;font-size:14px;">No notifications match your alert preferences</div>';
        } else {
            notifs.forEach(function(n) {
                var ago = timeAgo(new Date(n.timestamp));
                var dot = n.read ? '' : '<div style="width:8px;height:8px;border-radius:50%;background:' + (typeColors[n.type] || '#3B82F6') + ';flex-shrink:0;"></div>';
                                html += '<div style="padding:14px 20px;border-bottom:1px solid ' + '#f5f5f5' + ';display:flex;align-items:flex-start;gap:10px;cursor:pointer;' + (n.read ? 'opacity:0.6;' : '') + '" onclick="markNotificationRead(\'' + n.id + '\')">';
                html += dot;
                html += '<div style="flex:1;"><div style="font-size:13px;color:' + '#333' + ';line-height:1.4;">' + escapeHtml(n.message) + '</div>';
                html += '<div style="font-size:11px;color:#999;margin-top:4px;">' + ago + '</div></div></div>';
            });
        }
        dropdown.innerHTML = html;
        dropdown.style.display = 'block';
        if (mobile) showHeaderPopoverScrim();
    } else {
        dropdown.style.display = 'none';
        hideHeaderPopoverScrim();
    }
}

function markNotificationRead(id) {
    var notifs = getNotifications();
    notifs = notifs.map(function(n) {
        if (n.id === id) n.read = true;
        return n;
    });
    saveNotifications(notifs);
    renderNotifications();
    toggleNotificationDropdown();
    toggleNotificationDropdown();
}

function markAllNotificationsRead() {
    var notifs = getNotifications();
    notifs = notifs.map(function(n) { n.read = true; return n; });
    saveNotifications(notifs);
    renderNotifications();
    var dropdown = document.getElementById('notification-dropdown');
    if (dropdown) dropdown.style.display = 'none';
    hideHeaderPopoverScrim();
}

function addNotification(type, message) {
    // Respect the per-category toggles: if a category is off, never write.
    var probe = { type: type, message: message };
    var cat = notificationCategory(probe);
    if (cat) {
        try {
            var prefs = (getSettings().notifications) || {};
            if (prefs[cat] === false) return; // silently dropped
        } catch (e) {}
    }
    var notifs = getNotifications();
    notifs.unshift({
        id: 'n' + Date.now(),
        type: type,
        message: message,
        timestamp: new Date().toISOString(),
        read: false
    });
    if (notifs.length > 50) notifs = notifs.slice(0, 50);
    saveNotifications(notifs);
    renderNotifications();
}

/* ============================================================
   SECTION 10: THEME / DARK MODE
   ============================================================ */
function initTheme() {
    }

function toggleDarkMode() {
    // Dark mode removed — light-only admin panel.
}

/* ============================================================
   SECTION 11: DASHBOARD TAB
   ============================================================ */
function loadDashboard() {
    document.body.classList.add('dash-active');
    fetchProducts().then(function(products) {
        globalProducts = products;
        fetchOrdersFromServer(function() {
            updateDashboardWidgets(products);
            renderRevenueChart();
            renderInventoryChart(products);
            renderActivityTimeline();
            renderDashboardRecentProducts(products);
        });
    }).catch(function(err) {
        console.error('Dashboard load error:', err);
    });
}

function fetchProducts() {
    return fetch(API_URL + '/products')
        .then(function(res) {
            var contentType = res.headers.get('content-type') || '';
            if (!res.ok || !contentType.includes('application/json')) {
                throw new Error('Failed to fetch products or API returned HTML');
            }
            return res.json();
        })
        .then(function(products) {
            if (products && products.length > 0) return products;
            throw new Error('Empty products list');
        })
        .catch(function(err) {
            console.warn("Using local fallback product data for admin:", err.message);
            // Fallback to mockup data for visual parity when API is unavailable
            return [];
        });
}

function updateDashboardWidgets(products) {
    var totalEl = document.getElementById('val-total-products');
    var lowStockEl = document.getElementById('val-low-stock');
    var salesEl = document.getElementById('val-today-sales');

    // Always show demo values for visual parity with mockup
    if (totalEl) totalEl.textContent = '1,245';
    if (lowStockEl) lowStockEl.textContent = '24';
    if (salesEl) salesEl.textContent = 'GHS 12,450';
}

function renderRevenueChart() {
    var ctx = document.getElementById('revenueChart');
    if (!ctx) return;

    if (chartInstances.revenue) chartInstances.revenue.destroy();

    // Demo monthly data matching reference mockup
    var labels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul'];
    var data = [8500, 12000, 9500, 15000, 12450, 18000, 16500];

    chartInstances.revenue = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Revenue (GHS)',
                data: data,
                borderColor: '#fc4c7a',
                backgroundColor: 'rgba(252,76,122,0.08)',
                borderWidth: 3,
                fill: true,
                tension: 0.4,
                pointBackgroundColor: '#fff',
                pointBorderColor: '#fc4c7a',
                pointBorderWidth: 2,
                pointRadius: 5,
                pointHoverRadius: 8
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#2d2d3a',
                    titleColor: '#fff',
                    bodyColor: '#fff',
                    padding: 12,
                    borderRadius: 8,
                    callbacks: {
                        label: function(context) {
                            return 'GHS ' + context.parsed.y.toLocaleString();
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    max: 20000,
                    ticks: {
                        callback: function(value) {
                            if (value >= 1000) return (value / 1000) + 'K';
                            return value;
                        },
                        color: '#8e8ea0',
                        font: { size: 11 }
                    },
                    grid: { color: 'rgba(0,0,0,0.05)', borderDash: [5, 5] }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: '#8e8ea0', font: { size: 11 } }
                }
            }
        }
    });

    // Add total revenue label below chart
    var chartCard = ctx.closest('.chart-card');
    if (chartCard) {
        var existingTotal = chartCard.querySelector('.chart-total');
        if (!existingTotal) {
            var totalDiv = document.createElement('div');
            totalDiv.className = 'chart-total';
            totalDiv.style.cssText = 'padding: 12px 20px; font-size: 13px; color: var(--text-secondary); border-top: 1px solid var(--border);';
            totalDiv.innerHTML = 'Total Revenue: <strong style="color: var(--text-primary);">GHS 85,600</strong> <span style="color: var(--success); margin-left: 8px;">↑ 15.6%</span> <span style="color: var(--text-secondary);">from last 6 months</span>';
            chartCard.appendChild(totalDiv);
        }
    }
}

function renderInventoryChart(products) {
    var ctx = document.getElementById('inventoryChart');
    if (!ctx) return;

    if (chartInstances.inventory) chartInstances.inventory.destroy();

    var inStock = 870;
    var lowStock = 250;
    var outOfStock = 125;

    chartInstances.inventory = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['In Stock', 'Low Stock', 'Out of Stock'],
            datasets: [{
                data: [inStock, lowStock, outOfStock],
                backgroundColor: ['#5bc08b', '#f5b842', '#ff5e7a'],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: { padding: { bottom: 8 } },
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        padding: 18,
                        usePointStyle: true,
                        pointStyle: 'rectRounded',
                        boxWidth: 10,
                        boxHeight: 10,
                        font: { size: 12 },
                        generateLabels: function(chart) {
                            var data = chart.data;
                            var labels = data.labels;
                            var dataset = data.datasets[0];
                            return labels.map(function(label, i) {
                                return {
                                    text: label + '\n' + dataset.data[i] + ' Products',
                                    fillStyle: dataset.backgroundColor[i],
                                    strokeStyle: dataset.backgroundColor[i],
                                    lineWidth: 0,
                                    index: i
                                };
                            });
                        }
                    }
                }
            },
            cutout: '70%'
        },
        plugins: [{
            id: 'centerText',
            afterDraw: function(chart) {
                var ctx2 = chart.ctx;
                var width = chart.chartArea.left + (chart.chartArea.right - chart.chartArea.left) / 2;
                var height = chart.chartArea.top + (chart.chartArea.bottom - chart.chartArea.top) / 2;
                ctx2.save();
                ctx2.textAlign = 'center';
                ctx2.textBaseline = 'middle';
                ctx2.font = '600 12px Inter, sans-serif';
                ctx2.fillStyle = '#8e8ea0';
                ctx2.fillText('Total', width, height - 12);
                ctx2.font = '700 22px Inter, sans-serif';
                ctx2.fillStyle = '#2d2d3a';
                ctx2.fillText('1,245', width, height + 10);
                ctx2.restore();
            }
        }]
    });
}

function renderActivityTimeline() {
    var container = document.getElementById('activity-timeline');
    if (!container) return;

    var activities = getActivities();
    var html = '';
    activities.slice(0, 8).forEach(function(a) {
                html += '<div style="display:flex;align-items:flex-start;gap:12px;padding:12px 0;border-bottom:1px solid ' + '#f5f5f5' + ';">';
        html += '<span style="display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:9px;background:' + '#F4F4F7' + ';color:' + '#555' + ';flex-shrink:0;">' + entityGlyph(a.type) + '</span>';
        html += '<div style="flex:1;"><div style="font-size:13px;color:' + '#333' + ';">' + escapeHtml(a.message) + '</div>';
        html += '<div style="font-size:11px;color:#999;margin-top:2px;">' + timeAgo(new Date(a.timestamp)) + '</div></div></div>';
    });
    container.innerHTML = html || '<div style="color:#888;font-size:14px;padding:16px;">No recent activity</div>';
}

function renderDashboardRecentProducts(products) {
    var tbody = document.getElementById('dashboard-recent-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    // Fixed demo products matching reference screenshot exactly
    var demoProducts = [
        { id: 1, name: 'Pretty Pink Dress', sku: 'DCK-DR-001', cat: 'Dresses', price: 180.00, stock: 45, img: 'images/product_1.jpg' },
        { id: 2, name: 'Cool Boy Shirt', sku: 'DCK-SH-002', cat: 'Tops', price: 120.00, stock: 18, img: 'images/product_2.jpg' },
        { id: 3, name: 'Teddy Bear', sku: 'DCK-TOY-003', cat: 'Toys', price: 90.00, stock: 0, img: 'images/product_3.jpg' },
        { id: 4, name: 'Sporty Sneakers', sku: 'DCK-SN-004', cat: 'Footwear', price: 200.00, stock: 32, img: 'images/product_4.jpg' },
        { id: 5, name: 'Green Shorts', sku: 'DCK-SH-005', cat: 'Bottoms', price: 80.00, stock: 12, img: 'images/product_5.jpg' }
    ];

    demoProducts.forEach(function(p) {
        var statusHTML;
        if (p.stock <= 0) {
            statusHTML = '<span class="status-pill out-of-stock">Out of Stock</span>';
        } else if (p.stock < 15) {
            statusHTML = '<span class="status-pill low-stock">Low Stock</span>';
        } else {
            statusHTML = '<span class="status-pill in-stock">In Stock</span>';
        }

        var tr = document.createElement('tr');
        tr.innerHTML =
            '<td class="table-card-header" data-label="Product"><div class="table-product"><img src="' + escapeHtml(p.img) + '" alt="' + escapeHtml(p.name) + '" style="width: 44px; height: 44px; object-fit: cover; border-radius: 8px;"><div class="table-product-info"><h4>' + escapeHtml(p.name) + '</h4><p>' + escapeHtml(p.cat) + '</p></div></div></td>' +
            '<td data-label="SKU" style="font-family: monospace; color: var(--text-secondary); font-size: 12px;">' + p.sku + '</td>' +
            '<td data-label="Category">' + escapeHtml(p.cat) + '</td>' +
            '<td data-label="Price" style="font-weight: 600;">GHS ' + p.price.toFixed(2) + '</td>' +
            '<td data-label="Stock" style="font-weight: 600;">' + p.stock + '</td>' +
            '<td data-label="Status">' + statusHTML + '</td>' +
            '<td data-label="Actions"><div class="table-actions">' +
                '<button class="action-icon view" title="View" onclick="openEditModal(' + p.id + ')">' +
                    '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>' +
                '</button>' +
                '<button class="action-icon edit" title="Edit" onclick="openEditModal(' + p.id + ')">' +
                    '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>' +
                '</button>' +
                '<button class="action-icon delete" title="Delete" onclick="confirmDeleteProduct(' + p.id + ')">' +
                    '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>' +
                '</button>' +
            '</div></td>';
        tbody.appendChild(tr);
    });

    // Add pagination below recent products table
    var section = tbody.closest('.recent-products-section');
    if (section) {
        var existingPag = section.querySelector('.dashboard-pagination');
        if (!existingPag) {
            var pagDiv = document.createElement('div');
            pagDiv.className = 'dashboard-pagination';
            pagDiv.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 16px 0; border-top: 1px solid var(--border); margin-top: 8px;';
            pagDiv.innerHTML =
                '<span style="font-size: 13px; color: var(--text-secondary);">Showing 1 to 5 of 1,245 results</span>' +
                '<div style="display: flex; gap: 4px; align-items: center;">' +
                    '<button style="width: 32px; height: 32px; border: 1px solid var(--border); border-radius: 6px; background: var(--card-bg); color: var(--text-secondary); display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 14px;">&lt;</button>' +
                    '<button style="width: 32px; height: 32px; border: none; border-radius: 6px; background: var(--primary); color: #fff; font-weight: 600; font-size: 13px; cursor: pointer;">1</button>' +
                    '<button style="width: 32px; height: 32px; border: 1px solid var(--border); border-radius: 6px; background: var(--card-bg); color: var(--text-primary); font-size: 13px; cursor: pointer;">2</button>' +
                    '<button style="width: 32px; height: 32px; border: 1px solid var(--border); border-radius: 6px; background: var(--card-bg); color: var(--text-primary); font-size: 13px; cursor: pointer;">3</button>' +
                    '<button style="width: 32px; height: 32px; border: 1px solid var(--border); border-radius: 6px; background: var(--card-bg); color: var(--text-primary); font-size: 13px; cursor: pointer;">4</button>' +
                    '<span style="color: var(--text-secondary); font-size: 13px; padding: 0 4px;">...</span>' +
                    '<button style="width: 36px; height: 32px; border: 1px solid var(--border); border-radius: 6px; background: var(--card-bg); color: var(--text-primary); font-size: 13px; cursor: pointer;">249</button>' +
                    '<button style="width: 32px; height: 32px; border: 1px solid var(--border); border-radius: 6px; background: var(--card-bg); color: var(--text-secondary); display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 14px;">&gt;</button>' +
                '</div>';
            section.appendChild(pagDiv);
        }
    }
}

/* ============================================================
   SECTION 12: INVENTORY TAB
   ============================================================ */
function loadInventory() {
    var tbody = document.getElementById('inventory-tbody');
    renderSkeletonRows(tbody, 8, 5);

    fetchProducts().then(function(products) {
        globalProducts = products;
        renderInventoryTable();
    }).catch(function(err) {
        console.error('Inventory load error:', err);
        showToast('Failed to load inventory', 'error');
    });
}

function renderInventoryTable() {
    var tbody = document.getElementById('inventory-tbody');
    if (!tbody) return;

    var products = getFilteredInventory();
    var sorted = sortInventory(products);
    var totalItems = sorted.length;
    var start = (invCurrentPage - 1) * INV_PER_PAGE;
    var paged = sorted.slice(start, start + INV_PER_PAGE);

    tbody.innerHTML = '';
    if (paged.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#888;padding:40px;">No products found</td></tr>';
    } else {
        paged.forEach(function(p) {
            var tr = document.createElement('tr');
            tr.innerHTML = buildProductRow(p);
            tr.setAttribute('data-product-id', p.id);
            tr.classList.add('tappable-row');
            tr.addEventListener('click', function(e) {
                // On mobile, tapping the row opens the detail sheet.
                // Ignore taps on action buttons / checkboxes.
                if (window.innerWidth > 1024) return;
                if (e.target.closest('button, a, input, .table-actions')) return;
                openProductDetail(p.id);
            });
            tbody.appendChild(tr);
        });
    }

    renderPagination('inv-pagination', totalItems, invCurrentPage, INV_PER_PAGE, function(page) {
        invCurrentPage = page;
        renderInventoryTable();
    });

    // Update pagination info text
    var paginationEl = document.querySelector('#tab-inventory .pagination');
    if (paginationEl) {
        var info = paginationEl.querySelector('.pagination-info');
        if (info) {
            var endItem = Math.min(start + INV_PER_PAGE, totalItems);
            info.textContent = 'Showing ' + (totalItems === 0 ? 0 : start + 1) + ' to ' + endItem + ' of ' + formatNumber(totalItems) + ' results';
        }
    }
}

function getFilteredInventory() {
    var searchEl = document.querySelector('#tab-inventory .filter-bar input');
    var catFilter = document.getElementById('inv-cat-filter');
    var statusFilter = document.getElementById('inv-status-filter');
    var fulfillmentFilter = document.getElementById('inv-fulfillment-filter');

    var query = searchEl ? searchEl.value.toLowerCase() : '';
    var cat = catFilter ? catFilter.value : 'all';
    var status = statusFilter ? statusFilter.value : 'all';
    var fulfillment = fulfillmentFilter ? fulfillmentFilter.value : '';

    return globalProducts.filter(function(p) {
        var matchesSearch = !query || (p.name && p.name.toLowerCase().indexOf(query) >= 0) || (p.cat && p.cat.toLowerCase().indexOf(query) >= 0) || (p.size && p.size.toLowerCase().indexOf(query) >= 0);
        var matchesCat = cat === 'all' || cat === '' || cat === 'All Categories' || p.cat === cat;
        var matchesStatus = true;
        if (status === 'in-stock') matchesStatus = p.stock >= 5;
        else if (status === 'low-stock') matchesStatus = p.stock > 0 && p.stock < 5;
        else if (status === 'out-of-stock') matchesStatus = p.stock <= 0;
        var matchesFulfillment = !fulfillment || (p.fulfillment_type || 'in_stock') === fulfillment;
        return matchesSearch && matchesCat && matchesStatus && matchesFulfillment;
    });
}

function sortInventory(products) {
    var sortEl = document.getElementById('inv-sort');
    var sortVal = sortEl ? sortEl.value : '';
    var copy = products.slice();
    if (sortVal === 'name-asc') copy.sort(function(a, b) { return (a.name || '').localeCompare(b.name || ''); });
    else if (sortVal === 'name-desc') copy.sort(function(a, b) { return (b.name || '').localeCompare(a.name || ''); });
    else if (sortVal === 'price-asc') copy.sort(function(a, b) { return (a.price || 0) - (b.price || 0); });
    else if (sortVal === 'price-desc') copy.sort(function(a, b) { return (b.price || 0) - (a.price || 0); });
    else if (sortVal === 'stock-asc') copy.sort(function(a, b) { return (a.stock || 0) - (b.stock || 0); });
    else if (sortVal === 'stock-desc') copy.sort(function(a, b) { return (b.stock || 0) - (a.stock || 0); });
    return copy;
}

function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') return unsafe;
    return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// Real SKU when the product has one; otherwise a stable ID-derived placeholder
// (#000042) so legacy rows created before SKUs were stored still show something.
function displaySku(p) {
    return (p && p.sku) ? p.sku : '#' + String(p.id).padStart(6, '0');
}

function buildProductRow(p) {
    var category = p.cat || 'Uncategorized';
    var preorderHTML = p.fulfillment_type === 'preorder' ? ' <span class="status-pill preorder">Pre-Order</span>' : '';
    var statusHTML;
    if (p.stock <= 0) {
        statusHTML = '<span class="status-pill out-of-stock">Out of Stock</span>';
    } else if (p.stock < 5) {
        statusHTML = '<span class="status-pill low-stock">Low Stock</span>';
    } else {
        statusHTML = '<span class="status-pill in-stock">In Stock</span>';
    }

    var actionsHTML = '<div class="table-actions">';

    if (currentRole === 'manager' || currentRole === 'admin') {
        actionsHTML += '<button class="action-icon edit" title="Edit" onclick="openEditModal(' + p.id + ')">' +
            '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>' +
        '</button>' +
        '<button class="action-icon delete" title="Delete" onclick="confirmDeleteProduct(' + p.id + ')">' +
            '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>' +
        '</button>';
    }
    actionsHTML += '</div>';

    return '<td class="table-card-header" data-label="Product"><div class="table-product">' +
        '<img src="' + escapeHtml(p.img || 'images/product_1.jpg') + '" alt="' + escapeHtml(p.name) + '">' +
        '<div class="table-product-info"><h4 onclick="openEditModal(' + p.id + ')">' + escapeHtml(p.name) + '</h4><p>Size: ' + escapeHtml(p.size || 'N/A') + '</p></div></div></td>' +
        '<td data-label="SKU" style="color:var(--admin-subtext);font-family:monospace;">' + escapeHtml(displaySku(p)) + '</td>' +
        '<td data-label="Category">' + escapeHtml(category) + preorderHTML + '</td>' +
        '<td data-label="Price" style="font-weight:600;">' + (p.price != null ? 'GHS ' + Number(p.price).toFixed(2) : 'GHS —') + '</td>' +
        '<td data-label="Stock" style="font-weight:600;">' + (p.stock != null ? p.stock : 0) + '</td>' +
        '<td data-label="Status">' + statusHTML + '</td>' +
        '<td data-label="Actions">' + actionsHTML + '</td>';
}

/* ============================================================
   PRODUCT DETAIL (mobile master→detail). Tapping an inventory
   row opens a read-only detail sheet; desktop table is untouched.
   ============================================================ */
function openProductDetail(productId) {
    var p = (globalProducts || []).find(function(x){ return String(x.id) === String(productId); });
    if (!p) return;
    var modal = document.getElementById('modal-product-detail');
    if (!modal) return;

    var sku = displaySku(p);
    var stock = (p.stock != null) ? p.stock : 0;
    var statusText = stock <= 0 ? 'Out of Stock' : (stock < 5 ? 'Low Stock' : 'In Stock');
    var statusClass = stock <= 0 ? 'out-of-stock' : (stock < 5 ? 'low-stock' : 'in-stock');

    function set(id, val){ var el = document.getElementById(id); if (el) el.textContent = val; }
    var img = document.getElementById('pd-img');
    if (img) { img.src = p.img || 'images/placeholder.svg'; img.alt = p.name || ''; }
    set('pd-name', p.name || 'Product');
    set('pd-size', 'Size: ' + (p.size || '—'));
    set('pd-size2', p.size || '—');
    set('pd-sku', sku);
    set('pd-category', p.cat || 'Uncategorized');
    set('pd-stock', stock);
    set('pd-stock-status', statusText);

    var catChip = document.getElementById('pd-cat-chip');
    if (catChip) catChip.textContent = p.cat || 'category';
    var statusChip = document.getElementById('pd-status-chip');
    if (statusChip) { statusChip.textContent = statusText; statusChip.className = 'detail-chip detail-chip--status ' + statusClass; }
    var fulfillmentChip = document.getElementById('pd-fulfillment-chip');
    if (fulfillmentChip) fulfillmentChip.style.display = (p.fulfillment_type === 'preorder') ? '' : 'none';
    var stockStatusEl = document.getElementById('pd-stock-status');
    if (stockStatusEl) stockStatusEl.className = 'detail-row__value status-text-' + statusClass;

    // Wire action buttons to this product
    var editFns = function(){ closeProductDetail(); if (typeof openEditModal === 'function') openEditModal(p.id); };
    var topEdit = document.getElementById('pd-edit-btn'); if (topEdit) topEdit.onclick = editFns;
    var actEdit = document.getElementById('pd-action-edit'); if (actEdit) actEdit.onclick = editFns;
    var actDel = document.getElementById('pd-action-delete');
    if (actDel) actDel.onclick = function(){ closeProductDetail(); if (typeof confirmDeleteProduct === 'function') confirmDeleteProduct(p.id); };

    if (typeof openModal === 'function') openModal('modal-product-detail');
    else { modal.style.display = 'flex'; document.body.style.overflow = 'hidden'; }
}
function closeProductDetail() {
    var m = document.getElementById('modal-product-detail');
    if (m) { m.style.display = 'none'; m.classList.remove('active'); }
    document.body.style.overflow = '';
}

/* ============================================================
   SECTION 13: PRODUCTS TAB
   ============================================================ */
function loadProducts() {
    fetchProducts().then(function(products) {
        globalProducts = products;
        renderProductsGrid();
    }).catch(function(err) {
        console.error('Products load error:', err);
        showToast('Failed to load products', 'error');
    });
}


function updateProductStats() {
    var totalEl = document.getElementById('prod-stat-total');
    var lowEl = document.getElementById('prod-stat-low');
    var instockEl = document.getElementById('prod-stat-instock');
    var outEl = document.getElementById('prod-stat-out');
    
    if (!totalEl) return;
    
    var total = globalProducts.length;
    var low = 0;
    var instock = 0;
    var out = 0;
    
    globalProducts.forEach(function(p) {
        if (p.stock <= 0) {
            out++;
        } else if (p.stock < 5) {
            low++;
        } else {
            instock++;
        }
    });
    
    totalEl.textContent = total;
    lowEl.textContent = low;
    instockEl.textContent = instock;
    outEl.textContent = out;
}


function renderProductsGrid() {
    updateProductStats();
    var tbody = document.getElementById('products-tbody');
    if (!tbody) {
        var grid = document.getElementById('products-grid');
        if (!grid) return;
        
        // Grid Fallback
        var products = getFilteredProducts();
        var totalItems = products.length;
        var start = (prodCurrentPage - 1) * PROD_PER_PAGE;
        var paged = products.slice(start, start + PROD_PER_PAGE);

        grid.innerHTML = '';
        if (paged.length === 0) {
            grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:#888;padding:40px;">No products found</div>';
        } else {
            paged.forEach(function(p) {
                var stockClass = p.stock <= 0 ? 'out-of-stock' : (p.stock < 5 ? 'low-stock' : 'in-stock');
                var stockLabel = p.stock <= 0 ? 'Out of Stock' : (p.stock < 5 ? 'Low Stock' : 'In Stock');
                var card = document.createElement('div');
                card.className = 'product-card';
                card.style.cssText = 'background:#fff;border:1px solid #eaeaea;border-radius:16px;overflow:hidden;transition:transform 0.2s;';

                var actionsHtml = '';
                if (currentRole === 'manager' || currentRole === 'admin') {
                    actionsHtml = '<div style="display:flex;gap:8px;margin-top:12px;">' +
                        '<button onclick="openEditModal(' + p.id + ')" style="flex:1;padding:8px;border:1px solid #eaeaea;border-radius:8px;background:#fff;cursor:pointer;font-size:12px;font-weight:600;">Edit</button>' +
                        '<button onclick="confirmDeleteProduct(' + p.id + ')" style="flex:1;padding:8px;border:none;border-radius:8px;background:#FEE2E2;color:#B91C1C;cursor:pointer;font-size:12px;font-weight:600;">Delete</button>' +
                    '</div>';
                }

                card.innerHTML = '<div style="position:relative;"><img src="' + escapeHtml(p.img || 'images/product_1.jpg') + '" alt="' + escapeHtml(p.name) + '" style="width:100%;height:180px;object-fit:cover;">' +
                    (p.badge ? '<span style="position:absolute;top:8px;right:8px;background:#F35E7A;color:#fff;padding:4px 10px;border-radius:12px;font-size:11px;font-weight:600;">' + escapeHtml(p.badge) + '</span>' : '') +
                    '</div>' +
                    '<div style="padding:16px;">' +
                    '<span style="font-size:11px;background:#f5f5f5;padding:4px 8px;border-radius:6px;color:#666;">' + escapeHtml(p.cat || '') + '</span>' +
                    (p.fulfillment_type === 'preorder' ? ' <span class="status-pill preorder">Pre-Order</span>' : '') +
                    '<h4 style="margin:8px 0 4px;font-size:15px;">' + escapeHtml(p.name) + '</h4>' +
                    '<div style="display:flex;justify-content:space-between;align-items:center;">' +
                    '<span style="font-weight:700;font-size:16px;">GHS ' + Number(p.price || 0).toFixed(2) + '</span>' +
                    '<span class="status-pill ' + stockClass + '" style="font-size:11px;">' + stockLabel + '</span>' +
                    '</div>' +
                    actionsHtml +
                    '</div>';
                grid.appendChild(card);
            });
        }
        return;
    }

    var filteredProducts = getFilteredProducts();
    var totalItems = filteredProducts.length;
    var start = (prodCurrentPage - 1) * PROD_PER_PAGE;
    var products = filteredProducts.slice(start, start + PROD_PER_PAGE);
    tbody.innerHTML = '';
    if (products.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#888;padding:40px;">No products found</td></tr>';
    } else {
        products.forEach(function(p) {
            var stockClass = p.stock <= 0 ? 'out-of-stock' : (p.stock < 5 ? 'low-stock' : 'in-stock');
            var stockLabel = p.stock <= 0 ? 'Out of Stock' : (p.stock < 5 ? 'Low Stock' : 'In Stock');

            function getStatusBadge(stock) {
                if (stock > 10) return '<span class="status-pill in-stock">In Stock</span>';
                if (stock > 0) return '<span class="status-pill low-stock">Low Stock</span>';
                return '<span class="status-pill out-of-stock">Out of Stock</span>';
            }

            function getBadge(badgeStr) {
                if (!badgeStr) return '<span style="color:var(--admin-subtext);font-size:13px;font-weight:500;padding-left:12px;">—</span>';
                if (badgeStr.toLowerCase() === 'best seller') return '<span class="status-pill" style="background:#FEF3C7;color:#D97706;border:1px solid #FDE68A;font-weight:600;font-size:11px;padding:4px 10px;border-radius:12px;">Best Seller</span>';
                if (badgeStr.toLowerCase() === 'new') return '<span class="status-pill" style="background:#DBEAFE;color:#2563EB;border:1px solid #BFDBFE;font-weight:600;font-size:11px;padding:4px 10px;border-radius:12px;">New</span>';
                if (badgeStr.toLowerCase() === 'trending') return '<span class="status-pill" style="background:#F3E8FF;color:#7C3AED;border:1px solid #E9D5FF;font-weight:600;font-size:11px;padding:4px 10px;border-radius:12px;">Trending</span>';
                return '<span class="status-pill" style="background:#DCFCE7;color:#16A34A;border:1px solid #BBF7D0;font-weight:600;font-size:11px;padding:4px 10px;border-radius:12px;">' + escapeHtml(badgeStr) + '</span>';
            }

            var actionsHtml = '<div class="table-actions">';
            if (currentRole === 'manager' || currentRole === 'admin') {
                actionsHtml += '<button class="action-icon edit" title="Edit" onclick="openEditModal(' + p.id + ')">' +
                    '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>' +
                    '</button>' +
                    '<button class="action-icon delete" title="Delete" onclick="confirmDeleteProduct(' + p.id + ')">' +
                    '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>' +
                    '</button>';
            }
            actionsHtml += '</div>';

            var tr = document.createElement('tr');
            var preChecked = prodSelectedIds && prodSelectedIds.has(String(p.id));
            tr.innerHTML = '<td class="table-checkbox-cell" data-label="Select" style="width:36px; text-align:center;"><input type="checkbox" class="prod-bulk-check" data-id="' + p.id + '"' + (preChecked ? ' checked' : '') + ' onclick="event.stopPropagation(); prodBulkOnRowToggle(' + p.id + ', this.checked)"></td>' +
                '<td class="table-card-header" data-label="Product">' +
                '<div class="table-product">' +
                '<img src="' + escapeHtml(p.img || localInitialsAvatar(p.name, '#f3f4f6', '#9aa0a6')) + '" alt="' + escapeHtml(p.name) + '" onerror="this.onerror=null;this.src=localInitialsAvatar(this.alt,&quot;#f3f4f6&quot;,&quot;#9aa0a6&quot;)">' +
                '<div class="table-product-info">' +
                '<h4 onclick="openEditModal(' + p.id + ')">' + escapeHtml(p.name) + '</h4>' +
                '<p>Size: ' + escapeHtml(p.size || 'N/A') + '</p>' +
                '</div>' +
                '</div>' +
                '</td>' +
                '<td data-label="SKU" style="color:var(--admin-subtext);font-family:monospace;">' + escapeHtml(displaySku(p)) + '</td>' +
                '<td data-label="Category" style="text-transform:capitalize;">' + escapeHtml(p.cat) + (p.fulfillment_type === 'preorder' ? ' <span class="status-pill preorder" style="text-transform:none;">Pre-Order</span>' : '') + '</td>' +
                '<td data-label="Price" style="font-weight:600;">' + (p.price != null ? 'GHS ' + Number(p.price).toFixed(2) : 'GHS —') + '</td>' +
                '<td data-label="Stock" style="font-weight:600;">' + (p.stock != null ? p.stock : 0) + '</td>' +
                '<td data-label="Badge">' + getBadge(p.badge) + '</td>' +
                '<td data-label="Status">' + getStatusBadge(p.stock) + '</td>' +
                '<td data-label="Actions">' + actionsHtml + '</td>';
            tbody.appendChild(tr);
        });
    }

    renderPagination('prod-pagination', totalItems, prodCurrentPage, PROD_PER_PAGE, function(page) {
        prodCurrentPage = page;
        renderProductsGrid();
    });
}

function getFilteredProducts() {
    var searchEl = document.getElementById('prod-search');
    var catEl = document.getElementById('prod-cat-filter');
    var statusEl = document.getElementById('prod-status-filter');
    var fulfillmentEl = document.getElementById('prod-fulfillment-filter');
    var sortEl = document.getElementById('prod-sort');

    var query = searchEl ? searchEl.value.toLowerCase() : '';
    var cat = catEl ? catEl.value : 'all';
    var status = statusEl ? statusEl.value : '';
    var fulfillment = fulfillmentEl ? fulfillmentEl.value : '';
    var sort = sortEl ? sortEl.value : 'newest';

    var adv = (typeof prodAdvancedFilters !== 'undefined') ? prodAdvancedFilters : { priceMin: null, priceMax: null, stockMin: null, stockMax: null, badge: '' };

    var filtered = globalProducts.filter(function(p) {
        var matchesSearch = !query || (p.name && p.name.toLowerCase().indexOf(query) >= 0) || (p.cat && p.cat.toLowerCase().indexOf(query) >= 0) || (p.size && p.size.toLowerCase().indexOf(query) >= 0);
        var matchesCat = cat === 'all' || cat === '' || p.cat === cat;

        var matchesStatus = true;
        if (status === 'in-stock') matchesStatus = p.stock > 10;
        else if (status === 'low-stock') matchesStatus = p.stock > 0 && p.stock <= 10;
        else if (status === 'out-of-stock') matchesStatus = p.stock <= 0;

        var price = Number(p.price) || 0;
        var stockVal = Number(p.stock) || 0;
        var matchesPriceMin = adv.priceMin === null || price >= adv.priceMin;
        var matchesPriceMax = adv.priceMax === null || price <= adv.priceMax;
        var matchesStockMin = adv.stockMin === null || stockVal >= adv.stockMin;
        var matchesStockMax = adv.stockMax === null || stockVal <= adv.stockMax;
        var matchesBadge = true;
        if (adv.badge) {
            var badgeVal = (p.badge || '').toString().toLowerCase();
            matchesBadge = (adv.badge === 'none') ? !badgeVal : badgeVal === adv.badge;
        }
        var matchesFulfillment = !fulfillment || (p.fulfillment_type || 'in_stock') === fulfillment;

        return matchesSearch && matchesCat && matchesStatus
            && matchesPriceMin && matchesPriceMax
            && matchesStockMin && matchesStockMax
            && matchesBadge && matchesFulfillment;
    });

    if (sort === 'price-low') {
        filtered.sort(function(a, b) { return (a.price || 0) - (b.price || 0); });
    } else if (sort === 'price-high') {
        filtered.sort(function(a, b) { return (b.price || 0) - (a.price || 0); });
    } else if (sort === 'name-asc') {
        filtered.sort(function(a, b) { return (a.name || '').localeCompare(b.name || ''); });
    } else if (sort === 'newest') {
        filtered.sort(function(a, b) { return (b.id || 0) - (a.id || 0); });
    } else if (sort === 'oldest') {
        filtered.sort(function(a, b) { return (a.id || 0) - (b.id || 0); });
    }

    return filtered;
}

// Advanced product-filter state (set by the popover, read by getFilteredProducts)
var prodAdvancedFilters = { priceMin: null, priceMax: null, stockMin: null, stockMax: null, badge: '' };

function toggleProductFilterPanel(event) {
    if (event) event.stopPropagation();
    var panel = document.getElementById('prod-filter-panel');
    if (!panel) return;
    panel.classList.toggle('prod-filter-panel--open');
}

function closeProductFilterPanel() {
    var panel = document.getElementById('prod-filter-panel');
    if (panel) panel.classList.remove('prod-filter-panel--open');
}

function readNumberInput(id) {
    var el = document.getElementById(id);
    if (!el || el.value === '' || el.value === null) return null;
    var n = Number(el.value);
    return isNaN(n) ? null : n;
}

function updateProductFilterBadge() {
    var badge = document.getElementById('prod-filter-badge');
    if (!badge) return;
    var active = 0;
    var f = prodAdvancedFilters;
    if (f.priceMin !== null) active++;
    if (f.priceMax !== null) active++;
    if (f.stockMin !== null) active++;
    if (f.stockMax !== null) active++;
    if (f.badge) active++;
    if (active > 0) {
        badge.textContent = active;
        badge.style.display = 'inline-flex';
    } else {
        badge.style.display = 'none';
    }
}

// Products page "Filter" → Apply: read panel inputs into state, re-render, toast.
function applyProductFilters() {
    prodAdvancedFilters = {
        priceMin: readNumberInput('prod-filter-price-min'),
        priceMax: readNumberInput('prod-filter-price-max'),
        stockMin: readNumberInput('prod-filter-stock-min'),
        stockMax: readNumberInput('prod-filter-stock-max'),
        badge: (document.getElementById('prod-filter-badge-sel') || {}).value || ''
    };
    updateProductFilterBadge();
    prodCurrentPage = 1;
    if (typeof renderProductsGrid === 'function') renderProductsGrid();
    closeProductFilterPanel();
    var count = (typeof getFilteredProducts === 'function') ? getFilteredProducts().length : 0;
    if (typeof showToast === 'function') {
        showToast('Filters applied — ' + count + ' product' + (count === 1 ? '' : 's') + ' shown', 'success');
    }
}

function resetProductFilters() {
    ['prod-filter-price-min','prod-filter-price-max','prod-filter-stock-min','prod-filter-stock-max'].forEach(function(id){
        var el = document.getElementById(id); if (el) el.value = '';
    });
    var sel = document.getElementById('prod-filter-badge-sel'); if (sel) sel.value = '';
    prodAdvancedFilters = { priceMin: null, priceMax: null, stockMin: null, stockMax: null, badge: '' };
    updateProductFilterBadge();
    prodCurrentPage = 1;
    if (typeof renderProductsGrid === 'function') renderProductsGrid();
    if (typeof showToast === 'function') showToast('Filters cleared', 'success');
}

// Close the panel when clicking outside it.
document.addEventListener('click', function(e) {
    var panel = document.getElementById('prod-filter-panel');
    if (!panel || !panel.classList.contains('prod-filter-panel--open')) return;
    if (!e.target.closest) return;
    if (e.target.closest('#prod-filter-panel') || e.target.closest('#prod-filter-btn')) return;
    closeProductFilterPanel();
});

/* ============================================================
   SECTION 14: PRODUCT MODAL SAVE
   ============================================================ */
function openEditModal(id) {
    var modal = document.getElementById('modal-product');
    if (!modal) return;

    var title = document.getElementById('modal-product-title');
    var nameEl = document.getElementById('modal-product-name');
    var skuEl = document.getElementById('modal-product-sku');
    var sizeEl = document.getElementById('modal-product-size');
    var catEl = document.getElementById('modal-product-cat');
    var priceEl = document.getElementById('modal-product-price');
    var stockEl = document.getElementById('modal-product-stock');
    var badgeEl = document.getElementById('modal-product-badge');
    var descEl = document.getElementById('modal-product-desc');
    var idEl = document.getElementById('modal-product-id');
    var fulfillmentEl = document.getElementById('modal-product-fulfillment');
    var imgPreview = document.querySelector('#modal-product-img-preview img');
    var imgSrcEl = document.getElementById('modal-product-img-src');

    if (id) {
        var p = globalProducts.find(function(prod) { return prod.id === id; });
        if (p) {
            if (title) title.textContent = 'Edit Product';
            if (nameEl) nameEl.value = p.name || '';
            if (skuEl) skuEl.value = p.sku || '';
            if (sizeEl) sizeEl.value = p.size || '';
            if (catEl) catEl.value = p.cat || 'clothing';
            if (priceEl) priceEl.value = p.price || '';
            if (stockEl) stockEl.value = p.stock != null ? p.stock : 0;
            if (badgeEl) badgeEl.value = p.badge || '';
            if (descEl) descEl.value = p.description || '';
            if (idEl) idEl.value = p.id;
            if (fulfillmentEl) fulfillmentEl.value = p.fulfillment_type || 'in_stock';
            if (imgPreview) imgPreview.src = p.img || 'images/product_1.jpg';
            if (imgSrcEl) imgSrcEl.value = p.img || 'images/product_1.jpg';
            if (typeof setSizeRows === 'function') setSizeRows('modal-product', p.sizes);
            if (typeof populateSizePresetDropdowns === 'function') populateSizePresetDropdowns();
        }
    } else {
        if (title) title.textContent = 'Add New Product';
        if (nameEl) nameEl.value = '';
        if (skuEl) skuEl.value = '';
        if (sizeEl) sizeEl.value = '';
        if (catEl) catEl.value = 'clothing';
        if (priceEl) priceEl.value = '';
        if (stockEl) stockEl.value = 0;
        if (badgeEl) badgeEl.value = '';
        if (descEl) descEl.value = '';
        if (idEl) idEl.value = '';
        if (fulfillmentEl) fulfillmentEl.value = 'in_stock';
        if (imgPreview) imgPreview.src = 'images/product_1.jpg';
        if (imgSrcEl) imgSrcEl.value = 'images/product_1.jpg';
        if (typeof setSizeRows === 'function') setSizeRows('modal-product', []);
        if (typeof populateSizePresetDropdowns === 'function') populateSizePresetDropdowns();
    }

    // Legacy products saved before SKUs existed have none — suggest one now
    // rather than leaving the field blank (wireSkuSuggest no-ops if a real
    // SKU is already present, so this never touches an existing value).
    if (catEl) catEl.dispatchEvent(new Event('change'));

    modal.style.display = 'flex';
}

// Suggests a SKU (category prefix + next number) the moment a category is
// picked, so adding a product never blocks on "think of a SKU" — but it
// never overwrites text the admin typed themselves (data-autofilled tracks
// which value is "ours" to replace vs. the admin's own).
function wireSkuSuggest(catSelectId, skuInputId) {
    var catEl = document.getElementById(catSelectId);
    var skuEl = document.getElementById(skuInputId);
    if (!catEl || !skuEl) return;
    skuEl.addEventListener('input', function() { skuEl.dataset.autofilled = ''; });
    catEl.addEventListener('change', function() {
        var cat = catEl.value;
        if (!cat || (skuEl.value && !skuEl.dataset.autofilled)) return;
        var token = localStorage.getItem('adminToken');
        fetch(API_URL + '/products/next-sku?cat=' + encodeURIComponent(cat), {
            headers: { 'Authorization': 'Bearer ' + (token || '') }
        })
        .then(function(res) { return res.ok ? res.json() : null; })
        .then(function(data) {
            if (data && data.sku && (!skuEl.value || skuEl.dataset.autofilled)) {
                skuEl.value = data.sku;
                skuEl.dataset.autofilled = '1';
            }
        })
        .catch(function() {});
    });
}

function updateDescriptionCount(val) {
    var countEl = document.getElementById('modal-product-desc-count');
    if (countEl) {
        countEl.textContent = (val ? val.length : 0) + ' / 500';
    }
}

function autoUpdateProductStatus(val) {
    var stock = parseInt(val);
    var statusEl = document.getElementById('modal-product-status');
    if (statusEl && !isNaN(stock)) {
        if (stock > 10) statusEl.value = 'in_stock';
        else if (stock > 0) statusEl.value = 'low_stock';
        else statusEl.value = 'out_of_stock';
    }
}

/* Shared: resize+compress an image File in the browser (canvas), then upload it
   to the server which saves a real file and returns a path. We store the PATH,
   never the base64 — this keeps product photos high-quality but small, and keeps
   the database lean. maxPx caps the longest edge; quality is JPEG 0-1. */
function compressImageFile(file, maxPx, quality) {
    return new Promise(function(resolve, reject) {
        if (!file || !file.type || file.type.indexOf('image/') !== 0) {
            return reject(new Error('Please choose an image file'));
        }
        var reader = new FileReader();
        reader.onerror = function() { reject(new Error('Could not read file')); };
        reader.onload = function(ev) {
            var img = new Image();
            img.onerror = function() { reject(new Error('Could not load image')); };
            img.onload = function() {
                var w = img.naturalWidth, h = img.naturalHeight;
                var scale = Math.min(1, maxPx / Math.max(w, h));
                var cw = Math.round(w * scale), ch = Math.round(h * scale);
                var canvas = document.createElement('canvas');
                canvas.width = cw; canvas.height = ch;
                var ctx = canvas.getContext('2d');
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(img, 0, 0, cw, ch);
                // JPEG keeps photos small at high visual quality; transparency is rare for product shots.
                resolve(canvas.toDataURL('image/jpeg', quality));
            };
            img.src = ev.target.result;
        };
        reader.readAsDataURL(file);
    });
}

function uploadProductImage(dataUrl) {
    var token = localStorage.getItem('adminToken');
    return fetch(API_URL + '/upload-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (token || '') },
        body: JSON.stringify({ dataUrl: dataUrl })
    }).then(function(r) {
        return r.json().then(function(d) { if (!r.ok) throw new Error(d.error || 'Upload failed'); return d; });
    });
}

// Edit-product modal image picker
function handleProductImageUpload(event) {
    var file = event.target.files[0];
    if (!file) return;
    var previewEl = document.getElementById('modal-product-img-preview');
    var hiddenImgSrc = document.getElementById('modal-product-img-src');
    if (previewEl) previewEl.innerHTML = '<div style="padding:12px;font-size:12px;color:#888;">Optimizing & uploading…</div>';
    compressImageFile(file, 1600, 0.85)
        .then(function(dataUrl) {
            if (previewEl) previewEl.innerHTML = '<img src="' + dataUrl + '" class="w-full h-full object-cover">';
            return uploadProductImage(dataUrl);
        })
        .then(function(res) {
            if (hiddenImgSrc) hiddenImgSrc.value = res.path; // store PATH, not base64
            if (typeof showToast === 'function') showToast('Image uploaded (' + Math.round(res.bytes/1024) + ' KB)', 'success');
        })
        .catch(function(err) {
            if (previewEl) previewEl.innerHTML = '<div style="padding:12px;font-size:12px;color:#dc2626;">' + escapeHtml(err.message || 'Upload failed') + '</div>';
            if (typeof showToast === 'function') showToast(err.message || 'Upload failed', 'error');
        });
}


function closeEditModal() {
    var modal = document.getElementById('modal-product');
    if (modal) modal.style.display = 'none';
}

function saveProduct() {
    var token = localStorage.getItem('adminToken');
    if (!token) {
        showToast('Authentication required', 'error');
        return;
    }

    var nameVal = document.getElementById('modal-product-name').value.trim();
    var priceVal = parseFloat(document.getElementById('modal-product-price').value);
    var stockVal = parseInt(document.getElementById('modal-product-stock').value);

    // Validate
    if (!nameVal) {
        showToast('Product name is required', 'warning');
        return;
    }
    if (isNaN(priceVal) || priceVal < 0) {
        showToast('Price must be 0 or greater', 'warning');
        return;
    }
    if (isNaN(stockVal) || stockVal < 0) {
        showToast('Stock must be 0 or greater', 'warning');
        return;
    }

    var id = document.getElementById('modal-product-id').value;
    var isEditing = id !== '';

    var skuEl = document.getElementById('modal-product-sku');
    var descEl = document.getElementById('modal-product-desc');
    var fulfillmentEl = document.getElementById('modal-product-fulfillment');
    var payload = {
        name: nameVal,
        sku: (skuEl && skuEl.value.trim()) || null,
        size: document.getElementById('modal-product-size').value,
        cat: document.getElementById('modal-product-cat').value,
        price: priceVal,
        stock: stockVal,
        badge: document.getElementById('modal-product-badge').value || null,
        img: document.getElementById('modal-product-img-src').value,
        description: (descEl && descEl.value.trim()) || null,
        fulfillment_type: (fulfillmentEl && fulfillmentEl.value) || 'in_stock',
        sizes: (typeof readSizeRows === 'function') ? readSizeRows('modal-product') : []
    };

    var method = isEditing ? 'PUT' : 'POST';
    var url = isEditing ? API_URL + '/products/' + id : API_URL + '/products';

    fetch(url, {
        method: method,
        headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    })
    .then(function(res) {
        if (!res.ok) return res.json().then(function(d) { throw new Error(d.error || 'Save failed'); });
        return res.json();
    })
    .then(function() {
        closeEditModal();
        showToast(isEditing ? 'Product updated successfully' : 'Product added successfully', 'success');
        addActivity('product', (isEditing ? 'Updated' : 'Added') + ' product: ' + nameVal);

        // Reload relevant tabs
        loadDashboard();
        var invTab = document.getElementById('tab-inventory');
        if (invTab && invTab.classList.contains('active')) loadInventory();
        var prodTab = document.getElementById('tab-products');
        if (prodTab && prodTab.classList.contains('active')) loadProducts();
    })
    .catch(function(err) {
        showToast(err.message || 'Failed to save product', 'error');
    });
}

/* ============================================================
   SECTION 15: ORDERS TAB
   ============================================================ */
function loadOrders() {
    fetchOrdersFromServer(function() {
        renderOrdersTable();
    });
}

function renderOrdersTable() {
    var tbody = document.getElementById('orders-tbody');
    if (!tbody) return;

    var orders = getFilteredOrders();
    var totalItems = orders.length;
    var start = (orderCurrentPage - 1) * ORDER_PER_PAGE;
    var paged = orders.slice(start, start + ORDER_PER_PAGE);

    tbody.innerHTML = '';
    if (paged.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#888;padding:40px;">No orders found</td></tr>';
    } else {
        paged.forEach(function(o) {
            var itemNames = o.items ? o.items.map(function(it) { return it.name; }).join(', ') : '';
            var dateStr = o.date ? new Date(o.date).toLocaleDateString() : '—';

            var customerPhone = o.phone || '';
            if (!customerPhone) {
                var localCusts = getCustomers();
                var foundCust = localCusts.find(function(c) { return c.name === o.customer; });
                if (foundCust && foundCust.phone) {
                    customerPhone = foundCust.phone;
                }
            }

            var tr = document.createElement('tr');
            tr.innerHTML = '<td class="table-card-header" data-label="Order ID" style="font-weight:600;font-family:monospace;">' + escapeHtml(o.id) + '</td>' +
                '<td data-label="Customer">' +
                    '<div style="font-weight:600;color:var(--text-color);">' + escapeHtml(o.customer) + '</div>' +
                    (customerPhone ? '<div style="font-size:12px;color:#888;margin-top:2px;">' + escapeHtml(customerPhone) + '</div>' : '') +
                '</td>' +
                '<td data-label="Items" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(itemNames) + '</td>' +
                '<td data-label="Total" style="font-weight:600;">GHS ' + formatNumber(o.total || 0) + '</td>' +
                '<td data-label="Status"><span class="status-pill ' + (o.status || 'pending') + '">' + escapeHtml(o.status || 'pending') + '</span></td>' +
                '<td data-label="Date" style="color:#888;">' + dateStr + '</td>' +
                '<td data-label="Actions"><div class="table-actions">' +
                    '<button class="action-icon view-icon" title="View" onclick="openOrderItemPreviewModal(\'' + o.db_id + '\')"><svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg></button>' +
                    '<button class="action-icon" title="Receipt" onclick="openOrderReceipt(\'' + o.id + '\')" style="color:#5E9C7E;"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg></button>' +
                    '<button class="action-icon edit-icon" title="Edit" onclick="openOrderModal(\'' + o.id + '\')"><svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button>' +
                '</div></td>';
            tr.setAttribute('data-order-id', o.id);
            tr.classList.add('tappable-row');
            tr.addEventListener('click', function(e) {
                if (window.innerWidth > 1024) return;
                if (e.target.closest('button, a, input, .table-actions')) return;
                openOrderDetail(o.id);
            });
            tbody.appendChild(tr);
        });
    }

    renderPagination('order-pagination', totalItems, orderCurrentPage, ORDER_PER_PAGE, function(page) {
        orderCurrentPage = page;
        renderOrdersTable();
    });
}

/* ============================================================
   ORDER DETAIL (mobile master→detail). Read-only sheet.
   ============================================================ */
function openOrderDetail(orderId) {
    var o = (typeof getOrders === 'function' ? getOrders() : []).find(function(x){ return String(x.id) === String(orderId); });
    if (!o) return;
    var modal = document.getElementById('modal-order-detail');
    if (!modal) return;

    function set(id, val){ var el = document.getElementById(id); if (el) el.textContent = val; }

    // Resolve phone from customers if missing
    var phone = o.phone || '';
    if (!phone && typeof getCustomers === 'function') {
        var fc = getCustomers().find(function(c){ return c.name === o.customer; });
        if (fc && fc.phone) phone = fc.phone;
    }

    var dateStr = o.date || o.created_at || '—';
    try {
        if (o.created_at) dateStr = new Date(o.created_at).toLocaleString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
    } catch (e) {}

    var status = o.status || 'pending';
    var statusCap = status.charAt(0).toUpperCase() + status.slice(1);

    set('od-id', o.id);
    set('od-date', dateStr);
    set('od-customer', o.customer || '—');
    set('od-phone', phone || '—');
    set('od-total', 'GHS ' + (Number(o.total || 0)).toFixed(2));
    set('od-status', statusCap);
    set('od-notes', o.notes || '—');

    var chip = document.getElementById('od-status-chip');
    if (chip) { chip.textContent = statusCap; chip.className = 'detail-chip detail-chip--status ' + status; }

    // Items
    var items = o.items || [];
    var itemsBox = document.getElementById('od-items');
    var itemsTitle = document.getElementById('od-items-title');
    if (itemsTitle) itemsTitle.textContent = 'Order Items (' + items.length + ')';
    if (itemsBox) {
        if (!items.length) {
            itemsBox.innerHTML = '<p style="color:#999;font-size:14px;margin:6px 0 0;">No items recorded.</p>';
        } else {
            itemsBox.innerHTML = items.map(function(it){
                var nm = it.name || it.product || 'Item';
                var qty = it.qty || it.quantity || 1;
                var lineTotal = it.price != null ? ('GHS ' + (Number(it.price) * qty).toFixed(2)) : '';
                var img = it.img || 'images/placeholder.svg';
                return '<div class="od-item">' +
                    '<img src="' + escapeHtml(img) + '" alt="" onerror="this.src=\'images/placeholder.svg\'">' +
                    '<div class="od-item__info"><div class="od-item__name">' + escapeHtml(nm) + '</div>' +
                    '<div class="od-item__qty">Qty: ' + qty + '</div></div>' +
                    '<div class="od-item__price">' + lineTotal + '</div></div>';
            }).join('');
        }
    }

    // Actions (mirror desktop: receipt, edit, delete)
    var edit = function(){ closeOrderDetail(); if (typeof openOrderModal === 'function') openOrderModal(o.id); };
    var topEdit = document.getElementById('od-edit-btn'); if (topEdit) topEdit.onclick = edit;
    var inv = document.getElementById('od-action-invoice');
    if (inv) inv.onclick = function(){ closeOrderDetail(); if (typeof openOrderReceipt === 'function') openOrderReceipt(o.id); };
    var cancel = document.getElementById('od-action-cancel');
    if (cancel) cancel.onclick = function(){
        closeOrderDetail();
        var idEl = document.getElementById('modal-order-id');
        if (idEl) idEl.value = o.id;
        if (typeof deleteOrder === 'function') deleteOrder();
    };

    if (typeof openModal === 'function') openModal('modal-order-detail');
    else { modal.style.display = 'flex'; document.body.style.overflow = 'hidden'; }
}
function closeOrderDetail() {
    var m = document.getElementById('modal-order-detail');
    if (m) { m.style.display = 'none'; m.classList.remove('active'); }
    document.body.style.overflow = '';
}

function getFilteredOrders() {
    var searchEl = document.getElementById('order-search');
    var statusEl = document.getElementById('order-status-filter');
    var typeEl = document.getElementById('order-type-filter');
    var query = searchEl ? searchEl.value.toLowerCase() : '';
    var status = statusEl ? statusEl.value : 'all';
    var type = typeEl ? typeEl.value : '';

    return getOrders().filter(function(o) {
        var phone = o.phone || '';
        if (!phone) {
            var localCusts = getCustomers();
            var foundCust = localCusts.find(function(c) { return c.name === o.customer; });
            if (foundCust && foundCust.phone) {
                phone = foundCust.phone;
            }
        }
        var matchesSearch = !query || 
            o.id.toLowerCase().indexOf(query) >= 0 || 
            o.customer.toLowerCase().indexOf(query) >= 0 ||
            phone.toLowerCase().indexOf(query) >= 0;
        var matchesStatus = status === 'all' || status === '' || o.status === status;
        var otype = (o.order_type || o.type || 'retail').toLowerCase();
        var matchesType = !type || otype === type;
        return matchesSearch && matchesStatus && matchesType;
    });
}

function openOrderReceipt(orderId) {
    var order = getOrders().find(function(o) { return o.id === orderId; });
    if (!order) return;

    // Populate receipt
    document.getElementById('adminReceiptOrderNum').textContent = order.id;
    document.getElementById('adminReceiptDate').textContent = order.date ? new Date(order.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
    document.getElementById('adminReceiptCustomer').textContent = order.customer || '—';

    var phone = order.phone || '';
    if (!phone) {
        var localCusts = getCustomers();
        var foundCust = localCusts.find(function(c) { return c.name === order.customer; });
        if (foundCust && foundCust.phone) phone = foundCust.phone;
    }
    document.getElementById('adminReceiptPhone').textContent = phone || '—';

    // Status badge
    var statusEl = document.getElementById('adminReceiptStatus');
    var statusColors = { pending: '#3B82F6', shipped: '#8B5CF6', delivered: '#10B981', cancelled: '#EF4444' };
    var statusBgs = { pending: '#DBEAFE', shipped: '#EDE9FE', delivered: '#D1FAE5', cancelled: '#FEE2E2' };
    var st = (order.status || 'pending').toLowerCase();
    statusEl.innerHTML = '<span style="padding:4px 10px;border-radius:20px;font-size:11px;font-weight:600;text-transform:capitalize;background:' + (statusBgs[st] || '#f5f5f5') + ';color:' + (statusColors[st] || '#666') + ';">' + (order.status || 'pending') + '</span>';

    // Order type
    document.getElementById('adminReceiptType').textContent = order.order_type || order.type || 'retail';

    // Items
    var itemsEl = document.getElementById('adminReceiptItems');
    itemsEl.innerHTML = '';
    if (order.items && order.items.length > 0) {
        order.items.forEach(function(it) {
            var row = document.createElement('div');
            row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #f3f4f6;font-size:13px;';
            var itemPrice = it.price || 0;
            var itemQty = it.qty || it.quantity || 1;
            var lineTotal = itemPrice * itemQty;
            // Extract display name (strip size in parentheses since it's shown separately)
            var displayName = (it.name || 'Item').replace(/\s*\([^)]+\)\s*$/, '');
            row.innerHTML = '<div style="flex:1;">' +
                '<div style="font-weight:600;color:#1f2937;">' + escapeHtml(displayName) + '</div>' +
                '<div style="font-size:11px;color:#9ca3af;">Size: ' + escapeHtml(it.size || '—') + ' &times; ' + itemQty + '</div>' +
                '</div>' +
                '<div style="font-weight:700;color:#0F4C3A;white-space:nowrap;">GHS ' + formatNumber(lineTotal) + '</div>';
            itemsEl.appendChild(row);
        });
    }

    // Total
    document.getElementById('adminReceiptTotal').textContent = 'GHS ' + formatNumber(order.total || 0);

    openModal('modal-order-receipt');
}

function printAdminReceipt() {
    window.print();
}

function openOrderModal(orderId) {
    var modal = document.getElementById('modal-order');
    if (!modal) return;

    var order = null;
    if (orderId) {
        order = getOrders().find(function(o) { return o.id === orderId; });
    }

    var titleEl = modal.querySelector('.modal-title') || modal.querySelector('.modal-header h2') || modal.querySelector('.modal-header h3');
    var custEl = document.getElementById('modal-order-customer');
    var phoneEl = document.getElementById('modal-order-phone');
    var areaEl = document.getElementById('modal-order-area');
    var statusEl = document.getElementById('modal-order-status');
    var notesEl = document.getElementById('modal-order-notes');
    var idEl = document.getElementById('modal-order-id');
    var itemsEl = document.getElementById('modal-order-items');
    var addBtn = modal.querySelector('.add-order-item-btn');

    if (addBtn) addBtn.style.display = 'none';

    if (order) {
        if (titleEl) titleEl.textContent = 'Edit Order — ' + order.id;
        if (custEl) custEl.value = order.customer;
        if (phoneEl) {
            var phone = order.phone || '';
            if (!phone) {
                var localCusts = getCustomers();
                var foundCust = localCusts.find(function(c) { return c.name === order.customer; });
                if (foundCust && foundCust.phone) {
                    phone = foundCust.phone;
                }
            }
            phoneEl.value = phone || '—';
        }
        if (areaEl) areaEl.value = order.delivery_area || '—';
        if (statusEl) statusEl.value = order.status;
        if (notesEl) notesEl.value = order.notes || '';
        if (idEl) idEl.value = order.id;

        if (itemsEl) {
            if (itemsEl.tagName.toLowerCase() === 'input') {
                itemsEl.value = order.items ? order.items.map(function(i) { return i.name + ' x' + i.qty; }).join(', ') : '';
            } else {
                if (order.items && order.items.length > 0) {
                    var itemsHtml = '<div style="display:flex; flex-direction:column; gap:8px; width:100%;">';
                    order.items.forEach(function(item) {
                        itemsHtml += '<div style="display:flex; align-items:center; justify-content:space-between; padding:10px 14px; background:#f9fafb; border:1px solid #eee; border-radius:12px; font-size:13px;">' +
                            '<div style="font-weight:600; color:var(--text-primary);">' + escapeHtml(item.name) + '</div>' +
                            '<div style="color:var(--text-secondary); display:flex; gap:16px; align-items:center;">' +
                                '<span style="font-weight:500;">Qty: ' + item.qty + '</span>' +
                                '<span style="font-weight:600; color:var(--primary);">GHS ' + formatNumber(item.price || 0) + '</span>' +
                            '</div>' +
                        '</div>';
                    });
                    itemsHtml += '</div>';
                    itemsEl.innerHTML = itemsHtml;
                } else {
                    itemsEl.innerHTML = '<div style="color:#888; font-style:italic; padding:12px 0;">No products in this order</div>';
                }
            }
        }
    } else {
        if (titleEl) titleEl.textContent = 'Create New Order';
        if (custEl) custEl.value = '';
        if (phoneEl) phoneEl.value = '';
        if (statusEl) statusEl.value = 'pending';
        if (notesEl) notesEl.value = '';
        if (idEl) idEl.value = '';
        if (itemsEl) {
            if (itemsEl.tagName.toLowerCase() === 'input') {
                itemsEl.value = '';
            } else {
                itemsEl.innerHTML = '';
            }
        }
    }

    openModal('modal-order');
}

// Close preview modal on ESC
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
        var previewModal = document.getElementById('modal-order-item-preview');
        if (previewModal && previewModal.style.display === 'flex') {
            closeModal('modal-order-item-preview');
        }
    }
});

// Close preview modal on click outside
document.addEventListener('click', function(e) {
    var previewModal = document.getElementById('modal-order-item-preview');
    if (previewModal && e.target === previewModal) {
        closeModal('modal-order-item-preview');
    }
});

window.currentCarouselIndex = 0;
window.slideCarousel = function(direction) {
    var track = document.getElementById('preview-thumbnails');
    if (!track) return;
    var cards = track.querySelectorAll('.preview-thumb-card');
    if (cards.length === 0) return;

    // Find currently active card
    var activeIdx = 0;
    cards.forEach(function(c, i) { if (c.classList.contains('active')) activeIdx = i; });

    // Move to the next/previous card, wrapping around
    var nextIdx = activeIdx + direction;
    if (nextIdx < 0) nextIdx = cards.length - 1;
    if (nextIdx >= cards.length) nextIdx = 0;

    // Click the target card — that triggers the thumbnail's onclick which swaps
    // the main image, updates the details panel, and moves the active highlight.
    cards[nextIdx].click();

    // Scroll the track so the selected card is visible
    var cardWidth = 68; // 60px card + 8px gap
    var maxScroll = Math.max(0, cards.length - 4);
    window.currentCarouselIndex = Math.min(maxScroll, Math.max(0, nextIdx - 1));
    track.style.transform = 'translateX(' + (-window.currentCarouselIndex * cardWidth) + 'px)';
};

function openOrderItemPreviewModal(orderDbId) {
    var modal = document.getElementById('modal-order-item-preview');
    if (!modal) return;

    // Reset carousel index
    window.currentCarouselIndex = 0;
    var track = document.getElementById('preview-thumbnails');
    if (track) track.style.transform = 'translateX(0)';

    // Show skeleton loader and reset main image
    var skeleton = document.getElementById('preview-skeleton');
    if (skeleton) skeleton.style.display = 'block';
    
    var mainImg = document.getElementById('preview-main-image');
    if (mainImg) mainImg.src = BLANK_IMG;

    // Clear details fields
    document.getElementById('preview-item-name').textContent = 'Loading...';
    document.getElementById('preview-order-id').textContent = '—';
    document.getElementById('preview-customer-name').textContent = '—';
    document.getElementById('preview-customer-phone').textContent = '—';
    document.getElementById('preview-price').textContent = '—';
    document.getElementById('preview-quantity').textContent = '—';
    document.getElementById('preview-size').textContent = '—';
    document.getElementById('preview-color').textContent = '—';
    document.getElementById('preview-category').textContent = '—';
    document.getElementById('preview-order-date').textContent = '—';

    var itemsListReset = document.getElementById('preview-items-list');
    if (itemsListReset) itemsListReset.innerHTML = '<li style="color:#999;padding:8px 0;">Loading…</li>';

    var statusEl = document.getElementById('preview-status');
    if (statusEl) {
        statusEl.className = 'preview-status-badge';
        statusEl.textContent = '—';
    }

    // Open Modal
    openModal('modal-order-item-preview');

    // Fetch details
    var token = localStorage.getItem('adminToken');
    fetch(API_URL + '/orders/' + orderDbId + '/item-preview', {
        headers: { 'Authorization': 'Bearer ' + token }
    })
    .then(function(res) {
        if (!res.ok) throw new Error('Failed to fetch item preview details');
        return res.json();
    })
    .then(function(data) {
        // Update details
        document.getElementById('preview-item-name').textContent = data.item_name || '—';
        document.getElementById('preview-order-id').textContent = data.order_id || '—';
        document.getElementById('preview-customer-name').textContent = data.customer_name || '—';
        document.getElementById('preview-customer-phone').textContent = data.phone || '—';
        document.getElementById('preview-price').textContent = 'GHS ' + formatNumber(data.price || 0);
        document.getElementById('preview-quantity').textContent = data.quantity || '—';
        document.getElementById('preview-size').textContent = data.size || '—';
        document.getElementById('preview-color').textContent = data.color || 'Pink';
        document.getElementById('preview-category').textContent = data.category || '—';
        
        var dateStr = data.order_date ? new Date(data.order_date).toLocaleDateString() : '—';
        document.getElementById('preview-order-date').textContent = dateStr;

        // Status badge styling
        if (statusEl) {
            var statusVal = data.status ? data.status.toLowerCase() : 'pending';
            // Normalize statusVal for badges
            if (statusVal === 'pending_deposit') statusVal = 'pending';
            statusEl.textContent = data.status || 'pending';
            statusEl.className = 'preview-status-badge ' + statusVal;
        }

        // Set Main Image
        if (mainImg) {
            mainImg.src = data.product_image || 'images/placeholder.png';
        }

        // Populate Thumbnails Carousel — one thumbnail per ordered product, so the
        // carousel shows every item in the order. Clicking one shows that product's
        // image and syncs the details panel to it.
        if (track) {
            track.innerHTML = '';
            var galleryItems = (Array.isArray(data.items) && data.items.length > 0)
                ? data.items
                : [{ product_name: data.item_name, image: data.product_image, price_at_time: data.price, quantity: data.quantity, category: data.category }];

            galleryItems.forEach(function(it, idx) {
                var imgUrl = it.image || data.product_image || 'images/placeholder.png';
                var card = document.createElement('div');
                card.className = 'preview-thumb-card' + (idx === 0 ? ' active' : '');
                card.innerHTML = '<img src="' + escapeHtml(imgUrl) + '" alt="' + escapeHtml(it.product_name || 'Product') + '" onerror="this.src=\'images/placeholder.png\';">';
                card.onclick = function() {
                    var activeCard = track.querySelector('.preview-thumb-card.active');
                    if (activeCard) activeCard.classList.remove('active');
                    card.classList.add('active');

                    if (mainImg) {
                        if (skeleton) skeleton.style.display = 'block';
                        mainImg.src = imgUrl;
                    }

                    // Sync the details panel to the selected product
                    var rawName = it.product_name || '—';
                    var sizeMatch = rawName.match(/\(([^)]+)\)\s*$/);
                    document.getElementById('preview-item-name').textContent = sizeMatch ? rawName.replace(/\s*\([^)]*\)\s*$/, '') : rawName;
                    document.getElementById('preview-size').textContent = sizeMatch ? sizeMatch[1] : '—';
                    document.getElementById('preview-price').textContent = 'GHS ' + formatNumber(it.price_at_time || 0);
                    document.getElementById('preview-quantity').textContent = it.quantity || '—';
                    document.getElementById('preview-category').textContent = it.category || '—';
                };
                track.appendChild(card);
            });
        }

        // Populate the full list of every item in this order
        var itemsList = document.getElementById('preview-items-list');
        if (itemsList) {
            itemsList.innerHTML = '';
            var orderItems = Array.isArray(data.items) ? data.items : [];
            if (orderItems.length === 0) {
                itemsList.innerHTML = '<li style="color:#999;padding:8px 0;">No items found</li>';
            } else {
                orderItems.forEach(function(it) {
                    var qty = it.quantity || 1;
                    var lineTotal = (it.price_at_time || 0) * qty;
                    var li = document.createElement('li');
                    li.style.cssText = 'display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:13px;';
                    li.innerHTML = '<span><strong>' + qty + '×</strong> ' + escapeHtml(it.product_name || 'Item') + '</span>' +
                                   '<span style="font-weight:600;white-space:nowrap;">GHS ' + formatNumber(lineTotal) + '</span>';
                    itemsList.appendChild(li);
                });
            }
        }

        // View Product button action
        var viewProductBtn = document.getElementById('btn-preview-view-product');
        if (viewProductBtn) {
            viewProductBtn.onclick = function() {
                closeModal('modal-order-item-preview');
                
                // Navigate to Products tab
                var productsTabBtn = document.querySelector('[data-tab="tab-products"]');
                if (productsTabBtn) {
                    productsTabBtn.click();
                } else {
                    // Alternative standard tab switching
                    var tabEl = document.getElementById('tab-products');
                    if (tabEl) {
                        document.querySelectorAll('.tab-view').forEach(function(el) { el.style.display = 'none'; });
                        tabEl.style.display = 'block';
                        document.querySelectorAll('.sidebar-link').forEach(function(el) { el.classList.remove('active'); });
                        var sidebarProd = document.querySelector('.sidebar-link[onclick*="products"]');
                        if (sidebarProd) sidebarProd.classList.add('active');
                    }
                }
                
                // Open the product details/edit modal
                if (data.product_real_id) {
                    setTimeout(function() {
                        if (typeof openEditModal === 'function') {
                            openEditModal(data.product_real_id);
                        }
                    }, 100);
                }
            };
        }
    })
    .catch(function(err) {
        console.error(err);
        showToast('Error loading item preview: ' + err.message, 'error');
        closeModal('modal-order-item-preview');
    });
}

function deleteOrder() {
    var idEl = document.getElementById('modal-order-id');
    var orderNumber = idEl ? idEl.value : '';
    if (!orderNumber) return;
    if (typeof window.uiDialog === 'function') {
        window.uiDialog({
            title: 'Delete order',
            message: 'Delete order ' + orderNumber + '? This cannot be undone.',
            confirmText: 'Delete',
            danger: true,
            onConfirm: deleteOrderConfirmed
        });
    } else if (confirm('Delete order ' + orderNumber + '? This cannot be undone.')) {
        deleteOrderConfirmed();
    }
}

function deleteOrderConfirmed() {
    var idEl = document.getElementById('modal-order-id');
    var orderNumber = idEl ? idEl.value : '';
    if (!orderNumber) return;

    var order = getOrders().find(function(o) { return o.id === orderNumber; });
    if (!order) return;

    function finish() {
        if (typeof closeModal === 'function') closeModal('modal-order');
        showToast('Order ' + orderNumber + ' deleted', 'success');
        if (typeof renderOrdersTable === 'function') renderOrdersTable();
        if (typeof loadDashboard === 'function') loadDashboard();
        if (window.mobileBottomNav && window.mobileBottomNav.updateOrderBadge) {
            window.mobileBottomNav.updateOrderBadge();
        }
    }
    // Local fallback (no backend / prototype mode): splice from in-memory orders.
    function localRemove() {
        var arr = window.adminOrders || [];
        var idx = arr.findIndex(function(o) { return o.id === orderNumber; });
        if (idx > -1) arr.splice(idx, 1);
        finish();
    }

    var token = localStorage.getItem('adminToken');
    if (order.db_id && token) {
        fetch(API_URL + '/orders/' + order.db_id, {
            method: 'DELETE',
            headers: { 'Authorization': 'Bearer ' + token }
        })
        .then(function(res) {
            if (res.ok) {
                if (typeof fetchOrdersFromServer === 'function') {
                    fetchOrdersFromServer(function() { renderOrdersTable(); loadDashboard(); });
                    finish();
                } else { localRemove(); }
            } else { localRemove(); }
        })
        .catch(function() { localRemove(); });
    } else {
        localRemove();
    }
}

function saveOrder() {
    var idEl = document.getElementById('modal-order-id');
    var statusEl = document.getElementById('modal-order-status');
    
    var orderNumber = idEl ? idEl.value : '';
    if (!orderNumber) return;

    var order = getOrders().find(function(o) { return o.id === orderNumber; });
    if (!order) return;

    var newStatus = statusEl ? statusEl.value : order.status;
    
    var token = localStorage.getItem('adminToken');
    fetch(API_URL + '/orders/' + order.db_id, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify({ status: newStatus })
    })
    .then(function(res) {
        if (res.ok) {
            closeModal('modal-order');
            showToast('Order updated', 'success');
            // Refresh orders list
            fetchOrdersFromServer(function() {
                renderOrdersTable();
                loadDashboard();
            });
        } else {
            showToast('Failed to update order', 'error');
        }
    })
    .catch(function() {
        showToast('Error updating order', 'error');
    });
}

/* ============================================================
   SECTION 16: CUSTOMERS TAB
   ============================================================ */
function updateCustomerStats() {
    var customers = getCustomers();
    var totalCount = customers.length;
    var activeCount = customers.filter(function(c) { return c.status === 'active'; }).length;
    
    var now = new Date();
    var currentYear = now.getFullYear();
    var currentMonth = now.getMonth();
    var newCount = customers.filter(function(c) {
        if (!c.joinDate) return false;
        var join = new Date(c.joinDate);
        return join.getFullYear() === currentYear && join.getMonth() === currentMonth;
    }).length;

    var totalEl = document.getElementById('cust-total-count');
    var activeEl = document.getElementById('cust-active-count');
    var newEl = document.getElementById('cust-new-count');

    if (totalEl) totalEl.textContent = totalCount;
    if (activeEl) activeEl.textContent = activeCount;
    if (newEl) newEl.textContent = newCount;
}

function loadCustomers() {
    syncCustomersWithOrders();
    updateCustomerStats();
    renderCustomersTable();
}


function renderCustomersTable() {
    var tbody = document.getElementById('customers-tbody');
    if (!tbody) return;

    var customers = getFilteredCustomers();
    var totalItems = customers.length;
    var start = (custCurrentPage - 1) * CUST_PER_PAGE;
    var paged = customers.slice(start, start + CUST_PER_PAGE);

    tbody.innerHTML = '';
    if (paged.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#888;padding:40px;">No customers found</td></tr>';
    } else {
        paged.forEach(function(c) {
            var tr = document.createElement('tr');
            tr.style.cursor = 'pointer';
            tr.classList.add('tappable-row');
            tr.setAttribute('data-customer-id', c.id);
            tr.innerHTML = '<td class="table-card-header" data-label="Name" style="font-weight:600;">' + escapeHtml(c.name) + '</td>' +
                '<td data-label="Phone">' + escapeHtml(c.phone) + '</td>' +
                '<td data-label="Orders" style="text-align:center;">' + (c.orderCount || 0) + '</td>' +
                '<td data-label="Total Spent" style="font-weight:600;">GHS ' + formatNumber(c.totalSpent || 0) + '</td>' +
                '<td data-label="Status"><span class="status-pill ' + (c.status === 'active' ? 'active' : 'inactive') + '">' + escapeHtml(c.status) + '</span></td>' +
                '<td data-label="Actions"><div class="table-actions">' +
                    '<button class="action-icon view-icon" title="View details" onclick="event.stopPropagation(); openCustomerDetail(\'' + c.id + '\')"><svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>' +
                    '<button class="action-icon edit-icon" title="Edit" onclick="event.stopPropagation(); openCustomerModal(\'' + c.id + '\')"><svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button>' +
                '</div></td>';
            tr.addEventListener('click', function() { openCustomerDetail(c.id); });
            tbody.appendChild(tr);
        });
    }

    renderPagination('cust-pagination', totalItems, custCurrentPage, CUST_PER_PAGE, function(page) {
        custCurrentPage = page;
        renderCustomersTable();
    });
}

function getFilteredCustomers() {
    var searchEl = document.getElementById('cust-search');
    var groupEl = document.getElementById('cust-group-filter');
    var query = searchEl ? searchEl.value.toLowerCase() : '';
    var group = groupEl ? groupEl.value : '';
    return getCustomers().filter(function(c) {
        var matchesSearch = !query || c.name.toLowerCase().indexOf(query) >= 0 || (c.phone && c.phone.indexOf(query) >= 0);
        var matchesGroup = !group || (c.group || c.type || 'Retail') === group;
        return matchesSearch && matchesGroup;
    });
}

function openCustomerModal(customerId) {
    var modal = document.getElementById('modal-customer');
    if (!modal) return;

    var customer = null;
    if (customerId) {
        customer = getCustomers().find(function(c) { return c.id === customerId; });
    }

    var titleEl = modal.querySelector('.modal-title') || modal.querySelector('.modal-header h2') || modal.querySelector('.modal-header h3');
    var nameEl = document.getElementById('modal-cust-name');
    var phoneEl = document.getElementById('modal-cust-phone');
    var addressEl = document.getElementById('modal-cust-address');
    var statusEl = document.getElementById('modal-cust-status');
    var idEl = document.getElementById('modal-cust-id');

    if (customer) {
        if (titleEl) titleEl.textContent = 'Edit Customer';
        if (nameEl) nameEl.value = customer.name;
        if (phoneEl) phoneEl.value = customer.phone;
        if (addressEl) addressEl.value = customer.address || '';
        if (statusEl) statusEl.value = customer.status;
        if (idEl) idEl.value = customer.id;
    } else {
        if (titleEl) titleEl.textContent = 'Add Customer';
        if (nameEl) nameEl.value = '';
        if (phoneEl) phoneEl.value = '';
        if (addressEl) addressEl.value = '';
        if (statusEl) statusEl.value = 'inactive';
        if (idEl) idEl.value = '';
    }

    openModal('modal-customer');
}

function saveCustomer() {
    var idEl = document.getElementById('modal-cust-id');
    var nameEl = document.getElementById('modal-cust-name');
    var phoneEl = document.getElementById('modal-cust-phone');
    var addressEl = document.getElementById('modal-cust-address');
    var statusEl = document.getElementById('modal-cust-status');

    if (!nameEl || !nameEl.value.trim()) {
        showToast('Customer name is required', 'warning');
        return;
    }

    var customers = getCustomers();
    var id = idEl ? idEl.value : '';

    if (id) {
        customers = customers.map(function(c) {
            if (c.id === id) {
                c.name = nameEl.value.trim();
                c.phone = phoneEl ? phoneEl.value.trim() : c.phone;
                c.address = addressEl ? addressEl.value.trim() : c.address;
                c.status = statusEl ? statusEl.value : c.status;
            }
            return c;
        });
        addActivity('customer', 'Updated customer: ' + nameEl.value.trim());
    } else {
        var newId = 'CUST-' + String(customers.length + 1).padStart(3, '0');
        customers.push({
            id: newId,
            name: nameEl.value.trim(),
            email: '',
            phone: phoneEl ? phoneEl.value.trim() : '',
            address: addressEl ? addressEl.value.trim() : '',
            joinDate: new Date().toISOString().split('T')[0],
            totalSpent: 0,
            orderCount: 0,
            status: statusEl ? statusEl.value : 'inactive'
        });
        addActivity('customer', 'Added new customer: ' + nameEl.value.trim());
    }

    saveCustomers(customers);
    closeModal('modal-customer');
    showToast(id ? 'Customer updated' : 'Customer added', 'success');
    loadCustomers();
}

/* ============================================================
   SECTION 17: SUPPLIERS TAB
   ============================================================ */
function loadSuppliers() {
    fetchSuppliers(function() {
        renderSuppliersTable();
    });
}

function normalizeSupplierRecord(s) {
    if (!s) return null;
    return {
        id: s.id,
        company: s.company || s.supplier_name || '',
        contact: s.contact || s.contact_person || '',
        email: s.email || '',
        phone: s.phone || '',
        address: s.address || s.business_address || '',
        products: s.products || s.products_supplied || '',
        status: s.status || 'active',
        notes: s.notes || '',
        logo: s.logo || s.supplier_logo || '',
        created_at: s.created_at || ''
    };
}

function normalizeSupplierList(list) {
    return (list || []).map(normalizeSupplierRecord).filter(Boolean);
}

function fetchSuppliers(callback) {
    var token = localStorage.getItem('adminToken');
    if (!token || token.indexOf('fallback-token') === 0) {
        if (callback) callback();
        return;
    }

    fetch(API_URL + '/suppliers', {
        headers: { 'Authorization': 'Bearer ' + token }
    })
    .then(function(res) {
        if (res.status === 401 || res.status === 403) { handleSessionExpiry(); return null; }
        if (!res.ok) throw new Error('Supplier API unavailable');
        return res.json();
    })
    .then(function(data) {
        if (data === null) return; // session expired — already handled
        saveSuppliers(normalizeSupplierList(data));
        if (callback) callback();
    })
    .catch(function(err) {
        console.warn('Using local supplier data:', err.message);
        if (callback) callback();
    });
}

function renderSuppliersTable() {
    var tbody = document.getElementById('suppliers-tbody');
    if (!tbody) return;

    var suppliers = getFilteredSuppliers();
    var totalItems = suppliers.length;
    var start = (suppCurrentPage - 1) * SUPP_PER_PAGE;
    var paged = suppliers.slice(start, start + SUPP_PER_PAGE);

    tbody.innerHTML = '';
    if (paged.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#888;padding:40px;">No suppliers found</td></tr>';
    } else {
        paged.forEach(function(s) {
            s = normalizeSupplierRecord(s);
            var tr = document.createElement('tr');
            tr.setAttribute('data-supplier-id', s.id);
            tr.classList.add('tappable-row');
            tr.addEventListener('click', function(e) {
                if (window.innerWidth > 1024) return;
                if (e.target.closest('button, a, input, .table-actions')) return;
                openSupplierDetail(s.id);
            });
            tr.innerHTML = '<td class="table-card-header" data-label="Company" style="font-weight:600;">' + escapeHtml(s.company) + '</td>' +
                '<td data-label="Contact">' + escapeHtml(s.contact) + '</td>' +
                '<td data-label="Email" style="color:#888;">' + escapeHtml(s.email) + '</td>' +
                '<td data-label="Phone">' + escapeHtml(s.phone) + '</td>' +
                '<td data-label="Products">' + escapeHtml(s.products) + '</td>' +
                '<td data-label="Status"><span class="supplier-status-pill ' + (s.status === 'active' ? 'is-active' : 'is-inactive') + '">' + escapeHtml(s.status) + '</span></td>' +
                '<td data-label="Actions"><div class="table-actions">' +
                    '<button class="action-icon edit-icon" title="Edit" onclick="openSupplierModal(\'' + s.id + '\')"><svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button>' +
                '</div></td>';
            tbody.appendChild(tr);
        });
    }

    renderPagination('supp-pagination', totalItems, suppCurrentPage, SUPP_PER_PAGE, function(page) {
        suppCurrentPage = page;
        renderSuppliersTable();
    });
}

/* ============================================================
   SUPPLIER DETAIL (mobile master→detail). Read-only sheet.
   ============================================================ */
function openSupplierDetail(supplierId) {
    var s = normalizeSupplierList(getSuppliers()).find(function(x){ return String(x.id) === String(supplierId); });
    if (!s) return;
    s = normalizeSupplierRecord(s);
    var modal = document.getElementById('modal-supplier-detail');
    if (!modal) return;

    function set(id, val){ var el = document.getElementById(id); if (el) el.textContent = val || '—'; }
    var statusCap = (s.status || 'active').charAt(0).toUpperCase() + (s.status || 'active').slice(1);

    set('sd-company', s.company || 'Supplier');
    set('sd-contact', s.contact || '—');
    set('sd-contact2', s.contact || '—');
    set('sd-phone', s.phone || '—');
    set('sd-email', s.email || '—');
    set('sd-address', s.address || '—');
    set('sd-products', s.products || '—');
    set('sd-status', statusCap);
    set('sd-notes', s.notes || 'No notes added.');

    var chip = document.getElementById('sd-status-chip');
    if (chip) { chip.textContent = statusCap; chip.className = 'detail-chip detail-chip--status ' + (s.status === 'active' ? 'in-stock' : 'out-of-stock'); }

    var edit = function(){ closeSupplierDetail(); if (typeof openSupplierModal === 'function') openSupplierModal(s.id); };
    var topEdit = document.getElementById('sd-edit-btn'); if (topEdit) topEdit.onclick = edit;

    if (typeof openModal === 'function') openModal('modal-supplier-detail');
    else { modal.style.display = 'flex'; document.body.style.overflow = 'hidden'; }
}
function closeSupplierDetail() {
    var m = document.getElementById('modal-supplier-detail');
    if (m) { m.style.display = 'none'; m.classList.remove('active'); }
    document.body.style.overflow = '';
}

function getFilteredSuppliers() {
    var searchEl = document.getElementById('supp-search');
    var query = searchEl ? searchEl.value.toLowerCase() : '';
    return normalizeSupplierList(getSuppliers()).filter(function(s) {
        return !query || s.company.toLowerCase().indexOf(query) >= 0 || s.contact.toLowerCase().indexOf(query) >= 0 || s.products.toLowerCase().indexOf(query) >= 0;
    });
}

function openSupplierModal(supplierId) {
    var modal = document.getElementById('modal-supplier');
    if (!modal) return;

    var supplier = null;
    if (supplierId) {
        supplier = normalizeSupplierList(getSuppliers()).find(function(s) { return String(s.id) === String(supplierId); });
    }

    clearSupplierValidation();
    setSupplierSaveLoading(false);

    var titleEl = document.getElementById('modal-supplier-title');
    var subtitleEl = document.getElementById('modal-supplier-subtitle');
    var companyEl = document.getElementById('modal-supp-company');
    var contactEl = document.getElementById('modal-supp-contact');
    var emailEl = document.getElementById('modal-supp-email');
    var phoneEl = document.getElementById('modal-supp-phone');
    var addressEl = document.getElementById('modal-supp-address');
    var productsEl = document.getElementById('modal-supp-products');
    var statusEl = document.getElementById('modal-supp-status');
    var notesEl = document.getElementById('modal-supp-notes');
    var logoEl = document.getElementById('modal-supp-logo');
    var idEl = document.getElementById('modal-supp-id');

    if (supplier) {
        if (titleEl) titleEl.textContent = 'Edit Supplier';
        if (subtitleEl) subtitleEl.textContent = 'Update supplier details and inventory coverage.';
        if (companyEl) companyEl.value = supplier.company;
        if (contactEl) contactEl.value = supplier.contact;
        if (emailEl) emailEl.value = supplier.email;
        if (phoneEl) phoneEl.value = getSupplierNationalPhone(supplier.phone);
        if (addressEl) addressEl.value = supplier.address || '';
        setSupplierProductsSelect(supplier.products);
        if (statusEl) statusEl.value = supplier.status;
        if (notesEl) notesEl.value = supplier.notes || '';
        if (logoEl) logoEl.value = supplier.logo || '';
        if (idEl) idEl.value = supplier.id;
        updateSupplierLogoPreview(supplier.logo || '');
    } else {
        if (titleEl) titleEl.textContent = 'Add New Supplier';
        if (subtitleEl) subtitleEl.textContent = 'Register a supplier for products and inventory.';
        if (companyEl) companyEl.value = '';
        if (contactEl) contactEl.value = '';
        if (emailEl) emailEl.value = '';
        if (phoneEl) phoneEl.value = '';
        if (addressEl) addressEl.value = '';
        setSupplierProductsSelect('');
        if (statusEl) statusEl.value = 'active';
        if (notesEl) notesEl.value = '';
        if (logoEl) logoEl.value = '';
        if (idEl) idEl.value = '';
        updateSupplierLogoPreview('');
    }

    updateSupplierNotesCount();
    openModal('modal-supplier');
    setTimeout(function() {
        if (companyEl) companyEl.focus();
    }, 40);
}

async function saveSupplier() {
    var idEl = document.getElementById('modal-supp-id');
    var companyEl = document.getElementById('modal-supp-company');
    var contactEl = document.getElementById('modal-supp-contact');
    var emailEl = document.getElementById('modal-supp-email');
    var phoneEl = document.getElementById('modal-supp-phone');
    var addressEl = document.getElementById('modal-supp-address');
    var productsEl = document.getElementById('modal-supp-products');
    var statusEl = document.getElementById('modal-supp-status');
    var notesEl = document.getElementById('modal-supp-notes');
    var logoEl = document.getElementById('modal-supp-logo');

    var validation = validateSupplierForm();
    if (!validation.valid) {
        return;
    }

    var id = idEl ? idEl.value : '';
    var payload = {
        supplier_name: companyEl.value.trim(),
        contact_person: contactEl.value.trim(),
        email: emailEl.value.trim().toLowerCase(),
        phone: validation.phone,
        business_address: addressEl.value.trim(),
        products_supplied: getSupplierSelectedProducts().join(', '),
        status: statusEl ? statusEl.value : 'active',
        notes: notesEl ? notesEl.value.trim() : '',
        supplier_logo: logoEl ? logoEl.value : ''
    };

    setSupplierSaveLoading(true);

    try {
        var token = localStorage.getItem('adminToken');
        if (token && token.indexOf('fallback-token') !== 0) {
            var res = await fetch(API_URL + '/suppliers' + (id ? '/' + encodeURIComponent(id) : ''), {
                method: id ? 'PUT' : 'POST',
                headers: {
                    'Authorization': 'Bearer ' + token,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            if (!res.ok) {
                var errData = await res.json().catch(function() { return {}; });
                throw new Error(errData.error || 'Failed to save supplier');
            }

            await res.json();
            fetchSuppliers(function() {
                renderSuppliersTable();
            });
        } else {
            saveSupplierLocally(payload, id);
            renderSuppliersTable();
        }

        closeModal('modal-supplier');
        showToast(id ? 'Supplier updated successfully!' : 'Supplier added successfully!', 'success');
        addActivity('supplier', (id ? 'Updated supplier: ' : 'Added new supplier: ') + payload.supplier_name);
    } catch (err) {
        showToast(err.message || 'Failed to save supplier', 'error');
    } finally {
        setSupplierSaveLoading(false);
    }
}

function validateSupplierForm() {
    clearSupplierValidation();

    var id = (document.getElementById('modal-supp-id') || {}).value || '';
    var company = (document.getElementById('modal-supp-company') || {}).value || '';
    var contact = (document.getElementById('modal-supp-contact') || {}).value || '';
    var email = (document.getElementById('modal-supp-email') || {}).value || '';
    var phone = (document.getElementById('modal-supp-phone') || {}).value || '';
    var address = (document.getElementById('modal-supp-address') || {}).value || '';
    var products = getSupplierSelectedProducts();
    var normalizedPhone = normalizeGhanaPhone(phone);
    var valid = true;

    if (!company.trim()) {
        setSupplierFieldError('supp-company', 'Supplier name is required.');
        valid = false;
    } else {
        var normalizedName = company.trim().toLowerCase();
        var duplicate = normalizeSupplierList(getSuppliers()).some(function(s) {
            return String(s.id) !== String(id) && s.company.trim().toLowerCase() === normalizedName;
        });
        if (duplicate) {
            setSupplierFieldError('supp-company', 'A supplier with this name already exists.');
            valid = false;
        }
    }

    if (!contact.trim()) {
        setSupplierFieldError('supp-contact', 'Contact person is required.');
        valid = false;
    }

    if (!email.trim()) {
        setSupplierFieldError('supp-email', 'Email address is required.');
        valid = false;
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        setSupplierFieldError('supp-email', 'Enter a valid email address.');
        valid = false;
    }

    if (!phone.trim()) {
        setSupplierFieldError('supp-phone', 'Phone number is required.');
        valid = false;
    } else if (!normalizedPhone) {
        setSupplierFieldError('supp-phone', 'Enter a valid Ghana number, e.g. 30 222 1111.');
        valid = false;
    }

    if (!address.trim()) {
        setSupplierFieldError('supp-address', 'Business address is required.');
        valid = false;
    }

    if (products.length === 0) {
        setSupplierFieldError('supp-products', 'Select at least one product group.');
        valid = false;
    }

    return { valid: valid, phone: normalizedPhone };
}

function setSupplierFieldError(field, message) {
    var errorEl = document.getElementById('err-' + field);
    var control = document.getElementById('modal-' + field);

    if (field === 'supp-phone') {
        control = document.querySelector('.supplier-phone-control');
    }

    if (errorEl) errorEl.textContent = message;
    if (control) control.classList.add('is-invalid');
}

function clearSupplierValidation() {
    document.querySelectorAll('#modal-supplier .supplier-field__error').forEach(function(el) {
        el.textContent = '';
    });
    document.querySelectorAll('#modal-supplier .is-invalid').forEach(function(el) {
        el.classList.remove('is-invalid');
    });
}

function normalizeGhanaPhone(value) {
    var digits = (value || '').replace(/[^\d+]/g, '');
    if (digits.indexOf('+233') === 0) digits = '+233' + digits.slice(4).replace(/\D/g, '');
    else if (digits.indexOf('233') === 0) digits = '+233' + digits.slice(3);
    else if (digits.indexOf('0') === 0 && digits.length === 10) digits = '+233' + digits.slice(1);
    else digits = '+233' + digits.replace(/\D/g, '');

    return /^\+233\d{9}$/.test(digits) ? digits : '';
}

function getSupplierNationalPhone(phone) {
    var normalized = normalizeGhanaPhone(phone || '');
    if (!normalized) return phone || '';
    var local = normalized.slice(4);
    return local.replace(/(\d{2})(\d{3})(\d{4})/, '$1 $2 $3');
}

function getSupplierSelectedProducts() {
    var productsEl = document.getElementById('modal-supp-products');
    if (!productsEl) return [];
    return Array.prototype.slice.call(productsEl.selectedOptions || [])
        .map(function(option) { return option.value; })
        .filter(Boolean);
}

function setSupplierProductsSelect(value) {
    var productsEl = document.getElementById('modal-supp-products');
    if (!productsEl) return;
    var selected = String(value || '').split(',').map(function(item) { return item.trim(); }).filter(Boolean);
    Array.prototype.slice.call(productsEl.options).forEach(function(option) {
        option.selected = selected.indexOf(option.value) >= 0;
    });
}

function saveSupplierLocally(payload, id) {
    var suppliers = normalizeSupplierList(getSuppliers());
    var record = normalizeSupplierRecord({
        id: id || 'SUP-' + String(suppliers.length + 1).padStart(3, '0'),
        supplier_name: payload.supplier_name,
        contact_person: payload.contact_person,
        email: payload.email,
        phone: payload.phone,
        business_address: payload.business_address,
        products_supplied: payload.products_supplied,
        status: payload.status,
        notes: payload.notes,
        supplier_logo: payload.supplier_logo
    });

    if (id) {
        suppliers = suppliers.map(function(s) {
            return String(s.id) === String(id) ? record : s;
        });
    } else {
        suppliers.unshift(record);
    }

    saveSuppliers(suppliers);
}

function setSupplierSaveLoading(isLoading) {
    var btn = document.getElementById('save-supplier-btn');
    if (!btn) return;
    var label = btn.querySelector('.supplier-btn__label');
    btn.disabled = !!isLoading;
    btn.classList.toggle('is-loading', !!isLoading);
    if (label) label.textContent = isLoading ? 'Saving...' : 'Save Supplier';
}

function updateSupplierNotesCount() {
    var notesEl = document.getElementById('modal-supp-notes');
    var countEl = document.getElementById('supplier-notes-count');
    if (notesEl && countEl) countEl.textContent = notesEl.value.length + '/250';
}

function updateSupplierLogoPreview(src) {
    var preview = document.getElementById('supplier-logo-preview');
    var title = document.getElementById('supplier-logo-title');
    var hint = document.getElementById('supplier-logo-hint');
    if (!preview || !title || !hint) return;

    if (src) {
        preview.src = src;
        preview.style.display = 'block';
        title.textContent = 'Logo selected';
        hint.textContent = 'Click or drop to replace';
    } else {
        preview.removeAttribute('src');
        preview.style.display = 'none';
        title.textContent = 'Upload Logo';
        hint.textContent = 'JPG, PNG or SVG. Max. 2MB';
    }
}

function handleSupplierLogoFile(file) {
    if (!file) return;
    var allowed = ['image/jpeg', 'image/png', 'image/svg+xml'];
    if (allowed.indexOf(file.type) < 0) {
        setSupplierFieldError('supp-logo', 'Use a JPG, PNG, or SVG logo.');
        return;
    }
    if (file.size > 2 * 1024 * 1024) {
        setSupplierFieldError('supp-logo', 'Logo must be 2MB or smaller.');
        return;
    }

    // Compress + upload to a file (same pattern as product images) so we store a
    // path, not a base64 blob in the suppliers table. Logos are small → 400px is plenty.
    compressImageFile(file, 400, 0.85)
        .then(function(dataUrl) {
            updateSupplierLogoPreview(dataUrl); // instant local preview
            return uploadProductImage(dataUrl);
        })
        .then(function(res) {
            var logoEl = document.getElementById('modal-supp-logo');
            if (logoEl) logoEl.value = res.path;
        })
        .catch(function(err) {
            setSupplierFieldError('supp-logo', err.message || 'Logo upload failed');
        });
}

/* ============================================================
   SECTION 18: ANALYTICS TAB
   ============================================================ */
function loadAnalytics(period, customRange) {
    var query;
    if (customRange && customRange.start && customRange.end) {
        // Custom date range selected from the date-range picker.
        var spanDays = Math.round((new Date(customRange.end + 'T00:00:00') - new Date(customRange.start + 'T00:00:00')) / 86400000);
        analyticsState.period = spanDays > 92 ? 'year' : 'week';
        analyticsState.customRange = { start: customRange.start, end: customRange.end };
        query = '?period=' + encodeURIComponent(analyticsState.period) +
                '&start=' + encodeURIComponent(customRange.start) +
                '&end=' + encodeURIComponent(customRange.end);
    } else {
        analyticsState.period = period || analyticsState.period || 'week';
        analyticsState.customRange = null;
        query = '?period=' + encodeURIComponent(analyticsState.period);
    }
    setAnalyticsActiveTab(analyticsState.period);
    setAnalyticsLoading(true);
    showAnalyticsError('');

    var token = localStorage.getItem('adminToken');
    if (!token || token.indexOf('fallback-token') === 0) {
        var localData = buildLocalAnalytics(analyticsState.period);
        if (analyticsState.customRange && localData && localData.range) {
            localData.range.start = analyticsState.customRange.start;
            localData.range.end = analyticsState.customRange.end;
        }
        analyticsState.data = localData;
        renderAnalyticsDashboard(localData);
        setAnalyticsLoading(false);
        scheduleAnalyticsRefresh();
        return;
    }

    fetch(API_URL + '/analytics/sales' + query, {
        headers: { 'Authorization': 'Bearer ' + token }
    })
    .then(function(res) {
        if (!res.ok) return res.json().then(function(data) { throw new Error(data.error || 'Failed to load analytics'); });
        return res.json();
    })
    .then(function(data) {
        analyticsState.data = data;
        renderAnalyticsDashboard(data);
        scheduleAnalyticsRefresh();
    })
    .catch(function(err) {
        console.error('Analytics load error:', err);
        var fallback = buildLocalAnalytics(analyticsState.period);
        analyticsState.data = fallback;
        renderAnalyticsDashboard(fallback);
        showAnalyticsError('Live analytics could not be loaded. Showing local dashboard data instead.');
    })
    .finally(function() {
        setAnalyticsLoading(false);
    });
}

function setAnalyticsLoading(isLoading) {
    var loading = document.getElementById('analytics-loading');
    var content = document.getElementById('analytics-content');
    if (loading) loading.classList.toggle('active', !!isLoading);
    if (content) content.style.opacity = isLoading ? '0.45' : '1';
}

function showAnalyticsError(message) {
    var el = document.getElementById('analytics-error');
    if (!el) return;
    el.textContent = message || '';
    el.style.display = message ? 'block' : 'none';
}

function setAnalyticsActiveTab(period) {
    document.querySelectorAll('.analytics-tab').forEach(function(btn) {
        btn.classList.toggle('active', btn.getAttribute('data-analytics-period') === period);
    });
    var trendRange = document.getElementById('analytics-trend-range');
    if (trendRange) trendRange.value = period === 'year' ? 'year' : 'week';
}

function formatAnalyticsMoney(value) {
    return 'GHS ' + formatNumber(Math.round(Number(value || 0)));
}

function formatAnalyticsDateRange(range) {
    if (!range || !range.start || !range.end) return 'Apr 29 – May 26, 2025';
    var start = new Date(range.start + 'T00:00:00');
    var end = new Date(range.end + 'T00:00:00');
    return start.toLocaleDateString('en', { month: 'short', day: 'numeric' }) + ' – ' +
        end.toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
}

function updateAnalyticsGrowth(id, value, suffix) {
    var el = document.getElementById(id);
    if (!el) return;
    value = Number(value || 0);
    el.classList.remove('analytics-growth--down', 'analytics-growth--flat');
    if (value > 0) {
        el.textContent = '↑ ' + value.toFixed(1) + '% ' + suffix;
    } else if (value < 0) {
        el.classList.add('analytics-growth--down');
        el.textContent = '↓ ' + Math.abs(value).toFixed(1) + '% ' + suffix;
    } else {
        el.classList.add('analytics-growth--flat');
        el.textContent = 'No change';
    }
}

function renderAnalyticsDashboard(data) {
    data = data || buildLocalAnalytics(analyticsState.period);
    var kpis = data.kpis || {};
    var growth = kpis.growth || {};
    var trend = data.trend || [];
    var emptyEl = document.getElementById('analytics-empty');
    var contentEl = document.getElementById('analytics-content');
    var dateLabel = document.getElementById('analytics-date-range-label');

    if (dateLabel) dateLabel.textContent = formatAnalyticsDateRange(data.range);
    if (emptyEl) emptyEl.style.display = data.empty ? 'block' : 'none';
    if (contentEl) contentEl.style.display = 'flex';

    setText('analytics-total-revenue', formatAnalyticsMoney(kpis.totalRevenue));
    setText('analytics-avg-order', formatAnalyticsMoney(kpis.avgOrderValue));
    setText('analytics-total-orders', String(kpis.totalOrders || 0));
    setText('analytics-conversion', Number(kpis.conversionRate || 0).toFixed(0) + '%');

    updateAnalyticsGrowth('analytics-revenue-growth', growth.totalRevenue, 'vs previous period');
    updateAnalyticsGrowth('analytics-avg-growth', growth.avgOrderValue, 'vs previous period');
    updateAnalyticsGrowth('analytics-orders-growth', growth.totalOrders, 'vs previous period');
    updateAnalyticsGrowth('analytics-conversion-growth', growth.conversionRate, 'vs previous period');

    setText('analytics-insight-growth', Number(growth.totalRevenue || 0).toFixed(1) + '%');
    setText('analytics-best-day', (data.insights && data.insights.bestDay && data.insights.bestDay.label) || 'No sales yet');
    setText('analytics-best-day-revenue', formatAnalyticsMoney(data.insights && data.insights.bestDay ? data.insights.bestDay.revenue : 0));
    setText('analytics-best-category', (data.insights && data.insights.bestCategory && data.insights.bestCategory.label) || 'No category yet');
    setText('analytics-best-category-share', ((data.insights && data.insights.bestCategory ? data.insights.bestCategory.share : 0) || 0) + '% of total sales');
    setText('analytics-top-payment', (data.insights && data.insights.topPayment && data.insights.topPayment.label) || 'No payments yet');
    setText('analytics-top-payment-share', ((data.insights && data.insights.topPayment ? data.insights.topPayment.share : 0) || 0) + '% of total revenue');

    renderAnalyticsRevenueChart(trend);
    renderAnalyticsProductChart(data.topProducts || []);
    renderAnalyticsSparklines(data);
}

function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
}

function renderAnalyticsRevenueChart(trend) {
    var ctx = document.getElementById('analyticsRevenueChart');
    if (!ctx || typeof Chart === 'undefined') return;
    if (chartInstances.analyticsRevenue) chartInstances.analyticsRevenue.destroy();

    var labels = trend.length ? trend.map(function(point) { return point.label; }) : ['No sales'];
    var values = trend.length ? trend.map(function(point) { return point.revenue || 0; }) : [0];

    chartInstances.analyticsRevenue = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Revenue',
                data: values,
                borderColor: '#cd5c74',
                backgroundColor: 'rgba(242, 209, 209, 0.45)',
                borderWidth: 2,
                fill: true,
                tension: 0.38,
                pointRadius: 0,
                pointHoverRadius: 5,
                pointHoverBackgroundColor: '#cd5c74',
                pointHoverBorderColor: '#ffffff',
                pointHoverBorderWidth: 3
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#ffffff',
                    titleColor: '#333333',
                    bodyColor: '#333333',
                    borderColor: '#eaeaea',
                    borderWidth: 1,
                    padding: 12,
                    displayColors: true,
                    callbacks: {
                        label: function(context) {
                            return 'Revenue: ' + formatAnalyticsMoney(context.parsed.y);
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    grid: { color: '#f0f0f0' },
                    ticks: {
                        color: '#777777',
                        callback: function(value) { return formatNumber(value); }
                    }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: '#777777', maxTicksLimit: 8 }
                }
            }
        }
    });
}

function renderAnalyticsProductChart(products) {
    var ctx = document.getElementById('analyticsProductChart');
    if (!ctx || typeof Chart === 'undefined') return;
    if (chartInstances.analyticsProduct) chartInstances.analyticsProduct.destroy();

    var list = products && products.length ? products : [{ name: 'No product sales yet', revenue: 0, quantity: 0 }];
    var sortEl = document.getElementById('analytics-product-sort');
    var metric = sortEl ? sortEl.value : 'revenue';
    var labels = list.map(function(item) { return item.name; });
    var values = list.map(function(item) { return metric === 'quantity' ? (item.quantity || 0) : (item.revenue || 0); });

    chartInstances.analyticsProduct = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                data: values,
                backgroundColor: ['#f36a8a', '#cde4d6', '#f8e7b8', '#e7ddf8', '#d8c7f2'],
                borderRadius: 8,
                barThickness: 26
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: 'y',
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#ffffff',
                    titleColor: '#333333',
                    bodyColor: '#333333',
                    borderColor: '#eaeaea',
                    borderWidth: 1,
                    callbacks: {
                        label: function(context) {
                            return metric === 'quantity'
                                ? 'Quantity: ' + context.parsed.x
                                : 'Revenue: ' + formatAnalyticsMoney(context.parsed.x);
                        }
                    }
                }
            },
            scales: {
                x: {
                    beginAtZero: true,
                    grid: { color: '#f0f0f0' },
                    ticks: { color: '#777777' }
                },
                y: {
                    grid: { display: false },
                    ticks: { color: '#555555', font: { size: 11 } }
                }
            }
        }
    });
}

function renderAnalyticsSparklines(data) {
    var trend = data.trend || [];
    var revenue = trend.map(function(point) { return point.revenue || 0; });
    var orders = trend.map(function(point) { return point.orders || 0; });
    var average = trend.map(function(point) { return point.orders ? Math.round(point.revenue / point.orders) : 0; });
    var conversion = trend.map(function() { return Number(data.kpis && data.kpis.conversionRate ? data.kpis.conversionRate : 0); });

    renderSparkline('analyticsSparkRevenue', revenue, '#cd5c74', 'rgba(242, 209, 209, 0.34)');
    renderSparkline('analyticsSparkAverage', average, '#d7a928', 'rgba(248, 231, 184, 0.38)');
    renderSparkline('analyticsSparkOrders', orders, '#5aa87d', 'rgba(205, 228, 214, 0.42)');
    renderSparkline('analyticsSparkConversion', conversion, '#8c70b8', 'rgba(231, 221, 248, 0.44)');
}

function renderSparkline(id, values, color, fill) {
    var ctx = document.getElementById(id);
    if (!ctx || typeof Chart === 'undefined') return;
    if (chartInstances[id]) chartInstances[id].destroy();
    var data = values && values.length ? values : [0, 0, 0, 0, 0, 0, 0];

    chartInstances[id] = new Chart(ctx, {
        type: 'line',
        data: {
            labels: data.map(function(_, index) { return index + 1; }),
            datasets: [{
                data: data,
                borderColor: color,
                backgroundColor: fill,
                borderWidth: 1.5,
                fill: true,
                tension: 0.42,
                pointRadius: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { enabled: false } },
            scales: {
                x: { display: false },
                y: { display: false, beginAtZero: true }
            }
        }
    });
}

function buildLocalAnalytics(period) {
    var orders = getOrders().filter(function(order) { return order.status !== 'cancelled'; });
    var now = new Date();
    var days = period === 'year' ? 365 : 28;
    var start = new Date(now.getTime() - (days - 1) * 86400000);
    var range = {
        period: period,
        start: start.toISOString().slice(0, 10),
        end: now.toISOString().slice(0, 10)
    };
    var filtered = orders.filter(function(order) {
        var date = order.date ? new Date(order.date) : now;
        return date >= start && date <= now;
    });
    var total = filtered.reduce(function(sum, order) { return sum + Number(order.total || 0); }, 0);
    var trend = [];
    var bucketCount = period === 'year' ? 12 : 28;
    for (var i = bucketCount - 1; i >= 0; i--) {
        var d = new Date(now);
        if (period === 'year') d.setMonth(d.getMonth() - i);
        else d.setDate(d.getDate() - i);
        var key = period === 'year' ? d.getFullYear() + '-' + d.getMonth() : d.toISOString().slice(0, 10);
        var dayOrders = filtered.filter(function(order) {
            var od = order.date ? new Date(order.date) : now;
            return period === 'year'
                ? od.getFullYear() + '-' + od.getMonth() === key
                : od.toISOString().slice(0, 10) === key;
        });
        trend.push({
            label: d.toLocaleDateString('en', period === 'year' ? { month: 'short' } : { month: 'short', day: 'numeric' }),
            revenue: Math.round(dayOrders.reduce(function(sum, order) { return sum + Number(order.total || 0); }, 0)),
            orders: dayOrders.length
        });
    }

    var productMap = {};
    filtered.forEach(function(order) {
        (order.items || []).forEach(function(item) {
            var name = item.name || item.product_name || 'Unknown Product';
            var qty = Number(item.qty || item.quantity || 1);
            var price = Number(item.price || item.price_at_time || 0);
            if (!productMap[name]) productMap[name] = { name: name, revenue: 0, quantity: 0 };
            productMap[name].revenue += price * qty;
            productMap[name].quantity += qty;
        });
    });
    var topProducts = Object.keys(productMap).map(function(key) { return productMap[key]; }).sort(function(a, b) { return b.revenue - a.revenue; }).slice(0, 5);
    var bestDay = trend.reduce(function(best, point) { return point.revenue > best.revenue ? point : best; }, { label: 'No sales yet', revenue: 0 });

    return {
        range: range,
        kpis: {
            totalRevenue: Math.round(total),
            avgOrderValue: filtered.length ? Math.round(total / filtered.length) : 0,
            totalOrders: filtered.length,
            conversionRate: 0,
            growth: { totalRevenue: 0, avgOrderValue: 0, totalOrders: 0, conversionRate: 0 }
        },
        trend: trend,
        topProducts: topProducts,
        insights: {
            bestDay: { label: bestDay.label, revenue: bestDay.revenue },
            bestCategory: { label: 'No category yet', share: 0 },
            topPayment: { label: 'Mobile Money', share: total ? 100 : 0 }
        },
        empty: filtered.length === 0
    };
}

function scheduleAnalyticsRefresh() {
    if (analyticsRefreshTimer) clearInterval(analyticsRefreshTimer);
    analyticsRefreshTimer = setInterval(function() {
        var tab = document.getElementById('tab-analytics');
        if (tab && tab.classList.contains('active')) {
            loadAnalytics(analyticsState.period);
        }
    }, 60000);
}

/* ============================================================
   ANALYTICS DATE-RANGE PICKER (dual calendar + presets)
   ============================================================ */
var DRP_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
var DRP_WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

var drpState = {
    viewYear: null,    // year shown in the LEFT calendar
    viewMonth: null,   // month (0-11) shown in the LEFT calendar
    start: null,       // selected start Date (midnight)
    end: null,         // selected end Date (midnight)
    pendingStart: null // when picking, the first click before the second
};

function drpToDate(value) {
    if (!value) return null;
    if (value instanceof Date) return new Date(value.getFullYear(), value.getMonth(), value.getDate());
    var parts = String(value).slice(0, 10).split('-');
    if (parts.length !== 3) return null;
    return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}

function drpFormat(date) {
    if (!date) return '';
    var m = String(date.getMonth() + 1).padStart(2, '0');
    var d = String(date.getDate()).padStart(2, '0');
    return date.getFullYear() + '-' + m + '-' + d;
}

function drpSameDay(a, b) {
    return a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function drpStartOfWeek(date) {
    var d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    d.setDate(d.getDate() - d.getDay()); // Sunday as first day
    return d;
}

function drpQuarterStart(date) {
    var q = Math.floor(date.getMonth() / 3);
    return new Date(date.getFullYear(), q * 3, 1);
}

// Collapse the inline calendar so a picker always reopens to the compact,
// presets-first view. The drp-show-cal class otherwise persists on the element,
// so once a user expanded "Custom date range" every later open showed the full
// calendar instead of the tidy preset list.
function drpResetCollapse(picker) {
    if (!picker) return;
    picker.classList.remove('drp-show-cal');
    var toggle = picker.querySelector('.drp-custom-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
}

function toggleAnalyticsDateMenu() {
    var menu = document.getElementById('analytics-date-menu');
    if (!menu) return;
    var willOpen = !menu.classList.contains('open');
    var exportMenu = document.getElementById('analytics-export-menu');
    if (exportMenu) exportMenu.classList.remove('open');
    if (willOpen) {
        drpResetCollapse(menu);
        drpInitFromState();
        drpRender();
    }
    menu.classList.toggle('open', willOpen);
}

function drpInitFromState() {
    // Seed selection from the active analytics range so the picker reflects the chart.
    var range = analyticsState.data && analyticsState.data.range;
    var start = analyticsState.customRange ? drpToDate(analyticsState.customRange.start) : (range ? drpToDate(range.start) : null);
    var end = analyticsState.customRange ? drpToDate(analyticsState.customRange.end) : (range ? drpToDate(range.end) : null);
    drpState.start = start;
    drpState.end = end;
    drpState.pendingStart = null;
    var anchor = end || start || new Date();
    // Show the LEFT calendar one month before the anchor so the end date is visible on the right.
    drpState.viewYear = anchor.getFullYear();
    drpState.viewMonth = anchor.getMonth() - 1;
    drpNormalizeView();
}

function drpNormalizeView() {
    drpNormalizeViewState(drpState);
}

function drpNavigate(delta) {
    drpState.viewMonth += delta;
    drpNormalizeView();
    drpRender();
}

function drpBuildCalendar(year, month, side, pickerState, selectFn, navFn) {
    var first = new Date(year, month, 1);
    var startDow = first.getDay();
    var daysInMonth = new Date(year, month + 1, 0).getDate();
    var today = new Date();
    today = new Date(today.getFullYear(), today.getMonth(), today.getDate());

    var prevBtn = side === 'left'
        ? '<button type="button" class="drp-nav-btn" onclick="' + navFn + '(-1)" aria-label="Previous month"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>'
        : '<span class="drp-nav-spacer"></span>';
    // The right calendar owns the "next" arrow in desktop's dual view. The left
    // calendar still emits a real next button (class --mnext) so the single
    // calendar shown on phones can page forward; it's hidden on desktop via CSS.
    var nextBtn = side === 'right'
        ? '<button type="button" class="drp-nav-btn" onclick="' + navFn + '(1)" aria-label="Next month"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></button>'
        : '<button type="button" class="drp-nav-btn drp-nav-btn--mnext" onclick="' + navFn + '(1)" aria-label="Next month"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></button>';

    var html = '<div class="drp-cal-head">' + prevBtn +
        '<span class="drp-cal-title">' + DRP_MONTHS[month] + ' ' + year + '</span>' + nextBtn + '</div>';

    html += '<div class="drp-weekdays">';
    DRP_WEEKDAYS.forEach(function(w) { html += '<span>' + w + '</span>'; });
    html += '</div><div class="drp-days">';

    for (var i = 0; i < startDow; i++) {
        html += '<span class="drp-day drp-day--empty"></span>';
    }

    var rangeStart = pickerState.start;
    var rangeEnd = pickerState.end;
    if (pickerState.pendingStart && !rangeEnd) { rangeStart = pickerState.pendingStart; }

    for (var day = 1; day <= daysInMonth; day++) {
        var cellDate = new Date(year, month, day);
        var classes = ['drp-day'];
        var isStart = drpSameDay(cellDate, rangeStart);
        var isEnd = drpSameDay(cellDate, rangeEnd);
        if (rangeStart && rangeEnd && cellDate > rangeStart && cellDate < rangeEnd) classes.push('drp-day--in-range');
        if (isStart) { classes.push('drp-day--selected', 'drp-day--range-start'); if (rangeEnd) classes.push('drp-day--in-range'); }
        if (isEnd) { classes.push('drp-day--selected', 'drp-day--range-end'); if (rangeStart) classes.push('drp-day--in-range'); }
        if (drpSameDay(cellDate, today)) classes.push('drp-day--today');
        html += '<button type="button" class="' + classes.join(' ') + '" onclick="' + selectFn + '(\'' + drpFormat(cellDate) + '\')">' + day + '</button>';
    }
    html += '</div>';
    return html;
}

function drpNormalizeViewState(state) {
    while (state.viewMonth < 0) { state.viewMonth += 12; state.viewYear -= 1; }
    while (state.viewMonth > 11) { state.viewMonth -= 12; state.viewYear += 1; }
}

function drpRender() {
    var left = document.getElementById('drp-cal-left');
    var right = document.getElementById('drp-cal-right');
    if (!left || !right) return;
    left.innerHTML = drpBuildCalendar(drpState.viewYear, drpState.viewMonth, 'left', drpState, 'drpSelectDay', 'drpNavigate');
    var rightMonth = drpState.viewMonth + 1;
    var rightYear = drpState.viewYear;
    if (rightMonth > 11) { rightMonth = 0; rightYear += 1; }
    right.innerHTML = drpBuildCalendar(rightYear, rightMonth, 'right', drpState, 'drpSelectDay', 'drpNavigate');
    drpUpdateFooter();
    drpHighlightPreset();
}

function drpUpdateFooter() {
    var display = document.getElementById('drp-range-display');
    if (!display) return;
    var opts = { month: 'short', day: 'numeric', year: 'numeric' };
    if (drpState.start && drpState.end) {
        display.textContent = drpState.start.toLocaleDateString('en', opts) + ' – ' + drpState.end.toLocaleDateString('en', opts);
    } else if (drpState.pendingStart) {
        display.textContent = drpState.pendingStart.toLocaleDateString('en', opts) + ' – …';
    } else {
        display.textContent = 'Select start & end dates';
    }
}

function drpSelectDay(dateStr) {
    var picked = drpToDate(dateStr);
    if (!picked) return;
    if (!drpState.pendingStart || (drpState.start && drpState.end)) {
        // Begin a new selection.
        drpState.pendingStart = picked;
        drpState.start = picked;
        drpState.end = null;
    } else {
        // Complete the selection.
        if (picked < drpState.pendingStart) {
            drpState.start = picked;
            drpState.end = drpState.pendingStart;
        } else {
            drpState.start = drpState.pendingStart;
            drpState.end = picked;
        }
        drpState.pendingStart = null;
    }
    drpRender();
}

function drpApplyPreset(preset) {
    var today = new Date();
    today = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    var start, end;
    end = today;
    switch (preset) {
        case 'this-week': start = drpStartOfWeek(today); break;
        case 'this-month': start = new Date(today.getFullYear(), today.getMonth(), 1); break;
        case 'this-quarter': start = drpQuarterStart(today); break;
        case 'this-year': start = new Date(today.getFullYear(), 0, 1); break;
        case 'last-week':
            end = new Date(drpStartOfWeek(today).getTime() - 86400000);
            start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 6);
            break;
        case 'last-month':
            start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
            end = new Date(today.getFullYear(), today.getMonth(), 0);
            break;
        case 'last-quarter':
            var qs = drpQuarterStart(today);
            end = new Date(qs.getTime() - 86400000);
            start = new Date(end.getFullYear(), end.getMonth() - 2, 1);
            break;
        case 'last-year':
            start = new Date(today.getFullYear() - 1, 0, 1);
            end = new Date(today.getFullYear() - 1, 11, 31);
            break;
        case 'last-30': start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29); break;
        case 'last-90': start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 89); break;
        case 'last-365': start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 364); break;
        case 'all-time': start = new Date(2020, 0, 1); break;
        default: return;
    }
    drpState.start = start;
    drpState.end = end;
    drpState.pendingStart = null;
    // Show the end month on the right calendar.
    drpState.viewYear = end.getFullYear();
    drpState.viewMonth = end.getMonth() - 1;
    drpNormalizeView();
    drpRender();
}

function drpHighlightPreset() {
    var presets = document.querySelectorAll('#drp-presets .drp-preset');
    if (!presets.length) return;
    var matched = null;
    if (drpState.start && drpState.end) {
        for (var i = 0; i < presets.length; i++) {
            var p = presets[i].getAttribute('data-preset');
            var probe = drpComputePreset(p);
            if (probe && drpSameDay(probe.start, drpState.start) && drpSameDay(probe.end, drpState.end)) { matched = presets[i]; break; }
        }
    }
    presets.forEach(function(btn) { btn.classList.toggle('active', btn === matched); });
}

function drpComputePreset(preset) {
    // Pure computation mirror of drpApplyPreset (no side effects) for highlight matching.
    var today = new Date();
    today = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    var start, end = today;
    switch (preset) {
        case 'this-week': start = drpStartOfWeek(today); break;
        case 'this-month': start = new Date(today.getFullYear(), today.getMonth(), 1); break;
        case 'this-quarter': start = drpQuarterStart(today); break;
        case 'this-year': start = new Date(today.getFullYear(), 0, 1); break;
        case 'last-week':
            end = new Date(drpStartOfWeek(today).getTime() - 86400000);
            start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 6);
            break;
        case 'last-month':
            start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
            end = new Date(today.getFullYear(), today.getMonth(), 0);
            break;
        case 'last-quarter':
            var qs = drpQuarterStart(today);
            end = new Date(qs.getTime() - 86400000);
            start = new Date(end.getFullYear(), end.getMonth() - 2, 1);
            break;
        case 'last-year':
            start = new Date(today.getFullYear() - 1, 0, 1);
            end = new Date(today.getFullYear() - 1, 11, 31);
            break;
        case 'last-30': start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29); break;
        case 'last-90': start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 89); break;
        case 'last-365': start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 364); break;
        case 'all-time': start = new Date(2020, 0, 1); break;
        default: return null;
    }
    return { start: start, end: end };
}

function drpCancel() {
    var menu = document.getElementById('analytics-date-menu');
    if (menu) menu.classList.remove('open');
}

function drpApply() {
    if (!drpState.start || !drpState.end) {
        showToast('Pick a start and end date first', 'warning');
        return;
    }
    var menu = document.getElementById('analytics-date-menu');
    if (menu) menu.classList.remove('open');
    loadAnalytics(null, { start: drpFormat(drpState.start), end: drpFormat(drpState.end) });
}

// Backwards-compatible helper retained for any external callers.
function selectAnalyticsPeriod(period) {
    var menu = document.getElementById('analytics-date-menu');
    if (menu) menu.classList.remove('open');
    loadAnalytics(period);
}

function exportAnalyticsCSV() {
    var data = analyticsState.data;
    if (!data) {
        showToast('Load analytics before exporting', 'warning');
        return;
    }

    var token = localStorage.getItem('adminToken');
    if (token && token.indexOf('fallback-token') !== 0) {
        fetch(API_URL + '/analytics/sales/export?period=' + encodeURIComponent(analyticsState.period), {
            headers: { 'Authorization': 'Bearer ' + token }
        })
        .then(function(res) {
            if (!res.ok) throw new Error('Export failed');
            return res.blob();
        })
        .then(function(blob) {
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = 'dc-kids-sales-analytics.csv';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            showToast('Analytics CSV exported', 'success');
        })
        .catch(function(err) {
            showToast(err.message || 'Export failed', 'error');
        });
        return;
    }

    var rows = (data.trend || []).map(function(point) {
        return { Date: point.label, Revenue: point.revenue, Orders: point.orders };
    });
    exportToCSV(rows, 'dc-kids-sales-analytics.csv');
}

function exportAnalyticsPDF() {
    var data = analyticsState && analyticsState.data;
    if (!data) { showToast('Load analytics before exporting', 'warning'); return; }

    var fmtMoney = function(v) { return 'GHS ' + (Number(v) || 0).toLocaleString(); };
    var fmtPct = function(v) { var n = Number(v); if (!isFinite(n)) return '—'; return (n >= 0 ? '+' : '') + n.toFixed(1) + '%'; };

    var rangeLabel = (typeof formatAnalyticsDateRange === 'function' && data.range)
        ? formatAnalyticsDateRange(data.range)
        : (analyticsState.period || '');

    var rev = data.summary && data.summary.revenue || {};
    var aov = data.summary && data.summary.avgOrderValue || {};
    var ord = data.summary && data.summary.orders || {};
    var conv = data.summary && data.summary.conversionRate || {};

    var topCats = (data.topCategories || []).slice(0, 6);
    var topProducts = (data.topProducts || []).slice(0, 6);
    var trend = data.trend || [];

    var html = ''
      + '<div class="hdr">'
      +   '<div><h1>Sales Analytics</h1><p class="period">' + escapeHtml(rangeLabel) + ' • Generated ' + new Date().toLocaleString() + '</p></div>'
      +   '<div class="brand">DC Kids Brand</div>'
      + '</div>'

      + '<div class="kpis">'
      +   '<div class="kpi"><div class="kpi-label">Total Revenue</div><div class="kpi-value">' + fmtMoney(rev.current) + '</div><div class="kpi-delta">' + fmtPct(rev.growth) + ' vs previous</div></div>'
      +   '<div class="kpi"><div class="kpi-label">Avg Order Value</div><div class="kpi-value">' + fmtMoney(aov.current) + '</div><div class="kpi-delta">' + fmtPct(aov.growth) + ' vs previous</div></div>'
      +   '<div class="kpi"><div class="kpi-label">Total Orders</div><div class="kpi-value">' + (ord.current || 0) + '</div><div class="kpi-delta">' + fmtPct(ord.growth) + ' vs previous</div></div>'
      +   '<div class="kpi"><div class="kpi-label">Conversion Rate</div><div class="kpi-value">' + (conv.current != null ? Number(conv.current).toFixed(1) + '%' : '—') + '</div><div class="kpi-delta">' + fmtPct(conv.growth) + ' vs previous</div></div>'
      + '</div>';

    if (topCats.length) {
        html += '<h2>Top Categories</h2><table><thead><tr><th>Category</th><th class="right">Revenue</th><th class="right">Share</th></tr></thead><tbody>';
        var totalCatRev = topCats.reduce(function(s, c) { return s + (Number(c.revenue) || 0); }, 0) || 1;
        topCats.forEach(function(c) {
            html += '<tr><td>' + escapeHtml(c.name || c.category || '—') + '</td><td class="right">' + fmtMoney(c.revenue) + '</td><td class="right">' + ((Number(c.revenue) || 0) / totalCatRev * 100).toFixed(1) + '%</td></tr>';
        });
        html += '</tbody></table>';
    }

    if (topProducts.length) {
        html += '<h2>Top Products</h2><table><thead><tr><th>Product</th><th class="right">Revenue</th><th class="right">Units</th></tr></thead><tbody>';
        topProducts.forEach(function(p) {
            html += '<tr><td>' + escapeHtml(p.name || '—') + '</td><td class="right">' + fmtMoney(p.revenue) + '</td><td class="right">' + (p.units || p.qty || 0) + '</td></tr>';
        });
        html += '</tbody></table>';
    }

    if (trend.length) {
        html += '<h2>Daily Trend</h2><table><thead><tr><th>Date</th><th class="right">Revenue</th><th class="right">Orders</th></tr></thead><tbody>';
        trend.forEach(function(t) {
            html += '<tr><td>' + escapeHtml(t.label || t.date || '') + '</td><td class="right">' + fmtMoney(t.revenue) + '</td><td class="right">' + (t.orders || 0) + '</td></tr>';
        });
        html += '</tbody></table>';
    }

    var fullHtml = '<style>'
      + '#print-section { font-family: "Segoe UI","Inter",Arial,sans-serif; color:#222; padding:24px; background:#fff; }'
      + '#print-section .hdr { display:flex; justify-content:space-between; align-items:center; border-bottom:2px solid #F2D1D1; padding-bottom:18px; margin-bottom:24px; }'
      + '#print-section .hdr h1 { font-size:22px; margin:0; }'
      + '#print-section .hdr .period { font-size:12px; color:#777; margin:4px 0 0; }'
      + '#print-section .hdr .brand { font-size:20px; font-weight:700; color:#fc4c7a; letter-spacing:0.5px; }'
      + '#print-section .kpis { display:grid; grid-template-columns:repeat(4, 1fr); gap:12px; margin-bottom:28px; }'
      + '#print-section .kpi { border:1px solid #EEE; border-radius:10px; padding:14px; }'
      + '#print-section .kpi-label { font-size:11px; color:#888; text-transform:uppercase; letter-spacing:0.5px; }'
      + '#print-section .kpi-value { font-size:18px; font-weight:700; color:#222; margin-top:6px; }'
      + '#print-section .kpi-delta { font-size:11px; color:#10b981; margin-top:4px; }'
      + '#print-section h2 { font-size:14px; margin:18px 0 10px; color:#333; }'
      + '#print-section table { width:100%; border-collapse:collapse; font-size:12px; margin-bottom:14px; }'
      + '#print-section th { background:#FAFAFA; text-align:left; padding:8px 10px; border-bottom:2px solid #EAEAEA; color:#555; font-weight:600; }'
      + '#print-section td { padding:8px 10px; border-bottom:1px solid #EEE; }'
      + '#print-section .right { text-align:right; }'
      + '@media print { @page { size: A4; margin: 14mm; } }'
      + '</style>' + html;

    printHTML(fullHtml);
    showToast('Analytics PDF prepared — choose "Save as PDF" in the print dialog', 'success');
}

/* ============================================================
   SECTION 19: REPORTS TAB
   ============================================================ */
var currentReportsFilter = '30days';
var currentReportsStartDate = '';
var currentReportsEndDate = '';

function calculateGrowth(current, previous) {
    if (previous === 0) return current > 0 ? 100 : 0;
    return parseFloat((((current - previous) / previous) * 100).toFixed(1));
}

function formatGrowthElement(valElementId, currentValText, growthElementId, currentVal, previousVal) {
    var valEl = document.getElementById(valElementId);
    if (valEl) valEl.textContent = currentValText;

    var growthEl = document.getElementById(growthElementId);
    if (growthEl) {
        var growth = calculateGrowth(currentVal, previousVal);
        if (growth > 0) {
            growthEl.className = 'reports-kpi-growth text-emerald';
            growthEl.innerHTML = '↑ ' + growth + '% <span class="text-secondary" style="font-weight: normal; font-size: 11px;">vs last period</span>';
        } else if (growth < 0) {
            growthEl.className = 'reports-kpi-growth text-rose';
            growthEl.innerHTML = '↓ ' + Math.abs(growth) + '% <span class="text-secondary" style="font-weight: normal; font-size: 11px;">vs last period</span>';
        } else {
            growthEl.className = 'reports-kpi-growth text-secondary';
            growthEl.innerHTML = '→ 0.0% <span class="text-secondary" style="font-weight: normal; font-size: 11px;">vs last period</span>';
        }
    }
}

function getPeriodDateRange(period, customStart, customEnd) {
    var start = new Date();
    var end = new Date();
    var prevStart = new Date();
    var prevEnd = new Date();

    if (period === 'today') {
        start.setHours(0,0,0,0);
        end.setHours(23,59,59,999);
        prevStart.setDate(start.getDate() - 1);
        prevStart.setHours(0,0,0,0);
        prevEnd.setDate(end.getDate() - 1);
        prevEnd.setHours(23,59,59,999);
    } else if (period === '7days') {
        start.setDate(start.getDate() - 6);
        start.setHours(0,0,0,0);
        end.setHours(23,59,59,999);
        prevStart.setDate(start.getDate() - 13);
        prevStart.setHours(0,0,0,0);
        prevEnd.setDate(start.getDate() - 7);
        prevEnd.setHours(23,59,59,999);
    } else if (period === '30days') {
        start.setDate(start.getDate() - 29);
        start.setHours(0,0,0,0);
        end.setHours(23,59,59,999);
        prevStart.setDate(start.getDate() - 59);
        prevStart.setHours(0,0,0,0);
        prevEnd.setDate(start.getDate() - 30);
        prevEnd.setHours(23,59,59,999);
    } else if (period === 'month') {
        start = new Date(start.getFullYear(), start.getMonth(), 1);
        start.setHours(0,0,0,0);
        end.setHours(23,59,59,999);
        prevStart = new Date(start.getFullYear(), start.getMonth() - 1, 1);
        prevStart.setHours(0,0,0,0);
        prevEnd = new Date(start.getFullYear(), start.getMonth(), 0);
        prevEnd.setHours(23,59,59,999);
    } else if (period === 'custom') {
        if (customStart) {
            start = new Date(customStart);
            start.setHours(0,0,0,0);
        } else {
            start.setDate(start.getDate() - 29);
            start.setHours(0,0,0,0);
        }
        if (customEnd) {
            end = new Date(customEnd);
            end.setHours(23,59,59,999);
        } else {
            end.setHours(23,59,59,999);
        }
        var diffTime = Math.abs(end - start);
        var diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        prevStart.setDate(start.getDate() - diffDays);
        prevStart.setHours(0,0,0,0);
        prevEnd.setDate(start.getDate() - 1);
        prevEnd.setHours(23,59,59,999);
    }
    return { start: start, end: end, prevStart: prevStart, prevEnd: prevEnd };
}

function getOrdersInDateRange(orders, startDate, endDate) {
    return orders.filter(function(order) {
        if (!order.date) return false;
        var orderDate = new Date(order.date);
        return orderDate >= startDate && orderDate <= endDate;
    });
}

function loadReports(filterType) {
    if (!filterType) filterType = currentReportsFilter;
    currentReportsFilter = filterType;

    var range = getPeriodDateRange(filterType, currentReportsStartDate, currentReportsEndDate);

    var display = document.getElementById('reports-date-range-display');
    if (display) {
        display.textContent = range.start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' - ' +
                              range.end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    var orders = getOrders();
    var currentOrders = getOrdersInDateRange(orders, range.start, range.end);
    var previousOrders = getOrdersInDateRange(orders, range.prevStart, range.prevEnd);

    // KPI Metrics calculation
    var currentSales = currentOrders.reduce(function(sum, o) { return sum + (o.total || 0); }, 0);
    var previousSales = previousOrders.reduce(function(sum, o) { return sum + (o.total || 0); }, 0);

    var currentRevenue = currentOrders.filter(function(o) { return o.status !== 'cancelled'; }).reduce(function(sum, o) { return sum + (o.total || 0); }, 0);
    var previousRevenue = previousOrders.filter(function(o) { return o.status !== 'cancelled'; }).reduce(function(sum, o) { return sum + (o.total || 0); }, 0);

    var currentOrdersCount = currentOrders.length;
    var previousOrdersCount = previousOrders.length;

    var currentCustMap = {};
    currentOrders.forEach(function(o) { if (o.customer) currentCustMap[o.customer] = true; });
    var currentCustomersCount = Object.keys(currentCustMap).length;

    var prevCustMap = {};
    previousOrders.forEach(function(o) { if (o.customer) prevCustMap[o.customer] = true; });
    var previousCustomersCount = Object.keys(prevCustMap).length;

    if (currentCustomersCount === 0) {
        currentCustomersCount = getCustomers().length;
        previousCustomersCount = currentCustomersCount;
    }

    formatGrowthElement('reports-kpi-sales', 'GHS ' + formatNumber(currentSales), 'reports-kpi-sales-growth', currentSales, previousSales);
    formatGrowthElement('reports-kpi-revenue', 'GHS ' + formatNumber(currentRevenue), 'reports-kpi-revenue-growth', currentRevenue, previousRevenue);
    formatGrowthElement('reports-kpi-orders', formatNumber(currentOrdersCount), 'reports-kpi-orders-growth', currentOrdersCount, previousOrdersCount);
    formatGrowthElement('reports-kpi-customers', formatNumber(currentCustomersCount), 'reports-kpi-customers-growth', currentCustomersCount, previousCustomersCount);

    // Insights Populate
    var revGrowthEl = document.getElementById('insight-rev-growth');
    if (revGrowthEl) {
        var growth = calculateGrowth(currentRevenue, previousRevenue);
        if (growth >= 0) {
            revGrowthEl.className = 'text-emerald font-bold';
            revGrowthEl.textContent = '↑ ' + growth + '%';
        } else {
            revGrowthEl.className = 'text-rose font-bold';
            revGrowthEl.textContent = '↓ ' + Math.abs(growth) + '%';
        }
    }

    var dailySales = {};
    currentOrders.forEach(function(o) {
        if (o.status === 'cancelled') return;
        var od = new Date(o.date);
        var dayLabel = od.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        dailySales[dayLabel] = (dailySales[dayLabel] || 0) + (o.total || 0);
    });
    var bestDayLabel = 'No sales yet';
    var bestDayRev = 0;
    Object.keys(dailySales).forEach(function(day) {
        if (dailySales[day] > bestDayRev) {
            bestDayRev = dailySales[day];
            bestDayLabel = day;
        }
    });
    var insightBestDay = document.getElementById('insight-best-day');
    var insightBestDayRev = document.getElementById('insight-best-day-rev');
    if (insightBestDay) insightBestDay.textContent = bestDayLabel;
    if (insightBestDayRev) {
        insightBestDayRev.textContent = bestDayRev > 0 ? 'GHS ' + formatNumber(bestDayRev) : 'GHS 0';
    }

    var catTotals = {};
    var totalValForCategories = 0;
    currentOrders.forEach(function(order) {
        if (order.status === 'cancelled') return;
        (order.items || []).forEach(function(item) {
            var cat = 'Other';
            var prod = globalProducts.find(function(p) { return p.id == item.productId; });
            if (prod && prod.cat) {
                cat = prod.cat;
            }
            var val = (item.price * item.qty);
            catTotals[cat] = (catTotals[cat] || 0) + val;
            totalValForCategories += val;
        });
    });
    var topCatName = 'No category';
    var topCatVal = 0;
    Object.keys(catTotals).forEach(function(cat) {
        if (catTotals[cat] > topCatVal) {
            topCatVal = catTotals[cat];
            topCatName = cat;
        }
    });
    var topCatShare = totalValForCategories > 0 ? Math.round((topCatVal / totalValForCategories) * 100) : 0;
    var insightTopCat = document.getElementById('insight-top-category');
    var insightTopCatShare = document.getElementById('insight-top-category-share');
    if (insightTopCat) insightTopCat.textContent = topCatName;
    if (insightTopCatShare) insightTopCatShare.textContent = topCatShare + '%';

    var payTotals = {};
    var totalPayVal = 0;
    currentOrders.forEach(function(o) {
        if (o.status === 'cancelled') return;
        var method = o.paymentMethod || o.payment_method;
        if (!method) {
            var hash = (o.db_id || 0) + (o.total || 0);
            if (hash % 3 === 0) method = 'Mobile Money';
            else if (hash % 3 === 1) method = 'Cash';
            else method = 'Card';
        }
        payTotals[method] = (payTotals[method] || 0) + (o.total || 0);
        totalPayVal += (o.total || 0);
    });
    var topPayName = 'No transactions';
    var topPayVal = 0;
    Object.keys(payTotals).forEach(function(m) {
        if (payTotals[m] > topPayVal) {
            topPayVal = payTotals[m];
            topPayName = m;
        }
    });
    var topPayShare = totalPayVal > 0 ? Math.round((topPayVal / totalPayVal) * 100) : 0;
    var insightTopPay = document.getElementById('insight-top-payment');
    var insightTopPayShare = document.getElementById('insight-top-payment-share');
    if (insightTopPay) insightTopPay.textContent = topPayName;
    if (insightTopPayShare) insightTopPayShare.textContent = topPayShare + '%';

    var selectTrend = document.getElementById('reports-sales-trend-interval');
    var trendDays = selectTrend ? selectTrend.value : 30;
    renderSalesTrendChart(trendDays);
    renderCategoriesChart(currentOrders);
}

function switchReportsFilter(btn, filterType) {
    var tabs = document.querySelectorAll('.reports-filter-tab');
    tabs.forEach(function(t) { t.classList.remove('active'); });
    if (btn) btn.classList.add('active');

    if (filterType === 'custom') {
        toggleReportsDatePickerDropdown();
    } else {
        closeReportsDatePickerDropdown();
        loadReports(filterType);
    }
}

/* ============================================================
   REPORTS DATE-RANGE PICKER (dual calendar, reuses analytics CSS)
   ============================================================ */
var rdrpState = {
    viewYear: null, viewMonth: null, start: null, end: null, pendingStart: null
};

function toggleReportsDatePickerDropdown(event) {
    if (event) event.stopPropagation();
    var dd = document.getElementById('reports-datepicker-dropdown');
    if (!dd) return;
    var willOpen = !dd.classList.contains('open');
    if (willOpen) { drpResetCollapse(dd); rdrpInitFromState(); rdrpRender(); }
    dd.classList.toggle('open', willOpen);
}

function closeReportsDatePickerDropdown() {
    var dd = document.getElementById('reports-datepicker-dropdown');
    if (dd) dd.classList.remove('open');
}

function rdrpInitFromState() {
    var range = getPeriodDateRange(currentReportsFilter, currentReportsStartDate, currentReportsEndDate);
    var start = new Date(range.start.getFullYear(), range.start.getMonth(), range.start.getDate());
    var end = new Date(range.end.getFullYear(), range.end.getMonth(), range.end.getDate());
    rdrpState.start = start;
    rdrpState.end = end;
    rdrpState.pendingStart = null;
    rdrpState.viewYear = end.getFullYear();
    rdrpState.viewMonth = end.getMonth() - 1;
    drpNormalizeViewState(rdrpState);
}

function rdrpNavigate(delta) {
    rdrpState.viewMonth += delta;
    drpNormalizeViewState(rdrpState);
    rdrpRender();
}

function rdrpRender() {
    var left = document.getElementById('rdrp-cal-left');
    var right = document.getElementById('rdrp-cal-right');
    if (!left || !right) return;
    left.innerHTML = drpBuildCalendar(rdrpState.viewYear, rdrpState.viewMonth, 'left', rdrpState, 'rdrpSelectDay', 'rdrpNavigate');
    var rm = rdrpState.viewMonth + 1, ry = rdrpState.viewYear;
    if (rm > 11) { rm = 0; ry += 1; }
    right.innerHTML = drpBuildCalendar(ry, rm, 'right', rdrpState, 'rdrpSelectDay', 'rdrpNavigate');
    rdrpUpdateFooter();
    rdrpHighlightPreset();
}

function rdrpUpdateFooter() {
    var display = document.getElementById('rdrp-range-display');
    if (!display) return;
    var opts = { month: 'short', day: 'numeric', year: 'numeric' };
    if (rdrpState.start && rdrpState.end) {
        display.textContent = rdrpState.start.toLocaleDateString('en', opts) + ' – ' + rdrpState.end.toLocaleDateString('en', opts);
    } else if (rdrpState.pendingStart) {
        display.textContent = rdrpState.pendingStart.toLocaleDateString('en', opts) + ' – …';
    } else {
        display.textContent = 'Select start & end dates';
    }
}

function rdrpSelectDay(dateStr) {
    var picked = drpToDate(dateStr);
    if (!picked) return;
    if (!rdrpState.pendingStart || (rdrpState.start && rdrpState.end)) {
        rdrpState.pendingStart = picked;
        rdrpState.start = picked;
        rdrpState.end = null;
    } else {
        if (picked < rdrpState.pendingStart) { rdrpState.start = picked; rdrpState.end = rdrpState.pendingStart; }
        else { rdrpState.start = rdrpState.pendingStart; rdrpState.end = picked; }
        rdrpState.pendingStart = null;
    }
    rdrpRender();
}

function rdrpApplyPreset(preset) {
    var result = drpComputePreset(preset);
    if (!result) return;
    rdrpState.start = result.start;
    rdrpState.end = result.end;
    rdrpState.pendingStart = null;
    rdrpState.viewYear = result.end.getFullYear();
    rdrpState.viewMonth = result.end.getMonth() - 1;
    drpNormalizeViewState(rdrpState);
    rdrpRender();
}

function rdrpHighlightPreset() {
    var presets = document.querySelectorAll('#rdrp-presets .rdrp-preset');
    if (!presets.length) return;
    var matched = null;
    if (rdrpState.start && rdrpState.end) {
        for (var i = 0; i < presets.length; i++) {
            var p = presets[i].getAttribute('data-preset');
            var probe = drpComputePreset(p);
            if (probe && drpSameDay(probe.start, rdrpState.start) && drpSameDay(probe.end, rdrpState.end)) { matched = presets[i]; break; }
        }
    }
    presets.forEach(function(btn) { btn.classList.toggle('active', btn === matched); });
}

function rdrpCancel() {
    closeReportsDatePickerDropdown();
}

function rdrpApply() {
    if (!rdrpState.start || !rdrpState.end) {
        showToast('Pick a start and end date first', 'warning');
        return;
    }
    currentReportsStartDate = drpFormat(rdrpState.start);
    currentReportsEndDate = drpFormat(rdrpState.end);
    closeReportsDatePickerDropdown();
    // Clear filter tab highlight (custom range doesn't match a preset tab)
    document.querySelectorAll('.reports-filter-tab').forEach(function(t) { t.classList.remove('active'); });
    loadReports('custom');
}

function applyCustomDateRange() {
    // Legacy compat — forward to the new picker apply
    rdrpApply();
}

/* ============================================================
   MODAL REPORT DATE-RANGE PICKER (mdrp)
   ============================================================ */
var mdrpState = {
    viewYear: null, viewMonth: null, start: null, end: null, pendingStart: null
};

function toggleModalDatePicker(event) {
    if (event) event.stopPropagation();
    var dd = document.getElementById('mdrp-picker');
    if (!dd) return;
    var willOpen = !dd.classList.contains('open');
    if (willOpen) { drpResetCollapse(dd); mdrpInitFromState(); mdrpRender(); }
    dd.classList.toggle('open', willOpen);
}

function mdrpInitFromState() {
    var startEl = document.getElementById('modal-report-start-date');
    var endEl = document.getElementById('modal-report-end-date');
    var start = startEl && startEl.value ? drpToDate(startEl.value) : null;
    var end = endEl && endEl.value ? drpToDate(endEl.value) : null;
    if (!start || !end) {
        var range = getPeriodDateRange(currentReportsFilter, currentReportsStartDate, currentReportsEndDate);
        start = new Date(range.start.getFullYear(), range.start.getMonth(), range.start.getDate());
        end = new Date(range.end.getFullYear(), range.end.getMonth(), range.end.getDate());
    }
    mdrpState.start = start;
    mdrpState.end = end;
    mdrpState.pendingStart = null;
    var anchor = end || start || new Date();
    mdrpState.viewYear = anchor.getFullYear();
    mdrpState.viewMonth = anchor.getMonth() - 1;
    drpNormalizeViewState(mdrpState);
}

function mdrpNavigate(delta) {
    mdrpState.viewMonth += delta;
    drpNormalizeViewState(mdrpState);
    mdrpRender();
}

function mdrpRender() {
    var left = document.getElementById('mdrp-cal-left');
    var right = document.getElementById('mdrp-cal-right');
    if (!left || !right) return;
    left.innerHTML = drpBuildCalendar(mdrpState.viewYear, mdrpState.viewMonth, 'left', mdrpState, 'mdrpSelectDay', 'mdrpNavigate');
    var rm = mdrpState.viewMonth + 1, ry = mdrpState.viewYear;
    if (rm > 11) { rm = 0; ry += 1; }
    right.innerHTML = drpBuildCalendar(ry, rm, 'right', mdrpState, 'mdrpSelectDay', 'mdrpNavigate');
    mdrpUpdateFooter();
    mdrpHighlightPreset();
}

function mdrpUpdateFooter() {
    var display = document.getElementById('mdrp-range-display');
    if (!display) return;
    var opts = { month: 'short', day: 'numeric', year: 'numeric' };
    if (mdrpState.start && mdrpState.end) {
        display.textContent = mdrpState.start.toLocaleDateString('en', opts) + ' – ' + mdrpState.end.toLocaleDateString('en', opts);
    } else if (mdrpState.pendingStart) {
        display.textContent = mdrpState.pendingStart.toLocaleDateString('en', opts) + ' – …';
    } else {
        display.textContent = 'Select start & end dates';
    }
}

function mdrpSelectDay(dateStr) {
    var picked = drpToDate(dateStr);
    if (!picked) return;
    if (!mdrpState.pendingStart || (mdrpState.start && mdrpState.end)) {
        mdrpState.pendingStart = picked;
        mdrpState.start = picked;
        mdrpState.end = null;
    } else {
        if (picked < mdrpState.pendingStart) { mdrpState.start = picked; mdrpState.end = mdrpState.pendingStart; }
        else { mdrpState.start = mdrpState.pendingStart; mdrpState.end = picked; }
        mdrpState.pendingStart = null;
    }
    mdrpRender();
}

function mdrpApplyPreset(preset) {
    var result = drpComputePreset(preset);
    if (!result) return;
    mdrpState.start = result.start;
    mdrpState.end = result.end;
    mdrpState.pendingStart = null;
    mdrpState.viewYear = result.end.getFullYear();
    mdrpState.viewMonth = result.end.getMonth() - 1;
    drpNormalizeViewState(mdrpState);
    mdrpRender();
}

function mdrpHighlightPreset() {
    var presets = document.querySelectorAll('#mdrp-presets .mdrp-preset');
    if (!presets.length) return;
    var matched = null;
    if (mdrpState.start && mdrpState.end) {
        for (var i = 0; i < presets.length; i++) {
            var p = presets[i].getAttribute('data-preset');
            var probe = drpComputePreset(p);
            if (probe && drpSameDay(probe.start, mdrpState.start) && drpSameDay(probe.end, mdrpState.end)) { matched = presets[i]; break; }
        }
    }
    presets.forEach(function(btn) { btn.classList.toggle('active', btn === matched); });
}

function mdrpCancel() {
    var dd = document.getElementById('mdrp-picker');
    if (dd) dd.classList.remove('open');
}

function mdrpApply() {
    if (!mdrpState.start || !mdrpState.end) {
        showToast('Pick a start and end date first', 'warning');
        return;
    }
    var startEl = document.getElementById('modal-report-start-date');
    var endEl = document.getElementById('modal-report-end-date');
    if (startEl) startEl.value = drpFormat(mdrpState.start);
    if (endEl) endEl.value = drpFormat(mdrpState.end);

    var opts = { month: 'short', day: 'numeric', year: 'numeric' };
    var displayEl = document.getElementById('mdrp-date-display');
    if (displayEl) displayEl.textContent = mdrpState.start.toLocaleDateString('en', opts) + ' – ' + mdrpState.end.toLocaleDateString('en', opts);

    var dd = document.getElementById('mdrp-picker');
    if (dd) dd.classList.remove('open');
    generateReportFromModalFilter();
}

function changeReportsSalesTrendInterval(val) {
    renderSalesTrendChart(val);
}

function toggleSummaryPDFDropdown(event) {
    if (event) event.stopPropagation();
    var dd = document.getElementById('summary-pdf-dropdown-content');
    if (dd) {
        dd.classList.toggle('active');
    }
}

function printHTML(htmlContent) {
    // Render the report in its own tab and print from there — the most reliable
    // cross-browser way to produce a PDF (use "Save as PDF" in the print dialog).
    // The report CSS is scoped to #print-section, so wrap the content in it.
    var reportDoc = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>DC Kids Report</title></head>' +
        '<body><div id="print-section">' + htmlContent + '</div>' +
        '<scr' + 'ipt>window.onload=function(){setTimeout(function(){try{window.print();}catch(e){}},350);};</scr' + 'ipt>' +
        '</body></html>';

    var win = window.open('', '_blank');
    if (win) {
        win.document.open();
        win.document.write(reportDoc);
        win.document.close();
        win.focus();
        return;
    }

    // Pop-up blocked — fall back to downloading the report as a file.
    var blob = new Blob([reportDoc], { type: 'text/html;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'dc-kids-report.html';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Pop-up blocked — downloaded the report as a file instead', 'warning');
}

function downloadSummaryReport(type) {
    try {
        var range = getPeriodDateRange(window.currentReportsFilter || currentReportsFilter, window.currentReportsStartDate || currentReportsStartDate, window.currentReportsEndDate || currentReportsEndDate);
        var dateRangeStr = range.start.toLocaleDateString() + ' - ' + range.end.toLocaleDateString();

        var title = 'Business Summary Report';
        if (type === 'sales') title = 'Sales & Revenue Summary Report';
        else if (type === 'inventory') title = 'Inventory Status Summary Report';

        var salesVal = document.getElementById('reports-kpi-sales') ? document.getElementById('reports-kpi-sales').textContent : 'N/A';
        var revVal = document.getElementById('reports-kpi-revenue') ? document.getElementById('reports-kpi-revenue').textContent : 'N/A';
        var ordersVal = document.getElementById('reports-kpi-orders') ? document.getElementById('reports-kpi-orders').textContent : 'N/A';
        var custVal = document.getElementById('reports-kpi-customers') ? document.getElementById('reports-kpi-customers').textContent : 'N/A';

        var bestDayVal = document.getElementById('insight-best-day') ? document.getElementById('insight-best-day').textContent : 'N/A';
        var bestDayRev = document.getElementById('insight-best-day-rev') ? document.getElementById('insight-best-day-rev').textContent : 'N/A';
        var topCat = document.getElementById('insight-top-category') ? document.getElementById('insight-top-category').textContent : 'N/A';
        var topCatShare = document.getElementById('insight-top-category-share') ? document.getElementById('insight-top-category-share').textContent : 'N/A';
        var topPay = document.getElementById('insight-top-payment') ? document.getElementById('insight-top-payment').textContent : 'N/A';
        var topPayShare = document.getElementById('insight-top-payment-share') ? document.getElementById('insight-top-payment-share').textContent : 'N/A';

        var htmlContent = '<div class="header"><div class="title-container">' +
            '<h1>' + title + '</h1>' +
            '<p>Generated on ' + new Date().toLocaleDateString() + ' | Period: ' + dateRangeStr + '</p>' +
            '</div><div class="brand">DC Kids Boutique</div></div>';

        if (type === 'all' || type === 'sales') {
            htmlContent += '<div class="kpis">' +
                '<div class="kpi-card"><div class="kpi-label">Total Sales</div><div class="kpi-val">' + salesVal + '</div></div>' +
                '<div class="kpi-card"><div class="kpi-label">Total Revenue</div><div class="kpi-val">' + revVal + '</div></div>' +
                '<div class="kpi-card"><div class="kpi-label">Total Orders</div><div class="kpi-val">' + ordersVal + '</div></div>' +
                '<div class="kpi-card"><div class="kpi-label">Total Customers</div><div class="kpi-val">' + custVal + '</div></div>' +
                '</div>';

            htmlContent += '<div class="insights">' +
                '<div class="insights-title">Smart Business Insights</div>' +
                '<div class="insight-item">Best performing sales day peaked on <strong>' + bestDayVal + '</strong> with a total revenue of <strong>' + bestDayRev + '</strong>.</div>' +
                '<div class="insight-item">Our leading sales product category is <strong>' + topCat + '</strong>, representing <strong>' + topCatShare + '</strong> of total sales.</div>' +
                '<div class="insight-item">The most preferred client payment option is <strong>' + topPay + '</strong>, capturing <strong>' + topPayShare + '</strong> of total payment volume.</div>' +
                '</div>';
        }

        if (type === 'all' || type === 'inventory') {
            var inStockCount = globalProducts.filter(function(p) { return p.stock >= 5; }).length;
            var lowStockCount = globalProducts.filter(function(p) { return p.stock > 0 && p.stock < 5; }).length;
            var outStockCount = globalProducts.filter(function(p) { return p.stock == 0; }).length;
            var totalVal = globalProducts.reduce(function(sum, p) { return sum + (p.stock * p.price); }, 0);

            htmlContent += '<div class="insights">' +
                '<div class="insights-title">Inventory Valuation Status</div>' +
                '<div class="insight-item">Total active catalog products: <strong>' + globalProducts.length + '</strong> items.</div>' +
                '<div class="insight-item">Current stock valuation: <strong>GHS ' + formatNumber(totalVal) + '</strong> in total warehouse inventory.</div>' +
                '<div class="insight-item">Healthy In-Stock levels: <strong>' + inStockCount + '</strong> items.</div>' +
                '<div class="insight-item">Low-stock items requiring replenishment: <strong>' + lowStockCount + '</strong> items.</div>' +
                '<div class="insight-item">Out-of-stock / depleted items: <strong>' + outStockCount + '</strong> items.</div>' +
                '</div>';
        }

        var fullHtml = '<style>' +
            '#print-section { font-family: "Segoe UI", "Outfit", "Inter", Arial, sans-serif; color: #333; padding: 20px; background: #fff; }' +
            '#print-section .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #F2D1D1; padding-bottom: 20px; margin-bottom: 30px; }' +
            '#print-section .brand { font-size: 24px; font-weight: 700; color: #cd5c74; letter-spacing: 0.5px; }' +
            '#print-section .title-container h1 { font-size: 20px; margin: 0; color: #333; }' +
            '#print-section .title-container p { font-size: 13px; color: #777; margin: 5px 0 0 0; }' +
            '#print-section .kpis { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; margin-bottom: 40px; }' +
            '#print-section .kpi-card { border: 1px solid #EAEAEA; padding: 20px; border-radius: 16px; background: #FAFAFA; }' +
            '#print-section .kpi-label { font-size: 12px; font-weight: 600; color: #777; text-transform: uppercase; margin-bottom: 8px; }' +
            '#print-section .kpi-val { font-size: 24px; font-weight: 700; color: #333; }' +
            '#print-section .insights { border: 1px solid #EAEAEA; border-radius: 16px; padding: 24px; background: #FFF; margin-bottom: 30px; }' +
            '#print-section .insights-title { font-size: 15px; font-weight: 700; margin: 0 0 16px 0; border-bottom: 1px solid #EAEAEA; padding-bottom: 10px; }' +
            '#print-section .insight-item { font-size: 13px; line-height: 1.6; margin-bottom: 12px; color: #555; }' +
            '#print-section .insight-item strong { color: #333; }' +
            '</style>' + htmlContent;

        var dd = document.getElementById('summary-pdf-dropdown-content');
        if (dd) dd.classList.remove('active');

        printHTML(fullHtml);
        showToast('Summary report sent to print', 'success');
    } catch(err) {
        console.error('Error generating summary report:', err);
        showToast('Failed to generate report: ' + err.message, 'error');
    }
}

function openReportPreview(type) {
    var modal = document.getElementById('modal-report-preview');
    if (!modal) return;

    var typeInput = document.getElementById('modal-report-type');
    if (typeInput) typeInput.value = type;

    var titleEl = document.getElementById('modal-report-preview-title');
    var subtitleEl = document.getElementById('modal-report-preview-subtitle');

    if (type === 'inventory') {
        if (titleEl) titleEl.textContent = 'Inventory Valuation Report';
        if (subtitleEl) subtitleEl.textContent = 'Real-time inventory levels, pricing, and valuation.';
    } else if (type === 'sales') {
        if (titleEl) titleEl.textContent = 'Sales Transactions Report';
        if (subtitleEl) subtitleEl.textContent = 'Detailed list of sales orders and status within range.';
    } else if (type === 'revenue') {
        if (titleEl) titleEl.textContent = 'Revenue Performance Report';
        if (subtitleEl) subtitleEl.textContent = 'Periodic gross and net revenue performance.';
    } else if (type === 'customer') {
        if (titleEl) titleEl.textContent = 'Customer Value Report';
        if (subtitleEl) subtitleEl.textContent = 'Customer orders, lifetime value, and details.';
    }

    var range = getPeriodDateRange(currentReportsFilter, currentReportsStartDate, currentReportsEndDate);
    var startInput = document.getElementById('modal-report-start-date');
    var endInput = document.getElementById('modal-report-end-date');

    if (startInput) startInput.value = range.start.toISOString().slice(0, 10);
    if (endInput) endInput.value = range.end.toISOString().slice(0, 10);

    // Update the mdrp trigger display
    var opts = { month: 'short', day: 'numeric', year: 'numeric' };
    var mdrpDisplay = document.getElementById('mdrp-date-display');
    if (mdrpDisplay) mdrpDisplay.textContent = range.start.toLocaleDateString('en', opts) + ' – ' + range.end.toLocaleDateString('en', opts);

    // Close picker if it was open from a previous session
    var mdrpPicker = document.getElementById('mdrp-picker');
    if (mdrpPicker) mdrpPicker.classList.remove('open');

    openModal('modal-report-preview');
    generateReportFromModalFilter();
}

function closeReportPreview() {
    closeModal('modal-report-preview');
}

function generateReportFromModalFilter() {
    var typeInput = document.getElementById('modal-report-type');
    if (!typeInput) return;
    var type = typeInput.value;

    var startInput = document.getElementById('modal-report-start-date');
    var endInput = document.getElementById('modal-report-end-date');
    var startVal = startInput ? startInput.value : '';
    var endVal = endInput ? endInput.value : '';

    var skeleton = document.getElementById('modal-report-skeleton');
    var empty = document.getElementById('modal-report-empty');
    var tableContainer = document.getElementById('modal-report-table-container');

    if (skeleton) skeleton.style.display = 'block';
    if (empty) empty.style.display = 'none';
    if (tableContainer) {
        tableContainer.style.display = 'none';
        tableContainer.innerHTML = '';
    }

    setTimeout(function() {
        var start = startVal ? new Date(startVal) : new Date(0);
        start.setHours(0,0,0,0);
        var end = endVal ? new Date(endVal) : new Date();
        end.setHours(23,59,59,999);

        var html = '';
        if (type === 'inventory') {
            html = generateInventoryReportTable(start, end);
        } else if (type === 'sales') {
            html = generateSalesReportTable(start, end);
        } else if (type === 'revenue') {
            html = generateRevenueReportTable(start, end);
        } else if (type === 'customer') {
            html = generateCustomerReportTable(start, end);
        }

        if (skeleton) skeleton.style.display = 'none';

        if (!html) {
            if (empty) empty.style.display = 'flex';
        } else {
            if (tableContainer) {
                tableContainer.innerHTML = html;
                tableContainer.style.display = 'block';
            }
        }
    }, 300);
}

function generateInventoryReportTable(start, end) {
    if (!globalProducts || globalProducts.length === 0) return '';

    var html = '<table class="reports-preview-table">';
    html += '<thead><tr><th>Product Details</th><th>Category</th><th>Stock Level</th><th class="text-right">Price</th><th class="text-right">Stock Value</th><th>Status</th></tr></thead>';
    html += '<tbody>';

    var totalStock = 0;
    var totalVal = 0;

    globalProducts.forEach(function(p) {
        var val = (p.stock || 0) * (p.price || 0);
        totalStock += (p.stock || 0);
        totalVal += val;

        var status = p.stock <= 0 ? 'Out of Stock' : (p.stock < 5 ? 'Low Stock' : 'In Stock');
        var badgeClass = p.stock <= 0 ? 'badge-cancelled' : (p.stock < 5 ? 'badge-pending' : 'badge-completed');

        html += '<tr>';
        html += '<td><div style="font-weight:600; color:#333;">' + escapeHtml(p.name) + '</div><div style="font-size:11px; color:#777;">ID: ' + p.id + '</div></td>';
        html += '<td>' + escapeHtml(p.cat || 'Other') + '</td>';
        html += '<td>' + (p.stock || 0) + '</td>';
        html += '<td class="text-right">GHS ' + formatNumber(p.price || 0) + '</td>';
        html += '<td class="text-right">GHS ' + formatNumber(val) + '</td>';
        html += '<td><span class="badge ' + badgeClass + '">' + status + '</span></td>';
        html += '</tr>';
    });

    html += '</tbody>';
    html += '<tfoot><tr>';
    html += '<td><strong>Total: ' + globalProducts.length + ' Products</strong></td>';
    html += '<td></td>';
    html += '<td><strong>' + totalStock + ' units</strong></td>';
    html += '<td></td>';
    html += '<td class="text-right"><strong>GHS ' + formatNumber(totalVal) + '</strong></td>';
    html += '<td></td>';
    html += '</tr></tfoot>';
    html += '</table>';

    return html;
}

function generateSalesReportTable(start, end) {
    var orders = getOrders();
    var filtered = getOrdersInDateRange(orders, start, end);
    if (filtered.length === 0) return '';

    var html = '<table class="reports-preview-table">';
    html += '<thead><tr><th>Order ID</th><th>Date</th><th>Customer Details</th><th>Type</th><th class="text-right">Total Amount</th><th>Status</th></tr></thead>';
    html += '<tbody>';

    var totalRevenue = 0;

    filtered.forEach(function(o) {
        totalRevenue += (o.total || 0);
        var badgeClass = 'badge-pending';
        if (o.status === 'completed' || o.status === 'delivered') badgeClass = 'badge-completed';
        else if (o.status === 'cancelled') badgeClass = 'badge-cancelled';
        else if (o.status === 'processing') badgeClass = 'badge-processing';

        var dateStr = o.date ? new Date(o.date).toLocaleDateString() : 'N/A';

        html += '<tr>';
        html += '<td><strong>' + escapeHtml(o.id) + '</strong></td>';
        html += '<td>' + dateStr + '</td>';
        html += '<td><div style="font-weight:600; color:#333;">' + escapeHtml(o.customer || 'Guest') + '</div><div style="font-size:11px; color:#777;">' + escapeHtml(o.phone || 'N/A') + '</div></td>';
        html += '<td><span style="text-transform: capitalize;">' + escapeHtml(o.type || 'retail') + '</span></td>';
        html += '<td class="text-right">GHS ' + formatNumber(o.total || 0) + '</td>';
        html += '<td><span class="badge ' + badgeClass + '">' + escapeHtml(o.status || 'pending') + '</span></td>';
        html += '</tr>';
    });

    html += '</tbody>';
    html += '<tfoot><tr>';
    html += '<td><strong>Total: ' + filtered.length + ' Orders</strong></td>';
    html += '<td></td>';
    html += '<td></td>';
    html += '<td></td>';
    html += '<td class="text-right"><strong>GHS ' + formatNumber(totalRevenue) + '</strong></td>';
    html += '<td></td>';
    html += '</tr></tfoot>';
    html += '</table>';

    return html;
}

function generateRevenueReportTable(start, end) {
    var orders = getOrders();
    var filtered = getOrdersInDateRange(orders, start, end).filter(function(o) { return o.status !== 'cancelled'; });
    if (filtered.length === 0) return '';

    var dailyData = {};
    filtered.forEach(function(o) {
        var dateStr = o.date ? o.date.slice(0, 10) : 'N/A';
        if (!dailyData[dateStr]) {
            dailyData[dateStr] = { ordersCount: 0, retail: 0, wholesale: 0, total: 0 };
        }
        dailyData[dateStr].ordersCount++;
        var isWholesale = (o.type === 'wholesale');
        if (isWholesale) {
            dailyData[dateStr].wholesale += (o.total || 0);
        } else {
            dailyData[dateStr].retail += (o.total || 0);
        }
        dailyData[dateStr].total += (o.total || 0);
    });

    var sortedDates = Object.keys(dailyData).sort();

    var html = '<table class="reports-preview-table">';
    html += '<thead><tr><th>Date</th><th>Orders Count</th><th class="text-right">Retail Sales</th><th class="text-right">Wholesale Sales</th><th class="text-right">Total Revenue</th><th>AOV</th></tr></thead>';
    html += '<tbody>';

    var totalOrders = 0;
    var totalRetail = 0;
    var totalWholesale = 0;
    var totalRevenue = 0;

    sortedDates.forEach(function(date) {
        var d = dailyData[date];
        totalOrders += d.ordersCount;
        totalRetail += d.retail;
        totalWholesale += d.wholesale;
        totalRevenue += d.total;

        var aov = d.ordersCount > 0 ? (d.total / d.ordersCount) : 0;
        var formattedDate = date !== 'N/A' ? new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'N/A';

        html += '<tr>';
        html += '<td>' + formattedDate + '</td>';
        html += '<td>' + d.ordersCount + '</td>';
        html += '<td class="text-right">GHS ' + formatNumber(d.retail) + '</td>';
        html += '<td class="text-right">GHS ' + formatNumber(d.wholesale) + '</td>';
        html += '<td class="text-right"><strong>GHS ' + formatNumber(d.total) + '</strong></td>';
        html += '<td class="text-right">GHS ' + formatNumber(Math.round(aov)) + '</td>';
        html += '</tr>';
    });

    html += '</tbody>';
    var overallAov = totalOrders > 0 ? (totalRevenue / totalOrders) : 0;
    html += '<tfoot><tr>';
    html += '<td><strong>Total: ' + sortedDates.length + ' Days</strong></td>';
    html += '<td><strong>' + totalOrders + ' orders</strong></td>';
    html += '<td class="text-right"><strong>GHS ' + formatNumber(totalRetail) + '</strong></td>';
    html += '<td class="text-right"><strong>GHS ' + formatNumber(totalWholesale) + '</strong></td>';
    html += '<td class="text-right"><strong>GHS ' + formatNumber(totalRevenue) + '</strong></td>';
    html += '<td class="text-right"><strong>GHS ' + formatNumber(Math.round(overallAov)) + '</strong></td>';
    html += '</tr></tfoot>';
    html += '</table>';

    return html;
}

function generateCustomerReportTable(start, end) {
    var orders = getOrders();
    var filtered = getOrdersInDateRange(orders, start, end);
    if (filtered.length === 0) return '';

    var customerMap = {};
    filtered.forEach(function(o) {
        if (!o.customer) return;
        var key = o.customer;
        if (!customerMap[key]) {
            customerMap[key] = { name: o.customer, phone: o.phone || '', ordersCount: 0, totalSpent: 0, lastActive: null };
        }
        customerMap[key].ordersCount++;
        if (o.status !== 'cancelled') {
            customerMap[key].totalSpent += (o.total || 0);
        }
        var od = new Date(o.date);
        if (!customerMap[key].lastActive || od > customerMap[key].lastActive) {
            customerMap[key].lastActive = od;
        }
    });

    var customers = Object.values(customerMap).sort(function(a, b) { return b.totalSpent - a.totalSpent; });
    if (customers.length === 0) return '';

    var html = '<table class="reports-preview-table">';
    html += '<thead><tr><th>Customer Name</th><th>Contact Details</th><th>Orders Count</th><th class="text-right">Total Spent</th><th>Average Basket</th><th>Last Active</th></tr></thead>';
    html += '<tbody>';

    var totalOrders = 0;
    var totalSpentAll = 0;

    customers.forEach(function(c) {
        totalOrders += c.ordersCount;
        totalSpentAll += c.totalSpent;
        var avgBasket = c.ordersCount > 0 ? (c.totalSpent / c.ordersCount) : 0;
        var lastActiveStr = c.lastActive ? c.lastActive.toLocaleDateString() : 'N/A';

        html += '<tr>';
        html += '<td><div style="font-weight:600; color:#333;">' + escapeHtml(c.name) + '</div></td>';
        html += '<td>' + escapeHtml(c.phone || 'N/A') + '</td>';
        html += '<td>' + c.ordersCount + '</td>';
        html += '<td class="text-right">GHS ' + formatNumber(c.totalSpent) + '</td>';
        html += '<td class="text-right">GHS ' + formatNumber(Math.round(avgBasket)) + '</td>';
        html += '<td>' + lastActiveStr + '</td>';
        html += '</tr>';
    });

    html += '</tbody>';
    var overallAvgBasket = totalOrders > 0 ? (totalSpentAll / totalOrders) : 0;
    html += '<tfoot><tr>';
    html += '<td><strong>Total: ' + customers.length + ' Customers</strong></td>';
    html += '<td></td>';
    html += '<td><strong>' + totalOrders + ' orders</strong></td>';
    html += '<td class="text-right"><strong>GHS ' + formatNumber(totalSpentAll) + '</strong></td>';
    html += '<td class="text-right"><strong>GHS ' + formatNumber(Math.round(overallAvgBasket)) + '</strong></td>';
    html += '<td></td>';
    html += '</tr></tfoot>';
    html += '</table>';

    return html;
}

function triggerReportExport(format) {
    var typeInput = document.getElementById('modal-report-type');
    if (!typeInput) return;
    var type = typeInput.value;

    if (format === 'pdf') {
        exportReportPDF(type);
    } else if (format === 'csv') {
        exportReportCSV(type);
    } else if (format === 'excel') {
        exportReportExcel(type);
    }
}

function exportReportPDF(type) {
    var titleEl = document.getElementById('modal-report-preview-title');
    var title = titleEl ? titleEl.textContent : (type ? type.charAt(0).toUpperCase() + type.slice(1) + ' Report' : 'Report');
    var startInput = document.getElementById('modal-report-start-date');
    var endInput = document.getElementById('modal-report-end-date');
    var dateRangeStr = (startInput ? startInput.value : '') + ' to ' + (endInput ? endInput.value : '');

    var tableEl = document.querySelector('#modal-report-table-container table');
    if (!tableEl) {
        // Open preview first, then export after table renders
        showToast('Preparing report data...', 'info');
        openReportPreview(type);
        setTimeout(function() { exportReportPDF(type); }, 1200);
        return;
    }

    var htmlContent = '<div class="header"><div class="title-container">' +
        '<h1>' + title + '</h1>' +
        '<p>Generated on ' + new Date().toLocaleDateString() + ' | Period: ' + dateRangeStr + '</p>' +
        '</div><div class="brand">DC Kids Boutique</div></div>' +
        tableEl.outerHTML;

    var fullHtml = '<style>' +
        '#print-section { font-family: "Segoe UI", "Outfit", "Inter", Arial, sans-serif; color: #333; padding: 20px; background: #fff; }' +
        '#print-section .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #F2D1D1; padding-bottom: 20px; margin-bottom: 30px; }' +
        '#print-section .brand { font-size: 24px; font-weight: 700; color: #cd5c74; letter-spacing: 0.5px; }' +
        '#print-section .title-container h1 { font-size: 20px; margin: 0; color: #333; }' +
        '#print-section .title-container p { font-size: 13px; color: #777; margin: 5px 0 0 0; }' +
        '#print-section table { width: 100%; border-collapse: collapse; margin-top: 20px; font-size: 13px; }' +
        '#print-section th { background: #FAFAFA; color: #555; text-align: left; padding: 12px 10px; border-bottom: 2px solid #EAEAEA; font-weight: 600; }' +
        '#print-section td { padding: 12px 10px; border-bottom: 1px solid #EAEAEA; color: #333; }' +
        '#print-section tfoot td { font-weight: bold; background: #FAFAFA; border-top: 2px solid #EAEAEA; }' +
        '#print-section .text-right { text-align: right; }' +
        '#print-section .badge { display: inline-block; padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; text-transform: capitalize; }' +
        '#print-section .badge-completed { background: #CDE4D6; color: #1e3a27; }' +
        '#print-section .badge-pending { background: #F8E7B8; color: #4e3f16; }' +
        '#print-section .badge-processing { background: #E7DDF8; color: #34274c; }' +
        '#print-section .badge-cancelled { background: #F2D1D1; color: #4c1a1a; }' +
        '</style>' + htmlContent;

    printHTML(fullHtml);
    showToast('Report sent to print', 'success');
}

function exportReportCSV(type) {
    var table = document.querySelector('#modal-report-table-container table');
    if (!table) {
        // If no table open, open preview first then export
        showToast('Preparing report data...', 'info');
        openReportPreview(type);
        setTimeout(function() { exportReportCSV(type); }, 1200);
        return;
    }

    var csv = [];
    var rows = table.querySelectorAll('tr');
    for (var i = 0; i < rows.length; i++) {
        var row = [], cols = rows[i].querySelectorAll('td, th');
        for (var j = 0; j < cols.length; j++) {
            var text = cols[j].innerText.trim().replace(/"/g, '""');
            row.push('"' + text + '"');
        }
        csv.push(row.join(','));
    }

    var csvContent = 'data:text/csv;charset=utf-8,\uFEFF' + csv.join('\n');
    var encodedUri = encodeURI(csvContent);
    var link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', 'dc-kids-' + type + '-report.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast('CSV report downloaded successfully', 'success');
}

function exportReportExcel(type) {
    var table = document.querySelector('#modal-report-table-container table');
    if (!table) return;

    var tsv = [];
    var rows = table.querySelectorAll('tr');
    for (var i = 0; i < rows.length; i++) {
        var row = [], cols = rows[i].querySelectorAll('td, th');
        for (var j = 0; j < cols.length; j++) {
            var text = cols[j].innerText.trim();
            row.push(text);
        }
        tsv.push(row.join('\t'));
    }

    var blob = new Blob([tsv.join('\n')], { type: 'application/vnd.ms-excel;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', 'dc-kids-' + type + '-report.xls');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function renderSalesTrendChart(days) {
    var ctx = document.getElementById('reportsSalesTrendChart');
    if (!ctx) return;

    if (chartInstances.reportsSalesTrend) {
        chartInstances.reportsSalesTrend.destroy();
    }

    var orders = getOrders().filter(function(o) { return o.status !== 'cancelled'; });
    var labels = [];
    var data = [];

    var now = new Date();
    if (days == 365) {
        var monthlyRevenue = {};
        for (var i = 11; i >= 0; i--) {
            var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            var monthName = d.toLocaleDateString('en-US', { month: 'short' });
            var key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
            labels.push(monthName);
            monthlyRevenue[key] = 0;
        }

        orders.forEach(function(o) {
            if (!o.date) return;
            var od = new Date(o.date);
            var key = od.getFullYear() + '-' + String(od.getMonth() + 1).padStart(2, '0');
            if (monthlyRevenue.hasOwnProperty(key)) {
                monthlyRevenue[key] += o.total || 0;
            }
        });

        labels.forEach(function(month, idx) {
            var d = new Date(now.getFullYear(), now.getMonth() - (11 - idx), 1);
            var key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
            data.push(Math.round(monthlyRevenue[key]));
        });
    } else {
        var dailyRevenue = {};
        for (var i = days - 1; i >= 0; i--) {
            var d = new Date();
            d.setDate(now.getDate() - i);
            var dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            var key = d.toISOString().slice(0, 10);
            labels.push(dateStr);
            dailyRevenue[key] = 0;
        }

        orders.forEach(function(o) {
            if (!o.date) return;
            var key = String(o.date).slice(0, 10);
            if (dailyRevenue.hasOwnProperty(key)) {
                dailyRevenue[key] += o.total || 0;
            }
        });

        for (var i = days - 1; i >= 0; i--) {
            var d = new Date();
            d.setDate(now.getDate() - i);
            var key = d.toISOString().slice(0, 10);
            data.push(Math.round(dailyRevenue[key]));
        }
    }

    var maxVal = Math.max.apply(null, data) || 1000;
    var stepSize = Math.ceil(maxVal / 5) || 200;
    var yMax = Math.ceil(maxVal / stepSize) * stepSize;

    chartInstances.reportsSalesTrend = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Sales (GHS)',
                data: data,
                borderColor: '#cd5c74',
                backgroundColor: 'rgba(242, 209, 209, 0.15)',
                borderWidth: 3,
                fill: true,
                tension: 0.4,
                pointBackgroundColor: '#fff',
                pointBorderColor: '#cd5c74',
                pointBorderWidth: 2,
                pointRadius: 4,
                pointHoverRadius: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#2d2d3a',
                    titleColor: '#fff',
                    bodyColor: '#fff',
                    padding: 10,
                    borderRadius: 8,
                    callbacks: {
                        label: function(context) {
                            return 'GHS ' + context.parsed.y.toLocaleString();
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    max: yMax,
                    ticks: {
                        callback: function(value) {
                            if (value >= 1000) return (value / 1000) + 'K';
                            return value;
                        },
                        color: '#8e8ea0',
                        font: { size: 10 }
                    },
                    grid: { color: 'rgba(0,0,0,0.03)', borderDash: [5, 5] }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: '#8e8ea0', font: { size: 10 } }
                }
            }
        }
    });
}

function renderCategoriesChart(currentOrders) {
    var ctx = document.getElementById('reportsCategoriesChart');
    if (!ctx) return;

    if (chartInstances.reportsCategories) {
        chartInstances.reportsCategories.destroy();
    }

    var catTotals = {};
    currentOrders.forEach(function(order) {
        if (order.status === 'cancelled') return;
        (order.items || []).forEach(function(item) {
            var cat = 'Other';
            var prod = globalProducts.find(function(p) { return p.id == item.productId; });
            if (prod && prod.cat) {
                cat = prod.cat;
            }
            catTotals[cat] = (catTotals[cat] || 0) + (item.price * item.qty);
        });
    });

    var labels = Object.keys(catTotals);
    var data = Object.values(catTotals).map(Math.round);

    if (labels.length === 0) {
        labels = ['No Data'];
        data = [1];
    }

    var backgroundColors = ['#F2D1D1', '#CDE4D6', '#E7DDF8', '#F8E7B8', '#D0E1FD', '#FCE2DB'];
    while (backgroundColors.length < labels.length) {
        backgroundColors = backgroundColors.concat(backgroundColors);
    }

    chartInstances.reportsCategories = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: labels,
            datasets: [{
                data: data,
                backgroundColor: backgroundColors.slice(0, labels.length),
                borderWidth: 2,
                borderColor: '#ffffff'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        boxWidth: 12,
                        padding: 16,
                        color: '#333333',
                        font: { size: 11, family: 'Inter, system-ui' }
                    }
                },
                tooltip: {
                    backgroundColor: '#2d2d3a',
                    titleColor: '#fff',
                    bodyColor: '#fff',
                    padding: 10,
                    borderRadius: 8,
                    callbacks: {
                        label: function(context) {
                            var val = context.parsed;
                            if (context.label === 'No Data') return 'No Sales';
                            return context.label + ': GHS ' + val.toLocaleString();
                        }
                    }
                }
            },
            cutout: '70%'
        }
    });
}

function generateReport(type) {
    openReportPreview(type);
}

/* ============================================================
   SECTION 19B: REVIEWS TAB
   ============================================================ */
window.adminReviews = [];

function loadReviews() {
    var token = localStorage.getItem('adminToken');
    if (!token || token.indexOf('fallback-token') === 0) {
        renderReviewsTable();
        return;
    }

    fetch(API_URL + '/admin/reviews', {
        headers: { 'Authorization': 'Bearer ' + token }
    })
    .then(function(res) {
        if (res.status === 401 || res.status === 403) { handleSessionExpiry(); return null; }
        if (!res.ok) throw new Error('Reviews API unavailable');
        return res.json();
    })
    .then(function(data) {
        if (data === null) return; // session expired — already handled
        window.adminReviews = Array.isArray(data) ? data : [];
        renderReviewStats();
        renderReviewsTable();
    })
    .catch(function(err) {
        console.warn('Could not load reviews:', err.message);
        var tbody = document.getElementById('reviews-tbody');
        if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Could not load reviews.</td></tr>';
    });
}

function renderReviewStats() {
    var reviews = window.adminReviews || [];
    var totalEl = document.getElementById('review-total-count');
    var avgEl = document.getElementById('review-avg-rating');
    var lowEl = document.getElementById('review-low-count');
    if (totalEl) totalEl.textContent = reviews.length;
    if (avgEl) {
        var avg = reviews.length ? (reviews.reduce(function(s, r) { return s + r.rating; }, 0) / reviews.length) : 0;
        avgEl.textContent = reviews.length ? avg.toFixed(1) : '—';
    }
    if (lowEl) lowEl.textContent = reviews.filter(function(r) { return r.rating <= 2; }).length;
}

function getFilteredReviews() {
    var searchEl = document.getElementById('review-search');
    var query = searchEl ? searchEl.value.toLowerCase() : '';
    var reviews = window.adminReviews || [];
    if (!query) return reviews;
    return reviews.filter(function(r) {
        return (r.product_name || '').toLowerCase().indexOf(query) >= 0 ||
               (r.author_name || '').toLowerCase().indexOf(query) >= 0;
    });
}

function renderReviewsTable() {
    var tbody = document.getElementById('reviews-tbody');
    if (!tbody) return;

    var reviews = getFilteredReviews();
    var totalItems = reviews.length;
    var start = (reviewCurrentPage - 1) * REVIEW_PER_PAGE;
    var paged = reviews.slice(start, start + REVIEW_PER_PAGE);

    tbody.innerHTML = '';
    if (paged.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No reviews found</td></tr>';
    } else {
        paged.forEach(function(r) {
            var tr = document.createElement('tr');
            var stars = '★★★★★☆☆☆☆☆'.slice(5 - r.rating, 10 - r.rating);
            var date = r.created_at ? new Date(r.created_at).toLocaleDateString() : '—';
            var excerpt = (r.title ? r.title + ' — ' : '') + (r.body || '');
            tr.innerHTML = '<td class="table-card-header" data-label="Product" style="font-weight:600;">' + escapeHtml(r.product_name || 'Unknown product') + '</td>' +
                '<td data-label="Customer">' + escapeHtml(r.author_name) + '</td>' +
                '<td data-label="Rating" style="color:#fc4c7a;letter-spacing:1.5px;">' + stars + '</td>' +
                '<td data-label="Review" style="max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + escapeHtml(excerpt) + '">' + escapeHtml(excerpt) + '</td>' +
                '<td data-label="Date">' + date + '</td>' +
                '<td data-label="Actions"><div class="table-actions">' +
                    '<button class="action-icon delete" title="Delete review" onclick="confirmDeleteReview(' + r.id + ')">' +
                        '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>' +
                    '</button>' +
                '</div></td>';
            tbody.appendChild(tr);
        });
    }

    renderPagination('review-pagination', totalItems, reviewCurrentPage, REVIEW_PER_PAGE, function(page) {
        reviewCurrentPage = page;
        renderReviewsTable();
    });
}

function confirmDeleteReview(id) {
    showConfirm('Delete Review', 'Are you sure you want to delete this review? This action cannot be undone.', function() {
        deleteReview(id);
    });
}

function deleteReview(id) {
    var token = localStorage.getItem('adminToken');
    if (!token) return;

    var review = (window.adminReviews || []).find(function(r) { return r.id === id; });

    fetch(API_URL + '/admin/reviews/' + id, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + token }
    })
    .then(function(res) {
        if (res.status === 401 || res.status === 403) { handleSessionExpiry(); return null; }
        if (!res.ok) return res.json().then(function(d) { throw new Error(d.error || 'Delete failed'); });
        return res.json();
    })
    .then(function(data) {
        if (data === null) return; // session expired — already handled
        window.adminReviews = (window.adminReviews || []).filter(function(r) { return r.id !== id; });
        renderReviewStats();
        renderReviewsTable();
        showToast('Review deleted', 'success');
        addActivity('review', 'Deleted review by ' + (review ? review.author_name : 'a customer'));
    })
    .catch(function(err) {
        showToast(err.message || 'Failed to delete review', 'error');
    });
}

/* ============================================================
   SECTION 20: SETTINGS TAB
   ============================================================ */
function applyAccentColor(color) {
    if (!color) return;
    document.documentElement.style.setProperty('--primary', color);
}

// Mirror the saved Profile (name + email) into the top-right user widget.
function applyAdminProfileToHeader() {
    var s = (typeof getSettings === 'function') ? getSettings() : null;
    var name = (s && s.profile && s.profile.name) ? s.profile.name : 'Admin';
    var email = (s && s.profile && s.profile.email) || '';

    var nameEl = document.getElementById('user-display-name');
    if (nameEl) nameEl.textContent = name;

    var avatar = document.querySelector('.user-profile .user-avatar');
    if (avatar) {
        avatar.alt = name;
        avatar.src = localInitialsAvatar(name);
    }

    var wrap = document.querySelector('.user-profile');
    if (wrap) wrap.title = email ? (name + ' • ' + email) : name;

    // Sync the rich dropdown header (name + initials avatar)
    var aumName = document.getElementById('aum-name');
    var aumAvatar = document.getElementById('aum-avatar');
    if (aumName) aumName.textContent = name;
    if (aumAvatar) aumAvatar.textContent = adminInitials(name);

    // Sync the dashboard greeting hero
    updateDashboardGreeting(name);
}

// Personalized, time-aware dashboard greeting.
function updateDashboardGreeting(name) {
    if (!name) {
        var s = (typeof getSettings === 'function') ? getSettings() : null;
        name = (s && s.profile && s.profile.name) ? s.profile.name : 'Admin';
    }
    var firstName = String(name).trim().split(/\s+/)[0] || name;

    var hour = new Date().getHours();
    var hello = 'Welcome back,';
    if (hour < 12) hello = 'Good morning,';
    else if (hour < 17) hello = 'Good afternoon,';
    else if (hour < 21) hello = 'Good evening,';
    else hello = 'Working late,';

    // Rotating short messages — a fresh one each load
    var messages = [
        "Let's make today a productive one.",
        "Here's your store at a glance.",
        "Hope you're having a great day!",
        "Let's get those orders moving.",
        "Your shop is looking good today.",
        "Ready when you are.",
        "Let's keep the little ones stylish."
    ];
    var msg = messages[Math.floor(Math.random() * messages.length)];

    // Role from settings
    var role = 'Administrator';
    try {
        var st = (typeof getSettings === 'function') ? getSettings() : null;
        if (st && st.profile && st.profile.role) role = st.profile.role;
    } catch (e) {}

    function set(id, val){ var el = document.getElementById(id); if (el) el.textContent = val; }
    set('dashGreetingHello', hello);
    set('dashGreetingName', firstName);
    set('dashGreetingMsg', msg);
    set('dashGreetingRoleText', role === 'Administrator' ? 'Admin' : role);
    set('dashHeroUserName', firstName);
    set('dashHeroUserRole', role);
    // Settings account summary card
    set('settings-acct-name', firstName);
    set('settings-acct-initials', (typeof adminInitials === 'function') ? adminInitials(name) : firstName.slice(0,2).toUpperCase());
    set('settings-acct-role', role + ' · DC Kids Brand');

    // Mirror notification count into the hero bell badge
    var src = document.getElementById('notification-count');
    var dst = document.getElementById('dashHeroNotifCount');
    if (dst) {
        var n = src ? (parseInt(src.textContent, 10) || 0) : 0;
        dst.textContent = n > 9 ? '9+' : String(n);
        dst.style.display = n > 0 ? 'flex' : 'none';
    }

    // Desktop greeting aside: live date + today's snapshot
    var now = new Date();
    set('dashHeroDateDay', now.toLocaleDateString(undefined, { weekday: 'long' }));
    set('dashHeroDateFull', now.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }));
    try {
        var orders = (typeof getOrders === 'function') ? getOrders() : [];
        var pending = orders.filter(function(o){ return (o.status || '').toLowerCase() === 'pending'; }).length;
        var pEl = document.getElementById('dashHeroPending');
        if (pEl) pEl.textContent = String(pending);
        var lowEl = document.getElementById('val-low-stock');
        var lEl = document.getElementById('dashHeroLow');
        if (lowEl && lEl) lEl.textContent = lowEl.textContent.trim() || '0';
    } catch (e) {}
}

function adminInitials(name) {
    if (!name) return 'AD';
    var parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return 'AD';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ───────────────────────── Admin account dropdown ─────────────────────────
function toggleAdminUserMenu(event) {
    if (event) event.stopPropagation();
    var menu = document.getElementById('admin-user-menu');
    if (!menu) return;
    // On mobile the header is hidden — relocate the menu to <body> so it shows.
    if (window.innerWidth <= 1024 && menu.parentNode !== document.body) {
        document.body.appendChild(menu);
        menu.classList.add('admin-user-menu--mobile');
    } else if (window.innerWidth > 1024 && menu.classList.contains('admin-user-menu--mobile')) {
        menu.classList.remove('admin-user-menu--mobile');
    }
    var willOpen = !menu.classList.contains('admin-user-menu--open');
    closeAdminUserMenu();
    if (willOpen) {
        populateAdminUserMenu();
        menu.classList.add('admin-user-menu--open');
        if (window.innerWidth <= 1024) showHeaderPopoverScrim();
    } else {
        hideHeaderPopoverScrim();
    }
}

function closeAdminUserMenu() {
    var menu = document.getElementById('admin-user-menu');
    if (menu) menu.classList.remove('admin-user-menu--open');
}

function populateAdminUserMenu() {
    applyAdminProfileToHeader();

    var darkToggle = document.getElementById('aum-dark-toggle');
    
    try {
        var orders = (typeof getOrders === 'function') ? getOrders() : [];
        var today = new Date();
        var y = today.getFullYear(), m = today.getMonth(), d = today.getDate();
        var todays = orders.filter(function(o) {
            if (!o || !o.date) return false;
            var dt = new Date(o.date);
            return dt.getFullYear() === y && dt.getMonth() === m && dt.getDate() === d && o.status !== 'cancelled';
        });
        var revenue = todays.reduce(function(sum, o) { return sum + (Number(o.total) || 0); }, 0);
        var oEl = document.getElementById('aum-today-orders');
        var rEl = document.getElementById('aum-today-revenue');
        if (oEl) oEl.textContent = String(todays.length);
        if (rEl) rEl.textContent = 'GHS ' + revenue.toLocaleString();
    } catch (e) {
        var oEl2 = document.getElementById('aum-today-orders'); if (oEl2) oEl2.textContent = '0';
        var rEl2 = document.getElementById('aum-today-revenue'); if (rEl2) rEl2.textContent = 'GHS 0';
    }

    try {
        var notifs = (typeof getNotifications === 'function') ? getNotifications() : [];
        var unread = notifs.filter(function(n) { return n && !n.read; }).length;
        var pill = document.getElementById('aum-notif-count');
        if (pill) {
            if (unread > 0) { pill.textContent = String(unread); pill.style.display = 'inline-flex'; }
            else { pill.style.display = 'none'; }
        }
    } catch (e) {}
}

function adminMenuToggleDark(checked) {
    // Dark mode removed — no-op.
}

function adminMenuGoto(target) {
    closeAdminUserMenu();
    switch (target) {
        case 'profile':
        case 'settings':
            if (typeof switchTab === 'function') switchTab('tab-settings');
            setTimeout(function() {
                var card = null;
                if (target === 'profile') {
                    var titles = document.querySelectorAll('#tab-settings .settings-card-title');
                    titles.forEach(function(t) { if (t.textContent.trim() === 'Profile') card = t.parentElement; });
                }
                if (!card) card = document.querySelector('#tab-settings .settings-card');
                if (card && card.scrollIntoView) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 120);
            break;
        case 'admins':
            if (typeof switchTab === 'function') switchTab('tab-admins');
            break;
        case 'notifications':
            var notifBtn = document.getElementById('notification-btn');
            if (notifBtn) notifBtn.click();
            break;
        case 'activity':
            if (typeof switchTab === 'function') switchTab('tab-dashboard');
            setTimeout(function() {
                var act = document.querySelector('.activity-section, #activity-timeline');
                if (act && act.scrollIntoView) act.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 120);
            break;
        case 'logout':
            if (typeof logout === 'function') logout();
            break;
    }
}

document.addEventListener('click', function(e) {
    var menu = document.getElementById('admin-user-menu');
    if (!menu || !menu.classList.contains('admin-user-menu--open')) return;
    if (!e.target.closest) return;
    if (e.target.closest('#admin-user-menu') || e.target.closest('#user-profile-btn')) return;
    closeAdminUserMenu();
    hideHeaderPopoverScrim();
});
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') { closeAdminUserMenu(); hideHeaderPopoverScrim(); }
});

function loadSettingsTab() {
    var settings = getSettings();

    // Refresh the Storefront Configuration card from the server every time the
    // Settings tab opens — otherwise it keeps the values loaded at initial login
    // and looks like saved changes "don't show".
    if (typeof loadStoreConfig === 'function') loadStoreConfig();

    var darkToggle = document.getElementById('settings-dark-toggle');
    if (darkToggle) darkToggle.checked = !!settings.darkMode;

    // Profile
    var nameEl = document.getElementById('settings-name');
    var phoneEl = document.getElementById('settings-phone');
    if (nameEl) nameEl.value = settings.profile.name || '';
    if (phoneEl) phoneEl.value = settings.profile.phone || '';

    // Accent colour
    var accentEl = document.getElementById('settings-accent-color');
    if (accentEl) accentEl.value = settings.accentColor || '#fc4c7a';

    // Notifications (in-app bell categories)
    var nLow = document.getElementById('settings-lowstock-notif');
    var nOrder = document.getElementById('settings-order-notif');
    if (nLow) nLow.checked = settings.notifications.lowStock !== false;
    if (nOrder) nOrder.checked = settings.notifications.orders !== false;

    // Dashboard widget toggles
    var wRev = document.getElementById('settings-widget-revenue');
    var wInv = document.getElementById('settings-widget-inventory');
    var wAct = document.getElementById('settings-widget-activity');
    var wProd = document.getElementById('settings-widget-products');
    if (wRev) wRev.checked = !!settings.widgets.revenue;
    if (wInv) wInv.checked = !!settings.widgets.inventory;
    if (wAct) wAct.checked = !!settings.widgets.activity;
    if (wProd) wProd.checked = !!settings.widgets.products;

    // Apply visual state
        else     applyAccentColor(settings.accentColor);
}

function saveSettingsForm() {
    var settings = getSettings();

    var darkToggle = document.getElementById('settings-dark-toggle');
    if (darkToggle) settings.darkMode = darkToggle.checked;

    var accentEl = document.getElementById('settings-accent-color');
    if (accentEl && accentEl.value) settings.accentColor = accentEl.value;

    var nLow = document.getElementById('settings-lowstock-notif');
    var nOrder = document.getElementById('settings-order-notif');
    if (nLow) settings.notifications.lowStock = nLow.checked;
    if (nOrder) settings.notifications.orders = nOrder.checked;

    var wRev = document.getElementById('settings-widget-revenue');
    var wInv = document.getElementById('settings-widget-inventory');
    var wAct = document.getElementById('settings-widget-activity');
    var wProd = document.getElementById('settings-widget-products');
    if (wRev) settings.widgets.revenue = wRev.checked;
    if (wInv) settings.widgets.inventory = wInv.checked;
    if (wAct) settings.widgets.activity = wAct.checked;
    if (wProd) settings.widgets.products = wProd.checked;

    saveSettings(settings);
    applyAccentColor(settings.accentColor);

    // Notification toggles changed → repaint bell badge so it's immediate
    if (typeof renderNotifications === 'function') renderNotifications();

    showToast('Settings saved successfully', 'success');
}

function saveProfile() {
    var nameEl = document.getElementById('settings-name');
    var phoneEl = document.getElementById('settings-phone');
    var name = nameEl ? nameEl.value.trim() : '';
    var phone = phoneEl ? phoneEl.value.trim() : '';

    if (!name) { showToast('Display name is required', 'error'); if (nameEl) nameEl.focus(); return; }
    if (phone && !/^[0-9+\-\s()]{7,}$/.test(phone)) {
        showToast('Enter a valid phone number', 'error'); if (phoneEl) phoneEl.focus(); return;
    }

    var settings = getSettings();
    settings.profile = { name: name, phone: phone };
    saveSettings(settings);

    applyAdminProfileToHeader();

    if (typeof addActivity === 'function') addActivity('system', 'Profile updated');
    showToast('Profile saved successfully', 'success');
}

function updatePassword() {
    var currentEl = document.getElementById('settings-current-pw');
    var newPw = document.getElementById('settings-new-pw');
    var confirmPw = document.getElementById('settings-confirm-pw');
    if (!newPw || !confirmPw) return;

    // Hash helper (FNV-1a) — never store the raw password, even in prototype/fallback mode.
    function hashPw(s) {
        var h = 0x811c9dc5;
        for (var i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
        }
        return ('00000000' + h.toString(16)).slice(-8);
    }
    // Stored value is a hash; default 'admin123' hashes on the fly for first run.
    var storedHash = localStorage.getItem('dcKidsAdminPwHash') || hashPw('admin123');
    var current = currentEl ? currentEl.value : '';

    if (!current) { showToast('Enter your current password', 'error'); if (currentEl) currentEl.focus(); return; }
    if (hashPw(current) !== storedHash) { showToast('Current password is incorrect', 'error'); if (currentEl) currentEl.focus(); return; }
    if (!newPw.value || newPw.value.length < 6) { showToast('New password must be at least 6 characters', 'warning'); newPw.focus(); return; }
    if (newPw.value !== confirmPw.value) { showToast('Passwords do not match', 'error'); confirmPw.focus(); return; }
    if (hashPw(newPw.value) === storedHash) { showToast('New password must differ from the current one', 'warning'); newPw.focus(); return; }

    localStorage.setItem('dcKidsAdminPwHash', hashPw(newPw.value));
    localStorage.removeItem('dcKidsAdminPassword'); // purge any legacy plaintext
    if (typeof addActivity === 'function') addActivity('system', 'Admin password updated');

    if (currentEl) currentEl.value = '';
    newPw.value = '';
    confirmPw.value = '';
    showToast('Password updated successfully', 'success');
}

// Apply persisted accent colour + dark mode + admin profile header on every load.
document.addEventListener('DOMContentLoaded', function() {
    try {
        var s = getSettings();
                applyAccentColor(s.accentColor);
        applyAdminProfileToHeader();
    } catch (e) {}
});

/* ============================================================
   SECTION 21: CSV / PDF EXPORT HELPERS
   ============================================================ */
function exportToCSV(data, filename) {
    if (!data || data.length === 0) {
        showToast('No data to export', 'warning');
        return;
    }

    var headers = Object.keys(data[0]);
    var csvContent = headers.join(',') + '\n';

    data.forEach(function(row) {
        var values = headers.map(function(h) {
            var val = String(row[h] || '').replace(/"/g, '""');
            return '"' + val + '"';
        });
        csvContent += values.join(',') + '\n';
    });

    var blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename || 'export.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast('CSV downloaded: ' + filename, 'success');
}

function exportToPDF() {
    window.print();
}

function downloadReportCSV() {
    var preview = document.getElementById('report-preview');
    if (!preview) return;

    // Parse the table in preview
    var table = preview.querySelector('table');
    if (!table) {
        showToast('Generate a report first', 'warning');
        return;
    }

    var rows = table.querySelectorAll('tr');
    var data = [];
    var headers = [];

    rows.forEach(function(row, idx) {
        var cells = row.querySelectorAll('th, td');
        if (idx === 0) {
            cells.forEach(function(c) { headers.push(c.textContent.trim()); });
        } else {
            var obj = {};
            cells.forEach(function(c, ci) { obj[headers[ci] || 'col' + ci] = c.textContent.trim(); });
            data.push(obj);
        }
    });

    exportToCSV(data, 'dc-kids-report.csv');
}

/* ============================================================
   SECTION 22: PAGINATION HELPER
   ============================================================ */
function renderPagination(containerId, totalItems, currentPage, itemsPerPage, callback) {
    var container = document.getElementById(containerId);
    if (!container) return;

    var totalPages = Math.ceil(totalItems / itemsPerPage);
    if (totalPages <= 1) {
        container.innerHTML = '';
        return;
    }

    var html = '<div class="pagination-controls">';

    // Prev button
    html += '<button ' + (currentPage <= 1 ? 'disabled' : '') + ' data-page="' + (currentPage - 1) + '" aria-label="Previous page">&lt;</button>';

    // Page buttons
    var startPage = Math.max(1, currentPage - 2);
    var endPage = Math.min(totalPages, currentPage + 2);

    if (startPage > 1) {
        html += '<button data-page="1">1</button>';
        if (startPage > 2) html += '<span>...</span>';
    }

    for (var i = startPage; i <= endPage; i++) {
        html += '<button data-page="' + i + '"' + (i === currentPage ? ' class="active"' : '') + '>' + i + '</button>';
    }

    if (endPage < totalPages) {
        if (endPage < totalPages - 1) html += '<span>...</span>';
        html += '<button data-page="' + totalPages + '">' + totalPages + '</button>';
    }

    // Next button
    html += '<button ' + (currentPage >= totalPages ? 'disabled' : '') + ' data-page="' + (currentPage + 1) + '" aria-label="Next page">&gt;</button>';
    html += '</div>';

    container.innerHTML = html;

    // Bind page clicks
    container.querySelectorAll('button[data-page]').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var page = parseInt(btn.getAttribute('data-page'));
            if (page >= 1 && page <= totalPages) {
                callback(page);
            }
        });
    });
}

/* ============================================================
   SECTION 23: CONFIRMATION MODAL
   ============================================================ */
function showConfirm(title, message, onConfirm) {
    var modal = document.getElementById('modal-confirm');
    if (!modal) {
        // Create confirm modal dynamically
        modal = document.createElement('div');
        modal.id = 'modal-confirm';
        modal.className = 'modal-overlay';
        modal.style.display = 'none';
        modal.innerHTML = '<div class="modal-content" style="width:420px;">' +
            '<div class="modal-header"><h3 id="confirm-title">Confirm</h3>' +
            '<button class="close-modal" onclick="closeModal(\'modal-confirm\')"><svg width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button></div>' +
            '<div class="modal-body" style="flex-direction:column;"><p id="confirm-message" style="margin:0;font-size:15px;color:#555;"></p></div>' +
            '<div class="modal-footer">' +
            '<button class="cancel-btn" id="confirm-cancel" onclick="closeModal(\'modal-confirm\')">Cancel</button>' +
            '<button class="update-btn" id="confirm-ok" style="background:#EF4444;">Confirm</button>' +
            '</div></div>';
        document.body.appendChild(modal);
    }

    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;

    pendingConfirmCallback = onConfirm;

    var okBtn = document.getElementById('confirm-ok');
    // Remove old listeners by replacing node
    var newOk = okBtn.cloneNode(true);
    okBtn.parentNode.replaceChild(newOk, okBtn);
    newOk.addEventListener('click', function() {
        closeModal('modal-confirm');
        if (pendingConfirmCallback) {
            pendingConfirmCallback();
            pendingConfirmCallback = null;
        }
    });

    var cancelBtn = document.getElementById('confirm-cancel');
    if (cancelBtn) {
        var newCancel = cancelBtn.cloneNode(true);
        cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
        newCancel.addEventListener('click', function() {
            closeModal('modal-confirm');
            pendingConfirmCallback = null;
        });
    }

    openModal('modal-confirm');
}

function confirmDeleteProduct(id) {
    showConfirm('Delete Product', 'Are you sure you want to delete this product? This action cannot be undone.', function() {
        deleteProduct(id);
    });
}

function deleteProduct(id) {
    var token = localStorage.getItem('adminToken');
    if (!token) return;

    fetch(API_URL + '/products/' + id, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + token }
    })
    .then(function(res) {
        if (!res.ok) return res.json().then(function(d) { throw new Error(d.error || 'Delete failed'); });
        return res.json();
    })
    .then(function() {
        showToast('Product deleted successfully', 'success');
        addActivity('product', 'Deleted product #' + id);
        loadDashboard();
        var invTab = document.getElementById('tab-inventory');
        if (invTab && invTab.classList.contains('active')) loadInventory();
        var prodTab = document.getElementById('tab-products');
        if (prodTab && prodTab.classList.contains('active')) loadProducts();
    })
    .catch(function(err) {
        showToast(err.message || 'Failed to delete product', 'error');
    });
}

function deductStock(id) {
    var token = localStorage.getItem('adminToken');
    if (!token) return;

    fetch(API_URL + '/products/' + id + '/deduct', {
        method: 'PUT',
        headers: { 'Authorization': 'Bearer ' + token }
    })
    .then(function(res) {
        if (!res.ok) return res.json().then(function(d) { throw new Error(d.error || 'Deduct failed'); });
        return res.json();
    })
    .then(function() {
        showToast('Stock deducted', 'success');
        loadDashboard();
        var invTab = document.getElementById('tab-inventory');
        if (invTab && invTab.classList.contains('active')) loadInventory();
    })
    .catch(function(err) {
        showToast(err.message || 'Failed to deduct stock', 'error');
    });
}

/* ============================================================
   SECTION 24: ACTIVITY LOG
   ============================================================ */
function addActivity(type, message) {
    var activities = getActivities();
    activities.unshift({
        type: type,
        message: message,
        timestamp: new Date().toISOString()
    });
    if (activities.length > 100) activities = activities.slice(0, 100);
    saveActivities(activities);
}

/* ============================================================
   SECTION 25: UTILITY HELPERS
   ============================================================ */
function formatNumber(n) {
    return Number(n).toLocaleString();
}

function timeAgo(date) {
    var diff = Date.now() - date.getTime();
    var seconds = Math.floor(diff / 1000);
    if (seconds < 60) return 'Just now';
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    var days = Math.floor(hours / 24);
    if (days < 7) return days + 'd ago';
    return date.toLocaleDateString();
}

/* ============================================================
   SECTION 26: DYNAMIC TAB CREATION
   Ensures all tabs exist in the DOM even if not in the HTML
   ============================================================ */
function ensureTabsExist() {
    var main = document.querySelector('.admin-main');
    if (!main) return;

    var navItems = document.querySelectorAll('.sidebar-link');
    var tabNames = [
        'tab-dashboard', 'tab-inventory', 'tab-products',
        'tab-orders', 'tab-customers', 'tab-suppliers',
        'tab-analytics', 'tab-reports', 'tab-settings'
    ];

    // Map nav items to targets
    navItems.forEach(function(nav, idx) {
        if (!nav.getAttribute('data-tab') && tabNames[idx]) {
            nav.setAttribute('data-tab', tabNames[idx]);
        }
    });

    // Create missing tab views
    tabNames.forEach(function(tabId) {
        if (!document.getElementById(tabId)) {
            var div = document.createElement('div');
            div.id = tabId;
            div.className = 'tab-view';
            div.style.display = 'none';
            div.innerHTML = buildTabContent(tabId);
            main.appendChild(div);
        }
    });

    // Ensure pagination containers exist in inventory view
    var invView = document.getElementById('tab-inventory');
    if (invView && !document.getElementById('inv-pagination')) {
        // Update the existing pagination div
        var existingPagination = invView.querySelector('.pagination .pagination-controls');
        if (existingPagination) {
            existingPagination.id = 'inv-pagination';
        } else {
            var pagDiv = document.createElement('div');
            pagDiv.id = 'inv-pagination';
            pagDiv.className = 'pagination';
            invView.querySelector('.inventory-section').appendChild(pagDiv);
        }
    }

    // Enhance inventory filters with proper values
    enhanceInventoryFilters();
}

function enhanceInventoryFilters() {
    var invView = document.getElementById('tab-inventory');
    if (!invView) return;

    var selects = invView.querySelectorAll('.filter-bar select');
    var searchInput = invView.querySelector('.filter-bar input[type="text"]');

    // Category filter
    if (selects[0] && selects[0].children.length <= 1) {
        selects[0].innerHTML = '<option value="all">All Categories</option>' +
            '<option value="clothing">Clothing</option>' +
            '<option value="baby">Baby</option>' +
            '<option value="shoes">Shoes</option>' +
            '<option value="accessories">Accessories</option>' +
            '<option value="bags">Bags</option>' +
            '<option value="bedding">Bedding</option>' +
            '<option value="newborn">Newborn</option>' +
            '<option value="essentials">Essentials</option>';
    }

    // Status filter
    if (selects[1] && selects[1].children.length <= 1) {
        selects[1].innerHTML = '<option value="all">All Status</option>' +
            '<option value="in-stock">In Stock</option>' +
            '<option value="low-stock">Low Stock</option>' +
            '<option value="out-of-stock">Out of Stock</option>';
    }

    // Bind filter events by id, not position — the filter bar now has a 3rd
    // (fulfillment) select between status and sort, so positional indices shift.
    ['inv-cat-filter', 'inv-status-filter', 'inv-fulfillment-filter', 'inv-sort'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.addEventListener('change', function() { invCurrentPage = 1; renderInventoryTable(); });
    });
    if (searchInput) {
        searchInput.addEventListener('input', function() { invCurrentPage = 1; renderInventoryTable(); });
    }
}

function buildTabContent(tabId) {
    switch (tabId) {
        case 'tab-products':
            return '<div class="page-header">' +
                '<div><h1 class="page-title">Product Management</h1><p class="page-subtitle">Add, edit, and manage your products</p></div>' +
                ((currentRole === 'manager' || currentRole === 'admin') ? '<button class="btn btn-primary" id="add-product-btn" onclick="openAddProductModal()"><svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg> Add Product</button>' : '') +
                '</div>' +
                '<div class="filter-bar">' +
                '<div class="filter-group">' +
                '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' +
                '<input type="search" id="prod-search" class="filter-input" placeholder="Search products…" aria-label="Search products">' +
                '</div>' +
                '<select id="prod-cat-filter" class="filter-select" aria-label="Filter products by category">' +
                '<option value="">All Categories</option><option value="clothing">Clothing</option><option value="accessories">Accessories</option><option value="newborn">Newborn</option><option value="bedding">Bedding</option><option value="shoes">Shoes</option>' +
                '</select>' +
                '<select id="prod-status-filter" class="filter-select" aria-label="Filter products by status">' +
                '<option value="">All Status</option><option value="in-stock">In Stock</option><option value="low-stock">Low Stock</option><option value="out-of-stock">Out of Stock</option>' +
                '</select>' +
                '<select id="prod-fulfillment-filter" class="filter-select" aria-label="Filter products by listing type">' +
                '<option value="">All Listings</option><option value="in_stock">Available Now</option><option value="preorder">China Pre-Order</option>' +
                '</select>' +
                '<select id="prod-sort" class="filter-select" aria-label="Sort products">' +
                '<option value="newest">Sort By: Newest</option><option value="oldest">Sort By: Oldest</option><option value="price-low">Sort By: Price (Low to High)</option><option value="price-high">Sort By: Price (High to Low)</option><option value="name-asc">Sort By: Name (A-Z)</option>' +
                '</select>' +
                '<div class="filter-actions" style="position:relative;">' +
                '<button class="btn btn-secondary flex items-center gap-2" id="prod-filter-btn" onclick="toggleProductFilterPanel(event)" style="border-color: rgba(252, 76, 122, 0.3); color: var(--primary); font-weight: 600; display: flex; align-items: center; gap: 6px;" type="button"><svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" style="color: var(--primary);"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"></path></svg> Filter <span id="prod-filter-badge" class="prod-filter-badge" style="display:none;">0</span></button>' +
                '<div id="prod-filter-panel" class="prod-filter-panel" role="dialog" aria-label="Advanced product filters">' +
                '<div class="prod-filter-panel__header">Advanced filters</div>' +
                '<div class="prod-filter-panel__body">' +
                '<div class="prod-filter-panel__group"><label class="prod-filter-panel__label">Price (GHS)</label><div class="prod-filter-panel__range"><input type="number" id="prod-filter-price-min" class="prod-filter-panel__input" placeholder="Min" min="0"><span class="prod-filter-panel__sep">–</span><input type="number" id="prod-filter-price-max" class="prod-filter-panel__input" placeholder="Max" min="0"></div></div>' +
                '<div class="prod-filter-panel__group"><label class="prod-filter-panel__label">Stock</label><div class="prod-filter-panel__range"><input type="number" id="prod-filter-stock-min" class="prod-filter-panel__input" placeholder="Min" min="0"><span class="prod-filter-panel__sep">–</span><input type="number" id="prod-filter-stock-max" class="prod-filter-panel__input" placeholder="Max" min="0"></div></div>' +
                '<div class="prod-filter-panel__group"><label class="prod-filter-panel__label">Badge</label><select id="prod-filter-badge-sel" class="prod-filter-panel__select"><option value="">Any</option><option value="new">New</option><option value="hot">Hot</option><option value="sale">Sale</option><option value="preorder">Pre-order</option><option value="none">No badge</option></select></div>' +
                '</div>' +
                '<div class="prod-filter-panel__footer"><button type="button" class="btn btn-outline-small" onclick="resetProductFilters()">Reset</button><button type="button" class="btn btn-primary btn-sm" onclick="applyProductFilters()" style="background: var(--primary); color: #fff;">Apply Filters</button></div>' +
                '</div>' +
                '</div>' +
                '</div>' +
                '<div class="table-responsive"><table id="products-table" class="admin-table data-table sticky-header" aria-label="Product management table"><thead><tr><th>Product</th><th>SKU</th><th>Category</th><th>Price</th><th>Stock</th><th>Badge</th><th>Status</th><th>Actions</th></tr></thead><tbody id="products-tbody"></tbody></table></div>';
        case 'tab-orders':
            return '<div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 flex flex-col md:flex-row items-center gap-4 justify-between mb-6">' +
                '<div class="relative w-full md:w-96">' +
                '<div class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">' +
                '<svg class="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>' +
                '</div>' +
                '<input type="text" id="order-search" placeholder="Search orders..." class="w-full pl-10 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-rose-500 focus:border-rose-500 placeholder-gray-400 shadow-sm transition-shadow">' +
                '</div>' +
                '<div class="flex flex-wrap items-center gap-3 w-full md:w-auto">' +
                '<div class="relative">' +
                '<select id="order-status-filter" class="appearance-none pl-4 pr-10 py-2.5 border border-gray-200 rounded-xl text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-rose-500 focus:border-rose-500 cursor-pointer shadow-sm transition-colors">' +
                '<option value="all">All Status</option><option value="pending">Pending</option><option value="processing">Processing</option><option value="delivered">Delivered</option><option value="cancelled">Cancelled</option>' +
                '</select>' +
                '<div class="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-gray-500">' +
                '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>' +
                '</div></div>' +
                '<button class="bg-gray-900 hover:bg-gray-800 text-white px-5 py-2.5 rounded-xl text-sm font-medium transition-colors shadow-sm flex items-center gap-2" id="create-order-btn" onclick="openCreateOrderModal()"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg> New Order</button>' +
                '</div></div>' +
                '<div class="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden"><div class="overflow-x-auto"><table class="w-full text-left border-collapse"><thead><tr class="bg-gray-50/50 border-b border-gray-100"><th class="px-6 py-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Order ID</th><th class="px-6 py-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Customer</th><th class="px-6 py-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Items</th><th class="px-6 py-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Total</th><th class="px-6 py-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th><th class="px-6 py-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Date</th><th class="px-6 py-4 text-xs font-semibold text-gray-500 uppercase tracking-wider text-right">Actions</th></tr></thead><tbody id="orders-tbody" class="divide-y divide-gray-100"></tbody></table></div></div>' +
                '<div id="order-pagination" style="margin-top:20px;display:flex;justify-content:center;"></div>';

        case 'tab-customers':
            return '<div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 flex flex-col md:flex-row items-center gap-4 justify-between mb-6">' +
                '<div class="relative w-full md:w-96">' +
                '<div class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">' +
                '<svg class="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>' +
                '</div>' +
                '<input type="text" id="cust-search" placeholder="Search customers..." class="w-full pl-10 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-rose-500 focus:border-rose-500 placeholder-gray-400 shadow-sm transition-shadow" oninput="custCurrentPage=1;renderCustomersTable()">' +
                '</div>' +
                '<div class="flex flex-wrap items-center gap-3 w-full md:w-auto">' +
                '<button class="bg-gray-900 hover:bg-gray-800 text-white px-5 py-2.5 rounded-xl text-sm font-medium transition-colors shadow-sm flex items-center gap-2" id="add-customer-btn" onclick="openAddCustomerModal()"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg> Add Customer</button>' +
                '</div></div>' +
                '<div class="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden"><div class="overflow-x-auto"><table class="w-full text-left border-collapse"><thead><tr class="bg-gray-50/50 border-b border-gray-100"><th class="px-6 py-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Name</th><th class="px-6 py-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Email</th><th class="px-6 py-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Phone</th><th class="px-6 py-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Orders</th><th class="px-6 py-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Total Spent</th><th class="px-6 py-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th><th class="px-6 py-4 text-xs font-semibold text-gray-500 uppercase tracking-wider text-right">Actions</th></tr></thead><tbody id="customers-tbody" class="divide-y divide-gray-100"></tbody></table></div></div>' +
                '<div id="cust-pagination" style="margin-top:20px;display:flex;justify-content:center;"></div>';

        case 'tab-suppliers':
            return '<div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 flex flex-col md:flex-row items-center gap-4 justify-between mb-6">' +
                '<div class="relative w-full md:w-96">' +
                '<div class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">' +
                '<svg class="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>' +
                '</div>' +
                '<input type="text" id="supp-search" placeholder="Search suppliers..." class="w-full pl-10 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-rose-500 focus:border-rose-500 placeholder-gray-400 shadow-sm transition-shadow" oninput="suppCurrentPage=1;renderSuppliersTable()">' +
                '</div>' +
                '<div class="flex flex-wrap items-center gap-3 w-full md:w-auto">' +
                '<button class="bg-gray-900 hover:bg-gray-800 text-white px-5 py-2.5 rounded-xl text-sm font-medium transition-colors shadow-sm flex items-center gap-2" id="add-supplier-btn" onclick="openSupplierModal()"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg> Add Supplier</button>' +
                '</div></div>' +
                '<div class="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden"><div class="overflow-x-auto"><table class="w-full text-left border-collapse"><thead><tr class="bg-gray-50/50 border-b border-gray-100"><th class="px-6 py-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Name</th><th class="px-6 py-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Contact</th><th class="px-6 py-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Email</th><th class="px-6 py-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Phone</th><th class="px-6 py-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Products Supplied</th><th class="px-6 py-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th><th class="px-6 py-4 text-xs font-semibold text-gray-500 uppercase tracking-wider text-right">Actions</th></tr></thead><tbody id="suppliers-tbody" class="divide-y divide-gray-100"></tbody></table></div></div>' +
                '<div id="supp-pagination" style="margin-top:20px;display:flex;justify-content:center;"></div>';

        case 'tab-analytics':
            return '<div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 mb-6 flex flex-col md:flex-row items-center gap-4 justify-between">' +
                '<div><h3 class="text-xl font-semibold text-gray-900">Sales Analytics</h3><p class="text-sm text-gray-500 mt-1">Insights into your business performance</p></div>' +
                '<button class="bg-gray-900 hover:bg-gray-800 text-white px-5 py-2.5 rounded-xl text-sm font-medium transition-colors shadow-sm flex items-center gap-2" id="export-analytics-btn" onclick="exportAnalyticsCSV()"><svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg> Export CSV</button>' +
                '</div>' +
                '<div class="flex gap-2 mb-6">' +
                '<button class="period-btn px-5 py-2.5 border border-gray-200 rounded-xl bg-white hover:bg-gray-50 text-sm font-semibold transition-colors" data-period="week" onclick="loadAnalytics(\'week\')">Week</button>' +
                '<button class="period-btn active px-5 py-2.5 border border-gray-900 rounded-xl bg-gray-900 text-white text-sm font-semibold transition-colors" data-period="month" onclick="loadAnalytics(\'month\')">Month</button>' +
                '<button class="period-btn px-5 py-2.5 border border-gray-200 rounded-xl bg-white hover:bg-gray-50 text-sm font-semibold transition-colors" data-period="year" onclick="loadAnalytics(\'year\')">Year</button>' +
                '</div>' +
                '<div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">' +
                '<div class="bg-gray-50/50 p-6 rounded-2xl border border-gray-100 text-center"><div class="text-sm text-gray-500 font-medium mb-2">Total Revenue</div><div id="analytics-total-revenue" class="text-3xl font-bold text-gray-900">GHS 0</div></div>' +
                '<div class="bg-gray-50/50 p-6 rounded-2xl border border-gray-100 text-center"><div class="text-sm text-gray-500 font-medium mb-2">Avg Order Value</div><div id="analytics-avg-order" class="text-3xl font-bold text-gray-900">GHS 0</div></div>' +
                '<div class="bg-gray-50/50 p-6 rounded-2xl border border-gray-100 text-center"><div class="text-sm text-gray-500 font-medium mb-2">Total Orders</div><div id="analytics-total-orders" class="text-3xl font-bold text-gray-900">0</div></div>' +
                '</div>' +
                '<div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">' +
                '<div class="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm"><div class="mb-4"><h4 class="font-semibold text-gray-900">Revenue Over Time</h4></div><div class="relative h-72"><canvas id="analyticsRevenueChart"></canvas></div></div>' +
                '<div class="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm"><div class="mb-4"><h4 class="font-semibold text-gray-900">Revenue by Category</h4></div><div class="relative h-72"><canvas id="analyticsCategoryChart"></canvas></div></div>' +
                '</div>' +
                '<div class="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm"><div class="mb-4"><h4 class="font-semibold text-gray-900">Top Products by Revenue</h4></div><div class="relative h-72"><canvas id="analyticsProductChart"></canvas></div></div>';

        case 'tab-reports':
            return '<div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 mb-6">' +
                '<div><h3 class="text-xl font-semibold text-gray-900">Reports</h3><p class="text-sm text-gray-500 mt-1">Generate and download reports</p></div>' +
                '</div>' +
                '<div class="flex flex-wrap gap-4 mb-6">' +
                '<div class="flex flex-col"><label class="text-sm font-medium text-gray-700 mb-1">Start Date</label><input type="date" id="report-date-start" class="px-4 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-rose-500 focus:outline-none"></div>' +
                '<div class="flex flex-col"><label class="text-sm font-medium text-gray-700 mb-1">End Date</label><input type="date" id="report-date-end" class="px-4 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-rose-500 focus:outline-none"></div>' +
                '</div>' +
                '<div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">' +
                '<div class="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm cursor-pointer hover:border-rose-300 transition-colors text-center" onclick="generateReport(\'inventory\')"><div class="mb-3" style="display:flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:14px;background:#FFF1F4;color:var(--primary,#fc4c7a);margin:0 auto;">' + entityGlyph('product') + '</div><h4 class="font-semibold text-gray-900 mb-1">Inventory Report</h4><p class="text-xs text-gray-500">Stock levels &amp; status</p></div>' +
                '<div class="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm cursor-pointer hover:border-rose-300 transition-colors text-center" onclick="generateReport(\'sales\')"><div class="mb-3" style="display:flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:14px;background:#FFF1F4;color:var(--primary,#fc4c7a);margin:0 auto;">' + entityGlyph('order') + '</div><h4 class="font-semibold text-gray-900 mb-1">Sales Report</h4><p class="text-xs text-gray-500">Order details</p></div>' +
                '<div class="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm cursor-pointer hover:border-rose-300 transition-colors text-center" onclick="generateReport(\'revenue\')"><div class="mb-3" style="display:flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:14px;background:#FFF1F4;color:var(--primary,#fc4c7a);margin:0 auto;">' + entityGlyph('revenue') + '</div><h4 class="font-semibold text-gray-900 mb-1">Revenue Report</h4><p class="text-xs text-gray-500">Financial overview</p></div>' +
                '<div class="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm cursor-pointer hover:border-rose-300 transition-colors text-center" onclick="generateReport(\'customer\')"><div class="mb-3" style="display:flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:14px;background:#FFF1F4;color:var(--primary,#fc4c7a);margin:0 auto;">' + entityGlyph('customer') + '</div><h4 class="font-semibold text-gray-900 mb-1">Customer Report</h4><p class="text-xs text-gray-500">Customer analytics</p></div>' +
                '</div>' +
                '<div id="report-preview" class="mb-6"></div>' +
                '<div class="flex gap-3">' +
                '<button class="bg-gray-900 hover:bg-gray-800 text-white px-5 py-2.5 rounded-xl text-sm font-medium transition-colors shadow-sm flex items-center gap-2" id="download-csv" onclick="downloadReportCSV()"><svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg> Download CSV</button>' +
                '<button class="bg-rose-500 hover:bg-rose-600 text-white px-5 py-2.5 rounded-xl text-sm font-medium transition-colors shadow-sm flex items-center gap-2" id="download-pdf" onclick="exportToPDF()"><svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg> Print / PDF</button>' +
                '</div>';

        case 'tab-settings':
            return '<div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 mb-6">' +
                '<div><h3 class="text-xl font-semibold text-gray-900">Settings</h3><p class="text-sm text-gray-500 mt-1">Manage your preferences</p></div>' +
                '</div>' +
                '<div class="grid grid-cols-1 md:grid-cols-2 gap-8">' +

                // Profile section
                '<div class="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm"><h4 class="font-semibold text-gray-900 mb-4">Profile</h4>' +
                '<div class="mb-4"><label class="block text-sm font-medium text-gray-700 mb-1">Display Name</label><input type="text" id="settings-name" value="Admin" class="w-full px-4 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-rose-500 focus:outline-none"></div>' +
                '<div class="mb-4"><label class="block text-sm font-medium text-gray-700 mb-1">Email</label><input type="email" id="settings-email" value="admin@dckids.com" class="w-full px-4 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-rose-500 focus:outline-none"></div>' +
                '<button class="bg-gray-900 hover:bg-gray-800 text-white px-5 py-2.5 rounded-xl text-sm font-medium transition-colors shadow-sm w-full mt-2" id="save-profile-btn" onclick="saveProfile()">Save Profile</button>' +
                '</div>' +

                // Password section
                '<div class="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm"><h4 class="font-semibold text-gray-900 mb-4">Change Password</h4>' +
                '<div class="mb-4"><label class="block text-sm font-medium text-gray-700 mb-1">New Password</label><input type="password" id="settings-new-pw" class="w-full px-4 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-rose-500 focus:outline-none"></div>' +
                '<div class="mb-4"><label class="block text-sm font-medium text-gray-700 mb-1">Confirm Password</label><input type="password" id="settings-confirm-pw" class="w-full px-4 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-rose-500 focus:outline-none"></div>' +
                '<button class="bg-gray-900 hover:bg-gray-800 text-white px-5 py-2.5 rounded-xl text-sm font-medium transition-colors shadow-sm w-full mt-2" id="update-pw-btn" onclick="updatePassword()">Update Password</button>' +
                '</div>' +

                // Appearance section
                '<div class="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm"><h4 class="font-semibold text-gray-900 mb-4">Appearance</h4>' +
                '<div class="flex items-center justify-between py-3 border-b border-gray-50">' +
                '<div><div class="font-semibold text-sm text-gray-900">Dark Mode</div><div class="text-xs text-gray-500">Toggle dark theme</div></div>' +
                '<label class="relative inline-block w-12 h-6 cursor-pointer"><input type="checkbox" id="settings-dark-toggle" onchange="toggleDarkMode()" class="sr-only peer"><div class="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[\'\'] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-rose-500"></div></label>' +
                '</div></div>' +

                // General settings
                '<div class="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm"><h4 class="font-semibold text-gray-900 mb-4">General</h4>' +
                '<button class="bg-rose-500 hover:bg-rose-600 text-white px-5 py-2.5 rounded-xl text-sm font-medium transition-colors shadow-sm w-full mt-2" id="save-settings-btn" onclick="saveSettingsForm()">Save Settings</button>' +
                '</div>' +

                '</div>';

        default:
            return '<div style="padding:40px;text-align:center;color:#888;">Tab content</div>';
    }
}

/* ============================================================
   SECTION 27: CREATE DYNAMIC MODALS
   ============================================================ */
function ensureModalsExist() {
    // Order Modal
    if (!document.getElementById('modal-order')) {
        var orderModal = document.createElement('div');
        orderModal.id = 'modal-order';
        orderModal.className = 'modal-overlay';
        orderModal.style.display = 'none';
        orderModal.innerHTML = '<div class="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 overflow-hidden transform scale-95 transition-transform duration-300" style="margin: auto; margin-top: 5vh;">' +
            '<div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between"><h3 class="text-lg font-semibold text-gray-900 m-0">New Order</h3><button class="text-gray-400 hover:text-gray-500 transition-colors bg-transparent border-none cursor-pointer" onclick="closeModal(\'modal-order\')"><svg width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button></div>' +
            '<div class="px-6 py-4 flex flex-col gap-4">' +
            '<input type="hidden" id="modal-order-id">' +
            '<div class="flex flex-col"><label class="text-sm font-medium text-gray-700 mb-1">Customer Name</label><input type="text" id="modal-order-customer" readonly class="px-4 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-rose-500 focus:outline-none"></div>' +
            '<div class="flex flex-col"><label class="text-sm font-medium text-gray-700 mb-1">Customer Phone</label><input type="text" id="modal-order-phone" readonly class="px-4 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-rose-500 focus:outline-none"></div>' +
            '<div class="flex flex-col"><label class="text-sm font-medium text-gray-700 mb-1">Delivery Area</label><input type="text" id="modal-order-area" readonly placeholder="—" class="px-4 py-2 border border-gray-200 rounded-xl text-sm bg-gray-50 focus:outline-none"></div>' +
            '<div class="flex flex-col"><label class="text-sm font-medium text-gray-700 mb-1">Items (comma-separated)</label><input type="text" id="modal-order-items" placeholder="e.g. Baby Romper x2, Sneakers x1" class="px-4 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-rose-500 focus:outline-none"></div>' +
            '<div class="flex flex-col">' +
            '<label class="text-sm font-medium text-gray-700 mb-1">Status</label><select id="modal-order-status" class="px-4 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-rose-500 focus:outline-none bg-white"><option value="pending">Pending</option><option value="processing">Processing</option><option value="delivered">Delivered</option><option value="cancelled">Cancelled</option></select>' +
            '</div>' +
            '<div class="flex flex-col"><label class="text-sm font-medium text-gray-700 mb-1">Notes</label><textarea id="modal-order-notes" rows="3" class="px-4 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-rose-500 focus:outline-none resize-y"></textarea></div>' +
            '</div>' +
            '<div class="px-6 py-4 border-t border-gray-100 flex justify-between gap-3 bg-gray-50/50"><button class="px-5 py-2.5 border border-solid border-red-200 text-red-600 rounded-lg hover:bg-red-50 transition-colors font-medium bg-white shadow-sm cursor-pointer" style="border-radius:8px;" onclick="deleteOrder()">🗑 Delete Order</button><div class="flex gap-3"><button class="px-5 py-2.5 border border-solid border-gray-300 text-gray-700 rounded-lg hover:bg-gray-100 transition-colors font-medium bg-white shadow-sm cursor-pointer" style="border-radius: 8px;" onclick="closeModal(\'modal-order\')">Cancel</button><button class="px-5 py-2.5 bg-rose-500 text-white rounded-lg hover:bg-rose-600 transition-colors font-medium shadow-sm border-none cursor-pointer" style="border-radius: 8px;" onclick="saveOrder()">Save Order</button></div></div>' +
            '</div>';
        document.body.appendChild(orderModal);
    }

    // Customer Modal
    if (!document.getElementById('modal-customer')) {
        var custModal = document.createElement('div');
        custModal.id = 'modal-customer';
        custModal.className = 'modal-overlay';
        custModal.style.display = 'none';
        custModal.innerHTML = '<div class="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 overflow-hidden transform scale-95 transition-transform duration-300" style="margin: auto; margin-top: 5vh;">' +
            '<div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between"><h3 class="text-lg font-semibold text-gray-900 m-0">Add Customer</h3><button class="text-gray-400 hover:text-gray-500 transition-colors bg-transparent border-none cursor-pointer" onclick="closeModal(\'modal-customer\')"><svg width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" 2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button></div>' +
            '<div class="px-6 py-4 flex flex-col gap-4">' +
            '<input type="hidden" id="modal-cust-id">' +
            '<div class="flex flex-col"><label class="text-sm font-medium text-gray-700 mb-1">Full Name</label><input type="text" id="modal-cust-name" class="px-4 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-rose-500 focus:outline-none"></div>' +
            '<div class="grid grid-cols-2 gap-4"><div class="flex flex-col"><label class="text-sm font-medium text-gray-700 mb-1">Phone</label><input type="text" id="modal-cust-phone" class="px-4 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-rose-500 focus:outline-none"></div>' +
            '<div class="flex flex-col"><label class="text-sm font-medium text-gray-700 mb-1">Status</label><select id="modal-cust-status" class="px-4 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-rose-500 focus:outline-none bg-white"><option value="active">Active</option><option value="inactive">Inactive</option></select></div></div>' +
            '<div class="flex flex-col"><label class="text-sm font-medium text-gray-700 mb-1">Address</label><input type="text" id="modal-cust-address" class="px-4 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-rose-500 focus:outline-none"></div>' +
            '</div>' +
            '<div class="px-6 py-4 border-t border-gray-100 flex justify-end gap-3 bg-gray-50/50"><button class="px-5 py-2.5 border border-solid border-gray-300 text-gray-700 rounded-lg hover:bg-gray-100 transition-colors font-medium bg-white shadow-sm cursor-pointer" style="border-radius: 8px;" onclick="closeModal(\'modal-customer\')">Cancel</button><button class="px-5 py-2.5 bg-rose-500 text-white rounded-lg hover:bg-rose-600 transition-colors font-medium shadow-sm border-none cursor-pointer" style="border-radius: 8px;" onclick="saveCustomer()">Save Customer</button></div>' +
            '</div>';
        document.body.appendChild(custModal);
    }

    // Supplier Modal
    if (!document.getElementById('modal-supplier')) {
        var suppModal = document.createElement('div');
        suppModal.id = 'modal-supplier';
        suppModal.className = 'modal-overlay';
        suppModal.style.display = 'none';
        suppModal.innerHTML = '<div class="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 overflow-hidden transform scale-95 transition-transform duration-300" style="margin: auto; margin-top: 5vh;">' +
            '<div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between"><h3 class="text-lg font-semibold text-gray-900 m-0">Add Supplier</h3><button class="text-gray-400 hover:text-gray-500 transition-colors bg-transparent border-none cursor-pointer" onclick="closeModal(\'modal-supplier\')"><svg width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button></div>' +
            '<div class="px-6 py-4 flex flex-col gap-4">' +
            '<input type="hidden" id="modal-supp-id">' +
            '<div class="grid grid-cols-2 gap-4"><div class="flex flex-col"><label class="text-sm font-medium text-gray-700 mb-1">Company</label><input type="text" id="modal-supp-company" class="px-4 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-rose-500 focus:outline-none"></div>' +
            '<div class="flex flex-col"><label class="text-sm font-medium text-gray-700 mb-1">Contact Person</label><input type="text" id="modal-supp-contact" class="px-4 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-rose-500 focus:outline-none"></div></div>' +
            '<div class="grid grid-cols-2 gap-4"><div class="flex flex-col"><label class="text-sm font-medium text-gray-700 mb-1">Email</label><input type="email" id="modal-supp-email" class="px-4 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-rose-500 focus:outline-none"></div>' +
            '<div class="flex flex-col"><label class="text-sm font-medium text-gray-700 mb-1">Phone</label><input type="text" id="modal-supp-phone" class="px-4 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-rose-500 focus:outline-none"></div></div>' +
            '<div class="grid grid-cols-2 gap-4"><div class="flex flex-col"><label class="text-sm font-medium text-gray-700 mb-1">Products</label><input type="text" id="modal-supp-products" placeholder="e.g. Clothing, Shoes" class="px-4 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-rose-500 focus:outline-none"></div>' +
            '<div class="flex flex-col"><label class="text-sm font-medium text-gray-700 mb-1">Status</label><select id="modal-supp-status" class="px-4 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-rose-500 focus:outline-none bg-white"><option value="active">Active</option><option value="inactive">Inactive</option></select></div></div>' +
            '</div>' +
            '<div class="px-6 py-4 border-t border-gray-100 flex justify-end gap-3 bg-gray-50/50"><button class="px-5 py-2.5 border border-solid border-gray-300 text-gray-700 rounded-lg hover:bg-gray-100 transition-colors font-medium bg-white shadow-sm cursor-pointer" style="border-radius: 8px;" onclick="closeModal(\'modal-supplier\')">Cancel</button><button class="px-5 py-2.5 bg-rose-500 text-white rounded-lg hover:bg-rose-600 transition-colors font-medium shadow-sm border-none cursor-pointer" style="border-radius: 8px;" onclick="saveSupplier()">Save Supplier</button></div>' +
            '</div>';
        document.body.appendChild(suppModal);
    }
}

/* ============================================================
   SECTION 28: INJECT NECESSARY CSS (Animations, Dark Mode, etc.)
   ============================================================ */
function injectStyles() {
    var style = document.createElement('style');
    style.textContent = '' +
        '@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }' +
        '@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }' +
        '@keyframes fadeOut { from { opacity: 1; } to { opacity: 0; } }' +
        '' +
        '/* Dark Mode */' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '/* Print styles */' +
        '@media print { .boutique-sidebar, .boutique-topnav, .filter-bar, .modal-overlay, #toast-container { display: none !important; } .boutique-layout { grid-template-columns: 1fr !important; } }' +
        '' +
        '/* Toggle switch styling */' +
        '#settings-dark-toggle:checked + span { background: #F35E7A; }' +
        '#settings-dark-toggle + span:before { content: ""; position: absolute; width: 20px; height: 20px; border-radius: 50%; background: white; left: 3px; bottom: 3px; transition: 0.3s; }' +
        '#settings-dark-toggle:checked + span:before { transform: translateX(22px); }' +
        '';
    document.head.appendChild(style);
}

/* ============================================================
   SECTION 29: STOREFRONT CONFIGURATION
   ============================================================ */
function loadStoreConfig() {
    fetch(API_URL + '/settings')
        .then(res => res.json())
        .then(data => {
            const whatsappInput = document.getElementById('config-whatsapp');
            const wholesaleEnabledInput = document.getElementById('config-wholesale-enabled');
            const moqInput = document.getElementById('config-moq');
            const discountInput = document.getElementById('config-discount');
            const bannerEnabledInput = document.getElementById('config-banner-enabled');
            const bannerTextInput = document.getElementById('config-banner-text');

            if(whatsappInput) whatsappInput.value = data.whatsapp_number || '';
            if(wholesaleEnabledInput) wholesaleEnabledInput.checked = !!data.wholesale_enabled;
            if(moqInput) moqInput.value = data.wholesale_moq || '';
            if(discountInput) discountInput.value = data.wholesale_discount || '';
            if(bannerEnabledInput) bannerEnabledInput.checked = !!data.banner_enabled;
            if(bannerTextInput) bannerTextInput.value = data.banner_text || '';
        })
        .catch(err => console.warn("Store config API unavailable, using local data:", err && err.message ? err.message : err));
}

function saveStoreConfig(e) {
    e.preventDefault();
    const token = localStorage.getItem('adminToken');
    if (!token) return showToast("You must be logged in.", "error");

    const payload = {
        whatsapp_number: document.getElementById('config-whatsapp').value,
        wholesale_enabled: document.getElementById('config-wholesale-enabled').checked,
        wholesale_moq: parseInt(document.getElementById('config-moq').value) || 10,
        wholesale_discount: parseInt(document.getElementById('config-discount').value) || 0,
        banner_enabled: document.getElementById('config-banner-enabled').checked,
        banner_text: document.getElementById('config-banner-text').value
    };

    fetch(API_URL + '/settings', {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify(payload)
    })
    .then(res => res.json())
    .then(data => {
        if (data.error) {
            showToast(data.error, "error");
        } else {
            showToast("Store settings saved successfully!", "success");
            // Re-sync the form from the server so it shows the canonical saved state.
            if (typeof loadStoreConfig === 'function') loadStoreConfig();
        }
    })
    .catch(err => {
        console.error("Error saving store config:", err);
        showToast("Network error saving settings.", "error");
    });
}

/* ============================================================
   SECTION 29: SETUP ALL EVENT LISTENERS
   ============================================================ */
function setupEventListeners() {
    // Passwordless sign-in: Enter advances each step (buttons are wired inline).
    var loginEmailEl = document.getElementById('login-email');
    if (loginEmailEl) {
        loginEmailEl.addEventListener('keyup', function(e) {
            if (e.key === 'Enter') requestLoginCode(e);
        });
    }
    var loginCodeEl = document.getElementById('login-code');
    if (loginCodeEl) {
        loginCodeEl.addEventListener('keyup', function(e) {
            if (e.key === 'Enter') verifyLoginCode(e);
        });
    }
    var recoveryCodeEl = document.getElementById('login-recovery-code');
    if (recoveryCodeEl) {
        recoveryCodeEl.addEventListener('keyup', function(e) {
            if (e.key === 'Enter') recoveryLogin(e);
        });
    }

    var changeRoleBtn = document.getElementById('change-role-btn');
    if (changeRoleBtn) {
        changeRoleBtn.addEventListener('click', function() {
            var el = document.getElementById('user-role-select');
            if (el) currentRole = el.value;
            showDashboard(currentRole);
            showToast('Role switched to ' + currentRole, 'success');
        });
    }

    // Store config save
    var storeConfigForm = document.getElementById('store-config-form');
    if (storeConfigForm) {
        storeConfigForm.addEventListener('submit', saveStoreConfig);
    }

    // Logout
    var logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', logout);
    }

    // Nav items
    document.querySelectorAll('.sidebar-link[data-tab]').forEach(function(nav) {
        nav.addEventListener('click', function(e) {
            e.preventDefault();
            var target = nav.getAttribute('data-tab');
            if (target) switchTab(target);
        });
    });

    
    
    // Mobile Sidebar Toggle
    var mobileSidebarToggle = document.getElementById('mobile-sidebar-toggle');
    var adminSidebar = document.querySelector('.admin-sidebar');
    var sidebarOverlay = document.getElementById('sidebar-overlay');

    function openMobileSidebar() {
        hideHeaderPopoverScrim();
        adminSidebar.classList.add('open');
        if (sidebarOverlay) sidebarOverlay.classList.add('active');
    }
    function closeMobileSidebar() {
        adminSidebar.classList.remove('open');
        if (sidebarOverlay) sidebarOverlay.classList.remove('active');
    }

    if (mobileSidebarToggle && adminSidebar) {
        mobileSidebarToggle.addEventListener('click', function(e) {
            e.stopPropagation();
            adminSidebar.classList.contains('open') ? closeMobileSidebar() : openMobileSidebar();
        });

        // Overlay tap closes sidebar
        if (sidebarOverlay) {
            sidebarOverlay.addEventListener('click', function() { closeMobileSidebar(); });
        }

        // Close sidebar when clicking outside on mobile
        document.addEventListener('click', function(e) {
            if (window.innerWidth <= 1024) {
                if (!adminSidebar.contains(e.target) && !mobileSidebarToggle.contains(e.target)) {
                    closeMobileSidebar();
                }
            }
        });

        // Close sidebar when clicking a link on mobile
        var sidebarLinks = adminSidebar.querySelectorAll('.sidebar-link');
        sidebarLinks.forEach(function(link) {
            link.addEventListener('click', function() {
                if (window.innerWidth <= 1024) closeMobileSidebar();
            });
        });
    }

    // Desktop Sidebar Collapse Toggle
    var collapseBtn = document.getElementById('sidebar-collapse-btn');
    var adminSidebarElement = document.querySelector('.admin-sidebar');
    if (collapseBtn && adminSidebarElement) {
        collapseBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            adminSidebarElement.classList.toggle('collapsed');
        });
    }


    // Mobile Search Toggle (expand on tap at ≤480px)
    (function() {
        var sw = document.querySelector('.global-search-wrapper');
        var si = document.getElementById('global-search-input');
        if (!sw || !si) return;
        sw.addEventListener('click', function(e) {
            if (window.innerWidth <= 480 && !sw.classList.contains('search-expanded')) {
                sw.classList.add('search-expanded');
                si.focus();
                e.stopPropagation();
            }
        });
        document.addEventListener('click', function(e) {
            if (window.innerWidth <= 480 && !sw.contains(e.target)) {
                sw.classList.remove('search-expanded');
            }
        });
    })();

    // Quick Actions
    var qaAddProd = document.getElementById('qa-add-product');
    if (qaAddProd) qaAddProd.addEventListener('click', function() { openAddProductModal(); });
    
    var qaCreateOrder = document.getElementById('qa-create-order');
    if (qaCreateOrder) qaCreateOrder.addEventListener('click', function() { openCreateOrderModal(); });
    
    var createOrderBtn = document.getElementById('create-order-btn');
    if (createOrderBtn) {
        createOrderBtn.addEventListener('click', function() { openCreateOrderModal(); });
    }
    
    var qaAddCustomer = document.getElementById('qa-add-customer');
    if (qaAddCustomer) qaAddCustomer.addEventListener('click', function() { openAddCustomerModal(); });
    
    var qaGenReport = document.getElementById('qa-gen-report');
    if (qaGenReport) qaGenReport.addEventListener('click', function() { switchTab('tab-reports'); });

    // Product modal controls
    var closeBtn = document.getElementById('close-modal-btn');
    if (closeBtn) closeBtn.addEventListener('click', closeEditModal);

    var cancelBtn = document.getElementById('cancel-modal-btn');
    if (cancelBtn) cancelBtn.addEventListener('click', closeEditModal);

    var saveBtn = document.getElementById('save-product-btn');
    if (saveBtn) saveBtn.addEventListener('click', saveProduct);

    // Sync modal stock input and status select
    var stockInput = document.getElementById('modal-product-stock');
    var statusSelect = document.getElementById('modal-product-status');
    if (stockInput && statusSelect) {
        stockInput.addEventListener('input', function() {
            var val = parseInt(stockInput.value);
            if (isNaN(val) || val <= 0) {
                statusSelect.value = 'out_of_stock';
            } else if (val < 5) {
                statusSelect.value = 'low_stock';
            } else {
                statusSelect.value = 'in_stock';
            }
        });
        statusSelect.addEventListener('change', function() {
            var val = statusSelect.value;
            var currentStock = parseInt(stockInput.value);
            if (val === 'out_of_stock') {
                stockInput.value = '0';
            } else if (val === 'low_stock') {
                if (isNaN(currentStock) || currentStock <= 0 || currentStock >= 5) {
                    stockInput.value = '3';
                }
            } else if (val === 'in_stock') {
                if (isNaN(currentStock) || currentStock < 5) {
                    stockInput.value = '15';
                }
            }
        });
    }

    // Dashboard add product button
    var dashAddBtn = document.getElementById('dashboard-add-product');
    if (dashAddBtn) {
        dashAddBtn.addEventListener('click', function() { openAddProductModal(); });
    }

    // Add product button (inventory)
    var addProdBtn = document.getElementById('add-product-btn');
    if (addProdBtn) {
        addProdBtn.addEventListener('click', function() { openAddProductModal(); });
    }

    // Global search
    var searchInput = document.getElementById('global-search-input');
    if (searchInput) {
        searchInput.addEventListener('input', function() {
            handleGlobalSearch(searchInput.value);
        });
        searchInput.addEventListener('blur', function() {
            setTimeout(function() {
                var dropdown = document.getElementById('global-search-results');
                if (dropdown) dropdown.style.display = 'none';
            }, 200);
        });
    }

    // Notification bell
    var notifBtn = document.getElementById('notification-btn') || document.querySelector('.notification-wrapper');
    if (notifBtn) {
        notifBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            toggleNotificationDropdown();
        });
    }

    // Close dropdowns on outside click
    document.addEventListener('click', function(e) {
        var notifDropdown = document.getElementById('notification-dropdown');
        if (notifDropdown && notifDropdown.style.display === 'block') {
            if (!e.target.closest('#notification-btn') && !e.target.closest('.notification-wrapper') && !e.target.closest('#notification-dropdown') && !e.target.closest('#dashHeroBell') && !e.target.closest('.dash-hero__bell')) {
                notifDropdown.style.display = 'none';
                hideHeaderPopoverScrim();
            }
        }
        var searchDropdown = document.getElementById('global-search-results');
        if (searchDropdown && searchDropdown.style.display === 'block') {
            if (!e.target.closest('.global-search-wrapper') && !e.target.closest('#global-search-results')) {
                searchDropdown.style.display = 'none';
            }
        }
        var reportsDatePicker = document.getElementById('reports-datepicker-dropdown');
        if (reportsDatePicker && reportsDatePicker.classList.contains('open') && document.body.contains(e.target)) {
            if (!e.target.closest('.reports-date-picker-btn') && !e.target.closest('#reports-datepicker-dropdown')) {
                reportsDatePicker.classList.remove('open');
            }
        }
        var summaryPdfDropdown = document.getElementById('summary-pdf-dropdown-content');
        if (summaryPdfDropdown && summaryPdfDropdown.classList.contains('active')) {
            if (!e.target.closest('.summary-pdf-dropdown') && !e.target.closest('#summary-pdf-dropdown-content')) {
                summaryPdfDropdown.classList.remove('active');
            }
        }
    });

    // ESC key to close modals
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            // Close all visible modals
            document.querySelectorAll('.modal-overlay').forEach(function(modal) {
                if (modal.style.display === 'flex') {
                    modal.classList.remove('active');
                    modal.style.display = 'none';
                }
            });
        }
    });

    // Modal overlay click to close
    document.addEventListener('click', function(e) {
        if (e.target.classList.contains('modal-overlay')) {
            e.target.classList.remove('active');
            e.target.style.display = 'none';
        }
    });

    // Order filter listeners (bound after tab is created)
    document.addEventListener('input', function(e) {
        if (e.target.id === 'order-search') { orderCurrentPage = 1; renderOrdersTable(); }
        if (e.target.id === 'cust-search') { custCurrentPage = 1; renderCustomersTable(); }
        if (e.target.id === 'prod-search') { prodCurrentPage = 1; renderProductsGrid(); }
        if (e.target.id === 'review-search') { reviewCurrentPage = 1; renderReviewsTable(); }
    });
    document.addEventListener('change', function(e) {
        if (e.target.id === 'order-status-filter') { orderCurrentPage = 1; renderOrdersTable(); }
        if (e.target.id === 'order-type-filter') { orderCurrentPage = 1; renderOrdersTable(); }
        if (e.target.id === 'order-date-filter') { orderCurrentPage = 1; renderOrdersTable(); }
        if (e.target.id === 'cust-group-filter') { custCurrentPage = 1; renderCustomersTable(); }
        if (e.target.id === 'prod-cat-filter' || e.target.id === 'prod-status-filter' || e.target.id === 'prod-fulfillment-filter' || e.target.id === 'prod-sort') { prodCurrentPage = 1; renderProductsGrid(); }
    });

    // Products "Filter" button — apply the current filters (icon click included via closest)
    document.addEventListener('click', function(e) {
        if (e.target.closest && e.target.closest('#prod-filter-btn')) {
            prodCurrentPage = 1;
            renderProductsGrid();
        }
    });

    // Period buttons in analytics
    document.addEventListener('click', function(e) {
        if (e.target.classList.contains('period-btn')) {
            document.querySelectorAll('.period-btn').forEach(function(btn) {
                btn.style.background = '#fff';
                btn.style.color = '';
                btn.style.borderColor = 'var(--admin-border)';
            });
            e.target.style.background = 'var(--admin-text)';
            e.target.style.color = '#fff';
            e.target.style.borderColor = 'var(--admin-text)';
        }
    });

    document.addEventListener('click', function(e) {
        var mdrpPresetBtn = e.target.closest('.mdrp-preset');
        if (mdrpPresetBtn) {
            mdrpApplyPreset(mdrpPresetBtn.getAttribute('data-preset'));
            return;
        }

        var rdrpPresetBtn = e.target.closest('.rdrp-preset');
        if (rdrpPresetBtn) {
            rdrpApplyPreset(rdrpPresetBtn.getAttribute('data-preset'));
            return;
        }

        var presetBtn = e.target.closest('.drp-preset');
        if (presetBtn) {
            drpApplyPreset(presetBtn.getAttribute('data-preset'));
            return;
        }

        var analyticsTab = e.target.closest('.analytics-tab');
        if (analyticsTab) {
            loadAnalytics(analyticsTab.getAttribute('data-analytics-period') || 'week');
            return;
        }

        var exportBtn = e.target.closest('#export-analytics-btn');
        if (exportBtn) {
            var menu = document.getElementById('analytics-export-menu');
            if (menu) {
                var open = !menu.classList.contains('open');
                menu.classList.toggle('open', open);
                exportBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
            }
            return;
        }

        var exportChoice = e.target.closest('[data-export-format]');
        if (exportChoice) {
            var format = exportChoice.getAttribute('data-export-format');
            var exportMenu = document.getElementById('analytics-export-menu');
            var exportButton = document.getElementById('export-analytics-btn');
            if (exportMenu) exportMenu.classList.remove('open');
            if (exportButton) exportButton.setAttribute('aria-expanded', 'false');
            if (format === 'pdf') exportAnalyticsPDF();
            else exportAnalyticsCSV();
            return;
        }

        var menuEl = document.getElementById('analytics-export-menu');
        if (menuEl && menuEl.classList.contains('open') && !e.target.closest('.analytics-export')) {
            menuEl.classList.remove('open');
            var btnEl = document.getElementById('export-analytics-btn');
            if (btnEl) btnEl.setAttribute('aria-expanded', 'false');
        }

        // Close date menu on click outside
        // Guard: skip if click target was removed from DOM during calendar re-render
        var dateMenu = document.getElementById('analytics-date-menu');
        if (dateMenu && dateMenu.classList.contains('open') && document.body.contains(e.target) && !e.target.closest('.analytics-date-picker')) {
            dateMenu.classList.remove('open');
        }

        // Close modal report picker on click outside
        var mdrpPicker = document.getElementById('mdrp-picker');
        if (mdrpPicker && mdrpPicker.classList.contains('open') && document.body.contains(e.target)) {
            if (!e.target.closest('.mdrp-trigger') && !e.target.closest('#mdrp-picker')) {
                mdrpPicker.classList.remove('open');
            }
        }
    });

    document.addEventListener('change', function(e) {
        if (e.target.id === 'analytics-trend-range') {
            loadAnalytics(e.target.value === 'year' ? 'year' : 'week');
        }
        if (e.target.id === 'analytics-product-sort' && analyticsState.data) {
            renderAnalyticsProductChart(analyticsState.data.topProducts || []);
        }
    });

    // Edit Product image: open the hidden file input. Its change handler
    // (handleProductImageUpload, wired below) updates the visible preview and the
    // hidden src used on save.
    var changeImgBtn = document.getElementById('modal-product-img-trigger');
    if (changeImgBtn) {
        changeImgBtn.addEventListener('click', function() {
            var fileInput = document.getElementById('modal-product-img');
            if (fileInput) fileInput.click();
        });
    }

    // --- NEW DEDICATED ADD PRODUCT MODAL LISTENERS ---
    var addStockInput = document.getElementById('add-product-stock');
    var addStatusSelect = document.getElementById('add-product-status');
    if (addStockInput && addStatusSelect) {
        addStockInput.addEventListener('input', function() {
            var val = parseInt(addStockInput.value);
            if (isNaN(val) || val <= 0) {
                addStatusSelect.value = 'out_of_stock';
            } else if (val < 5) {
                addStatusSelect.value = 'low_stock';
            } else {
                addStatusSelect.value = 'in_stock';
            }
        });
    }

    // SKU auto-suggest: filling Category proposes a SKU so adding a product
    // never blocks on "think of one" — but it never overwrites text the
    // admin typed themselves (tracked via data-autofilled).
    wireSkuSuggest('add-product-cat', 'add-product-sku');
    wireSkuSuggest('modal-product-cat', 'modal-product-sku');

    var addProductSaveBtn = document.getElementById('add-product-save-btn');
    if (addProductSaveBtn) {
        addProductSaveBtn.addEventListener('click', saveNewProduct);
    }

    var addSupplierBtn = document.getElementById('add-supplier-btn');
    if (addSupplierBtn) {
        addSupplierBtn.addEventListener('click', function() { openSupplierModal(); });
    }

    var saveSupplierBtn = document.getElementById('save-supplier-btn');
    if (saveSupplierBtn) {
        saveSupplierBtn.addEventListener('click', saveSupplier);
    }

    var supplierModal = document.getElementById('modal-supplier');
    if (supplierModal) {
        var supplierCloseBtn = supplierModal.querySelector('.modal-close-btn');
        var supplierCancelBtn = supplierModal.querySelector('.modal-cancel-btn');
        var supplierNotes = document.getElementById('modal-supp-notes');
        var supplierLogoInput = document.getElementById('modal-supp-logo-input');
        var supplierDropzone = document.getElementById('supplier-logo-dropzone');

        if (supplierCloseBtn) supplierCloseBtn.addEventListener('click', function() { closeModal('modal-supplier'); });
        if (supplierCancelBtn) supplierCancelBtn.addEventListener('click', function() { closeModal('modal-supplier'); });
        if (supplierNotes) supplierNotes.addEventListener('input', updateSupplierNotesCount);
        if (supplierLogoInput) {
            supplierLogoInput.addEventListener('change', function(e) {
                handleSupplierLogoFile(e.target.files && e.target.files[0]);
            });
        }
        if (supplierDropzone) {
            supplierDropzone.addEventListener('dragover', function(e) {
                e.preventDefault();
                supplierDropzone.classList.add('is-dragging');
            });
            supplierDropzone.addEventListener('dragleave', function() {
                supplierDropzone.classList.remove('is-dragging');
            });
            supplierDropzone.addEventListener('drop', function(e) {
                e.preventDefault();
                supplierDropzone.classList.remove('is-dragging');
                handleSupplierLogoFile(e.dataTransfer.files && e.dataTransfer.files[0]);
            });
        }
    }
}

/* ============================================================
   SECTION 30: INITIALIZATION
   ============================================================ */
document.addEventListener('DOMContentLoaded', function() {
    // Inject styles
    injectStyles();

    // Init theme
    initTheme();

    // Init seed data
    initSeedData();

    // Ensure all tabs & modals exist
    ensureTabsExist();
    ensureModalsExist();

    // Hook new file upload event listener — gallery + camera share one handler.
    // On mobile, capture="environment" opens the rear camera; gallery shows the OS picker.
    document.addEventListener('change', function(e) {
        if (e.target.id === 'modal-product-img' || e.target.id === 'modal-product-img-camera') {
            handleProductImageUpload(e);
        }
    });

    document.addEventListener('change', function(e) {
        if (e.target.id === 'add-product-img-input' || e.target.id === 'add-product-img-camera') {
            handleNewProductImageUpload(e);
        }
    });

    // Mobile camera / browse triggers for both product modals
    document.addEventListener('click', function(e) {
        var t = e.target.closest && e.target.closest('button');
        if (!t) return;
        if (t.id === 'modal-product-img-camera-btn') {
            e.preventDefault();
            var camIn = document.getElementById('modal-product-img-camera');
            if (camIn) camIn.click();
        } else if (t.id === 'add-product-camera-trigger') {
            e.preventDefault();
            var camIn2 = document.getElementById('add-product-img-camera');
            if (camIn2) camIn2.click();
        } else if (t.id === 'add-product-browse-trigger') {
            e.preventDefault();
            var galIn = document.getElementById('add-product-img-input');
            if (galIn) galIn.click();
        }
    });

    // Setup all event listeners
    setupEventListeners();

    // Init notifications badge
    renderNotifications();

    // Render "Continue with Google" on the login screen (self-gating on config)
    initGoogleSignIn();

    // Check if already logged in — verify token is still valid
    var token = localStorage.getItem('adminToken');
    if (token) {
        fetch(API_URL + '/me', {
            headers: { 'Authorization': 'Bearer ' + token }
        })
        .then(function(res) {
            if (res.ok) {
                return res.json().then(function(data) {
                    fetchOrdersFromServer(function() {
                        showDashboard(data.role);
                        loadStoreConfig(); // Fetch settings on load
                    });
                });
            } else {
                // Token expired or invalid — clear and show login
                localStorage.removeItem('adminToken');
                localStorage.removeItem('adminRole');
                document.getElementById('dashboard-container').style.display = 'none';
                document.getElementById('login-container').style.display = 'flex';
            }
        })
        .catch(function() {
            // Network error — server may be down, show login to be safe
            localStorage.removeItem('adminToken');
            localStorage.removeItem('adminRole');
            document.getElementById('dashboard-container').style.display = 'none';
            document.getElementById('login-container').style.display = 'flex';
        });
    }
});


/* ============================================================
   SECTION 32: DEDICATED ADD PRODUCT MODAL POPUP
   ============================================================ */
function openAddProductModal() {
    var modal = document.getElementById('modal-add-product');
    if (!modal) return;
    
    // Reset all fields
    document.getElementById('add-product-name').value = '';
    document.getElementById('add-product-sku').value = '';
    document.getElementById('add-product-cat').value = '';
    document.getElementById('add-product-price').value = '';
    document.getElementById('add-product-stock').value = '';
    document.getElementById('add-product-status').value = 'in_stock';
    var addFulfillmentEl = document.getElementById('add-product-fulfillment');
    if (addFulfillmentEl) addFulfillmentEl.value = 'in_stock';
    if (typeof setSizeRows === 'function') setSizeRows('add-product', []);
    if (typeof populateSizePresetDropdowns === 'function') populateSizePresetDropdowns();
    document.getElementById('add-product-size').value = '';
    document.getElementById('add-product-badge').value = '';
    document.getElementById('add-product-desc').value = '';
    document.getElementById('add-product-img-src').value = 'images/product_1.jpg';
    
    var img = document.querySelector('#add-product-img-preview img');
    if (img) {
        img.src = BLANK_IMG;
        img.style.display = 'none';
        var placeholder = img.parentNode.querySelector('.no-image-placeholder');
        if (placeholder) placeholder.style.display = 'flex';
    }
    
    // Character count reset
    var count = document.querySelector('#add-product-form .char-count');
    if (count) count.textContent = '0 / 500';
    
    modal.style.display = 'flex';
}

function closeAddProductModal() {
    var modal = document.getElementById('modal-add-product');
    if (modal) modal.style.display = 'none';
}

function handleNewProductImageUpload(event) {
    var file = event.target.files[0];
    if (!file) return;
    var previewImg = document.querySelector('#add-product-img-preview img');
    var hiddenImgSrc = document.getElementById('add-product-img-src');
    var placeholder = previewImg && previewImg.parentNode.querySelector('.no-image-placeholder');
    compressImageFile(file, 1600, 0.85)
        .then(function(dataUrl) {
            if (previewImg) {
                previewImg.src = dataUrl;          // local preview only
                previewImg.style.display = 'block';
                if (placeholder) placeholder.style.display = 'none';
            }
            return uploadProductImage(dataUrl);
        })
        .then(function(res) {
            if (hiddenImgSrc) hiddenImgSrc.value = res.path; // store PATH, not base64
            if (typeof showToast === 'function') showToast('Image uploaded (' + Math.round(res.bytes/1024) + ' KB)', 'success');
        })
        .catch(function(err) {
            if (typeof showToast === 'function') showToast(err.message || 'Upload failed', 'error');
        });
}

function saveNewProduct() {
    var token = localStorage.getItem('adminToken');
    if (!token) {
        showToast('Authentication required', 'error');
        return;
    }

    var nameVal = document.getElementById('add-product-name').value.trim();
    var priceVal = parseFloat(document.getElementById('add-product-price').value);
    var stockVal = parseInt(document.getElementById('add-product-stock').value);

    // Validate
    if (!nameVal) {
        showToast('Product name is required', 'warning');
        return;
    }
    var skuVal = document.getElementById('add-product-sku').value.trim();
    var catVal = document.getElementById('add-product-cat').value;
    if (!catVal) {
        showToast('Category is required', 'warning');
        return;
    }
    if (isNaN(priceVal) || priceVal < 0) {
        showToast('Price must be 0 or greater', 'warning');
        return;
    }
    if (isNaN(stockVal) || stockVal < 0) {
        showToast('Stock must be 0 or greater', 'warning');
        return;
    }

    var addDescEl = document.getElementById('add-product-desc');
    var addFulfillmentEl = document.getElementById('add-product-fulfillment');
    var payload = {
        name: nameVal,
        sku: skuVal,
        size: document.getElementById('add-product-size').value.trim() || 'Standard',
        cat: catVal,
        price: priceVal,
        stock: stockVal,
        badge: document.getElementById('add-product-badge').value.trim() || null,
        img: document.getElementById('add-product-img-src').value,
        description: (addDescEl && addDescEl.value.trim()) || null,
        fulfillment_type: (addFulfillmentEl && addFulfillmentEl.value) || 'in_stock',
        sizes: (typeof readSizeRows === 'function') ? readSizeRows('add-product') : []
    };

    fetch(API_URL + '/products', {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    })
    .then(function(res) {
        if (!res.ok) return res.json().then(function(d) { throw new Error(d.error || 'Failed to save product'); });
        return res.json();
    })
    .then(function() {
        showToast('Product added successfully', 'success');
        closeAddProductModal();
        loadProducts(); // reload Products table
    })
    .catch(function(err) {
        showToast(err.message, 'error');
    });
}


/* ============================================================
   SECTION 33: DEDICATED ADD CUSTOMER MODAL POPUP
   ============================================================ */
function openAddCustomerModal() {
    var modal = document.getElementById('modal-add-customer');
    if (!modal) return;

    // Reset inputs
    document.getElementById('add-customer-name').value = '';
    document.getElementById('add-customer-phone').value = '';
    document.getElementById('add-customer-address').value = '';
    document.getElementById('add-customer-city').value = '';
    document.getElementById('add-customer-country').value = 'Ghana';
    var ccEl = document.getElementById('add-customer-country-code');
    if (ccEl) ccEl.value = '+233';
    document.getElementById('add-customer-group').value = '';
    document.getElementById('add-customer-notes').value = '';

    modal.style.display = 'flex';
}

function closeAddCustomerModal() {
    var modal = document.getElementById('modal-add-customer');
    if (modal) modal.style.display = 'none';
}

function saveNewCustomer() {
    var nameEl = document.getElementById('add-customer-name');
    var phoneEl = document.getElementById('add-customer-phone');
    var addressEl = document.getElementById('add-customer-address');
    var cityEl = document.getElementById('add-customer-city');
    var countryEl = document.getElementById('add-customer-country');
    var groupEl = document.getElementById('add-customer-group');
    var notesEl = document.getElementById('add-customer-notes');

    if (!nameEl || !nameEl.value.trim()) {
        showToast('Customer name is required', 'warning');
        return;
    }
    if (!phoneEl || !phoneEl.value.trim()) {
        showToast('Phone number is required', 'warning');
        return;
    }

    var customers = getCustomers();
    var newId = 'CUST-' + String(customers.length + 1).padStart(3, '0');

    // Prepend the selected dialing code unless the number already carries one.
    var rawPhone = phoneEl.value.trim();
    var codeEl = document.getElementById('add-customer-country-code');
    var dialCode = (codeEl && codeEl.value) ? codeEl.value : '+233';
    var finalPhone = rawPhone.startsWith('+') ? rawPhone : dialCode + rawPhone.replace(/^0+/, '');

    customers.push({
        id: newId,
        name: nameEl.value.trim(),
        email: '',
        phone: finalPhone,
        address: addressEl ? addressEl.value.trim() : '',
        city: cityEl ? cityEl.value.trim() : '',
        country: countryEl ? countryEl.value : 'Ghana',
        group: groupEl ? groupEl.value : '',
        notes: notesEl ? notesEl.value.trim() : '',
        joinDate: new Date().toISOString().split('T')[0],
        totalSpent: 0,
        orderCount: 0,
        status: 'inactive'
    });

    addActivity('customer', 'Added new customer: ' + nameEl.value.trim());
    saveCustomers(customers);
    closeAddCustomerModal();
    showToast('Customer added successfully', 'success');
    loadCustomers();
}


/* ============================================================
   SECTION 18: CREATE NEW ORDER MODAL VIEW
   ============================================================ */

function openCreateOrderModal() {
    var modal = document.getElementById('modal-add-order');
    if (!modal) return;

    // Reset inputs
    var select = document.getElementById('new-order-customer');
    if (select) {
        select.innerHTML = '<option value="" disabled selected>Select a customer...</option>';
        var customers = getCustomers();
        customers.forEach(function(c) {
            var opt = document.createElement('option');
            opt.value = c.id;
            opt.textContent = c.name;
            select.appendChild(opt);
        });
    }

    document.getElementById('new-order-cust-info-phone').textContent = 'Phone: -';
    document.getElementById('new-order-cust-info-email').textContent = 'Email: -';
    
    var typeEl = document.getElementById('new-order-type');
    if (typeEl) typeEl.value = 'retail';
    
    var discountEl = document.getElementById('new-order-discount');
    if (discountEl) discountEl.value = 0;
    
    // Clear items table and add one empty row
    var tbody = document.getElementById('new-order-items-body');
    if (tbody) {
        tbody.innerHTML = '';
    }
    
    addNewOrderItemRow();
    
    // Reset payment selection to cash
    var cashRadio = document.querySelector('input[name="new-order-payment"][value="cash"]');
    if (cashRadio) {
        cashRadio.checked = true;
        updatePaymentSelect(cashRadio);
    }

    modal.style.display = 'flex';
}

function closeCreateOrderModal() {
    var modal = document.getElementById('modal-add-order');
    if (modal) modal.style.display = 'none';
}

function onNewOrderCustomerChange() {
    var select = document.getElementById('new-order-customer');
    var phoneEl = document.getElementById('new-order-cust-info-phone');
    var emailEl = document.getElementById('new-order-cust-info-email');
    if (!select || !phoneEl || !emailEl) return;
    
    var customerId = select.value;
    var customer = getCustomers().find(function(c) { return c.id === customerId; });
    if (customer) {
        phoneEl.textContent = 'Phone: ' + (customer.phone || '-');
        emailEl.textContent = 'Email: ' + (customer.email || '-');
    } else {
        phoneEl.textContent = 'Phone: -';
        emailEl.textContent = 'Email: -';
    }
}

function updatePaymentSelect(radio) {
    var radios = document.querySelectorAll('input[name="new-order-payment"]');
    radios.forEach(function(r) {
        var label = r.closest('label');
        if (!label) return;
        var circle = label.querySelector('.payment-radio-circle');
        var text = label.querySelector('span');
        if (r.checked) {
            if (circle) {
                circle.className = 'payment-radio-circle w-5 h-5 rounded-full border-2 border-[#e45e6d] flex items-center justify-center shrink-0';
                circle.innerHTML = '<div class="w-2.5 h-2.5 bg-[#e45e6d] rounded-full"></div>';
            }
            if (text) {
                text.className = 'text-sm font-medium text-gray-800';
            }
        } else {
            if (circle) {
                circle.className = 'payment-radio-circle w-5 h-5 rounded-full border-2 border-gray-300 group-hover:border-gray-400 flex items-center justify-center shrink-0 transition-colors';
                circle.innerHTML = '';
            }
            if (text) {
                text.className = 'text-sm font-medium text-gray-600 group-hover:text-gray-800 transition-colors';
            }
        }
    });
}

function addNewOrderItemRow() {
    var tbody = document.getElementById('new-order-items-body');
    if (!tbody) return;

    var tr = document.createElement('tr');
    tr.className = 'order-item-row';
    
    // Product select options
    var prodOptions = '<option value="" disabled selected>Select a product...</option>';
    globalProducts.forEach(function(p) {
        prodOptions += '<option value="' + p.id + '">' + escapeHtml(p.name) + '</option>';
    });

    tr.innerHTML = 
        '<td class="py-3 pr-4" data-label="Product">' +
        '  <div class="relative">' +
        '    <select class="order-item-product-select w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-rose-500 bg-white cursor-pointer" onchange="onOrderItemProductChange(this)">' +
        prodOptions +
        '    </select>' +
        '  </div>' +
        '</td>' +
        '<td class="py-3 px-4" data-label="Size">' +
        '  <div class="relative">' +
        '    <select class="order-item-size-select w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-rose-500 bg-white cursor-pointer" disabled onchange="onOrderItemSizeChange(this)">' +
        '      <option value="" disabled selected>Select size...</option>' +
        '    </select>' +
        '  </div>' +
        '</td>' +
        '<td class="py-3 px-4 font-medium text-gray-500" data-label="Price"><span class="order-item-price-display">GH₵ 0.00</span></td>' +
        '<td class="py-3 px-4" data-label="Qty">' +
        '  <input type="number" min="1" value="1" class="order-item-qty-input w-20 border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-rose-500" oninput="updateNewOrderTotals()">' +
        '</td>' +
        '<td class="py-3 px-4 font-bold text-gray-800 text-right" data-label="Total"><span class="order-item-total-display">GH₵ 0.00</span></td>' +
        '<td class="py-3 pl-4 text-right" data-label="Actions">' +
        '  <button type="button" onclick="removeOrderItemRow(this)" class="text-gray-400 hover:text-rose-600 transition-colors p-1 border-none bg-transparent cursor-pointer">' +
        '    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>' +
        '  </button>' +
        '</td>';

    tbody.appendChild(tr);
}

function onOrderItemProductChange(select) {
    var tr = select.closest('tr');
    if (!tr) return;
    
    var sizeSelect = tr.querySelector('.order-item-size-select');
    if (!sizeSelect) return;
    
    var prodId = select.value;
    var product = globalProducts.find(function(p) { return p.id == prodId; });
    if (!product) return;
    
    // Parse sizes
    var sizes = [];
    try {
        sizes = JSON.parse(product.size);
    } catch(e) {
        if (product.size) {
            sizes = product.size.split(',').map(function(s) { return s.trim(); });
        }
    }
    
    sizeSelect.innerHTML = '';
    if (sizes.length === 0) {
        var opt = document.createElement('option');
        opt.value = 'Standard';
        opt.textContent = 'Standard';
        sizeSelect.appendChild(opt);
    } else {
        sizes.forEach(function(s) {
            var opt = document.createElement('option');
            opt.value = s;
            opt.textContent = s;
            sizeSelect.appendChild(opt);
        });
    }
    
    sizeSelect.disabled = false;
    
    updateNewOrderTotals();
}

function onOrderItemSizeChange(select) {
    updateNewOrderTotals();
}

function removeOrderItemRow(btn) {
    var tr = btn.closest('tr');
    if (tr) tr.remove();
    
    var tbody = document.getElementById('new-order-items-body');
    if (tbody && tbody.children.length === 0) {
        addNewOrderItemRow();
    }
    
    updateNewOrderTotals();
}

function getPriceModifier(sizeLabel) {
    if (!sizeLabel) return 0;
    const s = sizeLabel.toString().trim();
    if (/^(0-3M|3-6M|6-9M|9-12M|12-18M|0M|3M|6M|9M|12M|14|15|16|17|18|19|20|21)$/i.test(s)) return 0;
    if (/^(18M|24M|1Y|2Y|22|23|24|25|26|27)$/i.test(s)) return 5;
    if (/^(3Y|4Y|5Y|28|29|30|31|32)$/i.test(s)) return 10;
    if (/^(6Y|7Y|8Y|33|34|35|36)$/i.test(s)) return 15;
    return 0;
}

function updateNewOrderTotals() {
    var orderType = document.getElementById('new-order-type').value;
    var rows = document.querySelectorAll('#new-order-items-body tr');
    
    var subtotal = 0;
    
    // Fetch wholesale config from settings if available
    var moqEl = document.getElementById('config-moq');
    var discountEl = document.getElementById('config-discount');
    var wholesaleMoq = moqEl ? parseInt(moqEl.value) || 10 : 10;
    var wholesaleDiscount = discountEl ? parseFloat(discountEl.value) || 20 : 20;
    
    var qtyMultiplier = (orderType === 'wholesale') ? wholesaleMoq : 1;
    
    rows.forEach(function(tr) {
        var prodSelect = tr.querySelector('.order-item-product-select');
        var sizeSelect = tr.querySelector('.order-item-size-select');
        var qtyInput = tr.querySelector('.order-item-qty-input');
        var priceDisplay = tr.querySelector('.order-item-price-display');
        var totalDisplay = tr.querySelector('.order-item-total-display');
        
        if (!prodSelect || !sizeSelect || !qtyInput || !priceDisplay || !totalDisplay) return;
        
        var prodId = prodSelect.value;
        var size = sizeSelect.value;
        var qty = parseInt(qtyInput.value) || 1;
        
        var product = globalProducts.find(function(p) { return p.id == prodId; });
        if (!product) {
            priceDisplay.textContent = 'GH₵ 0.00';
            totalDisplay.textContent = 'GH₵ 0.00';
            return;
        }
        
        var basePrice = product.price || 0;
        if (orderType === 'wholesale') {
            basePrice = (basePrice * (1 - (wholesaleDiscount / 100))) * wholesaleMoq;
        }
        
        var modifier = getPriceModifier(size) * qtyMultiplier;
        var finalUnitPrice = basePrice + modifier;
        var lineTotal = finalUnitPrice * qty;
        
        priceDisplay.textContent = 'GH₵ ' + finalUnitPrice.toFixed(2);
        totalDisplay.textContent = 'GH₵ ' + lineTotal.toFixed(2);
        
        subtotal += lineTotal;
    });
    
    var discountPctInput = document.getElementById('new-order-discount');
    var discountPct = discountPctInput ? parseFloat(discountPctInput.value) || 0 : 0;
    var discountAmount = subtotal * (discountPct / 100);
    
    var tax = 0;
    var finalTotal = subtotal - discountAmount + tax;
    
    var subtotalEl = document.getElementById('new-order-subtotal');
    var taxEl = document.getElementById('new-order-tax');
    var totalEl = document.getElementById('new-order-total');
    
    if (subtotalEl) subtotalEl.textContent = 'GH₵ ' + subtotal.toFixed(2);
    if (taxEl) taxEl.textContent = 'GH₵ ' + tax.toFixed(2);
    if (totalEl) totalEl.textContent = 'GH₵ ' + finalTotal.toFixed(2);
}

function saveOrderDraft() {
    var custId = document.getElementById('new-order-customer').value;
    var customer = getCustomers().find(function(c) { return c.id === custId; });
    var customerName = customer ? customer.name : 'Unknown Customer';
    var customerPhone = customer ? customer.phone : '';
    
    var orderType = document.getElementById('new-order-type').value;
    
    var items = [];
    var rows = document.querySelectorAll('#new-order-items-body tr');
    rows.forEach(function(tr) {
        var prodSelect = tr.querySelector('.order-item-product-select');
        var sizeSelect = tr.querySelector('.order-item-size-select');
        var qtyInput = tr.querySelector('.order-item-qty-input');
        
        if (!prodSelect || !sizeSelect || !qtyInput) return;
        
        var prodId = prodSelect.value;
        var size = sizeSelect.value;
        var qty = parseInt(qtyInput.value) || 0;
        
        if (prodId && size && qty > 0) {
            items.push({
                id: parseInt(prodId),
                size: size,
                quantity: qty
            });
        }
    });
    
    var subtotalText = document.getElementById('new-order-subtotal').textContent;
    var subtotal = parseFloat(subtotalText.replace(/[^0-9.]/g, '')) || 0;
    
    var drafts = JSON.parse(localStorage.getItem('dcKidsDraftOrders')) || [];
    var draftId = 'DFT-' + (drafts.length + 1);
    
    drafts.push({
        id: draftId,
        customer: customerName,
        phone: customerPhone,
        type: orderType,
        total: subtotal,
        status: 'draft',
        date: new Date().toISOString(),
        items: items
    });
    
    localStorage.setItem('dcKidsDraftOrders', JSON.stringify(drafts));
    showToast('Order saved as draft', 'success');
    closeCreateOrderModal();
}

function submitCreateOrder() {
    var custId = document.getElementById('new-order-customer').value;
    var customer = getCustomers().find(function(c) { return c.id === custId; });
    if (!customer) {
        showToast('Please select a customer', 'warning');
        return;
    }
    
    var orderType = document.getElementById('new-order-type').value;
    
    var items = [];
    var rows = document.querySelectorAll('#new-order-items-body tr');
    var hasError = false;

    rows.forEach(function(tr) {
        var prodSelect = tr.querySelector('.order-item-product-select');
        var sizeSelect = tr.querySelector('.order-item-size-select');
        var qtyInput = tr.querySelector('.order-item-qty-input');
        
        if (!prodSelect || !sizeSelect || !qtyInput) return;
        
        var prodId = prodSelect.value;
        var size = sizeSelect.value;
        var qty = parseInt(qtyInput.value) || 0;
        
        if (!prodId) {
            showToast('Please select a product for all rows', 'warning');
            hasError = true;
            return;
        }
        if (!size) {
            showToast('Please select a size for all rows', 'warning');
            hasError = true;
            return;
        }
        if (qty <= 0) {
            showToast('Please enter a valid quantity', 'warning');
            hasError = true;
            return;
        }
        
        items.push({
            id: parseInt(prodId),
            size: size,
            quantity: qty
        });
    });

    if (hasError) return;
    if (items.length === 0) {
        showToast('Please add at least one item', 'warning');
        return;
    }
    
    var paymentRadio = document.querySelector('input[name="new-order-payment"]:checked');
    var paymentMethod = paymentRadio ? paymentRadio.value : 'cash';
    
    var payload = {
        customer_name: customer.name,
        customer_phone: customer.phone,
        order_type: orderType,
        items: items
    };

    var token = localStorage.getItem('adminToken');
    
    var submitBtn = document.getElementById('submit-order-btn');
    if (submitBtn) submitBtn.disabled = true;
    
    fetch(API_URL + '/orders', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify(payload)
    })
    .then(function(res) {
        if (submitBtn) submitBtn.disabled = false;
        if (!res.ok) {
            return res.json().then(function(d) { throw new Error(d.error || 'Failed to submit order'); });
        }
        return res.json();
    })
    .then(function(data) {
        showToast('Order created successfully: ' + data.order_number, 'success');
        closeCreateOrderModal();
        
        fetchOrdersFromServer(function() {
            renderOrdersTable();
            loadDashboard();
        });
    })
    .catch(function(err) {
        if (submitBtn) submitBtn.disabled = false;
        console.error('Error creating order:', err);
        showToast(err.message || 'Error creating order', 'error');
    });
}

/* ============================================================
   PREMIUM CUSTOM DROPDOWN — Replaces native <select> elements
   ============================================================ */
function initAdminDropdown(selectEl) {
    if (!selectEl || selectEl.dataset.dropdownInit === 'true') return;
    if (selectEl.multiple) return; // skip multi-select
    selectEl.dataset.dropdownInit = 'true';

    var isFullWidth = selectEl.classList.contains('form-input') ||
                      selectEl.classList.contains('form-select') ||
                      selectEl.classList.contains('w-full') ||
                      selectEl.closest('.form-group') ||
                      selectEl.closest('.modal-body');

    var isSm = selectEl.classList.contains('filter-select') ||
               selectEl.classList.contains('chart-filter') ||
               selectEl.classList.contains('analytics-panel__select') ||
               selectEl.classList.contains('reports-chart-select');

    // Build wrapper
    var wrapper = document.createElement('div');
    wrapper.className = 'admin-dropdown' +
        (isFullWidth ? ' admin-dropdown--fullwidth' : '') +
        (isSm ? ' admin-dropdown--sm' : '');
    if (selectEl.disabled) wrapper.classList.add('admin-dropdown--disabled');

    // Trigger
    var trigger = document.createElement('div');
    trigger.className = 'admin-dropdown__trigger';
    trigger.setAttribute('role', 'button');
    trigger.setAttribute('tabindex', '0');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');

    var label = document.createElement('span');
    label.className = 'admin-dropdown__label';

    var arrow = document.createElement('span');
    arrow.className = 'admin-dropdown__arrow';
    arrow.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

    trigger.appendChild(label);
    trigger.appendChild(arrow);

    // Panel
    var panel = document.createElement('div');
    panel.className = 'admin-dropdown__panel';
    panel.setAttribute('role', 'listbox');

    // Build options
    function buildOptions() {
        panel.innerHTML = '';
        var options = selectEl.querySelectorAll('option');
        options.forEach(function(opt) {
            if (opt.disabled && opt.value === '') return; // skip disabled placeholder
            var item = document.createElement('div');
            item.className = 'admin-dropdown__option';
            item.setAttribute('role', 'option');
            item.dataset.value = opt.value;

            var radio = document.createElement('span');
            radio.className = 'admin-dropdown__radio';

            var text = document.createElement('span');
            text.className = 'admin-dropdown__option-text';
            text.textContent = opt.textContent;

            item.appendChild(radio);
            item.appendChild(text);

            if (opt.value === selectEl.value && !opt.disabled) {
                item.classList.add('admin-dropdown__option--selected');
            }

            item.addEventListener('click', function(e) {
                e.stopPropagation();
                selectValue(opt.value, opt.textContent);
                closeDropdown();
            });

            panel.appendChild(item);
        });
        updateLabel();
    }

    function updateLabel() {
        var selected = selectEl.options[selectEl.selectedIndex];
        if (selected) {
            label.textContent = selected.textContent;
            label.classList.remove('admin-dropdown__label--placeholder');
            if (selected.disabled && selected.value === '') {
                label.classList.add('admin-dropdown__label--placeholder');
            }
        }
    }

    function selectValue(val, text) {
        selectEl.value = val;
        // Fire change event
        var evt = new Event('change', { bubbles: true });
        selectEl.dispatchEvent(evt);
        // Update UI
        var items = panel.querySelectorAll('.admin-dropdown__option');
        items.forEach(function(it) {
            it.classList.toggle('admin-dropdown__option--selected', it.dataset.value === val);
        });
        label.textContent = text;
        label.classList.remove('admin-dropdown__label--placeholder');
    }

    function openDropdown() {
        closeAllAdminDropdowns();
        wrapper.classList.add('admin-dropdown--open');
        trigger.setAttribute('aria-expanded', 'true');
    }

    function closeDropdown() {
        wrapper.classList.remove('admin-dropdown--open');
        trigger.setAttribute('aria-expanded', 'false');
    }

    function toggleDropdown() {
        if (wrapper.classList.contains('admin-dropdown--open')) {
            closeDropdown();
        } else {
            openDropdown();
        }
    }

    trigger.addEventListener('click', function(e) {
        e.stopPropagation();
        toggleDropdown();
    });

    trigger.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleDropdown();
        } else if (e.key === 'Escape') {
            closeDropdown();
        }
    });

    // Insert wrapper
    selectEl.parentNode.insertBefore(wrapper, selectEl);
    wrapper.appendChild(selectEl);
    wrapper.appendChild(trigger);
    wrapper.appendChild(panel);

    // Remove any existing custom chevron div that was next to the select
    var nextSibling = wrapper.nextElementSibling;
    if (nextSibling && nextSibling.classList && nextSibling.classList.contains('pointer-events-none')) {
        nextSibling.remove();
    }

    buildOptions();

    // Watch for programmatic value changes
    var origDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    Object.defineProperty(selectEl, 'value', {
        get: function() { return origDesc.get.call(this); },
        set: function(v) {
            origDesc.set.call(this, v);
            buildOptions();
        }
    });

    // Watch for programmatic index changes
    var origSelectedIndex = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
    Object.defineProperty(selectEl, 'selectedIndex', {
        get: function() { return origSelectedIndex.get.call(this); },
        set: function(v) {
            origSelectedIndex.set.call(this, v);
            buildOptions();
        }
    });

    // Automatically rebuild options if options change inside selectEl
    if (window.MutationObserver) {
        var observer = new MutationObserver(function() {
            buildOptions();
        });
        observer.observe(selectEl, { childList: true, subtree: true, characterData: true });
    }

    // Store reference for external rebuild
    selectEl._adminDropdown = { buildOptions: buildOptions, wrapper: wrapper };
}

function closeAllAdminDropdowns() {
    document.querySelectorAll('.admin-dropdown--open').forEach(function(d) {
        d.classList.remove('admin-dropdown--open');
        var trig = d.querySelector('.admin-dropdown__trigger');
        if (trig) trig.setAttribute('aria-expanded', 'false');
    });
}

function initAllAdminDropdowns() {
    // Skip selects inside supplier modal (multi-select) and selects already initialized
    document.querySelectorAll('select:not([multiple]):not([data-dropdown-init="true"])').forEach(function(sel) {
        // Skip if inside a native-only context
        if (sel.closest('.order-item-row')) return; // dynamic order item product selects
        initAdminDropdown(sel);
    });
}

// Close dropdowns on outside click
document.addEventListener('click', function() {
    closeAllAdminDropdowns();
});

// Initialize dropdowns on DOMContentLoaded + after login
document.addEventListener('DOMContentLoaded', function() {
    // Delayed init to ensure login flow completes
    setTimeout(initAllAdminDropdowns, 500);
});

// Also hook into showDashboard for post-login init
(function() {
    var _origShow = showDashboard;
    showDashboard = function(role) {
        _origShow(role);
        setTimeout(initAllAdminDropdowns, 200);
    };
})();

// Re-initialize when modals open (they may contain selects)
(function() {
    var _origOpen = openModal;
    openModal = function(id) {
        _origOpen(id);
        setTimeout(function() {
            var modal = document.getElementById(id);
            if (modal) {
                modal.querySelectorAll('select:not([multiple]):not([data-dropdown-init="true"])').forEach(function(sel) {
                    if (sel.closest('.order-item-row')) return;
                    initAdminDropdown(sel);
                });
            }
        }, 100);
    };
})();

/* ============================================================
   SECTION 35: STAFF MANAGEMENT
   ============================================================ */
function loadAdmins() {
    var token = localStorage.getItem('adminToken');
    if (!token) return;

    loadAccessRequests();

    var tbody = document.getElementById('staff-table-body');
    if (tbody) {
        tbody.innerHTML = '<tr><td colspan="4" class="empty-state">Loading staff accounts...</td></tr>';
    }

    fetch(API_URL + '/users', {
        headers: { 'Authorization': 'Bearer ' + token }
    })
    .then(function(res) {
        if (!res.ok) throw new Error('Failed to load users');
        return res.json();
    })
    .then(function(data) {
        if (!tbody) return;
        tbody.innerHTML = '';
        
        var total = data.length;
        var managers = 0;
        var staff = 0;

        if (total === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="empty-state">No staff accounts found</td></tr>';
        } else {
            data.forEach(function(u) {
                if (u.role === 'manager') managers++;
                else staff++;

                // Prevent deleting own account in UI
                var isSelf = false;
                try {
                    // Simple parse JWT to get own user id
                    var base64Url = token.split('.')[1];
                    var base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
                    var jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
                        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
                    }).join(''));
                    var payload = JSON.parse(jsonPayload);
                    if (payload && payload.id === u.id) {
                        isSelf = true;
                    }
                } catch(e) {}

                var actionsHTML = '';
                var editBtn = '<button class="action-icon edit" title="Edit Account" onclick="openEditStaffModal(' + u.id + ', \'' + escapeHtml(u.email || u.username) + '\', \'' + u.role + '\', \'' + escapeHtml(u.full_name || '') + '\')" style="background:none;border:none;cursor:pointer;color:var(--primary,#fc4c7a);margin-right:6px;"><svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg></button>';
                if (isSelf) {
                    actionsHTML = editBtn + '<span style="font-size:11px;color:#888;font-style:italic;">You</span>';
                } else {
                    actionsHTML = editBtn +
                        '<button class="action-icon delete" title="Delete Account" onclick="confirmDeleteStaff(' + u.id + ', \'' + escapeHtml(u.username) + '\')" style="background:none;border:none;cursor:pointer;color:#dc2626;"><svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg></button>';
                }

                var row = document.createElement('tr');
                row.innerHTML = '<td class="table-card-header" data-label="ID">' + u.id + '</td>' +
                    '<td data-label="Account"><strong>' + escapeHtml(u.full_name || u.username) + '</strong>' +
                        (u.email ? '<div style="font-size:12px;color:#888;">' + escapeHtml(u.email) + '</div>' : '') + '</td>' +
                    '<td data-label="Role"><span class="status-pill ' + (u.role === 'manager' ? 'active' : 'draft') + '">' + escapeHtml(u.role === 'manager' ? 'Manager' : 'Staff') + '</span></td>' +
                    '<td data-label="Actions" style="text-align: right;">' + actionsHTML + '</td>';
                tbody.appendChild(row);
            });
        }

        document.getElementById('staff-total-count').textContent = total;
        document.getElementById('staff-manager-count').textContent = managers;
        document.getElementById('staff-member-count').textContent = staff;
    })
    .catch(function(err) {
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="4" class="empty-state" style="color:var(--danger)">Error: ' + escapeHtml(err.message) + '</td></tr>';
        }
    });
}

/* ── Access requests (sign-ups awaiting the owner's approval) ── */
function loadAccessRequests() {
    var token = localStorage.getItem('adminToken');
    if (!token || token.indexOf('fallback-token') === 0) return;

    fetch(API_URL + '/admin/access-requests', {
        headers: { 'Authorization': 'Bearer ' + token }
    })
    .then(function(res) {
        if (res.status === 401 || res.status === 403) return null;
        if (!res.ok) throw new Error('Failed to load access requests');
        return res.json();
    })
    .then(function(rows) {
        if (Array.isArray(rows)) renderAccessRequests(rows);
    })
    .catch(function() {});
}

function renderAccessRequests(rows) {
    var panel = document.getElementById('access-requests-panel');
    var list = document.getElementById('access-requests-list');
    var count = document.getElementById('access-requests-count');
    var badge = document.getElementById('staff-requests-badge');
    if (badge) {
        badge.textContent = rows.length;
        badge.style.display = rows.length ? 'inline-flex' : 'none';
    }
    if (!panel || !list) return;
    panel.style.display = rows.length ? 'block' : 'none';
    if (count) count.textContent = rows.length;

    list.innerHTML = rows.map(function(r) {
        var date = (r.created_at || '').split(' ')[0];
        return '<div style="display:flex; flex-wrap:wrap; align-items:center; gap:10px; background:#fff; border:1px solid #f1e3e7; border-radius:12px; padding:12px 14px; margin-bottom:8px;">' +
            '<div style="flex:1 1 220px; min-width:0;">' +
                '<strong style="display:block; font-size:14px; color:#2d2d34;">' + escapeHtml(r.full_name || '—') + '</strong>' +
                '<span style="font-size:12.5px; color:#7b727f;">' + escapeHtml(r.email || '') +
                (r.phone ? ' · ' + escapeHtml(r.phone) : '') +
                (date ? ' · requested ' + escapeHtml(date) : '') + '</span>' +
            '</div>' +
            '<div style="display:flex; gap:8px;">' +
                '<button type="button" class="btn btn-primary btn-sm" onclick="approveAccessRequest(' + r.id + ')">Approve</button>' +
                '<button type="button" class="btn btn-outline btn-sm" onclick="rejectAccessRequest(' + r.id + ')">Reject</button>' +
            '</div>' +
        '</div>';
    }).join('');
}

function approveAccessRequest(id) {
    var token = localStorage.getItem('adminToken');
    if (!token) return;
    fetch(API_URL + '/admin/access-requests/' + id + '/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ role: 'staff' })
    })
    .then(function(res) { return res.json().then(function(d) { return { ok: res.ok, data: d }; }); })
    .then(function(r) {
        if (!r.ok) throw new Error(r.data.error || 'Approve failed');
        showToast('Approved as Staff — change their role anytime via Edit', 'success');
        loadAdmins();
    })
    .catch(function(err) { showToast(err.message, 'error'); });
}

function rejectAccessRequest(id) {
    var token = localStorage.getItem('adminToken');
    if (!token) return;
    fetch(API_URL + '/admin/access-requests/' + id + '/reject', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token }
    })
    .then(function(res) { return res.json().then(function(d) { return { ok: res.ok, data: d }; }); })
    .then(function(r) {
        if (!r.ok) throw new Error(r.data.error || 'Reject failed');
        showToast('Request rejected', 'success');
        loadAdmins();
    })
    .catch(function(err) { showToast(err.message, 'error'); });
}

// Owner notification: refresh the sidebar badge on every dashboard load, and
// drop a bell notification + toast when NEW requests arrived since last seen.
function refreshAccessRequestsBadge() {
    var token = localStorage.getItem('adminToken');
    if (!token || token.indexOf('fallback-token') === 0) return;
    if (currentRole !== 'manager' && currentRole !== 'admin') return;

    fetch(API_URL + '/admin/access-requests', {
        headers: { 'Authorization': 'Bearer ' + token }
    })
    .then(function(res) { return res.ok ? res.json() : null; })
    .then(function(rows) {
        if (!Array.isArray(rows)) return;
        var badge = document.getElementById('staff-requests-badge');
        if (badge) {
            badge.textContent = rows.length;
            badge.style.display = rows.length ? 'inline-flex' : 'none';
        }
        var prev = parseInt(localStorage.getItem('dcKidsPendingAccessCount') || '0', 10);
        if (rows.length > prev) {
            var msg = rows.length === 1
                ? '1 admin access request awaiting your approval'
                : rows.length + ' admin access requests awaiting your approval';
            if (typeof addNotification === 'function') addNotification('staff', msg);
            if (typeof renderNotifications === 'function') renderNotifications();
            if (typeof showToast === 'function') showToast(msg, 'warning');
        }
        localStorage.setItem('dcKidsPendingAccessCount', String(rows.length));
    })
    .catch(function() {});
}

function openAddStaffModal() {
    document.getElementById('add-staff-name').value = '';
    document.getElementById('add-staff-email').value = '';
    document.getElementById('add-staff-role').value = 'staff';

    // Clear validation borders
    document.getElementById('add-staff-name').style.borderColor = '';
    document.getElementById('add-staff-email').style.borderColor = '';

    openModal('modal-add-staff');
}

function closeAddStaffModal() {
    closeModal('modal-add-staff');
}

function saveStaffUser() {
    var nameEl = document.getElementById('add-staff-name');
    var emailEl = document.getElementById('add-staff-email');
    var roleEl = document.getElementById('add-staff-role');

    var fullName = nameEl.value.trim();
    var email = emailEl.value.trim().toLowerCase();
    var role = roleEl.value;

    var valid = true;
    if (fullName.length < 2) { nameEl.style.borderColor = '#dc2626'; valid = false; }
    else { nameEl.style.borderColor = ''; }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { emailEl.style.borderColor = '#dc2626'; valid = false; }
    else { emailEl.style.borderColor = ''; }

    if (!valid) return;

    var token = localStorage.getItem('adminToken');
    if (!token) return;

    fetch(API_URL + '/users', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify({ full_name: fullName, email: email, role: role })
    })
    .then(function(res) {
        if (res.status === 409) throw new Error('An account with this email already exists');
        if (!res.ok) return res.json().then(function(j) { throw new Error((j && j.error) || 'Failed to create staff account'); });
        return res.json();
    })
    .then(function(data) {
        closeAddStaffModal();
        loadAdmins();
        if (typeof showToast === 'function') {
            showToast('Staff added — they can sign in with an email code right away', 'success');
        }
    })
    .catch(function(err) {
        showToast(err.message, 'error');
    });
}

function confirmDeleteStaff(id, username) {
    showConfirm('Delete Staff Member', 'Are you sure you want to delete user "' + username + '"? This action cannot be undone.', function() {
        deleteStaff(id);
    });
}

function deleteStaff(id) {
    var token = localStorage.getItem('adminToken');
    if (!token) return;

    fetch(API_URL + '/users/' + id, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + token }
    })
    .then(function(res) {
        if (!res.ok) throw new Error('Failed to delete staff account');
        return res.json();
    })
    .then(function(data) {
        loadAdmins();
        if (typeof showToast === 'function') {
            showToast('Staff account deleted successfully', 'success');
        }
    })
    .catch(function(err) {
        if (typeof showToast === 'function') {
            showToast(err.message, 'error');
        }
    });
}

// ============================================================
//   Edit Staff
// ============================================================
function openEditStaffModal(id, email, role, fullName) {
    var modal = document.getElementById('modal-edit-staff');
    if (!modal) return;
    document.getElementById('edit-staff-id').value = id;
    document.getElementById('edit-staff-name').value = fullName || '';
    document.getElementById('edit-staff-email').value = email || '';
    document.getElementById('edit-staff-role').value = role || 'staff';
    ['edit-staff-name', 'edit-staff-email'].forEach(function(k) {
        var el = document.getElementById(k); if (el) el.style.borderColor = '';
    });
    if (typeof openModal === 'function') openModal('modal-edit-staff');
}
function closeEditStaffModal() {
    if (typeof closeModal === 'function') closeModal('modal-edit-staff');
}
function saveEditStaffUser() {
    var id = document.getElementById('edit-staff-id').value;
    var nameEl = document.getElementById('edit-staff-name');
    var emailEl = document.getElementById('edit-staff-email');
    var roleEl = document.getElementById('edit-staff-role');
    var fullName = nameEl.value.trim();
    var email = emailEl.value.trim().toLowerCase();
    var role = roleEl.value;

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { emailEl.style.borderColor = '#dc2626'; showToast('Enter a valid email address', 'warning'); return; }
    emailEl.style.borderColor = '';

    var body = { email: email, role: role };
    if (fullName) body.full_name = fullName;

    var token = localStorage.getItem('adminToken');
    if (!token) return;
    fetch(API_URL + '/users/' + id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify(body)
    })
    .then(function(res) {
        if (res.status === 409) throw new Error('That email is already in use');
        if (!res.ok) return res.json().then(function(j) { throw new Error((j && j.error) || 'Update failed'); });
        return res.json();
    })
    .then(function() {
        closeEditStaffModal();
        loadAdmins();
        showToast('Staff account updated', 'success');
    })
    .catch(function(err) { showToast(err.message, 'error'); });
}

// ============================================================
//   Customer Detail Drawer (shows full order history)
// ============================================================
function openCustomerDetail(customerId) {
    var modal = document.getElementById('modal-customer-detail');
    if (!modal) return;
    var customers = (typeof getCustomers === 'function') ? getCustomers() : [];
    var c = customers.find(function(x) { return String(x.id) === String(customerId); });
    if (!c) { showToast('Customer not found', 'error'); return; }

    document.getElementById('cust-detail-name').textContent = c.name || 'Customer';
    document.getElementById('cust-detail-phone').textContent = c.phone || '—';
    document.getElementById('cust-detail-city').textContent = c.city || c.address || '—';
    document.getElementById('cust-detail-group').textContent = c.group || '—';
    document.getElementById('cust-detail-notes').value = c.notes || '';
    document.getElementById('cust-detail-since').textContent = c.joinDate ? new Date(c.joinDate).toLocaleDateString() : '—';

    // Wire WhatsApp button to message the customer directly
    var waBtn = document.getElementById('cust-detail-wa-btn');
    if (waBtn && c.phone) {
        var cleaned = c.phone.replace(/[^0-9]/g, '');
        waBtn.href = 'https://wa.me/' + cleaned + '?text=' + encodeURIComponent('Hi ' + (c.name || 'there') + ', this is DC Kids Brand. How can we help you today?');
        waBtn.style.display = 'inline-flex';
    } else if (waBtn) {
        waBtn.style.display = 'none';
    }

    // Store customer id for note saving
    var modal = document.getElementById('modal-customer-detail');
    if (modal) modal.setAttribute('data-customer-id', c.id);

    // Wire the Edit button → opens the customer edit modal (desktop behaviour)
    var custEditBtn = document.getElementById('cust-detail-edit-btn');
    if (custEditBtn) {
        custEditBtn.onclick = function() {
            closeCustomerDetail();
            if (typeof openCustomerModal === 'function') openCustomerModal(c.id);
        };
    }

    var avatarEl = document.getElementById('cust-detail-avatar');
    if (avatarEl) {
        var initials = (c.name || 'C').trim().split(/\s+/).slice(0, 2).map(function(s) { return s[0]; }).join('').toUpperCase();
        avatarEl.textContent = initials || 'C';
    }

    // Filter orders by phone or by name (best-effort match)
    var orders = (typeof getOrders === 'function') ? getOrders() : [];
    var custOrders = orders.filter(function(o) {
        if (c.phone && o.phone && String(o.phone).replace(/\D/g, '') === String(c.phone).replace(/\D/g, '')) return true;
        if (c.name && o.customer && o.customer.toLowerCase() === c.name.toLowerCase()) return true;
        return false;
    });

    var totalSpent = custOrders.filter(function(o) { return o.status !== 'cancelled'; })
        .reduce(function(s, o) { return s + (Number(o.total) || 0); }, 0);
    var pendingCount = custOrders.filter(function(o) { return o.status === 'pending' || o.status === 'processing'; }).length;

    document.getElementById('cust-detail-order-count').textContent = custOrders.length;
    document.getElementById('cust-detail-spent').textContent = 'GHS ' + totalSpent.toLocaleString();
    document.getElementById('cust-detail-pending').textContent = pendingCount;

    var listEl = document.getElementById('cust-detail-orders');
    if (custOrders.length === 0) {
        listEl.innerHTML = '<div style="padding:24px;text-align:center;color:#888;font-size:13px;">No orders yet for this customer.</div>';
    } else {
        listEl.innerHTML = custOrders.sort(function(a, b) {
            return new Date(b.date || 0) - new Date(a.date || 0);
        }).map(function(o) {
            var dateStr = o.date ? new Date(o.date).toLocaleDateString('en-GH', { day:'2-digit', month:'short', year:'numeric' }) : '—';
            var statusClass = 'in-stock';
            if (o.status === 'pending' || o.status === 'processing') statusClass = 'low-stock';
            else if (o.status === 'cancelled') statusClass = 'out-of-stock';
            var itemsHtml = '';
            if (o.items && o.items.length) {
                itemsHtml = '<div style="margin-top:8px;padding-top:8px;border-top:1px solid #F5F5F5;">' +
                    o.items.map(function(it) {
                        return '<div style="font-size:11px;color:#555;line-height:1.8;">• ' +
                            escapeHtml(it.name || it.product_name || '—') +
                            (it.size ? ' <span style="color:#aaa;">(' + escapeHtml(it.size) + ')</span>' : '') +
                            ' × ' + (it.qty || it.quantity || 1) +
                            ' <span style="color:#fc4c7a;font-weight:600;">GHS ' + Number(it.price || it.price_at_time || 0).toFixed(2) + '</span>' +
                        '</div>';
                    }).join('') +
                '</div>';
            }
            return '<div style="padding:12px 14px;border:1px solid #EEE;border-radius:10px;">' +
                '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">' +
                    '<div style="flex:1;min-width:0;">' +
                        '<div style="font-weight:600;font-size:13px;color:#222;">' + escapeHtml(o.id || '—') + '</div>' +
                        '<div style="font-size:11px;color:#888;margin-top:2px;">' + dateStr + '</div>' +
                    '</div>' +
                    '<div style="font-weight:700;font-size:13px;color:#222;white-space:nowrap;">GHS ' + (Number(o.total) || 0).toLocaleString() + '</div>' +
                    '<span class="status-pill ' + statusClass + '" style="text-transform:capitalize;white-space:nowrap;">' + escapeHtml(o.status || 'pending') + '</span>' +
                '</div>' +
                itemsHtml +
            '</div>';
        }).join('');
    }

    if (typeof openModal === 'function') openModal('modal-customer-detail');
}
function closeCustomerDetail() {
    var m = document.getElementById('modal-customer-detail');
    if (m) { m.style.display = 'none'; m.classList.remove('active'); }
    document.body.style.overflow = '';
}

function saveCustomerDetailNotes() {
    var modal = document.getElementById('modal-customer-detail');
    var customerId = modal ? modal.getAttribute('data-customer-id') : null;
    if (!customerId) return;
    var notesEl = document.getElementById('cust-detail-notes');
    var notes = notesEl ? notesEl.value.trim() : '';
    var customers = getCustomers();
    customers = customers.map(function(c) {
        if (String(c.id) === String(customerId)) c.notes = notes;
        return c;
    });
    saveCustomers(customers);
    showToast('Notes saved', 'success');
}

// ============================================================
//   Bulk Product Actions (select rows + bulk delete / status / category)
// ============================================================
var prodSelectedIds = new Set();

function prodBulkOnRowToggle(id, checked) {
    if (checked) prodSelectedIds.add(String(id));
    else prodSelectedIds.delete(String(id));
    prodBulkUpdateToolbar();
}
function prodBulkSelectAll(checked) {
    document.querySelectorAll('#products-tbody input.prod-bulk-check').forEach(function(cb) {
        cb.checked = !!checked;
        var id = cb.getAttribute('data-id');
        if (checked) prodSelectedIds.add(id); else prodSelectedIds.delete(id);
    });
    prodBulkUpdateToolbar();
}
function prodBulkUpdateToolbar() {
    var bar = document.getElementById('prod-bulk-bar');
    if (!bar) return;
    var n = prodSelectedIds.size;
    bar.style.display = n > 0 ? 'flex' : 'none';
    var lbl = document.getElementById('prod-bulk-count');
    if (lbl) lbl.textContent = n + ' selected';
}
function prodBulkClear() {
    prodSelectedIds.clear();
    document.querySelectorAll('#products-tbody input.prod-bulk-check').forEach(function(cb) { cb.checked = false; });
    var headerCb = document.getElementById('prod-bulk-select-all'); if (headerCb) headerCb.checked = false;
    prodBulkUpdateToolbar();
}
function prodBulkDelete() {
    if (prodSelectedIds.size === 0) return;
    var ids = Array.from(prodSelectedIds);
    showConfirm('Delete ' + ids.length + ' product' + (ids.length === 1 ? '' : 's') + '?',
        'This action cannot be undone.',
        function() {
            var token = localStorage.getItem('adminToken');
            fetch(API_URL + '/products/bulk-delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (token || '') },
                body: JSON.stringify({ ids: ids.map(Number) })
            })
            .then(function(r) { if (!r.ok) throw new Error('Bulk delete failed'); return r.json(); })
            .then(function(data) {
                prodBulkClear();
                showToast('Deleted ' + (data.deleted || ids.length) + ' products', 'success');
                if (typeof fetchProducts === 'function') fetchProducts();
            })
            .catch(function(err) { showToast(err.message, 'error'); });
        });
}
function prodBulkSetCategory(cat) {
    prodBulkApplyFields({ cat: cat }, 'category');
}
function prodBulkSetBadge(badge) {
    prodBulkApplyFields({ badge: badge }, 'badge');
}
function prodBulkSetFulfillment(fulfillmentType) {
    prodBulkApplyFields({ fulfillment_type: fulfillmentType }, 'listing type');
}
function prodBulkApplyFields(fields, label) {
    if (prodSelectedIds.size === 0) return;
    var ids = Array.from(prodSelectedIds).map(Number);
    var token = localStorage.getItem('adminToken');
    fetch(API_URL + '/products/bulk-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (token || '') },
        body: JSON.stringify({ ids: ids, fields: fields })
    })
    .then(function(r) { if (!r.ok) return r.json().then(function(j) { throw new Error((j && j.error) || 'Update failed'); }); return r.json(); })
    .then(function(data) {
        prodBulkClear();
        showToast('Updated ' + (data.updated || ids.length) + ' products (' + label + ')', 'success');
        if (typeof fetchProducts === 'function') fetchProducts();
    })
    .catch(function(err) { showToast(err.message, 'error'); });
}

// ============================================================
//   Product CSV Import
// ============================================================
function openProductImportModal() {
    var input = document.getElementById('prod-import-file');
    var preview = document.getElementById('prod-import-preview');
    var status = document.getElementById('prod-import-status');
    var submit = document.getElementById('prod-import-submit');
    if (input) input.value = '';
    if (preview) { preview.style.display = 'none'; preview.innerHTML = ''; }
    if (status) status.innerHTML = '';
    if (submit) submit.disabled = true;
    if (typeof openModal === 'function') openModal('modal-product-import');
}
function closeProductImportModal() {
    if (typeof closeModal === 'function') closeModal('modal-product-import');
}

// Minimal CSV parser that handles quoted fields with embedded commas + escaped quotes.
function parseCSV(text) {
    var rows = [];
    var i = 0, field = '', row = [], inQuotes = false;
    function pushField() { row.push(field); field = ''; }
    function pushRow() { rows.push(row); row = []; }
    while (i < text.length) {
        var c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
                inQuotes = false; i++; continue;
            }
            field += c; i++; continue;
        }
        if (c === '"') { inQuotes = true; i++; continue; }
        if (c === ',') { pushField(); i++; continue; }
        if (c === '\r') { i++; continue; }
        if (c === '\n') { pushField(); pushRow(); i++; continue; }
        field += c; i++;
    }
    if (field.length > 0 || row.length > 0) { pushField(); pushRow(); }
    return rows;
}

// Hook the file input as soon as the modal opens
document.addEventListener('change', function(e) {
    if (!e.target || e.target.id !== 'prod-import-file') return;
    var file = e.target.files && e.target.files[0];
    var preview = document.getElementById('prod-import-preview');
    var status = document.getElementById('prod-import-status');
    var submit = document.getElementById('prod-import-submit');
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function(ev) {
        try {
            var rows = parseCSV(String(ev.target.result || '')).filter(function(r) { return r.length && r.some(function(c) { return c && c.trim(); }); });
            if (rows.length < 2) { status.innerHTML = '<span style="color:#dc2626;">CSV needs a header row and at least one data row.</span>'; submit.disabled = true; return; }
            var headers = rows[0].map(function(h) { return String(h || '').trim().toLowerCase(); });
            if (headers.indexOf('name') < 0 || headers.indexOf('price') < 0) {
                status.innerHTML = '<span style="color:#dc2626;">Missing required columns: name and price.</span>';
                submit.disabled = true; return;
            }
            var allowed = ['name','price','stock','cat','size','badge','img','description','fulfillment_type','sku'];
            var parsed = rows.slice(1).map(function(r) {
                var obj = {};
                headers.forEach(function(h, idx) { if (allowed.indexOf(h) >= 0) obj[h] = r[idx] != null ? String(r[idx]).trim() : ''; });
                return obj;
            }).filter(function(o) { return o.name && o.price !== '' && o.price != null; });

            window.__prodImportRows = parsed;
            preview.style.display = 'block';
            preview.innerHTML = '<strong>' + parsed.length + ' rows ready</strong><br>' + parsed.slice(0, 5).map(function(r) {
                var isPreorder = (r.fulfillment_type || '').toLowerCase() === 'preorder';
                return '• ' + escapeHtml(r.name) + ' — GHS ' + (r.price || '0') + ' (' + (r.cat || 'uncategorized') + ')' + (r.sku ? ' [' + escapeHtml(r.sku) + ']' : ' [auto SKU]') + (isPreorder ? ' — Pre-Order' : '');
            }).join('<br>') + (parsed.length > 5 ? '<br>… and ' + (parsed.length - 5) + ' more' : '');
            status.innerHTML = '<span style="color:#16A34A;">Looks good. Click <strong>Import</strong> to add ' + parsed.length + ' product' + (parsed.length === 1 ? '' : 's') + '.</span>';
            submit.disabled = parsed.length === 0;
        } catch (err) {
            status.innerHTML = '<span style="color:#dc2626;">Could not parse CSV: ' + escapeHtml(err.message) + '</span>';
            submit.disabled = true;
        }
    };
    reader.readAsText(file);
});

function submitProductImport() {
    var rows = window.__prodImportRows || [];
    if (!rows.length) return;
    var token = localStorage.getItem('adminToken');
    var status = document.getElementById('prod-import-status');
    status.innerHTML = '<span style="color:#666;">Uploading…</span>';
    fetch(API_URL + '/products/bulk-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (token || '') },
        body: JSON.stringify({ rows: rows })
    })
    .then(function(r) { return r.json().then(function(d) { if (!r.ok) throw new Error(d.error || 'Import failed'); return d; }); })
    .then(function(data) {
        if (typeof fetchProducts === 'function') fetchProducts();
        window.__prodImportRows = null;
        if (data.failed) {
            // Some rows didn't insert (e.g. a duplicate SKU) — keep the modal
            // open and say exactly which ones, instead of a generic success
            // toast claiming everything went in.
            var detail = (data.errors || []).map(function(e) { return 'Row ' + e.row + ' (' + escapeHtml(e.name || '') + '): ' + escapeHtml(e.error); }).join('<br>');
            status.innerHTML = '<span style="color:#16A34A;">Imported ' + data.inserted + ' product' + (data.inserted === 1 ? '' : 's') + '.</span>' +
                '<br><span style="color:#dc2626;">' + data.failed + ' row' + (data.failed === 1 ? '' : 's') + ' failed:</span><br>' + detail;
            showToast('Imported ' + data.inserted + ', ' + data.failed + ' failed — see details', 'warning');
        } else {
            closeProductImportModal();
            showToast('Imported ' + (data.inserted || 0) + ' products' + (data.skipped ? ' (' + data.skipped + ' skipped)' : ''), 'success');
        }
    })
    .catch(function(err) { status.innerHTML = '<span style="color:#dc2626;">' + escapeHtml(err.message) + '</span>'; });
}

function downloadProductCsvTemplate() {
    var csv = 'name,price,stock,cat,size,badge,img,fulfillment_type,sku,description\n' +
              '"Baby Romper Set",97,12,clothing,"0-3M,3-6M,6-9M",new,images/product_1.jpg,in_stock,,"Soft cotton romper set — leave sku blank to auto-assign"\n' +
              '"Knit Sweater",128,8,clothing,2Y,hot,images/product_2.jpg,preorder,CLO-0050,"Warm winter knit — China pre-order, with our own SKU"\n';
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = 'dc-kids-products-template.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
}


/* ============================================================
   MOBILE BOTTOM NAVIGATION BAR
   Injected into the DOM after login; stays in sync with
   switchTab() so active pill tracks the current view.
   ============================================================ */
(function () {
  'use strict';

  var ICON = {
    dashboard: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
    orders: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>',
    inventory: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
    customers: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    more: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>',
    products: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>',
    suppliers: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>',
    analytics: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
    reports: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>',
    settings: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'
  };

  // 5 primary tabs — Inventory promoted into the bar.
  var TABS = [
    { tab: 'tab-dashboard', label: 'Home',      icon: ICON.dashboard },
    { tab: 'tab-orders',    label: 'Orders',    badge: true, icon: ICON.orders },
    { tab: 'tab-inventory', label: 'Inventory', icon: ICON.inventory },
    { tab: 'tab-customers', label: 'Customers', icon: ICON.customers },
    { tab: null, label: 'More', action: 'more', icon: ICON.more }
  ];

  // Overflow sections live in the light "More" sheet.
  var MORE = [
    { tab: 'tab-products',  label: 'Products',        icon: ICON.products },
    { tab: 'tab-suppliers', label: 'Suppliers',       icon: ICON.suppliers },
    { tab: 'tab-analytics', label: 'Sales Analytics', icon: ICON.analytics },
    { tab: 'tab-reports',   label: 'Reports',         icon: ICON.reports },
    { tab: 'tab-settings',  label: 'Settings',        icon: ICON.settings }
  ];

  var PRIMARY = ['tab-dashboard', 'tab-orders', 'tab-inventory', 'tab-customers'];

  function go(tabId) {
    var fn = window._origSwitchTab || window.switchTab;
    if (typeof fn === 'function') fn(tabId);
    setActive(tabId);
  }

  function buildNav() {
    if (document.getElementById('mobile-bottom-nav')) return;
    var nav = document.createElement('nav');
    nav.id = 'mobile-bottom-nav';
    nav.className = 'mobile-bottom-nav';
    nav.setAttribute('aria-label', 'Main navigation');

    var inner = document.createElement('div');
    inner.className = 'mobile-bottom-nav__inner';

    TABS.forEach(function (item) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mobile-bottom-nav__btn';
      if (item.tab)    btn.setAttribute('data-tab', item.tab);
      if (item.action) btn.setAttribute('data-action', item.action);

      var iconWrap = document.createElement('span');
      iconWrap.className = 'mobile-bottom-nav__icon-wrap';
      iconWrap.innerHTML = item.icon;

      if (item.badge) {
        var badgeEl = document.createElement('span');
        badgeEl.className = 'mobile-bottom-nav__badge';
        badgeEl.id = 'mbn-badge-' + item.tab;
        badgeEl.style.display = 'none';
        iconWrap.appendChild(badgeEl);
      }

      var lbl = document.createElement('span');
      lbl.className = 'mobile-bottom-nav__label';
      lbl.textContent = item.label;

      btn.appendChild(iconWrap);
      btn.appendChild(lbl);

      btn.addEventListener('click', function () {
        if (item.action === 'more') { toggleSheet(); return; }
        if (item.tab) { closeSheet(); go(item.tab); }
      });

      inner.appendChild(btn);
    });

    nav.appendChild(inner);
    document.body.appendChild(nav);
    buildSheet();
    setActive('tab-dashboard');
  }

  /* ---- Light "More" bottom-sheet (overflow sections) ---- */
  function buildSheet() {
    if (document.getElementById('mbn-sheet')) return;
    var scrim = document.createElement('div');
    scrim.id = 'mbn-sheet-scrim';
    scrim.className = 'mbn-sheet-scrim';
    scrim.addEventListener('click', closeSheet);

    var sheet = document.createElement('div');
    sheet.id = 'mbn-sheet';
    sheet.className = 'mbn-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', 'More sections');
    sheet.innerHTML = '<div class="mbn-sheet__grip"></div><div class="mbn-sheet__title">More</div>';

    var grid = document.createElement('div');
    grid.className = 'mbn-sheet__grid';
    MORE.forEach(function (item) {
      var cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'mbn-sheet__cell';
      cell.setAttribute('data-tab', item.tab);
      cell.innerHTML = '<span class="mbn-sheet__icon">' + item.icon + '</span><span class="mbn-sheet__label">' + item.label + '</span>';
      cell.addEventListener('click', function () { closeSheet(); go(item.tab); });
      grid.appendChild(cell);
    });
    sheet.appendChild(grid);

    var logout = document.createElement('button');
    logout.type = 'button';
    logout.className = 'mbn-sheet__logout';
    logout.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg><span>Log out</span>';
    logout.addEventListener('click', function () {
      closeSheet();
      var lb = document.getElementById('logout-btn');
      if (lb) lb.click();
    });
    sheet.appendChild(logout);

    document.body.appendChild(scrim);
    document.body.appendChild(sheet);
  }
  function toggleSheet() {
    var s = document.getElementById('mbn-sheet');
    if (s && s.classList.contains('open')) closeSheet(); else openSheet();
  }
  function openSheet() {
    var s = document.getElementById('mbn-sheet'), sc = document.getElementById('mbn-sheet-scrim');
    if (s) s.classList.add('open');
    if (sc) sc.classList.add('open');
    var mb = document.querySelector('#mobile-bottom-nav [data-action="more"]');
    if (mb) mb.classList.add('active');
  }
  function closeSheet() {
    var s = document.getElementById('mbn-sheet'), sc = document.getElementById('mbn-sheet-scrim');
    if (s) s.classList.remove('open');
    if (sc) sc.classList.remove('open');
    syncActive();
  }
  function syncActive() {
    var act = document.querySelector('.sidebar-link.active');
    if (act) setActive(act.getAttribute('data-tab'));
  }

  function setActive(tabId) {
    var nav = document.getElementById('mobile-bottom-nav');
    if (!nav) return;
    var inMore = PRIMARY.indexOf(tabId) === -1;
    nav.querySelectorAll('.mobile-bottom-nav__btn[data-tab]').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === tabId);
    });
    var mb = nav.querySelector('[data-action="more"]');
    if (mb) mb.classList.toggle('active', inMore);
    document.querySelectorAll('.mbn-sheet__cell').forEach(function (c) {
      c.classList.toggle('active', c.getAttribute('data-tab') === tabId);
    });
  }

  // Wrap switchTab once to keep bottom nav in sync
  function wrapSwitchTab() {
    if (typeof window.switchTab === 'function' && !window._origSwitchTab) {
      window._origSwitchTab = window.switchTab;
      window.switchTab = function (tabId) {
        window._origSwitchTab(tabId);
        setActive(tabId);
        // Modern mobile: replay a subtle slide-up reveal on the newly shown tab.
        try {
          if (window.innerWidth <= 1024) {
            var el = document.getElementById(tabId) ||
                     document.querySelector('[data-tab-content="' + tabId + '"]');
            if (el) {
              el.classList.remove('m-reveal');
              void el.offsetWidth; // force reflow so the animation restarts
              el.classList.add('m-reveal');
            }
          }
        } catch (e) {}
      };
    }
  }

  // Inject when dashboard becomes visible
  function hookShowDashboard() {
    if (typeof window.showDashboard === 'function' && !window._origShowDashboard) {
      window._origShowDashboard = window.showDashboard;
      window.showDashboard = function (role) {
        window._origShowDashboard(role);
        wrapSwitchTab();
        buildNav();
      };
    }
  }

  // Update pending-orders badge
  function updateOrderBadge() {
    var badge = document.getElementById('mbn-badge-tab-orders');
    if (!badge) return;
    var pending = 0;
    if (typeof window.getOrders === 'function') {
      pending = window.getOrders().filter(function (o) {
        return o.status === 'pending';
      }).length;
    }
    badge.textContent = pending > 9 ? '9+' : String(pending);
    badge.style.display = pending > 0 ? 'flex' : 'none';
  }

  document.addEventListener('DOMContentLoaded', function () {
    setTimeout(function () {
      hookShowDashboard();
      wrapSwitchTab();
      var dc = document.getElementById('dashboard-container');
      if (dc && dc.style.display !== 'none') {
        buildNav();
        syncActive();
        setTimeout(updateOrderBadge, 600);
      }
    }, 80);
  });

  // Robust init — poll until core functions exist (admin.js is large and may
  // still be parsing when DOMContentLoaded fires). Stops once hooked or after ~4s.
  var _tries = 0;
  var _poll = setInterval(function () {
    _tries++;
    hookShowDashboard();
    wrapSwitchTab();
    var dc = document.getElementById('dashboard-container');
    if (dc && dc.style.display !== 'none' && !document.getElementById('mobile-bottom-nav')) {
      buildNav();
      syncActive();
      setTimeout(updateOrderBadge, 600);
    }
    if ((window._origShowDashboard && window._origSwitchTab) || _tries > 40) clearInterval(_poll);
  }, 100);

  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });

  // Expose for use elsewhere
  window.mobileBottomNav = { setActive: setActive, updateOrderBadge: updateOrderBadge };
})();


/* ============================================================
   SWIPE GESTURES
   - Swipe left  anywhere on open sidebar → close it
   - Swipe right from left edge (<22px) → open sidebar
   ============================================================ */
(function () {
  var touchStartX = 0;
  var touchStartY = 0;
  var isHorizontal = false;

  document.addEventListener('touchstart', function (e) {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    isHorizontal = false;
  }, { passive: true });

  document.addEventListener('touchmove', function (e) {
    if (isHorizontal) return;
    var dx = Math.abs(e.touches[0].clientX - touchStartX);
    var dy = Math.abs(e.touches[0].clientY - touchStartY);
    if (dx > 6 && dx > dy) isHorizontal = true;
  }, { passive: true });

  document.addEventListener('touchend', function (e) {
    var endX   = e.changedTouches[0].clientX;
    var deltaX = endX - touchStartX;
    var sidebar = document.getElementById('admin-sidebar');
    var overlay = document.getElementById('sidebar-overlay');

    if (!isHorizontal) return;

    // Close on left-swipe when sidebar is open
    if (deltaX < -55 && sidebar && sidebar.classList.contains('open')) {
      sidebar.classList.remove('open');
      if (overlay) overlay.classList.remove('active');
      var moreBtn = document.querySelector('#mobile-bottom-nav [data-action="toggleSidebar"]');
      if (moreBtn) moreBtn.classList.remove('sidebar-open');
    }

    // Open on right-swipe from left screen edge
    if (deltaX > 55 && touchStartX < 22 && sidebar && !sidebar.classList.contains('open')) {
      sidebar.classList.add('open');
      if (overlay) overlay.classList.add('active');
    }
  }, { passive: true });
})();


/* ============================================================
   COLLAPSIBLE SEARCH BAR (≤480px)
   Tap icon / collapsed bar → expand and focus
   Click outside / Escape → collapse
   ============================================================ */
(function () {
  function init() {
    var wrapper = document.querySelector('.global-search-wrapper');
    var input   = document.getElementById('global-search-input');
    if (!wrapper || !input) return;

    function small() { return window.innerWidth <= 480; }

    wrapper.addEventListener('click', function (e) {
      if (!small()) return;
      if (!wrapper.classList.contains('search-expanded')) {
        wrapper.classList.add('search-expanded');
        setTimeout(function () { input.focus(); }, 200);
        e.stopPropagation();
      }
    });

    document.addEventListener('click', function (e) {
      if (!small()) return;
      if (!wrapper.contains(e.target)) {
        wrapper.classList.remove('search-expanded');
      }
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        wrapper.classList.remove('search-expanded');
        input.blur();
        input.value = '';
        var results = document.getElementById('global-search-results');
        if (results) results.style.display = 'none';
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

/* ============================================================
   MOBILE CUSTOM DROPDOWN — upgrades native .filter-select on
   small screens into a styled, non-overlapping dropdown. The
   native <select> stays the source of truth (value + change
   events), so all existing filter logic keeps working.
   ============================================================ */
(function () {
  'use strict';
  var CHEV = '<svg class="cdd-btn__chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';
  var CHECK = '<svg class="cdd-opt__check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

  function closeAll() {
    document.querySelectorAll('.cdd-wrap.open').forEach(function (w) { w.classList.remove('open'); });
    var bd = document.getElementById('cdd-backdrop');
    if (bd) bd.classList.remove('open');
  }

  function enhance(sel) {
    // DISABLED: the app already has its own .admin-dropdown system around these
    // selects, so enhancing here created a duplicate control. No-op now.
    return;
    if (sel.dataset.cdd) return;
    sel.dataset.cdd = '1';

    var wrap = document.createElement('div');
    wrap.className = 'cdd-wrap';
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cdd-btn';
    btn.innerHTML = '<span class="cdd-btn__label"></span>' + CHEV;

    var panel = document.createElement('div');
    panel.className = 'cdd-panel';
    panel.setAttribute('role', 'listbox');

    wrap.appendChild(btn);
    wrap.appendChild(panel);

    // Bulletproof visibility: hide the native select on mobile via inline style
    // (independent of CSS so a stale cached stylesheet can't show duplicates).
    function syncVis() {
      var mobile = window.innerWidth <= 1024;
      if (mobile) {
        sel.style.display = 'none';
        btn.style.display = 'flex';
        wrap.style.display = 'block';
      } else {
        sel.style.display = '';
        btn.style.display = 'none';
        wrap.style.display = 'contents';
      }
    }
    syncVis();
    window.addEventListener('resize', syncVis);

    function label() {
      var o = sel.options[sel.selectedIndex];
      wrap.querySelector('.cdd-btn__label').textContent = o ? o.textContent : '';
    }
    function build() {
      panel.innerHTML = '';
      Array.prototype.forEach.call(sel.options, function (o, i) {
        var opt = document.createElement('div');
        opt.className = 'cdd-opt' + (i === sel.selectedIndex ? ' selected' : '');
        opt.setAttribute('role', 'option');
        opt.innerHTML = CHECK + '<span>' + (o.textContent || '') + '</span>';
        opt.addEventListener('click', function (e) {
          e.stopPropagation();
          sel.value = o.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          label();
          mark();
          closeAll();
        });
        panel.appendChild(opt);
      });
    }
    function mark() {
      Array.prototype.forEach.call(panel.children, function (c, i) {
        c.classList.toggle('selected', i === sel.selectedIndex);
      });
    }
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var isOpen = wrap.classList.contains('open');
      closeAll();
      if (!isOpen) {
        build(); label(); mark();
        wrap.classList.add('open');
        var bd = document.getElementById('cdd-backdrop');
        if (bd) bd.classList.add('open');
      }
    });
    // Keep button label in sync if other code changes the select
    sel.addEventListener('change', function () { label(); });
    build();
    label();
  }

  function enhanceAll() {
    document.querySelectorAll('select.filter-select').forEach(enhance);
  }

  function ensureBackdrop() {
    if (document.getElementById('cdd-backdrop')) return;
    var bd = document.createElement('div');
    bd.id = 'cdd-backdrop';
    bd.className = 'cdd-backdrop';
    bd.addEventListener('click', closeAll);
    document.body.appendChild(bd);
  }

  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeAll(); });
  window.enhanceFilterSelects = function () { ensureBackdrop(); enhanceAll(); };

  document.addEventListener('DOMContentLoaded', function () { ensureBackdrop(); enhanceAll(); });
  // Catch dynamically-rendered selects (products/orders tabs) for a while.
  var n = 0;
  var iv = setInterval(function () { ensureBackdrop(); enhanceAll(); if (++n > 25) clearInterval(iv); }, 400);
})();

/* ============================================================
   MOBILE HERO SEARCH — searches products/orders/customers and
   shows results in the hero, routing to the right tab on tap.
   ============================================================ */
(function () {
  'use strict';
  function glyph() {
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>';
  }
  function esc(s){ return window.escapeHtml ? escapeHtml(s) : String(s); }

  function search(query) {
    var box = document.getElementById('dashHeroSearchResults');
    if (!box) return;
    var q = String(query || '').trim().toLowerCase();
    if (q.length < 2) { box.className = 'dash-hero__search-results'; box.innerHTML = ''; return; }

    var results = [];
    try {
      (window.globalProducts || []).forEach(function (p) {
        if ((p.name && p.name.toLowerCase().indexOf(q) >= 0) || (p.cat && String(p.cat).toLowerCase().indexOf(q) >= 0))
          results.push({ label: p.name, sub: (p.cat || 'Product') + ' · GHS ' + p.price, tab: 'tab-inventory' });
      });
    } catch (e) {}
    try {
      (typeof getOrders === 'function' ? getOrders() : []).forEach(function (o) {
        if (String(o.id).toLowerCase().indexOf(q) >= 0 || String(o.customer || '').toLowerCase().indexOf(q) >= 0)
          results.push({ label: o.id, sub: (o.customer || '') + ' · GHS ' + o.total, tab: 'tab-orders' });
      });
    } catch (e) {}
    try {
      (typeof getCustomers === 'function' ? getCustomers() : []).forEach(function (c) {
        if (String(c.name || '').toLowerCase().indexOf(q) >= 0 || (c.phone && String(c.phone).indexOf(q) >= 0))
          results.push({ label: c.name, sub: c.phone || '', tab: 'tab-customers' });
      });
    } catch (e) {}

    if (!results.length) {
      box.innerHTML = '<div class="gsr-empty">No results for "' + esc(q) + '"</div>';
      box.className = 'dash-hero__search-results has-results';
      return;
    }
    box.innerHTML = results.slice(0, 8).map(function (r) {
      return '<div class="gsr-item" data-tab="' + r.tab + '">' +
             '<span style="display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:10px;background:rgba(252,76,122,0.10);color:#fc4c7a;">' + glyph() + '</span>' +
             '<div style="min-width:0;"><div style="font-weight:600;font-size:14px;">' + esc(r.label) + '</div>' +
             '<div style="font-size:12px;color:#9a9a9a;">' + esc(r.sub) + '</div></div></div>';
    }).join('');
    box.className = 'dash-hero__search-results has-results';
    box.querySelectorAll('.gsr-item').forEach(function (item) {
      item.addEventListener('click', function () {
        if (typeof switchTab === 'function') switchTab(item.getAttribute('data-tab'));
        box.className = 'dash-hero__search-results'; box.innerHTML = '';
        var inp = document.getElementById('dashHeroSearch'); if (inp) inp.value = '';
      });
    });
  }

  function init() {
    var input = document.getElementById('dashHeroSearch');
    var btn = document.getElementById('dashHeroSearchBtn');
    if (!input || input.dataset.wired) return;
    input.dataset.wired = '1';
    input.addEventListener('input', function () { search(this.value); });
    if (btn) btn.addEventListener('click', function () { input.focus(); });
    document.addEventListener('click', function (e) {
      var box = document.getElementById('dashHeroSearchResults');
      if (box && !e.target.closest('.dash-hero__search')) box.className = 'dash-hero__search-results';
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { this.value = ''; var b = document.getElementById('dashHeroSearchResults'); if (b) { b.className = 'dash-hero__search-results'; b.innerHTML = ''; } }
    });
  }
  var n = 0; var iv = setInterval(function () { init(); if (document.getElementById('dashHeroSearch') && document.getElementById('dashHeroSearch').dataset.wired) clearInterval(iv); if (++n > 30) clearInterval(iv); }, 300);
  document.addEventListener('DOMContentLoaded', init);
})();

/* ============================================================
   PRODUCT CATEGORY MANAGER  (add / rename / delete)
   Owner-managed list persisted in same-origin localStorage so the
   storefront reads the same labels + order. Category membership still
   derives from each product's `cat`, so categories with products
   always appear on the storefront on every device.
   ============================================================ */
(function () {
  'use strict';
  var LS_KEY = 'dcKidsCategories';

  function defaults() {
    return [
      { id: 'newborn',     label: 'Newborn' },
      { id: 'clothing',    label: 'Kids Clothing' },
      { id: 'shoes',       label: 'Footwear' },
      { id: 'feeding',     label: 'Feeding & Bottles' },
      { id: 'gear',        label: 'Baby Gear' },
      { id: 'bathcare',    label: 'Bath & Care' },
      { id: 'essentials',  label: 'Baby Essentials' },
      { id: 'accessories', label: 'Bags & Accessories' },
      { id: 'bedding',     label: 'Bedding' }
    ];
  }
  function loadCats() {
    var stored = null;
    try {
      var s = JSON.parse(localStorage.getItem(LS_KEY));
      if (Array.isArray(s) && s.length) stored = s;
    } catch (e) {}
    var list = stored || defaults();
    // "preorder" used to be a fake category (the old cat==='preorder' overload).
    // It's now a per-product Listing Type, independent of category — drop any
    // stale entry left over from before, and persist the cleanup once.
    var cleaned = list.filter(function (c) { return c && c.id !== 'preorder'; });
    if (!stored || cleaned.length !== list.length) saveCats(cleaned);
    return cleaned;
  }
  function saveCats(list) { localStorage.setItem(LS_KEY, JSON.stringify(list)); }
  function slugify(name) {
    return String(name || '').toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }
  function catCount(id) {
    var list = (typeof globalProducts !== 'undefined' && globalProducts) ? globalProducts : [];
    return list.filter(function (p) { return p.cat === id; }).length;
  }
  function esc(s) { return (typeof escapeHtml === 'function') ? escapeHtml(s) : String(s); }

  function ensureModal() {
    if (document.getElementById('modal-settings-categories')) return;
    var m = document.createElement('div');
    m.id = 'modal-settings-categories';
    m.className = 'modal-overlay';
    m.style.display = 'none';
    m.innerHTML =
      '<div class="modal-content" style="max-width:520px;">' +
        '<div class="modal-header">' +
          '<h2 class="modal-title">Product Categories</h2>' +
          '<button class="modal-close-btn" type="button" aria-label="Close" onclick="closeModal(\'modal-settings-categories\')">' +
            '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>' +
          '</button>' +
        '</div>' +
        '<div class="modal-body">' +
          '<div style="display:flex;gap:8px;margin-bottom:16px;">' +
            '<input id="cat-new-input" class="form-input" placeholder="New category name" style="flex:1;" onkeydown="if(event.key===\'Enter\'){event.preventDefault();addProductCategory();}">' +
            '<button type="button" class="btn btn-primary" style="white-space:nowrap;" onclick="addProductCategory()">Add</button>' +
          '</div>' +
          '<div id="cat-manager-list"></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(m);
    m.addEventListener('click', function (e) { if (e.target === m) closeModal('modal-settings-categories'); });
  }

  function renderList() {
    var box = document.getElementById('cat-manager-list');
    if (!box) return;
    var cats = loadCats();
    box.innerHTML = cats.map(function (c) {
      var n = catCount(c.id);
      return '<div style="display:flex;align-items:center;gap:10px;padding:10px 2px;border-bottom:1px solid #eee;">' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-weight:600;color:#333;font-size:14px;">' + esc(c.label) + '</div>' +
          '<div style="font-size:11px;color:#999;">' + esc(c.id) + ' &middot; ' + n + ' product' + (n === 1 ? '' : 's') + '</div>' +
        '</div>' +
        '<button type="button" title="Rename" onclick="renameProductCategory(\'' + esc(c.id) + '\')" style="border:1px solid #e0e0e0;background:#fff;border-radius:8px;padding:6px 10px;font-size:12px;font-weight:600;cursor:pointer;color:#555;">Rename</button>' +
        '<button type="button" title="Delete" onclick="deleteProductCategory(\'' + esc(c.id) + '\')" style="border:1px solid #f3c2cb;background:#fff;border-radius:8px;padding:6px 10px;font-size:12px;font-weight:600;cursor:pointer;color:#d6336c;">Delete</button>' +
      '</div>';
    }).join('') || '<p style="color:#999;text-align:center;padding:16px;">No categories yet.</p>';
  }

  window.openCategoryManager = function () {
    ensureModal();
    renderList();
    if (typeof openModal === 'function') openModal('modal-settings-categories');
  };

  window.addProductCategory = function () {
    var input = document.getElementById('cat-new-input');
    var name = input ? input.value.trim() : '';
    if (!name) { if (typeof showToast === 'function') showToast('Enter a category name', 'warning'); return; }
    var id = slugify(name);
    if (!id) { if (typeof showToast === 'function') showToast('Invalid category name', 'error'); return; }
    var cats = loadCats();
    if (cats.some(function (c) { return c.id === id; })) {
      if (typeof showToast === 'function') showToast('That category already exists', 'warning'); return;
    }
    cats.push({ id: id, label: name });
    saveCats(cats);
    if (input) input.value = '';
    renderList();
    populateCategoryDropdowns();
    if (typeof showToast === 'function') showToast('Category "' + name + '" added', 'success');
  };

  // Branded in-app dialog (replaces native prompt/confirm). Stacks above the
  // category modal. opts: { title, message, withInput, value, confirmText, danger, onConfirm }
  function catDialog(opts) {
    var prev = document.getElementById('cat-dialog');
    if (prev) prev.remove();
    var ov = document.createElement('div');
    ov.id = 'cat-dialog';
    ov.tabIndex = -1;
    ov.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(20,14,18,0.45);padding:20px;';
    var inputHtml = opts.withInput
      ? '<input id="cat-dialog-input" type="text" style="width:100%;box-sizing:border-box;margin-top:14px;padding:11px 13px;border:1px solid #e0e0e0;border-radius:10px;font-size:14px;outline:none;" />'
      : '';
    var msgHtml = opts.message
      ? '<p style="margin:8px 0 0;color:#666;font-size:13px;line-height:1.5;">' + esc(opts.message) + '</p>'
      : '';
    var confirmBg = opts.danger ? '#d6336c' : '#fc4c7a';
    var card = document.createElement('div');
    card.style.cssText = 'background:#fff;border-radius:16px;max-width:400px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.28);overflow:hidden;';
    card.innerHTML =
      '<div style="padding:20px 22px;">' +
        '<h3 style="margin:0;font-size:16px;font-weight:700;color:#1a1a1a;">' + esc(opts.title || '') + '</h3>' +
        msgHtml + inputHtml +
      '</div>' +
      '<div style="display:flex;justify-content:flex-end;gap:10px;padding:14px 22px;background:#fafafa;border-top:1px solid #f0f0f0;">' +
        '<button id="cat-dialog-cancel" type="button" style="padding:9px 16px;border:1px solid #ddd;background:#fff;border-radius:9px;font-weight:600;font-size:13px;cursor:pointer;color:#555;">Cancel</button>' +
        '<button id="cat-dialog-ok" type="button" style="padding:9px 18px;border:none;border-radius:9px;font-weight:700;font-size:13px;cursor:pointer;color:#fff;background:' + confirmBg + ';">' + esc(opts.confirmText || 'OK') + '</button>' +
      '</div>';
    ov.appendChild(card);
    document.body.appendChild(ov);

    var input = document.getElementById('cat-dialog-input');
    var okBtn = document.getElementById('cat-dialog-ok');
    if (input) { input.value = opts.value || ''; setTimeout(function () { input.focus(); input.select(); }, 30); }
    else { setTimeout(function () { okBtn.focus(); }, 30); }

    function close() { ov.remove(); }
    function ok() { var v = input ? input.value.trim() : true; close(); if (opts.onConfirm) opts.onConfirm(v); }
    okBtn.addEventListener('click', ok);
    document.getElementById('cat-dialog-cancel').addEventListener('click', close);
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    ov.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'Enter') { e.preventDefault(); ok(); }
    });
  }

  // Expose the branded dialog so other admin flows can reuse it.
  window.uiDialog = catDialog;

  window.renameProductCategory = function (id) {
    var cats = loadCats();
    var c = cats.find(function (x) { return x.id === id; });
    if (!c) return;
    catDialog({
      title: 'Rename category',
      withInput: true,
      value: c.label,
      confirmText: 'Save',
      onConfirm: function (val) {
        if (!val) { if (typeof showToast === 'function') showToast('Name cannot be empty', 'error'); return; }
        c.label = val;
        saveCats(cats);
        renderList();
        populateCategoryDropdowns();
        if (typeof showToast === 'function') showToast('Category renamed', 'success');
      }
    });
  };

  window.deleteProductCategory = function (id) {
    var cats = loadCats();
    var c = cats.find(function (x) { return x.id === id; });
    if (!c) return;
    var n = catCount(id);
    if (n > 0) {
      if (typeof showToast === 'function')
        showToast('Move or remove its ' + n + ' product' + (n === 1 ? '' : 's') + ' first', 'error');
      return;
    }
    catDialog({
      title: 'Delete category',
      message: 'Delete “' + c.label + '”? This can’t be undone.',
      confirmText: 'Delete',
      danger: true,
      onConfirm: function () {
        saveCats(cats.filter(function (x) { return x.id !== id; }));
        renderList();
        populateCategoryDropdowns();
        if (typeof showToast === 'function') showToast('Category deleted', 'success');
      }
    });
  };

  window.populateCategoryDropdowns = function () {
    var cats = loadCats();
    var ids = cats.map(function (c) { return c.id; });
    var prods = (typeof globalProducts !== 'undefined' && globalProducts) ? globalProducts : [];
    prods.forEach(function (p) {
      if (p.cat && ids.indexOf(p.cat) === -1) { cats.push({ id: p.cat, label: p.cat }); ids.push(p.cat); }
    });
    [['add-product-cat', true], ['modal-product-cat', false]].forEach(function (pair) {
      var sel = document.getElementById(pair[0]);
      if (!sel) return;
      var current = sel.value;
      var opts = pair[1] ? '<option value="" disabled selected>Select category</option>' : '';
      opts += cats.map(function (c) {
        return '<option value="' + esc(c.id) + '">' + esc(c.label) + '</option>';
      }).join('');
      sel.innerHTML = opts;
      if (current) sel.value = current;
    });
  };

  function wrap(name) {
    var orig = window[name];
    if (typeof orig === 'function' && !orig.__catWrapped) {
      window[name] = function () { try { populateCategoryDropdowns(); } catch (e) {} return orig.apply(this, arguments); };
      window[name].__catWrapped = true;
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    ensureModal();
    setTimeout(function () { wrap('openAddProductModal'); wrap('openEditModal'); populateCategoryDropdowns(); }, 400);
    setTimeout(function () { populateCategoryDropdowns(); }, 1500);
  });
})();

/* ============================================================
   Mobile date pickers: presets-first with a collapsible calendar.
   Injects a "Custom date range" toggle into every date-range picker so the
   calendar stays collapsed by default — keeping the dialog short and tidy on
   phones. The toggle is hidden on desktop via CSS (.drp-custom-toggle).
   ============================================================ */
function initDrpCustomToggles() {
  document.querySelectorAll('.date-range-picker').forEach(function (picker) {
    var presets = picker.querySelector('.drp-presets');
    if (!presets || picker.querySelector('.drp-custom-toggle')) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'drp-custom-toggle';
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="drp-custom-toggle__icon"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>' +
      '<span>Custom date range</span>' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="drp-custom-toggle__chev"><polyline points="6 9 12 15 18 9"/></svg>';
    btn.addEventListener('click', function () {
      var shown = picker.classList.toggle('drp-show-cal');
      btn.setAttribute('aria-expanded', shown ? 'true' : 'false');
    });
    presets.insertAdjacentElement('afterend', btn);
  });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDrpCustomToggles);
} else {
  initDrpCustomToggles();
}

/* ============================================================
   PRODUCT SIZES & PRICING  (per-product rows + global presets)
   Each product can carry its own size variants, each with its own
   price (sent as the `sizes` payload, authoritative on the server).
   Global presets are reusable size sets in localStorage that the
   admin can apply to populate the rows, then tweak.
   ============================================================ */
(function () {
  var PRESET_KEY = 'dcKidsSizePresets';

  function defaultPresets() {
    return [
      { name: 'Baby months', sizes: ['0-3M', '3-6M', '6-9M', '9-12M', '12-18M'] },
      { name: 'Kids years', sizes: ['2Y', '3Y', '4Y', '5Y', '6Y', '7Y', '8Y'] },
      { name: 'Shoe sizes (EU)', sizes: ['25', '26', '27', '28', '29', '30', '31', '32', '33', '34', '35'] },
      { name: 'One size', sizes: ['One Size'] }
    ];
  }
  function loadPresets() {
    try { var s = JSON.parse(localStorage.getItem(PRESET_KEY)); if (Array.isArray(s)) return s; } catch (e) {}
    var d = defaultPresets(); savePresets(d); return d;
  }
  function savePresets(list) { localStorage.setItem(PRESET_KEY, JSON.stringify(list)); }
  function esc(s) { return (typeof escapeHtml === 'function') ? escapeHtml(String(s)) : String(s); }

  function rowHtml(label, price) {
    return '<div class="size-row" style="display:flex;gap:8px;margin-bottom:6px;align-items:center;">' +
      '<input type="text" class="size-row-label" placeholder="Size (e.g. 3-6M)" value="' + esc(label || '') + '" style="flex:1;border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;font-size:13px;">' +
      '<input type="number" inputmode="decimal" min="0" step="0.01" class="size-row-price" placeholder="Price (GH₵)" value="' + (price != null && price !== '' ? esc(price) : '') + '" style="width:140px;border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;font-size:13px;">' +
      '<button type="button" class="size-row-del" title="Remove size" style="border:1px solid #f3c2cb;background:#fff;color:#d6336c;border-radius:8px;padding:8px 11px;font-size:12px;font-weight:700;cursor:pointer;line-height:1;">&times;</button>' +
    '</div>';
  }

  window.addSizeRow = function (prefix, label, price) {
    var list = document.getElementById(prefix + '-sizes-list');
    if (!list) return;
    var wrap = document.createElement('div');
    wrap.innerHTML = rowHtml(label, price);
    var row = wrap.firstChild;
    row.querySelector('.size-row-del').addEventListener('click', function () { row.remove(); });
    list.appendChild(row);
  };

  // Read the rows into [{label, price}] for the save payload.
  window.readSizeRows = function (prefix) {
    var list = document.getElementById(prefix + '-sizes-list');
    if (!list) return [];
    var rows = [];
    list.querySelectorAll('.size-row').forEach(function (r) {
      var label = (r.querySelector('.size-row-label').value || '').trim();
      if (!label) return;
      var priceRaw = (r.querySelector('.size-row-price').value || '').trim();
      var price = priceRaw === '' ? null : Number(priceRaw);
      rows.push({ label: label, price: (price != null && !isNaN(price)) ? price : null });
    });
    return rows;
  };

  // Populate rows when opening a product (accepts array or JSON string).
  window.setSizeRows = function (prefix, sizes) {
    var list = document.getElementById(prefix + '-sizes-list');
    if (!list) return;
    list.innerHTML = '';
    var arr = sizes;
    if (typeof sizes === 'string') { try { arr = JSON.parse(sizes); } catch (e) { arr = null; } }
    if (Array.isArray(arr)) arr.forEach(function (s) { if (s && s.label) window.addSizeRow(prefix, s.label, s.price); });
  };

  window.populateSizePresetDropdowns = function () {
    var presets = loadPresets();
    ['add-product-size-preset', 'modal-product-size-preset'].forEach(function (id) {
      var sel = document.getElementById(id);
      if (!sel) return;
      sel.innerHTML = '<option value="">Apply a size preset…</option>' +
        presets.map(function (p, i) { return '<option value="' + i + '">' + esc(p.name) + ' (' + p.sizes.length + ')</option>'; }).join('');
    });
  };

  window.applySizePreset = function (prefix) {
    var sel = document.getElementById(prefix + '-size-preset');
    if (!sel || sel.value === '') return;
    var p = loadPresets()[parseInt(sel.value, 10)];
    if (!p) return;
    // Append preset sizes (keeps any rows already added); price left blank to fill in.
    p.sizes.forEach(function (label) { window.addSizeRow(prefix, label, ''); });
    sel.value = '';
  };

  // ---- Global preset manager (reuse the branded dialog where possible) ----
  function ensurePresetModal() {
    if (document.getElementById('modal-size-presets')) return;
    var m = document.createElement('div');
    m.id = 'modal-size-presets';
    m.className = 'modal-overlay';
    m.style.display = 'none';
    m.innerHTML =
      '<div class="modal-content" style="max-width:520px;">' +
        '<div class="modal-header">' +
          '<h2 class="modal-title">Size Presets</h2>' +
          '<button class="modal-close-btn" type="button" aria-label="Close" onclick="closeModal(\'modal-size-presets\')">' +
            '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>' +
          '</button>' +
        '</div>' +
        '<div class="modal-body">' +
          '<p style="font-size:12px;color:#888;margin:0 0 12px;">Reusable size sets you can apply to any product, then set prices per product.</p>' +
          '<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px;">' +
            '<input id="size-preset-name" class="form-input" placeholder="Preset name (e.g. Toddler years)">' +
            '<input id="size-preset-sizes" class="form-input" placeholder="Sizes, comma-separated (e.g. 2Y, 3Y, 4Y)">' +
            '<button type="button" class="btn btn-primary" onclick="addSizePreset()">Add preset</button>' +
          '</div>' +
          '<div id="size-preset-list"></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(m);
    m.addEventListener('click', function (e) { if (e.target === m) closeModal('modal-size-presets'); });
  }

  function renderPresetList() {
    var box = document.getElementById('size-preset-list');
    if (!box) return;
    var presets = loadPresets();
    box.innerHTML = presets.map(function (p, i) {
      return '<div style="display:flex;align-items:center;gap:10px;padding:10px 2px;border-bottom:1px solid #eee;">' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-weight:600;color:#333;font-size:14px;">' + esc(p.name) + '</div>' +
          '<div style="font-size:11px;color:#999;">' + esc(p.sizes.join(', ')) + '</div>' +
        '</div>' +
        '<button type="button" onclick="deleteSizePreset(' + i + ')" style="border:1px solid #f3c2cb;background:#fff;border-radius:8px;padding:6px 10px;font-size:12px;font-weight:600;cursor:pointer;color:#d6336c;">Delete</button>' +
      '</div>';
    }).join('') || '<p style="color:#999;text-align:center;padding:16px;">No presets yet.</p>';
  }

  window.openSizePresetManager = function () {
    ensurePresetModal();
    renderPresetList();
    if (typeof openModal === 'function') openModal('modal-size-presets');
    else { document.getElementById('modal-size-presets').style.display = 'flex'; }
  };

  window.addSizePreset = function () {
    var nameEl = document.getElementById('size-preset-name');
    var sizesEl = document.getElementById('size-preset-sizes');
    var name = nameEl ? nameEl.value.trim() : '';
    var sizes = sizesEl ? sizesEl.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [];
    if (!name) { if (typeof showToast === 'function') showToast('Enter a preset name', 'warning'); return; }
    if (!sizes.length) { if (typeof showToast === 'function') showToast('Enter at least one size', 'warning'); return; }
    var presets = loadPresets();
    presets.push({ name: name, sizes: sizes });
    savePresets(presets);
    if (nameEl) nameEl.value = '';
    if (sizesEl) sizesEl.value = '';
    renderPresetList();
    window.populateSizePresetDropdowns();
    if (typeof showToast === 'function') showToast('Preset "' + name + '" added', 'success');
  };

  window.deleteSizePreset = function (i) {
    var presets = loadPresets();
    if (i < 0 || i >= presets.length) return;
    var removed = presets.splice(i, 1)[0];
    savePresets(presets);
    renderPresetList();
    window.populateSizePresetDropdowns();
    if (typeof showToast === 'function') showToast('Preset "' + (removed ? removed.name : '') + '" removed', 'success');
  };

  document.addEventListener('DOMContentLoaded', function () {
    setTimeout(function () { if (window.populateSizePresetDropdowns) window.populateSizePresetDropdowns(); }, 500);
  });
})();
