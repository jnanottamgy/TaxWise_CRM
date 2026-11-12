-- 0244 · A day's time has to be possible (§7.10). Found by the end-to-end break-it run: a timer left
-- on overnight logged 30 hours, one day could hold 67 hours, two timed entries could cover the same
-- minutes, and all of it counted as billable unbilled time at the person's rate.
--
-- time_entries_sanity runs after time_entries_guard (triggers fire in name order, so the minutes and
-- the end time are already worked out) and, for every caller:
--   1. a timer being stopped after more than 12 hours is counted as 12 hours and says so on the entry
--      (the person corrects it if the work was shorter or longer);
--   2. a person's entries for one day (IST) can't add up to more than 24 hours;
--   3. two timed entries of one person can't overlap (a duration-only entry carries no real times).
-- Changes that don't touch the time itself (billing marks, week approval) never trip it.
--
-- Also records the schema version (§0.1 rule 1): lib/env.ts EXPECTED_SCHEMA_VERSION matches it.

set search_path = public, extensions;

create or replace function public.time_entries_sanity()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_day date;
  v_from timestamptz;
  v_total int;
  v_clash record;
begin
  if tg_op = 'UPDATE'
     and new.started_at is not distinct from old.started_at
     and new.ended_at is not distinct from old.ended_at
     and new.minutes is not distinct from old.minutes
     and new.employee_id is not distinct from old.employee_id then
    return new;
  end if;

  -- 1. A timer nobody stopped.
  if tg_op = 'UPDATE' and new.entry_source = 'timer' and old.ended_at is null and new.ended_at is not null and new.minutes > 720 then
    new.ended_at := new.started_at + interval '12 hours';
    new.minutes := 720;
    new.description := left(
      concat_ws(' ', nullif(btrim(coalesce(new.description, '')), ''), '(Timer left running: counted as 12 hours. Correct it if the work was shorter or longer.)'),
      500
    );
  end if;

  if new.ended_at is null then
    return new; -- a running timer has no length yet
  end if;

  -- 2. No more than 24 hours in one day.
  v_day := (new.started_at at time zone 'Asia/Kolkata')::date;
  v_from := v_day::timestamp at time zone 'Asia/Kolkata';
  select coalesce(sum(t.minutes), 0) into v_total
    from public.time_entries t
   where t.employee_id = new.employee_id
     and t.id <> new.id
     and t.ended_at is not null
     and t.started_at >= v_from
     and t.started_at < v_from + interval '1 day';
  if v_total + new.minutes > 1440 then
    raise exception 'USER: That would make % h % min on %, more than 24 hours in a day. Check that day''s entries.',
      (v_total + new.minutes) / 60, (v_total + new.minutes) % 60, to_char(v_day, 'DD Mon YYYY')
      using errcode = 'P0001';
  end if;

  -- 3. Timed entries don't overlap.
  if new.entry_source <> 'manual_duration' then
    select t.started_at, t.ended_at into v_clash
      from public.time_entries t
     where t.employee_id = new.employee_id
       and t.id <> new.id
       and t.entry_source <> 'manual_duration'
       and t.ended_at is not null
       and t.started_at < new.ended_at
       and t.ended_at > new.started_at
     order by t.started_at
     limit 1;
    if found then
      raise exception 'USER: This overlaps another entry (% to %). Change the times, or log it as a duration.',
        to_char(v_clash.started_at at time zone 'Asia/Kolkata', 'DD Mon HH24:MI'),
        to_char(v_clash.ended_at at time zone 'Asia/Kolkata', 'HH24:MI')
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

comment on function public.time_entries_sanity() is
  'After time_entries_guard: caps a timer stopped after 12 hours, refuses more than 24 hours in an IST day and overlapping timed entries (§7.10).';

drop trigger if exists time_entries_sanity on public.time_entries;
create trigger time_entries_sanity before insert or update on public.time_entries
  for each row execute function public.time_entries_sanity();

revoke execute on function public.time_entries_sanity() from public, anon, authenticated;

update public.app_meta set value = '0244' where key = 'schema_version';
