import { describe, expect, it } from "vitest";
import { filingStatusFromGroups, moneyHref, practiceHref, workHref } from "@/components/home/logic";
import { parseTableParams } from "@/components/app/data-table/params";
import { INVOICE_LIST_FILTERS, INVOICE_LIST_SORTABLE } from "@/lib/schemas/invoices";
import { QUOTATION_FILTERS, QUOTATION_SORTABLE } from "@/lib/schemas/quotations";
import { LEAD_FILTERS, LEAD_SORTABLE } from "@/lib/schemas/leads";
import { REGISTER_FILTERS, REGISTER_SORTABLE } from "@/lib/schemas/whatsapp";
import { AUDIT_LIST_FILTERS, AUDIT_LIST_SORTABLE } from "@/lib/schemas/audits";
import { NOTICE_LIST_FILTERS, NOTICE_LIST_SORTABLE } from "@/lib/schemas/notices";
import { DATA_REQUEST_FILTERS, DATA_REQUEST_SORTABLE } from "@/lib/schemas/dpdp";
import { WORK_FILTERS, WORK_SORTABLE } from "@/lib/schemas/tasks";
import { parseLetterView } from "@/lib/schemas/engagement-letters";
import { LEAD_STATUSES } from "@/lib/domain/enums";

/** The path and the filters the destination page would read from the link (its own definitions). */
function read(href: string, opts: Parameters<typeof parseTableParams>[1]) {
  const [path, qs] = href.split("?");
  const sp = new URLSearchParams(qs ?? "");
  return { path, sp, t: parseTableParams(sp, opts) };
}

describe("every money figure opens the filtered list behind it (§7.2)", () => {
  const invoices = { sortable: INVOICE_LIST_SORTABLE, filters: INVOICE_LIST_FILTERS };

  it("overdue, outstanding and held invoices", () => {
    expect(read(moneyHref.overdue(), invoices)).toMatchObject({ path: "/invoices", t: { filters: { status: ["overdue"] }, sort: "due_date", dir: "asc" } });
    expect(read(moneyHref.outstanding(), invoices).t.filters).toEqual({ status: ["sent", "partially_paid", "disputed"] });
    expect(read(moneyHref.awaitingApproval(), invoices).t.filters).toEqual({ status: ["awaiting_approval"] });
    expect(read(moneyHref.issuedThisMonth(), invoices).t.filters).toEqual({ period: ["this_month"] });
  });

  it("invoiced and received open the revenue ledger for the same dates", () => {
    const inv = read(moneyHref.invoiced("2026-04-01", "2026-10-24"), {});
    expect(inv.path).toBe("/revenue");
    expect(Object.fromEntries(inv.sp)).toEqual({ tab: "invoices", from: "2026-04-01", to: "2026-10-24" });
    expect(Object.fromEntries(read(moneyHref.received("2026-10-01", "2026-10-24"), {}).sp)).toEqual({ tab: "receipts", from: "2026-10-01", to: "2026-10-24" });
  });

  it("quotations and leads", () => {
    const quotations = { sortable: QUOTATION_SORTABLE, filters: QUOTATION_FILTERS };
    expect(read(moneyHref.quotationsPending(), quotations).t.filters).toEqual({ status: ["pending_approval"] });
    expect(read(moneyHref.quotationsAwaiting(), quotations).t.filters).toEqual({ status: ["sent", "viewed"] });
    expect(read(moneyHref.quotationsDecided(), quotations).t.filters).toEqual({ status: ["accepted", "rejected", "expired"] });
    const leads = { sortable: LEAD_SORTABLE, filters: LEAD_FILTERS };
    expect(read(moneyHref.openLeads(), leads).t.filters).toEqual({ status: LEAD_STATUSES.filter((s) => s !== "won" && s !== "lost") });
    expect(read(moneyHref.staleLeads(), leads).t.filters).toEqual({ flag: ["stale"] });
  });
});

describe("every practice-health title opens its register filtered (§7.2)", () => {
  it("audits, notices, data requests and WhatsApp groups use those pages' own filters", () => {
    expect(read(practiceHref.assemblyDue(), { sortable: AUDIT_LIST_SORTABLE, filters: AUDIT_LIST_FILTERS }).t.filters).toEqual({ attention: ["assembly_due"] });
    expect(read(practiceHref.assemblyOverdue(), { sortable: AUDIT_LIST_SORTABLE, filters: AUDIT_LIST_FILTERS }).t.filters).toEqual({ attention: ["assembly_overdue"] });
    expect(read(practiceHref.noticesOverdue(), { sortable: NOTICE_LIST_SORTABLE, filters: NOTICE_LIST_FILTERS }).t.filters).toEqual({ attention: ["reply_overdue"] });
    expect(read(practiceHref.noticesDue(), { sortable: NOTICE_LIST_SORTABLE, filters: NOTICE_LIST_FILTERS }).t.filters).toEqual({ attention: ["reply_week"] });
    const dr = read(practiceHref.dataRequests(), { sortable: DATA_REQUEST_SORTABLE, filters: DATA_REQUEST_FILTERS });
    expect(dr).toMatchObject({ path: "/quality", t: { filters: { status: ["open_all"] } } });
    expect(dr.sp.get("tab")).toBe("data-requests");
    expect(read(practiceHref.dataRequestsOverdue(), { sortable: DATA_REQUEST_SORTABLE, filters: DATA_REQUEST_FILTERS }).t.filters).toEqual({ status: ["overdue"] });
    expect(read(practiceHref.noWhatsAppGroup(), { sortable: REGISTER_SORTABLE, filters: REGISTER_FILTERS })).toMatchObject({ path: "/whatsapp-groups", t: { filters: { status: ["none"] } } });
  });

  it("engagement letters open the missing and expiring views", () => {
    const view = (href: string) => {
      const sp = new URLSearchParams(href.split("?")[1]);
      return parseLetterView(sp.get("view"), sp.get("missing"));
    };
    expect(view(practiceHref.lettersMissing())).toBe("missing");
    expect(view(practiceHref.lettersExpiring())).toBe("expiring");
  });

  it("registers open the right tab with the 30-day window", () => {
    expect(Object.fromEntries(new URLSearchParams(practiceHref.dscExpiring().split("?")[1]))).toEqual({ tab: "dsc", expiring: "30" });
    expect(Object.fromEntries(new URLSearchParams(practiceHref.registrationsExpiring().split("?")[1]))).toEqual({ tab: "registrations", expiring: "30" });
    expect(practiceHref.udin()).toBe("/registers?tab=udin");
  });

  it("an at-risk client's overdue tasks open the work tracker filtered to that client", () => {
    expect(read(workHref.overdueForClient("c1"), { sortable: WORK_SORTABLE, filters: WORK_FILTERS }).t.filters).toEqual({ due: ["overdue"], client: ["c1"] });
  });
});

describe("filing status from the database's groups", () => {
  it("folds type, form and rule groups into the grid's return types, in the grid's order, Other last", () => {
    const rows = filingStatusFromGroups([
      { type: "custom", form_code: "Board meeting", rule_code: null, filed: 0, pending: 2, overdue: 0 },
      { type: "gstr_3b", form_code: "GSTR-3B", rule_code: null, filed: 4, pending: 1, overdue: 2 },
      // No form or rule code: the grid can't place it, so it counts under Other (as on the grid).
      { type: "gstr_3b", form_code: null, rule_code: null, filed: 1, pending: 0, overdue: 0 },
      { type: "gstr_3b", form_code: "PMT-06", rule_code: null, filed: 0, pending: 3, overdue: 0 },
      { type: "tds", form_code: null, rule_code: "TDS_RETURN_Q2", filed: 0, pending: 0, overdue: 5 },
      { type: "gstr_1", form_code: "GSTR-1", rule_code: null, filed: 0, pending: 0, overdue: 0 },
    ]);
    const by = Object.fromEntries(rows.map((r) => [r.type, r]));
    expect(by.tds_return).toMatchObject({ filed: 0, pending: 0, overdue: 5, total: 5, label: "TDS return", href: "/filings?type=tds_return" });
    expect(by.pmt_06).toMatchObject({ pending: 3, total: 3 });
    expect(by.gstr_3b).toMatchObject({ filed: 4, pending: 1, overdue: 2, total: 7 });
    expect(by.other).toMatchObject({ filed: 1, pending: 2, total: 3, href: null });
    expect(rows[rows.length - 1].type).toBe("other");
    // A type with nothing due is left out.
    expect(by.gstr_1).toBeUndefined();
    // The totals add up to the groups'.
    expect(rows.reduce((n, r) => n + r.total, 0)).toBe(4 + 1 + 2 + 1 + 3 + 5 + 2);
  });

  it("is empty when nothing falls due", () => {
    expect(filingStatusFromGroups([])).toEqual([]);
  });
});
