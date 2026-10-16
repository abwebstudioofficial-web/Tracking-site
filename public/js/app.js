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
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
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
    const home = homeFor(profile);
    if (home !== page) {
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

  return { sb, inApp, tracker, cameFromRecovery, urlError, ROLES, normalizePhone, phoneEmail, isPhoneAccount, friendlyError, account, myProfile, homeFor, guard, signOut, toLogin };
})();
