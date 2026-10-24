/**
 * How the audit log reads (§7.20, §5.11): event names in plain words, resource types as nouns, and
 * the before/after of a change pulled out of an entry's details. Pure and client-safe; the page, the
 * drawer and the CSV export share it.
 */

import { AUDIT_EVENTS, type AuditEvent } from "@/lib/domain/enums"

export const AUDIT_EVENT_LABEL: Readonly<Record<AuditEvent, string>> = {
  login_success: "Signed in",
  login_failure: "Sign-in failed",
  logout: "Signed out",
  password_change: "Password changed",
  access_denied: "Access refused",
  permission_change: "Permission changed",
  data_create: "Created",
  data_update: "Changed",
  data_delete: "Deleted",
  file_upload: "File uploaded",
  file_download: "File downloaded",
  credential_viewed: "Portal password revealed",
  config_change: "Setting changed",
  user_create: "Person added",
  user_update: "Person changed",
  user_disable: "Person disabled",
  export_run: "Export run",
  record_viewed: "Record viewed",
}

export function auditEventLabel(event: string): string {
  return (AUDIT_EVENTS as readonly string[]).includes(event) ? AUDIT_EVENT_LABEL[event as AuditEvent] : humanise(event)
}

/** `client_covers` → "Client covers", `gst_recon_run` → "GST recon run". */
export function humanise(key: string | null | undefined): string {
  if (!key) return ""
  const words = key
    .replace(/[._-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .map((w) => w.toLowerCase())
  const upper = new Set(["gst", "tds", "itr", "pan", "gstin", "tan", "udin", "dsc", "roc", "pdf", "csv", "id", "ip", "upi", "kyc", "sms", "otp", "mfa", "aal2", "ca", "fy", "ay", "sac", "irn", "arn", "dpdp", "url"])
  return words
    .map((w, i) => (upper.has(w) ? w.toUpperCase() : i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ")
}

/** "Partner", "Manager", "Employee", "Client" or the stored text; empty for system events. */
export function roleLabel(role: string | null | undefined): string {
  if (!role) return ""
  return role === "partner" ? "Partner" : role === "manager" ? "Manager" : role === "employee" ? "Employee" : role === "client" ? "Client" : humanise(role)
}

// -------------------------------------------------------------------------------------------------
// Before / after
// -------------------------------------------------------------------------------------------------

export type AuditChange = { field: string; before: unknown; after: unknown }
export type AuditDetailsView = {
  /** Field-by-field changes, from `before`/`after` or a `changes` list. */
  changes: AuditChange[]
  /** Everything else in the details, as label/value pairs. */
  other: Array<{ label: string; value: unknown }>
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/**
 * The before/after of an entry (§7.20 "detail drawer with before/after"). Understands the shapes the
 * actions write: `{ before: {...}, after: {...} }` (one row per field, changed fields only when any
 * field changed), `{ field, before, after }` and `{ before: x, after: y }` (one row), and
 * `{ changes: [{ field | id | client_id, before, after }] }` (one row each). Anything else in the
 * details is listed as it is.
 */
export function auditDetailsView(details: unknown): AuditDetailsView {
  if (!isRecord(details)) return { changes: [], other: details === null || details === undefined ? [] : [{ label: "Details", value: details }] }
  const changes: AuditChange[] = []
  const used = new Set<string>()

  if ("before" in details || "after" in details) {
    const before = details.before
    const after = details.after
    used.add("before")
    used.add("after")
    if (isRecord(before) || isRecord(after)) {
      const b = isRecord(before) ? before : {}
      const a = isRecord(after) ? after : {}
      const keys = Array.from(new Set([...Object.keys(b), ...Object.keys(a)]))
      const rows = keys.map((k) => ({ field: humanise(k), before: b[k], after: a[k] }))
      const changed = rows.filter((r) => !same(r.before, r.after))
      changes.push(...(changed.length ? changed : rows))
    } else {
      const field = typeof details.field === "string" ? details.field : "value"
      if ("field" in details) used.add("field")
      changes.push({ field: humanise(field), before, after })
    }
  }

  if (Array.isArray(details.changes)) {
    used.add("changes")
    for (const c of details.changes) {
      if (!isRecord(c)) continue
      const name = typeof c.field === "string" ? humanise(c.field) : typeof c.id === "string" ? c.id : typeof c.client_id === "string" ? c.client_id : "Change"
      changes.push({ field: name, before: c.before, after: c.after })
    }
  }

  const other = Object.entries(details)
    .filter(([k, v]) => !used.has(k) && v !== undefined)
    .map(([k, v]) => ({ label: humanise(k), value: v }))
  return { changes, other }
}

/** One value for the drawer or a CSV cell: an em dash when missing, Yes/No, JSON for objects. */
export function auditValueText(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—"
  if (typeof v === "boolean") return v ? "Yes" : "No"
  if (typeof v === "string") return v
  if (typeof v === "number") return String(v)
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}
