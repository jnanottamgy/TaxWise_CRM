-- 0151 · Invoice drafts, approval and issue (§5.7, §6.3, §6.4, §7.9.2, §7.9.3, §13).
--
-- Every function here is SECURITY INVOKER: RLS (Partners and Managers only, 0034) and the triggers
-- (invoices_role_guard's approval gate, 0044; the issued-invoice freeze, 0017 and 0150; the
-- settlement trigger; the number trigger) apply to the caller exactly as for a direct write.
--
--   save_invoice_draft(payload)        one transaction: the invoice header and its lines, with the
--                                      totals computed here (per line, half-up to the paisa; CGST =
--                                      round(tax/2), SGST = tax − CGST; IGST out of state; pure-agent
--                                      reimbursements untaxed and outside the taxable value; optional
--                                      ±₹0.99 round-off; mirror of lib/domain/gst.ts invoiceTotals).
--                                      Place of supply derived from the client unless overridden with a
--                                      reason; SAC from firm_settings.sac_by_service; "other" GST rates
--                                      need a reason; the same engagement period can't be billed twice;
--                                      unbilled time can't sit on two invoices. `submit` on a held
--                                      invoice (a Manager's over the limit, 0044) sends it for approval.
--   delete_invoice_draft(id, at)       soft delete (§0.1 rule 11) of a draft that has no number.
--   approve_invoice(id, at)            Partner: approves a held invoice; it can then be sent.
--   return_invoice(id, note, at)       Partner: returns a held invoice to its raiser with a note.
--   issue_invoice(id, at, channel)     Draft → Sent (§7.9.3 "Sent on the first send of any kind"): the
--                                      Rule 46 checks, the number from the locked series (0031
--                                      trigger, next_document_number('invoice', issue_date)), the
--                                      snapshots (client name / address / state / GSTIN, firm GSTIN),
--                                      the signatory, and the unbilled time marked invoiced.
--   record_invoice_send(id, channel)   adds a channel to sent_channels after an email or hand-off.
--   invoice_period_conflicts(…)        the invoices that already bill an engagement for a period.
--
-- User-facing refusals: RAISE 'USER: …' (CONVENTIONS §3.4).

set search_path = public, extensions;

-- =============================================================================================
-- invoice_period_conflicts: issued or draft invoices (not this one, not cancelled or deleted, tax
-- invoices only) that bill one of these engagements for this period, at invoice or line level.
-- =============================================================================================
create or replace function public.invoice_period_conflicts(p_invoice_id uuid, p_client_service_ids uuid[], p_period_label text)
returns table (invoice_id uuid, invoice_number text, billing_period_label text, client_service_id uuid)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select distinct on (i.id) i.id, i.invoice_number, i.billing_period_label, s.sid
  from public.invoices i
  cross join lateral unnest(coalesce(p_client_service_ids, '{}'::uuid[])) as s(sid)
  where public.normalise_period_label(p_period_label) is not null
    and i.id is distinct from p_invoice_id
    and i.deleted_at is null
    and i.cancelled_at is null
    and i.invoice_kind = 'tax_invoice'
    and public.normalise_period_label(i.billing_period_label) = public.normalise_period_label(p_period_label)
    and (
      i.client_service_id = s.sid
      or exists (select 1 from public.invoice_items ii where ii.invoice_id = i.id and ii.client_service_id = s.sid)
    )
  order by i.id
$$;

comment on function public.invoice_period_conflicts(uuid, uuid[], text) is
  'Invoices (not cancelled or deleted) that already bill one of these engagements for this billing period (§7.9.2).';

-- =============================================================================================
-- save_invoice_draft
-- =============================================================================================
create or replace function public.save_invoice_draft(p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_id uuid := public.try_uuid(p_payload ->> 'id');
  v_expected timestamptz := nullif(p_payload ->> 'updated_at', '')::timestamptz;
  v_client_id uuid := public.try_uuid(p_payload ->> 'client_id');
  v_issue date := coalesce(nullif(p_payload ->> 'issue_date', '')::date, public.today_ist());
  v_due date := nullif(p_payload ->> 'due_date', '')::date;
  v_pos text := nullif(btrim(p_payload ->> 'place_of_supply_code'), '');
  v_pos_reason text := nullif(btrim(p_payload ->> 'place_of_supply_reason'), '');
  v_period text := nullif(btrim(p_payload ->> 'billing_period_label'), '');
  v_notes text := nullif(btrim(p_payload ->> 'notes'), '');
  v_terms text := nullif(btrim(p_payload ->> 'terms'), '');
  v_service_type public.service_type := nullif(p_payload ->> 'service_type', '')::public.service_type;
  v_round_off boolean;
  v_submit boolean := coalesce((p_payload ->> 'submit')::boolean, false);
  v_lines jsonb := coalesce(p_payload -> 'lines', '[]'::jsonb);
  v_existing public.invoices%rowtype;
  v_row public.invoices%rowtype;
  v_client record;
  v_fs public.firm_settings%rowtype;
  v_derived_pos text;
  v_intra boolean;
  v_options numeric[];
  v_allow_other boolean;
  v_rate_param jsonb;
  v_line jsonb;
  v_n int := 0;
  v_desc text;
  v_qty numeric;
  v_rate numeric;
  v_tax_rate numeric;
  v_reimb_line boolean;
  v_sac text;
  v_line_service public.service_type;
  v_line_cs uuid;
  v_line_task uuid;
  v_line_entries uuid[];
  v_amount numeric;
  v_tax numeric;
  v_half numeric;
  v_taxable numeric := 0;
  v_cgst numeric := 0;
  v_sgst numeric := 0;
  v_igst numeric := 0;
  v_reimb numeric := 0;
  v_gross numeric;
  v_total numeric;
  v_round numeric := 0;
  v_cs_ids uuid[] := '{}';
  v_entries uuid[] := '{}';
  v_first_cs uuid;
  v_first_task uuid;
  v_first_service public.service_type;
  v_conflict record;
  v_bad_count int;
  v_items jsonb := '[]'::jsonb;
  v_submitted boolean := false;
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only Partners and Managers raise invoices.' using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_lines) <> 'array' then
    raise exception 'USER: The invoice lines didn''t arrive. Reload and try again.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(v_lines) > 100 then
    raise exception 'USER: An invoice can have at most 100 lines.' using errcode = 'P0001';
  end if;

  select * into v_fs from public.firm_settings where id = 1;
  v_round_off := coalesce((p_payload ->> 'round_off')::boolean, v_fs.round_off_enabled, false);

  -- The invoice being edited, locked, and the concurrency check (§13).
  if v_id is not null then
    select * into v_existing from public.invoices where id = v_id and deleted_at is null for update;
    if not found then
      raise exception 'USER: That invoice no longer exists. It may have been deleted.' using errcode = 'P0001';
    end if;
    if v_existing.status not in ('draft', 'awaiting_approval') then
      raise exception 'USER: An issued invoice can''t be edited. Cancel and reissue it, or raise a credit or debit note.' using errcode = 'P0001';
    end if;
    if v_expected is null or v_existing.updated_at <> v_expected then
      raise exception '%', public.invoice_change_conflict(v_id) using errcode = 'P0001';
    end if;
    -- A debit note, or the reissue of a cancelled invoice, stays with its client.
    if (v_existing.invoice_kind = 'debit_note' or v_existing.revised_from_id is not null) and v_client_id is distinct from v_existing.client_id then
      raise exception 'USER: This invoice belongs to the client of the invoice it corrects; its client can''t change.' using errcode = 'P0001';
    end if;
  end if;

  if v_client_id is null then
    raise exception 'USER: Choose the client to invoice.' using errcode = 'P0001';
  end if;
  select c.id, c.display_name, c.status, c.gstin, c.state_code
    into v_client
  from public.clients c
  where c.id = v_client_id and c.deleted_at is null;
  if not found then
    raise exception 'USER: That client doesn''t exist, or is in the recycle bin.' using errcode = 'P0001';
  end if;
  if v_client.status = 'inactive' then
    raise exception 'USER: % is inactive, so it isn''t billed. Make the client Active before invoicing them.', v_client.display_name using errcode = 'P0001';
  end if;

  -- Dates (§7.9.2): invoice date (default today), due date (default + payment terms).
  if v_due is null then
    v_due := v_issue + coalesce(v_fs.payment_terms_days, 15);
  end if;
  if v_due < v_issue then
    raise exception 'USER: The due date can''t be before the invoice date.' using errcode = 'P0001';
  end if;

  -- Place of supply (§6.4): the client's GSTIN state, else its state, else the firm's own state.
  v_derived_pos := coalesce(
    case when v_client.gstin is not null and left(v_client.gstin::text, 2) ~ '^[0-9]{2}$' then left(v_client.gstin::text, 2) end,
    v_client.state_code::text,
    coalesce(v_fs.state_code::text, '29')
  );
  if v_id is not null and v_existing.invoice_kind = 'debit_note' then
    v_pos := v_existing.place_of_supply_code;      -- a debit note follows its original invoice
    v_pos_reason := v_existing.place_of_supply_reason;
  elsif v_pos is null or v_pos = v_derived_pos then
    v_pos := v_derived_pos;
    v_pos_reason := null;
  else
    if public.gst_state_name(v_pos) is null then
      raise exception 'USER: Pick the state the service is supplied to.' using errcode = 'P0001';
    end if;
    if v_pos_reason is null then
      raise exception 'USER: Say why the place of supply is % (%) rather than % (%).',
        public.gst_state_name(v_pos), v_pos, public.gst_state_name(v_derived_pos), v_derived_pos using errcode = 'P0001';
    end if;
  end if;
  v_intra := v_pos = coalesce(v_fs.state_code::text, '29');

  -- The GST rate picker in force on the invoice date (§6.4).
  v_rate_param := public.statutory_param_value('gst.invoice_rate_options', v_issue);
  select coalesce(array_agg(x::numeric), array[18, 5, 0]::numeric[])
    into v_options
  from jsonb_array_elements_text(coalesce(v_rate_param -> 'options', '[18,5,0]'::jsonb)) x;
  v_allow_other := coalesce((v_rate_param ->> 'allowOther')::boolean, true);

  -- Lines and totals (§6.3, §6.4).
  for v_line in select value from jsonb_array_elements(v_lines)
  loop
    v_n := v_n + 1;
    v_desc := nullif(btrim(v_line ->> 'description'), '');
    if v_desc is null then
      raise exception 'USER: Describe the service on line %.', v_n using errcode = 'P0001';
    end if;
    if char_length(v_desc) > 1000 then
      raise exception 'USER: Keep the description on line % under 1,000 characters.', v_n using errcode = 'P0001';
    end if;
    v_qty := coalesce(nullif(v_line ->> 'quantity', '')::numeric, 1);
    v_rate := coalesce(nullif(v_line ->> 'rate', '')::numeric, 0);
    v_reimb_line := coalesce((v_line ->> 'is_reimbursement')::boolean, false);
    v_tax_rate := case when v_reimb_line then 0 else coalesce(nullif(v_line ->> 'tax_rate', '')::numeric, v_fs.default_tax_rate, 18) end;
    if v_qty <= 0 or v_qty <> round(v_qty, 2) or v_qty > 99999999 then
      raise exception 'USER: Enter a quantity above 0 on line %, with at most two decimals.', v_n using errcode = 'P0001';
    end if;
    if v_rate < 0 or v_rate <> round(v_rate, 2) then
      raise exception 'USER: Enter the rate on line % in rupees and paise, 0 or more.', v_n using errcode = 'P0001';
    end if;
    if v_tax_rate < 0 or v_tax_rate > 100 or v_tax_rate <> round(v_tax_rate, 2) then
      raise exception 'USER: Enter the GST rate on line % as a percentage, for example 18.', v_n using errcode = 'P0001';
    end if;
    if not v_reimb_line and not (v_tax_rate = any (v_options)) then
      if not v_allow_other then
        raise exception 'USER: Use one of the GST rates offered on line %.', v_n using errcode = 'P0001';
      end if;
      if nullif(btrim(v_line ->> 'tax_rate_reason'), '') is null then
        raise exception 'USER: Give a reason for the % GST rate on line %.', v_tax_rate || '%', v_n using errcode = 'P0001';
      end if;
    end if;

    v_line_service := nullif(v_line ->> 'service_type', '')::public.service_type;
    v_sac := nullif(regexp_replace(coalesce(v_line ->> 'sac_code', ''), '\s+', '', 'g'), '');
    if v_sac is null then
      v_sac := coalesce(nullif(v_fs.sac_by_service ->> v_line_service::text, ''), v_fs.default_sac, '9982');
    end if;
    if v_sac !~ '^99[0-9]{2}([0-9]{2})?$' then
      raise exception 'USER: Enter the SAC on line %: 4 or 6 digits starting 99, for example 9982 or 998221.', v_n using errcode = 'P0001';
    end if;

    v_line_cs := public.try_uuid(v_line ->> 'client_service_id');
    if v_line_cs is not null then
      perform 1 from public.client_services s where s.id = v_line_cs and s.client_id = v_client_id;
      if not found then
        raise exception 'USER: The engagement on line % isn''t one of this client''s services.', v_n using errcode = 'P0001';
      end if;
      v_cs_ids := array_append(v_cs_ids, v_line_cs);
      v_first_cs := coalesce(v_first_cs, v_line_cs);
    end if;
    v_line_task := public.try_uuid(v_line ->> 'source_task_id');
    if v_line_task is not null then
      perform 1 from public.tasks t where t.id = v_line_task and t.client_id = v_client_id and t.deleted_at is null;
      if not found then
        raise exception 'USER: The task on line % isn''t one of this client''s tasks.', v_n using errcode = 'P0001';
      end if;
      v_first_task := coalesce(v_first_task, v_line_task);
    end if;
    select coalesce(array_agg(distinct public.try_uuid(x)) filter (where public.try_uuid(x) is not null), '{}'::uuid[])
      into v_line_entries
    from jsonb_array_elements_text(coalesce(v_line -> 'time_entry_ids', '[]'::jsonb)) x;
    if array_length(v_line_entries, 1) > 0 then
      if v_line_entries && v_entries then
        raise exception 'USER: The same time entry is on two lines. Keep it on one.' using errcode = 'P0001';
      end if;
      v_entries := v_entries || v_line_entries;
    end if;
    v_first_service := coalesce(v_first_service, v_line_service);

    v_amount := round(v_qty * v_rate, 2);
    v_tax := round(v_amount * v_tax_rate / 100, 2);
    if v_reimb_line then
      v_reimb := v_reimb + v_amount;
    else
      v_taxable := v_taxable + v_amount;
      if v_intra then
        v_half := round(v_tax / 2, 2);
        v_cgst := v_cgst + v_half;
        v_sgst := v_sgst + (v_tax - v_half);
      else
        v_igst := v_igst + v_tax;
      end if;
    end if;

    v_items := v_items || jsonb_build_object(
      'description', v_desc,
      'service_type', v_line_service,
      'sac_code', v_sac,
      'quantity', v_qty,
      'rate', v_rate,
      'amount', v_amount,
      'tax_rate', v_tax_rate,
      'is_reimbursement', v_reimb_line,
      'tax_rate_reason', case when v_reimb_line or v_tax_rate = any (v_options) then null else nullif(btrim(v_line ->> 'tax_rate_reason'), '') end,
      'client_service_id', v_line_cs,
      'source_task_id', v_line_task,
      'time_entry_ids', to_jsonb(v_line_entries),
      'sort_order', v_n
    );
  end loop;

  v_gross := v_taxable + v_cgst + v_sgst + v_igst + v_reimb;
  if v_round_off then
    v_total := round(v_gross, 0);
    v_round := v_total - v_gross;
  else
    v_total := v_gross;
  end if;

  -- Unbilled time (§7.9.2): this client's billable, finished time, not billed and not on another
  -- live invoice.
  if array_length(v_entries, 1) > 0 then
    select count(*) into v_bad_count
    from unnest(v_entries) e(id)
    left join public.time_entries te on te.id = e.id
    where te.id is null
       or te.client_id is distinct from v_client_id
       or not te.billable
       or te.ended_at is null
       or (te.invoice_id is not null and te.invoice_id is distinct from v_id);
    if v_bad_count > 0 then
      raise exception 'USER: % of the time entries can''t be billed here: they belong to another client, aren''t billable, are still running, or are already billed. Add the unbilled time again.', v_bad_count using errcode = 'P0001';
    end if;
    select i.id, i.invoice_number, i.issue_date into v_conflict
    from public.invoice_items ii
    join public.invoices i on i.id = ii.invoice_id
    where ii.time_entry_ids && v_entries
      and i.id is distinct from v_id
      and i.deleted_at is null
      and i.cancelled_at is null
    limit 1;
    if found then
      raise exception 'USER: Some of this time is already on % dated %. Remove it there first.',
        coalesce('invoice ' || v_conflict.invoice_number, 'a draft invoice'), public.format_day(v_conflict.issue_date) using errcode = 'P0001';
    end if;
  end if;

  -- The same engagement period already billed (§7.9.2: block).
  v_first_cs := coalesce(public.try_uuid(p_payload ->> 'client_service_id'), v_first_cs);
  if v_first_cs is not null then
    perform 1 from public.client_services s where s.id = v_first_cs and s.client_id = v_client_id;
    if not found then
      raise exception 'USER: That engagement isn''t one of this client''s services.' using errcode = 'P0001';
    end if;
    v_cs_ids := array_append(v_cs_ids, v_first_cs);
  end if;
  -- A debit note bills more for a period already invoiced, so only tax invoices are checked.
  if v_period is not null and array_length(v_cs_ids, 1) > 0 and coalesce(v_existing.invoice_kind, 'tax_invoice') = 'tax_invoice' then
    select * into v_conflict from public.invoice_period_conflicts(v_id, v_cs_ids, v_period) limit 1;
    if found then
      raise exception 'USER: % is already billed for this engagement on %. Open it instead of raising another.',
        v_period, coalesce('invoice ' || v_conflict.invoice_number, 'a draft invoice') using errcode = 'P0001';
    end if;
  end if;

  v_service_type := coalesce(v_service_type, v_first_service);
  v_first_task := coalesce(public.try_uuid(p_payload ->> 'source_task_id'), v_first_task);

  if v_id is null then
    insert into public.invoices (
      client_id, issue_date, due_date, status, place_of_supply_code, place_of_supply_reason,
      taxable_amount, cgst_amount, sgst_amount, igst_amount, reimbursement_amount, round_off, total_amount,
      service_type, billing_period_label, notes, terms, source_task_id, client_service_id, created_by
    ) values (
      v_client_id, v_issue, v_due, 'draft', v_pos, v_pos_reason,
      v_taxable, v_cgst, v_sgst, v_igst, v_reimb, v_round, v_total,
      v_service_type, v_period, v_notes, coalesce(v_terms, v_fs.invoice_terms), v_first_task, v_first_cs, auth.uid()
    )
    returning * into v_row;
    v_id := v_row.id;
  else
    update public.invoices set
      client_id = v_client_id,
      issue_date = v_issue,
      due_date = v_due,
      place_of_supply_code = v_pos,
      place_of_supply_reason = v_pos_reason,
      taxable_amount = v_taxable,
      cgst_amount = v_cgst,
      sgst_amount = v_sgst,
      igst_amount = v_igst,
      reimbursement_amount = v_reimb,
      round_off = v_round,
      total_amount = v_total,
      service_type = v_service_type,
      billing_period_label = v_period,
      notes = v_notes,
      terms = v_terms,
      source_task_id = v_first_task,
      client_service_id = case when invoice_kind = 'debit_note' then client_service_id else v_first_cs end
    where id = v_id
    returning * into v_row;
    delete from public.invoice_items where invoice_id = v_id;
  end if;

  insert into public.invoice_items (
    invoice_id, description, service_type, sac_code, quantity, rate, amount, tax_rate, is_reimbursement,
    tax_rate_reason, client_service_id, source_task_id, time_entry_ids, sort_order
  )
  select
    v_id,
    x ->> 'description',
    nullif(x ->> 'service_type', '')::public.service_type,
    x ->> 'sac_code',
    (x ->> 'quantity')::numeric,
    (x ->> 'rate')::numeric,
    (x ->> 'amount')::numeric,
    (x ->> 'tax_rate')::numeric,
    (x ->> 'is_reimbursement')::boolean,
    x ->> 'tax_rate_reason',
    public.try_uuid(x ->> 'client_service_id'),
    public.try_uuid(x ->> 'source_task_id'),
    coalesce((select array_agg(public.try_uuid(e)) from jsonb_array_elements_text(x -> 'time_entry_ids') e), '{}'::uuid[]),
    (x ->> 'sort_order')::int
  from jsonb_array_elements(v_items) x;

  -- §7.9.2: a held invoice (over the limit, raised by a Manager) goes to the Partners when saved.
  if v_submit and v_row.requires_approval and v_row.approved_at is null and v_row.status = 'draft' then
    update public.invoices
       set status = 'awaiting_approval', submitted_at = now(), approval_note = null
     where id = v_id
    returning * into v_row;
    v_submitted := true;
  end if;

  return jsonb_build_object(
    'id', v_row.id,
    'status', v_row.status,
    'updated_at', v_row.updated_at,
    'requires_approval', v_row.requires_approval,
    'approved_at', v_row.approved_at,
    'submitted', v_submitted,
    'client_id', v_row.client_id,
    'taxable_amount', v_row.taxable_amount,
    'cgst_amount', v_row.cgst_amount,
    'sgst_amount', v_row.sgst_amount,
    'igst_amount', v_row.igst_amount,
    'reimbursement_amount', v_row.reimbursement_amount,
    'round_off', v_row.round_off,
    'total_amount', v_row.total_amount
  );
end;
$$;

comment on function public.save_invoice_draft(jsonb) is
  'Partner/Manager: saves an unissued invoice and its lines in one transaction, computing the totals (§6.3, §6.4, §7.9.2). `submit` sends a held invoice for approval.';

-- =============================================================================================
-- delete_invoice_draft: soft delete of a draft that has no number (§7.9.3 "Draft: … delete (soft)").
-- =============================================================================================
create or replace function public.delete_invoice_draft(p_invoice_id uuid, p_updated_at timestamptz)
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
  if v_inv.status not in ('draft', 'awaiting_approval') or v_inv.invoice_number is not null then
    raise exception 'USER: An issued invoice is never deleted. Cancel and reissue it, or raise a credit note.' using errcode = 'P0001';
  end if;
  if p_updated_at is null or v_inv.updated_at <> p_updated_at then
    raise exception '%', public.invoice_change_conflict(p_invoice_id) using errcode = 'P0001';
  end if;
  update public.invoices set deleted_at = now(), deleted_by = auth.uid() where id = p_invoice_id;
  return jsonb_build_object('id', p_invoice_id, 'client_id', v_inv.client_id);
end;
$$;

-- =============================================================================================
-- approve_invoice / return_invoice (§7.9.2, §4.1: only Partners approve).
-- =============================================================================================
create or replace function public.approve_invoice(p_invoice_id uuid, p_updated_at timestamptz)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_inv public.invoices%rowtype;
begin
  if not public.is_partner() then
    raise exception 'USER: Only a Partner can approve an invoice that is awaiting approval.' using errcode = 'P0001';
  end if;
  select * into v_inv from public.invoices where id = p_invoice_id and deleted_at is null for update;
  if not found then
    raise exception 'USER: That invoice no longer exists. It may have been deleted.' using errcode = 'P0001';
  end if;
  if p_updated_at is null or v_inv.updated_at <> p_updated_at then
    raise exception '%', public.invoice_change_conflict(p_invoice_id) using errcode = 'P0001';
  end if;
  if v_inv.status <> 'awaiting_approval' then
    raise exception 'USER: This invoice isn''t awaiting approval.' using errcode = 'P0001';
  end if;
  update public.invoices
     set status = 'draft', approved_by = auth.uid(), approved_at = now(), approval_note = null
   where id = p_invoice_id
  returning * into v_inv;
  return jsonb_build_object('id', v_inv.id, 'status', v_inv.status, 'updated_at', v_inv.updated_at, 'created_by', v_inv.created_by, 'client_id', v_inv.client_id, 'total_amount', v_inv.total_amount);
end;
$$;

create or replace function public.return_invoice(p_invoice_id uuid, p_note text, p_updated_at timestamptz)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_inv public.invoices%rowtype;
  v_note text := nullif(btrim(p_note), '');
begin
  if not public.is_partner() then
    raise exception 'USER: Only a Partner can return an invoice that is awaiting approval.' using errcode = 'P0001';
  end if;
  if v_note is null then
    raise exception 'USER: Write a note for the person who raised it: what should change?' using errcode = 'P0001';
  end if;
  select * into v_inv from public.invoices where id = p_invoice_id and deleted_at is null for update;
  if not found then
    raise exception 'USER: That invoice no longer exists. It may have been deleted.' using errcode = 'P0001';
  end if;
  if p_updated_at is null or v_inv.updated_at <> p_updated_at then
    raise exception '%', public.invoice_change_conflict(p_invoice_id) using errcode = 'P0001';
  end if;
  if v_inv.status <> 'awaiting_approval' then
    raise exception 'USER: This invoice isn''t awaiting approval.' using errcode = 'P0001';
  end if;
  update public.invoices
     set status = 'draft', approval_note = left(v_note, 1000), returned_at = now(), returned_by = auth.uid()
   where id = p_invoice_id
  returning * into v_inv;
  return jsonb_build_object('id', v_inv.id, 'status', v_inv.status, 'updated_at', v_inv.updated_at, 'created_by', v_inv.created_by, 'client_id', v_inv.client_id);
end;
$$;

-- =============================================================================================
-- invoice_signatory: the Partner who signs (§6.4 Rule 46 "the Partner's name and Authorised
-- Signatory"): the approving Partner, else the issuing Partner, else the client's engagement
-- partner, else the first active Partner by name.
-- =============================================================================================
create or replace function public.invoice_signatory(p_invoice_id uuid)
returns table (profile_id uuid, full_name text)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with inv as (
    select i.id, i.client_id, i.approved_by from public.invoices i
    where i.id = p_invoice_id and public.is_manager_or_partner()
  ),
  candidates as (
    select p.id, p.full_name, 1 as rank
    from inv join public.profiles p on p.id = inv.approved_by
    where p.role = 'partner' and p.is_active
    union all
    select p.id, p.full_name, 2
    from public.profiles p
    where p.id = auth.uid() and p.role = 'partner' and p.is_active and exists (select 1 from inv)
    union all
    select p.id, p.full_name, 3
    from inv
    join public.client_team_members tm on tm.client_id = inv.client_id and tm.team_role = 'engagement_partner'
    join public.employees e on e.id = tm.employee_id and e.is_active and e.deleted_at is null
    join public.profiles p on p.id = e.profile_id
    where p.role = 'partner' and p.is_active
    union all
    select p.id, p.full_name, 4
    from public.profiles p
    where p.role = 'partner' and p.is_active and exists (select 1 from inv)
  )
  select c.id, c.full_name from candidates c order by c.rank, c.full_name limit 1
$$;

comment on function public.invoice_signatory(uuid) is
  'The Partner who signs an invoice as Authorised Signatory (§6.4): approver, issuing Partner, engagement partner, or the first active Partner.';

-- =============================================================================================
-- issue_invoice: Draft → Sent, numbered, snapshotted (§7.9.2, §7.9.3, §6.4 Rule 46).
-- =============================================================================================
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
  'Partner/Manager: Draft → Sent with the Rule 46 checks, the number from the locked series, the snapshots and signatory, and the unbilled time marked invoiced (§6.4, §7.9.2, §7.9.3).';

-- =============================================================================================
-- record_invoice_send: an email went, or a WhatsApp / Gmail hand-off was opened (§7.9.3).
-- =============================================================================================
create or replace function public.record_invoice_send(p_invoice_id uuid, p_channel text)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_inv public.invoices%rowtype;
begin
  if p_channel not in ('email', 'whatsapp', 'gmail', 'in_person') then
    raise exception 'USER: That isn''t a way of sending an invoice.' using errcode = 'P0001';
  end if;
  select * into v_inv from public.invoices where id = p_invoice_id and deleted_at is null for update;
  if not found then
    raise exception 'USER: That invoice no longer exists. It may have been deleted.' using errcode = 'P0001';
  end if;
  if v_inv.status in ('draft', 'awaiting_approval') then
    raise exception 'USER: Issue the invoice before sending it.' using errcode = 'P0001';
  end if;
  if v_inv.cancelled_at is not null then
    raise exception 'USER: This invoice was cancelled and reissued; send the new one instead.' using errcode = 'P0001';
  end if;
  update public.invoices
     set sent_channels = case when p_channel = any (coalesce(sent_channels, '{}')) then sent_channels else coalesce(sent_channels, '{}') || p_channel end,
         last_sent_at = now()
   where id = p_invoice_id
  returning * into v_inv;
  return jsonb_build_object('id', v_inv.id, 'sent_channels', to_jsonb(v_inv.sent_channels), 'updated_at', v_inv.updated_at);
end;
$$;

revoke execute on function
  public.invoice_period_conflicts(uuid, uuid[], text),
  public.save_invoice_draft(jsonb),
  public.delete_invoice_draft(uuid, timestamptz),
  public.approve_invoice(uuid, timestamptz),
  public.return_invoice(uuid, text, timestamptz),
  public.invoice_signatory(uuid),
  public.issue_invoice(uuid, timestamptz, text),
  public.record_invoice_send(uuid, text)
from public, anon;

grant execute on function
  public.invoice_period_conflicts(uuid, uuid[], text),
  public.save_invoice_draft(jsonb),
  public.delete_invoice_draft(uuid, timestamptz),
  public.approve_invoice(uuid, timestamptz),
  public.return_invoice(uuid, text, timestamptz),
  public.invoice_signatory(uuid),
  public.issue_invoice(uuid, timestamptz, text),
  public.record_invoice_send(uuid, text)
to authenticated, service_role;
