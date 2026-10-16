-- Keep the free database small: every night, forget routes and incidents older than 30 days.
create extension if not exists pg_cron;

create or replace function public.forget_old_history()
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from public.location_history where recorded_at < now() - interval '30 days';
  delete from public.tracking_incidents where started_at < now() - interval '30 days';
end $$;
revoke execute on function public.forget_old_history() from public, anon, authenticated;

-- 22:15 UTC = 03:15 in Pakistan.
select cron.schedule('ibraya-forget-old-history', '15 22 * * *', 'select public.forget_old_history()');
