# Ibraya Logistics Tracking

Live location tracking for Ibraya Logistics import/export truck drivers. Drivers sign in on their phones and their location streams to a live map that only the admin can see.

## How it works

- **Sign in** with a **phone number + password** (free, no SMS), an **email + password**, or **Google**. Google and email users add their phone number once, the first time they sign in. Each phone number can only be used once.
- **The first person to sign up becomes the admin.** Everyone after that starts as a *Driver*.
- **Drivers see only their role** (and their name) plus a small "location sharing is on" indicator. Their phone sends its GPS position while the page is open (at most every 5 seconds, plus a check-in every 30 seconds while parked).
- **The admin sees a live map** with every driver's truck. Trucks that reported in the last 2 minutes pulse green; older ones turn grey. Click a truck or a name to see speed, accuracy, last update and a Google Maps link.
- **The admin manages users**: change roles (Driver, Import Driver, Export Driver, Admin), set a new password for a driver who forgot theirs (🔑), or remove a user (✕). There is only ever one admin; making someone else admin hands the role over.
- **Bright theme by default**, with a dark-mode switch in the bottom-right corner.

## Architecture

| Part | What it does |
|------|--------------|
| `server.js` (Railway) | Serves the web pages. Nothing else; it holds no data. |
| Supabase Auth | Accounts and sign-in (phone, email, Google). |
| Supabase database (`profiles` table) | Names, phones, roles, last known location. Row-level security: drivers can only read their own row, only the admin can read everyone, and all changes go through checked database functions. |
| Supabase Realtime | Pushes location and role changes to the admin map and driver pages instantly. |
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

## Limits of browser-based tracking

Phone browsers pause GPS when the screen is off or the browser is in the background. The driver page asks the phone to keep the screen awake, but tracking while the phone is locked needs a native Android/iOS app. That can be added later on top of the same Supabase project.

Free Supabase projects pause after about a week with no activity; daily use keeps it running.
