import './firebase-auth.js';

const Auth = window.DCKidsAuth;
const data = { customer: null, orders: [], addresses: [], wishlist: [], reviews: [] };
let activeTab = 'profile';
let loadedCustomerId = null;
let accountRecoveryAction = null;
let accountRecoveryOffline = false;

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const money = (value) => `GH₵ ${Number(value || 0).toFixed(2)}`;
const shortDate = (value) => value ? new Date(value).toLocaleDateString('en-GH', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
const iconButton = (label, action, id, glyph) => `<button class="account-icon-btn" type="button" aria-label="${escapeHtml(label)}" data-action="${action}" data-id="${id}">${glyph}</button>`;
const editGlyph = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z"/><path d="m13.5 7.5 3 3"/></svg>';
const deleteGlyph = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/></svg>';

function setVisible(id, visible) { const element = $(id); if (element) element.hidden = !visible; }
function notice(message, kind = 'error') {
  const element = $('authMessage');
  if (!element) return;
  element.textContent = message || '';
  element.classList.toggle('is-success', kind === 'success');
  element.setAttribute('role', kind === 'success' ? 'status' : 'alert');
  element.setAttribute('aria-live', kind === 'success' ? 'polite' : 'assertive');
  element.hidden = !message;
}

function noticeAddress(message) {
  const element = $('addressMessage');
  if (!element) return;
  element.textContent = message || '';
  element.hidden = !message;
}

function recoveryCopy(error, fallback) {
  if (!navigator.onLine) return 'Reconnect to the internet, then try again. Your account information has not been changed.';
  return String((error && error.message) || fallback || 'The request could not be completed.');
}

function clearRecovery() {
  const recovery = $('accountRecovery');
  if (recovery) recovery.hidden = true;
  accountRecoveryAction = null;
  accountRecoveryOffline = false;
}

function showRecovery(title, message, retryAction, offline = !navigator.onLine) {
  const recovery = $('accountRecovery');
  if (!recovery) return;
  $('accountRecoveryTitle').textContent = title;
  $('accountRecoveryMessage').textContent = message;
  accountRecoveryAction = typeof retryAction === 'function' ? retryAction : null;
  accountRecoveryOffline = offline;
  const retryButton = $('accountRecoveryRetry');
  retryButton.hidden = !accountRecoveryAction;
  retryButton.disabled = offline;
  recovery.hidden = false;
  recovery.focus({ preventScroll: true });
  recovery.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function showAuthView(view) {
  const map = { signin: 'authSignIn', register: 'authRegister', reset: 'authReset', verify: 'authVerify' };
  Object.values(map).forEach((id) => setVisible(id, id === map[view]));
  notice('');
}

function setBusy(button, busy, busyText) {
  if (!button) return;
  button.setAttribute('aria-busy', String(busy));
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = busyText || 'Please wait…';
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
  }
}

async function jsonResponse(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Request failed');
  return body;
}

async function customerJson(path, options) {
  return jsonResponse(await Auth.apiFetch(path, options));
}

async function mergeGuestWishlist() {
  let guestIds;
  try { guestIds = JSON.parse(localStorage.getItem('dcKidsGuestWishlist') || '[]'); } catch (error) { guestIds = []; }
  if (!Array.isArray(guestIds) || !guestIds.length) return;
  await customerJson('/api/wishlist/merge', { method: 'POST', body: JSON.stringify({ productIds: guestIds }) });
  localStorage.removeItem('dcKidsGuestWishlist');
}

async function loadAccountData(force = false) {
  const state = Auth.getState();
  if (!state.customer) return;
  if (!force && loadedCustomerId === state.customer.id) return;
  data.customer = state.customer;
  $('accountDashboard').setAttribute('aria-busy', 'true');
  try {
    await mergeGuestWishlist();
    const [customer, orders, addresses, wishlist, reviews] = await Promise.all([
      customerJson('/api/customer/me'),
      customerJson('/api/customer/orders'),
      customerJson('/api/customer/addresses'),
      customerJson('/api/wishlist'),
      customerJson('/api/customer/reviews')
    ]);
    data.customer = customer;
    data.orders = orders;
    data.addresses = addresses;
    data.wishlist = wishlist;
    data.reviews = reviews;
    loadedCustomerId = customer.id;
    clearRecovery();
    renderDashboard();
    $('accountDashboard').setAttribute('aria-busy', 'false');
  } catch (error) {
    renderProfile();
    const unavailable = '<div class="account-empty">This information is temporarily unavailable. Use the recovery action above to try again.</div>';
    $('recentOrders').innerHTML = unavailable;
    $('ordersList').innerHTML = unavailable;
    $('addressesList').innerHTML = unavailable;
    $('wishlistList').innerHTML = unavailable;
    $('reviewsList').innerHTML = unavailable;
    openTab(activeTab);
    $('accountDashboard').setAttribute('aria-busy', 'false');
    showRecovery("We couldn't refresh your account", recoveryCopy(error), () => loadAccountData(true));
  }
}

function initials(name) {
  return String(name || 'DC').trim().split(/\s+/).slice(0, 2).map((part) => part.charAt(0).toUpperCase()).join('') || 'DC';
}

function renderProfile() {
  const customer = data.customer || {};
  $('welcomeName').textContent = String(customer.name || 'there').split(/\s+/)[0];
  $('profileInitials').textContent = initials(customer.name);
  $('profileDisplayName').textContent = customer.name || 'DC Kids customer';
  $('profileDisplayEmail').textContent = customer.email || '';
  $('profileDisplayPhone').textContent = customer.phone || 'No phone saved';
  $('profileName').value = customer.name || '';
  $('profileEmail').value = customer.email || '';
  $('profilePhone').value = customer.phone || '';
}

function statusClass(status) {
  return `account-status account-status--${String(status || 'pending').toLowerCase().replace(/[^a-z_]/g, '')}`;
}

function orderRow(order, compact = false) {
  const row = `<div class="account-row">
    <strong>${escapeHtml(order.order_number)}</strong>
    <span class="account-row__muted">${escapeHtml(shortDate(order.created_at))}</span>
    <span>${escapeHtml(money(order.total_amount))}</span>
    <span class="${statusClass(order.status)}">${escapeHtml(String(order.status || 'pending').replace(/_/g, ' '))}</span>
    <span aria-hidden="true">›</span>
  </div>`;
  if (compact) return row;
  const items = (order.items || []).map((item) => `<div class="account-order__item"><span>${escapeHtml(item.quantity)} × ${escapeHtml(item.product_name)}</span><strong>${escapeHtml(money(item.quantity * item.price_at_time))}</strong></div>`).join('');
  return `<details class="account-order"><summary>${row}</summary><div class="account-order__items">${items || '<div class="account-empty">Item details are unavailable for this order.</div>'}</div></details>`;
}

function renderOrders() {
  const recent = data.orders.slice(0, 2);
  $('recentOrders').innerHTML = recent.length ? recent.map((order) => orderRow(order, true)).join('') : '<div class="account-empty">No signed-in orders yet. <a href="/index.html">Start shopping</a>.</div>';
  $('ordersList').innerHTML = data.orders.length ? data.orders.map((order) => orderRow(order)).join('') : '<div class="account-empty">Orders placed while you are signed in will appear here.</div>';
}

function addressText(address) {
  return [address.address_line1, address.address_line2, address.city, address.region, address.country].filter(Boolean).join(', ');
}

function renderAddresses() {
  $('addressesList').innerHTML = data.addresses.length ? data.addresses.map((address) => `
    <div class="account-address-row">
      <span class="account-address-row__icon"><svg viewBox="0 0 24 24"><path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></svg></span>
      <div class="account-address-row__copy"><strong>${escapeHtml(address.label || 'Address')}</strong><span>${escapeHtml(addressText(address))}</span></div>
      ${address.is_default ? '<span class="account-default">Default</span>' : ''}
      <div class="account-address-actions">${iconButton('Edit address', 'edit-address', address.id, editGlyph)}${iconButton('Delete address', 'delete-address', address.id, deleteGlyph)}</div>
    </div>`).join('') : '<div class="account-empty">No saved addresses yet. Add one to make checkout faster.</div>';
}

function productImage(product) {
  const source = String(product.img || product.product_image || 'images/placeholder.svg').replace(/^\//, '');
  return `/${escapeHtml(source)}`;
}

function renderWishlist() {
  $('wishlistList').innerHTML = data.wishlist.length ? data.wishlist.map((product) => `
    <article class="account-product">
      <img src="${productImage(product)}" alt="${escapeHtml(product.name || '')}" onerror="this.src='/images/placeholder.svg'">
      <div><strong>${escapeHtml(product.name || 'Product')}</strong><span>${escapeHtml(money(product.price))}</span></div>
      ${iconButton('Remove from wishlist', 'remove-wishlist', product.product_id, deleteGlyph)}
    </article>`).join('') : '<div class="account-empty">Your wishlist is empty. <a href="/index.html">Browse the shop</a>.</div>';
}

function renderReviews() {
  $('reviewsList').innerHTML = data.reviews.length ? data.reviews.map((review) => `
    <article class="account-review-row">
      <img src="${productImage(review)}" alt="${escapeHtml(review.product_name || '')}" onerror="this.src='/images/placeholder.svg'">
      <div><strong>${escapeHtml(review.product_name || 'Product')}</strong><div class="account-stars" aria-label="${review.rating} out of 5 stars">${'★'.repeat(review.rating)}${'☆'.repeat(5 - review.rating)}</div><span class="account-row__muted">${escapeHtml(shortDate(review.created_at))}</span></div>
      <div class="account-review-body">${review.title ? `<strong>${escapeHtml(review.title)}</strong><br>` : ''}${escapeHtml(review.body)}</div>
      <span class="account-status">${escapeHtml(review.status || 'approved')}</span>
    </article>`).join('') : '<div class="account-empty">You have not written any signed-in reviews yet.</div>';
}

function renderDashboard() {
  renderProfile();
  renderOrders();
  renderAddresses();
  renderWishlist();
  renderReviews();
  openTab(activeTab);
}

function openTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.account-tab').forEach((button) => {
    const selected = button.dataset.tab === tab;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  document.querySelectorAll('.account-panel').forEach((panel) => { panel.hidden = panel.id !== `panel-${tab}`; });
}

function renderAuthState(state) {
  setVisible('accountLoading', state.loading);
  setVisible('accountAuth', !state.loading && !state.customer);
  setVisible('accountDashboard', !state.loading && !!state.customer);
  $('accountSignOut').hidden = !state.user;

  if (state.loading) return;
  if (state.customer) {
    notice('');
    loadAccountData();
    return;
  }
  if (state.user && !state.user.emailVerified) {
    $('verificationEmail').textContent = state.user.email || '';
    showAuthView('verify');
  } else {
    showAuthView('signin');
  }
  if (state.error) notice(state.error);
}

function openAddressDialog(address) {
  noticeAddress('');
  $('addressDialogTitle').textContent = address ? 'Edit address' : 'Add address';
  $('addressId').value = address ? address.id : '';
  $('addressLabel').value = address ? address.label || '' : 'Home';
  $('addressRecipient').value = address ? address.recipient_name || '' : data.customer.name || '';
  $('addressPhone').value = address ? address.phone || '' : data.customer.phone || '';
  $('addressLine1').value = address ? address.address_line1 || '' : '';
  $('addressLine2').value = address ? address.address_line2 || '' : '';
  $('addressCity').value = address ? address.city || '' : '';
  $('addressRegion').value = address ? address.region || '' : '';
  $('addressDefault').checked = address ? !!address.is_default : data.addresses.length === 0;
  $('addressDialog').showModal();
}

document.querySelectorAll('[data-auth-view]').forEach((button) => button.addEventListener('click', () => showAuthView(button.dataset.authView)));
document.querySelectorAll('.account-tab').forEach((button) => button.addEventListener('click', () => openTab(button.dataset.tab)));
document.querySelector('.account-tabs').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = Array.from(document.querySelectorAll('.account-tab'));
  const currentIndex = tabs.indexOf(document.activeElement);
  if (currentIndex < 0) return;
  event.preventDefault();
  let nextIndex;
  if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = tabs.length - 1;
  else if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
  else nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
  openTab(tabs[nextIndex].dataset.tab);
  tabs[nextIndex].focus();
});
document.querySelectorAll('[data-open-tab]').forEach((button) => button.addEventListener('click', () => openTab(button.dataset.openTab)));

$('accountRecoveryRetry').addEventListener('click', async (event) => {
  if (!accountRecoveryAction || accountRecoveryOffline) return;
  const retryAction = accountRecoveryAction;
  setBusy(event.currentTarget, true, 'Trying again...');
  try {
    await retryAction();
  } catch (error) {
    showRecovery('The retry did not complete', recoveryCopy(error), retryAction);
  } finally {
    setBusy(event.currentTarget, false);
  }
});

$('googleSignIn').addEventListener('click', async (event) => {
  const button = event.currentTarget; setBusy(button, true, 'Opening Google…'); notice('');
  try { await Auth.signInGoogle(); } catch (error) { notice(error.message); } finally { setBusy(button, false); }
});

$('signInForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  const button = event.currentTarget.querySelector('[type="submit"]'); setBusy(button, true, 'Signing in…'); notice('');
  try { await Auth.signInEmail($('signInEmail').value, $('signInPassword').value); } catch (error) { notice(error.message); } finally { setBusy(button, false); }
});

$('registerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  const password = $('registerPassword').value;
  if (password.length < 8) return notice('Use a password with at least 8 characters.');
  if (password !== $('registerConfirm').value) return notice('The passwords do not match.');
  const button = event.currentTarget.querySelector('[type="submit"]'); setBusy(button, true, 'Creating account…'); notice('');
  try {
    await Auth.registerWithEmail({ name: $('registerName').value, phone: $('registerPhone').value, email: $('registerEmail').value, password });
    $('verificationEmail').textContent = $('registerEmail').value.trim();
    showAuthView('verify');
  } catch (error) { notice(error.message); } finally { setBusy(button, false); }
});

$('resetForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  const button = event.currentTarget.querySelector('[type="submit"]'); setBusy(button, true, 'Sending…'); notice('');
  try { await Auth.sendPasswordReset($('resetEmail').value); notice('If an account exists for that email, Firebase has sent a reset link.', 'success'); } catch (error) { notice(error.message); } finally { setBusy(button, false); }
});

$('resendVerification').addEventListener('click', async () => {
  try { await Auth.resendVerification(); notice('A new verification email has been sent.', 'success'); } catch (error) { notice(error.message); }
});
$('checkVerification').addEventListener('click', async (event) => {
  setBusy(event.currentTarget, true, 'Checking…'); notice('');
  try {
    const state = await Auth.refreshVerification();
    if (!state.user || !state.user.emailVerified) notice('The email is not verified yet. Open the link in your email, then check again.');
  } catch (error) { notice(error.message); } finally { setBusy(event.currentTarget, false); }
});
$('verifySignOut').addEventListener('click', () => Auth.signOut());
$('accountSignOut').addEventListener('click', () => Auth.signOut());

$('profileForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  const form = event.currentTarget;
  const button = event.currentTarget.querySelector('[type="submit"]'); setBusy(button, true, 'Saving…');
  let saved = false;
  try {
    const result = await customerJson('/api/customer/me', { method: 'PUT', body: JSON.stringify({ name: $('profileName').value.trim(), phone: $('profilePhone').value.trim() }) });
    data.customer = result.customer;
    renderProfile();
    clearRecovery();
    saved = true;
  } catch (error) {
    showRecovery('Your profile was not saved', recoveryCopy(error), () => form.requestSubmit());
  } finally {
    setBusy(button, false);
    if (saved) {
      button.textContent = 'Saved';
      window.setTimeout(() => { button.textContent = 'Save profile'; }, 1400);
    }
  }
});

$('addAddress').addEventListener('click', () => openAddressDialog(null));
$('closeAddressDialog').addEventListener('click', () => $('addressDialog').close());
$('addressForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  noticeAddress('');
  const id = $('addressId').value;
  const body = {
    label: $('addressLabel').value.trim(), recipient_name: $('addressRecipient').value.trim(), phone: $('addressPhone').value.trim(),
    address_line1: $('addressLine1').value.trim(), address_line2: $('addressLine2').value.trim(), city: $('addressCity').value.trim(),
    region: $('addressRegion').value.trim(), country: 'Ghana', is_default: $('addressDefault').checked
  };
  const button = event.currentTarget.querySelector('[type="submit"]'); setBusy(button, true, 'Saving…');
  try {
    await customerJson(id ? `/api/customer/addresses/${id}` : '/api/customer/addresses', { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) });
    $('addressDialog').close();
    loadedCustomerId = null;
    await loadAccountData(true);
  } catch (error) {
    noticeAddress(recoveryCopy(error, 'The address was not saved. Check the details and try again.'));
  } finally { setBusy(button, false); }
});

async function deleteAddress(address) {
  try {
    await customerJson(`/api/customer/addresses/${address.id}`, { method: 'DELETE' });
    await loadAccountData(true);
    clearRecovery();
  } catch (error) {
    showRecovery('The address was not deleted', recoveryCopy(error), () => deleteAddress(address));
  }
}

async function removeWishlistItem(productId) {
  try {
    await customerJson(`/api/wishlist/${productId}`, { method: 'DELETE' });
    await loadAccountData(true);
    clearRecovery();
  } catch (error) {
    showRecovery('The wishlist item was not removed', recoveryCopy(error), () => removeWishlistItem(productId));
  }
}

$('addressesList').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]'); if (!button) return;
  const address = data.addresses.find((item) => String(item.id) === String(button.dataset.id));
  if (!address) return;
  if (button.dataset.action === 'edit-address') return openAddressDialog(address);
  if (button.dataset.action === 'delete-address' && window.confirm(`Delete the ${address.label || 'saved'} address?`)) {
    await deleteAddress(address);
  }
});

$('wishlistList').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action="remove-wishlist"]'); if (!button) return;
  await removeWishlistItem(button.dataset.id);
});

window.addEventListener('offline', () => {
  showRecovery('You are offline', 'Reconnect to continue using your account. Your entered information remains on this page.', () => window.location.reload(), true);
});

window.addEventListener('online', () => {
  if (!accountRecoveryOffline) return;
  const retryAction = accountRecoveryAction || (() => window.location.reload());
  showRecovery('Connection restored', 'You are back online. Use Try again to continue.', retryAction, false);
});

Auth.onChange(renderAuthState);
await Auth.ready;
if (new URLSearchParams(window.location.search).get('verified') === '1' && Auth.getState().user) {
  try { await Auth.refreshVerification(); } catch (error) { notice(error.message); }
}
