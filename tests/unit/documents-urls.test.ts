import { describe, expect, it } from "vitest"
import { documentsHref, fileHref } from "@/components/documents/doc-urls"

const C = "0b6a1f6e-2d7c-4c1e-9f3a-5d8e7c6b5a40"
const D = "9d3c2b1a-0f4e-4d5c-8b7a-6e5d4c3b2a10"

describe("documents links (Client 360 → Documents)", () => {
  it("opens the tab, a view and a document", () => {
    expect(documentsHref(C, {})).toBe(`/clients/${C}?tab=documents`)
    expect(documentsHref(C, { docs: "requests" })).toBe(`/clients/${C}?tab=documents&docs=requests`)
    expect(documentsHref(C, { docs: "vault" })).toBe(`/clients/${C}?tab=documents`)
    expect(documentsHref(C, { doc: D }, { tab: "documents", dcat: "gst", q: "bank" })).toBe(`/clients/${C}?tab=documents&dcat=gst&q=bank&doc=${D}`)
  })

  it("keeps the search and layout when choosing a folder, and starts at page 1", () => {
    const current = new URLSearchParams({ tab: "documents", q: "bank", dview: "grid", page: "3", doc: D })
    expect(documentsHref(C, { docs: "vault", doc: null, dcat: "gst" }, current)).toBe(`/clients/${C}?tab=documents&q=bank&dview=grid&dcat=gst`)
  })

  it("drops the vault's state when switching to another view", () => {
    const current = new URLSearchParams({ tab: "documents", q: "bank", dcat: "gst", page: "2" })
    expect(documentsHref(C, { docs: "checklist" }, current)).toBe(`/clients/${C}?tab=documents&docs=checklist`)
  })

  it("links files through /api/files", () => {
    expect(fileHref(D)).toBe(`/api/files/documents/${D}`)
    expect(fileHref(D, { mode: "preview", json: true })).toBe(`/api/files/documents/${D}?mode=preview&as=json`)
    expect(fileHref(D, { version: 2 })).toBe(`/api/files/documents/${D}?version=2`)
  })
})
