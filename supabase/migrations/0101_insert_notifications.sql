-- 0101 · Sending notifications (§4.1, §4.7, §9, §7.17).
--
--   is_money_notification(type, entity_type, link)  a notice about fees, invoices, receipts,
--       quotations, leads or engagement letters: by its type (invoice_overdue,
--       invoice_awaiting_approval, payment_received, quotation_viewed, quotation_responded), by the
--       entity it is about (money_side_kind, 0043), or by the page it links to (/invoices,
--       /quotations, /leads, /payments …).
--   insert_notifications(...)  what server/notify.ts calls. Resolves the recipients and writes one
--       row each, which RLS on notifications can't do for a caller who may not read the people it
--       notifies:
--         * recipients: profile ids, every active Partner and/or Manager, employee ids;
--         * cover forwarding (§4.7, §9 "Any notification about a covered client: also the cover
--           person, while the cover is in force"): when the notice is about a client and goes to
--           the absent person of a cover in force for that client (a client cover, whose absent
--           person defaults to the client's owner; or a person cover for someone who owns the client
--           or is on its team), the cover person gets it too;
--         * money notices never reach an Employee, not even a cover person (§4.1 beats §9); portal
--           users only get notices about their own client that link into /portal;
--         * disabled people, and the person who did the thing (p_exclude_user_id), get nothing;
--         * a dedupe key makes a retried job notify once (0100).
--       Callers: the service role (jobs, webhooks, the public quotation page) and signed-in users
--       through the server. Staff notify staff (as RLS on notifications already allows) and reach a
--       client's portal user only for a client they can see; a portal user only sends
--       document_uploaded / info / payment_received about their own client. security_alert comes
--       only from the service role (and report_role_claim).

set search_path = public, extensions;

create or replace function public.is_money_notification(p_type public.notification_type, p_entity_type text, p_link_url text)
returns boolean
language sql
immutable
set search_path = public, extensions
as $$
  select coalesce(p_type in ('invoice_overdue', 'invoice_awaiting_approval', 'payment_received', 'quotation_viewed', 'quotation_responded'), false)
      or public.money_side_kind(p_entity_type)
      or coalesce(p_link_url, '') ~ '^/(invoices|payments|quotations|leads|acceptance|fee-realisation|revenue|tds-credits|retainer-drafts|engagement-letters|reports)([/?#]|$)'
$$;

comment on function public.is_money_notification(public.notification_type, text, text) is
  'True for a notice about fees, invoices, receipts, quotations, leads or engagement letters (by type, entity or link). Employees never get these (§4.1).';

revoke execute on function public.is_money_notification(public.notification_type, text, text) from public, anon;
grant execute on function public.is_money_notification(public.notification_type, text, text) to authenticated, service_role;

create or replace function public.insert_notifications(
  p_type public.notification_type,
  p_title text,
  p_body text,
  p_link_url text,
  p_user_ids uuid[] default null,
  p_roles public.app_role[] default null,
  p_employee_ids uuid[] default null,
  p_entity_type text default null,
  p_entity_id uuid default null,
  p_client_id uuid default null,
  p_dedupe_key text default null,
  p_exclude_user_id uuid default null
)
returns table (notification_id uuid, recipient_id uuid, forwarded boolean)
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_trusted boolean := auth.jwt() is null or coalesce(auth.jwt() ->> 'role', '') = 'service_role';
  v_role public.app_role := public.app_role();
  v_title text := left(btrim(coalesce(p_title, '')), 200);
  v_body text := left(btrim(coalesce(p_body, '')), 2000);
  v_link text := btrim(coalesce(p_link_url, ''));
  v_entity_type text := nullif(left(btrim(coalesce(p_entity_type, '')), 60), '');
  v_dedupe text := nullif(left(btrim(coalesce(p_dedupe_key, '')), 200), '');
  v_money boolean;
  v_client_ok boolean;
begin
  if not v_trusted then
    if v_role is null then
      raise exception 'USER: You don''t have permission to send notifications.' using errcode = 'P0001';
    end if;
    if p_type = 'security_alert' then
      raise exception 'USER: Security alerts are raised by the system only.' using errcode = 'P0001';
    end if;
    if v_role = 'client' then
      if p_type not in ('document_uploaded', 'info', 'payment_received')
         or p_client_id is null
         or p_client_id not in (select public.portal_client_ids()) then
        raise exception 'USER: You don''t have permission to send that notification.' using errcode = 'P0001';
      end if;
    end if;
  end if;
  -- Staff may notify staff about any client their work touches (an Employee can hold a task on a
  -- client they can't otherwise see, §4.1); only a client they can see lets them reach its portal user.
  v_client_ok := v_trusted or v_role in ('partner', 'manager', 'client')
    or (p_client_id is not null and public.can_see_client(p_client_id));

  if v_title = '' or v_body = '' then
    raise exception 'USER: A notification needs a title and a message.' using errcode = 'P0001';
  end if;
  if v_link !~ '^/([^/\\]|$)' then
    raise exception 'USER: A notification links to a page inside the app.' using errcode = 'P0001';
  end if;

  v_money := public.is_money_notification(p_type, v_entity_type, v_link);

  return query
  with direct as (
    select p.id as uid
    from public.profiles p
    where p.id = any (coalesce(p_user_ids, '{}'::uuid[]))
    union
    select p.id
    from public.profiles p
    where p.role = any (coalesce(p_roles, '{}'::public.app_role[]))
      and p.role in ('partner', 'manager')
    union
    select e.profile_id
    from public.employees e
    where e.id = any (coalesce(p_employee_ids, '{}'::uuid[]))
      and e.profile_id is not null
      and e.is_active
      and e.deleted_at is null
  ),
  covered as (
    -- §4.7: notices about a covered client that go to the absent person also go to the cover person.
    select ce.profile_id as uid
    from direct d
    join public.employees ae on ae.profile_id = d.uid
    join public.clients c on c.id = p_client_id
    join public.covers_in_force f on f.kind = 'client' and f.client_id = c.id
      and coalesce(f.absent_employee_id, c.owner_employee_id) = ae.id
    join public.employees ce on ce.id = f.cover_employee_id and ce.is_active and ce.deleted_at is null
    where p_client_id is not null and ce.profile_id is not null
    union
    select ce.profile_id
    from direct d
    join public.employees ae on ae.profile_id = d.uid
    join public.clients c on c.id = p_client_id
    join public.covers_in_force f on f.kind = 'person' and f.absent_employee_id = ae.id
    join public.employees ce on ce.id = f.cover_employee_id and ce.is_active and ce.deleted_at is null
    where p_client_id is not null
      and ce.profile_id is not null
      and (
        c.owner_employee_id = ae.id
        or exists (select 1 from public.client_team_members tm where tm.client_id = c.id and tm.employee_id = ae.id)
      )
  ),
  candidates as (
    select d.uid, false as fwd from direct d
    union all
    select cv.uid, true from covered cv
  ),
  eligible as (
    select c.uid, bool_and(c.fwd) as fwd
    from candidates c
    join public.profiles p on p.id = c.uid and p.is_active
    where c.uid is distinct from p_exclude_user_id
      and (
        p.role in ('partner', 'manager')
        or (p.role = 'employee' and not v_money)
        or (
          p.role = 'client'
          and v_client_ok
          and v_link ~ '^/portal([/?#]|$)'
          and p_client_id is not null
          and exists (
            select 1 from public.clients cl
            where cl.id = p_client_id and cl.portal_user_id = p.id and cl.deleted_at is null
          )
        )
      )
    group by c.uid
  ),
  ins as (
    insert into public.notifications (user_id, type, title, body, link_url, entity_type, entity_id, dedupe_key)
    select e.uid, p_type, v_title, v_body, v_link, v_entity_type, p_entity_id, v_dedupe
    from eligible e
    on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing
    returning notifications.id as nid, notifications.user_id as nuid
  )
  select i.nid, i.nuid, e.fwd
  from ins i
  join eligible e on e.uid = i.nuid;
end;
$$;

comment on function public.insert_notifications(public.notification_type, text, text, text, uuid[], public.app_role[], uuid[], text, uuid, uuid, text, uuid) is
  'Writes one notification per recipient (profile ids, Partners/Managers by role, employee ids), forwarding client notices to cover persons in force, never sending money notices to Employees, skipping disabled people and the actor, de-duplicated by key (§4.1, §4.7, §9).';

revoke execute on function public.insert_notifications(public.notification_type, text, text, text, uuid[], public.app_role[], uuid[], text, uuid, uuid, text, uuid) from public, anon;
grant execute on function public.insert_notifications(public.notification_type, text, text, text, uuid[], public.app_role[], uuid[], text, uuid, uuid, text, uuid) to authenticated, service_role;
