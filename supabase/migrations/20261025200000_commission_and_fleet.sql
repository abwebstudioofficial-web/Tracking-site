-- Transport Hub, stage 5: commission and each carrier's fleet map.
--
-- platform_settings  values the platform admins can change. fee_per_trip: what a carrier owes
--                    Transport Hub for each truck trip it delivers (starts at Rs 1,000).
-- platform_fees      one row per delivered load the carrier carried: trips x the fee at that moment.
--                    Admins mark it paid (or waive it). Changing the fee only affects new deliveries.
-- my_fleet()         a carrier's own drivers with their live position and current job, for its map.

create table public.platform_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);
alter table public.platform_settings enable row level security;
revoke all on table public.platform_settings from anon, authenticated; -- read through platform_fee()
insert into public.platform_settings (key, value) values ('fee_per_trip', '1000');

create table public.platform_fees (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  load_id      uuid not null unique references public.loads(id) on delete cascade,
  trips        smallint not null check (trips >= 1),
  fee_per_trip integer not null check (fee_per_trip >= 0),
  amount       integer not null check (amount >= 0),
  status       text not null default 'due' check (status in ('due', 'paid', 'waived')),
  note         text not null default '' check (length(note) <= 200),
  created_at   timestamptz not null default now(),
  paid_at      timestamptz
);
create index platform_fees_company on public.platform_fees (company_id, created_at desc);
alter table public.platform_fees enable row level security;
revoke all on table public.platform_fees from anon;
revoke insert, update, delete on table public.platform_fees from authenticated;
grant select on table public.platform_fees to authenticated;
create policy "Carrier staff and admins read fees" on public.platform_fees for select to authenticated using (
  (select public.is_admin())
  or (company_id = (select public.my_company_id()) and (select public.my_company_role()) in ('owner', 'manager')));

create or replace function public.platform_fee()
returns integer language sql stable security definer set search_path = '' as $$
  select coalesce((select (value #>> '{}')::integer from public.platform_settings where key = 'fee_per_trip'), 0);
$$;

-- A delivered load: the carrier owes the fee for each truck trip delivered.
create or replace function public.fee_on_delivery()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  carrier uuid;
  n integer;
  fee integer := public.platform_fee();
begin
  if new.status = 'delivered' and old.status is distinct from 'delivered' and new.booked_bid is not null then
    select company_id into carrier from public.bids where id = new.booked_bid;
    select count(*) into n from public.trips where load_id = new.id and status = 'delivered';
    if n = 0 then n := new.trucks; end if; -- marked delivered without using the driver app
    insert into public.platform_fees (company_id, load_id, trips, fee_per_trip, amount, status)
    values (carrier, new.id, n, fee, n * fee, case when fee = 0 then 'waived' else 'due' end)
    on conflict (load_id) do nothing;
    if fee > 0 then
      perform public.notify(carrier, 'fee', 'Transport Hub fee: ' || public.rs(n * fee),
        n || ' trip' || case when n > 1 then 's' else '' end || ' × ' || public.rs(fee) || ' · ' || public.route_text(new.id), new.id);
    end if;
  end if;
  return new;
end $$;
create trigger loads_fee_on_delivery after update of status on public.loads
  for each row execute function public.fee_on_delivery();

create or replace function public.fee_row(f public.platform_fees)
returns json language sql stable security definer set search_path = '' as $$
  select json_build_object('id', f.id, 'load_id', f.load_id, 'trips', f.trips, 'fee_per_trip', f.fee_per_trip,
    'amount', f.amount, 'status', f.status, 'note', f.note, 'created_at', f.created_at, 'paid_at', f.paid_at,
    'route', public.route_text(f.load_id),
    'company', (select json_build_object('id', c.id, 'name', c.name, 'city', c.city, 'phone', c.phone) from public.companies c where c.id = f.company_id));
$$;

-- A carrier's fees (Invoices tab).
create or replace function public.my_platform_fees()
returns json language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce(public.my_company_role(), '') not in ('owner', 'manager') then raise exception 'Only the owner or a manager can see fees'; end if;
  return json_build_object(
    'fee_per_trip', public.platform_fee(),
    'due', (select coalesce(sum(amount), 0) from public.platform_fees where company_id = public.my_company_id() and status = 'due'),
    'items', coalesce((select json_agg(public.fee_row(f) order by (f.status = 'due') desc, f.created_at desc)
                         from public.platform_fees f where f.company_id = public.my_company_id()), '[]'::json));
end $$;

-- Platform admins: the fee, and everything owed or collected.
create or replace function public.admin_platform_fees()
returns json language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  return json_build_object(
    'fee_per_trip', public.platform_fee(),
    'due', (select coalesce(sum(amount), 0) from public.platform_fees where status = 'due'),
    'collected', (select coalesce(sum(amount), 0) from public.platform_fees where status = 'paid'),
    'items', coalesce((select json_agg(public.fee_row(f) order by (f.status = 'due') desc, f.created_at desc)
                         from (select * from public.platform_fees order by created_at desc limit 500) f), '[]'::json));
end $$;

create or replace function public.admin_set_fee(p_amount integer)
returns json language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if p_amount is null or p_amount < 0 or p_amount > 1000000 then raise exception 'Enter the fee in rupees (0 to 1,000,000)'; end if;
  insert into public.platform_settings (key, value, updated_at, updated_by)
  values ('fee_per_trip', to_jsonb(p_amount), now(), (select auth.uid()))
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by;
  return public.admin_platform_fees();
end $$;

create or replace function public.admin_set_fee_status(p_fee uuid, p_status text, p_note text default '')
returns json language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if p_status not in ('due', 'paid', 'waived') then raise exception 'Unknown status'; end if;
  update public.platform_fees
     set status = p_status, note = left(trim(coalesce(p_note, '')), 200),
         paid_at = case when p_status = 'paid' then now() end
   where id = p_fee;
  if not found then raise exception 'Fee not found'; end if;
  return public.admin_platform_fees();
end $$;

-- A carrier's own drivers, where they are and what they're doing.
create or replace function public.my_fleet()
returns json language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce(public.my_company_role(), '') not in ('owner', 'manager') then raise exception 'Only the owner or a manager can see the fleet'; end if;
  return coalesce((
    select json_agg(json_build_object(
             'id', p.id, 'name', p.name, 'phone', p.phone,
             'lat', p.lat, 'lng', p.lng, 'at', p.location_at, 'speed', p.speed, 'heading', p.heading,
             'problem', p.tracking_problem, 'battery', p.battery,
             'trip', (select json_build_object('status', t.status, 'load_id', t.load_id, 'route', public.route_text(t.load_id))
                        from public.trips t where t.driver_id = p.id and t.status in ('assigned', 'at_pickup', 'loaded', 'at_drop')
                        order by t.created_at desc limit 1))
           order by p.name)
      from public.company_members m join public.profiles p on p.id = m.user_id
     where m.company_id = public.my_company_id() and m.role = 'driver'), '[]'::json);
end $$;

revoke execute on function public.platform_fee() from public, anon;
revoke execute on function public.fee_on_delivery() from public, anon, authenticated;
revoke execute on function public.fee_row(public.platform_fees) from public, anon, authenticated;
revoke execute on function public.my_platform_fees() from public, anon;
revoke execute on function public.admin_platform_fees() from public, anon;
revoke execute on function public.admin_set_fee(integer) from public, anon;
revoke execute on function public.admin_set_fee_status(uuid, text, text) from public, anon;
revoke execute on function public.my_fleet() from public, anon;
grant execute on function public.platform_fee() to authenticated;
grant execute on function public.my_platform_fees() to authenticated;
grant execute on function public.admin_platform_fees() to authenticated;
grant execute on function public.admin_set_fee(integer) to authenticated;
grant execute on function public.admin_set_fee_status(uuid, text, text) to authenticated;
grant execute on function public.my_fleet() to authenticated;
