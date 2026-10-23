-- 0147 · Read models for leads, quotations and the acceptance register (§7.5.1, §7.5.3, §7.5.4),
-- and the leads analytics. Every view is security_invoker (the caller's RLS: Partners and Managers
-- only, §4.1) and SELECT-only for the API roles.
--
--   leads_list                 a lead with its assignee, author, converted client, open quotations
--                              (count and value), latest quotation, untouched-for-14-days and
--                              follow-up-overdue flags.
--   quotations_list            a quotation with its author (and their role), approver, lead,
--                              client, the revision that replaced it, follow-ups and
--                              `is_lapsed` (Sent / Viewed past valid_until, before the nightly
--                              expiry). The public token is left out: the detail page reads it.
--   client_acceptances_list    the acceptance register: decision, decider, conflicts found,
--                              independence threat, the lead or client it belongs to.
--   lead_analytics(from, to)   leads by source and stage, conversion (won ÷ closed), average days
--                              to win, pipeline value (open quotations), loss reasons and decline
--                              reasons, for the period (IST dates).

set search_path = public, extensions;

-- =============================================================================================
-- leads_list
-- =============================================================================================
create or replace view public.leads_list with (security_invoker = true) as
select
  l.id,
  l.lead_number,
  l.name,
  l.company,
  l.email,
  l.phone,
  l.whatsapp,
  l.services_required,
  l.requirement_notes,
  l.source,
  l.source_detail,
  l.status,
  l.estimated_value,
  l.assigned_to,
  e.full_name as assigned_name,
  l.next_follow_up_at,
  l.lost_reason,
  l.lost_category,
  l.converted_client_id,
  cc.display_name as converted_client_name,
  cc.client_code::text as converted_client_code,
  l.created_by,
  p.full_name as created_by_name,
  l.created_at,
  l.updated_at,
  l.last_activity_at,
  l.status_changed_at,
  l.closed_at,
  l.deleted_at,
  (l.status not in ('won', 'lost') and l.last_activity_at < now() - interval '14 days') as is_stale,
  (l.status not in ('won', 'lost') and l.next_follow_up_at is not null and l.next_follow_up_at < now()) as follow_up_overdue,
  coalesce(qs.open_count, 0)::int as open_quotations,
  coalesce(qs.open_value, 0)::numeric(14,2) as open_quotation_value,
  coalesce(qs.all_count, 0)::int as quotation_count,
  qs.latest_id as latest_quotation_id,
  qs.latest_number as latest_quotation_number,
  qs.latest_status as latest_quotation_status
from public.leads l
left join public.employees e on e.id = l.assigned_to
left join public.profiles p on p.id = l.created_by
left join public.clients cc on cc.id = l.converted_client_id
left join lateral (
  select
    count(*) filter (where q.status in ('pending_approval', 'approved', 'sent', 'viewed')) as open_count,
    sum(q.total) filter (where q.status in ('pending_approval', 'approved', 'sent', 'viewed')) as open_value,
    count(*) as all_count,
    (array_agg(q.id order by q.created_at desc))[1] as latest_id,
    (array_agg(q.quotation_number order by q.created_at desc))[1] as latest_number,
    (array_agg(q.status order by q.created_at desc))[1] as latest_status
  from public.quotations q
  where q.lead_id = l.id and q.deleted_at is null
) qs on true;

comment on view public.leads_list is
  'Leads (§7.5.1) with assignee, author, converted client, open quotations and their value, the latest quotation, and the untouched-14-days / follow-up-overdue flags. security_invoker: Partner/Manager only by RLS.';

revoke all on public.leads_list from anon, public;
revoke insert, update, delete, truncate, references, trigger on public.leads_list from authenticated;
grant select on public.leads_list to authenticated, service_role;

-- =============================================================================================
-- quotations_list
-- =============================================================================================
create or replace view public.quotations_list with (security_invoker = true) as
select
  q.id,
  q.quotation_number,
  q.lead_id,
  l.lead_number,
  l.name as lead_name,
  q.client_id,
  c.display_name as client_display_name,
  c.client_code::text as client_code,
  q.client_name,
  q.client_email,
  q.client_phone,
  q.client_company,
  q.client_gstin,
  q.place_of_supply_code,
  q.issue_date,
  q.valid_until,
  q.status,
  q.subtotal,
  q.tax_amount,
  q.total,
  q.notes,
  q.created_by,
  cp.full_name as created_by_name,
  cp.role as created_by_role,
  q.approved_by,
  ap.full_name as approved_by_name,
  q.approved_at,
  q.approval_note,
  q.approval_requested_at,
  q.returned_at,
  q.sent_at,
  q.last_sent_at,
  q.first_viewed_at,
  q.last_viewed_at,
  q.view_count,
  q.responded_at,
  q.response,
  q.rejection_reason,
  q.accepted_by_name,
  q.response_note,
  q.converted_client_id,
  q.revised_from_id,
  q.revision_number,
  rv.id as superseded_by_id,
  rv.quotation_number as superseded_by_number,
  q.expired_at,
  q.created_at,
  q.updated_at,
  q.deleted_at,
  (q.status in ('sent', 'viewed') and q.valid_until < public.today_ist()) as is_lapsed,
  fu.next_follow_up_at,
  coalesce(fu.handoff_due, 0)::int as follow_ups_to_hand_off
from public.quotations q
left join public.leads l on l.id = q.lead_id
left join public.clients c on c.id = q.client_id
left join public.profiles cp on cp.id = q.created_by
left join public.profiles ap on ap.id = q.approved_by
left join lateral (
  select r.id, r.quotation_number from public.quotations r
  where r.revised_from_id = q.id and r.deleted_at is null
  order by r.created_at desc limit 1
) rv on true
left join lateral (
  select
    min(f.scheduled_at) filter (where f.status = 'pending') as next_follow_up_at,
    count(*) filter (where f.notified_at is not null and f.status in ('pending', 'failed')) as handoff_due
  from public.quotation_follow_ups f
  where f.quotation_id = q.id
) fu on true;

comment on view public.quotations_list is
  'Quotations (§7.5.2–§7.5.3) with author and role, approver, lead, client, the revision that replaced it, follow-ups, and is_lapsed (Sent/Viewed past valid_until). No token. security_invoker: Partner/Manager only by RLS.';

revoke all on public.quotations_list from anon, public;
revoke insert, update, delete, truncate, references, trigger on public.quotations_list from authenticated;
grant select on public.quotations_list to authenticated, service_role;

-- =============================================================================================
-- client_acceptances_list (the acceptance register, §7.5.4)
-- =============================================================================================
create or replace view public.client_acceptances_list with (security_invoker = true) as
select
  a.id,
  a.prospect_name,
  a.pan,
  a.gstin,
  a.related_parties,
  a.conflicts_found,
  case when jsonb_typeof(a.conflicts_found) = 'array' then jsonb_array_length(a.conflicts_found) else 0 end::int as conflict_count,
  a.independence_answers,
  coalesce((
    select bool_or(v.value = 'yes')
    from jsonb_each_text(case when jsonb_typeof(a.independence_answers) = 'object' then a.independence_answers else '{}'::jsonb end) v
  ), false) as independence_threat,
  a.outcome,
  a.rationale,
  a.decided_by,
  dp.full_name as decided_by_name,
  a.decided_at,
  a.lead_id,
  l.lead_number,
  l.name as lead_name,
  a.client_id,
  c.display_name as client_display_name,
  c.client_code::text as client_code,
  a.created_by,
  cp.full_name as created_by_name,
  a.created_at,
  a.updated_at
from public.client_acceptances a
left join public.profiles dp on dp.id = a.decided_by
left join public.profiles cp on cp.id = a.created_by
left join public.leads l on l.id = a.lead_id
left join public.clients c on c.id = a.client_id;

comment on view public.client_acceptances_list is
  'The client acceptance register (§7.5.4): decision, decider, conflicts found and their count, independence threat, and the lead or client. security_invoker: Partner/Manager only by RLS.';

revoke all on public.client_acceptances_list from anon, public;
revoke insert, update, delete, truncate, references, trigger on public.client_acceptances_list from authenticated;
grant select on public.client_acceptances_list to authenticated, service_role;

create index if not exists client_acceptances_outcome_created_idx on public.client_acceptances (outcome, created_at desc);
create index if not exists client_acceptances_created_idx on public.client_acceptances (created_at desc);

-- =============================================================================================
-- lead_analytics(from, to)
-- =============================================================================================
create or replace function public.lead_analytics(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  v_from timestamptz;
  v_to timestamptz;
  v_out jsonb;
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Leads and quotations are for Partners and Managers.' using errcode = 'P0001';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'USER: Choose a period that ends after it starts.' using errcode = 'P0001';
  end if;
  if p_to - p_from > 3660 then
    raise exception 'USER: Choose a period of at most ten years.' using errcode = 'P0001';
  end if;
  v_from := p_from::timestamp at time zone 'Asia/Kolkata';
  v_to := (p_to + 1)::timestamp at time zone 'Asia/Kolkata';

  with created as (
    select * from public.leads l where l.deleted_at is null and l.created_at >= v_from and l.created_at < v_to
  ),
  closed as (
    select * from public.leads l where l.deleted_at is null and l.closed_at >= v_from and l.closed_at < v_to and l.status in ('won', 'lost')
  ),
  by_source as (
    select l.source::text as source,
           count(*)::int as total,
           count(*) filter (where l.status = 'won')::int as won,
           count(*) filter (where l.status = 'lost')::int as lost,
           count(*) filter (where l.status not in ('won', 'lost'))::int as open,
           coalesce(sum(l.estimated_value), 0)::numeric(14,2) as estimated_value
    from created l group by l.source
  ),
  by_stage as (
    select l.status::text as status, count(*)::int as total, coalesce(sum(l.estimated_value), 0)::numeric(14,2) as estimated_value
    from created l group by l.status
  ),
  loss as (
    select coalesce(l.lost_category, 'other') as category, count(*)::int as total,
           (array_agg(l.lost_reason order by l.closed_at desc))[1:3] as examples
    from closed l where l.status = 'lost' group by coalesce(l.lost_category, 'other')
  ),
  declines as (
    select q.id, q.quotation_number, coalesce(nullif(q.client_company, ''), q.client_name) as client, q.rejection_reason, q.responded_at
    from public.quotations q
    where q.deleted_at is null and q.status = 'rejected' and q.responded_at >= v_from and q.responded_at < v_to
    order by q.responded_at desc limit 10
  ),
  quote_stats as (
    select
      count(*) filter (where q.sent_at >= v_from and q.sent_at < v_to)::int as sent,
      count(*) filter (where q.status = 'accepted' and q.responded_at >= v_from and q.responded_at < v_to)::int as accepted,
      count(*) filter (where q.status = 'rejected' and q.responded_at >= v_from and q.responded_at < v_to)::int as rejected,
      count(*) filter (where q.status = 'expired' and q.expired_at >= v_from and q.expired_at < v_to)::int as expired
    from public.quotations q where q.deleted_at is null
  ),
  pipeline as (
    select count(*)::int as open_count, coalesce(sum(q.total), 0)::numeric(14,2) as open_value
    from public.quotations q
    where q.deleted_at is null and q.status in ('pending_approval', 'approved', 'sent', 'viewed') and q.valid_until >= public.today_ist()
  )
  select jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'leads_created', (select count(*) from created),
    'by_source', coalesce((select jsonb_agg(to_jsonb(s) order by s.total desc, s.source) from by_source s), '[]'::jsonb),
    'by_stage', coalesce((select jsonb_agg(to_jsonb(s)) from by_stage s), '[]'::jsonb),
    'won', (select count(*) from closed where status = 'won'),
    'lost', (select count(*) from closed where status = 'lost'),
    'avg_days_to_win', (select round(avg(extract(epoch from (c.closed_at - c.created_at)) / 86400.0)::numeric, 1) from closed c where c.status = 'won'),
    'pipeline', (select to_jsonb(p) from pipeline p),
    'quotations', (select to_jsonb(s) from quote_stats s),
    'loss_reasons', coalesce((select jsonb_agg(to_jsonb(x) order by x.total desc, x.category) from loss x), '[]'::jsonb),
    'decline_reasons', coalesce((select jsonb_agg(to_jsonb(d) order by d.responded_at desc) from declines d), '[]'::jsonb)
  ) into v_out;
  return v_out;
end;
$$;

comment on function public.lead_analytics(date, date) is
  'Partner/Manager: leads by source and stage, conversion (won ÷ closed), average days to win, pipeline value (open quotations within validity), loss and decline reasons, for a period of IST dates (§7.5.1).';

revoke execute on function public.lead_analytics(date, date) from public, anon;
grant execute on function public.lead_analytics(date, date) to authenticated;
