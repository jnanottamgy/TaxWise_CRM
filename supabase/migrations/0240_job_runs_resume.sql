-- 0240 · Scheduled jobs that continue on the next check (§8, §7.24).
--
-- Hosts cap how long one request may run (Netlify: about 10 seconds), so the scheduler
-- (app/api/cron/tick, every 15 minutes) gives each call a time budget. A job that loops over many
-- records (the monthly compliance top-up, recurring tasks on the 1st) stops when the budget runs out
-- and returns where it got to; the run row keeps that cursor, and the next check resumes from it
-- (server/jobs/due.ts). NULL means the run finished its work.
--
-- Also records the schema version (§0.1 rule 1): lib/env.ts EXPECTED_SCHEMA_VERSION matches it.

set search_path = public, extensions;

alter table public.job_runs add column if not exists resume_cursor text;

comment on column public.job_runs.resume_cursor is
  'Where a run that stopped at its time budget got to; the scheduler continues from it on its next check. NULL: the run finished its work.';

insert into public.app_meta (key, value) values ('schema_version', '0240')
on conflict (key) do update set value = excluded.value;
