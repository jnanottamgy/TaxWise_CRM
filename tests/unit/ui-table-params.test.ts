import { describe, expect, it } from "vitest"
import {
  applyTablePatch,
  escapeLike,
  hasActiveFilters,
  nextSort,
  pageCount,
  pageWindow,
  parseTableParams,
  rangeLabel,
  readParamList,
  tableHref,
} from "@/components/app/data-table/params"

describe("parseTableParams", () => {
  it("uses defaults when nothing is in the URL", () => {
    const t = parseTableParams({}, { sortable: ["name"], defaultSort: "name" })
    expect(t).toEqual({ page: 1, pageSize: 25, sort: "name", dir: "asc", q: "", filters: {}, from: 0, to: 24 })
  })

  it("reads page, size, sort, dir and q from a Next.js searchParams record", () => {
    const t = parseTableParams(
      { page: "3", size: "50", sort: "due_date", dir: "desc", q: "  sharma   traders " },
      { sortable: ["name", "due_date"], defaultSort: { sort: "name", dir: "asc" } }
    )
    expect(t.page).toBe(3)
    expect(t.pageSize).toBe(50)
    expect(t.sort).toBe("due_date")
    expect(t.dir).toBe("desc")
    expect(t.q).toBe("sharma traders")
    expect(t.from).toBe(100)
    expect(t.to).toBe(149)
  })

  it("accepts URLSearchParams too", () => {
    const t = parseTableParams(new URLSearchParams("page=2&size=100"), {})
    expect(t.page).toBe(2)
    expect(t.pageSize).toBe(100)
    expect(t.from).toBe(100)
    expect(t.to).toBe(199)
  })

  it("ignores a sort column that is not whitelisted (never reaches SQL)", () => {
    const t = parseTableParams({ sort: "password_hash", dir: "desc" }, { sortable: ["name"], defaultSort: "-created_at" as never })
    expect(t.sort).toBe("created_at")
    expect(t.dir).toBe("desc")
  })

  it("supports the '-column' shorthand for a descending default", () => {
    const t = parseTableParams({}, { sortable: ["created_at"], defaultSort: "-created_at" })
    expect(t.sort).toBe("created_at")
    expect(t.dir).toBe("desc")
  })

  it("falls back on malformed paging", () => {
    for (const page of ["0", "-2", "abc", "1.5", "99999999999"]) {
      expect(parseTableParams({ page }).page).toBe(1)
    }
    expect(parseTableParams({ size: "30" }).pageSize).toBe(25)
    expect(parseTableParams({ size: "1000" }).pageSize).toBe(25)
  })

  it("caps the search text at 100 characters", () => {
    expect(parseTableParams({ q: "x".repeat(300) }).q).toHaveLength(100)
  })

  it("reads filters from comma lists and repeated keys, de-duplicated", () => {
    const sp = new URLSearchParams("status=active,pending&status=pending&owner=abc")
    const t = parseTableParams(sp, { filters: ["status", "owner"] })
    expect(t.filters).toEqual({ status: ["active", "pending"], owner: ["abc"] })
  })

  it("keeps only allowed values for enum filters and drops empty ones", () => {
    const t = parseTableParams({ status: "active,deleted", priority: "nope" }, { filters: { status: ["active", "pending"], priority: ["low", "high"] } })
    expect(t.filters).toEqual({ status: ["active"] })
  })

  it("never treats reserved params as filters", () => {
    const t = parseTableParams({ page: "2", tab: "billing" }, { filters: ["page", "tab", "status"] })
    expect(t.filters).toEqual({})
  })
})

describe("applyTablePatch / tableHref", () => {
  it("resets the page when search, filters, sort or size change", () => {
    const current = new URLSearchParams("page=4&status=active")
    expect(applyTablePatch(current, { q: "gst" })).toBe("status=active&q=gst")
    expect(applyTablePatch(current, { filters: { status: ["pending"] } })).toBe("status=pending")
    expect(applyTablePatch(current, { sort: "name", dir: "desc" })).toBe("status=active&sort=name&dir=desc")
    expect(applyTablePatch(current, { pageSize: 50 })).toBe("status=active&size=50")
  })

  it("keeps the page when only the page changes, and omits defaults", () => {
    const current = new URLSearchParams("status=active&size=50")
    expect(applyTablePatch(current, { page: 3 })).toBe("status=active&size=50&page=3")
    expect(applyTablePatch(current, { page: 1 })).toBe("status=active&size=50")
    expect(applyTablePatch(current, { pageSize: 25 })).toBe("status=active")
  })

  it("removes cleared filters and an empty search", () => {
    const current = new URLSearchParams("q=sharma&status=active&tab=tasks")
    expect(applyTablePatch(current, { q: "", filters: { status: null } })).toBe("tab=tasks")
  })

  it("builds hrefs for KPI tiles", () => {
    expect(tableHref("/work", { filters: { status: ["data_awaited"] }, sort: "due_date" })).toBe(
      "/work?status=data_awaited&sort=due_date&dir=asc"
    )
    expect(tableHref("/clients", {})).toBe("/clients")
  })
})

describe("helpers", () => {
  it("formats the range label with Indian grouping and an en dash", () => {
    expect(rangeLabel(1, 25, 1284)).toBe("1–25 of 1,284")
    expect(rangeLabel(52, 25, 1284)).toBe("1,276–1,284 of 1,284")
    expect(rangeLabel(2, 100, 128400)).toBe("101–200 of 1,28,400")
    expect(rangeLabel(1, 25, 0)).toBe("0 results")
    expect(rangeLabel(9, 25, 10)).toBe("10 total")
  })

  it("counts pages", () => {
    expect(pageCount(0, 25)).toBe(1)
    expect(pageCount(25, 25)).toBe(1)
    expect(pageCount(26, 25)).toBe(2)
  })

  it("windows page numbers with gaps", () => {
    expect(pageWindow(1, 1)).toEqual([1])
    expect(pageWindow(1, 5)).toEqual([1, 2, 3, 4, 5])
    expect(pageWindow(5, 52)).toEqual([1, "gap", 4, 5, 6, "gap", 52])
    expect(pageWindow(1, 52)).toEqual([1, 2, "gap", 52])
    expect(pageWindow(52, 52)).toEqual([1, "gap", 51, 52])
    expect(pageWindow(3, 52)).toEqual([1, 2, 3, 4, "gap", 52])
  })

  it("cycles sort asc → desc → default", () => {
    const def = { sort: "name", dir: "asc" as const }
    expect(nextSort("due_date", { sort: "name", dir: "asc" }, def)).toEqual({ sort: "due_date", dir: "asc" })
    expect(nextSort("due_date", { sort: "due_date", dir: "asc" }, def)).toEqual({ sort: "due_date", dir: "desc" })
    expect(nextSort("due_date", { sort: "due_date", dir: "desc" }, def)).toEqual({ sort: "name", dir: "asc" })
    expect(nextSort("name", { sort: "name", dir: "desc" }, def)).toEqual({ sort: "name", dir: "asc" })
  })

  it("escapes LIKE wildcards", () => {
    expect(escapeLike("50%_off\\")).toBe("50\\%\\_off\\\\")
  })

  it("detects active filters", () => {
    expect(hasActiveFilters({ q: " " }, ["status"])).toBe(false)
    expect(hasActiveFilters({ q: "gst" }, ["status"])).toBe(true)
    expect(hasActiveFilters({ status: "active" }, ["status"])).toBe(true)
    expect(hasActiveFilters({ tab: "tasks" }, ["status"])).toBe(false)
  })

  it("limits filter values", () => {
    const many = Array.from({ length: 80 }, (_, i) => `v${i}`).join(",")
    expect(readParamList({ status: many }, "status")).toHaveLength(50)
  })
})
