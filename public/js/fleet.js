// Transport Hub: a carrier's own fleet map (Hub → Fleet map). Every driver of the company with
// where they are now and the job they're on. Refreshes every 15 seconds while it's open.
window.HubFleet = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const localPhone = (p) => (p && p.startsWith('+92') ? '0' + p.slice(3) : p || '');
  const ago = (t) => {
    const m = Math.round((Date.now() - new Date(t)) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
    return `${Math.round(m / 1440)} days ago`;
  };
  const TRIP = { assigned: 'Going to pickup', at_pickup: 'At pickup', loaded: 'Loaded, on the way', at_drop: 'At destination' };
  const PROBLEM = { location_off: 'Location turned off', no_gps: 'No GPS signal', phone_off: 'Phone switched off', battery_dead: 'Battery died', signed_out: 'Signed out of the app' };
  const OFFLINE_MS = 10 * 60 * 1000;

  // live (moving or parked), job, offline, problem
  function state(d) {
    if (d.problem) return 'problem';
    if (!d.at || Date.now() - new Date(d.at) > OFFLINE_MS) return 'offline';
    return d.trip ? 'job' : 'live';
  }
  const STATE_LABEL = { job: 'On a job', live: 'Free', offline: 'Offline', problem: 'Problem' };

  let map = null;
  let layer = null;
  let timer = null;
  let fitted = false;
  let ctx = null;

  async function refresh() {
    clearTimeout(timer);
    const box = document.getElementById('fleet');
    if (!box) { if (map) { map.remove(); map = null; } return; }
    let drivers;
    try { drivers = await ctx.rpc('my_fleet'); } catch (err) {
      document.getElementById('fleet-list').innerHTML = `<p class="error">${esc(Ibraya.friendlyError(err))}</p>`;
      return;
    }
    if (!document.getElementById('fleet')) return;
    const counts = { job: 0, live: 0, offline: 0, problem: 0 };
    drivers.forEach((d) => counts[state(d)]++);
    document.getElementById('fleet-counts').innerHTML = Object.entries(counts)
      .map(([k, n]) => `<span class="fleet-chip ${k}">${STATE_LABEL[k]} <b>${n}</b></span>`).join('');
    const list = document.getElementById('fleet-list');
    list.innerHTML = drivers.length ? drivers.map((d) => {
      const s = state(d);
      return `<div class="row fleet-row ${s}" data-driver="${d.id}">
        <div class="row-main"><b>${esc(d.name)}</b> <span class="fleet-chip ${s}">${STATE_LABEL[s]}</span>
          <div class="muted small"><a href="tel:${esc(d.phone)}">${esc(localPhone(d.phone))}</a>
            ${d.at ? ` · seen ${ago(d.at)}` : ' · never tracked'}${d.speed > 1.4 ? ` · ${Math.round(d.speed * 3.6)} km/h` : ''}${d.battery != null ? ` · 🔋 ${d.battery}%` : ''}</div>
          ${d.problem ? `<div class="small error-text">⚠ ${esc(PROBLEM[d.problem] || d.problem)}</div>` : ''}
          ${d.trip ? `<div class="small">${esc(TRIP[d.trip.status])} · <button class="link" data-load="${d.trip.load_id}">${esc(d.trip.route)}</button></div>` : ''}</div>
      </div>`;
    }).join('') : '<p class="muted">No drivers yet. Add your drivers in the Team tab; they sign in to the app with their phone number.</p>';
    list.querySelectorAll('[data-load]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); ctx.openLoad(b.dataset.load); }));
    list.querySelectorAll('[data-driver]').forEach((r) => r.addEventListener('click', () => {
      const d = drivers.find((x) => x.id === r.dataset.driver);
      if (d && d.lat != null && map) map.setView([d.lat, d.lng], 14);
    }));

    if (!map && window.L) {
      map = L.map('fleet-map', { zoomControl: true }).setView([30.3753, 69.3451], 5);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
      layer = L.layerGroup().addTo(map);
    }
    if (map) {
      layer.clearLayers();
      const pts = [];
      drivers.filter((d) => d.lat != null).forEach((d) => {
        const p = [d.lat, d.lng];
        pts.push(p);
        L.marker(p, { icon: L.divIcon({ className: `trip-pin fleet-${state(d)}`, html: `<span>🚚 ${esc(d.name)}</span>`, iconSize: null }) })
          .bindPopup(`<b>${esc(d.name)}</b><br>${STATE_LABEL[state(d)]}${d.trip ? `: ${esc(d.trip.route)}` : ''}<br>${d.at ? 'Seen ' + ago(d.at) : ''}`)
          .addTo(layer);
      });
      if (!fitted && pts.length) {
        if (pts.length === 1) map.setView(pts[0], 12); else map.fitBounds(pts, { padding: [30, 30] });
        fitted = true;
      }
      setTimeout(() => map && map.invalidateSize(), 50);
    }
    if (document.visibilityState === 'visible') timer = setTimeout(refresh, 15000);
  }

  function render(body, context) {
    ctx = context;
    if (map) { map.remove(); map = null; }
    fitted = false;
    body.innerHTML = `
      <div class="panel-card" id="fleet">
        <div class="card-head"><h2>Your fleet · آپ کے ٹرک</h2><button class="btn btn-ghost btn-small" id="fleet-refresh">↻ Refresh</button></div>
        <div class="fleet-counts" id="fleet-counts"></div>
        <div class="fleet-map" id="fleet-map"></div>
        <div class="rows" id="fleet-list"><p class="muted">Loading…</p></div>
      </div>`;
    body.querySelector('#fleet-refresh').addEventListener('click', refresh);
    refresh();
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && document.getElementById('fleet')) refresh(); });

  return { render };
})();
