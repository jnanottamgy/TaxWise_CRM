# Go-live checklist (§18.2) and acceptance run (§18.3)

Tick every line before real client data goes into production. Owner: a Partner, with whoever deploys.

## 1. Environments
- [ ] Two Supabase projects exist: `taxwise-production` and `taxwise-staging`, in the region the Partners chose
      (README → Supabase setup). Staging holds no real data (only `scripts/seed-staging.ts` synthetic data, which
      refuses to run with `APP_ENV=production`).
- [ ] The Netlify site publishes the production branch with production variables; deploy previews use staging.
- [ ] The firm's domain (e.g. `app.twchartered.com`) points at Netlify, HTTPS is on, and `NEXT_PUBLIC_APP_URL` and the
      Supabase Site URL use it.
- [ ] The GitHub repository is **private**.

## 2. Database
- [ ] Migrations and seed applied: GitHub → Actions → **Database** → Run workflow → production (it skips what is
      already applied).
- [ ] Settings → Diagnostics: schema version matches, every table answers, enums complete, RLS helpers present, buckets exist.
- [ ] RLS is on for every table — prove it in the SQL editor:
      `select tablename from pg_tables where schemaname = 'public' and not rowsecurity;` returns no rows.
- [ ] Backups decided and in place: Supabase Pro (daily backups, 7 days) or a weekly full export kept outside
      Supabase (Settings → Data); point-in-time recovery if the Partners want it. First restore drill recorded in
      Quality → Restore drills.

## 3. Configuration
- [ ] `npm run env:check` passes against the production values (the production build on Netlify runs it).
- [ ] `CREDENTIAL_VAULT_KEY` set **and backed up offline** before any portal credential is stored.
- [ ] Auth: sign-ups disabled; TOTP enabled; Site URL set.
- [ ] Scheduler: Netlify → Logs → Functions → `scheduler` shows a check every 15 minutes; every job has run once
      successfully (Diagnostics → Cron jobs).

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

## 6. WhatsApp
- [ ] Settings → WhatsApp: the firm numbers entered; each office phone has two-step verification on and a named custodian.
- [ ] Settings → Templates: the WhatsApp messages reviewed by a Partner (invoice, quotation, receipt, reminders,
      document requests, login hand-out).
- [ ] On each computer that sends: WhatsApp Web signed in to the right office number (WhatsApp → Linked devices) and
      pop-ups allowed for the app's address, so the chat opens in its window beside the CRM.
- [ ] Pilot with two people for a week: send an invoice, a quotation and a reminder from the app; check the text, the
      attached PDF and the hand-off on the client's Communication tab.

## 7. Acceptance run (§18.3)
Run every item in §18.3 on **staging**, role by role (Partner 1–13, Manager 1–6, Employee 1–10, Client 1–7), at
1366×768 and 390×844, in light and dark themes. Automated coverage today:
- unit tests for every pure rule (`npm test`) and role × table database tests (`npm run test:db`) — run in CI.
Record the run (date, who, result per item) in Quality before go-live.
