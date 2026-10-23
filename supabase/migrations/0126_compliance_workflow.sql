-- 0126 · Compliance workflow and filing capture (§7.7 workflow, §7.6.5 filing capture, §5.6, §4.1).
--
-- change_compliance_workflow(p_event_id, p_to, p_reason, p_expected_updated_at)
--   Not started → Documents awaited → In progress → Under review → Filed → Completed. Any move is
--   allowed (corrected figures happen), except:
--     - a no-op (refused, not silently written);
--     - a cancelled deadline (restore it first);
--     - Filed / Completed: Partners and Managers only (Employees submit Under review, §7.6.4);
--       a client's statutory deadline needs its filing record first (§7.7: "Filing an event
--       without a linked filing record prompts for the §7.6.5 details");
--     - reopening (Filed / Completed → anything earlier): Partners and Managers, with a reason.
--   Optimistic concurrency on updated_at (§13). Writes a history line (activity_logs).
--
-- record_compliance_filing(p_event_id, p_filing, p_expected_updated_at)
--   Partners and Managers (filing_records is theirs to write, 0037). Creates the filing record
--   (return / form, period, FY, filed on, acknowledgement / ARN / SRN, the acknowledgement document,
--   notes; or links an existing record, e.g. one imported from a previous CA), links a UDIN
--   optionally, and marks the deadline Filed (or Completed). One transaction under the caller's RLS.
--
-- Both are SECURITY INVOKER: RLS and the compliance_events_guard trigger (0125) still apply.

set search_path = public, extensions;

create or replace function public.compliance_workflow_label(p public.compliance_workflow)
returns text
language sql
immutable
set search_path = public, extensions
as $$
  select case p
    when 'not_started' then 'Not started'
    when 'documents_awaited' then 'Documents awaited'
    when 'in_progress' then 'In progress'
    when 'under_review' then 'Under review'
    when 'filed' then 'Filed'
    when 'completed' then 'Completed'
  end
$$;

comment on function public.compliance_workflow_label(public.compliance_workflow) is
  'The §3.6 label of a compliance workflow step.';

revoke all on function public.compliance_workflow_label(public.compliance_workflow) from public, anon;
grant execute on function public.compliance_workflow_label(public.compliance_workflow) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- change_compliance_workflow
-- ---------------------------------------------------------------------------------------------
create or replace function public.change_compliance_workflow(
  p_event_id uuid,
  p_to public.compliance_workflow,
  p_reason text default null,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_user_name text;
  v_manager boolean := public.is_manager_or_partner();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_old_done boolean;
  v_new_done boolean;
  e record;
  v_after record;
begin
  if not public.is_staff() then
    raise exception 'USER: Only staff can change a deadline''s progress.' using errcode = 'P0001';
  end if;
  if p_to is null then
    raise exception 'USER: Choose where the deadline moves to.' using errcode = 'P0001';
  end if;

  select ce.id, ce.client_id, ce.title, ce.workflow_status, ce.status, ce.is_statutory, ce.updated_at
    into e
    from public.compliance_events ce
   where ce.id = p_event_id
   for update;
  if not found then
    raise exception 'USER: That deadline no longer exists, or isn''t one of your clients''.' using errcode = 'P0001';
  end if;

  if p_expected_updated_at is not null and date_trunc('milliseconds', e.updated_at) <> date_trunc('milliseconds', p_expected_updated_at) then
    raise exception 'USER: This deadline was changed by someone else. Reload to see their changes.' using errcode = 'P0001';
  end if;
  if e.status = 'cancelled' then
    raise exception 'USER: This deadline is cancelled. Restore it before changing its progress.' using errcode = 'P0001';
  end if;
  if e.workflow_status = p_to then
    raise exception 'USER: It is already %.', public.compliance_workflow_label(p_to) using errcode = 'P0001';
  end if;

  v_old_done := e.workflow_status in ('filed', 'completed');
  v_new_done := p_to in ('filed', 'completed');

  if v_new_done and not v_manager then
    raise exception 'USER: Only a Partner or Manager can mark a deadline filed. Move it to Under review instead.' using errcode = 'P0001';
  end if;
  if v_new_done and not v_old_done and e.client_id is not null and e.is_statutory
     and not exists (select 1 from public.filing_records fr where fr.compliance_event_id = e.id) then
    raise exception 'USER: Record the filing details first: the return, period, filed-on date and acknowledgement number.' using errcode = 'P0001';
  end if;
  if v_old_done and not v_new_done then
    if not v_manager then
      raise exception 'USER: Only a Partner or Manager can reopen a filed deadline.' using errcode = 'P0001';
    end if;
    if v_reason is null then
      raise exception 'USER: Say why you are reopening it.' using errcode = 'P0001';
    end if;
  end if;

  update public.compliance_events set workflow_status = p_to where id = e.id
  returning id, workflow_status, status, completed_at, updated_at into v_after;

  select full_name into v_user_name from public.profiles where id = v_uid;
  insert into public.activity_logs (entity_type, entity_id, action, description, user_id, user_name, metadata)
  values (
    'compliance_event', e.id,
    case when v_old_done and not v_new_done then 'reopened' else 'workflow_changed' end,
    format('%s → %s%s', public.compliance_workflow_label(e.workflow_status), public.compliance_workflow_label(p_to),
           case when v_reason is not null then ': ' || left(v_reason, 500) else '.' end),
    v_uid, v_user_name,
    jsonb_build_object('from', e.workflow_status, 'to', p_to, 'reason', v_reason)
  );

  return jsonb_build_object(
    'id', v_after.id,
    'client_id', e.client_id,
    'from', e.workflow_status,
    'to', v_after.workflow_status,
    'status', v_after.status,
    'completed_at', v_after.completed_at,
    'updated_at', v_after.updated_at
  );
end;
$$;

comment on function public.change_compliance_workflow(uuid, public.compliance_workflow, text, timestamptz) is
  'Moves a deadline along its workflow (§7.7): no no-ops; Filed/Completed by Partners/Managers only and, for a client''s statutory deadline, only with a filing record; reopening needs a reason; optimistic concurrency; history line.';

revoke all on function public.change_compliance_workflow(uuid, public.compliance_workflow, text, timestamptz) from public, anon;
grant execute on function public.change_compliance_workflow(uuid, public.compliance_workflow, text, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- record_compliance_filing
-- p_filing: { filing_type*, period*, financial_year*, filed_on* (YYYY-MM-DD), acknowledgement_no,
--             service_type, document_id, udin_record_id, notes, shareable_with_client,
--             complete (bool: mark Completed instead of Filed), filing_record_id (link an existing
--             record instead of creating one) }
-- ---------------------------------------------------------------------------------------------
create or replace function public.record_compliance_filing(
  p_event_id uuid,
  p_filing jsonb,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_user_name text;
  e record;
  v_after record;
  v_record uuid := nullif(p_filing ->> 'filing_record_id', '')::uuid;
  v_type text := left(nullif(btrim(p_filing ->> 'filing_type'), ''), 60);
  v_period text := left(nullif(btrim(p_filing ->> 'period'), ''), 40);
  v_fy text := nullif(btrim(p_filing ->> 'financial_year'), '');
  v_filed_on date;
  v_ack text := left(nullif(btrim(p_filing ->> 'acknowledgement_no'), ''), 60);
  v_service public.service_type := nullif(p_filing ->> 'service_type', '')::public.service_type;
  v_document uuid := nullif(p_filing ->> 'document_id', '')::uuid;
  v_udin uuid := nullif(p_filing ->> 'udin_record_id', '')::uuid;
  v_notes text := left(nullif(btrim(p_filing ->> 'notes'), ''), 2000);
  v_share boolean := coalesce((p_filing ->> 'shareable_with_client')::boolean, false);
  v_to public.compliance_workflow := case when coalesce((p_filing ->> 'complete')::boolean, false) then 'completed' else 'filed' end;
  v_n int;
  v_existing record;
  v_on_time boolean;
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only a Partner or Manager can record a filing.' using errcode = 'P0001';
  end if;
  if p_filing is null or jsonb_typeof(p_filing) <> 'object' then
    raise exception 'USER: Enter the filing details.' using errcode = 'P0001';
  end if;

  select ce.id, ce.client_id, ce.title, ce.form_code, ce.filing_period, ce.financial_year, ce.due_date,
         ce.workflow_status, ce.status, ce.task_id, ce.updated_at
    into e
    from public.compliance_events ce
   where ce.id = p_event_id
   for update;
  if not found then
    raise exception 'USER: That deadline no longer exists.' using errcode = 'P0001';
  end if;
  if p_expected_updated_at is not null and date_trunc('milliseconds', e.updated_at) <> date_trunc('milliseconds', p_expected_updated_at) then
    raise exception 'USER: This deadline was changed by someone else. Reload to see their changes.' using errcode = 'P0001';
  end if;
  if e.client_id is null then
    raise exception 'USER: A firm-level deadline has no client to file for. Mark it filed and note the acknowledgement instead.' using errcode = 'P0001';
  end if;
  if e.status = 'cancelled' then
    raise exception 'USER: This deadline is cancelled. Restore it before recording a filing.' using errcode = 'P0001';
  end if;

  if v_record is not null then
    -- Link a filing record that already exists (imported history, or filed from the task).
    select fr.id, fr.client_id, fr.compliance_event_id, fr.filed_on
      into v_existing
      from public.filing_records fr
     where fr.id = v_record
     for update;
    if not found or v_existing.client_id <> e.client_id then
      raise exception 'USER: That filing record isn''t this client''s.' using errcode = 'P0001';
    end if;
    if v_existing.compliance_event_id is not null and v_existing.compliance_event_id <> e.id then
      raise exception 'USER: That filing record is already linked to another deadline.' using errcode = 'P0001';
    end if;
    update public.filing_records
       set compliance_event_id = e.id, task_id = coalesce(task_id, e.task_id)
     where id = v_record;
    v_filed_on := v_existing.filed_on;
  else
    if v_type is null then
      raise exception 'USER: Enter the return or form that was filed.' using errcode = 'P0001';
    end if;
    if v_period is null then
      raise exception 'USER: Enter the period the return is for.' using errcode = 'P0001';
    end if;
    if v_fy is null or not public.is_fy_label(v_fy) then
      raise exception 'USER: Enter the financial year as YYYY-YY, for example 2026-27.' using errcode = 'P0001';
    end if;
    begin
      v_filed_on := nullif(p_filing ->> 'filed_on', '')::date;
    exception when others then
      v_filed_on := null;
    end;
    if v_filed_on is null then
      raise exception 'USER: Enter the date it was filed.' using errcode = 'P0001';
    end if;
    if v_filed_on > public.today_ist() then
      raise exception 'USER: The filed-on date can''t be in the future.' using errcode = 'P0001';
    end if;
    if v_filed_on < date '2000-01-01' then
      raise exception 'USER: Check the filed-on date.' using errcode = 'P0001';
    end if;
    if v_document is not null and not exists (
      select 1 from public.documents d where d.id = v_document and d.client_id = e.client_id and d.deleted_at is null
    ) then
      raise exception 'USER: That acknowledgement isn''t in this client''s documents.' using errcode = 'P0001';
    end if;

    insert into public.filing_records (
      client_id, financial_year, filing_type, service_type, period, filed_on, acknowledgement_no,
      task_id, compliance_event_id, document_id, shareable_with_client, notes, created_by
    ) values (
      e.client_id, v_fy, v_type, v_service, v_period, v_filed_on, v_ack,
      e.task_id, e.id, v_document, v_share, v_notes, v_uid
    )
    returning id into v_record;
  end if;

  if v_udin is not null then
    update public.udin_records
       set filing_record_id = v_record
     where id = v_udin
       and (client_id = e.client_id or client_id is null)
       and (filing_record_id is null or filing_record_id = v_record);
    get diagnostics v_n = row_count;
    if v_n = 0 then
      raise exception 'USER: That UDIN is linked to another filing or belongs to another client.' using errcode = 'P0001';
    end if;
  end if;

  if e.workflow_status <> v_to and not (e.workflow_status = 'completed' and v_to = 'filed') then
    update public.compliance_events set workflow_status = v_to where id = e.id;
  end if;
  select ce.id, ce.workflow_status, ce.status, ce.completed_at, ce.updated_at into v_after
    from public.compliance_events ce where ce.id = e.id;

  v_on_time := v_filed_on is null or v_filed_on <= e.due_date;

  select full_name into v_user_name from public.profiles where id = v_uid;
  insert into public.activity_logs (entity_type, entity_id, action, description, user_id, user_name, metadata)
  values (
    'compliance_event', e.id, 'filed',
    format('Filed%s%s%s.',
           case when v_filed_on is not null then ' on ' || to_char(v_filed_on, 'DD Mon YYYY') else '' end,
           case when v_ack is not null then ' · acknowledgement ' || v_ack else '' end,
           case when v_filed_on is not null and v_filed_on > e.due_date
                then format(' · %s day%s late', v_filed_on - e.due_date, case when v_filed_on - e.due_date = 1 then '' else 's' end)
                else '' end),
    v_uid, v_user_name,
    jsonb_build_object('filing_record_id', v_record, 'filed_on', v_filed_on, 'acknowledgement_no', v_ack,
                       'on_time', v_on_time, 'udin_record_id', v_udin, 'to', v_after.workflow_status)
  );
  insert into public.activity_logs (entity_type, entity_id, action, description, user_id, user_name, metadata)
  values (
    'filing_record', v_record, 'linked_to_deadline',
    format('Recorded against %s.', e.title),
    v_uid, v_user_name,
    jsonb_build_object('compliance_event_id', e.id)
  );

  return jsonb_build_object(
    'filing_record_id', v_record,
    'event_id', e.id,
    'client_id', e.client_id,
    'workflow_status', v_after.workflow_status,
    'status', v_after.status,
    'updated_at', v_after.updated_at,
    'filed_on', v_filed_on,
    'on_time', v_on_time,
    'due_date', e.due_date
  );
end;
$$;

comment on function public.record_compliance_filing(uuid, jsonb, timestamptz) is
  'Partner/Manager: records (or links) the filing record of a client''s deadline with its acknowledgement, links a UDIN optionally, and marks the deadline Filed or Completed, in one transaction (§7.6.5, §7.7).';

revoke all on function public.record_compliance_filing(uuid, jsonb, timestamptz) from public, anon;
grant execute on function public.record_compliance_filing(uuid, jsonb, timestamptz) to authenticated;
