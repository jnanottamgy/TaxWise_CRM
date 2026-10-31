# TaxWise Consultants — Practice OS
### Powered by J-TACS · Complete build specification (single-firm edition)

> **Changed since this specification was written:** no TaxWise Desktop app (§7.25), no email (WhatsApp is the only
> channel to clients), and hosting on Netlify instead of Vercel. See README → "Changes from the original specification".

> **How to use this prompt (for the person pasting it — delete this box before pasting if you like)**
> - **Claude Code / Cursor / Windsurf:** paste the whole file. Tell it to build in the order given in §18 and to stop after each phase so you can check.
> - **Lovable / Bolt / v0 (message-length limits):** use the 9 part files instead (`TaxWise-build-prompt-parts.zip`). Paste parts 1–5 first (foundation, roles, database, Indian law). Then paste parts 6–9 one at a time, building each before pasting the next.
> - **Already building from the earlier version (before 22 Oct 2026)?** Don't start again: paste the two `ADDENDUM-…` files from the zip, in order. They add the security corrections, cover access, and WhatsApp inside the CRM.
> - **WhatsApp inside the CRM (§7.25) is a desktop app.** Build it with Claude Code or Cursor. Lovable, Bolt and v0 can build only the web side.
> - **Indian law in §6 is current to October 2026.** Items marked **[verify]** were confirmed only from secondary sources, or the sources disagreed. A partner should confirm each one before go-live (§18.2).
> - Nothing in here depends on the old codebase. Everything the builder needs is written down below.
> - Before real data goes in, run the acceptance checklist in §18.3, role by role.

---

## §0. Mission and ground rules for the builder

You are building a production web application that runs the whole of one Chartered Accountancy practice: **TaxWise Consultants, Bengaluru**. It is **exclusive to this one firm**. There is no multi-firm mode, no public sign-up, no pricing page and no "workspace" concept. Every screen, document and email carries the TaxWise brand. The product underneath is **J-TACS**, credited small and tastefully as **"Powered by J-TACS"**: on the login screen, in the sidebar footer, in the footer of every PDF and every email.

Four kinds of people use it:

| Who | What they do here |
|---|---|
| **Partner** | Owns the firm. Sees and controls everything: settings, money, approvals, people, audit trail. There can be more than one Partner. |
| **Manager** | Runs the work and the team: every client, task, quotation and invoice, but not firm-level settings, not other Managers or Partners, and not invoices above the approval limit. |
| **Employee** | Does the work. Sees only clients assigned to them, never sees fees, invoices or payments, and cannot sign off their own filings. |
| **Client** | The firm's customer. Uses a separate, simple portal to see their deadlines and compliance status, upload requested documents, view invoices and message the firm. |

### 0.1 Non-negotiable engineering rules
These come from real failures in the previous version of this product. Every one of them caused a production incident. Follow all of them.

1. **Schema changes go through migration files only.** Never run `db push` (or any auto-sync) against the production database. Every migration is committed to the repo and applied in order. The app records its schema version in a table (`app_meta.schema_version`), and the diagnostics page (§7.24) compares it with the version the code expects. A stale database must announce itself, not show up later as random "column does not exist" crashes.
2. **No server action or API route ever lets an exception reach the user.** Every server function returns `{ ok: true, data }` or `{ ok: false, error, fieldErrors?, ref }`. Every unexpected error is logged server-side as one structured JSON line with a short reference id, and the user sees a plain sentence with that **Ref** they can quote. The *one* exception is the framework's own redirect/not-found signals, which must be re-thrown.
3. **Layouts never await anything that can throw without catching it.** In Next.js an `error.tsx` cannot catch an error thrown by the layout of its own segment; it bubbles to the root and blanks the whole app. Wrap layout-level data loads in try/catch and degrade gracefully. Put an `error.tsx` boundary in every route group (staff app, client portal, auth, public quotation).
4. **The action buttons at the bottom of a dialog must always be visible** (Save, Submit, Complete, Back). Dialog footers are `position: sticky; bottom: 0`, `flex-shrink: 0`, and scrollable content sits above them. Test every dialog and wizard at **1366×768** (the most common Indian office laptop) and at **390×844** (phone). A fixed `min-height` must yield to the viewport (`min(560px, 68dvh)`, not `560px`).
5. **Work done after a save must never fail the save.** Emails, activity logs, notifications, compliance-date generation and timeline entries run after the main write. If one of them fails, the save still succeeds and the user gets a *warning* naming what to do by hand. Telling someone a save failed when it didn't is how duplicate clients get created.
6. **Document numbers come from a locked counter, never from `count()+1` or `max()+1`.** Use a `number_series` table and a Postgres function that increments under `SELECT … FOR UPDATE` (§5.11). Invoice numbers must satisfy GST Rule 46: unique within the financial year, **at most 16 characters**, using only letters, digits, `-` and `/`.
7. **Money is never a float.** Store `numeric(14,2)`, compute in integer paise, round half-up to 2 decimals, and display in Indian grouping (`₹1,23,456.00`). Show amounts in words on invoices using lakh and crore.
8. **The database enforces who can see what.** Row Level Security is enabled on every table. The interface hides what a role can't use, but the hiding is cosmetic; RLS is the real control. Only one small server module (`server/admin.ts`) may use the Supabase service-role key, and it is never imported into client code.
9. **A user's role is never read from anything the user can edit.** Supabase lets any signed-in user change their own `user_metadata`, so `user_metadata` must never decide permissions. Store the role in `app_metadata` (only the service role can write it) **and** in `profiles.role`. Server checks read `profiles.role`; RLS reads the JWT `app_metadata.role` and cross-checks `profiles` (§4.6). This covers **every** signed-in user, client portal users included: in the old build a client could make themselves a Partner of the firm from the browser console. The proxy may read `app_metadata.role` as a hint for redirects, never `user_metadata`. If `app_metadata.role` is missing, the proxy treats the user as having no access; there is no fallback. Nothing in the app ever writes a role into `user_metadata` (§4.4).
10. **Derived states are computed, never stored as one-way flags.** "Overdue" for a task or invoice is computed from status + due date (in a view or at query time), not from a boolean a nightly job sets and nothing ever clears.
11. **Soft delete with a recycle bin** for clients, leads, quotations, invoices, tasks and documents (`deleted_at`). Every list query filters `deleted_at is null`.
12. **Every mutation writes an audit row** (who, what, when, before/after summary). Viewing a stored portal password writes one too.
13. **All dates in Indian Standard Time.** Store `timestamptz`; store date-only facts as `date`; compute "today" in `Asia/Kolkata`. The financial year runs **1 April – 31 March** and is labelled `2026-27`.
14. **No fake data, ever, in production.** Seed only what §16 lists (firm settings, statutory templates, default job and message templates). The previous product shipped seed scripts that created demo clients, a script that deleted every client on the database, and a committed tool that emptied every business table and reset a demo Partner's password to a value written in the (public) repository. None of these may exist here. No script holds a password or key, nothing destructive is committed, the repository is private, and production Auth has no demo or test accounts.
15. **Caching never crosses users.** Do not put per-user or role-scoped data in a shared cache (`unstable_cache`, CDN, module-level variables). If you cache, the user id and role are part of the key, and every query runs under that user's RLS.

### 0.2 Definition of done for any feature
- It works for every role that should have it, and is refused (in the UI **and** by RLS) for every role that shouldn't.
- Loading, empty, error and success states are all designed (not left as defaults).
- Forms validate inline, keep the user's input on error, and show server errors on the right field.
- It is usable at 1366×768 and on a phone.
- It writes an audit row and, where relevant, a client timeline entry.
- There is at least one automated test for its business rule (pure functions get unit tests).

---

## §1. Firm identity (pre-seeded, editable by Partners in Settings)

| Field | Value |
|---|---|
| Display name | **TaxWise Consultants** |
| Tagline | Chartered Accountants · Bengaluru *(editable)* |
| Registered address | 307, 14th Main Rd, Raj Mahal Vilas Extension, Sadashiva Nagar, Bengaluru, Karnataka 560080 |
| Phone | +91 97405 40239 |
| Public email | info@twchartered.com |
| Website | https://www.twchartered.com/ |
| GSTIN | **29AAXFT1811B1Z3**: passes the mod-36 checksum. State code **29 (Karnataka)**; embedded PAN **AAXFT1811B**, 4th character `F` = Firm/LLP |
| PAN | AAXFT1811B (derived from the GSTIN; editable) |
| Email sending domain | twchartered.com (verify with Resend, §7.13.5) |
| Default "from" | `TaxWise Consultants <noreply@twchartered.com>`, reply-to `info@twchartered.com` |
| Time zone / currency / FY | Asia/Kolkata · INR · April–March |
| To be filled in at first run | ICAI Firm Registration Number (FRN); each Partner's ICAI membership number; bank name, account name, account number, IFSC, branch; UPI ID; logo (PNG/SVG, transparent) |

Use the firm's own colours if a logo is uploaded. Otherwise use the palette in §3.

---

## §2. Technology and architecture

### 2.1 Stack
- **Next.js (App Router, latest stable) + TypeScript (strict)**. Server Components for reads; Server Actions for mutations; Route Handlers for PDFs, cron, webhooks and file streams.
- **Tailwind CSS + shadcn/ui** (Radix primitives), **lucide-react** icons, **Recharts** charts, **TanStack Table** for every data table, **react-hook-form + zod** for every form (one zod schema shared by client and server), **date-fns + date-fns-tz**.
- **Supabase**: Auth (email + password), Postgres 15+ with **RLS on every table**, Storage (private buckets with short-lived signed URLs), and `pg_cron` *or* Vercel Cron for schedules.
- **Resend** for transactional email from the verified `twchartered.com` domain.
- **PDF**: `@react-pdf/renderer` (or `pdfkit`). PDFs are generated on the server and streamed; nothing is generated in the browser.
- **Excel/CSV**: `exceljs` for exports and imports; CSV parsing via `papaparse`.
- **Desktop app (§7.25):** Electron + electron-builder + electron-updater. It is a separate project in `desktop/` that wraps the production CRM and adds the WhatsApp panel.
- **Hosting**: Vercel. **Two environments, two Supabase projects:** `production` (TaxWise's real data, `main` branch) and `staging` (test data, `develop` branch). Preview deployments always point at staging. Production is never used for testing.
- If you are a builder that only does **Vite + React + Supabase** (Lovable/Bolt), keep the data model, RLS and business rules identical. Implement the server logic as **Supabase Edge Functions** and Postgres functions, and the schedules with `pg_cron`.

### 2.2 Folder layout (Next.js)
```
app/
  (auth)/login, forgot-password, reset-password, set-password, setup   ← setup only while no users exist
  (staff)/…                ← the firm's app (sidebar shell)
  (portal)/portal/…        ← client portal (lighter shell)
  q/[token]/               ← public quotation page (no login)
  api/cron/*, api/pdf/*, api/files/*, api/desktop/* (§7.25.1), api/health
components/ui (shadcn) · components/<feature>/…
lib/domain/   ← pure business rules (gst.ts, tds.ts, statutory-calendar.ts, itr.ts, recon.ts, buckets.ts, presence.ts, capacity.ts, transitions.ts, numbering.ts, india-validators.ts, money.ts, fy.ts, cover.ts)
lib/data/     ← typed query functions (run under the user's RLS)
server/admin.ts ← the ONLY service-role usage (create/ban users, change auth email, cron, vault)
supabase/migrations/*.sql · supabase/seed.sql (only §16 content) · tests/
desktop/        ← TaxWise Desktop (Electron): the CRM plus the WhatsApp panel (§7.25.3)
```

### 2.3 Architecture rules
- **Single firm, no tenant column.** No `firm_id` anywhere. Firm-wide configuration lives in a singleton `firm_settings` row (`id = 1`, enforced by a CHECK constraint).
- **Reads** go through the Supabase server client using the **signed-in user's session**, so RLS applies. **Writes** go through Server Actions that validate with zod, check the role, then write under the user's session (RLS applies again). Only `server/admin.ts` bypasses RLS, and only for the listed jobs.
- **Business rules live in pure functions** in `lib/domain`, with no I/O, and each has unit tests. The UI and the server both import the same functions (GST split, TDS suggestion, due-date generation, status transitions, capacity, presence).
- **Every list is paginated on the server** (default 25; options 50/100), sorted, filtered and searched in SQL. Never fetch everything and filter in the browser.
- **IDs:** `uuid default gen_random_uuid()`. Human-facing numbers (client code, task number, invoice number, etc.) are separate columns.
- **Text that is matched case-insensitively** (emails, PAN, GSTIN, client code) uses the `citext` type or is normalised to upper case on write.
- **Files** live in private Storage buckets: `client-documents`, `task-files`, `branding` (public-read for the logo only), and `generated` (PDF cache). Access is through a signed URL valid for 60 seconds, issued only after an RLS-checked lookup.

---

## §3. Design system and UX

The feel: **calm, precise, premium**, like a well-run CA office: quiet surfaces, crisp type, and colour used only where it means something. Light theme by default (people print from this and work in daylight), with a complete dark theme. Nothing decorative that doesn't carry information.

### 3.1 Colour tokens (define as CSS variables on `:root` and `.dark`)
| Token | Light | Dark | Use |
|---|---|---|---|
| `--brand-navy` | `#14284B` | `#0B1630` | Login panel, sidebar header band, PDF headers |
| `--primary` | `#1F4FD8` | `#5B8CFF` | Primary buttons, links, focus, active nav |
| `--primary-soft` | `#EAF0FF` | `#17254A` | Selected rows, active nav background |
| `--accent-gold` | `#B8892E` | `#D9AD55` | Small highlights only: the "Powered by J-TACS" mark, the Partner badge, key milestones |
| `--bg` | `#F6F7FB` | `#0B0F17` | App background |
| `--surface` | `#FFFFFF` | `#121826` | Cards, tables, dialogs |
| `--surface-2` | `#F1F3F8` | `#182033` | Table headers, input fills, zebra |
| `--border` | `#E4E7EE` | `#253049` | Hairlines |
| `--text` | `#0F172A` | `#E6EAF2` | Body text |
| `--text-muted` | `#5B6476` | `#9AA4B8` | Labels, helper text |
| `--success` | `#0E9F6E` | `#34D399` | Paid, filed, active |
| `--warning` | `#C27803` | `#FBBF24` | Due soon, data awaited, pending |
| `--danger` | `#D92D20` | `#F87171` | Overdue, failed, destructive |
| `--info` | `#2563EB` | `#60A5FA` | Sent, in progress |
| `--violet` | `#7C3AED` | `#A78BFA` | Under review, disputed |

Every text/background pair meets **WCAG AA** (4.5:1 for body text). Status is never shown by colour alone; it always has a label, and an icon where space allows.

### 3.2 Type, spacing, shape
- **Font:** Inter (variable) for all UI; enable `tabular-nums` on every number, amount and date column. PDFs use Inter as well.
- **Scale:** 12 / 13 / 14 (body) / 16 / 20 / 24 / 30. Headings are semibold with slightly tight tracking (−0.01em). Never use more than three sizes on one screen.
- **Spacing:** 4-point base, 8-point rhythm. Page padding 24px on desktop, 16px on mobile. 16–24px gaps between cards.
- **Radius:** inputs 8px, cards 12px, dialogs and sheets 16px, chips fully rounded.
- **Elevation:** level 1 = `0 1px 2px rgba(15,23,42,.06)`; level 2 (popovers, dialogs) = `0 12px 32px rgba(15,23,42,.12)`. No heavy shadows and no glassmorphism.
- **Motion:** 150–200 ms ease-out for hover, expand and dialog enter. Respect `prefers-reduced-motion`. No bouncing, no confetti.
- **Density:** comfortable by default (44px table rows); a "compact" toggle in the user menu (36px rows) for heavy table users.

### 3.3 App shell (staff)
- **Left sidebar** (260px, collapsible to a 64px icon rail; the state is remembered per user). Top: TaxWise logo and name. Then grouped navigation (per role, §4.2), a **"+ New"** split button (New client · New task · New invoice · New quotation · New lead · Log time), and **Favourites** (star any nav item) and **Recent** (last 5 places). Bottom: the user card (name, role badge, avatar menu: Profile, Theme, Density, Keyboard shortcuts, Sign out) and a small "Powered by **J-TACS**" line.
- **Top bar:** page title and breadcrumb; **global search** (`⌘K` / `Ctrl K`, §7.18); **FY switcher** (default: the current FY; it filters every FY-aware screen); **Inbox** bell with unread count (§7.17); help (opens the in-app guide for that page).
- **Mobile (< 768px):** the sidebar becomes a drawer. Employees get a **bottom tab bar** (Today · Tasks · Timer · Clients · More). Tables turn into stacked cards showing the 3–4 most important fields.
- **Page anatomy:** header row (title, one-line description, primary action at right) → filter bar (search, filter chips, saved views, column chooser, export) → content → pagination. Detail pages: header card with key facts and actions, then tabs.

### 3.4 Components and patterns (use these everywhere, consistently)
- **Status chip:** a coloured dot plus a label. **Hovering (or tapping) a chip explains what the status means and what happens next**, e.g. "Data awaited: blocked on the client. Shows on the manager's call list." Every enum's colour and meaning is in §3.6.
- **Empty state:** an icon, one sentence on what would be here, and one primary action ("No clients yet. Add your first client"). A filtered-to-nothing state is different: "No results for these filters", with Clear filters.
- **Loading:** skeletons shaped like the real content. Never a full-page spinner after the first paint.
- **Errors:** inline at the field; a form-level alert for anything not tied to a field; a toast for background failures. Every unexpected error shows its **Ref**.
- **Confirmations:** destructive or irreversible actions (delete, send to client, approve, issue credit note, disable user) open a dialog that says exactly what will happen. Type-to-confirm for permanent purges.
- **Forms:**
  - Sections in cards: two columns on desktop, one on mobile; labels above fields, helper text below.
  - Required fields marked with `*`. Validate on blur and again on submit; the server's field errors land on the right field.
  - A **sticky footer** with Cancel and Save.
  - **Unsaved-changes guard** when navigating away.
  - Long forms (client wizard, quotation, invoice, ITR, financial statements) **autosave a draft** every 5 seconds: locally, plus as a server DRAFT where the entity has a draft status. "Draft saved · 12:41" shows in the footer.
- **Tables:** sticky header; sortable columns; filter chips; column chooser; **saved views** (per user, optionally shared firm-wide by a Partner or Manager); row click opens the detail; checkbox bulk actions; CSV export of the current view; 25/50/100 per page; server-side everything.
- **Money and numbers:** `₹1,23,456.00`, right-aligned, tabular figures. Compact (`₹12.3L`, `₹1.2Cr`) only on dashboard tiles, with the full value on hover.
- **Dates:** `22 Oct 2026` on screen. Relative time ("in 3 days", "2 days overdue") alongside due dates, coloured by urgency: overdue = danger, ≤3 days = warning, ≤7 days = info.
- **Copy buttons** next to PAN, GSTIN, TAN, client code, invoice number and acknowledgement numbers.
- **Keyboard:** `⌘K` search; `N` opens New; `G` then `C` / `T` / `I` goes to Clients / Tasks / Invoices; `?` shows the shortcut sheet; `Esc` closes dialogs.
- **Writing voice:** plain English for an Indian CA office. Say what happened and what to do next. Never blame the user. Use "Filed", not "Completed"; "Data awaited", not "Blocked".

### 3.5 Login screen (and the brand moment)
- Split layout. **Left (40%)**: a deep navy panel with a subtle diagonal line pattern. The TaxWise logo (or the name set in large type), "Chartered Accountants · Bengaluru", one quiet line ("Your practice, in one place."), and at the bottom, small: "Powered by J-TACS" with the gold J mark.
- **Right**: a centred card titled "Sign in to TaxWise". Email; password with show/hide; "Forgot password?"; a Sign in button that shows a spinner while working.
  - A wrong password says only "Email or password is incorrect." After **5 failed attempts in 15 minutes** for the same email + IP: "Too many attempts. Try again in 15 minutes, or reset your password."
  - Footer: "Trouble signing in? Ask a Partner to reset your access."
- **No sign-up link anywhere.** Clients sign in on the same page; their role sends them to the portal.
- On a phone, only the right card shows, with the logo above it.

### 3.6 Status vocabulary (labels, colours and meanings, used identically everywhere)
**Client status:** Active (success): included in billing runs, reminders and work allocation · Pending (warning): onboarding not finished · On hold (violet): no new work, reminders and auto-invoicing paused · Inactive (muted): kept for history and excluded everywhere.

**Client priority:** Low · Medium · High · Critical.

**Task status:** Not started (muted) · In progress (info) · Data awaited (warning): blocked on the client, appears on the manager's call list · Under review (violet): preparer has finished and it waits for a reviewer · Filed / Done (success): signed off, can only be set by a Manager or Partner · On hold (muted).

**Task acceptance:** Waiting for acceptance · Accepted · Declined (with reason, returned to the manager).

**Task priority:** Low · Medium · High · Urgent.

**Lead stage:** New lead · Contacted · Quotation requested · Follow-up required · Client will revert · Proposal sent · Negotiation · Won (success) · Lost (danger, with reason).

**Quotation status:** Draft · Pending approval · Approved · Sent · Viewed · Accepted (success) · Rejected (danger, with reason) · Expired (muted) · Superseded (muted; replaced by a revision, link no longer answers).

**Invoice status:** Draft · Awaiting approval (when over the limit) · Sent · Partially paid (warning) · Paid (success) · Overdue (danger; derived) · Disputed (violet) · Waived (muted). Paid and Partially paid are **derived from recorded receipts and can never be set by hand**.

**Compliance event:** Pending · Completed · Overdue (derived) · Cancelled; workflow: Not started · Documents awaited · In progress · Under review · Filed · Completed.

**Notice:** Open · Reply drafted · Replied · Hearing · Closed (favourable / unfavourable / partial).

**Attendance:** Present · Late login · Half day · Absent · On leave.

**Engagement letter:** Draft · Issued · Signed · Declined · Expired.

**Document request item:** Pending · Uploaded · Accepted · Rejected (with reason).

**Registration / DSC:** Active · Expired · Surrendered / Revoked · Cancelled.

---

## §4. Users, roles, permissions and sign-in (Supabase Auth)

### 4.1 What each role can do
| Capability | Partner | Manager | Employee | Client |
|---|:-:|:-:|:-:|:-:|
| Firm settings, branding, bank, ICAI identity, number series, working hours, email domain | ✅ | ❌ | ❌ | ❌ |
| Add / edit / disable **Partners and Managers** | ✅ | ❌ | ❌ | ❌ |
| Add / edit / disable **Employees**, issue logins, reset passwords | ✅ | ✅ | ❌ | ❌ |
| Delete a team member (soft; only with no open work) | ✅ | ❌ | ❌ | ❌ |
| See **every** client; create, edit, onboard | ✅ | ✅ | ❌ (own only, read + limited edit) | ❌ |
| Delete a client (soft) / restore / purge from recycle bin | ✅ | restore only | ❌ | ❌ |
| Fees, engagement terms, invoices, receipts, credit notes | ✅ | ✅ | **never, anywhere** | own invoices only |
| Raise an invoice above the approval limit without approval | ✅ | ❌ (held for a Partner) | ❌ | ❌ |
| Approve held invoices; waive an invoice; issue a credit note | ✅ | ❌ | ❌ | ❌ |
| Payments dashboard (receivables, ageing, collection) | ✅ | ❌ | ❌ | ❌ |
| Leads and quotations: create and edit | ✅ | ✅ | ❌ | ❌ |
| Send a quotation to a client | ✅ | ✅ if under the quotation approval limit, else ❌ (held) | ❌ | ❌ |
| Create and assign tasks; bulk reassign | ✅ | ✅ | ❌ | ❌ |
| Update the status of tasks assigned to them; comment; checklist; log time | ✅ | ✅ | ✅ | ❌ |
| Set a task to **Filed / Done** | ✅ (any, including their own) | ✅ (not their own) | ❌ (submits Under review) | ❌ |
| Compliance calendar and filings grid (firm-wide) | ✅ | ✅ | own clients only | own only (read) |
| Workpapers (GST recon, ITR, financial statements, notices) | ✅ | ✅ | own clients | ❌ |
| Registers: registrations, DSC, UDIN | ✅ | ✅ | own clients (read; UDIN add if signing staff) | ❌ |
| **Reveal a stored portal password** | ✅ | ✅ | only if a Partner granted "Vault access", and only for own clients (a covered client counts only if the cover includes portal passwords, §4.7) | ❌ |
| Open a client's WhatsApp group in the CRM's WhatsApp panel (§7.25) | ✅ any client; full WhatsApp | ✅ any client; full WhatsApp | own and **covered** clients, one chat at a time (client mode) | ❌ |
| Grant, extend or end **cover access** (§4.7) | ✅ | ✅ | ❌ | ❌ |
| Firm WhatsApp numbers, client mode, linked PCs, house rules (Settings) | ✅ | read | read | ❌ |
| Remove a PC from TaxWise Desktop | ✅ | ❌ | ❌ | ❌ |
| Engagement letters, filing history, peer review, client acceptance register | ✅ | ✅ (peer review read-only) | ❌ | ❌ |
| Job templates, message templates | ✅ | ✅ | use only | ❌ |
| People, performance, attendance, capacity, leave approvals | ✅ | ✅ | own record and leave requests only | ❌ |
| Reports, revenue, fee realisation | ✅ | ✅ | ❌ | ❌ |
| Audit log | ✅ | ❌ | ❌ | ❌ |
| Recycle bin | ✅ | ✅ (restore) | ❌ | ❌ |
| Diagnostics page | ✅ | ❌ | ❌ | ❌ |
| Client portal | — | — | — | ✅ |

**Employee scope** ("own clients"): a client is visible to an employee when they are its **owner** (`clients.owner_employee_id`) **or** on its **engagement team** (`client_team_members`), and while they hold a **cover** in force for it (§4.7). Tasks are visible when assigned to them, when they are the named reviewer, or when the task belongs to a visible client. An employee **never** receives fee, invoice, receipt, credit note, quotation or lead data, not in a page, a search result, an API response or an export. Enforce this with RLS and with views that leave out fee columns (§4.6).

### 4.2 Navigation per role
**Partner sidebar**
- **Home:** Dashboard · Inbox
- **Clients:** Clients · Client groups · WhatsApp groups
- **Work:** Work tracker · Filings · Calendar · Timesheet
- **Workpapers:** GST reconciliation · ITR computation · Financial statements · Notices
- **Growth:** Leads & quotations
- **Money:** Invoices · Payments · Fee realisation · Revenue
- **Team:** People · Performance & attendance · Leave
- **Practice:** Registers · Engagement letters · Quality (peer review, acceptance, retention) · Job templates · Message templates
- **Admin:** Reports · Audit log · Recycle bin · Settings

**Manager sidebar:** the same, minus Payments, Audit log, Diagnostics and firm-level Settings. Their Settings is just their profile.

**Employee sidebar:** My day · My tasks · My clients (including clients they are covering, §4.7) · My timesheet · Calendar · Workpapers (four entries, own clients) · Messages · Leave · Profile.

**Client portal:** Home · Deadlines · Compliance · Documents · Invoices · Messages · Help.

### 4.3 First run (bootstrap), with no public sign-up
- `/setup` is reachable **only while the `profiles` table is empty** (checked server-side on every request; after that it returns 404 forever).
- It asks for the first Partner's name, email and password (policy in §4.4), and confirms the firm details from §1 (all pre-filled). It creates the auth user with `app_metadata.role = 'partner'`, the `profiles` row, the matching `employees` row, and the `firm_settings` row if missing. Then it signs the Partner in and lands them on a **Setup checklist** (§7.2): add logo, bank and UPI, ICAI numbers, verify the email domain, add the team, add the first client.
- Alternative for the operator: `supabase/seed.sql` can create the first Partner from `FIRST_PARTNER_EMAIL` plus a one-time password that must be changed at first login.

### 4.4 Sign-in and password rules
- Email + password through Supabase Auth. Passwords need **at least 8 characters, an uppercase letter, a lowercase letter, a digit and a symbol**. Show these as a live checklist under the password field.
- **Forgot password** sends Supabase's reset link (it works even before Resend is verified, because it comes from Supabase's own mailer, or from Resend SMTP once configured). The reset page sets a new password and signs them in.
- **Temporary passwords:** a login created or reset by a Partner or Manager is marked `must_change_password` (in `app_metadata` and `profiles`). Until it is changed, every route except `/set-password` redirects there, and every server action refuses with "Set your own password first."
- **Sessions:** refresh-token rotation on. Idle timeout of **12 hours** for staff, **2 hours** for clients. "Sign out" revokes the session server-side.
- **Rate limit** on login, password reset and the public quotation response endpoint (§13).
- Every sign-in (success and failure), sign-out and password change is written to `audit_logs`, with IP and user agent.
- **Role claims in `user_metadata` are ignored and reported.** Nothing in the app writes a role, or any permission, into `user_metadata`. If a signed-in user's `user_metadata` contains a `role` key, the server:
  - ignores it;
  - writes an `access_denied` audit event ("role claim in user_metadata ignored");
  - notifies Partners (`security_alert`), at most once per user per day.
- **Landing after login:** Partner and Manager → Dashboard; Employee → My day; Client → Portal home. If someone has a session but no `profiles` row, show a clear page ("Your account isn't set up yet. Ask a Partner.") and never a crash.

### 4.5 Staff lifecycle (People module)
1. **Add team member:** name\*, email\* (unique), phone, WhatsApp, department, designation, date of joining, role\* (the role picker shows what each role grants and where it stops), billing rate ₹/hour (optional; "not billed hourly" if blank), cost rate ₹/hour (optional, Partner only, for profitability), "Vault access" toggle (Partner only).
   - Only a Partner can choose **Partner** or **Manager**. A Manager can only create Employees.
   - Partners also enter their **ICAI membership number** (used for UDINs).
2. **Login is issued on save:** the server creates the auth user with a generated temporary password (meeting the policy), sets `app_metadata.role`, marks `must_change_password`, and emails an invite (§10). **Whether or not the email sends**, the dialog then shows "Login created": the login email, the temporary password with a copy button, a **Share on WhatsApp** button (pre-drafted message with the login link, email and temporary password), and a **Send via Gmail** button. It also states plainly whether the invite email went, and the provider's reason if it didn't. The password is shown once.
3. **Reset password** (Partner/Manager; Managers only for Employees): a new temporary password, shown the same way.
4. **Change email:** editable at any time. If the person has a login, **the auth account's email moves too** (service role, `email_confirm: true`), then the profile and employee rows. The auth change happens first; if Supabase refuses (the address is taken), nothing changes and the error appears on the field. Duplicate check runs before anything moves.
5. **Change role:** Partner only for Manager/Partner changes.
   - Writes `profiles.role` first (it is the authority), then `app_metadata.role`, then revokes the user's sessions so the change takes effect at once.
   - If the `app_metadata` write fails, the change still stands. The next sign-in copies `profiles.role` into `app_metadata`, and the audit log records the repair.
6. **Disable:** bans the auth user (sign-in blocked immediately, sessions revoked) and sets `is_active = false`. History is kept, and they can be re-enabled. **Blocked while they hold open tasks**: the dialog shows the count and offers **Reassign all work to…** (one action moves open tasks, client ownership and reviewer assignments, and logs it).
7. **Delete (Partner only):** soft delete, same open-work check.
8. **Bulk import:** CSV with columns `name, email, phone, department, designation, role, date_of_joining`. Preview with a per-row validation report. Import creates records; logins are issued in a second step (button: "Issue logins for N people").

### 4.6 RLS design (implement exactly)
Postgres helper functions (`security definer`, `stable`, `search_path = public`):
- `app_role()` returns the role from `auth.jwt() -> 'app_metadata' ->> 'role'`, **and** requires a matching active `profiles` row (`profiles.id = auth.uid() and is_active and role = that value`). Otherwise it returns null. **Never read `user_metadata`.**
- `is_partner()`, `is_manager_or_partner()`, `is_staff()` (partner/manager/employee), `is_client()`.
- `my_employee_id()` → `employees.id where profile_id = auth.uid()`.
- `can_see_client(cid uuid)` → true for Partner/Manager. For an Employee, true if they are the owner or on the team, **or** hold a cover in force for the client (from `covers_in_force`: a client cover for it, or a person cover for a colleague who owns it or is on its team; §4.7). For a Client, true if `clients.portal_user_id = auth.uid()`.
- `can_open_whatsapp(cid uuid)` → `is_staff() and can_see_client(cid)`. Clients never get WhatsApp groups, not even their own.

Policies by table group:
- **Firm settings:** SELECT for all staff; UPDATE Partner only. The public `/q/[token]` page and PDFs read through a server function that exposes only the public subset (name, address, GSTIN, phone, email, website, logo, bank/UPI).
- **Clients and client-owned rows** (contacts, team, checklist, documents, document requests, compliance events, filing records, registrations, DSC, UDIN, notices, workpapers, messages, timeline): SELECT where `can_see_client(client_id)`. INSERT/UPDATE for Partner/Manager, plus Employees where the column set they may change is limited (status, notes, checklist, uploads, comments). DELETE (soft) Partner/Manager.
- **Money tables** (invoices, invoice_items, payment_receipts, credit_notes, invoice_follow_ups, invoice_reminders) and **engagement fees** (client_services fee columns, engagement_letters, quotations, quotation_items, leads): Partner/Manager only. The Client portal gets SELECT on its own invoices through a view `portal_invoices` that only exposes portal-safe columns. Employees get `client_services_public` (a view without `agreed_fee`, `billing_frequency`, `auto_invoice`, `next_billing_date`).
- **Credentials** (`client_credentials`): no direct SELECT for anyone. The list view returns portal/username/login URL/notes but **never the ciphertext**. Revealing a password goes through a server action that checks role and vault access, decrypts in `server/admin.ts`, writes `credential_access_logs`, and returns the plaintext once. The UI auto-hides it after 30 seconds and offers copy.
- **Tasks and children:** SELECT as in §4.1. Employees may UPDATE only `status` (within the transition rules), `remarks` and `acceptance_status` on tasks assigned to them; checklist `done`; and comments, attachments and time entries they authored. Status changes go through a Postgres function `change_task_status(task_id, to_status, reason)` that enforces §7.6.4.
- **People tables:** Partners and Managers see all. Employees see their own `employees` row, their own sessions, attendance, leave and time entries, and a minimal directory (name, designation, avatar) of colleagues.
- **Audit logs:** INSERT only through a `security definer` function; SELECT Partner only; no UPDATE or DELETE for anyone.
- **Notifications:** each user sees their own only.
- **WhatsApp groups** (§5.13: `client_whatsapp_groups`, `client_whatsapp_group_members`):
  - SELECT for staff where `can_open_whatsapp(client_id)`. Employees read groups only through `client_whatsapp_groups_public` (no `invite_link`).
  - INSERT/UPDATE Partner/Manager.
  - `firm_whatsapp_numbers`: SELECT for all staff; writes Partner only.
- **TaxWise Desktop** (`desktop_devices`, `desktop_device_numbers`):
  - SELECT for Partners and Managers.
  - Rows are written only by the desktop API route handlers (§7.25.1), after their own checks.
  - Revoking a PC: Partner only.
- **Covers** (`client_covers`):
  - SELECT for Partners and Managers, and for the cover person and the absent person on their own rows.
  - INSERT/UPDATE Partner/Manager only; `include_vault` Partner only.
  - No DELETE: end a cover with `revoked_at`.

### 4.7 Cover access (when the person on a client is away)
A Partner or Manager can let another staff member work on a colleague's clients for a fixed period. While the cover is in force, that person sees and works on the client exactly as if they were on its engagement team: tasks, documents, compliance, workpapers, registers, and the client's **WhatsApp group** in the CRM's WhatsApp panel (§7.25). They still never see fees (§4.1). When the period ends, access ends by itself.

*Example:* Employee 3 is the preparer for XYZ Traders and is absent. A Partner gives Employee 2 cover for XYZ Traders until Friday. Employee 2 can open XYZ Traders, and its WhatsApp group in the CRM's WhatsApp panel, straight away. Employee 4 still can't, and on Friday night Employee 2 can't either.

- **Two kinds:**
  - **Client cover:** one client. "Anita covers XYZ Traders until Friday."
  - **Person cover:** every client a colleague owns or is on the team of, including clients assigned to them during the cover. "Anita covers all of Ravi's clients, 23–25 Oct."
- **Who can grant:** Partners and Managers. Employees can't grant, extend or pass on a cover. Only a Partner can tick **Include portal passwords**, and it has an effect only if the cover person already has Vault access (§4.5).
- **Fields:**
  - **Cover person**\* (active staff; shows their capacity band and warns if they are on leave during the window).
  - **Covering for** (the absent person; required for a person cover; for a client cover it defaults to the client's owner).
  - **Client**\* (client cover only).
  - **From**\* (default now; can't be in the past).
  - **Until**\* (date and time). Quick picks: end of today · end of tomorrow · end of this week · until their leave ends. At most 90 days.
  - **Reason**\* (On leave · Absent today · Workload · Other) · **Note**.
  - **Handover note** (shown to the cover person at the top of the client page).
  - **Include portal passwords** (Partner only) · **Also email the cover person** (default on).
- **Where a cover is created:**
  - Client 360 → Profile & contacts → **Team** → **Add cover**.
  - People → person → **Cover their clients**: one person for all of them, or split client by client in a table showing each client's open tasks and next deadline. A split creates client covers.
  - **Leave approval** (§7.11.3): after approving, the approver is asked "Who covers Ravi's 18 clients from 23 to 25 Oct?" with the same choices, plus **No cover needed** (recorded).
  - The Manager dashboard's **Absent today without cover** list (§7.2).
- **While it is in force:**
  - The client appears in the cover person's **My clients** with the badge "Covering for Ravi · until Sat 25 Oct, 11:59 pm". The client header shows the same chip to everyone.
  - Notifications about these clients that go to the absent person (§9) also go to the cover person.
  - The cover person can be assigned the client's tasks without the "not on this client's team" warning.
  - In TaxWise Desktop, the client's group is on their allowed list in client mode (§7.25.5). When the cover ends, the next context refresh (within 5 minutes) takes it off and closes the chat if it is open.
- **Ending:**
  - **Automatic at Until.** RLS compares the window with `now()`, so nothing has to be switched off and no job can fail to do it.
  - **End now** (Partner/Manager, or the absent person from My day: "I'm back, end cover") · **Extend** (Partner/Manager).
  - When a cover ends, the absent person gets "Anita covered XYZ Traders for you, 23–25 Oct. See what changed", which opens the client timeline filtered to that window. The cover person is asked for an optional note back (`return_note`).
- **Limits:** no covering yourself; no cover for or by a disabled person; overlapping covers for the same client (or the same absent person) and the same cover person merge into one, and the later end wins.
- **Records:** granting, extending and ending (including automatic expiry, recorded by the hourly job in §8) write `audit_logs` (`permission_change`) and a client timeline entry ("Anita is covering for Ravi until 25 Oct; granted by CA Vinay").
- **Code:** the rules (in force or not, merging, which clients a person cover reaches, the 90-day cap) live in `lib/domain/cover.ts` with unit tests. The SQL helper behind `can_see_client` (§4.6) applies the same rules.

---

## §5. Database (Supabase Postgres): every table and column

Notation: `column type` · **NN** = not null · `= x` default · **U** = unique · **FK→t** = foreign key. Every table also has `created_at timestamptz NN = now()` and `updated_at timestamptz NN = now()` (trigger-maintained) unless noted, and RLS enabled (§4.6). Soft-deletable tables have `deleted_at timestamptz`. Money is `numeric(14,2)` unless stated. Enums are Postgres enum types with exactly the values listed.

### 5.1 Enums
```
app_role:            partner, manager, employee, client
client_status:       active, inactive, pending, on_hold
client_priority:     low, medium, high, critical
entity_type:         proprietorship, partnership, llp, pvt_ltd, public_ltd, section_8, trust, aop, huf, individual, other
gst_registration:    registered, unregistered, unknown
gst_scheme:          monthly, qrmp
service_type:        gst, income_tax, tds, payroll, bookkeeping, audit, company_law, incorporation, other
service_frequency:   monthly, quarterly, annual, one_time
team_role:           engagement_partner, review_manager, preparer
task_status:         not_started, in_progress, data_awaited, under_review, filed_done, on_hold
task_priority:       low, medium, high, urgent
task_acceptance:     pending, accepted, declined
decline_reason:      no_capacity, not_my_client, wrong_skill, needs_info, on_leave, other
automation_type:     recurring_task, reminder, escalation
automation_frequency:daily, weekly, monthly, quarterly, yearly, custom
compliance_type:     gstr_1, gstr_3b, tds, roc, itr, pf_esic, audit, advance_tax, pt, custom
compliance_status:   pending, completed, cancelled          -- "overdue" is derived
compliance_workflow: not_started, documents_awaited, in_progress, under_review, filed, completed
compliance_source:   statutory_engine, ops_template, manual
lead_status:         new_lead, contacted, quotation_requested, follow_up_required, client_will_revert, proposal_sent, negotiation, won, lost
lead_source:         referral, website, walk_in, cold_call, social_media, whatsapp, existing_client, other
quotation_status:    draft, pending_approval, approved, sent, viewed, accepted, rejected, expired, superseded
invoice_status:      draft, awaiting_approval, sent, partially_paid, paid, disputed, waived   -- "overdue" is derived
payment_method:      bank_transfer, upi, cheque, cash, card, other
credit_note_reason:  fee_reduction, service_not_rendered, duplicate, error, goodwill
document_category:   gst, tds, roc, audit, income_tax, payroll, bank_statements, invoices, agreements, kyc, engagement, acknowledgements, other
document_activity:   uploaded, downloaded, viewed, renamed, deleted, version_created, tag_added, tag_removed
request_status:      open, completed, cancelled
request_item_status: pending, uploaded, accepted, rejected
message_channel:     email, whatsapp_handoff, gmail_handoff, portal, internal_note, call_log
message_direction:   outbound, inbound
message_status:      pending, queued, sent, handed_off, delivered, read, failed
template_type:       document_reminder, compliance_reminder, payment_reminder, task_assignment, overdue_notification, quotation, welcome, custom
notification_type:   task_assigned, task_declined, task_sent_back, task_approved, review_requested, task_overdue, compliance_due, invoice_overdue, invoice_awaiting_approval, payment_received, document_uploaded, quotation_viewed, quotation_responded, leave_requested, leave_decided, expiry_alert, info, warning, cover_started, cover_ending, cover_ended, whatsapp_group_missing, whatsapp_device_linked, whatsapp_client_mode_down, security_alert
attendance_status:   present, absent, late_login, half_day, on_leave
leave_type:          annual, sick, casual, unpaid, sabbatical, other
leave_status:        requested, approved, declined, cancelled
engagement_status:   draft, issued, signed, declined, expired
notice_status:       open, reply_drafted, replied, hearing, closed_favourable, closed_unfavourable, closed_partial
registration_status: active, expired, surrendered, cancelled
dsc_status:          active, expired, revoked
acceptance_outcome:  pending, accepted, declined
peer_review_status:  scheduled, in_progress, completed
audit_event:         login_success, login_failure, logout, password_change, access_denied, permission_change, data_create, data_update, data_delete, file_upload, file_download, credential_viewed, config_change, user_create, user_update, user_disable, export_run, record_viewed
whatsapp_number_kind:   partner, managers_office, staff_office, other
whatsapp_group_status:  to_create, active, closed
whatsapp_member_kind:   firm_number, client_contact, other_person
cover_kind:             client, person
cover_reason:           leave, absent_today, workload, other
```

### 5.2 Firm and people
**firm_settings** (singleton): `id smallint pk = 1 check (id = 1)` ·
- **Identity:** `firm_name text NN = 'TaxWise Consultants'` · `legal_name text` · `tagline text` · `address text` · `city text` · `state_code char(2) NN = '29'` · `pincode char(6)` · `phone text` · `email text` · `website text` · `gstin citext` · `pan citext` · `tan citext` · `icai_frn text`
- **Bank and UPI:** `bank_name text` · `bank_account_name text` · `bank_account_number text` · `bank_ifsc text` · `bank_branch text` · `upi_id text` · `upi_payee_name text`
- **Branding:** `logo_path text` · `logo_updated_at timestamptz`
- **Numbering:** `invoice_prefix text NN = 'TW'` · `credit_note_prefix text NN = 'TW-CN'` · `quotation_prefix text NN = 'TW-Q'` · `receipt_prefix text NN = 'TW-R'` · `client_code_prefix text NN = 'TW-C'`
- **Billing defaults:** `default_sac text NN = '9982'` · `sac_by_service jsonb` (service_type → SAC, editable; see §6.4) · `default_tax_rate numeric(5,2) NN = 18` · `payment_terms_days int NN = 15` · `invoice_approval_limit numeric(14,2)` (null = no approvals needed) · `quotation_approval_limit numeric(14,2)` (null = Managers' quotations always need Partner approval; 0 = never)
- **Quotation defaults:** `quotation_validity_days int NN = 30` · `quotation_terms text` · `invoice_terms text` · `invoice_footer_note text`
- **Working hours:** `work_day_start time NN = '09:30'` · `late_grace_minutes int NN = 15` · `half_day_minutes int NN = 240` · `working_weekdays smallint[] NN = '{1,2,3,4,5,6}'` (1 = Monday) · `weekly_hours_target int NN = 48` · `holidays date[]` (or a separate `holidays` table)
- **Reminders:** `compliance_reminder_days int NN = 7` · `invoice_reminder_before_days int NN = 3` · `invoice_reminder_after_days int[] NN = '{1,7,15}'` · `document_request_reminder_every_days int NN = 3`
- **Email:** `email_from_name text NN = 'TaxWise Consultants'` · `email_from_address text NN = 'noreply@twchartered.com'` · `email_reply_to text NN = 'info@twchartered.com'` · `sending_domain text NN = 'twchartered.com'` · `resend_domain_id text` · `domain_status text` (not_started / pending / verified / failed; mirrors Resend, never set locally) · `domain_verified_at timestamptz`
- **Other:** `whatsapp_country_code text NN = '91'` · `updated_by uuid`
- **WhatsApp and TaxWise Desktop (§7.25):** `whatsapp_group_name_format text NN = 'TW · {client_code} · {short_name}'` · `whatsapp_signature text NN = '– {first_name}'` · `whatsapp_client_mode bool NN = true` · `whatsapp_employee_notifications bool NN = false` · `whatsapp_employee_browser_window bool NN = false` · `whatsapp_linked_device_limit smallint NN = 4` · `whatsapp_house_rules text` (seeded, §16) · `desktop_download_url text`

**profiles** (one per auth user): `id uuid pk FK→auth.users on delete cascade` · `full_name text NN` · `email citext NN U` · `phone text` · `role app_role NN` · `is_active bool NN = true` · `must_change_password bool NN = false` · `icai_membership_no text` (Partners) · `avatar_path text` · `last_login_at timestamptz` · `onboarding_completed bool NN = false` · `onboarding_step int NN = 0` · `preferences jsonb NN = '{}'` (theme, density, favourites, notification channels per type).

**employees** (staff records; a person can exist before they have a login, and Partners have one too): `id` · `profile_id uuid U FK→profiles on delete set null` · `full_name text NN` · `email citext NN U` · `phone text` · `whatsapp text` · `department text` · `designation text` · `date_of_joining date` · `billing_rate_per_hour numeric(10,2)` (null = not billed hourly; excl. GST) · `cost_rate_per_hour numeric(10,2)` (Partner-only column) · `vault_access bool NN = false` · `is_active bool NN = true` · `deleted_at`.

**employee_leave:** `id` · `employee_id FK NN` · `start_date date NN` · `end_date date NN` (inclusive; check end ≥ start) · `type leave_type NN = 'annual'` · `status leave_status NN = 'requested'` · `reason text` · `decided_by uuid` · `decided_at timestamptz` · `decision_note text`.

**employee_sessions:** `id` · `employee_id FK NN` · `user_id uuid NN` · `login_at timestamptz NN = now()` · `last_active_at timestamptz NN` · `logout_at timestamptz` · `active_minutes int NN = 0` (accumulated from heartbeats, §7.12) · `duration_minutes int` (copied from active_minutes at close) · `closed_reason text` (logout / stale / day_end) · `ip text` · `user_agent text` · `is_active bool NN = true`. No `updated_at` needed.

**attendance_records:** `id` · `employee_id FK NN` · `date date NN` · `status attendance_status NN` · `first_login_at timestamptz` · `last_activity_at timestamptz` · `work_minutes int` · `notes text` · `corrected_by uuid` · `correction_reason text` · **U(employee_id, date)**.

**employee_activities:** `id` · `employee_id NN` · `user_id NN` · `activity_type text NN` (login, logout, client_created, client_updated, client_viewed, task_created, task_updated, task_completed, document_uploaded, document_downloaded, invoice_created, invoice_updated, payment_recorded, compliance_completed, email_sent, whatsapp_sent, report_generated, search_performed, settings_changed) · `description text NN` · `entity_type text` · `entity_id uuid` · `entity_name text` · `metadata jsonb` · `performed_at timestamptz NN = now()`.

### 5.3 Clients
**client_groups:** `id` · `name citext NN U` · `notes text`.

**clients:**
- **Identity:** `id` · `client_code citext NN U` (auto `TW-C-0001` from number_series, editable) · `display_name text NN` · `legal_name text` · `entity_type entity_type` · `entity_type_other text` · `is_incorporated bool NN = true` · `date_of_birth_or_incorporation date` (drives the ITR age band for individuals)
- **Tax registrations:** `pan citext U` · `tan citext` · `gst_registration gst_registration NN = 'unknown'` · `gstin citext U` (required when registered) · `state_code char(2)` (place of supply; auto from GSTIN)
- **Contact:** `email citext` · `phone text` · `whatsapp text` · `address text` · `city text` · `pincode char(6)` · `notes text`
- **Work:** `status client_status NN = 'pending'` · `priority client_priority NN = 'medium'` · `owner_employee_id FK→employees on delete set null` · `group_id FK→client_groups on delete set null`
- **Financial year and scale:** `fy_end_month smallint NN = 3 check 1–12` · `annual_turnover numeric(16,2)` · `turnover_fy text` (e.g. `2025-26`) · `gst_scheme gst_scheme` (null = derive from turnover, §6.6)
- **Portal:** `portal_user_id uuid U FK→auth.users` · `portal_invited_at` · `portal_last_seen_at`
- **Origin:** `source_lead_id uuid` · `source_quotation_id uuid` · `onboarded_at timestamptz` · `onboarded_by uuid`
- **Housekeeping:** `created_by uuid` · `deleted_at`
- **Constraints:** if `gst_registration = 'registered'` then `gstin` is not null; if GSTIN is present, characters 3–12 must equal the PAN when the PAN is present. Indexes on status, priority, owner, group, deleted_at, lower(display_name) (trigram for search).

**client_services** (the engagement: this client, this service, this fee, this cycle): `id` · `client_id FK NN` · `service_type service_type NN` · `custom_name text` (required when `other`) · `frequency service_frequency NN` · `is_active bool NN = true` · `next_due_date date` · `agreed_fee numeric(12,2)` (per billing occurrence, excl. GST; null = not agreed) · `billing_frequency service_frequency` (null = same as frequency) · `sac_code text` (override) · `fee_agreed_at timestamptz` · `source_quotation_item_id uuid` · `auto_invoice bool NN = false` · `next_billing_date date` · `last_auto_invoiced_at timestamptz` · **U(client_id, service_type, coalesce(custom_name,''))**. *(View `client_services_public` without the fee columns for Employees.)*

**client_contacts:** `id` · `client_id FK NN` · `name text NN` · `role text` (Director, CFO, Authorised Signatory, Accountant, Promoter, Other) · `email citext` · `phone text` · `whatsapp text` · `is_primary bool NN = false` (partial unique: one primary per client) · `handles service_type[] NN = '{}'` (which services this person answers for; empty = general) · `notes text`.

**client_team_members:** `id` · `client_id FK NN` · `employee_id FK NN` · `team_role team_role NN = 'preparer'` · **U(client_id, employee_id, team_role)**.

**client_document_checklist_items:** `id` · `client_id FK NN` · `label text NN` · `is_required bool NN = true` · `collected bool NN = false` · `collected_at` · `collected_by uuid` · `document_id uuid FK→documents` · `sort_order int NN = 0`.

**client_credentials** (government portal logins): `id` · `client_id FK NN` · `portal text NN` (GST, INCOME_TAX, TRACES, MCA, EPFO, ESIC, ICEGATE, PT, OTHER) · `portal_label text` (when OTHER) · `username text NN` · `password_ciphertext text NN` (AES-256-GCM, `base64(iv).base64(tag).base64(ct)`, key = `CREDENTIAL_VAULT_KEY`, 64 hex chars) · `login_url text` · `notes text` · `updated_by uuid` · **U(client_id, portal, username)**.
**credential_access_logs:** `id` · `credential_id FK NN` · `user_id NN` · `action text NN` (viewed, copied, created, updated, deleted) · `ip text` · `created_at`.

**client_acceptances** (conflict check before taking a client on): `id` · `prospect_name text NN` · `pan citext` · `gstin citext` · `related_parties text[] NN = '{}'` · `conflicts_found jsonb` (frozen at decision time) · `outcome acceptance_outcome NN = 'pending'` · `rationale text` (required when declining or accepting despite a conflict) · `decided_by uuid` · `decided_at` · `lead_id uuid` · `client_id uuid` · `created_by uuid NN`.

### 5.4 Sales pipeline
**leads:** `id` · `lead_number text U` (auto `L-0001`) · `name text NN` · `company text` · `email citext` · `phone text` · `whatsapp text` (check: at least one of email / phone / whatsapp) · `services_required service_type[] NN = '{}'` · `requirement_notes text` · `source lead_source NN = 'other'` · `source_detail text` (who referred them) · `status lead_status NN = 'new_lead'` · `estimated_value numeric(14,2)` · `assigned_to uuid FK→employees` · `next_follow_up_at timestamptz` · `lost_reason text` (required when lost) · `converted_client_id uuid` · `created_by uuid NN` · `deleted_at`.

**quotations:** `id` · `quotation_number text NN U` (from number_series, e.g. `TW-Q/26-27/0007`) · `lead_id uuid` · `client_id uuid` (when quoting an existing client for extra work) · `client_name text NN` · `client_email citext NN` · `client_phone text` · `client_company text` · `client_gstin citext` · `place_of_supply_code char(2)` · `issue_date date NN = today` · `valid_until date NN` · `status quotation_status NN = 'draft'` · `notes text` · `terms text` · `subtotal`, `tax_amount`, `total` (NN) · `token text NN U` (32 random bytes, URL-safe) · `created_by uuid NN` · `approved_by`, `approved_at` · `sent_at` · `first_viewed_at`, `last_viewed_at`, `view_count int NN = 0` · `responded_at` · `response text` (accepted / rejected) · `rejection_reason text` · `accepted_by_name text` (the client types their name to accept) · `response_ip text` · `converted_client_id uuid` · `revised_from_id uuid FK→quotations` · `revision_number int NN = 0` · `deleted_at`.

**quotation_items:** `id` · `quotation_id FK NN` · `description text NN` · `service_type service_type` · `frequency service_frequency` (so a converted engagement knows its cycle) · `quantity numeric(10,2) NN = 1` · `unit_price NN` · `tax_rate numeric(5,2) NN = 18` · `tax_amount NN` · `total NN` · `sort_order int NN = 0`.

**quotation_email_logs:** `id` · `quotation_id FK NN` · `channel message_channel NN` · `email_type text NN` (initial, follow_up_3, follow_up_7, follow_up_14, revision, acceptance_confirmation) · `to text NN` · `subject text` · `status text NN` (sent, handed_off, failed, delivered, opened, bounced) · `provider_message_id text` · `error text` · `sent_at` · `delivered_at` · `opened_at`.

**quotation_follow_ups:** `id` · `quotation_id FK NN` · `follow_up_day smallint NN` (3, 7, 14) · `scheduled_at timestamptz NN` · `sent_at` · `status text NN = 'pending'` (pending / sent / skipped / failed).

### 5.5 Work
**tasks:**
- **What:** `id` · `task_number text NN U` (auto `T-000123`) · `client_id FK NN` · `title text NN` · `description text` · `service_type service_type` · `financial_year text` · `period_label text` (e.g. `Sep 2026`, `Q2 2026-27`)
- **Status:** `status task_status NN = 'not_started'` · `priority task_priority NN = 'medium'` · `due_date date` · `completion_date timestamptz` (set when filed_done, cleared on reopen) · `on_hold_reason text`
- **People:** `assigned_employee_id FK→employees on delete set null` · `reviewer_employee_id FK→employees` · `acceptance_status task_acceptance NN = 'pending'` · `accepted_at` · `declined_at` · `decline_reason decline_reason` · `decline_note text` · `declined_by_employee_id uuid`
- **Escalation and links:** `estimated_minutes int` · `remarks text` · `escalation_level int NN = 0` · `escalated_at` · `compliance_event_id uuid FK` · `source_template_id uuid` · `created_by uuid NN` · `deleted_at`
- **View `tasks_view`** adds the derived `is_overdue = status not in (filed_done) and due_date < today_ist()`, plus `days_overdue`.

**task_status_history:** `id` · `task_id FK NN` · `from_status` · `to_status NN` · `reason text` · `changed_by uuid NN` · `changed_at timestamptz NN = now()`.

**task_comments:** `id` · `task_id FK NN` · `author_id uuid NN` · `body text NN` · `mentions uuid[] NN = '{}'` · `edited_at` · `deleted_at`.

**task_attachments:** `id` · `task_id FK NN` · `document_id uuid FK→documents` (files go through the vault) · `uploaded_by uuid` · `created_at`.

**task_checklist_items:** `id` · `task_id FK NN` · `title text NN` · `done bool NN = false` · `done_by uuid` · `done_at` · `due_offset_days int` · `sort_order int NN = 0`.

**task_dependencies:** `id` · `task_id FK NN` (the blocked task) · `blocker_task_id FK NN` · **U(task_id, blocker_task_id)** · a trigger rejects cycles and self-dependency.

**task_automations** (recurring tasks): `id` · `template_task_id uuid` · `client_id uuid` · `type automation_type NN` · `frequency automation_frequency NN` · `config jsonb` · `is_active bool NN = true` · `next_run_at` · `last_run_at`.

**job_templates:** `id` · `name citext NN U` · `service_type service_type NN` · `description text` · `default_lead_days int` · `is_active bool NN = true`.
**job_template_items:** `id` · `template_id FK NN` · `title text NN` · `description text` · `offset_days int NN = 0` (days before the job's due date; negative = after) · `sort_order int NN = 0`.

**time_entries:** `id` · `employee_id FK NN` · `client_id uuid` · `task_id uuid` · `description text` · `started_at timestamptz NN` · `ended_at timestamptz` (null while the timer runs; **at most one running timer per employee**, partial unique index) · `minutes int NN = 0` · `billable bool NN = true` · `invoice_id uuid FK` · `invoiced_at` · `locked bool NN = false` (true once billed or week approved).

### 5.6 Compliance and filings
**compliance_events** (one calendar for statutory deadlines, internal prep steps and manual dates): `id` · `client_id uuid FK` (null = firm-level event) · `type compliance_type NN` · `form_code text` (e.g. `GSTR-3B`, `24Q`, `AOC-4`, `ITR-6`) · `title text NN` · `description text` · `financial_year text` · `filing_period text` (e.g. `Sep 2026`, `Q2 2026-27`) · `period_start date` · `period_end date` · `due_date date NN` · `status compliance_status NN = 'pending'` · `workflow_status compliance_workflow NN = 'not_started'` · `is_statutory bool NN = true` · `source compliance_source NN` · `reminder_days int NN = 7` · `task_id uuid FK` · `completed_at` · `notes text` · `dedupe_key text U` (`client_id|form_code|filing_period`, so generators never double up). View adds the derived `is_overdue`.

**recurring_compliance_templates** (internal prep steps that lead up to statutory dates): `id` · `service_type NN` · `compliance_type NN` · `title text NN` · `description text` · `frequency service_frequency NN` · `due_day_of_month smallint NN` · `due_month smallint` · `period_offset smallint NN = 0` · `reminder_days int NN` · `is_active bool NN = true` · **U(service_type, compliance_type, title)**.

**filing_records** (what was actually filed, by us or a previous CA): `id` · `client_id FK NN` · `financial_year text NN` · `filing_type text NN` (free text: `GSTR-3B`, `ITR-6`, `24Q`, `AOC-4`…) · `service_type service_type` · `period text` · `filed_on date` · `acknowledgement_no text` (ARN / ack no / SRN) · `filed_by_external text` (previous firm's name, for inherited history) · `task_id uuid` · `compliance_event_id uuid` · `document_id uuid` (acknowledgement PDF) · `notes text` · `created_by uuid`.

**udin_records:** `id` · `client_id uuid` · `udin citext NN U` · `document_type text NN` (Tax Audit Report, Statutory Audit Report, Certificate, GST Audit, Net-worth certificate, Other) · `document_date date NN` · `filing_record_id uuid FK` · `signing_partner_id uuid FK→profiles` · `remarks text`.

**statutory_registrations:** `id` · `client_id FK NN` · `registration_type text NN` (GST, PT, IEC, MSME_UDYAM, FSSAI, SHOPS_ESTAB, PF, ESIC, DIN, LLPIN, CIN, TAN, OTHER) · `registration_number text NN` · `jurisdiction text` · `issue_date date` · `expiry_date date` · `reminder_days int NN = 30` · `status registration_status NN = 'active'` · `notes text`.

**dsc_records:** `id` · `client_id FK NN` · `holder_name text NN` · `holder_pan citext` · `dsc_class text NN = 'class_3'` · `serial_number text` · `issued_by text` (eMudhra, Capricorn, Sify, (n)Code, Other) · `issue_date date` · `expiry_date date NN` · `custody text` (who physically holds the token: Firm / Client / named person) · `status dsc_status NN = 'active'` · `notes text`.

**engagement_letters:** `id` · `client_id FK NN` · `financial_year text NN` · `service_types service_type[] NN` · `scope text` · `fee_agreed numeric(14,2)` · `status engagement_status NN = 'draft'` · `issued_at` · `signed_at` · `expires_at date` · `document_id uuid` (the signed letter in the vault) · `notes text` · `created_by uuid`.

**peer_reviews:** `id` · `period_from date NN` · `period_to date NN` · `reviewer_name text NN` · `reviewer_frn text` · `status peer_review_status NN = 'scheduled'` · `reviewed_on date` · `certificate_no text` · `valid_until date` · `observations text` · `notes text` · `created_by uuid`.

### 5.7 Money
**invoices:**
- **Identity:** `id` · `invoice_number text NN U` (from number_series, ≤16 chars, e.g. `TW/26-27/0042`) · `client_id FK NN`
- **Dates and status:** `issue_date date NN` · `due_date date NN` · `status invoice_status NN = 'draft'`
- **Snapshots at issue:** `client_name_snapshot text` · `client_address_snapshot text` · `client_gstin_snapshot citext` · `place_of_supply_code char(2) NN` · `firm_gstin_snapshot citext`
- **Totals:** `reverse_charge bool NN = false` · `taxable_amount NN` · `cgst_amount NN = 0` · `sgst_amount NN = 0` · `igst_amount NN = 0` · `reimbursement_amount NN = 0` (non-taxable pure-agent expenses) · `round_off numeric(6,2) NN = 0` · `total_amount NN` (taxable + tax + reimbursements + round-off)
- **Settlement (maintained by trigger from receipts and credit notes):** `amount_received NN = 0` · `tds_credited NN = 0` · `credit_noted NN = 0` · `outstanding_amount NN`
- **Content:** `service_type service_type` (primary) · `billing_period_label text` · `notes text` · `terms text`
- **Links:** `source_task_id uuid` · `client_service_id uuid` (retainer source) · `revised_from_id uuid FK→invoices` · `revision_number int NN = 0`
- **Approval and sending:** `requires_approval bool NN = false` (frozen at creation) · `approved_by` · `approved_at` · `sent_at` · `sent_channels text[]` · `waived_reason text` · `disputed_reason text` · `created_by uuid NN` · `deleted_at`
- **View `invoices_view`** adds the derived `is_overdue = status in (sent, partially_paid) and outstanding_amount > 0 and due_date < today_ist()` and `days_overdue`. **A draft is never overdue.**

**invoice_items:** `id` · `invoice_id FK NN` · `description text NN` · `service_type service_type` · `sac_code text NN` · `quantity numeric(10,2) NN = 1` · `rate NN` · `amount NN` · `tax_rate numeric(5,2) NN` (0 for reimbursements) · `is_reimbursement bool NN = false` · `sort_order int NN = 0`.

**payment_receipts:** `id` · `receipt_number text NN U` · `invoice_id FK NN` · `payment_date date NN` · `amount_received NN` (cash/bank actually received; may be 0 if fully settled by TDS) · `tds_amount numeric(14,2) NN = 0` · `tds_section text` (194J, 194C, 194H, 194I, OTHER) · `method payment_method NN` · `reference text` (UTR / cheque no) · `deposited_to text` (which firm account) · `notes text` · `recorded_by uuid NN` · `reversed_at` · `reversed_by` · `reversal_reason text`. Receipts are **reversed, never deleted**.

**credit_notes:** `id` · `credit_note_number text NN U` · `invoice_id FK NN` · `client_id FK NN` · `reason_code credit_note_reason NN` · `reason text NN` · `taxable_amount NN` · `tax_rate numeric(5,2)` · `cgst_amount`, `sgst_amount`, `igst_amount` · `total_amount NN` · `place_of_supply_code char(2)` · `issue_date date NN` · `issued_by uuid NN`.

**invoice_follow_ups** (collection notes): `id` · `invoice_id FK NN` · `channel text NN` (call, email, whatsapp, visit, other) · `notes text NN` · `promised_payment_date date` · `next_follow_up_at timestamptz` · `by_user uuid NN` · `created_at`.

**invoice_reminders:** `id` · `invoice_id FK NN` · `kind text NN` (before_due, after_due, custom) · `scheduled_for timestamptz NN` · `channel message_channel NN` · `sent_at` · `status text NN = 'pending'`.

### 5.8 Documents and requests
**documents:**
- **What:** `id` · `client_id FK NN` · `title text NN` · `category document_category NN = 'other'` · `financial_year text` · `period text` · `description text`
- **The file:** `file_name text NN` · `file_size int NN` · `mime_type text NN` · `storage_path text NN` (bucket `client-documents/<client_id>/<uuid>.<ext>`) · `sha256 text` (duplicate warning) · `version int NN = 1`
- **Origin and handling:** `source text NN = 'staff'` (staff, client_portal, generated, email, whatsapp) · `is_confidential bool NN = false` (hidden from Employees unless they're on the client team) · `uploaded_by uuid NN`
- **Dates:** `expiry_date date` · `renewal_date date` · `retention_until date` (default report/upload date + 7 years) · `deleted_at`
- **Rules:** max 25 MB; allowed types: pdf, jpg/jpeg, png, heic, csv, xls, xlsx, doc, docx. Reject anything else with the reason.

**document_versions:** `id` · `document_id FK NN` · `version int NN` · `file_name`, `file_size`, `storage_path` NN · `uploaded_by NN` · `change_note text` · `created_at`.
**document_tags:** `id` · `document_id FK NN` · `tag citext NN` · **U(document_id, tag)**.
**document_activities:** `id` · `document_id FK NN` · `user_id NN` · `activity document_activity NN` · `metadata jsonb` · `created_at`.

**document_requests** (PBC lists sent to clients): `id` · `client_id FK NN` · `title text NN` · `status request_status NN = 'open'` · `due_date date` · `notes text` · `created_by uuid NN` · `last_reminded_at` · `reminder_every_days int NN = 3`.
**document_request_items:** `id` · `request_id FK NN` · `title text NN` · `help_text text` · `is_required bool NN = true` · `status request_item_status NN = 'pending'` · `document_id uuid FK` · `rejection_reason text` · `sort_order int NN`.

### 5.9 Communication
**message_templates:** `id` · `name citext NN U` · `type template_type NN = 'custom'` · `channel text NN = 'any'` (email, whatsapp, any) · `subject text` (email) · `body text NN` (with `{{variables}}`, §7.13) · `is_active bool NN = true` · `created_by uuid`.

**messages** (the communication history per client, every channel): `id` · `client_id FK NN` · `contact_id uuid` · `channel message_channel NN` · `direction message_direction NN = 'outbound'` · `recipient text` (email address or normalised phone) · `subject text` · `body text NN` · `template_id uuid` · `status message_status NN` · `provider_message_id text` · `error text` · `related_entity_type text` · `related_entity_id uuid` · `sent_by uuid` · `sent_at` · `delivered_at` · `read_at` · `failed_at`.
**message_events:** `id` · `message_id FK NN` · `status message_status NN` · `details jsonb` · `at timestamptz NN = now()`.

### 5.10 Workpapers
**gst_recon_runs:** `id` · `client_id FK NN` · `period char(6) NN` (MMYYYY) · `portal_gstin citext` · `summary jsonb NN` (counts, matched value, unclaimed ITC, ITC at risk, supplier roll-up) · `diagnostics jsonb` · `source_files jsonb` (storage paths of the uploaded 2B and register) · `created_by uuid NN`.
**gst_recon_entries:** `id` · `run_id FK NN` · `bucket text NN` (matched, mismatch, missing_in_books, missing_in_2b) · `match_tier text` (exact, loose, fuzzy) · `supplier_gstin citext NN` · `supplier_name text` · `data jsonb NN` (both sides and deltas) · `resolution text` (open, accepted, follow_up_supplier, ignore) · `resolution_note text`.

**itr_computations:** `id` · `client_id FK NN` · `financial_year text NN` · `inputs jsonb NN` · `results jsonb NN` (recomputed on the server on every save; never trusted from the browser) · `regime_chosen text` (old/new/null) · `status text NN = 'draft'` (draft, reviewed, final) · `created_by uuid NN`.

**financial_statements:** `id` · `client_id FK NN` · `financial_year text NN` · `ledgers jsonb NN` (name, group, debit, credit, bucket, matched) · `statements jsonb NN` (P&L, balance sheet, checks; rebuilt on the server on save) · `status text NN = 'draft'` · `created_by uuid NN`.

**tax_notices:** `id` · `client_id FK NN` · `notice_type text NN` (e.g. GST DRC-01, ASMT-10, IT 143(2), IT 148/148A, 142(1), TDS 200A/201) · `section text` · `authority text` · `reference_no text` (DIN) · `notice_date date` · `received_date date` · `reply_due_date date` · `hearing_date timestamptz` · `status notice_status NN = 'open'` · `demand_amount numeric(16,2)` · `description text` · `notes text` (running log) · `assigned_employee_id uuid` · `created_by uuid NN`.

### 5.11 Platform
**notifications:** `id` · `user_id uuid NN` · `type notification_type NN` · `title text NN` · `body text NN` · `link_url text NN` (deep link to the exact record) · `entity_type text` · `entity_id uuid` · `read_at` · `archived_at` · `emailed_at` · `created_at`.

**activity_logs** (entity history shown on detail pages): `id` · `entity_type text NN` · `entity_id uuid NN` · `action text NN` · `description text NN` · `user_id uuid` · `user_name text` · `metadata jsonb` · `at timestamptz NN = now()`.

**client_timeline_events** (the client's story): `id` · `client_id uuid` · `lead_id uuid` · `event_type text NN` (lead_created, lead_status_changed, quotation_created/sent/viewed/accepted/rejected, client_onboarded, document_uploaded/requested, task_created/completed, compliance_filed/overdue, invoice_created/sent, payment_received, message_sent, note_added, employee_assigned) · `title text NN` · `description text` · `metadata jsonb` · `performed_by uuid` · `created_at`.

**audit_logs:** `id` · `event audit_event NN` · `user_id uuid` · `user_email text` · `user_role text` · `ip text` · `user_agent text` · `resource_type text` · `resource_id text` · `action text` · `details jsonb` · `success bool NN = true` · `error text` · `at timestamptz NN = now()`. Insert-only.

**saved_views:** `id` · `user_id uuid NN` · `page text NN` · `name text NN` · `filters jsonb NN` · `columns jsonb` · `sort jsonb` · `is_shared bool NN = false` · `is_default bool NN = false`.

**number_series:** `key text pk` (invoice, credit_note, quotation, receipt, client_code, task, lead) · `financial_year text` · `next_value int NN = 1`. Function `next_document_number(p_key text, p_date date) returns text`: locks the row (`FOR UPDATE`), resets the counter when the FY changes for FY-scoped series, and formats as `<prefix>/<yy-yy>/<0000>` (e.g. `TW/26-27/0001`). It raises if the result exceeds 16 characters.

**app_meta:** `key text pk` · `value text`, holding `schema_version`.

### 5.12 Law-driven tables (statutory parameters are data, not code)
Indian rates, thresholds, section numbers and due dates change every year: by Finance Act, by CBDT/CBIC/MCA notification and circular, and by ICAI pronouncement. **None of them may be hard-coded in application logic.** Store them in the tables below, each row with an effective period and the legal source. Seed them with §6, let Partners edit them on a **Law & rules** settings page, and show "last reviewed on" on that page.

**statutory_parameters:** `id` · `key text NN` (e.g. `gst.default_rate_services`, `tds.professional_fees.rate`, `tds.professional_fees.threshold`, `itr.new.rebate_limit`, `audit.tax_audit_ceiling`, `udin.generation_days`) · `value jsonb NN` · `effective_from date NN` · `effective_to date` · `statute text` (e.g. `Income-tax Act, 2025`) · `section_ref text` · `source_ref text` (notification/circular number and date) · `notes text` · `verified_by uuid` · `verified_on date`. Lookups always pass a date, and the row in force on that date wins.

**due_date_rules:** `id` · `code text NN U` (e.g. `GSTR3B_MONTHLY`, `ITR_NON_AUDIT_3_4`, `TAX_AUDIT_REPORT`, `DIR3_KYC_WEB`) · `title text NN` · `compliance_type compliance_type NN` · `form_code text` · `applies_to jsonb` (service type, entity types, scheme, audit status, turnover band) · `frequency service_frequency NN` · `rule jsonb NN` (e.g. `{ "monthOffset": 1, "day": 20 }`, `{ "afterEvent": "AGM", "days": 30 }`, `{ "fixed": "07-31", "yearOffset": 1 }`, `{ "everyNYears": 3, "fixed": "06-30" }`) · `reminder_days int NN` · `effective_from date NN` · `effective_to date` · `source_ref text`.

**due_date_overrides** (government extensions): `id` · `rule_code text NN` · `period_label text NN` (e.g. `AY 2026-27`, `Sep 2026`) · `original_due date NN` · `extended_due date NN` · `scope text` (who it covers) · `source_ref text NN` (e.g. "CBDT Circular 07/2026 dated 28 Sep 2026") · `created_by uuid`. When an override is saved, every matching **unfiled** compliance event moves to the new date, its reminder is re-planned, and the event's history records the move with the circular reference.

**section_concordance** (1961 Act ↔ 2025 Act): `id` · `topic text NN` · `old_section text` · `new_section text` · `old_form text` · `new_form text` · `verified bool NN = false` · `source_ref text`. Every label on screen and every PDF that cites a section picks the version that matches the **tax year** of the record (§6.1).

**client_kyc** (ICAI KYC Norms, mandatory for attest engagements since 1 Jan 2017):
- **Who:** `id` · `client_id FK NN U` · `entity_category text NN` (individual_proprietor, corporate, non_corporate)
- **Identity:** `pan citext` · `cin_llpin text` · `business_description text` · `registered_address text`
- **People:** `principal_persons jsonb` (directors/partners/trustees: name, address, PAN or DIN; **never a full Aadhaar number**, see §6.10)
- **Engagement:** `last_audited_fs_document_id uuid` · `engagement_types text[]`
- **Verification:** `verified_by uuid` · `verified_on date` · `next_review_on date` (annual re-confirmation)

**previous_auditor_communications** (CA Act 1949, First Schedule Part I, Clause 8: write to the outgoing auditor before accepting an audit): `id` · `client_id FK NN` · `engagement_type text NN` · `previous_auditor_name text NN` · `previous_auditor_frn text` · `letter_sent_on date NN` · `delivery_proof_document_id uuid` (registered post/email acknowledgement) · `reply_received_on date` · `objections text` · `outcome text` (no_objection, objection_resolved, objection_unresolved).

**audit_engagements** (statutory, tax, GST, internal, bank, other audits, run to the Standards on Auditing, §6.9):
- **Engagement:** `id` · `client_id FK NN` · `audit_type text NN` (statutory_companies_act, tax_audit, gst_audit, internal, bank_branch, stock, certification, other) · `financial_year text NN`
- **Team:** `engagement_partner_id uuid NN` · `review_manager_id uuid`
- **Status and dates:** `stage text NN` (acceptance, planning, risk_assessment, execution, completion, reporting, archived) · `materiality jsonb` (basis, overall, performance, trivial threshold) · `report_type text` (unmodified, qualified, adverse, disclaimer) · `report_date date` · `udin_record_id uuid` · `file_assembly_due date` (generated = report_date + 60 days) · `archived_at timestamptz` (after this the file is read-only) · `retain_until date` (report_date + 7 years)
- **Checklists:** `caro_applicable bool` · `checklist jsonb` (SA-mapped steps with evidence links and sign-offs)

**tax_audit_ceiling_view** (computed): per signing member per financial year, counts the tax audit reports **signed** in that year that count towards the ICAI ceiling (§6.8), with warnings.

**privacy_notices**, **consent_records**, **data_requests**, **data_incidents** (DPDP Act 2023 / DPDP Rules 2025, §6.10):
- **privacy_notices:** `id` · `version text` · `body markdown` · `published_at` · `is_current`.
- **consent_records:** `id` · `subject_type` (client_contact, portal_user, employee, lead) · `subject_id` · `notice_version` · `purposes text[]` · `given_at` · `withdrawn_at` · `channel` · `ip`.
- **data_requests:** `id` · `subject` · `type` (access, correction, erasure, grievance, nomination) · `received_at` · `due_by` · `status` · `response` · `handled_by`.
- **data_incidents:** `id` · `detected_at` · `description` · `data_categories` · `people_affected_estimate` · `contained_at` · `board_notified_at` · `principals_notified_at` · `root_cause` · `actions`.

**udin_records**, extra columns for the ceiling: `signed_on date NN` (the date the report was signed, not the date the UDIN was generated) · `generated_on date NN` · `report_form text` (3CA, 3CB_44AB_a, 3CB_44AB_b, 3CB_combined, 3CB_44AB_c, 3CB_44AB_d, 3CB_44AB_e, FORM_26, audit_report, certificate, gst_audit, other) · `is_revised bool NN = false` · `counts_towards_tax_audit_ceiling bool` (computed from report_form per §6.8).

### 5.13 WhatsApp groups, TaxWise Desktop and cover access (§4.7, §7.25)
**firm_whatsapp_numbers** (the firm's own WhatsApp numbers):
- `id` · `label text NN` (e.g. "CA Vinay H Karlagere (Partner)", "Managers' office", "Staff office") · `number text U` (normalised digits per §7.13.2; null while a seeded slot is unfilled) · `kind whatsapp_number_kind NN`
- `employee_id uuid FK→employees` (the Partner whose number it is; only they may use it in TaxWise Desktop) · `custodian_employee_id uuid FK→employees` (who keeps the phone)
- `in_every_client_group bool NN = true` · `group_admin bool NN = false` (true for Managers' office) · `shared bool NN = false` (true for the office numbers; staff sign their messages)
- `usable_by app_role[] NN` (who may open this number's panel in TaxWise Desktop). Defaults:
  - a Partner's number: `{partner}`, and only its owner;
  - Managers' office: `{partner, manager}`;
  - Staff office: `{partner, manager, employee}`.
- `two_step_verification_on bool NN = false` · `devices_reviewed_at timestamptz` · `is_active bool NN = false` · check: `is_active` implies `number is not null`.

**client_whatsapp_groups:**
- `id` · `client_id FK NN` · `name text NN` (from the name format in Settings; must contain the client code) · `purpose text` (e.g. "All work", "Statutory audit FY 2025-26") · `is_primary bool NN = true` (partial unique: one primary per client among groups not closed)
- `status whatsapp_group_status NN = 'to_create'` · `created_on date` · `created_by_number_id uuid FK→firm_whatsapp_numbers` · `invite_link text` (Partner/Manager only; TaxWise Desktop may use its code to open the group, §7.25.5)
- `checklist jsonb NN = '{}'` (each setup step in §7.25.2 → `{ done, by, at }`) · `last_opened_at timestamptz` · `last_opened_by uuid`
- `closed_at` · `closed_reason text` · `notes text` · `deleted_at`.
- View **client_whatsapp_groups_public:** every column except `invite_link`. Employees read groups only through this view.

**client_whatsapp_group_members:** `id` · `group_id FK NN` · `kind whatsapp_member_kind NN` · `firm_number_id uuid FK→firm_whatsapp_numbers` · `contact_id uuid FK→client_contacts` · `display_name text NN` · `number text` (normalised) · `is_admin bool NN = false` · `added_on date` · `removed_on date` · `source text NN = 'checklist'` (checklist, manual) · partial unique **U(group_id, number) where removed_on is null**.

**desktop_devices** (PCs running TaxWise Desktop, §7.25.7):
- `id` · `device_key text NN U` (random; generated at install and kept in the operating system's credential store) · `device_name text NN` (the PC name, editable by a Partner) · `os text` · `app_version text`
- `last_user_id uuid` · `last_seen_at timestamptz` · `revoked_at timestamptz` · `revoked_by uuid` (a revoked PC is refused by the desktop API and wipes its WhatsApp data at its next start).

**desktop_device_numbers** (which firm number is linked on which PC):
- `id` · `device_id FK→desktop_devices NN` · `number_id FK→firm_whatsapp_numbers NN` · `linked_at timestamptz NN` · `linked_by uuid NN` · `unlinked_at timestamptz`
- partial unique **U(device_id, number_id) where unlinked_at is null**.
- View **whatsapp_links_per_number:** active links per number, compared with `firm_settings.whatsapp_linked_device_limit`.

**client_covers** (§4.7):
- `id` · `kind cover_kind NN` · `client_id uuid FK→clients` · `absent_employee_id uuid FK→employees` · `cover_employee_id uuid FK→employees NN`
- `starts_at timestamptz NN = now()` · `ends_at timestamptz NN` · `reason cover_reason NN` · `note text` · `handover_note text` · `return_note text` · `include_vault bool NN = false` · `leave_id uuid FK→employee_leave`
- `granted_by uuid NN` · `revoked_at` · `revoked_by uuid` · `revoke_reason text` · `expiry_logged_at timestamptz` (set by the hourly job when it records the automatic end)
- **Checks:**
  - `ends_at > starts_at` and `ends_at <= starts_at + interval '90 days'`;
  - `cover_employee_id <> absent_employee_id`;
  - `kind = 'client'` ⇒ `client_id is not null`;
  - `kind = 'person'` ⇒ `absent_employee_id is not null and client_id is null`.
- Indexes on `(cover_employee_id, ends_at)`, `(absent_employee_id, ends_at)` and `client_id`.
- View **covers_in_force:** rows where `now() >= starts_at and now() < ends_at and revoked_at is null`.

---

## §6. Indian law, ICAI pronouncements and auditing standards (as at October 2026)

Everything in this section is **seed data and business rules**. Build it, test it, and keep every number in the §5.12 tables so the firm can update it without a code change.

Facts in this section are marked by how far they were checked:
- **No mark:** settled law.
- **[verify]:** checked against secondary sources only, or the sources disagreed. Seed the value with `verified = false` so the Law & rules page lists it as "awaiting partner confirmation".

### 6.1 Two income-tax statutes at once
- The **Income-tax Act, 2025** came into force on **1 April 2026** and replaces the Income-tax Act, 1961 for **tax years beginning on or after 1 April 2026**. The 1961 Act still governs **FY 2025-26 (AY 2026-27) and every earlier year**: returns, audits, notices, assessments and corrections for those years keep the old section and form numbers.
- **Terminology:** from tax year 2026-27 the 2025 Act uses **"tax year"** in place of "previous year" and "assessment year". Every income-tax record in the app stores `financial_year` (e.g. `2026-27`) plus a computed `statute` (1961 or 2025). Labels and PDFs show "AY 2026-27" for 1961-Act years and "Tax year 2026-27" for 2025-Act years.
- **Concordance seed** (`section_concordance`):

| Topic | 1961 Act | 2025 Act | Status |
|---|---|---|---|
| Tax audit | s.44AB · Form 3CA/3CB + 3CD | s.63 · **Form 26** (one form replaces 3CA/3CB/3CD) | [verify] |
| Rebate | s.87A | s.156 | [verify] |
| Interest for default in return / advance tax | ss.234A / 234B / 234C | ss.423 / 424 / 425 | [verify]; sources conflict |
| Return of income | s.139 | s.263 | [verify] |
| TDS (non-salary) | ss.194A–194T | **s.393** (one tabular section) | settled; table entry numbers [verify] |
| TDS certificates and statements | Form 16 · 16A · 24Q · 26Q · 27Q · 27EQ · 26AS | Form **130** · **131** · **138** · **140** · **144** · **143** · **168** | [verify] (Income-tax Rules, 2026) |

  Fill in the rest of the concordance from the CBDT's published mapping before go-live. Where the app cites a section in a PDF and the mapping is unverified, print the old section with "(corresponding provision of the Income-tax Act, 2025)".

### 6.2 Identifiers and validation (pure functions with unit tests)
- **GSTIN:** `^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$`. The 15th character is a **Luhn mod-36 check digit** over the first 14 characters, using the alphabet `0-9A-Z`; factor 1 on even positions and 2 on odd (0-based); add `floor(p/36) + p%36`; check = `(36 − sum%36) % 36`. Characters 1–2 are the state code (table below); characters 3–12 are the holder's PAN. Show the derived state and PAN as soon as a valid GSTIN is typed. TaxWise's own `29AAXFT1811B1Z3` passes.
- **State codes:**
  - 01 J&K · 02 Himachal Pradesh · 03 Punjab · 04 Chandigarh · 05 Uttarakhand · 06 Haryana · 07 Delhi · 08 Rajasthan · 09 Uttar Pradesh · 10 Bihar
  - 11 Sikkim · 12 Arunachal Pradesh · 13 Nagaland · 14 Manipur · 15 Mizoram · 16 Tripura · 17 Meghalaya · 18 Assam · 19 West Bengal · 20 Jharkhand
  - 21 Odisha · 22 Chhattisgarh · 23 Madhya Pradesh · 24 Gujarat · 25 Daman & Diu (legacy) · 26 Dadra & Nagar Haveli and Daman & Diu · 27 Maharashtra · 28 Andhra Pradesh (old) · 29 **Karnataka** · 30 Goa
  - 31 Lakshadweep · 32 Kerala · 33 Tamil Nadu · 34 Puducherry · 35 Andaman & Nicobar · 36 Telangana · 37 Andhra Pradesh · 38 Ladakh · 97 Other Territory · 99 Centre Jurisdiction
- **PAN:** `^[A-Z]{5}[0-9]{4}[A-Z]$`. The 4th character is the holder type: P Individual · C Company · H HUF · F Firm/LLP · A AOP · T Trust · B BOI · L Local authority · J Artificial juridical person · G Government. **Warn** (don't block) when it disagrees with the chosen entity type (e.g. entity "Private Limited" with a PAN whose 4th character isn't C).
- **TAN:** `^[A-Z]{4}[0-9]{5}[A-Z]$`. **IFSC:** `^[A-Z]{4}0[A-Z0-9]{6}$`; derive the bank name from the first four letters (a lookup table of major banks). **Pincode:** six digits, not starting with 0. **Indian mobile:** normalise to E.164 `91XXXXXXXXXX` (§7.13.2).
- **CIN:** 21 characters, `^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$`. **LLPIN:** `^[A-Z]{3}-[0-9]{4}$`. **DIN:** 8 digits.
- **UDIN:** 18 characters; store upper-case; unique. Format: 2-digit year, then the signing member's 6-digit membership number, then 10 alphanumeric characters. [verify] Warn when characters 3–8 don't match the signing partner's membership number.
- **Aadhaar:** never stored in full (§6.10). If a document needs it, keep only the last 4 digits as text, and keep the copy in the confidential document vault.

### 6.3 Financial year, dates and money
- FY = 1 April – 31 March; label `YYYY-YY` (e.g. `2026-27`). `financialYearOf(date)` uses IST. Quarters: Q1 Apr–Jun, Q2 Jul–Sep, Q3 Oct–Dec, Q4 Jan–Mar.
- **Indian number formatting:** lakh/crore grouping (`12,34,56,789.00`). Amount in words in the Indian system ("Rupees Twelve Lakh Thirty-Four Thousand … and Fifty Paise Only").
- **Rounding:** compute in paise; round half-up at the line; totals are sums of rounded lines. An invoice may carry a round-off line of at most ±₹0.99 to reach whole rupees (optional setting).
- Due dates that land on a Sunday or a gazetted holiday are **not** moved automatically (statutory dates generally aren't). Show "falls on a Sunday" as a hint instead.

### 6.4 GST on TaxWise's own invoices
- **Rate:** professional, accounting, auditing and tax services (SAC group **9982**) are at **18%**. Since **22 September 2025** the GST slab structure is **0% / 5% / 18% / 40%**; the 12% and 28% slabs were removed. The invoice rate picker offers 18% (default), 5%, 0% / exempt, and "other" with a reason. Old invoices keep the rate they were issued at. [verify the SAC-level rate against the current CBIC rate notification]
- **SAC by service** (editable map in Settings; confirm with the partners): audit/assurance **998221** · accounting & bookkeeping **998222** · corporate tax consulting & preparation **998231** · individual tax preparation **998232** · other/general **9982**. Up to ₹5 crore aggregate turnover, a 4-digit SAC on the invoice is enough; above that, 6 digits.
- **Place of supply:** the recipient's state (from the client's GSTIN, otherwise the client's state code, otherwise Karnataka for an unregistered local client).
  - **Same state as TaxWise (29)** → CGST 9% + SGST 9%; `cgst = round(tax/2, 2)`, `sgst = tax − cgst` (so the two always add up exactly).
  - **Different state** → IGST 18% on the full amount.
- **Reimbursements** of expenses incurred as a *pure agent* (Rule 33 of the CGST Rules, e.g. government fees paid on the client's behalf) are separate invoice lines with `is_reimbursement = true`, no GST, and excluded from the taxable value. The line must say it's a reimbursement.
- **Invoice contents (Rule 46)**, all mandatory on the PDF:
  - **Supplier:** name, address and GSTIN.
  - **Number and date:** a serial number unique for the FY, **≤16 characters**, using only letters, digits, `-` and `/`; the invoice date.
  - **Recipient:** name and address; GSTIN if registered; for unregistered recipients where the invoice value exceeds ₹50,000, the recipient's address and state.
  - **Place of supply:** state name and code.
  - **Lines:** SAC and description; taxable value; rate and amount of CGST/SGST or IGST; total value.
  - **Other:** whether tax is payable on reverse charge ("No"); signature or digital signature of an authorised signatory (the Partner's name and "Authorised Signatory"; an uploaded signature image is optional).
- **When to invoice:** a tax invoice for a service must be issued **within 30 days of supplying it** (Rule 47). The app flags completed, billable work with no invoice after 25 days.
- **E-invoicing** applies only above ₹5 crore aggregate turnover (in which case IRPs require reporting within 30 days where turnover is ₹10 crore or more). Keep optional fields `irn`, `irn_ack_no`, `irn_ack_date` and `signed_qr` on invoices, hidden unless Settings → "E-invoicing applies" is on.
- **Credit notes (s.34 CGST Act):** a credit note that reduces tax must be issued **no later than 30 November following the end of the FY in which the supply was made, or the date of filing the annual return for that FY, whichever is earlier.** The app computes the deadline per invoice, warns from 30 days before it, and refuses a tax-reducing credit note after it. A commercial (non-GST) credit is still allowed, with a clear notice. Credit notes carry their own series and appear in GSTR-1 data exports.
- **Unregistered clients (B2C):** if `gst_registration = registered` but the GSTIN is missing, block the invoice and say why: an invoice without the recipient's GSTIN costs a registered client their input tax credit.

### 6.5 TDS deducted by clients on TaxWise's fees
- **What the client deducts:** under the **2025 Act (payments from 1 April 2026)** non-salary TDS sits in **s.393** (a tabular section). Seed these rates:
  - **Professional fees:** **10%** above an annual **₹50,000** threshold.
  - **Technical services:** **2%**.
  - **Commission/brokerage:** **2%** above ₹20,000.
  - **Rent:** **10%** on land/building and **2%** on plant/machinery, above ₹50,000 a month.
  - **Contract work:** 1% individuals/HUF, 2% others.
  
  [verify table entry numbers and thresholds against s.393]. For payments **up to 31 March 2026** the 1961 sections apply: 194J (10% professional / 2% technical; ₹50,000 threshold from 1 April 2025), 194C (1%/2%), 194H (2% from 1 October 2024), 194I (2%/10%).
- **Base:** TDS applies to the fee **excluding GST** when GST is shown separately on the invoice (CBDT Circular 23/2017). When recording a receipt, the app suggests `expected TDS = taxable value × rate` and shows any difference from what the client actually deducted.
- **Settlement:** `outstanding = total − amount_received − tds_credited − credit_noted`. A receipt may be settled wholly or partly by TDS. TDS credits are tracked until they appear in the firm's **Form 26AS** (1961 Act years) / **Form 168** Annual Information Statement (2025 Act years). The TDS credit screen (§7.9.9) lists unmatched credits by client and quarter.

### 6.6 Scale-driven decisions about a client
- **GST filing scheme:** aggregate turnover **≤ ₹5 crore** is eligible for **QRMP** (quarterly GSTR-1 and GSTR-3B, monthly PMT-06); above that, monthly is mandatory. With no turnover recorded, default to monthly, because over-filing is safer than a missed return. A client below the threshold may opt for monthly; record the choice.
- **QRMP GSTR-3B due day** depends on the principal place of business:
  - **22nd** for 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37.
  - **24th** for every other state code.
  - Karnataka (29) → **22nd**.
- **Tax audit indication** (s.44AB / s.63). This is an *indication* for the partner to confirm, never a determination:
  - **Business:** audit if turnover > **₹1 crore**. The limit is **₹10 crore** where cash receipts **and** cash payments are each ≤ 5% of the total. Ask the cash-ratio question when turnover is between ₹1 crore and ₹10 crore.
  - **Profession:** audit if gross receipts > **₹50 lakh**. A professional eligible for the presumptive scheme (s.44ADA: receipts up to ₹75 lakh with cash receipts ≤ 5%) who declares at least 50% as income needs no audit.
  - **Presumptive business (s.44AD):** turnover up to ₹2 crore, or ₹3 crore where cash receipts ≤ 5%. Declaring below 6%/8%, with income above the basic exemption, triggers an audit.
  - Show the reasoning in plain words and keep the partner's decision on the client (`tax_audit_applicable: yes/no/review`, with a note).

### 6.7 Statutory calendar (seed for `due_date_rules`)
Generate events per client from their active services, entity type, scheme and audit status. Generated events are **idempotent** (`dedupe_key`), cover the **next 13 months** for monthly cadences and the **current and next FY** for annual ones, and a monthly job tops them up. Show the legal source on each event.

**GST**
| Return | Due | Who |
|---|---|---|
| GSTR-1 | 11th of next month | monthly filers |
| IFF (optional, months 1–2 of quarter) | 13th of next month | QRMP |
| GSTR-1 | 13th after quarter end | QRMP |
| GSTR-3B | 20th of next month | monthly filers |
| GSTR-3B | 22nd / 24th after quarter end (by state, §6.6) | QRMP |
| PMT-06 (tax payment) | 25th of next month, for months 1–2 of the quarter | QRMP |
| CMP-08 | 18th after quarter end | composition |
| GSTR-4 | 30 April after FY end | composition |
| GSTR-7 / GSTR-8 | 10th of next month | TDS/TCS deductors under GST |
| GSTR-9 (annual return) | 31 December after FY end | mandatory above ₹2 crore turnover [verify the optional-filing exemption for the year] |
| GSTR-9C (reconciliation statement) | 31 December after FY end | above ₹5 crore turnover |

GST portal behaviour the workflow must respect:
- From the **July 2025** tax period, the liability auto-populated in GSTR-3B from GSTR-1/1A/IFF is **hard-locked** (not editable in 3B; corrections go through **GSTR-1A**, filed once per period; Table 3.2 locking deferred) [verify current status]. The GSTR-3B task checklist therefore includes "Review auto-populated liability; correct through GSTR-1A *before* filing 3B".
- Returns **cannot be filed after three years** from their due date (reported effective from the July 2025 period) [verify]. The app flags any unfiled return within 6 months of that bar in red.
- **Invoice Management System (IMS):** the recipient accepts, rejects or keeps pending each inward invoice. Inaction counts as deemed acceptance, and GSTR-2B is regenerated after IMS actions. GST reconciliation (§7.8.1) outputs an IMS action list.

**Income tax: FY 2025-26 / AY 2026-27 (1961 Act)**
| Item | Due |
|---|---|
| ITR-1 / ITR-2 (non-audit) | **31 July 2026** |
| ITR-3 / ITR-4 (non-audit business/profession, incl. partners of non-audited firms) | **31 August 2026** (moved by Finance Act 2026, and reported as permanent) [verify] |
| Tax audit report (3CA/3CB-3CD) | 30 September 2026 → **extended to 21 October 2026** (CBDT Circular 07/2026, 28 Sep 2026) |
| ITR for audit cases | 31 October 2026 → **extended to 21 November 2026** (same circular) |
| Transfer-pricing report (Form 3CEB) / ITR for TP cases | 31 October 2026 / 30 November 2026 |
| Belated return | 31 December 2026 |
| Revised return | up to 12 months from the end of the tax year, with a fee after 9 months (Finance Act 2026) [verify] |
| Updated return (ITR-U) | up to 48 months from the end of the relevant assessment year, with additional tax |

The two extensions are seed rows in `due_date_overrides`. Each later year's dates come from `due_date_rules`; the firm adds that year's overrides as circulars are issued.

**Income tax: all years**
| Item | Due |
|---|---|
| Advance tax | 15 June (15%) · 15 September (45%) · 15 December (75%) · 15 March (100%). Presumptive 44AD/44ADA: 100% by 15 March |
| TDS/TCS deposit | 7th of the next month; **March → 30 April** |
| TDS statements (24Q/26Q/27Q → Forms 138/140/144 from tax year 2026-27) | Q1 31 July · Q2 31 October · Q3 31 January · Q4 31 May |
| TDS certificates | Form 16 / Form 130 by 15 June; Form 16A / Form 131 within 15 days of the statement due date |

**Companies Act 2013 and LLP Act 2008 (MCA V3)**
| Item | Due |
|---|---|
| AGM | within 6 months of FY end (30 September for a March year-end) |
| **ADT-1** (auditor appointment) | within **15 days of the AGM** |
| **AOC-4** (financial statements) | within **30 days of the AGM**; OPC: within 180 days of FY end |
| **MGT-7 / MGT-7A** (annual return) | within **60 days of the AGM** |
| DPT-3 | 30 June |
| MSME-1 (half-yearly) | 30 April and 31 October |
| **DIR-3 KYC Web** | **once every three financial years, by 30 June** (G.S.R. 943(E) of 31 Dec 2025, in force from 31 March 2026). Changes to a director's mobile, email or address must be filed within 30 days and don't reset the cycle. Track the next due year per DIN in `statutory_registrations` (type DIN). |
| LLP Form 11 (annual return) | 30 May |
| LLP Form 8 (accounts & solvency) | 30 October |
| Late fee | ₹100 per day per form on most forms. Show it accruing on overdue ROC events. |

AGM-linked dates are generated once the AGM date is entered on the client's ROC event (until then they show provisional dates based on 30 September).

**Labour and state**
- PF and ESIC: 15th of the next month.
- **Karnataka Professional Tax:** monthly employer remittance by the 20th of the next month; annual enrolment payment by 30 April [verify].
- Other states: add rules as needed (`applies_to.state`).

### 6.8 ICAI practice rules the app must enforce or support
- **UDIN** is required for every certificate, GST/tax audit report and audit report signed by a member. It must be generated **within 60 days of signing** (ICAI Council decision, 17 Sep 2021), or immediately if a regulator asks. The UDIN register links each UDIN to the filing and the signing partner. The dashboard lists signed documents with no UDIN, with the days left.
- **Tax audit ceiling** (Chartered Accountants (Limit on Number of Tax Audits) Guidelines, 2025; **in force from 1 April 2026**; enforced on the UDIN portal): **60 tax audit reports per member per financial year**, counted by the **date the report was signed**.
  - **Counted:** Form 3CA, and Form 3CB under s.44AB(a), s.44AB(b) and "combined".
  - **Not counted:** Form 3CB under s.44AB(c), (d) and (e). Under the 2025 Act the equivalent categories apply to Form 26 [verify mapping].
  - **Other rules:** audits in individual capacity and across firms are aggregated; head office and branch audits of the same assessee for the same year count as one; revised reports don't count separately.
  - **The app:** shows each Partner's running count, warns at 50 and 58, and requires a Partner's confirmation to log a 61st. The per-member count includes an "audits signed elsewhere" number the partner enters, since other firms' audits count too.
- **Company audit limit:** no more than **20 company audits per partner** (Companies Act s.141(3)(g); excludes OPCs, small companies, dormant companies, and private companies with paid-up capital under ₹100 crore). Warn when a Partner is engaging partner on the 18th+ countable audit.
- **KYC Norms** (mandatory for all attest engagements since 1 January 2017): before an audit or certification engagement can move past *acceptance*, `client_kyc` must be complete for the client's category:
  - **Individual/proprietor:** name, PAN, business description, last audited financial statements, engagement type.
  - **Corporate:** additionally PAN and CIN, and each director's name, address and DIN.
  - **Non-corporate:** each partner's/trustee's name, address and PAN or DIN.
  
  Re-confirm annually.
- **Communication with the previous auditor** (Clause 8, Part I, First Schedule, CA Act 1949): for an audit where another CA held the position, the engagement can't reach *planning* until a `previous_auditor_communications` record exists with proof of delivery. Record the reply or its absence.
- **Engagement letters (SA 210):** an audit can't move past acceptance without an engagement letter at **Issued**. Non-audit services get an engagement letter per FY (§7.15.3).
- **Quality control:** **SQC 1 continues to apply.** ICAI issued SQM 1 and SQM 2 on 14 Oct 2024, effective 1 April 2026, but **deferred them on 31 March 2026 "until further announcement"**. Build the quality module (§7.15.4) around SQC 1's elements (leadership, ethics/independence, acceptance & continuance, human resources, engagement performance incl. review and consultation, monitoring), with a switch so the firm can adopt SQM 1's risk-assessment approach when it takes effect.
- **Peer review** (Peer Review Guidelines 2022, effective 1 Oct 2022): record each review (period, reviewer, certificate number, validity) [verify the validity period]. Before accepting a statutory audit of an entity that needs a peer-reviewed auditor (listed entities; large unlisted public companies; public-interest entities, under the phased mandate), check that the certificate is valid on the acceptance date. Warn 90 days before expiry.
- **Retention:** every document gets `retention_until` from the longest rule that applies:
  - Engagement documentation / working papers: **at least 7 years from the date of the auditor's report** (SQC 1).
  - A company's books held by the firm: **8 financial years** (Companies Act s.128(5)).
  - GST records: **72 months from the due date of the annual return** for that year (CGST Act s.36).
  - Income-tax records for professionals and businesses: the period the income-tax rules prescribe (6 years from the end of the relevant assessment year under the 1961 Rules) [verify the 2026 Rules].
  
  Purging before `retention_until` is blocked; after it, the document goes on a "review for disposal" list. Documents are never deleted automatically.
- **Fees and ethics:** a member in practice may not charge fees based on a percentage of profits or contingent on the findings or results of the work (CA Act, First Schedule Part I, Clause 10, with the narrow exceptions the Council permits). Independence is required for attest work. The engagement acceptance form asks the independence questions (financial interest, relationships, other services to an audit client, fee dependence) and records the answers. Quotations and engagement letters have no "success fee" line type.
- **Confidentiality:** a member in practice may not disclose information acquired in a professional engagement to anyone other than the client, without the client's consent or other than as a law requires (CA Act, Second Schedule, Part I, Clause (1)). The access rules, the logged views of sensitive records and client mode in TaxWise Desktop (§7.25.5) all follow from this.

### 6.9 Audit engagements to the Standards on Auditing
Run every audit (`audit_engagements`) through these stages. Each stage is a checklist with required evidence, preparer and reviewer sign-off, and the engagement partner's approval to move on:

1. **Acceptance and continuance:** KYC (§6.8); independence and conflict check (`client_acceptances`); previous-auditor communication; peer review certificate check where required; company-audit / tax-audit ceiling check; **engagement letter, SA 210**.
2. **Planning:** overall audit strategy and plan (**SA 300**); **materiality** (**SA 320**): basis (e.g. % of revenue, profit before tax or total assets), overall, performance and clearly-trivial amounts, stored on the engagement; team briefing.
3. **Risk assessment:** understanding the entity and its environment, significant risks, fraud risk (**SA 315, SA 240**); laws and regulations (**SA 250**); related parties (**SA 550**).
4. **Execution:** responses to assessed risks (**SA 330**); evidence (**SA 500**); external confirmations (**SA 505**); analytical procedures (**SA 520**); sampling (**SA 530**); estimates (**SA 540**). Working papers are uploaded to the vault and tagged to the step.
5. **Completion:** evaluation of misstatements (**SA 450**); subsequent events (**SA 560**); going concern (**SA 570**); **written representations (SA 580)**, with a management representation letter template; communication with those charged with governance (**SA 260/265**).
6. **Reporting:** opinion type (**SA 700/705**); key audit matters where applicable (**SA 701**); emphasis of matter / other matter (**SA 706**); **CARO 2020** applicability check for companies (not for small companies, OPCs, banking, insurance or Section 8 companies, using the small-company limits in force for the year [verify the limits as amended w.e.f. 1 Dec 2025]); tax audit reports in Form 3CA/3CB-3CD (AY up to 2026-27) or Form 26 (tax year 2026-27 onward); **UDIN within 60 days of signing**.
7. **Archive:** **assemble the final audit file within 60 days of the report date (SA 230)**. On "Archive", the engagement and its documents become read-only, with any later addition logged as an amendment. Retain until report date + 7 years.

Ship **job templates** for: Statutory audit (Companies Act), Tax audit, GST audit/reconciliation, Internal audit, Bank branch audit, Certification (net worth, turnover, 15CB). Each is pre-loaded with the stage checklists above.

### 6.10 Personal data: DPDP Act 2023 and DPDP Rules 2025
The **DPDP Rules, 2025** were notified in **November 2025**. Most Data Fiduciary obligations phase in over about **18 months (to around May 2027)**; sources differ on which fall at 12 months [verify the dates]. TaxWise is a **Data Fiduciary** for the personal data of clients' individuals, portal users, leads and staff. Build compliance in now:
- **Notice:** an itemised privacy notice (what data, why, how long, rights, how to complain, grievance contact). It is shown when a client portal account is first used and when a lead is captured through any form, versioned in `privacy_notices`, with the acknowledgement stored in `consent_records`.
- **Purpose and retention:** each data category has a purpose and a retention rule. Statutory retention (tax, audit, §6.8) overrides erasure requests: tell the requester what is retained and why.
- **Rights:** `data_requests` handles access, correction, erasure, grievance and nomination, with due dates and status; staff see them in the Inbox.
- **Security safeguards:** encryption in transit and at rest; the credential vault (AES-256-GCM); RLS; least-privilege roles; audit logging; signed URLs; backups; access reviews every quarter (a Partner reviews who has which role and vault access).
- **Breach response:** `data_incidents` records an incident and drives a checklist: contain; assess; notify the **Data Protection Board** and the **affected people** within the time the Rules require [verify, reported as 72 hours for the Board's detailed report]; record the root cause.
- **Data minimisation:** never store full Aadhaar numbers, card numbers or bank passwords. Only portal credentials the client authorises go in the vault (the authorisation letter is a checklist item).

### 6.11 Income tax computation engine (individuals and HUF; both regimes, side by side)
Implement as a pure function `computeItr(inputs, ruleSet)`, with rule sets keyed by financial year and stored as parameters:

**Rule set: FY 2025-26 and tax year 2026-27** (the 2026 Budget left slabs unchanged)
- **New regime (default):** slabs 0–4 L nil · 4–8 L 5% · 8–12 L 10% · 12–16 L 15% · 16–20 L 20% · 20–24 L 25% · above 24 L 30%. Rebate up to **₹60,000** where total income ≤ **₹12 lakh**, with marginal relief just above ₹12 lakh; the rebate never applies to special-rate income. Standard deduction ₹75,000 (salary/pension). Only employer NPS (80CCD(2)) and a few others are allowed.
- **Old regime (optional):** basic exemption ₹2.5 lakh (₹3 lakh at 60–79, ₹5 lakh at 80+); slabs 5% to 5 L, 20% to 10 L, 30% above. Rebate up to ₹12,500 where total income ≤ ₹5 lakh. Standard deduction ₹50,000. Chapter VI-A: 80C/80CCC/80CCD(1) up to ₹1.5 lakh; 80CCD(1B) ₹50,000; 80D; 80G; 80TTA/80TTB; others; house-property loss set-off capped at ₹2 lakh.

**Rule set: FY 2024-25** (for belated/revised work): new regime 0–3 L nil · 3–7 L 5% · 7–10 L 10% · 10–12 L 15% · 12–15 L 20% · above 15 L 30%; rebate up to ₹25,000 where income ≤ ₹7 lakh; standard deduction ₹75,000.

**Both regimes, all years**
- **Capital gains:** STCG on listed equity (111A) 20%; LTCG on listed equity (112A) 12.5% above ₹1.25 lakh; other LTCG (112) 12.5% (rates for transfers from 23 July 2024; earlier transfers use the earlier rates).
- **Surcharge:** 10% above ₹50 L, 15% above ₹1 Cr, 25% above ₹2 Cr, 37% above ₹5 Cr (**old regime only**; the new regime caps at 25%). Capital-gains surcharge capped at 15%. Marginal relief at each threshold.
- **Cess and interest:** health & education cess 4%. Interest for late filing, advance-tax shortfall and deferment at **1% per month** under 234A/234B/234C (2025 Act: ss.423–425 [verify]), with the 12%/36% safe harbours for 234C.
- **Output:** a computation sheet with every line explained, the regime comparison, the saving, and the recommended regime. Saved as `itr_computations`; exported to PDF on letterhead. Results are always recomputed on the server.

### 6.12 GST reconciliation engine (GSTR-2B / IMS ↔ purchase register)
- **Inputs:** the GSTR-2B JSON downloaded from the portal (parse B2B, B2BA, CDNR, CDNRA, ISD, IMPG sections), and the client's purchase register as CSV/XLSX through a **column-mapping step** (map supplier GSTIN, supplier name, document type, number, date, taxable value, IGST, CGST, SGST, cess). Save the mapping per client for next time.
- **Matching, per supplier GSTIN, in three tiers:**
  1. **Exact:** trimmed, upper-cased document number.
  2. **Loose:** alphanumeric only, numeric runs de-zero-padded (`INV/007` ≡ `inv-7`).
  3. **Fuzzy:** same supplier, taxable value within ±₹1 or 0.5%, dates within 5 days.
- **Results:** a matched pair within **₹1** on every tax head → *Matched*; otherwise *Mismatch*, with signed deltas per head. Leftovers: **in 2B but not in books** (unclaimed ITC: book it or reject it in IMS) and **in books but not in 2B** (ITC at risk: supplier hasn't filed; follow up). Check that the 2B file's GSTIN equals the client's GSTIN and warn otherwise.
- **Outputs:** a summary (counts and values per bucket; ITC available, at risk and unclaimed); a **supplier roll-up** (whom to chase); an **IMS action list** (accept / reject / keep pending, with reasons); Excel export; a "message supplier" draft (§7.13). Runs are saved per client and period, and the next month shows what carried forward.

### 6.13 Financial statements engine (Schedule III, Division I)
- **Input:** a trial balance (CSV/XLSX: ledger name, group, debit, credit) through a mapping step.
- **Buckets** (each ledger maps to exactly one):
  - **Equity and liabilities:** Share/partners'/proprietor's capital · Reserves and surplus · Long-term borrowings · Long-term provisions · Short-term borrowings · Trade payables · Other current liabilities · Short-term provisions.
  - **Assets:** Property, plant and equipment · Intangible assets · Non-current investments · Long-term loans and advances · Inventories · Trade receivables · Cash and bank balances · Short-term loans and advances · Other current assets.
  - **Profit and loss:** Revenue from operations · Other income · Changes in inventories (opening stock) · Purchases · Direct expenses · Employee benefits expense · Finance costs · Depreciation and amortisation · Other expenses.
- **Auto-classification:** keyword rules first (e.g. "interest received"/"dividend"/"rent received" → Other income; "sales"/"professional fee"/"consultancy" → Revenue; "opening stock" → Changes in inventories; "purchase" → Purchases; "depreciation"/"amortis" → Depreciation), then the TB group, then "unmapped" for a human. The user can re-map any ledger; mappings are remembered per client.
- **Checks shown prominently:** TB totals agree (debits = credits); balance sheet balances; every ledger mapped; profit in the P&L equals the movement in reserves/capital. Also: **trade receivables and payables ageing schedules** and **MSME dues** disclosure inputs (Schedule III as amended in 2021).
- **Output:** P&L and balance sheet in Schedule III format with previous-year comparatives (from last year's saved statement), and notes stubs. Export to PDF and Excel. Saved per client and FY.

---

## §7. Modules: screens, fields, actions and rules

Fields are listed as **Label** (type) · required? · validation · default · notes. Every form uses the patterns in §3.4.

### 7.1 Sign-in, first run, profile
- **Screens:** `/login`, `/forgot-password`, `/reset-password`, `/set-password` (forced for temporary passwords), and `/setup` (first run only). See §3.5 and §4.3–4.4.
- **Profile** (every user): name, phone, avatar, theme, density, notification preferences per event and channel (in-app always on; email optional), change password (current, new, confirm, with the policy checklist), active sessions (device, last seen, "sign out other sessions").
- Partners additionally hold their ICAI membership number and signature image (optional, used on PDFs).

### 7.2 Dashboards (role-specific; every tile links to the filtered list behind it)
**Partner: "Firm today"**
- **Setup checklist** (shown until complete): logo · bank & UPI · ICAI FRN and membership numbers · email domain verified · firm WhatsApp numbers · team added · first client onboarded · first invoice issued · law & rules reviewed.
- **KPI tiles:** active clients · fees invoiced this FY · collected this month · outstanding · overdue receivables (amount and count) · filings due in 7 days · overdue tasks · team online now · unbilled time (₹).
- **Approvals:** invoices awaiting approval · quotations pending approval · leave requests · data requests (DPDP).
- **Practice health:**
  - signed reports without a UDIN (days left of 60);
  - each Partner's tax-audit count against the 60 ceiling;
  - engagement letters expiring or missing;
  - DSCs and registrations expiring in 30 days;
  - peer review validity;
  - audit files whose 60-day assembly date is near;
  - clients with no WhatsApp group, and PCs linked per firm number against WhatsApp's limit (§7.25.7).
- **Charts:** fees invoiced vs collected by month (FY); filing status by return type for the current period (stacked bar); receivables ageing (0–30 / 31–60 / 61–90 / 90+ days).
- **Lists:** this week's deadlines · review queue · at-risk clients (3+ overdue tasks, or receivables over 90 days) · pipeline (open leads, quotations sent and their value, conversion rate this FY) · recent activity.

**Manager: "Team today"**
- Unassigned tasks.
- Tasks waiting for acceptance.
- Declined tasks to reassign.
- Review queue.
- **Data awaited** (the call list: client, task, days waiting, contact person, WhatsApp/call buttons).
- Deadlines this week.
- Overdue tasks by person.
- Team capacity (CLEAR/BUSY/TIGHT/OVER per person, §7.11.4).
- Attendance today (present, late, absent, on leave, online now).
- **Absent today without cover:** people on leave or not signed in, whose clients have tasks due within 2 days and no cover in force, each with **Set up cover** (§4.7).
- Invoices raised this month.
- Quotations awaiting response.

**Employee: "My day"**
- **Timer** (start/stop on a task).
- Waiting for my acceptance (Accept / Decline buttons inline).
- **Sent back to me** (with the reviewer's reason).
- Due today and overdue.
- My review items (if I'm a reviewer).
- This week's hours vs target.
- My clients' upcoming deadlines.
- My leave.
- **Covering:** the clients I'm covering, for whom, until when, with the handover notes (§4.7).
- Unread messages from clients I handle.

### 7.3 Clients
#### 7.3.1 Client list
- **Columns:** code, name (with entity badge), PAN, GSTIN, status, priority, owner, group, services (chips), next deadline, open tasks, outstanding ₹ (Partner/Manager only), last contact, portal (yes/no), WhatsApp group (optional column: none / to create / active).
- **Filters:** status, priority, owner, service, entity type, GST registration (registered / unregistered / unknown / missing GSTIN), scheme (monthly/QRMP), group, onboarded within (30/90/365 days), has overdue tasks, has overdue invoices, unreachable (no email and no phone), WhatsApp group status, covered now.
- **Row actions:** open; WhatsApp (§7.13.2); email; new task; new invoice (Partner/Manager).
- **Bulk actions:** assign owner, add to group, change status, export.
- **Banner:** "N clients can't be reached: no email or phone". Opens that filter.

#### 7.3.2 Add client: five-step wizard (full-screen dialog; sticky footer with Back · Save draft · Continue / Complete)
Steps unlock in order. Each step shows a ✓ when valid. The draft autosaves.

**Step 1: Basic information**
- **Identity**
  - **Display name**\* (text, 2–120).
  - **Legal / registered name** (text).
  - **Client code**\* (auto-suggested `TW-C-0001`; editable; unique).
  - **Entity type**\* (Sole proprietorship · Partnership firm · LLP · Private limited company · Public company · Section 8 company · Trust · AOP · HUF · Individual · Others → **Specify**\* text).
  - **Already incorporated/registered?** (toggle, default Yes; "No" suggests the Incorporation service in step 2).
  - **Date of birth / incorporation** (date; for individuals it sets the ITR age band).
- **Tax registrations**
  - **PAN** (upper-cased; validated; warns on holder-type mismatch, §6.2).
  - **GST registration**\* (Registered · Not registered · Not sure yet).
  - **GSTIN** (required if Registered; checksum-validated; must contain the PAN; auto-fills the state and the PAN if empty).
  - **State (place of supply)** (auto from GSTIN; otherwise select from the state list).
  - **TAN** (shown when TDS is likely; validated).
- **Contact**
  - **Primary email** (validated), **Phone** (Indian mobile/landline), **WhatsApp** (with a "same as phone" toggle).
  - **Address**, **City**, **Pincode** (6 digits).
- **Scale**
  - **Financial year ends in** (month; default March).
  - **Annual turnover (₹)** + **Turnover for FY** (select from the last 3 FYs).
  - **GST filing scheme** (Auto from turnover · Monthly · QRMP), with a live line explaining the decision (§6.6).
  - A **tax audit indication** card (§6.6) appears once turnover is entered.
- **Notes** (textarea).
- **Duplicate guard:** on PAN, GSTIN or a close name match with an existing (or recycled) client, show "This looks like **X** (TW-C-0042)". Options: **Open existing** · **Continue anyway** (Partner/Manager, with a reason).
- **Conflict check** (optional button, mandatory for audit services): runs `client_acceptances` against existing clients, leads and related parties, and shows matches.

**Step 2: Services** (selectable cards with a one-line description each)
- GST returns · Income tax · TDS/TCS · Payroll (PF/ESIC/PT) · Bookkeeping · Audit (statutory/tax/GST/internal) · ROC/Company law · Incorporation · Other (**name**\*).
- Selecting **Audit** adds the KYC and previous-auditor steps to the client's acceptance checklist.

**Step 3: Configure services and team**, per selected service (one collapsible panel each):
- **Filing frequency**\* (Monthly · Quarterly · Annual · One-time). GST follows the scheme and is locked with an explanation.
- **Next due date** (auto from the statutory calendar; editable).
- **Agreed fee (₹, excl. GST)** per billing occurrence (Partner/Manager only; hidden for Employees).
- **Billing frequency** (default = filing frequency).
- **Raise invoices automatically** (toggle; off by default) + **first billing date**.
- **SAC override** (optional).

Then **Client owner**\* (employee), **Engagement team** (engagement partner, review manager, preparers) and **Priority** (default Medium).

**Step 4: Document checklist**
- Always: **Engagement letter**, **Client authorisation letter** (plus **Portal credentials authorisation** when GST/IT/TDS are selected).
- Suggestions per service (pre-ticked, removable):
  - **GST:** GST registration certificate, last 3 returns, sales and purchase registers.
  - **Income tax:** PAN copy, last ITR and computation, Form 26AS/AIS access, bank statements.
  - **TDS:** TAN allotment, challans, deductee master.
  - **Audit:** previous audited financial statements, trial balance, fixed asset register, bank confirmations, previous-auditor NOC.
  - **ROC:** certificate of incorporation, MOA/AOA, directors' KYC, statutory registers.
  - **Payroll:** employee master, PF/ESIC registrations, PT registration.
  - **Bookkeeping:** bank statements, invoices and bills, opening balances.
- **Add custom item.**
- Mark items already **collected**, and optionally attach the file there and then.
- **"I've reviewed this checklist"**\* (checkbox).

**Step 5: Compliance setup and review**
- **Reminder lead time** (days, default 7, 1–60).
- **Notify the client by:** Email · WhatsApp (hand-off) · Portal, with defaults from Settings.
- **Preview of generated deadlines** for the next 12 months (list grouped by month), with the source of each date.
- **Invite to the client portal now** (toggle; needs an email).
- A **summary** of everything entered, with "Edit" links back to each step.
- **Complete onboarding** opens a confirm dialog, then in one transaction:
  - creates the client, its services, primary contact, team, checklist, compliance events, initial tasks ("Collect documents for <service>", due in 14 days, assigned to the owner, acceptance pending) and the KYC record shell;
  - writes timeline and audit entries;
  - marks the source lead or quotation as converted.
  
  **After** the commit (never failing it): notify the owner and team, send the welcome email (if enabled) and the portal invite, and put **Set up the WhatsApp group** (§7.25.2) on the success screen and on the engagement partner's to-do list. Any failure there shows as a warning ("Client created. Compliance dates couldn't be generated. Use 'Generate deadlines' on the Compliance tab."), never as an error.
- **From a quotation:** the wizard opens pre-filled from the lead and quotation (name, email, phone, company, GSTIN, services with frequency and agreed fee per line). The services step is locked ("these are the services the client accepted; raise a revised quotation to change them").

#### 7.3.3 Client 360 (detail page)
- **Header:** name, code, entity, status chip, priority, owner, group; PAN/GSTIN/TAN with copy buttons; contact buttons (Call · WhatsApp · Email · Gmail); a **Covering** chip while a cover is in force (§4.7).
- **Quick actions:** New task · Apply job template · Request documents · New invoice* · New quotation* · Log a call/note · Generate deadlines.
- **Warnings strip:** no email/phone; registered but GSTIN missing; KYC incomplete (for audit clients); engagement letter missing for this FY; DSC expiring; portal invite pending.

Tabs (`*` = Partner/Manager only):
1. **Overview:** key facts and dates; open tasks, overdue, next deadline; outstanding ₹*; last contact; tax-audit indication and the partner's decision; portal access card (invite / resend / revoke / last seen); the client's latest messages; WhatsApp group status and when it was last opened.
2. **Profile & contacts:**
   - Master data (edit form = step 1 fields).
   - **Contacts:** name\*, role (Director · CFO · Authorised signatory · Accountant · Promoter · Other), email, phone, WhatsApp, **handles** (which services they answer for, so reminders go to the right person), primary (exactly one), notes.
   - **Team:** engagement partner, review manager, preparers; covers in force and scheduled, with **Add cover**, **Extend** and **End now** (§4.7).
   - **Group.**
   - **KYC** (§6.8; required for attest clients).
3. **Services & fees\*:** each engagement with frequency, next due, agreed fee, billing frequency, SAC, auto-invoice toggle, next billing date and a **preview of the next invoice**; fee history; add, end or re-price a service (re-pricing records `fee_agreed_at`).
4. **Tasks:** the client's tasks (table/board), new task, apply job template.
5. **Compliance:** the client's calendar (list by month) and status per period; **Generate deadlines** (idempotent); coverage gaps ("GST service active but no GSTR-3B events after Dec 2026"); **compliance report PDF** (deadlines met and missed over a period, for sending to the client).
6. **Documents:** vault (folders by category and FY), document requests (PBC lists), checklist.
7. **Workpapers:** this client's GST reconciliation runs, ITR computations, financial statements, notices.
8. **Registers:** portal credentials (vault), registrations, DSCs, UDINs, filing history (incl. "Import prior filings" from a previous CA via CSV).
9. **Billing\*:** invoices, receipts, credit notes, TDS credits, outstanding, **Statement of account** PDF (opening balance, invoices, receipts, TDS, credit notes, closing balance, for any period).
10. **Engagement\*:** engagement letters per FY (status, fee, scope, expiry, renewal); audit engagements (§6.9); previous-auditor communication; acceptance/conflict records.
11. **Communication:** every message across email, WhatsApp hand-off, Gmail hand-off, portal and call notes, in one thread view; templates; "Log a call".
12. **WhatsApp group:** the setup checklist, members and **Open chat** (§7.25). Staff only; never in the portal.
13. **Timeline:** the client's story from the first lead contact (§5.11), filterable.

#### 7.3.4 Edit, status, delete
- Status changes record a reason. **On hold / Inactive** pause auto-invoicing and client-facing reminders, with a confirm dialog that says so.
- **Delete** (Partner) moves the client to the recycle bin with everything under it. It is blocked while there are unpaid invoices (offer to waive or settle first).
- **Import / export:** CSV import with a downloadable template, header mapping, row-level validation report (invalid PAN/GSTIN, duplicate code, unknown owner), "import valid rows only". CSV/Excel export of the current view; Employees can't export fees.

### 7.4 Client groups
- Name\* (unique), notes, member clients (add/remove).
- The group page shows combined open tasks, deadlines and (Partner/Manager) outstanding across members.
- Invoicing stays per client; a consolidated **group statement of account** PDF is available.

### 7.5 Leads, quotations and client acceptance
#### 7.5.1 Leads
- **Views:** pipeline board (columns = stages; drag to move, with a reason required when moving to Lost); table; analytics.
- **Lead form**
  - **Who:** **Name**\* · **Company** · **Email** · **Phone** · **WhatsApp** (at least one contact method required).
  - **What they need:** **Services needed** (multi-select) · **Requirement notes**.
  - **Origin:** **Source**\* (Referral · Website · Walk-in · Cold call · Social media · WhatsApp · Existing client · Other) · **Referred by / source detail**.
  - **Handling:** **Estimated value (₹/yr)** · **Assigned to** · **Next follow-up** (date-time) · **Stage**.
- **Lead detail:** timeline (calls, notes, stage changes, quotations); log a call/note; WhatsApp/email/Gmail buttons with drafts; **Create quotation**; **Run conflict check**; **Convert to client** (opens the onboarding wizard pre-filled; services unlocked, since there's no accepted quotation); **Mark lost** (reason\*).
- **Automation:** a reminder at the next follow-up time; leads untouched for 14 days surface on the manager's dashboard.
- **Analytics:** leads by source and stage; conversion rate (won ÷ closed); average days to win; pipeline value (sum of open quotations); win/loss reasons.

#### 7.5.2 Quotation builder (full-page form; autosaves as Draft)
- **Who it's for:** **Lead** (search) or **existing client**. Pre-fills **Client name**\*, **Email**\*, **Phone**, **Company**, **GSTIN** (validated), **Place of supply** (derived).
- **Dates:** **Issue date**\* (today) · **Valid until**\* (today + validity days from Settings).
- **Line items** (add / remove / reorder):
  - **Description**\* · **Service** (type) · **Frequency** (Monthly / Quarterly / Annual / One-time).
  - **Qty**\* (default 1) · **Unit price (₹)**\* · **GST %**\* (default 18).
  - **Line total** (computed).
- **Totals:** subtotal, CGST/SGST or IGST split (by place of supply), total; total in words.
- **Notes to client** · **Terms** (pre-filled from the Settings default; editable per quotation).
- **Approval:** if a Manager creates a quotation and its total exceeds the **quotation approval limit** (or the limit is null), "Submit for approval" puts it at *Pending approval* and notifies Partners. A Partner can **Approve**, **Approve & send** or **Return with comments**. Partners' own quotations skip approval.

#### 7.5.3 Sending and tracking a quotation
- **Send by email** (Resend): a branded email with a **View quotation** button (`/q/<token>`) and a PDF attachment. Logged in `quotation_email_logs` with the provider id.
- **Send via Gmail** (hand-off, §7.13.3): Gmail compose opens with the recipient, subject and a covering note containing the link. No compose URL can attach a file, so the PDF is downloaded separately if wanted.
- **Send via WhatsApp** (hand-off): a drafted message with the link.
- **Copy link.**
- The **public page** (`/q/[token]`, no login, §7.23) records the first and every later view (`viewed`, `view_count`), lets the client **Accept** (typing their full name as an e-acceptance, plus an optional note) or **Decline** (reason\*), and offers the PDF.
- **Follow-ups:** automatic reminders on **day 3, 7 and 14** after sending, while the quotation is still Sent/Viewed and not expired. Each is sent by email if delivery works, otherwise surfaced to the owner as a task to hand off.
- **Expiry:** after `valid_until` → *Expired* (nightly). The link shows "This quotation has expired. Contact TaxWise for an updated one."
- **Revise:** a quotation that has been sent, viewed, rejected, expired, approved or pending is never edited in place. **Revise** creates a new quotation (same lines, `revision_number + 1`, a new number and token), marks the old one *Superseded*, and the old link stops accepting responses ("This quotation has been replaced by a newer version").
- **On acceptance:** notify the owner and Partners; stage → Won; show the **Create client** call to action (§7.3.2 pre-fill). Converting stamps `converted_client_id` so it can't happen twice.
- **PDF:** letterhead (logo, firm name, address, GSTIN, contact) · "QUOTATION" with number, issue date, valid-until and prepared-by · Prepared for · line table · totals and tax split · total in words · notes · terms · acceptance block (signature line, or "Accepted electronically by <name> on <date>") · footer "TaxWise Consultants · Powered by J-TACS".

#### 7.5.4 Client acceptance and conflict check (before taking on a client; mandatory for attest work)
- **Inputs:** prospect name\*, PAN, GSTIN, related parties (group companies, directors, partners; tag input).
- **The check** searches existing clients, leads and every client's contacts and related parties for exact PAN/GSTIN matches, normalised-name matches and related-party overlaps, and shows each hit with why it matched.
- **Decision:** **Accept** · **Decline** · **Pending**. A rationale is required when declining, or when accepting despite a conflict. Frozen with `conflicts_found` and the decider. The acceptance register is a Partner/Manager list (filters: outcome, date).

### 7.6 Work tracker (tasks)
#### 7.6.1 Views
- **Table** (default), **Board** (columns = status), **Calendar** (by due date) and **My review queue**.
- **Filters:** status, assignee, reviewer, client, service, priority, due window (overdue / today / this week / next 7 days / this month / no date), acceptance (waiting / accepted / declined), FY/period, has blockers.
- **Saved views:** shipped defaults are "My open tasks", "Due this week", "Data awaited", "Unassigned", "Waiting for acceptance", "Overdue".

#### 7.6.2 Create / edit task
- **What:** **Client**\* (search; Employees only see their clients) · **Title**\* · **Description** · **Service** · **FY** + **Period** (e.g. Sep 2026).
- **When:** **Due date** · **Priority** (default Medium) · **Estimated time** (hours/minutes).
- **Who:** **Assignee** · **Reviewer** (cannot be the assignee).
- **Detail:** **Checklist** (add items, or **Apply job template**: items get due dates from the template offsets) · **Blocked by** (pick other tasks; cycles rejected) · **Remarks**.
- **Assignment check on save** (`checkAssignment`); results show inline before saving:
  - **Blocks** when the assignee's account is disabled ("the work would be lost").
  - **Blocks** when the assignee is the named reviewer ("nobody reviews their own work").
  - **Warns** when they're on approved leave on the due date ("from 01 Jul to 10 Jul"), since assigning ahead to cover leave is normal.
  - **Warns** when they'd be over capacity, showing the arithmetic ("20 open tasks over 5 working days = 4.0 a day").
  - **Calls out** "no working days left before the due date" rather than dividing by zero.

#### 7.6.3 Acceptance
- A newly assigned task is **Waiting for acceptance**. The assignee **Accepts**, or **Declines** with a reason code\*:
  - No capacity this week · Not my client · Outside what I do · Not enough information to start · I'm away when this is due · Something else (note\*).
- Declining **unassigns** the task, records who declined it, and notifies the assigner and Managers.
- The decliner can't update a task they declined. Status can't change until the task is accepted.

#### 7.6.4 Status rules (`change_task_status`, enforced in the database function **and** the UI)
- **Moves:** any move is allowed, including backwards (corrected figures happen), except:
  - a no-op (refused, not silently written);
  - Filed/Done → Not started ("already done and filed; reopen to In progress instead").
- **A reason is required** when sending back (Under review → In progress), when reopening (Filed/Done → anything), and when putting On hold.
- **Who can file:**
  - **Employees cannot set Filed/Done**; they submit **Under review**.
  - **Managers** may file work they didn't do; nobody files their own (separation of duties).
  - **Partners** may file anything.
- **Dependencies:** a task cannot move to In progress, Under review or Filed/Done while any blocker isn't Filed/Done. The error names the blocker.
- **Derived values:**
  - `completion_date` is set when first Filed/Done, kept on re-save, and cleared on reopen.
  - Escalation resets on reopen.
  - **Overdue is computed**, never stored.
- Every change writes `task_status_history` (from, to, reason, who, when) and the client timeline.
- **Notifications:**
  - **Under review** → the named reviewer (personally), otherwise all Managers.
  - **Sent back** → the assignee, with the reason.
  - **Filed** → the assignee, plus the owner if different.
  - **Data awaited** → appears on the Manager's call list, with WhatsApp/email drafts asking the client for what's missing.

#### 7.6.5 Filing capture
- When a task with a filing service is set to **Filed/Done**, a dialog asks for:
  - **Return / form**\* (from the compliance event, e.g. GSTR-3B).
  - **Period**\*, **FY**\*, **Filed on**\*.
  - **Acknowledgement / ARN / SRN no.**
  - Upload the acknowledgement PDF.
  - Link a UDIN (if a certificate or report was signed).
- This creates the `filing_records` row and marks the linked compliance event Filed. The dialog can be skipped, with a reason, for non-filing work.

#### 7.6.6 Task detail page
- Header: client, title, status chip with its allowed next moves, assignee, reviewer, due (with relative time), priority.
- Then: description, checklist (progress bar), comments (`@mention` notifies), attachments (stored through the documents vault), time logged vs estimate (bar), dependencies (blocked by / blocking), status history, activity.
- Buttons: Start timer · Log time · Ask client for data (WhatsApp/email drafts) · Change status.

#### 7.6.7 Bulk operations and escalation
- **Bulk:** assign, change reviewer, change due date (with reason), change priority. **Reassign all work from person A to B** (from the People page).
- **Escalation (daily job):** overdue > **3 days** → level 1 (notify the assignee and Managers); > **7 days** → level 2 (notify Partners). Idempotent; re-arms after reopen or a due-date change.
- **Recurring tasks:** `task_automations` can create a task each period from a template, for a client and service (e.g. "GSTR-3B: <period>" on the 1st of every month).

### 7.7 Filings and calendar (compliance)
- **Filings grid** (Partner/Manager): rows = clients, columns = periods (months, or quarters for QRMP and TDS), cells = status (Not started · Docs awaited · In progress · Under review · Filed · Overdue). Filter by return type (GSTR-1, GSTR-3B, TDS return, ITR, ROC…), owner and FY.
  - Click a cell to open the event: its task, its filing record, and its acknowledgement.
  - **Answers "is everyone's GSTR-3B filed for September?" in one glance.**
- **Calendar:** month / week / agenda views. Statutory and firm events in one calendar, colour by type, filter by client, owner and type. Shows extended dates with a badge linking to the circular.
- **Event form:**
  - **Client** (or firm-level) · **Type**\* · **Form code** · **Title**\* · **Description**.
  - **FY**, **Filing period**, **Due date**\*, **Reminder days** (default from Settings).
  - **Linked task** (create one automatically: toggle) · **Notes**.
- **Workflow:** Not started → Documents awaited → In progress → Under review → Filed → Completed. Filing an event without a linked filing record prompts for the §7.6.5 details.
- **Generation:**
  - On onboarding.
  - On service changes.
  - **Generate deadlines** on Client 360.
  - Monthly job (1st, 08:30 IST): tops up the 13-month window.
  - All via `due_date_rules` + overrides (§5.12, §6.7), idempotent by `dedupe_key`.
- **Ops templates** (`recurring_compliance_templates`) add internal prep steps ahead of statutory dates. Defaults:
  - **Bookkeeping:** collect bank statements (5th), sales data (7th), purchase data (7th), expense receipts (10th).
  - **GST:** GSTR-1 data collection (5th), GSTR-3B reconciliation prep (14th), each for the previous month.
  - **Income tax:** tax planning review (1 March).
  - **Audit:** documentation collection (1 September), financial statement preparation (15 September).
- **Coverage gaps:** a report listing clients whose active services have no upcoming events (e.g. GST active but nothing after December), with a one-click fix.
- **Extensions:** adding a `due_date_overrides` row moves every matching unfiled event, re-plans reminders and notes the circular on each event (§5.12).
- **Client compliance report** (PDF): for a client and a date range, every deadline, its status, filed-on date, acknowledgement number and whether it was on time. Branded, for sending to the client.

### 7.8 Workpapers
#### 7.8.1 GST reconciliation (§6.12)
1. Pick **Client**\* and **Period**\* (month).
2. Upload the **GSTR-2B JSON**\* and the **purchase register** (CSV/XLSX)\*.
3. Map the register's columns (remembered per client).
4. **Run.**

- **Results:** a summary card (ITC per 2B, per books, matched, mismatched, missing in books, missing in 2B, ITC at risk, unclaimed ITC); tabs per bucket with sortable tables; the supplier roll-up; the **IMS action list**.
- **Actions:** export Excel; "Draft supplier follow-up" (WhatsApp/email per supplier listing their missing invoices); mark rows resolved with notes.
- Runs are saved, with history per client and period.

#### 7.8.2 ITR computation (§6.11)
- **Pick:** Client\* (individual/HUF), FY\*, age band (auto from date of birth, overridable).
- **Income:** salary (gross), house property (net; negative = loss), business/profession, other sources, STCG 111A, LTCG 112A, other LTCG.
- **Deductions (old regime):** 80C basket, 80CCD(1B), 80D, 80G, 80TTA/TTB, other.
- **Employer NPS** 80CCD(2) (both regimes).
- **Taxes paid:** TDS/TCS, advance tax by instalment (Q1–Q4), self-assessment tax.
- **Filing date** (for interest; defaults to today).
- **Output:** a side-by-side computation (old vs new) with every line; interest u/s 234A/B/C; tax payable or refund; recommended regime and the saving. "Regime chosen" is recorded by the reviewer.
- Status Draft → Reviewed → Final (only a Manager/Partner can mark Final). PDF on letterhead.

#### 7.8.3 Financial statements (§6.13)
1. Client\*, FY\*.
2. Upload the trial balance.
3. Map columns.
4. **Auto-map ledgers** to buckets (confidence shown); fix the unmapped ones; review the checks.
5. Generate the P&L and balance sheet with comparatives.
6. Export PDF/Excel.

Draft → Reviewed → Final.

#### 7.8.4 Notices and litigation register
- **The notice:** **Client**\* · **Notice type**\* (select + free text: GST DRC-01/ASMT-10/REG-17…, IT 143(1)/143(2)/142(1)/148A/148, TDS 200A/201, other) · **Section** · **Authority** · **Reference/DIN** · **Notice date** · **Received date**.
- **Dates:** **Reply due date**\* · **Hearing date/time**.
- **Substance:** **Demand (₹)** · **Description** · **Assigned to**.
- **Status:** Open → Reply drafted → Replied → Hearing → Closed (favourable / unfavourable / partial).
- **Running notes log** (dated entries); attach the notice, the reply and the order.
- **Appeal tracking** (when closed unfavourable): appeal forum, order date, **limitation date** (seed from parameters: IT first appeal 30 days from the order; ITAT 60 days; GST first appeal 3 months; GST Appellate Tribunal 3 months [verify each against the current statute]), and an appeal task created automatically.
- **Reminders** at 7 and 2 days before the reply due date and the hearing; overdue replies are red on the dashboard.

### 7.9 Billing (Partner/Manager only)
#### 7.9.1 Invoice list
- **Columns:** number, date, client, period, taxable amount, GST, total, received, TDS, outstanding, due date, status (incl. derived Overdue with days), sent via.
- **Filters:** status, client, date range, FY, overdue, awaiting approval, created by.
- **Totals row** for the filtered set.

#### 7.9.2 Create invoice
- **Who and when:** **Client**\* (shows GST status, state, outstanding, engagements) · **Invoice date**\* (default today) · **Due date**\* (date + payment terms; editable) · **Place of supply** (auto; overridable with a reason).
- **Lines:**
  - **Description**\* · **Service** · **SAC**\* (auto from the service map) · **Qty** (default 1) · **Rate (₹)**\* · **GST %**\* (default 18; 0 for reimbursements) · **Reimbursement (pure agent)** toggle · line amount.
  - **Add from:** **Engagement** (the client's agreed fee for a period; billing period label) · **Unbilled time** (pick entries; billed at each employee's rate, grouped by task) · **Completed task**.
- **Totals:** taxable value, CGST+SGST or IGST, reimbursements, round-off (optional), **total**, in words.
- **Notes**, **Terms** (default from Settings), **Billing period label**.
- **Checks:**
  - registered client with no GSTIN → **block**;
  - a fee different from the agreed engagement fee → note ("Agreed ₹X; invoicing ₹Y");
  - work completed more than 30 days ago → Rule 47 warning;
  - the same engagement period already invoiced → **block** with a link.
- **Approval:** a Manager-raised invoice above `invoice_approval_limit` (incl. GST) saves as **Awaiting approval**. It can't be sent; Partners are notified and can **Approve** or **Return with note**. The gate is **frozen at creation** (a later limit change doesn't re-gate or release).
- **Number** assigned when it leaves Draft (Issue), from the locked series (§5.11). Drafts show "Draft".

#### 7.9.3 Invoice lifecycle and corrections
- **Draft:** edit freely; delete (soft).
- **Issue/Send:**
  - Email (Resend) with the PDF attached and a portal "Pay / view" link; **Send via Gmail** hand-off (§7.13.3); **Send via WhatsApp** hand-off (link to the portal invoice + UPI deep link).
  - The status moves to **Sent** on the first send of any kind.
- **Issued invoices are never edited.**
  - Not yet reported in TaxWise's filed GSTR-1 → **Cancel & reissue**. The original keeps its number, is marked cancelled with a reason, and a new invoice is created.
  - Already reported → **Credit note** (reduce; s.34 deadline, §6.4) or **Debit note / supplementary invoice** (increase).
  - A setting tells the app the last month for which TaxWise has filed its own GSTR-1.
- **Disputed:** reason\*; paused from reminders.
- **Waive:** Partner only, reason\*. It writes off the outstanding amount and is shown in reports as a write-off (not revenue reversal).
- **Status derivation:**
  - Paid / Partially paid come only from receipts.
  - Overdue is computed (only Sent/Partially paid with a balance after the due date; **a draft is never overdue**).

#### 7.9.4 Record receipt
- **Payment date**\* · **Amount received (₹)**\* (≥ 0) · **TDS deducted (₹)** · **TDS section** (from parameters; expected TDS suggested, §6.5) · **Method**\* (Bank transfer NEFT/IMPS/RTGS · UPI · Cheque · Cash · Card · Other) · **Reference/UTR/cheque no.** · **Deposited to** (bank account) · **Notes**.
- Validation: received + TDS ≤ outstanding + ₹1. Excess is refused, with "record the advance separately" guidance.
- Generates a **receipt number** and a **receipt PDF**. Receipts are **reversed with a reason, never deleted**.

#### 7.9.5 Collections
- **Follow-up log** per invoice: channel, notes\*, promised payment date, next follow-up. Promised dates feed the collection forecast.
- **Reminders** (daily job): **3 days before due** (gentle), then **1, 7 and 15 days after due** (firmer), by email when delivery works, otherwise surfaced to the owner as hand-off tasks (WhatsApp/Gmail drafts ready).
  - Never for Draft, Disputed, Waived or Paid invoices, or for clients On hold.
- **Payments dashboard** (Partner only): outstanding, overdue, ageing buckets, collection rate, days sales outstanding, top 10 debtors, promised vs received this month, monthly collections chart, unbilled time ₹.

#### 7.9.6 Retainer (auto) billing
A daily job (09:30 IST) handles every engagement with `auto_invoice = true` and `next_billing_date ≤ today`, and creates **Draft** invoices (never sent automatically).
- **Skipped**, with the reason counted: not enabled · service inactive · client inactive or on hold · no agreed fee · one-time service · not yet due.
- **Catches up** missed periods, up to **3 per run**, and reports any engagement that hit the cap. Advances `next_billing_date` by one cycle per invoice.
- A **"Retainer drafts"** queue shows the batch; **Issue all / Issue selected** sends them.

#### 7.9.7 Credit notes
- From an issued invoice: **Reason code**\* (Fee reduction · Service not rendered · Duplicate · Error · Goodwill) · **Reason**\* · **Taxable amount to credit**\* (≤ remaining taxable value) · GST computed with the invoice's rate and split.
- Number from its own series; PDF; reduces the outstanding amount; included in GSTR-1 exports. The **s.34 deadline** is enforced (§6.4).

#### 7.9.8 TaxWise's own GST compliance
- **GSTR-1 export** for a month/quarter: B2B, B2CL/B2CS, CDNR (credit/debit notes), HSN/SAC summary, document-issued summary, in the portal's Excel/JSON layout.
- A **sales register** export for TaxWise's own books.

#### 7.9.9 TDS credits
- Every receipt with TDS: client, invoice, quarter, section, amount.
- Status: **Expected → Reflected in 26AS/AIS (Form 168) → Claimed**. Mark manually, or import the 26AS/AIS text/CSV to auto-match by deductor TAN and amount.
- Mismatches are listed (ask the client to correct their TDS statement; WhatsApp/email drafts).

#### 7.9.10 Reports in Billing
- **Revenue ledger:** invoice-level with GST split, receipts and credit notes; Excel.
- **Fee realisation:** per client and service: agreed (quoted/engagement) vs invoiced vs collected; billing % and realisation %; leakage list (engagements with no invoice for a due period).
- **Statement of account** per client or group.

### 7.10 Timesheet
- **Timer:** one running timer per person (start from a task, client or top bar; stop; switching tasks stops the previous one). It survives reloads (stored server-side).
- **Manual entry:** **Date**\* · **Client** · **Task** (filtered by client) · **Start/End** or **Duration**\* · **Description** · **Billable** (default on for client work).
- **My timesheet:** a week grid (days × tasks), daily and weekly totals vs target, copy last week's rows.
- **Team timesheet** (Partner/Manager): per person per day, utilisation (billable ÷ total), and budget vs actual per task.
- **Locking:** billed entries are read-only. A Partner/Manager can approve a week, which locks it.
- **Unbilled time:** by client with ₹ value (minutes × employee billing rate), feeding invoices (§7.9.2).

### 7.11 People
#### 7.11.1 Team list
- **Columns:** name, role badge (Partner gold, Manager navy, Employee grey), designation, department, email, phone, status (active / disabled / no login yet), open tasks, capacity band, online now, last seen.
- **Actions:** Add · Import CSV · Issue logins · Reset password · Change email · Change role · Disable/Enable · Reassign work · Delete (Partner). See §4.5.

#### 7.11.2 Person detail
- **Profile:** fields from §4.5.
- **Work:** open tasks, review items, clients owned/on team; covers they hold and covers for them, with **Cover their clients** (§4.7).
- **Time:** this week/month hours, billable %, utilisation.
- **Attendance:** calendar with statuses.
- **Leave:** balance and history.
- **Activity timeline.**
- **Performance:** tasks filed on time %, average days late, review send-back rate, hours vs target.

These are shown to the person themselves too, so the people being measured can see it.

#### 7.11.3 Leave
- **Request:** **Type**\* (Annual · Sick · Casual · Unpaid · Sabbatical · Other) · **From**\* · **To**\* (inclusive; half-day option) · **Reason**.
- **Approval:** Managers approve Employees; Partners approve Managers and Partners. Decision note optional. Approved leave:
  - marks attendance **On leave**;
  - feeds the assignment warnings and capacity;
  - sets the "out of office" badge;
  - surfaces tasks due during the leave to the Manager ("Reassign before 01 Jul?");
  - asks the approver who covers the person's clients during the leave (§4.7), or records **No cover needed**.
- **Holidays list** in Settings (firm holidays are non-working days for capacity and attendance).

#### 7.11.4 Capacity
- Per person: open tasks due in the window ÷ working days left (excluding weekends, holidays and leave) = tasks per working day.
- **Bands:** **CLEAR** < 1.5 · **BUSY** ≥ 1.5 · **TIGHT** ≥ 2.5 · **OVER** ≥ 4. Thresholds editable in Settings.
- Shown on the Manager dashboard, on People, and inside the assignment check.

### 7.12 Presence and attendance engine (pure functions + jobs)
- **Heartbeat:** while a staff member has the app **open and visible** (Page Visibility API), the browser sends a heartbeat every **5 minutes**, plus one immediately when the tab becomes visible again. Hidden tabs send nothing.
- **Accumulation:**
  - The server credits `min(now − last_active_at, 6 minutes)` to the open session's `active_minutes` (a capped credit, so an early or duplicate beat can't inflate time) and updates `last_active_at`.
  - A beat with no open session opens one (`login_at = now`).
- **Status:** **Online** (last beat < 20 min) · **Idle** (20–45 min) · **Offline** (> 45 min). Invariant: idle threshold < stale threshold (assert it at module load).
- **Closing:**
  - A session silent for **45 minutes** is closed at its **last activity time** (not at "now"), so forgotten tabs never earn hours.
  - Explicit sign-out closes it too.
  - A nightly job (00:15 IST) closes every session still open, at its last activity.
- **Attendance per working day:**
  - First activity ≤ `work_day_start + late_grace` → **Present**; later → **Late login**.
  - Total active minutes < `half_day_minutes` → **Half day** (computed at day end).
  - No activity on a working day → **Absent** (job at 11:30 IST for the previous day).
  - Approved leave → **On leave** (wins over everything).
  - Non-working days and holidays create no record.
- **Corrections:** Partner/Manager can correct a day's status with a reason (stored, visible in the audit log).
- **Exports:** attendance report (person × day) as CSV/Excel, and a monthly summary (present, late, half days, absent, leave, hours).

### 7.13 Messaging
#### 7.13.1 Channels and what "sent" means
| Channel | How it works | What the app may claim |
|---|---|---|
| **Email (automatic)** | Resend, from `noreply@twchartered.com`, reply-to `info@twchartered.com`, once the domain is verified | Sent / delivered / opened / bounced (Resend webhooks) |
| **WhatsApp hand-off** | Opens WhatsApp (app or web) with the recipient and a drafted message; the user presses Send | **"Handed off"** only; never "delivered" |
| **Gmail hand-off** | Opens Gmail compose in a new tab with to/subject/body filled in; the user presses Send | **"Handed off"** only |
| **Client portal** | Message thread between the client and the firm | Sent / read (portal read receipts) |
| **Call log / note** | Staff record a phone call or meeting | Logged |
| **WhatsApp panel (TaxWise Desktop)** | WhatsApp Web inside the desktop app (§7.25); the user types and sends in WhatsApp itself | Nothing about the messages: the CRM never sees or stores them, and logs only that the chat was opened |

Every channel writes to `messages` (client, contact, channel, direction, body, template, related record, who) so the **Communication** tab shows one complete history.

#### 7.13.2 WhatsApp click-to-chat: **ready now; build exactly this**
No WhatsApp Business API, no Meta account and no per-message fees. Messages go from the firm's own WhatsApp, the number clients already recognise and can reply to. *(Automated sending, delivery receipts and inbound WhatsApp are out of scope here and will be specified later.)*
- **Number normalisation** (`normalizeWhatsAppNumber`, unit-tested):
  1. Trim. A leading `+` means the country code is present; strip everything but digits.
  2. Without `+`:
     - 11 digits starting `0` → drop the `0` (trunk prefix);
     - more than 12 digits starting `00` → drop the `00`;
     - exactly 10 digits → must start with 6–9 (Indian mobile; landlines aren't on WhatsApp) → prefix `91`.
  3. With `+` and a leading `00` → drop it.
  4. The result must be **8–15 digits** (E.164).
  5. If it starts `91` and is 12 digits, the subscriber part must start with 6–9.
  6. Anything else → **null** ("no WhatsApp number").
- **Which number:** contact `whatsapp` → contact `phone` → client `whatsapp` → client `phone`. Per-contact buttons use that contact's own number. The `handles` field picks the right contact for a service (e.g. the GST accountant for a GSTR-3B data request).
- **URL:** `https://wa.me/<digits>?text=<encodeURIComponent(draft)>`. Line breaks are kept (`%0A`). `wa.me` routes itself to the phone app, WhatsApp Web or desktop. Don't hard-code `web.whatsapp.com`. In TaxWise Desktop the app catches `wa.me` links and opens them in its WhatsApp panel (§7.25.3).
- **Button:** a green WhatsApp icon + label.
  - If there is no usable number it **stays visible but disabled**, with a tooltip: "No WhatsApp number for this client. Add one in Contacts."
  - Clicking first opens a small **preview sheet** (recipient name and number, editable draft, template picker), then "Open WhatsApp". After opening, the app logs the message as `whatsapp_handoff / handed_off`.
- **Signature on shared numbers:** if the user's profile has "Add my signature to WhatsApp drafts" on (the default for Managers and Employees, who send from the shared office numbers), the draft ends with the firm's signature (default `– {first_name}`), so the client knows who wrote it (§7.25.10).
- **Where it appears, and the default draft (each from a template, §7.13.4):**
  - Client list row and Client 360 header (general).
  - Each contact row.
  - **Data awaited** task: "Hi {{contact_name}}, for your {{service_type}} for {{period}} we still need: {{missing_items}}. You can upload them here: {{portal_link}}".
  - **Document request:** the list of pending items + portal link.
  - **Compliance reminder:** "{{compliance_type}} for {{period}} is due on {{due_date}}…".
  - **Invoice:** amount, due date, portal link, UPI pay link.
  - **Payment reminder** (before/after due).
  - **Quotation:** the public link.
  - **Staff login share** (People → "Login created"): login URL, email, temporary password.
  - **Supplier follow-up** from GST reconciliation (to the client's contact, listing the suppliers to chase).
  - **Lead follow-up.**
- **Bulk reminders:** for a filtered list (e.g. all clients with GSTR-3B data pending), the app builds a **queue** of personalised drafts. The user steps through them ("Open WhatsApp → mark handed off → next"), each logged. Nothing is sent without a person pressing Send.

#### 7.13.3 Gmail compose hand-off
- **URL:** `https://mail.google.com/mail/?view=cm&fs=1&tf=1&to=…&su=…&body=…` (plus `cc`/`bcc` if needed); `mailto:` as a fallback for non-Gmail users (a toggle in the profile: "I use Gmail / Outlook / default mail app").
- **Attachments:** **no compose URL can attach a file**; browsers forbid it. Put a **link** in the body: the quotation's public page, the portal invoice page, or the portal document request. Offer **Download PDF** beside the button for anyone who wants to attach one by hand.
- **Length:** Gmail drops very long compose URLs. Cap the URL at about 1,900 characters by trimming the **body**, never the recipient or subject (UTF-8 aware, since ₹ is multi-byte).
- **Where:** everywhere an automatic email can be sent (quotation, invoice, reminder, document request, staff invite), and **prominently whenever an automatic send failed** ("Delivery failed, so {{client}} hasn't received this. Send it from your own mailbox instead; the note and link are filled in.").

#### 7.13.4 Templates
- **Fields:** **Name**\* · **Type**\* (Document reminder · Compliance reminder · Payment reminder · Task assignment · Overdue notice · Quotation · Welcome · Custom) · **Channel** (Email · WhatsApp · Any) · **Subject** (email) · **Body**\*.
- **Variables** (inserted from a picker; unknown variables are rejected on save):
  - Client: `{{client_name}}` `{{client_code}}` `{{contact_name}}`
  - Work: `{{service_type}}` `{{compliance_type}}` `{{period}}` `{{due_date}}` `{{days_until_due}}` `{{days_overdue}}` `{{task_title}}` `{{missing_items}}` `{{priority}}`
  - Money: `{{invoice_number}}` `{{amount}}` `{{payment_link}}` `{{upi_link}}`
  - Links: `{{portal_link}}` `{{quotation_link}}`
  - Firm: `{{firm_name}}` `{{firm_phone}}` `{{sender_name}}`
- **Preview** renders with a sample client. Seed defaults for every type (§16).

#### 7.13.5 Email (Resend) setup and behaviour
- The domain verification wizard (Settings → Email) creates the domain in Resend, **shows the exact DNS records** (SPF, DKIM, return-path/MX, DMARC recommendation) with copy buttons, polls the status, and shows **Verified** only when Resend says so. It never sets "verified" locally.
- **Until verified:** automatic client emails are **not attempted silently**. Every place that would send shows the hand-off buttons instead, with a banner "Email isn't set up yet. Use WhatsApp or Gmail, or finish email setup."
- **Send test email** (to yourself).
- **Delivery events** via the Resend webhook: delivered / bounced / complained / opened. Bounces flag the contact's email as bad.
- Every email footer carries: the firm's name, address and phone · "This message was sent by TaxWise Consultants" · a small "Powered by J-TACS".

### 7.14 Documents and requests
- **Vault per client:**
  - **Organisation:** folders by **category** and **FY**; list and grid; search by title, tag or text.
  - **Upload:** drag-drop multi-upload with per-file category, FY, period, title (defaults from the file name), tags and a "confidential" flag.
  - **File rules:** max 25 MB; PDF, JPG/PNG/HEIC, CSV/XLS/XLSX, DOC/DOCX; rejected files get the reason. Duplicate warning by SHA-256.
  - **Versions:** "upload new version" with a change note.
  - **Preview** for PDF and images; download through a signed URL (60 s). Every view and download is logged.
- **Expiry and retention:** expiry/renewal dates (with reminders) and `retention_until` (§6.8).
- **Confidential files** are visible only to Partners/Managers and the client's engagement team.
- **Document requests (PBC lists):**
  - **Fields:** **Title**\* · **Due date** · **Items**\* (title\*, help text, required) · **Notes** · **Reminder every N days** (default 3).
  - **Sending:** by portal (the client sees it under Documents), with email + WhatsApp + Gmail hand-offs carrying the portal link.
  - **The client uploads against each item.** Staff **Accept**, or **Reject with a reason** (the client is notified and can re-upload).
  - **Closing:** the request completes when every required item is accepted. Reminders stop when nothing is pending.
- **Checklist** (from onboarding): items can be ticked collected, linked to a document, added or removed.

### 7.15 Practice management
#### 7.15.1 Registers (firm-wide pages; per-client copies on Client 360)
- **Portal credentials vault:**
  - **Fields:** **Client**\* · **Portal**\* (GST · Income Tax · TRACES · MCA · EPFO · ESIC · ICEGATE · Professional Tax · Other → name) · **Username**\* · **Password**\* (encrypted with AES-256-GCM on save; never shown in lists) · **Login URL** · **Notes**.
  - **Reveal:** shows the password for 30 seconds with copy, and logs it (who, when, IP).
  - **Who may reveal:** Partners, Managers, and Employees with vault access for their own clients only.
  - **Access trail** per credential. Quarterly "vault access review" reminder for Partners.
- **Statutory registrations:** **Client**\* · **Type**\* (GST · Professional Tax · IEC · MSME/Udyam · FSSAI · Shops & Establishment · PF · ESIC · DIN · LLPIN · CIN · TAN · Other) · **Number**\* · **Jurisdiction** · **Issue date** · **Expiry/renewal date** · **Remind N days before** (default 30) · **Status** (Active · Expired · Surrendered · Cancelled) · **Notes**.
  - DIN rows also hold **last DIR-3 KYC Web filed (FY)** and compute the next due year (every third FY, by 30 June; §6.7).
- **DSC register:** **Client**\* · **Holder name**\* · **Holder PAN** · **Class** (Class 3 default) · **Serial no.** · **Issued by** · **Issue date** · **Expiry date**\* · **Custody** (Firm / Client / named person) · **Status** · **Notes**. Alerts at 30, 15 and 7 days; the dashboard lists DSCs expiring this month.
- **UDIN register:** **UDIN**\* (validated, §6.2) · **Client** · **Document type**\* · **Report form** (for the tax-audit ceiling) · **Signed on**\* · **Generated on**\* (warn if more than 60 days after signing) · **Signing partner**\* · **Linked filing record / audit engagement** · **Revised?** · **Remarks**. Includes the per-partner tax-audit ceiling panel (§6.8).

#### 7.15.2 Filing history
- All `filing_records` firm-wide: filter by client, FY, form, "filed by us / inherited".
- **Import prior filings** (CSV) for clients moving from another CA: FY, form, period, filed on, acknowledgement no., previous firm.

#### 7.15.3 Engagement letters
- **Fields:** **Client**\* · **FY**\* · **Services covered**\* · **Scope / exclusions** · **Fee agreed (₹, excl. GST)** · **Status** (Draft → Issued → Signed / Declined / Expired) · **Issued on** · **Signed on** · **Expires on** · **Signed copy** (upload) · **Notes**.
- **Generate** a letter PDF from a template:
  - TaxWise letterhead;
  - SA 210 contents for audits (objective and scope, responsibilities of the auditor and of management, applicable framework, expected form of report);
  - a services schedule and fees for non-audit work;
  - signature blocks.
- **Lists:** clients with active services and **no letter for the current FY**; letters expiring in 30 days, with a one-click **Renew for next FY** (copies scope and services).

#### 7.15.4 Quality and risk (Partner; Managers read-only)
- **Quality manual checklist** (SQC 1 elements, §6.8) with owner and last-reviewed date.
- **Peer review** records (§5.6) with validity warnings.
- **Client acceptance register** (§7.5.4).
- **KYC status** by client.
- **Previous-auditor communications.**
- **Independence declarations:** annual, per staff member; a simple yes/no questionnaire plus details.
- **Retention summary:** documents by retention year; the "review for disposal" list.
- **Data protection:** privacy notice versions, consent records, data requests, incidents (§6.10).

#### 7.15.5 Audit engagements
Built to §6.9. The engagement page shows:
- a stage tracker (Acceptance → Planning → Risk assessment → Execution → Completion → Reporting → Archive);
- for each stage, its checklist (SA references, evidence uploads, preparer and reviewer sign-off);
- materiality;
- linked tasks, documents, report details, UDIN;
- the **file assembly countdown** (report date + 60 days);
- **Archive**, which locks the file.

The engagement partner's approval is needed to move each stage.

### 7.16 Reports (Partner/Manager)
A reporting centre with filters (FY, date range, client, owner, service, employee) and Excel/PDF export:
- **Compliance:** filed on time vs late per return type and period; upcoming load; overdue by owner.
- **Work:** tasks created/filed per person; average time to file; send-back rate; data-awaited ageing.
- **Clients:** by status, service, entity type, group; new clients per month; churned (inactive) clients.
- **Revenue & realisation:** §7.9.10.
- **Collections:** ageing, collection rate, promised vs actual.
- **People:** hours, utilisation, attendance summary, leave.
- **Pipeline:** leads by source/stage, conversion, quotation win rate, average deal value.
- **Practice:** UDIN register (period), tax-audit ceiling by partner, DSC/registration expiries, engagement letters coverage.

Each report states what it counts in one line under the title.

### 7.17 Inbox and notifications
- **The bell opens the Inbox,** grouped as:
  - **Needs your action:** approvals, review requests, tasks waiting for acceptance, declined tasks to reassign, client messages, data requests.
  - **Updates.**
- Every notification has a **deep link** to the exact record, and can be marked read/unread, archived or deleted. "Mark all read".
- **Preferences** per event type: in-app (always) + email (optional). A daily digest email for Partners at 8:00 IST (optional): today's deadlines, approvals waiting, overdue receivables, unassigned work.

### 7.18 Search (`⌘K`)
- One box searching, within the user's RLS scope:
  - clients (name, code, PAN, GSTIN, email, phone), contacts, tasks (number, title), leads, documents (title, tags), employees;
  - for Partner/Manager only: invoices (number), quotations (number).
- **Results** are grouped by type with the top 5 each, plus **"See all N results"** opening a full results page with filters.
- **Commands:** "New client", "New task", "Go to invoices", "Start timer"…
- Recent searches, per user. Trigram/full-text indexes (`pg_trgm`) for speed.

### 7.19 Recycle bin
- Lists soft-deleted clients, leads, quotations, invoices, tasks and documents, with who deleted them and when.
- **Restore** (Partner/Manager) puts everything back, including children.
- **Purge permanently** (Partner only; type-to-confirm). Blocked while `retention_until` is in the future, or while invoices are under the GST record-keeping period.

### 7.20 Audit log (Partner only)
- Every audit event (§5.11): filters by user, event type, resource, date; detail drawer with before/after; CSV export.
- Insert-only; no one can edit or delete entries.

### 7.21 Settings
**Partner only, except My profile and Notifications.**
- **Firm details:** identity, address, contact, GSTIN/PAN/TAN, ICAI FRN, partners' membership numbers, logo upload (PNG/SVG/JPG ≤ 1 MB, previewed on the invoice template).
- **Bank & UPI** (shown on invoices and in the portal Pay dialog).
- **Numbering:** prefixes and the next number per series. Shows a sample number and enforces ≤ 16 characters.
- **Billing:** default GST rate, SAC map, payment terms, invoice terms and footer, round-off on/off, invoice approval limit, quotation approval limit, quotation validity and terms, "e-invoicing applies", "last month reported in our GSTR-1".
- **Working hours:** day start time, late grace, half-day minutes, working weekdays, weekly hours target, holidays list, capacity thresholds.
- **Reminders:** compliance lead days, invoice reminder schedule, document request cadence, digest on/off.
- **Email:** the domain verification wizard, from-name/address, reply-to, test send, delivery log.
- **WhatsApp:**
  - default country code; template defaults;
  - **firm WhatsApp numbers:** label, number, kind, Partner, custodian, in every client group, admin, shared, who may use it in TaxWise Desktop, two-step verification, last device review;
  - **group name format** (with a live example) and **signature format**;
  - **client mode** for Employees (on by default), **Employee notifications** (off), **Allow WhatsApp in a browser window for Employees** (off), **linked device limit** (4; 10 with Meta Verified multi-agent);
  - **Linked PCs:** each PC, its numbers, last user, last seen; **Remove PC**;
  - **house rules** (§7.25.10) and the **WhatsApp group welcome** template;
  - **Download TaxWise Desktop** (link to the latest signed installer).
- **Law & rules:** `statutory_parameters`, `due_date_rules`, `due_date_overrides` and `section_concordance`, with **[verify]** items highlighted, "verified by / on", and a change log.
- **Job templates** and **message templates** (also reachable from Practice).
- **Data:** full export (ZIP of CSVs for every table + documents manifest); privacy notice editor.
- **Diagnostics** (§7.24).

### 7.22 Client portal (`/portal`)
Separate, simpler shell: TaxWise logo, the client's name, a top navigation bar, mobile-first. On first sign-in the client must set a password and acknowledge the privacy notice.
- **Home:**
  - next deadlines (with "what we need from you");
  - pending document requests;
  - outstanding invoices with **Pay**;
  - latest messages from the firm;
  - the firm's contact card with the owner's name.
- **Deadlines:** upcoming and overdue, with plain-language explanations ("GSTR-3B for September: your monthly GST summary return").
- **Compliance:** filing status by period, with acknowledgement numbers (downloadable acknowledgements when the firm marks them shareable).
- **Documents:**
  - requests with per-item upload (drag-drop or camera on mobile), item status, rejection reasons, re-upload;
  - shared documents from the firm (returns, computations, financial statements, engagement letter).
- **Invoices & payments:**
  - **Invoices:** list, PDF download, receipts.
  - **Pay dialog:** bank details, **UPI QR code** and deep link (`upi://pay?pa=<upi_id>&pn=<payee>&am=<amount>&tn=<invoice no>&cu=INR`), and "I've paid" (reference + date + optional screenshot), which notifies the firm to verify. It does **not** mark the invoice paid; only a recorded receipt does.
- **Messages:** a thread with the firm (attachments allowed; read receipts). Staff reply from the Client 360 Communication tab.
- **Help:** FAQ and the firm's contact details.
- **Access:** invited from Client 360 → **Invite to portal** (needs an email). Creates an auth user with role `client`, linked through `clients.portal_user_id`, temporary password + email + WhatsApp/Gmail hand-off (like staff). **Revoke** bans the user and unlinks them. Portal users only ever see their own client (RLS). A portal login is linked to a client **only** through `clients.portal_user_id`, set by this invite, never by matching email addresses (the old build adopted logins by email). The portal never shows WhatsApp chats (§7.25).

### 7.23 Public quotation page (`/q/[token]`, no login)
- TaxWise-branded, read-only quotation (same layout as the PDF), with **Download PDF**.
- **Accept:** type your full name\* + optional note → confirmation screen.
- **Decline:** reason\* → confirmation.
- Records views; rate-limited; tokens are random 32-byte values. Expired, superseded, accepted or declined quotations show the right message instead of the buttons.

### 7.24 Diagnostics and health (Partner only)
- **Gated on the Supabase session alone,** so it still answers when the database is broken.
- **Runs, one at a time, reporting pass/fail with the error code:**
  - DB connection;
  - schema version vs expected;
  - a read of every table (missing tables show as `42P01` / Prisma `P2021`-style);
  - every enum value the app filters on (catches a partly migrated database);
  - the most recently added columns;
  - the RLS helper functions;
  - Storage buckets exist;
  - email configuration (resolved sender, domain status, last delivery error);
  - required environment variables (as booleans, never values);
  - cron jobs last run time and result.
- Messages are truncated and stripped of connection strings.
- `/api/health` (public) returns only `{ ok: true, version }` for uptime monitors.

### 7.25 Client WhatsApp groups and WhatsApp Web inside the CRM (TaxWise Desktop)
**How TaxWise works on WhatsApp:** every new client gets one WhatsApp group containing:
- the **three Partners' own numbers**;
- the **Managers' office** number (one number shared by the three Managers);
- the **Staff office** number (one number shared by all fifteen Employees);
- the client's people.

**What this module adds:**
- **A register of each client's group** on Client 360, with a setup checklist and its members.
- **WhatsApp Web inside the CRM.** A desktop app, **TaxWise Desktop**, is the CRM with a built-in browser panel that shows WhatsApp Web. **Open chat** on a client opens that client's group in the panel, beside the client's page.
- **Client mode:** Employees see only the chats of clients they are on or covering (§4.7).

**Why a desktop app:** WhatsApp's servers forbid WhatsApp Web from being shown inside another website. An `<iframe>` in the web CRM therefore shows "web.whatsapp.com refused to connect". A desktop app's built-in browser shows WhatsApp Web as an ordinary page, the way WhatsApp desktop wrappers do. Without the desktop app, the web CRM still works everywhere, and **Open chat** opens WhatsApp Web in a separate window beside the CRM (§7.25.8).

**How to build it:** the desktop app is a second project in the same repository (`desktop/`), using Electron.
- Builders that make only web apps (Lovable, Bolt, v0) build §7.25.1, §7.25.2 and §7.25.8.
- Build §7.25.3–§7.25.7 with Claude Code or Cursor.

#### 7.25.1 What changes in the web CRM
- **Client 360 → WhatsApp group tab.** The group card shows:
  - group name (copy), status and purpose;
  - members as chips: Partners `--accent-gold`, Managers' office `--brand-navy`, Staff office `--text-muted`, client people `--info`; admins marked;
  - checklist progress (e.g. 6/7);
  - the invite link (Partner/Manager only; hidden until **Reveal**, then copy);
  - "Last opened 2 hours ago by Anita".
  
  Actions: **Open chat** · Checklist · Close group.
- **Open chat:**
  - **In TaxWise Desktop** (`window.taxwiseDesktop` exists): calls `taxwiseDesktop.openClientChat(clientId)`; the app does the rest (§7.25.5).
  - **In a browser:** see §7.25.8.
  - **Both** go through the same server check: `can_open_whatsapp(client_id)` (§4.6). They write `audit_logs` (`record_viewed`, resource `client_whatsapp_group`) and update `last_opened_at`/`last_opened_by`.
- **Detecting the desktop app:** the app's preload for the CRM view exposes `window.taxwiseDesktop` with exactly these members, and nothing else:
  - `version`;
  - `openClientChat(clientId)`;
  - `toggleWhatsApp()`;
  - `refreshContext()`;
  - `onDownload(callback)`.
  
  The CRM shows desktop-only buttons (the WhatsApp toggle in the top bar, "Open chat here") only when it is present.
- **Settings → WhatsApp** (Partner): see §7.21.
- **WhatsApp groups page** (Partners and Managers): every group with its status, members and when it was last opened.
  - Filters: no group yet · to create · active · closed.
  - Also shows **PCs linked per number** ("Staff office: 3 of 4").
- **Desktop API.** Route handlers authenticated by the CRM session cookie, with `Cache-Control: no-store`. They return 401 without a session and 403 for a revoked PC.
  - `GET /api/desktop/context` returns:
    - `user` (id, name, role, from `profiles`);
    - `clientMode` and `employeeNotifications` (from Settings);
    - `numbers` (id, label, kind) the user may use;
    - `allowedGroups` (client id, client name, group name). For Employees this is the groups of clients they can see, covers in force included. For Partners and Managers it is `null`, meaning all.
  - `POST /api/desktop/whatsapp/open` `{ clientId }`: makes the same checks as Open chat, and returns `{ groupName, inviteCode?, numberId }`. The invite code goes to the app's main process only, never to the page.
  - `POST /api/desktop/devices/checkin` `{ deviceKey, deviceName, os, appVersion }`: creates or updates `desktop_devices`; refuses a revoked PC.
  - `POST /api/desktop/devices/link` `{ deviceKey, numberId, linked }`: records a link or unlink in `desktop_device_numbers`. A new link notifies Partners (§9).
  - `POST /api/desktop/health` `{ deviceKey, failing: string[] }`: tells Partners that client mode can't run on that PC, at most once a day per PC.

#### 7.25.2 Setting up a new client's group (a checklist on Client 360)
After onboarding completes (§7.3.2), the client's **WhatsApp group** tab shows **Set up the WhatsApp group**, and the engagement partner gets a to-do. Each step is ticked and stamped with who and when (`checklist`):
1. **Group name** (copy button). It comes from Settings → WhatsApp → name format, default `TW · {client_code} · {short_name}`, for example `TW · TW-C-0142 · XYZ Traders`. The client code makes the group findable in WhatsApp search, and it is how TaxWise Desktop finds the group.
2. **Save the contacts first**, because WhatsApp only adds saved contacts. **Download contact cards** (`.vcf`) for:
   - the client's contacts, named like `XYZ Traders – Ramesh (Director)`;
   - the firm's own numbers: `TW Partner – CA Vinay`, `TW Managers' office`, `TW Staff office`.
   
   Opening the file on the phone saves them in one tap.
3. **Add these numbers** (copy each, or **Copy all**). The list holds every active firm number marked "in every client group", plus the client contacts ticked here (the primary contact is ticked by default).
4. **Group settings:**
   - *Edit group settings → Only admins.* This stops anyone else renaming the group, which would stop TaxWise Desktop finding it.
   - *Approve new participants → On.*
   - *Disappearing messages → Off.*
5. **Make the Managers' office number an admin** too, so the group never depends on one Partner's phone.
6. **Post the welcome message** (copy; template "WhatsApp group welcome", §16). It says who is in the group, says that staff sign their messages, and gives the office phone for anything urgent.
7. **Mark the group created:** date (default today), which firm number created it, and the invite link (optional; Partner/Manager only). Status becomes **Active**, and the members list fills in from the checklist.

A client can have more than one group (for example a separate group for a statutory audit); one is **primary**. **Close group** (when an engagement ends) asks for a reason and a closing date.

#### 7.25.3 TaxWise Desktop: the app
- **Stack:**
  - Electron, latest stable. Use `BaseWindow` + `WebContentsView`; `BrowserView` has been deprecated since Electron 30.
  - TypeScript.
  - electron-builder: a Windows NSIS installer, plus a macOS dmg if the firm uses Macs.
  - electron-updater for auto-update from GitHub Releases or a static URL.
  - `@electron/fuses`.
- **Window:** one `BaseWindow` with three views:
  1. **CRM view** (left; takes the remaining width): loads `TAXWISE_APP_URL` (the production CRM) in session partition `persist:crm`.
  2. **WhatsApp panel** (right): loads `https://web.whatsapp.com/`.
     - Default width 440 px; drag the splitter to resize it between 360 and 720 px.
     - Collapse and expand it with `Ctrl+Shift+W` or the CRM's WhatsApp button.
     - Each firm number gets **one persistent partition**, `persist:wa-<number_id>`. Each number's WhatsApp login survives restarts, and numbers never share data.
  3. **Panel header** (36 px; local HTML from the app bundle). It holds:
     - the number in use, with a switcher listing only numbers this user may use (§7.25.4);
     - the client-mode chip ("XYZ Traders · client mode");
     - **Pop out**, which moves the panel into its own window for a second monitor;
     - **Close**.
- **User agent:** WhatsApp Web refuses browsers it doesn't recognise ("WhatsApp works with Google Chrome…").
  - Before the first load, set every WhatsApp partition's user agent with `session.setUserAgent`, to the Chrome string of the bundled Chromium: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<major of process.versions.chrome>.0.0.0 Safari/537.36`.
  - If the block still appears, clear that partition's cache, then check that both `navigator.userAgent` and the request headers carry the new value.
- **Permissions** (`setPermissionRequestHandler` and `setPermissionCheckHandler`, per partition):
  - **WhatsApp partitions** allow:
    - `notifications`, only when the user's role allows it (§7.25.5);
    - `media`, audio only (voice notes);
    - `clipboard-sanitized-write`.
    
    They deny everything else.
  - **CRM partition** allows `notifications` and `clipboard-sanitized-write`, and denies the rest.
- **Navigation:**
  - The CRM view may navigate only within `TAXWISE_APP_URL`'s origin. WhatsApp views may navigate only within `https://web.whatsapp.com`.
  - Every other link, from either view, opens in the system browser through `shell.openExternal`, and only for `https:` URLs. `setWindowOpenHandler` denies new Electron windows.
  - `wa.me` and `api.whatsapp.com/send` links clicked in the CRM (the hand-off drafts, §7.13.2) open in the WhatsApp panel as `https://web.whatsapp.com/send?phone=…&text=…`, so a hand-off happens inside the app.
- **Security** (every item of Electron's security checklist):
  - `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`. No `allowRunningInsecureContent` and no experimental features.
  - Preloads expose only the listed functions, through `contextBridge`.
  - Every `ipcMain` handler checks the sender's frame URL.
  - DevTools are disabled in production builds, and no context menu offers "Inspect".
  - Fuses: `RunAsNode` off, `EnableNodeCliInspectArguments` off, `EnableEmbeddedAsarIntegrityValidation` on, `OnlyLoadAppFromAsar` on, `EnableCookieEncryption` on.
- **The main process calls the desktop API** with the CRM view's session cookies (`session.fetch()` on the `persist:crm` session). It never uses a token handed over by the page.
- **Updates and signing:**
  - Check for updates at start and every 6 hours.
  - Buy a Windows code-signing certificate before rolling out to every PC; unsigned installers trigger SmartScreen warnings.
  - Notarise macOS builds.
- **Start-up:**
  - single-instance lock;
  - remembers the window size and panel width;
  - `app.setAppUserModelId('in.taxwise.desktop')`, so Windows shows notifications under the right name;
  - checks in with `/api/desktop/devices/checkin`;
  - loads `/api/desktop/context` after the user signs in to the CRM, then every 5 minutes and whenever the CRM page calls `refreshContext()`.
- **Signing out** of the CRM hides the WhatsApp panel at once. WhatsApp itself stays linked on the PC for the next person who signs in: the link belongs to the PC and the number, not to the CRM user. The number rules (§7.25.4) decide what that next person may see.

#### 7.25.4 Which number each person uses
- **Employees:** Staff office.
- **Managers:** Managers' office; also Staff office if a Partner adds `manager` to its `usable_by`.
- **Partners:** their own number (only on their own PC), plus any number whose `usable_by` includes Partners.
- **The panel shows a number only if** the user may use it **and** it is linked on this PC.
- **If a number isn't linked yet,** the panel shows WhatsApp's QR screen with: "Link this PC: on the <label> phone, open WhatsApp → Settings → Linked devices → Link a device, and scan this code." When the chat list appears, the app reports the link (§7.25.7).
- **A Partner's own number never appears for anyone else,** even on the same PC.

#### 7.25.5 Opening a client's chat; client mode for Employees
**Open chat** (the CRM button, or ⌘K "Open XYZ Traders' WhatsApp"):
1. The app calls `/api/desktop/whatsapp/open` and switches the panel to the right number.
2. **In-page search:** it focuses WhatsApp Web's search box and inserts the group name with `document.execCommand('insertText')`, so WhatsApp's editor registers it. It waits for results, then clicks the result whose title matches exactly. No page reload.
3. **Fallback:** it loads `https://web.whatsapp.com/accept?code=<invite code>` [verify: for a number already in the group this should open the group rather than offer to join].
4. If neither works: "Couldn't find 'TW · TW-C-0142 · XYZ Traders' on the Staff office WhatsApp. Check the group name, or that this number is in the group."

**Client mode** (Employees, while `whatsapp_client_mode` is on in Settings):
- **Only one conversation shows.** The chat list, search and archive are hidden; the panel shows only the conversation opened from the CRM. The header chip names the client.
- **Other chats are closed.** The WhatsApp preload watches the title of the open conversation. A chat is allowed if it is in `allowedGroups`, or is a one-to-one chat the CRM itself opened in this session (a hand-off, §7.13.2). Any other chat is closed, the panel shows "Not one of your clients", and `access_denied` is logged once per chat per day.
- **Covers count.** Covered clients (§4.7) are in `allowedGroups` while the cover is in force. When it ends, the next context refresh removes them and closes the chat if it is open.
- **Notifications are off for Employees,** unless a Partner turns on "Employee notifications", because a preview could show another client's message.
- **Client mode fails closed:**
  - Every DOM selector the preload uses lives in one file, `desktop/src/whatsapp/selectors.ts`. On load and every 10 minutes, the preload checks that each one still matches.
  - If one doesn't, the panel shows "Client mode is unavailable because WhatsApp changed its page. A Partner has been told." and posts to `/api/desktop/health`.
  - A Partner can turn client mode off in Settings, so Employees can use the full Staff office WhatsApp until `selectors.ts` is fixed.

**Partners and Managers** get full WhatsApp Web; **Open chat** still jumps to the client's group.

**The app never:**
- reads, copies or stores message content;
- sends a message or presses Send;
- scrapes contacts or groups;
- runs anything in WhatsApp Web beyond the search-and-open step and the client-mode checks above.

#### 7.25.6 Files from WhatsApp into the client file
- When a file is downloaded in the WhatsApp panel (`will-download`), the app offers:
  - **Save to <client> documents** (the client whose chat is open);
  - **Save to another client…**;
  - **Save to this PC**, for Partners and Managers only. Employees' downloads go to a client file or nowhere, so client documents don't pile up on shared PCs.
- **Save to documents** hands the file to the CRM page (`onDownload`). The page opens the normal upload dialog pre-filled (client, a title from the file name, category to choose, FY/period) and uploads it the usual way (signed URL, §2.3), with `documents.source = 'whatsapp'`. The temporary file is deleted after the upload, or after 10 minutes.
- **For audit clients:** when a WhatsApp exchange supports an audit judgement, save it (a downloaded file or a screenshot) to the audit file. SA 230 requires documenting discussions of significant matters with management, including when and with whom they took place.

#### 7.25.7 Linked PCs and WhatsApp's device limit
- **The limit:** WhatsApp allows each number its phone plus **4 linked devices**, or up to **10** with Meta Verified for Business multi-agent. Every PC with a number linked in TaxWise Desktop uses one.
  - So fifteen Employees on one Staff office number can't all have it open on their own PCs at once. Either set up shared WhatsApp desks, or subscribe to Meta Verified and set `whatsapp_linked_device_limit` to 10.
- **Linked PCs** (Settings → WhatsApp) lists each PC, the numbers linked on it, the last user and when it was last seen.
- **New links and idle PCs:** linking a PC notifies Partners ("FRONTDESK-2 linked the Staff office number"). A PC not seen for 30 days is flagged for unlinking.
- **Remove PC** (Partner):
  - The PC is revoked: the desktop API refuses it, and at its next start the app clears every WhatsApp partition on it.
  - The app then reminds the Partner to remove the PC from the phone's Linked devices list too.
- **The 14-day rule:** each phone must be opened at least every 14 days, or WhatsApp disconnects its linked devices.

#### 7.25.8 Without the desktop app (browser, phone)
- **Browser:**
  - **Open chat** opens WhatsApp Web in a separate window beside the CRM: `window.open('https://web.whatsapp.com/', 'taxwise-whatsapp', 'popup,width=<half the screen>,height=<screen height>,left=<half the screen>,top=0')`. The same window name is reused, so windows don't multiply.
  - It also copies the group name, so the user can paste it into WhatsApp's search.
  - A banner suggests TaxWise Desktop.
  - For Employees this button appears only if a Partner allows it (Settings → WhatsApp → "Allow WhatsApp in a browser window for Employees", default off), because client mode can't run in a plain browser.
- **Don't ship an `<iframe>` of web.whatsapp.com in the website.** WhatsApp forbids it, and the browser shows "refused to connect". A builder who wants to see this can try it once in development, then remove it.
- **Phone:** **Open chat** copies the group name and opens the WhatsApp app (`whatsapp://` [verify]).

#### 7.25.9 Risks the firm accepts by trying this
- **WhatsApp changes its web page often.** The open-chat search and client mode can break until `selectors.ts` is updated; client mode fails closed for Employees (§7.25.5).
- **WhatsApp's terms prohibit unofficial or modified WhatsApp apps,** and WhatsApp says it can ban accounts that use them.
  - This app loads the official WhatsApp Web, adds no automation beyond opening a chat, and never sends, reads or stores messages. Hiding parts of WhatsApp's page in client mode is still a modification.
  - Try it on the Staff office number first, watch for any warning from WhatsApp, and stop if one appears.
- **Client mode is a screen restriction on a shared number, not encryption.** Anyone holding the Staff office phone still sees every group.

#### 7.25.10 House rules (Settings → WhatsApp → House rules; editable by Partners; shown to staff)
1. **Same firm numbers in every client group,** plus the client's people. No personal staff numbers.
2. **Sign every message on the shared numbers** ("– Ravi"). Drafts from the CRM add the signature (§7.13.2).
3. **Office phones:**
   - stay in the office with a named custodian;
   - have a screen lock;
   - have two-step verification on.
4. **Link firm numbers only in TaxWise Desktop, on office PCs.** A Partner links their own number only on their own PC.
5. **Every week, the custodian checks** the phone's Linked devices list against Settings → Linked PCs, and removes anything unknown. The app sends the reminder (§8) and records `devices_reviewed_at`.
6. **Never discuss one client in another client's group.** If it happens:
   - delete the message for everyone;
   - tell a Partner, who records the incident (§6.10).
7. **People and engagements changing:**
   - When a Partner leaves, the WhatsApp groups page lists every group to remove their number from. Then remove their PCs.
   - When an engagement ends, post a closing message, then close the group in the app.

#### 7.25.11 Later: the official API (not built now)
Meta's **Groups API** for the WhatsApp Business Platform (Cloud API) would bring the chat into the CRM itself:
- messages would arrive by webhook;
- staff would reply from the CRM as TaxWise;
- every reply would record which staff member sent it.

What Meta's documentation says in 2026:
- An **Official Business Account** is required, on a number that runs on the Cloud API, not the WhatsApp Business app.
- A group holds at most **8 participants, the business number included**. TaxWise's six-member groups fit.
- People join by invite link; they can't be added directly.
- Billable messages are charged per member they are delivered to.
- The Business app's **coexistence** feature does **not** sync group chats. Moving to the API would therefore mean new groups, created from the API number.

Build nothing for it now.

---

## §8. Scheduled jobs (times in IST)
Every job is **idempotent** (safe to run twice), writes a `job_runs` row (`name, started_at, finished_at, status, counts jsonb, error`), and is protected by `CRON_SECRET` (Vercel Cron) or runs inside `pg_cron`. The diagnostics page shows the last run of each. A job that throws for one record logs it and continues with the rest.

| Time | Job | What it does |
|---|---|---|
| Hourly | Cover lifecycle | Sends "cover ends tomorrow" to the granter (once). For covers that have ended, notifies both people (with the timeline link and the return-note prompt) and records the automatic end (`expiry_logged_at`, audit row). Access itself needs no job, because RLS checks the time (§4.7) |
| 00:15 daily | Workforce sweep | Closes open sessions at their last activity; finalises yesterday's half-days and hours |
| 07:30 daily | Receivables sweep | Notifies the owner and Partners about invoices that **became** overdue today (derived), deep-linked; never touches drafts |
| 08:00 daily | Task escalation + digest | Escalation levels (>3 days → Managers, >7 → Partners); Partner digest email |
| 08:30, 1st of month | Compliance top-up | Extends the generated events to 13 months ahead per active service; reports coverage gaps |
| 09:00 daily | Reminders | Compliance reminders (staff in-app; client email/hand-off queue) per `reminder_days`; DSC/registration/engagement-letter/peer-review expiries; notice reply and hearing reminders; UDIN 60-day warnings; document request cadence |
| 09:30 daily | Retainer billing | Creates Draft invoices for due engagements (§7.9.6) and notifies Partners of the batch |
| 10:00 daily | Invoice reminders | Before-due and after-due reminders (§7.9.5) |
| 10:00 daily | Absent without cover | Tells Managers who is on leave or not signed in by start time + grace + 30 min, where that person's clients have tasks due within 2 days and no cover in force (§4.7) |
| 11:30 daily | Attendance | Marks yesterday's Absent for working days with no activity (leave wins) |
| 14:30 daily | Quotations | Day 3/7/14 follow-ups; expiry of lapsed quotations |
| Mon 08:30 weekly | Team health | Capacity alerts to Managers; leads untouched for 14 days; unassigned tasks; clients with no engagement letter for the current FY |
| Mon 08:45 weekly | WhatsApp housekeeping | Linked-devices review reminder to each office number's custodian; PCs not seen for 30 days → Partners; clients onboarded 2+ days ago with no WhatsApp group → engagement partner (§7.25) |
| 1st of Jan/Apr/Jul/Oct | Access review | Reminds Partners to review roles and vault access |
| 1 April yearly | New FY | Rolls FY-scoped number series; reminds about engagement letter renewals and annual independence declarations; asks a Partner to review §6 parameters for the new Finance Act |

---

## §9. Notifications catalogue (in-app always; email per preference)
| Event | Who | Link |
|---|---|---|
| Task assigned to you | Assignee | Task |
| Task declined | Assigner + Managers | Task (reassign) |
| Submitted for review | Named reviewer, otherwise Managers | Task (review) |
| Sent back to you | Assignee (with reason) | Task |
| Filed / approved | Assignee (+ owner) | Task |
| Task overdue / escalated | Assignee; level 1 Managers; level 2 Partners | Task |
| `@mention` in a comment | Mentioned person | Comment |
| Compliance due in N days | Owner + preparer | Event |
| Invoice awaiting approval | Partners | Invoice |
| Invoice approved / returned | Raiser | Invoice |
| Invoice became overdue | Owner + Partners | Invoice |
| Payment received / "I've paid" from portal | Owner + Partners | Invoice |
| Quotation viewed / accepted / declined | Creator + Partners | Quotation |
| Quotation pending approval | Partners | Quotation |
| Client uploaded a document / sent a message | Owner + team | Request item / thread |
| Leave requested / decided | Approver / requester | Leave |
| DSC / registration / engagement letter expiring | Owner + Partners | Register item |
| UDIN not generated, signed N days ago | Signing partner | UDIN register |
| Tax-audit ceiling at 50 / 58 / 60 | That partner | Ceiling panel |
| Data request received (DPDP) | Partners | Request |
| Cover started | Cover person; the absent person | Client, or My clients filtered to the cover |
| Cover ends tomorrow | Granter | Cover |
| Cover ended | Cover person (with a prompt for a return note); the absent person ("see what changed") | Client timeline for the cover window |
| Any notification about a covered client | Also the cover person, while the cover is in force | As the original |
| No WhatsApp group 2 days after onboarding | Engagement partner | Client → WhatsApp group |
| A PC linked a firm WhatsApp number | Partners | Settings → WhatsApp → Linked PCs |
| Client mode unavailable on a PC (WhatsApp changed its page) | Partners (once a day per PC) | Settings → WhatsApp |
| Role claim found in a user's `user_metadata` (ignored) | Partners (once per user per day) | Audit log, filtered to that user |
| Email bounced | Sender + owner | Message |

---

## §10. Emails the system sends (Resend; branded HTML + plain-text alternative)
1. **Staff invite:** login link, email, temporary password, "you'll set your own on first sign-in".
2. **Password reset:** Supabase template, restyled with TaxWise branding.
3. **Client portal invite:** what the portal is for, login link, temporary password.
4. **Welcome to TaxWise** (after onboarding, optional): who their owner is, how to share documents, portal link.
5. **Quotation sent:** covering note, total, valid-until, **View quotation** button, PDF attached.
6. **Quotation follow-ups:** day 3, 7 and 14, each shorter than the last.
7. **Quotation accepted/declined:** confirmation to the client; alert to the firm.
8. **Invoice:** summary, due date, **View & pay** (portal), PDF attached, bank and UPI details.
9. **Payment receipt:** thanks, receipt PDF.
10. **Payment reminders:** before due; 1, 7 and 15 days after.
11. **Document request** and its reminders: item list, upload link.
12. **Compliance reminder:** what's due, when, and what we need from you, sent to the contact who **handles** that service.
13. **Engagement letter for signature.**
14. **Partner daily digest** (optional).

Every email has a plain-language subject naming the firm and the item ("TaxWise Consultants | Invoice TW/26-27/0042 for September fees"). Each send is logged in `messages`, and bounces are handled.

---

## §11. Documents the system generates (PDF, on the server, letterhead from Settings)
- **Tax invoice** (Rule 46 fields, §6.4): logo, firm block, invoice number/date, place of supply (state and code), bill-to with GSTIN, lines with SAC, taxable value, CGST/SGST or IGST per line and in total, reimbursements separately, total in figures and words, bank details + **UPI QR**, terms, "Authorised Signatory", footer "Computer-generated invoice · TaxWise Consultants · Powered by J-TACS".
- **Credit note / debit note / receipt voucher / payment receipt.**
- **Quotation** (§7.5.3).
- **Statement of account** (client or group, any period).
- **Client compliance report.**
- **ITR computation sheet.**
- **Financial statements** (Schedule III).
- **Engagement letter** (audit / non-audit templates).
- **Management representation letter template** (SA 580).
- **Audit engagement checklist export.**
- **Excel/CSV exports:** client list, task list, revenue ledger, GSTR-1 export (portal layout), receivables ageing, attendance report, timesheets, UDIN register, GST reconciliation results, financial statements, every report in §7.16.

All money in PDFs uses Indian grouping, and all dates use `22 Oct 2026` style.

---

## §12. Security and privacy
- **Authentication:**
  - Supabase Auth; password policy (§4.4); **TOTP multi-factor authentication required for Partners and Managers** (they can see fees and reveal portal passwords), optional for Employees.
  - Temporary passwords force a change. Sessions as in §4.4.
- **Authorisation:**
  - RLS on every table (§4.6); role from `app_metadata` + `profiles`, never `user_metadata`.
  - Server actions re-check the role, reading `profiles.role`.
  - The proxy uses `app_metadata.role` only for redirects, with no fallback (§0.1 rule 9).
  - A **test suite asserts every role × table** permission (§14).
- **Service role:** only in `server/admin.ts`; never bundled for the browser (lint rule + build check).
- **Credential vault:**
  - AES-256-GCM with a random 12-byte IV per secret; the key comes from `CREDENTIAL_VAULT_KEY` (64 hex chars).
  - Ciphertext is prefixed with a key version (`v1:`) so the key can be **rotated** (a re-encryption job) without data loss.
  - Keep an offline copy of the key; **losing it makes every stored password unreadable**.
- **Files:** private buckets; signed URLs valid for 60 s, issued after an RLS check; MIME type checked by magic bytes, not just extension; max 25 MB; filenames sanitised.
- **Web hardening:**
  - **Headers:** CSP (self + Supabase + Resend + fonts), HSTS, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` minimal, `X-Robots-Tag: noindex` on everything except the login page.
  - **Cookies:** HttpOnly, Secure, SameSite=Lax.
  - **Server actions:** origin check on.
- **Input/output:** zod validation on client and server; never render user HTML (templates render plain text with variables escaped); rich text, if any, is sanitised.
- **Audit:** every mutation, sign-in, export and credential view.
- **Backups:**
  - Supabase point-in-time recovery on.
  - A nightly logical backup (`pg_dump`) to separate storage, encrypted, with 30 daily + 12 monthly copies kept.
  - Storage bucket backup weekly.
  - **A restore drill every quarter, recorded in the quality module.**
- **Data protection:** DPDP features (§6.10); no full Aadhaar; least data collected; retention rules.
- **TaxWise Desktop (§7.25.3):**
  - Electron's security checklist in full: context isolation, sandbox, no Node in pages, navigation and new-window allowlists, permission handlers, IPC sender checks, DevTools off, fuses.
  - Signed installers and updates.
  - WhatsApp data stays in one partition per number on the PC, and is wiped when a Partner removes the PC.
  - The app never reads, stores or sends WhatsApp messages.
- **Environments:** production and staging are separate Supabase projects. Production data never goes to staging (seed staging with synthetic data only).

## §13. Rate limits, reliability and performance
- **Rate limits** (Postgres or KV backed):
  - login: 5 per 15 min per email + IP;
  - password reset: 3 per hour per email;
  - public quotation responses: 10 per hour per token + IP;
  - portal uploads: 60 per hour per user;
  - general server actions: 300 per minute per user.
  
  Exceeding a limit returns a clear message and writes an audit event.
- **Error contract** (§0.1 rule 2): structured JSON logs `{ ts, level, ref, source, userId, role, err }`. Optional Sentry. Users see the Ref.
- **Concurrency:** edits send the `updated_at` they loaded. If the row changed since, the save is refused with "Changed by <name> at 12:41. Reload to see their changes." No silent lost updates.
- **Transactions:** onboarding, invoice issue, receipt, credit note and status changes with history are single transactions. Side effects run after the commit (§0.1 rule 5).
- **Email:** Resend idempotency keys per message, retried 3× with backoff, failures visible on the record.
- **Performance targets:** lists of 2,000 clients / 20,000 tasks paginate in < 300 ms server time. Pages are interactive in < 2 s on a mid-range phone over 4G. Indexes on every filter/sort column listed in §5; `pg_trgm` for search; no N+1 queries (fetch with joins or batched `in` queries); select only needed columns.
- **Accessibility:** keyboard-complete, visible focus, labelled controls, ARIA for dialogs/menus/tabs, contrast AA, reduced-motion respected, all charts with a table alternative.

## §14. Testing (required before each phase is "done")
- **Unit tests (Vitest)** for every pure function:
  - **Identifiers:** GSTIN checksum (incl. `29AAXFT1811B1Z3` valid; one changed character invalid), PAN/TAN/IFSC/UDIN, WhatsApp normalisation (all cases in §7.13.2), Gmail URL trimming (multi-byte).
  - **GST and money:** GST split (intra vs inter-state; odd-paise splits), rounding, number series (≤16 chars; FY rollover; concurrency), credit note deadline (s.34), Rule 47 warning.
  - **Settlement:** TDS suggestion and settlement maths; **"a draft invoice is never overdue"**; derived overdue for invoices and tasks.
  - **Calendar:** every due-date rule incl. QRMP 22nd/24th by state, the ITR-3/4 31 August rule, DIR-3 KYC triennial, AGM-linked ROC dates, March TDS deposit 30 April, and override application.
  - **Engines:** ITR computations against hand-worked cases for both regimes and both rule sets (incl. the ₹12 lakh rebate edge with marginal relief); GST recon tiers and buckets; Schedule III bucket mapping and checks.
  - **People and work:** capacity bands; presence (idle < stale invariant, capped credit, closing at last activity); task transitions (allowed moves, required reasons, who can file, dependency block); assignment checks.
  - **ICAI:** tax-audit ceiling counting rules (what counts, branch = head, revised excluded).
  - **Roles:** server checks use `profiles.role` even when `user_metadata.role` and a stale `app_metadata.role` say otherwise; the proxy never falls back to `user_metadata`.
  - **Cover rules:** in force or not; merging; which clients a person cover reaches; the 90-day cap.
- **Database tests:** for each role (partner, manager, employee, client) and each table, assert what SELECT/INSERT/UPDATE/DELETE may and may not do. In particular: **an Employee can never read invoices, receipts, fees or quotations; a client can never read another client's data; nobody can read credential ciphertext; editing `user_metadata.role` grants nothing.** Also:
  - A **client portal user** who sets `user_metadata.role` to `partner` gets nothing more than before.
  - An Employee can open a client's WhatsApp group only while they own the client, are on its team, or hold a cover in force.
  - Employees never receive `invite_link`.
  - The desktop device tables are readable only by Partners and Managers.
- **End-to-end (Playwright):** the §18.3 acceptance checklist, at 1366×768 and 390×844, in light and dark themes.
- **TaxWise Desktop:** use Playwright's Electron support (`_electron.launch`) to test:
  - the bridge;
  - the navigation and new-window guards;
  - the permission handlers;
  - which numbers each role can see;
  - client mode, against saved WhatsApp Web page fixtures (never the live WhatsApp in CI).

---

## §15. What changes compared with the current J-TACS build (and why)
Each of these fixes a real problem found in production or in review.

1. **Single-firm product.** Multi-tenancy, `firm_id` columns and public sign-up are removed; first-run setup instead. Removes a whole class of cross-tenant bugs (the old dashboard could aggregate other firms' data when its cached queries lost the tenant).
2. **Roles come from `app_metadata` + `profiles`, never `user_metadata`.** The old build fell back to `user_metadata.role`, which any signed-in user, client portal users included, can edit in their own browser: a client could make themselves a Partner of the firm. Its proxy used the same fallback for redirects, and a committed tool held a demo Partner's password in the public repository.
3. **Migrations, not `db push`;** a schema version check and a diagnostics page. The old production database drifted behind the code and every page failed on missing columns while looking like a login problem.
4. **Locked document number series**, GST-compliant (≤16 characters, FY-scoped). The old build used `count()+1` / `max()+1`, which can duplicate numbers.
5. **More than one Partner**, each with an ICAI membership number for UDINs and signatures.
6. **Working hours are editable** (they existed in the database with no screen).
7. **One calendar table** for statutory dates, internal prep steps and manual dates, with idempotent generation and **government extensions as data** (e.g. this year's tax audit extension to 21 Oct 2026).
8. **Law in data tables** (§5.12): rates, thresholds, due dates and section numbers versioned with sources, covering the Income-tax Act 2025 transition, GST 2.0 slabs and the DIR-3 KYC triennial rule.
9. **ICAI compliance built in:** UDIN 60-day tracking, the 60-tax-audit ceiling (from 1 Apr 2026), the company audit limit, KYC Norms, previous-auditor communication, SA 210 engagement letters, SQC 1 quality module (SQM-ready), peer review validity, SA 230 file assembly and retention.
10. **Audit engagements run stage by stage to the Standards on Auditing,** with evidence and sign-offs.
11. **Multi-line invoices** with SAC per line and **pure-agent reimbursements** without GST (the old build had one line per invoice).
12. **GST-correct corrections:** issued invoices are never edited. Cancel-and-reissue before reporting; credit/debit notes after. The s.34 credit note deadline is enforced.
13. **TaxWise's own GSTR-1 export** and sales register.
14. **TDS credit tracking** against Form 26AS / Form 168, with expected-TDS suggestions on the base excluding GST.
15. **UPI QR and deep link** on invoices and in the portal Pay dialog, plus "I've paid" notifications (never auto-marking an invoice paid).
16. **Email you can trust:** a domain verification wizard with real DNS records, status mirrored from Resend, bounce handling, and **WhatsApp and Gmail hand-offs everywhere**, shown prominently when automatic sending fails.
17. **WhatsApp bulk queue:** personalised drafts stepped through one by one, each logged as "handed off".
18. **Employee email is editable,** and the login moves with it (the old build locked the field with no explanation).
19. **Work after a save never fails the save** (the old onboarding reported "unexpected error" for clients that had been created, which produced duplicates).
20. **Dialog footers are never clipped** (the old onboarding's Complete button was cut off on 1366×768 laptops).
21. **Layout-level failures degrade gracefully** instead of blanking the app, and every error carries a findable Ref.
22. **Overdue is derived** for tasks and invoices; one-way flags are gone. Drafts are never overdue.
23. **Task status history** with reasons; `@mentions`; recurring task automations; a review queue that notifies the named reviewer personally.
24. **Duplicate client guard** on PAN, GSTIN and similar names, and a conflict check before acceptance.
25. **Saved views, a column chooser and an Inbox** that puts approvals, reviews and client messages in one place.
26. **Mobile experience for Employees:** a bottom tab bar, a one-tap timer, "My day".
27. **MFA for Partners and Managers,** vault key rotation, quarterly access reviews, a restore drill.
28. **DPDP-ready:** privacy notice, consent records, data requests, incident log, no full Aadhaar storage.
29. **Separate staging environment.** Production is never used for testing, and pushes to the development branch never reach the live firm.
30. **Optimistic concurrency** on edits, so two people editing the same client can't silently overwrite each other.
31. **WhatsApp Web inside the CRM** (§7.25).
    - TaxWise Desktop shows each client's WhatsApp group beside the client page.
    - Employees see only their own and covered clients' chats (client mode).
    - Every client's group is set up the same way, from a checklist.
32. **Cover access** (§4.7). A Partner or Manager can give a colleague time-limited, logged access to one client, or to all of an absent person's clients, from leave approval or at any time. It ends by itself.

---

## §16. Seed data (production): this and nothing else
- **Firm and numbering:**
  - `firm_settings` from §1 (logo, bank, UPI, FRN and membership numbers left empty for the setup checklist).
  - `number_series` for invoice, credit note, quotation, receipt, client code, task and lead, starting at 1 for FY 2026-27.
- **Law tables:**
  - `statutory_parameters` from §6.4–§6.6, §6.8 and §6.11.
  - `due_date_rules` from §6.7.
  - `due_date_overrides`: **TAX_AUDIT_REPORT AY 2026-27 → 21 Oct 2026** and **ITR_AUDIT AY 2026-27 → 21 Nov 2026** (CBDT Circular 07/2026 dated 28 Sep 2026).
  - `section_concordance` from §6.1, with every row `verified = false` until a Partner confirms it.
- **Templates:**
  - `recurring_compliance_templates` from §7.7.
  - **Job templates**, each with steps and offset days:
    - **Monthly GST filing:** collect sales register (−9), collect purchase register (−9), GSTR-2B/IMS reconciliation (−6), review auto-populated liability and correct through GSTR-1A if needed (−5), prepare GSTR-1 (−4), file GSTR-1 & record ARN (0), file GSTR-3B & record ARN (by the 3B date).
    - **Quarterly TDS return:** reconcile challans (−10), compile deductee data (−7), validate FVU (−3), file return (0), download Conso & issue Form 16A/131 (+15).
    - **ITR (non-audit):** collect Form 16/130 (−30), download AIS/26AS/168 (−25), compute income & compare regimes (−15), client approval (−7), file & e-verify (0).
    - **Tax audit:** the §6.9 stages, ending with the report in Form 3CA/3CB-3CD or Form 26, UDIN, and the ceiling check.
    - **Statutory audit (Companies Act):** the §6.9 stages, with CARO and ADT-1 / AOC-4 hand-offs.
    - **GST annual return (GSTR-9/9C)** · **Monthly bookkeeping** · **ROC annual filing** (AOC-4, MGT-7/7A after the AGM, ADT-1) · **LLP annual filing** (Form 11, Form 8) · **Incorporation** · **Certification** (UDIN).
  - **Message templates:** one per type in §7.13.4, in a warm, professional Indian-English tone.
  - **Quotation terms:** fees exclusive of GST at the applicable rate; out-of-pocket expenses and government fees at actuals; penalties/late fees arising from late information not included; scope limited to the listed services; timelines depend on complete information from the client; an engagement letter follows acceptance; payment terms as stated; subject to Bengaluru jurisdiction.
  - **Invoice terms:** payment due within the stated days; quote the invoice number; please issue TDS certificates in time; bank and UPI details; Bengaluru jurisdiction.
  - **Privacy notice v1:** draft text for the Partners to approve, listing WhatsApp groups with our team as a communication channel.
- **WhatsApp (§7.25):**
  - `firm_whatsapp_numbers`: five inactive slots with no number yet, which Partners fill in under Settings → WhatsApp (a Setup checklist item):
    - "CA Vinay H Karlagere (Partner)", "Partner 2", "Partner 3" (`usable_by = {partner}`, owner only);
    - "Managers' office" (`group_admin`, `shared`, `usable_by = {partner, manager}`);
    - "Staff office" (`shared`, `usable_by = {partner, manager, employee}`).
  - Message template **WhatsApp group welcome** (channel WhatsApp): "Welcome to the {{firm_name}} group for {{client_name}}. Our Partners, our Managers' desk and our team desk are all here, and our team sign their messages with their name. For anything urgent, please call {{firm_phone}}."
  - `firm_settings.whatsapp_house_rules`: the text of §7.25.10.
- **No clients, leads, tasks, invoices or demo users.** Staging gets synthetic data from a separate script that refuses to run when `APP_ENV=production`.

---

## §17. Environment variables (document each in `.env.example` by what breaks without it)
| Variable | Purpose |
|---|---|
| `APP_ENV` | `production` or `staging` (guards seed scripts and banners) |
| `NEXT_PUBLIC_APP_URL` | Public URL, used in links in emails and WhatsApp drafts |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Client and session |
| `SUPABASE_SERVICE_ROLE_KEY` | `server/admin.ts` only (create users, change auth email, jobs, vault) |
| `DATABASE_URL` | Pooled connection for the app (transaction pooler) |
| `DIRECT_URL` | Direct/session connection for **migrations**. Schema changes can't run through the transaction pooler; they hang. |
| `CREDENTIAL_VAULT_KEY`, `CREDENTIAL_VAULT_KEY_VERSION` | Portal-password encryption (64 hex chars; keep an offline copy) |
| `CRON_SECRET` | Authenticates scheduled jobs; without it nothing runs on schedule |
| `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `EMAIL_FROM`, `EMAIL_REPLY_TO` | Email |
| `FIRST_PARTNER_EMAIL` | Bootstrap only (§4.3) |
| `NEXT_PUBLIC_DESKTOP_DOWNLOAD_URL` | Where Settings → WhatsApp links to the TaxWise Desktop installer (§7.25) |
| `TAXWISE_APP_URL` (desktop build only) | The CRM URL TaxWise Desktop loads, set at build time in `desktop/`. Code-signing secrets live in CI, never in the repository |
| `SENTRY_DSN` | Optional error tracking |

Ship `npm run env:check`. It exits non-zero on missing or malformed required values and flags example values left in place.

---

## §18. Build order and acceptance
### 18.1 Phases (stop and demo after each)
0. **Foundation:** project, design system (§3), app shell, auth + first-run setup + forced password change + MFA (§4), RLS helpers, Settings → Firm details, diagnostics (§7.24), error contract, CI with tests.
1. **People and clients:** staff lifecycle (§4.5), clients list + onboarding wizard + Client 360 (Overview, Profile & contacts, Documents), groups, document vault.
2. **Law and calendar:** §5.12 tables + Law & rules page; statutory engine; compliance events; filings grid; calendar; extensions.
3. **Work:** tasks (acceptance, transitions, review, dependencies, checklists, templates, filing capture, escalation), timesheet, presence & attendance, leave & capacity, cover access (§4.7).
4. **Growth:** leads, quotations, approvals, public page, follow-ups, conversion, conflict check.
5. **Money:** invoices (multi-line, approvals, numbering, PDF), receipts (TDS), credit/debit notes, collections and reminders, retainers, TDS credits, GSTR-1 export, payments dashboard, statement of account.
6. **Communication:** WhatsApp hand-off (§7.13.2), Gmail hand-off, Resend + domain wizard, templates, bulk queue, Inbox/notifications, client portal (§7.22), client WhatsApp groups (register, checklist and browser window; §7.25.1, §7.25.2, §7.25.8). Then **TaxWise Desktop** (§7.25.3–§7.25.7), built with Claude Code or Cursor and piloted on two PCs with the Staff office number before rolling out.
7. **Practice:** workpapers (GST recon, ITR, financial statements, notices), registers (vault, registrations, DSC, UDIN + ceiling), engagement letters, filing history, quality, audit engagements (§6.9), DPDP features.
8. **Insight and admin:** reports, search, recycle bin, audit log, exports.
9. **Hardening:** full RLS test suite, e2e suite, performance, accessibility, responsive and dark-mode QA, backups and restore drill, go-live checklist.

### 18.2 Go-live checklist
- Production Supabase: migrations applied in order; `schema_version` matches; RLS on for every table (query `pg_tables` to prove it); PITR on.
- `env:check` passes. `CREDENTIAL_VAULT_KEY` set and backed up **before** any credential is stored.
- Email domain **Verified** in Resend; test email received; bounce webhook working.
- Cron jobs registered; each has run once successfully (visible in diagnostics).
- First Partner created via `/setup`; `/setup` now 404s.
- Every Partner has MFA enrolled.
- No demo or test accounts in production Auth; no passwords or keys anywhere in the repository; the repository is private.
- Firm WhatsApp numbers entered. Each office phone has two-step verification on and a named custodian.
- TaxWise Desktop (signed) installed on the office PCs that will hold WhatsApp, within the device limit.
- Law & rules page reviewed and **every [verify] item confirmed or corrected** by a Partner.
- Staging exists and holds no real data. The live firm uses the production domain only.

### 18.3 Acceptance tests (run as each role; all must pass)
**Partner**
1. Completes first-run setup, uploads the logo, sets bank/UPI/FRN/membership number, verifies the email domain.
2. Adds a Manager and an Employee. Both get temporary passwords on screen (and by email once verified), and both are forced to set their own password on first sign-in.
3. Onboards a GST-registered Pvt Ltd client in Karnataka with GST (QRMP) + income tax + audit:
   - the GSTIN checksum is validated;
   - QRMP GSTR-3B events land on the **22nd**;
   - the tax audit indication appears;
   - KYC and the previous-auditor step block the audit engagement until completed;
   - the onboarding footer buttons are visible at 1366×768.
4. Adds a CBDT extension override and sees the matching unfiled events move with the circular cited.
5. Approves a Manager's invoice that is over the limit, then sees it sendable.
6. Issues a credit note within the s.34 window; is blocked after it for a tax-reducing note.
7. Logs UDINs and sees the tax-audit ceiling count, with the counting rules applied.
8. Reveals a portal password and sees it in the access trail and the audit log.
9. Restores a deleted client from the recycle bin.
10. Enters the five firm WhatsApp numbers. Onboards a client, follows the WhatsApp group checklist and marks the group created; it shows as Active with six members.
11. In TaxWise Desktop, links their own number on their own PC and clicks **Open chat** on that client. The group opens in the panel beside the client page, and the audit log shows the open. On another user's PC, their number never appears.
12. Gives Employee 2 cover for XYZ Traders (Employee 3 is its preparer) until tomorrow evening:
    - in TaxWise Desktop, Employee 2 can open XYZ Traders' chat in client mode at once;
    - Employee 4 can't open it, and gets "Not one of your clients" if they reach it another way;
    - the audit log and the client timeline record the grant;
    - after the end time Employee 2 can't open it, and an open chat closes within 5 minutes.
13. Removes a PC in Settings → Linked PCs. At its next start the PC's WhatsApp data is gone, and the desktop API refuses it.

**Manager**
1. Cannot open firm Settings, Payments or the Audit log, or create a Manager. Each is refused, with an explanation, in the UI and by the database.
2. Creates a quotation over the quotation approval limit and can't send it until a Partner approves it.
3. Assigns a task to an Employee on leave on the due date (warning shown), and to a disabled employee (blocked).
4. Reviews an Employee's task, sends it back without a reason (refused), then with one (works; the Employee is notified).
5. Records a receipt with TDS under the professional-fees rate. The outstanding amount updates and the status derives to Paid.
6. Approves Employee 3's leave and, when asked, has Employee 2 cover all of Employee 3's clients for those days. Once the leave ends, Employee 2 no longer sees them, and Employee 3 gets the "see what changed" link.

**Employee**
1. Sees only clients they own or are on the team for. Search, URL guessing and the API all return nothing for other clients.
2. Sees **no fees, invoices, receipts, quotations or leads anywhere**.
3. Accepts a task, starts the timer, moves it to Data awaited, sends a WhatsApp hand-off asking the client for data (logged as "handed off"), and submits Under review. **Cannot** set Filed/Done.
4. Declines a task with "No capacity this week". The task is unassigned and the Manager is notified.
5. Requests leave. Approval marks the days On leave.
6. On a phone: My day, the timer and tasks all work with the bottom tab bar.
7. Editing their own `user_metadata.role` to `partner` from the browser console **grants nothing**.
8. In TaxWise Desktop with client mode on, sees only the chat opened from the CRM. Opening any other chat closes it with "Not one of your clients".
9. Downloads a PDF the client sent in the group and saves it to that client's documents from the prompt; saving it to the PC isn't offered.
10. With one entry in `selectors.ts` deliberately broken, the panel fails closed and Partners are told.

**Client (portal)**
1. Accepts the invite, sets a password, acknowledges the privacy notice.
2. Sees only their own deadlines, compliance status, documents, invoices and messages.
3. Uploads a requested document. Staff reject it with a reason, and the client re-uploads.
4. Opens an invoice, scans the UPI QR, taps "I've paid". The firm is notified; the invoice is **not** auto-marked paid.
5. Accepts a quotation on the public page by typing their name. A superseded quotation's old link refuses a response.
6. Editing their own `user_metadata.role` to `partner` from the browser console grants nothing: they stay in the portal, and Partners see the attempt in the audit log.
7. Never sees WhatsApp chats in the portal.

---

## §19. Sources checked for §6 and §7.25 (October 2026). Re-check before relying on any [verify] item
- **Income-tax Act 2025, section mapping and forms:**
  - [Income Tax Act 2025 vs 1961: section mapping (TaxGuru)](https://taxguru.in/income-tax/income-tax-act-2025-1961-section-mapping-cheat-sheet-sections-day.html)
  - [Overview of key provisions of the Income-tax Act, 2025 (EIRC of ICAI)](https://eirc-icai.org/uploads/background_materials/Overview%20of%20key%20provisions%20of%20Income-Tax%20Act,%202025_1776429283.pdf)
  - [Income Tax Act 2025: TDS and TCS changes (Zoho)](https://www.zoho.com/books/academy/in/taxes-and-compliance/income-tax-act-tds-tcs-updates-india.html)
  - [New income tax forms (ClearTax)](https://cleartax.in/s/new-income-tax-forms)
  - [Income tax forms renumbered from FY 2026-27 (StudyCafe)](https://studycafe.in/income-tax-forms-renumbered-from-fy-2026-27-key-changes-under-the-income-tax-act-2025-411260.html)
- **TDS under s.393:**
  - [Section 393: unified TDS framework (India Briefing)](https://india-briefing.com/news/section-393-income-tax-act-2025-tds-rules-rates-compliance-guide-44450.html/)
  - [TDS master sheet from 1 April 2026 (TaxGuru)](https://taxguru.in/income-tax/tds-rates-income-tax-act-2025-1-april-2026.html)
- **Slabs and due dates:**
  - [Income tax slabs (Tata Capital)](https://www.tatacapital.com/blog/wealth-services/personal-income-tax-slabs/)
  - [ITR-3/ITR-4 due date 31 August (CalcGuru)](https://calcguru.in/itr-due-date-ay-2026-27/)
  - [ITR-3/ITR-4 due date extended (Patron Accounting)](https://www.patronaccounting.com/blog/itr-3-itr-4-due-date-extended-august-31)
  - [CBDT extends AY 2026-27 tax audit date to 21 October 2026 (TaxGuru)](https://taxguru.in/income-tax/cbdt-extends-ay-2026-27-tax-audit-date-21-october-2026.html)
  - [CBDT extension of tax audit and ITR due dates (CAclubindia)](https://www.caclubindia.com/news/cbdt-extends-tax-audit-due-date-for-ay-2026-27-to-21st-october-2026-itr-deadline-moved-to-21st-november-26821.asp)
- **GST:**
  - [GSTR-3B hard-locking advisory (MahaGST)](https://www.mahagst.gov.in/public/uploads/gstnadvisory/1760597577_326%20Attention%20%E2%80%93%20Hard%20-%20Locking%20of%20auto-populated%20liability%20in%20GSTR-3B.pdf)
  - [Hard-locking in GSTR-3B (ClearTax)](https://cleartax.in/s/hard-locking-in-gstr-3b)
  - [56th GST Council meeting overview (TaxGuru)](https://taxguru.in/goods-and-service-tax/56th-gst-council-meeting-overview.html)
  - [New GST rates from 22 September 2025 (Tally)](https://tallysolutions.com/gst/new-gst-rates-september-2025-business-impact/)
  - [GST compliance calendar FY 2026-27 (LegalWiz)](https://www.legalwiz.in/blog/gst-compliance-calendar-for-fy-2026-2027)
- **ICAI:**
  - [ICAI announcement deferring SQM 1 and SQM 2](https://icai.org/post/announcement-on-deferment-of-effective-date-of-sqm-1-and-sqm-2)
  - [FAQs on UDIN ceiling on tax audit (ICAI UDIN portal)](https://udin.icai.org/assets/images/FAQs_on_UDIN_Ceiling_on_Tax_Audit.pdf)
  - [UDIN generation within 60 days of signing (TaxGuru)](https://taxguru.in/chartered-accountant/icai-udin-generation-60-days-signing-certificates-reports-document.html)
  - [Peer review mandate roll-out (ICAI)](https://icai.org/post/peer-review-mandate-roll-out-revised)
  - [Mandatory client KYC norms for CAs (TaxGuru)](https://taxguru.in/chartered-accountant/mandatory-client-kyc-norms-compliance-ca-cas-practice.html)
- **MCA:**
  - [ICAI CLCGC note on director KYC compliance](https://www.icai.org/post/clcgc-director-kyc-compliance-02012026)
  - [ROC and MCA compliance calendar 2026 (StudyCafe)](https://studycafe.in/roc-and-mca-compliance-calendar-2026-key-filing-due-dates-for-companies-and-llps-423549.html)
- **CARO:** [CARO 2020 for FY 2025-26 (CA Surekha Ahuja)](https://www.casahuja.com/2026/08/caro-2020-for-fy-2025-26-ultimate.html)
- **DPDP:**
  - [DPDP Rules, 2025 (PIB)](https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/nov/doc20251117695301.pdf)
  - [DPDP Act 2023 brought into force (Hogan Lovells)](https://www.hoganlovells.com/en/publications/indias-digital-personal-data-protection-act-2023-brought-into-force-)
- **WhatsApp and TaxWise Desktop (§7.25):**
  - [How to link a device (WhatsApp Help Center)](https://faq.whatsapp.com/1317564962315842/)
  - [About multi-agent (WhatsApp Help Center)](https://faq.whatsapp.com/395911122612120/)
  - [About unofficial apps (WhatsApp Help Center)](https://faq.whatsapp.com/1217634902127718/)
  - ["WhatsApp works with Google Chrome" user-agent block (Vivaldi forum)](https://forum.vivaldi.net/topic/37417/error-whatsapp-works-with-google-chrome-36)
  - [Migrating from BrowserView to WebContentsView (Electron blog)](https://electronjs.org/blog/migrate-to-webcontentsview)
  - [Security checklist (Electron)](https://www.electronjs.org/docs/latest/tutorial/security)
  - [Electron in Playwright](https://playwright.dev/docs/api/class-electron)
  - [Groups API (Meta for Developers)](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/)
  - [Get started with the Groups API (Meta for Developers)](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/get-started/)
  - [Onboarding WhatsApp Business app users: group chats are not synchronised under coexistence (Meta for Developers)](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users)

*End of specification. Build it phase by phase, stop after each one for a demo, and don't skip any test in §14.*
