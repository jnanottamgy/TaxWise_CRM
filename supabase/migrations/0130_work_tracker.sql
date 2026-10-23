-- 0130 · Work tracker: who assigned a task, escalation re-arm, recurring-task links, and the list
-- view behind /work (§5.5, §7.6.1–§7.6.3, §7.6.7).
--
-- 1. tasks.assigned_by / assigned_at: who gave the task to its current assignee and when. Declining
--    "notifies the assigner and Managers" (§7.6.3), so the assigner is recorded on every change of
--    assignee (the signed-in user; the system for a job). API callers can't write these directly.
-- 2. tasks.automation_id: the recurring-task automation that created the task (§7.6.7). One task per
--    automation and period (unique index), so a job that runs twice never doubles up.
-- 3. task_automations.created_by: the person who set the automation up; its tasks are created in
--    their name (tasks.created_by is required).
-- 4. Escalation re-arms on a due-date change (§7.6.7 "re-arms after reopen or a due-date change"):
--    a trigger resets escalation_level / escalated_at whenever the due date moves, for every writer.
--    (Reopening is handled by change_task_status, 0036.)
-- 5. tasks_list (security_invoker): tasks with the client's name and code, the assignee's, reviewer's
--    and decliner's names (from employee_directory, which every staff member may read), the derived
--    overdue values (§0.1 rule 10), checklist progress, open blockers and time logged. No money.
--    An Employee may hold a task on a client they can't otherwise see (assigned or named reviewer,
--    §4.1); the client's name and code then come from task_client_ref(), which answers only for a
--    task the caller can see. Open blockers and time logged count every blocker and every person's
--    time on the task (an Employee's RLS would otherwise hide colleagues' rows and undercount).

set search_path = public, extensions;

-- =============================================================================================
-- 1–3. Columns
-- =============================================================================================
alter table public.tasks
  add column if not exists assigned_by uuid,
  add column if not exists assigned_at timestamptz,
  add column if not exists automation_id uuid references public.task_automations (id) on delete set null;

comment on column public.tasks.assigned_by is 'profiles.id of who assigned the current assignee (§7.6.3: declines notify the assigner). Set by tasks_track_assignment.';
comment on column public.tasks.assigned_at is 'When the current assignee was assigned. Set by tasks_track_assignment.';
comment on column public.tasks.automation_id is 'The recurring-task automation that created this task (§7.6.7).';

alter table public.task_automations
  add column if not exists created_by uuid;

comment on column public.task_automations.created_by is 'profiles.id of who set the automation up; its tasks are created in their name.';

-- Existing assignments: the creator assigned them.
update public.tasks
   set assigned_by = coalesce(assigned_by, created_by),
       assigned_at = coalesce(assigned_at, accepted_at, created_at)
 where assigned_employee_id is not null and (assigned_by is null or assigned_at is null);

create unique index if not exists tasks_automation_period_key
  on public.tasks (automation_id, period_label)
  where automation_id is not null and deleted_at is null;

create index if not exists tasks_assigned_by_idx on public.tasks (assigned_by) where deleted_at is null;
create index if not exists task_automations_client_idx on public.task_automations (client_id);

-- =============================================================================================
-- 4. tasks_track_assignment: assigner, assignment time and the escalation re-arm
-- Fires after tasks_guard (BEFORE triggers run in name order), so the Employee column limits in
-- tasks_guard_employee see the row as the caller sent it.
-- =============================================================================================
create or replace function public.tasks_track_assignment()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_api boolean := public.is_api_caller();
begin
  if tg_op = 'INSERT' then
    if new.assigned_employee_id is null then
      new.assigned_by := null;
      new.assigned_at := null;
    else
      new.assigned_by := coalesce(case when v_api then auth.uid() end, new.assigned_by, auth.uid(), new.created_by);
      new.assigned_at := now();
    end if;
    return new;
  end if;

  if new.assigned_employee_id is not null and new.assigned_employee_id is distinct from old.assigned_employee_id then
    -- A new assignee: the person making the change assigned it (a job may name the assigner itself).
    new.assigned_by := coalesce(
      auth.uid(),
      case when not v_api and new.assigned_by is distinct from old.assigned_by then new.assigned_by end,
      old.assigned_by,
      new.created_by
    );
    new.assigned_at := now();
  elsif v_api then
    -- Unchanged (or unassigned by a decline): the record of who assigned it stays as it was.
    new.assigned_by := old.assigned_by;
    new.assigned_at := old.assigned_at;
  end if;

  -- §7.6.7: a due-date change re-arms escalation, unless the same change sets the level itself.
  if new.due_date is distinct from old.due_date
     and new.escalation_level is not distinct from old.escalation_level
     and new.escalated_at is not distinct from old.escalated_at then
    new.escalation_level := 0;
    new.escalated_at := null;
  end if;
  return new;
end;
$$;

comment on function public.tasks_track_assignment() is
  'Trigger: records who assigned the current assignee and when (§7.6.3), keeps API callers from rewriting it, and re-arms escalation when the due date changes (§7.6.7).';

drop trigger if exists tasks_track_assignment on public.tasks;
create trigger tasks_track_assignment before insert or update on public.tasks
  for each row execute function public.tasks_track_assignment();

revoke execute on function public.tasks_track_assignment() from public, anon, authenticated;

-- =============================================================================================
-- 5. Helpers for tasks_list (SECURITY DEFINER, read-only, each answering only for visible tasks)
-- =============================================================================================

-- The client's name and code for a task the caller can see, even when the client itself is outside
-- their scope (an Employee assigned work on a colleague's client). Nothing else about the client.
create or replace function public.task_client_ref(p_task_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  select jsonb_build_object('name', c.display_name, 'code', c.client_code::text)
  from public.tasks t
  join public.clients c on c.id = t.client_id
  where t.id = p_task_id
    and public.can_see_task(p_task_id)
$$;

comment on function public.task_client_ref(uuid) is
  'Name and code of the client of a task the caller can see (§4.1: tasks assigned to an Employee are theirs to see).';

-- Open blockers of a task the caller can see: every blocker that isn't Filed/Done (§7.6.4).
create or replace function public.task_open_blocker_count(p_task_id uuid)
returns int
language sql
stable
security definer
set search_path = public, extensions
as $$
  select case when public.can_see_task(p_task_id) then (
    select count(*)::int
    from public.task_dependencies d
    join public.tasks b on b.id = d.blocker_task_id
    where d.task_id = p_task_id and b.deleted_at is null and b.status <> 'filed_done'
  ) end
$$;

comment on function public.task_open_blocker_count(uuid) is
  'How many of a visible task''s blockers aren''t Filed/Done yet (§7.6.4).';

-- Time logged on a task the caller can see, by everyone (§7.6.6 "time logged vs estimate"). Minutes only.
create or replace function public.task_logged_minutes(p_task_id uuid)
returns int
language sql
stable
security definer
set search_path = public, extensions
as $$
  select case when public.can_see_task(p_task_id) then (
    select coalesce(sum(te.minutes), 0)::int
    from public.time_entries te
    where te.task_id = p_task_id and te.ended_at is not null
  ) end
$$;

comment on function public.task_logged_minutes(uuid) is
  'Minutes logged on a visible task by everyone, finished entries only (§7.6.6).';

-- Blocked by / blocking for a task the caller can see (§7.6.6), with the other task's title,
-- status and client, whether or not the other task is in the caller's own scope.
create or replace function public.task_dependency_list(p_task_id uuid)
returns table (
  dependency_id uuid,
  direction text,
  task_id uuid,
  task_number text,
  title text,
  status public.task_status,
  due_date date,
  client_name text,
  visible boolean
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select d.id, 'blocked_by'::text, b.id, b.task_number, b.title, b.status, b.due_date, c.display_name,
         public.can_see_task(b.id)
  from public.task_dependencies d
  join public.tasks b on b.id = d.blocker_task_id and b.deleted_at is null
  join public.clients c on c.id = b.client_id
  where d.task_id = p_task_id and public.can_see_task(p_task_id)
  union all
  select d.id, 'blocking'::text, w.id, w.task_number, w.title, w.status, w.due_date, c.display_name,
         public.can_see_task(w.id)
  from public.task_dependencies d
  join public.tasks w on w.id = d.task_id and w.deleted_at is null
  join public.clients c on c.id = w.client_id
  where d.blocker_task_id = p_task_id and public.can_see_task(p_task_id)
$$;

comment on function public.task_dependency_list(uuid) is
  'The tasks a visible task is blocked by and is blocking, with title, status and client (§7.6.6).';

revoke execute on function
  public.task_client_ref(uuid),
  public.task_open_blocker_count(uuid),
  public.task_logged_minutes(uuid),
  public.task_dependency_list(uuid)
from public, anon;
grant execute on function
  public.task_client_ref(uuid),
  public.task_open_blocker_count(uuid),
  public.task_logged_minutes(uuid),
  public.task_dependency_list(uuid)
to authenticated, service_role;

-- =============================================================================================
-- tasks_list (security_invoker: the caller's RLS on tasks decides the rows)
-- =============================================================================================
create or replace view public.tasks_list with (security_invoker = true) as
select
  t.id,
  t.task_number,
  t.client_id,
  coalesce(c.display_name, public.task_client_ref(t.id) ->> 'name') as client_name,
  coalesce(c.client_code::text, public.task_client_ref(t.id) ->> 'code') as client_code,
  c.owner_employee_id as client_owner_employee_id,
  t.title,
  t.description,
  t.service_type,
  t.financial_year,
  t.period_label,
  t.status,
  t.priority,
  t.due_date,
  t.completion_date,
  t.on_hold_reason,
  t.assigned_employee_id,
  ad.full_name as assignee_name,
  t.reviewer_employee_id,
  rd.full_name as reviewer_name,
  t.acceptance_status,
  t.accepted_at,
  t.declined_at,
  t.decline_reason,
  t.decline_note,
  t.declined_by_employee_id,
  dd.full_name as declined_by_name,
  t.assigned_by,
  t.assigned_at,
  t.estimated_minutes,
  t.remarks,
  t.escalation_level,
  t.escalated_at,
  t.compliance_event_id,
  t.source_template_id,
  t.automation_id,
  t.filing_skipped_reason,
  t.created_by,
  t.created_at,
  t.updated_at,
  t.deleted_at,
  coalesce(t.status <> 'filed_done' and t.due_date < public.today_ist(), false) as is_overdue,
  case when t.status <> 'filed_done' and t.due_date < public.today_ist() then public.today_ist() - t.due_date else 0 end as days_overdue,
  (select count(*)::int from public.task_checklist_items ci where ci.task_id = t.id) as checklist_total,
  (select count(*)::int from public.task_checklist_items ci where ci.task_id = t.id and ci.done) as checklist_done,
  case
    when (select public.is_manager_or_partner()) then (
      select count(*)::int
      from public.task_dependencies d
      join public.tasks b on b.id = d.blocker_task_id
      where d.task_id = t.id and b.deleted_at is null and b.status <> 'filed_done'
    )
    else coalesce(public.task_open_blocker_count(t.id), 0)
  end as open_blockers,
  case
    when (select public.is_manager_or_partner()) then (
      select coalesce(sum(te.minutes), 0)::int from public.time_entries te where te.task_id = t.id and te.ended_at is not null
    )
    else coalesce(public.task_logged_minutes(t.id), 0)
  end as logged_minutes
from public.tasks t
left join public.clients c on c.id = t.client_id
left join public.employee_directory ad on ad.id = t.assigned_employee_id
left join public.employee_directory rd on rd.id = t.reviewer_employee_id
left join public.employee_directory dd on dd.id = t.declined_by_employee_id;

comment on view public.tasks_list is
  'The work tracker''s rows (§7.6.1): tasks with client, people''s names, derived overdue, checklist progress, open blockers and time logged. security_invoker: the caller''s RLS. No money.';

revoke all on public.tasks_list from anon, public;
revoke insert, update, delete, truncate, references, trigger on public.tasks_list from authenticated;
grant select on public.tasks_list to authenticated, service_role;
