-- 42 · statutory_parameters for practice rules: ICAI limits and UDIN (§6.8), document retention
-- (§6.8, §5.8), capacity bands (§7.11.4), presence thresholds (§7.12), task escalation (§7.6.7),
-- quotation follow-ups (§7.5.3) and appeal limitation periods (§7.8.4). §16 content only: law and
-- firm-practice parameters, no clients, no users, no demo data. Settled law and firm practice are
-- seeded verified = true; [verify] items verified = false, so the Law & rules page lists them as
-- "awaiting partner confirmation" (§6, §7.21).
--
-- Idempotent: on conflict (key, effective_from) do nothing, so re-running never overwrites a value
-- or a verification a Partner has since recorded. Amounts inside values are in RUPEES.
-- The same rows live in the TS seed lists (CEILING_SEED_PARAMETERS, RETENTION_SEED_PARAMETERS,
-- CAPACITY_SEED_PARAMETERS, PRESENCE_SEED_PARAMETERS, ESCALATION_SEED_PARAMETERS);
-- tests/unit/ceiling.test.ts checks that this file matches them.
--
-- Keys:
--   ICAI (lib/domain/ceiling.ts)
--   udin.generation_days          number, 60: UDIN within 60 days of signing.
--   audit.tax_audit_ceiling       number, 60: tax audit reports per member per FY (read by
--                                 tax_audit_ceiling_view).
--   audit.tax_audit_ceiling_warn_at number[], [50,58]: warning counts (read by tax_audit_ceiling_view).
--   audit.tax_audit_form26_categories {"counted":[...],"notCounted":[...]}: Form 26 mapping [verify].
--   audit.company_audit_limit     number, 20: company audits per partner (s.141(3)(g)).
--   audit.company_audit_limit_warn_from number, 18: warn from this countable company audit.
--   audit.company_audit_private_paid_up_exclusion {"amount": ₹}: private companies below ₹100 crore
--                                 paid-up don't count.
--   peer_review.expiry_warning_days number, 90: warn before the peer review certificate expires.
--   kyc.reconfirm_months          number, 12: client KYC is re-confirmed annually (KYC Norms).
--   Retention (lib/domain/retention.ts)
--   retention.working_papers_years number, 7: years from the auditor's report (SQC 1).
--   retention.company_books_financial_years number, 8: FYs for a company's books (s.128(5)).
--   retention.gst_records_months  number, 72: months from the GST annual return's due date (s.36).
--   retention.gst_annual_return_due {"month":12,"day":31,"yearOffset":0}: 31 Dec after the FY (s.44).
--   retention.income_tax_years_after_ay number, 6: years from the end of the assessment year
--                                 (Rule 6F(5); the 2026 Rules row is [verify]).
--   retention.default_years       number, 7: years from upload when no rule applies (§5.8).
--   Firm practice (lib/domain/capacity.ts, presence.ts, escalation.ts)
--   capacity.bands                {"busy":1.5,"tight":2.5,"over":4} (firm_settings.capacity_thresholds
--                                 is the editable copy).
--   presence.thresholds           {"heartbeatMinutes":5,"creditCapMinutes":6,"idleAfterMinutes":20,
--                                 "staleAfterMinutes":45}; idle must stay below stale.
--   escalation.overdue_days       {"level1":3,"level2":7}: overdue days before each level.
--   quotation.follow_up_days      number[], [3,7,14] (firm_settings.quotation_follow_up_days is the
--                                 editable copy).
--   Appeal limitation (lib/domain/escalation.ts), all [verify] (§7.8.4)
--   appeal.income_tax.first_appeal {"days":30}: CIT(A), from the order.
--   appeal.income_tax.tribunal    {"days":60}: ITAT.
--   appeal.gst.first_appeal       {"months":3}: GST Appellate Authority.
--   appeal.gst.tribunal           {"months":3}: GST Appellate Tribunal.

insert into public.statutory_parameters
  (key, value, effective_from, effective_to, statute, section_ref, source_ref, notes, verified)
values
  -- ICAI: UDIN, tax-audit ceiling, company audit limit, peer review (§6.8)
  ('udin.generation_days', '60'::jsonb, '2021-09-17', null, 'ICAI UDIN Guidelines', 'UDIN for certificates, GST/tax audit reports and audit reports', 'ICAI Council decision dated 17 Sep 2021', 'A UDIN must be generated within 60 days of signing the document, or at once if a regulator asks (§6.8). The dashboard lists signed documents with no UDIN and the days left.', true),
  ('audit.tax_audit_ceiling', '60'::jsonb, '2026-04-01', null, 'Chartered Accountants (Limit on Number of Tax Audits) Guidelines, 2025', 'Tax audits per member per financial year', 'ICAI Guidelines, 2025, in force from 1 Apr 2026; enforced on the UDIN portal (FAQs on UDIN ceiling on tax audit)', '60 tax audit reports per member per FY, counted by the date signed. Counted: 3CA, 3CB u/s 44AB(a), (b) and combined. Not counted: 3CB u/s 44AB(c), (d), (e). Head office and branch audits of the same assessee and year count as one; revised reports don''t count separately; audits in individual capacity and across firms are aggregated.', true),
  ('audit.tax_audit_ceiling_warn_at', '[50,58]'::jsonb, '2026-04-01', null, 'Chartered Accountants (Limit on Number of Tax Audits) Guidelines, 2025', '§6.8 firm practice: ceiling warnings', 'TaxWise Practice OS specification §6.8', 'Warn the partner at 50 and 58 tax audits in the FY; logging a 61st needs a Partner''s confirmation (§6.8).', true),
  ('audit.tax_audit_form26_categories', '{"counted":["a","b","combined"],"notCounted":["c","d","e"]}'::jsonb, '2026-04-01', null, 'Chartered Accountants (Limit on Number of Tax Audits) Guidelines, 2025', 'Form 26 under the Income-tax Act, 2025 [verify]', '§6.8: the equivalent categories apply to Form 26', 'Form 26 reports count like 3CB under the s.44AB clause they replace: (a), (b) and combined count; (c), (d) and (e) don''t. [verify] the mapping to the 2025 Act''s tax audit provision.', false),
  ('audit.company_audit_limit', '20'::jsonb, '2014-04-01', null, 'Companies Act, 2013', 's.141(3)(g)', 'Companies Act, 2013, s.141(3)(g), as amended', 'No more than 20 company audits per partner, excluding one person companies, small companies, dormant companies and private companies with paid-up share capital under ₹100 crore.', true),
  ('audit.company_audit_limit_warn_from', '18'::jsonb, '2014-04-01', null, 'Companies Act, 2013', '§6.8 firm practice: company audit warning', 'TaxWise Practice OS specification §6.8', 'Warn when a Partner is engaging partner on the 18th or later countable company audit (§6.8).', true),
  ('audit.company_audit_private_paid_up_exclusion', '{"amount":1000000000}'::jsonb, '2015-06-05', null, 'Companies Act, 2013', 's.141(3)(g)', 'Companies Act, 2013, s.141(3)(g), as amended (MCA exemption notification for private companies, G.S.R. 464(E) dated 5 Jun 2015)', 'Private companies with paid-up share capital under ₹100 crore (₹1,00,00,00,000) don''t count towards the 20-audit limit. Amount in rupees.', true),
  ('peer_review.expiry_warning_days', '90'::jsonb, '2022-10-01', null, 'ICAI Peer Review Guidelines 2022', '§6.8 firm practice: certificate expiry warning', 'Peer Review Guidelines 2022 (effective 1 Oct 2022); TaxWise Practice OS specification §6.8', 'Warn 90 days before the peer review certificate expires; check it is valid on the acceptance date of a statutory audit that needs a peer-reviewed auditor.', true),
  ('kyc.reconfirm_months', '12'::jsonb, '2017-01-01', null, 'ICAI KYC Norms for members in practice', 'Annual re-confirmation of client KYC', 'ICAI KYC Norms, mandatory for attest engagements from 1 Jan 2017', 'Client KYC is complete before an audit or certification engagement moves past acceptance, and is re-confirmed annually (§6.8).', true),
  -- Retention (§6.8, §5.8)
  ('retention.working_papers_years', '7'::jsonb, '2009-04-01', null, 'ICAI Standard on Quality Control (SQC) 1', 'SQC 1, retention of engagement documentation', 'SQC 1 (continues to apply: SQM 1 and SQM 2 deferred by ICAI on 31 Mar 2026)', 'Engagement documentation and working papers are kept for at least 7 years from the date of the auditor''s report (§6.8).', true),
  ('retention.company_books_financial_years', '8'::jsonb, '2014-04-01', null, 'Companies Act, 2013', 's.128(5)', 'Companies Act, 2013, s.128(5)', 'A company''s books of account are kept for at least 8 financial years, so the books of FY X held by the firm are kept to the end of FY X + 8 (§6.8).', true),
  ('retention.gst_records_months', '72'::jsonb, '2017-07-01', null, 'Central Goods and Services Tax Act, 2017', 's.36', 'CGST Act, 2017, s.36', 'GST accounts and records are kept until 72 months from the due date of the annual return for the year they relate to (§6.8).', true),
  ('retention.gst_annual_return_due', '{"month":12,"day":31,"yearOffset":0}'::jsonb, '2017-07-01', null, 'Central Goods and Services Tax Act, 2017', 's.44', 'CGST Act, 2017, s.44', 'The annual return is due on 31 December following the end of the FY. Where a notification extended it, retention runs from the extended date, which the caller passes in.', true),
  ('retention.income_tax_years_after_ay', '6'::jsonb, '1962-04-01', '2026-03-31', 'Income-tax Rules, 1962', 'Rule 6F(5)', 'Income-tax Rules, 1962, Rule 6F(5)', 'Books and documents of specified professions are kept for 6 years from the end of the relevant assessment year (§6.8).', true),
  ('retention.income_tax_years_after_ay', '6'::jsonb, '2026-04-01', null, 'Income-tax Rules, 2026', 'Rule 6F equivalent [verify]', '§6.8: the period the income-tax rules prescribe', 'Carried forward at 6 years from the end of the relevant year until the 2026 Rules are checked. [verify] the 2026 Rules (§6.8).', false),
  ('retention.default_years', '7'::jsonb, '2009-04-01', null, 'Firm practice', '§5.8 documents.retention_until default', 'TaxWise Practice OS specification §5.8', 'When no specific rule applies, a document is kept for 7 years from its upload date (§5.8).', true),
  -- Capacity bands (§7.11.4)
  ('capacity.bands', '{"busy":1.5,"tight":2.5,"over":4}'::jsonb, '2026-04-01', null, 'Firm practice', '§7.11.4 capacity bands', 'TaxWise Practice OS specification §7.11.4', 'Tasks per working day: CLEAR below 1.5, BUSY from 1.5, TIGHT from 2.5, OVER from 4. firm_settings.capacity_thresholds is the copy used at run time (Settings → Working hours).', true),
  -- Presence thresholds (§7.12)
  ('presence.thresholds', '{"heartbeatMinutes":5,"creditCapMinutes":6,"idleAfterMinutes":20,"staleAfterMinutes":45}'::jsonb, '2026-04-01', null, 'Firm practice', '§7.12 presence and attendance engine', 'TaxWise Practice OS specification §7.12', 'Heartbeat every 5 minutes while the app is visible; each beat credits at most 6 minutes; Online under 20 minutes, Idle 20–45, Offline after 45, when a silent session is closed at its last activity. The idle threshold must stay below the stale threshold.', true),
  -- Escalation, quotation follow-ups (§7.6.7, §7.5.3) and appeal limitation (§7.8.4)
  ('escalation.overdue_days', '{"level1":3,"level2":7}'::jsonb, '2026-04-01', null, 'Firm practice', '§7.6.7 escalation', 'TaxWise Practice OS specification §7.6.7, §8', 'A task overdue by more than 3 days reaches level 1 (the assignee and Managers are told); by more than 7 days, level 2 (Partners are told). Re-arms after a reopen or a due-date change.', true),
  ('quotation.follow_up_days', '[3,7,14]'::jsonb, '2026-04-01', null, 'Firm practice', '§7.5.3 quotation follow-ups', 'TaxWise Practice OS specification §7.5.3', 'Automatic follow-ups on day 3, 7 and 14 after a quotation is sent, while it is still Sent or Viewed and not expired. firm_settings.quotation_follow_up_days is the copy used at run time.', true),
  ('appeal.income_tax.first_appeal', '{"days":30}'::jsonb, '1962-04-01', null, 'Income-tax Act, 1961', 's.249(2) [verify] the Income-tax Act, 2025 equivalent', 'Income-tax Act, 1961, s.249(2)', 'First appeal to the CIT(A): 30 days from the order (strictly, from service of the order or demand notice). [verify] against the current statute before relying on it (§7.8.4).', false),
  ('appeal.income_tax.tribunal', '{"days":60}'::jsonb, '1962-04-01', null, 'Income-tax Act, 1961', 's.253(3) [verify] the Income-tax Act, 2025 equivalent', 'Income-tax Act, 1961, s.253(3)', 'Appeal to the Income Tax Appellate Tribunal: 60 days from the date the order is communicated. [verify] against the current statute before relying on it (§7.8.4).', false),
  ('appeal.gst.first_appeal', '{"months":3}'::jsonb, '2017-07-01', null, 'Central Goods and Services Tax Act, 2017', 's.107(1) [verify]', 'CGST Act, 2017, s.107(1)', 'First appeal to the Appellate Authority: 3 months from the date the order is communicated. [verify] against the current statute before relying on it (§7.8.4).', false),
  ('appeal.gst.tribunal', '{"months":3}'::jsonb, '2017-07-01', null, 'Central Goods and Services Tax Act, 2017', 's.112(1) [verify]', 'CGST Act, 2017, s.112(1)', 'Appeal to the GST Appellate Tribunal: 3 months from the date the order appealed against is communicated. [verify] against the current statute and the GSTAT notifications before relying on it (§7.8.4).', false)
on conflict (key, effective_from) do nothing;
