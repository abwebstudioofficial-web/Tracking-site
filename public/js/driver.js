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
    if (p.role === 'admin' && !p.tracked) return location.replace('/admin');
    document.getElementById('to-admin').hidden = p.role !== 'admin';
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

  // ---------- inside the Ibraya Android app: 24/7 tracking by the native service ----------
  // The steps (and where things are in the settings) depend a little on the phone brand.
  const AUTOSTART_KEY = 'ibraya-autostart-done';
  const autostartDone = () => { try { return localStorage.getItem(AUTOSTART_KEY) === '1'; } catch { return false; } };
  function stepsFor(brand) {
    const B = window.IbrayaBrands;
    const bg = B.background[brand] || B.background.other;
    const bat = B.battery[brand];
    const auto = B.autostart[brand];
    return [
      {
        key: 'location', en: 'Allow location', ur: 'لوکیشن کی اجازت دیں',
        button: 'Allow · اجازت دیں', action: 'requestLocation',
      },
      {
        key: 'background', en: 'Choose "Allow all the time"', ur: 'لوکیشن میں "ہر وقت اجازت دیں" منتخب کریں',
        help: `A screen opens: choose "Allow all the time", then come back. If the app's settings open instead: ${bg[0]}.`,
        helpUr: `ایک اسکرین کھلے گی: "Allow all the time" چنیں اور واپس آئیں۔ اگر ایپ کی سیٹنگز کھلیں تو: ${bg[1]}`,
        button: 'Open settings · سیٹنگز کھولیں', action: 'openBackgroundLocationSettings', needs: 'location',
      },
      {
        key: 'notifications', en: 'Allow notifications', ur: 'نوٹیفکیشن کی اجازت دیں',
        button: 'Allow · اجازت دیں', action: 'requestNotifications',
      },
      {
        key: 'battery', en: 'Stop battery saver from closing tracking', ur: 'بیٹری سیور کو ٹریکنگ بند کرنے سے روکیں',
        help: `Tap "Allow" on the next screen.${bat ? ` ${bat[0]}` : ''}`,
        helpUr: `اگلی اسکرین پر "Allow" دبائیں۔${bat ? ` ${bat[1]}` : ''}`,
        button: 'Allow · اجازت دیں', action: 'requestIgnoreBatteryOptimizations',
      },
      ...(auto ? [{
        key: 'autostart', en: 'Turn on Autostart', ur: 'آٹو اسٹارٹ آن کریں',
        help: `${auto[0]} Then come back and tap "Done".`,
        helpUr: `${auto[1]} پھر واپس آ کر "ہو گیا" دبائیں۔`,
        button: 'Open settings · سیٹنگز کھولیں', action: 'openAutostartSettings',
        button2: 'Done · ہو گیا', action2: 'autostartDone',
      }] : []),
      {
        key: 'gpsOn', en: 'Turn on Location (GPS)', ur: 'فون کی لوکیشن (GPS) آن کریں',
        button: 'Turn on · آن کریں', action: 'openLocationSettings',
      },
    ];
  }
  let STEPS = stepsFor('other');

  function renderSetup(st) {
    st = { ...st, autostart: autostartDone() };
    STEPS = stepsFor((window.IbrayaBrands && IbrayaBrands.detect(st.device)) || 'other');
    const stepsEl = document.getElementById('steps');
    const pending = STEPS.filter((step) => !st[step.key]);
    document.getElementById('app-setup').hidden = pending.length === 0;
    stepsEl.innerHTML = STEPS.map((step, i) => {
      const done = !!st[step.key];
      const locked = step.needs && !st[step.needs];
      return `<li class="step ${done ? 'done' : ''}">
        <span class="num">${done ? '✓' : i + 1}</span>
        <div class="text"><b>${step.en}</b><span>${step.ur}</span>${!done && step.help ? `<small class="hint" style="text-align:left;display:block;margin:4px 0 0">${step.help}</small>` : ''}${!done && step.helpUr ? `<small class="hint" dir="rtl" style="text-align:right;display:block;margin:2px 0 0">${IbrayaBrands.urduHtml(step.helpUr)}</small>` : ''}</div>
        ${done ? '' : `<button class="btn" data-action="${step.action}" ${locked ? 'disabled' : ''}>${step.button}</button>`}
        ${done || !step.button2 ? '' : `<button class="btn btn-ghost" data-action="${step.action2}">${step.button2}</button>`}
      </li>`;
    }).join('');

    const keepOpen = document.getElementById('keep-open');
    keepOpen.textContent = pending.length
      ? 'Finish these steps once. Then tracking runs by itself. · یہ مراحل ایک بار مکمل کریں۔'
      : 'You can close the app. Tracking keeps running. · ایپ بند کر سکتے ہیں، ٹریکنگ جاری رہے گی۔';
    if (st.running && st.lastSentAt && Date.now() - st.lastSentAt < 3 * 60 * 1000) {
      setStatus(pending.length ? 'Tracking is on · ٹریکنگ آن ہے' : 'Tracking 24/7 is on · ٹریکنگ چل رہی ہے', 'on');
    } else if (st.running) {
      setStatus(st.lastError && st.lastError !== 'signed out' ? 'Waiting for signal… · سگنل کا انتظار' : 'Starting tracking… · ٹریکنگ شروع ہو رہی ہے', 'warn');
    } else {
      setStatus('Tracking is off: finish the steps below · ٹریکنگ بند ہے', 'warn');
    }
  }

  async function ensureDeviceToken(st) {
    if (st.hasToken) return st;
    const { data: token, error } = await sb.rpc('register_tracker_device', { p_device_name: st.device || null });
    if (error) throw error;
    return Ibraya.tracker.start({ token, supabaseUrl: IBRAYA.supabaseUrl, apiKey: IBRAYA.supabaseKey });
  }

  async function refreshApp() {
    try {
      let st = await Ibraya.tracker.getStatus();
      st = await ensureDeviceToken(st);
      renderSetup(st);
    } catch (err) {
      setStatus(Ibraya.friendlyError(err), 'warn');
    }
  }

  // Each time the app opens: is this driver's SIM still in this phone? (Shown to the admin.)
  let simCheckedAt = 0;
  async function recheckSim() {
    if (Date.now() - simCheckedAt < 60000) return;
    simCheckedAt = Date.now();
    const sim = await Ibraya.checkSim(profile.phone);
    if (!sim || sim === 'denied') return;
    await sb.rpc('set_my_sim_check', { p_status: sim === 'no_sim' ? 'mismatch' : sim }).then(() => {}, () => {});
  }

  function startAppTracking() {
    document.getElementById('steps').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      btn.disabled = true;
      if (btn.dataset.action === 'autostartDone') {
        try { localStorage.setItem(AUTOSTART_KEY, '1'); } catch { /* ignore */ }
        return refreshApp();
      }
      try {
        renderSetup(await Ibraya.tracker[btn.dataset.action]());
      } catch { /* the driver cancelled */ }
      btn.disabled = false;
      setTimeout(refreshApp, 800);
    });
    // Coming back from Android settings: check again.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { refreshApp(); recheckSim(); }
    });
    recheckSim();
    setInterval(() => { if (document.visibilityState === 'visible') refreshApp(); }, 5000);
    refreshApp();
  }

  if (Ibraya.tracker) {
    startAppTracking();
  } else {
    // Android phone in a normal browser: offer the app.
    if (/Android/i.test(navigator.userAgent)) document.getElementById('get-app').hidden = false;
    enableBtn.addEventListener('click', startTracking);
    startTracking();
  }
})();
