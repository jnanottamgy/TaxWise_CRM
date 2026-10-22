-- 0035 · RLS: tasks and their children, job templates, automations, time entries (§4.1, §4.6, §5.5,
-- §7.6, §7.10).
--
-- Tasks are visible (§4.1) when assigned to the caller, when they are the named reviewer, or when
-- the task belongs to a client they can see; Partners and Managers see all. Partners/Managers
-- create and assign. Employees may change only remarks and acceptance on tasks assigned to them,
-- and status only through change_task_status (0036), which enforces §7.6.3–§7.6.4. Nobody changes
-- a task's status by a direct UPDATE through the API: the rules (acceptance, blockers, who may file,
-- separation of duties) live in that function.

set search_path = public, extensions;

-- =============================================================================================
-- tasks
-- =============================================================================================
create policy tasks_select on public.tasks
  for select to authenticated
  using (
    (select public.is_manager_or_partner())
    or assigned_employee_id = (select public.staff_employee_id())
    or reviewer_employee_id = (select public.staff_employee_id())
    or client_id in (select public.staff_client_ids())
  );
create policy tasks_insert on public.tasks
  for insert to authenticated
  with check ((select public.is_manager_or_partner()) and created_by = (select auth.uid()));
create policy tasks_update_manager_partner on public.tasks
  for update to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));
create policy tasks_update_assignee on public.tasks
  for update to authenticated
  using ((select public.app_role()) = 'employee' and assigned_employee_id = (select public.staff_employee_id()))
  with check (
    (select public.app_role()) = 'employee'
    and (
      assigned_employee_id = (select public.staff_employee_id())
      -- declining unassigns the task and records who declined it (§7.6.3)
      or (assigned_employee_id is null and acceptance_status = 'declined'
          and declined_by_employee_id = (select public.staff_employee_id()))
    )
  );
create policy tasks_delete on public.tasks
  for delete to authenticated using ((select public.is_partner()));

-- What an Employee may change directly on a task assigned to them (§4.6, §7.6.3): remarks, and
-- accepting or declining it (declining unassigns it and records them as the decliner).
create or replace function public.tasks_guard_employee(p_old public.tasks, p_new public.tasks)
returns void
language plpgsql
set search_path = public, extensions
as $$
declare
  v_me uuid := public.my_employee_id();
begin
  perform public.assert_changed_only(to_jsonb(p_old), to_jsonb(p_new),
    array['remarks', 'acceptance_status', 'accepted_at', 'declined_at', 'decline_reason', 'decline_note',
          'declined_by_employee_id', 'assigned_employee_id'],
    'this task');
  if p_new.assigned_employee_id is distinct from p_old.assigned_employee_id and p_new.acceptance_status <> 'declined' then
    raise exception 'USER: Only a Partner or Manager can reassign a task. Decline it with a reason instead.' using errcode = 'P0001';
  end if;
  if p_new.acceptance_status is distinct from p_old.acceptance_status then
    if p_old.acceptance_status <> 'pending' or p_new.acceptance_status = 'pending' then
      raise exception 'USER: You can accept or decline a task only while it is waiting for acceptance.' using errcode = 'P0001';
    end if;
    if p_new.acceptance_status = 'declined' then
      if p_new.decline_reason is null then
        raise exception 'USER: Choose a reason for declining.' using errcode = 'P0001';
      end if;
      if p_new.declined_by_employee_id is distinct from v_me or p_new.assigned_employee_id is not null then
        raise exception 'USER: Declining hands the task back: it is unassigned and recorded as declined by you.' using errcode = 'P0001';
      end if;
    end if;
  end if;
  if p_new.declined_by_employee_id is distinct from p_old.declined_by_employee_id and p_new.declined_by_employee_id is distinct from v_me then
    raise exception 'USER: You can only record your own decline.' using errcode = 'P0001';
  end if;
end;
$$;

-- Status and completion_date change only through change_task_status (SECURITY DEFINER), for every
-- API caller; Employees are further limited by tasks_guard_employee. Reassignment resets acceptance.
create or replace function public.tasks_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if tg_op = 'INSERT' then
    if public.is_api_caller() and (new.status = 'filed_done' or new.completion_date is not null) then
      raise exception 'USER: A new task can''t start as Filed/Done. Create it, then file it through Change status.'
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  if public.is_api_caller() then
    if new.status is distinct from old.status or new.completion_date is distinct from old.completion_date then
      raise exception 'USER: A task''s status changes only through Change status (change_task_status), which checks acceptance, blockers and who may file.'
        using errcode = 'P0001';
    end if;
    if public.app_role() = 'employee' then
      perform public.tasks_guard_employee(old, new);
    end if;
  end if;

  -- §7.6.3: a newly assigned task waits for acceptance. Reassigning puts it back to pending unless
  -- the same change sets the acceptance explicitly (applies to every caller).
  if new.assigned_employee_id is not null
     and new.assigned_employee_id is distinct from old.assigned_employee_id
     and new.acceptance_status is not distinct from old.acceptance_status then
    new.acceptance_status := 'pending';
    new.accepted_at := null;
  end if;
  return new;
end;
$$;

create trigger tasks_guard before insert or update on public.tasks
  for each row execute function public.tasks_guard();

-- =============================================================================================
-- Task children: visible with the task (task_id in staff_task_ids()).
-- =============================================================================================

-- task_status_history: written only by change_task_status.
create policy task_status_history_select on public.task_status_history
  for select to authenticated
  using ((select public.is_manager_or_partner()) or task_id in (select public.staff_task_ids()));
revoke insert, update, delete on public.task_status_history from authenticated;

-- task_comments: staff who can see the task comment as themselves; authors edit their own;
-- Partners/Managers moderate.
create policy task_comments_select on public.task_comments
  for select to authenticated
  using ((select public.is_manager_or_partner()) or task_id in (select public.staff_task_ids()));
create policy task_comments_insert on public.task_comments
  for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and ((select public.is_manager_or_partner()) or task_id in (select public.staff_task_ids()))
  );
create policy task_comments_update on public.task_comments
  for update to authenticated
  using ((select public.is_manager_or_partner()) or (author_id = (select auth.uid()) and task_id in (select public.staff_task_ids())))
  with check ((select public.is_manager_or_partner()) or (author_id = (select auth.uid()) and task_id in (select public.staff_task_ids())));
create policy task_comments_delete on public.task_comments
  for delete to authenticated using ((select public.is_manager_or_partner()));

create trigger limit_employee_columns before update on public.task_comments
  for each row execute function public.limit_employee_columns('body,mentions,edited_at,deleted_at', 'this comment');

-- task_attachments: append-only links to vault documents.
create policy task_attachments_select on public.task_attachments
  for select to authenticated
  using ((select public.is_manager_or_partner()) or task_id in (select public.staff_task_ids()));
create policy task_attachments_insert on public.task_attachments
  for insert to authenticated
  with check (
    uploaded_by = (select auth.uid())
    and ((select public.is_manager_or_partner()) or task_id in (select public.staff_task_ids()))
  );
create policy task_attachments_delete on public.task_attachments
  for delete to authenticated
  using ((select public.is_manager_or_partner()) or (uploaded_by = (select auth.uid()) and task_id in (select public.staff_task_ids())));
revoke update on public.task_attachments from authenticated;

-- task_checklist_items: Partners/Managers manage; the assignee ticks items done (§4.6).
create policy task_checklist_items_select on public.task_checklist_items
  for select to authenticated
  using ((select public.is_manager_or_partner()) or task_id in (select public.staff_task_ids()));
create policy task_checklist_items_insert on public.task_checklist_items
  for insert to authenticated with check ((select public.is_manager_or_partner()));
create policy task_checklist_items_update on public.task_checklist_items
  for update to authenticated
  using (
    (select public.is_manager_or_partner())
    or task_id in (select t.id from public.tasks t where t.assigned_employee_id = (select public.staff_employee_id()))
  )
  with check (
    (select public.is_manager_or_partner())
    or task_id in (select t.id from public.tasks t where t.assigned_employee_id = (select public.staff_employee_id()))
  );
create policy task_checklist_items_delete on public.task_checklist_items
  for delete to authenticated using ((select public.is_manager_or_partner()));

create trigger limit_employee_columns before update on public.task_checklist_items
  for each row execute function public.limit_employee_columns('done,done_by,done_at', 'this checklist item');

-- task_dependencies: Partners/Managers set them (cycles rejected in 0017).
create policy task_dependencies_select on public.task_dependencies
  for select to authenticated
  using ((select public.is_manager_or_partner()) or task_id in (select public.staff_task_ids()));
create policy task_dependencies_insert on public.task_dependencies
  for insert to authenticated with check ((select public.is_manager_or_partner()));
create policy task_dependencies_update on public.task_dependencies
  for update to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));
create policy task_dependencies_delete on public.task_dependencies
  for delete to authenticated using ((select public.is_manager_or_partner()));

-- task_automations (§7.6.7): Partners/Managers.
create policy task_automations_all on public.task_automations
  for all to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));

-- =============================================================================================
-- Job templates (§4.1 "Job templates: Employees use only")
-- =============================================================================================
create policy job_templates_select on public.job_templates
  for select to authenticated using ((select public.is_staff()));
create policy job_templates_insert on public.job_templates
  for insert to authenticated with check ((select public.is_manager_or_partner()));
create policy job_templates_update on public.job_templates
  for update to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));
create policy job_templates_delete on public.job_templates
  for delete to authenticated using ((select public.is_manager_or_partner()));

create policy job_template_items_select on public.job_template_items
  for select to authenticated using ((select public.is_staff()));
create policy job_template_items_insert on public.job_template_items
  for insert to authenticated with check ((select public.is_manager_or_partner()));
create policy job_template_items_update on public.job_template_items
  for update to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));
create policy job_template_items_delete on public.job_template_items
  for delete to authenticated using ((select public.is_manager_or_partner()));

-- =============================================================================================
-- time_entries (§7.10): own entries for Employees; billed or locked entries are read-only for
-- them; billing links and locks are Partner/Manager work.
-- =============================================================================================
create policy time_entries_select on public.time_entries
  for select to authenticated
  using ((select public.is_manager_or_partner()) or employee_id = (select public.staff_employee_id()));
create policy time_entries_insert on public.time_entries
  for insert to authenticated
  with check (
    (select public.is_manager_or_partner())
    or (
      employee_id = (select public.staff_employee_id())
      and invoice_id is null and invoiced_at is null and not locked
      and (client_id is null or client_id in (select public.staff_client_ids()))
      and (task_id is null or task_id in (select public.staff_task_ids()))
    )
  );
create policy time_entries_update on public.time_entries
  for update to authenticated
  using (
    (select public.is_manager_or_partner())
    or (employee_id = (select public.staff_employee_id()) and invoice_id is null and not locked)
  )
  with check (
    (select public.is_manager_or_partner())
    or (
      employee_id = (select public.staff_employee_id())
      and invoice_id is null and invoiced_at is null and not locked
      and (client_id is null or client_id in (select public.staff_client_ids()))
      and (task_id is null or task_id in (select public.staff_task_ids()))
    )
  );
create policy time_entries_delete on public.time_entries
  for delete to authenticated
  using (
    (select public.is_manager_or_partner())
    or (employee_id = (select public.staff_employee_id()) and invoice_id is null and not locked)
  );

revoke execute on function public.tasks_guard() from public, anon, authenticated;
-- tasks_guard_employee runs inside the trigger as the invoking user, so authenticated keeps EXECUTE.
revoke execute on function public.tasks_guard_employee(public.tasks, public.tasks) from public, anon;
grant execute on function public.tasks_guard_employee(public.tasks, public.tasks) to authenticated, service_role;

update public.app_meta set value = '0035' where key = 'schema_version';
