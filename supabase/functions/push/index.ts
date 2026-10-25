// Sends Transport Hub pop-up notifications to phones with Firebase Cloud Messaging (free).
// Called only by the database (public.send_push), with the shared secret stored in
// platform_settings.push_hook_secret. Body: { company_id?, user_id?, title, body, url }
//   company_id: the company's owners and managers;  user_id: one person (e.g. a driver).
// Needs the Edge Function secret FCM_SERVICE_ACCOUNT: the Firebase service-account JSON.
import { createClient } from 'npm:@supabase/supabase-js@2';

function secretKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
    if (keys.default) return keys.default;
  } catch { /* fall back to the legacy key */ }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
}
const db = createClient(Deno.env.get('SUPABASE_URL')!, secretKey(), { auth: { persistSession: false, autoRefreshToken: false } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type ServiceAccount = { project_id: string; client_email: string; private_key: string; token_uri?: string };
let account: ServiceAccount | null = null;
let cachedToken: { value: string; until: number } | null = null;

const b64url = (data: Uint8Array | string) => {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  let s = '';
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

// A Google access token for FCM, from the service account (signed JWT, cached for ~55 min).
async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.until > Date.now()) return cachedToken.value;
  const sa = account!;
  const now = Math.floor(Date.now() / 1000);
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: tokenUri, iat: now, exp: now + 3600,
  }))}`;
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)));
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(sig)}` }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error('Google sign-in failed: ' + JSON.stringify(data).slice(0, 200));
  cachedToken = { value: data.access_token, until: Date.now() + 55 * 60 * 1000 };
  return data.access_token;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const { data: setting } = await db.from('platform_settings').select('value').eq('key', 'push_hook_secret').maybeSingle();
  const secret = setting?.value;
  if (!secret || req.headers.get('x-push-secret') !== secret) return json({ error: 'Forbidden' }, 403);

  if (!account) {
    try {
      account = JSON.parse(Deno.env.get('FCM_SERVICE_ACCOUNT') ?? '');
    } catch {
      return json({ error: 'FCM_SERVICE_ACCOUNT secret is missing or not valid JSON' }, 500);
    }
  }

  const body = await req.json().catch(() => ({}));
  const title = String(body.title ?? '').slice(0, 140);
  const text = String(body.body ?? '').slice(0, 300);
  const url = typeof body.url === 'string' && body.url.startsWith('/') ? body.url : '/hub';

  // Who gets it: one person, or the company's owners and managers.
  let users: string[] = [];
  if (body.user_id) users.push(String(body.user_id));
  if (body.company_id) {
    const { data } = await db.from('company_members').select('user_id').eq('company_id', body.company_id).in('role', ['owner', 'manager']);
    users = users.concat((data ?? []).map((m) => m.user_id));
  }
  if (!users.length || !title) return json({ sent: 0 });
  const { data: tokens } = await db.from('push_tokens').select('token').in('user_id', users);
  if (!tokens?.length) return json({ sent: 0 });

  const auth = await accessToken();
  let sent = 0;
  const gone: string[] = [];
  await Promise.all(tokens.map(async ({ token }) => {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${account!.project_id}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          token,
          notification: { title, body: text },
          data: { url },
          android: { priority: 'HIGH', notification: { channel_id: 'hub', icon: 'ic_stat_tracking', color: '#6930C3', sound: 'default' } },
        },
      }),
    });
    if (res.ok) { sent++; return; }
    const err = await res.json().catch(() => ({}));
    const code = JSON.stringify(err);
    // The app was uninstalled or the token expired: forget this phone.
    if (res.status === 404 || /UNREGISTERED|registration-token-not-registered|INVALID_ARGUMENT/.test(code)) gone.push(token);
    else console.error('FCM send failed', res.status, code.slice(0, 300));
  }));
  if (gone.length) await db.from('push_tokens').delete().in('token', gone);
  return json({ sent, removed: gone.length });
});
