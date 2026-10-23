-- 0153 · Corrections to issued invoices (§6.4, §7.9.3, §7.9.7): credit notes, debit notes, cancel &
-- reissue, disputes, waivers, and the optional e-invoice fields.
--
--   issue_credit_note(payload)     Partner (§4.1): from an issued invoice, a reason code and reason, the
--                                  taxable amount to credit (≤ the remaining taxable value at that GST
--                                  rate), GST at the invoice's rate split the invoice's way (CGST + SGST
--                                  or IGST), its own series. s.34 (§6.4): a tax-reducing credit note is
--                                  refused after credit_note_deadline() (30 Nov after the FY, or the
--                                  annual return's filing date if earlier); a commercial credit (no GST)
--                                  is still allowed, up to the outstanding amount. The settlement trigger
--                                  (0017) reduces the outstanding amount.
--   create_debit_note(id, reason)  Partner/Manager: a draft debit note / supplementary invoice against an
--                                  issued invoice (increase), same client and place of supply; its lines
--                                  are added in the editor and it is issued like any invoice (shares the
--                                  invoice series, 0031).
--   cancel_and_reissue(id, reason) Partner/Manager: only before the invoice's month is reported in
--                                  TaxWise's own GSTR-1 (firm_settings.last_gstr1_reported_month); the
--                                  original keeps its number and is marked cancelled with the reason, its
--                                  time is released, and a new draft copy is created (revised_from_id).
--   mark_invoice_disputed / resolve_invoice_dispute   Disputed with a reason (paused from reminders).
--   waive_invoice(id, reason)      Partner: writes off the outstanding amount (waived_amount), with a reason.
--   set_invoice_e_invoice(…)       IRN, acknowledgement number and date, signed QR (§6.4), once issued.
--
-- SECURITY INVOKER throughout: RLS (credit notes are Partner-only to insert, 0034) and the role guard
-- (waive is Partner-only, 0044) apply to the caller.

set search_path = public, extensions;

-- =============================================================================================
-- issue_credit_note
-- =============================================================================================
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
    v_tax := round(v_taxable * v_rate / 100, 2);
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

comment on function public.issue_credit_note(jsonb) is
  'Partner: a credit note against an issued invoice, ≤ the remaining taxable value, GST split the invoice''s way, refused after the s.34 deadline unless commercial (§6.4, §7.9.7).';

-- =============================================================================================
-- create_debit_note
-- =============================================================================================
create or replace function public.create_debit_note(p_original_id uuid, p_reason text)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_reason text := nullif(btrim(p_reason), '');
  v_orig public.invoices%rowtype;
  v_fs public.firm_settings%rowtype;
  v_row public.invoices%rowtype;
  v_today date := public.today_ist();
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only Partners and Managers raise debit notes.' using errcode = 'P0001';
  end if;
  if v_reason is null then
    raise exception 'USER: Say what the debit note is for, for example "Additional work on the September return".' using errcode = 'P0001';
  end if;
  select * into v_orig from public.invoices where id = p_original_id and deleted_at is null;
  if not found then
    raise exception 'USER: That invoice no longer exists. It may have been deleted.' using errcode = 'P0001';
  end if;
  if v_orig.status in ('draft', 'awaiting_approval') then
    raise exception 'USER: A draft can be edited, so it needs no debit note.' using errcode = 'P0001';
  end if;
  if v_orig.cancelled_at is not null then
    raise exception 'USER: Invoice % was cancelled and reissued. Raise the debit note against the new invoice.', v_orig.invoice_number using errcode = 'P0001';
  end if;
  if v_orig.invoice_kind <> 'tax_invoice' then
    raise exception 'USER: Raise the debit note against the original tax invoice.' using errcode = 'P0001';
  end if;
  perform 1 from public.clients c where c.id = v_orig.client_id and c.deleted_at is null and c.status <> 'inactive';
  if not found then
    raise exception 'USER: The client is inactive or in the recycle bin, so it isn''t billed.' using errcode = 'P0001';
  end if;
  select * into v_fs from public.firm_settings where id = 1;

  insert into public.invoices (
    invoice_kind, original_invoice_id, client_id, issue_date, due_date, status, place_of_supply_code, place_of_supply_reason,
    service_type, billing_period_label, notes, terms, created_by
  ) values (
    'debit_note', v_orig.id, v_orig.client_id, v_today, v_today + coalesce(v_fs.payment_terms_days, 15), 'draft',
    v_orig.place_of_supply_code, v_orig.place_of_supply_reason, v_orig.service_type, v_orig.billing_period_label,
    left(format('Debit note (supplementary invoice) against invoice %s dated %s: %s', v_orig.invoice_number, public.format_day(v_orig.issue_date), v_reason), 2000),
    coalesce(v_orig.terms, v_fs.invoice_terms), auth.uid()
  )
  returning * into v_row;

  return jsonb_build_object('id', v_row.id, 'client_id', v_row.client_id, 'original_invoice_id', v_orig.id, 'original_invoice_number', v_orig.invoice_number, 'updated_at', v_row.updated_at);
end;
$$;

-- =============================================================================================
-- cancel_and_reissue
-- =============================================================================================
create or replace function public.cancel_and_reissue(p_invoice_id uuid, p_reason text, p_updated_at timestamptz)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_reason text := nullif(btrim(p_reason), '');
  v_inv public.invoices%rowtype;
  v_fs public.firm_settings%rowtype;
  v_reported text;
  v_live int;
  v_today date := public.today_ist();
  v_new public.invoices%rowtype;
  v_released int := 0;
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only Partners and Managers cancel invoices.' using errcode = 'P0001';
  end if;
  if v_reason is null then
    raise exception 'USER: Say why the invoice is being cancelled.' using errcode = 'P0001';
  end if;
  select * into v_inv from public.invoices where id = p_invoice_id and deleted_at is null for update;
  if not found then
    raise exception 'USER: That invoice no longer exists. It may have been deleted.' using errcode = 'P0001';
  end if;
  if p_updated_at is null or v_inv.updated_at <> p_updated_at then
    raise exception '%', public.invoice_change_conflict(p_invoice_id) using errcode = 'P0001';
  end if;
  if v_inv.status in ('draft', 'awaiting_approval') then
    raise exception 'USER: A draft can be edited or deleted; it doesn''t need cancelling.' using errcode = 'P0001';
  end if;
  if v_inv.cancelled_at is not null then
    raise exception 'USER: Invoice % is already cancelled.', v_inv.invoice_number using errcode = 'P0001';
  end if;
  if v_inv.status = 'waived' then
    raise exception 'USER: Invoice % was waived, so it can''t be cancelled and reissued.', v_inv.invoice_number using errcode = 'P0001';
  end if;

  -- §7.9.3: only before TaxWise's GSTR-1 for that month is filed.
  select * into v_fs from public.firm_settings where id = 1;
  v_reported := nullif(btrim(v_fs.last_gstr1_reported_month), '');
  if v_reported is not null and v_reported ~ '^[0-9]{4}-[0-9]{2}$' and to_char(v_inv.issue_date, 'YYYY-MM') <= v_reported then
    raise exception 'USER: Invoice % is dated %, and TaxWise''s GSTR-1 is filed up to %, so it is already reported. Correct it with a credit note or a debit note instead.',
      v_inv.invoice_number, public.format_day(v_inv.issue_date), to_char(to_date(v_reported || '-01', 'YYYY-MM-DD'), 'Mon YYYY') using errcode = 'P0001';
  end if;

  select count(*) into v_live from public.payment_receipts r where r.invoice_id = p_invoice_id and r.reversed_at is null;
  if v_live > 0 then
    raise exception 'USER: Payments are recorded against invoice %. Reverse them first, then record them against the new invoice.', v_inv.invoice_number using errcode = 'P0001';
  end if;
  perform 1 from public.credit_notes cn where cn.invoice_id = p_invoice_id;
  if found then
    raise exception 'USER: A credit note has been issued against invoice %, so it can''t be cancelled. Raise another credit note or a debit note instead.', v_inv.invoice_number using errcode = 'P0001';
  end if;
  perform 1 from public.invoices d where d.original_invoice_id = p_invoice_id and d.deleted_at is null and d.cancelled_at is null;
  if found then
    raise exception 'USER: A debit note has been raised against invoice %, so it can''t be cancelled.', v_inv.invoice_number using errcode = 'P0001';
  end if;

  update public.invoices
     set cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = left(v_reason, 1000)
   where id = p_invoice_id;

  -- Release its time, so the new invoice can bill it (locked stays only for approved weeks).
  update public.time_entries te
     set invoice_id = null,
         invoiced_at = null,
         locked = exists (
           select 1 from public.timesheet_week_approvals a
           where a.employee_id = te.employee_id and a.week_start = public.ist_week_start(te.started_at)
         )
   where te.invoice_id = p_invoice_id;
  get diagnostics v_released = row_count;

  insert into public.invoices (
    invoice_kind, original_invoice_id, client_id, issue_date, due_date, status, place_of_supply_code, place_of_supply_reason,
    service_type, billing_period_label, notes, terms, source_task_id, client_service_id, revised_from_id, revision_number, created_by,
    taxable_amount, cgst_amount, sgst_amount, igst_amount, reimbursement_amount, round_off, total_amount
  ) values (
    v_inv.invoice_kind, v_inv.original_invoice_id, v_inv.client_id, v_today, v_today + greatest(v_inv.due_date - v_inv.issue_date, 0), 'draft',
    v_inv.place_of_supply_code, v_inv.place_of_supply_reason, v_inv.service_type, v_inv.billing_period_label, v_inv.notes, v_inv.terms,
    v_inv.source_task_id, v_inv.client_service_id, v_inv.id, v_inv.revision_number + 1, auth.uid(),
    v_inv.taxable_amount, v_inv.cgst_amount, v_inv.sgst_amount, v_inv.igst_amount, v_inv.reimbursement_amount, v_inv.round_off, v_inv.total_amount
  )
  returning * into v_new;

  insert into public.invoice_items (
    invoice_id, description, service_type, sac_code, quantity, rate, amount, tax_rate, is_reimbursement,
    tax_rate_reason, client_service_id, source_task_id, time_entry_ids, sort_order
  )
  select v_new.id, ii.description, ii.service_type, ii.sac_code, ii.quantity, ii.rate, ii.amount, ii.tax_rate, ii.is_reimbursement,
         ii.tax_rate_reason, ii.client_service_id, ii.source_task_id, ii.time_entry_ids, ii.sort_order
  from public.invoice_items ii
  where ii.invoice_id = p_invoice_id
  order by ii.sort_order;

  return jsonb_build_object(
    'cancelled_id', v_inv.id,
    'cancelled_number', v_inv.invoice_number,
    'new_id', v_new.id,
    'new_status', v_new.status,
    'client_id', v_inv.client_id,
    'time_entries_released', v_released
  );
end;
$$;

comment on function public.cancel_and_reissue(uuid, text, timestamptz) is
  'Partner/Manager: before GSTR-1 reporting, cancels an issued invoice (it keeps its number) and creates a new draft copy (§7.9.3).';

-- =============================================================================================
-- Disputes and waivers (§7.9.3)
-- =============================================================================================
create or replace function public.mark_invoice_disputed(p_invoice_id uuid, p_reason text, p_updated_at timestamptz)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_reason text := nullif(btrim(p_reason), '');
  v_inv public.invoices%rowtype;
begin
  if v_reason is null then
    raise exception 'USER: Say what the client disputes.' using errcode = 'P0001';
  end if;
  select * into v_inv from public.invoices where id = p_invoice_id and deleted_at is null for update;
  if not found then
    raise exception 'USER: That invoice no longer exists. It may have been deleted.' using errcode = 'P0001';
  end if;
  if p_updated_at is null or v_inv.updated_at <> p_updated_at then
    raise exception '%', public.invoice_change_conflict(p_invoice_id) using errcode = 'P0001';
  end if;
  if v_inv.cancelled_at is not null or v_inv.status not in ('sent', 'partially_paid') then
    raise exception 'USER: Only an issued invoice with a balance can be marked disputed.' using errcode = 'P0001';
  end if;
  update public.invoices
     set status = 'disputed', disputed_reason = left(v_reason, 1000), disputed_at = now(), disputed_by = auth.uid(), dispute_resolved_at = null
   where id = p_invoice_id
  returning * into v_inv;
  return jsonb_build_object('id', v_inv.id, 'status', v_inv.status, 'updated_at', v_inv.updated_at, 'client_id', v_inv.client_id, 'invoice_number', v_inv.invoice_number);
end;
$$;

create or replace function public.resolve_invoice_dispute(p_invoice_id uuid, p_updated_at timestamptz)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_inv public.invoices%rowtype;
begin
  select * into v_inv from public.invoices where id = p_invoice_id and deleted_at is null for update;
  if not found then
    raise exception 'USER: That invoice no longer exists. It may have been deleted.' using errcode = 'P0001';
  end if;
  if p_updated_at is null or v_inv.updated_at <> p_updated_at then
    raise exception '%', public.invoice_change_conflict(p_invoice_id) using errcode = 'P0001';
  end if;
  if v_inv.status <> 'disputed' then
    raise exception 'USER: This invoice isn''t disputed.' using errcode = 'P0001';
  end if;
  -- Back to Sent: the settlement trigger lands it on Sent, Partially paid or Paid.
  update public.invoices set status = 'sent', dispute_resolved_at = now() where id = p_invoice_id
  returning * into v_inv;
  return jsonb_build_object('id', v_inv.id, 'status', v_inv.status, 'updated_at', v_inv.updated_at, 'client_id', v_inv.client_id, 'invoice_number', v_inv.invoice_number);
end;
$$;

create or replace function public.waive_invoice(p_invoice_id uuid, p_reason text, p_updated_at timestamptz)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_reason text := nullif(btrim(p_reason), '');
  v_inv public.invoices%rowtype;
begin
  if not public.is_partner() then
    raise exception 'USER: Only a Partner can waive an invoice.' using errcode = 'P0001';
  end if;
  if v_reason is null then
    raise exception 'USER: Say why the invoice is being waived.' using errcode = 'P0001';
  end if;
  select * into v_inv from public.invoices where id = p_invoice_id and deleted_at is null for update;
  if not found then
    raise exception 'USER: That invoice no longer exists. It may have been deleted.' using errcode = 'P0001';
  end if;
  if p_updated_at is null or v_inv.updated_at <> p_updated_at then
    raise exception '%', public.invoice_change_conflict(p_invoice_id) using errcode = 'P0001';
  end if;
  if v_inv.cancelled_at is not null or v_inv.status not in ('sent', 'partially_paid', 'disputed') then
    raise exception 'USER: Only an issued invoice with a balance can be waived.' using errcode = 'P0001';
  end if;
  if v_inv.outstanding_amount <= 0 then
    raise exception 'USER: Nothing is outstanding on invoice %, so there is nothing to waive.', v_inv.invoice_number using errcode = 'P0001';
  end if;
  update public.invoices
     set status = 'waived', waived_reason = left(v_reason, 1000), waived_at = now(), waived_by = auth.uid(), waived_amount = v_inv.outstanding_amount
   where id = p_invoice_id
  returning * into v_inv;
  return jsonb_build_object('id', v_inv.id, 'status', v_inv.status, 'updated_at', v_inv.updated_at, 'client_id', v_inv.client_id, 'invoice_number', v_inv.invoice_number, 'waived_amount', v_inv.waived_amount);
end;
$$;

-- =============================================================================================
-- set_invoice_e_invoice (§6.4): only on issued invoices; the IRN is the IRP's 64-character hash.
-- =============================================================================================
create or replace function public.set_invoice_e_invoice(p_invoice_id uuid, p_irn text, p_ack_no text, p_ack_date timestamptz, p_signed_qr text, p_updated_at timestamptz)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_inv public.invoices%rowtype;
  v_irn text := nullif(lower(btrim(p_irn)), '');
  v_ack text := nullif(btrim(p_ack_no), '');
  v_qr text := nullif(btrim(p_signed_qr), '');
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only Partners and Managers record e-invoice details.' using errcode = 'P0001';
  end if;
  select * into v_inv from public.invoices where id = p_invoice_id and deleted_at is null for update;
  if not found then
    raise exception 'USER: That invoice no longer exists. It may have been deleted.' using errcode = 'P0001';
  end if;
  if p_updated_at is null or v_inv.updated_at <> p_updated_at then
    raise exception '%', public.invoice_change_conflict(p_invoice_id) using errcode = 'P0001';
  end if;
  if v_inv.status in ('draft', 'awaiting_approval') then
    raise exception 'USER: Issue the invoice first; the IRN is generated for an issued invoice.' using errcode = 'P0001';
  end if;
  if v_irn is not null and v_irn !~ '^[0-9a-f]{64}$' then
    raise exception 'USER: The IRN is the 64-character code the IRP returns. Paste it exactly.' using errcode = 'P0001';
  end if;
  if v_ack is not null and v_ack !~ '^[0-9]{10,20}$' then
    raise exception 'USER: The acknowledgement number is the IRP''s number of 10 to 20 digits.' using errcode = 'P0001';
  end if;
  if v_qr is not null and char_length(v_qr) > 4000 then
    raise exception 'USER: The signed QR code is too long. Paste the signed QR text from the IRP.' using errcode = 'P0001';
  end if;
  update public.invoices
     set irn = v_irn, irn_ack_no = v_ack, irn_ack_date = case when v_ack is null then null else p_ack_date end, signed_qr = v_qr
   where id = p_invoice_id
  returning * into v_inv;
  return jsonb_build_object('id', v_inv.id, 'updated_at', v_inv.updated_at, 'irn', v_inv.irn);
end;
$$;

revoke execute on function
  public.issue_credit_note(jsonb),
  public.create_debit_note(uuid, text),
  public.cancel_and_reissue(uuid, text, timestamptz),
  public.mark_invoice_disputed(uuid, text, timestamptz),
  public.resolve_invoice_dispute(uuid, timestamptz),
  public.waive_invoice(uuid, text, timestamptz),
  public.set_invoice_e_invoice(uuid, text, text, timestamptz, text, timestamptz)
from public, anon;

grant execute on function
  public.issue_credit_note(jsonb),
  public.create_debit_note(uuid, text),
  public.cancel_and_reissue(uuid, text, timestamptz),
  public.mark_invoice_disputed(uuid, text, timestamptz),
  public.resolve_invoice_dispute(uuid, timestamptz),
  public.waive_invoice(uuid, text, timestamptz),
  public.set_invoice_e_invoice(uuid, text, text, timestamptz, text, timestamptz)
to authenticated, service_role;
