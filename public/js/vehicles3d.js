// 3D trucks and cars on the admin map (like Google Maps' navigation arrow, but real models).
// Drawn with three.js inside the MapLibre map, so they tilt and turn with it.
//   truck: cab in the live-status colour, container in the urgency colour, 20ft or 40ft long.
//   car (tracked admins): body in the live-status colour.
// Real size when zoomed in close; never smaller than a clear icon when zoomed out.
// The HTML markers stay on top (name tag, click, popup); their flat drawing is hidden while 3D works.
import * as THREE from '/vendor/three.module.min.js';

const STATUS_COLOR = { active: 0x1fae5b, idle: 0xf5a524, offline: 0x8b97a1, none: 0x8b97a1, alert: 0xd93838 };
const URGENCY_COLOR = { normal: 0xf1f4f7, urgent: 0xfcd34d, very_urgent: 0xef4444 };
const MIN_PX = 54;    // a truck is never drawn shorter than this on screen
const EARTH = 40075016.686;

// Shared geometry and materials (meters; +y = forward, +z = up).
const box = new THREE.BoxGeometry(1, 1, 1);
const wheelGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.35, 16);
wheelGeo.rotateZ(Math.PI / 2);
const mat = (color, opts = {}) => new THREE.MeshLambertMaterial({ color, ...opts });
const M = {
  tyre: mat(0x1e252b),
  chassis: mat(0x2d3640),
  glass: mat(0x1b2a38),
  light: mat(0xfff1b0, { emissive: 0x665a20 }),
  rib: mat(0x000000, { transparent: true, opacity: 0.12 }),
};

function part(geo, material, [w, l, h], [x, y, z]) {
  const m = new THREE.Mesh(geo, material);
  m.scale.set(w, l, h);
  m.position.set(x, y, z);
  return m;
}
function wheels(group, ys, halfWidth, r = 0.5) {
  ys.forEach((y) => [-halfWidth, halfWidth].forEach((x) => {
    const w = new THREE.Mesh(wheelGeo, M.tyre);
    w.scale.set(1, r * 2, r * 2);
    w.position.set(x, y, r);
    group.add(w);
  }));
}

// Moves the parts so the middle of the vehicle sits on its map point.
function centre(g, front, back) {
  const mid = (front + back) / 2;
  g.children.forEach((c) => { c.position.y -= mid; });
}

function buildTruck(long) {
  const g = new THREE.Group();
  const boxLen = long ? 12.2 : 6.1;
  const rear = -boxLen - 0.6;
  const cabMat = mat(0x1fae5b);
  const boxMat = mat(0xf1f4f7);
  g.add(part(box, M.chassis, [2.3, boxLen + 3.6, 0.35], [0, rear / 2 + 1.5, 0.75]));
  // container with ribs
  g.add(part(box, boxMat, [2.5, boxLen, 2.6], [0, rear + boxLen / 2, 2.25]));
  for (let i = 1; i < Math.floor(boxLen / 1.2); i++) {
    g.add(part(box, M.rib, [2.54, 0.12, 2.5], [0, rear + i * 1.2, 2.25]));
  }
  // cab: body, windscreen, roof, lights
  g.add(part(box, cabMat, [2.45, 2.3, 2.5], [0, 1.6, 1.95]));
  g.add(part(box, M.glass, [2.2, 0.08, 0.95], [0, 2.76, 2.55]));
  g.add(part(box, M.glass, [0.08, 1.2, 0.8], [1.23, 1.9, 2.5]));
  g.add(part(box, M.glass, [0.08, 1.2, 0.8], [-1.23, 1.9, 2.5]));
  g.add(part(box, M.light, [0.5, 0.06, 0.25], [0.85, 2.77, 1.3]));
  g.add(part(box, M.light, [0.5, 0.06, 0.25], [-0.85, 2.77, 1.3]));
  wheels(g, long ? [1.6, rear + 3, rear + 1.6] : [1.6, rear + 1.6], 1.1);
  centre(g, 2.8, rear);
  g.userData = { cabMat, boxMat, length: boxLen + 3.4 };
  return g;
}

function buildCar() {
  const g = new THREE.Group();
  const bodyMat = mat(0x1fae5b);
  g.add(part(box, bodyMat, [1.8, 4.4, 0.8], [0, 0, 0.75]));
  g.add(part(box, bodyMat, [1.6, 2.3, 0.65], [0, -0.25, 1.45]));
  g.add(part(box, M.glass, [1.5, 0.08, 0.55], [0, 0.92, 1.45]));
  g.add(part(box, M.glass, [1.5, 0.08, 0.5], [0, -1.42, 1.45]));
  g.add(part(box, M.glass, [0.06, 1.9, 0.45], [0.81, -0.25, 1.45]));
  g.add(part(box, M.glass, [0.06, 1.9, 0.45], [-0.81, -0.25, 1.45]));
  g.add(part(box, M.light, [0.45, 0.06, 0.2], [0.6, 2.21, 0.85]));
  g.add(part(box, M.light, [0.45, 0.06, 0.2], [-0.6, 2.21, 0.85]));
  wheels(g, [1.35, -1.35], 0.85, 0.36);
  g.userData = { cabMat: bodyMat, length: 4.4 }; // already centred
  return g;
}

// ---------- the map layer ----------
const vehicles = new Map(); // id -> { group, kind, long, get: () => state }
let map = null;
let renderer = null;
let shown = true;
let pending = false;
const scene = new THREE.Scene();
const camera = new THREE.Camera();
scene.add(new THREE.AmbientLight(0xffffff, 2.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.4);
sun.position.set(0.6, -0.8, 1.2);
scene.add(sun);

const layer = {
  id: 'ib-vehicles',
  type: 'custom',
  renderingMode: '3d',
  onAdd(m, gl) {
    if (!renderer) {
      renderer = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
    }
  },
  render(gl, args) {
    if (!renderer || !shown) return;
    const matrix = args && args.defaultProjectionData ? args.defaultProjectionData.mainMatrix : args;
    const c = map.getCenter();
    const center = maplibregl.MercatorCoordinate.fromLngLat(c, 0);
    const zoom = map.getZoom();
    // Everything is placed relative to the map centre (small numbers keep it steady when zoomed in).
    camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix)
      .multiply(new THREE.Matrix4().makeTranslation(center.x, center.y, center.z));
    vehicles.forEach((v) => {
      const s = v.get();
      if (!s) { v.group.visible = false; return; }
      const mc = maplibregl.MercatorCoordinate.fromLngLat([s.lng, s.lat], 0);
      const unit = mc.meterInMercatorCoordinateUnits();
      const pxPerM = (512 * 2 ** zoom) / (EARTH * Math.cos((s.lat * Math.PI) / 180));
      const grow = Math.max(1, MIN_PX / (v.group.userData.length * pxPerM));
      const k = unit * grow;
      v.group.visible = true;
      v.group.matrixAutoUpdate = false;
      v.group.matrix = new THREE.Matrix4()
        .makeTranslation(mc.x - center.x, mc.y - center.y, 0)
        .multiply(new THREE.Matrix4().makeScale(k, k, k))
        .multiply(new THREE.Matrix4().makeRotationZ(Math.PI + ((s.heading || 0) * Math.PI) / 180));
      v.group.userData.cabMat.color.setHex(STATUS_COLOR[s.status] ?? STATUS_COLOR.none);
      v.group.updateMatrixWorld(true);
      if (v.group.userData.boxMat) v.group.userData.boxMat.color.setHex(URGENCY_COLOR[s.urgency] ?? URGENCY_COLOR.normal);
    });
    renderer.resetState();
    renderer.render(scene, camera);
  },
};

function repaint() {
  if (pending || !map) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; if (map) map.triggerRepaint(); });
}

window.Vehicles3D = {
  // Adds the layer to the map (again after every base-map change).
  attach(glMap) {
    map = glMap;
    const add = () => { if (!map.getLayer(layer.id)) map.addLayer(layer); };
    if (map.isStyleLoaded()) add();
    map.on('style.load', add);
    document.documentElement.classList.add('vehicles-3d');
  },
  // get() returns { lat, lng, heading, status, urgency } or null; kind 'truck' | 'car'.
  set(id, kind, long, get) {
    const v = vehicles.get(id);
    if (v && v.kind === kind && v.long === long) { v.get = get; repaint(); return; }
    if (v) scene.remove(v.group);
    const group = kind === 'car' ? buildCar() : buildTruck(long);
    scene.add(group);
    vehicles.set(id, { group, kind, long, get });
    repaint();
  },
  remove(id) {
    const v = vehicles.get(id);
    if (v) { scene.remove(v.group); vehicles.delete(id); repaint(); }
  },
  show(on) { shown = on; repaint(); },
  repaint,
};
window.dispatchEvent(new Event('vehicles3d-ready'));
