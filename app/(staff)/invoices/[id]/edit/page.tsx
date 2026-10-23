import type { Metadata } from "next"
import { notFound, redirect, unstable_rethrow } from "next/navigation"
import { requireManagerOrPartner } from "@/lib/auth/guards"
import { logUnexpected } from "@/lib/log"
import { todayIST } from "@/lib/domain/fy"
import { getBillingSettings, getClientBillingFacts, getGstParams } from "@/lib/data/invoices"
import { PageHeader } from "@/components/app/page-header"
import { ErrorBlock } from "@/components/app/error-block"
import { PageGuide, ShellTitle } from "@/components/shell/page-slots"
import { InvoiceEditor } from "@/components/invoices/editor/invoice-editor"
import { draftInvoiceForm, editorGst, editorSettings } from "@/components/invoices/editor/editor-context"
import type { EditorInvoice } from "@/components/invoices/editor/types"

export const metadata: Metadata = { title: "Edit invoice" }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Edit a draft (§7.9.3 "Draft: edit freely"), including one awaiting approval or returned with a
 * note, a reissue after cancel, and a debit note. An issued invoice is never edited: this sends it
 * back to its page.
 */
export default async function EditInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { user, supabase } = await requireManagerOrPartner()
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const today = todayIST()

  type Loaded = {
    initial: ReturnType<typeof draftInvoiceForm>
    editorInvoice: EditorInvoice
    client: Awaited<ReturnType<typeof getClientBillingFacts>>
    settings: Awaited<ReturnType<typeof getBillingSettings>>
    gst: Awaited<ReturnType<typeof getGstParams>>
    kind: string
  }
  let loaded: Loaded | null = null
  let errorRef: string | null = null
  try {
    const { data: inv, error } = await supabase.from("invoices").select("*").eq("id", id).is("deleted_at", null).maybeSingle()
    if (error) throw error
    if (!inv) notFound()
    if (inv.status !== "draft" && inv.status !== "awaiting_approval") redirect(`/invoices/${id}`)

    const related = [inv.revised_from_id, inv.original_invoice_id].filter((v): v is string => Boolean(v))
    const people = [inv.approved_by, inv.returned_by, inv.created_by].filter((v): v is string => Boolean(v))
    const [items, settings, gst, client, rel, names] = await Promise.all([
      supabase.from("invoice_items").select("*").eq("invoice_id", id).order("sort_order"),
      getBillingSettings(supabase),
      getGstParams(supabase, today),
      getClientBillingFacts(supabase, inv.client_id, { invoiceId: id }),
      related.length ? supabase.from("invoices").select("id, invoice_number").in("id", related) : Promise.resolve({ data: [], error: null }),
      people.length ? supabase.from("profiles").select("id, full_name").in("id", people) : Promise.resolve({ data: [], error: null }),
    ])
    for (const r of [items, rel, names]) if (r.error) throw r.error
    const name = (pid: string | null) => (pid ? ((names.data ?? []) as Array<{ id: string; full_name: string }>).find((p) => p.id === pid)?.full_name ?? null : null)
    const number = (rid: string | null) => (rid ? ((rel.data ?? []) as Array<{ id: string; invoice_number: string | null }>).find((r) => r.id === rid)?.invoice_number ?? null : null)

    loaded = {
      initial: draftInvoiceForm(inv, items.data ?? [], gst.defaultRateServices, settings.roundOffEnabled),
      editorInvoice: {
        id: inv.id,
        status: inv.status as "draft" | "awaiting_approval",
        invoiceKind: inv.invoice_kind as "tax_invoice" | "debit_note",
        requiresApproval: inv.requires_approval,
        approvedAt: inv.approved_at,
        approvedByName: name(inv.approved_by),
        approvalNote: inv.approval_note,
        returnedAt: inv.returned_at,
        returnedByName: name(inv.returned_by),
        submittedAt: inv.submitted_at,
        createdByName: name(inv.created_by),
        revisedFrom: inv.revised_from_id ? { id: inv.revised_from_id, number: number(inv.revised_from_id) } : null,
        original: inv.original_invoice_id ? { id: inv.original_invoice_id, number: number(inv.original_invoice_id) } : null,
      },
      client,
      settings,
      gst,
      kind: inv.invoice_kind === "debit_note" ? "debit note" : "invoice",
    }
  } catch (err) {
    unstable_rethrow(err)
    errorRef = logUnexpected(err, { source: "page:/invoices/[id]/edit", userId: user.id })
  }

  const crumbs = loaded
    ? [{ label: "Invoices", href: "/invoices" }, { label: loaded.client?.display_name ?? "Draft", href: `/invoices/${id}` }, { label: "Edit" }]
    : [{ label: "Invoices", href: "/invoices" }, { label: "Edit draft" }]
  const content = loaded ? (
    <>
      <PageHeader breadcrumbs={crumbs} title={`Edit draft ${loaded.kind}`} description={loaded.client ? `${loaded.client.client_code} · ${loaded.client.display_name}` : undefined} />
      <InvoiceEditor
        mode="edit"
        initial={loaded.initial}
        invoice={loaded.editorInvoice}
        client={loaded.client}
        settings={editorSettings(loaded.settings)}
        gst={editorGst(loaded.gst)}
        viewer={{ role: user.role === "partner" ? "partner" : "manager", name: user.fullName }}
        today={today}
      />
    </>
  ) : (
    <>
      <PageHeader breadcrumbs={crumbs} title="Edit draft" />
      <div className="rounded-lg border border-border bg-surface">
        <ErrorBlock message="Couldn't open this draft." errorRef={errorRef ?? undefined} />
      </div>
    </>
  )

  return (
    <div className="flex min-w-0 flex-col">
      <ShellTitle crumbs={crumbs} />
      <PageGuide title="Edit draft">
        <p>A draft can be changed freely until it is issued. It saves itself every few seconds; Save and review opens it to issue and send.</p>
        <p className="mt-2">A Manager&apos;s invoice over the approval limit stays held for a Partner, even if the amount comes down later; a Partner&apos;s approval is for the amount approved.</p>
      </PageGuide>
      {content}
    </div>
  )
}
