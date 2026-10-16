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
