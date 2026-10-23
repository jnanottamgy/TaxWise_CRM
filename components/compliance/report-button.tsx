"use client"

import * as React from "react"
import { toast } from "sonner"
import { FileDownIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { ReportRangeSchema } from "@/lib/schemas/compliance"
import { fyEnd, fyStart, previousFinancialYear } from "@/lib/domain/fy"
import { formatDate } from "@/lib/format"

/**
 * The client compliance report (§7.7, §11): choose the period (this FY, last FY, or any dates) and
 * download the branded PDF: every statutory deadline in it, its status, filed-on date,
 * acknowledgement number and whether it was on time. The PDF comes from
 * /api/pdf/compliance-report/<clientId>; a refusal shows its sentence and Ref here.
 */
export function ReportButton({ clientId, clientCode, fy }: { clientId: string; clientCode: string; fy: string }) {
  const [open, setOpen] = React.useState(false)
  const [preset, setPreset] = React.useState<"this" | "last" | "custom">("this")
  const [from, setFrom] = React.useState(fyStart(fy))
  const [to, setTo] = React.useState(fyEnd(fy))
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<{ message: string; ref?: string } | null>(null)

  const range = preset === "this" ? { from: fyStart(fy), to: fyEnd(fy) } : preset === "last" ? { from: fyStart(previousFinancialYear(fy)), to: fyEnd(previousFinancialYear(fy)) } : { from, to }

  const download = async (event?: React.FormEvent) => {
    event?.preventDefault()
    setError(null)
    const parsed = ReportRangeSchema.safeParse(range)
    if (!parsed.success) {
      setError({ message: parsed.error.issues[0]?.message ?? "Choose a valid period." })
      return
    }
    setBusy(true)
    try {
      const res = await fetch(`/api/pdf/compliance-report/${clientId}?from=${parsed.data.from}&to=${parsed.data.to}&download=1`, { cache: "no-store" })
      const type = res.headers.get("content-type") ?? ""
      if (!res.ok || !type.includes("application/pdf")) {
        const body = (await res.json().catch(() => null)) as { error?: string; ref?: string } | null
        setError({ message: body?.error ?? "The report couldn't be prepared. Please try again.", ref: body?.ref })
        return
      }
      const blob = await res.blob()
      const href = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = href
      a.download = `Compliance-report-${clientCode}-${parsed.data.from}-to-${parsed.data.to}.pdf`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(href), 10_000)
      toast.success("Compliance report downloaded")
      setOpen(false)
    } catch {
      setError({ message: "We couldn't reach the server. Check your connection and try again." })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <FileDownIcon aria-hidden="true" />
        Compliance report
      </Button>
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        size="sm"
        title="Compliance report"
        description="Every statutory deadline in the period, its status, filed-on date, acknowledgement and whether it was on time. For sending to the client."
        onSubmit={download}
        pending={busy}
        submitLabel={busy ? "Preparing…" : "Download PDF"}
      >
        <FormAlert error={error} />
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-medium text-text">Period</legend>
          <RadioGroup value={preset} onValueChange={(v) => setPreset(v as typeof preset)} className="gap-2">
            {[
              { v: "this", label: `FY ${fy}`, hint: `${formatDate(fyStart(fy))} – ${formatDate(fyEnd(fy))}` },
              { v: "last", label: `FY ${previousFinancialYear(fy)}`, hint: `${formatDate(fyStart(previousFinancialYear(fy)))} – ${formatDate(fyEnd(previousFinancialYear(fy)))}` },
              { v: "custom", label: "Other dates", hint: "Up to three years" },
            ].map((o) => (
              <label key={o.v} className="flex cursor-pointer items-start gap-2.5 text-sm">
                <RadioGroupItem value={o.v} className="mt-0.5" />
                <span>
                  <span className="block font-medium text-text">{o.label}</span>
                  <span className="block text-text-muted">{o.hint}</span>
                </span>
              </label>
            ))}
          </RadioGroup>
          {preset === "custom" ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="report-from" className="text-sm font-medium text-text">
                  From
                </label>
                <Input id="report-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="report-to" className="text-sm font-medium text-text">
                  To
                </label>
                <Input id="report-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
            </div>
          ) : null}
        </fieldset>
        {busy ? (
          <p className="mt-3 flex items-center gap-2 text-sm text-text-muted">
            <Spinner /> Preparing the PDF…
          </p>
        ) : null}
      </FormDialog>
    </>
  )
}
