// Install and setup instructions that differ between Android phone brands.
// Used by the download page (install steps) and the driver page in the app (setup steps).
// Menu names differ slightly between models and Android versions; these are the usual ones.
window.IbrayaBrands = (() => {
  const BRANDS = {
    samsung: { name: 'Samsung' },
    xiaomi: { name: 'Xiaomi / Redmi / POCO' },
    oppo: { name: 'Oppo / Realme / OnePlus' },
    vivo: { name: 'Vivo / iQOO' },
    infinix: { name: 'Infinix / Tecno / itel' },
    other: { name: 'Other phone' },
  };

  // Brand from a manufacturer or model name ("Xiaomi", "Redmi Note 10", "SM-A325F", "CPH2219", ...).
  function detect(text) {
    const t = String(text || '').toLowerCase();
    if (!t) return null;
    if (/samsung|\bsm-[a-z]\d/.test(t)) return 'samsung';
    if (/xiaomi|redmi|poco|\bmi \d|^m\d{4}|^\d{4,5}[a-z0-9]{2,5}[a-z]$/.test(t)) return 'xiaomi';
    if (/oppo|realme|oneplus|\bcph\d|\brmx\d/.test(t)) return 'oppo';
    if (/vivo|iqoo|^v\d{4}/.test(t)) return 'vivo';
    if (/infinix|tecno|itel|transsion|^x\d{3,4}\b/.test(t)) return 'infinix';
    return 'other';
  }

  // Download page: the brand of the phone this page is open on (Chrome tells the model).
  async function detectThisPhone() {
    try {
      if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
        const { model } = await navigator.userAgentData.getHighEntropyValues(['model']);
        if (model) return detect(model);
      }
    } catch { /* not available */ }
    const m = navigator.userAgent.match(/Android [\d.]+; ([^;)]+)/);
    return m && m[1] !== 'K' ? detect(m[1]) : null;
  }

  // ---------- install steps (download page) ----------
  // Each step: English + Urdu, with an optional brand-specific note.
  const files = {
    samsung: ['Open "My Files" → Downloads → tap Ibraya-Tracking.apk.', '"My Files" کھولیں → Downloads → Ibraya-Tracking.apk دبائیں۔'],
    xiaomi: ['On Xiaomi "Open" often does nothing: open the "File Manager" app → Downloads → tap Ibraya-Tracking.apk.', 'شیاؤمی پر "Open" اکثر کام نہیں کرتا: "File Manager" کھولیں → Downloads → Ibraya-Tracking.apk دبائیں۔'],
    oppo: ['Open the "File Manager" (or "Files") app → Downloads → tap Ibraya-Tracking.apk.', '"File Manager" کھولیں → Downloads → Ibraya-Tracking.apk دبائیں۔'],
    vivo: ['Open the "File Manager" app → Downloads → tap Ibraya-Tracking.apk.', '"File Manager" کھولیں → Downloads → Ibraya-Tracking.apk دبائیں۔'],
    infinix: ['Open the "Files" (or "File Manager") app → Downloads → tap Ibraya-Tracking.apk.', '"Files" کھولیں → Downloads → Ibraya-Tracking.apk دبائیں۔'],
    other: ['Open the "Files" app → Downloads → tap Ibraya-Tracking.apk.', '"Files" کھولیں → Downloads → Ibraya-Tracking.apk دبائیں۔'],
  };
  const unknownSources = {
    oppo: ['Some Oppo / Realme phones then ask for your screen lock or account password: enter it.', 'کچھ اوپو / ریئل می فون اسکرین لاک یا اکاؤنٹ پاس ورڈ مانگتے ہیں: وہ لکھ دیں۔'],
    vivo: ['On Vivo it may be called "Install unknown apps": turn it on for this app.', 'ویوو پر اس کا نام "Install unknown apps" ہو سکتا ہے: اسے آن کریں۔'],
  };
  const installWarning = {
    samsung: ['If "Unsafe app blocked" appears: don\'t tap OK. Tap "More details" → "Install anyway".', 'اگر "Unsafe app blocked" آئے تو OK نہ دبائیں۔ "More details" → "Install anyway" دبائیں۔'],
    xiaomi: ['Xiaomi first scans the app: wait, then tap "Install anyway" (or "Continue installation"). If "Unsafe app blocked" appears: don\'t tap OK, tap the small "Install anyway".', 'شیاؤمی پہلے ایپ اسکین کرتا ہے: انتظار کریں، پھر "Install anyway" یا "Continue installation" دبائیں۔ اگر "Unsafe app blocked" آئے تو OK نہ دبائیں، چھوٹا "Install anyway" دبائیں۔'],
    oppo: ['If it says the app "hasn\'t been checked" or "Unsafe app blocked": don\'t tap OK. Tap "Install anyway".', 'اگر لکھا آئے کہ ایپ چیک نہیں ہوئی یا "Unsafe app blocked": OK نہ دبائیں، "Install anyway" دبائیں۔'],
    vivo: ['If it says the app "hasn\'t been verified" or "Unsafe app blocked": don\'t tap OK. Tap "Install anyway" (or "Continue").', 'اگر لکھا آئے کہ ایپ تصدیق شدہ نہیں یا "Unsafe app blocked": OK نہ دبائیں، "Install anyway" یا "Continue" دبائیں۔'],
    infinix: ['If "Unsafe app blocked" appears: don\'t tap OK. Tap "More details" → "Install anyway".', 'اگر "Unsafe app blocked" آئے تو OK نہ دبائیں۔ "More details" → "Install anyway" دبائیں۔'],
    other: ['If "Unsafe app blocked" appears: don\'t tap the big OK. Tap the small "Install anyway" (some phones: "More details" first).', 'اگر "Unsafe app blocked" آئے تو بڑا OK نہ دبائیں۔ چھوٹا "Install anyway" دبائیں (کچھ فون پر پہلے "More details")۔'],
  };
  function installSteps(brand) {
    const b = BRANDS[brand] ? brand : 'other';
    return [
      { en: 'Tap "Download app" above', ur: 'اوپر "ایپ ڈاؤن لوڈ کریں" دبائیں',
        note: ['If Chrome says the file "might be harmful", tap "Download anyway".', 'اگر کروم کہے کہ فائل نقصان دہ ہو سکتی ہے تو "Download anyway" دبائیں۔'] },
      { en: 'When the download finishes, tap "Open"', ur: 'ڈاؤن لوڈ مکمل ہونے پر "Open" دبائیں',
        note: [`Nothing happens? ${files[b][0]}`, `کچھ نہ ہو تو: ${files[b][1]}`] },
      { en: 'If asked, tap "Settings" → turn on "Allow from this source" → go back', ur: 'اگر پوچھا جائے تو "Settings" دبائیں، "Allow from this source" آن کریں، اور واپس آئیں',
        note: unknownSources[b] || null },
      { en: 'Tap "Install"', ur: '"Install" دبائیں', note: installWarning[b], warn: true },
      { en: 'Tap "Open", sign in with the number of the SIM in this phone, and follow the steps in the app', ur: '"Open" دبائیں، اسی فون میں لگی سم کے نمبر سے سائن ان کریں، اور ایپ کے مراحل مکمل کریں' },
    ];
  }

  // ---------- setup steps (in the app) ----------
  // Where "Allow all the time" is, if Android opens the app's settings instead of the location screen.
  const background = {
    samsung: ['Permissions → Location → "Allow all the time"', 'Permissions → Location → "Allow all the time"'],
    xiaomi: ['App permissions → Location → "Allow all the time"', 'App permissions → Location → "Allow all the time"'],
    oppo: ['Permissions → Location → "Allow all the time"', 'Permissions → Location → "Allow all the time"'],
    vivo: ['Permissions → Location → "Always allow" / "Allow all the time"', 'Permissions → Location → "Always allow"'],
    infinix: ['Permissions → Location → "Allow all the time"', 'Permissions → Location → "Allow all the time"'],
    other: ['Permissions → Location → "Allow all the time"', 'Permissions → Location → "Allow all the time"'],
  };
  // Extra battery setting some brands have on top of Android's own (which the app asks for).
  const battery = {
    samsung: ['Also: Apps → Ibraya Tracking → Battery → "Unrestricted".', 'یہ بھی: Apps → Ibraya Tracking → Battery → "Unrestricted"۔'],
    xiaomi: ['Also: App info → Battery saver → "No restrictions".', 'یہ بھی: App info → Battery saver → "No restrictions"۔'],
    oppo: ['Also: App info → Battery usage → turn on "Allow background activity".', 'یہ بھی: App info → Battery usage → "Allow background activity" آن کریں۔'],
    vivo: ['Also: Settings → Battery → Background power consumption → Ibraya Tracking → "Allow".', 'یہ بھی: Settings → Battery → Background power consumption → Ibraya Tracking → "Allow"۔'],
    infinix: ['Also: App info → Battery → "Allow background activity" (or "No restrictions").', 'یہ بھی: App info → Battery → "Allow background activity"۔'],
  };
  // Brands whose own "autostart" switch must be on, or tracking won't restart after a reboot.
  const autostart = {
    xiaomi: ['Find Ibraya Tracking and turn on "Autostart".', 'Ibraya Tracking ڈھونڈیں اور "Autostart" آن کریں۔'],
    oppo: ['Find Ibraya Tracking and turn on "Auto launch" (or "Auto startup").', 'Ibraya Tracking ڈھونڈیں اور "Auto launch" آن کریں۔'],
    vivo: ['Find Ibraya Tracking and turn on "Autostart" (or "Background startup").', 'Ibraya Tracking ڈھونڈیں اور "Autostart" آن کریں۔'],
    infinix: ['In Phone Master → "Auto-start management": turn on Ibraya Tracking.', 'Phone Master → "Auto-start management" میں Ibraya Tracking آن کریں۔'],
  };

  // Urdu text with English menu names inside: HTML-escape it and keep each English part
  // ("Allow all the time", App info → Battery saver) in one left-to-right piece.
  function urduHtml(text) {
    const esc = String(text).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    return esc.replace(/["A-Za-z][A-Za-z0-9"'().\-\/ ]*(?:\s*→\s*["A-Za-z][A-Za-z0-9"'().\-\/ ]*)*/g,
      (m) => {
        const t = m.trim();
        if (!/[A-Za-z]/.test(t)) return m;
        return m.replace(t, `<bdi dir="ltr">${t}</bdi>`);
      });
  }

  return { BRANDS, detect, urduHtml, detectThisPhone, installSteps, background, battery, autostart };
})();
