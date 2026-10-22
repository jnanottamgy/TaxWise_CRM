/**
 * Sample content for the UI kit gallery (app/(dev)/kit) ONLY: the visual QA page that is
 * notFound() in production. Nothing else may import this file; it never reaches the database.
 */
import { applyTablePatch, escapeLike, parseTableParams, type SearchParamsInput } from "@/components/app/data-table/params"
import { addDays } from "@/lib/domain/fy"

export interface KitClientRow {
  id: string
  name: string
  code: string
  gstin: string | null
  status: "active" | "pending" | "on_hold" | "inactive"
  owner: string
  nextFiling: string
  nextDue: string | null
  fee: number | null
  outstanding: number
}

const NAMES = [
  "Sharma Traders", "Kaveri Textiles LLP", "Nandini Agro Foods Pvt Ltd", "Bhat & Rao Associates", "Malnad Coffee Estates",
  "Shree Ganesh Hardware", "Indiranagar Dental Clinic", "Vasudha Organics", "Coastal Marine Exports", "Hebbal Auto Spares",
  "Jayanagar Opticals", "Rajajinagar Steel Works", "Kumar Family HUF", "Anitha Krishnan", "Mysore Silk House",
  "Deccan Logistics Pvt Ltd", "Sunrise Pharma Distributors", "Green Leaf Caterers", "Prakash Electricals", "Udupi Grand Hotels",
  "Nilgiri Tea Traders", "Veena Ramesh (Proprietor)", "BlueOak Software LLP", "Chamundi Builders", "Srinivasa Jewellers",
  "Lakshmi Rice Mills", "Basavanagudi Medicals", "Arka Solar Systems", "Vijaya Bank Employees Co-op", "Tumkur Granite Exports",
  "Raghavendra Transport", "Silicon Valley Interiors", "Kodagu Spices", "Metro Cash Traders", "Pai & Sons", "Hampi Heritage Tours",
  "Sahyadri Seeds", "Whitefield Diagnostics", "Mangalore Tiles Co", "Royal Enfield Service Centre Yelahanka", "Karavali Fisheries",
  "Shivaji Nagar Footwear", "Krishna Dairy Farms", "Electronic City Hostels", "Bengaluru Book Depot", "Tirupati Packaging",
  "Navya Fashions", "Shetty Constructions", "Gokul Sweets", "Pristine Labs Pvt Ltd", "Yeshwanthpur Timber Mart",
  "Om Sai Enterprises", "Kalpataru Trust", "Narayana Eye Care", "Swastik Polymers", "Majestic Travels", "Rangoli Handicrafts",
]

const OWNERS = ["Anita Rao", "Vikram Shetty", "Deepa Nair", "Rahul Menon", "Kavya Iyer"]
const FILINGS = ["GSTR-3B · Sep 2026", "GSTR-1 · Sep 2026", "TDS 24Q · Q2 2026-27", "ITR · AY 2026-27", "Advance tax · Q3", "ROC AOC-4 · FY 2025-26"]
const STATUSES: KitClientRow["status"][] = ["active", "active", "active", "pending", "active", "on_hold", "active", "inactive"]

/** 57 deterministic sample clients (the same on every render). */
export const KIT_CLIENTS: KitClientRow[] = NAMES.map((name, i) => {
  const n = i + 1
  const gstRegistered = i % 6 !== 4
  const panSeed = (n * 7919).toString(36).toUpperCase().padStart(4, "Q").slice(-4)
  return {
    id: `kit-client-${n}`,
    name,
    code: `TW-C-${String(n).padStart(4, "0")}`,
    gstin: gstRegistered ? `29AAK${panSeed}${String.fromCharCode(65 + (i % 26))}1Z${(i % 9) + 1}` : null,
    status: STATUSES[i % STATUSES.length],
    owner: OWNERS[i % OWNERS.length],
    nextFiling: FILINGS[i % FILINGS.length],
    nextDue: i % 11 === 10 ? null : addDays("2026-10-22", ((i * 5) % 29) - 6),
    fee: i % 9 === 8 ? null : 2500 + ((i * 1750) % 22500),
    outstanding: i % 4 === 0 ? 0 : ((i * 13_457) % 245_000) + 0.5 * (i % 2),
  }
})

export const KIT_SORTABLE = ["name", "code", "next_due", "fee", "outstanding"] as const
export const KIT_STATUS_VALUES = ["active", "pending", "on_hold", "inactive"] as const

/** The same thing a lib/data range query does, done in memory for the kit. */
export function queryKitClients(sp: SearchParamsInput) {
  const t = parseTableParams(sp, {
    sortable: KIT_SORTABLE,
    defaultSort: { sort: "name", dir: "asc" },
    filters: { status: KIT_STATUS_VALUES, owner: OWNERS },
  })
  const needle = escapeLike(t.q).replace(/\\(.)/g, "$1").toLowerCase()
  let rows = KIT_CLIENTS.filter(
    (r) =>
      (!needle || r.name.toLowerCase().includes(needle) || r.code.toLowerCase().includes(needle) || (r.gstin ?? "").toLowerCase().includes(needle)) &&
      (!t.filters.status || t.filters.status.includes(r.status)) &&
      (!t.filters.owner || t.filters.owner.includes(r.owner))
  )
  const key = (r: KitClientRow): string | number => {
    switch (t.sort) {
      case "code":
        return r.code
      case "next_due":
        return r.nextDue ?? "9999-12-31"
      case "fee":
        return r.fee ?? -1
      case "outstanding":
        return r.outstanding
      default:
        return r.name.toLowerCase()
    }
  }
  rows = [...rows].sort((a, b) => {
    const ka = key(a)
    const kb = key(b)
    const c = ka < kb ? -1 : ka > kb ? 1 : 0
    return t.dir === "asc" ? c : -c
  })
  return { ...t, total: rows.length, rows: rows.slice(t.from, t.to + 1) }
}

export const KIT_OWNERS = OWNERS

/** Monthly collections for FY 2026-27 so far, in rupees. */
export const KIT_COLLECTIONS = [
  { month: "Apr", collected: 412_300, lastYear: 365_000 },
  { month: "May", collected: 389_750, lastYear: 371_200 },
  { month: "Jun", collected: 455_100, lastYear: 402_800 },
  { month: "Jul", collected: 521_900, lastYear: 433_500 },
  { month: "Aug", collected: 498_400, lastYear: 441_000 },
  { month: "Sep", collected: 612_350, lastYear: 512_600 },
  { month: "Oct", collected: 287_600, lastYear: 476_300 },
]

export const KIT_FILED = [
  { month: "Apr", filed: 182 },
  { month: "May", filed: 176 },
  { month: "Jun", filed: 191 },
  { month: "Jul", filed: 240 },
  { month: "Aug", filed: 188 },
  { month: "Sep", filed: 205 },
  { month: "Oct", filed: 121 },
]

export const KIT_BILLING_BY_SERVICE = [
  { month: "Jul", gst: 238_000, income_tax: 156_000, audit: 82_000, other: 41_500 },
  { month: "Aug", gst: 241_500, income_tax: 98_000, audit: 112_000, other: 38_000 },
  { month: "Sep", gst: 252_000, income_tax: 211_000, audit: 96_500, other: 44_200 },
  { month: "Oct", gst: 129_000, income_tax: 74_000, audit: 51_000, other: 19_800 },
]

/** A query string the saved-views demo can link to. */
export const KIT_VIEWS = [
  { id: "v1", name: "Pending onboarding", query: applyTablePatch(null, { filters: { status: ["pending"] } }) },
  { id: "v2", name: "Due soonest", query: applyTablePatch(null, { sort: "next_due", dir: "asc" }) },
  { id: "v3", name: "Anita's clients", query: applyTablePatch(null, { filters: { owner: ["Anita Rao"] } }), shared: true },
]
