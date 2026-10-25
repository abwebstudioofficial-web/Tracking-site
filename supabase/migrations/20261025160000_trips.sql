-- Transport Hub, stage 3: doing the job.
--
-- trips  one truck/driver on a booked load. The winning carrier assigns its own drivers (up to the
--        number of trucks the load needs). The driver moves the trip through its steps in the app:
--          assigned -> at_pickup -> loaded -> at_drop -> delivered (with a photo of the signed bilty)
--        Each step stores the time and where the phone was (its last tracked position), so a step
--        tapped far from the road can be spotted. When every trip is delivered, the load is delivered.
-- The shipper sees each assigned truck's live position while it is on the job (not before, not after).
-- trip-pod storage: proof-of-delivery photos, trip-pod/<load id>/<trip id>-<time>.<ext>.

create table public.trips (
  id            uuid primary key default gen_random_uuid(),
  load_id       uuid not null references public.loads(id) on delete cascade,
  company_id    uuid not null references public.companies(id) on delete cascade,
  driver_id     uuid not null references public.profiles(id) on delete cascade,
  assigned_by   uuid references public.profiles(id) on delete set null,
  status        text not null default 'assigned'
                check (status in ('assigned', 'at_pickup', 'loaded', 'at_drop', 'delivered', 'cancelled')),
  steps         jsonb not null default '{}'::jsonb, -- { at_pickup: {at, lat, lng}, loaded: {...}, ... }
  pod_path      text,
  created_at    timestamptz not null default now()
);
create index trips_load on public.trips (load_id);
create index trips_driver on public.trips (driver_id, created_at desc);
-- A driver has at most one job on the road at a time.
create unique index trips_one_active_per_driver on public.trips (driver_id)
  where status in ('assigned', 'at_pickup', 'loaded', 'at_drop');

-- Who may see a trip: its driver, the carrier's and the shipper's owner/managers, and admins.
create or replace function public.can_see_trip(p_load uuid, p_company uuid, p_driver uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_admin() or p_driver = (select auth.uid())
      or (coalesce(public.my_company_role(), '') in ('owner', 'manager')
          and (p_company = public.my_company_id()
               or exists (select 1 from public.loads l where l.id = p_load and l.company_id = public.my_company_id())));
$$;

alter table public.trips enable row level security;
revoke all on table public.trips from anon;
revoke insert, update, delete on table public.trips from authenticated;
grant select on table public.trips to authenticated;
create policy "Who can see a trip" on public.trips for select to authenticated
  using ((select public.can_see_trip(load_id, company_id, driver_id)));
alter publication supabase_realtime add table public.trips;

-- One trip as the pages show it. With_location: the driver's live position (active trips only).
create or replace function public.trip_json(t public.trips, with_location boolean)
returns json language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'id', t.id, 'load_id', t.load_id, 'status', t.status, 'steps', t.steps, 'has_pod', t.pod_path is not null,
    'pod_path', t.pod_path, 'created_at', t.created_at,
    'driver', json_build_object('id', p.id, 'name', p.name, 'phone', p.phone),
    'location', case when with_location and t.status in ('assigned', 'at_pickup', 'loaded', 'at_drop') and p.lat is not null
                     then json_build_object('lat', p.lat, 'lng', p.lng, 'at', p.location_at, 'speed', p.speed, 'heading', p.heading,
                                            'problem', p.tracking_problem) end)
    from public.profiles p where p.id = t.driver_id;
$$;

-- Trips of a booked load, plus (for the carrier) the drivers it can assign.
create or replace function public.load_trips(p_load uuid)
returns json language plpgsql stable security definer set search_path = '' as $$
declare
  l public.loads;
  carrier uuid;
  staff boolean := coalesce(public.my_company_role(), '') in ('owner', 'manager');
  is_carrier boolean;
begin
  select * into l from public.loads where id = p_load;
  select company_id into carrier from public.bids where id = l.booked_bid;
  is_carrier := carrier is not null and carrier = public.my_company_id() and staff;
  if not (public.is_admin() or is_carrier or (l.company_id = public.my_company_id() and staff)) then
    raise exception 'Only the shipper and the booked carrier see the trucks on this load';
  end if;
  return json_build_object(
    'trucks', l.trucks,
    'can_assign', is_carrier and l.status = 'booked',
    'trips', coalesce((select json_agg(public.trip_json(t, true) order by t.created_at)
                         from public.trips t where t.load_id = l.id and t.status <> 'cancelled'), '[]'::json),
    'drivers', case when is_carrier and l.status = 'booked' then coalesce((
      select json_agg(json_build_object('id', p.id, 'name', p.name, 'phone', p.phone,
                                        'busy', exists (select 1 from public.trips t where t.driver_id = p.id
                                                          and t.status in ('assigned', 'at_pickup', 'loaded', 'at_drop')))
                      order by p.name)
        from public.company_members m join public.profiles p on p.id = m.user_id
       where m.company_id = carrier and m.role = 'driver'), '[]'::json) end);
end $$;

create or replace function public.assign_driver(p_load uuid, p_driver uuid)
returns json language plpgsql security definer set search_path = '' as $$
declare
  l public.loads;
  carrier uuid;
begin
  select * into l from public.loads where id = p_load for update;
  select company_id into carrier from public.bids where id = l.booked_bid;
  if carrier is null or carrier is distinct from public.my_company_id()
     or coalesce(public.my_company_role(), '') not in ('owner', 'manager') then
    raise exception 'Only the booked carrier can assign drivers';
  end if;
  if l.status <> 'booked' then raise exception 'This load is not waiting for trucks'; end if;
  if not exists (select 1 from public.company_members where company_id = carrier and user_id = p_driver and role = 'driver') then
    raise exception 'This driver is not in your company';
  end if;
  if (select count(*) from public.trips where load_id = l.id and status <> 'cancelled') >= l.trucks then
    raise exception 'All % trucks for this load are assigned', l.trucks;
  end if;
  if exists (select 1 from public.trips where driver_id = p_driver and status in ('assigned', 'at_pickup', 'loaded', 'at_drop')) then
    raise exception 'This driver is already on another job';
  end if;
  insert into public.trips (load_id, company_id, driver_id, assigned_by) values (l.id, carrier, p_driver, (select auth.uid()));
  return public.load_trips(l.id);
end $$;

-- The carrier takes a driver off a job that hasn't been loaded yet.
create or replace function public.unassign_trip(p_trip uuid)
returns json language plpgsql security definer set search_path = '' as $$
declare t public.trips;
begin
  select * into t from public.trips where id = p_trip for update;
  if t.id is null or t.company_id is distinct from public.my_company_id()
     or coalesce(public.my_company_role(), '') not in ('owner', 'manager') then
    raise exception 'Only the carrier can change its drivers';
  end if;
  if t.status not in ('assigned', 'at_pickup') then raise exception 'The truck is already loaded'; end if;
  update public.trips set status = 'cancelled' where id = t.id;
  return public.load_trips(t.load_id);
end $$;

-- The driver's jobs: on the road now first, then the last few finished ones.
create or replace function public.my_trips()
returns json language sql stable security definer set search_path = '' as $$
  select coalesce(json_agg(x.j order by x.active desc, x.created_at desc), '[]'::json) from (
    select json_build_object(
             'trip', public.trip_json(t, false),
             'load', json_build_object('id', l.id, 'trade', l.trade, 'pickup_city', l.pickup_city, 'pickup_place', l.pickup_place,
                                       'drop_city', l.drop_city, 'drop_place', l.drop_place, 'pickup_date', l.pickup_date,
                                       'equipment', l.equipment, 'cargo', l.cargo, 'weight_tons', l.weight_tons,
                                       'container_no', l.container_no, 'notes', l.notes),
             'shipper', (select json_build_object('name', c.name, 'person', p.name, 'phone', coalesce(p.phone, c.phone))
                           from public.companies c left join public.profiles p on p.id = l.posted_by where c.id = l.company_id)) j,
           t.status in ('assigned', 'at_pickup', 'loaded', 'at_drop') active, t.created_at
      from public.trips t join public.loads l on l.id = t.load_id
     where t.driver_id = (select auth.uid()) and t.status <> 'cancelled'
     order by active desc, t.created_at desc limit 6) x;
$$;

-- The driver taps the next step. Where the phone was is taken from its tracked position (not from
-- the page), and kept only if it is fresh. Delivery needs the proof-of-delivery photo.
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

-- A cancelled load ends its trips.
create or replace function public.end_trips_of_cancelled_load()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    update public.trips set status = 'cancelled' where load_id = new.id and status <> 'delivered';
  end if;
  return new;
end $$;
create trigger loads_cancel_trips after update of status on public.loads
  for each row execute function public.end_trips_of_cancelled_load();

-- Proof-of-delivery photos: the trip's driver uploads; both companies' staff and admins view.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('trip-pod', 'trip-pod', false, 8388608, array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'])
on conflict (id) do nothing;
create policy "Driver uploads proof of delivery" on storage.objects for insert to authenticated with check (
  bucket_id = 'trip-pod' and exists (
    select 1 from public.trips t
     where t.driver_id = (select auth.uid()) and t.status = 'at_drop'
       and (storage.foldername(name))[1] = t.load_id::text and storage.filename(name) like t.id::text || '-%'));
create policy "Both companies see proof of delivery" on storage.objects for select to authenticated using (
  bucket_id = 'trip-pod' and exists (
    select 1 from public.trips t
     where (storage.foldername(name))[1] = t.load_id::text and storage.filename(name) like t.id::text || '-%'
       and (select public.can_see_trip(t.load_id, t.company_id, t.driver_id))));

revoke execute on function public.can_see_trip(uuid, uuid, uuid) from public, anon;
revoke execute on function public.trip_json(public.trips, boolean) from public, anon, authenticated;
revoke execute on function public.load_trips(uuid) from public, anon;
revoke execute on function public.assign_driver(uuid, uuid) from public, anon;
revoke execute on function public.unassign_trip(uuid) from public, anon;
revoke execute on function public.my_trips() from public, anon;
revoke execute on function public.trip_step(uuid, text, text) from public, anon;
revoke execute on function public.end_trips_of_cancelled_load() from public, anon, authenticated;
grant execute on function public.can_see_trip(uuid, uuid, uuid) to authenticated;
grant execute on function public.load_trips(uuid) to authenticated;
grant execute on function public.assign_driver(uuid, uuid) to authenticated;
grant execute on function public.unassign_trip(uuid) to authenticated;
grant execute on function public.my_trips() to authenticated;
grant execute on function public.trip_step(uuid, text, text) to authenticated;
