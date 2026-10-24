-- 0239 · Schema version after the final hardening pass (§0.1 rule 1, §7.24). The highest migration
-- records the version that lib/env.ts EXPECTED_SCHEMA_VERSION must match; diagnostics compares the two.
-- Repeats the RLS guard for any table created by 0231–0238 (0234: GST reconciliation imports without
-- a supplier GSTIN), and keeps every view SELECT-only for the API roles (idempotent), including
-- gst_recon_entry_list as recreated by 0234.

set search_path = public, extensions;

do $$
declare
  r record;
begin
  for r in
    select c.oid::regclass as tbl
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
  loop
    execute format('alter table %s enable row level security', r.tbl);
  end loop;
end;
$$;

-- Views are read-only for the API roles (see 0043 §1): a security_invoker = false view written
-- through would bypass the base table's RLS. Repeated here for views (re)created after 0230.
do $$
declare
  r record;
begin
  for r in
    select c.oid::regclass as rel
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('v', 'm')
  loop
    execute format('revoke insert, update, delete, truncate, references, trigger on %s from public, anon, authenticated', r.rel);
    execute format('revoke all on %s from anon', r.rel);
  end loop;
end;
$$;

insert into public.app_meta (key, value) values ('schema_version', '0239')
on conflict (key) do update set value = excluded.value;
