-- 0144 · The quotation workflow (§7.5.2, §7.5.3), each step one transaction under the caller's
-- session (security invoker: RLS, quotations_role_guard and quotations_status_guard all apply).
-- Every step takes the updated_at the person loaded and refuses with 'USER: CONFLICT: …' when the
-- row changed since (§13); server/actions/quotations.ts turns that into a conflict result.
--
--   submit_quotation_for_approval(id, updated_at)
--       A Manager's Draft over the quotation approval limit (or any, when the limit is null) →
--       Pending approval. Partners' quotations skip approval (quotationNeedsApproval).
--   decide_quotation_approval(id, updated_at, decision, note)
--       Partner only. 'approve' → Approved (approved_by / approved_at); 'return' → back to Draft
--       with the comments (approval_note, returned_at). Approve & send is approve, then send.
--   mark_quotation_sent(id, updated_at, channel, to, subject, provider_message_id, email_type)
--       After the email went out (with Resend's id), when a WhatsApp / Gmail hand-off was opened, or
--       when its link was copied to share by hand (channel internal_note, logged as handed off):
--       logs quotation_email_logs, moves Draft / Approved → Sent (sent_at once, last_sent_at every
--       time), schedules the day 3 / 7 / 14 follow-ups on the first send (firm_settings
--       .quotation_follow_up_days, due on that IST date) and moves the lead to Proposal sent when
--       it was at an earlier stage.
--   record_quotation_follow_up(id, day, channel, to, subject, status, provider_message_id, error)
--       A follow-up sent by email (the job, as the system) or handed off by a person: logs it,
--       marks the follow-up sent (or failed) and skips earlier ones still waiting.
--   revise_quotation(id, updated_at)
--       Pending approval, Approved, Sent, Viewed, Rejected or Expired → a new Draft with the same
--       lines (revision_number + 1, a new number and link, the caller as its author, validity from
--       today) and the old one Superseded: its link stops taking responses. Its waiting follow-ups
--       are skipped.

set search_path = public, extensions;

-- =============================================================================================
-- Shared refusal for a stale row
-- =============================================================================================
create or replace function public.quotation_conflict_message(p_updated_at timestamptz)
returns text
language sql
stable
set search_path = public, extensions
as $$
  select 'USER: CONFLICT: This quotation was changed at ' || to_char(p_updated_at at time zone 'Asia/Kolkata', 'HH24:MI')
         || ' on ' || to_char(p_updated_at at time zone 'Asia/Kolkata', 'DD Mon') || '. Reload to see the changes.'
$$;

-- =============================================================================================
-- submit_quotation_for_approval
-- =============================================================================================
create or replace function public.submit_quotation_for_approval(p_id uuid, p_expected_updated_at timestamptz)
returns table (id uuid, status public.quotation_status, updated_at timestamptz)
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_q public.quotations%rowtype;
  v_limit numeric(14,2);
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only Partners and Managers prepare quotations.' using errcode = 'P0001';
  end if;
  select * into v_q from public.quotations q where q.id = p_id for update;
  if not found or v_q.deleted_at is not null then
    raise exception 'USER: This quotation no longer exists. It may have been deleted.' using errcode = 'P0001';
  end if;
  if p_expected_updated_at is not null and v_q.updated_at is distinct from p_expected_updated_at then
    raise exception '%', public.quotation_conflict_message(v_q.updated_at) using errcode = 'P0001';
  end if;
  if v_q.status <> 'draft' then
    raise exception 'USER: Only a draft can be submitted for approval. This quotation is %.', replace(v_q.status::text, '_', ' ') using errcode = 'P0001';
  end if;
  if public.is_partner() or exists (select 1 from public.profiles p where p.id = v_q.created_by and p.role = 'partner') then
    raise exception 'USER: A Partner''s quotation needs no approval. Send it to the client.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.quotation_items i where i.quotation_id = v_q.id) then
    raise exception 'USER: Add at least one line before submitting it.' using errcode = 'P0001';
  end if;
  if v_q.valid_until < public.today_ist() then
    raise exception 'USER: The valid-until date has passed. Move it to a later date first.' using errcode = 'P0001';
  end if;
  select fs.quotation_approval_limit into v_limit from public.firm_settings fs where fs.id = 1;
  -- quotationNeedsApproval(): null limit = always; 0 = never; otherwise total > limit.
  if v_limit is not null and (v_limit = 0 or v_q.total <= v_limit) then
    raise exception 'USER: This quotation is within the approval limit, so you can send it yourself.' using errcode = 'P0001';
  end if;

  update public.quotations q
     set status = 'pending_approval',
         approval_requested_at = now(),
         approval_requested_by = auth.uid(),
         approval_note = null,
         returned_at = null
   where q.id = v_q.id
  returning * into v_q;
  return query select v_q.id, v_q.status, v_q.updated_at;
end;
$$;

-- =============================================================================================
-- decide_quotation_approval
-- =============================================================================================
create or replace function public.decide_quotation_approval(p_id uuid, p_expected_updated_at timestamptz, p_decision text, p_note text default null)
returns table (id uuid, status public.quotation_status, updated_at timestamptz)
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_q public.quotations%rowtype;
  v_note text := nullif(btrim(p_note), '');
begin
  if not public.is_partner() then
    raise exception 'USER: Only a Partner can approve or return a quotation.' using errcode = 'P0001';
  end if;
  if p_decision is null or p_decision not in ('approve', 'return') then
    raise exception 'USER: Choose Approve or Return with comments.' using errcode = 'P0001';
  end if;
  if v_note is not null and char_length(v_note) > 2000 then
    raise exception 'USER: Keep the comments under 2,000 characters.' using errcode = 'P0001';
  end if;
  select * into v_q from public.quotations q where q.id = p_id for update;
  if not found or v_q.deleted_at is not null then
    raise exception 'USER: This quotation no longer exists. It may have been deleted.' using errcode = 'P0001';
  end if;
  if p_expected_updated_at is not null and v_q.updated_at is distinct from p_expected_updated_at then
    raise exception '%', public.quotation_conflict_message(v_q.updated_at) using errcode = 'P0001';
  end if;
  if v_q.status <> 'pending_approval' then
    raise exception 'USER: This quotation isn''t waiting for approval: it is %.', replace(v_q.status::text, '_', ' ') using errcode = 'P0001';
  end if;

  if p_decision = 'approve' then
    if v_q.valid_until < public.today_ist() then
      raise exception 'USER: The valid-until date has passed. Return it with comments so the date can be moved.' using errcode = 'P0001';
    end if;
    update public.quotations q
       set status = 'approved', approved_by = auth.uid(), approved_at = now(), approval_note = v_note
     where q.id = v_q.id
    returning * into v_q;
  else
    if v_note is null then
      raise exception 'USER: Say what needs to change, so it can be fixed and submitted again.' using errcode = 'P0001';
    end if;
    update public.quotations q
       set status = 'draft', approved_by = null, approved_at = null, approval_note = v_note, returned_at = now()
     where q.id = v_q.id
    returning * into v_q;
  end if;
  return query select v_q.id, v_q.status, v_q.updated_at;
end;
$$;

-- =============================================================================================
-- mark_quotation_sent
-- =============================================================================================
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
    v_to := case when p_channel = 'internal_note' then 'Link copied' else v_q.client_email::text end;
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

-- =============================================================================================
-- record_quotation_follow_up
-- =============================================================================================
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
    v_to := v_q.client_email::text;
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

-- =============================================================================================
-- revise_quotation
-- =============================================================================================
create or replace function public.revise_quotation(p_id uuid, p_expected_updated_at timestamptz)
returns table (id uuid, quotation_number text, revision_number int)
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_old public.quotations%rowtype;
  v_new public.quotations%rowtype;
  v_validity int;
  v_sub numeric(14,2);
  v_tax numeric(14,2);
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only Partners and Managers revise quotations.' using errcode = 'P0001';
  end if;
  select * into v_old from public.quotations q where q.id = p_id for update;
  if not found or v_old.deleted_at is not null then
    raise exception 'USER: This quotation no longer exists. It may have been deleted.' using errcode = 'P0001';
  end if;
  if p_expected_updated_at is not null and v_old.updated_at is distinct from p_expected_updated_at then
    raise exception '%', public.quotation_conflict_message(v_old.updated_at) using errcode = 'P0001';
  end if;
  case v_old.status
    when 'draft' then
      raise exception 'USER: A draft is edited directly; there is nothing to revise.' using errcode = 'P0001';
    when 'accepted' then
      raise exception 'USER: An accepted quotation can''t be revised. Prepare a new quotation for further work.' using errcode = 'P0001';
    when 'superseded' then
      raise exception 'USER: This quotation has already been revised. Open the newer version.' using errcode = 'P0001';
    else
      null;
  end case;

  select coalesce(fs.quotation_validity_days, 30) into v_validity from public.firm_settings fs where fs.id = 1;

  insert into public.quotations (
    lead_id, client_id, client_name, client_email, client_phone, client_company, client_gstin, place_of_supply_code,
    issue_date, valid_until, notes, terms, status, created_by, revised_from_id, revision_number
  ) values (
    v_old.lead_id, v_old.client_id, v_old.client_name, v_old.client_email, v_old.client_phone, v_old.client_company,
    v_old.client_gstin, v_old.place_of_supply_code, public.today_ist(), public.today_ist() + coalesce(v_validity, 30),
    v_old.notes, v_old.terms, 'draft', auth.uid(), v_old.id, v_old.revision_number + 1
  )
  returning * into v_new;

  insert into public.quotation_items (quotation_id, description, service_type, frequency, quantity, unit_price, tax_rate, tax_amount, total, sort_order)
  select v_new.id, i.description, i.service_type, i.frequency, i.quantity, i.unit_price, i.tax_rate, 0, 0, i.sort_order
  from public.quotation_items i
  where i.quotation_id = v_old.id
  order by i.sort_order, i.created_at;

  select coalesce(sum(i.total - i.tax_amount), 0), coalesce(sum(i.tax_amount), 0) into v_sub, v_tax
  from public.quotation_items i where i.quotation_id = v_new.id;
  update public.quotations q set subtotal = v_sub, tax_amount = v_tax, total = v_sub + v_tax where q.id = v_new.id;

  update public.quotations q set status = 'superseded' where q.id = v_old.id;
  update public.quotation_follow_ups f
     set status = 'skipped', note = 'Replaced by revision ' || v_new.quotation_number || '.'
   where f.quotation_id = v_old.id and f.status in ('pending', 'failed');

  return query select v_new.id, v_new.quotation_number, v_new.revision_number;
end;
$$;

comment on function public.submit_quotation_for_approval(uuid, timestamptz) is 'Partner/Manager: a Manager''s Draft that needs approval → Pending approval (§7.5.2).';
comment on function public.decide_quotation_approval(uuid, timestamptz, text, text) is 'Partner: Approve (→ Approved) or Return with comments (→ Draft) a quotation pending approval (§7.5.2).';
comment on function public.mark_quotation_sent(uuid, timestamptz, public.message_channel, text, text, text, text) is 'Partner/Manager: records a send (email with the provider id, or a WhatsApp/Gmail hand-off), moves it to Sent, schedules the follow-ups once and moves the lead to Proposal sent (§7.5.3).';
comment on function public.record_quotation_follow_up(uuid, int, public.message_channel, text, text, text, text, text) is 'Partner/Manager or the system: records a day-N follow-up sent, handed off or failed, and skips earlier ones (§7.5.3).';
comment on function public.revise_quotation(uuid, timestamptz) is 'Partner/Manager: a new Draft revision (same lines, revision_number + 1, new number and link) and the old quotation Superseded (§7.5.3).';

revoke execute on function
  public.quotation_conflict_message(timestamptz),
  public.submit_quotation_for_approval(uuid, timestamptz),
  public.decide_quotation_approval(uuid, timestamptz, text, text),
  public.mark_quotation_sent(uuid, timestamptz, public.message_channel, text, text, text, text),
  public.record_quotation_follow_up(uuid, int, public.message_channel, text, text, text, text, text),
  public.revise_quotation(uuid, timestamptz)
from public, anon;

grant execute on function
  public.submit_quotation_for_approval(uuid, timestamptz),
  public.decide_quotation_approval(uuid, timestamptz, text, text),
  public.mark_quotation_sent(uuid, timestamptz, public.message_channel, text, text, text, text),
  public.record_quotation_follow_up(uuid, int, public.message_channel, text, text, text, text, text),
  public.revise_quotation(uuid, timestamptz)
to authenticated, service_role;

grant execute on function public.quotation_conflict_message(timestamptz) to authenticated, service_role;
