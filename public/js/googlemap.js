// Google's map as the main map (Google Maps Platform, Map Tiles API), with our free
// OpenStreetMap map as the backup. The key is set by an admin in Hub → Commission; with no key,
// or when Google fails (key wrong, limit reached), the map pages use the free map.
// Google asks for its name and the map-data credit to be shown on the map: credit() does that.
window.GoogleMap = (() => {
  const API = 'https://tile.googleapis.com';
  let keyP = null;

  // The admins' key ('' = none). Asked once per page.
  function key() {
    if (!keyP) {
      keyP = Ibraya.sb.rpc('map_config')
        .then(({ data, error }) => (error || !data ? '' : data.google_key || ''))
        .catch(() => '');
    }
    return keyP;
  }

  // A tile session lasts about two weeks; reuse it on this device until shortly before it ends.
  // type: 'roadmap' or 'satellite' (with road names on top).
  async function session(k, type) {
    const store = `gmap-session-${type}`;
    try {
      const s = JSON.parse(localStorage.getItem(store) || 'null');
      if (s && s.key === k && s.expiry * 1000 > Date.now() + 3600e3) return s.session;
    } catch { /* no saved session */ }
    const body = { mapType: type, language: 'en-US', region: 'PK', scale: 'scaleFactor2x', highDpi: true };
    if (type === 'satellite') body.layerTypes = ['layerRoadmap'];
    const res = await fetch(`${API}/v1/createSession?key=${encodeURIComponent(k)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.session) throw new Error((d.error && d.error.message) || `Google map ${res.status}`);
    try { localStorage.setItem(store, JSON.stringify({ key: k, session: d.session, expiry: Number(d.expiry) })); } catch { /* private mode */ }
    return d.session;
  }
  function forget(type) { try { localStorage.removeItem(`gmap-session-${type}`); } catch { /* ignore */ } }

  // { tiles, key, session } for a map type, or null when there is no key / Google said no.
  async function source(type = 'roadmap') {
    const k = await key();
    if (!k) return null;
    const s = await session(k, type);
    return { key: k, session: s, type, tiles: `${API}/v1/2dtiles/{z}/{x}/{y}?session=${s}&key=${encodeURIComponent(k)}` };
  }

  // The credit Google asks for ("Google" + "Map data ©2026 Google" for what is on screen).
  // el: an element on the map; view: { zoom, north, south, east, west } in Google's zoom levels.
  let creditTimer = null;
  function credit(el, src, view) {
    clearTimeout(creditTimer);
    creditTimer = setTimeout(async () => {
      el.hidden = false;
      const q = new URLSearchParams({ session: src.session, key: src.key, zoom: String(Math.max(0, Math.round(view.zoom))),
        north: view.north.toFixed(5), south: view.south.toFixed(5), east: view.east.toFixed(5), west: view.west.toFixed(5) });
      let text = 'Map data ©Google';
      try {
        const r = await fetch(`${API}/tile/v1/viewport?${q}`);
        const d = await r.json();
        if (d.copyright) text = d.copyright;
      } catch { /* keep the short credit */ }
      el.innerHTML = '<b class="g-logo"><i>G</i><i>o</i><i>o</i><i>g</i><i>l</i><i>e</i></b><span></span>';
      el.querySelector('span').textContent = text;
    }, 400);
  }

  // Leaflet maps on the hub (fleet map, trip map): Google's tiles, or OpenStreetMap as the backup.
  // Gives back the layer; when Google tiles keep failing it swaps itself for the free map.
  async function leafletLayer(L, map) {
    const osm = () => L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' });
    let src = null;
    try { src = await source('roadmap'); } catch { forget('roadmap'); }
    if (!src) return osm().addTo(map);
    const layer = L.tileLayer(src.tiles, { maxZoom: 21, attribution: '' }).addTo(map);
    const box = document.createElement('div');
    box.className = 'google-credit';
    box.hidden = true;
    map.getContainer().appendChild(box);
    const update = () => {
      const b = map.getBounds();
      credit(box, src, { zoom: map.getZoom(), north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() });
    };
    map.on('moveend', update);
    update();
    let errors = 0;
    layer.on('tileload', () => { errors = 0; });
    layer.on('tileerror', () => {
      if (++errors < 6) return;
      forget('roadmap');
      map.removeLayer(layer);
      map.off('moveend', update);
      box.remove();
      osm().addTo(map);
    });
    return layer;
  }

  return { key, source, forget, credit, leafletLayer };
})();
