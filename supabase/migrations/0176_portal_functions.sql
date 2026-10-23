-- 0176 · Portal writes (§7.22, §4.1, §4.6): read receipts, "I've paid" and its screenshot.
--
--   mark_portal_message_read(ids)   the client opened their Messages page: the firm's unread portal
--                                   messages (all of them, or the ids given) get read_at, which is
--                                   the read receipt staff see on the thread (§7.22 "read receipts"),
--                                   and a 'read' message_events row each (§5.9 "portal read
--                                   receipts"). SECURITY DEFINER because message_events is staff-only
--                                   for writing; it touches only the caller's own client's outbound
--                                   portal messages. Returns how many it marked.
--   submit_portal_payment_claim(…)  "I've paid" (§7.22): reference + date + optional screenshot →
--                                   portal_payment_claims, one transaction under the caller's RLS.
--                                   The invoice must be the caller's own issued invoice with something
--                                   still due (portal_invoices); the date can't be in the future; the
--                                   same reference can't be reported twice while it waits; at most five
--                                   claims wait per invoice. A screenshot is the caller's checked
--                                   upload slot, confirmed into a document (confirm_document_upload,
--                                   0121) in the same transaction, so it is a payment proof from the
--                                   moment it exists. It never marks the invoice paid: only a recorded
--                                   receipt does (invoice settlement triggers, 0152).
--   portal_payment_claims_insert_client (replaces 0034)  the insert policy now also requires an
--                                   active client role, a reference and a date (not in the future), no
--                                   staff review note, an invoice that is still payable, and a
--                                   screenshot (if any) that is the caller's own portal upload of the
--                                   same client. Length checks on reference, note and review note.
--   Payment proofs stay on the money side (§4.1 "An employee never receives … receipt … data,
--   not in a page, a search result, an API response or an export"). A screenshot of a payment to the
--   firm shows the fee, but it lives in the client's document vault, which Employees on the client
--   can read. Restrictive policies now hide documents that are a claim's screenshot from Employees:
--   the document row, its versions (storage paths) and activities, and the stored object itself in
--   client-documents. Partners, Managers and the client who uploaded it are unaffected.

set search_path = public, extensions;

-- =============================================================================================
-- mark_portal_message_read
-- =============================================================================================
create or replace function public.mark_portal_message_read(p_message_ids uuid[] default null)
returns integer
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_client uuid;
  v_now timestamptz := now();
  v_count integer := 0;
begin
  if v_uid is null or not public.is_client() then
    raise exception 'USER: Only the client marks the firm''s portal messages read.' using errcode = 'P0001';
  end if;
  if p_message_ids is not null and cardinality(p_message_ids) > 500 then
    raise exception 'USER: Mark at most 500 messages at a time.' using errcode = 'P0001';
  end if;
  select c.id into v_client
  from public.clients c
  where c.portal_user_id = v_uid and c.deleted_at is null;
  if v_client is null then
    raise exception 'USER: Your login isn''t linked to a client file yet. Ask the firm to check your portal access.' using errcode = 'P0001';
  end if;

  with marked as (
    update public.messages m
       set read_at = v_now
     where m.client_id = v_client
       and m.channel = 'portal'
       and m.direction = 'outbound'
       and m.read_at is null
       and m.created_at <= v_now
       and (p_message_ids is null or m.id = any (p_message_ids))
    returning m.id
  ),
  logged as (
    insert into public.message_events (message_id, status, details, at)
    select marked.id, 'read', jsonb_build_object('channel', 'portal', 'by', 'client'), v_now from marked
    returning 1
  )
  select count(*)::integer into v_count from logged;

  return v_count;
end;
$$;

comment on function public.mark_portal_message_read(uuid[]) is
  'The portal user read the firm''s portal messages (all unread, or the ids given): read_at + a read message event each; their own client only (§7.22 read receipts).';

revoke execute on function public.mark_portal_message_read(uuid[]) from public, anon;
grant execute on function public.mark_portal_message_read(uuid[]) to authenticated, service_role;

-- =============================================================================================
-- portal_payment_claims: constraints and the insert policy
-- =============================================================================================
alter table public.portal_payment_claims drop constraint if exists portal_payment_claims_reference_length;
alter table public.portal_payment_claims
  add constraint portal_payment_claims_reference_length check (reference is null or char_length(reference) between 1 and 100);
alter table public.portal_payment_claims drop constraint if exists portal_payment_claims_note_length;
alter table public.portal_payment_claims
  add constraint portal_payment_claims_note_length check (note is null or char_length(note) <= 1000);
alter table public.portal_payment_claims drop constraint if exists portal_payment_claims_review_note_length;
alter table public.portal_payment_claims
  add constraint portal_payment_claims_review_note_length check (review_note is null or char_length(review_note) <= 1000);

create index if not exists portal_payment_claims_invoice_idx on public.portal_payment_claims (invoice_id, status);
create index if not exists portal_payment_claims_screenshot_idx on public.portal_payment_claims (screenshot_document_id) where screenshot_document_id is not null;

drop policy if exists portal_payment_claims_insert_client on public.portal_payment_claims;
create policy portal_payment_claims_insert_client on public.portal_payment_claims
  for insert to authenticated
  with check (
    (select public.is_client())
    and client_id in (select public.portal_client_ids())
    and created_by = (select auth.uid())
    and status = 'pending'
    and verified_by is null and verified_at is null and payment_receipt_id is null and review_note is null
    and nullif(btrim(reference), '') is not null
    and paid_on is not null and paid_on <= public.today_ist()
    and exists (
      select 1 from public.portal_invoices pi
      where pi.id = portal_payment_claims.invoice_id
        and pi.client_id = portal_payment_claims.client_id
        and pi.cancelled_at is null
        and pi.status in ('sent', 'partially_paid', 'disputed')
        and pi.outstanding_amount > 0
    )
    and (
      screenshot_document_id is null
      or exists (
        select 1 from public.documents d
        where d.id = portal_payment_claims.screenshot_document_id
          and d.client_id = portal_payment_claims.client_id
          and d.uploaded_by = (select auth.uid())
          and d.source = 'client_portal'
          and d.deleted_at is null
      )
    )
  );

-- =============================================================================================
-- submit_portal_payment_claim
-- =============================================================================================
create or replace function public.submit_portal_payment_claim(
  p_invoice_id uuid,
  p_reference text,
  p_paid_on date,
  p_note text default null,
  p_upload_id uuid default null,
  p_file_size integer default null,
  p_mime_type text default null,
  p_sha256 text default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_ref text := nullif(btrim(coalesce(p_reference, '')), '');
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_inv record;
  v_purpose text;
  v_upload jsonb;
  v_doc uuid;
  v_claim uuid;
  v_waiting integer;
begin
  if v_uid is null or not public.is_client() then
    raise exception 'USER: Payments are reported by the client from their portal.' using errcode = 'P0001';
  end if;

  select pi.id, pi.client_id, pi.invoice_number, pi.issue_date, pi.status, pi.cancelled_at, pi.outstanding_amount
    into v_inv
  from public.portal_invoices pi
  where pi.id = p_invoice_id;
  if not found then
    raise exception 'USER: That invoice isn''t one of yours, or it no longer exists.' using errcode = 'P0001';
  end if;
  if v_inv.cancelled_at is not null then
    raise exception 'USER: Invoice % was cancelled, so nothing is due on it.', v_inv.invoice_number using errcode = 'P0001';
  end if;
  if v_inv.status = 'paid' or v_inv.outstanding_amount <= 0 then
    raise exception 'USER: Invoice % is already settled. Nothing more is due on it.', v_inv.invoice_number using errcode = 'P0001';
  end if;
  if v_inv.status not in ('sent', 'partially_paid', 'disputed') then
    raise exception 'USER: Invoice % can''t take a payment report. Send us a message if you have paid it.', v_inv.invoice_number using errcode = 'P0001';
  end if;

  if v_ref is null then
    raise exception 'USER: Enter the payment reference: the UTR, UPI transaction ID or cheque number.' using errcode = 'P0001';
  end if;
  if char_length(v_ref) > 100 then
    raise exception 'USER: Keep the payment reference under 100 characters.' using errcode = 'P0001';
  end if;
  if p_paid_on is null then
    raise exception 'USER: Enter the date you paid.' using errcode = 'P0001';
  end if;
  if p_paid_on > public.today_ist() then
    raise exception 'USER: The payment date can''t be in the future.' using errcode = 'P0001';
  end if;
  if p_paid_on < v_inv.issue_date - 365 then
    raise exception 'USER: That date is more than a year before the invoice. Check the payment date.' using errcode = 'P0001';
  end if;
  if v_note is not null and char_length(v_note) > 1000 then
    raise exception 'USER: Keep the note under 1,000 characters.' using errcode = 'P0001';
  end if;

  -- One report at a time per invoice, so the duplicate check below holds.
  perform pg_advisory_xact_lock(hashtextextended('portal_payment_claim:' || p_invoice_id::text, 0));

  if exists (
    select 1 from public.portal_payment_claims c
    where c.invoice_id = p_invoice_id and c.status = 'pending' and lower(btrim(c.reference)) = lower(v_ref)
  ) then
    raise exception 'USER: You''ve already told us about this payment. We''ll confirm it once we''ve matched it in our bank account.'
      using errcode = 'P0001';
  end if;
  select count(*)::integer into v_waiting
  from public.portal_payment_claims c
  where c.invoice_id = p_invoice_id and c.status = 'pending';
  if v_waiting >= 5 then
    raise exception 'USER: Five payments on invoice % are already waiting for us to confirm. We''ll be in touch; send us a message if it''s urgent.', v_inv.invoice_number
      using errcode = 'P0001';
  end if;

  if p_upload_id is not null then
    select u.purpose into v_purpose
    from public.document_uploads u
    where u.id = p_upload_id and u.created_by = v_uid and u.client_id = v_inv.client_id;
    if v_purpose is null then
      raise exception 'USER: The screenshot upload wasn''t found. Attach it again.' using errcode = 'P0001';
    end if;
    if v_purpose <> 'new_document' then
      raise exception 'USER: Attach the screenshot as a new file.' using errcode = 'P0001';
    end if;
    v_upload := public.confirm_document_upload(p_upload_id, p_file_size, p_mime_type, p_sha256, null);
    v_doc := nullif(v_upload ->> 'document_id', '')::uuid;
  end if;

  insert into public.portal_payment_claims (invoice_id, client_id, reference, paid_on, screenshot_document_id, note, created_by, status)
  values (p_invoice_id, v_inv.client_id, v_ref, p_paid_on, v_doc, v_note, v_uid, 'pending')
  returning id into v_claim;

  return jsonb_build_object(
    'claim_id', v_claim,
    'invoice_id', p_invoice_id,
    'invoice_number', v_inv.invoice_number,
    'client_id', v_inv.client_id,
    'document_id', v_doc
  );
end;
$$;

comment on function public.submit_portal_payment_claim(uuid, text, date, text, uuid, integer, text, text) is
  'Portal "I''ve paid": a pending claim on the caller''s own payable invoice, with an optional checked screenshot upload, in one transaction under RLS. Never marks the invoice paid (§7.22).';

revoke execute on function public.submit_portal_payment_claim(uuid, text, date, text, uuid, integer, text, text) from public, anon;
grant execute on function public.submit_portal_payment_claim(uuid, text, date, text, uuid, integer, text, text) to authenticated, service_role;

-- =============================================================================================
-- Payment proofs: never shown to Employees (§4.1)
-- =============================================================================================
create or replace function public.payment_proof_document_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, extensions
as $$
  select distinct c.screenshot_document_id
  from public.portal_payment_claims c
  where c.screenshot_document_id is not null
$$;

comment on function public.payment_proof_document_ids() is
  'Documents that are the screenshot of a portal "I''ve paid" claim: money-side, hidden from Employees (§4.1, §7.22).';

create or replace function public.is_payment_proof_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select p_name is not null and exists (
    select 1
    from public.portal_payment_claims c
    join public.documents d on d.id = c.screenshot_document_id
    where d.storage_path = p_name or d.storage_path = 'client-documents/' || p_name
       or exists (
         select 1 from public.document_versions v
         where v.document_id = d.id and (v.storage_path = p_name or v.storage_path = 'client-documents/' || p_name)
       )
  )
$$;

comment on function public.is_payment_proof_object(text) is
  'True when a client-documents object is the file of a payment proof (a claim''s screenshot) (§4.1).';

revoke execute on function public.payment_proof_document_ids(), public.is_payment_proof_object(text) from public, anon;
grant execute on function public.payment_proof_document_ids(), public.is_payment_proof_object(text) to authenticated, service_role;

drop policy if exists documents_payment_proof_guard on public.documents;
create policy documents_payment_proof_guard on public.documents
  as restrictive
  for all to authenticated
  using ((select public.app_role()) is distinct from 'employee' or id not in (select public.payment_proof_document_ids()))
  with check ((select public.app_role()) is distinct from 'employee' or id not in (select public.payment_proof_document_ids()));

drop policy if exists document_versions_payment_proof_guard on public.document_versions;
create policy document_versions_payment_proof_guard on public.document_versions
  as restrictive
  for select to authenticated
  using ((select public.app_role()) is distinct from 'employee' or document_id not in (select public.payment_proof_document_ids()));

drop policy if exists document_activities_payment_proof_guard on public.document_activities;
create policy document_activities_payment_proof_guard on public.document_activities
  as restrictive
  for select to authenticated
  using ((select public.app_role()) is distinct from 'employee' or document_id not in (select public.payment_proof_document_ids()));

drop policy if exists client_documents_payment_proof_guard on storage.objects;
create policy client_documents_payment_proof_guard on storage.objects
  as restrictive
  for select to authenticated
  using (
    bucket_id is distinct from 'client-documents'
    or (select public.app_role()) is distinct from 'employee'
    or not public.is_payment_proof_object(name)
  );
