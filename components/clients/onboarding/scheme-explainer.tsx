"use client"

import { InfoIcon, TriangleAlertIcon } from "lucide-react"
import type { GstSchemeDecision } from "@/lib/domain/scale"
import { GST_SCHEME_LABELS } from "@/lib/domain/enums"

/**
 * The live line under "GST filing scheme" (§7.3.2 step 1, §6.6): which scheme applies and why, in
 * plain words, updated as the turnover or the choice changes. A recorded choice that can't be
 * honoured (QRMP above the limit) or couldn't be checked (no turnover) shows its warning.
 */
export function SchemeExplainer({ decision, registered }: { decision: GstSchemeDecision; registered: boolean }) {
  return (
    <div aria-live="polite" className="flex flex-col gap-1.5">
      <p className="flex gap-2 text-sm text-text-muted">
        <InfoIcon aria-hidden="true" className="mt-0.5 size-3.5 flex-none" />
        <span>
          <span className="font-medium text-text">{GST_SCHEME_LABELS[decision.scheme]}.</span> {decision.explanation}
          {registered ? "" : " This applies once the client is registered for GST."}
        </span>
      </p>
      {decision.warning ? (
        <p className="flex gap-2 rounded-md border border-warning/40 bg-warning-soft px-2.5 py-1.5 text-sm text-warning-text">
          <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-3.5 flex-none" />
          <span>{decision.warning}</span>
        </p>
      ) : null}
    </div>
  )
}
