-- One main admin (the first account) and optional tracking of the other admins.
--   is_owner: the main admin. Never tracked; other admins can't change, remove or reset them.
--   tracked:  for other admins, whether their phone's location is shared like a driver's.
--             Only the main admin can switch it. Drivers are always tracked.
alter table public.profiles
  add column is_owner boolean not null default false,
  add column tracked boolean not null default false,
  add constraint profiles_owner_not_tracked check (not (is_owner and tracked));
create unique index profiles_one_owner on public.profiles (is_owner) where is_owner;

-- The current (and first-created) admin becomes the main admin.
update public.profiles set is_owner = true
 where id = (select id from public.profiles where role = 'admin' order by created_at limit 1);

-- Whether this person's location is recorded: drivers always, admins only when switched on.
create or replace function public.is_tracked_person(p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = p_user and (role <> 'admin' or tracked));
$$;
revoke execute on function public.is_tracked_person(uuid) from public, anon, authenticated;

-- The very first sign-up becomes the main admin.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  is_phone_account boolean := new.email like '%@phone.ibraya.local';
  first_user boolean;
begin
  perform pg_advisory_xact_lock(hashtext('ibraya_first_admin'));
  first_user := not exists (select 1 from public.profiles);
  insert into public.profiles (id, name, phone, email, role, is_owner)
  values (
    new.id,
    left(coalesce(nullif(trim(new.raw_user_meta_data->>'name'), ''),
                  nullif(trim(new.raw_user_meta_data->>'full_name'), ''),
                  split_part(coalesce(new.email, ''), '@', 1)), 80),
    case when is_phone_account then '+' || split_part(new.email, '@', 1) end,
    case when is_phone_account then null else new.email end,
    case when first_user then 'admin' else 'driver' end,
    first_user
  );
  return new;
end $$;

create or replace function public.admin_set_role(p_user uuid, p_role text)
returns public.profiles language plpgsql security definer set search_path = '' as $$
declare target public.profiles;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if p_role not in ('admin', 'driver', 'import_driver', 'export_driver') then
    raise exception 'Unknown role';
  end if;
  if p_user = (select auth.uid()) then
    raise exception 'You cannot change your own role. Ask another admin.';
  end if;
  if exists (select 1 from public.profiles where id = p_user and is_owner) then
    raise exception 'The main admin cannot be changed';
  end if;
  -- Becoming a driver means being tracked again; becoming admin starts untracked.
  update public.profiles set role = p_role, tracked = false where id = p_user returning * into target;
  if target.id is null then raise exception 'User not found'; end if;
  return target;
end $$;

-- Main admin only: share another admin's location (or stop).
create or replace function public.admin_set_tracked(p_user uuid, p_tracked boolean)
returns public.profiles language plpgsql security definer set search_path = '' as $$
declare target public.profiles;
begin
  if not exists (select 1 from public.profiles where id = (select auth.uid()) and is_owner) then
    raise exception 'Only the main admin can do this';
  end if;
  update public.profiles set tracked = coalesce(p_tracked, false)
   where id = p_user and role = 'admin' and not is_owner
  returning * into target;
  if target.id is null then raise exception 'Only other admins can be tracked'; end if;
  return target;
end $$;
revoke execute on function public.admin_set_tracked(uuid, boolean) from public, anon;
grant execute on function public.admin_set_tracked(uuid, boolean) to authenticated;

create or replace function public.record_location(
  p_user uuid, p_lat double precision, p_lng double precision,
  p_accuracy double precision, p_speed double precision, p_heading double precision)
returns void language plpgsql security definer set search_path = '' as $$
declare
  prof public.profiles;
  moving boolean := coalesce(p_speed, 0) >= 1.4;
  moved double precision;
  last_point public.location_history;
begin
  if p_lat is null or p_lng is null or abs(p_lat) > 90 or abs(p_lng) > 180 then
    raise exception 'Invalid location';
  end if;
  select * into prof from public.profiles where id = p_user for update;
  if prof.id is null or (prof.role = 'admin' and not prof.tracked) then return; end if;
  moved := case when prof.lat is null then null else public.distance_m(prof.lat, prof.lng, p_lat, p_lng) end;
  update public.tracking_incidents set ended_at = now(), moved_m = moved
   where user_id = p_user and ended_at is null;
  if not found and prof.location_at < now() - interval '30 minutes' then
    insert into public.tracking_incidents (user_id, kind, started_at, ended_at, moved_m)
    values (p_user, 'no_signal', prof.location_at, now(), moved);
  end if;
  if moving and coalesce(moved, 0) <= 200 and prof.stopped_since < now() - interval '60 minutes' then
    insert into public.tracking_incidents (user_id, kind, started_at, ended_at, moved_m)
    values (p_user, 'long_stop', prof.stopped_since, now(), moved);
  end if;
  update public.profiles
     set lat = p_lat, lng = p_lng, accuracy = p_accuracy,
         speed = case when p_speed is null or p_speed < 0 then null else p_speed end,
         heading = case when p_heading is null or p_heading < 0 then null else p_heading end,
         location_at = now(),
         tracking_problem = null, problem_at = null,
         stopped_since = case
           when moving then null
           when prof.stopped_since is null or coalesce(moved, 0) > 200 then now()
           else prof.stopped_since end
   where id = p_user;
  select * into last_point from public.location_history
   where user_id = p_user order by recorded_at desc limit 1;
  if last_point.user_id is null
     or (now() - last_point.recorded_at >= interval '20 seconds'
         and (public.distance_m(last_point.lat, last_point.lng, p_lat, p_lng) >= 50
              or now() - last_point.recorded_at >= interval '2 minutes')) then
    insert into public.location_history (user_id, lat, lng, speed)
    values (p_user, p_lat, p_lng, case when p_speed < 0 then null else p_speed end)
    on conflict do nothing;
  end if;
end $$;

create or replace function public.report_problem(p_user uuid, p_problem text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_problem not in ('location_off', 'no_gps', 'phone_off', 'battery_dead', 'signed_out') then
    raise exception 'Unknown problem';
  end if;
  if not public.is_tracked_person(p_user) then return; end if;
  update public.profiles
     set tracking_problem = p_problem, problem_at = coalesce(case when tracking_problem = p_problem then problem_at end, now())
   where id = p_user;
  update public.tracking_incidents set ended_at = now()
   where user_id = p_user and ended_at is null and kind <> p_problem;
  if not exists (select 1 from public.tracking_incidents
                  where user_id = p_user and ended_at is null and kind = p_problem) then
    insert into public.tracking_incidents (user_id, kind, started_at) values (p_user, p_problem, now());
  end if;
end $$;

create or replace function public.set_my_sim_check(p_status text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('verified', 'unverified', 'mismatch') then raise exception 'Unknown SIM status'; end if;
  if not public.is_tracked_person((select auth.uid())) then return; end if;
  update public.profiles set sim_check = p_status, sim_checked_at = now()
   where id = (select auth.uid()) and sim_check is distinct from p_status;
end $$;
