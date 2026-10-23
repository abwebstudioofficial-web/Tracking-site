-- Route recorded while the phone had no internet.
-- The app keeps the positions it couldn't send (a point every 20 s or 50 m while driving,
-- every 2 min while parked, with the GPS time of each) and uploads them here once it's online
-- again, so trip history and "Follow live" show the road the truck took during the gap.
-- p_points: [[epoch milliseconds, lat, lng, speed m/s or null], ...], at most 1000 per call.
-- Returns the number of points received, or -1 if the token is no longer valid.

create function public.track_backlog(p_token text, p_points json)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  device_user uuid;
begin
  if p_token is null or length(p_token) <> 64 then return -1; end if;
  select user_id into device_user from public.tracker_devices
   where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
  if device_user is null then return -1; end if;
  if json_typeof(p_points) <> 'array' or json_array_length(p_points) > 1000 then
    raise exception 'Send at most 1000 points at a time';
  end if;
  -- Same people as record_location: drivers, and admins the main admin chose to track.
  if not exists (select 1 from public.profiles
                  where id = device_user and (role <> 'admin' or tracked)) then
    return json_array_length(p_points);
  end if;

  insert into public.location_history (user_id, recorded_at, lat, lng, speed)
  select device_user, t, lat, lng, case when speed >= 0 and speed <= 70 then speed end
    from (select to_timestamp((e->>0)::double precision / 1000) as t,
                 (e->>1)::double precision as lat, (e->>2)::double precision as lng,
                 (e->>3)::double precision as speed
            from json_array_elements(p_points) e
           where json_typeof(e) = 'array' and json_array_length(e) >= 3) pts
   where lat between -90 and 90 and lng between -180 and 180
     -- History is kept for 30 days; a time in the future means the phone's clock is wrong.
     and t > now() - interval '30 days' and t < now() + interval '5 minutes'
  on conflict do nothing;

  update public.tracker_devices set last_seen_at = now() where user_id = device_user;
  return json_array_length(p_points);
end $$;

revoke execute on function public.track_backlog(text, json) from public;
-- The token itself is the credential, so the app's background service calls this with just the publishable key.
grant execute on function public.track_backlog(text, json) to anon, authenticated;
