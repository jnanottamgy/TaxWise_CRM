-- 0171 · Inbox actions on notifications (§7.17: "Every notification … can be marked read/unread,
-- archived or deleted. 'Mark all read'"). Each runs as the caller (security invoker): RLS lets a
-- person touch only their own notifications (0039), and notifications_guard lets them change only
-- read_at and archived_at.
--
--   mark_notifications(ids, action)        action read | unread | archived | unarchived; returns how
--                                          many changed (rows already in that state don't count).
--   mark_all_notifications_read()          every unread, unarchived notification of the caller.
--   mark_entity_notifications_read(type, id)  the caller's unread notifications about one record,
--                                          when they open it from "Needs your action".

set search_path = public, extensions;

create or replace function public.mark_notifications(p_ids uuid[], p_action text)
returns integer
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_count integer;
begin
  if v_uid is null then
    raise exception 'USER: Your session has ended. Please sign in again.' using errcode = 'P0001';
  end if;
  if p_action is null or p_action not in ('read', 'unread', 'archived', 'unarchived') then
    raise exception 'USER: Choose read, unread, archive or move back to the inbox.' using errcode = 'P0001';
  end if;
  if p_ids is null or cardinality(p_ids) = 0 then
    return 0;
  end if;
  if cardinality(p_ids) > 500 then
    raise exception 'USER: Choose at most 500 notifications at a time.' using errcode = 'P0001';
  end if;

  update public.notifications n
     set read_at = case p_action when 'read' then now() when 'unread' then null else n.read_at end,
         archived_at = case p_action when 'archived' then now() when 'unarchived' then null else n.archived_at end
   where n.id = any (p_ids)
     and n.user_id = v_uid
     and case p_action
           when 'read' then n.read_at is null
           when 'unread' then n.read_at is not null
           when 'archived' then n.archived_at is null
           else n.archived_at is not null
         end;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.mark_notifications(uuid[], text) is
  'Marks the caller''s notifications read, unread, archived or back in the inbox; returns how many changed (§7.17).';

create or replace function public.mark_all_notifications_read()
returns integer
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_count integer;
begin
  if v_uid is null then
    raise exception 'USER: Your session has ended. Please sign in again.' using errcode = 'P0001';
  end if;
  update public.notifications n
     set read_at = now()
   where n.user_id = v_uid and n.read_at is null and n.archived_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.mark_all_notifications_read() is 'Marks every unread notification in the caller''s inbox read (§7.17 "Mark all read").';

create or replace function public.mark_entity_notifications_read(p_entity_type text, p_entity_id uuid)
returns integer
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_count integer;
begin
  if v_uid is null then
    raise exception 'USER: Your session has ended. Please sign in again.' using errcode = 'P0001';
  end if;
  if p_entity_type is null or p_entity_id is null then
    return 0;
  end if;
  update public.notifications n
     set read_at = now()
   where n.user_id = v_uid and n.read_at is null and n.entity_type = p_entity_type and n.entity_id = p_entity_id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.mark_entity_notifications_read(text, uuid) is
  'Marks the caller''s unread notifications about one record read, when they open it from the Inbox (§7.17).';

revoke execute on function
  public.mark_notifications(uuid[], text),
  public.mark_all_notifications_read(),
  public.mark_entity_notifications_read(text, uuid)
from public, anon;
grant execute on function
  public.mark_notifications(uuid[], text),
  public.mark_all_notifications_read(),
  public.mark_entity_notifications_read(text, uuid)
to authenticated;

-- The Inbox lists a person's notifications newest first, inbox and archive separately.
create index if not exists notifications_user_archived_created_idx on public.notifications (user_id, (archived_at is null), created_at desc);
