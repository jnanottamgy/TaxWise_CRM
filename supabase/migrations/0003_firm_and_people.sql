-- 0003 · Firm settings and people (§5.2, §2.3, §4.5, §7.11, §7.12, §7.21).

set search_path = public, extensions;

-- ---------------------------------------------------------------------------------------------
-- firm_settings: the singleton row of firm-wide configuration (§2.3: id = 1, enforced by CHECK).
-- ---------------------------------------------------------------------------------------------
create table public.firm_settings (
  id smallint primary key default 1 constraint firm_settings_singleton check (id = 1),

  -- Identity
  firm_name text not null default 'TaxWise Consultants',
  legal_name text,
  tagline text,
  address text,
  city text,
  state_code char(2) not null default '29' constraint firm_settings_state_code_format check (state_code ~ '^[0-9]{2}$'),
  pincode char(6) constraint firm_settings_pincode_format check (pincode ~ '^[1-9][0-9]{5}$'),
  phone text,
  email text,
  website text,
  gstin citext constraint firm_settings_gstin_format check (gstin::text ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  pan citext constraint firm_settings_pan_format check (pan::text ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  tan citext constraint firm_settings_tan_format check (tan::text ~ '^[A-Z]{4}[0-9]{5}[A-Z]$'),
  icai_frn text,

  -- Bank and UPI
  bank_name text,
  bank_account_name text,
  bank_account_number text,
  bank_ifsc text,
  bank_branch text,
  upi_id text,
  upi_payee_name text,

  -- Branding
  logo_path text,
  logo_updated_at timestamptz,

  -- Numbering
  invoice_prefix text not null default 'TW',
  credit_note_prefix text not null default 'TW-CN',
  quotation_prefix text not null default 'TW-Q',
  receipt_prefix text not null default 'TW-R',
  client_code_prefix text not null default 'TW-C',

  -- Billing defaults
  default_sac text not null default '9982',
  sac_by_service jsonb,
  default_tax_rate numeric(5,2) not null default 18 check (default_tax_rate >= 0),
  payment_terms_days int not null default 15 check (payment_terms_days >= 0),
  invoice_approval_limit numeric(14,2) check (invoice_approval_limit >= 0),     -- null = no approvals needed
  quotation_approval_limit numeric(14,2) check (quotation_approval_limit >= 0), -- null = always approve; 0 = never
  e_invoicing_applies boolean not null default false,       -- §6.4, §7.21: shows irn/irn_ack_* fields on invoices
  last_gstr1_reported_month text,                           -- §7.9.3: last month TaxWise filed its own GSTR-1 (suggested 'YYYY-MM')
  round_off_enabled boolean not null default false,         -- §6.3, §7.21: optional ±₹0.99 round-off line

  -- Quotation defaults
  quotation_validity_days int not null default 30 check (quotation_validity_days > 0),
  quotation_terms text,
  invoice_terms text,
  invoice_footer_note text,
  quotation_follow_up_days int[] not null default '{3,7,14}', -- §7.5.3 follow-up schedule (editable)

  -- Working hours
  work_day_start time not null default '09:30',
  late_grace_minutes int not null default 15 check (late_grace_minutes >= 0),
  half_day_minutes int not null default 240 check (half_day_minutes >= 0),
  working_weekdays smallint[] not null default '{1,2,3,4,5,6}' -- 1 = Monday
    constraint firm_settings_working_weekdays_range check (working_weekdays <@ '{1,2,3,4,5,6,7}'::smallint[]),
  weekly_hours_target int not null default 48 check (weekly_hours_target >= 0),
  -- §5.2 offers "holidays date[] (or a separate holidays table)": the holidays table below is used.
  capacity_thresholds jsonb not null default '{"busy":1.5,"tight":2.5,"over":4}'::jsonb, -- §7.11.4 bands, editable (§7.21)

  -- Reminders
  compliance_reminder_days int not null default 7 check (compliance_reminder_days >= 0),
  invoice_reminder_before_days int not null default 3 check (invoice_reminder_before_days >= 0),
  invoice_reminder_after_days int[] not null default '{1,7,15}',
  document_request_reminder_every_days int not null default 3 check (document_request_reminder_every_days > 0),
  digest_enabled boolean not null default false,            -- §7.17, §7.21: Partner daily digest on/off

  -- Email
  email_from_name text not null default 'TaxWise Consultants',
  email_from_address text not null default 'noreply@twchartered.com',
  email_reply_to text not null default 'info@twchartered.com',
  sending_domain text not null default 'twchartered.com',
  resend_domain_id text,
  domain_status text constraint firm_settings_domain_status_values
    check (domain_status in ('not_started', 'pending', 'verified', 'failed')), -- mirrors Resend, never set locally
  domain_verified_at timestamptz,

  -- Other
  whatsapp_country_code text not null default '91' check (whatsapp_country_code ~ '^[0-9]{1,4}$'),
  updated_by uuid,

  -- WhatsApp and TaxWise Desktop (§7.25)
  whatsapp_group_name_format text not null default 'TW · {client_code} · {short_name}',
  whatsapp_signature text not null default '– {first_name}',
  whatsapp_client_mode boolean not null default true,
  whatsapp_employee_notifications boolean not null default false,
  whatsapp_employee_browser_window boolean not null default false,
  whatsapp_linked_device_limit smallint not null default 4 check (whatsapp_linked_device_limit > 0),
  whatsapp_house_rules text,
  desktop_download_url text,

  -- Practice (§6.8, §7.21)
  quality_framework text not null default 'sqc1'            -- §6.8: SQC 1 applies; switch to SQM 1 when it takes effect
    constraint firm_settings_quality_framework_values check (quality_framework in ('sqc1', 'sqm1')),
  law_last_reviewed_at timestamptz,                          -- §5.12: "last reviewed on" on the Law & rules page
  law_last_reviewed_by uuid,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.firm_settings enable row level security;

create trigger normalize_identifiers before insert or update on public.firm_settings
  for each row execute function public.normalize_upper('gstin', 'pan', 'tan');

-- ---------------------------------------------------------------------------------------------
-- profiles: one per auth user. profiles.role is the authority for server checks (§0.1 rule 9).
-- ---------------------------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null,
  email citext not null unique,
  phone text,
  role public.app_role not null,
  is_active boolean not null default true,
  must_change_password boolean not null default false,
  icai_membership_no text,                    -- Partners (UDIN, §6.2)
  avatar_path text,
  signature_path text,                        -- §7.1: Partner's optional signature image for PDFs
  last_login_at timestamptz,
  onboarding_completed boolean not null default false,
  onboarding_step int not null default 0,
  preferences jsonb not null default '{}'::jsonb, -- theme, density, favourites, notification channels per type (§7.17)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

-- ---------------------------------------------------------------------------------------------
-- employees: staff records (a person can exist before they have a login; Partners have one too).
-- ---------------------------------------------------------------------------------------------
create table public.employees (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid unique references public.profiles (id) on delete set null,
  full_name text not null,
  email citext not null unique,
  phone text,
  whatsapp text,
  department text,
  designation text,
  date_of_joining date,
  -- §4.5.8: bulk import records a role before any login exists; logins are issued later with it.
  -- Once a login exists profiles.role is the authority (§0.1 rule 9); never read this for permissions.
  staff_role public.app_role not null default 'employee'
    constraint employees_staff_role_is_staff check (staff_role in ('partner', 'manager', 'employee')),
  billing_rate_per_hour numeric(10,2) check (billing_rate_per_hour >= 0), -- null = not billed hourly; excl. GST
  cost_rate_per_hour numeric(10,2) check (cost_rate_per_hour >= 0),       -- Partner-only column
  vault_access boolean not null default false,
  is_active boolean not null default true,
  deleted_at timestamptz,
  deleted_by uuid,                            -- §7.19: who deleted it
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.employees enable row level security;

-- ---------------------------------------------------------------------------------------------
-- employee_leave (§5.2, §7.11.3)
-- ---------------------------------------------------------------------------------------------
create table public.employee_leave (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete cascade,
  start_date date not null,
  end_date date not null,
  type public.leave_type not null default 'annual',
  status public.leave_status not null default 'requested',
  half_day boolean not null default false,    -- §7.11.3: half-day option
  reason text,
  decided_by uuid,
  decided_at timestamptz,
  decision_note text,
  no_cover_needed boolean not null default false, -- §4.7, §7.11.3: approver recorded "No cover needed"
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employee_leave_end_after_start check (end_date >= start_date)
);
alter table public.employee_leave enable row level security;

-- ---------------------------------------------------------------------------------------------
-- employee_sessions (§5.2, §7.12). No updated_at (spec).
-- ---------------------------------------------------------------------------------------------
create table public.employee_sessions (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete cascade,
  user_id uuid not null,
  login_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  logout_at timestamptz,
  active_minutes int not null default 0 check (active_minutes >= 0),
  duration_minutes int check (duration_minutes >= 0),
  closed_reason text constraint employee_sessions_closed_reason_values
    check (closed_reason in ('logout', 'stale', 'day_end')),
  ip text,
  user_agent text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.employee_sessions enable row level security;

-- ---------------------------------------------------------------------------------------------
-- attendance_records (§5.2, §7.12)
-- ---------------------------------------------------------------------------------------------
create table public.attendance_records (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete cascade,
  date date not null,
  status public.attendance_status not null,
  first_login_at timestamptz,
  last_activity_at timestamptz,
  work_minutes int check (work_minutes >= 0),
  notes text,
  corrected_by uuid,
  correction_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attendance_records_employee_date_key unique (employee_id, date),
  constraint attendance_records_correction_has_reason check (corrected_by is null or correction_reason is not null)
);
alter table public.attendance_records enable row level security;

-- ---------------------------------------------------------------------------------------------
-- employee_activities (§5.2): append-only activity feed, timestamped by performed_at.
-- ---------------------------------------------------------------------------------------------
create table public.employee_activities (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete cascade,
  user_id uuid not null,
  activity_type text not null, -- login, logout, client_created, … settings_changed (§5.2)
  description text not null,
  entity_type text,
  entity_id uuid,
  entity_name text,
  metadata jsonb,
  performed_at timestamptz not null default now()
);
alter table public.employee_activities enable row level security;

-- ---------------------------------------------------------------------------------------------
-- holidays (§5.2 alternative to firm_settings.holidays, §7.11.3): firm holidays are non-working
-- days for capacity and attendance.
-- ---------------------------------------------------------------------------------------------
create table public.holidays (
  date date primary key,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.holidays enable row level security;

update public.app_meta set value = '0003' where key = 'schema_version';
