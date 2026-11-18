-- 0246 · One document dated in a later financial year no longer blocks the year in progress (§5.11).
-- Found by the end-to-end break-it run: a quotation dated 1 April next year (a typo, or a quote
-- prepared on 31 March) moved the quotation series to the new year, and every quotation dated today
-- was then refused, for everyone, with no screen to undo it. The series row remembered only its
-- latest year.
--
-- number_series_years keeps the counter of each year the series has left. next_document_number
-- stores the year it leaves when it moves forward, and a document dated in such a year carries on
-- from that year's own counter. A year that was never kept is still refused (restarting it would
-- reuse its numbers). The function body is 0031's with only that changed.
--
-- Also records the schema version (§0.1 rule 1): lib/env.ts EXPECTED_SCHEMA_VERSION matches it.

set search_path = public, extensions;

create table if not exists public.number_series_years (
  key text not null references public.number_series (key) on delete cascade,
  financial_year text not null constraint number_series_years_fy_format check (public.is_fy_label(financial_year)),
  next_value int not null check (next_value >= 1),
  updated_at timestamptz not null default now(),
  primary key (key, financial_year)
);
alter table public.number_series_years enable row level security;
-- Written only by next_document_number (security definer); Partners and Managers may read it.
create policy number_series_years_select on public.number_series_years
  for select to authenticated using ((select public.is_manager_or_partner()));
revoke insert, update, delete on public.number_series_years from anon, authenticated;

create or replace function public.next_document_number(p_key text, p_date date default null)
returns text
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_date date := coalesce(p_date, public.today_ist());
  v_fy_scoped boolean;
  v_pad int;
  v_noun text;
  v_prefix text;
  v_row public.number_series%rowtype;
  v_date_fy text;
  v_seq int;
  v_fy text;
  v_digits text;
  v_number text;
  v_max int;
  v_earlier boolean := false;
  fs public.firm_settings%rowtype;
begin
  if not (
    auth.jwt() is null                                  -- direct database session (migrations, seed, jobs over SQL)
    or coalesce(auth.jwt() ->> 'role', '') = 'service_role'
    or public.is_manager_or_partner()
  ) then
    raise exception 'USER: You don''t have permission to take a document number.' using errcode = 'P0001';
  end if;

  case p_key
    when 'invoice' then v_fy_scoped := true; v_pad := 4; v_noun := 'invoice';
    when 'credit_note' then v_fy_scoped := true; v_pad := 4; v_noun := 'credit note';
    when 'quotation' then v_fy_scoped := true; v_pad := 4; v_noun := 'quotation';
    when 'receipt' then v_fy_scoped := true; v_pad := 4; v_noun := 'receipt';
    when 'client_code' then v_fy_scoped := false; v_pad := 4; v_noun := 'client code';
    when 'task' then v_fy_scoped := false; v_pad := 6; v_noun := 'task number';
    when 'lead' then v_fy_scoped := false; v_pad := 4; v_noun := 'lead number';
    else
      raise exception 'USER: There is no number series called "%".', coalesce(p_key, '') using errcode = 'P0001';
  end case;

  select * into fs from public.firm_settings where id = 1;
  v_prefix := btrim(case p_key
    when 'invoice' then coalesce(fs.invoice_prefix, 'TW')
    when 'credit_note' then coalesce(fs.credit_note_prefix, 'TW-CN')
    when 'quotation' then coalesce(fs.quotation_prefix, 'TW-Q')
    when 'receipt' then coalesce(fs.receipt_prefix, 'TW-R')
    when 'client_code' then coalesce(fs.client_code_prefix, 'TW-C')
    when 'task' then 'T'
    when 'lead' then 'L'
  end);

  if v_prefix = '' or v_prefix !~ '^[A-Za-z0-9/-]+$' then
    raise exception 'USER: The % prefix "%" can use only letters, digits, - and /. Fix it in Settings → Numbering.', v_noun, v_prefix
      using errcode = 'P0001';
  end if;

  v_max := coalesce(public.jsonb_to_numeric(public.statutory_param_value('gst.invoice_number_max_length', v_date))::int, 16);

  insert into public.number_series (key, financial_year, next_value)
  values (p_key, case when v_fy_scoped then public.financial_year_label(v_date) end, 1)
  on conflict (key) do nothing;

  select * into v_row from public.number_series where key = p_key for update;

  v_seq := v_row.next_value;
  v_fy := v_row.financial_year;
  if v_fy_scoped then
    v_date_fy := public.financial_year_label(v_date);
    if v_row.financial_year is not null and left(v_date_fy, 4)::int < left(v_row.financial_year, 4)::int then
      -- An earlier year the series has left: carry on from that year's own counter, if it was kept.
      select y.next_value into v_seq from public.number_series_years y
       where y.key = p_key and y.financial_year = v_date_fy for update;
      if not found then
        raise exception 'USER: The % series has moved on to FY %, so it can''t number a document dated in FY %.',
          v_noun, v_row.financial_year, v_date_fy using errcode = 'P0001';
      end if;
      v_earlier := true;
    elsif v_row.financial_year is not null and left(v_date_fy, 4)::int > left(v_row.financial_year, 4)::int then
      -- Moving on to a later year: keep the year being left, so a document dated in it can still be numbered.
      insert into public.number_series_years (key, financial_year, next_value)
      values (p_key, v_row.financial_year, v_row.next_value)
      on conflict (key, financial_year) do update set next_value = greatest(public.number_series_years.next_value, excluded.next_value);
      v_seq := 1;
    elsif v_row.financial_year is null then
      v_seq := 1;
    end if;
    v_fy := v_date_fy;
  end if;

  v_digits := case when length(v_seq::text) >= v_pad then v_seq::text else lpad(v_seq::text, v_pad, '0') end;
  v_number := case
    when v_fy_scoped then v_prefix || '/' || right(left(v_fy, 4), 2) || '-' || right(v_fy, 2) || '/' || v_digits
    else v_prefix || '-' || v_digits
  end;

  if char_length(v_number) > v_max then
    raise exception 'USER: The next % number (%) would be longer than % characters. Shorten the prefix in Settings → Numbering.',
      v_noun, v_number, v_max using errcode = 'P0001';
  end if;

  if v_earlier then
    update public.number_series_years set next_value = v_seq + 1, updated_at = now()
     where key = p_key and financial_year = v_fy;
  else
    update public.number_series
       set next_value = v_seq + 1,
           financial_year = case when v_fy_scoped then v_fy else financial_year end
     where key = p_key;
  end if;

  return v_number;
end;
$$;


update public.app_meta set value = '0246' where key = 'schema_version';
