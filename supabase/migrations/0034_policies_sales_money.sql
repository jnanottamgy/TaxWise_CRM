-- 0034 · RLS: leads, quotations and money (§4.1, §4.6, §5.4, §5.7, §7.5, §7.9, §7.22).
--
-- Partner/Manager only. Employees get nothing here, not in a page, a search result, an API response
-- or an export (§4.1). The portal reads its own invoices and receipts only through portal_invoices
-- and portal_payment_receipts (0016), and records "I've paid" claims (§7.22).
-- Partner-only acts (§4.1): approving held invoices, waiving, issuing credit notes; purging from the
-- recycle bin.

set search_path = public, extensions;

-- =============================================================================================
-- Leads and quotations (§7.5). Soft delete is an UPDATE (deleted_at); purge is Partner only.
-- =============================================================================================
create policy leads_select on public.leads
  for select to authenticated using ((select public.is_manager_or_partner()));
create policy leads_insert on public.leads
  for insert to authenticated with check ((select public.is_manager_or_partner()));
create policy leads_update on public.leads
  for update to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));
create policy leads_delete on public.leads
  for delete to authenticated using ((select public.is_partner()));

create policy quotations_select on public.quotations
  for select to authenticated using ((select public.is_manager_or_partner()));
create policy quotations_insert on public.quotations
  for insert to authenticated with check ((select public.is_manager_or_partner()));
create policy quotations_update on public.quotations
  for update to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));
create policy quotations_delete on public.quotations
  for delete to authenticated using ((select public.is_partner()));

create policy quotation_items_select on public.quotation_items
  for select to authenticated using ((select public.is_manager_or_partner()));
create policy quotation_items_insert on public.quotation_items
  for insert to authenticated with check ((select public.is_manager_or_partner()));
create policy quotation_items_update on public.quotation_items
  for update to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));
create policy quotation_items_delete on public.quotation_items
  for delete to authenticated using ((select public.is_manager_or_partner()));

create policy quotation_email_logs_select on public.quotation_email_logs
  for select to authenticated using ((select public.is_manager_or_partner()));
create policy quotation_email_logs_insert on public.quotation_email_logs
  for insert to authenticated with check ((select public.is_manager_or_partner()));
create policy quotation_email_logs_update on public.quotation_email_logs
  for update to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));

create policy quotation_follow_ups_select on public.quotation_follow_ups
  for select to authenticated using ((select public.is_manager_or_partner()));
create policy quotation_follow_ups_insert on public.quotation_follow_ups
  for insert to authenticated with check ((select public.is_manager_or_partner()));
create policy quotation_follow_ups_update on public.quotation_follow_ups
  for update to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));
create policy quotation_follow_ups_delete on public.quotation_follow_ups
  for delete to authenticated using ((select public.is_manager_or_partner()));

-- =============================================================================================
-- Invoices (§7.9)
-- =============================================================================================
create policy invoices_select on public.invoices
  for select to authenticated using ((select public.is_manager_or_partner()));
create policy invoices_insert on public.invoices
  for insert to authenticated with check ((select public.is_manager_or_partner()));
create policy invoices_update on public.invoices
  for update to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));
create policy invoices_delete on public.invoices
  for delete to authenticated using ((select public.is_partner()));

-- Partner-only acts on invoices (§4.1, §7.9.2–§7.9.3): approve a held invoice, waive one.
create or replace function public.invoices_role_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if not public.is_api_caller() or public.is_partner() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.status = 'waived' or new.approved_by is not null or new.approved_at is not null then
      raise exception 'USER: Only a Partner can approve or waive an invoice.' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if new.status = 'waived' and old.status is distinct from 'waived' then
    raise exception 'USER: Only a Partner can waive an invoice.' using errcode = 'P0001';
  end if;
  if new.approved_by is distinct from old.approved_by or new.approved_at is distinct from old.approved_at then
    raise exception 'USER: Only a Partner can approve an invoice that is awaiting approval.' using errcode = 'P0001';
  end if;
  if old.status = 'awaiting_approval' and old.requires_approval and old.approved_at is null
     and new.status not in ('draft', 'awaiting_approval') then
    raise exception 'USER: This invoice is waiting for a Partner''s approval, so it can''t be sent yet.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger invoices_role_guard before insert or update on public.invoices
  for each row execute function public.invoices_role_guard();

create policy invoice_items_select on public.invoice_items
  for select to authenticated using ((select public.is_manager_or_partner()));
create policy invoice_items_insert on public.invoice_items
  for insert to authenticated with check ((select public.is_manager_or_partner()));
create policy invoice_items_update on public.invoice_items
  for update to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));
create policy invoice_items_delete on public.invoice_items
  for delete to authenticated using ((select public.is_manager_or_partner()));

-- payment_receipts: recorded and reversed (never deleted, 0017) by Partners/Managers.
create policy payment_receipts_select on public.payment_receipts
  for select to authenticated using ((select public.is_manager_or_partner()));
create policy payment_receipts_insert on public.payment_receipts
  for insert to authenticated
  with check ((select public.is_manager_or_partner()) and recorded_by = (select auth.uid()));
create policy payment_receipts_update on public.payment_receipts
  for update to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));
revoke delete on public.payment_receipts from authenticated;

-- credit_notes: Partners/Managers read; only a Partner issues one (§4.1).
create policy credit_notes_select on public.credit_notes
  for select to authenticated using ((select public.is_manager_or_partner()));
create policy credit_notes_insert on public.credit_notes
  for insert to authenticated with check ((select public.is_partner()) and issued_by = (select auth.uid()));
create policy credit_notes_update on public.credit_notes
  for update to authenticated using ((select public.is_partner())) with check ((select public.is_partner()));
revoke delete on public.credit_notes from authenticated;

-- invoice_follow_ups: collection notes, append-only.
create policy invoice_follow_ups_select on public.invoice_follow_ups
  for select to authenticated using ((select public.is_manager_or_partner()));
create policy invoice_follow_ups_insert on public.invoice_follow_ups
  for insert to authenticated with check ((select public.is_manager_or_partner()) and by_user = (select auth.uid()));
revoke update, delete on public.invoice_follow_ups from authenticated;

create policy invoice_reminders_select on public.invoice_reminders
  for select to authenticated using ((select public.is_manager_or_partner()));
create policy invoice_reminders_insert on public.invoice_reminders
  for insert to authenticated with check ((select public.is_manager_or_partner()));
create policy invoice_reminders_update on public.invoice_reminders
  for update to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));
create policy invoice_reminders_delete on public.invoice_reminders
  for delete to authenticated using ((select public.is_manager_or_partner()));

-- =============================================================================================
-- portal_payment_claims (§7.22 "I've paid"): the client records a claim against one of their own
-- issued invoices; Partners/Managers verify. It never marks the invoice paid.
-- =============================================================================================
create policy portal_payment_claims_select_firm on public.portal_payment_claims
  for select to authenticated using ((select public.is_manager_or_partner()));
create policy portal_payment_claims_select_client on public.portal_payment_claims
  for select to authenticated using (client_id in (select public.portal_client_ids()));
create policy portal_payment_claims_insert_client on public.portal_payment_claims
  for insert to authenticated
  with check (
    client_id in (select public.portal_client_ids())
    and created_by = (select auth.uid())
    and status = 'pending'
    and verified_by is null and verified_at is null and payment_receipt_id is null
    and exists (select 1 from public.portal_invoices pi where pi.id = portal_payment_claims.invoice_id and pi.client_id = portal_payment_claims.client_id)
  );
create policy portal_payment_claims_update_firm on public.portal_payment_claims
  for update to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));
create policy portal_payment_claims_delete_firm on public.portal_payment_claims
  for delete to authenticated using ((select public.is_partner()));

-- tds_statement_entries (§7.9.9): money.
create policy tds_statement_entries_select on public.tds_statement_entries
  for select to authenticated using ((select public.is_manager_or_partner()));
create policy tds_statement_entries_insert on public.tds_statement_entries
  for insert to authenticated with check ((select public.is_manager_or_partner()));
create policy tds_statement_entries_update on public.tds_statement_entries
  for update to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));
create policy tds_statement_entries_delete on public.tds_statement_entries
  for delete to authenticated using ((select public.is_manager_or_partner()));

-- engagement_letters (§4.6 "engagement fees"): Partner/Manager only.
create policy engagement_letters_select on public.engagement_letters
  for select to authenticated using ((select public.is_manager_or_partner()));
create policy engagement_letters_insert on public.engagement_letters
  for insert to authenticated with check ((select public.is_manager_or_partner()));
create policy engagement_letters_update on public.engagement_letters
  for update to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));
create policy engagement_letters_delete on public.engagement_letters
  for delete to authenticated using ((select public.is_manager_or_partner()));

-- =============================================================================================
-- portal_invoices / portal_payment_receipts (0016): same columns, now also requiring an active
-- client role (app_role() = 'client'), so a disabled portal user or a JWT whose role doesn't match
-- the profile sees nothing (§4.6, §0.1 rule 9).
-- =============================================================================================
create or replace view public.portal_invoices with (security_invoker = false, security_barrier = true) as
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
where public.is_client()
  and c.portal_user_id = auth.uid()
  and c.deleted_at is null
  and i.deleted_at is null
  and i.invoice_number is not null
  and i.status not in ('draft', 'awaiting_approval');

create or replace view public.portal_payment_receipts with (security_invoker = false, security_barrier = true) as
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
where public.is_client()
  and c.portal_user_id = auth.uid()
  and c.deleted_at is null
  and i.deleted_at is null
  and i.status not in ('draft', 'awaiting_approval');

revoke all on public.portal_invoices, public.portal_payment_receipts from anon, public;
grant select on public.portal_invoices, public.portal_payment_receipts to authenticated, service_role;

revoke execute on function public.invoices_role_guard() from public, anon, authenticated;

update public.app_meta set value = '0034' where key = 'schema_version';
