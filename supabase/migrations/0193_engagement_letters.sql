-- 0193 · Engagement letters (§7.15.3, §6.8 SA 210, §6.9, §4.1 Partner/Manager only).
--
--   engagement_letters, new columns
--     exclusions            what the engagement doesn't cover ("Scope / exclusions")
--     services_schedule     the services schedule printed for non-audit work, frozen on the letter:
--                           [{service_type, description, frequency, fee}] (fees excl. GST)
--     audit_type            for audits: statutory_companies_act, tax_audit, gst_audit, internal,
--                           bank_branch, stock, certification, other (as audit_engagements)
--     reporting_framework   SA 210 "applicable financial reporting framework"
--     report_form           SA 210 "expected form and content of the report"
--     audit_engagement_id   the audit engagement the letter is for (§6.9 acceptance gate)
--     signatory_id          the Partner who signs for the firm (signature block)
--     renewed_from_id       the letter this one renews ("Renew for next FY")
--     declined_reason · sent_at · sent_to · updated_by
--   engagement_letters_guard (BEFORE INSERT/UPDATE, API callers): a letter is created as a Draft;
--     status moves Draft → Issued → Signed / Declined / Expired (Issued → Draft to withdraw it,
--     Declined → Draft to try again, Signed → Expired); Issued and Signed stamp their dates, which
--     can't be in the future or before issue; Declined needs the client's reason; what the client
--     signs (FY, services, scope, exclusions, fee, schedule, audit terms, signatory) is frozen once
--     the letter leaves Draft; the client never changes.
--   engagement_letters_register  (security invoker) the letter with its client, owner, signatory,
--     a derived Expired for an Issued/Signed letter past expires_at, days to expiry, the renewal.
--   engagement_letter_gaps(fy)   clients with active services and no letter Issued or Signed for
--     the FY (Partners/Managers; an Employee gets nothing).

set search_path = public, extensions;

alter table public.engagement_letters
  add column if not exists exclusions text,
  add column if not exists services_schedule jsonb not null default '[]'::jsonb,
  add column if not exists audit_type text,
  add column if not exists reporting_framework text,
  add column if not exists report_form text,
  add column if not exists audit_engagement_id uuid references public.audit_engagements (id) on delete set null,
  add column if not exists signatory_id uuid references public.profiles (id) on delete set null,
  add column if not exists renewed_from_id uuid references public.engagement_letters (id) on delete set null,
  add column if not exists declined_reason text,
  add column if not exists sent_at timestamptz,
  add column if not exists sent_to text,
  add column if not exists updated_by uuid;

alter table public.engagement_letters
  add constraint engagement_letters_services_schedule_array check (jsonb_typeof(services_schedule) = 'array'),
  add constraint engagement_letters_audit_type_values check (audit_type is null or audit_type in (
    'statutory_companies_act', 'tax_audit', 'gst_audit', 'internal', 'bank_branch', 'stock', 'certification', 'other'
  )),
  add constraint engagement_letters_services_present check (cardinality(service_types) > 0) not valid,
  add constraint engagement_letters_not_own_renewal check (renewed_from_id is null or renewed_from_id <> id),
  add constraint engagement_letters_text_lengths check (
    coalesce(length(scope), 0) <= 8000 and coalesce(length(exclusions), 0) <= 4000 and coalesce(length(notes), 0) <= 4000
    and coalesce(length(reporting_framework), 0) <= 1000 and coalesce(length(report_form), 0) <= 1000
    and coalesce(length(declined_reason), 0) <= 1000
  );

create index if not exists engagement_letters_renewed_from_idx on public.engagement_letters (renewed_from_id) where renewed_from_id is not null;
create index if not exists engagement_letters_expires_idx on public.engagement_letters (expires_at) where status in ('issued', 'signed');

-- =============================================================================================
-- engagement_letters_guard
-- =============================================================================================
create or replace function public.engagement_letters_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_today date := public.today_ist();
begin
  if not public.is_api_caller() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'USER: A new engagement letter starts as a draft. Issue it once it''s ready.' using errcode = 'P0001';
    end if;
    new.issued_at := null;
    new.signed_at := null;
    new.sent_at := null;
    new.sent_to := null;
    new.declined_reason := null;
    new.created_by := auth.uid();
    new.updated_by := auth.uid();
    return new;
  end if;

  if new.client_id is distinct from old.client_id then
    raise exception 'USER: An engagement letter stays with its client. Start a new letter for the other client.' using errcode = 'P0001';
  end if;
  if new.created_by is distinct from old.created_by then
    new.created_by := old.created_by;
  end if;

  if new.status is distinct from old.status then
    if not (
      (old.status = 'draft' and new.status = 'issued')
      or (old.status = 'issued' and new.status in ('signed', 'declined', 'expired', 'draft'))
      or (old.status = 'signed' and new.status = 'expired')
      or (old.status = 'declined' and new.status = 'draft')
    ) then
      raise exception 'USER: An engagement letter can''t go from % to %.', initcap(old.status::text), initcap(new.status::text) using errcode = 'P0001';
    end if;
    if new.status = 'issued' then
      new.issued_at := coalesce(new.issued_at, now());
      new.signed_at := null;
      new.declined_reason := null;
    elsif new.status = 'signed' then
      new.signed_at := coalesce(new.signed_at, now());
    elsif new.status = 'declined' then
      if nullif(btrim(coalesce(new.declined_reason, '')), '') is null then
        raise exception 'USER: Say why the client declined the letter.' using errcode = 'P0001';
      end if;
    elsif new.status = 'draft' then
      new.issued_at := null;
      new.signed_at := null;
      new.sent_at := null;
      new.sent_to := null;
    end if;
  end if;

  if new.issued_at is not null and (new.issued_at at time zone 'Asia/Kolkata')::date > v_today then
    raise exception 'USER: The issue date can''t be in the future.' using errcode = 'P0001';
  end if;
  if new.signed_at is not null then
    if (new.signed_at at time zone 'Asia/Kolkata')::date > v_today then
      raise exception 'USER: The signing date can''t be in the future.' using errcode = 'P0001';
    end if;
    if new.issued_at is not null and (new.signed_at at time zone 'Asia/Kolkata')::date < (new.issued_at at time zone 'Asia/Kolkata')::date then
      raise exception 'USER: The letter can''t be signed before it was issued.' using errcode = 'P0001';
    end if;
  end if;

  -- What the client signs is frozen once the letter is out of Draft.
  if old.status <> 'draft' and new.status <> 'draft' and (
    row(new.financial_year, new.service_types, new.scope, new.exclusions, new.fee_agreed, new.services_schedule,
        new.audit_type, new.reporting_framework, new.report_form, new.signatory_id, new.audit_engagement_id)
    is distinct from
    row(old.financial_year, old.service_types, old.scope, old.exclusions, old.fee_agreed, old.services_schedule,
        old.audit_type, old.reporting_framework, old.report_form, old.signatory_id, old.audit_engagement_id)
  ) then
    raise exception 'USER: An issued letter can''t be changed: it''s what the client signs. Withdraw it to a draft first, or start a new letter.' using errcode = 'P0001';
  end if;

  new.updated_by := auth.uid();
  return new;
end;
$$;

comment on function public.engagement_letters_guard() is
  'Trigger: engagement letters start as drafts, move Draft → Issued → Signed / Declined / Expired, and are frozen once issued (§7.15.3).';

drop trigger if exists engagement_letters_guard on public.engagement_letters;
create trigger engagement_letters_guard
  before insert or update on public.engagement_letters
  for each row execute function public.engagement_letters_guard();

revoke execute on function public.engagement_letters_guard() from public, anon, authenticated;

-- A renewal and an audit engagement belong to the same client.
create or replace function public.engagement_letters_links_guard()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if new.renewed_from_id is not null and (tg_op = 'INSERT' or new.renewed_from_id is distinct from old.renewed_from_id)
     and not exists (select 1 from public.engagement_letters l where l.id = new.renewed_from_id and l.client_id = new.client_id) then
    raise exception 'USER: A renewal is for the same client as the letter it renews.' using errcode = 'P0001';
  end if;
  if new.audit_engagement_id is not null and (tg_op = 'INSERT' or new.audit_engagement_id is distinct from old.audit_engagement_id)
     and not exists (select 1 from public.audit_engagements ae where ae.id = new.audit_engagement_id and ae.client_id = new.client_id) then
    raise exception 'USER: The audit engagement belongs to another client.' using errcode = 'P0001';
  end if;
  if new.signatory_id is not null and (tg_op = 'INSERT' or new.signatory_id is distinct from old.signatory_id)
     and not exists (select 1 from public.profiles p where p.id = new.signatory_id and p.role = 'partner' and p.is_active) then
    raise exception 'USER: The letter is signed for the firm by an active Partner.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists engagement_letters_links_guard on public.engagement_letters;
create trigger engagement_letters_links_guard
  before insert or update on public.engagement_letters
  for each row execute function public.engagement_letters_links_guard();

revoke execute on function public.engagement_letters_links_guard() from public, anon, authenticated;

-- =============================================================================================
-- engagement_letters_register
-- =============================================================================================
create or replace view public.engagement_letters_register with (security_invoker = true) as
select
  el.id,
  el.client_id,
  c.display_name as client_name,
  c.client_code::text as client_code,
  c.status as client_status,
  c.owner_employee_id,
  od.full_name as owner_name,
  el.financial_year,
  el.service_types,
  ('audit' = any (el.service_types)) as is_audit,
  el.scope,
  el.exclusions,
  el.fee_agreed,
  el.services_schedule,
  el.audit_type,
  el.reporting_framework,
  el.report_form,
  el.audit_engagement_id,
  el.signatory_id,
  sp.full_name as signatory_name,
  el.status,
  case when el.status in ('issued', 'signed') and el.expires_at is not null and el.expires_at < public.today_ist() then 'expired' else el.status::text end as display_status,
  el.issued_at,
  el.signed_at,
  el.expires_at,
  case when el.expires_at is not null then el.expires_at - public.today_ist() end as days_to_expiry,
  el.document_id,
  d.title as signed_copy_title,
  el.declined_reason,
  el.sent_at,
  el.sent_to,
  el.renewed_from_id,
  rf.financial_year as renewed_from_fy,
  rn.id as renewal_id,
  rn.financial_year as renewal_fy,
  rn.status as renewal_status,
  el.notes,
  el.created_by,
  cb.full_name as created_by_name,
  el.updated_by,
  el.created_at,
  el.updated_at
from public.engagement_letters el
join public.clients c on c.id = el.client_id and c.deleted_at is null
left join public.employee_directory od on od.id = c.owner_employee_id
left join public.profiles sp on sp.id = el.signatory_id
left join public.profiles cb on cb.id = el.created_by
left join public.documents d on d.id = el.document_id and d.deleted_at is null
left join public.engagement_letters rf on rf.id = el.renewed_from_id
left join lateral (
  select r.id, r.financial_year, r.status
  from public.engagement_letters r
  where r.renewed_from_id = el.id and r.status <> 'declined'
  order by r.created_at desc
  limit 1
) rn on true;

comment on view public.engagement_letters_register is
  'Engagement letters with the client, owner, signatory, a derived Expired past expires_at, days to expiry and the renewal (§7.15.3, §0.1 rule 10). Partners/Managers (RLS).';

revoke all on public.engagement_letters_register from anon, public;
revoke insert, update, delete, truncate, references, trigger on public.engagement_letters_register from authenticated;
grant select on public.engagement_letters_register to authenticated, service_role;

-- =============================================================================================
-- engagement_letter_gaps(fy): active clients with active services and no Issued/Signed letter.
-- =============================================================================================
create or replace function public.engagement_letter_gaps(p_fy text)
returns table (
  client_id uuid,
  client_name text,
  client_code text,
  owner_employee_id uuid,
  owner_name text,
  service_types public.service_type[],
  drafts int,
  last_letter_fy text,
  last_letter_status text
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select
    c.id,
    c.display_name,
    c.client_code::text,
    c.owner_employee_id,
    od.full_name,
    array_agg(distinct s.service_type order by s.service_type),
    (select count(*)::int from public.engagement_letters d where d.client_id = c.id and d.financial_year = p_fy and d.status = 'draft'),
    (select l.financial_year from public.engagement_letters l where l.client_id = c.id and l.status in ('issued', 'signed', 'expired') order by l.financial_year desc, l.created_at desc limit 1),
    (select l.status::text from public.engagement_letters l where l.client_id = c.id and l.status in ('issued', 'signed', 'expired') order by l.financial_year desc, l.created_at desc limit 1)
  from public.clients c
  join public.client_services s on s.client_id = c.id and s.is_active
  left join public.employee_directory od on od.id = c.owner_employee_id
  where public.is_manager_or_partner()
    and public.is_fy_label(p_fy)
    and c.deleted_at is null
    and c.status = 'active'
    and not exists (
      select 1 from public.engagement_letters l
      where l.client_id = c.id and l.financial_year = p_fy and l.status in ('issued', 'signed')
    )
  group by c.id, c.display_name, c.client_code, c.owner_employee_id, od.full_name
$$;

comment on function public.engagement_letter_gaps(text) is
  'Active clients with active services and no engagement letter Issued or Signed for the FY (§7.15.3 lists, §8 team health). Partners/Managers only.';

revoke execute on function public.engagement_letter_gaps(text) from public, anon;
grant execute on function public.engagement_letter_gaps(text) to authenticated, service_role;
