-- 0120 · Document vault: upload slots, version details, request bookkeeping (§5.8, §7.14, §12, §13).
--
--   document_uploads             one row per file the browser is about to upload. The server inserts it
--                                under the caller's RLS (so only someone who may add files for the
--                                client gets a slot), then issues a signed upload URL for exactly its
--                                storage_path ('<client_id>/<uuid>.<ext>' in client-documents). After
--                                the upload the server reads the stored object back (size, magic bytes,
--                                SHA-256) and confirm_document_upload (0121) turns the slot into a
--                                document, a new version, or a request item's upload. Abandoned slots
--                                never become documents; their objects are removed by the cleanup job.
--                                A portal user's slot is never confidential, never a new version, and
--                                always source 'client_portal' (as the documents portal policy requires).
--   document_versions.mime_type  what each version's file is, so an older version downloads and
--   document_versions.sha256     previews correctly and counts in the duplicate check.
--   document_requests.contact_id the contact a request (and its reminders) goes to (§7.14 sending);
--     reminder_count             how many reminders have gone (the email says "reminder 2");
--     completed_at, cancelled_*  when it completed (every required item accepted) or was cancelled.
--   document_request_items.uploaded_at / reviewed_at / reviewed_by   when the client uploaded and who
--                                accepted or rejected it (§7.14 "Staff Accept, or Reject with a reason").
--
-- Employees may also set a request's contact, its reminder count and a cancel reason (the column
-- limit of 0037 is re-created with them).

set search_path = public, extensions;

-- =============================================================================================
-- document_uploads
-- =============================================================================================
create table public.document_uploads (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  bucket text not null default 'client-documents' constraint document_uploads_bucket check (bucket = 'client-documents'),
  storage_path text not null constraint document_uploads_storage_path_key unique,
  file_name text not null constraint document_uploads_file_name_length check (char_length(file_name) between 1 and 160),
  file_size int not null constraint document_uploads_file_size_limit check (file_size > 0 and file_size <= 26214400),
  mime_type text not null constraint document_uploads_mime_allowed check (mime_type in (
    'application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'text/csv', 'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
  -- What the file becomes
  purpose text not null constraint document_uploads_purpose check (purpose in ('new_document', 'new_version', 'request_item')),
  document_id uuid references public.documents (id) on delete cascade,             -- new_version: the document
  request_item_id uuid references public.document_request_items (id) on delete cascade, -- request_item: the item
  -- The new document's description (§7.14 upload: category, FY, period, title, tags, confidential)
  title text constraint document_uploads_title_length check (title is null or char_length(title) between 1 and 200),
  category public.document_category not null default 'other',
  financial_year text constraint document_uploads_financial_year_format check (public.is_fy_label(financial_year)),
  period text constraint document_uploads_period_length check (period is null or char_length(period) <= 40),
  description text constraint document_uploads_description_length check (description is null or char_length(description) <= 2000),
  tags text[] not null default '{}' constraint document_uploads_tags_limit check (cardinality(tags) <= 20),
  is_confidential boolean not null default false,
  expiry_date date,
  renewal_date date,
  source text not null default 'staff'
    constraint document_uploads_source_values check (source in ('staff', 'client_portal', 'generated', 'email', 'whatsapp')),
  change_note text constraint document_uploads_change_note_length check (change_note is null or char_length(change_note) <= 500),
  accept_item boolean not null default false,                                      -- staff upload against an item: accept it at once
  -- What the browser computed (the duplicate warning); the server's own hash is the one stored
  claimed_sha256 text constraint document_uploads_claimed_sha256 check (claimed_sha256 is null or claimed_sha256 ~ '^[0-9a-f]{64}$'),
  -- Lifecycle
  created_by uuid not null default auth.uid(),
  expires_at timestamptz not null default (now() + interval '2 hours'),           -- signed upload URLs last 2 hours
  confirmed_at timestamptz,
  confirmed_document_id uuid references public.documents (id) on delete set null,
  failed_at timestamptz,
  failure text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint document_uploads_storage_path_in_client_folder check (public.storage_path_in_client_folder(storage_path, client_id)),
  constraint document_uploads_purpose_target check (
    (purpose = 'new_version') = (document_id is not null)
    and (purpose = 'request_item') = (request_item_id is not null)
  ),
  constraint document_uploads_one_outcome check (confirmed_at is null or failed_at is null)
);
alter table public.document_uploads enable row level security;

comment on table public.document_uploads is
  'Upload slots (§7.14, §12): reserved under RLS before a signed upload URL is issued; confirmed into a document, a version or a request item''s upload by confirm_document_upload.';

create trigger set_updated_at before insert or update on public.document_uploads
  for each row execute function public.set_updated_at();

create index document_uploads_created_by_idx on public.document_uploads (created_by, created_at desc);
create index document_uploads_pending_idx on public.document_uploads (expires_at) where confirmed_at is null and failed_at is null;
create index document_uploads_client_idx on public.document_uploads (client_id);

-- A slot belongs to its creator; Partners and Managers read every slot (support, cleanup review).
create policy document_uploads_select on public.document_uploads
  for select to authenticated
  using (created_by = (select auth.uid()) or (select public.is_manager_or_partner()));

-- Staff: a client they can see. Portal: their own client, a new document or a request item's upload,
-- never confidential, always from the portal.
create policy document_uploads_insert on public.document_uploads
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and confirmed_at is null
    and failed_at is null
    and (
      ((select public.is_staff()) and ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids())))
      or (
        (select public.is_client())
        and client_id in (select public.portal_client_ids())
        and purpose in ('new_document', 'request_item')
        and source = 'client_portal'
        and not is_confidential
        and not accept_item
        and cardinality(tags) = 0
      )
    )
  );

-- No UPDATE or DELETE through the API: slots change only through confirm_document_upload and
-- discard_document_upload (0121), and the cleanup job (service role).
revoke update, delete, truncate on public.document_uploads from authenticated;

-- Relationships the policies can't see: the item belongs to a live request of the same client and
-- isn't accepted; the document to version is the same client's and in the vault. Also fixes the
-- lifecycle columns, so a slot can't be born confirmed or with a long life. SECURITY INVOKER: it
-- reads what the caller may see (is_api_caller() must see the caller's role).
create or replace function public.document_uploads_guard()
returns trigger
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_req public.document_requests%rowtype;
  v_item public.document_request_items%rowtype;
begin
  if public.is_api_caller() then
    new.created_by := auth.uid();
    new.expires_at := now() + interval '2 hours';
    new.confirmed_at := null;
    new.confirmed_document_id := null;
    new.failed_at := null;
    new.failure := null;
  end if;

  if new.purpose = 'new_version' then
    if not exists (
      select 1 from public.documents d
      where d.id = new.document_id and d.client_id = new.client_id and d.deleted_at is null
    ) then
      raise exception 'USER: That document is no longer in this client''s vault.' using errcode = 'P0001';
    end if;
  elsif new.purpose = 'request_item' then
    select * into v_item from public.document_request_items where id = new.request_item_id;
    select * into v_req from public.document_requests where id = v_item.request_id;
    if v_item.id is null or v_req.id is null or v_req.client_id <> new.client_id then
      raise exception 'USER: That request item isn''t one of this client''s.' using errcode = 'P0001';
    end if;
    if v_req.status = 'cancelled' then
      raise exception 'USER: This request has been cancelled, so nothing more can be uploaded for it.' using errcode = 'P0001';
    end if;
    if v_item.status = 'accepted' then
      raise exception 'USER: This item has already been accepted.' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

create trigger document_uploads_guard before insert on public.document_uploads
  for each row execute function public.document_uploads_guard();

revoke execute on function public.document_uploads_guard() from public, anon, authenticated;

-- =============================================================================================
-- document_versions: the file's type and hash per version
-- =============================================================================================
alter table public.document_versions
  add column if not exists mime_type text,
  add column if not exists sha256 text;
alter table public.document_versions
  add constraint document_versions_sha256_format check (sha256 is null or sha256 ~* '^[0-9a-f]{64}$');

create index document_versions_sha256_idx on public.document_versions (sha256) where sha256 is not null;

-- =============================================================================================
-- document_requests / document_request_items bookkeeping
-- =============================================================================================
alter table public.document_requests
  add column if not exists contact_id uuid references public.client_contacts (id) on delete set null,
  add column if not exists reminder_count int not null default 0,
  add column if not exists completed_at timestamptz,
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by uuid,
  add column if not exists cancel_reason text;
alter table public.document_requests
  add constraint document_requests_reminder_count_nonneg check (reminder_count >= 0),
  add constraint document_requests_reminder_every_days_range check (reminder_every_days between 1 and 60),
  add constraint document_requests_title_length check (char_length(btrim(title)) between 1 and 200),
  add constraint document_requests_cancel_reason_length check (cancel_reason is null or char_length(cancel_reason) <= 500);

alter table public.document_request_items
  add column if not exists uploaded_at timestamptz,
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid;
alter table public.document_request_items
  add constraint document_request_items_title_length check (char_length(btrim(title)) between 1 and 200),
  add constraint document_request_items_help_text_length check (help_text is null or char_length(help_text) <= 1000),
  add constraint document_request_items_rejection_reason_length check (rejection_reason is null or char_length(rejection_reason) <= 500);

create index document_requests_contact_idx on public.document_requests (contact_id) where contact_id is not null;

-- Employees: the 0037 list plus who it goes to, the reminder count and why it was cancelled.
drop trigger if exists limit_employee_columns on public.document_requests;
create trigger limit_employee_columns before update on public.document_requests
  for each row execute function public.limit_employee_columns(
    'title,status,due_date,notes,last_reminded_at,reminder_every_days,contact_id,reminder_count,cancel_reason',
    'this document request');
