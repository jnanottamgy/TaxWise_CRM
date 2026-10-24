-- 0197 · Quality and risk (§6.8 SQC 1 with the SQM 1 switch, §7.15.4, §12 restore drills) and
-- data protection (§6.10 DPDP Act 2023 / DPDP Rules 2025): the columns and rules the module needs.
--
--   quality_manual_items     + owner's review cycle (review_every_months), last_reviewed_by, and the
--                            SQM 1 risk-assessment fields (component, quality objective, quality risk,
--                            response). The element names SQC 1's six elements or SQM 1's components.
--   peer_reviews             a completed review carries the certificate number, review date and
--                            validity, and validity follows the review.
--   independence_declarations  yes/no answers; any "yes" needs the details; stamped when declared.
--   restore_drills           + backup used, where it was restored, minutes taken, what was checked,
--                            issues; outcome passed / passed_with_issues / failed.
--   privacy_notices          + change summary, who drafted and who published. A published version is
--                            never edited (a change is a new version, acknowledged again).
--                            publish_privacy_notice(id) makes it the current one, in one step.
--   data_requests            + who it is about, contact, client, details, channel, what statutory
--                            retention keeps back, closed_at, created_by, updated_by. Status words:
--                            open, in_progress, completed, resolved, rejected, withdrawn (the closed
--                            ones are what the inbox, 0172, leaves out). The due date comes from the
--                            type (dpdp.request_response_days). Closing needs the response; an erasure
--                            needs what is retained and why (§6.10). Writes are Partner-only (§7.15.4
--                            "Partner; Managers read-only"; the inbox shows them to Partners, 0172).
--   data_incidents           + title, severity, assessment, Board reference, closed_at/by, updated_by.
--                            Step times follow detection; closing needs every step of the breach
--                            checklist (contain, assess, notify the Board, notify people, root cause).

set search_path = public, extensions;

-- =============================================================================================
-- quality_manual_items
-- =============================================================================================
alter table public.quality_manual_items
  add column if not exists review_every_months int not null default 12,
  add column if not exists last_reviewed_by uuid references public.profiles (id) on delete set null,
  add column if not exists sqm1_component text,
  add column if not exists quality_objective text,
  add column if not exists quality_risk text,
  add column if not exists risk_response text;

alter table public.quality_manual_items drop constraint if exists quality_manual_items_element_values;
alter table public.quality_manual_items
  add constraint quality_manual_items_element_values check (element in (
    'leadership', 'ethics_independence', 'acceptance_continuance', 'human_resources', 'engagement_performance', 'monitoring',
    'governance_leadership', 'relevant_ethical_requirements', 'resources', 'information_communication', 'monitoring_remediation',
    'risk_assessment_process'
  ));
alter table public.quality_manual_items drop constraint if exists quality_manual_items_sqm1_component_values;
alter table public.quality_manual_items
  add constraint quality_manual_items_sqm1_component_values check (sqm1_component is null or sqm1_component in (
    'governance_leadership', 'relevant_ethical_requirements', 'acceptance_continuance', 'engagement_performance', 'resources',
    'information_communication', 'monitoring_remediation', 'risk_assessment_process'
  ));
alter table public.quality_manual_items drop constraint if exists quality_manual_items_review_cycle;
alter table public.quality_manual_items
  add constraint quality_manual_items_review_cycle check (review_every_months between 1 and 60);
alter table public.quality_manual_items drop constraint if exists quality_manual_items_lengths;
alter table public.quality_manual_items
  add constraint quality_manual_items_lengths check (
    length(title) between 3 and 300
    and (notes is null or length(notes) <= 4000)
    and (quality_objective is null or length(quality_objective) <= 2000)
    and (quality_risk is null or length(quality_risk) <= 2000)
    and (risk_response is null or length(risk_response) <= 2000)
  );

create or replace function public.quality_manual_items_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if new.last_reviewed_on is not null and new.last_reviewed_on > public.today_ist() then
    raise exception 'USER: The last review can''t be in the future.' using errcode = 'P0001';
  end if;
  if public.is_api_caller() and new.last_reviewed_on is distinct from (case when tg_op = 'UPDATE' then old.last_reviewed_on end) then
    new.last_reviewed_by := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists quality_manual_items_guard on public.quality_manual_items;
create trigger quality_manual_items_guard before insert or update on public.quality_manual_items
  for each row execute function public.quality_manual_items_guard();

-- =============================================================================================
-- peer_reviews (§6.8 Peer Review Guidelines 2022)
-- =============================================================================================
create or replace function public.peer_reviews_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if new.status = 'completed' then
    if nullif(btrim(new.certificate_no), '') is null or new.valid_until is null or new.reviewed_on is null then
      raise exception 'USER: A completed peer review needs the certificate number, the review date and the date the certificate is valid until.' using errcode = 'P0001';
    end if;
  end if;
  if new.valid_until is not null and new.reviewed_on is not null and new.valid_until < new.reviewed_on then
    raise exception 'USER: The certificate can''t expire before the review date.' using errcode = 'P0001';
  end if;
  if new.reviewed_on is not null and new.reviewed_on > public.today_ist() then
    raise exception 'USER: The review date can''t be in the future.' using errcode = 'P0001';
  end if;
  if public.is_api_caller() and tg_op = 'INSERT' then
    new.created_by := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists peer_reviews_guard on public.peer_reviews;
create trigger peer_reviews_guard before insert or update on public.peer_reviews
  for each row execute function public.peer_reviews_guard();

-- =============================================================================================
-- independence_declarations (§6.8, §7.15.4: annual, yes/no questionnaire plus details)
-- =============================================================================================
alter table public.independence_declarations
  add column if not exists declared_by uuid references public.profiles (id) on delete set null;

alter table public.independence_declarations drop constraint if exists independence_declarations_answers_object;
alter table public.independence_declarations
  add constraint independence_declarations_answers_object check (jsonb_typeof(answers) = 'object');
alter table public.independence_declarations drop constraint if exists independence_declarations_details_length;
alter table public.independence_declarations
  add constraint independence_declarations_details_length check (details is null or length(details) <= 4000);

create or replace function public.independence_declarations_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_bad int;
  v_yes int;
begin
  select count(*) filter (where jsonb_typeof(a.value) <> 'boolean'), count(*) filter (where a.value = 'true'::jsonb)
    into v_bad, v_yes
  from jsonb_each(new.answers) a;
  if v_bad > 0 then
    raise exception 'USER: Answer each question yes or no.' using errcode = 'P0001';
  end if;
  if v_yes > 0 and nullif(btrim(new.details), '') is null then
    raise exception 'USER: Give the details for each question answered yes, and the safeguards in place.' using errcode = 'P0001';
  end if;
  if public.is_api_caller() then
    new.declared_at := now();
    new.declared_by := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists independence_declarations_guard on public.independence_declarations;
create trigger independence_declarations_guard before insert or update on public.independence_declarations
  for each row execute function public.independence_declarations_guard();

-- =============================================================================================
-- restore_drills (§12 "A restore drill every quarter, recorded in the quality module")
-- =============================================================================================
alter table public.restore_drills
  add column if not exists backup_reference text,
  add column if not exists restored_to text,
  add column if not exists duration_minutes int,
  add column if not exists checks text,
  add column if not exists issues text;

alter table public.restore_drills drop constraint if exists restore_drills_outcome_values;
alter table public.restore_drills
  add constraint restore_drills_outcome_values check (outcome in ('passed', 'passed_with_issues', 'failed'));
alter table public.restore_drills drop constraint if exists restore_drills_duration;
alter table public.restore_drills
  add constraint restore_drills_duration check (duration_minutes is null or duration_minutes between 1 and 10080);
alter table public.restore_drills drop constraint if exists restore_drills_issues_when_not_clean;
alter table public.restore_drills
  add constraint restore_drills_issues_when_not_clean check (outcome = 'passed' or nullif(btrim(issues), '') is not null);

create or replace function public.restore_drills_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if new.performed_on > public.today_ist() then
    raise exception 'USER: A restore drill can''t be recorded for a future date.' using errcode = 'P0001';
  end if;
  if public.is_api_caller() and tg_op = 'INSERT' and new.performed_by is null then
    new.performed_by := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists restore_drills_guard on public.restore_drills;
create trigger restore_drills_guard before insert or update on public.restore_drills
  for each row execute function public.restore_drills_guard();

create index if not exists restore_drills_performed_idx on public.restore_drills (performed_on desc);

-- =============================================================================================
-- privacy_notices (§6.10)
-- =============================================================================================
alter table public.privacy_notices
  add column if not exists change_summary text,
  add column if not exists created_by uuid references public.profiles (id) on delete set null,
  add column if not exists published_by uuid references public.profiles (id) on delete set null;

alter table public.privacy_notices drop constraint if exists privacy_notices_version_format;
alter table public.privacy_notices
  add constraint privacy_notices_version_format check (version ~ '^v[0-9]{1,4}$');
alter table public.privacy_notices drop constraint if exists privacy_notices_body_length;
alter table public.privacy_notices
  add constraint privacy_notices_body_length check (length(body) between 1 and 50000 and (change_summary is null or length(change_summary) <= 1000));

create or replace function public.privacy_notices_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if tg_op = 'DELETE' then
    if old.published_at is not null then
      raise exception 'USER: A published notice is kept with the acknowledgements given against it, so it can''t be deleted.' using errcode = 'P0001';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and old.published_at is not null then
    -- Only which version is current may change once published (publish_privacy_notice).
    if new.version is distinct from old.version or new.body is distinct from old.body or new.published_at is distinct from old.published_at
       or new.change_summary is distinct from old.change_summary or new.published_by is distinct from old.published_by then
      raise exception 'USER: A published notice can''t be changed. Make a new version instead; portal users acknowledge it again.' using errcode = 'P0001';
    end if;
  end if;
  if public.is_api_caller() then
    if tg_op = 'INSERT' then
      new.created_by := auth.uid();
      if new.published_at is not null or new.is_current then
        raise exception 'USER: Save the notice as a draft, then publish it.' using errcode = 'P0001';
      end if;
    elsif old.published_at is null and new.published_at is not null then
      -- Publishing stamps who published it; making it the current version goes through
      -- publish_privacy_notice so only one version is ever current.
      new.published_by := auth.uid();
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists privacy_notices_guard on public.privacy_notices;
create trigger privacy_notices_guard before insert or update or delete on public.privacy_notices
  for each row execute function public.privacy_notices_guard();

-- publish_privacy_notice: the version becomes the current one (the portal welcome gate shows it,
-- §7.22), the previous one is superseded. Partner only. Idempotent for the current version.
create or replace function public.publish_privacy_notice(p_id uuid, p_expected_updated_at timestamptz default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  n public.privacy_notices%rowtype;
  v_previous text;
begin
  if not public.is_partner() then
    raise exception 'USER: Only a Partner can publish the privacy notice.' using errcode = 'P0001';
  end if;
  select * into n from public.privacy_notices where id = p_id for update;
  if not found then
    raise exception 'USER: That version no longer exists.' using errcode = 'P0001';
  end if;
  if p_expected_updated_at is not null and n.updated_at is distinct from p_expected_updated_at then
    raise exception 'USER: This version was changed by someone else. Reload to see their changes.' using errcode = 'P0001';
  end if;
  if n.published_at is not null and n.is_current then
    return jsonb_build_object('id', n.id, 'version', n.version, 'published_at', n.published_at, 'previous', null, 'already', true);
  end if;
  if n.published_at is not null then
    raise exception 'USER: This version was published before and has been replaced. Make a new version from it instead.' using errcode = 'P0001';
  end if;
  if length(btrim(n.body)) < 200 then
    raise exception 'USER: The notice is too short to tell people what data you hold, why, for how long and their rights.' using errcode = 'P0001';
  end if;

  select version into v_previous from public.privacy_notices where is_current and published_at is not null and id <> p_id;
  update public.privacy_notices set is_current = false where is_current and id <> p_id;
  update public.privacy_notices
  set is_current = true, published_at = now(), published_by = auth.uid()
  where id = p_id
  returning * into n;
  return jsonb_build_object('id', n.id, 'version', n.version, 'published_at', n.published_at, 'previous', v_previous, 'already', false, 'updated_at', n.updated_at);
end;
$$;

comment on function public.publish_privacy_notice(uuid, timestamptz) is
  'Partner: publishes a draft privacy notice as the current version (portal users acknowledge it at the welcome gate, §6.10, §7.22); the previous version is superseded.';

-- =============================================================================================
-- data_requests (§6.10 rights of data principals)
-- =============================================================================================
alter table public.data_requests
  add column if not exists subject_type text,
  add column if not exists contact text,
  add column if not exists client_id uuid references public.clients (id) on delete set null,
  add column if not exists details text,
  add column if not exists channel text,
  add column if not exists retained_explanation text,
  add column if not exists closed_at timestamptz,
  add column if not exists created_by uuid references public.profiles (id) on delete set null,
  add column if not exists updated_by uuid references public.profiles (id) on delete set null;

alter table public.data_requests drop constraint if exists data_requests_status_values;
alter table public.data_requests
  add constraint data_requests_status_values check (status in ('open', 'in_progress', 'completed', 'resolved', 'rejected', 'withdrawn'));
alter table public.data_requests drop constraint if exists data_requests_subject_type_values;
alter table public.data_requests
  add constraint data_requests_subject_type_values check (subject_type is null or subject_type in ('client_contact', 'portal_user', 'employee', 'lead', 'other'));
alter table public.data_requests drop constraint if exists data_requests_channel_values;
alter table public.data_requests
  add constraint data_requests_channel_values check (channel is null or channel in ('email', 'portal', 'phone', 'letter', 'in_person', 'whatsapp', 'other'));
alter table public.data_requests drop constraint if exists data_requests_lengths;
alter table public.data_requests
  add constraint data_requests_lengths check (
    length(subject) between 2 and 200
    and (contact is null or length(contact) <= 200)
    and (details is null or length(details) <= 4000)
    and (response is null or length(response) <= 8000)
    and (retained_explanation is null or length(retained_explanation) <= 4000)
  );

create or replace function public.data_requests_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_days numeric;
  v_closed constant text[] := array['closed', 'completed', 'resolved', 'rejected', 'withdrawn'];
  v_received date;
begin
  v_received := (new.received_at at time zone 'Asia/Kolkata')::date;
  if new.received_at > now() + interval '5 minutes' then
    raise exception 'USER: The request can''t have been received in the future.' using errcode = 'P0001';
  end if;
  if new.due_by is null or (tg_op = 'UPDATE' and new.type is distinct from old.type and new.due_by is not distinct from old.due_by)
     or (tg_op = 'UPDATE' and new.received_at is distinct from old.received_at and new.due_by is not distinct from old.due_by) then
    v_days := public.jsonb_to_numeric(public.statutory_param_value('dpdp.request_response_days', v_received) -> new.type);
    new.due_by := v_received + coalesce(v_days, 90)::int;
  end if;
  if new.due_by < v_received then
    raise exception 'USER: The due date can''t be before the request was received.' using errcode = 'P0001';
  end if;

  if new.status = any (v_closed) then
    if new.status <> 'withdrawn' and nullif(btrim(new.response), '') is null then
      raise exception 'USER: Record the response given to the requester before closing the request.' using errcode = 'P0001';
    end if;
    if new.type = 'erasure' and new.status in ('completed', 'rejected') and nullif(btrim(new.retained_explanation), '') is null then
      raise exception 'USER: Say what is retained and why (statutory retention overrides erasure), or that nothing is retained.' using errcode = 'P0001';
    end if;
    if tg_op = 'INSERT' or not (old.status = any (v_closed)) then
      new.closed_at := now();
    end if;
  else
    new.closed_at := null;
  end if;

  if public.is_api_caller() then
    if tg_op = 'INSERT' then
      new.created_by := auth.uid();
    else
      new.created_by := old.created_by;
    end if;
    new.updated_by := auth.uid();
  end if;
  return new;
end;
$$;

comment on function public.data_requests_guard() is
  'Trigger: due date from the type (dpdp.request_response_days, 90 days [verify]); closing needs the response, and an erasure what is retained and why (§6.10); closed_at, created_by, updated_by.';

drop trigger if exists data_requests_guard on public.data_requests;
create trigger data_requests_guard before insert or update on public.data_requests
  for each row execute function public.data_requests_guard();

-- Writes are the Partners' (§7.15.4 "Partner; Managers read-only"); Managers keep reading them.
drop policy if exists data_requests_insert on public.data_requests;
create policy data_requests_insert on public.data_requests
  for insert to authenticated with check ((select public.is_partner()));
drop policy if exists data_requests_update on public.data_requests;
create policy data_requests_update on public.data_requests
  for update to authenticated using ((select public.is_partner())) with check ((select public.is_partner()));

create index if not exists data_requests_client_idx on public.data_requests (client_id) where client_id is not null;

-- =============================================================================================
-- data_incidents (§6.10 breach response)
-- =============================================================================================
alter table public.data_incidents
  add column if not exists title text,
  add column if not exists severity text not null default 'medium',
  add column if not exists assessed_at timestamptz,
  add column if not exists assessment text,
  add column if not exists board_reference text,
  add column if not exists closed_at timestamptz,
  add column if not exists closed_by uuid references public.profiles (id) on delete set null,
  add column if not exists updated_by uuid references public.profiles (id) on delete set null;

alter table public.data_incidents drop constraint if exists data_incidents_severity_values;
alter table public.data_incidents
  add constraint data_incidents_severity_values check (severity in ('low', 'medium', 'high'));
alter table public.data_incidents drop constraint if exists data_incidents_actions_array;
alter table public.data_incidents
  add constraint data_incidents_actions_array check (jsonb_typeof(actions) = 'array');
alter table public.data_incidents drop constraint if exists data_incidents_lengths;
alter table public.data_incidents
  add constraint data_incidents_lengths check (
    (title is null or length(title) between 3 and 200)
    and length(description) between 5 and 8000
    and (assessment is null or length(assessment) <= 8000)
    and (root_cause is null or length(root_cause) <= 8000)
    and (board_reference is null or length(board_reference) <= 200)
  );

create or replace function public.data_incidents_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if new.detected_at > now() + interval '5 minutes' then
    raise exception 'USER: The breach can''t have been detected in the future.' using errcode = 'P0001';
  end if;
  if (new.contained_at is not null and new.contained_at < new.detected_at)
     or (new.assessed_at is not null and new.assessed_at < new.detected_at)
     or (new.board_notified_at is not null and new.board_notified_at < new.detected_at)
     or (new.principals_notified_at is not null and new.principals_notified_at < new.detected_at) then
    raise exception 'USER: A step can''t be dated before the breach was detected.' using errcode = 'P0001';
  end if;
  if greatest(new.contained_at, new.assessed_at, new.board_notified_at, new.principals_notified_at) > now() + interval '5 minutes' then
    raise exception 'USER: A step can''t be dated in the future.' using errcode = 'P0001';
  end if;
  if new.closed_at is not null and (tg_op = 'INSERT' or old.closed_at is null) then
    if new.contained_at is null or new.assessed_at is null or new.board_notified_at is null or new.principals_notified_at is null
       or nullif(btrim(new.root_cause), '') is null then
      raise exception 'USER: Close the incident once it is contained, assessed, the Board and the people affected are notified, and the root cause is recorded.' using errcode = 'P0001';
    end if;
  end if;
  if public.is_api_caller() then
    if tg_op = 'INSERT' then
      new.created_by := auth.uid();
    else
      new.created_by := old.created_by;
    end if;
    if new.closed_at is not null and (tg_op = 'INSERT' or old.closed_at is null) then
      new.closed_by := auth.uid();
    elsif new.closed_at is null then
      new.closed_by := null;
    end if;
    new.updated_by := auth.uid();
  end if;
  return new;
end;
$$;

comment on function public.data_incidents_guard() is
  'Trigger: breach steps follow detection and are not in the future; closing needs the whole checklist (contain, assess, notify the Board and the people affected, root cause) (§6.10).';

drop trigger if exists data_incidents_guard on public.data_incidents;
create trigger data_incidents_guard before insert or update on public.data_incidents
  for each row execute function public.data_incidents_guard();

-- =============================================================================================
-- Grants
-- =============================================================================================
revoke execute on function
  public.quality_manual_items_guard(),
  public.peer_reviews_guard(),
  public.independence_declarations_guard(),
  public.restore_drills_guard(),
  public.privacy_notices_guard(),
  public.data_requests_guard(),
  public.data_incidents_guard()
from public, anon, authenticated;

revoke execute on function public.publish_privacy_notice(uuid, timestamptz) from public, anon;
grant execute on function public.publish_privacy_notice(uuid, timestamptz) to authenticated, service_role;
