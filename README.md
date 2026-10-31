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
| Data | Supabase: Auth (email + password, TOTP for Partners/Managers), Postgres with RLS on every table, private Storage |
| Forms and rules | react-hook-form + zod (one schema for client and server); pure business rules in `lib/domain/` |
| Documents | Server-side PDFs (`@react-pdf/renderer`), Excel/CSV (`exceljs`, `papaparse`) |
| Messaging | WhatsApp only: the chat opens in WhatsApp Web (the WhatsApp app on a phone) with the message typed in and the document downloaded to attach. The app sends no email |
| Hosting | Netlify, built from GitHub on every push (`netlify.toml`) |
| Scheduling | A Netlify scheduled function every 15 minutes → `/api/cron/tick` runs the jobs that are due (`server/jobs/schedule.ts`) |

## Repository layout

```
app/                 routes: (auth), (staff), (portal)/portal, q/[token] (public quotation), api/*
components/          ui/ (shadcn primitives), app/ (TaxWise patterns), one folder per module
lib/domain/          pure business rules (GST, TDS, ITR, statutory calendar, recon, Schedule III, covers, …)
lib/data/            typed reads (run under the signed-in user's RLS)
server/actions/      mutations, each wrapped in defineAction (lib/action.ts)
server/admin.ts      the ONLY use of the Supabase service-role key
server/jobs/         scheduled job bodies, the schedule and the scheduler's check
supabase/migrations/ the schema — applied in order, never edited after release
supabase/seed/       §16 production seed only (firm settings, law tables, templates) — no demo data
tests/unit/          Vitest unit tests for every pure rule
tests/db/            role × table RLS and SQL function tests against real Postgres
netlify/functions/   the scheduler (every 15 minutes on the live site)
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
`taxwise-staging` (test data, deploy previews and testing). Production is never used for testing. On the region:
Mumbai (South Asia) keeps the data in India; the app's server on Netlify runs in the USA (Ohio) unless the Netlify
plan lets you pick a region, and every page asks the database a few questions, so a database in East US (Ohio)
answers fastest. Pick one before real data goes in: a project can't move region later.

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
5. **Backups (§12, §18.2):** the Pro plan keeps a daily backup for 7 days and never pauses the project; the Free plan
   has neither, and pauses a project after a week without use. Point-in-time recovery is a paid add-on on top of Pro.
   Whatever the plan, download Settings → Data → **Download full export** regularly (weekly at least) and keep it
   outside Supabase; on the Free plan it is the only backup of the records. Uploaded documents are not in it.

## Hosting on Netlify

1. **Site:** Netlify → Add new site → Import an existing project → GitHub → this repository. Netlify reads
   `netlify.toml` (build command, Node 22) and detects Next.js; choose the branch to publish. Every push builds a new
   deploy; pull requests get deploy previews (point them at the staging project).
2. **Environment variables:** Site configuration → Environment variables, every variable in
   [`.env.example`](.env.example) (it says what breaks without each one). Where each value comes from:
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (anon or publishable key) and
     `SUPABASE_SERVICE_ROLE_KEY` (service_role or secret key): Supabase → the project → Project Settings → API.
   - `DATABASE_URL` (transaction pooler) and `DIRECT_URL` (session pooler): Supabase → Connect.
   - `CREDENTIAL_VAULT_KEY` and `CRON_SECRET`: make them yourself with `openssl rand -hex 32` (or, in the Supabase SQL
     editor, `select encode(gen_random_bytes(32), 'hex');`). **Keep an offline copy of the vault key**: losing it makes
     every stored portal password unreadable.
   - `NEXT_PUBLIC_APP_URL`: the site's address (the `netlify.app` one while testing, then the firm's domain);
     `APP_ENV`: `production` on the live site, `staging` elsewhere; `FIRST_PARTNER_EMAIL`: the first Partner's login.
   The production build runs `npm run env:check` first and stops if a value is missing or still the example.
3. **Scheduled jobs:** `netlify/functions/scheduler.mts` runs every 15 minutes on the published deploy and calls
   `/api/cron/tick` with `Authorization: Bearer <CRON_SECRET>`. The check runs the jobs that are due (times in UTC in
   `server/jobs/schedule.ts`; IST − 5:30), keeps each request inside Netlify's time limit (about 10 seconds), and
   continues a long job on the next check. Netlify → Logs → Functions → `scheduler` shows each check;
   Settings → Diagnostics → Cron jobs shows each job's last run. If the app ever moves host, anything that can call
   that URL every 15 minutes with the header does the same job (a GitHub Actions schedule, cron-job.org).
4. **Domain:** Domain management → Add a domain (e.g. `app.twchartered.com`), add the DNS record Netlify shows at the
   domain's registrar, and HTTPS follows on its own. Then set `NEXT_PUBLIC_APP_URL` and the Supabase Site URL to it.

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
firm details from §1 and then 404s forever. Every Partner and Manager enrols TOTP on first sign-in. The Partner dashboard
shows the setup checklist (logo, bank and UPI, ICAI numbers, firm WhatsApp numbers, team, first client, first invoice,
law & rules review).

## Security model (summary)

- RLS on every table is the real control; the interface only hides what a role can't use.
- A user's role comes from `profiles.role` (server) and `app_metadata.role` (JWT), never `user_metadata`.
- Employees never receive fee, invoice, receipt, credit-note, quotation or lead data — enforced in RLS and tested.
- Only `server/admin.ts` holds the service-role key; `scripts/check-service-role.mjs` fails the build if it reaches the browser.
- Portal passwords are AES-256-GCM encrypted (`server/vault.ts`); revealing one is logged.
- Audit log is insert-only, including against `TRUNCATE`.

## Law and rules

Rates, thresholds, due dates and section numbers are data (`statutory_parameters`, `due_date_rules`,
`due_date_overrides`, `section_concordance`), editable on Settings → Law & rules. Items marked **[verify]** in §6 are
seeded unverified and listed as "awaiting partner confirmation" — a Partner confirms each before go-live.

## Changes from the original specification

Decided with TaxWise after the specification (`docs/SPEC.md`) was written; where the two disagree, this wins:

- **No TaxWise Desktop.** Staff use the web app in their browser; WhatsApp Web opens in its own window beside it.
  §7.25 and the desktop parts of §7.13 are not built.
- **No email.** WhatsApp is the only channel to clients (above). The app sends no invoices, reminders, invites,
  digests or password resets by email, and has no Settings → Email.
- **Netlify, not Vercel.** The scheduled jobs of §8 keep their times; one check every 15 minutes runs them.
