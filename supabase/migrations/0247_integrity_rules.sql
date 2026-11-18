-- 0247 · Smaller integrity rules from the end-to-end break-it run.
--   1. Task comments: only the author changes what a comment says, and the change is stamped
--      "edited". Partners and Managers can still remove a comment (deleted_at), not rewrite it.
--   2. Leave: one person's requested or approved leave can't overlap; a half day is one day.
--   3. Attendance after leave: approving back-dated leave no longer overwrites a past day that has
--      its own record (the person was present, late …), and cancelling leave clears its "On leave"
--      days in the past as well as ahead.
--   4. A receipt can't be dated more than a year before its invoice.
--   5. A credit note for the whole remaining value credits the whole remaining GST (the invoice's
--      GST is rounded per line, so recomputing it on the total could leave ₹0.01 behind).
--   6. task_visible_to(task, profile): whether a given person may see a task, so an @mention
--      doesn't send a task's text to someone who can't open it.
-- record_receipt and issue_credit_note are 0152's and 0153's bodies with only those lines changed.
--
-- Also records the schema version (§0.1 rule 1): lib/env.ts EXPECTED_SCHEMA_VERSION matches it.

set search_path = public, extensions;

-- 1 ------------------------------------------------------------------------------------------
create or replace function public.task_comments_edit_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if new.body is distinct from old.body or new.mentions is distinct from old.mentions then
    if public.is_api_caller() and old.author_id is distinct from auth.uid() then
      raise exception 'USER: Only the person who wrote a comment can change it. You can remove it instead.' using errcode = 'P0001';
    end if;
    if new.body is distinct from old.body then
      new.edited_at := now();
    end if;
  end if;
  if public.is_api_caller() and new.author_id is distinct from old.author_id then
    raise exception 'USER: A comment stays with the person who wrote it.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
drop trigger if exists task_comments_edit_guard on public.task_comments;
create trigger task_comments_edit_guard before update on public.task_comments
  for each row execute function public.task_comments_edit_guard();
revoke execute on function public.task_comments_edit_guard() from public, anon, authenticated;

-- 2 ------------------------------------------------------------------------------------------
create or replace function public.employee_leave_overlap_guard()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_other record;
begin
  if new.status not in ('requested', 'approved') then
    return new;
  end if;
  if new.half_day and new.start_date <> new.end_date then
    raise exception 'USER: A half day is a single day. Choose the same From and To date.' using errcode = 'P0001';
  end if;
  if new.end_date - new.start_date > 366 then
    raise exception 'USER: Leave can''t run for more than a year. Check the dates.' using errcode = 'P0001';
  end if;
  -- One person's leave at a time: serialise their requests, then look for an overlap.
  perform pg_advisory_xact_lock(hashtext('employee_leave'), hashtext(new.employee_id::text));
  select l.start_date, l.end_date, l.status into v_other
    from public.employee_leave l
   where l.employee_id = new.employee_id
     and l.id <> new.id
     and l.status in ('requested', 'approved')
     and l.start_date <= new.end_date
     and l.end_date >= new.start_date
   order by l.start_date
   limit 1;
  if found then
    raise exception 'USER: This overlaps leave already % (% to %).',
      case when v_other.status = 'approved' then 'approved' else 'requested' end,
      public.format_day(v_other.start_date), public.format_day(v_other.end_date) using errcode = 'P0001';
  end if;
  return new;
end;
$$;
drop trigger if exists employee_leave_overlap_guard on public.employee_leave;
create trigger employee_leave_overlap_guard before insert or update of start_date, end_date, status, half_day, employee_id on public.employee_leave
  for each row execute function public.employee_leave_overlap_guard();
revoke execute on function public.employee_leave_overlap_guard() from public, anon, authenticated;

-- 3 ------------------------------------------------------------------------------------------
create or replace function public.mark_leave_attendance(p_employee uuid, p_start date, p_end date, p_half_day boolean)
returns int
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_count int := 0;
begin
  insert into public.attendance_records (employee_id, date, status, notes)
  select p_employee, d, 'on_leave', case when p_half_day then 'Half-day leave' else 'Approved leave' end
  from public.leave_working_dates(p_start, p_end) as d
  on conflict (employee_id, date) do update
    set status = 'on_leave', notes = excluded.notes
    where attendance_records.corrected_by is null
      -- A day already past keeps what was recorded for it: leave approved afterwards doesn't
      -- rewrite a day the person was at work.
      and (attendance_records.date >= public.today_ist() or attendance_records.status = 'on_leave');
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.clear_leave_attendance(p_employee uuid, p_start date, p_end date)
returns int
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_count int := 0;
begin
  -- Past days too: "On leave" with no leave behind it is wrong whichever side of today it falls.
  delete from public.attendance_records a
   where a.employee_id = p_employee
     and a.date between p_start and p_end
     and a.status = 'on_leave'
     and a.corrected_by is null
     and a.notes in ('Approved leave', 'Half-day leave');
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- 6 ------------------------------------------------------------------------------------------
create or replace function public.task_visible_to(p_task uuid, p_profile uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_role public.app_role;
  v_active boolean;
  v_emp uuid;
  t record;
begin
  -- Asked only by someone who can see the task themself.
  if not public.can_see_task(p_task) then
    return false;
  end if;
  select p.role, p.is_active into v_role, v_active from public.profiles p where p.id = p_profile;
  if v_role is null or not coalesce(v_active, false) or v_role = 'client' then
    return false;
  end if;
  if v_role in ('partner', 'manager') then
    return true;
  end if;
  select e.id into v_emp from public.employees e where e.profile_id = p_profile;
  if v_emp is null then
    return false;
  end if;
  select tk.assigned_employee_id, tk.reviewer_employee_id, tk.client_id into t from public.tasks tk where tk.id = p_task;
  if t.assigned_employee_id = v_emp or t.reviewer_employee_id = v_emp then
    return true;
  end if;
  return exists (select 1 from public.clients c where c.id = t.client_id and c.deleted_at is null and c.owner_employee_id = v_emp)
      or exists (select 1 from public.client_team_members tm where tm.client_id = t.client_id and tm.employee_id = v_emp)
      or exists (select 1 from public.covers_in_force f where f.cover_employee_id = v_emp
                  and ((f.kind = 'client' and f.client_id = t.client_id)
                    or (f.kind = 'person' and f.absent_employee_id in (
                          select c.owner_employee_id from public.clients c where c.id = t.client_id
                          union select tm.employee_id from public.client_team_members tm where tm.client_id = t.client_id))));
end;
$$;
comment on function public.task_visible_to(uuid, uuid) is
  'Whether the person with this profile may see the task (the rules of can_see_task, for someone other than the caller). For @mentions.';
revoke execute on function public.task_visible_to(uuid, uuid) from public, anon;
grant execute on function public.task_visible_to(uuid, uuid) to authenticated, service_role;

-- 4 ------------------------------------------------------------------------------------------
create or replace function public.record_receipt(p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_invoice_id uuid := public.try_uuid(p_payload ->> 'invoice_id');
  v_expected timestamptz := nullif(p_payload ->> 'invoice_updated_at', '')::timestamptz;
  v_date date := nullif(p_payload ->> 'payment_date', '')::date;
  v_received numeric := coalesce(nullif(p_payload ->> 'amount_received', '')::numeric, 0);
  v_tds numeric := coalesce(nullif(p_payload ->> 'tds_amount', '')::numeric, 0);
  v_section text := nullif(upper(btrim(p_payload ->> 'tds_section')), '');
  v_method public.payment_method := nullif(p_payload ->> 'method', '')::public.payment_method;
  v_reference text := nullif(btrim(p_payload ->> 'reference'), '');
  v_deposited text := nullif(btrim(p_payload ->> 'deposited_to'), '');
  v_notes text := nullif(btrim(p_payload ->> 'notes'), '');
  v_claim uuid := public.try_uuid(p_payload ->> 'claim_id');
  v_inv public.invoices%rowtype;
  v_client record;
  v_receipt public.payment_receipts%rowtype;
  v_quarter text;
  v_month int;
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only Partners and Managers record receipts.' using errcode = 'P0001';
  end if;
  if v_invoice_id is null then
    raise exception 'USER: Choose the invoice the payment is for.' using errcode = 'P0001';
  end if;
  select * into v_inv from public.invoices where id = v_invoice_id and deleted_at is null for update;
  if not found then
    raise exception 'USER: That invoice no longer exists. It may have been deleted.' using errcode = 'P0001';
  end if;
  if v_expected is not null and v_inv.updated_at <> v_expected then
    raise exception '%', public.invoice_change_conflict(v_invoice_id) using errcode = 'P0001';
  end if;
  if v_inv.cancelled_at is not null then
    raise exception 'USER: Invoice % was cancelled and reissued. Record the payment against the new invoice.', v_inv.invoice_number using errcode = 'P0001';
  end if;
  case v_inv.status
    when 'draft', 'awaiting_approval' then
      raise exception 'USER: Issue the invoice before recording a payment against it.' using errcode = 'P0001';
    when 'waived' then
      raise exception 'USER: Invoice % was waived, so nothing is due on it.', v_inv.invoice_number using errcode = 'P0001';
    else
      null;
  end case;

  if v_date is null then
    raise exception 'USER: Enter the payment date.' using errcode = 'P0001';
  end if;
  if v_date > public.today_ist() then
    raise exception 'USER: The payment date can''t be in the future.' using errcode = 'P0001';
  end if;
  -- An advance can come before its invoice, but not years before: that is a mistyped date.
  if v_date < v_inv.issue_date - 366 then
    raise exception 'USER: The payment date (%) is more than a year before the invoice (%). Check the date.',
      public.format_day(v_date), public.format_day(v_inv.issue_date) using errcode = 'P0001';
  end if;
  if v_method is null then
    raise exception 'USER: Choose how the client paid.' using errcode = 'P0001';
  end if;
  if v_received < 0 or v_received <> round(v_received, 2) then
    raise exception 'USER: The amount received can''t be negative. Enter 0 if the client paid only by TDS.' using errcode = 'P0001';
  end if;
  if v_tds < 0 or v_tds <> round(v_tds, 2) then
    raise exception 'USER: The TDS deducted can''t be negative.' using errcode = 'P0001';
  end if;
  if v_received + v_tds = 0 then
    raise exception 'USER: Enter the amount received, the TDS deducted, or both.' using errcode = 'P0001';
  end if;
  if v_tds > 0 and v_section is null then
    raise exception 'USER: Choose the section the client deducted TDS under.' using errcode = 'P0001';
  end if;
  if v_tds = 0 then
    v_section := null;
  end if;
  -- §7.9.4: received + TDS ≤ outstanding + ₹1.
  if v_received + v_tds > v_inv.outstanding_amount + 1 then
    if v_inv.outstanding_amount <= 0 then
      raise exception 'USER: Nothing is outstanding on this invoice. Record only what settles this invoice, and record the advance separately.' using errcode = 'P0001';
    end if;
    raise exception 'USER: % received and deducted is more than the % outstanding. Record only what settles this invoice, and record the advance separately.',
      public.format_inr(v_received + v_tds), public.format_inr(greatest(v_inv.outstanding_amount, 0)) using errcode = 'P0001';
  end if;

  select c.tan into v_client from public.clients c where c.id = v_inv.client_id;
  v_month := extract(month from v_date)::int;
  v_quarter := 'Q' || ((((v_month - 4 + 12) % 12) / 3) + 1)::text || ' ' || public.financial_year_label(v_date);

  insert into public.payment_receipts (
    invoice_id, payment_date, amount_received, tds_amount, tds_section, method, reference, deposited_to, notes,
    recorded_by, tds_quarter, deductor_tan
  ) values (
    v_invoice_id, v_date, v_received, v_tds, v_section, v_method, left(v_reference, 120), left(v_deposited, 120), left(v_notes, 2000),
    auth.uid(), case when v_tds > 0 then v_quarter end, case when v_tds > 0 then v_client.tan end
  )
  returning * into v_receipt;

  if v_claim is not null then
    update public.portal_payment_claims
       set status = 'verified', verified_by = auth.uid(), verified_at = now(), payment_receipt_id = v_receipt.id
     where id = v_claim and invoice_id = v_invoice_id and status = 'pending';
  end if;

  select * into v_inv from public.invoices where id = v_invoice_id;
  return jsonb_build_object(
    'receipt_id', v_receipt.id,
    'receipt_number', v_receipt.receipt_number,
    'invoice_id', v_inv.id,
    'invoice_number', v_inv.invoice_number,
    'client_id', v_inv.client_id,
    'status', v_inv.status,
    'outstanding_amount', v_inv.outstanding_amount,
    'amount_received', v_inv.amount_received,
    'tds_credited', v_inv.tds_credited,
    'updated_at', v_inv.updated_at
  );
end;
$$;

-- 5 ------------------------------------------------------------------------------------------
create or replace function public.issue_credit_note(p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_invoice_id uuid := public.try_uuid(p_payload ->> 'invoice_id');
  v_reason_code public.credit_note_reason := nullif(p_payload ->> 'reason_code', '')::public.credit_note_reason;
  v_reason text := nullif(btrim(p_payload ->> 'reason'), '');
  v_taxable numeric := nullif(p_payload ->> 'taxable_amount', '')::numeric;
  v_rate numeric := nullif(p_payload ->> 'tax_rate', '')::numeric;
  v_reduces boolean := coalesce((p_payload ->> 'reduces_gst')::boolean, true);
  v_date date := coalesce(nullif(p_payload ->> 'issue_date', '')::date, public.today_ist());
  v_filed date := nullif(p_payload ->> 'annual_return_filed_on', '')::date;
  v_notes text := nullif(btrim(p_payload ->> 'notes'), '');
  v_inv public.invoices%rowtype;
  v_fs public.firm_settings%rowtype;
  v_fy text;
  v_deadline date;
  v_rates numeric[];
  v_line_taxable numeric;
  v_credited numeric;
  v_remaining numeric;
  v_tax numeric := 0;
  v_line_tax numeric := 0;
  v_tax_credited numeric := 0;
  v_cgst numeric := 0;
  v_sgst numeric := 0;
  v_igst numeric := 0;
  v_total numeric;
  v_all_credited numeric;
  v_cn public.credit_notes%rowtype;
begin
  if not public.is_partner() then
    raise exception 'USER: Only a Partner can issue a credit note.' using errcode = 'P0001';
  end if;
  if v_invoice_id is null then
    raise exception 'USER: Choose the invoice the credit note is for.' using errcode = 'P0001';
  end if;
  if v_reason_code is null then
    raise exception 'USER: Choose the reason code.' using errcode = 'P0001';
  end if;
  if v_reason is null then
    raise exception 'USER: Explain the reason for the credit note.' using errcode = 'P0001';
  end if;
  if v_taxable is null or v_taxable <= 0 or v_taxable <> round(v_taxable, 2) then
    raise exception 'USER: Enter the taxable amount to credit.' using errcode = 'P0001';
  end if;
  if v_date > public.today_ist() then
    raise exception 'USER: A credit note can''t be dated after today.' using errcode = 'P0001';
  end if;

  select * into v_inv from public.invoices where id = v_invoice_id and deleted_at is null for update;
  if not found then
    raise exception 'USER: That invoice no longer exists. It may have been deleted.' using errcode = 'P0001';
  end if;
  if v_inv.status in ('draft', 'awaiting_approval') then
    raise exception 'USER: A draft can be edited, so it needs no credit note.' using errcode = 'P0001';
  end if;
  if v_inv.status = 'waived' then
    raise exception 'USER: Invoice % was waived; nothing is left to credit.', v_inv.invoice_number using errcode = 'P0001';
  end if;
  if v_inv.cancelled_at is not null then
    raise exception 'USER: Invoice % was cancelled and reissued. Credit the new invoice instead.', v_inv.invoice_number using errcode = 'P0001';
  end if;
  if v_date < v_inv.issue_date then
    raise exception 'USER: A credit note can''t be dated before the invoice it corrects (%).', public.format_day(v_inv.issue_date) using errcode = 'P0001';
  end if;

  -- The annual return's filing date for the invoice's FY can bring the s.34 deadline forward.
  v_fy := public.financial_year_label(v_inv.issue_date);
  if v_filed is not null then
    if v_filed > public.today_ist() then
      raise exception 'USER: The annual return''s filing date can''t be in the future.' using errcode = 'P0001';
    end if;
    insert into public.gst_annual_returns (financial_year, filed_on, recorded_by)
    values (v_fy, v_filed, auth.uid())
    on conflict (financial_year) do update set filed_on = excluded.filed_on;
  end if;
  select filed_on into v_filed from public.gst_annual_returns where financial_year = v_fy;
  v_deadline := public.credit_note_deadline(v_inv.issue_date, v_filed, v_date);

  select * into v_fs from public.firm_settings where id = 1;

  if v_reduces then
    if v_date > v_deadline then
      raise exception 'USER: A credit note that reduces GST had to be issued by % (%). You can still give a commercial credit, which reduces what the client owes but not the GST.',
        public.format_day(v_deadline),
        case when v_filed is not null and v_deadline = v_filed then 'the annual return was filed' else 's.34 deadline' end
        using errcode = 'P0001';
    end if;
    select coalesce(array_agg(distinct ii.tax_rate order by ii.tax_rate desc), '{}') into v_rates
    from public.invoice_items ii where ii.invoice_id = v_invoice_id and not ii.is_reimbursement;
    if array_length(v_rates, 1) is null then
      raise exception 'USER: This invoice has no taxable lines to credit. Give a commercial credit instead.' using errcode = 'P0001';
    end if;
    v_rate := coalesce(v_rate, v_rates[1]);
    if not (v_rate = any (v_rates)) then
      raise exception 'USER: Credit at a GST rate used on the invoice: %.', array_to_string(v_rates, '%, ') || '%' using errcode = 'P0001';
    end if;
    select coalesce(sum(ii.amount), 0) into v_line_taxable
    from public.invoice_items ii where ii.invoice_id = v_invoice_id and not ii.is_reimbursement and ii.tax_rate = v_rate;
    select coalesce(sum(cn.taxable_amount), 0) into v_credited
    from public.credit_notes cn where cn.invoice_id = v_invoice_id and cn.reduces_gst and cn.tax_rate = v_rate;
    v_remaining := v_line_taxable - v_credited;
    if v_taxable > v_remaining then
      raise exception 'USER: You can credit at most %, the taxable value at % not yet credited on this invoice.',
        public.format_inr(greatest(v_remaining, 0)), v_rate || '%' using errcode = 'P0001';
    end if;
    -- The invoice's GST is rounded line by line, so the tax on the credited total can be a paisa off
    -- the tax actually charged. Never credit more tax than is left at this rate, and when the whole
    -- remaining value is credited, credit the whole remaining tax (nothing is left hanging).
    select coalesce(sum(round(ii.amount * ii.tax_rate / 100, 2)), 0) into v_line_tax
    from public.invoice_items ii where ii.invoice_id = v_invoice_id and not ii.is_reimbursement and ii.tax_rate = v_rate;
    select coalesce(sum(cn.cgst_amount + cn.sgst_amount + cn.igst_amount), 0) into v_tax_credited
    from public.credit_notes cn where cn.invoice_id = v_invoice_id and cn.reduces_gst and cn.tax_rate = v_rate;
    v_tax := case
      when v_taxable = v_remaining then greatest(v_line_tax - v_tax_credited, 0)
      else least(round(v_taxable * v_rate / 100, 2), greatest(v_line_tax - v_tax_credited, 0))
    end;
    if v_inv.place_of_supply_code = coalesce(v_fs.state_code::text, '29') then
      v_cgst := round(v_tax / 2, 2);
      v_sgst := v_tax - v_cgst;
    else
      v_igst := v_tax;
    end if;
  else
    -- A commercial (non-GST) credit reduces what the client owes, not the tax.
    v_rate := null;
    if v_taxable > greatest(v_inv.outstanding_amount, 0) then
      raise exception 'USER: A commercial credit can''t be more than the % outstanding on this invoice.', public.format_inr(greatest(v_inv.outstanding_amount, 0)) using errcode = 'P0001';
    end if;
  end if;
  v_total := v_taxable + v_tax;

  select coalesce(sum(cn.total_amount), 0) into v_all_credited from public.credit_notes cn where cn.invoice_id = v_invoice_id;
  if v_all_credited + v_total > v_inv.total_amount then
    raise exception 'USER: Credit notes on this invoice would add up to more than its total of %.', public.format_inr(v_inv.total_amount) using errcode = 'P0001';
  end if;

  insert into public.credit_notes (
    invoice_id, client_id, reason_code, reason, reduces_gst, taxable_amount, tax_rate, cgst_amount, sgst_amount, igst_amount,
    total_amount, place_of_supply_code, issue_date, issued_by, s34_deadline, notes
  ) values (
    v_invoice_id, v_inv.client_id, v_reason_code, left(v_reason, 1000), v_reduces, v_taxable, v_rate, v_cgst, v_sgst, v_igst,
    v_total, v_inv.place_of_supply_code, v_date, auth.uid(), v_deadline, left(v_notes, 2000)
  )
  returning * into v_cn;

  select * into v_inv from public.invoices where id = v_invoice_id;
  return jsonb_build_object(
    'credit_note_id', v_cn.id,
    'credit_note_number', v_cn.credit_note_number,
    'total_amount', v_cn.total_amount,
    'reduces_gst', v_cn.reduces_gst,
    's34_deadline', v_cn.s34_deadline,
    'invoice_id', v_inv.id,
    'invoice_number', v_inv.invoice_number,
    'client_id', v_inv.client_id,
    'status', v_inv.status,
    'outstanding_amount', v_inv.outstanding_amount
  );
end;
$$;

update public.app_meta set value = '0247' where key = 'schema_version';
