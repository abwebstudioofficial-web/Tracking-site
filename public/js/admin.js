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
    truckSize: r.truck_size || '20ft',   // drawn as a 20ft or 40ft container
    urgency: r.urgency || 'normal',      // container colour: normal / urgent / very_urgent
    owner: !!r.is_owner,                 // the main admin: never tracked, can't be changed by other admins
    tracked: !!r.tracked,                // admins only: location shared (switched by the main admin)
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
  // Drivers are always tracked; admins only when the main admin switched it on.
  const isTracked = (u) => u.role !== 'admin' || u.tracked;
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
  // MapLibre (see js/glmap.js): drag with the right mouse button or two fingers to rotate,
  // Ctrl/two-finger drag up to tilt and see the buildings in 3D; the compass turns it back north.
  const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
  const BLANK_STYLE = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#dfe5e8' } }] };
  const map = GL.createMap('map', { center: [30.3753, 69.3451], zoom: 5, style: BLANK_STYLE });
  map.gl.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
  map.gl.addControl(new maplibregl.AttributionControl({
    compact: true,
    customAttribution: `<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> ${OSM_ATTR}`,
  }), 'bottom-right');
  // Base map: OpenFreeMap (free, no API key), drawn in the browser by MapLibre so we can
  // choose the labels: English name on top, Urdu (or other local script) underneath.
  // Falls back to plain OpenStreetMap tiles if OpenFreeMap can't be reached.
  // Our own lines (history routes, Follow live trail) are kept when the base map is swapped in.
  const keepOurLayers = (prev, next) => {
    if (!prev) return next;
    const ours = (id) => id.startsWith('ib-');
    Object.entries(prev.sources).filter(([id]) => ours(id)).forEach(([id, src]) => { next.sources[id] = src; });
    next.layers.push(...prev.layers.filter((l) => ours(l.id)));
    return next;
  };

  function bilingualLabel(separator) {
    return ['let',
      'en', ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name:latin'], ['get', 'name']],
      'local', ['coalesce', ['get', 'name:ur'], ['get', 'name:nonlatin'], ''],
      ['case',
        ['all', ['!=', ['var', 'local'], ''], ['!=', ['var', 'local'], ['var', 'en']]],
        ['concat', ['var', 'en'], separator, ['var', 'local']],
        ['var', 'en']]];
  }

  // Roads first: wider roads, clearer road names and highway numbers, faint flat buildings.
  // 3D buildings are off; the 🏢 button on the map turns them on.
  const ROAD = /^(road|bridge|tunnel)_(motorway|trunk_primary|secondary_tertiary|link|motorway_link|minor|street|service_track)(_casing)?$/;
  function scaleWidth(w, k) {
    if (Array.isArray(w) && w[0] === 'interpolate') return w.map((v, i) => (i > 3 && i % 2 === 1 && typeof v === 'number' ? v : (i > 3 && typeof v === 'number' ? v * k : v)));
    if (w && w.stops) return { ...w, stops: w.stops.map(([z, v]) => [z, v * k]) };
    return typeof w === 'number' ? w * k : w;
  }
  function roadsFirst(style) {
    for (const l of style.layers) {
      if (l.type === 'line' && ROAD.test(l.id) && l.paint && l.paint['line-width'] != null) {
        l.paint['line-width'] = scaleWidth(l.paint['line-width'], 1.35);
      }
      if (l.id === 'building') l.paint = { ...l.paint, 'fill-opacity': 0.35 };
      if (l.id === 'building-3d') l.layout = { ...(l.layout || {}), visibility: 'none' };
      if (/^highway-name/.test(l.id) && l.layout) {
        l.layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 12, 11, 15, 13, 18, 15];
        l.paint = { ...l.paint, 'text-color': '#1f2a33', 'text-halo-color': '#ffffff', 'text-halo-width': 2 };
        if (l.id === 'highway-name-minor') l.minzoom = 14;
        if (l.id === 'highway-name-path') l.minzoom = 16;
      }
      if (/^poi_/.test(l.id)) l.minzoom = Math.max(l.minzoom || 0, 16); // fewer shop icons over the roads
    }
  }
  // 🏢 button: 3D buildings on / off.
  class BuildingsControl {
    onAdd(m) {
      this.el = document.createElement('div');
      this.el.className = 'maplibregl-ctrl maplibregl-ctrl-group';
      this.el.innerHTML = '<button type="button" class="ctrl-3d" title="3D buildings on / off" aria-label="3D buildings">🏢</button>';
      this.el.querySelector('button').addEventListener('click', () => {
        if (!m.getLayer('building-3d')) return;
        const on = m.getLayoutProperty('building-3d', 'visibility') === 'none';
        m.setLayoutProperty('building-3d', 'visibility', on ? 'visible' : 'none');
        this.el.querySelector('button').classList.toggle('on', on);
        if (on && m.getPitch() < 30) m.easeTo({ pitch: 55 });
      });
      return this.el;
    }
    onRemove() { this.el.remove(); }
  }
  map.gl.addControl(new BuildingsControl(), 'top-right');

  // Google view: Google's own map (more streets and place names in Pakistan) in place of ours, at the
  // same spot. It's Google's free embedded map, so our trucks can't be drawn on it: a truck is shown
  // as Google's red pin, and the pin follows the truck while it's being followed.
  let google = null; // { id: truck shown with a pin, or null; at: [lat, lng] last shown }
  const gWrap = document.createElement('div');
  gWrap.className = 'google-view';
  gWrap.hidden = true;
  gWrap.innerHTML = `<iframe title="Google map" loading="lazy" referrerpolicy="no-referrer-when-downgrade" allowfullscreen></iframe>
    <div class="google-bar"><span id="google-what"></span><button class="btn btn-small" id="google-close">← Live map with trucks</button></div>`;
  map.getContainer().parentElement.appendChild(gWrap);
  const gFrame = gWrap.querySelector('iframe');
  const gWhat = gWrap.querySelector('#google-what');
  function showGoogle(id) {
    const u = id && users.get(id);
    const z = Math.max(3, Math.min(20, Math.round(map.getZoom()) - 1));
    let src;
    if (u && u.location) {
      const zoom = Math.max(z, 15);
      google = { id, at: [u.location.lat, u.location.lng] };
      src = `https://maps.google.com/maps?q=${u.location.lat.toFixed(6)},${u.location.lng.toFixed(6)}&z=${zoom}&hl=en&output=embed`;
      gWhat.textContent = `📍 ${u.name} on Google map · updated ${ago(u.location.at)}`;
    } else {
      const c = map.gl.getCenter();
      google = { id: null, at: [c.lat, c.lng] };
      src = `https://maps.google.com/maps?ll=${c.lat.toFixed(6)},${c.lng.toFixed(6)}&z=${z}&hl=en&output=embed`;
      gWhat.textContent = 'Google map · trucks show on the live map';
    }
    if (gFrame.src !== src) gFrame.src = src;
    gWrap.hidden = false;
    gBtn.classList.add('on');
  }
  function hideGoogle() {
    gWrap.hidden = true;
    google = null;
    gBtn.classList.remove('on');
  }
  // A shown truck that moved more than 50 m gets its pin moved (Google's map reloads).
  function googleTruckMoved(u) {
    if (!google || google.id !== u.id || !u.location) return;
    if (map.distance(google.at, [u.location.lat, u.location.lng]) > 50) showGoogle(u.id);
    else gWhat.textContent = `📍 ${u.name} on Google map · updated ${ago(u.location.at)}`;
  }
  class GoogleControl {
    onAdd() {
      this.el = document.createElement('div');
      this.el.className = 'maplibregl-ctrl maplibregl-ctrl-group';
      this.el.innerHTML = '<button type="button" class="ctrl-google" title="Google map" aria-label="Google map">G</button>';
      this.el.querySelector('button').addEventListener('click', () => {
        // On Google's map: road map ↔ satellite. On our free map: the Google view.
        if (googleSrc) {
          const next = googleSrc.type === 'satellite' ? 'roadmap' : 'satellite';
          useGoogle(next).catch(() => { GoogleMap.forget(next); });
        } else if (google) hideGoogle();
        else showGoogle(following ? following.id : null);
      });
      return this.el;
    }
    onRemove() { this.el.remove(); }
  }
  map.gl.addControl(new GoogleControl(), 'top-right');
  const gBtn = document.querySelector('.ctrl-google');
  // Map buttons that fit the base map in use: 🏢 only on our free map (it has the 3D buildings),
  // 🛰️ / 🗺️ on Google's map, G (Google view) on our free map.
  map.gl.on('style.load', () => {
    document.querySelector('.ctrl-3d').parentElement.hidden = !map.gl.getLayer('building-3d');
    if (googleSrc) {
      hideGoogle();
      const sat = googleSrc.type === 'satellite';
      gBtn.textContent = sat ? '🗺️' : '🛰️';
      gBtn.title = sat ? 'Road map' : 'Satellite';
    } else {
      gBtn.textContent = 'G';
      gBtn.title = 'Google map';
    }
  });
  gWrap.querySelector('#google-close').addEventListener('click', hideGoogle);

  // Main map: Google's (when an admin has set the Google key in Hub → Commission). Backup: our free
  // map below. Google's tiles are pictures, so they're shown as a raster layer under our trucks.
  let googleSrc = null; // the Google tiles in use, or null on our free map
  let googleErrors = 0;
  const gCredit = document.createElement('div');
  gCredit.className = 'google-credit';
  gCredit.hidden = true;
  map.getContainer().appendChild(gCredit);
  function updateGoogleCredit() {
    if (!googleSrc) return;
    const b = map.gl.getBounds();
    GoogleMap.credit(gCredit, googleSrc, { zoom: map.getZoom(), north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() });
  }
  map.on('moveend', updateGoogleCredit);
  // Dark theme on a picture map (Google road map, plain OpenStreetMap): the map image is turned
  // dark (light ↔ dark swapped, colours kept), but never our trucks or a satellite photo.
  const rasterPaint = (photo) => (document.documentElement.dataset.theme === 'dark' && !photo
    ? { 'raster-brightness-min': 0.92, 'raster-brightness-max': 0.08, 'raster-hue-rotate': 180, 'raster-saturation': -0.35, 'raster-contrast': 0.05 }
    : {});
  function paintRaster() {
    const id = ['google', 'osm'].find((x) => map.gl.getLayer(x));
    if (!id) return;
    const paint = rasterPaint(googleSrc && googleSrc.type === 'satellite');
    ['raster-brightness-min', 'raster-brightness-max', 'raster-hue-rotate', 'raster-saturation', 'raster-contrast']
      .forEach((k) => map.gl.setPaintProperty(id, k, paint[k] ?? (k === 'raster-brightness-max' ? 1 : 0)));
  }
  new MutationObserver(paintRaster).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  async function useGoogle(type) {
    const src = await GoogleMap.source(type);
    if (!src) return false;
    googleSrc = src;
    googleErrors = 0;
    map.getContainer().classList.add('raster-map', 'google-map');
    map.getContainer().classList.toggle('satellite', type === 'satellite');
    map.setStyle({
      version: 8,
      sources: { google: { type: 'raster', tiles: [src.tiles], tileSize: 256, maxzoom: 22 } },
      layers: [{ id: 'google', type: 'raster', source: 'google', paint: rasterPaint(type === 'satellite') }],
    }, { transformStyle: keepOurLayers });
    updateGoogleCredit();
    return true;
  }
  // Google tiles that keep failing (key removed, daily limit reached): switch to our free map.
  map.gl.on('error', (e) => {
    if (!googleSrc || e.sourceId !== 'google') return;
    if (++googleErrors < 6) return;
    GoogleMap.forget(googleSrc.type);
    googleSrc = null;
    gCredit.hidden = true;
    addFreeMap();
  });
  map.gl.on('data', (e) => { if (e.sourceId === 'google' && e.tile) googleErrors = 0; });

  async function addBaseMap() {
    try {
      if (await useGoogle('roadmap')) return;
    } catch { GoogleMap.forget('roadmap'); }
    addFreeMap();
  }
  async function addFreeMap() {
    map.getContainer().classList.remove('google-map', 'satellite', 'raster-map');
    try {
      // Joins Urdu/Arabic letters correctly and draws them right-to-left.
      maplibregl.setRTLTextPlugin(`${location.origin}/vendor/rtl-text.js`, true).catch(() => {});
      const res = await fetch('https://tiles.openfreemap.org/styles/liberty');
      if (!res.ok) throw new Error(`style ${res.status}`);
      const style = await res.json();
      roadsFirst(style);
      for (const layer of style.layers) {
        const field = layer.layout && layer.layout['text-field'];
        const text = JSON.stringify(field || '');
        if (!text.includes('name')) continue; // leave road numbers etc. alone
        // Point labels (cities) get two lines; labels along roads/rivers stay on one line.
        layer.layout['text-field'] = bilingualLabel(text.includes('\\n') ? '\n' : ' ');
      }
      map.setStyle(style, { transformStyle: keepOurLayers });
    } catch {
      map.getContainer().classList.add('raster-map');
      map.setStyle({
        version: 8,
        sources: { osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19, attribution: OSM_ATTR } },
        layers: [{ id: 'osm', type: 'raster', source: 'osm', paint: rasterPaint(false) }],
      }, { transformStyle: keepOurLayers });
    }
  }
  addBaseMap();

  const markers = new Map();
  let following = null; // "Follow live": { id, line, points } (see the follow section)
  const fleetLayer = GL.layerGroup().addTo(map); // live trucks (hidden while a trip history is shown)
  map.on('dragstart', () => { userMovedMap = true; });
  map.on('rotatestart', () => { userMovedMap = true; });
  // Turning the map: every truck keeps pointing the way it really drives.
  map.on('rotate', () => GL.rotateWithMap(map.getContainer(), map.getBearing()));
  map.getContainer().addEventListener('wheel', () => { userMovedMap = true; }, { passive: true });

  // 3D trucks and cars (js/vehicles3d.js). Until it has loaded, or if 3D can't run, the flat ones show.
  let vehicles3d = null;
  function startVehicles3d() {
    try {
      Vehicles3D.attach(map.gl);
      vehicles3d = Vehicles3D;
      users.forEach(renderMarker);
    } catch { vehicles3d = null; document.documentElement.classList.remove('vehicles-3d'); }
  }
  if (window.Vehicles3D) startVehicles3d(); else window.addEventListener('vehicles3d-ready', startVehicles3d, { once: true });
  function vehicleState(id) {
    const u = users.get(id);
    const m = markers.get(id);
    if (!u || !m || !u.location || !map.hasLayer(fleetLayer)) return null;
    const ll = m.getLatLng();
    return { lat: ll.lat, lng: ll.lng, heading: u.location.heading ?? 0, status: statusOf(u), urgency: u.urgency };
  }

  // A top-down truck that turns to face the direction it's driving:
  //   cab       = live status colour (green / amber / grey / red)
  //   container = urgency (white normal, yellow urgent, red very urgent), 20ft or 40ft long
  // Shared gradients are defined once in admin.html.
  const URGENCY = {
    normal: { fill: 'url(#ib-box)', label: 'Normal' },
    urgent: { fill: 'url(#ib-box-y)', label: 'Urgent' },
    very_urgent: { fill: 'url(#ib-box-r)', label: 'Very urgent' },
  };
  function truckSvg(u) {
    const long = u.truckSize === '40ft';
    const box = long ? 49 : 31; // container length
    const h = 17 + box + 2;
    const fill = (URGENCY[u.urgency] || URGENCY.normal).fill;
    const ribs = Array.from({ length: Math.floor((box - 6) / 5) }, (_, i) => `M6 ${22 + i * 5}h16`).join('');
    const wheels = (long ? [21, 40, 58] : [21, 38]).map((y) => `<rect x="1" y="${y}" width="2" height="5.5" rx=".8" fill="#2b3640"/><rect x="25" y="${y}" width="2" height="5.5" rx=".8" fill="#2b3640"/>`).join('');
    return `
    <svg class="truck-svg" viewBox="0 0 28 ${h}" width="24" height="${Math.round(h * 24 / 28)}" aria-hidden="true">
      ${wheels}
      <rect x="2.5" y="17" width="23" height="${box}" rx="2.5" fill="${fill}" stroke="#7d8a95" stroke-width=".8"/>
      <path d="${ribs}" stroke="#000" stroke-width=".5" opacity=".18"/>
      <rect x="4.5" y="13.5" width="19" height="4.5" rx="1" fill="#3a4651"/>
      <rect class="cab" x="4" y="1.5" width="20" height="14" rx="5"/>
      <rect x="4" y="1.5" width="20" height="14" rx="5" fill="url(#ib-shade)"/>
      <path d="M6.5 4.6c0-1 .8-1.6 1.8-1.6h11.4c1 0 1.8.6 1.8 1.6v3.2H6.5z" fill="#1c2833"/>
      <path d="M8 4.3h4.5L10 7H8z" fill="#fff" opacity=".35"/>
      <rect x="1.5" y="6.5" width="2.5" height="2" rx=".8" fill="#2b3640"/><rect x="24" y="6.5" width="2.5" height="2" rx=".8" fill="#2b3640"/>
      <rect x="6" y="1.2" width="3.5" height="1.3" rx=".6" fill="#ffe08a"/><rect x="18.5" y="1.2" width="3.5" height="1.3" rx=".6" fill="#ffe08a"/>
    </svg>`;
  }

  // Tag next to the name for urgent trucks.
  const nameTags = (u) => (u.urgency && u.urgency !== 'normal'
    ? `<span class="tag tag-${u.urgency}">${URGENCY[u.urgency].label}</span>` : '');

  // Tracked admins show as a car (same style: body in the status colour, turns to its heading).
  const CAR_SVG = `
    <svg class="truck-svg car-svg" viewBox="0 0 26 44" width="22" height="38" aria-hidden="true">
      <rect x="1" y="8" width="2.6" height="7" rx="1.2" fill="#22303b"/><rect x="22.4" y="8" width="2.6" height="7" rx="1.2" fill="#22303b"/>
      <rect x="1" y="29" width="2.6" height="7" rx="1.2" fill="#22303b"/><rect x="22.4" y="29" width="2.6" height="7" rx="1.2" fill="#22303b"/>
      <path class="cab" d="M13 1.5c5.2 0 9.5 2.6 9.5 7.5v27c0 4.4-3.4 6.5-9.5 6.5S3.5 40.4 3.5 36V9C3.5 4.1 7.8 1.5 13 1.5z"/>
      <path d="M13 1.5c5.2 0 9.5 2.6 9.5 7.5v27c0 4.4-3.4 6.5-9.5 6.5S3.5 40.4 3.5 36V9C3.5 4.1 7.8 1.5 13 1.5z" fill="url(#ib-shade)"/>
      <path d="M6.2 13.5c1.8-1.6 4.2-2.3 6.8-2.3s5 .7 6.8 2.3l-1.4 5.2H7.6z" fill="#1c2833"/>
      <rect x="7.4" y="19.5" width="11.2" height="10" rx="2" fill="#000" opacity=".12"/>
      <path d="M7.8 30.5h10.4l1.3 4.2c-1.7 1.3-4 1.9-6.5 1.9s-4.8-.6-6.5-1.9z" fill="#1c2833"/>
      <path d="M8.6 13.8h3.4l-1.6 3.6H8z" fill="#fff" opacity=".35"/>
      <rect x="5.2" y="2.6" width="3.6" height="1.6" rx=".8" fill="#ffe08a"/><rect x="17.2" y="2.6" width="3.6" height="1.6" rx=".8" fill="#ffe08a"/>
      <rect x="1.4" y="12.5" width="2.4" height="1.8" rx=".8" fill="#22303b"/><rect x="22.2" y="12.5" width="2.4" height="1.8" rx=".8" fill="#22303b"/>
    </svg>`;

  function truckIcon(u) {
    const heading = u.location && u.location.heading != null ? u.location.heading : 0;
    return GL.divIcon({
      className: '',
      iconSize: [44, 44],
      iconAnchor: [22, 22],
      popupAnchor: [0, -22],
      html: `
        <div class="truck ${statusOf(u)}">
          <div class="pulse"></div>
          <div class="truck-rot" data-heading="${heading}" style="transform:rotate(${heading - map.getBearing()}deg)">${u.role === 'admin' ? CAR_SVG : truckSvg(u)}</div>
          <div class="truck-label${u.truckSize === '40ft' && u.role !== 'admin' ? ' long' : ''}">${esc(u.name)}${nameTags(u)}${chip(u)}</div>
        </div>`,
    });
  }

  // Other drivers within 30 km of this one, nearest first (straight-line distance).
  const NEARBY_KM = 30;
  function nearbyHtml(u) {
    const here = [u.location.lat, u.location.lng];
    const near = [...users.values()]
      .filter((o) => o.id !== u.id && isTracked(o) && o.location)
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
      ${esc(ROLES[u.role] || u.role)}${u.role !== 'admin' ? ` · ${u.truckSize} · ${URGENCY[u.urgency].label}` : ''} · ${esc(u.phone)}<br>
      ${chip(u)} · updated ${ago(u.location.at)}
      ${speed != null ? `<br>${isLive(u) ? 'Speed' : 'Last speed'}: <b>${speedText(speed)}</b>` : ''}
      ${u.location.accuracy != null ? `<br>Accuracy: ±${Math.round(u.location.accuracy)} m` : ''}
      ${u.battery != null ? `<br>Battery: ${u.battery}%` : ''}<br>
      ${nearbyHtml(u)}
      <button class="link" data-follow="${u.id}">${following && following.id === u.id ? 'Stop following' : 'Follow live'}</button> ·
      <button class="link" data-history="${u.id}">Show history</button> ·
      <button class="link" data-gview="${u.id}">Google map here</button> ·
      <button class="link" data-gmaps="${u.id}">Route in Google Maps</button>`;
  }

  // Trucks move continuously instead of jumping: each new position is reached at a steady speed
  // over about the time until the next update is expected (the gap between the last two updates).
  // A new position arriving mid-way continues from where the truck is on screen, so it never pauses
  // between updates and never goes past the last real position (it trails it by one update).
  // Big jumps (e.g. after being offline) and hidden tabs move straight there.
  const GLIDE_MIN_MS = 1000;
  const GLIDE_MAX_MS = 6000;
  function glideTo(m, latlng) {
    const to = GL.latLng(latlng);
    // Same position again (a parked truck's check-in, or the regular redraw): keep gliding as is.
    if (m._target ? m._target.equals(to) : m.getLatLng().equals(to)) return;
    m._target = to;
    const now = performance.now();
    const gap = m._lastFixAt ? now - m._lastFixAt : 5000;
    m._lastFixAt = now;
    const from = m.getLatLng();
    cancelAnimationFrame(m._glide);
    if (document.hidden || map.distance(from, to) > 2000) return m.setLatLng(to);
    const duration = Math.min(GLIDE_MAX_MS, Math.max(GLIDE_MIN_MS, gap));
    const step = (t) => {
      const k = Math.min(1, (t - now) / duration); // steady speed: no speeding up or slowing down
      m.setLatLng([from.lat + (to.lat - from.lat) * k, from.lng + (to.lng - from.lng) * k]);
      if (vehicles3d) vehicles3d.repaint();
      if (k < 1) m._glide = requestAnimationFrame(step);
    };
    m._glide = requestAnimationFrame(step);
  }

  function renderMarker(u) {
    googleTruckMoved(u);
    let m = markers.get(u.id);
    if (!u.location || !isTracked(u)) {
      if (m) { m.remove(); markers.delete(u.id); }
      if (vehicles3d) vehicles3d.remove(u.id);
      return;
    }
    const latlng = [u.location.lat, u.location.lng];
    if (!m) {
      m = GL.marker(latlng, { icon: truckIcon(u) }).addTo(fleetLayer).bindPopup(popupHtml(u));
      m.on('click', () => select(u.id, false));
      markers.set(u.id, m);
      if (!userMovedMap) fitAll();
    } else {
      glideTo(m, latlng);
      m.setIcon(truckIcon(u));
      m.setPopupContent(popupHtml(u));
    }
    m.setZIndexOffset(isLive(u) ? 1000 : 0);
    if (vehicles3d) vehicles3d.set(u.id, u.role === 'admin' ? 'car' : 'truck', u.truckSize === '40ft', () => vehicleState(u.id));
  }

  function fitAll() {
    const pts = [...markers.values()].map((m) => m.getLatLng());
    if (!pts.length) return;
    if (pts.length === 1) map.setView(pts[0], 14);
    else map.fitBounds(GL.latLngBounds(pts), { padding: [60, 60], maxZoom: 15 });
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
    const drivers = [...users.values()].filter(isTracked);
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
      const state = !isTracked(u) ? '' : { active: 'on', idle: 'warn', alert: 'bad' }[st] || '';
      const contact = esc(u.phone || u.email || 'no phone yet');
      const meta = !isTracked(u)
        ? `${contact} · ${u.owner ? 'main admin · ' : ''}not tracked`
        : `${contact} · ${chip(u)}${(st === 'offline' || st === 'alert') && u.location ? ` seen ${ago(u.location.at)}` : ''}${simBadge(u)}`;
      // The main admin can't be changed by other admins; only the main admin switches tracking.
      const locked = u.owner;
      const trackBtn = me && me.is_owner && u.role === 'admin' && !u.owner
        ? `<button class="del track ${u.tracked ? 'on' : ''}" data-track="${u.id}" title="Share this admin's location">📍 ${u.tracked ? 'Tracking on' : 'Track'}</button>` : '';
      const options = Object.entries(ROLES)
        .map(([k, v]) => `<option value="${k}" ${k === u.role ? 'selected' : ''}>${v}</option>`)
        .join('');
      return `
        <div class="user ${u.id === selectedId ? 'selected' : ''}" data-id="${u.id}">
          <span class="dot ${state}"></span>
          <div class="name">${esc(u.name)}${self ? '<span class="badge">You</span>' : ''}${u.role === 'admin' ? '' : nameTags(u)}</div>
          <div class="meta">${meta}</div>
          ${self || locked ? '' : `<div class="controls">
            <select data-role="${u.id}" aria-label="Role for ${esc(u.name)}">${options}</select>
            ${u.role === 'admin' ? '' : `<select data-size="${u.id}" class="small" aria-label="Truck size">
              ${['20ft', '40ft'].map((v) => `<option ${v === u.truckSize ? 'selected' : ''}>${v}</option>`).join('')}</select>
            <select data-urgency="${u.id}" class="small urg-${u.urgency}" aria-label="Urgency">
              ${Object.entries(URGENCY).map(([k, v]) => `<option value="${k}" ${k === u.urgency ? 'selected' : ''}>${v.label}</option>`).join('')}</select>`}
            ${trackBtn}
            ${!isTracked(u) ? '' : `<button class="del" data-history="${u.id}" title="Trip history">History</button>`}
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

  const passwordRule = (v) => (v.length < 6 ? 'Password must be at least 6 characters' : '');

  listEl.addEventListener('change', async (e) => {
    const id = e.target.dataset.role;
    if (!id) return;
    const u = users.get(id);
    const role = e.target.value;
    const undo = () => { e.target.value = u.role; renderList(); };
    let password = null;
    if (role === 'admin') {
      const sure = await Ibraya.dialog({
        title: `Make ${u.name} an admin?`,
        message: 'They will see every truck, the alerts and the history, and can manage drivers. You stay an admin too.',
        okText: 'Make admin',
      });
      if (!sure) return undo();
      // Drivers sign in with just their phone, but admins use a password: set one for phone accounts.
      // (Email / Google accounts keep signing in the way they already do.)
      if (!u.email) {
        password = await Ibraya.dialog({
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
      }
    }
    const { data, error } = await sb.rpc('admin_set_role', { p_user: id, p_role: role });
    if (error) {
      await Ibraya.message('Could not change the role', Ibraya.friendlyError(error));
      return undo();
    }
    users.set(id, fromRow(data));
    e.target.blur();
    renderList();
    if (role === 'admin') {
      await Ibraya.message(`${u.name} is now an admin`, password
        ? `Tell them: tap "Admin? Sign in with password", then use their phone number and the password: ${password}`
        : 'They can sign in the way they already do (email or Google).');
    }
  });
  listEl.addEventListener('focusout', () => setTimeout(renderList, 0));

  // Truck size and urgency (how the driver's truck is drawn on the map).
  listEl.addEventListener('change', async (e) => {
    const id = e.target.dataset.size || e.target.dataset.urgency;
    if (!id) return;
    const args = { p_user: id };
    if (e.target.dataset.size) args.p_truck_size = e.target.value;
    else args.p_urgency = e.target.value;
    const { data, error } = await sb.rpc('admin_set_truck', args);
    if (error) {
      await Ibraya.message('Could not save', Ibraya.friendlyError(error));
    } else {
      upsertUser(data);
    }
    e.target.blur();
    renderList();
  });

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
      if (!isTracked(u) || !u.location) return;
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
  const historyLayer = GL.layerGroup();
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

  const dotIcon = (cls, label) => GL.divIcon({ className: '', iconSize: [18, 18], iconAnchor: [9, 9], html: `<div class="hist-dot ${cls}">${label || ''}</div>` });

  function drawHistory() {
    historyLayer.clearLayers();
    const { points, entries } = history;
    if (!points.length) return;
    const latlngs = (pts) => pts.map((p) => [p.lat, p.lng]);
    entries.forEach((e, i) => {
      let layer;
      if (e.type === 'drive') {
        layer = GL.polyline(latlngs(e.points), { color: ROUTE_COLOR, weight: 5, opacity: 0.85 });
        layer.on('click', (ev) => {
          // Exact time at the clicked spot: the nearest saved point.
          let best = e.points[0];
          e.points.forEach((p) => { if (map.distance(ev.latlng, [p.lat, p.lng]) < map.distance(ev.latlng, [best.lat, best.lng])) best = p; });
          GL.popup().setLatLng([best.lat, best.lng])
            .setContent(`<b>${hms(best.t)}</b>${best.speed != null ? `<br>${speedText(Math.round(best.speed * 3.6))}` : ''}`)
            .openOn(map);
        });
      } else if (e.type === 'stop') {
        layer = GL.marker([e.at.lat, e.at.lng], { icon: dotIcon('stop', 'P') })
          .bindPopup(`<b>Stopped ${duration(e.to - e.from)}</b><br>${hm(e.from)}–${hm(e.to)}`);
      } else if (e.type === 'gap') {
        layer = GL.polyline(latlngs([e.a, e.b]), { color: '#d93838', weight: 3, dashArray: '6 8' })
          .bindPopup(`<b>No signal ${duration(e.to - e.from)}</b><br>${hm(e.from)}–${hm(e.to)}<br>Moved ${distance(e.moved)} (straight line)`);
      }
      if (layer) { layer.entry = i; historyLayer.addLayer(layer); e.layer = layer; }
    });
    const first = points[0];
    const last = points[points.length - 1];
    historyLayer.addLayer(GL.marker([first.lat, first.lng], { icon: dotIcon('start', 'A'), zIndexOffset: 500 }).bindPopup(`<b>First point</b><br>${hms(first.t)}`));
    historyLayer.addLayer(GL.marker([last.lat, last.lng], { icon: dotIcon('end', 'B'), zIndexOffset: 500 }).bindPopup(`<b>Last point</b><br>${hms(last.t)}`));
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
    if (fit && points.length) map.fitBounds(GL.latLngBounds(points.map((p) => [p.lat, p.lng])), { ...fitPadding(), maxZoom: 16 });
  }

  function openHistory(id, day) {
    const u = users.get(id);
    if (!u) return;
    stopFollow();
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
    if (vehicles3d) vehicles3d.repaint();
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
    if (vehicles3d) vehicles3d.repaint();
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

  // Main admin: share another admin's location, or stop.
  listEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-track]');
    if (!btn) return;
    const u = users.get(btn.dataset.track);
    const on = !u.tracked;
    const sure = await Ibraya.dialog({
      title: on ? `Track ${u.name}?` : `Stop tracking ${u.name}?`,
      message: on
        ? 'Their phone will share its location like a driver\'s: map, history and alerts. They need the Transport Hub app on their phone, signed in.'
        : 'Their location will no longer be shared. Their past history is kept.',
      okText: on ? 'Track' : 'Stop tracking',
    });
    if (!sure) return;
    const { data, error } = await sb.rpc('admin_set_tracked', { p_user: u.id, p_tracked: on });
    if (error) return Ibraya.message('Could not change tracking', Ibraya.friendlyError(error));
    upsertUser(data);
    renderList();
  });

  // This admin's own phone: share its location only if the main admin switched tracking on.
  async function syncMyTracking() {
    const banner = document.getElementById('my-tracking');
    if (!me.tracked) {
      banner.hidden = true;
      if (Ibraya.tracker) {
        sb.rpc('unregister_my_tracker_devices').then(() => {}, () => {});
        Ibraya.tracker.stop().catch(() => {});
      }
      return;
    }
    banner.hidden = false;
    if (!Ibraya.tracker) {
      banner.removeAttribute('href');
      banner.textContent = '📍 Your location is shared with the main admin. Open the Transport Hub app on your phone and sign in there.';
      return;
    }
    try {
      let st = await Ibraya.tracker.getStatus();
      if (!st.hasToken) {
        const { data: token, error } = await sb.rpc('register_tracker_device', { p_device_name: st.device || null });
        if (error) throw error;
        st = await Ibraya.tracker.start({ token, supabaseUrl: IBRAYA.supabaseUrl, apiKey: IBRAYA.supabaseKey });
      }
      const ready = st.location && st.background && st.gpsOn;
      banner.href = '/driver';
      banner.textContent = ready
        ? '📍 Your location is shared with the main admin (24/7).'
        : '📍 Your location must be shared. Tap here to finish the setup →';
    } catch (err) {
      banner.textContent = `📍 Location sharing: ${Ibraya.friendlyError(err)}`;
    }
  }

  // ---------- follow live / route in Google Maps ----------
  // Follow live: keep the map on one truck and draw the road it drove in the last 2 hours,
  // growing as new positions arrive, so you can see where it's heading.
  const FOLLOW_TRAIL_MS = 2 * 3600 * 1000;
  async function recentRoute(id, ms) {
    const { data } = await sb.rpc('get_driver_history', {
      p_user: id, p_from: new Date(Date.now() - ms).toISOString(), p_to: new Date(Date.now() + 60000).toISOString(),
    });
    return ((data && data.points) || []).map(([, lat, lng]) => [lat, lng]);
  }
  function refreshPopup(id) {
    const u = users.get(id);
    const m = markers.get(id);
    if (u && m && u.location) m.setPopupContent(popupHtml(u));
  }
  async function startFollow(id) {
    const u = users.get(id);
    if (!u || !u.location) return;
    stopFollow();
    following = { id, points: [], line: GL.polyline([], { color: '#2563eb', weight: 5, opacity: 0.7 }).addTo(map) };
    userMovedMap = true;
    map.setView([u.location.lat, u.location.lng], Math.max(map.getZoom(), 15));
    document.getElementById('follow-name').textContent = u.name;
    document.getElementById('follow-bar').hidden = false;
    refreshPopup(id);
    let points = [];
    try { points = await recentRoute(id, FOLLOW_TRAIL_MS); } catch { /* just follow from now */ }
    if (!following || following.id !== id) return;
    following.points = points;
    followUpdate(users.get(id));
  }
  // A truck that was without internet uploads the road it took once it's back online:
  // after a gap, load the trail again a little later so that part is drawn in too.
  const FOLLOW_GAP_MS = 2 * 60 * 1000;
  async function reloadTrail(id) {
    let points;
    try { points = await recentRoute(id, FOLLOW_TRAIL_MS); } catch { return; }
    const u = users.get(id);
    if (!following || following.id !== id || !points.length) return;
    if (u && u.location) points.push([u.location.lat, u.location.lng]);
    following.points = points;
    following.line.setLatLngs(points);
  }
  function followUpdate(u) {
    if (!following || !u || u.id !== following.id || !u.location) return;
    const at = new Date(u.location.at).getTime();
    if (following.lastAt && at - following.lastAt > FOLLOW_GAP_MS) {
      const id = u.id;
      setTimeout(() => reloadTrail(id), 20000);
      setTimeout(() => reloadTrail(id), 90000);
    }
    following.lastAt = at;
    const p = [u.location.lat, u.location.lng];
    const last = following.points[following.points.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) following.points.push(p);
    following.line.setLatLngs(following.points);
    map.panTo(p, { animate: true, duration: 2, easeLinearity: 1 });
  }
  function stopFollow() {
    if (!following) return;
    const id = following.id;
    following.line.remove();
    following = null;
    document.getElementById('follow-bar').hidden = true;
    refreshPopup(id);
  }
  document.getElementById('follow-stop').addEventListener('click', stopFollow);

  // Route in Google Maps: the last hour's route (on the roads) up to where the truck is now.
  // Google Maps can't receive our live positions, so this shows the route at the moment you tap.
  async function openRouteInGoogleMaps(id) {
    const u = users.get(id);
    if (!u || !u.location) return;
    const win = window.open('about:blank', '_blank'); // open now, or popup blockers stop it
    let points = [];
    try { points = await recentRoute(id, 3600 * 1000); } catch { /* current position only */ }
    points.push([u.location.lat, u.location.lng]);
    const n = Math.min(10, points.length); // Google Maps links take about 10 stops
    const pick = Array.from({ length: n }, (_, i) => points[Math.round((i * (points.length - 1)) / Math.max(n - 1, 1))]);
    const url = pick.length > 1
      ? `https://www.google.com/maps/dir/${pick.map(([lat, lng]) => `${lat.toFixed(5)},${lng.toFixed(5)}`).join('/')}`
      : `https://www.google.com/maps?q=${u.location.lat},${u.location.lng}`;
    if (win) win.location.href = url;
    else location.href = url;
  }

  document.addEventListener('click', (e) => {
    const f = e.target.closest('[data-follow]');
    const g = e.target.closest('[data-gmaps]');
    const gv = e.target.closest('[data-gview]');
    if (gv) {
      e.preventDefault();
      map.closePopup();
      showGoogle(gv.dataset.gview);
    } else if (f) {
      e.preventDefault();
      if (following && following.id === f.dataset.follow) stopFollow();
      else startFollow(f.dataset.follow);
    } else if (g) {
      e.preventDefault();
      openRouteInGoogleMaps(g.dataset.gmaps);
    }
  });

  searchEl.addEventListener('input', renderList);
  document.getElementById('toggle').addEventListener('click', () => sidebar.classList.toggle('open'));
  document.getElementById('logout').addEventListener('click', () => Ibraya.signOut());

  // ---------- data + realtime ----------
  function upsertUser(row) {
    // Business accounts (shippers, brokers, ...) aren't tracked: they're on the hub, not the map.
    if (row.role === 'business') return removeUser(row.id);
    const u = fromRow(row);
    // Another admin took away my admin role: go to the driver page.
    if (me && u.id === me.id && u.role !== 'admin') return location.replace('/driver');
    // The main admin switched my tracking on or off.
    if (me && u.id === me.id && !!row.tracked !== !!me.tracked) { me = row; syncMyTracking(); }
    users.set(u.id, u);
    renderMarker(u);
    followUpdate(u);
  }

  function removeUser(id) {
    if (following && following.id === id) stopFollow();
    users.delete(id);
    const m = markers.get(id);
    if (m) { m.remove(); markers.delete(id); }
    renderList();
  }

  async function loadAll() {
    const { data, error } = await sb.from('profiles').select('*');
    if (error) return false;
    const seen = new Set();
    data.forEach((row) => { seen.add(row.id); upsertUser(row); });
    [...users.keys()].filter((id) => !seen.has(id)).forEach(removeUser);
    renderList();
    renderAlerts();
    return true;
  }

  me = await Ibraya.guard('/admin');
  if (!me) return;
  syncMyTracking();
  sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') Ibraya.toLogin();
  });

  // The database only sends the admin these changes (row-level security).
  let fleet = null;
  function connectLive() {
    if (fleet) sb.removeChannel(fleet);
    fleet = sb.channel('fleet')
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
  }
  connectLive();

  await loadAll();

  // Manual refresh, in case live updates stopped: load everything again and reconnect.
  const refreshBtn = document.getElementById('refresh');
  refreshBtn.addEventListener('click', async () => {
    if (refreshBtn.classList.contains('spinning')) return;
    refreshBtn.classList.add('spinning');
    try {
      const [ok] = await Promise.all([loadAll(), loadIncidents(), following ? reloadTrail(following.id) : null]);
      if (!fleet || fleet.state !== 'joined') connectLive();
      if (!ok) Ibraya.message('Could not refresh', 'Check your internet connection and try again.');
    } finally {
      setTimeout(() => refreshBtn.classList.remove('spinning'), 400);
    }
  });
  // And automatically: if the live connection is down, load the locations every 30 s instead.
  setInterval(() => {
    if (fleet && fleet.state && fleet.state !== 'joined' && document.visibilityState === 'visible') loadAll();
  }, 30000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { loadAll(); loadIncidents(); }
  });

  // Refresh "x min ago" labels and grey out stale trucks.
  setInterval(() => { users.forEach(renderMarker); renderList(); renderAlerts(); }, 15000);
})();
