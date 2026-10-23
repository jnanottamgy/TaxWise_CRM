-- 0184 · WhatsApp housekeeping (§7.25.10 house rule 5, §8 Mon 08:45, §7.25.7).
--
--   record_whatsapp_devices_review(number)   "Every week, the custodian checks the phone's Linked
--                                            devices list against Settings → Linked PCs, and removes
--                                            anything unknown … records devices_reviewed_at." The
--                                            number's custodian (any staff role) or a Partner
--                                            records it; firm_whatsapp_numbers is otherwise
--                                            Partner-write only (§4.6), so this is security definer.
--   remove_firm_number_from_groups(number, groups, date)
--                                            house rule 7: when a Partner leaves, their number is
--                                            removed from every group in WhatsApp, then recorded here
--                                            in one go from the WhatsApp groups page. Partner/Manager,
--                                            security invoker (RLS applies).

set search_path = public, extensions;

create or replace function public.record_whatsapp_devices_review(p_number_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_row public.firm_whatsapp_numbers%rowtype;
  v_at timestamptz := now();
begin
  if not public.is_staff() then
    raise exception 'USER: Only the firm''s staff can record a linked devices review.' using errcode = 'P0001';
  end if;
  select * into v_row from public.firm_whatsapp_numbers where id = p_number_id for update;
  if not found then
    raise exception 'USER: That firm number no longer exists. Reload the page.' using errcode = 'P0001';
  end if;
  if not public.is_partner() and (v_row.custodian_employee_id is null or v_row.custodian_employee_id is distinct from public.my_employee_id()) then
    raise exception 'USER: Only the phone''s custodian or a Partner can record that its linked devices were checked.' using errcode = 'P0001';
  end if;
  update public.firm_whatsapp_numbers set devices_reviewed_at = v_at where id = v_row.id;
  return jsonb_build_object('id', v_row.id, 'label', v_row.label, 'reviewed_at', v_at, 'previous', v_row.devices_reviewed_at);
end;
$$;

comment on function public.record_whatsapp_devices_review(uuid) is
  'House rule 5 (§7.25.10): the number''s custodian or a Partner records that the phone''s Linked devices list was checked (devices_reviewed_at = now()).';

create or replace function public.remove_firm_number_from_groups(p_number_id uuid, p_group_ids uuid[], p_removed_on date default null)
returns int
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_on date := coalesce(p_removed_on, (now() at time zone 'Asia/Kolkata')::date);
  v_count int;
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only Partners and Managers can change a group''s members.' using errcode = 'P0001';
  end if;
  if p_group_ids is null or array_length(p_group_ids, 1) is null then
    return 0;
  end if;
  if array_length(p_group_ids, 1) > 500 then
    raise exception 'USER: Record at most 500 groups at a time.' using errcode = 'P0001';
  end if;
  update public.client_whatsapp_group_members
     set removed_on = greatest(v_on, coalesce(added_on, v_on))
   where firm_number_id = p_number_id
     and group_id = any (p_group_ids)
     and removed_on is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.remove_firm_number_from_groups(uuid, uuid[], date) is
  'House rule 7 (§7.25.10): records that a firm number was removed from these groups (removed_on). Partner/Manager, security invoker.';

revoke execute on function
  public.record_whatsapp_devices_review(uuid),
  public.remove_firm_number_from_groups(uuid, uuid[], date)
from public, anon;
grant execute on function
  public.record_whatsapp_devices_review(uuid),
  public.remove_firm_number_from_groups(uuid, uuid[], date)
to authenticated, service_role;
