-- 0201 · Column and ledger mappings remembered per client (§6.12 "Save the mapping per client for
-- next time", §6.13 "mappings are remembered per client", §7.8.1 step 3, §7.8.3 steps 3–4).
--
-- register_portal_mappings holds one row per client and kind:
--   purchase_register  {"version": 1, "columns": {field: header | null}, "sheet": …, "headerRow": …}
--   trial_balance      the same shape for the trial-balance columns
--   ledger_buckets     {ledger key: Schedule III bucket code}, merged one choice at a time
--
--   save_import_mapping(client, kind, mapping, merge)  insert or update the client's row. Without
--                      merge the mapping replaces the stored one as given (a column a person
--                      unmapped stays null, so the next suggestion respects it); with merge (ledger
--                      buckets) the new keys are laid over the stored ones and a key set to null is
--                      removed. Security invoker: RLS decides (staff who can see the client, §4.1
--                      "Workpapers … own clients").

set search_path = public, extensions;

create or replace function public.register_portal_mappings_stamp()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if public.is_api_caller() then
    if tg_op = 'UPDATE' and (new.client_id is distinct from old.client_id or new.kind is distinct from old.kind) then
      raise exception 'USER: A saved mapping belongs to one client and one kind of file.' using errcode = 'P0001';
    end if;
    new.updated_by := auth.uid();
  end if;
  return new;
end;
$$;

comment on function public.register_portal_mappings_stamp() is
  'Trigger: stamps who last changed a remembered mapping; a mapping never moves to another client or kind.';

drop trigger if exists register_portal_mappings_stamp on public.register_portal_mappings;
create trigger register_portal_mappings_stamp before insert or update on public.register_portal_mappings
  for each row execute function public.register_portal_mappings_stamp();

revoke execute on function public.register_portal_mappings_stamp() from public, anon, authenticated;

create or replace function public.save_import_mapping(p_client_id uuid, p_kind text, p_mapping jsonb, p_merge boolean default false)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_row public.register_portal_mappings%rowtype;
begin
  if not public.is_staff() then
    raise exception 'USER: Only the firm''s staff can save import mappings.' using errcode = 'P0001';
  end if;
  if p_kind is null or p_kind not in ('purchase_register', 'trial_balance', 'ledger_buckets') then
    raise exception 'USER: That isn''t a kind of mapping the app remembers.' using errcode = 'P0001';
  end if;
  if p_mapping is null or jsonb_typeof(p_mapping) <> 'object' then
    raise exception 'USER: The mapping is not in the expected form.' using errcode = 'P0001';
  end if;
  if pg_column_size(p_mapping) > 1048576 then
    raise exception 'USER: The mapping is too large to remember.' using errcode = 'P0001';
  end if;
  if p_client_id is null or not public.can_see_client(p_client_id)
     or not exists (select 1 from public.clients c where c.id = p_client_id and c.deleted_at is null) then
    raise exception 'USER: That client isn''t one of yours, or it is in the recycle bin.' using errcode = 'P0001';
  end if;

  insert into public.register_portal_mappings as m (client_id, kind, mapping)
  values (p_client_id, p_kind, case when coalesce(p_merge, false) then jsonb_strip_nulls(p_mapping) else p_mapping end)
  on conflict (client_id, kind) do update
    set mapping = case when coalesce(p_merge, false) then jsonb_strip_nulls(m.mapping || p_mapping) else excluded.mapping end
  returning * into v_row;

  return jsonb_build_object('id', v_row.id, 'kind', v_row.kind, 'updated_at', v_row.updated_at, 'keys', (select count(*) from jsonb_object_keys(v_row.mapping)));
end;
$$;

comment on function public.save_import_mapping(uuid, text, jsonb, boolean) is
  'Remembers a client''s purchase-register or trial-balance columns, or merges ledger → Schedule III bucket choices (§6.12, §6.13). Security invoker: RLS applies.';

revoke execute on function public.save_import_mapping(uuid, text, jsonb, boolean) from public, anon;
grant execute on function public.save_import_mapping(uuid, text, jsonb, boolean) to authenticated, service_role;
