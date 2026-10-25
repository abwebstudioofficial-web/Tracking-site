// A small Leaflet-style layer over MapLibre GL, so the admin map can rotate and tilt (3D) while
// admin.js keeps using the same few calls it used with Leaflet: markers with HTML icons, popups,
// polylines, layer groups, setView / fitBounds / panTo and distance.
// Zoom levels are given in Leaflet's scale (MapLibre's zoom + 1), so existing numbers keep working.
window.GL = (() => {
  const Z = 1; // Leaflet zoom = MapLibre zoom + 1
  const toLngLat = (ll) => (Array.isArray(ll) ? [ll[1], ll[0]] : [ll.lng, ll.lat]);
  const toLatLng = (lngLat) => latLng([lngLat.lat, lngLat.lng]);

  function latLng(a) {
    const lat = Array.isArray(a) ? a[0] : a.lat;
    const lng = Array.isArray(a) ? a[1] : a.lng;
    return { lat, lng, equals: (b) => !!b && Math.abs(b.lat - lat) < 1e-9 && Math.abs(b.lng - lng) < 1e-9 };
  }
  function distance(a, b) {
    const p = latLng(a);
    const q = latLng(b);
    const r = Math.PI / 180;
    const h = Math.sin(((q.lat - p.lat) * r) / 2) ** 2
      + Math.cos(p.lat * r) * Math.cos(q.lat * r) * Math.sin(((q.lng - p.lng) * r) / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
  }
  function latLngBounds(points) {
    const pts = points.map(latLng);
    return {
      points: pts,
      gl() {
        const lats = pts.map((p) => p.lat);
        const lngs = pts.map((p) => p.lng);
        return [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]];
      },
    };
  }
  // Leaflet padding options -> MapLibre padding.
  function padding(opts = {}) {
    if (opts.paddingTopLeft || opts.paddingBottomRight) {
      const [l, t] = opts.paddingTopLeft || [0, 0];
      const [r, b] = opts.paddingBottomRight || [0, 0];
      return { top: t, left: l, right: r, bottom: b };
    }
    const [x, y] = opts.padding || [0, 0];
    return { top: y, bottom: y, left: x, right: x };
  }

  let uid = 0;
  let openPopups = new Set();

  function createMap(container, { center, zoom, style }) {
    const gl = new maplibregl.Map({
      container, style, center: toLngLat(center), zoom: zoom - Z,
      attributionControl: false, dragRotate: true, pitchWithRotate: true, touchPitch: true,
      maxPitch: 70,
    });
    gl.touchZoomRotate.enableRotation();
    // Sources and layers can only be added once the current style has loaded (also after a style
    // swap). Our own flag: MapLibre's isStyleLoaded() is also false while a line's data is loading.
    let styleReady = false;
    let queue = [];
    gl.on('style.load', () => {
      styleReady = true;
      const q = queue;
      queue = [];
      q.forEach((fn) => fn());
    });
    const whenReady = (fn) => { if (styleReady) fn(); else queue.push(fn); };

    const map = {
      gl,
      whenReady,
      getContainer: () => gl.getContainer(),
      getZoom: () => gl.getZoom() + Z,
      getBearing: () => gl.getBearing(),
      distance,
      on: (ev, fn) => gl.on(ev, fn),
      // Swap the base map (our own lines are carried over by opts.transformStyle).
      setStyle(style, opts) { styleReady = false; gl.setStyle(style, { ...opts, diff: false }); },
      setView(ll, z) { gl.jumpTo({ center: toLngLat(ll), zoom: (z ?? map.getZoom()) - Z }); return map; },
      panTo(ll, opts = {}) {
        gl.easeTo({ center: toLngLat(ll), duration: opts.animate === false ? 0 : (opts.duration || 0.25) * 1000, easing: (t) => t });
        return map;
      },
      fitBounds(b, opts = {}) {
        const box = b.gl ? b.gl() : b;
        const pts = b.points || [];
        if (pts.length === 1) return map.setView(pts[0], Math.min(opts.maxZoom || 16, 16));
        gl.fitBounds(box, { padding: padding(opts), maxZoom: opts.maxZoom != null ? opts.maxZoom - Z : undefined, bearing: gl.getBearing(), duration: 0 });
        return map;
      },
      closePopup() { [...openPopups].forEach((p) => p.remove()); openPopups = new Set(); },
      hasLayer: (layer) => !!layer._shown,
      removeLayer: (layer) => { if (layer.removeFrom) layer.removeFrom(map); else layer.remove(); return map; },
    };
    // A click on the map (not on a truck or a popup) closes the open popup, like Leaflet.
    gl.on('click', (e) => {
      const t = e.originalEvent && e.originalEvent.target;
      if (t && t.closest && t.closest('.maplibregl-marker, .maplibregl-popup')) return;
      if (!e.ibHandled) map.closePopup();
    });
    maps.push(map);
    return map;
  }
  const maps = []; // every map made here (handy for checks in the browser console)

  // Popups: opened by code (marker click or select), closed by the close button or a map click.
  function makePopup(map, offset) {
    const p = new maplibregl.Popup({ closeOnClick: false, offset, maxWidth: '300px', focusAfterOpen: false });
    p.on('close', () => openPopups.delete(p));
    return p;
  }

  function divIcon(opts) { return opts; }

  function marker(ll, opts = {}) {
    let pos = latLng(ll);
    let icon = opts.icon || { html: '', iconSize: [18, 18] };
    let zOffset = opts.zIndexOffset || 0;
    const el = document.createElement('div');
    const clicks = [];
    let popupHtml = null;
    let popup = null;
    let map = null;
    let mk = null;
    const paint = () => {
      el.className = `ib-marker ${icon.className || ''}`;
      const [w, h] = icon.iconSize || [18, 18];
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      el.style.zIndex = String(1000 + zOffset);
      el.innerHTML = icon.html || '';
      if (map) rotateWithMap(el, map.getBearing());
    };
    paint();
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (popupHtml != null) self.openPopup();
      clicks.forEach((fn) => fn({ latlng: pos }));
    });
    const self = {
      _isMarker: true,
      addTo(target) {
        if (target.addLayer && !target.gl) { target.addLayer(self); return self; }
        map = target;
        mk = mk || new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(toLngLat(pos));
        mk.addTo(map.gl);
        rotateWithMap(el, map.getBearing());
        return self;
      },
      remove() { if (popup) popup.remove(); if (mk) mk.remove(); map = null; return self; },
      getLatLng: () => pos,
      setLatLng(next) { pos = latLng(next); if (mk) mk.setLngLat(toLngLat(pos)); if (popup && popup.isOpen()) popup.setLngLat(toLngLat(pos)); return self; },
      setIcon(next) { icon = next; paint(); return self; },
      setZIndexOffset(z) { zOffset = z; el.style.zIndex = String(1000 + z); return self; },
      bindPopup(html) { popupHtml = html; return self; },
      getPopup: () => (popupHtml != null ? {} : null),
      setPopupContent(html) { popupHtml = html; if (popup && popup.isOpen()) popup.setHTML(html); return self; },
      openPopup() {
        if (!map || popupHtml == null) return self;
        const [, h] = icon.iconSize || [18, 18];
        popup = popup || makePopup(map, Math.round(h / 2) + 4);
        popup.setLngLat(toLngLat(pos)).setHTML(popupHtml);
        if (!popup.isOpen()) { map.closePopup(); popup.addTo(map.gl); openPopups.add(popup); }
        return self;
      },
      on(ev, fn) { if (ev === 'click') clicks.push(fn); return self; },
    };
    return self;
  }

  // Trucks point the way they drive: keep their heading true to the ground when the map turns.
  function rotateWithMap(el, bearing) {
    el.querySelectorAll('[data-heading]').forEach((r) => {
      r.style.transform = `rotate(${Number(r.dataset.heading) - bearing}deg)`;
    });
  }

  function polyline(points, opts = {}) {
    const id = `ib-line-${++uid}`;
    let pts = points.map(latLng);
    let map = null;
    let popupHtml = null;
    const clicks = [];
    const data = () => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts.map((p) => [p.lng, p.lat]) } });
    const onClick = (e) => {
      e.ibHandled = true;
      const ll = toLatLng(e.lngLat);
      if (popupHtml != null) popup().setLatLng(ll).setContent(popupHtml).openOn(map);
      clicks.forEach((fn) => fn({ latlng: ll }));
    };
    const enter = () => { map.gl.getCanvas().style.cursor = 'pointer'; };
    const leave = () => { map.gl.getCanvas().style.cursor = ''; };
    const self = {
      addTo(target) {
        if (target.addLayer && !target.gl) { target.addLayer(self); return self; }
        map = target;
        const m = map;
        map.whenReady(() => {
          if (map !== m || m.gl.getSource(id)) return;
          m.gl.addSource(id, { type: 'geojson', data: data() });
          m.gl.addLayer({
            id, type: 'line', source: id, layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
              'line-color': opts.color || '#2563eb', 'line-width': opts.weight || 3, 'line-opacity': opts.opacity ?? 1,
              ...(opts.dashArray ? { 'line-dasharray': opts.dashArray.split(/\s+/).map((n) => Number(n) / (opts.weight || 3)) } : {}),
            },
          });
          m.gl.on('click', id, onClick);
          m.gl.on('mouseenter', id, enter);
          m.gl.on('mouseleave', id, leave);
        });
        return self;
      },
      remove() {
        const m = map;
        map = null;
        if (!m) return self;
        m.whenReady(() => {
          m.gl.off('click', id, onClick);
          m.gl.off('mouseenter', id, enter);
          m.gl.off('mouseleave', id, leave);
          if (m.gl.getLayer(id)) m.gl.removeLayer(id);
          if (m.gl.getSource(id)) m.gl.removeSource(id);
        });
        return self;
      },
      setLatLngs(next) {
        pts = next.map(latLng);
        if (map) map.whenReady(() => { const s = map && map.gl.getSource(id); if (s) s.setData(data()); });
        return self;
      },
      getBounds: () => latLngBounds(pts),
      bindPopup(html) { popupHtml = html; return self; },
      getPopup: () => (popupHtml != null ? {} : null),
      openPopup() {
        if (map && popupHtml != null && pts.length) popup().setLatLng(pts[Math.floor(pts.length / 2)]).setContent(popupHtml).openOn(map);
        return self;
      },
      on(ev, fn) { if (ev === 'click') clicks.push(fn); return self; },
    };
    return self;
  }

  function popup() {
    let pos = null;
    let html = '';
    return {
      setLatLng(ll) { pos = latLng(ll); return this; },
      setContent(h) { html = h; return this; },
      openOn(map) {
        map.closePopup();
        const p = makePopup(map, 8).setLngLat(toLngLat(pos)).setHTML(html).addTo(map.gl);
        openPopups.add(p);
        return this;
      },
    };
  }

  // A group of markers/lines shown or hidden together (live trucks, a trip history).
  function layerGroup() {
    const items = new Set();
    let map = null;
    const self = {
      _shown: false,
      addLayer(l) { items.add(l); if (map) l.addTo(map); return self; },
      clearLayers() { items.forEach((l) => l.remove()); items.clear(); return self; },
      addTo(m) { map = m; self._shown = true; items.forEach((l) => l.addTo(m)); return self; },
      removeFrom() { items.forEach((l) => l.remove()); map = null; self._shown = false; return self; },
      remove() { return self.removeFrom(); },
    };
    return self;
  }

  return { maps, createMap, marker, divIcon, polyline, popup, layerGroup, latLng, latLngBounds, distance, rotateWithMap };
})();
