-- 10 · The firm and its numbering (§16 "Firm and numbering", §1, §5.2, §5.11, §6.4, §7.25.10).
-- §16 content only: the firm's own identity, its billing and quotation defaults, the WhatsApp house
-- rules, and the document-number counters. No clients, no users, no demo data.
--
-- Left empty on purpose, for the Setup checklist (§4.3, §7.2): logo, bank and UPI details, ICAI FRN
-- (and each Partner's membership number, which lives on profiles), TAN, legal name.
-- Every other firm_settings column takes its §5.2 default from the table definition (0003):
-- prefixes, working hours, reminders, the email sender and the WhatsApp settings.
--
-- Idempotent: ON CONFLICT DO NOTHING, so re-running never overwrites what a Partner has since
-- changed in Settings (or what /setup confirmed, §4.3). app_meta is left alone: the migrations set
-- schema_version.

set search_path = public, extensions;

-- -------------------------------------------------------------------------------------------------
-- firm_settings: the singleton row (§1, §5.2)
-- -------------------------------------------------------------------------------------------------
insert into public.firm_settings (
  id,
  -- Identity (§1). GSTIN 29AAXFT1811B1Z3 passes the mod-36 check; state 29 Karnataka; its PAN.
  firm_name, tagline, address, city, state_code, pincode, phone, email, website, gstin, pan,
  -- Billing and quotation defaults (§5.2, §6.4). SAC map: service type → SAC, editable in
  -- Settings → Billing; services not in the map use default_sac. Same values as
  -- GST_DEFAULTS.sacByService in lib/domain/gst.ts.
  default_sac, sac_by_service, default_tax_rate, payment_terms_days, quotation_validity_days,
  quotation_terms, invoice_terms,
  -- Email sender (§1, §7.13.5)
  email_from_name, email_from_address, email_reply_to, sending_domain,
  -- WhatsApp house rules (§7.25.10), shown to staff and editable by Partners
  whatsapp_house_rules
)
values (
  1,
  'TaxWise Consultants',
  'Chartered Accountants · Bengaluru',
  '307, 14th Main Rd, Raj Mahal Vilas Extension, Sadashiva Nagar',
  'Bengaluru',
  '29',
  '560080',
  '+91 97405 40239',
  'info@twchartered.com',
  'https://www.twchartered.com/',
  '29AAXFT1811B1Z3',
  'AAXFT1811B',

  '9982',
  '{"audit": "998221", "bookkeeping": "998222", "income_tax": "998231", "income_tax_individual": "998232", "other": "9982"}'::jsonb,
  18,
  15,
  30,

  -- Quotation terms (§16)
  $terms$Thank you for considering TaxWise Consultants. This quotation is offered on the following terms:

1. Our fees are exclusive of GST, which will be charged at the rate applicable on the date of the invoice.
2. Out-of-pocket expenses and government fees (filing fees, stamp duty, challans and the like) will be charged at actuals.
3. Penalties, late fees and interest that arise because information reached us late are not included in our fees, and are payable by you.
4. The scope of our work is limited to the services listed in this quotation. Any other work will be quoted separately.
5. Timelines depend on our receiving complete and accurate information from you in good time.
6. Once you accept this quotation, we will send you an engagement letter setting out the scope of work, our respective responsibilities and the fees.
7. Payment terms are as stated in this quotation.
8. This quotation is subject to the jurisdiction of the courts at Bengaluru.

We look forward to working with you.$terms$,

  -- Invoice terms (§16)
  $terms$1. Payment is due within the number of days stated on this invoice, by the due date shown above.
2. Kindly quote the invoice number when you make the payment, so that we can match it promptly.
3. If you deduct TDS on this invoice, please deposit it and issue the TDS certificate in time, so that the credit reflects in our tax statement.
4. You can pay by bank transfer or UPI, using the bank and UPI details given on this invoice.
5. Subject to Bengaluru jurisdiction.

Thank you for your business.$terms$,

  'TaxWise Consultants',
  'noreply@twchartered.com',
  'info@twchartered.com',
  'twchartered.com',

  -- House rules (§7.25.10)
  $rules$1. Same firm numbers in every client group, plus the client's people. No personal staff numbers.

2. Sign every message on the shared numbers ("– Ravi"). Drafts from the CRM add the signature.

3. Office phones:
   - stay in the office with a named custodian;
   - have a screen lock;
   - have two-step verification on.

4. Sign firm numbers in to WhatsApp Web only on office PCs. A Partner's own number goes only on their own PC.

5. Every week, the custodian checks the phone's Linked devices list (WhatsApp → Linked devices) and logs out anything that isn't an office PC. The app sends the reminder and records the review.

6. Never discuss one client in another client's group. If it happens:
   - delete the message for everyone;
   - tell a Partner, who records the incident.

7. People and engagements changing:
   - When a Partner leaves, the WhatsApp groups page lists every group to remove their number from. Then log their number out of every office PC (Linked devices).
   - When an engagement ends, post a closing message, then close the group in the app.$rules$
)
on conflict (id) do nothing;

-- -------------------------------------------------------------------------------------------------
-- number_series: the locked document counters (§0.1 rule 6, §5.11), starting at 1.
-- FY-scoped series (invoice, credit note, quotation, receipt) start in FY 2026-27 and reset each FY
-- (next_document_number); the others never reset, so they carry no FY.
-- -------------------------------------------------------------------------------------------------
insert into public.number_series (key, financial_year, next_value)
values
  ('invoice',     '2026-27', 1),
  ('credit_note', '2026-27', 1),
  ('quotation',   '2026-27', 1),
  ('receipt',     '2026-27', 1),
  ('client_code', null,      1),
  ('task',        null,      1),
  ('lead',        null,      1)
on conflict (key) do nothing;
