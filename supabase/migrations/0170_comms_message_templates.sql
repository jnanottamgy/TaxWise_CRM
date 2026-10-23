-- 0170 · Message templates (§5.9, §7.13.4; §4.1 "Job templates, message templates: Partner ✅
-- Manager ✅ Employee use only").
--
--   message_templates.updated_by        who last changed a template (stamped by the guard), for the
--                                       "Changed by … at …" concurrency message (§13).
--   message_template_variables()        the §7.13.4 variables, in picker order. Mirror of
--                                       lib/domain/templates.ts TEMPLATE_VARIABLES (tests/db/comms
--                                       keeps the two in step).
--   message_template_problems(text)     the unknown {{variables}} and malformed placeholders in a
--                                       text: `{{client_email}}`, `{{client name}}`, a stray `{{`.
--   message_templates_guard (trigger)   the database half of "unknown variables are rejected on
--       save" (the save action checks first with validateTemplate and names the field): trims the
--       name, refuses an empty name or body and anything over the limits, refuses unknown variables
--       and malformed placeholders in plain words, drops the subject of a WhatsApp-only template
--       (the subject is email's), and stamps created_by / updated_by from the session.
--   message_templates_select (replaces 0038)  Employees read only the templates that aren't about
--       money: payment reminders and quotations stay with Partners and Managers (§4.1), the same
--       rule is_money_message (0043) applies to the messages written from them.

set search_path = public, extensions;

alter table public.message_templates add column if not exists updated_by uuid;
comment on column public.message_templates.updated_by is 'profiles.id of who last changed the template (message_templates_guard), for the concurrency message (§13).';

-- ---------------------------------------------------------------------------------------------
-- The variable list and the check
-- ---------------------------------------------------------------------------------------------
create or replace function public.message_template_variables()
returns text[]
language sql
immutable
set search_path = public, extensions
as $$
  select array[
    'client_name', 'client_code', 'contact_name',
    'service_type', 'compliance_type', 'period', 'due_date', 'days_until_due', 'days_overdue', 'task_title', 'missing_items', 'priority',
    'invoice_number', 'amount', 'payment_link', 'upi_link',
    'portal_link', 'quotation_link',
    'firm_name', 'firm_phone', 'sender_name'
  ]::text[]
$$;

comment on function public.message_template_variables() is
  'The {{variables}} a message template may use, in picker order (§7.13.4). Mirror of lib/domain/templates.ts TEMPLATE_VARIABLES.';

create or replace function public.message_template_problems(p_text text)
returns text[]
language plpgsql
immutable
set search_path = public, extensions
as $$
declare
  v_allowed text[] := public.message_template_variables();
  v_out text[] := '{}';
  v_match text[];
  v_name text;
  v_rest text;
begin
  if p_text is null or p_text = '' then
    return v_out;
  end if;
  for v_match in select regexp_matches(p_text, '\{\{([^{}]*)\}\}', 'g') loop
    v_name := btrim(v_match[1]);
    if v_name !~ '^[A-Za-z_][A-Za-z0-9_]*$' then
      v_out := v_out || ('{{' || v_match[1] || '}}');
    elsif not (v_name = any (v_allowed)) then
      v_out := v_out || ('{{' || v_name || '}}');
    end if;
  end loop;
  v_rest := regexp_replace(p_text, '\{\{[^{}]*\}\}', '', 'g');
  if position('{{' in v_rest) > 0 then
    v_out := v_out || '{{'::text;
  end if;
  if position('}}' in v_rest) > 0 then
    v_out := v_out || '}}'::text;
  end if;
  -- Distinct, in order of first appearance.
  return coalesce((select array_agg(x order by first_at) from (select x, min(ord) as first_at from unnest(v_out) with ordinality as u(x, ord) group by x) d), '{}');
end;
$$;

comment on function public.message_template_problems(text) is
  'Unknown {{variables}} and malformed placeholders in a template text, distinct, in order of first use (§7.13.4).';

-- ---------------------------------------------------------------------------------------------
-- The guard
-- ---------------------------------------------------------------------------------------------
create or replace function public.message_templates_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_bad text[];
begin
  new.name := btrim(coalesce(new.name::text, ''));
  if new.name::text = '' then
    raise exception 'USER: Give the template a name.' using errcode = 'P0001';
  end if;
  if char_length(new.name::text) > 120 then
    raise exception 'USER: Keep the template name under 120 characters.' using errcode = 'P0001';
  end if;
  if btrim(coalesce(new.body, '')) = '' then
    raise exception 'USER: Write the message.' using errcode = 'P0001';
  end if;
  if char_length(new.body) > 5000 then
    raise exception 'USER: Keep the message under 5,000 characters.' using errcode = 'P0001';
  end if;

  new.subject := nullif(btrim(coalesce(new.subject, '')), '');
  if new.channel = 'whatsapp' then
    new.subject := null; -- the subject is email's (§7.13.4)
  end if;
  if new.subject is not null and char_length(new.subject) > 300 then
    raise exception 'USER: Keep the subject under 300 characters.' using errcode = 'P0001';
  end if;

  v_bad := public.message_template_problems(new.body) || public.message_template_problems(coalesce(new.subject, ''));
  if cardinality(v_bad) > 0 then
    raise exception 'USER: % available: %. Pick variables from the list, written as {{name}}.',
      case when cardinality(v_bad) = 1 then 'This variable or placeholder isn''t' else 'These variables or placeholders aren''t' end,
      array_to_string(v_bad, ', ')
      using errcode = 'P0001';
  end if;

  if public.is_api_caller() then
    if tg_op = 'INSERT' then
      new.created_by := auth.uid();
    else
      new.created_by := old.created_by;
    end if;
    new.updated_by := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists message_templates_guard on public.message_templates;
create trigger message_templates_guard before insert or update on public.message_templates
  for each row execute function public.message_templates_guard();

revoke execute on function public.message_templates_guard() from public, anon, authenticated;
revoke execute on function public.message_template_variables(), public.message_template_problems(text) from public, anon;
grant execute on function public.message_template_variables(), public.message_template_problems(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Employees: use only, and never the money templates (§4.1)
-- ---------------------------------------------------------------------------------------------
drop policy if exists message_templates_select on public.message_templates;
create policy message_templates_select on public.message_templates
  for select to authenticated
  using (
    (select public.is_manager_or_partner())
    or ((select public.is_staff()) and type not in ('payment_reminder', 'quotation'))
  );

create index if not exists message_templates_type_channel_idx on public.message_templates (type, channel) where is_active;
