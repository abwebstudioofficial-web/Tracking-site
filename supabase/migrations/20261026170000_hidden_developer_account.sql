-- Developer account: an admin that only the main admin can see.
--
-- profiles.hidden  true for the developer who builds and looks after the site. It is a full admin,
--                  but other admins never see it (not in the people list, not on the map) and
--                  can't change, reset or remove it. The main admin (owner of Transport Hub) sees
--                  it, marked "Developer", and can change or remove it like anyone else.

alter table public.profiles add column if not exists hidden boolean not null default false;
alter table public.profiles drop constraint if exists profiles_hidden_is_admin;
alter table public.profiles add constraint profiles_hidden_is_admin check (not hidden or (role = 'admin' and not is_owner));

create or replace function public.is_main_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'admin' and is_owner);
$$;
revoke execute on function public.is_main_admin() from public, anon;
grant execute on function public.is_main_admin() to authenticated;

-- Admins read every profile except hidden ones; the main admin reads them too.
-- ("Users read their own profile" still lets the developer read their own.)
drop policy if exists "Admin reads every profile" on public.profiles;
create policy "Admin reads every profile" on public.profiles for select to authenticated
  using ((select public.is_admin()) and (not hidden or (select public.is_main_admin())));

-- Changing someone's role: a hidden account only by the main admin (and it stops being hidden
-- when it stops being an admin).
create or replace function public.admin_set_role(p_user uuid, p_role text)
returns public.profiles language plpgsql security definer set search_path = '' as $$
declare target public.profiles;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if p_role not in ('admin', 'driver', 'import_driver', 'export_driver') then
    raise exception 'Unknown role';
  end if;
  if p_user = (select auth.uid()) then
    raise exception 'You cannot change your own role. Ask another admin.';
  end if;
  if exists (select 1 from public.profiles where id = p_user and is_owner) then
    raise exception 'The main admin cannot be changed';
  end if;
  if exists (select 1 from public.profiles where id = p_user and hidden) and not public.is_main_admin() then
    raise exception 'User not found';
  end if;
  -- Becoming a driver means being tracked again; becoming admin starts untracked.
  update public.profiles set role = p_role, tracked = false, hidden = hidden and p_role = 'admin'
   where id = p_user returning * into target;
  if target.id is null then raise exception 'User not found'; end if;
  return target;
end $$;
