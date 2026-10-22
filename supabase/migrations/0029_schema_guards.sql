-- 0029 · Schema guards for everything created in 0001–0028 (§0.1 rules 1 and 8, §18.2).
--   * RLS enabled on every table in public (policies are defined in 0030+).
--   * set_updated_at() attached to every public table with an updated_at column.
--   * app_meta.schema_version recorded.
-- Both loops are idempotent; later migrations may repeat them for their own tables.

set search_path = public, extensions;

do $$
declare
  r record;
begin
  for r in
    select c.oid::regclass as tbl
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and not c.relrowsecurity
  loop
    execute format('alter table %s enable row level security', r.tbl);
  end loop;
end;
$$;

do $$
declare
  r record;
begin
  for r in
    select c.oid::regclass as tbl
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'updated_at' and not a.attisdropped
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and not exists (
        select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'set_updated_at' and not t.tgisinternal
      )
  loop
    execute format(
      'create trigger set_updated_at before insert or update on %s for each row execute function public.set_updated_at()',
      r.tbl
    );
  end loop;
end;
$$;

insert into public.app_meta (key, value) values ('schema_version', '0029')
on conflict (key) do update set value = excluded.value;
