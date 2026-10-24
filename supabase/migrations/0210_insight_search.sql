-- 0210 · Global search (§7.18): one box over the caller's RLS scope, grouped by type, plus the
-- per-user recent searches.
--
--   search_everything(q, limit_per_type, types, offset)   SECURITY INVOKER: every table is read under
--       the caller's own RLS, so an Employee finds only the clients they own, are on the team of or
--       cover, and the tasks and documents that go with them (§4.1, §4.7). On top of RLS the function
--       never searches leads, invoices or quotations for anyone but a Partner or a Manager (§4.1
--       "never, anywhere"), and refuses portal users outright (the portal has no search).
--         clients     display name, legal name, code, PAN, GSTIN, email, phone / WhatsApp (digits)
--         contacts    name, email, phone / WhatsApp (digits)
--         tasks       number, title
--         documents   title, tags
--         employees   name, email (an Employee's RLS shows only their own row)
--         leads       number, name, company, email, phone        Partner / Manager only
--         invoices    number                                     Partner / Manager only
--         quotations  number                                     Partner / Manager only
--       Soft-deleted rows (and the rows of a deleted client) never match (§0.1 rule 11). Each group
--       carries its total and the best `limit_per_type` items: exact identifier or name first, then
--       prefixes, then the rest by trigram similarity. `types` narrows the groups (the full results
--       page pages one type with `offset`).
--   remember_search(query)   the caller's recent searches (recent_searches, RLS: own rows only):
--       adds the query, drops older copies of it (case-insensitive) and keeps the newest 10.
--
-- Trigram indexes (pg_trgm, §7.18, §13) for the identifier columns that did not have one yet; the
-- digits-only phone expressions match `regexp_replace(phone, '[^0-9]', '', 'g')` in the function.

set search_path = public, extensions;

-- =============================================================================================
-- Indexes
-- =============================================================================================
create index if not exists clients_pan_trgm on public.clients using gin ((pan::text) gin_trgm_ops);
create index if not exists clients_gstin_trgm on public.clients using gin ((gstin::text) gin_trgm_ops);
create index if not exists clients_email_trgm on public.clients using gin ((email::text) gin_trgm_ops);
create index if not exists clients_phone_digits_trgm on public.clients using gin ((regexp_replace(phone, '[^0-9]', '', 'g')) gin_trgm_ops);
create index if not exists clients_whatsapp_digits_trgm on public.clients using gin ((regexp_replace(whatsapp, '[^0-9]', '', 'g')) gin_trgm_ops);

create index if not exists client_contacts_email_trgm on public.client_contacts using gin ((email::text) gin_trgm_ops);
create index if not exists client_contacts_phone_digits_trgm on public.client_contacts using gin ((regexp_replace(phone, '[^0-9]', '', 'g')) gin_trgm_ops);
create index if not exists client_contacts_whatsapp_digits_trgm on public.client_contacts using gin ((regexp_replace(whatsapp, '[^0-9]', '', 'g')) gin_trgm_ops);

create index if not exists leads_number_trgm on public.leads using gin (lead_number gin_trgm_ops);
create index if not exists leads_email_trgm on public.leads using gin ((email::text) gin_trgm_ops);
create index if not exists leads_phone_digits_trgm on public.leads using gin ((regexp_replace(phone, '[^0-9]', '', 'g')) gin_trgm_ops);

create index if not exists employees_email_trgm on public.employees using gin ((email::text) gin_trgm_ops);

-- =============================================================================================
-- search_everything
-- =============================================================================================
create or replace function public.search_everything(
  p_q text,
  p_limit_per_type int default 5,
  p_types text[] default null,
  p_offset int default 0
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  v_role public.app_role := public.app_role();
  v_q text := left(btrim(regexp_replace(coalesce(p_q, ''), '\s+', ' ', 'g')), 100);
  v_lower text;
  v_esc text;
  v_like text;
  v_prefix text;
  v_digits text;
  v_dlike text;
  v_limit int := least(greatest(coalesce(p_limit_per_type, 5), 1), 100);
  v_offset int := least(greatest(coalesce(p_offset, 0), 0), 100000);
  v_money boolean;
  v_all text[] := array['client', 'contact', 'task', 'document', 'employee', 'lead', 'invoice', 'quotation'];
  v_types text[];
  v_groups jsonb := '[]'::jsonb;
  v_group jsonb;
begin
  if v_role is null then
    raise exception 'USER: Your session has ended. Please sign in again.' using errcode = 'P0001';
  end if;
  if v_role = 'client' then
    raise exception 'USER: Search isn''t available in the client portal.' using errcode = 'P0001';
  end if;
  if length(v_q) < 2 then
    return jsonb_build_object('query', v_q, 'groups', '[]'::jsonb);
  end if;

  v_money := v_role in ('partner', 'manager');
  v_lower := lower(v_q);
  v_esc := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_');
  v_like := '%' || v_esc || '%';
  v_prefix := v_esc || '%';
  v_digits := regexp_replace(v_q, '[^0-9]', '', 'g');
  -- Phone numbers match on digits alone ("97405 40239" finds "+91 97405 40239"), from four digits.
  v_dlike := case when length(v_digits) >= 4 then '%' || v_digits || '%' end;

  select coalesce(array_agg(t order by array_position(v_all, t)), '{}')
    into v_types
  from unnest(coalesce(p_types, v_all)) t
  where t = any (v_all)
    and (v_money or t not in ('lead', 'invoice', 'quotation'));

  -- ------------------------------------------------------------------------------------------
  -- Clients
  -- ------------------------------------------------------------------------------------------
  if 'client' = any (v_types) then
    with m as (
      select
        c.id,
        c.display_name as title,
        concat_ws(' · ', c.client_code::text, coalesce(c.gstin::text, c.pan::text), nullif(c.city, '')) as subtitle,
        c.id as client_id,
        case
          when lower(c.client_code::text) = v_lower or lower(coalesce(c.pan::text, '')) = v_lower
            or lower(coalesce(c.gstin::text, '')) = v_lower or lower(c.display_name) = v_lower then 0
          when c.display_name ilike v_prefix or coalesce(c.legal_name, '') ilike v_prefix or c.client_code::text ilike v_prefix then 1
          else 2
        end as rank,
        similarity(c.display_name, v_q) as sim
      from public.clients c
      where c.deleted_at is null
        and (
          c.display_name ilike v_like
          or c.legal_name ilike v_like
          or c.client_code::text ilike v_like
          or c.pan::text ilike v_like
          or c.gstin::text ilike v_like
          or c.email::text ilike v_like
          or (v_dlike is not null and (regexp_replace(c.phone, '[^0-9]', '', 'g') like v_dlike or regexp_replace(c.whatsapp, '[^0-9]', '', 'g') like v_dlike))
        )
    )
    select jsonb_build_object(
      'type', 'client',
      'total', (select count(*) from m),
      'items', coalesce((
        select jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'subtitle', nullif(x.subtitle, ''), 'client_id', x.client_id) order by x.rank, x.sim desc, x.title, x.id)
        from (select * from m order by rank, sim desc, title, id offset v_offset limit v_limit) x
      ), '[]'::jsonb)
    ) into v_group;
    v_groups := v_groups || jsonb_build_array(v_group);
  end if;

  -- ------------------------------------------------------------------------------------------
  -- Contacts (of clients the caller can see; the client must not be in the recycle bin)
  -- ------------------------------------------------------------------------------------------
  if 'contact' = any (v_types) then
    with m as (
      select
        k.id,
        k.name as title,
        concat_ws(' · ', nullif(k.role, ''), c.display_name, coalesce(k.email::text, k.phone)) as subtitle,
        k.client_id,
        case
          when lower(k.name) = v_lower or lower(coalesce(k.email::text, '')) = v_lower then 0
          when k.name ilike v_prefix or coalesce(k.email::text, '') ilike v_prefix then 1
          else 2
        end as rank,
        similarity(k.name, v_q) as sim
      from public.client_contacts k
      join public.clients c on c.id = k.client_id and c.deleted_at is null
      where k.name ilike v_like
         or k.email::text ilike v_like
         or (v_dlike is not null and (regexp_replace(k.phone, '[^0-9]', '', 'g') like v_dlike or regexp_replace(k.whatsapp, '[^0-9]', '', 'g') like v_dlike))
    )
    select jsonb_build_object(
      'type', 'contact',
      'total', (select count(*) from m),
      'items', coalesce((
        select jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'subtitle', nullif(x.subtitle, ''), 'client_id', x.client_id) order by x.rank, x.sim desc, x.title, x.id)
        from (select * from m order by rank, sim desc, title, id offset v_offset limit v_limit) x
      ), '[]'::jsonb)
    ) into v_group;
    v_groups := v_groups || jsonb_build_array(v_group);
  end if;

  -- ------------------------------------------------------------------------------------------
  -- Tasks
  -- ------------------------------------------------------------------------------------------
  if 'task' = any (v_types) then
    with m as (
      select
        t.id,
        t.task_number || ' · ' || t.title as title,
        concat_ws(' · ', c.display_name, nullif(t.period_label, ''), case when t.due_date is not null then 'due ' || to_char(t.due_date, 'DD Mon YYYY') end) as subtitle,
        t.client_id,
        case
          when lower(t.task_number) = v_lower or lower(t.title) = v_lower then 0
          when t.task_number ilike v_prefix or t.title ilike v_prefix then 1
          else 2
        end as rank,
        similarity(t.title, v_q) as sim,
        t.created_at
      from public.tasks t
      join public.clients c on c.id = t.client_id and c.deleted_at is null
      where t.deleted_at is null
        and (t.task_number ilike v_like or t.title ilike v_like)
    )
    select jsonb_build_object(
      'type', 'task',
      'total', (select count(*) from m),
      'items', coalesce((
        select jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'subtitle', nullif(x.subtitle, ''), 'client_id', x.client_id) order by x.rank, x.sim desc, x.created_at desc, x.id)
        from (select * from m order by rank, sim desc, created_at desc, id offset v_offset limit v_limit) x
      ), '[]'::jsonb)
    ) into v_group;
    v_groups := v_groups || jsonb_build_array(v_group);
  end if;

  -- ------------------------------------------------------------------------------------------
  -- Documents (title or tag)
  -- ------------------------------------------------------------------------------------------
  if 'document' = any (v_types) then
    with m as (
      select
        d.id,
        d.title,
        concat_ws(' · ', c.display_name, nullif(d.financial_year, ''), d.file_name) as subtitle,
        d.client_id,
        case
          when lower(d.title) = v_lower then 0
          when d.title ilike v_prefix then 1
          else 2
        end as rank,
        similarity(d.title, v_q) as sim,
        d.created_at
      from public.documents d
      join public.clients c on c.id = d.client_id and c.deleted_at is null
      where d.deleted_at is null
        and (
          d.title ilike v_like
          or exists (select 1 from public.document_tags g where g.document_id = d.id and g.tag::text ilike v_like)
        )
    )
    select jsonb_build_object(
      'type', 'document',
      'total', (select count(*) from m),
      'items', coalesce((
        select jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'subtitle', nullif(x.subtitle, ''), 'client_id', x.client_id) order by x.rank, x.sim desc, x.created_at desc, x.id)
        from (select * from m order by rank, sim desc, created_at desc, id offset v_offset limit v_limit) x
      ), '[]'::jsonb)
    ) into v_group;
    v_groups := v_groups || jsonb_build_array(v_group);
  end if;

  -- ------------------------------------------------------------------------------------------
  -- Employees (the people table under RLS: Partners and Managers see everyone, an Employee only
  -- their own row; the directory view is not searched, so colleagues' emails never leak)
  -- ------------------------------------------------------------------------------------------
  if 'employee' = any (v_types) then
    with m as (
      select
        e.id,
        e.full_name as title,
        concat_ws(' · ', nullif(e.designation, ''), case when not e.is_active then 'Disabled' end, e.email::text) as subtitle,
        null::uuid as client_id,
        case
          when lower(e.full_name) = v_lower or lower(e.email::text) = v_lower then 0
          when e.full_name ilike v_prefix or e.email::text ilike v_prefix then 1
          else 2
        end as rank,
        similarity(e.full_name, v_q) as sim
      from public.employees e
      where e.deleted_at is null
        and (e.full_name ilike v_like or e.email::text ilike v_like)
    )
    select jsonb_build_object(
      'type', 'employee',
      'total', (select count(*) from m),
      'items', coalesce((
        select jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'subtitle', nullif(x.subtitle, ''), 'client_id', x.client_id) order by x.rank, x.sim desc, x.title, x.id)
        from (select * from m order by rank, sim desc, title, id offset v_offset limit v_limit) x
      ), '[]'::jsonb)
    ) into v_group;
    v_groups := v_groups || jsonb_build_array(v_group);
  end if;

  -- ------------------------------------------------------------------------------------------
  -- Leads, invoices and quotations: Partners and Managers only (§4.1), checked here as well as by RLS.
  -- ------------------------------------------------------------------------------------------
  if v_money and 'lead' = any (v_types) then
    with m as (
      select
        l.id,
        coalesce(nullif(l.company, ''), l.name) as title,
        concat_ws(' · ', l.lead_number, case when nullif(l.company, '') is not null then l.name end, initcap(replace(l.status::text, '_', ' '))) as subtitle,
        l.converted_client_id as client_id,
        case
          when lower(coalesce(l.lead_number, '')) = v_lower or lower(l.name) = v_lower or lower(coalesce(l.company, '')) = v_lower then 0
          when l.name ilike v_prefix or coalesce(l.company, '') ilike v_prefix or coalesce(l.lead_number, '') ilike v_prefix then 1
          else 2
        end as rank,
        greatest(similarity(l.name, v_q), similarity(coalesce(l.company, ''), v_q)) as sim,
        l.created_at
      from public.leads l
      where l.deleted_at is null
        and (
          l.name ilike v_like
          or l.company ilike v_like
          or l.lead_number ilike v_like
          or l.email::text ilike v_like
          or (v_dlike is not null and regexp_replace(l.phone, '[^0-9]', '', 'g') like v_dlike)
        )
    )
    select jsonb_build_object(
      'type', 'lead',
      'total', (select count(*) from m),
      'items', coalesce((
        select jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'subtitle', nullif(x.subtitle, ''), 'client_id', x.client_id) order by x.rank, x.sim desc, x.created_at desc, x.id)
        from (select * from m order by rank, sim desc, created_at desc, id offset v_offset limit v_limit) x
      ), '[]'::jsonb)
    ) into v_group;
    v_groups := v_groups || jsonb_build_array(v_group);
  end if;

  if v_money and 'invoice' = any (v_types) then
    with m as (
      select
        i.id,
        i.invoice_number as title,
        concat_ws(' · ', c.display_name, to_char(i.issue_date, 'DD Mon YYYY'),
          case when i.cancelled_at is not null then 'Cancelled' when i.invoice_kind = 'debit_note' then 'Debit note' end) as subtitle,
        i.client_id,
        case when lower(i.invoice_number) = v_lower then 0 when i.invoice_number ilike v_prefix then 1 else 2 end as rank,
        i.issue_date
      from public.invoices i
      join public.clients c on c.id = i.client_id and c.deleted_at is null
      where i.deleted_at is null
        and i.invoice_number is not null
        and i.invoice_number ilike v_like
    )
    select jsonb_build_object(
      'type', 'invoice',
      'total', (select count(*) from m),
      'items', coalesce((
        select jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'subtitle', nullif(x.subtitle, ''), 'client_id', x.client_id) order by x.rank, x.issue_date desc, x.title, x.id)
        from (select * from m order by rank, issue_date desc, title, id offset v_offset limit v_limit) x
      ), '[]'::jsonb)
    ) into v_group;
    v_groups := v_groups || jsonb_build_array(v_group);
  end if;

  if v_money and 'quotation' = any (v_types) then
    with m as (
      select
        q.id,
        q.quotation_number as title,
        concat_ws(' · ', coalesce(nullif(q.client_company, ''), q.client_name), to_char(q.issue_date, 'DD Mon YYYY'), initcap(replace(q.status::text, '_', ' '))) as subtitle,
        q.client_id,
        case when lower(q.quotation_number) = v_lower then 0 when q.quotation_number ilike v_prefix then 1 else 2 end as rank,
        q.issue_date
      from public.quotations q
      where q.deleted_at is null
        and q.quotation_number ilike v_like
    )
    select jsonb_build_object(
      'type', 'quotation',
      'total', (select count(*) from m),
      'items', coalesce((
        select jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'subtitle', nullif(x.subtitle, ''), 'client_id', x.client_id) order by x.rank, x.issue_date desc, x.title, x.id)
        from (select * from m order by rank, issue_date desc, title, id offset v_offset limit v_limit) x
      ), '[]'::jsonb)
    ) into v_group;
    v_groups := v_groups || jsonb_build_array(v_group);
  end if;

  return jsonb_build_object('query', v_q, 'groups', v_groups);
end;
$$;

comment on function public.search_everything(text, int, text[], int) is
  'Global search (§7.18) under the caller''s RLS: clients, contacts, tasks, documents, employees; leads, invoices and quotations for Partners and Managers only. Groups with totals and the best items per type.';

-- =============================================================================================
-- remember_search
-- =============================================================================================
create or replace function public.remember_search(p_query text)
returns void
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_q text := left(btrim(regexp_replace(coalesce(p_query, ''), '\s+', ' ', 'g')), 120);
begin
  if v_uid is null or not public.is_staff() then
    raise exception 'USER: Recent searches are kept for staff only.' using errcode = 'P0001';
  end if;
  if length(v_q) < 2 then
    return;
  end if;
  delete from public.recent_searches r where r.user_id = v_uid and lower(r.query) = lower(v_q);
  insert into public.recent_searches (user_id, query, searched_at) values (v_uid, v_q, clock_timestamp());
  delete from public.recent_searches r
  where r.user_id = v_uid
    and r.id not in (
      select k.id from public.recent_searches k where k.user_id = v_uid order by k.searched_at desc, k.id desc limit 10
    );
end;
$$;

comment on function public.remember_search(text) is
  'Adds a query to the caller''s recent searches (§7.18), drops older copies and keeps the newest 10. RLS: own rows only.';

-- =============================================================================================
-- Grants
-- =============================================================================================
revoke execute on function public.search_everything(text, int, text[], int), public.remember_search(text) from public, anon;
grant execute on function public.search_everything(text, int, text[], int), public.remember_search(text) to authenticated, service_role;
