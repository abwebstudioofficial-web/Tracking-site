-- Transport Hub, stage 2: the load board.
--
-- loads  a shipment posted by a verified shipper or broker: route, date, truck type, cargo, target price.
-- bids   a verified carrier, broker or dispatcher's price for a load (one per company, can be changed).
--        Bids are open: every verified company sees all bids on an open load, so shippers compare and
--        carriers know the going rate. Once booked, only the two sides see the bids and contacts.
-- Booking: the poster accepts a bid. The load is booked, the other bids are declined, and both sides
-- see each other's phone number. The poster marks it delivered at the end.

create table public.loads (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  posted_by    uuid references public.profiles(id) on delete set null,
  trade        text not null check (trade in ('import', 'export', 'domestic')),
  pickup_city  text not null check (length(trim(pickup_city)) between 2 and 60),
  pickup_place text not null default '' check (length(pickup_place) <= 120),
  drop_city    text not null check (length(trim(drop_city)) between 2 and 60),
  drop_place   text not null default '' check (length(drop_place) <= 120),
  pickup_date  date not null,
  equipment    text not null check (equipment in ('container_20', 'container_40', 'flatbed', 'open_body', 'covered', 'other')),
  trucks       smallint not null default 1 check (trucks between 1 and 50),
  weight_tons  numeric(6, 2) check (weight_tons > 0 and weight_tons <= 500),
  cargo        text not null default '' check (length(cargo) <= 120),
  container_no text not null default '' check (length(container_no) <= 60),
  target_price integer check (target_price between 1000 and 100000000),
  notes        text not null default '' check (length(notes) <= 500),
  status       text not null default 'open' check (status in ('open', 'booked', 'cancelled', 'delivered')),
  booked_bid   uuid,
  booked_at    timestamptz,
  delivered_at timestamptz,
  created_at   timestamptz not null default now()
);
create index loads_open on public.loads (pickup_date) where status = 'open';
create index loads_company on public.loads (company_id, created_at desc);

create table public.bids (
  id         uuid primary key default gen_random_uuid(),
  load_id    uuid not null references public.loads(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  placed_by  uuid references public.profiles(id) on delete set null,
  amount     integer not null check (amount between 1000 and 100000000),
  note       text not null default '' check (length(note) <= 300),
  status     text not null default 'active' check (status in ('active', 'withdrawn', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (load_id, company_id)
);
create index bids_company on public.bids (company_id, updated_at desc);
alter table public.loads add constraint loads_booked_bid_fkey foreign key (booked_bid) references public.bids(id) on delete set null;

-- My company, if it is verified and I may act for it (owner or manager).
create or replace function public.my_trading_company()
returns public.companies language sql stable security definer set search_path = '' as $$
  select c.* from public.companies c join public.company_members m on m.company_id = c.id
   where m.user_id = (select auth.uid()) and m.role in ('owner', 'manager') and c.status = 'verified';
$$;

create or replace function public.can_see_load(p_load uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_admin() or exists (
    select 1 from public.loads l
     where l.id = p_load and (
       l.company_id = public.my_company_id()
       or (l.status = 'open' and (select status from public.companies where id = public.my_company_id()) = 'verified')
       or exists (select 1 from public.bids b where b.load_id = l.id and b.company_id = public.my_company_id())));
$$;

-- Reads go through the functions below; these policies let the page get live updates.
alter table public.loads enable row level security;
alter table public.bids enable row level security;
revoke all on table public.loads, public.bids from anon;
revoke insert, update, delete on table public.loads, public.bids from authenticated;
grant select on table public.loads, public.bids to authenticated;
create policy "Who can see a load" on public.loads for select to authenticated using ((select public.can_see_load(id)));
create policy "Who can see a bid" on public.bids for select to authenticated using (
  (select public.is_admin()) or company_id = (select public.my_company_id())
  or exists (select 1 from public.loads l where l.id = load_id and (
    l.company_id = (select public.my_company_id())
    or (l.status = 'open' and (select public.can_see_load(l.id))))));
alter publication supabase_realtime add table public.loads, public.bids;

create or replace function public.post_load(
  p_trade text, p_pickup_city text, p_pickup_place text, p_drop_city text, p_drop_place text,
  p_pickup_date date, p_equipment text, p_trucks integer, p_weight_tons numeric, p_cargo text,
  p_container_no text, p_target_price integer, p_notes text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  c public.companies := public.my_trading_company();
  new_id uuid;
begin
  if c.id is null then raise exception 'Only verified companies can post loads (owner or manager)'; end if;
  if c.kind not in ('shipper', 'broker') then raise exception 'Only shippers and brokers post loads'; end if;
  if p_pickup_date is null or p_pickup_date < current_date then raise exception 'Choose a pickup date from today on'; end if;
  if p_pickup_date > current_date + 90 then raise exception 'Choose a pickup date within 3 months'; end if;
  insert into public.loads (company_id, posted_by, trade, pickup_city, pickup_place, drop_city, drop_place,
                            pickup_date, equipment, trucks, weight_tons, cargo, container_no, target_price, notes)
  values (c.id, (select auth.uid()), p_trade, trim(p_pickup_city), trim(coalesce(p_pickup_place, '')),
          trim(p_drop_city), trim(coalesce(p_drop_place, '')), p_pickup_date, p_equipment,
          coalesce(p_trucks, 1), p_weight_tons, trim(coalesce(p_cargo, '')), trim(coalesce(p_container_no, '')),
          p_target_price, trim(coalesce(p_notes, '')))
  returning id into new_id;
  return new_id;
end $$;

-- A short summary of a load, as the lists show it.
create or replace function public.load_summary(l public.loads)
returns json language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'id', l.id, 'trade', l.trade, 'pickup_city', l.pickup_city, 'pickup_place', l.pickup_place,
    'drop_city', l.drop_city, 'drop_place', l.drop_place, 'pickup_date', l.pickup_date,
    'equipment', l.equipment, 'trucks', l.trucks, 'weight_tons', l.weight_tons, 'cargo', l.cargo,
    'target_price', l.target_price, 'status', l.status, 'created_at', l.created_at,
    'mine', l.company_id = public.my_company_id(),
    'poster', (select json_build_object('name', c.name, 'city', c.city, 'kind', c.kind) from public.companies c where c.id = l.company_id),
    'bids', (select count(*) from public.bids b where b.load_id = l.id and b.status = 'active'),
    'lowest', (select min(amount) from public.bids b where b.load_id = l.id and b.status = 'active'),
    'my_bid', (select json_build_object('amount', b.amount, 'status', b.status) from public.bids b
                where b.load_id = l.id and b.company_id = public.my_company_id()),
    'booked_amount', (select b.amount from public.bids b where b.id = l.booked_bid),
    'booked_with', (select c.name from public.bids b join public.companies c on c.id = b.company_id where b.id = l.booked_bid));
$$;

-- The board: open loads, soonest pickup first. Filters are optional.
create or replace function public.load_board(p_trade text default null, p_equipment text default null,
                                             p_from text default null, p_to text default null)
returns json language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() and coalesce((select status from public.companies where id = public.my_company_id()), '') <> 'verified' then
    raise exception 'Your company must be verified to see the load board';
  end if;
  return coalesce((
    select json_agg(public.load_summary(l) order by l.pickup_date, l.created_at)
      from (select * from public.loads l
             where l.status = 'open' and l.pickup_date >= current_date - 2
               and (p_trade is null or l.trade = p_trade)
               and (p_equipment is null or l.equipment = p_equipment)
               and (p_from is null or l.pickup_city ilike '%' || p_from || '%' or l.pickup_place ilike '%' || p_from || '%')
               and (p_to is null or l.drop_city ilike '%' || p_to || '%' or l.drop_place ilike '%' || p_to || '%')
             order by l.pickup_date, l.created_at limit 300) l), '[]'::json);
end $$;

-- My company's loads (posted) and bids (placed), newest first.
create or replace function public.my_loads()
returns json language sql stable security definer set search_path = '' as $$
  select coalesce(json_agg(public.load_summary(l) order by (l.status = 'open') desc, l.created_at desc), '[]'::json)
    from (select * from public.loads where company_id = public.my_company_id() order by created_at desc limit 300) l;
$$;
create or replace function public.my_bids()
returns json language sql stable security definer set search_path = '' as $$
  select coalesce(json_agg(public.load_summary(l) order by b.updated_at desc), '[]'::json)
    from public.bids b join public.loads l on l.id = b.load_id
   where b.company_id = public.my_company_id();
$$;

-- One load with its bids. Contacts are shown to both sides once it's booked.
create or replace function public.load_detail(p_load uuid)
returns json language plpgsql stable security definer set search_path = '' as $$
declare
  l public.loads;
  mine boolean;
  winner uuid;
  open_view boolean;
begin
  if not public.can_see_load(p_load) then raise exception 'This load is no longer available'; end if;
  select * into l from public.loads where id = p_load;
  mine := l.company_id = public.my_company_id();
  select company_id into winner from public.bids where id = l.booked_bid;
  open_view := l.status = 'open' or mine or public.is_admin();
  return json_build_object(
    'load', public.load_summary(l),
    'details', json_build_object('container_no', l.container_no, 'notes', l.notes, 'booked_at', l.booked_at, 'delivered_at', l.delivered_at),
    'can_bid', coalesce(l.status = 'open' and not mine and (public.my_trading_company()).kind in ('carrier', 'broker', 'dispatcher'), false),
    'can_manage', mine and coalesce(public.my_company_role(), '') in ('owner', 'manager'),
    'bids', coalesce((
      select json_agg(json_build_object(
               'id', b.id, 'amount', b.amount, 'note', b.note, 'status', b.status, 'updated_at', b.updated_at,
               'mine', b.company_id = public.my_company_id(),
               'company', json_build_object('name', c.name, 'city', c.city, 'kind', c.kind, 'fleet_size', c.fleet_size))
             order by (b.status = 'accepted') desc, (b.status = 'active') desc, b.amount)
        from public.bids b join public.companies c on c.id = b.company_id
       where b.load_id = l.id and (open_view or b.company_id = public.my_company_id())
         and (b.status in ('active', 'accepted') or b.company_id = public.my_company_id() or mine)), '[]'::json),
    -- After booking: the poster sees the carrier's contact, the carrier sees the poster's.
    'contact', case
      when l.status not in ('booked', 'delivered') then null
      when mine then (select json_build_object('company', c.name, 'phone', c.phone, 'city', c.city,
                                               'person', (select p.name from public.profiles p where p.id = b.placed_by),
                                               'person_phone', (select p.phone from public.profiles p where p.id = b.placed_by))
                        from public.bids b join public.companies c on c.id = b.company_id where b.id = l.booked_bid)
      when winner = public.my_company_id() or public.is_admin() then (
        select json_build_object('company', c.name, 'phone', c.phone, 'city', c.city,
                                 'person', (select p.name from public.profiles p where p.id = l.posted_by),
                                 'person_phone', (select p.phone from public.profiles p where p.id = l.posted_by))
          from public.companies c where c.id = l.company_id)
    end);
end $$;

-- Place or change my company's bid (total price for the whole load, in rupees).
create or replace function public.place_bid(p_load uuid, p_amount integer, p_note text default '')
returns json language plpgsql security definer set search_path = '' as $$
declare
  c public.companies := public.my_trading_company();
  l public.loads;
begin
  if c.id is null then raise exception 'Only verified companies can bid (owner or manager)'; end if;
  if c.kind not in ('carrier', 'broker', 'dispatcher') then raise exception 'Only carriers, brokers and dispatchers bid on loads'; end if;
  select * into l from public.loads where id = p_load for update;
  if l.id is null or l.status <> 'open' then raise exception 'This load is no longer open for bids'; end if;
  if l.company_id = c.id then raise exception 'You cannot bid on your own load'; end if;
  if p_amount is null or p_amount < 1000 then raise exception 'Enter your price in rupees'; end if;
  insert into public.bids (load_id, company_id, placed_by, amount, note)
  values (p_load, c.id, (select auth.uid()), p_amount, left(trim(coalesce(p_note, '')), 300))
  on conflict (load_id, company_id) do update
    set amount = excluded.amount, note = excluded.note, placed_by = excluded.placed_by,
        status = 'active', updated_at = now();
  return public.load_detail(p_load);
end $$;

create or replace function public.withdraw_bid(p_load uuid)
returns json language plpgsql security definer set search_path = '' as $$
begin
  if public.my_trading_company() is null then raise exception 'Only the owner or a manager can do this'; end if;
  update public.bids set status = 'withdrawn', updated_at = now()
   where load_id = p_load and company_id = public.my_company_id() and status = 'active'
     and exists (select 1 from public.loads where id = p_load and status = 'open');
  if not found then raise exception 'There is no open bid to withdraw'; end if;
  return public.load_detail(p_load);
end $$;

-- The poster books a carrier: accepts one bid, declines the others.
create or replace function public.accept_bid(p_bid uuid)
returns json language plpgsql security definer set search_path = '' as $$
declare
  b public.bids;
  l public.loads;
begin
  select * into b from public.bids where id = p_bid;
  select * into l from public.loads where id = b.load_id for update;
  if l.id is null or l.company_id is distinct from public.my_company_id()
     or coalesce(public.my_company_role(), '') not in ('owner', 'manager') then
    raise exception 'Only the company that posted this load can book it';
  end if;
  if l.status <> 'open' then raise exception 'This load is already booked or closed'; end if;
  if b.status <> 'active' then raise exception 'This bid was withdrawn'; end if;
  update public.bids set status = 'accepted', updated_at = now() where id = b.id;
  update public.bids set status = 'declined', updated_at = now() where load_id = l.id and id <> b.id and status = 'active';
  update public.loads set status = 'booked', booked_bid = b.id, booked_at = now() where id = l.id;
  return public.load_detail(l.id);
end $$;

create or replace function public.set_load_status(p_load uuid, p_status text)
returns json language plpgsql security definer set search_path = '' as $$
declare l public.loads;
begin
  select * into l from public.loads where id = p_load for update;
  if l.id is null or l.company_id is distinct from public.my_company_id()
     or coalesce(public.my_company_role(), '') not in ('owner', 'manager') then
    raise exception 'Only the company that posted this load can change it';
  end if;
  if p_status = 'cancelled' and l.status in ('open', 'booked') then
    update public.loads set status = 'cancelled' where id = l.id;
    update public.bids set status = 'declined', updated_at = now() where load_id = l.id and status in ('active', 'accepted');
  elsif p_status = 'delivered' and l.status = 'booked' then
    update public.loads set status = 'delivered', delivered_at = now() where id = l.id;
  else
    raise exception 'This change is not possible now';
  end if;
  return public.load_detail(l.id);
end $$;

revoke execute on function public.my_trading_company() from public, anon;
revoke execute on function public.can_see_load(uuid) from public, anon;
revoke execute on function public.load_summary(public.loads) from public, anon, authenticated;
revoke execute on function public.post_load(text, text, text, text, text, date, text, integer, numeric, text, text, integer, text) from public, anon;
revoke execute on function public.load_board(text, text, text, text) from public, anon;
revoke execute on function public.my_loads() from public, anon;
revoke execute on function public.my_bids() from public, anon;
revoke execute on function public.load_detail(uuid) from public, anon;
revoke execute on function public.place_bid(uuid, integer, text) from public, anon;
revoke execute on function public.withdraw_bid(uuid) from public, anon;
revoke execute on function public.accept_bid(uuid) from public, anon;
revoke execute on function public.set_load_status(uuid, text) from public, anon;
grant execute on function public.my_trading_company() to authenticated;
grant execute on function public.can_see_load(uuid) to authenticated;
grant execute on function public.post_load(text, text, text, text, text, date, text, integer, numeric, text, text, integer, text) to authenticated;
grant execute on function public.load_board(text, text, text, text) to authenticated;
grant execute on function public.my_loads() to authenticated;
grant execute on function public.my_bids() to authenticated;
grant execute on function public.load_detail(uuid) to authenticated;
grant execute on function public.place_bid(uuid, integer, text) to authenticated;
grant execute on function public.withdraw_bid(uuid) to authenticated;
grant execute on function public.accept_bid(uuid) to authenticated;
grant execute on function public.set_load_status(uuid, text) to authenticated;
