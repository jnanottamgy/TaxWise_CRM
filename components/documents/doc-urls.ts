/**
 * Links inside Client 360 → Documents (§7.3.3 tab 6): every view is a URL, so a folder, a document or
 * a request can be shared or opened from a notification. Pure and client-safe.
 *
 *   documentsHref(clientId, { docs: "vault", dcat: "gst" })        → /clients/<id>?tab=documents&docs=vault&dcat=gst
 *   documentsHref(clientId, { doc: id }, currentParams)            → keeps the current folder, opens the document
 *   fileHref(documentId, { mode: "preview" })                      → /api/files/documents/<id>?mode=preview
 */

type Params = URLSearchParams | Record<string, string | string[] | undefined> | null | undefined

/** Params that belong to the vault's folder and list state (cleared when the sub-tab changes). */
const VAULT_STATE = ["q", "page", "size", "sort", "dir", "dcat", "dfy", "dview", "dbin", "dexp", "doc"]

export function documentsHref(clientId: string, patch: Record<string, string | null | undefined>, current?: Params): string {
  const next = new URLSearchParams()
  if (current) {
    if (current instanceof URLSearchParams) current.forEach((v, k) => next.append(k, v))
    else
      for (const [k, v] of Object.entries(current)) {
        if (v === undefined) continue
        for (const one of Array.isArray(v) ? v : [v]) next.append(k, one)
      }
  }
  next.set("tab", "documents")
  // "vault" is the default view: it is never written into the URL.
  if ("docs" in patch) {
    const from = next.get("docs") || "vault"
    const to = patch.docs || "vault"
    if (from !== to) for (const k of [...VAULT_STATE, "request", "rstatus"]) next.delete(k)
  }
  // A change of folder or filter starts at page 1.
  if (["dcat", "dfy", "dbin", "dexp", "q", "dview"].some((k) => k in patch)) next.delete("page")
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === "" || (k === "docs" && v === "vault")) next.delete(k)
    else next.set(k, v)
  }
  return `/clients/${clientId}?${next.toString()}`
}

export function fileHref(documentId: string, opts: { mode?: "preview" | "download"; version?: number | null; json?: boolean } = {}): string {
  const p = new URLSearchParams()
  if (opts.mode === "preview") p.set("mode", "preview")
  if (opts.version) p.set("version", String(opts.version))
  if (opts.json) p.set("as", "json")
  const qs = p.toString()
  return `/api/files/documents/${documentId}${qs ? `?${qs}` : ""}`
}
