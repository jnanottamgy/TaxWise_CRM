-- 0015 · WhatsApp groups, TaxWise Desktop and cover access (§5.13, §4.7, §7.25).

set search_path = public, extensions;

-- ---------------------------------------------------------------------------------------------
-- firm_whatsapp_numbers: the firm's own WhatsApp numbers (§5.13, §7.25.4, §16).
-- ---------------------------------------------------------------------------------------------
create table public.firm_whatsapp_numbers (
  id uuid primary key default gen_random_uuid(),
  label text not null unique,                  -- e.g. "CA Vinay H Karlagere (Partner)", "Managers' office"
  number text unique                           -- normalised digits (§7.13.2); null while a seeded slot is unfilled
    constraint firm_whatsapp_numbers_number_format check (number ~ '^[0-9]{8,15}$'),
  kind public.whatsapp_number_kind not null,
  employee_id uuid references public.employees (id) on delete set null,           -- the Partner whose number it is
  custodian_employee_id uuid references public.employees (id) on delete set null, -- who keeps the phone
  in_every_client_group boolean not null default true,
  group_admin boolean not null default false,
  shared boolean not null default false,
  usable_by public.app_role[] not null,        -- who may open this number's panel in TaxWise Desktop
  two_step_verification_on boolean not null default false,
  devices_reviewed_at timestamptz,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint firm_whatsapp_numbers_active_has_number check (not is_active or number is not null),
  -- §4.6: clients never get WhatsApp
  constraint firm_whatsapp_numbers_never_clients check (not ('client'::public.app_role = any (usable_by)))
);
alter table public.firm_whatsapp_numbers enable row level security;

-- ---------------------------------------------------------------------------------------------
-- client_whatsapp_groups (§5.13, §7.25.1–§7.25.2). invite_link: Partner/Manager only; Employees
-- read groups through client_whatsapp_groups_public (0016).
-- ---------------------------------------------------------------------------------------------
create table public.client_whatsapp_groups (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  name text not null,                          -- from the name format in Settings; must contain the client code
  purpose text,                                -- e.g. "All work", "Statutory audit FY 2025-26"
  is_primary boolean not null default true,
  status public.whatsapp_group_status not null default 'to_create',
  created_on date,
  created_by_number_id uuid references public.firm_whatsapp_numbers (id) on delete set null,
  invite_link text,
  checklist jsonb not null default '{}'::jsonb, -- each setup step → { done, by, at }
  last_opened_at timestamptz,
  last_opened_by uuid,
  closed_at timestamptz,
  closed_reason text,
  notes text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_whatsapp_groups_closed_has_date check (status <> 'closed' or closed_at is not null)
);
alter table public.client_whatsapp_groups enable row level security;

-- one primary group per client among groups not closed (§5.13)
create unique index client_whatsapp_groups_one_primary_per_client
  on public.client_whatsapp_groups (client_id)
  where is_primary and status <> 'closed' and deleted_at is null;

-- ---------------------------------------------------------------------------------------------
-- client_whatsapp_group_members (§5.13)
-- ---------------------------------------------------------------------------------------------
create table public.client_whatsapp_group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.client_whatsapp_groups (id) on delete cascade,
  kind public.whatsapp_member_kind not null,
  firm_number_id uuid references public.firm_whatsapp_numbers (id) on delete set null,
  contact_id uuid references public.client_contacts (id) on delete set null,
  display_name text not null,
  number text constraint client_whatsapp_group_members_number_format check (number ~ '^[0-9]{8,15}$'), -- normalised
  is_admin boolean not null default false,
  added_on date,
  removed_on date,
  source text not null default 'checklist'
    constraint client_whatsapp_group_members_source_values check (source in ('checklist', 'manual')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.client_whatsapp_group_members enable row level security;

create unique index client_whatsapp_group_members_current_number
  on public.client_whatsapp_group_members (group_id, number)
  where removed_on is null;

-- ---------------------------------------------------------------------------------------------
-- desktop_devices: PCs running TaxWise Desktop (§5.13, §7.25.7)
-- ---------------------------------------------------------------------------------------------
create table public.desktop_devices (
  id uuid primary key default gen_random_uuid(),
  device_key text not null unique,             -- random; generated at install, kept in the OS credential store
  device_name text not null,                   -- the PC name, editable by a Partner
  os text,
  app_version text,
  last_user_id uuid,
  last_seen_at timestamptz,
  revoked_at timestamptz,                      -- a revoked PC is refused and wipes its WhatsApp data at next start
  revoked_by uuid,
  -- §7.25.1 POST /api/desktop/health: Partners are told at most once a day per PC
  failing_checks text[],
  last_health_alert_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.desktop_devices enable row level security;

-- ---------------------------------------------------------------------------------------------
-- desktop_device_numbers: which firm number is linked on which PC (§5.13)
-- ---------------------------------------------------------------------------------------------
create table public.desktop_device_numbers (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.desktop_devices (id) on delete cascade,
  number_id uuid not null references public.firm_whatsapp_numbers (id) on delete cascade,
  linked_at timestamptz not null default now(),
  linked_by uuid not null,
  unlinked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint desktop_device_numbers_unlink_after_link check (unlinked_at is null or unlinked_at >= linked_at)
);
alter table public.desktop_device_numbers enable row level security;

create unique index desktop_device_numbers_current_link
  on public.desktop_device_numbers (device_id, number_id)
  where unlinked_at is null;

-- ---------------------------------------------------------------------------------------------
-- client_covers (§5.13, §4.7). Access ends by itself: RLS compares the window with now()
-- (covers_in_force, 0016). No DELETE: end a cover with revoked_at.
-- ---------------------------------------------------------------------------------------------
create table public.client_covers (
  id uuid primary key default gen_random_uuid(),
  kind public.cover_kind not null,
  client_id uuid references public.clients (id) on delete cascade,
  absent_employee_id uuid references public.employees (id) on delete cascade,
  cover_employee_id uuid not null references public.employees (id) on delete cascade,
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,
  reason public.cover_reason not null,
  note text,
  handover_note text,
  return_note text,
  include_vault boolean not null default false,
  leave_id uuid references public.employee_leave (id) on delete set null,
  granted_by uuid not null,
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text,
  expiry_logged_at timestamptz,                -- set by the hourly job when it records the automatic end
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_covers_window check (ends_at > starts_at and ends_at <= starts_at + interval '90 days'),
  constraint client_covers_not_self check (absent_employee_id is null or cover_employee_id <> absent_employee_id),
  constraint client_covers_client_kind check (kind <> 'client' or client_id is not null),
  constraint client_covers_person_kind check (kind <> 'person' or (absent_employee_id is not null and client_id is null))
);
alter table public.client_covers enable row level security;

update public.app_meta set value = '0015' where key = 'schema_version';
