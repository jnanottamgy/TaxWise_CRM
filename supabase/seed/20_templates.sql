-- 20 · Default templates and firm-practice lists (§16 "Templates" and "WhatsApp", §7.7, §6.9,
-- §7.13.4, §7.25.2, §6.10, §6.8, §5.13).
-- §16 content only: ops templates, job templates, message templates, the draft privacy notice, the
-- five empty firm WhatsApp number slots and the SQC 1 quality manual checklist. No clients, no
-- users, no demo data.
--
-- Idempotent, and it never overwrites what Partners have since edited:
--   * recurring_compliance_templates, message_templates, firm_whatsapp_numbers, privacy_notices:
--     ON CONFLICT on their unique key DO NOTHING.
--   * job_templates: ON CONFLICT (name) DO NOTHING, and a template's items are inserted in the same
--     statement only when the template itself was just inserted. Re-running never adds, restores or
--     duplicates items under a template that already exists.
--   * quality_manual_items (no natural unique key): inserted only where no item with the same
--     element and title exists.
--
-- Job template offsets. job_template_items.offset_days is "days BEFORE the job's due date; negative
-- = after" (§5.5, 0006). §16 writes the same steps as signed offsets from the due date ("collect
-- sales register (−9)" = 9 days before; "issue Form 16A/131 (+15)" = 15 days after), so each §16
-- number is stored with its sign flipped: −9 → 9, 0 → 0, +15 → −15.
--
-- Message templates use only the §7.13.4 variables (lib/domain/templates.ts TEMPLATE_VARIABLES).
-- Email bodies end with the sender's sign-off; the firm's name, address, phone and "Powered by
-- J-TACS" footer is added by the email renderer (§7.13.5). WhatsApp drafts carry no sign-off: the
-- sender's signature ("– {first_name}") is appended to drafts on the shared numbers (§7.13.2).

set search_path = public, extensions;

-- =================================================================================================
-- recurring_compliance_templates: internal prep steps ahead of statutory dates (§7.7 defaults).
-- Same rows as OPS_TEMPLATE_DEFAULTS in lib/domain/statutory-calendar.ts. period_offset 1 = the
-- work is for the previous period (previous month; previous FY for the September audit steps).
-- =================================================================================================
insert into public.recurring_compliance_templates
  (service_type, compliance_type, title, description, frequency, due_day_of_month, due_month, period_offset, reminder_days, is_active)
values
  ('bookkeeping', 'custom',  'Collect bank statements',         'Bank statements for the previous month.',                                          'monthly', 5,  null, 1, 3, true),
  ('bookkeeping', 'custom',  'Collect sales data',              'Sales data for the previous month.',                                               'monthly', 7,  null, 1, 3, true),
  ('bookkeeping', 'custom',  'Collect purchase data',           'Purchase data for the previous month.',                                            'monthly', 7,  null, 1, 3, true),
  ('bookkeeping', 'custom',  'Collect expense receipts',        'Expense receipts for the previous month.',                                         'monthly', 10, null, 1, 3, true),
  ('gst',         'gstr_1',  'GSTR-1 data collection',          'Sales data for the previous month''s GSTR-1.',                                     'monthly', 5,  null, 1, 3, true),
  ('gst',         'gstr_3b', 'GSTR-3B reconciliation prep',     'Reconcile purchases with GSTR-2B / IMS for the previous month''s GSTR-3B.',        'monthly', 14, null, 1, 3, true),
  ('income_tax',  'itr',     'Tax planning review',             'Review the year''s tax position before the 15 March advance tax instalment.',     'annual',  1,  3,    0, 3, true),
  ('audit',       'audit',   'Audit documentation collection',  'Collect the documents for the previous financial year''s audit.',                  'annual',  1,  9,    1, 3, true),
  ('audit',       'audit',   'Financial statement preparation', 'Prepare the previous financial year''s financial statements.',                     'annual',  15, 9,    1, 3, true)
on conflict on constraint recurring_compliance_templates_service_type_title_key do nothing;

-- =================================================================================================
-- Job templates (§16, §6.9). Each statement inserts one template and, only if it was new, its steps.
-- Item columns: (sort_order, offset_days = days before the job's due date, title, description).
-- default_lead_days: how far ahead of the due date a job from this template is normally created.
-- =================================================================================================

-- Monthly GST filing (§16) ------------------------------------------------------------------------
with t as (
  insert into public.job_templates (name, service_type, description, default_lead_days)
  values (
    'Monthly GST filing', 'gst',
    'GSTR-1 and GSTR-3B for a monthly filer. The job is due on the GSTR-1 date (the 11th of the next month); GSTR-3B follows by its own due date (the 20th).',
    10
  )
  on conflict (name) do nothing
  returning id
)
insert into public.job_template_items (template_id, sort_order, offset_days, title, description)
select t.id, i.sort_order, i.offset_days, i.title, i.description
from t cross join (values
  (1,  9, 'Collect sales register',
       'Sales register for the month, with e-invoices, credit and debit notes, and advances received.'),
  (2,  9, 'Collect purchase register',
       'Purchase register for the month, with expense bills and imports of services.'),
  (3,  6, 'GSTR-2B/IMS reconciliation',
       'Match the purchase register with GSTR-2B. In IMS, accept, reject or keep pending each inward invoice (no action counts as acceptance). List the suppliers to follow up.'),
  (4,  5, 'Review auto-populated liability and correct through GSTR-1A if needed',
       'The liability auto-populated in GSTR-3B from GSTR-1/1A/IFF can''t be edited in GSTR-3B (from the July 2025 period). Correct it through GSTR-1A, once per period, before filing GSTR-3B.'),
  (5,  4, 'Prepare GSTR-1',
       'B2B and B2C supplies, credit and debit notes, HSN/SAC summary and documents issued. Share the summary with the client for confirmation.'),
  (6,  0, 'File GSTR-1 & record ARN',
       'File GSTR-1 with DSC or EVC and record the ARN.'),
  (7, -9, 'File GSTR-3B & record ARN',
       'By the GSTR-3B due date: the 20th, 9 days after this job''s GSTR-1 date. Set off the liability (ITC first, then cash), file, and record the ARN.')
) as i(sort_order, offset_days, title, description);

-- Quarterly TDS return (§16) ----------------------------------------------------------------------
with t as (
  insert into public.job_templates (name, service_type, description, default_lead_days)
  values (
    'Quarterly TDS return', 'tds',
    'Quarterly TDS statement: 24Q, 26Q or 27Q (Forms 138, 140 and 144 from tax year 2026-27). The job is due on the statement due date: 31 July, 31 October, 31 January or 31 May.',
    12
  )
  on conflict (name) do nothing
  returning id
)
insert into public.job_template_items (template_id, sort_order, offset_days, title, description)
select t.id, i.sort_order, i.offset_days, i.title, i.description
from t cross join (values
  (1,  10, 'Reconcile challans',
        'Match the TDS deposited in each challan (by the 7th of the next month; March by 30 April) with the deductions in the books. Pay any shortfall, with interest, before filing.'),
  (2,   7, 'Compile deductee data',
        'PAN, section, amount paid or credited, TDS deducted and date for every deductee, with any lower-deduction certificates. Check the PANs on TRACES.'),
  (3,   3, 'Validate FVU',
        'Prepare the statement and validate it with the latest File Validation Utility. Fix every error it reports.'),
  (4,   0, 'File return',
        'Upload the statement and record the token number.'),
  (5, -15, 'Download Conso & issue Form 16A/131',
        'Once the statement is processed, download the Conso file from TRACES and issue the TDS certificates (Form 16A; Form 131 from tax year 2026-27) within 15 days of the statement due date.')
) as i(sort_order, offset_days, title, description);

-- ITR (non-audit) (§16) ---------------------------------------------------------------------------
with t as (
  insert into public.job_templates (name, service_type, description, default_lead_days)
  values (
    'ITR (non-audit)', 'income_tax',
    'Income-tax return where no audit applies. The job is due on the return due date for the client (31 July, or 31 August for non-audit business and profession cases).',
    35
  )
  on conflict (name) do nothing
  returning id
)
insert into public.job_template_items (template_id, sort_order, offset_days, title, description)
select t.id, i.sort_order, i.offset_days, i.title, i.description
from t cross join (values
  (1, 30, 'Collect Form 16/130',
       'Form 16 (Form 130 from tax year 2026-27) from each employer, plus the client''s other income: interest, capital gains, rent, business or professional receipts, and proof of deductions.'),
  (2, 25, 'Download AIS/26AS/168',
       'Download AIS, TIS and Form 26AS (the Annual Information Statement is Form 168 from tax year 2026-27) and reconcile them with the client''s figures.'),
  (3, 15, 'Compute income & compare regimes',
       'Compute total income and tax under both regimes, side by side, and recommend one. Work out any self-assessment tax and interest payable.'),
  (4,  7, 'Client approval',
       'Share the computation and the draft return with the client and record their approval of the figures and the regime.'),
  (5,  0, 'File & e-verify',
       'File the return, e-verify it (or have the client e-verify it in time) and record the acknowledgement number.')
) as i(sort_order, offset_days, title, description);

-- Tax audit (§16, §6.9) ---------------------------------------------------------------------------
with t as (
  insert into public.job_templates (name, service_type, description, default_lead_days)
  values (
    'Tax audit', 'audit',
    'Tax audit under s.44AB of the Income-tax Act, 1961 (s.63 of the Income-tax Act, 2025), run through the Standards on Auditing stages: acceptance, planning, risk assessment, execution, completion and reporting. The job is due on the tax audit report due date; it ends with the report, the UDIN and the ceiling check.',
    75
  )
  on conflict (name) do nothing
  returning id
)
insert into public.job_template_items (template_id, sort_order, offset_days, title, description)
select t.id, i.sort_order, i.offset_days, i.title, i.description
from t cross join (values
  (1,  60, 'Acceptance: KYC complete',
        'Client KYC under the ICAI KYC Norms (mandatory for attest engagements) is complete and current for the client''s category.'),
  (2,  60, 'Acceptance: independence and conflict check',
        'Run the conflict check and record the independence answers: financial interest, relationships, other services, fee dependence.'),
  (3,  60, 'Acceptance: communication with the previous auditor',
        'Where another CA did the last tax audit, write to them before accepting and keep the proof of delivery (CA Act, First Schedule, Part I, Clause 8). Record the reply or its absence.'),
  (4,  60, 'Acceptance: tax audit ceiling check',
        'Check the signing partner''s count of tax audit reports for the financial year, including audits signed elsewhere, against the ICAI ceiling before accepting.'),
  (5,  60, 'Acceptance: engagement letter (SA 210)',
        'Issue the engagement letter (objective and scope, responsibilities, the form of report) and have it signed before the audit moves past acceptance.'),
  (6,  50, 'Planning: audit strategy and plan (SA 300)',
        'Set the overall strategy, the plan and the timetable.'),
  (7,  50, 'Planning: materiality (SA 320)',
        'Set the basis (for example a percentage of turnover, profit before tax or total assets), overall and performance materiality, and the clearly trivial amount. Record them on the engagement.'),
  (8,  45, 'Planning: team briefing',
        'Brief the team on the client, the risks, the timetable and the clauses of the report.'),
  (9,  45, 'Risk assessment: the entity, significant risks and fraud (SA 315, SA 240)',
        'Understand the business, its environment and its controls; identify the significant risks, including the risk of fraud.'),
  (10, 40, 'Risk assessment: laws and regulations (SA 250)',
        'Identify the laws that affect the accounts and the report, and any non-compliance.'),
  (11, 40, 'Risk assessment: related parties (SA 550)',
        'List the related parties and their transactions, including payments to persons specified under s.40A(2)(b).'),
  (12, 35, 'Execution: responses to assessed risks (SA 330)',
        'Design and perform the procedures that respond to each assessed risk.'),
  (13, 30, 'Execution: audit evidence and external confirmations (SA 500, SA 505)',
        'Vouch, verify and obtain confirmations. Upload the working papers to the vault and tag them to this step.'),
  (14, 25, 'Execution: analytical procedures, sampling and estimates (SA 520, SA 530, SA 540)',
        'Analytical review, sample selection and evaluation, and the accounting estimates.'),
  (15, 20, 'Execution: verify each clause of the report',
        'Verify each clause of Form 3CD (or Form 26) with evidence, and draft the particulars, observations and qualifications.'),
  (16, 12, 'Completion: evaluate misstatements (SA 450)',
        'Accumulate the misstatements found and ask management to correct them.'),
  (17, 10, 'Completion: subsequent events and going concern (SA 560, SA 570)',
        'Review events after the balance sheet date and the going-concern assumption.'),
  (18,  8, 'Completion: written representations (SA 580)',
        'Obtain the management representation letter, dated close to the report date.'),
  (19,  5, 'Completion: communication with those charged with governance (SA 260, SA 265)',
        'Communicate the significant findings and any deficiencies in internal control.'),
  (20,  0, 'Reporting: tax audit report in Form 3CA/3CB-3CD or Form 26',
        'Sign the report in Form 3CA or Form 3CB with Form 3CD (AY up to 2026-27), or in Form 26 (tax year 2026-27 onward). Upload it on the e-filing portal and have the client accept it.'),
  (21,  0, 'Reporting: UDIN',
        'Generate the UDIN within 60 days of signing, quote it when the report is uploaded, and record it in the UDIN register against the signing partner.'),
  (22,  0, 'Reporting: tax audit ceiling check',
        'Record the signed report against the signing partner''s count for the financial year (counted by the date signed: Form 3CA and Form 3CB under s.44AB(a), (b) and combined count; (c), (d) and (e) don''t). A report past the ceiling needs a Partner''s confirmation.')
) as i(sort_order, offset_days, title, description);

-- Statutory audit (Companies Act) (§16, §6.9) -----------------------------------------------------
with t as (
  insert into public.job_templates (name, service_type, description, default_lead_days)
  values (
    'Statutory audit (Companies Act)', 'audit',
    'Statutory audit of a company under the Companies Act, 2013, run through the Standards on Auditing stages from acceptance to archive, with CARO 2020 and the ADT-1 and AOC-4 hand-offs to the ROC team. The job is due on the planned date of the audit report.',
    100
  )
  on conflict (name) do nothing
  returning id
)
insert into public.job_template_items (template_id, sort_order, offset_days, title, description)
select t.id, i.sort_order, i.offset_days, i.title, i.description
from t cross join (values
  (1,  90, 'Acceptance: KYC complete',
        'Client KYC under the ICAI KYC Norms for a corporate client: PAN and CIN, and each director''s name, address and DIN.'),
  (2,  90, 'Acceptance: independence and conflict check',
        'Eligibility and disqualifications (s.141), services an auditor may not render (s.144), the conflict check and the independence answers.'),
  (3,  90, 'Acceptance: communication with the previous auditor',
        'Write to the outgoing auditor before accepting and keep the proof of delivery (CA Act, First Schedule, Part I, Clause 8). Record the reply or its absence. The audit can''t reach planning without it.'),
  (4,  90, 'Acceptance: peer review certificate check',
        'Where the company needs a peer-reviewed auditor (listed entities, large unlisted public companies, other public-interest entities), check that the firm''s peer review certificate is valid on the acceptance date.'),
  (5,  90, 'Acceptance: company audit limit check',
        'Check the engagement partner''s count of company audits against the limit in s.141(3)(g). OPCs, small companies, dormant companies and private companies below the paid-up capital limit don''t count.'),
  (6,  85, 'Acceptance: consent, eligibility certificate and ADT-1 hand-off',
        'Give the written consent and the eligibility certificate (s.139). Hand the appointment details to the ROC team: the company files ADT-1 within 15 days of the AGM that appoints the auditor.'),
  (7,  85, 'Acceptance: engagement letter (SA 210)',
        'Issue the engagement letter (objective and scope, responsibilities of the auditor and of management, the financial reporting framework, the expected form of report) and have it signed.'),
  (8,  75, 'Planning: audit strategy and plan (SA 300)',
        'Set the overall strategy, the plan and the timetable.'),
  (9,  75, 'Planning: materiality (SA 320)',
        'Set the basis (for example a percentage of revenue, profit before tax or total assets), overall and performance materiality, and the clearly trivial amount. Record them on the engagement.'),
  (10, 70, 'Planning: team briefing',
        'Brief the team on the company, the risks, the timetable and who reviews what.'),
  (11, 65, 'Risk assessment: the entity, significant risks and fraud (SA 315, SA 240)',
        'Understand the company, its environment and its internal control; identify the significant risks, including the risk of fraud.'),
  (12, 60, 'Risk assessment: laws and regulations (SA 250)',
        'Identify the laws that affect the financial statements, and any non-compliance.'),
  (13, 60, 'Risk assessment: related parties (SA 550)',
        'List the related parties and their transactions, and check approvals under s.188.'),
  (14, 50, 'Execution: responses to assessed risks (SA 330)',
        'Design and perform the procedures that respond to each assessed risk, including tests of controls.'),
  (15, 45, 'Execution: audit evidence and external confirmations (SA 500, SA 505)',
        'Vouch, verify and obtain balance confirmations. Upload the working papers to the vault and tag them to this step.'),
  (16, 35, 'Execution: analytical procedures and sampling (SA 520, SA 530)',
        'Analytical review, sample selection and evaluation.'),
  (17, 30, 'Execution: accounting estimates (SA 540)',
        'Provisions, impairment, fair values and other estimates.'),
  (18, 15, 'Completion: evaluate misstatements (SA 450)',
        'Accumulate the misstatements found and ask management to correct them.'),
  (19, 10, 'Completion: subsequent events (SA 560)',
        'Review events between the balance sheet date and the report date.'),
  (20, 10, 'Completion: going concern (SA 570)',
        'Evaluate management''s assessment of the going-concern assumption.'),
  (21,  7, 'Completion: written representations (SA 580)',
        'Obtain the management representation letter, dated close to the report date.'),
  (22,  5, 'Completion: communication with those charged with governance (SA 260, SA 265)',
        'Communicate the significant findings and any deficiencies in internal control.'),
  (23,  0, 'Reporting: opinion (SA 700, SA 705)',
        'Form the opinion (unmodified, qualified, adverse or disclaimer) and record the report type and date on the engagement.'),
  (24,  0, 'Reporting: key audit matters (SA 701)',
        'Where applicable: listed companies, or where the auditor decides to communicate them.'),
  (25,  0, 'Reporting: emphasis of matter and other matter (SA 706)',
        'Add these paragraphs where they are needed.'),
  (26,  0, 'Reporting: CARO 2020',
        'Check whether CARO 2020 applies (it doesn''t for small companies, OPCs, banking, insurance or Section 8 companies, using the small-company limits in force for the year, as amended from 1 December 2025) and report on each clause.'),
  (27,  0, 'Reporting: UDIN',
        'Generate the UDIN within 60 days of signing and record it in the UDIN register against the signing partner.'),
  (28, -5, 'Reporting: AOC-4 hand-off',
        'Hand the signed financial statements, the auditor''s report and the board''s report to the ROC team for AOC-4, due within 30 days of the AGM.'),
  (29, -60, 'Archive: assemble the final audit file (SA 230)',
        'Assemble the final audit file within 60 days of the report date, then archive the engagement: the file becomes read-only and is retained until 7 years after the report date.')
) as i(sort_order, offset_days, title, description);

-- GST audit / reconciliation (§6.9) ---------------------------------------------------------------
with t as (
  insert into public.job_templates (name, service_type, description, default_lead_days)
  values (
    'GST audit / reconciliation', 'audit',
    'A GST audit or reconciliation engagement (including certifying a GSTR-9C reconciliation), run through the Standards on Auditing stages. The job is due on the date the report or reconciliation is due.',
    60
  )
  on conflict (name) do nothing
  returning id
)
insert into public.job_template_items (template_id, sort_order, offset_days, title, description)
select t.id, i.sort_order, i.offset_days, i.title, i.description
from t cross join (values
  (1,  50, 'Acceptance: KYC, independence and engagement letter (SA 210)',
        'Client KYC under the ICAI KYC Norms, the conflict and independence check, and a signed engagement letter.'),
  (2,  45, 'Planning: scope, GSTINs and materiality (SA 300, SA 320)',
        'Agree the GSTINs, the period and the scope; set materiality.'),
  (3,  40, 'Risk assessment: high-risk areas (SA 315)',
        'Input tax credit eligibility and reversals, reverse charge, exempt and non-GST supplies, valuation and place of supply.'),
  (4,  30, 'Execution: reconcile turnover',
        'Books against GSTR-1/1A/IFF, GSTR-3B, e-invoices and e-way bills.'),
  (5,  25, 'Execution: reconcile input tax credit',
        'Books against GSTR-2B and GSTR-3B, with reversals and reverse-charge tax.'),
  (6,  20, 'Execution: evidence, confirmations and sampling (SA 500, SA 505, SA 530)',
        'Vouch and verify samples; upload the working papers to the vault and tag them to this step.'),
  (7,  10, 'Completion: differences and written representations (SA 580)',
        'Discuss the unreconciled differences, work out any additional liability (paid through DRC-03), and obtain the management representation letter.'),
  (8,   0, 'Reporting: report or reconciliation, and UDIN',
        'Issue the report or certify the reconciliation, and generate the UDIN within 60 days of signing.'),
  (9, -60, 'Archive: assemble the final file (SA 230)',
        'Assemble the final file within 60 days of the report date and retain it for 7 years.')
) as i(sort_order, offset_days, title, description);

-- Internal audit (§6.9) ---------------------------------------------------------------------------
with t as (
  insert into public.job_templates (name, service_type, description, default_lead_days)
  values (
    'Internal audit', 'audit',
    'An internal audit cycle, run through the Standards on Auditing stages. The job is due on the date the internal audit report is due.',
    45
  )
  on conflict (name) do nothing
  returning id
)
insert into public.job_template_items (template_id, sort_order, offset_days, title, description)
select t.id, i.sort_order, i.offset_days, i.title, i.description
from t cross join (values
  (1,  40, 'Acceptance: engagement letter and independence',
        'Agree the scope, areas, period, reporting line and fee in an engagement letter. A company''s statutory auditor can''t be its internal auditor (s.144): check the firm isn''t.'),
  (2,  35, 'Planning: risk-based audit plan (SA 300)',
        'Agree the areas, the plan and the timetable with management.'),
  (3,  30, 'Risk assessment: processes and controls (SA 315)',
        'Walk through each process in scope and document its risks and controls.'),
  (4,  20, 'Execution: test controls and transactions (SA 330, SA 530)',
        'Test the design and operation of the controls on samples; upload the working papers to the vault and tag them to this step.'),
  (5,  10, 'Completion: agree observations with management',
        'Agree the facts, root causes and management''s actions, with owners and dates.'),
  (6,   0, 'Reporting: internal audit report',
        'Issue the report with observations, risk ratings and the agreed actions to the audit committee or management.'),
  (7, -30, 'Follow-up: track the agreed actions',
        'Follow up the agreed actions and report their status in the next cycle.'),
  (8, -60, 'Archive: assemble the final file (SA 230)',
        'Assemble the final file within 60 days of the report date and retain it for 7 years.')
) as i(sort_order, offset_days, title, description);

-- Bank branch audit (§6.9) ------------------------------------------------------------------------
with t as (
  insert into public.job_templates (name, service_type, description, default_lead_days)
  values (
    'Bank branch audit', 'audit',
    'Statutory audit of a bank branch, run through the Standards on Auditing stages, with the Long Form Audit Report and the certificates the bank asks for. The job is due on the date the bank wants the branch report.',
    30
  )
  on conflict (name) do nothing
  returning id
)
insert into public.job_template_items (template_id, sort_order, offset_days, title, description)
select t.id, i.sort_order, i.offset_days, i.title, i.description
from t cross join (values
  (1,  28, 'Acceptance: appointment, independence and limits',
        'Accept the bank''s appointment letter, give the independence and no-conflict declaration, and check the partner''s audit limits.'),
  (2,  25, 'Planning: the bank''s instructions and materiality (SA 300, SA 320)',
        'Read the bank''s closing circulars and audit instructions; plan the work and set materiality.'),
  (3,  22, 'Risk assessment: the branch''s risk profile (SA 315)',
        'Previous statutory, concurrent and inspection reports; large and stressed advances; high-risk areas.'),
  (4,  18, 'Execution: advances and asset classification',
        'Verify sanction, documents and security for large advances; check income recognition, asset classification and provisioning, and NPA identification.'),
  (5,  14, 'Execution: deposits, cash, balancing and other areas (SA 500, SA 505, SA 530)',
        'Cash and securities, KYC and anti-money-laundering checks, balancing of books, suspense and sundry accounts, contingent liabilities, interest and charges.'),
  (6,   8, 'Completion: written representations and memorandum of changes (SA 580)',
        'Obtain the branch manager''s representation letter and agree the memorandum of changes.'),
  (7,   0, 'Reporting: audit report, LFAR and certificates',
        'Sign the branch audit report, the Long Form Audit Report and the certificates the bank asks for.'),
  (8,   0, 'Reporting: UDIN',
        'Generate a UDIN for the report and each certificate within 60 days of signing.'),
  (9, -60, 'Archive: assemble the final file (SA 230)',
        'Assemble the final file within 60 days of the report date and retain it for 7 years.')
) as i(sort_order, offset_days, title, description);

-- GST annual return (GSTR-9/9C) (§16) -------------------------------------------------------------
with t as (
  insert into public.job_templates (name, service_type, description, default_lead_days)
  values (
    'GST annual return (GSTR-9/9C)', 'gst',
    'The GST annual return (GSTR-9) and, above the turnover limit, the reconciliation statement (GSTR-9C). The job is due on 31 December after the financial year.',
    45
  )
  on conflict (name) do nothing
  returning id
)
insert into public.job_template_items (template_id, sort_order, offset_days, title, description)
select t.id, i.sort_order, i.offset_days, i.title, i.description
from t cross join (values
  (1, 40, 'Collect the year''s books and returns',
       'Final books for the year, every GSTR-1/1A/IFF and GSTR-3B filed, and GSTR-2B for each period.'),
  (2, 30, 'Reconcile outward supplies',
       'Books against GSTR-1/1A/IFF and GSTR-3B, period by period, with credit and debit notes.'),
  (3, 25, 'Reconcile input tax credit',
       'Books against GSTR-2B and GSTR-3B, with reversals and reverse-charge tax.'),
  (4, 20, 'Compile HSN/SAC summaries and later-period adjustments',
       'HSN/SAC-wise summaries and the adjustments made in the next year''s returns for this year.'),
  (5, 12, 'Prepare GSTR-9 and GSTR-9C',
       'Prepare GSTR-9, and GSTR-9C where the turnover requires it.'),
  (6,  7, 'Client review and approval',
       'Share the drafts and the differences found, and record the client''s approval.'),
  (7,  5, 'Pay any additional liability',
       'Pay any tax found short, with interest, through DRC-03.'),
  (8,  0, 'File GSTR-9 & record ARN',
       'File GSTR-9 and record the ARN.'),
  (9,  0, 'File GSTR-9C & record ARN',
       'Where it applies, file GSTR-9C and record the ARN.')
) as i(sort_order, offset_days, title, description);

-- Monthly bookkeeping (§16) -----------------------------------------------------------------------
with t as (
  insert into public.job_templates (name, service_type, description, default_lead_days)
  values (
    'Monthly bookkeeping', 'bookkeeping',
    'Monthly accounts for a bookkeeping client. The job is due when the month''s books are closed and reported, normally the 20th of the next month; the collection steps then fall on the 5th, 7th and 10th, as in the bookkeeping prep reminders.',
    16
  )
  on conflict (name) do nothing
  returning id
)
insert into public.job_template_items (template_id, sort_order, offset_days, title, description)
select t.id, i.sort_order, i.offset_days, i.title, i.description
from t cross join (values
  (1, 15, 'Collect bank statements',
       'Statements for every bank account for the month.'),
  (2, 13, 'Collect sales data',
       'Sales invoices and the sales register for the month.'),
  (3, 13, 'Collect purchase data',
       'Purchase bills and the purchase register for the month.'),
  (4, 10, 'Collect expense receipts',
       'Expense bills and receipts for the month.'),
  (5,  6, 'Record vouchers',
       'Post sales, purchases, expenses, receipts and payments for the month.'),
  (6,  4, 'Bank reconciliation',
       'Reconcile every bank account and clear the unreconciled items.'),
  (7,  2, 'Review and close the month',
       'Review the ledgers, the GST and TDS accounts, and debtors and creditors; pass the month-end entries.'),
  (8,  0, 'Send the monthly reports to the client',
       'Share the trial balance or profit and loss, receivables and payables, and the open queries.')
) as i(sort_order, offset_days, title, description);

-- ROC annual filing (§16) -------------------------------------------------------------------------
with t as (
  insert into public.job_templates (name, service_type, description, default_lead_days)
  values (
    'ROC annual filing', 'company_law',
    'Annual MCA filings for a company: ADT-1 and AOC-4, then MGT-7/7A after the AGM. The job is due on the AOC-4 date (30 days after the AGM; for an OPC, 180 days after the financial year ends). Until the AGM date is entered, dates assume a 30 September AGM. Late fees accrue per day on each form.',
    70
  )
  on conflict (name) do nothing
  returning id
)
insert into public.job_template_items (template_id, sort_order, offset_days, title, description)
select t.id, i.sort_order, i.offset_days, i.title, i.description
from t cross join (values
  (1,  60, 'Board meeting: approve the financial statements and the board''s report',
        'Hold the board meeting that approves the audited financial statements and the board''s report, and calls the AGM.'),
  (2,  55, 'Send the AGM notice',
        'Send the notice with the annual report at least 21 clear days before the AGM.'),
  (3,  30, 'Hold the AGM and record its date',
        'Enter the AGM date on the client''s ROC event so the AGM-linked due dates are generated.'),
  (4,  15, 'File ADT-1',
        'Auditor appointment, within 15 days of the AGM (when the AGM appoints or re-appoints the auditor).'),
  (5,   0, 'File AOC-4',
        'Financial statements, within 30 days of the AGM (with AOC-4 CFS where consolidated statements apply). Record the SRN.'),
  (6, -30, 'File MGT-7/7A',
        'Annual return (MGT-7A for OPCs and small companies), within 60 days of the AGM. Record the SRN.')
) as i(sort_order, offset_days, title, description);

-- LLP annual filing (§16) -------------------------------------------------------------------------
with t as (
  insert into public.job_templates (name, service_type, description, default_lead_days)
  values (
    'LLP annual filing', 'company_law',
    'Annual MCA filings for an LLP: Form 11 (annual return, by 30 May) and Form 8 (statement of account and solvency, by 30 October). The job is due on the Form 8 date. Late fees accrue per day on each form.',
    160
  )
  on conflict (name) do nothing
  returning id
)
insert into public.job_template_items (template_id, sort_order, offset_days, title, description)
select t.id, i.sort_order, i.offset_days, i.title, i.description
from t cross join (values
  (1, 160, 'Collect partner and contribution details',
        'Changes in partners, designated partners and contributions during the year.'),
  (2, 153, 'File Form 11',
        'Annual return, by 30 May (153 days before this job''s 30 October date). Record the SRN.'),
  (3,  30, 'Finalise the accounts and the statement of solvency',
        'Finalise the statement of account and solvency, with the audit where the LLP''s turnover or contribution requires one.'),
  (4,  10, 'Designated partners'' approval and signatures',
        'The designated partners approve the statement and sign with their DSCs.'),
  (5,   0, 'File Form 8',
        'Statement of account and solvency, by 30 October. Record the SRN.')
) as i(sort_order, offset_days, title, description);

-- Incorporation (§16) -----------------------------------------------------------------------------
with t as (
  insert into public.job_templates (name, service_type, description, default_lead_days)
  values (
    'Incorporation', 'incorporation',
    'Incorporating a company (SPICe+) or an LLP (FiLLiP). The job is due on the target date for the certificate of incorporation.',
    30
  )
  on conflict (name) do nothing
  returning id
)
insert into public.job_template_items (template_id, sort_order, offset_days, title, description)
select t.id, i.sort_order, i.offset_days, i.title, i.description
from t cross join (values
  (1,  25, 'Collect KYC and the registered office proof',
        'PAN, address proof and photographs of every subscriber and director (or partner), and proof of the registered office with the owner''s no-objection.'),
  (2,  22, 'Obtain DSCs',
        'Digital signature certificates for the subscribers and directors (or designated partners).'),
  (3,  20, 'Reserve the name',
        'SPICe+ Part A (company) or RUN-LLP; record the approved name.'),
  (4,  15, 'Draft the MoA and AoA (or the LLP agreement)',
        'Agree the objects, capital and articles with the promoters.'),
  (5,  10, 'File the incorporation form',
        'SPICe+ Part B with e-MoA, e-AoA and AGILE-PRO-S (company), or FiLLiP (LLP). Record the SRN.'),
  (6,   5, 'Answer any resubmission',
        'Respond to the ROC''s queries within the time allowed.'),
  (7,   0, 'Certificate of incorporation, PAN and TAN',
        'Save the certificate of incorporation with the PAN and TAN allotted, and create the client''s registrations.'),
  (8, -30, 'Post-incorporation compliance',
        'Bank account, first auditor (within 30 days, with ADT-1), declaration of commencement of business (INC-20A, within 180 days); for an LLP, the LLP agreement in Form 3 within 30 days.')
) as i(sort_order, offset_days, title, description);

-- Certification (UDIN) (§16, §6.9: net worth, turnover, Form 15CB) --------------------------------
with t as (
  insert into public.job_templates (name, service_type, description, default_lead_days)
  values (
    'Certification (UDIN)', 'audit',
    'A certificate signed by a Partner: net worth, turnover, Form 15CB and other attest certificates. KYC Norms apply, and every certificate needs a UDIN. The job is due on the date the client needs the certificate.',
    10
  )
  on conflict (name) do nothing
  returning id
)
insert into public.job_template_items (template_id, sort_order, offset_days, title, description)
select t.id, i.sort_order, i.offset_days, i.title, i.description
from t cross join (values
  (1, 7, 'Accept the engagement: KYC and engagement letter',
      'Client KYC under the ICAI KYC Norms is complete; agree the purpose, the addressee and the fee in writing.'),
  (2, 5, 'Obtain the records and evidence',
      'The books, statements and documents behind each figure: net worth, turnover, or the remittance and its tax treatment for Form 15CB.'),
  (3, 3, 'Verify and draft the certificate',
      'Follow ICAI''s guidance on reports and certificates for special purposes, and keep the working papers.'),
  (4, 1, 'Partner review and signature',
      'The signing partner reviews the working papers and signs.'),
  (5, 0, 'Generate the UDIN',
      'Generate the UDIN within 60 days of signing (immediately if a regulator asks) and record it in the UDIN register. Form 15CB is filed on the e-filing portal with the UDIN.'),
  (6, 0, 'Deliver the certificate and file the working papers',
      'Send the certificate to the client and keep the working papers for at least 7 years.')
) as i(sort_order, offset_days, title, description);

-- =================================================================================================
-- Message templates (§7.13.4, §7.13.2, §10, §16): every template type, for email and for WhatsApp.
-- =================================================================================================
insert into public.message_templates (name, type, channel, subject, body)
values
  -- document_reminder -----------------------------------------------------------------------------
  ('Document reminder (email)', 'document_reminder', 'email',
   '{{firm_name}} | Reminder: documents pending for {{period}}',
   $body$Dear {{contact_name}},

This is a gentle reminder that we are still waiting for the following documents for your {{service_type}} for {{period}}:

{{missing_items}}

You can upload them securely on our client portal: {{portal_link}}

If you have already sent them, thank you, and please ignore this reminder. If anything is unclear, just reply to this email and we will help.

Warm regards,
{{sender_name}}
{{firm_name}}$body$),

  ('Document reminder (WhatsApp)', 'document_reminder', 'whatsapp', null,
   $body$Hi {{contact_name}}, a gentle reminder from {{firm_name}}: for your {{service_type}} for {{period}} we are still waiting for:
{{missing_items}}

You can upload them here: {{portal_link}}
If you have already sent them, thank you!$body$),

  -- compliance_reminder ---------------------------------------------------------------------------
  ('Compliance reminder (email)', 'compliance_reminder', 'email',
   '{{firm_name}} | {{compliance_type}} for {{period}} is due on {{due_date}}',
   $body$Dear {{contact_name}},

{{compliance_type}} for {{period}} is due on {{due_date}}.

To file it on time, we need the following from you:

{{missing_items}}

Kindly upload them on our client portal: {{portal_link}}

Filing on time avoids late fees and interest. If you have any questions, please reply to this email or call us on {{firm_phone}}.

Warm regards,
{{sender_name}}
{{firm_name}}$body$),

  ('Compliance reminder (WhatsApp)', 'compliance_reminder', 'whatsapp', null,
   $body$Hi {{contact_name}}, {{compliance_type}} for {{period}} is due on {{due_date}}. To file it on time, we need:
{{missing_items}}

You can upload them here: {{portal_link}}
Thank you!$body$),

  -- payment_reminder: before and after the due date -----------------------------------------------
  ('Payment reminder: before due (email)', 'payment_reminder', 'email',
   '{{firm_name}} | Invoice {{invoice_number}} is due on {{due_date}}',
   $body$Dear {{contact_name}},

A friendly reminder that our invoice {{invoice_number}} for {{amount}} is due on {{due_date}}.

You can view the invoice and pay online here: {{payment_link}}
To pay by UPI: {{upi_link}}

Kindly quote the invoice number when you pay. If you deduct TDS, please let us know the amount and share the TDS certificate when it is issued. If you have already made the payment, thank you, and please ignore this reminder.

Warm regards,
{{sender_name}}
{{firm_name}}$body$),

  ('Payment reminder: before due (WhatsApp)', 'payment_reminder', 'whatsapp', null,
   $body$Hi {{contact_name}}, a friendly reminder from {{firm_name}}: invoice {{invoice_number}} for {{amount}} is due on {{due_date}}.

View and pay: {{payment_link}}
Pay by UPI: {{upi_link}}

If you have already paid, thank you!$body$),

  ('Payment reminder: after due (email)', 'payment_reminder', 'email',
   '{{firm_name}} | Invoice {{invoice_number}} is overdue',
   $body$Dear {{contact_name}},

Our records show that invoice {{invoice_number}} for {{amount}}, which was due on {{due_date}}, is still outstanding.

We would be grateful if you could arrange the payment at the earliest. You can view the invoice and pay here: {{payment_link}}
To pay by UPI: {{upi_link}}

If the payment has already been made, please share the transaction reference so that we can match it. If there is anything about the invoice you would like to discuss, just reply to this email or call us on {{firm_phone}}.

Warm regards,
{{sender_name}}
{{firm_name}}$body$),

  ('Payment reminder: after due (WhatsApp)', 'payment_reminder', 'whatsapp', null,
   $body$Hi {{contact_name}}, invoice {{invoice_number}} for {{amount}} was due on {{due_date}} and is still outstanding. We would be grateful if you could arrange the payment at the earliest.

View and pay: {{payment_link}}
Pay by UPI: {{upi_link}}

If it is already paid, please share the reference so that we can match it. Thank you!$body$),

  -- task_assignment (to a member of staff) --------------------------------------------------------
  ('Task assignment (email)', 'task_assignment', 'email',
   '{{firm_name}} | New task: {{task_title}}',
   $body$Hello,

{{sender_name}} has assigned you a new task.

Task: {{task_title}}
Client: {{client_name}} ({{client_code}})
Due date: {{due_date}}
Priority: {{priority}}

Please open it in the app and accept it, or decline it with a reason if you can't take it on.

Thank you,
{{firm_name}}$body$),

  ('Task assignment (WhatsApp)', 'task_assignment', 'whatsapp', null,
   $body$New task for you: {{task_title}}
Client: {{client_name}} ({{client_code}})
Due: {{due_date}} · Priority: {{priority}}

Please accept it in the app, or decline it with a reason.$body$),

  -- overdue_notification (to the client: a filing past its due date) -------------------------------
  ('Overdue notice (email)', 'overdue_notification', 'email',
   '{{firm_name}} | {{compliance_type}} for {{period}} is overdue',
   $body$Dear {{contact_name}},

{{compliance_type}} for {{period}} was due on {{due_date}} and has not been filed yet, as we are still waiting for:

{{missing_items}}

Late fees and interest grow every day a return is late. Kindly upload the pending items on our client portal at the earliest, so that we can file without further delay: {{portal_link}}

If you would like to talk it through, please call us on {{firm_phone}}.

Warm regards,
{{sender_name}}
{{firm_name}}$body$),

  ('Overdue notice (WhatsApp)', 'overdue_notification', 'whatsapp', null,
   $body$Hi {{contact_name}}, {{compliance_type}} for {{period}} was due on {{due_date}} and is still pending, as we need:
{{missing_items}}

Late fees and interest grow every day, so please upload them as soon as you can: {{portal_link}}
For anything urgent, call us on {{firm_phone}}.$body$),

  -- quotation ---------------------------------------------------------------------------------------
  ('Quotation (email)', 'quotation', 'email',
   '{{firm_name}} | Our quotation for {{client_name}}',
   $body$Dear {{contact_name}},

Thank you for considering {{firm_name}}. As discussed, our quotation for {{client_name}} is ready. The quoted total is {{amount}}, and you can view, download, accept or decline it online:

{{quotation_link}}

The scope, fees and terms are set out in the quotation. If you would like to change anything or discuss it, just reply to this email or call us on {{firm_phone}}.

We look forward to working with you.

Warm regards,
{{sender_name}}
{{firm_name}}$body$),

  ('Quotation (WhatsApp)', 'quotation', 'whatsapp', null,
   $body$Hi {{contact_name}}, thank you for your time. Our quotation for {{client_name}} ({{amount}}) is here: {{quotation_link}}

You can view, download, accept or decline it on that page. Happy to answer any questions.$body$),

  -- welcome -----------------------------------------------------------------------------------------
  ('Welcome (email)', 'welcome', 'email',
   'Welcome to {{firm_name}}',
   $body$Dear {{contact_name}},

Welcome to {{firm_name}}, and thank you for choosing us for {{client_name}}. Your client code with us is {{client_code}}; please mention it whenever you write to us.

I will be your first point of contact, and our team will keep you informed at every step.

Our client portal is where you can see your upcoming deadlines, upload the documents we ask for, view invoices and message us: {{portal_link}}

We will also set up a WhatsApp group with our Partners and our team for quick day-to-day questions. For anything urgent, please call {{firm_phone}}.

We look forward to working with you.

Warm regards,
{{sender_name}}
{{firm_name}}$body$),

  ('Welcome (WhatsApp)', 'welcome', 'whatsapp', null,
   $body$Hi {{contact_name}}, welcome to {{firm_name}}, and thank you for choosing us for {{client_name}}! Your client code with us is {{client_code}}.

Our client portal shows your deadlines, document requests and invoices: {{portal_link}}
For anything urgent, please call {{firm_phone}}.$body$),

  -- WhatsApp group welcome (§16, exact text; posted in step 6 of the group checklist, §7.25.2) -----
  ('WhatsApp group welcome', 'welcome', 'whatsapp', null,
   'Welcome to the {{firm_name}} group for {{client_name}}. Our Partners, our Managers'' desk and our team desk are all here, and our team sign their messages with their name. For anything urgent, please call {{firm_phone}}.'),

  -- custom: data-awaited request (§7.13.2 "Data awaited" task) --------------------------------------
  ('Data awaited request (email)', 'custom', 'email',
   '{{firm_name}} | Information needed for your {{service_type}} for {{period}}',
   $body$Dear {{contact_name}},

We have started work on your {{service_type}} for {{period}}, and we need a few things from you to complete it:

{{missing_items}}

You can upload them securely on our client portal: {{portal_link}}

As the due date is {{due_date}}, we would be grateful to receive them at the earliest. If you have any questions, just reply to this email.

Warm regards,
{{sender_name}}
{{firm_name}}$body$),

  ('Data awaited request (WhatsApp)', 'custom', 'whatsapp', null,
   'Hi {{contact_name}}, for your {{service_type}} for {{period}} we still need: {{missing_items}}. You can upload them here: {{portal_link}}'),

  -- custom: document request (PBC list, §7.14) ------------------------------------------------------
  ('Document request (email)', 'custom', 'email',
   '{{firm_name}} | Documents requested for {{period}}',
   $body$Dear {{contact_name}},

To proceed with your work for {{period}}, kindly share the following documents:

{{missing_items}}

Please upload each one against its item on our client portal: {{portal_link}}
We would appreciate receiving them by {{due_date}}.

If an item does not apply to you, or you would like help with what we are asking for, just reply to this email.

Warm regards,
{{sender_name}}
{{firm_name}}$body$),

  ('Document request (WhatsApp)', 'custom', 'whatsapp', null,
   $body$Hi {{contact_name}}, to proceed with your work for {{period}}, please share these documents:
{{missing_items}}

You can upload them here: {{portal_link}}
Thank you!$body$),

  -- custom: invoice (§7.13.2, §10) ------------------------------------------------------------------
  ('Invoice (email)', 'custom', 'email',
   '{{firm_name}} | Invoice {{invoice_number}}',
   $body$Dear {{contact_name}},

Thank you for your continued trust in {{firm_name}}. Our invoice {{invoice_number}} for {{amount}} is ready, and is due on {{due_date}}.

View and pay online: {{payment_link}}
Pay by UPI: {{upi_link}}

Our bank details are on the invoice. Kindly quote the invoice number when you pay. If you deduct TDS, please issue the TDS certificate in time, so that the credit reflects in our tax statement.

Warm regards,
{{sender_name}}
{{firm_name}}$body$),

  ('Invoice (WhatsApp)', 'custom', 'whatsapp', null,
   $body$Hi {{contact_name}}, our invoice {{invoice_number}} for {{amount}} is ready, and is due on {{due_date}}.

View and pay: {{payment_link}}
Pay by UPI: {{upi_link}}

Thank you for your continued trust in {{firm_name}}!$body$),

  -- custom: staff login share (§4.5 "Login created"). The login link, email and temporary password
  -- are added by the People screen when it builds the draft; they are never stored in a template.
  ('Staff login share (email)', 'custom', 'email',
   '{{firm_name}} | Your login is ready',
   $body$Hello,

Welcome to {{firm_name}}! Your login to our practice system is ready.

Sign in with your office email address and the temporary password shared with you. You will be asked to choose your own password the first time you sign in, and nobody else will know it.

If anything doesn't work, call {{firm_phone}}.

Regards,
{{sender_name}}
{{firm_name}}$body$),

  ('Staff login share (WhatsApp)', 'custom', 'whatsapp', null,
   $body$Welcome to {{firm_name}}! Your login to our practice system is ready.

Sign in with your office email address and the temporary password shared with you. You will choose your own password the first time you sign in.

If anything doesn't work, call {{firm_phone}}.$body$),

  -- custom: supplier follow-up from GST reconciliation (§7.8.1). {{missing_items}} lists the
  -- suppliers to chase.
  ('Supplier follow-up (email)', 'custom', 'email',
   '{{firm_name}} | Suppliers to follow up for your GST input tax credit for {{period}}',
   $body$Dear {{contact_name}},

While reconciling your purchases with GSTR-2B for {{period}}, we found invoices from the suppliers below that are missing from their GST returns, or don't match them:

{{missing_items}}

Until these suppliers file or correct their GSTR-1, the input tax credit on these invoices is at risk. Kindly ask them to do so at the earliest; we will check again once GSTR-2B is updated.

Warm regards,
{{sender_name}}
{{firm_name}}$body$),

  ('Supplier follow-up (WhatsApp)', 'custom', 'whatsapp', null,
   $body$Hi {{contact_name}}, while reconciling your GST purchases for {{period}}, we found invoices from these suppliers that are missing from GSTR-2B, or don't match it:
{{missing_items}}

Please ask them to file or correct their GSTR-1 soon, so that your input tax credit isn't lost. We will check again once GSTR-2B is updated.$body$),

  -- custom: lead follow-up (§7.5.1) -----------------------------------------------------------------
  ('Lead follow-up (email)', 'custom', 'email',
   '{{firm_name}} | Following up on our conversation',
   $body$Dear {{contact_name}},

Thank you for your interest in {{firm_name}}. I am following up on our recent conversation about your {{service_type}} requirements.

If you would like a quotation, or have any questions about how we can help, just reply to this email or call us on {{firm_phone}}. We would be happy to meet at a time that suits you.

Warm regards,
{{sender_name}}
{{firm_name}}$body$),

  ('Lead follow-up (WhatsApp)', 'custom', 'whatsapp', null,
   $body$Hi {{contact_name}}, greetings from {{firm_name}}! Following up on our conversation about your {{service_type}} requirements: shall we send you a quotation, or is there anything we can clarify? Happy to help.$body$)
on conflict (name) do nothing;

-- =================================================================================================
-- Privacy notice v1 (§6.10, §16): draft text for the Partners to approve (published_at stays null
-- until they do). It is the current notice unless a Partner has already made another one current.
-- =================================================================================================
insert into public.privacy_notices (version, body, published_at, is_current)
select
  'v1',
  $notice$# Privacy notice

TaxWise Consultants, Chartered Accountants, 307, 14th Main Rd, Raj Mahal Vilas Extension, Sadashiva Nagar, Bengaluru, Karnataka 560080 ("we", "us") is the Data Fiduciary for the personal data described in this notice, under the Digital Personal Data Protection Act, 2023 and the Digital Personal Data Protection Rules, 2025.

## What personal data we collect
- **Identity and contact details:** name, designation, email address, phone and WhatsApp numbers, and postal address.
- **Tax and statutory identifiers:** PAN, TAN, GSTIN, DIN, CIN or LLPIN. Where a document needs your Aadhaar, we keep only its last four digits. We never store a full Aadhaar number, card numbers or bank passwords.
- **Financial and business records** you share for our work: books of account, bank statements, invoices, returns, Form 16 and other tax documents.
- **Government portal logins** that you authorise us in writing to use, stored encrypted.
- **Client portal use:** sign-in times, IP address and device details, kept for security.
- **Communications** with our team: emails, portal messages and notes of calls and meetings.

## Why we use it
- To provide the services you engage us for: income tax, GST, TDS, audit and assurance, accounting, payroll, company law and related advice.
- To file returns and forms, respond to notices and deal with the authorities on your behalf.
- To meet our own legal and professional obligations, including the Chartered Accountants Act, 1949, the ICAI's standards and KYC Norms, and tax and GST law.
- To remind you about deadlines, documents and invoices, and to bill and collect our fees.
- To keep our systems and your information secure.

We do not sell your personal data or use it for advertising.

## How we communicate with you
- **Email** and our **client portal**.
- **Phone calls.**
- **WhatsApp groups with our team:** each client has a WhatsApp group with our Partners' numbers, our Managers' office number and our Staff office number, together with your people. We may also send you individual WhatsApp messages from these numbers. Our team sign their messages with their name. WhatsApp is run by Meta under its own terms and privacy policy. We do not copy or store the content of these chats in our systems; a file you send there is saved to your client file only when our work needs it. Please share another person's details in a group only when our work needs them.

## Who we share it with
- Government authorities and their portals (the Income Tax Department, GSTN, MCA, TRACES, EPFO, ESIC and others), when we file or respond on your behalf, or when a law requires it.
- The ICAI and its peer reviewers, when professional rules require it, under a duty of confidentiality.
- Service providers who host and run our systems (cloud hosting, database and email delivery), under contracts that require them to protect your data.

As Chartered Accountants we are bound to keep your information confidential, and we share nothing else without your consent unless a law requires it.

## How long we keep it
We keep your data only as long as our work and the law require:
- audit working papers: at least 7 years from the date of the audit report;
- a company's books held by us: 8 financial years;
- GST records: 72 months from the due date of the annual return for that year;
- income-tax records: the period the income-tax rules prescribe.

After that, records are reviewed for secure disposal. If a law requires us to keep a record you ask us to erase, we will tell you what we keep and why.

## How we protect it
Encryption in transit and at rest, encrypted storage of portal passwords, access limited by role (our team see only the clients they work on), logs of who viewed what, short-lived download links, regular backups and quarterly reviews of who has access.

## Your rights
Under the DPDP Act you may:
- ask for a summary of the personal data we hold about you and how we use it;
- ask us to correct, complete or update it;
- ask us to erase it, subject to the retention periods the law requires;
- withdraw your consent where we rely on it (this does not affect work already done, or processing that a law requires);
- nominate a person to exercise these rights for you if you die or become unable to;
- raise a grievance with us.

## Grievances and contact
Email **info@twchartered.com** with the subject "Personal data", or write to us at the address above. We will acknowledge your request and reply within the time the DPDP Rules allow. If you are not satisfied with our reply, you may complain to the Data Protection Board of India.

## Changes to this notice
If this notice changes, we will show you the new version and ask you to acknowledge it.$notice$,
  null::timestamptz,
  not exists (select 1 from public.privacy_notices p where p.is_current)
on conflict (version) do nothing;

-- =================================================================================================
-- firm_whatsapp_numbers (§5.13, §7.25.4, §16): five inactive slots with no number yet. Partners fill
-- in the numbers (and the Partner and custodian) under Settings → WhatsApp, a Setup checklist item.
-- =================================================================================================
insert into public.firm_whatsapp_numbers
  (label, number, kind, in_every_client_group, group_admin, shared, usable_by, is_active)
values
  ('CA Vinay H Karlagere (Partner)', null, 'partner',         true, false, false, '{partner}'::public.app_role[],                    false),
  ('Partner 2',                      null, 'partner',         true, false, false, '{partner}'::public.app_role[],                    false),
  ('Partner 3',                      null, 'partner',         true, false, false, '{partner}'::public.app_role[],                    false),
  ('Managers'' office',              null, 'managers_office', true, true,  true,  '{partner,manager}'::public.app_role[],            false),
  ('Staff office',                   null, 'staff_office',    true, false, true,  '{partner,manager,employee}'::public.app_role[],   false)
on conflict (label) do nothing;

-- =================================================================================================
-- quality_manual_items (§6.8, §7.15.4): the SQC 1 quality manual checklist, by element. Owner and
-- last-reviewed date are filled in by the Partners.
-- =================================================================================================
insert into public.quality_manual_items (element, title, notes, sort_order)
select v.element, v.title, v.notes, v.sort_order
from (values
  ('leadership', 'Quality policies and procedures documented and communicated to all staff',
   'SQC 1: leadership responsibilities for quality within the firm.', 10),
  ('leadership', 'Partner responsible for the firm''s system of quality control named',
   'Name the Partner who owns the quality system and reviews this checklist.', 20),

  ('ethics_independence', 'Annual independence declaration from every staff member',
   'Yes/no questionnaire plus details, per person per financial year.', 30),
  ('ethics_independence', 'Independence and conflict check before every attest engagement',
   'Financial interest, relationships, other services to an audit client, fee dependence.', 40),
  ('ethics_independence', 'Confidentiality of client information',
   'CA Act, Second Schedule, Part I, Clause (1): nothing is disclosed without the client''s consent or a legal requirement.', 50),
  ('ethics_independence', 'No fees based on a percentage of profits or contingent on results',
   'CA Act, First Schedule, Part I, Clause 10: quotations and engagement letters have no success-fee lines.', 60),

  ('acceptance_continuance', 'Client acceptance and conflict check before taking on a client',
   'Mandatory for attest work; decisions recorded in the acceptance register.', 70),
  ('acceptance_continuance', 'KYC Norms complete for every attest engagement, re-confirmed annually',
   'ICAI KYC Norms, mandatory since 1 January 2017.', 80),
  ('acceptance_continuance', 'Communication with the previous auditor before accepting an audit',
   'CA Act, First Schedule, Part I, Clause 8, with proof of delivery.', 90),
  ('acceptance_continuance', 'Engagement letter for every audit (SA 210) and for other services each financial year',
   'An audit can''t move past acceptance without an issued letter.', 100),
  ('acceptance_continuance', 'Peer review certificate valid where the engagement needs a peer-reviewed auditor',
   'Checked on the acceptance date.', 110),
  ('acceptance_continuance', 'Tax audit ceiling and company audit limit checked before acceptance',
   'ICAI tax audit guidelines and Companies Act s.141(3)(g).', 120),
  ('acceptance_continuance', 'Annual continuance review of existing clients', null, 130),

  ('human_resources', 'Recruitment, training and CPE records for every member of staff', null, 140),
  ('human_resources', 'Engagement teams assigned with the right skills and capacity', null, 150),
  ('human_resources', 'Annual performance evaluation', null, 160),

  ('engagement_performance', 'Work reviewed by a Manager or Partner before filing',
   'Separation of duties: nobody files their own work.', 170),
  ('engagement_performance', 'Consultation on difficult or contentious matters, documented', null, 180),
  ('engagement_performance', 'Engagement quality control review where the firm''s policy requires it', null, 190),
  ('engagement_performance', 'Differences of opinion resolved and documented', null, 200),
  ('engagement_performance', 'Audit files assembled within 60 days of the report date and retained for 7 years',
   'SA 230 and SQC 1.', 210),
  ('engagement_performance', 'UDIN generated within 60 days of signing for every certificate and report',
   'ICAI Council decision, 17 September 2021.', 220),

  ('monitoring', 'Annual inspection of a sample of completed engagements', null, 230),
  ('monitoring', 'Peer review recorded, with its validity', 'Peer Review Guidelines 2022.', 240),
  ('monitoring', 'Quarterly review of roles and vault access', null, 250),
  ('monitoring', 'Quarterly backup restore drill recorded', null, 260)
) as v(element, title, notes, sort_order)
where not exists (
  select 1 from public.quality_manual_items q where q.element = v.element and q.title = v.title
);
