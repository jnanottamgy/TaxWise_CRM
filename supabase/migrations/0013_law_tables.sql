-- 0013 · Law-driven tables: statutory parameters are data, not code (§5.12, §6, §16).
-- Columns are the shared contract the seed files (supabase/seed/*.sql) insert into.
-- Settled-law rows are seeded verified = true; [verify] rows verified = false (§6 preamble).

set search_path = public, extensions;

-- ---------------------------------------------------------------------------------------------
-- statutory_parameters (§5.12): rates, thresholds, limits. Lookups always pass a date; the row in
-- force on that date wins.
-- ---------------------------------------------------------------------------------------------
create table public.statutory_parameters (
  id uuid primary key default gen_random_uuid(),
  key text not null,                           -- e.g. gst.default_rate_services, audit.tax_audit_ceiling
  value jsonb not null,
  effective_from date not null,
  effective_to date,
  statute text,                                -- e.g. 'Income-tax Act, 2025'
  section_ref text,
  source_ref text,                             -- notification/circular number and date
  notes text,
  verified boolean not null default false,
  verified_by uuid,
  verified_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint statutory_parameters_key_effective_from_key unique (key, effective_from),
  constraint statutory_parameters_effective_order check (effective_to is null or effective_to >= effective_from)
);
alter table public.statutory_parameters enable row level security;

-- ---------------------------------------------------------------------------------------------
-- due_date_rules (§5.12, §6.7)
-- ---------------------------------------------------------------------------------------------
create table public.due_date_rules (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,                   -- e.g. GSTR3B_MONTHLY, ITR_NON_AUDIT_3_4, TAX_AUDIT_REPORT, DIR3_KYC_WEB
  title text not null,
  compliance_type public.compliance_type not null,
  form_code text,
  applies_to jsonb not null default '{}'::jsonb, -- service type, entity types, scheme, audit status, turnover band, state
  frequency public.service_frequency not null,
  rule jsonb not null,                         -- e.g. {"monthOffset":1,"day":20}, {"afterEvent":"AGM","days":30}
  reminder_days int not null default 7 check (reminder_days >= 0),
  effective_from date not null,
  effective_to date,
  source_ref text,
  verified boolean not null default false,
  verified_by uuid,
  verified_on date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint due_date_rules_effective_order check (effective_to is null or effective_to >= effective_from)
);
alter table public.due_date_rules enable row level security;

-- ---------------------------------------------------------------------------------------------
-- due_date_overrides: government extensions (§5.12, §7.7). Saving one moves every matching
-- unfiled compliance event (done by the compliance module, recording the circular).
-- ---------------------------------------------------------------------------------------------
create table public.due_date_overrides (
  id uuid primary key default gen_random_uuid(),
  rule_code text not null references public.due_date_rules (code) on update cascade on delete restrict,
  period_label text not null,                  -- e.g. 'AY 2026-27', 'Sep 2026'
  original_due date not null,
  extended_due date not null,
  scope text,                                  -- who it covers
  source_ref text not null,                    -- e.g. 'CBDT Circular 07/2026 dated 28 Sep 2026'
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint due_date_overrides_rule_period_key unique (rule_code, period_label)
);
alter table public.due_date_overrides enable row level security;

alter table public.compliance_events
  add constraint compliance_events_override_id_fkey
    foreign key (override_id) references public.due_date_overrides (id) on delete set null;

-- ---------------------------------------------------------------------------------------------
-- section_concordance: Income-tax Act 1961 ↔ 2025 (§5.12, §6.1)
-- ---------------------------------------------------------------------------------------------
create table public.section_concordance (
  id uuid primary key default gen_random_uuid(),
  topic text not null,
  old_section text,
  new_section text,
  old_form text,
  new_form text,
  verified boolean not null default false,
  source_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.section_concordance enable row level security;

-- ---------------------------------------------------------------------------------------------
-- statutory_param_value(key, on): the value in force on a date (§5.12: "Lookups always pass a
-- date, and the row in force on that date wins"). Runs with the caller's rights (RLS applies).
-- ---------------------------------------------------------------------------------------------
create or replace function public.statutory_param_value(p_key text, p_on date)
returns jsonb
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select sp.value
  from public.statutory_parameters sp
  where sp.key = p_key
    and sp.effective_from <= p_on
    and (sp.effective_to is null or sp.effective_to >= p_on)
  order by sp.effective_from desc
  limit 1
$$;

comment on function public.statutory_param_value(text, date) is
  'The statutory_parameters value for a key in force on a date (§5.12); null when none.';

-- jsonb_to_numeric(v): reads a number out of a parameter value stored as 60, "60", or an object
-- such as {"value": 60} / {"limit": 60} / {"rate": 10} / {"amount": 50000}.
create or replace function public.jsonb_to_numeric(p jsonb)
returns numeric
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case jsonb_typeof(s.v)
    when 'number' then (s.v #>> '{}')::numeric
    when 'string' then case when (s.v #>> '{}') ~ '^-?[0-9]+(\.[0-9]+)?$' then (s.v #>> '{}')::numeric end
  end
  from (
    select case when jsonb_typeof(p) = 'object'
      then coalesce(p -> 'value', p -> 'limit', p -> 'rate', p -> 'amount', p -> 'max')
      else p
    end as v
  ) s
$$;

comment on function public.jsonb_to_numeric(jsonb) is
  'Numeric reading of a statutory parameter value (number, numeric string, or {value|limit|rate|amount|max}).';

update public.app_meta set value = '0013' where key = 'schema_version';
