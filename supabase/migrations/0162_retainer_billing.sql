-- 0162 · Retainer (auto) billing, the database half of the 09:30 job (§7.9.6, §8).
--
--   generate_retainer_drafts(today, max_per_run)
--       Every engagement (client_services of clients not in the recycle bin) is either skipped,
--       with the first §7.9.6 reason that applies, counted exactly as listed:
--         not enabled · service inactive · client inactive or on hold · no agreed fee ·
--         one-time service · not yet due
--       or billed: one DRAFT invoice per billing date from next_billing_date up to today, at most
--       `max_per_run` (3) per engagement per run, oldest first; next_billing_date advances one
--       cycle per period, counted from the original date so a 31st stays on month ends
--       (mirror of lib/domain/invoice.ts planRetainerBilling). An engagement still behind after
--       the cap is reported in the run's `capped` list. A period that is already invoiced for the
--       engagement (a draft or an issued invoice, at invoice or line level) is not billed again;
--       next_billing_date still moves past it.
--       Drafts are never sent: they wait in the Retainer drafts queue for a person to issue.
--       Each draft: dated today, due after the firm's payment terms, one line "<service> for
--       <period>" at the agreed fee (excl. GST) with the engagement's SAC (else the firm's SAC map,
--       else the default SAC) and the GST rate in force (gst.default_rate_services), split CGST +
--       SGST or IGST by the place of supply exactly as save_invoice_draft does (0151), round-off
--       per Settings. Over the invoice approval limit (incl. GST), the draft is held for a Partner
--       (requires_approval, frozen at creation, §7.9.2): a Partner issues it; a Manager sends it
--       for approval first. It is raised in the name of the client's owner when a Partner or
--       Manager, else its engagement partner, else the first Partner.
--       One engagement that fails is rolled back on its own, recorded in the run's errors, and
--       the run carries on (§8). Idempotent: a second run the same day finds nothing due.
--       Service role only (the job).

set search_path = public, extensions;

create or replace function public.retainer_period_label(p_date date, p_cycle public.service_frequency)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case p_cycle
    when 'monthly' then to_char(p_date, 'Mon YYYY')
    when 'quarterly' then 'Q' || ((((extract(month from p_date)::int - 4 + 12) % 12) / 3) + 1)::text || ' ' || public.financial_year_label(p_date)
    when 'annual' then 'FY ' || public.financial_year_label(p_date)
  end
$$;

comment on function public.retainer_period_label(date, public.service_frequency) is
  'Sep 2026 · Q2 2026-27 · FY 2026-27: the billing period containing a date (mirror of lib/domain/invoice.ts retainerPeriodLabel).';

create or replace function public.retainer_service_label(p_type public.service_type, p_custom text)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case p_type
    when 'gst' then 'GST returns'
    when 'income_tax' then 'Income tax'
    when 'tds' then 'TDS/TCS'
    when 'payroll' then 'Payroll (PF/ESIC/PT)'
    when 'bookkeeping' then 'Bookkeeping'
    when 'audit' then 'Audit'
    when 'company_law' then 'ROC/Company law'
    when 'incorporation' then 'Incorporation'
    else coalesce(nullif(btrim(p_custom), ''), 'Professional services')
  end
$$;

comment on function public.retainer_service_label(public.service_type, text) is
  'The service''s name on an invoice line (mirror of lib/domain/enums.ts SERVICE_TYPE_LABELS; "other" uses the custom name).';

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

  for r in
    select
      s.id, s.client_id, s.service_type, s.custom_name, s.frequency, s.billing_frequency, s.is_active,
      s.agreed_fee, s.auto_invoice, s.next_billing_date, s.sac_code,
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
        v_bill := (r.next_billing_date + make_interval(months => v_k * v_step))::date;
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

      v_next := (r.next_billing_date + make_interval(months => v_k * v_step))::date;
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
        while v_left < 120 and (v_next + make_interval(months => v_left * v_step))::date <= v_today loop
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
  'The retainer billing job (service role): Draft invoices for due auto-invoiced engagements, at most 3 periods each per run, next_billing_date advanced one cycle per period, skips counted by the §7.9.6 reasons (§8 09:30).';

revoke execute on function public.generate_retainer_drafts(date, int) from public, anon, authenticated;
grant execute on function public.generate_retainer_drafts(date, int) to service_role;
revoke execute on function public.retainer_period_label(date, public.service_frequency), public.retainer_service_label(public.service_type, text) from public, anon;
grant execute on function public.retainer_period_label(date, public.service_frequency), public.retainer_service_label(public.service_type, text) to authenticated, service_role;
