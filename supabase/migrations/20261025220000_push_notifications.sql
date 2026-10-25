-- Transport Hub, stage 5: pop-up notifications on phones (Firebase Cloud Messaging, free).
--
-- push_tokens   one row per phone that allowed notifications (the Transport Hub app registers it
--               after sign-in and forgets it on sign-out).
-- send_push()   asks the "push" Edge Function (supabase/functions/push) to send a notification to
--               a company's owners/managers or to one person. It is called by triggers:
--                 every alert (bids, booked, driver steps, delivered, invoices, payments, ...),
--                 and the driver's new job / cancelled job.
-- The Edge Function checks the shared secret stored here as push_hook_secret (set by hand, never in
-- a migration) and sends with the Firebase key in its FCM_SERVICE_ACCOUNT secret.

create table public.push_tokens (
  token      text primary key check (length(token) between 20 and 4096),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  platform   text not null default 'android',
  updated_at timestamptz not null default now()
);
create index push_tokens_user on public.push_tokens (user_id);
alter table public.push_tokens enable row level security;
revoke all on table public.push_tokens from anon, authenticated;

create or replace function public.save_push_token(p_token text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then raise exception 'Not signed in'; end if;
  insert into public.push_tokens (token, user_id, updated_at) values (p_token, (select auth.uid()), now())
  on conflict (token) do update set user_id = excluded.user_id, updated_at = now();
end $$;
create or replace function public.delete_push_token(p_token text)
returns void language sql security definer set search_path = '' as $$
  delete from public.push_tokens where token = p_token and user_id = (select auth.uid());
$$;

-- Sends through the Edge Function (in the background, via pg_net), only if someone has a phone registered.
create or replace function public.send_push(p_company uuid, p_user uuid, p_title text, p_body text, p_url text)
returns void language plpgsql security definer set search_path = '' as $$
declare secret text := (select value #>> '{}' from public.platform_settings where key = 'push_hook_secret');
begin
  if secret is null then return; end if;
  if not exists (
       select 1 from public.push_tokens t
        where t.user_id = p_user
           or t.user_id in (select user_id from public.company_members
                             where company_id = p_company and role in ('owner', 'manager'))) then
    return;
  end if;
  perform net.http_post(
    url := 'https://qodvhcvqhwvllfmhfndo.supabase.co/functions/v1/push',
    body := jsonb_build_object('company_id', p_company, 'user_id', p_user, 'title', p_title, 'body', p_body, 'url', p_url),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', secret));
end $$;

-- Every alert also pops up on the phones of the company's owner and managers.
create or replace function public.push_on_notification()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.send_push(new.company_id, null, new.title, new.body,
    case when new.invoice_id is not null then '/invoice?id=' || new.invoice_id
         when new.load_id is not null then '/hub?load=' || new.load_id
         else '/hub' end);
  return new;
end $$;
create trigger notifications_push after insert on public.notifications
  for each row execute function public.push_on_notification();

-- Drivers: a new job, or a job taken away / cancelled.
create or replace function public.push_on_trip()
returns trigger language plpgsql security definer set search_path = '' as $$
declare l public.loads;
begin
  select * into l from public.loads where id = new.load_id;
  if tg_op = 'INSERT' then
    perform public.send_push(null, new.driver_id, 'New job · نیا کام',
      'Pickup ' || l.pickup_city || coalesce(nullif(' (' || l.pickup_place || ')', ' ()'), '') || ' → ' || l.drop_city
        || ' · ' || to_char(l.pickup_date, 'Dy DD Mon'), '/driver');
  elsif new.status = 'cancelled' and old.status <> 'cancelled' then
    perform public.send_push(null, new.driver_id, 'Job cancelled · کام منسوخ', public.route_text(l.id), '/driver');
  end if;
  return new;
end $$;
create trigger trips_push after insert or update of status on public.trips
  for each row execute function public.push_on_trip();

revoke execute on function public.save_push_token(text) from public, anon;
revoke execute on function public.delete_push_token(text) from public, anon;
revoke execute on function public.send_push(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.push_on_notification() from public, anon, authenticated;
revoke execute on function public.push_on_trip() from public, anon, authenticated;
grant execute on function public.save_push_token(text) to authenticated;
grant execute on function public.delete_push_token(text) to authenticated;
