-- 0203 · Read models for the GST reconciliation and financial statements workpapers (§7.8.1,
-- §7.8.3), so lists are searched, sorted and paged in SQL (§2.3). All security_invoker (the caller's
-- RLS decides which rows exist: Employees their own clients, §4.1) and SELECT-only for the API roles.
-- Derived states (open, latest run, GSTIN mismatch) are computed here, never stored (§0.1 rule 10).
-- Amounts are integer paise, as the engines compute and store them.
--
--   gst_recon_runs_list         every run with its client, who ran it, the bucket counts and ITC
--                               figures from its summary, how many lines are still open, and
--                               whether it is the latest run of its client and month.
--   gst_recon_entry_list        every reconciliation line with sortable columns drawn from its data
--                               (document numbers and dates, taxable values, ITC each side and the
--                               difference), its resolution and its IMS decision.
--   financial_statements_list   every statement with its client, status, who prepared, reviewed and
--                               finalised it, the ledger and unmapped counts, and its checks.

set search_path = public, extensions;

-- =============================================================================================
-- gst_recon_runs_list
-- =============================================================================================
create or replace view public.gst_recon_runs_list with (security_invoker = true) as
select
  r.id,
  r.client_id,
  c.display_name as client_name,
  c.client_code::text as client_code,
  c.gstin::text as client_gstin,
  r.period::text as period,
  to_date(r.period::text, 'MMYYYY') as period_start,
  r.portal_gstin::text as portal_gstin,
  (r.portal_gstin is not null and c.gstin is not null and r.portal_gstin::text <> c.gstin::text) as gstin_mismatch,
  r.previous_run_id,
  r.register_document_id,
  r.created_by,
  d.full_name as created_by_name,
  r.created_at,
  coalesce((r.summary->'summary'->'buckets'->'matched'->>'count')::int, 0) as matched_count,
  coalesce((r.summary->'summary'->'buckets'->'mismatch'->>'count')::int, 0) as mismatch_count,
  coalesce((r.summary->'summary'->'buckets'->'missing_in_books'->>'count')::int, 0) as missing_in_books_count,
  coalesce((r.summary->'summary'->'buckets'->'missing_in_2b'->>'count')::int, 0) as missing_in_2b_count,
  coalesce((r.summary->'summary'->'itc'->>'per2b')::bigint, 0) as itc_per_2b_paise,
  coalesce((r.summary->'summary'->'itc'->>'perBooks')::bigint, 0) as itc_per_books_paise,
  coalesce((r.summary->'summary'->'itc'->>'atRisk')::bigint, 0) as itc_at_risk_paise,
  coalesce((r.summary->'summary'->'itc'->>'unclaimed')::bigint, 0) as unclaimed_itc_paise,
  coalesce(e.open_count, 0) as open_count,
  coalesce(e.follow_up_count, 0) as follow_up_count,
  coalesce(e.resolved_count, 0) as resolved_count,
  coalesce(e.carried_count, 0) as carried_count,
  coalesce(e.ims_pending_count, 0) as ims_pending_count,
  not exists (
    select 1 from public.gst_recon_runs r2
    where r2.client_id = r.client_id and r2.period = r.period
      and (r2.created_at > r.created_at or (r2.created_at = r.created_at and r2.id > r.id))
  ) as is_latest
from public.gst_recon_runs r
join public.clients c on c.id = r.client_id
left join public.employee_directory d on d.profile_id = r.created_by
left join lateral (
  select
    count(*) filter (where x.bucket <> 'matched' and coalesce(x.resolution, 'open') in ('open', 'follow_up_supplier'))::int as open_count,
    count(*) filter (where x.bucket <> 'matched' and x.resolution = 'follow_up_supplier')::int as follow_up_count,
    count(*) filter (where x.bucket <> 'matched' and x.resolution in ('accepted', 'ignore'))::int as resolved_count,
    count(*) filter (where x.origin = 'carried')::int as carried_count,
    count(*) filter (where x.ims_action is not null and x.ims_decided_by is null)::int as ims_pending_count
  from public.gst_recon_entries x
  where x.run_id = r.id
) e on true
where c.deleted_at is null;

comment on view public.gst_recon_runs_list is
  'GST reconciliation runs with client, bucket counts, ITC figures, open lines and whether each is the latest for its client and month (§6.12, §7.8.1).';

-- =============================================================================================
-- gst_recon_entry_list
-- =============================================================================================
create or replace view public.gst_recon_entry_list with (security_invoker = true) as
with lines as (
  select
    x.*,
    r.client_id,
    r.period::text as run_period,
    case when jsonb_typeof(x.data->'portal') = 'object' then x.data->'portal' end as p,
    case when jsonb_typeof(x.data->'books') = 'object' then x.data->'books' end as b
  from public.gst_recon_entries x
  join public.gst_recon_runs r on r.id = x.run_id
)
select
  l.id,
  l.run_id,
  l.client_id,
  l.run_period as period,
  l.entry_key,
  l.bucket,
  l.match_tier,
  l.origin,
  l.first_seen_period::text as first_seen_period,
  l.supplier_gstin::text as supplier_gstin,
  l.supplier_name,
  coalesce(l.p->>'docType', l.b->>'docType') as doc_type,
  l.p->>'section' as portal_section,
  l.p->>'docNumber' as portal_doc_number,
  case when (l.p->>'docDate') ~ '^\d{4}-\d{2}-\d{2}$' then (l.p->>'docDate')::date end as portal_doc_date,
  l.b->>'docNumber' as books_doc_number,
  case when (l.b->>'docDate') ~ '^\d{4}-\d{2}-\d{2}$' then (l.b->>'docDate')::date end as books_doc_date,
  coalesce(l.p->>'docNumber', l.b->>'docNumber') as doc_number,
  coalesce(
    case when (l.p->>'docDate') ~ '^\d{4}-\d{2}-\d{2}$' then (l.p->>'docDate')::date end,
    case when (l.b->>'docDate') ~ '^\d{4}-\d{2}-\d{2}$' then (l.b->>'docDate')::date end
  ) as doc_date,
  (l.p->>'taxable')::bigint as portal_taxable_paise,
  (l.b->>'taxable')::bigint as books_taxable_paise,
  coalesce((l.data->'itc'->>'portal')::bigint, 0) as itc_portal_paise,
  coalesce((l.data->'itc'->>'books')::bigint, 0) as itc_books_paise,
  coalesce((l.data->'itc'->>'portal')::bigint, 0) - coalesce((l.data->'itc'->>'books')::bigint, 0) as itc_difference_paise,
  case when l.bucket = 'missing_in_2b' then coalesce((l.data->'itc'->>'books')::bigint, 0) else coalesce((l.data->'itc'->>'portal')::bigint, 0) end as itc_paise,
  coalesce(l.resolution, 'open') as resolution,
  l.resolution_note,
  l.resolved_by,
  rd.full_name as resolved_by_name,
  l.resolved_at,
  l.ims_action,
  l.ims_reason,
  l.ims_decided_by,
  idd.full_name as ims_decided_by_name,
  l.ims_decided_at,
  l.cleared_by_run_id,
  (l.bucket <> 'matched' and coalesce(l.resolution, 'open') in ('open', 'follow_up_supplier')) as is_open,
  l.data,
  l.created_at,
  l.updated_at
from lines l
left join public.employee_directory rd on rd.profile_id = l.resolved_by
left join public.employee_directory idd on idd.profile_id = l.ims_decided_by;

comment on view public.gst_recon_entry_list is
  'Reconciliation lines with sortable document, amount (paise) and ITC columns, their resolution and IMS decision (§6.12, §7.8.1).';

-- =============================================================================================
-- financial_statements_list
-- =============================================================================================
create or replace view public.financial_statements_list with (security_invoker = true) as
select
  s.id,
  s.client_id,
  c.display_name as client_name,
  c.client_code::text as client_code,
  c.entity_type::text as entity_type,
  s.financial_year,
  s.status,
  s.created_by,
  cb.full_name as created_by_name,
  s.prepared_by,
  pb.full_name as prepared_by_name,
  s.updated_by,
  ub.full_name as updated_by_name,
  s.reviewed_by,
  rb.full_name as reviewed_by_name,
  s.reviewed_at,
  s.finalised_by,
  fb.full_name as finalised_by_name,
  s.finalised_at,
  s.review_note,
  s.source_document_id,
  s.previous_statement_id,
  case when jsonb_typeof(s.ledgers) = 'array' then jsonb_array_length(s.ledgers) else 0 end as ledger_count,
  case when jsonb_typeof(s.ledgers) = 'array'
    then (select count(*)::int from jsonb_array_elements(s.ledgers) l where coalesce(l->>'bucket', '') = '')
    else 0 end as unmapped_count,
  coalesce((s.statements->>'allChecksPassed')::boolean, false) as all_checks_passed,
  case when jsonb_typeof(s.statements->'checks') = 'array'
    then (select count(*)::int from jsonb_array_elements(s.statements->'checks') k where k->>'status' = 'fail')
    else 0 end as failed_checks,
  (s.statements->'totals'->'current'->>'profit')::bigint as profit_paise,
  (s.statements->'totals'->'current'->>'assets')::bigint as total_assets_paise,
  (s.statements->'totals'->'current'->>'totalIncome')::bigint as total_income_paise,
  s.created_at,
  s.updated_at
from public.financial_statements s
join public.clients c on c.id = s.client_id
left join public.employee_directory cb on cb.profile_id = s.created_by
left join public.employee_directory pb on pb.profile_id = s.prepared_by
left join public.employee_directory ub on ub.profile_id = s.updated_by
left join public.employee_directory rb on rb.profile_id = s.reviewed_by
left join public.employee_directory fb on fb.profile_id = s.finalised_by
where c.deleted_at is null;

comment on view public.financial_statements_list is
  'Financial statements with client, status and who prepared, reviewed and finalised them, ledger and unmapped counts and the checks (§6.13, §7.8.3).';

-- =============================================================================================
-- Grants: SELECT only (§4.6, 0043).
-- =============================================================================================
revoke all on public.gst_recon_runs_list, public.gst_recon_entry_list, public.financial_statements_list from anon, public;
revoke insert, update, delete, truncate, references, trigger
  on public.gst_recon_runs_list, public.gst_recon_entry_list, public.financial_statements_list from authenticated;
grant select on public.gst_recon_runs_list, public.gst_recon_entry_list, public.financial_statements_list to authenticated, service_role;
