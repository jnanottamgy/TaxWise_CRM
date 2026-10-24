-- =============================================================================================
-- 0216 Firm today (§7.2 Partner) in one round trip
-- =============================================================================================
--   dashboard_firm_today(fy, today, online_minutes, rows, at_risk_tasks, at_risk_days)
--
-- Partner only (§4.1: the payments figures are the Partner's). SECURITY INVOKER: every figure is
-- summed from rows the Partner's RLS returns. Amounts are decimal strings, so nothing is lost
-- before the app turns them into paise (lib/domain/money.ts).
--
-- One answer, one definition: receivables, overdue (Sent or Partially paid past the due date),
-- ageing (days since the invoice date: 0–30, 31–60, 61–90, 90+), collected (received + TDS, by
-- payment date) and unbilled time are worked out exactly as payments_dashboard (0163) works them
-- out, so Firm today and the Payments page never disagree (tests/db/dashboard.test.ts checks it).
--
-- Returns:
--   setup        the facts behind the setup checklist (logo, bank & UPI, ICAI FRN and each
--                Partner's membership number, email domain, firm WhatsApp numbers, team, first
--                client onboarded, first invoice issued, law & rules reviewed)
--   kpis         active clients, invoiced in the FY, collected this month (and its TDS),
--                outstanding, overdue (amount and count), filings due in 7 days, overdue tasks,
--                team online now, unbilled time
--   approvals    invoices awaiting approval, quotations pending approval, leave requests, DPDP data
--                requests (open, overdue, next due)
--   months       invoiced and collected per month of the FY (null for months not yet begun)
--   ageing       outstanding by age bucket
--   filing       this month's deadlines grouped by type, form and rule (filed, pending, overdue);
--                the app maps the groups to the filings grid's return types
--   at_risk      clients with 3+ overdue tasks or receivables over 90 days, worst first
--   pipeline     open leads, quotations out with clients and their value, quotations decided in
--                the FY (accepted, rejected, expired)
--   week         this week's deadlines (Monday to Sunday), not yet filed
--   review       the Partner's review queue

set search_path = public, extensions;

create or replace function public.dashboard_firm_today(
  p_fy text default null,
  p_today date default null,
  p_online_minutes integer default 20,
  p_rows integer default 6,
  p_at_risk_tasks integer default 3,
  p_at_risk_days integer default 90
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  v_today date := coalesce(p_today, public.today_ist());
  v_fy text := coalesce(nullif(btrim(p_fy), ''), public.financial_year_label(coalesce(p_today, public.today_ist())));
  v_fy_start date;
  v_fy_end date;
  v_fy_to date;
  v_month_start date := date_trunc('month', coalesce(p_today, public.today_ist()))::date;
  v_month_end date := (date_trunc('month', coalesce(p_today, public.today_ist())) + interval '1 month' - interval '1 day')::date;
  v_week_from date := coalesce(p_today, public.today_ist()) - (extract(isodow from coalesce(p_today, public.today_ist()))::int - 1);
  v_me uuid := public.my_employee_id();
  v_rows integer := least(greatest(coalesce(p_rows, 6), 0), 50);
  v_online integer := greatest(coalesce(p_online_minutes, 20), 1);
  v_risk_tasks integer := greatest(coalesce(p_at_risk_tasks, 3), 1);
  v_risk_days integer := greatest(coalesce(p_at_risk_days, 90), 0);
  v_settings public.firm_settings%rowtype;
  v_out jsonb;
begin
  if not coalesce(public.is_partner(), false) then
    raise exception 'USER: Firm today is for Partners.' using errcode = 'P0001';
  end if;
  if v_fy !~ '^[0-9]{4}-[0-9]{2}$' then
    raise exception 'USER: Choose a financial year like 2026-27.' using errcode = 'P0001';
  end if;
  v_fy_start := public.fy_start_date(v_fy);
  v_fy_end := public.fy_end_date(v_fy);
  v_fy_to := least(v_fy_end, v_today);

  select * into v_settings from public.firm_settings where id = 1;

  with
  issued as (
    select i.id, i.client_id, i.issue_date, i.total_amount, i.cancelled_at
    from public.invoices i
    where i.deleted_at is null
      and i.invoice_number is not null
      and i.status not in ('draft', 'awaiting_approval')
  ),
  recv as (
    select
      i.id, i.client_id, i.issue_date, i.due_date, i.status, i.outstanding_amount,
      (i.status in ('sent', 'partially_paid') and i.due_date < v_today) as is_overdue,
      greatest(v_today - i.issue_date, 0) as age_days
    from public.invoices i
    where i.deleted_at is null
      and i.cancelled_at is null
      and i.status in ('sent', 'partially_paid', 'disputed')
      and i.outstanding_amount > 0
  ),
  live_receipts as (
    select r.payment_date, r.amount_received, r.tds_amount
    from public.payment_receipts r
    join issued i on i.id = r.invoice_id
    where r.reversed_at is null
  ),
  months as (
    select (v_fy_start + make_interval(months => g))::date as month_start
    from generate_series(0, 11) g
  ),
  overdue_tasks as (
    select t.client_id
    from public.tasks t
    where t.deleted_at is null
      and t.status <> 'filed_done'
      and t.due_date < v_today
  ),
  month_events as (
    select e.type, e.form_code, e.rule_code, e.status, e.due_date
    from public.compliance_events e
    left join public.clients c on c.id = e.client_id
    where e.status <> 'cancelled'
      and e.due_date between v_month_start and v_month_end
      and (e.client_id is null or c.deleted_at is null)
  ),
  risk as (
    select
      c.id as client_id,
      c.display_name as client_name,
      c.client_code::text as client_code,
      coalesce(od.n, 0) as overdue_tasks,
      coalesce(aged.amount, 0) as receivables_old
    from public.clients c
    left join (select client_id, count(*) as n from overdue_tasks group by client_id) od on od.client_id = c.id
    left join (select client_id, sum(outstanding_amount) as amount from recv where age_days > v_risk_days group by client_id) aged on aged.client_id = c.id
    where c.deleted_at is null
      and (coalesce(od.n, 0) >= v_risk_tasks or coalesce(aged.amount, 0) > 0)
  ),
  open_requests as (
    select r.due_by, r.is_overdue
    from public.data_requests_view r
    where r.is_open
  )
  select jsonb_build_object(
    'today', v_today,
    'financial_year', v_fy,
    'fy_start', v_fy_start,
    'fy_end', v_fy_end,
    'month_start', v_month_start,
    'month_end', v_month_end,

    'setup', jsonb_build_object(
      'has_logo', coalesce(btrim(v_settings.logo_path), '') <> '',
      'has_bank', coalesce(btrim(v_settings.bank_account_number), '') <> '' and coalesce(btrim(v_settings.bank_ifsc), '') <> '',
      'has_upi', coalesce(btrim(v_settings.upi_id), '') <> '',
      'has_frn', coalesce(btrim(v_settings.icai_frn), '') <> '',
      'domain_status', coalesce(v_settings.domain_status, 'not_started'),
      'law_reviewed_at', v_settings.law_last_reviewed_at,
      'partners', (select count(*) from public.profiles p where p.role = 'partner' and p.is_active),
      'partners_missing_membership', coalesce((
        select jsonb_agg(jsonb_build_object('profile_id', p.id, 'employee_id', e.id, 'name', p.full_name) order by p.full_name)
        from public.profiles p
        left join public.employees e on e.profile_id = p.id and e.deleted_at is null
        where p.role = 'partner' and p.is_active and coalesce(btrim(p.icai_membership_no), '') = ''
      ), '[]'::jsonb),
      'whatsapp_numbers', (select count(*) from public.firm_whatsapp_numbers n where n.is_active and n.number is not null),
      'whatsapp_slots', (select count(*) from public.firm_whatsapp_numbers n),
      'team_members', (select count(*) from public.employees e where e.deleted_at is null and e.is_active),
      'clients_onboarded', (select count(*) from public.clients c where c.deleted_at is null and c.onboarded_at is not null),
      'invoices_issued', (select count(*) from issued)
    ),

    'kpis', jsonb_build_object(
      'active_clients', (select count(*) from public.clients c where c.deleted_at is null and c.status = 'active'),
      'invoiced_fy', (select coalesce(sum(i.total_amount), 0) from issued i where i.cancelled_at is null and i.issue_date between v_fy_start and v_fy_to)::text,
      'invoiced_fy_count', (select count(*) from issued i where i.cancelled_at is null and i.issue_date between v_fy_start and v_fy_to),
      'collected_month', (select coalesce(sum(r.amount_received + r.tds_amount), 0) from live_receipts r where r.payment_date between v_month_start and v_today)::text,
      'tds_month', (select coalesce(sum(r.tds_amount), 0) from live_receipts r where r.payment_date between v_month_start and v_today)::text,
      'outstanding', (select coalesce(sum(outstanding_amount), 0) from recv)::text,
      'outstanding_count', (select count(*) from recv),
      'overdue', (select coalesce(sum(outstanding_amount) filter (where is_overdue), 0) from recv)::text,
      'overdue_count', (select count(*) filter (where is_overdue) from recv),
      'filings_due_7', (
        select count(*)
        from public.compliance_events e
        left join public.clients c on c.id = e.client_id
        where e.status = 'pending'
          and e.due_date between v_today and v_today + 7
          and (e.client_id is null or c.deleted_at is null)
      ),
      'overdue_tasks', (select count(*) from overdue_tasks),
      'online_now', (
        select count(*)
        from public.people_overview po
        where po.login_status <> 'disabled'
          and po.open_session_active_at > now() - make_interval(mins => v_online)
      ),
      'with_login', (select count(*) from public.people_overview po where po.login_status = 'active'),
      'unbilled', (select coalesce(sum(u.amount), 0) from public.unbilled_time_by_client u)::text,
      'unbilled_minutes', (select coalesce(sum(u.minutes), 0) from public.unbilled_time_by_client u),
      'unbilled_clients', (select count(*) from public.unbilled_time_by_client u)
    ),

    'approvals', jsonb_build_object(
      'invoices', (select count(*) from public.invoices i where i.deleted_at is null and i.status = 'awaiting_approval'),
      'invoices_value', (select coalesce(sum(i.total_amount), 0) from public.invoices i where i.deleted_at is null and i.status = 'awaiting_approval')::text,
      'quotations', (select count(*) from public.quotations q where q.deleted_at is null and q.status = 'pending_approval'),
      'quotations_value', (select coalesce(sum(q.total), 0) from public.quotations q where q.deleted_at is null and q.status = 'pending_approval')::text,
      'leave', (select count(*) from public.employee_leave l where l.status = 'requested' and (v_me is null or l.employee_id <> v_me)),
      'data_requests', (select count(*) from open_requests),
      'data_requests_overdue', (select count(*) from open_requests where is_overdue),
      'data_requests_next_due', (select min(due_by) from open_requests)
    ),

    'months', (
      select jsonb_agg(jsonb_build_object(
        'month', to_char(m.month_start, 'YYYY-MM'),
        'invoiced', case when m.month_start <= v_today then (
          select coalesce(sum(i.total_amount), 0)
          from issued i
          where i.cancelled_at is null
            and i.issue_date >= m.month_start
            and i.issue_date < (m.month_start + interval '1 month')::date
            and i.issue_date <= v_today
        )::text end,
        'collected', case when m.month_start <= v_today then (
          select coalesce(sum(r.amount_received + r.tds_amount), 0)
          from live_receipts r
          where r.payment_date >= m.month_start
            and r.payment_date < (m.month_start + interval '1 month')::date
            and r.payment_date <= v_today
        )::text end
      ) order by m.month_start)
      from months m
    ),

    'ageing', (
      select jsonb_agg(jsonb_build_object('bucket', b.bucket, 'count', coalesce(a.n, 0), 'amount', coalesce(a.amount, 0)::text) order by b.ord)
      from (values (1, '0_30'), (2, '31_60'), (3, '61_90'), (4, '90_plus')) as b(ord, bucket)
      left join (
        select
          case when age_days <= 30 then '0_30' when age_days <= 60 then '31_60' when age_days <= 90 then '61_90' else '90_plus' end as bucket,
          count(*) as n,
          sum(outstanding_amount) as amount
        from recv
        group by 1
      ) a on a.bucket = b.bucket
    ),

    'filing', coalesce((
      select jsonb_agg(jsonb_build_object(
        'type', g.type, 'form_code', g.form_code, 'rule_code', g.rule_code,
        'filed', g.filed, 'pending', g.pending, 'overdue', g.overdue
      ) order by g.type, g.form_code nulls first, g.rule_code nulls first)
      from (
        select
          me.type::text as type, me.form_code, me.rule_code,
          count(*) filter (where me.status = 'completed') as filed,
          count(*) filter (where me.status = 'pending' and me.due_date >= v_today) as pending,
          count(*) filter (where me.status = 'pending' and me.due_date < v_today) as overdue
        from month_events me
        group by 1, 2, 3
      ) g
    ), '[]'::jsonb),

    'at_risk', jsonb_build_object(
      'total', (select count(*) from risk),
      'rows', coalesce((
        select jsonb_agg(jsonb_build_object(
          'client_id', x.client_id, 'client_name', x.client_name, 'client_code', x.client_code,
          'overdue_tasks', x.overdue_tasks, 'receivables_old', x.receivables_old::text
        ) order by x.ord)
        from (
          select r.*, row_number() over (
            order by ((r.overdue_tasks >= v_risk_tasks)::int + (r.receivables_old > 0)::int) desc,
                     r.overdue_tasks desc, r.receivables_old desc, r.client_name
          ) as ord
          from risk r
        ) x
        where x.ord <= v_rows
      ), '[]'::jsonb)
    ),

    'pipeline', jsonb_build_object(
      'open_leads', (select count(*) from public.leads l where l.deleted_at is null and l.status not in ('won', 'lost')),
      'quotations_sent', (select count(*) from public.quotations q where q.deleted_at is null and q.status in ('sent', 'viewed')),
      'quotations_sent_value', (select coalesce(sum(q.total), 0) from public.quotations q where q.deleted_at is null and q.status in ('sent', 'viewed'))::text,
      'accepted', (select count(*) from public.quotations q where q.deleted_at is null and q.status = 'accepted' and q.issue_date between v_fy_start and v_fy_end),
      'rejected', (select count(*) from public.quotations q where q.deleted_at is null and q.status = 'rejected' and q.issue_date between v_fy_start and v_fy_end),
      'expired', (select count(*) from public.quotations q where q.deleted_at is null and q.status = 'expired' and q.issue_date between v_fy_start and v_fy_end)
    ),

    'week', public.dashboard_deadlines(v_week_from, v_week_from + 6, v_rows, null, true, false),
    'review', public.dashboard_review_queue(least(v_rows, 5))
  )
  into v_out;

  return v_out;
end;
$$;

comment on function public.dashboard_firm_today(text, date, integer, integer, integer, integer) is
  'Firm today (§7.2 Partner) in one call: setup checklist facts, KPIs, approvals, invoiced and collected by month, receivables ageing, filing status this month, at-risk clients, the pipeline, this week''s deadlines and the review queue. Partner only; SECURITY INVOKER.';

revoke execute on function public.dashboard_firm_today(text, date, integer, integer, integer, integer) from public, anon;
grant execute on function public.dashboard_firm_today(text, date, integer, integer, integer, integer) to authenticated, service_role;
