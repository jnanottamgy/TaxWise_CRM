-- 0195 · Audit engagements to the Standards on Auditing: the schema (§6.8, §6.9, §7.15.5).
--
--   audit_engagements           + had_previous_auditor (null until answered), accepted_on, the
--                               company's facts (company_profile: CARO 2020 and the s.141(3)(g)
--                               count), the Partner's confirmation of a tax audit over the ceiling,
--                               archived_by, updated_by, notes. retain_until = report date + 7 years
--                               (SQC 1) and counts_towards_company_audit_limit are derived here.
--   audit_step_definitions      the SA checklist, stage by stage (mirror of lib/domain/audit-stages.ts
--                               AUDIT_STEPS; tests/db/quality.test.ts checks they match).
--   audit_engagement_documents  evidence: vault documents tagged to a step. Added after archive only
--                               as an amendment, with a note (SA 230).
--   audit_engagement_stage_log  every stage move, approved by the engagement partner.
--   previous_auditor_communications + audit_engagement_id, sent_via, notes, created_by (Clause 8).
--
-- Guards (the database is the real control, §0.1 rule 8):
--   audit_engagements_guard     a session creates an engagement at Acceptance with an empty
--                               checklist; stage, checklist, archive and the ceiling confirmation
--                               change only through the 0196 functions; the engagement partner is an
--                               active Partner; type, year and the acceptance answers change only at
--                               Acceptance; an archived file is read-only for everyone.
--   documents_audit_lock (+ versions, tags)  a document in an archived audit file is read-only for
--                               every caller (new versions and tags included); its retention date may
--                               only be extended.
--   previous_auditor_communications_guard   proof of delivery is one of the client's documents;
--                               dates make sense; a record linked to an archived file is read-only.
--
-- RLS: Partners and Managers read and write audit records (0033; §7.3.3 Engagement tab is Partner/
-- Manager); the new tables are read by Partners and Managers and written only through the functions.

set search_path = public, extensions;

-- =============================================================================================
-- 1. audit_engagements: the extra facts
-- =============================================================================================
alter table public.audit_engagements
  add column if not exists had_previous_auditor boolean,
  add column if not exists accepted_on date,
  add column if not exists company_profile jsonb,
  add column if not exists limit_override_by uuid references public.profiles (id) on delete set null,
  add column if not exists limit_override_at timestamptz,
  add column if not exists limit_override_note text,
  add column if not exists archived_by uuid references public.profiles (id) on delete set null,
  add column if not exists updated_by uuid references public.profiles (id) on delete set null,
  add column if not exists notes text;

alter table public.audit_engagements drop constraint if exists audit_engagements_company_profile_object;
alter table public.audit_engagements
  add constraint audit_engagements_company_profile_object check (company_profile is null or jsonb_typeof(company_profile) = 'object');
alter table public.audit_engagements drop constraint if exists audit_engagements_checklist_object;
alter table public.audit_engagements
  add constraint audit_engagements_checklist_object check (checklist is null or jsonb_typeof(checklist) = 'object');
alter table public.audit_engagements drop constraint if exists audit_engagements_override_complete;
alter table public.audit_engagements
  add constraint audit_engagements_override_complete check (
    (limit_override_at is null and limit_override_by is null)
    or (limit_override_at is not null and limit_override_by is not null and nullif(btrim(limit_override_note), '') is not null)
  );
alter table public.audit_engagements drop constraint if exists audit_engagements_review_manager_not_partner;
alter table public.audit_engagements
  add constraint audit_engagements_review_manager_not_partner check (review_manager_id is null or review_manager_id <> engagement_partner_id);
alter table public.audit_engagements drop constraint if exists audit_engagements_notes_length;
alter table public.audit_engagements
  add constraint audit_engagements_notes_length check (notes is null or length(notes) <= 4000);

comment on column public.audit_engagements.engagement_partner_id is 'employees.id of the engagement partner (an active Partner). Approves every stage move (§7.15.5).';
comment on column public.audit_engagements.review_manager_id is 'employees.id of the review manager (Partner or Manager), never the engagement partner.';
comment on column public.audit_engagements.had_previous_auditor is 'Another CA held the position before (Clause 8). Null until answered at Acceptance; true needs the letter with proof of delivery.';
comment on column public.audit_engagements.accepted_on is 'The day the engagement left Acceptance: the date the peer review certificate must be valid on (§6.8).';
comment on column public.audit_engagements.company_profile is 'Company facts for CARO 2020 and the s.141(3)(g) count: is_public, is_one_person_company, is_section_8, is_banking, is_insurance, is_holding_or_subsidiary(_of_public), is_special_act, is_dormant, paid_up_capital, turnover, capital_and_reserves, max_borrowings, revenue (rupees).';
comment on column public.audit_engagements.limit_override_by is 'The Partner who confirmed taking this tax audit over the ICAI ceiling (§6.8 "a 61st needs a Partner''s confirmation").';
comment on column public.audit_engagements.checklist is '{"steps": {"<step key>": {prepared_by, prepared_at, reviewed_by, reviewed_at, na, na_reason, note}}}: SA sign-offs, written only by audit_step_signoff (0196).';

-- =============================================================================================
-- 2. previous_auditor_communications (Clause 8): link, how it was sent, notes, who recorded it
-- =============================================================================================
alter table public.previous_auditor_communications
  add column if not exists audit_engagement_id uuid references public.audit_engagements (id) on delete set null,
  add column if not exists sent_via text,
  add column if not exists notes text,
  add column if not exists created_by uuid references public.profiles (id) on delete set null;

alter table public.previous_auditor_communications drop constraint if exists previous_auditor_communications_sent_via_values;
alter table public.previous_auditor_communications
  add constraint previous_auditor_communications_sent_via_values
    check (sent_via is null or sent_via in ('registered_post', 'speed_post', 'email', 'hand_delivery', 'courier'));
alter table public.previous_auditor_communications drop constraint if exists previous_auditor_communications_reply_after_letter;
alter table public.previous_auditor_communications
  add constraint previous_auditor_communications_reply_after_letter
    check (reply_received_on is null or reply_received_on >= letter_sent_on);

create index if not exists previous_auditor_communications_client_idx on public.previous_auditor_communications (client_id, letter_sent_on desc);
create index if not exists previous_auditor_communications_engagement_idx on public.previous_auditor_communications (audit_engagement_id) where audit_engagement_id is not null;

-- =============================================================================================
-- 3. audit_step_definitions: the SA checklist (§6.9)
-- =============================================================================================
create table if not exists public.audit_step_definitions (
  key text primary key,
  stage text not null constraint audit_step_definitions_stage_values check (stage in (
    'acceptance', 'planning', 'risk_assessment', 'execution', 'completion', 'reporting', 'archived'
  )),
  sort_order int not null,
  title text not null,
  sa_refs text[] not null default '{}',
  guidance text not null,
  evidence_required boolean not null default false,
  allow_na boolean not null default false,
  audit_types text[],                              -- null = every audit type
  system_check text,                               -- the live fact shown beside it (kyc, materiality, udin …)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.audit_step_definitions enable row level security;

drop trigger if exists set_updated_at on public.audit_step_definitions;
create trigger set_updated_at before update on public.audit_step_definitions
  for each row execute function public.set_updated_at();

comment on table public.audit_step_definitions is
  'The SA-mapped checklist of each audit stage (§6.9). Mirrors lib/domain/audit-stages.ts AUDIT_STEPS.';

insert into public.audit_step_definitions (key, stage, sort_order, title, sa_refs, guidance, evidence_required, allow_na, audit_types, system_check)
values
  ('acc.kyc', 'acceptance', 10, 'Client KYC complete and current', array['ICAI KYC Norms'], 'KYC for the client''s category is complete and re-confirmed within the year: identity, PAN, business, last audited financial statements and the principal persons.', false, false, null, 'kyc'),
  ('acc.independence', 'acceptance', 20, 'Independence and conflict check', array['SQC 1', 'Code of Ethics'], 'The conflict check is decided in the client acceptance register, and the independence questions (financial interest, relationships, other services, fee dependence) are answered with any threats and safeguards recorded.', false, false, null, 'acceptance'),
  ('acc.previous_auditor', 'acceptance', 30, 'Communication with the previous auditor', array['CA Act 1949, First Schedule, Part I, Clause 8'], 'Where another CA held the position, the letter to the outgoing auditor is recorded with proof of delivery, and the reply (or its absence) is noted. Not applicable for a first audit.', false, true, null, 'previous_auditor'),
  ('acc.peer_review', 'acceptance', 40, 'Peer review certificate valid on the acceptance date', array['Peer Review Guidelines 2022'], 'Where the entity needs a peer-reviewed auditor (listed entities, large unlisted public companies, public-interest entities), the firm''s certificate is valid on the acceptance date.', false, true, null, 'peer_review'),
  ('acc.limits', 'acceptance', 50, 'Tax audit ceiling and company audit limit checked', array['ICAI Tax Audit Guidelines 2025', 'Companies Act s.141(3)(g)'], 'The engagement partner stays within 60 tax audits in the year and 20 countable company audits. A tax audit over the ceiling needs a Partner''s confirmation.', false, true, null, 'limits'),
  ('acc.ethics_fees', 'acceptance', 60, 'Fees agreed without a contingent or profit-based element', array['CA Act 1949, First Schedule, Part I, Clause 10'], 'The fee is fixed for the work, not a percentage of profits and not contingent on the findings or results.', false, false, null, null),
  ('acc.engagement_letter', 'acceptance', 70, 'Engagement letter issued (SA 210)', array['SA 210'], 'The terms of the engagement are agreed in a letter at Issued or Signed for the year: objective and scope, responsibilities of auditor and management, the framework and the expected form of report.', false, false, null, 'engagement_letter'),
  ('plan.strategy', 'planning', 80, 'Overall audit strategy and audit plan', array['SA 300'], 'The strategy sets scope, timing and direction; the plan sets the nature, timing and extent of procedures. File both.', true, false, null, null),
  ('plan.materiality', 'planning', 90, 'Materiality determined and documented', array['SA 320'], 'Record the basis, the overall materiality, performance materiality and the clearly-trivial threshold on the engagement.', false, false, null, 'materiality'),
  ('plan.team_briefing', 'planning', 100, 'Engagement team briefed', array['SA 300', 'SA 220'], 'The team knows the client, the risks so far, materiality, the timetable and who reviews what.', false, false, null, null),
  ('risk.entity', 'risk_assessment', 110, 'Understanding of the entity, its environment and internal control', array['SA 315'], 'Document the business, the applicable framework, the internal control relevant to the audit and the walkthroughs done.', true, false, null, null),
  ('risk.significant', 'risk_assessment', 120, 'Risks of material misstatement and significant risks identified', array['SA 315'], 'Risks at the financial-statement and assertion levels, with the significant risks named.', false, false, null, null),
  ('risk.fraud', 'risk_assessment', 130, 'Fraud risk assessed and discussed by the team', array['SA 240'], 'Management inquiries, the team discussion, revenue recognition and management override considered.', false, false, null, null),
  ('risk.laws', 'risk_assessment', 140, 'Compliance with laws and regulations considered', array['SA 250'], 'Laws with a direct effect on the financial statements, and others fundamental to the business.', false, false, null, null),
  ('risk.related_parties', 'risk_assessment', 150, 'Related parties and their transactions identified', array['SA 550'], 'The related-party list from management, checked against the records and the KYC principal persons.', false, false, null, null),
  ('exec.responses', 'execution', 160, 'Responses to the assessed risks performed', array['SA 330'], 'Tests of controls and substantive procedures linked to each assessed risk.', true, false, null, null),
  ('exec.evidence', 'execution', 170, 'Sufficient appropriate audit evidence obtained', array['SA 500'], 'Working papers for each area, uploaded to the vault and tagged to this step.', true, false, null, null),
  ('exec.confirmations', 'execution', 180, 'External confirmations', array['SA 505'], 'Bank, debtor, creditor and other confirmations sent under the auditor''s control, with replies and alternative procedures.', false, true, null, null),
  ('exec.analytics', 'execution', 190, 'Analytical procedures', array['SA 520'], 'Substantive analytics where used, and the overall review near the end of the audit.', false, false, null, null),
  ('exec.sampling', 'execution', 200, 'Audit sampling', array['SA 530'], 'The population, sample size, selection method and the evaluation of results.', false, true, null, null),
  ('exec.estimates', 'execution', 210, 'Accounting estimates', array['SA 540'], 'How management made each estimate, and the auditor''s evaluation of it.', false, true, null, null),
  ('comp.misstatements', 'completion', 220, 'Misstatements evaluated', array['SA 450'], 'The summary of uncorrected misstatements against materiality, communicated to management.', false, false, null, null),
  ('comp.subsequent_events', 'completion', 230, 'Subsequent events reviewed', array['SA 560'], 'Events between the balance sheet date and the report date.', false, false, null, null),
  ('comp.going_concern', 'completion', 240, 'Going concern assessed', array['SA 570'], 'Management''s assessment for at least twelve months, and any material uncertainty.', false, false, null, null),
  ('comp.representations', 'completion', 250, 'Written representations obtained', array['SA 580'], 'The management representation letter, signed and dated as near as practicable to the report date. Download the template from this engagement and file the signed copy.', true, false, null, null),
  ('comp.governance', 'completion', 260, 'Communication with those charged with governance', array['SA 260', 'SA 265'], 'Significant findings and deficiencies in internal control communicated in writing.', false, false, null, null),
  ('rep.opinion', 'reporting', 270, 'Opinion formed and the report drafted', array['SA 700', 'SA 705'], 'Record the report type and the report date on the engagement.', false, false, null, 'opinion'),
  ('rep.kam', 'reporting', 280, 'Key audit matters communicated', array['SA 701'], 'Required for listed entities and where the auditor decides to communicate them; otherwise not applicable.', false, true, array['statutory_companies_act'], null),
  ('rep.eom', 'reporting', 290, 'Emphasis of matter and other matter paragraphs considered', array['SA 706'], 'Include them where needed; not applicable when there are none.', false, true, null, null),
  ('rep.caro', 'reporting', 300, 'CARO 2020 applicability decided and reported on', array['CARO 2020', 'Companies Act s.143(11)'], 'CARO doesn''t apply to small companies, one person companies, banking, insurance or Section 8 companies, or the private companies Para 1(2)(v) excludes. Record the decision.', false, false, array['statutory_companies_act'], 'caro'),
  ('rep.tax_audit_form', 'reporting', 310, 'Tax audit report in the form for the year', array['Income-tax Act 1961 s.44AB', 'Income-tax Act 2025 s.63'], 'Form 3CA or 3CB with 3CD up to AY 2026-27; Form 26 from tax year 2026-27.', true, false, array['tax_audit'], null),
  ('rep.udin', 'reporting', 320, 'UDIN generated within 60 days of signing', array['ICAI UDIN Guidelines'], 'Generate the UDIN on the ICAI portal, log it in the UDIN register and link it to this engagement.', false, false, null, 'udin'),
  ('arch.assembly', 'archived', 330, 'Final audit file assembled', array['SA 230'], 'Assemble the final file within 60 days of the report date. After archiving, nothing is changed or removed; any addition is logged as an amendment.', false, false, null, 'assembly'),
  ('arch.partner_review', 'archived', 340, 'Engagement partner''s final review of the file', array['SQC 1', 'SA 220'], 'The engagement partner is satisfied the file supports the report, before it is locked.', false, false, null, null)
on conflict (key) do update set
  stage = excluded.stage, sort_order = excluded.sort_order, title = excluded.title, sa_refs = excluded.sa_refs,
  guidance = excluded.guidance, evidence_required = excluded.evidence_required, allow_na = excluded.allow_na,
  audit_types = excluded.audit_types, system_check = excluded.system_check;

create policy audit_step_definitions_select on public.audit_step_definitions
  for select to authenticated using ((select public.is_manager_or_partner()));
revoke insert, update, delete, truncate on public.audit_step_definitions from authenticated, anon;

-- =============================================================================================
-- 4. audit_engagement_documents: evidence tagged to a step (§6.9 "uploaded to the vault and tagged
--    to the step"); after archive only as an amendment with a note (SA 230).
-- =============================================================================================
create table if not exists public.audit_engagement_documents (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references public.audit_engagements (id) on delete cascade,
  document_id uuid not null references public.documents (id) on delete cascade,
  step_key text not null references public.audit_step_definitions (key) on update cascade,
  is_amendment boolean not null default false,
  amendment_note text,
  added_by uuid not null references public.profiles (id),
  added_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint audit_engagement_documents_unique unique (engagement_id, document_id, step_key),
  constraint audit_engagement_documents_amendment_note
    check (not is_amendment or nullif(btrim(amendment_note), '') is not null)
);
alter table public.audit_engagement_documents enable row level security;

drop trigger if exists set_updated_at on public.audit_engagement_documents;
create trigger set_updated_at before update on public.audit_engagement_documents
  for each row execute function public.set_updated_at();

create index if not exists audit_engagement_documents_document_idx on public.audit_engagement_documents (document_id);
create index if not exists audit_engagement_documents_step_idx on public.audit_engagement_documents (engagement_id, step_key);

comment on table public.audit_engagement_documents is
  'Working papers and other evidence for an audit step (§6.9). Written only by audit_attach_evidence / audit_detach_evidence (0196).';

create policy audit_engagement_documents_select on public.audit_engagement_documents
  for select to authenticated using ((select public.is_manager_or_partner()));
revoke insert, update, delete, truncate on public.audit_engagement_documents from authenticated, anon;

-- =============================================================================================
-- 5. audit_engagement_stage_log: who approved each move, when, and why (§7.15.5)
-- =============================================================================================
create table if not exists public.audit_engagement_stage_log (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references public.audit_engagements (id) on delete cascade,
  from_stage text not null,
  to_stage text not null,
  approved_by uuid not null references public.profiles (id),
  note text,
  warnings jsonb not null default '[]'::jsonb,
  at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.audit_engagement_stage_log enable row level security;

create index if not exists audit_engagement_stage_log_engagement_idx on public.audit_engagement_stage_log (engagement_id, at desc);

comment on table public.audit_engagement_stage_log is
  'Each stage move of an audit engagement with the engagement partner who approved it (§7.15.5). Insert-only, through advance_audit_stage (0196).';

create policy audit_engagement_stage_log_select on public.audit_engagement_stage_log
  for select to authenticated using ((select public.is_manager_or_partner()));
revoke insert, update, delete, truncate on public.audit_engagement_stage_log from authenticated, anon;

-- =============================================================================================
-- 6. Company facts (mirrors lib/domain/audit-stages.ts isSmallCompany / countsTowardsCompanyLimit)
-- =============================================================================================
create or replace function public.is_small_company(p_profile jsonb, p_on date)
returns boolean
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  v_limits jsonb := public.statutory_param_value('company.small_company_limits', p_on);
  v_cap_limit numeric := coalesce(public.jsonb_to_numeric(v_limits -> 'paid_up_capital'), 100000000);
  v_turnover_limit numeric := coalesce(public.jsonb_to_numeric(v_limits -> 'turnover'), 1000000000);
  v_public boolean;
  v_cap numeric;
  v_turnover numeric;
begin
  if p_profile is null or jsonb_typeof(p_profile) <> 'object' then
    return null;
  end if;
  v_public := case p_profile -> 'is_public' when 'true'::jsonb then true when 'false'::jsonb then false end;
  if v_public is true
     or coalesce((p_profile ->> 'is_holding_or_subsidiary')::boolean, false)
     or coalesce((p_profile ->> 'is_section_8')::boolean, false)
     or coalesce((p_profile ->> 'is_special_act')::boolean, false) then
    return false;
  end if;
  v_cap := public.jsonb_to_numeric(p_profile -> 'paid_up_capital');
  v_turnover := public.jsonb_to_numeric(p_profile -> 'turnover');
  if v_public is null or v_cap is null or v_turnover is null then
    return null;
  end if;
  return v_cap <= v_cap_limit and v_turnover <= v_turnover_limit;
end;
$$;

comment on function public.is_small_company(jsonb, date) is
  'Companies Act s.2(85) with the limits in force on the date (company.small_company_limits): not public, holding/subsidiary, Section 8 or special-Act; capital and turnover within the limits. Null when unknown.';

create or replace function public.company_counts_towards_audit_limit(p_profile jsonb, p_on date)
returns boolean
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  v_small boolean;
  v_public boolean;
  v_cap numeric;
  v_exclusion numeric := coalesce(public.jsonb_to_numeric(public.statutory_param_value('audit.company_audit_private_paid_up_exclusion', p_on)), 1000000000);
begin
  if p_profile is null or jsonb_typeof(p_profile) <> 'object' then
    return null;
  end if;
  if coalesce((p_profile ->> 'is_one_person_company')::boolean, false) or coalesce((p_profile ->> 'is_dormant')::boolean, false) then
    return false;
  end if;
  v_small := public.is_small_company(p_profile, p_on);
  if v_small is true then
    return false;
  end if;
  v_public := case p_profile -> 'is_public' when 'true'::jsonb then true when 'false'::jsonb then false end;
  if v_public is null then
    return null;
  end if;
  if v_public is false then
    v_cap := public.jsonb_to_numeric(p_profile -> 'paid_up_capital');
    if v_cap is null then
      return null;
    end if;
    return v_cap >= v_exclusion;
  end if;
  return true;
end;
$$;

comment on function public.company_counts_towards_audit_limit(jsonb, date) is
  'Whether auditing the company counts towards the 20 per partner (Companies Act s.141(3)(g), §6.8): not OPCs, small or dormant companies, or private companies under ₹100 crore paid-up. Null when unknown.';

-- A step is done when it is prepared (or marked not applicable) and reviewed (§6.9).
create or replace function public.audit_step_done(p_checklist jsonb, p_key text)
returns boolean
language sql
immutable
set search_path = public, extensions
as $$
  select coalesce(
    ((p_checklist -> 'steps' -> p_key ->> 'prepared_at') is not null or (p_checklist -> 'steps' -> p_key -> 'na') = 'true'::jsonb)
    and (p_checklist -> 'steps' -> p_key ->> 'reviewed_at') is not null,
    false)
$$;

comment on function public.audit_step_done(jsonb, text) is
  'True when a checklist step is prepared (or N/A) and reviewed (mirror of lib/domain/audit-stages.ts stepDone).';

-- =============================================================================================
-- 7. audit_engagements_derive (every writer): retain_until, the company-limit flag, updated_by
-- =============================================================================================
create or replace function public.audit_engagements_derive()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_years numeric;
begin
  if new.report_date is null then
    new.retain_until := null;
  else
    v_years := coalesce(public.jsonb_to_numeric(public.statutory_param_value('retention.working_papers_years', new.report_date)), 7);
    new.retain_until := (new.report_date + make_interval(years => v_years::int))::date;
  end if;
  if new.audit_type = 'statutory_companies_act' then
    new.counts_towards_company_audit_limit := public.company_counts_towards_audit_limit(new.company_profile, public.fy_end_date(new.financial_year));
  else
    new.counts_towards_company_audit_limit := null;
  end if;
  if new.checklist is null then
    new.checklist := '{}'::jsonb;
  end if;
  if auth.uid() is not null then
    new.updated_by := auth.uid();
  end if;
  return new;
end;
$$;

comment on function public.audit_engagements_derive() is
  'Trigger: retain_until = report date + 7 years (SQC 1, retention.working_papers_years); counts_towards_company_audit_limit from the company facts (§6.8); updated_by.';

drop trigger if exists audit_engagements_derive on public.audit_engagements;
create trigger audit_engagements_derive before insert or update on public.audit_engagements
  for each row execute function public.audit_engagements_derive();

-- =============================================================================================
-- 8. audit_engagements_guard
-- =============================================================================================
create or replace function public.audit_engagements_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_ok boolean;
begin
  -- An archived file is read-only for everyone (SA 230, §6.9). Additions go in as amendments.
  if tg_op in ('UPDATE', 'DELETE') and old.archived_at is not null then
    raise exception 'USER: This audit file is archived and read-only. Add anything new as an amendment.' using errcode = 'P0001';
  end if;

  if not public.is_api_caller() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    if old.stage <> 'acceptance' or exists (select 1 from public.audit_engagement_documents d where d.engagement_id = old.id) then
      raise exception 'USER: Only an engagement still at Acceptance, with no working papers, can be deleted.' using errcode = 'P0001';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    new.stage := 'acceptance';
    new.archived_at := null;
    new.archived_by := null;
    new.checklist := '{}'::jsonb;
    new.limit_override_by := null;
    new.limit_override_at := null;
    new.limit_override_note := null;
    new.accepted_on := null;
    new.created_by := auth.uid();
  else
    if new.stage is distinct from old.stage or new.archived_at is distinct from old.archived_at or new.archived_by is distinct from old.archived_by then
      raise exception 'USER: Move the engagement with the stage tracker; the engagement partner approves each move.' using errcode = 'P0001';
    end if;
    if new.checklist is distinct from old.checklist then
      raise exception 'USER: Sign off checklist steps one at a time from the engagement page.' using errcode = 'P0001';
    end if;
    if new.limit_override_by is distinct from old.limit_override_by or new.limit_override_at is distinct from old.limit_override_at
       or new.limit_override_note is distinct from old.limit_override_note then
      raise exception 'USER: Only a Partner can confirm a tax audit over the ceiling, from the engagement page.' using errcode = 'P0001';
    end if;
    if new.accepted_on is distinct from old.accepted_on or new.created_by is distinct from old.created_by or new.client_id is distinct from old.client_id then
      raise exception 'USER: You can''t change the client, the acceptance date or who created the engagement.' using errcode = 'P0001';
    end if;
    if old.stage <> 'acceptance' and (
         new.audit_type is distinct from old.audit_type
         or new.financial_year is distinct from old.financial_year
         or new.had_previous_auditor is distinct from old.had_previous_auditor
         or new.requires_peer_reviewed_auditor is distinct from old.requires_peer_reviewed_auditor) then
      raise exception 'USER: The audit type, year and acceptance answers are fixed once the engagement is past Acceptance.' using errcode = 'P0001';
    end if;
    if new.engagement_partner_id is distinct from old.engagement_partner_id and not public.is_partner() then
      raise exception 'USER: Only a Partner can change the engagement partner.' using errcode = 'P0001';
    end if;
  end if;

  -- The engagement partner is an active Partner; the review manager an active Partner or Manager.
  if tg_op = 'INSERT' or new.engagement_partner_id is distinct from old.engagement_partner_id then
    select exists (
      select 1 from public.employees e join public.profiles p on p.id = e.profile_id
      where e.id = new.engagement_partner_id and e.is_active and e.deleted_at is null and p.is_active and p.role = 'partner'
    ) into v_ok;
    if not v_ok then
      raise exception 'USER: The engagement partner must be an active Partner of the firm.' using errcode = 'P0001';
    end if;
  end if;
  if new.review_manager_id is not null and (tg_op = 'INSERT' or new.review_manager_id is distinct from old.review_manager_id) then
    select exists (
      select 1 from public.employees e join public.profiles p on p.id = e.profile_id
      where e.id = new.review_manager_id and e.is_active and e.deleted_at is null and p.is_active and p.role in ('partner', 'manager')
    ) into v_ok;
    if not v_ok then
      raise exception 'USER: The review manager must be an active Partner or Manager.' using errcode = 'P0001';
    end if;
  end if;
  if new.udin_record_id is not null and (tg_op = 'INSERT' or new.udin_record_id is distinct from old.udin_record_id) then
    if not exists (select 1 from public.udin_records u where u.id = new.udin_record_id and (u.client_id is null or u.client_id = new.client_id)) then
      raise exception 'USER: Link a UDIN logged for this client.' using errcode = 'P0001';
    end if;
  end if;
  if new.report_date is not null and new.report_date > public.today_ist() then
    raise exception 'USER: The report date can''t be in the future.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

comment on function public.audit_engagements_guard() is
  'Trigger: archived files are read-only for everyone; for sessions, stage/checklist/archive/ceiling confirmation only through the 0196 functions, partner and manager roles checked, type/year/acceptance answers fixed after Acceptance (§6.9, §7.15.5).';

drop trigger if exists audit_engagements_guard on public.audit_engagements;
create trigger audit_engagements_guard before insert or update or delete on public.audit_engagements
  for each row execute function public.audit_engagements_guard();

-- =============================================================================================
-- 9. The archived audit file locks its documents (SA 230, §6.9 "the engagement and its documents
--    become read-only"). SECURITY DEFINER trigger functions: the lock holds whoever writes,
--    including the upload function confirm_document_upload (a new version is refused).
-- =============================================================================================
create or replace function public.audit_file_lock_reason(p_document_id uuid)
returns text
language sql
stable
security definer
set search_path = public, extensions
as $$
  select format('This document is part of the archived %s file for %s (FY %s), so it is read-only. Add anything new to the engagement as an amendment.',
                case e.audit_type
                  when 'statutory_companies_act' then 'statutory audit'
                  when 'tax_audit' then 'tax audit'
                  when 'gst_audit' then 'GST audit'
                  when 'internal' then 'internal audit'
                  when 'bank_branch' then 'bank branch audit'
                  when 'stock' then 'stock audit'
                  when 'certification' then 'certification'
                  else 'audit'
                end,
                c.display_name, e.financial_year)
  from public.audit_engagement_documents l
  join public.audit_engagements e on e.id = l.engagement_id
  join public.clients c on c.id = e.client_id
  where l.document_id = p_document_id and e.archived_at is not null
  order by e.archived_at
  limit 1
$$;

comment on function public.audit_file_lock_reason(uuid) is
  'Why a document is read-only (it is in an archived audit file), or null. Used by the document lock triggers.';

create or replace function public.documents_audit_lock()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_reason text := public.audit_file_lock_reason(old.id);
begin
  if v_reason is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'UPDATE' then
    -- Only the retention date may move, and only later (archiving extends it to report date + 7 years).
    if (to_jsonb(new) - 'retention_until' - 'updated_at') = (to_jsonb(old) - 'retention_until' - 'updated_at')
       and (old.retention_until is null or (new.retention_until is not null and new.retention_until >= old.retention_until)) then
      return new;
    end if;
  end if;
  raise exception 'USER: %', v_reason using errcode = 'P0001';
end;
$$;

drop trigger if exists documents_audit_lock on public.documents;
create trigger documents_audit_lock before update or delete on public.documents
  for each row execute function public.documents_audit_lock();

create or replace function public.document_children_audit_lock()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_doc uuid := case when tg_op = 'DELETE' then old.document_id else new.document_id end;
  v_reason text := public.audit_file_lock_reason(v_doc);
begin
  if v_reason is not null then
    raise exception 'USER: %', v_reason using errcode = 'P0001';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists document_versions_audit_lock on public.document_versions;
create trigger document_versions_audit_lock before insert on public.document_versions
  for each row execute function public.document_children_audit_lock();
drop trigger if exists document_tags_audit_lock on public.document_tags;
create trigger document_tags_audit_lock before insert or update or delete on public.document_tags
  for each row execute function public.document_children_audit_lock();

comment on function public.documents_audit_lock() is
  'Trigger: a document in an archived audit file is read-only (only its retention date may be extended); deleting it is refused (SA 230).';
comment on function public.document_children_audit_lock() is
  'Trigger: no new version or tag change for a document in an archived audit file (SA 230).';

-- =============================================================================================
-- 10. previous_auditor_communications_guard (Clause 8)
-- =============================================================================================
create or replace function public.previous_auditor_communications_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_engagement record;
begin
  if tg_op in ('UPDATE', 'DELETE') and old.audit_engagement_id is not null
     and exists (select 1 from public.audit_engagements e where e.id = old.audit_engagement_id and e.archived_at is not null) then
    raise exception 'USER: This letter is part of an archived audit file and is read-only.' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' or not public.is_api_caller() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
  elsif new.created_by is distinct from old.created_by then
    new.created_by := old.created_by;
  end if;
  if new.letter_sent_on > public.today_ist() then
    raise exception 'USER: The letter can''t have been sent in the future.' using errcode = 'P0001';
  end if;
  if new.reply_received_on is not null and new.reply_received_on > public.today_ist() then
    raise exception 'USER: The reply can''t have arrived in the future.' using errcode = 'P0001';
  end if;
  if new.delivery_proof_document_id is not null and (tg_op = 'INSERT' or new.delivery_proof_document_id is distinct from old.delivery_proof_document_id) then
    if not exists (
      select 1 from public.documents d
      where d.id = new.delivery_proof_document_id and d.client_id = new.client_id and d.deleted_at is null
    ) then
      raise exception 'USER: Choose the proof of delivery from this client''s documents.' using errcode = 'P0001';
    end if;
  end if;
  if new.audit_engagement_id is not null and (tg_op = 'INSERT' or new.audit_engagement_id is distinct from old.audit_engagement_id) then
    select e.client_id, e.archived_at into v_engagement from public.audit_engagements e where e.id = new.audit_engagement_id;
    if v_engagement.client_id is distinct from new.client_id then
      raise exception 'USER: That audit engagement belongs to another client.' using errcode = 'P0001';
    end if;
    if v_engagement.archived_at is not null then
      raise exception 'USER: That audit file is archived and read-only.' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

comment on function public.previous_auditor_communications_guard() is
  'Trigger: proof of delivery is one of the client''s documents; no future dates; a letter in an archived audit file is read-only (Clause 8, §6.8).';

drop trigger if exists previous_auditor_communications_guard on public.previous_auditor_communications;
create trigger previous_auditor_communications_guard before insert or update or delete on public.previous_auditor_communications
  for each row execute function public.previous_auditor_communications_guard();

-- =============================================================================================
-- Grants
-- =============================================================================================
revoke execute on function
  public.audit_engagements_derive(),
  public.audit_engagements_guard(),
  public.documents_audit_lock(),
  public.document_children_audit_lock(),
  public.previous_auditor_communications_guard()
from public, anon, authenticated;

revoke execute on function public.audit_file_lock_reason(uuid) from public, anon, authenticated;
grant execute on function public.audit_file_lock_reason(uuid) to service_role;

revoke execute on function
  public.is_small_company(jsonb, date),
  public.company_counts_towards_audit_limit(jsonb, date),
  public.audit_step_done(jsonb, text)
from public, anon;
grant execute on function
  public.is_small_company(jsonb, date),
  public.company_counts_towards_audit_limit(jsonb, date),
  public.audit_step_done(jsonb, text)
to authenticated, service_role;
