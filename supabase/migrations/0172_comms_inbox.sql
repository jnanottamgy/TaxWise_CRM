-- 0172 · The Inbox (§7.17): "Needs your action" and "Updates".
--
--   inbox_action_items (view, security invoker)  what is waiting for the signed-in person right now,
--       derived from the records themselves, so an item leaves the list the moment it is dealt with
--       (by anyone) and never goes stale the way a notification can. One row per item:
--         invoice_approval    invoices held for a Partner's approval (§7.9.2)            Partners
--         quotation_approval  quotations pending approval (§7.5.2)                       Partners
--         leave_approval      leave waiting for its approver (§7.11.3): Partners decide
--                             everyone's but their own, Managers decide Employees'         Partners, Managers
--         review              tasks Under review with the person as named reviewer, or
--                             with no named reviewer for Managers (§9)                     reviewer / Managers
--         acceptance          tasks assigned to the person, waiting for them to accept     the assignee
--         declined            declined tasks back with nobody on them, to reassign: the
--                             assigner and every Manager (§7.6.3, §9)                      assigner, Managers
--         client_message      a client's unread portal messages, one row per client, for
--                             its owner and team (a client with nobody active on it falls
--                             to Partners and Managers) (§9)                              owner + team
--         data_request        open DPDP data requests (§6.10)                             Partners
--       It runs under the caller's RLS as well as these filters: an Employee never gets a money row
--       (invoices, quotations: RLS refuses them, and their branches are Partner-only), and sees
--       client messages only for clients they can see. `amount` is filled only on the Partner-only
--       approval rows.
--   inbox_notifications (view, security invoker)  the caller's notifications with `needs_action`:
--       true while the record it is about is still on their action list. The Inbox shows those as
--       "new" on the action item and keeps them out of Updates, so nothing is listed twice; once the
--       item is dealt with the notification drops into Updates as history.

set search_path = public, extensions;

create or replace view public.inbox_action_items with (security_invoker = true) as
-- Approvals: invoices held over the limit (§7.9.2). invoice_number is empty until issue.
select
  'invoice_approval'::text as kind,
  'invoice'::text as entity_type,
  i.id as entity_id,
  i.client_id,
  c.display_name as client_name,
  i.invoice_number as reference,
  i.billing_period_label as title,
  rb.full_name as person_name,
  i.total_amount as amount,
  i.due_date,
  i.updated_at as since,
  null::text as reason,
  i.approval_note as note,
  null::integer as item_count,
  '/invoices/' || i.id::text as link_url
from public.invoices i
join public.clients c on c.id = i.client_id
left join public.employee_directory rb on rb.profile_id = i.created_by
where (select public.is_partner())
  and i.status = 'awaiting_approval'
  and i.deleted_at is null
  and i.cancelled_at is null

union all
-- Approvals: quotations over the quotation approval limit (§7.5.2).
select
  'quotation_approval',
  'quotation',
  q.id,
  q.client_id,
  coalesce(nullif(btrim(q.client_company), ''), q.client_name),
  q.quotation_number,
  null::text,
  rb.full_name,
  q.total,
  q.valid_until,
  q.updated_at,
  null::text,
  q.approval_note,
  null::integer,
  '/quotations/' || q.id::text
from public.quotations q
left join public.employee_directory rb on rb.profile_id = q.created_by
where (select public.is_partner())
  and q.status = 'pending_approval'
  and q.deleted_at is null

union all
-- Approvals: leave requests (§7.11.3). Nobody decides their own.
select
  'leave_approval',
  'employee_leave',
  l.id,
  null::uuid,
  null::text,
  null::text,
  l.type::text,
  e.full_name,
  null::numeric,
  l.start_date,
  l.created_at,
  case when l.half_day then 'half_day' end,
  l.reason,
  (l.end_date - l.start_date + 1)::integer,
  '/leave?status=requested'
from public.employee_leave l
join public.employees e on e.id = l.employee_id
left join public.profiles p on p.id = e.profile_id
where (select public.is_manager_or_partner())
  and l.status = 'requested'
  and l.employee_id is distinct from (select public.staff_employee_id())
  and ((select public.is_partner()) or p.role = 'employee')

union all
-- Review requests: Under review with you as the named reviewer; with no reviewer, Managers (§9).
select
  'review',
  'task',
  t.id,
  t.client_id,
  c.display_name,
  t.task_number,
  t.title,
  ad.full_name,
  null::numeric,
  t.due_date,
  coalesce(h.changed_at, t.updated_at),
  null::text,
  null::text,
  null::integer,
  '/work/' || t.id::text
from public.tasks t
join public.clients c on c.id = t.client_id
left join public.employee_directory ad on ad.id = t.assigned_employee_id
left join lateral (
  select max(sh.changed_at) as changed_at
  from public.task_status_history sh
  where sh.task_id = t.id and sh.to_status = 'under_review'
) h on true
where t.status = 'under_review'
  and t.deleted_at is null
  and c.deleted_at is null
  and (
    t.reviewer_employee_id = (select public.staff_employee_id())
    or (t.reviewer_employee_id is null and (select public.app_role()) = 'manager')
  )

union all
-- Tasks waiting for you to accept them (§7.6.3).
select
  'acceptance',
  'task',
  t.id,
  t.client_id,
  c.display_name,
  t.task_number,
  t.title,
  ab.full_name,
  null::numeric,
  t.due_date,
  coalesce(t.assigned_at, t.created_at),
  null::text,
  null::text,
  null::integer,
  '/work/' || t.id::text
from public.tasks t
join public.clients c on c.id = t.client_id
left join public.employee_directory ab on ab.profile_id = t.assigned_by
where t.assigned_employee_id = (select public.staff_employee_id())
  and t.acceptance_status = 'pending'
  and t.status <> 'filed_done'
  and t.deleted_at is null
  and c.deleted_at is null

union all
-- Declined tasks to reassign: the assigner and every Manager (§7.6.3, §9 "Task declined").
select
  'declined',
  'task',
  t.id,
  t.client_id,
  c.display_name,
  t.task_number,
  t.title,
  dd.full_name,
  null::numeric,
  t.due_date,
  coalesce(t.declined_at, t.updated_at),
  t.decline_reason::text,
  t.decline_note,
  null::integer,
  '/work/' || t.id::text
from public.tasks t
join public.clients c on c.id = t.client_id
left join public.employee_directory dd on dd.id = t.declined_by_employee_id
where (select public.is_manager_or_partner())
  and t.acceptance_status = 'declined'
  and t.assigned_employee_id is null
  and t.status <> 'filed_done'
  and t.deleted_at is null
  and c.deleted_at is null
  and (t.assigned_by = (select auth.uid()) or (select public.app_role()) = 'manager')

union all
-- Client messages: unread portal messages, one row per client, for its owner and team (§9).
select
  'client_message',
  'client_messages',
  c.id,
  c.id,
  c.display_name,
  c.client_code::text,
  lm.subject,
  null::text,
  null::numeric,
  null::date,
  u.last_at,
  null::text,
  left(lm.body, 200),
  u.unread::integer,
  '/messages?client=' || c.id::text
from (
  select m.client_id, count(*) as unread, max(m.created_at) as last_at
  from public.messages m
  where m.channel = 'portal' and m.direction = 'inbound' and m.read_at is null
  group by m.client_id
) u
join public.clients c on c.id = u.client_id
left join lateral (
  select m2.subject, m2.body
  from public.messages m2
  where m2.client_id = u.client_id and m2.channel = 'portal' and m2.direction = 'inbound' and m2.read_at is null
  order by m2.created_at desc
  limit 1
) lm on true
where c.deleted_at is null
  and (select public.is_staff())
  and (
    -- Employees reach only the clients they can see (RLS on messages): their own, their team's, covers.
    (select public.app_role()) = 'employee'
    or c.owner_employee_id = (select public.staff_employee_id())
    or exists (
      select 1 from public.client_team_members tm
      where tm.client_id = c.id and tm.employee_id = (select public.staff_employee_id())
    )
    or (
      -- Nobody active on the client: Partners and Managers pick it up.
      not exists (
        select 1 from public.employee_directory od
        where od.id = c.owner_employee_id and od.is_active
      )
      and not exists (
        select 1 from public.client_team_members tm2
        join public.employee_directory td on td.id = tm2.employee_id and td.is_active
        where tm2.client_id = c.id
      )
    )
  )

union all
-- DPDP data requests (§6.10, §9 "Data request received → Partners").
select
  'data_request',
  'data_request',
  d.id,
  null::uuid,
  null::text,
  d.type,
  d.subject,
  null::text,
  null::numeric,
  d.due_by,
  d.received_at,
  d.status,
  null::text,
  null::integer,
  '/quality?tab=data-requests'
from public.data_requests d
where (select public.is_partner())
  and d.status not in ('closed', 'completed', 'resolved', 'rejected', 'withdrawn');

comment on view public.inbox_action_items is
  'What waits for the signed-in person right now (§7.17 Needs your action): approvals, reviews, acceptance, declined tasks, client messages, data requests. Derived, under the caller''s RLS.';

create or replace view public.inbox_notifications with (security_invoker = true) as
select
  n.id,
  n.user_id,
  n.type,
  n.title,
  n.body,
  n.link_url,
  n.entity_type,
  n.entity_id,
  n.read_at,
  n.archived_at,
  n.emailed_at,
  n.created_at,
  (
    n.entity_id is not null
    and exists (
      select 1 from public.inbox_action_items a
      where a.entity_type = n.entity_type and a.entity_id = n.entity_id
    )
  ) as needs_action
from public.notifications n
where n.user_id = (select auth.uid());

comment on view public.inbox_notifications is
  'The caller''s notifications, with needs_action while the record is still on their action list (§7.17).';

revoke all on public.inbox_action_items, public.inbox_notifications from anon, public;
revoke insert, update, delete, truncate, references, trigger on public.inbox_action_items, public.inbox_notifications from authenticated;
grant select on public.inbox_action_items, public.inbox_notifications to authenticated, service_role;

-- Lookups the action list makes.
create index if not exists tasks_reviewer_under_review_idx on public.tasks (reviewer_employee_id) where status = 'under_review' and deleted_at is null;
create index if not exists tasks_declined_unassigned_idx on public.tasks (declined_at) where acceptance_status = 'declined' and assigned_employee_id is null and deleted_at is null;
create index if not exists task_status_history_task_to_idx on public.task_status_history (task_id, to_status, changed_at desc);
