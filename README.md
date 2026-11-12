# TaxWise Practice OS

The practice-management system for **TaxWise Consultants, Bengaluru** — clients and onboarding, compliance calendar and
filings, work and timesheets, leads and quotations, GST invoicing and collections, the client portal, workpapers
(GST reconciliation, ITR computation, Schedule III statements, notices), ICAI registers and audit engagements, and
WhatsApp for every message to a client. Powered by J-TACS.

The full product specification is [`docs/SPEC.md`](docs/SPEC.md) (cited as §n throughout the code).
Engineering conventions: [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md). Design brief: [`docs/DESIGN.md`](docs/DESIGN.md).
Go-live checklist: [`docs/GO-LIVE.md`](docs/GO-LIVE.md). Local QA stack, crawler and the final crawl's results:
[`docs/QA.md`](docs/QA.md).

## Stack

| Layer | Choice |
|---|---|
| Web app | Next.js 16 (App Router, `proxy.ts`), React 19, TypeScript strict, Tailwind CSS 4, shadcn/ui (Radix) |
| Data | Supabase: Auth (email + password; an authenticator app optional, from Profile), Postgres with RLS on every table, private Storage |
| Forms and rules | react-hook-form + zod (one schema for client and server); pure business rules in `lib/domain/` |
| Documents | Server-side PDFs (`@react-pdf/renderer`), Excel/CSV (`exceljs`, `papaparse`) |
| Messaging | WhatsApp only: the chat opens in WhatsApp Web (the WhatsApp app on a phone) with the message typed in and the document downloaded to attach. The app sends no email |
| Hosting | Vercel, built from GitHub on every push (`vercel.json`: the app's server in Mumbai, `bom1`) |
| Scheduling | Supabase Cron every 15 minutes → `/api/cron/tick` runs the jobs that are due (`server/jobs/schedule.ts`) |

## Repository layout

```
app/                 routes: (auth), (staff), (portal)/portal, q/[token] (public quotation), api/*
components/          ui/ (shadcn primitives), app/ (TaxWise patterns), brand/ (the logo), one folder per module
lib/brand.ts         the TaxWise logo as vector paths (screen, icons and PDF letterheads draw from it)
lib/domain/          pure business rules (GST, TDS, ITR, statutory calendar, recon, Schedule III, covers, …)
lib/data/            typed reads (run under the signed-in user's RLS)
server/actions/      mutations, each wrapped in defineAction (lib/action.ts)
server/admin.ts      the ONLY use of the Supabase service-role key
server/jobs/         scheduled job bodies, the schedule and the scheduler's check
supabase/migrations/ the schema — applied in order, never edited after release
supabase/seed/       §16 production seed only (firm settings, law tables, templates) — no demo data
tests/unit/          Vitest unit tests for every pure rule
tests/db/            role × table RLS and SQL function tests against real Postgres
vercel.json          Vercel: the app's server in Mumbai; production builds run env:check first
```

## Local development

Requirements: Node 22+, PostgreSQL 16 (for the database harness).

```bash
npm ci
cp .env.example .env.local          # fill in staging Supabase values (never production)
echo "LOCAL_PG_ADMIN_URL=postgres://postgres:<password>@localhost:5432/postgres" > .env.test.local
npm run db:reset                    # local Postgres + Supabase shim + every migration + seed
npm run dev
```

| Command | What it does |
|---|---|
| `npm run typecheck` · `npm run lint` | TypeScript and ESLint |
| `npm test` | Unit tests (Vitest) |
| `npm run test:db` | Database tests: each file builds a fresh local database and checks RLS per role and the SQL functions |
| `npm run db:reset` | Recreate `taxwise_local` from migrations + seed |
| `npm run db:types` | Regenerate `lib/database.types.ts` after a migration |
| `npm run env:check` | Validate environment variables (exits non-zero on missing or example values) |
| `npm run build` | Production build |

The database harness (`scripts/db-local.ts`, `tests/db/shim/`) refuses to touch anything but `localhost`.

## Supabase setup (two projects)

Create **two** Supabase projects in the same region: `taxwise-production` (real data, production branch) and
`taxwise-staging` (test data, preview deployments and testing). Production is never used for testing. On the
region: pick **Mumbai (South Asia)**. It keeps the data in India, and `vercel.json` runs the app's server in Mumbai
too (`bom1`), next to the database, which matters because every page asks the database a few questions. A project
can't move region later.

For each project:

1. **Schema:** from GitHub, no tools needed: add the repository secrets `SUPABASE_DB_URL_STAGING` and
   `SUPABASE_DB_URL_PRODUCTION` (Settings → Secrets and variables → Actions; the value is Supabase → Connect →
   Session pooler, with the database password filled in), then Actions → **Database** → Run workflow → staging or
   production. It applies `supabase/migrations/*.sql` in order (skipping those already applied) and the seed
   (`.github/workflows/database.yml`). From a computer instead: `supabase db push --db-url "<session pooler URL>"
   --include-seed`. Settings → Diagnostics compares the database's `schema_version` with the code's
   `EXPECTED_SCHEMA_VERSION`, so it shows when an update needs the workflow run again.
2. **Auth → Providers → Email:** enabled (people sign in with an email address and a password; no email is sent);
   **disable sign-ups**; enable TOTP MFA. Session: refresh-token rotation on.
3. **Auth → URL configuration:** Site URL = the app URL.
4. **Storage:** buckets `client-documents`, `task-files`, `generated` (private) and `branding` (public logo) are created
   by the migrations. Optionally set `allowed_mime_types` on `client-documents` as a second file-type check.
5. **Backups:** see Backups below. The Free plan keeps none of its own.

## Backups

The firm runs on Supabase's Free plan, which keeps no backups and pauses a project after a week
without use (the 15-minute scheduler keeps it in use). Two copies are kept instead:

- **Every night (automatic):** `.github/workflows/backup.yml` dumps the production database at
  02:00 IST with the Supabase CLI (roles, schema, data), encrypts it with `BACKUP_PASSPHRASE` and keeps
  it 10 days under Actions → Nightly backup → a run → Artifacts. Add the repository secrets
  `SUPABASE_DB_URL_PRODUCTION` (as for the Database workflow) and `BACKUP_PASSPHRASE` (a long
  passphrase, kept offline with the vault key: a backup can't be opened without it). GitHub Free
  keeps 500 MB of artifacts for a private repository; a backup is about a megabyte per few thousand
  records.
- **Every Friday (by hand):** Settings → Data → **Download full export**, kept in the firm's Google
  Drive.

Neither holds the uploaded documents (Supabase Storage, 1 GB on Free): keep the originals.

To restore into a new Supabase project: download the artifact, then

```bash
gpg --decrypt taxwise-db-YYYY-MM-DD.tar.gz.gpg > backup.tar.gz   # asks for BACKUP_PASSPHRASE
mkdir backup && tar -xzf backup.tar.gz -C backup && cd backup
psql "<new project's session pooler URL>" --single-transaction --variable ON_ERROR_STOP=1 \
  --file roles.sql --file schema.sql --command 'SET session_replication_role = replica' --file data.sql
```

then point the Vercel environment variables at the new project. (Checked on a copy of the QA database: every
table came back with the same row counts.)

## Hosting on Vercel

1. **Project:** Vercel → Add New → Project → import this repository (the Vercel GitHub app needs access to it).
   Vercel detects Next.js. `vercel.json` runs the app's server in Mumbai (`bom1`) and makes production builds run
   `npm run env:check` first, so a missing or example value stops the build instead of reaching the live site. Every
   push to the production branch deploys; other branches and pull requests get preview deployments.
2. **Environment variables:** Settings → Environment Variables: every variable in [`.env.example`](.env.example)
   (it says what breaks without each one), for Production (and Preview, pointed at the staging project).
   Where each value comes from:
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (anon or publishable key) and
     `SUPABASE_SERVICE_ROLE_KEY` (service_role or secret key): Supabase → the project → Project Settings → API Keys
     (the URL under Data API).
   - `DATABASE_URL` (transaction pooler) and `DIRECT_URL` (session pooler): Supabase → Connect. Optional for the
     app itself.
   - `CREDENTIAL_VAULT_KEY` and `CRON_SECRET`: make them yourself with `openssl rand -hex 32` (or, in the Supabase SQL
     editor, `select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');`). **Keep an offline copy
     of the vault key**: losing it makes every stored portal password unreadable.
   - `NEXT_PUBLIC_APP_URL`: the firm's address (`https://app.twchartered.com`); `APP_ENV`: `production` on the live
     site, `staging` on previews; `FIRST_PARTNER_EMAIL`: the first Partner's login.
   A variable change takes effect on the next deployment (Deployments → ⋯ → Redeploy).
3. **Domain:** Settings → Domains → add `app.twchartered.com`. `twchartered.com` is already in the firm's Vercel
   account with its DNS at Cloudflare, so add the record Vercel shows there: CNAME `app` → the target Vercel gives
   (e.g. `cname.vercel-dns.com`), proxy status **DNS only**. HTTPS follows on its own. Then set `NEXT_PUBLIC_APP_URL`
   and the Supabase Site URL to it and redeploy.
4. **Deployment Protection:** Vercel Authentication (on by default) keeps the `*.vercel.app` addresses for the Vercel
   team only; the firm's own domain stays public, which clients, the portal, quotation links and the scheduler need.
5. **Plan:** Vercel's free Hobby plan is meant for personal, non-commercial use; a firm's working system belongs on
   Pro. The app runs the same on either (the scheduler below doesn't use Vercel Cron).

### Scheduled jobs

The jobs of §8 (times in UTC in `server/jobs/schedule.ts`; IST − 5:30) run from one check every 15 minutes:
`/api/cron/tick` works out what is due, runs it, and continues a long job on the next check. Supabase Cron calls it
(free on every Supabase plan, and independent of the Vercel plan; Hobby's own cron jobs run at most once a day). Set
it up once in the production project's SQL editor, with the app's address and the `CRON_SECRET` value in place:

```sql
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
select cron.schedule(
  'taxwise-scheduler',
  '*/15 * * * *',
  $$ select net.http_post(
       url := 'https://app.twchartered.com/api/cron/tick?background=1',
       headers := jsonb_build_object('Authorization', 'Bearer <CRON_SECRET>'),
       timeout_milliseconds := 10000
     ) $$
);
```

With `?background=1` the app answers at once and runs the check after answering (`after()`, up to 60 seconds), so
the call's HTTP timeout never cuts a check short. Running `cron.schedule` again with the same name replaces the job
(a new address or secret); `select cron.unschedule('taxwise-scheduler');` stops it. Supabase → Integrations → Cron
shows the job and its runs; Settings → Diagnostics → Cron jobs shows each job's last run. On a Vercel Pro plan,
Vercel Cron can make the call instead: add `"crons": [{ "path": "/api/cron/tick", "schedule": "*/15 * * * *" }]` to
`vercel.json` (Vercel sends the `CRON_SECRET` header itself) and unschedule the Supabase job.

## Messaging (WhatsApp)

Every message to a client goes out on WhatsApp. Wherever there is something to send (an invoice, a quotation, a
reminder, a document request, a portal login), **Send on WhatsApp** shows the client's number and a ready message
from Settings → Templates, filled in; the text can be edited. Pressing it opens the chat in WhatsApp Web, in one
window on the right half of the screen (the WhatsApp app on a phone), with the message typed in, and downloads the
document in the same click: attach it with the paperclip (or drag it in) and press Send. The client's Communication
tab records the hand-off. WhatsApp Web must be signed in on the computer (WhatsApp → Linked devices) and pop-ups
allowed for the app's address.

The app sends no email. Staff logins and client portal logins are handed out on WhatsApp with a temporary password,
changed at first sign-in; a forgotten password is reset by a Partner or Manager (People, or the client's Portal
access).

## First run

Open `/setup` while no users exist: it creates the first Partner (app role in `app_metadata` + `profiles`), confirms the
firm details from §1 and then 404s forever. Two-step sign-in (TOTP) is optional: anyone turns it on from Profile. The Partner dashboard
shows the setup checklist (bank and UPI, ICAI numbers, firm WhatsApp numbers, team, first client, first invoice,
law & rules review). The TaxWise logo is built in, so there is nothing to upload.

## Security model (summary)

- RLS on every table is the real control; the interface only hides what a role can't use.
- A user's role comes from `profiles.role` (server) and `app_metadata.role` (JWT), never `user_metadata`.
- Employees never receive fee, invoice, receipt, credit-note, quotation or lead data — enforced in RLS and tested.
- Only `server/admin.ts` holds the service-role key; `scripts/check-service-role.mjs` fails the build if it reaches the browser.
- Portal passwords are AES-256-GCM encrypted (`server/vault.ts`); revealing one is logged.
- Audit log is insert-only, including against `TRUNCATE`.
- The database API and file storage answer only this app's server (migration 0243): a request made with a
  login alone, without the token the server derives from `CREDENTIAL_VAULT_KEY`, is refused, so nobody can
  go around the rules that live in the app's server actions. The scheduler switches the gate on by itself
  once the database recognises the app; Settings → Diagnostics → "Database API gate" shows its state.
  `API_GATE=off` in the environment opens it again (for a rollback to an older build).

## Law and rules

Rates, thresholds, due dates and section numbers are data (`statutory_parameters`, `due_date_rules`,
`due_date_overrides`, `section_concordance`), editable on Settings → Law & rules. Items marked **[verify]** in §6 are
seeded unverified and listed as "awaiting partner confirmation". A Partner ticks the rows checked against their
source and confirms them together, or one at a time.

## Changes from the original specification

Decided with TaxWise after the specification (`docs/SPEC.md`) was written; where the two disagree, this wins:

- **No TaxWise Desktop.** Staff use the web app in their browser; WhatsApp Web opens in its own window beside it.
  §7.25 and the desktop parts of §7.13 are not built.
- **No email.** WhatsApp is the only channel to clients (above). The app sends no invoices, reminders, invites,
  digests or password resets by email, and has no Settings → Email.
- **One scheduler check.** The scheduled jobs of §8 keep their times, but one check every 15 minutes (Supabase
  Cron → `/api/cron/tick`) runs whatever is due, instead of a Vercel Cron job per job.
- **Two-step sign-in is optional.** §12 required an authenticator app for Partners and Managers; the firm chose to
  make it optional for everyone (Profile → Two-step sign-in). `MFA_REQUIRED_ROLES` in `lib/auth/mfa.ts` turns the
  requirement back on for a role.
- **Reopening filed work is a Partner's or Manager's move.** §7.6.4 let any assignee reopen a Filed/Done task
  with a reason; an Employee now asks a Manager, and a reopen tells the assignee, the reviewer, whoever filed it
  and the client's owner.
- **Capacity reads Free / Busy / Tight / Over**, not the capitals of §7.11.4.
- **A day's time has to be possible.** No more than 24 hours in a day, no overlapping timed entries, and a timer
  stopped after 12 hours counts as 12 hours (migration 0244).
- **The logo is built in.** The firm's shield and wordmark are redrawn as vectors in `lib/brand.ts` and appear
  in the app, its icons and every PDF letterhead. Uploading a logo in Settings → Firm details is optional and
  replaces it; the setup checklist has no logo step.
