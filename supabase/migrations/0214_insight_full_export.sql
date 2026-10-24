-- 0214 · The full data export (§7.21 Settings → Data: "full export (ZIP of CSVs for every table +
-- documents manifest)"; §12 every export audited).
--
--   full_export_catalog()   Partner only: every base table in the public schema the caller may
--       SELECT at least one column of, with exactly the columns they may read (column grants decide:
--       employees.cost_rate_per_hour stays out, as do tables with no grant at all such as
--       client_credentials, whose ciphertext nobody reads, §4.6), the primary key to page by, and
--       the read-only views that stand in for a table the caller may not read
--       (client_credentials_list: the vault without the ciphertext; employee_cost_rates: the cost
--       rates Partners keep). Bearer secrets that are credentials rather than records stay out
--       too: a quotation's public link token (it opens the accept page, §7.5.3) and a desktop PC's
--       device key (it checks the PC in, §7.25.7). Rows are then read through the caller's own
--       session, so RLS decides what each file holds. SECURITY INVOKER: current_user is the API
--       role, so the privileges checked are the caller's.

set search_path = public, extensions;

create or replace function public.full_export_catalog()
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  v_stand_ins text[] := array['client_credentials_list', 'employee_cost_rates'];
  v_secrets text[] := array['quotations.token', 'desktop_devices.device_key'];
begin
  if not public.is_partner() then
    raise exception 'USER: Only a Partner can export the firm''s data.' using errcode = 'P0001';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'name', r.relname,
      'kind', r.kind,
      'columns', r.columns,
      'key', r.key
    ) order by r.kind, r.relname)
    from (
      select
        c.relname::text as relname,
        case when c.relkind in ('r', 'p') then 'table' else 'view' end as kind,
        (
          select jsonb_agg(a.attname::text order by a.attnum)
          from pg_attribute a
          where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
            and has_column_privilege(current_user, c.oid, a.attnum, 'SELECT')
            and (c.relname::text || '.' || a.attname::text) <> all (v_secrets)
        ) as columns,
        coalesce((
          select jsonb_agg(a.attname::text order by k.ord)
          from pg_index i
          cross join lateral unnest(i.indkey) with ordinality as k(attnum, ord)
          join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
          where i.indrelid = c.oid and i.indisprimary
        ), case when exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'id' and not a.attisdropped)
                then '["id"]'::jsonb end) as key
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and (
          c.relkind in ('r', 'p')
          or (c.relkind = 'v' and c.relname = any (v_stand_ins))
        )
        and exists (
          select 1 from pg_attribute a
          where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
            and has_column_privilege(current_user, c.oid, a.attnum, 'SELECT')
        )
    ) r
  ), '[]'::jsonb);
end;
$$;

comment on function public.full_export_catalog() is
  'Partner only: the tables (and stand-in views) the caller may read, with their readable columns and key, for the full data export (§7.21).';

revoke execute on function public.full_export_catalog() from public, anon;
grant execute on function public.full_export_catalog() to authenticated, service_role;
