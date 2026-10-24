-- 0220 · Retainer billing keeps its day of the month across runs (§7.9.6; wave C integration).
--
-- generate_retainer_drafts (0162) counted cycles from the stored next_billing_date, so a 31st stayed
-- on month ends only inside one run: a run that billed 31 Jan stored 28 Feb, and every later run
-- counted from the 28th (28 Mar, 28 Apr …). The engagement now remembers the day it was first
-- billed on:
--
--   client_services.billing_anchor_day  1–31, the day of the month billing falls on (clamped to
--       short months). Set from next_billing_date whenever anyone but the billing run sets or
--       changes that date (Client 360 → Services, onboarding); the run leaves it alone, so 28 Feb
--       stored after a February run still leads to 31 Mar. Money-side like the other billing columns:
--       client_services is Partner/Manager only (0033) and client_services_public leaves it out.
--   retainer_anchored_date(date, months, anchor)  the date `months` after a billing date on the
--       anchor day (mirror of lib/domain/invoice.ts anchoredAddMonths). months = 0 is the date
--       itself, so the stored date is always the first one billed.
--   generate_retainer_drafts  as 0162, with every cycle computed through retainer_anchored_date.
--
-- Existing rows: the anchor is the day of next_billing_date, except where the engagement's first
-- retainer draft fell on the 29th–31st and the stored date sits on the 28th or later of a month
-- (the drift above), where it is that first draft's day.

set search_path = public, extensions;

alter table public.client_services
  add column if not exists billing_anchor_day smallint
  constraint client_services_billing_anchor_day_check check (billing_anchor_day between 1 and 31);

comment on column public.client_services.billing_anchor_day is
  'The day of the month retainer billing falls on (1–31, clamped to short months); set from next_billing_date when a person sets it (0220).';

create or replace function public.retainer_anchored_date(p_date date, p_months int, p_anchor int)
returns date
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case
    when p_date is null then null
    when coalesce(p_months, 0) = 0 or p_anchor is null then (p_date + make_interval(months => coalesce(p_months, 0)))::date
    else (
      date_trunc('month', p_date + make_interval(months => p_months))::date
      + (least(greatest(p_anchor, 1),
               extract(day from (date_trunc('month', p_date + make_interval(months => p_months)) + interval '1 month - 1 day'))::int) - 1)
    )
  end
$$;

comment on function public.retainer_anchored_date(date, int, int) is
  'The date p_months after p_date on day p_anchor of that month, clamped to its length (31 Jan +1 → 28 Feb; 28 Feb +1 with anchor 31 → 31 Mar). Mirror of lib/domain/invoice.ts anchoredAddMonths.';

revoke execute on function public.retainer_anchored_date(date, int, int) from public, anon;
grant execute on function public.retainer_anchored_date(date, int, int) to authenticated, service_role;

-- Whoever sets next_billing_date sets the anchor with it (a person in Client 360 → Services, the
-- onboarding wizard, an import); the billing run advances the date without touching it. The run
-- marks itself with a transaction-local setting, which no API caller can set (set_config isn't
-- exposed), and clears it before it returns.
create or replace function public.client_services_billing_anchor()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if new.next_billing_date is null then
    if tg_op = 'UPDATE' then
      new.billing_anchor_day := old.billing_anchor_day;
    else
      new.billing_anchor_day := null;
    end if;
    return new;
  end if;
  if coalesce(current_setting('app.retainer_run', true), '') = 'on' then
    if tg_op = 'UPDATE' then
      new.billing_anchor_day := coalesce(old.billing_anchor_day, extract(day from old.next_billing_date)::smallint);
    end if;
    new.billing_anchor_day := coalesce(new.billing_anchor_day, extract(day from new.next_billing_date)::smallint);
  elsif tg_op = 'INSERT' or new.next_billing_date is distinct from old.next_billing_date or old.billing_anchor_day is null then
    new.billing_anchor_day := extract(day from new.next_billing_date)::smallint;
  else
    new.billing_anchor_day := old.billing_anchor_day;
  end if;
  return new;
end;
$$;

comment on function public.client_services_billing_anchor() is
  'billing_anchor_day follows next_billing_date when anyone but the retainer billing run sets it; the run keeps it (0220).';

revoke execute on function public.client_services_billing_anchor() from public, anon, authenticated;

drop trigger if exists client_services_billing_anchor on public.client_services;
create trigger client_services_billing_anchor
  before insert or update on public.client_services
  for each row execute function public.client_services_billing_anchor();

-- Existing engagements.
update public.client_services s
   set billing_anchor_day = case
     when f.first_day between 29 and 31 and extract(day from s.next_billing_date) >= 28
       and extract(day from s.next_billing_date) < f.first_day then f.first_day
     else extract(day from s.next_billing_date)::smallint
   end
  from (
    select s2.id,
           (select extract(day from d.billing_date)::smallint
              from public.retainer_drafts d
             where d.client_service_id = s2.id
             order by d.billing_date, d.created_at
             limit 1) as first_day
      from public.client_services s2
  ) f
 where f.id = s.id and s.next_billing_date is not null and s.billing_anchor_day is null;

create or replace function public.generate_retainer_drafts(p_today date default null, p_max int default 3)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_today date := coalesce(p_today, public.today_ist());
  v_max int := greatest(1, least(coalesce(p_max, 3), 12));
  v_fs public.firm_settings%rowtype;
  v_run public.retainer_runs%rowtype;
  v_rate numeric;
  v_firm_state text;
  v_first_partner uuid;
  r record;
  v_cycle public.service_frequency;
  v_step int;
  v_k int;
  v_bill date;
  v_next date;
  v_label text;
  v_creator uuid;
  v_pos text;
  v_intra boolean;
  v_sac text;
  v_amount numeric;
  v_tax numeric;
  v_half numeric;
  v_cgst numeric;
  v_sgst numeric;
  v_igst numeric;
  v_gross numeric;
  v_total numeric;
  v_round numeric;
  v_invoice_id uuid;
  v_billed_any boolean;
  v_left int;
  v_checked int := 0;
  v_created int := 0;
  v_engagements int := 0;
  v_already int := 0;
  v_capped_count int := 0;
  v_failed int := 0;
  v_skip jsonb := jsonb_build_object(
    'not_enabled', 0, 'service_inactive', 0, 'client_inactive_or_on_hold', 0,
    'no_agreed_fee', 0, 'one_time_service', 0, 'not_yet_due', 0
  );
  v_reason text;
  v_capped jsonb := '[]'::jsonb;
  v_errors jsonb := '[]'::jsonb;
  v_drafts_total numeric := 0;
  v_counts jsonb;
begin
  if not (auth.jwt() is null or coalesce(auth.jwt() ->> 'role', '') = 'service_role') then
    raise exception 'USER: Retainer drafts are created by the daily billing run.' using errcode = 'P0001';
  end if;

  select * into v_fs from public.firm_settings where id = 1;
  v_rate := coalesce(public.jsonb_to_numeric(public.statutory_param_value('gst.default_rate_services', v_today)), v_fs.default_tax_rate, 18);
  v_firm_state := coalesce(v_fs.state_code::text, '29');
  select p.id into v_first_partner
  from public.profiles p
  where p.role = 'partner' and p.is_active
  order by p.created_at, p.id
  limit 1;

  insert into public.retainer_runs (run_date) values (v_today) returning * into v_run;
  -- client_services_billing_anchor keeps each engagement's anchor day while this run moves its date.
  perform set_config('app.retainer_run', 'on', true);

  for r in
    select
      s.id, s.client_id, s.service_type, s.custom_name, s.frequency, s.billing_frequency, s.is_active,
      s.agreed_fee, s.auto_invoice, s.next_billing_date, s.billing_anchor_day, s.sac_code,
      c.display_name, c.status as client_status, c.gstin, c.state_code, c.owner_employee_id
    from public.client_services s
    join public.clients c on c.id = s.client_id
    where c.deleted_at is null
    order by s.next_billing_date nulls last, s.id
    for update of s skip locked
  loop
    v_checked := v_checked + 1;
    v_reason := case
      when not r.auto_invoice then 'not_enabled'
      when not r.is_active then 'service_inactive'
      when r.client_status in ('inactive', 'on_hold') then 'client_inactive_or_on_hold'
      when r.agreed_fee is null or r.agreed_fee <= 0 then 'no_agreed_fee'
      when r.frequency = 'one_time' or coalesce(r.billing_frequency, r.frequency) = 'one_time' then 'one_time_service'
      when r.next_billing_date is null or r.next_billing_date > v_today then 'not_yet_due'
    end;
    if v_reason is not null then
      v_skip := jsonb_set(v_skip, array[v_reason], to_jsonb((v_skip ->> v_reason)::int + 1));
      continue;
    end if;

    begin
      v_cycle := coalesce(r.billing_frequency, r.frequency);
      v_step := case v_cycle when 'monthly' then 1 when 'quarterly' then 3 else 12 end;

      -- Who the draft is raised by: the owner (Partner/Manager), the engagement partner, the first Partner.
      v_creator := null;
      select p.id into v_creator
      from public.employees e
      join public.profiles p on p.id = e.profile_id
      where e.id = r.owner_employee_id and p.is_active and p.role in ('partner', 'manager');
      if v_creator is null then
        select p.id into v_creator
        from public.client_team_members t
        join public.employees e on e.id = t.employee_id
        join public.profiles p on p.id = e.profile_id
        where t.client_id = r.client_id and t.team_role = 'engagement_partner' and p.is_active and p.role = 'partner'
        order by t.created_at
        limit 1;
      end if;
      v_creator := coalesce(v_creator, v_first_partner);
      if v_creator is null then
        raise exception 'No active Partner to raise the draft in the name of.';
      end if;

      -- Place of supply (§6.4), as save_invoice_draft derives it.
      v_pos := coalesce(
        case when r.gstin is not null and left(r.gstin::text, 2) ~ '^[0-9]{2}$' then left(r.gstin::text, 2) end,
        r.state_code::text,
        v_firm_state
      );
      v_intra := v_pos = v_firm_state;
      v_sac := coalesce(
        nullif(btrim(r.sac_code), ''),
        nullif(v_fs.sac_by_service ->> r.service_type::text, ''),
        v_fs.default_sac,
        '9982'
      );

      -- Totals (§6.3, §6.4): one line at the agreed fee.
      v_amount := round(r.agreed_fee, 2);
      v_tax := round(v_amount * v_rate / 100, 2);
      v_cgst := 0; v_sgst := 0; v_igst := 0;
      if v_intra then
        v_half := round(v_tax / 2, 2);
        v_cgst := v_half;
        v_sgst := v_tax - v_half;
      else
        v_igst := v_tax;
      end if;
      v_gross := v_amount + v_cgst + v_sgst + v_igst;
      if coalesce(v_fs.round_off_enabled, false) then
        v_total := round(v_gross, 0);
        v_round := v_total - v_gross;
      else
        v_total := v_gross;
        v_round := 0;
      end if;

      v_k := 0;
      v_billed_any := false;
      while v_k < v_max loop
        v_bill := public.retainer_anchored_date(r.next_billing_date, v_k * v_step, r.billing_anchor_day);
        exit when v_bill > v_today;
        v_label := public.retainer_period_label(v_bill, v_cycle);

        perform 1 from public.invoice_period_conflicts(null, array[r.id], v_label);
        if found then
          v_already := v_already + 1;
        else
          insert into public.invoices (
            client_id, issue_date, due_date, status, place_of_supply_code,
            taxable_amount, cgst_amount, sgst_amount, igst_amount, reimbursement_amount, round_off, total_amount,
            service_type, billing_period_label, terms, client_service_id, created_by, requires_approval
          ) values (
            r.client_id, v_today, v_today + coalesce(v_fs.payment_terms_days, 15), 'draft', v_pos,
            v_amount, v_cgst, v_sgst, v_igst, 0, v_round, v_total,
            r.service_type, v_label, v_fs.invoice_terms, r.id, v_creator,
            v_fs.invoice_approval_limit is not null and v_total > v_fs.invoice_approval_limit
          )
          returning id into v_invoice_id;

          insert into public.invoice_items (
            invoice_id, description, service_type, sac_code, quantity, rate, amount, tax_rate, is_reimbursement, client_service_id, sort_order
          ) values (
            v_invoice_id, public.retainer_service_label(r.service_type, r.custom_name) || ' for ' || v_label,
            r.service_type, v_sac, 1, v_amount, v_amount, v_rate, false, r.id, 1
          );

          insert into public.retainer_drafts (run_id, invoice_id, client_service_id, billing_date, period_label)
          values (v_run.id, v_invoice_id, r.id, v_bill, v_label);

          insert into public.client_timeline_events (client_id, event_type, title, metadata)
          values (r.client_id, 'invoice_drafted',
                  format('Retainer draft invoice for %s: %s', v_label, public.format_inr(v_total)),
                  jsonb_build_object('invoice_id', v_invoice_id, 'client_service_id', r.id, 'source', 'retainer_billing'));

          v_created := v_created + 1;
          v_drafts_total := v_drafts_total + v_total;
          v_billed_any := true;
        end if;
        v_k := v_k + 1;
      end loop;

      v_next := public.retainer_anchored_date(r.next_billing_date, v_k * v_step, r.billing_anchor_day);
      update public.client_services
         set next_billing_date = v_next,
             last_auto_invoiced_at = case when v_billed_any then now() else last_auto_invoiced_at end
       where id = r.id;
      if v_billed_any then
        v_engagements := v_engagements + 1;
      end if;

      if v_next <= v_today then
        -- The cap stopped the catch-up: count what is still due (bounded), and report it.
        v_left := 0;
        while v_left < 120 and public.retainer_anchored_date(v_next, v_left * v_step, r.billing_anchor_day) <= v_today loop
          v_left := v_left + 1;
        end loop;
        v_capped_count := v_capped_count + 1;
        v_capped := v_capped || jsonb_build_object(
          'client_service_id', r.id,
          'client_id', r.client_id,
          'client_name', r.display_name,
          'service', public.retainer_service_label(r.service_type, r.custom_name),
          'next_billing_date', v_next,
          'periods_left', v_left
        );
      end if;
    exception when others then
      v_failed := v_failed + 1;
      v_errors := v_errors || jsonb_build_object(
        'client_service_id', r.id,
        'client_id', r.client_id,
        'client_name', r.display_name,
        'error', left(regexp_replace(sqlerrm, '^USER: ', ''), 300)
      );
    end;
  end loop;

  v_counts := jsonb_build_object(
    'engagements_checked', v_checked,
    'drafts_created', v_created,
    'engagements_billed', v_engagements,
    'already_billed', v_already,
    'capped', v_capped_count,
    'failed', v_failed,
    'skipped_not_enabled', (v_skip ->> 'not_enabled')::int,
    'skipped_service_inactive', (v_skip ->> 'service_inactive')::int,
    'skipped_client_inactive_or_on_hold', (v_skip ->> 'client_inactive_or_on_hold')::int,
    'skipped_no_agreed_fee', (v_skip ->> 'no_agreed_fee')::int,
    'skipped_one_time_service', (v_skip ->> 'one_time_service')::int,
    'skipped_not_yet_due', (v_skip ->> 'not_yet_due')::int
  );

  perform set_config('app.retainer_run', '', true);

  update public.retainer_runs
     set finished_at = now(), counts = v_counts, capped = v_capped, errors = v_errors,
         drafts_created = v_created, drafts_total = v_drafts_total
   where id = v_run.id;

  return jsonb_build_object(
    'run_id', v_run.id,
    'run_date', v_today,
    'counts', v_counts,
    'capped', v_capped,
    'errors', v_errors,
    'drafts_created', v_created,
    'drafts_total', v_drafts_total::text
  );
end;
$$;

comment on function public.generate_retainer_drafts(date, int) is
  'The retainer billing job (service role): Draft invoices for due auto-invoiced engagements, at most 3 periods each per run, next_billing_date advanced one cycle per period on the engagement''s anchor day (0220), skips counted by the §7.9.6 reasons (§8 09:30).';

revoke execute on function public.generate_retainer_drafts(date, int) from public, anon, authenticated;
grant execute on function public.generate_retainer_drafts(date, int) to service_role;
