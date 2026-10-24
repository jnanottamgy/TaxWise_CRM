-- 0207 · Read models for the notices and litigation register (§7.8.4), so the register is searched,
-- sorted and paged in SQL (§2.3) and the derived states (reply overdue, next date, appeal open) are
-- computed here, never stored (§0.1 rule 10). Both security_invoker (the caller's RLS decides which
-- rows exist: Employees their own clients, §4.1) and SELECT-only for the API roles.
--
--   tax_notices_list        every notice with its client, the people, the appeal task, the counts of
--                           log lines and attachments, and the derived dates and flags
--   tax_notice_notes_list   the log with its author's name

set search_path = public, extensions;

create or replace view public.tax_notices_list with (security_invoker = true) as
with base as (
  select
    n.*,
    public.today_ist() as today,
    (n.hearing_date at time zone 'Asia/Kolkata')::date as hearing_on,
    n.status in ('closed_favourable', 'closed_unfavourable', 'closed_partial') as is_closed,
    n.status in ('open', 'reply_drafted') as reply_pending
  from public.tax_notices n
)
select
  b.id,
  b.client_id,
  c.display_name as client_name,
  c.client_code::text as client_code,
  c.pan::text as client_pan,
  c.gstin::text as client_gstin,
  c.owner_employee_id as client_owner_employee_id,
  b.notice_type,
  b.tax_area,
  b.section,
  b.authority,
  b.reference_no,
  b.financial_year,
  b.notice_date,
  b.received_date,
  b.reply_due_date,
  b.hearing_date,
  b.hearing_on,
  b.status,
  b.demand_amount,
  b.description,
  b.assigned_employee_id,
  ae.full_name as assigned_name,
  ae.profile_id as assigned_profile_id,
  b.replied_on,
  b.closed_at,
  b.closed_by,
  cl.full_name as closed_by_name,
  b.order_date,
  b.appeal_decision,
  b.appeal_note,
  b.appeal_forum,
  b.limitation_date,
  b.limitation_manual,
  b.appeal_task_id,
  t.task_number as appeal_task_number,
  t.status as appeal_task_status,
  b.created_by,
  cb.full_name as created_by_name,
  b.updated_by,
  ub.full_name as updated_by_name,
  b.created_at,
  b.updated_at,
  b.is_closed,
  b.reply_pending,
  (b.reply_pending and b.reply_due_date < b.today) as reply_overdue,
  case when b.reply_pending then b.reply_due_date - b.today end as days_to_reply,
  (not b.is_closed and b.hearing_on is not null and b.hearing_on >= b.today) as hearing_upcoming,
  (b.appeal_decision = 'appeal' and b.limitation_date is not null and coalesce(t.status::text, '') <> 'filed_done') as appeal_open,
  case when b.appeal_decision = 'appeal' and b.limitation_date is not null and coalesce(t.status::text, '') <> 'filed_done'
    then b.limitation_date - b.today end as days_to_limitation,
  -- The next date someone has to act on: the reply while one is pending, the hearing while it is
  -- ahead, the limitation date while an appeal is still to be filed.
  (select min(d) from unnest(array[
      case when b.reply_pending then b.reply_due_date end,
      case when not b.is_closed and b.hearing_on >= b.today then b.hearing_on end,
      case when b.appeal_decision = 'appeal' and coalesce(t.status::text, '') <> 'filed_done' then b.limitation_date end
    ]) d) as next_action_date,
  coalesce(nc.notes_count, 0) as notes_count,
  nc.last_noted_on,
  coalesce(dc.documents_count, 0) as documents_count
from base b
join public.clients c on c.id = b.client_id
left join public.employee_directory ae on ae.id = b.assigned_employee_id
left join public.employee_directory cb on cb.profile_id = b.created_by
left join public.employee_directory ub on ub.profile_id = b.updated_by
left join public.employee_directory cl on cl.profile_id = b.closed_by
left join public.tasks t on t.id = b.appeal_task_id and t.deleted_at is null
left join lateral (
  select count(*)::int as notes_count, max(x.noted_on) as last_noted_on
  from public.tax_notice_notes x where x.notice_id = b.id
) nc on true
left join lateral (
  select count(*)::int as documents_count
  from public.tax_notice_documents d
  join public.documents dd on dd.id = d.document_id and dd.deleted_at is null
  where d.notice_id = b.id
) dc on true
where c.deleted_at is null;

comment on view public.tax_notices_list is
  'Notices with client, people, appeal task and derived states: reply overdue, days to reply, upcoming hearing, appeal open, days to limitation and the next action date (§7.8.4). Derived, never stored.';

create or replace view public.tax_notice_notes_list with (security_invoker = true) as
select
  x.id,
  x.notice_id,
  x.client_id,
  x.noted_on,
  x.kind,
  x.body,
  x.author_id,
  a.full_name as author_name,
  x.created_at
from public.tax_notice_notes x
left join public.employee_directory a on a.profile_id = x.author_id;

comment on view public.tax_notice_notes_list is 'A notice''s running log with each line''s author (§7.8.4).';

revoke all on public.tax_notices_list, public.tax_notice_notes_list from anon, public;
revoke insert, update, delete, truncate, references, trigger on public.tax_notices_list, public.tax_notice_notes_list from authenticated;
grant select on public.tax_notices_list, public.tax_notice_notes_list to authenticated, service_role;
