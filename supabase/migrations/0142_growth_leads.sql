-- 0142 · Leads (§7.5.1): stage moves, the close date the analytics need, and the follow-up
-- bookkeeping of the lead reminders job.
--
--   leads.lost_category        why a lead was lost, as a category the win/loss analysis groups by
--                              (lost_reason stays the free-text reason §5.4 requires)
--   leads.status_changed_at    when the stage last changed
--   leads.closed_at            when it was Won or Lost (cleared if it is reopened): "average days to
--                              win" is closed_at − created_at over won leads
--   leads.follow_up_reminded_for  the next_follow_up_at a reminder went out for (server/jobs/lead-follow-ups.ts)
--   leads.stale_notified_at    when "untouched for 14 days" was last surfaced for this lead
--
--   leads_stage_guard (trigger)  keeps status_changed_at / closed_at, clears the lost reason when a
--       lead is reopened, refuses to move a converted lead off Won or to repoint its client, and
--       refuses a Lost lead without a reason in plain words (the 0005 check stays as the backstop).
--   leads_touch_activity (replaces 0017)  the job's own bookkeeping no longer counts as activity,
--       so a reminder never makes a stale lead look touched.

set search_path = public, extensions;

alter table public.leads
  add column if not exists lost_category text,
  add column if not exists status_changed_at timestamptz not null default now(),
  add column if not exists closed_at timestamptz,
  add column if not exists follow_up_reminded_for timestamptz,
  add column if not exists stale_notified_at timestamptz;

alter table public.leads drop constraint if exists leads_lost_category_values;
alter table public.leads add constraint leads_lost_category_values
  check (lost_category is null or lost_category in ('fees', 'competitor', 'no_response', 'not_a_fit', 'timing', 'in_house', 'other'));

-- Existing rows: closed when Won / Lost.
update public.leads set closed_at = coalesce(closed_at, updated_at) where status in ('won', 'lost') and closed_at is null;

comment on column public.leads.lost_category is 'Why the lead was lost (fees, competitor, no_response, not_a_fit, timing, in_house, other): the win/loss analysis groups by it (§7.5.1).';
comment on column public.leads.closed_at is 'When the lead was Won or Lost; null while open. Average days to win = closed_at − created_at (§7.5.1).';
comment on column public.leads.follow_up_reminded_for is 'The next_follow_up_at value a reminder was sent for (lead follow-ups job, §7.5.1).';
comment on column public.leads.stale_notified_at is 'When the lead was last surfaced as untouched for 14 days (§7.5.1).';

-- =============================================================================================
-- leads_stage_guard
-- =============================================================================================
create or replace function public.leads_stage_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  -- Someone who may not write leads can't: leave the row as it is and let RLS refuse it.
  if public.is_api_caller() and not public.is_manager_or_partner() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.status_changed_at := now();
    new.closed_at := case when new.status in ('won', 'lost') then now() end;
    if new.status <> 'lost' then
      new.lost_category := null;
    elsif nullif(btrim(new.lost_reason), '') is null then
      raise exception 'USER: Say why the lead was lost.' using errcode = 'P0001';
    end if;
    return new;
  end if;

  if old.converted_client_id is not null then
    if new.status is distinct from old.status and new.status <> 'won' then
      raise exception 'USER: This lead has become a client, so it stays Won.' using errcode = 'P0001';
    end if;
    if new.converted_client_id is not null and new.converted_client_id is distinct from old.converted_client_id then
      raise exception 'USER: This lead has already been converted to a client.' using errcode = 'P0001';
    end if;
  end if;

  if new.status is distinct from old.status then
    new.status_changed_at := now();
    new.closed_at := case when new.status in ('won', 'lost') then now() end;
  end if;

  if new.status = 'lost' then
    if nullif(btrim(new.lost_reason), '') is null then
      raise exception 'USER: Say why the lead was lost.' using errcode = 'P0001';
    end if;
  else
    new.lost_reason := null;
    new.lost_category := null;
  end if;
  return new;
end;
$$;

comment on function public.leads_stage_guard() is
  'Trigger: keeps status_changed_at and closed_at, clears the lost reason on reopening, keeps a converted lead Won and its client fixed, and asks for a reason when Lost (§7.5.1).';

drop trigger if exists leads_stage_guard on public.leads;
create trigger leads_stage_guard before insert or update on public.leads
  for each row execute function public.leads_stage_guard();

-- =============================================================================================
-- leads_touch_activity (replaces 0017): bookkeeping writes don't count as activity
-- =============================================================================================
create or replace function public.leads_touch_activity()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if (to_jsonb(new) - array['follow_up_reminded_for', 'stale_notified_at', 'updated_at', 'last_activity_at'])
     is not distinct from (to_jsonb(old) - array['follow_up_reminded_for', 'stale_notified_at', 'updated_at', 'last_activity_at']) then
    return new;
  end if;
  if new.last_activity_at is not distinct from old.last_activity_at then
    new.last_activity_at := now();
  end if;
  return new;
end;
$$;

create index if not exists leads_closed_at_idx on public.leads (closed_at) where deleted_at is null;
create index if not exists leads_status_changed_idx on public.leads (status, status_changed_at) where deleted_at is null;
create index if not exists leads_follow_up_due_idx on public.leads (next_follow_up_at)
  where deleted_at is null and status not in ('won', 'lost') and next_follow_up_at is not null;

revoke execute on function public.leads_stage_guard(), public.leads_touch_activity() from public, anon, authenticated;
