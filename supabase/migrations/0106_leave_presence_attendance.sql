-- 0106 · Leave decisions, attendance marking and presence sessions (§5.2, §7.11.3, §7.12, §18.3).
--
--   decide_leave(id, decision, note, token)   the only way leave is approved or declined: Managers
--                                             decide Employees' leave, Partners decide Managers' and
--                                             Partners' (and Employees'); nobody decides their own.
--                                             Approval marks every working day of the leave On leave
--                                             in attendance_records (leave wins over everything).
--   cancel_leave(id, token)                   the requester (a request any time, approved leave only
--                                             before it starts) or their approver; cancelling approved
--                                             leave clears the On leave days still ahead.
--   employee_leave_attendance                 every writer: approved leave marks its working days
--                                             On leave; leave that stops being approved clears the
--                                             On leave days still ahead.
--   employee_leave_status_guard               API callers: nobody decides their own leave, only a
--                                             Requested leave is decided (and records who decided),
--                                             a decided leave's dates don't change.
--   employee_sessions_one_open                one open presence session per person (§7.12: a beat
--                                             with no open session opens one; two at once can't).
--
-- The wording of every refusal matches lib/domain/leave.ts (canDecideLeaveFor, canDecideLeaveStatus,
-- canCancelLeave).

set search_path = public, extensions;

-- =============================================================================================
-- Working days of a leave (weekdays from firm_settings, holidays table), for attendance marking.
-- =============================================================================================
create or replace function public.leave_working_dates(p_start date, p_end date)
returns setof date
language sql
stable
security definer
set search_path = public, extensions
as $$
  select d::date
  from generate_series(p_start, p_end, interval '1 day') as d
  where extract(isodow from d)::smallint = any (
          coalesce((select fs.working_weekdays from public.firm_settings fs where fs.id = 1), '{1,2,3,4,5,6}'::smallint[]))
    and not exists (select 1 from public.holidays h where h.date = d::date)
$$;

comment on function public.leave_working_dates(date, date) is
  'The working days between two dates, inclusive: firm working weekdays, not firm holidays (§7.11.3, §7.12).';

-- =============================================================================================
-- Attendance follows approved leave, for every writer (§7.11.3 "Approved leave marks attendance
-- On leave", §7.12 "Approved leave → On leave (wins over everything)").
--   approved            → every working day of the leave is On leave (a deliberate correction stays);
--   no longer approved  → the On leave days still ahead go back to normal; days already past stay as
--                         recorded (a Partner or Manager corrects them, with a reason, if they worked).
-- =============================================================================================
create or replace function public.mark_leave_attendance(p_employee uuid, p_start date, p_end date, p_half_day boolean)
returns int
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_count int := 0;
begin
  insert into public.attendance_records (employee_id, date, status, notes)
  select p_employee, d, 'on_leave', case when p_half_day then 'Half-day leave' else 'Approved leave' end
  from public.leave_working_dates(p_start, p_end) as d
  on conflict (employee_id, date) do update
    set status = 'on_leave', notes = excluded.notes
    where attendance_records.corrected_by is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.clear_leave_attendance(p_employee uuid, p_start date, p_end date)
returns int
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_count int := 0;
begin
  delete from public.attendance_records a
   where a.employee_id = p_employee
     and a.date between greatest(p_start, public.today_ist()) and p_end
     and a.status = 'on_leave'
     and a.corrected_by is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.employee_leave_attendance()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'approved' then
      perform public.mark_leave_attendance(new.employee_id, new.start_date, new.end_date, new.half_day);
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.status = 'approved' then
      perform public.clear_leave_attendance(old.employee_id, old.start_date, old.end_date);
    end if;
    return old;
  end if;
  if old.status = 'approved' and (new.status <> 'approved'
       or (new.start_date, new.end_date) is distinct from (old.start_date, old.end_date)) then
    perform public.clear_leave_attendance(old.employee_id, old.start_date, old.end_date);
  end if;
  if new.status = 'approved' and (old.status <> 'approved'
       or (new.start_date, new.end_date, new.half_day) is distinct from (old.start_date, old.end_date, old.half_day)) then
    perform public.mark_leave_attendance(new.employee_id, new.start_date, new.end_date, new.half_day);
  end if;
  return new;
end;
$$;

create trigger employee_leave_attendance after insert or update or delete on public.employee_leave
  for each row execute function public.employee_leave_attendance();

-- =============================================================================================
-- employee_leave_status_guard (API callers; 0032/0044 already decide who manages whose leave):
--   nobody decides their own leave, whatever their role; only a request still Requested is decided,
--   and the decision records who made it; a decided leave's dates don't change (cancel and ask
--   again); a new leave starts as a request.
-- =============================================================================================
create or replace function public.employee_leave_status_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if not public.is_api_caller() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'requested' or new.decided_by is not null or new.decided_at is not null then
      raise exception 'USER: Leave starts as a request. Approve it from the Leave page, which also marks attendance.' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if new.status is distinct from old.status and new.status in ('approved', 'declined') then
    if old.employee_id = public.my_employee_id() then
      raise exception 'USER: You can''t decide your own leave. Another approver decides it.' using errcode = 'P0001';
    end if;
    if old.status <> 'requested' then
      raise exception 'USER: This leave is already %, so it can''t be decided again.', old.status using errcode = 'P0001';
    end if;
    new.decided_by := auth.uid();
    new.decided_at := now();
  end if;
  if old.status <> 'requested' and (new.start_date, new.end_date, new.half_day, new.type)
       is distinct from (old.start_date, old.end_date, old.half_day, old.type) then
    raise exception 'USER: Only a leave request that hasn''t been decided can be changed. Cancel it and ask again.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger employee_leave_status_guard before insert or update on public.employee_leave
  for each row execute function public.employee_leave_status_guard();

-- =============================================================================================
-- decide_leave: the Leave page's Approve / Decline, with the §7.11.3 rules in one place and the
-- concurrency check (§13). Attendance follows through employee_leave_attendance.
-- =============================================================================================
create or replace function public.decide_leave(p_leave_id uuid, p_decision text, p_note text, p_updated_at timestamptz)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_role public.app_role := public.app_role();
  v_uid uuid := auth.uid();
  v_me uuid := public.my_employee_id();
  v_leave public.employee_leave%rowtype;
  v_subject_role public.app_role;
  v_updated timestamptz;
  v_marked int := 0;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_role is null or v_role not in ('partner', 'manager') then
    raise exception 'USER: Only Managers and Partners decide leave requests.' using errcode = 'P0001';
  end if;
  if p_decision is null or p_decision not in ('approved', 'declined') then
    raise exception 'USER: Choose Approve or Decline.' using errcode = 'P0001';
  end if;
  if v_note is not null and length(v_note) > 1000 then
    raise exception 'USER: Keep the decision note under 1,000 characters.' using errcode = 'P0001';
  end if;

  select * into v_leave from public.employee_leave l where l.id = p_leave_id for update;
  if not found then
    raise exception 'USER: That leave request no longer exists.' using errcode = 'P0001';
  end if;
  if v_me is not null and v_leave.employee_id = v_me then
    raise exception 'USER: You can''t decide your own leave. Another approver decides it.' using errcode = 'P0001';
  end if;
  v_subject_role := public.employee_role(v_leave.employee_id);
  if v_role = 'manager' and v_subject_role is distinct from 'employee' then
    raise exception 'USER: A Partner decides leave for Managers and Partners.' using errcode = 'P0001';
  end if;
  if v_leave.status <> 'requested' then
    raise exception 'USER: This leave is already %, so it can''t be decided again.', v_leave.status using errcode = 'P0001';
  end if;
  if p_updated_at is null or v_leave.updated_at <> p_updated_at then
    raise exception 'USER: This leave request was changed at %, after you opened it. Reload to see the changes.',
      to_char(v_leave.updated_at at time zone 'Asia/Kolkata', 'HH24:MI') using errcode = 'P0001';
  end if;

  update public.employee_leave
     set status = p_decision::public.leave_status,
         decided_by = v_uid,
         decided_at = now(),
         decision_note = v_note
   where id = p_leave_id
  returning updated_at into v_updated;

  if p_decision = 'approved' then
    select count(*) into v_marked from public.attendance_records a
    where a.employee_id = v_leave.employee_id and a.status = 'on_leave'
      and a.date between v_leave.start_date and v_leave.end_date;
  end if;

  return jsonb_build_object(
    'status', p_decision,
    'updated_at', v_updated,
    'employee_id', v_leave.employee_id,
    'days_marked', v_marked
  );
end;
$$;

comment on function public.decide_leave(uuid, text, text, timestamptz) is
  '§7.11.3: approve or decline a leave request (Managers: Employees; Partners: everyone; never your own). Approval marks the working days On leave.';

-- =============================================================================================
-- cancel_leave: the requester (a request any time, approved leave only before it starts) or their
-- approver (Managers: Employees; Partners: everyone).
-- =============================================================================================
create or replace function public.cancel_leave(p_leave_id uuid, p_updated_at timestamptz)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_role public.app_role := public.app_role();
  v_me uuid := public.my_employee_id();
  v_leave public.employee_leave%rowtype;
  v_own boolean;
  v_subject_role public.app_role;
  v_updated timestamptz;
  v_before int := 0;
  v_after int := 0;
begin
  if v_role is null or v_role not in ('partner', 'manager', 'employee') then
    raise exception 'USER: Only the firm''s staff can cancel leave.' using errcode = 'P0001';
  end if;
  select * into v_leave from public.employee_leave l where l.id = p_leave_id for update;
  if not found then
    raise exception 'USER: That leave request no longer exists.' using errcode = 'P0001';
  end if;
  v_own := v_me is not null and v_leave.employee_id = v_me;
  v_subject_role := public.employee_role(v_leave.employee_id);

  if not v_own then
    if v_role = 'employee' then
      raise exception 'USER: You can cancel only your own leave.' using errcode = 'P0001';
    end if;
    if v_role = 'manager' and v_subject_role is distinct from 'employee' then
      raise exception 'USER: A Partner manages leave for Managers and Partners.' using errcode = 'P0001';
    end if;
  end if;

  if v_leave.status not in ('requested', 'approved') then
    raise exception 'USER: This leave is already %.', v_leave.status using errcode = 'P0001';
  end if;
  if v_own and v_leave.status = 'approved' and v_leave.start_date <= public.today_ist() then
    raise exception 'USER: This leave has already started. Ask a Manager to correct it.' using errcode = 'P0001';
  end if;
  if p_updated_at is null or v_leave.updated_at <> p_updated_at then
    raise exception 'USER: This leave request was changed at %, after you opened it. Reload to see the changes.',
      to_char(v_leave.updated_at at time zone 'Asia/Kolkata', 'HH24:MI') using errcode = 'P0001';
  end if;

  select count(*) into v_before from public.attendance_records a
  where a.employee_id = v_leave.employee_id and a.status = 'on_leave' and a.date between v_leave.start_date and v_leave.end_date;
  update public.employee_leave set status = 'cancelled' where id = p_leave_id returning updated_at into v_updated;
  select count(*) into v_after from public.attendance_records a
  where a.employee_id = v_leave.employee_id and a.status = 'on_leave' and a.date between v_leave.start_date and v_leave.end_date;

  return jsonb_build_object('status', 'cancelled', 'updated_at', v_updated, 'employee_id', v_leave.employee_id,
                            'was', v_leave.status, 'days_cleared', v_before - v_after);
end;
$$;

comment on function public.cancel_leave(uuid, timestamptz) is
  '§7.11.3: cancels a leave request (the requester: a request any time, approved leave before it starts; Managers/Partners as approvers). Clears On leave days still ahead.';

-- =============================================================================================
-- One open presence session per person (§7.12). Older duplicates (if any) close at their last
-- activity first.
-- =============================================================================================
update public.employee_sessions s
   set is_active = false, logout_at = s.last_active_at, duration_minutes = s.active_minutes, closed_reason = 'stale'
 where s.is_active
   and s.id not in (
     select distinct on (x.employee_id) x.id
     from public.employee_sessions x
     where x.is_active
     order by x.employee_id, x.last_active_at desc
   );

create unique index employee_sessions_one_open on public.employee_sessions (employee_id) where is_active;
create index employee_sessions_open_last_active_idx on public.employee_sessions (last_active_at) where is_active;
create index attendance_records_employee_date_idx on public.attendance_records (employee_id, date desc);

-- =============================================================================================
-- Grants
-- =============================================================================================
revoke execute on function
  public.leave_working_dates(date, date),
  public.decide_leave(uuid, text, text, timestamptz),
  public.cancel_leave(uuid, timestamptz)
from public, anon;
grant execute on function
  public.leave_working_dates(date, date),
  public.decide_leave(uuid, text, text, timestamptz),
  public.cancel_leave(uuid, timestamptz)
to authenticated, service_role;

revoke execute on function
  public.mark_leave_attendance(uuid, date, date, boolean),
  public.clear_leave_attendance(uuid, date, date),
  public.employee_leave_attendance(),
  public.employee_leave_status_guard()
from public, anon, authenticated;
