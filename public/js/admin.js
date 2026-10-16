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
  // Speed is only "current" while the truck is live; otherwise it's the last reported speed.
  const liveKmh = (u) => (isLive(u) ? kmh(u) : null);
  const speedText = (v) => (v === 0 ? 'Stopped' : `${v} km/h`);

  // ---------- map ----------
  const map = L.map('map', { zoomControl: false }).setView([30.3753, 69.3451], 5);
  L.control.zoom({ position: 'topright' }).addTo(map);
  // OpenStreetMap Germany's tiles: free, no API key, and they label places in both the
  // local script and Latin letters (e.g. "لاہور Lahore"). Dark mode darkens them with a CSS filter.
  L.tileLayer('https://tile.openstreetmap.de/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  }).addTo(map);

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
        <div class="truck ${isLive(u) ? '' : 'offline'}">
          <div class="pulse"></div>
          <div style="position:absolute;inset:0;transform:rotate(${heading}deg)">
            ${showArrow ? '<div class="arrow"></div>' : ''}
          </div>
          <div class="body">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4h13v11H1z"/><path d="M14 8h4l4 4v3h-8z"/><circle cx="5.5" cy="17.5" r="2"/><circle cx="17.5" cy="17.5" r="2"/></svg>
          </div>
          <div class="truck-label">${esc(u.name)}${liveKmh(u) != null ? `<span class="truck-speed">${speedText(liveKmh(u))}</span>` : ''}</div>
        </div>`,
    });
  }

  function popupHtml(u) {
    const speed = kmh(u);
    return `<b>${esc(u.name)}</b><br>
      ${esc(ROLES[u.role] || u.role)} · ${esc(u.phone)}<br>
      ${isLive(u) ? '🟢 Live' : '⚪ Offline'} · updated ${ago(u.location.at)}
      ${speed != null ? `<br>${isLive(u) ? 'Speed' : 'Last speed'}: ${speedText(speed)}` : ''}
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
    document.getElementById('s-online').textContent = drivers.filter(isLive).length;
    document.getElementById('s-located').textContent = drivers.filter((u) => u.location).length;

    const rows = [...users.values()]
      .filter((u) => !q || u.name.toLowerCase().includes(q) || u.phone.includes(q) || (u.email || '').toLowerCase().includes(q))
      .sort((a, b) => (b.role === 'admin') - (a.role === 'admin') || isLive(b) - isLive(a) || a.name.localeCompare(b.name));

    listEl.innerHTML = rows.map((u) => {
      const self = me && u.id === me.id;
      const speed = liveKmh(u);
      const state = u.role === 'admin' ? '' : isLive(u) ? 'on' : '';
      const contact = esc(u.phone || u.email || 'no phone yet');
      const meta = u.role === 'admin'
        ? `${contact} · not tracked`
        : `${contact} · ${u.location ? `seen ${ago(u.location.at)}` : 'no location yet'}${speed != null ? ` · ${speedText(speed)}` : ''}`;
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
