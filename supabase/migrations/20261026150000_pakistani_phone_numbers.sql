-- 1. Phone numbers must be real Pakistani numbers. A number with a digit missing (0300926520)
--    used to be saved as "+0300926520", so a driver added with it could never get the invite.
--    Accepted: 0300 1234567, 300 1234567, +92 300 1234567, 0092 300 1234567 → +923001234567.
--    The one invite saved with such a number is removed (it can never be accepted); add it again.
-- 2. Trip steps are updated by the driver only (undoes the short-lived "office" change):
--    trip_step() is the original again, and the office upload rule for bilty photos is gone.

create or replace function public.normalize_phone(p text)
returns text language plpgsql immutable set search_path = '' as $$
declare d text := regexp_replace(coalesce(p, ''), '\D', '', 'g');
begin
  if d like '00%' then d := substr(d, 3); end if;            -- 0092 300 ...
  if d like '0%' and length(d) = 11 then d := '92' || substr(d, 2); end if;
  if d like '3%' and length(d) = 10 then d := '92' || d; end if;
  if d !~ '^92[0-9]{9,10}$' then return null; end if;      -- Pakistan: 92 + 9 or 10 digits
  return '+' || d;
end $$;

delete from public.company_invites where phone !~ '^\+92[0-9]{9,10}$';

drop policy if exists "Carrier office uploads proof of delivery" on storage.objects;

create or replace function public.trip_step(p_trip uuid, p_step text, p_pod_path text default null)
returns json language plpgsql security definer set search_path = '' as $$
declare
  t public.trips;
  me public.profiles;
  next_step text;
begin
  select * into t from public.trips where id = p_trip for update;
  if t.id is null or t.driver_id <> (select auth.uid()) then raise exception 'This is not your job'; end if;
  next_step := case t.status when 'assigned' then 'at_pickup' when 'at_pickup' then 'loaded'
                             when 'loaded' then 'at_drop' when 'at_drop' then 'delivered' end;
  if next_step is null or p_step is distinct from next_step then raise exception 'This step is already done or not next'; end if;
  if p_step = 'delivered' then
    if p_pod_path is null or p_pod_path not like t.load_id::text || '/' || t.id::text || '-%' then
      raise exception 'Take a photo of the signed bilty / receipt first';
    end if;
  end if;
  select * into me from public.profiles where id = t.driver_id;
  update public.trips
     set status = p_step,
         pod_path = coalesce(p_pod_path, pod_path),
         steps = steps || jsonb_build_object(p_step, jsonb_build_object(
                   'at', now(),
                   'lat', case when me.location_at > now() - interval '15 minutes' then me.lat end,
                   'lng', case when me.location_at > now() - interval '15 minutes' then me.lng end))
   where id = t.id;
  -- Every truck delivered: the load is delivered.
  if p_step = 'delivered' and not exists (
       select 1 from public.trips where load_id = t.load_id and status in ('assigned', 'at_pickup', 'loaded', 'at_drop')) then
    update public.loads set status = 'delivered', delivered_at = now() where id = t.load_id and status = 'booked';
  end if;
  return public.my_trips();
end $$;
