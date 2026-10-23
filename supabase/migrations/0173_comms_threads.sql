-- 0173 · Staff message threads (§7.13.1 "Every channel writes to messages … so the Communication
-- tab shows one complete history", §7.22 portal read receipts, /messages).
--
--   message_thread_reads   per person and client: when they last opened the client's thread
--                          (the "Seen by" line and the "new since you last looked" marker). A person
--                          writes only their own row; staff who can see the client read the rows.
--   mark_thread_read(client)  run when a staff member opens a thread: stamps their row and marks the
--                          client's unread portal messages read (messages.read_at, the firm's read
--                          receipt the client sees), returning how many it marked. Security invoker:
--                          an Employee can do it only for a client they can see, and never touches a
--                          money-side message (RLS, 0043).
--   message_threads (view, security invoker)  one row per client with messages: the latest
--                          message, how many portal messages are unread (has_unread sorts them
--                          first), and when the caller last opened it. Under the caller's RLS, so an
--                          Employee lists only their clients and never sees a message about money.

set search_path = public, extensions;

create table if not exists public.message_thread_reads (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  last_read_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint message_thread_reads_client_user_key unique (client_id, user_id)
);
alter table public.message_thread_reads enable row level security;

comment on table public.message_thread_reads is 'When each staff member last opened a client''s message thread (/messages, Client 360 → Communication).';

drop trigger if exists set_updated_at on public.message_thread_reads;
create trigger set_updated_at before insert or update on public.message_thread_reads
  for each row execute function public.set_updated_at();

create index if not exists message_thread_reads_user_idx on public.message_thread_reads (user_id);

drop policy if exists message_thread_reads_select on public.message_thread_reads;
create policy message_thread_reads_select on public.message_thread_reads
  for select to authenticated
  using (
    (select public.is_staff())
    and ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()))
  );
drop policy if exists message_thread_reads_insert on public.message_thread_reads;
create policy message_thread_reads_insert on public.message_thread_reads
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (select public.is_staff())
    and ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()))
  );
drop policy if exists message_thread_reads_update on public.message_thread_reads;
create policy message_thread_reads_update on public.message_thread_reads
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and (select public.is_staff())
    and ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()))
  );
revoke delete, truncate on public.message_thread_reads from authenticated, anon;
revoke all on public.message_thread_reads from anon;

-- ---------------------------------------------------------------------------------------------
-- mark_thread_read
-- ---------------------------------------------------------------------------------------------
create or replace function public.mark_thread_read(p_client_id uuid)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_marked integer := 0;
  v_now timestamptz := now();
begin
  if v_uid is null or not public.is_staff() then
    raise exception 'USER: Only the firm''s staff open client threads.' using errcode = 'P0001';
  end if;
  if p_client_id is null or not public.can_see_client(p_client_id) then
    raise exception 'USER: Not one of your clients.' using errcode = 'P0001';
  end if;

  insert into public.message_thread_reads (client_id, user_id, last_read_at)
  values (p_client_id, v_uid, v_now)
  on conflict (client_id, user_id) do update set last_read_at = excluded.last_read_at;

  update public.messages m
     set read_at = v_now
   where m.client_id = p_client_id
     and m.channel = 'portal'
     and m.direction = 'inbound'
     and m.read_at is null;
  get diagnostics v_marked = row_count;

  return jsonb_build_object('marked', v_marked, 'last_read_at', v_now);
end;
$$;

comment on function public.mark_thread_read(uuid) is
  'A staff member opened a client''s thread: stamps their read row and marks the client''s unread portal messages read (§7.22 read receipts).';

revoke execute on function public.mark_thread_read(uuid) from public, anon;
grant execute on function public.mark_thread_read(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- message_threads
-- ---------------------------------------------------------------------------------------------
create or replace view public.message_threads with (security_invoker = true) as
select
  c.id as client_id,
  c.display_name as client_name,
  c.client_code::text as client_code,
  c.status as client_status,
  c.owner_employee_id,
  (c.portal_user_id is not null) as on_portal,
  l.id as last_message_id,
  l.channel as last_channel,
  l.direction as last_direction,
  l.status as last_status,
  l.subject as last_subject,
  left(l.body, 200) as last_preview,
  l.sent_by as last_sent_by,
  l.created_at as last_at,
  coalesce(u.unread, 0)::integer as unread_count,
  coalesce(u.unread, 0) > 0 as has_unread,
  r.last_read_at as my_last_read_at,
  (l.sent_by is distinct from (select auth.uid()) and (r.last_read_at is null or l.created_at > r.last_read_at)) as new_for_me
from public.clients c
join lateral (
  select m.id, m.channel, m.direction, m.status, m.subject, m.body, m.sent_by, m.created_at
  from public.messages m
  where m.client_id = c.id
  order by m.created_at desc, m.id desc
  limit 1
) l on true
left join lateral (
  select count(*) as unread
  from public.messages m
  where m.client_id = c.id and m.channel = 'portal' and m.direction = 'inbound' and m.read_at is null
) u on true
left join public.message_thread_reads r on r.client_id = c.id and r.user_id = (select auth.uid())
where c.deleted_at is null
  and (select public.is_staff());

comment on view public.message_threads is
  'One row per client with messages: the latest one, unread portal messages, and when the caller last opened it (/messages). Under the caller''s RLS.';

revoke all on public.message_threads from anon, public;
revoke insert, update, delete, truncate, references, trigger on public.message_threads from authenticated;
grant select on public.message_threads to authenticated, service_role;
