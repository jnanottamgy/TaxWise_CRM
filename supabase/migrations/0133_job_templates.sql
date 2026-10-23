-- 0133 · Job templates and recurring-task automations (§5.5, §7.6.2, §7.6.7, §4.1 "Job templates:
-- Partner ✅ Manager ✅ Employee use only").
--
-- save_job_template(p, expected_updated_at)  Partner/Manager: creates or edits a template with its
--   steps in one transaction (the step list replaces the old one: kept steps are updated in place,
--   removed ones deleted, new ones added, in the order given). Optimistic concurrency on the
--   template's updated_at (§13); the template's updated_at moves with every save, step edits too.
-- task_automations_guard: a recurring-task automation names a client and the person who set it up
--   (created_by = the signed-in user for API callers), and its config is an object.

set search_path = public, extensions;

create or replace function public.save_job_template(p jsonb, p_expected_updated_at timestamptz default null)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_id uuid := public.try_uuid(p ->> 'id');
  v_name text := left(nullif(btrim(p ->> 'name'), ''), 120);
  v_service public.service_type;
  v_description text := left(nullif(btrim(p ->> 'description'), ''), 2000);
  v_lead int;
  v_active boolean := coalesce((p ->> 'is_active')::boolean, true);
  v_items jsonb := case when jsonb_typeof(p -> 'items') = 'array' then p -> 'items' else '[]'::jsonb end;
  v_item jsonb;
  v_ord int := 0;
  v_item_id uuid;
  v_keep uuid[] := '{}';
  v_offset int;
  v_title text;
  v_current record;
  v_updated_at timestamptz;
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only a Partner or Manager can change job templates.' using errcode = 'P0001';
  end if;
  if v_name is null then
    raise exception 'USER: Name the template.' using errcode = 'P0001';
  end if;
  begin
    v_service := (p ->> 'service_type')::public.service_type;
    v_lead := nullif(p ->> 'default_lead_days', '')::int;
  exception when others then
    raise exception 'USER: Check the service and the lead days.' using errcode = 'P0001';
  end;
  if v_service is null then
    raise exception 'USER: Choose the service.' using errcode = 'P0001';
  end if;
  if v_lead is not null and (v_lead < 0 or v_lead > 366) then
    raise exception 'USER: Lead days must be between 0 and 366.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(v_items) = 0 then
    raise exception 'USER: Add at least one step.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(v_items) > 100 then
    raise exception 'USER: A template can have at most 100 steps.' using errcode = 'P0001';
  end if;

  if v_id is null then
    insert into public.job_templates (name, service_type, description, default_lead_days, is_active)
    values (v_name, v_service, v_description, v_lead, v_active)
    returning id into v_id;
  else
    select id, updated_at into v_current from public.job_templates where id = v_id for update;
    if not found then
      raise exception 'USER: That job template no longer exists.' using errcode = 'P0001';
    end if;
    if p_expected_updated_at is not null and date_trunc('milliseconds', v_current.updated_at) <> date_trunc('milliseconds', p_expected_updated_at) then
      raise exception 'USER: This template was changed by someone else. Reload to see their changes.' using errcode = 'P0001';
    end if;
    update public.job_templates
       set name = v_name, service_type = v_service, description = v_description,
           default_lead_days = v_lead, is_active = v_active, updated_at = now()
     where id = v_id;
  end if;

  for v_item in select value from jsonb_array_elements(v_items)
  loop
    v_title := left(nullif(btrim(v_item ->> 'title'), ''), 300);
    if v_title is null then
      raise exception 'USER: Every step needs a title (step %).', v_ord + 1 using errcode = 'P0001';
    end if;
    begin
      v_offset := coalesce(nullif(v_item ->> 'offset_days', '')::int, 0);
    exception when others then
      raise exception 'USER: Enter the days for step % as a whole number.', v_ord + 1 using errcode = 'P0001';
    end;
    if v_offset < -366 or v_offset > 366 then
      raise exception 'USER: Step % must be within 366 days of the due date.', v_ord + 1 using errcode = 'P0001';
    end if;
    v_item_id := public.try_uuid(v_item ->> 'id');
    if v_item_id is not null then
      update public.job_template_items
         set title = v_title,
             description = left(nullif(btrim(v_item ->> 'description'), ''), 2000),
             offset_days = v_offset,
             sort_order = v_ord
       where id = v_item_id and template_id = v_id;
      if not found then
        v_item_id := null;
      end if;
    end if;
    if v_item_id is null then
      insert into public.job_template_items (template_id, title, description, offset_days, sort_order)
      values (v_id, v_title, left(nullif(btrim(v_item ->> 'description'), ''), 2000), v_offset, v_ord)
      returning id into v_item_id;
    end if;
    v_keep := v_keep || v_item_id;
    v_ord := v_ord + 1;
  end loop;

  delete from public.job_template_items where template_id = v_id and not (id = any (v_keep));

  select updated_at into v_updated_at from public.job_templates where id = v_id;
  return jsonb_build_object('id', v_id, 'items', v_ord, 'updated_at', v_updated_at);
end;
$$;

comment on function public.save_job_template(jsonb, timestamptz) is
  'Partner/Manager: creates or edits a job template with its steps in one transaction; optimistic concurrency on updated_at (§7.6.2, §13).';

revoke execute on function public.save_job_template(jsonb, timestamptz) from public, anon;
grant execute on function public.save_job_template(jsonb, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- task_automations_guard
-- ---------------------------------------------------------------------------------------------
create or replace function public.task_automations_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if public.is_api_caller() then
    if tg_op = 'INSERT' then
      new.created_by := auth.uid();
    else
      new.created_by := old.created_by;
    end if;
  end if;
  if new.type = 'recurring_task' then
    if new.client_id is null then
      raise exception 'USER: Choose the client the recurring task is for.' using errcode = 'P0001';
    end if;
    if new.config is null or jsonb_typeof(new.config) <> 'object' then
      raise exception 'USER: Set up what the recurring task creates.' using errcode = 'P0001';
    end if;
    if nullif(btrim(new.config ->> 'title'), '') is null then
      raise exception 'USER: Give the recurring task a title.' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

comment on function public.task_automations_guard() is
  'Trigger: a recurring-task automation has a client, a config object with a title, and records who set it up (§7.6.7).';

drop trigger if exists task_automations_guard on public.task_automations;
create trigger task_automations_guard before insert or update on public.task_automations
  for each row execute function public.task_automations_guard();

revoke execute on function public.task_automations_guard() from public, anon, authenticated;
