-- 0127 · Filings grid and coverage reads (§7.7, §4.1, §2.3).
--
-- filings_grid(...): rows = clients, columns = periods. One call returns, for a financial year and a
--   return type (compliance types + an optional form-code / rule-code pattern):
--     total     clients with at least one matching deadline (after the owner / search / status filters);
--     clients   one page of them (sorted by name), with the owner's name;
--     events    their matching deadlines (not cancelled), with whether a filing record is linked;
--     summary   every matching deadline of every client (narrow columns) for the column counts
--               ("38 of 42 filed"), so the answer covers the whole firm, not just the page.
--   Partners and Managers only (§4.1: Employees get the calendar of their own clients). SECURITY
--   INVOKER: RLS applies to every row it reads.
--
-- compliance_coverage(p_client_ids): per client and return (type, form, rule), the last upcoming
--   statutory due date and how many are planned, for the coverage-gaps report (§7.7). Cancelled
--   deadlines and internal prep steps don't count as cover. Under the caller's RLS.

set search_path = public, extensions;

create or replace function public.filings_grid(
  p_financial_year text,
  p_types public.compliance_type[],
  p_form_pattern text default null,
  p_rule_pattern text default null,
  p_owner uuid default null,
  p_unassigned boolean default false,
  p_q text default null,
  p_status text default null,
  p_limit int default 25,
  p_offset int default 0
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  v_today date := public.today_ist();
  v_q text := nullif(btrim(coalesce(p_q, '')), '');
  v_like text;
  v_limit int := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_total int;
  v_clients jsonb;
  v_events jsonb;
  v_summary jsonb;
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: The filings grid is for Partners and Managers. Your clients'' deadlines are on the calendar.' using errcode = 'P0001';
  end if;
  if p_financial_year is null or not public.is_fy_label(p_financial_year) then
    raise exception 'USER: Choose a financial year.' using errcode = 'P0001';
  end if;
  if p_types is null or cardinality(p_types) = 0 then
    raise exception 'USER: Choose a return type.' using errcode = 'P0001';
  end if;
  if p_status is not null and p_status not in ('overdue', 'unfiled') then
    raise exception 'USER: Unknown status filter.' using errcode = 'P0001';
  end if;
  if v_q is not null then
    v_like := '%' || replace(replace(replace(left(v_q, 100), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  with ev as (
    select e.id, e.client_id, e.type, e.form_code, e.title, e.filing_period, e.period_start, e.period_end,
           e.due_date, e.status, e.workflow_status, e.is_statutory, e.rule_code, e.original_due_date,
           e.override_id, e.task_id, e.updated_at
      from public.compliance_events e
      join public.clients c on c.id = e.client_id and c.deleted_at is null
     where e.financial_year = p_financial_year
       and e.status <> 'cancelled'
       and e.type = any (p_types)
       and (
         (p_form_pattern is null and p_rule_pattern is null)
         or (p_form_pattern is not null and coalesce(e.form_code, '') ~* p_form_pattern)
         or (p_rule_pattern is not null and coalesce(e.rule_code, '') ~* p_rule_pattern)
       )
  ),
  owned as (
    select c.id, c.display_name, c.client_code, c.owner_employee_id, c.state_code, c.gst_scheme, c.status, c.legal_name, c.gstin
      from public.clients c
     where c.deleted_at is null
       and exists (select 1 from ev f where f.client_id = c.id)
       and (p_owner is null or c.owner_employee_id = p_owner)
       and (not coalesce(p_unassigned, false) or c.owner_employee_id is null)
  ),
  matching as (
    select o.*
      from owned o
     where (v_like is null or o.display_name ilike v_like or o.client_code::text ilike v_like
            or coalesce(o.legal_name, '') ilike v_like or coalesce(o.gstin::text, '') ilike v_like)
       and (
         p_status is null
         or (p_status = 'overdue' and exists (
               select 1 from ev f where f.client_id = o.id and f.status = 'pending'
                 and f.workflow_status not in ('filed', 'completed') and f.due_date < v_today))
         or (p_status = 'unfiled' and exists (
               select 1 from ev f where f.client_id = o.id and f.status = 'pending'
                 and f.workflow_status not in ('filed', 'completed')))
       )
  ),
  page as (
    select m.* from matching m order by lower(m.display_name), m.client_code limit v_limit offset v_offset
  )
  select
    (select count(*)::int from matching),
    coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'display_name', p.display_name, 'client_code', p.client_code,
               'owner_employee_id', p.owner_employee_id, 'owner_name', d.full_name,
               'state_code', p.state_code, 'gst_scheme', p.gst_scheme, 'status', p.status
             ) order by lower(p.display_name), p.client_code)
        from page p
        left join public.employee_directory d on d.id = p.owner_employee_id
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', f.id, 'client_id', f.client_id, 'type', f.type, 'form_code', f.form_code, 'title', f.title,
               'filing_period', f.filing_period, 'period_start', f.period_start, 'period_end', f.period_end,
               'due_date', f.due_date, 'status', f.status, 'workflow_status', f.workflow_status,
               'is_statutory', f.is_statutory, 'rule_code', f.rule_code, 'original_due_date', f.original_due_date,
               'override_id', f.override_id, 'task_id', f.task_id, 'updated_at', f.updated_at,
               'has_filing', exists (select 1 from public.filing_records fr where fr.compliance_event_id = f.id)
             ) order by f.due_date, f.form_code)
        from ev f
       where f.client_id in (select p.id from page p)
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(jsonb_build_object(
               'client_id', f.client_id, 'form_code', f.form_code, 'filing_period', f.filing_period,
               'period_start', f.period_start, 'period_end', f.period_end, 'due_date', f.due_date,
               'status', f.status, 'workflow_status', f.workflow_status
             ))
        from ev f
       where f.client_id in (select o.id from owned o)
    ), '[]'::jsonb)
    into v_total, v_clients, v_events, v_summary;

  return jsonb_build_object(
    'total', coalesce(v_total, 0),
    'today', v_today,
    'clients', v_clients,
    'events', v_events,
    'summary', v_summary
  );
end;
$$;

comment on function public.filings_grid(text, public.compliance_type[], text, text, uuid, boolean, text, text, int, int) is
  'Filings grid (§7.7): one page of clients with matching deadlines in an FY, their deadlines, and every matching deadline for the column counts. Partner/Manager; under RLS.';

revoke all on function public.filings_grid(text, public.compliance_type[], text, text, uuid, boolean, text, text, int, int) from public, anon;
grant execute on function public.filings_grid(text, public.compliance_type[], text, text, uuid, boolean, text, text, int, int) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- compliance_coverage
-- ---------------------------------------------------------------------------------------------
create or replace function public.compliance_coverage(p_client_ids uuid[] default null)
returns jsonb
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'client_id', g.client_id, 'type', g.type, 'form_code', g.form_code, 'rule_code', g.rule_code,
           'last_due', g.last_due, 'next_due', g.next_due, 'upcoming', g.upcoming
         ) order by g.client_id, g.last_due), '[]'::jsonb)
    from (
      select e.client_id, e.type, e.form_code, e.rule_code,
             max(e.due_date) as last_due, min(e.due_date) as next_due, count(*)::int as upcoming
        from public.compliance_events e
        join public.clients c on c.id = e.client_id and c.deleted_at is null
       where (public.is_staff() or not public.is_api_caller())
         and e.status <> 'cancelled'
         and e.is_statutory
         and e.source <> 'ops_template'
         and e.due_date >= public.today_ist()
         and (p_client_ids is null or e.client_id = any (p_client_ids))
       group by e.client_id, e.type, e.form_code, e.rule_code
    ) g
$$;

comment on function public.compliance_coverage(uuid[]) is
  'Per client and return, the upcoming statutory deadlines planned (last and next due, count) as a JSON list, for the coverage-gaps report (§7.7). Under RLS; the scheduled job reads every client.';

revoke all on function public.compliance_coverage(uuid[]) from public, anon;
grant execute on function public.compliance_coverage(uuid[]) to authenticated, service_role;
