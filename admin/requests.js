/* TM Market admin: "Requests" tab (customers asking for products that are not on the platform yet).
   Loaded by index.html. Uses the helpers already defined there: api, run, esc, date, naira, $, token, show, fail. */
(function () {
  const css = document.createElement('style');
  css.textContent = `
  .rq-tools{display:flex;flex-wrap:wrap;gap:10px;margin:14px 0}.rq-tools select,.rq-tools input{padding:9px 11px;border:1px solid var(--line,#ddd);border-radius:10px;font:inherit}
  .rq-card{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:12px}.rq-imgs{display:flex;gap:8px;flex-wrap:wrap}
  .rq-imgs img{width:92px;height:92px;object-fit:cover;border-radius:10px;border:1px solid var(--line,#ddd)}
  .rq-main{flex:1;min-width:230px}.rq-main p{margin:4px 0;overflow-wrap:anywhere}.rq-who{font-size:13px;opacity:.85}
  .rq-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.rq-actions textarea{width:100%;padding:8px 10px;border:1px solid var(--line,#ddd);border-radius:10px;font:inherit}
  `;
  document.head.appendChild(css);

  const baseTitle = document.title;
  let rqStatus = 'pending', rqSearch = '', rqPage = 1, lastPending = null;
  const STATUS = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected', fulfilled: 'Available' };

  // Reuse the panel's own alert bar (the same one used for new orders and withdrawals).
  function alertNew(n) {
    try {
      alertTo = 'requests';
      document.getElementById('alerttxt').textContent = n === 1 ? 'New product request from a customer.' : n + ' product requests are waiting for review.';
      document.getElementById('alertgo').textContent = 'View requests';
      document.getElementById('alertbar').hidden = false;
      if (typeof beep === 'function') beep();
    } catch (e) { /* the badge still shows the count */ }
  }

  async function refreshBadge() {
    const app = document.getElementById('appView');
    if (!token || !app || app.hidden) return;
    try {
      const { summary } = await api('/api/admin/requests/summary');
      const n = summary.pending;
      const b = document.getElementById('reqBadge');
      if (b) { b.textContent = n; b.hidden = !n; }
      document.title = (n ? `(${n}) ` : '') + baseTitle;
      if (lastPending !== null && n > lastPending) alertNew(n);
      lastPending = n;
    } catch (e) { /* the badge is a convenience; ignore network errors */ }
  }
  setTimeout(refreshBadge, 2500);
  setInterval(refreshBadge, 30000);

  function row(r) {
    const imgs = (r.images || []).map(u => `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="" loading="lazy"></a>`).join('');
    const meta = [r.category_name, r.budget ? 'Budget ' + naira(r.budget) : '', r.location, date(r.created_at)].filter(Boolean).map(esc).join(' · ');
    const note = r.admin_note ? `<p><em>Note: ${esc(r.admin_note)}</em></p>` : '';
    const btn = (s, label) => r.status === s ? '' : `<button class="btn" data-act="${s}" data-id="${r.id}">${label}</button>`;
    return `<div class="card rq-card" id="rq${r.id}"><div class="rq-imgs">${imgs}</div>
      <div class="rq-main"><strong>${esc(r.title)}</strong> <span class="pill">${esc(STATUS[r.status] || r.status)}</span>
      <p>${esc(r.description)}</p><p>${meta}</p>
      <p class="rq-who">${esc(r.customer_name)} · ${esc(r.customer_email)} · ${esc(r.customer_phone || 'no phone saved')}</p>${note}
      <div class="rq-actions"><textarea id="rqn${r.id}" rows="2" maxlength="500" placeholder="Optional note for the customer (shown if you reject)"></textarea>
      ${btn('approved', 'Approve (publish)')}${btn('fulfilled', 'Mark available')}${btn('rejected', 'Reject')}${r.status === 'pending' ? '' : btn('pending', 'Back to pending')}</div></div></div>`;
  }

  async function load() {
    const list = document.getElementById('rqList'), pager = document.getElementById('rqPager');
    try {
      const q = new URLSearchParams({ page: rqPage, limit: 10 });
      if (rqStatus) q.set('status', rqStatus);
      if (rqSearch) q.set('search', rqSearch);
      const d = await run('Loading requests…', () => api('/api/admin/requests?' + q));
      list.innerHTML = d.requests.length ? d.requests.map(row).join('') : '<div class="card">No requests here yet.</div>';
      const p = d.pagination;
      pager.innerHTML = p.totalPages > 1 ? `<button class="btn" id="rqPrev" ${p.page <= 1 ? 'disabled' : ''}>Previous</button> Page ${p.page} of ${p.totalPages} <button class="btn" id="rqNext" ${p.page >= p.totalPages ? 'disabled' : ''}>Next</button>` : '';
      if (p.totalPages > 1) { document.getElementById('rqPrev').onclick = () => { rqPage--; load(); }; document.getElementById('rqNext').onclick = () => { rqPage++; load(); }; }
    } catch (e) { fail(e); }
  }

  window.requests = async function requests() {
    document.getElementById('view').innerHTML = `<h1>Product requests</h1>
      <p>Customers ask for products that are not on TM Market yet. Nothing is shown publicly until you approve it.</p>
      <div class="rq-tools"><select id="rqStatus"><option value="pending">Pending</option><option value="approved">Approved</option><option value="fulfilled">Available</option><option value="rejected">Rejected</option><option value="">All</option></select>
      <input id="rqSearch" type="search" placeholder="Search title or customer"></div>
      <div id="rqList"></div><div id="rqPager" style="margin:12px 0"></div>`;
    const sel = document.getElementById('rqStatus'), inp = document.getElementById('rqSearch');
    sel.value = rqStatus; inp.value = rqSearch;
    sel.onchange = () => { rqStatus = sel.value; rqPage = 1; load(); };
    let t; inp.oninput = () => { clearTimeout(t); t = setTimeout(() => { rqSearch = inp.value.trim(); rqPage = 1; load(); }, 350); };
    document.getElementById('rqList').onclick = async e => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      const id = b.dataset.id, status = b.dataset.act, noteEl = document.getElementById('rqn' + id);
      try {
        await run('Saving…', () => api(`/api/admin/requests/${id}/status`, { method: 'POST', body: JSON.stringify({ status, note: noteEl ? noteEl.value.trim() : '' }) }));
        load(); refreshBadge();
      } catch (err) { alert(err.message); }
    };
    load();
  };
})();
