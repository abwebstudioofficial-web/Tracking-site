// JazzCash in-app payments for the Transport Hub wallet (like Foodpanda's JazzCash checkout).
// The company enters its JazzCash number and the last 6 digits of the CNIC; JazzCash shows a
// prompt on that phone; once approved with the MPIN the money is added to the wallet.
//
// Uses JazzCash's Mobile Wallet API (Online Payment Gateway). Edge Function secrets:
//   JAZZCASH_MERCHANT_ID, JAZZCASH_PASSWORD, JAZZCASH_INTEGRITY_SALT
//   JAZZCASH_ENV  'sandbox' (default, test money) or 'live'
// Without them, { action: 'status' } answers ready: false and the site shows only the
// "send to our Till ID" way of adding money.
//
// Body: { action: 'status' }  or  { action: 'pay', amount, mobile, cnic }  (signed-in user)
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

function secretKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
    if (keys.default) return keys.default;
  } catch { /* fall back to the legacy key */ }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
}
const db = createClient(Deno.env.get('SUPABASE_URL')!, secretKey(), { auth: { persistSession: false, autoRefreshToken: false } });

const MERCHANT = Deno.env.get('JAZZCASH_MERCHANT_ID') ?? '';
const PASSWORD = Deno.env.get('JAZZCASH_PASSWORD') ?? '';
const SALT = Deno.env.get('JAZZCASH_INTEGRITY_SALT') ?? '';
const LIVE = (Deno.env.get('JAZZCASH_ENV') ?? 'sandbox') === 'live';
const API = `https://${LIVE ? 'payments' : 'sandbox'}.jazzcash.com.pk/ApplicationAPI/API/2.0/Purchase/DoMWalletTransaction`;
const ready = () => !!(MERCHANT && PASSWORD && SALT);

// yyyyMMddHHmmss in Pakistan time.
function pkTime(d: Date): string {
  const t = new Date(d.getTime() + 5 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}${p(t.getUTCHours())}${p(t.getUTCMinutes())}${p(t.getUTCSeconds())}`;
}

// JazzCash's secure hash: HMAC-SHA256 (key = integrity salt) of the salt and every non-empty
// pp_ / ppmpf_ value, in key order, joined with '&'; upper-case hex.
async function secureHash(fields: Record<string, string>): Promise<string> {
  const values = Object.keys(fields).filter((k) => k.startsWith('pp') && k !== 'pp_SecureHash' && fields[k] !== '')
    .sort().map((k) => fields[k]);
  const message = [SALT, ...values].join('&');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SALT), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// Messages people understand for JazzCash's usual answers.
const FRIENDLY: Record<string, string> = {
  '124': 'The payment is waiting for approval on your phone. If you approved it, wait a minute and check your wallet.',
  '157': 'The payment was not approved on the phone (or it took too long). Please try again.',
  '121': 'The payment was not completed. Please try again.',
  '199': 'JazzCash could not take the payment. Check the number and that the account has enough money.',
  '110': 'Check the JazzCash number and the last 6 digits of the CNIC.',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  if (body.action === 'status') return json({ ready: ready(), live: LIVE });
  if (body.action !== 'pay') return json({ error: 'Unknown action' }, 400);
  if (!ready()) return json({ error: 'JazzCash in-app payment is not set up yet. Use the Till ID way for now.' }, 503);

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: who, error: authError } = await db.auth.getUser(token);
  if (authError || !who.user) return json({ error: 'Please sign in again' }, 401);

  const amount = Math.round(Number(body.amount));
  let mobile = String(body.mobile ?? '').replace(/\D/g, '');
  if (mobile.startsWith('92') && mobile.length === 12) mobile = '0' + mobile.slice(2);
  if (mobile.startsWith('3') && mobile.length === 10) mobile = '0' + mobile;
  const cnic = String(body.cnic ?? '').replace(/\D/g, '');
  if (!(amount >= 100 && amount <= 1000000)) return json({ error: 'Enter an amount from Rs 100' }, 400);
  if (!/^03\d{9}$/.test(mobile)) return json({ error: 'Enter your JazzCash number, e.g. 0300 1234567' }, 400);
  if (!/^\d{6}$/.test(cnic)) return json({ error: 'Enter the last 6 digits of the CNIC of that JazzCash account' }, 400);

  const now = new Date();
  const ref = `TH${pkTime(now)}${Math.floor(Math.random() * 900 + 100)}`; // ≤ 20 characters
  const start = await db.rpc('wallet_online_start', { p_user: who.user.id, p_amount: amount, p_ref: ref });
  if (start.error) return json({ error: start.error.message }, 400);
  const entry = start.data as string;

  const fields: Record<string, string> = {
    pp_Language: 'EN',
    pp_MerchantID: MERCHANT,
    pp_SubMerchantID: '',
    pp_Password: PASSWORD,
    pp_TxnRefNo: ref,
    pp_MobileNumber: mobile,
    pp_CNIC: cnic,
    pp_Amount: String(amount * 100), // paisa
    pp_TxnCurrency: 'PKR',
    pp_TxnDateTime: pkTime(now),
    pp_BillReference: 'wallet',
    pp_Description: 'Transport Hub wallet top-up',
    pp_TxnExpiryDateTime: pkTime(new Date(now.getTime() + 24 * 3600 * 1000)),
    ppmpf_1: '', ppmpf_2: '', ppmpf_3: '', ppmpf_4: '', ppmpf_5: '',
  };
  fields.pp_SecureHash = await secureHash(fields);

  let answer: Record<string, string> = {};
  try {
    const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields) });
    answer = await res.json();
  } catch (err) {
    await db.rpc('wallet_online_finish', { p_entry: entry, p_ok: false, p_rrn: '', p_message: 'could not reach JazzCash' });
    console.error('JazzCash request failed:', err);
    return json({ error: 'Could not reach JazzCash. Please try again in a moment.' }, 502);
  }

  const code = String(answer.pp_ResponseCode ?? '');
  const ok = code === '000';
  const message = String(answer.pp_ResponseMessage ?? '');
  if (code === '124') {
    // Still waiting on the phone: leave it pending for an admin to check, like a Till ID payment.
    return json({ ok: false, pending: true, error: FRIENDLY[code] });
  }
  const done = await db.rpc('wallet_online_finish', { p_entry: entry, p_ok: ok, p_rrn: String(answer.pp_RetreivalReferenceNo ?? ''), p_message: message });
  if (done.error) return json({ error: done.error.message }, 500);
  if (ok) return json({ ok: true, ...(done.data as Record<string, unknown>) });
  return json({ ok: false, error: FRIENDLY[code] || `JazzCash: ${message || 'the payment did not go through'}` }, 402);
});
