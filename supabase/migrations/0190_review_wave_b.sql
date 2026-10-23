-- 0190 · Fixes from the adversarial review of wave B. Each closes a way round a rule that the
-- functions of 0143–0153 enforce only when they are the path taken: Partners and Managers can also
-- write the money tables directly through the API (RLS lets them, 0034), so the rules have to hold
-- on the rows themselves. Every guard here acts only for API callers (a signed-in session,
-- is_api_caller()); the jobs, the service role and security-definer functions keep their own rules.
-- The trigger functions are security invoker on purpose: is_api_caller() reads current_user, which a
-- security-definer function would replace with its owner. They read under the caller's RLS, which
-- lets Partners and Managers (the only roles RLS lets write these tables) see what they check.
--
--   1. invoice_items_derive_amount  a line's amount is round(quantity × rate, 2) and a pure-agent
--      reimbursement carries no GST, however the line is written (§6.3, §6.4).
--   2. invoices_totals_guard  (runs after invoices_role_guard, so a held invoice says so first) a
--      session creates invoices as drafts, and an invoice leaves Draft only through issue_invoice
--      (number, snapshots and the Rule 46 checks; a direct status update numbered it without any of
--      them), and only when its totals are what its lines add up to (taxable value, CGST/SGST or
--      IGST split per line, reimbursements, a round-off under ₹1). Before this a Manager could save
--      a draft under the approval limit, then add lines or lower the totals by hand and issue it
--      without a Partner's approval (§6.4, §7.9.2, §18.3 Partner 5).
--   3. quotations_derive_totals  a Draft's subtotal, tax and total are always the sum of its lines,
--      and a quotation written directly starts as a Draft. Before this a Manager could zero a draft's
--      total by hand and send an over-limit quotation without approval (§7.5.2, §18.3 Manager 2).
--   4. quotation_items_guard (replaces 0143)  lines change only on a Draft. 0143 let the first lines
--      be added to a quotation that had none in any status, so an empty quotation could be sent and
--      filled in afterwards, past the approval gate and against "never edited in place" (§7.5.3).
--   5. credit_notes_insert_guard  the s.34 deadline is judged on the day the credit note is actually
--      issued, not the date typed on it: a tax-reducing credit note backdated to fall inside the
--      deadline was accepted (§6.4, §18.3 Partner 6). Also: only against a live issued invoice of the
--      same client, dated between the invoice and today, and never more than the invoice's total.
--   6. payment_receipts_insert_guard  §7.9.4's validation for every receipt, not only those recorded
--      through record_receipt: an issued, live invoice; a date not in the future; amounts ≥ 0 and not
--      both 0; a TDS section with TDS; received + TDS ≤ outstanding + ₹1.

set search_path = public, extensions;

-- =============================================================================================
-- 1. invoice_items_derive_amount
-- =============================================================================================
create or replace function public.invoice_items_derive_amount()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if not public.is_api_caller() then
    return new;
  end if;
  new.amount := round(coalesce(new.quantity, 1) * coalesce(new.rate, 0), 2);
  if new.is_reimbursement then
    new.tax_rate := 0;
  end if;
  return new;
end;
$$;

comment on function public.invoice_items_derive_amount() is
  'Trigger: an invoice line''s amount is round(quantity × rate, 2) and a reimbursement line has no GST, for every session write (§6.3, §6.4).';

drop trigger if exists invoice_items_derive_amount on public.invoice_items;
create trigger invoice_items_derive_amount before insert or update on public.invoice_items
  for each row execute function public.invoice_items_derive_amount();

-- =============================================================================================
-- 2. invoices_totals_guard
-- =============================================================================================
create or replace function public.invoice_totals_mismatch(p_invoice_id uuid, p_pos text, p_taxable numeric, p_cgst numeric, p_sgst numeric, p_igst numeric, p_reimb numeric, p_round numeric, p_total numeric)
returns boolean
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  v_firm_state text;
  v_intra boolean;
  v_bad_lines int;
  v_taxable numeric := 0;
  v_reimb numeric := 0;
  v_tax numeric := 0;
  v_cgst numeric := 0;
begin
  select coalesce(fs.state_code::text, '29') into v_firm_state from public.firm_settings fs where fs.id = 1;
  v_intra := p_pos = coalesce(v_firm_state, '29');

  select
    count(*) filter (where ii.amount <> round(ii.quantity * ii.rate, 2) or (ii.is_reimbursement and ii.tax_rate <> 0)),
    coalesce(sum(ii.amount) filter (where not ii.is_reimbursement), 0),
    coalesce(sum(ii.amount) filter (where ii.is_reimbursement), 0),
    coalesce(sum(round(ii.amount * ii.tax_rate / 100, 2)) filter (where not ii.is_reimbursement), 0),
    coalesce(sum(round(round(ii.amount * ii.tax_rate / 100, 2) / 2, 2)) filter (where not ii.is_reimbursement), 0)
  into v_bad_lines, v_taxable, v_reimb, v_tax, v_cgst
  from public.invoice_items ii
  where ii.invoice_id = p_invoice_id;

  if v_bad_lines > 0 then
    return true;
  end if;
  if coalesce(p_taxable, 0) <> v_taxable or coalesce(p_reimb, 0) <> v_reimb then
    return true;
  end if;
  if v_intra then
    if coalesce(p_cgst, 0) <> v_cgst or coalesce(p_sgst, 0) <> v_tax - v_cgst or coalesce(p_igst, 0) <> 0 then
      return true;
    end if;
  elsif coalesce(p_igst, 0) <> v_tax or coalesce(p_cgst, 0) <> 0 or coalesce(p_sgst, 0) <> 0 then
    return true;
  end if;
  if abs(coalesce(p_round, 0)) >= 1 then
    return true;
  end if;
  return coalesce(p_total, 0) <> v_taxable + v_tax + v_reimb + coalesce(p_round, 0);
end;
$$;

comment on function public.invoice_totals_mismatch(uuid, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric) is
  'True when an invoice''s header totals differ from what its lines add up to: per-line amount = round(qty × rate), tax half-up per line, CGST = round(tax/2) and SGST = tax − CGST in the firm''s state, else IGST, reimbursements untaxed, round-off under ₹1 (§6.3, §6.4; mirror of save_invoice_draft).';

create or replace function public.invoices_totals_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if not public.is_api_caller() then
    return new;
  end if;
  -- An invoice starts as a draft; it takes its number, its snapshots and the Rule 46 checks only
  -- through issue_invoice (§6.4, §7.9.2).
  if tg_op = 'INSERT' then
    if new.status not in ('draft', 'awaiting_approval') then
      raise exception 'USER: An invoice starts as a draft. Save it, then issue it: that is when it takes its number.' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if old.status in ('draft', 'awaiting_approval') and new.status not in ('draft', 'awaiting_approval') then
    if coalesce(current_setting('taxwise.issuing_invoice', true), '') is distinct from new.id::text then
      raise exception 'USER: Issue the invoice from its page. That is where it takes its number and the Rule 46 checks run.' using errcode = 'P0001';
    end if;
    if public.invoice_totals_mismatch(new.id, new.place_of_supply_code, new.taxable_amount, new.cgst_amount, new.sgst_amount,
                                      new.igst_amount, new.reimbursement_amount, new.round_off, new.total_amount) then
      raise exception 'USER: This invoice''s lines don''t add up to the invoice''s totals. Open the draft and save it again before issuing it.'
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

comment on function public.invoices_totals_guard() is
  'Trigger: for sessions, an invoice is created as a draft and leaves Draft only through issue_invoice (number, snapshots, Rule 46 checks), with totals that match its lines, so the approval gate (invoices_role_guard, which runs first) judges the amount actually billed (§6.4, §7.9.2).';

drop trigger if exists invoices_totals_guard on public.invoices;
create trigger invoices_totals_guard before insert or update on public.invoices
  for each row execute function public.invoices_totals_guard();

-- issue_invoice (0151) unchanged but for the mark above, set just before it moves the invoice out of
-- Draft (a transaction-local setting a client can't set through the API).
create or replace function public.issue_invoice(p_invoice_id uuid, p_updated_at timestamptz, p_channel text default null)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_inv public.invoices%rowtype;
  v_client record;
  v_fs public.firm_settings%rowtype;
  v_today date := public.today_ist();
  v_lines int;
  v_zero int;
  v_b2c jsonb;
  v_b2c_amount numeric;
  v_b2c_inclusive boolean;
  v_over boolean;
  v_cs_ids uuid[];
  v_conflict record;
  v_entries uuid[];
  v_signatory record;
  v_address text;
  v_state text;
  v_billed int;
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only Partners and Managers issue invoices.' using errcode = 'P0001';
  end if;
  if p_channel is not null and p_channel not in ('email', 'whatsapp', 'gmail', 'in_person') then
    raise exception 'USER: Choose how the invoice is going to the client.' using errcode = 'P0001';
  end if;

  select * into v_inv from public.invoices where id = p_invoice_id and deleted_at is null for update;
  if not found then
    raise exception 'USER: That invoice no longer exists. It may have been deleted.' using errcode = 'P0001';
  end if;
  if p_updated_at is null or v_inv.updated_at <> p_updated_at then
    raise exception '%', public.invoice_change_conflict(p_invoice_id) using errcode = 'P0001';
  end if;
  if v_inv.status = 'awaiting_approval' or (v_inv.requires_approval and v_inv.approved_at is null and not public.is_partner()) then
    raise exception 'USER: This invoice is over the approval limit and waits for a Partner''s approval before it can be sent.' using errcode = 'P0001';
  end if;
  if v_inv.status <> 'draft' then
    raise exception 'USER: Invoice % has already been issued.', coalesce(v_inv.invoice_number, '') using errcode = 'P0001';
  end if;
  if v_inv.issue_date > v_today then
    raise exception 'USER: The invoice is dated %, after today. Issue it on that day, or change its date.', public.format_day(v_inv.issue_date) using errcode = 'P0001';
  end if;

  select count(*), count(*) filter (where amount <= 0) into v_lines, v_zero from public.invoice_items where invoice_id = p_invoice_id;
  if v_lines = 0 then
    raise exception 'USER: Add at least one line before issuing the invoice.' using errcode = 'P0001';
  end if;
  if v_zero > 0 then
    raise exception 'USER: % on this invoice % no amount. Enter the rate, or remove the line.',
      case when v_zero = 1 then 'One line' else v_zero || ' lines' end, case when v_zero = 1 then 'has' else 'have' end using errcode = 'P0001';
  end if;
  if v_inv.total_amount <= 0 then
    raise exception 'USER: The invoice total must be more than ₹0.00.' using errcode = 'P0001';
  end if;

  select c.id, c.display_name, c.legal_name, c.status, c.gst_registration, c.gstin, c.state_code, c.address, c.city, c.pincode
    into v_client
  from public.clients c
  where c.id = v_inv.client_id and c.deleted_at is null;
  if not found then
    raise exception 'USER: The client is in the recycle bin. Restore it before issuing its invoice.' using errcode = 'P0001';
  end if;
  if v_client.status = 'inactive' then
    raise exception 'USER: % is inactive, so it isn''t billed. Make the client Active before issuing the invoice.', v_client.display_name using errcode = 'P0001';
  end if;

  -- Rule 46 (§6.4).
  if v_client.gst_registration = 'registered' and v_client.gstin is null then
    raise exception 'USER: This client is registered for GST but has no GSTIN on file. Add it before invoicing: an invoice without the recipient''s GSTIN costs a registered client their input tax credit.'
      using errcode = 'P0001';
  end if;
  select * into v_fs from public.firm_settings where id = 1;
  if v_fs.id is null or nullif(btrim(v_fs.firm_name), '') is null or nullif(btrim(v_fs.address), '') is null then
    raise exception 'USER: Add the firm''s name and address in Settings → Firm details before issuing invoices.' using errcode = 'P0001';
  end if;
  if v_fs.gstin is null then
    raise exception 'USER: Add the firm''s GSTIN in Settings → Firm details before issuing invoices.' using errcode = 'P0001';
  end if;
  if v_client.gstin is null then
    v_b2c := public.statutory_param_value('gst.b2c_address_threshold', v_inv.issue_date);
    v_b2c_amount := coalesce(public.jsonb_to_numeric(v_b2c), 50000);
    v_b2c_inclusive := coalesce((v_b2c ->> 'inclusive')::boolean, false);
    v_over := case when v_b2c_inclusive then v_inv.total_amount >= v_b2c_amount else v_inv.total_amount > v_b2c_amount end;
    if v_over and (nullif(btrim(v_client.address), '') is null or v_client.state_code is null) then
      raise exception 'USER: Add the client''s address and state on their profile: an invoice over % to an unregistered client must show them (Rule 46).',
        public.format_inr(v_b2c_amount) using errcode = 'P0001';
    end if;
  end if;

  -- The same engagement period already billed (§7.9.2).
  select coalesce(array_agg(distinct x), '{}') into v_cs_ids
  from (
    select ii.client_service_id as x from public.invoice_items ii where ii.invoice_id = p_invoice_id and ii.client_service_id is not null
    union select v_inv.client_service_id where v_inv.client_service_id is not null
  ) s;
  if v_inv.invoice_kind = 'tax_invoice' and v_inv.billing_period_label is not null and array_length(v_cs_ids, 1) > 0 then
    select * into v_conflict from public.invoice_period_conflicts(p_invoice_id, v_cs_ids, v_inv.billing_period_label) limit 1;
    if found then
      raise exception 'USER: % is already billed for this engagement on %. Open it instead of issuing another.',
        v_inv.billing_period_label, coalesce('invoice ' || v_conflict.invoice_number, 'a draft invoice') using errcode = 'P0001';
    end if;
  end if;

  -- The unbilled time on the lines: still unbilled.
  select coalesce(array_agg(distinct e), '{}') into v_entries
  from public.invoice_items ii, unnest(ii.time_entry_ids) e
  where ii.invoice_id = p_invoice_id;
  if array_length(v_entries, 1) > 0 then
    select count(*) into v_billed
    from public.time_entries te
    where te.id = any (v_entries) and te.invoice_id is not null and te.invoice_id <> p_invoice_id;
    if v_billed > 0 then
      raise exception 'USER: % of the time entries on this invoice % already been billed on another invoice. Remove those lines and add the unbilled time again.',
        v_billed, case when v_billed = 1 then 'has' else 'have' end using errcode = 'P0001';
    end if;
  end if;

  select * into v_signatory from public.invoice_signatory(p_invoice_id);
  v_state := coalesce(v_client.state_code::text, case when v_client.gstin is not null then left(v_client.gstin::text, 2) end);
  v_address := nullif(concat_ws(', ',
    nullif(btrim(v_client.address), ''),
    nullif(btrim(v_client.city), ''),
    nullif(btrim(concat_ws(' ', public.gst_state_name(v_state), v_client.pincode)), '')
  ), '');

  -- 0190: the mark invoices_totals_guard looks for; an invoice leaves Draft only through here.
  perform set_config('taxwise.issuing_invoice', p_invoice_id::text, true);

  update public.invoices set
    status = 'sent',
    approved_by = case when requires_approval and approved_at is null then auth.uid() else approved_by end,
    approved_at = case when requires_approval and approved_at is null then now() else approved_at end,
    issued_at = now(),
    issued_by = auth.uid(),
    sent_at = now(),
    last_sent_at = case when p_channel is not null then now() end,
    sent_channels = case when p_channel = 'in_person' then array['in_person'] else '{}'::text[] end,
    client_name_snapshot = coalesce(nullif(btrim(v_client.legal_name), ''), v_client.display_name),
    client_address_snapshot = v_address,
    client_gstin_snapshot = v_client.gstin,
    client_state_snapshot = v_state,
    firm_gstin_snapshot = v_fs.gstin,
    signatory_id = v_signatory.profile_id,
    signatory_name = v_signatory.full_name
  where id = p_invoice_id
  returning * into v_inv;

  if array_length(v_entries, 1) > 0 then
    update public.time_entries
       set invoice_id = p_invoice_id, invoiced_at = now(), locked = true
     where id = any (v_entries) and (invoice_id is null or invoice_id = p_invoice_id);
  end if;

  return jsonb_build_object(
    'id', v_inv.id,
    'invoice_number', v_inv.invoice_number,
    'status', v_inv.status,
    'updated_at', v_inv.updated_at,
    'client_id', v_inv.client_id,
    'total_amount', v_inv.total_amount,
    'outstanding_amount', v_inv.outstanding_amount,
    'time_entries_billed', coalesce(array_length(v_entries, 1), 0)
  );
end;
$$;

comment on function public.issue_invoice(uuid, timestamptz, text) is
  'Partner/Manager: Draft → Sent with the Rule 46 checks, the number from the locked series, the snapshots and signatory, and the unbilled time marked invoiced (§6.4, §7.9.2, §7.9.3). The only way an invoice leaves Draft for a session (0190).';

-- =============================================================================================
-- 3. quotations_derive_totals (fires before quotations_role_guard: triggers run in name order)
-- =============================================================================================
create or replace function public.quotations_derive_totals()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_sub numeric(14,2);
  v_tax numeric(14,2);
begin
  if not public.is_api_caller() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.status is distinct from 'draft' then
      raise exception 'USER: A new quotation starts as a draft. Save it, then send it or submit it for approval.' using errcode = 'P0001';
    end if;
    -- It has no lines yet.
    new.subtotal := 0;
    new.tax_amount := 0;
    new.total := 0;
    return new;
  end if;
  -- Only a Draft's lines can change (quotation_items_guard), so only a Draft's totals can move.
  if old.status = 'draft' then
    select coalesce(sum(i.total - i.tax_amount), 0), coalesce(sum(i.tax_amount), 0)
      into v_sub, v_tax
    from public.quotation_items i
    where i.quotation_id = new.id;
    new.subtotal := v_sub;
    new.tax_amount := v_tax;
    new.total := v_sub + v_tax;
  end if;
  return new;
end;
$$;

comment on function public.quotations_derive_totals() is
  'Trigger: a Draft quotation''s subtotal, tax and total are the sum of its lines whenever it is written, so the approval gate (quotations_role_guard) judges the real total; a quotation written directly starts as a Draft (§7.5.2).';

drop trigger if exists quotations_derive_totals on public.quotations;
create trigger quotations_derive_totals before insert or update on public.quotations
  for each row execute function public.quotations_derive_totals();

-- =============================================================================================
-- 4. quotation_items_guard: lines change only on a Draft
-- =============================================================================================
create or replace function public.quotation_items_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_status public.quotation_status;
  v_id uuid := coalesce(new.quotation_id, old.quotation_id);
  v_amount numeric(14,2);
begin
  if public.is_api_caller() and public.is_manager_or_partner() then
    select q.status into v_status from public.quotations q where q.id = v_id;
    if v_status is not null and v_status <> 'draft' then
      raise exception 'USER: This quotation is % and its lines can''t be changed. Revise it to change the terms.',
        replace(v_status::text, '_', ' ') using errcode = 'P0001';
    end if;
    if tg_op = 'UPDATE' and new.quotation_id is distinct from old.quotation_id then
      select q.status into v_status from public.quotations q where q.id = old.quotation_id;
      if v_status is not null and v_status <> 'draft' then
        raise exception 'USER: This quotation is % and its lines can''t be changed. Revise it to change the terms.',
          replace(v_status::text, '_', ' ') using errcode = 'P0001';
      end if;
      raise exception 'USER: A line can''t move to another quotation.' using errcode = 'P0001';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  if public.is_api_caller() and not public.is_manager_or_partner() then
    return new; -- RLS refuses it
  end if;

  v_amount := round(new.quantity * new.unit_price, 2);
  new.tax_amount := round(v_amount * new.tax_rate / 100, 2);
  new.total := v_amount + new.tax_amount;
  return new;
end;
$$;

comment on function public.quotation_items_guard() is
  'Trigger: quotation lines change only on a Draft (no exception for a quotation without lines); each line''s tax = round(round(qty × price, 2) × rate%, 2) and total = amount + tax (§6.3, §7.5.2, §7.5.3).';

-- =============================================================================================
-- 5. credit_notes_insert_guard
-- =============================================================================================
create or replace function public.credit_notes_insert_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_inv public.invoices%rowtype;
  v_today date := public.today_ist();
  v_filed date;
  v_deadline date;
  v_all numeric(14,2);
begin
  if not public.is_api_caller() then
    return new;
  end if;
  select * into v_inv from public.invoices i where i.id = new.invoice_id and i.deleted_at is null;
  if not found then
    raise exception 'USER: That invoice no longer exists. It may have been deleted.' using errcode = 'P0001';
  end if;
  if v_inv.status in ('draft', 'awaiting_approval', 'waived') or v_inv.cancelled_at is not null then
    raise exception 'USER: A credit note is raised only against an issued invoice that hasn''t been cancelled or waived.' using errcode = 'P0001';
  end if;
  if new.client_id is distinct from v_inv.client_id then
    raise exception 'USER: A credit note belongs to the client of the invoice it corrects.' using errcode = 'P0001';
  end if;
  if new.issue_date > v_today then
    raise exception 'USER: A credit note can''t be dated after today.' using errcode = 'P0001';
  end if;
  if new.issue_date < v_inv.issue_date then
    raise exception 'USER: A credit note can''t be dated before the invoice it corrects (%).', public.format_day(v_inv.issue_date) using errcode = 'P0001';
  end if;

  if new.reduces_gst then
    select g.filed_on into v_filed from public.gst_annual_returns g where g.financial_year = public.financial_year_label(v_inv.issue_date);
    v_deadline := public.credit_note_deadline(v_inv.issue_date, v_filed, v_today);
    -- s.34: judged on the day it is issued, whatever date is typed on it.
    if v_today > v_deadline then
      raise exception 'USER: A credit note that reduces GST had to be issued by % (%). You can still give a commercial credit, which reduces what the client owes but not the GST.',
        public.format_day(v_deadline),
        case when v_filed is not null and v_deadline = v_filed then 'the annual return was filed' else 's.34 deadline' end
        using errcode = 'P0001';
    end if;
    new.s34_deadline := v_deadline;
  end if;

  select coalesce(sum(cn.total_amount), 0) into v_all from public.credit_notes cn where cn.invoice_id = new.invoice_id;
  if v_all + coalesce(new.total_amount, 0) > v_inv.total_amount then
    raise exception 'USER: Credit notes on this invoice would add up to more than its total of %.', public.format_inr(v_inv.total_amount) using errcode = 'P0001';
  end if;
  return new;
end;
$$;

comment on function public.credit_notes_insert_guard() is
  'Trigger: a credit note only against a live issued invoice of the same client, dated between the invoice and today, never more than the invoice; a tax-reducing one refused once today is past the s.34 deadline, whatever its date (§6.4, §7.9.7).';

drop trigger if exists credit_notes_insert_guard on public.credit_notes;
create trigger credit_notes_insert_guard before insert on public.credit_notes
  for each row execute function public.credit_notes_insert_guard();

-- =============================================================================================
-- 6. payment_receipts_insert_guard
-- =============================================================================================
create or replace function public.payment_receipts_insert_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_inv public.invoices%rowtype;
  v_sum numeric(14,2);
begin
  if not public.is_api_caller() then
    return new;
  end if;
  select * into v_inv from public.invoices i where i.id = new.invoice_id and i.deleted_at is null for update;
  if not found then
    raise exception 'USER: That invoice no longer exists. It may have been deleted.' using errcode = 'P0001';
  end if;
  if v_inv.status in ('draft', 'awaiting_approval', 'waived') or v_inv.cancelled_at is not null then
    raise exception 'USER: A payment is recorded only against an issued invoice that hasn''t been cancelled or waived.' using errcode = 'P0001';
  end if;
  if new.payment_date is null or new.payment_date > public.today_ist() then
    raise exception 'USER: The payment date can''t be in the future.' using errcode = 'P0001';
  end if;
  if coalesce(new.amount_received, 0) < 0 or coalesce(new.tds_amount, 0) < 0 then
    raise exception 'USER: The amount received and the TDS deducted can''t be negative.' using errcode = 'P0001';
  end if;
  v_sum := coalesce(new.amount_received, 0) + coalesce(new.tds_amount, 0);
  if v_sum = 0 then
    raise exception 'USER: Enter the amount received, the TDS deducted, or both.' using errcode = 'P0001';
  end if;
  if coalesce(new.tds_amount, 0) > 0 and nullif(btrim(coalesce(new.tds_section, '')), '') is null then
    raise exception 'USER: Choose the section the client deducted TDS under.' using errcode = 'P0001';
  end if;
  if v_sum > v_inv.outstanding_amount + 1 then
    raise exception 'USER: % received and deducted is more than the % outstanding. Record only what settles this invoice, and record the advance separately.',
      public.format_inr(v_sum), public.format_inr(greatest(v_inv.outstanding_amount, 0)) using errcode = 'P0001';
  end if;
  return new;
end;
$$;

comment on function public.payment_receipts_insert_guard() is
  'Trigger: §7.9.4 validation on every receipt written by a session: issued live invoice, date not in the future, amounts ≥ 0 and not both 0, a TDS section with TDS, received + TDS ≤ outstanding + ₹1.';

drop trigger if exists payment_receipts_insert_guard on public.payment_receipts;
create trigger payment_receipts_insert_guard before insert on public.payment_receipts
  for each row execute function public.payment_receipts_insert_guard();

-- Trigger functions are never called directly (a trigger fires whatever the caller's EXECUTE rights).
revoke execute on function
  public.invoice_items_derive_amount(),
  public.invoices_totals_guard(),
  public.quotations_derive_totals(),
  public.quotation_items_guard(),
  public.credit_notes_insert_guard(),
  public.payment_receipts_insert_guard()
from public, anon, authenticated;
-- The helper runs as its caller (RLS: only Partners and Managers read invoice lines).
revoke execute on function public.invoice_totals_mismatch(uuid, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric) from public, anon;
grant execute on function public.invoice_totals_mismatch(uuid, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric) to authenticated, service_role;

insert into public.app_meta (key, value) values ('schema_version', '0190')
on conflict (key) do update set value = excluded.value;
