-- 0016 · Views: derived states (§0.1 rule 10), fee-free and invite-link-free projections (§4.6),
-- portal-safe invoice data (§4.6, §7.22), covers in force (§4.7), WhatsApp device links (§7.25.7),
-- the tax-audit ceiling (§5.12, §6.8).
--
-- Views over RLS-protected tables are security_invoker = true, so the caller's RLS applies.
-- The two portal views are the exception (security_invoker = false + security_barrier): the portal
-- reads invoices ONLY through them (§4.6), so they carry their own row filter — the signed-in
-- user's client, linked through clients.portal_user_id (§7.22) — and expose portal-safe columns only.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------------------------
-- tasks_view (§5.5): is_overdue = status not in (filed_done) and due_date < today_ist()
-- ---------------------------------------------------------------------------------------------
create view public.tasks_view with (security_invoker = true) as
select
  t.*,
  coalesce(t.status <> 'filed_done' and t.due_date < public.today_ist(), false) as is_overdue,
  case when t.status <> 'filed_done' and t.due_date < public.today_ist()
       then public.today_ist() - t.due_date else 0 end as days_overdue
from public.tasks t;

comment on view public.tasks_view is 'tasks + derived is_overdue / days_overdue (§5.5, §0.1 rule 10).';

-- ---------------------------------------------------------------------------------------------
-- invoices_view (§5.7): is_overdue only for sent / partially_paid with outstanding > 0 after the
-- due date. A draft is never overdue. A cancelled invoice (cancel & reissue, §7.9.3) is never overdue.
-- display_status: 'cancelled' | 'overdue' | the stored status (§7.9.1 "status incl. derived Overdue").
-- ---------------------------------------------------------------------------------------------
create view public.invoices_view with (security_invoker = true) as
select
  i.*,
  o.is_overdue,
  case when o.is_overdue then public.today_ist() - i.due_date else 0 end as days_overdue,
  case
    when i.cancelled_at is not null then 'cancelled'
    when o.is_overdue then 'overdue'
    else i.status::text
  end as display_status
from public.invoices i
cross join lateral (
  select (
    i.status in ('sent', 'partially_paid')
    and i.outstanding_amount > 0
    and i.due_date < public.today_ist()
    and i.cancelled_at is null
  ) as is_overdue
) o;

comment on view public.invoices_view is
  'invoices + derived is_overdue / days_overdue / display_status; a draft is never overdue (§5.7, §7.9.3).';

-- ---------------------------------------------------------------------------------------------
-- compliance_events_view (§5.6): is_overdue for pending events past their due date.
-- ---------------------------------------------------------------------------------------------
create view public.compliance_events_view with (security_invoker = true) as
select
  e.*,
  (e.status = 'pending' and e.due_date < public.today_ist()) as is_overdue,
  case when e.status = 'pending' and e.due_date < public.today_ist()
       then public.today_ist() - e.due_date else 0 end as days_overdue,
  e.due_date - public.today_ist() as days_until_due
from public.compliance_events e;

comment on view public.compliance_events_view is
  'compliance_events + derived is_overdue / days_overdue / days_until_due (§5.6, §0.1 rule 10).';

-- ---------------------------------------------------------------------------------------------
-- covers_in_force (§5.13, §4.7): now() >= starts_at and now() < ends_at and revoked_at is null.
-- ---------------------------------------------------------------------------------------------
create view public.covers_in_force with (security_invoker = true) as
select c.*
from public.client_covers c
where now() >= c.starts_at
  and now() < c.ends_at
  and c.revoked_at is null;

comment on view public.covers_in_force is 'Covers whose window contains now() and that are not revoked (§4.7).';

-- ---------------------------------------------------------------------------------------------
-- client_services_public (§4.6, §5.3): the engagement without fee data, for Employees.
-- Leaves out agreed_fee, billing_frequency, auto_invoice, next_billing_date (spec) and also every
-- other billing column (fee_agreed_at, sac_code, last_auto_invoiced_at, source_quotation_item_id),
-- since Employees never receive fee, invoice or quotation data (§4.1).
-- ---------------------------------------------------------------------------------------------
create view public.client_services_public with (security_invoker = true) as
select
  s.id,
  s.client_id,
  s.service_type,
  s.custom_name,
  s.frequency,
  s.is_active,
  s.next_due_date,
  s.created_at,
  s.updated_at
from public.client_services s;

comment on view public.client_services_public is 'client_services without fee or billing columns (§4.6).';

-- ---------------------------------------------------------------------------------------------
-- client_whatsapp_groups_public (§5.13, §4.6): every column except invite_link.
-- ---------------------------------------------------------------------------------------------
create view public.client_whatsapp_groups_public with (security_invoker = true) as
select
  g.id,
  g.client_id,
  g.name,
  g.purpose,
  g.is_primary,
  g.status,
  g.created_on,
  g.created_by_number_id,
  g.checklist,
  g.last_opened_at,
  g.last_opened_by,
  g.closed_at,
  g.closed_reason,
  g.notes,
  g.deleted_at,
  g.created_at,
  g.updated_at
from public.client_whatsapp_groups g;

comment on view public.client_whatsapp_groups_public is 'client_whatsapp_groups without invite_link (§5.13).';

-- ---------------------------------------------------------------------------------------------
-- portal_invoices (§4.6, §7.22): the client portal's only window onto invoices. Issued, not
-- deleted invoices of the client whose portal_user_id is the signed-in user; portal-safe columns.
-- ---------------------------------------------------------------------------------------------
create view public.portal_invoices with (security_invoker = false, security_barrier = true) as
select
  i.id,
  i.invoice_number,
  i.invoice_kind,
  i.client_id,
  i.issue_date,
  i.due_date,
  i.status,
  case
    when i.cancelled_at is not null then 'cancelled'
    when i.status in ('sent', 'partially_paid') and i.outstanding_amount > 0 and i.due_date < public.today_ist() then 'overdue'
    else i.status::text
  end as display_status,
  (i.cancelled_at is null and i.status in ('sent', 'partially_paid') and i.outstanding_amount > 0
    and i.due_date < public.today_ist()) as is_overdue,
  i.client_name_snapshot,
  i.client_address_snapshot,
  i.client_gstin_snapshot,
  i.place_of_supply_code,
  i.firm_gstin_snapshot,
  i.reverse_charge,
  i.taxable_amount,
  i.cgst_amount,
  i.sgst_amount,
  i.igst_amount,
  i.reimbursement_amount,
  i.round_off,
  i.total_amount,
  i.amount_received,
  i.tds_credited,
  i.credit_noted,
  i.outstanding_amount,
  i.service_type,
  i.billing_period_label,
  i.notes,
  i.terms,
  i.irn,
  i.irn_ack_no,
  i.irn_ack_date,
  i.signed_qr,
  i.sent_at,
  i.cancelled_at,
  i.created_at
from public.invoices i
join public.clients c on c.id = i.client_id
where c.portal_user_id = auth.uid()
  and c.deleted_at is null
  and i.deleted_at is null
  and i.invoice_number is not null
  and i.status not in ('draft', 'awaiting_approval');

revoke all on public.portal_invoices from anon;
grant select on public.portal_invoices to authenticated;

comment on view public.portal_invoices is
  'Portal-safe invoice columns for the signed-in client (clients.portal_user_id = auth.uid()) (§4.6, §7.22).';

-- portal_payment_receipts (§7.22 "Invoices: list, PDF download, receipts"): receipts of the
-- client's portal invoices; no internal notes or who recorded them.
create view public.portal_payment_receipts with (security_invoker = false, security_barrier = true) as
select
  r.id,
  r.receipt_number,
  r.invoice_id,
  i.invoice_number,
  r.payment_date,
  r.amount_received,
  r.tds_amount,
  r.method,
  r.reference,
  r.reversed_at,
  r.created_at
from public.payment_receipts r
join public.invoices i on i.id = r.invoice_id
join public.clients c on c.id = i.client_id
where c.portal_user_id = auth.uid()
  and c.deleted_at is null
  and i.deleted_at is null
  and i.status not in ('draft', 'awaiting_approval');

revoke all on public.portal_payment_receipts from anon;
grant select on public.portal_payment_receipts to authenticated;

comment on view public.portal_payment_receipts is
  'Portal-safe receipt columns for the signed-in client''s invoices (§7.22).';

-- ---------------------------------------------------------------------------------------------
-- whatsapp_links_per_number (§5.13, §7.25.7): active links per firm number (not unlinked, PC not
-- revoked) against firm_settings.whatsapp_linked_device_limit.
-- ---------------------------------------------------------------------------------------------
create view public.whatsapp_links_per_number with (security_invoker = true) as
select
  n.id as number_id,
  n.label,
  n.kind,
  n.number,
  n.is_active,
  count(d.id)::int as active_links,
  fs.whatsapp_linked_device_limit::int as device_limit,
  (fs.whatsapp_linked_device_limit is not null and count(d.id) >= fs.whatsapp_linked_device_limit) as at_limit,
  (fs.whatsapp_linked_device_limit is not null and count(d.id) > fs.whatsapp_linked_device_limit) as over_limit
from public.firm_whatsapp_numbers n
left join public.desktop_device_numbers dn on dn.number_id = n.id and dn.unlinked_at is null
left join public.desktop_devices d on d.id = dn.device_id and d.revoked_at is null
left join public.firm_settings fs on fs.id = 1
group by n.id, n.label, n.kind, n.number, n.is_active, fs.whatsapp_linked_device_limit;

comment on view public.whatsapp_links_per_number is
  'Active PC links per firm WhatsApp number vs the linked-device limit (§7.25.7).';

-- ---------------------------------------------------------------------------------------------
-- tax_audit_ceiling_view (§5.12, §6.8): per signing member per FY (by the date signed), the tax
-- audit reports that count towards the ICAI ceiling, plus "audits signed elsewhere".
--   * counted forms: udin_records.counts_towards_tax_audit_ceiling (derived from report_form, 0017):
--     3CA, 3CB u/s 44AB(a)/(b)/combined (and Form 26 unless marked otherwise); not 3CB (c)/(d)/(e);
--   * revised reports don't count separately (is_revised rows never count);
--   * head office and branch audits of the same assessee for the same year count as one
--     (distinct client + FY covered).
-- ceiling: statutory parameter 'audit.tax_audit_ceiling' in force on 1 April of that FY.
-- warn_at: parameter 'audit.tax_audit_ceiling_warn_at' (array, e.g. [50,58]) or the ceiling
-- parameter's own "warn_at" member, when present.
-- ---------------------------------------------------------------------------------------------
create view public.tax_audit_ceiling_view with (security_invoker = true) as
with signed as (
  select
    u.signing_partner_id as member_profile_id,
    public.financial_year_label(u.signed_on) as financial_year,
    count(distinct case
      when u.client_id is null then u.id::text
      else u.client_id::text || '|' || coalesce(u.financial_year, fr.financial_year, ae.financial_year, u.id::text)
    end)::int as reports_counted,
    count(*)::int as udin_rows_counted
  from public.udin_records u
  left join public.filing_records fr on fr.id = u.filing_record_id
  left join public.audit_engagements ae on ae.id = u.audit_engagement_id
  where u.signing_partner_id is not null
    and u.counts_towards_tax_audit_ceiling
    and not u.is_revised
  group by 1, 2
),
merged as (
  select
    coalesce(s.member_profile_id, e.member_profile_id) as member_profile_id,
    coalesce(s.financial_year, e.financial_year) as financial_year,
    coalesce(s.reports_counted, 0) as signed_in_firm,
    coalesce(s.udin_rows_counted, 0) as udin_rows_counted,
    coalesce(e.audits_signed_elsewhere, 0) as signed_elsewhere
  from signed s
  full join public.tax_audit_external_counts e
    on e.member_profile_id = s.member_profile_id and e.financial_year = s.financial_year
),
params as (
  select
    m.*,
    public.statutory_param_value('audit.tax_audit_ceiling', public.fy_start_date(m.financial_year)) as ceiling_value,
    public.statutory_param_value('audit.tax_audit_ceiling_warn_at', public.fy_start_date(m.financial_year)) as warn_value
  from merged m
),
computed as (
  select
    p.member_profile_id,
    p.financial_year,
    p.signed_in_firm,
    p.udin_rows_counted,
    p.signed_elsewhere,
    p.signed_in_firm + p.signed_elsewhere as total_count,
    public.jsonb_to_numeric(p.ceiling_value)::int as ceiling,
    coalesce(
      case when jsonb_typeof(p.warn_value) = 'array' then p.warn_value end,
      case when jsonb_typeof(p.ceiling_value) = 'object' and jsonb_typeof(p.ceiling_value -> 'warn_at') = 'array'
           then p.ceiling_value -> 'warn_at' end
    ) as warn_at
  from params p
)
select
  c.member_profile_id,
  pr.full_name as member_name,
  pr.icai_membership_no,
  c.financial_year,
  c.signed_in_firm,
  c.udin_rows_counted,
  c.signed_elsewhere,
  c.total_count,
  c.ceiling,
  case when c.ceiling is not null then c.ceiling - c.total_count end as remaining,
  c.warn_at,
  case
    when c.ceiling is null then null
    when c.total_count > c.ceiling then 'over'
    when c.total_count = c.ceiling then 'at_ceiling'
    when c.warn_at is not null and exists (
      select 1 from jsonb_array_elements(c.warn_at) w
      where public.jsonb_to_numeric(w) is not null and c.total_count >= public.jsonb_to_numeric(w)
    ) then 'near'
    else null
  end as warning
from computed c
left join public.profiles pr on pr.id = c.member_profile_id;

comment on view public.tax_audit_ceiling_view is
  'Per member per FY: tax audit reports counted towards the ICAI ceiling, incl. audits signed elsewhere (§6.8).';

update public.app_meta set value = '0016' where key = 'schema_version';
