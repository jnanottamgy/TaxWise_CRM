"use client"

import * as React from "react"
import { ChevronRightIcon, RotateCwIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatTime } from "@/lib/format"
import type { CheckStatus, DiagnosticCheckInfo, DiagnosticResult } from "@/server/diagnostics"
import { runDiagnosticCheck } from "@/server/actions/settings"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { StatusChip } from "@/components/app/status-chip"
import { CopyButton } from "@/components/app/copy-button"
import type { StatusTone } from "@/lib/status"

type RowState =
  | { state: "waiting" }
  | { state: "running" }
  | { state: "done"; result: DiagnosticResult }
  | { state: "error"; message: string; ref?: string }

const STATUS_CHIP: Record<CheckStatus, { label: string; tone: StatusTone; meaning: string }> = {
  pass: { label: "Pass", tone: "success", meaning: "This part of the deployment is healthy." },
  warn: { label: "Warning", tone: "warning", meaning: "It works, with a gap worth fixing. The details say what." },
  fail: { label: "Fail", tone: "danger", meaning: "Something the app relies on is missing or broken. The details give the error code." },
}

function Chip({ row }: { row: RowState }) {
  if (row.state === "waiting") return <StatusChip label="Waiting" tone="muted" meaning="Runs after the checks above it." />
  if (row.state === "running") return <StatusChip label="Running" tone="info" meaning="Checking now." />
  if (row.state === "error") return <StatusChip label="Couldn't run" tone="danger" meaning="The check itself couldn't run. Its message and Ref are shown." />
  const s = STATUS_CHIP[row.result.status]
  return <StatusChip label={s.label} tone={s.tone} meaning={s.meaning} />
}

/**
 * Runs the diagnostics one at a time (§7.24) and shows each result as it lands: pass / warning /
 * fail, the error code, a one-line summary and the failing items. The report can be copied to send
 * to whoever maintains the deployment; it holds names and codes only, never values or secrets.
 */
export function DiagnosticsRunner({ checks, context }: { checks: readonly DiagnosticCheckInfo[]; context: { today: string; appEnv: string; expectedSchema: string } }) {
  const [rows, setRows] = React.useState<Record<string, RowState>>(() => Object.fromEntries(checks.map((c) => [c.id, { state: "waiting" } as RowState])))
  const [running, setRunning] = React.useState(false)
  const [finishedAt, setFinishedAt] = React.useState<Date | null>(null)
  const started = React.useRef(false)

  const runAll = React.useCallback(async () => {
    setRunning(true)
    setFinishedAt(null)
    setRows(Object.fromEntries(checks.map((c) => [c.id, { state: "waiting" } as RowState])))
    for (const c of checks) {
      setRows((r) => ({ ...r, [c.id]: { state: "running" } }))
      let next: RowState
      try {
        const res = await runDiagnosticCheck(c.id)
        next = res.ok ? { state: "done", result: res.data } : { state: "error", message: res.error, ref: res.ref }
      } catch {
        next = { state: "error", message: "The server didn't answer. Check your connection and run again." }
      }
      setRows((r) => ({ ...r, [c.id]: next }))
    }
    setRunning(false)
    setFinishedAt(new Date())
  }, [checks])

  React.useEffect(() => {
    if (started.current) return
    started.current = true
    void runAll()
  }, [runAll])

  const done = checks.map((c) => rows[c.id]).filter((r): r is Extract<RowState, { state: "done" }> => r?.state === "done")
  const counts = {
    pass: done.filter((r) => r.result.status === "pass").length,
    warn: done.filter((r) => r.result.status === "warn").length,
    fail: done.filter((r) => r.result.status === "fail").length + checks.filter((c) => rows[c.id]?.state === "error").length,
  }
  const position = checks.findIndex((c) => rows[c.id]?.state === "running") + 1

  const report = [
    `TaxWise diagnostics · ${context.today} · APP_ENV=${context.appEnv} · expects schema ${context.expectedSchema}`,
    ...checks.map((c) => {
      const r = rows[c.id]
      if (!r || r.state === "waiting" || r.state === "running") return `- ${c.label}: not run`
      if (r.state === "error") return `- ${c.label}: COULD NOT RUN · ${r.message}${r.ref ? ` (Ref ${r.ref})` : ""}`
      const bad = r.result.items.filter((i) => i.status !== "pass")
      return [
        `- ${c.label}: ${r.result.status.toUpperCase()}${r.result.code ? ` [${r.result.code}]` : ""} · ${r.result.summary}`,
        ...bad.map((i) => `    · ${i.label}: ${i.status}${i.code ? ` [${i.code}]` : ""}${i.detail ? ` · ${i.detail}` : ""}`),
      ].join("\n")
    }),
  ].join("\n")

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between md:px-5">
        <p className="min-w-0 text-base text-text" aria-live="polite">
          {running ? (
            <>
              Running check {position} of {checks.length}…
            </>
          ) : finishedAt ? (
            <>
              <span className="num">{counts.pass}</span> passed · <span className={cn("num", counts.warn ? "font-medium text-warning-text" : "")}>{counts.warn}</span>{" "}
              {counts.warn === 1 ? "warning" : "warnings"} · <span className={cn("num", counts.fail ? "font-medium text-danger-text" : "")}>{counts.fail}</span> failed
              <span className="text-text-muted"> · finished at <span className="num">{formatTime(finishedAt)}</span></span>
            </>
          ) : (
            "Starting…"
          )}
        </p>
        <div className="flex flex-none items-center gap-2">
          {finishedAt ? (
            <span className="inline-flex items-center gap-1 text-sm text-text-muted">
              Copy report <CopyButton value={report} label="diagnostics report" />
            </span>
          ) : null}
          <Button type="button" onClick={() => void runAll()} disabled={running}>
            {running ? <Spinner /> : <RotateCwIcon aria-hidden="true" />}
            {running ? "Running…" : "Run again"}
          </Button>
        </div>
      </div>

      <ol className="flex min-w-0 flex-col divide-y divide-border rounded-lg border border-border bg-surface">
        {checks.map((c) => {
          const r = rows[c.id] ?? { state: "waiting" }
          const result = r.state === "done" ? r.result : null
          const items = result?.items ?? []
          const shown = result ? (result.status === "pass" ? items : items.filter((i) => i.status !== "pass")) : []
          return (
            <li key={c.id} className="min-w-0 px-4 py-3.5 md:px-5">
              <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 sm:grid-cols-[13rem_minmax(0,1fr)_auto]">
                <div className="min-w-0">
                  <p className="text-base font-medium text-text">{c.label}</p>
                  <p className="text-xs text-text-muted sm:hidden">{c.description}</p>
                </div>
                <div className="col-span-2 row-start-2 min-w-0 sm:col-span-1 sm:row-start-1">
                  {r.state === "done" ? (
                    <p className="text-base break-words text-text">
                      {r.result.summary}
                      {r.result.code ? <span className="ml-2 font-mono text-sm text-text-muted">{r.result.code}</span> : null}
                    </p>
                  ) : r.state === "error" ? (
                    <p className="text-base text-danger-text">
                      {r.message}
                      {r.ref ? <span className="ml-2 font-mono text-sm text-text-muted">Ref {r.ref}</span> : null}
                    </p>
                  ) : (
                    <p className="hidden text-sm text-text-muted sm:block">{c.description}</p>
                  )}
                </div>
                <div className="flex items-center gap-3 justify-self-end">
                  {result ? <span className="num hidden text-xs text-text-muted sm:inline">{result.ms} ms</span> : null}
                  {r.state === "running" ? <Spinner className="size-3.5 text-text-muted" /> : null}
                  <Chip row={r} />
                </div>
              </div>
              {shown.length > 0 ? (
                <details className="group mt-2 sm:ml-[13rem] sm:pl-4" open={result?.status === "fail"}>
                  <summary className="inline-flex cursor-pointer items-center gap-1 rounded-sm text-sm font-medium text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                    <ChevronRightIcon aria-hidden="true" className="size-3.5 transition-transform duration-150 group-open:rotate-90" />
                    {result?.status === "pass" ? `Details (${shown.length})` : `${shown.length} item${shown.length === 1 ? "" : "s"} to look at`}
                  </summary>
                  <ul className="mt-2 flex flex-col divide-y divide-border rounded-md border border-border">
                    {shown.map((i) => (
                      <li key={i.label} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 px-3 py-2 sm:grid-cols-[14rem_minmax(0,1fr)_auto]">
                        <span className="min-w-0 truncate font-mono text-sm text-text" title={i.label}>
                          {i.label}
                        </span>
                        <span className="col-span-2 row-start-2 min-w-0 text-sm break-words text-text-muted sm:col-span-1 sm:row-start-1">
                          {i.detail ?? ""}
                          {i.code ? <span className="ml-1.5 font-mono text-xs">{i.code}</span> : null}
                        </span>
                        <span className="justify-self-end">
                          <StatusChip label={STATUS_CHIP[i.status].label} tone={STATUS_CHIP[i.status].tone} meaning={STATUS_CHIP[i.status].meaning} />
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
