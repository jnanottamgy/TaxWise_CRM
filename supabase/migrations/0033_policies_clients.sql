-- 0033 · RLS: clients and client-owned master data, credentials, acceptance and KYC (§4.1, §4.6, §5.3,
-- §5.12, §7.3, §7.15, §7.22).
--
-- "Client-owned rows" (§4.6): SELECT where the caller can see the client; INSERT/UPDATE for
-- Partner/Manager, plus Employees for a limited column set (enforced by BEFORE UPDATE triggers,
-- since RLS can't restrict columns); DELETE Partner/Manager.
-- Portal users read their own client through portal_my_client (portal-safe columns), never the
-- clients table itself, which holds internal notes.

set search_path = public, extensions;

-- =============================================================================================
-- clients
-- =============================================================================================
create policy clients_select_staff on public.clients
  for select to authenticated
  using ((select public.is_manager_or_partner()) or id in (select public.staff_client_ids()));
create policy clients_insert on public.clients
  for insert to authenticated with check ((select public.is_manager_or_partner()));
create policy clients_update_manager_partner on public.clients
  for update to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));
create policy clients_update_employee on public.clients
  for update to authenticated
  using ((select public.app_role()) = 'employee' and id in (select public.staff_client_ids()))
  with check ((select public.app_role()) = 'employee' and id in (select public.staff_client_ids()));
create policy clients_delete_partner on public.clients
  for delete to authenticated using ((select public.is_partner()));

-- Employees: notes only (§4.1 "read + limited edit"). Managers restore but don't delete (§4.1).
create or replace function public.clients_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_role public.app_role;
begin
  if not public.is_api_caller() then
    return new;
  end if;
  v_role := public.app_role();
  if v_role = 'employee' then
    perform public.assert_changed_only(to_jsonb(old), to_jsonb(new), array['notes'], 'this client');
  elsif v_role = 'manager' and old.deleted_at is null and new.deleted_at is not null then
    raise exception 'USER: Only a Partner can delete a client. Managers can restore clients from the recycle bin.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger clients_guard before update on public.clients
  for each row execute function public.clients_guard();

-- portal_my_client: the signed-in portal user's client, portal-safe columns, plus the owner's
-- contact card (§7.22 "the firm's contact card with the owner's name").
create view public.portal_my_client with (security_invoker = false, security_barrier = true) as
select
  c.id,
  c.client_code,
  c.display_name,
  c.legal_name,
  c.entity_type,
  c.pan,
  c.tan,
  c.gst_registration,
  c.gstin,
  c.gst_scheme,
  c.state_code,
  c.email,
  c.phone,
  c.whatsapp,
  c.address,
  c.city,
  c.pincode,
  c.status,
  c.fy_end_month,
  c.portal_invited_at,
  c.portal_last_seen_at,
  e.full_name as owner_name,
  e.designation as owner_designation,
  e.email as owner_email,
  e.phone as owner_phone
from public.clients c
left join public.employees e on e.id = c.owner_employee_id and e.deleted_at is null
where public.is_client()
  and c.portal_user_id = auth.uid()
  and c.deleted_at is null;

comment on view public.portal_my_client is
  'The portal user''s own client (clients.portal_user_id = auth.uid()), portal-safe columns and owner contact (§7.22).';

revoke all on public.portal_my_client from anon, public;
grant select on public.portal_my_client to authenticated, service_role;

-- =============================================================================================
-- client_groups (§7.4): staff read (the client header shows the group); Partner/Manager write.
-- =============================================================================================
create policy client_groups_select on public.client_groups
  for select to authenticated using ((select public.is_staff()));
create policy client_groups_insert on public.client_groups
  for insert to authenticated with check ((select public.is_manager_or_partner()));
create policy client_groups_update on public.client_groups
  for update to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));
create policy client_groups_delete on public.client_groups
  for delete to authenticated using ((select public.is_manager_or_partner()));

-- onboarding_drafts (§7.3.2): the wizard's own drafts; onboarding is Partner/Manager work.
create policy onboarding_drafts_own on public.onboarding_drafts
  for all to authenticated
  using ((select public.is_manager_or_partner()) and user_id = (select auth.uid()))
  with check ((select public.is_manager_or_partner()) and user_id = (select auth.uid()));

-- =============================================================================================
-- client_services: engagement fees are Partner/Manager only (§4.6). Employees read
-- client_services_public, redefined here as a filtered view without fee columns (it must not
-- depend on the base table's RLS, which hides every row from Employees).
-- =============================================================================================
create policy client_services_select on public.client_services
  for select to authenticated using ((select public.is_manager_or_partner()));
create policy client_services_insert on public.client_services
  for insert to authenticated with check ((select public.is_manager_or_partner()));
create policy client_services_update on public.client_services
  for update to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));
create policy client_services_delete on public.client_services
  for delete to authenticated using ((select public.is_manager_or_partner()));

create or replace view public.client_services_public with (security_invoker = false, security_barrier = true) as
select
  s.id,
  s.client_id,
  s.service_type,
  s.custom_name,
  s.frequency,
  s.is_active,
  s.next_due_date,
  s.created_at,
  s.updated_at
from public.client_services s
where public.is_staff()
  and (public.is_manager_or_partner() or s.client_id in (select public.staff_client_ids()));

comment on view public.client_services_public is
  'client_services without fee or billing columns, rows the calling staff member can see (§4.6).';

revoke all on public.client_services_public from anon, public;
grant select on public.client_services_public to authenticated, service_role;

-- client_service_fee_history: money; written only by the fee-history trigger.
create policy client_service_fee_history_select on public.client_service_fee_history
  for select to authenticated using ((select public.is_manager_or_partner()));
revoke insert, update, delete on public.client_service_fee_history from authenticated;

-- =============================================================================================
-- client_contacts, client_team_members, client_kyc, statutory master data: staff who can see the
-- client read; Partner/Manager write.
-- =============================================================================================
create policy client_contacts_select on public.client_contacts
  for select to authenticated
  using ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()));
create policy client_contacts_insert on public.client_contacts
  for insert to authenticated with check ((select public.is_manager_or_partner()));
create policy client_contacts_update on public.client_contacts
  for update to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));
create policy client_contacts_delete on public.client_contacts
  for delete to authenticated using ((select public.is_manager_or_partner()));

create policy client_team_members_select on public.client_team_members
  for select to authenticated
  using ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()));
create policy client_team_members_insert on public.client_team_members
  for insert to authenticated with check ((select public.is_manager_or_partner()));
create policy client_team_members_update on public.client_team_members
  for update to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));
create policy client_team_members_delete on public.client_team_members
  for delete to authenticated using ((select public.is_manager_or_partner()));

create policy client_kyc_select on public.client_kyc
  for select to authenticated
  using ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()));
create policy client_kyc_insert on public.client_kyc
  for insert to authenticated with check ((select public.is_manager_or_partner()));
create policy client_kyc_update on public.client_kyc
  for update to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));
create policy client_kyc_delete on public.client_kyc
  for delete to authenticated using ((select public.is_manager_or_partner()));

-- client_document_checklist_items (§7.14 "Checklist"): Employees tick items collected and link
-- the document; adding and removing items is Partner/Manager.
create policy client_checklist_select on public.client_document_checklist_items
  for select to authenticated
  using ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()));
create policy client_checklist_insert on public.client_document_checklist_items
  for insert to authenticated with check ((select public.is_manager_or_partner()));
create policy client_checklist_update on public.client_document_checklist_items
  for update to authenticated
  using ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()))
  with check ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()));
create policy client_checklist_delete on public.client_document_checklist_items
  for delete to authenticated using ((select public.is_manager_or_partner()));

-- =============================================================================================
-- Generic Employee column limit: limit_employee_columns('col,col,…') lets an Employee change only
-- the listed columns (plus updated_at). Partners, Managers, SECURITY DEFINER functions and the
-- service role are not limited by it.
-- =============================================================================================
create or replace function public.limit_employee_columns()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if public.is_api_caller() and public.app_role() = 'employee' then
    perform public.assert_changed_only(
      to_jsonb(old), to_jsonb(new),
      string_to_array(coalesce(tg_argv[0], ''), ','),
      coalesce(tg_argv[1], 'this record')
    );
  end if;
  return new;
end;
$$;

comment on function public.limit_employee_columns() is
  'Trigger: an Employee (API caller) may change only the columns listed in the first trigger argument (§4.6).';

create trigger limit_employee_columns before update on public.client_document_checklist_items
  for each row execute function public.limit_employee_columns('collected,collected_at,collected_by,document_id', 'this checklist item');

-- =============================================================================================
-- client_credentials (§4.6, §12, §14 "nobody can read credential ciphertext"):
--   no direct SELECT (or any other privilege) for anyone through the API;
--   client_credentials_list shows portal / username / login URL / notes, never the ciphertext;
--   writes go through save_client_credential / delete_client_credential (Partner/Manager);
--   revealing a password happens in server/admin.ts, which logs credential_access_logs.
-- =============================================================================================
revoke all on public.client_credentials from anon, authenticated;

create view public.client_credentials_list with (security_invoker = false, security_barrier = true) as
select
  cc.id,
  cc.client_id,
  cc.portal,
  cc.portal_label,
  cc.username,
  cc.login_url,
  cc.notes,
  cc.updated_by,
  cc.created_at,
  cc.updated_at
from public.client_credentials cc
where public.is_staff()
  and (public.is_manager_or_partner() or cc.client_id in (select public.staff_client_ids()));

comment on view public.client_credentials_list is
  'Stored portal logins without the ciphertext, for staff who can see the client (§4.6).';

revoke all on public.client_credentials_list from anon, public;
grant select on public.client_credentials_list to authenticated, service_role;

-- save_client_credential: insert (p_id null) or update one stored login. The ciphertext is produced
-- by the server (AES-256-GCM, server/vault.ts); null on update keeps the stored password.
-- p_expected_updated_at gives optimistic concurrency (§13). Returns the row id.
create or replace function public.save_client_credential(
  p_id uuid,
  p_client_id uuid,
  p_portal text,
  p_portal_label text,
  p_username text,
  p_password_ciphertext text,
  p_login_url text default null,
  p_notes text default null,
  p_expected_updated_at timestamptz default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid;
  v_current public.client_credentials%rowtype;
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only Partners and Managers can add or change stored portal logins.' using errcode = 'P0001';
  end if;

  if p_id is null then
    if p_password_ciphertext is null then
      raise exception 'USER: Enter the password to store.' using errcode = 'P0001';
    end if;
    insert into public.client_credentials (client_id, portal, portal_label, username, password_ciphertext, login_url, notes, updated_by)
    values (p_client_id, p_portal, p_portal_label, p_username, p_password_ciphertext, p_login_url, p_notes, auth.uid())
    returning id into v_id;
    insert into public.credential_access_logs (credential_id, user_id, action) values (v_id, auth.uid(), 'created');
    return v_id;
  end if;

  select * into v_current from public.client_credentials where id = p_id for update;
  if not found then
    raise exception 'USER: That stored login no longer exists.' using errcode = 'P0001';
  end if;
  if p_expected_updated_at is not null and date_trunc('milliseconds', v_current.updated_at) <> date_trunc('milliseconds', p_expected_updated_at) then
    raise exception 'USER: This login was changed by someone else. Reload to see their changes.' using errcode = 'P0001';
  end if;

  update public.client_credentials
     set client_id = coalesce(p_client_id, client_id),
         portal = coalesce(p_portal, portal),
         portal_label = p_portal_label,
         username = coalesce(p_username, username),
         password_ciphertext = coalesce(p_password_ciphertext, password_ciphertext),
         login_url = p_login_url,
         notes = p_notes,
         updated_by = auth.uid()
   where id = p_id;
  insert into public.credential_access_logs (credential_id, user_id, action) values (p_id, auth.uid(), 'updated');
  return p_id;
end;
$$;

comment on function public.save_client_credential(uuid, uuid, text, text, text, text, text, text, timestamptz) is
  'Partner/Manager: insert or update a stored portal login with server-made ciphertext; logs credential_access_logs (§4.6, §12).';

create or replace function public.delete_client_credential(p_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only Partners and Managers can delete stored portal logins.' using errcode = 'P0001';
  end if;
  delete from public.client_credentials where id = p_id;
  return found;
end;
$$;

comment on function public.delete_client_credential(uuid) is 'Partner/Manager: deletes a stored portal login (§4.6).';

revoke execute on function
  public.save_client_credential(uuid, uuid, text, text, text, text, text, text, timestamptz),
  public.delete_client_credential(uuid)
from public, anon;
grant execute on function
  public.save_client_credential(uuid, uuid, text, text, text, text, text, text, timestamptz),
  public.delete_client_credential(uuid)
to authenticated, service_role;

-- credential_access_logs (§5.3): Partners/Managers read. A staff member may log their own action on
-- a login of a client they can see (e.g. "copied"); reveals are logged by the server.
create policy credential_access_logs_select on public.credential_access_logs
  for select to authenticated using ((select public.is_manager_or_partner()));
create policy credential_access_logs_insert on public.credential_access_logs
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (select public.is_staff())
    and exists (
      select 1 from public.client_credentials_list l where l.id = credential_access_logs.credential_id
    )
  );
revoke update, delete on public.credential_access_logs from authenticated;

-- =============================================================================================
-- Engagement-side records (Client 360 → Engagement tab, Partner/Manager only, §7.3.3, §7.5.4, §7.15):
-- client_acceptances, previous_auditor_communications, audit_engagements.
-- =============================================================================================
create policy client_acceptances_select on public.client_acceptances
  for select to authenticated using ((select public.is_manager_or_partner()));
create policy client_acceptances_insert on public.client_acceptances
  for insert to authenticated with check ((select public.is_manager_or_partner()));
create policy client_acceptances_update on public.client_acceptances
  for update to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));
create policy client_acceptances_delete on public.client_acceptances
  for delete to authenticated using ((select public.is_partner()));

create policy previous_auditor_communications_select on public.previous_auditor_communications
  for select to authenticated using ((select public.is_manager_or_partner()));
create policy previous_auditor_communications_insert on public.previous_auditor_communications
  for insert to authenticated with check ((select public.is_manager_or_partner()));
create policy previous_auditor_communications_update on public.previous_auditor_communications
  for update to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));
create policy previous_auditor_communications_delete on public.previous_auditor_communications
  for delete to authenticated using ((select public.is_manager_or_partner()));

create policy audit_engagements_select on public.audit_engagements
  for select to authenticated using ((select public.is_manager_or_partner()));
create policy audit_engagements_insert on public.audit_engagements
  for insert to authenticated with check ((select public.is_manager_or_partner()));
create policy audit_engagements_update on public.audit_engagements
  for update to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));
create policy audit_engagements_delete on public.audit_engagements
  for delete to authenticated using ((select public.is_partner()));

revoke execute on function public.clients_guard(), public.limit_employee_columns() from public, anon, authenticated;

update public.app_meta set value = '0033' where key = 'schema_version';
