# Ibraya Logistics Tracking

Live location tracking for Ibraya Logistics import/export truck drivers. Drivers sign in on their phones and their location streams to a live map that only the admin can see.

## How it works

- **Sign in with a phone number** and a password, or **with Google**. Google users add their phone number once, the first time they sign in. Each phone number can register once.
- **The first person to sign up becomes the admin.** Everyone after that starts as a *Driver*.
- **Drivers see only their role** (and their name) plus a small "location sharing is on" indicator. Their phone sends its GPS position while the page is open.
- **The admin sees a live map** with every driver's truck, updating in real time, with a green pulse for trucks that are live and grey for trucks that went quiet (no update for 2 minutes). Click a truck or a name in the list to zoom to it and see speed, accuracy, last update time and a Google Maps link.
- **The admin changes roles** from the list: Driver, Import Driver, Export Driver, or Admin. There is only ever one admin (the database enforces this). Making someone else admin hands the role over and the current admin becomes a Driver.
- The admin can also remove a user.

## Run it

Requires Node.js 22.13 or newer (it uses Node's built-in SQLite).

```bash
npm install
npm start
# open http://localhost:3000
```

Settings (environment variables):

| Variable   | Default   | Purpose                                 |
|------------|-----------|-----------------------------------------|
| `PORT`     | `3000`    | Port the server listens on              |
| `DATA_DIR` | `./data`  | Where the SQLite database file is kept  |
| `GOOGLE_CLIENT_ID` | (empty) | Turns on "Continue with Google". Leave empty to hide the button |

## Setting up Google sign-in

1. Go to [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials) (create a project if asked).
2. If asked, set up the **OAuth consent screen**: choose *External*, app name *Ibraya Logistics Tracking*, add your email, and save.
3. Click **Create credentials → OAuth client ID**, choose **Web application**.
4. Under **Authorized JavaScript origins** add your site address, e.g. `https://your-app.up.railway.app` (no trailing slash). No redirect URI is needed.
5. Copy the **Client ID** (ends in `.apps.googleusercontent.com`) and set it as the `GOOGLE_CLIENT_ID` variable on your host, then redeploy.

## Deploying (important)

- **HTTPS is required.** Phones only share GPS with sites served over `https://` (localhost is the one exception). Put the app behind HTTPS on your host or a reverse proxy (Nginx/Caddy, Render, Railway, Fly.io, a VPS, etc.).
- **Keep `DATA_DIR` on persistent storage** so accounts survive restarts and redeploys.
- **Sign up as admin first** right after you deploy, since the first account to register becomes the admin.

## Limits of browser-based tracking

Phone browsers pause GPS when the screen is off or the browser is in the background. The driver page asks the phone to keep the screen awake, but for tracking that keeps going while the phone is locked you would need a native Android/iOS app. That can be added later on top of the same server.

## Project layout

```
server.js        Express API, pages, and Socket.io live updates
db.js            SQLite schema, users, sessions, roles
public/
  login.html     Sign in / create account
  driver.html    Driver view (role only + location sharing)
  admin.html     Admin live map + driver list
  js/            Browser scripts for each page
  css/style.css  Styles
```
