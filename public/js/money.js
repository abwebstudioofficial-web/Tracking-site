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
    rated: '⭐', verified: '✅', rejected: '⚠️', cancelled: '✖' };
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

  async function renderInvoices(body, { rpc }) {
    body.innerHTML = '<div class="panel-card"><p class="muted">Loading invoices…</p></div>';
    let d;
    try { d = await rpc('my_invoices'); } catch (err) {
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
      </div>`;
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

  return { ratingText, initBell, renderInvoices, ratingBlock, wireRating };
})();
