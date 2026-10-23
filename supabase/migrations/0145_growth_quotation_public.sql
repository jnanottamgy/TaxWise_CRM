-- 0145 · The public quotation page (§7.23): views and the client's response, by token.
--
-- server/quotations-public.ts is the only caller, through the service role (server/admin.ts), after
-- its own rate limit (§13: 10 responses per hour per token + IP). Neither function is callable by
-- anon or by a signed-in user. Both are security definer with a pinned search_path and do every
-- state check themselves, holding the quotation's row lock:
--
--   record_quotation_view(token)
--       Counts a view of a quotation the client has been sent (Sent, Viewed, Accepted, Rejected,
--       Expired, Superseded): first_viewed_at once, last_viewed_at and view_count every time; Sent
--       becomes Viewed on the first view. Returns { found, counted, first_view, quotation_id, status }.
--   respond_to_quotation(token, response, name, note, reason, ip)
--       Accept (the client's full name, typed as an e-acceptance, and an optional note) or Decline
--       (a reason) a Sent / Viewed quotation that is within its validity. Superseded, accepted,
--       declined, expired and unsent quotations answer with why instead. On acceptance the lead
--       moves to Won; waiting follow-ups are skipped; the lead's / client's timeline records it.
--       Returns { outcome, … } where outcome is accepted | declined | already_accepted |
--       already_declined | expired | superseded | not_open | not_found | invalid.

set search_path = public, extensions;

create or replace function public.record_quotation_view(p_token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_q public.quotations%rowtype;
  v_first boolean;
begin
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{32,128}$' then
    return jsonb_build_object('found', false);
  end if;
  select * into v_q from public.quotations q where q.token = p_token and q.deleted_at is null for update;
  if not found then
    return jsonb_build_object('found', false);
  end if;
  if v_q.status in ('draft', 'pending_approval', 'approved') then
    return jsonb_build_object('found', true, 'counted', false, 'first_view', false, 'quotation_id', v_q.id, 'status', v_q.status);
  end if;

  v_first := v_q.first_viewed_at is null;
  update public.quotations q
     set first_viewed_at = coalesce(q.first_viewed_at, now()),
         last_viewed_at = now(),
         view_count = q.view_count + 1,
         status = case when q.status = 'sent' then 'viewed'::public.quotation_status else q.status end
   where q.id = v_q.id
  returning * into v_q;

  if v_first and (v_q.client_id is not null or v_q.lead_id is not null) then
    insert into public.client_timeline_events (client_id, lead_id, event_type, title, metadata)
    values (v_q.client_id, v_q.lead_id, 'quotation_viewed', format('Quotation %s opened by the client', v_q.quotation_number),
            jsonb_build_object('quotation_id', v_q.id));
  end if;

  return jsonb_build_object('found', true, 'counted', true, 'first_view', v_first, 'quotation_id', v_q.id, 'status', v_q.status, 'view_count', v_q.view_count);
end;
$$;

create or replace function public.respond_to_quotation(
  p_token text,
  p_response text,
  p_name text default null,
  p_note text default null,
  p_reason text default null,
  p_ip text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_q public.quotations%rowtype;
  v_name text := nullif(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'), '');
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_lead_won boolean := false;
begin
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{32,128}$' then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if p_response is null or p_response not in ('accept', 'decline') then
    return jsonb_build_object('outcome', 'invalid', 'error', 'Choose Accept or Decline.');
  end if;

  select * into v_q from public.quotations q where q.token = p_token and q.deleted_at is null for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_q.status = 'superseded' then
    return jsonb_build_object('outcome', 'superseded', 'quotation_id', v_q.id);
  elsif v_q.status = 'accepted' then
    return jsonb_build_object('outcome', 'already_accepted', 'quotation_id', v_q.id, 'responded_at', v_q.responded_at, 'accepted_by_name', v_q.accepted_by_name);
  elsif v_q.status = 'rejected' then
    return jsonb_build_object('outcome', 'already_declined', 'quotation_id', v_q.id, 'responded_at', v_q.responded_at);
  elsif v_q.status = 'expired' or (v_q.status in ('sent', 'viewed') and v_q.valid_until < public.today_ist()) then
    return jsonb_build_object('outcome', 'expired', 'quotation_id', v_q.id);
  elsif v_q.status not in ('sent', 'viewed') then
    return jsonb_build_object('outcome', 'not_open', 'quotation_id', v_q.id);
  end if;

  if p_response = 'accept' then
    if v_name is null or char_length(v_name) < 2 then
      return jsonb_build_object('outcome', 'invalid', 'field', 'name', 'error', 'Type your full name to accept.');
    end if;
    if char_length(v_name) > 120 then
      return jsonb_build_object('outcome', 'invalid', 'field', 'name', 'error', 'Keep your name under 120 characters.');
    end if;
    if v_note is not null and char_length(v_note) > 2000 then
      return jsonb_build_object('outcome', 'invalid', 'field', 'note', 'error', 'Keep the note under 2,000 characters.');
    end if;
    update public.quotations q
       set status = 'accepted', responded_at = now(), response = 'accepted', accepted_by_name = v_name,
           response_note = v_note, response_ip = left(nullif(btrim(p_ip), ''), 64),
           first_viewed_at = coalesce(q.first_viewed_at, now()), last_viewed_at = coalesce(q.last_viewed_at, now())
     where q.id = v_q.id
    returning * into v_q;

    if v_q.lead_id is not null then
      update public.leads l set status = 'won'
       where l.id = v_q.lead_id and l.deleted_at is null and l.status <> 'won' and l.converted_client_id is null;
      v_lead_won := found;
    end if;

    if v_q.client_id is not null or v_q.lead_id is not null then
      insert into public.client_timeline_events (client_id, lead_id, event_type, title, description, metadata)
      values (v_q.client_id, v_q.lead_id, 'quotation_accepted',
            format('Quotation %s accepted electronically by %s', v_q.quotation_number, v_name),
              v_note, jsonb_build_object('quotation_id', v_q.id, 'total', v_q.total));
    end if;
  else
    if v_reason is null or char_length(v_reason) < 3 then
      return jsonb_build_object('outcome', 'invalid', 'field', 'reason', 'error', 'Tell us briefly why you are declining.');
    end if;
    if char_length(v_reason) > 2000 then
      return jsonb_build_object('outcome', 'invalid', 'field', 'reason', 'error', 'Keep the reason under 2,000 characters.');
    end if;
    update public.quotations q
       set status = 'rejected', responded_at = now(), response = 'rejected', rejection_reason = v_reason,
           response_ip = left(nullif(btrim(p_ip), ''), 64),
           first_viewed_at = coalesce(q.first_viewed_at, now()), last_viewed_at = coalesce(q.last_viewed_at, now())
     where q.id = v_q.id
    returning * into v_q;

    if v_q.client_id is not null or v_q.lead_id is not null then
      insert into public.client_timeline_events (client_id, lead_id, event_type, title, description, metadata)
      values (v_q.client_id, v_q.lead_id, 'quotation_rejected', format('Quotation %s declined by the client', v_q.quotation_number),
              v_reason, jsonb_build_object('quotation_id', v_q.id));
    end if;
  end if;

  update public.quotation_follow_ups f
     set status = 'skipped', note = case when p_response = 'accept' then 'The client accepted.' else 'The client declined.' end
   where f.quotation_id = v_q.id and f.status in ('pending', 'failed');

  return jsonb_build_object(
    'outcome', case when p_response = 'accept' then 'accepted' else 'declined' end,
    'quotation_id', v_q.id,
    'quotation_number', v_q.quotation_number,
    'responded_at', v_q.responded_at,
    'accepted_by_name', v_q.accepted_by_name,
    'lead_id', v_q.lead_id,
    'lead_won', v_lead_won,
    'client_id', v_q.client_id,
    'created_by', v_q.created_by
  );
end;
$$;

comment on function public.record_quotation_view(text) is
  'Service role only (server/quotations-public.ts): counts a view of a sent quotation by its token; Sent → Viewed on the first (§7.23).';
comment on function public.respond_to_quotation(text, text, text, text, text, text) is
  'Service role only (server/quotations-public.ts): the client accepts (typed full name, optional note) or declines (reason) an open, unexpired quotation; every state check under the row lock; lead → Won on acceptance (§7.5.3, §7.23).';

revoke execute on function public.record_quotation_view(text), public.respond_to_quotation(text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.record_quotation_view(text), public.respond_to_quotation(text, text, text, text, text, text)
  to service_role;
