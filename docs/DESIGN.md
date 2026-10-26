# Design brief: TaxWise Practice OS

Read this before building any screen. It merges three sources, in this order of authority:

1. **The spec, §3** (`docs/SPEC.md`): tokens, type scale, shell, patterns, status vocabulary. Where the
   spec is explicit, it wins.
2. **taste-skill, app-screens** (`.claude/skills/taste-skill/references/app-screens.md`): how working
   screens look when someone decided them, not a template. Read §§5–11 and 13–14 of that file before
   building dashboards, tables, settings or empty states.
3. **ui-ux-pro-max** (`.claude/skills/ui-ux-pro-max/`): accessibility, forms, interaction and
   Next.js/shadcn guidance. Query it for a specific concern:
   `python3 .claude/skills/ui-ux-pro-max/scripts/search.py "<concern>" --domain ux` (or `--stack shadcn`, `--stack nextjs`).
   Before calling a screen done, run its pre-delivery checklist (below).

Its design system search for this product returned **Minimalism & Swiss style, light-first, dense
dashboard (density 8/10), subtle motion (2/10)**. That matches the spec: calm, precise, premium, like a
well-run CA office.

## 1. The product's face

- **Who:** Partners and Managers in long daily sessions at a 1366×768 office laptop; Employees on the
  same laptops and on phones (My day, timer, tasks); clients on phones (portal).
- **One question per screen.** Name it before building and make the biggest block answer it:
  - Partner dashboard: "What needs my decision today, and is the firm on time and getting paid?"
  - Manager dashboard: "Who is stuck, who is over capacity, and what is due this week?"
  - My day: "What do I do next?"
  - Filings grid: "Is everyone's GSTR-3B filed for September?" (§7.7)
  - Client 360: "What's the state of this client: deadlines, open work, money, contact?"
  - Invoices: "What's outstanding, and what's overdue?"
- **Signature elements** (only this product has them; build them properly):
  - the **filings grid**: clients × periods, each cell a status mark (§7.7);
  - the **TW monogram** in `--accent-gold` on a `--brand-navy` band at the top of the sidebar, and
    "Powered by **J-TACS**" small in gold-text at the foot (§0, §3.3);
  - the **FY switcher** (`2026-27`) in the top bar;
  - **Indian money**: `₹1,23,456.00`, lakh/crore words on invoices, `₹12.3L` only on dashboard figures
    with the full value on hover;
  - **relative due dates** beside every due date ("in 3 days", "2 days overdue"), coloured by urgency.
- **Words of the trade** everywhere: "Data awaited", "Filed", "Under review", "Sent back", "ARN",
  "UDIN", "Place of supply", "AY 2026-27" / "Tax year 2026-27". Never "Items", "Records", "Completed".

## 2. Tokens (already in `app/globals.css`; never hard-code hex in components)

Use Tailwind classes mapped to the tokens: `bg-bg`, `bg-surface`, `bg-surface-2`, `text-text`,
`text-text-muted`, `border-border`, `bg-primary`, `text-primary`, `bg-primary-soft`, `bg-brand-navy`,
`text-gold-text`, `bg-gold`, and status: `text-success-text`, `bg-success-soft`, `bg-success` (dot), and
the same for `warning`, `danger`, `info`, `violet`.

**Contrast rule we added:** the spec's light-theme `--success`, `--warning` and `--accent-gold` fail
WCAG AA as text (3.2–3.5:1). Use them for dots, bars and fills only. **Text always uses the `*-text`
variant** (all ≥ 4.5:1 on surface, surface-2 and bg, both themes).

Type scale (§3.2), as Tailwind sizes: `text-xs` 12 · `text-sm` 13 · `text-base` 14 (body) · `text-md` 16
· `text-lg` 20 · `text-xl` 24 · `text-2xl` 30. Never more than three sizes on one screen. Page titles
`text-xl font-semibold` (24/600). Card titles `text-md font-semibold` (16). Labels/meta `text-xs` or
`text-sm` in `text-text-muted`. Every number, amount and date: class `num` (tabular figures) and
right-aligned in tables.

Radius: inputs/buttons `rounded-md` (8) · cards `rounded-lg` (12) · dialogs/sheets `rounded-xl` (16) ·
chips `rounded-full`. Spacing: 4-point base; page padding 24 desktop / 16 mobile; 16–24 between cards.
Density: table row height `var(--row-height)` (44, or 36 in compact mode).

## 3. House rules for app screens (taste-skill, adapted to the spec)

| Do | Don't |
|---|---|
| Cards separated by a 1px `border-border` on `bg-surface`, **no shadow at rest** | Shadows on resting cards; a border *and* a shadow; glass/blur; gradients anywhere |
| Shadows (`shadow-2`) only on what floats: menus, popovers, dialogs, sheets, toasts | |
| KPIs as **type**: one container split by 1px dividers, label (12–13 grey) above value (24, `num`) | KPI tiles with an icon in a tinted circle; sparklines on KPIs; values ≥ 48px |
| One figure is the answer and is the largest (30px max) | Several equal-sized "hero" numbers |
| Deltas in words with their baseline ("vs last month"); colour = good/bad, not up/down; zero is grey | A green "+12%" on everything; colour on a zero change |
| Colour on **data and status** only, plus the primary action | Accent on chrome: tinted tab pills, coloured icons per category |
| Tables: 12–13px grey sentence-case headers, no zebra, row rules 1px, numbers right-aligned `num`, identity column widest | Uppercase tracked headers, zebra stripes, left-aligned numbers |
| Sticky table header on `bg-surface-2` (it must cover scrolling rows) — the one band allowed | Fill bands elsewhere |
| Status as `StatusChip`: coloured dot + **ink** label (grey for muted states), pale tint pair only when a pill is needed; hover explains (§3.4) | Saturated chips with white text; status by colour alone; a column of coloured labels |
| Red is a signal: one red mark per fact (an overdue date, overdue money); normal states stay grey (capacity CLEAR, Low/Medium priority) | Red on every row (priority label *and* due date *and* counts) |
| Missing value = grey em dash; real zero printed (`₹0.00`, `0`) | `--` at value size; blank cells |
| Empty section keeps its frame + header + one sentence + one action (§3.4) | Illustrations, "No data" pictures, emoji |
| Loading = skeletons at the real size of the content, no shimmer gradient, no layout shift | Full-page spinners after first paint |
| Error inside the block that failed, one sentence, the **Ref**, a Retry | Full-screen error banners for a block failure |
| Charts (Recharts): one series per chart, one hue (`--chart-1`), 3–5 faint horizontal gridlines, no y-axis line, no legend for one series, straight lines, square bars, round ticks; every chart has a table alternative (§13) | Rainbow charts, smoothed splines, gradient area fills, rotated x labels, donuts with labels on slices |
| Icons: lucide outline, 16px in nav/buttons, 14px inline, grey | Icons in coloured boxes repeated down a list |
| Row actions: icon-only buttons are **ghost** (no box); one kebab for the rest; a row's lesser answer (Decline) is ghost beside an outlined main answer | A bordered box around every icon in every row |
| Nav active item: `bg-primary-soft` with `text-primary` label (spec §3.1) | A coloured left bar *and* a fill |
| One filled primary button per screen (spec: `--primary` blue), the page's own; the sidebar's "+ New" is outlined. Secondary: outline. Tertiary: ghost/text | Brand fill on every button; two blue fills on one screen |
| Dashed borders only for empty slots and drop zones | Dashed filter chips or controls |
| Sentence case everywhere | ALL-CAPS labels (one exception: none) |
| Titles are nouns ("Clients", "Firm today") | "Welcome back 👋", hero headers |
| Emoji: never as icons or decoration | |

The spec asks for a navy band at the top of the sidebar (logo area) and a navy login panel: keep those
as the brand moments. The rest of the sidebar is `bg-surface` with a right `border-border` (taste: no
dark or saturated sidebar).

## 4. Patterns (build once in `components/app/`, reuse everywhere)

- **PageHeader**: title (h1, 24/600), one-line description (13–14 grey, about the data, not the
  interface), primary action at right; breadcrumbs above on detail pages.
- **FilterBar**: search (debounced, URL-synced), filter chips, saved views, column chooser, export —
  one row of controls above the list: the first 4 chips inline (`maxInline`), the rest behind
  "More filters"; a filter in use always shows as a chip.
- **Sibling-page navs** (Workpapers, Growth): a quiet row of links above the title, the open one in
  ink, counts as small pills; never a second segmented control above the page's own view switch.
- **DataTable**: server-paginated (25/50/100), sortable headers (sort glyph on active column only),
  checkbox bulk actions, row click → detail, column chooser, CSV export of the current view, sticky
  header; below 768px rows become stacked cards with the 3–4 key fields (§3.3).
- **StatusChip**: from `lib/status.ts` (every §3.6 enum: label, tone, meaning, "what happens next").
- **Money**, **DateText** (with relative urgency), **CopyButton** (PAN, GSTIN, TAN, codes, ARNs).
- **FormDialog / FormSheet / Wizard**: sticky footer (`position: sticky; bottom: 0; flex-shrink: 0`),
  scrollable body, `max-height: min(…, 92dvh)`, unsaved-changes guard, "Draft saved · 12:41" stamp.
- **ConfirmDialog**: says exactly what will happen; type-to-confirm for purges.
- **EmptyState** (icon, one sentence, one action) and **FilteredEmpty** ("No results for these filters" + Clear).
- **KpiStrip**: one bordered container, equal columns split by 1px dividers; 2-column grid on phones.
- **Section card**: header row (16/600 title, optional right-aligned period/action), body, optional
  "View all" — overviews show 4–6 rows, never paginate.

## 5. Forms (ui-ux-pro-max: forms & feedback)

Labels above fields (13–14/500), helper text below, `*` for required. Validate on blur and on submit;
server field errors land on the field; a form-level alert summarises and receives focus after a failed
submit. Inputs 36–40px tall, `rounded-md`, white (`bg-surface`) even on grey. Two columns on desktop,
one on mobile, sections in cards. Disabled controls stay legible and say why (tooltip).

## 6. Interaction & motion

150–200ms ease-out on hover, expand and dialog enter; nothing performs an entrance; respect
`prefers-reduced-motion` (global rule in globals.css). Touch targets ≥ 44px on phones. Visible focus
ring (`ring-ring`), keyboard-complete; `⌘K` search, `N` new, `G C/T/I`, `?` shortcuts, `Esc` closes.

## 7. Responsive

Test at **1366×768**, **768×1024** and **390×844** (§0.1 rule 4), plus dark mode. Sidebar 260px
(collapsible to a 64px rail) from 1024px; always the 64px rail from 768 to 1023px (tablets, and the
Desktop app beside WhatsApp); a drawer below 768px. Employees get the bottom tab bar (Today · Tasks ·
Timer · Clients · More). No horizontal page scroll ever; wide tables scroll inside their own frame with
the first column fixed, or become card lists. Cards that share a row share a bottom edge (stretch the
last card and pin its "View all"), or keep their own height when stretching would leave a hole.

## 8. Pre-delivery checklist (ui-ux-pro-max + spec §0.2)

- [ ] Contrast ≥ 4.5:1 for all text (use `*-text` tokens for status text), focus visible, labels on every control, icon-only buttons have `aria-label`
- [ ] Loading, empty, filtered-empty, error and success states designed
- [ ] Works at 1366×768 and 390×844, light and dark; dialog footers visible
- [ ] Numbers right-aligned with tabular figures; money in Indian grouping; dates `22 Oct 2026`
- [ ] No emoji icons, no gradients, no glass, no shadows on resting cards, no zebra, no uppercase headers
- [ ] Status never by colour alone; chips explain themselves on hover/tap
- [ ] Role-correct: hidden for roles that can't use it, and refused by the server/RLS anyway

## 9. UI review log

- **Oct 2026, taste-skill app run** (`draw.mjs --app --kind finance --keep palette,type`, style
  *achromatic ledger*, seed 646198405; the dealt shell was not used because §3.3 fixes the shell).
  Measured with `inspect.mjs --app` at 1440/768/390 before and after. Fixed: sideways scroll at 768px
  on every staff screen (tablet rail), coloured status labels (ink labels, violet text gone), dashed
  and wrapping filter chips (one row, "More filters"), boxed icon buttons in rows, two filled primaries
  per screen, the Partner setup checklist dominating Firm today, the declined task listed twice on Team
  today, ragged/void rows on both dashboards and the UDIN register. Kept on purpose: the spec's violet
  for Under review (now a dot only), `--info` blue, the navy login panel, monospace for IDs.
