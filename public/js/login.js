(() => {
  const { sb } = Ibraya;
  const $ = (id) => document.getElementById(id);
  const views = ['view-main', 'view-check-email', 'view-forgot', 'view-new-password', 'view-complete'];
  const form = $('form');
  let mode = 'login';
  let busy = false;

  function show(view) {
    views.forEach((v) => ($(v).hidden = v !== view));
  }

  async function withButton(btn, errorEl, fn) {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    if (errorEl) errorEl.textContent = '';
    try {
      await fn();
    } catch (err) {
      if (errorEl) errorEl.textContent = Ibraya.friendlyError(err);
    } finally {
      busy = false;
      btn.disabled = false;
    }
  }

  // After any successful sign-in: ask for a phone number if missing, else go to the right page.
  async function continueSignedIn() {
    const profile = await Ibraya.myProfile();
    if (!profile) throw new Error('Your account is still being set up. Please try again in a moment.');
    if (!profile.phone) {
      $('complete-form').name.value = profile.name || '';
      show('view-complete');
      return;
    }
    location.replace(Ibraya.homeFor(profile));
  }

  // ---------- sign in / create account ----------
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.addEventListener('click', () => {
      mode = b.dataset.mode;
      document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
      $('name-field').hidden = mode !== 'register';
      $('forgot-row').hidden = mode === 'register';
      $('submit').textContent = mode === 'register' ? 'Create account' : 'Sign in';
      form.password.autocomplete = mode === 'register' ? 'new-password' : 'current-password';
      $('hint').textContent = mode === 'register'
        ? 'Drivers: use the phone number you carry while driving.'
        : 'Drivers: sign in with the phone number you registered with.';
      $('error').textContent = '';
    });
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    withButton($('submit'), $('error'), async () => {
      const identity = form.identity.value.trim();
      const password = form.password.value;
      const isEmail = identity.includes('@');
      const phone = isEmail ? null : Ibraya.normalizePhone(identity);
      if (!isEmail && !phone) throw new Error('Enter a valid phone number or email');
      if (password.length < 6) throw new Error('Password must be at least 6 characters');

      if (mode === 'register') {
        const name = form.name.value.trim();
        if (!name) throw new Error('Please enter your name');
        if (isEmail) {
          const { data, error } = await sb.auth.signUp({
            email: identity,
            password,
            options: { data: { name }, emailRedirectTo: `${location.origin}/login` },
          });
          if (error) throw error;
          // Supabase hides "already registered" for privacy; an empty identities list means exactly that.
          if (data.user && data.user.identities && data.user.identities.length === 0) {
            throw new Error('This email is already registered. Sign in instead.');
          }
          if (!data.session) {
            $('sent-to').textContent = identity;
            show('view-check-email');
            return;
          }
        } else {
          await Ibraya.account('phone-signup', { name, phone, password });
          const { error } = await sb.auth.signInWithPassword({ email: Ibraya.phoneEmail(phone), password });
          if (error) throw error;
        }
      } else {
        const email = isEmail ? identity : Ibraya.phoneEmail(phone);
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
      await continueSignedIn();
    });
  });

  // ---------- Google ----------
  $('google-btn').addEventListener('click', () => {
    withButton($('google-btn'), $('error'), async () => {
      const { error } = await sb.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: `${location.origin}/login` },
      });
      if (error) throw error;
    });
  });

  // Only show the Google button once it has been switched on in Supabase.
  fetch(`${IBRAYA.supabaseUrl}/auth/v1/settings`, { headers: { apikey: IBRAYA.supabaseKey } })
    .then((r) => r.json())
    .then((s) => { if (s?.external?.google) $('google-area').hidden = false; })
    .catch(() => {});

  // ---------- forgot password ----------
  $('forgot-link').addEventListener('click', () => {
    $('forgot-form').identity.value = form.identity.value;
    $('forgot-error').textContent = '';
    $('forgot-notice').hidden = true;
    show('view-forgot');
  });

  $('forgot-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    withButton($('forgot-submit'), $('forgot-error'), async () => {
      const identity = f.identity.value.trim();
      const notice = $('forgot-notice');
      if (!identity.includes('@')) {
        if (!Ibraya.normalizePhone(identity)) throw new Error('Enter a valid phone number or email');
        notice.textContent = 'Phone accounts: ask your admin to set a new password for you. They can do it from the admin page.';
        notice.hidden = false;
        return;
      }
      const { error } = await sb.auth.resetPasswordForEmail(identity, { redirectTo: `${location.origin}/login` });
      if (error) throw error;
      notice.textContent = `If ${identity} has an account, a reset link is on its way. Open it on this phone.`;
      notice.hidden = false;
    });
  });

  $('new-password-form').addEventListener('submit', (e) => {
    e.preventDefault();
    withButton($('new-password-submit'), $('new-password-error'), async () => {
      const password = e.target.password.value;
      if (password.length < 6) throw new Error('Password must be at least 6 characters');
      const { error } = await sb.auth.updateUser({ password });
      if (error) throw error;
      history.replaceState(null, '', '/login');
      await continueSignedIn();
    });
  });

  // ---------- add phone (Google / email users) ----------
  $('complete-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    withButton($('complete-submit'), $('complete-error'), async () => {
      if (!Ibraya.normalizePhone(f.phone.value)) throw new Error('Please enter a valid phone number');
      const { error } = await sb.rpc('complete_my_profile', { p_name: f.name.value, p_phone: f.phone.value });
      if (error) throw error;
      await continueSignedIn();
    });
  });
  $('complete-signout').addEventListener('click', () => Ibraya.signOut());

  document.querySelectorAll('.back').forEach((b) => b.addEventListener('click', () => {
    document.querySelector('.tabs [data-mode=login]').click();
    show('view-main');
  }));

  // ---------- on load ----------
  if (Ibraya.urlError) $('error').textContent = Ibraya.urlError.replace(/\+/g, ' ');

  sb.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') show('view-new-password');
  });

  sb.auth.getSession().then(({ data: { session } }) => {
    if (!session) return;
    if (Ibraya.cameFromRecovery) return show('view-new-password');
    continueSignedIn().catch((err) => ($('error').textContent = Ibraya.friendlyError(err)));
  });
})();
