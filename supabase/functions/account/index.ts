// Account actions that need Supabase admin rights:
//  - phone-login:     drivers sign in with just their phone number (no password, no SMS).
//                     New numbers are asked for a name and get an account. Admin and business
//                     accounts are refused here and must use their password.
//  - phone-signup:    create a business account: phone + password (free, no SMS)
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

// The main admin can't be removed or have their password changed by other admins.
async function isOwner(userId: string): Promise<boolean> {
  const { data } = await admin.from('profiles').select('is_owner').eq('id', userId).maybeSingle();
  return !!data?.is_owner;
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
    case 'phone-login': {
      const phone = normalizePhone(body.phone);
      if (!phone) return json({ error: 'Please enter a valid phone number' }, 400);

      const { data: profile } = await admin.from('profiles').select('id, role').eq('phone', phone).maybeSingle();
      let email: string;
      if (profile) {
        if (profile.role === 'admin') {
          return json({ error: 'This is the admin account. Sign in with your password.', needsPassword: true }, 403);
        }
        if (profile.role === 'business') {
          return json({ error: 'This is a business account. Sign in with your password.', needsPassword: true }, 403);
        }
        const { data: found, error } = await admin.auth.admin.getUserById(profile.id);
        if (error || !found.user?.email) return json({ error: 'Could not sign in. Please try again.' }, 400);
        email = found.user.email;
      } else {
        // The very first account becomes the admin, so it must be created with a password.
        const { count } = await admin.from('profiles').select('id', { count: 'exact', head: true });
        if (!count) return json({ error: 'Create the admin account first, with a password.', needsPassword: true }, 403);
        const name = String(body.name ?? '').trim().slice(0, 80);
        if (!name) return json({ needsName: true });
        email = `${phone.slice(1)}@${PHONE_DOMAIN}`;
        const password = crypto.randomUUID() + crypto.randomUUID(); // never used: drivers sign in by phone
        const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name } });
        if (error && !/already|registered|exists/i.test(error.message)) return json({ error: error.message }, 400);
      }

      // A one-time sign-in code for that account; nothing is sent by email.
      const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
      if (linkError || !link?.properties?.hashed_token) {
        return json({ error: linkError?.message || 'Could not sign in. Please try again.' }, 400);
      }
      return json({ tokenHash: link.properties.hashed_token });
    }

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
        user_metadata: { name, account: 'business' },
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
      if (await isOwner(userId)) return json({ error: 'The main admin cannot be removed' }, 403);
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
      if (await isOwner(userId)) return json({ error: "The main admin's password can only be changed by them" }, 403);
      if (password.length < 6) return json({ error: 'Password must be at least 6 characters' }, 400);
      const { error } = await admin.auth.admin.updateUserById(userId, { password });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    default:
      return json({ error: 'Unknown action' }, 400);
  }
});
