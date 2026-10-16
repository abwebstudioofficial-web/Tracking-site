(() => {
  const ROLES = {
    driver: 'Driver',
    import_driver: 'Import Driver',
    export_driver: 'Export Driver',
    admin: 'Admin',
  };
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

  const isLive = (u) => u.online && u.location && Date.now() - u.location.at < STALE_MS;
  const kmh = (u) => (u.location && u.location.speed != null ? Math.round(u.location.speed * 3.6) : null);

  // ---------- map ----------
  const map = L.map('map', { zoomControl: false }).setView([30.3753, 69.3451], 5);
  L.control.zoom({ position: 'topright' }).addTo(map);
  const TILES = {
    light: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  };
  const tiles = L.tileLayer(document.documentElement.dataset.theme === 'dark' ? TILES.dark : TILES.light, {
    maxZoom: 19,
    subdomains: 'abcd',
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
  }).addTo(map);
  window.addEventListener('themechange', (e) => tiles.setUrl(e.detail === 'dark' ? TILES.dark : TILES.light));

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
          <div class="truck-label">${esc(u.name)}</div>
        </div>`,
    });
  }

  function popupHtml(u) {
    const speed = kmh(u);
    return `<b>${esc(u.name)}</b><br>
      ${esc(ROLES[u.role] || u.role)} · ${esc(u.phone)}<br>
      ${isLive(u) ? '🟢 Live' : '⚪ Offline'} · updated ${ago(u.location.at)}
      ${speed != null ? `<br>Speed: ${speed} km/h` : ''}
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
    document.getElementById('s-online').textContent = drivers.filter((u) => u.online).length;
    document.getElementById('s-located').textContent = drivers.filter((u) => u.location).length;

    const rows = [...users.values()]
      .filter((u) => !q || u.name.toLowerCase().includes(q) || u.phone.includes(q))
      .sort((a, b) => (b.role === 'admin') - (a.role === 'admin') || isLive(b) - isLive(a) || a.name.localeCompare(b.name));

    listEl.innerHTML = rows.map((u) => {
      const self = me && u.id === me.id;
      const speed = kmh(u);
      const state = u.role === 'admin' ? '' : isLive(u) ? 'on' : u.online ? 'warn' : '';
      const meta = u.role === 'admin'
        ? `${esc(u.phone)} · not tracked`
        : `${esc(u.phone)} · ${u.location ? `seen ${ago(u.location.at)}` : 'no location yet'}${speed ? ` · ${speed} km/h` : ''}`;
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
    if (row) select(Number(row.dataset.id));
  });

  listEl.addEventListener('change', async (e) => {
    const id = e.target.dataset.role;
    if (!id) return;
    const u = users.get(Number(id));
    const role = e.target.value;
    if (role === 'admin' && !confirm(
      `Make ${u.name} the admin?\n\nThere can only be one admin. You will lose admin access and become a Driver.`
    )) {
      e.target.value = u.role;
      return;
    }
    const res = await fetch(`/api/users/${id}/role`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    if (!res.ok) {
      alert((await res.json()).error || 'Could not change role');
      e.target.value = u.role;
    }
    e.target.blur();
    renderList();
  });
  listEl.addEventListener('focusout', () => setTimeout(renderList, 0));

  listEl.addEventListener('click', async (e) => {
    const id = e.target.dataset.del;
    if (!id) return;
    const u = users.get(Number(id));
    if (!confirm(`Remove ${u.name} (${u.phone})? They will need to create a new account.`)) return;
    const res = await fetch(`/api/users/${id}`, { method: 'DELETE' });
    if (!res.ok) alert((await res.json()).error || 'Could not remove user');
  });

  searchEl.addEventListener('input', renderList);
  document.getElementById('toggle').addEventListener('click', () => sidebar.classList.toggle('open'));
  document.getElementById('logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    location.href = '/login';
  });

  // ---------- realtime ----------
  fetch('/api/me')
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((d) => {
      if (d.user.role !== 'admin') return (location.href = '/driver');
      me = d.user;
      renderList();
    })
    .catch(() => (location.href = '/login'));

  const socket = io();
  socket.on('connect_error', (err) => {
    if (err.message === 'unauthorized') location.href = '/login';
  });

  socket.on('users', (list) => {
    users = new Map(list.map((u) => [u.id, u]));
    for (const id of markers.keys()) if (!users.has(id)) { markers.get(id).remove(); markers.delete(id); }
    users.forEach(renderMarker);
    renderList();
  });

  socket.on('location', ({ id, location: loc }) => {
    const u = users.get(id);
    if (!u) return;
    u.location = loc;
    u.online = true;
    renderMarker(u);
    renderList();
  });

  socket.on('presence', ({ id, online }) => {
    const u = users.get(id);
    if (!u) return;
    u.online = online;
    renderMarker(u);
    renderList();
  });

  socket.on('role:changed', (user) => {
    if (user.role !== 'admin') location.href = '/driver';
  });

  // Refresh "x min ago" labels and grey out stale trucks.
  setInterval(() => { users.forEach(renderMarker); renderList(); }, 15000);
})();
