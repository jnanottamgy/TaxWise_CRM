-- 0211 · The recycle bin (§7.19, §0.1 rule 11, §6.8 retention).
--
--   recycle_bin_items (view, security_invoker)   every soft-deleted client, lead, quotation, invoice,
--       task and document, with who deleted it and when. Partners and Managers only (§4.1): each
--       branch also asks is_manager_or_partner(), so an Employee (whose RLS still shows the deleted
--       tasks and documents of their own clients) gets nothing here. A task, document or invoice that
--       went into the bin with its client (delete_client stamps one deleted_at on all of them, 0110)
--       is marked `with_client` and counted on the client's row instead of listed on its own.
--   recycle_bin_blockers(entity, id)   why a purge is refused, as a list of {code, message, until}:
--       documents kept by their retention_until (§6.8); issued invoices inside the GST record-keeping
--       period (72 months from the due date of the annual return for their FY, CGST Act s.36, the
--       due date moved by a recorded GSTR-9 extension); receipts and credit notes, which are never
--       deleted (0152, 0153); and, for a client, the registers kept with it (audit files under SA 230
--       and SQC 1, UDINs, filing history, engagement letters). Every period is a statutory parameter
--       (retention.*, seeded with §6.8); "today" is IST and the last day is still kept.
--   restore_deleted(entity, id, updated_at)   Partner / Manager (§4.1 "restore"): puts the item
--       back. A client brings back everything that went into the bin with it (its tasks, documents,
--       invoices and WhatsApp groups with the same deleted_at). A task, document or invoice whose
--       client is still in the bin, or a quotation whose lead or client is, waits for that first.
--       SECURITY INVOKER: RLS decides as for any other write.
--   purge_deleted(entity, id, updated_at)   Partner only, after the type-to-confirm in the UI:
--       deletes the item for good, with its children, once recycle_bin_blockers is empty. Returns the
--       storage paths of the files to remove from the vault (the server removes them after the
--       commit). SECURITY DEFINER (a client's registers sit in tables Partners don't delete from
--       directly) with the Partner check first; the document guards (retention, archived audit
--       files, 0121 and 0196) still run.
--
-- Both writes take the updated_at the caller loaded (optimistic concurrency, §13).

set search_path = public, extensions;

-- =============================================================================================
-- Retention dates (§6.8): kept until and including the returned date.
-- =============================================================================================
create or replace function public.retention_param_number(p_key text, p_on date, p_default numeric)
returns numeric
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select coalesce(public.jsonb_to_numeric(public.statutory_param_value(p_key, p_on)), p_default)
$$;

comment on function public.retention_param_number(text, date, numeric) is
  'A numeric retention parameter (statutory_parameters retention.*) in force on a date, or the §6.8 default.';

-- GST records: 72 months from the due date of the annual return for the FY (CGST Act s.36, s.44).
create or replace function public.gst_records_kept_until(p_fy text)
returns date
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  v_start int;
  v_due jsonb;
  v_month int;
  v_day int;
  v_offset int;
  v_year int;
  v_date date;
  v_months numeric;
begin
  if not coalesce(public.is_fy_label(p_fy), false) then
    return null;
  end if;
  v_start := left(p_fy, 4)::int;
  v_due := public.statutory_param_value('retention.gst_annual_return_due', make_date(v_start + 1, 3, 31));
  v_month := coalesce((v_due ->> 'month')::int, 12);
  v_day := coalesce((v_due ->> 'day')::int, 31);
  v_offset := coalesce((v_due ->> 'yearOffset')::int, 0);
  v_year := v_start + 1 + v_offset;
  v_date := (make_date(v_year, v_month, 1) + interval '1 month' - interval '1 day')::date;
  v_date := least(make_date(v_year, v_month, 1) + (v_day - 1), v_date);
  -- A recorded extension of the annual return (GSTR-9) moves the start of the period.
  select coalesce(max(o.extended_due), v_date) into v_date
  from public.due_date_overrides o
  where o.rule_code = 'GSTR9' and o.period_label in ('FY ' || p_fy, p_fy) and o.extended_due > v_date;
  v_months := public.retention_param_number('retention.gst_records_months', v_date, 72);
  return (v_date + make_interval(months => v_months::int))::date;
end;
$$;

comment on function public.gst_records_kept_until(text) is
  'GST records of an FY are kept until 72 months (retention.gst_records_months) after the annual return''s due date, or its recorded extension (CGST Act s.36, §6.8).';

-- Income-tax records: 6 years from the end of the relevant assessment year (Rule 6F(5), §6.8).
create or replace function public.income_tax_records_kept_until(p_fy text)
returns date
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select (make_date(left(p_fy, 4)::int + 2, 3, 31)
          + make_interval(years => public.retention_param_number('retention.income_tax_years_after_ay', make_date(left(p_fy, 4)::int + 2, 3, 31), 6)::int))::date
  where coalesce(public.is_fy_label(p_fy), false)
$$;

comment on function public.income_tax_records_kept_until(text) is
  'Income-tax records of an FY are kept until 6 years (retention.income_tax_years_after_ay) after the end of its assessment year (§6.8).';

-- Engagement documentation: 7 years from the auditor's report (SQC 1, §6.8).
create or replace function public.working_papers_kept_until(p_report_date date)
returns date
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select (p_report_date + make_interval(years => public.retention_param_number('retention.working_papers_years', p_report_date, 7)::int))::date
  where p_report_date is not null
$$;

comment on function public.working_papers_kept_until(date) is
  'Engagement documentation is kept until 7 years (retention.working_papers_years) after the report date (SQC 1, §6.8).';

-- =============================================================================================
-- recycle_bin_items
-- =============================================================================================
create or replace view public.recycle_bin_items with (security_invoker = true) as
select
  'client'::text as entity,
  c.id,
  c.display_name as title,
  c.client_code::text as reference,
  c.id as client_id,
  c.display_name as client_name,
  null::uuid as lead_id,
  c.deleted_at,
  c.deleted_by,
  p.full_name as deleted_by_name,
  c.updated_at,
  null::date as retention_until,
  false as with_client,
  false as parent_in_bin,
  (select count(*)::int from public.tasks t where t.client_id = c.id and t.deleted_at = c.deleted_at) as tasks_with,
  (select count(*)::int from public.documents d where d.client_id = c.id and d.deleted_at = c.deleted_at) as documents_with,
  (select count(*)::int from public.invoices i where i.client_id = c.id and i.deleted_at = c.deleted_at) as invoices_with
from public.clients c
left join public.profiles p on p.id = c.deleted_by
where c.deleted_at is not null
  and public.is_manager_or_partner()
union all
select
  'task',
  t.id,
  t.title,
  t.task_number,
  t.client_id,
  c.display_name,
  null::uuid,
  t.deleted_at,
  t.deleted_by,
  p.full_name,
  t.updated_at,
  null::date,
  (c.deleted_at is not null and c.deleted_at = t.deleted_at),
  (c.deleted_at is not null),
  0, 0, 0
from public.tasks t
join public.clients c on c.id = t.client_id
left join public.profiles p on p.id = t.deleted_by
where t.deleted_at is not null
  and public.is_manager_or_partner()
union all
select
  'document',
  d.id,
  d.title,
  d.file_name,
  d.client_id,
  c.display_name,
  null::uuid,
  d.deleted_at,
  d.deleted_by,
  p.full_name,
  d.updated_at,
  d.retention_until,
  (c.deleted_at is not null and c.deleted_at = d.deleted_at),
  (c.deleted_at is not null),
  0, 0, 0
from public.documents d
join public.clients c on c.id = d.client_id
left join public.profiles p on p.id = d.deleted_by
where d.deleted_at is not null
  and public.is_manager_or_partner()
union all
select
  'invoice',
  i.id,
  coalesce(i.invoice_number, case when i.invoice_kind = 'debit_note' then 'Draft debit note' else 'Draft invoice' end),
  i.billing_period_label,
  i.client_id,
  c.display_name,
  null::uuid,
  i.deleted_at,
  i.deleted_by,
  p.full_name,
  i.updated_at,
  null::date,
  (c.deleted_at is not null and c.deleted_at = i.deleted_at),
  (c.deleted_at is not null),
  0, 0, 0
from public.invoices i
join public.clients c on c.id = i.client_id
left join public.profiles p on p.id = i.deleted_by
where i.deleted_at is not null
  and public.is_manager_or_partner()
union all
select
  'lead',
  l.id,
  coalesce(nullif(l.company, ''), l.name),
  l.lead_number,
  null::uuid,
  null::text,
  l.id,
  l.deleted_at,
  l.deleted_by,
  p.full_name,
  l.updated_at,
  null::date,
  false,
  false,
  0, 0, 0
from public.leads l
left join public.profiles p on p.id = l.deleted_by
where l.deleted_at is not null
  and public.is_manager_or_partner()
union all
select
  'quotation',
  q.id,
  q.quotation_number,
  coalesce(nullif(q.client_company, ''), q.client_name),
  q.client_id,
  c.display_name,
  q.lead_id,
  q.deleted_at,
  q.deleted_by,
  p.full_name,
  q.updated_at,
  null::date,
  false,
  (coalesce(c.deleted_at, l.deleted_at) is not null),
  0, 0, 0
from public.quotations q
left join public.clients c on c.id = q.client_id
left join public.leads l on l.id = q.lead_id
left join public.profiles p on p.id = q.deleted_by
where q.deleted_at is not null
  and public.is_manager_or_partner();

comment on view public.recycle_bin_items is
  'Soft-deleted clients, tasks, documents, invoices, leads and quotations with who deleted them and when (§7.19). Partners and Managers only.';

revoke all on public.recycle_bin_items from anon, public;
revoke insert, update, delete, truncate, references, trigger on public.recycle_bin_items from authenticated;
grant select on public.recycle_bin_items to authenticated, service_role;

-- Partial indexes for the bin's own reads (soft-deleted rows only, so they stay small).
create index if not exists clients_deleted_idx on public.clients (deleted_at desc) where deleted_at is not null;
create index if not exists tasks_deleted_idx on public.tasks (client_id, deleted_at) where deleted_at is not null;
create index if not exists documents_deleted_idx on public.documents (client_id, deleted_at) where deleted_at is not null;
create index if not exists invoices_deleted_idx on public.invoices (client_id, deleted_at) where deleted_at is not null;
create index if not exists leads_deleted_idx on public.leads (deleted_at desc) where deleted_at is not null;
create index if not exists quotations_deleted_idx on public.quotations (deleted_at desc) where deleted_at is not null;

-- =============================================================================================
-- recycle_bin_blockers
-- =============================================================================================
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

  return v_out;
end;
$$;

comment on function public.recycle_bin_blockers(text, uuid) is
  'Why a purge from the recycle bin is refused: retention dates, the GST record-keeping period, receipts and credit notes, and a client''s registers (§6.8, §7.19). Empty = may be purged.';

-- =============================================================================================
-- Shared lookups
-- =============================================================================================
create or replace function public.recycle_bin_conflict(p_updated_at timestamptz, p_by uuid)
returns text
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select format('USER: Changed by %s at %s. Reload the recycle bin to see their changes.',
                coalesce((select p.full_name from public.profiles p where p.id = p_by), 'someone else'),
                to_char(p_updated_at at time zone 'Asia/Kolkata', 'HH24:MI'))
$$;

-- =============================================================================================
-- restore_deleted
-- =============================================================================================
create or replace function public.restore_deleted(p_entity text, p_id uuid, p_updated_at timestamptz)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_at timestamptz;
  v_updated timestamptz;
  v_by uuid;
  v_label text;
  v_client uuid;
  v_lead uuid;
  v_client_deleted timestamptz;
  v_client_name text;
  v_tasks int := 0;
  v_documents int := 0;
  v_invoices int := 0;
  v_groups int := 0;
begin
  if not public.is_manager_or_partner() then
    raise exception 'USER: Only Partners and Managers restore from the recycle bin.' using errcode = 'P0001';
  end if;
  if p_entity not in ('client', 'task', 'document', 'invoice', 'lead', 'quotation') then
    raise exception 'USER: That kind of record isn''t kept in the recycle bin.' using errcode = 'P0001';
  end if;

  if p_entity = 'client' then
    select c.deleted_at, c.updated_at, coalesce(c.updated_by, c.deleted_by), c.display_name || ' (' || c.client_code::text || ')'
      into v_at, v_updated, v_by, v_label
    from public.clients c where c.id = p_id for update;
    v_client := p_id;
  elsif p_entity = 'task' then
    select t.deleted_at, t.updated_at, t.deleted_by, t.task_number || ' · ' || t.title, t.client_id
      into v_at, v_updated, v_by, v_label, v_client
    from public.tasks t where t.id = p_id for update;
  elsif p_entity = 'document' then
    select d.deleted_at, d.updated_at, d.deleted_by, d.title, d.client_id
      into v_at, v_updated, v_by, v_label, v_client
    from public.documents d where d.id = p_id for update;
  elsif p_entity = 'invoice' then
    select i.deleted_at, i.updated_at, i.deleted_by, coalesce(i.invoice_number, 'the draft invoice'), i.client_id
      into v_at, v_updated, v_by, v_label, v_client
    from public.invoices i where i.id = p_id for update;
  elsif p_entity = 'lead' then
    select l.deleted_at, l.updated_at, l.deleted_by, coalesce(nullif(l.company, ''), l.name), l.id
      into v_at, v_updated, v_by, v_label, v_lead
    from public.leads l where l.id = p_id for update;
  else
    select q.deleted_at, q.updated_at, q.deleted_by, q.quotation_number, q.client_id, q.lead_id
      into v_at, v_updated, v_by, v_label, v_client, v_lead
    from public.quotations q where q.id = p_id for update;
  end if;

  if v_updated is null then
    raise exception 'USER: That record no longer exists. It may have been purged.' using errcode = 'P0001';
  end if;
  if v_at is null then
    raise exception 'USER: % isn''t in the recycle bin any more. Someone may have restored it already.', v_label using errcode = 'P0001';
  end if;
  if p_updated_at is null or date_trunc('milliseconds', v_updated) <> date_trunc('milliseconds', p_updated_at) then
    raise exception '%', public.recycle_bin_conflict(v_updated, v_by) using errcode = 'P0001';
  end if;

  -- Children wait for their parent.
  if p_entity in ('task', 'document', 'invoice', 'quotation') and v_client is not null then
    select c.deleted_at, c.display_name into v_client_deleted, v_client_name from public.clients c where c.id = v_client;
    if v_client_deleted is not null then
      raise exception 'USER: % is in the recycle bin. Restore the client first; what was deleted with it comes back too.', v_client_name
        using errcode = 'P0001';
    end if;
  end if;
  if p_entity = 'quotation' and v_lead is not null then
    select l.deleted_at, coalesce(nullif(l.company, ''), l.name) into v_client_deleted, v_client_name from public.leads l where l.id = v_lead;
    if v_client_deleted is not null then
      raise exception 'USER: Its lead % is in the recycle bin. Restore the lead first.', v_client_name using errcode = 'P0001';
    end if;
  end if;

  if p_entity = 'client' then
    update public.tasks set deleted_at = null, deleted_by = null where client_id = p_id and deleted_at = v_at;
    get diagnostics v_tasks = row_count;
    update public.documents set deleted_at = null, deleted_by = null where client_id = p_id and deleted_at = v_at;
    get diagnostics v_documents = row_count;
    update public.invoices set deleted_at = null, deleted_by = null where client_id = p_id and deleted_at = v_at;
    get diagnostics v_invoices = row_count;
    update public.client_whatsapp_groups set deleted_at = null where client_id = p_id and deleted_at = v_at;
    get diagnostics v_groups = row_count;
    update public.clients set deleted_at = null, deleted_by = null where id = p_id;
  elsif p_entity = 'task' then
    update public.tasks set deleted_at = null, deleted_by = null where id = p_id;
  elsif p_entity = 'document' then
    update public.documents set deleted_at = null, deleted_by = null where id = p_id;
  elsif p_entity = 'invoice' then
    update public.invoices set deleted_at = null, deleted_by = null where id = p_id;
  elsif p_entity = 'lead' then
    update public.leads set deleted_at = null, deleted_by = null where id = p_id;
  else
    update public.quotations set deleted_at = null, deleted_by = null where id = p_id;
  end if;

  return jsonb_build_object(
    'entity', p_entity,
    'id', p_id,
    'label', v_label,
    'client_id', v_client,
    'lead_id', v_lead,
    'deleted_at', v_at,
    'tasks', v_tasks,
    'documents', v_documents,
    'invoices', v_invoices,
    'whatsapp_groups', v_groups
  );
end;
$$;

comment on function public.restore_deleted(text, uuid, timestamptz) is
  'Partner/Manager: restores a record from the recycle bin; a client brings back everything deleted with it (§7.19). Optimistic concurrency on updated_at.';

-- =============================================================================================
-- purge_deleted
-- =============================================================================================
create or replace function public.purge_deleted(p_entity text, p_id uuid, p_updated_at timestamptz)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_at timestamptz;
  v_updated timestamptz;
  v_by uuid;
  v_label text;
  v_client uuid;
  v_lead uuid;
  v_blockers jsonb;
  v_paths text[] := '{}';
  v_counts jsonb := '{}'::jsonb;
  v_n int;
begin
  if not public.is_partner() then
    raise exception 'USER: Only a Partner can purge from the recycle bin.' using errcode = 'P0001';
  end if;
  if p_entity not in ('client', 'task', 'document', 'invoice', 'lead', 'quotation') then
    raise exception 'USER: That kind of record isn''t kept in the recycle bin.' using errcode = 'P0001';
  end if;

  if p_entity = 'client' then
    select c.deleted_at, c.updated_at, coalesce(c.updated_by, c.deleted_by), c.display_name || ' (' || c.client_code::text || ')', c.id
      into v_at, v_updated, v_by, v_label, v_client
    from public.clients c where c.id = p_id for update;
  elsif p_entity = 'task' then
    select t.deleted_at, t.updated_at, t.deleted_by, t.task_number || ' · ' || t.title, t.client_id
      into v_at, v_updated, v_by, v_label, v_client
    from public.tasks t where t.id = p_id for update;
  elsif p_entity = 'document' then
    select d.deleted_at, d.updated_at, d.deleted_by, d.title, d.client_id
      into v_at, v_updated, v_by, v_label, v_client
    from public.documents d where d.id = p_id for update;
  elsif p_entity = 'invoice' then
    select i.deleted_at, i.updated_at, i.deleted_by, coalesce(i.invoice_number, 'the draft invoice'), i.client_id
      into v_at, v_updated, v_by, v_label, v_client
    from public.invoices i where i.id = p_id for update;
  elsif p_entity = 'lead' then
    select l.deleted_at, l.updated_at, l.deleted_by, coalesce(nullif(l.company, ''), l.name), l.id
      into v_at, v_updated, v_by, v_label, v_lead
    from public.leads l where l.id = p_id for update;
  else
    select q.deleted_at, q.updated_at, q.deleted_by, q.quotation_number, q.client_id, q.lead_id
      into v_at, v_updated, v_by, v_label, v_client, v_lead
    from public.quotations q where q.id = p_id for update;
  end if;

  if v_updated is null then
    raise exception 'USER: That record no longer exists. It may have been purged already.' using errcode = 'P0001';
  end if;
  if v_at is null then
    raise exception 'USER: % isn''t in the recycle bin, so it can''t be purged. Delete it first.', v_label using errcode = 'P0001';
  end if;
  if p_updated_at is null or date_trunc('milliseconds', v_updated) <> date_trunc('milliseconds', p_updated_at) then
    raise exception '%', public.recycle_bin_conflict(v_updated, v_by) using errcode = 'P0001';
  end if;

  v_blockers := public.recycle_bin_blockers(p_entity, p_id);
  if jsonb_array_length(v_blockers) > 0 then
    raise exception 'USER: % can''t be purged yet. %', v_label,
      (select string_agg(b ->> 'message', ' ' order by ord) from jsonb_array_elements(v_blockers) with ordinality as x(b, ord))
      using errcode = 'P0001';
  end if;

  if p_entity = 'document' then
    select array_remove(array[d.storage_path], null) || coalesce((select array_agg(v.storage_path) from public.document_versions v where v.document_id = d.id), '{}')
      into v_paths
    from public.documents d where d.id = p_id;
    delete from public.documents where id = p_id;
  elsif p_entity = 'invoice' then
    delete from public.invoices where id = p_id;
  elsif p_entity = 'task' then
    delete from public.tasks where id = p_id;
  elsif p_entity = 'lead' then
    delete from public.leads where id = p_id;
  elsif p_entity = 'quotation' then
    delete from public.quotations where id = p_id;
  else
    -- A client: the files of every document and version first, then the rows that refer to the
    -- client without cascading (registers and money, all past their retention by now), then the
    -- client, which cascades to the rest of its rows.
    select coalesce(array_agg(x.path), '{}') into v_paths
    from (
      select d.storage_path as path from public.documents d where d.client_id = p_id
      union
      select v.storage_path from public.document_versions v join public.documents d on d.id = v.document_id where d.client_id = p_id
    ) x
    where x.path is not null;

    update public.documents set deleted_at = coalesce(deleted_at, v_at) where client_id = p_id and deleted_at is null;
    delete from public.documents where client_id = p_id;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object('documents', v_n);

    delete from public.invoices where client_id = p_id and original_invoice_id is not null;
    delete from public.invoices where client_id = p_id;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object('invoices', v_n);

    update public.audit_engagements set udin_record_id = null where client_id = p_id and udin_record_id is not null;
    delete from public.audit_engagements where client_id = p_id;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object('audit_engagements', v_n);
    delete from public.udin_records where client_id = p_id;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object('udin_records', v_n);
    delete from public.filing_records where client_id = p_id;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object('filing_records', v_n);
    delete from public.engagement_letters where client_id = p_id;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object('engagement_letters', v_n);

    select count(*) into v_n from public.tasks where client_id = p_id;
    v_counts := v_counts || jsonb_build_object('tasks', v_n);
    delete from public.clients where id = p_id;
  end if;

  return jsonb_build_object(
    'entity', p_entity,
    'id', p_id,
    'label', v_label,
    'client_id', case when p_entity = 'client' then null else v_client end,
    'lead_id', case when p_entity = 'lead' then null else v_lead end,
    'storage_paths', to_jsonb(v_paths),
    'counts', v_counts
  );
end;
$$;

comment on function public.purge_deleted(text, uuid, timestamptz) is
  'Partner only: deletes a recycle-bin record for good once recycle_bin_blockers is empty (§7.19, §6.8). Returns the storage paths to remove from the vault.';

-- =============================================================================================
-- Grants
-- =============================================================================================
revoke execute on function
  public.retention_param_number(text, date, numeric),
  public.gst_records_kept_until(text),
  public.income_tax_records_kept_until(text),
  public.working_papers_kept_until(date),
  public.recycle_bin_blockers(text, uuid),
  public.recycle_bin_conflict(timestamptz, uuid),
  public.restore_deleted(text, uuid, timestamptz),
  public.purge_deleted(text, uuid, timestamptz)
from public, anon;
grant execute on function
  public.retention_param_number(text, date, numeric),
  public.gst_records_kept_until(text),
  public.income_tax_records_kept_until(text),
  public.working_papers_kept_until(date),
  public.recycle_bin_blockers(text, uuid),
  public.recycle_bin_conflict(timestamptz, uuid),
  public.restore_deleted(text, uuid, timestamptz),
  public.purge_deleted(text, uuid, timestamptz)
to authenticated, service_role;
