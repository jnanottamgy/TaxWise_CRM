-- =============================================================================================
-- 0215 Home pages (§7.2): shared readers for Firm today, Team today and My day
-- =============================================================================================
--   dashboard_task_rows(ids)          the work tracker's list row (tasks_list) for each id, in the
--                                     order given: what the home pages' task lists render.
--   dashboard_review_queue(limit)     the caller's review queue (the same rule as /work?view=review):
--                                     Under review, named to me (or to any Manager when nobody is
--                                     named and I am a Partner or Manager), never my own task.
--   dashboard_deadlines(from, to, …)  deadlines due in a window, soonest first: the total and the
--                                     first rows (cancelled ones and deleted clients' left out).
--
-- All SECURITY INVOKER: every row comes through the caller's RLS, so an Employee's lists hold only
-- their own clients' tasks and deadlines (§4.1) and nothing here touches money.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------------------------
-- dashboard_task_rows(ids)
-- ---------------------------------------------------------------------------------------------
create or replace function public.dashboard_task_rows(p_ids uuid[])
returns jsonb
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by array_position(p_ids, x.id)), '[]'::jsonb)
  from (
    select
      t.id, t.task_number, t.client_id, t.client_name, t.client_code, t.client_owner_employee_id, t.title,
      t.service_type, t.financial_year, t.period_label, t.status, t.priority, t.due_date, t.completion_date,
      t.assigned_employee_id, t.assignee_name, t.reviewer_employee_id, t.reviewer_name, t.acceptance_status,
      t.decline_reason, t.declined_by_employee_id, t.declined_by_name, t.estimated_minutes, t.escalation_level,
      t.compliance_event_id, t.is_overdue, t.days_overdue, t.checklist_total, t.checklist_done, t.open_blockers,
      t.logged_minutes, t.created_by, t.updated_at
    from public.tasks_list t
    where t.id = any (coalesce(p_ids, '{}'::uuid[]))
      and t.deleted_at is null
  ) x
$$;

comment on function public.dashboard_task_rows(uuid[]) is
  'The work tracker list row (tasks_list columns) for each task id, in the order given, under the caller''s RLS (§7.2).';

-- ---------------------------------------------------------------------------------------------
-- dashboard_review_queue(limit)
-- ---------------------------------------------------------------------------------------------
create or replace function public.dashboard_review_queue(p_limit integer default 5)
returns jsonb
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with me as (
    select public.my_employee_id() as id, coalesce(public.is_manager_or_partner(), false) as pm
  ),
  q as (
    select t.id, t.due_date, t.task_number
    from public.tasks t
    cross join me
    where t.deleted_at is null
      and t.status = 'under_review'
      and (t.reviewer_employee_id = me.id or (me.pm and t.reviewer_employee_id is null))
      and (t.assigned_employee_id is null or me.id is null or t.assigned_employee_id <> me.id)
  )
  select jsonb_build_object(
    'total', (select count(*) from q),
    'rows', public.dashboard_task_rows(array(
      select q.id from q order by q.due_date asc nulls last, q.task_number limit least(greatest(coalesce(p_limit, 5), 0), 50)
    ))
  )
$$;

comment on function public.dashboard_review_queue(integer) is
  'The caller''s review queue (/work?view=review): its size and the first rows, soonest due first (§7.2, §7.6.4).';

-- ---------------------------------------------------------------------------------------------
-- dashboard_deadlines(from, to, limit, owner, pending_only, clients_only)
-- ---------------------------------------------------------------------------------------------
create or replace function public.dashboard_deadlines(
  p_from date,
  p_to date,
  p_limit integer default 6,
  p_owner_employee_id uuid default null,
  p_pending_only boolean default true,
  p_clients_only boolean default false
)
returns jsonb
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with e as (
    select
      e.id, e.client_id, c.display_name as client_name, c.client_code::text as client_code,
      c.owner_employee_id, e.type, e.form_code, e.rule_code, e.title, e.filing_period, e.due_date,
      e.status, e.workflow_status, e.task_id
    from public.compliance_events e
    left join public.clients c on c.id = e.client_id
    where e.status <> 'cancelled'
      and (not coalesce(p_pending_only, true) or e.status = 'pending')
      and e.due_date between p_from and p_to
      and (e.client_id is null or c.deleted_at is null)
      and (not coalesce(p_clients_only, false) or e.client_id is not null)
      and (p_owner_employee_id is null or c.owner_employee_id = p_owner_employee_id)
  )
  select jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'total', (select count(*) from e),
    'rows', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.due_date, x.id)
      from (select * from e order by e.due_date, e.id limit least(greatest(coalesce(p_limit, 6), 0), 100)) x
    ), '[]'::jsonb)
  )
$$;

comment on function public.dashboard_deadlines(date, date, integer, uuid, boolean, boolean) is
  'Deadlines due between two dates (not cancelled; deleted clients'' left out), soonest first: the total and the first rows, under the caller''s RLS (§7.2, §7.7).';

revoke execute on function public.dashboard_task_rows(uuid[]) from public, anon;
revoke execute on function public.dashboard_review_queue(integer) from public, anon;
revoke execute on function public.dashboard_deadlines(date, date, integer, uuid, boolean, boolean) from public, anon;
grant execute on function public.dashboard_task_rows(uuid[]) to authenticated, service_role;
grant execute on function public.dashboard_review_queue(integer) to authenticated, service_role;
grant execute on function public.dashboard_deadlines(date, date, integer, uuid, boolean, boolean) to authenticated, service_role;
