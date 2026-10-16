-- Allow several admins. Making someone admin no longer hands the role over: the current admin
-- stays admin. Admins can't change their own role, so there is always at least one admin left.
drop index if exists public.profiles_one_admin;

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
  update public.profiles set role = p_role where id = p_user returning * into target;
  if target.id is null then raise exception 'User not found'; end if;
  return target;
end $$;
