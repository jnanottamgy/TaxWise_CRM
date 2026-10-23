-- 0182 · TaxWise Desktop: what the desktop API routes write (§7.25.1, §7.25.4–§7.25.7, §4.6,
-- docs/DESKTOP-API.md).
--
-- §4.6: desktop_devices and desktop_device_numbers are written only by the desktop API route
-- handlers, after their own checks (authenticated has no INSERT/UPDATE/DELETE on them, 0040). The
-- route handlers (app/api/desktop/*, server/desktop.ts) first refuse a revoked PC, then require a
-- signed-in staff member, then call these functions under that person's session, so auth.uid() is
-- the real user in every row and audit entry. Each function is security definer, re-checks
-- is_staff() and the device itself, and answers with a status the route turns into HTTP:
--   'ok' · 'not_found' (the PC hasn't checked in) · 'revoked' (403 device_revoked) · 'forbidden'.
--
--   desktop_checkin(key, name, os, version)     creates or updates the PC (§7.25.3 start-up): last
--                                               user and last seen; a Partner's rename sticks; a
--                                               revoked PC stays revoked.
--   desktop_touch_device(key)                   GET /context: last user and last seen.
--   desktop_link_number(key, number, linked)    a number linked on (or unlinked from) the PC
--                                               (§7.25.7), only a number this person may use
--                                               (§7.25.4); returns the links now active for the
--                                               number and the firm's device limit.
--   desktop_report_health(key, failing)         client mode can't run on this PC (§7.25.5): stores
--                                               the failing selectors and says whether to tell the
--                                               Partners, at most once per IST day per PC.
--   desktop_log_access_denied(key, number, title, ip, ua)
--                                               a chat closed by client mode (§7.25.5): an
--                                               access_denied audit row, on the client's group when
--                                               the title is one, else on resource whatsapp_chat.
--   rename_desktop_device(id, name)             Partner: renames a PC (Settings → Linked PCs).

set search_path = public, extensions;

-- =============================================================================================
-- desktop_checkin
-- =============================================================================================
create or replace function public.desktop_checkin(p_device_key text, p_device_name text, p_os text default null, p_app_version text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_name text := left(regexp_replace(btrim(coalesce(p_device_name, '')), '\s+', ' ', 'g'), 100);
  v_row public.desktop_devices%rowtype;
begin
  if not public.is_staff() then
    raise exception 'USER: TaxWise Desktop is for the firm''s staff.' using errcode = 'P0001';
  end if;
  if p_device_key is null or p_device_key !~ '^[0-9a-f]{64}$' then
    raise exception 'USER: This PC''s key isn''t valid. Reinstall TaxWise Desktop.' using errcode = 'P0001';
  end if;
  if v_name = '' then
    v_name := 'Unnamed PC';
  end if;

  select * into v_row from public.desktop_devices where device_key = p_device_key for update;
  if found then
    if v_row.revoked_at is not null then
      return jsonb_build_object('status', 'revoked');
    end if;
    update public.desktop_devices
       set device_name = case when renamed_at is null then v_name else device_name end,
           os = left(nullif(btrim(coalesce(p_os, '')), ''), 100),
           app_version = left(nullif(btrim(coalesce(p_app_version, '')), ''), 40),
           last_user_id = auth.uid(),
           last_seen_at = now()
     where id = v_row.id
    returning * into v_row;
    return jsonb_build_object('status', 'ok', 'device_id', v_row.id, 'device_name', v_row.device_name, 'created', false);
  end if;

  insert into public.desktop_devices (device_key, device_name, os, app_version, last_user_id, last_seen_at)
  values (p_device_key, v_name, left(nullif(btrim(coalesce(p_os, '')), ''), 100), left(nullif(btrim(coalesce(p_app_version, '')), ''), 40), auth.uid(), now())
  on conflict (device_key) do nothing
  returning * into v_row;
  if not found then
    -- Two check-ins raced: the other one created it.
    select * into v_row from public.desktop_devices where device_key = p_device_key;
    if v_row.revoked_at is not null then
      return jsonb_build_object('status', 'revoked');
    end if;
  end if;
  return jsonb_build_object('status', 'ok', 'device_id', v_row.id, 'device_name', v_row.device_name, 'created', true);
end;
$$;

comment on function public.desktop_checkin(text, text, text, text) is
  'POST /api/desktop/devices/checkin (§7.25.3): creates or updates the PC with its last user and last seen; keeps a Partner''s rename; a revoked PC answers status revoked. Staff only.';

-- =============================================================================================
-- desktop_touch_device
-- =============================================================================================
create or replace function public.desktop_touch_device(p_device_key text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_row public.desktop_devices%rowtype;
begin
  if not public.is_staff() then
    raise exception 'USER: TaxWise Desktop is for the firm''s staff.' using errcode = 'P0001';
  end if;
  select * into v_row from public.desktop_devices where device_key = p_device_key;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_row.revoked_at is not null then
    return jsonb_build_object('status', 'revoked');
  end if;
  update public.desktop_devices set last_user_id = auth.uid(), last_seen_at = now() where id = v_row.id;
  return jsonb_build_object('status', 'ok', 'device_id', v_row.id);
end;
$$;

comment on function public.desktop_touch_device(text) is
  'GET /api/desktop/context: stamps the PC''s last user and last seen (docs/DESKTOP-API.md 1). Staff only.';

-- =============================================================================================
-- desktop_may_use_number: may the caller open this firm number in TaxWise Desktop (§7.25.4)?
-- Active, usable_by holds their role, and a number with an owner only for that Partner.
-- =============================================================================================
create or replace function public.desktop_may_use_number(p_number public.firm_whatsapp_numbers)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select coalesce(
    public.is_staff()
    and p_number.is_active
    and p_number.number is not null
    and public.app_role() = any (p_number.usable_by)
    and (p_number.employee_id is null or (public.app_role() = 'partner' and p_number.employee_id = public.my_employee_id())),
    false)
$$;

comment on function public.desktop_may_use_number(public.firm_whatsapp_numbers) is
  'True when the caller may use the firm number in TaxWise Desktop (§7.25.4): active, usable_by holds their role, an owned number only for its Partner. Mirrors contextNumbers in lib/domain/whatsapp.ts.';

-- =============================================================================================
-- desktop_link_number
-- =============================================================================================
create or replace function public.desktop_link_number(p_device_key text, p_number_id uuid, p_linked boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_device public.desktop_devices%rowtype;
  v_number public.firm_whatsapp_numbers%rowtype;
  v_link uuid;
  v_changed boolean := false;
  v_active int;
  v_limit int;
begin
  if not public.is_staff() then
    raise exception 'USER: TaxWise Desktop is for the firm''s staff.' using errcode = 'P0001';
  end if;
  select * into v_device from public.desktop_devices where device_key = p_device_key for update;
  if not found then
    return jsonb_build_object('status', 'not_found', 'error', 'This PC hasn''t checked in with TaxWise yet. Restart TaxWise Desktop.');
  end if;
  if v_device.revoked_at is not null then
    return jsonb_build_object('status', 'revoked');
  end if;

  select * into v_number from public.firm_whatsapp_numbers where id = p_number_id;
  if not found then
    return jsonb_build_object('status', 'not_found', 'error', 'That firm number no longer exists. Ask a Partner to check Settings → WhatsApp.');
  end if;
  if not public.desktop_may_use_number(v_number) then
    return jsonb_build_object('status', 'forbidden', 'error', format('You can''t use the %s number in TaxWise Desktop.', v_number.label));
  end if;

  if coalesce(p_linked, false) then
    insert into public.desktop_device_numbers (device_id, number_id, linked_at, linked_by)
    values (v_device.id, v_number.id, now(), auth.uid())
    on conflict (device_id, number_id) where unlinked_at is null do nothing
    returning id into v_link;
    v_changed := v_link is not null;
    if not v_changed then
      select id into v_link from public.desktop_device_numbers where device_id = v_device.id and number_id = v_number.id and unlinked_at is null;
    end if;
  else
    update public.desktop_device_numbers
       set unlinked_at = now()
     where device_id = v_device.id and number_id = v_number.id and unlinked_at is null
    returning id into v_link;
    v_changed := v_link is not null;
  end if;

  update public.desktop_devices set last_user_id = auth.uid(), last_seen_at = now() where id = v_device.id;

  select count(*)::int into v_active
  from public.desktop_device_numbers dn
  join public.desktop_devices d on d.id = dn.device_id and d.revoked_at is null
  where dn.number_id = v_number.id and dn.unlinked_at is null;
  select fs.whatsapp_linked_device_limit::int into v_limit from public.firm_settings fs where fs.id = 1;

  return jsonb_build_object(
    'status', 'ok', 'changed', v_changed, 'linked', coalesce(p_linked, false), 'link_id', v_link,
    'device_id', v_device.id, 'device_name', v_device.device_name,
    'number_id', v_number.id, 'number_label', v_number.label,
    'active_links', v_active, 'device_limit', v_limit
  );
end;
$$;

comment on function public.desktop_link_number(text, uuid, boolean) is
  'POST /api/desktop/devices/link (§7.25.7): records a link (linked_by = caller) unless one is active, or ends the active link; only for a number the caller may use. Returns the number''s active links and the device limit. Staff only.';

-- =============================================================================================
-- desktop_report_health
-- =============================================================================================
create or replace function public.desktop_report_health(p_device_key text, p_failing text[])
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_device public.desktop_devices%rowtype;
  v_failing text[];
  v_notify boolean := false;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if not public.is_staff() then
    raise exception 'USER: TaxWise Desktop is for the firm''s staff.' using errcode = 'P0001';
  end if;
  select * into v_device from public.desktop_devices where device_key = p_device_key for update;
  if not found then
    return jsonb_build_object('status', 'not_found', 'error', 'This PC hasn''t checked in with TaxWise yet. Restart TaxWise Desktop.');
  end if;
  if v_device.revoked_at is not null then
    return jsonb_build_object('status', 'revoked');
  end if;

  select array_agg(distinct f order by f) into v_failing
  from unnest(coalesce(p_failing, '{}'::text[])) as f
  where f ~ '^[A-Za-z0-9_.-]{1,60}$';
  if v_failing is not null and array_length(v_failing, 1) > 50 then
    v_failing := v_failing[1:50];
  end if;

  if v_failing is null then
    update public.desktop_devices set failing_checks = null, last_user_id = auth.uid(), last_seen_at = now() where id = v_device.id;
  else
    v_notify := v_device.last_health_alert_at is null or (v_device.last_health_alert_at at time zone 'Asia/Kolkata')::date < v_today;
    update public.desktop_devices
       set failing_checks = v_failing,
           last_health_alert_at = case when v_notify then now() else last_health_alert_at end,
           last_user_id = auth.uid(),
           last_seen_at = now()
     where id = v_device.id;
  end if;

  return jsonb_build_object(
    'status', 'ok', 'notify', v_notify, 'device_id', v_device.id, 'device_name', v_device.device_name,
    'failing', to_jsonb(coalesce(v_failing, '{}'::text[])), 'day', v_today
  );
end;
$$;

comment on function public.desktop_report_health(text, text[]) is
  'POST /api/desktop/health (§7.25.5): stores the selectors client mode found failing; notify is true at most once per IST day per PC. Staff only.';

-- =============================================================================================
-- desktop_log_access_denied
-- =============================================================================================
create or replace function public.desktop_log_access_denied(
  p_device_key text,
  p_number_id uuid,
  p_chat_title text,
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
  v_device public.desktop_devices%rowtype;
  v_title text := left(regexp_replace(btrim(coalesce(p_chat_title, '')), '\s+', ' ', 'g'), 300);
  v_group public.client_whatsapp_groups%rowtype;
  v_label text;
  v_audit uuid;
begin
  if not public.is_staff() then
    raise exception 'USER: TaxWise Desktop is for the firm''s staff.' using errcode = 'P0001';
  end if;
  select * into v_device from public.desktop_devices where device_key = p_device_key;
  if not found then
    return jsonb_build_object('status', 'not_found', 'error', 'This PC hasn''t checked in with TaxWise yet. Restart TaxWise Desktop.');
  end if;
  if v_device.revoked_at is not null then
    return jsonb_build_object('status', 'revoked');
  end if;

  select n.label into v_label from public.firm_whatsapp_numbers n where n.id = p_number_id;
  if v_title <> '' then
    select * into v_group from public.client_whatsapp_groups g
    where lower(g.name) = lower(v_title) and g.deleted_at is null
    order by (g.status <> 'closed') desc, g.created_at desc
    limit 1;
  end if;

  v_audit := public.log_audit_event(
    'access_denied',
    case when v_group.id is not null then 'client_whatsapp_group' else 'whatsapp_chat' end,
    v_group.id::text,
    'desktop.access_denied',
    jsonb_build_object(
      'chat_title', v_title,
      'number_id', p_number_id,
      'number_label', v_label,
      'device_id', v_device.id,
      'device_name', v_device.device_name,
      'client_id', v_group.client_id
    ),
    false,
    'Not one of your clients',
    p_ip,
    p_user_agent
  );
  return jsonb_build_object('status', 'ok', 'audit_id', v_audit);
end;
$$;

comment on function public.desktop_log_access_denied(text, uuid, text, text, text) is
  'POST /api/desktop/access-denied (§7.25.5): an access_denied audit row for a chat client mode closed, on the matching client group or on resource whatsapp_chat, with the chat title, number and PC. Staff only.';

-- =============================================================================================
-- rename_desktop_device
-- =============================================================================================
create or replace function public.rename_desktop_device(p_device_id uuid, p_name text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_old text;
begin
  if not public.is_partner() then
    raise exception 'USER: Only a Partner can rename a PC.' using errcode = 'P0001';
  end if;
  if length(v_name) < 2 or length(v_name) > 100 then
    raise exception 'USER: Enter a name of 2 to 100 characters, such as FRONTDESK-2.' using errcode = 'P0001';
  end if;
  select device_name into v_old from public.desktop_devices where id = p_device_id for update;
  if not found then
    raise exception 'USER: That PC is no longer listed. Reload the page.' using errcode = 'P0001';
  end if;
  update public.desktop_devices set device_name = v_name, renamed_at = now(), renamed_by = auth.uid() where id = p_device_id;
  return jsonb_build_object('id', p_device_id, 'before', v_old, 'after', v_name);
end;
$$;

comment on function public.rename_desktop_device(uuid, text) is 'Partner: renames a TaxWise Desktop PC; later check-ins keep the name (§5.13).';

revoke execute on function
  public.desktop_checkin(text, text, text, text),
  public.desktop_touch_device(text),
  public.desktop_may_use_number(public.firm_whatsapp_numbers),
  public.desktop_link_number(text, uuid, boolean),
  public.desktop_report_health(text, text[]),
  public.desktop_log_access_denied(text, uuid, text, text, text),
  public.rename_desktop_device(uuid, text)
from public, anon;
grant execute on function
  public.desktop_checkin(text, text, text, text),
  public.desktop_touch_device(text),
  public.desktop_may_use_number(public.firm_whatsapp_numbers),
  public.desktop_link_number(text, uuid, boolean),
  public.desktop_report_health(text, text[]),
  public.desktop_log_access_denied(text, uuid, text, text, text),
  public.rename_desktop_device(uuid, text)
to authenticated, service_role;
