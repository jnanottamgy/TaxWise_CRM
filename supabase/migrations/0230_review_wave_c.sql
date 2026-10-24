-- 0230 · Review of wave C (§4.1, §6.8, §7.15, §7.19). Fixes found in the adversarial review:
--
--   1. Engagement documents never reach Employees (§4.1 "Fees, engagement terms … never, anywhere";
--      "Engagement letters … Employee ❌"). A signed engagement letter is filed in the client's
--      document vault (category 'engagement', linked from engagement_letters.document_id) and carries
--      the fee schedule; the vault showed it to every Employee on the client's team. Now:
--        is_engagement_document(id, category)   'engagement' category, or the signed copy of a letter
--        documents_select_staff / _update_staff  Employees see and change only other documents
--        staff_document_ids() / can_see_document  the same rule for versions, tags and activities
--        client_documents_read (storage)          the file itself is refused to an Employee too
--        documents_engagement_category guard      an Employee can't file (or re-file) a document
--                                                 under 'engagement'; it would vanish from them
--   2. The recycle bin's client purge (§7.19, §6.8) deleted the client's workpapers (ITR
--      computations, financial statements, GST reconciliations, notices) by cascade without asking
--      their retention. recycle_bin_blockers now keeps a client while any of them is inside its
--      record-keeping period: ITR computations the income-tax records period of their FY, GST
--      reconciliations the GST records period of their month's FY, financial statements 7 years from
--      the year end (SQC 1), notices 7 years from closing (or from the notice while open).
--   3. A Form 26 UDIN's ceiling count follows its s.44AB-equivalent category (§6.8): (a), (b) and
--      combined count, (c), (d) and (e) don't, from audit.tax_audit_form26_categories. The derive
--      trigger used to keep whatever the writer sent, so a direct write could count a (c) report.
--   4. "UDIN add if signing staff" (§4.1): an Employee may log a UDIN only when their profile has an
--      ICAI membership number (they sign as a member), as the server action already requires.
--   5. compliance_agenda takes p_pending_only, so the dashboard's "Filings due in 7 days" opens the
--      agenda with exactly the deadlines it counts (not yet filed), not the filed ones as well.
--
-- Stamps schema_version 0230 (EXPECTED_SCHEMA_VERSION in lib/env.ts).

set search_path = public, extensions;

-- =============================================================================================
-- 1. Engagement documents are Partner / Manager only
-- =============================================================================================
create or replace function public.is_engagement_document(p_id uuid, p_category public.document_category)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select coalesce(p_category = 'engagement', false)
      or exists (select 1 from public.engagement_letters l where l.document_id = p_id)
$$;

comment on function public.is_engagement_document(uuid, public.document_category) is
  'True for an engagement document: category engagement, or the signed copy of an engagement letter. Partners and Managers only (§4.1).';

create index if not exists engagement_letters_document_idx on public.engagement_letters (document_id) where document_id is not null;
create index if not exists document_versions_storage_path_idx on public.document_versions (storage_path);

-- The storage object of an engagement document (current file or an earlier version).
create or replace function public.storage_object_is_engagement_document(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1 from public.documents d
    where d.storage_path in (p_name, 'client-documents/' || p_name) and public.is_engagement_document(d.id, d.category)
  ) or exists (
    select 1 from public.document_versions v
    join public.documents d on d.id = v.document_id
    where v.storage_path in (p_name, 'client-documents/' || p_name) and public.is_engagement_document(d.id, d.category)
  )
$$;

comment on function public.storage_object_is_engagement_document(text) is
  'True when a client-documents object is the file (or an earlier version) of an engagement document (§4.1).';

create or replace function public.staff_document_ids()
returns setof uuid
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  if public.is_manager_or_partner() then
    return query select d.id from public.documents d;
  elsif public.is_staff() then
    return query
      select d.id from public.documents d
      where d.client_id in (select public.staff_client_ids())
        and not public.is_engagement_document(d.id, d.category);
  end if;
end;
$$;

comment on function public.staff_document_ids() is
  'Documents the calling staff member can see: every one for Partners and Managers; an Employee their clients'' documents except engagement documents (§4.1, §4.6).';

create or replace function public.can_see_document(did uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select did is not null and (
    (public.is_staff() and exists (
      select 1 from public.documents d
      where d.id = did
        and public.can_see_client(d.client_id)
        and (public.is_manager_or_partner() or not public.is_engagement_document(d.id, d.category))
    ))
    or (public.is_client() and did in (select public.portal_document_ids()))
  )
$$;

comment on function public.can_see_document(uuid) is
  'Staff: the document''s client is visible (engagement documents for Partners and Managers only). Client: portal_document_ids() (§4.1, §4.6, §7.22).';

drop policy if exists documents_select_staff on public.documents;
create policy documents_select_staff on public.documents
  for select to authenticated
  using (
    (select public.is_manager_or_partner())
    or (client_id in (select public.staff_client_ids()) and not public.is_engagement_document(id, category))
  );

drop policy if exists documents_update_staff on public.documents;
create policy documents_update_staff on public.documents
  for update to authenticated
  using (
    (select public.is_manager_or_partner())
    or (client_id in (select public.staff_client_ids()) and not public.is_engagement_document(id, category))
  )
  with check (
    (select public.is_manager_or_partner())
    or (client_id in (select public.staff_client_ids()) and not public.is_engagement_document(id, category))
  );

drop policy if exists client_documents_read on storage.objects;
create policy client_documents_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'client-documents'
    and (
      (
        public.is_staff()
        and public.can_see_client(public.storage_first_folder_uuid(name))
        and (public.is_manager_or_partner() or not public.storage_object_is_engagement_document(name))
      )
      or public.portal_can_read_object(name)
    )
  );

-- An Employee can't file a document under 'engagement' (it would disappear from them at once, and
-- engagement papers are kept by Partners and Managers). Jobs and the service role have no app role.
create or replace function public.documents_engagement_category_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if new.category = 'engagement'
     and (tg_op = 'INSERT' or old.category is distinct from new.category)
     and public.app_role() = 'employee' then
    raise exception 'USER: Engagement documents (letters, acceptance papers) are kept by Partners and Managers. Choose another category.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

comment on function public.documents_engagement_category_guard() is
  'Trigger: an Employee can''t file a document (or a pending upload) under the engagement category (§4.1).';

drop trigger if exists documents_engagement_category_guard on public.documents;
create trigger documents_engagement_category_guard
  before insert or update of category on public.documents
  for each row execute function public.documents_engagement_category_guard();

drop trigger if exists document_uploads_engagement_category_guard on public.document_uploads;
create trigger document_uploads_engagement_category_guard
  before insert or update of category on public.document_uploads
  for each row execute function public.documents_engagement_category_guard();

revoke execute on function public.documents_engagement_category_guard() from public, anon, authenticated;
revoke execute on function
  public.is_engagement_document(uuid, public.document_category),
  public.storage_object_is_engagement_document(text),
  public.staff_document_ids(),
  public.can_see_document(uuid)
from public, anon;
grant execute on function
  public.is_engagement_document(uuid, public.document_category),
  public.storage_object_is_engagement_document(text),
  public.staff_document_ids(),
  public.can_see_document(uuid)
to authenticated, service_role;

-- =============================================================================================
-- 2. recycle_bin_blockers: a client's workpapers are kept for their record-keeping period
-- =============================================================================================
-- The FY of a GST reconciliation's month (period MMYYYY).
create or replace function public.gst_recon_period_fy(p_period text)
returns text
language sql
immutable
set search_path = public, extensions
as $$
  select case
    when p_period ~ '^(0[1-9]|1[0-2])[0-9]{4}$' then public.financial_year_label(make_date(substr(p_period, 3, 4)::int, substr(p_period, 1, 2)::int, 1))
  end
$$;

comment on function public.gst_recon_period_fy(text) is 'The financial year of a GST return period written MMYYYY (092026 → 2026-27).';

create or replace function public.recycle_bin_blockers(p_entity text, p_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  v_today date := public.today_ist();
  v_out jsonb := '[]'::jsonb;
  v_n int;
  v_m int;
  v_until date;
  v_text text;
  v_doc public.documents%rowtype;
  v_inv public.invoices%rowtype;
  v_kinds text[];
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: The recycle bin is for Partners and Managers.' using errcode = 'P0001';
  end if;

  if p_entity = 'document' then
    select * into v_doc from public.documents where id = p_id;
    if not found then
      return v_out;
    end if;
    if v_doc.retention_until is null then
      v_out := v_out || jsonb_build_array(jsonb_build_object('code', 'no_retention_date', 'message',
        'This document has no retention date, so it can''t be purged. Set one first.'));
    elsif v_doc.retention_until >= v_today then
      v_out := v_out || jsonb_build_array(jsonb_build_object('code', 'retention', 'until', v_doc.retention_until, 'message',
        format('This document must be kept until %s under the retention rules.', to_char(v_doc.retention_until, 'DD Mon YYYY'))));
    end if;
    return v_out;
  end if;

  if p_entity = 'invoice' then
    select * into v_inv from public.invoices where id = p_id;
    if not found then
      return v_out;
    end if;
    if v_inv.invoice_number is not null then
      v_until := public.gst_records_kept_until(public.financial_year_label(v_inv.issue_date));
      if v_until >= v_today then
        v_out := v_out || jsonb_build_array(jsonb_build_object('code', 'gst_records', 'until', v_until, 'message',
          format('%s is a GST record of FY %s and must be kept until %s (CGST Act s.36: 72 months from the annual return''s due date).',
                 v_inv.invoice_number, public.financial_year_label(v_inv.issue_date), to_char(v_until, 'DD Mon YYYY'))));
      end if;
    end if;
    if exists (select 1 from public.payment_receipts r where r.invoice_id = p_id)
       or exists (select 1 from public.credit_notes n where n.invoice_id = p_id) then
      v_out := v_out || jsonb_build_array(jsonb_build_object('code', 'settlements', 'message',
        'Receipts or credit notes are recorded against it. They are never deleted, so the invoice stays on record.'));
    end if;
    select string_agg(coalesce(d.invoice_number, 'a draft'), ', ' order by d.issue_date) into v_text
    from public.invoices d where d.original_invoice_id = p_id;
    if v_text is not null then
      v_out := v_out || jsonb_build_array(jsonb_build_object('code', 'debit_notes', 'message',
        format('Debit notes refer to it (%s).', v_text)));
    end if;
    return v_out;
  end if;

  if p_entity <> 'client' then
    -- Leads, quotations and tasks carry no retention rule of their own.
    return v_out;
  end if;

  -- ---------------------------------------------------------------------------------------------
  -- A client: everything that would go with it.
  -- ---------------------------------------------------------------------------------------------
  select count(*) filter (where d.retention_until >= v_today), max(d.retention_until) filter (where d.retention_until >= v_today),
         count(*) filter (where d.retention_until is null)
    into v_n, v_until, v_m
  from public.documents d where d.client_id = p_id;
  if v_n > 0 then
    v_out := v_out || jsonb_build_array(jsonb_build_object('code', 'documents_retention', 'until', v_until, 'message',
      format('%s of its documents must be kept until %s under the retention rules.',
             case when v_n = 1 then 'One' else v_n::text end, to_char(v_until, 'DD Mon YYYY'))));
  end if;
  if v_m > 0 then
    v_out := v_out || jsonb_build_array(jsonb_build_object('code', 'documents_no_retention_date', 'message',
      format('%s of its documents %s no retention date. Set one on each first.',
             case when v_m = 1 then 'One' else v_m::text end, case when v_m = 1 then 'has' else 'have' end)));
  end if;

  select count(*) into v_n
  from public.invoices i
  where i.client_id = p_id
    and (exists (select 1 from public.payment_receipts r where r.invoice_id = i.id)
         or exists (select 1 from public.credit_notes n where n.invoice_id = i.id));
  if v_n > 0 then
    v_out := v_out || jsonb_build_array(jsonb_build_object('code', 'settlements', 'message',
      format('%s of its invoices %s receipts or credit notes, which are never deleted.',
             case when v_n = 1 then 'One' else v_n::text end, case when v_n = 1 then 'has' else 'have' end)));
  end if;

  select max(public.gst_records_kept_until(public.financial_year_label(i.issue_date))) into v_until
  from public.invoices i
  where i.client_id = p_id and i.invoice_number is not null;
  if v_until >= v_today then
    v_out := v_out || jsonb_build_array(jsonb_build_object('code', 'gst_records', 'until', v_until, 'message',
      format('Its invoices are GST records and must be kept until %s (CGST Act s.36).', to_char(v_until, 'DD Mon YYYY'))));
  end if;

  select count(*), string_agg(distinct e.financial_year, ', ') into v_n, v_text
  from public.audit_engagements e where e.client_id = p_id and e.archived_at is not null;
  if v_n > 0 then
    v_out := v_out || jsonb_build_array(jsonb_build_object('code', 'audit_archived', 'message',
      format('Its archived audit %s for FY %s %s read-only (SA 230).', case when v_n = 1 then 'file' else 'files' end, v_text, case when v_n = 1 then 'is' else 'are' end)));
  end if;
  select max(coalesce(e.retain_until, public.working_papers_kept_until(e.report_date), public.working_papers_kept_until(public.fy_end_date(e.financial_year)))) into v_until
  from public.audit_engagements e
  where e.client_id = p_id and e.archived_at is null and e.stage <> 'acceptance';
  if v_until >= v_today then
    v_out := v_out || jsonb_build_array(jsonb_build_object('code', 'audit_working_papers', 'until', v_until, 'message',
      format('Its audit working papers must be kept until %s (SQC 1).', to_char(v_until, 'DD Mon YYYY'))));
  end if;

  select max(public.working_papers_kept_until(u.signed_on)) into v_until
  from public.udin_records u where u.client_id = p_id;
  if v_until >= v_today then
    v_out := v_out || jsonb_build_array(jsonb_build_object('code', 'udin_register', 'until', v_until, 'message',
      format('Its UDIN register entries must be kept until %s (SQC 1).', to_char(v_until, 'DD Mon YYYY'))));
  end if;

  select max(greatest(public.gst_records_kept_until(f.financial_year), public.income_tax_records_kept_until(f.financial_year))) into v_until
  from public.filing_records f where f.client_id = p_id;
  if v_until >= v_today then
    v_out := v_out || jsonb_build_array(jsonb_build_object('code', 'filing_history', 'until', v_until, 'message',
      format('Its filing history must be kept until %s under the tax record-keeping rules.', to_char(v_until, 'DD Mon YYYY'))));
  end if;

  select max(public.working_papers_kept_until(public.fy_end_date(l.financial_year))) into v_until
  from public.engagement_letters l where l.client_id = p_id;
  if v_until >= v_today then
    v_out := v_out || jsonb_build_array(jsonb_build_object('code', 'engagement_letters', 'until', v_until, 'message',
      format('Its engagement letters must be kept until %s (SQC 1).', to_char(v_until, 'DD Mon YYYY'))));
  end if;

  -- Workpapers (§7.8): each kept for the record-keeping period of what it works on.
  with kept as (
    select 'ITR computations' as kind, public.income_tax_records_kept_until(t.financial_year) as until
    from public.itr_computations t where t.client_id = p_id
    union all
    select 'financial statements', public.working_papers_kept_until(public.fy_end_date(s.financial_year))
    from public.financial_statements s where s.client_id = p_id
    union all
    select 'GST reconciliations', public.gst_records_kept_until(public.gst_recon_period_fy(r.period))
    from public.gst_recon_runs r where r.client_id = p_id
    union all
    select 'notices', public.working_papers_kept_until(coalesce((n.closed_at at time zone 'Asia/Kolkata')::date, n.notice_date, (n.created_at at time zone 'Asia/Kolkata')::date))
    from public.tax_notices n where n.client_id = p_id
  )
  select max(k.until), array_agg(distinct k.kind order by k.kind) into v_until, v_kinds
  from kept k where k.until >= v_today;
  if v_until is not null then
    v_out := v_out || jsonb_build_array(jsonb_build_object('code', 'workpapers', 'until', v_until, 'message',
      format('Its workpapers (%s) must be kept until %s under the record-keeping rules.', array_to_string(v_kinds, ', '), to_char(v_until, 'DD Mon YYYY'))));
  end if;

  return v_out;
end;
$$;

comment on function public.recycle_bin_blockers(text, uuid) is
  'Why a purge from the recycle bin is refused: retention dates, the GST record-keeping period, receipts and credit notes, and a client''s registers and workpapers (§6.8, §7.19). Empty = may be purged.';

revoke execute on function public.gst_recon_period_fy(text), public.recycle_bin_blockers(text, uuid) from public, anon;
grant execute on function public.gst_recon_period_fy(text), public.recycle_bin_blockers(text, uuid) to authenticated, service_role;

-- =============================================================================================
-- 3. udin_records_derive: a Form 26 report counts by its category
-- =============================================================================================
create or replace function public.udin_records_derive()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_counted jsonb;
begin
  new.udin := nullif(upper(btrim(new.udin::text)), '');
  if new.report_form = 'FORM_26' and new.form26_category is not null then
    v_counted := public.statutory_param_value('audit.tax_audit_form26_categories', coalesce(new.signed_on, public.today_ist())) -> 'counted';
    if v_counted is null or jsonb_typeof(v_counted) <> 'array' then
      v_counted := '["a", "b", "combined"]'::jsonb;
    end if;
  end if;
  new.counts_towards_tax_audit_ceiling := case
    when new.is_revised then false
    when new.report_form in ('3CA', '3CB_44AB_a', '3CB_44AB_b', '3CB_combined') then true
    when new.report_form = 'FORM_26' and new.form26_category is not null then v_counted ? new.form26_category
    when new.report_form = 'FORM_26' then coalesce(new.counts_towards_tax_audit_ceiling, true)
    when new.report_form is null then null
    else false
  end;
  return new;
end;
$$;

comment on function public.udin_records_derive() is
  'Trigger: UDIN upper-case (§6.2); counts_towards_tax_audit_ceiling from the report form, and for Form 26 from its s.44AB-equivalent category (audit.tax_audit_form26_categories) (§6.8).';

-- =============================================================================================
-- 4. udin_records_insert: an Employee logs a UDIN only as a member who signs
-- =============================================================================================
create or replace function public.is_signing_member()
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.is_active
      and (p.role = 'partner' or nullif(btrim(p.icai_membership_no), '') is not null)
  )
$$;

comment on function public.is_signing_member() is
  'True when the caller signs reports as an ICAI member: a Partner, or staff with a membership number on their profile (§4.1 "UDIN add if signing staff").';

revoke execute on function public.is_signing_member() from public, anon;
grant execute on function public.is_signing_member() to authenticated, service_role;

drop policy if exists udin_records_insert on public.udin_records;
create policy udin_records_insert on public.udin_records
  for insert to authenticated
  with check (
    (select public.is_manager_or_partner())
    or (
      (select public.is_staff())
      and (select public.is_signing_member())
      and signing_partner_id = (select auth.uid())
      and (client_id is null or client_id in (select public.staff_client_ids()))
    )
  );

-- =============================================================================================
-- 5. compliance_agenda: "not yet filed" (the Partner dashboard's "Filings due in 7 days" opens the
--    agenda with exactly the deadlines it counts, §7.2 "every tile links to the filtered list")
-- =============================================================================================
drop function if exists public.compliance_agenda(date, date, uuid, uuid, public.compliance_type[], boolean, text, boolean, int, int);

create or replace function public.compliance_agenda(
  p_from date,
  p_to date default null,
  p_client uuid default null,
  p_owner uuid default null,
  p_types public.compliance_type[] default null,
  p_statutory boolean default null,
  p_label text default null,
  p_overdue_only boolean default false,
  p_limit int default 25,
  p_offset int default 0,
  p_pending_only boolean default false
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  v_today date := public.today_ist();
  v_limit int := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_total int;
  v_rows jsonb;
begin
  if not public.is_staff() then
    raise exception 'USER: The calendar is for staff.' using errcode = 'P0001';
  end if;
  if p_from is null and not coalesce(p_overdue_only, false) then
    raise exception 'USER: Choose the first date to show.' using errcode = 'P0001';
  end if;

  with ev as (
    select e.id, e.client_id, e.type, e.form_code, e.title, e.financial_year, e.filing_period, e.due_date,
           e.status, e.workflow_status, e.is_statutory, e.source, e.rule_code, e.original_due_date,
           e.override_id, e.task_id, e.is_provisional, e.updated_at,
           c.display_name as client_name, c.client_code, c.owner_employee_id,
           (select o.source_ref from public.due_date_overrides o where o.id = e.override_id) as override_ref,
           exists (select 1 from public.filing_records fr where fr.compliance_event_id = e.id) as has_filing
      from public.compliance_events e
      left join public.clients c on c.id = e.client_id
     where e.status <> 'cancelled'
       and (e.client_id is null or c.deleted_at is null)
       and (
         case when coalesce(p_overdue_only, false)
           then e.status = 'pending' and e.workflow_status not in ('filed', 'completed') and e.due_date < v_today
                and (p_from is null or e.due_date >= p_from)
           else e.due_date >= p_from and (p_to is null or e.due_date <= p_to)
         end
       )
       and (not coalesce(p_pending_only, false) or (e.status = 'pending' and e.workflow_status not in ('filed', 'completed')))
       and (p_client is null or e.client_id = p_client)
       and (p_owner is null or c.owner_employee_id = p_owner)
       and (p_types is null or e.type = any (p_types))
       and (p_statutory is null or e.is_statutory = p_statutory)
       and (p_label is null or coalesce(nullif(e.form_code, ''), regexp_replace(e.title, '\s+for\s+.+$', '')) = p_label)
  ),
  page as (
    select * from ev order by due_date, client_name nulls first, title limit v_limit offset v_offset
  )
  select
    (select count(*)::int from ev),
    coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'client_id', p.client_id, 'client_name', p.client_name, 'client_code', p.client_code,
               'owner_employee_id', p.owner_employee_id, 'owner_name', d.full_name,
               'type', p.type, 'form_code', p.form_code, 'title', p.title, 'financial_year', p.financial_year,
               'filing_period', p.filing_period, 'due_date', p.due_date, 'status', p.status,
               'workflow_status', p.workflow_status, 'is_statutory', p.is_statutory, 'source', p.source,
               'rule_code', p.rule_code, 'original_due_date', p.original_due_date, 'override_id', p.override_id,
               'override_ref', p.override_ref, 'task_id', p.task_id, 'is_provisional', p.is_provisional,
               'has_filing', p.has_filing, 'updated_at', p.updated_at
             ) order by p.due_date, p.client_name nulls first, p.title)
        from page p
        left join public.employee_directory d on d.id = p.owner_employee_id
    ), '[]'::jsonb)
    into v_total, v_rows;

  return jsonb_build_object('today', v_today, 'total', coalesce(v_total, 0), 'rows', v_rows);
end;
$$;

comment on function public.compliance_agenda(date, date, uuid, uuid, public.compliance_type[], boolean, text, boolean, int, int, boolean) is
  'Calendar agenda (§7.7): one row per deadline from a date (or the unfiled overdue ones; or, with p_pending_only, only those not yet filed), filtered and paginated in SQL, under RLS.';

revoke all on function public.compliance_agenda(date, date, uuid, uuid, public.compliance_type[], boolean, text, boolean, int, int, boolean) from public, anon;
grant execute on function public.compliance_agenda(date, date, uuid, uuid, public.compliance_type[], boolean, text, boolean, int, int, boolean) to authenticated;

-- =============================================================================================
-- Views stay SELECT-only for the API roles (as 0229); schema version
-- =============================================================================================
do $$
declare
  r record;
begin
  for r in
    select c.oid::regclass as rel
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('v', 'm')
  loop
    execute format('revoke insert, update, delete, truncate, references, trigger on %s from public, anon, authenticated', r.rel);
    execute format('revoke all on %s from anon', r.rel);
  end loop;
end;
$$;

insert into public.app_meta (key, value) values ('schema_version', '0230')
on conflict (key) do update set value = excluded.value;
