-- 0017 · Data-integrity triggers.
--   * task_dependencies: no self-dependency, no cycles (§5.5, §7.6.2)
--   * invoices: settlement columns + sent ↔ partially_paid ↔ paid maintained from receipts and credit
--     notes; Paid / Partially paid can't be set by hand against the settlement (§5.7, §6.5, §7.9.3)
--   * invoices: issued invoices are never edited (§7.9.3, §15 item 12)
--   * payment_receipts: reversed, never deleted; amounts never edited (§5.7, §7.9.4)
--   * audit_logs: insert-only (§4.6, §7.20)
--   * udin_records: upper-case UDIN; counts_towards_tax_audit_ceiling from report_form (§5.12, §6.8)
--   * clients: state_code from the GSTIN (§5.3)
--   * client_services: fee history (§7.3.3)
--   * leads: last_activity_at (§7.5.1)
-- User-facing refusals use 'USER: <plain sentence>' with errcode P0001 (CONVENTIONS §3.4).
-- Functions that must see rows the caller's RLS hides are SECURITY DEFINER with a fixed search_path.

set search_path = public, extensions;

-- =============================================================================================
-- task_dependencies: reject self-dependency and cycles.
-- =============================================================================================
create or replace function public.task_dependencies_guard()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if new.task_id = new.blocker_task_id then
    raise exception 'USER: A task can''t be blocked by itself.' using errcode = 'P0001';
  end if;

  -- Serialise dependency writes so two concurrent inserts can't close a loop between them.
  perform pg_advisory_xact_lock(hashtext('public.task_dependencies'));

  -- Would the new edge (task_id waits on blocker_task_id) close a loop? It does if the blocker
  -- already (transitively) waits on task_id.
  if exists (
    with recursive chain (id) as (
      select d.blocker_task_id
      from public.task_dependencies d
      where d.task_id = new.blocker_task_id
        and d.id is distinct from new.id
      union
      select d.blocker_task_id
      from public.task_dependencies d
      join chain c on d.task_id = c.id
      where d.id is distinct from new.id
    )
    select 1 from chain where chain.id = new.task_id
  ) then
    raise exception 'USER: That would create a loop: the blocking task already waits on this task.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger task_dependencies_guard
  before insert or update of task_id, blocker_task_id on public.task_dependencies
  for each row execute function public.task_dependencies_guard();

-- =============================================================================================
-- invoices: settlement and derived payment status.
--   outstanding = total − received − tds − credit (§6.5)
--   received / tds = sums over receipts that are not reversed; credit = sum of credit notes.
-- =============================================================================================
create or replace function public.invoices_apply_settlement()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_received numeric(14,2);
  v_tds numeric(14,2);
  v_credit numeric(14,2);
  v_derived public.invoice_status;
begin
  select coalesce(sum(r.amount_received), 0), coalesce(sum(r.tds_amount), 0)
    into v_received, v_tds
  from public.payment_receipts r
  where r.invoice_id = new.id and r.reversed_at is null;

  select coalesce(sum(c.total_amount), 0)
    into v_credit
  from public.credit_notes c
  where c.invoice_id = new.id;

  new.amount_received := v_received;
  new.tds_credited := v_tds;
  new.credit_noted := v_credit;
  new.outstanding_amount := new.total_amount - v_received - v_tds - v_credit;

  -- Paid / Partially paid come only from receipts (§7.9.3). Only the settled family moves by itself;
  -- draft, awaiting_approval, disputed and waived are left alone.
  if new.status in ('sent', 'partially_paid', 'paid') then
    v_derived := case
      when new.outstanding_amount <= 0 then 'paid'
      when v_received + v_tds + v_credit > 0 then 'partially_paid'
      else 'sent'
    end;

    if tg_op = 'UPDATE' then
      if new.status = old.status then
        new.status := v_derived;          -- settlement changed (or an unrelated edit): follow it
      end if;
    end if;
    if new.status = 'sent' then
      new.status := v_derived;            -- issuing, or leaving disputed: land on the settled state
    elsif new.status <> v_derived then
      raise exception 'USER: Paid and Partially paid come only from recorded receipts. With what has been received so far, this invoice is %.',
        case v_derived when 'sent' then 'still unpaid' when 'partially_paid' then 'partially paid' else 'paid' end
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

create trigger invoices_apply_settlement
  before insert or update on public.invoices
  for each row execute function public.invoices_apply_settlement();

-- Touch the parent invoice so invoices_apply_settlement recomputes it.
create or replace function public.sync_invoice_settlement()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if tg_op in ('INSERT', 'UPDATE') then
    update public.invoices set outstanding_amount = outstanding_amount where id = new.invoice_id;
  end if;
  if tg_op = 'DELETE' then
    update public.invoices set outstanding_amount = outstanding_amount where id = old.invoice_id;
  elsif tg_op = 'UPDATE' then
    if old.invoice_id is distinct from new.invoice_id then
      update public.invoices set outstanding_amount = outstanding_amount where id = old.invoice_id;
    end if;
  end if;
  return null;
end;
$$;

create trigger payment_receipts_sync_settlement
  after insert or delete on public.payment_receipts
  for each row execute function public.sync_invoice_settlement();

create trigger payment_receipts_sync_settlement_on_update
  after update on public.payment_receipts
  for each row
  when (
    old.amount_received is distinct from new.amount_received
    or old.tds_amount is distinct from new.tds_amount
    or old.reversed_at is distinct from new.reversed_at
    or old.invoice_id is distinct from new.invoice_id
  )
  execute function public.sync_invoice_settlement();

create trigger credit_notes_sync_settlement
  after insert or delete on public.credit_notes
  for each row execute function public.sync_invoice_settlement();

create trigger credit_notes_sync_settlement_on_update
  after update on public.credit_notes
  for each row
  when (old.total_amount is distinct from new.total_amount or old.invoice_id is distinct from new.invoice_id)
  execute function public.sync_invoice_settlement();

-- =============================================================================================
-- invoices: issued invoices are never edited (§7.9.3). Once an invoice has left draft /
-- awaiting_approval its number, client, date, place of supply, amounts and snapshots are frozen,
-- and it can't go back to draft. Corrections: cancel & reissue, credit note or debit note.
-- =============================================================================================
create or replace function public.invoices_issued_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if old.status in ('draft', 'awaiting_approval') then
    return new;
  end if;

  if new.status in ('draft', 'awaiting_approval') then
    raise exception 'USER: An issued invoice can''t go back to draft. Cancel and reissue it instead.'
      using errcode = 'P0001';
  end if;

  if new.invoice_number is distinct from old.invoice_number
     or new.invoice_kind is distinct from old.invoice_kind
     or new.client_id is distinct from old.client_id
     or new.issue_date is distinct from old.issue_date
     or new.place_of_supply_code is distinct from old.place_of_supply_code
     or new.reverse_charge is distinct from old.reverse_charge
     or new.taxable_amount is distinct from old.taxable_amount
     or new.cgst_amount is distinct from old.cgst_amount
     or new.sgst_amount is distinct from old.sgst_amount
     or new.igst_amount is distinct from old.igst_amount
     or new.reimbursement_amount is distinct from old.reimbursement_amount
     or new.round_off is distinct from old.round_off
     or new.total_amount is distinct from old.total_amount
     or new.client_name_snapshot is distinct from old.client_name_snapshot
     or new.client_address_snapshot is distinct from old.client_address_snapshot
     or new.client_gstin_snapshot is distinct from old.client_gstin_snapshot
     or new.firm_gstin_snapshot is distinct from old.firm_gstin_snapshot
     or new.original_invoice_id is distinct from old.original_invoice_id
  then
    raise exception 'USER: An issued invoice can''t be edited. Cancel and reissue it, or raise a credit or debit note.'
      using errcode = 'P0001';
  end if;

  if old.cancelled_at is not null and new.cancelled_at is null then
    raise exception 'USER: A cancelled invoice stays cancelled.' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger invoices_issued_guard
  before update on public.invoices
  for each row execute function public.invoices_issued_guard();

create or replace function public.invoice_items_issued_guard()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_status public.invoice_status;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    select i.status into v_status from public.invoices i where i.id = old.invoice_id;
    if v_status is not null and v_status not in ('draft', 'awaiting_approval') then
      raise exception 'USER: The lines of an issued invoice can''t be changed. Cancel and reissue it, or raise a credit or debit note.'
        using errcode = 'P0001';
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    select i.status into v_status from public.invoices i where i.id = new.invoice_id;
    if v_status is not null and v_status not in ('draft', 'awaiting_approval') then
      raise exception 'USER: The lines of an issued invoice can''t be changed. Cancel and reissue it, or raise a credit or debit note.'
        using errcode = 'P0001';
    end if;
    return new;
  end if;
  return old;
end;
$$;

create trigger invoice_items_issued_guard
  before insert or update or delete on public.invoice_items
  for each row execute function public.invoice_items_issued_guard();

-- =============================================================================================
-- payment_receipts: reversed with a reason, never deleted; the money on a receipt never changes.
-- =============================================================================================
create or replace function public.payment_receipts_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'USER: Receipts are never deleted. Reverse it with a reason instead.' using errcode = 'P0001';
  end if;

  if new.invoice_id is distinct from old.invoice_id
     or new.amount_received is distinct from old.amount_received
     or new.tds_amount is distinct from old.tds_amount
  then
    raise exception 'USER: A recorded receipt can''t be changed. Reverse it with a reason and record it again.'
      using errcode = 'P0001';
  end if;

  if old.reversed_at is not null and new.reversed_at is null then
    raise exception 'USER: A reversed receipt stays reversed. Record a new receipt instead.' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger payment_receipts_guard
  before update or delete on public.payment_receipts
  for each row execute function public.payment_receipts_guard();

-- =============================================================================================
-- audit_logs: insert-only, for everyone (§4.6, §7.20).
-- =============================================================================================
create or replace function public.audit_logs_immutable()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  raise exception 'USER: Audit log entries can''t be changed or deleted.' using errcode = 'P0001';
end;
$$;

create trigger audit_logs_immutable
  before update or delete on public.audit_logs
  for each row execute function public.audit_logs_immutable();

-- =============================================================================================
-- udin_records: UDIN stored upper-case (§6.2); counts_towards_tax_audit_ceiling from report_form
-- (§5.12, §6.8):
--   counted:     3CA, 3CB_44AB_a, 3CB_44AB_b, 3CB_combined
--   not counted: 3CB_44AB_c, 3CB_44AB_d, 3CB_44AB_e, audit_report, certificate, gst_audit, other
--   FORM_26 (2025 Act; category mapping [verify]): as supplied, defaulting to counted
--   revised reports never count separately
-- =============================================================================================
create or replace function public.udin_records_derive()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  new.udin := nullif(upper(btrim(new.udin::text)), '');
  new.counts_towards_tax_audit_ceiling := case
    when new.is_revised then false
    when new.report_form in ('3CA', '3CB_44AB_a', '3CB_44AB_b', '3CB_combined') then true
    when new.report_form = 'FORM_26' then coalesce(new.counts_towards_tax_audit_ceiling, true)
    when new.report_form is null then null
    else false
  end;
  return new;
end;
$$;

create trigger udin_records_derive
  before insert or update on public.udin_records
  for each row execute function public.udin_records_derive();

-- =============================================================================================
-- clients: place of supply (state_code) follows the GSTIN's first two digits (§5.3).
-- =============================================================================================
create or replace function public.clients_derive_state_code()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if new.gstin is null then
    return new;
  end if;
  -- Runs before normalize_identifiers (trigger order is alphabetical), so trim here too.
  if tg_op = 'INSERT' or new.state_code is null then
    new.state_code := substr(btrim(new.gstin::text), 1, 2);
  elsif new.gstin is distinct from old.gstin then
    new.state_code := substr(btrim(new.gstin::text), 1, 2);
  end if;
  return new;
end;
$$;

create trigger clients_derive_state_code
  before insert or update of gstin, state_code on public.clients
  for each row execute function public.clients_derive_state_code();

-- =============================================================================================
-- client_services: record every change to the agreed fee or billing cycle (§7.3.3 fee history).
-- =============================================================================================
create or replace function public.client_services_fee_history()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if tg_op = 'INSERT' then
    if new.agreed_fee is null and new.billing_frequency is null then
      return null;
    end if;
  elsif new.agreed_fee is not distinct from old.agreed_fee
        and new.billing_frequency is not distinct from old.billing_frequency then
    return null;
  end if;

  insert into public.client_service_fee_history (client_service_id, client_id, agreed_fee, billing_frequency, changed_by, changed_at)
  values (new.id, new.client_id, new.agreed_fee, new.billing_frequency, auth.uid(), coalesce(new.fee_agreed_at, now()));
  return null;
end;
$$;

create trigger client_services_fee_history
  after insert or update of agreed_fee, billing_frequency on public.client_services
  for each row execute function public.client_services_fee_history();

-- =============================================================================================
-- leads: last_activity_at moves on every change to the lead and on every timeline event for it
-- (§7.5.1: "leads untouched for 14 days surface on the manager's dashboard").
-- =============================================================================================
create or replace function public.leads_touch_activity()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if new.last_activity_at is not distinct from old.last_activity_at then
    new.last_activity_at := now();
  end if;
  return new;
end;
$$;

create trigger leads_touch_activity
  before update on public.leads
  for each row execute function public.leads_touch_activity();

create or replace function public.timeline_touch_lead()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  update public.leads
     set last_activity_at = greatest(last_activity_at, new.created_at)
   where id = new.lead_id;
  return null;
end;
$$;

create trigger timeline_touch_lead
  after insert on public.client_timeline_events
  for each row when (new.lead_id is not null)
  execute function public.timeline_touch_lead();

-- =============================================================================================
-- updated_at: attach set_updated_at() to every public table with an updated_at column (§5).
-- =============================================================================================
do $$
declare
  r record;
begin
  for r in
    select c.oid::regclass as tbl
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'updated_at' and not a.attisdropped
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and not exists (
        select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'set_updated_at' and not t.tgisinternal
      )
  loop
    execute format(
      'create trigger set_updated_at before insert or update on %s for each row execute function public.set_updated_at()',
      r.tbl
    );
  end loop;
end;
$$;

-- Trigger functions are never called directly.
revoke execute on function
  public.task_dependencies_guard(), public.invoices_apply_settlement(), public.sync_invoice_settlement(),
  public.invoices_issued_guard(), public.invoice_items_issued_guard(), public.payment_receipts_guard(),
  public.audit_logs_immutable(), public.udin_records_derive(), public.clients_derive_state_code(),
  public.client_services_fee_history(), public.leads_touch_activity(), public.timeline_touch_lead(),
  public.set_updated_at(), public.normalize_upper()
from public, anon, authenticated;

update public.app_meta set value = '0017' where key = 'schema_version';
