-- 0128 · Calendar reads (§7.7 Calendar: month / week / agenda; §4.1; §2.3).
--
-- Statutory and firm events in one calendar, filtered by client, owner, compliance type and kind
-- (statutory or firm/internal). Everything runs under the caller's RLS (SECURITY INVOKER), so an
-- Employee sees only the deadlines of clients they own, are on the team of, or cover; firm-level
-- events (no client) only reach Partners and Managers (0037). Deadlines of clients in the recycle
-- bin are left out.
--
-- compliance_calendar_days(p_from, p_to, …): the month and week views. A firm has hundreds of
--   GSTR-3B returns on the 20th, so each day is a list of groups (one per return: form code, or the
--   step's name for internal steps) with how many there are, how many are filed and how many are
--   overdue; a group of one carries the event itself (id, title, client) so it opens directly.
--   At most 62 days at a time.
-- compliance_agenda(p_from, p_to, …, p_limit, p_offset): the agenda, one row per deadline, ordered
--   by due date, server-paginated (total included). p_overdue_only lists unfiled deadlines that are
--   already past due (the "Overdue" group above the agenda).

set search_path = public, extensions;

create or replace function public.compliance_calendar_days(
  p_from date,
  p_to date,
  p_client uuid default null,
  p_owner uuid default null,
  p_types public.compliance_type[] default null,
  p_statutory boolean default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  v_today date := public.today_ist();
  v_out jsonb;
begin
  if not public.is_staff() then
    raise exception 'USER: The calendar is for staff.' using errcode = 'P0001';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'USER: Choose the dates to show.' using errcode = 'P0001';
  end if;
  if p_to - p_from > 62 then
    raise exception 'USER: Show at most two months at a time.' using errcode = 'P0001';
  end if;

  with ev as (
    select e.id, e.due_date, e.type, e.form_code, e.title, e.is_statutory, e.client_id, e.status,
           e.workflow_status, e.override_id, e.original_due_date, c.display_name as client_name,
           coalesce(nullif(e.form_code, ''), regexp_replace(e.title, '\s+for\s+.+$', '')) as label
      from public.compliance_events e
      left join public.clients c on c.id = e.client_id
     where e.due_date between p_from and p_to
       and e.status <> 'cancelled'
       and (e.client_id is null or c.deleted_at is null)
       and (p_client is null or e.client_id = p_client)
       and (p_owner is null or c.owner_employee_id = p_owner)
       and (p_types is null or e.type = any (p_types))
       and (p_statutory is null or e.is_statutory = p_statutory)
  ),
  grouped as (
    select ev.due_date, ev.type, ev.label, ev.is_statutory,
           count(*)::int as total,
           count(*) filter (where ev.workflow_status in ('filed', 'completed'))::int as done,
           count(*) filter (where ev.status = 'pending' and ev.workflow_status not in ('filed', 'completed') and ev.due_date < v_today)::int as overdue,
           count(*) filter (where ev.override_id is not null)::int as extended,
           (array_agg(jsonb_build_object(
              'id', ev.id, 'title', ev.title, 'client_id', ev.client_id, 'client_name', ev.client_name,
              'status', ev.status, 'workflow_status', ev.workflow_status, 'original_due_date', ev.original_due_date,
              'override_ref', (select o.source_ref from public.due_date_overrides o where o.id = ev.override_id)
            ) order by ev.client_name nulls first, ev.title))[1] as sample
      from ev
     group by ev.due_date, ev.type, ev.label, ev.is_statutory
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'date', g.due_date, 'type', g.type, 'label', g.label, 'is_statutory', g.is_statutory,
           'total', g.total, 'done', g.done, 'overdue', g.overdue, 'extended', g.extended,
           'event', case when g.total = 1 then g.sample end
         ) order by g.due_date, g.is_statutory desc, g.total desc, g.label), '[]'::jsonb)
    into v_out
    from grouped g;

  return jsonb_build_object('today', v_today, 'groups', v_out);
end;
$$;

comment on function public.compliance_calendar_days(date, date, uuid, uuid, public.compliance_type[], boolean) is
  'Calendar month/week (§7.7): per day, one group per return with counts (total, filed, overdue, extended); a group of one carries its event. Under RLS; at most 62 days.';

revoke all on function public.compliance_calendar_days(date, date, uuid, uuid, public.compliance_type[], boolean) from public, anon;
grant execute on function public.compliance_calendar_days(date, date, uuid, uuid, public.compliance_type[], boolean) to authenticated;

create or replace function public.compliance_agenda(
  p_from date,
  p_to date default null,
  p_client uuid default null,
  p_owner uuid default null,
  p_types public.compliance_type[] default null,
  p_statutory boolean default null,
  p_label text default null,
  p_overdue_only boolean default false,
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
  v_limit int := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_total int;
  v_rows jsonb;
begin
  if not public.is_staff() then
    raise exception 'USER: The calendar is for staff.' using errcode = 'P0001';
  end if;
  if p_from is null and not coalesce(p_overdue_only, false) then
    raise exception 'USER: Choose the first date to show.' using errcode = 'P0001';
  end if;

  with ev as (
    select e.id, e.client_id, e.type, e.form_code, e.title, e.financial_year, e.filing_period, e.due_date,
           e.status, e.workflow_status, e.is_statutory, e.source, e.rule_code, e.original_due_date,
           e.override_id, e.task_id, e.is_provisional, e.updated_at,
           c.display_name as client_name, c.client_code, c.owner_employee_id,
           (select o.source_ref from public.due_date_overrides o where o.id = e.override_id) as override_ref,
           exists (select 1 from public.filing_records fr where fr.compliance_event_id = e.id) as has_filing
      from public.compliance_events e
      left join public.clients c on c.id = e.client_id
     where e.status <> 'cancelled'
       and (e.client_id is null or c.deleted_at is null)
       and (
         case when coalesce(p_overdue_only, false)
           then e.status = 'pending' and e.workflow_status not in ('filed', 'completed') and e.due_date < v_today
                and (p_from is null or e.due_date >= p_from)
           else e.due_date >= p_from and (p_to is null or e.due_date <= p_to)
         end
       )
       and (p_client is null or e.client_id = p_client)
       and (p_owner is null or c.owner_employee_id = p_owner)
       and (p_types is null or e.type = any (p_types))
       and (p_statutory is null or e.is_statutory = p_statutory)
       and (p_label is null or coalesce(nullif(e.form_code, ''), regexp_replace(e.title, '\s+for\s+.+$', '')) = p_label)
  ),
  page as (
    select * from ev order by due_date, client_name nulls first, title limit v_limit offset v_offset
  )
  select
    (select count(*)::int from ev),
    coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'client_id', p.client_id, 'client_name', p.client_name, 'client_code', p.client_code,
               'owner_employee_id', p.owner_employee_id, 'owner_name', d.full_name,
               'type', p.type, 'form_code', p.form_code, 'title', p.title, 'financial_year', p.financial_year,
               'filing_period', p.filing_period, 'due_date', p.due_date, 'status', p.status,
               'workflow_status', p.workflow_status, 'is_statutory', p.is_statutory, 'source', p.source,
               'rule_code', p.rule_code, 'original_due_date', p.original_due_date, 'override_id', p.override_id,
               'override_ref', p.override_ref, 'task_id', p.task_id, 'is_provisional', p.is_provisional,
               'has_filing', p.has_filing, 'updated_at', p.updated_at
             ) order by p.due_date, p.client_name nulls first, p.title)
        from page p
        left join public.employee_directory d on d.id = p.owner_employee_id
    ), '[]'::jsonb)
    into v_total, v_rows;

  return jsonb_build_object('today', v_today, 'total', coalesce(v_total, 0), 'rows', v_rows);
end;
$$;

comment on function public.compliance_agenda(date, date, uuid, uuid, public.compliance_type[], boolean, text, boolean, int, int) is
  'Calendar agenda (§7.7): one row per deadline from a date (or the unfiled overdue ones), filtered and paginated in SQL, under RLS.';

revoke all on function public.compliance_agenda(date, date, uuid, uuid, public.compliance_type[], boolean, text, boolean, int, int) from public, anon;
grant execute on function public.compliance_agenda(date, date, uuid, uuid, public.compliance_type[], boolean, text, boolean, int, int) to authenticated;
