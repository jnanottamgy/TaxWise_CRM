-- 0042 · Lock-down and coverage guard (§0.1 rule 8, §4.6, §12, §14).
--   * anon gets nothing on any table or view in public (policies are TO authenticated as well;
--     this removes the table privileges too). The public quotation page reads through the server;
--     public_firm_profile() stays callable by anon by design.
--   * tables created later by the same owner don't grant anon anything by default.
--   * RLS is enabled on every public table (idempotent; later migrations repeat it).
--   * a NOTICE lists any public table that has RLS but no policy and isn't locked by design.
--
-- Tables intentionally locked (RLS on, no policy at all, no API privileges):
--   client_credentials  read through client_credentials_list (no ciphertext); written through
--                       save_client_credential / delete_client_credential; revealed in server/admin.ts
--   rate_limits         only check_rate_limit() (service role)

set search_path = public, extensions;

do $$
declare
  r record;
begin
  for r in
    select c.oid::regclass as rel
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
  loop
    execute format('revoke all on %s from anon', r.rel);
  end loop;
end;
$$;

alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;

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

do $$
declare
  v_missing text;
begin
  select string_agg(c.relname, ', ' order by c.relname)
    into v_missing
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'p')
    and c.relname not in ('client_credentials', 'rate_limits')
    and not exists (select 1 from pg_policy p where p.polrelid = c.oid);
  if v_missing is not null then
    raise notice 'RLS: tables with no policy (deny-all until one is added): %', v_missing;
  end if;
end;
$$;

update public.app_meta set value = '0042' where key = 'schema_version';
