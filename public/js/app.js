// Shared helpers for every page: Supabase client, phone handling, profile + page routing.
window.Ibraya = (() => {
  const { supabaseUrl, supabaseKey } = window.IBRAYA;
  // Read before Supabase consumes the URL: did we arrive from a password-reset link or an auth error?
  const urlInfo = new URLSearchParams(location.hash.slice(1) || location.search.slice(1));
  const cameFromRecovery = urlInfo.get('type') === 'recovery';
  const urlError = urlInfo.get('error_description');
  const sb = window.supabase.createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  // Inside the Ibraya Android app the page can talk to the native 24/7 tracking service.
  const cap = window.Capacitor;
  const inApp = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  const tracker = inApp && cap.Plugins ? cap.Plugins.IbrayaTracker || null : null;

  // Phone accounts sign in to Supabase with this placeholder email (no SMS needed).
  const PHONE_DOMAIN = 'phone.ibraya.local';

  const ROLES = {
    driver: 'Driver',
    import_driver: 'Import Driver',
    export_driver: 'Export Driver',
    admin: 'Admin',
  };

  // Same rules as public.normalize_phone() in the database:
  // 03001234567 / 3001234567 / +92 300 1234567 -> +923001234567
  function normalizePhone(raw) {
    let d = String(raw || '').replace(/\D/g, '');
    if (d.startsWith('0') && d.length === 11) d = '92' + d.slice(1);
    if (d.startsWith('3') && d.length === 10) d = '92' + d;
    if (d.length < 9 || d.length > 15) return null;
    return '+' + d;
  }

  // Inside the app: is the SIM for this number in this phone?
  // 'verified' | 'unverified' (the SIM doesn't store its own number) | 'mismatch' | 'no_sim'
  // | 'denied' (no "Phone" permission) | null (browser, or an older app that can't check).
  async function checkSim(phone) {
    if (!tracker) return null;
    let info;
    try {
      info = await tracker.getSimNumbers();
    } catch {
      return null; // older app version without this check
    }
    if (!info.permitted) return 'denied';
    if (info.sims === 0) return 'no_sim';
    if (info.sims < 0) return 'unverified';
    const numbers = (info.numbers || []).map(normalizePhone).filter(Boolean);
    if (numbers.includes(phone)) return 'verified';
    return info.unreadable > 0 ? 'unverified' : 'mismatch';
  }

  const phoneEmail = (phone) => `${phone.slice(1)}@${PHONE_DOMAIN}`;
  const isPhoneAccount = (user) => !!user?.email?.endsWith('@' + PHONE_DOMAIN);

  // Turn Supabase's technical messages into plain ones.
  function friendlyError(err) {
    const msg = err?.message || String(err || 'Something went wrong');
    if (/invalid login credentials/i.test(msg)) return 'Wrong phone number / email or password';
    if (/email not confirmed/i.test(msg)) return 'Please confirm your email first. Check your inbox for the link.';
    if (/user already registered/i.test(msg)) return 'This email is already registered. Sign in instead.';
    if (/provider is not enabled/i.test(msg)) return 'Google sign-in is not switched on yet.';
    if (/rate limit|too many/i.test(msg)) return 'Too many attempts. Please wait a few minutes and try again.';
    if (/failed to fetch|network/i.test(msg)) return 'No internet connection. Check your signal and try again.';
    return msg;
  }

  // Calls the "account" Edge Function (phone sign-up, admin delete/reset).
  async function account(action, body = {}) {
    const { data: { session } } = await sb.auth.getSession();
    const headers = { 'Content-Type': 'application/json', apikey: supabaseKey };
    if (session) headers.Authorization = `Bearer ${session.access_token}`;
    const res = await fetch(`${supabaseUrl}/functions/v1/account`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action, ...body }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && session) return signInAgain();
    if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong'), { data });
    return data;
  }

  async function myProfile() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return null;
    const { data, error } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
    if (error) throw error;
    return data;
  }

  const homeFor = (profile) => (profile.role === 'admin' ? '/admin' : '/driver');

  // The sign-in was ended on the server (e.g. a password was set for this account when it was
  // made admin), but this phone still holds it: forget it and ask to sign in again.
  async function signInAgain() {
    await sb.auth.signOut({ scope: 'local' }).catch(() => {});
    location.replace('/login#error_description=' + encodeURIComponent('Please sign in again. Admin: use your phone number and password.'));
    return new Promise(() => {}); // the page is leaving
  }

  // Ask the server whether this sign-in is still valid (the page can't tell on its own).
  async function sessionStillValid() {
    const { error } = await sb.auth.getUser();
    // A network problem is not a reason to sign out; only the server saying no is.
    return !(error && (error.status === 401 || error.status === 403 || /session|jwt|token/i.test(error.message || '')));
  }

  // For /driver and /admin: send the visitor to the right page if this isn't it.
  async function guard(page) {
    let profile = null;
    try {
      profile = await myProfile();
    } catch { /* treat as signed out */ }
    if (!profile || !profile.phone) {
      location.replace('/login');
      return null;
    }
    if (!(await sessionStillValid())) {
      await signInAgain();
      return null;
    }
    const home = homeFor(profile);
    // A tracked admin may also open the driver page, to finish the phone's tracking setup.
    const trackedAdminSetup = page === '/driver' && profile.role === 'admin' && profile.tracked;
    if (home !== page && !trackedAdminSetup) {
      location.replace(home);
      return null;
    }
    return profile;
  }

  // Go to the sign-in page once, even if several things trigger it at the same moment.
  let leaving = false;
  function toLogin() {
    if (leaving) return;
    leaving = true;
    location.replace('/login');
  }

  async function signOut() {
    if (leaving) return;
    if (tracker) {
      // Stop 24/7 tracking on this phone and cancel its device token.
      await sb.rpc('unregister_my_tracker_devices').then(() => {}, () => {});
      await tracker.stop().catch(() => {});
    }
    await sb.auth.signOut().catch(() => {});
    toLogin();
  }

  // The site's own pop-up (instead of the browser's alert/confirm/prompt boxes).
  // Resolves true/false for a question, the typed text (or null) for an input, true for a message.
  function dialog({ title, message = '', okText = 'OK', cancelText = 'Cancel', danger = false, input = null, cancel = true }) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'modal-backdrop';
      wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
          <h2 id="modal-title"></h2>
          <p class="modal-msg"></p>
          ${input ? '<input class="modal-input">' : ''}
          <div class="error modal-err"></div>
          <div class="modal-actions">
            ${cancel ? '<button type="button" class="btn btn-ghost modal-cancel"></button>' : ''}
            <button type="button" class="btn modal-ok"></button>
          </div>
        </div>`;
      wrap.querySelector('#modal-title').textContent = title;
      wrap.querySelector('.modal-msg').textContent = message;
      const ok = wrap.querySelector('.modal-ok');
      ok.textContent = okText;
      if (danger) ok.classList.add('btn-danger');
      const cancelBtn = wrap.querySelector('.modal-cancel');
      if (cancelBtn) cancelBtn.textContent = cancelText;
      const field = wrap.querySelector('.modal-input');
      if (field) {
        field.type = input.type || 'text';
        field.placeholder = input.placeholder || '';
        field.autocomplete = 'off';
      }
      const close = (value) => {
        document.removeEventListener('keydown', onKey);
        wrap.remove();
        resolve(value);
      };
      const submit = () => {
        if (!field) return close(true);
        const err = input.validate ? input.validate(field.value) : '';
        if (err) {
          wrap.querySelector('.modal-err').textContent = err;
          field.focus();
          return;
        }
        close(field.value);
      };
      const dismiss = () => close(field ? null : false);
      const onKey = (e) => {
        if (e.key === 'Escape' && cancel) dismiss();
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
      };
      ok.addEventListener('click', submit);
      if (cancelBtn) cancelBtn.addEventListener('click', dismiss);
      wrap.addEventListener('click', (e) => { if (e.target === wrap && cancel) dismiss(); });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(wrap);
      (field || ok).focus();
    });
  }
  const message = (title, text) => dialog({ title, message: text, cancel: false });

  return { sb, inApp, tracker, checkSim, dialog, message, cameFromRecovery, urlError, ROLES, normalizePhone, phoneEmail, isPhoneAccount, friendlyError, account, myProfile, homeFor, guard, signOut, toLogin };
})();
