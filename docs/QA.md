# QA: the local stack and the crawler

This is how the real pages were rendered with real data before go-live, and how to do it again. The
stack runs the app's **production build, unchanged**, against a local Postgres database that holds a
realistic practice (40 clients, 172 tasks, 90 invoices, 3,600+ deadlines …), with every read going
through PostgREST under the signed-in user's role, so Row Level Security decides what each page gets,
exactly as it does on Supabase. A crawler then opens every route as every role at three viewport and
theme combinations and records anything that went wrong.

The harness lives in `scripts/local-stack/` (its `README.md` has the details of each file). It never
talks to a real Supabase project and never sends mail.

```
browser ──► next start :3100 ──► Supabase stand-in :54321 ──► PostgREST :3333 ──► Postgres taxwise_qa
            (production build)    /auth/v1  signed JWTs        (RLS as the user)
                                  /storage/v1  404/501 JSON
                                  /rest/v1  → PostgREST
```

## 1. Prerequisites

| Need | How |
|---|---|
| Node 22 and `node_modules` | `npm ci` |
| Postgres 16 with the Supabase shim | the same cluster `npm run test:db` uses: `LOCAL_PG_ADMIN_URL` in `.env.test.local` (start it with `pg_ctlcluster 16 main start`) |
| PostgREST 12.2.3 (static Linux build) | download into `.local-stack/bin/` (or set `QA_POSTGREST_BIN`); exact commands in `scripts/local-stack/README.md` |
| chrome-headless-shell 131 (for the crawler) | download into `.local-stack/bin/` (or set `QA_CHROME_BIN`) |

`.local-stack/` holds the throwaway keys, pid files, logs and binaries, and ignores itself in git.

## 2. Running the stack

```bash
npx tsx scripts/local-stack/stack.ts up --fresh    # rebuild taxwise_qa, production build, next start on :3100
npx tsx scripts/local-stack/stack.ts up            # idempotent: reuses the data and the build when unchanged
npx tsx scripts/local-stack/stack.ts up --dev      # next dev instead (hot reload while fixing a page)
npx tsx scripts/local-stack/stack.ts status        # services, row counts, binaries
npx tsx scripts/local-stack/stack.ts reset-data    # reload taxwise_qa only
npx tsx scripts/local-stack/stack.ts down          # stop everything (keeps keys, data and build)
npx tsx scripts/local-stack/stack.ts down --purge  # also drop taxwise_qa and forget the keys
```

`up` rebuilds the app whenever the source tree (HEAD plus uncommitted changes) or `.next/BUILD_ID`
changed, so run it again after any edit, or after anyone else's `npm run build`. The QA data is built
relative to **today in IST**; reload it with `--fresh` on a later day so "due today", "overdue" and the
relative dates stay meaningful. Logs: `.local-stack/logs/{app,mock,postgrest,build,data}.log`; the
stand-in logs every PostgREST error it forwards (status, path, role, body), which is usually the
fastest route to the cause of a block error.

**Signing in.** In a browser, `/login` with `p1@taxwise.test` (and so on), the password printed by `npx tsx scripts/local-stack/stack.ts status` (random per stack),
two-step code `123456`. For scripts, `npx tsx scripts/local-stack/sessions.ts P1` prints a Cookie
header (`--json` gives Playwright cookies).

| Key | Person | Role |
|---|---|---|
| P1, P2 | Raghavendra Bhat, Shalini Hegde | Partner |
| M1, M2 | Anita Rao, Suresh Kulkarni | Manager |
| E1–E4 | Ravi Kumar, Deepa Nair, Meghana Iyer, Kiran Shetty | Employee (E1 is on 15 clients' teams) |
| CA, CB | Mahesh Gowda (Alpha Traders), Sunita Reddy (Beta Industries) | Client portal |
| X, D | Arjun Patil, Pooja Naik | staff without a usable login (D is disabled) |

## 3. Running the crawler

```bash
npx tsx scripts/local-stack/crawl.ts --round r-final --out <dir>          # everything (897 visits, ~20 min)
npx tsx scripts/local-stack/crawl.ts --roles employee --viewports mobile-light --only work
npx tsx scripts/local-stack/crawl.ts --round r-final --out <dir> --report-only   # rebuild report.md
```

It writes `<dir>/<round>/report.md` (problems grouped by area, the refusals table, PostgREST errors the
stand-in saw, errors in the app's server log, the slowest visits), `report.json`, `results.jsonl` (one
line per visit, written as it goes) and a full-page screenshot per visit,
`<dir>/<round>/<role>/<route>-<viewport>.png`.

**Who and where.** Partner (P1), Manager (M1), Employee (E1), the portal user (CA) and a signed-out
visitor, each at **1366×768 light, 1366×768 dark and 390×844 light** (touch, mobile). Each role visits
its own navigation from `lib/nav.ts`; detail pages found in the QA database (Client 360 with all 13 tabs,
a task, the four Work views, a lead, quotations and the quotation editor, invoices and the invoice
editor, an audit, each kind of workpaper, a person, an engagement letter, a client group, every
register tab, every report, every Settings section, the new-record pages); and other roles' pages that
**must be refused**:

| Role | Must be refused |
|---|---|
| Employee | every money, growth and practice-management page (`/invoices`, `/quotations`, `/leads`, `/payments`, `/fee-realisation`, `/revenue`, `/tds-credits`, `/retainer-drafts`, `/acceptance`, `/audits`, `/engagement-letters`, `/reports`, `/recycle-bin`, `/audit-log`), `/clients/groups`, `/clients/new`, `/whatsapp-groups`, `/filings`, Partner-only Settings, the new-invoice and new-quotation pages, an invoice, a quotation, a lead and an audit by id; `/dashboard` redirects to My day |
| Manager | `/payments`, `/audit-log` and every Partner-only Settings section |
| Client | staff pages (`/dashboard`, `/clients`, a client's Client 360, `/work`, `/invoices`, `/messages`, `/settings/firm`) and **another client's invoice** in the portal (must be a 404) |
| Signed out | `/dashboard`, `/clients`, `/invoices`, `/portal`, `/portal/invoices` (all go to `/login`) |

**What counts as a problem** on an allowed page: HTTP ≥ 400; the route error boundary ("This page
didn't load"); `ShellUnavailable`; a block error (with its Ref, matched to the app log); Next's own error
text; a page error or console error (hydration mismatches included); a failed request (≥ 400 or a
network failure) to the app or `/rest/v1`; horizontal overflow of the page (`scrollWidth >
clientWidth`); no h1 or more than one; dark mode not applied; more than 12 s to settle; a refusal page on
an allowed route. On a refused route: anything but a 403/404 or a redirect away (a refusal page with
HTTP 200 also counts, because it means the role check ran after the loading skeleton had streamed).

**API smoke.** The crawler opens pages; route handlers that pages only link to are checked by

```bash
npx tsx scripts/local-stack/api-smoke.ts
```

every PDF (invoice, credit note, receipt, quotation, engagement letter, financial statements, ITR,
management representation, compliance report, client and group statements) and every export (audit
checklist, audit log, financial statements, GST reconciliation, revenue ledger, sales register, each
report) as a Partner, the portal and public quotation PDFs, search and the vCard, a document download
(expects the stack's JSON 404, as there is no storage), money PDFs and firm exports as an Employee and
another client's invoice PDF as a portal user (expects a refusal), and eight tabs of one Employee
sending the presence heartbeat at once (expects all eight answered).

## 4. What the stack cannot cover

These need a real Supabase project, Resend and a real WhatsApp session, so they are on the go-live
checklist (`docs/GO-LIVE.md`) and the §18.3 acceptance run instead:

- **Supabase Auth.** The stand-in issues and verifies signed JWTs for the fixture users: one shared
  password and one TOTP code, no real factor enrolment, no email links (invite, set password, reset
  password, `/auth/confirm`), no sign-up settings, no session expiry by Supabase's clock, and admin
  user changes (create, disable, reset) answer 501. Sign-in, MFA, sessions and role routing are
  covered as far as the app's own code goes; the provider's side is not.
- **Supabase Storage.** There are no buckets or objects: document rows exist but downloads, previews,
  uploads, signed URLs and PDF archiving show their designed error states (the file routes answer a
  JSON 404/501). The magic-byte and size checks are covered by unit tests (`lib/domain/files.ts`).
- **Resend.** `RESEND_API_KEY` is empty, so nothing is ever emailed; pages show "Email isn't set up"
  where they should, and the delivery webhook (`/api/webhooks/resend`) and bounce handling are covered
  by unit and DB tests only.
- **WhatsApp.** The live `web.whatsapp.com` page is never loaded. TaxWise Desktop's e2e suite
  (`cd desktop && xvfb-run --auto-servernum npm run e2e`) drives the real Electron app against a
  fixture page and a mock CRM; the CRM's WhatsApp groups, numbers and checklist pages are crawled.
- **Scheduled jobs and writes.** The crawler only reads. Cron jobs (`/api/cron/[job]`) and server
  actions are covered by unit tests (2,608) and DB tests (742, RLS role × table), not by the crawl.
- **Scale and network.** One database on the same machine: load times are not production numbers,
  and only one user per role is crawled (other users' visibility is the DB tests' job).
- **Accessibility.** The crawler checks headings and dark mode only. Contrast, focus order, keyboard
  use and screen-reader behaviour are not measured by it: run an axe or Lighthouse pass against the
  stack, and the `docs/DESIGN.md` §8 checklist by hand, for those.

Expected noise, not problems: Settings → Diagnostics probes every table as the signed-in Partner, so
the stand-in logs `42501 permission denied` for `employees`, `client_credentials` and `rate_limits`
(tables the API roles can't read by design; the page marks them as such). Crawling `/q/<token>`
signed out counts as the client viewing the quotation, so its view counter rises with every crawl.

## 5. Final run (r-final)

Run on 25 Oct 2026, 04:06–04:15 IST (24 Oct, 22:36–22:45 UTC), after the last fix of the hardening
phase: the stack stopped (`stack.ts down`) and started from scratch (`up --fresh`: `taxwise_qa` rebuilt
from every migration, schema 0239), production build of the final tree.

### Checks run in the same pass

| Check | Result |
|---|---|
| `npx tsc --noEmit -p .` | clean |
| `npx eslint app components hooks lib server proxy.ts tests scripts` | clean |
| `npm test` | 130 files, 2,608 tests, all pass |
| `npm run test:db` | 34 files, 742 tests, all pass (run while the IST and UTC dates differed) |
| `npm run build` (CI placeholder env) | success |
| `node scripts/check-service-role.mjs` | ok, no service-role key or reference in the browser bundle |
| `cd desktop && npm test` / `npm run typecheck` | 14 files, 228 tests, all pass / clean |
| `npx tsx scripts/local-stack/api-smoke.ts` | 38 route checks, 0 bad: 29 PDFs, spreadsheets, CSVs and JSON answered 200 with the right type; 8 refusals (403 for an Employee, 404 for another client's invoice, 401 signed out); the document download gave the designed no-storage 404; 8 of 8 concurrent presence beats answered 200 |

### Crawl results

**897 visits (299 routes × 3 viewports), 0 with problems.** No error boundaries, no block errors, no
page or console errors, no failed requests, no response ≥ 500, no horizontal overflow at 1366 or 390
(the widest page was exactly its viewport), dark mode applied on every dark visit, one h1 on every
allowed page, slowest settle 5.4 s (Partner dashboard, dark). All 741 allowed visits answered 200; all 156
refusal visits were refused: 114 with 403, 3 with 404 (another client's invoice in the portal) and 39
by redirect (Employee `/dashboard` → `/my-day`, a portal user on a staff page → `/portal`, signed out →
`/login?next=…`). The app's server log held no errors; the stand-in saw only the three expected
Diagnostics probes (section 4). Screenshots and `report.md` for this round were written to the
scratch directory of the run and are not kept in the repository; rerun the command in section 3 to
reproduce them.

"pass 3/3" = the route passed at 1366×768 light, 1366×768 dark and 390×844 light; "—" = not that
role's route.

#### Clients

| Route | Partner | Manager | Employee | Client | Signed out |
|---|---|---|---|---|---|
| `/calendar` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/clients` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/clients/:id?tab=billing` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/clients/:id?tab=communication` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/clients/:id?tab=compliance` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/clients/:id?tab=documents` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/clients/:id?tab=engagement` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/clients/:id?tab=overview` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/clients/:id?tab=profile` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/clients/:id?tab=registers` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/clients/:id?tab=services` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/clients/:id?tab=tasks` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/clients/:id?tab=timeline` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/clients/:id?tab=whatsapp` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/clients/:id?tab=workpapers` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/clients/groups` | pass 3/3 | pass 3/3 | — | — | — |
| `/clients/groups/:id` | pass 3/3 | pass 3/3 | — | — | — |
| `/clients/new` | pass 3/3 | pass 3/3 | — | — | — |
| `/filings` | pass 3/3 | pass 3/3 | — | — | — |

#### Work and people

| Route | Partner | Manager | Employee | Client | Signed out |
|---|---|---|---|---|---|
| `/dashboard` | pass 3/3 | pass 3/3 | — | — | — |
| `/inbox` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/leave` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/messages` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/my-day` | — | — | pass 3/3 | — | — |
| `/people` | pass 3/3 | pass 3/3 | — | — | — |
| `/people/:id` | pass 3/3 | pass 3/3 | — | — | — |
| `/performance` | pass 3/3 | pass 3/3 | — | — | — |
| `/profile` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/templates/jobs` | pass 3/3 | pass 3/3 | — | — | — |
| `/templates/messages` | pass 3/3 | pass 3/3 | — | — | — |
| `/timesheet` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/timesheet?new=1` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/work` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/work?new=1` | pass 3/3 | pass 3/3 | — | — | — |
| `/work?view=board` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/work?view=calendar` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/work?view=review` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/work?view=table` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/work/:id` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |

#### Money

| Route | Partner | Manager | Employee | Client | Signed out |
|---|---|---|---|---|---|
| `/acceptance` | pass 3/3 | pass 3/3 | — | — | — |
| `/fee-realisation` | pass 3/3 | pass 3/3 | — | — | — |
| `/invoices` | pass 3/3 | pass 3/3 | — | — | — |
| `/invoices/:id` | pass 3/3 | pass 3/3 | — | — | — |
| `/invoices/:id/edit` | pass 3/3 | pass 3/3 | — | — | — |
| `/invoices/new` | pass 3/3 | pass 3/3 | — | — | — |
| `/leads` | pass 3/3 | pass 3/3 | — | — | — |
| `/leads?new=1` | pass 3/3 | pass 3/3 | — | — | — |
| `/leads/:id` | pass 3/3 | pass 3/3 | — | — | — |
| `/payments` | pass 3/3 | — | — | — | — |
| `/q/:token` | — | — | — | — | pass 3/3 |
| `/quotations` | pass 3/3 | pass 3/3 | — | — | — |
| `/quotations/:id` | pass 3/3 | pass 3/3 | — | — | — |
| `/quotations/:id/edit` | pass 3/3 | pass 3/3 | — | — | — |
| `/quotations/new` | pass 3/3 | pass 3/3 | — | — | — |
| `/retainer-drafts` | pass 3/3 | pass 3/3 | — | — | — |
| `/revenue` | pass 3/3 | pass 3/3 | — | — | — |
| `/tds-credits` | pass 3/3 | pass 3/3 | — | — | — |

#### Practice

| Route | Partner | Manager | Employee | Client | Signed out |
|---|---|---|---|---|---|
| `/audit-log` | pass 3/3 | — | — | — | — |
| `/audits` | pass 3/3 | pass 3/3 | — | — | — |
| `/audits/:id` | pass 3/3 | pass 3/3 | — | — | — |
| `/engagement-letters` | pass 3/3 | pass 3/3 | — | — | — |
| `/engagement-letters/:id` | pass 3/3 | pass 3/3 | — | — | — |
| `/engagement-letters/new` | pass 3/3 | pass 3/3 | — | — | — |
| `/quality` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/recycle-bin` | pass 3/3 | pass 3/3 | — | — | — |
| `/registers` | pass 3/3 | pass 3/3 | — | — | — |
| `/registers?tab=dsc` | pass 3/3 | pass 3/3 | — | — | — |
| `/registers?tab=filings` | pass 3/3 | pass 3/3 | — | — | — |
| `/registers?tab=registrations` | pass 3/3 | pass 3/3 | — | — | — |
| `/registers?tab=udin` | pass 3/3 | pass 3/3 | — | — | — |
| `/registers?tab=vault` | pass 3/3 | pass 3/3 | — | — | — |
| `/reports` | pass 3/3 | pass 3/3 | — | — | — |
| `/reports/clients` | pass 3/3 | pass 3/3 | — | — | — |
| `/reports/collections` | pass 3/3 | pass 3/3 | — | — | — |
| `/reports/compliance` | pass 3/3 | pass 3/3 | — | — | — |
| `/reports/people` | pass 3/3 | pass 3/3 | — | — | — |
| `/reports/pipeline` | pass 3/3 | pass 3/3 | — | — | — |
| `/reports/practice` | pass 3/3 | pass 3/3 | — | — | — |
| `/reports/revenue` | pass 3/3 | pass 3/3 | — | — | — |
| `/reports/work` | pass 3/3 | pass 3/3 | — | — | — |
| `/search` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/search?q=a` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/settings` | pass 3/3 | — | — | — | — |
| `/settings/bank` | pass 3/3 | — | — | — | — |
| `/settings/billing` | pass 3/3 | — | — | — | — |
| `/settings/data` | pass 3/3 | — | — | — | — |
| `/settings/diagnostics` | pass 3/3 | — | — | — | — |
| `/settings/email` | pass 3/3 | — | — | — | — |
| `/settings/firm` | pass 3/3 | — | — | — | — |
| `/settings/law` | pass 3/3 | — | — | — | — |
| `/settings/numbering` | pass 3/3 | — | — | — | — |
| `/settings/reminders` | pass 3/3 | — | — | — | — |
| `/settings/templates` | pass 3/3 | — | — | — | — |
| `/settings/working-hours` | pass 3/3 | — | — | — | — |
| `/workpapers` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/workpapers/financial-statements` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/workpapers/financial-statements/:id` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/workpapers/gst-recon` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/workpapers/gst-recon/:id` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/workpapers/itr` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/workpapers/itr/:id` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/workpapers/itr/new` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/workpapers/notices` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |
| `/workpapers/notices/:id` | pass 3/3 | pass 3/3 | pass 3/3 | — | — |

#### Portal and WhatsApp

| Route | Partner | Manager | Employee | Client | Signed out |
|---|---|---|---|---|---|
| `/portal` | — | — | — | pass 3/3 | — |
| `/portal/compliance` | — | — | — | pass 3/3 | — |
| `/portal/deadlines` | — | — | — | pass 3/3 | — |
| `/portal/documents` | — | — | — | pass 3/3 | — |
| `/portal/help` | — | — | — | pass 3/3 | — |
| `/portal/invoices` | — | — | — | pass 3/3 | — |
| `/portal/invoices/:id` | — | — | — | pass 3/3 | — |
| `/portal/messages` | — | — | — | pass 3/3 | — |
| `/portal/welcome` | — | — | — | pass 3/3 | — |
| `/settings/whatsapp` | pass 3/3 | — | — | — | — |
| `/whatsapp-groups` | pass 3/3 | pass 3/3 | — | — | — |

#### Sign-in and public

| Route | Partner | Manager | Employee | Client | Signed out |
|---|---|---|---|---|---|
| `/login` | — | — | — | — | pass 3/3 |

#### Refused routes (must answer 403/404 or redirect, never data)

| Route | Partner | Manager | Employee | Client | Signed out |
|---|---|---|---|---|---|
| `/acceptance` | — | — | refused 3/3 | — | — |
| `/audit-log` | — | refused 3/3 | refused 3/3 | — | — |
| `/audits` | — | — | refused 3/3 | — | — |
| `/audits/:id` | — | — | refused 3/3 | — | — |
| `/clients` | — | — | — | refused 3/3 | refused 3/3 |
| `/clients/:id` | — | — | — | refused 3/3 | — |
| `/clients/groups` | — | — | refused 3/3 | — | — |
| `/clients/new` | — | — | refused 3/3 | — | — |
| `/dashboard` | — | — | refused 3/3 | refused 3/3 | refused 3/3 |
| `/engagement-letters` | — | — | refused 3/3 | — | — |
| `/fee-realisation` | — | — | refused 3/3 | — | — |
| `/filings` | — | — | refused 3/3 | — | — |
| `/invoices` | — | — | refused 3/3 | refused 3/3 | refused 3/3 |
| `/invoices/:id` | — | — | refused 3/3 | — | — |
| `/invoices/new` | — | — | refused 3/3 | — | — |
| `/leads` | — | — | refused 3/3 | — | — |
| `/leads/:id` | — | — | refused 3/3 | — | — |
| `/messages` | — | — | — | refused 3/3 | — |
| `/payments` | — | refused 3/3 | refused 3/3 | — | — |
| `/portal` | — | — | — | — | refused 3/3 |
| `/portal/invoices` | — | — | — | — | refused 3/3 |
| `/portal/invoices/:id` | — | — | — | refused 3/3 | — |
| `/quotations` | — | — | refused 3/3 | — | — |
| `/quotations/:id` | — | — | refused 3/3 | — | — |
| `/quotations/new` | — | — | refused 3/3 | — | — |
| `/recycle-bin` | — | — | refused 3/3 | — | — |
| `/reports` | — | — | refused 3/3 | — | — |
| `/retainer-drafts` | — | — | refused 3/3 | — | — |
| `/revenue` | — | — | refused 3/3 | — | — |
| `/settings/bank` | — | refused 3/3 | refused 3/3 | — | — |
| `/settings/billing` | — | refused 3/3 | — | — | — |
| `/settings/data` | — | refused 3/3 | refused 3/3 | — | — |
| `/settings/email` | — | refused 3/3 | — | — | — |
| `/settings/firm` | — | refused 3/3 | refused 3/3 | refused 3/3 | — |
| `/settings/law` | — | refused 3/3 | — | — | — |
| `/settings/numbering` | — | refused 3/3 | refused 3/3 | — | — |
| `/settings/templates` | — | refused 3/3 | — | — | — |
| `/tds-credits` | — | — | refused 3/3 | — | — |
| `/whatsapp-groups` | — | — | refused 3/3 | — | — |
| `/work` | — | — | — | refused 3/3 | — |

### Fixed in this pass

- **Presence heartbeat 500s** when several tabs of one person beat at once: a beat whose moment a
  concurrent beat had already credited counted as a lost race, and the fourth loss threw. Such a beat
  now succeeds without writing; retries back off with jitter (`server/presence.ts`, new
  `tests/unit/presence-server.test.ts`).
- **Refusals that answered 200**: `/clients/groups`, `/clients/new`, `/filings` and `/whatsapp-groups`
  refused an Employee only after the loading skeleton had streamed. Segment layouts now check first
  (a path check in `app/(staff)/clients/layout.tsx`, whose loading boundary wraps both), so they answer
  403; an Employee's `/dashboard` is a real 307 to My day; another client's invoice in the portal is a
  real 404 (`app/(portal)/portal/layout.tsx`).
- **Malformed addresses** (`/clients/%E0%A4%A`) made Next's parameter decoding answer a bare 500; the
  proxy now answers 400 (`lib/supabase/proxy.ts`, with tests).
- The refusal and not-found pages name themselves in the phone top bar; two spec section numbers left
  in user-facing copy were replaced with plain words; DB tests that assumed tomorrow in UTC is
  tomorrow in IST now use `today_ist()`; schema stamped 0239 (0234 had been added without a stamp).
- QA data: invoice lines linked to their engagement (Fee realisation had shown ₹0.00 invoiced
  everywhere), message timestamps consistent, nothing dated later today when loaded before office
  hours, a notification that printed an ISO date.

### Known and accepted (not failures)

- Capacity bands print as CLEAR / BUSY / TIGHT / OVER because §7.11.4 names them so; `docs/DESIGN.md`
  otherwise bans all-caps labels. The spec wins until a Partner decides otherwise.
- Wide tables (Fee realisation, the financial statement, the recon summary, the ITR comparison, the
  letter's services schedule) scroll inside their own frame; the page itself never does.
- `inbox_action_items` (0172) still counts calendar days in `item_count`; the app corrects it in
  TypeScript. `client_groups_overview.next_due_date` counts upcoming deadlines only (overdue shown
  separately), by design. Changing either needs a migration.
- Invoice numbers in large type show wide hyphens (`TW/26 - 27/0068`): Inter's tabular figures apply
  to the hyphen under the global `.num` rule.
- TaxWise Desktop: `safeStorage.isEncryptionAvailable` is deprecated in Electron 45 (move to the async
  call); packaged builds (fuses, asar integrity, signing) were not exercised here.
- QA-data quirks that come from `tests/db/fixtures.ts` rather than the app: a placeholder PT number
  (`PTEC-…`), Beta Industries' fee history and DSC rows, and timeline entries written by the fixture.
