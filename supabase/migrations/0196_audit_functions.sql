-- 0196 · Audit engagements: the gates and the only ways to move, sign and archive (§6.8, §6.9,
-- §7.15.5, §18.3 Partner 3 "KYC and the previous-auditor step block the audit engagement until
-- completed").
--
--   kyc_missing(client) / kyc_review_due(client, on) / kyc_status(client)
--                               ICAI KYC Norms completeness for the client's category, and the
--                               annual re-confirmation (mirror of lib/domain/ceiling.ts kycCompleteness).
--   audit_limit_check(id)       the engagement partner's company-audit count (s.141(3)(g): block over
--                               20, warn from 18) or tax-audit count (ICAI ceiling 60: a Partner
--                               confirms one over it; warn at 50 and 58).
--   audit_stage_gate(id, to)    what stands between the engagement and the stage asked for:
--                               the stage's checklist signed (prepared or N/A, then reviewed by
--                               someone else); leaving Acceptance also needs KYC complete and current,
--                               the conflict check accepted, an engagement letter at Issued or Signed
--                               for the year (SA 210), the previous-auditor answer and, where there was
--                               one, the letter with proof of delivery (Clause 8), a peer review
--                               certificate valid on the acceptance date where required, and no
--                               ceiling block; leaving Planning needs materiality (SA 320); archiving
--                               needs the report type and date, the UDIN, and the CARO decision for a
--                               company. Returns {ok, missing[], warnings[], is_engagement_partner}.
--   advance_audit_stage(id, to, note, expected)
--                               the engagement partner moves it (one stage forward through the gate,
--                               or back with a reason); archiving locks the file and extends the
--                               retention of its documents to report date + 7 years.
--   audit_step_signoff(id, step, action, note)
--                               prepare · not_applicable (with a reason) · review (not by the preparer)
--                               · reopen. Evidence steps need a document before they are prepared.
--   audit_attach_evidence(id, step, documents[], note) / audit_detach_evidence(link)
--                               vault documents of the client tagged to a step; after archive only as an
--                               amendment with a note.
--   confirm_audit_limit_override(id, note)
--                               a Partner confirms a tax audit over the ICAI ceiling (§6.8).
--
-- Every function checks the caller is a Partner or Manager (the audit records are theirs, §4.1) and
-- raises plain 'USER: …' sentences (CONVENTIONS §3.4). The writers are SECURITY DEFINER because the
-- guard (0195) keeps stage, checklist and evidence out of reach of direct API writes.

set search_path = public, extensions;

-- =============================================================================================
-- KYC (§6.8 ICAI KYC Norms)
-- =============================================================================================
create or replace function public.kyc_missing(p_client_id uuid)
returns text[]
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  c record;
  k record;
  v_missing text[] := '{}';
  v_people jsonb;
  v_count int;
  v_bad int;
begin
  select cl.legal_name, cl.display_name into c from public.clients cl where cl.id = p_client_id;
  if not found then
    return array['the KYC record'];
  end if;
  select * into k from public.client_kyc where client_id = p_client_id;
  if not found then
    return array['the KYC record'];
  end if;

  if coalesce(nullif(btrim(c.legal_name), ''), nullif(btrim(c.display_name), '')) is null then v_missing := array_append(v_missing, 'name'); end if;
  if nullif(btrim(k.pan::text), '') is null then v_missing := array_append(v_missing, 'PAN'); end if;
  if nullif(btrim(k.business_description), '') is null then v_missing := array_append(v_missing, 'business description'); end if;
  if k.last_audited_fs_document_id is null then v_missing := array_append(v_missing, 'last audited financial statements'); end if;
  if k.engagement_types is null or cardinality(k.engagement_types) = 0 then v_missing := array_append(v_missing, 'engagement type'); end if;

  -- Principal persons as the app reads them: objects with a name.
  select coalesce(jsonb_agg(p), '[]'::jsonb) into v_people
  from jsonb_array_elements(case when jsonb_typeof(k.principal_persons) = 'array' then k.principal_persons else '[]'::jsonb end) p
  where jsonb_typeof(p) = 'object' and nullif(btrim(p ->> 'name'), '') is not null;
  v_count := jsonb_array_length(v_people);

  if k.entity_category = 'corporate' then
    if nullif(btrim(k.cin_llpin), '') is null then v_missing := array_append(v_missing, 'CIN'); end if;
    if v_count = 0 then
      v_missing := array_append(v_missing, 'directors');
    else
      select count(*) into v_bad from jsonb_array_elements(v_people) p
      where nullif(btrim(p ->> 'address'), '') is null or nullif(btrim(p ->> 'din'), '') is null;
      if v_bad > 0 then v_missing := array_append(v_missing, 'each director''s name, address and DIN'); end if;
    end if;
  elsif k.entity_category = 'non_corporate' then
    if v_count = 0 then
      v_missing := array_append(v_missing, 'partners or trustees');
    else
      select count(*) into v_bad from jsonb_array_elements(v_people) p
      where nullif(btrim(p ->> 'address'), '') is null
         or (nullif(btrim(p ->> 'pan'), '') is null and nullif(btrim(p ->> 'din'), '') is null);
      if v_bad > 0 then v_missing := array_append(v_missing, 'each partner''s or trustee''s name, address and PAN or DIN'); end if;
    end if;
  end if;
  return v_missing;
end;
$$;

comment on function public.kyc_missing(uuid) is
  'What the client''s KYC lacks for its category (ICAI KYC Norms, §6.8), in plain words; empty when complete. Mirror of kycCompleteness.';

create or replace function public.kyc_review_due(p_client_id uuid, p_on date default null)
returns boolean
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  k record;
  v_on date := coalesce(p_on, public.today_ist());
  v_months numeric;
  v_review date;
begin
  select verified_on, next_review_on into k from public.client_kyc where client_id = p_client_id;
  if not found then
    return true;
  end if;
  v_months := coalesce(public.jsonb_to_numeric(public.statutory_param_value('kyc.reconfirm_months', v_on)), 12);
  v_review := coalesce(k.next_review_on, case when k.verified_on is not null then (k.verified_on + make_interval(months => v_months::int))::date end);
  return v_review is null or v_on > v_review;
end;
$$;

comment on function public.kyc_review_due(uuid, date) is
  'The annual KYC re-confirmation is due (or it was never verified) on the date (§6.8, kyc.reconfirm_months).';

create or replace function public.kyc_status(p_client_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  v_missing text[] := public.kyc_missing(p_client_id);
  v_due boolean := public.kyc_review_due(p_client_id, null);
begin
  return jsonb_build_object(
    'missing', to_jsonb(v_missing),
    'complete', cardinality(v_missing) = 0,
    'review_due', v_due,
    'current', cardinality(v_missing) = 0 and not v_due
  );
end;
$$;

comment on function public.kyc_status(uuid) is 'KYC completeness and re-confirmation for a client: {missing, complete, review_due, current}.';

-- =============================================================================================
-- Ceilings (§6.8)
-- =============================================================================================
create or replace function public.audit_limit_check(p_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  e public.audit_engagements%rowtype;
  v_profile uuid;
  v_fy text := public.financial_year_label(public.today_ist());
  v_current int;
  v_limit int;
  v_warn int;
  v_warn_at jsonb;
  v_position int;
  v_level text := 'ok';
  v_message text;
begin
  select * into e from public.audit_engagements where id = p_id;
  if not found then
    return null;
  end if;

  if e.audit_type = 'statutory_companies_act' then
    if e.counts_towards_company_audit_limit is null then
      return jsonb_build_object('kind', 'company', 'level', 'unknown', 'counted', null,
        'message', 'Record the company''s facts (public or private, paid-up capital, turnover) to check the company audit limit.');
    end if;
    if e.counts_towards_company_audit_limit is false then
      return jsonb_build_object('kind', 'company', 'level', 'ok', 'counted', false,
        'message', 'This company doesn''t count towards the 20-audit limit (s.141(3)(g)).');
    end if;
    select count(*) into v_current from public.audit_engagements o
    where o.engagement_partner_id = e.engagement_partner_id
      and o.financial_year = e.financial_year
      and o.audit_type = 'statutory_companies_act'
      and o.counts_towards_company_audit_limit
      and o.stage <> 'acceptance'
      and o.id <> e.id;
    v_limit := coalesce(public.jsonb_to_numeric(public.statutory_param_value('audit.company_audit_limit', public.today_ist()))::int, 20);
    v_warn := coalesce(public.jsonb_to_numeric(public.statutory_param_value('audit.company_audit_limit_warn_from', public.today_ist()))::int, 18);
    v_position := v_current + 1;
    if v_position > v_limit then
      v_level := 'block';
      v_message := format('This would be company audit %s for the engagement partner, over the limit of %s (Companies Act s.141(3)(g)).', v_position, v_limit);
    elsif v_position >= v_warn then
      v_level := 'warn';
      v_message := format('This is company audit %s of %s for the engagement partner (%s left).', v_position, v_limit, v_limit - v_position);
    end if;
    return jsonb_build_object('kind', 'company', 'level', v_level, 'counted', true, 'current', v_current, 'position', v_position, 'limit', v_limit, 'message', v_message);
  end if;

  if e.audit_type = 'tax_audit' then
    select profile_id into v_profile from public.employees where id = e.engagement_partner_id;
    select coalesce(max(v.total_count), 0) into v_current
    from public.tax_audit_ceiling_view v
    where v.member_profile_id = v_profile and v.financial_year = v_fy;
    -- Tax audits this partner has accepted and not yet signed will count when they are signed.
    v_current := v_current + (
      select count(*) from public.audit_engagements o
      where o.engagement_partner_id = e.engagement_partner_id
        and o.audit_type = 'tax_audit'
        and o.stage not in ('acceptance', 'archived')
        and o.report_date is null
        and o.id <> e.id
    );
    v_limit := coalesce(public.jsonb_to_numeric(public.statutory_param_value('audit.tax_audit_ceiling', public.fy_start_date(v_fy)))::int, 60);
    v_warn_at := public.statutory_param_value('audit.tax_audit_ceiling_warn_at', public.fy_start_date(v_fy));
    select min(public.jsonb_to_numeric(w))::int into v_warn
    from jsonb_array_elements(case when jsonb_typeof(v_warn_at) = 'array' then v_warn_at else '[50]'::jsonb end) w;
    v_position := v_current + 1;
    if v_position > v_limit then
      v_level := 'confirm';
      v_message := case when e.limit_override_at is not null
        then format('Tax audit %s for the engagement partner in FY %s, over the ICAI ceiling of %s, confirmed by a Partner.', v_position, v_fy, v_limit)
        else format('This would be tax audit %s for the engagement partner in FY %s, over the ICAI ceiling of %s. A Partner must confirm it.', v_position, v_fy, v_limit) end;
    elsif v_position >= coalesce(v_warn, v_limit) then
      v_level := 'warn';
      v_message := format('This is tax audit %s of %s for the engagement partner in FY %s (%s left).', v_position, v_limit, v_fy, v_limit - v_position);
    end if;
    return jsonb_build_object('kind', 'tax_audit', 'level', v_level, 'counted', true, 'current', v_current, 'position', v_position, 'limit', v_limit,
      'financial_year', v_fy, 'overridden', e.limit_override_at is not null, 'message', v_message);
  end if;

  return jsonb_build_object('kind', null, 'level', 'ok', 'counted', false, 'message', null);
end;
$$;

comment on function public.audit_limit_check(uuid) is
  'The engagement partner''s company audit count (s.141(3)(g)) or tax audit count (ICAI ceiling) with this engagement added: {kind, level ok|warn|block|confirm|unknown, position, limit, message} (§6.8).';

-- =============================================================================================
-- audit_stage_gate
-- =============================================================================================
create or replace function public.audit_stage_gate(p_id uuid, p_to text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  c_stages constant text[] := array['acceptance', 'planning', 'risk_assessment', 'execution', 'completion', 'reporting', 'archived'];
  c_labels constant text[] := array['Acceptance', 'Planning', 'Risk assessment', 'Execution', 'Completion', 'Reporting', 'Archive'];
  e public.audit_engagements%rowtype;
  v_from int;
  v_to int;
  v_missing jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
  v_kyc text[];
  v_limit jsonb;
  v_services text[];
  v_m jsonb;
  d record;
  v_today date := public.today_ist();
  v_is_partner boolean;
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only Partners and Managers work on audit engagements.' using errcode = 'P0001';
  end if;
  select * into e from public.audit_engagements where id = p_id;
  if not found then
    raise exception 'USER: That audit engagement no longer exists.' using errcode = 'P0001';
  end if;
  v_from := array_position(c_stages, e.stage);
  v_to := array_position(c_stages, p_to);
  if v_to is null then
    raise exception 'USER: That isn''t a stage of an audit.' using errcode = 'P0001';
  end if;
  v_is_partner := public.my_employee_id() is not distinct from e.engagement_partner_id;

  if e.archived_at is not null or e.stage = 'archived' then
    v_missing := v_missing || jsonb_build_object('code', 'archived', 'message', 'the file is archived and read-only');
  elsif v_to = v_from then
    v_missing := v_missing || jsonb_build_object('code', 'same_stage', 'message', format('the engagement is already at %s', c_labels[v_to]));
  elsif v_to > v_from + 1 then
    v_missing := v_missing || jsonb_build_object('code', 'one_at_a_time', 'message', format('move one stage at a time (%s comes next)', c_labels[v_from + 1]));
  elsif v_to > v_from then
    -- The checklist of the stage being left (and Archive's own steps when archiving).
    for d in
      select s.key, s.title from public.audit_step_definitions s
      where (s.stage = e.stage or (p_to = 'archived' and s.stage = 'archived'))
        and (s.audit_types is null or e.audit_type = any (s.audit_types))
      order by s.sort_order
    loop
      if not public.audit_step_done(e.checklist, d.key) then
        v_missing := v_missing || jsonb_build_object('code', 'step', 'step', d.key, 'message', format('sign off "%s" (prepared and reviewed)', d.title));
      end if;
    end loop;

    if e.stage = 'acceptance' then
      v_kyc := public.kyc_missing(e.client_id);
      if cardinality(v_kyc) > 0 then
        v_missing := v_missing || jsonb_build_object('code', 'kyc', 'message', format('complete the client''s KYC (%s)', array_to_string(v_kyc, ', ')));
      elsif public.kyc_review_due(e.client_id, v_today) then
        v_missing := v_missing || jsonb_build_object('code', 'kyc_review', 'message', 're-confirm the client''s KYC (the annual review is due)');
      end if;

      if not exists (select 1 from public.client_acceptances a where a.client_id = e.client_id and a.outcome = 'accepted') then
        v_missing := v_missing || jsonb_build_object('code', 'acceptance', 'message', 'record an accepted conflict and independence check for the client in the acceptance register');
      end if;

      v_services := case e.audit_type
        when 'tax_audit' then array['audit', 'income_tax']
        when 'gst_audit' then array['audit', 'gst']
        else array['audit'] end;
      -- The letter for this engagement (0193 links it), or a letter for the year covering the audit.
      if not exists (
        select 1 from public.engagement_letters l
        where l.client_id = e.client_id and l.status in ('issued', 'signed')
          and (
            l.audit_engagement_id = e.id
            or (l.audit_engagement_id is null and l.financial_year = e.financial_year
                and (l.audit_type = e.audit_type or (l.audit_type is null and l.service_types::text[] && v_services)))
          )
      ) then
        v_missing := v_missing || jsonb_build_object('code', 'engagement_letter', 'message', format('issue the engagement letter for FY %s covering the audit (SA 210)', e.financial_year));
      end if;

      if e.had_previous_auditor is null then
        v_missing := v_missing || jsonb_build_object('code', 'previous_auditor_unanswered', 'message', 'say whether another CA was the auditor before');
      elsif e.had_previous_auditor and not exists (
        select 1 from public.previous_auditor_communications pac
        where pac.client_id = e.client_id
          and pac.delivery_proof_document_id is not null
          and (pac.audit_engagement_id = e.id or (pac.audit_engagement_id is null and pac.engagement_type = e.audit_type))
      ) then
        v_missing := v_missing || jsonb_build_object('code', 'previous_auditor', 'message', 'record the letter to the previous auditor with proof of delivery (Clause 8)');
      end if;

      if e.requires_peer_reviewed_auditor and not exists (
        select 1 from public.peer_reviews pr
        where pr.status = 'completed' and pr.certificate_no is not null and pr.valid_until >= v_today
          and (pr.reviewed_on is null or pr.reviewed_on <= v_today)
      ) then
        v_missing := v_missing || jsonb_build_object('code', 'peer_review', 'message', 'hold a peer review certificate valid on the acceptance date');
      end if;

      v_limit := public.audit_limit_check(e.id);
      if v_limit ->> 'level' = 'unknown' then
        v_missing := v_missing || jsonb_build_object('code', 'company_facts', 'message', 'record the company''s facts to check the company audit limit');
      elsif v_limit ->> 'level' = 'block' then
        v_missing := v_missing || jsonb_build_object('code', 'company_limit', 'message', v_limit ->> 'message');
      elsif v_limit ->> 'level' = 'confirm' and e.limit_override_at is null then
        v_missing := v_missing || jsonb_build_object('code', 'tax_audit_ceiling', 'message', v_limit ->> 'message');
      elsif v_limit ->> 'level' in ('warn', 'confirm') then
        v_warnings := v_warnings || jsonb_build_object('code', 'limit', 'message', v_limit ->> 'message');
      end if;
    end if;

    if e.stage = 'planning' then
      v_m := e.materiality;
      if v_m is null or jsonb_typeof(v_m) <> 'object'
         or nullif(v_m ->> 'basis', '') is null
         or coalesce(public.jsonb_to_numeric(v_m -> 'overall'), 0) <= 0
         or coalesce(public.jsonb_to_numeric(v_m -> 'performance'), 0) <= 0
         or public.jsonb_to_numeric(v_m -> 'performance') > public.jsonb_to_numeric(v_m -> 'overall')
         or coalesce(public.jsonb_to_numeric(v_m -> 'trivial'), 0) <= 0
         or public.jsonb_to_numeric(v_m -> 'trivial') >= public.jsonb_to_numeric(v_m -> 'performance') then
        v_missing := v_missing || jsonb_build_object('code', 'materiality', 'message', 'record materiality: the basis, overall, performance and clearly-trivial amounts (SA 320)');
      end if;
    end if;

    if p_to = 'archived' then
      if e.report_type is null or e.report_date is null then
        v_missing := v_missing || jsonb_build_object('code', 'report', 'message', 'record the report type and report date');
      end if;
      if e.udin_record_id is null then
        v_missing := v_missing || jsonb_build_object('code', 'udin', 'message', 'link the UDIN generated for the report');
      end if;
      if e.audit_type = 'statutory_companies_act' and e.caro_applicable is null then
        v_missing := v_missing || jsonb_build_object('code', 'caro', 'message', 'record whether CARO 2020 applies');
      end if;
      if e.file_assembly_due is not null and v_today > e.file_assembly_due then
        v_warnings := v_warnings || jsonb_build_object('code', 'assembly_late', 'message',
          format('the file is being assembled %s days after the 60-day date (SA 230)', v_today - e.file_assembly_due));
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'ok', jsonb_array_length(v_missing) = 0,
    'from', e.stage,
    'to', p_to,
    'missing', v_missing,
    'warnings', v_warnings,
    'is_engagement_partner', v_is_partner
  );
end;
$$;

comment on function public.audit_stage_gate(uuid, text) is
  'What stands between an audit engagement and a stage (§6.8, §6.9): checklist sign-offs, and the acceptance, materiality and reporting gates. {ok, from, to, missing[{code, message, step}], warnings[], is_engagement_partner}.';

-- The sentence a refused move raises: "Before Planning: …; …."
create or replace function public.audit_gate_sentence(p_to text, p_missing jsonb)
returns text
language sql
immutable
set search_path = public, extensions
as $$
  select format('Before %s: %s.',
    case p_to when 'acceptance' then 'Acceptance' when 'planning' then 'Planning' when 'risk_assessment' then 'Risk assessment'
      when 'execution' then 'Execution' when 'completion' then 'Completion' when 'reporting' then 'Reporting' else 'Archive' end,
    (select string_agg(regexp_replace(m ->> 'message', '\.$', ''), '; ') from jsonb_array_elements(p_missing) m))
$$;

-- "Changed by Anita at 12:41. Reload to see their changes." (§13)
create or replace function public.audit_change_conflict(p_id uuid)
returns text
language sql
stable
security definer
set search_path = public, extensions
as $$
  select format('USER: Changed by %s at %s. Reload to see their changes.',
    coalesce(p.full_name, 'someone else'), to_char(e.updated_at at time zone 'Asia/Kolkata', 'HH24:MI'))
  from public.audit_engagements e
  left join public.profiles p on p.id = e.updated_by
  where e.id = p_id and public.is_manager_or_partner()
$$;

-- =============================================================================================
-- advance_audit_stage
-- =============================================================================================
create or replace function public.advance_audit_stage(p_id uuid, p_to text, p_note text default null, p_expected_updated_at timestamptz default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  c_stages constant text[] := array['acceptance', 'planning', 'risk_assessment', 'execution', 'completion', 'reporting', 'archived'];
  e public.audit_engagements%rowtype;
  v_gate jsonb;
  v_from int;
  v_to int;
  v_partner_name text;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_docs int := 0;
  v_conflict text;
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only Partners and Managers work on audit engagements.' using errcode = 'P0001';
  end if;
  select * into e from public.audit_engagements where id = p_id for update;
  if not found then
    raise exception 'USER: That audit engagement no longer exists.' using errcode = 'P0001';
  end if;
  if p_expected_updated_at is not null and e.updated_at is distinct from p_expected_updated_at then
    v_conflict := public.audit_change_conflict(p_id);
    raise exception '%', coalesce(v_conflict, 'USER: The engagement was changed by someone else. Reload to see their changes.') using errcode = 'P0001';
  end if;
  if e.archived_at is not null then
    raise exception 'USER: This audit file is archived and read-only.' using errcode = 'P0001';
  end if;
  if public.my_employee_id() is distinct from e.engagement_partner_id then
    select full_name into v_partner_name from public.employees where id = e.engagement_partner_id;
    raise exception 'USER: Only %, the engagement partner, can approve moving this engagement to another stage.', coalesce(v_partner_name, 'the engagement partner') using errcode = 'P0001';
  end if;
  v_from := array_position(c_stages, e.stage);
  v_to := array_position(c_stages, p_to);
  if v_to is null then
    raise exception 'USER: That isn''t a stage of an audit.' using errcode = 'P0001';
  end if;
  if v_to = v_from then
    raise exception 'USER: The engagement is already at that stage.' using errcode = 'P0001';
  end if;
  if length(coalesce(v_note, '')) > 2000 then
    raise exception 'USER: Keep the note under 2,000 characters.' using errcode = 'P0001';
  end if;

  if v_to < v_from then
    if v_note is null or length(v_note) < 5 then
      raise exception 'USER: Say why the engagement goes back a stage.' using errcode = 'P0001';
    end if;
    v_gate := jsonb_build_object('warnings', '[]'::jsonb);
  else
    v_gate := public.audit_stage_gate(p_id, p_to);
    if not (v_gate ->> 'ok')::boolean then
      raise exception 'USER: %', public.audit_gate_sentence(p_to, v_gate -> 'missing') using errcode = 'P0001';
    end if;
  end if;

  update public.audit_engagements
  set stage = p_to,
      accepted_on = case when e.stage = 'acceptance' and v_to > v_from then coalesce(accepted_on, public.today_ist()) else accepted_on end,
      archived_at = case when p_to = 'archived' then now() else archived_at end,
      archived_by = case when p_to = 'archived' then auth.uid() else archived_by end
  where id = p_id
  returning * into e;

  if p_to = 'archived' and e.retain_until is not null then
    -- SQC 1: the file's documents are kept at least until report date + 7 years.
    update public.documents d
    set retention_until = e.retain_until
    where d.id in (select l.document_id from public.audit_engagement_documents l where l.engagement_id = p_id)
      and (d.retention_until is null or d.retention_until < e.retain_until);
    get diagnostics v_docs = row_count;
  end if;

  insert into public.audit_engagement_stage_log (engagement_id, from_stage, to_stage, approved_by, note, warnings)
  values (p_id, c_stages[v_from], p_to, auth.uid(), v_note, coalesce(v_gate -> 'warnings', '[]'::jsonb));

  return jsonb_build_object(
    'id', e.id,
    'stage', e.stage,
    'from', c_stages[v_from],
    'updated_at', e.updated_at,
    'archived_at', e.archived_at,
    'retain_until', e.retain_until,
    'documents_retention_extended', v_docs,
    'warnings', coalesce(v_gate -> 'warnings', '[]'::jsonb)
  );
end;
$$;

comment on function public.advance_audit_stage(uuid, text, text, timestamptz) is
  'The engagement partner moves an audit one stage forward through audit_stage_gate, or back with a reason; archiving locks the file and extends its documents'' retention to report date + 7 years (§6.9, §7.15.5).';

-- =============================================================================================
-- audit_step_signoff
-- =============================================================================================
create or replace function public.audit_step_signoff(p_id uuid, p_step text, p_action text, p_note text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  c_stages constant text[] := array['acceptance', 'planning', 'risk_assessment', 'execution', 'completion', 'reporting', 'archived'];
  e public.audit_engagements%rowtype;
  s public.audit_step_definitions%rowtype;
  v_cur jsonb;
  v_new jsonb;
  v_prepared boolean;
  v_reviewed boolean;
  v_evidence int;
  v_uid uuid := auth.uid();
  v_now text := to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_signable boolean;
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only Partners and Managers sign off audit steps.' using errcode = 'P0001';
  end if;
  if p_action not in ('prepare', 'not_applicable', 'review', 'reopen') then
    raise exception 'USER: That isn''t a sign-off.' using errcode = 'P0001';
  end if;
  if length(coalesce(v_note, '')) > 2000 then
    raise exception 'USER: Keep the note under 2,000 characters.' using errcode = 'P0001';
  end if;
  select * into e from public.audit_engagements where id = p_id for update;
  if not found then
    raise exception 'USER: That audit engagement no longer exists.' using errcode = 'P0001';
  end if;
  if e.archived_at is not null or e.stage = 'archived' then
    raise exception 'USER: This audit file is archived and read-only.' using errcode = 'P0001';
  end if;
  select * into s from public.audit_step_definitions where key = p_step;
  if not found or (s.audit_types is not null and not (e.audit_type = any (s.audit_types))) then
    raise exception 'USER: That step isn''t part of this type of audit.' using errcode = 'P0001';
  end if;
  v_signable := s.stage = e.stage or (e.stage = 'reporting' and s.stage = 'archived');
  if not v_signable then
    raise exception 'USER: This step belongs to another stage. Sign off the steps of the stage the engagement is at.' using errcode = 'P0001';
  end if;

  v_cur := coalesce(e.checklist -> 'steps' -> p_step, '{}'::jsonb);
  v_prepared := (v_cur ->> 'prepared_at') is not null or (v_cur -> 'na') = 'true'::jsonb;
  v_reviewed := v_prepared and (v_cur ->> 'reviewed_at') is not null;
  select count(*) into v_evidence from public.audit_engagement_documents d where d.engagement_id = p_id and d.step_key = p_step;

  if p_action = 'prepare' then
    if v_reviewed then
      raise exception 'USER: This step is already reviewed. Reopen it to change it.' using errcode = 'P0001';
    end if;
    if s.evidence_required and v_evidence = 0 then
      raise exception 'USER: Attach the working paper for this step before signing it as prepared.' using errcode = 'P0001';
    end if;
    v_new := jsonb_build_object('prepared_by', v_uid, 'prepared_at', v_now, 'na', false, 'note', v_note);
  elsif p_action = 'not_applicable' then
    if not s.allow_na then
      raise exception 'USER: This step can''t be marked not applicable.' using errcode = 'P0001';
    end if;
    if v_reviewed then
      raise exception 'USER: This step is already reviewed. Reopen it to change it.' using errcode = 'P0001';
    end if;
    if v_note is null or length(v_note) < 5 then
      raise exception 'USER: Say why the step doesn''t apply.' using errcode = 'P0001';
    end if;
    v_new := jsonb_build_object('prepared_by', v_uid, 'prepared_at', v_now, 'na', true, 'na_reason', v_note, 'note', v_note);
  elsif p_action = 'review' then
    if v_reviewed then
      raise exception 'USER: This step is already reviewed.' using errcode = 'P0001';
    end if;
    if not v_prepared then
      raise exception 'USER: The step has to be prepared (or marked not applicable) before it is reviewed.' using errcode = 'P0001';
    end if;
    if (v_cur ->> 'prepared_by') = v_uid::text then
      raise exception 'USER: You prepared this step, so someone else has to review it.' using errcode = 'P0001';
    end if;
    v_new := v_cur || jsonb_build_object('reviewed_by', v_uid, 'reviewed_at', v_now)
      || case when v_note is not null then jsonb_build_object('review_note', v_note) else '{}'::jsonb end;
  else
    if not v_prepared then
      raise exception 'USER: Nothing has been signed on this step yet.' using errcode = 'P0001';
    end if;
    v_new := null;
  end if;

  update public.audit_engagements
  set checklist = case
      when v_new is null then jsonb_set(coalesce(checklist, '{}'::jsonb), '{steps}', coalesce(checklist -> 'steps', '{}'::jsonb) - p_step)
      else jsonb_set(coalesce(checklist, '{}'::jsonb), '{steps}', coalesce(checklist -> 'steps', '{}'::jsonb) || jsonb_build_object(p_step, v_new))
    end
  where id = p_id
  returning * into e;

  return jsonb_build_object('id', e.id, 'step', p_step, 'action', p_action, 'signoff', e.checklist -> 'steps' -> p_step, 'updated_at', e.updated_at,
    'stage_index', array_position(c_stages, e.stage));
end;
$$;

comment on function public.audit_step_signoff(uuid, text, text, text) is
  'Prepare, mark not applicable (with a reason), review (not by the preparer) or reopen one checklist step of an audit engagement at its current stage (§6.9).';

-- =============================================================================================
-- Evidence
-- =============================================================================================
create or replace function public.audit_attach_evidence(p_id uuid, p_step text, p_document_ids uuid[], p_note text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  e public.audit_engagements%rowtype;
  s public.audit_step_definitions%rowtype;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_bad int;
  v_added int;
  v_amendment boolean;
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only Partners and Managers add working papers to an audit.' using errcode = 'P0001';
  end if;
  if p_document_ids is null or cardinality(p_document_ids) = 0 then
    raise exception 'USER: Choose at least one document.' using errcode = 'P0001';
  end if;
  if cardinality(p_document_ids) > 50 then
    raise exception 'USER: Attach at most 50 documents at a time.' using errcode = 'P0001';
  end if;
  select * into e from public.audit_engagements where id = p_id for update;
  if not found then
    raise exception 'USER: That audit engagement no longer exists.' using errcode = 'P0001';
  end if;
  select * into s from public.audit_step_definitions where key = p_step;
  if not found or (s.audit_types is not null and not (e.audit_type = any (s.audit_types))) then
    raise exception 'USER: That step isn''t part of this type of audit.' using errcode = 'P0001';
  end if;
  v_amendment := e.archived_at is not null;
  if v_amendment and (v_note is null or length(v_note) < 5) then
    raise exception 'USER: The file is archived, so this goes in as an amendment. Say what it is and why it is added now.' using errcode = 'P0001';
  end if;
  if length(coalesce(v_note, '')) > 2000 then
    raise exception 'USER: Keep the note under 2,000 characters.' using errcode = 'P0001';
  end if;

  select count(*) into v_bad
  from unnest(p_document_ids) x(id)
  where not exists (select 1 from public.documents d where d.id = x.id and d.client_id = e.client_id and d.deleted_at is null);
  if v_bad > 0 then
    raise exception 'USER: Choose documents from this client''s vault (deleted documents can''t be attached).' using errcode = 'P0001';
  end if;

  insert into public.audit_engagement_documents (engagement_id, document_id, step_key, is_amendment, amendment_note, added_by)
  select p_id, x.id, p_step, v_amendment, case when v_amendment then v_note end, auth.uid()
  from (select distinct unnest(p_document_ids) as id) x
  on conflict (engagement_id, document_id, step_key) do nothing;
  get diagnostics v_added = row_count;

  if v_amendment and v_added > 0 and e.retain_until is not null then
    update public.documents d
    set retention_until = e.retain_until
    where d.id = any (p_document_ids) and (d.retention_until is null or d.retention_until < e.retain_until);
  end if;

  return jsonb_build_object('added', v_added, 'amendment', v_amendment, 'step', p_step);
end;
$$;

comment on function public.audit_attach_evidence(uuid, text, uuid[], text) is
  'Tags the client''s vault documents to an audit step as evidence (§6.9); after archive they go in as an amendment with a note (SA 230).';

create or replace function public.audit_detach_evidence(p_link_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  l public.audit_engagement_documents%rowtype;
  e public.audit_engagements%rowtype;
  s public.audit_step_definitions%rowtype;
  v_cur jsonb;
  v_left int;
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only Partners and Managers change an audit''s working papers.' using errcode = 'P0001';
  end if;
  select * into l from public.audit_engagement_documents where id = p_link_id;
  if not found then
    raise exception 'USER: That document is no longer attached.' using errcode = 'P0001';
  end if;
  select * into e from public.audit_engagements where id = l.engagement_id for update;
  if e.archived_at is not null then
    raise exception 'USER: This audit file is archived and read-only.' using errcode = 'P0001';
  end if;
  select * into s from public.audit_step_definitions where key = l.step_key;
  v_cur := coalesce(e.checklist -> 'steps' -> l.step_key, '{}'::jsonb);
  if (v_cur ->> 'reviewed_at') is not null then
    raise exception 'USER: The step is reviewed. Reopen it before removing its working papers.' using errcode = 'P0001';
  end if;
  select count(*) into v_left from public.audit_engagement_documents d where d.engagement_id = l.engagement_id and d.step_key = l.step_key and d.id <> l.id;
  if s.evidence_required and v_left = 0 and (v_cur ->> 'prepared_at') is not null and coalesce((v_cur -> 'na') = 'true'::jsonb, false) = false then
    raise exception 'USER: The step is signed as prepared on this working paper. Reopen the step before removing it.' using errcode = 'P0001';
  end if;
  delete from public.audit_engagement_documents where id = p_link_id;
  return jsonb_build_object('removed', true, 'document_id', l.document_id, 'step', l.step_key, 'engagement_id', l.engagement_id);
end;
$$;

comment on function public.audit_detach_evidence(uuid) is
  'Removes a working paper from an audit step before archive; refused while the step is reviewed, or when it is the prepared step''s only evidence (§6.9).';

-- =============================================================================================
-- confirm_audit_limit_override (§6.8 "requires a Partner's confirmation to log a 61st")
-- =============================================================================================
create or replace function public.confirm_audit_limit_override(p_id uuid, p_note text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  e public.audit_engagements%rowtype;
  v_limit jsonb;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not public.is_partner() then
    raise exception 'USER: Only a Partner can confirm a tax audit over the ceiling.' using errcode = 'P0001';
  end if;
  if v_note is null or length(v_note) < 10 then
    raise exception 'USER: Record why the firm is taking this tax audit over the ceiling.' using errcode = 'P0001';
  end if;
  if length(v_note) > 2000 then
    raise exception 'USER: Keep the note under 2,000 characters.' using errcode = 'P0001';
  end if;
  select * into e from public.audit_engagements where id = p_id for update;
  if not found then
    raise exception 'USER: That audit engagement no longer exists.' using errcode = 'P0001';
  end if;
  if e.stage <> 'acceptance' then
    raise exception 'USER: The ceiling is confirmed at Acceptance.' using errcode = 'P0001';
  end if;
  v_limit := public.audit_limit_check(p_id);
  if v_limit ->> 'kind' is distinct from 'tax_audit' or v_limit ->> 'level' <> 'confirm' then
    raise exception 'USER: This engagement isn''t over the tax audit ceiling, so there is nothing to confirm.' using errcode = 'P0001';
  end if;
  update public.audit_engagements
  set limit_override_by = auth.uid(), limit_override_at = now(), limit_override_note = v_note
  where id = p_id
  returning * into e;
  return jsonb_build_object('id', e.id, 'updated_at', e.updated_at, 'position', v_limit -> 'position', 'limit', v_limit -> 'limit');
end;
$$;

comment on function public.confirm_audit_limit_override(uuid, text) is
  'A Partner confirms taking a tax audit over the ICAI ceiling, with the reason (§6.8).';

-- =============================================================================================
-- Grants: callable by signed-in users (each function checks the role itself); never anon.
-- =============================================================================================
revoke execute on function
  public.kyc_missing(uuid),
  public.kyc_review_due(uuid, date),
  public.kyc_status(uuid),
  public.audit_limit_check(uuid),
  public.audit_stage_gate(uuid, text),
  public.audit_gate_sentence(text, jsonb),
  public.audit_change_conflict(uuid),
  public.advance_audit_stage(uuid, text, text, timestamptz),
  public.audit_step_signoff(uuid, text, text, text),
  public.audit_attach_evidence(uuid, text, uuid[], text),
  public.audit_detach_evidence(uuid),
  public.confirm_audit_limit_override(uuid, text)
from public, anon;

grant execute on function
  public.kyc_missing(uuid),
  public.kyc_review_due(uuid, date),
  public.kyc_status(uuid),
  public.audit_limit_check(uuid),
  public.audit_stage_gate(uuid, text),
  public.audit_gate_sentence(text, jsonb),
  public.audit_change_conflict(uuid),
  public.advance_audit_stage(uuid, text, text, timestamptz),
  public.audit_step_signoff(uuid, text, text, text),
  public.audit_attach_evidence(uuid, text, uuid[], text),
  public.audit_detach_evidence(uuid),
  public.confirm_audit_limit_override(uuid, text)
to authenticated, service_role;
