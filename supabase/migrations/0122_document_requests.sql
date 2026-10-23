-- 0122 · Document requests: PBC lists (§5.8, §7.14, §7.22).
--
--   create_document_request(client, title, due, notes, every_days, contact, items jsonb)
--        The request and its items in one transaction, under the caller's RLS (staff who can see
--        the client). Items: [{ "title": "...", "help_text": "...", "is_required": true }, …].
--   review_document_request_item(item, decision, reason, document, expected_updated_at)
--        Staff accept an uploaded item (or link a vault document and accept it), or reject it with a
--        reason so the client can upload it again (§7.14). Optimistic: a stale expected_updated_at
--        is refused. Returns the item's and the request's new status.
--   document_request_is_complete(request)
--        At least one item, and every required item accepted (when every item is optional, every
--        item accepted). Mirrors requestProgress() in lib/schemas/document-requests.ts.
--   Status upkeep (for every writer):
--        * a request completes by itself when it becomes complete, and reopens when it no longer is
--          (an item rejected again, a new required item); a cancelled request stays cancelled;
--        * a request can't be created completed or cancelled, or marked completed by hand while
--          items are outstanding; completed_at / cancelled_at / cancelled_by are stamped;
--        * items of a cancelled request can't be added; an item is accepted only with a file;
--          uploaded_at / reviewed_at / reviewed_by are stamped; an item never moves to another request.

set search_path = public, extensions;

-- =============================================================================================
-- Completeness
-- =============================================================================================
create or replace function public.document_request_is_complete(p_request_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select exists (select 1 from public.document_request_items i where i.request_id = p_request_id)
     and not exists (
       select 1 from public.document_request_items i
       where i.request_id = p_request_id
         and i.status <> 'accepted'
         and (
           i.is_required
           or not exists (select 1 from public.document_request_items r where r.request_id = p_request_id and r.is_required)
         )
     )
$$;

comment on function public.document_request_is_complete(uuid) is
  'True when the request has items and every required item is accepted (every item, when none is required) (§7.14).';

-- =============================================================================================
-- Request status guard and stamps (runs after limit_employee_columns: trigger names sort)
-- =============================================================================================
create or replace function public.document_requests_status_stamp()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'open' then
      raise exception 'USER: A new request starts open.' using errcode = 'P0001';
    end if;
    new.completed_at := null;
    new.cancelled_at := null;
    new.cancelled_by := null;
    new.reminder_count := coalesce(new.reminder_count, 0);
    return new;
  end if;

  if new.client_id is distinct from old.client_id then
    raise exception 'USER: A request can''t be moved to another client.' using errcode = 'P0001';
  end if;

  if new.status is distinct from old.status then
    if new.status = 'completed' then
      if not public.document_request_is_complete(new.id) then
        raise exception 'USER: A request completes by itself once every required item is accepted.' using errcode = 'P0001';
      end if;
      new.completed_at := now();
      new.cancelled_at := null;
      new.cancelled_by := null;
    elsif new.status = 'cancelled' then
      new.cancelled_at := now();
      new.cancelled_by := coalesce(auth.uid(), new.cancelled_by);
      new.completed_at := null;
    else -- reopened
      new.cancelled_at := null;
      new.cancelled_by := null;
      new.cancel_reason := null;
      new.completed_at := null;
      if public.document_request_is_complete(new.id) then
        new.status := 'completed';
        new.completed_at := now();
      end if;
    end if;
  end if;
  return new;
end;
$$;

create trigger stamp_request_status before insert or update on public.document_requests
  for each row execute function public.document_requests_status_stamp();

-- =============================================================================================
-- Item guard and stamps (runs after document_request_items_portal_guard: names sort)
-- =============================================================================================
create or replace function public.document_request_items_stamp()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_status public.request_status;
begin
  if tg_op = 'UPDATE' and new.request_id is distinct from old.request_id then
    raise exception 'USER: An item can''t be moved to another request.' using errcode = 'P0001';
  end if;
  if tg_op = 'INSERT' then
    select r.status into v_status from public.document_requests r where r.id = new.request_id;
    if v_status = 'cancelled' then
      raise exception 'USER: This request has been cancelled. Reopen it before adding items.' using errcode = 'P0001';
    end if;
  end if;

  if new.status = 'accepted' and new.document_id is null then
    raise exception 'USER: Upload or link the file before accepting this item.' using errcode = 'P0001';
  end if;

  if tg_op = 'INSERT' or new.status is distinct from old.status then
    case new.status
      when 'uploaded' then
        new.uploaded_at := now();
      when 'accepted', 'rejected' then
        new.reviewed_at := now();
        new.reviewed_by := coalesce(auth.uid(), new.reviewed_by);
        if new.uploaded_at is null and new.document_id is not null then
          new.uploaded_at := now();
        end if;
      else
        new.uploaded_at := null;
        new.reviewed_at := null;
        new.reviewed_by := null;
    end case;
  end if;
  return new;
end;
$$;

create trigger document_request_items_stamp before insert or update on public.document_request_items
  for each row execute function public.document_request_items_stamp();

-- =============================================================================================
-- The request follows its items (AFTER, as the system so the Employee column limit and the
-- portal's lack of UPDATE on requests don't stop the bookkeeping).
-- =============================================================================================
create or replace function public.sync_document_request_status(p_request_id uuid)
returns public.request_status
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_status public.request_status;
  v_complete boolean;
begin
  select status into v_status from public.document_requests where id = p_request_id for update;
  if v_status is null or v_status = 'cancelled' then
    return v_status;
  end if;
  v_complete := public.document_request_is_complete(p_request_id);
  if v_status = 'open' and v_complete then
    update public.document_requests set status = 'completed' where id = p_request_id;
    return 'completed';
  elsif v_status = 'completed' and not v_complete then
    update public.document_requests set status = 'open' where id = p_request_id;
    return 'open';
  end if;
  return v_status;
end;
$$;

comment on function public.sync_document_request_status(uuid) is
  'Completes an open request that has become complete, or reopens a completed one that no longer is (§7.14).';

create or replace function public.document_request_items_sync()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.sync_document_request_status(old.request_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') and (tg_op = 'INSERT' or new.request_id is distinct from old.request_id) then
    perform public.sync_document_request_status(new.request_id);
  end if;
  return null;
end;
$$;

create trigger document_request_items_sync after insert or delete or update of status, is_required, request_id on public.document_request_items
  for each row execute function public.document_request_items_sync();

-- =============================================================================================
-- create_document_request (SECURITY INVOKER)
-- =============================================================================================
create or replace function public.create_document_request(
  p_client_id uuid,
  p_title text,
  p_due_date date,
  p_notes text,
  p_reminder_every_days int,
  p_contact_id uuid,
  p_items jsonb
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_id uuid;
  v_item jsonb;
  v_order int := 0;
  v_title text := btrim(coalesce(p_title, ''));
begin
  if not public.is_staff() then
    raise exception 'USER: Only the firm''s staff can request documents.' using errcode = 'P0001';
  end if;
  if v_title = '' then
    raise exception 'USER: Give the request a title.' using errcode = 'P0001';
  end if;
  if p_due_date is not null and p_due_date < public.today_ist() then
    raise exception 'USER: Choose a due date from today on.' using errcode = 'P0001';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'USER: Add at least one item to request.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_items) > 50 then
    raise exception 'USER: A request can have at most 50 items. Split it into two.' using errcode = 'P0001';
  end if;
  if p_contact_id is not null and not exists (
    select 1 from public.client_contacts c where c.id = p_contact_id and c.client_id = p_client_id
  ) then
    raise exception 'USER: Choose one of this client''s contacts.' using errcode = 'P0001';
  end if;

  insert into public.document_requests (client_id, title, due_date, notes, created_by, reminder_every_days, contact_id)
  values (p_client_id, left(v_title, 200), p_due_date, nullif(btrim(coalesce(p_notes, '')), ''), auth.uid(),
          coalesce(p_reminder_every_days, 3), p_contact_id)
  returning id into v_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    if btrim(coalesce(v_item ->> 'title', '')) = '' then
      raise exception 'USER: Every item needs a title.' using errcode = 'P0001';
    end if;
    insert into public.document_request_items (request_id, title, help_text, is_required, sort_order)
    values (v_id, left(btrim(v_item ->> 'title'), 200), nullif(btrim(coalesce(v_item ->> 'help_text', '')), ''),
            coalesce((v_item ->> 'is_required')::boolean, true), v_order);
    v_order := v_order + 1;
  end loop;
  return v_id;
end;
$$;

comment on function public.create_document_request(uuid, text, date, text, int, uuid, jsonb) is
  'Creates a document request (PBC list) and its items in one transaction under the caller''s RLS (§7.14).';

-- =============================================================================================
-- review_document_request_item (SECURITY INVOKER)
-- =============================================================================================
create or replace function public.review_document_request_item(
  p_item_id uuid,
  p_decision text,
  p_reason text default null,
  p_document_id uuid default null,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_item public.document_request_items%rowtype;
  v_req public.document_requests%rowtype;
  v_doc uuid;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_request_status public.request_status;
begin
  if not public.is_staff() then
    raise exception 'USER: Only the firm''s staff accept or reject uploads.' using errcode = 'P0001';
  end if;
  if p_decision not in ('accept', 'reject') then
    raise exception 'USER: Choose Accept or Reject.' using errcode = 'P0001';
  end if;

  select * into v_item from public.document_request_items where id = p_item_id for update;
  if not found then
    raise exception 'USER: That item no longer exists. Reload to see the request.' using errcode = 'P0001';
  end if;
  select * into v_req from public.document_requests where id = v_item.request_id;
  if p_expected_updated_at is not null and v_item.updated_at <> p_expected_updated_at then
    raise exception 'USER: This item was changed by someone else just now. Reload to see the latest.' using errcode = 'P0001';
  end if;
  if v_req.status = 'cancelled' then
    raise exception 'USER: This request has been cancelled. Reopen it first.' using errcode = 'P0001';
  end if;

  if p_decision = 'accept' then
    v_doc := coalesce(p_document_id, v_item.document_id);
    if v_doc is null then
      raise exception 'USER: Upload or link the file before accepting this item.' using errcode = 'P0001';
    end if;
    if not exists (
      select 1 from public.documents d where d.id = v_doc and d.client_id = v_req.client_id and d.deleted_at is null
    ) then
      raise exception 'USER: That file isn''t in this client''s vault any more.' using errcode = 'P0001';
    end if;
    update public.document_request_items
       set status = 'accepted', document_id = v_doc, rejection_reason = null
     where id = v_item.id
     returning * into v_item;
  else
    if v_reason is null then
      raise exception 'USER: Say why it''s rejected, so the client knows what to send instead.' using errcode = 'P0001';
    end if;
    if v_item.status not in ('uploaded', 'accepted') then
      raise exception 'USER: Nothing has been uploaded for this item yet.' using errcode = 'P0001';
    end if;
    update public.document_request_items
       set status = 'rejected', rejection_reason = left(v_reason, 500)
     where id = v_item.id
     returning * into v_item;
  end if;

  select status into v_request_status from public.document_requests where id = v_req.id;
  return jsonb_build_object(
    'item_id', v_item.id, 'item_status', v_item.status, 'item_title', v_item.title, 'updated_at', v_item.updated_at,
    'request_id', v_req.id, 'request_status', v_request_status, 'request_title', v_req.title,
    'client_id', v_req.client_id, 'document_id', v_item.document_id);
end;
$$;

comment on function public.review_document_request_item(uuid, text, text, uuid, timestamptz) is
  'Staff accept an uploaded request item (or link a vault document and accept it), or reject it with a reason (§7.14).';

-- =============================================================================================
-- Grants
-- =============================================================================================
revoke execute on function
  public.document_requests_status_stamp(),
  public.document_request_items_stamp(),
  public.document_request_items_sync()
from public, anon, authenticated;

revoke execute on function
  public.document_request_is_complete(uuid),
  public.sync_document_request_status(uuid),
  public.create_document_request(uuid, text, date, text, int, uuid, jsonb),
  public.review_document_request_item(uuid, text, text, uuid, timestamptz)
from public, anon;
grant execute on function
  public.document_request_is_complete(uuid),
  public.create_document_request(uuid, text, date, text, int, uuid, jsonb),
  public.review_document_request_item(uuid, text, text, uuid, timestamptz)
to authenticated, service_role;
-- The status upkeep is the triggers' (and the jobs'): no direct calls from the API.
revoke execute on function public.sync_document_request_status(uuid) from authenticated;
grant execute on function public.sync_document_request_status(uuid) to service_role;
