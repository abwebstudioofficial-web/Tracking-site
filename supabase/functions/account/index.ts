// Account actions that need Supabase admin rights:
//  - phone-signup:    create a phone + password account (free, no SMS)
//  - delete-user:     admin removes a user
//  - reset-password:  admin sets a new password for a user (e.g. a driver who forgot theirs)
import { createClient } from 'npm:@supabase/supabase-js@2';

const PHONE_DOMAIN = 'phone.ibraya.local';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

// Same rules as public.normalize_phone() in the database.
function normalizePhone(raw: unknown): string | null {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.startsWith('0') && d.length === 11) d = '92' + d.slice(1);
  if (d.startsWith('3') && d.length === 10) d = '92' + d;
  if (d.length < 9 || d.length > 15) return null;
  return '+' + d;
}

function secretKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
    if (keys.default) return keys.default;
  } catch { /* fall back to the legacy key */ }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
}

const admin = createClient(Deno.env.get('SUPABASE_URL')!, secretKey(), {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function requireAdmin(req: Request): Promise<string | Response> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return json({ error: 'Not signed in' }, 401);
  const { data: me } = await admin.from('profiles').select('role').eq('id', data.user.id).single();
  if (me?.role !== 'admin') return json({ error: 'Admin only' }, 403);
  return data.user.id;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid request' }, 400);
  }

  switch (body.action) {
    case 'phone-signup': {
      const name = String(body.name ?? '').trim().slice(0, 80);
      const phone = normalizePhone(body.phone);
      const password = String(body.password ?? '');
      if (!name) return json({ error: 'Please enter your name' }, 400);
      if (!phone) return json({ error: 'Please enter a valid phone number' }, 400);
      if (password.length < 6) return json({ error: 'Password must be at least 6 characters' }, 400);

      const { data: taken } = await admin.from('profiles').select('id').eq('phone', phone).maybeSingle();
      if (taken) return json({ error: 'This phone number is already registered' }, 409);

      const { error } = await admin.auth.admin.createUser({
        email: `${phone.slice(1)}@${PHONE_DOMAIN}`,
        password,
        email_confirm: true,
        user_metadata: { name },
      });
      if (error) {
        const exists = /already|registered|exists/i.test(error.message);
        return json({ error: exists ? 'This phone number is already registered' : error.message }, exists ? 409 : 400);
      }
      return json({ ok: true, phone });
    }

    case 'delete-user': {
      const me = await requireAdmin(req);
      if (me instanceof Response) return me;
      const userId = String(body.userId ?? '');
      if (userId === me) return json({ error: 'You cannot delete your own admin account' }, 400);
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    case 'reset-password': {
      const me = await requireAdmin(req);
      if (me instanceof Response) return me;
      const userId = String(body.userId ?? '');
      const password = String(body.password ?? '');
      if (userId === me) return json({ error: 'Change your own password from the sign-in page' }, 400);
      if (password.length < 6) return json({ error: 'Password must be at least 6 characters' }, 400);
      const { error } = await admin.auth.admin.updateUserById(userId, { password });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    default:
      return json({ error: 'Unknown action' }, 400);
  }
});
