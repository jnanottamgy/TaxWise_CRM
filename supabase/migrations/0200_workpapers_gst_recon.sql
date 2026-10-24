-- 0200 · GST reconciliation workpapers (§5.10, §6.12, §7.8.1): a run and its lines saved in one
-- transaction, resolutions with notes, IMS decisions, and what carries into the next month.
--
-- The app reads the stored GSTR-2B JSON and the purchase register itself, parses and reconciles
-- them on the server (lib/domain/gstr2b.ts, lib/domain/recon.ts) and saves the result here:
--
--   save_gst_recon_run(payload)        the run, every line, and the lines of the previous month's run
--                                      that this month's files clear ("the next month shows what
--                                      carried forward", §6.12). Security invoker: the caller's RLS
--                                      decides whether they may reconcile the client at all.
--   set_gst_recon_resolution(...)      mark lines resolved (accepted / follow up supplier / ignore /
--                                      open again) with a note, all or nothing, with the §13
--                                      concurrency check per line.
--   set_gst_recon_ims_action(...)      the IMS decision for one 2B document: accept, reject or keep
--                                      pending, with the reason (§6.7, §6.12 "IMS action list").
--
-- A saved run is a record: its results never change after the save (guard triggers). Only a line's
-- resolution and IMS decision move, and every move stamps who and when. Amounts inside
-- gst_recon_entries.data and gst_recon_runs.summary are integer paise, as the engine computes them.

set search_path = public, extensions;

-- =============================================================================================
-- Columns
-- =============================================================================================
alter table public.gst_recon_runs
  add column if not exists previous_run_id uuid references public.gst_recon_runs (id) on delete set null,
  add column if not exists register_document_id uuid references public.documents (id) on delete set null;

comment on column public.gst_recon_runs.previous_run_id is
  'The run whose open lines were carried into this one: the latest run of the latest earlier period (§6.12).';
comment on column public.gst_recon_runs.register_document_id is
  'The purchase register in the client''s document vault that this run reconciled (§7.8.1).';

alter table public.gst_recon_entries
  add column if not exists entry_key text,
  add column if not exists origin text not null default 'current',
  add column if not exists first_seen_period char(6),
  add column if not exists ims_action text,
  add column if not exists ims_reason text,
  add column if not exists ims_decided_by uuid,
  add column if not exists ims_decided_at timestamptz,
  add column if not exists resolved_by uuid,
  add column if not exists resolved_at timestamptz,
  add column if not exists cleared_by_run_id uuid references public.gst_recon_runs (id) on delete set null,
  add column if not exists updated_by uuid;

alter table public.gst_recon_entries
  add constraint gst_recon_entries_origin_values check (origin in ('current', 'carried')),
  add constraint gst_recon_entries_first_seen_format check (first_seen_period is null or first_seen_period ~ '^(0[1-9]|1[0-2])[0-9]{4}$'),
  add constraint gst_recon_entries_ims_action_values check (ims_action is null or ims_action in ('accept', 'reject', 'keep_pending')),
  add constraint gst_recon_entries_note_length check (resolution_note is null or char_length(resolution_note) <= 1000),
  add constraint gst_recon_entries_ims_reason_length check (ims_reason is null or char_length(ims_reason) <= 1000);

comment on column public.gst_recon_entries.entry_key is
  'Stable key of the line within its run (supplier GSTIN | debit/credit | loose document number), as lib/domain/recon.ts builds it.';
comment on column public.gst_recon_entries.origin is
  'current: from this month''s files; carried: an open line of an earlier month that this month''s files didn''t clear (§6.12).';
comment on column public.gst_recon_entries.first_seen_period is 'MMYYYY of the run the line first appeared in.';
comment on column public.gst_recon_entries.ims_action is
  'The IMS action for a 2B document (accept, reject, keep_pending): suggested by the engine until a person decides (ims_decided_by).';
comment on column public.gst_recon_entries.cleared_by_run_id is
  'The later run whose files cleared this open line (the supplier reported it, or it was booked).';

create index if not exists gst_recon_entries_run_key_idx on public.gst_recon_entries (run_id, entry_key);
create index if not exists gst_recon_entries_cleared_by_idx on public.gst_recon_entries (cleared_by_run_id) where cleared_by_run_id is not null;
create index if not exists gst_recon_runs_previous_idx on public.gst_recon_runs (previous_run_id) where previous_run_id is not null;

-- =============================================================================================
-- Guards: results are fixed at the save; resolutions and IMS decisions are stamped.
-- =============================================================================================
create or replace function public.gst_recon_runs_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if not public.is_api_caller() then
    return new;
  end if;
  if new.client_id is distinct from old.client_id
     or new.period is distinct from old.period
     or new.portal_gstin is distinct from old.portal_gstin
     or new.summary is distinct from old.summary
     or new.diagnostics is distinct from old.diagnostics
     or new.source_files is distinct from old.source_files
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at
     or new.previous_run_id is distinct from old.previous_run_id
     or new.register_document_id is distinct from old.register_document_id then
    raise exception 'USER: A saved reconciliation can''t be changed. Run it again to replace its results.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

comment on function public.gst_recon_runs_guard() is
  'Trigger: a saved GST reconciliation run is a record; its results never change (§6.12 "runs are saved, with history").';

drop trigger if exists gst_recon_runs_guard on public.gst_recon_runs;
create trigger gst_recon_runs_guard before update on public.gst_recon_runs
  for each row execute function public.gst_recon_runs_guard();

create or replace function public.gst_recon_entries_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if not public.is_api_caller() then
    return new;
  end if;
  if new.run_id is distinct from old.run_id
     or new.bucket is distinct from old.bucket
     or new.match_tier is distinct from old.match_tier
     or new.supplier_gstin is distinct from old.supplier_gstin
     or new.supplier_name is distinct from old.supplier_name
     or new.data is distinct from old.data
     or new.entry_key is distinct from old.entry_key
     or new.origin is distinct from old.origin
     or new.first_seen_period is distinct from old.first_seen_period
     or new.created_at is distinct from old.created_at then
    raise exception 'USER: A reconciliation line can''t be changed, only resolved. Run the reconciliation again to replace it.' using errcode = 'P0001';
  end if;

  if new.resolution is distinct from old.resolution or new.resolution_note is distinct from old.resolution_note then
    if coalesce(new.resolution, 'open') = 'open' then
      new.resolved_by := null;
      new.resolved_at := null;
    else
      new.resolved_by := auth.uid();
      new.resolved_at := now();
    end if;
  end if;

  if new.ims_action is distinct from old.ims_action or new.ims_reason is distinct from old.ims_reason then
    new.ims_decided_by := auth.uid();
    new.ims_decided_at := now();
  elsif new.ims_decided_by is distinct from old.ims_decided_by or new.ims_decided_at is distinct from old.ims_decided_at then
    raise exception 'USER: Record an IMS decision with its action and reason.' using errcode = 'P0001';
  end if;

  new.updated_by := auth.uid();
  return new;
end;
$$;

comment on function public.gst_recon_entries_guard() is
  'Trigger: a reconciliation line''s results are fixed; resolution and IMS decision changes stamp who and when (§6.12, §7.8.1).';

drop trigger if exists gst_recon_entries_guard on public.gst_recon_entries;
create trigger gst_recon_entries_guard before update on public.gst_recon_entries
  for each row execute function public.gst_recon_entries_guard();

revoke execute on function public.gst_recon_runs_guard(), public.gst_recon_entries_guard() from public, anon, authenticated;

-- =============================================================================================
-- "Changed by Anita at 12:41. Reload to see their changes." (§13) for a line the caller can see.
-- =============================================================================================
create or replace function public.gst_recon_entry_conflict(p_entry_id uuid)
returns text
language sql
stable
security definer
set search_path = public, extensions
as $$
  select format(
    'USER: Changed by %s at %s. Reload to see their changes.',
    coalesce(p.full_name, 'someone else'),
    to_char(e.updated_at at time zone 'Asia/Kolkata', 'HH24:MI')
  )
  from public.gst_recon_entries e
  join public.gst_recon_runs r on r.id = e.run_id
  left join public.profiles p on p.id = e.updated_by
  where e.id = p_entry_id
    and public.is_staff()
    and public.can_see_client(r.client_id)
$$;

comment on function public.gst_recon_entry_conflict(uuid) is
  'The concurrency refusal for a reconciliation line: who changed it last and when (§13).';

-- =============================================================================================
-- save_gst_recon_run(payload)
-- =============================================================================================
create or replace function public.save_gst_recon_run(p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_client uuid := nullif(p_payload->>'client_id', '')::uuid;
  v_period text := nullif(btrim(coalesce(p_payload->>'period', '')), '');
  v_prev uuid := nullif(p_payload->>'previous_run_id', '')::uuid;
  v_doc uuid := nullif(p_payload->>'register_document_id', '')::uuid;
  v_entries jsonb := p_payload->'entries';
  v_clear jsonb := coalesce(p_payload->'clear_previous', '[]'::jsonb);
  v_run uuid;
  v_created timestamptz;
  v_count int;
  v_cleared int := 0;
  v_reopened int := 0;
  v_prev_period text;
begin
  if not public.is_staff() then
    raise exception 'USER: Only the firm''s staff can save a GST reconciliation.' using errcode = 'P0001';
  end if;
  if v_client is null or not public.can_see_client(v_client)
     or not exists (select 1 from public.clients c where c.id = v_client and c.deleted_at is null) then
    raise exception 'USER: That client isn''t one of yours, or it is in the recycle bin.' using errcode = 'P0001';
  end if;
  if v_period is null or v_period !~ '^(0[1-9]|1[0-2])[0-9]{4}$' then
    raise exception 'USER: Choose the month the reconciliation is for.' using errcode = 'P0001';
  end if;
  if v_entries is null or jsonb_typeof(v_entries) <> 'array' then
    raise exception 'USER: The reconciliation has no lines to save.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(v_entries) > 50000 then
    raise exception 'USER: This reconciliation has more than 50,000 documents. Split the purchase register by month and run it again.' using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_clear) <> 'array' then
    raise exception 'USER: The carried-forward lines are not in the expected form.' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_payload->'summary') is distinct from 'object' then
    raise exception 'USER: The reconciliation summary is missing.' using errcode = 'P0001';
  end if;

  if v_prev is not null then
    select r.period into v_prev_period from public.gst_recon_runs r where r.id = v_prev and r.client_id = v_client;
    if v_prev_period is null then
      raise exception 'USER: The earlier reconciliation to carry forward from isn''t this client''s.' using errcode = 'P0001';
    end if;
    if to_date(v_prev_period, 'MMYYYY') >= to_date(v_period, 'MMYYYY') then
      raise exception 'USER: Open lines carry forward only from an earlier month.' using errcode = 'P0001';
    end if;
  end if;

  if v_doc is not null and not exists (select 1 from public.documents d where d.id = v_doc and d.client_id = v_client) then
    raise exception 'USER: The purchase register isn''t in this client''s documents.' using errcode = 'P0001';
  end if;

  insert into public.gst_recon_runs (client_id, period, portal_gstin, summary, diagnostics, source_files, created_by, previous_run_id, register_document_id)
  values (
    v_client,
    v_period,
    nullif(btrim(coalesce(p_payload->>'portal_gstin', '')), ''),
    p_payload->'summary',
    p_payload->'diagnostics',
    p_payload->'source_files',
    auth.uid(),
    v_prev,
    v_doc
  )
  returning id, created_at into v_run, v_created;

  insert into public.gst_recon_entries (
    run_id, entry_key, bucket, match_tier, supplier_gstin, supplier_name, data,
    resolution, resolution_note, ims_action, ims_reason, origin, first_seen_period, resolved_by, resolved_at
  )
  select
    v_run,
    nullif(e->>'entry_key', ''),
    e->>'bucket',
    nullif(e->>'match_tier', ''),
    coalesce(e->>'supplier_gstin', ''),
    nullif(btrim(coalesce(e->>'supplier_name', '')), ''),
    coalesce(e->'data', '{}'::jsonb),
    coalesce(nullif(e->>'resolution', ''), 'open'),
    nullif(btrim(coalesce(e->>'resolution_note', '')), ''),
    nullif(e->>'ims_action', ''),
    nullif(btrim(coalesce(e->>'ims_reason', '')), ''),
    coalesce(nullif(e->>'origin', ''), 'current'),
    coalesce(nullif(e->>'first_seen_period', ''), v_period),
    case when coalesce(nullif(e->>'resolution', ''), 'open') <> 'open' then auth.uid() end,
    case when coalesce(nullif(e->>'resolution', ''), 'open') <> 'open' then now() end
  from jsonb_array_elements(v_entries) e;
  get diagnostics v_count = row_count;

  if v_prev is not null then
    -- A re-run of this month replaces an earlier run of the same month: lines of the previous
    -- month that the earlier run cleared are open again until this run decides.
    update public.gst_recon_entries pe
    set resolution = 'open', resolution_note = null, cleared_by_run_id = null
    where pe.run_id = v_prev
      and pe.cleared_by_run_id is not null
      and pe.cleared_by_run_id <> v_run
      and pe.cleared_by_run_id in (select r.id from public.gst_recon_runs r where r.client_id = v_client and r.period = v_period);
    get diagnostics v_reopened = row_count;

    update public.gst_recon_entries pe
    set resolution = 'accepted',
        resolution_note = left(nullif(btrim(coalesce(c.note, '')), ''), 1000),
        cleared_by_run_id = v_run
    from (
      select (x->>'entry_id')::uuid as id, x->>'note' as note
      from jsonb_array_elements(v_clear) x
      where nullif(x->>'entry_id', '') is not null
    ) c
    where pe.id = c.id
      and pe.run_id = v_prev
      and pe.bucket <> 'matched'
      and coalesce(pe.resolution, 'open') in ('open', 'follow_up_supplier');
    get diagnostics v_cleared = row_count;
  end if;

  return jsonb_build_object('id', v_run, 'created_at', v_created, 'entries', v_count, 'cleared_previous', v_cleared, 'reopened_previous', v_reopened);
end;
$$;

comment on function public.save_gst_recon_run(jsonb) is
  'Saves a GST reconciliation run and all its lines in one transaction, and marks the previous month''s lines this run clears (§6.12, §7.8.1). Security invoker: RLS applies.';

-- =============================================================================================
-- set_gst_recon_resolution(run, [{id, updated_at}], resolution, note)
-- =============================================================================================
create or replace function public.set_gst_recon_resolution(p_run_id uuid, p_entries jsonb, p_resolution text, p_note text)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_ids uuid[];
  v_ts timestamptz[];
  v_wanted int;
  v_found int;
  v_conflict uuid;
  v_matched int;
  v_updated int;
begin
  if not public.is_staff() then
    raise exception 'USER: Only the firm''s staff can resolve reconciliation lines.' using errcode = 'P0001';
  end if;
  if p_resolution is null or p_resolution not in ('open', 'accepted', 'follow_up_supplier', 'ignore') then
    raise exception 'USER: Choose how the line is resolved.' using errcode = 'P0001';
  end if;
  if p_resolution = 'ignore' and v_note is null then
    raise exception 'USER: Say why the line is ignored, so the reviewer can see it.' using errcode = 'P0001';
  end if;
  if v_note is not null and char_length(v_note) > 1000 then
    raise exception 'USER: Keep the note under 1,000 characters.' using errcode = 'P0001';
  end if;
  if p_entries is null or jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) = 0 then
    raise exception 'USER: Choose the lines to resolve.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_entries) > 1000 then
    raise exception 'USER: Resolve at most 1,000 lines at a time.' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(w.id), '{}'), coalesce(array_agg(w.ts), '{}')
  into v_ids, v_ts
  from (
    select distinct on ((x->>'id')::uuid) (x->>'id')::uuid as id, nullif(x->>'updated_at', '')::timestamptz as ts
    from jsonb_array_elements(p_entries) x
    where nullif(x->>'id', '') is not null
  ) w;
  v_wanted := cardinality(v_ids);

  -- Lock the lines (RLS: only lines of a client the caller may see are found).
  perform 1 from public.gst_recon_entries e where e.run_id = p_run_id and e.id = any (v_ids) for update;
  select count(*) into v_found from public.gst_recon_entries e where e.run_id = p_run_id and e.id = any (v_ids);
  if v_wanted = 0 or v_found <> v_wanted then
    raise exception 'USER: Some of these lines are no longer in this reconciliation. Reload it.' using errcode = 'P0001';
  end if;

  select e.id into v_conflict
  from public.gst_recon_entries e
  join unnest(v_ids, v_ts) as w(id, ts) on w.id = e.id
  where e.run_id = p_run_id and w.ts is not null and e.updated_at <> w.ts
  limit 1;
  if v_conflict is not null then
    raise exception '%', coalesce(public.gst_recon_entry_conflict(v_conflict), 'USER: Changed by someone else. Reload to see their changes.') using errcode = 'P0001';
  end if;

  select count(*) into v_matched
  from public.gst_recon_entries e
  where e.run_id = p_run_id and e.id = any (v_ids) and e.bucket = 'matched';
  if v_matched > 0 then
    raise exception 'USER: Matched lines need no resolution. Leave them out of the selection.' using errcode = 'P0001';
  end if;

  update public.gst_recon_entries e
  set resolution = p_resolution,
      resolution_note = case when p_resolution = 'open' then null else v_note end
  where e.run_id = p_run_id and e.id = any (v_ids);
  get diagnostics v_updated = row_count;

  return jsonb_build_object(
    'updated', v_updated,
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object('id', e.id, 'updated_at', e.updated_at, 'resolution', e.resolution))
      from public.gst_recon_entries e
      where e.run_id = p_run_id and e.id = any (v_ids)
    ), '[]'::jsonb)
  );
end;
$$;

comment on function public.set_gst_recon_resolution(uuid, jsonb, text, text) is
  'Marks reconciliation lines resolved (accepted, follow up supplier, ignore) or open again, with a note, all or nothing, after the §13 concurrency check on each line.';

-- =============================================================================================
-- set_gst_recon_ims_action(entry, updated_at, action, reason)
-- =============================================================================================
create or replace function public.set_gst_recon_ims_action(p_entry_id uuid, p_updated_at timestamptz, p_action text, p_reason text)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_row public.gst_recon_entries%rowtype;
begin
  if not public.is_staff() then
    raise exception 'USER: Only the firm''s staff can record IMS decisions.' using errcode = 'P0001';
  end if;
  if p_action is null or p_action not in ('accept', 'reject', 'keep_pending') then
    raise exception 'USER: Choose accept, reject or keep pending.' using errcode = 'P0001';
  end if;
  if v_reason is null then
    raise exception 'USER: Give the reason for this IMS action.' using errcode = 'P0001';
  end if;
  if char_length(v_reason) > 1000 then
    raise exception 'USER: Keep the reason under 1,000 characters.' using errcode = 'P0001';
  end if;

  select * into v_row from public.gst_recon_entries e where e.id = p_entry_id for update;
  if not found then
    raise exception 'USER: That line is no longer in the reconciliation. Reload it.' using errcode = 'P0001';
  end if;
  if p_updated_at is not null and v_row.updated_at <> p_updated_at then
    raise exception '%', coalesce(public.gst_recon_entry_conflict(p_entry_id), 'USER: Changed by someone else. Reload to see their changes.') using errcode = 'P0001';
  end if;
  if v_row.origin <> 'current'
     or jsonb_typeof(v_row.data->'portal') is distinct from 'object'
     or coalesce(v_row.data->'portal'->>'section', '') not in ('b2b', 'b2ba', 'cdnr', 'cdnra')
     or coalesce((v_row.data->'portal'->>'reverseCharge')::boolean, false) then
    raise exception 'USER: The IMS acts only on this month''s inward invoices and credit or debit notes in GSTR-2B (not reverse charge, ISD or imports).' using errcode = 'P0001';
  end if;

  update public.gst_recon_entries e set ims_action = p_action, ims_reason = v_reason where e.id = p_entry_id;

  return (
    select jsonb_build_object('id', e.id, 'updated_at', e.updated_at, 'ims_action', e.ims_action, 'ims_reason', e.ims_reason, 'ims_decided_at', e.ims_decided_at)
    from public.gst_recon_entries e where e.id = p_entry_id
  );
end;
$$;

comment on function public.set_gst_recon_ims_action(uuid, timestamptz, text, text) is
  'Records the IMS decision (accept, reject, keep pending) and its reason for one GSTR-2B document of a reconciliation (§6.7, §6.12).';

revoke execute on function
  public.gst_recon_entry_conflict(uuid),
  public.save_gst_recon_run(jsonb),
  public.set_gst_recon_resolution(uuid, jsonb, text, text),
  public.set_gst_recon_ims_action(uuid, timestamptz, text, text)
from public, anon;
grant execute on function
  public.gst_recon_entry_conflict(uuid),
  public.save_gst_recon_run(jsonb),
  public.set_gst_recon_resolution(uuid, jsonb, text, text),
  public.set_gst_recon_ims_action(uuid, timestamptz, text, text)
to authenticated, service_role;
