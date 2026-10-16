-- Background tracking from the Ibraya Android app.
-- When a driver signs in inside the app, the app gets a long random device token.
-- Its background service sends locations with that token (no login session needed,
-- so it keeps working with the screen off, the app closed, and after a reboot).
-- Only a SHA-256 hash of the token is stored. One phone per driver.
create table public.tracker_devices (
  user_id      uuid primary key references public.profiles(id) on delete cascade,
  token_hash   text unique,          -- null = signed out on that phone
  device_name  text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz
);
alter table public.tracker_devices enable row level security;
revoke all on table public.tracker_devices from anon, authenticated;
-- No policies: only the functions below touch this table.

-- Called by a signed-in driver in the app. A new phone replaces the old one.
create or replace function public.register_tracker_device(p_device_name text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare
  token text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  if not exists (select 1 from public.profiles where id = (select auth.uid())) then
    raise exception 'Not signed in';
  end if;
  insert into public.tracker_devices (user_id, token_hash, device_name)
  values ((select auth.uid()), encode(extensions.digest(token, 'sha256'), 'hex'), left(p_device_name, 80))
  on conflict (user_id) do update
    set token_hash = excluded.token_hash, device_name = excluded.device_name,
        created_at = now(), last_seen_at = null;
  return token;
end $$;

-- Called on sign-out in the app, so the phone stops reporting.
create or replace function public.unregister_my_tracker_devices()
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.tracker_devices set token_hash = null where user_id = (select auth.uid());
end $$;

-- Called by the app's background service with its device token.
-- Returns false if the token is unknown (signed out, or driver removed): the app then stops.
create or replace function public.track_with_device_token(
  p_token text, p_lat double precision, p_lng double precision,
  p_accuracy double precision default null, p_speed double precision default null,
  p_heading double precision default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  device_user uuid;
begin
  if p_token is null or length(p_token) <> 64 then return false; end if;
  select user_id into device_user from public.tracker_devices
   where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
  if device_user is null then return false; end if;
  if p_lat is null or p_lng is null or abs(p_lat) > 90 or abs(p_lng) > 180 then
    raise exception 'Invalid location';
  end if;
  update public.profiles
     set lat = p_lat, lng = p_lng, accuracy = p_accuracy,
         speed = case when p_speed is null or p_speed < 0 then null else p_speed end,
         heading = case when p_heading is null or p_heading < 0 then null else p_heading end,
         location_at = now()
   where id = device_user and role <> 'admin';
  update public.tracker_devices set last_seen_at = now() where user_id = device_user;
  return true;
end $$;

revoke execute on function public.register_tracker_device(text) from public, anon;
revoke execute on function public.unregister_my_tracker_devices() from public, anon;
revoke execute on function public.track_with_device_token(text, double precision, double precision, double precision, double precision, double precision) from public;
grant execute on function public.register_tracker_device(text) to authenticated;
grant execute on function public.unregister_my_tracker_devices() to authenticated;
-- The token itself is the credential, so the background service can call this with just the publishable key.
grant execute on function public.track_with_device_token(text, double precision, double precision, double precision, double precision, double precision) to anon, authenticated;
