"use strict";

/* ==========================================================================
   TM Store page  (store.html?id=SELLER_ID)
   --------------------------------------------------------------------------
   Shows one seller's public store: name, location, about text and products.
   Loaded AFTER script.js, so it reuses its helpers (el, esc, money, apiRequest,
   mapProduct, showProductDetails, requireAuth, toast, load/save, updateBagCount).
   Backend: GET /api/sellers/:userId/store   (public, returns only public fields)
   Only real data is shown. No ratings or "verified" badge until those systems exist.
   ========================================================================== */
document.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('storeRoot');
  if (!root || !Auth.isLoggedIn()) return;   // script.js already sends logged-out visitors to the login page

  const say = (text, isError) => root.replaceChildren(el('div', { class: 'store-state' + (isError ? ' is-error' : ''), text }));

  document.getElementById('modalClose')?.addEventListener('click', () => document.getElementById('productModal').close());

  function addToBag(p) {
    requireAuth(() => {
      if (!p.available) return toast('This product is no longer available.');
      const c = load('tm-market-cart', []), ex = c.find(i => i.id === p.id);
      if (ex) ex.qty++; else c.push({ id: p.id, name: p.name, price: p.price, image: p.image, qty: 1 });
      save('tm-market-cart', c); updateBagCount(); toast(`${p.name} added to your bag`);
    });
  }

  function card(p) {
    const open = () => showProductDetails(p.id, { onAdd: x => addToBag(x) });
    const img = el('img', { src: p.image, alt: p.name, loading: 'lazy' });
    const title = el('h4', { text: p.name });
    [img, title].forEach(n => { n.style.cursor = 'pointer'; n.addEventListener('click', open); });
    const c = el('div', { class: 'product-card' });
    if (p.badge) c.append(el('span', { class: 'badge', text: p.badge }));
    c.append(img, title);
    if (p.condition) c.append(el('p', { class: 'seller-line' }, el('span', { class: 'cond cond-' + p.condition, text: CONDITION_LABELS[p.condition] })));
    c.append(el('p', { class: 'price', text: money(p.price) }));
    const b = el('button', { class: 'btn-cart', type: 'button', text: p.available ? 'Add to Bag' : 'Unavailable' });
    if (!p.available) b.disabled = true;
    b.addEventListener('click', () => addToBag(p));
    c.append(b);
    return c;
  }

  (async () => {
    const id = params().get('id');
    if (!id || !/^\d+$/.test(id)) return say('This store link is not valid.', true);
    say('Loading store…');
    let data;
    try { data = await apiRequest('GET', `/api/sellers/${encodeURIComponent(id)}/store`); }
    catch (err) { return say(err.status === 404 ? 'This store is not available.' : err.message, true); }

    const s = data.seller;
    const items = (data.products || []).map(mapProduct);
    document.title = `${s.store_name} | TM Marketplace`;

    const logo = s.logo_url && /^https:\/\//i.test(s.logo_url)
      ? el('img', { class: 'store-logo', src: s.logo_url, alt: `${s.store_name} logo` })
      : el('div', { class: 'store-logo store-logo-fallback', 'aria-hidden': 'true', text: (s.store_name || '?').trim().charAt(0).toUpperCase() });

    const joined = s.created_at ? new Date(s.created_at).toLocaleDateString('en-NG', { month: 'long', year: 'numeric' }) : '';
    const meta = [s.location ? '📍 ' + s.location : '', joined ? 'On TM since ' + joined : ''].filter(Boolean).join(' · ');

    const info = el('div', { class: 'store-info' }, el('span', { class: 'eyebrow', text: 'TM STORE' }), el('h1', { text: s.store_name }));
    if (meta) info.append(el('p', { class: 'store-meta', text: meta }));
    if (s.description) info.append(el('p', { class: 'store-about', text: s.description }));

    const grid = el('div', { class: 'product-grid' });
    if (items.length) items.forEach(p => grid.append(card(p)));
    else grid.append(el('div', { class: 'empty-state' }, el('strong', { text: 'No products listed yet' }), document.createTextNode('This seller has not added any products. Check back soon.')));

    root.replaceChildren(
      el('div', { class: 'store-head' }, logo, info),
      el('p', { class: 'store-count', text: `${items.length} product${items.length === 1 ? '' : 's'}` }),
      grid
    );
  })();
});
