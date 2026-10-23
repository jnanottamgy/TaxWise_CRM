-- 0131 · Task write functions (§7.6.2, §7.6.5, §7.6.7). All SECURITY INVOKER: the caller's RLS and
-- the task triggers (tasks_guard, tasks_track_assignment, task_dependencies_guard) still apply.
-- Refusals are 'USER: <sentence>' (errcode P0001).
--
--   create_task(p jsonb)                         Partner/Manager (or the recurring-task job): the task,
--                                                its checklist (typed items and/or a job template's
--                                                items, with their offsets), its blockers and the
--                                                link to a compliance deadline, in one transaction.
--   apply_job_template(task, template)           Partner/Manager: adds the template's steps to the
--                                                checklist (steps already there by title are skipped).
--   bulk_update_tasks(ids, changes, reason)      Partner/Manager: assign, change reviewer, change due
--                                                date (reason required), change priority (§7.6.7).
--                                                Rows that can't take the change are skipped and
--                                                reported, never half-written.
--   file_task(task, filing, skip_reason, at)     Partner/Manager: Filed/Done with the filing capture
--                                                (§7.6.5): the filing record (or a skip reason), the
--                                                linked deadline marked Filed, and the status change
--                                                through change_task_status, all or nothing.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------------------------
-- Small shared checks
-- ---------------------------------------------------------------------------------------------

-- An employee who can be given work: active record, not deleted, and (if they have a login) an
-- active profile. §7.6.2: assigning to a disabled account would lose the work.
create or replace function public.employee_can_take_work(p_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
    from public.employees e
    left join public.profiles p on p.id = e.profile_id
    where e.id = p_employee_id
      and e.is_active
      and e.deleted_at is null
      and coalesce(p.is_active, true)
  )
$$;

comment on function public.employee_can_take_work(uuid) is
  'True for an active, undeleted team member with an active login (or none yet): someone work can be assigned to (§7.6.2).';

-- ---------------------------------------------------------------------------------------------
-- create_task
-- p: { client_id*, title*, description, service_type, financial_year, period_label, due_date,
--      priority, estimated_minutes, assigned_employee_id, reviewer_employee_id, remarks,
--      compliance_event_id, template_id, checklist: [{ title, due_offset_days }], blocker_ids: [uuid],
--      -- the recurring-task job only (service role): created_by, automation_id }
-- Returns { id, task_number, existed } (existed: the automation already made this period's task).
-- ---------------------------------------------------------------------------------------------
create or replace function public.create_task(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_api boolean := public.is_api_caller();
  v_uid uuid := auth.uid();
  v_created_by uuid;
  v_client uuid := public.try_uuid(p ->> 'client_id');
  v_title text := left(nullif(btrim(p ->> 'title'), ''), 300);
  v_description text := left(nullif(btrim(p ->> 'description'), ''), 5000);
  v_remarks text := left(nullif(btrim(p ->> 'remarks'), ''), 2000);
  v_service public.service_type;
  v_priority public.task_priority;
  v_fy text := nullif(btrim(p ->> 'financial_year'), '');
  v_period text := left(nullif(btrim(p ->> 'period_label'), ''), 40);
  v_due date;
  v_estimate int;
  v_assignee uuid := public.try_uuid(p ->> 'assigned_employee_id');
  v_reviewer uuid := public.try_uuid(p ->> 'reviewer_employee_id');
  v_event uuid := public.try_uuid(p ->> 'compliance_event_id');
  v_event_client uuid;
  v_template uuid := public.try_uuid(p ->> 'template_id');
  v_automation uuid := public.try_uuid(p ->> 'automation_id');
  v_task public.tasks%rowtype;
  v_item jsonb;
  v_sort int := 0;
  v_items int := 0;
  v_blocker uuid;
  v_offset int;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'USER: Enter the task''s details.' using errcode = 'P0001';
  end if;

  if v_api then
    if not public.is_manager_or_partner() then
      raise exception 'USER: Only a Partner or Manager can create tasks.' using errcode = 'P0001';
    end if;
    if v_automation is not null then
      raise exception 'USER: Recurring tasks are created by their schedule.' using errcode = 'P0001';
    end if;
    v_created_by := v_uid;
  else
    v_created_by := coalesce(public.try_uuid(p ->> 'created_by'), v_uid);
    if v_created_by is null then
      raise exception 'create_task: created_by is required outside a signed-in session';
    end if;
  end if;

  if v_client is null then
    raise exception 'USER: Choose the client.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.clients c where c.id = v_client and c.deleted_at is null) then
    raise exception 'USER: That client doesn''t exist, or is in the recycle bin.' using errcode = 'P0001';
  end if;
  if v_title is null then
    raise exception 'USER: Give the task a title.' using errcode = 'P0001';
  end if;

  begin
    v_service := nullif(p ->> 'service_type', '')::public.service_type;
    v_priority := coalesce(nullif(p ->> 'priority', '')::public.task_priority, 'medium');
    v_due := nullif(p ->> 'due_date', '')::date;
    v_estimate := nullif(p ->> 'estimated_minutes', '')::int;
  exception when others then
    raise exception 'USER: Check the service, priority, due date and estimated time.' using errcode = 'P0001';
  end;
  if v_fy is not null and not public.is_fy_label(v_fy) then
    raise exception 'USER: Enter the financial year as YYYY-YY, for example 2026-27.' using errcode = 'P0001';
  end if;
  if v_estimate is not null and (v_estimate < 0 or v_estimate > 100000) then
    raise exception 'USER: Enter the estimated time in hours and minutes.' using errcode = 'P0001';
  end if;

  if v_assignee is not null and not public.employee_can_take_work(v_assignee) then
    raise exception 'USER: That person''s account is disabled, so the work would be lost. Choose someone active.' using errcode = 'P0001';
  end if;
  if v_reviewer is not null and not public.employee_can_take_work(v_reviewer) then
    raise exception 'USER: The reviewer''s account is disabled. Choose someone active to review it.' using errcode = 'P0001';
  end if;
  if v_assignee is not null and v_assignee = v_reviewer then
    raise exception 'USER: The reviewer can''t also be the assignee: nobody reviews their own work.' using errcode = 'P0001';
  end if;

  if v_event is not null then
    select e.client_id into v_event_client from public.compliance_events e where e.id = v_event;
    if not found then
      raise exception 'USER: That deadline no longer exists.' using errcode = 'P0001';
    end if;
    if v_event_client is distinct from v_client then
      raise exception 'USER: That deadline belongs to another client.' using errcode = 'P0001';
    end if;
  end if;
  if v_template is not null and not exists (select 1 from public.job_templates jt where jt.id = v_template and jt.is_active) then
    raise exception 'USER: That job template isn''t available. Choose an active template.' using errcode = 'P0001';
  end if;

  if v_automation is not null then
    insert into public.tasks (
      client_id, title, description, service_type, financial_year, period_label, priority, due_date,
      estimated_minutes, assigned_employee_id, reviewer_employee_id, remarks, compliance_event_id,
      source_template_id, automation_id, created_by
    ) values (
      v_client, v_title, v_description, v_service, v_fy, v_period, v_priority, v_due,
      v_estimate, v_assignee, v_reviewer, v_remarks, v_event,
      v_template, v_automation, v_created_by
    )
    on conflict (automation_id, period_label) where automation_id is not null and deleted_at is null do nothing
    returning * into v_task;
    if not found then
      return jsonb_build_object('id', null, 'task_number', null, 'existed', true);
    end if;
  else
    insert into public.tasks (
      client_id, title, description, service_type, financial_year, period_label, priority, due_date,
      estimated_minutes, assigned_employee_id, reviewer_employee_id, remarks, compliance_event_id,
      source_template_id, created_by
    ) values (
      v_client, v_title, v_description, v_service, v_fy, v_period, v_priority, v_due,
      v_estimate, v_assignee, v_reviewer, v_remarks, v_event,
      v_template, v_created_by
    )
    returning * into v_task;
  end if;

  -- The deadline points back at its task (§5.6 compliance_events.task_id), unless it already has one.
  if v_event is not null then
    update public.compliance_events set task_id = v_task.id where id = v_event and task_id is null;
  end if;

  -- Checklist: the template's steps first (their offsets give each step a date before the task's
  -- due date, §7.6.2), then the typed items.
  if v_template is not null then
    insert into public.task_checklist_items (task_id, title, due_offset_days, sort_order)
    select v_task.id, i.title, i.offset_days, (row_number() over (order by i.sort_order, i.created_at, i.id) - 1)::int
    from public.job_template_items i
    where i.template_id = v_template;
    get diagnostics v_items = row_count;
    v_sort := v_items;
  end if;

  for v_item in select value from jsonb_array_elements(case when jsonb_typeof(p -> 'checklist') = 'array' then p -> 'checklist' else '[]'::jsonb end)
  loop
    continue when nullif(btrim(v_item ->> 'title'), '') is null;
    begin
      v_offset := nullif(v_item ->> 'due_offset_days', '')::int;
    exception when others then
      v_offset := null;
    end;
    insert into public.task_checklist_items (task_id, title, due_offset_days, sort_order)
    values (v_task.id, left(btrim(v_item ->> 'title'), 300), v_offset, v_sort);
    v_sort := v_sort + 1;
    v_items := v_items + 1;
  end loop;

  -- Blocked by (cycles and self-dependency are refused by task_dependencies_guard, 0017).
  for v_blocker in
    select distinct public.try_uuid(x)
    from jsonb_array_elements_text(case when jsonb_typeof(p -> 'blocker_ids') = 'array' then p -> 'blocker_ids' else '[]'::jsonb end) x
  loop
    continue when v_blocker is null;
    if not exists (select 1 from public.tasks b where b.id = v_blocker and b.deleted_at is null) then
      raise exception 'USER: One of the blocking tasks no longer exists.' using errcode = 'P0001';
    end if;
    insert into public.task_dependencies (task_id, blocker_task_id) values (v_task.id, v_blocker)
    on conflict (task_id, blocker_task_id) do nothing;
  end loop;

  return jsonb_build_object(
    'id', v_task.id,
    'task_number', v_task.task_number,
    'existed', false,
    'client_id', v_task.client_id,
    'title', v_task.title,
    'due_date', v_task.due_date,
    'assigned_employee_id', v_task.assigned_employee_id,
    'reviewer_employee_id', v_task.reviewer_employee_id,
    'checklist_items', v_items
  );
end;
$$;

comment on function public.create_task(jsonb) is
  'Partner/Manager (or the recurring-task job): creates a task with its checklist (typed items and a job template''s steps), blockers and deadline link in one transaction (§7.6.2, §7.6.7).';

-- ---------------------------------------------------------------------------------------------
-- apply_job_template
-- ---------------------------------------------------------------------------------------------
create or replace function public.apply_job_template(p_task_id uuid, p_template_id uuid)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  t record;
  tpl record;
  v_sort int;
  v_added int;
  v_total int;
  v_uid uuid := auth.uid();
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only a Partner or Manager can apply a job template.' using errcode = 'P0001';
  end if;
  select id, title, status into t from public.tasks where id = p_task_id and deleted_at is null for update;
  if not found then
    raise exception 'USER: That task doesn''t exist, or it''s in the recycle bin.' using errcode = 'P0001';
  end if;
  select id, name, is_active into tpl from public.job_templates where id = p_template_id;
  if not found or not tpl.is_active then
    raise exception 'USER: That job template isn''t available. Choose an active template.' using errcode = 'P0001';
  end if;

  select count(*) into v_total from public.job_template_items where template_id = tpl.id;
  if v_total = 0 then
    raise exception 'USER: That job template has no steps yet.' using errcode = 'P0001';
  end if;

  select coalesce(max(sort_order) + 1, 0) into v_sort from public.task_checklist_items where task_id = t.id;

  insert into public.task_checklist_items (task_id, title, due_offset_days, sort_order)
  select t.id, i.title, i.offset_days, v_sort + (row_number() over (order by i.sort_order, i.created_at, i.id) - 1)::int
  from public.job_template_items i
  where i.template_id = tpl.id
    and not exists (
      select 1 from public.task_checklist_items x
      where x.task_id = t.id and lower(btrim(x.title)) = lower(btrim(i.title))
    );
  get diagnostics v_added = row_count;

  update public.tasks set source_template_id = tpl.id where id = t.id and source_template_id is null;

  insert into public.activity_logs (entity_type, entity_id, action, description, user_id, user_name, metadata)
  values (
    'task', t.id, 'template_applied',
    format('Applied the job template “%s”: %s %s added%s.', tpl.name, v_added, case when v_added = 1 then 'step' else 'steps' end,
           case when v_total - v_added > 0 then format(', %s already on the checklist', v_total - v_added) else '' end),
    v_uid, (select full_name from public.profiles where id = v_uid),
    jsonb_build_object('template_id', tpl.id, 'added', v_added, 'skipped', v_total - v_added)
  );

  return jsonb_build_object('added', v_added, 'skipped', v_total - v_added, 'template_name', tpl.name);
end;
$$;

comment on function public.apply_job_template(uuid, uuid) is
  'Partner/Manager: adds a job template''s steps (with their due offsets) to a task''s checklist, skipping steps already there by title (§7.6.2).';

-- ---------------------------------------------------------------------------------------------
-- bulk_update_tasks
-- p_changes: any of { assigned_employee_id (uuid | null), reviewer_employee_id (uuid | null),
--                     due_date (YYYY-MM-DD | null), priority }. A due-date change needs p_reason.
-- Returns { updated: [ { id, task_number, title, client_id, assignee_changed, old_assignee,
--           new_assignee, reviewer_changed, new_reviewer, due_changed, old_due, new_due,
--           priority_changed } ], skipped: [ { id, task_number, reason } ] }.
-- ---------------------------------------------------------------------------------------------
create or replace function public.bulk_update_tasks(p_task_ids uuid[], p_changes jsonb, p_reason text default null)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_user_name text;
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 500);
  v_has_assignee boolean := coalesce(p_changes ? 'assigned_employee_id', false);
  v_has_reviewer boolean := coalesce(p_changes ? 'reviewer_employee_id', false);
  v_has_due boolean := coalesce(p_changes ? 'due_date', false);
  v_has_priority boolean := coalesce(p_changes ? 'priority', false);
  v_assignee uuid := public.try_uuid(p_changes ->> 'assigned_employee_id');
  v_reviewer uuid := public.try_uuid(p_changes ->> 'reviewer_employee_id');
  v_due date;
  v_priority public.task_priority;
  v_assignee_name text;
  v_reviewer_name text;
  t record;
  v_new_assignee uuid;
  v_new_reviewer uuid;
  v_new_due date;
  v_new_priority public.task_priority;
  v_parts text[];
  v_updated jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_found uuid[] := '{}';
  v_missing int;
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only a Partner or Manager can change tasks in bulk.' using errcode = 'P0001';
  end if;
  if p_task_ids is null or cardinality(p_task_ids) = 0 then
    raise exception 'USER: Select at least one task.' using errcode = 'P0001';
  end if;
  if cardinality(p_task_ids) > 500 then
    raise exception 'USER: Change at most 500 tasks at a time.' using errcode = 'P0001';
  end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or not (v_has_assignee or v_has_reviewer or v_has_due or v_has_priority) then
    raise exception 'USER: Choose what to change.' using errcode = 'P0001';
  end if;

  if v_has_assignee and p_changes ->> 'assigned_employee_id' is not null and v_assignee is null then
    raise exception 'USER: Choose who to assign them to.' using errcode = 'P0001';
  end if;
  if v_has_reviewer and p_changes ->> 'reviewer_employee_id' is not null and v_reviewer is null then
    raise exception 'USER: Choose the reviewer.' using errcode = 'P0001';
  end if;
  if v_assignee is not null and not public.employee_can_take_work(v_assignee) then
    raise exception 'USER: That person''s account is disabled, so the work would be lost. Choose someone active.' using errcode = 'P0001';
  end if;
  if v_reviewer is not null and not public.employee_can_take_work(v_reviewer) then
    raise exception 'USER: The reviewer''s account is disabled. Choose someone active to review them.' using errcode = 'P0001';
  end if;
  if v_has_due then
    begin
      v_due := nullif(p_changes ->> 'due_date', '')::date;
    exception when others then
      raise exception 'USER: Enter the new due date.' using errcode = 'P0001';
    end;
    if v_reason is null then
      raise exception 'USER: Give a reason for changing the due date.' using errcode = 'P0001';
    end if;
  end if;
  if v_has_priority then
    if coalesce(p_changes ->> 'priority', '') not in ('low', 'medium', 'high', 'urgent') then
      raise exception 'USER: Choose the priority.' using errcode = 'P0001';
    end if;
    v_priority := (p_changes ->> 'priority')::public.task_priority;
  end if;

  select full_name into v_user_name from public.profiles where id = v_uid;
  select full_name into v_assignee_name from public.employees where id = v_assignee;
  select full_name into v_reviewer_name from public.employees where id = v_reviewer;

  for t in
    select id, task_number, title, client_id, status, assigned_employee_id, reviewer_employee_id, due_date, priority
    from public.tasks
    where id = any (p_task_ids) and deleted_at is null
    order by task_number
    for update
  loop
    v_found := v_found || t.id;
    if t.status = 'filed_done' and (v_has_assignee or v_has_reviewer or v_has_due) then
      v_skipped := v_skipped || jsonb_build_object('id', t.id, 'task_number', t.task_number, 'reason', 'Already filed');
      continue;
    end if;
    v_new_assignee := case when v_has_assignee then v_assignee else t.assigned_employee_id end;
    v_new_reviewer := case when v_has_reviewer then v_reviewer else t.reviewer_employee_id end;
    v_new_due := case when v_has_due then v_due else t.due_date end;
    v_new_priority := case when v_has_priority then v_priority else t.priority end;

    if v_new_assignee is not null and v_new_assignee = v_new_reviewer then
      v_skipped := v_skipped || jsonb_build_object('id', t.id, 'task_number', t.task_number, 'reason',
        case when v_has_assignee then 'They are its reviewer: nobody reviews their own work' else 'They are its assignee: nobody reviews their own work' end);
      continue;
    end if;
    if v_new_assignee is not distinct from t.assigned_employee_id and v_new_reviewer is not distinct from t.reviewer_employee_id
       and v_new_due is not distinct from t.due_date and v_new_priority = t.priority then
      v_skipped := v_skipped || jsonb_build_object('id', t.id, 'task_number', t.task_number, 'reason', 'Nothing to change');
      continue;
    end if;

    update public.tasks
       set assigned_employee_id = v_new_assignee,
           acceptance_status = case when v_new_assignee is null and t.assigned_employee_id is not null then 'pending' else acceptance_status end,
           accepted_at = case when v_new_assignee is null and t.assigned_employee_id is not null then null else accepted_at end,
           reviewer_employee_id = v_new_reviewer,
           due_date = v_new_due,
           priority = v_new_priority
     where id = t.id;

    v_parts := '{}';
    if v_new_assignee is distinct from t.assigned_employee_id then
      v_parts := v_parts || case when v_new_assignee is null then 'Unassigned' else format('Assigned to %s', coalesce(v_assignee_name, 'someone')) end;
    end if;
    if v_new_reviewer is distinct from t.reviewer_employee_id then
      v_parts := v_parts || case when v_new_reviewer is null then 'Reviewer removed' else format('Reviewer set to %s', coalesce(v_reviewer_name, 'someone')) end;
    end if;
    if v_new_due is distinct from t.due_date then
      v_parts := v_parts || format('Due date %s → %s', coalesce(to_char(t.due_date, 'DD Mon YYYY'), 'none'), coalesce(to_char(v_new_due, 'DD Mon YYYY'), 'none'));
    end if;
    if v_new_priority <> t.priority then
      v_parts := v_parts || format('Priority %s → %s', initcap(t.priority::text), initcap(v_new_priority::text));
    end if;

    insert into public.activity_logs (entity_type, entity_id, action, description, user_id, user_name, metadata)
    values (
      'task', t.id, 'bulk_updated',
      array_to_string(v_parts, ' · ') || case when v_reason is not null then ': ' || v_reason else '.' end,
      v_uid, v_user_name,
      jsonb_build_object(
        'reason', v_reason,
        'from', jsonb_build_object('assigned_employee_id', t.assigned_employee_id, 'reviewer_employee_id', t.reviewer_employee_id, 'due_date', t.due_date, 'priority', t.priority),
        'to', jsonb_build_object('assigned_employee_id', v_new_assignee, 'reviewer_employee_id', v_new_reviewer, 'due_date', v_new_due, 'priority', v_new_priority)
      )
    );

    v_updated := v_updated || jsonb_build_object(
      'id', t.id, 'task_number', t.task_number, 'title', t.title, 'client_id', t.client_id,
      'assignee_changed', v_new_assignee is distinct from t.assigned_employee_id,
      'old_assignee', t.assigned_employee_id, 'new_assignee', v_new_assignee,
      'reviewer_changed', v_new_reviewer is distinct from t.reviewer_employee_id, 'new_reviewer', v_new_reviewer,
      'due_changed', v_new_due is distinct from t.due_date, 'old_due', t.due_date, 'new_due', v_new_due,
      'priority_changed', v_new_priority <> t.priority
    );
  end loop;

  select count(*) into v_missing from unnest(p_task_ids) x where not (x = any (v_found));
  if v_missing > 0 then
    v_skipped := v_skipped || jsonb_build_object('id', null, 'task_number', null, 'reason',
      format('%s %s no longer available', v_missing, case when v_missing = 1 then 'task is' else 'tasks are' end));
  end if;

  return jsonb_build_object('updated', v_updated, 'skipped', v_skipped);
end;
$$;

comment on function public.bulk_update_tasks(uuid[], jsonb, text) is
  'Partner/Manager: assign, change reviewer, change due date (with a reason) or priority for many tasks (§7.6.7); tasks that can''t take the change are skipped with the reason; one history line per task.';

-- ---------------------------------------------------------------------------------------------
-- file_task (§7.6.5)
-- p_filing: { filing_type*, period*, financial_year*, filed_on* (YYYY-MM-DD), acknowledgement_no,
--             service_type, document_id, udin_record_id, notes, shareable_with_client,
--             filing_record_id (use a filing already recorded) }
-- or p_skip_reason for work with nothing to file. Returns change_task_status's json plus
-- { filing_record_id, filing_skipped, compliance_event_id }.
-- ---------------------------------------------------------------------------------------------
create or replace function public.file_task(
  p_task_id uuid,
  p_filing jsonb default null,
  p_skip_reason text default null,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_user_name text;
  t public.tasks%rowtype;
  v_skip text := left(nullif(btrim(coalesce(p_skip_reason, '')), ''), 500);
  v_status jsonb;
  v_result jsonb;
  v_record uuid;
  v_existing uuid := public.try_uuid(p_filing ->> 'filing_record_id');
  v_type text := left(nullif(btrim(p_filing ->> 'filing_type'), ''), 60);
  v_period text := left(nullif(btrim(p_filing ->> 'period'), ''), 40);
  v_fy text := nullif(btrim(p_filing ->> 'financial_year'), '');
  v_filed_on date;
  v_ack text := left(nullif(btrim(p_filing ->> 'acknowledgement_no'), ''), 60);
  v_service public.service_type;
  v_document uuid := public.try_uuid(p_filing ->> 'document_id');
  v_udin uuid := public.try_uuid(p_filing ->> 'udin_record_id');
  v_notes text := left(nullif(btrim(p_filing ->> 'notes'), ''), 2000);
  v_share boolean := coalesce((p_filing ->> 'shareable_with_client')::boolean, false);
  v_n int;
begin
  if not public.is_staff() then
    raise exception 'USER: Only the firm''s staff can change a task''s status.' using errcode = 'P0001';
  end if;
  select * into t from public.tasks where id = p_task_id and deleted_at is null for update;
  if not found then
    raise exception 'USER: That task doesn''t exist, or it isn''t one of yours.' using errcode = 'P0001';
  end if;
  if p_expected_updated_at is not null and date_trunc('milliseconds', t.updated_at) <> date_trunc('milliseconds', p_expected_updated_at) then
    raise exception 'USER: This task was changed by someone else. Reload to see their changes.' using errcode = 'P0001';
  end if;
  if v_skip is null and (p_filing is null or jsonb_typeof(p_filing) <> 'object') then
    raise exception 'USER: Enter the filing details, or skip them with a reason.' using errcode = 'P0001';
  end if;

  -- The status rules first (acceptance, who may file, separation of duties, blockers, §7.6.4).
  v_status := public.change_task_status(p_task_id, 'filed_done', null);

  if v_skip is not null then
    update public.tasks set filing_skipped_reason = v_skip where id = t.id;
  else
    begin
      v_service := coalesce(nullif(p_filing ->> 'service_type', '')::public.service_type, t.service_type);
    exception when others then
      v_service := t.service_type;
    end;
    update public.tasks set filing_skipped_reason = null where id = t.id and filing_skipped_reason is not null;

    if t.compliance_event_id is not null then
      -- record_compliance_filing (0126) creates or links the record, links the UDIN and marks the
      -- deadline Filed, under the caller's RLS.
      v_result := public.record_compliance_filing(
        t.compliance_event_id,
        p_filing || jsonb_build_object('service_type', v_service),
        null
      );
      v_record := public.try_uuid(v_result ->> 'filing_record_id');
      update public.filing_records set task_id = t.id where id = v_record and task_id is null;
    elsif v_existing is not null then
      select count(*) into v_n from public.filing_records fr
       where fr.id = v_existing and fr.client_id = t.client_id and (fr.task_id is null or fr.task_id = t.id);
      if v_n = 0 then
        raise exception 'USER: That filing record isn''t this task''s.' using errcode = 'P0001';
      end if;
      update public.filing_records set task_id = t.id where id = v_existing and task_id is null;
      v_record := v_existing;
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
        select 1 from public.documents d where d.id = v_document and d.client_id = t.client_id and d.deleted_at is null
      ) then
        raise exception 'USER: That acknowledgement isn''t in this client''s documents.' using errcode = 'P0001';
      end if;

      insert into public.filing_records (
        client_id, financial_year, filing_type, service_type, period, filed_on, acknowledgement_no,
        task_id, document_id, shareable_with_client, notes, created_by
      ) values (
        t.client_id, v_fy, v_type, v_service, v_period, v_filed_on, v_ack,
        t.id, v_document, v_share, v_notes, v_uid
      )
      returning id into v_record;

      if v_udin is not null then
        update public.udin_records
           set filing_record_id = v_record
         where id = v_udin
           and (client_id = t.client_id or client_id is null)
           and (filing_record_id is null or filing_record_id = v_record);
        get diagnostics v_n = row_count;
        if v_n = 0 then
          raise exception 'USER: That UDIN is linked to another filing or belongs to another client.' using errcode = 'P0001';
        end if;
      end if;
    end if;
  end if;

  select full_name into v_user_name from public.profiles where id = v_uid;
  insert into public.activity_logs (entity_type, entity_id, action, description, user_id, user_name, metadata)
  values (
    'task', t.id,
    case when v_skip is not null then 'filing_skipped' else 'filing_recorded' end,
    case
      when v_skip is not null then 'Filed/Done without a filing record: ' || v_skip
      else format('Filing recorded%s.', case when v_ack is not null then ' · acknowledgement ' || v_ack else '' end)
    end,
    v_uid, v_user_name,
    jsonb_build_object('filing_record_id', v_record, 'compliance_event_id', t.compliance_event_id, 'skip_reason', v_skip)
  );

  return v_status || jsonb_build_object(
    'filing_record_id', v_record,
    'filing_skipped', v_skip is not null,
    'compliance_event_id', t.compliance_event_id
  );
end;
$$;

comment on function public.file_task(uuid, jsonb, text, timestamptz) is
  'Filed/Done with the §7.6.5 filing capture: the filing record (new, or one already recorded) and the linked deadline marked Filed, or a skip reason; then change_task_status. One transaction under the caller''s RLS.';

-- ---------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------
revoke execute on function
  public.employee_can_take_work(uuid),
  public.create_task(jsonb),
  public.apply_job_template(uuid, uuid),
  public.bulk_update_tasks(uuid[], jsonb, text),
  public.file_task(uuid, jsonb, text, timestamptz)
from public, anon;
grant execute on function
  public.employee_can_take_work(uuid),
  public.create_task(jsonb),
  public.apply_job_template(uuid, uuid),
  public.bulk_update_tasks(uuid[], jsonb, text),
  public.file_task(uuid, jsonb, text, timestamptz)
to authenticated, service_role;
