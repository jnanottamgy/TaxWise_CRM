-- 0125 · Compliance engine: event integrity and the idempotent bulk upsert (§5.6, §6.7, §7.7, §4.1, §4.6).
--
-- 1. compliance_events_guard (BEFORE INSERT OR UPDATE): keeps `status` in step with the workflow, so
--    the derived "overdue" (compliance_events_view, 0016: status = 'pending' and due_date < today)
--    never marks a filed return overdue, and reminders/next-deadline lookups that read
--    `status = 'pending'` skip filed work:
--      workflow reaches Filed or Completed  → status 'completed', completed_at stamped once;
--      workflow moves back from Filed/Completed (a reopen) → status 'pending', completed_at cleared;
--      status set to 'completed' directly (older callers) → workflow 'completed'.
--    It also mirrors §7.6.4 / §4.1 for Employees (API callers): they can't create or move a deadline
--    to Filed or Completed, can't reopen one, and can't create one that isn't pending. A deadline
--    never moves to another client.
-- 2. upsert_compliance_events(p_rows jsonb): the generators' bulk write (Generate deadlines, service
--    changes, the monthly top-up), idempotent by dedupe_key. SECURITY INVOKER: the caller's RLS
--    applies (the job runs as the service role). For each row:
--      - a new dedupe_key is inserted (`on conflict do nothing`, so a race never doubles up);
--      - an existing row is rewritten only when the caller flags it (`update_reason`: the facts
--        behind the date changed, lib/domain/statutory-calendar planEventSync), only while it is
--        unfiled and from the same source, and never by an Employee (0037 column limits);
--      - a filed, completed or cancelled row is never touched (counted as `locked`).
--    A rewrite that moves the date clears reminder_sent_at (the reminder is re-planned) and writes a
--    history line on the event. Returns the counts.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------------------------
-- 1. Integrity of status / workflow / completed_at, and the Employee limits
-- ---------------------------------------------------------------------------------------------
create or replace function public.compliance_events_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_employee boolean := public.is_api_caller() and public.app_role() = 'employee';
  v_old_done boolean;
  v_new_done boolean;
begin
  if tg_op = 'INSERT' then
    if v_employee and (new.status <> 'pending' or new.workflow_status in ('filed', 'completed')) then
      raise exception 'USER: Only a Partner or Manager can add a deadline that is already filed or closed.' using errcode = 'P0001';
    end if;
    if new.status = 'completed' and new.workflow_status not in ('filed', 'completed') then
      new.workflow_status := 'completed';
    end if;
    if new.workflow_status in ('filed', 'completed') and new.status = 'pending' then
      new.status := 'completed';
    end if;
    if new.status = 'completed' then
      new.completed_at := coalesce(new.completed_at, now());
    end if;
    return new;
  end if;

  if new.client_id is distinct from old.client_id then
    raise exception 'USER: A deadline can''t be moved to another client. Cancel it and add one for the right client.' using errcode = 'P0001';
  end if;

  v_old_done := old.workflow_status in ('filed', 'completed');
  v_new_done := new.workflow_status in ('filed', 'completed');

  if v_employee then
    if v_new_done and not v_old_done then
      raise exception 'USER: Only a Partner or Manager can mark a deadline filed. Move it to Under review instead.' using errcode = 'P0001';
    end if;
    if v_old_done and not v_new_done then
      raise exception 'USER: Only a Partner or Manager can reopen a filed deadline.' using errcode = 'P0001';
    end if;
  end if;

  if new.status = 'cancelled' and old.status <> 'cancelled' and v_old_done then
    raise exception 'USER: A filed deadline can''t be cancelled. Reopen it first if it was marked filed by mistake.' using errcode = 'P0001';
  end if;

  -- Status follows the workflow (cancelled stays cancelled until it is restored).
  if new.status is distinct from old.status and new.status = 'completed' and not v_new_done then
    new.workflow_status := 'completed';
    v_new_done := true;
  end if;
  if new.status <> 'cancelled' then
    if v_new_done then
      new.status := 'completed';
      new.completed_at := coalesce(new.completed_at, old.completed_at, now());
    elsif new.status = 'completed' or (v_old_done and not v_new_done) then
      new.status := 'pending';
      new.completed_at := null;
    end if;
  end if;
  return new;
end;
$$;

comment on function public.compliance_events_guard() is
  'Trigger: status follows the workflow (Filed/Completed → completed, reopen → pending), completed_at once; Employees can''t file, reopen or add closed deadlines; a deadline never changes client (§5.6, §7.7, §4.1).';

revoke all on function public.compliance_events_guard() from public, anon, authenticated;

drop trigger if exists compliance_events_guard on public.compliance_events;
create trigger compliance_events_guard before insert or update on public.compliance_events
  for each row execute function public.compliance_events_guard();

-- Rows recorded before this guard: a filed workflow with a pending status reads as overdue.
update public.compliance_events
   set status = 'completed', completed_at = coalesce(completed_at, updated_at)
 where workflow_status in ('filed', 'completed') and status = 'pending';

-- ---------------------------------------------------------------------------------------------
-- 2. upsert_compliance_events(p_rows jsonb)
-- ---------------------------------------------------------------------------------------------
create or replace function public.upsert_compliance_events(p_rows jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_api boolean := public.is_api_caller();
  v_role text := public.app_role();
  v_uid uuid := auth.uid();
  v_user_name text;
  v_inserted int := 0;
  v_updated int := 0;
  v_locked int := 0;
  v_unchanged int := 0;
  v_skipped int := 0;
  v_n int;
  r record;
  e record;
begin
  if v_api and (v_role is null or v_role not in ('partner', 'manager', 'employee')) then
    raise exception 'USER: Only staff can plan deadlines.' using errcode = 'P0001';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'USER: The deadlines to plan must be a list.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_rows) > 5000 then
    raise exception 'USER: Too many deadlines in one go. Generate them client by client.' using errcode = 'P0001';
  end if;

  select full_name into v_user_name from public.profiles where id = v_uid;

  for r in
    select * from jsonb_to_recordset(p_rows) as x(
      client_id uuid, type public.compliance_type, form_code text, title text, description text,
      financial_year text, filing_period text, period_start date, period_end date, due_date date,
      is_statutory boolean, source public.compliance_source, reminder_days int, notes text,
      dedupe_key text, rule_code text, source_ref text, original_due_date date, override_id uuid,
      agm_date date, is_provisional boolean, update_reason text
    )
  loop
    if r.client_id is null or r.dedupe_key is null or left(r.dedupe_key, 37) <> r.client_id::text || '|' then
      raise exception 'USER: A generated deadline doesn''t belong to its client. Generate the deadlines again.' using errcode = 'P0001';
    end if;
    if r.source is null or r.source = 'manual' then
      raise exception 'USER: Only the statutory calendar and ops templates plan deadlines in bulk.' using errcode = 'P0001';
    end if;
    if r.type is null or nullif(btrim(r.title), '') is null or r.due_date is null then
      raise exception 'USER: A generated deadline needs a type, a title and a due date.' using errcode = 'P0001';
    end if;

    select ce.id, ce.status, ce.workflow_status, ce.source, ce.due_date, ce.notes
      into e
      from public.compliance_events ce
     where ce.dedupe_key = r.dedupe_key
     for update;

    if not found then
      insert into public.compliance_events (
        client_id, type, form_code, title, description, financial_year, filing_period, period_start,
        period_end, due_date, is_statutory, source, reminder_days, notes, dedupe_key, rule_code,
        source_ref, original_due_date, override_id, agm_date, is_provisional
      ) values (
        r.client_id, r.type, nullif(btrim(r.form_code), ''), left(btrim(r.title), 300), nullif(btrim(r.description), ''),
        r.financial_year, nullif(btrim(r.filing_period), ''), r.period_start, r.period_end, r.due_date,
        coalesce(r.is_statutory, r.source = 'statutory_engine'), r.source, greatest(coalesce(r.reminder_days, 7), 0),
        nullif(btrim(r.notes), ''), r.dedupe_key, r.rule_code, r.source_ref, r.original_due_date, r.override_id,
        r.agm_date, coalesce(r.is_provisional, false)
      )
      on conflict (dedupe_key) do nothing;
      get diagnostics v_n = row_count;
      if v_n > 0 then
        v_inserted := v_inserted + 1;
      else
        v_skipped := v_skipped + 1; -- planned meanwhile, or held by a client this caller can't see
      end if;
      continue;
    end if;

    if e.status <> 'pending' or e.workflow_status in ('filed', 'completed') then
      v_locked := v_locked + 1;
      continue;
    end if;
    if nullif(btrim(r.update_reason), '') is null or e.source <> r.source then
      v_unchanged := v_unchanged + 1;
      continue;
    end if;
    if v_api and v_role = 'employee' then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    update public.compliance_events
       set type = r.type,
           form_code = nullif(btrim(r.form_code), ''),
           title = left(btrim(r.title), 300),
           description = nullif(btrim(r.description), ''),
           financial_year = r.financial_year,
           filing_period = nullif(btrim(r.filing_period), ''),
           period_start = r.period_start,
           period_end = r.period_end,
           due_date = r.due_date,
           reminder_days = greatest(coalesce(r.reminder_days, 7), 0),
           -- The engine's own provisional note goes stale once the date is firm; people's notes stay.
           notes = case when e.notes like '%Provisional: dated from%' then nullif(btrim(r.notes), '') else e.notes end,
           rule_code = r.rule_code,
           source_ref = r.source_ref,
           original_due_date = r.original_due_date,
           override_id = r.override_id,
           agm_date = r.agm_date,
           is_provisional = coalesce(r.is_provisional, false),
           reminder_sent_at = case when r.due_date is distinct from e.due_date then null else reminder_sent_at end
     where id = e.id;
    v_updated := v_updated + 1;

    if r.due_date is distinct from e.due_date then
      insert into public.activity_logs (entity_type, entity_id, action, description, user_id, user_name, metadata)
      values (
        'compliance_event', e.id, 'due_date_regenerated',
        format('Due date moved from %s to %s. %s', to_char(e.due_date, 'DD Mon YYYY'), to_char(r.due_date, 'DD Mon YYYY'), btrim(r.update_reason)),
        v_uid, v_user_name,
        jsonb_build_object('from', e.due_date, 'to', r.due_date, 'reason', btrim(r.update_reason), 'rule_code', r.rule_code)
      );
    end if;
  end loop;

  return jsonb_build_object(
    'inserted', v_inserted,
    'updated', v_updated,
    'locked', v_locked,
    'unchanged', v_unchanged,
    'skipped', v_skipped
  );
end;
$$;

comment on function public.upsert_compliance_events(jsonb) is
  'Bulk plan of generated deadlines, idempotent by dedupe_key: inserts new keys, rewrites flagged unfiled rows of the same source (never an Employee), never touches filed, completed or cancelled rows; under the caller''s RLS (§6.7, §7.7).';

revoke all on function public.upsert_compliance_events(jsonb) from public, anon;
grant execute on function public.upsert_compliance_events(jsonb) to authenticated, service_role;
