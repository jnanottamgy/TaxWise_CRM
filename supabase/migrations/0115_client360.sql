-- 0115 · Client 360 (§7.3.3, §4.7, §5.3, §6.6, §6.8, §6.10, §7.22, §13).
--
--   client_contacts_primary_guard   exactly one primary contact per client (§5.3, §7.3.3 "primary
--                                   (exactly one)"), for every writer: the first contact becomes
--                                   primary; making a contact primary demotes the old one in the
--                                   same statement; the primary can't simply be unset; deleting it
--                                   promotes the oldest remaining contact; a contact never moves to
--                                   another client.
--   set_primary_contact(id, at)     Partner/Manager: makes one contact the primary, with optimistic
--                                   concurrency (§13).
--   client_team_signature(client)   the owner and engagement team as one comparable string, so a
--                                   team edit can be refused when someone else changed it (§13).
--   set_client_team(...)            Partner/Manager: the client owner, engagement partner (a
--                                   Partner), review manager (Partner or Manager) and preparers in
--                                   one transaction; returns who was added and removed.
--   clients.tax_audit_decided_by/at the partner's tax-audit decision (§6.6) records who and when;
--                                   only a Partner may change it once recorded.
--   clients.portal_revoked_at/by/   portal access revoked from Client 360 (§7.22): when, by whom, and
--   portal_revoked_user_id          the banned login (so access can be restored to it); cleared when
--                                   the client is linked to a portal login again.
--   client_cover_badges(client)     the "Covering for Ravi · until Sat 25 Oct, 11:59 pm" chip shown to
--                                   everyone who can see the client (§4.7), and the handover note
--                                   for the cover person (and Partners/Managers) only.
--   client_kyc guards               never a full Aadhaar number (§6.10); principal persons are a list.

set search_path = public, extensions;

-- =============================================================================================
-- Exactly one primary contact (§5.3)
-- =============================================================================================
create or replace function public.client_contacts_primary_guard()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if tg_op = 'INSERT' then
    -- Serialise primary changes for this client, so two first contacts can't both become primary.
    perform 1 from public.clients c where c.id = new.client_id for no key update;
    if new.is_primary then
      update public.client_contacts set is_primary = false where client_id = new.client_id and is_primary;
    elsif not exists (select 1 from public.client_contacts cc where cc.client_id = new.client_id and cc.is_primary) then
      new.is_primary := true;
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.client_id is distinct from old.client_id then
      raise exception 'USER: A contact can''t be moved to another client. Add it to that client instead.' using errcode = 'P0001';
    end if;
    if new.is_primary and not old.is_primary then
      perform 1 from public.clients c where c.id = new.client_id for no key update;
      update public.client_contacts set is_primary = false
       where client_id = new.client_id and is_primary and id <> new.id;
    elsif old.is_primary and not new.is_primary and pg_trigger_depth() = 1 then
      -- Only this guard (one level down) may demote a primary contact.
      raise exception 'USER: A client needs one primary contact. Make another contact primary instead.' using errcode = 'P0001';
    end if;
    return new;
  end if;

  -- DELETE (after): the oldest remaining contact becomes primary.
  if old.is_primary and exists (select 1 from public.clients c where c.id = old.client_id) then
    update public.client_contacts set is_primary = true
     where id = (
       select cc.id from public.client_contacts cc
       where cc.client_id = old.client_id
       order by cc.created_at, cc.id
       limit 1
     );
  end if;
  return null;
end;
$$;

comment on function public.client_contacts_primary_guard() is
  'Exactly one primary contact per client (§5.3): first contact is primary; a new primary demotes the old; the primary can''t be unset directly; deleting it promotes the oldest remaining contact.';

drop trigger if exists client_contacts_primary_guard on public.client_contacts;
create trigger client_contacts_primary_guard
  before insert or update on public.client_contacts
  for each row execute function public.client_contacts_primary_guard();

drop trigger if exists client_contacts_primary_after_delete on public.client_contacts;
create trigger client_contacts_primary_after_delete
  after delete on public.client_contacts
  for each row execute function public.client_contacts_primary_guard();

-- Clients that already have contacts but no primary (rows from before this guard): the oldest one.
update public.client_contacts cc
   set is_primary = true
 where cc.id in (
   select distinct on (x.client_id) x.id
   from public.client_contacts x
   where not exists (select 1 from public.client_contacts p where p.client_id = x.client_id and p.is_primary)
   order by x.client_id, x.created_at, x.id
 );

create or replace function public.set_primary_contact(p_contact_id uuid, p_updated_at timestamptz default null)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_row public.client_contacts%rowtype;
  v_previous uuid;
  v_updated timestamptz;
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only Partners and Managers can change a client''s primary contact.' using errcode = 'P0001';
  end if;

  select * into v_row from public.client_contacts where id = p_contact_id for update;
  if not found then
    raise exception 'USER: That contact no longer exists. Reload to see the current contacts.' using errcode = 'P0001';
  end if;
  if p_updated_at is not null and date_trunc('milliseconds', v_row.updated_at) <> date_trunc('milliseconds', p_updated_at) then
    raise exception 'USER: This contact was changed by someone else. Reload to see their changes.' using errcode = 'P0001';
  end if;
  if v_row.is_primary then
    return jsonb_build_object('id', v_row.id, 'client_id', v_row.client_id, 'name', v_row.name, 'previous_id', v_row.id, 'updated_at', v_row.updated_at, 'changed', false);
  end if;

  select id into v_previous from public.client_contacts where client_id = v_row.client_id and is_primary;
  update public.client_contacts set is_primary = true where id = p_contact_id returning updated_at into v_updated;

  return jsonb_build_object('id', v_row.id, 'client_id', v_row.client_id, 'name', v_row.name, 'previous_id', v_previous, 'updated_at', v_updated, 'changed', true);
end;
$$;

comment on function public.set_primary_contact(uuid, timestamptz) is
  'Partner/Manager: makes a contact the client''s primary contact (the guard demotes the old one in the same transaction). p_updated_at gives optimistic concurrency (§13).';

-- =============================================================================================
-- The owner and engagement team (§5.3, §7.3.3 Profile & contacts → Team)
-- =============================================================================================
create or replace function public.client_team_signature(p_client_id uuid)
returns text
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select 'owner:' || coalesce((select c.owner_employee_id::text from public.clients c where c.id = p_client_id), '')
      || ';' || coalesce((
        select string_agg(tm.team_role::text || ':' || tm.employee_id::text, ',' order by tm.team_role::text collate "C", tm.employee_id::text collate "C")
        from public.client_team_members tm
        where tm.client_id = p_client_id
      ), '')
$$;

comment on function public.client_team_signature(uuid) is
  'The client''s owner and engagement team as "owner:<id>;<role>:<id>,…" (roles then ids in C order), for optimistic concurrency on team edits (§13). Mirror: teamSignature in components/client360/logic/team.ts.';

create or replace function public.set_client_team(
  p_client_id uuid,
  p_owner uuid,
  p_engagement_partner uuid,
  p_review_manager uuid,
  p_preparers uuid[],
  p_expected_signature text default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_client public.clients%rowtype;
  v_wanted jsonb := '[]'::jsonb;
  v_added jsonb := '[]'::jsonb;
  v_removed jsonb := '[]'::jsonb;
  v_prep uuid;
  v_role public.app_role;
  v_old_owner uuid;
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only Partners and Managers can change a client''s team.' using errcode = 'P0001';
  end if;

  select * into v_client from public.clients c where c.id = p_client_id for update;
  if not found or v_client.deleted_at is not null then
    raise exception 'USER: That client isn''t in the client list any more. It may be in the recycle bin.' using errcode = 'P0001';
  end if;
  if p_expected_signature is not null and public.client_team_signature(p_client_id) <> p_expected_signature then
    raise exception 'USER: Someone else changed this client''s team. Reload to see their changes.' using errcode = 'P0001';
  end if;

  -- The owner: an active member of the team (as in onboarding, §7.3.2 step 3).
  if p_owner is null then
    raise exception 'USER: Choose the client owner.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.employees e where e.id = p_owner and e.is_active and e.deleted_at is null) then
    raise exception 'USER: The client owner must be an active member of the team.' using errcode = 'P0001';
  end if;

  if p_engagement_partner is not null then
    if not exists (select 1 from public.employees e where e.id = p_engagement_partner and e.is_active and e.deleted_at is null) then
      raise exception 'USER: Everyone on the engagement team must be an active member of the team.' using errcode = 'P0001';
    end if;
    if public.employee_role(p_engagement_partner) is distinct from 'partner' then
      raise exception 'USER: The engagement partner must be a Partner.' using errcode = 'P0001';
    end if;
    v_wanted := v_wanted || jsonb_build_object('employee_id', p_engagement_partner, 'team_role', 'engagement_partner');
  end if;

  if p_review_manager is not null then
    if not exists (select 1 from public.employees e where e.id = p_review_manager and e.is_active and e.deleted_at is null) then
      raise exception 'USER: Everyone on the engagement team must be an active member of the team.' using errcode = 'P0001';
    end if;
    v_role := public.employee_role(p_review_manager);
    if v_role is null or v_role not in ('partner', 'manager') then
      raise exception 'USER: The review manager must be a Partner or a Manager.' using errcode = 'P0001';
    end if;
    v_wanted := v_wanted || jsonb_build_object('employee_id', p_review_manager, 'team_role', 'review_manager');
  end if;

  if coalesce(cardinality(p_preparers), 0) > 20 then
    raise exception 'USER: A client can have at most 20 preparers.' using errcode = 'P0001';
  end if;
  foreach v_prep in array coalesce(p_preparers, '{}'::uuid[]) loop
    if v_prep is null then
      continue;
    end if;
    if not exists (select 1 from public.employees e where e.id = v_prep and e.is_active and e.deleted_at is null) then
      raise exception 'USER: Everyone on the engagement team must be an active member of the team.' using errcode = 'P0001';
    end if;
    if public.employee_role(v_prep) is null or public.employee_role(v_prep) = 'client' then
      raise exception 'USER: Preparers must be members of the firm''s team.' using errcode = 'P0001';
    end if;
    v_wanted := v_wanted || jsonb_build_object('employee_id', v_prep, 'team_role', 'preparer');
  end loop;

  -- Removed: rows not wanted any more.
  with gone as (
    delete from public.client_team_members tm
    where tm.client_id = p_client_id
      and not exists (
        select 1 from jsonb_to_recordset(v_wanted) as w(employee_id uuid, team_role public.team_role)
        where w.employee_id = tm.employee_id and w.team_role = tm.team_role
      )
    returning tm.employee_id, tm.team_role
  )
  select coalesce(jsonb_agg(jsonb_build_object('employee_id', employee_id, 'team_role', team_role)), '[]'::jsonb) into v_removed from gone;

  -- Added: wanted rows that weren't there.
  with put as (
    insert into public.client_team_members (client_id, employee_id, team_role)
    select distinct p_client_id, w.employee_id, w.team_role
    from jsonb_to_recordset(v_wanted) as w(employee_id uuid, team_role public.team_role)
    on conflict (client_id, employee_id, team_role) do nothing
    returning employee_id, team_role
  )
  select coalesce(jsonb_agg(jsonb_build_object('employee_id', employee_id, 'team_role', team_role)), '[]'::jsonb) into v_added from put;

  v_old_owner := v_client.owner_employee_id;
  if v_old_owner is distinct from p_owner then
    update public.clients set owner_employee_id = p_owner where id = p_client_id;
  end if;

  return jsonb_build_object(
    'added', v_added,
    'removed', v_removed,
    'owner_changed', v_old_owner is distinct from p_owner,
    'previous_owner', v_old_owner,
    'owner', p_owner,
    'signature', public.client_team_signature(p_client_id)
  );
end;
$$;

comment on function public.set_client_team(uuid, uuid, uuid, uuid, uuid[], text) is
  'Partner/Manager: sets the client owner and engagement team (engagement partner a Partner, review manager a Partner or Manager, preparers any active staff) in one transaction, refusing when the team changed since it was loaded (§5.3, §13).';

-- =============================================================================================
-- The partner's tax-audit decision (§6.6)
-- =============================================================================================
alter table public.clients
  add column if not exists tax_audit_decided_by uuid,
  add column if not exists tax_audit_decided_at timestamptz,
  add column if not exists portal_revoked_at timestamptz,
  add column if not exists portal_revoked_by uuid,
  add column if not exists portal_revoked_user_id uuid references auth.users (id) on delete set null;

comment on column public.clients.tax_audit_decided_by is 'Who recorded the tax-audit decision (§6.6), stamped by clients_tax_audit_guard.';
comment on column public.clients.tax_audit_decided_at is 'When the tax-audit decision was recorded (§6.6), stamped by clients_tax_audit_guard.';
comment on column public.clients.portal_revoked_at is 'When portal access was revoked from Client 360 (§7.22); cleared when a portal login is linked again.';
comment on column public.clients.portal_revoked_by is 'Who revoked portal access (§7.22).';
comment on column public.clients.portal_revoked_user_id is 'The banned portal login of a revoked client, so access can be restored to the same login (§7.22); cleared when a login is linked again.';

create or replace function public.clients_tax_audit_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if tg_op = 'INSERT' then
    if new.tax_audit_applicable is not null then
      new.tax_audit_decided_by := coalesce(new.tax_audit_decided_by, auth.uid());
      new.tax_audit_decided_at := coalesce(new.tax_audit_decided_at, now());
    end if;
    return new;
  end if;

  if new.tax_audit_applicable is distinct from old.tax_audit_applicable
     or new.tax_audit_note is distinct from old.tax_audit_note then
    if public.is_api_caller() and public.app_role() is distinct from 'partner' then
      raise exception 'USER: Only a Partner can record the tax-audit decision.' using errcode = 'P0001';
    end if;
    new.tax_audit_decided_by := auth.uid();
    new.tax_audit_decided_at := now();
  elsif public.is_api_caller()
     and (new.tax_audit_decided_by is distinct from old.tax_audit_decided_by
          or new.tax_audit_decided_at is distinct from old.tax_audit_decided_at) then
    -- The stamps follow the decision; nobody sets them by hand.
    new.tax_audit_decided_by := old.tax_audit_decided_by;
    new.tax_audit_decided_at := old.tax_audit_decided_at;
  end if;

  -- Linking a portal login again clears the revoked marker (§7.22).
  if new.portal_user_id is not null and new.portal_user_id is distinct from old.portal_user_id then
    new.portal_revoked_at := null;
    new.portal_revoked_by := null;
    new.portal_revoked_user_id := null;
  end if;
  return new;
end;
$$;

comment on function public.clients_tax_audit_guard() is
  'Trigger: only a Partner changes the tax-audit decision once recorded, and who/when are stamped (§6.6); linking a portal login clears portal_revoked_at (§7.22).';

drop trigger if exists clients_tax_audit_guard on public.clients;
create trigger clients_tax_audit_guard
  before insert or update on public.clients
  for each row execute function public.clients_tax_audit_guard();

-- =============================================================================================
-- Cover chips on the client header (§4.7 "The client header shows the same chip to everyone")
-- =============================================================================================
create or replace function public.client_cover_badges(p_client_id uuid)
returns table (
  cover_id uuid,
  kind public.cover_kind,
  cover_employee_id uuid,
  cover_name text,
  absent_employee_id uuid,
  absent_name text,
  starts_at timestamptz,
  ends_at timestamptz,
  handover_note text
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_me uuid := public.my_employee_id();
  v_manager boolean := public.is_manager_or_partner();
  v_owner uuid;
begin
  if p_client_id is null or not public.is_staff() or not public.can_see_client(p_client_id) then
    return;
  end if;
  select c.owner_employee_id into v_owner from public.clients c where c.id = p_client_id;

  return query
    select
      f.id,
      f.kind,
      f.cover_employee_id,
      ce.full_name,
      coalesce(f.absent_employee_id, case when f.kind = 'client' then v_owner end),
      ae.full_name,
      f.starts_at,
      f.ends_at,
      case when v_manager or f.cover_employee_id = v_me then f.handover_note end
    from public.covers_in_force f
    join public.employees ce on ce.id = f.cover_employee_id
    left join public.employees ae on ae.id = coalesce(f.absent_employee_id, case when f.kind = 'client' then v_owner end)
    where (f.kind = 'client' and f.client_id = p_client_id)
       or (
         f.kind = 'person'
         and f.absent_employee_id is not null
         and (
           f.absent_employee_id = v_owner
           or exists (
             select 1 from public.client_team_members tm
             where tm.client_id = p_client_id and tm.employee_id = f.absent_employee_id
           )
         )
       )
    order by f.ends_at, f.id;
end;
$$;

comment on function public.client_cover_badges(uuid) is
  'Covers in force that reach a client (client covers for it; person covers for its owner or a team member), for the header chip every staff member who can see the client gets (§4.7). The handover note only for the cover person and Partners/Managers.';

-- =============================================================================================
-- KYC (§6.8, §6.10): never a full Aadhaar number; principal persons are a list.
-- =============================================================================================
create or replace function public.contains_full_aadhaar(p text)
returns boolean
language sql
immutable
set search_path = public, extensions
as $$
  -- Mirror of containsFullAadhaar in lib/domain/india-validators.ts.
  select coalesce(p ~ '(^|[^0-9])[2-9][0-9]{3}[ -]?[0-9]{4}[ -]?[0-9]{4}([^0-9]|$)', false)
$$;

comment on function public.contains_full_aadhaar(text) is
  'True when the text holds a full 12-digit Aadhaar number, together or in 4-4-4 groups (mirror of containsFullAadhaar, §6.10).';

create or replace function public.client_kyc_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if public.contains_full_aadhaar(new.principal_persons::text)
     or public.contains_full_aadhaar(new.business_description)
     or public.contains_full_aadhaar(new.registered_address) then
    raise exception 'USER: Don''t store a full Aadhaar number. Keep only the last 4 digits, and the copy in the confidential document vault.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

comment on function public.client_kyc_guard() is 'Trigger: refuses a full Aadhaar number anywhere in a KYC record (§6.10).';

drop trigger if exists client_kyc_guard on public.client_kyc;
create trigger client_kyc_guard
  before insert or update on public.client_kyc
  for each row execute function public.client_kyc_guard();

alter table public.client_kyc drop constraint if exists client_kyc_principal_persons_list;
alter table public.client_kyc
  add constraint client_kyc_principal_persons_list
  check (principal_persons is null or jsonb_typeof(principal_persons) = 'array');

-- =============================================================================================
-- Grants
-- =============================================================================================
revoke execute on function
  public.client_contacts_primary_guard(),
  public.clients_tax_audit_guard(),
  public.client_kyc_guard()
from public, anon, authenticated;

revoke execute on function
  public.set_primary_contact(uuid, timestamptz),
  public.client_team_signature(uuid),
  public.set_client_team(uuid, uuid, uuid, uuid, uuid[], text),
  public.client_cover_badges(uuid),
  public.contains_full_aadhaar(text)
from public, anon;
grant execute on function
  public.set_primary_contact(uuid, timestamptz),
  public.client_team_signature(uuid),
  public.set_client_team(uuid, uuid, uuid, uuid, uuid[], text),
  public.client_cover_badges(uuid),
  public.contains_full_aadhaar(text)
to authenticated, service_role;
