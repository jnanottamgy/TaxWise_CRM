-- 0181 · Client WhatsApp groups: the business transactions (§7.25.1–§7.25.2, §4.6, CONVENTIONS §3.4).
--
--   mark_whatsapp_group_created(...)   step 7 of the setup checklist, in one transaction: the date,
--                                      the firm number that created the group and the invite link;
--                                      status → Active; the members fill in from the checklist (the
--                                      server computes the list from the numbers and contacts,
--                                      lib/domain/whatsapp.ts membersFromChecklist; this checks each
--                                      one against the firm's numbers and the client's contacts);
--                                      the creating number is always a member and an admin.
--                                      Partner/Manager; security invoker (RLS applies).
--   set_primary_whatsapp_group(id)     one primary group per client (§7.25.2): demotes the old one
--                                      and promotes this one in the same transaction.
--   close_whatsapp_group(...)          Close group (§7.25.2): a reason and a closing date; when the
--                                      primary closes, the client's next open group becomes primary.
--   record_whatsapp_open(...)          Open chat (§7.25.1): the one server check for TaxWise Desktop,
--                                      a browser window and a phone. can_open_whatsapp(client) or
--                                      refused (access_denied audited); Employees in a browser or on
--                                      a phone only when a Partner allows it
--                                      (firm_settings.whatsapp_employee_browser_window, §7.25.8);
--                                      only an Active group opens; writes last_opened_at/by and the
--                                      record_viewed audit row. Returns the invite link only to
--                                      Partners and Managers. Security definer (Employees can't
--                                      update groups) and therefore checks everything itself.

set search_path = public, extensions;

-- =============================================================================================
-- mark_whatsapp_group_created
-- =============================================================================================
create or replace function public.mark_whatsapp_group_created(
  p_group_id uuid,
  p_expected_updated_at timestamptz,
  p_created_on date,
  p_created_by_number_id uuid,
  p_invite_link text default null,
  p_members jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  g public.client_whatsapp_groups%rowtype;
  v_creator public.firm_whatsapp_numbers%rowtype;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_link text := nullif(btrim(coalesce(p_invite_link, '')), '');
  m jsonb;
  v_kind text;
  v_number text;
  v_name text;
  v_firm public.firm_whatsapp_numbers%rowtype;
  v_contact uuid;
  v_updated timestamptz;
  v_members int;
  v_admins int;
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only Partners and Managers can mark a WhatsApp group created.' using errcode = 'P0001';
  end if;

  select * into g from public.client_whatsapp_groups where id = p_group_id for update;
  if not found or g.deleted_at is not null then
    raise exception 'USER: That WhatsApp group no longer exists. Reload the page.' using errcode = 'P0001';
  end if;
  if p_expected_updated_at is not null and date_trunc('milliseconds', g.updated_at) <> date_trunc('milliseconds', p_expected_updated_at) then
    raise exception 'USER: This group was changed by someone else. Reload to see their changes.' using errcode = 'P0001';
  end if;
  if g.status = 'active' then
    raise exception 'USER: This group is already marked created.' using errcode = 'P0001';
  end if;
  if g.status = 'closed' then
    raise exception 'USER: This group is closed. Set up a new group for the client instead.' using errcode = 'P0001';
  end if;

  if p_created_on is null then
    raise exception 'USER: Enter the date the group was created.' using errcode = 'P0001';
  end if;
  if p_created_on > v_today then
    raise exception 'USER: The date the group was created can''t be in the future.' using errcode = 'P0001';
  end if;
  if p_created_on < date '2009-01-01' then
    raise exception 'USER: Check the date the group was created.' using errcode = 'P0001';
  end if;

  select * into v_creator from public.firm_whatsapp_numbers where id = p_created_by_number_id;
  if not found or not v_creator.is_active or v_creator.number is null then
    raise exception 'USER: Choose the firm number that created the group (an active number in Settings → WhatsApp).' using errcode = 'P0001';
  end if;

  if v_link is not null and not public.is_whatsapp_invite_link(v_link) then
    raise exception 'USER: The invite link should look like https://chat.whatsapp.com/ followed by the group''s code.' using errcode = 'P0001';
  end if;

  if p_members is null or jsonb_typeof(p_members) <> 'array' then
    raise exception 'USER: The members list isn''t in the expected form. Reload the page and try again.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_members) > 256 then
    raise exception 'USER: A WhatsApp group can''t have that many members.' using errcode = 'P0001';
  end if;

  for m in select * from jsonb_array_elements(p_members)
  loop
    v_kind := m ->> 'kind';
    v_number := m ->> 'number';
    v_name := left(regexp_replace(btrim(coalesce(m ->> 'display_name', '')), '\s+', ' ', 'g'), 200);
    if v_number is null or v_number !~ '^[1-9][0-9]{7,14}$' then
      raise exception 'USER: % doesn''t have a number WhatsApp can use.', coalesce(nullif(v_name, ''), 'A member') using errcode = 'P0001';
    end if;
    if v_kind = 'firm_number' then
      select * into v_firm from public.firm_whatsapp_numbers where id = public.try_uuid(m ->> 'firm_number_id');
      if not found or not v_firm.is_active or v_firm.number is distinct from v_number then
        raise exception 'USER: The firm''s numbers changed while you were on this page. Reload and mark the group created again.' using errcode = 'P0001';
      end if;
      insert into public.client_whatsapp_group_members (group_id, kind, firm_number_id, display_name, number, is_admin, added_on, source)
      values (g.id, 'firm_number', v_firm.id, coalesce(nullif(v_name, ''), v_firm.label), v_number,
              coalesce((m ->> 'is_admin')::boolean, false) or v_firm.group_admin or v_firm.id = v_creator.id, p_created_on, 'checklist')
      on conflict (group_id, number) where removed_on is null
      do update set is_admin = public.client_whatsapp_group_members.is_admin or excluded.is_admin;
    elsif v_kind = 'client_contact' then
      v_contact := public.try_uuid(m ->> 'contact_id');
      if v_contact is null or not exists (select 1 from public.client_contacts c where c.id = v_contact and c.client_id = g.client_id) then
        raise exception 'USER: The client''s contacts changed while you were on this page. Reload and mark the group created again.' using errcode = 'P0001';
      end if;
      if v_name = '' then
        raise exception 'USER: Every member needs a name.' using errcode = 'P0001';
      end if;
      insert into public.client_whatsapp_group_members (group_id, kind, contact_id, display_name, number, is_admin, added_on, source)
      values (g.id, 'client_contact', v_contact, v_name, v_number, coalesce((m ->> 'is_admin')::boolean, false), p_created_on, 'checklist')
      on conflict (group_id, number) where removed_on is null do nothing;
    else
      raise exception 'USER: The members list isn''t in the expected form. Reload the page and try again.' using errcode = 'P0001';
    end if;
  end loop;

  -- The number that created the group is always in it, as an admin (WhatsApp makes the creator one).
  insert into public.client_whatsapp_group_members (group_id, kind, firm_number_id, display_name, number, is_admin, added_on, source)
  values (g.id, 'firm_number', v_creator.id, v_creator.label, v_creator.number, true, p_created_on, 'checklist')
  on conflict (group_id, number) where removed_on is null
  do update set is_admin = true;

  update public.client_whatsapp_groups
     set status = 'active',
         created_on = p_created_on,
         created_by_number_id = v_creator.id,
         invite_link = coalesce(v_link, invite_link),
         checklist = jsonb_set(
           case when jsonb_typeof(checklist) = 'object' then checklist else '{}'::jsonb end,
           '{mark_created}',
           jsonb_build_object('done', true, 'by', auth.uid(), 'at', to_jsonb(now()))
         )
   where id = g.id
  returning updated_at into v_updated;

  select count(*)::int, count(*) filter (where is_admin)::int into v_members, v_admins
  from public.client_whatsapp_group_members where group_id = g.id and removed_on is null;

  return jsonb_build_object(
    'id', g.id, 'client_id', g.client_id, 'name', g.name, 'updated_at', v_updated,
    'members', v_members, 'admins', v_admins, 'created_by_label', v_creator.label
  );
end;
$$;

comment on function public.mark_whatsapp_group_created(uuid, timestamptz, date, uuid, text, jsonb) is
  'Step 7 of the WhatsApp group checklist (§7.25.2): date, creating number, invite link; status Active; members from the checklist (each checked against the firm numbers and the client''s contacts); the creator is an admin member. Partner/Manager, security invoker.';

-- =============================================================================================
-- set_primary_whatsapp_group
-- =============================================================================================
create or replace function public.set_primary_whatsapp_group(p_group_id uuid)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  g public.client_whatsapp_groups%rowtype;
  v_previous uuid;
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only Partners and Managers can change a client''s primary WhatsApp group.' using errcode = 'P0001';
  end if;
  select * into g from public.client_whatsapp_groups where id = p_group_id for update;
  if not found or g.deleted_at is not null then
    raise exception 'USER: That WhatsApp group no longer exists. Reload the page.' using errcode = 'P0001';
  end if;
  if g.status = 'closed' then
    raise exception 'USER: A closed group can''t be the primary group.' using errcode = 'P0001';
  end if;
  if g.is_primary then
    return jsonb_build_object('id', g.id, 'changed', false, 'previous_id', g.id);
  end if;

  update public.client_whatsapp_groups
     set is_primary = false
   where client_id = g.client_id and is_primary and status <> 'closed' and deleted_at is null and id <> g.id
  returning id into v_previous;

  update public.client_whatsapp_groups set is_primary = true where id = g.id;
  return jsonb_build_object('id', g.id, 'changed', true, 'previous_id', v_previous);
end;
$$;

comment on function public.set_primary_whatsapp_group(uuid) is
  'Makes a group its client''s primary WhatsApp group (one per client among open groups, §5.13), demoting the old one. Partner/Manager, security invoker.';

-- =============================================================================================
-- close_whatsapp_group
-- =============================================================================================
create or replace function public.close_whatsapp_group(
  p_group_id uuid,
  p_expected_updated_at timestamptz,
  p_closed_on date,
  p_reason text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  g public.client_whatsapp_groups%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_promoted uuid;
  v_updated timestamptz;
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only Partners and Managers can close a WhatsApp group.' using errcode = 'P0001';
  end if;
  select * into g from public.client_whatsapp_groups where id = p_group_id for update;
  if not found or g.deleted_at is not null then
    raise exception 'USER: That WhatsApp group no longer exists. Reload the page.' using errcode = 'P0001';
  end if;
  if p_expected_updated_at is not null and date_trunc('milliseconds', g.updated_at) <> date_trunc('milliseconds', p_expected_updated_at) then
    raise exception 'USER: This group was changed by someone else. Reload to see their changes.' using errcode = 'P0001';
  end if;
  if g.status = 'closed' then
    raise exception 'USER: This group is already closed.' using errcode = 'P0001';
  end if;
  if v_reason is null then
    raise exception 'USER: Say why the group is being closed.' using errcode = 'P0001';
  end if;
  if p_closed_on is null then
    raise exception 'USER: Enter the date the group was closed.' using errcode = 'P0001';
  end if;
  if p_closed_on > (now() at time zone 'Asia/Kolkata')::date then
    raise exception 'USER: The closing date can''t be in the future.' using errcode = 'P0001';
  end if;
  if g.created_on is not null and p_closed_on < g.created_on then
    raise exception 'USER: The group can''t close before it was created (%).', to_char(g.created_on, 'DD Mon YYYY') using errcode = 'P0001';
  end if;

  update public.client_whatsapp_groups
     set status = 'closed',
         closed_at = (p_closed_on::timestamp at time zone 'Asia/Kolkata'),
         closed_reason = left(v_reason, 500),
         is_primary = false
   where id = g.id
  returning updated_at into v_updated;

  if g.is_primary then
    select x.id into v_promoted
    from public.client_whatsapp_groups x
    where x.client_id = g.client_id and x.id <> g.id and x.status <> 'closed' and x.deleted_at is null
    order by (x.status = 'active') desc, x.created_at
    limit 1;
    if v_promoted is not null then
      update public.client_whatsapp_groups set is_primary = true where id = v_promoted;
    end if;
  end if;

  return jsonb_build_object('id', g.id, 'client_id', g.client_id, 'name', g.name, 'updated_at', v_updated, 'promoted_id', v_promoted, 'was_status', g.status);
end;
$$;

comment on function public.close_whatsapp_group(uuid, timestamptz, date, text) is
  'Close group (§7.25.2): reason and closing date; the next open group becomes primary when the primary closes. Partner/Manager, security invoker.';

-- =============================================================================================
-- record_whatsapp_open (Open chat, §7.25.1)
-- =============================================================================================
create or replace function public.record_whatsapp_open(
  p_client_id uuid,
  p_group_id uuid default null,
  p_via text default 'browser',
  p_ip text default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_role public.app_role := public.app_role();
  v_via text := lower(btrim(coalesce(p_via, '')));
  g public.client_whatsapp_groups%rowtype;
  v_client_name text;
  v_members uuid[];
  v_allowed_browser boolean;
begin
  if v_via not in ('desktop', 'browser', 'phone') then
    raise exception 'USER: Open chat from TaxWise Desktop, a browser window or the phone app.' using errcode = 'P0001';
  end if;

  if p_client_id is null or not public.can_open_whatsapp(p_client_id) then
    perform public.log_audit_event('access_denied', 'client_whatsapp_group', coalesce(p_group_id, p_client_id)::text, 'whatsapp.open',
      jsonb_build_object('client_id', p_client_id, 'group_id', p_group_id, 'via', v_via), false, 'Not one of your clients', p_ip, p_user_agent);
    return jsonb_build_object('status', 'forbidden', 'error', 'Not one of your clients.');
  end if;

  if v_role = 'employee' and v_via in ('browser', 'phone') then
    select coalesce(fs.whatsapp_employee_browser_window, false) into v_allowed_browser from public.firm_settings fs where fs.id = 1;
    if not coalesce(v_allowed_browser, false) then
      perform public.log_audit_event('access_denied', 'client_whatsapp_group', coalesce(p_group_id, p_client_id)::text, 'whatsapp.open',
        jsonb_build_object('client_id', p_client_id, 'group_id', p_group_id, 'via', v_via), false, 'WhatsApp in a browser is off for Employees', p_ip, p_user_agent);
      return jsonb_build_object('status', 'forbidden',
        'error', 'Client chats open in TaxWise Desktop for Employees: a Partner hasn''t allowed WhatsApp in a browser window.');
    end if;
  end if;

  select c.display_name into v_client_name from public.clients c where c.id = p_client_id;

  if p_group_id is not null then
    select * into g from public.client_whatsapp_groups x
    where x.id = p_group_id and x.client_id = p_client_id and x.deleted_at is null;
  else
    select * into g from public.client_whatsapp_groups x
    where x.client_id = p_client_id and x.deleted_at is null and x.status <> 'closed'
    order by x.is_primary desc, (x.status = 'active') desc, x.created_at
    limit 1;
  end if;

  if not found then
    return jsonb_build_object('status', 'no_group', 'client_name', v_client_name,
      'error', format('%s has no WhatsApp group yet. Set it up on the client''s WhatsApp group tab.', coalesce(v_client_name, 'This client')));
  end if;
  if g.status = 'closed' then
    return jsonb_build_object('status', 'no_group', 'client_name', v_client_name,
      'error', format('%s is closed. Open the client''s current group instead.', g.name));
  end if;
  if g.status = 'to_create' then
    return jsonb_build_object('status', 'no_group', 'client_name', v_client_name,
      'error', format('%s isn''t marked created yet. Finish the setup checklist on the client''s WhatsApp group tab first.', g.name));
  end if;

  update public.client_whatsapp_groups set last_opened_at = now(), last_opened_by = auth.uid() where id = g.id;

  perform public.log_audit_event('record_viewed', 'client_whatsapp_group', g.id::text, 'whatsapp.open',
    jsonb_build_object('client_id', p_client_id, 'via', v_via), true, null, p_ip, p_user_agent);

  select coalesce(array_agg(mm.firm_number_id), '{}') into v_members
  from public.client_whatsapp_group_members mm
  where mm.group_id = g.id and mm.removed_on is null and mm.firm_number_id is not null;

  return jsonb_build_object(
    'status', 'ok',
    'client_name', v_client_name,
    'group', jsonb_build_object(
      'id', g.id,
      'client_id', g.client_id,
      'name', g.name,
      'is_primary', g.is_primary,
      'status', g.status,
      'invite_link', case when v_role in ('partner', 'manager') then g.invite_link end
    ),
    'member_number_ids', to_jsonb(v_members)
  );
end;
$$;

comment on function public.record_whatsapp_open(uuid, uuid, text, text, text) is
  'Open chat (§7.25.1, §7.25.8): can_open_whatsapp or access_denied; Employees in a browser/phone only when firm_settings.whatsapp_employee_browser_window; only an Active group opens; stamps last_opened_at/by and audits record_viewed. Invite link only for Partners/Managers.';

revoke execute on function
  public.mark_whatsapp_group_created(uuid, timestamptz, date, uuid, text, jsonb),
  public.set_primary_whatsapp_group(uuid),
  public.close_whatsapp_group(uuid, timestamptz, date, text),
  public.record_whatsapp_open(uuid, uuid, text, text, text)
from public, anon;
grant execute on function
  public.mark_whatsapp_group_created(uuid, timestamptz, date, uuid, text, jsonb),
  public.set_primary_whatsapp_group(uuid),
  public.close_whatsapp_group(uuid, timestamptz, date, text),
  public.record_whatsapp_open(uuid, uuid, text, text, text)
to authenticated, service_role;
