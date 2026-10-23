-- 0160 · Collections: the tables and columns behind follow-ups, payment reminders, retainer
-- billing and TDS credits (§5.7, §7.9.5, §7.9.6, §7.9.9, §8).
--
--   invoice_reminders         one row per reminder slot (3 days before the due date, then 1, 7 and
--                             15 days after it): which slot (reminder_key 'before_due:3',
--                             'after_due:7'), the due date it was planned for, and what happened
--                             to it: emailed (sent / failed), or handed to a Partner or Manager to
--                             send by WhatsApp or Gmail (handoff_pending → handed_off, or
--                             dismissed). The key is unique per invoice, so the daily job never
--                             sends one twice.
--   retainer_runs             one row per run of the retainer job: its counts (drafts made, each
--                             §7.9.6 skip reason), the engagements that hit the catch-up cap, and
--                             any engagement that failed.
--   retainer_drafts           the Draft invoices a run created, for the "Retainer drafts" queue.
--   payment_receipts (TDS)    when a TDS credit was claimed, and in which return; who last changed
--                             its status and why (Expected → Reflected in 26AS / AIS (Form 168) →
--                             Claimed).
--   tds_statement_imports     each 26AS / AIS (Form 168) file imported, with its match counts.
--   tds_statement_entries     how each line of a statement matched (matched / amount mismatch /
--                             unmatched / ignored), the booking status and date the statement gives,
--                             and the client whose TAN it carries.
--   tds_statement_matches     which receipts a statement line settles (one line can cover several
--                             receipts the client paid together; a receipt matches one line).
--
-- Everything here is money: Partners and Managers only (§4.1, §4.6). Retainer runs and drafts are
-- written only by the retainer job (service role); staff read them. The schema version stamp is
-- left to the integrator.

set search_path = public, extensions;

-- =============================================================================================
-- invoice_reminders
-- =============================================================================================
alter table public.invoice_reminders
  add column if not exists reminder_key text,
  add column if not exists offset_days int,
  add column if not exists due_date date,
  add column if not exists owner_user_id uuid references public.profiles (id) on delete set null,
  add column if not exists recipient text,
  add column if not exists message_id uuid references public.messages (id) on delete set null,
  add column if not exists error text,
  add column if not exists handed_off_at timestamptz,
  add column if not exists handed_off_by uuid,
  add column if not exists dismissed_at timestamptz,
  add column if not exists dismissed_by uuid,
  add column if not exists dismiss_reason text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'invoice_reminders_status_values') then
    alter table public.invoice_reminders
      add constraint invoice_reminders_status_values
        check (status in ('pending', 'sent', 'failed', 'handoff_pending', 'handed_off', 'dismissed', 'skipped'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'invoice_reminders_key_format') then
    alter table public.invoice_reminders
      add constraint invoice_reminders_key_format
        check (reminder_key is null or reminder_key ~ '^(before_due|after_due):[0-9]{1,3}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'invoice_reminders_dismiss_has_reason') then
    alter table public.invoice_reminders
      add constraint invoice_reminders_dismiss_has_reason
        check (status <> 'dismissed' or nullif(btrim(dismiss_reason), '') is not null);
  end if;
end;
$$;

comment on column public.invoice_reminders.reminder_key is
  'The §7.9.5 slot: before_due:3, after_due:1, after_due:7, after_due:15. One row per slot per invoice.';
comment on column public.invoice_reminders.owner_user_id is
  'Who sends it by hand when email can''t go: the client''s owner if a Partner or Manager, else the invoice''s raiser (never an Employee, §4.1).';
comment on column public.invoice_reminders.status is
  'pending · sent (emailed) · failed · handoff_pending (waiting for a person to send by WhatsApp or Gmail) · handed_off · dismissed · skipped.';

create unique index if not exists invoice_reminders_invoice_key
  on public.invoice_reminders (invoice_id, reminder_key) where reminder_key is not null;
create index if not exists invoice_reminders_handoff_idx
  on public.invoice_reminders (owner_user_id, created_at desc) where status = 'handoff_pending';
create index if not exists invoice_reminders_invoice_created_idx
  on public.invoice_reminders (invoice_id, created_at desc);

-- =============================================================================================
-- retainer_runs / retainer_drafts (§7.9.6)
-- =============================================================================================
create table if not exists public.retainer_runs (
  id uuid primary key default gen_random_uuid(),
  run_date date not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  -- engagements_checked, drafts_created, engagements_billed, already_billed, capped, failed and one
  -- count per §7.9.6 skip reason (skipped_not_enabled … skipped_not_yet_due).
  counts jsonb not null default '{}'::jsonb,
  -- [{ client_service_id, client_id, client_name, service, next_billing_date, periods_left }]
  capped jsonb not null default '[]'::jsonb,
  -- [{ client_service_id, client_id, client_name, error }]
  errors jsonb not null default '[]'::jsonb,
  drafts_created int not null default 0 check (drafts_created >= 0),
  drafts_total numeric(14,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.retainer_runs enable row level security;

comment on table public.retainer_runs is
  'One row per run of the retainer billing job (§7.9.6, §8 09:30): its counts, the engagements that hit the catch-up cap of 3, and failures.';

drop trigger if exists set_updated_at on public.retainer_runs;
create trigger set_updated_at before update on public.retainer_runs
  for each row execute function public.set_updated_at();

create table if not exists public.retainer_drafts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.retainer_runs (id) on delete cascade,
  invoice_id uuid not null unique references public.invoices (id) on delete cascade,
  client_service_id uuid references public.client_services (id) on delete set null,
  billing_date date not null,
  period_label text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.retainer_drafts enable row level security;

comment on table public.retainer_drafts is
  'The Draft invoices the retainer job created (never sent automatically, §7.9.6): the "Retainer drafts" queue.';

drop trigger if exists set_updated_at on public.retainer_drafts;
create trigger set_updated_at before update on public.retainer_drafts
  for each row execute function public.set_updated_at();

create index if not exists retainer_runs_date_idx on public.retainer_runs (run_date desc, started_at desc);
create index if not exists retainer_drafts_run_idx on public.retainer_drafts (run_id);
create index if not exists retainer_drafts_service_idx on public.retainer_drafts (client_service_id) where client_service_id is not null;

drop policy if exists retainer_runs_select on public.retainer_runs;
create policy retainer_runs_select on public.retainer_runs
  for select to authenticated using ((select public.is_manager_or_partner()));
drop policy if exists retainer_drafts_select on public.retainer_drafts;
create policy retainer_drafts_select on public.retainer_drafts
  for select to authenticated using ((select public.is_manager_or_partner()));

revoke all on public.retainer_runs, public.retainer_drafts from anon, public;
revoke insert, update, delete on public.retainer_runs, public.retainer_drafts from authenticated;
grant select on public.retainer_runs, public.retainer_drafts to authenticated;
grant all on public.retainer_runs, public.retainer_drafts to service_role;

-- =============================================================================================
-- payment_receipts: the TDS credit trail (§7.9.9). The money on a receipt never changes (0017
-- payment_receipts_guard); these columns may.
-- =============================================================================================
alter table public.payment_receipts
  add column if not exists tds_claimed_on date,
  add column if not exists tds_claimed_in text,
  add column if not exists tds_status_note text,
  add column if not exists tds_status_changed_at timestamptz,
  add column if not exists tds_status_changed_by uuid;

comment on column public.payment_receipts.tds_claimed_in is 'Where the credit was claimed, e.g. "ITR for tax year 2026-27" (§7.9.9).';

create index if not exists payment_receipts_tds_idx
  on public.payment_receipts (tds_status, payment_date desc) where tds_amount > 0 and reversed_at is null;
create index if not exists payment_receipts_deductor_idx
  on public.payment_receipts (deductor_tan) where tds_amount > 0 and reversed_at is null;

-- =============================================================================================
-- tds_statement_imports / entries / matches (§7.9.9)
-- =============================================================================================
create table if not exists public.tds_statement_imports (
  id uuid primary key default gen_random_uuid(),
  financial_year text not null constraint tds_statement_imports_fy_format check (public.is_fy_label(financial_year)),
  source text not null default '26as' constraint tds_statement_imports_source_values check (source in ('26as', 'ais', 'form_168', 'other')),
  file_name text,
  rows_total int not null default 0 check (rows_total >= 0),
  matched int not null default 0 check (matched >= 0),
  amount_mismatches int not null default 0 check (amount_mismatches >= 0),
  unmatched int not null default 0 check (unmatched >= 0),
  imported_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.tds_statement_imports enable row level security;

comment on table public.tds_statement_imports is
  'A 26AS / AIS (Form 168) statement imported on the TDS credits page, with how its lines matched the receipts (§7.9.9).';

drop trigger if exists set_updated_at on public.tds_statement_imports;
create trigger set_updated_at before update on public.tds_statement_imports
  for each row execute function public.set_updated_at();

alter table public.tds_statement_entries
  add column if not exists match_status text not null default 'unmatched',
  add column if not exists match_note text,
  add column if not exists booking_status text,
  add column if not exists booking_date date,
  add column if not exists client_id uuid references public.clients (id) on delete set null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tds_statement_entries_match_status_values') then
    alter table public.tds_statement_entries
      add constraint tds_statement_entries_match_status_values
        check (match_status in ('matched', 'amount_mismatch', 'unmatched', 'ignored'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tds_statement_entries_import_batch_id_fkey') then
    alter table public.tds_statement_entries
      add constraint tds_statement_entries_import_batch_id_fkey
        foreign key (import_batch_id) references public.tds_statement_imports (id) on delete cascade;
  end if;
end;
$$;

create index if not exists tds_statement_entries_batch_idx on public.tds_statement_entries (import_batch_id);
create index if not exists tds_statement_entries_status_idx on public.tds_statement_entries (match_status, financial_year);
create index if not exists tds_statement_entries_client_idx on public.tds_statement_entries (client_id) where client_id is not null;

create table if not exists public.tds_statement_matches (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.tds_statement_entries (id) on delete cascade,
  receipt_id uuid not null unique references public.payment_receipts (id) on delete cascade,
  matched_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.tds_statement_matches enable row level security;

comment on table public.tds_statement_matches is
  'The receipts a 26AS / AIS line settles: one line may cover several receipts the client paid together; a receipt matches one line (§7.9.9).';

drop trigger if exists set_updated_at on public.tds_statement_matches;
create trigger set_updated_at before update on public.tds_statement_matches
  for each row execute function public.set_updated_at();

create index if not exists tds_statement_matches_entry_idx on public.tds_statement_matches (entry_id);

drop policy if exists tds_statement_imports_select on public.tds_statement_imports;
create policy tds_statement_imports_select on public.tds_statement_imports
  for select to authenticated using ((select public.is_manager_or_partner()));
drop policy if exists tds_statement_imports_insert on public.tds_statement_imports;
create policy tds_statement_imports_insert on public.tds_statement_imports
  for insert to authenticated with check ((select public.is_manager_or_partner()) and imported_by = (select auth.uid()));
drop policy if exists tds_statement_imports_update on public.tds_statement_imports;
create policy tds_statement_imports_update on public.tds_statement_imports
  for update to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));
drop policy if exists tds_statement_imports_delete on public.tds_statement_imports;
create policy tds_statement_imports_delete on public.tds_statement_imports
  for delete to authenticated using ((select public.is_partner()));

drop policy if exists tds_statement_matches_select on public.tds_statement_matches;
create policy tds_statement_matches_select on public.tds_statement_matches
  for select to authenticated using ((select public.is_manager_or_partner()));
drop policy if exists tds_statement_matches_insert on public.tds_statement_matches;
create policy tds_statement_matches_insert on public.tds_statement_matches
  for insert to authenticated with check ((select public.is_manager_or_partner()));
drop policy if exists tds_statement_matches_delete on public.tds_statement_matches;
create policy tds_statement_matches_delete on public.tds_statement_matches
  for delete to authenticated using ((select public.is_manager_or_partner()));

revoke all on public.tds_statement_imports, public.tds_statement_matches from anon, public;
grant select, insert, update, delete on public.tds_statement_imports to authenticated;
grant select, insert, delete on public.tds_statement_matches to authenticated;
grant all on public.tds_statement_imports, public.tds_statement_matches to service_role;

-- =============================================================================================
-- The B2CL threshold for TaxWise's own GSTR-1 (§7.9.8): an inter-state invoice to an unregistered
-- recipient above this value is reported invoice by invoice (B2CL); everything else to
-- unregistered recipients is summarised (B2CS). A law-driven value (§5.12), editable on Law &
-- rules. [verify against the notification]
-- =============================================================================================
insert into public.statutory_parameters (key, value, effective_from, effective_to, statute, section_ref, source_ref, notes)
select v.key, v.value::jsonb, v.effective_from::date, v.effective_to::date, 'CGST Rules, 2017', 'Rule 59 (GSTR-1 Table 5)', v.source_ref, v.notes
from (values
  ('gst.gstr1_b2cl_threshold', '{"amount": 250000, "inclusive": false}', '2017-07-01', '2024-07-31',
   'Rule 59, CGST Rules, 2017', 'B2CL: inter-state invoices to unregistered persons above ₹2,50,000.'),
  ('gst.gstr1_b2cl_threshold', '{"amount": 100000, "inclusive": false}', '2024-08-01', null,
   'Notification No. 12/2024–Central Tax dated 10 July 2024 [verify]', 'B2CL: inter-state invoices to unregistered persons above ₹1,00,000.')
) as v(key, value, effective_from, effective_to, source_ref, notes)
where not exists (
  select 1 from public.statutory_parameters p where p.key = v.key and p.effective_from = v.effective_from::date
);
