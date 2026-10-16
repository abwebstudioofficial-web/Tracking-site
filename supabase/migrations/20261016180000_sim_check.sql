-- The app checks that a driver's phone number is a SIM in the phone they signed in on.
--   verified    the SIM with that number is in the phone
--   unverified  the phone has a SIM but it doesn't store its own number (common), so it can't be checked
--   mismatch    the SIM was taken out after signing in (checked each time the app opens)
alter table public.profiles
  add column sim_check text check (sim_check in ('verified', 'unverified', 'mismatch')),
  add column sim_checked_at timestamptz;

create or replace function public.set_my_sim_check(p_status text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('verified', 'unverified', 'mismatch') then raise exception 'Unknown SIM status'; end if;
  update public.profiles set sim_check = p_status, sim_checked_at = now()
   where id = (select auth.uid()) and role <> 'admin'
     and sim_check is distinct from p_status;
end $$;

revoke execute on function public.set_my_sim_check(text) from public, anon;
grant execute on function public.set_my_sim_check(text) to authenticated;
