-- 0040 · RLS: WhatsApp groups, TaxWise Desktop and cover access (§4.6, §4.7, §5.13, §7.25, §14).
--
--   firm_whatsapp_numbers        staff read; Partner writes.
--   client_whatsapp_groups       Partners/Managers (can_open_whatsapp is always true for them) read
--                                and write; Employees read only client_whatsapp_groups_public (no
--                                invite_link) for clients they can open; clients never.
--   client_whatsapp_group_members staff where can_open_whatsapp(client); Partner/Manager write.
--   desktop_devices / _numbers   Partners/Managers read; rows are written only by the desktop API
--                                route handlers (service role); revoking a PC is Partner-only
--                                (revoke_desktop_device).
--   client_covers                Partners/Managers, and the cover person and the absent person on
--                                their own rows; Partner/Manager write; include_vault Partner-only;
--                                no DELETE (end a cover with revoked_at).

set search_path = public, extensions;

-- =============================================================================================
-- firm_whatsapp_numbers
-- =============================================================================================
create policy firm_whatsapp_numbers_select on public.firm_whatsapp_numbers
  for select to authenticated using ((select public.is_staff()));
create policy firm_whatsapp_numbers_insert on public.firm_whatsapp_numbers
  for insert to authenticated with check ((select public.is_partner()));
create policy firm_whatsapp_numbers_update on public.firm_whatsapp_numbers
  for update to authenticated using ((select public.is_partner())) with check ((select public.is_partner()));
create policy firm_whatsapp_numbers_delete on public.firm_whatsapp_numbers
  for delete to authenticated using ((select public.is_partner()));

-- =============================================================================================
-- client_whatsapp_groups (+ the public view without invite_link)
-- =============================================================================================
create policy client_whatsapp_groups_select on public.client_whatsapp_groups
  for select to authenticated
  using ((select public.is_manager_or_partner()) and public.can_open_whatsapp(client_id));
create policy client_whatsapp_groups_insert on public.client_whatsapp_groups
  for insert to authenticated with check ((select public.is_manager_or_partner()));
create policy client_whatsapp_groups_update on public.client_whatsapp_groups
  for update to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));
create policy client_whatsapp_groups_delete on public.client_whatsapp_groups
  for delete to authenticated using ((select public.is_partner()));

-- staff_whatsapp_client_ids(): clients whose WhatsApp group the caller may open (= can_open_whatsapp).
create or replace function public.staff_whatsapp_client_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, extensions
as $$
  select id from public.staff_client_ids() as s(id) where public.is_staff()
$$;

comment on function public.staff_whatsapp_client_ids() is
  'Clients whose WhatsApp group the caller may open: is_staff() and can_see_client (§4.6).';

-- staff_whatsapp_group_ids(): groups of those clients (the base table hides every row from
-- Employees, so policies on child tables can't read it under the caller's RLS).
create or replace function public.staff_whatsapp_group_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, extensions
as $$
  select g.id from public.client_whatsapp_groups g
  where g.client_id in (select public.staff_whatsapp_client_ids())
$$;

comment on function public.staff_whatsapp_group_ids() is 'WhatsApp groups of clients the caller may open (§4.6).';

revoke execute on function public.staff_whatsapp_client_ids(), public.staff_whatsapp_group_ids() from public, anon;
grant execute on function public.staff_whatsapp_client_ids(), public.staff_whatsapp_group_ids() to authenticated, service_role;

-- Every column except invite_link (§5.13), filtered by can_open_whatsapp: the base table hides
-- every row from Employees, so this view carries its own row filter.
create or replace view public.client_whatsapp_groups_public with (security_invoker = false, security_barrier = true) as
select
  g.id,
  g.client_id,
  g.name,
  g.purpose,
  g.is_primary,
  g.status,
  g.created_on,
  g.created_by_number_id,
  g.checklist,
  g.last_opened_at,
  g.last_opened_by,
  g.closed_at,
  g.closed_reason,
  g.notes,
  g.deleted_at,
  g.created_at,
  g.updated_at
from public.client_whatsapp_groups g
where public.is_staff()
  and (public.is_manager_or_partner() or g.client_id in (select public.staff_whatsapp_client_ids()));

comment on view public.client_whatsapp_groups_public is
  'client_whatsapp_groups without invite_link, for staff who can open the client''s WhatsApp (§4.6, §5.13).';

revoke all on public.client_whatsapp_groups_public from anon, public;
grant select on public.client_whatsapp_groups_public to authenticated, service_role;

-- client_whatsapp_group_members
create policy client_whatsapp_group_members_select on public.client_whatsapp_group_members
  for select to authenticated
  using (
    (select public.is_manager_or_partner())
    or group_id in (select public.staff_whatsapp_group_ids())
  );
create policy client_whatsapp_group_members_insert on public.client_whatsapp_group_members
  for insert to authenticated with check ((select public.is_manager_or_partner()));
create policy client_whatsapp_group_members_update on public.client_whatsapp_group_members
  for update to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));
create policy client_whatsapp_group_members_delete on public.client_whatsapp_group_members
  for delete to authenticated using ((select public.is_manager_or_partner()));

-- record_whatsapp_group_opened(client) (§7.25.1 "Open chat"): checks can_open_whatsapp, stamps
-- last_opened_at / last_opened_by on the client's primary open group, and writes the audit row
-- (record_viewed, or access_denied when refused). Never returns the invite link.
-- Returns {"allowed": false, "error": "Not one of your clients."} when refused (the denial is
-- audited, so it does not raise), {"allowed": true, "group": null} when the client has no open
-- group yet, else {"allowed": true, "group": {...}}.
create or replace function public.record_whatsapp_group_opened(p_client_id uuid, p_ip text default null, p_user_agent text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  g public.client_whatsapp_groups%rowtype;
begin
  if not public.can_open_whatsapp(p_client_id) then
    perform public.log_audit_event('access_denied', 'client_whatsapp_group', p_client_id::text, 'whatsapp.open',
      jsonb_build_object('client_id', p_client_id), false, 'Not one of your clients', p_ip, p_user_agent);
    return jsonb_build_object('allowed', false, 'error', 'Not one of your clients.');
  end if;

  select * into g
  from public.client_whatsapp_groups x
  where x.client_id = p_client_id and x.deleted_at is null and x.status <> 'closed'
  order by x.is_primary desc, (x.status = 'active') desc, x.created_at
  limit 1;
  if not found then
    return jsonb_build_object('allowed', true, 'group', null);
  end if;

  update public.client_whatsapp_groups
     set last_opened_at = now(), last_opened_by = auth.uid()
   where id = g.id;

  perform public.log_audit_event('record_viewed', 'client_whatsapp_group', g.id::text, 'whatsapp.open',
    jsonb_build_object('client_id', p_client_id), true, null, p_ip, p_user_agent);

  return jsonb_build_object('allowed', true, 'group', jsonb_build_object(
    'id', g.id, 'client_id', g.client_id, 'name', g.name, 'status', g.status, 'is_primary', g.is_primary));
end;
$$;

comment on function public.record_whatsapp_group_opened(uuid, text, text) is
  'Open chat (§7.25.1): can_open_whatsapp check (denials audited), last_opened_at/by on the primary group, record_viewed audit. Never returns the invite link.';

-- =============================================================================================
-- TaxWise Desktop (§7.25.7)
-- =============================================================================================
create policy desktop_devices_select on public.desktop_devices
  for select to authenticated using ((select public.is_manager_or_partner()));
revoke insert, update, delete, truncate on public.desktop_devices from authenticated, anon;

create policy desktop_device_numbers_select on public.desktop_device_numbers
  for select to authenticated using ((select public.is_manager_or_partner()));
revoke insert, update, delete, truncate on public.desktop_device_numbers from authenticated, anon;

-- revoke_desktop_device(device): Partner only. The PC is refused by the desktop API from now on and
-- wipes its WhatsApp data at its next start; its number links end now.
create or replace function public.revoke_desktop_device(p_device_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
begin
  if not public.is_partner() then
    raise exception 'USER: Only a Partner can remove a PC from TaxWise Desktop.' using errcode = 'P0001';
  end if;
  update public.desktop_devices
     set revoked_at = now(), revoked_by = auth.uid()
   where id = p_device_id and revoked_at is null;
  if not found then
    return false;
  end if;
  update public.desktop_device_numbers
     set unlinked_at = now()
   where device_id = p_device_id and unlinked_at is null;
  return true;
end;
$$;

comment on function public.revoke_desktop_device(uuid) is
  'Partner only: revokes a TaxWise Desktop PC and ends its number links (§4.6, §7.25.7).';

revoke execute on function
  public.record_whatsapp_group_opened(uuid, text, text),
  public.revoke_desktop_device(uuid)
from public, anon;
grant execute on function
  public.record_whatsapp_group_opened(uuid, text, text),
  public.revoke_desktop_device(uuid)
to authenticated, service_role;

-- =============================================================================================
-- client_covers (§4.6, §4.7)
-- =============================================================================================
create policy client_covers_select on public.client_covers
  for select to authenticated
  using (
    (select public.is_manager_or_partner())
    or cover_employee_id = (select public.staff_employee_id())
    or absent_employee_id = (select public.staff_employee_id())
  );
create policy client_covers_insert on public.client_covers
  for insert to authenticated
  with check ((select public.is_manager_or_partner()) and granted_by = (select auth.uid()));
create policy client_covers_update_manager_partner on public.client_covers
  for update to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));
-- the absent person ends the cover ("I'm back, end cover"); the cover person leaves a return note
create policy client_covers_update_people on public.client_covers
  for update to authenticated
  using (
    cover_employee_id = (select public.staff_employee_id())
    or absent_employee_id = (select public.staff_employee_id())
  )
  with check (
    cover_employee_id = (select public.staff_employee_id())
    or absent_employee_id = (select public.staff_employee_id())
  );
revoke delete, truncate on public.client_covers from authenticated, anon;

-- is_active_employee(id): the employee exists, is active and not deleted (read regardless of the
-- caller's RLS, which shows Employees only their own row).
create or replace function public.is_active_employee(eid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (select 1 from public.employees e where e.id = eid and e.is_active and e.deleted_at is null)
$$;

comment on function public.is_active_employee(uuid) is 'True for an active, not deleted employees row.';
revoke execute on function public.is_active_employee(uuid) from public, anon;
grant execute on function public.is_active_employee(uuid) to authenticated, service_role;

create or replace function public.client_covers_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_me uuid;
  v_allowed text[] := '{}';
begin
  -- Integrity for every writer (§4.7): no cover for or by a disabled person.
  if tg_op = 'INSERT' or new.cover_employee_id is distinct from old.cover_employee_id
     or new.absent_employee_id is distinct from old.absent_employee_id then
    if not public.is_active_employee(new.cover_employee_id) then
      raise exception 'USER: The cover person''s account is disabled, so they can''t cover anyone.' using errcode = 'P0001';
    end if;
    if new.absent_employee_id is not null and not public.is_active_employee(new.absent_employee_id) then
      raise exception 'USER: That person''s account is disabled; reassign their work instead of covering it.' using errcode = 'P0001';
    end if;
  end if;

  if not public.is_api_caller() then
    return new;
  end if;

  -- Only a Partner ticks Include portal passwords (§4.7).
  if new.include_vault and (tg_op = 'INSERT' or not old.include_vault) and not public.is_partner() then
    raise exception 'USER: Only a Partner can include portal passwords in a cover.' using errcode = 'P0001';
  end if;

  if tg_op = 'UPDATE' and not public.is_manager_or_partner() then
    v_me := public.my_employee_id();
    if old.absent_employee_id = v_me then
      v_allowed := v_allowed || array['revoked_at', 'revoked_by', 'revoke_reason'];
    end if;
    if old.cover_employee_id = v_me then
      v_allowed := v_allowed || array['return_note'];
    end if;
    perform public.assert_changed_only(to_jsonb(old), to_jsonb(new), v_allowed, 'this cover');
    if new.revoked_at is distinct from old.revoked_at then
      if old.revoked_at is not null or new.revoked_at is null or new.revoked_at > now() + interval '1 minute' then
        raise exception 'USER: You can end this cover now, but not reopen or postpone it.' using errcode = 'P0001';
      end if;
      if new.revoked_by is distinct from auth.uid() then
        raise exception 'USER: Record yourself as the person ending this cover.' using errcode = 'P0001';
      end if;
    end if;
  end if;
  return new;
end;
$$;

create trigger client_covers_guard before insert or update on public.client_covers
  for each row execute function public.client_covers_guard();

revoke execute on function public.client_covers_guard() from public, anon, authenticated;

update public.app_meta set value = '0040' where key = 'schema_version';
