(() => {
  const { sb } = Ibraya;
  const $ = (id) => document.getElementById(id);
  const views = ['view-phone', 'view-main', 'view-check-email', 'view-forgot', 'view-new-password', 'view-complete'];
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
      $('submit').textContent = mode === 'register' ? 'Create business account' : 'Sign in';
      form.password.autocomplete = mode === 'register' ? 'new-password' : 'current-password';
      $('hint').textContent = mode === 'register'
        ? 'Next you tell us about your company. Drivers don\'t need an account here: their company adds them.'
        : 'Drivers don\'t need a password.';
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
            options: { data: { name, account: 'business' }, emailRedirectTo: `${location.origin}/login` },
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

  // ---------- drivers: phone number only ----------
  const phoneForm = $('phone-form');
  function askName(show) {
    $('phone-name-field').hidden = !show;
    $('phone-new-hint').hidden = !show;
    if (show) phoneForm.name.focus();
  }
  phoneForm.phone.addEventListener('input', () => askName(false));

  phoneForm.addEventListener('submit', (e) => {
    e.preventDefault();
    withButton($('phone-submit'), $('phone-error'), async () => {
      const phone = Ibraya.normalizePhone(phoneForm.phone.value);
      if (!phone) throw new Error('Enter a valid phone number · درست فون نمبر لکھیں');
      const asking = !$('phone-name-field').hidden;
      const name = phoneForm.name.value.trim();
      if (asking && !name) throw new Error('Please enter your name · اپنا نام لکھیں');
      // In the app: the SIM for this number must be in this phone.
      const sim = await Ibraya.checkSim(phone);
      if (sim === 'denied') {
        const open = await Ibraya.dialog({
          title: 'Allow "Phone" · "فون" کی اجازت دیں',
          message: 'The app checks that this number\'s SIM is in this phone. Open settings → Permissions → Phone → Allow, then come back.\nایپ چیک کرتی ہے کہ اس نمبر کی سم اسی فون میں ہے۔ سیٹنگز میں Permissions → Phone → Allow کریں۔',
          okText: 'Open settings · سیٹنگز',
        });
        if (open) Ibraya.tracker.openAppSettings().catch(() => {});
        return;
      }
      if (sim === 'no_sim') throw new Error('Put the SIM of this number in this phone · اس نمبر کی سم اس فون میں ڈالیں');
      if (sim === 'mismatch') {
        throw new Error('This number\'s SIM is not in this phone. Use the number of the SIM in this phone. · اس نمبر کی سم اس فون میں نہیں ہے۔ اسی فون کی سم والا نمبر استعمال کریں۔');
      }
      let result;
      try {
        result = await Ibraya.account('phone-login', asking ? { phone, name } : { phone });
      } catch (err) {
        if (err.data && err.data.needsPassword) {
          // An admin or business number: switch to the password form.
          show('view-main');
          form.identity.value = phoneForm.phone.value;
          form.password.focus();
          $('error').textContent = err.message;
          return;
        }
        throw err;
      }
      if (result.needsName) return askName(true);
      const { error } = await sb.auth.verifyOtp({ token_hash: result.tokenHash, type: 'magiclink' });
      if (error) throw error;
      if (sim) await sb.rpc('set_my_sim_check', { p_status: sim }).then(() => {}, () => {});
      await continueSignedIn();
    });
  });

  $('to-admin').addEventListener('click', () => { $('error').textContent = ''; show('view-main'); });
  $('to-phone').addEventListener('click', () => { $('phone-error').textContent = ''; show('view-phone'); });

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
    // Google doesn't allow its sign-in inside apps, so the app shows phone/email only.
    .then((s) => { if (s?.external?.google && !Ibraya.inApp) $('google-area').hidden = false; })
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
        notice.textContent = 'Phone accounts: ask a Transport Hub admin to set a new password for you.';
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
  show('view-phone');

  if (Ibraya.inApp) {
    $('hint').textContent = 'Drivers don\'t need a password. (Signed up with Google? Tap "Forgot password?" to set a password for your Gmail.)';
  }

  // ---------- on load ----------
  if (Ibraya.urlError) {
    show('view-main');
    $('error').textContent = Ibraya.urlError.replace(/\+/g, ' ');
  }

  sb.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') show('view-new-password');
  });

  sb.auth.getSession().then(({ data: { session } }) => {
    // Sent here with a message (e.g. "sign in again"): stay, never bounce straight back.
    if (!session || Ibraya.urlError) return;
    if (Ibraya.cameFromRecovery) return show('view-new-password');
    continueSignedIn().catch((err) => ($('error').textContent = Ibraya.friendlyError(err)));
  });
})();
