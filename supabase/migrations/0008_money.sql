-- 0008 · Money: invoices, items, receipts, credit notes, collections, portal "I've paid" claims,
-- TDS credits (§5.7, §6.4, §6.5, §7.9, §7.22).
-- Settlement columns and the sent ↔ partially_paid ↔ paid status are maintained by triggers (0017).

set search_path = public, extensions;

-- ---------------------------------------------------------------------------------------------
-- invoices (§5.7, §7.9). "Overdue" is derived in invoices_view (0016); a draft is never overdue.
-- ---------------------------------------------------------------------------------------------
create table public.invoices (
  -- Identity
  id uuid primary key default gen_random_uuid(),
  -- From number_series (§5.11) when the invoice leaves Draft (§7.9.2: "Drafts show 'Draft'"), so it
  -- may be null only while draft / awaiting approval. Rule 46 (§0.1 rule 6, §6.4): unique, at most
  -- 16 characters, letters, digits, '-' and '/' only.
  invoice_number text unique
    constraint invoices_number_rule_46 check (char_length(invoice_number) <= 16 and invoice_number ~ '^[A-Za-z0-9/-]+$'),
  invoice_kind text not null default 'tax_invoice'   -- §7.9.3: debit note / supplementary invoice (increase)
    constraint invoices_kind_values check (invoice_kind in ('tax_invoice', 'debit_note')),
  client_id uuid not null references public.clients (id) on delete restrict,

  -- Dates and status
  issue_date date not null default public.today_ist(),
  due_date date not null,
  status public.invoice_status not null default 'draft',

  -- Snapshots at issue
  client_name_snapshot text,
  client_address_snapshot text,
  client_gstin_snapshot citext,
  place_of_supply_code char(2) not null constraint invoices_pos_format check (place_of_supply_code ~ '^[0-9]{2}$'),
  firm_gstin_snapshot citext,

  -- Totals
  reverse_charge boolean not null default false,
  taxable_amount numeric(14,2) not null default 0,
  cgst_amount numeric(14,2) not null default 0,
  sgst_amount numeric(14,2) not null default 0,
  igst_amount numeric(14,2) not null default 0,
  reimbursement_amount numeric(14,2) not null default 0, -- non-taxable pure-agent expenses (Rule 33)
  round_off numeric(6,2) not null default 0,
  total_amount numeric(14,2) not null default 0,         -- taxable + tax + reimbursements + round-off

  -- Settlement (maintained by trigger from receipts and credit notes, 0017)
  amount_received numeric(14,2) not null default 0,
  tds_credited numeric(14,2) not null default 0,
  credit_noted numeric(14,2) not null default 0,
  outstanding_amount numeric(14,2) not null default 0,

  -- Content
  service_type public.service_type,
  billing_period_label text,
  notes text,
  terms text,

  -- Links
  source_task_id uuid references public.tasks (id) on delete set null,
  client_service_id uuid references public.client_services (id) on delete set null, -- retainer source
  revised_from_id uuid references public.invoices (id) on delete set null,          -- cancel & reissue (§7.9.3)
  original_invoice_id uuid references public.invoices (id) on delete restrict,     -- §7.9.3: the invoice a debit note increases
  revision_number int not null default 0 check (revision_number >= 0),

  -- Approval and sending
  requires_approval boolean not null default false, -- frozen at creation
  approved_by uuid,
  approved_at timestamptz,
  approval_note text,                          -- §7.9.2: "Return with note"
  sent_at timestamptz,
  sent_channels text[],
  waived_reason text,
  disputed_reason text,

  -- Cancel & reissue (§7.9.3): the original keeps its number and is marked cancelled with a reason.
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancel_reason text,

  -- Optional e-invoicing fields (§6.4), shown only when firm_settings.e_invoicing_applies.
  irn text,
  irn_ack_no text,
  irn_ack_date timestamptz,
  signed_qr text,

  created_by uuid not null,
  deleted_at timestamptz,
  deleted_by uuid,                             -- §7.19
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint invoices_number_required_once_issued
    check (invoice_number is not null or status in ('draft', 'awaiting_approval')),
  constraint invoices_due_after_issue check (due_date >= issue_date),
  constraint invoices_total_adds_up check (
    total_amount = taxable_amount + cgst_amount + sgst_amount + igst_amount + reimbursement_amount + round_off
  ),
  constraint invoices_igst_xor_cgst_sgst check (igst_amount = 0 or (cgst_amount = 0 and sgst_amount = 0)),
  constraint invoices_round_off_under_one_rupee check (round_off > -1 and round_off < 1), -- §6.3: at most ±₹0.99
  constraint invoices_amounts_non_negative check (
    taxable_amount >= 0 and cgst_amount >= 0 and sgst_amount >= 0 and igst_amount >= 0 and reimbursement_amount >= 0
  ),
  constraint invoices_waived_has_reason check (status <> 'waived' or nullif(btrim(waived_reason), '') is not null),
  constraint invoices_disputed_has_reason check (status <> 'disputed' or nullif(btrim(disputed_reason), '') is not null),
  constraint invoices_cancel_has_reason check (cancelled_at is null or nullif(btrim(cancel_reason), '') is not null),
  constraint invoices_debit_note_has_original check (invoice_kind <> 'debit_note' or original_invoice_id is not null)
);
alter table public.invoices enable row level security;

create trigger normalize_identifiers before insert or update on public.invoices
  for each row execute function public.normalize_upper('client_gstin_snapshot', 'firm_gstin_snapshot');

-- §7.9.2: "the same engagement period already invoiced → block" (also keeps retainer billing idempotent).
create unique index invoices_one_per_engagement_period
  on public.invoices (client_service_id, billing_period_label)
  where client_service_id is not null and billing_period_label is not null
    and deleted_at is null and cancelled_at is null and invoice_kind = 'tax_invoice';

alter table public.time_entries
  add constraint time_entries_invoice_id_fkey foreign key (invoice_id) references public.invoices (id) on delete set null;

-- ---------------------------------------------------------------------------------------------
-- invoice_items (§5.7). Reimbursement lines carry no GST (§6.4).
-- ---------------------------------------------------------------------------------------------
create table public.invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices (id) on delete cascade,
  description text not null,
  service_type public.service_type,
  sac_code text not null constraint invoice_items_sac_format check (sac_code ~ '^[0-9]{4,8}$'),
  quantity numeric(10,2) not null default 1 check (quantity > 0),
  rate numeric(14,2) not null,
  amount numeric(14,2) not null,
  tax_rate numeric(5,2) not null check (tax_rate >= 0), -- 0 for reimbursements
  is_reimbursement boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint invoice_items_reimbursement_untaxed check (not is_reimbursement or tax_rate = 0)
);
alter table public.invoice_items enable row level security;

-- ---------------------------------------------------------------------------------------------
-- payment_receipts (§5.7, §6.5, §7.9.4, §7.9.9). Reversed, never deleted (trigger, 0017).
-- ---------------------------------------------------------------------------------------------
create table public.payment_receipts (
  id uuid primary key default gen_random_uuid(),
  receipt_number text not null unique,
  invoice_id uuid not null references public.invoices (id) on delete restrict,
  payment_date date not null,
  amount_received numeric(14,2) not null check (amount_received >= 0), -- may be 0 if fully settled by TDS
  tds_amount numeric(14,2) not null default 0 check (tds_amount >= 0),
  tds_section text,                            -- 194J, 194C, 194H, 194I, OTHER (2025 Act: s.393 entries)
  method public.payment_method not null,
  reference text,                              -- UTR / cheque no
  deposited_to text,                           -- which firm account
  notes text,
  recorded_by uuid not null,
  reversed_at timestamptz,
  reversed_by uuid,
  reversal_reason text,
  -- §7.9.9 TDS credits: Expected → Reflected in 26AS/AIS (Form 168) → Claimed
  tds_status text not null default 'expected'
    constraint payment_receipts_tds_status_values check (tds_status in ('expected', 'reflected', 'claimed')),
  tds_quarter text,                            -- e.g. 'Q2 2026-27'
  deductor_tan citext,
  tds_reflected_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_receipts_something_received check (amount_received + tds_amount > 0),
  constraint payment_receipts_reversal_has_reason check (reversed_at is null or nullif(btrim(reversal_reason), '') is not null)
);
alter table public.payment_receipts enable row level security;

create trigger normalize_identifiers before insert or update on public.payment_receipts
  for each row execute function public.normalize_upper('deductor_tan');

-- ---------------------------------------------------------------------------------------------
-- credit_notes (§5.7, §6.4, §7.9.7)
-- ---------------------------------------------------------------------------------------------
create table public.credit_notes (
  id uuid primary key default gen_random_uuid(),
  credit_note_number text not null unique
    constraint credit_notes_number_rule_46 check (char_length(credit_note_number) <= 16 and credit_note_number ~ '^[A-Za-z0-9/-]+$'),
  invoice_id uuid not null references public.invoices (id) on delete restrict,
  client_id uuid not null references public.clients (id) on delete restrict,
  reason_code public.credit_note_reason not null,
  reason text not null,
  reduces_gst boolean not null default true,   -- §6.4: false = commercial (non-GST) credit after the s.34 deadline
  taxable_amount numeric(14,2) not null check (taxable_amount > 0),
  tax_rate numeric(5,2) check (tax_rate >= 0),
  cgst_amount numeric(14,2) default 0 check (cgst_amount >= 0),
  sgst_amount numeric(14,2) default 0 check (sgst_amount >= 0),
  igst_amount numeric(14,2) default 0 check (igst_amount >= 0),
  total_amount numeric(14,2) not null check (total_amount > 0),
  place_of_supply_code char(2) constraint credit_notes_pos_format check (place_of_supply_code ~ '^[0-9]{2}$'),
  issue_date date not null default public.today_ist(),
  issued_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.credit_notes enable row level security;

-- ---------------------------------------------------------------------------------------------
-- invoice_follow_ups: collection notes (§5.7, §7.9.5). Append-only.
-- ---------------------------------------------------------------------------------------------
create table public.invoice_follow_ups (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices (id) on delete cascade,
  channel text not null constraint invoice_follow_ups_channel_values
    check (channel in ('call', 'email', 'whatsapp', 'visit', 'other')),
  notes text not null,
  promised_payment_date date,
  next_follow_up_at timestamptz,
  by_user uuid not null,
  created_at timestamptz not null default now()
);
alter table public.invoice_follow_ups enable row level security;

-- ---------------------------------------------------------------------------------------------
-- invoice_reminders (§5.7, §7.9.5)
-- ---------------------------------------------------------------------------------------------
create table public.invoice_reminders (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices (id) on delete cascade,
  kind text not null constraint invoice_reminders_kind_values check (kind in ('before_due', 'after_due', 'custom')),
  scheduled_for timestamptz not null,
  channel public.message_channel not null,
  sent_at timestamptz,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint invoice_reminders_invoice_kind_time_key unique (invoice_id, kind, scheduled_for) -- idempotent job (§8)
);
alter table public.invoice_reminders enable row level security;

-- ---------------------------------------------------------------------------------------------
-- portal_payment_claims (§7.22: "I've paid" with reference + date + optional screenshot; notifies the
-- firm to verify; never marks the invoice paid — only a recorded receipt does).
-- screenshot_document_id FK added in 0009.
-- ---------------------------------------------------------------------------------------------
create table public.portal_payment_claims (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  reference text,
  paid_on date,
  screenshot_document_id uuid,
  note text,
  created_by uuid not null,
  status text not null default 'pending'
    constraint portal_payment_claims_status_values check (status in ('pending', 'verified', 'rejected')),
  verified_by uuid,
  verified_at timestamptz,
  review_note text,
  payment_receipt_id uuid references public.payment_receipts (id) on delete set null, -- the receipt recorded on verification
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.portal_payment_claims enable row level security;

-- ---------------------------------------------------------------------------------------------
-- tds_statement_entries (§7.9.9: import the 26AS/AIS (Form 168) text/CSV to auto-match receipts by
-- deductor TAN and amount; mismatches are listed).
-- ---------------------------------------------------------------------------------------------
create table public.tds_statement_entries (
  id uuid primary key default gen_random_uuid(),
  financial_year text not null constraint tds_statement_entries_financial_year_format check (public.is_fy_label(financial_year)),
  quarter text,                                -- e.g. 'Q2'
  source text not null default '26as',         -- e.g. 26as, ais, form_168, manual
  deductor_tan citext not null,
  deductor_name text,
  section text,
  transaction_date date,
  amount_paid numeric(14,2),
  tds_amount numeric(14,2) not null,
  import_batch_id uuid,
  matched_receipt_id uuid references public.payment_receipts (id) on delete set null,
  matched_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.tds_statement_entries enable row level security;

create trigger normalize_identifiers before insert or update on public.tds_statement_entries
  for each row execute function public.normalize_upper('deductor_tan');

update public.app_meta set value = '0008' where key = 'schema_version';
