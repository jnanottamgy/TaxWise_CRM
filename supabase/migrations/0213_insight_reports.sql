-- 0213 · The reports centre (§7.16): one function per report, aggregated in SQL (§2.3, §13).
--
-- Every function is SECURITY INVOKER (the caller's RLS applies to every table it reads) and starts
-- by refusing anyone but a Partner or a Manager (§4.1 "Reports, revenue, fee realisation"), so an
-- Employee or a portal user never receives a figure, money or otherwise. Parameters arrive as one
-- jsonb object, validated by the app (lib/schemas/reports.ts) and checked again here:
--   from, to      IST dates of the period (to ≥ from, at most ten years)
--   client_id     one client
--   owner_id      the client's owner (employees.id)
--   service       a service_type
--   employee_id   one person (employees.id): the task's assignee, the time's author, the lead's owner
--   fy            the FY label for reports that are kept per FY (tax-audit ceiling, letters)
--   offset/limit  the page of the one long list a report has
-- Amounts come back as decimal strings, so nothing is lost before the app turns them into paise
-- (lib/domain/money.ts); rates are worked out in the app from the counts and amounts.
--
--   report_compliance   filed on time vs late per return and period, the next eight weeks' load,
--                       overdue returns by client owner (statutory events; cancelled ones left out)
--   report_work         tasks created and filed per person, average days to file, submissions and
--                       send-backs, data-awaited ageing and the longest waits
--   report_clients      clients by status, entity type, service and group; new clients per month;
--                       clients made inactive in the period
--   report_collections  receivables ageing, the period's collection-rate inputs, payment promises
--                       against what came in, and the largest debtors
--   report_people       hours and billable hours, attendance days and approved leave per person
--   report_pipeline     leads by source and stage, conversion, quotation outcomes, win rate inputs
--                       and deal values, by source and by author
--   report_practice     the UDIN register for the period, the tax-audit ceiling by partner, DSC and
--                       registration expiries, and engagement-letter coverage for the FY
-- Revenue and realisation reuse the collections module's revenue_ledger (0163) and fee realisation.

set search_path = public, extensions;

-- =============================================================================================
-- Shared helpers
-- =============================================================================================

-- The service a statutory return belongs to (§5.1 compliance_type → service_type).
create or replace function public.compliance_type_service(p_type public.compliance_type)
returns public.service_type
language sql
immutable
set search_path = public, extensions
as $$
  select case p_type
    when 'gstr_1' then 'gst'
    when 'gstr_3b' then 'gst'
    when 'tds' then 'tds'
    when 'itr' then 'income_tax'
    when 'advance_tax' then 'income_tax'
    when 'roc' then 'company_law'
    when 'pf_esic' then 'payroll'
    when 'pt' then 'payroll'
    when 'audit' then 'audit'
    else 'other'
  end::public.service_type
$$;

comment on function public.compliance_type_service(public.compliance_type) is
  'The service a compliance type belongs to, for the reports'' service filter (§7.16).';

-- The validated common parameters (raises a plain sentence for a bad period).
create or replace function public.report_period(p jsonb, out v_from date, out v_to date)
language plpgsql
stable
set search_path = public, extensions
as $$
begin
  v_to := coalesce(nullif(p ->> 'to', '')::date, public.today_ist());
  v_from := coalesce(nullif(p ->> 'from', '')::date, public.fy_start_date(public.financial_year_label(v_to)));
  if v_to < v_from then
    raise exception 'USER: Choose a period that ends after it starts.' using errcode = 'P0001';
  end if;
  if v_to - v_from > 3660 then
    raise exception 'USER: Choose a period of at most ten years.' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.report_require_manager()
returns void
language plpgsql
stable
set search_path = public, extensions
as $$
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Reports are for Partners and Managers.' using errcode = 'P0001';
  end if;
end;
$$;

-- =============================================================================================
-- report_compliance
-- =============================================================================================
create or replace function public.report_compliance(p jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  v_from date;
  v_to date;
  v_today date := public.today_ist();
  v_week0 date := date_trunc('week', public.today_ist())::date;
  v_client uuid := nullif(p ->> 'client_id', '')::uuid;
  v_owner uuid := nullif(p ->> 'owner_id', '')::uuid;
  v_service public.service_type := nullif(p ->> 'service', '')::public.service_type;
  v_employee uuid := nullif(p ->> 'employee_id', '')::uuid;
  v_out jsonb;
begin
  perform public.report_require_manager();
  select r.v_from, r.v_to into v_from, v_to from public.report_period(p) r;

  with ev as (
    select
      e.id, e.client_id, e.type, nullif(e.form_code, '') as form_code, e.filing_period, e.period_start,
      e.due_date, e.status, (e.completed_at at time zone 'Asia/Kolkata')::date as filed_on,
      c.owner_employee_id
    from public.compliance_events e
    join public.clients c on c.id = e.client_id and c.deleted_at is null
    left join public.tasks t on t.id = e.task_id and t.deleted_at is null
    where e.is_statutory
      and e.status <> 'cancelled'
      and (v_client is null or e.client_id = v_client)
      and (v_owner is null or c.owner_employee_id = v_owner)
      and (v_employee is null or t.assigned_employee_id = v_employee)
      and (v_service is null or public.compliance_type_service(e.type) = v_service)
  ),
  in_period as (
    select * from ev where due_date between v_from and v_to
  ),
  by_return as (
    select
      type, form_code, coalesce(filing_period, '') as filing_period,
      min(period_start) as period_start, min(due_date) as first_due, max(due_date) as last_due,
      count(*) as due,
      count(*) filter (where status = 'completed') as filed,
      count(*) filter (where status = 'completed' and filed_on is not null and filed_on <= due_date) as on_time,
      count(*) filter (where status = 'completed' and filed_on is not null and filed_on > due_date) as late,
      count(*) filter (where status = 'pending' and due_date < v_today) as overdue,
      count(*) filter (where status = 'pending' and due_date >= v_today) as not_yet_due
    from in_period
    group by type, form_code, coalesce(filing_period, '')
  ),
  weeks as (
    select (v_week0 + g * 7) as week_start from generate_series(0, 7) g
  ),
  upcoming as (
    select
      w.week_start,
      count(e.id) as total,
      count(e.id) filter (where e.type in ('gstr_1', 'gstr_3b')) as gst,
      count(e.id) filter (where e.type = 'tds') as tds,
      count(e.id) filter (where e.type in ('itr', 'advance_tax')) as income_tax,
      count(e.id) filter (where e.type = 'roc') as roc,
      count(e.id) filter (where e.type not in ('gstr_1', 'gstr_3b', 'tds', 'itr', 'advance_tax', 'roc')) as other
    from weeks w
    left join ev e on e.status = 'pending' and e.due_date >= greatest(w.week_start, v_today) and e.due_date < w.week_start + 7
    group by w.week_start
  ),
  overdue as (
    select
      e.owner_employee_id,
      count(*) as overdue,
      count(distinct e.client_id) as clients,
      min(e.due_date) as oldest_due
    from ev e
    where e.status = 'pending' and e.due_date < v_today
    group by e.owner_employee_id
  )
  select jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'today', v_today,
    'kpis', jsonb_build_object(
      'due', (select count(*) from in_period),
      'filed', (select count(*) from in_period where status = 'completed'),
      'on_time', (select count(*) from in_period where status = 'completed' and filed_on is not null and filed_on <= due_date),
      'late', (select count(*) from in_period where status = 'completed' and filed_on is not null and filed_on > due_date),
      'overdue_now', (select count(*) from ev where status = 'pending' and due_date < v_today),
      'due_next_30', (select count(*) from ev where status = 'pending' and due_date between v_today and v_today + 30)
    ),
    'by_return', coalesce((
      select jsonb_agg(to_jsonb(b) order by coalesce(b.form_code, b.type::text), b.period_start nulls last, b.first_due, b.filing_period)
      from by_return b
    ), '[]'::jsonb),
    'upcoming', coalesce((select jsonb_agg(to_jsonb(u) order by u.week_start) from upcoming u), '[]'::jsonb),
    'overdue_by_owner', coalesce((
      select jsonb_agg(jsonb_build_object(
        'owner_id', o.owner_employee_id,
        'owner_name', emp.full_name,
        'overdue', o.overdue,
        'clients', o.clients,
        'oldest_due', o.oldest_due,
        'days_overdue', v_today - o.oldest_due
      ) order by o.overdue desc, emp.full_name nulls last)
      from overdue o
      left join public.employees emp on emp.id = o.owner_employee_id
    ), '[]'::jsonb)
  ) into v_out;
  return v_out;
end;
$$;

-- =============================================================================================
-- report_work
-- =============================================================================================
create or replace function public.report_work(p jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  v_from date;
  v_to date;
  v_today date := public.today_ist();
  v_client uuid := nullif(p ->> 'client_id', '')::uuid;
  v_owner uuid := nullif(p ->> 'owner_id', '')::uuid;
  v_service public.service_type := nullif(p ->> 'service', '')::public.service_type;
  v_employee uuid := nullif(p ->> 'employee_id', '')::uuid;
  v_out jsonb;
begin
  perform public.report_require_manager();
  select r.v_from, r.v_to into v_from, v_to from public.report_period(p) r;

  with t as (
    select
      t.id, t.task_number, t.title, t.client_id, c.display_name as client_name, t.status, t.due_date,
      t.assigned_employee_id as emp, t.created_at, t.completion_date, t.updated_at,
      (t.created_at at time zone 'Asia/Kolkata')::date as created_on,
      (t.completion_date at time zone 'Asia/Kolkata')::date as filed_on
    from public.tasks t
    join public.clients c on c.id = t.client_id and c.deleted_at is null
    where t.deleted_at is null
      and (v_client is null or t.client_id = v_client)
      and (v_owner is null or c.owner_employee_id = v_owner)
      and (v_service is null or t.service_type = v_service)
      and (v_employee is null or t.assigned_employee_id = v_employee)
  ),
  hist as (
    select t.emp, h.from_status, h.to_status
    from public.task_status_history h
    join t on t.id = h.task_id
    where (h.changed_at at time zone 'Asia/Kolkata')::date between v_from and v_to
  ),
  per as (
    select emp,
      sum(created) as created, sum(filed) as filed, sum(file_days) as file_days, sum(filed_with_days) as filed_with_days,
      sum(submitted) as submitted, sum(sent_back) as sent_back, sum(open_now) as open_now, sum(overdue_now) as overdue_now,
      sum(data_awaited) as data_awaited
    from (
      select emp,
        count(*) filter (where created_on between v_from and v_to) as created,
        count(*) filter (where status = 'filed_done' and filed_on between v_from and v_to) as filed,
        sum(extract(epoch from (completion_date - created_at)) / 86400.0) filter (where status = 'filed_done' and filed_on between v_from and v_to) as file_days,
        count(*) filter (where status = 'filed_done' and filed_on between v_from and v_to and completion_date >= created_at) as filed_with_days,
        0::bigint as submitted, 0::bigint as sent_back,
        count(*) filter (where status <> 'filed_done') as open_now,
        count(*) filter (where status <> 'filed_done' and due_date < v_today) as overdue_now,
        count(*) filter (where status = 'data_awaited') as data_awaited
      from t group by emp
      union all
      select emp, 0, 0, null, 0,
        count(*) filter (where to_status = 'under_review'),
        count(*) filter (where from_status = 'under_review' and to_status = 'in_progress'),
        0, 0, 0
      from hist group by emp
    ) x
    group by emp
  ),
  waiting as (
    select t.*,
      v_today - coalesce((
        select max((h.changed_at at time zone 'Asia/Kolkata')::date)
        from public.task_status_history h where h.task_id = t.id and h.to_status = 'data_awaited'
      ), (t.updated_at at time zone 'Asia/Kolkata')::date) as days_waiting
    from t where t.status = 'data_awaited'
  )
  select jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'today', v_today,
    'kpis', jsonb_build_object(
      'created', (select count(*) from t where created_on between v_from and v_to),
      'filed', (select count(*) from t where status = 'filed_done' and filed_on between v_from and v_to),
      'avg_days_to_file', (
        select round((avg(extract(epoch from (completion_date - created_at)) / 86400.0))::numeric, 1)
        from t where status = 'filed_done' and filed_on between v_from and v_to and completion_date >= created_at
      ),
      'submitted', (select count(*) from hist where to_status = 'under_review'),
      'sent_back', (select count(*) from hist where from_status = 'under_review' and to_status = 'in_progress'),
      'data_awaited', (select count(*) from t where status = 'data_awaited'),
      'overdue_now', (select count(*) from t where status <> 'filed_done' and due_date < v_today)
    ),
    'by_person', coalesce((
      select jsonb_agg(jsonb_build_object(
        'employee_id', per.emp,
        'name', e.full_name,
        'designation', e.designation,
        'created', per.created,
        'filed', per.filed,
        'avg_days_to_file', case when per.filed_with_days > 0 then round((per.file_days / per.filed_with_days)::numeric, 1) end,
        'submitted', per.submitted,
        'sent_back', per.sent_back,
        'open_now', per.open_now,
        'overdue_now', per.overdue_now,
        'data_awaited', per.data_awaited
      ) order by (per.emp is null), e.full_name, per.emp)
      from per
      left join public.employees e on e.id = per.emp
      where per.created + per.filed + per.submitted + per.sent_back + per.open_now > 0
    ), '[]'::jsonb),
    'ageing', (
      select jsonb_agg(jsonb_build_object('bucket', b.bucket, 'label', b.label, 'tasks', coalesce(w.n, 0)) order by b.ord)
      from (values (1, 'd0_7', '0–7 days'), (2, 'd8_15', '8–15 days'), (3, 'd16_30', '16–30 days'), (4, 'd31_plus', 'Over 30 days')) as b(ord, bucket, label)
      left join (
        select case when days_waiting <= 7 then 'd0_7' when days_waiting <= 15 then 'd8_15' when days_waiting <= 30 then 'd16_30' else 'd31_plus' end as bucket,
               count(*) as n
        from waiting group by 1
      ) w on w.bucket = b.bucket
    ),
    'longest_waiting', coalesce((
      select jsonb_agg(jsonb_build_object(
        'task_id', w.id, 'task_number', w.task_number, 'title', w.title, 'client_id', w.client_id, 'client_name', w.client_name,
        'assignee', e.full_name, 'due_date', w.due_date, 'days_waiting', w.days_waiting
      ) order by w.days_waiting desc, w.task_number)
      from (select * from waiting order by days_waiting desc, task_number limit 25) w
      left join public.employees e on e.id = w.emp
    ), '[]'::jsonb)
  ) into v_out;
  return v_out;
end;
$$;

-- =============================================================================================
-- report_clients
-- =============================================================================================
create or replace function public.report_clients(p jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  v_from date;
  v_to date;
  v_client uuid := nullif(p ->> 'client_id', '')::uuid;
  v_owner uuid := nullif(p ->> 'owner_id', '')::uuid;
  v_service public.service_type := nullif(p ->> 'service', '')::public.service_type;
  v_months int;
  v_out jsonb;
begin
  perform public.report_require_manager();
  select r.v_from, r.v_to into v_from, v_to from public.report_period(p) r;
  v_months := least(((extract(year from v_to) - extract(year from v_from)) * 12 + extract(month from v_to) - extract(month from v_from))::int, 35);

  with c as (
    select c.*,
      (coalesce(c.onboarded_at, c.created_at) at time zone 'Asia/Kolkata')::date as joined_on
    from public.clients c
    where c.deleted_at is null
      and (v_client is null or c.id = v_client)
      and (v_owner is null or c.owner_employee_id = v_owner)
      and (v_service is null or exists (
        select 1 from public.client_services s where s.client_id = c.id and s.service_type = v_service and s.is_active
      ))
  ),
  churn as (
    select distinct on (h.client_id) h.client_id, (h.changed_at at time zone 'Asia/Kolkata')::date as changed_on, h.reason, h.changed_by
    from public.client_status_history h
    join c on c.id = h.client_id and c.status = 'inactive'
    where h.to_status = 'inactive'
    order by h.client_id, h.changed_at desc
  ),
  churned as (
    select ch.*, c.display_name, c.client_code::text as client_code, e.full_name as owner_name
    from churn ch
    join c on c.id = ch.client_id
    left join public.employees e on e.id = c.owner_employee_id
    where ch.changed_on between v_from and v_to
  ),
  months as (
    select (date_trunc('month', v_from) + make_interval(months => g))::date as month_start
    from generate_series(0, v_months) g
  )
  select jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'kpis', jsonb_build_object(
      'total', (select count(*) from c),
      'active', (select count(*) from c where status = 'active'),
      'pending', (select count(*) from c where status = 'pending'),
      'new', (select count(*) from c where joined_on between v_from and v_to),
      'churned', (select count(*) from churned)
    ),
    'by_status', (
      select jsonb_agg(jsonb_build_object('status', s.status, 'clients', (select count(*) from c where c.status = s.status)) order by s.ord)
      from (values (1, 'active'::public.client_status), (2, 'pending'), (3, 'on_hold'), (4, 'inactive')) as s(ord, status)
    ),
    'by_entity', coalesce((
      select jsonb_agg(jsonb_build_object('entity_type', x.entity_type, 'clients', x.n, 'active', x.active) order by x.n desc, x.entity_type nulls last)
      from (select entity_type, count(*) as n, count(*) filter (where status = 'active') as active from c group by entity_type) x
    ), '[]'::jsonb),
    'by_service', coalesce((
      select jsonb_agg(jsonb_build_object('service_type', x.service_type, 'clients', x.n, 'active_clients', x.active) order by x.n desc, x.service_type)
      from (
        select s.service_type, count(distinct s.client_id) as n, count(distinct s.client_id) filter (where c.status = 'active') as active
        from public.client_services s join c on c.id = s.client_id
        where s.is_active
        group by s.service_type
      ) x
    ), '[]'::jsonb),
    'by_group', coalesce((
      select jsonb_agg(jsonb_build_object('group_id', x.group_id, 'name', x.name, 'clients', x.n, 'active', x.active) order by (x.group_id is null), x.n desc, x.name)
      from (
        select c.group_id, g.name::text as name, count(*) as n, count(*) filter (where c.status = 'active') as active
        from c left join public.client_groups g on g.id = c.group_id
        group by c.group_id, g.name
        order by (c.group_id is null), count(*) desc
        limit 25
      ) x
    ), '[]'::jsonb),
    'groups_total', (select count(distinct group_id) from c where group_id is not null),
    'new_per_month', (
      select jsonb_agg(jsonb_build_object(
        'month', to_char(m.month_start, 'YYYY-MM'),
        'clients', (select count(*) from c where c.joined_on >= greatest(m.month_start, v_from) and c.joined_on <= least((m.month_start + interval '1 month' - interval '1 day')::date, v_to))
      ) order by m.month_start)
      from months m
    ),
    'churned_total', (select count(*) from churned),
    'churned', coalesce((
      select jsonb_agg(jsonb_build_object(
        'client_id', x.client_id, 'display_name', x.display_name, 'client_code', x.client_code, 'owner_name', x.owner_name,
        'changed_on', x.changed_on, 'reason', x.reason
      ) order by x.changed_on desc, x.display_name)
      from (select * from churned order by changed_on desc, display_name limit 200) x
    ), '[]'::jsonb)
  ) into v_out;
  return v_out;
end;
$$;

-- =============================================================================================
-- report_collections
-- =============================================================================================
create or replace function public.report_collections(p jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  v_from date;
  v_to date;
  v_today date := public.today_ist();
  v_client uuid := nullif(p ->> 'client_id', '')::uuid;
  v_owner uuid := nullif(p ->> 'owner_id', '')::uuid;
  v_service public.service_type := nullif(p ->> 'service', '')::public.service_type;
  v_out jsonb;
begin
  perform public.report_require_manager();
  select r.v_from, r.v_to into v_from, v_to from public.report_period(p) r;

  with issued as (
    select i.*, c.display_name as client_name, c.client_code::text as client_code
    from public.invoices i
    join public.clients c on c.id = i.client_id and c.deleted_at is null
    where i.deleted_at is null
      and i.invoice_number is not null
      and i.status not in ('draft', 'awaiting_approval')
      and (v_client is null or i.client_id = v_client)
      and (v_owner is null or c.owner_employee_id = v_owner)
      and (v_service is null or i.service_type = v_service)
  ),
  recv as (
    select i.*,
      (i.status in ('sent', 'partially_paid') and i.due_date < v_today) as is_overdue,
      greatest(v_today - i.issue_date, 0) as age_days
    from issued i
    where i.cancelled_at is null
      and i.status in ('sent', 'partially_paid', 'disputed')
      and i.outstanding_amount > 0
  ),
  live_receipts as (
    select r.invoice_id, r.payment_date, r.amount_received, r.tds_amount
    from public.payment_receipts r
    where r.reversed_at is null
  ),
  opening as (
    select coalesce(sum(greatest(
      i.total_amount
        - coalesce((select sum(r.amount_received + r.tds_amount) from live_receipts r where r.invoice_id = i.id and r.payment_date < v_from), 0)
        - coalesce((select sum(n.total_amount) from public.credit_notes n where n.invoice_id = i.id and n.issue_date < v_from), 0)
        - case when i.waived_at is not null and (i.waived_at at time zone 'Asia/Kolkata')::date < v_from then coalesce(i.waived_amount, 0) else 0 end,
      0)), 0) as amount
    from issued i
    where i.issue_date < v_from
      and i.cancelled_at is null
  ),
  promises as (
    select f.*
    from public.collection_forecast f
    join issued i on i.id = f.invoice_id
    where f.promised_payment_date between v_from and v_to
  ),
  debtors as (
    select r.client_id, max(r.client_name) as client_name, max(r.client_code) as client_code,
      sum(r.outstanding_amount) as outstanding,
      coalesce(sum(r.outstanding_amount) filter (where r.is_overdue), 0) as overdue,
      count(*) as invoices,
      min(r.issue_date) as oldest_issue_date
    from recv r
    group by r.client_id
  )
  select jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'today', v_today,
    'receivables', (
      select jsonb_build_object(
        'outstanding', coalesce(sum(outstanding_amount), 0)::text,
        'count', count(*),
        'overdue', coalesce(sum(outstanding_amount) filter (where is_overdue), 0)::text,
        'overdue_count', count(*) filter (where is_overdue),
        'disputed', coalesce(sum(outstanding_amount) filter (where status = 'disputed'), 0)::text,
        'disputed_count', count(*) filter (where status = 'disputed'),
        'clients', count(distinct client_id)
      ) from recv
    ),
    'ageing', (
      select jsonb_agg(jsonb_build_object('bucket', b.bucket, 'count', coalesce(a.n, 0), 'amount', coalesce(a.amount, 0)::text) order by b.ord)
      from (values (1, 'd0_30'), (2, 'd31_60'), (3, 'd61_90'), (4, 'd90_plus')) as b(ord, bucket)
      left join (
        select case when age_days <= 30 then 'd0_30' when age_days <= 60 then 'd31_60' when age_days <= 90 then 'd61_90' else 'd90_plus' end as bucket,
               count(*) as n, sum(outstanding_amount) as amount
        from recv group by 1
      ) a on a.bucket = b.bucket
    ),
    'collection', jsonb_build_object(
      'opening', (select amount from opening)::text,
      'billed', (select coalesce(sum(total_amount), 0) from issued where issue_date between v_from and v_to and cancelled_at is null)::text,
      'credited', (
        select coalesce(sum(n.total_amount), 0) from public.credit_notes n join issued i on i.id = n.invoice_id
        where n.issue_date between v_from and v_to
      )::text,
      'written_off', (
        select coalesce(sum(i.waived_amount), 0) from issued i
        where i.waived_at is not null and (i.waived_at at time zone 'Asia/Kolkata')::date between v_from and v_to
      )::text,
      'collected', (
        select coalesce(sum(r.amount_received + r.tds_amount), 0) from live_receipts r join issued i on i.id = r.invoice_id
        where r.payment_date between v_from and v_to
      )::text,
      'tds', (
        select coalesce(sum(r.tds_amount), 0) from live_receipts r join issued i on i.id = r.invoice_id
        where r.payment_date between v_from and v_to
      )::text
    ),
    'promises', jsonb_build_object(
      'count', (select count(*) from promises),
      'promised', (select coalesce(sum(promised_amount), 0) from promises)::text,
      'received', (select coalesce(sum(settled_since_promise), 0) from promises)::text,
      'kept', (select count(*) from promises where promise_status = 'kept'),
      'missed', (select count(*) from promises where promise_status = 'missed'),
      'open', (select count(*) from promises where promise_status = 'open'),
      'rows', coalesce((
        select jsonb_agg(jsonb_build_object(
          'invoice_id', x.invoice_id, 'invoice_number', x.invoice_number, 'client_id', x.client_id, 'client_name', x.client_name,
          'promised_on', x.promised_payment_date, 'promised', x.promised_amount::text, 'received', x.settled_since_promise::text,
          'outstanding', x.outstanding_amount::text, 'status', x.promise_status
        ) order by x.promised_payment_date, x.client_name)
        from (select * from promises order by promised_payment_date, client_name limit 200) x
      ), '[]'::jsonb)
    ),
    'debtors_total', (select count(*) from debtors),
    'debtors', coalesce((
      select jsonb_agg(jsonb_build_object(
        'client_id', d.client_id, 'client_name', d.client_name, 'client_code', d.client_code,
        'outstanding', d.outstanding::text, 'overdue', d.overdue::text, 'invoices', d.invoices, 'oldest_issue_date', d.oldest_issue_date
      ) order by d.outstanding desc, d.client_name)
      from (select * from debtors order by outstanding desc, client_name limit 25) d
    ), '[]'::jsonb)
  ) into v_out;
  return v_out;
end;
$$;

-- =============================================================================================
-- report_people
-- =============================================================================================
create or replace function public.report_people(p jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  v_from date;
  v_to date;
  v_client uuid := nullif(p ->> 'client_id', '')::uuid;
  v_service public.service_type := nullif(p ->> 'service', '')::public.service_type;
  v_employee uuid := nullif(p ->> 'employee_id', '')::uuid;
  v_weekdays smallint[];
  v_out jsonb;
begin
  perform public.report_require_manager();
  select r.v_from, r.v_to into v_from, v_to from public.report_period(p) r;
  select coalesce(fs.working_weekdays, '{1,2,3,4,5,6}') into v_weekdays from public.firm_settings fs where fs.id = 1;
  v_weekdays := coalesce(v_weekdays, '{1,2,3,4,5,6}');

  with time_rows as (
    select te.employee_id, sum(te.minutes) as minutes, coalesce(sum(te.minutes) filter (where te.billable), 0) as billable
    from public.time_entries te
    left join public.tasks t on t.id = te.task_id
    where te.ended_at is not null
      and (te.started_at at time zone 'Asia/Kolkata')::date between v_from and v_to
      and (v_client is null or te.client_id = v_client)
      and (v_service is null or t.service_type = v_service)
    group by te.employee_id
  ),
  att as (
    select a.employee_id,
      count(*) filter (where a.status = 'present') as present,
      count(*) filter (where a.status = 'late_login') as late_login,
      count(*) filter (where a.status = 'half_day') as half_day,
      count(*) filter (where a.status = 'absent') as absent,
      count(*) filter (where a.status = 'on_leave') as on_leave
    from public.attendance_records a
    where a.date between v_from and v_to
    group by a.employee_id
  ),
  leave_days as (
    select l.employee_id, l.type,
      sum(case when l.half_day then 0.5 else 1 end) as days
    from public.employee_leave l
    cross join lateral generate_series(greatest(l.start_date, v_from), least(l.end_date, v_to), interval '1 day') d
    where l.status = 'approved'
      and l.start_date <= v_to and l.end_date >= v_from
      and extract(isodow from d)::smallint = any (v_weekdays)
      and not exists (select 1 from public.holidays h where h.date = d::date)
    group by l.employee_id, l.type
  ),
  leave_by as (
    select employee_id,
      coalesce(sum(days) filter (where type = 'annual'), 0) as annual,
      coalesce(sum(days) filter (where type = 'sick'), 0) as sick,
      coalesce(sum(days) filter (where type = 'casual'), 0) as casual,
      coalesce(sum(days) filter (where type not in ('annual', 'sick', 'casual')), 0) as other,
      coalesce(sum(days), 0) as total
    from leave_days group by employee_id
  ),
  people as (
    select e.id, e.full_name, e.designation, e.staff_role, e.is_active
    from public.employees e
    where e.deleted_at is null
      and e.staff_role in ('partner', 'manager', 'employee')
      and (v_employee is null or e.id = v_employee)
      and (e.is_active or exists (select 1 from time_rows tr where tr.employee_id = e.id) or exists (select 1 from att where att.employee_id = e.id))
  )
  select jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'kpis', jsonb_build_object(
      'people', (select count(*) from people),
      'minutes', (select coalesce(sum(tr.minutes), 0) from time_rows tr join people pp on pp.id = tr.employee_id),
      'billable', (select coalesce(sum(tr.billable), 0) from time_rows tr join people pp on pp.id = tr.employee_id),
      'absent', (select coalesce(sum(a.absent), 0) from att a join people pp on pp.id = a.employee_id),
      'leave_days', (select coalesce(sum(l.total), 0) from leave_by l join people pp on pp.id = l.employee_id)
    ),
    'by_person', coalesce((
      select jsonb_agg(jsonb_build_object(
        'employee_id', pp.id, 'name', pp.full_name, 'designation', pp.designation, 'role', pp.staff_role, 'is_active', pp.is_active,
        'minutes', coalesce(tr.minutes, 0), 'billable', coalesce(tr.billable, 0),
        'present', coalesce(a.present, 0), 'late_login', coalesce(a.late_login, 0), 'half_day', coalesce(a.half_day, 0),
        'absent', coalesce(a.absent, 0), 'on_leave', coalesce(a.on_leave, 0),
        'leave_annual', coalesce(l.annual, 0), 'leave_sick', coalesce(l.sick, 0), 'leave_casual', coalesce(l.casual, 0),
        'leave_other', coalesce(l.other, 0), 'leave_total', coalesce(l.total, 0)
      ) order by pp.full_name, pp.id)
      from people pp
      left join time_rows tr on tr.employee_id = pp.id
      left join att a on a.employee_id = pp.id
      left join leave_by l on l.employee_id = pp.id
    ), '[]'::jsonb)
  ) into v_out;
  return v_out;
end;
$$;

-- =============================================================================================
-- report_pipeline
-- =============================================================================================
create or replace function public.report_pipeline(p jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  v_from date;
  v_to date;
  v_today date := public.today_ist();
  v_ts_from timestamptz;
  v_ts_to timestamptz;
  v_client uuid := nullif(p ->> 'client_id', '')::uuid;
  v_owner uuid := nullif(p ->> 'owner_id', '')::uuid;
  v_service public.service_type := nullif(p ->> 'service', '')::public.service_type;
  v_employee uuid := nullif(p ->> 'employee_id', '')::uuid;
  v_author uuid;
  v_out jsonb;
begin
  perform public.report_require_manager();
  select r.v_from, r.v_to into v_from, v_to from public.report_period(p) r;
  v_ts_from := v_from::timestamp at time zone 'Asia/Kolkata';
  v_ts_to := (v_to + 1)::timestamp at time zone 'Asia/Kolkata';
  if v_employee is not null then
    select e.profile_id into v_author from public.employees e where e.id = v_employee;
  end if;

  with l as (
    select l.*
    from public.leads l
    where l.deleted_at is null
      and (v_owner is null or l.assigned_to = v_owner)
      and (v_employee is null or l.assigned_to = v_employee)
      and (v_service is null or v_service = any (l.services_required))
      and (v_client is null or l.converted_client_id = v_client)
  ),
  created as (
    select * from l where l.created_at >= v_ts_from and l.created_at < v_ts_to
  ),
  closed as (
    select * from l where l.closed_at >= v_ts_from and l.closed_at < v_ts_to and l.status in ('won', 'lost')
  ),
  q as (
    select q.*
    from public.quotations q
    where q.deleted_at is null
      and (v_client is null or q.client_id = v_client)
      and (v_employee is null or q.created_by = v_author)
      and (v_owner is null or exists (select 1 from public.leads ld where ld.id = q.lead_id and ld.assigned_to = v_owner))
      and (v_service is null or exists (select 1 from public.quotation_items qi where qi.quotation_id = q.id and qi.service_type = v_service))
  ),
  q_sent as (select * from q where q.sent_at >= v_ts_from and q.sent_at < v_ts_to),
  q_acc as (select * from q where q.status = 'accepted' and q.responded_at >= v_ts_from and q.responded_at < v_ts_to),
  q_rej as (select * from q where q.status = 'rejected' and q.responded_at >= v_ts_from and q.responded_at < v_ts_to),
  q_exp as (select * from q where q.status = 'expired' and q.expired_at >= v_ts_from and q.expired_at < v_ts_to),
  authors as (
    select a.created_by,
      count(*) filter (where a.kind = 'sent') as sent,
      count(*) filter (where a.kind = 'accepted') as accepted,
      count(*) filter (where a.kind = 'rejected') as rejected,
      count(*) filter (where a.kind = 'expired') as expired,
      coalesce(sum(a.subtotal) filter (where a.kind = 'accepted'), 0) as accepted_value
    from (
      select created_by, 'sent' as kind, subtotal from q_sent
      union all select created_by, 'accepted', subtotal from q_acc
      union all select created_by, 'rejected', subtotal from q_rej
      union all select created_by, 'expired', subtotal from q_exp
    ) a
    group by a.created_by
  )
  select jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'kpis', jsonb_build_object(
      'leads_created', (select count(*) from created),
      'won', (select count(*) from closed where status = 'won'),
      'lost', (select count(*) from closed where status = 'lost'),
      'quotations_sent', (select count(*) from q_sent),
      'accepted', (select count(*) from q_acc),
      'rejected', (select count(*) from q_rej),
      'expired', (select count(*) from q_exp),
      'sent_value', (select coalesce(sum(subtotal), 0) from q_sent)::text,
      'accepted_value', (select coalesce(sum(subtotal), 0) from q_acc)::text,
      'rejected_value', (select coalesce(sum(subtotal), 0) from q_rej)::text,
      'expired_value', (select coalesce(sum(subtotal), 0) from q_exp)::text,
      'avg_deal_value', (select round(avg(subtotal), 2) from q_acc)::text,
      'open_quotations', (select count(*) from q where status in ('pending_approval', 'approved', 'sent', 'viewed') and valid_until >= v_today),
      'open_value', (select coalesce(sum(subtotal), 0) from q where status in ('pending_approval', 'approved', 'sent', 'viewed') and valid_until >= v_today)::text,
      'avg_days_to_win', (
        select round((avg(extract(epoch from (closed_at - created_at)) / 86400.0))::numeric, 1) from closed where status = 'won'
      )
    ),
    'by_source', coalesce((
      select jsonb_agg(jsonb_build_object(
        'source', s.source, 'leads', s.leads, 'won', s.won, 'lost', s.lost, 'open', s.open, 'estimated_value', s.estimated_value::text
      ) order by s.leads desc, s.source)
      from (
        select x.source,
          count(*) filter (where x.kind = 'created') as leads,
          count(*) filter (where x.kind = 'closed' and x.status = 'won') as won,
          count(*) filter (where x.kind = 'closed' and x.status = 'lost') as lost,
          count(*) filter (where x.kind = 'created' and x.status not in ('won', 'lost')) as open,
          coalesce(sum(x.estimated_value) filter (where x.kind = 'created'), 0) as estimated_value
        from (
          select source, status, estimated_value, 'created' as kind from created
          union all
          select source, status, estimated_value, 'closed' from closed
        ) x
        group by x.source
      ) s
    ), '[]'::jsonb),
    'by_stage', coalesce((
      select jsonb_agg(jsonb_build_object('status', s.status, 'leads', s.n, 'estimated_value', s.v::text) order by array_position(
        array['new_lead', 'contacted', 'quotation_requested', 'follow_up_required', 'client_will_revert', 'proposal_sent', 'negotiation', 'won', 'lost']::public.lead_status[], s.status))
      from (select status, count(*) as n, coalesce(sum(estimated_value), 0) as v from created group by status) s
    ), '[]'::jsonb),
    'by_author', coalesce((
      select jsonb_agg(jsonb_build_object(
        'profile_id', a.created_by, 'name', pr.full_name, 'sent', a.sent, 'accepted', a.accepted, 'rejected', a.rejected,
        'expired', a.expired, 'accepted_value', a.accepted_value::text
      ) order by a.accepted_value desc, pr.full_name nulls last)
      from authors a
      left join public.profiles pr on pr.id = a.created_by
    ), '[]'::jsonb)
  ) into v_out;
  return v_out;
end;
$$;

-- =============================================================================================
-- report_practice
-- =============================================================================================
create or replace function public.report_practice(p jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  v_from date;
  v_to date;
  v_today date := public.today_ist();
  v_fy text;
  v_client uuid := nullif(p ->> 'client_id', '')::uuid;
  v_owner uuid := nullif(p ->> 'owner_id', '')::uuid;
  v_service public.service_type := nullif(p ->> 'service', '')::public.service_type;
  v_employee uuid := nullif(p ->> 'employee_id', '')::uuid;
  v_signer uuid;
  v_offset int := least(greatest(coalesce((p ->> 'offset')::int, 0), 0), 1000000);
  v_limit int := least(greatest(coalesce((p ->> 'limit')::int, 25), 1), 20000);
  v_horizon int := 90;
  v_out jsonb;
begin
  perform public.report_require_manager();
  select r.v_from, r.v_to into v_from, v_to from public.report_period(p) r;
  v_fy := coalesce(nullif(p ->> 'fy', ''), public.financial_year_label(v_to));
  if not coalesce(public.is_fy_label(v_fy), false) then
    raise exception 'USER: Choose a financial year such as 2026-27.' using errcode = 'P0001';
  end if;
  if v_employee is not null then
    select e.profile_id into v_signer from public.employees e where e.id = v_employee;
  end if;

  with u as (
    select
      u.id, u.udin::text as udin, u.client_id, c.display_name as client_name, u.document_type, u.report_form, u.document_date,
      u.signed_on, u.generated_on, u.is_revised, u.counts_towards_tax_audit_ceiling as counts,
      u.signing_partner_id, pr.full_name as signed_by,
      (u.generated_on - u.signed_on) as days_to_generate,
      coalesce(public.jsonb_to_numeric(public.statutory_param_value('udin.generation_days', u.signed_on)), 60)::int as allowed_days
    from public.udin_records u
    left join public.clients c on c.id = u.client_id
    left join public.profiles pr on pr.id = u.signing_partner_id
    where u.signed_on between v_from and v_to
      and (c.id is null or c.deleted_at is null)
      and (v_client is null or u.client_id = v_client)
      and (v_owner is null or c.owner_employee_id = v_owner)
      and (v_employee is null or u.signing_partner_id = v_signer)
  ),
  exp as (
    select 'dsc' as kind, d.id, d.client_id, c.display_name as client_name, 'DSC'::text as label, d.holder_name as detail, d.expiry_date
    from public.dsc_records d
    join public.clients c on c.id = d.client_id and c.deleted_at is null
    where d.status = 'active' and d.expiry_date <= v_today + v_horizon
      and (v_client is null or d.client_id = v_client)
      and (v_owner is null or c.owner_employee_id = v_owner)
    union all
    select 'registration', r.id, r.client_id, c.display_name, r.registration_type, r.registration_number, r.expiry_date
    from public.statutory_registrations r
    join public.clients c on c.id = r.client_id and c.deleted_at is null
    where r.status = 'active' and r.expiry_date is not null and r.expiry_date <= v_today + v_horizon
      and (v_client is null or r.client_id = v_client)
      and (v_owner is null or c.owner_employee_id = v_owner)
  ),
  covered as (
    select c.id as client_id, c.display_name, c.client_code::text as client_code, e.full_name as owner_name,
      (
        select l.status from public.engagement_letters l
        where l.client_id = c.id and l.financial_year = v_fy
        order by array_position(array['signed', 'issued', 'draft', 'declined', 'expired']::public.engagement_status[], l.status), l.updated_at desc
        limit 1
      ) as letter_status
    from public.clients c
    left join public.employees e on e.id = c.owner_employee_id
    where c.deleted_at is null
      and c.status = 'active'
      and exists (
        select 1 from public.client_services s where s.client_id = c.id and s.is_active and (v_service is null or s.service_type = v_service)
      )
      and (v_client is null or c.id = v_client)
      and (v_owner is null or c.owner_employee_id = v_owner)
  )
  select jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'today', v_today,
    'fy', v_fy,
    'udin', jsonb_build_object(
      'total', (select count(*) from u),
      'late', (select count(*) from u where days_to_generate > allowed_days),
      'counted', (select count(*) from u where counts and not is_revised),
      'rows', coalesce((
        select jsonb_agg(to_jsonb(x) - 'signing_partner_id' order by x.signed_on desc, x.udin)
        from (select * from u order by signed_on desc, udin offset v_offset limit v_limit) x
      ), '[]'::jsonb)
    ),
    'ceiling', coalesce((
      select jsonb_agg(jsonb_build_object(
        'member_profile_id', m.id, 'name', m.full_name, 'membership_no', m.icai_membership_no,
        'signed_in_firm', coalesce(v.signed_in_firm, 0), 'signed_elsewhere', coalesce(v.signed_elsewhere, 0),
        'total', coalesce(v.total_count, 0),
        'ceiling', coalesce(v.ceiling, public.jsonb_to_numeric(public.statutory_param_value('audit.tax_audit_ceiling', public.fy_start_date(v_fy)))::int),
        'warning', v.warning
      ) order by coalesce(v.total_count, 0) desc, m.full_name)
      from (
        select pr.id, pr.full_name, pr.icai_membership_no from public.profiles pr where pr.role = 'partner' and pr.is_active
        union
        select pr.id, pr.full_name, pr.icai_membership_no
        from public.tax_audit_ceiling_view tv join public.profiles pr on pr.id = tv.member_profile_id
        where tv.financial_year = v_fy
      ) m
      left join public.tax_audit_ceiling_view v on v.member_profile_id = m.id and v.financial_year = v_fy
      where v_employee is null or m.id = v_signer
    ), '[]'::jsonb),
    'expiries', jsonb_build_object(
      'expired', (select count(*) from exp where expiry_date < v_today),
      'next_30', (select count(*) from exp where expiry_date between v_today and v_today + 30),
      'next_90', (select count(*) from exp where expiry_date between v_today and v_today + v_horizon),
      'total', (select count(*) from exp),
      'rows', coalesce((
        select jsonb_agg(jsonb_build_object(
          'kind', x.kind, 'id', x.id, 'client_id', x.client_id, 'client_name', x.client_name, 'label', x.label, 'detail', x.detail,
          'expiry_date', x.expiry_date, 'days_left', x.expiry_date - v_today
        ) order by x.expiry_date, x.client_name)
        from (select * from exp order by expiry_date, client_name limit 200) x
      ), '[]'::jsonb)
    ),
    'letters', jsonb_build_object(
      'clients', (select count(*) from covered),
      'signed', (select count(*) from covered where letter_status = 'signed'),
      'issued', (select count(*) from covered where letter_status = 'issued'),
      'draft', (select count(*) from covered where letter_status = 'draft'),
      'declined', (select count(*) from covered where letter_status = 'declined'),
      'expired', (select count(*) from covered where letter_status = 'expired'),
      'none', (select count(*) from covered where letter_status is null),
      'missing_total', (select count(*) from covered where letter_status is null or letter_status not in ('signed', 'issued')),
      'missing', coalesce((
        select jsonb_agg(to_jsonb(x) order by x.display_name)
        from (
          select * from covered where letter_status is null or letter_status not in ('signed', 'issued')
          order by display_name limit 200
        ) x
      ), '[]'::jsonb)
    )
  ) into v_out;
  return v_out;
end;
$$;

-- =============================================================================================
-- Grants
-- =============================================================================================
revoke execute on function
  public.compliance_type_service(public.compliance_type),
  public.report_period(jsonb),
  public.report_require_manager(),
  public.report_compliance(jsonb),
  public.report_work(jsonb),
  public.report_clients(jsonb),
  public.report_collections(jsonb),
  public.report_people(jsonb),
  public.report_pipeline(jsonb),
  public.report_practice(jsonb)
from public, anon;
grant execute on function
  public.compliance_type_service(public.compliance_type),
  public.report_period(jsonb),
  public.report_require_manager(),
  public.report_compliance(jsonb),
  public.report_work(jsonb),
  public.report_clients(jsonb),
  public.report_collections(jsonb),
  public.report_people(jsonb),
  public.report_pipeline(jsonb),
  public.report_practice(jsonb)
to authenticated, service_role;
