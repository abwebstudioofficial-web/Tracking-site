(async () => {
  const { sb, ROLES } = Ibraya;
  const STALE_MS = 2 * 60 * 1000; // marker greys out if no update for 2 minutes

  const listEl = document.getElementById('list');
  const searchEl = document.getElementById('search');
  const sidebar = document.getElementById('sidebar');
  let users = new Map();
  let me = null;
  let selectedId = null;
  let userMovedMap = false; // auto-fit to all trucks until the admin pans/zooms themselves

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  function ago(ts) {
    if (!ts) return 'never';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 10) return 'just now';
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(ts).toLocaleDateString();
  }

  // A truck is "live" if it reported its position in the last 2 minutes.
  const isLive = (u) => !!u.location && Date.now() - u.location.at < STALE_MS;

  // Database row -> what the map and list use.
  const fromRow = (r) => ({
    id: r.id,
    name: r.name || 'Unnamed',
    phone: r.phone || '',
    email: r.email,
    role: r.role,
    problem: r.tracking_problem || null, // reported by the app: location_off / no_gps / phone_off / battery_dead / signed_out
    battery: r.battery ?? null,          // phone battery %, sent by the app
    sim: r.sim_check || null,            // verified / unverified / mismatch (checked by the app)
    simAt: r.sim_checked_at ? Date.parse(r.sim_checked_at) : null,
    problemAt: r.problem_at ? Date.parse(r.problem_at) : null,
    stoppedSince: r.stopped_since ? Date.parse(r.stopped_since) : null,
    location: r.lat == null ? null : {
      lat: r.lat, lng: r.lng, accuracy: r.accuracy, speed: r.speed, heading: r.heading,
      at: Date.parse(r.location_at),
    },
  });
  const kmh = (u) => (u.location && u.location.speed != null ? Math.round(u.location.speed * 3.6) : null);
  const speedText = (v) => (v === 0 ? 'Stopped' : `${v} km/h`);

  // Status shown on the map and in the list. Speed itself is only shown in the popup.
  const ACTIVE_KMH = 5; // at or above this the truck counts as moving
  const STATUS = {
    active: 'Active',   // live and moving
    idle: 'Idle',       // live but stopped / crawling
    offline: 'Offline', // no update for 2 minutes
    alert: 'Problem',   // offline, and the app told us why (see PROBLEM)
    none: 'No location yet',
  };
  const PROBLEM = {
    location_off: 'Location off',
    no_gps: 'No GPS',
    phone_off: 'Phone off',
    battery_dead: 'Battery dead',
    signed_out: 'Signed out',
  };
  function statusOf(u) {
    if (!u.location) return 'none';
    if (!isLive(u)) return u.problem ? 'alert' : 'offline';
    return (kmh(u) ?? 0) >= ACTIVE_KMH ? 'active' : 'idle';
  }
  const STATUS_ORDER = { alert: 0, active: 1, idle: 2, offline: 3, none: 4 };
  const chip = (u) => {
    const st = statusOf(u);
    return `<span class="state-chip state-${st}">${st === 'alert' ? PROBLEM[u.problem] : STATUS[st]}</span>`;
  };

  // Exact times, 24-hour clock. Other days get the date too.
  const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
  const hm = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const hms = (ms) => new Date(ms).toLocaleTimeString('en-GB');
  const when = (ms) => (sameDay(ms, Date.now()) ? hm(ms)
    : `${new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${hm(ms)}`);
  function duration(ms) {
    const min = Math.round(ms / 60000);
    if (min < 1) return 'under 1 min';
    if (min < 60) return `${min} min`;
    return `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`;
  }
  const distance = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`);

  // ---------- map ----------
  const map = L.map('map', { zoomControl: false }).setView([30.3753, 69.3451], 5);
  L.control.zoom({ position: 'topright' }).addTo(map);
  // Base map: OpenFreeMap (free, no API key), drawn in the browser by MapLibre so we can
  // choose the labels: English name on top, Urdu (or other local script) underneath.
  // Falls back to plain OpenStreetMap tiles if OpenFreeMap can't be reached.
  const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

  function bilingualLabel(separator) {
    return ['let',
      'en', ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name:latin'], ['get', 'name']],
      'local', ['coalesce', ['get', 'name:ur'], ['get', 'name:nonlatin'], ''],
      ['case',
        ['all', ['!=', ['var', 'local'], ''], ['!=', ['var', 'local'], ['var', 'en']]],
        ['concat', ['var', 'en'], separator, ['var', 'local']],
        ['var', 'en']]];
  }

  async function addBaseMap() {
    try {
      if (!window.maplibregl || !L.maplibreGL) throw new Error('MapLibre not loaded');
      // Joins Urdu/Arabic letters correctly and draws them right-to-left.
      maplibregl.setRTLTextPlugin(`${location.origin}/vendor/rtl-text.js`, true).catch(() => {});
      const res = await fetch('https://tiles.openfreemap.org/styles/liberty');
      if (!res.ok) throw new Error(`style ${res.status}`);
      const style = await res.json();
      for (const layer of style.layers) {
        const field = layer.layout && layer.layout['text-field'];
        const text = JSON.stringify(field || '');
        if (!text.includes('name')) continue; // leave road numbers etc. alone
        // Point labels (cities) get two lines; labels along roads/rivers stay on one line.
        layer.layout['text-field'] = bilingualLabel(text.includes('\\n') ? '\n' : ' ');
      }
      L.maplibreGL({ style }).addTo(map);
      map.attributionControl.addAttribution(
        `<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> ${OSM_ATTR}`
      );
    } catch {
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: OSM_ATTR }).addTo(map);
    }
  }
  addBaseMap();

  const markers = new Map();
  const fleetLayer = L.layerGroup().addTo(map); // live trucks (hidden while a trip history is shown)
  map.on('dragstart', () => { userMovedMap = true; });
  map.getContainer().addEventListener('wheel', () => { userMovedMap = true; }, { passive: true });

  function truckIcon(u) {
    const heading = u.location && u.location.heading != null ? u.location.heading : 0;
    const showArrow = u.location && u.location.heading != null;
    return L.divIcon({
      className: '',
      iconSize: [44, 44],
      iconAnchor: [22, 22],
      popupAnchor: [0, -20],
      html: `
        <div class="truck ${statusOf(u)}">
          <div class="pulse"></div>
          <div style="position:absolute;inset:0;transform:rotate(${heading}deg)">
            ${showArrow ? '<div class="arrow"></div>' : ''}
          </div>
          <div class="body">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4h13v11H1z"/><path d="M14 8h4l4 4v3h-8z"/><circle cx="5.5" cy="17.5" r="2"/><circle cx="17.5" cy="17.5" r="2"/></svg>
          </div>
          <div class="truck-label">${esc(u.name)}${chip(u)}</div>
        </div>`,
    });
  }

  // Other drivers within 30 km of this one, nearest first (straight-line distance).
  const NEARBY_KM = 30;
  function nearbyHtml(u) {
    const here = [u.location.lat, u.location.lng];
    const near = [...users.values()]
      .filter((o) => o.id !== u.id && o.role !== 'admin' && o.location)
      .map((o) => ({ o, m: map.distance(here, [o.location.lat, o.location.lng]) }))
      .filter((x) => x.m <= NEARBY_KM * 1000)
      .sort((a, b) => a.m - b.m);
    if (!near.length) return `<div class="nearby"><b>Nearby (${NEARBY_KM} km)</b><br><span class="muted">No other drivers</span></div>`;
    return `<div class="nearby"><b>Nearby (${NEARBY_KM} km, straight line)</b>
      ${near.map(({ o, m }) => `<button class="link near" data-near="${o.id}">${esc(o.name)}</button>
        <span>≈ ${distance(m)}</span> ${chip(o)}${isLive(o) ? '' : ` <span class="muted">seen ${ago(o.location.at)}</span>`}`).join('<br>')}
    </div>`;
  }

  function popupHtml(u) {
    const speed = kmh(u);
    return `<b>${esc(u.name)}</b><br>
      ${esc(ROLES[u.role] || u.role)} · ${esc(u.phone)}<br>
      ${chip(u)} · updated ${ago(u.location.at)}
      ${speed != null ? `<br>${isLive(u) ? 'Speed' : 'Last speed'}: <b>${speedText(speed)}</b>` : ''}
      ${u.location.accuracy != null ? `<br>Accuracy: ±${Math.round(u.location.accuracy)} m` : ''}
      ${u.battery != null ? `<br>Battery: ${u.battery}%` : ''}<br>
      ${nearbyHtml(u)}
      <button class="link" data-history="${u.id}">Show history</button> ·
      <a href="https://www.google.com/maps?q=${u.location.lat},${u.location.lng}" target="_blank" rel="noopener">Open in Google Maps</a>`;
  }

  function renderMarker(u) {
    let m = markers.get(u.id);
    if (!u.location || u.role === 'admin') {
      if (m) { m.remove(); markers.delete(u.id); }
      return;
    }
    const latlng = [u.location.lat, u.location.lng];
    if (!m) {
      m = L.marker(latlng, { icon: truckIcon(u) }).addTo(fleetLayer).bindPopup(popupHtml(u));
      m.on('click', () => select(u.id, false));
      markers.set(u.id, m);
      if (!userMovedMap) fitAll();
    } else {
      m.setLatLng(latlng);
      m.setIcon(truckIcon(u));
      m.setPopupContent(popupHtml(u));
    }
    m.setZIndexOffset(isLive(u) ? 1000 : 0);
  }

  function fitAll() {
    const pts = [...markers.values()].map((m) => m.getLatLng());
    if (!pts.length) return;
    if (pts.length === 1) map.setView(pts[0], 14);
    else map.fitBounds(L.latLngBounds(pts), { padding: [60, 60], maxZoom: 15 });
  }

  // Was the driver's SIM found in the phone they use? (Checked by the app.)
  const SIM_BADGE = {
    verified: ['ok', 'SIM ✓', 'The SIM of this number is in the phone'],
    unverified: ['unknown', 'SIM not checked', "This phone's SIM doesn't store its number, so it couldn't be checked"],
    mismatch: ['bad', 'Wrong SIM', 'The SIM of this number is not in the phone'],
  };
  function simBadge(u) {
    const b = SIM_BADGE[u.sim];
    return b ? ` <span class="sim-badge sim-${b[0]}" title="${b[2]}">${b[1]}</span>` : '';
  }

  // ---------- list ----------
  function renderList() {
    // Don't rebuild the list while the admin has a role dropdown open.
    if (document.activeElement && document.activeElement.tagName === 'SELECT' && listEl.contains(document.activeElement)) return;
    const q = searchEl.value.trim().toLowerCase();
    const drivers = [...users.values()].filter((u) => u.role !== 'admin');
    document.getElementById('s-total').textContent = drivers.length;
    document.getElementById('s-active').textContent = drivers.filter((u) => statusOf(u) === 'active').length;
    document.getElementById('s-idle').textContent = drivers.filter((u) => statusOf(u) === 'idle').length;

    const rows = [...users.values()]
      .filter((u) => !q || u.name.toLowerCase().includes(q) || u.phone.includes(q) || (u.email || '').toLowerCase().includes(q))
      .sort((a, b) => (b.role === 'admin') - (a.role === 'admin')
        || STATUS_ORDER[statusOf(a)] - STATUS_ORDER[statusOf(b)]
        || a.name.localeCompare(b.name));

    listEl.innerHTML = rows.map((u) => {
      const self = me && u.id === me.id;
      const st = statusOf(u);
      const state = u.role === 'admin' ? '' : { active: 'on', idle: 'warn', alert: 'bad' }[st] || '';
      const contact = esc(u.phone || u.email || 'no phone yet');
      const meta = u.role === 'admin'
        ? `${contact} · not tracked`
        : `${contact} · ${chip(u)}${st === 'offline' || st === 'alert' ? ` seen ${ago(u.location.at)}` : ''}${simBadge(u)}`;
      const options = Object.entries(ROLES)
        .map(([k, v]) => `<option value="${k}" ${k === u.role ? 'selected' : ''}>${v}</option>`)
        .join('');
      return `
        <div class="user ${u.id === selectedId ? 'selected' : ''}" data-id="${u.id}">
          <span class="dot ${state}"></span>
          <div class="name">${esc(u.name)}${self ? '<span class="badge">You</span>' : ''}</div>
          <div class="meta">${meta}</div>
          ${self ? '' : `<div class="controls">
            <select data-role="${u.id}" aria-label="Role for ${esc(u.name)}">${options}</select>
            ${u.role === 'admin' ? '' : `<button class="del" data-history="${u.id}" title="Trip history">History</button>`}
            ${u.email ? `<button class="del" data-reset="${u.id}" title="Set a new password">🔑</button>` : ''}
            <button class="del" data-del="${u.id}" title="Remove user">✕</button>
          </div>`}
        </div>`;
    }).join('') || '<p class="hint">No users yet. Ask drivers to create an account.</p>';
  }

  function select(id, pan = true) {
    selectedId = id;
    userMovedMap = true;
    const u = users.get(id);
    const m = markers.get(id);
    if (u && m && map.hasLayer(fleetLayer)) {
      if (pan) map.setView(m.getLatLng(), Math.max(map.getZoom(), 14));
      m.openPopup();
      sidebar.classList.remove('open');
    }
    renderList();
  }

  listEl.addEventListener('click', (e) => {
    if (e.target.closest('select, button')) return;
    const row = e.target.closest('.user');
    if (row) select(row.dataset.id);
  });

  let handingOver = false;
  const passwordRule = (v) => (v.length < 6 ? 'Password must be at least 6 characters' : '');

  listEl.addEventListener('change', async (e) => {
    const id = e.target.dataset.role;
    if (!id) return;
    const u = users.get(id);
    const role = e.target.value;
    const undo = () => { e.target.value = u.role; renderList(); };
    if (role === 'admin') {
      const sure = await Ibraya.dialog({
        title: `Make ${u.name} the admin?`,
        message: 'There can only be one admin. You will lose admin access and become a Driver.',
        okText: 'Make admin',
      });
      if (!sure) return undo();
      // Drivers sign in with just their phone, but the admin must use a password: set one for them.
      const password = await Ibraya.dialog({
        title: `Choose a password for ${u.name}`,
        message: 'They will sign in as admin with their phone number and this password.',
        okText: 'Continue',
        input: { type: 'text', placeholder: 'At least 6 characters', validate: passwordRule },
      });
      if (password == null) return undo();
      try {
        await Ibraya.account('reset-password', { userId: id, password });
      } catch (err) {
        await Ibraya.message('Could not set the password', Ibraya.friendlyError(err));
        return undo();
      }
      handingOver = true;
      const { data, error } = await sb.rpc('admin_set_role', { p_user: id, p_role: role });
      if (error) {
        handingOver = false;
        await Ibraya.message('Could not change the role', Ibraya.friendlyError(error));
        return undo();
      }
      users.set(id, fromRow(data));
      await Ibraya.message(`${u.name} is now the admin`,
        `Tell them: tap "Admin? Sign in with password", then use their phone number and the password: ${password}`);
      return location.replace('/driver'); // you handed admin over
    }
    const { data, error } = await sb.rpc('admin_set_role', { p_user: id, p_role: role });
    if (error) {
      await Ibraya.message('Could not change the role', Ibraya.friendlyError(error));
      return undo();
    }
    users.set(id, fromRow(data));
    e.target.blur();
    renderList();
  });
  listEl.addEventListener('focusout', () => setTimeout(renderList, 0));

  listEl.addEventListener('click', async (e) => {
    const id = e.target.dataset.del;
    if (!id) return;
    const u = users.get(id);
    const sure = await Ibraya.dialog({
      title: `Remove ${u.name}?`,
      message: `${u.phone || u.email}\nThey will need to sign up again to use the app.`,
      okText: 'Remove',
      danger: true,
    });
    if (!sure) return;
    try {
      await Ibraya.account('delete-user', { userId: id });
      removeUser(id);
    } catch (err) {
      await Ibraya.message('Could not remove', Ibraya.friendlyError(err));
    }
  });

  // For email/Google accounts that forgot their password (drivers sign in by phone, no password).
  listEl.addEventListener('click', async (e) => {
    const id = e.target.dataset.reset;
    if (!id) return;
    const u = users.get(id);
    const password = await Ibraya.dialog({
      title: `New password for ${u.name}`,
      message: 'They will be signed out and must sign in with this password.',
      okText: 'Set password',
      input: { type: 'text', placeholder: 'At least 6 characters', validate: passwordRule },
    });
    if (password == null) return;
    try {
      await Ibraya.account('reset-password', { userId: id, password });
      await Ibraya.message('Password changed', `Tell ${u.name} their new password: ${password}`);
    } catch (err) {
      await Ibraya.message('Could not change the password', Ibraya.friendlyError(err));
    }
  });

  // ---------- side panels: drivers / alerts / history ----------
  const $ = (id) => document.getElementById(id);
  const PANELS = ['view-fleet', 'view-alerts', 'view-history'];
  function showPanel(id) {
    PANELS.forEach((p) => ($(p).hidden = p !== id));
    if (id !== 'view-history') closeHistory();
    if (id === 'view-alerts') renderAlerts();
    sidebar.classList.add('open');
  }
  document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => showPanel('view-fleet')));
  $('bell').addEventListener('click', () => showPanel($('view-alerts').hidden ? 'view-alerts' : 'view-fleet'));

  // Nearby driver in a popup: jump to that truck.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-near]');
    if (!btn) return;
    e.preventDefault();
    select(btn.dataset.near);
  });

  // History buttons in the list and in map popups.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-history]');
    if (!btn) return;
    e.preventDefault();
    openHistory(btn.dataset.history, btn.dataset.day ? Number(btn.dataset.day) : Date.now());
  });

  // ---------- alerts ----------
  const OFFLINE_ALERT_MS = 30 * 60 * 1000; // no signal for 30 min
  const STOP_ALERT_MS = 60 * 60 * 1000;    // standing still for 1 hour
  const NO_GPS_ALERT_MS = 10 * 60 * 1000;  // "no GPS" can be a tunnel or a parking garage: wait 10 min
  const ALERT_TEXT = {
    location_off: 'Turned off location',
    no_gps: 'No GPS signal',
    phone_off: 'Switched the phone off',
    battery_dead: 'Battery died',
    wrong_sim: "Number's SIM is not in the phone",
    signed_out: 'Signed out of the app',
    no_signal: 'No signal',
    long_stop: 'Stopped',
  };
  let incidents = new Map(); // finished incidents of the last 24 h, from the database
  let knownAlerts = null;    // alert keys already seen (no sound for those)
  let soundOn = true;
  try { soundOn = localStorage.getItem('ibraya-alert-sound') !== 'off'; } catch { /* private mode */ }

  // What needs the admin's attention right now, worked out from the live data.
  function activeAlerts() {
    const now = Date.now();
    const list = [];
    users.forEach((u) => {
      if (u.role === 'admin' || !u.location) return;
      if (u.sim === 'mismatch') list.push({ u, kind: 'wrong_sim', since: u.simAt || now });
      if (u.problem && (u.problem !== 'no_gps' || now - u.problemAt >= NO_GPS_ALERT_MS)) {
        list.push({ u, kind: u.problem, since: u.problemAt || u.location.at, battery: u.battery });
      } else if (!isLive(u) && now - u.location.at >= OFFLINE_ALERT_MS) {
        list.push({ u, kind: 'no_signal', since: u.location.at });
      } else if (isLive(u) && u.stoppedSince && now - u.stoppedSince >= STOP_ALERT_MS) {
        list.push({ u, kind: 'long_stop', since: u.stoppedSince });
      }
    });
    return list.sort((a, b) => b.since - a.since);
  }

  function beep() {
    if (!soundOn) return;
    try {
      const ctx = beep.ctx || (beep.ctx = new (window.AudioContext || window.webkitAudioContext)());
      [0, 0.25].forEach((delay, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = i ? 660 : 880;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime + delay);
        gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + delay + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + 0.22);
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime + delay);
        osc.stop(ctx.currentTime + delay + 0.25);
      });
    } catch { /* no audio */ }
  }
  // Browsers only allow sound after the page has been clicked once.
  document.addEventListener('pointerdown', () => { if (beep.ctx) beep.ctx.resume(); }, { once: false, passive: true });

  function renderSoundToggle() {
    $('sound-toggle').textContent = soundOn ? '🔊 Sound on' : '🔇 Sound off';
  }
  $('sound-toggle').addEventListener('click', () => {
    soundOn = !soundOn;
    try { localStorage.setItem('ibraya-alert-sound', soundOn ? 'on' : 'off'); } catch { /* ignore */ }
    renderSoundToggle();
    if (soundOn) beep();
  });
  renderSoundToggle();

  // "Switched the phone off (battery was 64%)": shows it wasn't a dead battery.
  const batteryNote = (kind, battery) => (battery != null && kind === 'phone_off'
    ? ` (battery was ${battery}%)` : '');

  function alertRow({ u, kind, since, until, moved, battery }) {
    const name = esc(u ? u.name : 'Removed driver');
    const time = until
      ? `${when(since)}–${hm(until)} (${duration(until - since)})`
      : `since ${when(since)} (${duration(Date.now() - since)})`;
    const movedText = moved != null && moved >= 200 ? ` · moved ${distance(moved)}` : '';
    const sev = kind === 'long_stop' || kind === 'no_gps' || kind === 'battery_dead' ? 'warn' : 'bad';
    return `<div class="alert-row ${sev}">
        <div><b>${name}</b> · ${ALERT_TEXT[kind]}${batteryNote(kind, battery)}</div>
        <div class="meta">${time}${movedText}</div>
        ${u ? `<div class="controls">
          ${until ? '' : `<button class="del" data-locate="${u.id}">Map</button>`}
          <button class="del" data-history="${u.id}" data-day="${since}">History</button>
        </div>` : ''}
      </div>`;
  }

  function renderAlerts() {
    const now = activeAlerts();
    // Sound + badge for alerts that weren't there before.
    const keys = new Set(now.map((a) => `${a.u.id}|${a.kind}|${a.since}`));
    if (knownAlerts && [...keys].some((k) => !knownAlerts.has(k))) beep();
    knownAlerts = keys;
    const count = $('bell-count');
    count.textContent = now.length;
    count.hidden = !now.length;
    $('bell').classList.toggle('ringing', now.length > 0);
    if ($('view-alerts').hidden) return;
    $('alerts-now').innerHTML = now.map(alertRow).join('') || '<p class="hint">All good. No problems right now.</p>';
    const dayAgo = Date.now() - 24 * 3600 * 1000;
    const earlier = [...incidents.values()]
      .filter((i) => i.ended_at && Date.parse(i.ended_at) >= dayAgo)
      .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))
      .map((i) => alertRow({
        u: users.get(i.user_id), kind: i.kind, since: Date.parse(i.started_at),
        until: Date.parse(i.ended_at), moved: i.moved_m, battery: i.battery,
      }));
    $('alerts-earlier').innerHTML = earlier.join('') || '<p class="hint">Nothing in the last 24 hours.</p>';
  }

  $('view-alerts').addEventListener('click', (e) => {
    const id = e.target.dataset.locate;
    if (!id) return;
    showPanel('view-fleet');
    select(id);
  });

  async function loadIncidents() {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data, error } = await sb.from('tracking_incidents').select('*')
      .or(`ended_at.gte.${since},ended_at.is.null`).order('started_at', { ascending: false }).limit(300);
    if (error) return;
    incidents = new Map(data.map((i) => [i.id, i]));
    renderAlerts();
  }

  // ---------- trip history ----------
  const GAP_MS = 5 * 60 * 1000;      // the app saves a point at least every 2 min: a longer silence is a gap
  const STOP_MIN_MS = 3 * 60 * 1000; // standing still at least this long counts as a stop
  const MOVING_MPS = ACTIVE_KMH / 3.6;
  const historyLayer = L.layerGroup();
  const ROUTE_COLOR = '#2563eb';
  let history = null; // { id, day, points, entries }
  let historyTimer = null;

  const metres = (a, b) => map.distance([a.lat, a.lng], [b.lat, b.lng]);
  const dayStart = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const toInput = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const fromInput = (v) => { const [y, m, d] = v.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };

  // Points -> drives, stops and gaps (times when nothing arrived), in time order.
  function buildTimeline(points, incidentList) {
    const entries = [];
    let totalM = 0;
    // Distance between two saved points, ignoring GPS jumps (> 250 km/h).
    const step = (a, b) => { const d = metres(a, b); return d / Math.max((b.t - a.t) / 1000, 1) < 70 ? d : 0; };

    const segments = [];
    points.forEach((p, i) => {
      if (!i || p.t - points[i - 1].t > GAP_MS) segments.push([]);
      segments[segments.length - 1].push(p);
    });

    segments.forEach((seg, n) => {
      const speedAt = (i) => (seg[i].speed != null ? seg[i].speed
        : i ? metres(seg[i - 1], seg[i]) / Math.max((seg[i].t - seg[i - 1].t) / 1000, 1) : 0);
      for (let i = 1; i < seg.length; i++) totalM += step(seg[i - 1], seg[i]);

      // Stops: runs of standing-still points lasting at least STOP_MIN_MS.
      const stops = [];
      for (let i = 0; i < seg.length; i++) {
        if (speedAt(i) >= MOVING_MPS) continue;
        let j = i;
        while (j + 1 < seg.length && speedAt(j + 1) < MOVING_MPS) j++;
        const to = j + 1 < seg.length ? seg[j + 1].t : seg[j].t; // until it moved again
        if (to - seg[i].t >= STOP_MIN_MS) stops.push({ s: i, e: j, from: seg[i].t, to });
        i = j;
      }
      const addDrive = (a, b, from) => {
        if (b <= a) return;
        const pts = seg.slice(a, b + 1);
        let m = 0;
        for (let k = 1; k < pts.length; k++) m += step(pts[k - 1], pts[k]);
        const to = pts[pts.length - 1].t;
        if (to > from) entries.push({ type: 'drive', from, to, metres: m, points: pts });
      };
      let cursor = 0;
      let cursorT = seg[0].t;
      stops.forEach((st) => {
        addDrive(cursor, st.s, cursorT);
        entries.push({ type: 'stop', from: st.from, to: st.to, at: seg[st.s] });
        cursor = st.e;
        cursorT = st.to;
      });
      addDrive(cursor, seg.length - 1, cursorT);

      const next = segments[n + 1];
      if (next) {
        const a = seg[seg.length - 1];
        const b = next[0];
        // What the app reported during the silence (location off, phone off, ...).
        const why = incidentList.filter((x) => x.kind !== 'long_stop' && x.kind !== 'no_signal'
          && Date.parse(x.started_at) <= b.t && (x.ended_at ? Date.parse(x.ended_at) : Infinity) >= a.t);
        entries.push({ type: 'gap', from: a.t, to: b.t, moved: metres(a, b), a, b, why });
      }
    });
    return { entries, totalM };
  }

  const short = (ms) => { const min = Math.round(ms / 60000); return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${min % 60}m`; };

  // On phones the driver sheet covers the lower part of the map: fit the route above it.
  const fitPadding = () => (window.innerWidth <= 800
    ? { paddingTopLeft: [30, 30], paddingBottomRight: [30, sidebar.offsetHeight + 20] }
    : { padding: [50, 50] });

  function summaryHtml(entries, totalM) {
    const sum = (type) => entries.filter((e) => e.type === type).reduce((n, e) => n + (e.to - e.from), 0);
    return [
      ['Distance', distance(totalM)],
      ['Driving', short(sum('drive'))],
      ['Stopped', short(sum('stop'))],
      ['No signal', short(sum('gap'))],
    ].map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join('');
  }

  function entryHtml(e, i) {
    const range = `${hm(e.from)}–${hm(e.to)}`;
    if (e.type === 'drive') {
      return `<div class="tl drive" data-entry="${i}"><b>Drove ${distance(e.metres)}</b><span>${range} · ${duration(e.to - e.from)}</span></div>`;
    }
    if (e.type === 'stop') {
      return `<div class="tl stop" data-entry="${i}"><b>Stopped ${duration(e.to - e.from)}</b><span>${range}</span></div>`;
    }
    if (e.type === 'gap') {
      const why = e.why.map((x) => `${ALERT_TEXT[x.kind]}${batteryNote(x.kind, x.battery)} at ${hm(Date.parse(x.started_at))}`).join(' · ');
      return `<div class="tl gap" data-entry="${i}"><b>No signal ${duration(e.to - e.from)}</b><span>${range}${e.moved >= 200 ? ` · truck moved <b>${distance(e.moved)}</b> meanwhile` : ''}</span>${why ? `<span class="why">${why}</span>` : ''}</div>`;
    }
    return `<div class="tl ${e.type}" data-entry="${i}"><b>${e.title}</b><span>${e.text}</span></div>`;
  }

  const dotIcon = (cls, label) => L.divIcon({ className: '', iconSize: [18, 18], iconAnchor: [9, 9], html: `<div class="hist-dot ${cls}">${label || ''}</div>` });

  function drawHistory() {
    historyLayer.clearLayers();
    const { points, entries } = history;
    if (!points.length) return;
    const latlngs = (pts) => pts.map((p) => [p.lat, p.lng]);
    entries.forEach((e, i) => {
      let layer;
      if (e.type === 'drive') {
        layer = L.polyline(latlngs(e.points), { color: ROUTE_COLOR, weight: 5, opacity: 0.85 });
        layer.on('click', (ev) => {
          // Exact time at the clicked spot: the nearest saved point.
          let best = e.points[0];
          e.points.forEach((p) => { if (map.distance(ev.latlng, [p.lat, p.lng]) < map.distance(ev.latlng, [best.lat, best.lng])) best = p; });
          L.popup().setLatLng([best.lat, best.lng])
            .setContent(`<b>${hms(best.t)}</b>${best.speed != null ? `<br>${speedText(Math.round(best.speed * 3.6))}` : ''}`)
            .openOn(map);
        });
      } else if (e.type === 'stop') {
        layer = L.marker([e.at.lat, e.at.lng], { icon: dotIcon('stop', 'P') })
          .bindPopup(`<b>Stopped ${duration(e.to - e.from)}</b><br>${hm(e.from)}–${hm(e.to)}`);
      } else if (e.type === 'gap') {
        layer = L.polyline(latlngs([e.a, e.b]), { color: '#d93838', weight: 3, dashArray: '6 8' })
          .bindPopup(`<b>No signal ${duration(e.to - e.from)}</b><br>${hm(e.from)}–${hm(e.to)}<br>Moved ${distance(e.moved)} (straight line)`);
      }
      if (layer) { layer.entry = i; historyLayer.addLayer(layer); e.layer = layer; }
    });
    const first = points[0];
    const last = points[points.length - 1];
    historyLayer.addLayer(L.marker([first.lat, first.lng], { icon: dotIcon('start', 'A'), zIndexOffset: 500 }).bindPopup(`<b>First point</b><br>${hms(first.t)}`));
    historyLayer.addLayer(L.marker([last.lat, last.lng], { icon: dotIcon('end', 'B'), zIndexOffset: 500 }).bindPopup(`<b>Last point</b><br>${hms(last.t)}`));
  }

  async function loadHistory(fit) {
    const { id, day } = history;
    const from = dayStart(day);
    const to = from + 24 * 3600 * 1000;
    $('history-list').innerHTML = '<p class="hint">Loading…</p>';
    const { data, error } = await sb.rpc('get_driver_history', {
      p_user: id, p_from: new Date(from).toISOString(), p_to: new Date(to).toISOString(),
    });
    if (!history || history.id !== id || history.day !== day) return; // the admin moved on
    if (error) {
      $('history-list').innerHTML = `<p class="error">${esc(Ibraya.friendlyError(error))}</p>`;
      return;
    }
    const points = data.points.map(([t, lat, lng, speed]) => ({ t: t * 1000, lat, lng, speed }));
    const { entries, totalM } = buildTimeline(points, data.incidents);
    // Still silent now (today only): show it at the end.
    const u = users.get(id);
    const lastT = points.length ? points[points.length - 1].t : null;
    const openIncident = data.incidents.find((x) => !x.ended_at);
    if (openIncident) {
      entries.push({ type: 'now', title: `${ALERT_TEXT[openIncident.kind]}${batteryNote(openIncident.kind, openIncident.battery)}`, text: `since ${when(Date.parse(openIncident.started_at))}, still now` });
    } else if (sameDay(day, Date.now()) && u && lastT && !isLive(u) && Date.now() - lastT > GAP_MS) {
      entries.push({ type: 'now', title: 'No signal', text: `since ${hm(lastT)} (${duration(Date.now() - lastT)}), still now` });
    }
    history.points = points;
    history.entries = entries;
    $('history-summary').innerHTML = summaryHtml(entries, totalM);
    $('history-list').innerHTML = points.length
      ? `<div class="tl start"><b>First point ${hms(points[0].t)}</b></div>
         ${entries.map(entryHtml).join('')}
         <div class="tl end"><b>Last point ${hms(lastT)}</b></div>`
      : `${entries.map(entryHtml).join('')}<p class="hint">No route saved on this day.</p>`;
    drawHistory();
    if (fit && points.length) map.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lng])), { ...fitPadding(), maxZoom: 16 });
  }

  function openHistory(id, day) {
    const u = users.get(id);
    if (!u) return;
    map.closePopup();
    history = { id, day: dayStart(day), points: [], entries: [] };
    $('history-name').textContent = u.name;
    $('day').max = toInput(Date.now());
    $('day').value = toInput(history.day);
    $('day-next').disabled = sameDay(history.day, Date.now());
    PANELS.forEach((p) => ($(p).hidden = p !== 'view-history'));
    sidebar.classList.add('open');
    map.removeLayer(fleetLayer);
    historyLayer.addTo(map);
    loadHistory(true);
    clearInterval(historyTimer);
    // Today's route keeps growing: refresh it every minute.
    historyTimer = setInterval(() => { if (history && sameDay(history.day, Date.now())) loadHistory(false); }, 60000);
  }

  function closeHistory() {
    if (!history) return;
    history = null;
    clearInterval(historyTimer);
    historyLayer.clearLayers();
    map.removeLayer(historyLayer);
    fleetLayer.addTo(map);
  }

  function changeDay(ms) {
    if (!history || ms > Date.now()) return;
    openHistory(history.id, ms);
  }
  $('day').addEventListener('change', (e) => { if (e.target.value) changeDay(fromInput(e.target.value)); });
  $('day-prev').addEventListener('click', () => history && changeDay(history.day - 12 * 3600 * 1000));
  $('day-next').addEventListener('click', () => history && changeDay(history.day + 36 * 3600 * 1000));

  $('history-list').addEventListener('click', (e) => {
    const row = e.target.closest('[data-entry]');
    if (!row || !history) return;
    const entry = history.entries[Number(row.dataset.entry)];
    if (!entry || !entry.layer) return;
    if (entry.layer.getBounds) map.fitBounds(entry.layer.getBounds(), { padding: [60, 60], maxZoom: 16 });
    else map.setView(entry.layer.getLatLng(), Math.max(map.getZoom(), 15));
    if (entry.layer.getPopup()) entry.layer.openPopup();
    sidebar.classList.remove('open');
  });

  searchEl.addEventListener('input', renderList);
  document.getElementById('toggle').addEventListener('click', () => sidebar.classList.toggle('open'));
  document.getElementById('logout').addEventListener('click', () => Ibraya.signOut());

  // ---------- data + realtime ----------
  function upsertUser(row) {
    const u = fromRow(row);
    // Lost admin (handed over): go to the driver page, unless we're still showing the handover message.
    if (me && u.id === me.id && u.role !== 'admin' && !handingOver) return location.replace('/driver');
    users.set(u.id, u);
    renderMarker(u);
  }

  function removeUser(id) {
    users.delete(id);
    const m = markers.get(id);
    if (m) { m.remove(); markers.delete(id); }
    renderList();
  }

  async function loadAll() {
    const { data, error } = await sb.from('profiles').select('*');
    if (error) return;
    const seen = new Set();
    data.forEach((row) => { seen.add(row.id); upsertUser(row); });
    [...users.keys()].filter((id) => !seen.has(id)).forEach(removeUser);
    renderList();
    renderAlerts();
  }

  me = await Ibraya.guard('/admin');
  if (!me) return;
  // The admin isn't tracked: if this is the Ibraya app on the admin's phone, stop its tracking.
  if (Ibraya.tracker) {
    sb.rpc('unregister_my_tracker_devices').then(() => {}, () => {});
    Ibraya.tracker.stop().catch(() => {});
  }
  sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') Ibraya.toLogin();
  });

  // The database only sends the admin these changes (row-level security).
  sb.channel('fleet')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, (payload) => {
      if (payload.eventType === 'DELETE') removeUser(payload.old.id);
      else { upsertUser(payload.new); renderList(); }
      renderAlerts();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tracking_incidents' }, (payload) => {
      if (payload.eventType === 'DELETE') incidents.delete(payload.old.id);
      else incidents.set(payload.new.id, payload.new);
      renderAlerts();
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') { loadAll(); loadIncidents(); } // (re)load everything after (re)connecting
    });

  await loadAll();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { loadAll(); loadIncidents(); }
  });

  // Refresh "x min ago" labels and grey out stale trucks.
  setInterval(() => { users.forEach(renderMarker); renderList(); renderAlerts(); }, 15000);
})();
