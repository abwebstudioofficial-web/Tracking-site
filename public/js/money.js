// Transport Hub: alerts (the bell), invoices list and ratings (used by hub.js and loads.js).
window.HubMoney = (() => {
  const { sb } = Ibraya;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rs = (n) => 'Rs ' + Number(n || 0).toLocaleString('en-PK');
  const date = (t) => new Date(String(t).length === 10 ? t + 'T00:00:00' : t).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: 'numeric' });
  const ago = (t) => {
    const m = Math.round((Date.now() - new Date(t)) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
    return `${Math.round(m / 1440)} days ago`;
  };

  // "★ 4.8 (12) · 95% on time · 30 jobs", or "New on Transport Hub".
  function ratingText(r, { long = false } = {}) {
    if (!r) return '';
    const parts = [];
    if (r.reviews) parts.push(`<span class="stars-inline">★ ${Number(r.stars).toFixed(1)}</span> (${r.reviews})`);
    if (r.on_time != null) parts.push(`${r.on_time}% on time`);
    if (long || r.jobs) parts.push(`${r.jobs} ${r.jobs === 1 ? 'job' : 'jobs'} done`);
    return parts.length && (r.reviews || r.jobs) ? parts.join(' · ') : 'New on Transport Hub';
  }

  // ---------- the bell ----------
  const ICONS = { bid: '💬', won: '🏆', lost: '·', driver: '🚚', step: '📍', delivered: '✅', invoice: '🧾', payment: '💰', paid: '✅',
    rated: '⭐', verified: '✅', rejected: '⚠️', cancelled: '✖', fee: '🏷️', wallet: '💳' };
  let bell = null;
  let data = { unseen: 0, items: [] };
  let open = false;

  function initBell({ rpc, openLoad }) {
    bell = document.getElementById('bell');
    if (!bell) return;
    bell.hidden = false;
    const panel = document.createElement('div');
    panel.className = 'alerts-panel';
    panel.id = 'alerts-panel';
    panel.hidden = true;
    document.body.appendChild(panel);

    const paint = () => {
      const count = bell.querySelector('.bell-count');
      count.hidden = !data.unseen;
      count.textContent = data.unseen > 99 ? '99+' : data.unseen;
      bell.classList.toggle('ringing', data.unseen > 0);
      panel.innerHTML = `<div class="alerts-head"><b>Alerts · اطلاعات</b><button class="sheet-close" aria-label="Close">✕</button></div>
        <div class="alerts-list">${data.items.length ? data.items.map((n, i) => `
          <button class="alert-item ${i < highlight ? 'new' : ''}" data-load="${n.load_id || ''}" data-invoice="${n.invoice_id || ''}">
            <span class="alert-icon">${ICONS[n.kind] || '•'}</span>
            <span><b>${esc(n.title)}</b><small>${esc(n.body)}${n.body ? ' · ' : ''}${ago(n.created_at)}</small></span>
          </button>`).join('') : '<p class="muted" style="padding:14px">Nothing yet. New bids, bookings, deliveries and payments show up here.</p>'}</div>`;
      panel.querySelector('.sheet-close').addEventListener('click', close);
      panel.querySelectorAll('.alert-item').forEach((b) => b.addEventListener('click', () => {
        close();
        if (b.dataset.invoice) location.href = `/invoice?id=${encodeURIComponent(b.dataset.invoice)}`;
        else if (b.dataset.load) openLoad(b.dataset.load);
      }));
    };
    let highlight = 0; // how many of the newest items were unseen when the panel was opened
    const refresh = async () => {
      try {
        const before = data.items[0] && data.items[0].id;
        data = (await rpc('my_notifications')) || { unseen: 0, items: [] };
        if (open) highlight += Math.max(0, data.items.findIndex((n) => n.id === before));
        paint();
      } catch { /* keep the last list */ }
    };
    function close() {
      open = false;
      panel.hidden = true;
    }
    bell.addEventListener('click', async () => {
      if (open) return close();
      open = true;
      highlight = data.unseen;
      paint();
      panel.hidden = false;
      if (data.unseen) {
        await rpc('mark_notifications_seen').catch(() => {});
        data.unseen = 0;
        const count = bell.querySelector('.bell-count');
        count.hidden = true;
        bell.classList.remove('ringing');
      }
    });
    document.addEventListener('click', (e) => { if (open && !panel.contains(e.target) && !bell.contains(e.target)) close(); });
    sb.channel('alerts').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications' }, refresh).subscribe();
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
    refresh();
  }

  // ---------- invoices tab ----------
  const INV_STATUS = { unpaid: ['Unpaid', 'warn'], paid_reported: ['Payment reported', 'warn'], paid: ['Paid ✓', 'ok'] };
  const overdue = (i) => i.status !== 'paid' && new Date(i.due_date + 'T23:59:59') < new Date();

  const FEE_STATUS = { due: ['Due', 'warn'], paid: ['Paid ✓', 'ok'], waived: ['Waived', 'ok'] };
  function feeRows(items, admin) {
    return items.length ? items.map((f) => {
      const [label, cls] = FEE_STATUS[f.status];
      return `<div class="row">
        <div class="row-main"><b>${rs(f.amount)}</b> <span class="pill small ${cls}">${label}</span>${admin ? ` · <b>${esc(f.company.name)}</b>` : ''}
          <div class="muted small">${f.trips} trip${f.trips > 1 ? 's' : ''} × ${rs(f.fee_per_trip)} · ${esc(f.route)} · ${date(f.created_at)}${f.note ? ` · ${esc(f.note)}` : ''}</div></div>
        ${admin ? `<div class="row-actions">${f.status !== 'paid' ? `<button class="btn btn-small" data-fee="${f.id}" data-to="paid">Mark paid</button>` : ''}
          ${f.status === 'due' ? `<button class="btn btn-ghost btn-small" data-fee="${f.id}" data-to="waived">Waive</button>` : ''}
          ${f.status !== 'due' ? `<button class="btn btn-ghost btn-small" data-fee="${f.id}" data-to="due">Back to due</button>` : ''}</div>` : ''}
      </div>`;
    }).join('') : '<p class="muted">No fees yet. A fee is added when a load you carried is delivered.</p>';
  }

  async function renderInvoices(body, { rpc, kind }) {
    body.innerHTML = '<div class="panel-card"><p class="muted">Loading invoices…</p></div>';
    let d;
    let fees = null;
    try {
      d = await rpc('my_invoices');
      if (kind !== 'shipper') fees = await rpc('my_platform_fees');
    } catch (err) {
      body.innerHTML = `<div class="panel-card"><p class="error">${esc(Ibraya.friendlyError(err))}</p></div>`;
      return;
    }
    body.innerHTML = `
      <div class="money-cards">
        <div class="panel-card money"><small>To receive · وصول کرنا ہے</small><b>${rs(d.to_receive)}</b></div>
        <div class="panel-card money"><small>To pay · ادا کرنا ہے</small><b>${rs(d.to_pay)}</b></div>
        <div class="panel-card money ${d.overdue ? 'bad' : ''}"><small>Overdue</small><b>${d.overdue}</b></div>
      </div>
      <div class="panel-card">
        <h2>Invoices · انوائس</h2>
        <p class="muted small">An invoice is made automatically when a load is delivered: the carrier bills the shipper the booked price.</p>
        <div class="rows">${d.items.length ? d.items.map((i) => {
          const [label, cls] = INV_STATUS[i.status];
          return `<a class="row inv-row" href="/invoice?id=${encodeURIComponent(i.id)}">
            <div class="row-main"><b>${esc(i.number)}</b> <span class="pill small ${overdue(i) ? 'bad' : cls}">${overdue(i) ? 'Overdue' : label}</span>
              <div class="muted small">${i.direction === 'receivable' ? 'Bill to' : 'From'} ${esc(i.other)} · ${esc(i.route)} · due ${date(i.due_date)}</div></div>
            <div class="price ${i.direction === 'receivable' ? 'in' : 'out'}">${i.direction === 'receivable' ? '+' : '−'} ${rs(i.total)}</div>
          </a>`;
        }).join('') : '<p class="muted">No invoices yet. They appear here when your loads are delivered.</p>'}</div>
      </div>
      ${fees ? `<div class="panel-card fee-card">
        <div class="card-head"><h2>Transport Hub fees · کمیشن</h2><b>${rs(fees.due)} due</b></div>
        <p class="muted small">${rs(fees.fee_per_trip)} for each truck trip you deliver, taken from your Wallet on delivery.</p>
        <div class="rows">${feeRows(fees.items, false)}</div>
      </div>` : ''}`;
  }

  // ---------- platform admins: the fee per trip and what carriers owe ----------
  async function renderCommission(body, { rpc, busy }) {
    body.innerHTML = '<div class="panel-card"><p class="muted">Loading…</p></div>';
    let d;
    try { d = await rpc('admin_platform_fees'); } catch (err) {
      body.innerHTML = `<div class="panel-card"><p class="error">${esc(Ibraya.friendlyError(err))}</p></div>`;
      return;
    }
    const owed = {};
    d.items.filter((f) => f.status === 'due').forEach((f) => {
      const o = owed[f.company.id] || (owed[f.company.id] = { name: f.company.name, phone: f.company.phone, amount: 0, trips: 0 });
      o.amount += f.amount;
      o.trips += f.trips;
    });
    const owers = Object.values(owed).sort((a, b) => b.amount - a.amount);
    body.innerHTML = `
      <div class="money-cards">
        <div class="panel-card money"><small>Fee per trip</small><b>${rs(d.fee_per_trip)}</b></div>
        <div class="panel-card money"><small>Owed by carriers</small><b>${rs(d.due)}</b></div>
        <div class="panel-card money"><small>Collected</small><b>${rs(d.collected)}</b></div>
      </div>
      <div class="panel-card narrow">
        <h2>Change the fee · کمیشن تبدیل کریں</h2>
        <form class="fee-form" id="fee-form" novalidate>
          <input name="amount" class="select" type="number" min="0" max="1000000" step="100" inputmode="numeric" value="${d.fee_per_trip}">
          <span class="muted">Rs per truck trip</span>
          <button class="btn btn-small" id="fee-save">Save</button>
        </form>
        <p class="muted small">Carriers pay this for each truck trip they deliver. A new fee only applies to loads delivered after you change it.</p>
        <div class="error" id="fee-error"></div>
      </div>
      ${owers.length ? `<div class="panel-card"><h2>Who owes</h2><div class="rows">${owers.map((o) => `
        <div class="row"><div class="row-main"><b>${esc(o.name)}</b><div class="muted small">${o.trips} trip${o.trips > 1 ? 's' : ''}${o.phone ? ` · ${esc(o.phone.startsWith('+92') ? '0' + o.phone.slice(3) : o.phone)}` : ''}</div></div>
          <div class="price">${rs(o.amount)}</div></div>`).join('')}</div></div>` : ''}
      <div class="panel-card"><h2>All fees</h2><div class="rows" id="fee-list">${feeRows(d.items, true)}</div></div>
      <div class="panel-card narrow">
        <h2>Google map · گوگل نقشہ</h2>
        <p class="muted small">With a Google key, every map on Transport Hub uses Google's map (more streets and place names). Without one, or if Google stops working, our free map is used.</p>
        <form class="fee-form" id="gkey-form" novalidate>
          <input name="key" class="select" maxlength="60" autocomplete="off" spellcheck="false" placeholder="AIza…" value="">
          <button class="btn btn-small" id="gkey-save">Save</button>
        </form>
        <p class="muted small" id="gkey-now"></p>
        <div class="error" id="gkey-error"></div>
      </div>`;
    const gk = body.querySelector('#gkey-form');
    const showKey = (k) => {
      body.querySelector('#gkey-now').textContent = k ? `Google map is on (key …${k.slice(-6)}). Save an empty box to turn it off.` : 'Google map is off: our free map is used.';
    };
    rpc('map_config').then((c) => showKey(c.google_key)).catch(() => showKey(''));
    gk.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(body.querySelector('#gkey-save'), body.querySelector('#gkey-error'), async () => {
        const c = await rpc('admin_set_map_key', { p_key: gk.key.value.trim() });
        gk.key.value = '';
        showKey(c.google_key);
        await Ibraya.dialog({ title: 'Saved', message: 'Maps opened from now on use it.', cancel: false });
      });
    });
    const f = body.querySelector('#fee-form');
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(body.querySelector('#fee-save'), body.querySelector('#fee-error'), async () => {
        const amount = parseInt(f.amount.value, 10);
        if (Number.isNaN(amount) || amount < 0) throw new Error('Enter the fee in rupees');
        if (!(await Ibraya.dialog({ title: `Set the fee to ${rs(amount)} per trip?`, message: 'It applies to loads delivered from now on.', okText: 'Save' }))) return;
        await rpc('admin_set_fee', { p_amount: amount });
        await renderCommission(body, { rpc, busy });
      });
    });
    body.querySelectorAll('[data-fee]').forEach((b) => b.addEventListener('click', async () => {
      let note = '';
      if (b.dataset.to === 'paid') {
        note = await Ibraya.dialog({ title: 'Mark this fee as paid?', message: 'How was it paid? (optional)', okText: 'Mark paid', input: { placeholder: 'e.g. JazzCash TX123, cash' } });
        if (note == null) return;
      }
      busy(b, null, async () => {
        await rpc('admin_set_fee_status', { p_fee: b.dataset.fee, p_status: b.dataset.to, p_note: note });
        await renderCommission(body, { rpc, busy });
      });
    }));
  }

  // ---------- rating a delivered load (inside the load panel) ----------
  function ratingBlock(r) {
    if (!r) return '';
    const mine = r.mine;
    return `<section class="rate-box" id="rate-box">
      <h3>Rate ${esc(r.other)} · ریٹنگ دیں</h3>
      ${r.can_rate ? `<form id="rate-form" novalidate>
        <div class="star-pick" role="radiogroup">${[5, 4, 3, 2, 1].map((n) => `
          <label title="${n} star${n > 1 ? 's' : ''}"><input type="radio" name="stars" value="${n}" ${mine && mine.stars === n ? 'checked' : ''}><span>★</span></label>`).join('')}</div>
        <input name="comment" class="select" maxlength="300" placeholder="A few words (optional)" value="${esc(mine ? mine.comment : '')}">
        <div class="error" id="rate-error"></div>
        <div class="form-actions"><button class="btn btn-small" id="rate-submit">${mine ? 'Update rating' : 'Save rating'}</button></div>
      </form>` : mine ? `<p>${'★'.repeat(mine.stars)} ${esc(mine.comment)}</p>` : ''}
      ${r.theirs ? `<p class="muted small">${esc(r.other)} rated you <span class="stars-inline">${'★'.repeat(r.theirs.stars)}</span>${r.theirs.comment ? `: “${esc(r.theirs.comment)}”` : ''}</p>` : ''}
    </section>`;
  }
  function wireRating(root, loadId, { rpc, busy, after }) {
    const f = root.querySelector('#rate-form');
    if (!f) return;
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(root.querySelector('#rate-submit'), root.querySelector('#rate-error'), async () => {
        const stars = f.querySelector('[name=stars]:checked');
        if (!stars) throw new Error('Tap the stars to choose 1 to 5');
        after(await rpc('rate_load', { p_load: loadId, p_stars: Number(stars.value), p_comment: f.comment.value }));
      });
    });
  }

  return { ratingText, initBell, renderInvoices, renderCommission, ratingBlock, wireRating };
})();
