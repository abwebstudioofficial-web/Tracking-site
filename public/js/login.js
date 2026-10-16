(() => {
  const form = document.getElementById('form');
  const nameField = document.getElementById('name-field');
  const submit = document.getElementById('submit');
  const error = document.getElementById('error');
  const hint = document.getElementById('hint');
  let mode = 'login';

  // Already signed in? Go straight to the right page.
  fetch('/api/me').then((r) => r.ok && r.json()).then((d) => {
    if (d && d.user) location.href = d.user.role === 'admin' ? '/admin' : '/driver';
  });

  document.querySelectorAll('.tabs button').forEach((b) => {
    b.addEventListener('click', () => {
      mode = b.dataset.mode;
      document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
      nameField.hidden = mode !== 'register';
      submit.textContent = mode === 'register' ? 'Create account' : 'Sign in';
      form.password.autocomplete = mode === 'register' ? 'new-password' : 'current-password';
      hint.textContent = mode === 'register'
        ? 'Use the phone number you carry while driving.'
        : 'Drivers: sign in with the phone number you registered with.';
      error.textContent = '';
    });
  });

  // ---------- Sign in with Google ----------
  const googleArea = document.getElementById('google-area');
  const phoneForm = document.getElementById('google-phone-form');
  const googleError = document.getElementById('google-error');
  let googleCredential = null;

  async function postGoogle(extra = {}) {
    const res = await fetch('/api/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: googleCredential, ...extra }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Google sign-in failed');
    return data;
  }

  function goHome(user) {
    location.href = user.role === 'admin' ? '/admin' : '/driver';
  }

  async function onGoogleCredential(response) {
    googleCredential = response.credential;
    error.textContent = '';
    try {
      const data = await postGoogle();
      if (data.user) return goHome(data.user);
      // New Google user: collect their phone number once.
      form.hidden = true;
      googleArea.hidden = true;
      document.querySelector('.tabs').hidden = true;
      hint.hidden = true;
      phoneForm.hidden = false;
      phoneForm.name.value = data.name || '';
      phoneForm.phone.focus();
    } catch (err) {
      error.textContent = err.message;
    }
  }

  phoneForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    googleError.textContent = '';
    const btn = document.getElementById('google-submit');
    btn.disabled = true;
    try {
      const data = await postGoogle({ name: phoneForm.name.value, phone: phoneForm.phone.value });
      goHome(data.user);
    } catch (err) {
      googleError.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  function initGoogle(clientId) {
    if (!window.google || !google.accounts) return setTimeout(() => initGoogle(clientId), 200);
    google.accounts.id.initialize({ client_id: clientId, callback: onGoogleCredential });
    google.accounts.id.renderButton(document.getElementById('google-btn'), {
      theme: 'filled_black', size: 'large', shape: 'pill', text: 'continue_with', width: 300,
    });
    googleArea.hidden = false;
  }

  fetch('/api/config').then((r) => r.json()).then((c) => {
    if (c.googleClientId) initGoogle(c.googleClientId);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    submit.disabled = true;
    try {
      const body = { phone: form.phone.value, password: form.password.value };
      if (mode === 'register') body.name = form.name.value;
      const res = await fetch(`/api/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong');
      location.href = data.user.role === 'admin' ? '/admin' : '/driver';
    } catch (err) {
      error.textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  });
})();
