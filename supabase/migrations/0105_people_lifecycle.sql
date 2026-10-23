-- 0105 · People: staff lifecycle, open-work checks, reassigning work, the team overview, profile
-- images, and who may correct attendance (§4.1, §4.5, §4.6, §7.1, §7.11, §7.12).
--
--   employee_role(eid)                 profiles.role (the authority) or, before a login exists,
--                                      employees.staff_role.
--   employee_open_work(eid)            what a person still holds: open tasks, open review items,
--                                      clients owned and on the team of, open notices and leads.
--   employees_open_work_guard          a person can't be disabled or deleted while they hold open
--                                      tasks or review items (§4.5 points 6 and 7), for every writer.
--   reassign_all_work(from, to)        the one-shot "Reassign all work to…" (§4.5 point 6): open
--                                      tasks, reviewer assignments, client ownership, team places,
--                                      open notices and open leads, logged on each client's timeline.
--   set_staff_active(eid, on, token)   disable / enable the record and the profile together, ending
--                                      covers for or by the person and closing their open session.
--   delete_staff(eid, token)           Partner only: soft delete, same open-work check.
--   change_staff_email(eid, email, t)  moves the profile and employee email together, after the
--                                      auth account has moved (server/people-admin.ts).
--   revoke_auth_sessions(uid)          service role only: ends every session of a login (role
--                                      change, password reset), so the change takes effect at once.
--   people_overview                    the team list (§7.11.1): role, login status, open work, last
--                                      seen, out of office today. security_invoker: the caller's RLS.
--   profile-images bucket              avatars (staff read) and Partners' signature images (owner
--                                      only; PDFs read them with the service role) (§7.1).
--   attendance_records_guard           corrections carry who and why; Managers correct Employees
--                                      only (§4.1, §7.12).

set search_path = public, extensions;

-- =============================================================================================
-- employee_role(eid)
-- =============================================================================================
create or replace function public.employee_role(p_employee uuid)
returns public.app_role
language sql
stable
security definer
set search_path = public, extensions
as $$
  select coalesce(p.role, e.staff_role)
  from public.employees e
  left join public.profiles p on p.id = e.profile_id
  where e.id = p_employee
$$;

comment on function public.employee_role(uuid) is
  'The role of an employees row: profiles.role once a login exists (the authority), else employees.staff_role (§4.5 point 8).';

-- =============================================================================================
-- employee_open_work(eid): counts only, never fees.
-- =============================================================================================
create or replace function public.employee_open_work(p_employee uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_tasks int;
  v_reviews int;
  v_owned int;
  v_team int;
  v_notices int;
  v_leads int;
begin
  if not (public.is_manager_or_partner() or (p_employee is not null and p_employee = public.staff_employee_id())) then
    raise exception 'USER: Only Partners and Managers can see someone else''s open work.' using errcode = 'P0001';
  end if;

  select count(*) into v_tasks from public.tasks t
  where t.assigned_employee_id = p_employee and t.deleted_at is null and t.status <> 'filed_done';
  select count(*) into v_reviews from public.tasks t
  where t.reviewer_employee_id = p_employee and t.deleted_at is null and t.status <> 'filed_done';
  select count(*) into v_owned from public.clients c
  where c.owner_employee_id = p_employee and c.deleted_at is null;
  select count(distinct tm.client_id) into v_team from public.client_team_members tm
  join public.clients c on c.id = tm.client_id and c.deleted_at is null
  where tm.employee_id = p_employee;
  select count(*) into v_notices from public.tax_notices n
  where n.assigned_employee_id = p_employee and n.status in ('open', 'reply_drafted', 'replied', 'hearing');

  -- Leads are money-side (§4.1): an Employee asking about themselves gets no lead count.
  if public.is_manager_or_partner() then
    select count(*) into v_leads from public.leads l
    where l.assigned_to = p_employee and l.deleted_at is null and l.status not in ('won', 'lost');
  else
    v_leads := 0;
  end if;

  return jsonb_build_object(
    'open_tasks', v_tasks,
    'review_tasks', v_reviews,
    'owned_clients', v_owned,
    'team_clients', v_team,
    'open_notices', v_notices,
    'open_leads', v_leads
  );
end;
$$;

comment on function public.employee_open_work(uuid) is
  'What a person still holds (§4.5): open tasks, open review items, clients owned / on the team of, open notices and (Partners/Managers only) open leads.';

-- =============================================================================================
-- employees_open_work_guard: no disabling or deleting a person who holds open tasks (§4.5).
-- Applies to every writer (the service role too): the work would be lost otherwise.
-- =============================================================================================
create or replace function public.employees_open_work_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_tasks int;
  v_reviews int;
  v_what text;
begin
  if (old.is_active and not new.is_active) or (old.deleted_at is null and new.deleted_at is not null) then
    select count(*) into v_tasks from public.tasks t
    where t.assigned_employee_id = old.id and t.deleted_at is null and t.status <> 'filed_done';
    select count(*) into v_reviews from public.tasks t
    where t.reviewer_employee_id = old.id and t.deleted_at is null and t.status <> 'filed_done';
    if v_tasks > 0 or v_reviews > 0 then
      v_what := concat_ws(' and ',
        case when v_tasks = 1 then '1 open task' when v_tasks > 1 then v_tasks || ' open tasks' end,
        case when v_reviews = 1 then '1 task to review' when v_reviews > 1 then v_reviews || ' tasks to review' end);
      raise exception 'USER: % still holds %. Reassign their work first.', old.full_name, v_what using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

create trigger employees_open_work_guard before update of is_active, deleted_at on public.employees
  for each row execute function public.employees_open_work_guard();

-- =============================================================================================
-- reassign_all_work(from, to) (§4.5 point 6)
-- =============================================================================================
create or replace function public.reassign_all_work(p_from_employee uuid, p_to_employee uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_role public.app_role := public.app_role();
  v_uid uuid := auth.uid();
  v_actor text;
  v_from_name text;
  v_from_role public.app_role;
  v_to_name text;
  v_to_ok boolean;
  v_tasks int := 0;
  v_tasks_reviewer_cleared int := 0;
  v_reviews int := 0;
  v_reviews_cleared int := 0;
  v_clients int := 0;
  v_team int := 0;
  v_notices int := 0;
  v_leads int := 0;
  v_client uuid;
  v_task_clients uuid[] := '{}';
  v_owned_clients uuid[] := '{}';
  v_team_clients uuid[] := '{}';
  v_all_clients uuid[];
begin
  if v_role is null or v_role not in ('partner', 'manager') then
    raise exception 'USER: Only Partners and Managers can reassign work.' using errcode = 'P0001';
  end if;
  if p_from_employee is null or p_to_employee is null then
    raise exception 'USER: Choose who the work moves to.' using errcode = 'P0001';
  end if;
  if p_from_employee = p_to_employee then
    raise exception 'USER: Choose someone else: the work is already theirs.' using errcode = 'P0001';
  end if;

  -- Lock both people so a disable or another reassignment can't run alongside this one.
  perform 1 from public.employees e where e.id in (p_from_employee, p_to_employee) order by e.id for update;

  select e.full_name, public.employee_role(e.id) into v_from_name, v_from_role
  from public.employees e where e.id = p_from_employee;
  if v_from_name is null then
    raise exception 'USER: That person wasn''t found.' using errcode = 'P0001';
  end if;
  select e.full_name, (e.is_active and e.deleted_at is null and coalesce(p.is_active, true))
    into v_to_name, v_to_ok
  from public.employees e left join public.profiles p on p.id = e.profile_id
  where e.id = p_to_employee;
  if v_to_name is null then
    raise exception 'USER: The person taking the work wasn''t found.' using errcode = 'P0001';
  end if;
  if not v_to_ok then
    raise exception 'USER: %''s account is disabled, so the work would be lost. Choose someone active.', v_to_name using errcode = 'P0001';
  end if;
  if v_role = 'manager' and v_from_role is distinct from 'employee' then
    raise exception 'USER: A Partner moves work for Managers and Partners.' using errcode = 'P0001';
  end if;

  select p.full_name into v_actor from public.profiles p where p.id = v_uid;

  -- 1. Open tasks assigned to them. Nobody reviews their own work: where the new assignee was the
  --    reviewer, the reviewer is cleared (and counted, so the screen can say so). The tasks wait for
  --    the new person's acceptance (tasks_guard, §7.6.3).
  select count(*) into v_tasks_reviewer_cleared from public.tasks t
  where t.assigned_employee_id = p_from_employee and t.deleted_at is null and t.status <> 'filed_done'
    and t.reviewer_employee_id = p_to_employee;
  with moved as (
    update public.tasks t
       set assigned_employee_id = p_to_employee,
           reviewer_employee_id = case when t.reviewer_employee_id = p_to_employee then null else t.reviewer_employee_id end
     where t.assigned_employee_id = p_from_employee and t.deleted_at is null and t.status <> 'filed_done'
    returning t.client_id
  )
  select count(*), coalesce(array_agg(distinct client_id), '{}') into v_tasks, v_task_clients from moved;

  -- 2. Open tasks they review. Where the new person is the assignee, the reviewer is cleared.
  select count(*) into v_reviews_cleared from public.tasks t
  where t.reviewer_employee_id = p_from_employee and t.deleted_at is null and t.status <> 'filed_done'
    and t.assigned_employee_id = p_to_employee;
  with moved as (
    update public.tasks t
       set reviewer_employee_id = case when t.assigned_employee_id = p_to_employee then null else p_to_employee end
     where t.reviewer_employee_id = p_from_employee and t.deleted_at is null and t.status <> 'filed_done'
    returning t.client_id
  )
  select count(*), v_task_clients || coalesce(array_agg(distinct client_id), '{}') into v_reviews, v_task_clients from moved;
  v_reviews := v_reviews - v_reviews_cleared;

  -- 3. Client ownership (clients in the recycle bin too, so a restore doesn't land on a disabled owner).
  with moved as (
    update public.clients c set owner_employee_id = p_to_employee
     where c.owner_employee_id = p_from_employee
    returning c.id, c.deleted_at
  )
  select count(*) filter (where deleted_at is null), coalesce(array_agg(id) filter (where deleted_at is null), '{}')
    into v_clients, v_owned_clients from moved;

  -- 4. Their places on engagement teams (same team role; an existing place is kept, not doubled).
  insert into public.client_team_members (client_id, employee_id, team_role)
  select tm.client_id, p_to_employee, tm.team_role
  from public.client_team_members tm
  where tm.employee_id = p_from_employee
  on conflict (client_id, employee_id, team_role) do nothing;
  with removed as (
    delete from public.client_team_members tm where tm.employee_id = p_from_employee returning tm.client_id
  )
  select count(distinct client_id), coalesce(array_agg(distinct client_id), '{}') into v_team, v_team_clients from removed;

  -- 5. Open notices and open leads.
  update public.tax_notices n set assigned_employee_id = p_to_employee
   where n.assigned_employee_id = p_from_employee and n.status in ('open', 'reply_drafted', 'replied', 'hearing');
  get diagnostics v_notices = row_count;
  update public.leads l set assigned_to = p_to_employee
   where l.assigned_to = p_from_employee and l.deleted_at is null and l.status not in ('won', 'lost');
  get diagnostics v_leads = row_count;

  -- 6. The story: one entry on each affected client's timeline (no fees), one on the person's history.
  select coalesce(array_agg(distinct x), '{}') into v_all_clients
  from unnest(v_task_clients || v_owned_clients || v_team_clients) as x
  where x is not null;
  foreach v_client in array v_all_clients loop
    insert into public.client_timeline_events (client_id, event_type, title, description, metadata, performed_by)
    select v_client,
           'employee_assigned',
           format('%s''s work moved to %s', v_from_name, v_to_name),
           concat_ws(' · ',
             case when v_client = any (v_owned_clients) then 'Owner changed' end,
             case when v_client = any (v_team_clients) then 'Team place moved' end,
             case when v_client = any (v_task_clients) then 'Open tasks moved' end,
             case when v_actor is not null then 'by ' || v_actor end),
           jsonb_build_object('from_employee_id', p_from_employee, 'to_employee_id', p_to_employee, 'reason', 'reassign_all_work'),
           v_uid
    from public.clients c where c.id = v_client;
  end loop;

  insert into public.activity_logs (entity_type, entity_id, action, description, user_id, user_name, metadata)
  values (
    'employee', p_from_employee, 'work_reassigned',
    format('All work moved to %s: %s open tasks, %s review items, %s clients owned, %s team places, %s notices, %s leads.',
      v_to_name, v_tasks, v_reviews + v_reviews_cleared, v_clients, v_team, v_notices, v_leads),
    v_uid, v_actor,
    jsonb_build_object('to_employee_id', p_to_employee, 'tasks', v_tasks, 'reviews', v_reviews,
      'reviews_cleared', v_reviews_cleared, 'tasks_reviewer_cleared', v_tasks_reviewer_cleared,
      'clients', v_clients, 'team', v_team, 'notices', v_notices, 'leads', v_leads)
  );

  return jsonb_build_object(
    'tasks', v_tasks,
    'tasks_reviewer_cleared', v_tasks_reviewer_cleared,
    'reviews', v_reviews,
    'reviews_cleared', v_reviews_cleared,
    'clients', v_clients,
    'team', v_team,
    'notices', v_notices,
    'leads', v_leads,
    'client_ids', to_jsonb(v_all_clients)
  );
end;
$$;

comment on function public.reassign_all_work(uuid, uuid) is
  '§4.5 "Reassign all work to…": moves open tasks, reviewer assignments, client ownership, team places, open notices and open leads in one transaction, and logs it on each client''s timeline.';

-- =============================================================================================
-- set_staff_active / delete_staff
-- =============================================================================================
create or replace function public.staff_record_conflict(p_name text, p_at timestamptz)
returns text
language sql
immutable
set search_path = public, extensions
as $$
  select format('USER: %s''s record was changed at %s, after you opened it. Reload to see the changes.',
    p_name, to_char(p_at at time zone 'Asia/Kolkata', 'HH24:MI'))
$$;

create or replace function public.set_staff_active(p_employee uuid, p_active boolean, p_updated_at timestamptz)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_role public.app_role := public.app_role();
  v_uid uuid := auth.uid();
  v_row public.employees%rowtype;
  v_subject_role public.app_role;
  v_partners int;
  v_covers int := 0;
  v_sessions int := 0;
  v_updated timestamptz;
begin
  if v_role is null or v_role not in ('partner', 'manager') then
    raise exception 'USER: Only Partners and Managers can disable or enable a team member.' using errcode = 'P0001';
  end if;
  select * into v_row from public.employees e where e.id = p_employee for update;
  if not found or v_row.deleted_at is not null then
    raise exception 'USER: That person wasn''t found.' using errcode = 'P0001';
  end if;
  if v_row.profile_id = v_uid then
    raise exception 'USER: You can''t disable or enable your own account. Ask another Partner.' using errcode = 'P0001';
  end if;
  v_subject_role := public.employee_role(p_employee);
  if v_role = 'manager' and v_subject_role is distinct from 'employee' then
    raise exception 'USER: Only a Partner can disable or enable a Manager or a Partner.' using errcode = 'P0001';
  end if;
  if p_updated_at is null or v_row.updated_at <> p_updated_at then
    raise exception '%', public.staff_record_conflict(v_row.full_name, v_row.updated_at) using errcode = 'P0001';
  end if;
  if v_row.is_active = p_active then
    raise exception 'USER: % is already %.', v_row.full_name, case when p_active then 'active' else 'disabled' end using errcode = 'P0001';
  end if;

  if not p_active and v_subject_role = 'partner' then
    select count(*) into v_partners
    from public.profiles p join public.employees e on e.profile_id = p.id
    where p.role = 'partner' and p.is_active and e.is_active and e.deleted_at is null and e.id <> p_employee;
    if v_partners = 0 then
      raise exception 'USER: % is the only active Partner. Make someone else a Partner first.', v_row.full_name using errcode = 'P0001';
    end if;
  end if;

  -- employees first: employees_open_work_guard refuses while they hold open tasks.
  update public.employees set is_active = p_active where id = p_employee returning updated_at into v_updated;
  if v_row.profile_id is not null then
    update public.profiles set is_active = p_active where id = v_row.profile_id;
  end if;

  if not p_active then
    -- §4.7: no cover for or by a disabled person.
    update public.client_covers c
       set revoked_at = now(), revoked_by = v_uid, revoke_reason = 'Account disabled'
     where (c.cover_employee_id = p_employee or c.absent_employee_id = p_employee)
       and c.revoked_at is null and c.ends_at > now();
    get diagnostics v_covers = row_count;
    -- §7.12: the open session closes at its last activity.
    update public.employee_sessions s
       set is_active = false, logout_at = s.last_active_at, duration_minutes = s.active_minutes, closed_reason = 'logout'
     where s.employee_id = p_employee and s.is_active;
    get diagnostics v_sessions = row_count;
  end if;

  insert into public.activity_logs (entity_type, entity_id, action, description, user_id, user_name)
  select 'employee', p_employee, case when p_active then 'enabled' else 'disabled' end,
         format('%s was %s.', v_row.full_name, case when p_active then 'enabled' else 'disabled' end),
         v_uid, p.full_name
  from public.profiles p where p.id = v_uid;

  return jsonb_build_object('updated_at', v_updated, 'profile_id', v_row.profile_id, 'covers_ended', v_covers, 'sessions_closed', v_sessions);
end;
$$;

comment on function public.set_staff_active(uuid, boolean, timestamptz) is
  '§4.5 point 6: disables or enables a team member (record and profile together), ends covers for or by them and closes their open session. Blocked while they hold open tasks (employees_open_work_guard).';

create or replace function public.delete_staff(p_employee uuid, p_updated_at timestamptz)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.employees%rowtype;
  v_partners int;
begin
  if not public.is_partner() then
    raise exception 'USER: Only a Partner can delete a team member.' using errcode = 'P0001';
  end if;
  select * into v_row from public.employees e where e.id = p_employee for update;
  if not found or v_row.deleted_at is not null then
    raise exception 'USER: That person wasn''t found.' using errcode = 'P0001';
  end if;
  if v_row.profile_id = v_uid then
    raise exception 'USER: You can''t delete your own record. Ask another Partner.' using errcode = 'P0001';
  end if;
  if p_updated_at is null or v_row.updated_at <> p_updated_at then
    raise exception '%', public.staff_record_conflict(v_row.full_name, v_row.updated_at) using errcode = 'P0001';
  end if;
  if public.employee_role(p_employee) = 'partner' then
    select count(*) into v_partners
    from public.profiles p join public.employees e on e.profile_id = p.id
    where p.role = 'partner' and p.is_active and e.is_active and e.deleted_at is null and e.id <> p_employee;
    if v_partners = 0 then
      raise exception 'USER: % is the only active Partner. Make someone else a Partner first.', v_row.full_name using errcode = 'P0001';
    end if;
  end if;

  update public.employees
     set deleted_at = now(), deleted_by = v_uid, is_active = false
   where id = p_employee;
  if v_row.profile_id is not null then
    update public.profiles set is_active = false where id = v_row.profile_id;
  end if;
  update public.client_covers c
     set revoked_at = now(), revoked_by = v_uid, revoke_reason = 'Team member deleted'
   where (c.cover_employee_id = p_employee or c.absent_employee_id = p_employee)
     and c.revoked_at is null and c.ends_at > now();
  update public.employee_sessions s
     set is_active = false, logout_at = s.last_active_at, duration_minutes = s.active_minutes, closed_reason = 'logout'
   where s.employee_id = p_employee and s.is_active;

  insert into public.activity_logs (entity_type, entity_id, action, description, user_id, user_name)
  select 'employee', p_employee, 'deleted', format('%s was deleted. Their history is kept.', v_row.full_name), v_uid, p.full_name
  from public.profiles p where p.id = v_uid;

  return jsonb_build_object('profile_id', v_row.profile_id);
end;
$$;

comment on function public.delete_staff(uuid, timestamptz) is
  '§4.5 point 7: Partner-only soft delete of a team member, with the same open-work check as disabling.';

-- =============================================================================================
-- change_staff_email(eid, email, token): the profile and the record move together, after the auth
-- account (server/people-admin.ts moves that first, with the service role).
-- =============================================================================================
create or replace function public.change_staff_email(p_employee uuid, p_email text, p_updated_at timestamptz)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_role public.app_role := public.app_role();
  v_row public.employees%rowtype;
  v_email citext := lower(btrim(p_email))::citext;
  v_updated timestamptz;
begin
  if v_role is null or v_role not in ('partner', 'manager') then
    raise exception 'USER: Only Partners and Managers can change a team member''s email.' using errcode = 'P0001';
  end if;
  select * into v_row from public.employees e where e.id = p_employee for update;
  if not found or v_row.deleted_at is not null then
    raise exception 'USER: That person wasn''t found.' using errcode = 'P0001';
  end if;
  if v_role = 'manager' and public.employee_role(p_employee) is distinct from 'employee' then
    raise exception 'USER: Only a Partner can change a Manager''s or a Partner''s email.' using errcode = 'P0001';
  end if;
  if p_updated_at is null or v_row.updated_at <> p_updated_at then
    raise exception '%', public.staff_record_conflict(v_row.full_name, v_row.updated_at) using errcode = 'P0001';
  end if;
  if v_email is null or v_email::text !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'USER: Enter a valid email address, like name@example.com.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.employees e where e.email = v_email and e.id <> p_employee)
     or exists (select 1 from public.profiles p where p.email = v_email and p.id is distinct from v_row.profile_id) then
    raise exception 'USER: Someone already uses that email address.' using errcode = 'P0001';
  end if;

  update public.employees set email = v_email where id = p_employee returning updated_at into v_updated;
  if v_row.profile_id is not null then
    update public.profiles set email = v_email where id = v_row.profile_id;
  end if;
  return v_updated;
end;
$$;

comment on function public.change_staff_email(uuid, text, timestamptz) is
  '§4.5 point 4: moves a team member''s email on the profile and the employee record together (the auth account moves first).';

-- =============================================================================================
-- revoke_auth_sessions(uid): service role only (server/people-admin.ts).
-- =============================================================================================
create or replace function public.revoke_auth_sessions(p_user uuid)
returns int
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_count int := 0;
begin
  if p_user is null then
    return 0;
  end if;
  -- Refresh tokens go with their session. The Auth schema exists on Supabase; a bare Postgres
  -- (the local test harness) has no sessions to end.
  if to_regclass('auth.refresh_tokens') is not null then
    execute 'update auth.refresh_tokens set revoked = true where user_id::text = $1::text and not coalesce(revoked, false)' using p_user;
  end if;
  if to_regclass('auth.sessions') is not null then
    execute 'delete from auth.sessions where user_id = $1' using p_user;
    get diagnostics v_count = row_count;
  end if;
  return v_count;
end;
$$;

comment on function public.revoke_auth_sessions(uuid) is
  'Service role only: ends every session of a login (role change, password reset, §4.5 point 5). Returns the sessions ended.';

-- =============================================================================================
-- people_overview (§7.11.1). security_invoker: Partners and Managers see everyone; anyone else
-- sees only their own row (employees RLS). Never cost rates or billing rates.
-- =============================================================================================
create view public.people_overview with (security_invoker = true) as
select
  e.id,
  e.profile_id,
  e.full_name,
  e.email,
  e.phone,
  e.whatsapp,
  e.department,
  e.designation,
  e.date_of_joining,
  coalesce(p.role, e.staff_role) as role,
  case
    when not e.is_active or (p.id is not null and not p.is_active) then 'disabled'
    when e.profile_id is null then 'no_login'
    else 'active'
  end as login_status,
  (e.is_active and coalesce(p.is_active, true)) as is_active,
  e.vault_access,
  p.avatar_path,
  p.last_login_at,
  p.must_change_password,
  (select count(*) from public.tasks t
    where t.assigned_employee_id = e.id and t.deleted_at is null and t.status <> 'filed_done')::int as open_tasks,
  (select count(*) from public.tasks t
    where t.reviewer_employee_id = e.id and t.deleted_at is null and t.status <> 'filed_done')::int as review_tasks,
  (select max(s.last_active_at) from public.employee_sessions s where s.employee_id = e.id) as last_seen_at,
  (select s.last_active_at from public.employee_sessions s
    where s.employee_id = e.id and s.is_active order by s.last_active_at desc limit 1) as open_session_active_at,
  exists (
    select 1 from public.employee_leave l
    where l.employee_id = e.id and l.status = 'approved'
      and public.today_ist() between l.start_date and l.end_date
  ) as on_leave_today,
  e.created_at,
  e.updated_at
from public.employees e
left join public.profiles p on p.id = e.profile_id
where e.deleted_at is null
  and (select public.is_staff());

comment on view public.people_overview is
  'The team list (§7.11.1): role, login status, open work, last seen, out of office today. Caller''s RLS applies; no rates.';

revoke all on public.people_overview from anon, public, authenticated;
grant select on public.people_overview to authenticated, service_role;

-- =============================================================================================
-- profile-images: avatars and Partners' signature images (§7.1). Private bucket; files are
-- served through 60-second signed URLs created under the viewer's session.
--   <user_id>/avatar-<uuid>.<png|jpg|webp>      the owner writes; every staff member reads
--   <user_id>/signature-<uuid>.<png|jpg>        a Partner writes their own; only they read it
--                                               (PDFs read it with the service role)
-- =============================================================================================
insert into storage.buckets (id, name, public, file_size_limit)
values ('profile-images', 'profile-images', false, 2097152)
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit;

create or replace function public.profile_image_kind(p_name text)
returns text
language sql
immutable
set search_path = public, extensions
as $$
  select case
    when p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/avatar-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$' then 'avatar'
    when p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/signature-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg)$' then 'signature'
  end
$$;

comment on function public.profile_image_kind(text) is
  'avatar | signature for a well-formed profile-images object name (<user_id>/avatar-<uuid>.<ext>), else null.';

create policy profile_images_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'profile-images'
    and (
      (public.profile_image_kind(name) = 'avatar' and public.is_staff())
      or (public.profile_image_kind(name) = 'signature' and public.is_partner()
          and public.storage_first_folder_uuid(name) = auth.uid())
    )
  );
create policy profile_images_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'profile-images'
    and public.is_staff()
    and public.storage_first_folder_uuid(name) = auth.uid()
    and (public.profile_image_kind(name) = 'avatar'
         or (public.profile_image_kind(name) = 'signature' and public.is_partner()))
  );
create policy profile_images_update on storage.objects
  for update to authenticated
  using (bucket_id = 'profile-images' and public.is_staff() and public.storage_first_folder_uuid(name) = auth.uid())
  with check (
    bucket_id = 'profile-images'
    and public.is_staff()
    and public.storage_first_folder_uuid(name) = auth.uid()
    and (public.profile_image_kind(name) = 'avatar'
         or (public.profile_image_kind(name) = 'signature' and public.is_partner()))
  );
create policy profile_images_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'profile-images' and public.is_staff() and public.storage_first_folder_uuid(name) = auth.uid());

-- profiles.avatar_path / signature_path point only at the owner's own, well-formed files.
create or replace function public.profiles_image_paths_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if new.avatar_path is distinct from old.avatar_path and new.avatar_path is not null then
    if public.profile_image_kind(new.avatar_path) is distinct from 'avatar'
       or public.storage_first_folder_uuid(new.avatar_path) is distinct from new.id then
      raise exception 'USER: Upload the photo again.' using errcode = 'P0001';
    end if;
  end if;
  if new.signature_path is distinct from old.signature_path and new.signature_path is not null then
    if new.role <> 'partner' then
      raise exception 'USER: Only Partners keep a signature image.' using errcode = 'P0001';
    end if;
    if public.profile_image_kind(new.signature_path) is distinct from 'signature'
       or public.storage_first_folder_uuid(new.signature_path) is distinct from new.id then
      raise exception 'USER: Upload the signature again.' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

create trigger profiles_image_paths_guard before update of avatar_path, signature_path on public.profiles
  for each row execute function public.profiles_image_paths_guard();

-- =============================================================================================
-- attendance_records_guard (§7.12 corrections; §4.1 Managers don't touch Partners or Managers).
-- Jobs write with the service role and step past it (is_api_caller()).
-- =============================================================================================
create or replace function public.attendance_records_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_role public.app_role;
  v_subject public.app_role;
begin
  if not public.is_api_caller() then
    return new;
  end if;
  v_role := public.app_role();
  v_subject := public.employee_role(new.employee_id);
  if v_role = 'manager' and v_subject is distinct from 'employee' then
    raise exception 'USER: Managers correct Employees'' attendance; a Partner corrects Managers'' and Partners''.' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and new.employee_id is distinct from old.employee_id then
    raise exception 'USER: An attendance record can''t be moved to another person.' using errcode = 'P0001';
  end if;
  if new.corrected_by is distinct from auth.uid() or nullif(btrim(new.correction_reason), '') is null then
    raise exception 'USER: Give a reason for the correction.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger attendance_records_guard before insert or update on public.attendance_records
  for each row execute function public.attendance_records_guard();

-- =============================================================================================
-- Grants
-- =============================================================================================
revoke execute on function
  public.employee_role(uuid),
  public.employee_open_work(uuid),
  public.reassign_all_work(uuid, uuid),
  public.set_staff_active(uuid, boolean, timestamptz),
  public.delete_staff(uuid, timestamptz),
  public.change_staff_email(uuid, text, timestamptz),
  public.staff_record_conflict(text, timestamptz),
  public.profile_image_kind(text)
from public, anon;
grant execute on function
  public.employee_role(uuid),
  public.employee_open_work(uuid),
  public.reassign_all_work(uuid, uuid),
  public.set_staff_active(uuid, boolean, timestamptz),
  public.delete_staff(uuid, timestamptz),
  public.change_staff_email(uuid, text, timestamptz),
  public.staff_record_conflict(text, timestamptz),
  public.profile_image_kind(text)
to authenticated, service_role;

revoke execute on function public.revoke_auth_sessions(uuid) from public, anon, authenticated;
grant execute on function public.revoke_auth_sessions(uuid) to service_role;

revoke execute on function public.employees_open_work_guard(), public.profiles_image_paths_guard(), public.attendance_records_guard()
  from public, anon, authenticated;
