-- Per-driver truck size (drawn as a 20ft or 40ft container) and urgency (container colour), set by admins.
alter table public.profiles
  add column truck_size text not null default '20ft' check (truck_size in ('20ft', '40ft')),
  add column urgency text not null default 'normal' check (urgency in ('normal', 'urgent', 'very_urgent'));

create or replace function public.admin_set_truck(p_user uuid, p_truck_size text default null, p_urgency text default null)
returns public.profiles language plpgsql security definer set search_path = '' as $$
declare target public.profiles;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if p_truck_size is not null and p_truck_size not in ('20ft', '40ft') then raise exception 'Unknown truck size'; end if;
  if p_urgency is not null and p_urgency not in ('normal', 'urgent', 'very_urgent') then raise exception 'Unknown urgency'; end if;
  update public.profiles
     set truck_size = coalesce(p_truck_size, truck_size), urgency = coalesce(p_urgency, urgency)
   where id = p_user
  returning * into target;
  if target.id is null then raise exception 'User not found'; end if;
  return target;
end $$;
revoke execute on function public.admin_set_truck(uuid, text, text) from public, anon;
grant execute on function public.admin_set_truck(uuid, text, text) to authenticated;
