-- 0241 · A quotation reaches the client on WhatsApp, so it needs a way to reach them, not an email
-- (§7.5; the firm sends no email). quotations.client_email becomes optional: save_quotation asks for
-- the client's name, the valid-until date, and a WhatsApp number or an email, and stores a blank
-- email as NULL. The send records (mark_quotation_sent, record_quotation_follow_up) name the number
-- the hand-off went to when the caller doesn't, instead of the email. Function bodies are 0143's and
-- 0144's with only those lines changed; their grants and comments are unchanged.
--
-- Also records the schema version (§0.1 rule 1): lib/env.ts EXPECTED_SCHEMA_VERSION matches it.

set search_path = public, extensions;

alter table public.quotations alter column client_email drop not null;

create or replace function public.save_quotation(
  p_id uuid,
  p_expected_updated_at timestamptz,
  p_header jsonb,
  p_items jsonb
)
returns table (id uuid, quotation_number text, status public.quotation_status, updated_at timestamptz,
               subtotal numeric, tax_amount numeric, total numeric, conflict boolean)
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_q public.quotations%rowtype;
  v_id uuid;
  v_item jsonb;
  v_i int := 0;
  v_sub numeric(14,2);
  v_tax numeric(14,2);
  v_lead uuid := nullif(p_header ->> 'lead_id', '')::uuid;
  v_client uuid := nullif(p_header ->> 'client_id', '')::uuid;
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only Partners and Managers prepare quotations.' using errcode = 'P0001';
  end if;
  if p_header is null or jsonb_typeof(p_header) <> 'object' then
    raise exception 'USER: The quotation is missing its details.' using errcode = 'P0001';
  end if;
  if p_items is not null and jsonb_typeof(p_items) <> 'array' then
    raise exception 'USER: The quotation''s lines aren''t readable.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) > 100 then
    raise exception 'USER: A quotation can have at most 100 lines.' using errcode = 'P0001';
  end if;
  if nullif(btrim(p_header ->> 'client_name'), '') is null or nullif(p_header ->> 'valid_until', '') is null then
    raise exception 'USER: Add the client''s name and the valid-until date to save the draft.' using errcode = 'P0001';
  end if;
  if nullif(btrim(p_header ->> 'client_phone'), '') is null and nullif(btrim(p_header ->> 'client_email'), '') is null then
    raise exception 'USER: Add the client''s WhatsApp number (or an email), so the quotation can reach them.' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) e
    where nullif(btrim(e ->> 'description'), '') is null or nullif(e ->> 'unit_price', '') is null
  ) then
    raise exception 'USER: Every line needs a description and a unit price.' using errcode = 'P0001';
  end if;
  if v_lead is not null and not exists (select 1 from public.leads l where l.id = v_lead and l.deleted_at is null) then
    raise exception 'USER: That lead no longer exists.' using errcode = 'P0001';
  end if;
  if v_client is not null and not exists (select 1 from public.clients c where c.id = v_client and c.deleted_at is null) then
    raise exception 'USER: That client no longer exists.' using errcode = 'P0001';
  end if;

  if p_id is null then
    insert into public.quotations (
      lead_id, client_id, client_name, client_email, client_phone, client_company, client_gstin,
      place_of_supply_code, issue_date, valid_until, notes, terms, status, created_by
    ) values (
      v_lead, v_client,
      btrim(p_header ->> 'client_name'), nullif(btrim(p_header ->> 'client_email'), ''),
      nullif(btrim(p_header ->> 'client_phone'), ''), nullif(btrim(p_header ->> 'client_company'), ''),
      nullif(btrim(p_header ->> 'client_gstin'), ''), nullif(btrim(p_header ->> 'place_of_supply_code'), ''),
      coalesce(nullif(p_header ->> 'issue_date', '')::date, public.today_ist()),
      (p_header ->> 'valid_until')::date,
      nullif(btrim(p_header ->> 'notes'), ''), nullif(btrim(p_header ->> 'terms'), ''),
      'draft', auth.uid()
    )
    returning * into v_q;
    v_id := v_q.id;
  else
    select * into v_q from public.quotations q where q.id = p_id for update;
    if not found or v_q.deleted_at is not null then
      raise exception 'USER: This quotation no longer exists. It may have been deleted.' using errcode = 'P0001';
    end if;
    if v_q.status <> 'draft' then
      raise exception 'USER: This quotation is % and can''t be edited. Revise it to change the terms.',
        replace(v_q.status::text, '_', ' ') using errcode = 'P0001';
    end if;
    if p_expected_updated_at is not null and v_q.updated_at is distinct from p_expected_updated_at then
      return query select v_q.id, v_q.quotation_number, v_q.status, v_q.updated_at, v_q.subtotal, v_q.tax_amount, v_q.total, true;
      return;
    end if;
    v_id := v_q.id;
    update public.quotations q set
      lead_id = v_lead,
      client_id = v_client,
      client_name = btrim(p_header ->> 'client_name'),
      client_email = nullif(btrim(p_header ->> 'client_email'), ''),
      client_phone = nullif(btrim(p_header ->> 'client_phone'), ''),
      client_company = nullif(btrim(p_header ->> 'client_company'), ''),
      client_gstin = nullif(btrim(p_header ->> 'client_gstin'), ''),
      place_of_supply_code = nullif(btrim(p_header ->> 'place_of_supply_code'), ''),
      issue_date = coalesce(nullif(p_header ->> 'issue_date', '')::date, q.issue_date),
      valid_until = (p_header ->> 'valid_until')::date,
      notes = nullif(btrim(p_header ->> 'notes'), ''),
      terms = nullif(btrim(p_header ->> 'terms'), '')
    where q.id = v_id;
    delete from public.quotation_items i where i.quotation_id = v_id;
  end if;

  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    insert into public.quotation_items (quotation_id, description, service_type, frequency, quantity, unit_price, tax_rate, tax_amount, total, sort_order)
    values (
      v_id,
      btrim(v_item ->> 'description'),
      nullif(v_item ->> 'service_type', '')::public.service_type,
      nullif(v_item ->> 'frequency', '')::public.service_frequency,
      coalesce(nullif(v_item ->> 'quantity', '')::numeric, 1),
      (v_item ->> 'unit_price')::numeric,
      coalesce(nullif(v_item ->> 'tax_rate', '')::numeric, 18),
      0, 0, v_i
    );
    v_i := v_i + 1;
  end loop;

  select coalesce(sum(i.total - i.tax_amount), 0), coalesce(sum(i.tax_amount), 0)
    into v_sub, v_tax
  from public.quotation_items i where i.quotation_id = v_id;

  update public.quotations q set subtotal = v_sub, tax_amount = v_tax, total = v_sub + v_tax
  where q.id = v_id
  returning * into v_q;

  return query select v_q.id, v_q.quotation_number, v_q.status, v_q.updated_at, v_q.subtotal, v_q.tax_amount, v_q.total, false;
end;
$$;

create or replace function public.mark_quotation_sent(
  p_id uuid,
  p_expected_updated_at timestamptz,
  p_channel public.message_channel,
  p_to text,
  p_subject text default null,
  p_provider_message_id text default null,
  p_email_type text default 'initial'
)
returns table (id uuid, status public.quotation_status, updated_at timestamptz, sent_at timestamptz, first_send boolean)
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_q public.quotations%rowtype;
  v_first boolean;
  v_days int[];
  v_to text := nullif(btrim(p_to), '');
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only Partners and Managers send quotations.' using errcode = 'P0001';
  end if;
  -- internal_note: the link was copied and shared by hand ("Copy link", §7.5.3).
  if p_channel is null or p_channel not in ('email', 'gmail_handoff', 'whatsapp_handoff', 'internal_note') then
    raise exception 'USER: Send it by email, Gmail or WhatsApp, or copy its link.' using errcode = 'P0001';
  end if;
  if p_email_type is null or p_email_type not in ('initial', 'revision') then
    raise exception 'USER: That isn''t a kind of quotation email the app sends.' using errcode = 'P0001';
  end if;
  select * into v_q from public.quotations q where q.id = p_id for update;
  if not found or v_q.deleted_at is not null then
    raise exception 'USER: This quotation no longer exists. It may have been deleted.' using errcode = 'P0001';
  end if;
  if p_expected_updated_at is not null and v_q.updated_at is distinct from p_expected_updated_at then
    raise exception '%', public.quotation_conflict_message(v_q.updated_at) using errcode = 'P0001';
  end if;
  if v_q.status = 'pending_approval' then
    raise exception 'USER: This quotation waits for a Partner''s approval before it can be sent.' using errcode = 'P0001';
  end if;
  if v_q.status not in ('draft', 'approved', 'sent', 'viewed') then
    raise exception 'USER: This quotation is % and can''t be sent. Revise it to send a new version.', replace(v_q.status::text, '_', ' ') using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.quotation_items i where i.quotation_id = v_q.id) then
    raise exception 'USER: Add at least one line before sending it.' using errcode = 'P0001';
  end if;
  if v_q.valid_until < public.today_ist() then
    raise exception 'USER: The valid-until date has passed, so the client couldn''t accept it. Revise the quotation (or, for a draft, move the date) first.' using errcode = 'P0001';
  end if;
  if v_to is null then
    v_to := case when p_channel = 'internal_note' then 'Link copied' else coalesce(v_q.client_phone, v_q.client_email::text, 'WhatsApp') end;
  end if;
  v_first := v_q.sent_at is null;

  insert into public.quotation_email_logs (quotation_id, channel, email_type, "to", subject, status, provider_message_id, sent_at)
  values (v_q.id, p_channel, p_email_type, left(v_to, 320), left(nullif(btrim(p_subject), ''), 300),
          case when p_channel = 'email' then 'sent' else 'handed_off' end, nullif(btrim(p_provider_message_id), ''), now());

  update public.quotations q
     set status = case when q.status in ('draft', 'approved') then 'sent'::public.quotation_status else q.status end,
         sent_at = coalesce(q.sent_at, now()),
         last_sent_at = now()
   where q.id = v_q.id
  returning * into v_q;

  if v_first then
    select fs.quotation_follow_up_days into v_days from public.firm_settings fs where fs.id = 1;
    insert into public.quotation_follow_ups (quotation_id, follow_up_day, scheduled_at)
    select v_q.id, d, (((v_q.sent_at at time zone 'Asia/Kolkata')::date + d)::timestamp at time zone 'Asia/Kolkata')
    from unnest(coalesce(v_days, '{3,7,14}'::int[])) d
    where d between 1 and 365
    on conflict (quotation_id, follow_up_day) do nothing;
  end if;

  if v_q.lead_id is not null then
    update public.leads l set status = 'proposal_sent'
     where l.id = v_q.lead_id and l.deleted_at is null
       and l.status in ('new_lead', 'contacted', 'quotation_requested', 'follow_up_required', 'client_will_revert');
  end if;

  return query select v_q.id, v_q.status, v_q.updated_at, v_q.sent_at, v_first;
end;
$$;

create or replace function public.record_quotation_follow_up(
  p_id uuid,
  p_day int,
  p_channel public.message_channel,
  p_to text,
  p_subject text default null,
  p_status text default 'sent',
  p_provider_message_id text default null,
  p_error text default null
)
returns table (follow_up_id uuid, status text)
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_q public.quotations%rowtype;
  v_f public.quotation_follow_ups%rowtype;
  v_failed boolean := p_status = 'failed';
  v_to text := nullif(btrim(p_to), '');
begin
  if not (
    public.is_manager_or_partner()
    or auth.jwt() is null
    or coalesce(auth.jwt() ->> 'role', '') = 'service_role'
  ) then
    raise exception 'USER: Only Partners and Managers follow up quotations.' using errcode = 'P0001';
  end if;
  if p_status is null or p_status not in ('sent', 'handed_off', 'failed') then
    raise exception 'USER: A follow-up is sent, handed off or failed.' using errcode = 'P0001';
  end if;
  if p_channel is null or p_channel not in ('email', 'gmail_handoff', 'whatsapp_handoff') then
    raise exception 'USER: Follow up by email, Gmail or WhatsApp.' using errcode = 'P0001';
  end if;
  select * into v_q from public.quotations q where q.id = p_id for update;
  if not found or v_q.deleted_at is not null then
    raise exception 'USER: This quotation no longer exists. It may have been deleted.' using errcode = 'P0001';
  end if;
  select * into v_f from public.quotation_follow_ups f where f.quotation_id = v_q.id and f.follow_up_day = p_day for update;
  if not found then
    raise exception 'USER: There is no day-% follow-up for this quotation.', p_day using errcode = 'P0001';
  end if;
  if v_f.status not in ('pending', 'failed') then
    raise exception 'USER: The day-% follow-up has already been %.', p_day, v_f.status using errcode = 'P0001';
  end if;
  if not v_failed and (v_q.status not in ('sent', 'viewed') or v_q.valid_until < public.today_ist()) then
    raise exception 'USER: This quotation is no longer open (it is %), so there is nothing to follow up.',
      case when v_q.valid_until < public.today_ist() and v_q.status in ('sent', 'viewed') then 'past its valid-until date' else replace(v_q.status::text, '_', ' ') end
      using errcode = 'P0001';
  end if;
  if v_to is null then
    v_to := coalesce(v_q.client_phone, v_q.client_email::text, 'WhatsApp');
  end if;

  insert into public.quotation_email_logs (quotation_id, channel, email_type, "to", subject, status, provider_message_id, error, sent_at)
  values (v_q.id, p_channel, 'follow_up_' || p_day, left(v_to, 320), left(nullif(btrim(p_subject), ''), 300),
          p_status, nullif(btrim(p_provider_message_id), ''), left(nullif(btrim(p_error), ''), 1000),
          case when v_failed then null else now() end);

  update public.quotation_follow_ups f
     set status = case when v_failed then 'failed' else 'sent' end,
         sent_at = case when v_failed then f.sent_at else now() end,
         channel = p_channel,
         note = case when v_failed then left(nullif(btrim(p_error), ''), 1000) else null end
   where f.id = v_f.id;

  if not v_failed then
    update public.quotation_follow_ups f
       set status = 'skipped', note = 'A later follow-up went instead.'
     where f.quotation_id = v_q.id and f.follow_up_day < p_day and f.status in ('pending', 'failed');
    update public.quotations q set last_sent_at = now() where q.id = v_q.id;
  end if;

  return query select v_f.id, case when v_failed then 'failed' else 'sent' end;
end;
$$;

insert into public.app_meta (key, value) values ('schema_version', '0241')
on conflict (key) do update set value = excluded.value;
