-- 0198 · Read models for the quality module, the audit list and Client 360's Engagement tab
-- (§7.15.4, §7.15.5, §7.3.3). All security_invoker (the caller's RLS decides what rows exist), and
-- SELECT-only for the API roles. Derived states (overdue, due soon, open) are computed here, never
-- stored (§0.1 rule 10).
--
--   audit_engagements_list   each engagement with its client, partner, review manager, UDIN, the
--                            SA 230 assembly countdown and how much of the current stage is signed.
--   kyc_register             attest clients (an active audit service, an audit engagement or a KYC
--                            record) with their KYC completeness and the annual re-confirmation.
--   documents_for_disposal   documents past retention_until (§6.8 "review for disposal"; never deleted
--                            automatically), and whether they sit in an archived audit file.
--   retention_summary()      documents by the year their retention ends.
--   data_requests_view       + is_open, is_overdue, days_left.
--   data_incidents_view      + the Board's report deadline, steps done, is_open, board_overdue.
--   independence_register(fy) every active staff member and their declaration for the year.

set search_path = public, extensions;

-- =============================================================================================
-- audit_engagements_list
-- =============================================================================================
create or replace view public.audit_engagements_list with (security_invoker = true) as
select
  e.id,
  e.client_id,
  c.display_name as client_name,
  c.client_code::text as client_code,
  c.entity_type::text as entity_type,
  e.audit_type,
  e.financial_year,
  e.stage,
  e.engagement_partner_id,
  ep.full_name as engagement_partner_name,
  e.review_manager_id,
  rm.full_name as review_manager_name,
  e.report_type,
  e.report_date,
  e.udin_record_id,
  u.udin::text as udin,
  e.file_assembly_due,
  e.archived_at,
  e.retain_until,
  e.caro_applicable,
  e.had_previous_auditor,
  e.requires_peer_reviewed_auditor,
  e.accepted_on,
  case when e.archived_at is null and e.file_assembly_due is not null then e.file_assembly_due - public.today_ist() end as assembly_days_left,
  (e.archived_at is null and e.file_assembly_due is not null and e.file_assembly_due < public.today_ist()) as assembly_overdue,
  (select count(*)::int from public.audit_step_definitions s
     where (s.stage = e.stage or (e.stage = 'reporting' and s.stage = 'archived'))
       and (s.audit_types is null or e.audit_type = any (s.audit_types))) as stage_steps,
  (select count(*)::int from public.audit_step_definitions s
     where (s.stage = e.stage or (e.stage = 'reporting' and s.stage = 'archived'))
       and (s.audit_types is null or e.audit_type = any (s.audit_types))
       and public.audit_step_done(e.checklist, s.key)) as stage_steps_done,
  (select count(*)::int from public.audit_engagement_documents d where d.engagement_id = e.id) as evidence_count,
  e.created_at,
  e.updated_at
from public.audit_engagements e
join public.clients c on c.id = e.client_id
left join public.employees ep on ep.id = e.engagement_partner_id
left join public.employees rm on rm.id = e.review_manager_id
left join public.udin_records u on u.id = e.udin_record_id;

comment on view public.audit_engagements_list is
  'Audit engagements with client, team, UDIN, the derived SA 230 assembly countdown and the current stage''s sign-off count (§7.15.5). Partner/Manager by RLS.';

-- =============================================================================================
-- kyc_register (§6.8 KYC Norms, §7.15.4 "KYC status by client")
-- =============================================================================================
create or replace view public.kyc_register with (security_invoker = true) as
with attest as (
  select c.id as client_id,
    exists (select 1 from public.client_services_public s where s.client_id = c.id and s.service_type = 'audit' and s.is_active) as has_audit_service,
    (select count(*)::int from public.audit_engagements a where a.client_id = c.id and a.archived_at is null) as open_audits
  from public.clients c
  where c.deleted_at is null
)
select
  c.id as client_id,
  c.display_name as client_name,
  c.client_code::text as client_code,
  c.entity_type::text as entity_type,
  c.status::text as client_status,
  c.owner_employee_id,
  k.id as kyc_id,
  k.entity_category,
  k.verified_on,
  k.verified_by,
  k.next_review_on,
  k.updated_at as kyc_updated_at,
  a.has_audit_service,
  a.open_audits,
  m.missing,
  cardinality(m.missing) = 0 as complete,
  public.kyc_review_due(c.id, public.today_ist()) as review_due,
  case
    when k.id is null then 'missing'
    when cardinality(m.missing) > 0 then 'incomplete'
    when public.kyc_review_due(c.id, public.today_ist()) then 'review_due'
    else 'current'
  end as kyc_state
from public.clients c
join attest a on a.client_id = c.id
left join public.client_kyc k on k.client_id = c.id
cross join lateral (select public.kyc_missing(c.id) as missing) m
where c.deleted_at is null
  and (a.has_audit_service or a.open_audits > 0 or k.id is not null);

comment on view public.kyc_register is
  'Attest clients and their KYC state: missing, incomplete, review_due or current (§6.8, §7.15.4).';

-- =============================================================================================
-- documents_for_disposal (§6.8, §7.15.4) and retention_summary()
-- =============================================================================================
create or replace view public.documents_for_disposal with (security_invoker = true) as
select
  d.id,
  d.client_id,
  c.display_name as client_name,
  c.client_code::text as client_code,
  d.title,
  d.category::text as category,
  d.financial_year,
  d.file_name,
  d.retention_until,
  public.today_ist() - d.retention_until as days_past,
  exists (
    select 1 from public.audit_engagement_documents l
    join public.audit_engagements e on e.id = l.engagement_id
    where l.document_id = d.id and e.archived_at is not null
  ) as in_audit_file,
  d.created_at
from public.documents d
join public.clients c on c.id = d.client_id
where d.deleted_at is null
  and d.retention_until is not null
  and d.retention_until < public.today_ist();

comment on view public.documents_for_disposal is
  'Documents whose retention has run out: the "review for disposal" list (§6.8). Nothing is deleted automatically.';

create or replace function public.retention_summary()
returns table (year int, documents int, past_retention int)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select extract(year from d.retention_until)::int as year,
         count(*)::int as documents,
         count(*) filter (where d.retention_until < public.today_ist())::int as past_retention
  from public.documents d
  where d.deleted_at is null and d.retention_until is not null
  group by 1
  order by 1
$$;

comment on function public.retention_summary() is 'Documents by the calendar year their retention ends, with how many are already past it (§7.15.4).';

-- =============================================================================================
-- data_requests_view, data_incidents_view (§6.10)
-- =============================================================================================
create or replace view public.data_requests_view with (security_invoker = true) as
select
  r.*,
  c.display_name as client_name,
  h.full_name as handled_by_name,
  not (r.status = any (array['closed', 'completed', 'resolved', 'rejected', 'withdrawn'])) as is_open,
  (not (r.status = any (array['closed', 'completed', 'resolved', 'rejected', 'withdrawn'])) and r.due_by is not null and r.due_by < public.today_ist()) as is_overdue,
  case when not (r.status = any (array['closed', 'completed', 'resolved', 'rejected', 'withdrawn'])) and r.due_by is not null then r.due_by - public.today_ist() end as days_left
from public.data_requests r
left join public.clients c on c.id = r.client_id
left join public.profiles h on h.id = r.handled_by;

comment on view public.data_requests_view is 'DPDP data requests with the derived open, overdue and days left (§6.10).';

create or replace view public.data_incidents_view with (security_invoker = true) as
select
  i.*,
  i.detected_at + make_interval(hours => coalesce(public.jsonb_to_numeric(public.statutory_param_value('dpdp.breach_board_report_hours', (i.detected_at at time zone 'Asia/Kolkata')::date)), 72)::int) as board_report_due_at,
  (i.contained_at is not null)::int + (i.assessed_at is not null)::int + (i.board_notified_at is not null)::int
    + (i.principals_notified_at is not null)::int + (nullif(btrim(i.root_cause), '') is not null)::int as steps_done,
  i.closed_at is null as is_open,
  (i.closed_at is null and i.board_notified_at is null
    and now() > i.detected_at + make_interval(hours => coalesce(public.jsonb_to_numeric(public.statutory_param_value('dpdp.breach_board_report_hours', (i.detected_at at time zone 'Asia/Kolkata')::date)), 72)::int)) as board_overdue
from public.data_incidents i;

comment on view public.data_incidents_view is 'Personal data breaches with the Board''s report deadline, checklist progress and whether it is open (§6.10).';

-- =============================================================================================
-- independence_register(fy) (§6.8, §7.15.4)
-- =============================================================================================
create or replace function public.independence_register(p_financial_year text)
returns table (
  employee_id uuid,
  full_name text,
  designation text,
  role text,
  declaration_id uuid,
  declared_at timestamptz,
  answers jsonb,
  details text,
  has_exceptions boolean,
  updated_at timestamptz
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select e.id, e.full_name, e.designation, p.role::text, d.id, d.declared_at, d.answers, d.details,
         coalesce((select bool_or(a.value = 'true'::jsonb) from jsonb_each(d.answers) a), false),
         d.updated_at
  from public.employees e
  join public.profiles p on p.id = e.profile_id
  left join public.independence_declarations d on d.employee_id = e.id and d.financial_year = p_financial_year
  where e.is_active and e.deleted_at is null and p.is_active and p.role in ('partner', 'manager', 'employee')
  order by (d.id is null) desc, e.full_name
$$;

comment on function public.independence_register(text) is
  'Every active staff member with their independence declaration for the FY (or none yet) (§6.8). The caller''s RLS applies.';

-- =============================================================================================
-- Grants
-- =============================================================================================
revoke execute on function public.retention_summary(), public.independence_register(text) from public, anon;
grant execute on function public.retention_summary(), public.independence_register(text) to authenticated, service_role;
