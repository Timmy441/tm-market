/* TM Market admin: "Promotions" tab (sellers' paid Sponsored listings).
   Loaded by index.html. Uses the helpers already defined there: api, run, esc, date, naira, $, show, fail, qs, pager, page. */
(function () {
  let rows = [], status = '';
  const LABEL = { running: 'Running', scheduled: 'Starts soon', paused: 'Paused', ended: 'Ended', removed: 'Removed' };
  const CLS = { running: 'ok', scheduled: 'wait', paused: 'wait', ended: '', removed: 'no' };
  const pill = s => `<span class="pill ${CLS[s] || ''}">${esc(LABEL[s] || s)}</span>`;

  window.promotions = async function promotions() {
    if (!$('#pstatus')) {
      $('#view').innerHTML = `<h1>Promotions</h1><div id="psum"></div>
        <div class="tools"><select id="pstatus" aria-label="Status"><option value="">All paid promotions</option><option value="running">Running</option><option value="scheduled">Starts soon</option><option value="paused">Paused</option><option value="ended">Ended</option><option value="removed">Removed</option></select></div><div id="list"></div>`;
      $('#pstatus').onchange = () => { status = $('#pstatus').value; page = 1; promotions(); };
    }
    $('#pstatus').value = status;
    try {
      const d = await run('Loading promotions…', () => api('/api/admin/promotions?' + qs({ status, page })));
      rows = d.promotions;
      const s = d.summary;
      $('#psum').innerHTML = `<div class="cards">
        <div class="card"><b>${naira(s.total)}</b><span>Earned from promotions (before Paystack fees)</span></div>
        <div class="card"><b>${naira(s.last30)}</b><span>Earned in the last 30 days</span></div>
        <div class="card"><b>${s.running}</b><span>Running now (${s.sold} sold in total)</span></div></div>`;
      const body = rows.map(r => `<tr class="row" data-id="${esc(r.id)}"><td>${esc(r.product_name || 'Removed product')}</td><td>${esc(r.seller_name || '-')}</td><td>${r.plan_days} days</td><td>${naira(r.amount)}</td><td>${r.starts_at ? date(r.starts_at) : '-'} to ${r.ends_at ? date(r.ends_at) : '-'}</td><td>${pill(r.state)}</td></tr>`).join('');
      $('#list').innerHTML = `<div class="tbl"><table><tr><th>Product</th><th>Store</th><th>Plan</th><th>Paid</th><th>Runs</th><th>Status</th></tr>${body || '<tr><td colspan="6" class="empty">No paid promotions here yet.</td></tr>'}</table></div>${pager({ total: d.total, limit: d.limit })}`;
      if ($('#prev')) $('#prev').onclick = () => { page--; promotions(); };
      if ($('#next')) $('#next').onclick = () => { page++; promotions(); };
      document.querySelectorAll('tr.row').forEach(r => r.onclick = () => sheet(r.dataset.id));
    } catch (e) { $('#list').innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
  };

  function sheet(id) {
    const r = rows.find(x => String(x.id) === String(id));
    if (!r) return;
    const close = () => { $('#modal').hidden = true; };
    const acts = [];
    if (r.state === 'running' || r.state === 'scheduled') acts.push(['pause', 'Pause promotion', 'btn']);
    if (r.state === 'paused') acts.push(['resume', 'Resume promotion', 'btn good']);
    if (['running', 'scheduled', 'paused'].includes(r.state)) acts.push(['remove', 'Remove promotion', 'btn bad']);
    const hint = r.state === 'paused' ? 'Paused promotions do not show. The paused time is added back when you resume.'
      : r.state === 'removed' ? 'This promotion was removed. The listing no longer shows as Sponsored. Refunds are done in the Paystack dashboard.'
      : r.state === 'ended' ? 'This promotion has ended by itself.'
      : 'Pausing hides the Sponsored label and placement. Removing ends it for good and does not refund the seller automatically.';
    $('#sheet').innerHTML = `<h2>${esc(r.product_name || 'Removed product')}</h2><p>${pill(r.state)}</p><dl class="kv">
      <dt>Store</dt><dd>${esc(r.seller_name || '-')}${r.seller_email ? '<br>' + esc(r.seller_email) : ''}</dd>
      <dt>Plan</dt><dd>${r.plan_days} days, ${naira(r.amount)}</dd>
      <dt>Paid</dt><dd>${r.paid_at ? date(r.paid_at) : '-'}</dd>
      <dt>Runs</dt><dd>${r.starts_at ? date(r.starts_at) : '-'} to ${r.ends_at ? date(r.ends_at) : '-'}</dd>
      <dt>Reference</dt><dd>${esc(r.reference)}</dd></dl>
      <p style="font-size:13px;margin-bottom:12px">${esc(hint)}</p>
      <div class="acts">${acts.map(a => `<button class="${a[2]}" data-pact="${a[0]}">${esc(a[1])}</button>`).join('')}<button class="btn" id="cls">Close</button></div>
      <p class="msg" id="smsg" role="alert"></p>`;
    $('#modal').hidden = false;
    $('#cls').onclick = close;
    document.querySelectorAll('[data-pact]').forEach(b => b.onclick = async () => {
      const act = b.dataset.pact;
      if (act === 'remove' && !confirm('Remove this promotion for good? The seller is not refunded automatically.')) return;
      b.disabled = true;
      try { await run('Saving…', () => api(`/api/admin/promotions/${r.id}/${act}`, { method: 'POST' })); close(); promotions(); }
      catch (e) { $('#smsg').textContent = e.message; b.disabled = false; }
    });
  }
})();
