-- 0012 · Platform: notifications, activity and timeline logs, audit log, saved views, number series,
-- scheduled job runs, rate limits, recent searches (§5.11, §7.17, §7.18, §7.20, §8, §13).

set search_path = public, extensions;

-- ---------------------------------------------------------------------------------------------
-- notifications (§5.11, §9): each user sees their own only.
-- ---------------------------------------------------------------------------------------------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  type public.notification_type not null,
  title text not null,
  body text not null,
  link_url text not null,                      -- deep link to the exact record
  entity_type text,
  entity_id uuid,
  read_at timestamptz,
  archived_at timestamptz,
  emailed_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.notifications enable row level security;

-- ---------------------------------------------------------------------------------------------
-- activity_logs: entity history shown on detail pages (§5.11). Append-only, timestamped by `at`.
-- ---------------------------------------------------------------------------------------------
create table public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  action text not null,
  description text not null,
  user_id uuid,
  user_name text,
  metadata jsonb,
  at timestamptz not null default now()
);
alter table public.activity_logs enable row level security;

-- ---------------------------------------------------------------------------------------------
-- client_timeline_events: the client's story, from the first lead contact (§5.11, §7.3.3).
-- ---------------------------------------------------------------------------------------------
create table public.client_timeline_events (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients (id) on delete cascade,
  lead_id uuid references public.leads (id) on delete cascade,
  event_type text not null,
  title text not null,
  description text,
  metadata jsonb,
  performed_by uuid,
  created_at timestamptz not null default now(),
  constraint client_timeline_events_has_subject check (client_id is not null or lead_id is not null)
);
alter table public.client_timeline_events enable row level security;

-- ---------------------------------------------------------------------------------------------
-- audit_logs (§5.11, §0.1 rule 12, §7.20): insert-only. UPDATE/DELETE are refused by a trigger (0017).
-- ---------------------------------------------------------------------------------------------
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  event public.audit_event not null,
  user_id uuid,
  user_email text,
  user_role text,
  ip text,
  user_agent text,
  resource_type text,
  resource_id text,
  action text,
  details jsonb,
  success boolean not null default true,
  error text,
  at timestamptz not null default now()
);
alter table public.audit_logs enable row level security;

-- ---------------------------------------------------------------------------------------------
-- saved_views (§5.11, §7.6.1)
-- ---------------------------------------------------------------------------------------------
create table public.saved_views (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  page text not null,
  name text not null,
  filters jsonb not null default '{}'::jsonb,
  columns jsonb,
  sort jsonb,
  is_shared boolean not null default false,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint saved_views_user_page_name_key unique (user_id, page, name)
);
alter table public.saved_views enable row level security;

create unique index saved_views_one_default_per_user_page on public.saved_views (user_id, page) where is_default;

-- ---------------------------------------------------------------------------------------------
-- number_series (§5.11, §0.1 rule 6): locked counters for document numbers. The function
-- next_document_number(p_key, p_date) (FOR UPDATE, FY reset, ≤16 chars) is defined with the
-- numbering module.
-- ---------------------------------------------------------------------------------------------
create table public.number_series (
  key text primary key,                        -- invoice, credit_note, quotation, receipt, client_code, task, lead
  financial_year text constraint number_series_financial_year_format check (public.is_fy_label(financial_year)),
  next_value int not null default 1 check (next_value >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.number_series enable row level security;

-- ---------------------------------------------------------------------------------------------
-- job_runs (§8): every scheduled job writes one row; diagnostics shows the last run of each (§7.24).
-- ---------------------------------------------------------------------------------------------
create table public.job_runs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running',      -- e.g. running, succeeded, failed, partial
  counts jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint job_runs_finish_after_start check (finished_at is null or finished_at >= started_at)
);
alter table public.job_runs enable row level security;

-- ---------------------------------------------------------------------------------------------
-- rate_limits (§13): fixed-window counters (login, password reset, quotation responses, portal
-- uploads, server actions). The key encodes the limit and its subject, e.g. 'login:<email>:<ip>'.
-- ---------------------------------------------------------------------------------------------
create table public.rate_limits (
  key text not null,
  window_start timestamptz not null,
  count int not null default 0 check (count >= 0),
  primary key (key, window_start)
);
alter table public.rate_limits enable row level security;

-- ---------------------------------------------------------------------------------------------
-- recent_searches (§7.18): recent searches, per user.
-- ---------------------------------------------------------------------------------------------
create table public.recent_searches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  query text not null check (btrim(query) <> ''),
  searched_at timestamptz not null default now()
);
alter table public.recent_searches enable row level security;

update public.app_meta set value = '0012' where key = 'schema_version';
