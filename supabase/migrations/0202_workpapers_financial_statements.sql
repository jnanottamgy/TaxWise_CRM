-- 0202 · Financial statements workpapers (§5.10, §6.13, §7.8.3): one statement per client and FY,
-- rebuilt on the server on every save, with the Draft → Reviewed → Final workflow enforced here.
--
--   financial_statements.inputs       the person's inputs besides the trial balance: closing stock,
--                                     where the profit goes, other movements in capital, the trade
--                                     receivables / payables ageing items, the MSME disclosure, the
--                                     accounting-policies text and the trial-balance import settings
--   financial_statements.ledgers      the trial balance with each ledger's bucket (§5.10: name, group,
--                                     debit, credit, bucket, matched), amounts in integer paise
--   financial_statements.statements   P&L, balance sheet, notes and checks (lib/domain/schedule3.ts)
--
--   save_financial_statement(payload)            create (as a draft) or update one statement, with
--                                                the §13 concurrency check. Security invoker.
--   set_financial_statement_status(id, ts, to, note)  Draft → Reviewed → Final, back to Draft.
--
-- The guard trigger is the real control (§4.1, §7.8.3 "Final only Manager/Partner"):
--   * only a Partner or Manager marks a statement Final, only from Reviewed, and only when every
--     check passed; only they reopen a Final statement;
--   * a Final statement's figures never change;
--   * a statement is reviewed by someone other than the person who last changed its figures
--     (a Partner may review their own, as with filing a task, §4.1);
--   * a change to the figures of a Reviewed statement sends it back to Draft.

set search_path = public, extensions;

-- =============================================================================================
-- Columns
-- =============================================================================================
alter table public.financial_statements
  add column if not exists inputs jsonb not null default '{}'::jsonb,
  add column if not exists source_document_id uuid references public.documents (id) on delete set null,
  add column if not exists previous_statement_id uuid references public.financial_statements (id) on delete set null,
  add column if not exists prepared_by uuid,
  add column if not exists updated_by uuid,
  add column if not exists reviewed_by uuid,
  add column if not exists reviewed_at timestamptz,
  add column if not exists finalised_by uuid,
  add column if not exists finalised_at timestamptz,
  add column if not exists review_note text;

alter table public.financial_statements
  add constraint financial_statements_review_note_length check (review_note is null or char_length(review_note) <= 1000);

comment on column public.financial_statements.inputs is
  'Inputs besides the trial balance: closing stock, profit destination, other capital movements, ageing items, MSME disclosure, notes text, import settings (§6.13).';
comment on column public.financial_statements.source_document_id is 'The trial balance in the client''s document vault (§7.8.3 step 2).';
comment on column public.financial_statements.previous_statement_id is 'Last year''s saved statement the comparatives came from (§6.13).';
comment on column public.financial_statements.prepared_by is 'Who last changed the figures (trial balance, mapping or inputs).';
comment on column public.financial_statements.review_note is 'Why a statement was sent back to Draft or reopened.';

create unique index if not exists financial_statements_client_fy_key on public.financial_statements (client_id, financial_year);

-- =============================================================================================
-- Guard
-- =============================================================================================
create or replace function public.financial_statements_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_content_changed boolean;
begin
  if not public.is_api_caller() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'USER: A new statement starts as a draft.' using errcode = 'P0001';
    end if;
    new.prepared_by := auth.uid();
    new.updated_by := auth.uid();
    new.reviewed_by := null;
    new.reviewed_at := null;
    new.finalised_by := null;
    new.finalised_at := null;
    return new;
  end if;

  if new.client_id is distinct from old.client_id or new.financial_year is distinct from old.financial_year
     or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
    raise exception 'USER: A statement stays with its client and year.' using errcode = 'P0001';
  end if;
  if new.reviewed_by is distinct from old.reviewed_by or new.reviewed_at is distinct from old.reviewed_at
     or new.finalised_by is distinct from old.finalised_by or new.finalised_at is distinct from old.finalised_at
     or new.prepared_by is distinct from old.prepared_by then
    raise exception 'USER: Who prepared, reviewed and finalised a statement is recorded by the app.' using errcode = 'P0001';
  end if;

  v_content_changed := new.ledgers is distinct from old.ledgers
    or new.statements is distinct from old.statements
    or new.inputs is distinct from old.inputs
    or new.source_document_id is distinct from old.source_document_id
    or new.previous_statement_id is distinct from old.previous_statement_id;

  -- A Final statement is locked; only a Partner or Manager reopens it.
  if old.status = 'final' then
    if new.status = 'final' and v_content_changed then
      raise exception 'USER: This statement is final. A Manager or Partner can reopen it to make changes.' using errcode = 'P0001';
    end if;
    if new.status <> 'final' and not public.is_manager_or_partner() then
      raise exception 'USER: Only a Manager or Partner can reopen a final statement.' using errcode = 'P0001';
    end if;
  end if;

  if v_content_changed then
    new.prepared_by := auth.uid();
    -- Changed figures need a fresh review.
    if new.status = 'reviewed' and old.status = 'reviewed' then
      new.status := 'draft';
    end if;
  end if;

  if new.status = 'final' and old.status <> 'final' then
    if not public.is_manager_or_partner() then
      raise exception 'USER: Only a Manager or Partner can mark a statement final.' using errcode = 'P0001';
    end if;
    if old.status <> 'reviewed' or v_content_changed then
      raise exception 'USER: A statement is reviewed before it is marked final.' using errcode = 'P0001';
    end if;
    if coalesce((new.statements->>'allChecksPassed')::boolean, false) is not true then
      raise exception 'USER: Every check must pass before the statement is final. Fix the failing checks first.' using errcode = 'P0001';
    end if;
    new.finalised_by := auth.uid();
    new.finalised_at := now();
  end if;

  if new.status = 'reviewed' and old.status = 'draft' then
    if old.prepared_by = auth.uid() and not public.is_partner() then
      raise exception 'USER: Someone other than the preparer reviews the statement. Ask a colleague, a Manager or a Partner.' using errcode = 'P0001';
    end if;
    new.reviewed_by := auth.uid();
    new.reviewed_at := now();
  elsif new.status = 'reviewed' and old.status = 'final' then
    raise exception 'USER: Reopen a final statement as a draft.' using errcode = 'P0001';
  end if;

  if new.status = 'draft' then
    new.reviewed_by := null;
    new.reviewed_at := null;
  end if;
  if new.status <> 'final' then
    new.finalised_by := null;
    new.finalised_at := null;
  end if;
  if new.status = old.status and new.review_note is distinct from old.review_note and not v_content_changed then
    -- The note travels with a status change; on its own it is kept as it was.
    new.review_note := old.review_note;
  end if;

  new.updated_by := auth.uid();
  return new;
end;
$$;

comment on function public.financial_statements_guard() is
  'Trigger: Draft → Reviewed → Final with Final by Partner/Manager only, every check passed; Final is locked; reviewer ≠ preparer (Partners excepted); changed figures go back to Draft (§7.8.3).';

drop trigger if exists financial_statements_guard on public.financial_statements;
create trigger financial_statements_guard before insert or update on public.financial_statements
  for each row execute function public.financial_statements_guard();

revoke execute on function public.financial_statements_guard() from public, anon, authenticated;

-- =============================================================================================
-- Concurrency message (§13)
-- =============================================================================================
create or replace function public.financial_statement_conflict(p_id uuid)
returns text
language sql
stable
security definer
set search_path = public, extensions
as $$
  select format(
    'USER: Changed by %s at %s. Reload to see their changes.',
    coalesce(p.full_name, 'someone else'),
    to_char(s.updated_at at time zone 'Asia/Kolkata', 'HH24:MI')
  )
  from public.financial_statements s
  left join public.profiles p on p.id = s.updated_by
  where s.id = p_id
    and public.is_staff()
    and public.can_see_client(s.client_id)
$$;

comment on function public.financial_statement_conflict(uuid) is
  'The concurrency refusal for a financial statement: who changed it last and when (§13).';

-- =============================================================================================
-- save_financial_statement(payload)
-- =============================================================================================
create or replace function public.save_financial_statement(p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_id uuid := nullif(p_payload->>'id', '')::uuid;
  v_expected timestamptz := nullif(p_payload->>'updated_at', '')::timestamptz;
  v_client uuid := nullif(p_payload->>'client_id', '')::uuid;
  v_fy text := nullif(btrim(coalesce(p_payload->>'financial_year', '')), '');
  v_doc uuid := nullif(p_payload->>'source_document_id', '')::uuid;
  v_prev uuid := nullif(p_payload->>'previous_statement_id', '')::uuid;
  v_row public.financial_statements%rowtype;
begin
  if not public.is_staff() then
    raise exception 'USER: Only the firm''s staff can prepare financial statements.' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_payload->'ledgers') is distinct from 'array' or jsonb_typeof(p_payload->'statements') is distinct from 'object' then
    raise exception 'USER: The statement has no trial balance to save.' using errcode = 'P0001';
  end if;
  if p_payload ? 'inputs' and jsonb_typeof(p_payload->'inputs') <> 'object' then
    raise exception 'USER: The statement''s inputs are not in the expected form.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_payload->'ledgers') > 20000 then
    raise exception 'USER: The trial balance has more than 20,000 ledgers.' using errcode = 'P0001';
  end if;

  if v_id is null then
    if v_client is null or not public.can_see_client(v_client)
       or not exists (select 1 from public.clients c where c.id = v_client and c.deleted_at is null) then
      raise exception 'USER: That client isn''t one of yours, or it is in the recycle bin.' using errcode = 'P0001';
    end if;
    if v_fy is null or not public.is_fy_label(v_fy) then
      raise exception 'USER: Choose the financial year.' using errcode = 'P0001';
    end if;
    if v_doc is not null and not exists (select 1 from public.documents d where d.id = v_doc and d.client_id = v_client) then
      raise exception 'USER: The trial balance isn''t in this client''s documents.' using errcode = 'P0001';
    end if;
    if v_prev is not null and not exists (select 1 from public.financial_statements s where s.id = v_prev and s.client_id = v_client and s.financial_year < v_fy) then
      raise exception 'USER: Comparatives come from this client''s statement of an earlier year.' using errcode = 'P0001';
    end if;
    begin
      insert into public.financial_statements (client_id, financial_year, ledgers, statements, inputs, source_document_id, previous_statement_id, created_by)
      values (v_client, v_fy, p_payload->'ledgers', p_payload->'statements', coalesce(p_payload->'inputs', '{}'::jsonb), v_doc, v_prev, auth.uid())
      returning * into v_row;
    exception when unique_violation then
      raise exception 'USER: This client already has a statement for FY %. Open it to upload a new trial balance.', v_fy using errcode = 'P0001';
    end;
  else
    select * into v_row from public.financial_statements s where s.id = v_id for update;
    if not found then
      raise exception 'USER: That statement no longer exists, or isn''t one of yours.' using errcode = 'P0001';
    end if;
    if v_expected is null or v_row.updated_at <> v_expected then
      raise exception '%', coalesce(public.financial_statement_conflict(v_id), 'USER: Changed by someone else. Reload to see their changes.') using errcode = 'P0001';
    end if;
    if v_doc is not null and not exists (select 1 from public.documents d where d.id = v_doc and d.client_id = v_row.client_id) then
      raise exception 'USER: The trial balance isn''t in this client''s documents.' using errcode = 'P0001';
    end if;
    if v_prev is not null and not exists (
      select 1 from public.financial_statements s where s.id = v_prev and s.client_id = v_row.client_id and s.financial_year < v_row.financial_year
    ) then
      raise exception 'USER: Comparatives come from this client''s statement of an earlier year.' using errcode = 'P0001';
    end if;
    update public.financial_statements s
    set ledgers = p_payload->'ledgers',
        statements = p_payload->'statements',
        inputs = coalesce(p_payload->'inputs', s.inputs),
        source_document_id = case when p_payload ? 'source_document_id' then v_doc else s.source_document_id end,
        previous_statement_id = case when p_payload ? 'previous_statement_id' then v_prev else s.previous_statement_id end
    where s.id = v_id
    returning * into v_row;
  end if;

  return jsonb_build_object('id', v_row.id, 'status', v_row.status, 'updated_at', v_row.updated_at, 'client_id', v_row.client_id, 'financial_year', v_row.financial_year);
end;
$$;

comment on function public.save_financial_statement(jsonb) is
  'Creates (as a draft) or updates a financial statement with the §13 concurrency check; the guard trigger enforces the workflow (§6.13, §7.8.3). Security invoker: RLS applies.';

-- =============================================================================================
-- set_financial_statement_status(id, updated_at, status, note)
-- =============================================================================================
create or replace function public.set_financial_statement_status(p_id uuid, p_updated_at timestamptz, p_status text, p_note text)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_row public.financial_statements%rowtype;
begin
  if not public.is_staff() then
    raise exception 'USER: Only the firm''s staff can review financial statements.' using errcode = 'P0001';
  end if;
  if p_status is null or p_status not in ('draft', 'reviewed', 'final') then
    raise exception 'USER: Choose Draft, Reviewed or Final.' using errcode = 'P0001';
  end if;
  if v_note is not null and char_length(v_note) > 1000 then
    raise exception 'USER: Keep the note under 1,000 characters.' using errcode = 'P0001';
  end if;

  select * into v_row from public.financial_statements s where s.id = p_id for update;
  if not found then
    raise exception 'USER: That statement no longer exists, or isn''t one of yours.' using errcode = 'P0001';
  end if;
  if p_updated_at is null or v_row.updated_at <> p_updated_at then
    raise exception '%', coalesce(public.financial_statement_conflict(p_id), 'USER: Changed by someone else. Reload to see their changes.') using errcode = 'P0001';
  end if;
  if v_row.status = p_status then
    raise exception 'USER: The statement is already %.', initcap(p_status) using errcode = 'P0001';
  end if;
  if p_status = 'draft' and v_note is null then
    raise exception 'USER: Say why it goes back to Draft, so the preparer knows what to change.' using errcode = 'P0001';
  end if;

  update public.financial_statements s
  set status = p_status,
      review_note = case when p_status = 'draft' then v_note else s.review_note end
  where s.id = p_id
  returning * into v_row;

  return jsonb_build_object('id', v_row.id, 'status', v_row.status, 'updated_at', v_row.updated_at, 'reviewed_at', v_row.reviewed_at, 'finalised_at', v_row.finalised_at);
end;
$$;

comment on function public.set_financial_statement_status(uuid, timestamptz, text, text) is
  'Moves a financial statement Draft → Reviewed → Final, or back to Draft with a note, after the §13 concurrency check; the guard trigger decides who may (§7.8.3).';

revoke execute on function
  public.financial_statement_conflict(uuid),
  public.save_financial_statement(jsonb),
  public.set_financial_statement_status(uuid, timestamptz, text, text)
from public, anon;
grant execute on function
  public.financial_statement_conflict(uuid),
  public.save_financial_statement(jsonb),
  public.set_financial_statement_status(uuid, timestamptz, text, text)
to authenticated, service_role;
