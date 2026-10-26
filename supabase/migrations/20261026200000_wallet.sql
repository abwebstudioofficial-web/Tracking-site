-- Transport Hub wallet: carriers, brokers and dispatchers keep money with Transport Hub and the
-- per-trip fee is taken from it automatically when a trip is delivered.
--
-- Adding money (JazzCash, no merchant gateway needed): the company sends money from its JazzCash
-- app to Transport Hub's JazzCash business account (number / Till ID shown in the wallet), then
-- enters the amount, the transaction ID (TID) and a screenshot. A Transport Hub admin checks it in
-- the JazzCash Business app and approves it; then it counts in the balance.
--
-- wallet_entries     every change to a wallet: deposit (+, waits for approval), fee (−, on delivery),
--                    adjust (+/−, by an admin, e.g. cash received or a correction).
-- wallet-proofs      storage for deposit screenshots, wallet-proofs/<company id>/<file>.
-- platform_settings  pay_jazzcash: { name, number, till_id } shown to companies.
-- Bidding needs enough balance for the fee on that load (fee per trip × trucks).

create table public.wallet_entries (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  kind        text not null check (kind in ('deposit', 'fee', 'adjust')),
  amount      integer not null check (amount <> 0), -- + adds to the wallet, − takes from it
  status      text not null default 'approved' check (status in ('pending', 'approved', 'rejected')),
  method      text not null default '' check (method in ('', 'jazzcash')),
  tid         text not null default '' check (length(tid) <= 40),
  proof_path  text,
  load_id     uuid references public.loads(id) on delete set null,
  note        text not null default '' check (length(note) <= 200),
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  decided_by  uuid references public.profiles(id) on delete set null,
  decided_at  timestamptz
);
create index wallet_entries_company on public.wallet_entries (company_id, created_at desc);
create index wallet_entries_pending on public.wallet_entries (created_at) where status = 'pending';
-- One JazzCash transaction can only be claimed once.
create unique index wallet_entries_tid on public.wallet_entries (upper(tid)) where kind = 'deposit' and status <> 'rejected';
alter table public.wallet_entries enable row level security;
revoke all on table public.wallet_entries from anon, authenticated; -- read and written through the functions below

insert into public.platform_settings (key, value)
values ('pay_jazzcash', '{"name": "Mirza Talal Baig", "number": "01008413087", "till_id": "984864495"}')
on conflict (key) do nothing;

create or replace function public.wallet_balance(p_company uuid)
returns bigint language sql stable security definer set search_path = '' as $$
  select coalesce(sum(amount), 0) from public.wallet_entries where company_id = p_company and status = 'approved';
$$;

create or replace function public.pay_info()
returns json language sql stable security definer set search_path = '' as $$
  select json_build_object('jazzcash', coalesce((select value from public.platform_settings where key = 'pay_jazzcash'), '{}'::jsonb));
$$;

create or replace function public.wallet_row(w public.wallet_entries)
returns json language sql stable security definer set search_path = '' as $$
  select json_build_object('id', w.id, 'kind', w.kind, 'amount', w.amount, 'status', w.status, 'method', w.method,
    'tid', w.tid, 'has_proof', w.proof_path is not null, 'proof_path', w.proof_path, 'note', w.note,
    'created_at', w.created_at, 'decided_at', w.decided_at,
    'route', case when w.load_id is not null then public.route_text(w.load_id) end,
    'by', (select name from public.profiles where id = w.created_by),
    'company', (select json_build_object('id', c.id, 'name', c.name, 'kind', c.kind, 'city', c.city, 'phone', c.phone)
                  from public.companies c where c.id = w.company_id));
$$;

-- My company's wallet (owner / managers of a carrier, broker or dispatcher).
create or replace function public.my_wallet()
returns json language plpgsql stable security definer set search_path = '' as $$
declare c public.companies;
begin
  select * into c from public.companies where id = public.my_company_id();
  if c.id is null or coalesce(public.my_company_role(), '') not in ('owner', 'manager') then
    raise exception 'Only the owner or a manager can see the wallet';
  end if;
  if c.kind not in ('carrier', 'broker', 'dispatcher') then raise exception 'Shippers don''t have a wallet'; end if;
  return json_build_object(
    'balance', public.wallet_balance(c.id),
    'pending', (select coalesce(sum(amount), 0) from public.wallet_entries where company_id = c.id and status = 'pending'),
    'fee_per_trip', public.platform_fee(),
    'pay', public.pay_info(),
    'items', coalesce((select json_agg(public.wallet_row(w) order by w.created_at desc)
                         from (select * from public.wallet_entries where company_id = c.id order by created_at desc limit 200) w), '[]'::json));
end $$;

-- "I sent money by JazzCash": waits for an admin to check it.
create or replace function public.wallet_deposit(p_amount integer, p_tid text, p_proof_path text default null)
returns json language plpgsql security definer set search_path = '' as $$
declare
  c public.companies;
  clean_tid text := upper(regexp_replace(coalesce(p_tid, ''), '\s', '', 'g'));
  a record;
begin
  select * into c from public.companies where id = public.my_company_id();
  if c.id is null or coalesce(public.my_company_role(), '') not in ('owner', 'manager') then
    raise exception 'Only the owner or a manager can add money';
  end if;
  if c.kind not in ('carrier', 'broker', 'dispatcher') then raise exception 'Shippers don''t have a wallet'; end if;
  if p_amount is null or p_amount < 100 or p_amount > 1000000 then raise exception 'Enter the amount you sent (Rs 100 to Rs 1,000,000)'; end if;
  if clean_tid !~ '^[A-Z0-9]{6,30}$' then raise exception 'Enter the transaction ID (TID) from the JazzCash message'; end if;
  if p_proof_path is not null and p_proof_path not like c.id::text || '/%' then raise exception 'Upload the screenshot again'; end if;
  if exists (select 1 from public.wallet_entries where kind = 'deposit' and status <> 'rejected' and upper(tid) = clean_tid) then
    raise exception 'This transaction ID has already been used';
  end if;
  insert into public.wallet_entries (company_id, kind, amount, status, method, tid, proof_path, created_by)
  values (c.id, 'deposit', p_amount, 'pending', 'jazzcash', clean_tid, p_proof_path, (select auth.uid()));
  -- Tell the admins' phones there is a payment to check.
  for a in select id from public.profiles where role = 'admin' loop
    perform public.send_push(null, a.id, 'Wallet top-up to check', c.name || ' · ' || public.rs(p_amount) || ' · TID ' || clean_tid, '/hub');
  end loop;
  return public.my_wallet();
end $$;

-- Admins: payments to check, every wallet's balance, and the JazzCash details shown to companies.
create or replace function public.admin_wallets()
returns json language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  return json_build_object(
    'pay', public.pay_info(),
    'pending', coalesce((select json_agg(public.wallet_row(w) order by w.created_at)
                           from public.wallet_entries w where w.status = 'pending'), '[]'::json),
    'wallets', coalesce((select json_agg(json_build_object('id', c.id, 'name', c.name, 'kind', c.kind, 'city', c.city, 'phone', c.phone,
                                          'balance', public.wallet_balance(c.id)) order by public.wallet_balance(c.id), c.name)
                           from public.companies c where c.kind in ('carrier', 'broker', 'dispatcher')), '[]'::json),
    'recent', coalesce((select json_agg(public.wallet_row(w) order by w.created_at desc)
                          from (select * from public.wallet_entries where status <> 'pending' order by created_at desc limit 100) w), '[]'::json));
end $$;

create or replace function public.admin_decide_deposit(p_entry uuid, p_approve boolean, p_note text default '')
returns json language plpgsql security definer set search_path = '' as $$
declare w public.wallet_entries;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  update public.wallet_entries
     set status = case when p_approve then 'approved' else 'rejected' end,
         note = left(trim(coalesce(p_note, '')), 200), decided_by = (select auth.uid()), decided_at = now()
   where id = p_entry and status = 'pending'
  returning * into w;
  if w.id is null then raise exception 'This payment was already checked'; end if;
  if p_approve then
    perform public.notify(w.company_id, 'wallet', 'Money added to your wallet: ' || public.rs(w.amount),
      'JazzCash TID ' || w.tid || ' · balance ' || public.rs(public.wallet_balance(w.company_id)));
  else
    perform public.notify(w.company_id, 'wallet', 'Top-up not approved: ' || public.rs(w.amount),
      'JazzCash TID ' || w.tid || coalesce(nullif(' · ' || w.note, ' · '), ''));
  end if;
  return public.admin_wallets();
end $$;

-- Admins: add or take money by hand (cash received, a correction). Amount + or −.
create or replace function public.admin_wallet_adjust(p_company uuid, p_amount integer, p_note text)
returns json language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if p_amount is null or p_amount = 0 or abs(p_amount) > 1000000 then raise exception 'Enter an amount (use − to take money out)'; end if;
  if length(trim(coalesce(p_note, ''))) = 0 then raise exception 'Write the reason (e.g. cash received)'; end if;
  if not exists (select 1 from public.companies where id = p_company and kind in ('carrier', 'broker', 'dispatcher')) then
    raise exception 'Company not found';
  end if;
  insert into public.wallet_entries (company_id, kind, amount, note, created_by, decided_by, decided_at)
  values (p_company, 'adjust', p_amount, left(trim(p_note), 200), (select auth.uid()), (select auth.uid()), now());
  perform public.notify(p_company, 'wallet',
    case when p_amount > 0 then 'Money added to your wallet: ' else 'Money taken from your wallet: ' end || public.rs(abs(p_amount)),
    trim(p_note) || ' · balance ' || public.rs(public.wallet_balance(p_company)));
  return public.admin_wallets();
end $$;

create or replace function public.admin_set_pay_info(p_name text, p_number text, p_till_id text)
returns json language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if length(trim(coalesce(p_name, ''))) < 2 then raise exception 'Enter the account name'; end if;
  if coalesce(p_number, '') !~ '^[0-9 ]{10,14}$' then raise exception 'Enter the JazzCash account number'; end if;
  if coalesce(p_till_id, '') !~ '^[0-9]{0,12}$' then raise exception 'The Till ID is numbers only'; end if;
  insert into public.platform_settings (key, value, updated_at, updated_by)
  values ('pay_jazzcash', jsonb_build_object('name', left(trim(p_name), 80), 'number', replace(p_number, ' ', ''), 'till_id', coalesce(p_till_id, '')),
          now(), (select auth.uid()))
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by;
  return public.admin_wallets();
end $$;

-- The fee is taken from the wallet when a load is delivered (it can go below zero; bidding needs
-- enough balance, so normally it doesn't).
create or replace function public.fee_on_delivery()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  carrier uuid;
  n integer;
  fee integer := public.platform_fee();
  fee_id uuid;
begin
  if new.status = 'delivered' and old.status is distinct from 'delivered' and new.booked_bid is not null then
    select company_id into carrier from public.bids where id = new.booked_bid;
    select count(*) into n from public.trips where load_id = new.id and status = 'delivered';
    if n = 0 then n := new.trucks; end if; -- marked delivered without using the driver app
    insert into public.platform_fees (company_id, load_id, trips, fee_per_trip, amount, status, note, paid_at)
    values (carrier, new.id, n, fee, n * fee, case when fee = 0 then 'waived' else 'paid' end,
            case when fee = 0 then '' else 'From wallet' end, case when fee = 0 then null else now() end)
    on conflict (load_id) do nothing
    returning id into fee_id;
    if fee_id is not null and fee > 0 then
      insert into public.wallet_entries (company_id, kind, amount, load_id, note)
      values (carrier, 'fee', -(n * fee), new.id, n || ' trip' || case when n > 1 then 's' else '' end || ' × ' || public.rs(fee));
      perform public.notify(carrier, 'fee', 'Transport Hub fee: ' || public.rs(n * fee) || ' from your wallet',
        public.route_text(new.id) || ' · balance ' || public.rs(public.wallet_balance(carrier)), new.id);
    end if;
  end if;
  return new;
end $$;

-- Bidding needs enough in the wallet for this load's fee.
create or replace function public.place_bid(p_load uuid, p_amount integer, p_note text default '')
returns json language plpgsql security definer set search_path = '' as $$
declare
  c public.companies := public.my_trading_company();
  l public.loads;
  need bigint;
begin
  if c.id is null then raise exception 'Only verified companies can bid (owner or manager)'; end if;
  if c.kind not in ('carrier', 'broker', 'dispatcher') then raise exception 'Only carriers, brokers and dispatchers bid on loads'; end if;
  select * into l from public.loads where id = p_load for update;
  if l.id is null or l.status <> 'open' then raise exception 'This load is no longer open for bids'; end if;
  if l.company_id = c.id then raise exception 'You cannot bid on your own load'; end if;
  if p_amount is null or p_amount < 1000 then raise exception 'Enter your price in rupees'; end if;
  need := public.platform_fee()::bigint * l.trucks;
  if need > 0 and public.wallet_balance(c.id) < need then
    raise exception 'Add money to your wallet first: this load''s Transport Hub fee is % and your balance is %. Open the Wallet tab.',
      public.rs(need), public.rs(public.wallet_balance(c.id));
  end if;
  insert into public.bids (load_id, company_id, placed_by, amount, note)
  values (p_load, c.id, (select auth.uid()), p_amount, left(trim(coalesce(p_note, '')), 300))
  on conflict (load_id, company_id) do update
    set amount = excluded.amount, note = excluded.note, placed_by = excluded.placed_by,
        status = 'active', updated_at = now();
  return public.load_detail(p_load);
end $$;

-- Deposit screenshots: wallet-proofs/<company id>/<file>.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('wallet-proofs', 'wallet-proofs', false, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'])
on conflict (id) do nothing;
create policy "Company staff upload wallet proofs" on storage.objects for insert to authenticated with check (
  bucket_id = 'wallet-proofs' and (storage.foldername(name))[1] = (select public.my_company_id())::text
  and (select public.my_company_role()) in ('owner', 'manager'));
create policy "Company staff and admins see wallet proofs" on storage.objects for select to authenticated using (
  bucket_id = 'wallet-proofs' and (
    ((storage.foldername(name))[1] = (select public.my_company_id())::text and (select public.my_company_role()) in ('owner', 'manager'))
    or (select public.is_admin())));

revoke execute on function public.wallet_balance(uuid) from public, anon, authenticated;
revoke execute on function public.wallet_row(public.wallet_entries) from public, anon, authenticated;
revoke execute on function public.pay_info() from public, anon;
revoke execute on function public.my_wallet() from public, anon;
revoke execute on function public.wallet_deposit(integer, text, text) from public, anon;
revoke execute on function public.admin_wallets() from public, anon;
revoke execute on function public.admin_decide_deposit(uuid, boolean, text) from public, anon;
revoke execute on function public.admin_wallet_adjust(uuid, integer, text) from public, anon;
revoke execute on function public.admin_set_pay_info(text, text, text) from public, anon;
grant execute on function public.pay_info() to authenticated;
grant execute on function public.my_wallet() to authenticated;
grant execute on function public.wallet_deposit(integer, text, text) to authenticated;
grant execute on function public.admin_wallets() to authenticated;
grant execute on function public.admin_decide_deposit(uuid, boolean, text) to authenticated;
grant execute on function public.admin_wallet_adjust(uuid, integer, text) to authenticated;
grant execute on function public.admin_set_pay_info(text, text, text) to authenticated;
