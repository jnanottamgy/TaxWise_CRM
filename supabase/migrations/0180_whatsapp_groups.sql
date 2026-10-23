-- 0180 · Client WhatsApp groups: integrity rules for the register (§5.13, §7.25.1–§7.25.2, §4.6).
--
-- Everything here applies to API callers (the authenticated/anon roles, is_api_caller()); security
-- definer functions and the service role (jobs, the desktop routes' own checks) are trusted to
-- keep the same rules themselves.
--
--   client_whatsapp_groups_guard        the name carries the client's code (§5.13 "must contain the
--                                       client code"; TaxWise Desktop finds the group by it, §7.25.5)
--                                       and fits WhatsApp's 100 characters; a group stays with its
--                                       client; invite links are chat.whatsapp.com links; a closed
--                                       group stays closed; Active needs a created-on date; Closed
--                                       needs a reason and a closing date that isn't in the future;
--                                       the checklist holds only the seven §7.25.2 steps;
--                                       last_opened_at / last_opened_by are written only by Open chat
--                                       (record_whatsapp_open, 0181).
--   client_whatsapp_groups_live_name    one live (not closed, not deleted) group per name, so Open
--                                       chat's exact-title search can't land in the wrong group.
--   client_whatsapp_group_members_guard a firm-number member names its firm number, a contact member
--                                       a contact of the group's own client; no members are added to
--                                       a closed group; a member stays in its group.
--   firm_whatsapp_numbers_guard         a Partner's own number is usable by Partners only and owned
--                                       by an active Partner; only a Partner's number has an owner;
--                                       an active Partner's number needs its owner (§5.13, §7.25.4).
--   desktop_devices.renamed_at / _by    a Partner's rename of a PC survives the app's check-ins
--                                       (§5.13 device_name "editable by a Partner").

set search_path = public, extensions;

-- =============================================================================================
-- desktop_devices: a Partner's rename sticks
-- =============================================================================================
alter table public.desktop_devices
  add column if not exists renamed_at timestamptz,
  add column if not exists renamed_by uuid;

comment on column public.desktop_devices.renamed_at is
  'When a Partner renamed the PC. Check-ins from TaxWise Desktop keep a renamed PC''s name (§5.13).';

-- =============================================================================================
-- client_whatsapp_groups
-- =============================================================================================
create unique index if not exists client_whatsapp_groups_live_name
  on public.client_whatsapp_groups (lower(name))
  where status <> 'closed' and deleted_at is null;

create index if not exists client_whatsapp_group_members_firm_number_idx
  on public.client_whatsapp_group_members (firm_number_id)
  where removed_on is null and firm_number_id is not null;

-- The seven checklist steps of §7.25.2, in order (mirrors CHECKLIST_STEP_IDS in lib/domain/whatsapp.ts).
create or replace function public.whatsapp_checklist_steps()
returns text[]
language sql
immutable
set search_path = public, extensions
as $$
  select array['group_name', 'save_contacts', 'add_numbers', 'group_settings', 'managers_admin', 'welcome_message', 'mark_created']
$$;

comment on function public.whatsapp_checklist_steps() is
  'The seven WhatsApp group setup steps (§7.25.2), the only keys client_whatsapp_groups.checklist may hold.';

-- A chat.whatsapp.com invite link (the code is 10–40 letters and digits, docs/DESKTOP-API.md).
create or replace function public.is_whatsapp_invite_link(p text)
returns boolean
language sql
immutable
set search_path = public, extensions
as $$
  select coalesce(p ~ '^https://chat\.whatsapp\.com/[A-Za-z0-9]{10,40}$', false)
$$;

comment on function public.is_whatsapp_invite_link(text) is 'True for https://chat.whatsapp.com/<10–40 letters and digits>.';

-- The client's code for the guard, only for a client the caller can see (can_see_client): the
-- guard runs for Partners and Managers, who see every client; nobody learns another client's code.
create or replace function public.client_code_of(p_client_id uuid)
returns text
language sql
stable
security definer
set search_path = public, extensions
as $$
  select c.client_code::text from public.clients c where c.id = p_client_id and public.can_see_client(p_client_id)
$$;

comment on function public.client_code_of(uuid) is 'clients.client_code for a client the caller can see (used by the WhatsApp group guard).';
revoke execute on function public.client_code_of(uuid) from public, anon;
grant execute on function public.client_code_of(uuid) to authenticated, service_role;

create or replace function public.client_whatsapp_groups_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_code text;
  v_bad text[];
begin
  -- Every writer: tidy the free text.
  new.name := regexp_replace(btrim(coalesce(new.name, '')), '\s+', ' ', 'g');
  new.purpose := nullif(regexp_replace(btrim(coalesce(new.purpose, '')), '\s+', ' ', 'g'), '');
  new.notes := nullif(btrim(coalesce(new.notes, '')), '');
  new.closed_reason := nullif(btrim(coalesce(new.closed_reason, '')), '');
  new.invite_link := nullif(btrim(coalesce(new.invite_link, '')), '');

  if not public.is_api_caller() then
    return new;
  end if;

  if tg_op = 'UPDATE' and new.client_id is distinct from old.client_id then
    raise exception 'USER: A WhatsApp group stays with its client. Set up a new group for the other client instead.' using errcode = 'P0001';
  end if;

  if tg_op = 'INSERT' or new.name is distinct from old.name then
    if length(new.name) < 3 then
      raise exception 'USER: Enter the group''s name.' using errcode = 'P0001';
    end if;
    if length(new.name) > 100 then
      raise exception 'USER: WhatsApp group names are at most 100 characters.' using errcode = 'P0001';
    end if;
    v_code := public.client_code_of(new.client_id);
    if v_code is null then
      raise exception 'USER: That client no longer exists.' using errcode = 'P0001';
    end if;
    if position(lower(v_code) in lower(new.name)) = 0 then
      raise exception 'USER: Keep the client code % in the group name: TaxWise Desktop finds the group by it.', v_code using errcode = 'P0001';
    end if;
  end if;

  if new.invite_link is not null and (tg_op = 'INSERT' or new.invite_link is distinct from old.invite_link)
     and not public.is_whatsapp_invite_link(new.invite_link) then
    raise exception 'USER: The invite link should look like https://chat.whatsapp.com/ followed by the group''s code.' using errcode = 'P0001';
  end if;

  if jsonb_typeof(new.checklist) is distinct from 'object' then
    raise exception 'USER: The setup checklist isn''t in the expected form. Reload the page and try again.' using errcode = 'P0001';
  end if;
  select array_agg(k) into v_bad from jsonb_object_keys(new.checklist) k where not (k = any (public.whatsapp_checklist_steps()));
  if v_bad is not null then
    raise exception 'USER: The setup checklist has steps it doesn''t know (%).', array_to_string(v_bad, ', ') using errcode = 'P0001';
  end if;

  if tg_op = 'UPDATE' and old.status = 'closed' and new.status <> 'closed' then
    raise exception 'USER: A closed group stays closed. Set up a new group for the client instead.' using errcode = 'P0001';
  end if;

  if new.status = 'active' and (tg_op = 'INSERT' or old.status <> 'active') and new.created_on is null then
    raise exception 'USER: Mark the group created with the date it was created.' using errcode = 'P0001';
  end if;
  if new.created_on is not null and (tg_op = 'INSERT' or new.created_on is distinct from old.created_on)
     and new.created_on > (now() at time zone 'Asia/Kolkata')::date then
    raise exception 'USER: The date the group was created can''t be in the future.' using errcode = 'P0001';
  end if;

  if new.status = 'closed' and (tg_op = 'INSERT' or old.status <> 'closed') then
    if new.closed_reason is null then
      raise exception 'USER: Say why the group is being closed.' using errcode = 'P0001';
    end if;
    if new.closed_at is null then
      raise exception 'USER: Enter the date the group was closed.' using errcode = 'P0001';
    end if;
    if (new.closed_at at time zone 'Asia/Kolkata')::date > (now() at time zone 'Asia/Kolkata')::date then
      raise exception 'USER: The closing date can''t be in the future.' using errcode = 'P0001';
    end if;
  end if;

  if tg_op = 'UPDATE'
     and (new.last_opened_at is distinct from old.last_opened_at or new.last_opened_by is distinct from old.last_opened_by) then
    raise exception 'USER: When a group was last opened is recorded by Open chat only.' using errcode = 'P0001';
  end if;
  if tg_op = 'INSERT' and (new.last_opened_at is not null or new.last_opened_by is not null) then
    raise exception 'USER: When a group was last opened is recorded by Open chat only.' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.client_whatsapp_groups_guard() is
  'WhatsApp group integrity for API callers (§5.13, §7.25.2): name carries the client code, invite link format, closed stays closed, Active needs created_on, Closed needs a reason and date, checklist keys, last_opened only through Open chat.';

drop trigger if exists client_whatsapp_groups_guard on public.client_whatsapp_groups;
create trigger client_whatsapp_groups_guard before insert or update on public.client_whatsapp_groups
  for each row execute function public.client_whatsapp_groups_guard();

revoke execute on function public.client_whatsapp_groups_guard() from public, anon, authenticated;

-- =============================================================================================
-- client_whatsapp_group_members
-- =============================================================================================
create or replace function public.client_whatsapp_group_members_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_group public.client_whatsapp_groups%rowtype;
begin
  new.display_name := regexp_replace(btrim(coalesce(new.display_name, '')), '\s+', ' ', 'g');

  if not public.is_api_caller() then
    return new;
  end if;

  if tg_op = 'UPDATE' and new.group_id is distinct from old.group_id then
    raise exception 'USER: A member stays in their group. Add them to the other group instead.' using errcode = 'P0001';
  end if;
  if new.display_name = '' then
    raise exception 'USER: Enter the member''s name.' using errcode = 'P0001';
  end if;

  select * into v_group from public.client_whatsapp_groups g where g.id = new.group_id;
  if not found or v_group.deleted_at is not null then
    raise exception 'USER: That WhatsApp group no longer exists. Reload the page.' using errcode = 'P0001';
  end if;
  if v_group.status = 'closed' and (tg_op = 'INSERT' or new.removed_on is not distinct from old.removed_on) then
    raise exception 'USER: This group is closed, so its members can''t change.' using errcode = 'P0001';
  end if;

  if new.kind = 'firm_number' then
    if new.firm_number_id is null then
      raise exception 'USER: Choose which firm number this member is.' using errcode = 'P0001';
    end if;
    new.contact_id := null;
  elsif new.kind = 'client_contact' then
    if new.contact_id is null then
      raise exception 'USER: Choose which of the client''s contacts this member is.' using errcode = 'P0001';
    end if;
    if not exists (select 1 from public.client_contacts cc where cc.id = new.contact_id and cc.client_id = v_group.client_id) then
      raise exception 'USER: That contact belongs to another client.' using errcode = 'P0001';
    end if;
    new.firm_number_id := null;
  else
    new.firm_number_id := null;
    new.contact_id := null;
  end if;

  if new.removed_on is not null and new.added_on is not null and new.removed_on < new.added_on then
    raise exception 'USER: A member can''t be removed before they were added.' using errcode = 'P0001';
  end if;
  if new.removed_on is not null and new.removed_on > (now() at time zone 'Asia/Kolkata')::date then
    raise exception 'USER: The date a member was removed can''t be in the future.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

comment on function public.client_whatsapp_group_members_guard() is
  'WhatsApp group member integrity for API callers (§5.13): firm members name their number, contact members a contact of the same client, closed groups are frozen, dates in order.';

drop trigger if exists client_whatsapp_group_members_guard on public.client_whatsapp_group_members;
create trigger client_whatsapp_group_members_guard before insert or update on public.client_whatsapp_group_members
  for each row execute function public.client_whatsapp_group_members_guard();

revoke execute on function public.client_whatsapp_group_members_guard() from public, anon, authenticated;

-- =============================================================================================
-- firm_whatsapp_numbers
-- =============================================================================================
create or replace function public.firm_whatsapp_numbers_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  new.label := regexp_replace(btrim(coalesce(new.label, '')), '\s+', ' ', 'g');

  if not public.is_api_caller() then
    return new;
  end if;

  if length(new.label) < 2 then
    raise exception 'USER: Enter a label for the number, such as "Staff office".' using errcode = 'P0001';
  end if;

  if new.kind = 'partner' then
    if new.usable_by is distinct from array['partner']::public.app_role[] then
      raise exception 'USER: A Partner''s own number is used only by that Partner, so "Who may use it" must be Partners only.' using errcode = 'P0001';
    end if;
    if new.is_active and new.employee_id is null then
      raise exception 'USER: Choose the Partner whose number this is before switching it on.' using errcode = 'P0001';
    end if;
  elsif new.employee_id is not null then
    raise exception 'USER: Only a Partner''s own number has an owner. Leave the Partner empty for an office number.' using errcode = 'P0001';
  end if;

  if new.employee_id is not null and (tg_op = 'INSERT' or new.employee_id is distinct from old.employee_id) then
    if not exists (
      select 1 from public.employees e
      join public.profiles p on p.id = e.profile_id
      where e.id = new.employee_id and e.is_active and e.deleted_at is null and p.role = 'partner' and p.is_active
    ) then
      raise exception 'USER: The owner of a Partner''s number must be an active Partner.' using errcode = 'P0001';
    end if;
  end if;

  if array_length(new.usable_by, 1) is null then
    raise exception 'USER: Choose who may use this number in TaxWise Desktop.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

comment on function public.firm_whatsapp_numbers_guard() is
  'Firm WhatsApp number rules for API callers (§5.13, §7.25.4): a Partner''s number is {partner}-only and owned by an active Partner; only Partner numbers have owners; someone must be able to use it.';

drop trigger if exists firm_whatsapp_numbers_guard on public.firm_whatsapp_numbers;
create trigger firm_whatsapp_numbers_guard before insert or update on public.firm_whatsapp_numbers
  for each row execute function public.firm_whatsapp_numbers_guard();

revoke execute on function public.firm_whatsapp_numbers_guard() from public, anon, authenticated;
revoke execute on function public.whatsapp_checklist_steps(), public.is_whatsapp_invite_link(text) from public, anon;
grant execute on function public.whatsapp_checklist_steps(), public.is_whatsapp_invite_link(text) to authenticated, service_role;
