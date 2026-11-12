-- 0245 · The last day to appeal to the Income Tax Appellate Tribunal (§7.8.4). Found by the
-- end-to-end break-it run: the app counted 60 days from the order. Since 1 October 2024 (Finance
-- (No. 2) Act, 2024, amending s.253(3)) the appeal lies within two months from the end of the month
-- in which the order is communicated. For an order of 31 December 2025 the screen showed 1 March
-- 2026; the last day is 28 February 2026, so the app's date was a day too late.
--
-- 1. notice_appeal_limitation reads a third period shape, {"months": n, "from": "month_end"}: the
--    last day of the month n months after the month of the order. {"days": n} and {"months": n} are
--    unchanged. Mirror: limitationDate in lib/domain/escalation.ts.
-- 2. The parameter appeal.income_tax.tribunal: the 60-day row ends on 30 September 2024 and a new row
--    starts on 1 October 2024, awaiting partner confirmation like the other appeal periods. A row a
--    Partner has already changed or confirmed is left alone.
--
-- Also records the schema version (§0.1 rule 1): lib/env.ts EXPECTED_SCHEMA_VERSION matches it.

set search_path = public, extensions;

create or replace function public.notice_appeal_limitation(p_forum text, p_order_date date)
returns date
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  v_key text;
  v_value jsonb;
  v_n int;
begin
  if p_order_date is null then
    return null;
  end if;
  v_key := case p_forum
    when 'income_tax_first_appeal' then 'appeal.income_tax.first_appeal'
    when 'income_tax_tribunal' then 'appeal.income_tax.tribunal'
    when 'gst_first_appeal' then 'appeal.gst.first_appeal'
    when 'gst_tribunal' then 'appeal.gst.tribunal'
    else null
  end;
  if v_key is null then
    return null;
  end if;
  v_value := public.statutory_param_value(v_key, p_order_date);
  if v_value is null or jsonb_typeof(v_value) <> 'object' then
    return null;
  end if;
  if jsonb_typeof(v_value->'days') = 'number' then
    v_n := (v_value->>'days')::numeric::int;
    if v_n > 0 and (v_value->>'days')::numeric = v_n then
      return p_order_date + v_n;
    end if;
  elsif jsonb_typeof(v_value->'months') = 'number' then
    v_n := (v_value->>'months')::numeric::int;
    if v_n > 0 and (v_value->>'months')::numeric = v_n then
      if v_value->>'from' = 'month_end' then
        -- From the end of the order's month: the last day of the month n months later.
        return (date_trunc('month', p_order_date::timestamp) + make_interval(months => v_n + 1) - interval '1 day')::date;
      end if;
      return (p_order_date + make_interval(months => v_n))::date;
    end if;
  end if;
  return null;
end;
$$;

comment on function public.notice_appeal_limitation(text, date) is
  'The last day to appeal an order to a forum: the order date plus the period in the appeal.* statutory parameter in force on that date (days; calendar months clamped to month end; or months from the end of the order''s month) (§7.8.4). Mirror: limitationDate in lib/domain/escalation.ts.';

-- The parameter. Only the row as seeded is touched.
update public.statutory_parameters
   set effective_to = date '2024-09-30',
       section_ref = 's.253(3), before the Finance (No. 2) Act, 2024',
       notes = 'Appeal to the Income Tax Appellate Tribunal, orders up to 30 September 2024: 60 days from the date the order is communicated. [verify] against the statute as it then stood before relying on it (§7.8.4).'
 where key = 'appeal.income_tax.tribunal'
   and effective_from = date '1962-04-01'
   and effective_to is null
   and value = '{"days":60}'::jsonb
   and verified = false;

insert into public.statutory_parameters (key, value, effective_from, effective_to, statute, section_ref, source_ref, notes, verified)
select 'appeal.income_tax.tribunal', '{"months":2,"from":"month_end"}'::jsonb, date '2024-10-01', null,
       'Income-tax Act, 1961', 's.253(3) [verify] the Income-tax Act, 2025 equivalent',
       'Income-tax Act, 1961, s.253(3) as amended by the Finance (No. 2) Act, 2024, from 1 October 2024',
       'Appeal to the Income Tax Appellate Tribunal: two months from the end of the month in which the order is communicated. [verify] against the current statute before relying on it (§7.8.4).',
       false
 where exists (select 1 from public.statutory_parameters where key = 'appeal.income_tax.tribunal' and effective_to = date '2024-09-30')
on conflict (key, effective_from) do nothing;

update public.app_meta set value = '0245' where key = 'schema_version';
