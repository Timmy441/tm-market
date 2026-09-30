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

// --- Single Product Source of Truth ---
const products = [
  { id: "aurora-x1", name: "Aurora X1 Smartphone", category: "Electronics", price: 89000, oldPrice: 105000, rating: 4.9, reviews: 124, badge: "Best seller", stock: "In stock", newness: 8, image: "assets/product-1.svg", seller: "Lagos Gadgets Hub", isPartner: false },
  { id: "pulse-pro", name: "Pulse Pro Headphones", category: "Electronics", price: 45000, oldPrice: 56000, rating: 4.8, reviews: 87, badge: "20% off", stock: "Only 6 left", newness: 7, image: "assets/product-2.svg", seller: "Jumia Partner", isPartner: true, affiliateUrl: "https://www.jumia.com.ng" },
  { id: "streetflex", name: "StreetFlex Sneakers", category: "Fashion", price: 32000, oldPrice: 40000, rating: 4.7, reviews: 64, badge: "Trending", stock: "In stock", newness: 6, image: "assets/product-3.svg", seller: "Kicks Plug Abuja", isPartner: false },
  { id: "nova-bag", name: "Nova Everyday Bag", category: "Fashion", price: 18500, oldPrice: 23000, rating: 4.8, reviews: 53, badge: "Popular", stock: "In stock", newness: 5, image: "assets/product-4.svg", seller: "TM Collection", isPartner: false },
  { id: "chrono-watch", name: "Chrono Smart Watch", category: "Accessories", price: 56000, oldPrice: 65000, rating: 4.6, reviews: 41, badge: "New", stock: "In stock", newness: 10, image: "assets/product-5.svg", seller: "TM Collection", isPartner: false },
  { id: "sounddock", name: "SoundDock Mini", category: "Electronics", price: 27000, oldPrice: 32000, rating: 4.7, reviews: 38, badge: "20% off", stock: "In stock", newness: 9, image: "assets/product-6.svg", seller: "TM Collection", isPartner: false },
  { id: "cloudfit", name: "CloudFit Hoodie", category: "Fashion", price: 24000, oldPrice: 29000, rating: 4.9, reviews: 72, badge: "New", stock: "In stock", newness: 11, image: "assets/product-7.svg", seller: "TM Collection", isPartner: false },
  { id: "pixel-pro", name: "Pixel Pro Camera", category: "Home", price: 125000, oldPrice: 145000, rating: 4.8, reviews: 29, badge: "Pro pick", stock: "Only 3 left", newness: 4, image: "assets/product-8.svg", seller: "TM Collection", isPartner: false }
];

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
      <div class="form-group"><label for="reg-password">Password</label><input type="password" id="reg-password" placeholder="••••••••" autocomplete="new-password" required></div>
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
    handleRegister($('#reg-name').value.trim(), $('#reg-email').value.trim(), $('#reg-password').value);
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

async function handleRegister(name, email, password) {
  setFormError('register', '');
  setFormBusy('#register-form', true, 'Creating account…');
  Loader.show('Creating your account…');
  try {
    const data = await apiPost('/api/register', { name, email, password });
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
    filter: "All", query: "", sort: "featured", onlyWishlist: false,
    cart: load("tm-market-cart", []),
    wishlist: load("tm-market-wishlist", []),
    coupon: null
  };
  const preview = Number(document.body.dataset.preview || 0);   // landing page shows a small read-only preview
  const product = id => products.find(p => p.id === id || p.id === Number(id));

  function filteredProducts() {
    let list = products.filter(p => (state.filter === "All" || p.category === state.filter) && (!state.onlyWishlist || state.wishlist.includes(p.id)) && (!state.query || `${p.name} ${p.category}`.toLowerCase().includes(state.query)));
    const sort = { "price-low": (a, b) => a.price - b.price, "price-high": (a, b) => b.price - a.price, "rating": (a, b) => b.rating - a.rating, "newest": (a, b) => b.newness - a.newness };
    if (sort[state.sort]) list.sort(sort[state.sort]);
    return preview ? list.slice(0, preview) : list;
  }

  function renderProducts() {
    const grid = $("#productGrid"), list = filteredProducts();
    if (!grid) return;
    if ($("#resultsCount")) $("#resultsCount").textContent = `${list.length} product${list.length === 1 ? "" : "s"}`;
    if ($("#noResults")) $("#noResults").hidden = !!list.length;
    grid.innerHTML = "";

    list.forEach(p => {
      const card = document.createElement("article");
      card.className = "product-card";
      const wished = state.wishlist.includes(p.id);
      const actionButton = p.isPartner
        ? `<a href="${p.affiliateUrl}" target="_blank" rel="noopener" class="btn-affiliate">Buy Partner ↗</a>`
        : `<button class="add-btn" data-add="${p.id}" type="button" aria-label="Add ${p.name} to cart">+</button>`;

      card.innerHTML = `<div class="product-media">
        <span class="badge ${p.isPartner ? "partner" : (p.badge?.includes("off") ? "sale" : "")}">${p.isPartner ? "Partner Deal" : p.badge}</span>
        <button class="heart ${wished ? "active" : ""}" data-wish="${p.id}" aria-label="${wished ? "Remove" : "Add"} ${p.name}">${wished ? "♥" : "♡"}</button>
        <a href="product.html" aria-label="View ${p.name}"><img src="${p.image}" alt="${p.name}" loading="lazy"></a>
        <button class="quick-view" data-quick="${p.id}" type="button">Quick view</button>
      </div>
      <div class="product-info">
        <div class="product-meta"><span class="product-category">${p.category}</span><span class="stock">${p.stock}</span></div>
        <h3><a href="product.html">${p.name}</a></h3>
        <div class="rating">★★★★★ <span>${p.rating} (${p.reviews})</span></div>
        <div class="price-row"><div class="price">${money(p.price)} ${p.oldPrice ? `<span class="old-price">${money(p.oldPrice)}</span>` : ''}</div>${actionButton}</div>
      </div>`;
      grid.appendChild(card);
    });
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
      line.innerHTML = `<img src="${item.image}" alt="${item.name}"><div><h3>${item.name}</h3><p>${money(item.price)}</p><div class="qty"><button data-qty="${item.id}" data-delta="-1" aria-label="Decrease">−</button><strong>${item.qty}</strong><button data-qty="${item.id}" data-delta="1" aria-label="Increase">+</button><button class="remove" data-remove="${item.id}" type="button">Remove</button></div></div><span class="line-total">${money(item.price * item.qty)}</span>`;
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
    renderProducts();
    updateCounts();
  }

  function openCart() { const d = $("#cartDrawer"); if (!d) return; d.classList.add("open"); d.setAttribute("aria-hidden", "false"); $("#drawerOverlay").hidden = false; document.body.style.overflow = "hidden"; }
  function closeCart() { const d = $("#cartDrawer"); if (!d) return; d.classList.remove("open"); d.setAttribute("aria-hidden", "true"); $("#drawerOverlay").hidden = true; document.body.style.overflow = ""; }

  function openQuick(id) {
    const p = product(id), modal = $("#productModal");
    if (!modal || !p) return;
    $("#modalContent").innerHTML = `<div class="modal-content"><img class="quick-image" src="${p.image}" alt="${p.name}"><div class="modal-info"><span class="eyebrow">${p.category}</span><h2>${p.name}</h2><div class="rating">★★★★★ <span>${p.rating} · ${p.reviews} reviews</span></div><p>Thoughtfully selected for everyday use, with a clean design and the quality you expect from TM Market.</p><div class="modal-price">${money(p.price)} ${p.oldPrice ? `<span class="old-price">${money(p.oldPrice)}</span>` : ''}</div><p style="color:var(--green);font-size:11px;font-weight:800">✓ ${p.stock}</p><button class="btn btn-primary" data-modal-add="${p.id}" style="width:100%;margin-top:15px">Add to cart →</button></div></div>`;
    modal.showModal();
  }

  function applyFilters() {
    renderProducts();
    $$(".chip").forEach(c => c.classList.toggle("active", c.dataset.filter === state.filter));
  }
  function resetFilters() {
    state.filter = "All"; state.query = ""; state.sort = "featured"; state.onlyWishlist = false;
    if ($("#searchInput")) $("#searchInput").value = "";
    if ($("#sortSelect")) $("#sortSelect").value = "featured";
    if ($("#clearSearch")) $("#clearSearch").hidden = true;
    applyFilters();
  }
  function showWishlist() {
    state.onlyWishlist = !state.onlyWishlist;
    applyFilters();
    $("#shop")?.scrollIntoView({ behavior: "smooth" });
    toast(state.onlyWishlist ? (state.wishlist.length ? "Showing your wishlist" : "Your wishlist is empty. Tap ♡ on a product to save it.") : "Showing all products");
  }

  /* --- events --- */
  $("#productGrid")?.addEventListener("click", e => {
    const add = e.target.closest("[data-add]"), wish = e.target.closest("[data-wish]"), quick = e.target.closest("[data-quick]");
    if (add) requireAuth(() => addToCart(add.dataset.add));
    if (wish) requireAuth(() => toggleWish(wish.dataset.wish));
    if (quick) openQuick(quick.dataset.quick);
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
    renderProducts();
  });
  $("#clearSearch")?.addEventListener("click", resetFilters);
  $$(".chip").forEach(c => c.addEventListener("click", () => { state.filter = c.dataset.filter; applyFilters(); }));
  $$(".category-card[data-category]").forEach(c => c.addEventListener("click", () => { state.filter = c.dataset.category; applyFilters(); $("#shop")?.scrollIntoView({ behavior: "smooth" }); }));
  $("#sortSelect")?.addEventListener("change", e => { state.sort = e.target.value; renderProducts(); });
  $("#clearFilters")?.addEventListener("click", resetFilters);
  $("#resetShop")?.addEventListener("click", resetFilters);
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

  renderProducts();
  renderCart();
  if (params().get('cart') === '1' && Auth.isLoggedIn()) openCart();
}

/* ---------- shop page (product.html): rendered from the same products list ---------- */
function initShopPage() {
  const grid = $("#shopGrid");
  if (!grid) return;
  const cats = [...new Set(products.map(p => p.category))];
  const catBox = $("#catFilters");
  const wanted = (params().get('category') || '').toLowerCase();
  cats.forEach(c => {
    const l = el('label', {}, el('input', { type: 'checkbox', value: c }), document.createTextNode(' ' + c));
    if (wanted && c.toLowerCase() === wanted) l.querySelector('input').checked = true;
    catBox.append(l);
  });
  const range = $("#priceRange"), readout = $("#priceReadout");
  range.max = Math.max(...products.map(p => p.price)); range.value = range.max;

  const cart = () => load("tm-market-cart", []);

  function render() {
    const on = $$('#catFilters input:checked').map(i => i.value);
    readout.textContent = `Up to ${money(Number(range.value))}`;
    let list = products.filter(p => (!on.length || on.includes(p.category)) && p.price <= Number(range.value));
    const s = $("#shopSort").value;
    if (s === 'price-low') list.sort((a, b) => a.price - b.price);
    if (s === 'price-high') list.sort((a, b) => b.price - a.price);
    grid.replaceChildren();
    if (!list.length) { grid.append(el('div', { class: 'empty-state' }, el('strong', { text: 'No products match your filters' }), document.createTextNode('Try a different category or a higher price.'))); return; }
    list.forEach(p => {
      const card = el('div', { class: 'product-card' },
        el('span', { class: 'badge' + (p.isPartner ? ' partner' : ''), text: p.isPartner ? 'Partner Deal' : 'Verified Merchant' }),
        el('img', { src: p.image, alt: p.name, loading: 'lazy' }),
        el('h4', { text: p.name }),
        el('p', { class: 'seller-info' }, document.createTextNode('Sold by: '), el('strong', { text: p.seller })),
        el('p', { class: 'price', text: money(p.price) }));
      if (p.isPartner) card.append(el('a', { class: 'btn-affiliate', href: p.affiliateUrl, target: '_blank', rel: 'noopener', text: 'Buy on Partner Store ↗' }));
      else card.append(el('button', { class: 'btn-cart', type: 'button', 'data-id': p.id, text: 'Add to Bag' }));
      grid.append(card);
    });
  }
  grid.addEventListener('click', e => {
    const b = e.target.closest('.btn-cart'); if (!b) return;
    requireAuth(() => {
      const p = products.find(x => x.id === b.dataset.id); if (!p) return;
      const c = cart(), ex = c.find(i => i.id === p.id);
      if (ex) ex.qty++; else c.push({ id: p.id, name: p.name, price: p.price, image: p.image, qty: 1 });
      save("tm-market-cart", c); updateBagCount(); toast(`${p.name} added to your bag`);
    });
  });
  catBox.addEventListener('change', render);
  range.addEventListener('input', render);
  $("#shopSort").addEventListener('change', render);
  render();
}

/* ---------- sell page: same WhatsApp onboarding as before ---------- */
function initVendorForm() {
  const vendorForm = $(".vendor-form");
  if (!vendorForm) return;
  vendorForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = vendorForm.querySelector('input[placeholder*="John Doe"]')?.value || "";
    const storeName = vendorForm.querySelector('input[placeholder*="Jay Fashion"]')?.value || "";
    const phone = vendorForm.querySelector('input[type="tel"]')?.value || "";
    const category = vendorForm.querySelector('select')?.value || "";
    const adminWhatsApp = "2347086049886";
    const message = `Hello TM Market, I would like to register as a seller!\n\n*Name:* ${name}\n*Store:* ${storeName}\n*Phone:* ${phone}\n*Category:* ${category}`;
    window.open(`https://wa.me/${adminWhatsApp}?text=${encodeURIComponent(message)}`, "_blank", "noopener");
  });
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
      const nav = $('#mainNav'), b = $('#mobileMenuBtn');
      const isOpen = nav.classList.toggle('open');
      b.setAttribute('aria-expanded', String(isOpen));
    }
    if (e.target.closest('#backTop')) window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
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
