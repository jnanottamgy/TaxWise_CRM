import { describe, expect, it } from "vitest"
import { boardMoveOptions, dropCheck, type BoardCardFacts } from "@/components/tasks/board-logic"
import { askClientDraft, askClientSubject, askClientValues, missingLines, type AskClientFacts } from "@/lib/schemas/tasks"

const EMP = "11111111-1111-4111-8111-111111111111"
const OTHER = "22222222-2222-4222-8222-222222222222"
const MGR = "33333333-3333-4333-8333-333333333333"

const card = (over: Partial<BoardCardFacts> = {}): BoardCardFacts => ({
  status: "in_progress",
  assigned_employee_id: EMP,
  acceptance_status: "accepted",
  declined_by_employee_id: null,
  open_blockers: 0,
  ...over,
})

describe("board moves (§7.6.1, §7.6.4)", () => {
  it("lets the assignee move their accepted task, but never to Filed/Done", () => {
    const viewer = { role: "employee" as const, employeeId: EMP }
    expect(dropCheck(card(), "data_awaited", viewer)).toEqual({ ok: true, requiresReason: false })
    expect(dropCheck(card(), "under_review", viewer)).toEqual({ ok: true, requiresReason: false })
    const filed = dropCheck(card(), "filed_done", viewer)
    expect(filed.ok).toBe(false)
    if (!filed.ok) expect(filed.error).toMatch(/Employees can't set Filed\/Done/)
  })

  it("refuses an Employee moving someone else's task", () => {
    const r = dropCheck(card({ assigned_employee_id: OTHER }), "data_awaited", { role: "employee", employeeId: EMP })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/assigned to you/)
  })

  it("refuses moves while the task waits for acceptance", () => {
    const r = dropCheck(card({ acceptance_status: "pending", status: "not_started" }), "in_progress", { role: "manager", employeeId: MGR })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/waiting for acceptance/)
  })

  it("asks for a reason when a Manager sends work back from Under review", () => {
    expect(dropCheck(card({ status: "under_review" }), "in_progress", { role: "manager", employeeId: MGR })).toEqual({ ok: true, requiresReason: true })
    expect(dropCheck(card({ status: "under_review" }), "filed_done", { role: "manager", employeeId: MGR })).toEqual({ ok: true, requiresReason: false })
  })

  it("stops a Manager filing their own work", () => {
    const r = dropCheck(card({ status: "under_review", assigned_employee_id: MGR }), "filed_done", { role: "manager", employeeId: MGR })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/Nobody files their own work/)
  })

  it("names the count of open blockers on dependency-gated columns only", () => {
    const blocked = card({ status: "not_started", open_blockers: 2 })
    const viewer = { role: "partner" as const, employeeId: null }
    const r = dropCheck(blocked, "in_progress", viewer)
    expect(r).toEqual({ ok: false, error: "Waiting on 2 blocking tasks that aren't Filed/Done yet." })
    expect(dropCheck(blocked, "data_awaited", viewer)).toEqual({ ok: true, requiresReason: false })
    expect(dropCheck(blocked, "on_hold", viewer)).toEqual({ ok: true, requiresReason: true })
    const one = dropCheck(card({ status: "not_started", open_blockers: 1 }), "under_review", viewer)
    expect(one).toEqual({ ok: false, error: "Waiting on 1 blocking task that isn't Filed/Done yet." })
  })

  it("refuses a drop on the card's own column", () => {
    expect(dropCheck(card(), "in_progress", { role: "partner", employeeId: null })).toEqual({ ok: false, error: "It's already in this column." })
  })

  it("lists every other column once", () => {
    const opts = boardMoveOptions(card(), { role: "partner", employeeId: null })
    expect(opts.map((o) => o.status).sort()).toEqual(["data_awaited", "filed_done", "not_started", "on_hold", "under_review"])
  })
})

const facts = (over: Partial<AskClientFacts> = {}): AskClientFacts => ({
  contactName: "Ramesh",
  clientName: "Sharma Traders",
  clientCode: "TW-C-0042",
  taskTitle: "GSTR-3B",
  period: "Sep 2026",
  serviceLabel: "GST",
  missing: ["Sales register", "Purchase invoices"],
  dueDateText: "18 Oct 2026",
  portalLink: "https://portal.example.test/requests/abc",
  firmName: "TaxWise Consultants",
  firmPhone: "+91 80 4000 0000",
  senderName: "Anita",
  ...over,
})

describe("asking the client for data (§7.6.6, §7.13.4)", () => {
  it("lists the open items, or the work itself when nothing is listed", () => {
    expect(missingLines([" Sales register ", "", "Bank statement"], "GSTR-3B")).toEqual(["• Sales register", "• Bank statement"])
    expect(missingLines([], "GSTR-3B")).toEqual(["• The data and documents for GSTR-3B"])
  })

  it("drafts the message with the period, the deadline and the portal link", () => {
    const d = askClientDraft(facts())
    expect(d.split("\n")).toEqual([
      "Hi Ramesh,",
      "",
      "To complete GSTR-3B (Sep 2026) for Sharma Traders, we need the following by 18 Oct 2026:",
      "• Sales register",
      "• Purchase invoices",
      "",
      "You can upload them here: https://portal.example.test/requests/abc",
    ])
  })

  it("greets plainly without a contact name and leaves out a missing period and date", () => {
    const d = askClientDraft(facts({ contactName: null, period: null, dueDateText: null }))
    expect(d.startsWith("Hello,\n\nTo complete GSTR-3B for Sharma Traders, we need the following:")).toBe(true)
  })

  it("builds the email subject", () => {
    expect(askClientSubject(facts())).toBe("TaxWise Consultants | Data needed for GSTR-3B (Sep 2026)")
    expect(askClientSubject(facts({ period: null }))).toBe("TaxWise Consultants | Data needed for GSTR-3B")
  })

  it("fills every template variable, empty when unknown", () => {
    const v = askClientValues(facts({ firmPhone: null, contactName: null }))
    expect(v.missing_items).toBe("• Sales register\n• Purchase invoices")
    expect(v.firm_phone).toBe("")
    expect(v.contact_name).toBe("")
    expect(v.client_code).toBe("TW-C-0042")
    expect(Object.values(v).every((x) => typeof x === "string")).toBe(true)
  })
})
