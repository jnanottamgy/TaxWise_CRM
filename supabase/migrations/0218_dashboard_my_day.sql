-- =============================================================================================
-- 0218 My day (§7.2 Employee) in one round trip
-- =============================================================================================
--   dashboard_my_day(today, rows, deadline_days)
--
-- Any staff member's own day (the Employee's landing page; Partners and Managers may open it too).
-- SECURITY INVOKER, and nothing here reads a fee, an invoice, a receipt, a quotation or a lead
-- (§4.1): only the caller's tasks, their review queue and their clients' deadlines.
--
--   waiting    my open tasks still waiting for my Accept / Decline
--   due_now    my accepted open tasks due today or overdue (and how many of each)
--   sent_back  my tasks whose latest status change is a reviewer's send-back (Under review →
--              In progress, §7.6.4), with the reviewer's reason, when and by whom
--   review     my review queue (dashboard_review_queue)
--   deadlines  my clients' deadlines due in the next `deadline_days` days, not yet filed: an
--              Employee's clients by RLS (owner, team or cover); for a Partner or Manager, the
--              clients they own
-- A login with no team-member record gets { linked: false }.

set search_path = public, extensions;

create or replace function public.dashboard_my_day(
  p_today date default null,
  p_rows integer default 6,
  p_deadline_days integer default 14
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  v_today date := coalesce(p_today, public.today_ist());
  v_me uuid := public.my_employee_id();
  v_rows integer := least(greatest(coalesce(p_rows, 6), 0), 50);
  v_days integer := least(greatest(coalesce(p_deadline_days, 14), 0), 366);
  v_pm boolean := coalesce(public.is_manager_or_partner(), false);
  v_out jsonb;
begin
  if not coalesce(public.is_staff(), false) then
    raise exception 'USER: My day is for the firm''s team.' using errcode = 'P0001';
  end if;
  if v_me is null then
    return jsonb_build_object('linked', false, 'today', v_today);
  end if;

  with
  mine as (
    select t.id, t.task_number, t.due_date, t.priority, t.status, t.acceptance_status
    from public.tasks t
    where t.deleted_at is null
      and t.assigned_employee_id = v_me
      and t.status <> 'filed_done'
  ),
  waiting as (select * from mine where acceptance_status = 'pending'),
  due_now as (select * from mine where acceptance_status <> 'pending' and due_date <= v_today),
  sent_back as (
    select m.id, h.reason, h.changed_at, h.changed_by
    from mine m
    cross join lateral (
      select h.from_status, h.to_status, h.reason, h.changed_at, h.changed_by
      from public.task_status_history h
      where h.task_id = m.id
      order by h.changed_at desc, h.id desc
      limit 1
    ) h
    where m.status = 'in_progress'
      and h.from_status = 'under_review'
      and h.to_status = 'in_progress'
  ),
  sent_back_top as (
    select s.*, row_number() over (order by s.changed_at desc, s.id) as ord
    from sent_back s
  )
  select jsonb_build_object(
    'linked', true,
    'today', v_today,
    'waiting', jsonb_build_object(
      'total', (select count(*) from waiting),
      'rows', public.dashboard_task_rows(array(select w.id from waiting w order by w.due_date asc nulls last, w.task_number limit v_rows))
    ),
    'due_now', jsonb_build_object(
      'total', (select count(*) from due_now),
      'overdue', (select count(*) from due_now where due_date < v_today),
      'today', (select count(*) from due_now where due_date = v_today),
      'rows', public.dashboard_task_rows(array(select d.id from due_now d order by d.due_date asc nulls last, d.priority desc, d.task_number limit v_rows))
    ),
    'sent_back', jsonb_build_object(
      'total', (select count(*) from sent_back),
      'rows', public.dashboard_task_rows(array(select s.id from sent_back_top s where s.ord <= v_rows order by s.ord)),
      'meta', coalesce((
        select jsonb_agg(jsonb_build_object('task_id', s.id, 'reason', s.reason, 'at', s.changed_at, 'by_name', d.full_name) order by s.ord)
        from sent_back_top s
        left join public.employee_directory d on d.profile_id = s.changed_by
        where s.ord <= v_rows
      ), '[]'::jsonb)
    ),
    'review', public.dashboard_review_queue(v_rows),
    'deadlines', public.dashboard_deadlines(v_today, v_today + v_days, v_rows, case when v_pm then v_me end, true, true)
  )
  into v_out;

  return v_out;
end;
$$;

comment on function public.dashboard_my_day(date, integer, integer) is
  'My day (§7.2 Employee) in one call: my tasks waiting for acceptance, due today or overdue, and sent back with the reviewer''s reason; my review queue; my clients'' upcoming deadlines. Any staff member; no money; SECURITY INVOKER.';

revoke execute on function public.dashboard_my_day(date, integer, integer) from public, anon;
grant execute on function public.dashboard_my_day(date, integer, integer) to authenticated, service_role;
