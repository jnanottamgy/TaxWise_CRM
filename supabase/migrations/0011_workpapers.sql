-- 0011 · Workpapers: GST reconciliation, ITR computations, financial statements, notices and
-- litigation, saved import column mappings (§5.10, §6.11–§6.13, §7.8).

set search_path = public, extensions;

-- ---------------------------------------------------------------------------------------------
-- gst_recon_runs / gst_recon_entries (§5.10, §6.12, §7.8.1)
-- ---------------------------------------------------------------------------------------------
create table public.gst_recon_runs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  period char(6) not null constraint gst_recon_runs_period_format check (period ~ '^(0[1-9]|1[0-2])[0-9]{4}$'), -- MMYYYY
  portal_gstin citext,
  summary jsonb not null,                      -- counts, matched value, unclaimed ITC, ITC at risk, supplier roll-up
  diagnostics jsonb,
  source_files jsonb,                          -- storage paths of the uploaded 2B and register
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.gst_recon_runs enable row level security;

create trigger normalize_identifiers before insert or update on public.gst_recon_runs
  for each row execute function public.normalize_upper('portal_gstin');

create table public.gst_recon_entries (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.gst_recon_runs (id) on delete cascade,
  bucket text not null constraint gst_recon_entries_bucket_values
    check (bucket in ('matched', 'mismatch', 'missing_in_books', 'missing_in_2b')),
  match_tier text constraint gst_recon_entries_match_tier_values check (match_tier in ('exact', 'loose', 'fuzzy')),
  supplier_gstin citext not null,
  supplier_name text,
  data jsonb not null,                         -- both sides and deltas
  resolution text default 'open' constraint gst_recon_entries_resolution_values
    check (resolution in ('open', 'accepted', 'follow_up_supplier', 'ignore')),
  resolution_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.gst_recon_entries enable row level security;

create trigger normalize_identifiers before insert or update on public.gst_recon_entries
  for each row execute function public.normalize_upper('supplier_gstin');

-- ---------------------------------------------------------------------------------------------
-- itr_computations (§5.10, §6.11, §7.8.2): results are always recomputed on the server.
-- ---------------------------------------------------------------------------------------------
create table public.itr_computations (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  financial_year text not null constraint itr_computations_financial_year_format check (public.is_fy_label(financial_year)),
  inputs jsonb not null,
  results jsonb not null,
  regime_chosen text constraint itr_computations_regime_values check (regime_chosen in ('old', 'new')),
  status text not null default 'draft' constraint itr_computations_status_values check (status in ('draft', 'reviewed', 'final')),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.itr_computations enable row level security;

-- ---------------------------------------------------------------------------------------------
-- financial_statements (§5.10, §6.13, §7.8.3)
-- ---------------------------------------------------------------------------------------------
create table public.financial_statements (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  financial_year text not null constraint financial_statements_financial_year_format check (public.is_fy_label(financial_year)),
  ledgers jsonb not null,                      -- name, group, debit, credit, bucket, matched
  statements jsonb not null,                   -- P&L, balance sheet, checks; rebuilt on the server on save
  status text not null default 'draft' constraint financial_statements_status_values check (status in ('draft', 'reviewed', 'final')),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.financial_statements enable row level security;

-- ---------------------------------------------------------------------------------------------
-- tax_notices: notices and litigation register (§5.10, §7.8.4)
-- ---------------------------------------------------------------------------------------------
create table public.tax_notices (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  notice_type text not null,                   -- e.g. GST DRC-01, ASMT-10, IT 143(2), IT 148/148A, 142(1), TDS 200A/201
  section text,
  authority text,
  reference_no text,                           -- DIN
  notice_date date,
  received_date date,
  reply_due_date date,
  hearing_date timestamptz,
  status public.notice_status not null default 'open',
  demand_amount numeric(16,2) check (demand_amount >= 0),
  description text,
  notes text,                                  -- running log
  assigned_employee_id uuid references public.employees (id) on delete set null,
  -- §7.8.4 appeal tracking (when closed unfavourable)
  appeal_forum text,
  order_date date,
  limitation_date date,
  appeal_task_id uuid references public.tasks (id) on delete set null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.tax_notices enable row level security;

-- §7.8.4: "attach the notice, the reply and the order" (files live in the vault).
create table public.tax_notice_documents (
  id uuid primary key default gen_random_uuid(),
  notice_id uuid not null references public.tax_notices (id) on delete cascade,
  document_id uuid not null references public.documents (id) on delete cascade,
  kind text not null default 'other'
    constraint tax_notice_documents_kind_values check (kind in ('notice', 'reply', 'order', 'appeal', 'other')),
  created_at timestamptz not null default now(),
  constraint tax_notice_documents_notice_document_key unique (notice_id, document_id)
);
alter table public.tax_notice_documents enable row level security;

-- ---------------------------------------------------------------------------------------------
-- register_portal_mappings: saved column mappings per client (§6.12 purchase register,
-- §6.13 trial balance and ledger → bucket mappings), "remembered per client".
-- ---------------------------------------------------------------------------------------------
create table public.register_portal_mappings (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  kind text not null constraint register_portal_mappings_kind_values
    check (kind in ('purchase_register', 'trial_balance', 'ledger_buckets')),
  mapping jsonb not null,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint register_portal_mappings_client_kind_key unique (client_id, kind)
);
alter table public.register_portal_mappings enable row level security;

update public.app_meta set value = '0011' where key = 'schema_version';
