"use client"

import { cn } from "@/lib/utils"
import { CopyButton } from "@/components/app/copy-button"
import { StatusChip } from "@/components/app/status-chip"
import type { DnsRecordRow, DnsRecordStatus } from "@/server/email/policy"
import type { StatusTone } from "@/lib/status"

/**
 * The DNS records Resend asks for, plus our DMARC recommendation (§7.13.5 "shows the exact DNS
 * records (SPF, DKIM, return-path/MX, DMARC recommendation) with copy buttons"). A table on wide
 * screens; one card per record on phones. Each name and value has its own copy button; long values
 * (the DKIM key) wrap inside their cell, never the page.
 */

const RECORD_STATUS: Record<DnsRecordStatus, { label: string; tone: StatusTone; meaning: string }> = {
  verified: { label: "Verified", tone: "success", meaning: "Verified: Resend found this record with the right value." },
  pending: {
    label: "Not found yet",
    tone: "warning",
    meaning: "Not found yet: Resend hasn't seen this record. DNS changes can take from a few minutes to a few hours to show.",
  },
  not_started: { label: "Not checked", tone: "muted", meaning: "Not checked: Resend hasn't looked for this record yet. Add it, then Check now." },
  failed: {
    label: "Doesn't match",
    tone: "danger",
    meaning: "Doesn't match: Resend couldn't find this record, or found a different value. Check the name and value at your DNS provider.",
  },
  recommended: {
    label: "Recommended",
    tone: "muted",
    meaning: "Recommended: Resend doesn't check this one. DMARC tells mail servers what to do with mail that fails SPF and DKIM; p=none only watches, so it can't stop real mail.",
  },
}

function RecordChip({ status }: { status: DnsRecordStatus }) {
  const s = RECORD_STATUS[status]
  return <StatusChip label={s.label} tone={s.tone} meaning={s.meaning} />
}

function Mono({ value, className }: { value: string; className?: string }) {
  return <span className={cn("font-mono text-sm break-all text-text", className)}>{value}</span>
}

export function DnsRecords({ records, domain }: { records: DnsRecordRow[]; domain: string }) {
  return (
    <div className="min-w-0">
      {/* Wide screens: a table */}
      <div className="hidden overflow-x-auto rounded-md border border-border md:block">
        <table className="w-full min-w-[46rem] border-collapse text-left">
          <caption className="sr-only">DNS records to add for {domain}</caption>
          <thead className="bg-surface-2">
            <tr className="text-sm text-text-muted">
              <th scope="col" className="w-[19%] px-3 py-2 font-normal">Record</th>
              <th scope="col" className="w-[7%] px-3 py-2 font-normal">Type</th>
              <th scope="col" className="w-[22%] px-3 py-2 font-normal">Name</th>
              <th scope="col" className="px-3 py-2 font-normal">Value</th>
              <th scope="col" className="w-[8%] px-3 py-2 text-right font-normal">Priority</th>
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={`${r.purpose}-${r.type}-${r.host}`} className="border-t border-border align-top">
                <td className="px-3 py-2.5">
                  <p className="text-base font-medium text-text">{r.purpose}</p>
                  <div className="mt-0.5">
                    <RecordChip status={r.status} />
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <Mono value={r.type} />
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex items-start gap-1">
                    <Mono value={r.host} />
                    <CopyButton value={r.host} label={`name of the ${r.purpose} record`} />
                  </div>
                  {r.host !== "@" ? <p className="mt-0.5 text-xs text-text-muted break-all">{r.fullName}</p> : null}
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex items-start gap-1">
                    <Mono value={r.value} className="max-w-[34rem]" />
                    <CopyButton value={r.value} label={`value of the ${r.purpose} record`} />
                  </div>
                </td>
                <td className="num px-3 py-2.5 text-right text-base text-text">
                  {r.priority ?? <span className="text-text-muted">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Phones: one card per record */}
      <ul className="flex flex-col gap-2 md:hidden" aria-label={`DNS records to add for ${domain}`}>
        {records.map((r) => (
          <li key={`${r.purpose}-${r.type}-${r.host}`} className="rounded-md border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-base font-medium text-text">
                {r.purpose} <span className="font-mono text-sm text-text-muted">{r.type}</span>
              </p>
              <RecordChip status={r.status} />
            </div>
            <dl className="mt-2 grid grid-cols-[4.5rem_1fr] gap-x-2 gap-y-1.5">
              <dt className="text-sm text-text-muted">Name</dt>
              <dd className="flex min-w-0 items-start gap-1">
                <Mono value={r.host} />
                <CopyButton value={r.host} label={`name of the ${r.purpose} record`} />
              </dd>
              <dt className="text-sm text-text-muted">Value</dt>
              <dd className="flex min-w-0 items-start gap-1">
                <Mono value={r.value} className="min-w-0" />
                <CopyButton value={r.value} label={`value of the ${r.purpose} record`} />
              </dd>
              {r.priority !== null ? (
                <>
                  <dt className="text-sm text-text-muted">Priority</dt>
                  <dd className="num text-base text-text">{r.priority}</dd>
                </>
              ) : null}
            </dl>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-sm text-text-muted">
        TTL: leave it at your provider&apos;s default (Auto or 3600). Some providers want the full name ({records[0]?.fullName ?? domain}); others add
        &nbsp;.{domain} themselves, so enter only the part before it.
      </p>
    </div>
  )
}
