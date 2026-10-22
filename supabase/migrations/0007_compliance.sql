-- 0007 · Compliance and filings, registers, engagement letters, peer reviews (§5.6, §5.12, §6.7, §6.8, §7.7, §7.15).
-- document_id FKs are added in 0009; udin_records.audit_engagement_id FK in 0014.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------------------------
-- compliance_events: one calendar for statutory deadlines, internal prep steps and manual dates
-- (§5.6). "Overdue" is derived in compliance_events_view (0016).
-- ---------------------------------------------------------------------------------------------
create table public.compliance_events (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients (id) on delete cascade, -- null = firm-level event
  type public.compliance_type not null,
  form_code text,                              -- e.g. GSTR-3B, 24Q, AOC-4, ITR-6
  title text not null,
  description text,
  financial_year text constraint compliance_events_financial_year_format check (public.is_fy_label(financial_year)),
  filing_period text,                          -- e.g. 'Sep 2026', 'Q2 2026-27'
  period_start date,
  period_end date,
  due_date date not null,
  status public.compliance_status not null default 'pending',
  workflow_status public.compliance_workflow not null default 'not_started',
  is_statutory boolean not null default true,
  source public.compliance_source not null,
  reminder_days int not null default 7 check (reminder_days >= 0),
  task_id uuid references public.tasks (id) on delete set null,
  completed_at timestamptz,
  notes text,
  dedupe_key text unique,                      -- 'client_id|form_code|filing_period': generators never double up
  -- §6.7 "Show the legal source on each event"; §7.7 extended dates show a badge linking to the circular;
  -- §6.7 AGM-linked ROC dates are provisional until the AGM date is entered on the event.
  rule_code text,                              -- due_date_rules.code that generated it (null for manual events)
  source_ref text,                             -- legal source shown on the event
  original_due_date date,                      -- the statutory date before any government extension
  override_id uuid,                            -- due_date_overrides row that moved it (FK added in 0013)
  agm_date date,                               -- ROC events: the AGM date that anchors ADT-1/AOC-4/MGT-7
  is_provisional boolean not null default false,
  reminder_sent_at timestamptz,                -- §8 reminders job idempotency; cleared when the date moves
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint compliance_events_period_order check (period_start is null or period_end is null or period_end >= period_start)
);
alter table public.compliance_events enable row level security;

alter table public.tasks
  add constraint tasks_compliance_event_id_fkey
    foreign key (compliance_event_id) references public.compliance_events (id) on delete set null;

-- ---------------------------------------------------------------------------------------------
-- recurring_compliance_templates: internal prep steps ahead of statutory dates (§5.6, §7.7)
-- ---------------------------------------------------------------------------------------------
create table public.recurring_compliance_templates (
  id uuid primary key default gen_random_uuid(),
  service_type public.service_type not null,
  compliance_type public.compliance_type not null,
  title text not null,
  description text,
  frequency public.service_frequency not null,
  due_day_of_month smallint not null check (due_day_of_month between 1 and 31),
  due_month smallint check (due_month between 1 and 12),
  period_offset smallint not null default 0,
  reminder_days int not null default 7 check (reminder_days >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint recurring_compliance_templates_service_type_title_key unique (service_type, compliance_type, title)
);
alter table public.recurring_compliance_templates enable row level security;

-- ---------------------------------------------------------------------------------------------
-- filing_records: what was actually filed, by us or a previous CA (§5.6, §7.6.5, §7.15.2)
-- ---------------------------------------------------------------------------------------------
create table public.filing_records (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete restrict,
  financial_year text not null constraint filing_records_financial_year_format check (public.is_fy_label(financial_year)),
  filing_type text not null,                   -- free text: GSTR-3B, ITR-6, 24Q, AOC-4…
  service_type public.service_type,
  period text,
  filed_on date,
  acknowledgement_no text,                     -- ARN / ack no / SRN
  filed_by_external text,                      -- previous firm's name, for inherited history
  task_id uuid references public.tasks (id) on delete set null,
  compliance_event_id uuid references public.compliance_events (id) on delete set null,
  document_id uuid,                            -- acknowledgement PDF (FK added in 0009)
  shareable_with_client boolean not null default false, -- §7.22: acknowledgements downloadable in the portal
  notes text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.filing_records enable row level security;

-- ---------------------------------------------------------------------------------------------
-- udin_records (§5.6 + §5.12 extra columns for the tax-audit ceiling, §6.8, §7.15.1)
-- counts_towards_tax_audit_ceiling is derived from report_form by a trigger (0017).
-- ---------------------------------------------------------------------------------------------
create table public.udin_records (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients (id) on delete restrict,
  udin citext not null unique
    constraint udin_records_udin_format check (udin::text ~ '^[0-9A-Z]{18}$'), -- 18 characters, upper-case (§6.2)
  document_type text not null,                 -- Tax Audit Report, Statutory Audit Report, Certificate, GST Audit, Net-worth certificate, Other
  document_date date not null,
  filing_record_id uuid references public.filing_records (id) on delete set null,
  audit_engagement_id uuid,                    -- §7.15.1 "Linked filing record / audit engagement" (FK added in 0014)
  signing_partner_id uuid references public.profiles (id) on delete set null,
  financial_year text                          -- §6.8: FY the report covers (head office + branch of the same assessee/year count once)
    constraint udin_records_financial_year_format check (public.is_fy_label(financial_year)),
  remarks text,
  -- §5.12 extra columns
  signed_on date not null,                     -- the date the report was signed (not the UDIN generation date)
  generated_on date not null,
  report_form text constraint udin_records_report_form_values check (report_form in (
    '3CA', '3CB_44AB_a', '3CB_44AB_b', '3CB_combined', '3CB_44AB_c', '3CB_44AB_d', '3CB_44AB_e',
    'FORM_26', 'audit_report', 'certificate', 'gst_audit', 'other'
  )),
  is_revised boolean not null default false,
  counts_towards_tax_audit_ceiling boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.udin_records enable row level security;

-- ---------------------------------------------------------------------------------------------
-- statutory_registrations (§5.6, §7.15.1). DIN rows track the DIR-3 KYC Web triennial cycle (§6.7).
-- ---------------------------------------------------------------------------------------------
create table public.statutory_registrations (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  registration_type text not null constraint statutory_registrations_type_values check (registration_type in (
    'GST', 'PT', 'IEC', 'MSME_UDYAM', 'FSSAI', 'SHOPS_ESTAB', 'PF', 'ESIC', 'DIN', 'LLPIN', 'CIN', 'TAN', 'OTHER'
  )),
  registration_number text not null,
  jurisdiction text,
  issue_date date,
  expiry_date date,
  reminder_days int not null default 30 check (reminder_days >= 0),
  status public.registration_status not null default 'active',
  last_dir3_kyc_fy text                        -- §6.7, §7.15.1: last DIR-3 KYC Web filed (FY), DIN rows
    constraint statutory_registrations_dir3_fy_format check (public.is_fy_label(last_dir3_kyc_fy)),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.statutory_registrations enable row level security;

-- ---------------------------------------------------------------------------------------------
-- dsc_records (§5.6, §7.15.1)
-- ---------------------------------------------------------------------------------------------
create table public.dsc_records (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  holder_name text not null,
  holder_pan citext,
  dsc_class text not null default 'class_3',
  serial_number text,
  issued_by text,                              -- eMudhra, Capricorn, Sify, (n)Code, Other
  issue_date date,
  expiry_date date not null,
  custody text,                                -- Firm / Client / named person
  status public.dsc_status not null default 'active',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.dsc_records enable row level security;

create trigger normalize_identifiers before insert or update on public.dsc_records
  for each row execute function public.normalize_upper('holder_pan');

-- ---------------------------------------------------------------------------------------------
-- engagement_letters (§5.6, §7.15.3)
-- ---------------------------------------------------------------------------------------------
create table public.engagement_letters (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete restrict,
  financial_year text not null constraint engagement_letters_financial_year_format check (public.is_fy_label(financial_year)),
  service_types public.service_type[] not null,
  scope text,
  fee_agreed numeric(14,2) check (fee_agreed >= 0),
  status public.engagement_status not null default 'draft',
  issued_at timestamptz,
  signed_at timestamptz,
  expires_at date,
  document_id uuid,                            -- the signed letter in the vault (FK added in 0009)
  notes text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.engagement_letters enable row level security;

-- ---------------------------------------------------------------------------------------------
-- peer_reviews (§5.6, §6.8)
-- ---------------------------------------------------------------------------------------------
create table public.peer_reviews (
  id uuid primary key default gen_random_uuid(),
  period_from date not null,
  period_to date not null,
  reviewer_name text not null,
  reviewer_frn text,
  status public.peer_review_status not null default 'scheduled',
  reviewed_on date,
  certificate_no text,
  valid_until date,
  observations text,
  notes text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint peer_reviews_period_order check (period_to >= period_from)
);
alter table public.peer_reviews enable row level security;

update public.app_meta set value = '0007' where key = 'schema_version';
