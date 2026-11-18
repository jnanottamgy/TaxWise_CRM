-- 0248 · A leave allowance, so people and approvers see days left (§7.11.2 said "the firm keeps no
-- leave allowance"; the end-to-end run asked for one). leave.allowance_days holds the working days a
-- person may take in a financial year, by leave type. A type left out, or 0, has no limit. The
-- figures below are placeholders awaiting a Partner's confirmation: change them under Settings →
-- Law & rules to the firm's own policy. The app shows the balance and warns when a request goes
-- past it; it never blocks the request (the approver decides).
--
-- Also records the schema version (§0.1 rule 1): lib/env.ts EXPECTED_SCHEMA_VERSION matches it.

set search_path = public, extensions;

insert into public.statutory_parameters (key, value, effective_from, effective_to, statute, section_ref, source_ref, notes, verified)
values (
  'leave.allowance_days', '{"annual":18,"sick":12,"casual":6}'::jsonb, date '2026-04-01', null,
  'Firm practice', 'Leave policy', 'The firm''s own leave policy',
  'Working days of leave a person may take in a financial year, by type (annual, sick, casual). Leave a type out, or set it to 0, for no limit. [verify] These are placeholders: set the firm''s own figures.',
  false
)
on conflict (key, effective_from) do nothing;

update public.app_meta set value = '0248' where key = 'schema_version';
