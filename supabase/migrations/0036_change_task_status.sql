-- 0036 · Task status and acceptance functions (§4.6, §7.6.3, §7.6.4). The pure mirror of these rules
-- is lib/domain/transitions.ts (canTransition / transitionEffects); both must agree, including the
-- order in which refusals are reported and their wording.
--
-- change_task_status(task, to, reason) checks, in this order:
--   1. the caller is staff                       "Only the firm's staff can change a task's status."
--   2. not a no-op                               "This task is already <Status>."
--   3. not declined by the caller (unless taken back and accepted)
--   4. accepted (pending / declined refuse)
--   5. Employees: only tasks assigned to them
--   6. never Filed/Done → Not started            "…reopen it to In progress instead."
--   7. Filed/Done: Employees never (they submit Under review); Managers not their own work
--      (separation of duties); Partners anything
--   8. In progress / Under review / Filed/Done wait for every blocker to be Filed/Done (named)
--   9. a reason for sending back (Under review → In progress), reopening (Filed/Done → anything)
--      and putting On hold
-- and then writes, in one transaction: the status; completion_date (set when first Filed/Done, kept
-- on re-save, cleared on reopen); escalation reset on reopen; on_hold_reason; and the
-- task_status_history row. Notifications and the client timeline entry are side effects for the
-- caller to run after the commit (§0.1 rule 5); the returned json carries what they need.
-- Refusals are 'USER: <sentence>' (errcode P0001).

set search_path = public, extensions;

create or replace function public.task_status_label(p public.task_status)
returns text
language sql
immutable
set search_path = public, extensions
as $$
  select case p
    when 'not_started' then 'Not started'
    when 'in_progress' then 'In progress'
    when 'data_awaited' then 'Data awaited'
    when 'under_review' then 'Under review'
    when 'filed_done' then 'Filed/Done'
    when 'on_hold' then 'On hold'
  end
$$;

comment on function public.task_status_label(public.task_status) is 'Status names as §3.6 / transitions.ts use them.';

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

  -- 6. Filed/Done → Not started
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
    'history_id', v_history_id
  );
end;
$$;

comment on function public.change_task_status(uuid, public.task_status, text) is
  'Moves a task to a new status under §7.6.3–§7.6.4 (acceptance, no-op, Filed/Done→Not started, reasons, who may file, separation of duties, named blockers), sets completion_date and escalation, writes task_status_history. Mirror: lib/domain/transitions.ts.';

-- =============================================================================================
-- respond_to_task(task, accept, decline_reason, decline_note) (§7.6.3): the assignee accepts, or
-- declines with a reason code (a note for "Something else"). Declining unassigns the task and
-- records who declined it; the caller notifies the assigner and Managers after the commit.
-- =============================================================================================
create or replace function public.respond_to_task(
  p_task_id uuid,
  p_accept boolean,
  p_decline_reason public.decline_reason default null,
  p_decline_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_me uuid := public.staff_employee_id();
  t public.tasks%rowtype;
  v_note text := nullif(btrim(coalesce(p_decline_note, '')), '');
begin
  if v_me is null then
    raise exception 'USER: Only the firm''s staff can accept or decline tasks.' using errcode = 'P0001';
  end if;
  if p_accept is null then
    raise exception 'USER: Choose Accept or Decline.' using errcode = 'P0001';
  end if;

  select * into t from public.tasks where id = p_task_id and deleted_at is null for update;
  if not found or t.assigned_employee_id is distinct from v_me then
    raise exception 'USER: Only the person this task is assigned to can accept or decline it.' using errcode = 'P0001';
  end if;
  if t.acceptance_status = 'accepted' then
    raise exception 'USER: You''ve already accepted this task.' using errcode = 'P0001';
  end if;
  if t.acceptance_status = 'declined' then
    raise exception 'USER: This task was already declined.' using errcode = 'P0001';
  end if;

  if p_accept then
    update public.tasks
       set acceptance_status = 'accepted', accepted_at = now()
     where id = t.id;
  else
    if p_decline_reason is null then
      raise exception 'USER: Choose a reason for declining.' using errcode = 'P0001';
    end if;
    if p_decline_reason = 'other' and v_note is null then
      raise exception 'USER: Add a note saying why you''re declining.' using errcode = 'P0001';
    end if;
    update public.tasks
       set acceptance_status = 'declined',
           declined_at = now(),
           decline_reason = p_decline_reason,
           decline_note = v_note,
           declined_by_employee_id = v_me,
           assigned_employee_id = null,
           accepted_at = null
     where id = t.id;
  end if;

  return jsonb_build_object(
    'task_id', t.id,
    'task_number', t.task_number,
    'title', t.title,
    'client_id', t.client_id,
    'acceptance_status', case when p_accept then 'accepted' else 'declined' end,
    'decline_reason', case when p_accept then null else p_decline_reason end,
    'decline_note', case when p_accept then null else v_note end,
    'employee_id', v_me,
    'created_by', t.created_by
  );
end;
$$;

comment on function public.respond_to_task(uuid, boolean, public.decline_reason, text) is
  'The assignee accepts a task, or declines it with a reason (unassigns it and records who declined) (§7.6.3).';

revoke execute on function
  public.change_task_status(uuid, public.task_status, text),
  public.respond_to_task(uuid, boolean, public.decline_reason, text),
  public.task_status_label(public.task_status)
from public, anon;
grant execute on function
  public.change_task_status(uuid, public.task_status, text),
  public.respond_to_task(uuid, boolean, public.decline_reason, text),
  public.task_status_label(public.task_status)
to authenticated, service_role;

update public.app_meta set value = '0036' where key = 'schema_version';
