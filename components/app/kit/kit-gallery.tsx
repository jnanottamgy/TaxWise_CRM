"use client"

import * as React from "react"
import Link from "next/link"
import { ChevronRightIcon, DownloadIcon, PlusIcon, ReceiptIcon } from "lucide-react"
import { toast } from "sonner"
import { useTheme } from "next-themes"
import { gmailComposeUrl, waMeUrl } from "@/lib/domain/messaging"
import { cn } from "@/lib/utils"
import { STATUS_VOCABULARY, statusOptions, type StatusKind } from "@/lib/status"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { PageHeader } from "@/components/app/page-header"
import { SectionCard } from "@/components/app/section-card"
import { Delta, KpiStrip } from "@/components/app/kpi-strip"
import { DefinitionList } from "@/components/app/definition-list"
import { StatusChip } from "@/components/app/status-chip"
import { PriorityChip } from "@/components/app/priority-chip"
import { RoleBadge } from "@/components/app/role-badge"
import { Money } from "@/components/app/money"
import { DateText } from "@/components/app/date-text"
import { CopyButton } from "@/components/app/copy-button"
import { MonoId } from "@/components/app/mono-id"
import { EmptyState } from "@/components/app/empty-state"
import { FilteredEmpty } from "@/components/app/filtered-empty"
import { ErrorBlock } from "@/components/app/error-block"
import { FormAlert } from "@/components/app/form/form-alert"
import { SkeletonCard, SkeletonDetailHeader, SkeletonKpiStrip, SkeletonPageHeader, SkeletonTable } from "@/components/app/skeletons"
import { Keys, ShortcutSheet } from "@/components/app/shortcut-sheet"
import { BarChartCard, LineChartCard, StackedBarCard } from "@/components/app/charts/chart-cards"
import { WhatsAppButton } from "@/components/app/messaging/whatsapp-button"
import { GmailButton } from "@/components/app/messaging/gmail-button"
import { KitTable, KitTableStates } from "@/components/app/kit/kit-table"
import { KitFormDemos } from "@/components/app/kit/kit-forms"
import { KIT_BILLING_BY_SERVICE, KIT_COLLECTIONS, KIT_FILED, type KitClientRow } from "@/components/app/kit/sample-data"
import type { SortDir } from "@/components/app/data-table/params"

/* The UI kit gallery: every TaxWise pattern in every state, for visual QA. Development only. */

const TODAY = "2026-10-22"

const SECTIONS = [
  { id: "themes", label: "Light and dark" },
  { id: "type", label: "Type and buttons" },
  { id: "headers", label: "Page header" },
  { id: "kpis", label: "KPI strip" },
  { id: "cards", label: "Section cards" },
  { id: "status", label: "Status vocabulary" },
  { id: "values", label: "Money, dates, codes" },
  { id: "table", label: "Data table" },
  { id: "table-states", label: "Table states" },
  { id: "feedback", label: "Empty, error, loading" },
  { id: "forms", label: "Forms and dialogs" },
  { id: "charts", label: "Charts" },
  { id: "messaging", label: "WhatsApp and Gmail" },
  { id: "keyboard", label: "Keyboard" },
]

// The real hand-off builders (lib/domain/messaging.ts), so the kit shows exactly what features send.
const kitWhatsAppUrl = (digits: string, text: string) => waMeUrl(digits, text)
const kitGmailUrl = (f: { to: string; cc?: string; bcc?: string; subject: string; body: string }) => gmailComposeUrl(f)

function Section({ id, title, description, children }: { id: string; title: string; description?: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-6">
      <h2 id={`${id}-h`} className="text-lg leading-7 font-semibold text-text">
        {title}
      </h2>
      {description ? <p className="mt-0.5 mb-4 max-w-[72ch] text-base text-text-muted">{description}</p> : <div className="mb-4" />}
      {children}
    </section>
  )
}

function Label({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-2 text-sm font-medium text-text-muted">{children}</h3>
}

// --- Theme and density switches (they change <html> classes, so menus and dialogs follow) --------

function subscribeHtmlClass(cb: () => void) {
  const obs = new MutationObserver(cb)
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
  return () => obs.disconnect()
}

function useHtmlClass(name: string): boolean {
  return React.useSyncExternalStore(
    subscribeHtmlClass,
    () => document.documentElement.classList.contains(name),
    () => false
  )
}

function Segmented({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: Array<{ value: string; label: string }>
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-md border border-text-muted/30 bg-surface p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-7 cursor-pointer rounded-[6px] px-2.5 text-sm transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring pointer-coarse:h-10",
            value === o.value ? "bg-primary-soft font-medium text-primary" : "text-text-muted hover:text-text"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function DisplayControls() {
  const { setTheme } = useTheme()
  const dark = useHtmlClass("dark")
  const compact = useHtmlClass("density-compact")
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented
        label="Theme"
        value={dark ? "dark" : "light"}
        options={[
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
        ]}
        // Through next-themes (app/providers.tsx), which owns the class on <html>.
        onChange={(v) => setTheme(v)}
      />
      <Segmented
        label="Density"
        value={compact ? "compact" : "comfortable"}
        options={[
          { value: "comfortable", label: "Comfortable" },
          { value: "compact", label: "Compact" },
        ]}
        onChange={(v) => document.documentElement.classList.toggle("density-compact", v === "compact")}
      />
    </div>
  )
}

// --- Sample blocks ----------------------------------------------------------------------------

function MiniSample() {
  return (
    <div className="flex flex-col gap-3">
      <KpiStrip
        items={[
          { label: "Outstanding", value: <Money value={1234567} compact />, sub: "42 invoices" },
          { label: "Overdue", value: <Money value={345600} compact />, sub: <Delta change={-3} goodDirection="down" baseline="vs last week" /> },
        ]}
      />
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3">
        <StatusChip kind="task_status" value="data_awaited" />
        <StatusChip kind="task_status" value="under_review" />
        <StatusChip kind="invoice_status" value="paid" variant="pill" />
        <StatusChip kind="invoice_status" value="overdue" variant="pill" />
        <PriorityChip kind="task_priority" value="urgent" />
        <RoleBadge role="partner" />
        <DateText date="2026-10-20" withRelative today={TODAY} />
        <Money value="123456" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm">Save</Button>
        <Button size="sm" variant="outline">
          Cancel
        </Button>
        <Button size="sm" variant="whatsapp">
          WhatsApp
        </Button>
        <Input aria-label="Sample input" placeholder="Search clients" className="w-44" />
      </div>
    </div>
  )
}

const DUE_ROWS = [
  { title: "GSTR-3B · Sep 2026", client: "TW-C-0001 · Sharma Traders", due: "2026-10-20", status: "data_awaited" },
  { title: "TDS 24Q · Q2 2026-27", client: "TW-C-0016 · Deccan Logistics Pvt Ltd", due: "2026-10-31", status: "in_progress" },
  { title: "GSTR-1 · Sep 2026", client: "TW-C-0007 · Indiranagar Dental Clinic", due: "2026-10-24", status: "under_review" },
  { title: "ITR · AY 2026-27", client: "TW-C-0014 · Anitha Krishnan", due: "2026-10-28", status: "not_started" },
  { title: "Tax audit 3CD · FY 2025-26", client: "TW-C-0023 · BlueOak Software LLP", due: "2026-11-06", status: "in_progress" },
]

export function KitGallery({
  table,
}: {
  table: { rows: KitClientRow[]; total: number; page: number; pageSize: number; sort: string | null; dir: SortDir }
}) {
  const [shortcuts, setShortcuts] = React.useState(false)
  const kinds = Object.keys(STATUS_VOCABULARY) as StatusKind[]

  return (
    <div className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-6">
      <PageHeader
        breadcrumbs={[{ label: "Development", href: "/dev/kit" }, { label: "UI kit" }]}
        title="UI kit"
        description="Every TaxWise pattern in every state, with sample content. This page doesn't exist in production."
        actions={<DisplayControls />}
      />
      <div className="lg:grid lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-10">
        <nav aria-label="Kit sections" className="hidden lg:block">
          <ul className="sticky top-6 flex flex-col gap-0.5 text-sm">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  className="block rounded-md px-2 py-1.5 text-text-muted hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-ring"
                >
                  {s.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex min-w-0 flex-col gap-14">
          <Section id="themes" title="Light and dark" description="The left panel follows the page theme; the right is always dark. Use the switches above to flip the whole page (menus and dialogs follow).">
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <div className="rounded-lg border border-border bg-bg p-4">
                <MiniSample />
              </div>
              <div className="dark rounded-lg border border-border bg-bg p-4 text-text">
                <MiniSample />
              </div>
            </div>
          </Section>

          <Section id="type" title="Type and buttons" description="12 / 13 / 14 (body) / 16 / 20 / 24 / 30. One filled primary per region; outline for secondary; ghost for tertiary.">
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-4">
                <p className="text-2xl font-semibold tracking-[-0.01em]">30 · ₹12.3L outstanding</p>
                <p className="text-xl font-semibold tracking-[-0.01em]">24 · Clients</p>
                <p className="text-lg font-semibold">20 · Sharma Traders</p>
                <p className="text-md font-semibold">16 · Due this week</p>
                <p className="text-base">14 · GSTR-3B for September is waiting for the purchase register.</p>
                <p className="text-sm text-text-muted">13 · Assigned to Anita Rao · updated 2 hours ago</p>
                <p className="text-xs text-text-muted">12 · Powered by J-TACS</p>
              </div>
              <div className="flex flex-col gap-3">
                {(["default", "sm", "lg", "xs"] as const).map((size) => (
                  <div key={size} className="flex flex-wrap items-center gap-2">
                    <span className="w-14 text-sm text-text-muted">{size}</span>
                    <Button size={size}>
                      <PlusIcon aria-hidden="true" />
                      New client
                    </Button>
                    <Button size={size} variant="outline">
                      <DownloadIcon aria-hidden="true" />
                      Export CSV
                    </Button>
                    <Button size={size} variant="secondary">
                      Secondary
                    </Button>
                    <Button size={size} variant="ghost">
                      Ghost
                    </Button>
                    <Button size={size} variant="link">
                      Link
                    </Button>
                    <Button size={size} variant="destructive">
                      Delete
                    </Button>
                    <Button size={size} variant="destructive-outline">
                      Disable user
                    </Button>
                    <Button size={size} variant="whatsapp">
                      WhatsApp
                    </Button>
                  </div>
                ))}
                <div className="flex flex-wrap items-center gap-2">
                  <span className="w-14 text-sm text-text-muted">states</span>
                  <Button disabled>Disabled</Button>
                  <Button variant="outline" disabled>
                    Disabled
                  </Button>
                  <Button disabled aria-busy>
                    <Spinner />
                    Saving…
                  </Button>
                  <Button size="icon" variant="outline" aria-label="New invoice">
                    <ReceiptIcon />
                  </Button>
                  <Button size="icon-sm" variant="ghost" aria-label="Open">
                    <ChevronRightIcon />
                  </Button>
                </div>
              </div>
            </div>
          </Section>

          <Section id="headers" title="Page header" description="Title 24/600, one line about the data, the primary action at right; breadcrumbs on detail pages.">
            <div className="flex flex-col gap-4">
              <div className="rounded-lg border border-dashed border-border p-4">
                <PageHeader
                  title="Clients"
                  description="1,284 clients · 37 waiting to finish onboarding"
                  actions={
                    <>
                      <Button variant="outline">Import CSV</Button>
                      <Button>
                        <PlusIcon aria-hidden="true" />
                        New client
                      </Button>
                    </>
                  }
                  className="pb-0 md:pb-0"
                />
              </div>
              <div className="rounded-lg border border-dashed border-border p-4">
                <PageHeader
                  breadcrumbs={[{ label: "Clients", href: "/dev/kit#headers" }, { label: "Sharma Traders" }]}
                  title="Sharma Traders"
                  meta={
                    <>
                      <MonoId value="TW-C-0001" copy label="client code" />
                      <StatusChip kind="client_status" value="active" />
                    </>
                  }
                  description="Partnership firm · Bengaluru · GST monthly"
                  actions={
                    <>
                      <WhatsAppButton recipientName="Rakesh Sharma · Sharma Traders" number="919845012345" draft="Hi Rakesh," buildUrl={kitWhatsAppUrl} />
                      <Button variant="outline" size="sm">
                        Edit
                      </Button>
                    </>
                  }
                  className="pb-0 md:pb-0"
                />
              </div>
            </div>
          </Section>

          <Section id="kpis" title="KPI strip" description="One container split by hairlines; label above value; no icons. Two columns on phones (an odd last item spans both).">
            <div className="flex flex-col gap-4">
              <KpiStrip
                aria-label="Billing this month"
                items={[
                  { label: "Outstanding", value: <Money value={1234567.5} compact />, sub: "42 invoices", href: "/dev/kit#kpis" },
                  { label: "Overdue", value: <Money value={345600} compact />, sub: <Delta change={-3} goodDirection="down" baseline="vs last week" format={(n) => `${n} invoices`} />, href: "/dev/kit#kpis" },
                  { label: "Collected in October", value: <Money value={287600} compact />, sub: <Delta change={-188700} baseline="vs September" format={(n) => `₹${n.toLocaleString("en-IN")}`} /> },
                  { label: "Unbilled work", value: <Money value={0} compact />, sub: <Delta change={0} baseline="vs last month" /> },
                ]}
              />
              <KpiStrip
                lead
                items={[
                  { label: "Filed on time this FY", value: "94.2%", sub: <Delta change={1.8} baseline="vs 2025-26" format={(n) => `${n} pts`} /> },
                  { label: "Data awaited", value: "17", sub: "6 for more than a week", href: "/dev/kit#kpis" },
                  { label: "Under review", value: "9", sub: <Delta change={4} previous={0} baseline="since Monday" /> },
                ]}
              />
              <KpiStrip
                items={[
                  { label: "Clients", value: "1,284" },
                  { label: "Active", value: "1,172" },
                  { label: "Pending", value: "37" },
                  { label: "On hold", value: "21" },
                  { label: "Inactive", value: "54" },
                ]}
              />
            </div>
          </Section>

          <Section id="cards" title="Section cards" description="Overviews show 4–6 rows and link out; an empty or failed section keeps its frame and header.">
            <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
              <SectionCard title="Due this week" action={<span className="num text-sm text-text-muted">20–26 Oct</span>} viewAll={{ href: "/dev/kit#cards", label: "View all 18" }} flush>
                <ul>
                  {DUE_ROWS.map((r) => (
                    <li key={r.title + r.client} className="flex min-h-14 items-center justify-between gap-4 border-t border-border/70 px-4 py-2 first:border-t-0 md:px-5">
                      <div className="min-w-0">
                        <p className="truncate text-base font-medium text-text">{r.title}</p>
                        <p className="truncate text-sm text-text-muted">{r.client}</p>
                      </div>
                      <div className="flex flex-none flex-col items-end gap-0.5">
                        <DateText date={r.due} withRelative today={TODAY} className="text-sm" />
                        <StatusChip kind="task_status" value={r.status} />
                      </div>
                    </li>
                  ))}
                </ul>
              </SectionCard>
              <div className="flex flex-col gap-4">
                <SectionCard title="Overdue invoices" action={<Button variant="ghost" size="sm">Remind all</Button>}>
                  <EmptyState size="compact" message="Nothing overdue. Every sent invoice is within its due date." />
                </SectionCard>
                <SectionCard title="Revenue by month">
                  <ErrorBlock size="compact" message="Couldn't load revenue." errorRef="R4T8N2QA" lastGood="Last updated 09:14." />
                </SectionCard>
                <SectionCard title="Client profile" description="Sharma Traders">
                  <DefinitionList
                    columns={2}
                    items={[
                      { term: "PAN", value: <MonoId value="AAKFS1234C" copy label="PAN" /> },
                      { term: "GSTIN", value: <MonoId value="29AAKFS1234C1Z5" copy label="GSTIN" /> },
                      { term: "Entity", value: "Partnership firm" },
                      { term: "Place of supply", value: "Karnataka (29)" },
                      { term: "Monthly fee", value: <Money value={12500} />, align: "right" },
                      { term: "Outstanding", value: <Money value={0} />, align: "right" },
                      { term: "TAN", value: null },
                      { term: "Onboarded", value: <DateText date="2024-04-01" /> },
                    ]}
                  />
                </SectionCard>
              </div>
            </div>
          </Section>

          <Section id="status" title="Status vocabulary" description="Every §3.6 enum from lib/status.ts. Hover, focus or tap a chip for what it means and what happens next.">
            <div className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4">
              {kinds.map((kind) => (
                <div key={kind} className="grid grid-cols-1 gap-2 border-b border-border/70 pb-3 last:border-b-0 last:pb-0 md:grid-cols-[12rem_1fr]">
                  <span className="font-mono text-[13px] text-text-muted">{kind}</span>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    {statusOptions(kind, { includeDerived: true }).map((o) => (
                      <StatusChip key={o.value} kind={kind} value={o.value} />
                    ))}
                  </div>
                </div>
              ))}
              <div className="grid grid-cols-1 gap-2 border-t border-border pt-3 md:grid-cols-[12rem_1fr]">
                <span className="font-mono text-[13px] text-text-muted">pill variant</span>
                <div className="flex flex-wrap items-center gap-2">
                  {statusOptions("invoice_status", { includeDerived: true }).map((o) => (
                    <StatusChip key={o.value} kind="invoice_status" value={o.value} variant="pill" />
                  ))}
                  <StatusChip kind="task_status" value={null} />
                  <StatusChip label="Handed off" tone="info" meaning="Handed off: WhatsApp opened with the draft. The app can't confirm it was sent or delivered." />
                </div>
              </div>
              <div className="grid grid-cols-1 gap-2 border-t border-border pt-3 md:grid-cols-[12rem_1fr]">
                <span className="font-mono text-[13px] text-text-muted">priority, roles</span>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  {["low", "medium", "high", "urgent"].map((p) => (
                    <PriorityChip key={p} kind="task_priority" value={p} />
                  ))}
                  <PriorityChip kind="client_priority" value="critical" />
                  <PriorityChip kind="task_priority" value="high" hideLabel />
                  <RoleBadge role="partner" />
                  <RoleBadge role="manager" />
                  <RoleBadge role="employee" />
                  <RoleBadge role="client" />
                </div>
              </div>
            </div>
          </Section>

          <Section id="values" title="Money, dates, codes" description="Tabular figures, Indian grouping, 22 Oct 2026, relative due dates by urgency, copy buttons on identifiers.">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <SectionCard title="Money" headingLevel={3}>
                <DefinitionList
                  items={[
                    { term: "Full", value: <Money value={123456} />, align: "right" },
                    { term: "From a numeric string", value: <Money value="1234567.5" />, align: "right" },
                    { term: "Compact (tiles only)", value: <Money value={1234567.5} compact />, align: "right" },
                    { term: "Crore", value: <Money value={123456789} compact />, align: "right" },
                    { term: "Zero is printed", value: <Money value={0} />, align: "right" },
                    { term: "Negative", value: <Money value={-500} />, align: "right" },
                    { term: "Missing", value: <Money value={null} />, align: "right" },
                  ]}
                />
              </SectionCard>
              <SectionCard title="Dates" headingLevel={3} description="Today is 22 Oct 2026 here.">
                <DefinitionList
                  items={[
                    { term: "Overdue", value: <DateText date="2026-10-20" withRelative today={TODAY} /> },
                    { term: "Today", value: <DateText date="2026-10-22" withRelative today={TODAY} /> },
                    { term: "In 3 days", value: <DateText date="2026-10-25" withRelative today={TODAY} /> },
                    { term: "In 6 days", value: <DateText date="2026-10-28" withRelative today={TODAY} /> },
                    { term: "Later", value: <DateText date="2026-11-20" withRelative today={TODAY} /> },
                    { term: "Stacked", value: <DateText date="2026-10-24" withRelative stacked today={TODAY} /> },
                    { term: "With time", value: <DateText date="2026-10-22T07:11:00Z" withTime /> },
                    { term: "Missing", value: <DateText date={null} /> },
                  ]}
                />
              </SectionCard>
              <SectionCard title="Codes" headingLevel={3}>
                <DefinitionList
                  items={[
                    { term: "Client code", value: <MonoId value="TW-C-0042" copy label="client code" /> },
                    { term: "GSTIN", value: <MonoId value="29AAKFS1234C1Z5" copy label="GSTIN" /> },
                    { term: "Invoice", value: <MonoId value="TW/26-27/0142" copy label="invoice number" /> },
                    { term: "ARN (truncated)", value: <MonoId value="AA2910260412345" copy label="ARN" truncate={10} /> },
                    { term: "Ref", value: <span className="inline-flex items-center gap-1"><span className="font-mono text-[13px]">7KQ2M9XD</span><CopyButton value="7KQ2M9XD" label="Ref" showText /></span> },
                    { term: "Missing", value: <MonoId value={null} label="TAN" /> },
                  ]}
                />
              </SectionCard>
            </div>
          </Section>

          <Section
            id="table"
            title="Data table"
            description="Server-driven: search, filters, sort and page live in the URL and the page re-renders on the server. Select rows for bulk actions; hide columns; below 768px rows become cards."
          >
            <KitTable {...table} />
          </Section>

          <Section id="table-states" title="Table states">
            <KitTableStates />
          </Section>

          <Section id="feedback" title="Empty, error, loading" description="Empty keeps its frame with one sentence and one action; errors stay inside the block with a Ref and Retry; skeletons are the real size.">
            <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
              <div className="rounded-lg border border-border bg-surface">
                <EmptyState icon={<ReceiptIcon />} message="No invoices yet for FY 2026-27." action={<Button size="sm">Create invoice</Button>} />
              </div>
              <div className="rounded-lg border border-border bg-surface">
                <FilteredEmpty message="No invoices match “Sharma” in FY 2026-27." onClear={() => toast.message("Filters cleared")} />
              </div>
              <div className="rounded-lg border border-border bg-surface">
                <ErrorBlock message="Couldn't load this week's filings." errorRef="F2Q8W7ZK" onRetry={() => new Promise((r) => setTimeout(r, 900))} />
              </div>
              <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
                <FormAlert error={{ message: "Something went wrong on our side. Please try again, and if it keeps happening, quote Ref 7KQ2M9XD.", ref: "7KQ2M9XD" }} className="mb-0" />
                <FormAlert error={{ message: "Changed by Anita Rao at 12:41. Reload to see their changes." }} className="mb-0" />
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => toast.success("Client saved")}>
                    Success toast
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => toast.warning("Saved. The welcome email didn't go through, so send it by hand. (Ref 3HF8WQ2L)")}>
                    Warning toast
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => toast.error("Couldn't refresh the inbox. (Ref P9D3X1VB)")}>
                    Error toast
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => toast.info("3 new documents from Sharma Traders")}>
                    Info toast
                  </Button>
                </div>
              </div>
            </div>
            <div className="mt-6 flex flex-col gap-4">
              <Label>Skeletons</Label>
              <SkeletonPageHeader />
              <SkeletonKpiStrip labels={["Outstanding", "Overdue", "Collected in October", "Unbilled work"]} />
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <SkeletonCard title="Due this week" rows={5} />
                <SkeletonDetailHeader />
              </div>
              <SkeletonTable headers={["Client", "Code", "Status", "Due", "Outstanding"]} rows={6} />
            </div>
          </Section>

          <Section id="forms" title="Forms and dialogs" description="useActionForm: zod on blur and submit, server field errors on the field, a focused form alert with the Ref, warnings as toasts, input kept on error.">
            <KitFormDemos />
          </Section>

          <Section id="charts" title="Charts" description="One hue, faint horizontal grid, no y-axis line, square bars, straight lines, round ticks above the maximum, and a table view on every chart.">
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <LineChartCard
                title="Collections"
                description="FY 2026-27 by month, against 2025-26"
                xKey="month"
                xLabel="Month"
                data={KIT_COLLECTIONS}
                series={[
                  { key: "collected", label: "2026-27" },
                  { key: "lastYear", label: "2025-26" },
                ]}
                valueFormat="money"
                summary="Collections rose from ₹4.1L in April to ₹6.1L in September; October so far is ₹2.9L."
              />
              <BarChartCard
                title="Returns filed"
                description="All return types, by month"
                xKey="month"
                xLabel="Month"
                data={KIT_FILED}
                series={{ key: "filed", label: "Returns filed" }}
                integer
                highlight={KIT_FILED.length - 1}
              />
              <StackedBarCard
                title="Billing by service"
                description="Last four months"
                xKey="month"
                xLabel="Month"
                data={KIT_BILLING_BY_SERVICE}
                series={[
                  { key: "gst", label: "GST" },
                  { key: "income_tax", label: "Income tax" },
                  { key: "audit", label: "Audit" },
                  { key: "other", label: "Other" },
                ]}
                valueFormat="money"
              />
              <LineChartCard title="Hours logged" description="This week" xKey="day" data={[]} series={[{ key: "hours", label: "Hours" }]} emptyMessage="No time logged this week yet." />
            </div>
          </Section>

          <Section id="messaging" title="WhatsApp and Gmail" description="Hand-off only: the app opens WhatsApp or Gmail with the draft, and records “Handed off”, never “Delivered”.">
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-4">
              <WhatsAppButton
                recipientName="Rakesh Sharma · Sharma Traders"
                number="919845012345"
                draft={"Hi Rakesh, for your GSTR-3B for Sep 2026 we still need:\n• Purchase register\n• Bank statement for September\nYou can upload them here: https://app.twchartered.com/portal/documents\n– Anita"}
                buildUrl={kitWhatsAppUrl}
                templates={[
                  { id: "t1", name: "Compliance reminder", body: "Hi Rakesh, GSTR-3B for Sep 2026 is due on 20 Oct 2026. Please share the purchase register today.\n– Anita" },
                  { id: "t2", name: "Payment reminder", body: "Hi Rakesh, invoice TW/26-27/0142 for ₹14,750.00 is due on 31 Oct 2026. Pay by UPI from the portal.\n– Anita" },
                ]}
                onHandedOff={async () => {
                  await new Promise((r) => setTimeout(r, 300))
                }}
              />
              <WhatsAppButton recipientName="Malnad Coffee Estates" number={null} draft="" buildUrl={kitWhatsAppUrl} />
              <WhatsAppButton recipientName="Rakesh Sharma" number="919845012345" draft="Hi Rakesh," buildUrl={kitWhatsAppUrl} iconOnly variant="outline" />
              <WhatsAppButton recipientName="Malnad Coffee Estates" number={null} draft="" buildUrl={kitWhatsAppUrl} iconOnly />
              <GmailButton
                to="accounts@sharmatraders.in"
                subject="Invoice TW/26-27/0142 from TaxWise Consultants"
                body={"Dear Rakesh,\n\nPlease find invoice TW/26-27/0142 for ₹14,750.00, due on 31 Oct 2026:\nhttps://app.twchartered.com/portal/invoices\n\nRegards,\nAnita Rao\nTaxWise Consultants"}
                buildUrl={kitGmailUrl}
                pdfHref="#messaging"
              />
              <GmailButton to={null} subject="" body="" buildUrl={kitGmailUrl} />
            </div>
          </Section>

          <Section id="keyboard" title="Keyboard" description="The shell binds these; the sheet lists them.">
            <div className="flex flex-wrap items-center gap-4 rounded-lg border border-border bg-surface p-4 text-sm text-text-muted">
              <span className="flex items-center gap-2">
                Search <Keys keys={["mod", "K"]} />
              </span>
              <span className="flex items-center gap-2">
                New <Keys keys={["N"]} />
              </span>
              <span className="flex items-center gap-2">
                Clients <Keys keys={["G", "C"]} sequence />
              </span>
              <Button variant="outline" size="sm" onClick={() => setShortcuts(true)}>
                Show shortcut sheet
              </Button>
              <Link href="/dev/kit#themes" className="text-primary hover:underline">
                Back to top
              </Link>
            </div>
            <ShortcutSheet open={shortcuts} onOpenChange={setShortcuts} />
          </Section>
        </div>
      </div>
    </div>
  )
}
