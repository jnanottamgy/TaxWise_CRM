-- 0006 · Work: job templates, tasks and their children, automations, time entries (§5.5, §7.6, §7.10).
-- tasks.compliance_event_id FK is added in 0007; time_entries.invoice_id FK in 0008;
-- task_attachments.document_id FK in 0009.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------------------------
-- job_templates / job_template_items (§5.5, §16)
-- ---------------------------------------------------------------------------------------------
create table public.job_templates (
  id uuid primary key default gen_random_uuid(),
  name citext not null unique,
  service_type public.service_type not null,
  description text,
  default_lead_days int check (default_lead_days >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.job_templates enable row level security;

create table public.job_template_items (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.job_templates (id) on delete cascade,
  title text not null,
  description text,
  offset_days int not null default 0,          -- days before the job's due date; negative = after
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.job_template_items enable row level security;

-- ---------------------------------------------------------------------------------------------
-- tasks (§5.5, §7.6). "Overdue" is derived in tasks_view (0016), never stored (§0.1 rule 10).
-- ---------------------------------------------------------------------------------------------
create table public.tasks (
  -- What
  id uuid primary key default gen_random_uuid(),
  task_number text not null unique,            -- auto T-000123
  client_id uuid not null references public.clients (id) on delete cascade,
  title text not null,
  description text,
  service_type public.service_type,
  financial_year text constraint tasks_financial_year_format check (public.is_fy_label(financial_year)),
  period_label text,                           -- e.g. 'Sep 2026', 'Q2 2026-27'

  -- Status
  status public.task_status not null default 'not_started',
  priority public.task_priority not null default 'medium',
  due_date date,
  completion_date timestamptz,                 -- set when filed_done, cleared on reopen
  on_hold_reason text,

  -- People
  assigned_employee_id uuid references public.employees (id) on delete set null,
  reviewer_employee_id uuid references public.employees (id) on delete set null,
  acceptance_status public.task_acceptance not null default 'pending',
  accepted_at timestamptz,
  declined_at timestamptz,
  decline_reason public.decline_reason,
  decline_note text,
  declined_by_employee_id uuid references public.employees (id) on delete set null,

  -- Escalation and links
  estimated_minutes int check (estimated_minutes >= 0),
  remarks text,
  escalation_level int not null default 0 check (escalation_level >= 0),
  escalated_at timestamptz,
  compliance_event_id uuid,                    -- FK added in 0007
  source_template_id uuid references public.job_templates (id) on delete set null,
  filing_skipped_reason text,                  -- §7.6.5: filing capture skipped, with a reason
  created_by uuid not null,
  deleted_at timestamptz,
  deleted_by uuid,                             -- §7.19
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- §7.6.2: "Reviewer (cannot be the assignee)" — nobody reviews their own work.
  constraint tasks_reviewer_not_assignee
    check (assigned_employee_id is null or reviewer_employee_id is null or assigned_employee_id <> reviewer_employee_id),
  -- §7.6.3: "Something else (note*)"
  constraint tasks_decline_other_has_note
    check (decline_reason is distinct from 'other' or nullif(btrim(decline_note), '') is not null)
);
alter table public.tasks enable row level security;

-- ---------------------------------------------------------------------------------------------
-- task_status_history (§5.5, §7.6.4)
-- ---------------------------------------------------------------------------------------------
create table public.task_status_history (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id) on delete cascade,
  from_status public.task_status,
  to_status public.task_status not null,
  reason text,
  changed_by uuid not null,
  changed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.task_status_history enable row level security;

-- ---------------------------------------------------------------------------------------------
-- task_comments (§5.5)
-- ---------------------------------------------------------------------------------------------
create table public.task_comments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id) on delete cascade,
  author_id uuid not null,
  body text not null,
  mentions uuid[] not null default '{}',
  edited_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.task_comments enable row level security;

-- ---------------------------------------------------------------------------------------------
-- task_attachments (§5.5): files go through the documents vault. Append-only.
-- ---------------------------------------------------------------------------------------------
create table public.task_attachments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id) on delete cascade,
  document_id uuid,                            -- FK added in 0009
  uploaded_by uuid,
  created_at timestamptz not null default now()
);
alter table public.task_attachments enable row level security;

-- ---------------------------------------------------------------------------------------------
-- task_checklist_items (§5.5)
-- ---------------------------------------------------------------------------------------------
create table public.task_checklist_items (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id) on delete cascade,
  title text not null,
  done boolean not null default false,
  done_by uuid,
  done_at timestamptz,
  due_offset_days int,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.task_checklist_items enable row level security;

-- ---------------------------------------------------------------------------------------------
-- task_dependencies (§5.5). Cycles and self-dependency are rejected by a trigger (0017).
-- ---------------------------------------------------------------------------------------------
create table public.task_dependencies (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id) on delete cascade,          -- the blocked task
  blocker_task_id uuid not null references public.tasks (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint task_dependencies_task_blocker_key unique (task_id, blocker_task_id),
  constraint task_dependencies_not_self check (task_id <> blocker_task_id)
);
alter table public.task_dependencies enable row level security;

-- ---------------------------------------------------------------------------------------------
-- task_automations: recurring tasks (§5.5, §7.6.7)
-- ---------------------------------------------------------------------------------------------
create table public.task_automations (
  id uuid primary key default gen_random_uuid(),
  template_task_id uuid,
  client_id uuid references public.clients (id) on delete cascade,
  type public.automation_type not null,
  frequency public.automation_frequency not null,
  config jsonb,
  is_active boolean not null default true,
  next_run_at timestamptz,
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.task_automations enable row level security;

-- ---------------------------------------------------------------------------------------------
-- time_entries (§5.5, §7.10). At most one running timer per employee (partial unique index).
-- ---------------------------------------------------------------------------------------------
create table public.time_entries (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete restrict, -- billed/logged time is a record
  client_id uuid references public.clients (id) on delete set null,
  task_id uuid references public.tasks (id) on delete set null,
  description text,
  started_at timestamptz not null,
  ended_at timestamptz,                        -- null while the timer runs
  minutes int not null default 0 check (minutes >= 0),
  billable boolean not null default true,
  invoice_id uuid,                             -- FK added in 0008
  invoiced_at timestamptz,
  locked boolean not null default false,       -- true once billed or week approved
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint time_entries_end_after_start check (ended_at is null or ended_at >= started_at)
);
alter table public.time_entries enable row level security;

create unique index time_entries_one_running_timer_per_employee
  on public.time_entries (employee_id) where ended_at is null;

update public.app_meta set value = '0006' where key = 'schema_version';
