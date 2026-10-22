-- 0031 · Core database functions (§0.1 rules 6 and 12, §4.4, §4.6, §5.11, §7.9.2, §13).
--   * log_audit_event(...)            insert-only audit trail (§4.6: INSERT only through this function)
--   * report_role_claim()             role claims in user_metadata are ignored and reported (§4.4)
--   * check_rate_limit(...)           fixed-window counters (§13)
--   * next_document_number(key, date) the locked counter (§0.1 rule 6, §5.11)
--   * auto numbers: task T-000001, lead L-0001, client code TW-C-0001 on insert; quotation, receipt
--     and credit note numbers when none is given; invoice numbers when the invoice leaves Draft
--     (§7.9.2 "Number assigned when it leaves Draft (Issue)").

set search_path = public, extensions;

-- =============================================================================================
-- log_audit_event (§0.1 rule 12, §4.4, §4.6, §7.20)
-- Who is taken from the session, never from the arguments: user_id = auth.uid(); email and role
-- from profiles (profiles.role is the authority, §0.1 rule 9).
-- =============================================================================================
create or replace function public.log_audit_event(
  p_event public.audit_event,
  p_resource_type text default null,
  p_resource_id text default null,
  p_action text default null,
  p_details jsonb default '{}'::jsonb,
  p_success boolean default true,
  p_error text default null,
  p_ip text default null,
  p_user_agent text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_role text;
  v_id uuid;
begin
  if p_event is null then
    raise exception 'USER: An audit entry needs an event type.' using errcode = 'P0001';
  end if;

  if v_uid is not null then
    select p.email::text, p.role::text into v_email, v_role from public.profiles p where p.id = v_uid;
  end if;
  v_email := coalesce(v_email, auth.jwt() ->> 'email');

  insert into public.audit_logs (
    event, user_id, user_email, user_role, ip, user_agent, resource_type, resource_id, action, details, success, error
  ) values (
    p_event, v_uid, v_email, v_role,
    left(p_ip, 100), left(p_user_agent, 500),
    left(p_resource_type, 100), left(p_resource_id, 200), left(p_action, 200),
    coalesce(p_details, '{}'::jsonb), coalesce(p_success, true), left(p_error, 2000)
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.log_audit_event(public.audit_event, text, text, text, jsonb, boolean, text, text, text) is
  'Writes one audit_logs row for the signed-in user (user_id/email/role from the session and profiles). The only way the API inserts audit rows (§4.6).';

-- =============================================================================================
-- report_role_claim() (§4.4): if the caller's auth.users.raw_user_meta_data has a "role" key, write
-- an access_denied audit row ("role claim in user_metadata ignored") and send every active Partner
-- a security_alert notification, at most once per user per IST day. The claim itself grants
-- nothing: app_role() never reads user_metadata. Returns true when it reported, false otherwise.
-- =============================================================================================
create or replace function public.report_role_claim()
returns boolean
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_meta jsonb;
  v_claim jsonb;
  v_email text;
  v_name text;
  v_role text;
  v_day_start timestamptz := (public.today_ist()::timestamp at time zone 'Asia/Kolkata');
begin
  if v_uid is null then
    return false;
  end if;

  select u.raw_user_meta_data into v_meta from auth.users u where u.id = v_uid;
  if v_meta is null or not (v_meta ? 'role') then
    return false;
  end if;
  v_claim := v_meta -> 'role';

  -- One report per user per day, even when several requests arrive at once.
  perform pg_advisory_xact_lock(hashtext('report_role_claim:' || v_uid::text));
  if exists (
    select 1 from public.audit_logs a
    where a.user_id = v_uid
      and a.event = 'access_denied'
      and a.action = 'role_claim.ignored'
      and a.at >= v_day_start
  ) then
    return false;
  end if;

  select p.email::text, p.full_name, p.role::text into v_email, v_name, v_role from public.profiles p where p.id = v_uid;
  v_email := coalesce(v_email, (select u.email::text from auth.users u where u.id = v_uid));

  insert into public.audit_logs (event, user_id, user_email, user_role, resource_type, resource_id, action, details, success, error)
  values (
    'access_denied', v_uid, v_email, v_role, 'auth', v_uid::text, 'role_claim.ignored',
    jsonb_build_object('message', 'role claim in user_metadata ignored', 'claimed_role', v_claim, 'profile_role', v_role),
    false, 'role claim in user_metadata ignored'
  );

  insert into public.notifications (user_id, type, title, body, link_url, entity_type, entity_id)
  select
    p.id,
    'security_alert',
    'Role claim ignored',
    coalesce(v_name, v_email, 'A user') || coalesce(' (' || v_email || ')', '')
      || ' has a role claim (' || coalesce(v_claim #>> '{}', 'unknown') || ') in their user metadata. It was ignored and grants nothing; check how it got there.',
    '/audit-log?user=' || v_uid::text,
    'profile',
    v_uid
  from public.profiles p
  where p.role = 'partner' and p.is_active;

  return true;
end;
$$;

comment on function public.report_role_claim() is
  'If user_metadata has a role key: access_denied audit row + security_alert to every active Partner, at most once per user per IST day (§4.4). Grants nothing.';

-- =============================================================================================
-- check_rate_limit(key, limit, window_seconds) (§13): counts one attempt in the current fixed
-- window and returns true while the count is within the limit. Service role only: keys belong to
-- other people (an email + IP), so signed-in users must not be able to spend them.
-- =============================================================================================
create or replace function public.check_rate_limit(p_key text, p_limit int, p_window_seconds int)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_window timestamptz;
  v_count int;
begin
  if p_key is null or btrim(p_key) = '' then
    raise exception 'check_rate_limit: key is required';
  end if;
  if p_limit is null or p_limit < 1 or p_window_seconds is null or p_window_seconds < 1 then
    raise exception 'check_rate_limit: limit and window must be at least 1';
  end if;

  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  insert into public.rate_limits as r (key, window_start, count)
  values (p_key, v_window, 1)
  on conflict (key, window_start) do update set count = r.count + 1
  returning r.count into v_count;

  -- Housekeeping: now and then, drop windows that ended long ago.
  if random() < 0.01 then
    delete from public.rate_limits where window_start < now() - interval '2 days';
  end if;

  return v_count <= p_limit;
end;
$$;

comment on function public.check_rate_limit(text, int, int) is
  'Fixed-window rate limit (§13): counts one attempt for the key and returns true while within the limit.';

-- =============================================================================================
-- next_document_number(p_key, p_date) (§0.1 rule 6, §5.11). Pure mirror: lib/domain/numbering.ts.
--   * locks the number_series row (SELECT … FOR UPDATE); a missing row is created at 1;
--   * FY-scoped series (invoice, credit_note, quotation, receipt) restart at 1 in a later FY and
--     refuse a date in an earlier FY than the row (restarting would reuse that FY's numbers);
--   * prefixes come from firm_settings (task 'T' and lead 'L' are fixed);
--   * formats: invoice TW/26-27/0001 · credit_note TW-CN/26-27/0001 · quotation TW-Q/26-27/0001 ·
--     receipt TW-R/26-27/0001 · client_code TW-C-0001 · task T-000001 · lead L-0001
--     (the sequence is zero-padded, never truncated);
--   * GST Rule 46: letters, digits, '-' and '/', at most 16 characters (statutory parameter
--     'gst.invoice_number_max_length' when present, else 16). numbering.ts applies the limit to
--     every series, and so does this function.
-- Callable by Partners/Managers, the service role, and direct database sessions (seed, jobs).
-- =============================================================================================
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
      raise exception 'USER: The % series has moved on to FY %, so it can''t number a document dated in FY %.',
        v_noun, v_row.financial_year, v_date_fy using errcode = 'P0001';
    end if;
    if v_row.financial_year is null or left(v_date_fy, 4)::int > left(v_row.financial_year, 4)::int then
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

  update public.number_series
     set next_value = v_seq + 1,
         financial_year = case when v_fy_scoped then v_fy else financial_year end
   where key = p_key;

  return v_number;
end;
$$;

comment on function public.next_document_number(text, date) is
  'Takes the next number from the locked number_series row (FOR UPDATE; FY reset; ≤16 chars, GST Rule 46). Mirror: lib/domain/numbering.ts (§0.1 rule 6, §5.11).';

-- =============================================================================================
-- Auto numbers (§5.3 client_code "auto TW-C-0001", §5.4 lead "auto L-0001", §5.5 task "auto
-- T-000123", §5.4/§5.7 quotation, receipt and credit note numbers "from number_series", §7.9.2
-- invoice number when it leaves Draft). A number supplied by the caller is kept.
-- =============================================================================================
create or replace function public.assign_document_number()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  -- Someone who may not take numbers can't create these rows either: leave the number empty and
  -- let RLS (which is checked after BEFORE triggers) refuse the row with its own message.
  if public.is_api_caller() and not public.is_manager_or_partner() then
    return new;
  end if;
  case tg_table_name
    when 'tasks' then
      if nullif(btrim(new.task_number), '') is null then
        new.task_number := public.next_document_number('task', public.today_ist());
      end if;
    when 'leads' then
      if nullif(btrim(new.lead_number), '') is null then
        new.lead_number := public.next_document_number('lead', public.today_ist());
      end if;
    when 'clients' then
      if nullif(btrim(new.client_code::text), '') is null then
        new.client_code := public.next_document_number('client_code', public.today_ist());
      end if;
    when 'quotations' then
      if nullif(btrim(new.quotation_number), '') is null then
        new.quotation_number := public.next_document_number('quotation', coalesce(new.issue_date, public.today_ist()));
      end if;
    when 'payment_receipts' then
      -- Numbered on the day it is recorded (a March payment recorded in April is a receipt of April's FY).
      if nullif(btrim(new.receipt_number), '') is null then
        new.receipt_number := public.next_document_number('receipt', public.today_ist());
      end if;
    when 'credit_notes' then
      if nullif(btrim(new.credit_note_number), '') is null then
        new.credit_note_number := public.next_document_number('credit_note', coalesce(new.issue_date, public.today_ist()));
      end if;
    when 'invoices' then
      -- §7.9.2: drafts (and invoices awaiting approval) show "Draft"; the number is assigned when the
      -- invoice leaves Draft. Debit notes / supplementary invoices share the invoice series.
      if nullif(btrim(new.invoice_number), '') is null then
        new.invoice_number := null;
        if new.status not in ('draft', 'awaiting_approval') then
          new.invoice_number := public.next_document_number('invoice', coalesce(new.issue_date, public.today_ist()));
        end if;
      end if;
    else
      null;
  end case;
  return new;
end;
$$;

comment on function public.assign_document_number() is
  'Trigger: fills task/lead/client code/quotation/receipt/credit note numbers on insert, and the invoice number when it leaves Draft (§5.11, §7.9.2).';

create trigger assign_document_number before insert on public.tasks
  for each row execute function public.assign_document_number();
create trigger assign_document_number before insert on public.leads
  for each row execute function public.assign_document_number();
create trigger assign_document_number before insert on public.clients
  for each row execute function public.assign_document_number();
create trigger assign_document_number before insert on public.quotations
  for each row execute function public.assign_document_number();
create trigger assign_document_number before insert on public.payment_receipts
  for each row execute function public.assign_document_number();
create trigger assign_document_number before insert on public.credit_notes
  for each row execute function public.assign_document_number();
create trigger assign_document_number before insert or update of status, invoice_number on public.invoices
  for each row execute function public.assign_document_number();

-- =============================================================================================
-- Grants
-- =============================================================================================
revoke execute on function
  public.log_audit_event(public.audit_event, text, text, text, jsonb, boolean, text, text, text),
  public.report_role_claim(),
  public.next_document_number(text, date),
  public.check_rate_limit(text, int, int),
  public.assign_document_number()
from public, anon;

grant execute on function
  public.log_audit_event(public.audit_event, text, text, text, jsonb, boolean, text, text, text),
  public.report_role_claim(),
  public.next_document_number(text, date)
to authenticated, service_role;

revoke execute on function public.check_rate_limit(text, int, int) from authenticated;
grant execute on function public.check_rate_limit(text, int, int) to service_role;

revoke execute on function public.assign_document_number() from authenticated;

update public.app_meta set value = '0031' where key = 'schema_version';
