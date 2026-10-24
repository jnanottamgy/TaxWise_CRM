-- 0222 · The client list can show Firm today's at-risk clients (§7.2 "every tile links to the
-- filtered list behind it"; wave C integration).
--
-- Firm today (dashboard_firm_today, 0216) lists clients with 3 or more overdue tasks or receivables
-- over 90 days. clients_list (0110) had the overdue task count but not the receivables age, so the
-- card couldn't open its full list. clients_list gains one column at the end:
--   has_aged_receivables  an issued invoice (Sent, Partially paid or Disputed, not cancelled or
--                         deleted) with money still owed, issued more than 90 days ago; null for
--                         Employees, like has_overdue_invoices (§4.1).
-- The client list's ?flag=at_risk reads overdue_tasks >= 3 or has_aged_receivables (lib/data/clients.ts).
-- Otherwise the view is exactly 0110's: security_invoker, SELECT-only.

set search_path = public, extensions;

create or replace view public.clients_list with (security_invoker = true) as
select
  c.id,
  c.client_code,
  c.display_name,
  c.legal_name,
  c.entity_type,
  c.entity_type_other,
  c.pan,
  c.gstin,
  c.tan,
  c.gst_registration,
  c.gst_scheme,
  public.effective_gst_scheme(
    c.gst_registration, c.gst_scheme, c.annual_turnover,
    (select public.jsonb_to_numeric(public.statutory_param_value('gst.qrmp_turnover_limit', public.today_ist())))
  ) as effective_gst_scheme,
  c.state_code,
  c.email,
  c.phone,
  c.whatsapp,
  c.city,
  c.status,
  c.priority,
  c.owner_employee_id,
  o.full_name as owner_name,
  c.group_id,
  g.name::text as group_name,
  c.annual_turnover,
  c.turnover_fy,
  c.onboarded_at,
  c.created_at,
  c.updated_at,
  c.deleted_at,
  (c.portal_user_id is not null) as has_portal,
  c.portal_invited_at,
  coalesce(s.service_types, '{}'::public.service_type[]) as service_types,
  d.next_due_date,
  d.next_due_title,
  coalesce(t.open_tasks, 0)::int as open_tasks,
  coalesce(t.overdue_tasks, 0)::int as overdue_tasks,
  case when public.is_manager_or_partner() then coalesce(i.outstanding, 0) end as outstanding,
  case when public.is_manager_or_partner() then coalesce(i.overdue_invoices, 0) > 0 end as has_overdue_invoices,
  m.last_contact_at,
  coalesce(w.status, 'none') as whatsapp_group_status,
  (
    nullif(btrim(c.email::text), '') is null
    and nullif(btrim(c.phone), '') is null
    and nullif(btrim(c.whatsapp), '') is null
    and not exists (
      select 1 from public.client_contacts cc
      where cc.client_id = c.id
        and (nullif(btrim(cc.email::text), '') is not null or nullif(btrim(cc.phone), '') is not null or nullif(btrim(cc.whatsapp), '') is not null)
    )
  ) as unreachable,
  exists (
    select 1 from public.covers_in_force f
    where (f.kind = 'client' and f.client_id = c.id)
       or (f.kind = 'person' and (
            f.absent_employee_id = c.owner_employee_id
            or exists (select 1 from public.client_team_members tm where tm.client_id = c.id and tm.employee_id = f.absent_employee_id)
          ))
  ) as covered_now,
  -- 0222: money still owed on an invoice issued more than 90 days ago (Partners and Managers only),
  -- the receivables half of Firm today's "at-risk clients" (0216).
  case when public.is_manager_or_partner() then coalesce(i.aged_invoices, 0) > 0 end as has_aged_receivables
from public.clients c
left join public.employee_directory o on o.id = c.owner_employee_id
left join public.client_groups g on g.id = c.group_id
left join lateral (
  select array_agg(distinct sp.service_type order by sp.service_type) as service_types
  from public.client_services_public sp
  where sp.client_id = c.id and sp.is_active
) s on true
left join lateral (
  select e.due_date as next_due_date, e.title as next_due_title
  from public.compliance_events e
  where e.client_id = c.id and e.status = 'pending'
  order by e.due_date, e.title
  limit 1
) d on true
left join lateral (
  select
    count(*) filter (where tk.status <> 'filed_done') as open_tasks,
    count(*) filter (where tk.status <> 'filed_done' and tk.due_date < public.today_ist()) as overdue_tasks
  from public.tasks tk
  where tk.client_id = c.id and tk.deleted_at is null
) t on true
left join lateral (
  select
    sum(inv.outstanding_amount) as outstanding,
    count(*) filter (where inv.status in ('sent', 'partially_paid') and inv.outstanding_amount > 0 and inv.due_date < public.today_ist()) as overdue_invoices,
    count(*) filter (where inv.outstanding_amount > 0 and public.today_ist() - inv.issue_date > 90) as aged_invoices
  from public.invoices inv
  where inv.client_id = c.id
    and inv.deleted_at is null
    and inv.cancelled_at is null
    and inv.status in ('sent', 'partially_paid', 'disputed')
) i on true
left join lateral (
  select max(coalesce(ms.sent_at, ms.created_at)) as last_contact_at
  from public.messages ms
  where ms.client_id = c.id
) m on true
left join lateral (
  select wg.status::text as status
  from public.client_whatsapp_groups_public wg
  where wg.client_id = c.id and wg.deleted_at is null
  order by (wg.status <> 'closed') desc, wg.is_primary desc, wg.created_at desc
  limit 1
) w on true;

comment on view public.clients_list is
  'The client list (§7.3.1): owner, group, services, next deadline, open/overdue tasks, outstanding and aged receivables (Partner/Manager only), last contact, portal, WhatsApp group, unreachable, covered now. security_invoker: the caller''s RLS.';

revoke all on public.clients_list from anon, public;
revoke insert, update, delete, truncate, references, trigger on public.clients_list from authenticated;
grant select on public.clients_list to authenticated, service_role;
