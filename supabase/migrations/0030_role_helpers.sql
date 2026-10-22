-- 0030 · Role helpers for Row Level Security (§4.6, §4.7, §0.1 rules 8 and 9).
--
-- The role comes from the JWT's app_metadata (only the service role can write it) AND a matching,
-- active profiles row. user_metadata is never read: any signed-in user can edit it (§0.1 rule 9).
--
-- Helpers are SECURITY DEFINER (they read profiles / employees / clients / covers regardless of the
-- caller's RLS, which also keeps policies free of recursion), STABLE, with a fixed search_path.
--
-- Besides the §4.6 helpers this file adds a few set-returning helpers that policies use for speed:
-- a policy written as `client_id in (select public.staff_client_ids())` evaluates the helper once per
-- query (a hashed sub-plan) instead of once per row, which keeps 2,000-client / 20,000-task lists
-- inside the §13 targets. They apply exactly the same rules as can_see_client().

set search_path = public, extensions;

-- =============================================================================================
-- app_role(): the caller's role, or null (§4.6).
--   role = auth.jwt() -> 'app_metadata' ->> 'role'
--   and a profiles row with id = auth.uid(), is_active, and the same role.
-- =============================================================================================
create or replace function public.app_role()
returns public.app_role
language sql
stable
security definer
set search_path = public, extensions
as $$
  select p.role
  from public.profiles p
  where p.id = auth.uid()
    and p.is_active
    and p.role::text = (auth.jwt() -> 'app_metadata' ->> 'role')
$$;

comment on function public.app_role() is
  'The caller''s role: JWT app_metadata.role, only when an active profiles row has the same role; else null. Never reads user_metadata (§4.6, §0.1 rule 9).';

create or replace function public.is_partner()
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select coalesce(public.app_role() = 'partner', false)
$$;

comment on function public.is_partner() is 'True when app_role() is partner (§4.6).';

create or replace function public.is_manager_or_partner()
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select coalesce(public.app_role() in ('partner', 'manager'), false)
$$;

comment on function public.is_manager_or_partner() is 'True when app_role() is partner or manager (§4.6).';

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select coalesce(public.app_role() in ('partner', 'manager', 'employee'), false)
$$;

comment on function public.is_staff() is 'True when app_role() is partner, manager or employee (§4.6).';

create or replace function public.is_client()
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select coalesce(public.app_role() = 'client', false)
$$;

comment on function public.is_client() is 'True when app_role() is client (§4.6).';

-- =============================================================================================
-- my_employee_id(): employees.id where profile_id = auth.uid() (§4.6).
-- staff_employee_id(): the same, but only while app_role() is a staff role. Policies use this one,
-- so a disabled person (or a JWT whose role no longer matches the profile) matches nothing.
-- =============================================================================================
create or replace function public.my_employee_id()
returns uuid
language sql
stable
security definer
set search_path = public, extensions
as $$
  select e.id from public.employees e where e.profile_id = auth.uid()
$$;

comment on function public.my_employee_id() is 'employees.id of the signed-in user (§4.6).';

create or replace function public.staff_employee_id()
returns uuid
language sql
stable
security definer
set search_path = public, extensions
as $$
  select case when public.is_staff() then public.my_employee_id() end
$$;

comment on function public.staff_employee_id() is
  'my_employee_id() while the caller holds a staff role; null otherwise (used by policies).';

-- =============================================================================================
-- can_see_client(cid) (§4.6, §4.7)
--   Partner / Manager: true.
--   Employee: owner, or on the engagement team, or holding a cover in force (covers_in_force,
--     evaluated against now()): a client cover for this client, or a person cover for a colleague
--     who owns it or is on its team. Soft-deleted clients are in the recycle bin, which Employees
--     don't see.
--   Client: clients.portal_user_id = auth.uid() (and the client isn't deleted).
-- Mirrors canSeeClient() in lib/domain/cover.ts.
-- =============================================================================================
create or replace function public.can_see_client(cid uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_role public.app_role := public.app_role();
  v_me uuid;
begin
  if cid is null or v_role is null then
    return false;
  end if;
  if v_role in ('partner', 'manager') then
    return true;
  end if;
  if v_role = 'client' then
    return exists (
      select 1 from public.clients c
      where c.id = cid and c.portal_user_id = auth.uid() and c.deleted_at is null
    );
  end if;

  v_me := public.my_employee_id();
  if v_me is null then
    return false;
  end if;
  return exists (
    select 1
    from public.clients c
    where c.id = cid
      and c.deleted_at is null
      and (
        c.owner_employee_id = v_me
        or exists (
          select 1 from public.client_team_members tm
          where tm.client_id = c.id and tm.employee_id = v_me
        )
        or exists (
          select 1
          from public.covers_in_force f
          where f.cover_employee_id = v_me
            and (
              (f.kind = 'client' and f.client_id = c.id)
              or (
                f.kind = 'person'
                and f.absent_employee_id is not null
                and (
                  c.owner_employee_id = f.absent_employee_id
                  or exists (
                    select 1 from public.client_team_members tm2
                    where tm2.client_id = c.id and tm2.employee_id = f.absent_employee_id
                  )
                )
              )
            )
        )
      )
  );
end;
$$;

comment on function public.can_see_client(uuid) is
  'Partner/Manager: true. Employee: owner, team member, or a cover in force (client cover, or person cover for the owner/a team member). Client: clients.portal_user_id = auth.uid() (§4.6, §4.7).';

-- can_open_whatsapp(cid) = is_staff() and can_see_client(cid). Clients never get WhatsApp (§4.6).
create or replace function public.can_open_whatsapp(cid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select public.is_staff() and public.can_see_client(cid)
$$;

comment on function public.can_open_whatsapp(uuid) is
  'is_staff() and can_see_client(cid): clients never get WhatsApp groups, not even their own (§4.6).';

-- =============================================================================================
-- Set-returning helpers for policies (same rules as can_see_client).
-- =============================================================================================

-- staff_client_ids(): the clients a staff member can see. Partner/Manager: every client.
-- Employee: owner / team / covers in force, not deleted. Anyone else: none.
create or replace function public.staff_client_ids()
returns setof uuid
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_role public.app_role := public.app_role();
  v_me uuid;
begin
  if v_role in ('partner', 'manager') then
    return query select c.id from public.clients c;
    return;
  end if;
  if v_role is distinct from 'employee' then
    return;
  end if;
  v_me := public.my_employee_id();
  if v_me is null then
    return;
  end if;

  return query
    with people as (
      -- the employee themself, plus everyone they hold a person cover for right now
      select v_me as emp
      union
      select f.absent_employee_id
      from public.covers_in_force f
      where f.kind = 'person' and f.cover_employee_id = v_me and f.absent_employee_id is not null
    )
    select c.id
    from public.clients c
    join people p on c.owner_employee_id = p.emp
    where c.deleted_at is null
    union
    select tm.client_id
    from public.client_team_members tm
    join people p on tm.employee_id = p.emp
    join public.clients c on c.id = tm.client_id and c.deleted_at is null
    union
    select f.client_id
    from public.covers_in_force f
    join public.clients c on c.id = f.client_id and c.deleted_at is null
    where f.kind = 'client' and f.cover_employee_id = v_me;
end;
$$;

comment on function public.staff_client_ids() is
  'Clients the calling staff member can see (Partner/Manager: all; Employee: owner/team/covers in force). Same rules as can_see_client (§4.6, §4.7).';

-- portal_client_ids(): the client whose portal_user_id is the signed-in client user.
create or replace function public.portal_client_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, extensions
as $$
  select c.id
  from public.clients c
  where public.is_client()
    and c.portal_user_id = auth.uid()
    and c.deleted_at is null
$$;

comment on function public.portal_client_ids() is
  'The client linked to the signed-in portal user through clients.portal_user_id (§7.22).';

-- staff_task_ids(): tasks a staff member can see (§4.1): assigned to them, they are the named
-- reviewer, or the task belongs to a client they can see. Partner/Manager: every task.
create or replace function public.staff_task_ids()
returns setof uuid
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_role public.app_role := public.app_role();
  v_me uuid;
begin
  if v_role in ('partner', 'manager') then
    return query select t.id from public.tasks t;
    return;
  end if;
  if v_role is distinct from 'employee' then
    return;
  end if;
  v_me := public.my_employee_id();
  if v_me is null then
    return;
  end if;
  return query
    select t.id from public.tasks t
    where t.assigned_employee_id = v_me or t.reviewer_employee_id = v_me
    union
    select t.id from public.tasks t
    where t.client_id in (select public.staff_client_ids());
end;
$$;

comment on function public.staff_task_ids() is
  'Tasks the calling staff member can see: assigned, named reviewer, or on a visible client (§4.1).';

create or replace function public.can_see_task(tid uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_role public.app_role := public.app_role();
  v_me uuid;
begin
  if tid is null or v_role is null or v_role = 'client' then
    return false;
  end if;
  if v_role in ('partner', 'manager') then
    return exists (select 1 from public.tasks t where t.id = tid);
  end if;
  v_me := public.my_employee_id();
  return exists (
    select 1 from public.tasks t
    where t.id = tid
      and (
        (v_me is not null and (t.assigned_employee_id = v_me or t.reviewer_employee_id = v_me))
        or public.can_see_client(t.client_id)
      )
  );
end;
$$;

comment on function public.can_see_task(uuid) is 'Scalar form of staff_task_ids() (§4.1).';

-- =============================================================================================
-- Guards for columns RLS can't restrict (§4.6: "INSERT/UPDATE for Partner/Manager, plus Employees
-- where the column set they may change is limited").
--
-- is_api_caller(): true when the statement comes straight from the API roles. Inside a SECURITY
-- DEFINER function (change_task_status and friends) current_user is the function owner, and for the
-- service role it is service_role, so the column guards step aside for those trusted paths.
-- MUST stay SECURITY INVOKER.
-- =============================================================================================
create or replace function public.is_api_caller()
returns boolean
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select current_user in ('authenticated', 'anon')
$$;

comment on function public.is_api_caller() is
  'True when current_user is an API role (authenticated/anon), i.e. not a SECURITY DEFINER function or the service role.';

-- assert_changed_only(old, new, allowed, what): raises a USER error naming the columns that changed
-- outside the allowed list (updated_at is always allowed).
create or replace function public.assert_changed_only(p_old jsonb, p_new jsonb, p_allowed text[], p_what text)
returns void
language plpgsql
immutable
set search_path = public, extensions
as $$
declare
  v_bad text[];
begin
  select array_agg(replace(n.key, '_', ' ') order by n.key)
    into v_bad
  from jsonb_each(p_new) n
  where not (n.key = any (coalesce(p_allowed, '{}'::text[]) || array['updated_at']))
    and n.value is distinct from (p_old -> n.key);

  if v_bad is not null then
    raise exception 'USER: You can''t change % on %. Ask a Manager or a Partner.', array_to_string(v_bad, ', '), p_what
      using errcode = 'P0001';
  end if;
end;
$$;

comment on function public.assert_changed_only(jsonb, jsonb, text[], text) is
  'Raises ''USER: You can''''t change <columns> on <what>'' when columns outside the allowed list differ (§4.6 column limits).';

-- try_uuid(text): the text as a uuid, or null (storage paths, §12).
create or replace function public.try_uuid(p text)
returns uuid
language plpgsql
immutable
set search_path = public, extensions
as $$
begin
  return p::uuid;
exception when others then
  return null;
end;
$$;

comment on function public.try_uuid(text) is 'Casts text to uuid, or null when it isn''t one.';

-- =============================================================================================
-- Grants: callable by signed-in users (policies run as the caller and need EXECUTE); never anon.
-- =============================================================================================
revoke execute on function
  public.app_role(), public.is_partner(), public.is_manager_or_partner(), public.is_staff(), public.is_client(),
  public.my_employee_id(), public.staff_employee_id(), public.can_see_client(uuid), public.can_open_whatsapp(uuid),
  public.staff_client_ids(), public.portal_client_ids(), public.staff_task_ids(), public.can_see_task(uuid),
  public.is_api_caller(), public.assert_changed_only(jsonb, jsonb, text[], text), public.try_uuid(text)
from public, anon;

grant execute on function
  public.app_role(), public.is_partner(), public.is_manager_or_partner(), public.is_staff(), public.is_client(),
  public.my_employee_id(), public.staff_employee_id(), public.can_see_client(uuid), public.can_open_whatsapp(uuid),
  public.staff_client_ids(), public.portal_client_ids(), public.staff_task_ids(), public.can_see_task(uuid),
  public.is_api_caller(), public.assert_changed_only(jsonb, jsonb, text[], text), public.try_uuid(text)
to authenticated, service_role;

update public.app_meta set value = '0030' where key = 'schema_version';
