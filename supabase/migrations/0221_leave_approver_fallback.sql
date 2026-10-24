-- 0221 · Leave notices reach someone who can decide them (§7.11.3, §9 "Leave requested / decided:
-- Approver"; wave C integration).
--
-- An Employee's leave went to the Managers only. A firm with no active Manager (a small office, or
-- the Manager left) got no notice at all, though a Partner can decide anyone's leave (decide_leave,
-- 0106). leave_approver_role(employee) names who is told:
--   'manager'  the person is an Employee and at least one Manager can sign in;
--   'partner'  otherwise (Managers' and Partners' leave, or no active Manager).
-- It answers only that, for staff; it reveals no one's identity.

set search_path = public, extensions;

create or replace function public.leave_approver_role(p_employee_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  -- Staff only (is_api_caller() can't tell here: in a definer function current_user is the owner).
  if not public.is_staff() and auth.jwt() is not null and coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'USER: Only the team can ask who decides leave.' using errcode = 'P0001';
  end if;
  if public.employee_role(p_employee_id) is distinct from 'employee' then
    return 'partner';
  end if;
  if exists (
    select 1
    from public.profiles p
    join public.employees e on e.profile_id = p.id
    where p.role = 'manager' and p.is_active and e.is_active and e.deleted_at is null
  ) then
    return 'manager';
  end if;
  return 'partner';
end;
$$;

comment on function public.leave_approver_role(uuid) is
  'Who is told about a leave request: ''manager'' for an Employee while an active Manager exists, else ''partner'' (0221).';

revoke execute on function public.leave_approver_role(uuid) from public, anon;
grant execute on function public.leave_approver_role(uuid) to authenticated, service_role;
