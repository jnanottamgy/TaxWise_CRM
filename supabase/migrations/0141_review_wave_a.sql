-- 0141 · Wave A review fixes (§0.2 "writes … a client timeline entry", §4.1, §4.6).
--
-- 1. A task's timeline entries for the person doing the task. An Employee can hold a task on a
--    client they can't otherwise see (assigned or named reviewer on a colleague's client: the
--    assignment check only warns "not on this client's team", §7.6.2, and §4.1 "Tasks are visible
--    when assigned to them, when they are the named reviewer…"). Accepting, declining, moving the
--    status or deleting such a task wrote its client timeline entry through the Employee's session,
--    and client_timeline_events_insert (0043) refused it because the client isn't in
--    staff_client_ids(): the entry was silently lost. The policy now also lets staff write a
--    task_* event (never money-side, never for a lead) for a client of a task they hold or review.
--    They still can't read that client's timeline (the SELECT policy is unchanged).
--
--    staff_task_client_ids(): the clients of the live tasks the calling staff member is assigned to
--    or names them as reviewer. security definer stable, search_path pinned.
--
-- 2. clients.income_nature, stored at onboarding and read by the deadline generator (below).
--
-- 3. Schema version 0141 (lib/env.ts EXPECTED_SCHEMA_VERSION).

set search_path = public, extensions;

create or replace function public.staff_task_client_ids()
returns setof uuid
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_me uuid;
begin
  if not public.is_staff() then
    return;
  end if;
  v_me := public.my_employee_id();
  if v_me is null then
    return;
  end if;
  return query
    select distinct t.client_id
    from public.tasks t
    join public.clients c on c.id = t.client_id and c.deleted_at is null
    where t.deleted_at is null
      and (t.assigned_employee_id = v_me or t.reviewer_employee_id = v_me);
end;
$$;

comment on function public.staff_task_client_ids() is
  'Clients of the live tasks the calling staff member is assigned to or reviews (for writing those tasks'' timeline entries, §4.1, §0.2).';

revoke execute on function public.staff_task_client_ids() from public, anon;
grant execute on function public.staff_task_client_ids() to authenticated, service_role;

drop policy if exists client_timeline_events_insert on public.client_timeline_events;
create policy client_timeline_events_insert on public.client_timeline_events
  for insert to authenticated
  with check (
    (select public.is_manager_or_partner())
    or (
      lead_id is null
      and not public.money_side_kind(event_type)
      and (performed_by is null or performed_by = (select auth.uid()))
      and (
        client_id in (select public.staff_client_ids())
        or client_id in (select public.portal_client_ids())
        or (event_type like 'task\_%' and client_id in (select public.staff_task_client_ids()))
      )
    )
  );

-- =============================================================================================
-- 2. clients.income_nature (§6.6, §6.7): how the client earns its income (business, profession,
--    presumptive 44AD / 44ADA). The onboarding wizard asks it for the tax-audit indication, and the
--    statutory calendar uses it: presumptive cases pay advance tax in one instalment by 15 March,
--    so the 15 June / 15 September / 15 December instalments don't apply. It was never stored, so
--    every later generation (the onboarding after-effect itself, Generate deadlines, the monthly
--    top-up) planned those three instalments for presumptive clients the wizard had left out.
--    onboard_client stores it now; the generator reads it back (server/compliance/generate.ts).
-- =============================================================================================
alter table public.clients
  add column if not exists income_nature text;
alter table public.clients drop constraint if exists clients_income_nature_values;
alter table public.clients
  add constraint clients_income_nature_values
  check (income_nature is null or income_nature in ('business', 'profession', 'presumptive_44ad', 'presumptive_44ada'));

comment on column public.clients.income_nature is
  'How the client earns its income: business, profession, presumptive_44ad, presumptive_44ada (§6.6). Presumptive cases get the single 15 March advance-tax instalment (§6.7).';

create or replace function public.onboard_client(p_payload jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  c jsonb := p_payload -> 'client';
  v_id uuid;
  v_code text;
  v_owner uuid;
  v_attempt int := 0;
  v_services text[];
  v_has_audit boolean;
  v_acc public.client_acceptances%rowtype;
  v_lead uuid;
  v_quote uuid;
  v_q public.quotations%rowtype;
  v_l public.leads%rowtype;
  r jsonb;
  v_task_id uuid;
  v_task_ids uuid[] := '{}';
  v_service_ids uuid[] := '{}';
  v_service_id uuid;
  v_checklist jsonb := '[]'::jsonb;
  v_item_id uuid;
  v_events int := 0;
  v_events_given int := 0;
  v_contact_id uuid;
  v_kyc_id uuid;
  v_team int := 0;
  v_tax_audit text;
  v_name text;
  v_role public.app_role;
  v_order int := 0;
  v_dup_reason text := nullif(btrim(p_payload ->> 'duplicate_reason'), '');
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only Partners and Managers can onboard a client.' using errcode = 'P0001';
  end if;
  if c is null or jsonb_typeof(c) <> 'object' then
    raise exception 'USER: The client details are missing.' using errcode = 'P0001';
  end if;

  v_id := coalesce(nullif(c ->> 'id', '')::uuid, gen_random_uuid());
  v_name := nullif(btrim(c ->> 'display_name'), '');
  if v_name is null or char_length(v_name) < 2 then
    raise exception 'USER: Enter the client''s display name.' using errcode = 'P0001';
  end if;

  -- The owner: an active member of the team (§7.3.2 step 3 "Client owner*").
  v_owner := nullif(c ->> 'owner_employee_id', '')::uuid;
  if v_owner is null then
    raise exception 'USER: Choose the client owner.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.employees e where e.id = v_owner and e.is_active and e.deleted_at is null) then
    raise exception 'USER: The client owner must be an active member of the team.' using errcode = 'P0001';
  end if;

  -- §6.6: the tax audit decision is the Partner's; a Manager leaves it for a Partner to review.
  v_tax_audit := nullif(c ->> 'tax_audit_applicable', '');
  if v_tax_audit in ('yes', 'no') and not public.is_partner() then
    raise exception 'USER: Only a Partner can confirm whether a tax audit applies. Leave it as "Partner to review".' using errcode = 'P0001';
  end if;

  -- Services (§7.3.2 step 2).
  select coalesce(array_agg(s ->> 'service_type'), '{}') into v_services
  from jsonb_array_elements(coalesce(p_payload -> 'services', '[]'::jsonb)) s;
  if cardinality(v_services) = 0 then
    raise exception 'USER: Choose at least one service.' using errcode = 'P0001';
  end if;
  v_has_audit := 'audit' = any (v_services);

  -- The conflict check (§7.5.4; mandatory for attest work).
  if nullif(p_payload ->> 'acceptance_id', '') is not null then
    select * into v_acc from public.client_acceptances a where a.id = (p_payload ->> 'acceptance_id')::uuid for update;
    if not found then
      raise exception 'USER: The conflict check wasn''t found. Run it again.' using errcode = 'P0001';
    end if;
    if v_acc.client_id is not null then
      raise exception 'USER: That conflict check already belongs to another client. Run a new one.' using errcode = 'P0001';
    end if;
    if v_acc.outcome = 'declined' then
      raise exception 'USER: The acceptance decision for this client is Decline, so it can''t be onboarded.' using errcode = 'P0001';
    end if;
  end if;
  if v_has_audit and (v_acc.id is null or v_acc.outcome is distinct from 'accepted') then
    raise exception 'USER: Audit work needs a conflict check with the decision Accept before the client is onboarded. Run the conflict check in step 1.'
      using errcode = 'P0001';
  end if;

  -- Where the client came from (§7.3.2 "marks the source lead or quotation as converted").
  v_quote := nullif(c ->> 'source_quotation_id', '')::uuid;
  v_lead := nullif(c ->> 'source_lead_id', '')::uuid;
  if v_quote is not null then
    select * into v_q from public.quotations q where q.id = v_quote and q.deleted_at is null for update;
    if not found then
      raise exception 'USER: The quotation wasn''t found.' using errcode = 'P0001';
    end if;
    if v_q.converted_client_id is not null then
      raise exception 'USER: Quotation % has already been converted to a client.', v_q.quotation_number using errcode = 'P0001';
    end if;
    if v_q.status <> 'accepted' then
      raise exception 'USER: Only an accepted quotation can be converted to a client.' using errcode = 'P0001';
    end if;
    v_lead := coalesce(v_lead, v_q.lead_id);
  end if;
  if v_lead is not null then
    select * into v_l from public.leads l where l.id = v_lead and l.deleted_at is null for update;
    if not found then
      raise exception 'USER: The lead wasn''t found.' using errcode = 'P0001';
    end if;
    if v_l.converted_client_id is not null then
      raise exception 'USER: This lead has already been converted to a client.' using errcode = 'P0001';
    end if;
  end if;

  -- Client code: as entered, or the next free number from the locked series (§5.3, §0.1 rule 6).
  v_code := nullif(upper(btrim(c ->> 'client_code')), '');
  if v_code is null then
    loop
      v_attempt := v_attempt + 1;
      v_code := public.next_document_number('client_code', public.today_ist());
      exit when not exists (select 1 from public.clients x where x.client_code = v_code);
      if v_attempt >= 50 then
        raise exception 'USER: Couldn''t find a free client code. Enter one by hand.' using errcode = 'P0001';
      end if;
    end loop;
  elsif exists (select 1 from public.clients x where x.client_code = v_code) then
    raise exception 'USER: Client code % is already in use. Choose another.', v_code using errcode = 'P0001';
  end if;

  insert into public.clients (
    id, client_code, display_name, legal_name, entity_type, entity_type_other, is_incorporated,
    date_of_birth_or_incorporation, pan, tan, gst_registration, gstin, state_code, email, phone, whatsapp,
    address, city, pincode, notes, status, priority, owner_employee_id, group_id, fy_end_month,
    annual_turnover, turnover_fy, gst_scheme, tax_audit_applicable, tax_audit_note, reminder_days,
    notify_channels, source_lead_id, source_quotation_id, onboarded_at, onboarded_by, created_by, income_nature
  ) values (
    v_id, v_code, v_name, nullif(btrim(c ->> 'legal_name'), ''),
    nullif(c ->> 'entity_type', '')::public.entity_type, nullif(btrim(c ->> 'entity_type_other'), ''),
    coalesce((c ->> 'is_incorporated')::boolean, true),
    nullif(c ->> 'date_of_birth_or_incorporation', '')::date,
    nullif(btrim(c ->> 'pan'), ''), nullif(btrim(c ->> 'tan'), ''),
    coalesce(nullif(c ->> 'gst_registration', '')::public.gst_registration, 'unknown'),
    nullif(btrim(c ->> 'gstin'), ''), nullif(btrim(c ->> 'state_code'), ''),
    nullif(btrim(c ->> 'email'), ''), nullif(btrim(c ->> 'phone'), ''), nullif(btrim(c ->> 'whatsapp'), ''),
    nullif(btrim(c ->> 'address'), ''), nullif(btrim(c ->> 'city'), ''), nullif(btrim(c ->> 'pincode'), ''),
    nullif(btrim(c ->> 'notes'), ''),
    'active',
    coalesce(nullif(c ->> 'priority', '')::public.client_priority, 'medium'),
    v_owner, nullif(c ->> 'group_id', '')::uuid,
    coalesce(nullif(c ->> 'fy_end_month', '')::smallint, 3),
    nullif(c ->> 'annual_turnover', '')::numeric, nullif(c ->> 'turnover_fy', ''),
    nullif(c ->> 'gst_scheme', '')::public.gst_scheme,
    v_tax_audit, nullif(btrim(c ->> 'tax_audit_note'), ''),
    nullif(c ->> 'reminder_days', '')::int,
    coalesce(array(select jsonb_array_elements_text(coalesce(c -> 'notify_channels', '[]'::jsonb))), '{}'),
    v_lead, v_quote, now(), v_uid, v_uid, nullif(c ->> 'income_nature', '')
  );

  -- Services, with fees (Partner/Manager; Employees never see these, §4.1).
  for r in select * from jsonb_array_elements(coalesce(p_payload -> 'services', '[]'::jsonb)) loop
    if coalesce((r ->> 'auto_invoice')::boolean, false)
       and (nullif(r ->> 'agreed_fee', '') is null or nullif(r ->> 'next_billing_date', '') is null) then
      raise exception 'USER: Automatic invoicing needs an agreed fee and a first billing date.' using errcode = 'P0001';
    end if;
    if nullif(r ->> 'source_quotation_item_id', '') is not null and not exists (
      select 1 from public.quotation_items qi where qi.id = (r ->> 'source_quotation_item_id')::uuid and qi.quotation_id = v_quote
    ) then
      raise exception 'USER: A service points at a line of a different quotation.' using errcode = 'P0001';
    end if;
    insert into public.client_services (
      client_id, service_type, custom_name, frequency, next_due_date, agreed_fee, billing_frequency, sac_code,
      fee_agreed_at, source_quotation_item_id, auto_invoice, next_billing_date
    ) values (
      v_id, (r ->> 'service_type')::public.service_type, nullif(btrim(r ->> 'custom_name'), ''),
      (r ->> 'frequency')::public.service_frequency, nullif(r ->> 'next_due_date', '')::date,
      nullif(r ->> 'agreed_fee', '')::numeric, nullif(r ->> 'billing_frequency', '')::public.service_frequency,
      nullif(btrim(r ->> 'sac_code'), ''),
      case when nullif(r ->> 'agreed_fee', '') is not null then now() end,
      nullif(r ->> 'source_quotation_item_id', '')::uuid,
      coalesce((r ->> 'auto_invoice')::boolean, false), nullif(r ->> 'next_billing_date', '')::date
    )
    returning id into v_service_id;
    v_service_ids := v_service_ids || v_service_id;
  end loop;

  -- The primary contact.
  r := p_payload -> 'contact';
  if r is not null and jsonb_typeof(r) = 'object' and nullif(btrim(r ->> 'name'), '') is not null then
    insert into public.client_contacts (client_id, name, role, email, phone, whatsapp, is_primary)
    values (
      v_id, btrim(r ->> 'name'), nullif(btrim(r ->> 'role'), ''), nullif(btrim(r ->> 'email'), ''),
      nullif(btrim(r ->> 'phone'), ''), nullif(btrim(r ->> 'whatsapp'), ''), true
    )
    returning id into v_contact_id;
  end if;

  -- The engagement team (§5.3): engagement partner (a Partner), review manager (Partner or Manager),
  -- preparers (any active staff).
  for r in select * from jsonb_array_elements(coalesce(p_payload -> 'team', '[]'::jsonb)) loop
    if not exists (
      select 1 from public.employees e
      where e.id = (r ->> 'employee_id')::uuid and e.is_active and e.deleted_at is null
    ) then
      raise exception 'USER: Everyone on the engagement team must be an active member of the team.' using errcode = 'P0001';
    end if;
    v_role := public.employee_role((r ->> 'employee_id')::uuid);
    if r ->> 'team_role' = 'engagement_partner' and v_role is distinct from 'partner' then
      raise exception 'USER: The engagement partner must be a Partner.' using errcode = 'P0001';
    end if;
    if r ->> 'team_role' = 'review_manager' and v_role not in ('partner', 'manager') then
      raise exception 'USER: The review manager must be a Partner or a Manager.' using errcode = 'P0001';
    end if;
    insert into public.client_team_members (client_id, employee_id, team_role)
    values (v_id, (r ->> 'employee_id')::uuid, (r ->> 'team_role')::public.team_role)
    on conflict (client_id, employee_id, team_role) do nothing;
    v_team := v_team + 1;
  end loop;

  -- The document checklist (§7.3.2 step 4).
  for r in select * from jsonb_array_elements(coalesce(p_payload -> 'checklist', '[]'::jsonb)) loop
    if nullif(btrim(r ->> 'label'), '') is null then
      continue;
    end if;
    v_order := v_order + 1;
    insert into public.client_document_checklist_items (client_id, label, is_required, collected, collected_at, collected_by, sort_order)
    values (
      v_id, left(btrim(r ->> 'label'), 200), coalesce((r ->> 'is_required')::boolean, true),
      coalesce((r ->> 'collected')::boolean, false),
      case when coalesce((r ->> 'collected')::boolean, false) then now() end,
      case when coalesce((r ->> 'collected')::boolean, false) then v_uid end,
      v_order
    )
    returning id into v_item_id;
    v_checklist := v_checklist || jsonb_build_object('id', v_item_id, 'sort_order', v_order, 'label', left(btrim(r ->> 'label'), 200));
  end loop;

  -- Compliance events from the statutory engine (§6.7), idempotent by dedupe_key.
  select count(*) into v_events_given from jsonb_array_elements(coalesce(p_payload -> 'events', '[]'::jsonb));
  if exists (
    select 1 from jsonb_to_recordset(coalesce(p_payload -> 'events', '[]'::jsonb)) as x(client_id uuid, dedupe_key text)
    where x.client_id is distinct from v_id or x.dedupe_key is null or left(x.dedupe_key, 37) <> v_id::text || '|'
  ) then
    raise exception 'USER: The generated deadlines don''t belong to this client. Go back to step 5 and try again.' using errcode = 'P0001';
  end if;
  insert into public.compliance_events (
    client_id, type, form_code, title, description, financial_year, filing_period, period_start, period_end,
    due_date, is_statutory, source, reminder_days, notes, dedupe_key, rule_code, source_ref, original_due_date,
    override_id, agm_date, is_provisional
  )
  select
    v_id, x.type, x.form_code, x.title, x.description, x.financial_year, x.filing_period, x.period_start, x.period_end,
    x.due_date, coalesce(x.is_statutory, true), coalesce(x.source, 'statutory_engine'), coalesce(x.reminder_days, 7), x.notes,
    x.dedupe_key, x.rule_code, x.source_ref, x.original_due_date, x.override_id, x.agm_date, coalesce(x.is_provisional, false)
  from jsonb_to_recordset(coalesce(p_payload -> 'events', '[]'::jsonb)) as x(
    client_id uuid, type public.compliance_type, form_code text, title text, description text, financial_year text,
    filing_period text, period_start date, period_end date, due_date date, is_statutory boolean,
    source public.compliance_source, reminder_days int, notes text, dedupe_key text, rule_code text, source_ref text,
    original_due_date date, override_id uuid, agm_date date, is_provisional boolean
  )
  on conflict (dedupe_key) do nothing;
  get diagnostics v_events = row_count;

  -- Initial tasks: "Collect documents for <service>", due in 14 days, assigned to the owner,
  -- waiting for acceptance (§7.3.2).
  for r in select * from jsonb_array_elements(coalesce(p_payload -> 'tasks', '[]'::jsonb)) loop
    if nullif(btrim(r ->> 'title'), '') is null then
      continue;
    end if;
    insert into public.tasks (
      client_id, title, description, service_type, financial_year, due_date, priority,
      assigned_employee_id, acceptance_status, created_by
    ) values (
      v_id, left(btrim(r ->> 'title'), 200), nullif(btrim(r ->> 'description'), ''),
      nullif(r ->> 'service_type', '')::public.service_type, nullif(r ->> 'financial_year', ''),
      coalesce(nullif(r ->> 'due_date', '')::date, public.today_ist() + 14), 'medium',
      v_owner, 'pending', v_uid
    )
    returning id into v_task_id;
    v_task_ids := v_task_ids || v_task_id;
  end loop;

  -- The KYC record shell (§6.8; completed later on Client 360 → Profile & contacts).
  r := p_payload -> 'kyc';
  if r is not null and jsonb_typeof(r) = 'object' and nullif(r ->> 'entity_category', '') is not null then
    insert into public.client_kyc (client_id, entity_category, pan, cin_llpin, registered_address, engagement_types)
    values (
      v_id, r ->> 'entity_category', nullif(btrim(r ->> 'pan'), ''), nullif(btrim(r ->> 'cin_llpin'), ''),
      nullif(btrim(r ->> 'registered_address'), ''),
      nullif(array(select jsonb_array_elements_text(coalesce(r -> 'engagement_types', '[]'::jsonb))), '{}')
    )
    returning id into v_kyc_id;
  end if;

  -- Link the conflict check, and mark the source lead and quotation as converted.
  if v_acc.id is not null then
    update public.client_acceptances set client_id = v_id, lead_id = coalesce(lead_id, v_lead) where id = v_acc.id;
  end if;
  if v_lead is not null then
    update public.leads set status = 'won', converted_client_id = v_id, last_activity_at = now() where id = v_lead;
  end if;
  if v_quote is not null then
    update public.quotations set converted_client_id = v_id where id = v_quote;
  end if;

  -- The client's story (§5.11). No fees here: Employees on the team read this event (§4.1).
  insert into public.client_timeline_events (client_id, event_type, title, description, metadata, performed_by)
  values (
    v_id, 'client_onboarded', format('Client onboarded: %s (%s)', v_name, v_code),
    case when v_dup_reason is not null then format('Onboarded although it looked like an existing client: %s', left(v_dup_reason, 500)) end,
    jsonb_build_object(
      'services', to_jsonb(v_services), 'deadlines', v_events, 'tasks', cardinality(v_task_ids),
      'from_lead', v_lead is not null, 'from_quotation', v_quote is not null
    ),
    v_uid
  );
  if v_lead is not null then
    insert into public.client_timeline_events (client_id, lead_id, event_type, title, performed_by)
    values (v_id, v_lead, 'lead_converted', format('Lead converted to client %s (%s)', v_name, v_code), v_uid);
  end if;
  if v_quote is not null then
    insert into public.client_timeline_events (client_id, lead_id, event_type, title, metadata, performed_by)
    values (v_id, v_lead, 'quotation_converted', format('Quotation %s converted to client %s', v_q.quotation_number, v_code),
            jsonb_build_object('quotation_id', v_quote), v_uid);
  end if;

  perform public.log_audit_event(
    'data_create', 'client', v_id::text, 'clients.onboard',
    jsonb_build_object(
      'client_code', v_code, 'display_name', v_name, 'services', to_jsonb(v_services),
      'deadlines', v_events, 'deadlines_given', v_events_given, 'tasks', cardinality(v_task_ids), 'team', v_team,
      'source_lead_id', v_lead, 'source_quotation_id', v_quote, 'acceptance_id', v_acc.id,
      'duplicate_reason', v_dup_reason
    ),
    true, null,
    nullif(p_payload -> 'meta' ->> 'ip', ''), nullif(p_payload -> 'meta' ->> 'user_agent', '')
  );

  return jsonb_build_object(
    'client_id', v_id,
    'client_code', v_code,
    'display_name', v_name,
    'service_ids', to_jsonb(v_service_ids),
    'contact_id', v_contact_id,
    'task_ids', to_jsonb(v_task_ids),
    'checklist', v_checklist,
    'event_count', v_events,
    'kyc_id', v_kyc_id,
    'source_lead_id', v_lead,
    'source_quotation_id', v_quote
  );
end;
$$;

comment on function public.onboard_client(jsonb) is
  'Partner/Manager: creates a client with its services, primary contact, team, checklist, compliance events (from the TS statutory engine), initial tasks and KYC shell; links the conflict check; converts the source lead/quotation; writes timeline and audit — one transaction under the caller''s RLS (§7.3.2). Stores income_nature (0141).';

revoke execute on function public.onboard_client(jsonb) from public, anon;
grant execute on function public.onboard_client(jsonb) to authenticated, service_role;

insert into public.app_meta (key, value) values ('schema_version', '0141')
on conflict (key) do update set value = excluded.value;
