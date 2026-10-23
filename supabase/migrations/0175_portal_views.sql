-- 0175 · The client portal's windows onto compliance, filings and its message thread (§4.6, §7.22,
-- §18.3 Client 2 and 6). Requested by the security review of the portal.
--
--   portal_compliance_events  the signed-in client's statutory deadlines (is_statutory: the firm's
--                             internal prep steps never show), with the derived overdue state, a
--                             coarse `progress` the client can act on, the extension that moved the
--                             date, and the filing that closed it (filed on, acknowledgement number,
--                             and the acknowledgement document only when the firm marked it
--                             shareable_with_client). No staff notes, no workflow internals (the
--                             raw workflow_status, reminder bookkeeping, generator keys, rule codes)
--                             and no task ids.
--   portal_filing_records     what was filed for the client, by the firm or a previous CA: form,
--                             period, filed on and the acknowledgement number. §7.22 "filing status
--                             by period, with acknowledgement numbers (downloadable acknowledgements
--                             when the firm marks them shareable)": the number is the client's own
--                             filing fact; the acknowledgement document id is exposed only when
--                             shareable_with_client (0007: "acknowledgements downloadable in the
--                             portal"). No notes, task ids or who recorded it.
--   portal_messages           the client's portal thread (§7.22 Messages): both directions, the
--                             firm's sender by name, read receipts. Never WhatsApp hand-offs,
--                             internal notes or call logs (§7.25), and no template, provider or
--                             related-record ids.
--
-- Every view is security_invoker = false + security_barrier = true with its own row filter
-- (public.is_client() and clients.portal_user_id = auth.uid() and the client isn't deleted), the
-- same pattern as portal_invoices (0034): is_client() requires app_metadata.role = 'client' AND a
-- matching active profile, so a role claim in user_metadata, a JWT whose role doesn't match the
-- profile, or a disabled portal login sees nothing (§0.1 rule 9, §18.3 Client 6). SELECT only for
-- authenticated (0043), nothing for anon.
--
-- The client-role SELECT policies on the base tables compliance_events and filing_records are
-- dropped, so the portal reads compliance only through these views. Nothing in the app read those
-- tables as a portal user (the compliance report route refuses clients); portal_document_ids() and
-- portal_linked_document_ids() (0037) read filing_records as security definer and are unaffected.

set search_path = public, extensions;

-- =============================================================================================
-- portal_compliance_events
-- =============================================================================================
create or replace view public.portal_compliance_events with (security_invoker = false, security_barrier = true) as
select
  e.id,
  e.client_id,
  e.type,
  e.form_code,
  e.title,
  e.description,
  e.financial_year,
  e.filing_period,
  e.period_start,
  e.period_end,
  e.due_date,
  e.original_due_date,
  (e.original_due_date is not null and e.due_date > e.original_due_date) as is_extended,
  o.source_ref as extension_ref,
  e.is_provisional,
  e.status,
  e.completed_at,
  (e.status = 'pending' and e.due_date < public.today_ist()) as is_overdue,
  case when e.status = 'pending' and e.due_date < public.today_ist() then public.today_ist() - e.due_date else 0 end as days_overdue,
  e.due_date - public.today_ist() as days_until_due,
  -- What the client can act on, without the firm's internal steps (§7.22).
  case
    when e.status = 'cancelled' then 'cancelled'
    when e.status = 'completed' or e.workflow_status in ('filed', 'completed') then 'filed'
    when e.workflow_status = 'documents_awaited' then 'waiting_on_you'
    when e.workflow_status in ('in_progress', 'under_review') then 'in_progress'
    else 'not_started'
  end as progress,
  f.id as filing_record_id,
  f.filed_on,
  f.acknowledgement_no,
  case when f.shareable_with_client and ad.id is not null then f.document_id end as acknowledgement_document_id
from public.compliance_events e
join public.clients c on c.id = e.client_id
left join public.due_date_overrides o on o.id = e.override_id
left join lateral (
  select fr.id, fr.filed_on, fr.acknowledgement_no, fr.shareable_with_client, fr.document_id
  from public.filing_records fr
  where fr.compliance_event_id = e.id and fr.client_id = e.client_id
  order by fr.filed_on desc nulls last, fr.created_at desc
  limit 1
) f on true
left join public.documents ad on ad.id = f.document_id and ad.client_id = e.client_id and ad.deleted_at is null
where public.is_client()
  and c.portal_user_id = auth.uid()
  and c.deleted_at is null
  and e.is_statutory;

comment on view public.portal_compliance_events is
  'The signed-in client''s statutory deadlines: portal-safe columns, derived overdue and progress, the closing filing; acknowledgement document only when shareable (§4.6, §7.22).';

-- =============================================================================================
-- portal_filing_records
-- =============================================================================================
create or replace view public.portal_filing_records with (security_invoker = false, security_barrier = true) as
select
  fr.id,
  fr.client_id,
  fr.financial_year,
  fr.filing_type,
  fr.service_type,
  fr.period,
  fr.filed_on,
  fr.acknowledgement_no,
  fr.compliance_event_id,
  (fr.filed_by_external is not null) as is_external,
  fr.filed_by_external,
  case when fr.shareable_with_client and d.id is not null then fr.document_id end as acknowledgement_document_id,
  fr.created_at
from public.filing_records fr
join public.clients c on c.id = fr.client_id
left join public.documents d on d.id = fr.document_id and d.client_id = fr.client_id and d.deleted_at is null
where public.is_client()
  and c.portal_user_id = auth.uid()
  and c.deleted_at is null;

comment on view public.portal_filing_records is
  'What was filed for the signed-in client (by the firm or a previous CA): form, period, filed on, acknowledgement number; the acknowledgement document only when shareable (§4.6, §7.22).';

-- =============================================================================================
-- portal_messages
-- =============================================================================================
create or replace view public.portal_messages with (security_invoker = false, security_barrier = true) as
select
  m.id,
  m.client_id,
  m.direction,
  m.subject,
  m.body,
  m.status,
  m.sent_at,
  m.delivered_at,
  m.read_at,
  m.created_at,
  case when m.direction = 'outbound' then p.full_name end as sender_name,
  (select count(*)::integer from public.message_attachments ma where ma.message_id = m.id) as attachment_count
from public.messages m
join public.clients c on c.id = m.client_id
left join public.profiles p on p.id = m.sent_by and p.role in ('partner', 'manager', 'employee')
where public.is_client()
  and c.portal_user_id = auth.uid()
  and c.deleted_at is null
  and m.channel = 'portal';

comment on view public.portal_messages is
  'The signed-in client''s portal thread with the firm: both directions, sender names, read receipts; never other channels (§7.22, §7.25).';

-- SELECT only for signed-in users (0043); nothing for anon or public.
revoke all on public.portal_compliance_events, public.portal_filing_records, public.portal_messages from anon, public;
revoke insert, update, delete, truncate, references, trigger
  on public.portal_compliance_events, public.portal_filing_records, public.portal_messages from authenticated;
grant select on public.portal_compliance_events, public.portal_filing_records, public.portal_messages to authenticated, service_role;

-- =============================================================================================
-- The portal reads compliance only through the views above.
-- =============================================================================================
drop policy if exists compliance_events_select_portal on public.compliance_events;
drop policy if exists filing_records_select_portal on public.filing_records;

-- The filing lookup the events view makes per row (messages already have (client_id, created_at),
-- 0018; attachments are found through their (message_id, document_id) key, 0010).
create index if not exists filing_records_compliance_event_idx on public.filing_records (compliance_event_id, filed_on desc) where compliance_event_id is not null;
