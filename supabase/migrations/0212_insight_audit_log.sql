-- 0212 · The audit log page (§7.20, §5.11, §0.1 rule 12): Partner only, insert-only.
--
--   audit_log_page(params)   one page of audit_logs, newest first, with its total, filtered in SQL
--       by user, event, resource type (and id), success, an IST date range and a search over the
--       action, resource id and email. SECURITY INVOKER: the audit_logs RLS (0039: SELECT Partner
--       only) applies, and the function says so plainly to anyone else. The CSV export pages through
--       it in batches.
--   audit_log_facets()       the people, events and resource types the log holds, for the filters.
--
-- Nothing here writes: audit rows are inserted only by log_audit_event (0031) and refused on UPDATE
-- and DELETE by audit_logs_immutable (0017). The names of staff come from profiles (a portal user's
-- profile isn't visible to staff, so their rows show the email recorded with the event).

set search_path = public, extensions;

create index if not exists audit_logs_resource_type_at_idx on public.audit_logs (resource_type, at desc);

create or replace function public.audit_log_page(p_params jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  v_user uuid := nullif(p_params ->> 'user_id', '')::uuid;
  v_system boolean := coalesce((p_params ->> 'system')::boolean, false);
  v_events public.audit_event[] := (
    select coalesce(array_agg(e::public.audit_event), '{}')
    from jsonb_array_elements_text(coalesce(p_params -> 'events', '[]'::jsonb)) e
  );
  v_resource text := nullif(btrim(p_params ->> 'resource_type'), '');
  v_resource_id text := nullif(btrim(p_params ->> 'resource_id'), '');
  v_success boolean := (p_params ->> 'success')::boolean;
  v_from date := nullif(p_params ->> 'from', '')::date;
  v_to date := nullif(p_params ->> 'to', '')::date;
  v_q text := left(nullif(btrim(p_params ->> 'q'), ''), 100);
  v_like text;
  v_offset int := least(greatest(coalesce((p_params ->> 'offset')::int, 0), 0), 10000000);
  v_limit int := least(greatest(coalesce((p_params ->> 'limit')::int, 25), 1), 5000);
  v_dir text := case when p_params ->> 'dir' = 'asc' then 'asc' else 'desc' end;
  v_total bigint;
  v_rows jsonb;
begin
  if not public.is_partner() then
    raise exception 'USER: The audit log is for Partners.' using errcode = 'P0001';
  end if;
  if v_q is not null then
    v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  select count(*) into v_total
  from public.audit_logs a
  where (v_user is null or a.user_id = v_user)
    and (not v_system or a.user_id is null)
    and (cardinality(v_events) = 0 or a.event = any (v_events))
    and (v_resource is null or a.resource_type = v_resource)
    and (v_resource_id is null or a.resource_id = v_resource_id)
    and (v_success is null or a.success = v_success)
    and (v_from is null or a.at >= (v_from::timestamp at time zone 'Asia/Kolkata'))
    and (v_to is null or a.at < ((v_to + 1)::timestamp at time zone 'Asia/Kolkata'))
    and (v_like is null or a.action ilike v_like or a.resource_id ilike v_like or a.user_email ilike v_like or a.resource_type ilike v_like);

  select coalesce(jsonb_agg(to_jsonb(x) order by x.ord), '[]'::jsonb) into v_rows
  from (
    select
      row_number() over (order by case when v_dir = 'asc' then a.at end asc, case when v_dir = 'desc' then a.at end desc, a.id) as ord,
      a.id, a.at, a.event, a.user_id, a.user_email, a.user_role, p.full_name as user_name,
      a.ip, a.user_agent, a.resource_type, a.resource_id, a.action, a.success, a.error, a.details
    from public.audit_logs a
    left join public.profiles p on p.id = a.user_id
    where (v_user is null or a.user_id = v_user)
      and (not v_system or a.user_id is null)
      and (cardinality(v_events) = 0 or a.event = any (v_events))
      and (v_resource is null or a.resource_type = v_resource)
      and (v_resource_id is null or a.resource_id = v_resource_id)
      and (v_success is null or a.success = v_success)
      and (v_from is null or a.at >= (v_from::timestamp at time zone 'Asia/Kolkata'))
      and (v_to is null or a.at < ((v_to + 1)::timestamp at time zone 'Asia/Kolkata'))
      and (v_like is null or a.action ilike v_like or a.resource_id ilike v_like or a.user_email ilike v_like or a.resource_type ilike v_like)
    order by case when v_dir = 'asc' then a.at end asc, case when v_dir = 'desc' then a.at end desc, a.id
    offset v_offset
    limit v_limit
  ) x;

  return jsonb_build_object('total', v_total, 'rows', v_rows);
end;
$$;

comment on function public.audit_log_page(jsonb) is
  'Partner only: a filtered, paged slice of the audit log with its total (§7.20). Read-only; RLS applies.';

create or replace function public.audit_log_facets()
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
begin
  if not public.is_partner() then
    raise exception 'USER: The audit log is for Partners.' using errcode = 'P0001';
  end if;
  return jsonb_build_object(
    'users', coalesce((
      select jsonb_agg(jsonb_build_object('id', u.user_id, 'email', u.email, 'role', u.role, 'name', p.full_name, 'events', u.n)
                       order by coalesce(p.full_name, u.email), u.user_id)
      from (
        select a.user_id, max(a.user_email) as email, max(a.user_role) as role, count(*) as n
        from public.audit_logs a
        where a.user_id is not null
        group by a.user_id
        order by count(*) desc
        limit 500
      ) u
      left join public.profiles p on p.id = u.user_id
    ), '[]'::jsonb),
    'resource_types', coalesce((
      select jsonb_agg(jsonb_build_object('value', r.resource_type, 'events', r.n) order by r.resource_type)
      from (
        select a.resource_type, count(*) as n
        from public.audit_logs a
        where a.resource_type is not null
        group by a.resource_type
        order by count(*) desc
        limit 300
      ) r
    ), '[]'::jsonb),
    'has_system', exists (select 1 from public.audit_logs a where a.user_id is null)
  );
end;
$$;

comment on function public.audit_log_facets() is
  'Partner only: the people and resource types in the audit log, for its filters (§7.20).';

revoke execute on function public.audit_log_page(jsonb), public.audit_log_facets() from public, anon;
grant execute on function public.audit_log_page(jsonb), public.audit_log_facets() to authenticated, service_role;
