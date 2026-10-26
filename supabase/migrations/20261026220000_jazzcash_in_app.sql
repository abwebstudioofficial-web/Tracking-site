-- JazzCash in-app payments (like Foodpanda): the company enters its JazzCash number and the last
-- 6 digits of the CNIC, approves the payment on its phone with the MPIN, and the money is in the
-- wallet straight away. The "jazzcash" Edge Function talks to JazzCash's Mobile Wallet API with
-- the gateway credentials (Edge Function secrets) and records the payment with the two functions
-- below, which only the Edge Function (service role) may call.
--
-- wallet_online_start(user, amount, ref)   checks the user may add money, saves the payment as
--                                          'pending' and returns its id
-- wallet_online_finish(id, ok, rrn, msg)   approved (counts in the balance, alert) or rejected

alter table public.wallet_entries drop constraint if exists wallet_entries_method_check;
alter table public.wallet_entries add constraint wallet_entries_method_check check (method in ('', 'jazzcash', 'jazzcash_app'));

create or replace function public.wallet_online_start(p_user uuid, p_amount integer, p_ref text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  m public.company_members;
  c public.companies;
  entry uuid;
begin
  select * into m from public.company_members where user_id = p_user;
  select * into c from public.companies where id = m.company_id;
  if c.id is null or m.role not in ('owner', 'manager') then raise exception 'Only the owner or a manager can add money'; end if;
  if c.kind not in ('carrier', 'broker', 'dispatcher') then raise exception 'Shippers don''t have a wallet'; end if;
  if p_amount is null or p_amount < 100 or p_amount > 1000000 then raise exception 'Enter an amount from Rs 100'; end if;
  insert into public.wallet_entries (company_id, kind, amount, status, method, tid, note, created_by)
  values (c.id, 'deposit', p_amount, 'pending', 'jazzcash_app', p_ref, 'Paid in the app', p_user)
  returning id into entry;
  return entry;
end $$;

create or replace function public.wallet_online_finish(p_entry uuid, p_ok boolean, p_rrn text, p_message text)
returns json language plpgsql security definer set search_path = '' as $$
declare w public.wallet_entries;
begin
  update public.wallet_entries
     set status = case when p_ok then 'approved' else 'rejected' end,
         note = left(case when p_ok then 'Paid in the app' || coalesce(' · ref ' || nullif(p_rrn, ''), '')
                          else 'JazzCash: ' || coalesce(nullif(p_message, ''), 'not paid') end, 200),
         decided_at = now()
   where id = p_entry and status = 'pending'
  returning * into w;
  if w.id is null then raise exception 'Payment not found'; end if;
  if p_ok then
    perform public.notify(w.company_id, 'wallet', 'Money added to your wallet: ' || public.rs(w.amount),
      'JazzCash · balance ' || public.rs(public.wallet_balance(w.company_id)));
  end if;
  return json_build_object('ok', p_ok, 'amount', w.amount, 'balance', public.wallet_balance(w.company_id));
end $$;

revoke execute on function public.wallet_online_start(uuid, integer, text) from public, anon, authenticated;
revoke execute on function public.wallet_online_finish(uuid, boolean, text, text) from public, anon, authenticated;
grant execute on function public.wallet_online_start(uuid, integer, text) to service_role;
grant execute on function public.wallet_online_finish(uuid, boolean, text, text) to service_role;
