# Ibraya Logistics Tracking

Live location tracking for Ibraya Logistics import/export truck drivers. Drivers sign in on their phones and their location streams to a live map that only the admin can see.

## How it works

- **Sign in** with a **phone number + password** (free, no SMS), an **email + password**, or **Google**. Google and email users add their phone number once, the first time they sign in. Each phone number can only be used once.
- **The first person to sign up becomes the admin.** Everyone after that starts as a *Driver*.
- **Drivers see only their role** (and their name) plus a small "location sharing is on" indicator. Their phone sends its GPS position while the page is open (at most every 5 seconds, plus a check-in every 30 seconds while parked).
- **The admin sees a live map** with every driver's truck. Trucks that reported in the last 2 minutes pulse green; older ones turn grey. Click a truck or a name to see speed, accuracy, last update and a Google Maps link.
- **The admin manages users**: change roles (Driver, Import Driver, Export Driver, Admin), set a new password for a driver who forgot theirs (🔑), or remove a user (✕). There is only ever one admin; making someone else admin hands the role over.
- **Trip history** (admin only, behind the *History* button on a driver or in a truck's popup): pick a day and see the exact route on the map, with every drive, stop and **no-signal gap** listed with exact times, how far the truck moved during each gap, and why (location turned off, phone switched off, signed out). Click the route for the exact time at that spot. Routes are kept for 30 days.
- **Alerts** (the bell): a list with a sound when a driver turns off location, switches the phone off (with the battery % it had, so it isn't mistaken for a dead battery), the battery dies, signs out of the app, has no signal for 30+ minutes, or stands still for 1+ hour. *Last 24 hours* lists the problems that already ended. Thresholds are at the top of the alerts section in `public/js/admin.js`.
- **Bright theme by default**, with a dark-mode switch in the bottom-right corner.

## Architecture

| Part | What it does |
|------|--------------|
| `server.js` (Railway) | Serves the web pages. Nothing else; it holds no data. |
| Supabase Auth | Accounts and sign-in (phone, email, Google). |
| Supabase database (`profiles` table) | Names, phones, roles, last known location. Row-level security: drivers can only read their own row, only the admin can read everyone, and all changes go through checked database functions. |
| Supabase Realtime | Pushes location and role changes to the admin map and driver pages instantly. |
| `location_history`, `tracking_incidents` tables | The saved route points (a point every 20 s / 50 m while driving, every 2 min while parked) and the alert log. Admin-only. A nightly `pg_cron` job (`forget_old_history`) removes anything older than 30 days to stay within the free database size. |
| Edge Function `account` | Phone sign-up (creates the account without SMS), and the admin's remove / reset-password actions. |

Phone accounts sign in to Supabase with a hidden placeholder email `<digits>@phone.ibraya.local`. Pakistani numbers are normalised, so `0300 1234567`, `3001234567` and `+92 300 1234567` are the same account.

The Supabase project is **Ibraya Logistics Tracking** (`qodvhcvqhwvllfmhfndo`, Mumbai region). Its URL and publishable key are in `public/js/config.js`; the publishable key is meant to be public. Database changes are in `supabase/migrations/`, the Edge Function in `supabase/functions/account/`.

## Run it

```bash
npm install
npm start
# open http://localhost:3000
```

No environment variables are needed (`PORT` is optional).

## One-time setup in Supabase

Open the project at [supabase.com/dashboard](https://supabase.com/dashboard/project/qodvhcvqhwvllfmhfndo).

1. **Your site address** — *Authentication → URL Configuration*:
   - **Site URL**: your Railway address, e.g. `https://your-app.up.railway.app`
   - **Redirect URLs**: add `https://your-app.up.railway.app/login`

   Email confirmation and password-reset links use this, and so does Google sign-in.
2. **Google sign-in** (optional):
   1. In [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials), create an **OAuth client ID** of type **Web application** (set up the consent screen first if asked).
   2. **Authorized JavaScript origins**: your Railway address.
   3. **Authorized redirect URIs**: `https://qodvhcvqhwvllfmhfndo.supabase.co/auth/v1/callback`
   4. Copy the **Client ID** and **Client secret** into Supabase: *Authentication → Sign In / Providers → Google*, switch it on and save.

   The "Continue with Google" button appears on the sign-in page by itself once Google is switched on.
3. **Email sign-up** works out of the box, but Supabase's built-in email sender only sends a few emails per hour. Before many people sign up by email, add your own email sender under *Authentication → Emails → SMTP Settings* (for example a free Brevo or Resend account).

Phone + password sign-up needs no setup.

## Deploying

- **HTTPS is required.** Phones only share GPS with `https://` sites. Railway's addresses are HTTPS already.
- No storage volume is needed any more; all data lives in Supabase.
- **Sign up as admin first** right after you deploy, since the first account to register becomes the admin.

## Android app (24/7 tracking)

Websites can't use GPS with the screen off or the browser closed, so drivers use the **Ibraya Tracking** Android app (`mobile/`):

- It opens the live website (same sign-in and screens), so website changes reach the app without a new install.
- A native foreground service (`TrackerService.java`) keeps sending GPS with the screen off and the app closed, and `BootReceiver` restarts it after the phone reboots. It sends every 10 s while moving and every 30 s while parked, and shows a small "Ibraya Tracking is on" notification (Android requires it).
- The service uses a per-phone **device token** (`tracker_devices` table, `track_with_device_token` function), not the login session. Signing out in the app, signing in on another phone, or removing the driver cancels it.
- Inside the app the driver page shows a one-time setup checklist in English and Urdu: location, "Allow all the time", notifications, battery saver, GPS.
- Google sign-in is hidden inside the app (Google blocks it in apps). Drivers who signed up with Google use "Forgot password?" to set a password.

**Installing:** drivers open `https://<your-site>/download` on their Android phone and tap **Download app**, then **Open** and **Install**. The first time, Android asks to "Allow from this source". Android never lets a downloaded file install itself; for a one-tap install, publish the app on Google Play.

**Building:** `.github/workflows/android.yml` builds the APK on GitHub whenever `mobile/` changes. On `main` it also publishes it as the latest GitHub release, which `/download` serves, but only when the **`IBRAYA_KEYSTORE`** repository secret is set (*Settings → Secrets and variables → Actions*). That secret is the base64 of the release signing key. **Keep a backup of the key file**: if it's lost, drivers must uninstall and reinstall to get updates.

A phone that is switched off, or has no battery, can't be tracked; it shows as Offline until it's back on.

iPhone isn't supported by the app (it would need an Apple developer account, $99/year).

Free Supabase projects pause after about a week with no activity; daily use keeps it running.
