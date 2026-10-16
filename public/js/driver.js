(() => {
  const roleEl = document.getElementById('role');
  const whoEl = document.getElementById('who');
  const dot = document.getElementById('dot');
  const statusEl = document.getElementById('status');
  const enableBtn = document.getElementById('enable');
  let watchId = null;
  let wakeLock = null;
  let lastPos = null;

  function setStatus(text, state) {
    statusEl.textContent = text;
    dot.className = 'dot' + (state ? ' ' + state : '');
  }

  function showUser(user) {
    if (user.role === 'admin') return (location.href = '/admin');
    roleEl.textContent = user.roleLabel;
    whoEl.textContent = user.name;
  }

  fetch('/api/me')
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((d) => showUser(d.user))
    .catch(() => (location.href = '/login'));

  const socket = io();
  socket.on('connect_error', (err) => {
    if (err.message === 'unauthorized') location.href = '/login';
  });
  socket.on('role:changed', showUser);
  socket.on('account:deleted', () => (location.href = '/login'));

  // Ask the phone to keep the screen on, since browsers pause GPS when the page is hidden.
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch { /* not supported or denied — tracking still works while the page is open */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') keepAwake();
  });

  function sendLocation() {
    if (!lastPos) return;
    if (socket.connected) {
      socket.emit('location', lastPos);
      setStatus('Location sharing is on', 'on');
    } else {
      setStatus('Reconnecting…', 'warn');
    }
  }
  socket.on('connect', sendLocation);

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
        lastPos = { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy, speed: c.speed, heading: c.heading };
        sendLocation();
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
  socket.on('disconnect', () => setStatus('Reconnecting…', 'warn'));
  startTracking();

  document.getElementById('logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    location.href = '/login';
  });
})();
