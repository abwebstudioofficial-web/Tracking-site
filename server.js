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
app.get('/download', page('download.html'));
app.get('/privacy', page('privacy.html'));

// The Android app is built by GitHub (.github/workflows/android.yml) and published as the latest
// release. Serve it from this site with the Android file type, so phones offer to install it.
const APK_SOURCE = 'https://github.com/abwebstudioofficial-web/Tracking-site/releases/latest/download/ibraya-tracking.apk';
const APK_CACHE_MS = 10 * 60 * 1000;
let apkCache = { at: 0, data: null };

async function latestApk() {
  if (apkCache.data && Date.now() - apkCache.at < APK_CACHE_MS) return apkCache.data;
  const r = await fetch(APK_SOURCE, { redirect: 'follow' });
  if (!r.ok) {
    if (apkCache.data) return apkCache.data; // GitHub hiccup: keep serving the last good copy
    return null;
  }
  apkCache = { at: Date.now(), data: Buffer.from(await r.arrayBuffer()) };
  return apkCache.data;
}

app.get('/download/ibraya-tracking.apk', async (req, res) => {
  try {
    const apk = await latestApk();
    if (!apk) return res.status(404).send('The app has not been published yet.');
    res.set({
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Disposition': 'attachment; filename="Ibraya-Tracking.apk"',
      'Content-Length': apk.length,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    res.end(apk);
  } catch (err) {
    console.error('APK download failed:', err.message);
    res.status(502).send('Could not get the app right now. Please try again.');
  }
});

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
