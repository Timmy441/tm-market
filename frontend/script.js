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
    available, stock, badge: available ? '' : stock, quantity: qty
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
    const extras = load(profileExtraKey(user.email), {});   // phone/address/avatar the user saved earlier on this device
    localStorage.setItem(USER_KEY, JSON.stringify({ ...user, ...extras }));
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
}

function switchTab(tab) {
  const login = tab !== 'register';
  $('#tabLoginBtn').classList.toggle('active', login);
  $('#tabRegisterBtn').classList.toggle('active', !login);
  $('#login-form').hidden = !login;
  $('#register-form').hidden = login;
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
  setFormError('login', ''); setFormError('register', '');
  $('#authModal').hidden = false;
  document.body.style.overflow = 'hidden';
  setTimeout(() => $(tab === 'register' ? '#reg-name' : '#login-email')?.focus(), 60);
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

/* ---------- profile modal (logged-in pages) ---------- */
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
        <input type="file" id="avatarInput" accept="image/*" hidden>
      </div>
      <small>Tap the camera to change your picture</small>
    </div>
    <form id="profile-form">
      <div class="form-group"><label for="profile-name">Full Name</label><input type="text" id="profile-name" required></div>
      <div class="form-group"><label for="profile-email">Email Address</label><input type="email" id="profile-email" disabled></div>
      <div class="form-group"><label for="profile-phone">Phone Number</label><input type="tel" id="profile-phone" placeholder="+234 800 000 0000"></div>
      <div class="form-group"><label for="profile-address">Delivery Address</label><input type="text" id="profile-address" placeholder="123 Main St, Lagos"></div>
      <button type="submit" class="btn btn-primary btn-block">Save Changes</button>
      <p class="form-note">Profile changes are saved on this device only.</p>
    </form>
  </div>`;
  document.body.appendChild(d);

  d.addEventListener('mousedown', e => { d._down = e.target === d; });
  d.addEventListener('click', e => { if (e.target === d && d._down) d.hidden = true; });
  $('#closeProfileModal').addEventListener('click', () => { d.hidden = true; });

  $('#avatarInput').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast('Please choose an image file.'); return; }
    const reader = new FileReader();
    reader.onerror = () => toast('Unable to read that image. Please try another.');
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => toast('Unable to read that image. Please try another.');
      img.onload = () => {                     // shrink to 256px so it fits in browser storage
        const s = Math.min(1, 256 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        $('#profileAvatarPrev').src = c.toDataURL('image/jpeg', 0.85);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });

  $('#profile-form').addEventListener('submit', e => {
    e.preventDefault();
    const user = Auth.user();
    user.name = $('#profile-name').value.trim() || user.name;
    user.phone = $('#profile-phone').value.trim();
    user.address = $('#profile-address').value.trim();
    const avatar = $('#profileAvatarPrev').getAttribute('src');
    user.avatar = avatar && avatar.startsWith('data:') ? avatar : undefined;
    try {
      localStorage.setItem(USER_KEY, JSON.stringify(user));
      save(profileExtraKey(user.email), { name: user.name, phone: user.phone, address: user.address, avatar: user.avatar });
    } catch { toast('Unable to save your changes. Please try again.'); return; }
    updateAuthUI();
    d.hidden = true;
    toast('Profile updated successfully!');
  });
}

function openProfileModal() {
  buildProfileModal();
  const user = Auth.user();
  $('#profile-name').value = user.name || '';
  $('#profile-email').value = user.email || '';
  $('#profile-phone').value = user.phone || '';
  $('#profile-address').value = user.address || '';
  $('#profileAvatarPrev').src = user.avatar || 'assets/default-avatar.svg';
  $('#profileModal').hidden = false;
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
    if (e.target.closest('#authModal')) return;
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
  const state = {
    filter: "All", query: "", sort: "newest", onlyWishlist: false, page: 1, total: 0, timer: null,
    cart: load("tm-market-cart", []),
    wishlist: load("tm-market-wishlist", []),
    coupon: null
  };
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

      card.innerHTML = `<div class="product-media">
        ${p.badge ? `<span class="badge sale">${esc(p.badge)}</span>` : ""}
        <button class="heart ${wished ? "active" : ""}" data-wish="${esc(p.id)}" aria-label="${wished ? "Remove" : "Add"} ${esc(p.name)}">${wished ? "♥" : "♡"}</button>
        <a href="#" data-quick="${esc(p.id)}" aria-label="View ${esc(p.name)}"><img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy"></a>
        <button class="quick-view" data-quick="${esc(p.id)}" type="button">Quick view</button>
      </div>
      <div class="product-info">
        <div class="product-meta"><span class="product-category">${esc(p.category)}</span><span class="stock">${esc(p.stock)}</span></div>
        <h3><a href="#" data-quick="${esc(p.id)}">${esc(p.name)}</a></h3>
        ${meta ? `<p class="seller-line">${meta}</p>` : ""}
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
    const discount = state.coupon === "TM20" ? subtotal * 0.20 : 0;
    const total = subtotal - discount;

    if ($("#cartSubtotal")) $("#cartSubtotal").textContent = money(total);
    if ($("#checkoutTotal")) $("#checkoutTotal").textContent = money(total);

    const pct = Math.min(100, (subtotal / 50000) * 100);
    if ($("#shippingBar")) $("#shippingBar").style.width = `${pct}%`;
    if ($("#shippingAmount")) $("#shippingAmount").textContent = `${money(subtotal)} / ₦50k`;

    if (subtotal >= 50000) {
      if ($("#shippingMessage")) $("#shippingMessage").textContent = "🎉 You unlocked free delivery!";
      if ($("#deliveryCost")) $("#deliveryCost").textContent = "FREE";
    } else {
      if ($("#shippingMessage")) $("#shippingMessage").textContent = `Add ${money(50000 - subtotal)} for free delivery`;
      if ($("#deliveryCost")) $("#deliveryCost").textContent = "Calculated at checkout";
    }

    wrap.innerHTML = "";
    if (!state.cart.length) {
      wrap.innerHTML = '<div class="cart-empty"><div style="font-size:38px">🛍</div><strong>Your bag is waiting</strong><span>Add something you love and it will appear here.</span></div>';
      return;
    }
    state.cart.forEach(item => {
      const line = document.createElement("div");
      line.className = "cart-line";
      line.innerHTML = `<img src="${esc(item.image)}" alt="${esc(item.name)}"><div><h3>${esc(item.name)}</h3><p>${money(item.price)}</p><div class="qty"><button data-qty="${esc(item.id)}" data-delta="-1" aria-label="Decrease">−</button><strong>${item.qty}</strong><button data-qty="${esc(item.id)}" data-delta="1" aria-label="Increase">+</button><button class="remove" data-remove="${esc(item.id)}" type="button">Remove</button></div></div><span class="line-total">${money(item.price * item.qty)}</span>`;
      wrap.appendChild(line);
    });
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

  $("#modalContent")?.addEventListener("click", e => {
    const b = e.target.closest("[data-modal-add]");
    if (b) { requireAuth(() => addToCart(b.dataset.modalAdd)); $("#productModal").close(); }
  });

  $("#applyCoupon")?.addEventListener("click", () => {
    const code = ($("#couponInput")?.value || "").trim().toUpperCase();
    if (code === "TM20") { state.coupon = "TM20"; toast("Promo code applied: 20% off"); }
    else { state.coupon = null; toast(code ? "That promo code isn't valid." : "Enter a promo code first."); }
    renderCart();
  });
  $("#copyCode")?.addEventListener("click", () => {
    (navigator.clipboard?.writeText("TM20") || Promise.reject()).then(() => toast("Code TM20 copied"), () => toast("Use code TM20 at checkout"));
  });

  // Checkout: there is no order endpoint in the existing backend, so we don't pretend an order was placed.
  $("#checkoutBtn")?.addEventListener("click", () => requireAuth(() => {
    if (!state.cart.length) { toast("Your bag is empty. Add something first."); return; }
    const u = Auth.user(), f = $("#checkoutForm");
    if (f) { f.elements.name.value ||= u.name || ""; f.elements.email.value ||= u.email || ""; f.elements.phone.value ||= u.phone || ""; f.elements.address.value ||= u.address || ""; }
    closeCart();
    $("#checkoutModal")?.showModal();
  }));
  $("#checkoutClose")?.addEventListener("click", () => $("#checkoutModal").close());
  $("#checkoutForm")?.addEventListener("submit", e => {
    e.preventDefault();
    toast("Online ordering isn't available yet. Please contact support@tmmarket.com to complete your order.", 5000);
  });

  $("#themeBtn")?.addEventListener("click", () => {
    document.body.classList.toggle("dark");
    localStorage.setItem("tm-market-dark", document.body.classList.contains("dark"));
  });

  loadProducts(true);
  renderCart();
  if (params().get('cart') === '1' && Auth.isLoggedIn()) openCart();
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
  if (!res.ok) { const e = new Error(res.status < 500 && data.message ? data.message : 'Something went wrong. Please try again.'); e.status = res.status; throw e; }
  return data;
}

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Images go straight from the browser to Cloudinary using a signature made by our backend.
async function uploadImage(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Images must be JPG, PNG or WebP.');
  if (file.size > 5 * 1024 * 1024) throw new Error('Each image must be under 5 MB.');
  const sig = await apiRequest('POST', '/api/sellers/me/uploads/sign');
  const fd = new FormData();
  fd.append('file', file); fd.append('api_key', sig.apiKey); fd.append('timestamp', sig.timestamp);
  fd.append('folder', sig.folder); fd.append('signature', sig.signature);
  let res;
  try { res = await fetch(`https://api.cloudinary.com/v1_1/${sig.cloudName}/image/upload`, { method: 'POST', body: fd }); }
  catch { throw new Error('Image upload failed. Check your connection and try again.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.secure_url) throw new Error('Image upload failed. Please try another image.');
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
      <p class="detail-meta">${esc(p.stock)}${p.location ? ' · 📍 ' + esc(p.location) : ''}</p>
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

async function renderSellerDashboard(root, seller) {
  root.classList.add('wide');
  root.querySelector('.sell-panel')?.remove();
  const box = el('section', { class: 'sell-panel' });
  box.innerHTML = `
    <div class="sell-head"><h2>${esc(seller.store_name)}</h2><p>${esc(seller.location)}</p></div>
    <form class="vendor-form" id="listingForm" novalidate>
      <h2 id="lfTitle">Add a product</h2>
      <p class="form-error" id="lfError" role="alert" hidden></p>
      <label for="lf-name">Product name</label><input id="lf-name" type="text" maxlength="255" required>
      <label for="lf-price">Price (₦)</label><input id="lf-price" type="number" min="1" step="any" inputmode="decimal" required>
      <label for="lf-cat">Category</label><select id="lf-cat" required><option value="">Select category</option></select>
      <label for="lf-loc">Location</label><input id="lf-loc" type="text" maxlength="150" value="${esc(seller.location)}" required>
      <label for="lf-qty">Quantity available</label><input id="lf-qty" type="number" min="0" step="1" value="1" required>
      <label for="lf-desc">Description</label><textarea id="lf-desc" maxlength="5000" rows="4"></textarea>
      <label for="lf-img">Photos (up to 5, JPG/PNG/WebP, max 5 MB each)</label>
      <input id="lf-img" type="file" accept="image/jpeg,image/png,image/webp" multiple>
      <div class="sell-previews" id="lfPreviews"></div>
      <button type="submit" class="btn-primary" id="lfSubmit">Publish product</button>
      <button type="button" class="btn-ghost-sm" id="lfCancel" hidden>Cancel editing</button>
    </form>
    <h2 class="sell-list-title">Your listings</h2>
    <div id="myListings" class="sell-listings"></div>`;
  root.appendChild(box);

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
          <span>${money(p.price)} · ${p.quantity ?? 0} in stock · ${esc(p.location || '')}</span>
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
        editing = p; $('#lf-name').value = p.name; $('#lf-price').value = p.price; $('#lf-cat').value = p.category_id || '';
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
    const body = {
      name: $('#lf-name').value, price: $('#lf-price').value, categoryId: $('#lf-cat').value,
      location: $('#lf-loc').value, quantity: $('#lf-qty').value, description: $('#lf-desc').value
    };
    const btn = $('#lfSubmit'); btn.disabled = true;
    try {
      await Loader.run(async () => {
        if (files.length) body.images = (await Promise.all(files.map(uploadImage))).map(imageUrl => ({ imageUrl }));
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
  Loader.ensure();
  updateAuthUI();
  updateBagCount();

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
