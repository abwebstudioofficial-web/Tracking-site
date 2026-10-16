-- Trip history (admin only) and tracking alerts.
--
-- location_history: the route each truck drove, thinned out to keep the free database small
--   (a point every 20 s or 50 m while driving, every 2 min while parked). Kept for 30 days.
-- tracking_incidents: things the admin should know about, with exact times:
--   location_off  driver turned off location on the phone (reported by the app)
--   no_gps        the phone can't get a position (reported by the app after 3 min)
--   phone_off     driver switched the phone off (reported by the app while shutting down)
--   signed_out    driver signed out of the app
--   no_signal     nothing arrived for 30+ min (found when the phone reports again)
--   long_stop     truck stood still for 60+ min (found when it drives off again)
--   moved_m is how far the truck was from where it was last seen when the problem ended.

alter table public.profiles
  add column tracking_problem text
    check (tracking_problem in ('location_off', 'no_gps', 'phone_off', 'signed_out')),
  add column problem_at timestamptz,
  add column stopped_since timestamptz;

create table public.location_history (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  recorded_at timestamptz not null default now(),
  lat         real not null,
  lng         real not null,
  speed       real,
  primary key (user_id, recorded_at)
);
alter table public.location_history enable row level security;
revoke all on table public.location_history from anon, authenticated;
grant select on table public.location_history to authenticated;
create policy "Admin reads history" on public.location_history
  for select to authenticated using ((select public.is_admin()));

create table public.tracking_incidents (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  kind       text not null
             check (kind in ('location_off', 'no_gps', 'phone_off', 'signed_out', 'no_signal', 'long_stop')),
  started_at timestamptz not null,
  ended_at   timestamptz,
  moved_m    double precision
);
create index tracking_incidents_user_time on public.tracking_incidents (user_id, started_at);
create index tracking_incidents_time on public.tracking_incidents (started_at);
alter table public.tracking_incidents enable row level security;
revoke all on table public.tracking_incidents from anon, authenticated;
grant select on table public.tracking_incidents to authenticated;
create policy "Admin reads incidents" on public.tracking_incidents
  for select to authenticated using ((select public.is_admin()));
alter publication supabase_realtime add table public.tracking_incidents;

-- Distance in metres between two points (haversine).
create or replace function public.distance_m(lat1 double precision, lng1 double precision,
                                             lat2 double precision, lng2 double precision)
returns double precision language sql immutable set search_path = '' as $$
  select 2 * 6371000 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)));
$$;

-- Shared by the website (update_my_location) and the app (track_with_device_token).
create or replace function public.record_location(
  p_user uuid, p_lat double precision, p_lng double precision,
  p_accuracy double precision, p_speed double precision, p_heading double precision)
returns void language plpgsql security definer set search_path = '' as $$
declare
  prof public.profiles;
  moving boolean := coalesce(p_speed, 0) >= 1.4; -- ~5 km/h, same as "Active" on the map
  moved double precision;
  last_point public.location_history;
begin
  if p_lat is null or p_lng is null or abs(p_lat) > 90 or abs(p_lng) > 180 then
    raise exception 'Invalid location';
  end if;
  select * into prof from public.profiles where id = p_user for update;
  if prof.id is null or prof.role = 'admin' then return; end if;

  moved := case when prof.lat is null then null else public.distance_m(prof.lat, prof.lng, p_lat, p_lng) end;

  -- A problem (location off, phone off, ...) is over: close it and note how far the truck moved.
  update public.tracking_incidents
     set ended_at = now(), moved_m = moved
   where user_id = p_user and ended_at is null;
  -- Silent for 30+ minutes without the app saying why.
  if not found and prof.location_at < now() - interval '30 minutes' then
    insert into public.tracking_incidents (user_id, kind, started_at, ended_at, moved_m)
    values (p_user, 'no_signal', prof.location_at, now(), moved);
  end if;

  -- Stood still for an hour or more and now drives off (not: moved a long way during a signal gap).
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

-- Opens a problem incident (if one of that kind isn't already open) and shows it on the profile.
create or replace function public.report_problem(p_user uuid, p_problem text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_problem not in ('location_off', 'no_gps', 'phone_off', 'signed_out') then
    raise exception 'Unknown problem';
  end if;
  if not exists (select 1 from public.profiles where id = p_user and role <> 'admin') then return; end if;
  update public.profiles
     set tracking_problem = p_problem, problem_at = coalesce(case when tracking_problem = p_problem then problem_at end, now())
   where id = p_user;
  -- One open incident at a time: a new kind replaces the old one from now on.
  update public.tracking_incidents set ended_at = now()
   where user_id = p_user and ended_at is null and kind <> p_problem;
  if not exists (select 1 from public.tracking_incidents
                  where user_id = p_user and ended_at is null and kind = p_problem) then
    insert into public.tracking_incidents (user_id, kind, started_at) values (p_user, p_problem, now());
  end if;
end $$;

create or replace function public.update_my_location(
  p_lat double precision, p_lng double precision,
  p_accuracy double precision default null, p_speed double precision default null,
  p_heading double precision default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.profiles where id = (select auth.uid())) then
    raise exception 'Account removed';
  end if;
  perform public.record_location((select auth.uid()), p_lat, p_lng, p_accuracy, p_speed, p_heading);
end $$;

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
  perform public.record_location(device_user, p_lat, p_lng, p_accuracy, p_speed, p_heading);
  update public.tracker_devices set last_seen_at = now() where user_id = device_user;
  return true;
end $$;

-- The app reports why it can't send a location. Returns false if the token is no longer valid.
create or replace function public.tracker_report_problem(p_token text, p_problem text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  device_user uuid;
begin
  if p_token is null or length(p_token) <> 64 then return false; end if;
  if p_problem not in ('location_off', 'no_gps', 'phone_off') then raise exception 'Unknown problem'; end if;
  select user_id into device_user from public.tracker_devices
   where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
  if device_user is null then return false; end if;
  perform public.report_problem(device_user, p_problem);
  update public.tracker_devices set last_seen_at = now() where user_id = device_user;
  return true;
end $$;

-- Signing out in the app stops tracking on that phone, and the admin is told.
create or replace function public.unregister_my_tracker_devices()
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.tracker_devices set token_hash = null
   where user_id = (select auth.uid()) and token_hash is not null;
  if found then perform public.report_problem((select auth.uid()), 'signed_out'); end if;
end $$;

-- Admin: one driver's route and incidents between two times.
-- Points come back as [epoch seconds, lat, lng, speed m/s] to keep the answer small.
create or replace function public.get_driver_history(p_user uuid, p_from timestamptz, p_to timestamptz)
returns json language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if p_to - p_from > interval '8 days' then raise exception 'Choose a shorter time range'; end if;
  return json_build_object(
    'points', coalesce((
      select json_agg(json_build_array(round(extract(epoch from recorded_at)), lat, lng, speed) order by recorded_at)
        from public.location_history
       where user_id = p_user and recorded_at >= p_from and recorded_at < p_to), '[]'::json),
    'incidents', coalesce((
      select json_agg(json_build_object('kind', kind, 'started_at', started_at, 'ended_at', ended_at, 'moved_m', moved_m)
                      order by started_at)
        from public.tracking_incidents
       where user_id = p_user and started_at < p_to and coalesce(ended_at, now()) >= p_from), '[]'::json));
end $$;

revoke execute on function public.distance_m(double precision, double precision, double precision, double precision) from public, anon;
revoke execute on function public.record_location(uuid, double precision, double precision, double precision, double precision, double precision) from public, anon, authenticated;
revoke execute on function public.report_problem(uuid, text) from public, anon, authenticated;
revoke execute on function public.tracker_report_problem(text, text) from public;
revoke execute on function public.get_driver_history(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.distance_m(double precision, double precision, double precision, double precision) to authenticated;
grant execute on function public.tracker_report_problem(text, text) to anon, authenticated;
grant execute on function public.get_driver_history(uuid, timestamptz, timestamptz) to authenticated;
