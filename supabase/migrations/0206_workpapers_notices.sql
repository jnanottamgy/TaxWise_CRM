-- 0206 · Notices and litigation register (§5.10, §7.8.4): the notice, its dates and substance, the
-- Open → Reply drafted → Replied → Hearing → Closed workflow, a running dated log, the notice / reply
-- / order attachments, and appeal tracking when a notice closes against the client, with the
-- limitation date computed from statutory_parameters and an appeal task created automatically.
--
--   tax_notices (new columns)   tax_area, financial_year (the year the notice is about), replied_on,
--                               closed_at / closed_by, appeal_decision (+ note), limitation_manual,
--                               updated_by
--   tax_notice_notes            the running log: people's dated notes, plus lines the database
--                               writes itself (logged, dates moved, reassigned, status, attachments)
--
--   save_tax_notice(payload)                      create or edit a notice (§13 concurrency check)
--   set_tax_notice_status(id, ts, status, p)      the workflow, closing with the appeal decision;
--                                                 creates or updates the appeal task (§7.8.4)
--   notice_appeal_limitation(forum, order_date)   the last day to appeal, from the parameters
--
-- Rules (the guard is the real control, §4.1 "Workpapers: own clients", §4.6 column limits):
--   * status, closure and appeal columns change only through set_tax_notice_status;
--   * a notice stays with its client; it always has a type and a reply due date (§7.8.4 "*");
--   * a Hearing has a hearing date;
--   * Employees work on their own clients' notices (RLS), but only a Partner or Manager assigns a
--     notice to someone else, and only a Partner or Manager reopens a closed notice;
--   * the log is append-only for people (a Partner or Manager can remove a line written by mistake);
--   * an attachment must be one of the same client's documents.

set search_path = public, extensions;

-- =============================================================================================
-- Columns
-- =============================================================================================
alter table public.tax_notices
  add column if not exists tax_area text,
  add column if not exists financial_year text,
  add column if not exists replied_on date,
  add column if not exists closed_at timestamptz,
  add column if not exists closed_by uuid,
  add column if not exists appeal_decision text,
  add column if not exists appeal_note text,
  add column if not exists limitation_manual boolean not null default false,
  add column if not exists updated_by uuid;

alter table public.tax_notices
  add constraint tax_notices_tax_area_values check (tax_area is null or tax_area in ('gst', 'income_tax', 'tds', 'other')),
  add constraint tax_notices_financial_year_format check (financial_year is null or public.is_fy_label(financial_year)),
  add constraint tax_notices_appeal_decision_values check (appeal_decision is null or appeal_decision in ('appeal', 'no_appeal')),
  add constraint tax_notices_appeal_forum_values check (
    appeal_forum is null or appeal_forum in ('income_tax_first_appeal', 'income_tax_tribunal', 'gst_first_appeal', 'gst_tribunal', 'other')
  ),
  add constraint tax_notices_appeal_note_length check (appeal_note is null or char_length(appeal_note) <= 1000),
  add constraint tax_notices_description_length check (description is null or char_length(description) <= 5000);

comment on column public.tax_notices.tax_area is 'gst, income_tax, tds or other: decides the appeal forums and the appeal task''s service (§7.8.4).';
comment on column public.tax_notices.financial_year is 'The financial year the notice is about; its label (AY / Tax year) follows the statute of that year (§6.1).';
comment on column public.tax_notices.replied_on is 'When the reply was submitted.';
comment on column public.tax_notices.appeal_decision is 'When closed unfavourable or partial: appeal (forum, limitation date, appeal task) or no_appeal (with the reason).';
comment on column public.tax_notices.limitation_manual is 'True when the limitation date was entered by hand (e.g. the order was served after its date) instead of computed from the parameters.';

create index if not exists tax_notices_client_idx on public.tax_notices (client_id, created_at desc);
create index if not exists tax_notices_assigned_idx on public.tax_notices (assigned_employee_id) where assigned_employee_id is not null;
create index if not exists tax_notices_limitation_idx on public.tax_notices (limitation_date) where appeal_decision = 'appeal';

-- =============================================================================================
-- tax_notice_notes: the running log (§7.8.4 "Running notes log (dated entries)")
-- =============================================================================================
create table if not exists public.tax_notice_notes (
  id uuid primary key default gen_random_uuid(),
  notice_id uuid not null references public.tax_notices (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  noted_on date not null default public.today_ist(),
  kind text not null default 'note'
    constraint tax_notice_notes_kind_values check (kind in ('note', 'logged', 'dates', 'assigned', 'status', 'appeal', 'document')),
  body text not null constraint tax_notice_notes_body_length check (char_length(btrim(body)) between 1 and 4000),
  author_id uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.tax_notice_notes enable row level security;

comment on table public.tax_notice_notes is
  'The notice''s running log (§7.8.4): dated notes by people (kind note) and the lines the database writes on changes.';

create index if not exists tax_notice_notes_notice_idx on public.tax_notice_notes (notice_id, noted_on desc, created_at desc);
create index if not exists tax_notice_notes_client_idx on public.tax_notice_notes (client_id);

drop trigger if exists set_updated_at on public.tax_notice_notes;
create trigger set_updated_at before insert or update on public.tax_notice_notes
  for each row execute function public.set_updated_at();

create or replace function public.tax_notice_notes_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_client uuid;
begin
  select n.client_id into v_client from public.tax_notices n where n.id = new.notice_id;
  if v_client is null then
    raise exception 'USER: That notice no longer exists, or isn''t one of yours.' using errcode = 'P0001';
  end if;
  new.client_id := v_client;
  if public.is_api_caller() then
    if new.kind <> 'note' then
      raise exception 'USER: Only notes can be added to the log by hand; the other lines are written by the app.' using errcode = 'P0001';
    end if;
    if new.author_id is distinct from auth.uid() then
      raise exception 'USER: A note is written in your own name.' using errcode = 'P0001';
    end if;
    if new.noted_on > public.today_ist() then
      raise exception 'USER: A note can''t be dated in the future.' using errcode = 'P0001';
    end if;
    new.body := btrim(new.body);
  end if;
  return new;
end;
$$;

comment on function public.tax_notice_notes_guard() is
  'Trigger: a log line belongs to its notice''s client; people add only notes, in their own name, not dated in the future (§7.8.4).';

drop trigger if exists tax_notice_notes_guard on public.tax_notice_notes;
create trigger tax_notice_notes_guard before insert on public.tax_notice_notes
  for each row execute function public.tax_notice_notes_guard();

create policy tax_notice_notes_select on public.tax_notice_notes
  for select to authenticated
  using ((select public.is_staff()) and ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids())));
create policy tax_notice_notes_insert on public.tax_notice_notes
  for insert to authenticated
  with check (
    (select public.is_staff())
    and author_id = (select auth.uid())
    and ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()))
    and notice_id in (select n.id from public.tax_notices n)
  );
create policy tax_notice_notes_delete on public.tax_notice_notes
  for delete to authenticated using ((select public.is_manager_or_partner()));
revoke update, truncate, references, trigger on public.tax_notice_notes from authenticated;
revoke all on public.tax_notice_notes from anon;

-- =============================================================================================
-- Guard on tax_notices
-- =============================================================================================
create or replace function public.tax_notices_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_me uuid := public.my_employee_id();
  v_mp boolean := public.is_manager_or_partner();
begin
  if not public.is_api_caller() then
    return new;
  end if;

  new.notice_type := btrim(coalesce(new.notice_type, ''));
  if new.notice_type = '' then
    raise exception 'USER: Choose or type the notice type.' using errcode = 'P0001';
  end if;
  if new.reply_due_date is null then
    raise exception 'USER: Enter the reply due date.' using errcode = 'P0001';
  end if;
  if new.status = 'hearing' and new.hearing_date is null then
    raise exception 'USER: Enter the hearing date and time.' using errcode = 'P0001';
  end if;

  if tg_op = 'INSERT' then
    if new.status not in ('open', 'reply_drafted', 'replied', 'hearing') then
      raise exception 'USER: Log the notice first, then close it with its outcome.' using errcode = 'P0001';
    end if;
    if new.closed_at is not null or new.closed_by is not null or new.appeal_decision is not null or new.appeal_forum is not null
       or new.order_date is not null or new.limitation_date is not null or new.appeal_task_id is not null or new.appeal_note is not null then
      raise exception 'USER: The outcome and the appeal are recorded when the notice is closed.' using errcode = 'P0001';
    end if;
    if not v_mp and new.assigned_employee_id is not null and new.assigned_employee_id is distinct from v_me then
      raise exception 'USER: Only a Partner or Manager assigns a notice to someone else. Assign it to yourself or leave it unassigned.' using errcode = 'P0001';
    end if;
    new.limitation_manual := false;
    new.updated_by := auth.uid();
    return new;
  end if;

  if new.client_id is distinct from old.client_id or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
    raise exception 'USER: A notice stays with its client. Log a new notice for the other client.' using errcode = 'P0001';
  end if;
  if new.status is distinct from old.status or new.closed_at is distinct from old.closed_at or new.closed_by is distinct from old.closed_by
     or new.appeal_decision is distinct from old.appeal_decision or new.appeal_note is distinct from old.appeal_note
     or new.appeal_forum is distinct from old.appeal_forum or new.order_date is distinct from old.order_date
     or new.limitation_date is distinct from old.limitation_date or new.limitation_manual is distinct from old.limitation_manual
     or new.appeal_task_id is distinct from old.appeal_task_id then
    raise exception 'USER: The status, outcome and appeal change through Change status, which checks what each step needs.' using errcode = 'P0001';
  end if;
  if not v_mp and new.assigned_employee_id is distinct from old.assigned_employee_id then
    raise exception 'USER: Only a Partner or Manager reassigns a notice.' using errcode = 'P0001';
  end if;
  new.updated_by := auth.uid();
  return new;
end;
$$;

comment on function public.tax_notices_guard() is
  'Trigger: a notice has a type and a reply due date, a Hearing has its date; status, outcome and appeal change only through set_tax_notice_status; only Partners and Managers assign others or reassign (§4.6, §7.8.4).';

drop trigger if exists tax_notices_guard on public.tax_notices;
create trigger tax_notices_guard before insert or update on public.tax_notices
  for each row execute function public.tax_notices_guard();

-- The log lines the database writes itself (§7.8.4 running log): logged, dates moved, reassigned.
-- Status lines are written by set_tax_notice_status with the person's note.
create or replace function public.tax_notices_log()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_name text;
  v_fmt constant text := 'FMDD Mon YYYY';
  v_hearing_fmt constant text := 'FMDD Mon YYYY, HH24:MI';
begin
  if tg_op = 'INSERT' then
    insert into public.tax_notice_notes (notice_id, client_id, kind, body, author_id)
    values (new.id, new.client_id, 'logged',
      format('Notice logged: %s%s. Reply due %s%s.',
        new.notice_type,
        case when new.reference_no is not null and btrim(new.reference_no) <> '' then ', ref. ' || btrim(new.reference_no) else '' end,
        to_char(new.reply_due_date, v_fmt),
        case when new.hearing_date is not null then '; hearing ' || to_char(new.hearing_date at time zone 'Asia/Kolkata', v_hearing_fmt) else '' end),
      auth.uid());
    return new;
  end if;

  if new.reply_due_date is distinct from old.reply_due_date then
    insert into public.tax_notice_notes (notice_id, client_id, kind, body, author_id)
    values (new.id, new.client_id, 'dates',
      format('Reply due date moved from %s to %s.', coalesce(to_char(old.reply_due_date, v_fmt), 'none'), coalesce(to_char(new.reply_due_date, v_fmt), 'none')),
      auth.uid());
  end if;
  if new.hearing_date is distinct from old.hearing_date then
    insert into public.tax_notice_notes (notice_id, client_id, kind, body, author_id)
    values (new.id, new.client_id, 'dates',
      case
        when old.hearing_date is null then format('Hearing fixed for %s.', to_char(new.hearing_date at time zone 'Asia/Kolkata', v_hearing_fmt))
        when new.hearing_date is null then format('Hearing of %s removed.', to_char(old.hearing_date at time zone 'Asia/Kolkata', v_hearing_fmt))
        else format('Hearing moved from %s to %s.', to_char(old.hearing_date at time zone 'Asia/Kolkata', v_hearing_fmt), to_char(new.hearing_date at time zone 'Asia/Kolkata', v_hearing_fmt))
      end,
      auth.uid());
  end if;
  if new.assigned_employee_id is distinct from old.assigned_employee_id then
    select e.full_name into v_name from public.employees e where e.id = new.assigned_employee_id;
    insert into public.tax_notice_notes (notice_id, client_id, kind, body, author_id)
    values (new.id, new.client_id, 'assigned',
      case when new.assigned_employee_id is null then 'Unassigned.' else format('Assigned to %s.', coalesce(v_name, 'a colleague')) end,
      auth.uid());
  end if;
  return new;
end;
$$;

comment on function public.tax_notices_log() is
  'Trigger: writes the notice''s log lines for logging, moved reply and hearing dates, and reassignment (§7.8.4).';

drop trigger if exists tax_notices_log on public.tax_notices;
create trigger tax_notices_log after insert or update on public.tax_notices
  for each row execute function public.tax_notices_log();

-- =============================================================================================
-- tax_notice_documents: the same client's documents only, and a log line for each attachment.
-- =============================================================================================
create or replace function public.tax_notice_documents_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if not exists (
    select 1 from public.tax_notices n join public.documents d on d.client_id = n.client_id
    where n.id = new.notice_id and d.id = new.document_id
  ) then
    raise exception 'USER: Attach one of this client''s own documents.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

comment on function public.tax_notice_documents_guard() is 'Trigger: a notice''s attachment is one of the same client''s documents (§7.8.4).';

drop trigger if exists tax_notice_documents_guard on public.tax_notice_documents;
create trigger tax_notice_documents_guard before insert on public.tax_notice_documents
  for each row execute function public.tax_notice_documents_guard();

create or replace function public.tax_notice_documents_log()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_title text;
  v_client uuid;
begin
  select coalesce(d.title, d.file_name, 'a document'), n.client_id into v_title, v_client
  from public.tax_notices n left join public.documents d on d.id = new.document_id
  where n.id = new.notice_id;
  if v_client is null then
    return new;
  end if;
  insert into public.tax_notice_notes (notice_id, client_id, kind, body, author_id)
  values (new.notice_id, v_client, 'document',
    format('Attached %s: %s.',
      case new.kind when 'notice' then 'the notice' when 'reply' then 'the reply' when 'order' then 'the order' when 'appeal' then 'the appeal' else 'a document' end,
      v_title),
    auth.uid());
  return new;
end;
$$;

comment on function public.tax_notice_documents_log() is 'Trigger: a log line for each document attached to a notice (§7.8.4).';

drop trigger if exists tax_notice_documents_log on public.tax_notice_documents;
create trigger tax_notice_documents_log after insert on public.tax_notice_documents
  for each row execute function public.tax_notice_documents_log();

revoke execute on function
  public.tax_notice_notes_guard(),
  public.tax_notices_guard(),
  public.tax_notices_log(),
  public.tax_notice_documents_guard(),
  public.tax_notice_documents_log()
from public, anon, authenticated;

-- =============================================================================================
-- Appeal limitation (§7.8.4): from the statutory_parameters rows in force on the order date.
-- =============================================================================================
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
      return (p_order_date + make_interval(months => v_n))::date;
    end if;
  end if;
  return null;
end;
$$;

comment on function public.notice_appeal_limitation(text, date) is
  'The last day to appeal an order to a forum: the order date plus the period in the appeal.* statutory parameter in force on that date (days, or calendar months clamped to month end); null when no usable row (§7.8.4).';

-- =============================================================================================
-- Concurrency message (§13)
-- =============================================================================================
create or replace function public.tax_notice_conflict(p_id uuid)
returns text
language sql
stable
security definer
set search_path = public, extensions
as $$
  select format(
    'USER: Changed by %s at %s. Reload to see their changes.',
    coalesce(p.full_name, 'someone else'),
    to_char(n.updated_at at time zone 'Asia/Kolkata', 'HH24:MI')
  )
  from public.tax_notices n
  left join public.profiles p on p.id = n.updated_by
  where n.id = p_id
    and public.is_staff()
    and public.can_see_client(n.client_id)
$$;

comment on function public.tax_notice_conflict(uuid) is 'The concurrency refusal for a notice: who changed it last and when (§13).';

-- =============================================================================================
-- save_tax_notice(payload)
--   { id?, updated_at? (required with id), client_id (create), notice_type*, tax_area, section,
--     authority, reference_no, financial_year, notice_date, received_date, reply_due_date*,
--     hearing_date, demand_amount, description, assigned_employee_id, replied_on,
--     status (create only: open, reply_drafted, replied, hearing) }
-- Returns { id, status, updated_at, client_id, created, assigned_employee_id, previous_assigned_employee_id }.
-- =============================================================================================
create or replace function public.save_tax_notice(p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_id uuid := public.try_uuid(nullif(p_payload->>'id', ''));
  v_expected timestamptz;
  v_client uuid := public.try_uuid(nullif(p_payload->>'client_id', ''));
  v_type text := left(nullif(btrim(coalesce(p_payload->>'notice_type', '')), ''), 120);
  v_area text := nullif(btrim(coalesce(p_payload->>'tax_area', '')), '');
  v_section text := left(nullif(btrim(coalesce(p_payload->>'section', '')), ''), 80);
  v_authority text := left(nullif(btrim(coalesce(p_payload->>'authority', '')), ''), 200);
  v_ref text := left(nullif(btrim(coalesce(p_payload->>'reference_no', '')), ''), 100);
  v_fy text := nullif(btrim(coalesce(p_payload->>'financial_year', '')), '');
  v_description text := nullif(btrim(coalesce(p_payload->>'description', '')), '');
  v_assigned uuid := public.try_uuid(nullif(p_payload->>'assigned_employee_id', ''));
  v_status public.notice_status;
  v_notice_date date;
  v_received date;
  v_reply_due date;
  v_hearing timestamptz;
  v_replied date;
  v_demand numeric(16,2);
  v_row public.tax_notices%rowtype;
  v_prev_assigned uuid;
begin
  if not public.is_staff() then
    raise exception 'USER: Only the firm''s staff keep the notices register.' using errcode = 'P0001';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'USER: Enter the notice''s details.' using errcode = 'P0001';
  end if;
  if v_type is null then
    raise exception 'USER: Choose or type the notice type.' using errcode = 'P0001';
  end if;
  if v_area is not null and v_area not in ('gst', 'income_tax', 'tds', 'other') then
    raise exception 'USER: Choose GST, income tax, TDS or other.' using errcode = 'P0001';
  end if;
  if v_fy is not null and not public.is_fy_label(v_fy) then
    raise exception 'USER: Enter the year as YYYY-YY, for example 2025-26.' using errcode = 'P0001';
  end if;
  if v_description is not null and char_length(v_description) > 5000 then
    raise exception 'USER: Keep the description under 5,000 characters.' using errcode = 'P0001';
  end if;
  begin
    v_expected := nullif(p_payload->>'updated_at', '')::timestamptz;
    v_notice_date := nullif(p_payload->>'notice_date', '')::date;
    v_received := nullif(p_payload->>'received_date', '')::date;
    v_reply_due := nullif(p_payload->>'reply_due_date', '')::date;
    v_hearing := nullif(p_payload->>'hearing_date', '')::timestamptz;
    v_replied := nullif(p_payload->>'replied_on', '')::date;
    v_demand := nullif(p_payload->>'demand_amount', '')::numeric(16,2);
    v_status := coalesce(nullif(p_payload->>'status', ''), 'open')::public.notice_status;
  exception when others then
    raise exception 'USER: Check the dates, the demand amount and the status.' using errcode = 'P0001';
  end;
  if v_reply_due is null then
    raise exception 'USER: Enter the reply due date.' using errcode = 'P0001';
  end if;
  if v_notice_date is not null and v_notice_date > public.today_ist() then
    raise exception 'USER: The notice date can''t be in the future.' using errcode = 'P0001';
  end if;
  if v_received is not null and v_received > public.today_ist() then
    raise exception 'USER: The received date can''t be in the future.' using errcode = 'P0001';
  end if;
  if v_notice_date is not null and v_received is not null and v_received < v_notice_date then
    raise exception 'USER: The notice can''t be received before its date.' using errcode = 'P0001';
  end if;
  if v_notice_date is not null and v_reply_due < v_notice_date then
    raise exception 'USER: The reply due date can''t be before the notice date.' using errcode = 'P0001';
  end if;
  if v_replied is not null and v_replied > public.today_ist() then
    raise exception 'USER: The reply date can''t be in the future.' using errcode = 'P0001';
  end if;
  if v_demand is not null and v_demand < 0 then
    raise exception 'USER: The demand can''t be negative.' using errcode = 'P0001';
  end if;
  if v_assigned is not null and not public.employee_can_take_work(v_assigned) then
    raise exception 'USER: That person''s account is disabled. Choose someone active.' using errcode = 'P0001';
  end if;

  if v_id is null then
    if v_client is null or not public.can_see_client(v_client)
       or not exists (select 1 from public.clients c where c.id = v_client and c.deleted_at is null) then
      raise exception 'USER: That client isn''t one of yours, or it is in the recycle bin.' using errcode = 'P0001';
    end if;
    if v_status not in ('open', 'reply_drafted', 'replied', 'hearing') then
      raise exception 'USER: Log the notice first, then close it with its outcome.' using errcode = 'P0001';
    end if;
    insert into public.tax_notices (
      client_id, notice_type, tax_area, section, authority, reference_no, financial_year, notice_date, received_date,
      reply_due_date, hearing_date, status, demand_amount, description, assigned_employee_id, replied_on, created_by
    ) values (
      v_client, v_type, v_area, v_section, v_authority, v_ref, v_fy, v_notice_date, v_received,
      v_reply_due, v_hearing, v_status, v_demand, v_description, v_assigned,
      case when v_status in ('replied', 'hearing') then v_replied end, auth.uid()
    )
    returning * into v_row;
    return jsonb_build_object('id', v_row.id, 'status', v_row.status, 'updated_at', v_row.updated_at, 'client_id', v_row.client_id,
      'created', true, 'assigned_employee_id', v_row.assigned_employee_id, 'previous_assigned_employee_id', null);
  end if;

  select * into v_row from public.tax_notices n where n.id = v_id for update;
  if not found then
    raise exception 'USER: That notice no longer exists, or isn''t one of yours.' using errcode = 'P0001';
  end if;
  if v_expected is null or v_row.updated_at <> v_expected then
    raise exception '%', coalesce(public.tax_notice_conflict(v_id), 'USER: Changed by someone else. Reload to see their changes.') using errcode = 'P0001';
  end if;
  if v_client is not null and v_client <> v_row.client_id then
    raise exception 'USER: A notice stays with its client. Log a new notice for the other client.' using errcode = 'P0001';
  end if;
  v_prev_assigned := v_row.assigned_employee_id;

  update public.tax_notices n
  set notice_type = v_type,
      tax_area = v_area,
      section = v_section,
      authority = v_authority,
      reference_no = v_ref,
      financial_year = v_fy,
      notice_date = v_notice_date,
      received_date = v_received,
      reply_due_date = v_reply_due,
      hearing_date = v_hearing,
      demand_amount = v_demand,
      description = v_description,
      assigned_employee_id = case when p_payload ? 'assigned_employee_id' then v_assigned else n.assigned_employee_id end,
      replied_on = case when p_payload ? 'replied_on' then v_replied else n.replied_on end
  where n.id = v_id
  returning * into v_row;

  return jsonb_build_object('id', v_row.id, 'status', v_row.status, 'updated_at', v_row.updated_at, 'client_id', v_row.client_id,
    'created', false, 'assigned_employee_id', v_row.assigned_employee_id, 'previous_assigned_employee_id', v_prev_assigned);
end;
$$;

comment on function public.save_tax_notice(jsonb) is
  'Logs or edits a notice with the §13 concurrency check; the guard enforces the column limits and the log trigger records moved dates and reassignment (§7.8.4). Security invoker: RLS applies.';

-- =============================================================================================
-- notice_appeal_task_number(): the next task number (T-000123, §5.5) for the appeal task an
-- Employee's closing of a notice creates. It takes the same locked number_series row as
-- next_document_number('task') (§0.1 rule 6: a locked counter, never count()+1), which only a
-- Partner or Manager may call. Called only from set_tax_notice_status; no API grant.
-- =============================================================================================
create or replace function public.notice_appeal_task_number()
returns text
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_seq int;
begin
  insert into public.number_series (key, financial_year, next_value) values ('task', null, 1)
  on conflict (key) do nothing;
  select next_value into v_seq from public.number_series where key = 'task' for update;
  update public.number_series set next_value = v_seq + 1 where key = 'task';
  return 'T-' || case when length(v_seq::text) >= 6 then v_seq::text else lpad(v_seq::text, 6, '0') end;
end;
$$;

comment on function public.notice_appeal_task_number() is
  'The next task number from the locked task series, for the appeal task set_tax_notice_status creates (§5.5, §7.8.4). Not callable by API users.';

revoke execute on function public.notice_appeal_task_number() from public, anon, authenticated;

-- =============================================================================================
-- set_tax_notice_status(id, updated_at, status, payload)
--   payload: { note, replied_on, hearing_date, order_date,
--              appeal: { decision: appeal | no_appeal, forum, limitation_date, note } }
-- Security definer (status, outcome and appeal columns are closed to direct writes): it checks the
-- caller is staff who can see the client, the §13 concurrency, the step's requirements, then writes
-- the status, the log line and, when appealing, the appeal task.
-- Returns { id, status, from_status, updated_at, client_id, appeal_task_id, task_created,
--           task_assignee_id, limitation_date, limitation_manual }.
-- =============================================================================================
create or replace function public.set_tax_notice_status(p_id uuid, p_updated_at timestamptz, p_status public.notice_status, p_payload jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_appeal jsonb := case when jsonb_typeof(v_payload->'appeal') = 'object' then v_payload->'appeal' else '{}'::jsonb end;
  v_note text := left(nullif(btrim(coalesce(v_payload->>'note', '')), ''), 2000);
  v_row public.tax_notices%rowtype;
  v_from public.notice_status;
  v_closing boolean := p_status in ('closed_favourable', 'closed_unfavourable', 'closed_partial');
  v_was_closed boolean;
  v_today date := public.today_ist();
  v_replied date;
  v_hearing timestamptz;
  v_order date;
  v_decision text := nullif(btrim(coalesce(v_appeal->>'decision', '')), '');
  v_forum text := nullif(btrim(coalesce(v_appeal->>'forum', '')), '');
  v_appeal_note text := left(nullif(btrim(coalesce(v_appeal->>'note', '')), ''), 1000);
  v_manual date;
  v_limitation date;
  v_limitation_manual boolean := false;
  v_task public.tasks%rowtype;
  v_task_id uuid;
  v_task_created boolean := false;
  v_assignee uuid;
  v_owner uuid;
  v_forum_label text;
  v_title text;
  v_description text;
  v_service public.service_type;
  v_priority public.task_priority;
  v_line text;
  v_label constant text := 'FMDD Mon YYYY';
begin
  if not public.is_staff() then
    raise exception 'USER: Only the firm''s staff keep the notices register.' using errcode = 'P0001';
  end if;
  if p_status is null then
    raise exception 'USER: Choose the new status.' using errcode = 'P0001';
  end if;

  select * into v_row from public.tax_notices n where n.id = p_id for update;
  if not found or not public.can_see_client(v_row.client_id)
     or not exists (select 1 from public.clients c where c.id = v_row.client_id and c.deleted_at is null) then
    raise exception 'USER: That notice no longer exists, or isn''t one of yours.' using errcode = 'P0001';
  end if;
  if p_updated_at is null or v_row.updated_at <> p_updated_at then
    raise exception '%', coalesce(public.tax_notice_conflict(p_id), 'USER: Changed by someone else. Reload to see their changes.') using errcode = 'P0001';
  end if;
  v_from := v_row.status;
  v_was_closed := v_from in ('closed_favourable', 'closed_unfavourable', 'closed_partial');

  if v_from = p_status and not (v_closing and p_status <> 'closed_favourable') then
    raise exception 'USER: The notice is already at that status.' using errcode = 'P0001';
  end if;
  if v_was_closed and not v_closing then
    if not public.is_manager_or_partner() then
      raise exception 'USER: Only a Manager or Partner can reopen a closed notice.' using errcode = 'P0001';
    end if;
    if v_note is null then
      raise exception 'USER: Say why the notice is reopened (for example, the order was set aside or remanded).' using errcode = 'P0001';
    end if;
  end if;

  begin
    v_replied := nullif(v_payload->>'replied_on', '')::date;
    v_hearing := nullif(v_payload->>'hearing_date', '')::timestamptz;
    v_order := nullif(v_payload->>'order_date', '')::date;
    v_manual := nullif(v_appeal->>'limitation_date', '')::date;
  exception when others then
    raise exception 'USER: Check the dates.' using errcode = 'P0001';
  end;

  -- Replied: when the reply went in.
  if p_status = 'replied' then
    v_replied := coalesce(v_replied, v_row.replied_on, v_today);
    if v_replied > v_today then
      raise exception 'USER: The reply date can''t be in the future.' using errcode = 'P0001';
    end if;
    if v_row.notice_date is not null and v_replied < v_row.notice_date then
      raise exception 'USER: The reply can''t be before the notice date.' using errcode = 'P0001';
    end if;
  else
    v_replied := coalesce(v_replied, v_row.replied_on);
  end if;

  -- Hearing: its date and time.
  v_hearing := coalesce(v_hearing, v_row.hearing_date);
  if p_status = 'hearing' and v_hearing is null then
    raise exception 'USER: Enter the hearing date and time.' using errcode = 'P0001';
  end if;

  if v_closing then
    if p_status in ('closed_unfavourable', 'closed_partial') then
      if v_order is null then
        raise exception 'USER: Enter the date of the order.' using errcode = 'P0001';
      end if;
      if v_decision is null or v_decision not in ('appeal', 'no_appeal') then
        raise exception 'USER: Record whether the client will appeal.' using errcode = 'P0001';
      end if;
    elsif v_decision is not null then
      raise exception 'USER: A favourable outcome needs no appeal.' using errcode = 'P0001';
    end if;
    if v_order is not null and v_order > v_today then
      raise exception 'USER: The order date can''t be in the future.' using errcode = 'P0001';
    end if;
    if v_order is not null and v_row.notice_date is not null and v_order < v_row.notice_date then
      raise exception 'USER: The order can''t be dated before the notice.' using errcode = 'P0001';
    end if;

    if v_decision = 'no_appeal' then
      if v_appeal_note is null then
        raise exception 'USER: Say why the client won''t appeal (for example, the demand is accepted and paid).' using errcode = 'P0001';
      end if;
      v_forum := null;
      v_limitation := null;
    elsif v_decision = 'appeal' then
      if v_forum is null or v_forum not in ('income_tax_first_appeal', 'income_tax_tribunal', 'gst_first_appeal', 'gst_tribunal', 'other') then
        raise exception 'USER: Choose the appeal forum.' using errcode = 'P0001';
      end if;
      if v_forum <> 'other' then
        v_limitation := public.notice_appeal_limitation(v_forum, v_order);
      end if;
      if v_manual is not null then
        if v_manual < v_order then
          raise exception 'USER: The limitation date can''t be before the order date.' using errcode = 'P0001';
        end if;
        v_limitation_manual := v_limitation is distinct from v_manual;
        v_limitation := v_manual;
      elsif v_limitation is null then
        raise exception 'USER: Enter the limitation date: no limitation period is recorded for this forum on the Law & rules page.' using errcode = 'P0001';
      end if;
    end if;
  end if;

  -- The appeal task (§7.8.4 "an appeal task created automatically"), or its new dates.
  if v_closing and v_decision = 'appeal' then
    v_forum_label := case v_forum
      when 'income_tax_first_appeal' then 'the Commissioner (Appeals)'
      when 'income_tax_tribunal' then 'the Income Tax Appellate Tribunal'
      when 'gst_first_appeal' then 'the GST Appellate Authority'
      when 'gst_tribunal' then 'the GST Appellate Tribunal'
      else 'the appellate forum'
    end;
    v_title := left(format('Appeal to %s: %s order of %s', v_forum_label, v_row.notice_type, to_char(v_order, v_label)), 300);
    v_description := left(format(
      'File the appeal by %s (limitation date%s). Notice: %s%s%s. Order dated %s. Open the notice: /workpapers/notices/%s',
      to_char(v_limitation, v_label),
      case when v_limitation_manual then ', entered by hand' else ', from the order date and the period on the Law & rules page' end,
      v_row.notice_type,
      case when v_row.section is not null then ', ' || v_row.section else '' end,
      case when v_row.reference_no is not null then ', ref. ' || v_row.reference_no else '' end,
      to_char(v_order, v_label),
      v_row.id), 5000);
    v_service := case v_row.tax_area when 'gst' then 'gst' when 'income_tax' then 'income_tax' when 'tds' then 'tds' else 'other' end;
    v_priority := case when v_limitation - v_today <= 7 then 'urgent' else 'high' end;

    if v_row.appeal_task_id is not null then
      select * into v_task from public.tasks t where t.id = v_row.appeal_task_id and t.deleted_at is null;
    end if;
    if v_task.id is not null then
      v_task_id := v_task.id;
      if v_task.status <> 'filed_done' then
        update public.tasks t
        set due_date = v_limitation, title = v_title, description = v_description, priority = v_priority
        where t.id = v_task.id;
      end if;
      v_assignee := v_task.assigned_employee_id;
    else
      select c.owner_employee_id into v_owner from public.clients c where c.id = v_row.client_id;
      v_assignee := case
        when v_row.assigned_employee_id is not null and public.employee_can_take_work(v_row.assigned_employee_id) then v_row.assigned_employee_id
        when v_owner is not null and public.employee_can_take_work(v_owner) then v_owner
        else null
      end;
      insert into public.tasks (task_number, client_id, title, description, service_type, financial_year, priority, due_date, assigned_employee_id, created_by)
      values (
        -- A Partner or Manager takes the number the usual way; for an Employee closing their own
        -- client's notice, the task series is advanced here (next_document_number is theirs alone).
        case when public.is_manager_or_partner() then public.next_document_number('task', v_today) else public.notice_appeal_task_number() end,
        v_row.client_id, v_title, v_description, v_service, v_row.financial_year, v_priority, v_limitation, v_assignee, auth.uid()
      )
      returning id into v_task_id;
      v_task_created := true;
    end if;
  end if;

  update public.tax_notices n
  set status = p_status,
      replied_on = v_replied,
      hearing_date = v_hearing,
      closed_at = case when v_closing then coalesce(case when v_was_closed then n.closed_at end, now()) else null end,
      closed_by = case when v_closing then coalesce(case when v_was_closed then n.closed_by end, auth.uid()) else null end,
      order_date = case when v_closing then v_order else n.order_date end,
      appeal_decision = case when v_closing then v_decision else n.appeal_decision end,
      appeal_note = case when v_closing then v_appeal_note else n.appeal_note end,
      appeal_forum = case when v_closing then v_forum else n.appeal_forum end,
      limitation_date = case when v_closing then v_limitation else n.limitation_date end,
      limitation_manual = case when v_closing then v_limitation_manual else n.limitation_manual end,
      appeal_task_id = case when v_task_id is not null then v_task_id else n.appeal_task_id end,
      updated_by = auth.uid()
  where n.id = p_id
  returning * into v_row;

  -- The log line: what changed and the person's note.
  v_line := case
    when v_from = p_status then 'Appeal details updated.'
    else format('Status: %s → %s.', public.notice_status_label(v_from), public.notice_status_label(p_status))
  end;
  if p_status = 'replied' and v_replied is not null then
    v_line := v_line || format(' Replied on %s.', to_char(v_replied, v_label));
  end if;
  if v_closing and v_order is not null then
    v_line := v_line || format(' Order dated %s.', to_char(v_order, v_label));
  end if;
  if v_closing and v_decision = 'appeal' then
    v_line := v_line || format(' Appeal to %s by %s%s.', v_forum_label, to_char(v_limitation, v_label), case when v_limitation_manual then ' (date entered by hand)' else '' end);
  elsif v_closing and v_decision = 'no_appeal' then
    v_line := v_line || format(' No appeal: %s', v_appeal_note);
  end if;
  if v_note is not null then
    v_line := v_line || ' ' || v_note;
  end if;
  insert into public.tax_notice_notes (notice_id, client_id, kind, body, author_id)
  values (v_row.id, v_row.client_id, case when v_closing and v_decision is not null then 'appeal' else 'status' end, left(v_line, 4000), auth.uid());

  return jsonb_build_object(
    'id', v_row.id, 'status', v_row.status, 'from_status', v_from, 'updated_at', v_row.updated_at, 'client_id', v_row.client_id,
    'appeal_task_id', v_row.appeal_task_id, 'task_created', v_task_created, 'task_assignee_id', v_assignee,
    'limitation_date', v_row.limitation_date, 'limitation_manual', v_row.limitation_manual, 'appeal_decision', v_row.appeal_decision
  );
end;
$$;

comment on function public.set_tax_notice_status(uuid, timestamptz, public.notice_status, jsonb) is
  'The notice workflow (§3.6, §7.8.4): Open → Reply drafted → Replied → Hearing → Closed, reopening by Partner/Manager with a reason; closing unfavourable or partial records the appeal decision, the limitation date (parameters or by hand) and creates or updates the appeal task. Security definer with its own staff, client and concurrency checks.';

-- Labels for log lines (§3.6 status vocabulary).
create or replace function public.notice_status_label(p public.notice_status)
returns text
language sql
immutable
set search_path = public, extensions
as $$
  select case p
    when 'open' then 'Open'
    when 'reply_drafted' then 'Reply drafted'
    when 'replied' then 'Replied'
    when 'hearing' then 'Hearing'
    when 'closed_favourable' then 'Closed (favourable)'
    when 'closed_unfavourable' then 'Closed (unfavourable)'
    when 'closed_partial' then 'Closed (partial)'
  end
$$;

comment on function public.notice_status_label(public.notice_status) is 'The §3.6 label of a notice status.';

revoke execute on function
  public.notice_appeal_limitation(text, date),
  public.tax_notice_conflict(uuid),
  public.save_tax_notice(jsonb),
  public.set_tax_notice_status(uuid, timestamptz, public.notice_status, jsonb),
  public.notice_status_label(public.notice_status)
from public, anon;
grant execute on function
  public.notice_appeal_limitation(text, date),
  public.tax_notice_conflict(uuid),
  public.save_tax_notice(jsonb),
  public.set_tax_notice_status(uuid, timestamptz, public.notice_status, jsonb),
  public.notice_status_label(public.notice_status)
to authenticated, service_role;
