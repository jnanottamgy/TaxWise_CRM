-- 0242 · Task sign-off holds for every caller, including one who talks to the database API directly
-- with their own login instead of using the app (§7.6.3–§7.6.5). Found by the end-to-end break-it run:
--
--   1. Acceptance is the assignee's own act. A Manager could write acceptance_status / accepted_at /
--      assigned_employee_id on a task through the API: accept on someone's behalf, or unassign their
--      own accepted task and then file it (so "nobody files their own work" didn't hold). tasks_guard
--      now lets only the assignee accept or decline (respond_to_task, or the Employee's own update),
--      and any change of assignee through the API, to someone else or to nobody, puts the task back
--      to waiting for acceptance.
--   2. Work that ends in a filing is filed through file_task, which records the filing or the reason
--      there is none. change_task_status alone moved such a task to Filed/Done with neither; the rule
--      lived only in the app. file_task now vouches for the capture inside the transaction and
--      change_task_status refuses without it.
--   3. Reopening filed work is a Partner's or Manager's move: an Employee could undo the reviewer's
--      sign-off on a task assigned to them, with nobody told. (The app now also tells the assignee,
--      the reviewer and the client's owner when a task is reopened: notification type task_reopened.)
--   4. Filing the same return twice for one task (after a reopen) updates that task's filing record
--      instead of adding a second one; the same acknowledgement number can't be recorded against two
--      tasks.
--
-- Function bodies are 0035's, 0036's and 0131's with only those rules changed; grants and comments
-- are unchanged. The pure mirror of the status rules is lib/domain/transitions.ts.

set search_path = public, extensions;

alter type public.notification_type add value if not exists 'task_reopened';

-- =============================================================================================
-- 1. tasks_guard
-- =============================================================================================
create or replace function public.tasks_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_api boolean := public.is_api_caller();
begin
  if tg_op = 'INSERT' then
    if v_api and (new.status = 'filed_done' or new.completion_date is not null) then
      raise exception 'USER: A new task can''t start as Filed/Done. Create it, then file it through Change status.'
        using errcode = 'P0001';
    end if;
    if v_api and (new.acceptance_status <> 'pending' or new.accepted_at is not null
                  or new.declined_at is not null or new.declined_by_employee_id is not null) then
      raise exception 'USER: A new task waits for the person it''s assigned to. Only they can accept or decline it.'
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  if v_api then
    if new.status is distinct from old.status or new.completion_date is distinct from old.completion_date then
      raise exception 'USER: A task''s status changes only through Change status (change_task_status), which checks acceptance, blockers and who may file.'
        using errcode = 'P0001';
    end if;
    if public.app_role() = 'employee' then
      perform public.tasks_guard_employee(old, new);
    else
      -- §7.6.3: accepting and declining belong to the assignee (respond_to_task). Anyone else may only
      -- put a task back to waiting, which a change of assignee does by itself below.
      if (new.acceptance_status is distinct from old.acceptance_status or new.accepted_at is distinct from old.accepted_at)
         and not (new.acceptance_status = 'pending' and new.accepted_at is null) then
        raise exception 'USER: Only the person a task is assigned to can accept or decline it.' using errcode = 'P0001';
      end if;
      if new.declined_at is distinct from old.declined_at
         or new.decline_reason is distinct from old.decline_reason
         or new.decline_note is distinct from old.decline_note
         or new.declined_by_employee_id is distinct from old.declined_by_employee_id then
        raise exception 'USER: Only the person a task is assigned to can accept or decline it.' using errcode = 'P0001';
      end if;
    end if;
  end if;

  -- §7.6.3: a task waits for its assignee.
  if new.assigned_employee_id is distinct from old.assigned_employee_id then
    if v_api then
      -- Through the API every change of assignee, to someone else or to nobody, waits again; the one
      -- exception is the assignee's own decline, which unassigns the task and records them.
      if not (new.assigned_employee_id is null and new.acceptance_status = 'declined') then
        new.acceptance_status := 'pending';
        new.accepted_at := null;
      end if;
    elsif new.assigned_employee_id is not null
          and new.acceptance_status is not distinct from old.acceptance_status then
      -- The firm's own functions and jobs: a new assignee waits unless the same change says otherwise.
      new.acceptance_status := 'pending';
      new.accepted_at := null;
    end if;
  end if;
  return new;
end;
$$;

-- =============================================================================================
-- 2–3. change_task_status: Employees don't reopen filed work; a filing task is filed by file_task.
-- The checks, in the order their refusals are reported (mirror: lib/domain/transitions.ts):
--   1. the caller is staff   2. not a no-op   3. not declined by the caller   4. accepted
--   5. Employees: only tasks assigned to them
--   6. reopening: Employees never (a Partner or Manager reopens); never Filed/Done → Not started
--   7. Filed/Done: Employees never; Managers not their own work; Partners anything
--   8. blockers   9. reasons
--  10. Filed/Done on work that ends in a filing: only through file_task (§7.6.5)
-- =============================================================================================
create or replace function public.task_needs_filing_capture(p_service public.service_type, p_compliance_event_id uuid)
returns boolean
language sql
immutable
set search_path = public, extensions
as $$
  select p_compliance_event_id is not null
      or (p_service is not null and p_service in ('gst', 'income_tax', 'tds', 'payroll', 'audit', 'company_law', 'incorporation'))
$$;

comment on function public.task_needs_filing_capture(public.service_type, uuid) is
  'True when moving the task to Filed/Done asks for the filing details (§7.6.5): it is linked to a compliance deadline, or its service ends in a filing. Mirror: needsFilingCapture in lib/schemas/tasks.ts.';

create or replace function public.change_task_status(p_task_id uuid, p_to public.task_status, p_reason text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_role public.app_role := public.app_role();
  v_me uuid;
  t public.tasks%rowtype;
  v_from public.task_status;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_open text[];
  v_list text;
  v_kind text;
  v_completion timestamptz;
  v_reset_escalation boolean := false;
  v_history_id uuid;
  v_owner uuid;
  v_filed_by uuid;
begin
  if v_role is null or v_role not in ('partner', 'manager', 'employee') then
    raise exception 'USER: Only the firm''s staff can change a task''s status.' using errcode = 'P0001';
  end if;
  if p_to is null then
    raise exception 'USER: Choose the status to move this task to.' using errcode = 'P0001';
  end if;
  v_me := public.my_employee_id();

  select * into t from public.tasks where id = p_task_id and deleted_at is null for update;
  if not found or not public.can_see_task(p_task_id) then
    raise exception 'USER: That task doesn''t exist, or it isn''t one of yours.' using errcode = 'P0001';
  end if;
  v_from := t.status;

  -- 2. no-op
  if v_from = p_to then
    raise exception 'USER: This task is already %.', public.task_status_label(p_to) using errcode = 'P0001';
  end if;

  -- 3–4. acceptance (§7.6.3)
  if t.declined_by_employee_id is not null and v_me is not null and t.declined_by_employee_id = v_me
     and not (t.assigned_employee_id = v_me and t.acceptance_status = 'accepted') then
    raise exception 'USER: You declined this task, so you can''t update it.' using errcode = 'P0001';
  end if;
  if t.acceptance_status = 'pending' then
    raise exception 'USER: This task is waiting for acceptance. Its status can change once the assignee accepts it.'
      using errcode = 'P0001';
  end if;
  if t.acceptance_status = 'declined' then
    raise exception 'USER: This task was declined. Reassign it; its status can change once the new assignee accepts it.'
      using errcode = 'P0001';
  end if;

  -- 5. Employees change only tasks assigned to them (§4.6)
  if v_role = 'employee' and (v_me is null or t.assigned_employee_id is distinct from v_me) then
    raise exception 'USER: You can only change the status of tasks assigned to you.' using errcode = 'P0001';
  end if;

  -- 6. reopening: filing is the reviewer's sign-off, so undoing it is a Partner's or Manager's move
  if v_from = 'filed_done' and v_role = 'employee' then
    raise exception 'USER: This task is filed. Ask a Manager or Partner to reopen it.' using errcode = 'P0001';
  end if;
  if v_from = 'filed_done' and p_to = 'not_started' then
    raise exception 'USER: This task is already done and filed; reopen it to In progress instead.' using errcode = 'P0001';
  end if;

  -- 7. who can file (§4.1, §7.6.4)
  if p_to = 'filed_done' then
    if v_role = 'employee' then
      raise exception 'USER: Employees can''t set Filed/Done. Submit it for review (Under review) instead.' using errcode = 'P0001';
    end if;
    if v_role = 'manager' and v_me is not null and v_me = t.assigned_employee_id then
      raise exception 'USER: Nobody files their own work. Ask another Manager or a Partner to file it.' using errcode = 'P0001';
    end if;
  end if;

  -- 8. dependencies: the error names the blocker(s)
  if p_to in ('in_progress', 'under_review', 'filed_done') then
    select array_agg('“' || b.title || '”' order by d.created_at, d.id)
      into v_open
    from public.task_dependencies d
    join public.tasks b on b.id = d.blocker_task_id
    where d.task_id = t.id
      and b.deleted_at is null
      and b.status <> 'filed_done';
    if v_open is not null then
      v_list := case
        when array_length(v_open, 1) = 1 then v_open[1]
        else array_to_string(v_open[1:array_length(v_open, 1) - 1], ', ') || ' and ' || v_open[array_length(v_open, 1)]
      end;
      raise exception 'USER: Blocked by %, %.', v_list,
        case when array_length(v_open, 1) = 1 then 'which isn''t Filed/Done yet' else 'which aren''t Filed/Done yet' end
        using errcode = 'P0001';
    end if;
  end if;

  -- 9. reasons (§7.6.4)
  if v_reason is null and (
    (v_from = 'under_review' and p_to = 'in_progress') or v_from = 'filed_done' or p_to = 'on_hold'
  ) then
    if v_from = 'filed_done' then
      raise exception 'USER: Give a reason for reopening this task.' using errcode = 'P0001';
    elsif v_from = 'under_review' and p_to = 'in_progress' then
      raise exception 'USER: Give a reason for sending this back; the assignee sees it.' using errcode = 'P0001';
    else
      raise exception 'USER: Give a reason for putting this task on hold.' using errcode = 'P0001';
    end if;
  end if;

  -- 10. §7.6.5: work that ends in a filing is filed through file_task, which sets this marker for
  -- its own transaction after checking the filing details or the reason for skipping them.
  if p_to = 'filed_done' and public.task_needs_filing_capture(t.service_type, t.compliance_event_id) then
    if coalesce(current_setting('taxwise.filing_capture', true), '') <> t.id::text then
      raise exception 'USER: Record the filing details (return, period, filed-on date, acknowledgement), or skip them with a reason.'
        using errcode = 'P0001';
    end if;
    perform set_config('taxwise.filing_capture', '', true);
  end if;

  -- Derived values (§7.6.4)
  v_kind := case
    when p_to = 'filed_done' then 'file'
    when v_from = 'filed_done' then 'reopen'
    when v_from = 'under_review' and p_to = 'in_progress' then 'send_back'
    when p_to = 'under_review' then 'submit_for_review'
    when p_to = 'on_hold' then 'hold'
    when p_to = 'data_awaited' then 'data_awaited'
    else 'move'
  end;
  v_completion := case
    when p_to = 'filed_done' then coalesce(t.completion_date, now())
    when v_from = 'filed_done' then null
    else t.completion_date
  end;
  v_reset_escalation := v_from = 'filed_done';

  -- Who filed it, for the reopen notice: the person behind the latest move to Filed/Done.
  if v_from = 'filed_done' then
    select e.id into v_filed_by
      from public.task_status_history h
      join public.employees e on e.profile_id = h.changed_by
     where h.task_id = t.id and h.to_status = 'filed_done'
     order by h.changed_at desc
     limit 1;
  end if;

  update public.tasks
     set status = p_to,
         completion_date = v_completion,
         escalation_level = case when v_reset_escalation then 0 else escalation_level end,
         escalated_at = case when v_reset_escalation then null else escalated_at end,
         on_hold_reason = case when p_to = 'on_hold' then v_reason when v_from = 'on_hold' then null else on_hold_reason end
   where id = t.id;

  insert into public.task_status_history (task_id, from_status, to_status, reason, changed_by)
  values (t.id, v_from, p_to, v_reason, auth.uid())
  returning id into v_history_id;

  select c.owner_employee_id into v_owner from public.clients c where c.id = t.client_id;

  return jsonb_build_object(
    'task_id', t.id,
    'task_number', t.task_number,
    'title', t.title,
    'client_id', t.client_id,
    'from_status', v_from,
    'to_status', p_to,
    'reason', v_reason,
    'kind', v_kind,
    'completion_date', v_completion,
    'reset_escalation', v_reset_escalation,
    'adds_to_call_list', p_to = 'data_awaited',
    'actor_employee_id', v_me,
    'assigned_employee_id', t.assigned_employee_id,
    'reviewer_employee_id', t.reviewer_employee_id,
    'client_owner_employee_id', v_owner,
    'filed_by_employee_id', v_filed_by,
    'history_id', v_history_id
  );
end;
$$;

-- =============================================================================================
-- 2, 4. file_task: vouches for the filing capture; one filing record per filing.
-- =============================================================================================
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
  v_same public.filing_records%rowtype;
  v_other_task text;
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

  -- The status rules first (acceptance, who may file, separation of duties, blockers, §7.6.4). The
  -- marker tells change_task_status that this transaction records the filing or the reason for none.
  perform set_config('taxwise.filing_capture', t.id::text, true);
  v_status := public.change_task_status(p_task_id, 'filed_done', null);
  perform set_config('taxwise.filing_capture', '', true);

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

      -- One record per filing. The same return, period and year already recorded for this task (it
      -- was reopened and is being filed again) is that filing, unless the acknowledgement number
      -- differs: then it is a revised return, a filing of its own. The same acknowledgement number
      -- against another task is one filing claimed twice.
      select fr.* into v_same
        from public.filing_records fr
       where fr.client_id = t.client_id
         and fr.financial_year = v_fy
         and upper(btrim(fr.filing_type)) = upper(v_type)
         and upper(btrim(coalesce(fr.period, ''))) = upper(v_period)
         and (
           (fr.task_id = t.id and (fr.acknowledgement_no is null or v_ack is null or upper(btrim(fr.acknowledgement_no)) = upper(v_ack)))
           or (v_ack is not null and upper(btrim(fr.acknowledgement_no)) = upper(v_ack))
         )
       order by (fr.task_id = t.id) desc nulls last, fr.created_at desc
       limit 1;

      if found and v_same.task_id is not null and v_same.task_id <> t.id then
        select x.task_number into v_other_task from public.tasks x where x.id = v_same.task_id;
        raise exception 'USER: This filing (same return, period and acknowledgement number) is already recorded on task %. Use that record, or check the acknowledgement number.',
          coalesce(v_other_task, 'another task') using errcode = 'P0001';
      elsif found then
        update public.filing_records
           set filed_on = v_filed_on,
               acknowledgement_no = coalesce(v_ack, acknowledgement_no),
               service_type = coalesce(v_service, service_type),
               task_id = t.id,
               document_id = coalesce(v_document, document_id),
               shareable_with_client = v_share,
               notes = coalesce(v_notes, notes)
         where id = v_same.id;
        v_record := v_same.id;
      else
        insert into public.filing_records (
          client_id, financial_year, filing_type, service_type, period, filed_on, acknowledgement_no,
          task_id, document_id, shareable_with_client, notes, created_by
        ) values (
          t.client_id, v_fy, v_type, v_service, v_period, v_filed_on, v_ack,
          t.id, v_document, v_share, v_notes, v_uid
        )
        returning id into v_record;
      end if;

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

revoke execute on function public.task_needs_filing_capture(public.service_type, uuid) from public, anon;
grant execute on function public.task_needs_filing_capture(public.service_type, uuid) to authenticated, service_role;

update public.app_meta set value = '0242' where key = 'schema_version';
