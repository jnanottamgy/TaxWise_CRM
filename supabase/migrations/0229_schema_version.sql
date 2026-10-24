-- 0229 · Schema version for wave C (§0.1 rule 1, §7.24). The highest migration records the version
-- that lib/env.ts EXPECTED_SCHEMA_VERSION must match; diagnostics compares the two.
-- Repeats the RLS guard for every table created by 0191–0228 (registers and the vault, engagement
-- letters, filing history, audit engagements, quality and DPDP, the four workpapers, search, the
-- recycle bin, the audit log, reports, the full export, the home pages and the wave C integration),
-- and keeps every view SELECT-only for the API roles (idempotent).

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
-- through would bypass the base table's RLS. Repeated here for the views added in wave C
-- (client_credentials_register, credential_access_trail, udin_register, dsc_register,
-- statutory_registrations_register, engagement_letters_register, filing_history,
-- audit_engagements_list, kyc_register, gst_recon_runs_list, gst_recon_entry_list,
-- gst_recon_supplier_rollup, financial_statements_list, itr_computations_list, tax_notices_list,
-- tax_notice_notes_list, recycle_bin_items and any other).
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

insert into public.app_meta (key, value) values ('schema_version', '0229')
on conflict (key) do update set value = excluded.value;
