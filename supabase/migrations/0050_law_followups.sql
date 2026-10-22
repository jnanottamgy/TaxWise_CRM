-- 0050 · Law & rules follow-ups (§5.12, §7.7 'Extensions', §7.21 Law & rules).
--
-- 1. section_concordance gets verified_by / verified_on like the other three law tables, so the
--    Law & rules page can record who confirmed a [verify] row and when.
-- 2. apply_due_date_override(p_override_id): moves every matching UNFILED compliance event to the
--    extended date in one transaction, clears its reminder stamp so the reminder is re-planned, and
--    writes one history line per event citing the circular. Mirrors applyOverride() in
--    lib/domain/statutory-calendar.ts. SECURITY INVOKER: the caller's RLS applies (Partners only may
--    update law tables; compliance events follow their own policies).

set search_path = public, extensions;

alter table public.section_concordance
  add column if not exists verified_by uuid references public.profiles(id) on delete set null,
  add column if not exists verified_on date;

create or replace function public.apply_due_date_override(p_override_id uuid)
returns integer
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_override public.due_date_overrides%rowtype;
  v_moved integer := 0;
  v_user uuid := auth.uid();
  v_user_name text;
  r record;
begin
  if not public.is_partner() then
    raise exception 'USER: Only a Partner can apply a government extension.' using errcode = 'P0001';
  end if;

  select * into v_override from public.due_date_overrides where id = p_override_id;
  if not found then
    raise exception 'USER: That extension no longer exists.' using errcode = 'P0001';
  end if;

  select full_name into v_user_name from public.profiles where id = v_user;

  for r in
    select e.id, e.due_date, e.original_due_date
    from public.compliance_events e
    where e.rule_code = v_override.rule_code
      and e.filing_period = v_override.period_label
      and e.status = 'pending'
      and e.workflow_status not in ('filed', 'completed')
      and e.due_date is distinct from v_override.extended_due
    for update
  loop
    update public.compliance_events
       set due_date = v_override.extended_due,
           original_due_date = coalesce(r.original_due_date, r.due_date),
           override_id = v_override.id,
           reminder_sent_at = null
     where id = r.id;

    insert into public.activity_logs (entity_type, entity_id, action, description, user_id, user_name, metadata)
    values (
      'compliance_event', r.id, 'due_date_extended',
      format('Due date moved from %s to %s (%s).',
             to_char(r.due_date, 'DD Mon YYYY'), to_char(v_override.extended_due, 'DD Mon YYYY'), v_override.source_ref),
      v_user, v_user_name,
      jsonb_build_object('override_id', v_override.id, 'source_ref', v_override.source_ref,
                         'from', r.due_date, 'to', v_override.extended_due)
    );
    v_moved := v_moved + 1;
  end loop;

  return v_moved;
end;
$$;

revoke all on function public.apply_due_date_override(uuid) from public, anon;
grant execute on function public.apply_due_date_override(uuid) to authenticated;

insert into public.app_meta (key, value) values ('schema_version', '0050')
on conflict (key) do update set value = excluded.value;
