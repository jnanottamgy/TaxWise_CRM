-- =============================================================================================
-- 0217 Team today (§7.2 Manager) in one round trip
-- =============================================================================================
--   dashboard_team_today(today, rows, stale_days, sales_rows)
--
-- Partners and Managers (refused for anyone else; RLS refuses the money tables anyway, §4.1).
-- SECURITY INVOKER. Each count is the size of the /work list its tile opens, with the same rule:
--   unassigned   open (not Filed/Done), nobody assigned (declined tasks included: a decline
--                unassigns the task, §7.6.3)
--   waiting      open, assigned, acceptance pending
--   declined     open, declined and unassigned again
--   review       the caller's review queue (dashboard_review_queue)
--   data_awaited status Data awaited
--   overdue      past due and not Filed/Done (derived, never stored)
-- plus overdue tasks by person (one row with a null employee for unassigned work), this week's
-- deadlines, and the sales strip: invoices issued this month (amount incl. GST) and those still
-- awaiting a Partner's approval, quotations awaiting the client's response (count, value and the
-- longest-waiting rows) and open leads untouched for `stale_days`.

set search_path = public, extensions;

create or replace function public.dashboard_team_today(
  p_today date default null,
  p_rows integer default 4,
  p_stale_days integer default 14,
  p_sales_rows integer default 4
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  v_today date := coalesce(p_today, public.today_ist());
  v_month_start date := date_trunc('month', coalesce(p_today, public.today_ist()))::date;
  v_month_end date := (date_trunc('month', coalesce(p_today, public.today_ist())) + interval '1 month' - interval '1 day')::date;
  v_week_from date := coalesce(p_today, public.today_ist()) - (extract(isodow from coalesce(p_today, public.today_ist()))::int - 1);
  v_rows integer := least(greatest(coalesce(p_rows, 4), 0), 50);
  v_sales_rows integer := least(greatest(coalesce(p_sales_rows, 4), 0), 50);
  v_stale_before timestamptz := now() - make_interval(days => greatest(coalesce(p_stale_days, 14), 1));
  v_out jsonb;
begin
  if not coalesce(public.is_manager_or_partner(), false) then
    raise exception 'USER: Team today is for Partners and Managers.' using errcode = 'P0001';
  end if;

  with
  open_t as (
    select t.id, t.task_number, t.due_date, t.assigned_employee_id, t.acceptance_status
    from public.tasks t
    where t.deleted_at is null
      and t.status <> 'filed_done'
  ),
  unassigned as (select * from open_t where assigned_employee_id is null),
  waiting as (select * from open_t where acceptance_status = 'pending' and assigned_employee_id is not null),
  declined as (select * from open_t where acceptance_status = 'declined' and assigned_employee_id is null),
  overdue as (
    select t.assigned_employee_id
    from public.tasks t
    where t.deleted_at is null
      and t.status <> 'filed_done'
      and t.due_date < v_today
  ),
  issued_month as (
    select i.total_amount
    from public.invoices i
    where i.deleted_at is null
      and i.cancelled_at is null
      and i.invoice_number is not null
      and i.status not in ('draft', 'awaiting_approval')
      and i.issue_date between v_month_start and v_month_end
  ),
  awaiting_quotes as (
    select q.id, q.quotation_number, coalesce(nullif(btrim(q.client_company), ''), q.client_name) as client_name, q.total, q.sent_at, q.status
    from public.quotations q
    where q.deleted_at is null
      and q.status in ('sent', 'viewed')
  ),
  stale as (
    select l.id, l.name, l.company, l.status, l.last_activity_at, l.created_at
    from public.leads l
    where l.deleted_at is null
      and l.status not in ('won', 'lost')
      and coalesce(l.last_activity_at, l.created_at) < v_stale_before
  )
  select jsonb_build_object(
    'today', v_today,
    'month_start', v_month_start,
    'month_end', v_month_end,
    'unassigned', jsonb_build_object(
      'total', (select count(*) from unassigned),
      'rows', public.dashboard_task_rows(array(select u.id from unassigned u order by u.due_date asc nulls last, u.task_number limit v_rows))
    ),
    'waiting', jsonb_build_object(
      'total', (select count(*) from waiting),
      'rows', public.dashboard_task_rows(array(select w.id from waiting w order by w.due_date asc nulls last, w.task_number limit v_rows))
    ),
    'declined', jsonb_build_object(
      'total', (select count(*) from declined),
      'rows', public.dashboard_task_rows(array(select d.id from declined d order by d.due_date asc nulls last, d.task_number limit v_rows))
    ),
    'review', public.dashboard_review_queue(v_rows),
    'data_awaited', (select count(*) from public.tasks t where t.deleted_at is null and t.status = 'data_awaited'),
    'overdue', (select count(*) from overdue),
    'overdue_by_person', coalesce((
      select jsonb_agg(jsonb_build_object('employee_id', x.employee_id, 'name', x.name, 'count', x.n) order by (x.employee_id is null), x.n desc, x.name)
      from (
        select o.assigned_employee_id as employee_id, coalesce(d.full_name, case when o.assigned_employee_id is null then 'Unassigned' else 'Someone' end) as name, count(*) as n
        from overdue o
        left join public.employee_directory d on d.id = o.assigned_employee_id
        group by 1, 2
      ) x
    ), '[]'::jsonb),
    'week', public.dashboard_deadlines(v_week_from, v_week_from + 6, 6, null, true, false),
    'sales', jsonb_build_object(
      'invoices_month', (select count(*) from issued_month),
      'invoices_month_total', (select coalesce(sum(total_amount), 0) from issued_month)::text,
      'invoices_awaiting', (select count(*) from public.invoices i where i.deleted_at is null and i.status = 'awaiting_approval'),
      'quotations_awaiting', (select count(*) from awaiting_quotes),
      'quotations_awaiting_value', (select coalesce(sum(total), 0) from awaiting_quotes)::text,
      'quotation_rows', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', q.id, 'quotation_number', q.quotation_number, 'client_name', q.client_name,
          'total', q.total::text, 'sent_at', q.sent_at, 'status', q.status
        ) order by q.sent_at asc nulls last, q.id)
        from (select * from awaiting_quotes order by sent_at asc nulls last, id limit v_sales_rows) q
      ), '[]'::jsonb),
      'stale_leads', (select count(*) from stale),
      'stale_rows', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', s.id, 'name', s.name, 'company', s.company, 'status', s.status,
          'last_activity_at', s.last_activity_at, 'created_at', s.created_at
        ) order by coalesce(s.last_activity_at, s.created_at), s.id)
        from (select * from stale order by coalesce(last_activity_at, created_at), id limit v_sales_rows) s
      ), '[]'::jsonb)
    )
  )
  into v_out;

  return v_out;
end;
$$;

comment on function public.dashboard_team_today(date, integer, integer, integer) is
  'Team today (§7.2 Manager) in one call: the work queues with their first rows, overdue tasks by person, this week''s deadlines, invoices issued this month, quotations awaiting a response and stale leads. Partners and Managers; SECURITY INVOKER.';

revoke execute on function public.dashboard_team_today(date, integer, integer, integer) from public, anon;
grant execute on function public.dashboard_team_today(date, integer, integer, integer) to authenticated, service_role;
