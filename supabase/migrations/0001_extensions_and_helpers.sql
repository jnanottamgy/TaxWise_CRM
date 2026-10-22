-- 0001 · Extensions, shared helper functions and app_meta.
--
-- Extensions live in schema `extensions` (CONVENTIONS §4). Supabase already has the schema; the
-- local harness shim creates it too. Every later migration sets the same search_path so citext
-- operators (case-insensitive comparison) and pg_trgm operator classes resolve.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists citext with schema extensions;
create extension if not exists pg_trgm with schema extensions;

set search_path = public, extensions;

-- ---------------------------------------------------------------------------------------------
-- set_updated_at(): keeps updated_at current on every UPDATE (§5 preamble).
-- Truncated to milliseconds so the value survives a round trip through a JavaScript Date, which
-- keeps optimistic-concurrency checks (`.eq('updated_at', loaded)`, §13) exact.
-- Attach it BEFORE INSERT OR UPDATE (or BEFORE UPDATE); 0029 attaches it to every public table
-- with an updated_at column that lacks it.
-- ---------------------------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'INSERT' then
    new.updated_at := date_trunc('milliseconds', coalesce(new.updated_at, now()));
  else
    new.updated_at := date_trunc('milliseconds', now());
  end if;
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'Trigger: maintains updated_at (ms precision) for optimistic concurrency (§5, §13).';

-- ---------------------------------------------------------------------------------------------
-- today_ist(): "today" in Asia/Kolkata (§0.1 rule 13). Used by every derived "overdue" (§0.1 rule 10).
-- ---------------------------------------------------------------------------------------------
create or replace function public.today_ist()
returns date
language sql
stable
set search_path = pg_catalog, public
as $$
  select (now() at time zone 'Asia/Kolkata')::date
$$;

comment on function public.today_ist() is 'The current date in Asia/Kolkata (§0.1 rule 13).';

-- ---------------------------------------------------------------------------------------------
-- Financial year helpers (§0.1 rule 13, §6.3): FY runs 1 April – 31 March, labelled '2026-27'.
-- ---------------------------------------------------------------------------------------------
create or replace function public.financial_year_label(p_date date)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select s.y::text || '-' || lpad(((s.y + 1) % 100)::text, 2, '0')
  from (
    select extract(year from p_date)::int - case when extract(month from p_date) < 4 then 1 else 0 end as y
  ) s
  where p_date is not null
$$;

comment on function public.financial_year_label(date) is
  'FY label for a date, e.g. 2026-10-22 -> ''2026-27'' (§6.3).';

create or replace function public.is_fy_label(p text)
returns boolean
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case
    when p is null then null
    when p ~ '^[0-9]{4}-[0-9]{2}$' then right(p, 2)::int = (left(p, 4)::int + 1) % 100
    else false
  end
$$;

comment on function public.is_fy_label(text) is
  'True for a well-formed FY label such as ''2026-27'' (the two years must be consecutive) (§0.1 rule 13).';

create or replace function public.fy_start_date(p_fy text)
returns date
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case when public.is_fy_label(p_fy) then make_date(left(p_fy, 4)::int, 4, 1) end
$$;

comment on function public.fy_start_date(text) is 'First day (1 April) of an FY label (§6.3).';

create or replace function public.fy_end_date(p_fy text)
returns date
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case when public.is_fy_label(p_fy) then make_date(left(p_fy, 4)::int + 1, 3, 31) end
$$;

comment on function public.fy_end_date(text) is 'Last day (31 March) of an FY label (§6.3).';

-- ---------------------------------------------------------------------------------------------
-- normalize_upper(col, ...): trigger that trims and upper-cases the named text/citext columns and
-- turns '' into null (§2.3, §6.2: PAN, GSTIN, TAN, UDIN and client codes are stored upper-case).
-- Usage: create trigger ... before insert or update on t for each row
--        execute function normalize_upper('pan', 'gstin');
-- ---------------------------------------------------------------------------------------------
create or replace function public.normalize_upper()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  col text;
  rec jsonb := to_jsonb(new);
  patch jsonb := '{}'::jsonb;
  v text;
begin
  foreach col in array tg_argv loop
    v := rec ->> col;
    if v is not null and v is distinct from nullif(upper(btrim(v)), '') then
      patch := patch || jsonb_build_object(col, nullif(upper(btrim(v)), ''));
    end if;
  end loop;
  if patch <> '{}'::jsonb then
    new := jsonb_populate_record(new, patch);
  end if;
  return new;
end;
$$;

comment on function public.normalize_upper() is
  'Trigger: trims + upper-cases the columns named in the trigger arguments; empty string becomes null (§6.2).';

-- ---------------------------------------------------------------------------------------------
-- app_meta (§5.11, §0.1 rule 1): holds schema_version, compared by diagnostics (§7.24) with
-- EXPECTED_SCHEMA_VERSION in lib/env.ts.
-- ---------------------------------------------------------------------------------------------
create table public.app_meta (
  key text primary key,
  value text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.app_meta enable row level security;

insert into public.app_meta (key, value) values ('schema_version', '0001')
on conflict (key) do update set value = excluded.value;
