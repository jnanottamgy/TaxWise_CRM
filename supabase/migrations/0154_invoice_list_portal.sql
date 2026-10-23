-- 0154 · The invoice list (§7.9.1) and the portal's windows onto invoice lines and credit notes (§7.22).
--
--   invoice_list(params)    Partner/Manager: one page of invoices, searched, filtered and sorted in SQL
--                           (§2.3), with the total count and the totals of the whole filtered set
--                           (§7.9.1 "Totals row for the filtered set"). Filters: status (the stored
--                           ones, plus the derived `overdue` and `cancelled`; a stored status never
--                           matches a cancelled invoice), client, invoice-date range, FY, overdue,
--                           awaiting approval, created by, kind. The dashboards link here with
--                           ?status=awaiting_approval · sent,partially_paid,disputed · overdue.
--                           Totals leave cancelled invoices out, and the outstanding total counts
--                           only issued invoices that are Sent, Partially paid or Disputed (what is
--                           still to collect, as the dashboards count it). SECURITY INVOKER: an
--                           Employee or a portal user gets an empty page from RLS.
--   portal_invoice_items    the lines of the signed-in client's issued invoices (through
--                           portal_invoices, 0034), for the portal invoice page and its PDF.
--   portal_credit_notes     the credit notes on those invoices.

set search_path = public, extensions;

create or replace function public.invoice_list(p_params jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  v_q text := nullif(btrim(coalesce(p_params ->> 'q', '')), '');
  v_pattern text;
  v_statuses text[];
  v_client uuid := public.try_uuid(p_params ->> 'client_id');
  v_from date := nullif(p_params ->> 'from', '')::date;
  v_to date := nullif(p_params ->> 'to', '')::date;
  v_fy text := nullif(p_params ->> 'fy', '');
  v_created_by uuid := public.try_uuid(p_params ->> 'created_by');
  v_kind text := nullif(p_params ->> 'kind', '');
  v_overdue boolean := coalesce((p_params ->> 'overdue')::boolean, false);
  v_awaiting boolean := coalesce((p_params ->> 'awaiting_approval')::boolean, false);
  v_sort text := coalesce(nullif(p_params ->> 'sort', ''), 'issue_date');
  v_dir text := case when lower(coalesce(p_params ->> 'dir', 'desc')) = 'asc' then 'asc' else 'desc' end;
  v_offset int := greatest(coalesce(nullif(p_params ->> 'offset', '')::int, 0), 0);
  v_limit int := least(greatest(coalesce(nullif(p_params ->> 'limit', '')::int, 25), 1), 100);
  v_order text;
  v_fy_start date;
  v_fy_end date;
  v_result jsonb;
begin
  if not public.is_manager_or_partner() then
    return jsonb_build_object('total', 0, 'rows', '[]'::jsonb, 'totals', jsonb_build_object(
      'taxable', 0, 'gst', 0, 'reimbursement', 0, 'total', 0, 'received', 0, 'tds', 0, 'credited', 0, 'outstanding', 0));
  end if;

  select array_agg(distinct x) into v_statuses
  from jsonb_array_elements_text(coalesce(p_params -> 'status', '[]'::jsonb)) x
  where x in ('draft', 'awaiting_approval', 'sent', 'partially_paid', 'paid', 'disputed', 'waived', 'overdue', 'cancelled');

  if v_fy is not null and public.is_fy_label(v_fy) then
    v_fy_start := make_date(left(v_fy, 4)::int, 4, 1);
    v_fy_end := make_date(left(v_fy, 4)::int + 1, 3, 31);
  end if;
  if v_q is not null then
    v_pattern := '%' || replace(replace(replace(left(v_q, 100), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  v_order := case v_sort
    when 'invoice_number' then 'b.invoice_number'
    when 'issue_date' then 'b.issue_date'
    when 'client' then 'lower(b.client_name)'
    when 'billing_period_label' then 'lower(b.billing_period_label)'
    when 'taxable_amount' then 'b.taxable_amount'
    when 'gst_amount' then 'b.gst_amount'
    when 'total_amount' then 'b.total_amount'
    when 'amount_received' then 'b.amount_received'
    when 'tds_credited' then 'b.tds_credited'
    when 'outstanding_amount' then 'b.outstanding_amount'
    when 'due_date' then 'b.due_date'
    when 'status' then 'b.display_status'
    else 'b.issue_date'
  end;

  execute format($sql$
    with base as (
      select
        i.id, i.invoice_number, i.invoice_kind, i.client_id, i.issue_date, i.due_date, i.status,
        i.billing_period_label, i.taxable_amount,
        (i.cgst_amount + i.sgst_amount + i.igst_amount) as gst_amount,
        i.cgst_amount, i.sgst_amount, i.igst_amount,
        i.reimbursement_amount, i.round_off, i.total_amount, i.amount_received, i.tds_credited, i.credit_noted, i.outstanding_amount,
        i.sent_channels, i.sent_at, i.last_sent_at, i.requires_approval, i.approved_at, i.cancelled_at, i.revised_from_id,
        i.original_invoice_id, i.created_by, i.created_at, i.updated_at, i.disputed_reason, i.waived_amount,
        coalesce(i.client_name_snapshot, c.display_name) as client_name,
        c.display_name as client_display_name,
        c.client_code::text as client_code,
        cp.full_name as created_by_name,
        o.is_overdue,
        case when o.is_overdue then public.today_ist() - i.due_date else 0 end as days_overdue,
        case when i.cancelled_at is not null then 'cancelled' when o.is_overdue then 'overdue' else i.status::text end as display_status
      from public.invoices i
      join public.clients c on c.id = i.client_id
      left join public.profiles cp on cp.id = i.created_by
      cross join lateral (
        select (i.status in ('sent', 'partially_paid') and i.outstanding_amount > 0 and i.due_date < public.today_ist() and i.cancelled_at is null) as is_overdue
      ) o
      where i.deleted_at is null
        and ($1::uuid is null or i.client_id = $1)
        and ($2::date is null or i.issue_date >= $2)
        and ($3::date is null or i.issue_date <= $3)
        and ($4::date is null or i.issue_date between $4 and $5)
        and ($6::uuid is null or i.created_by = $6)
        and ($7::text is null or i.invoice_kind = $7)
        and (not $8 or o.is_overdue)
        and (not $9 or (i.status = 'awaiting_approval' and i.cancelled_at is null))
        and ($10::text is null
             or i.invoice_number ilike $10
             or c.display_name ilike $10
             or coalesce(i.client_name_snapshot, '') ilike $10
             or c.client_code::text ilike $10
             or coalesce(i.billing_period_label, '') ilike $10)
        and ($11::text[] is null
             or ('overdue' = any ($11) and o.is_overdue)
             or ('cancelled' = any ($11) and i.cancelled_at is not null)
             or (i.cancelled_at is null and i.status::text = any ($11)))
    ),
    ranked as (
      select b.*, row_number() over (order by %1$s %2$s nulls last, b.created_at desc, b.id) as rn from base b
    ),
    page as (
      select r.* from ranked r order by r.rn offset $12 limit $13
    )
    select jsonb_build_object(
      'total', (select count(*) from base),
      'totals', (
        select jsonb_build_object(
          'taxable', coalesce(sum(b.taxable_amount) filter (where b.cancelled_at is null), 0),
          'gst', coalesce(sum(b.gst_amount) filter (where b.cancelled_at is null), 0),
          'reimbursement', coalesce(sum(b.reimbursement_amount) filter (where b.cancelled_at is null), 0),
          'total', coalesce(sum(b.total_amount) filter (where b.cancelled_at is null), 0),
          'received', coalesce(sum(b.amount_received) filter (where b.cancelled_at is null), 0),
          'tds', coalesce(sum(b.tds_credited) filter (where b.cancelled_at is null), 0),
          'credited', coalesce(sum(b.credit_noted) filter (where b.cancelled_at is null), 0),
          'outstanding', coalesce(sum(b.outstanding_amount) filter (where b.cancelled_at is null and b.status in ('sent', 'partially_paid', 'disputed')), 0),
          'cancelled', count(*) filter (where b.cancelled_at is not null),
          'drafts', count(*) filter (where b.cancelled_at is null and b.status in ('draft', 'awaiting_approval'))
        )
        from base b
      ),
      'rows', coalesce((select jsonb_agg(to_jsonb(p) order by p.rn) from page p), '[]'::jsonb)
    )
  $sql$, v_order, v_dir)
  into v_result
  using v_client, v_from, v_to, v_fy_start, v_fy_end, v_created_by, v_kind, v_overdue, v_awaiting, v_pattern, v_statuses, v_offset, v_limit;

  return v_result;
end;
$$;

comment on function public.invoice_list(jsonb) is
  'Partner/Manager: a page of invoices with the count and the totals of the filtered set (§7.9.1); derived overdue and cancelled statuses.';

-- =============================================================================================
-- Portal views (§4.6, §7.22): the signed-in client's own issued invoices only, portal-safe columns.
-- =============================================================================================
create or replace view public.portal_invoice_items with (security_invoker = false, security_barrier = true) as
select
  ii.id,
  ii.invoice_id,
  ii.description,
  ii.sac_code,
  ii.quantity,
  ii.rate,
  ii.amount,
  ii.tax_rate,
  ii.is_reimbursement,
  ii.sort_order
from public.invoice_items ii
join public.portal_invoices pi on pi.id = ii.invoice_id;

comment on view public.portal_invoice_items is 'The lines of the signed-in client''s issued invoices (through portal_invoices) (§7.22).';

create or replace view public.portal_credit_notes with (security_invoker = false, security_barrier = true) as
select
  cn.id,
  cn.credit_note_number,
  cn.invoice_id,
  pi.invoice_number,
  cn.reason,
  cn.reduces_gst,
  cn.taxable_amount,
  cn.tax_rate,
  cn.cgst_amount,
  cn.sgst_amount,
  cn.igst_amount,
  cn.total_amount,
  cn.place_of_supply_code,
  cn.issue_date
from public.credit_notes cn
join public.portal_invoices pi on pi.id = cn.invoice_id;

comment on view public.portal_credit_notes is 'Credit notes on the signed-in client''s issued invoices (§7.22).';

revoke all on public.portal_invoice_items, public.portal_credit_notes from anon, public, authenticated;
grant select on public.portal_invoice_items, public.portal_credit_notes to authenticated, service_role;

revoke execute on function public.invoice_list(jsonb) from public, anon;
grant execute on function public.invoice_list(jsonb) to authenticated, service_role;
