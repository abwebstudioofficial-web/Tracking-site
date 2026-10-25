-- Transport Hub, stage 1: businesses on the platform.
--
-- companies        a shipper, carrier (truck owner/fleet), broker or dispatcher business.
--                  New companies wait for a platform admin to check them (pending -> verified / rejected).
-- company_members  who works for a company: owner, manager (dispatcher / staff) or driver (carriers only).
--                  A person belongs to at most one company.
-- company_invites  someone added by phone number. New accounts join automatically when they sign up
--                  with that number; people who already have an account accept it themselves.
-- company-docs     storage for verification papers (CNIC, NTN, truck registration), one folder per company.
--
-- Business people sign in with a password (role 'business'); drivers keep signing in with their
-- phone number only. Ibraya Logistics becomes the first carrier, with its admins and drivers.

alter table public.profiles drop constraint profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('admin', 'driver', 'import_driver', 'export_driver', 'business'));

create table public.companies (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('shipper', 'carrier', 'broker', 'dispatcher')),
  name        text not null check (length(trim(name)) between 2 and 100),
  city        text not null default '' check (length(city) <= 60),
  address     text not null default '' check (length(address) <= 200),
  phone       text,
  ntn         text not null default '' check (length(ntn) <= 20),
  cnic        text not null default '' check (length(cnic) <= 20),
  fleet_size  integer check (fleet_size between 0 and 10000),
  status      text not null default 'pending' check (status in ('pending', 'verified', 'rejected')),
  status_note text not null default '' check (length(status_note) <= 300),
  verified_at timestamptz,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

create table public.company_members (
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id    uuid not null unique references public.profiles(id) on delete cascade,
  role       text not null check (role in ('owner', 'manager', 'driver')),
  added_at   timestamptz not null default now(),
  primary key (company_id, user_id)
);
create unique index company_members_one_owner on public.company_members (company_id) where role = 'owner';

create table public.company_invites (
  company_id uuid not null references public.companies(id) on delete cascade,
  phone      text not null,
  name       text not null default '',
  role       text not null check (role in ('manager', 'driver')),
  invited_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (company_id, phone)
);
create index company_invites_phone on public.company_invites (phone);

create or replace function public.my_company_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select company_id from public.company_members where user_id = (select auth.uid());
$$;
create or replace function public.my_company_role()
returns text language sql stable security definer set search_path = '' as $$
  select role from public.company_members where user_id = (select auth.uid());
$$;

-- Reads: your own company, or everything for platform admins. (Other companies will be shown on
-- the load board through functions that return only public details, never CNIC/NTN.)
-- Writes: only through the functions below.
alter table public.companies enable row level security;
alter table public.company_members enable row level security;
alter table public.company_invites enable row level security;
revoke all on table public.companies, public.company_members, public.company_invites from anon;
revoke insert, update, delete on table public.companies, public.company_members, public.company_invites from authenticated;
grant select on table public.companies, public.company_members, public.company_invites to authenticated;
create policy "Members and admins read the company" on public.companies
  for select to authenticated using (id = (select public.my_company_id()) or (select public.is_admin()));
create policy "Members and admins read the team" on public.company_members
  for select to authenticated using (company_id = (select public.my_company_id()) or (select public.is_admin()));
create policy "Owners, managers and admins read invites" on public.company_invites
  for select to authenticated using (
    (company_id = (select public.my_company_id()) and (select public.my_company_role()) in ('owner', 'manager'))
    or (select public.is_admin()));

-- New sign-ups: business accounts (password, from the "Create business account" form) get the
-- 'business' role; everyone else starts as a driver. A waiting invite for the number is joined.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  is_phone_account boolean := new.email like '%@phone.ibraya.local';
  first_user boolean;
  new_role text;
  new_phone text := case when is_phone_account then '+' || split_part(new.email, '@', 1) end;
begin
  perform pg_advisory_xact_lock(hashtext('ibraya_first_admin'));
  first_user := not exists (select 1 from public.profiles);
  new_role := case when first_user then 'admin'
                   when new.raw_user_meta_data->>'account' = 'business' then 'business'
                   else 'driver' end;
  insert into public.profiles (id, name, phone, email, role, is_owner)
  values (
    new.id,
    left(coalesce(nullif(trim(new.raw_user_meta_data->>'name'), ''),
                  nullif(trim(new.raw_user_meta_data->>'full_name'), ''),
                  split_part(coalesce(new.email, ''), '@', 1)), 80),
    new_phone,
    case when is_phone_account then null else new.email end,
    new_role,
    first_user
  );
  if new_phone is not null then
    insert into public.company_members (company_id, user_id, role)
    select company_id, new.id, role from public.company_invites
     where phone = new_phone and (role = 'driver') = (new_role <> 'business')
     order by created_at limit 1
    on conflict do nothing;
    delete from public.company_invites
     where phone = new_phone and exists (select 1 from public.company_members where user_id = new.id);
  end if;
  return new;
end $$;

-- Everything the hub page needs about my company, in one call.
create or replace function public.my_company()
returns json language plpgsql stable security definer set search_path = '' as $$
declare
  me public.profiles;
  member public.company_members;
begin
  select * into me from public.profiles where id = (select auth.uid());
  if me.id is null then raise exception 'Not signed in'; end if;
  select * into member from public.company_members where user_id = me.id;
  return json_build_object(
    'me', json_build_object('id', me.id, 'name', me.name, 'phone', me.phone, 'role', me.role, 'is_owner', me.is_owner),
    'role', member.role,
    'company', (select row_to_json(c) from public.companies c where c.id = member.company_id),
    'members', coalesce((
      select json_agg(json_build_object('user_id', m.user_id, 'name', p.name, 'phone', p.phone, 'role', m.role,
                                        'added_at', m.added_at, 'location_at', p.location_at)
                      order by array_position(array['owner', 'manager', 'driver'], m.role), p.name)
        from public.company_members m join public.profiles p on p.id = m.user_id
       where m.company_id = member.company_id), '[]'::json),
    'invites', case when member.role in ('owner', 'manager') then coalesce((
      select json_agg(json_build_object('phone', i.phone, 'name', i.name, 'role', i.role, 'created_at', i.created_at)
                      order by i.created_at)
        from public.company_invites i where i.company_id = member.company_id), '[]'::json) else '[]'::json end,
    -- Invites waiting for me (I already had an account when the company added my number).
    'my_invites', case when member.company_id is null then coalesce((
      select json_agg(json_build_object('company_id', c.id, 'company', c.name, 'kind', c.kind, 'role', i.role,
                                        'verified', c.status = 'verified'))
        from public.company_invites i join public.companies c on c.id = i.company_id
       where i.phone = me.phone and (i.role = 'driver') = (me.role <> 'business')), '[]'::json) else '[]'::json end);
end $$;

-- A business account registers its company. It waits for a platform admin to verify it.
create or replace function public.create_my_company(
  p_kind text, p_name text, p_city text, p_address text default '', p_ntn text default '',
  p_cnic text default '', p_fleet_size integer default null)
returns json language plpgsql security definer set search_path = '' as $$
declare
  me public.profiles;
  new_id uuid;
begin
  select * into me from public.profiles where id = (select auth.uid());
  if me.id is null or me.role not in ('business', 'admin') then
    raise exception 'Only business accounts can register a company';
  end if;
  if exists (select 1 from public.company_members where user_id = me.id) then
    raise exception 'You are already part of a company';
  end if;
  if p_kind not in ('shipper', 'carrier', 'broker', 'dispatcher') then raise exception 'Choose what your business does'; end if;
  if length(trim(coalesce(p_name, ''))) < 2 then raise exception 'Enter your company name'; end if;
  if length(trim(coalesce(p_city, ''))) < 2 then raise exception 'Enter your city'; end if;
  insert into public.companies (kind, name, city, address, phone, ntn, cnic, fleet_size, created_by)
  values (p_kind, trim(p_name), trim(p_city), trim(coalesce(p_address, '')), me.phone,
          trim(coalesce(p_ntn, '')), trim(coalesce(p_cnic, '')),
          case when p_kind = 'carrier' then p_fleet_size end, me.id)
  returning id into new_id;
  insert into public.company_members (company_id, user_id, role) values (new_id, me.id, 'owner');
  delete from public.company_invites where phone = me.phone;
  return public.my_company();
end $$;

-- The owner edits the company. Changing the name, NTN or CNIC of a verified company, or fixing a
-- rejected one, sends it back to the admins to check.
create or replace function public.update_my_company(
  p_name text, p_city text, p_address text, p_ntn text, p_cnic text, p_fleet_size integer default null)
returns json language plpgsql security definer set search_path = '' as $$
declare c public.companies;
begin
  if public.my_company_role() is distinct from 'owner' then raise exception 'Only the company owner can do this'; end if;
  if length(trim(coalesce(p_name, ''))) < 2 then raise exception 'Enter your company name'; end if;
  if length(trim(coalesce(p_city, ''))) < 2 then raise exception 'Enter your city'; end if;
  select * into c from public.companies where id = public.my_company_id() for update;
  update public.companies
     set name = trim(p_name), city = trim(p_city), address = trim(coalesce(p_address, '')),
         ntn = trim(coalesce(p_ntn, '')), cnic = trim(coalesce(p_cnic, '')),
         fleet_size = case when kind = 'carrier' then p_fleet_size end,
         status = case when c.status = 'rejected'
                         or (c.status = 'verified' and (c.name, c.ntn, c.cnic) is distinct from
                             (trim(p_name), trim(coalesce(p_ntn, '')), trim(coalesce(p_cnic, ''))))
                       then 'pending' else c.status end,
         status_note = case when c.status = 'rejected' then '' else c.status_note end
   where id = c.id;
  return public.my_company();
end $$;

-- Owners add managers and drivers; managers add drivers. Drivers only for carriers.
-- Returns 'invited' (they join when they sign up, or accept on their page).
create or replace function public.company_invite(p_phone text, p_name text, p_role text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  my_role text := public.my_company_role();
  c public.companies;
  clean_phone text := public.normalize_phone(p_phone);
  target public.profiles;
begin
  if my_role is null or my_role = 'driver' then raise exception 'Only the owner or a manager can add people'; end if;
  if p_role not in ('manager', 'driver') then raise exception 'Unknown role'; end if;
  if p_role = 'manager' and my_role <> 'owner' then raise exception 'Only the owner can add managers'; end if;
  select * into c from public.companies where id = public.my_company_id();
  if p_role = 'driver' and c.kind <> 'carrier' then raise exception 'Only carriers have drivers'; end if;
  if clean_phone is null then raise exception 'Enter a valid phone number'; end if;
  select * into target from public.profiles where phone = clean_phone;
  if target.id is not null then
    if exists (select 1 from public.company_members where user_id = target.id) then
      raise exception 'This number is already part of a company';
    end if;
    if p_role = 'driver' and target.role in ('business', 'admin') then
      raise exception 'This number has a business account, so it can''t be a driver';
    end if;
    if p_role = 'manager' and target.role <> 'business' then
      raise exception 'This number signs in as a driver. A manager needs a business account (with a password).';
    end if;
  end if;
  insert into public.company_invites (company_id, phone, name, role, invited_by)
  values (c.id, clean_phone, left(trim(coalesce(p_name, '')), 80), p_role, (select auth.uid()))
  on conflict (company_id, phone) do update set name = excluded.name, role = excluded.role, created_at = now();
  return 'invited';
end $$;

create or replace function public.company_cancel_invite(p_phone text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(public.my_company_role(), '') not in ('owner', 'manager') then raise exception 'Only the owner or a manager can do this'; end if;
  delete from public.company_invites where company_id = public.my_company_id() and phone = p_phone
     and (role = 'driver' or public.my_company_role() = 'owner');
end $$;

-- Owners remove anyone but themselves; managers remove drivers.
create or replace function public.company_remove_member(p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare target public.company_members;
begin
  if coalesce(public.my_company_role(), '') not in ('owner', 'manager') then raise exception 'Only the owner or a manager can do this'; end if;
  select * into target from public.company_members where user_id = p_user and company_id = public.my_company_id();
  if target.user_id is null then raise exception 'Not in your company'; end if;
  if target.role = 'owner' then raise exception 'The owner cannot be removed'; end if;
  if target.role = 'manager' and public.my_company_role() <> 'owner' then raise exception 'Only the owner can remove managers'; end if;
  delete from public.company_members where user_id = p_user;
end $$;

-- Someone who already had an account accepts or declines a company's invite.
create or replace function public.answer_company_invite(p_company uuid, p_accept boolean)
returns json language plpgsql security definer set search_path = '' as $$
declare
  me public.profiles;
  inv public.company_invites;
begin
  select * into me from public.profiles where id = (select auth.uid());
  select * into inv from public.company_invites where company_id = p_company and phone = me.phone;
  if inv.company_id is null then raise exception 'This invite is no longer there'; end if;
  if p_accept then
    if exists (select 1 from public.company_members where user_id = me.id) then
      raise exception 'You are already part of a company';
    end if;
    if (inv.role = 'driver') <> (me.role not in ('business', 'admin')) then
      raise exception 'This invite is for a different kind of account';
    end if;
    insert into public.company_members (company_id, user_id, role) values (p_company, me.id, inv.role);
    delete from public.company_invites where phone = me.phone;
  else
    delete from public.company_invites where company_id = p_company and phone = me.phone;
  end if;
  return public.my_company();
end $$;

-- Platform admins: every company, newest first, waiting ones on top.
create or replace function public.admin_list_companies()
returns json language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  return coalesce((
    select json_agg(json_build_object(
             'company', row_to_json(c),
             'owner', (select json_build_object('name', p.name, 'phone', p.phone)
                         from public.company_members m join public.profiles p on p.id = m.user_id
                        where m.company_id = c.id and m.role = 'owner'),
             'members', (select count(*) from public.company_members m where m.company_id = c.id))
           order by (c.status = 'pending') desc, c.created_at desc)
      from public.companies c), '[]'::json);
end $$;

create or replace function public.admin_set_company_status(p_company uuid, p_status text, p_note text default '')
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if p_status not in ('pending', 'verified', 'rejected') then raise exception 'Unknown status'; end if;
  if p_status = 'rejected' and length(trim(coalesce(p_note, ''))) = 0 then
    raise exception 'Write the reason, so the company knows what to fix';
  end if;
  update public.companies
     set status = p_status, status_note = left(trim(coalesce(p_note, '')), 300),
         verified_at = case when p_status = 'verified' then now() end
   where id = p_company;
  if not found then raise exception 'Company not found'; end if;
end $$;

-- Verification papers: company-docs/<company id>/<file>. The owner and managers upload and see
-- their own company's files; platform admins see all of them.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('company-docs', 'company-docs', false, 5242880,
        array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'])
on conflict (id) do nothing;
create policy "Company staff upload papers" on storage.objects for insert to authenticated with check (
  bucket_id = 'company-docs' and (storage.foldername(name))[1] = (select public.my_company_id())::text
  and (select public.my_company_role()) in ('owner', 'manager'));
create policy "Company staff and admins see papers" on storage.objects for select to authenticated using (
  bucket_id = 'company-docs' and (
    ((storage.foldername(name))[1] = (select public.my_company_id())::text
     and (select public.my_company_role()) in ('owner', 'manager'))
    or (select public.is_admin())));
create policy "Company owner removes papers" on storage.objects for delete to authenticated using (
  bucket_id = 'company-docs' and (storage.foldername(name))[1] = (select public.my_company_id())::text
  and (select public.my_company_role()) = 'owner');

-- Ibraya Logistics: the first carrier on the platform, already verified, with today's team.
with ibraya as (
  insert into public.companies (kind, name, city, phone, status, verified_at, created_by)
  select 'carrier', 'Ibraya Logistics', 'Karachi', phone, 'verified', now(), id
    from public.profiles where is_owner
  returning id)
insert into public.company_members (company_id, user_id, role)
select ibraya.id, p.id,
       case when p.is_owner then 'owner' when p.role = 'admin' then 'manager' else 'driver' end
  from ibraya, public.profiles p;

revoke execute on function public.my_company_id() from public, anon;
revoke execute on function public.my_company_role() from public, anon;
revoke execute on function public.my_company() from public, anon;
revoke execute on function public.create_my_company(text, text, text, text, text, text, integer) from public, anon;
revoke execute on function public.update_my_company(text, text, text, text, text, integer) from public, anon;
revoke execute on function public.company_invite(text, text, text) from public, anon;
revoke execute on function public.company_cancel_invite(text) from public, anon;
revoke execute on function public.company_remove_member(uuid) from public, anon;
revoke execute on function public.answer_company_invite(uuid, boolean) from public, anon;
revoke execute on function public.admin_list_companies() from public, anon;
revoke execute on function public.admin_set_company_status(uuid, text, text) from public, anon;
grant execute on function public.my_company_id() to authenticated;
grant execute on function public.my_company_role() to authenticated;
grant execute on function public.my_company() to authenticated;
grant execute on function public.create_my_company(text, text, text, text, text, text, integer) to authenticated;
grant execute on function public.update_my_company(text, text, text, text, text, integer) to authenticated;
grant execute on function public.company_invite(text, text, text) to authenticated;
grant execute on function public.company_cancel_invite(text) to authenticated;
grant execute on function public.company_remove_member(uuid) to authenticated;
grant execute on function public.answer_company_invite(uuid, boolean) to authenticated;
grant execute on function public.admin_list_companies() to authenticated;
grant execute on function public.admin_set_company_status(uuid, text, text) to authenticated;
