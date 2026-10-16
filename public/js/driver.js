(async () => {
  const { sb } = Ibraya;
  const roleEl = document.getElementById('role');
  const whoEl = document.getElementById('who');
  const dot = document.getElementById('dot');
  const statusEl = document.getElementById('status');
  const enableBtn = document.getElementById('enable');

  const SEND_EVERY_MS = 5000;      // at most one update every 5 seconds while moving
  const HEARTBEAT_MS = 30000;      // re-send while parked so the admin sees the truck as live
  let watchId = null;
  let lastPos = null;
  let lastSent = 0;
  let lastFixAt = 0;              // when the phone last gave a new GPS reading
  const STOPPED_AFTER_MS = 15000; // phones often stop sending readings when the truck is parked
  let sending = false;

  document.getElementById('logout').addEventListener('click', () => Ibraya.signOut());

  const profile = await Ibraya.guard('/driver');
  if (!profile) return;

  function setStatus(text, state) {
    statusEl.textContent = text;
    dot.className = 'dot' + (state ? ' ' + state : '');
  }

  function showProfile(p) {
    if (p.role === 'admin') return location.replace('/admin');
    roleEl.textContent = Ibraya.ROLES[p.role] || p.role;
    whoEl.textContent = p.name;
  }
  showProfile(profile);

  // Role changes by the admin show up immediately; removal signs the driver out.
  sb.channel('my-profile')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${profile.id}` },
      (payload) => showProfile(payload.new))
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'profiles', filter: `id=eq.${profile.id}` },
      () => Ibraya.signOut())
    .subscribe();

  sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') Ibraya.toLogin();
  });

  async function sendLocation(force = false) {
    if (!lastPos || sending) return;
    if (!force && Date.now() - lastSent < SEND_EVERY_MS) return;
    if (Date.now() - lastFixAt > STOPPED_AFTER_MS) lastPos.speed = 0; // no new readings: not moving
    sending = true;
    try {
      const { error } = await sb.rpc('update_my_location', {
        p_lat: lastPos.lat,
        p_lng: lastPos.lng,
        p_accuracy: lastPos.accuracy,
        p_speed: lastPos.speed,
        p_heading: lastPos.heading,
      });
      if (error) throw error;
      lastSent = Date.now();
      setStatus('Location sharing is on', 'on');
    } catch (err) {
      if (/account removed/i.test(err?.message || '')) return Ibraya.signOut();
      setStatus('No connection. Retrying…', 'warn');
    } finally {
      sending = false;
    }
  }
  setInterval(() => sendLocation(Date.now() - lastSent >= HEARTBEAT_MS), 5000);
  window.addEventListener('online', () => sendLocation(true));

  // Ask the phone to keep the screen on, since browsers pause GPS when the page is hidden.
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible') {
        await navigator.wakeLock.request('screen');
      }
    } catch { /* not supported or denied — tracking still works while the page is open */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      keepAwake();
      sendLocation(true);
    }
  });

  // Some phones don't report speed. Work it out from the distance between two GPS fixes
  // (in metres per second, like the GPS value), ignoring fixes that are too rough or too close in time.
  let prevFix = null;
  let estimated = null;
  function estimateSpeed(pos) {
    const fix = { lat: pos.coords.latitude, lng: pos.coords.longitude, t: pos.timestamp, acc: pos.coords.accuracy };
    if (fix.acc > 50) return estimated;
    if (prevFix) {
      const dt = (fix.t - prevFix.t) / 1000;
      if (dt >= 3) {
        const rad = Math.PI / 180;
        const dLat = (fix.lat - prevFix.lat) * rad;
        const dLng = (fix.lng - prevFix.lng) * rad;
        const a = Math.sin(dLat / 2) ** 2 +
          Math.cos(prevFix.lat * rad) * Math.cos(fix.lat * rad) * Math.sin(dLng / 2) ** 2;
        const metres = 2 * 6371000 * Math.asin(Math.sqrt(a));
        // Movement smaller than the GPS error is just jitter: treat it as stopped.
        const v = metres < Math.max(fix.acc, prevFix.acc) ? 0 : metres / dt;
        // Smooth moving speeds a little; ignore impossible jumps (over ~250 km/h).
        if (v === 0) estimated = 0;
        else if (v < 70) estimated = estimated == null ? v : 0.5 * estimated + 0.5 * v;
        prevFix = fix;
      }
    } else {
      prevFix = fix;
    }
    return estimated;
  }

  function startTracking() {
    if (!('geolocation' in navigator)) {
      return setStatus('This browser cannot share location', 'warn');
    }
    if (!window.isSecureContext) {
      return setStatus('Location needs a secure (https) connection', 'warn');
    }
    enableBtn.hidden = true;
    setStatus('Waiting for GPS…', 'warn');
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const c = pos.coords;
        const first = !lastPos;
        const speed = Number.isFinite(c.speed) && c.speed >= 0 ? c.speed : estimateSpeed(pos);
        lastPos = { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy, speed, heading: c.heading };
        lastFixAt = Date.now();
        sendLocation(first);
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setStatus('Location permission is blocked', 'warn');
          enableBtn.hidden = false;
        } else {
          setStatus('Searching for GPS signal…', 'warn');
        }
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 }
    );
    keepAwake();
  }

  enableBtn.addEventListener('click', startTracking);
  startTracking();
})();
