# Putting Ibraya Tracking on Google Play (private, for company drivers only)

We use Google Play **internal testing**. The app is **not public**: it can't be found by searching,
and only the Gmail accounts you add can install it. Drivers get the normal Play Store **Install**
button and automatic updates.

You do this once. It takes about an hour, plus Google's account check (usually 1–3 days).

---

## 1. Create the developer account ($25, one time)

1. Go to <https://play.google.com/console/signup> and sign in with the company Gmail you want to own the app.
2. Choose **Yourself** (a personal account is fine for internal testing).
3. Pay the **$25** fee and complete identity verification (CNIC/passport and phone number).
4. Wait for Google's email saying the account is verified.

## 2. Create the app

1. In Play Console click **Create app**.
2. App name: **Ibraya Tracking** · Default language: **English** · App or game: **App** · Free or paid: **Free**.
3. Tick the declarations and click **Create app**.

## 3. Get the app file

1. Open <https://github.com/abwebstudioofficial-web/Tracking-site/releases/latest>.
2. Download **`ibraya-tracking.aab`** (not the `.apk`).

## 4. Upload it to internal testing

1. In Play Console: **Test and release → Testing → Internal testing**.
2. **Testers** tab → **Create email list** → name it `Drivers` → add each driver's Gmail address
   (the Gmail signed in on their phone's Play Store) → **Save**. Up to 100 people.
3. **Releases** tab → **Create new release**.
4. If asked about **Play App Signing**, choose **Use Google-generated key** (recommended). Our own key
   then works as the "upload key"; keep the key files safe as before.
5. Upload **`ibraya-tracking.aab`**, release name `1.0`, release notes: `First version for Ibraya drivers.`
6. **Next → Save and publish**. Play Console will list a few setup tasks first; do section 5, then come back.

## 5. Setup tasks Play Console asks for

Find them under **Policy and programs → App content** (and **Grow users → Store presence → Main store listing**).

**Privacy policy:** `https://tracking-site.up.railway.app/privacy`

**App access:** "All or some functionality is restricted" → add instructions:
> Sign in with a phone number and password given by Ibraya Logistics. Test account: phone `<a test driver's number>`, password `<its password>`.
(Create a test driver account for Google, e.g. with your own spare number.)

**Ads:** No, the app does not contain ads.

**Content rating:** fill the questionnaire → category **Utility / Productivity** → answer **No** to everything.

**Target audience:** **18 and over** only.

**Data safety:**
- Does the app collect or share user data? **Yes, collects** · **Not shared** with third parties.
- Is data encrypted in transit? **Yes**.
- Can users request deletion? **Yes** (via the company admin).
- Data types collected:
  - **Location → Precise location** and **Approximate location**: Collected, not shared, required. Purpose: **App functionality**.
  - **Personal info → Name**, **Phone number**, **Email address**: Collected, not shared, required (email optional). Purpose: **App functionality**, **Account management**.
  - **Device or other IDs**: not collected (we only store the phone model name).

**Location permissions (background location declaration):**
- Feature that uses background location: **"Live truck tracking for Ibraya Logistics drivers"**.
- Description:
  > Ibraya Tracking is a private app for Ibraya Logistics truck drivers. It sends the truck's location to the company's live map while the driver is signed in, including when the app is closed or the screen is off, so the company can see where its import/export trucks are. The app shows a notice explaining this before asking for location, keeps a visible notification while tracking, and stops tracking when the driver signs out.
- **Video:** a short screen recording (30–60 s, upload to YouTube as *Unlisted* and paste the link) showing:
  1. Opening the app and signing in as a driver,
  2. the **Location tracking** notice and tapping **I agree**,
  3. allowing location and choosing **Allow all the time**,
  4. the "Ibraya Tracking is on" notification,
  5. the truck on the admin map.

**Foreground service permission:** type **Location** → "Keeps sending the truck's location to the company map while the driver is signed in, with an ongoing notification." Use the same video link.

**Main store listing** (needed even though the app is private):
- Short description: `Live truck tracking for Ibraya Logistics drivers.`
- Full description: `Private app for Ibraya Logistics drivers. Sign in with your phone number and the app shares your truck's location with the company map, even with the screen off. For company drivers only.`
- App icon (512×512): `public/img/icon-512.png` from the repository.
- Feature graphic (1024×500) and 2 phone screenshots: take screenshots of the app on a phone.

## 6. Publish and send drivers the link

1. Back in **Internal testing → Releases**, finish **Save and publish**. Internal testing releases are usually available within minutes to a few hours.
2. **Testers** tab → **Copy link** (looks like `https://play.google.com/apps/internaltest/...`).
3. Send that link to drivers (WhatsApp is fine). On their phone they tap it → **Accept** → **Download it on Google Play** → **Install**.
4. Tell Claude the link, so the website's `/download` page shows a big **Install from Google Play** button
   (it's the `playStoreUrl` setting in `public/js/config.js`).

## Updates

Every time the app is rebuilt on GitHub, a new `ibraya-tracking.aab` appears on the
[latest release](https://github.com/abwebstudioofficial-web/Tracking-site/releases/latest).
Upload it as a new release under **Internal testing**; drivers' phones update automatically.
Most changes don't even need this, because the app shows the live website.
