-- 0146 · The quotations job's database half (§8 "14:30 daily · Quotations": day 3/7/14
-- follow-ups; expiry of lapsed quotations).
--
--   expire_lapsed_quotations(today)  Sent, Viewed, Approved and Pending approval quotations whose
--       valid_until is before `today` (IST) become Expired (expired_at), their waiting follow-ups
--       are skipped, and the lead's / client's timeline records it. Returns the quotations it
--       expired, so the job can tell their authors. Idempotent: a second run finds nothing. Drafts
--       are left alone: they are still being prepared, and can't be sent with a past date.
--       Service role only (the job).

set search_path = public, extensions;

create or replace function public.expire_lapsed_quotations(p_today date default null)
returns table (id uuid, quotation_number text, created_by uuid, lead_id uuid, client_id uuid, client_name text, previous_status public.quotation_status, valid_until date)
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_today date := coalesce(p_today, public.today_ist());
  r record;
begin
  if not (auth.jwt() is null or coalesce(auth.jwt() ->> 'role', '') = 'service_role') then
    raise exception 'USER: Quotations expire on their own each night.' using errcode = 'P0001';
  end if;

  for r in
    select q.id, q.quotation_number, q.created_by, q.lead_id, q.client_id,
           coalesce(nullif(q.client_company, ''), q.client_name) as client_name, q.status, q.valid_until
    from public.quotations q
    where q.deleted_at is null
      and q.status in ('sent', 'viewed', 'approved', 'pending_approval')
      and q.valid_until < v_today
    order by q.valid_until, q.id
    for update of q skip locked
  loop
    update public.quotations q set status = 'expired', expired_at = now() where q.id = r.id;
    update public.quotation_follow_ups f
       set status = 'skipped', note = 'The quotation expired.'
     where f.quotation_id = r.id and f.status in ('pending', 'failed');
    if r.client_id is not null or r.lead_id is not null then
      insert into public.client_timeline_events (client_id, lead_id, event_type, title, metadata)
      values (r.client_id, r.lead_id, 'quotation_expired',
              format('Quotation %s expired (valid until %s)', r.quotation_number, to_char(r.valid_until, 'DD Mon YYYY')),
              jsonb_build_object('quotation_id', r.id));
    end if;
    id := r.id;
    quotation_number := r.quotation_number;
    created_by := r.created_by;
    lead_id := r.lead_id;
    client_id := r.client_id;
    client_name := r.client_name;
    previous_status := r.status;
    valid_until := r.valid_until;
    return next;
  end loop;
end;
$$;

comment on function public.expire_lapsed_quotations(date) is
  'The quotations job (service role): lapsed Sent / Viewed / Approved / Pending approval quotations → Expired, follow-ups skipped, timeline written; returns what it expired (§7.5.3, §8).';

create index if not exists quotation_follow_ups_quotation_status_idx on public.quotation_follow_ups (quotation_id, status);

revoke execute on function public.expire_lapsed_quotations(date) from public, anon, authenticated;
grant execute on function public.expire_lapsed_quotations(date) to service_role;
