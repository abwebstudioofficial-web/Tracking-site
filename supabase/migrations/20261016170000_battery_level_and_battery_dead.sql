-- Tell "the driver switched the phone off" apart from "the battery died".
-- The app now sends the battery level with every location and with every problem report.
-- When the phone shuts down at 0-2 % battery (not charging) the app reports battery_dead.

alter table public.profiles add column battery smallint check (battery between 0 and 100);
alter table public.tracking_incidents add column battery smallint check (battery between 0 and 100);

alter table public.profiles drop constraint profiles_tracking_problem_check;
alter table public.profiles add constraint profiles_tracking_problem_check
  check (tracking_problem in ('location_off', 'no_gps', 'phone_off', 'battery_dead', 'signed_out'));
alter table public.tracking_incidents drop constraint tracking_incidents_kind_check;
alter table public.tracking_incidents add constraint tracking_incidents_kind_check
  check (kind in ('location_off', 'no_gps', 'phone_off', 'battery_dead', 'signed_out', 'no_signal', 'long_stop'));

create or replace function public.report_problem(p_user uuid, p_problem text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_problem not in ('location_off', 'no_gps', 'phone_off', 'battery_dead', 'signed_out') then
    raise exception 'Unknown problem';
  end if;
  if not exists (select 1 from public.profiles where id = p_user and role <> 'admin') then return; end if;
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

-- New versions take the battery level (old app versions keep working without it).
drop function public.track_with_device_token(text, double precision, double precision, double precision, double precision, double precision);
drop function public.tracker_report_problem(text, text);

create function public.track_with_device_token(
  p_token text, p_lat double precision, p_lng double precision,
  p_accuracy double precision default null, p_speed double precision default null,
  p_heading double precision default null, p_battery integer default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  device_user uuid;
begin
  if p_token is null or length(p_token) <> 64 then return false; end if;
  select user_id into device_user from public.tracker_devices
   where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
  if device_user is null then return false; end if;
  perform public.record_location(device_user, p_lat, p_lng, p_accuracy, p_speed, p_heading);
  if p_battery between 0 and 100 then
    update public.profiles set battery = p_battery where id = device_user;
  end if;
  update public.tracker_devices set last_seen_at = now() where user_id = device_user;
  return true;
end $$;

create function public.tracker_report_problem(p_token text, p_problem text, p_battery integer default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  device_user uuid;
begin
  if p_token is null or length(p_token) <> 64 then return false; end if;
  if p_problem not in ('location_off', 'no_gps', 'phone_off', 'battery_dead') then raise exception 'Unknown problem'; end if;
  select user_id into device_user from public.tracker_devices
   where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
  if device_user is null then return false; end if;
  perform public.report_problem(device_user, p_problem);
  if p_battery between 0 and 100 then
    update public.profiles set battery = p_battery where id = device_user;
    update public.tracking_incidents set battery = p_battery
     where user_id = device_user and ended_at is null and kind = p_problem;
  end if;
  update public.tracker_devices set last_seen_at = now() where user_id = device_user;
  return true;
end $$;

-- History also returns the battery level of each incident.
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
      select json_agg(json_build_object('kind', kind, 'started_at', started_at, 'ended_at', ended_at,
                                        'moved_m', moved_m, 'battery', battery) order by started_at)
        from public.tracking_incidents
       where user_id = p_user and started_at < p_to and coalesce(ended_at, now()) >= p_from), '[]'::json));
end $$;

revoke execute on function public.track_with_device_token(text, double precision, double precision, double precision, double precision, double precision, integer) from public;
revoke execute on function public.tracker_report_problem(text, text, integer) from public;
-- The token itself is the credential, so the app's background service calls these with just the publishable key.
grant execute on function public.track_with_device_token(text, double precision, double precision, double precision, double precision, double precision, integer) to anon, authenticated;
grant execute on function public.tracker_report_problem(text, text, integer) to anon, authenticated;
