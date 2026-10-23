-- 0113 · Client import from CSV, and client groups (§7.3.4 "Import / export", §7.4).
--
--   import_clients(rows jsonb)   Partner/Manager, security invoker. Inserts each row in its own
--                                savepoint, so one bad row never stops the others ("import valid rows
--                                only"); each row gets its services (no fees) and a timeline entry.
--                                Returns one result per row: { row, ok, client_id, client_code, error }.
--                                The server action has already validated every row (lib/schemas/clients.ts
--                                checkImportRows) and resolved owners and groups; this is the guard.
--   client_groups_overview       one row per group (§7.4): members, open and overdue tasks across
--                                members, the next deadline, and (Partner/Manager only; null for
--                                Employees) the outstanding amount. security_invoker.

set search_path = public, extensions;

-- =============================================================================================
-- import_clients
-- rows = [{ row, client_code?, display_name, legal_name, entity_type, entity_type_other, pan,
--           gst_registration, gstin, state_code, tan, email, phone, whatsapp, address, city, pincode,
--           owner_employee_id, group_id, priority, status, fy_end_month, annual_turnover, turnover_fy,
--           gst_scheme, notes, services: [{ service_type, frequency }] }]
-- =============================================================================================
create or replace function public.import_clients(p_rows jsonb, p_meta jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  r jsonb;
  s jsonb;
  v_out jsonb := '[]'::jsonb;
  v_id uuid;
  v_code text;
  v_attempt int;
  v_ok int := 0;
  v_failed int := 0;
  v_ids uuid[] := '{}';
  v_msg text;
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only Partners and Managers can import clients.' using errcode = 'P0001';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'USER: There are no rows to import.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_rows) > 1000 then
    raise exception 'USER: Import at most 1,000 clients at a time.' using errcode = 'P0001';
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    begin
      v_code := nullif(upper(btrim(r ->> 'client_code')), '');
      if v_code is null then
        v_attempt := 0;
        loop
          v_attempt := v_attempt + 1;
          v_code := public.next_document_number('client_code', public.today_ist());
          exit when not exists (select 1 from public.clients x where x.client_code = v_code);
          if v_attempt >= 50 then
            raise exception 'USER: Couldn''t find a free client code. Give this row a code.' using errcode = 'P0001';
          end if;
        end loop;
      elsif exists (select 1 from public.clients x where x.client_code = v_code) then
        raise exception 'USER: Client code % is already in use.', v_code using errcode = 'P0001';
      end if;

      if nullif(r ->> 'owner_employee_id', '') is not null and not exists (
        select 1 from public.employees e where e.id = (r ->> 'owner_employee_id')::uuid and e.is_active and e.deleted_at is null
      ) then
        raise exception 'USER: The owner isn''t an active member of the team.' using errcode = 'P0001';
      end if;

      insert into public.clients (
        client_code, display_name, legal_name, entity_type, entity_type_other, pan, gst_registration, gstin,
        state_code, tan, email, phone, whatsapp, address, city, pincode, owner_employee_id, group_id, priority,
        status, fy_end_month, annual_turnover, turnover_fy, gst_scheme, notes, created_by, onboarded_at, onboarded_by
      ) values (
        v_code, btrim(r ->> 'display_name'), nullif(btrim(r ->> 'legal_name'), ''),
        nullif(r ->> 'entity_type', '')::public.entity_type, nullif(btrim(r ->> 'entity_type_other'), ''),
        nullif(btrim(r ->> 'pan'), ''),
        coalesce(nullif(r ->> 'gst_registration', '')::public.gst_registration, 'unknown'),
        nullif(btrim(r ->> 'gstin'), ''), nullif(btrim(r ->> 'state_code'), ''), nullif(btrim(r ->> 'tan'), ''),
        nullif(btrim(r ->> 'email'), ''), nullif(btrim(r ->> 'phone'), ''), nullif(btrim(r ->> 'whatsapp'), ''),
        nullif(btrim(r ->> 'address'), ''), nullif(btrim(r ->> 'city'), ''), nullif(btrim(r ->> 'pincode'), ''),
        nullif(r ->> 'owner_employee_id', '')::uuid, nullif(r ->> 'group_id', '')::uuid,
        coalesce(nullif(r ->> 'priority', '')::public.client_priority, 'medium'),
        coalesce(nullif(r ->> 'status', '')::public.client_status, 'active'),
        coalesce(nullif(r ->> 'fy_end_month', '')::smallint, 3),
        nullif(r ->> 'annual_turnover', '')::numeric, nullif(r ->> 'turnover_fy', ''),
        nullif(r ->> 'gst_scheme', '')::public.gst_scheme, nullif(btrim(r ->> 'notes'), ''),
        v_uid,
        case when coalesce(nullif(r ->> 'status', ''), 'active') = 'active' then now() end,
        case when coalesce(nullif(r ->> 'status', ''), 'active') = 'active' then v_uid end
      )
      returning id into v_id;

      for s in select * from jsonb_array_elements(coalesce(r -> 'services', '[]'::jsonb)) loop
        insert into public.client_services (client_id, service_type, custom_name, frequency)
        values (v_id, (s ->> 'service_type')::public.service_type, nullif(btrim(s ->> 'custom_name'), ''), (s ->> 'frequency')::public.service_frequency)
        on conflict do nothing;
      end loop;

      insert into public.client_timeline_events (client_id, event_type, title, performed_by)
      values (v_id, 'client_imported', format('Client imported from CSV: %s (%s)', btrim(r ->> 'display_name'), v_code), v_uid);

      v_ok := v_ok + 1;
      v_ids := v_ids || v_id;
      v_out := v_out || jsonb_build_object('row', r -> 'row', 'ok', true, 'client_id', v_id, 'client_code', v_code);
    exception
      when others then
        v_failed := v_failed + 1;
        v_msg := case
          when sqlstate = '23505' and sqlerrm like '%pan%' then 'Another client already has this PAN.'
          when sqlstate = '23505' and sqlerrm like '%gstin%' then 'Another client already has this GSTIN.'
          when sqlstate = '23505' and sqlerrm like '%client_code%' then 'This client code is already in use.'
          when sqlstate = '23514' and sqlerrm like '%gstin_required%' then 'A registered client needs a GSTIN.'
          when sqlstate = '23514' and sqlerrm like '%gstin_matches_pan%' then 'The GSTIN doesn''t contain the PAN.'
          when sqlstate = '23514' then 'A value in this row isn''t valid.'
          when sqlstate = 'P0001' and sqlerrm like 'USER: %' then substr(sqlerrm, 7)
          when sqlstate = '22P02' then 'A value in this row isn''t one the app knows.'
          else 'This row couldn''t be saved.'
        end;
        v_out := v_out || jsonb_build_object('row', r -> 'row', 'ok', false, 'error', v_msg);
    end;
  end loop;

  if v_ok > 0 then
    perform public.log_audit_event(
      'data_create', 'client_import', null, 'clients.import',
      jsonb_build_object('imported', v_ok, 'failed', v_failed, 'client_ids', to_jsonb(v_ids), 'file_name', p_meta ->> 'file_name'),
      true, null, nullif(p_meta ->> 'ip', ''), nullif(p_meta ->> 'user_agent', '')
    );
  end if;

  return jsonb_build_object('imported', v_ok, 'failed', v_failed, 'results', v_out);
end;
$$;

comment on function public.import_clients(jsonb, jsonb) is
  'Partner/Manager: imports validated client rows, each in its own savepoint ("import valid rows only"), with their services and a timeline entry; one audit row for the import (§7.3.4).';

revoke execute on function public.import_clients(jsonb, jsonb) from public, anon;
grant execute on function public.import_clients(jsonb, jsonb) to authenticated, service_role;

-- =============================================================================================
-- client_groups_overview (§7.4)
-- =============================================================================================
create or replace view public.client_groups_overview with (security_invoker = true) as
select
  g.id,
  g.name::text as name,
  g.notes,
  g.created_at,
  g.updated_at,
  coalesce(m.members, 0)::int as members,
  coalesce(m.active_members, 0)::int as active_members,
  coalesce(t.open_tasks, 0)::int as open_tasks,
  coalesce(t.overdue_tasks, 0)::int as overdue_tasks,
  d.next_due_date,
  case when public.is_manager_or_partner() then coalesce(i.outstanding, 0) end as outstanding
from public.client_groups g
left join lateral (
  select count(*) as members, count(*) filter (where c.status = 'active') as active_members
  from public.clients c
  where c.group_id = g.id and c.deleted_at is null
) m on true
left join lateral (
  select
    count(*) filter (where tk.status <> 'filed_done') as open_tasks,
    count(*) filter (where tk.status <> 'filed_done' and tk.due_date < public.today_ist()) as overdue_tasks
  from public.tasks tk
  join public.clients c on c.id = tk.client_id and c.group_id = g.id and c.deleted_at is null
  where tk.deleted_at is null
) t on true
left join lateral (
  select min(e.due_date) as next_due_date
  from public.compliance_events e
  join public.clients c on c.id = e.client_id and c.group_id = g.id and c.deleted_at is null
  where e.status = 'pending' and e.due_date >= public.today_ist()
) d on true
left join lateral (
  select sum(inv.outstanding_amount) as outstanding
  from public.invoices inv
  join public.clients c on c.id = inv.client_id and c.group_id = g.id and c.deleted_at is null
  where inv.deleted_at is null and inv.cancelled_at is null and inv.status in ('sent', 'partially_paid', 'disputed')
) i on true;

comment on view public.client_groups_overview is
  'Client groups with members, open/overdue tasks, next deadline and (Partner/Manager only) outstanding across members (§7.4). security_invoker.';

revoke all on public.client_groups_overview from anon, public;
revoke insert, update, delete, truncate, references, trigger on public.client_groups_overview from authenticated;
grant select on public.client_groups_overview to authenticated, service_role;

create index if not exists client_groups_name_trgm on public.client_groups using gin ((name::text) extensions.gin_trgm_ops);
