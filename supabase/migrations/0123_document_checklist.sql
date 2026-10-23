-- 0123 · The client's document checklist (§7.3.2 step 4, §7.14 "Checklist (from onboarding): items
-- can be ticked collected, linked to a document, added or removed").
--
-- Who may do what is already in 0033: anyone who can see the client ticks items and links documents
-- (Employees only those columns); Partners and Managers add and remove items. This adds the rules
-- the policies can't express, for every writer:
--   * the linked document is one of the same client's, and not in the recycle bin;
--   * collected_at / collected_by are stamped when an item is ticked (and cleared when unticked), so
--     "collected by Anita on 22 Oct" is always true; an insert may carry its own (onboarding does);
--   * an item never moves to another client;
--   * labels are 1-200 characters.

set search_path = public, extensions;

alter table public.client_document_checklist_items
  add constraint client_document_checklist_items_label_length check (char_length(btrim(label)) between 1 and 200);

create or replace function public.client_checklist_stamp()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if tg_op = 'UPDATE' and new.client_id is distinct from old.client_id then
    raise exception 'USER: A checklist item can''t be moved to another client.' using errcode = 'P0001';
  end if;

  if new.document_id is not null and (tg_op = 'INSERT' or new.document_id is distinct from old.document_id) then
    if not exists (
      select 1 from public.documents d
      where d.id = new.document_id and d.client_id = new.client_id and d.deleted_at is null
    ) then
      raise exception 'USER: Link one of this client''s documents.' using errcode = 'P0001';
    end if;
  end if;

  if tg_op = 'INSERT' then
    if new.collected then
      new.collected_at := coalesce(new.collected_at, now());
      new.collected_by := coalesce(new.collected_by, auth.uid());
    else
      new.collected_at := null;
      new.collected_by := null;
    end if;
  elsif new.collected is distinct from old.collected then
    if new.collected then
      new.collected_at := now();
      new.collected_by := coalesce(auth.uid(), new.collected_by);
    else
      new.collected_at := null;
      new.collected_by := null;
    end if;
  end if;
  return new;
end;
$$;

-- "stamp_…" sorts after "limit_employee_columns", so the Employee column check sees the person's
-- own change and the stamps are added afterwards.
create trigger stamp_checklist_collected before insert or update on public.client_document_checklist_items
  for each row execute function public.client_checklist_stamp();

revoke execute on function public.client_checklist_stamp() from public, anon, authenticated;
