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
    none: 'No location yet',
  };
  function statusOf(u) {
    if (!u.location) return 'none';
    if (!isLive(u)) return 'offline';
    return (kmh(u) ?? 0) >= ACTIVE_KMH ? 'active' : 'idle';
  }
  const STATUS_ORDER = { active: 0, idle: 1, offline: 2, none: 3 };
  const chip = (st) => `<span class="state-chip state-${st}">${STATUS[st]}</span>`;

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
          <div class="truck-label">${esc(u.name)}${chip(statusOf(u))}</div>
        </div>`,
    });
  }

  function popupHtml(u) {
    const speed = kmh(u);
    return `<b>${esc(u.name)}</b><br>
      ${esc(ROLES[u.role] || u.role)} · ${esc(u.phone)}<br>
      ${chip(statusOf(u))} · updated ${ago(u.location.at)}
      ${speed != null ? `<br>${isLive(u) ? 'Speed' : 'Last speed'}: <b>${speedText(speed)}</b>` : ''}
      ${u.location.accuracy != null ? `<br>Accuracy: ±${Math.round(u.location.accuracy)} m` : ''}<br>
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
      m = L.marker(latlng, { icon: truckIcon(u) }).addTo(map).bindPopup(popupHtml(u));
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
      const state = u.role === 'admin' ? '' : { active: 'on', idle: 'warn' }[st] || '';
      const contact = esc(u.phone || u.email || 'no phone yet');
      const meta = u.role === 'admin'
        ? `${contact} · not tracked`
        : `${contact} · ${chip(st)}${st === 'offline' ? ` seen ${ago(u.location.at)}` : ''}`;
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
            <button class="del" data-reset="${u.id}" title="Set a new password">🔑</button>
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
    if (u && m) {
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

  listEl.addEventListener('change', async (e) => {
    const id = e.target.dataset.role;
    if (!id) return;
    const u = users.get(id);
    const role = e.target.value;
    if (role === 'admin' && !confirm(
      `Make ${u.name} the admin?\n\nThere can only be one admin. You will lose admin access and become a Driver.`
    )) {
      e.target.value = u.role;
      return;
    }
    const { data, error } = await sb.rpc('admin_set_role', { p_user: id, p_role: role });
    if (error) {
      alert(Ibraya.friendlyError(error));
      e.target.value = u.role;
    } else {
      users.set(id, fromRow(data));
      if (role === 'admin') return location.replace('/driver'); // you handed admin over
    }
    e.target.blur();
    renderList();
  });
  listEl.addEventListener('focusout', () => setTimeout(renderList, 0));

  listEl.addEventListener('click', async (e) => {
    const id = e.target.dataset.del;
    if (!id) return;
    const u = users.get(id);
    if (!confirm(`Remove ${u.name} (${u.phone || u.email})? They will need to create a new account.`)) return;
    try {
      await Ibraya.account('delete-user', { userId: id });
      removeUser(id);
    } catch (err) {
      alert(Ibraya.friendlyError(err));
    }
  });

  // For drivers who forgot their password (phone accounts can't get reset emails).
  listEl.addEventListener('click', async (e) => {
    const id = e.target.dataset.reset;
    if (!id) return;
    const u = users.get(id);
    const password = prompt(`New password for ${u.name} (at least 6 characters).\nThey will be signed out and must sign in with this password.`);
    if (password == null) return;
    if (password.length < 6) return alert('Password must be at least 6 characters');
    try {
      await Ibraya.account('reset-password', { userId: id, password });
      alert(`Done. Tell ${u.name} their new password: ${password}`);
    } catch (err) {
      alert(Ibraya.friendlyError(err));
    }
  });

  searchEl.addEventListener('input', renderList);
  document.getElementById('toggle').addEventListener('click', () => sidebar.classList.toggle('open'));
  document.getElementById('logout').addEventListener('click', () => Ibraya.signOut());

  // ---------- data + realtime ----------
  function upsertUser(row) {
    const u = fromRow(row);
    if (me && u.id === me.id && u.role !== 'admin') return location.replace('/driver');
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
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') loadAll(); // (re)load everything after connecting or reconnecting
    });

  await loadAll();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') loadAll();
  });

  // Refresh "x min ago" labels and grey out stale trucks.
  setInterval(() => { users.forEach(renderMarker); renderList(); }, 15000);
})();
