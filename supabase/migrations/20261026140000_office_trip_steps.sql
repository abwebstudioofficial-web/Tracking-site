-- Trip steps from the carrier's office: besides the driver (in the app), the carrier's owner or
-- managers can mark a truck "at pickup", "loaded", "arrived" and "delivered" from the hub, for
-- drivers without the app or with a dead phone. Delivered still needs the bilty / receipt photo.
-- Each step remembers who marked it ('driver' or 'office').

create or replace function public.trip_step(p_trip uuid, p_step text, p_pod_path text default null)
returns json language plpgsql security definer set search_path = '' as $$
declare
  t public.trips;
  me public.profiles;
  next_step text;
  by_driver boolean;
begin
  select * into t from public.trips where id = p_trip for update;
  if t.id is null then raise exception 'This is not your job'; end if;
  by_driver := t.driver_id = (select auth.uid());
  if not by_driver and not (t.company_id = (select public.my_company_id())
                            and (select public.my_company_role()) in ('owner', 'manager')) then
    raise exception 'This is not your job';
  end if;
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
                   'by', case when by_driver then 'driver' else 'office' end,
                   'lat', case when me.location_at > now() - interval '15 minutes' then me.lat end,
                   'lng', case when me.location_at > now() - interval '15 minutes' then me.lng end))
   where id = t.id;
  -- Every truck delivered: the load is delivered.
  if p_step = 'delivered' and not exists (
       select 1 from public.trips where load_id = t.load_id and status in ('assigned', 'at_pickup', 'loaded', 'at_drop')) then
    update public.loads set status = 'delivered', delivered_at = now() where id = t.load_id and status = 'booked';
  end if;
  if by_driver then return public.my_trips(); end if;
  return public.load_trips(t.load_id);
end $$;

-- The office may upload the bilty photo for its own truck once it has arrived.
create policy "Carrier office uploads proof of delivery" on storage.objects for insert to authenticated with check (
  bucket_id = 'trip-pod' and exists (
    select 1 from public.trips t
     where t.company_id = (select public.my_company_id()) and (select public.my_company_role()) in ('owner', 'manager')
       and t.status = 'at_drop'
       and (storage.foldername(name))[1] = t.load_id::text and storage.filename(name) like t.id::text || '-%'));
