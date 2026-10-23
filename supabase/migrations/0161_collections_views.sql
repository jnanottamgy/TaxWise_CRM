-- 0161 · Collections: the read models behind the collection forecast, the retainer drafts queue and
-- the TDS credit register (§7.9.5, §7.9.6, §7.9.9).
--
--   collection_forecast    the latest payment promise on each invoice (§7.9.5 "Promised dates feed
--                          the collection forecast"): the date promised, the balance when it was
--                          promised, what has been settled since, and whether it was kept, is
--                          still open, or was missed. Cancelled, waived and deleted invoices drop
--                          out.
--   retainer_draft_queue   the retainer job's drafts with their invoice, client and engagement, for
--                          the "Retainer drafts" page (§7.9.6), sortable in SQL.
--   tds_credit_register    every live receipt with TDS (§7.9.9): client, invoice, quarter, section,
--                          deductor TAN, amount, status, and the 26AS / AIS line it matched.
--
-- All security_invoker: the caller's RLS applies (money, so Partners and Managers only, §4.1).
-- SELECT-only for the API roles (0043).

set search_path = public, extensions;

-- =============================================================================================
-- collection_forecast
-- =============================================================================================
create or replace view public.collection_forecast with (security_invoker = true) as
with latest as (
  select distinct on (f.invoice_id)
    f.invoice_id,
    f.id as follow_up_id,
    f.promised_payment_date,
    f.created_at as promised_at,
    f.by_user as promised_to,
    f.channel,
    f.notes
  from public.invoice_follow_ups f
  where f.promised_payment_date is not null
  order by f.invoice_id, f.created_at desc, f.id desc
)
select
  l.invoice_id,
  l.follow_up_id,
  l.promised_payment_date,
  l.promised_at,
  l.promised_to,
  l.channel,
  l.notes,
  i.client_id,
  c.display_name as client_name,
  c.client_code,
  i.invoice_number,
  i.status,
  i.issue_date,
  i.due_date,
  i.total_amount,
  i.outstanding_amount,
  coalesce(s.settled, 0)::numeric(14,2) as settled_since_promise,
  coalesce(cn.credited, 0)::numeric(14,2) as credited_since_promise,
  -- The balance when the promise was made: what is outstanding now, plus what came in since.
  (i.outstanding_amount + coalesce(s.settled, 0) + coalesce(cn.credited, 0))::numeric(14,2) as promised_amount,
  case
    when i.outstanding_amount <= 0 then 'kept'
    when l.promised_payment_date < public.today_ist() then 'missed'
    else 'open'
  end as promise_status
from latest l
join public.invoices i on i.id = l.invoice_id
join public.clients c on c.id = i.client_id
left join lateral (
  select sum(r.amount_received + r.tds_amount) as settled
  from public.payment_receipts r
  where r.invoice_id = l.invoice_id and r.reversed_at is null and r.created_at >= l.promised_at
) s on true
left join lateral (
  select sum(n.total_amount) as credited
  from public.credit_notes n
  where n.invoice_id = l.invoice_id and n.created_at >= l.promised_at
) cn on true
where i.deleted_at is null
  and i.cancelled_at is null
  and i.status in ('sent', 'partially_paid', 'paid', 'disputed');

comment on view public.collection_forecast is
  'The latest payment promise per invoice, with the balance when promised, what was settled since, and kept / open / missed (§7.9.5).';

-- =============================================================================================
-- retainer_draft_queue
-- =============================================================================================
create or replace view public.retainer_draft_queue with (security_invoker = true) as
select
  d.id,
  d.run_id,
  r.run_date,
  d.invoice_id,
  d.client_service_id,
  d.billing_date,
  d.period_label,
  i.status,
  i.invoice_number,
  i.issue_date,
  i.due_date,
  i.taxable_amount,
  (i.cgst_amount + i.sgst_amount + i.igst_amount)::numeric(14,2) as gst_amount,
  i.total_amount,
  i.requires_approval,
  i.approved_at,
  i.submitted_at,
  i.updated_at as invoice_updated_at,
  i.deleted_at,
  i.cancelled_at,
  i.created_by,
  i.client_id,
  c.display_name as client_name,
  c.client_code,
  c.status as client_status,
  c.email as client_email,
  s.service_type,
  s.custom_name,
  s.frequency,
  s.billing_frequency,
  d.created_at
from public.retainer_drafts d
join public.retainer_runs r on r.id = d.run_id
join public.invoices i on i.id = d.invoice_id
join public.clients c on c.id = i.client_id
left join public.client_services s on s.id = d.client_service_id;

comment on view public.retainer_draft_queue is
  'The retainer job''s draft invoices with their client and engagement, for the Retainer drafts queue (§7.9.6).';

-- =============================================================================================
-- tds_credit_register
-- =============================================================================================
create or replace view public.tds_credit_register with (security_invoker = true) as
select
  r.id,
  r.receipt_number,
  r.payment_date,
  r.amount_received,
  r.tds_amount,
  r.tds_section,
  coalesce(
    r.tds_quarter,
    'Q' || ((((extract(month from r.payment_date)::int - 4 + 12) % 12) / 3) + 1)::text || ' ' || public.financial_year_label(r.payment_date)
  ) as quarter,
  public.financial_year_label(r.payment_date) as financial_year,
  r.tds_status,
  r.tds_reflected_on,
  r.tds_claimed_on,
  r.tds_claimed_in,
  r.tds_status_note,
  r.tds_status_changed_at,
  r.tds_status_changed_by,
  coalesce(r.deductor_tan, c.tan) as deductor_tan,
  r.deductor_tan as receipt_deductor_tan,
  r.invoice_id,
  i.invoice_number,
  i.issue_date as invoice_date,
  i.client_id,
  c.display_name as client_name,
  c.client_code,
  m.entry_id as matched_entry_id,
  r.created_at,
  r.updated_at
from public.payment_receipts r
join public.invoices i on i.id = r.invoice_id
join public.clients c on c.id = i.client_id
left join public.tds_statement_matches m on m.receipt_id = r.id
where r.tds_amount > 0
  and r.reversed_at is null
  and i.deleted_at is null;

comment on view public.tds_credit_register is
  'Every live receipt with TDS: client, invoice, quarter, section, deductor TAN, amount, Expected / Reflected / Claimed, and its 26AS / AIS match (§7.9.9).';

revoke all on public.collection_forecast, public.retainer_draft_queue, public.tds_credit_register from anon, public;
revoke insert, update, delete, truncate, references, trigger
  on public.collection_forecast, public.retainer_draft_queue, public.tds_credit_register from authenticated;
grant select on public.collection_forecast, public.retainer_draft_queue, public.tds_credit_register to authenticated, service_role;
