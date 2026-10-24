-- 0199 · Law-table rows the audit and data-protection rules read (§5.12: parameters are data, not
-- code), and the closing guards for the quality, audit and DPDP objects of 0195–0198.
--
--   company.small_company_limits    Companies Act s.2(85) limits by period (₹2 cr / ₹20 cr from
--                                   1 Feb 2021; ₹4 cr / ₹40 cr from 15 Sep 2022; ₹10 cr / ₹100 cr from
--                                   1 Dec 2025 [verify]) for the CARO 2020 indication and the
--                                   s.141(3)(g) count.
--   caro.private_company_exemption  CARO 2020 Para 1(2)(v) limits.
--   audit.file_assembly_warn_days   remind 14 days before the SA 230 assembly date.
--   dpdp.request_response_days      90 days per request type [verify].
--   dpdp.breach_board_report_hours  72 hours [verify].
--   dpdp.request_warn_days          7 days.
-- The same rows are AUDIT_SEED_PARAMETERS (lib/domain/audit-stages.ts) and DPDP_SEED_PARAMETERS
-- (lib/domain/dpdp.ts); tests/db/quality.test.ts checks they match. Idempotent: an existing
-- (key, effective_from) row — and any verification a Partner recorded on it — is never overwritten.
-- Amounts in rupees.
--
-- This migration doesn't stamp app_meta.schema_version (the integrator stamps the wave).

set search_path = public, extensions;

insert into public.statutory_parameters (key, value, effective_from, effective_to, statute, section_ref, source_ref, notes, verified)
values
  ('company.small_company_limits', '{"paid_up_capital":20000000,"turnover":200000000}'::jsonb, '2021-04-01', '2022-09-14'::date, 'Companies Act, 2013', 's.2(85); Companies (Specification of Definitions Details) Rules, 2014, Rule 2(1)(t)', 'G.S.R. 92(E) dated 1 Feb 2021', 'Small company: not a public company, paid-up capital up to ₹2 crore and turnover up to ₹20 crore. Holding, subsidiary, Section 8 and special-Act companies are never small.', true),
  ('company.small_company_limits', '{"paid_up_capital":40000000,"turnover":400000000}'::jsonb, '2022-09-15', '2025-11-30'::date, 'Companies Act, 2013', 's.2(85); Companies (Specification of Definitions Details) Rules, 2014, Rule 2(1)(t)', 'G.S.R. 700(E) dated 15 Sep 2022', 'Small company: paid-up capital up to ₹4 crore and turnover up to ₹40 crore.', true),
  ('company.small_company_limits', '{"paid_up_capital":100000000,"turnover":1000000000}'::jsonb, '2025-12-01', null::date, 'Companies Act, 2013', 's.2(85); Companies (Specification of Definitions Details) Rules, 2014, Rule 2(1)(t)', 'MCA amendment in force from 1 Dec 2025 [verify]', 'Small company: paid-up capital up to ₹10 crore and turnover up to ₹100 crore, as amended with effect from 1 Dec 2025 (§6.9). [verify] the notification.', false),
  ('caro.private_company_exemption', '{"capital_and_reserves":10000000,"borrowings":10000000,"revenue":100000000}'::jsonb, '2021-04-01', null::date, 'Companies (Auditor''s Report) Order, 2020', 'Para 1(2)(v)', 'CARO 2020, S.O. 849(E) dated 25 Feb 2020, applicable from FY 2021-22', 'CARO doesn''t apply to a private company (not a holding or subsidiary of a public company) with paid-up capital and reserves up to ₹1 crore, borrowings from banks and financial institutions never above ₹1 crore in the year, and revenue up to ₹10 crore.', true),
  ('audit.file_assembly_warn_days', '14'::jsonb, '2009-04-01', null::date, 'Firm practice', 'SA 230 file assembly reminder', 'TaxWise Practice OS specification §6.9', 'Remind the engagement partner this many days before the 60-day file assembly date.', true),
  ('dpdp.request_response_days', '{"access":90,"correction":90,"erasure":90,"grievance":90,"nomination":90}'::jsonb, '2025-11-13', null::date, 'Digital Personal Data Protection Rules, 2025', 'Rule 14(3) (grievance redressal) [verify]', 'DPDP Rules, 2025, notified November 2025 [verify the commencement dates]', 'Days from receipt to answer a data principal. The Rules set 90 days as the outer limit for grievances; the firm uses the same limit for access, correction, erasure and nomination until it adopts a shorter service standard. [verify] (§6.10).', false),
  ('dpdp.breach_board_report_hours', '72'::jsonb, '2025-11-13', null::date, 'Digital Personal Data Protection Rules, 2025', 'Rule 7(2) (intimation of personal data breach) [verify]', 'DPDP Rules, 2025 [verify]', 'The Data Protection Board is told of a breach without delay, with the detailed report within 72 hours of becoming aware of it; affected people are told without delay. [verify] (§6.10).', false),
  ('dpdp.request_warn_days', '7'::jsonb, '2025-11-13', null::date, 'Firm practice', 'DPDP request reminders', 'TaxWise Practice OS specification §6.10', 'Remind the Partners this many days before a data principal''s request is due.', true)
on conflict (key, effective_from) do nothing;

-- Every table has RLS on (§0.1 rule 8), including those added by 0195–0198.
do $$
declare
  r record;
begin
  for r in
    select c.oid::regclass as tbl
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
  loop
    execute format('alter table %s enable row level security', r.tbl);
  end loop;
end;
$$;

-- The read models are SELECT-only for the API roles (a view written through would bypass RLS).
revoke insert, update, delete, truncate, references, trigger on
  public.audit_engagements_list,
  public.kyc_register,
  public.documents_for_disposal,
  public.data_requests_view,
  public.data_incidents_view
from public, anon, authenticated;
revoke all on
  public.audit_engagements_list,
  public.kyc_register,
  public.documents_for_disposal,
  public.data_requests_view,
  public.data_incidents_view
from anon;
grant select on
  public.audit_engagements_list,
  public.kyc_register,
  public.documents_for_disposal,
  public.data_requests_view,
  public.data_incidents_view
to authenticated, service_role;
