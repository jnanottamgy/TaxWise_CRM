-- 0014 · ICAI practice records and DPDP (§5.12, §6.8, §6.9, §6.10, §7.15.4, §7.15.5, §12).

set search_path = public, extensions;

-- ---------------------------------------------------------------------------------------------
-- client_kyc (§5.12, §6.8 ICAI KYC Norms). Never a full Aadhaar number (§6.10).
-- ---------------------------------------------------------------------------------------------
create table public.client_kyc (
  -- Who
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null unique references public.clients (id) on delete cascade,
  entity_category text not null constraint client_kyc_entity_category_values
    check (entity_category in ('individual_proprietor', 'corporate', 'non_corporate')),
  -- Identity
  pan citext,
  cin_llpin text,
  business_description text,
  registered_address text,
  -- People: directors/partners/trustees (name, address, PAN or DIN)
  principal_persons jsonb,
  -- Engagement
  last_audited_fs_document_id uuid references public.documents (id) on delete set null,
  engagement_types text[],
  -- Verification
  verified_by uuid,
  verified_on date,
  next_review_on date,                         -- annual re-confirmation
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.client_kyc enable row level security;

create trigger normalize_identifiers before insert or update on public.client_kyc
  for each row execute function public.normalize_upper('pan');

-- ---------------------------------------------------------------------------------------------
-- previous_auditor_communications (§5.12; CA Act 1949, First Schedule Part I, Clause 8)
-- ---------------------------------------------------------------------------------------------
create table public.previous_auditor_communications (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  engagement_type text not null,
  previous_auditor_name text not null,
  previous_auditor_frn text,
  letter_sent_on date not null,
  delivery_proof_document_id uuid references public.documents (id) on delete set null,
  reply_received_on date,
  objections text,
  outcome text constraint previous_auditor_communications_outcome_values
    check (outcome in ('no_objection', 'objection_resolved', 'objection_unresolved')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.previous_auditor_communications enable row level security;

-- ---------------------------------------------------------------------------------------------
-- audit_engagements (§5.12, §6.9, §7.15.5)
-- engagement_partner_id / review_manager_id hold employees.id (the engagement team, like
-- client_team_members). file_assembly_due is generated: report_date + 60 days (SA 230, §5.12).
-- ---------------------------------------------------------------------------------------------
create table public.audit_engagements (
  -- Engagement
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete restrict,
  audit_type text not null constraint audit_engagements_audit_type_values check (audit_type in (
    'statutory_companies_act', 'tax_audit', 'gst_audit', 'internal', 'bank_branch', 'stock', 'certification', 'other'
  )),
  financial_year text not null constraint audit_engagements_financial_year_format check (public.is_fy_label(financial_year)),
  -- Team
  engagement_partner_id uuid not null,
  review_manager_id uuid,
  -- Status and dates
  stage text not null default 'acceptance' constraint audit_engagements_stage_values check (stage in (
    'acceptance', 'planning', 'risk_assessment', 'execution', 'completion', 'reporting', 'archived'
  )),
  materiality jsonb,                           -- basis, overall, performance, trivial threshold
  report_type text constraint audit_engagements_report_type_values
    check (report_type in ('unmodified', 'qualified', 'adverse', 'disclaimer')),
  report_date date,
  udin_record_id uuid references public.udin_records (id) on delete set null,
  file_assembly_due date generated always as (report_date + 60) stored,
  archived_at timestamptz,                     -- after this the file is read-only
  retain_until date,                           -- report_date + 7 years
  -- Checklists
  caro_applicable boolean,
  checklist jsonb default '{}'::jsonb,         -- SA-mapped steps with evidence links and sign-offs
  -- §6.8 company audit limit (s.141(3)(g)): whether this audit counts towards the 20 per partner
  counts_towards_company_audit_limit boolean,
  -- §6.8 peer review: the entity needs a peer-reviewed auditor (certificate checked at acceptance)
  requires_peer_reviewed_auditor boolean not null default false,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint audit_engagements_archived_stage check (archived_at is null or stage = 'archived')
);
alter table public.audit_engagements enable row level security;

alter table public.udin_records
  add constraint udin_records_audit_engagement_id_fkey
    foreign key (audit_engagement_id) references public.audit_engagements (id) on delete set null;

-- ---------------------------------------------------------------------------------------------
-- tax_audit_external_counts (§6.8: "The per-member count includes an 'audits signed elsewhere'
-- number the partner enters, since other firms' audits count too").
-- ---------------------------------------------------------------------------------------------
create table public.tax_audit_external_counts (
  id uuid primary key default gen_random_uuid(),
  member_profile_id uuid not null references public.profiles (id) on delete cascade,
  financial_year text not null constraint tax_audit_external_counts_financial_year_format check (public.is_fy_label(financial_year)),
  audits_signed_elsewhere int not null default 0 check (audits_signed_elsewhere >= 0),
  notes text,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tax_audit_external_counts_member_fy_key unique (member_profile_id, financial_year)
);
alter table public.tax_audit_external_counts enable row level security;

-- ---------------------------------------------------------------------------------------------
-- DPDP Act 2023 / DPDP Rules 2025 (§5.12, §6.10)
-- ---------------------------------------------------------------------------------------------
create table public.privacy_notices (
  id uuid primary key default gen_random_uuid(),
  version text not null unique,
  body text not null,                          -- markdown
  published_at timestamptz,
  is_current boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.privacy_notices enable row level security;

create unique index privacy_notices_one_current on public.privacy_notices ((true)) where is_current;

create table public.consent_records (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null constraint consent_records_subject_type_values
    check (subject_type in ('client_contact', 'portal_user', 'employee', 'lead')),
  subject_id uuid not null,
  notice_version text references public.privacy_notices (version) on update cascade on delete restrict,
  purposes text[] not null default '{}',
  given_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  channel text,
  ip text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.consent_records enable row level security;

create table public.data_requests (
  id uuid primary key default gen_random_uuid(),
  subject text not null,                       -- who the request is about / from
  type text not null constraint data_requests_type_values
    check (type in ('access', 'correction', 'erasure', 'grievance', 'nomination')),
  received_at timestamptz not null default now(),
  due_by date,
  status text not null default 'open',
  response text,
  handled_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.data_requests enable row level security;

create table public.data_incidents (
  id uuid primary key default gen_random_uuid(),
  detected_at timestamptz not null,
  description text not null,
  data_categories text[] not null default '{}',
  people_affected_estimate int check (people_affected_estimate >= 0),
  contained_at timestamptz,
  board_notified_at timestamptz,
  principals_notified_at timestamptz,
  root_cause text,
  actions jsonb not null default '[]'::jsonb,  -- breach-response checklist (§6.10)
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.data_incidents enable row level security;

-- ---------------------------------------------------------------------------------------------
-- Quality module (§6.8 SQC 1, §7.15.4, §12)
-- ---------------------------------------------------------------------------------------------
-- Independence declarations: annual, per staff member; yes/no questionnaire plus details.
create table public.independence_declarations (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete cascade,
  financial_year text not null constraint independence_declarations_financial_year_format check (public.is_fy_label(financial_year)),
  answers jsonb not null default '{}'::jsonb,
  details text,
  declared_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint independence_declarations_employee_fy_key unique (employee_id, financial_year)
);
alter table public.independence_declarations enable row level security;

-- Quality manual checklist (SQC 1 elements) with owner and last-reviewed date.
create table public.quality_manual_items (
  id uuid primary key default gen_random_uuid(),
  element text not null,                       -- leadership, ethics_independence, acceptance_continuance, human_resources, engagement_performance, monitoring
  title text not null,
  owner_employee_id uuid references public.employees (id) on delete set null,
  last_reviewed_on date,
  notes text,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.quality_manual_items enable row level security;

-- §12: "A restore drill every quarter, recorded in the quality module."
create table public.restore_drills (
  id uuid primary key default gen_random_uuid(),
  performed_on date not null,
  performed_by uuid,
  outcome text not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.restore_drills enable row level security;

update public.app_meta set value = '0014' where key = 'schema_version';
