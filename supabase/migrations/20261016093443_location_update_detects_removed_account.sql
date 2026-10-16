-- A removed driver whose phone is still open gets told so, and the page signs them out.
create or replace function public.update_my_location(
  p_lat double precision, p_lng double precision,
  p_accuracy double precision default null, p_speed double precision default null,
  p_heading double precision default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.profiles where id = (select auth.uid())) then
    raise exception 'Account removed';
  end if;
  if p_lat is null or p_lng is null or abs(p_lat) > 90 or abs(p_lng) > 180 then
    raise exception 'Invalid location';
  end if;
  update public.profiles
     set lat = p_lat, lng = p_lng, accuracy = p_accuracy, speed = p_speed,
         heading = p_heading, location_at = now()
   where id = (select auth.uid()) and role <> 'admin';
end $$;
