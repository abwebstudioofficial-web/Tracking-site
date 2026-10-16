// Bright theme by default; the corner button switches to dark and remembers the choice.
(() => {
  const KEY = 'ibraya-theme';
  const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const save = (t) => { try { localStorage.setItem(KEY, t); } catch { /* private mode */ } };
  const root = document.documentElement;

  const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

  function apply(theme) {
    root.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'dark' ? '#0f1418' : '#ffffff';
    const btn = document.getElementById('theme-toggle');
    if (btn) {
      // Show the icon of the theme you'd switch to.
      btn.innerHTML = theme === 'dark' ? SUN : MOON;
      btn.title = btn.ariaLabel = theme === 'dark' ? 'Switch to bright theme' : 'Switch to dark theme';
    }
    window.dispatchEvent(new CustomEvent('themechange', { detail: theme }));
  }

  apply(read() === 'dark' ? 'dark' : 'light');

  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'theme-toggle';
    btn.className = 'theme-toggle';
    btn.addEventListener('click', () => {
      const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
      save(next);
      apply(next);
    });
    document.body.appendChild(btn);
    apply(root.dataset.theme);
  });
})();
