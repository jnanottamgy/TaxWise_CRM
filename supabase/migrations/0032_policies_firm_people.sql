-- 0032 · RLS: firm settings and people (§4.1, §4.5, §4.6, §7.11, §7.12, §7.21).
--
-- Policy pattern (all policies are TO authenticated; anon gets nothing): helper calls are wrapped in
-- (select …) so Postgres evaluates them once per statement, not once per row.

set search_path = public, extensions;

-- =============================================================================================
-- firm_settings: SELECT all staff; UPDATE Partner only (§4.6). Clients and the public quotation
-- page read the public subset through public_firm_profile().
-- =============================================================================================
create policy firm_settings_select_staff on public.firm_settings
  for select to authenticated using ((select public.is_staff()));
create policy firm_settings_insert_partner on public.firm_settings
  for insert to authenticated with check ((select public.is_partner()));
create policy firm_settings_update_partner on public.firm_settings
  for update to authenticated using ((select public.is_partner())) with check ((select public.is_partner()));

-- public_firm_profile(): name, address, GSTIN, phone, email, website, logo, bank/UPI — what the
-- public /q/[token] page, the portal's Pay dialog and PDFs show (§4.6). Public by design.
create or replace function public.public_firm_profile()
returns table (
  firm_name text,
  legal_name text,
  tagline text,
  address text,
  city text,
  state_code char(2),
  pincode char(6),
  phone text,
  email text,
  website text,
  gstin text,
  logo_path text,
  logo_updated_at timestamptz,
  bank_name text,
  bank_account_name text,
  bank_account_number text,
  bank_ifsc text,
  bank_branch text,
  upi_id text,
  upi_payee_name text
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    fs.firm_name, fs.legal_name, fs.tagline, fs.address, fs.city, fs.state_code, fs.pincode,
    fs.phone, fs.email, fs.website, fs.gstin::text, fs.logo_path, fs.logo_updated_at,
    fs.bank_name, fs.bank_account_name, fs.bank_account_number, fs.bank_ifsc, fs.bank_branch,
    fs.upi_id, fs.upi_payee_name
  from public.firm_settings fs
  where fs.id = 1
$$;

comment on function public.public_firm_profile() is
  'The public subset of firm_settings (name, address, GSTIN, phone, email, website, logo, bank/UPI) for the quotation page, portal and PDFs (§4.6).';

revoke execute on function public.public_firm_profile() from public;
grant execute on function public.public_firm_profile() to anon, authenticated, service_role;

-- =============================================================================================
-- profiles (§4.4, §4.5, §4.6)
--   SELECT: your own row (always, so a disabled person can be told so); Partners and Managers see
--           every staff profile.
--   UPDATE: your own row (safe columns only, see the trigger); Partners any staff profile;
--           Managers Employee profiles only (and they stay Employees).
--   INSERT / DELETE: none through the API (logins are created by the service role).
-- =============================================================================================
create policy profiles_select_own on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy profiles_select_staff on public.profiles
  for select to authenticated using ((select public.is_manager_or_partner()) and role <> 'client');

create policy profiles_update_own on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy profiles_update_partner on public.profiles
  for update to authenticated
  using ((select public.is_partner()) and role <> 'client')
  with check ((select public.is_partner()) and role <> 'client');
create policy profiles_update_manager on public.profiles
  for update to authenticated
  using ((select public.app_role()) = 'manager' and role = 'employee')
  with check ((select public.app_role()) = 'manager' and role = 'employee');

-- Nobody changes their own role, access, email or forced-password flag (§4.4, §4.6, §0.1 rule 9).
create or replace function public.profiles_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if not public.is_api_caller() then
    return new;
  end if;
  if new.id is distinct from old.id then
    raise exception 'USER: A profile can''t be moved to another login.' using errcode = 'P0001';
  end if;
  if old.id = auth.uid() and (
    new.role is distinct from old.role
    or new.is_active is distinct from old.is_active
    or new.must_change_password is distinct from old.must_change_password
    or new.email is distinct from old.email
  ) then
    raise exception 'USER: Your role, sign-in email and access are managed by a Partner; they can''t be changed from your own profile.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger profiles_guard before update on public.profiles
  for each row execute function public.profiles_guard();

-- =============================================================================================
-- employees (§4.5, §4.6)
--   SELECT: own row; Partners and Managers all.
--   cost_rate_per_hour is a Partner-only column (§5.2): not selectable through the API at all;
--   Partners read it through employee_cost_rates. (Never select('*') from employees.)
--   INSERT/UPDATE: Partners; Managers only Employees, without vault access or cost rates (§4.5).
--   DELETE (purge): Partner.
-- =============================================================================================
create policy employees_select_own on public.employees
  for select to authenticated using (profile_id = (select auth.uid()));
create policy employees_select_staff on public.employees
  for select to authenticated using ((select public.is_manager_or_partner()));

create policy employees_insert_partner on public.employees
  for insert to authenticated with check ((select public.is_partner()));
create policy employees_insert_manager on public.employees
  for insert to authenticated
  with check ((select public.app_role()) = 'manager' and staff_role = 'employee' and not vault_access and cost_rate_per_hour is null);

create policy employees_update_partner on public.employees
  for update to authenticated using ((select public.is_partner())) with check ((select public.is_partner()));
create policy employees_update_manager on public.employees
  for update to authenticated
  using (
    (select public.app_role()) = 'manager'
    and staff_role = 'employee'
    and not exists (select 1 from public.profiles p where p.id = employees.profile_id and p.role <> 'employee')
  )
  with check ((select public.app_role()) = 'manager' and staff_role = 'employee');

create policy employees_delete_partner on public.employees
  for delete to authenticated using ((select public.is_partner()));

revoke select on public.employees from authenticated;
grant select (
  id, profile_id, full_name, email, phone, whatsapp, department, designation, date_of_joining, staff_role,
  billing_rate_per_hour, vault_access, is_active, deleted_at, deleted_by, created_at, updated_at
) on public.employees to authenticated;

-- Managers manage Employees but not vault access, cost rates, roles or deletion (§4.1, §4.5).
create or replace function public.employees_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if not public.is_api_caller() or public.is_partner() then
    return new;
  end if;
  if public.app_role() = 'manager' and (
    new.vault_access is distinct from old.vault_access
    or new.cost_rate_per_hour is distinct from old.cost_rate_per_hour
    or new.staff_role is distinct from old.staff_role
    or new.profile_id is distinct from old.profile_id
    or new.deleted_at is distinct from old.deleted_at
  ) then
    raise exception 'USER: Only a Partner can change vault access, cost rates, roles or delete a team member.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger employees_guard before update on public.employees
  for each row execute function public.employees_guard();

-- employee_cost_rates: the Partner-only cost rate (§5.2), plus the billing rate beside it.
create view public.employee_cost_rates with (security_invoker = false, security_barrier = true) as
select e.id, e.full_name, e.billing_rate_per_hour, e.cost_rate_per_hour
from public.employees e
where public.is_partner();

comment on view public.employee_cost_rates is 'Partner-only: employees.cost_rate_per_hour (§5.2).';

-- employee_directory: the minimal colleague directory every staff member can read (§4.6).
create view public.employee_directory with (security_invoker = false, security_barrier = true) as
select
  e.id,
  e.profile_id,
  e.full_name,
  e.designation,
  p.avatar_path,
  (e.is_active and e.deleted_at is null and coalesce(p.is_active, true)) as is_active
from public.employees e
left join public.profiles p on p.id = e.profile_id
where public.is_staff();

comment on view public.employee_directory is 'Colleague directory for staff: name, designation, avatar (§4.6).';

revoke all on public.employee_cost_rates, public.employee_directory from anon, public;
grant select on public.employee_cost_rates, public.employee_directory to authenticated, service_role;

-- =============================================================================================
-- employee_leave (§7.11.3): Partners/Managers all; Employees their own requests.
-- Managers decide Employees' leave; Partners decide Managers' and Partners' (trigger).
-- =============================================================================================
create policy employee_leave_select on public.employee_leave
  for select to authenticated
  using ((select public.is_manager_or_partner()) or employee_id = (select public.staff_employee_id()));
create policy employee_leave_insert on public.employee_leave
  for insert to authenticated
  with check (
    (select public.is_manager_or_partner())
    or (employee_id = (select public.staff_employee_id()) and status = 'requested'
        and decided_by is null and decided_at is null and not no_cover_needed)
  );
create policy employee_leave_update on public.employee_leave
  for update to authenticated
  using ((select public.is_manager_or_partner()) or employee_id = (select public.staff_employee_id()))
  with check ((select public.is_manager_or_partner()) or employee_id = (select public.staff_employee_id()));
create policy employee_leave_delete on public.employee_leave
  for delete to authenticated
  using ((select public.is_manager_or_partner()) or (employee_id = (select public.staff_employee_id()) and status = 'requested'));

create or replace function public.employee_leave_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_role public.app_role;
  v_own boolean;
  v_subject_role public.app_role;
begin
  if not public.is_api_caller() then
    return new;
  end if;
  v_role := public.app_role();
  v_own := old.employee_id = public.my_employee_id();

  if new.employee_id is distinct from old.employee_id then
    raise exception 'USER: A leave request can''t be moved to another person.' using errcode = 'P0001';
  end if;

  if v_role = 'employee' or (v_own and v_role = 'manager' and (
       new.decided_by is distinct from old.decided_by or new.status not in ('requested', 'cancelled')
     )) then
    -- Your own request: edit it while it's requested, or cancel it; the decision isn't yours.
    perform public.assert_changed_only(to_jsonb(old), to_jsonb(new),
      array['start_date', 'end_date', 'type', 'half_day', 'reason', 'status'], 'your leave request');
    if new.status is distinct from old.status and new.status <> 'cancelled' then
      raise exception 'USER: You can cancel your own leave request, but not approve or decline it.' using errcode = 'P0001';
    end if;
    if old.status <> 'requested' and (new.start_date, new.end_date, new.type, new.half_day)
         is distinct from (old.start_date, old.end_date, old.type, old.half_day) then
      raise exception 'USER: Only a leave request that hasn''t been decided can be changed. Cancel it and ask again.' using errcode = 'P0001';
    end if;
    return new;
  end if;

  if v_role = 'manager' and (
    new.status is distinct from old.status or new.decided_by is distinct from old.decided_by
    or new.decided_at is distinct from old.decided_at or new.decision_note is distinct from old.decision_note
  ) then
    select coalesce(p.role, e.staff_role) into v_subject_role
    from public.employees e left join public.profiles p on p.id = e.profile_id
    where e.id = old.employee_id;
    if v_subject_role is distinct from 'employee' then
      raise exception 'USER: Managers decide Employees'' leave; a Partner decides leave for Managers and Partners.'
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

create trigger employee_leave_guard before update on public.employee_leave
  for each row execute function public.employee_leave_guard();

-- =============================================================================================
-- employee_sessions (§7.12): Partners/Managers all, Employees their own. Written only by the
-- presence route handlers and jobs (service role).
-- =============================================================================================
create policy employee_sessions_select on public.employee_sessions
  for select to authenticated
  using ((select public.is_manager_or_partner()) or employee_id = (select public.staff_employee_id()));
revoke insert, update, delete on public.employee_sessions from authenticated;

-- attendance_records (§7.12): corrections by Partners/Managers with a reason; jobs write the rest.
create policy attendance_records_select on public.attendance_records
  for select to authenticated
  using ((select public.is_manager_or_partner()) or employee_id = (select public.staff_employee_id()));
create policy attendance_records_insert on public.attendance_records
  for insert to authenticated with check ((select public.is_manager_or_partner()));
create policy attendance_records_update on public.attendance_records
  for update to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));
create policy attendance_records_delete on public.attendance_records
  for delete to authenticated using ((select public.is_partner()));

-- employee_activities (§5.2): append-only feed. Own rows for Employees.
create policy employee_activities_select on public.employee_activities
  for select to authenticated
  using ((select public.is_manager_or_partner()) or employee_id = (select public.staff_employee_id()));
create policy employee_activities_insert on public.employee_activities
  for insert to authenticated
  with check (
    (select public.is_manager_or_partner())
    or (employee_id = (select public.staff_employee_id()) and user_id = (select auth.uid()))
  );
revoke update, delete on public.employee_activities from authenticated;

-- holidays (§7.11.3, §7.21): every staff member reads; Partners edit.
create policy holidays_select on public.holidays
  for select to authenticated using ((select public.is_staff()));
create policy holidays_insert on public.holidays
  for insert to authenticated with check ((select public.is_partner()));
create policy holidays_update on public.holidays
  for update to authenticated using ((select public.is_partner())) with check ((select public.is_partner()));
create policy holidays_delete on public.holidays
  for delete to authenticated using ((select public.is_partner()));

revoke execute on function public.profiles_guard(), public.employees_guard(), public.employee_leave_guard()
  from public, anon, authenticated;

update public.app_meta set value = '0032' where key = 'schema_version';
