-- 0044 · Fixes from the security review of the database layer (tests/db/security-review.test.ts).
--
-- 1. Invoice approval gate (§4.1 "Raise an invoice above the approval limit without approval":
--    Manager ❌ (held for a Partner); §7.9.2 "a Manager-raised invoice above invoice_approval_limit
--    (incl. GST) saves as Awaiting approval. It can't be sent … The gate is frozen at creation").
--    0034 only refused sending while the stored status was awaiting_approval and requires_approval was
--    already true, so a Manager could insert an over-limit invoice as Sent, clear requires_approval,
--    or move a held invoice to Draft and send it from there. Now, for everyone but a Partner:
--      * on INSERT requires_approval is set when a limit is in force and the total exceeds it;
--      * requires_approval can be set but never cleared (frozen);
--      * raising an unissued invoice's total above the limit holds it too, and an approved amount
--        can't be changed (the approval was for that amount);
--      * an invoice that requires approval and has none can't leave Draft / Awaiting approval.
--    Mirrors invoiceNeedsApproval() / canSendInvoice() in lib/domain/approvals.ts.
--
-- 2. Quotation approval gate (§4.1 "Send a quotation to a client: Manager ✅ if under the quotation
--    approval limit, else ❌ (held)"; §5.2 quotation_approval_limit: null = Managers' quotations
--    always need Partner approval, 0 = never). Nothing in the database enforced it: a Manager could
--    approve their own quotation or set it Sent. Now, for everyone but a Partner: approving
--    (status approved, approved_by / approved_at) is refused; a quotation leaves Draft / Pending
--    approval for Sent / Viewed / Accepted / Rejected only when it is approved or needs no approval
--    (quotationNeedsApproval() in lib/domain/approvals.ts: a Partner's own quotation never does);
--    and created_by is the caller's own id (so a Manager's quotation can't pass for a Partner's).
--
-- 3. activity_logs (§4.1 "An employee never receives fee, invoice, receipt, credit note, quotation or
--    lead data"). can_see_entity('message', …) ignored is_money_message(), so Employees read the
--    history of invoice and quotation emails; and a money-side action logged against a client
--    (invoice_created, fee_changed …) was readable too. 0043 closed the same gap for the timeline and
--    the message history; activity_logs now follows the same rule for reads and writes.
--
-- 4. client-documents storage (§0.1 rule 11 soft delete, §7.22 the portal uploads, never deletes):
--    a portal user could delete the file behind a document they had uploaded, even after the firm
--    accepted it. Deleting files is staff work (their own uploads; any file for Partners/Managers).
--
-- 5. audit_logs (§4.6 "no UPDATE or DELETE for anyone"): row triggers don't fire on TRUNCATE, and the
--    service role holds TRUNCATE by default. A statement trigger now refuses it, and the privilege is
--    revoked.
--
-- 6. employee_leave (§0 "Manager: … not other Managers or Partners", §4.1): Managers could edit the
--    dates of, or delete, a Partner's or another Manager's leave (only the decision was guarded).
--    A Manager now changes or deletes leave of Employees, and their own requests; a Partner the rest.

set search_path = public, extensions;

-- =============================================================================================
-- 1. invoices_role_guard (replaces 0034)
-- =============================================================================================
create or replace function public.invoices_role_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_limit numeric(14,2);
begin
  if not public.is_api_caller() or public.is_partner() then
    return new;
  end if;

  select fs.invoice_approval_limit into v_limit from public.firm_settings fs where fs.id = 1;

  if tg_op = 'INSERT' then
    if new.status = 'waived' or new.approved_by is not null or new.approved_at is not null then
      raise exception 'USER: Only a Partner can approve or waive an invoice.' using errcode = 'P0001';
    end if;
    -- §7.9.2: over the limit (incl. GST) → held for a Partner; frozen at creation.
    if v_limit is not null and new.total_amount > v_limit then
      new.requires_approval := true;
    end if;
    if new.requires_approval and new.status not in ('draft', 'awaiting_approval') then
      raise exception 'USER: This invoice is over the approval limit and waits for a Partner''s approval before it can be sent.'
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  if new.status = 'waived' and old.status is distinct from 'waived' then
    raise exception 'USER: Only a Partner can waive an invoice.' using errcode = 'P0001';
  end if;
  if new.approved_by is distinct from old.approved_by or new.approved_at is distinct from old.approved_at then
    raise exception 'USER: Only a Partner can approve an invoice that is awaiting approval.' using errcode = 'P0001';
  end if;
  if old.requires_approval and not new.requires_approval then
    raise exception 'USER: Whether an invoice needs a Partner''s approval is fixed when it is created; only a Partner can release it.'
      using errcode = 'P0001';
  end if;

  -- An unissued invoice whose amount changes: an approved amount stays as approved, and a new total
  -- above the limit is held like a new invoice would be.
  if old.status in ('draft', 'awaiting_approval') and new.total_amount is distinct from old.total_amount then
    if old.requires_approval and old.approved_at is not null then
      raise exception 'USER: A Partner approved this invoice at its current amount. Ask a Partner to change it, or raise a new invoice.'
        using errcode = 'P0001';
    end if;
    if v_limit is not null and new.total_amount > v_limit then
      new.requires_approval := true;
    end if;
  end if;

  if new.requires_approval and new.approved_at is null and new.status not in ('draft', 'awaiting_approval') then
    raise exception 'USER: This invoice is waiting for a Partner''s approval, so it can''t be sent yet.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

comment on function public.invoices_role_guard() is
  'Trigger: Partner-only acts on invoices (approve, waive) and the approval gate for everyone else: requires_approval set at creation over invoice_approval_limit, never cleared, re-applied when an unissued total rises; a held invoice can''t be issued unapproved (§4.1, §7.9.2).';

-- =============================================================================================
-- 2. quotations_role_guard (new)
-- =============================================================================================
create or replace function public.quotations_role_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_limit numeric(14,2);
  v_by_partner boolean;
begin
  if not public.is_api_caller() or public.is_partner() then
    return new;
  end if;

  if (tg_op = 'INSERT' or new.created_by is distinct from old.created_by) and new.created_by is distinct from auth.uid() then
    raise exception 'USER: Create quotations in your own name.' using errcode = 'P0001';
  end if;

  if (tg_op = 'INSERT' and (new.approved_by is not null or new.approved_at is not null or new.status = 'approved'))
     or (tg_op = 'UPDATE' and (
          (new.approved_by is not null and new.approved_by is distinct from old.approved_by)
          or (new.approved_at is not null and new.approved_at is distinct from old.approved_at)
          or (new.status = 'approved' and old.status is distinct from 'approved')
        )) then
    raise exception 'USER: Only a Partner can approve a quotation.' using errcode = 'P0001';
  end if;

  -- Leaving Draft / Pending approval towards the client is "sending" (§7.5.3).
  if new.status in ('sent', 'viewed', 'accepted', 'rejected')
     and (tg_op = 'INSERT' or old.status in ('draft', 'pending_approval'))
     and new.approved_at is null then
    select exists (select 1 from public.profiles p where p.id = new.created_by and p.role = 'partner') into v_by_partner;
    select fs.quotation_approval_limit into v_limit from public.firm_settings fs where fs.id = 1;
    -- quotationNeedsApproval(): a Partner's own never; else null limit = always, 0 = never, else total > limit.
    if not v_by_partner and (v_limit is null or (v_limit > 0 and new.total > v_limit)) then
      raise exception 'USER: This quotation is over the quotation approval limit. Submit it for a Partner''s approval first.'
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

comment on function public.quotations_role_guard() is
  'Trigger: only Partners approve quotations; a quotation that needs approval (quotationNeedsApproval, §5.2 quotation_approval_limit) can''t be sent unapproved; quotations are created in the caller''s own name (§4.1, §7.5.2).';

drop trigger if exists quotations_role_guard on public.quotations;
create trigger quotations_role_guard before insert or update on public.quotations
  for each row execute function public.quotations_role_guard();

-- =============================================================================================
-- 3. activity_logs: money-side history (same rule as 0043 for the timeline and messages)
-- =============================================================================================
create or replace function public.can_see_entity(p_type text, p_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_client uuid;
begin
  if public.is_manager_or_partner() then
    return true;
  end if;
  if not public.is_staff() or p_id is null then
    return false;
  end if;
  case p_type
    when 'client' then return public.can_see_client(p_id);
    when 'task' then return public.can_see_task(p_id);
    when 'document' then select d.client_id into v_client from public.documents d where d.id = p_id;
    when 'compliance_event' then select e.client_id into v_client from public.compliance_events e where e.id = p_id;
    when 'document_request' then select r.client_id into v_client from public.document_requests r where r.id = p_id;
    when 'filing_record' then select f.client_id into v_client from public.filing_records f where f.id = p_id;
    when 'tax_notice' then select n.client_id into v_client from public.tax_notices n where n.id = p_id;
    when 'gst_recon_run' then select g.client_id into v_client from public.gst_recon_runs g where g.id = p_id;
    when 'itr_computation' then select i.client_id into v_client from public.itr_computations i where i.id = p_id;
    when 'financial_statement' then select s.client_id into v_client from public.financial_statements s where s.id = p_id;
    when 'message' then
      -- Messages about invoices or quotations stay with Partners and Managers (0043).
      select m.client_id into v_client from public.messages m
      where m.id = p_id and not public.is_money_message(m.related_entity_type, m.template_id);
    when 'statutory_registration' then select r.client_id into v_client from public.statutory_registrations r where r.id = p_id;
    when 'dsc_record' then select r.client_id into v_client from public.dsc_records r where r.id = p_id;
    else return false;
  end case;
  return v_client is not null and public.can_see_client(v_client);
end;
$$;

comment on function public.can_see_entity(text, uuid) is
  'Whether the caller may see an entity''s history (activity_logs): Partner/Manager all; Employees entities of clients they can see, never money-side messages (§4.1).';

drop policy if exists activity_logs_select on public.activity_logs;
create policy activity_logs_select on public.activity_logs
  for select to authenticated
  using (
    (select public.is_manager_or_partner())
    or (not public.money_side_kind(action) and public.can_see_entity(entity_type, entity_id))
  );

drop policy if exists activity_logs_insert on public.activity_logs;
create policy activity_logs_insert on public.activity_logs
  for insert to authenticated
  with check (
    (select public.is_staff())
    and (user_id is null or user_id = (select auth.uid()))
    and (
      (select public.is_manager_or_partner())
      or (not public.money_side_kind(action) and public.can_see_entity(entity_type, entity_id))
    )
  );

-- =============================================================================================
-- 4. client-documents: only staff delete files
-- =============================================================================================
drop policy if exists client_documents_delete on storage.objects;
create policy client_documents_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'client-documents'
    and public.is_staff()
    and public.can_see_client(public.storage_first_folder_uuid(name))
    and (public.is_manager_or_partner() or owner = auth.uid())
  );

-- =============================================================================================
-- 5. audit_logs: no TRUNCATE
-- =============================================================================================
drop trigger if exists audit_logs_no_truncate on public.audit_logs;
create trigger audit_logs_no_truncate
  before truncate on public.audit_logs
  for each statement execute function public.audit_logs_immutable();

revoke truncate on public.audit_logs from public, anon, authenticated, service_role;

-- =============================================================================================
-- 6. employee_leave_guard (replaces 0032; now also on DELETE)
-- =============================================================================================
create or replace function public.employee_leave_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_role public.app_role;
  v_own boolean;
  v_subject_role public.app_role;
begin
  if not public.is_api_caller() then
    return coalesce(new, old);
  end if;
  v_role := public.app_role();
  v_own := old.employee_id = public.my_employee_id();

  -- Managers manage Employees' leave and their own requests; a Partner manages the rest.
  if v_role = 'manager' and not coalesce(v_own, false) then
    select coalesce(p.role, e.staff_role) into v_subject_role
    from public.employees e left join public.profiles p on p.id = e.profile_id
    where e.id = old.employee_id;
    if v_subject_role is distinct from 'employee' then
      raise exception 'USER: Managers decide Employees'' leave; a Partner decides leave for Managers and Partners.'
        using errcode = 'P0001';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  if new.employee_id is distinct from old.employee_id then
    raise exception 'USER: A leave request can''t be moved to another person.' using errcode = 'P0001';
  end if;

  if v_role = 'employee' or (v_own and v_role = 'manager' and (
       new.decided_by is distinct from old.decided_by or new.status not in ('requested', 'cancelled')
     )) then
    -- Your own request: edit it while it's requested, or cancel it; the decision isn't yours.
    perform public.assert_changed_only(to_jsonb(old), to_jsonb(new),
      array['start_date', 'end_date', 'type', 'half_day', 'reason', 'status'], 'your leave request');
    if new.status is distinct from old.status and new.status <> 'cancelled' then
      raise exception 'USER: You can cancel your own leave request, but not approve or decline it.' using errcode = 'P0001';
    end if;
    if old.status <> 'requested' and (new.start_date, new.end_date, new.type, new.half_day)
         is distinct from (old.start_date, old.end_date, old.type, old.half_day) then
      raise exception 'USER: Only a leave request that hasn''t been decided can be changed. Cancel it and ask again.' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists employee_leave_guard on public.employee_leave;
create trigger employee_leave_guard before update or delete on public.employee_leave
  for each row execute function public.employee_leave_guard();

revoke execute on function public.invoices_role_guard(), public.quotations_role_guard(), public.employee_leave_guard()
  from public, anon, authenticated;

update public.app_meta set value = '0044' where key = 'schema_version';
