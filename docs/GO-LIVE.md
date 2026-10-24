# Go-live checklist (§18.2) and acceptance run (§18.3)

Tick every line before real client data goes into production. Owner: a Partner, with whoever deploys.

## 1. Environments
- [ ] Two Supabase projects exist: `taxwise-production` and `taxwise-staging` (Mumbai region). Staging holds no real data
      (only `scripts/seed-staging.ts` synthetic data, which refuses to run with `APP_ENV=production`).
- [ ] Vercel production deploys from `main` with production variables; previews and `develop` use staging.
- [ ] The GitHub repository is **private**.

## 2. Database
- [ ] Migrations applied in order with `supabase db push`; seed applied once.
- [ ] Settings → Diagnostics: schema version matches, every table answers, enums complete, RLS helpers present, buckets exist.
- [ ] RLS is on for every table — prove it in the SQL editor:
      `select tablename from pg_tables where schemaname = 'public' and not rowsecurity;` returns no rows.
- [ ] Point-in-time recovery on. Nightly logical backup to separate storage configured; first restore drill recorded
      in Quality → Restore drills.

## 3. Configuration
- [ ] `npm run env:check` passes against the production values.
- [ ] `CREDENTIAL_VAULT_KEY` set **and backed up offline** before any portal credential is stored.
- [ ] Auth: sign-ups disabled; TOTP enabled; reset-password template points at `/auth/confirm`; redirect URLs set.
- [ ] Email: Settings → Email shows **Verified** for `twchartered.com`; test email received; Resend webhook added with
      `RESEND_WEBHOOK_SECRET`; a bounce test marks the contact's email as bad.
- [ ] Supabase Auth SMTP points at Resend, so password-reset mail comes from TaxWise.
- [ ] Cron: every job in `vercel.json` registered; each has run once successfully (Diagnostics → Cron jobs).

## 4. People and access
- [ ] First Partner created through `/setup`; `/setup` now returns 404.
- [ ] Every Partner and Manager has enrolled two-step sign-in (TOTP).
- [ ] No demo or test accounts in production Auth; no passwords or keys anywhere in the repository.
- [ ] Vault access granted only to the Employees who need it.

## 5. Firm data
- [ ] Settings → Firm details: logo, ICAI FRN, each Partner's membership number, bank, UPI.
- [ ] Settings → Billing: SAC map confirmed, approval limits set, last GSTR-1 month set.
- [ ] Settings → Law & rules: **every [verify] item confirmed or corrected** by a Partner (TDS s.393 table entries,
      ITR-3/4 31 August date, Form 26 mapping, DIR-3 KYC cycle, Karnataka PT dates, appeal limitation periods, DPDP
      timelines, GST rate at SAC level, GSTR-9 exemption for the year).
- [ ] GSTR-1 export checked against the current GSTN offline tool's column layout before the first filing from it.
- [ ] Privacy notice v1 reviewed and published (Settings → Data), so the portal shows it on first sign-in.

## 6. WhatsApp and TaxWise Desktop
- [ ] Settings → WhatsApp: the five firm numbers entered; each office phone has two-step verification on and a named custodian.
- [ ] TaxWise Desktop built with `TAXWISE_APP_URL` = the production URL, **signed** (Windows code-signing certificate;
      macOS notarised), and installed on the office PCs that will hold WhatsApp, within the linked-device limit.
- [ ] Pilot on two PCs with the Staff office number first; confirm the open-chat search, client mode and the
      `accept?code=` fallback on the live WhatsApp Web page (see `desktop/README.md`); stop if WhatsApp shows any warning.

## 7. Acceptance run (§18.3)
Run every item in §18.3 on **staging**, role by role (Partner 1–13, Manager 1–6, Employee 1–10, Client 1–7), at
1366×768 and 390×844, in light and dark themes. Automated coverage today:
- unit tests for every pure rule (`npm test`) and role × table database tests (`npm run test:db`) — run in CI;
- TaxWise Desktop Electron end-to-end tests (`desktop/`, `npm run e2e`) — run in CI.
Record the run (date, who, result per item) in Quality before go-live.
