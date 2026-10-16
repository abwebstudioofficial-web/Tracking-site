-- Phone numbers are stored as "+<digits>". Pakistani local formats are converted:
-- 03001234567 / 3001234567 / +92 300 1234567  ->  +923001234567
create or replace function public.normalize_phone(p text)
returns text language plpgsql immutable set search_path = '' as $$
declare d text := regexp_replace(coalesce(p, ''), '\D', '', 'g');
begin
  if d like '0%' and length(d) = 11 then d := '92' || substr(d, 2); end if;
  if d like '3%' and length(d) = 10 then d := '92' || d; end if;
  if length(d) < 9 or length(d) > 15 then return null; end if;
  return '+' || d;
end $$;

create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  name        text not null default '',
  phone       text unique,
  email       text,
  role        text not null default 'driver'
              check (role in ('admin', 'driver', 'import_driver', 'export_driver')),
  lat         double precision,
  lng         double precision,
  accuracy    double precision,
  speed       double precision,
  heading     double precision,
  location_at timestamptz,
  created_at  timestamptz not null default now()
);

-- There can never be more than one admin.
create unique index profiles_one_admin on public.profiles (role) where role = 'admin';

alter table public.profiles enable row level security;
revoke all on table public.profiles from anon;
revoke insert, update, delete on table public.profiles from authenticated;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'admin');
$$;

create policy "Users read their own profile" on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy "Admin reads every profile" on public.profiles
  for select to authenticated using ((select public.is_admin()));
-- No insert/update/delete policies: all writes go through the functions below.

-- Every new sign-up gets a profile. The very first one becomes the admin.
-- Phone accounts sign in with a placeholder email "<digits>@phone.ibraya.local",
-- so their phone number is taken from that email (never from user-editable metadata).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  is_phone_account boolean := new.email like '%@phone.ibraya.local';
  new_role text;
begin
  perform pg_advisory_xact_lock(hashtext('ibraya_first_admin'));
  new_role := case when exists (select 1 from public.profiles) then 'driver' else 'admin' end;
  insert into public.profiles (id, name, phone, email, role)
  values (
    new.id,
    left(coalesce(nullif(trim(new.raw_user_meta_data->>'name'), ''),
                  nullif(trim(new.raw_user_meta_data->>'full_name'), ''),
                  split_part(coalesce(new.email, ''), '@', 1)), 80),
    case when is_phone_account then '+' || split_part(new.email, '@', 1) end,
    case when is_phone_account then null else new.email end,
    new_role
  );
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Google/email users add their phone number once, the first time they sign in.
create or replace function public.complete_my_profile(p_name text, p_phone text)
returns public.profiles language plpgsql security definer set search_path = '' as $$
declare
  clean_phone text := public.normalize_phone(p_phone);
  me public.profiles;
begin
  if clean_phone is null then raise exception 'Please enter a valid phone number'; end if;
  if exists (select 1 from public.profiles where phone = clean_phone and id <> (select auth.uid())) then
    raise exception 'This phone number is already registered to another account';
  end if;
  update public.profiles
     set phone = clean_phone,
         name = coalesce(nullif(left(trim(p_name), 80), ''), name)
   where id = (select auth.uid()) and phone is null
  returning * into me;
  if me.id is null then raise exception 'Your phone number is already set'; end if;
  return me;
end $$;

-- Drivers report their own position. The admin is not tracked.
create or replace function public.update_my_location(
  p_lat double precision, p_lng double precision,
  p_accuracy double precision default null, p_speed double precision default null,
  p_heading double precision default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_lat is null or p_lng is null or abs(p_lat) > 90 or abs(p_lng) > 180 then
    raise exception 'Invalid location';
  end if;
  update public.profiles
     set lat = p_lat, lng = p_lng, accuracy = p_accuracy, speed = p_speed,
         heading = p_heading, location_at = now()
   where id = (select auth.uid()) and role <> 'admin';
end $$;

-- Admin changes a user's role. Giving someone "admin" hands the role over:
-- the current admin becomes a driver in the same transaction.
create or replace function public.admin_set_role(p_user uuid, p_role text)
returns public.profiles language plpgsql security definer set search_path = '' as $$
declare target public.profiles;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if p_role not in ('admin', 'driver', 'import_driver', 'export_driver') then
    raise exception 'Unknown role';
  end if;
  if p_user = (select auth.uid()) then
    raise exception 'To give up admin, make another user the admin';
  end if;
  if not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'User not found';
  end if;
  if p_role = 'admin' then
    update public.profiles set role = 'driver' where id = (select auth.uid());
  end if;
  update public.profiles set role = p_role where id = p_user returning * into target;
  return target;
end $$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.complete_my_profile(text, text) from public, anon;
revoke execute on function public.update_my_location(double precision, double precision, double precision, double precision, double precision) from public, anon;
revoke execute on function public.admin_set_role(uuid, text) from public, anon;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.complete_my_profile(text, text) to authenticated;
grant execute on function public.update_my_location(double precision, double precision, double precision, double precision, double precision) to authenticated;
grant execute on function public.admin_set_role(uuid, text) to authenticated;

-- Live map: the admin receives profile changes over Realtime (filtered by the policies above).
alter publication supabase_realtime add table public.profiles;
