-- 0183 · Views for the WhatsApp groups page and Settings → WhatsApp → Linked PCs (§7.25.1, §7.25.7,
-- §7.21). Both are security_invoker (the caller's RLS applies) and SELECT-only for the API roles.
--
--   whatsapp_group_register   one row per group (not deleted, client not deleted) with its status,
--                             members, admins, checklist progress and who opened it last; plus one
--                             row per active or on-hold client that has no group at all (status
--                             'none', "No group yet"). Partners and Managers only (and the service
--                             role for jobs): the WHERE clause says so, because an Employee's RLS
--                             would show their clients as having no group.
--   desktop_devices_overview  each PC with its active number links (label, kind, when, by whom), its
--                             last user's name and its failing client-mode checks. Partners and
--                             Managers (desktop_devices RLS, §4.6).

set search_path = public, extensions;

create or replace view public.whatsapp_group_register with (security_invoker = true) as
select
  g.id as row_id,
  g.id as group_id,
  c.id as client_id,
  c.client_code::text as client_code,
  c.display_name as client_name,
  c.status::text as client_status,
  c.onboarded_at,
  ep.engagement_partner_id,
  ep.engagement_partner_name,
  g.name as group_name,
  g.purpose,
  g.is_primary,
  g.status::text as status,
  case g.status when 'to_create' then 1 when 'active' then 2 else 3 end as status_rank,
  g.created_on,
  g.closed_at,
  g.closed_reason,
  g.last_opened_at,
  g.last_opened_by,
  op.full_name as last_opened_by_name,
  coalesce(m.members, 0) as member_count,
  coalesce(m.admins, 0) as admin_count,
  coalesce(m.firm_number_ids, '{}'::uuid[]) as firm_number_ids,
  coalesce(m.member_names, '{}'::text[]) as member_names,
  (
    select count(*)::int
    from jsonb_each(case when jsonb_typeof(g.checklist) = 'object' then g.checklist else '{}'::jsonb end) e
    where e.key = any (public.whatsapp_checklist_steps())
      and jsonb_typeof(e.value) = 'object'
      and e.value ->> 'done' = 'true'
  ) as checklist_done,
  g.updated_at
from public.client_whatsapp_groups g
join public.clients c on c.id = g.client_id and c.deleted_at is null
left join lateral (
  select
    count(*)::int as members,
    (count(*) filter (where mm.is_admin))::int as admins,
    array_agg(mm.firm_number_id order by mm.firm_number_id) filter (where mm.firm_number_id is not null) as firm_number_ids,
    array_agg(mm.display_name order by (mm.kind <> 'firm_number'), mm.display_name) as member_names
  from public.client_whatsapp_group_members mm
  where mm.group_id = g.id and mm.removed_on is null
) m on true
left join public.profiles op on op.id = g.last_opened_by
left join lateral (
  select tm.employee_id as engagement_partner_id, e.full_name as engagement_partner_name
  from public.client_team_members tm
  join public.employees e on e.id = tm.employee_id
  where tm.client_id = c.id and tm.team_role = 'engagement_partner'
  order by tm.created_at
  limit 1
) ep on true
where g.deleted_at is null
  and (public.is_manager_or_partner() or not public.is_api_caller())
union all
select
  c.id as row_id,
  null::uuid as group_id,
  c.id as client_id,
  c.client_code::text,
  c.display_name,
  c.status::text,
  c.onboarded_at,
  ep.engagement_partner_id,
  ep.engagement_partner_name,
  null::text,
  null::text,
  false,
  'none',
  0,
  null::date,
  null::timestamptz,
  null::text,
  null::timestamptz,
  null::uuid,
  null::text,
  0,
  0,
  '{}'::uuid[],
  '{}'::text[],
  0,
  c.updated_at
from public.clients c
left join lateral (
  select tm.employee_id as engagement_partner_id, e.full_name as engagement_partner_name
  from public.client_team_members tm
  join public.employees e on e.id = tm.employee_id
  where tm.client_id = c.id and tm.team_role = 'engagement_partner'
  order by tm.created_at
  limit 1
) ep on true
where c.deleted_at is null
  and c.status in ('active', 'on_hold')
  and (public.is_manager_or_partner() or not public.is_api_caller())
  and not exists (select 1 from public.client_whatsapp_groups g where g.client_id = c.id and g.deleted_at is null);

comment on view public.whatsapp_group_register is
  'The WhatsApp groups page (§7.25.1): every group with status, members, checklist progress and last opened, plus active/on-hold clients with no group (status none). Partners/Managers; security_invoker.';

create or replace view public.desktop_devices_overview with (security_invoker = true) as
select
  d.id,
  d.device_name,
  d.os,
  d.app_version,
  d.last_user_id,
  lu.full_name as last_user_name,
  d.last_seen_at,
  d.revoked_at,
  d.revoked_by,
  rb.full_name as revoked_by_name,
  d.renamed_at,
  d.failing_checks,
  d.last_health_alert_at,
  d.created_at,
  d.updated_at,
  coalesce(l.links, '[]'::jsonb) as links,
  coalesce(l.link_count, 0) as link_count
from public.desktop_devices d
left join public.profiles lu on lu.id = d.last_user_id
left join public.profiles rb on rb.id = d.revoked_by
left join lateral (
  select
    jsonb_agg(jsonb_build_object(
      'link_id', dn.id,
      'number_id', n.id,
      'label', n.label,
      'kind', n.kind,
      'linked_at', dn.linked_at,
      'linked_by', dn.linked_by,
      'linked_by_name', lb.full_name
    ) order by n.label) as links,
    count(*)::int as link_count
  from public.desktop_device_numbers dn
  join public.firm_whatsapp_numbers n on n.id = dn.number_id
  left join public.profiles lb on lb.id = dn.linked_by
  where dn.device_id = d.id and dn.unlinked_at is null
) l on true;

comment on view public.desktop_devices_overview is
  'Settings → WhatsApp → Linked PCs (§7.25.7): each PC with its active number links, last user and last seen. Partners/Managers (desktop_devices RLS); security_invoker.';

-- SELECT-only for the API roles (0043 §1), nothing for anon.
revoke insert, update, delete, truncate, references, trigger on public.whatsapp_group_register, public.desktop_devices_overview from public, anon, authenticated;
revoke all on public.whatsapp_group_register, public.desktop_devices_overview from anon;
grant select on public.whatsapp_group_register, public.desktop_devices_overview to authenticated, service_role;
