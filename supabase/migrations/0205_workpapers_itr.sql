-- 0205 · ITR computation workpaper (§5.10, §6.11, §7.8.2): computations for individuals and HUFs,
-- both regimes side by side, results recomputed on the server on every save, and the
-- Draft → Reviewed → Final workflow enforced here.
--
--   itr_computations.inputs      { version, engine (lib/domain/itr.ts ItrInputs, amounts in paise),
--                                  dates { filingDate, dueDate }, ageBandSource, dueDateSource,
--                                  returnKind }
--   itr_computations.results     the ItrResult the server computed from those inputs and rule_set
--   itr_computations.rule_set    the `itr.ruleset` statutory_parameters value the results were
--                                computed with, copied from the table by the guard below (never
--                                taken on trust from the caller), so a later edit on the Law & rules
--                                page never silently changes a saved computation
--
--   save_itr_computation(payload)                          create (as a draft) or update one
--                                                           computation, with the §13 check
--   set_itr_computation_status(id, ts, to, regime, note)   Draft → Reviewed (with the regime the
--                                                           reviewer chose) → Final; back to Draft
--   delete_itr_computation(id, ts)                         Partner/Manager, never a final one
--
-- The guard trigger is the real control (§4.1, §7.8.2 "only a Manager/Partner can mark Final"):
--   * a computation is only for an individual or a HUF client (a proprietor is an individual);
--   * its rule set is the one in force on 1 April of its FY, read from statutory_parameters; a caller
--     that computed with another (or an older version of the same row) is refused, so the results
--     and the stored rule set always belong together;
--   * the regime is chosen by the reviewer when it is marked Reviewed (§7.8.2), by someone other
--     than the preparer (a Partner may review their own, as with filing a task, §4.1);
--   * only a Partner or Manager marks it Final, only from Reviewed; a Final computation's figures
--     never change, it can't be deleted, and only a Partner or Manager reopens it;
--   * changed figures on a Reviewed computation send it back to Draft (the choice of regime goes
--     with the review).

set search_path = public, extensions;

-- =============================================================================================
-- Columns
-- =============================================================================================
alter table public.itr_computations
  add column if not exists label text,
  add column if not exists rule_set jsonb,
  add column if not exists rule_set_param_id uuid references public.statutory_parameters (id) on delete set null,
  add column if not exists rule_set_verified boolean,
  add column if not exists computed_at timestamptz,
  add column if not exists prepared_by uuid,
  add column if not exists updated_by uuid,
  add column if not exists reviewed_by uuid,
  add column if not exists reviewed_at timestamptz,
  add column if not exists regime_chosen_by uuid,
  add column if not exists regime_chosen_at timestamptz,
  add column if not exists finalised_by uuid,
  add column if not exists finalised_at timestamptz,
  add column if not exists review_note text;

alter table public.itr_computations
  add constraint itr_computations_label_length check (label is null or char_length(label) <= 120),
  add constraint itr_computations_review_note_length check (review_note is null or char_length(review_note) <= 1000);

comment on column public.itr_computations.label is 'Optional name, e.g. "Advance tax estimate, March" (several computations per client and FY are allowed).';
comment on column public.itr_computations.rule_set is 'The itr.ruleset value the results were computed with, copied from statutory_parameters on save (§5.12, §6.11).';
comment on column public.itr_computations.rule_set_param_id is 'The statutory_parameters row the rule set came from.';
comment on column public.itr_computations.rule_set_verified is 'Whether that row was confirmed by a Partner when the computation was saved ([verify] rows are not, §6).';
comment on column public.itr_computations.computed_at is 'When the server last computed the results.';
comment on column public.itr_computations.prepared_by is 'Who last changed the figures.';
comment on column public.itr_computations.regime_chosen_by is 'The reviewer who recorded the regime chosen (§7.8.2).';
comment on column public.itr_computations.review_note is 'Why a computation was sent back to Draft or reopened.';

create index if not exists itr_computations_status_idx on public.itr_computations (status, updated_at desc);
create index if not exists itr_computations_fy_idx on public.itr_computations (financial_year, updated_at desc);

-- =============================================================================================
-- Helpers
-- =============================================================================================

-- Whether a client can have an ITR computation (§7.8.2 "Client* (individual/HUF)"): an individual,
-- a HUF or a proprietorship (the proprietor files as an individual); otherwise a PAN whose 4th
-- character is P (individual) or H (HUF).
create or replace function public.itr_client_eligible(p_entity public.entity_type, p_pan text)
returns boolean
language sql
immutable
set search_path = public, extensions
as $$
  select coalesce(p_entity in ('individual', 'huf', 'proprietorship'), false)
      or ((p_entity is null or p_entity = 'other') and upper(substr(coalesce(p_pan, ''), 4, 1)) in ('P', 'H'))
$$;

comment on function public.itr_client_eligible(public.entity_type, text) is
  'True for clients an ITR computation can be prepared for: individuals, HUFs and proprietors (§7.8.2).';

-- The itr.ruleset row in force on 1 April of an FY (§5.12 "Lookups always pass a date").
create or replace function public.itr_ruleset_row(p_fy text)
returns table (id uuid, value jsonb, verified boolean, updated_at timestamptz)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select sp.id, sp.value, sp.verified, sp.updated_at
  from public.statutory_parameters sp
  where sp.key = 'itr.ruleset'
    and public.is_fy_label(p_fy)
    and sp.effective_from <= public.fy_start_date(p_fy)
    and (sp.effective_to is null or sp.effective_to >= public.fy_start_date(p_fy))
  order by sp.effective_from desc
  limit 1
$$;

comment on function public.itr_ruleset_row(text) is
  'The income-tax rule set (statutory_parameters key itr.ruleset) in force on 1 April of the FY (§5.12, §6.11). Runs under the caller''s RLS.';

-- =============================================================================================
-- Guard
-- =============================================================================================
create or replace function public.itr_computations_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_content_changed boolean;
  v_client record;
  v_rule record;
begin
  if not public.is_api_caller() then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.client_id is distinct from old.client_id or new.financial_year is distinct from old.financial_year
       or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
      raise exception 'USER: A computation stays with its client and year. Start a new one for another client or year.' using errcode = 'P0001';
    end if;
    if new.reviewed_by is distinct from old.reviewed_by or new.reviewed_at is distinct from old.reviewed_at
       or new.finalised_by is distinct from old.finalised_by or new.finalised_at is distinct from old.finalised_at
       or new.prepared_by is distinct from old.prepared_by
       or new.regime_chosen_by is distinct from old.regime_chosen_by or new.regime_chosen_at is distinct from old.regime_chosen_at
       or new.rule_set_verified is distinct from old.rule_set_verified or new.computed_at is distinct from old.computed_at then
      raise exception 'USER: Who prepared, reviewed and finalised a computation, and when it was computed, are recorded by the app.' using errcode = 'P0001';
    end if;
  end if;

  v_content_changed := tg_op = 'INSERT'
    or new.inputs is distinct from old.inputs
    or new.results is distinct from old.results
    or new.rule_set is distinct from old.rule_set
    or new.rule_set_param_id is distinct from old.rule_set_param_id
    or new.label is distinct from old.label;

  -- The figures: the right kind of client, the inputs and results of this FY, and the rule set in
  -- force for it, exactly as statutory_parameters holds it.
  if v_content_changed then
    select c.entity_type, c.pan::text as pan, c.deleted_at into v_client from public.clients c where c.id = new.client_id;
    if not found or v_client.deleted_at is not null then
      raise exception 'USER: That client doesn''t exist, or is in the recycle bin.' using errcode = 'P0001';
    end if;
    if not public.itr_client_eligible(v_client.entity_type, v_client.pan) then
      raise exception 'USER: ITR computations are for individuals and HUFs. This client is recorded as another kind of entity.' using errcode = 'P0001';
    end if;
    if jsonb_typeof(new.inputs) is distinct from 'object' or jsonb_typeof(new.inputs->'engine') is distinct from 'object'
       or jsonb_typeof(new.results) is distinct from 'object' then
      raise exception 'USER: The computation has no inputs or results to save.' using errcode = 'P0001';
    end if;
    if new.inputs->'engine'->>'financialYear' is distinct from new.financial_year
       or new.results->>'financialYear' is distinct from new.financial_year then
      raise exception 'USER: The inputs and results must be for FY %.', new.financial_year using errcode = 'P0001';
    end if;

    select * into v_rule from public.itr_ruleset_row(new.financial_year);
    if not found then
      raise exception 'USER: No income-tax rule set is recorded for FY %. A Partner adds it under Settings → Law & rules.', new.financial_year using errcode = 'P0001';
    end if;
    if new.rule_set_param_id is distinct from v_rule.id or new.rule_set is distinct from v_rule.value then
      raise exception 'USER: The income-tax rule set for FY % was changed on the Law & rules page a moment ago. Save again to compute with the current rules.', new.financial_year using errcode = 'P0001';
    end if;
    new.rule_set := v_rule.value;
    new.rule_set_verified := v_rule.verified;
    new.computed_at := now();
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'draft' or new.regime_chosen is not null then
      raise exception 'USER: A new computation starts as a draft; the reviewer chooses the regime.' using errcode = 'P0001';
    end if;
    new.prepared_by := auth.uid();
    new.updated_by := auth.uid();
    new.reviewed_by := null;
    new.reviewed_at := null;
    new.regime_chosen_by := null;
    new.regime_chosen_at := null;
    new.finalised_by := null;
    new.finalised_at := null;
    new.review_note := null;
    return new;
  end if;

  -- A Final computation is locked; only a Partner or Manager reopens it.
  if old.status = 'final' then
    if new.status = 'final' and (v_content_changed or new.regime_chosen is distinct from old.regime_chosen) then
      raise exception 'USER: This computation is final. A Manager or Partner can reopen it to make changes.' using errcode = 'P0001';
    end if;
    if new.status <> 'final' and not public.is_manager_or_partner() then
      raise exception 'USER: Only a Manager or Partner can reopen a final computation.' using errcode = 'P0001';
    end if;
    if new.status = 'reviewed' then
      raise exception 'USER: Reopen a final computation as a draft.' using errcode = 'P0001';
    end if;
  end if;

  if v_content_changed then
    new.prepared_by := auth.uid();
    -- Changed figures need a fresh review, and the regime choice goes with the review.
    if new.status = 'reviewed' and old.status = 'reviewed' then
      new.status := 'draft';
    end if;
  end if;

  if new.status = 'final' and old.status <> 'final' then
    if not public.is_manager_or_partner() then
      raise exception 'USER: Only a Manager or Partner can mark a computation final.' using errcode = 'P0001';
    end if;
    if old.status <> 'reviewed' or v_content_changed then
      raise exception 'USER: A computation is reviewed before it is marked final.' using errcode = 'P0001';
    end if;
    if new.regime_chosen is null then
      raise exception 'USER: Record the regime chosen before marking the computation final.' using errcode = 'P0001';
    end if;
    new.finalised_by := auth.uid();
    new.finalised_at := now();
  end if;

  if new.status = 'reviewed' and old.status = 'draft' then
    if new.regime_chosen is null then
      raise exception 'USER: Choose the regime (old or new) when you mark the computation reviewed.' using errcode = 'P0001';
    end if;
    if old.prepared_by = auth.uid() and not public.is_partner() then
      raise exception 'USER: Someone other than the preparer reviews the computation. Ask a colleague, a Manager or a Partner.' using errcode = 'P0001';
    end if;
    new.reviewed_by := auth.uid();
    new.reviewed_at := now();
    new.regime_chosen_by := auth.uid();
    new.regime_chosen_at := now();
  elsif new.status = 'reviewed' and old.status = 'reviewed' and new.regime_chosen is distinct from old.regime_chosen then
    -- The reviewer's choice changes only by someone who could review it.
    if new.regime_chosen is null then
      raise exception 'USER: A reviewed computation keeps the regime chosen. Send it back to Draft to clear it.' using errcode = 'P0001';
    end if;
    if old.prepared_by = auth.uid() and not public.is_partner() then
      raise exception 'USER: The regime is chosen by the reviewer, not the preparer.' using errcode = 'P0001';
    end if;
    new.regime_chosen_by := auth.uid();
    new.regime_chosen_at := now();
  elsif new.status = 'draft' and new.regime_chosen is not null then
    if old.status = 'draft' and new.regime_chosen is distinct from old.regime_chosen then
      raise exception 'USER: The regime is chosen when the computation is reviewed.' using errcode = 'P0001';
    end if;
  end if;

  if new.status = 'draft' then
    new.reviewed_by := null;
    new.reviewed_at := null;
    new.regime_chosen := null;
    new.regime_chosen_by := null;
    new.regime_chosen_at := null;
  end if;
  if new.status <> 'final' then
    new.finalised_by := null;
    new.finalised_at := null;
  end if;
  if new.status = old.status and new.review_note is distinct from old.review_note then
    -- The note travels with a status change; on its own it is kept as it was.
    new.review_note := old.review_note;
  end if;

  new.updated_by := auth.uid();
  return new;
end;
$$;

comment on function public.itr_computations_guard() is
  'Trigger: individual/HUF clients only; the rule set in force copied from statutory_parameters; Draft → Reviewed (regime chosen by someone other than the preparer, Partners excepted) → Final (Partner/Manager only); Final locked; changed figures go back to Draft (§6.11, §7.8.2).';

drop trigger if exists itr_computations_guard on public.itr_computations;
create trigger itr_computations_guard before insert or update on public.itr_computations
  for each row execute function public.itr_computations_guard();

create or replace function public.itr_computations_delete_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if public.is_api_caller() and old.status = 'final' then
    raise exception 'USER: A final computation can''t be deleted. Reopen it as a draft first.' using errcode = 'P0001';
  end if;
  return old;
end;
$$;

comment on function public.itr_computations_delete_guard() is 'Trigger: a final ITR computation is never deleted (§7.8.2).';

drop trigger if exists itr_computations_delete_guard on public.itr_computations;
create trigger itr_computations_delete_guard before delete on public.itr_computations
  for each row execute function public.itr_computations_delete_guard();

revoke execute on function public.itr_computations_guard(), public.itr_computations_delete_guard() from public, anon, authenticated;

-- =============================================================================================
-- Concurrency message (§13)
-- =============================================================================================
create or replace function public.itr_computation_conflict(p_id uuid)
returns text
language sql
stable
security definer
set search_path = public, extensions
as $$
  select format(
    'USER: Changed by %s at %s. Reload to see their changes.',
    coalesce(p.full_name, 'someone else'),
    to_char(i.updated_at at time zone 'Asia/Kolkata', 'HH24:MI')
  )
  from public.itr_computations i
  left join public.profiles p on p.id = i.updated_by
  where i.id = p_id
    and public.is_staff()
    and public.can_see_client(i.client_id)
$$;

comment on function public.itr_computation_conflict(uuid) is
  'The concurrency refusal for an ITR computation: who changed it last and when (§13).';

-- =============================================================================================
-- save_itr_computation(payload)
--   { id?, updated_at? (required with id), client_id (create), financial_year (create), label,
--     inputs, results, rule_set, rule_set_param_id }
-- Returns { id, status, updated_at, client_id, financial_year, back_to_draft }.
-- =============================================================================================
create or replace function public.save_itr_computation(p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_id uuid := public.try_uuid(nullif(p_payload->>'id', ''));
  v_expected timestamptz;
  v_client uuid := public.try_uuid(nullif(p_payload->>'client_id', ''));
  v_fy text := nullif(btrim(coalesce(p_payload->>'financial_year', '')), '');
  v_label text := left(nullif(btrim(coalesce(p_payload->>'label', '')), ''), 120);
  v_param uuid := public.try_uuid(nullif(p_payload->>'rule_set_param_id', ''));
  v_before text;
  v_row public.itr_computations%rowtype;
begin
  if not public.is_staff() then
    raise exception 'USER: Only the firm''s staff can prepare ITR computations.' using errcode = 'P0001';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'USER: Enter the computation''s details.' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_payload->'inputs') is distinct from 'object' or jsonb_typeof(p_payload->'results') is distinct from 'object'
     or jsonb_typeof(p_payload->'rule_set') is distinct from 'object' then
    raise exception 'USER: The computation has no inputs or results to save.' using errcode = 'P0001';
  end if;
  if octet_length(p_payload::text) > 1000000 then
    raise exception 'USER: The computation is too large to save.' using errcode = 'P0001';
  end if;
  begin
    v_expected := nullif(p_payload->>'updated_at', '')::timestamptz;
  exception when others then
    v_expected := null;
  end;

  if v_id is null then
    if v_client is null or not public.can_see_client(v_client)
       or not exists (select 1 from public.clients c where c.id = v_client and c.deleted_at is null) then
      raise exception 'USER: That client isn''t one of yours, or it is in the recycle bin.' using errcode = 'P0001';
    end if;
    if v_fy is null or not public.is_fy_label(v_fy) then
      raise exception 'USER: Choose the financial year.' using errcode = 'P0001';
    end if;
    insert into public.itr_computations (client_id, financial_year, label, inputs, results, rule_set, rule_set_param_id, created_by)
    values (v_client, v_fy, v_label, p_payload->'inputs', p_payload->'results', p_payload->'rule_set', v_param, auth.uid())
    returning * into v_row;
    return jsonb_build_object('id', v_row.id, 'status', v_row.status, 'updated_at', v_row.updated_at,
      'client_id', v_row.client_id, 'financial_year', v_row.financial_year, 'back_to_draft', false, 'created', true);
  end if;

  select * into v_row from public.itr_computations i where i.id = v_id for update;
  if not found then
    raise exception 'USER: That computation no longer exists, or isn''t one of yours.' using errcode = 'P0001';
  end if;
  if v_expected is null or v_row.updated_at <> v_expected then
    raise exception '%', coalesce(public.itr_computation_conflict(v_id), 'USER: Changed by someone else. Reload to see their changes.') using errcode = 'P0001';
  end if;
  if v_fy is not null and v_fy <> v_row.financial_year then
    raise exception 'USER: A computation stays with its year. Start a new one for FY %.', v_fy using errcode = 'P0001';
  end if;
  if v_client is not null and v_client <> v_row.client_id then
    raise exception 'USER: A computation stays with its client. Start a new one for the other client.' using errcode = 'P0001';
  end if;
  v_before := v_row.status;

  update public.itr_computations i
  set label = case when p_payload ? 'label' then v_label else i.label end,
      inputs = p_payload->'inputs',
      results = p_payload->'results',
      rule_set = p_payload->'rule_set',
      rule_set_param_id = v_param
  where i.id = v_id
  returning * into v_row;

  return jsonb_build_object('id', v_row.id, 'status', v_row.status, 'updated_at', v_row.updated_at,
    'client_id', v_row.client_id, 'financial_year', v_row.financial_year,
    'back_to_draft', v_before = 'reviewed' and v_row.status = 'draft', 'created', false);
end;
$$;

comment on function public.save_itr_computation(jsonb) is
  'Creates (as a draft) or updates an ITR computation with the §13 concurrency check; the server computes the results, and the guard copies the rule set in force from statutory_parameters (§6.11, §7.8.2). Security invoker: RLS applies.';

-- =============================================================================================
-- set_itr_computation_status(id, updated_at, status, regime, note)
-- =============================================================================================
create or replace function public.set_itr_computation_status(p_id uuid, p_updated_at timestamptz, p_status text, p_regime text, p_note text)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_regime text := nullif(btrim(coalesce(p_regime, '')), '');
  v_row public.itr_computations%rowtype;
  v_from text;
begin
  if not public.is_staff() then
    raise exception 'USER: Only the firm''s staff can review ITR computations.' using errcode = 'P0001';
  end if;
  if p_status is null or p_status not in ('draft', 'reviewed', 'final') then
    raise exception 'USER: Choose Draft, Reviewed or Final.' using errcode = 'P0001';
  end if;
  if v_regime is not null and v_regime not in ('old', 'new') then
    raise exception 'USER: Choose the old or the new regime.' using errcode = 'P0001';
  end if;
  if v_note is not null and char_length(v_note) > 1000 then
    raise exception 'USER: Keep the note under 1,000 characters.' using errcode = 'P0001';
  end if;

  select * into v_row from public.itr_computations i where i.id = p_id for update;
  if not found then
    raise exception 'USER: That computation no longer exists, or isn''t one of yours.' using errcode = 'P0001';
  end if;
  if p_updated_at is null or v_row.updated_at <> p_updated_at then
    raise exception '%', coalesce(public.itr_computation_conflict(p_id), 'USER: Changed by someone else. Reload to see their changes.') using errcode = 'P0001';
  end if;
  v_from := v_row.status;
  if v_row.status = p_status and not (p_status = 'reviewed' and v_regime is not null and v_regime is distinct from v_row.regime_chosen) then
    raise exception 'USER: The computation is already %.', initcap(p_status) using errcode = 'P0001';
  end if;
  if p_status = 'reviewed' and v_regime is null then
    raise exception 'USER: Choose the regime (old or new) when you mark the computation reviewed.' using errcode = 'P0001';
  end if;
  if p_status = 'draft' and v_note is null then
    raise exception 'USER: Say why it goes back to Draft, so the preparer knows what to change.' using errcode = 'P0001';
  end if;

  update public.itr_computations i
  set status = p_status,
      regime_chosen = case when p_status = 'reviewed' then v_regime when p_status = 'final' then i.regime_chosen else null end,
      review_note = case when p_status = 'draft' then v_note else i.review_note end
  where i.id = p_id
  returning * into v_row;

  return jsonb_build_object('id', v_row.id, 'status', v_row.status, 'from_status', v_from, 'updated_at', v_row.updated_at,
    'regime_chosen', v_row.regime_chosen, 'client_id', v_row.client_id, 'financial_year', v_row.financial_year,
    'prepared_by', v_row.prepared_by, 'reviewed_by', v_row.reviewed_by, 'finalised_at', v_row.finalised_at);
end;
$$;

comment on function public.set_itr_computation_status(uuid, timestamptz, text, text, text) is
  'Moves an ITR computation Draft → Reviewed (recording the regime chosen) → Final, or back to Draft with a note, after the §13 concurrency check; the guard decides who may (§7.8.2).';

-- =============================================================================================
-- delete_itr_computation(id, updated_at): Partner/Manager; RLS allows only them to delete.
-- =============================================================================================
create or replace function public.delete_itr_computation(p_id uuid, p_updated_at timestamptz)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_row public.itr_computations%rowtype;
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only a Manager or Partner can delete a computation.' using errcode = 'P0001';
  end if;
  select * into v_row from public.itr_computations i where i.id = p_id for update;
  if not found then
    raise exception 'USER: That computation no longer exists.' using errcode = 'P0001';
  end if;
  if p_updated_at is null or v_row.updated_at <> p_updated_at then
    raise exception '%', coalesce(public.itr_computation_conflict(p_id), 'USER: Changed by someone else. Reload to see their changes.') using errcode = 'P0001';
  end if;
  delete from public.itr_computations i where i.id = p_id;
  return jsonb_build_object('id', v_row.id, 'client_id', v_row.client_id, 'financial_year', v_row.financial_year, 'status', v_row.status);
end;
$$;

comment on function public.delete_itr_computation(uuid, timestamptz) is
  'Deletes a draft or reviewed ITR computation (Partner/Manager, §4.6) after the §13 concurrency check; a final one is refused by the delete guard.';

-- =============================================================================================
-- itr_computations_list: the register's read model (§2.3: searched, sorted and paged in SQL).
-- Amounts are integer paise, as the engine computes them.
-- =============================================================================================
create or replace view public.itr_computations_list with (security_invoker = true) as
select
  i.id,
  i.client_id,
  c.display_name as client_name,
  c.client_code::text as client_code,
  c.entity_type::text as entity_type,
  c.pan::text as client_pan,
  i.financial_year,
  i.results->>'yearLabel' as year_label,
  i.results->>'statute' as statute,
  i.label,
  i.status,
  i.regime_chosen,
  i.results->'comparison'->>'recommendedRegime' as recommended_regime,
  (i.results->'comparison'->>'saving')::bigint as saving_paise,
  (i.results->'comparison'->>'newRegime')::bigint as new_regime_total_paise,
  (i.results->'comparison'->>'oldRegime')::bigint as old_regime_total_paise,
  coalesce(i.regime_chosen, i.results->'comparison'->>'recommendedRegime') as effective_regime,
  (i.results->'regimes'->coalesce(i.regime_chosen, i.results->'comparison'->>'recommendedRegime')->>'balance')::bigint as balance_paise,
  (i.results->'regimes'->coalesce(i.regime_chosen, i.results->'comparison'->>'recommendedRegime')->>'totalIncome')::bigint as total_income_paise,
  (i.results->'regimes'->coalesce(i.regime_chosen, i.results->'comparison'->>'recommendedRegime')->'interest'->>'total')::bigint as interest_paise,
  case when (i.inputs->'dates'->>'filingDate') ~ '^\d{4}-\d{2}-\d{2}$' then (i.inputs->'dates'->>'filingDate')::date end as filing_date,
  case when (i.inputs->'dates'->>'dueDate') ~ '^\d{4}-\d{2}-\d{2}$' then (i.inputs->'dates'->>'dueDate')::date end as due_date,
  i.rule_set_verified,
  i.computed_at,
  i.created_by,
  cb.full_name as created_by_name,
  i.prepared_by,
  pb.full_name as prepared_by_name,
  i.updated_by,
  ub.full_name as updated_by_name,
  i.reviewed_by,
  rb.full_name as reviewed_by_name,
  i.reviewed_at,
  i.regime_chosen_by,
  i.finalised_by,
  fb.full_name as finalised_by_name,
  i.finalised_at,
  i.review_note,
  i.created_at,
  i.updated_at
from public.itr_computations i
join public.clients c on c.id = i.client_id
left join public.employee_directory cb on cb.profile_id = i.created_by
left join public.employee_directory pb on pb.profile_id = i.prepared_by
left join public.employee_directory ub on ub.profile_id = i.updated_by
left join public.employee_directory rb on rb.profile_id = i.reviewed_by
left join public.employee_directory fb on fb.profile_id = i.finalised_by
where c.deleted_at is null;

comment on view public.itr_computations_list is
  'ITR computations with client, year label, status, regimes (recommended and chosen), saving, balance and who prepared, reviewed and finalised them, in paise (§6.11, §7.8.2).';

revoke all on public.itr_computations_list from anon, public;
revoke insert, update, delete, truncate, references, trigger on public.itr_computations_list from authenticated;
grant select on public.itr_computations_list to authenticated, service_role;

-- =============================================================================================
-- Grants
-- =============================================================================================
revoke execute on function
  public.itr_client_eligible(public.entity_type, text),
  public.itr_ruleset_row(text),
  public.itr_computation_conflict(uuid),
  public.save_itr_computation(jsonb),
  public.set_itr_computation_status(uuid, timestamptz, text, text, text),
  public.delete_itr_computation(uuid, timestamptz)
from public, anon;
grant execute on function
  public.itr_client_eligible(public.entity_type, text),
  public.itr_ruleset_row(text),
  public.itr_computation_conflict(uuid),
  public.save_itr_computation(jsonb),
  public.set_itr_computation_status(uuid, timestamptz, text, text, text),
  public.delete_itr_computation(uuid, timestamptz)
to authenticated, service_role;
