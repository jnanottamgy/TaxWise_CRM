-- 0204 · The supplier roll-up of a GST reconciliation (§6.12 "a supplier roll-up (whom to chase)",
-- §7.8.1): one row per run and supplier GSTIN, computed live from the lines so a resolution moves
-- the figures at once. Security invoker over gst_recon_entry_list (the caller's RLS decides) and
-- SELECT-only for the API roles. Amounts are integer paise.
--
--   itc_at_risk_paise      open lines only: booked documents the supplier hasn't reported (credit
--                          notes excluded) plus the books' GST above 2B on mismatched pairs
--   unclaimed_itc_paise    open lines only: 2B documents not booked, ITC available (credit notes
--                          and "ITC not available" excluded)
--   chase_count            open lines the supplier must act on (not in 2B, or mismatched)

set search_path = public, extensions;

create or replace view public.gst_recon_supplier_rollup with (security_invoker = true) as
select
  l.run_id,
  l.client_id,
  l.supplier_gstin,
  max(l.supplier_name) as supplier_name,
  count(*)::int as line_count,
  count(*) filter (where l.bucket = 'matched')::int as matched_count,
  count(*) filter (where l.bucket = 'mismatch')::int as mismatch_count,
  count(*) filter (where l.bucket = 'missing_in_books')::int as missing_in_books_count,
  count(*) filter (where l.bucket = 'missing_in_2b')::int as missing_in_2b_count,
  count(*) filter (where l.origin = 'carried')::int as carried_count,
  count(*) filter (where l.is_open)::int as open_count,
  count(*) filter (where l.is_open and l.bucket in ('missing_in_2b', 'mismatch'))::int as chase_count,
  count(*) filter (where l.is_open and l.resolution = 'follow_up_supplier')::int as following_up_count,
  coalesce(sum(
    case
      when l.is_open and l.bucket = 'missing_in_2b' and coalesce(l.doc_type, '') not in ('credit_note', 'isd_credit_note') then l.itc_books_paise
      when l.is_open and l.bucket = 'mismatch' then greatest(0, l.itc_books_paise - l.itc_portal_paise)
      else 0
    end
  ), 0)::bigint as itc_at_risk_paise,
  coalesce(sum(
    case
      when l.is_open and l.bucket = 'missing_in_books' and coalesce(l.doc_type, '') not in ('credit_note', 'isd_credit_note')
        and coalesce(l.data->'portal'->>'itcAvailable', '') <> 'false' then l.itc_portal_paise
      else 0
    end
  ), 0)::bigint as unclaimed_itc_paise,
  coalesce(sum(case when l.bucket = 'mismatch' then l.itc_portal_paise - l.itc_books_paise else 0 end), 0)::bigint as mismatch_difference_paise,
  max(l.resolved_at) filter (where l.resolution = 'follow_up_supplier') as last_follow_up_at
from public.gst_recon_entry_list l
group by l.run_id, l.client_id, l.supplier_gstin;

comment on view public.gst_recon_supplier_rollup is
  'Per run and supplier: line counts by bucket, open lines, ITC at risk and unclaimed on open lines, the mismatch difference (paise) (§6.12 supplier roll-up).';

revoke all on public.gst_recon_supplier_rollup from anon, public;
revoke insert, update, delete, truncate, references, trigger on public.gst_recon_supplier_rollup from authenticated;
grant select on public.gst_recon_supplier_rollup to authenticated, service_role;
