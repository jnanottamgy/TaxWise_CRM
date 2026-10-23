-- 0121 · Document vault functions (§5.8, §6.8, §7.14, §7.19, §12).
--
--   confirm_document_upload(upload, size, mime, sha256, retention)
--        Turns a checked upload slot (0120) into, in one transaction:
--          new_document  a documents row (version 1), its first document_versions row, its tags and
--                        an 'uploaded' activity;
--          new_version   the next version of an existing document (the document row moves to the new
--                        file; the old file stays as a document_versions row) and a 'version_created'
--                        activity;
--          request_item  a new document as above, linked to the request item, which becomes
--                        'uploaded' (or 'accepted' when staff upload it and say so).
--        The server calls it only after it has read the stored object back and checked its size,
--        magic bytes and SHA-256 (server/files.ts). SECURITY DEFINER with the RLS rules repeated
--        explicitly: the slot must be the caller's, the caller must still see the client, a portal
--        user's upload is always source 'client_portal', never confidential and never a new version.
--        Calling it again for a confirmed slot returns the same document (idempotent).
--   discard_document_upload(upload, reason)
--        Marks the caller's unconfirmed slot as refused (the file failed the server's check) and
--        returns its storage path so the server removes the object.
--   find_document_duplicates(client, hashes[])
--        The client's documents (current files and older versions) whose SHA-256 matches, under the
--        caller's RLS: the duplicate warning (§7.14). Recycle-bin documents are flagged as such.
--   documents_purge_guard
--        A document can be purged only from the recycle bin and only after retention_until (§6.8:
--        "Purging before retention_until is blocked … Documents are never deleted automatically";
--        §7.19). Applies to everyone, the service role included.

set search_path = public, extensions;

-- =============================================================================================
-- confirm_document_upload
-- =============================================================================================
create or replace function public.confirm_document_upload(
  p_upload_id uuid,
  p_file_size int,
  p_mime_type text,
  p_sha256 text,
  p_retention_until date default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_role public.app_role := public.app_role();
  u public.document_uploads%rowtype;
  d public.documents%rowtype;
  v_item public.document_request_items%rowtype;
  v_req public.document_requests%rowtype;
  v_doc uuid;
  v_version int;
  v_title text;
  v_item_status public.request_item_status;
  v_sha text := lower(btrim(coalesce(p_sha256, '')));
begin
  if v_uid is null or v_role is null then
    raise exception 'USER: Your session has ended. Please sign in again.' using errcode = 'P0001';
  end if;

  select * into u from public.document_uploads where id = p_upload_id and created_by = v_uid for update;
  if not found then
    raise exception 'USER: This upload isn''t one of yours, or it no longer exists. Upload the file again.' using errcode = 'P0001';
  end if;

  if u.confirmed_at is not null then
    select * into d from public.documents where id = u.confirmed_document_id;
    return jsonb_build_object(
      'document_id', u.confirmed_document_id, 'version', d.version, 'client_id', u.client_id, 'purpose', u.purpose,
      'title', d.title, 'request_item_id', u.request_item_id,
      'request_id', (select i.request_id from public.document_request_items i where i.id = u.request_item_id),
      'item_status', (select i.status from public.document_request_items i where i.id = u.request_item_id),
      'already', true);
  end if;
  if u.failed_at is not null then
    raise exception 'USER: This upload was refused: %', coalesce(u.failure, 'the file didn''t pass the checks.') using errcode = 'P0001';
  end if;
  if u.expires_at < now() - interval '30 minutes' then
    raise exception 'USER: This upload took too long and has expired. Upload the file again.' using errcode = 'P0001';
  end if;

  -- The caller must still be allowed to add files for this client (a cover may have ended).
  if not public.can_see_client(u.client_id) then
    raise exception 'USER: You can''t add files for this client any more.' using errcode = 'P0001';
  end if;
  if v_role = 'client' and (u.purpose = 'new_version' or u.is_confidential or u.source <> 'client_portal' or u.accept_item) then
    raise exception 'USER: You don''t have permission to do that.' using errcode = 'P0001';
  end if;

  if p_mime_type is distinct from u.mime_type then
    raise exception 'USER: The uploaded file isn''t the type it was declared as. Upload it again.' using errcode = 'P0001';
  end if;
  if p_file_size is null or p_file_size <= 0 or p_file_size > 26214400 then
    raise exception 'USER: Files can be at most 25 MB.' using errcode = 'P0001';
  end if;
  if v_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'USER: The file''s checksum is missing. Upload it again.' using errcode = 'P0001';
  end if;

  if u.purpose = 'new_version' then
    select * into d from public.documents where id = u.document_id for update;
    if not found or d.deleted_at is not null or d.client_id <> u.client_id then
      raise exception 'USER: That document is no longer in this client''s vault.' using errcode = 'P0001';
    end if;
    -- Documents made before versions were kept (or by another module) get their current file
    -- recorded first, so it stays downloadable as the earlier version.
    if not exists (select 1 from public.document_versions v where v.document_id = d.id and v.version = d.version) then
      insert into public.document_versions (document_id, version, file_name, file_size, storage_path, uploaded_by, change_note, mime_type, sha256, created_at)
      values (d.id, d.version, d.file_name, d.file_size, d.storage_path, d.uploaded_by, null, d.mime_type, d.sha256, d.updated_at);
    end if;
    v_version := d.version + 1;
    insert into public.document_versions (document_id, version, file_name, file_size, storage_path, uploaded_by, change_note, mime_type, sha256)
    values (d.id, v_version, u.file_name, p_file_size, u.storage_path, v_uid, u.change_note, p_mime_type, v_sha);
    update public.documents
       set file_name = u.file_name, file_size = p_file_size, mime_type = p_mime_type, storage_path = u.storage_path,
           sha256 = v_sha, version = v_version
     where id = d.id;
    insert into public.document_activities (document_id, user_id, activity, metadata)
    values (d.id, v_uid, 'version_created',
            jsonb_build_object('version', v_version, 'file_name', u.file_name, 'file_size', p_file_size, 'change_note', u.change_note));
    v_doc := d.id;
    v_title := d.title;
  else
    v_title := coalesce(nullif(btrim(u.title), ''), regexp_replace(u.file_name, '\.[A-Za-z0-9]+$', ''));
    insert into public.documents (
      client_id, title, category, financial_year, period, description,
      file_name, file_size, mime_type, storage_path, sha256, version,
      source, is_confidential, shareable_with_client, uploaded_by,
      expiry_date, renewal_date, retention_until
    ) values (
      u.client_id, v_title, u.category, u.financial_year, nullif(btrim(u.period), ''), nullif(btrim(u.description), ''),
      u.file_name, p_file_size, p_mime_type, u.storage_path, v_sha, 1,
      case when v_role = 'client' then 'client_portal' else u.source end,
      case when v_role = 'client' then false else u.is_confidential end,
      false, v_uid,
      u.expiry_date, u.renewal_date,
      coalesce(p_retention_until, (public.today_ist() + interval '7 years')::date)
    )
    returning id into v_doc;
    v_version := 1;
    insert into public.document_versions (document_id, version, file_name, file_size, storage_path, uploaded_by, change_note, mime_type, sha256)
    values (v_doc, 1, u.file_name, p_file_size, u.storage_path, v_uid, null, p_mime_type, v_sha);
    if v_role <> 'client' then
      insert into public.document_tags (document_id, tag)
      select distinct v_doc, left(btrim(t), 40)::citext
      from unnest(u.tags) as t
      where btrim(t) <> ''
      on conflict (document_id, tag) do nothing;
    end if;
    insert into public.document_activities (document_id, user_id, activity, metadata)
    values (v_doc, v_uid, 'uploaded',
            jsonb_build_object('file_name', u.file_name, 'file_size', p_file_size, 'source',
                               case when v_role = 'client' then 'client_portal' else u.source end));
  end if;

  if u.purpose = 'request_item' then
    select * into v_item from public.document_request_items where id = u.request_item_id for update;
    select * into v_req from public.document_requests where id = v_item.request_id;
    if v_item.id is null or v_req.id is null or v_req.client_id <> u.client_id then
      raise exception 'USER: That request item no longer exists.' using errcode = 'P0001';
    end if;
    if v_req.status = 'cancelled' then
      raise exception 'USER: This request has been cancelled, so nothing more can be uploaded for it.' using errcode = 'P0001';
    end if;
    if v_item.status = 'accepted' then
      raise exception 'USER: This item has already been accepted.' using errcode = 'P0001';
    end if;
    v_item_status := case when v_role <> 'client' and u.accept_item then 'accepted' else 'uploaded' end;
    update public.document_request_items
       set document_id = v_doc,
           status = v_item_status,
           rejection_reason = case when v_item_status = 'accepted' then null else rejection_reason end
     where id = v_item.id;
  end if;

  update public.document_uploads set confirmed_at = now(), confirmed_document_id = v_doc where id = u.id;

  return jsonb_build_object(
    'document_id', v_doc, 'version', v_version, 'client_id', u.client_id, 'purpose', u.purpose, 'title', v_title,
    'request_item_id', u.request_item_id, 'request_id', v_item.request_id, 'item_status', v_item_status, 'already', false);
end;
$$;

comment on function public.confirm_document_upload(uuid, int, text, text, date) is
  'Turns the caller''s checked upload slot into a document, a new version or a request item''s upload, in one transaction (§7.14). Idempotent.';

-- =============================================================================================
-- discard_document_upload
-- =============================================================================================
create or replace function public.discard_document_upload(p_upload_id uuid, p_reason text)
returns text
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_path text;
begin
  update public.document_uploads
     set failed_at = now(), failure = left(coalesce(nullif(btrim(p_reason), ''), 'The file didn''t pass the checks.'), 500)
   where id = p_upload_id and created_by = auth.uid() and confirmed_at is null and failed_at is null
  returning storage_path into v_path;
  return v_path;
end;
$$;

comment on function public.discard_document_upload(uuid, text) is
  'Marks the caller''s unconfirmed upload slot as refused and returns its storage path (the server removes the object).';

-- =============================================================================================
-- find_document_duplicates (SECURITY INVOKER: the caller's RLS decides what they learn)
-- =============================================================================================
create or replace function public.find_document_duplicates(p_client_id uuid, p_hashes text[])
returns table (
  document_id uuid,
  sha256 text,
  title text,
  file_name text,
  version int,
  is_current boolean,
  category public.document_category,
  financial_year text,
  uploaded_at timestamptz,
  in_recycle_bin boolean
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with h as (
    select distinct lower(x) as sha from unnest(coalesce(p_hashes, '{}'::text[])) as x where x ~* '^[0-9a-f]{64}$' limit 50
  )
  select d.id, d.sha256, d.title, d.file_name, d.version, true, d.category, d.financial_year, d.created_at, d.deleted_at is not null
  from public.documents d
  join h on h.sha = d.sha256
  where d.client_id = p_client_id
  union all
  select d.id, v.sha256, d.title, v.file_name, v.version, false, d.category, d.financial_year, v.created_at, d.deleted_at is not null
  from public.document_versions v
  join public.documents d on d.id = v.document_id
  join h on h.sha = v.sha256
  where d.client_id = p_client_id and v.version <> d.version
  order by 9 desc
  limit 100
$$;

comment on function public.find_document_duplicates(uuid, text[]) is
  'The client''s documents and older versions with these SHA-256 hashes, under the caller''s RLS (§7.14 duplicate warning).';

-- =============================================================================================
-- documents_purge_guard (§6.8, §7.19)
-- =============================================================================================
create or replace function public.documents_purge_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if old.deleted_at is null then
    raise exception 'USER: Move the document to the recycle bin before purging it.' using errcode = 'P0001';
  end if;
  if old.retention_until is null then
    raise exception 'USER: This document has no retention date, so it can''t be purged. Set one first.' using errcode = 'P0001';
  end if;
  if old.retention_until >= public.today_ist() then
    raise exception 'USER: This document must be kept until % under the retention rules, so it can''t be purged yet.',
      to_char(old.retention_until, 'DD Mon YYYY') using errcode = 'P0001';
  end if;
  return old;
end;
$$;

create trigger documents_purge_guard before delete on public.documents
  for each row execute function public.documents_purge_guard();

-- =============================================================================================
-- Grants
-- =============================================================================================
revoke execute on function public.documents_purge_guard() from public, anon, authenticated;

revoke execute on function
  public.confirm_document_upload(uuid, int, text, text, date),
  public.discard_document_upload(uuid, text),
  public.find_document_duplicates(uuid, text[])
from public, anon;
grant execute on function
  public.confirm_document_upload(uuid, int, text, text, date),
  public.discard_document_upload(uuid, text),
  public.find_document_duplicates(uuid, text[])
to authenticated, service_role;
