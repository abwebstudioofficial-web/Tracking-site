-- Google map: the Google Maps Platform key that makes Google's map the main map on every map page
-- (OpenStreetMap stays as the backup). It is a browser key, restricted in Google Cloud to this
-- website and the Map Tiles API, so every signed-in user may read it; only admins change it.
--
-- map_config()             { google_key } for the map pages ('' = no key: our free map is used)
-- admin_set_map_key(key)   save or clear the key

create or replace function public.map_config()
returns json language sql stable security definer set search_path = '' as $$
  select json_build_object('google_key',
    case when (select auth.uid()) is null then ''
         else coalesce((select value #>> '{}' from public.platform_settings where key = 'google_maps_key'), '') end);
$$;
revoke all on function public.map_config() from public, anon;
grant execute on function public.map_config() to authenticated;

create or replace function public.admin_set_map_key(p_key text)
returns json language plpgsql security definer set search_path = '' as $$
declare k text := trim(coalesce(p_key, ''));
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if k <> '' and k !~ '^[A-Za-z0-9_-]{30,60}$' then raise exception 'That doesn''t look like a Google key (it starts with AIza)'; end if;
  insert into public.platform_settings (key, value, updated_at, updated_by)
  values ('google_maps_key', to_jsonb(k), now(), (select auth.uid()))
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by;
  return public.map_config();
end $$;
revoke all on function public.admin_set_map_key(text) from public, anon;
grant execute on function public.admin_set_map_key(text) to authenticated;
