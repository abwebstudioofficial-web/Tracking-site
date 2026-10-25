-- Transport Hub, stage 4: money, trust and alerts.
--
-- invoices       created automatically when a load is delivered: the carrier bills the shipper the booked
--                price. The carrier can add extra charges (detention, tolls, labour) while it is unpaid.
--                Payment: the shipper reports it (bank, cash, JazzCash, ...) and the carrier confirms it.
-- ratings        after delivery, the shipper rates the carrier and the carrier rates the shipper (1-5 stars).
--                Every company shows its stars, finished jobs and (carriers) on-time pickup percentage.
-- notifications  alerts for a company's owner and managers: new bids, won/lost, drivers' steps,
--                deliveries, invoices and payments, ratings, verification. Shown under the hub's bell.

-- ---------- ratings ----------
create table public.ratings (
  load_id      uuid not null references public.loads(id) on delete cascade,
  from_company uuid not null references public.companies(id) on delete cascade,
  to_company   uuid not null references public.companies(id) on delete cascade,
  stars        smallint not null check (stars between 1 and 5),
  comment      text not null default '' check (length(comment) <= 300),
  created_at   timestamptz not null default now(),
  primary key (load_id, from_company)
);
create index ratings_to on public.ratings (to_company);
alter table public.ratings enable row level security;
revoke all on table public.ratings from anon, authenticated; -- read through the functions below

-- Stars, reviews, finished jobs and (for carriers) the share of jobs where the truck reached the
-- pickup by the end of the pickup day (Pakistan time).
create or replace function public.company_rating(p_company uuid)
returns json language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'stars', (select round(avg(stars)::numeric, 1) from public.ratings where to_company = p_company),
    'reviews', (select count(*) from public.ratings where to_company = p_company),
    'jobs', (select count(*) from public.loads l
              where l.status = 'delivered' and (l.company_id = p_company
                 or exists (select 1 from public.bids b where b.id = l.booked_bid and b.company_id = p_company))),
    'on_time', (select round(100.0 * avg(case when x.first_pickup <= ((x.pickup_date + 1)::timestamp at time zone 'Asia/Karachi') then 1 else 0 end))
                  from (select l.pickup_date,
                               (select min((t.steps->'at_pickup'->>'at')::timestamptz) from public.trips t
                                 where t.load_id = l.id and t.steps ? 'at_pickup') first_pickup
                          from public.loads l join public.bids b on b.id = l.booked_bid
                         where b.company_id = p_company and l.status = 'delivered') x
                 where x.first_pickup is not null));
$$;

-- ---------- notifications ----------
create table public.notifications (
  id         bigint generated always as identity primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  kind       text not null,
  title      text not null,
  body       text not null default '',
  load_id    uuid references public.loads(id) on delete cascade,
  invoice_id uuid,
  created_at timestamptz not null default now()
);
create index notifications_company on public.notifications (company_id, created_at desc);
alter table public.profiles add column notifications_seen_at timestamptz;
alter table public.notifications enable row level security;
revoke all on table public.notifications from anon;
revoke insert, update, delete on table public.notifications from authenticated;
grant select on table public.notifications to authenticated;
create policy "Owners and managers read their alerts" on public.notifications for select to authenticated using (
  company_id = (select public.my_company_id()) and (select public.my_company_role()) in ('owner', 'manager'));
alter publication supabase_realtime add table public.notifications;

create or replace function public.notify(p_company uuid, p_kind text, p_title text, p_body text,
                                         p_load uuid default null, p_invoice uuid default null)
returns void language sql security definer set search_path = '' as $$
  insert into public.notifications (company_id, kind, title, body, load_id, invoice_id)
  select p_company, p_kind, left(p_title, 140), left(coalesce(p_body, ''), 300), p_load, p_invoice
   where p_company is not null;
$$;
create or replace function public.rs(n bigint)
returns text language sql immutable set search_path = '' as $$ select 'Rs ' || to_char(n, 'FM999,999,999,999'); $$;
create or replace function public.route_text(p_load uuid)
returns text language sql stable security definer set search_path = '' as $$
  select pickup_city || ' → ' || drop_city from public.loads where id = p_load;
$$;

-- My alerts (newest first) and how many are new since I last opened them.
create or replace function public.my_notifications()
returns json language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'unseen', (select count(*) from public.notifications n
                where n.company_id = public.my_company_id()
                  and n.created_at > coalesce((select notifications_seen_at from public.profiles where id = (select auth.uid())), '-infinity')),
    'items', coalesce((select json_agg(json_build_object('id', n.id, 'kind', n.kind, 'title', n.title, 'body', n.body,
                                                         'load_id', n.load_id, 'invoice_id', n.invoice_id, 'created_at', n.created_at)
                                       order by n.created_at desc, n.id desc)
                         from (select * from public.notifications where company_id = public.my_company_id()
                                order by created_at desc, id desc limit 50) n), '[]'::json))
   where coalesce(public.my_company_role(), '') in ('owner', 'manager');
$$;
create or replace function public.mark_notifications_seen()
returns void language sql security definer set search_path = '' as $$
  update public.profiles set notifications_seen_at = now() where id = (select auth.uid());
$$;

-- ---------- invoices ----------
create sequence public.invoice_number;
create table public.invoices (
  id                uuid primary key default gen_random_uuid(),
  number            text not null unique,
  load_id           uuid not null unique references public.loads(id) on delete cascade,
  carrier_id        uuid not null references public.companies(id) on delete cascade,
  shipper_id        uuid not null references public.companies(id) on delete cascade,
  freight           integer not null check (freight >= 0),
  extras            jsonb not null default '[]'::jsonb, -- [{label, amount}]
  status            text not null default 'unpaid' check (status in ('unpaid', 'paid_reported', 'paid')),
  paid_method       text check (paid_method in ('bank', 'cash', 'jazzcash', 'easypaisa', 'cheque', 'other')),
  paid_ref          text check (length(paid_ref) <= 80),
  paid_reported_at  timestamptz,
  paid_at           timestamptz,
  due_date          date not null,
  created_at        timestamptz not null default now()
);
create index invoices_carrier on public.invoices (carrier_id, created_at desc);
create index invoices_shipper on public.invoices (shipper_id, created_at desc);
alter table public.invoices enable row level security;
revoke all on table public.invoices from anon;
revoke insert, update, delete on table public.invoices from authenticated;
grant select on table public.invoices to authenticated;
create policy "Both companies and admins read an invoice" on public.invoices for select to authenticated using (
  (select public.is_admin())
  or ((carrier_id = (select public.my_company_id()) or shipper_id = (select public.my_company_id()))
      and (select public.my_company_role()) in ('owner', 'manager')));
alter publication supabase_realtime add table public.invoices;

create or replace function public.invoice_total(i public.invoices)
returns bigint language sql immutable set search_path = '' as $$
  select i.freight + coalesce((select sum((e->>'amount')::bigint) from jsonb_array_elements(i.extras) e), 0);
$$;

-- A delivered load gets its invoice (due in 15 days).
create or replace function public.invoice_on_delivery()
returns trigger language plpgsql security definer set search_path = '' as $$
declare b public.bids;
begin
  if new.status = 'delivered' and old.status is distinct from 'delivered' and new.booked_bid is not null then
    select * into b from public.bids where id = new.booked_bid;
    insert into public.invoices (number, load_id, carrier_id, shipper_id, freight, due_date)
    values ('TH-' || to_char(now() at time zone 'Asia/Karachi', 'YYYY') || '-' || lpad(nextval('public.invoice_number')::text, 5, '0'),
            new.id, b.company_id, new.company_id, b.amount, (now() at time zone 'Asia/Karachi')::date + 15)
    on conflict (load_id) do nothing;
  end if;
  return new;
end $$;
create trigger loads_invoice_on_delivery after update of status on public.loads
  for each row execute function public.invoice_on_delivery();

create or replace function public.invoice_row(i public.invoices)
returns json language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'id', i.id, 'number', i.number, 'load_id', i.load_id, 'status', i.status, 'freight', i.freight, 'extras', i.extras,
    'total', public.invoice_total(i), 'due_date', i.due_date, 'created_at', i.created_at,
    'paid_method', i.paid_method, 'paid_ref', i.paid_ref, 'paid_reported_at', i.paid_reported_at, 'paid_at', i.paid_at,
    'direction', case when i.carrier_id = public.my_company_id() then 'receivable' else 'payable' end,
    'other', (select c.name from public.companies c
               where c.id = case when i.carrier_id = public.my_company_id() then i.shipper_id else i.carrier_id end),
    'route', public.route_text(i.load_id));
$$;

create or replace function public.my_invoices()
returns json language plpgsql stable security definer set search_path = '' as $$
declare me uuid := public.my_company_id();
begin
  if coalesce(public.my_company_role(), '') not in ('owner', 'manager') then raise exception 'Only the owner or a manager can see invoices'; end if;
  return json_build_object(
    'to_receive', (select coalesce(sum(public.invoice_total(i)), 0) from public.invoices i where i.carrier_id = me and i.status <> 'paid'),
    'to_pay', (select coalesce(sum(public.invoice_total(i)), 0) from public.invoices i where i.shipper_id = me and i.status <> 'paid'),
    'overdue', (select count(*) from public.invoices i where (i.carrier_id = me or i.shipper_id = me) and i.status <> 'paid'
                   and i.due_date < (now() at time zone 'Asia/Karachi')::date),
    'items', coalesce((select json_agg(public.invoice_row(i) order by (i.status = 'paid'), i.created_at desc)
                         from public.invoices i where i.carrier_id = me or i.shipper_id = me), '[]'::json));
end $$;

-- Everything the printable invoice shows.
create or replace function public.invoice_detail(p_invoice uuid)
returns json language plpgsql stable security definer set search_path = '' as $$
declare
  i public.invoices;
  l public.loads;
  staff boolean := coalesce(public.my_company_role(), '') in ('owner', 'manager');
begin
  select * into i from public.invoices where id = p_invoice;
  if i.id is null or not (public.is_admin() or (staff and public.my_company_id() in (i.carrier_id, i.shipper_id))) then
    raise exception 'Invoice not found';
  end if;
  select * into l from public.loads where id = i.load_id;
  return json_build_object(
    'invoice', public.invoice_row(i),
    'carrier', (select json_build_object('name', name, 'city', city, 'address', address, 'phone', phone, 'ntn', ntn) from public.companies where id = i.carrier_id),
    'shipper', (select json_build_object('name', name, 'city', city, 'address', address, 'phone', phone, 'ntn', ntn) from public.companies where id = i.shipper_id),
    'load', json_build_object('trade', l.trade, 'pickup_city', l.pickup_city, 'pickup_place', l.pickup_place, 'drop_city', l.drop_city,
                              'drop_place', l.drop_place, 'pickup_date', l.pickup_date, 'equipment', l.equipment, 'trucks', l.trucks,
                              'cargo', l.cargo, 'weight_tons', l.weight_tons, 'container_no', l.container_no, 'delivered_at', l.delivered_at),
    'drivers', coalesce((select json_agg(json_build_object('name', p.name, 'delivered_at', t.steps->'delivered'->>'at') order by t.created_at)
                           from public.trips t join public.profiles p on p.id = t.driver_id
                          where t.load_id = l.id and t.status = 'delivered'), '[]'::json),
    'can_edit', staff and i.carrier_id = public.my_company_id() and i.status = 'unpaid',
    'can_report', staff and i.shipper_id = public.my_company_id() and i.status = 'unpaid',
    'can_confirm', staff and i.carrier_id = public.my_company_id() and i.status <> 'paid');
end $$;

create or replace function public.my_carrier_invoice(p_invoice uuid)
returns public.invoices language plpgsql security definer set search_path = '' as $$
declare i public.invoices;
begin
  select * into i from public.invoices where id = p_invoice for update;
  if i.id is null or i.carrier_id is distinct from public.my_company_id()
     or coalesce(public.my_company_role(), '') not in ('owner', 'manager') then
    raise exception 'Only the carrier can change this invoice';
  end if;
  return i;
end $$;

create or replace function public.invoice_add_charge(p_invoice uuid, p_label text, p_amount integer)
returns json language plpgsql security definer set search_path = '' as $$
declare i public.invoices := public.my_carrier_invoice(p_invoice);
begin
  if i.status <> 'unpaid' then raise exception 'Charges can only be added before payment'; end if;
  if length(trim(coalesce(p_label, ''))) < 2 then raise exception 'Write what the charge is for'; end if;
  if p_amount is null or p_amount < 1 or p_amount > 10000000 then raise exception 'Enter the amount in rupees'; end if;
  if jsonb_array_length(i.extras) >= 10 then raise exception 'At most 10 extra charges'; end if;
  update public.invoices set extras = extras || jsonb_build_array(jsonb_build_object('label', left(trim(p_label), 80), 'amount', p_amount))
   where id = i.id;
  return public.invoice_detail(i.id);
end $$;

create or replace function public.invoice_remove_charge(p_invoice uuid, p_index integer)
returns json language plpgsql security definer set search_path = '' as $$
declare i public.invoices := public.my_carrier_invoice(p_invoice);
begin
  if i.status <> 'unpaid' then raise exception 'Charges can only be changed before payment'; end if;
  update public.invoices set extras = extras - p_index where id = i.id;
  return public.invoice_detail(i.id);
end $$;

-- The shipper says it has paid; the carrier confirms (or says it hasn't arrived).
create or replace function public.invoice_report_paid(p_invoice uuid, p_method text, p_ref text default '')
returns json language plpgsql security definer set search_path = '' as $$
declare i public.invoices;
begin
  select * into i from public.invoices where id = p_invoice for update;
  if i.id is null or i.shipper_id is distinct from public.my_company_id()
     or coalesce(public.my_company_role(), '') not in ('owner', 'manager') then
    raise exception 'Only the shipper can report this payment';
  end if;
  if i.status <> 'unpaid' then raise exception 'This invoice is already marked as paid'; end if;
  if p_method not in ('bank', 'cash', 'jazzcash', 'easypaisa', 'cheque', 'other') then raise exception 'Choose how you paid'; end if;
  update public.invoices set status = 'paid_reported', paid_method = p_method, paid_ref = left(trim(coalesce(p_ref, '')), 80),
                             paid_reported_at = now() where id = i.id;
  return public.invoice_detail(i.id);
end $$;

create or replace function public.invoice_confirm_paid(p_invoice uuid, p_received boolean default true)
returns json language plpgsql security definer set search_path = '' as $$
declare i public.invoices := public.my_carrier_invoice(p_invoice);
begin
  if i.status = 'paid' then raise exception 'This invoice is already paid'; end if;
  if p_received then
    update public.invoices set status = 'paid', paid_at = now() where id = i.id;
  else
    if i.status <> 'paid_reported' then raise exception 'Nothing to reject'; end if;
    update public.invoices set status = 'unpaid', paid_reported_at = null where id = i.id;
  end if;
  return public.invoice_detail(i.id);
end $$;

-- ---------- rating a finished load ----------
create or replace function public.rate_load(p_load uuid, p_stars integer, p_comment text default '')
returns json language plpgsql security definer set search_path = '' as $$
declare
  l public.loads;
  carrier uuid;
  me uuid := public.my_company_id();
  target uuid;
begin
  if coalesce(public.my_company_role(), '') not in ('owner', 'manager') then raise exception 'Only the owner or a manager can rate'; end if;
  select * into l from public.loads where id = p_load;
  select company_id into carrier from public.bids where id = l.booked_bid;
  if l.status <> 'delivered' then raise exception 'You can rate once the load is delivered'; end if;
  target := case when me = l.company_id then carrier when me = carrier then l.company_id end;
  if target is null then raise exception 'Only the shipper and the carrier of this load can rate it'; end if;
  if p_stars not between 1 and 5 then raise exception 'Choose 1 to 5 stars'; end if;
  insert into public.ratings (load_id, from_company, to_company, stars, comment)
  values (l.id, me, target, p_stars, left(trim(coalesce(p_comment, '')), 300))
  on conflict (load_id, from_company) do update set stars = excluded.stars, comment = excluded.comment, created_at = now();
  return public.load_detail(l.id);
end $$;

-- ---------- loads and bids now carry ratings ----------
create or replace function public.load_summary(l public.loads)
returns json language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'id', l.id, 'trade', l.trade, 'pickup_city', l.pickup_city, 'pickup_place', l.pickup_place,
    'drop_city', l.drop_city, 'drop_place', l.drop_place, 'pickup_date', l.pickup_date,
    'equipment', l.equipment, 'trucks', l.trucks, 'weight_tons', l.weight_tons, 'cargo', l.cargo,
    'target_price', l.target_price, 'status', l.status, 'created_at', l.created_at,
    'mine', l.company_id = public.my_company_id(),
    'poster', (select json_build_object('name', c.name, 'city', c.city, 'kind', c.kind, 'rating', public.company_rating(c.id))
                 from public.companies c where c.id = l.company_id),
    'bids', (select count(*) from public.bids b where b.load_id = l.id and b.status = 'active'),
    'lowest', (select min(amount) from public.bids b where b.load_id = l.id and b.status = 'active'),
    'my_bid', (select json_build_object('amount', b.amount, 'status', b.status) from public.bids b
                where b.load_id = l.id and b.company_id = public.my_company_id()),
    'booked_amount', (select b.amount from public.bids b where b.id = l.booked_bid),
    'booked_with', (select c.name from public.bids b join public.companies c on c.id = b.company_id where b.id = l.booked_bid));
$$;

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
               'company', json_build_object('name', c.name, 'city', c.city, 'kind', c.kind, 'fleet_size', c.fleet_size,
                                            'rating', public.company_rating(c.id)))
             order by (b.status = 'accepted') desc, (b.status = 'active') desc, b.amount)
        from public.bids b join public.companies c on c.id = b.company_id
       where b.load_id = l.id and (open_view or b.company_id = public.my_company_id())
         and (b.status in ('active', 'accepted') or b.company_id = public.my_company_id() or mine)), '[]'::json),
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
    end,
    -- After delivery: my rating of the other side (if any), theirs of me, and the invoice.
    'rating', case when l.status = 'delivered' and (mine or winner = public.my_company_id()) then json_build_object(
      'can_rate', coalesce(public.my_company_role(), '') in ('owner', 'manager'),
      'other', (select name from public.companies where id = case when mine then winner else l.company_id end),
      'mine', (select json_build_object('stars', stars, 'comment', comment) from public.ratings
                where load_id = l.id and from_company = public.my_company_id()),
      'theirs', (select json_build_object('stars', stars, 'comment', comment) from public.ratings
                  where load_id = l.id and to_company = public.my_company_id())) end,
    'invoice_id', case when mine or winner = public.my_company_id() or public.is_admin()
                       then (select id from public.invoices where load_id = l.id) end);
end $$;

-- ---------- alerts from what happens ----------
create or replace function public.alert_on_bid()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  l public.loads;
  bidder text;
begin
  select * into l from public.loads where id = new.load_id;
  select name into bidder from public.companies where id = new.company_id;
  if new.status = 'active' and (tg_op = 'INSERT' or old.status <> 'active' or old.amount <> new.amount) then
    perform public.notify(l.company_id, 'bid',
      case when tg_op = 'UPDATE' and old.status = 'active' then 'Bid changed: ' else 'New bid: ' end || public.rs(new.amount),
      bidder || ' · ' || public.route_text(l.id), l.id);
  elsif tg_op = 'UPDATE' and new.status = 'accepted' and old.status <> 'accepted' then
    perform public.notify(new.company_id, 'won', 'You won a load: ' || public.rs(new.amount),
      public.route_text(l.id) || '. Assign your drivers now.', l.id);
  elsif tg_op = 'UPDATE' and new.status = 'declined' and old.status = 'active' and l.status <> 'cancelled' then
    perform public.notify(new.company_id, 'lost', 'Another carrier was booked', public.route_text(l.id), l.id);
  end if;
  return new;
end $$;
create trigger bids_alert after insert or update on public.bids for each row execute function public.alert_on_bid();

create or replace function public.alert_on_load()
returns trigger language plpgsql security definer set search_path = '' as $$
declare carrier uuid;
begin
  select company_id into carrier from public.bids where id = new.booked_bid;
  if new.status = 'cancelled' and old.status = 'booked' then
    perform public.notify(carrier, 'cancelled', 'Load cancelled by the shipper', public.route_text(new.id), new.id);
  elsif new.status = 'delivered' and old.status <> 'delivered' then
    perform public.notify(new.company_id, 'delivered', 'Delivered ✓ · rate the carrier', public.route_text(new.id), new.id);
    perform public.notify(carrier, 'delivered', 'Delivered ✓ · invoice ready', public.route_text(new.id), new.id);
  end if;
  return new;
end $$;
create trigger loads_alert after update of status on public.loads for each row execute function public.alert_on_load();

create or replace function public.alert_on_trip()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  shipper uuid;
  driver text;
begin
  select company_id into shipper from public.loads where id = new.load_id;
  select name into driver from public.profiles where id = new.driver_id;
  if tg_op = 'INSERT' then
    perform public.notify(shipper, 'driver', 'Driver assigned: ' || driver, public.route_text(new.load_id), new.load_id);
  elsif new.status <> old.status and new.status in ('at_pickup', 'loaded', 'at_drop', 'delivered') then
    perform public.notify(shipper, 'step',
      driver || case new.status when 'at_pickup' then ' arrived at pickup' when 'loaded' then ' is loaded and on the way'
                                when 'at_drop' then ' arrived at the destination' else ' delivered ✓' end,
      public.route_text(new.load_id), new.load_id);
  end if;
  return new;
end $$;
create trigger trips_alert after insert or update of status on public.trips for each row execute function public.alert_on_trip();

create or replace function public.alert_on_invoice()
returns trigger language plpgsql security definer set search_path = '' as $$
declare carrier text;
begin
  select name into carrier from public.companies where id = new.carrier_id;
  if tg_op = 'INSERT' then
    perform public.notify(new.shipper_id, 'invoice', 'Invoice ' || new.number || ' from ' || carrier,
      public.rs(public.invoice_total(new)) || ' · due ' || to_char(new.due_date, 'DD Mon'), new.load_id, new.id);
  elsif new.status = 'paid_reported' and old.status = 'unpaid' then
    perform public.notify(new.carrier_id, 'payment', 'Payment reported: ' || new.number,
      public.rs(public.invoice_total(new)) || ' · please confirm you received it', new.load_id, new.id);
  elsif new.status = 'paid' and old.status <> 'paid' then
    perform public.notify(new.shipper_id, 'paid', 'Payment received ✓ ' || new.number, carrier || ' confirmed it', new.load_id, new.id);
  elsif new.status = 'unpaid' and old.status = 'paid_reported' then
    perform public.notify(new.shipper_id, 'payment', 'Payment not received: ' || new.number, carrier || ' says it has not arrived', new.load_id, new.id);
  end if;
  return new;
end $$;
create trigger invoices_alert after insert or update of status on public.invoices for each row execute function public.alert_on_invoice();

create or replace function public.alert_on_rating()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.notify(new.to_company, 'rated',
    (select name from public.companies where id = new.from_company) || ' rated you ' || repeat('★', new.stars),
    coalesce(nullif(new.comment, ''), public.route_text(new.load_id)), new.load_id);
  return new;
end $$;
create trigger ratings_alert after insert on public.ratings for each row execute function public.alert_on_rating();

create or replace function public.alert_on_company()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'verified' and old.status <> 'verified' then
    perform public.notify(new.id, 'verified', 'Your company is verified ✓', 'You can now use the load board.');
  elsif new.status = 'rejected' and old.status <> 'rejected' then
    perform public.notify(new.id, 'rejected', 'Your company needs changes', new.status_note);
  end if;
  return new;
end $$;
create trigger companies_alert after update of status on public.companies for each row execute function public.alert_on_company();

-- ---------- permissions ----------
revoke execute on function public.company_rating(uuid) from public, anon;
revoke execute on function public.notify(uuid, text, text, text, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.route_text(uuid) from public, anon, authenticated;
revoke execute on function public.my_notifications() from public, anon;
revoke execute on function public.mark_notifications_seen() from public, anon;
revoke execute on function public.invoice_on_delivery() from public, anon, authenticated;
revoke execute on function public.invoice_row(public.invoices) from public, anon, authenticated;
revoke execute on function public.my_invoices() from public, anon;
revoke execute on function public.invoice_detail(uuid) from public, anon;
revoke execute on function public.my_carrier_invoice(uuid) from public, anon, authenticated;
revoke execute on function public.invoice_add_charge(uuid, text, integer) from public, anon;
revoke execute on function public.invoice_remove_charge(uuid, integer) from public, anon;
revoke execute on function public.invoice_report_paid(uuid, text, text) from public, anon;
revoke execute on function public.invoice_confirm_paid(uuid, boolean) from public, anon;
revoke execute on function public.rate_load(uuid, integer, text) from public, anon;
revoke execute on function public.alert_on_bid() from public, anon, authenticated;
revoke execute on function public.alert_on_load() from public, anon, authenticated;
revoke execute on function public.alert_on_trip() from public, anon, authenticated;
revoke execute on function public.alert_on_invoice() from public, anon, authenticated;
revoke execute on function public.alert_on_rating() from public, anon, authenticated;
revoke execute on function public.alert_on_company() from public, anon, authenticated;
grant execute on function public.company_rating(uuid) to authenticated;
grant execute on function public.my_notifications() to authenticated;
grant execute on function public.mark_notifications_seen() to authenticated;
grant execute on function public.my_invoices() to authenticated;
grant execute on function public.invoice_detail(uuid) to authenticated;
grant execute on function public.invoice_add_charge(uuid, text, integer) to authenticated;
grant execute on function public.invoice_remove_charge(uuid, integer) to authenticated;
grant execute on function public.invoice_report_paid(uuid, text, text) to authenticated;
grant execute on function public.invoice_confirm_paid(uuid, boolean) to authenticated;
grant execute on function public.rate_load(uuid, integer, text) to authenticated;
