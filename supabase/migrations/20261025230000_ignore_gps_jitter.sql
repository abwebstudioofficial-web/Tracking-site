-- Stop trucks "wandering" on the map while the phone lies still (e.g. at home or indoors).
-- Indoors a phone often has no real GPS fix and guesses its position from Wi-Fi / cell towers, with
-- an error of 50-500 m that changes every reading: the truck jumped across buildings and back.
-- A new position now only replaces the last one when it is a real move:
--   * it is outside the error circle of the readings (accuracy x 1.5, at least 20 m), or the phone
--     reports driving speed with a sharp fix (accuracy <= 30 m);
--   * a rough reading right after a sharp one (within 5 min) must be at least 2x its error away;
--   * an impossible jump (over 1 km at more than 250 km/h) is ignored.
-- Otherwise the truck keeps its last position (still marked live) and stays "stopped".
-- History, "long stop" and "moved during no signal" use the same filtered position.
-- Real movement is never hidden: driving moves far beyond any error circle.

create or replace function public.record_location(
  p_user uuid, p_lat double precision, p_lng double precision,
  p_accuracy double precision, p_speed double precision, p_heading double precision)
returns void language plpgsql security definer set search_path = '' as $$
declare
  prof public.profiles;
  acc double precision := coalesce(nullif(p_accuracy, 0), 50); -- unknown accuracy: assume a rough fix
  good_fix boolean;
  says_moving boolean := coalesce(p_speed, 0) >= 1.4;
  raw_moved double precision;
  secs double precision;
  limit_m double precision;
  jitter boolean := false;
  moving boolean;
  new_lat double precision := p_lat;
  new_lng double precision := p_lng;
  moved double precision;
  last_point public.location_history;
begin
  if p_lat is null or p_lng is null or abs(p_lat) > 90 or abs(p_lng) > 180 then
    raise exception 'Invalid location';
  end if;
  select * into prof from public.profiles where id = p_user for update;
  if prof.id is null or (prof.role = 'admin' and not prof.tracked) then return; end if;
  good_fix := acc <= 30;

  if prof.lat is not null then
    raw_moved := public.distance_m(prof.lat, prof.lng, p_lat, p_lng);
    secs := greatest(extract(epoch from now() - coalesce(prof.location_at, now() - interval '1 day')), 1);
    limit_m := greatest(acc, 20) * case
      when not good_fix and prof.accuracy <= 30 and prof.location_at > now() - interval '5 minutes' then 2.0
      else 1.5 end;
    jitter := (raw_moved < limit_m and not (says_moving and good_fix))
           or (secs < 300 and raw_moved > 1000 and raw_moved / secs > 70);
    if jitter then
      new_lat := prof.lat;
      new_lng := prof.lng;
    end if;
  end if;
  moving := says_moving and not jitter;
  moved := case when prof.lat is null then null else public.distance_m(prof.lat, prof.lng, new_lat, new_lng) end;

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
     set lat = new_lat, lng = new_lng,
         accuracy = case when jitter then prof.accuracy else p_accuracy end,
         speed = case when jitter then 0 when p_speed is null or p_speed < 0 then null else p_speed end,
         heading = case when jitter then prof.heading when p_heading is null or p_heading < 0 then null else p_heading end,
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
         and (public.distance_m(last_point.lat, last_point.lng, new_lat, new_lng) >= 50
              or now() - last_point.recorded_at >= interval '2 minutes')) then
    insert into public.location_history (user_id, lat, lng, speed)
    values (p_user, new_lat, new_lng, case when jitter then 0 when p_speed < 0 then null else p_speed end)
    on conflict do nothing;
  end if;
end $$;
