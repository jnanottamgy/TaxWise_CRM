-- 0194 · Filing history (§7.15.2, §7.3.3 Registers tab, §4.1).
--
--   filing_history              (security invoker: filing_records' RLS applies, 0037) every filing
--                               with its client, where it came from ("ours": filed through the work
--                               tracker / compliance; "inherited": a previous CA's, filed_by_external),
--                               the task and deadline it closed, and whether it met the due date.
--   filing_history_facets()     the forms and FYs on record, for the list's filters (RLS-scoped).
--   import_filing_records(client, rows)
--                               "Import prior filings" (CSV) for a client moving from another CA: FY,
--                               form, period, filed on, acknowledgement no., previous firm, in one
--                               transaction. Partners/Managers only (as filing_records' insert policy).
--                               A row already on record (same client, FY, form, period and
--                               acknowledgement) is skipped, so an import can be run again safely.

set search_path = public, extensions;

create index if not exists filing_records_dedupe_idx on public.filing_records (client_id, financial_year, upper(btrim(filing_type)));
create index if not exists filing_records_external_idx on public.filing_records (client_id) where filed_by_external is not null;

-- =============================================================================================
-- filing_history
-- =============================================================================================
create or replace view public.filing_history with (security_invoker = true) as
select
  fr.id,
  fr.client_id,
  c.display_name as client_name,
  c.client_code::text as client_code,
  c.owner_employee_id,
  fr.financial_year,
  fr.filing_type,
  upper(btrim(fr.filing_type)) as form_key,
  fr.service_type,
  fr.period,
  fr.filed_on,
  fr.acknowledgement_no,
  fr.filed_by_external,
  case when nullif(btrim(coalesce(fr.filed_by_external, '')), '') is null then 'ours' else 'inherited' end as origin,
  fr.task_id,
  t.task_number,
  fr.compliance_event_id,
  ce.title as event_title,
  ce.due_date as event_due_date,
  case when ce.due_date is not null and fr.filed_on is not null then fr.filed_on <= ce.due_date end as on_time,
  fr.document_id,
  fr.shareable_with_client,
  fr.notes,
  fr.created_by,
  cb.full_name as created_by_name,
  fr.created_at,
  fr.updated_at
from public.filing_records fr
join public.clients c on c.id = fr.client_id and c.deleted_at is null
left join public.tasks t on t.id = fr.task_id
left join public.compliance_events ce on ce.id = fr.compliance_event_id
left join public.employee_directory cb on cb.profile_id = fr.created_by;

comment on view public.filing_history is
  'Every filing on record, ours or inherited from a previous CA, with its task, deadline and on-time flag (§7.15.2).';

revoke all on public.filing_history from anon, public;
revoke insert, update, delete, truncate, references, trigger on public.filing_history from authenticated;
grant select on public.filing_history to authenticated, service_role;

-- =============================================================================================
-- filing_history_facets()
-- =============================================================================================
create or replace function public.filing_history_facets(p_client_id uuid default null)
returns jsonb
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select jsonb_build_object(
    'forms', coalesce((
      select jsonb_agg(f.form order by f.form)
      from (
        select distinct upper(btrim(fr.filing_type)) as form
        from public.filing_records fr
        join public.clients c on c.id = fr.client_id and c.deleted_at is null
        where p_client_id is null or fr.client_id = p_client_id
        limit 300
      ) f
    ), '[]'::jsonb),
    'years', coalesce((
      select jsonb_agg(y.fy order by y.fy desc)
      from (
        select distinct fr.financial_year as fy
        from public.filing_records fr
        join public.clients c on c.id = fr.client_id and c.deleted_at is null
        where p_client_id is null or fr.client_id = p_client_id
      ) y
    ), '[]'::jsonb)
  )
$$;

comment on function public.filing_history_facets(uuid) is 'The forms and FYs on record (for filters), under the caller''s RLS (§7.15.2).';

revoke execute on function public.filing_history_facets(uuid) from public, anon;
grant execute on function public.filing_history_facets(uuid) to authenticated, service_role;

-- =============================================================================================
-- import_filing_records(client, rows)
--   rows: [{financial_year, filing_type, period, filed_on, acknowledgement_no, filed_by_external,
--           service_type, notes}] (already checked by the server; checked again here)
--   → {inserted, skipped, ids}
-- =============================================================================================
create or replace function public.import_filing_records(p_client_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_row jsonb;
  v_n int := 0;
  v_inserted int := 0;
  v_skipped int := 0;
  v_ids uuid[] := '{}';
  v_id uuid;
  v_fy text;
  v_form text;
  v_period text;
  v_ack text;
  v_firm text;
  v_filed date;
  v_service public.service_type;
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only Partners and Managers can import filing history.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.clients c where c.id = p_client_id and c.deleted_at is null) then
    raise exception 'USER: That client isn''t in the client list any more. It may be in the recycle bin.' using errcode = 'P0001';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'USER: There are no rows to import.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_rows) > 2000 then
    raise exception 'USER: Import at most 2,000 filings at a time. Split the file and import each part.' using errcode = 'P0001';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_n := v_n + 1;
    v_fy := btrim(coalesce(v_row ->> 'financial_year', ''));
    v_form := btrim(coalesce(v_row ->> 'filing_type', ''));
    v_period := nullif(btrim(coalesce(v_row ->> 'period', '')), '');
    v_ack := nullif(btrim(coalesce(v_row ->> 'acknowledgement_no', '')), '');
    v_firm := nullif(btrim(coalesce(v_row ->> 'filed_by_external', '')), '');
    if not public.is_fy_label(v_fy) then
      raise exception 'USER: Row %: the FY should look like 2024-25.', v_n using errcode = 'P0001';
    end if;
    if v_form = '' or length(v_form) > 40 then
      raise exception 'USER: Row %: enter the form (for example GSTR-3B or ITR-6), in 40 characters or fewer.', v_n using errcode = 'P0001';
    end if;
    if v_firm is null then
      raise exception 'USER: Row %: enter the previous firm that filed it.', v_n using errcode = 'P0001';
    end if;
    begin
      v_filed := nullif(btrim(coalesce(v_row ->> 'filed_on', '')), '')::date;
    exception when others then
      raise exception 'USER: Row %: the filing date isn''t a date.', v_n using errcode = 'P0001';
    end;
    if v_filed is not null and v_filed > public.today_ist() then
      raise exception 'USER: Row %: the filing date is in the future.', v_n using errcode = 'P0001';
    end if;
    begin
      v_service := nullif(btrim(coalesce(v_row ->> 'service_type', '')), '')::public.service_type;
    exception when others then
      v_service := null;
    end;

    if exists (
      select 1 from public.filing_records fr
      where fr.client_id = p_client_id
        and fr.financial_year = v_fy
        and upper(btrim(fr.filing_type)) = upper(v_form)
        and coalesce(upper(btrim(fr.period)), '') = coalesce(upper(v_period), '')
        and coalesce(upper(btrim(fr.acknowledgement_no)), '') = coalesce(upper(v_ack), '')
    ) then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    insert into public.filing_records (
      client_id, financial_year, filing_type, service_type, period, filed_on, acknowledgement_no, filed_by_external, notes, created_by
    ) values (
      p_client_id, v_fy, left(v_form, 40), v_service, left(v_period, 40), v_filed, left(v_ack, 80), left(v_firm, 160),
      nullif(left(btrim(coalesce(v_row ->> 'notes', '')), 1000), ''), auth.uid()
    )
    returning id into v_id;
    v_inserted := v_inserted + 1;
    v_ids := v_ids || v_id;
  end loop;

  return jsonb_build_object('inserted', v_inserted, 'skipped', v_skipped, 'ids', to_jsonb(v_ids));
end;
$$;

comment on function public.import_filing_records(uuid, jsonb) is
  'Imports a client''s prior filings from a previous CA in one transaction, skipping rows already on record (§7.15.2). Partners/Managers.';

revoke execute on function public.import_filing_records(uuid, jsonb) from public, anon;
grant execute on function public.import_filing_records(uuid, jsonb) to authenticated, service_role;
