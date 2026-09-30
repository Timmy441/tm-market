"use strict";

const API_URL = 'https://tm-market-backend.fly.dev';

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

// Helper functions for storage and currency
const load = (k, fallback) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? fallback; } catch { return fallback; } };
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
const money = n => new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", maximumFractionDigits: 0 }).format(n);

// UI Toast Notification
function toast(message) {
  const el = document.querySelector("#toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove("show"), 2300);
}

// --- Auth Functions (Connected to Fly.dev Backend) ---
async function handleRegister(name, email, password) {
  try {
    const res = await fetch(`${API_URL}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Registration failed');
    toast('Registration successful! You can now log in.');
    return data;
  } catch (err) {
    toast(err.message);
  }
}

async function handleLogin(email, password) {
  try {
    const res = await fetch(`${API_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Login failed');
    localStorage.setItem('tm_token', data.token);
    localStorage.setItem('tm_user', JSON.stringify(data.user));
    toast(`Welcome back, ${data.user.name}!`);
    updateAuthUI();
    return data;
  } catch (err) {
    toast(err.message);
  }
}

function updateAuthUI() {
  const token = localStorage.getItem('tm_token');
  const user = JSON.parse(localStorage.getItem('tm_user') || '{}');
  const authContainer = document.querySelector('#authContainer');

  if (authContainer) {
    if (token && user.name) {
      const avatarSrc = user.avatar || 'assets/default-avatar.svg';
      authContainer.innerHTML = `
        <button id="openProfileBtn" class="profile-chip" type="button">
          <img src="${avatarSrc}" alt="${user.name}" class="nav-avatar">
          <span>${user.name}</span>
        </button>
        <button id="logoutBtn" class="btn-sm">Logout</button>
      `;
      document.querySelector('#logoutBtn')?.addEventListener('click', handleLogout);
      document.querySelector('#openProfileBtn')?.addEventListener('click', openProfileModal);
    } else {
      authContainer.innerHTML = `<button id="openAuthBtn" class="btn-sm">Login / Register</button>`;
      document.querySelector('#openAuthBtn')?.addEventListener('click', () => {
        document.querySelector('#authModal')?.removeAttribute('hidden');
      });
    }
  }
}

function openProfileModal() {
  const user = JSON.parse(localStorage.getItem('tm_user') || '{}');
  const modal = document.querySelector('#profileModal');
  if (!modal) return;

  document.querySelector('#profile-name').value = user.name || '';
  document.querySelector('#profile-email').value = user.email || '';
  document.querySelector('#profile-phone').value = user.phone || '';
  document.querySelector('#profile-address').value = user.address || '';
  if (user.avatar) document.querySelector('#profileAvatarPrev').src = user.avatar;

  modal.removeAttribute('hidden');
}

function handleLogout() {
  localStorage.removeItem('tm_token');
  localStorage.removeItem('tm_user');
  toast('Logged out successfully');
  setTimeout(() => window.location.reload(), 1000);
}
async function handleLogin(email, password) {
  try {
    const res = await fetch(`${API_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Login failed');

    // Save session
    localStorage.setItem('tm_token', data.token);
    localStorage.setItem('tm_user', JSON.stringify(data.user));

    toast(`Welcome back, ${data.user.name}!`);

    // 1. Auto-close the Auth Modal immediately
    const authModal = document.querySelector('#authModal');
    if (authModal) authModal.setAttribute('hidden', 'true');

    // 2. Clear input fields
    document.querySelector('#login-email').value = '';
    document.querySelector('#login-password').value = '';

    // 3. Update header UI and trigger pending action if any
    updateAuthUI();
    if (window.pendingAuthAction) {
      window.pendingAuthAction();
      window.pendingAuthAction = null;
    }

    return data;
  } catch (err) {
    toast(err.message);
  }
}

// Profile Modal listeners
const profileModal = document.querySelector('#profileModal');
document.querySelector('#closeProfileModal')?.addEventListener('click', () => {
  profileModal?.setAttribute('hidden', 'true');
});
function showLoader(durationMs = 0) {
  const loader = document.querySelector('#pageLoader');
  if (loader) loader.removeAttribute('hidden');

  if (durationMs > 0) {
    setTimeout(() => {
      hideLoader();
    }, durationMs);
  }
}

function hideLoader() {
  const loader = document.querySelector('#pageLoader');
  if (loader) loader.setAttribute('hidden', 'true');
}

// Show loader on initial page load for 3 seconds
window.addEventListener('load', () => {
  showLoader(3000); // Loader displays for 3 seconds when opening the site
});

// Profile picture upload preview
document.querySelector('#avatarInput')?.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) {
    const reader = new FileReader();
    reader.onload = (evt) => {
      document.querySelector('#profileAvatarPrev').src = evt.target.result;
    };
    reader.readAsDataURL(file);
  }
});
function requireAuth(actionCallback) {
  const token = localStorage.getItem('tm_token');
  if (token) {
    // User is logged in, perform action
    actionCallback();
  } else {
    // Save pending action to execute after login
    window.pendingAuthAction = actionCallback;
    // Show toast and open auth modal
    toast('Please log in or sign up to continue.');
    document.querySelector('#authModal')?.removeAttribute('hidden');
  }
}
// Example for "Shop Now" / Start Shopping button:
document.querySelector('#startShoppingBtn')?.addEventListener('click', (e) => {
  e.preventDefault();
  requireAuth(() => {
    // Smooth scroll to product grid or navigate to shop section
    document.querySelector('#products-section')?.scrollIntoView({ behavior: 'smooth' });
  });
});

// Example for "Add to Cart" buttons:
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('add-to-cart-btn')) {
    e.preventDefault();
    const productId = e.target.dataset.id;
    requireAuth(() => {
      addToCart(productId);
    });
  }
});

// Example for "Sell" / "Post Ad" button:
document.querySelector('#sellBtn')?.addEventListener('click', (e) => {
  e.preventDefault();
  requireAuth(() => {
    openSellModal();
  });
});
// Save profile form
document.querySelector('#profile-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const user = JSON.parse(localStorage.getItem('tm_user') || '{}');
  
  user.name = document.querySelector('#profile-name').value;
  user.phone = document.querySelector('#profile-phone').value;
  user.address = document.querySelector('#profile-address').value;
  user.avatar = document.querySelector('#profileAvatarPrev').src;

  localStorage.setItem('tm_user', JSON.stringify(user));
  updateAuthUI();
  profileModal?.setAttribute('hidden', 'true');
  toast('Profile updated successfully!');
});

// --- Main Application Engine ---
document.addEventListener("DOMContentLoaded", () => {
  updateAuthUI();

  // Attach auth form listeners if forms exist
  document.querySelector('#register-form')?.addEventListener('submit', e => {
    e.preventDefault();
    handleRegister(
      document.querySelector('#reg-name').value,
      document.querySelector('#reg-email').value,
      document.querySelector('#reg-password').value
    );
  });

// Toggle Auth Modal
const authModal = document.querySelector("#authModal");
const openAuthBtn = document.querySelector("#openAuthBtn");
const closeAuthBtn = document.querySelector("#closeAuthModal");
const tabLoginBtn = document.querySelector("#tabLoginBtn");
const tabRegisterBtn = document.querySelector("#tabRegisterBtn");
const loginForm = document.querySelector("#login-form");
const registerForm = document.querySelector("#register-form");

if (openAuthBtn && authModal) {
  openAuthBtn.addEventListener("click", () => authModal.removeAttribute("hidden"));
  closeAuthBtn?.addEventListener("click", () => authModal.setAttribute("hidden", "true"));

  tabLoginBtn?.addEventListener("click", () => {
    tabLoginBtn.classList.add("active");
    tabRegisterBtn.classList.remove("active");
    loginForm.style.display = "block";
    registerForm.style.display = "none";
  });

  tabRegisterBtn?.addEventListener("click", () => {
    tabRegisterBtn.classList.add("active");
    tabLoginBtn.classList.remove("active");
    registerForm.style.display = "block";
    loginForm.style.display = "none";
  });
}
  document.querySelector('#login-form')?.addEventListener('submit', e => {
    e.preventDefault();
    handleLogin(
      document.querySelector('#login-email').value,
      document.querySelector('#login-password').value
    );
  });

  // Handle Vendor Form Submission (WhatsApp Onboarding)
  const vendorForm = document.querySelector(".vendor-form");
  if (vendorForm) {
    vendorForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = vendorForm.querySelector('input[placeholder*="John Doe"]')?.value || "";
      const storeName = vendorForm.querySelector('input[placeholder*="Jay Fashion"]')?.value || "";
      const phone = vendorForm.querySelector('input[type="tel"]')?.value || "";
      const category = vendorForm.querySelector('select')?.value || "";
      const adminWhatsApp = "2347086049886";
      const message = `Hello TM Market, I would like to register as a seller!%0A%0A*Name:* ${name}%0A*Store:* ${storeName}%0A*Phone:* ${phone}%0A*Category:* ${category}`;
      window.open(`https://wa.me/${adminWhatsApp}?text=${message}`, "_blank");
    });
  }

  // --- Storefront logic (Runs if productGrid is present) ---
  if (!document.querySelector("#productGrid")) return;

  const state = {
    filter: "All", query: "", sort: "featured",
    cart: load("tm-market-cart", []),
    wishlist: load("tm-market-wishlist", []),
    coupon: null
  };

  const $ = s => document.querySelector(s);   const $$ = s => [...document.querySelectorAll(s)];
  const product = id => products.find(p => p.id === id || p.id === Number(id));

  function filteredProducts() {
    let list = products.filter(p => (state.filter === "All" || p.category === state.filter) && (!state.query || `${p.name} ${p.category}`.toLowerCase().includes(state.query)));
    const sort = { "price-low": (a, b) => a.price - b.price, "price-high": (a, b) => b.price - a.price, "rating": (a, b) => b.rating - a.rating, "newest": (a, b) => b.newness - a.newness };
    if (sort[state.sort]) list.sort(sort[state.sort]);
    return list;
  }

  function renderProducts() {
    const grid = $("#productGrid"), list = filteredProducts();
    $("#resultsCount").textContent = `${list.length} product${list.length === 1 ? "" : "s"}`;
    $("#noResults").hidden = !!list.length;
    grid.innerHTML = "";
    
    list.forEach(p => {
      const card = document.createElement("article");
      card.className = "product-card";
      const wished = state.wishlist.includes(p.id);
      const actionButton = p.isPartner
        ? `<a href="${p.affiliateUrl}" target="_blank" class="btn-affiliate">Buy Partner ↗</a>`
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
      updateCounts();
      return;
    }

    state.cart.forEach(item => {
      const el = document.createElement("div");
      el.className = "cart-line";
      el.innerHTML = `<img src="${item.image}" alt="${item.name}"><div><h3>${item.name}</h3><p>${money(item.price)}</p><div class="qty"><button data-qty="${item.id}" data-delta="-1" aria-label="Decrease">−</button><strong>${item.qty}</strong><button data-qty="${item.id}" data-delta="1" aria-label="Increase">+</button><button class="remove" data-remove="${item.id}" type="button">Remove</button></div></div><span class="line-total">${money(item.price * item.qty)}</span>`;
      wrap.appendChild(el);
    });
    updateCounts();
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
    if (!modal) return;
    $("#modalContent").innerHTML = `<div class="modal-content"><img class="quick-image" src="${p.image}" alt="${p.name}"><div class="modal-info"><span class="eyebrow">${p.category}</span><h2>${p.name}</h2><div class="rating">★★★★★ <span>${p.rating} · ${p.reviews} reviews</span></div><p>Thoughtfully selected for everyday use, with a clean design and the quality you expect from TM Market.</p><div class="modal-price">${money(p.price)} ${p.oldPrice ? `<span class="old-price">${money(p.oldPrice)}</span>` : ''}</div><p style="color:var(--green);font-size:11px;font-weight:800">✓ ${p.stock}</p><button class="btn btn-primary" data-modal-add="${p.id}" style="width:100%;margin-top:15px">Add to cart →</button></div></div>`;
    modal.showModal();
  }

  function applyFilters() {
    renderProducts();
    $$(".chip").forEach(c => c.classList.toggle("active", c.dataset.filter === state.filter));
  }

  // --- Event Listeners ---
  $("#productGrid")?.addEventListener("click", e => {
    const add = e.target.closest("[data-add]"), wish = e.target.closest("[data-wish]"), quick = e.target.closest("[data-quick]");
    if (add) addToCart(add.dataset.add);
    if (wish) toggleWish(wish.dataset.wish);
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
    if ($("#clearSearch")) $("#clearSearch").hidden = !state.query;     renderProducts();   });    $$(".chip").forEach(c => c.addEventListener("click", () => { state.filter = c.dataset.filter; applyFilters(); }));
  $("#sortSelect")?.addEventListener("change", e => { state.sort = e.target.value; renderProducts(); });
  $("#cartBtn")?.addEventListener("click", openCart);
  $("#closeCart")?.addEventListener("click", closeCart);
  $("#drawerOverlay")?.addEventListener("click", closeCart);
  $("#modalClose")?.addEventListener("click", () => $("#productModal").close());
  
  $("#modalContent")?.addEventListener("click", e => {
    const b = e.target.closest("[data-modal-add]");
    if (b) { addToCart(b.dataset.modalAdd); $("#productModal").close(); }
  });

  $("#themeBtn")?.addEventListener("click", () => {
    document.body.classList.toggle("dark");
    localStorage.setItem("tm-market-dark", document.body.classList.contains("dark"));
  });

  if (localStorage.getItem("tm-market-dark") === "true") document.body.classList.add("dark");

  renderProducts();
  renderCart();
});