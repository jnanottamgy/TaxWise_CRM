-- 50 · Section concordance (Income-tax Act, 1961 ↔ Income-tax Act, 2025) and other lists (§6.1, §16).
-- §16 content only. No clients, no users, no demo data.
--
-- section_concordance: the §6.1 table, one mapping per row, so that a label or a PDF can look up the
-- provision or form that matches the tax year of the record. Where the §6.1 table lists several
-- sections or forms in one row (interest 234A/B/C; the TDS certificates and statements), each is its
-- own row, paired in the order the table gives them. §16: EVERY row is seeded verified = false
-- until a Partner confirms it against the CBDT's published mapping (Settings → Law & rules), even
-- the s.393 row that §6.1 calls settled. Partners add the rest of the concordance from that mapping
-- before go-live (§6.1).
--
-- holidays (§5.2, §7.11.3): deliberately left empty. The firm's holiday list is entered by the
-- Partners under Settings → Working hours; nothing is seeded.
--
-- Idempotent: a row is inserted only when no row with the same topic exists, so re-running never
-- duplicates a row or undoes a Partner's edits or verification.

set search_path = public, extensions;

insert into public.section_concordance (topic, old_section, new_section, old_form, new_form, verified, source_ref)
select v.topic, v.old_section, v.new_section, v.old_form, v.new_form, false, v.source_ref
from (values
  ('Tax audit',
   's.44AB', 's.63', 'Form 3CA/3CB + 3CD', 'Form 26',
   'Income-tax Act, 2025 s.63: one form (Form 26) replaces Forms 3CA, 3CB and 3CD. [verify]'),
  ('Rebate',
   's.87A', 's.156', null, null,
   'Income-tax Act, 2025 s.156. [verify]'),
  ('Interest for default in furnishing the return',
   's.234A', 's.423', null, null,
   'Income-tax Act, 2025. [verify]: sources conflict on the interest sections (ss.423/424/425).'),
  ('Interest for default in payment of advance tax',
   's.234B', 's.424', null, null,
   'Income-tax Act, 2025. [verify]: sources conflict on the interest sections (ss.423/424/425).'),
  ('Interest for deferment of advance tax',
   's.234C', 's.425', null, null,
   'Income-tax Act, 2025. [verify]: sources conflict on the interest sections (ss.423/424/425).'),
  ('Return of income',
   's.139', 's.263', null, null,
   'Income-tax Act, 2025 s.263. [verify]'),
  ('TDS (non-salary)',
   'ss.194A–194T', 's.393 (one tabular section)', null, null,
   'Income-tax Act, 2025 s.393 (settled); the table entry numbers for each payment are [verify].'),
  ('TDS certificate: salary',
   null, null, 'Form 16', 'Form 130',
   'Income-tax Rules, 2026. [verify]'),
  ('TDS certificate: other than salary',
   null, null, 'Form 16A', 'Form 131',
   'Income-tax Rules, 2026. [verify]'),
  ('TDS statement: salary',
   null, null, 'Form 24Q', 'Form 138',
   'Income-tax Rules, 2026. [verify]'),
  ('TDS statement: other than salary (residents)',
   null, null, 'Form 26Q', 'Form 140',
   'Income-tax Rules, 2026. [verify]'),
  ('TDS statement: payments to non-residents',
   null, null, 'Form 27Q', 'Form 144',
   'Income-tax Rules, 2026. [verify]'),
  ('TCS statement',
   null, null, 'Form 27EQ', 'Form 143',
   'Income-tax Rules, 2026. [verify]'),
  ('Annual statement of tax credits (AIS)',
   null, null, 'Form 26AS', 'Form 168',
   'Income-tax Rules, 2026. [verify]')
) as v(topic, old_section, new_section, old_form, new_form, source_ref)
where not exists (
  select 1 from public.section_concordance c where c.topic = v.topic
);
