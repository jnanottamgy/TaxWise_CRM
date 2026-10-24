-- 0234 · GST reconciliation: an import of goods has no supplier GSTIN (§6.12, §7.8.1).
--
-- GSTR-2B reports imports (IMPG, from ICEGATE) as bills of entry with a port code and no supplier
-- GSTIN, and the engine (lib/domain/gstr2b.ts, lib/domain/recon.ts) carries them with an empty
-- supplier GSTIN. save_gst_recon_run (0200) stores that as '', the normalize_upper trigger on
-- gst_recon_entries (0011) turns '' into NULL (§6.2), and supplier_gstin was NOT NULL: so saving any
-- reconciliation whose 2B had an import failed with a not-null violation ("Run reconciliation"
-- refused the whole run).
--
-- NULL is the honest value (there is no GSTIN), so the column now allows it. The read model keeps
-- handing the app a string: gst_recon_entry_list shows a missing GSTIN as '' (as the engine and the
-- screens already treat it: "Import (no GSTIN)"), so the supplier roll-up (0204, built on it) groups
-- every import of a run in one row and the screens filter it like any other supplier. Same columns,
-- names and types as 0203, so dependent views are untouched.

set search_path = public, extensions;

alter table public.gst_recon_entries alter column supplier_gstin drop not null;

comment on column public.gst_recon_entries.supplier_gstin is
  'The supplier''s GSTIN, upper-case; NULL for an import of goods (IMPG bill of entry), which has none (§6.12).';

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
  coalesce(l.supplier_gstin::text, '') as supplier_gstin,
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
