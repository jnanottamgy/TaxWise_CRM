-- 0132 · Timesheet (§7.10): one running timer per person kept on the server, manual entries,
-- week approval and locking, the week grid's saved rows, and unbilled time with its ₹ value.
--
-- time_entries.entry_source: how the entry was made — 'timer' (started and stopped), 'manual_range'
--   (start and end typed) or 'manual_duration' (a duration only; the entry starts at midnight IST of
--   its date and its end is derived). Minutes are worked out from the times except for a duration.
-- time_entries_guard (BEFORE INSERT/UPDATE/DELETE), for API callers:
--   * a billed entry, or one in an approved week, is read-only (§7.10 "Locking"); Partners and
--     Managers may still change its billing link (invoice_id / invoiced_at / locked) for the invoice
--     flow (§7.9.2), but a week's lock lifts only by reopening the week;
--   * no new or moved entry inside an approved week;
--   * the task and client agree (the task's client fills in when only the task is given);
--   * time without a client is never billable (internal work);
--   * no entry longer than 24 hours, and no time logged for later than now.
-- An Employee may log time on a task assigned to them whose client they can't otherwise see
--   (time_entries_insert_task / _update_task policies), with the task's client.
-- start_timer / stop_timer: one running timer per person (§7.10, partial unique index 0006);
--   starting a new one stops the running one first (switching tasks), under a per-person lock.
-- approve_timesheet_week / reopen_timesheet_week (Partner/Manager, SECURITY DEFINER): approving
--   locks the person's entries of that week (Monday–Sunday, IST) and records who approved it;
--   reopening (with a reason) lifts the lock on entries that aren't billed. A Manager approves
--   Employees' weeks, never their own.
-- timesheet_week_rows: the rows a person keeps on their week grid without time yet (Add row,
--   Copy last week's rows), so the grid survives a reload.
-- unbilled_time_entries / unbilled_time_by_client (security_invoker, Partners and Managers only, and
--   the system for billing jobs): billable, finished, uninvoiced client time with its value =
--   minutes × the person's billing rate ÷ 60, rounded half-up to the paisa per entry (§7.10, §0.1
--   rule 7). Employees and portal users get no rows.

set search_path = public, extensions;

-- =============================================================================================
-- time_entries.entry_source
-- =============================================================================================
alter table public.time_entries
  add column if not exists entry_source text not null default 'manual_range';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'time_entries_entry_source_values') then
    alter table public.time_entries
      add constraint time_entries_entry_source_values check (entry_source in ('timer', 'manual_range', 'manual_duration'));
  end if;
end;
$$;

comment on column public.time_entries.entry_source is
  'timer | manual_range (start and end typed) | manual_duration (duration only; starts at midnight IST of its date) (§7.10).';

create index if not exists time_entries_task_idx on public.time_entries (task_id) where task_id is not null;

-- The Monday (IST) of the week a moment falls in.
create or replace function public.ist_week_start(p_at timestamptz)
returns date
language sql
stable
set search_path = pg_catalog, public
as $$
  select ((p_at at time zone 'Asia/Kolkata')::date - (extract(isodow from (p_at at time zone 'Asia/Kolkata'))::int - 1))
$$;

comment on function public.ist_week_start(timestamptz) is 'The Monday of the IST week that contains the moment (§7.10 weeks run Monday–Sunday).';

-- =============================================================================================
-- timesheet_week_approvals
-- =============================================================================================
create table if not exists public.timesheet_week_approvals (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete cascade,
  week_start date not null constraint timesheet_week_approvals_monday check (extract(isodow from week_start) = 1),
  approved_by uuid not null,
  approved_at timestamptz not null default now(),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint timesheet_week_approvals_key unique (employee_id, week_start)
);
alter table public.timesheet_week_approvals enable row level security;

comment on table public.timesheet_week_approvals is 'A Partner or Manager approved this person''s week, which locks its time entries (§7.10).';

drop trigger if exists set_updated_at on public.timesheet_week_approvals;
create trigger set_updated_at before insert or update on public.timesheet_week_approvals
  for each row execute function public.set_updated_at();

create index if not exists timesheet_week_approvals_week_idx on public.timesheet_week_approvals (week_start);

drop policy if exists timesheet_week_approvals_select on public.timesheet_week_approvals;
create policy timesheet_week_approvals_select on public.timesheet_week_approvals
  for select to authenticated
  using ((select public.is_manager_or_partner()) or employee_id = (select public.staff_employee_id()));

-- Written only by approve_timesheet_week / reopen_timesheet_week.
revoke insert, update, delete, truncate on public.timesheet_week_approvals from authenticated, anon;

-- =============================================================================================
-- timesheet_week_rows
-- =============================================================================================
create table if not exists public.timesheet_week_rows (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete cascade,
  week_start date not null constraint timesheet_week_rows_monday check (extract(isodow from week_start) = 1),
  client_id uuid references public.clients (id) on delete cascade,
  task_id uuid references public.tasks (id) on delete cascade,
  billable boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.timesheet_week_rows enable row level security;

comment on table public.timesheet_week_rows is 'Rows a person keeps on their week grid before any time is logged against them (§7.10 week grid, copy last week).';

create unique index if not exists timesheet_week_rows_key on public.timesheet_week_rows (
  employee_id, week_start,
  coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(task_id, '00000000-0000-0000-0000-000000000000'::uuid),
  billable
);

drop trigger if exists set_updated_at on public.timesheet_week_rows;
create trigger set_updated_at before insert or update on public.timesheet_week_rows
  for each row execute function public.set_updated_at();

create or replace function public.timesheet_week_rows_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_client uuid;
begin
  if new.task_id is not null then
    select t.client_id into v_client from public.tasks t where t.id = new.task_id;
    if v_client is not null then
      new.client_id := v_client;
    end if;
  end if;
  if new.client_id is null then
    new.billable := false;
  end if;
  return new;
end;
$$;

comment on function public.timesheet_week_rows_guard() is 'Trigger: a grid row''s client follows its task; rows without a client are not billable.';

drop trigger if exists timesheet_week_rows_guard on public.timesheet_week_rows;
create trigger timesheet_week_rows_guard before insert or update on public.timesheet_week_rows
  for each row execute function public.timesheet_week_rows_guard();

drop policy if exists timesheet_week_rows_select on public.timesheet_week_rows;
create policy timesheet_week_rows_select on public.timesheet_week_rows
  for select to authenticated
  using ((select public.is_manager_or_partner()) or employee_id = (select public.staff_employee_id()));
drop policy if exists timesheet_week_rows_insert on public.timesheet_week_rows;
create policy timesheet_week_rows_insert on public.timesheet_week_rows
  for insert to authenticated
  with check (
    employee_id = (select public.staff_employee_id())
    and (task_id is null or task_id in (select public.staff_task_ids()))
    and (client_id is null or client_id in (select public.staff_client_ids())
         or (task_id is not null and task_id in (select public.staff_task_ids())))
  );
drop policy if exists timesheet_week_rows_update on public.timesheet_week_rows;
create policy timesheet_week_rows_update on public.timesheet_week_rows
  for update to authenticated
  using (employee_id = (select public.staff_employee_id()))
  with check (
    employee_id = (select public.staff_employee_id())
    and (task_id is null or task_id in (select public.staff_task_ids()))
    and (client_id is null or client_id in (select public.staff_client_ids())
         or (task_id is not null and task_id in (select public.staff_task_ids())))
  );
drop policy if exists timesheet_week_rows_delete on public.timesheet_week_rows;
create policy timesheet_week_rows_delete on public.timesheet_week_rows
  for delete to authenticated
  using (employee_id = (select public.staff_employee_id()));

-- =============================================================================================
-- time_entries: an Employee's time on a task assigned to them, on a client outside their scope
-- (the general policies in 0035 need the client to be theirs too).
-- =============================================================================================
drop policy if exists time_entries_insert_task on public.time_entries;
create policy time_entries_insert_task on public.time_entries
  for insert to authenticated
  with check (
    employee_id = (select public.staff_employee_id())
    and invoice_id is null and invoiced_at is null and not locked
    and task_id is not null
    and task_id in (select t.id from public.tasks t where t.assigned_employee_id = (select public.staff_employee_id()))
  );
drop policy if exists time_entries_update_task on public.time_entries;
create policy time_entries_update_task on public.time_entries
  for update to authenticated
  using (employee_id = (select public.staff_employee_id()) and invoice_id is null and not locked)
  with check (
    employee_id = (select public.staff_employee_id())
    and invoice_id is null and invoiced_at is null and not locked
    and task_id is not null
    and task_id in (select t.id from public.tasks t where t.assigned_employee_id = (select public.staff_employee_id()))
  );

-- =============================================================================================
-- time_entries_guard
-- =============================================================================================
create or replace function public.time_entries_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_api boolean := public.is_api_caller();
  v_task_client uuid;
  v_week date;
  v_billing_only boolean;
  v_billing_cols text[] := array['invoice_id', 'invoiced_at', 'locked', 'updated_at'];
begin
  if tg_op = 'DELETE' then
    if v_api and (old.locked or old.invoice_id is not null) then
      raise exception 'USER: This time entry is locked (billed, or in an approved week), so it can''t be deleted.' using errcode = 'P0001';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' and v_api then
    v_billing_only := (to_jsonb(new) - v_billing_cols) = (to_jsonb(old) - v_billing_cols);
    if old.locked or old.invoice_id is not null then
      if not v_billing_only or not public.is_manager_or_partner() then
        raise exception 'USER: This time entry is locked (billed, or in an approved week), so it can''t be changed.' using errcode = 'P0001';
      end if;
      if old.locked and not new.locked and exists (
        select 1 from public.timesheet_week_approvals a
        where a.employee_id = old.employee_id and a.week_start = public.ist_week_start(old.started_at)
      ) then
        raise exception 'USER: This week is approved. Reopen the week to unlock its entries.' using errcode = 'P0001';
      end if;
      return new;
    end if;
    if v_billing_only then
      return new;
    end if;
  end if;

  -- The task and the client agree; the task's client fills in.
  if new.task_id is not null and (tg_op = 'INSERT' or new.task_id is distinct from old.task_id or new.client_id is distinct from old.client_id) then
    select t.client_id into v_task_client from public.tasks t where t.id = new.task_id;
    if v_task_client is not null then
      if new.client_id is null then
        new.client_id := v_task_client;
      elsif new.client_id <> v_task_client then
        raise exception 'USER: That task belongs to another client. Choose the client or the task again.' using errcode = 'P0001';
      end if;
    end if;
  end if;
  if new.client_id is null then
    new.billable := false;
  end if;

  -- Minutes from the times, except for a duration entry (whose end follows from it).
  if new.entry_source = 'manual_duration' then
    if new.minutes is null or new.minutes <= 0 then
      raise exception 'USER: Enter how long you worked.' using errcode = 'P0001';
    end if;
    new.ended_at := new.started_at + make_interval(mins => new.minutes);
  elsif new.ended_at is null then
    if new.entry_source <> 'timer' then
      raise exception 'USER: Enter when it ended, or how long it took.' using errcode = 'P0001';
    end if;
    new.minutes := 0;
  else
    if new.ended_at < new.started_at then
      raise exception 'USER: The end time is before the start time.' using errcode = 'P0001';
    end if;
    new.minutes := greatest(0, round(extract(epoch from (new.ended_at - new.started_at)) / 60.0)::int);
  end if;

  if new.entry_source <> 'timer' and new.minutes > 1440 then
    raise exception 'USER: One entry can''t be longer than 24 hours. Split it across the days.' using errcode = 'P0001';
  end if;
  if v_api then
    if new.entry_source = 'manual_duration' then
      if (new.started_at at time zone 'Asia/Kolkata')::date > public.today_ist() then
        raise exception 'USER: Time can''t be logged for a future date.' using errcode = 'P0001';
      end if;
    elsif new.started_at > now() + interval '5 minutes' or (new.ended_at is not null and new.ended_at > now() + interval '5 minutes') then
      raise exception 'USER: Time can''t be logged for later than now.' using errcode = 'P0001';
    end if;

    -- No new or moved entry inside an approved week.
    v_week := public.ist_week_start(new.started_at);
    if exists (select 1 from public.timesheet_week_approvals a where a.employee_id = new.employee_id and a.week_start = v_week) then
      raise exception 'USER: The week of % is approved and locked. Ask a Partner or Manager to reopen it.', to_char(v_week, 'DD Mon YYYY')
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

comment on function public.time_entries_guard() is
  'Trigger: billed or approved-week entries are read-only (billing links aside); no entries in an approved week; task and client agree; internal time is not billable; minutes from the times; ≤ 24 h; nothing later than now (§7.10).';

drop trigger if exists time_entries_guard on public.time_entries;
create trigger time_entries_guard before insert or update or delete on public.time_entries
  for each row execute function public.time_entries_guard();

revoke execute on function public.time_entries_guard(), public.timesheet_week_rows_guard() from public, anon, authenticated;

-- =============================================================================================
-- start_timer / stop_timer
-- =============================================================================================
create or replace function public.start_timer(
  p_task_id uuid default null,
  p_client_id uuid default null,
  p_description text default null,
  p_billable boolean default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_me uuid := public.staff_employee_id();
  v_client uuid := p_client_id;
  v_task_client uuid;
  v_stopped record;
  v_entry record;
begin
  if v_me is null then
    raise exception 'USER: Only the firm''s staff can run a timer.' using errcode = 'P0001';
  end if;
  -- One person, one timer: serialise this person's starts and stops.
  perform pg_advisory_xact_lock(hashtext('time_entries.timer'), hashtext(v_me::text));

  if p_task_id is not null then
    select t.client_id into v_task_client from public.tasks t where t.id = p_task_id and t.deleted_at is null;
    if not found then
      raise exception 'USER: That task doesn''t exist, or it isn''t one of yours.' using errcode = 'P0001';
    end if;
    if v_client is not null and v_client <> v_task_client then
      raise exception 'USER: That task belongs to another client.' using errcode = 'P0001';
    end if;
    v_client := v_task_client;
  elsif v_client is not null and not exists (select 1 from public.clients c where c.id = v_client and c.deleted_at is null) then
    raise exception 'USER: That client doesn''t exist, or isn''t one of yours.' using errcode = 'P0001';
  end if;

  update public.time_entries
     set ended_at = greatest(now(), started_at)
   where employee_id = v_me and ended_at is null
  returning id, task_id, client_id, minutes, started_at into v_stopped;

  insert into public.time_entries (employee_id, client_id, task_id, description, started_at, billable, entry_source)
  values (v_me, v_client, p_task_id, left(nullif(btrim(coalesce(p_description, '')), ''), 500), now(),
          coalesce(p_billable, v_client is not null), 'timer')
  returning id, started_at, client_id, task_id into v_entry;

  return jsonb_build_object(
    'entry_id', v_entry.id,
    'started_at', v_entry.started_at,
    'client_id', v_entry.client_id,
    'task_id', v_entry.task_id,
    'stopped_entry_id', v_stopped.id,
    'stopped_minutes', v_stopped.minutes,
    'stopped_task_id', v_stopped.task_id,
    'stopped_client_id', v_stopped.client_id
  );
end;
$$;

comment on function public.start_timer(uuid, uuid, text, boolean) is
  'Starts the caller''s timer on a task, a client or nothing; a running timer is stopped first (one per person, §7.10).';

create or replace function public.stop_timer(p_description text default null)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_me uuid := public.staff_employee_id();
  v record;
begin
  if v_me is null then
    raise exception 'USER: Only the firm''s staff can run a timer.' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtext('time_entries.timer'), hashtext(v_me::text));
  update public.time_entries
     set ended_at = greatest(now(), started_at),
         description = coalesce(left(nullif(btrim(coalesce(p_description, '')), ''), 500), description)
   where employee_id = v_me and ended_at is null
  returning id, task_id, client_id, minutes, started_at, ended_at into v;
  if not found then
    raise exception 'USER: No timer is running.' using errcode = 'P0001';
  end if;
  return jsonb_build_object('entry_id', v.id, 'task_id', v.task_id, 'client_id', v.client_id, 'minutes', v.minutes,
                            'started_at', v.started_at, 'ended_at', v.ended_at);
end;
$$;

comment on function public.stop_timer(text) is 'Stops the caller''s running timer and returns its minutes (§7.10).';

-- =============================================================================================
-- approve_timesheet_week / reopen_timesheet_week
-- =============================================================================================
create or replace function public.timesheet_week_scope_check(p_employee_id uuid, p_week_start date)
returns void
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_role public.app_role := public.app_role();
  v_me uuid := public.staff_employee_id();
  v_target_role public.app_role;
begin
  if v_role is null or v_role not in ('partner', 'manager') then
    raise exception 'USER: Only a Partner or Manager can approve or reopen a timesheet week.' using errcode = 'P0001';
  end if;
  if p_week_start is null or extract(isodow from p_week_start) <> 1 then
    raise exception 'USER: Choose the week by its Monday.' using errcode = 'P0001';
  end if;
  select coalesce(p.role, e.staff_role) into v_target_role
    from public.employees e left join public.profiles p on p.id = e.profile_id
   where e.id = p_employee_id and e.deleted_at is null;
  if not found then
    raise exception 'USER: That person isn''t on the team.' using errcode = 'P0001';
  end if;
  if v_role = 'manager' then
    if p_employee_id = v_me then
      raise exception 'USER: Nobody approves their own timesheet. Ask another Manager or a Partner.' using errcode = 'P0001';
    end if;
    if v_target_role <> 'employee' then
      raise exception 'USER: A Manager approves Employees'' weeks. Ask a Partner to approve this one.' using errcode = 'P0001';
    end if;
  end if;
end;
$$;

comment on function public.timesheet_week_scope_check(uuid, date) is
  'Who may approve or reopen a person''s week: Partners anyone''s; Managers Employees'' but never their own (§7.10).';

create or replace function public.approve_timesheet_week(p_employee_id uuid, p_week_start date, p_note text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_from timestamptz;
  v_to timestamptz;
  v_id uuid;
  v_locked int;
  v_entries int;
  v_minutes int;
begin
  perform public.timesheet_week_scope_check(p_employee_id, p_week_start);
  if p_week_start > public.today_ist() then
    raise exception 'USER: That week hasn''t started yet.' using errcode = 'P0001';
  end if;
  v_from := (p_week_start::timestamp at time zone 'Asia/Kolkata');
  v_to := ((p_week_start + 7)::timestamp at time zone 'Asia/Kolkata');

  if exists (
    select 1 from public.time_entries te
    where te.employee_id = p_employee_id and te.ended_at is null and te.started_at < v_to
  ) then
    raise exception 'USER: A timer is still running in this week. Stop it first.' using errcode = 'P0001';
  end if;

  insert into public.timesheet_week_approvals (employee_id, week_start, approved_by, note)
  values (p_employee_id, p_week_start, auth.uid(), left(nullif(btrim(coalesce(p_note, '')), ''), 500))
  on conflict (employee_id, week_start) do nothing
  returning id into v_id;
  if v_id is null then
    raise exception 'USER: This week is already approved.' using errcode = 'P0001';
  end if;

  update public.time_entries
     set locked = true
   where employee_id = p_employee_id and started_at >= v_from and started_at < v_to and not locked;
  get diagnostics v_locked = row_count;

  select count(*)::int, coalesce(sum(minutes), 0)::int into v_entries, v_minutes
    from public.time_entries
   where employee_id = p_employee_id and started_at >= v_from and started_at < v_to;

  return jsonb_build_object('approval_id', v_id, 'entries', v_entries, 'minutes', v_minutes, 'locked', v_locked);
end;
$$;

comment on function public.approve_timesheet_week(uuid, date, text) is
  'Partner/Manager: approves a person''s week (Mon–Sun IST) and locks its entries (§7.10). Refused while a timer runs in it.';

create or replace function public.reopen_timesheet_week(p_employee_id uuid, p_week_start date, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_from timestamptz;
  v_to timestamptz;
  v_id uuid;
  v_unlocked int;
  v_billed int;
begin
  perform public.timesheet_week_scope_check(p_employee_id, p_week_start);
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'USER: Give a reason for reopening this week.' using errcode = 'P0001';
  end if;
  v_from := (p_week_start::timestamp at time zone 'Asia/Kolkata');
  v_to := ((p_week_start + 7)::timestamp at time zone 'Asia/Kolkata');

  delete from public.timesheet_week_approvals
   where employee_id = p_employee_id and week_start = p_week_start
  returning id into v_id;
  if v_id is null then
    raise exception 'USER: This week isn''t approved.' using errcode = 'P0001';
  end if;

  update public.time_entries
     set locked = false
   where employee_id = p_employee_id and started_at >= v_from and started_at < v_to and locked and invoice_id is null;
  get diagnostics v_unlocked = row_count;

  select count(*)::int into v_billed
    from public.time_entries
   where employee_id = p_employee_id and started_at >= v_from and started_at < v_to and invoice_id is not null;

  return jsonb_build_object('approval_id', v_id, 'unlocked', v_unlocked, 'billed_still_locked', v_billed);
end;
$$;

comment on function public.reopen_timesheet_week(uuid, date, text) is
  'Partner/Manager: reopens an approved week (with a reason) and unlocks its entries that aren''t billed (§7.10).';

-- =============================================================================================
-- Unbilled time (§7.10, §7.9.2): Partners and Managers only; Employees get no rows.
-- =============================================================================================
create or replace view public.unbilled_time_entries with (security_invoker = true) as
select
  te.id,
  te.client_id,
  c.display_name as client_name,
  c.client_code::text as client_code,
  te.employee_id,
  e.full_name as employee_name,
  te.task_id,
  t.task_number,
  t.title as task_title,
  te.description,
  te.started_at,
  te.ended_at,
  te.minutes,
  e.billing_rate_per_hour,
  case when e.billing_rate_per_hour is null then null else round(te.minutes * e.billing_rate_per_hour / 60.0, 2) end as amount
from public.time_entries te
join public.clients c on c.id = te.client_id and c.deleted_at is null
join public.employees e on e.id = te.employee_id
left join public.tasks t on t.id = te.task_id
where ((select public.is_manager_or_partner()) or not (select public.is_api_caller()))
  and te.billable
  and te.invoice_id is null
  and te.ended_at is not null
  and te.minutes > 0;

comment on view public.unbilled_time_entries is
  'Billable, finished, uninvoiced client time with its ₹ value (minutes × billing rate ÷ 60, half-up to the paisa). Partners/Managers only (§7.10, §4.1).';

create or replace view public.unbilled_time_by_client with (security_invoker = true) as
select
  u.client_id,
  u.client_name,
  u.client_code,
  count(*)::int as entries,
  sum(u.minutes)::int as minutes,
  sum(u.amount) as amount,
  coalesce(sum(u.minutes) filter (where u.billing_rate_per_hour is null), 0)::int as unrated_minutes,
  count(distinct u.employee_id)::int as people,
  min(u.started_at) as oldest_started_at,
  max(u.started_at) as latest_started_at
from public.unbilled_time_entries u
group by u.client_id, u.client_name, u.client_code;

comment on view public.unbilled_time_by_client is
  'Unbilled time per client: minutes, ₹ value (sum of the entries'' values), minutes with no billing rate, oldest entry. Partners/Managers only (§7.10).';

revoke all on public.unbilled_time_entries, public.unbilled_time_by_client from anon, public;
revoke insert, update, delete, truncate, references, trigger on public.unbilled_time_entries, public.unbilled_time_by_client from authenticated;
grant select on public.unbilled_time_entries, public.unbilled_time_by_client to authenticated, service_role;

-- =============================================================================================
-- Grants
-- =============================================================================================
revoke execute on function
  public.ist_week_start(timestamptz),
  public.start_timer(uuid, uuid, text, boolean),
  public.stop_timer(text),
  public.timesheet_week_scope_check(uuid, date),
  public.approve_timesheet_week(uuid, date, text),
  public.reopen_timesheet_week(uuid, date, text)
from public, anon;
grant execute on function
  public.ist_week_start(timestamptz),
  public.start_timer(uuid, uuid, text, boolean),
  public.stop_timer(text),
  public.timesheet_week_scope_check(uuid, date),
  public.approve_timesheet_week(uuid, date, text),
  public.reopen_timesheet_week(uuid, date, text)
to authenticated, service_role;
