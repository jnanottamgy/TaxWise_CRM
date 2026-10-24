-- 0191 · Registers: the portal credentials vault (§7.15.1, §4.1, §4.6, §4.7, §12, §18.3 Partner 8).
--
-- The ciphertext stays where 0004/0033 put it: client_credentials has no API privileges at all,
-- client_credentials_list never carries the ciphertext, and save_client_credential is the only
-- function an API role may run that mentions it. This migration adds what revealing a password
-- needs, without handing the ciphertext to anyone:
--
--   vault_client_ids()               the clients whose stored passwords the caller may reveal:
--                                    Partner/Manager every client; an Employee with Vault access
--                                    their own clients (owner or engagement team) plus clients they
--                                    cover through a cover in force that includes portal passwords
--                                    (client_covers.include_vault, §4.7); anyone else none.
--   credential_reveal_check(id)      may the caller reveal this login? {allowed, reason, client_id,
--                                    via_cover}, with the refusal in plain words.
--   record_credential_reveal(id, …)  re-checks, then writes the access log (who, when, IP) and the
--                                    credential_viewed audit row in one transaction. The server
--                                    action (server/actions/credentials.ts) decrypts with
--                                    server/vault.ts only after the check, and returns the password
--                                    only if this record was written.
--   client_credentials_register      the vault list for staff: the login without the ciphertext,
--                                    the client, who last changed it, whether the caller may reveal
--                                    it, and (Partners/Managers only) when it was last viewed.
--   credential_access_trail          the access trail per credential with the person's name
--                                    (credential_access_logs is Partner/Manager only, 0033).

set search_path = public, extensions;

-- =============================================================================================
-- vault_client_ids()
-- =============================================================================================
create or replace function public.vault_client_ids()
returns setof uuid
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_role public.app_role := public.app_role();
  v_me uuid;
  v_vault boolean;
begin
  if v_role in ('partner', 'manager') then
    return query select c.id from public.clients c where c.deleted_at is null;
    return;
  end if;
  if v_role is distinct from 'employee' then
    return;
  end if;
  select e.id, e.vault_access into v_me, v_vault
  from public.employees e
  where e.profile_id = auth.uid() and e.is_active and e.deleted_at is null;
  if v_me is null or not coalesce(v_vault, false) then
    return;
  end if;

  return query
    -- own clients: owner or on the engagement team
    select c.id from public.clients c where c.owner_employee_id = v_me and c.deleted_at is null
    union
    select tm.client_id
    from public.client_team_members tm
    join public.clients c on c.id = tm.client_id and c.deleted_at is null
    where tm.employee_id = v_me
    union
    -- a client cover in force that includes portal passwords
    select f.client_id
    from public.covers_in_force f
    join public.clients c on c.id = f.client_id and c.deleted_at is null
    where f.kind = 'client' and f.cover_employee_id = v_me and f.include_vault
    union
    -- a person cover in force that includes portal passwords: the absent person's clients
    select c.id
    from public.covers_in_force f
    join public.clients c on c.owner_employee_id = f.absent_employee_id and c.deleted_at is null
    where f.kind = 'person' and f.cover_employee_id = v_me and f.include_vault and f.absent_employee_id is not null
    union
    select tm.client_id
    from public.covers_in_force f
    join public.client_team_members tm on tm.employee_id = f.absent_employee_id
    join public.clients c on c.id = tm.client_id and c.deleted_at is null
    where f.kind = 'person' and f.cover_employee_id = v_me and f.include_vault and f.absent_employee_id is not null;
end;
$$;

comment on function public.vault_client_ids() is
  'Clients whose stored portal passwords the caller may reveal: Partner/Manager all; Employee with Vault access own clients plus covers in force with include_vault (§4.1, §4.7, §7.15.1).';

-- =============================================================================================
-- credential_reveal_check(p_credential_id) → jsonb {allowed, reason, client_id, via_cover}
-- =============================================================================================
create or replace function public.credential_reveal_check(p_credential_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_role public.app_role := public.app_role();
  v_client uuid;
  v_me uuid;
  v_vault boolean;
  v_own boolean;
  v_cover boolean;
begin
  if v_role is null or v_role not in ('partner', 'manager', 'employee') then
    return jsonb_build_object('allowed', false, 'reason', 'Only the firm''s staff can reveal stored portal passwords.', 'client_id', null, 'via_cover', false);
  end if;

  select cc.client_id into v_client
  from public.client_credentials cc
  join public.clients c on c.id = cc.client_id and c.deleted_at is null
  where cc.id = p_credential_id;
  if v_client is null or not public.can_see_client(v_client) then
    return jsonb_build_object('allowed', false, 'reason', 'That stored login doesn''t exist, or it isn''t for one of your clients.', 'client_id', null, 'via_cover', false);
  end if;

  if v_role in ('partner', 'manager') then
    return jsonb_build_object('allowed', true, 'reason', null, 'client_id', v_client, 'via_cover', false);
  end if;

  select e.id, e.vault_access into v_me, v_vault
  from public.employees e
  where e.profile_id = auth.uid() and e.is_active and e.deleted_at is null;
  if v_me is null then
    return jsonb_build_object('allowed', false, 'reason', 'Your staff record isn''t active. Ask a Partner.', 'client_id', v_client, 'via_cover', false);
  end if;
  if not coalesce(v_vault, false) then
    return jsonb_build_object('allowed', false, 'reason', 'Revealing stored portal passwords needs Vault access. Ask a Partner to grant it.', 'client_id', v_client, 'via_cover', false);
  end if;

  select exists (
    select 1 from public.clients c where c.id = v_client and c.owner_employee_id = v_me
  ) or exists (
    select 1 from public.client_team_members tm where tm.client_id = v_client and tm.employee_id = v_me
  ) into v_own;
  if v_own then
    return jsonb_build_object('allowed', true, 'reason', null, 'client_id', v_client, 'via_cover', false);
  end if;

  select v_client in (select public.vault_client_ids()) into v_cover;
  if v_cover then
    return jsonb_build_object('allowed', true, 'reason', null, 'client_id', v_client, 'via_cover', true);
  end if;
  return jsonb_build_object(
    'allowed', false,
    'reason', 'You see this client through a cover that doesn''t include portal passwords. Ask a Partner to add them to the cover.',
    'client_id', v_client,
    'via_cover', true
  );
end;
$$;

comment on function public.credential_reveal_check(uuid) is
  'Whether the caller may reveal a stored portal password, with the refusal in plain words. Never returns the ciphertext (§4.1, §4.6, §4.7, §7.15.1).';

-- =============================================================================================
-- record_credential_reveal(p_credential_id, p_ip, p_user_agent) → jsonb {access_log_id, audit_id, logged_at}
-- =============================================================================================
create or replace function public.record_credential_reveal(p_credential_id uuid, p_ip text default null, p_user_agent text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_check jsonb := public.credential_reveal_check(p_credential_id);
  v_log uuid;
  v_audit uuid;
  v_at timestamptz := now();
  v_portal text;
  v_label text;
  v_username text;
  v_client_name text;
begin
  if not coalesce((v_check ->> 'allowed')::boolean, false) then
    raise exception 'USER: %', coalesce(v_check ->> 'reason', 'You can''t reveal this stored password.') using errcode = 'P0001';
  end if;

  select cc.portal, cc.portal_label, cc.username, c.display_name
    into v_portal, v_label, v_username, v_client_name
  from public.client_credentials cc
  join public.clients c on c.id = cc.client_id
  where cc.id = p_credential_id;

  insert into public.credential_access_logs (credential_id, user_id, action, ip, created_at)
  values (p_credential_id, auth.uid(), 'viewed', left(p_ip, 100), v_at)
  returning id into v_log;

  v_audit := public.log_audit_event(
    'credential_viewed',
    'client_credential',
    p_credential_id::text,
    'credentials.reveal',
    jsonb_build_object(
      'client_id', v_check ->> 'client_id',
      'client_name', v_client_name,
      'portal', v_portal,
      'portal_label', v_label,
      'username', v_username,
      'via_cover', coalesce((v_check ->> 'via_cover')::boolean, false),
      'access_log_id', v_log
    ),
    true,
    null,
    p_ip,
    p_user_agent
  );

  return jsonb_build_object('access_log_id', v_log, 'audit_id', v_audit, 'logged_at', v_at);
end;
$$;

comment on function public.record_credential_reveal(uuid, text, text) is
  'Re-checks the reveal rights, then writes credential_access_logs (viewed, IP) and the credential_viewed audit row together. Called before a password is shown (§4.6, §7.15.1, §0.1 rule 12).';

revoke execute on function
  public.vault_client_ids(),
  public.credential_reveal_check(uuid),
  public.record_credential_reveal(uuid, text, text)
from public, anon;
grant execute on function
  public.vault_client_ids(),
  public.credential_reveal_check(uuid),
  public.record_credential_reveal(uuid, text, text)
to authenticated, service_role;

-- =============================================================================================
-- client_credentials_register: the vault list (no ciphertext).
-- Same visibility as client_credentials_list (0033); clients in the recycle bin are left out.
-- =============================================================================================
create or replace view public.client_credentials_register with (security_invoker = false, security_barrier = true) as
select
  cc.id,
  cc.client_id,
  c.display_name as client_name,
  c.client_code::text as client_code,
  c.status as client_status,
  c.owner_employee_id,
  cc.portal,
  cc.portal_label,
  cc.username,
  cc.login_url,
  cc.notes,
  cc.updated_by,
  ub.full_name as updated_by_name,
  cc.created_at,
  cc.updated_at,
  (cc.client_id in (select public.vault_client_ids())) as can_reveal,
  case when public.is_manager_or_partner() then (
    select max(l.created_at) from public.credential_access_logs l where l.credential_id = cc.id and l.action = 'viewed'
  ) end as last_viewed_at,
  case when public.is_manager_or_partner() then (
    select count(*)::int from public.credential_access_logs l where l.credential_id = cc.id and l.action = 'viewed'
  ) end as view_count
from public.client_credentials cc
join public.clients c on c.id = cc.client_id and c.deleted_at is null
left join public.employees ub on ub.profile_id = cc.updated_by
-- API callers: staff, each seeing the clients they may see. The service role and the jobs (no API
-- role) see every row, as they can read client_credentials itself.
where not public.is_api_caller()
   or (public.is_staff() and (public.is_manager_or_partner() or cc.client_id in (select public.staff_client_ids())));

comment on view public.client_credentials_register is
  'The vault list for staff: stored logins without the ciphertext, with the client, can_reveal and (Partners/Managers) the last view (§7.15.1).';

-- =============================================================================================
-- credential_access_trail: the access trail per credential (Partners/Managers, through 0033's
-- credential_access_logs policy; the view runs as the caller).
-- =============================================================================================
create or replace view public.credential_access_trail with (security_invoker = true) as
select
  l.id,
  l.credential_id,
  l.user_id,
  p.full_name as user_name,
  p.role as user_role,
  l.action,
  l.ip,
  l.created_at
from public.credential_access_logs l
left join public.profiles p on p.id = l.user_id;

comment on view public.credential_access_trail is
  'Who viewed, copied, created or changed a stored login, and from which IP (§7.15.1 "access trail per credential").';

revoke all on public.client_credentials_register, public.credential_access_trail from anon, public;
revoke insert, update, delete, truncate, references, trigger on public.client_credentials_register, public.credential_access_trail from authenticated;
grant select on public.client_credentials_register, public.credential_access_trail to authenticated, service_role;
