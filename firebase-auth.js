import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js';
import {
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  onIdTokenChanged,
  reload,
  sendEmailVerification,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  updateProfile
} from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js';

const state = {
  configured: false,
  initialized: false,
  loading: true,
  user: null,
  customer: null,
  error: ''
};
const listeners = new Set();
let auth = null;
let lastSessionUid = '';
let resolveInitialState;
const initialState = new Promise((resolve) => { resolveInitialState = resolve; });

function snapshot() {
  return {
    configured: state.configured,
    initialized: state.initialized,
    loading: state.loading,
    user: state.user,
    customer: state.customer,
    error: state.error
  };
}

function emit() {
  const detail = snapshot();
  listeners.forEach((listener) => listener(detail));
  window.dispatchEvent(new CustomEvent('dckids-auth-change', { detail }));
}

function friendlyError(error) {
  const code = String(error && error.code || '');
  const messages = {
    'auth/invalid-credential': 'The email or password is incorrect.',
    'auth/email-already-in-use': 'An account already exists for this email. Try signing in instead.',
    'auth/weak-password': 'Use a password with at least 8 characters.',
    'auth/invalid-email': 'Enter a valid email address.',
    'auth/too-many-requests': 'Too many attempts. Please wait a little and try again.',
    'auth/network-request-failed': 'Check your connection and try again.',
    'auth/popup-closed-by-user': 'Google sign-in was closed before it finished.',
    'auth/account-exists-with-different-credential': 'This email already uses another sign-in method. Sign in with that method first.',
    'auth/user-disabled': 'This account is unavailable. Contact DC Kids for help.'
  };
  return messages[code] || (error && error.message) || 'Something went wrong. Please try again.';
}

async function parseResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'Request failed');
    error.code = data.code || `http/${response.status}`;
    throw error;
  }
  return data;
}

async function customerFetch(path, options = {}) {
  if (!auth || !auth.currentUser || !auth.currentUser.emailVerified) {
    const error = new Error('Sign in with a verified email to continue.');
    error.code = 'auth/email-not-verified';
    throw error;
  }
  const token = await auth.currentUser.getIdToken();
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return fetch(path, Object.assign({}, options, { headers }));
}

async function establishSession(user, profile) {
  if (!user || !user.emailVerified) return null;
  const token = await user.getIdToken();
  const stored = sessionStorage.getItem('dcKidsPendingCustomerProfile');
  let pending;
  try { pending = stored ? JSON.parse(stored) : {}; } catch (error) { pending = {}; }
  const body = {
    name: (profile && profile.name) || pending.name || user.displayName || '',
    phone: (profile && profile.phone) || pending.phone || ''
  };
  const response = await fetch('/api/customer/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  });
  const data = await parseResponse(response);
  sessionStorage.removeItem('dcKidsPendingCustomerProfile');
  state.customer = data.customer;
  lastSessionUid = user.uid;
  return data;
}

async function synchronizeUser(user, force = false) {
  state.user = user || null;
  state.customer = null;
  state.error = '';
  if (user && user.emailVerified) {
    try {
      if (force || lastSessionUid !== user.uid) await establishSession(user);
      if (!state.customer) {
        const response = await customerFetch('/api/customer/me');
        state.customer = await parseResponse(response);
      }
    } catch (error) {
      state.error = friendlyError(error);
    }
  } else {
    lastSessionUid = '';
  }
  state.loading = false;
  state.initialized = true;
  emit();
  resolveInitialState(snapshot());
  return snapshot();
}

async function initialize() {
  // Remove the retired local customer JWT if an older page left one behind.
  localStorage.removeItem('dcKidsCustomerToken');
  try {
    const config = await parseResponse(await fetch('/api/customer/auth/config', { cache: 'no-store' }));
    if (!config.apiKey || !config.authDomain || !config.projectId || !config.appId) {
      throw new Error('Customer sign-in has not been configured yet.');
    }
    const firebaseApp = initializeApp(config);
    auth = getAuth(firebaseApp);
    await setPersistence(auth, browserLocalPersistence);
    state.configured = true;
    // Subscribe before resolving a redirect so Firebase can restore an existing
    // local session even when a browser rejects the redirect helper's storage.
    onIdTokenChanged(auth, (user) => { synchronizeUser(user); });
    await getRedirectResult(auth).catch((error) => { throw error; });
  } catch (error) {
    state.error = friendlyError(error);
    state.loading = false;
    state.initialized = true;
    emit();
    resolveInitialState(snapshot());
  }
  return initialState;
}

const ready = initialize();

async function registerWithEmail({ name, phone, email, password }) {
  if (!auth) throw new Error(state.error || 'Customer sign-in is unavailable.');
  if (String(password || '').length < 8) throw new Error('Use a password with at least 8 characters.');
  sessionStorage.setItem('dcKidsPendingCustomerProfile', JSON.stringify({ name: String(name || '').trim(), phone: String(phone || '').trim() }));
  try {
    const credential = await createUserWithEmailAndPassword(auth, String(email || '').trim(), password);
    if (name) await updateProfile(credential.user, { displayName: String(name).trim() });
    await sendEmailVerification(credential.user, {
      url: `${window.location.origin}/account.html?verified=1`,
      handleCodeInApp: false
    });
    await synchronizeUser(credential.user, true);
    return credential.user;
  } catch (error) {
    sessionStorage.removeItem('dcKidsPendingCustomerProfile');
    throw new Error(friendlyError(error), { cause: error });
  }
}

async function signInEmail(email, password) {
  if (!auth) throw new Error(state.error || 'Customer sign-in is unavailable.');
  try {
    const credential = await signInWithEmailAndPassword(auth, String(email || '').trim(), password);
    await synchronizeUser(credential.user, true);
    return credential.user;
  } catch (error) { throw new Error(friendlyError(error), { cause: error }); }
}

async function signInGoogle() {
  if (!auth) throw new Error(state.error || 'Customer sign-in is unavailable.');
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    // Popup sign-in also works on mobile when it starts directly from a tap.
    // It avoids the cross-origin redirect storage restrictions that can lose
    // the result after the customer returns from Google's account chooser.
    const credential = await signInWithPopup(auth, provider);
    await synchronizeUser(credential.user, true);
    return credential.user;
  } catch (error) {
    if (['auth/popup-blocked', 'auth/cancelled-popup-request', 'auth/operation-not-supported-in-this-environment'].includes(error.code)) {
      await signInWithRedirect(auth, provider);
      return null;
    }
    throw new Error(friendlyError(error), { cause: error });
  }
}

async function resendVerification() {
  if (!auth || !auth.currentUser) throw new Error('Sign in again to resend the verification email.');
  await sendEmailVerification(auth.currentUser, { url: `${window.location.origin}/account.html?verified=1`, handleCodeInApp: false });
}

async function refreshVerification() {
  if (!auth || !auth.currentUser) return snapshot();
  await reload(auth.currentUser);
  await auth.currentUser.getIdToken(true);
  return synchronizeUser(auth.currentUser, true);
}

async function sendPasswordReset(email) {
  if (!auth) throw new Error(state.error || 'Customer sign-in is unavailable.');
  try {
    await sendPasswordResetEmail(auth, String(email || '').trim(), { url: `${window.location.origin}/account.html` });
  } catch (error) { throw new Error(friendlyError(error), { cause: error }); }
}

async function signOutCustomer() {
  if (auth) await signOut(auth);
  state.customer = null;
  lastSessionUid = '';
}

window.DCKidsAuth = {
  ready,
  getState: snapshot,
  onChange(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); },
  apiFetch: customerFetch,
  getIdToken: async () => auth && auth.currentUser ? auth.currentUser.getIdToken() : '',
  registerWithEmail,
  signInEmail,
  signInGoogle,
  resendVerification,
  refreshVerification,
  sendPasswordReset,
  signOut: signOutCustomer,
  friendlyError
};
