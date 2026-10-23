-- 0152 · Receipts (§5.7, §6.5, §7.9.4, §7.9.9).
--
--   record_receipt(payload)        Partner/Manager: one receipt against an issued invoice, numbered
--                                  from the receipt series on the day it is recorded (0031 trigger).
--                                  Validation (§7.9.4): amount received ≥ 0, TDS ≥ 0, something
--                                  received, and received + TDS ≤ outstanding + ₹1 ("record the
--                                  advance separately"). The TDS quarter (Q2 2026-27, from the payment
--                                  date) and the deductor's TAN (the client's) are recorded for the
--                                  TDS credit register (§7.9.9). The settlement trigger (0017) moves
--                                  the invoice to Partially paid / Paid; nothing here sets a status.
--                                  A portal "I've paid" claim it answers is marked verified (§7.22).
--   reverse_receipt(id, reason)    Partner/Manager: receipts are reversed with a reason, never deleted
--                                  (§7.9.4); the settlement trigger restores the balance.
--
-- Both SECURITY INVOKER: RLS (payment_receipts, Partners/Managers, 0034) and the receipt guard
-- (0017: amounts never change, a reversal stays) apply to the caller.

set search_path = public, extensions;

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

comment on function public.record_receipt(jsonb) is
  'Partner/Manager: records a receipt (with TDS) against an issued invoice; received + TDS ≤ outstanding + ₹1 (§6.5, §7.9.4).';

create or replace function public.reverse_receipt(p_receipt_id uuid, p_reason text)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_reason text := nullif(btrim(p_reason), '');
  v_receipt public.payment_receipts%rowtype;
  v_inv public.invoices%rowtype;
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only Partners and Managers reverse receipts.' using errcode = 'P0001';
  end if;
  if v_reason is null then
    raise exception 'USER: Say why the receipt is being reversed, for example "Cheque bounced".' using errcode = 'P0001';
  end if;
  select * into v_receipt from public.payment_receipts where id = p_receipt_id for update;
  if not found then
    raise exception 'USER: That receipt doesn''t exist.' using errcode = 'P0001';
  end if;
  if v_receipt.reversed_at is not null then
    raise exception 'USER: Receipt % was already reversed on %.', v_receipt.receipt_number,
      public.format_day((v_receipt.reversed_at at time zone 'Asia/Kolkata')::date) using errcode = 'P0001';
  end if;
  -- Lock the invoice too, so the settlement it moves is consistent.
  perform 1 from public.invoices where id = v_receipt.invoice_id for update;

  update public.payment_receipts
     set reversed_at = now(), reversed_by = auth.uid(), reversal_reason = left(v_reason, 500)
   where id = p_receipt_id
  returning * into v_receipt;

  update public.portal_payment_claims set status = 'pending', verified_by = null, verified_at = null, payment_receipt_id = null
   where payment_receipt_id = p_receipt_id;

  select * into v_inv from public.invoices where id = v_receipt.invoice_id;
  return jsonb_build_object(
    'receipt_id', v_receipt.id,
    'receipt_number', v_receipt.receipt_number,
    'invoice_id', v_inv.id,
    'invoice_number', v_inv.invoice_number,
    'client_id', v_inv.client_id,
    'status', v_inv.status,
    'outstanding_amount', v_inv.outstanding_amount,
    'amount_received', v_receipt.amount_received,
    'tds_amount', v_receipt.tds_amount,
    'tds_status', v_receipt.tds_status
  );
end;
$$;

comment on function public.reverse_receipt(uuid, text) is
  'Partner/Manager: reverses a receipt with a reason (never deleted); the settlement trigger restores the balance (§7.9.4).';

revoke execute on function public.record_receipt(jsonb), public.reverse_receipt(uuid, text) from public, anon;
grant execute on function public.record_receipt(jsonb), public.reverse_receipt(uuid, text) to authenticated, service_role;
