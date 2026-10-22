-- 0004 · Clients and client-owned master data (§5.3, §6.6, §7.3).
-- FKs to tables created later (leads, quotations, documents) are added in those migrations.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------------------------
-- client_groups (§5.3, §7.4)
-- ---------------------------------------------------------------------------------------------
create table public.client_groups (
  id uuid primary key default gen_random_uuid(),
  name citext not null unique,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.client_groups enable row level security;

-- ---------------------------------------------------------------------------------------------
-- clients (§5.3)
-- ---------------------------------------------------------------------------------------------
create table public.clients (
  -- Identity
  id uuid primary key default gen_random_uuid(),
  client_code citext not null unique,          -- auto TW-C-0001 from number_series, editable
  display_name text not null,
  legal_name text,
  entity_type public.entity_type,
  entity_type_other text,
  is_incorporated boolean not null default true,
  date_of_birth_or_incorporation date,         -- drives the ITR age band for individuals

  -- Tax registrations
  pan citext unique
    constraint clients_pan_format check (pan::text ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  tan citext
    constraint clients_tan_format check (tan::text ~ '^[A-Z]{4}[0-9]{5}[A-Z]$'),
  gst_registration public.gst_registration not null default 'unknown',
  gstin citext unique
    constraint clients_gstin_format check (gstin::text ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  state_code char(2)                           -- place of supply; auto from GSTIN (trigger in 0017)
    constraint clients_state_code_format check (state_code ~ '^[0-9]{2}$'),

  -- Contact
  email citext,
  phone text,
  whatsapp text,
  address text,
  city text,
  pincode char(6) constraint clients_pincode_format check (pincode ~ '^[1-9][0-9]{5}$'),
  notes text,

  -- Work
  status public.client_status not null default 'pending',
  priority public.client_priority not null default 'medium',
  owner_employee_id uuid references public.employees (id) on delete set null,
  group_id uuid references public.client_groups (id) on delete set null,

  -- Financial year and scale
  fy_end_month smallint not null default 3 constraint clients_fy_end_month_range check (fy_end_month between 1 and 12),
  annual_turnover numeric(16,2) check (annual_turnover >= 0),
  turnover_fy text constraint clients_turnover_fy_format check (public.is_fy_label(turnover_fy)),
  gst_scheme public.gst_scheme,                -- null = derive from turnover (§6.6)
  tax_audit_applicable text                    -- §6.6: the partner's decision on the tax-audit indication
    constraint clients_tax_audit_applicable_values check (tax_audit_applicable in ('yes', 'no', 'review')),
  tax_audit_note text,                         -- §6.6: the partner's note on that decision

  -- Client-facing reminders (§7.3.2 step 5)
  reminder_days int constraint clients_reminder_days_range check (reminder_days between 1 and 60), -- null = firm default
  notify_channels text[] not null default '{}' -- empty = firm defaults
    constraint clients_notify_channels_values check (notify_channels <@ array['email', 'whatsapp', 'portal']::text[]),

  -- Portal
  portal_user_id uuid unique references auth.users (id) on delete set null,
  portal_invited_at timestamptz,
  portal_last_seen_at timestamptz,

  -- Origin
  source_lead_id uuid,                         -- FK added in 0005
  source_quotation_id uuid,                    -- FK added in 0005
  onboarded_at timestamptz,
  onboarded_by uuid,

  -- Housekeeping
  created_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,                             -- §7.19: who deleted it
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- §5.3 constraints
  constraint clients_gstin_required_when_registered check (gst_registration <> 'registered' or gstin is not null),
  constraint clients_gstin_matches_pan check (gstin is null or pan is null or upper(substr(gstin::text, 3, 10)) = upper(pan::text)),
  constraint clients_entity_type_other_named check (entity_type is distinct from 'other' or nullif(btrim(entity_type_other), '') is not null)
);
alter table public.clients enable row level security;

create trigger normalize_identifiers before insert or update on public.clients
  for each row execute function public.normalize_upper('client_code', 'pan', 'tan', 'gstin');

-- ---------------------------------------------------------------------------------------------
-- onboarding_drafts (§7.3.2: the five-step wizard "autosaves" and has "Save draft"; the client
-- itself is created in one transaction at Complete, so the draft lives here).
-- ---------------------------------------------------------------------------------------------
create table public.onboarding_drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  step smallint not null default 1 check (step between 1 and 5),
  data jsonb not null default '{}'::jsonb,
  source_lead_id uuid,                         -- FK added in 0005
  source_quotation_id uuid,                    -- FK added in 0005
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.onboarding_drafts enable row level security;

-- ---------------------------------------------------------------------------------------------
-- client_services: the engagement (client, service, fee, cycle) (§5.3)
-- ---------------------------------------------------------------------------------------------
create table public.client_services (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  service_type public.service_type not null,
  custom_name text,                            -- required when service_type = 'other'
  frequency public.service_frequency not null,
  is_active boolean not null default true,
  next_due_date date,
  agreed_fee numeric(12,2) check (agreed_fee >= 0), -- per billing occurrence, excl. GST; null = not agreed
  billing_frequency public.service_frequency,  -- null = same as frequency
  sac_code text constraint client_services_sac_format check (sac_code ~ '^[0-9]{4,8}$'),
  fee_agreed_at timestamptz,
  source_quotation_item_id uuid,               -- FK added in 0005
  auto_invoice boolean not null default false,
  next_billing_date date,
  last_auto_invoiced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_services_custom_name_for_other check (service_type <> 'other' or nullif(btrim(custom_name), '') is not null)
);
alter table public.client_services enable row level security;

create unique index client_services_client_service_name_key
  on public.client_services (client_id, service_type, coalesce(custom_name, ''));

-- ---------------------------------------------------------------------------------------------
-- client_service_fee_history (§7.3.3 tab 3 "fee history"; re-pricing records fee_agreed_at).
-- Written only by the trigger in 0017. Money table: Partner/Manager only.
-- ---------------------------------------------------------------------------------------------
create table public.client_service_fee_history (
  id uuid primary key default gen_random_uuid(),
  client_service_id uuid not null references public.client_services (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  agreed_fee numeric(12,2),
  billing_frequency public.service_frequency,
  changed_by uuid,
  changed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table public.client_service_fee_history enable row level security;

-- ---------------------------------------------------------------------------------------------
-- client_contacts (§5.3)
-- ---------------------------------------------------------------------------------------------
create table public.client_contacts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  name text not null,
  role text,                                   -- Director, CFO, Authorised Signatory, Accountant, Promoter, Other
  email citext,
  email_bounced boolean not null default false, -- §7.13.5: a Resend bounce flags the address as bad
  phone text,
  whatsapp text,
  is_primary boolean not null default false,
  handles public.service_type[] not null default '{}', -- which services this person answers for; empty = general
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.client_contacts enable row level security;

-- one primary contact per client (§5.3)
create unique index client_contacts_one_primary_per_client
  on public.client_contacts (client_id) where is_primary;

-- ---------------------------------------------------------------------------------------------
-- client_team_members (§5.3)
-- ---------------------------------------------------------------------------------------------
create table public.client_team_members (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  employee_id uuid not null references public.employees (id) on delete cascade,
  team_role public.team_role not null default 'preparer',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_team_members_client_employee_role_key unique (client_id, employee_id, team_role)
);
alter table public.client_team_members enable row level security;

-- ---------------------------------------------------------------------------------------------
-- client_document_checklist_items (§5.3, §7.3.2 step 4). document_id FK added in 0009.
-- ---------------------------------------------------------------------------------------------
create table public.client_document_checklist_items (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  label text not null,
  is_required boolean not null default true,
  collected boolean not null default false,
  collected_at timestamptz,
  collected_by uuid,
  document_id uuid,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.client_document_checklist_items enable row level security;

-- ---------------------------------------------------------------------------------------------
-- client_credentials: government portal logins (§5.3, §4.6, §12).
-- password_ciphertext is 'v<key version>:base64(iv).base64(tag).base64(ct)' (§5.3, §12); the format
-- check makes it impossible to store a plaintext password by mistake.
-- ---------------------------------------------------------------------------------------------
create table public.client_credentials (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  portal text not null constraint client_credentials_portal_values
    check (portal in ('GST', 'INCOME_TAX', 'TRACES', 'MCA', 'EPFO', 'ESIC', 'ICEGATE', 'PT', 'OTHER')),
  portal_label text,
  username text not null,
  password_ciphertext text not null
    constraint client_credentials_ciphertext_format check (password_ciphertext ~ '^v[0-9]+:[^.:]+\.[^.:]+\.[^.:]+$'),
  login_url text,
  notes text,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_credentials_client_portal_username_key unique (client_id, portal, username),
  constraint client_credentials_other_has_label check (portal <> 'OTHER' or nullif(btrim(portal_label), '') is not null)
);
alter table public.client_credentials enable row level security;

-- §4.6 / §14: nobody can read credential ciphertext through the API. API roles may select every
-- other column (rows still gated by RLS); reveal goes through server/admin.ts only.
revoke all on public.client_credentials from anon, authenticated;
grant select (id, client_id, portal, portal_label, username, login_url, notes, updated_by, created_at, updated_at),
      insert, update, delete
  on public.client_credentials to authenticated;

-- ---------------------------------------------------------------------------------------------
-- credential_access_logs (§5.3): append-only.
-- ---------------------------------------------------------------------------------------------
create table public.credential_access_logs (
  id uuid primary key default gen_random_uuid(),
  credential_id uuid not null references public.client_credentials (id) on delete cascade,
  user_id uuid not null,
  action text not null constraint credential_access_logs_action_values
    check (action in ('viewed', 'copied', 'created', 'updated', 'deleted')),
  ip text,
  created_at timestamptz not null default now()
);
alter table public.credential_access_logs enable row level security;

-- ---------------------------------------------------------------------------------------------
-- client_acceptances: conflict check before taking a client on (§5.3, §7.5.4, §6.8).
-- lead_id / client_id FKs added in 0005.
-- ---------------------------------------------------------------------------------------------
create table public.client_acceptances (
  id uuid primary key default gen_random_uuid(),
  prospect_name text not null,
  pan citext,
  gstin citext,
  related_parties text[] not null default '{}',
  conflicts_found jsonb,                       -- frozen at decision time
  independence_answers jsonb,                  -- §6.8: the acceptance form records the independence answers
  outcome public.acceptance_outcome not null default 'pending',
  rationale text,                              -- required when declining or accepting despite a conflict
  decided_by uuid,
  decided_at timestamptz,
  lead_id uuid,
  client_id uuid,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_acceptances_decline_has_rationale check (outcome <> 'declined' or nullif(btrim(rationale), '') is not null)
);
alter table public.client_acceptances enable row level security;

create trigger normalize_identifiers before insert or update on public.client_acceptances
  for each row execute function public.normalize_upper('pan', 'gstin');

update public.app_meta set value = '0004' where key = 'schema_version';
