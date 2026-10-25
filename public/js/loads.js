// Transport Hub load board (used by hub.js).
// Shippers and brokers post loads; carriers, brokers and dispatchers bid. Bids are open: every
// verified company sees the prices on an open load. The poster books one, then both see contacts.
window.HubLoads = (() => {
  const { sb } = Ibraya;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rs = (n) => (n == null ? '' : 'Rs ' + Number(n).toLocaleString('en-PK'));
  const day = (d) => new Date(d + (String(d).length === 10 ? 'T00:00:00' : '')).toLocaleDateString('en-PK', { weekday: 'short', day: 'numeric', month: 'short' });
  const ago = (t) => {
    const m = Math.round((Date.now() - new Date(t)) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
    return `${Math.round(m / 1440)} days ago`;
  };
  const localPhone = (p) => (p && p.startsWith('+92') ? '0' + p.slice(3) : p || '');

  const TRADE = { import: 'Import · امپورٹ', export: 'Export · ایکسپورٹ', domestic: 'Domestic · اندرون ملک' };
  const TRADE_SHORT = { import: 'Import', export: 'Export', domestic: 'Domestic' };
  const EQUIPMENT = {
    container_20: '20ft container', container_40: '40ft container', flatbed: 'Flatbed / trailer',
    open_body: 'Open body truck', covered: 'Covered / box truck', other: 'Other',
  };
  const LOAD_STATUS = {
    open: ['Open for bids', 'ok'], booked: ['Booked', 'warn'], delivered: ['Delivered ✓', 'ok'], cancelled: ['Cancelled', 'bad'],
  };
  const BID_STATUS = { active: 'Your bid', accepted: 'Won ✓', declined: 'Not chosen', withdrawn: 'Withdrawn' };
  // Ports and dry ports for import/export loads, plus the main cities.
  const PLACES = ['KICT (Karachi International Container Terminal)', 'QICT (Qasim International Container Terminal)',
    'SAPT (South Asia Pakistan Terminals)', 'Karachi Port (East Wharf)', 'Karachi Port (West Wharf)', 'Port Qasim',
    'Gwadar Port', 'Lahore Dry Port (Mughalpura)', 'Sialkot Dry Port', 'Faisalabad Dry Port', 'Multan Dry Port',
    'Peshawar Dry Port', 'Quetta Dry Port', 'Islamabad Dry Port'];
  const CITIES = ['Karachi', 'Port Qasim', 'Lahore', 'Islamabad', 'Rawalpindi', 'Faisalabad', 'Multan', 'Hyderabad',
    'Peshawar', 'Quetta', 'Sialkot', 'Gujranwala', 'Sukkur', 'Gwadar', 'Bahawalpur', 'Sargodha', 'Sheikhupura', 'Kasur',
    'Rahim Yar Khan', 'Dera Ghazi Khan', 'Abbottabad', 'Mardan', 'Nowshera', 'Gujrat', 'Jhelum', 'Sahiwal', 'Okara'];

  const canPost = (c) => c.kind === 'shipper' || c.kind === 'broker';
  const canBid = (c) => c.kind !== 'shipper';

  // Tabs this company gets, in order, and which one opens first.
  function tabs(company, role) {
    if (!company || role === 'driver') return [];
    const t = [];
    if (canBid(company)) t.push(['board', 'Load board']);
    if (canPost(company)) t.push(['post', 'Post a load'], ['myloads', 'My loads']);
    if (canBid(company)) t.push(['mybids', 'My bids']);
    return t;
  }
  const firstTab = (company) => (canBid(company) ? 'board' : 'myloads');

  let ctx = null; // { state, body, busy, rpc, rerender }
  let filters = { trade: '', equipment: '', from: '', to: '' };
  let openLoad = null;
  let live = null;
  let refreshTimer = null;
  let tripsTimer = null;
  let feePerTrip = null; // Transport Hub's fee, shown to carriers before they bid
  let tripsMap = null;

  function route(l) {
    const place = (p) => (p ? `<small>${esc(p)}</small>` : '');
    return `<div class="route"><span><b>${esc(l.pickup_city)}</b>${place(l.pickup_place)}</span><span class="arrow">→</span><span><b>${esc(l.drop_city)}</b>${place(l.drop_place)}</span></div>`;
  }
  function loadCard(l, show = 'board') {
    const [label, cls] = LOAD_STATUS[l.status];
    const facts = [EQUIPMENT[l.equipment], l.trucks > 1 ? `${l.trucks} trucks` : '1 truck', l.weight_tons ? `${Number(l.weight_tons)} t` : '', l.cargo].filter(Boolean).map(esc).join(' · ');
    let right = '';
    if (l.status === 'open') {
      right = `<div class="price">${l.lowest ? `<small>Lowest bid</small>${rs(l.lowest)}` : l.target_price ? `<small>Target</small>${rs(l.target_price)}` : '<small>No bids yet</small>'}</div>
        ${l.bids ? `<div class="muted small">${l.bids} ${l.bids === 1 ? 'bid' : 'bids'}${l.target_price ? ` · target ${rs(l.target_price)}` : ''}</div>` : ''}`;
    } else if (l.booked_amount) {
      right = `<div class="price"><small>${esc(l.booked_with || '')}</small>${rs(l.booked_amount)}</div>`;
    }
    const mine = l.my_bid ? `<span class="pill small ${l.my_bid.status === 'accepted' ? 'ok' : l.my_bid.status === 'active' ? 'warn' : 'bad'}">${BID_STATUS[l.my_bid.status]}${l.my_bid.status === 'active' || l.my_bid.status === 'accepted' ? ': ' + rs(l.my_bid.amount) : ''}</span>` : '';
    return `<button class="load-card" data-load="${l.id}">
        <div class="load-top"><span class="tag ${l.trade}">${TRADE_SHORT[l.trade]}</span><span class="muted small">Pickup ${day(l.pickup_date)}</span>
          ${show === 'board' ? '' : `<span class="pill small ${cls}">${label}</span>`}</div>
        <div class="load-body"><div class="load-main">${route(l)}<div class="muted small">${facts}</div>
          <div class="muted small">${l.mine ? 'Your load' : `${esc(l.poster.name)} <span class="rating">${HubMoney.ratingText(l.poster.rating)}</span>`} · posted ${ago(l.created_at)}</div>${mine}</div>
          <div class="load-side">${right}</div></div>
      </button>`;
  }
  function wireCards(root) {
    root.querySelectorAll('[data-load]').forEach((b) => b.addEventListener('click', () => openDetail(b.dataset.load)));
  }

  // ---------- board ----------
  async function renderBoard() {
    const body = ctx.body;
    body.innerHTML = `
      <div class="panel-card">
        <div class="card-head"><h2>Open loads · دستیاب لوڈ</h2><button class="btn btn-ghost btn-small" id="board-refresh">↻ Refresh</button></div>
        <form class="filters" id="filters">
          <select name="trade" class="select"><option value="">All trades</option>${Object.entries(TRADE_SHORT).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
          <select name="equipment" class="select"><option value="">Any truck</option>${Object.entries(EQUIPMENT).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
          <input name="from" class="select" placeholder="From city" list="lb-cities" value="${esc(filters.from)}">
          <input name="to" class="select" placeholder="To city" list="lb-cities" value="${esc(filters.to)}">
          <datalist id="lb-cities">${CITIES.map((x) => `<option value="${x}">`).join('')}</datalist>
        </form>
        <div class="load-list" id="board-list"><p class="muted">Loading…</p></div>
      </div>`;
    const f = body.querySelector('#filters');
    f.trade.value = filters.trade;
    f.equipment.value = filters.equipment;
    let t = null;
    const apply = () => { filters = { trade: f.trade.value, equipment: f.equipment.value, from: f.from.value.trim(), to: f.to.value.trim() }; fillBoard(); };
    f.addEventListener('change', apply);
    f.addEventListener('input', () => { clearTimeout(t); t = setTimeout(apply, 400); });
    f.addEventListener('submit', (e) => { e.preventDefault(); apply(); });
    body.querySelector('#board-refresh').addEventListener('click', fillBoard);
    await fillBoard();
  }
  async function fillBoard() {
    const list = document.getElementById('board-list');
    if (!list) return;
    try {
      const loads = await ctx.rpc('load_board', {
        p_trade: filters.trade || null, p_equipment: filters.equipment || null, p_from: filters.from || null, p_to: filters.to || null,
      });
      if (!document.getElementById('board-list')) return;
      list.innerHTML = loads.length ? loads.map((l) => loadCard(l)).join('')
        : '<p class="muted">No open loads match. New loads show up here as soon as they are posted.</p>';
      wireCards(list);
    } catch (err) {
      list.innerHTML = `<p class="error">${esc(Ibraya.friendlyError(err))}</p>`;
    }
  }

  // ---------- my loads / my bids ----------
  async function renderList(kind) {
    const body = ctx.body;
    body.innerHTML = `<div class="panel-card"><div class="card-head"><h2>${kind === 'myloads' ? 'Loads you posted' : 'Loads you bid on'}</h2></div><div class="load-list" id="my-list"><p class="muted">Loading…</p></div></div>`;
    await fillList(kind);
  }
  async function fillList(kind) {
    const list = document.getElementById('my-list');
    if (!list) return;
    try {
      const loads = await ctx.rpc(kind === 'myloads' ? 'my_loads' : 'my_bids');
      if (!document.getElementById('my-list')) return;
      list.innerHTML = loads.length ? loads.map((l) => loadCard(l, kind)).join('')
        : `<p class="muted">${kind === 'myloads' ? 'You haven\'t posted a load yet. Use "Post a load".' : 'You haven\'t bid on a load yet. Find one on the load board.'}</p>`;
      wireCards(list);
    } catch (err) {
      list.innerHTML = `<p class="error">${esc(Ibraya.friendlyError(err))}</p>`;
    }
  }

  // ---------- post a load ----------
  function renderPost() {
    const body = ctx.body;
    const today = new Date();
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const max = new Date(today.getTime() + 90 * 864e5);
    body.innerHTML = `
      <div class="panel-card narrow">
        <h2>Post a load · لوڈ پوسٹ کریں</h2>
        <p class="muted">Verified carriers see it at once and send their prices. You compare the bids and book one.</p>
        <form id="post-form" novalidate>
          <div class="field"><span>Type · قسم</span><div class="seg">${Object.entries(TRADE).map(([k, v], i) => `
            <label><input type="radio" name="trade" value="${k}" ${i === 0 ? 'checked' : ''}><span>${v}</span></label>`).join('')}</div></div>
          <div class="field-pair">
            <label class="field"><span>From city · کہاں سے</span><input name="pickup_city" list="pl-cities" maxlength="60" placeholder="e.g. Karachi"></label>
            <label class="field"><span>Pickup place <i>(port, factory…)</i></span><input name="pickup_place" list="pl-places" maxlength="120" placeholder="e.g. KICT"></label>
            <label class="field"><span>To city · کہاں تک</span><input name="drop_city" list="pl-cities" maxlength="60" placeholder="e.g. Lahore"></label>
            <label class="field"><span>Drop place <i>(optional)</i></span><input name="drop_place" list="pl-places" maxlength="120" placeholder="e.g. Lahore Dry Port"></label>
          </div>
          <datalist id="pl-cities">${CITIES.map((x) => `<option value="${x}">`).join('')}</datalist>
          <datalist id="pl-places">${PLACES.map((x) => `<option value="${x}">`).join('')}</datalist>
          <div class="field-pair">
            <label class="field"><span>Pickup date · تاریخ</span><input name="pickup_date" type="date" min="${iso(today)}" max="${iso(max)}" value="${iso(new Date(today.getTime() + 864e5))}"></label>
            <label class="field"><span>Truck needed · ٹرک</span><select name="equipment" class="select">${Object.entries(EQUIPMENT).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
            <label class="field"><span>How many trucks</span><input name="trucks" type="number" min="1" max="50" value="1" inputmode="numeric"></label>
            <label class="field"><span>Weight (tons) <i>(optional)</i></span><input name="weight" type="number" min="0" max="500" step="0.5" inputmode="decimal"></label>
          </div>
          <label class="field"><span>Cargo · سامان</span><input name="cargo" maxlength="120" placeholder="e.g. Cotton yarn, 1,200 bags"></label>
          <label class="field" id="container-field"><span>Container / BL number <i>(optional)</i></span><input name="container_no" maxlength="60"></label>
          <label class="field"><span>Your target price, total (Rs) <i>(optional)</i> · متوقع کرایہ</span><input name="target" type="number" min="1000" step="500" inputmode="numeric" placeholder="e.g. 180000"></label>
          <label class="field"><span>Notes <i>(optional)</i></span><input name="notes" maxlength="500" placeholder="Loading time, labour, special care…"></label>
          <div class="error" id="post-error"></div>
          <button class="btn" id="post-submit">Post load · لوڈ پوسٹ کریں</button>
        </form>
      </div>`;
    const f = body.querySelector('#post-form');
    const containerField = body.querySelector('#container-field');
    const sync = () => { containerField.hidden = f.trade.value === 'domestic'; };
    f.querySelectorAll('[name=trade]').forEach((r) => r.addEventListener('change', sync));
    sync();
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      ctx.busy(body.querySelector('#post-submit'), body.querySelector('#post-error'), async () => {
        if (f.pickup_city.value.trim().length < 2) throw new Error('Enter the pickup city · کہاں سے');
        if (f.drop_city.value.trim().length < 2) throw new Error('Enter the destination city · کہاں تک');
        if (!f.pickup_date.value) throw new Error('Choose the pickup date');
        const target = f.target.value ? parseInt(f.target.value, 10) : null;
        if (target != null && target < 1000) throw new Error('Target price is in rupees, at least Rs 1,000');
        const id = await ctx.rpc('post_load', {
          p_trade: f.trade.value, p_pickup_city: f.pickup_city.value, p_pickup_place: f.pickup_place.value,
          p_drop_city: f.drop_city.value, p_drop_place: f.drop_place.value, p_pickup_date: f.pickup_date.value,
          p_equipment: f.equipment.value, p_trucks: Math.max(1, Math.min(50, parseInt(f.trucks.value, 10) || 1)),
          p_weight_tons: f.weight.value ? Number(f.weight.value) : null, p_cargo: f.cargo.value,
          p_container_no: f.trade.value === 'domestic' ? '' : f.container_no.value,
          p_target_price: target, p_notes: f.notes.value,
        });
        ctx.go('myloads');
        openDetail(id);
      });
    });
  }

  // ---------- one load: details, open bids, bid / book ----------
  function closeDetail() {
    openLoad = null;
    clearTimeout(tripsTimer);
    if (tripsMap) { tripsMap.remove(); tripsMap = null; }
    const s = document.getElementById('load-sheet');
    if (s) s.remove();
    document.body.classList.remove('sheet-open');
  }
  async function openDetail(id) {
    openLoad = id;
    let sheet = document.getElementById('load-sheet');
    if (!sheet) {
      sheet = document.createElement('div');
      sheet.id = 'load-sheet';
      sheet.className = 'sheet-backdrop';
      sheet.innerHTML = '<div class="sheet" role="dialog" aria-modal="true"><div class="sheet-body"><p class="muted">Loading…</p></div></div>';
      sheet.addEventListener('click', (e) => { if (e.target === sheet) closeDetail(); });
      document.body.appendChild(sheet);
      document.body.classList.add('sheet-open');
    }
    try {
      renderDetail(await ctx.rpc('load_detail', { p_load: id }));
    } catch (err) {
      sheet.querySelector('.sheet-body').innerHTML = `<button class="sheet-close" aria-label="Close">✕</button><p class="error">${esc(Ibraya.friendlyError(err))}</p>`;
      sheet.querySelector('.sheet-close').addEventListener('click', closeDetail);
    }
  }
  function renderDetail(d) {
    const sheet = document.getElementById('load-sheet');
    if (!sheet || !d || d.load.id !== openLoad) return;
    const l = d.load;
    const [label, cls] = LOAD_STATUS[l.status];
    const myBid = d.bids.find((b) => b.mine);
    const rows = [
      ['Type', TRADE[l.trade]], ['Pickup date', day(l.pickup_date)], ['Truck', EQUIPMENT[l.equipment] + (l.trucks > 1 ? ` × ${l.trucks}` : '')],
      ['Weight', l.weight_tons ? `${Number(l.weight_tons)} tons` : ''], ['Cargo', l.cargo], ['Container / BL', d.details.container_no],
      ['Target price', rs(l.target_price)], ['Notes', d.details.notes], ['Posted by', l.mine ? 'Your company' : `${l.poster.name}, ${l.poster.city}`],
    ].filter(([, v]) => v);
    const bidRow = (b) => `
      <div class="row bid ${b.mine ? 'mine' : ''} ${b.status}">
        <div class="row-main"><b>${rs(b.amount)}</b> <span class="muted">· ${esc(b.company.name)}${b.mine ? ' (you)' : ''}</span>
          ${b.status === 'accepted' ? ' <span class="pill small ok">Booked</span>' : b.status !== 'active' ? ` <span class="pill small bad">${BID_STATUS[b.status]}</span>` : ''}
          <div class="muted small">${esc(Ibraya.COMPANY_KINDS[b.company.kind].en)} · ${esc(b.company.city)}${b.company.fleet_size ? ` · ${b.company.fleet_size} trucks` : ''} · ${ago(b.updated_at)}${b.note ? ` · “${esc(b.note)}”` : ''}</div>
          <div class="small rating">${HubMoney.ratingText(b.company.rating)}</div></div>
        ${d.can_manage && l.status === 'open' && b.status === 'active' ? `<div class="row-actions"><button class="btn btn-small" data-accept="${b.id}" data-amount="${b.amount}" data-name="${esc(b.company.name)}">Book · بک کریں</button></div>` : ''}
      </div>`;
    const c = d.contact;
    sheet.querySelector('.sheet-body').innerHTML = `
      <button class="sheet-close" aria-label="Close">✕</button>
      <div class="load-top"><span class="tag ${l.trade}">${TRADE_SHORT[l.trade]}</span><span class="pill small ${cls}">${label}</span></div>
      <h2 class="sheet-title">${route(l)}</h2>
      <dl class="details">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      ${c ? `<div class="contact-card"><b>${l.mine ? 'Carrier' : 'Shipper'}: ${esc(c.company)}</b>
          <div>${esc(c.person || '')} ${c.person_phone ? `· <a href="tel:${esc(c.person_phone)}">${esc(localPhone(c.person_phone))}</a>` : ''}</div>
          ${c.phone && c.phone !== c.person_phone ? `<div>Office: <a href="tel:${esc(c.phone)}">${esc(localPhone(c.phone))}</a></div>` : ''}
          ${c.person_phone ? `<a class="btn btn-small wa" target="_blank" rel="noopener" href="https://wa.me/${esc(c.person_phone.replace(/\D/g, ''))}">WhatsApp</a>` : ''}</div>` : ''}
      ${d.invoice_id ? `<a class="btn btn-small invoice-link" href="/invoice?id=${encodeURIComponent(d.invoice_id)}">🧾 Open invoice</a>` : ''}
      ${HubMoney.ratingBlock(d.rating)}
      ${(l.status === 'booked' || l.status === 'delivered') && (l.mine || (myBid && myBid.status === 'accepted')) ? '<section class="trucks" id="trucks"><h3>Trucks · ٹرک</h3><p class="muted">Loading…</p></section>' : ''}
      ${d.can_bid ? `
        <form id="bid-form" class="bid-form" novalidate>
          <h3>${myBid && myBid.status === 'active' ? 'Change your bid' : 'Your price for this load'} · آپ کا کرایہ</h3>
          <div class="field-pair">
            <label class="field"><span>Total price (Rs)${l.trucks > 1 ? ` for all ${l.trucks} trucks` : ''}</span><input name="amount" type="number" min="1000" step="500" inputmode="numeric" value="${myBid && myBid.status === 'active' ? myBid.amount : ''}" placeholder="${l.lowest ? `Lowest now ${l.lowest}` : 'e.g. 175000'}"></label>
            <label class="field"><span>Note <i>(optional)</i></span><input name="note" maxlength="300" value="${myBid && myBid.status === 'active' ? esc(myBid.note) : ''}" placeholder="e.g. Truck ready in Karachi"></label>
          </div>
          ${feePerTrip ? `<p class="muted small">Transport Hub fee: ${rs(feePerTrip)} per truck trip${l.trucks > 1 ? ` (${rs(feePerTrip * l.trucks)} for ${l.trucks} trucks)` : ''}, charged to the carrier after delivery.</p>` : ''}
          <div class="error" id="bid-error"></div>
          <div class="form-actions">
            ${myBid && myBid.status === 'active' ? '<button type="button" class="btn btn-ghost btn-small" id="withdraw">Withdraw bid</button>' : ''}
            <button class="btn btn-small" id="bid-submit">${myBid && myBid.status === 'active' ? 'Update bid' : 'Place bid · بولی لگائیں'}</button>
          </div>
        </form>` : ''}
      <h3>Bids${l.status === 'open' ? ` (${d.bids.filter((b) => b.status === 'active').length}) · everyone can see these prices` : ''}</h3>
      <div class="rows">${d.bids.length ? d.bids.map(bidRow).join('') : '<p class="muted">No bids yet.</p>'}</div>
      ${d.can_manage && (l.status === 'open' || l.status === 'booked') ? `<div class="form-actions">
          ${l.status === 'booked' ? '<button class="btn btn-small" id="delivered">Mark delivered ✓</button>' : ''}
          <button class="btn btn-ghost btn-small" id="cancel-load">Cancel load</button></div>` : ''}`;
    const s = sheet.querySelector('.sheet-body');
    s.querySelector('.sheet-close').addEventListener('click', closeDetail);
    if (tripsMap) { tripsMap.remove(); tripsMap = null; }
    if (s.querySelector('#trucks')) renderTrucks(l.id);
    HubMoney.wireRating(s, l.id, { rpc: ctx.rpc, busy: ctx.busy, after: renderDetail });
    const bf = s.querySelector('#bid-form');
    if (bf) {
      bf.addEventListener('submit', (e) => {
        e.preventDefault();
        ctx.busy(s.querySelector('#bid-submit'), s.querySelector('#bid-error'), async () => {
          const amount = parseInt(bf.amount.value, 10);
          if (!amount || amount < 1000) throw new Error('Enter your total price in rupees · کرایہ لکھیں');
          renderDetail(await ctx.rpc('place_bid', { p_load: l.id, p_amount: amount, p_note: bf.note.value }));
        });
      });
      const w = s.querySelector('#withdraw');
      if (w) w.addEventListener('click', async () => {
        if (!(await Ibraya.dialog({ title: 'Withdraw your bid?', okText: 'Withdraw', danger: true }))) return;
        ctx.busy(w, s.querySelector('#bid-error'), async () => renderDetail(await ctx.rpc('withdraw_bid', { p_load: l.id })));
      });
    }
    s.querySelectorAll('[data-accept]').forEach((b) => b.addEventListener('click', async () => {
      const ok = await Ibraya.dialog({
        title: `Book ${b.dataset.name}?`,
        message: `For ${rs(b.dataset.amount)}. The other bids are declined, and you both see each other's phone number.`,
        okText: 'Book',
      });
      if (!ok) return;
      ctx.busy(b, null, async () => renderDetail(await ctx.rpc('accept_bid', { p_bid: b.dataset.accept })));
    }));
    const del = s.querySelector('#delivered');
    if (del) del.addEventListener('click', async () => {
      if (!(await Ibraya.dialog({ title: 'Mark as delivered?', okText: 'Delivered' }))) return;
      ctx.busy(del, null, async () => renderDetail(await ctx.rpc('set_load_status', { p_load: l.id, p_status: 'delivered' })));
    });
    const cancel = s.querySelector('#cancel-load');
    if (cancel) cancel.addEventListener('click', async () => {
      if (!(await Ibraya.dialog({ title: 'Cancel this load?', message: 'Carriers can no longer bid. A booked carrier is told it\'s cancelled.', okText: 'Cancel load', cancelText: 'Keep it', danger: true }))) return;
      ctx.busy(cancel, null, async () => renderDetail(await ctx.rpc('set_load_status', { p_load: l.id, p_status: 'cancelled' })));
    });
  }

  // ---------- trucks on a booked load: assign drivers, follow them, proof of delivery ----------
  const ACTIVE = ['assigned', 'at_pickup', 'loaded', 'at_drop'];
  const TRIP_STATUS = {
    assigned: ['Going to pickup', 'warn'], at_pickup: ['At pickup', 'warn'], loaded: ['Loaded, on the way', 'warn'],
    at_drop: ['At destination', 'warn'], delivered: ['Delivered ✓', 'ok'],
  };
  const TRIP_STEPS = [['at_pickup', 'Pickup'], ['loaded', 'Loaded'], ['at_drop', 'Arrived'], ['delivered', 'Delivered']];
  // The next step the carrier's office can mark for a truck (the driver does the same in the app).
  const NEXT_STEP = {
    assigned: ['at_pickup', 'Mark at pickup · پک اپ پر'], at_pickup: ['loaded', 'Mark loaded · لوڈ ہو گیا'],
    loaded: ['at_drop', 'Mark arrived · پہنچ گیا'], at_drop: ['delivered', 'Mark delivered (bilty photo) · ڈیلیور'],
  };
  const time = (t) => new Date(t).toLocaleString('en-PK', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const mapsAt = (lat, lng) => `https://www.google.com/maps?q=${lat},${lng}`;

  function tripRow(t, canAssign) {
    const [label, cls] = TRIP_STATUS[t.status];
    const loc = t.location;
    const seen = loc && loc.at ? ago(loc.at) : '';
    return `<div class="row trip">
      <div class="row-main"><b>${esc(t.driver.name)}</b> <span class="pill small ${cls}">${label}</span>
        <div class="muted small"><a href="tel:${esc(t.driver.phone)}">${esc(localPhone(t.driver.phone))}</a>${loc ? ` · last seen ${seen} · <a target="_blank" rel="noopener" href="${mapsAt(loc.lat, loc.lng)}">on map</a>${loc.problem ? ' · ⚠ tracking problem' : ''}` : ''}</div>
        <div class="trip-steps">${TRIP_STEPS.map(([k, v]) => {
          const st = t.steps[k];
          return `<span class="${st ? 'done' : ''}">${v}${st ? `<small>${time(st.at)}${st.by === 'office' ? ' · by office' : ''}${st.lat != null ? ` · <a target="_blank" rel="noopener" href="${mapsAt(st.lat, st.lng)}">where</a>` : ' · no GPS'}</small>` : ''}</span>`;
        }).join('')}</div></div>
      <div class="row-actions">
        ${canAssign && NEXT_STEP[t.status] ? `<button class="btn btn-small" data-step="${NEXT_STEP[t.status][0]}" data-trip="${t.id}" data-load="${t.load_id}" data-name="${esc(t.driver.name)}">${NEXT_STEP[t.status][1]}</button>` : ''}
        ${t.has_pod ? `<button class="btn btn-ghost btn-small" data-pod="${esc(t.pod_path)}">Bilty photo</button>` : ''}
        ${canAssign && (t.status === 'assigned' || t.status === 'at_pickup') ? `<button class="btn btn-ghost btn-small" data-unassign="${t.id}" data-name="${esc(t.driver.name)}">Remove</button>` : ''}
      </div>
    </div>`;
  }

  async function renderTrucks(loadId) {
    clearTimeout(tripsTimer);
    const el = document.getElementById('trucks');
    if (!el) return;
    let d;
    try { d = await ctx.rpc('load_trips', { p_load: loadId }); } catch (err) {
      el.innerHTML = `<h3>Trucks</h3><p class="error">${esc(Ibraya.friendlyError(err))}</p>`;
      return;
    }
    if (openLoad !== loadId || !document.getElementById('trucks')) return;
    const active = d.trips.filter((t) => ACTIVE.includes(t.status));
    const free = (d.drivers || []).filter((x) => !x.busy);
    if (!el.querySelector('#trucks-list')) {
      el.innerHTML = `<h3>Trucks · ٹرک <span id="trucks-count"></span></h3>
        <div class="trip-map" id="trip-map" hidden></div><div class="rows" id="trucks-list"></div><div id="assign-box"></div>`;
    }
    el.querySelector('#trucks-count').textContent = `(${d.trips.length} of ${d.trucks})`;
    const list = el.querySelector('#trucks-list');
    list.innerHTML = d.trips.length ? d.trips.map((t) => tripRow(t, d.can_assign)).join('')
      : `<p class="muted">${d.can_assign ? 'Assign a driver from your team for each truck.' : 'The carrier hasn\'t assigned a driver yet.'}</p>`;
    const assign = el.querySelector('#assign-box');
    assign.innerHTML = d.can_assign && d.trips.length < d.trucks ? (d.drivers.length ? `
      <form class="assign-form" id="assign-form">
        <select name="driver" class="select">${free.length ? free.map((x) => `<option value="${x.id}">${esc(x.name)} · ${esc(localPhone(x.phone))}</option>`).join('') : '<option value="">All your drivers are on other jobs</option>'}
          ${d.drivers.filter((x) => x.busy).map((x) => `<option disabled>${esc(x.name)} (on another job)</option>`).join('')}</select>
        <button class="btn btn-small" ${free.length ? '' : 'disabled'}>Assign driver</button>
      </form><div class="error" id="assign-error"></div>`
      : '<p class="muted">Add drivers to your company first (Team tab), then assign them here.</p>')
      : d.trips.length && !d.can_assign ? '<p class="muted small">Pickup, Loaded and Arrived are marked by the driver in the app (or by the carrier\'s office). You get an alert at each step.</p>' : '';
    const af = assign.querySelector('#assign-form');
    if (af) af.addEventListener('submit', (e) => {
      e.preventDefault();
      ctx.busy(af.querySelector('button'), assign.querySelector('#assign-error'), async () => {
        await ctx.rpc('assign_driver', { p_load: loadId, p_driver: af.driver.value });
        await renderTrucks(loadId);
      });
    });
    list.querySelectorAll('[data-unassign]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await Ibraya.dialog({ title: `Take ${b.dataset.name} off this job?`, okText: 'Remove', danger: true }))) return;
      ctx.busy(b, null, async () => { await ctx.rpc('unassign_trip', { p_trip: b.dataset.unassign }); await renderTrucks(loadId); });
    }));
    // The office marks the next step for a truck; "delivered" asks for the bilty / receipt photo.
    list.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', async () => {
      const { step, trip, load, name } = b.dataset;
      if (step !== 'delivered') {
        const label = { at_pickup: 'at pickup', loaded: 'loaded', at_drop: 'arrived at the destination' }[step];
        if (!(await Ibraya.dialog({ title: `${name}'s truck is ${label}?`, message: 'The shipper sees this straight away. Normally the driver marks it in the app.', okText: 'Yes, mark it' }))) return;
        return ctx.busy(b, null, async () => { await ctx.rpc('trip_step', { p_trip: trip, p_step: step }); await renderTrucks(loadId); });
      }
      const pick = document.createElement('input');
      pick.type = 'file';
      pick.accept = 'image/*,application/pdf';
      pick.addEventListener('change', () => {
        const file = pick.files[0];
        if (!file) return;
        ctx.busy(b, null, async () => {
          const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'jpg';
          const path = `${load}/${trip}-${Date.now()}.${ext}`;
          const up = await sb.storage.from('trip-pod').upload(path, file, { contentType: file.type || undefined });
          if (up.error) throw up.error;
          await ctx.rpc('trip_step', { p_trip: trip, p_step: 'delivered', p_pod_path: path });
          await renderTrucks(loadId);
        });
      });
      if (await Ibraya.dialog({ title: `Mark ${name}'s truck delivered?`, message: 'Choose a photo of the signed bilty / receipt. The shipper can see it.', okText: 'Choose photo' })) pick.click();
    }));
    list.querySelectorAll('[data-pod]').forEach((b) => b.addEventListener('click', () => ctx.busy(b, null, async () => {
      const win = window.open('', '_blank');
      const { data, error } = await sb.storage.from('trip-pod').createSignedUrl(b.dataset.pod, 300);
      if (error) { if (win) win.close(); throw error; }
      if (win) win.location = data.signedUrl; else location.href = data.signedUrl;
    })));
    drawTripMap(active.filter((t) => t.location));
    // While trucks are on the road, keep their positions fresh.
    if (active.length) tripsTimer = setTimeout(() => renderTrucks(loadId), 20000);
  }

  function drawTripMap(trips) {
    const box = document.getElementById('trip-map');
    if (!box || !window.L) return;
    box.hidden = !trips.length;
    if (!trips.length) return;
    if (!tripsMap) {
      tripsMap = L.map(box, { zoomControl: true, attributionControl: true });
      GoogleMap.leafletLayer(L, tripsMap); // Google's map, or OpenStreetMap as the backup
      tripsMap._ibLayer = L.layerGroup().addTo(tripsMap);
      tripsMap._ibFitted = false;
    }
    const layer = tripsMap._ibLayer;
    layer.clearLayers();
    const pts = trips.map((t) => {
      const p = [t.location.lat, t.location.lng];
      L.marker(p, { icon: L.divIcon({ className: 'trip-pin', html: `<span>🚚 ${esc(t.driver.name)}</span>`, iconSize: null }) }).addTo(layer);
      return p;
    });
    if (!tripsMap._ibFitted) {
      if (pts.length === 1) tripsMap.setView(pts[0], 12); else tripsMap.fitBounds(pts, { padding: [30, 30] });
      tripsMap._ibFitted = true;
    }
    setTimeout(() => tripsMap && tripsMap.invalidateSize(), 50);
  }

  // Live: a new load or bid anywhere I can see refreshes the open list and load.
  function listen() {
    if (live) return;
    const changed = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        if (document.getElementById('board-list')) fillBoard();
        const my = document.getElementById('my-list');
        if (my) fillList(ctx.tab);
        if (openLoad && !document.querySelector('#load-sheet input:focus')) openDetail(openLoad);
      }, 600);
    };
    live = sb.channel('loads')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'loads' }, changed)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bids' }, changed)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'trips' }, () => { if (openLoad && document.getElementById('trucks')) renderTrucks(openLoad); })
      .subscribe();
  }

  function loadFee() {
    if (feePerTrip == null && ctx) ctx.rpc('platform_fee').then((v) => { feePerTrip = v; }).catch(() => {});
  }

  function render(tab, context) {
    ctx = { ...context, tab };
    listen();
    loadFee();
    if (tab === 'board') return renderBoard();
    if (tab === 'post') return renderPost();
    if (tab === 'myloads' || tab === 'mybids') return renderList(tab);
  }

  // Open one load from elsewhere (an alert), whatever tab is showing.
  function open(id, context) {
    if (!ctx) ctx = { ...context, tab: null };
    listen();
    loadFee();
    openDetail(id);
  }

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openLoad && !document.querySelector('.modal-backdrop')) closeDetail(); });

  return { tabs, firstTab, render, open };
})();
