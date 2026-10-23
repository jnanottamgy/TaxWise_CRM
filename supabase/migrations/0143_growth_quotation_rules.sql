-- 0143 · Quotation rules (§7.5.2, §7.5.3, §7.23): what may change, and when.
--
--   quotations: response_note (the client's optional note when accepting), approval_requested_at /
--     approval_requested_by ("Submit for approval"), returned_at ("Return with comments"),
--     last_sent_at (resends and follow-ups), expired_at (the nightly expiry).
--   quotation_follow_ups: notified_at (the owner was asked to hand it off), channel, note.
--
--   quotations_status_guard (trigger; after quotations_role_guard, which keeps approvals to Partners)
--     For the API roles (a Partner's or Manager's session):
--       * a Draft is edited in place; once it leaves Draft its content is fixed: "a quotation that
--         has been sent, viewed, rejected, expired, approved or pending is never edited in place"
--         (§7.5.3): only Revise changes it;
--       * status moves only along the workflow: Draft → Pending approval | Sent;
--         Pending approval → Approved | Draft (returned) | Sent (approved) | Superseded;
--         Approved → Sent | Superseded; Sent → Superseded; Viewed → Superseded;
--         Rejected → Superseded; Expired → Superseded. Viewed, Accepted and Rejected come from the
--         client's page and Expired from the nightly job (both run as the system); Superseded only
--         once a revision exists;
--       * the view counters, the client's response, the token, the number and the revision chain
--         are never written from a session;
--       * converted_client_id is stamped once, on an accepted quotation;
--       * an accepted quotation can't be deleted (it is the record of what the client agreed).
--   quotation_items_guard (trigger): lines change only while the quotation is a Draft (the first
--     lines may be added to a quotation that has none), and each line's tax and total are computed
--     here, half-up to the paisa: amount = round(qty × unit price, 2), tax = round(amount × rate%, 2),
--     total = amount + tax (lib/domain/gst.ts computeLine).
--   save_quotation(id, expected_updated_at, header, items)  the builder's autosave and save: creates
--     or updates a Draft and replaces its lines in one transaction, totals from the lines, with
--     optimistic concurrency (returns conflict instead of overwriting).

set search_path = public, extensions;

alter table public.quotations
  add column if not exists response_note text,
  add column if not exists approval_requested_at timestamptz,
  add column if not exists approval_requested_by uuid,
  add column if not exists returned_at timestamptz,
  add column if not exists last_sent_at timestamptz,
  add column if not exists expired_at timestamptz;

alter table public.quotations drop constraint if exists quotations_response_note_length;
alter table public.quotations add constraint quotations_response_note_length check (response_note is null or char_length(response_note) <= 2000);

comment on column public.quotations.response_note is 'The client''s optional note when accepting on the public page (§7.23).';
comment on column public.quotations.approval_requested_at is 'When it was submitted for a Partner''s approval (§7.5.2).';
comment on column public.quotations.returned_at is 'When a Partner returned it with comments (approval_note) (§7.5.2).';
comment on column public.quotations.last_sent_at is 'The latest send, resend or follow-up (sent_at is the first send).';

alter table public.quotation_follow_ups
  add column if not exists notified_at timestamptz,
  add column if not exists channel public.message_channel,
  add column if not exists note text;

comment on column public.quotation_follow_ups.notified_at is 'When the owner was asked to hand this follow-up off (email not available or failed, §7.5.3).';

-- =============================================================================================
-- quotations_status_guard
-- =============================================================================================
create or replace function public.quotations_status_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_parent public.quotations%rowtype;
  v_ok boolean;
  -- Columns a session never writes (the client's page, the job and the numbering do).
  c_system constant text[] := array['token', 'quotation_number', 'first_viewed_at', 'last_viewed_at', 'view_count',
    'responded_at', 'response', 'rejection_reason', 'accepted_by_name', 'response_ip', 'response_note',
    'revision_number', 'revised_from_id', 'expired_at'];
  -- Columns the workflow moves once a quotation has left Draft.
  c_workflow constant text[] := array['status', 'sent_at', 'last_sent_at', 'approved_by', 'approved_at', 'approval_note',
    'approval_requested_at', 'approval_requested_by', 'returned_at', 'converted_client_id', 'deleted_at', 'deleted_by', 'updated_at'];
begin
  if not public.is_api_caller() or not public.is_manager_or_partner() then
    -- The system (the public page's functions, the jobs, migrations) keeps its own rules; anyone
    -- else is refused by RLS.
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.first_viewed_at is not null or new.last_viewed_at is not null or coalesce(new.view_count, 0) <> 0
       or new.responded_at is not null or new.response is not null or new.rejection_reason is not null
       or new.accepted_by_name is not null or new.response_ip is not null or new.response_note is not null
       or new.expired_at is not null then
      raise exception 'USER: A new quotation can''t carry the client''s views or response.' using errcode = 'P0001';
    end if;
    if new.revised_from_id is not null then
      select * into v_parent from public.quotations q where q.id = new.revised_from_id;
      if not found or v_parent.status not in ('pending_approval', 'approved', 'sent', 'viewed', 'rejected', 'expired')
         or new.revision_number <> v_parent.revision_number + 1 then
        raise exception 'USER: A revision must follow the quotation it replaces. Use Revise on that quotation.' using errcode = 'P0001';
      end if;
    elsif coalesce(new.revision_number, 0) <> 0 then
      raise exception 'USER: Only a revision has a revision number.' using errcode = 'P0001';
    end if;
    return new;
  end if;

  v_old := to_jsonb(old);
  v_new := to_jsonb(new);

  -- 1. System columns.
  if exists (select 1 from unnest(c_system) k where v_new -> k is distinct from v_old -> k) then
    raise exception 'USER: The quotation''s number, link, views and the client''s response can''t be changed.' using errcode = 'P0001';
  end if;

  -- 2. Content is fixed once the quotation has left Draft.
  if old.status <> 'draft' and (v_new - c_workflow) is distinct from (v_old - c_workflow) then
    raise exception 'USER: This quotation is % and can''t be edited. Revise it to change the terms.',
      replace(old.status::text, '_', ' ') using errcode = 'P0001';
  end if;

  -- 3. Status moves.
  if new.status is distinct from old.status then
    v_ok := case old.status
      when 'draft' then new.status in ('pending_approval', 'sent')
      when 'pending_approval' then new.status in ('approved', 'draft', 'sent', 'superseded')
      when 'approved' then new.status in ('sent', 'superseded')
      when 'sent' then new.status in ('superseded')
      when 'viewed' then new.status in ('superseded')
      when 'rejected' then new.status in ('superseded')
      when 'expired' then new.status in ('superseded')
      else false
    end;
    if not v_ok then
      raise exception 'USER: A quotation can''t go from % to % here.',
        replace(old.status::text, '_', ' '), replace(new.status::text, '_', ' ') using errcode = 'P0001';
    end if;
    if new.status = 'sent' and old.status = 'pending_approval' and new.approved_at is null then
      raise exception 'USER: This quotation is waiting for a Partner''s approval, so it can''t be sent yet.' using errcode = 'P0001';
    end if;
    if new.status = 'superseded' and not exists (select 1 from public.quotations r where r.revised_from_id = old.id) then
      raise exception 'USER: A quotation is superseded only by a revision. Use Revise.' using errcode = 'P0001';
    end if;
  end if;

  -- 4. Conversion is stamped once, on an accepted quotation (a purged client clears it).
  if new.converted_client_id is distinct from old.converted_client_id and new.converted_client_id is not null then
    if old.converted_client_id is not null then
      raise exception 'USER: Quotation % has already been converted to a client.', old.quotation_number using errcode = 'P0001';
    end if;
    if new.status <> 'accepted' then
      raise exception 'USER: Only an accepted quotation can be converted to a client.' using errcode = 'P0001';
    end if;
  end if;

  -- 5. Soft delete.
  if new.deleted_at is not null and old.deleted_at is null and old.status = 'accepted' then
    raise exception 'USER: An accepted quotation is the record of what the client agreed, so it can''t be deleted.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

comment on function public.quotations_status_guard() is
  'Trigger: Draft-only editing, the workflow''s status moves, system columns, one conversion and no deleting an accepted quotation, for Partner/Manager sessions (§7.5.2, §7.5.3).';

drop trigger if exists quotations_status_guard on public.quotations;
create trigger quotations_status_guard before insert or update on public.quotations
  for each row execute function public.quotations_status_guard();

-- =============================================================================================
-- quotation_items_guard
-- =============================================================================================
create or replace function public.quotation_items_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_status public.quotation_status;
  v_id uuid := coalesce(new.quotation_id, old.quotation_id);
  v_amount numeric(14,2);
begin
  if not public.is_api_caller() or public.is_manager_or_partner() then
    if public.is_api_caller() then
      select q.status into v_status from public.quotations q where q.id = v_id;
      if v_status is not null and v_status <> 'draft' then
        if tg_op = 'INSERT' and not exists (select 1 from public.quotation_items i where i.quotation_id = v_id) then
          null; -- the first lines of a quotation that has none
        else
          raise exception 'USER: This quotation is % and its lines can''t be changed. Revise it to change the terms.',
            replace(v_status::text, '_', ' ') using errcode = 'P0001';
        end if;
      end if;
      if tg_op = 'UPDATE' and new.quotation_id is distinct from old.quotation_id then
        raise exception 'USER: A line can''t move to another quotation.' using errcode = 'P0001';
      end if;
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  if public.is_api_caller() and not public.is_manager_or_partner() then
    return new; -- RLS refuses it
  end if;

  v_amount := round(new.quantity * new.unit_price, 2);
  new.tax_amount := round(v_amount * new.tax_rate / 100, 2);
  new.total := v_amount + new.tax_amount;
  return new;
end;
$$;

comment on function public.quotation_items_guard() is
  'Trigger: quotation lines change only on a Draft; each line''s tax = round(round(qty × price, 2) × rate%, 2) and total = amount + tax (§6.3, §7.5.2).';

drop trigger if exists quotation_items_guard on public.quotation_items;
create trigger quotation_items_guard before insert or update or delete on public.quotation_items
  for each row execute function public.quotation_items_guard();

-- =============================================================================================
-- save_quotation (the builder: autosave and save)
--   p_header: { lead_id, client_id, client_name, client_email, client_phone, client_company,
--               client_gstin, place_of_supply_code, issue_date, valid_until, notes, terms }
--   p_items:  [{ description, service_type, frequency, quantity, unit_price, tax_rate }]
-- =============================================================================================
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
  if nullif(btrim(p_header ->> 'client_name'), '') is null or nullif(btrim(p_header ->> 'client_email'), '') is null
     or nullif(p_header ->> 'valid_until', '') is null then
    raise exception 'USER: Add the client''s name and email, and the valid-until date, to save the draft.' using errcode = 'P0001';
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
      btrim(p_header ->> 'client_name'), btrim(p_header ->> 'client_email'),
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
      client_email = btrim(p_header ->> 'client_email'),
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

comment on function public.save_quotation(uuid, timestamptz, jsonb, jsonb) is
  'Partner/Manager: creates or updates a Draft quotation and replaces its lines in one transaction, totals from the lines; returns conflict = true (and changes nothing) when the row changed since expected_updated_at (§7.5.2, §13).';

create index if not exists quotations_lead_idx on public.quotations (lead_id) where lead_id is not null;
create index if not exists quotations_client_idx on public.quotations (client_id) where client_id is not null;
create index if not exists quotations_revised_from_idx on public.quotations (revised_from_id) where revised_from_id is not null;
create index if not exists quotations_status_creator_idx on public.quotations (created_by, status) where deleted_at is null;

revoke execute on function public.quotations_status_guard(), public.quotation_items_guard() from public, anon, authenticated;
revoke execute on function public.save_quotation(uuid, timestamptz, jsonb, jsonb) from public, anon;
grant execute on function public.save_quotation(uuid, timestamptz, jsonb, jsonb) to authenticated;
