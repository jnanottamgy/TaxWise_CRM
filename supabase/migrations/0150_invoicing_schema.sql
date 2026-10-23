-- 0150 · Invoicing: the columns, guards and helpers the invoice, receipt and credit-note functions
-- (0151–0154) build on (§5.7, §6.3, §6.4, §7.9.2–§7.9.7, §13).
--
--   invoices                     place-of-supply override reason (§7.9.2 "overridable with a reason"),
--                                the client's state at issue, who issued it and when, the approval
--                                trail (submitted / returned), dispute and waiver records (§7.9.3),
--                                the authorised signatory printed on the PDF (§6.4 Rule 46), the last
--                                send, and updated_by for "Changed by … at …" (§13).
--   invoice_items                where a line came from (§7.9.2 "Add from: Engagement · Unbilled time
--                                · Completed task") and the reason for an "other" GST rate (§6.4).
--   credit_notes                 the s.34 deadline that applied when it was issued, and a note.
--   gst_annual_returns           the date TaxWise filed its annual return for an FY: the s.34 deadline
--                                is 30 November after the FY or that date, whichever is earlier (§6.4).
--   invoices_content_guard       once issued, what is printed on the invoice (due date, notes, terms,
--                                period, links, signatory) never changes (§7.9.3 "Issued invoices are
--                                never edited"); 0017 already freezes the number, amounts and snapshots.
--   gst_state_name(code)         the §6.2 state table (mirror of lib/domain/india-validators STATE_CODES).
--   format_inr(amount)           ₹1,23,456.00 for refusal messages (mirror of lib/domain/money formatINR).
--   credit_note_deadline(…)      the s.34 deadline (mirror of lib/domain/gst.ts creditNoteDeadline).
--   normalise_period_label(text) a comparable billing period ("Sep 2026" = "sep  2026", "FY 2026-27" =
--                                "2026-27"), as lib/domain/invoice.ts normalisePeriodLabel compares them.
--   invoice_change_conflict(id)  "Changed by Anita at 12:41. Reload to see their changes." (§13).
--
-- The schema version stamp is left to the integrator.

set search_path = public, extensions;

-- =============================================================================================
-- invoices
-- =============================================================================================
alter table public.invoices
  add column if not exists place_of_supply_reason text,
  add column if not exists client_state_snapshot char(2),
  add column if not exists issued_at timestamptz,
  add column if not exists issued_by uuid,
  add column if not exists submitted_at timestamptz,
  add column if not exists returned_at timestamptz,
  add column if not exists returned_by uuid,
  add column if not exists disputed_at timestamptz,
  add column if not exists disputed_by uuid,
  add column if not exists dispute_resolved_at timestamptz,
  add column if not exists waived_at timestamptz,
  add column if not exists waived_by uuid,
  add column if not exists waived_amount numeric(14,2),
  add column if not exists signatory_id uuid,
  add column if not exists signatory_name text,
  add column if not exists last_sent_at timestamptz,
  add column if not exists updated_by uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'invoices_client_state_snapshot_format') then
    alter table public.invoices
      add constraint invoices_client_state_snapshot_format check (client_state_snapshot is null or client_state_snapshot ~ '^[0-9]{2}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'invoices_waived_amount_non_negative') then
    alter table public.invoices
      add constraint invoices_waived_amount_non_negative check (waived_amount is null or waived_amount >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'invoices_sent_channels_values') then
    alter table public.invoices
      add constraint invoices_sent_channels_values
        check (sent_channels is null or sent_channels <@ array['email', 'whatsapp', 'gmail', 'in_person']::text[]);
  end if;
end;
$$;

comment on column public.invoices.place_of_supply_reason is 'Why the place of supply differs from the one derived from the client (§7.9.2).';
comment on column public.invoices.client_state_snapshot is 'The client''s state code at issue (Rule 46: an unregistered recipient''s state).';
comment on column public.invoices.issued_at is 'When the invoice left Draft and took its number (§7.9.2).';
comment on column public.invoices.submitted_at is 'When a held invoice was last sent to the Partners for approval (§7.9.2).';
comment on column public.invoices.returned_at is 'When a Partner last returned a held invoice with a note (approval_note) (§7.9.2).';
comment on column public.invoices.waived_amount is 'The outstanding amount written off when a Partner waived the invoice (§7.9.3).';
comment on column public.invoices.signatory_id is 'The Partner who signs the invoice as Authorised Signatory (§6.4 Rule 46), chosen at issue.';
comment on column public.invoices.signatory_name is 'The signatory''s name as printed on the invoice, at issue.';
comment on column public.invoices.last_sent_at is 'The last time the invoice was emailed or handed off (§7.9.3).';

create index if not exists invoices_original_invoice_idx on public.invoices (original_invoice_id) where original_invoice_id is not null;
create index if not exists invoices_revised_from_idx on public.invoices (revised_from_id) where revised_from_id is not null;
create index if not exists invoices_client_service_idx on public.invoices (client_service_id) where client_service_id is not null;

-- updated_by: who touched the invoice last, for the concurrency refusal (§13).
create or replace function public.invoices_stamp_updated_by()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if auth.uid() is not null then
    new.updated_by := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists invoices_stamp_updated_by on public.invoices;
create trigger invoices_stamp_updated_by before insert or update on public.invoices
  for each row execute function public.invoices_stamp_updated_by();

-- =============================================================================================
-- invoices_content_guard: what is printed on an issued invoice never changes (§7.9.3). The number,
-- client, dates, amounts and snapshots are frozen by invoices_issued_guard (0017); this adds the
-- rest of the printed content and the links. E-invoice fields (IRN, ack, signed QR), the send
-- record, and the dispute / waiver / cancel records stay writable.
-- =============================================================================================
create or replace function public.invoices_content_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if old.status in ('draft', 'awaiting_approval') then
    return new;
  end if;
  if new.due_date is distinct from old.due_date
     or new.notes is distinct from old.notes
     or new.terms is distinct from old.terms
     or new.billing_period_label is distinct from old.billing_period_label
     or new.service_type is distinct from old.service_type
     or new.client_service_id is distinct from old.client_service_id
     or new.source_task_id is distinct from old.source_task_id
     or new.revised_from_id is distinct from old.revised_from_id
     or new.revision_number is distinct from old.revision_number
     or new.place_of_supply_reason is distinct from old.place_of_supply_reason
     or new.client_state_snapshot is distinct from old.client_state_snapshot
     or new.issued_at is distinct from old.issued_at
     or new.issued_by is distinct from old.issued_by
     or new.signatory_id is distinct from old.signatory_id
     or new.signatory_name is distinct from old.signatory_name
     or new.created_by is distinct from old.created_by
  then
    raise exception 'USER: An issued invoice can''t be edited. Cancel and reissue it, or raise a credit or debit note.'
      using errcode = 'P0001';
  end if;
  if old.waived_at is not null and (new.waived_at is distinct from old.waived_at or new.waived_amount is distinct from old.waived_amount) then
    raise exception 'USER: A waived invoice stays waived.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists invoices_content_guard on public.invoices;
create trigger invoices_content_guard before update on public.invoices
  for each row execute function public.invoices_content_guard();

-- =============================================================================================
-- invoice_items: where the line came from, and the reason for an "other" GST rate.
-- =============================================================================================
alter table public.invoice_items
  add column if not exists client_service_id uuid references public.client_services (id) on delete set null,
  add column if not exists source_task_id uuid references public.tasks (id) on delete set null,
  add column if not exists time_entry_ids uuid[] not null default '{}',
  add column if not exists tax_rate_reason text;

comment on column public.invoice_items.client_service_id is 'Added from this engagement''s agreed fee (§7.9.2 "Add from: Engagement").';
comment on column public.invoice_items.source_task_id is 'Added from this task (§7.9.2 "Completed task" or the task of "Unbilled time").';
comment on column public.invoice_items.time_entry_ids is 'The unbilled time entries this line bills; they are marked invoiced when the invoice is issued (§7.9.2).';
comment on column public.invoice_items.tax_rate_reason is 'Why a GST rate outside the picker (18%, 5%, 0%) was used (§6.4).';

create index if not exists invoice_items_client_service_idx on public.invoice_items (client_service_id) where client_service_id is not null;
create index if not exists invoice_items_source_task_idx on public.invoice_items (source_task_id) where source_task_id is not null;
create index if not exists invoice_items_time_entries_idx on public.invoice_items using gin (time_entry_ids);

-- =============================================================================================
-- credit_notes
-- =============================================================================================
alter table public.credit_notes
  add column if not exists s34_deadline date,
  add column if not exists notes text;

comment on column public.credit_notes.s34_deadline is 'The s.34 deadline that applied to the invoice when this credit note was issued (§6.4).';

create index if not exists credit_notes_invoice_idx on public.credit_notes (invoice_id);
create index if not exists credit_notes_client_issue_idx on public.credit_notes (client_id, issue_date desc);
create index if not exists payment_receipts_payment_date_idx on public.payment_receipts (payment_date desc);

-- =============================================================================================
-- gst_annual_returns: when TaxWise filed its own GST annual return (GSTR-9) for an FY (§6.4 s.34).
-- Partners and Managers read it; Partners record it (they issue credit notes, §4.1).
-- =============================================================================================
create table if not exists public.gst_annual_returns (
  financial_year text primary key constraint gst_annual_returns_fy_format check (public.is_fy_label(financial_year)),
  filed_on date not null,
  arn text,
  recorded_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.gst_annual_returns enable row level security;

comment on table public.gst_annual_returns is
  'TaxWise''s own GST annual return per FY: its filing date can bring the s.34 credit-note deadline forward (§6.4).';

drop trigger if exists set_updated_at on public.gst_annual_returns;
create trigger set_updated_at before update on public.gst_annual_returns
  for each row execute function public.set_updated_at();

drop policy if exists gst_annual_returns_select on public.gst_annual_returns;
create policy gst_annual_returns_select on public.gst_annual_returns
  for select to authenticated using ((select public.is_manager_or_partner()));
drop policy if exists gst_annual_returns_insert on public.gst_annual_returns;
create policy gst_annual_returns_insert on public.gst_annual_returns
  for insert to authenticated with check ((select public.is_partner()) and recorded_by = (select auth.uid()));
drop policy if exists gst_annual_returns_update on public.gst_annual_returns;
create policy gst_annual_returns_update on public.gst_annual_returns
  for update to authenticated using ((select public.is_partner())) with check ((select public.is_partner()));

revoke all on public.gst_annual_returns from anon, public;
grant select, insert, update on public.gst_annual_returns to authenticated;
grant all on public.gst_annual_returns to service_role;

-- =============================================================================================
-- Helpers
-- =============================================================================================

-- §6.2 state codes (mirror of STATE_CODES in lib/domain/india-validators.ts).
create or replace function public.gst_state_name(p_code text)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case btrim(coalesce(p_code, ''))
    when '01' then 'Jammu & Kashmir' when '02' then 'Himachal Pradesh' when '03' then 'Punjab'
    when '04' then 'Chandigarh' when '05' then 'Uttarakhand' when '06' then 'Haryana'
    when '07' then 'Delhi' when '08' then 'Rajasthan' when '09' then 'Uttar Pradesh'
    when '10' then 'Bihar' when '11' then 'Sikkim' when '12' then 'Arunachal Pradesh'
    when '13' then 'Nagaland' when '14' then 'Manipur' when '15' then 'Mizoram'
    when '16' then 'Tripura' when '17' then 'Meghalaya' when '18' then 'Assam'
    when '19' then 'West Bengal' when '20' then 'Jharkhand' when '21' then 'Odisha'
    when '22' then 'Chhattisgarh' when '23' then 'Madhya Pradesh' when '24' then 'Gujarat'
    when '25' then 'Daman & Diu (legacy)' when '26' then 'Dadra & Nagar Haveli and Daman & Diu'
    when '27' then 'Maharashtra' when '28' then 'Andhra Pradesh (old)' when '29' then 'Karnataka'
    when '30' then 'Goa' when '31' then 'Lakshadweep' when '32' then 'Kerala'
    when '33' then 'Tamil Nadu' when '34' then 'Puducherry' when '35' then 'Andaman & Nicobar'
    when '36' then 'Telangana' when '37' then 'Andhra Pradesh' when '38' then 'Ladakh'
    when '97' then 'Other Territory' when '99' then 'Centre Jurisdiction'
  end
$$;

comment on function public.gst_state_name(text) is 'The §6.2 state name for a GST state code, or null (mirror of lib/domain/india-validators STATE_CODES).';

-- ₹1,23,456.00: Indian grouping, two decimals, for refusal messages (mirror of formatINR).
create or replace function public.format_inr(p_amount numeric)
returns text
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  v_abs numeric := abs(round(coalesce(p_amount, 0), 2));
  v_int text := trunc(v_abs)::bigint::text;
  v_dec text := lpad(((v_abs - trunc(v_abs)) * 100)::int::text, 2, '0');
  v_head text;
  v_tail text;
begin
  if length(v_int) > 3 then
    v_tail := right(v_int, 3);
    v_head := left(v_int, length(v_int) - 3);
    v_head := regexp_replace(reverse(regexp_replace(reverse(v_head), '([0-9]{2})(?=[0-9])', '\1,', 'g')), '^,', '');
    v_int := v_head || ',' || v_tail;
  end if;
  return case when p_amount < 0 and v_abs > 0 then '-' else '' end || '₹' || v_int || '.' || v_dec;
end;
$$;

comment on function public.format_inr(numeric) is '₹1,23,456.00 (Indian grouping, two decimals), as lib/domain/money formatINR writes it.';

-- 22 Oct 2026 (§0.1 rule 13), for refusal messages.
create or replace function public.format_day(p_date date)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select to_char(p_date, 'DD Mon YYYY')
$$;

-- The s.34 deadline (§6.4; mirror of creditNoteDeadline in lib/domain/gst.ts): 30 November after
-- the end of the FY of the invoice (month/day from gst.credit_note_deadline in force on p_on), or
-- the date the annual return for that FY was filed, whichever is earlier.
create or replace function public.credit_note_deadline(p_invoice_date date, p_annual_return_filed_on date default null, p_on date default null)
returns date
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  v_param jsonb := public.statutory_param_value('gst.credit_note_deadline', coalesce(p_on, public.today_ist()));
  v_month int := coalesce(public.jsonb_to_numeric(v_param -> 'month')::int, 11);
  v_day int := coalesce(public.jsonb_to_numeric(v_param -> 'day')::int, 30);
  v_fy_end_year int;
  v_statutory date;
begin
  if p_invoice_date is null then
    return null;
  end if;
  v_fy_end_year := extract(year from p_invoice_date)::int + case when extract(month from p_invoice_date) >= 4 then 1 else 0 end;
  v_statutory := make_date(v_fy_end_year, v_month, v_day);
  if p_annual_return_filed_on is not null and p_annual_return_filed_on < v_statutory then
    return p_annual_return_filed_on;
  end if;
  return v_statutory;
end;
$$;

comment on function public.credit_note_deadline(date, date, date) is
  's.34 CGST Act: 30 Nov after the FY of the invoice, or the annual return''s filing date if earlier (§6.4; mirror of creditNoteDeadline).';

-- A comparable billing period label (lib/domain/invoice.ts normalisePeriodLabel for the forms the
-- app writes: "Sep 2026", "Q2 2026-27", "FY 2026-27" / "2026-27").
create or replace function public.normalise_period_label(p_label text)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select nullif(regexp_replace(lower(regexp_replace(btrim(coalesce(p_label, '')), '\s+', ' ', 'g')), '^fy ', ''), '')
$$;

-- "Changed by Anita at 12:41. Reload to see their changes." (§13) for an invoice the caller can see.
create or replace function public.invoice_change_conflict(p_invoice_id uuid)
returns text
language sql
stable
security definer
set search_path = public, extensions
as $$
  select format(
    'USER: Changed by %s at %s. Reload to see their changes.',
    coalesce(p.full_name, 'someone else'),
    to_char(i.updated_at at time zone 'Asia/Kolkata', 'HH24:MI')
  )
  from public.invoices i
  left join public.profiles p on p.id = i.updated_by
  where i.id = p_invoice_id
    and public.is_manager_or_partner()
$$;

comment on function public.invoice_change_conflict(uuid) is
  'The concurrency refusal for an invoice: "Changed by <name> at <IST time>. Reload to see their changes." (§13).';

revoke execute on function
  public.invoices_stamp_updated_by(),
  public.invoices_content_guard()
from public, anon, authenticated;

revoke execute on function
  public.gst_state_name(text),
  public.format_inr(numeric),
  public.format_day(date),
  public.credit_note_deadline(date, date, date),
  public.normalise_period_label(text),
  public.invoice_change_conflict(uuid)
from public, anon;

grant execute on function
  public.gst_state_name(text),
  public.format_inr(numeric),
  public.format_day(date),
  public.credit_note_deadline(date, date, date),
  public.normalise_period_label(text),
  public.invoice_change_conflict(uuid)
to authenticated, service_role;
