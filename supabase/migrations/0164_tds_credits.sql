-- 0164 · TDS credits (§6.5, §7.9.9): Expected → Reflected in 26AS / AIS (Form 168) → Claimed.
--
--   set_tds_credit_status(items, status, on, note, claimed_in)
--       Partner / Manager: marks receipts' TDS by hand, all or nothing. Moves allowed:
--         Expected → Reflected (the date it showed, default today) · Reflected → Claimed (when, and
--         in which return) · Reflected → Expected (undo; its statement match is removed) ·
--         Claimed → Reflected (undo). Claiming an Expected credit is refused: a credit is claimed
--         only once it shows in 26AS / AIS. Each item carries the updated_at it was loaded with;
--         if any changed since, nothing is saved (§13).
--   set_receipt_deductor_tan(receipt, tan, updated_at)
--       Partner / Manager: the TAN the client deducted under, when the receipt has none (the
--       statement is matched by TAN).
--   import_tds_statement(payload)
--       Partner / Manager, one transaction: records a 26AS / AIS file and its lines, and applies
--       the matches the app worked out (lib/domain/collections.ts matchTdsStatement) after checking
--       each again here: the receipts are live, carry TDS, are still Expected and unmatched, have
--       the line's deductor TAN, and add up to the line's TDS to within ₹1. A match that no longer
--       holds is recorded as an amount mismatch or unmatched instead. Matched receipts become
--       Reflected on the statement's booking date (else today). A line already imported (same
--       TAN, section, dates and amounts) is skipped as a duplicate.
--   set_tds_entry_status(entry, status, note)
--       Partner / Manager: sets a statement line aside (ignored, with a note) or back (unmatched).
--
-- All SECURITY INVOKER: RLS (Partners and Managers only) and the receipt guard (0017: the money on
-- a receipt never changes) apply to the caller.

set search_path = public, extensions;

create or replace function public.set_tds_credit_status(
  p_items jsonb,
  p_status text,
  p_on date default null,
  p_note text default null,
  p_claimed_in text default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_claimed_in text := nullif(btrim(coalesce(p_claimed_in, '')), '');
  v_on date := coalesce(p_on, public.today_ist());
  v_item jsonb;
  v_id uuid;
  v_loaded timestamptz;
  v_r record;
  v_ids uuid[] := '{}';
  v_changed int := 0;
  v_updated int := 0;
  v_clients jsonb := '[]'::jsonb;
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only Partners and Managers mark TDS credits.' using errcode = 'P0001';
  end if;
  if p_status not in ('expected', 'reflected', 'claimed') then
    raise exception 'USER: Choose Expected, Reflected or Claimed.' using errcode = 'P0001';
  end if;
  if jsonb_typeof(coalesce(p_items, 'null'::jsonb)) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'USER: Select at least one TDS credit.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_items) > 500 then
    raise exception 'USER: Mark at most 500 credits at a time.' using errcode = 'P0001';
  end if;
  if v_on > public.today_ist() then
    raise exception 'USER: The date can''t be in the future.' using errcode = 'P0001';
  end if;
  if p_status = 'claimed' and v_claimed_in is null then
    raise exception 'USER: Say where the credit was claimed, for example "ITR for tax year 2026-27".' using errcode = 'P0001';
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_id := public.try_uuid(v_item ->> 'id');
    v_loaded := nullif(v_item ->> 'updated_at', '')::timestamptz;
    if v_id is null then
      raise exception 'USER: One of the selected credits isn''t valid. Reload and try again.' using errcode = 'P0001';
    end if;
    select r.id, r.tds_status, r.tds_amount, r.reversed_at, r.updated_at, r.receipt_number, i.client_id, i.deleted_at
      into v_r
    from public.payment_receipts r
    join public.invoices i on i.id = r.invoice_id
    where r.id = v_id
    for update of r;
    if not found or v_r.reversed_at is not null or v_r.tds_amount <= 0 or v_r.deleted_at is not null then
      raise exception 'USER: Receipt % no longer has a TDS credit to mark (it may have been reversed).', coalesce(v_r.receipt_number, '') using errcode = 'P0001';
    end if;
    if v_loaded is null or v_r.updated_at <> v_loaded then
      v_changed := v_changed + 1;
      continue;
    end if;
    if p_status = 'claimed' and v_r.tds_status = 'expected' then
      raise exception 'USER: Receipt %''s TDS isn''t showing in 26AS / AIS yet. Mark it Reflected first: a credit is claimed only once it shows.', v_r.receipt_number using errcode = 'P0001';
    end if;
    if p_status = 'expected' and v_r.tds_status = 'claimed' then
      raise exception 'USER: Receipt %''s TDS is already claimed. Move it back to Reflected first.', v_r.receipt_number using errcode = 'P0001';
    end if;
    v_ids := v_ids || v_id;
    v_clients := v_clients || jsonb_build_object('receipt_id', v_id, 'client_id', v_r.client_id, 'receipt_number', v_r.receipt_number, 'from', v_r.tds_status);
  end loop;

  if v_changed > 0 then
    raise exception 'USER: % of the selected credits changed since you loaded the page. Reload to see the changes, then try again.',
      case when v_changed = 1 then 'One' else v_changed::text end using errcode = 'P0001';
  end if;

  if p_status = 'expected' then
    delete from public.tds_statement_matches m where m.receipt_id = any (v_ids);
    update public.tds_statement_entries e
       set match_status = 'unmatched', matched_receipt_id = null, matched_at = null,
           match_note = 'Match undone by hand.'
     where e.matched_receipt_id = any (v_ids)
       and not exists (select 1 from public.tds_statement_matches m where m.entry_id = e.id);
  end if;

  update public.payment_receipts r
     set tds_status = p_status,
         tds_reflected_on = case
           when p_status = 'reflected' and r.tds_status = 'expected' then v_on
           when p_status = 'expected' then null
           else r.tds_reflected_on
         end,
         tds_claimed_on = case when p_status = 'claimed' then v_on when p_status in ('reflected', 'expected') then null else r.tds_claimed_on end,
         tds_claimed_in = case when p_status = 'claimed' then left(v_claimed_in, 200) when p_status in ('reflected', 'expected') then null else r.tds_claimed_in end,
         tds_status_note = coalesce(left(v_note, 1000), r.tds_status_note),
         tds_status_changed_at = now(),
         tds_status_changed_by = auth.uid()
   where r.id = any (v_ids)
     and r.tds_status is distinct from p_status;
  get diagnostics v_updated = row_count;

  return jsonb_build_object('updated', v_updated, 'selected', coalesce(array_length(v_ids, 1), 0), 'receipts', v_clients);
end;
$$;

comment on function public.set_tds_credit_status(jsonb, text, date, text, text) is
  'Partner/Manager: marks TDS credits Expected / Reflected / Claimed by hand, all or nothing, with the concurrency check (§7.9.9, §13).';

create or replace function public.set_receipt_deductor_tan(p_receipt_id uuid, p_tan text, p_updated_at timestamptz)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_tan text := nullif(upper(regexp_replace(coalesce(p_tan, ''), '\s+', '', 'g')), '');
  v_r public.payment_receipts%rowtype;
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only Partners and Managers edit TDS credits.' using errcode = 'P0001';
  end if;
  if v_tan is null or v_tan !~ '^[A-Z]{4}[0-9]{5}[A-Z]$' then
    raise exception 'USER: Enter the TAN as 4 letters, 5 digits and a letter, for example BLRA12345B.' using errcode = 'P0001';
  end if;
  select * into v_r from public.payment_receipts where id = p_receipt_id for update;
  if not found or v_r.reversed_at is not null then
    raise exception 'USER: That receipt no longer has a TDS credit (it may have been reversed).' using errcode = 'P0001';
  end if;
  if p_updated_at is null or v_r.updated_at <> p_updated_at then
    raise exception 'USER: This credit changed since you loaded the page. Reload to see the change, then try again.' using errcode = 'P0001';
  end if;
  update public.payment_receipts set deductor_tan = v_tan where id = p_receipt_id returning * into v_r;
  return jsonb_build_object('id', v_r.id, 'deductor_tan', v_r.deductor_tan, 'updated_at', v_r.updated_at);
end;
$$;

create or replace function public.import_tds_statement(p_payload jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_fy text := nullif(btrim(p_payload ->> 'financial_year'), '');
  v_source text := coalesce(nullif(btrim(p_payload ->> 'source'), ''), '26as');
  v_file text := nullif(left(btrim(coalesce(p_payload ->> 'file_name', '')), 200), '');
  v_entries jsonb := coalesce(p_payload -> 'entries', '[]'::jsonb);
  v_import public.tds_statement_imports%rowtype;
  v_e jsonb;
  v_tan text;
  v_tds numeric;
  v_paid numeric;
  v_txn date;
  v_booking date;
  v_section text;
  v_status text;
  v_note text;
  v_receipts uuid[];
  v_sum numeric;
  v_ok int;
  v_entry_id uuid;
  v_client uuid;
  v_matched int := 0;
  v_mismatch int := 0;
  v_unmatched int := 0;
  v_duplicates int := 0;
  v_rows int := 0;
  v_reflected int := 0;
  v_receipt_ids uuid[] := '{}';
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only Partners and Managers import TDS statements.' using errcode = 'P0001';
  end if;
  if v_fy is null or not public.is_fy_label(v_fy) then
    raise exception 'USER: Choose the financial year the statement is for.' using errcode = 'P0001';
  end if;
  if v_source not in ('26as', 'ais', 'form_168', 'other') then
    raise exception 'USER: Choose what the file is: Form 26AS, AIS or Form 168.' using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_entries) <> 'array' or jsonb_array_length(v_entries) = 0 then
    raise exception 'USER: The file has no TDS lines to import.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(v_entries) > 5000 then
    raise exception 'USER: Import at most 5,000 lines at a time.' using errcode = 'P0001';
  end if;

  insert into public.tds_statement_imports (financial_year, source, file_name, imported_by)
  values (v_fy, v_source, v_file, auth.uid())
  returning * into v_import;

  for v_e in select value from jsonb_array_elements(v_entries)
  loop
    v_tan := upper(btrim(coalesce(v_e ->> 'tan', '')));
    v_tds := nullif(v_e ->> 'tds_amount', '')::numeric;
    v_paid := nullif(v_e ->> 'amount_paid', '')::numeric;
    v_txn := nullif(v_e ->> 'transaction_date', '')::date;
    v_booking := nullif(v_e ->> 'booking_date', '')::date;
    v_section := nullif(left(btrim(coalesce(v_e ->> 'section', '')), 20), '');
    if v_tan !~ '^[A-Z]{4}[0-9]{5}[A-Z]$' or v_tds is null or v_tds <= 0 or v_tds <> round(v_tds, 2) then
      raise exception 'USER: A line in the file has no valid TAN or TDS amount. Check the file and try again.' using errcode = 'P0001';
    end if;

    -- The same line imported before: skip it.
    perform 1 from public.tds_statement_entries x
     where x.financial_year = v_fy
       and x.deductor_tan = v_tan
       and x.tds_amount = v_tds
       and x.section is not distinct from v_section
       and x.transaction_date is not distinct from v_txn
       and x.amount_paid is not distinct from v_paid
       and x.import_batch_id is not null;
    if found then
      v_duplicates := v_duplicates + 1;
      continue;
    end if;
    v_rows := v_rows + 1;

    select c.id into v_client from public.clients c where c.tan = v_tan and c.deleted_at is null order by c.created_at limit 1;

    v_status := coalesce(nullif(v_e #>> '{match,status}', ''), 'unmatched');
    v_note := nullif(left(btrim(coalesce(v_e #>> '{match,note}', '')), 500), '');
    select coalesce(array_agg(distinct public.try_uuid(x)) filter (where public.try_uuid(x) is not null), '{}')
      into v_receipts
    from jsonb_array_elements_text(coalesce(v_e #> '{match,receipt_ids}', '[]'::jsonb)) x;

    if v_status = 'matched' then
      if array_length(v_receipts, 1) is null or v_receipts && v_receipt_ids then
        v_status := 'unmatched';
        v_note := 'The receipts proposed for this line were already matched to another line.';
      else
        select count(*), coalesce(sum(r.tds_amount), 0)
          into v_ok, v_sum
        from public.payment_receipts r
        join public.invoices i on i.id = r.invoice_id
        join public.clients c on c.id = i.client_id
        where r.id = any (v_receipts)
          and r.reversed_at is null
          and r.tds_amount > 0
          and r.tds_status = 'expected'
          and i.deleted_at is null
          and upper(coalesce(r.deductor_tan::text, c.tan::text, '')) = v_tan
          and not exists (select 1 from public.tds_statement_matches m where m.receipt_id = r.id);
        if v_ok <> array_length(v_receipts, 1) then
          v_status := 'unmatched';
          v_note := 'The receipts proposed for this line changed while the file was being imported.';
        elsif abs(v_sum - v_tds) > 1 then
          v_status := 'amount_mismatch';
          v_note := coalesce(v_note, format('Our receipts show %s; the statement shows %s.', public.format_inr(v_sum), public.format_inr(v_tds)));
        end if;
      end if;
    elsif v_status not in ('amount_mismatch', 'unmatched', 'ignored') then
      v_status := 'unmatched';
    end if;

    insert into public.tds_statement_entries (
      financial_year, quarter, source, deductor_tan, deductor_name, section, transaction_date, amount_paid, tds_amount,
      booking_status, booking_date, import_batch_id, client_id, match_status, match_note,
      matched_receipt_id, matched_at, created_by
    ) values (
      v_fy, nullif(left(btrim(coalesce(v_e ->> 'quarter', '')), 20), ''), v_source, v_tan,
      nullif(left(btrim(coalesce(v_e ->> 'name', '')), 200), ''), v_section, v_txn, v_paid, v_tds,
      nullif(left(btrim(coalesce(v_e ->> 'booking_status', '')), 4), ''), v_booking, v_import.id, v_client, v_status, v_note,
      case when v_status = 'matched' then v_receipts[1] end, case when v_status = 'matched' then now() end, auth.uid()
    )
    returning id into v_entry_id;

    if v_status = 'matched' then
      insert into public.tds_statement_matches (entry_id, receipt_id, matched_by)
      select v_entry_id, x, auth.uid() from unnest(v_receipts) x;
      update public.payment_receipts r
         set tds_status = 'reflected',
             tds_reflected_on = least(coalesce(v_booking, public.today_ist()), public.today_ist()),
             deductor_tan = coalesce(r.deductor_tan, v_tan),
             tds_status_changed_at = now(),
             tds_status_changed_by = auth.uid(),
             tds_status_note = 'Matched to ' || case v_source when 'ais' then 'AIS' when 'form_168' then 'Form 168' when '26as' then 'Form 26AS' else 'the statement' end
               || coalesce(' (' || v_file || ')', '') || '.'
       where r.id = any (v_receipts);
      get diagnostics v_ok = row_count;
      v_reflected := v_reflected + v_ok;
      v_receipt_ids := v_receipt_ids || v_receipts;
      v_matched := v_matched + 1;
    elsif v_status = 'amount_mismatch' then
      v_mismatch := v_mismatch + 1;
    else
      v_unmatched := v_unmatched + 1;
    end if;
  end loop;

  update public.tds_statement_imports
     set rows_total = v_rows, matched = v_matched, amount_mismatches = v_mismatch, unmatched = v_unmatched
   where id = v_import.id;

  return jsonb_build_object(
    'import_id', v_import.id,
    'rows', v_rows,
    'matched', v_matched,
    'amount_mismatches', v_mismatch,
    'unmatched', v_unmatched,
    'duplicates', v_duplicates,
    'receipts_reflected', v_reflected
  );
end;
$$;

comment on function public.import_tds_statement(jsonb) is
  'Partner/Manager: records a 26AS / AIS (Form 168) file and applies the app''s matches after re-checking them; matched receipts become Reflected (§7.9.9).';

create or replace function public.set_tds_entry_status(p_entry_id uuid, p_status text, p_note text default null)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_e public.tds_statement_entries%rowtype;
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only Partners and Managers review TDS statements.' using errcode = 'P0001';
  end if;
  if p_status not in ('ignored', 'unmatched') then
    raise exception 'USER: A line can be set aside or brought back.' using errcode = 'P0001';
  end if;
  select * into v_e from public.tds_statement_entries where id = p_entry_id for update;
  if not found then
    raise exception 'USER: That statement line no longer exists.' using errcode = 'P0001';
  end if;
  if v_e.match_status = 'matched' then
    raise exception 'USER: This line is matched to a receipt. Move the receipt back to Expected to undo the match first.' using errcode = 'P0001';
  end if;
  if p_status = 'ignored' and v_note is null then
    raise exception 'USER: Say why this line is being set aside.' using errcode = 'P0001';
  end if;
  update public.tds_statement_entries
     set match_status = p_status,
         match_note = case when p_status = 'ignored' then left(v_note, 500) else null end
   where id = p_entry_id
  returning * into v_e;
  return jsonb_build_object('id', v_e.id, 'match_status', v_e.match_status, 'updated_at', v_e.updated_at);
end;
$$;

revoke execute on function
  public.set_tds_credit_status(jsonb, text, date, text, text),
  public.set_receipt_deductor_tan(uuid, text, timestamptz),
  public.import_tds_statement(jsonb),
  public.set_tds_entry_status(uuid, text, text)
from public, anon;
grant execute on function
  public.set_tds_credit_status(jsonb, text, date, text, text),
  public.set_receipt_deductor_tan(uuid, text, timestamptz),
  public.import_tds_statement(jsonb),
  public.set_tds_entry_status(uuid, text, text)
to authenticated, service_role;
