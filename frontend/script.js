"use strict";

/* ==========================================================================
   TM Market frontend
   --------------------------------------------------------------------------
   index.html            public landing page (anyone can look, any click asks for login)
   homepage.html         main marketplace (login required)
   product.html          shop (login required)
   vendor-register.html  sell (login required)
   Backend: unchanged. Same API_URL, same endpoints, same request bodies,
   same localStorage keys (tm_token, tm_user, tm-market-cart, tm-market-wishlist).
   ========================================================================== */

const API_URL = 'https://tm-market-backend.fly.dev';

const TOKEN_KEY = 'tm_token';
const USER_KEY = 'tm_user';
const LANDING = 'index.html';
const HOME = 'homepage.html';
const PROTECTED_PAGES = ['homepage', 'product', 'vendor-register'];
const LOADER_MIN = { login: 3000, page: 600 };   // ms; minimum only for the login -> marketplace transition and page load
const LOADER_FAILSAFE = 20000;                   // ms; loader can never stay up longer than this

// --- Products come from the backend (GET /api/products). Nothing is hardcoded. ---
const products = [];
const PLACEHOLDER_IMG = 'assets/logo.svg';

const CONDITION_LABELS = { new: 'New', used: 'Used', repaired: 'Repaired' };

function mapProduct(r) {
  const qty = r.quantity === null || r.quantity === undefined ? null : Number(r.quantity);
  const available = r.available !== false && (r.status || 'active') === 'active' && (qty === null || qty > 0);
  let stock = 'In stock';
  if (!available) stock = r.status === 'sold' ? 'Sold' : 'Sold out';
  else if (qty !== null && qty <= 5) stock = `Only ${qty} left`;
  const price = Number(r.price);
  const cmp = r.compare_at_price ? Number(r.compare_at_price) : null;
  const images = (r.images || []).map(i => i.image_url).filter(Boolean);
  return {
    id: String(r.id), name: r.name || '', category: r.category_name || 'Other',
    price, oldPrice: cmp && cmp > price ? cmp : null,
    image: r.image_url || images[0] || PLACEHOLDER_IMG, images,
    description: r.description || '', seller: r.seller_name || '', location: r.location || r.seller_location || '',
    available, stock, badge: available ? '' : stock, quantity: qty,
    condition: CONDITION_LABELS[r.item_condition] ? r.item_condition : ''
  };
}

// Only numeric ids are real products. Drop leftovers from the old demo catalogue.
function purgeLegacyDemoState() {
  for (const k of ['tm-market-cart', 'tm-market-wishlist']) {
    const arr = load(k, []);
    if (!Array.isArray(arr)) { save(k, []); continue; }
    const clean = arr.filter(x => /^\d+$/.test(String(x && typeof x === 'object' ? x.id : x)));
    if (clean.length !== arr.length) save(k, clean);
  }
}

/* ---------- small helpers ---------- */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const load = (k, fallback) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? fallback; } catch { return fallback; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } };
const money = n => new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", maximumFractionDigits: 0 }).format(n);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const params = () => new URLSearchParams(location.search);
const currentPage = (location.pathname.split('/').pop() || 'index').replace(/\.html$/, '');

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v);
  }
  kids.forEach(k => n.append(k));
  return n;
}

// UI Toast Notification
function toast(message, ms = 2600) {
  const t = $("#toast") || (() => { const n = el('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.appendChild(n); return n; })();
  t.textContent = message;
  t.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove("show"), ms);
}

/* ---------- authentication state (uses the existing tm_token / tm_user) ---------- */
const profileExtraKey = email => `tm_profile:${String(email || '').toLowerCase()}`;

const Auth = {
  token() { return localStorage.getItem(TOKEN_KEY); },
  user() { try { return JSON.parse(localStorage.getItem(USER_KEY) || '{}') || {}; } catch { return {}; } },
  expired(token) {
    // If the token is a standard JWT with an "exp" claim, honour it. Anything else is left to the backend.
    try {
      const p = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return !!p.exp && p.exp * 1000 < Date.now();
    } catch { return false; }
  },
  isLoggedIn() {
    const t = this.token();
    if (!t) return false;
    if (this.expired(t)) { this.clear(); return false; }
    return true;
  },
  save(data) {
    localStorage.setItem(TOKEN_KEY, data.token);
    const user = data.user || {};
    // The profile (phone, address, picture) now lives on the server; avatarUrl is shown as "avatar".
    localStorage.setItem(USER_KEY, JSON.stringify({ ...user, avatar: user.avatarUrl || undefined }));
  },
  clear() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); }
};

function safeNext(n) {
  // Only allow same-site, known pages (prevents open redirects).
  if (!n) return null;
  const file = String(n).split(/[?#]/)[0];
  return /^[\w-]+(\.html)?$/.test(file) && PROTECTED_PAGES.includes(file.replace(/\.html$/, '')) ? n : null;
}

/* ---------- route guard: runs immediately, before the page paints ---------- */
function guardRoute() {
  const protectedPage = PROTECTED_PAGES.includes(currentPage) || (document.body && document.body.hasAttribute('data-protected'));
  if (!protectedPage || Auth.isLoggedIn()) return true;
  location.replace(`${LANDING}?next=${encodeURIComponent(currentPage + '.html' + location.search + location.hash)}`);
  return false;
}
const routeAllowed = guardRoute();

/* ---------- one reusable loader ---------- */
const Loader = {
  el: null, count: 0, timer: null,
  ensure() {
    if (this.el) return this.el;
    let n = $('#pageLoader');
    if (!n) {
      n = el('div', { id: 'pageLoader', class: 'loader-overlay', role: 'status', 'aria-live': 'polite' });
      n.hidden = true;
      n.innerHTML = '<div class="loader-box"><img class="loader-logo" src="assets/logo.svg" alt="TM Market"><div class="loader-bar"><i></i></div><p class="loader-text">Loading…</p></div>';
      document.body.appendChild(n);
    }
    return (this.el = n);
  },
  show(text = 'Loading…') {
    const n = this.ensure();
    this.count++;
    n.querySelector('.loader-text').textContent = text;
    n.classList.remove('out');
    n.hidden = false;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.hide(true); toast('This is taking longer than expected. Please try again.'); }, LOADER_FAILSAFE);
  },
  hide(force = false) {
    if (!this.el) return;
    this.count = force ? 0 : Math.max(0, this.count - 1);
    if (this.count > 0) return;
    clearTimeout(this.timer);
    this.el.classList.add('out');
    setTimeout(() => { if (this.count === 0) this.el.hidden = true; }, 220);
  },
  // Wrap any promise/function: loader shows while it runs and always hides, even on error.
  async run(task, { text, min = 0 } = {}) {
    this.show(text);
    const t0 = Date.now();
    try { return await (typeof task === 'function' ? task() : task); }
    finally {
      const wait = min - (Date.now() - t0);
      if (wait > 0) await sleep(wait);
      this.hide();
    }
  }
};
function go(dest, text = 'Loading…') { Loader.show(text); location.href = dest; }

/* ---------- API (same endpoints and bodies as before) ---------- */
async function apiPost(path, body) {
  let res;
  try {
    res = await fetch(`${API_URL}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch { throw new Error('Unable to reach TM Market. Check your connection and try again.'); }
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON response */ }
  if (!res.ok) throw new Error(res.status < 500 && data.message ? data.message : 'Something went wrong. Please try again.');
  return data;
}

/* ---------- login / sign-up modal (built once, shared by every page) ---------- */
let pending = null;   // { href?: string, run?: function } - what the visitor was trying to do
let resetToken = null;   // from the emailed link (#reset=...), kept in memory only

function buildAuthModal() {
  if ($('#authModal')) return;
  const d = el('div', { id: 'authModal', class: 'modal-overlay' });
  d.hidden = true;
  d.innerHTML = `
  <div class="modal-card" role="dialog" aria-modal="true" aria-label="Log in or sign up">
    <button id="closeAuthModal" class="close-btn" type="button" aria-label="Close">&times;</button>
    <img class="auth-logo" src="assets/logo.svg" alt="TM Market">
    <p id="authNotice" class="auth-notice" hidden></p>
    <div class="auth-tabs">
      <button id="tabLoginBtn" class="auth-tab active" type="button">Login</button>
      <button id="tabRegisterBtn" class="auth-tab" type="button">Sign Up</button>
    </div>
    <form id="login-form" class="auth-form">
      <h3>Welcome back</h3>
      <p id="loginError" class="form-error" role="alert" hidden></p>
      <div class="form-group"><label for="login-email">Email</label><input type="email" id="login-email" placeholder="email@example.com" autocomplete="email" required></div>
      <div class="form-group"><label for="login-password">Password</label><input type="password" id="login-password" placeholder="••••••••" autocomplete="current-password" required></div>
      <button type="submit" class="btn btn-primary btn-block">Log In</button>
      <p class="auth-aux"><button type="button" class="link-btn" id="forgotLink">Forgot password?</button></p>
    </form>
    <form id="forgot-form" class="auth-form" hidden>
      <h3>Reset your password</h3>
      <p class="form-note">Enter your account email and we will send you a link to choose a new password.</p>
      <p id="forgotError" class="form-error" role="alert" hidden></p>
      <div class="form-group"><label for="forgot-email">Email</label><input type="email" id="forgot-email" placeholder="email@example.com" autocomplete="email" required></div>
      <button type="submit" class="btn btn-primary btn-block">Send reset link</button>
      <p class="auth-aux"><button type="button" class="link-btn" data-back-login>Back to log in</button></p>
    </form>
    <form id="reset-form" class="auth-form" hidden>
      <h3>Choose a new password</h3>
      <p id="resetError" class="form-error" role="alert" hidden></p>
      <div class="form-group"><label for="reset-new">New password</label><input type="password" id="reset-new" placeholder="At least 8 characters" autocomplete="new-password" minlength="8" required></div>
      <div class="form-group"><label for="reset-confirm">Confirm new password</label><input type="password" id="reset-confirm" autocomplete="new-password" required></div>
      <button type="submit" class="btn btn-primary btn-block">Update password</button>
      <p class="auth-aux"><button type="button" class="link-btn" data-back-login>Back to log in</button></p>
    </form>
    <form id="register-form" class="auth-form" hidden>
      <h3>Create an account</h3>
      <p id="registerError" class="form-error" role="alert" hidden></p>
      <div class="form-group"><label for="reg-name">Full Name</label><input type="text" id="reg-name" placeholder="John Doe" autocomplete="name" required></div>
      <div class="form-group"><label for="reg-email">Email</label><input type="email" id="reg-email" placeholder="email@example.com" autocomplete="email" required></div>
      <div class="form-group"><label for="reg-phone">Phone number</label><input type="tel" id="reg-phone" placeholder="08012345678" autocomplete="tel" inputmode="tel" required></div>
      <div class="form-group"><label for="reg-password">Password</label><input type="password" id="reg-password" placeholder="At least 8 characters" autocomplete="new-password" minlength="8" required></div>
      <button type="submit" class="btn btn-primary btn-block">Sign Up</button>
    </form>
  </div>`;
  document.body.appendChild(d);

  d.addEventListener('mousedown', e => { d._down = e.target === d; });
  d.addEventListener('click', e => { if (e.target === d && d._down) closeAuth(true); });
  $('#closeAuthModal').addEventListener('click', () => closeAuth(true));
  $('#tabLoginBtn').addEventListener('click', () => switchTab('login'));
  $('#tabRegisterBtn').addEventListener('click', () => switchTab('register'));

  $('#login-form').addEventListener('submit', e => {
    e.preventDefault();
    handleLogin($('#login-email').value.trim(), $('#login-password').value);
  });
  $('#register-form').addEventListener('submit', e => {
    e.preventDefault();
    handleRegister($('#reg-name').value.trim(), $('#reg-email').value.trim(), $('#reg-phone').value.trim(), $('#reg-password').value);
  });

  $('#forgotLink').addEventListener('click', () => {
    setFormError('forgot', ''); setNotice('');
    $('#forgot-email').value = $('#login-email').value.trim();
    switchTab('forgot');
    $('#forgot-email').focus();
  });
  d.querySelectorAll('[data-back-login]').forEach(b => b.addEventListener('click', () => { setNotice(''); switchTab('login'); }));

  $('#forgot-form').addEventListener('submit', async e => {
    e.preventDefault();
    setFormError('forgot', '');
    setFormBusy('#forgot-form', true, 'Sending…');
    try {
      const data = await apiPost('/api/forgot-password', { email: $('#forgot-email').value.trim() });
      switchTab('login');
      setNotice(data.message || 'If an account exists for that email, we have sent a reset link.');
    } catch (ex) { setFormError('forgot', ex.message); }
    finally { setFormBusy('#forgot-form', false); }
  });

  $('#reset-form').addEventListener('submit', async e => {
    e.preventDefault();
    setFormError('reset', '');
    const nw = $('#reset-new').value, cf = $('#reset-confirm').value;
    if (nw.length < 8) return setFormError('reset', 'New password must be at least 8 characters.');
    if (nw !== cf) return setFormError('reset', 'The new passwords do not match.');
    setFormBusy('#reset-form', true, 'Updating…');
    try {
      const data = await apiPost('/api/reset-password', { token: resetToken, newPassword: nw });
      resetToken = null;
      $('#reset-form').reset();
      switchTab('login');
      setNotice(data.message || 'Your password has been updated. Please log in.');
    } catch (ex) { setFormError('reset', ex.message); }
    finally { setFormBusy('#reset-form', false); }
  });
}

function switchTab(tab) {
  const forms = { login: '#login-form', register: '#register-form', forgot: '#forgot-form', reset: '#reset-form' };
  if (!forms[tab]) tab = 'login';
  for (const [name, sel] of Object.entries(forms)) $(sel).hidden = name !== tab;
  $('#tabLoginBtn').classList.toggle('active', tab === 'login');
  $('#tabRegisterBtn').classList.toggle('active', tab === 'register');
  $('.auth-tabs').hidden = tab === 'forgot' || tab === 'reset';
}
function setNotice(text) { const n = $('#authNotice'); if (!n) return; n.textContent = text || ''; n.hidden = !text; }
function setFormError(which, text) { const n = $(`#${which}Error`); if (!n) return; n.textContent = text || ''; n.hidden = !text; }
function setFormBusy(formSel, busy, label) {
  const b = $(`${formSel} button[type=submit]`);
  if (!b) return;
  if (busy) { b.dataset.label = b.textContent; b.textContent = label; } else if (b.dataset.label) { b.textContent = b.dataset.label; }
  b.disabled = busy;
}

function openAuth(tab = 'login', notice = '') {
  buildAuthModal();
  switchTab(tab);
  setNotice(notice);
  setFormError('login', ''); setFormError('register', ''); setFormError('forgot', ''); setFormError('reset', '');
  $('#authModal').hidden = false;
  document.body.style.overflow = 'hidden';
  setTimeout(() => $({ register: '#reg-name', reset: '#reset-new', forgot: '#forgot-email' }[tab] || '#login-email')?.focus(), 60);
}
function closeAuth(manual = false) {
  const m = $('#authModal');
  if (m) m.hidden = true;
  document.body.style.overflow = '';
  if (manual) pending = null;   // visitor dismissed it themselves: forget the pending action
}

// Ask for login before a protected action, then continue that action afterwards.
function requireAuth(action, opts = {}) {
  if (Auth.isLoggedIn()) { if (typeof action === 'function') action(); return true; }
  updateAuthUI();
  pending = { run: typeof action === 'function' ? action : null, href: opts.href || null };
  openAuth('login', opts.notice || 'Please log in or sign up to continue.');
  return false;
}

async function handleLogin(email, password) {
  setFormError('login', '');
  setFormBusy('#login-form', true, 'Signing in…');
  const t0 = Date.now();
  Loader.show('Signing you in…');
  let data;
  try {
    data = await apiPost('/api/login', { email, password });
    if (!data.token) throw new Error('Sign-in failed. Please try again.');
  } catch (err) {
    Loader.hide();                                   // never leave the loader up on failure
    setFormBusy('#login-form', false);
    setFormError('login', err.message);
    return null;
  }
  Auth.save(data);
  const wait = LOADER_MIN.login - (Date.now() - t0);  // short, controlled minimum so the transition feels smooth
  if (wait > 0) await sleep(wait);
  setFormBusy('#login-form', false);
  const navigating = afterLogin();
  if (!navigating) Loader.hide();
  return data;
}

// Login succeeded: close the modal by itself, refresh the UI and continue what the visitor wanted.
function afterLogin() {
  closeAuth();
  $('#login-form')?.reset();
  updateAuthUI();
  const p = pending; pending = null;
  if (document.body.dataset.page === 'landing') {
    go(p?.href || safeNext(params().get('next')) || HOME, 'Opening your marketplace…');
    return true;
  }
  toast(`Welcome back, ${Auth.user().name || 'there'}!`);
  if (p?.run) p.run();
  return false;
}

async function handleRegister(name, email, phone, password) {
  setFormError('register', '');
  setFormBusy('#register-form', true, 'Creating account…');
  Loader.show('Creating your account…');
  try {
    const data = await apiPost('/api/register', { name, email, phone, password });
    Loader.hide();
    setFormBusy('#register-form', false);
    $('#register-form').reset();
    switchTab('login');
    $('#login-email').value = email;
    setNotice('Registration successful! You can now log in.');
    $('#login-password').focus();
    return data;
  } catch (err) {
    Loader.hide();
    setFormBusy('#register-form', false);
    setFormError('register', err.message);
    return null;
  }
}

function handleLogout() {
  Auth.clear();
  Loader.show('Signing you out…');
  setTimeout(() => { location.href = LANDING; }, 500);
}

/* ---------- header account area ---------- */
function updateAuthUI() {
  const landing = document.body.dataset.page === 'landing';
  $$('#authContainer').forEach(box => {
    box.replaceChildren();
    if (Auth.isLoggedIn()) {
      const user = Auth.user();
      const name = user.name || (user.email ? user.email.split('@')[0] : 'Account');
      if (landing) {
        box.append(el('a', { class: 'btn-sm btn-sm-primary', href: HOME, 'data-public': '', text: 'Open marketplace →' }));
      } else {
        const img = el('img', { class: 'nav-avatar', alt: '', src: user.avatar || 'assets/default-avatar.svg' });
        box.append(el('button', { id: 'openProfileBtn', class: 'profile-chip', type: 'button', 'aria-label': 'Open my profile' }, img, el('span', { text: name.split(' ')[0] })));
      }
      box.append(el('button', { id: 'logoutBtn', class: 'btn-sm', type: 'button', 'data-public': '', text: 'Logout' }));
    } else {
      box.append(el('button', { class: 'btn-sm', type: 'button', 'data-auth-open': 'login', 'data-public': '', text: 'Login' }));
      box.append(el('button', { class: 'btn-sm btn-sm-primary', type: 'button', 'data-auth-open': 'register', 'data-public': '', text: 'Sign Up' }));
    }
  });
}

/* ---------- profile modal (logged-in pages): saved on the server ---------- */
function buildProfileModal() {
  if ($('#profileModal')) return;
  const d = el('div', { id: 'profileModal', class: 'modal-overlay' });
  d.hidden = true;
  d.innerHTML = `
  <div class="modal-card profile-card" role="dialog" aria-modal="true" aria-label="My profile">
    <button id="closeProfileModal" class="close-btn" type="button" aria-label="Close">&times;</button>
    <h3>My Profile</h3>
    <div class="profile-avatar-section">
      <div class="avatar-wrapper">
        <img id="profileAvatarPrev" src="assets/default-avatar.svg" alt="Profile picture" class="profile-avatar-img">
        <label for="avatarInput" class="avatar-edit-badge" title="Change profile picture">📷</label>
        <input type="file" id="avatarInput" accept="image/jpeg,image/png,image/webp" hidden>
      </div>
      <small>Tap the camera to change your picture</small>
    </div>
    <form id="profile-form" novalidate>
      <p class="form-error" id="profileError" role="alert" hidden></p>
      <p class="form-note" id="profileLegacyNote" hidden>We found details saved on this device. Press Save to keep them on your account.</p>
      <div class="form-group"><label for="profile-name">Full Name</label><input type="text" id="profile-name" maxlength="200" required></div>
      <div class="form-group"><label for="profile-email">Email Address</label><input type="email" id="profile-email" disabled></div>
      <div class="form-group"><label for="profile-phone">Phone Number</label><input type="tel" id="profile-phone" inputmode="tel" placeholder="08012345678"></div>
      <div class="form-group"><label for="profile-address">Delivery Address</label><input type="text" id="profile-address" maxlength="500" placeholder="123 Main St, Lagos"></div>
      <button type="submit" class="btn btn-primary btn-block">Save Changes</button>
      <p class="form-note">Your phone number identifies your account, so each number can belong to one account only.</p>
    </form>
    <form id="password-form" class="profile-sep" novalidate>
      <h4>Change password</h4>
      <p class="form-error" id="passwordError" role="alert" hidden></p>
      <div class="form-group"><label for="pw-current">Current password</label><input type="password" id="pw-current" autocomplete="current-password"></div>
      <div class="form-group"><label for="pw-new">New password</label><input type="password" id="pw-new" autocomplete="new-password" minlength="8" placeholder="At least 8 characters"></div>
      <div class="form-group"><label for="pw-confirm">Confirm new password</label><input type="password" id="pw-confirm" autocomplete="new-password"></div>
      <button type="submit" class="btn btn-ghost btn-block">Update password</button>
      <p class="form-note">Changing your password signs you out on your other devices.</p>
    </form>
  </div>`;
  document.body.appendChild(d);

  d.addEventListener('mousedown', e => { d._down = e.target === d; });
  d.addEventListener('click', e => { if (e.target === d && d._down) d.hidden = true; });
  $('#closeProfileModal').addEventListener('click', () => { d.hidden = true; });

  let pendingAvatar = null;       // resized picture waiting to be uploaded when the profile is saved
  d._clearPending = () => { pendingAvatar = null; };

  $('#avatarInput').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { toast('Please choose a JPG, PNG or WebP image.'); return; }
    const reader = new FileReader();
    reader.onerror = () => toast('Unable to read that image. Please try another.');
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => toast('Unable to read that image. Please try another.');
      img.onload = () => {                     // shrink to 256px before uploading
        const s = Math.min(1, 256 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        $('#profileAvatarPrev').src = c.toDataURL('image/jpeg', 0.85);
        c.toBlob(b => { pendingAvatar = b; }, 'image/jpeg', 0.85);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });

  $('#profile-form').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#profileError'); err.hidden = true;
    const body = { address: $('#profile-address').value.trim() };
    const name = $('#profile-name').value.trim();
    const phone = $('#profile-phone').value.trim();
    if (name) body.name = name;
    if (phone) body.phone = phone;
    let photoWarning = '';
    try {
      await Loader.run(async () => {
        if (pendingAvatar) {
          try { body.avatarUrl = await uploadImage(pendingAvatar, '/api/me/uploads/sign'); }
          catch (ex) { photoWarning = ex.message; }          // a failed picture must not block the rest
        }
        const data = await apiRequest('PUT', '/api/me/profile', body);
        Auth.save({ token: Auth.token(), user: data.user });
      }, { text: 'Saving your profile…' });
    } catch (ex) { err.textContent = ex.message; err.hidden = false; return; }
    pendingAvatar = null;
    updateAuthUI();
    d.hidden = true;
    toast(photoWarning ? `Profile saved, but the picture was not: ${photoWarning}` : 'Profile updated successfully!', photoWarning ? 5000 : undefined);
  });

  $('#password-form').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#passwordError'); err.hidden = true;
    const cur = $('#pw-current').value, nw = $('#pw-new').value, cf = $('#pw-confirm').value;
    const fail = t => { err.textContent = t; err.hidden = false; };
    if (!cur) return fail('Please enter your current password.');
    if (nw.length < 8) return fail('New password must be at least 8 characters.');
    if (nw !== cf) return fail('The new passwords do not match.');
    try {
      const data = await Loader.run(() => apiRequest('POST', '/api/me/change-password', { currentPassword: cur, newPassword: nw }), { text: 'Updating password…' });
      Auth.save(data);                      // fresh token keeps this device signed in
      $('#password-form').reset();
      toast('Password changed. Other devices were signed out.', 5000);
    } catch (ex) { fail(ex.message); }
  });
}

function fillProfileForm(user) {
  $('#profile-name').value = user.name || '';
  $('#profile-email').value = user.email || '';
  $('#profile-phone').value = user.phone || '';
  $('#profile-address').value = user.address || '';
  $('#profileAvatarPrev').src = user.avatar || user.avatarUrl || 'assets/default-avatar.svg';
}

async function openProfileModal() {
  buildProfileModal();
  $('#profileModal')._clearPending?.();
  $('#profileError').hidden = true; $('#passwordError').hidden = true; $('#profileLegacyNote').hidden = true;
  fillProfileForm(Auth.user());
  $('#profileModal').hidden = false;

  try {                                    // refresh from the server so every device shows the same profile
    const { user } = await apiRequest('GET', '/api/me');
    Auth.save({ token: Auth.token(), user });
    fillProfileForm(Auth.user());
    updateAuthUI();
    // Details saved on this device by the old version: offer to move them to the account.
    const old = load(profileExtraKey(user.email), {});
    let used = false;
    if (!$('#profile-phone').value && old.phone) { $('#profile-phone').value = old.phone; used = true; }
    if (!$('#profile-address').value && old.address) { $('#profile-address').value = old.address; used = true; }
    $('#profileLegacyNote').hidden = !used;
  } catch { /* offline or session problem: the stored copy stays on screen */ }
}

/* ---------- landing page (index.html): look freely, any click asks for login ---------- */
function initLandingGate() {
  document.addEventListener('click', e => {
    if (e.target.closest('#authModal, #toast, [data-public]')) return;
    const a = e.target.closest('a[href], button, select, [data-category]');
    if (!a) return;
    const href = a.tagName === 'A' ? (a.getAttribute('href') || '') : '';
    if (a.tagName === 'A') {
      if (href === '#') { e.preventDefault(); return; }
      if (href.startsWith('#') || /^(mailto:|tel:)/.test(href)) return;   // scrolling around the landing page is fine
    }
    e.preventDefault();
    e.stopPropagation();
    const dest = safeNext(href) || HOME;
    if (Auth.isLoggedIn()) return go(dest);
    pending = { href: dest };
    openAuth('login', 'Please log in or sign up to continue.');
  }, true);

  document.addEventListener('submit', e => {
    if (e.target.closest('#authModal, [data-public]')) return;   // data-public: the chat form is allowed for everyone
    e.preventDefault(); e.stopPropagation();
    if (Auth.isLoggedIn()) return go(HOME);
    pending = { href: HOME };
    openAuth('register', 'Create a free account to continue.');
  }, true);

  document.addEventListener('focusin', e => {
    if (!e.target.matches('#searchInput')) return;
    e.target.blur();
    if (Auth.isLoggedIn()) return go(HOME);
    pending = { href: HOME };
    openAuth('login', 'Log in to search the marketplace.');
  });

  // Sent here by a protected page (e.g. someone opened profile page without being logged in)
  const next = safeNext(params().get('next'));
  if (next) {
    if (Auth.isLoggedIn()) go(next);
    else { pending = { href: next }; openAuth('login', 'Please log in to continue.'); }
  }
}

/* ---------- storefront (grid, cart, wishlist, checkout) ---------- */
function initStorefront() {
  const PAYMENT_QUEUE_KEY = 'tm-market-payment-queue';
  const state = {
    filter: "All", query: "", sort: "newest", onlyWishlist: false, page: 1, total: 0, timer: null,
    cart: load("tm-market-cart", []),
    wishlist: load("tm-market-wishlist", []),
    coupon: null
  };

  function inferCity(address, stateName) {
    const parts = String(address || '').split(',').map(x => x.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const tail = parts[parts.length - 1];
      if (tail.length >= 2 && tail.toLowerCase() !== String(stateName || '').toLowerCase()) return tail;
      const prev = parts[parts.length - 2];
      if (prev && prev.length >= 2) return prev;
    }
    if (typeof stateName === 'string' && stateName.trim().length >= 2) return stateName.trim();
    return 'Nigeria';
  }

  function removePurchasedItems(order) {
    const items = Array.isArray(order && order.items) ? order.items : [];
    const remaining = [...state.cart];

    for (const item of items) {
      const productId = String(item.productId);
      let need = Number(item.quantity) || 0;
      for (const line of remaining) {
        if (String(line.id) !== productId || need <= 0) continue;
        const take = Math.min(line.qty, need);
        line.qty -= take;
        need -= take;
      }
    }

    state.cart = remaining.filter(x => x.qty > 0);
    save("tm-market-cart", state.cart);
    renderCart();
  }

  function updateResumePaymentsButton() {
    const btn = $("#resumePaymentsBtn");
    if (!btn) return;
    const queue = readPaymentQueue();
    btn.hidden = queue.length === 0;
    btn.textContent = queue.length <= 1
      ? 'Resume pending payment →'
      : `Resume ${queue.length} pending payments →`;
  }

  function readPaymentQueue() {
    const raw = load(PAYMENT_QUEUE_KEY, []);
    if (!Array.isArray(raw)) return [];
    return raw
      .map(x => Number.parseInt(x, 10))
      .filter(Number.isInteger)
      .filter(x => x > 0);
  }

  function savePaymentQueue(ids) {
    save(PAYMENT_QUEUE_KEY, Array.isArray(ids) ? ids : []);
    updateResumePaymentsButton();
  }

  async function redirectToPaystack(orderId) {
    const callbackUrl = `${location.origin}${location.pathname}?payreturn=1&orderId=${encodeURIComponent(orderId)}`;
    const pay = await Loader.run(
      () => apiRequest('POST', '/api/payments/initialize', { orderId, callbackUrl }),
      { text: 'Connecting to Paystack…' }
    );

    if (!pay.success || !pay.payment || !pay.payment.authorizationUrl) {
      throw new Error(pay.message || 'Unable to start payment. Please try again.');
    }

    Loader.show('Redirecting to Paystack…');
    location.href = pay.payment.authorizationUrl;
  }

  async function verifyPaystackReturn() {
    const q = new URLSearchParams(location.search);
    const payReturn = q.get('payreturn');
    const orderId = q.get('orderId');
    const reference = q.get('reference') || q.get('trxref');
    if (payReturn !== '1' || !orderId || !reference || !Auth.isLoggedIn()) return;

    const clean = new URL(location.href);
    clean.searchParams.delete('payreturn');
    clean.searchParams.delete('orderId');
    clean.searchParams.delete('reference');
    clean.searchParams.delete('trxref');
    history.replaceState({}, '', clean.pathname + clean.search + clean.hash);

    let allPaid = false;
    await Loader.run(async () => {
      const out = await apiRequest('GET', `/api/payments/verify?orderId=${encodeURIComponent(orderId)}&reference=${encodeURIComponent(reference)}`);
      if (!out.success) throw new Error(out.message || 'Payment verification failed.');

      try {
        const details = await apiRequest('GET', `/api/orders/${encodeURIComponent(orderId)}`);
        if (details && details.order) removePurchasedItems(details.order);
      } catch {
        // Verification already succeeded; this read is best-effort to keep the cart in sync.
      }

      const queue = readPaymentQueue();
      const nextOrderId = queue.shift();
      savePaymentQueue(queue);

      if (nextOrderId) {
        toast('Payment confirmed. Redirecting for the next seller payment…', 3200);
        await redirectToPaystack(nextOrderId);
        return;
      }

      toast(out.message || 'Payment confirmed. Your order is now confirmed.', 4500);
      allPaid = true;
    }, { text: 'Verifying your payment…' });
    if (allPaid) openOrders();   // show the new order with its delivery dates
  }
  /* ---------- my orders + delivery tracking ---------- */
  const TRACK_STEPS = [
    { key: 'confirmed', label: 'Paid' },
    { key: 'processing', label: 'Preparing' },
    { key: 'shipped', label: 'On the way' },
    { key: 'delivered', label: 'Delivered' }
  ];
  const ORDER_STATUS_LABEL = {
    pending: 'Waiting for payment', confirmed: 'Paid', processing: 'Being prepared',
    shipped: 'On the way', delivered: 'Delivered', cancelled: 'Cancelled'
  };
  const AUTO_NOTE = /^(Payment received|Buyer confirmed delivery|Delivery expected between)/;
  const ordersView = { page: 1, total: 0, items: [], busy: false };

  // "2026-10-08" -> a local date (no time-zone shifting).
  function dayToDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  }
  const fmtDay = d => d.toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric', month: 'short' });
  const fmtStamp = iso => {
    const d = iso ? new Date(iso) : null;
    return d && !isNaN(d) ? d.toLocaleDateString('en-NG', { day: 'numeric', month: 'short' }) : '';
  };

  // The sentence the buyer reads about when the goods arrive. Never invents a date.
  function deliveryLine(o) {
    if (o.status === 'delivered') {
      const when = fmtStamp(o.deliveredAt);
      return { text: when ? `Delivered on ${when}` : 'Delivered', late: false };
    }
    const from = o.deliveryWindow && dayToDate(o.deliveryWindow.from);
    const to = o.deliveryWindow && dayToDate(o.deliveryWindow.to);
    if (!from || !to) return { text: 'Your seller will confirm the delivery dates soon.', late: false };

    const text = from.getTime() === to.getTime()
      ? `Expected on ${fmtDay(from)}`
      : `Expected between ${fmtDay(from)} and ${fmtDay(to)}`;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return { text, late: today.getTime() > to.getTime() };
  }

  function renderTracker(o) {
    const at = TRACK_STEPS.findIndex(s => s.key === o.status);
    const wrap = el('div', { class: 'track', role: 'list', 'aria-label': 'Order progress' });
    TRACK_STEPS.forEach((s, i) => {
      const ev = (o.events || []).find(e => e.status === s.key);   // earliest event for this step
      const cls = 'track-step' + (i < at ? ' done' : '') + (i === at ? ' current' : '');
      wrap.append(el('div', { class: cls, role: 'listitem' },
        el('i', { 'aria-hidden': 'true', text: i <= at ? '✓' : '' }),
        el('b', { text: s.label }),
        el('small', { text: i <= at && ev ? fmtStamp(ev.at) : '' })
      ));
    });
    return wrap;
  }

  function renderOrderCard(o) {
    const card = el('article', { class: 'order-card' });
    const who = (o.seller && o.seller.storeName) || 'TM Market seller';
    card.append(el('div', { class: 'order-head' },
      el('div', {}, el('strong', { text: o.orderNumber }), el('small', { text: `${who} · ${fmtStamp(o.createdAt)}` })),
      el('span', { class: `order-pill is-${o.status}`, text: ORDER_STATUS_LABEL[o.status] || o.status })
    ));

    const list = el('ul', { class: 'order-items' });
    (o.items || []).forEach(i => list.append(el('li', {},
      el('span', { text: `${i.quantity} × ${i.name}` }), el('span', { text: money(i.totalPrice) })
    )));
    card.append(list, el('div', { class: 'order-total' }, el('span', { text: 'Total' }), el('strong', { text: money(o.total) })));

    if (['confirmed', 'processing', 'shipped', 'delivered'].includes(o.status)) {
      card.append(renderTracker(o));
      const line = deliveryLine(o);
      const box = el('div', { class: 'order-window' + (line.late ? ' is-late' : '') }, el('strong', { text: line.text }));
      if (line.late) {
        box.append(el('small', { text: 'This is taking longer than expected. Please contact support: tmmarketsupport@gmail.com' }));
      }
      const note = [...(o.events || [])].reverse().find(e => e.note && !AUTO_NOTE.test(e.note));
      if (note) box.append(el('small', { text: `Note: ${note.note}` }));
      card.append(box);
    }

    const actions = el('div', { class: 'order-actions' });
    if (o.status === 'pending') {
      const pay = el('button', { type: 'button', class: 'btn btn-primary', text: 'Pay now' });
      pay.addEventListener('click', async () => {
        pay.disabled = true;
        try { await redirectToPaystack(o.id); }
        catch (err) { pay.disabled = false; toast(err.message || 'Unable to start payment.', 4500); }
      });
      const cancel = el('button', { type: 'button', class: 'btn btn-ghost', text: 'Cancel order' });
      cancel.addEventListener('click', async () => {
        if (!confirm('Cancel this unpaid order?')) return;
        cancel.disabled = true;
        try { await apiRequest('POST', `/api/orders/${o.id}/cancel`); toast('Order cancelled.'); await loadOrders(true); }
        catch (err) { cancel.disabled = false; toast(err.message || 'Unable to cancel this order.', 4500); }
      });
      actions.append(pay, cancel);
    }
    if (o.status === 'shipped') {
      const got = el('button', { type: 'button', class: 'btn btn-primary', text: 'I have received this order' });
      got.addEventListener('click', async () => {
        if (!confirm('Confirm that you have received this order?')) return;
        got.disabled = true;
        try { await apiRequest('POST', `/api/orders/${o.id}/delivered`); toast('Thanks! Delivery confirmed.'); await loadOrders(true); }
        catch (err) { got.disabled = false; toast(err.message || 'Unable to confirm delivery.', 4500); }
      });
      actions.append(got);
    }
    if (actions.children.length) card.append(actions);
    return card;
  }

  function paintOrders(message) {
    const box = $("#ordersList"), more = $("#ordersMore");
    if (!box) return;
    box.replaceChildren();
    if (message) { box.append(el('p', { class: 'orders-note', text: message })); }
    else if (!ordersView.items.length) {
      box.append(el('p', { class: 'orders-note', text: 'No orders yet. When you buy something, you can track it here.' }));
    } else {
      ordersView.items.forEach(o => box.append(renderOrderCard(o)));
    }
    if (more) more.hidden = !!message || ordersView.items.length >= ordersView.total;
  }

  async function loadOrders(reset) {
    if (ordersView.busy) return;
    ordersView.busy = true;
    if (reset) { ordersView.page = 1; ordersView.items = []; paintOrders('Loading your orders…'); }
    try {
      const out = await apiRequest('GET', `/api/orders/me?page=${ordersView.page}&limit=10`);
      const rows = Array.isArray(out.orders) ? out.orders : [];
      ordersView.items = reset ? rows : ordersView.items.concat(rows);
      ordersView.total = Number(out.total) || 0;
      paintOrders();
    } catch (err) {
      paintOrders(err.message || 'We could not load your orders. Please try again.');
    } finally {
      ordersView.busy = false;
    }
  }

  function openOrders() {
    const dlg = $("#ordersModal");
    if (!dlg) { toast('Open the home page to see your orders.'); return; }
    if (!dlg.open) dlg.showModal();
    loadOrders(true);
  }

  const preview = Number(document.body.dataset.preview || 0);   // landing page shows a small read-only preview
  const product = id => products.find(p => p.id === id || p.id === Number(id));

  const SORT_MAP = { newest: "newest", "price-low": "price_asc", "price-high": "price_desc" };
  const PAGE_SIZE = preview || 12;
  let reqId = 0;

  async function loadWishlistProducts() {
    const found = await Promise.all(state.wishlist.map(id =>
      apiRequest("GET", `/api/products/${encodeURIComponent(id)}`)
        .then(d => mapProduct(d.product))
        .catch(e => (e.status === 404 ? null : Promise.reject(e)))));
    const items = found.filter(p => p && p.available !== undefined);
    state.wishlist = items.map(p => p.id);          // products that no longer exist drop out of the wishlist
    save("tm-market-wishlist", state.wishlist);
    return items;
  }

  async function loadProducts(reset = true) {
    const grid = $("#productGrid");
    if (!grid) return;
    const mine = ++reqId;
    if (reset) {
      state.page = 1;
      grid.innerHTML = '<p class="grid-status">Loading products…</p>';
      if ($("#noResults")) $("#noResults").hidden = true;
      if ($("#loadMore")) $("#loadMore").hidden = true;
    } else state.page++;
    if ($("#loadMore")) $("#loadMore").disabled = true;
    try {
      let items, total;
      if (state.onlyWishlist) { items = await loadWishlistProducts(); total = items.length; }
      else {
        const q = new URLSearchParams({ limit: PAGE_SIZE, page: state.page, sort: SORT_MAP[state.sort] || "newest" });
        if (state.query) q.set("search", state.query);
        if (state.filter !== "All") q.set("category", state.filter.toLowerCase());
        const data = await apiRequest("GET", `/api/products?${q}`);
        items = data.products.map(mapProduct);
        total = data.pagination ? data.pagination.total : items.length;
      }
      if (mine !== reqId) return;                    // a newer search already replaced this one
      if (reset || state.onlyWishlist) products.splice(0, products.length, ...items);
      else products.push(...items);
      state.total = total;
      renderProducts();
    } catch (err) {
      if (mine !== reqId) return;
      if (reset) grid.innerHTML = `<p class="grid-status is-error">${esc(err.message)} <button type="button" class="link-btn" id="retryProducts">Try again</button></p>`;
      else { state.page--; toast(err.message, 4000); }
      if ($("#loadMore")) $("#loadMore").disabled = false;
    }
  }

  function renderProducts() {
    const grid = $("#productGrid"), list = products;
    if (!grid) return;
    const filtering = state.filter !== "All" || !!state.query || state.onlyWishlist;
    if ($("#resultsCount")) $("#resultsCount").textContent = `${state.total} product${state.total === 1 ? "" : "s"}`;

    const empty = $("#noResults");
    if (empty) {
      empty.hidden = !!list.length;
      const h = empty.querySelector("h3"), t = empty.querySelector("p"), b = $("#resetShop");
      if (!list.length) {
        h.textContent = filtering ? "No products found" : "No products yet";
        t.textContent = filtering ? "Try another search or clear your filters." : "Sellers are just getting started. Check back soon, or open your own store from the Sell page.";
        if (b) b.hidden = !filtering;
      }
    }
    grid.innerHTML = "";

    list.forEach(p => {
      const card = document.createElement("article");
      card.className = "product-card";
      const wished = state.wishlist.includes(p.id);
      const actionButton = p.available
        ? `<button class="add-btn" data-add="${esc(p.id)}" type="button" aria-label="Add ${esc(p.name)} to cart">+</button>`
        : "";
      const meta = [p.seller ? `By ${esc(p.seller)}` : "", p.location ? `📍 ${esc(p.location)}` : ""].filter(Boolean).join(" · ");
      const cond = p.condition ? `<span class="cond cond-${esc(p.condition)}">${esc(CONDITION_LABELS[p.condition])}</span>` : "";

      card.innerHTML = `<div class="product-media">
        ${p.badge ? `<span class="badge sale">${esc(p.badge)}</span>` : ""}
        <button class="heart ${wished ? "active" : ""}" data-wish="${esc(p.id)}" aria-label="${wished ? "Remove" : "Add"} ${esc(p.name)}">${wished ? "♥" : "♡"}</button>
        <a href="#" data-quick="${esc(p.id)}" aria-label="View ${esc(p.name)}"><img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy"></a>
        <button class="quick-view" data-quick="${esc(p.id)}" type="button">Quick view</button>
      </div>
      <div class="product-info">
        <div class="product-meta"><span class="product-category">${esc(p.category)}</span><span class="stock">${esc(p.stock)}</span></div>
        <h3><a href="#" data-quick="${esc(p.id)}">${esc(p.name)}</a></h3>
        ${(cond || meta) ? `<p class="seller-line">${cond}${cond && meta ? " " : ""}${meta}</p>` : ""}
        <div class="price-row"><div class="price">${money(p.price)} ${p.oldPrice ? `<span class="old-price">${money(p.oldPrice)}</span>` : ""}</div>${actionButton}</div>
      </div>`;
      grid.appendChild(card);
    });

    let more = $("#loadMore");
    if (!more) {
      const wrap = document.createElement("div");
      wrap.className = "load-more-wrap";
      wrap.innerHTML = '<button type="button" class="btn btn-ghost" id="loadMore" hidden>Load more products</button>';
      grid.after(wrap);
      more = $("#loadMore");
    }
    more.disabled = false;
    more.hidden = !!preview || state.onlyWishlist || products.length >= state.total;
  }

  function updateCounts() {
    const cartCount = state.cart.reduce((n, i) => n + i.qty, 0);
    if ($("#cartCount")) $("#cartCount").textContent = cartCount;
    if ($("#wishlistCount")) $("#wishlistCount").textContent = state.wishlist.length;
    if ($("#wishlistNavCount")) $("#wishlistNavCount").textContent = state.wishlist.length;
  }

  function renderCart() {
    const wrap = $("#cartItems");
    updateCounts();
    if (!wrap) return;
    const subtotal = state.cart.reduce((n, i) => n + i.price * i.qty, 0);
    const total = subtotal;

    if ($("#cartSubtotal")) $("#cartSubtotal").textContent = money(total);
    if ($("#checkoutTotal")) $("#checkoutTotal").textContent = money(total);

    wrap.innerHTML = "";
    if (!state.cart.length) {
      wrap.innerHTML = '<div class="cart-empty"><div style="font-size:38px">🛍</div><strong>Your bag is waiting</strong><span>Add something you love and it will appear here.</span></div>';
      updateResumePaymentsButton();
      return;
    }
    state.cart.forEach(item => {
      const line = document.createElement("div");
      line.className = "cart-line";
      line.innerHTML = `<img src="${esc(item.image)}" alt="${esc(item.name)}"><div><h3>${esc(item.name)}</h3><p>${money(item.price)}</p><div class="qty"><button data-qty="${esc(item.id)}" data-delta="-1" aria-label="Decrease">−</button><strong>${item.qty}</strong><button data-qty="${esc(item.id)}" data-delta="1" aria-label="Increase">+</button><button class="remove" data-remove="${esc(item.id)}" type="button">Remove</button></div></div><span class="line-total">${money(item.price * item.qty)}</span>`;
      wrap.appendChild(line);
    });
    updateResumePaymentsButton();
  }

  function addToCart(id) {
    const p = product(id);
    if (!p) return;
    const existing = state.cart.find(i => i.id === id);
    if (existing) existing.qty++;
    else state.cart.push({ id: p.id, name: p.name, price: p.price, image: p.image, qty: 1 });
    save("tm-market-cart", state.cart);
    renderCart();
    openCart();
    toast(`${p.name} added to your cart`);
  }

  function toggleWish(id) {
    const p = product(id), i = state.wishlist.indexOf(id);
    if (i > -1) { state.wishlist.splice(i, 1); toast("Removed from wishlist"); }
    else { state.wishlist.push(id); toast(`${p.name} saved to wishlist`); }
    save("tm-market-wishlist", state.wishlist);
    if (state.onlyWishlist) loadProducts(true); else renderProducts();
    updateCounts();
  }

  function openCart() { const d = $("#cartDrawer"); if (!d) return; d.classList.add("open"); d.setAttribute("aria-hidden", "false"); $("#drawerOverlay").hidden = false; document.body.style.overflow = "hidden"; }
  function closeCart() { const d = $("#cartDrawer"); if (!d) return; d.classList.remove("open"); d.setAttribute("aria-hidden", "true"); $("#drawerOverlay").hidden = true; document.body.style.overflow = ""; }

  function openQuick(id) {
    showProductDetails(id, { onAdd: p => { if (!product(p.id)) products.push(p); requireAuth(() => addToCart(p.id)); } });
  }

  function applyFilters() {
    $$(".chip").forEach(c => c.classList.toggle("active", c.dataset.filter === state.filter));
    loadProducts(true);
  }
  function resetFilters() {
    state.filter = "All"; state.query = ""; state.sort = "newest"; state.onlyWishlist = false;
    if ($("#searchInput")) $("#searchInput").value = "";
    if ($("#sortSelect")) $("#sortSelect").value = "newest";
    if ($("#clearSearch")) $("#clearSearch").hidden = true;
    applyFilters();
  }
  function showWishlist() {
    state.onlyWishlist = !state.onlyWishlist;
    loadProducts(true);
    $("#shop")?.scrollIntoView({ behavior: "smooth" });
    toast(state.onlyWishlist ? (state.wishlist.length ? "Showing your wishlist" : "Your wishlist is empty. Tap ♡ on a product to save it.") : "Showing all products");
  }

  /* --- events --- */
  $("#productGrid")?.addEventListener("click", e => {
    const add = e.target.closest("[data-add]"), wish = e.target.closest("[data-wish]"), quick = e.target.closest("[data-quick]");
    if (add) requireAuth(() => addToCart(add.dataset.add));
    if (wish) requireAuth(() => toggleWish(wish.dataset.wish));
    if (quick) { e.preventDefault(); openQuick(quick.dataset.quick); }
  });

  $("#cartItems")?.addEventListener("click", e => {
    const qty = e.target.closest("[data-qty]"), remove = e.target.closest("[data-remove]");
    if (qty) {
      const i = state.cart.find(x => x.id === qty.dataset.qty);
      if (i) {
        i.qty += Number(qty.dataset.delta);
        if (i.qty <= 0) state.cart = state.cart.filter(x => x.id !== i.id);
        save("tm-market-cart", state.cart);
        renderCart();
      }
    }
    if (remove) {
      state.cart = state.cart.filter(x => x.id !== remove.dataset.remove);
      save("tm-market-cart", state.cart);
      renderCart();
      toast("Item removed");
    }
  });

  $("#searchInput")?.addEventListener("input", e => {
    state.query = e.target.value.trim().toLowerCase();
    if ($("#clearSearch")) $("#clearSearch").hidden = !state.query;
    clearTimeout(state.timer);
    state.timer = setTimeout(() => loadProducts(true), 300);
  });
  $("#clearSearch")?.addEventListener("click", resetFilters);
  $$(".chip").forEach(c => c.addEventListener("click", () => { state.filter = c.dataset.filter; applyFilters(); }));
  $$(".category-card[data-category]").forEach(c => c.addEventListener("click", () => { state.filter = c.dataset.category; applyFilters(); $("#shop")?.scrollIntoView({ behavior: "smooth" }); }));
  $("#sortSelect")?.addEventListener("change", e => { state.sort = e.target.value; loadProducts(true); });
  $("#clearFilters")?.addEventListener("click", resetFilters);
  $("#resetShop")?.addEventListener("click", resetFilters);
  document.addEventListener("click", e => {
    if (e.target.closest("#retryProducts")) loadProducts(true);
    if (e.target.closest("#loadMore")) loadProducts(false);
  });
  $("#cartBtn")?.addEventListener("click", () => requireAuth(openCart));
  $("#closeCart")?.addEventListener("click", closeCart);
  $("#drawerOverlay")?.addEventListener("click", closeCart);
  $("#modalClose")?.addEventListener("click", () => $("#productModal").close());
  $("#wishlistBtn")?.addEventListener("click", showWishlist);
  $("#wishlistNav")?.addEventListener("click", showWishlist);
  $("#ordersNav")?.addEventListener("click", () => requireAuth(openOrders));
  $("#ordersClose")?.addEventListener("click", () => $("#ordersModal").close());
  $("#ordersMore")?.addEventListener("click", () => { ordersView.page += 1; loadOrders(false); });

  $("#modalContent")?.addEventListener("click", e => {
    const b = e.target.closest("[data-modal-add]");
    if (b) { requireAuth(() => addToCart(b.dataset.modalAdd)); $("#productModal").close(); }
  });

  $("#checkoutBtn")?.addEventListener("click", () => requireAuth(() => {
    if (!state.cart.length) { toast("Your bag is empty. Add something first."); return; }
    const u = Auth.user(), f = $("#checkoutForm");
    if (f) { f.elements.name.value ||= u.name || ""; f.elements.email.value ||= u.email || ""; f.elements.phone.value ||= u.phone || ""; f.elements.address.value ||= u.address || ""; }
    closeCart();
    $("#checkoutModal")?.showModal();
  }));
  $("#resumePaymentsBtn")?.addEventListener("click", () => requireAuth(async () => {
    const queue = readPaymentQueue();
    const nextOrderId = queue.shift();
    if (!nextOrderId) {
      savePaymentQueue([]);
      toast('No pending payments left to resume.');
      return;
    }

    savePaymentQueue(queue);

    try {
      await redirectToPaystack(nextOrderId);
    } catch (err) {
      savePaymentQueue([nextOrderId, ...readPaymentQueue()]);
      toast(err.message || 'Unable to resume payment right now.', 5000);
    }
  }));
  $("#checkoutClose")?.addEventListener("click", () => $("#checkoutModal").close());
  $("#checkoutForm")?.addEventListener("submit", async e => {
    e.preventDefault();
    if (!Auth.isLoggedIn()) { openAuth('login', 'Please log in to continue.'); return; }

    const form = e.currentTarget;
    const submitBtn = form.querySelector('button[type="submit"]');
    const oldText = submitBtn ? submitBtn.textContent : '';

    try {
      const paymentMethod = String(form.elements.payment?.value || '').trim().toLowerCase();
      if (paymentMethod !== 'pay online') {
        toast('Please choose "Pay online" to continue.');
        return;
      }

      if (!state.cart.length) {
        toast('Your bag is empty. Add something first.');
        return;
      }

      const shippingAddress = String(form.elements.address?.value || '').trim();
      const shippingState = String(form.elements.state?.value || '').trim();
      const shippingCity = inferCity(shippingAddress, shippingState);

      const payload = {
        items: state.cart.map(i => ({ productId: Number(i.id), quantity: Number(i.qty) })),
        shipping: {
          name: String(form.elements.name?.value || '').trim(),
          phone: String(form.elements.phone?.value || '').trim(),
          address: shippingAddress,
          city: shippingCity,
          state: shippingState
        }
      };

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Preparing payment…';
      }

      const created = await Loader.run(
        () => apiRequest('POST', '/api/orders', payload),
        { text: 'Creating your order…' }
      );

      const orders = Array.isArray(created.orders) ? created.orders : [];
      if (!orders.length) {
        throw new Error('No order was created. Please try again.');
      }

      const ids = orders.map(o => Number(o.id)).filter(Number.isInteger);
      const firstOrderId = ids.shift();
      savePaymentQueue(ids);

      if (orders.length > 1) {
        toast(`Your bag was split into ${orders.length} seller orders. You will complete ${orders.length} quick payments.`, 4800);
      }

      $("#checkoutModal")?.close();
      await redirectToPaystack(firstOrderId);
    } catch (err) {
      toast(err.message || 'Unable to start checkout right now.', 5000);
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = oldText || 'Place order securely';
      }
      Loader.hide();
    }
  });

  $("#themeBtn")?.addEventListener("click", () => {
    document.body.classList.toggle("dark");
    localStorage.setItem("tm-market-dark", document.body.classList.contains("dark"));
  });

  loadProducts(true);
  renderCart();
  updateResumePaymentsButton();
  if (params().get('cart') === '1' && Auth.isLoggedIn()) openCart();
  if (params().get('orders') === '1' && Auth.isLoggedIn()) openOrders();
  if (readPaymentQueue().length > 0) {
    toast('You have pending seller payments. Open your bag and tap "Resume pending payment".', 4200);
  }
  verifyPaystackReturn().catch(() => {
    toast('We could not verify that payment yet. Check your orders and try again.', 4500);
  });
}

/* ---------- shop page (product.html): rendered from the same products list ---------- */
function initShopPage() {
  const grid = $("#shopGrid");
  if (!grid) return;
  const catBox = $("#catFilters"), range = $("#priceRange"), readout = $("#priceReadout");
  const search = $("#shopSearch"), loc = $("#shopLocation"), more = $("#shopLoadMore");
  const wanted = (params().get('category') || '').toLowerCase();
  const PAGE_SIZE = 12, SORT = { newest: 'newest', 'price-low': 'price_asc', 'price-high': 'price_desc' };
  let page = 1, total = 0, reqId = 0, timer = null, priceCap = 0;
  const cart = () => load("tm-market-cart", []);

  const note = (text, isErr) => {
    const p = el('p', { class: 'grid-status' + (isErr ? ' is-error' : ''), text });
    if (isErr) { const b = el('button', { type: 'button', class: 'link-btn', text: 'Try again' }); b.addEventListener('click', () => fetchPage(true)); p.append(' ', b); }
    grid.replaceChildren(p);
  };

  function card(p) {
    const open = () => showProductDetails(p.id, { onAdd: x => addToBag(x) });
    const img = el('img', { src: p.image, alt: p.name, loading: 'lazy' });
    const title = el('h4', { text: p.name });
    [img, title].forEach(n => { n.style.cursor = 'pointer'; n.addEventListener('click', open); });
    const c = el('div', { class: 'product-card' });
    if (p.badge) c.append(el('span', { class: 'badge', text: p.badge }));
    c.append(img, title);
    if (p.condition) c.append(el('p', { class: 'seller-line' }, el('span', { class: 'cond cond-' + p.condition, text: CONDITION_LABELS[p.condition] })));
    if (p.seller) c.append(el('p', { class: 'seller-info' }, document.createTextNode('Sold by: '), el('strong', { text: p.seller })));
    if (p.location) c.append(el('p', { class: 'seller-line', text: '📍 ' + p.location }));
    c.append(el('p', { class: 'price', text: money(p.price) }));
    const b = el('button', { class: 'btn-cart', type: 'button', 'data-id': p.id, text: p.available ? 'Add to Bag' : 'Unavailable' });
    if (!p.available) b.disabled = true;
    c.append(b);
    return c;
  }

  async function fetchPage(reset) {
    const mine = ++reqId;
    if (reset) { page = 1; note('Loading products…'); more.hidden = true; } else page++;
    more.disabled = true;
    try {
      const q = new URLSearchParams({ limit: PAGE_SIZE, page, sort: SORT[$("#shopSort").value] || 'newest' });
      const cats = $$('#catFilters input:checked').map(i => i.value);
      if (cats.length) q.set('category', cats.join(','));
      if (search.value.trim()) q.set('search', search.value.trim());
      if (loc.value.trim()) q.set('location', loc.value.trim());
      if (priceCap && Number(range.value) < Number(range.max)) q.set('maxPrice', range.value);
      const data = await apiRequest('GET', `/api/products?${q}`);
      if (mine !== reqId) return;
      const items = data.products.map(mapProduct);
      total = data.pagination ? data.pagination.total : items.length;
      if (reset) { products.splice(0, products.length, ...items); grid.replaceChildren(); } else products.push(...items);
      if (!products.length) {
        const filtering = cats.length || search.value.trim() || loc.value.trim() || Number(range.value) < Number(range.max);
        grid.append(el('div', { class: 'empty-state' }, el('strong', { text: filtering ? 'No products match your filters' : 'No products yet' }),
          document.createTextNode(filtering ? 'Try a different category, location or price.' : 'Sellers are just getting started. Check back soon.')));
      } else items.forEach(p => grid.append(card(p)));
      more.disabled = false;
      more.hidden = products.length >= total;
    } catch (err) {
      if (mine !== reqId) return;
      if (reset) note(err.message, true); else { page--; more.disabled = false; toast(err.message, 4000); }
    }
  }

  function addToBag(p) {
    requireAuth(() => {
      if (!p.available) return toast('This product is no longer available.');
      const c = cart(), ex = c.find(i => i.id === p.id);
      if (ex) ex.qty++; else c.push({ id: p.id, name: p.name, price: p.price, image: p.image, qty: 1 });
      save("tm-market-cart", c); updateBagCount(); toast(`${p.name} added to your bag`);
    });
  }

  const refresh = () => { clearTimeout(timer); timer = setTimeout(() => fetchPage(true), 300); };
  grid.addEventListener('click', e => {
    const b = e.target.closest('.btn-cart'); if (!b) return;
    const p = products.find(x => x.id === b.dataset.id); if (p) addToBag(p);
  });
  catBox.addEventListener('change', refresh);
  $("#shopSort").addEventListener('change', refresh);
  search.addEventListener('input', refresh);
  loc.addEventListener('input', refresh);
  range.addEventListener('input', () => { readout.textContent = `Up to ${money(Number(range.value))}`; refresh(); });
  more.addEventListener('click', () => fetchPage(false));
  $("#modalClose")?.addEventListener("click", () => $("#productModal").close());

  (async () => {
    try {
      const [{ categories }, top] = await Promise.all([
        apiRequest('GET', '/api/categories'),
        apiRequest('GET', '/api/products?sort=price_desc&limit=1')
      ]);
      categories.forEach(c => {
        const i = el('input', { type: 'checkbox', value: c.slug });
        if (wanted && (c.slug === wanted || c.name.toLowerCase() === wanted)) i.checked = true;
        catBox.append(el('label', {}, i, document.createTextNode(' ' + c.name)));
      });
      priceCap = top.products.length ? Math.ceil(Number(top.products[0].price) / 1000) * 1000 : 0;
      range.min = 0; range.step = 500;
      if (priceCap) { range.max = priceCap; range.value = priceCap; readout.textContent = `Up to ${money(priceCap)}`; }
      else { range.disabled = true; readout.textContent = 'No products yet'; }
    } catch { readout.textContent = ''; }
    fetchPage(true);
  })();
}

/* ---------- authenticated API calls (backend checks the token and the seller role) ---------- */
async function apiRequest(method, path, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  let res;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(Auth.token() ? { Authorization: `Bearer ${Auth.token()}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal
    });
  } catch { throw new Error('Unable to reach TM Market. Check your connection and try again.'); }
  finally { clearTimeout(timer); }
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (res.status === 401) { Auth.clear(); guardRoute(); throw new Error('Your session has expired. Please log in again.'); }
  if (!res.ok) {
    const e = new Error(data && data.message ? data.message : 'Something went wrong. Please try again.');
    e.status = res.status;
    throw e;
  }
  return data;
}

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Images go straight from the browser to Cloudinary using a signature made by our backend.
// Phone photos are often 4-12 MB, which fails on mobile data. Shrink them in the browser first.
async function shrinkImage(file, maxSide = 1600, quality = 0.85) {
  if (file.size <= 800 * 1024) return file;
  try {
    const bmp = await createImageBitmap(file); // keeps the phone's rotation in modern browsers
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); // PNG transparency becomes white, not black
    ctx.drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', quality));
    return blob && blob.size < file.size ? blob : file;
  } catch { return file; }
}

async function uploadImage(file, signPath = '/api/sellers/me/uploads/sign') {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Images must be JPG, PNG or WebP.');
  if (file.size > 25 * 1024 * 1024) throw new Error('Each image must be under 25 MB.');
  file = await shrinkImage(file);
  if (file.size > 5 * 1024 * 1024) throw new Error('This image is still too large. Please choose a smaller one.');
  const sig = await apiRequest('POST', signPath);
  let res;
  for (let attempt = 0; attempt < 2 && !res; attempt++) { // one automatic retry for weak mobile networks
    const fd = new FormData();
    fd.append('file', file, 'photo.jpg'); fd.append('api_key', sig.apiKey); fd.append('timestamp', sig.timestamp);
    fd.append('folder', sig.folder); fd.append('signature', sig.signature);
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 60000);
    try { res = await fetch(`https://api.cloudinary.com/v1_1/${sig.cloudName}/image/upload`, { method: 'POST', body: fd, signal: ctrl.signal }); }
    catch { res = null; }
    finally { clearTimeout(timer); }
  }
  if (!res) throw new Error('Image upload failed. Check your connection and try again.');
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.secure_url) {
    const why = data && data.error && typeof data.error.message === 'string' ? data.error.message.slice(0, 160) : '';
    throw new Error(why ? `Image upload failed (${res.status}): ${why}` : `Image upload failed (${res.status || 'no response'}). Please try another image.`);
  }
  return data.secure_url;
}


/* ---------- product details (used by the homepage and the shop page) ---------- */
async function showProductDetails(id, { onAdd } = {}) {
  const modal = $('#productModal'), box = $('#modalContent');
  if (!modal || !box) return;
  box.innerHTML = '<p class="grid-status">Loading…</p>';
  if (!modal.open) modal.showModal();
  let p;
  try { p = mapProduct((await apiRequest('GET', `/api/products/${encodeURIComponent(id)}`)).product); }
  catch (err) { box.innerHTML = `<p class="grid-status is-error">${esc(err.status === 404 ? 'This product is no longer available.' : err.message)}</p>`; return; }

  const imgs = p.images.length ? p.images : [p.image];
  box.innerHTML = `<div class="modal-content">
    <div class="detail-gallery"><img class="quick-image" id="detailMain" src="${esc(imgs[0])}" alt="${esc(p.name)}">
      ${imgs.length > 1 ? `<div class="detail-thumbs">${imgs.map((u, i) => `<img src="${esc(u)}" alt="" data-thumb="${i}" class="${i === 0 ? 'active' : ''}">`).join('')}</div>` : ''}</div>
    <div class="modal-info"><span class="eyebrow">${esc(p.category)}</span><h2>${esc(p.name)}</h2>
      <div class="price detail-price">${money(p.price)} ${p.oldPrice ? `<span class="old-price">${money(p.oldPrice)}</span>` : ''}</div>
      <p class="detail-meta">${p.condition ? `<span class="cond cond-${esc(p.condition)}">${esc(CONDITION_LABELS[p.condition])}</span> · ` : ''}${esc(p.stock)}${p.location ? ' · 📍 ' + esc(p.location) : ''}</p>
      ${p.seller ? `<p class="detail-meta">Sold by <strong>${esc(p.seller)}</strong></p>` : ''}
      <p class="detail-desc">${esc(p.description || 'No description provided.')}</p>
      <div class="detail-actions">
        <button class="btn btn-primary" type="button" data-detail-add ${p.available ? '' : 'disabled'}>${p.available ? 'Add to bag' : 'Unavailable'}</button>
        <button class="btn btn-ghost" type="button" data-detail-contact>Chat with seller on WhatsApp</button>
      </div></div></div>`;

  box.querySelector('.detail-thumbs')?.addEventListener('click', e => {
    const t = e.target.closest('[data-thumb]'); if (!t) return;
    $('#detailMain').src = imgs[Number(t.dataset.thumb)];
    box.querySelectorAll('[data-thumb]').forEach(x => x.classList.toggle('active', x === t));
  });
  box.querySelector('[data-detail-add]').addEventListener('click', () => { if (p.available && onAdd) { onAdd(p); modal.close(); } });
  box.querySelector('[data-detail-contact]').addEventListener('click', () => requireAuth(async () => {
    try {
      const { contact } = await apiRequest('GET', `/api/products/${encodeURIComponent(p.id)}/contact`);
      const digits = String(contact.whatsapp || '').replace(/\D/g, '');
      if (!digits) return toast("This seller hasn't added a WhatsApp number yet.", 4000);
      const msg = `Hello, I'm interested in "${p.name}" (${money(p.price)}) on TM Market.`;
      window.open(`https://wa.me/${digits}?text=${encodeURIComponent(msg)}`, '_blank', 'noopener');
    } catch (err) { toast(err.message, 4000); }
  }));
}

/* ---------- sell page: open a store, then add / edit / delete real listings ---------- */
function initVendorForm() {
  const root = $('#sellRoot');
  if (!root) return;
  const statusEl = $('#sellStatus');
  const say = (t, err) => { if (statusEl) { statusEl.textContent = t; statusEl.classList.toggle('is-error', !!err); statusEl.hidden = !t; } };

  Loader.run(async () => {
    try {
      const { seller } = await apiRequest('GET', '/api/sellers/me');
      say('');
      renderSellerDashboard(root, seller);
    } catch (err) {
      if (err.status === 403 || err.status === 404) { say(''); renderOpenStore(root); }
      else say(err.message, true);
    }
  }, { text: 'Loading your seller account…' });
}

function renderOpenStore(root) {
  root.querySelector('.sell-panel')?.remove();
  const box = el('section', { class: 'vendor-form-section sell-panel' });
  const u = Auth.user();
  box.innerHTML = `<form class="vendor-form" id="storeForm" novalidate>
      <h2>Open your store</h2>
      <p class="form-error" id="storeError" role="alert" hidden></p>
      <label for="st-name">Store name</label><input id="st-name" type="text" maxlength="150" placeholder="e.g. Jay Fashion Store" required>
      <label for="st-loc">City / location</label><input id="st-loc" type="text" maxlength="150" placeholder="e.g. Minna, Niger State" required>
      <label for="st-wa">WhatsApp number (optional)</label><input id="st-wa" type="tel" placeholder="08012345678" value="${esc(u.phone || '')}">
      <label for="st-desc">About your store (optional)</label><textarea id="st-desc" maxlength="2000" rows="3"></textarea>
      <button type="submit" class="btn-primary">Open store</button>
    </form>`;
  root.appendChild(box);
  $('#storeForm').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#storeError'); err.hidden = true;
    try {
      const data = await Loader.run(() => apiRequest('POST', '/api/sellers', {
        storeName: $('#st-name').value, location: $('#st-loc').value, whatsapp: $('#st-wa').value, description: $('#st-desc').value
      }), { text: 'Opening your store…' });
      Auth.save(data);                     // new token carries the SELLER role
      toast('Your store is open!');
      box.remove();
      renderSellerDashboard(root, data.seller);
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
}

/* ---------- seller earnings: balances, bank account and withdrawals ---------- */
function initSellerEarnings(box) {
  const host = $('#sellEarnings');
  const state = { loaded: false, data: null };
  const naira = n => '\u20A6' + Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: Number.isInteger(Number(n || 0)) ? 0 : 2, maximumFractionDigits: 2 });
  const STATUS = { pending: ['Waiting for review', 'pending'], approved: ['Approved', 'pending'], processing: ['Processing', 'pending'], paid: ['Paid', 'active'], rejected: ['Not approved', 'sold'], failed: ['Failed', 'sold'] };
  const OPEN = ['pending', 'approved', 'processing'];
  const BANKS = ['Access Bank', 'Citibank Nigeria', 'Ecobank Nigeria', 'Fidelity Bank', 'First Bank of Nigeria', 'First City Monument Bank (FCMB)', 'Globus Bank', 'Guaranty Trust Bank (GTBank)', 'Keystone Bank', 'Kuda Bank', 'Moniepoint MFB', 'OPay', 'PalmPay', 'Polaris Bank', 'Providus Bank', 'Stanbic IBTC Bank', 'Standard Chartered Bank', 'Sterling Bank', 'SunTrust Bank', 'TAJBank', 'Titan Trust Bank', 'Union Bank of Nigeria', 'United Bank for Africa (UBA)', 'Unity Bank', 'Wema Bank', 'Zenith Bank'];
  const day = iso => { const d = iso ? new Date(iso) : null; return d && !isNaN(d) ? d.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; };

  async function load() {
    try {
      state.data = await Loader.run(() => apiRequest('GET', '/api/sellers/me/payouts'), { text: 'Loading your earnings\u2026' });
      state.loaded = true;
      draw();
    } catch (err) {
      host.innerHTML = `<p class="grid-status is-error">${esc(err.message)}</p>`;
    }
  }

  function draw() {
    const { balances: b, bank, withdrawals, rules } = state.data;
    const open = withdrawals.find(w => OPEN.includes(w.status));
    const canAsk = !!bank && !open && b.withdrawable >= rules.minWithdrawal;
    let ask;
    if (!bank) ask = '<p class="ep-hint">Add your bank details below before you can withdraw.</p>';
    else if (open) ask = `<p class="ep-hint">Your request for <strong>${esc(naira(open.amount))}</strong> is ${esc(STATUS[open.status][0].toLowerCase())}. You can send a new one after it is settled.</p>`;
    else if (b.withdrawable < rules.minWithdrawal) ask = `<p class="ep-hint">You need at least <strong>${esc(naira(rules.minWithdrawal))}</strong> available to withdraw.</p>`;
    else ask = '';

    const none = b.totalEarned === 0 && !withdrawals.length;
    host.innerHTML = `
      <div class="ep-grid">
        <div class="ep-card main"><small>Available to withdraw</small><strong>${esc(naira(b.availableBalance))}</strong></div>
        <div class="ep-card"><small>Pending</small><strong>${esc(naira(b.pendingBalance))}</strong></div>
        <div class="ep-card"><small>In review</small><strong>${esc(naira(b.inReview))}</strong></div>
        <div class="ep-card"><small>Withdrawn so far</small><strong>${esc(naira(b.withdrawn))}</strong></div>
        <div class="ep-card"><small>Total earned</small><strong>${esc(naira(b.totalEarned))}</strong></div>
      </div>
      ${none ? '<p class="ep-hint">No earnings yet. Your balance grows when customers pay for your items.</p>' : ''}
      <div class="ep-note">
        <strong>How payouts work</strong>
        <ul>
          <li>TM Market keeps ${esc(rules.feePercent)}% of each item's price. You receive the rest.</li>
          <li>Money is <b>Pending</b> until the buyer has received the item. It becomes <b>Available</b> ${esc(rules.holdDays)} day${rules.holdDays === 1 ? '' : 's'} after delivery is confirmed.</li>
          <li>Withdrawals are checked and paid by TM Market to your bank account. Minimum: ${esc(naira(rules.minWithdrawal))}.</li>
        </ul>
      </div>
      <div class="ep-note ep-warn">
        <strong>Shipping and delivery: please read</strong>
        <ul>
          <li>TM Market does not add a shipping fee. Agree the delivery cost and method directly with the buyer (their phone number is on the order) before you dispatch.</li>
          <li>Pack the item carefully and keep proof of dispatch and delivery.</li>
          <li>Never ask a buyer to pay you outside TM Market. Payments made outside TM Market are not recorded, cannot be paid out, and we cannot help with them.</li>
        </ul>
      </div>

      <h3 class="ep-title">Withdraw money</h3>
      ${ask}
      ${canAsk ? `<form class="vendor-form ep-form" id="epWdForm" novalidate>
        <p class="form-error" id="epWdError" role="alert" hidden></p>
        <label for="ep-amt">Amount (\u20A6)</label>
        <input id="ep-amt" type="number" inputmode="decimal" min="${esc(rules.minWithdrawal)}" max="${esc(b.withdrawable)}" step="any" placeholder="e.g. 20000" required>
        <button type="button" class="btn-ghost-sm" id="epAll">Withdraw all available (${esc(naira(b.withdrawable))})</button>
        <p class="ep-small">It will be sent to ${esc(bank.bankName)}, ${esc(bank.accountNumber)} (${esc(bank.accountName)}).</p>
        <button type="submit" class="btn-primary">Request withdrawal</button>
      </form>` : ''}

      <h3 class="ep-title">Bank account</h3>
      ${bank ? `<p class="ep-small">Current account: <strong>${esc(bank.bankName)}</strong>, ${esc(bank.accountNumber)} (${esc(bank.accountName)})</p>` : ''}
      <details class="ep-details" ${bank ? '' : 'open'}>
        <summary>${bank ? 'Change bank details' : 'Add bank details'}</summary>
        <form class="vendor-form ep-form" id="epBankForm" novalidate>
          <p class="form-error" id="epBankError" role="alert" hidden></p>
          <label for="ep-bank">Bank name</label>
          <input id="ep-bank" list="epBanks" type="text" maxlength="80" placeholder="Start typing your bank" autocomplete="off" required>
          <datalist id="epBanks">${BANKS.map(n => `<option value="${esc(n)}"></option>`).join('')}</datalist>
          <label for="ep-num">Account number (10 digits)</label>
          <input id="ep-num" type="text" inputmode="numeric" maxlength="10" pattern="[0-9]*" autocomplete="off" required>
          <label for="ep-name">Account name (exactly as your bank shows it)</label>
          <input id="ep-name" type="text" maxlength="120" autocomplete="off" required>
          <label for="ep-pw">Your TM Market password</label>
          <input id="ep-pw" type="password" autocomplete="current-password" required>
          <p class="ep-small">We ask for your password to protect your money. Bank details cannot be changed while a withdrawal is waiting to be paid.</p>
          <button type="submit" class="btn-primary">Save bank details</button>
        </form>
      </details>

      <h3 class="ep-title">Withdrawal history</h3>
      ${withdrawals.length ? withdrawals.map(w => {
        const st = STATUS[w.status] || [w.status, 'sold'];
        const extra = w.status === 'paid' && w.reference ? `Reference: ${w.reference}` : (w.status === 'rejected' && w.note ? `Reason: ${w.note}` : '');
        return `<div class="ep-row"><div><strong>${esc(naira(w.amount))}</strong><span>${esc(day(w.requestedAt))} \u00B7 ${esc(w.bank.name)} ${esc(w.bank.accountNumber)}</span>${extra ? `<span>${esc(extra)}</span>` : ''}</div><span class="sell-badge ${esc(st[1])}">${esc(st[0])}</span></div>`;
      }).join('') : '<p class="ep-hint">No withdrawals yet.</p>'}
    `;

    const show = (id, t) => { const e = $(id); if (e) { e.textContent = t; e.hidden = !t; } };

    const wd = $('#epWdForm');
    if (wd) {
      $('#epAll').addEventListener('click', () => { $('#ep-amt').value = b.withdrawable; });
      wd.addEventListener('submit', async e => {
        e.preventDefault();
        show('#epWdError', '');
        const amount = Number($('#ep-amt').value);
        if (!(amount > 0)) return show('#epWdError', 'Enter the amount you want to withdraw.');
        if (amount < rules.minWithdrawal) return show('#epWdError', `The minimum withdrawal is ${naira(rules.minWithdrawal)}.`);
        if (amount > b.withdrawable) return show('#epWdError', `You can withdraw up to ${naira(b.withdrawable)} right now.`);
        if (!window.confirm(`Request ${naira(amount)} to ${bank.bankName}, ${bank.accountNumber}?`)) return;
        try {
          await Loader.run(() => apiRequest('POST', '/api/sellers/me/withdrawals', { amount }), { text: 'Sending your request\u2026' });
          toast('Request sent. We will review it and pay you.', 4000);
          await load();
        } catch (ex) { show('#epWdError', ex.message); }
      });
    }

    $('#epBankForm').addEventListener('submit', async e => {
      e.preventDefault();
      show('#epBankError', '');
      const body = { bankName: $('#ep-bank').value, accountNumber: $('#ep-num').value, accountName: $('#ep-name').value, password: $('#ep-pw').value };
      if (!/^\d{10}$/.test(body.accountNumber.trim())) return show('#epBankError', 'Account number must be exactly 10 digits.');
      try {
        await Loader.run(() => apiRequest('PUT', '/api/sellers/me/bank', body), { text: 'Saving\u2026' });
        toast('Bank details saved', 3000);
        await load();
      } catch (ex) { show('#epBankError', ex.message); }
    });
  }

  return { show(on) { host.hidden = !on; if (on && !state.loaded) load(); } };
}

/* ---------- seller orders: set delivery dates and move paid orders forward ---------- */
function initSellerOrders(box) {
  const host = $('#sellOrders');
  const badge = $('#ordersBadge');
  const tabs = [...box.querySelectorAll('[data-sell-tab]')];
  const earnings = initSellerEarnings(box);
  const state = { items: [], total: 0, page: 1, busy: false, loaded: false, touched: false };

  const LABEL = { confirmed: 'Paid, ready to prepare', processing: 'Preparing', shipped: 'Shipped', delivered: 'Delivered' };
  const RANK = { confirmed: 0, processing: 0, shipped: 1, delivered: 2 };

  const toDate = s => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '')); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
  const pretty = d => d.toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric', month: 'short' });
  const stamp = iso => { const d = iso ? new Date(iso) : null; return d && !isNaN(d) ? d.toLocaleDateString('en-NG', { day: 'numeric', month: 'short' }) : ''; };
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const toShip = () => state.items.filter(o => o.status === 'confirmed' || o.status === 'processing').length;

  function showTab(name) {
    tabs.forEach(t => t.classList.toggle('on', t.dataset.sellTab === name));
    $('#sellProducts').hidden = name !== 'products';
    host.hidden = name !== 'orders';
    earnings.show(name === 'earnings');
    if (name === 'orders' && !state.loaded) load(true);
  }
  tabs.forEach(t => t.addEventListener('click', () => { state.touched = true; showTab(t.dataset.sellTab); }));

  function windowLine(o) {
    const from = o.deliveryWindow && toDate(o.deliveryWindow.from);
    const to = o.deliveryWindow && toDate(o.deliveryWindow.to);
    if (!from || !to) return { text: 'No delivery dates set yet', late: false };
    const now = new Date(), today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return {
      text: from.getTime() === to.getTime() ? `Delivery: ${pretty(from)}` : `Delivery: ${pretty(from)} to ${pretty(to)}`,
      late: o.status !== 'delivered' && today.getTime() > to.getTime()
    };
  }

  function card(o) {
    const c = el('article', { class: 'order-card so-card' });
    c.append(el('div', { class: 'order-head' },
      el('div', {}, el('strong', { text: o.orderNumber }), el('small', { text: `Placed ${stamp(o.createdAt)}` })),
      el('span', { class: `order-pill is-${o.status}`, text: LABEL[o.status] || o.status })
    ));

    const list = el('ul', { class: 'order-items' });
    (o.items || []).forEach(i => list.append(el('li', {}, el('span', { text: `${i.quantity} × ${i.name}` }), el('span', { text: money(i.totalPrice) }))));
    c.append(list, el('div', { class: 'order-total' }, el('span', { text: 'Total' }), el('strong', { text: money(o.total) })));

    const s = o.shipping || {};
    const digits = String(s.phone || '').replace(/\D/g, '');
    const where = [s.address, s.city, s.state].filter(Boolean).join(', ');
    const deliver = el('div', { class: 'so-deliver' },
      el('strong', { text: 'Deliver to' }),
      el('span', { text: s.name || '' }),
      el('span', { text: where })
    );
    if (digits) {
      const tel = el('a', { href: `tel:+${digits}`, text: s.phone });
      const wa = el('a', { href: `https://wa.me/${digits}`, target: '_blank', rel: 'noopener', text: 'WhatsApp the buyer' });
      deliver.append(el('span', { class: 'so-contact' }, tel, document.createTextNode(' · '), wa));
    }
    c.append(deliver);

    const w = windowLine(o);
    const win = el('div', { class: 'order-window' + (w.late ? ' is-late' : '') }, el('strong', { text: w.text }));
    if (w.late) win.append(el('small', { text: 'The delivery dates have passed. Update the dates or contact the buyer.' }));
    c.append(win);

    const msg = el('p', { class: 'so-msg', role: 'alert', hidden: true });
    const say = t => { msg.textContent = t; msg.hidden = !t; };

    if (o.status === 'delivered') {
      c.append(el('p', { class: 'so-done', text: 'Delivered. Nothing more to do.' }));
      return c;
    }

    // delivery dates
    const now = new Date();
    const fromIn = el('input', { type: 'date', 'aria-label': 'Delivery from', min: ymd(now), value: o.deliveryWindow ? o.deliveryWindow.from : '' });
    const toIn = el('input', { type: 'date', 'aria-label': 'Delivery to', min: ymd(now), value: o.deliveryWindow ? o.deliveryWindow.to : '' });
    const saveDates = el('button', { type: 'button', class: 'btn btn-ghost', text: 'Save dates' });
    c.append(el('div', { class: 'so-dates' }, el('label', {}, el('small', { text: 'From' }), fromIn), el('label', {}, el('small', { text: 'To' }), toIn), saveDates));

    saveDates.addEventListener('click', async () => {
      say(''); saveDates.disabled = true;
      try {
        await apiRequest('PUT', `/api/sellers/me/orders/${o.id}/delivery-window`, { from: fromIn.value, to: toIn.value });
        toast('Delivery dates saved.'); await load(true);
      } catch (ex) { say(ex.message || 'Unable to save the dates.'); saveDates.disabled = false; }
    });

    // moving the order forward
    if (o.status === 'shipped') {
      c.append(el('p', { class: 'so-done', text: 'Shipped. Waiting for the buyer to confirm they received it.' }), msg);
      return c;
    }
    const note = el('input', { type: 'text', maxlength: '200', placeholder: 'Optional note for the buyer', 'aria-label': 'Note for the buyer' });
    const acts = el('div', { class: 'order-actions' });
    const steps = o.status === 'confirmed' ? [['Mark preparing', 'processing', 'btn-ghost'], ['Mark shipped', 'shipped', 'btn-primary']] : [['Mark shipped', 'shipped', 'btn-primary']];
    steps.forEach(([text, status, cls]) => {
      const b = el('button', { type: 'button', class: `btn ${cls}`, text });
      b.addEventListener('click', async () => {
        if (status === 'shipped' && !confirm('Mark this order as shipped? The buyer will see it is on the way.')) return;
        say(''); b.disabled = true;
        try {
          await apiRequest('POST', `/api/sellers/me/orders/${o.id}/status`, { status, note: note.value });
          toast(status === 'shipped' ? 'Marked as shipped.' : 'Marked as preparing.'); await load(true);
        } catch (ex) { say(ex.message || 'Unable to update this order.'); b.disabled = false; }
      });
      acts.append(b);
    });
    c.append(note, acts, msg);
    return c;
  }

  function paint(message) {
    host.replaceChildren();
    host.append(el('h2', { class: 'sell-list-title', text: 'Your orders' }));
    if (message) { host.append(el('p', { class: 'orders-note', text: message })); }
    else if (!state.items.length) {
      host.append(el('p', { class: 'orders-note', text: 'No paid orders yet. When a buyer pays for one of your products, it will appear here.' }));
    } else {
      [...state.items]
        .sort((a, b) => (RANK[a.status] - RANK[b.status]) || (new Date(b.createdAt) - new Date(a.createdAt)))
        .forEach(o => host.append(card(o)));
      if (state.items.length < state.total) {
        const more = el('button', { type: 'button', class: 'btn btn-ghost orders-more', text: 'Load more' });
        more.addEventListener('click', () => { state.page += 1; load(false); });
        host.append(more);
      }
    }
    const n = toShip();
    badge.textContent = n ? String(n) : '';
    badge.hidden = !n;
  }

  async function load(reset) {
    if (state.busy) return;
    state.busy = true;
    if (reset) { state.page = 1; if (!state.loaded) paint('Loading your orders…'); }
    try {
      const out = await apiRequest('GET', `/api/sellers/me/orders?page=${state.page}&limit=20`);
      const rows = Array.isArray(out.orders) ? out.orders : [];
      state.items = reset ? rows : state.items.concat(rows);
      state.total = Number(out.total) || 0;
      state.loaded = true;
      paint();
    } catch (ex) { paint(ex.message || 'We could not load your orders. Please try again.'); }
    finally { state.busy = false; }
  }

  // Load quietly so the tab badge is right; open the Orders tab by itself if something needs shipping.
  load(true).then(() => { if (!state.touched && toShip() > 0) showTab('orders'); });
}

async function renderSellerDashboard(root, seller) {
  root.classList.add('wide');
  root.querySelector('.sell-panel')?.remove();
  const box = el('section', { class: 'sell-panel' });
  box.innerHTML = `
    <div class="sell-head"><h2>${esc(seller.store_name)}</h2><p>${esc(seller.location)}</p></div>
    <div class="sell-tabs" role="tablist">
      <button type="button" class="sell-tab" data-sell-tab="orders" role="tab">Orders <span class="sell-tab-n" id="ordersBadge" hidden></span></button>
      <button type="button" class="sell-tab" data-sell-tab="earnings" role="tab">Earnings</button>
      <button type="button" class="sell-tab on" data-sell-tab="products" role="tab">Products</button>
    </div>
    <section id="sellOrders" hidden></section>
    <section id="sellEarnings" hidden></section>
    <div id="sellProducts">
    <form class="vendor-form" id="listingForm" novalidate>
      <h2 id="lfTitle">Add a product</h2>
      <p class="form-error" id="lfError" role="alert" hidden></p>
      <label for="lf-name">Product name</label><input id="lf-name" type="text" maxlength="255" required>
      <label for="lf-price">Price (₦)</label><input id="lf-price" type="number" min="1" step="any" inputmode="decimal" required>
      <label for="lf-cat">Category</label><select id="lf-cat" required><option value="">Select category</option></select>
      <label for="lf-cond">Condition</label><select id="lf-cond" required><option value="">Select condition</option><option value="new">New</option><option value="used">Used</option><option value="repaired">Repaired (fixed and tested)</option></select>
      <label for="lf-loc">Location</label><input id="lf-loc" type="text" maxlength="150" value="${esc(seller.location)}" required>
      <label for="lf-qty">Quantity available</label><input id="lf-qty" type="number" min="0" step="1" value="1" required>
      <label for="lf-desc">Description</label><textarea id="lf-desc" maxlength="5000" rows="4"></textarea>
      <label for="lf-img">Photos (up to 5, JPG/PNG/WebP)</label>
      <input id="lf-img" type="file" accept="image/jpeg,image/png,image/webp" multiple>
      <div class="sell-previews" id="lfPreviews"></div>
      <button type="submit" class="btn-primary" id="lfSubmit">Publish product</button>
      <button type="button" class="btn-ghost-sm" id="lfCancel" hidden>Cancel editing</button>
    </form>
    <h2 class="sell-list-title">Your listings</h2>
    <div id="myListings" class="sell-listings"></div>
    </div>`;
  root.appendChild(box);
  initSellerOrders(box);

  let editing = null, products = [];
  const err = $('#lfError');
  const showErr = t => { err.textContent = t; err.hidden = !t; };

  try {
    const { categories } = await apiRequest('GET', '/api/categories');
    $('#lf-cat').innerHTML = '<option value="">Select category</option>' + categories.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  } catch { showErr('Could not load categories. Refresh the page.'); }

  const resetForm = () => {
    editing = null; $('#listingForm').reset(); $('#lf-loc').value = seller.location; $('#lf-qty').value = 1;
    $('#lfTitle').textContent = 'Add a product'; $('#lfSubmit').textContent = 'Publish product'; $('#lfCancel').hidden = true;
    $('#lfPreviews').innerHTML = ''; showErr('');
  };
  $('#lfCancel').addEventListener('click', resetForm);

  $('#lf-img').addEventListener('change', e => {
    const files = [...e.target.files].slice(0, 5);
    $('#lfPreviews').innerHTML = '';
    files.forEach(f => { const i = el('img', { alt: '' }); i.src = URL.createObjectURL(f); $('#lfPreviews').appendChild(i); });
  });

  async function loadListings() {
    const host = $('#myListings');
    try {
      ({ products } = await apiRequest('GET', '/api/sellers/me/products'));
    } catch (ex) { host.innerHTML = `<p class="sell-status is-error">${esc(ex.message)}</p>`; return; }
    if (!products.length) { host.innerHTML = '<p class="sell-status">You have no listings yet. Add your first product above.</p>'; return; }
    host.innerHTML = products.map(p => `
      <article class="sell-item" data-id="${p.id}">
        ${p.image_url ? `<img src="${esc(p.image_url)}" alt="">` : '<div class="sell-noimg"></div>'}
        <div class="sell-item-body">
          <strong>${esc(p.name)}</strong>
          <span>${money(p.price)} · ${p.item_condition && CONDITION_LABELS[p.item_condition] ? esc(CONDITION_LABELS[p.item_condition]) + ' · ' : ''}${p.quantity ?? 0} in stock · ${esc(p.location || '')}</span>
          <span class="sell-badge ${esc(p.status)}">${esc(p.status)}</span>
        </div>
        <div class="sell-actions">
          <button type="button" data-act="edit">Edit</button>
          ${p.status === 'sold' ? '<button type="button" data-act="relist">Relist</button>' : '<button type="button" data-act="sold">Mark sold</button>'}
          <button type="button" data-act="delete" class="danger">Delete</button>
        </div>
      </article>`).join('');
  }

  $('#myListings').addEventListener('click', async e => {
    const btn = e.target.closest('button[data-act]'); if (!btn) return;
    const id = btn.closest('.sell-item').dataset.id, p = products.find(x => String(x.id) === id); if (!p) return;
    try {
      if (btn.dataset.act === 'edit') {
        editing = p; $('#lf-name').value = p.name; $('#lf-price').value = p.price; $('#lf-cat').value = p.category_id || ''; $('#lf-cond').value = p.item_condition || '';
        $('#lf-loc').value = p.location || ''; $('#lf-qty').value = p.quantity ?? 0; $('#lf-desc').value = p.description || '';
        $('#lfTitle').textContent = 'Edit product'; $('#lfSubmit').textContent = 'Save changes'; $('#lfCancel').hidden = false;
        $('#lfPreviews').innerHTML = ''; $('#lf-img').value = ''; $('#listingForm').scrollIntoView({ behavior: 'smooth' });
        return;
      }
      if (btn.dataset.act === 'delete') {
        if (!confirm(`Delete "${p.name}"? Buyers will no longer see it.`)) return;
        await Loader.run(() => apiRequest('DELETE', `/api/sellers/me/products/${id}`), { text: 'Deleting…' });
        toast('Listing removed');
      } else {
        await Loader.run(() => apiRequest('PUT', `/api/sellers/me/products/${id}`, { status: btn.dataset.act === 'sold' ? 'sold' : 'active' }), { text: 'Updating…' });
        toast('Listing updated');
      }
      if (editing && String(editing.id) === id) resetForm();
      loadListings();
    } catch (ex) { toast(ex.message, 4000); }
  });

  $('#listingForm').addEventListener('submit', async e => {
    e.preventDefault(); showErr('');
    const files = [...$('#lf-img').files].slice(0, 5);
    if (!editing && !files.length) return showErr('Please add at least one photo.');
    if (!$('#lf-cond').value) return showErr('Please choose the item condition (new, used or repaired).');
    const body = {
      name: $('#lf-name').value, price: $('#lf-price').value, categoryId: $('#lf-cat').value, itemCondition: $('#lf-cond').value,
      location: $('#lf-loc').value, quantity: $('#lf-qty').value, description: $('#lf-desc').value
    };
    const btn = $('#lfSubmit'); btn.disabled = true;
    try {
      await Loader.run(async () => {
        if (files.length) { const urls = []; for (const f of files) urls.push(await uploadImage(f)); body.images = urls.map(imageUrl => ({ imageUrl })); }
        if (editing) await apiRequest('PUT', `/api/sellers/me/products/${editing.id}`, body);
        else await apiRequest('POST', '/api/sellers/me/products', body);
      }, { text: files.length ? 'Uploading photos…' : 'Saving…' });
      toast(editing ? 'Listing updated' : 'Product published!');
      resetForm(); loadListings();
    } catch (ex) { showErr(ex.message); }
    finally { btn.disabled = false; }
  });

  loadListings();
}

function updateBagCount() {
  const n = load("tm-market-cart", []).reduce((s, i) => s + i.qty, 0);
  $$('.bag-count').forEach(b => { b.textContent = n; });
}

/* ---------- shared header for Shop / Sell pages ---------- */
function renderSharedHeader() {
  const host = $('#siteHeader');
  if (!host) return;
  host.innerHTML = `<header class="site-header"><div class="container header-main header-simple">
    <a class="brand" href="homepage.html" aria-label="TM Market home"><img src="assets/logo.svg" alt="TM Market"></a>
    <nav class="simple-nav" aria-label="Primary"><a href="homepage.html">Home</a><a href="product.html">Shop</a><a href="vendor-register.html">Sell</a></nav>
    <div class="header-right"><a class="bag-link" href="homepage.html?cart=1">Bag (<span class="bag-count">0</span>)</a><div id="authContainer"></div></div></div></header>`;
  $$('.simple-nav a').forEach(a => a.classList.toggle('active', a.getAttribute('href').replace(/\.html$/, '') === currentPage));
}

/* ---------- mobile menu: the ☰ button turns into ✕ while the menu is open ---------- */
function setMobileMenu(open) {
  const nav = $('#mainNav'), b = $('#mobileMenuBtn');
  if (!nav || !b) return;
  nav.classList.toggle('open', open);
  b.setAttribute('aria-expanded', String(open));
  b.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  b.textContent = open ? '✕' : '☰';
}
window.addEventListener('resize', () => { if (window.innerWidth > 680) setMobileMenu(false); });

/* ---------- boot ---------- */
document.addEventListener("DOMContentLoaded", () => {
  if (!routeAllowed || !guardRoute()) return;      // logged-out visitors are already being sent to index.html

  const landing = document.body.dataset.page === 'landing';
  if (localStorage.getItem("tm-market-dark") === "true") document.body.classList.add("dark");

  renderSharedHeader();
  buildAuthModal();
  // Arrived from a password-reset email: take the token out of the address bar and ask for a new password.
  const resetMatch = /^#reset=([a-f0-9]{64})$/.exec(location.hash);
  if (resetMatch) {
    resetToken = resetMatch[1];
    history.replaceState(null, '', location.pathname + location.search);
    openAuth('reset');
  }
  Loader.ensure();
  updateAuthUI();
  updateBagCount();
  initChatWidget();

  // Header/account clicks (work on every page)
  document.addEventListener('click', e => {
    const open = e.target.closest('[data-auth-open]');
    if (open) return openAuth(open.dataset.authOpen);
    if (e.target.closest('#logoutBtn')) return handleLogout();
    if (e.target.closest('#openProfileBtn')) return requireAuth(openProfileModal);
    if (e.target.closest('#mobileMenuBtn')) {
      const nav = $('#mainNav');
      if (nav) setMobileMenu(!nav.classList.contains('open'));
    } else if (e.target.closest('#mainNav a')) setMobileMenu(false);
    if (e.target.closest('#backTop')) window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    setMobileMenu(false);
    if (!$('#authModal').hidden) closeAuth(true);
    if ($('#profileModal') && !$('#profileModal').hidden) $('#profileModal').hidden = true;
  });
  window.addEventListener('scroll', () => $('#backTop')?.classList.toggle('show', window.scrollY > 600), { passive: true });
  if (landing) {
    initLandingGate();
  } else {
    // Loader on logged-in pages: shows while the page loads, then fades out. Never artificial beyond a short minimum.
    Loader.run(new Promise(r => document.readyState === 'complete' ? r() : window.addEventListener('load', r, { once: true })), { text: 'Loading TM Market…', min: LOADER_MIN.page });
    // Show the loader while moving between pages
    document.addEventListener('click', e => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const a = e.target.closest('a[href]');
      if (!a || a.target === '_blank') return;
      const h = a.getAttribute('href') || '';
      if (!h || h.startsWith('#') || /^(mailto:|tel:|https?:|\/\/)/i.test(h)) return;
      Loader.show('Loading…');
    });
    const nm = $('#welcomeName');
    if (nm) nm.textContent = (Auth.user().name || '').split(' ')[0] || 'there';
  }

  // Attach the page-specific pieces that exist on this page
  purgeLegacyDemoState();
  initVendorForm();
  initShopPage();
  if ($("#productGrid")) initStorefront();

  // Back/forward cache: never resurrect a stuck loader or a stale login state
  window.addEventListener('pageshow', e => {
    if (!e.persisted) return;
    Loader.hide(true);
    if (!landing && !Auth.isLoggedIn()) return guardRoute();
    updateAuthUI();
  });
});

/* ==========================================================================
   TM Assistant (support chatbot)
   --------------------------------------------------------------------------
   Questions go to POST /api/chat on the backend, which answers from a written
   FAQ and, for a logged-in user, reads that user's own real order status.
   The support channels come from the backend (GET /api/chat/start).
   The chat history lives in memory only and disappears when the page reloads.
   ========================================================================== */
const CHAT_TIMEOUT = 15000;   // ms; the chat can never hang forever
// Used ONLY if the backend cannot be reached for the greeting. Same channels as the backend list.
const CHAT_FALLBACK_SUPPORT = {
  emails: ['tmmarketsupport@gmail.com', 'support@gmail.com'],
  whatsapp: { display: '+234 708 604 9886', link: 'https://wa.me/2347086049886' }
};

function initChatWidget() {
  if ($('#tmChat')) return;

  const root = el('div', { id: 'tmChat', class: 'tmc', 'data-public': '' });   // data-public: the landing-page login gate must ignore clicks here
  root.innerHTML = `
    <button type="button" class="tmc-launch" id="tmChatBtn" aria-label="Open TM Assistant chat" aria-expanded="false" aria-controls="tmChatPanel">
      <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.6-.8L3 21l1.9-5.1A8.4 8.4 0 1 1 21 11.5z"/></svg>
    </button>
    <section class="tmc-panel" id="tmChatPanel" role="dialog" aria-label="TM Assistant chat" hidden>
      <header class="tmc-head">
        <div><strong>TM Assistant</strong><small>Automated assistant, not a human</small></div>
        <button type="button" class="tmc-x" id="tmChatClose" aria-label="Close chat">&times;</button>
      </header>
      <div class="tmc-log" id="tmChatLog" role="log" aria-live="polite"></div>
      <div class="tmc-quick" id="tmChatQuick"></div>
      <form class="tmc-form" id="tmChatForm" autocomplete="off">
        <input type="text" id="tmChatInput" maxlength="500" placeholder="Type your question…" aria-label="Type your question">
        <button type="submit" class="tmc-send" id="tmChatSend" aria-label="Send">&#10148;</button>
      </form>
      <button type="button" class="tmc-support-btn" id="tmChatSupportBtn">Contact Support</button>
    </section>`;
  document.body.appendChild(root);

  const panel = $('#tmChatPanel'), btn = $('#tmChatBtn'), log = $('#tmChatLog');
  const quick = $('#tmChatQuick'), input = $('#tmChatInput'), form = $('#tmChatForm'), send = $('#tmChatSend');
  let started = false, busy = false, support = CHAT_FALLBACK_SUPPORT;

  const scrollDown = () => { log.scrollTop = log.scrollHeight; };

  function addMsg(who, text) {
    const m = el('div', { class: `tmc-msg tmc-${who}` });
    m.textContent = text;           // plain text only, so nothing from the server can inject HTML
    log.append(m);
    scrollDown();
    return m;
  }

  function addSupportCard(s) {
    const box = el('div', { class: 'tmc-msg tmc-bot tmc-card' }, el('strong', { text: 'Contact the TM Market team' }));
    (s.emails || []).forEach(addr => box.append(el('a', { class: 'tmc-link', href: `mailto:${addr}`, text: `Email ${addr}` })));
    if (s.whatsapp && /^https:\/\/wa\.me\/\d+$/.test(s.whatsapp.link || '')) {
      box.append(el('a', { class: 'tmc-link', href: s.whatsapp.link, target: '_blank', rel: 'noopener', text: `WhatsApp ${s.whatsapp.display}` }));
    }
    log.append(box);
    scrollDown();
  }

  function setQuick(list) {
    quick.replaceChildren();
    (list || []).slice(0, 4).forEach(q => {
      const b = el('button', { type: 'button', class: 'tmc-chip', text: q });
      b.addEventListener('click', () => ask(q));
      quick.append(b);
    });
  }

  async function begin() {
    if (started) return;
    started = true;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), CHAT_TIMEOUT);
      const res = await fetch(`${API_URL}/api/chat/start`, { signal: ctrl.signal });
      clearTimeout(timer);
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error('start failed');
      if (data.support) support = data.support;
      addMsg('bot', data.greeting);
      setQuick(data.suggestions);
    } catch {
      addMsg('bot', 'Hi! I am TM Assistant, an automated helper. I could not reach the server just now, but you can still type a question and I will try again.');
      setQuick(['How do I buy?', 'Track my order']);
    }
  }

  async function ask(text) {
    text = String(text || '').trim();
    if (!text || busy) return;
    busy = true; send.disabled = true;
    addMsg('me', text);
    input.value = '';
    setQuick([]);
    const typing = addMsg('bot', 'Typing…');
    typing.classList.add('tmc-typing');

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CHAT_TIMEOUT);
    try {
      const headers = { 'Content-Type': 'application/json' };
      const token = Auth.isLoggedIn() ? Auth.token() : null;
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(`${API_URL}/api/chat`, { method: 'POST', headers, body: JSON.stringify({ message: text }), signal: ctrl.signal });
      let data = {};
      try { data = await res.json(); } catch { /* not JSON */ }
      typing.remove();
      if (!res.ok || !data.success) {
        addMsg('bot', res.status < 500 && data.message ? data.message : 'Sorry, something went wrong. Please try again in a moment.');
      } else {
        addMsg('bot', data.reply);
        if (data.support) addSupportCard(data.support);
        setQuick(data.suggestions);
      }
    } catch (err) {
      typing.remove();
      addMsg('bot', err && err.name === 'AbortError'
        ? 'That is taking too long. Please try again in a moment.'
        : 'I could not reach TM Market. Please check your connection and try again.');
    } finally {
      clearTimeout(timer);
      busy = false; send.disabled = false;
      if (!panel.hidden) input.focus();
    }
  }

  function setOpen(open) {
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    btn.setAttribute('aria-label', open ? 'Close TM Assistant chat' : 'Open TM Assistant chat');
    root.classList.toggle('open', open);
    if (open) { begin(); setTimeout(() => input.focus(), 50); } else btn.focus();
  }

  btn.addEventListener('click', () => setOpen(panel.hidden));
  $('#tmChatClose').addEventListener('click', () => setOpen(false));
  $('#tmChatSupportBtn').addEventListener('click', () => addSupportCard(support));
  form.addEventListener('submit', e => { e.preventDefault(); ask(input.value); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden) setOpen(false); });
}
