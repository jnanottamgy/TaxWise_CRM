# TaxWise Practice OS

The practice-management system for **TaxWise Consultants, Bengaluru** — clients and onboarding, compliance calendar and
filings, work and timesheets, leads and quotations, GST invoicing and collections, the client portal, workpapers
(GST reconciliation, ITR computation, Schedule III statements, notices), ICAI registers and audit engagements, and
TaxWise Desktop with each client's WhatsApp group beside the CRM. Powered by J-TACS.

The full product specification is [`docs/SPEC.md`](docs/SPEC.md) (cited as §n throughout the code).
Engineering conventions: [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md). Design brief: [`docs/DESIGN.md`](docs/DESIGN.md).
Go-live checklist: [`docs/GO-LIVE.md`](docs/GO-LIVE.md). Desktop ↔ CRM contract: [`docs/DESKTOP-API.md`](docs/DESKTOP-API.md).
Local QA stack, crawler and the final crawl's results: [`docs/QA.md`](docs/QA.md).

## Stack

| Layer | Choice |
|---|---|
| Web app | Next.js 16 (App Router, `proxy.ts`), React 19, TypeScript strict, Tailwind CSS 4, shadcn/ui (Radix) |
| Data | Supabase: Auth (email + password, TOTP for Partners/Managers), Postgres with RLS on every table, private Storage |
| Forms and rules | react-hook-form + zod (one schema for client and server); pure business rules in `lib/domain/` |
| Documents | Server-side PDFs (`@react-pdf/renderer`), Excel/CSV (`exceljs`, `papaparse`) |
| Email | Resend from the verified `twchartered.com` domain; WhatsApp and Gmail hand-offs everywhere |
| Scheduling | Vercel Cron → `/api/cron/<job>` (schedule in `vercel.json`, IST in `server/jobs/schedule.ts`) |
| Desktop | `desktop/` — Electron app (CRM + WhatsApp Web panel), see [`desktop/README.md`](desktop/README.md) |

## Repository layout

```
app/                 routes: (auth), (staff), (portal)/portal, q/[token] (public quotation), api/*
components/          ui/ (shadcn primitives), app/ (TaxWise patterns), one folder per module
lib/domain/          pure business rules (GST, TDS, ITR, statutory calendar, recon, Schedule III, covers, …)
lib/data/            typed reads (run under the signed-in user's RLS)
server/actions/      mutations, each wrapped in defineAction (lib/action.ts)
server/admin.ts      the ONLY use of the Supabase service-role key
server/jobs/         scheduled job bodies
supabase/migrations/ the schema — applied in order, never edited after release
supabase/seed/       §16 production seed only (firm settings, law tables, templates) — no demo data
tests/unit/          Vitest unit tests for every pure rule
tests/db/            role × table RLS and SQL function tests against real Postgres
desktop/             TaxWise Desktop (Electron)
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

Create **two** Supabase projects in the South Asia (Mumbai) region: `taxwise-production` (real data, `main` branch)
and `taxwise-staging` (test data, `develop` branch and every preview deployment). Production is never used for testing.

For each project:

1. **Schema:** apply the migrations with the Supabase CLI against the project's *direct* (session) connection —
   `supabase link --project-ref <ref>` then `supabase db push` (applies `supabase/migrations/*.sql` in order and records
   them). Seed with `supabase db push --include-seed` the first time. Diagnostics (Settings → Diagnostics) compares the
   database's `schema_version` with the code's `EXPECTED_SCHEMA_VERSION`.
2. **Auth → Providers → Email:** enabled; **disable sign-ups**; enable TOTP MFA. Session: refresh-token rotation on.
3. **Auth → URL configuration:** Site URL = the app URL; add `<APP_URL>/auth/confirm` to redirect URLs.
4. **Auth → Email templates → Reset password:** link to
   `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/reset-password`
   (the branded template text is in `server/email/templates/password-reset.tsx`).
5. **Auth → SMTP:** point at Resend (`smtp.resend.com`) once the domain is verified, so reset emails come from TaxWise.
6. **Storage:** buckets `client-documents`, `task-files`, `generated` (private) and `branding` (public logo) are created
   by the migrations. Optionally set `allowed_mime_types` on `client-documents` as a second file-type check.
7. **Database → Backups:** turn on point-in-time recovery (Pro plan) before real data goes in (§12, §18.2).

## Vercel

1. Import the repository; framework Next.js. Production branch `main`; preview deployments use the **staging** project.
2. Environment variables: every variable in [`.env.example`](.env.example) (it documents what breaks without each one).
   Generate `CREDENTIAL_VAULT_KEY` with `openssl rand -hex 32` and **keep an offline copy** — losing it makes every stored
   portal password unreadable. `CRON_SECRET`: a long random string.
3. Cron: `vercel.json` registers every job (UTC times; IST − 5:30). Vercel sends `Authorization: Bearer <CRON_SECRET>`.
   The job list needs a plan that allows this many cron jobs at hourly frequency — check your Vercel plan's cron limits.
4. Run `npm run env:check` in the Vercel build (or locally against the production values) before go-live.

## Email (Resend)

Settings → Email (Partner) adds `twchartered.com` to Resend and shows the DNS records (SPF, DKIM, return-path, DMARC)
to add at the domain registrar; it shows **Verified** only when Resend says so. Until then, automatic client emails are
not attempted and every send offers WhatsApp/Gmail hand-offs. Add a Resend webhook to
`<APP_URL>/api/webhooks/resend` (events listed on the Settings → Email page) and set `RESEND_WEBHOOK_SECRET`.

## First run

Open `/setup` while no users exist: it creates the first Partner (app role in `app_metadata` + `profiles`), confirms the
firm details from §1 and then 404s forever. Every Partner and Manager enrols TOTP on first sign-in. The Partner dashboard
shows the setup checklist (logo, bank and UPI, ICAI numbers, email domain, firm WhatsApp numbers, team, first client,
first invoice, law & rules review).

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
