"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import Papa from "papaparse"
import { CircleAlertIcon, CircleCheckIcon, DownloadIcon, FileUpIcon, KeyRoundIcon, UploadIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { RoleBadge } from "@/components/app/role-badge"
import type { AppRole } from "@/lib/auth/roles"
import {
  IMPORT_COLUMNS,
  IMPORT_MAX_ROWS,
  IMPORT_TEMPLATE_CSV,
  checkImportRows,
  missingImportColumns,
  normaliseImportHeader,
  type ImportRowCheck,
  type RawImportRow,
} from "@/lib/schemas/people"
import { importPeople, issueLogins, type ImportResult, type LoginHandout } from "@/server/actions/people"
import { LoginCreatedDialog } from "@/components/people/login-created-dialog"
import { cn } from "@/lib/utils"

type Step = { kind: "choose" } | { kind: "preview"; fileName: string; rows: RawImportRow[]; checks: ImportRowCheck[] } | { kind: "done"; result: ImportResult }

const TEMPLATE_HREF = `data:text/csv;charset=utf-8,${encodeURIComponent(IMPORT_TEMPLATE_CSV)}`

/**
 * Bulk import (§4.5 point 8): a CSV with name, email, phone, department, designation, role,
 * date_of_joining. The file is read in the browser and every row is checked before anything is
 * saved (the per-row validation report); the server checks again on import. Import creates the
 * records only; logins are issued in a second step, "Issue logins for N people".
 */
export function ImportPeopleDialog({ actorRole, existingEmails }: { actorRole: AppRole; existingEmails: string[] }) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [step, setStep] = React.useState<Step>({ kind: "choose" })
  const [error, setError] = React.useState<{ message: string; ref?: string } | null>(null)
  const [busy, setBusy] = React.useState<"parse" | "import" | "logins" | null>(null)
  const [logins, setLogins] = React.useState<{ created: LoginHandout[]; failed: Array<{ name: string; error: string }> } | null>(null)
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const existing = React.useMemo(() => new Set(existingEmails.map((e) => e.toLowerCase())), [existingEmails])

  const reset = () => {
    setStep({ kind: "choose" })
    setError(null)
    if (inputRef.current) inputRef.current.value = ""
  }

  const read = (file: File) => {
    setError(null)
    if (!/\.csv$/i.test(file.name) && file.type !== "text/csv" && file.type !== "application/vnd.ms-excel") {
      setError({ message: "Choose a CSV file (save the spreadsheet as CSV first)." })
      return
    }
    if (file.size > 1024 * 1024) {
      setError({ message: "The file is larger than 1 MB. Import at most 200 people at a time." })
      return
    }
    setBusy("parse")
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: "greedy",
      transformHeader: (h) => normaliseImportHeader(h) ?? `ignored:${h}`,
      complete: (res) => {
        setBusy(null)
        const headers = res.meta.fields ?? []
        const missing = missingImportColumns(headers.filter((h) => !h.startsWith("ignored:")))
        if (missing.length) {
          setError({ message: `The file has no ${missing.join(" or ")} column. The first row must name the columns: ${IMPORT_COLUMNS.join(", ")}.` })
          return
        }
        const rows: RawImportRow[] = res.data.map((r) => {
          const out: RawImportRow = {}
          for (const c of IMPORT_COLUMNS) if (typeof r[c] === "string") out[c] = r[c]
          return out
        })
        if (rows.length === 0) {
          setError({ message: "The file has a header row but no people under it." })
          return
        }
        if (rows.length > IMPORT_MAX_ROWS) {
          setError({ message: `The file has ${rows.length} people. Import at most ${IMPORT_MAX_ROWS} at a time.` })
          return
        }
        setStep({ kind: "preview", fileName: file.name, rows, checks: checkImportRows(rows, { actorRole, existingEmails: existing }) })
      },
      error: () => {
        setBusy(null)
        setError({ message: "The file couldn't be read. Check it's a CSV file and try again." })
      },
    })
  }

  const doImport = async () => {
    if (step.kind !== "preview") return
    setBusy("import")
    setError(null)
    try {
      const r = await importPeople({ rows: step.rows })
      if (!r.ok) {
        setError({ message: r.error, ref: r.ref })
        return
      }
      setStep({ kind: "done", result: r.data })
      router.refresh()
    } finally {
      setBusy(null)
    }
  }

  const doLogins = async () => {
    if (step.kind !== "done") return
    setBusy("logins")
    setError(null)
    try {
      const r = await issueLogins({ ids: step.result.created.map((c) => c.id) })
      if (!r.ok) {
        setError({ message: r.error, ref: r.ref })
        return
      }
      setOpen(false)
      reset()
      setLogins({ created: r.data.created, failed: r.data.failed })
      router.refresh()
    } finally {
      setBusy(null)
    }
  }

  const ready = step.kind === "preview" ? step.checks.filter((c) => c.row).length : 0
  const problems = step.kind === "preview" ? step.checks.length - ready : 0

  const footer =
    step.kind === "choose" ? (
      <div className="ml-auto flex items-center gap-2">
        <Button type="button" variant="outline" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button type="button" onClick={() => inputRef.current?.click()} disabled={busy !== null}>
          {busy === "parse" ? <Spinner /> : <UploadIcon aria-hidden="true" />}
          Choose CSV file
        </Button>
      </div>
    ) : step.kind === "preview" ? (
      <div className="ml-auto flex items-center gap-2">
        <Button type="button" variant="outline" onClick={reset} disabled={busy !== null}>
          Choose another file
        </Button>
        <Button type="button" onClick={doImport} disabled={busy !== null || ready === 0}>
          {busy === "import" ? <Spinner /> : null}
          {ready === 0 ? "Nothing to import" : `Import ${ready} ${ready === 1 ? "person" : "people"}`}
        </Button>
      </div>
    ) : (
      <div className="ml-auto flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setOpen(false)
            reset()
          }}
          disabled={busy !== null}
        >
          Issue logins later
        </Button>
        <Button type="button" onClick={doLogins} disabled={busy !== null || step.result.created.length === 0}>
          {busy === "logins" ? <Spinner /> : <KeyRoundIcon aria-hidden="true" />}
          Issue logins for {step.result.created.length} {step.result.created.length === 1 ? "person" : "people"}
        </Button>
      </div>
    )

  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <FileUpIcon aria-hidden="true" />
        Import CSV
      </Button>
      <FormDialog
        open={open}
        onOpenChange={(o) => {
          if (busy) return
          setOpen(o)
          if (!o) reset()
        }}
        size="xl"
        title="Import team members"
        description="Add several people from a CSV file. Their records are created first; you issue their logins in the next step."
        footer={footer}
        pending={busy !== null}
      >
        {error ? <FormAlert error={error} /> : null}
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) read(file)
          }}
        />
        {step.kind === "choose" ? (
          <div className="flex flex-col gap-4 text-base">
            <p className="text-text">
              The first row names the columns: <span className="font-mono text-[13px]">{IMPORT_COLUMNS.join(", ")}</span>. Only <span className="font-medium">name</span> and{" "}
              <span className="font-medium">email</span> are required.
            </p>
            <ul className="list-disc space-y-1 pl-5 text-sm text-text-muted">
              <li>Role is Partner, Manager or Employee; blank means Employee.{actorRole === "manager" ? " Managers import Employees only." : ""}</li>
              <li>Date of joining can be 22/10/2026, 2026-10-22 or 22 Oct 2026.</li>
              <li>At most {IMPORT_MAX_ROWS} people per file. Nothing is saved until you check the preview and press Import.</li>
            </ul>
            <div>
              <Button asChild variant="link">
                <a href={TEMPLATE_HREF} download="team-import-template.csv">
                  <DownloadIcon aria-hidden="true" />
                  Download a template
                </a>
              </Button>
            </div>
          </div>
        ) : step.kind === "preview" ? (
          <div className="flex flex-col gap-3">
            <p className="text-base text-text">
              <span className="font-medium">{step.fileName}</span>: {ready} ready to import
              {problems ? (
                <>
                  , <span className="text-danger-text">{problems} with problems</span> (they&apos;ll be skipped; fix the file and import them later)
                </>
              ) : null}
              .
            </p>
            <div className="max-h-[min(52dvh,28rem)] overflow-auto rounded-md border border-border">
              <table className="w-full border-separate border-spacing-0 text-sm">
                <caption className="sr-only">Rows in the file and what&apos;s wrong with them</caption>
                <thead>
                  <tr>
                    {["Line", "Name", "Email", "Role", "Check"].map((h, i) => (
                      <th key={h} scope="col" className={cn("sticky top-0 z-10 h-9 bg-surface-2 px-3 text-left text-xs font-medium text-text-muted shadow-[inset_0_-1px_0_var(--border)]", i === 0 && "w-14 text-right")}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {step.checks.map((c) => (
                    <tr key={c.line} className="align-top">
                      <td className="num border-b border-border/70 px-3 py-2 text-right text-text-muted">{c.line}</td>
                      <td className="border-b border-border/70 px-3 py-2 text-text">{c.raw.name || <span className="text-text-muted">—</span>}</td>
                      <td className="border-b border-border/70 px-3 py-2 break-all text-text-muted">{c.raw.email || "—"}</td>
                      <td className="border-b border-border/70 px-3 py-2">{c.row ? <RoleBadge role={c.row.role} /> : <span className="text-text-muted">{c.raw.role || "—"}</span>}</td>
                      <td className="border-b border-border/70 px-3 py-2">
                        {c.row ? (
                          <span className="inline-flex items-center gap-1.5 text-success-text">
                            <CircleCheckIcon aria-hidden="true" className="size-3.5" />
                            Ready
                          </span>
                        ) : (
                          <ul className="flex flex-col gap-0.5 text-danger-text">
                            {c.errors.map((e) => (
                              <li key={e} className="flex gap-1.5">
                                <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-3.5 flex-none" />
                                <span>{e}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3 text-base">
            <p className="flex items-start gap-2 text-text">
              <CircleCheckIcon aria-hidden="true" className="mt-0.5 size-4 flex-none text-success-text" />
              <span>
                {step.result.created.length} {step.result.created.length === 1 ? "person was" : "people were"} added. They show as{" "}
                <span className="font-medium">No login yet</span> until you issue their logins.
              </span>
            </p>
            {step.result.skipped.length ? (
              <p className="text-sm text-text-muted">
                Skipped: lines {step.result.skipped.map((s) => s.line).join(", ")} (they had problems, or someone already uses the email).
              </p>
            ) : null}
            <p className="text-sm text-text-muted">
              Issuing logins creates a temporary password for each person. You&apos;ll see the passwords once, with a WhatsApp button to share each one; nothing is emailed.
            </p>
          </div>
        )}
      </FormDialog>
      {logins ? <LoginCreatedDialog logins={logins.created} failed={logins.failed} open={!!logins} onOpenChange={(o) => !o && setLogins(null)} /> : null}
    </>
  )
}
