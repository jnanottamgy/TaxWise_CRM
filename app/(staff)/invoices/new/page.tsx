import type { Metadata } from "next"
import { unstable_rethrow } from "next/navigation"
import { requireManagerOrPartner } from "@/lib/auth/guards"
import { logUnexpected } from "@/lib/log"
import { todayIST } from "@/lib/domain/fy"
import { readParam } from "@/components/app/data-table/params"
import { getBillingSettings, getClientBillingFacts, getGstParams } from "@/lib/data/invoices"
import { PageHeader } from "@/components/app/page-header"
import { ErrorBlock } from "@/components/app/error-block"
import { PageGuide, ShellTitle } from "@/components/shell/page-slots"
import { InvoiceEditor } from "@/components/invoices/editor/invoice-editor"
import { editorGst, editorSettings, newInvoiceForm } from "@/components/invoices/editor/editor-context"

export const metadata: Metadata = { title: "New invoice" }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * New invoice (§7.9.2). Partners and Managers only (§4.1). `?client=<id>` starts it for a client
 * (Client 360 "New invoice", the client list row, the timesheet's unbilled time). The draft is saved
 * on the server as soon as there is a client and something typed (§3.4); the number comes at issue.
 */
export default async function NewInvoicePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user, supabase } = await requireManagerOrPartner()
  const sp = await searchParams
  const clientParam = readParam(sp, "client")
  const today = todayIST()
  const crumbs = [{ label: "Invoices", href: "/invoices" }, { label: "New invoice" }]

  let loaded: { settings: Awaited<ReturnType<typeof getBillingSettings>>; gst: Awaited<ReturnType<typeof getGstParams>>; client: Awaited<ReturnType<typeof getClientBillingFacts>> }
  try {
    const [settings, gst, client] = await Promise.all([
      getBillingSettings(supabase),
      getGstParams(supabase, today),
      clientParam && UUID.test(clientParam) ? getClientBillingFacts(supabase, clientParam) : Promise.resolve(null),
    ])
    loaded = { settings, gst, client }
  } catch (err) {
    unstable_rethrow(err)
    const ref = logUnexpected(err, { source: "page:/invoices/new", userId: user.id })
    return (
      <div className="flex min-w-0 flex-col">
        <ShellTitle crumbs={crumbs} />
        <PageHeader breadcrumbs={crumbs} title="New invoice" />
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't open the invoice form." errorRef={ref} />
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-w-0 flex-col">
      <ShellTitle crumbs={crumbs} />
      <PageGuide title="New invoice">
        <p>Choose the client, then add lines by hand or from an engagement&apos;s agreed fee, the client&apos;s unbilled time (billed at each person&apos;s rate) or completed tasks. The SAC fills in from the service; reimbursements of expenses paid as pure agent carry no GST.</p>
        <p className="mt-2">The place of supply comes from the client&apos;s GSTIN or state and decides CGST + SGST or IGST. Change it only with a reason.</p>
        <p className="mt-2">The draft saves itself every few seconds. It gets its number when you issue it. A Manager&apos;s invoice over the approval limit goes to the Partners first.</p>
      </PageGuide>
      <PageHeader breadcrumbs={crumbs} title="New invoice" description="Drafts show “Draft” until they are issued; the number comes from the invoice series then." />
      <InvoiceEditor
        mode="new"
        initial={newInvoiceForm({ today, settings: loaded.settings, client: loaded.client, defaultRate: loaded.gst.defaultRateServices })}
        invoice={null}
        client={loaded.client}
        settings={editorSettings(loaded.settings)}
        gst={editorGst(loaded.gst)}
        viewer={{ role: user.role === "partner" ? "partner" : "manager", name: user.fullName }}
        today={today}
      />
    </div>
  )
}
