-- 0110 · Clients: the list, status changes with a reason, and delete to the recycle bin
-- (§3.6, §5.3, §7.3.1, §7.3.4, §13).
--
--   clients.updated_by                    who last changed the row (stamped by a trigger), so an edit
--                                         refused for concurrency says "Changed by <name> at 12:41" (§13).
--   firm_settings.client_notify_channels  the default "Notify the client by" choice in the onboarding
--                                         wizard (§7.3.2 step 5 "with defaults from Settings").
--   client_status_history                 every status change with its reason (§7.3.4).
--   effective_gst_scheme(...)             the §6.6 scheme for a registered client: QRMP up to the
--                                         turnover limit unless monthly was chosen, monthly above it
--                                         and when no turnover is recorded (mirror: lib/domain/scale.ts).
--   clients_list                          the client list (§7.3.1): one row per client with owner,
--                                         group, services, next deadline, open/overdue tasks,
--                                         outstanding (Partner/Manager only; null for Employees),
--                                         last contact, portal, WhatsApp group, unreachable, covered
--                                         now. security_invoker: the caller's RLS decides the rows.
--   change_client_status(id, to, reason, updated_at)
--                                         Partner/Manager: status + history + timeline in one go.
--   delete_client(id, updated_at)         Partner: moves the client to the recycle bin with its tasks,
--                                         documents, invoices and WhatsApp groups (same deleted_at, so a
--                                         restore can bring them back together); refused while an issued
--                                         invoice is unpaid (§7.3.4).

set search_path = public, extensions;

-- =============================================================================================
-- clients.updated_by
-- =============================================================================================
alter table public.clients add column if not exists updated_by uuid;

comment on column public.clients.updated_by is 'Who last changed the row (stamped by clients_stamp_updated_by), for the concurrency message (§13).';

-- Named so it runs after clients_guard (triggers fire in name order): an Employee's notes edit is
-- checked before updated_by changes.
create or replace function public.clients_stamp_updated_by()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if auth.uid() is not null then
    new.updated_by := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists clients_stamp_updated_by on public.clients;
create trigger clients_stamp_updated_by before insert or update on public.clients
  for each row execute function public.clients_stamp_updated_by();

revoke execute on function public.clients_stamp_updated_by() from public, anon, authenticated;

-- "Changed by Anita at 12:41. Reload to see their changes." (§13), for a client the caller can see.
create or replace function public.client_change_conflict(p_client_id uuid)
returns text
language sql
stable
security definer
set search_path = public, extensions
as $$
  select format(
    'USER: Changed by %s at %s. Reload to see their changes.',
    coalesce(p.full_name, 'someone else'),
    to_char(c.updated_at at time zone 'Asia/Kolkata', 'HH24:MI')
  )
  from public.clients c
  left join public.profiles p on p.id = c.updated_by
  where c.id = p_client_id
    and public.is_staff()
    and (public.is_manager_or_partner() or c.id in (select public.staff_client_ids()))
$$;

comment on function public.client_change_conflict(uuid) is
  'The concurrency refusal for a client row: "Changed by <name> at <IST time>. Reload to see their changes." (§13).';

-- =============================================================================================
-- firm_settings.client_notify_channels (§7.3.2 step 5)
-- =============================================================================================
alter table public.firm_settings
  add column if not exists client_notify_channels text[] not null default '{email,whatsapp}';

alter table public.firm_settings drop constraint if exists firm_settings_client_notify_channels_values;
alter table public.firm_settings
  add constraint firm_settings_client_notify_channels_values
  check (client_notify_channels <@ array['email', 'whatsapp', 'portal']::text[]);

comment on column public.firm_settings.client_notify_channels is
  'Default "Notify the client by" channels for new clients (email, whatsapp hand-off, portal) (§7.3.2 step 5).';

-- =============================================================================================
-- client_status_history (§7.3.4: "Status changes record a reason")
-- =============================================================================================
create table if not exists public.client_status_history (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  from_status public.client_status,
  to_status public.client_status not null,
  reason text not null constraint client_status_history_reason_present check (nullif(btrim(reason), '') is not null),
  changed_by uuid not null,
  changed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.client_status_history enable row level security;

drop trigger if exists set_updated_at on public.client_status_history;
create trigger set_updated_at before insert or update on public.client_status_history
  for each row execute function public.set_updated_at();

create index if not exists client_status_history_client_idx on public.client_status_history (client_id, changed_at desc);

create policy client_status_history_select on public.client_status_history
  for select to authenticated
  using ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()));
create policy client_status_history_insert on public.client_status_history
  for insert to authenticated
  with check ((select public.is_manager_or_partner()) and changed_by = (select auth.uid()));
revoke update, delete, truncate on public.client_status_history from authenticated, anon;

comment on table public.client_status_history is 'Every client status change with its reason and who made it (§7.3.4).';

-- =============================================================================================
-- Indexes the list needs (§13: lists of 2,000 clients paginate in < 300 ms)
-- =============================================================================================
create index if not exists client_contacts_client_idx on public.client_contacts (client_id);
create index if not exists clients_updated_at_idx on public.clients (updated_at desc) where deleted_at is null;
create index if not exists clients_pan_idx on public.clients (pan);

-- =============================================================================================
-- effective_gst_scheme (§6.6). Mirror of gstSchemeDecision in lib/domain/scale.ts: null for a
-- client that isn't GST-registered; monthly when no turnover is recorded (unless QRMP was chosen,
-- which is kept); monthly above the QRMP limit whatever was recorded; otherwise the recorded choice,
-- else QRMP. The limit is the statutory parameter in force today (gst.qrmp_turnover_limit).
-- =============================================================================================
create or replace function public.effective_gst_scheme(
  p_registration public.gst_registration,
  p_scheme public.gst_scheme,
  p_turnover numeric,
  p_limit numeric
)
returns text
language sql
immutable
set search_path = public, extensions
as $$
  select case
    when p_registration is distinct from 'registered' then null
    when p_turnover is null then coalesce(p_scheme::text, 'monthly')
    when p_turnover > coalesce(p_limit, 50000000) then 'monthly'
    else coalesce(p_scheme::text, 'qrmp')
  end
$$;

comment on function public.effective_gst_scheme(public.gst_registration, public.gst_scheme, numeric, numeric) is
  'The GST filing scheme a registered client files under (§6.6; mirror of gstSchemeDecision in lib/domain/scale.ts).';

-- =============================================================================================
-- clients_list (§7.3.1)
-- =============================================================================================
create or replace view public.clients_list with (security_invoker = true) as
select
  c.id,
  c.client_code,
  c.display_name,
  c.legal_name,
  c.entity_type,
  c.entity_type_other,
  c.pan,
  c.gstin,
  c.tan,
  c.gst_registration,
  c.gst_scheme,
  public.effective_gst_scheme(
    c.gst_registration, c.gst_scheme, c.annual_turnover,
    (select public.jsonb_to_numeric(public.statutory_param_value('gst.qrmp_turnover_limit', public.today_ist())))
  ) as effective_gst_scheme,
  c.state_code,
  c.email,
  c.phone,
  c.whatsapp,
  c.city,
  c.status,
  c.priority,
  c.owner_employee_id,
  o.full_name as owner_name,
  c.group_id,
  g.name::text as group_name,
  c.annual_turnover,
  c.turnover_fy,
  c.onboarded_at,
  c.created_at,
  c.updated_at,
  c.deleted_at,
  (c.portal_user_id is not null) as has_portal,
  c.portal_invited_at,
  coalesce(s.service_types, '{}'::public.service_type[]) as service_types,
  d.next_due_date,
  d.next_due_title,
  coalesce(t.open_tasks, 0)::int as open_tasks,
  coalesce(t.overdue_tasks, 0)::int as overdue_tasks,
  case when public.is_manager_or_partner() then coalesce(i.outstanding, 0) end as outstanding,
  case when public.is_manager_or_partner() then coalesce(i.overdue_invoices, 0) > 0 end as has_overdue_invoices,
  m.last_contact_at,
  coalesce(w.status, 'none') as whatsapp_group_status,
  (
    nullif(btrim(c.email::text), '') is null
    and nullif(btrim(c.phone), '') is null
    and nullif(btrim(c.whatsapp), '') is null
    and not exists (
      select 1 from public.client_contacts cc
      where cc.client_id = c.id
        and (nullif(btrim(cc.email::text), '') is not null or nullif(btrim(cc.phone), '') is not null or nullif(btrim(cc.whatsapp), '') is not null)
    )
  ) as unreachable,
  exists (
    select 1 from public.covers_in_force f
    where (f.kind = 'client' and f.client_id = c.id)
       or (f.kind = 'person' and (
            f.absent_employee_id = c.owner_employee_id
            or exists (select 1 from public.client_team_members tm where tm.client_id = c.id and tm.employee_id = f.absent_employee_id)
          ))
  ) as covered_now
from public.clients c
left join public.employee_directory o on o.id = c.owner_employee_id
left join public.client_groups g on g.id = c.group_id
left join lateral (
  select array_agg(distinct sp.service_type order by sp.service_type) as service_types
  from public.client_services_public sp
  where sp.client_id = c.id and sp.is_active
) s on true
left join lateral (
  select e.due_date as next_due_date, e.title as next_due_title
  from public.compliance_events e
  where e.client_id = c.id and e.status = 'pending'
  order by e.due_date, e.title
  limit 1
) d on true
left join lateral (
  select
    count(*) filter (where tk.status <> 'filed_done') as open_tasks,
    count(*) filter (where tk.status <> 'filed_done' and tk.due_date < public.today_ist()) as overdue_tasks
  from public.tasks tk
  where tk.client_id = c.id and tk.deleted_at is null
) t on true
left join lateral (
  select
    sum(inv.outstanding_amount) as outstanding,
    count(*) filter (where inv.status in ('sent', 'partially_paid') and inv.outstanding_amount > 0 and inv.due_date < public.today_ist()) as overdue_invoices
  from public.invoices inv
  where inv.client_id = c.id
    and inv.deleted_at is null
    and inv.cancelled_at is null
    and inv.status in ('sent', 'partially_paid', 'disputed')
) i on true
left join lateral (
  select max(coalesce(ms.sent_at, ms.created_at)) as last_contact_at
  from public.messages ms
  where ms.client_id = c.id
) m on true
left join lateral (
  select wg.status::text as status
  from public.client_whatsapp_groups_public wg
  where wg.client_id = c.id and wg.deleted_at is null
  order by (wg.status <> 'closed') desc, wg.is_primary desc, wg.created_at desc
  limit 1
) w on true;

comment on view public.clients_list is
  'The client list (§7.3.1): owner, group, services, next deadline, open/overdue tasks, outstanding (Partner/Manager only), last contact, portal, WhatsApp group, unreachable, covered now. security_invoker: the caller''s RLS.';

revoke all on public.clients_list from anon, public;
revoke insert, update, delete, truncate, references, trigger on public.clients_list from authenticated;
grant select on public.clients_list to authenticated, service_role;

-- =============================================================================================
-- change_client_status (§7.3.4)
-- =============================================================================================
create or replace function public.client_status_label(p public.client_status)
returns text
language sql
immutable
set search_path = public, extensions
as $$
  select case p when 'active' then 'Active' when 'pending' then 'Pending' when 'on_hold' then 'On hold' when 'inactive' then 'Inactive' end
$$;

create or replace function public.change_client_status(
  p_client_id uuid,
  p_to public.client_status,
  p_reason text,
  p_updated_at timestamptz default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.clients%rowtype;
  v_updated timestamptz;
  v_reason text := nullif(btrim(p_reason), '');
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only Partners and Managers can change a client''s status.' using errcode = 'P0001';
  end if;
  if p_to is null then
    raise exception 'USER: Choose the new status.' using errcode = 'P0001';
  end if;
  if v_reason is null then
    raise exception 'USER: Give a reason for the status change.' using errcode = 'P0001';
  end if;

  select * into v_row from public.clients c where c.id = p_client_id for update;
  if not found or v_row.deleted_at is not null then
    raise exception 'USER: That client isn''t in the client list any more. It may be in the recycle bin.' using errcode = 'P0001';
  end if;
  if p_updated_at is not null and v_row.updated_at <> p_updated_at then
    raise exception '%', public.client_change_conflict(p_client_id) using errcode = 'P0001';
  end if;
  if v_row.status = p_to then
    raise exception 'USER: % is already %.', v_row.display_name, public.client_status_label(p_to) using errcode = 'P0001';
  end if;

  update public.clients set status = p_to where id = p_client_id returning updated_at into v_updated;

  insert into public.client_status_history (client_id, from_status, to_status, reason, changed_by)
  values (p_client_id, v_row.status, p_to, left(v_reason, 1000), v_uid);

  insert into public.client_timeline_events (client_id, event_type, title, description, metadata, performed_by)
  values (
    p_client_id,
    'client_status_changed',
    format('Status changed from %s to %s', public.client_status_label(v_row.status), public.client_status_label(p_to)),
    left(v_reason, 1000),
    jsonb_build_object('from', v_row.status, 'to', p_to),
    v_uid
  );

  return jsonb_build_object('updated_at', v_updated, 'from', v_row.status, 'to', p_to, 'display_name', v_row.display_name);
end;
$$;

comment on function public.change_client_status(uuid, public.client_status, text, timestamptz) is
  'Partner/Manager: changes a client''s status with a reason, writing client_status_history and a timeline entry (§7.3.4). p_updated_at gives optimistic concurrency (§13).';

-- =============================================================================================
-- delete_client (§7.3.4, §7.19)
-- =============================================================================================
create or replace function public.delete_client(p_client_id uuid, p_updated_at timestamptz default null)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_row public.clients%rowtype;
  v_unpaid int;
  v_tasks int := 0;
  v_documents int := 0;
  v_invoices int := 0;
  v_groups int := 0;
begin
  if not public.is_partner() then
    raise exception 'USER: Only a Partner can delete a client. Put it on hold or make it inactive instead.' using errcode = 'P0001';
  end if;

  select * into v_row from public.clients c where c.id = p_client_id for update;
  if not found then
    raise exception 'USER: That client no longer exists.' using errcode = 'P0001';
  end if;
  if v_row.deleted_at is not null then
    raise exception 'USER: % is already in the recycle bin.', v_row.display_name using errcode = 'P0001';
  end if;
  if p_updated_at is not null and v_row.updated_at <> p_updated_at then
    raise exception '%', public.client_change_conflict(p_client_id) using errcode = 'P0001';
  end if;

  select count(*) into v_unpaid
  from public.invoices i
  where i.client_id = p_client_id
    and i.deleted_at is null
    and i.cancelled_at is null
    and i.status in ('sent', 'partially_paid', 'disputed')
    and i.outstanding_amount > 0;
  if v_unpaid > 0 then
    raise exception 'USER: % has % unpaid invoice%. Record the payments or waive them first, then delete the client.',
      v_row.display_name, v_unpaid, case when v_unpaid = 1 then '' else 's' end using errcode = 'P0001';
  end if;

  update public.tasks set deleted_at = v_now, deleted_by = v_uid where client_id = p_client_id and deleted_at is null;
  get diagnostics v_tasks = row_count;
  update public.documents set deleted_at = v_now, deleted_by = v_uid where client_id = p_client_id and deleted_at is null;
  get diagnostics v_documents = row_count;
  update public.invoices set deleted_at = v_now, deleted_by = v_uid where client_id = p_client_id and deleted_at is null;
  get diagnostics v_invoices = row_count;
  update public.client_whatsapp_groups set deleted_at = v_now where client_id = p_client_id and deleted_at is null;
  get diagnostics v_groups = row_count;

  update public.clients set deleted_at = v_now, deleted_by = v_uid where id = p_client_id;

  insert into public.client_timeline_events (client_id, event_type, title, metadata, performed_by)
  values (
    p_client_id, 'client_deleted', format('Moved to the recycle bin: %s (%s)', v_row.display_name, v_row.client_code),
    jsonb_build_object('tasks', v_tasks, 'documents', v_documents, 'whatsapp_groups', v_groups),
    v_uid
  );

  return jsonb_build_object(
    'deleted_at', v_now, 'display_name', v_row.display_name, 'client_code', v_row.client_code,
    'tasks', v_tasks, 'documents', v_documents, 'invoices', v_invoices, 'whatsapp_groups', v_groups
  );
end;
$$;

comment on function public.delete_client(uuid, timestamptz) is
  'Partner: moves a client to the recycle bin with its tasks, documents, invoices and WhatsApp groups (one deleted_at for all, so a restore brings them back together). Refused while an issued invoice is unpaid (§7.3.4, §7.19).';

-- =============================================================================================
-- Grants
-- =============================================================================================
revoke execute on function
  public.client_change_conflict(uuid),
  public.effective_gst_scheme(public.gst_registration, public.gst_scheme, numeric, numeric),
  public.client_status_label(public.client_status),
  public.change_client_status(uuid, public.client_status, text, timestamptz),
  public.delete_client(uuid, timestamptz)
from public, anon;
grant execute on function
  public.client_change_conflict(uuid),
  public.effective_gst_scheme(public.gst_registration, public.gst_scheme, numeric, numeric),
  public.client_status_label(public.client_status),
  public.change_client_status(uuid, public.client_status, text, timestamptz),
  public.delete_client(uuid, timestamptz)
to authenticated, service_role;
