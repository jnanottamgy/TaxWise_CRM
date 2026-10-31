# Local QA stack

(How to use it, what it can't cover and the final run's results: `docs/QA.md`.)

Renders the real app, with a realistic practice's data, on this machine, so every page can be looked at
(and crawled) as every role. It is for QA and for fixing pages. It **never touches a real Supabase
project**: the database is a local Postgres 16 database, the API is PostgREST, and Supabase Auth and
Storage are replaced by a small stand-in. Every key it uses is a throwaway generated on first `up`.

```
browser ──► next start / next dev :3100 ──► Supabase stand-in :54321 ──► PostgREST :3333 ──► Postgres taxwise_qa
                (the app, unchanged)         /auth/v1 from signed JWTs     (RLS as the user)
                                             /storage/v1 → 404/501 JSON
                                             /rest/v1 → PostgREST
```

| File | What it is |
|---|---|
| `stack.ts` | `up` · `down` · `status` · `reset-data` (below) |
| `qa-data.ts` | builds the `taxwise_qa` database: migrations + production seed, the users of `tests/db/fixtures.ts`, `scripts/seed-staging.ts` (unchanged, as a child process), the rest of the fixtures, then a QA layer of its own |
| `mock-supabase.ts` | the Supabase stand-in |
| `sessions.ts` | prints the sign-in cookie for a fixture user |
| `crawl.ts` | visits every route as every role at three viewports and writes a report |
| `api-smoke.ts` | what the crawler doesn't open: every PDF and export route, file downloads, API refusals, concurrent presence beats |
| `jwt.ts`, `config.ts` | tokens, sessions, ports and paths |

Runtime state (secrets, pid files, logs, PostgREST config, the binaries) lives in `.local-stack/`, which
ignores itself in git.

## Binaries (not in git)

Two downloads, put under `.local-stack/bin/` (or point `QA_POSTGREST_BIN` / `QA_CHROME_BIN` at them):

```bash
mkdir -p .local-stack/bin && cd .local-stack/bin
# PostgREST 12.2.3, static Linux build
curl -fsSL -o postgrest.tar.xz https://github.com/PostgREST/postgrest/releases/download/v12.2.3/postgrest-v12.2.3-linux-static-x64.tar.xz
tar -xJf postgrest.tar.xz && rm postgrest.tar.xz            # → .local-stack/bin/postgrest
# chrome-headless-shell 131 for the crawler (Playwright drives it)
curl -fsSL -o chrome.zip https://storage.googleapis.com/chrome-for-testing-public/131.0.6778.204/linux64/chrome-headless-shell-linux64.zip
unzip -q chrome.zip && rm chrome.zip                         # → .local-stack/bin/chrome-headless-shell-linux64/
```

You also need a local Postgres 16 with `LOCAL_PG_ADMIN_URL` in `.env.test.local` (the same one
`npm run test:db` uses; if the cluster is down: `pg_ctlcluster 16 main start`), and `node_modules`.

## Commands

```bash
npx tsx scripts/local-stack/stack.ts up            # production build + next start on :3100
npx tsx scripts/local-stack/stack.ts up --dev      # next dev on :3100 instead (hot reload, for fixing pages)
npx tsx scripts/local-stack/stack.ts up --fresh    # also rebuild the database first
npx tsx scripts/local-stack/stack.ts up --rebuild  # force a new production build
npx tsx scripts/local-stack/stack.ts status        # what's running, row counts, binaries
npx tsx scripts/local-stack/stack.ts reset-data    # rebuild taxwise_qa (restarts PostgREST)
npx tsx scripts/local-stack/stack.ts down          # stop everything (keeps keys, database and build)
npx tsx scripts/local-stack/stack.ts down --purge  # …and drop taxwise_qa and forget the keys
```

`up` is idempotent: it loads the database only when `taxwise_qa` has no complete QA load, starts only what
isn't running, and rebuilds only when the source tree (HEAD plus uncommitted changes), the keys or
`.next/BUILD_ID` changed. Anyone else's `npm run build` replaces the build the stack serves; `up` notices
and rebuilds (even while the app is running). Logs: `$TMPDIR/taxwise-qa-stack/logs/{app,mock,postgrest,build,data}.log` (outside the project, so `next dev` doesn't reload on every log line; `QA_LOG_DIR` overrides). The stand-in logs
every PostgREST error it forwards (status, path, role, body), which is usually the fastest way to the cause
of a block error.

The app runs with `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321`, anon and service-role keys signed with
the stack's secret, a throwaway `CREDENTIAL_VAULT_KEY` and `CRON_SECRET`, `APP_ENV=development`,
`NEXT_PUBLIC_APP_URL=http://localhost:3100`, and no `RESEND_API_KEY` (nothing is ever emailed).

## Signing in

```bash
npx tsx scripts/local-stack/sessions.ts P1           # Cookie header value: curl -H "Cookie: $(…)" localhost:3100/dashboard
npx tsx scripts/local-stack/sessions.ts E1 --json    # cookies for Playwright's context.addCookies
```

Users (`tests/db/fixtures.ts`, renamed by the QA layer): **P1** Raghavendra Bhat and **P2** Shalini Hegde
(Partners), **M1** Anita Rao and **M2** Suresh Kulkarni (Managers), **E1** Ravi Kumar, **E2** Deepa Nair,
**E3** Meghana Iyer, **E4** Kiran Shetty (Employees), **X** Arjun Patil, **D** Pooja Naik (disabled), and the
portal users **CA** Mahesh Gowda (Alpha Traders) and **CB** Sunita Reddy (Beta Industries). Partners and
Managers get an assurance-level-2 session (they have an authenticator app). In a browser you can also use
`/login` with the user's email (`p1@taxwise.test` …), the password printed by `npx tsx scripts/local-stack/stack.ts status` (random per stack), and code `123456` on the
two-step page.

## The data

Built fresh by `qa-data.ts` relative to today (IST), deterministic ids (`fid('qa:…')`) for what the crawler
opens: 39 live clients of every entity type with valid-checksum GSTINs (36 from `seed-staging.ts`, plus the
fixture's Alpha Traders, Beta Industries and Gamma Architects LLP, and a deleted Zeta), contacts, services
with fees, teams (E1 on 15 clients), the statutory calendar from the app's own engine (overdue, due and
filed periods, filing records with ARNs), tasks in every status for E1 (waiting to accept, due today,
overdue, sent back with the reason, data awaited, under review, on hold, filed, blocked by a dependency) plus
declined and unassigned ones, checklists, comments with mentions, three weeks of time entries and two
running timers, attendance, leave in every state, client and person covers, presence, leads in every stage,
quotations in every status (one revised; `quotation:sent` has a live `/q/<token>` link), invoices draft /
awaiting approval / sent / partially paid / paid / overdue / disputed with lines, receipts with TDS, a credit
note, reminders and follow-ups, a retainer run with drafts, a 26AS import matched to receipts, document rows
(no files) and document requests with items in every state, portal threads and other messages, inboxes,
WhatsApp numbers and groups, registrations, DSCs (expiring and expired), UDINs, portal
credentials sealed with `server/vault.ts`, engagement letters, the statutory audit of Beta Industries in
Execution with sign-offs and materiality, quality records, a GSTR-2B reconciliation (from
`tests/fixtures/gstr2b`), ITR computations (the app's engine), Schedule III statements, notices, the
published privacy notice, DPDP requests and an incident, audit-log rows, job runs, saved views.

Files: the stack has no storage, so downloads, previews and uploads show their designed error states.

## Crawling

```bash
npx tsx scripts/local-stack/crawl.ts --round r1 --out <dir>   # default <dir>: .local-stack/qa
npx tsx scripts/local-stack/crawl.ts --roles employee --viewports mobile-light --only work
```

Roles: `partner` (P1), `manager` (M1), `employee` (E1), `client` (CA), `anon`. Each visits its routes from
`lib/nav.ts`, detail pages found in the database (Client 360 with every tab, a task, lead, quotation and its
edit page, invoices, an audit, each kind of workpaper, a person, the new-record pages, every Settings section,
every register tab and report), and other roles' pages that must be refused (403/404 or a redirect, never
data). Every visit runs at 1366×768 light, 1366×768 dark and 390×844 light; it records the HTTP status,
error boundaries, ShellUnavailable, block errors with their Ref and the matching line of the app log, Next
error text, page and console errors, failed requests (≥ 400) to the app or `/rest/v1`, horizontal overflow,
the h1, the dark class, and the load time, and saves a full-page screenshot. It writes
`<dir>/<round>/report.json` and a readable `report.md` grouped by area (clients, work, money, practice,
portal), plus the PostgREST errors the stand-in saw during the run.
