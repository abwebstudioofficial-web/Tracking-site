// Transport Hub: a business's home page.
// - No company yet: invites waiting for me, or register my company (shipper, carrier, broker, dispatcher).
// - My company: its check status, details, team (add people by phone number) and verification papers.
// - Platform admins also check new companies here.
(async () => {
  const { sb, COMPANY_KINDS, MEMBER_ROLES } = Ibraya;
  const $ = (id) => document.getElementById(id);
  const main = $('main');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const BUCKET = 'company-docs';
  const PAPERS = {
    cnic_front: 'CNIC (front)',
    cnic_back: 'CNIC (back)',
    ntn: 'NTN certificate',
    registration: 'Truck registration',
    other: 'Other paper',
  };
  const CITIES = ['Karachi', 'Port Qasim', 'Lahore', 'Islamabad', 'Rawalpindi', 'Faisalabad', 'Multan', 'Hyderabad',
    'Peshawar', 'Quetta', 'Sialkot', 'Gujranwala', 'Sukkur', 'Gwadar', 'Bahawalpur', 'Sargodha', 'Sheikhupura', 'Kasur',
    'Rahim Yar Khan', 'Dera Ghazi Khan', 'Abbottabad', 'Mardan', 'Nowshera', 'Gujrat', 'Jhelum', 'Sahiwal', 'Okara'];
  const STATUS = {
    pending: { label: 'Waiting for check · جانچ جاری ہے', cls: 'warn' },
    verified: { label: 'Verified ✓ · تصدیق شدہ', cls: 'ok' },
    rejected: { label: 'Needs changes · تبدیلی درکار', cls: 'bad' },
  };
  const kindLabel = (k) => (COMPANY_KINDS[k] ? `${COMPANY_KINDS[k].en} · ${COMPANY_KINDS[k].ur}` : k);
  const date = (t) => (t ? new Date(t).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const localPhone = (p) => (p && p.startsWith('+92') ? '0' + p.slice(3) : p || '');

  const me = await Ibraya.guard('/hub');
  if (!me) return;
  $('logout').addEventListener('click', () => Ibraya.signOut());
  const isAdmin = me.role === 'admin';
  $('to-fleet').hidden = !isAdmin;

  let state = null; // answer of my_company()
  let tab = null; // opens on the load board (or My loads) once the company is verified
  let registering = false; // chose "register my own company" instead of an invite
  let editing = false;
  let companies = null; // admin: answer of admin_list_companies()
  let adminFilter = 'pending';
  let adminOpen = null;

  // Runs fn while the button shows it's busy; errors go into errorEl (or a pop-up).
  async function busy(btn, errorEl, fn) {
    if (btn.disabled) return;
    btn.disabled = true;
    if (errorEl) errorEl.textContent = '';
    try {
      await fn();
    } catch (err) {
      const msg = Ibraya.friendlyError(err);
      if (errorEl) errorEl.textContent = msg;
      else Ibraya.message('Something went wrong', msg);
    } finally {
      btn.disabled = false;
    }
  }
  async function rpc(name, args) {
    const { data, error } = await sb.rpc(name, args);
    if (error) throw error;
    return data;
  }

  let bellStarted = false;
  async function load() {
    state = await rpc('my_company');
    if (isAdmin) companies = await rpc('admin_list_companies');
    render();
    // Alerts for the company's owner and managers.
    if (!bellStarted && state.company && (state.role === 'owner' || state.role === 'manager')) {
      bellStarted = true;
      HubMoney.initBell({ rpc, openLoad: (id) => HubLoads.open(id, { busy, rpc, go: (t) => { tab = t; renderDashboard(); } }) });
    }
    // Opened from a notification: /hub?load=<id> shows that load.
    const fromAlert = new URLSearchParams(location.search).get('load');
    if (fromAlert && state.company) {
      history.replaceState(null, '', '/hub');
      HubLoads.open(fromAlert, { busy, rpc, go: (t) => { tab = t; renderDashboard(); } });
    }
  }

  function render() {
    const c = state.company;
    $('top-company').textContent = c ? c.name : 'Loads · Trucks · Tracking';
    if (!c) {
      if (state.my_invites.length && !registering) return renderInvites();
      return renderOnboarding();
    }
    renderDashboard();
  }

  // ---------- invites waiting for me ----------
  function renderInvites() {
    main.innerHTML = `
      <section class="panel-card">
        <h1>You've been added · آپ کو شامل کیا گیا ہے</h1>
        <p class="muted">Accept to join the company.</p>
        <div class="rows">${state.my_invites.map((i) => `
          <div class="row">
            <div class="row-main"><b>${esc(i.company)}</b>${i.verified ? ' <span class="pill ok small">Verified ✓</span>' : ''}
              <div class="muted">${esc(kindLabel(i.kind))} · as ${esc(MEMBER_ROLES[i.role] || i.role)}</div></div>
            <div class="row-actions">
              <button class="btn btn-small" data-accept="${i.company_id}">Accept · قبول</button>
              <button class="btn btn-ghost btn-small" data-decline="${i.company_id}">Decline</button>
            </div>
          </div>`).join('')}</div>
        ${me.role === 'business' || isAdmin ? '<p class="link-row"><button class="link" id="own-company">Register my own company instead</button></p>' : ''}
      </section>`;
    main.querySelectorAll('[data-accept],[data-decline]').forEach((b) => b.addEventListener('click', () => busy(b, null, async () => {
      const accept = !!b.dataset.accept;
      state = await rpc('answer_company_invite', { p_company: b.dataset.accept || b.dataset.decline, p_accept: accept });
      render();
    })));
    const own = $('own-company');
    if (own) own.addEventListener('click', () => { registering = true; render(); });
  }

  // ---------- register my company ----------
  function companyFields(c = {}, withKind = true) {
    const k = KIND_INFO[c.kind];
    return `
      ${withKind && k ? `<div class="field"><span>Your business · آپ کا کاروبار</span>
        <div class="kind-chosen"><span class="kind-icon">${k.icon}</span>
          <div><b>${COMPANY_KINDS[c.kind].en} · ${COMPANY_KINDS[c.kind].ur}</b><span>${esc(k.line)}</span></div>
          <button type="button" class="btn btn-ghost btn-small" id="change-kind">Change · تبدیل</button></div></div>` : ''}
      <label class="field"><span>Company name · کمپنی کا نام</span>
        <input name="name" maxlength="100" value="${esc(c.name)}" placeholder="e.g. Al-Madina Goods Transport" required></label>
      <label class="field"><span>City · شہر</span>
        <input name="city" maxlength="60" list="cities" value="${esc(c.city)}" placeholder="e.g. Karachi" required></label>
      <datalist id="cities">${CITIES.map((x) => `<option value="${x}">`).join('')}</datalist>
      <label class="field"><span>Office address · دفتر کا پتہ <i>(optional)</i></span>
        <input name="address" maxlength="200" value="${esc(c.address)}"></label>
      <div class="field-pair">
        <label class="field"><span>NTN <i>(if you have one)</i></span>
          <input name="ntn" maxlength="20" value="${esc(c.ntn)}" placeholder="1234567-8"></label>
        <label class="field"><span>Owner's CNIC · شناختی کارڈ</span>
          <input name="cnic" maxlength="20" inputmode="numeric" value="${esc(c.cnic)}" placeholder="42101-1234567-1"></label>
      </div>
      <label class="field" id="fleet-field" ${c.kind === 'carrier' ? '' : 'hidden'}><span>How many trucks? · کتنے ٹرک ہیں؟</span>
        <input name="fleet" type="number" min="0" max="10000" inputmode="numeric" value="${c.fleet_size ?? ''}"></label>`;
  }
  const readFleet = (f) => (f.fleet && f.fleet.value !== '' ? Math.max(0, Math.min(10000, parseInt(f.fleet.value, 10) || 0)) : null);

  // ---------- welcome pop-up: "What do you do?" ----------
  // Big, clear choices with what each one can do here, then a "Yes, that's me" check, so nobody
  // becomes a broker by tapping the wrong box. The type can't be changed later without an admin.
  const KIND_INFO = {
    shipper: {
      icon: '📦', line: 'I have goods to send: factory, trader, importer or exporter · میرے پاس بھیجنے کے لیے سامان ہے',
      can: ['Post loads (city to city, or to / from the port) · لوڈ پوسٹ کریں', 'See every carrier\'s price and book the best one · ریٹ دیکھیں اور بک کریں', 'Watch your truck live on the map · ٹرک کو لائیو دیکھیں', 'Get proof of delivery and invoices · ڈیلیوری کا ثبوت اور انوائس'],
    },
    carrier: {
      icon: '🚛', line: 'I own or run trucks · میرے پاس ٹرک ہیں',
      can: ['Find loads and give your price · لوڈ ڈھونڈیں اور ریٹ دیں', 'Add your drivers and send them jobs · ڈرائیور شامل کریں اور کام دیں', 'See all your trucks on one map · سب ٹرک ایک نقشے پر', 'Get paid with invoices (a small fee per booked trip) · انوائس سے ادائیگی'],
    },
    broker: {
      icon: '🤝', line: 'I arrange trucks for other people\'s goods (my own trucks not needed) · میں دوسروں کے سامان کے لیے ٹرک کا انتظام کرتا ہوں',
      can: ['Post loads for your clients · اپنے کلائنٹس کے لوڈ پوسٹ کریں', 'Also give prices on other people\'s loads · دوسروں کے لوڈ پر ریٹ دیں', 'Track the trucks you booked · بک کیے گئے ٹرک دیکھیں'],
    },
    dispatcher: {
      icon: '📋', line: 'I find loads for truck owners and handle their bookings · میں ٹرک مالکان کے لیے لوڈ ڈھونڈتا ہوں',
      can: ['Find loads and give prices for the carriers you work for · لوڈ ڈھونڈیں اور ریٹ دیں', 'Keep their trips on track · ان کے سفر سنبھالیں'],
    },
  };

  function chooseKind(current) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'modal-backdrop';
      wrap.innerHTML = '<div class="modal welcome" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="welcome-title"></div>';
      const box = wrap.querySelector('.modal');
      const close = (value) => { document.removeEventListener('keydown', onKey); wrap.remove(); resolve(value); };
      const onKey = (e) => { if (e.key === 'Escape' && current) close(current); };
      const pick = () => {
        box.innerHTML = `
          <div class="welcome-step">Step 1 of 2 · مرحلہ 1</div>
          <h2 id="welcome-title">Welcome to Transport Hub, ${esc(state.me.name)}!<br>What do you do? · آپ کیا کام کرتے ہیں؟</h2>
          <p class="modal-msg">Choose the one that fits your business. This decides what you can do on Transport Hub.</p>
          <div class="welcome-grid">${Object.entries(KIND_INFO).map(([k, v]) => `
            <button type="button" class="welcome-card${k === current ? ' on' : ''}" data-kind="${k}">
              <span class="kind-icon">${v.icon}</span>
              <b>${COMPANY_KINDS[k].en} · ${COMPANY_KINDS[k].ur}</b>
              <span>${esc(v.line)}</span>
            </button>`).join('')}</div>
          <p class="welcome-note">🚚 <b>Truck driver?</b> You don't register a company. Your transport company adds you with your phone number, then you sign in with your phone. · ڈرائیور؟ آپ کی کمپنی آپ کو شامل کرے گی۔</p>
          ${current ? '<div class="modal-actions"><button type="button" class="btn btn-ghost" data-keep>Keep my choice</button></div>' : ''}`;
        box.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', () => confirm(b.dataset.kind)));
        const keep = box.querySelector('[data-keep]');
        if (keep) keep.addEventListener('click', () => close(current));
        box.focus(); // not a card, so none looks chosen
      };
      const confirm = (k) => {
        const v = KIND_INFO[k];
        const name = COMPANY_KINDS[k];
        box.innerHTML = `
          <div class="welcome-step">Step 2 of 2 · مرحلہ 2</div>
          <div class="welcome-big">${v.icon}</div>
          <h2 id="welcome-title">You are a ${name.en} · آپ ${name.ur} ہیں</h2>
          <p class="modal-msg">${esc(v.line)}</p>
          <div class="welcome-can"><b>As a ${name.en} you can:</b><ul>${v.can.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
          <p class="welcome-note">Only a Transport Hub admin can change this later, so please check it's right.</p>
          <div class="modal-actions">
            <button type="button" class="btn btn-ghost" data-back>← Back</button>
            <button type="button" class="btn" data-yes>Yes, I'm a ${name.en}</button>
          </div>`;
        box.querySelector('[data-back]').addEventListener('click', pick);
        box.querySelector('[data-yes]').addEventListener('click', () => close(k));
        box.querySelector('[data-yes]').focus();
      };
      document.addEventListener('keydown', onKey);
      document.body.appendChild(wrap);
      pick();
    });
  }

  let chosenKind = null;
  let choosing = false;
  async function renderOnboarding() {
    if (!chosenKind) {
      if (choosing) return; // the pop-up is already open
      choosing = true;
      main.innerHTML = '';
      chosenKind = await chooseKind(null);
      choosing = false;
    }
    main.innerHTML = `
      <section class="panel-card narrow">
        <h1>Register your business · اپنا کاروبار رجسٹر کریں</h1>
        <p class="muted">Welcome, ${esc(state.me.name)}. A Transport Hub admin checks every company before it can post or take loads.</p>
        <form id="company-form" novalidate>
          ${companyFields({ kind: chosenKind })}
          <div class="error" id="company-error"></div>
          <button class="btn" id="company-submit">Register company · کمپنی رجسٹر کریں</button>
        </form>
        ${state.my_invites.length ? '<p class="link-row"><button class="link" id="see-invites">Back to my invites</button></p>' : ''}
      </section>`;
    const f = $('company-form');
    $('change-kind').addEventListener('click', async () => {
      const k = await chooseKind(chosenKind);
      if (k === chosenKind) return;
      chosenKind = k;
      const keep = Object.fromEntries(['name', 'city', 'address', 'ntn', 'cnic', 'fleet'].map((n) => [n, f[n].value]));
      renderOnboarding();
      const g = $('company-form');
      Object.entries(keep).forEach(([n, v]) => { g[n].value = v; });
    });
    const back = $('see-invites');
    if (back) back.addEventListener('click', () => { registering = false; render(); });
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      busy($('company-submit'), $('company-error'), async () => {
        if (!chosenKind) throw new Error('Choose what your business does · اپنے کاروبار کی قسم چنیں');
        if (f.name.value.trim().length < 2) throw new Error('Enter your company name · کمپنی کا نام لکھیں');
        if (f.city.value.trim().length < 2) throw new Error('Enter your city · شہر لکھیں');
        state = await rpc('create_my_company', {
          p_kind: chosenKind, p_name: f.name.value, p_city: f.city.value, p_address: f.address.value,
          p_ntn: f.ntn.value, p_cnic: f.cnic.value, p_fleet_size: readFleet(f),
        });
        tab = 'papers'; // next: upload papers so the admins can check
        render();
      });
    });
  }

  // ---------- my company ----------
  function statusHelp(c) {
    if (c.status === 'verified') return `Checked by Transport Hub on ${date(c.verified_at)}.`;
    if (c.status === 'rejected') return `<b>What to fix:</b> ${esc(c.status_note)}<br>Make the changes under Details or Papers. Saving the details sends your company to be checked again.`;
    return 'A Transport Hub admin is checking your company. Upload your papers (CNIC, NTN, truck registration) under Papers to get verified faster.';
  }

  function renderDashboard() {
    const c = state.company;
    const role = state.role;
    const staff = role === 'owner' || role === 'manager';
    const pending = isAdmin && companies ? companies.filter((x) => x.company.status === 'pending').length : 0;
    const loadTabs = c.status === 'verified' ? HubLoads.tabs(c, role) : [];
    if (!tab) tab = loadTabs.length ? HubLoads.firstTab(c) : 'overview';
    const tabs = [...loadTabs, ...(loadTabs.length && staff ? [['invoices', 'Invoices']] : []),
      ...(c.kind === 'carrier' && staff ? [['fleet', 'Fleet map']] : []),
      ['overview', 'Details'], ['team', `Team (${state.members.length})`]];
    if (staff) tabs.push(['papers', 'Papers']);
    if (isAdmin) tabs.push(['admin', `Companies${pending ? ` <span class="count">${pending}</span>` : ''}`], ['commission', 'Commission']);
    if (!tabs.some(([k]) => k === tab)) tab = 'overview';
    main.innerHTML = `
      <section class="panel-card company-head">
        <div class="company-title">
          <div><h1>${esc(c.name)}</h1><div class="muted">${esc(kindLabel(c.kind))} · ${esc(c.city)} · you are ${esc(MEMBER_ROLES[role] || role)}</div></div>
          <span class="pill ${STATUS[c.status].cls}">${STATUS[c.status].label}</span>
        </div>
        <p class="status-help">${statusHelp(c)}</p>
      </section>
      <nav class="hub-tabs">${tabs.map(([k, label]) => `<button data-tab="${k}" class="${k === tab ? 'active' : ''}">${label}</button>`).join('')}</nav>
      <section id="tab-body"></section>`;
    main.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; editing = false; renderDashboard(); }));
    const page = { overview: renderOverview, team: renderTeam, papers: renderPapers, admin: renderAdmin }[tab];
    if (page) return page();
    if (tab === 'invoices') return HubMoney.renderInvoices($('tab-body'), { rpc, kind: c.kind });
    if (tab === 'commission') return HubMoney.renderCommission($('tab-body'), { rpc, busy });
    const go = (t) => { tab = t; renderDashboard(); };
    if (tab === 'fleet') return HubFleet.render($('tab-body'), { rpc, openLoad: (id) => HubLoads.open(id, { busy, rpc, go }) });
    HubLoads.render(tab, { body: $('tab-body'), busy, rpc, go: (t) => { tab = t; renderDashboard(); } });
  }

  function detailRows(c) {
    const rows = [
      ['Business', kindLabel(c.kind)], ['City', c.city], ['Address', c.address], ['Contact', localPhone(c.phone)],
      ['NTN', c.ntn], ['Owner CNIC', c.cnic], ...(c.kind === 'carrier' ? [['Trucks', c.fleet_size ?? '']] : []),
      ['Registered', date(c.created_at)],
    ];
    return `<dl class="details">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v === '' || v == null ? '<span class="muted">—</span>' : esc(v)}</dd>`).join('')}</dl>`;
  }

  function renderOverview() {
    const c = state.company;
    const body = $('tab-body');
    if (editing) {
      body.innerHTML = `
        <div class="panel-card narrow">
          <h2>Edit details</h2>
          ${c.status === 'verified' ? '<p class="notice">Changing the name, NTN or CNIC sends your company to be checked again.</p>' : ''}
          <form id="edit-form" novalidate>
            ${companyFields(c, false)}
            <div class="error" id="edit-error"></div>
            <div class="form-actions"><button type="button" class="btn btn-ghost" id="edit-cancel">Cancel</button><button class="btn" id="edit-save">Save</button></div>
          </form>
        </div>`;
      const f = $('edit-form');
      $('edit-cancel').addEventListener('click', () => { editing = false; renderDashboard(); });
      f.addEventListener('submit', (e) => {
        e.preventDefault();
        busy($('edit-save'), $('edit-error'), async () => {
          state = await rpc('update_my_company', {
            p_name: f.name.value, p_city: f.city.value, p_address: f.address.value,
            p_ntn: f.ntn.value, p_cnic: f.cnic.value, p_fleet_size: readFleet(f),
          });
          editing = false;
          if (isAdmin) companies = await rpc('admin_list_companies');
          renderDashboard();
        });
      });
      return;
    }
    body.innerHTML = `
      <div class="panel-card">
        <div class="card-head"><h2>Company details</h2>${state.role === 'owner' ? '<button class="btn btn-ghost btn-small" id="edit">Edit</button>' : ''}</div>
        ${detailRows(c)}
      </div>
      ${c.status === 'verified' ? `<div class="panel-card"><h2>Your reputation · ساکھ</h2>
        <p id="reputation" class="muted">Loading…</p>
        <p class="muted small">Other companies see this next to your bids and loads. It grows with every delivered load and rating.</p></div>` : ''}
      ${c.status === 'verified' ? '' : `<div class="panel-card coming">
        <h2>The load board opens once you're verified · تصدیق کے بعد لوڈ بورڈ</h2>
        <p class="muted">${c.kind === 'shipper'
          ? 'Post your loads, compare carriers\' open bids side by side, and book a truck.'
          : 'Find loads, place bids that shippers can compare, and get booked.'}</p>
      </div>`}`;
    const edit = $('edit');
    if (edit) edit.addEventListener('click', () => { editing = true; renderOverview(); });
    if ($('reputation')) {
      rpc('company_rating', { p_company: c.id })
        .then((r) => { if ($('reputation')) $('reputation').innerHTML = HubMoney.ratingText(r, { long: true }); })
        .catch(() => { if ($('reputation')) $('reputation').textContent = ''; });
    }
  }

  // ---------- team ----------
  function renderTeam() {
    const c = state.company;
    const role = state.role;
    const canAddManager = role === 'owner';
    const canAddDriver = (role === 'owner' || role === 'manager') && c.kind === 'carrier';
    const canRemove = (m) => m.user_id !== state.me.id && m.role !== 'owner' && (role === 'owner' || (role === 'manager' && m.role === 'driver'));
    const options = [canAddDriver && ['driver', 'Driver · ڈرائیور'], canAddManager && ['manager', c.kind === 'carrier' ? 'Manager / dispatcher' : 'Manager / staff']].filter(Boolean);
    const body = $('tab-body');
    body.innerHTML = `
      <div class="panel-card">
        <h2>People · ٹیم</h2>
        <div class="rows">${state.members.map((m) => `
          <div class="row">
            <div class="row-main"><b>${esc(m.name || '—')}</b>${m.user_id === state.me.id ? ' <span class="badge">You</span>' : ''}
              <div class="muted">${esc(MEMBER_ROLES[m.role] || m.role)} · ${esc(localPhone(m.phone))}</div></div>
            ${canRemove(m) ? `<div class="row-actions"><button class="btn btn-ghost btn-small" data-remove="${m.user_id}" data-name="${esc(m.name)}">Remove</button></div>` : ''}
          </div>`).join('')}</div>
        ${state.invites.length ? `<h3>Waiting to join</h3><div class="rows">${state.invites.map((i) => `
          <div class="row">
            <div class="row-main"><b>${esc(i.name || localPhone(i.phone))}</b>
              <div class="muted">${esc(MEMBER_ROLES[i.role])} · ${esc(localPhone(i.phone))} · added ${date(i.created_at)}</div></div>
            ${role === 'owner' || i.role === 'driver' ? `<div class="row-actions"><button class="btn btn-ghost btn-small" data-cancel="${esc(i.phone)}">Cancel</button></div>` : ''}
          </div>`).join('')}</div>` : ''}
      </div>
      ${options.length ? `
      <div class="panel-card narrow">
        <h2>Add someone · کسی کو شامل کریں</h2>
        <form id="invite-form" novalidate>
          <label class="field"><span>Name · نام</span><input name="name" maxlength="80" placeholder="e.g. Muhammad Ali"></label>
          <label class="field"><span>Phone number · فون نمبر</span><input name="phone" type="tel" inputmode="tel" placeholder="0300 1234567"></label>
          <label class="field"><span>As</span><select name="role" class="select">${options.map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
          <p class="hint" style="text-align:left;margin-top:-4px">Drivers sign in to the Transport Hub app with this number, no password.
            Managers create a business account with this number. They join your company as soon as they do.</p>
          <div class="error" id="invite-error"></div>
          <button class="btn" id="invite-submit">Add · شامل کریں</button>
        </form>
      </div>` : ''}`;
    body.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
      const ok = await Ibraya.dialog({ title: `Remove ${b.dataset.name || 'this person'}?`, message: 'They will no longer be part of your company.', okText: 'Remove', danger: true });
      if (!ok) return;
      busy(b, null, async () => { await rpc('company_remove_member', { p_user: b.dataset.remove }); await load(); });
    }));
    body.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', () => busy(b, null, async () => {
      await rpc('company_cancel_invite', { p_phone: b.dataset.cancel });
      await load();
    })));
    const f = $('invite-form');
    if (f) f.addEventListener('submit', (e) => {
      e.preventDefault();
      busy($('invite-submit'), $('invite-error'), async () => {
        if (!Ibraya.normalizePhone(f.phone.value)) throw new Error('Enter the full mobile number, 11 digits, e.g. 0300 1234567 · پورا موبائل نمبر لکھیں');
        await rpc('company_invite', { p_phone: f.phone.value, p_name: f.name.value, p_role: f.role.value });
        await load();
      });
    });
  }

  // ---------- verification papers ----------
  async function listPapers(companyId) {
    const { data, error } = await sb.storage.from(BUCKET).list(companyId, { limit: 100, sortBy: { column: 'created_at', order: 'asc' } });
    if (error) throw error;
    return (data || []).filter((f) => f.name && !f.name.startsWith('.'));
  }
  const paperLabel = (name) => PAPERS[name.split('-')[0]] || PAPERS.other;
  async function openPaper(path) {
    const win = window.open('', '_blank'); // opened now, so pop-up blockers allow it
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, 300);
    if (error) { if (win) win.close(); throw error; }
    if (win) win.location = data.signedUrl; else location.href = data.signedUrl;
  }
  function papersList(companyId, files, canDelete) {
    if (!files.length) return '<p class="muted">No papers uploaded yet.</p>';
    return `<div class="rows">${files.map((f) => `
      <div class="row">
        <div class="row-main"><b>${esc(paperLabel(f.name))}</b><div class="muted">${date(f.created_at)}</div></div>
        <div class="row-actions">
          <button class="btn btn-ghost btn-small" data-view="${esc(companyId + '/' + f.name)}">View</button>
          ${canDelete ? `<button class="btn btn-ghost btn-small" data-delete="${esc(companyId + '/' + f.name)}">Delete</button>` : ''}
        </div>
      </div>`).join('')}</div>`;
  }
  function wirePapers(root, reload) {
    root.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => busy(b, null, () => openPaper(b.dataset.view))));
    root.querySelectorAll('[data-delete]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await Ibraya.dialog({ title: 'Delete this paper?', okText: 'Delete', danger: true }))) return;
      busy(b, null, async () => {
        const { error } = await sb.storage.from(BUCKET).remove([b.dataset.delete]);
        if (error) throw error;
        await reload();
      });
    }));
  }

  async function renderPapers() {
    const c = state.company;
    const body = $('tab-body');
    body.innerHTML = '<div class="panel-card"><p class="muted">Loading papers…</p></div>';
    let files = [];
    try { files = await listPapers(c.id); } catch (err) { body.innerHTML = `<div class="panel-card"><p class="error">${esc(Ibraya.friendlyError(err))}</p></div>`; return; }
    if (tab !== 'papers') return;
    const wanted = c.kind === 'carrier' ? 'the owner\'s CNIC (both sides), your NTN certificate if you have one, and the registration of your trucks'
      : 'the owner\'s CNIC (both sides) and your NTN certificate if you have one';
    body.innerHTML = `
      <div class="panel-card">
        <h2>Papers for verification · تصدیق کے کاغذات</h2>
        <p class="muted">Upload ${wanted}. Only your company's owner and managers, and Transport Hub admins, can see them.</p>
        ${papersList(c.id, files, state.role === 'owner')}
      </div>
      <div class="panel-card narrow">
        <h2>Upload a paper</h2>
        <form id="paper-form" novalidate>
          <label class="field"><span>Which paper</span><select name="kind" class="select">${Object.entries(PAPERS)
            .filter(([k]) => k !== 'registration' || c.kind === 'carrier').map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
          <label class="field"><span>Photo or PDF (up to 5 MB) · تصویر یا پی ڈی ایف</span>
            <input name="file" type="file" accept="image/*,application/pdf"></label>
          <div class="error" id="paper-error"></div>
          <button class="btn" id="paper-submit">Upload · اپ لوڈ</button>
        </form>
      </div>`;
    wirePapers(body, renderPapers);
    const f = $('paper-form');
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      busy($('paper-submit'), $('paper-error'), async () => {
        const file = f.file.files[0];
        if (!file) throw new Error('Choose a photo or PDF');
        if (file.size > 5 * 1024 * 1024) throw new Error('This file is bigger than 5 MB. Take a smaller photo.');
        const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'jpg';
        const { error } = await sb.storage.from(BUCKET).upload(`${c.id}/${f.kind.value}-${Date.now()}.${ext}`, file, { contentType: file.type || undefined });
        if (error) throw error;
        await renderPapers();
      });
    });
  }

  // ---------- platform admins: check companies ----------
  function renderAdmin() {
    const body = $('tab-body');
    const counts = { pending: 0, verified: 0, rejected: 0 };
    companies.forEach((x) => counts[x.company.status]++);
    const shown = companies.filter((x) => adminFilter === 'all' || x.company.status === adminFilter);
    body.innerHTML = `
      <div class="panel-card">
        <div class="card-head"><h2>Companies on Transport Hub</h2></div>
        <div class="chips">${[['pending', 'Waiting'], ['verified', 'Verified'], ['rejected', 'Needs changes'], ['all', 'All']].map(([k, v]) => `
          <button class="chip ${adminFilter === k ? 'active' : ''}" data-filter="${k}">${v}${k === 'all' ? ` (${companies.length})` : ` (${counts[k]})`}</button>`).join('')}</div>
        <div class="rows">${shown.length ? shown.map((x) => `
          <div class="row clickable ${adminOpen === x.company.id ? 'open' : ''}" data-open="${x.company.id}">
            <div class="row-main"><b>${esc(x.company.name)}</b> <span class="pill small ${STATUS[x.company.status].cls}">${x.company.status === 'pending' ? 'Waiting' : x.company.status === 'verified' ? 'Verified' : 'Needs changes'}</span>
              <div class="muted">${esc(COMPANY_KINDS[x.company.kind].en)} · ${esc(x.company.city)} · ${x.owner ? `${esc(x.owner.name)} ${esc(localPhone(x.owner.phone))}` : 'no owner'} · ${x.members} ${x.members === 1 ? 'person' : 'people'} · ${date(x.company.created_at)}</div></div>
          </div>
          ${adminOpen === x.company.id ? '<div class="row-detail" id="admin-detail"></div>' : ''}`).join('') : '<p class="muted">Nothing here.</p>'}</div>
      </div>`;
    body.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => { adminFilter = b.dataset.filter; adminOpen = null; renderAdmin(); }));
    body.querySelectorAll('[data-open]').forEach((r) => r.addEventListener('click', () => {
      adminOpen = adminOpen === r.dataset.open ? null : r.dataset.open;
      renderAdmin();
    }));
    if (adminOpen) renderAdminDetail(companies.find((x) => x.company.id === adminOpen));
  }

  async function renderAdminDetail(x) {
    const el = $('admin-detail');
    if (!el || !x) return;
    const c = x.company;
    el.innerHTML = `${detailRows(c)}${c.status_note ? `<p class="notice"><b>Note to the company:</b> ${esc(c.status_note)}</p>` : ''}
      <h3>Papers</h3><div id="admin-papers"><p class="muted">Loading…</p></div>
      <div class="form-actions">
        ${c.status !== 'verified' ? '<button class="btn btn-small" data-status="verified">Verify ✓</button>' : ''}
        ${c.status !== 'rejected' ? '<button class="btn btn-ghost btn-small" data-status="rejected">Ask for changes</button>' : ''}
        ${c.status !== 'pending' ? '<button class="btn btn-ghost btn-small" data-status="pending">Back to waiting</button>' : ''}
      </div>`;
    el.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', async () => {
      let note = '';
      if (b.dataset.status === 'rejected') {
        note = await Ibraya.dialog({
          title: `What should ${c.name} fix?`, message: 'They see this on their page.', okText: 'Send',
          input: { placeholder: 'e.g. CNIC photo is blurry, please upload it again', validate: (v) => (v.trim() ? '' : 'Write what to fix') },
        });
        if (note == null) return;
      }
      busy(b, null, async () => {
        await rpc('admin_set_company_status', { p_company: c.id, p_status: b.dataset.status, p_note: note });
        companies = await rpc('admin_list_companies');
        if (c.id === state.company?.id) state = await rpc('my_company');
        renderDashboard();
      });
    }));
    try {
      const files = await listPapers(c.id);
      const papers = $('admin-papers');
      if (!papers) return;
      papers.innerHTML = papersList(c.id, files, false);
      wirePapers(papers, () => renderAdminDetail(x));
    } catch (err) {
      const papers = $('admin-papers');
      if (papers) papers.innerHTML = `<p class="error">${esc(Ibraya.friendlyError(err))}</p>`;
    }
  }

  try {
    await load();
  } catch (err) {
    main.innerHTML = `<section class="panel-card"><p class="error">${esc(Ibraya.friendlyError(err))}</p></section>`;
  }
})();
