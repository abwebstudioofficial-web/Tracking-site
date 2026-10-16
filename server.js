// Serves the website. Accounts, data and live updates are handled by Supabase
// (see supabase/ for the database setup and the "account" Edge Function).
const path = require('node:path');
const express = require('express');

const PORT = process.env.PORT || 3000;
const app = express();

app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  });
  next();
});

const page = (file) => (req, res) => res.sendFile(path.join(__dirname, 'public', file));
app.get('/', (req, res) => res.redirect('/login'));
app.get('/login', page('login.html'));
app.get('/driver', page('driver.html'));
app.get('/admin', page('admin.html'));

app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.use('/vendor/leaflet', express.static(path.dirname(require.resolve('leaflet'))));
const pkgDir = (name) => path.dirname(require.resolve(`${name}/package.json`));
app.use('/vendor/maplibre', express.static(path.join(pkgDir('maplibre-gl'), 'dist')));
app.get('/vendor/maplibre-leaflet.js', (req, res) =>
  res.sendFile(path.join(pkgDir('@maplibre/maplibre-gl-leaflet'), 'leaflet-maplibre-gl.js'))
);
app.get('/vendor/rtl-text.js', (req, res) =>
  res.sendFile(path.join(pkgDir('@mapbox/mapbox-gl-rtl-text'), 'mapbox-gl-rtl-text.min.js'))
);
app.get('/vendor/supabase.js', (req, res) =>
  res.sendFile(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')), 'dist/umd/supabase.js'))
);

app.listen(PORT, () => console.log(`Ibraya Logistics Tracking running on http://localhost:${PORT}`));
