// Transport Hub: the driver's current job (on the driver page, in the app).
// One big button for the next step; delivery needs a photo of the signed bilty.
(() => {
  const { sb } = Ibraya;
  const box = document.getElementById('job');
  if (!box) return;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const localPhone = (p) => (p && p.startsWith('+92') ? '0' + p.slice(3) : p || '');
  const day = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-PK', { weekday: 'short', day: 'numeric', month: 'short' });
  const EQUIPMENT = { container_20: '20ft container', container_40: '40ft container', flatbed: 'Flatbed / trailer', open_body: 'Open body truck', covered: 'Covered / box truck', other: 'Truck' };

  const NEXT = {
    assigned: { step: 'at_pickup', en: 'I have arrived at pickup', ur: 'میں پک اپ پر پہنچ گیا ہوں' },
    at_pickup: { step: 'loaded', en: 'Truck is loaded', ur: 'ٹرک لوڈ ہو گیا' },
    loaded: { step: 'at_drop', en: 'I have arrived at the destination', ur: 'میں منزل پر پہنچ گیا ہوں' },
    at_drop: { step: 'delivered', en: 'Delivered: take a photo of the signed bilty', ur: 'ڈیلیور: دستخط شدہ بلٹی کی تصویر لیں' },
  };
  const STATUS = {
    assigned: 'Go to pickup · پک اپ پر جائیں',
    at_pickup: 'At pickup · پک اپ پر',
    loaded: 'Loaded, on the way · راستے میں',
    at_drop: 'At destination · منزل پر',
    delivered: 'Delivered ✓ · ڈیلیور ہو گیا',
  };
  const STEPS = ['at_pickup', 'loaded', 'at_drop', 'delivered'];
  const STEP_SHORT = { at_pickup: 'Pickup', loaded: 'Loaded', at_drop: 'Arrived', delivered: 'Delivered' };

  let jobs = [];
  let working = false;

  const placeText = (place, city) => [place, city].filter(Boolean).join(', ');
  const directions = (place, city) => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(placeText(place, city) + ', Pakistan')}`;

  function render() {
    const active = jobs.find((j) => j.trip.status !== 'delivered');
    if (!active) { box.hidden = true; box.innerHTML = ''; return; }
    const { trip: t, load: l, shipper } = active;
    const toDrop = t.status === 'loaded' || t.status === 'at_drop';
    const next = NEXT[t.status];
    box.hidden = false;
    box.innerHTML = `
      <div class="job-head"><b>Your job · آپ کا کام</b><span class="pill small warn">${STATUS[t.status]}</span></div>
      <div class="job-route">
        <div class="${toDrop ? 'done' : 'now'}"><small>Pickup · ${day(l.pickup_date)}</small><b>${esc(l.pickup_city)}</b><span>${esc(l.pickup_place)}</span></div>
        <div class="${toDrop ? 'now' : ''}"><small>Deliver to</small><b>${esc(l.drop_city)}</b><span>${esc(l.drop_place)}</span></div>
      </div>
      <div class="muted small">${[EQUIPMENT[l.equipment], l.cargo, l.weight_tons ? `${Number(l.weight_tons)} t` : '', l.container_no ? `Container ${l.container_no}` : ''].filter(Boolean).map(esc).join(' · ')}</div>
      ${l.notes ? `<div class="muted small">“${esc(l.notes)}”</div>` : ''}
      <div class="job-progress">${STEPS.map((s) => `<span class="${t.steps[s] ? 'done' : ''}">${STEP_SHORT[s]}</span>`).join('')}</div>
      <div class="job-actions">
        <a class="btn btn-ghost" target="_blank" rel="noopener" href="${directions(toDrop ? l.drop_place : l.pickup_place, toDrop ? l.drop_city : l.pickup_city)}">🧭 Directions · راستہ</a>
        ${shipper && shipper.phone ? `<a class="btn btn-ghost" href="tel:${esc(shipper.phone)}">📞 ${esc(shipper.person || shipper.name)}</a>` : ''}
      </div>
      ${next ? `<button class="btn job-next" id="job-next">${next.en}<span>${next.ur}</span></button>
        <input type="file" id="pod-file" accept="image/*" capture="environment" hidden>` : ''}
      <div class="error" id="job-error"></div>`;
    const btn = document.getElementById('job-next');
    if (btn) btn.addEventListener('click', () => (t.status === 'at_drop' ? document.getElementById('pod-file').click() : step(t, next.step)));
    const file = document.getElementById('pod-file');
    if (file) file.addEventListener('change', () => { if (file.files[0]) deliver(t, file.files[0]); });
  }

  async function run(fn) {
    if (working) return;
    working = true;
    const btn = document.getElementById('job-next');
    const err = document.getElementById('job-error');
    if (btn) btn.disabled = true;
    if (err) err.textContent = '';
    try {
      await fn();
    } catch (e) {
      const el = document.getElementById('job-error');
      if (el) el.textContent = Ibraya.friendlyError(e);
    } finally {
      working = false;
      const b = document.getElementById('job-next');
      if (b) b.disabled = false;
    }
  }

  function step(t, next) {
    return run(async () => {
      const { data, error } = await sb.rpc('trip_step', { p_trip: t.id, p_step: next });
      if (error) throw error;
      jobs = data;
      render();
    });
  }

  // Photos from the camera are big: send a smaller JPEG (the bilty stays readable).
  async function shrink(file) {
    try {
      const url = URL.createObjectURL(file);
      const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url; });
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', 0.82));
      return blob ? { blob, ext: 'jpg', type: 'image/jpeg' } : null;
    } catch {
      return null; // a format the phone can't draw (e.g. HEIC): send the original
    }
  }

  function deliver(t, file) {
    return run(async () => {
      const btn = document.getElementById('job-next');
      if (btn) btn.firstChild.textContent = 'Sending photo… ';
      const small = await shrink(file);
      const ext = small ? small.ext : (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5);
      const path = `${t.load_id}/${t.id}-${Date.now()}.${ext}`;
      const up = await sb.storage.from('trip-pod').upload(path, small ? small.blob : file, { contentType: small ? small.type : file.type || undefined });
      if (up.error) throw up.error;
      const { data, error } = await sb.rpc('trip_step', { p_trip: t.id, p_step: 'delivered', p_pod_path: path });
      if (error) throw error;
      jobs = data;
      render();
      Ibraya.message('Delivered ✓ · ڈیلیور ہو گیا', 'Thank you. The photo was sent to your company and the shipper.');
    });
  }

  async function load() {
    const { data, error } = await sb.rpc('my_trips');
    if (error) return;
    jobs = data || [];
    if (!working) render();
  }

  window.IbrayaJobs = {
    start(userId) {
      load();
      sb.channel('my-trips')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'trips', filter: `driver_id=eq.${userId}` }, () => load())
        .subscribe();
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });
    },
  };
})();
