"use client"

import * as React from "react"
import { createClient } from "@/lib/supabase/browser"
import { finishChecklistUpload, prepareChecklistUpload } from "@/server/actions/clients"
import type { CHECKLIST_DOCUMENT_CATEGORIES } from "@/lib/schemas/clients"

type Category = (typeof CHECKLIST_DOCUMENT_CATEGORIES)[number]

export type UploadJob = {
  itemId: string
  label: string
  file: File
  category: Category
  status: "queued" | "uploading" | "done" | "failed"
  error?: string
}

const CATEGORY_BY_WORD: Array<[RegExp, Category]> = [
  [/engagement letter/i, "engagement"],
  [/authori[sz]ation|credential/i, "agreements"],
  [/\bgst\b|gstr|sales and purchase/i, "gst"],
  [/\btds\b|\btan\b|deductee|challan/i, "tds"],
  [/\bitr\b|26as|\bais\b|pan copy|income/i, "income_tax"],
  [/bank/i, "bank_statements"],
  [/invoice|bill/i, "invoices"],
  [/incorporation|moa|aoa|statutory register|director/i, "roc"],
  [/audit|trial balance|fixed asset|noc/i, "audit"],
  [/payroll|employee master|\bpf\b|esic|\bpt\b/i, "payroll"],
  [/kyc/i, "kyc"],
]

/** The vault category a checklist item's file is filed under (§5.8). */
export function categoryForChecklistLabel(label: string): Category {
  for (const [re, cat] of CATEGORY_BY_WORD) if (re.test(label)) return cat
  return "other"
}

/**
 * Files picked in step 4 are filed in the new client's vault once it exists (§7.3.2 "optionally
 * attach the file there and then"): a signed upload to `client-documents/<client_id>/<uuid>.<ext>`,
 * then the server checks the real type and ticks the checklist item. One at a time, with retry.
 */
export function useChecklistUploads() {
  const [jobs, setJobs] = React.useState<UploadJob[]>([])
  const clientRef = React.useRef<string | null>(null)

  const patch = (i: number, p: Partial<UploadJob>) => setJobs((js) => js.map((j, k) => (k === i ? { ...j, ...p } : j)))

  const runOne = async (clientId: string, job: UploadJob, i: number) => {
    patch(i, { status: "uploading", error: undefined })
    try {
      const prep = await prepareChecklistUpload({ clientId, itemId: job.itemId, fileName: job.file.name, size: job.file.size })
      if (!prep.ok) throw new Error(prep.error)
      const supabase = createClient()
      const up = await supabase.storage.from("client-documents").uploadToSignedUrl(prep.data.path, prep.data.token, job.file, { contentType: prep.data.contentType })
      if (up.error) throw new Error("The upload didn't go through. Check your connection and try again.")
      const done = await finishChecklistUpload({ clientId, itemId: job.itemId, path: prep.data.path, fileName: job.file.name, category: job.category })
      if (!done.ok) throw new Error(done.error)
      patch(i, { status: "done" })
    } catch (err) {
      patch(i, { status: "failed", error: err instanceof Error ? err.message : "The file couldn't be filed." })
    }
  }

  const start = async (clientId: string, list: Array<Omit<UploadJob, "status" | "category">>) => {
    clientRef.current = clientId
    const initial = list.map((j) => ({ ...j, category: categoryForChecklistLabel(j.label), status: "queued" as const }))
    setJobs(initial)
    for (let i = 0; i < initial.length; i++) await runOne(clientId, initial[i], i)
  }

  const retry = async (i: number) => {
    const clientId = clientRef.current
    const job = jobs[i]
    if (!clientId || !job) return
    await runOne(clientId, job, i)
  }

  return { jobs, start, retry }
}
