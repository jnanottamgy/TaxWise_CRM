"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { MessageSquareShareIcon, UsersIcon } from "lucide-react"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import { formatCount, type SortDir } from "@/components/app/data-table/params"
import { EmptyState } from "@/components/app/empty-state"
import { DateText } from "@/components/app/date-text"
import { ErrorBlock } from "@/components/app/error-block"
import { WhatsAppButton } from "@/components/app/messaging/whatsapp-button"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { applySignature, firstNameOf, pickWhatsAppNumber } from "@/lib/domain/messaging"
import { renderTemplate } from "@/lib/domain/templates"
import { FOLLOW_UP_TEMPLATE_NAMES, SUPPLIER_DEFAULT_SORT, defaultSupplierFollowUp } from "@/lib/schemas/gst-recon"
import type { SupplierRow, FollowUpContext } from "@/lib/data/gst-recon"
import { logHandoff } from "@/server/actions/messages"
import { markSupplierFollowedUp, supplierFollowUp } from "@/server/actions/gst-recon"
import { PaiseAmount } from "@/components/workpapers/shared/amount"

export type FollowUpTarget = {
  runId: string
  clientId: string
  clientName: string
  clientCode: string
  /** "September 2026". */
  periodText: string
  context: FollowUpContext
}

function Count({ n, tone }: { n: number; tone?: "danger" | "warning" }) {
  if (n === 0) return <span className="num text-text-muted tabular-nums">0</span>
  return <span className={tone === "danger" ? "num font-medium text-danger-text tabular-nums" : tone === "warning" ? "num text-warning-text tabular-nums" : "num tabular-nums"}>{formatCount(n)}</span>
}

/**
 * The supplier roll-up (§6.12 "whom to chase"): one row per supplier GSTIN, the open lines to chase,
 * ITC at risk and unclaimed on open lines, the mismatch difference and the last follow-up; live from
 * the lines, so a resolution moves the figures. "Draft follow-up" opens the hand-off for that
 * supplier's missing and mismatched documents.
 */
export function SuppliersTable({ target, rows, total, page, pageSize, sort, dir }: { target: FollowUpTarget; rows: SupplierRow[]; total: number; page: number; pageSize: number; sort: string | null; dir: SortDir }) {
  const [drafting, setDrafting] = React.useState<SupplierRow | null>(null)
  const columns = React.useMemo<DataTableColumn<SupplierRow>[]>(
    () => [
      {
        id: "supplier_name",
        header: "Supplier",
        sortable: true,
        hideable: false,
        mobile: "primary",
        width: "26%",
        cell: (r) => (
          <span className="inline-flex min-w-0 flex-col leading-5" title={r.supplier_name ?? r.supplier_gstin}>
            <span className="truncate">{r.supplier_name ?? (r.supplier_gstin || "Imports (no GSTIN)")}</span>
            <span className="num text-xs text-text-muted">{r.supplier_gstin || "No GSTIN"}</span>
          </span>
        ),
        mobileCell: (r) => r.supplier_name ?? (r.supplier_gstin || "Imports (no GSTIN)"),
      },
      { id: "chase", header: "To chase", align: "right", cell: (r) => <Count n={r.chase_count} tone="danger" /> },
      { id: "missing_in_2b", header: "Not in 2B", align: "right", hideBelow: "lg", cell: (r) => <Count n={r.missing_in_2b_count} /> },
      { id: "mismatch", header: "Mismatch", align: "right", hideBelow: "lg", cell: (r) => <Count n={r.mismatch_count} /> },
      { id: "missing_in_books", header: "Not in books", align: "right", hideBelow: "xl", cell: (r) => <Count n={r.missing_in_books_count} tone="warning" /> },
      { id: "itc_at_risk_paise", header: "ITC at risk", sortable: true, align: "right", mobile: "trailing", cell: (r) => <PaiseAmount value={r.itc_at_risk_paise} /> },
      { id: "unclaimed_itc_paise", header: "Unclaimed ITC", sortable: true, align: "right", hideBelow: "lg", cell: (r) => <PaiseAmount value={r.unclaimed_itc_paise} /> },
      { id: "mismatch_difference_paise", header: "Mismatch (2B − books)", sortable: true, align: "right", hideBelow: "2xl", cell: (r) => <PaiseAmount value={r.mismatch_difference_paise} signed /> },
      {
        id: "last_follow_up_at",
        header: "Followed up",
        align: "right",
        hideBelow: "xl",
        mobile: "secondary",
        cell: (r) => (r.last_follow_up_at ? <DateText date={r.last_follow_up_at} /> : <span className="text-text-muted">Not yet</span>),
      },
      {
        id: "draft",
        header: "",
        hideable: false,
        cell: (r) =>
          r.chase_count === 0 ? null : r.supplier_gstin ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setDrafting(r)}>
              <MessageSquareShareIcon aria-hidden="true" />
              Draft follow-up
            </Button>
          ) : (
            // Imports (IMPG) have no supplier to write to: the bill of entry is checked on ICEGATE.
            <span className="text-sm text-text-muted">Check on ICEGATE</span>
          ),
      },
    ],
    [],
  )
  return (
    <>
      <DataTable
        id="gst-recon-suppliers"
        caption="Suppliers"
        columns={columns}
        rows={rows}
        getRowId={(r) => r.supplier_gstin || "no-gstin"}
        total={total}
        page={page}
        pageSize={pageSize}
        sort={sort}
        dir={dir}
        defaultSort={SUPPLIER_DEFAULT_SORT}
        countLabel={(n, t) => `${n} ${t === 1 ? "supplier" : "suppliers"}`}
        columnChooser
        empty={<EmptyState icon={<UsersIcon />} message="No suppliers in this reconciliation." />}
      />
      {drafting ? <FollowUpSheet target={target} supplier={drafting} onClose={() => setDrafting(null)} /> : null}
    </>
  )
}

/**
 * "Draft supplier follow-up" (§7.8.1, §7.13.2): a WhatsApp draft to the client's contact who handles
 * GST, listing this supplier's documents that aren't in GSTR-2B or don't match it, from the firm's
 * supplier follow-up template. Opening WhatsApp logs the hand-off ("Handed off", never
 * "delivered") and marks the supplier's open lines "Following up".
 */
function FollowUpSheet({ target, supplier, onClose }: { target: FollowUpTarget; supplier: SupplierRow; onClose: () => void }) {
  const router = useRouter()
  const [state, setState] = React.useState<{ kind: "loading" } | { kind: "ready"; items: string; count: number } | { kind: "failed"; message: string; ref?: string }>({ kind: "loading" })
  const [attemptNo, setAttemptNo] = React.useState(0)
  React.useEffect(() => {
    let live = true
    void supplierFollowUp({ runId: target.runId, supplierGstin: supplier.supplier_gstin }).then((r) => {
      if (!live) return
      setState(r.ok ? { kind: "ready", items: r.data.missingItems, count: r.data.lineCount } : { kind: "failed", message: r.error, ref: r.ref })
    })
    return () => {
      live = false
    }
  }, [target.runId, supplier.supplier_gstin, attemptNo])
  const retry = () => {
    setState({ kind: "loading" })
    setAttemptNo((n) => n + 1)
  }

  const { recipient, client, messaging } = target.context
  const contactName = recipient?.name ? firstNameOf(recipient.name) || recipient.name : null
  const sign = (text: string) => (messaging.addSignature ? applySignature(text, messaging.signatureFormat, firstNameOf(messaging.senderName)) : text)
  const values = (items: string) => ({
    client_name: target.clientName,
    client_code: target.clientCode,
    contact_name: contactName ?? "",
    period: target.periodText,
    missing_items: items,
    firm_name: messaging.firmName,
    firm_phone: messaging.firmPhone ?? "",
    sender_name: messaging.senderName,
  })
  const waTemplate = messaging.templates.find((t) => t.name === FOLLOW_UP_TEMPLATE_NAMES.whatsapp)
  const number = pickWhatsAppNumber(recipient, client, { countryCode: messaging.countryCode })

  const after = async () => {
    const r = await markSupplierFollowedUp({ runId: target.runId, supplierGstin: supplier.supplier_gstin, channel: "whatsapp_handoff" })
    if (!r.ok) toast.warning(`Handed off, but the lines weren't marked "Following up": ${r.error}`)
    onClose()
    router.refresh()
  }

  return (
    <Sheet open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <SheetContent className="w-[min(100%,32rem)] overflow-y-auto">
        <SheetHeader className="pr-12">
          <SheetTitle>Follow up {supplier.supplier_name ?? supplier.supplier_gstin}</SheetTitle>
          <SheetDescription>
            To {recipient?.name ?? target.clientName}, {recipient ? "the client's contact for GST" : "the client"}, who asks the supplier to file or correct their GSTR-1.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4 pb-6">
          {state.kind === "loading" ? (
            <p className="inline-flex items-center gap-2 text-sm text-text-muted">
              <Spinner className="size-3.5" /> Listing the documents
            </p>
          ) : state.kind === "failed" ? (
            <div className="rounded-md border border-border">
              <ErrorBlock message={state.message} errorRef={state.ref} onRetry={retry} size="compact" />
            </div>
          ) : (
            <>
              <div className="rounded-md border border-border bg-surface-2/50 px-3 py-2.5">
                <p className="mb-1 text-sm font-medium text-text">
                  {state.count} {state.count === 1 ? "document" : "documents"} to list
                </p>
                <pre className="font-sans text-sm whitespace-pre-wrap text-text">{state.items}</pre>
              </div>
              <div className="flex flex-wrap gap-2">
                <WhatsAppButton
                  recipientName={`${recipient?.name ?? "Client"} · ${target.clientName}`}
                  number={number?.digits ?? null}
                  draft={sign(
                    waTemplate
                      ? renderTemplate(waTemplate.body, values(state.items))
                      : defaultSupplierFollowUp({ contactName, periodText: target.periodText, missingItems: state.items }),
                  )}
                  size="default"
                  variant="outline"
                  disabledReason="No WhatsApp number for this client. Add one in Contacts."
                  onHandedOff={async ({ number: n, text }) => {
                    const r = await logHandoff({
                      clientId: target.clientId,
                      contactId: recipient?.contactId ?? null,
                      channel: "whatsapp_handoff",
                      recipient: n,
                      body: text,
                      templateId: waTemplate?.id ?? null,
                      related: { type: "gst_recon_run", id: target.runId },
                    })
                    if (!r.ok) throw new Error(r.error)
                    await after()
                  }}
                />
              </div>
              <p className="text-sm text-text-muted">The app opens WhatsApp with the message; you press Send there. Afterwards these lines show as Following up and keep carrying forward until the supplier files.</p>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
