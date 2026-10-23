-- 0163 · The payments dashboard and the revenue ledger, summed in SQL (§7.9.5, §7.9.10, §2.3).
--
--   payments_dashboard(today)   Partner only (§4.1 "Payments dashboard"). One call returns:
--       receivables          every issued invoice with a balance (Sent, Partially paid, Disputed;
--                            not cancelled or deleted): outstanding, of which overdue (derived:
--                            Sent / Partially paid past the due date, §5.7; a draft is never
--                            overdue) and disputed
--       ageing               0–30 / 31–60 / 61–90 / 90+ days since the invoice date (as the Partner
--                            dashboard ages them, lib/domain/dashboard.ts)
--       collection           the FY so far: receivables open at the FY's start, billed, credited
--                            and written off since, and collected (received + TDS); the app works
--                            out the collection rate from these in paise
--       dso                  outstanding and the last 90 days' billing (days sales outstanding)
--       top_debtors          the 10 clients owing most, with their overdue part and oldest invoice
--       promises             payment promises falling due this month (collection_forecast, 0161):
--                            promised, received against them since, kept, missed, and the list
--       monthly              collections by month of the FY (received + TDS, by payment date)
--       unbilled             unbilled time at each person's billing rate (unbilled_time_by_client)
--       handoffs             payment reminders waiting for someone to send by WhatsApp or Gmail
--     Amounts are returned as decimal strings so nothing is lost before the app converts them to
--     paise (lib/domain/money.ts).
--   revenue_ledger(params)      Partner / Manager: a page of the invoice, receipt or credit-note
--       ledger for a date range (§7.9.10): invoice-level with the GST split, every receipt (reversed
--       ones flagged), every credit note; searched, sorted and paged in SQL, with the totals of the
--       whole filtered set. Cancelled invoices and reversed receipts are listed but left out of the
--       totals; a waiver is a write-off column, not a reversal of revenue (§7.9.3).
--
-- Both SECURITY INVOKER: RLS applies to the caller (money: Partners and Managers only).

set search_path = public, extensions;

create or replace function public.payments_dashboard(p_today date default null)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  v_today date := coalesce(p_today, public.today_ist());
  v_fy text := public.financial_year_label(v_today);
  v_fy_start date := public.fy_start_date(v_fy);
  v_month_start date := date_trunc('month', v_today)::date;
  v_month_end date := (date_trunc('month', v_today) + interval '1 month' - interval '1 day')::date;
  v_result jsonb;
begin
  if not public.is_partner() then
    raise exception 'USER: The payments dashboard is for Partners.' using errcode = 'P0001';
  end if;

  with recv as (
    select
      i.id, i.client_id, i.invoice_number, i.issue_date, i.due_date, i.status, i.outstanding_amount,
      (i.status in ('sent', 'partially_paid') and i.due_date < v_today) as is_overdue,
      greatest(v_today - i.issue_date, 0) as age_days
    from public.invoices i
    where i.deleted_at is null
      and i.cancelled_at is null
      and i.status in ('sent', 'partially_paid', 'disputed')
      and i.outstanding_amount > 0
  ),
  issued as (
    select i.*
    from public.invoices i
    where i.deleted_at is null
      and i.invoice_number is not null
      and i.status not in ('draft', 'awaiting_approval')
  ),
  live_receipts as (
    select r.invoice_id, r.payment_date, r.amount_received, r.tds_amount, r.created_at
    from public.payment_receipts r
    where r.reversed_at is null
  ),
  opening as (
    select coalesce(sum(greatest(
      i.total_amount
        - coalesce((select sum(r.amount_received + r.tds_amount) from live_receipts r where r.invoice_id = i.id and r.payment_date < v_fy_start), 0)
        - coalesce((select sum(n.total_amount) from public.credit_notes n where n.invoice_id = i.id and n.issue_date < v_fy_start), 0)
        - case when i.waived_at is not null and (i.waived_at at time zone 'Asia/Kolkata')::date < v_fy_start then coalesce(i.waived_amount, 0) else 0 end,
      0)), 0) as amount
    from issued i
    where i.issue_date < v_fy_start
      and i.cancelled_at is null
  ),
  promises as (
    select f.*
    from public.collection_forecast f
    where f.promised_payment_date between v_month_start and v_month_end
  ),
  months as (
    select (v_fy_start + make_interval(months => g))::date as month_start
    from generate_series(0, 11) g
  ),
  debtors as (
    select
      r.client_id,
      sum(r.outstanding_amount) as outstanding,
      sum(r.outstanding_amount) filter (where r.is_overdue) as overdue,
      count(*) as invoices,
      min(r.issue_date) as oldest_issue_date,
      max(case when r.is_overdue then v_today - r.due_date else 0 end) as max_days_overdue
    from recv r
    group by r.client_id
    order by sum(r.outstanding_amount) desc, r.client_id
    limit 10
  )
  select jsonb_build_object(
    'today', v_today,
    'financial_year', v_fy,
    'receivables', (
      select jsonb_build_object(
        'outstanding', coalesce(sum(outstanding_amount), 0)::text,
        'count', count(*),
        'overdue', coalesce(sum(outstanding_amount) filter (where is_overdue), 0)::text,
        'overdue_count', count(*) filter (where is_overdue),
        'disputed', coalesce(sum(outstanding_amount) filter (where status = 'disputed'), 0)::text,
        'disputed_count', count(*) filter (where status = 'disputed'),
        'clients', count(distinct client_id)
      )
      from recv
    ),
    'ageing', (
      select jsonb_agg(jsonb_build_object('bucket', b.bucket, 'count', coalesce(a.n, 0), 'amount', coalesce(a.amount, 0)::text) order by b.ord)
      from (values (1, '0_30'), (2, '31_60'), (3, '61_90'), (4, '90_plus')) as b(ord, bucket)
      left join (
        select
          case when age_days <= 30 then '0_30' when age_days <= 60 then '31_60' when age_days <= 90 then '61_90' else '90_plus' end as bucket,
          count(*) as n,
          sum(outstanding_amount) as amount
        from recv
        group by 1
      ) a on a.bucket = b.bucket
    ),
    'collection', jsonb_build_object(
      'opening', (select amount from opening)::text,
      'billed', (select coalesce(sum(total_amount), 0) from issued where issue_date between v_fy_start and v_today and cancelled_at is null)::text,
      'credited', (
        select coalesce(sum(n.total_amount), 0)
        from public.credit_notes n
        join issued i on i.id = n.invoice_id
        where n.issue_date between v_fy_start and v_today
      )::text,
      'written_off', (
        select coalesce(sum(i.waived_amount), 0)
        from issued i
        where i.waived_at is not null and (i.waived_at at time zone 'Asia/Kolkata')::date between v_fy_start and v_today
      )::text,
      'collected', (
        select coalesce(sum(r.amount_received + r.tds_amount), 0)
        from live_receipts r
        join issued i on i.id = r.invoice_id
        where r.payment_date between v_fy_start and v_today
      )::text,
      'collected_month', (
        select coalesce(sum(r.amount_received + r.tds_amount), 0)
        from live_receipts r
        join issued i on i.id = r.invoice_id
        where r.payment_date between v_month_start and v_today
      )::text,
      'tds_month', (
        select coalesce(sum(r.tds_amount), 0)
        from live_receipts r
        join issued i on i.id = r.invoice_id
        where r.payment_date between v_month_start and v_today
      )::text
    ),
    'dso', jsonb_build_object(
      'outstanding', (select coalesce(sum(outstanding_amount), 0) from recv)::text,
      'billed_90', (select coalesce(sum(total_amount), 0) from issued where issue_date > v_today - 90 and issue_date <= v_today and cancelled_at is null)::text,
      'days', 90
    ),
    'top_debtors', coalesce((
      select jsonb_agg(jsonb_build_object(
        'client_id', d.client_id,
        'client_name', c.display_name,
        'client_code', c.client_code::text,
        'outstanding', d.outstanding::text,
        'overdue', coalesce(d.overdue, 0)::text,
        'invoices', d.invoices,
        'oldest_issue_date', d.oldest_issue_date,
        'max_days_overdue', d.max_days_overdue
      ) order by d.outstanding desc, c.display_name)
      from debtors d
      join public.clients c on c.id = d.client_id
    ), '[]'::jsonb),
    'promises', jsonb_build_object(
      'month_start', v_month_start,
      'month_end', v_month_end,
      'promised', (select coalesce(sum(promised_amount), 0) from promises)::text,
      'count', (select count(*) from promises),
      'received', (
        select coalesce(sum(r.amount_received + r.tds_amount), 0)
        from promises p
        join live_receipts r on r.invoice_id = p.invoice_id and r.created_at >= p.promised_at
        where r.payment_date between v_month_start and v_month_end
      )::text,
      'kept', (select count(*) from promises where promise_status = 'kept'),
      'missed', (select count(*) from promises where promise_status = 'missed'),
      'open', (select count(*) from promises where promise_status = 'open'),
      'rows', coalesce((
        select jsonb_agg(jsonb_build_object(
          'invoice_id', p.invoice_id,
          'invoice_number', p.invoice_number,
          'client_id', p.client_id,
          'client_name', p.client_name,
          'promised_payment_date', p.promised_payment_date,
          'promised_amount', p.promised_amount::text,
          'outstanding', p.outstanding_amount::text,
          'status', p.promise_status
        ) order by p.promised_payment_date, p.client_name)
        from (select * from promises order by promised_payment_date, client_name limit 12) p
      ), '[]'::jsonb)
    ),
    'monthly', (
      select jsonb_agg(jsonb_build_object(
        'month', to_char(m.month_start, 'YYYY-MM'),
        'collected', coalesce((
          select sum(r.amount_received + r.tds_amount)
          from live_receipts r
          join issued i on i.id = r.invoice_id
          where r.payment_date >= m.month_start
            and r.payment_date < (m.month_start + interval '1 month')::date
            and r.payment_date <= v_today
        ), 0)::text
      ) order by m.month_start)
      from months m
    ),
    'unbilled', (
      select jsonb_build_object('amount', coalesce(sum(u.amount), 0)::text, 'minutes', coalesce(sum(u.minutes), 0), 'clients', count(*))
      from public.unbilled_time_by_client u
    ),
    'handoffs', jsonb_build_object(
      'count', (select count(*) from public.invoice_reminders ir join issued i on i.id = ir.invoice_id where ir.status = 'handoff_pending'),
      'rows', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', h.id,
          'invoice_id', h.invoice_id,
          'invoice_number', h.invoice_number,
          'client_name', h.client_name,
          'reminder_key', h.reminder_key,
          'channel', h.channel,
          'owner_name', h.owner_name,
          'outstanding', h.outstanding_amount::text,
          'created_at', h.created_at
        ) order by h.created_at desc)
        from (
          select ir.id, ir.invoice_id, i.invoice_number, c.display_name as client_name, ir.reminder_key, ir.channel::text as channel,
                 p.full_name as owner_name, i.outstanding_amount, ir.created_at
          from public.invoice_reminders ir
          join issued i on i.id = ir.invoice_id
          join public.clients c on c.id = i.client_id
          left join public.profiles p on p.id = ir.owner_user_id
          where ir.status = 'handoff_pending'
          order by ir.created_at desc
          limit 8
        ) h
      ), '[]'::jsonb)
    )
  )
  into v_result;

  return v_result;
end;
$$;

comment on function public.payments_dashboard(date) is
  'Partner only: receivables, ageing, collection rate and DSO inputs, top debtors, promised vs received this month, monthly collections, unbilled time and waiting reminder hand-offs (§7.9.5).';

-- =============================================================================================
-- revenue_ledger
-- =============================================================================================
create or replace function public.revenue_ledger(p_params jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  v_kind text := coalesce(nullif(p_params ->> 'kind', ''), 'invoices');
  v_q text := nullif(btrim(coalesce(p_params ->> 'q', '')), '');
  v_pattern text;
  v_client uuid := public.try_uuid(p_params ->> 'client_id');
  v_from date := nullif(p_params ->> 'from', '')::date;
  v_to date := nullif(p_params ->> 'to', '')::date;
  v_sort text := coalesce(nullif(p_params ->> 'sort', ''), 'date');
  v_dir text := case when lower(coalesce(p_params ->> 'dir', 'desc')) = 'asc' then 'asc' else 'desc' end;
  v_offset int := greatest(coalesce(nullif(p_params ->> 'offset', '')::int, 0), 0);
  v_limit int := least(greatest(coalesce(nullif(p_params ->> 'limit', '')::int, 25), 1), 20000);
  v_order text;
  v_result jsonb;
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: The revenue ledger is for Partners and Managers.' using errcode = 'P0001';
  end if;
  if v_kind not in ('invoices', 'receipts', 'credit_notes') then
    raise exception 'USER: Choose invoices, receipts or credit notes.' using errcode = 'P0001';
  end if;
  if v_from is null or v_to is null or v_to < v_from then
    raise exception 'USER: Choose a period: a from date on or before the to date.' using errcode = 'P0001';
  end if;
  if v_q is not null then
    v_pattern := '%' || replace(replace(replace(left(v_q, 100), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  if v_kind = 'invoices' then
    v_order := case v_sort
      when 'number' then 'b.invoice_number'
      when 'client' then 'lower(b.client_name)'
      when 'taxable_amount' then 'b.taxable_amount'
      when 'gst_amount' then 'b.gst_amount'
      when 'total_amount' then 'b.total_amount'
      when 'received' then 'b.amount_received'
      when 'outstanding_amount' then 'b.outstanding_amount'
      else 'b.issue_date'
    end;
    execute format($sql$
      with base as (
        select
          i.id, i.invoice_number, i.invoice_kind, i.issue_date, i.due_date, i.status::text as status, i.client_id,
          coalesce(i.client_name_snapshot, c.display_name) as client_name, c.client_code::text as client_code,
          i.client_gstin_snapshot::text as client_gstin, i.place_of_supply_code,
          i.taxable_amount, i.cgst_amount, i.sgst_amount, i.igst_amount,
          (i.cgst_amount + i.sgst_amount + i.igst_amount) as gst_amount,
          i.reimbursement_amount, i.round_off, i.total_amount,
          i.amount_received, i.tds_credited, i.credit_noted, coalesce(i.waived_amount, 0) as written_off,
          case when i.status = 'waived' or i.cancelled_at is not null then 0 else i.outstanding_amount end as outstanding_amount,
          i.cancelled_at, i.billing_period_label, i.created_at,
          case
            when i.cancelled_at is not null then 'cancelled'
            when i.status in ('sent', 'partially_paid') and i.outstanding_amount > 0 and i.due_date < public.today_ist() then 'overdue'
            else i.status::text
          end as display_status
        from public.invoices i
        join public.clients c on c.id = i.client_id
        where i.deleted_at is null
          and i.invoice_number is not null
          and i.status not in ('draft', 'awaiting_approval')
          and i.issue_date between $1 and $2
          and ($3::uuid is null or i.client_id = $3)
          and ($4::text is null
               or i.invoice_number ilike $4
               or c.display_name ilike $4
               or coalesce(i.client_name_snapshot, '') ilike $4
               or c.client_code::text ilike $4
               or coalesce(i.client_gstin_snapshot::text, '') ilike $4)
      ),
      ranked as (select b.*, row_number() over (order by %1$s %2$s nulls last, b.created_at desc, b.id) as rn from base b),
      page as (select r.* from ranked r order by r.rn offset $5 limit $6)
      select jsonb_build_object(
        'total', (select count(*) from base),
        'totals', (
          select jsonb_build_object(
            'count', count(*) filter (where cancelled_at is null),
            'cancelled', count(*) filter (where cancelled_at is not null),
            'taxable', coalesce(sum(taxable_amount) filter (where cancelled_at is null), 0)::text,
            'cgst', coalesce(sum(cgst_amount) filter (where cancelled_at is null), 0)::text,
            'sgst', coalesce(sum(sgst_amount) filter (where cancelled_at is null), 0)::text,
            'igst', coalesce(sum(igst_amount) filter (where cancelled_at is null), 0)::text,
            'reimbursement', coalesce(sum(reimbursement_amount) filter (where cancelled_at is null), 0)::text,
            'round_off', coalesce(sum(round_off) filter (where cancelled_at is null), 0)::text,
            'total', coalesce(sum(total_amount) filter (where cancelled_at is null), 0)::text,
            'received', coalesce(sum(amount_received) filter (where cancelled_at is null), 0)::text,
            'tds', coalesce(sum(tds_credited) filter (where cancelled_at is null), 0)::text,
            'credited', coalesce(sum(credit_noted) filter (where cancelled_at is null), 0)::text,
            'written_off', coalesce(sum(written_off) filter (where cancelled_at is null), 0)::text,
            'outstanding', coalesce(sum(outstanding_amount) filter (where cancelled_at is null), 0)::text
          )
          from base
        ),
        'rows', coalesce((select jsonb_agg(to_jsonb(p) order by p.rn) from page p), '[]'::jsonb)
      )
    $sql$, v_order, v_dir)
    into v_result
    using v_from, v_to, v_client, v_pattern, v_offset, v_limit;
  elsif v_kind = 'receipts' then
    v_order := case v_sort
      when 'number' then 'b.receipt_number'
      when 'client' then 'lower(b.client_name)'
      when 'amount_received' then 'b.amount_received'
      when 'tds_amount' then 'b.tds_amount'
      else 'b.payment_date'
    end;
    execute format($sql$
      with base as (
        select
          r.id, r.receipt_number, r.payment_date, r.amount_received, r.tds_amount, (r.amount_received + r.tds_amount) as settled,
          r.tds_section, r.method::text as method, r.reference, r.deposited_to, r.reversed_at, r.reversal_reason,
          r.invoice_id, i.invoice_number, i.client_id,
          coalesce(i.client_name_snapshot, c.display_name) as client_name, c.client_code::text as client_code, r.created_at
        from public.payment_receipts r
        join public.invoices i on i.id = r.invoice_id
        join public.clients c on c.id = i.client_id
        where i.deleted_at is null
          and r.payment_date between $1 and $2
          and ($3::uuid is null or i.client_id = $3)
          and ($4::text is null
               or r.receipt_number ilike $4
               or coalesce(i.invoice_number, '') ilike $4
               or c.display_name ilike $4
               or c.client_code::text ilike $4
               or coalesce(r.reference, '') ilike $4)
      ),
      ranked as (select b.*, row_number() over (order by %1$s %2$s nulls last, b.created_at desc, b.id) as rn from base b),
      page as (select r.* from ranked r order by r.rn offset $5 limit $6)
      select jsonb_build_object(
        'total', (select count(*) from base),
        'totals', (
          select jsonb_build_object(
            'count', count(*) filter (where reversed_at is null),
            'reversed', count(*) filter (where reversed_at is not null),
            'received', coalesce(sum(amount_received) filter (where reversed_at is null), 0)::text,
            'tds', coalesce(sum(tds_amount) filter (where reversed_at is null), 0)::text,
            'settled', coalesce(sum(settled) filter (where reversed_at is null), 0)::text
          )
          from base
        ),
        'rows', coalesce((select jsonb_agg(to_jsonb(p) order by p.rn) from page p), '[]'::jsonb)
      )
    $sql$, v_order, v_dir)
    into v_result
    using v_from, v_to, v_client, v_pattern, v_offset, v_limit;
  else
    v_order := case v_sort
      when 'number' then 'b.credit_note_number'
      when 'client' then 'lower(b.client_name)'
      when 'taxable_amount' then 'b.taxable_amount'
      when 'total_amount' then 'b.total_amount'
      else 'b.issue_date'
    end;
    execute format($sql$
      with base as (
        select
          n.id, n.credit_note_number, n.issue_date, n.reason_code::text as reason_code, n.reason, n.reduces_gst,
          n.taxable_amount, coalesce(n.cgst_amount, 0) as cgst_amount, coalesce(n.sgst_amount, 0) as sgst_amount,
          coalesce(n.igst_amount, 0) as igst_amount,
          (coalesce(n.cgst_amount, 0) + coalesce(n.sgst_amount, 0) + coalesce(n.igst_amount, 0)) as gst_amount,
          n.total_amount, n.tax_rate, n.place_of_supply_code,
          n.invoice_id, i.invoice_number, i.issue_date as invoice_date, n.client_id,
          coalesce(i.client_name_snapshot, c.display_name) as client_name, c.client_code::text as client_code,
          i.client_gstin_snapshot::text as client_gstin, n.created_at
        from public.credit_notes n
        join public.invoices i on i.id = n.invoice_id
        join public.clients c on c.id = n.client_id
        where n.issue_date between $1 and $2
          and ($3::uuid is null or n.client_id = $3)
          and ($4::text is null
               or n.credit_note_number ilike $4
               or coalesce(i.invoice_number, '') ilike $4
               or c.display_name ilike $4
               or c.client_code::text ilike $4)
      ),
      ranked as (select b.*, row_number() over (order by %1$s %2$s nulls last, b.created_at desc, b.id) as rn from base b),
      page as (select r.* from ranked r order by r.rn offset $5 limit $6)
      select jsonb_build_object(
        'total', (select count(*) from base),
        'totals', (
          select jsonb_build_object(
            'count', count(*),
            'taxable', coalesce(sum(taxable_amount), 0)::text,
            'cgst', coalesce(sum(cgst_amount), 0)::text,
            'sgst', coalesce(sum(sgst_amount), 0)::text,
            'igst', coalesce(sum(igst_amount), 0)::text,
            'total', coalesce(sum(total_amount), 0)::text
          )
          from base
        ),
        'rows', coalesce((select jsonb_agg(to_jsonb(p) order by p.rn) from page p), '[]'::jsonb)
      )
    $sql$, v_order, v_dir)
    into v_result
    using v_from, v_to, v_client, v_pattern, v_offset, v_limit;
  end if;

  return v_result;
end;
$$;

comment on function public.revenue_ledger(jsonb) is
  'Partner/Manager: a page of the invoice, receipt or credit-note ledger for a period, with the totals of the filtered set (§7.9.10).';

revoke execute on function public.payments_dashboard(date), public.revenue_ledger(jsonb) from public, anon;
grant execute on function public.payments_dashboard(date), public.revenue_ledger(jsonb) to authenticated, service_role;
