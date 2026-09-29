"use strict";

document.addEventListener("DOMContentLoaded", () => {
  // The full store UI only exists on index.html; other pages use the simple script below
  if (!document.querySelector("#productGrid")) return;
  const products = [
    {id:"aurora-x1",name:"Aurora X1 Smartphone",category:"Electronics",price:89000,oldPrice:105000,rating:4.9,reviews:124,badge:"Best seller",stock:"In stock",newness:8,image:"assets/product-1.svg"},
    {id:"pulse-pro",name:"Pulse Pro Headphones",category:"Electronics",price:45000,oldPrice:56000,rating:4.8,reviews:87,badge:"20% off",stock:"Only 6 left",newness:7,image:"assets/product-2.svg"},
    {id:"streetflex",name:"StreetFlex Sneakers",category:"Fashion",price:32000,oldPrice:40000,rating:4.7,reviews:64,badge:"Trending",stock:"In stock",newness:6,image:"assets/product-3.svg"},
    {id:"nova-bag",name:"Nova Everyday Bag",category:"Fashion",price:18500,oldPrice:23000,rating:4.8,reviews:53,badge:"Popular",stock:"In stock",newness:5,image:"assets/product-4.svg"},
    {id:"chrono-watch",name:"Chrono Smart Watch",category:"Accessories",price:56000,oldPrice:65000,rating:4.6,reviews:41,badge:"New",stock:"In stock",newness:10,image:"assets/product-5.svg"},
    {id:"sounddock",name:"SoundDock Mini",category:"Electronics",price:27000,oldPrice:32000,rating:4.7,reviews:38,badge:"20% off",stock:"In stock",newness:9,image:"assets/product-6.svg"},
    {id:"cloudfit",name:"CloudFit Hoodie",category:"Fashion",price:24000,oldPrice:29000,rating:4.9,reviews:72,badge:"New",stock:"In stock",newness:11,image:"assets/product-7.svg"},
    {id:"pixel-pro",name:"Pixel Pro Camera",category:"Home",price:125000,oldPrice:145000,rating:4.8,reviews:29,badge:"Pro pick",stock:"Only 3 left",newness:4,image:"assets/product-8.svg"}
  ];

  const state = {
    filter:"All", query:"", sort:"featured",
    cart: load("tm-market-cart", []),
    wishlist: load("tm-market-wishlist", []),
    coupon: null
  };

  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const money = n => new Intl.NumberFormat("en-NG",{style:"currency",currency:"NGN",maximumFractionDigits:0}).format(n);
  const save = (k,v) => localStorage.setItem(k, JSON.stringify(v));
  function load(k,fallback){try{const v=JSON.parse(localStorage.getItem(k));return v ?? fallback}catch{return fallback}}
  function product(id){return products.find(p=>p.id===id)}
  function toast(message){const el=$("#toast");el.textContent=message;el.classList.add("show");clearTimeout(toast.t);toast.t=setTimeout(()=>el.classList.remove("show"),2300)}

  function filteredProducts(){
    let list=products.filter(p=>(state.filter==="All"||p.category===state.filter) && (!state.query || `${p.name} ${p.category}`.toLowerCase().includes(state.query)));
    const sort={ "price-low":(a,b)=>a.price-b.price,"price-high":(a,b)=>b.price-a.price,"rating":(a,b)=>b.rating-a.rating,"newest":(a,b)=>b.newness-a.newness };
    if(sort[state.sort]) list.sort(sort[state.sort]);
    return list;
  }

  function renderProducts(){
    const grid=$("#productGrid"), list=filteredProducts();
    $("#resultsCount").textContent=`${list.length} product${list.length===1?"":"s"}`;
    $("#noResults").hidden=!!list.length; grid.innerHTML="";
    list.forEach(p=>{
      const card=document.createElement("article"); card.className="product-card";
      const wished=state.wishlist.includes(p.id);
      card.innerHTML=`<div class="product-media">
        <span class="badge ${p.badge.includes("off")?"sale":""}">${p.badge}</span>
        <button class="heart ${wished?"active":""}" data-wish="${p.id}" aria-label="${wished?"Remove":"Add"} ${p.name} ${wished?"from":"to"} wishlist">${wished?"♥":"♡"}</button>
        <a href="product.html" aria-label="View ${p.name}"><img src="${p.image}" alt="${p.name}" loading="lazy"></a>
        <button class="quick-view" data-quick="${p.id}" type="button">Quick view</button>
      </div>
      <div class="product-info">
        <div class="product-meta"><span class="product-category">${p.category}</span><span class="stock">${p.stock}</span></div>
        <h3><a href="product.html">${p.name}</a></h3><div class="rating">★★★★★ <span>${p.rating} (${p.reviews})</span></div>
        <div class="price-row"><div class="price">${money(p.price)} <span class="old-price">${money(p.oldPrice)}</span></div><button class="add-btn" data-add="${p.id}" type="button" aria-label="Add ${p.name} to cart">+</button></div>
      </div>`;
      grid.appendChild(card);
    });
  }

  function updateCounts(){
    const cartCount=state.cart.reduce((n,i)=>n+i.qty,0);
    $("#cartCount").textContent=cartCount;
    $("#wishlistCount").textContent=state.wishlist.length;
    $("#wishlistNavCount").textContent=state.wishlist.length;
  }

  function renderCart(){
    const wrap=$("#cartItems"), subtotal=state.cart.reduce((n,i)=>n+i.price*i.qty,0);
    const discount = state.coupon === "TM20" ? subtotal * 0.20 : 0;
    const total = subtotal - discount;
    $("#cartSubtotal").textContent=money(total);
    $("#checkoutTotal").textContent=money(total);
    const pct=Math.min(100,(subtotal/50000)*100);
    $("#shippingBar").style.width=`${pct}%`;
    $("#shippingAmount").textContent=`${money(subtotal)} / ₦50k`;
    if(subtotal>=50000){$("#shippingMessage").textContent="🎉 You unlocked free delivery!";$("#deliveryCost").textContent="FREE"}
    else {$("#shippingMessage").textContent=`Add ${money(50000-subtotal)} for free delivery`;$("#deliveryCost").textContent="Calculated at checkout"}
    wrap.innerHTML="";
    if(!state.cart.length){wrap.innerHTML='<div class="cart-empty"><div style="font-size:38px">🛍</div><strong>Your bag is waiting</strong><span>Add something you love and it will appear here.</span></div>';updateCounts();return}
    state.cart.forEach(item=>{
      const el=document.createElement("div");el.className="cart-line";
      el.innerHTML=`<img src="${item.image}" alt="${item.name}"><div><h3>${item.name}</h3><p>${money(item.price)}</p><div class="qty"><button data-qty="${item.id}" data-delta="-1" aria-label="Decrease">−</button><strong>${item.qty}</strong><button data-qty="${item.id}" data-delta="1" aria-label="Increase">+</button><button class="remove" data-remove="${item.id}" type="button">Remove</button></div></div><span class="line-total">${money(item.price*item.qty)}</span>`;
      wrap.appendChild(el);
    });
    updateCounts();
  }

  function addToCart(id){
    const p=product(id), existing=state.cart.find(i=>i.id===id);
    if(existing) existing.qty++; else state.cart.push({id:p.id,name:p.name,price:p.price,image:p.image,qty:1});
    save("tm-market-cart",state.cart);renderCart();openCart();toast(`${p.name} added to your cart`);
  }

  function toggleWish(id){
    const p=product(id), i=state.wishlist.indexOf(id);
    if(i>-1){state.wishlist.splice(i,1);toast("Removed from wishlist")}else{state.wishlist.push(id);toast(`${p.name} saved to wishlist`)}
    save("tm-market-wishlist",state.wishlist);renderProducts();updateCounts();
  }

  function openCart(){const d=$("#cartDrawer");d.classList.add("open");d.setAttribute("aria-hidden","false");$("#drawerOverlay").hidden=false;document.body.style.overflow="hidden"}
  function closeCart(){const d=$("#cartDrawer");d.classList.remove("open");d.setAttribute("aria-hidden","true");$("#drawerOverlay").hidden=true;document.body.style.overflow=""}

  function openQuick(id){
    const p=product(id), modal=$("#productModal");
    $("#modalContent").innerHTML=`<div class="modal-content"><img class="quick-image" src="${p.image}" alt="${p.name}"><div class="modal-info"><span class="eyebrow">${p.category}</span><h2>${p.name}</h2><div class="rating">★★★★★ <span>${p.rating} · ${p.reviews} reviews</span></div><p>Thoughtfully selected for everyday use, with a clean design and the quality you expect from TM Market.</p><div class="modal-price">${money(p.price)} <span class="old-price">${money(p.oldPrice)}</span></div><p style="color:var(--green);font-size:11px;font-weight:800">✓ ${p.stock}</p><button class="btn btn-primary" data-modal-add="${p.id}" style="width:100%;margin-top:15px">Add to cart →</button></div></div>`;
    modal.showModal();
  }

  function applyFilters(){
    renderProducts();
    $$(".chip").forEach(c=>c.classList.toggle("active",c.dataset.filter===state.filter));
    $("#noResults").querySelector("h3").textContent="No products found";
    $("#noResults").querySelector("p").textContent="Try another search or clear your filters.";
  }

  function showWishlist(){
    const wished = products.filter(p=>state.wishlist.includes(p.id));
    state.filter="All"; state.query="";
    $("#searchInput").value=""; $("#clearSearch").hidden=true;
    const grid=$("#productGrid");
    $("#resultsCount").textContent=`${wished.length} saved product${wished.length===1?"":"s"}`;
    $("#noResults").hidden=!!wished.length;
    if(!wished.length){grid.innerHTML="";$("#noResults").querySelector("h3").textContent="Your wishlist is empty";$("#noResults").querySelector("p").textContent="Tap the heart on a product to save it for later.";document.querySelector("#shop").scrollIntoView({behavior:"smooth"});return}
    grid.innerHTML="";
    wished.forEach(p=>{
      const card=document.createElement("article"); card.className="product-card";
      card.innerHTML=`<div class="product-media"><span class="badge">Saved</span><button class="heart active" data-wish="${p.id}" aria-label="Remove ${p.name} from wishlist">♥</button><a href="product.html" aria-label="View ${p.name}"><img src="${p.image}" alt="${p.name}" loading="lazy"></a><button class="quick-view" data-quick="${p.id}" type="button">Quick view</button></div><div class="product-info"><div class="product-meta"><span class="product-category">${p.category}</span><span class="stock">${p.stock}</span></div><h3><a href="product.html">${p.name}</a></h3><div class="rating">★★★★★ <span>${p.rating} (${p.reviews})</span></div><div class="price-row"><div class="price">${money(p.price)}</div><button class="add-btn" data-add="${p.id}" type="button" aria-label="Add ${p.name} to cart">+</button></div></div>`;
      grid.appendChild(card);
    });
    document.querySelector("#shop").scrollIntoView({behavior:"smooth"});
  }

  $("#productGrid").addEventListener("click",e=>{
    const add=e.target.closest("[data-add]"), wish=e.target.closest("[data-wish]"), quick=e.target.closest("[data-quick]");
    if(add)addToCart(add.dataset.add);
    if(wish)toggleWish(wish.dataset.wish);
    if(quick)openQuick(quick.dataset.quick);
  });
  $("#cartItems").addEventListener("click",e=>{
    const qty=e.target.closest("[data-qty]"), remove=e.target.closest("[data-remove]");
    if(qty){const i=state.cart.find(x=>x.id===qty.dataset.qty);i.qty+=Number(qty.dataset.delta);if(i.qty<=0)state.cart=state.cart.filter(x=>x.id!==i.id);save("tm-market-cart",state.cart);renderCart()}
    if(remove){state.cart=state.cart.filter(x=>x.id!==remove.dataset.remove);save("tm-market-cart",state.cart);renderCart();toast("Item removed")}
  });
  $("#searchInput").addEventListener("input",e=>{
    state.query=e.target.value.trim().toLowerCase();$("#clearSearch").hidden=!state.query;renderSuggestions();renderProducts();
  });
  $("#clearSearch").addEventListener("click",()=>{$("#searchInput").value="";state.query="";$("#clearSearch").hidden=true;$("#searchSuggestions").hidden=true;renderProducts()});
  function renderSuggestions(){
    const q=state.query, box=$("#searchSuggestions");
    if(!q){box.hidden=true;return}
    const hits=products.filter(p=>`${p.name} ${p.category}`.toLowerCase().includes(q)).slice(0,5);
    box.innerHTML=hits.length?hits.map(p=>`<button type="button" data-suggest="${p.id}">⌕&nbsp; ${p.name}<span style="margin-left:auto;color:var(--muted);font-size:10px">${p.category}</span></button>`).join(""):'<div style="padding:12px;color:var(--muted);font-size:11px">No matching products</div>';
    box.hidden=false;
  }
  $("#searchSuggestions").addEventListener("click",e=>{const b=e.target.closest("[data-suggest]");if(!b)return;openQuick(b.dataset.suggest);$("#searchSuggestions").hidden=true});
  document.addEventListener("click",e=>{if(!e.target.closest(".search-wrap"))$("#searchSuggestions").hidden=true});

  $$(".chip").forEach(c=>c.addEventListener("click",()=>{state.filter=c.dataset.filter;applyFilters()}));
  $$(".category-card").forEach(c=>c.addEventListener("click",()=>{state.filter=c.dataset.category;applyFilters();document.querySelector("#shop").scrollIntoView({behavior:"smooth"})}));
  $("#sortSelect").addEventListener("change",e=>{state.sort=e.target.value;renderProducts()});
  $("#clearFilters").addEventListener("click",()=>{state.filter="All";state.query="";$("#searchInput").value="";$("#clearSearch").hidden=true;$("#sortSelect").value="featured";state.sort="featured";applyFilters()});
  $("#resetShop").addEventListener("click",()=>$("#clearFilters").click());
  $("#wishlistBtn").addEventListener("click",showWishlist);
  $("#wishlistNav").addEventListener("click",showWishlist);
  $("#cartBtn").addEventListener("click",openCart);$("#closeCart").addEventListener("click",closeCart);$("#drawerOverlay").addEventListener("click",closeCart);
  $("#modalClose").addEventListener("click",()=>$("#productModal").close());
  $("#modalContent").addEventListener("click",e=>{const b=e.target.closest("[data-modal-add]");if(b){addToCart(b.dataset.modalAdd);$("#productModal").close()}});
  $("#checkoutBtn").addEventListener("click",()=>{if(!state.cart.length){toast("Your cart is empty");return}renderCart();$("#checkoutModal").showModal()});
  $("#checkoutClose").addEventListener("click",()=>$("#checkoutModal").close());
  $("#checkoutForm").addEventListener("submit",e=>{e.preventDefault();const name=new FormData(e.target).get("name");$("#checkoutModal").close();state.cart=[];save("tm-market-cart",state.cart);renderCart();closeCart();toast(`Thanks, ${name}. Your order is ready for payment connection.`);e.target.reset()});
  $("#applyCoupon").addEventListener("click",()=>{const code=$("#couponInput").value.trim().toUpperCase();if(code==="TM20"){state.coupon="TM20";renderCart();toast("TM20 applied — 20% off your cart.")}else{state.coupon=null;renderCart();toast("That promo code isn't valid. Try TM20.")}});
  $("#copyCode").addEventListener("click",async()=>{try{await navigator.clipboard.writeText("TM20");toast("TM20 copied")}catch{toast("Promo code: TM20")}});
  $("#newsletterForm").addEventListener("submit",e=>{e.preventDefault();const email=$("#newsletterEmail").value;toast(`You're in — updates will go to ${email}`);e.target.reset()});
  $("#themeBtn").addEventListener("click",()=>{document.body.classList.toggle("dark");localStorage.setItem("tm-market-dark",document.body.classList.contains("dark"));});
  if(localStorage.getItem("tm-market-dark")==="true")document.body.classList.add("dark");
  $("#mobileMenuBtn").addEventListener("click",()=>{const nav=$("#mainNav"),open=nav.classList.toggle("open");$("#mobileMenuBtn").setAttribute("aria-expanded",open)});
  $$("#mainNav a").forEach(a=>a.addEventListener("click",()=>$("#mainNav").classList.remove("open")));
  document.addEventListener("keydown",e=>{if(e.key==="Escape"){closeCart();if($("#searchSuggestions"))$("#searchSuggestions").hidden=true}});
  window.addEventListener("scroll",()=>$("#backTop").classList.toggle("show",scrollY>500));
  $("#backTop").addEventListener("click",()=>scrollTo({top:0,behavior:"smooth"}));
  renderProducts();renderCart();
});
// --- Mock Product Database (Sellers + Affiliate Items) ---
const products = [
  {
    id: 1,
    title: "Aurora X1 Smartphone",
    price: 120000,
    seller: "Lagos Gadgets Hub",
    isPartner: false,
    category: "electronics",
    image: "assets/product-1.svg"
  },
  {
    id: 2,
    title: "Wireless Noise-Canceling Earbuds",
    price: 18500,
    seller: "Jumia Partner",
    isPartner: true,
    affiliateUrl: "https://www.jumia.com.ng", // Add your affiliate link here
    category: "electronics",
    image: "assets/product-1.svg"
  },
  {
    id: 3,
    title: "Casual Designer Sneakers",
    price: 25000,
    seller: "Kicks Plug Abuja",
    isPartner: false,
    category: "fashion",
    image: "assets/product-1.svg"
  }
];

// --- Simple State Engine ---
let cart = [];

document.addEventListener("DOMContentLoaded", () => {
  // 1. Render Products on products.html
  const productGrid = document.querySelector(".product-grid");
  if (productGrid && !document.querySelector("#productGrid")) {
    renderProducts(products, productGrid);
  }

  // 2. Handle Vendor Form Submission (WhatsApp Onboarding)
  const vendorForm = document.querySelector(".vendor-form");
  if (vendorForm) {
    vendorForm.addEventListener("submit", handleVendorSubmit);
  }
});

// Function to render products dynamically
function renderProducts(items, container) {
  container.innerHTML = ""; // Clear existing placeholder HTML

  items.forEach(product => {
    const card = document.createElement("div");
    card.className = "product-card";

    // Format currency to Nigerian Naira
    const formattedPrice = new Intl.NumberFormat("en-NG", {
      style: "currency",
      currency: "NGN",
      maximumFractionDigits: 0
    }).format(product.price);

    // Conditional render based on whether it's an affiliate item or merchant item
    const badgeText = product.isPartner ? "Partner Deal" : "Verified Merchant";
    const badgeClass = product.isPartner ? "badge partner" : "badge";
    const actionButton = product.isPartner
      ? `<a href="${product.affiliateUrl}" target="_blank" class="btn-affiliate">Buy on Partner Store ↗</a>`
      : `<button class="btn-cart" onclick="addToCart(${product.id})">Add to Bag</button>`;

    card.innerHTML = `
      <span class="${badgeClass}">${badgeText}</span>
      <img src="${product.image}" alt="${product.title}">
      <div>
        <h4>${product.title}</h4>
        <p class="seller-info">Sold by: <strong>${product.seller}</strong></p>
        <p class="price">${formattedPrice}</p>
      </div>
      ${actionButton}
    `;

    container.appendChild(card);
  });
}

// Function to handle merchant registration without a backend
function handleVendorSubmit(event) {
  event.preventDefault();
  
  const form = event.target;
  const name = form.querySelector('input[placeholder*="John Doe"]').value;
  const storeName = form.querySelector('input[placeholder*="Jay Fashion"]').value;
  const phone = form.querySelector('input[type="tel"]').value;
  const category = form.querySelector('select').value;

  // Format message to send directly to your WhatsApp
  const adminWhatsApp = "2347086049886";
  const message = `Hello TM Market, I would like to register as a seller!%0A%0A*Name:* ${name}%0A*Store:* ${storeName}%0A*Phone:* ${phone}%0A*Category:* ${category}`;

  // Redirect merchant to WhatsApp to send details
  window.open(`https://wa.me/${adminWhatsApp}?text=${message}`, "_blank");
}

// Global Cart Functionality
function addToCart(productId) {
  const item = products.find(p => p.id === productId);
  if (item) {
    cart.push(item);
    updateCartUI();
  }
}

function updateCartUI() {
  const cartButtons = document.querySelectorAll(".cart-btn");
  cartButtons.forEach(btn => {
    btn.textContent = `🛒 Bag (${cart.length})`;
  });
  alert("Item added to bag!");
}