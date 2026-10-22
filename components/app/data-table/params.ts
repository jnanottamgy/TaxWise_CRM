/**
 * URL <-> table state (§2.3, §3.4: pagination, sort, filter and search happen in SQL; URL search
 * params hold the table state). Pure and server-safe: import it from Server Components and lib/data.
 *
 * URL shape:  ?q=sharma&status=active,pending&owner=<uuid>&sort=due_date&dir=asc&page=2&size=50
 *
 * In a page (Next 16: searchParams is a Promise):
 *   const sp = await props.searchParams
 *   const t = parseTableParams(sp, {
 *     sortable: ["name", "client_code", "created_at"],
 *     defaultSort: { sort: "name", dir: "asc" },
 *     filters: { status: CLIENT_STATUSES, owner: null },
 *   })
 *   // lib/data: query.order(t.sort, { ascending: t.dir === "asc" }).range(t.from, t.to)
 *   //           if (t.q) query.ilike("name", `%${escapeLike(t.q)}%`)
 *   //           if (t.filters.status) query.in("status", t.filters.status)
 */

export const PAGE_SIZES = [25, 50, 100] as const
export type PageSize = (typeof PAGE_SIZES)[number]
export const DEFAULT_PAGE_SIZE: PageSize = 25

export type SortDir = "asc" | "desc"

/** Search-param names used by every table. Filters use their own names (e.g. `status`). */
export const TABLE_PARAM = {
  page: "page",
  pageSize: "size",
  sort: "sort",
  dir: "dir",
  q: "q",
} as const

/**
 * Params that are never treated as filters: table state, tabs and views on the same page, and the
 * financial year (page context from the FY switcher, if it is carried in the URL).
 */
export const RESERVED_PARAMS: readonly string[] = ["page", "size", "sort", "dir", "q", "tab", "view", "fy"]

const MAX_QUERY_LENGTH = 100
const MAX_FILTER_VALUES = 50
const MAX_FILTER_VALUE_LENGTH = 100
const MAX_PAGE = 100_000

/** A page's awaited `searchParams`, a URLSearchParams (incl. Next's ReadonlyURLSearchParams), or nothing. */
export type SearchParamsInput = URLSearchParams | Record<string, string | string[] | undefined> | null | undefined

export type DefaultSort<S extends string> = { sort: S; dir: SortDir } | S | `-${S}` | null

export interface TableParamsOptions<S extends string = string, F extends string = string> {
  /** Columns the database may order by. Anything else in `?sort=` is ignored (falls back to defaultSort). */
  sortable?: readonly S[]
  /** `{ sort: "due_date", dir: "asc" }`, or the shorthand `"due_date"` / `"-created_at"` (desc). */
  defaultSort?: DefaultSort<S>
  /**
   * Filter params to read. Either a list of names (any value accepted, e.g. ids), or a record of
   * name → allowed values (enum filters; `null` = any value).
   */
  filters?: readonly F[] | Partial<Record<F, readonly string[] | null>>
  defaultPageSize?: PageSize
}

export interface TableParams<S extends string = string, F extends string = string> {
  /** 1-based page number. */
  page: number
  pageSize: PageSize
  /** Validated sort column, or null when the table has no sort. */
  sort: S | null
  dir: SortDir
  /** Trimmed search text ("" when none). Escape it before using in ilike (see escapeLike). */
  q: string
  /** Only filters that are present and valid. Values are de-duplicated, in URL order. */
  filters: Partial<Record<F, string[]>>
  /** Inclusive row range for Supabase `.range(from, to)`. */
  from: number
  to: number
}

function isRecordInput(sp: SearchParamsInput): sp is Record<string, string | string[] | undefined> {
  return !!sp && !(sp instanceof URLSearchParams)
}

/** First value of a param, from either a URLSearchParams-like object or a Next.js searchParams record. */
export function readParam(sp: SearchParamsInput, name: string): string | null {
  if (!sp) return null
  if (isRecordInput(sp)) {
    const v = sp[name]
    if (Array.isArray(v)) return v[0] ?? null
    return v ?? null
  }
  return sp.get(name)
}

/** Every value of a param (repeated keys and comma-separated lists both count). */
export function readParamList(sp: SearchParamsInput, name: string): string[] {
  if (!sp) return []
  let raw: string[]
  if (isRecordInput(sp)) {
    const v = sp[name]
    raw = v === undefined ? [] : Array.isArray(v) ? v : [v]
  } else {
    raw = sp.getAll(name)
  }
  const out: string[] = []
  for (const chunk of raw) {
    for (const part of chunk.split(",")) {
      const v = part.trim()
      if (v && v.length <= MAX_FILTER_VALUE_LENGTH && !out.includes(v)) out.push(v)
      if (out.length >= MAX_FILTER_VALUES) return out
    }
  }
  return out
}

export function normaliseDefaultSort<S extends string>(d: DefaultSort<S> | undefined): { sort: S; dir: SortDir } | null {
  if (!d) return null
  if (typeof d === "object") return d
  if (d.startsWith("-")) return { sort: d.slice(1) as S, dir: "desc" }
  return { sort: d as S, dir: "asc" }
}

function parsePositiveInt(v: string | null): number | null {
  if (v === null || !/^\d{1,9}$/.test(v)) return null
  const n = Number(v)
  return n >= 1 ? n : null
}

export function isPageSize(n: number): n is PageSize {
  return (PAGE_SIZES as readonly number[]).includes(n)
}

/**
 * Reads and validates table state from search params. Never throws: anything malformed falls back
 * to the default, so a hand-edited URL can't break the page or reach SQL unchecked.
 */
export function parseTableParams<S extends string = string, F extends string = string>(
  sp: SearchParamsInput,
  opts: TableParamsOptions<S, F> = {}
): TableParams<S, F> {
  const pageSize = (() => {
    const n = parsePositiveInt(readParam(sp, TABLE_PARAM.pageSize))
    return n !== null && isPageSize(n) ? n : (opts.defaultPageSize ?? DEFAULT_PAGE_SIZE)
  })()
  const page = Math.min(parsePositiveInt(readParam(sp, TABLE_PARAM.page)) ?? 1, MAX_PAGE)

  const def = normaliseDefaultSort(opts.defaultSort)
  const sortable = (opts.sortable ?? []) as readonly string[]
  const rawSort = readParam(sp, TABLE_PARAM.sort)
  const rawDir = readParam(sp, TABLE_PARAM.dir)
  let sort: S | null = def?.sort ?? null
  let dir: SortDir = def?.dir ?? "asc"
  if (rawSort && sortable.includes(rawSort)) {
    sort = rawSort as S
    dir = rawDir === "desc" ? "desc" : "asc"
  } else if (def && (rawDir === "asc" || rawDir === "desc") && !rawSort) {
    dir = rawDir
  }

  const q = (readParam(sp, TABLE_PARAM.q) ?? "").trim().replace(/\s+/g, " ").slice(0, MAX_QUERY_LENGTH)

  const filters: Partial<Record<F, string[]>> = {}
  const spec = opts.filters
  if (spec) {
    const entries: Array<[string, readonly string[] | null]> = Array.isArray(spec)
      ? (spec as readonly string[]).map((name) => [name, null])
      : (Object.entries(spec) as Array<[string, readonly string[] | null | undefined]>).map(([k, v]) => [k, v ?? null])
    for (const [name, allowed] of entries) {
      if (RESERVED_PARAMS.includes(name)) continue
      const values = readParamList(sp, name).filter((v) => !allowed || allowed.includes(v))
      if (values.length > 0) filters[name as F] = values
    }
  }

  const from = (page - 1) * pageSize
  return { page, pageSize, sort, dir, q, filters, from, to: from + pageSize - 1 }
}

/** Escapes `%`, `_` and `\` for use inside a Postgres LIKE/ILIKE pattern. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

export interface TableStatePatch {
  page?: number | null
  pageSize?: number | null
  sort?: string | null
  dir?: SortDir | null
  q?: string | null
  /** Filter name → values. `null` or `[]` removes the filter. */
  filters?: Record<string, readonly string[] | null | undefined>
}

/**
 * Applies a patch to existing search params and returns the new query string (without "?").
 * Changing q, filters, sort or page size resets the page to 1 unless `page` is in the patch.
 * Defaults are omitted (page 1, size 25), so URLs stay short and shareable.
 */
export function applyTablePatch(current: SearchParamsInput, patch: TableStatePatch): string {
  const next = new URLSearchParams()
  if (current) {
    if (isRecordInput(current)) {
      for (const [k, v] of Object.entries(current)) {
        if (v === undefined) continue
        for (const one of Array.isArray(v) ? v : [v]) next.append(k, one)
      }
    } else {
      current.forEach((v, k) => next.append(k, v))
    }
  }

  const resetsPage =
    patch.q !== undefined || patch.filters !== undefined || patch.sort !== undefined || patch.pageSize !== undefined

  if (patch.q !== undefined) {
    const q = (patch.q ?? "").trim()
    if (q) next.set(TABLE_PARAM.q, q.slice(0, MAX_QUERY_LENGTH))
    else next.delete(TABLE_PARAM.q)
  }
  if (patch.filters) {
    for (const [name, values] of Object.entries(patch.filters)) {
      if (RESERVED_PARAMS.includes(name)) continue
      next.delete(name)
      const clean = (values ?? []).map((v) => v.trim()).filter(Boolean)
      if (clean.length > 0) next.set(name, Array.from(new Set(clean)).join(","))
    }
  }
  if (patch.sort !== undefined) {
    if (patch.sort) {
      next.set(TABLE_PARAM.sort, patch.sort)
      next.set(TABLE_PARAM.dir, patch.dir === "desc" ? "desc" : "asc")
    } else {
      next.delete(TABLE_PARAM.sort)
      next.delete(TABLE_PARAM.dir)
    }
  } else if (patch.dir !== undefined) {
    if (patch.dir) next.set(TABLE_PARAM.dir, patch.dir)
    else next.delete(TABLE_PARAM.dir)
  }
  if (patch.pageSize !== undefined) {
    if (patch.pageSize && isPageSize(patch.pageSize) && patch.pageSize !== DEFAULT_PAGE_SIZE) {
      next.set(TABLE_PARAM.pageSize, String(patch.pageSize))
    } else {
      next.delete(TABLE_PARAM.pageSize)
    }
  }
  if (patch.page !== undefined) {
    if (patch.page && patch.page > 1) next.set(TABLE_PARAM.page, String(Math.floor(patch.page)))
    else next.delete(TABLE_PARAM.page)
  } else if (resetsPage) {
    next.delete(TABLE_PARAM.page)
  }
  return next.toString()
}

/**
 * Builds a link to a table view, e.g. for KPI tiles and "View all" (§7.2: every tile links to the
 * filtered list behind it).
 *
 *   tableHref("/work", { filters: { status: ["data_awaited"] }, sort: "due_date" })
 *   // → "/work?status=data_awaited&sort=due_date&dir=asc"
 */
export function tableHref(pathname: string, patch: TableStatePatch, current?: SearchParamsInput): string {
  const qs = applyTablePatch(current ?? null, patch)
  return qs ? `${pathname}?${qs}` : pathname
}

/** True when search or any of the given filters is active (drives FilteredEmpty and "Clear filters"). */
export function hasActiveFilters(sp: SearchParamsInput, filterNames: readonly string[]): boolean {
  if ((readParam(sp, TABLE_PARAM.q) ?? "").trim()) return true
  return filterNames.some((n) => readParamList(sp, n).length > 0)
}

const groupIN = new Intl.NumberFormat("en-IN")

/** Formats a count with Indian digit grouping: 128400 → "1,28,400". */
export function formatCount(n: number): string {
  return groupIN.format(n)
}

export function pageCount(total: number, pageSize: number): number {
  if (total <= 0 || pageSize <= 0) return 1
  return Math.ceil(total / pageSize)
}

/** "1–25 of 1,284" (en dash). "0 of 0" is never shown: an empty table shows its empty state instead. */
export function rangeLabel(page: number, pageSize: number, total: number): string {
  if (total <= 0) return "0 results"
  const from = Math.min((page - 1) * pageSize + 1, total)
  const to = Math.min(page * pageSize, total)
  if (from > total || (page - 1) * pageSize >= total) return `${formatCount(total)} total`
  return `${formatCount(from)}–${formatCount(to)} of ${formatCount(total)}`
}

/**
 * Page numbers to show around the current page, with gaps: [1, "gap", 4, 5, 6, "gap", 52].
 * Always shows the first and last page; `siblings` pages either side of the current one.
 */
export function pageWindow(page: number, count: number, siblings = 1): Array<number | "gap"> {
  if (count <= 1) return [1]
  if (count <= 5 + 2 * siblings) return Array.from({ length: count }, (_, i) => i + 1)
  const p = Math.min(Math.max(1, page), count)
  const start = Math.max(2, p - siblings)
  const end = Math.min(count - 1, p + siblings)
  const out: Array<number | "gap"> = [1]
  if (start > 2) out.push(start === 3 ? 2 : "gap")
  for (let i = start; i <= end; i++) out.push(i)
  if (end < count - 1) out.push(end === count - 2 ? count - 1 : "gap")
  out.push(count)
  return out
}

/** Next sort state when a header is clicked: asc → desc → back to the default sort. */
export function nextSort(
  column: string,
  current: { sort: string | null; dir: SortDir },
  defaultSort?: { sort: string; dir: SortDir } | null
): { sort: string | null; dir: SortDir } {
  if (current.sort !== column) return { sort: column, dir: "asc" }
  if (current.dir === "asc") return { sort: column, dir: "desc" }
  if (defaultSort && defaultSort.sort !== column) return { sort: defaultSort.sort, dir: defaultSort.dir }
  return { sort: column, dir: "asc" }
}
