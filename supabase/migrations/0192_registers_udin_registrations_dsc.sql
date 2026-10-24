-- 0192 · Registers: UDINs and the tax-audit ceiling, statutory registrations, DSCs
-- (§7.15.1, §6.2, §6.7, §6.8, §4.1, §18.3 Partner 7).
--
--   udin_records, new columns
--     form26_category        a Form 26 report's s.44AB-equivalent category (a, b, combined, c, d, e):
--                            only a, b and combined count towards the ceiling [verify mapping]
--     ceiling_confirmed_by   the Partner who confirmed logging a tax audit past the ICAI ceiling
--     ceiling_confirmed_at   (stamped by the guard)
--     created_by / updated_by
--   udin_records_guard_ceiling  (BEFORE INSERT/UPDATE, after udin_records_derive by name order)
--     * the linked filing record and audit engagement belong to the UDIN's client;
--     * a report that counts towards the ceiling (counts_towards_tax_audit_ceiling, derived from
--       report_form by 0017) and would take its signing member past the ceiling for the FY it was
--       signed in (head office and branch reports of the same assessee and year count once; revised
--       reports never count; audits signed elsewhere are added, as tax_audit_ceiling_view counts)
--       needs ceiling_confirmed_by = an active Partner, who must be the person saving it when a
--       signed-in user saves it (§6.8 "requires a Partner's confirmation to log a 61st"). It reads
--       every UDIN, whatever the caller's RLS, so an Employee's own UDIN is counted fairly.
--   udin_records_link_engagement  (AFTER INSERT/UPDATE) a UDIN linked to an audit engagement fills
--     that engagement's udin_record_id when it has none and isn't archived, so the dashboard's
--     "signed reports without a UDIN" and the UDIN reminders stop for it.
--   tax_audit_position(member, fy, record id) → the member's counted total and whether this record
--     adds a new report to it (the guard and the UDIN form's live warning use the same numbers).
--   dir3_kyc_next_due(last FY) → the next FY DIR-3 KYC Web is due and its date, from the
--     DIR3_KYC_WEB due-date rule ({everyNYears, fixed}; §6.7: every third FY, by 30 June).
--   Views (security invoker: the base tables' RLS applies; clients in the recycle bin left out):
--     udin_register                    UDIN + client, signing member, linked filing / engagement,
--                                      days from signing to generation and the 60-day check,
--                                      the membership number check (§6.2 [verify])
--     statutory_registrations_register registration + client, derived "expired" for an Active row
--                                      past its expiry date, days to expiry, the reminder window,
--                                      and the next DIR-3 KYC Web for DIN rows
--     dsc_register                     DSC + client, derived "expired", days to expiry

set search_path = public, extensions;

-- =============================================================================================
-- udin_records: new columns
-- =============================================================================================
alter table public.udin_records
  add column if not exists form26_category text
    constraint udin_records_form26_category_values check (form26_category in ('a', 'b', 'combined', 'c', 'd', 'e')),
  add column if not exists ceiling_confirmed_by uuid references public.profiles (id) on delete set null,
  add column if not exists ceiling_confirmed_at timestamptz,
  add column if not exists created_by uuid,
  add column if not exists updated_by uuid;

alter table public.udin_records
  add constraint udin_records_form26_category_only_for_form26 check (form26_category is null or report_form = 'FORM_26');

comment on column public.udin_records.form26_category is
  'Form 26 (Income-tax Act, 2025): the s.44AB clause it replaces; a, b and combined count towards the ceiling [verify] (§6.8).';
comment on column public.udin_records.ceiling_confirmed_by is
  'The Partner who confirmed logging this tax audit past the ICAI ceiling for the year (§6.8).';

-- =============================================================================================
-- tax_audit_position(member, fy, record id)
--   counted   reports the member signed in the FY that count, after the head office / branch rule,
--             leaving out p_record_id, plus audits signed elsewhere
--   adds      true when the record's report key isn't already counted (always true for a key the
--             record shares with nobody)
--   ceiling   the ICAI ceiling in force on 1 April of the FY (statutory parameter)
-- =============================================================================================
create or replace function public.udin_report_key(p_client_id uuid, p_financial_year text, p_filing_record_id uuid, p_audit_engagement_id uuid, p_id uuid)
returns text
language sql
stable
security definer
set search_path = public, extensions
as $$
  select case
    when p_client_id is null then p_id::text
    else p_client_id::text || '|' || coalesce(
      p_financial_year,
      (select fr.financial_year from public.filing_records fr where fr.id = p_filing_record_id),
      (select ae.financial_year from public.audit_engagements ae where ae.id = p_audit_engagement_id),
      p_id::text
    )
  end
$$;

comment on function public.udin_report_key(uuid, text, uuid, uuid, uuid) is
  'The report a UDIN is for: client + FY covered (head office and branch reports of the same assessee and year count once), as tax_audit_ceiling_view keys it (§6.8).';

create or replace function public.tax_audit_position(p_member uuid, p_fy text, p_record_id uuid default null, p_key text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_counted int;
  v_elsewhere int;
  v_ceiling int;
  v_adds boolean := true;
begin
  if p_member is null or not public.is_fy_label(p_fy) then
    return jsonb_build_object('counted', 0, 'elsewhere', 0, 'adds', false, 'ceiling', null);
  end if;
  -- A signed-in Employee may only ask about themselves; Partners and Managers about anyone. (The
  -- guard calls this for the row being saved, and RLS lets an Employee save only their own UDINs.)
  -- The jobs and the service role have no auth.uid().
  if auth.uid() is not null and not public.is_manager_or_partner() and p_member is distinct from auth.uid() then
    raise exception 'USER: You can see only your own tax-audit count.' using errcode = 'P0001';
  end if;

  with keys as (
    select distinct public.udin_report_key(u.client_id, u.financial_year, u.filing_record_id, u.audit_engagement_id, u.id) as k
    from public.udin_records u
    where u.signing_partner_id = p_member
      and public.financial_year_label(u.signed_on) = p_fy
      and u.counts_towards_tax_audit_ceiling
      and not u.is_revised
      and (p_record_id is null or u.id <> p_record_id)
  )
  select count(*)::int, coalesce(bool_and(k is distinct from p_key), true)
    into v_counted, v_adds
  from keys;

  select coalesce(sum(e.audits_signed_elsewhere), 0)::int into v_elsewhere
  from public.tax_audit_external_counts e
  where e.member_profile_id = p_member and e.financial_year = p_fy;

  v_ceiling := public.jsonb_to_numeric(public.statutory_param_value('audit.tax_audit_ceiling', public.fy_start_date(p_fy)))::int;

  return jsonb_build_object(
    'counted', v_counted + v_elsewhere,
    'in_firm', v_counted,
    'elsewhere', v_elsewhere,
    'adds', p_key is null or v_adds,
    'ceiling', v_ceiling
  );
end;
$$;

comment on function public.tax_audit_position(uuid, text, uuid, text) is
  'A member''s tax audits counted for an FY (signed in the firm, head office/branch once, revised never, plus signed elsewhere), leaving one record out, and whether a report key adds to it (§6.8).';

-- =============================================================================================
-- udin_records_guard_ceiling (BEFORE INSERT OR UPDATE): same-client links and the 61st audit.
-- Security definer: it must count every UDIN of the member, not just the ones the caller can see.
-- =============================================================================================
create or replace function public.udin_records_guard_ceiling()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_fy text;
  v_key text;
  v_pos jsonb;
  v_total int;
  v_ceiling int;
  v_name text;
  v_link_client uuid;
begin
  -- Links point at this client's records.
  if new.filing_record_id is not null and (tg_op = 'INSERT' or new.filing_record_id is distinct from old.filing_record_id) then
    select fr.client_id into v_link_client from public.filing_records fr where fr.id = new.filing_record_id;
    if v_link_client is distinct from new.client_id then
      raise exception 'USER: The linked filing record belongs to another client.' using errcode = 'P0001';
    end if;
  end if;
  if new.audit_engagement_id is not null and (tg_op = 'INSERT' or new.audit_engagement_id is distinct from old.audit_engagement_id) then
    select ae.client_id into v_link_client from public.audit_engagements ae where ae.id = new.audit_engagement_id;
    if v_link_client is distinct from new.client_id then
      raise exception 'USER: The linked audit engagement belongs to another client.' using errcode = 'P0001';
    end if;
  end if;

  if not coalesce(new.counts_towards_tax_audit_ceiling, false) or new.is_revised or new.signing_partner_id is null then
    return new;
  end if;

  v_fy := public.financial_year_label(new.signed_on);
  v_key := public.udin_report_key(new.client_id, new.financial_year, new.filing_record_id, new.audit_engagement_id, new.id);

  -- An update that changes nothing the count depends on keeps its place.
  if tg_op = 'UPDATE'
     and coalesce(old.counts_towards_tax_audit_ceiling, false) and not old.is_revised
     and old.signing_partner_id = new.signing_partner_id
     and public.financial_year_label(old.signed_on) = v_fy
     and public.udin_report_key(old.client_id, old.financial_year, old.filing_record_id, old.audit_engagement_id, old.id) = v_key then
    return new;
  end if;

  v_pos := public.tax_audit_position(new.signing_partner_id, v_fy, new.id, v_key);
  v_ceiling := (v_pos ->> 'ceiling')::int;
  if v_ceiling is null or not coalesce((v_pos ->> 'adds')::boolean, true) then
    return new;
  end if;
  v_total := (v_pos ->> 'counted')::int + 1;
  if v_total <= v_ceiling then
    return new;
  end if;

  if new.ceiling_confirmed_by is not null
     and exists (select 1 from public.profiles p where p.id = new.ceiling_confirmed_by and p.role = 'partner' and p.is_active)
     and (auth.uid() is null or new.ceiling_confirmed_by = auth.uid()) then
    new.ceiling_confirmed_at := coalesce(new.ceiling_confirmed_at, now());
    return new;
  end if;

  select p.full_name into v_name from public.profiles p where p.id = new.signing_partner_id;
  raise exception 'USER: This would be tax audit % for % in FY %, over the ICAI ceiling of %. A Partner must confirm it to log it.',
    v_total, coalesce(v_name, 'the signing partner'), v_fy, v_ceiling
    using errcode = 'P0001';
end;
$$;

comment on function public.udin_records_guard_ceiling() is
  'Trigger: linked filing record / audit engagement of the same client; a tax audit past the ICAI ceiling needs a Partner''s confirmation (§6.8, §7.15.1).';

drop trigger if exists udin_records_guard_ceiling on public.udin_records;
create trigger udin_records_guard_ceiling
  before insert or update on public.udin_records
  for each row execute function public.udin_records_guard_ceiling();

-- =============================================================================================
-- udin_records_link_engagement (AFTER): the engagement gets its UDIN.
-- =============================================================================================
create or replace function public.udin_records_link_engagement()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if new.audit_engagement_id is not null and (tg_op = 'INSERT' or new.audit_engagement_id is distinct from old.audit_engagement_id) then
    update public.audit_engagements ae
       set udin_record_id = new.id
     where ae.id = new.audit_engagement_id
       and ae.udin_record_id is null
       and ae.archived_at is null
       and ae.client_id is not distinct from new.client_id;
  end if;
  return null;
end;
$$;

comment on function public.udin_records_link_engagement() is
  'Trigger: a UDIN linked to an audit engagement fills the engagement''s udin_record_id when empty (§6.8, §6.9).';

drop trigger if exists udin_records_link_engagement on public.udin_records;
create trigger udin_records_link_engagement
  after insert or update of audit_engagement_id on public.udin_records
  for each row execute function public.udin_records_link_engagement();

-- Who wrote it (the API caller), kept by the database.
create or replace function public.udin_records_stamp_author()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if auth.uid() is not null then
    if tg_op = 'INSERT' then
      new.created_by := coalesce(new.created_by, auth.uid());
    end if;
    new.updated_by := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists udin_records_stamp_author on public.udin_records;
create trigger udin_records_stamp_author
  before insert or update on public.udin_records
  for each row execute function public.udin_records_stamp_author();

revoke execute on function
  public.udin_records_guard_ceiling(),
  public.udin_records_link_engagement(),
  public.udin_records_stamp_author()
from public, anon, authenticated;

revoke execute on function public.udin_report_key(uuid, text, uuid, uuid, uuid), public.tax_audit_position(uuid, text, uuid, text) from public, anon;
grant execute on function public.udin_report_key(uuid, text, uuid, uuid, uuid), public.tax_audit_position(uuid, text, uuid, text) to authenticated, service_role;

-- =============================================================================================
-- dir3_kyc_next_due(last FY): from the DIR3_KYC_WEB rule (§6.7, §5.12: the cycle is data).
-- =============================================================================================
create or replace function public.dir3_kyc_next_due(p_last_fy text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_every int;
  v_fixed text;
  v_next text;
  v_year int;
begin
  if p_last_fy is null or not public.is_fy_label(p_last_fy) then
    return null;
  end if;
  select (r.rule ->> 'everyNYears')::int, r.rule ->> 'fixed'
    into v_every, v_fixed
  from public.due_date_rules r
  where r.code = 'DIR3_KYC_WEB'
  order by r.effective_from desc
  limit 1;
  v_every := coalesce(v_every, 3);
  v_fixed := coalesce(v_fixed, '06-30');
  v_next := public.financial_year_label((public.fy_start_date(p_last_fy) + make_interval(years => v_every))::date);
  v_year := extract(year from public.fy_start_date(v_next))::int;
  return jsonb_build_object(
    'next_fy', v_next,
    'due', make_date(v_year, split_part(v_fixed, '-', 1)::int, split_part(v_fixed, '-', 2)::int)
  );
end;
$$;

comment on function public.dir3_kyc_next_due(text) is
  'The next FY DIR-3 KYC Web is due after the one last filed, and its date, from the DIR3_KYC_WEB rule (every third FY by 30 June, §6.7).';

revoke execute on function public.dir3_kyc_next_due(text) from public, anon;
grant execute on function public.dir3_kyc_next_due(text) to authenticated, service_role;

-- =============================================================================================
-- Views
-- =============================================================================================
create or replace view public.udin_register with (security_invoker = true) as
select
  u.id,
  u.udin::text as udin,
  u.client_id,
  c.display_name as client_name,
  c.client_code::text as client_code,
  u.document_type,
  u.document_date,
  u.report_form,
  u.form26_category,
  u.financial_year,
  u.signed_on,
  u.generated_on,
  public.financial_year_label(u.signed_on) as signed_fy,
  (u.generated_on - u.signed_on) as days_to_generate,
  coalesce(public.jsonb_to_numeric(public.statutory_param_value('udin.generation_days', u.signed_on))::int, 60) as generation_days,
  (u.generated_on - u.signed_on) > coalesce(public.jsonb_to_numeric(public.statutory_param_value('udin.generation_days', u.signed_on))::int, 60) as generated_late,
  u.signing_partner_id,
  coalesce(sp.full_name, sd.full_name) as signing_partner_name,
  sp.icai_membership_no as signing_membership_no,
  case
    when sp.icai_membership_no is null or btrim(sp.icai_membership_no) !~ '^[0-9]{1,6}$' then null
    else substr(u.udin::text, 3, 6) <> lpad(btrim(sp.icai_membership_no), 6, '0')
  end as membership_mismatch,
  u.is_revised,
  u.counts_towards_tax_audit_ceiling,
  u.ceiling_confirmed_by,
  u.ceiling_confirmed_at,
  u.filing_record_id,
  fr.filing_type as filing_form,
  fr.period as filing_period,
  fr.financial_year as filing_financial_year,
  fr.acknowledgement_no as filing_acknowledgement_no,
  u.audit_engagement_id,
  ae.audit_type as engagement_audit_type,
  ae.financial_year as engagement_financial_year,
  u.remarks,
  u.created_by,
  u.updated_by,
  u.created_at,
  u.updated_at
from public.udin_records u
left join public.clients c on c.id = u.client_id
left join public.profiles sp on sp.id = u.signing_partner_id
left join public.employee_directory sd on sd.profile_id = u.signing_partner_id
left join public.filing_records fr on fr.id = u.filing_record_id
left join public.audit_engagements ae on ae.id = u.audit_engagement_id
where u.client_id is null or c.deleted_at is null;

comment on view public.udin_register is
  'The UDIN register (§7.15.1): client, signing member, linked filing / audit engagement, the 60-day check and the membership number check (§6.2, §6.8).';

create or replace view public.statutory_registrations_register with (security_invoker = true) as
select
  r.id,
  r.client_id,
  c.display_name as client_name,
  c.client_code::text as client_code,
  c.owner_employee_id,
  r.registration_type,
  r.registration_number,
  r.jurisdiction,
  r.issue_date,
  r.expiry_date,
  r.reminder_days,
  r.status,
  case when r.status = 'active' and r.expiry_date is not null and r.expiry_date < public.today_ist() then 'expired' else r.status::text end as display_status,
  case when r.expiry_date is not null then r.expiry_date - public.today_ist() end as days_to_expiry,
  (r.status = 'active' and r.expiry_date is not null and r.expiry_date >= public.today_ist() and r.expiry_date - public.today_ist() <= r.reminder_days) as in_reminder_window,
  r.last_dir3_kyc_fy,
  case when r.registration_type = 'DIN' then public.dir3_kyc_next_due(r.last_dir3_kyc_fy) ->> 'next_fy' end as next_dir3_kyc_fy,
  case when r.registration_type = 'DIN' then (public.dir3_kyc_next_due(r.last_dir3_kyc_fy) ->> 'due')::date end as next_dir3_kyc_due,
  r.notes,
  r.created_at,
  r.updated_at
from public.statutory_registrations r
join public.clients c on c.id = r.client_id and c.deleted_at is null;

comment on view public.statutory_registrations_register is
  'Statutory registrations with the client, a derived Expired for Active rows past their expiry, the reminder window and the next DIR-3 KYC Web for DINs (§7.15.1, §6.7, §0.1 rule 10).';

create or replace view public.dsc_register with (security_invoker = true) as
select
  d.id,
  d.client_id,
  c.display_name as client_name,
  c.client_code::text as client_code,
  c.owner_employee_id,
  d.holder_name,
  d.holder_pan::text as holder_pan,
  d.dsc_class,
  d.serial_number,
  d.issued_by,
  d.issue_date,
  d.expiry_date,
  d.custody,
  d.status,
  case when d.status = 'active' and d.expiry_date < public.today_ist() then 'expired' else d.status::text end as display_status,
  d.expiry_date - public.today_ist() as days_to_expiry,
  d.notes,
  d.created_at,
  d.updated_at
from public.dsc_records d
join public.clients c on c.id = d.client_id and c.deleted_at is null;

comment on view public.dsc_register is
  'DSCs with the client, a derived Expired for Active tokens past their expiry and the days left (§7.15.1, §0.1 rule 10).';

revoke all on public.udin_register, public.statutory_registrations_register, public.dsc_register from anon, public;
revoke insert, update, delete, truncate, references, trigger on public.udin_register, public.statutory_registrations_register, public.dsc_register from authenticated;
grant select on public.udin_register, public.statutory_registrations_register, public.dsc_register to authenticated, service_role;

-- Filter and sort columns of the registers (§13).
create index if not exists udin_records_client_idx on public.udin_records (client_id, signed_on desc);
create index if not exists udin_records_engagement_idx on public.udin_records (audit_engagement_id) where audit_engagement_id is not null;
create index if not exists statutory_registrations_client_idx on public.statutory_registrations (client_id, registration_type);
create index if not exists dsc_records_client_idx on public.dsc_records (client_id, expiry_date);
