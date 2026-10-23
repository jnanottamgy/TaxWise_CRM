import { describe, expect, it } from "vitest";
import { clientWarnings, type WarningFacts } from "@/components/client360/logic/warnings";
import { nextInvoicePreview, type NextInvoiceInput } from "@/components/client360/logic/next-invoice";
import { describeTeamChange, teamPickFrom, teamSignature } from "@/components/client360/logic/team";
import { groupByDay, groupOf, groupOrFilter, hasTimelineFilters, istRangeBounds, parseTimelineFilters, timelineGroups } from "@/components/client360/logic/timeline";
import { CLIENT_TABS, resolveTab, tabHref, visibleTabs } from "@/components/client360/logic/tabs";
import { kycCompleteness } from "@/lib/domain/ceiling";

// -------------------------------------------------------------------------------------------------
// Tabs (§7.3.3: * = Partner/Manager only)
// -------------------------------------------------------------------------------------------------

describe("Client 360 tabs", () => {
  it("lists the thirteen tabs in spec order for Partners and Managers", () => {
    expect(visibleTabs("partner").map((t) => t.id)).toEqual([
      "overview",
      "profile",
      "services",
      "tasks",
      "compliance",
      "documents",
      "workpapers",
      "registers",
      "billing",
      "engagement",
      "communication",
      "whatsapp",
      "timeline",
    ]);
    expect(visibleTabs("manager")).toHaveLength(CLIENT_TABS.length);
  });

  it("hides Services & fees, Billing and Engagement from Employees and never resolves to them", () => {
    const ids = visibleTabs("employee").map((t) => t.id);
    expect(ids).not.toContain("services");
    expect(ids).not.toContain("billing");
    expect(ids).not.toContain("engagement");
    expect(resolveTab("billing", "employee")).toBe("overview");
    expect(resolveTab("services", "employee")).toBe("overview");
    expect(resolveTab("billing", "manager")).toBe("billing");
    expect(resolveTab(["timeline", "x"], "employee")).toBe("timeline");
    expect(resolveTab("nonsense", "partner")).toBe("overview");
    expect(resolveTab(undefined, "partner")).toBe("overview");
  });

  it("builds tab links without carrying other tabs' params", () => {
    expect(tabHref("c1", "overview")).toBe("/clients/c1");
    expect(tabHref("c1", "timeline", { from: "2026-10-23" })).toBe("/clients/c1?tab=timeline&from=2026-10-23");
  });
});

// -------------------------------------------------------------------------------------------------
// Warnings strip (§7.3.3)
// -------------------------------------------------------------------------------------------------

const baseFacts = (over: Partial<WarningFacts> = {}): WarningFacts => ({
  clientId: "c1",
  client: {
    email: "accounts@sharma.in",
    phone: null,
    whatsapp: null,
    gst_registration: "registered",
    gstin: "29AAXFT1811B1Z3",
    portal_user_id: null,
    portal_invited_at: null,
    portal_last_seen_at: null,
  },
  contacts: [],
  activeServices: ["gst"],
  kyc: null,
  engagementLetter: null,
  dsc: [],
  today: "2026-10-23",
  ...over,
});

describe("clientWarnings", () => {
  it("is empty for a client in order", () => {
    expect(clientWarnings(baseFacts())).toEqual([]);
  });

  it("flags a client nobody can reach, but not when a contact has a phone", () => {
    const client = { ...baseFacts().client, email: null };
    expect(clientWarnings(baseFacts({ client })).map((w) => w.id)).toEqual(["unreachable"]);
    expect(clientWarnings(baseFacts({ client, contacts: [{ email: null, phone: "98450 12345", whatsapp: null }] }))).toEqual([]);
  });

  it("flags a missing GSTIN for a registered client or an active GST service", () => {
    const registered = clientWarnings(baseFacts({ client: { ...baseFacts().client, gstin: null } }));
    expect(registered[0].id).toBe("gstin_missing");
    expect(registered[0].message).toMatch(/Registered for GST/);
    const unknown = clientWarnings(baseFacts({ client: { ...baseFacts().client, gstin: null, gst_registration: "unknown" } }));
    expect(unknown[0].message).toMatch(/isn't confirmed/);
    const noGst = clientWarnings(baseFacts({ client: { ...baseFacts().client, gstin: null, gst_registration: "unregistered" }, activeServices: ["income_tax"] }));
    expect(noGst).toEqual([]);
  });

  it("flags incomplete KYC only for audit clients", () => {
    const kyc = kycCompleteness({ entityCategory: "corporate", name: "Beta Industries", pan: "AABCB1234C" }, "2026-10-23");
    expect(clientWarnings(baseFacts({ kyc })).map((w) => w.id)).toEqual([]);
    const audit = clientWarnings(baseFacts({ kyc, activeServices: ["audit"] }));
    expect(audit.map((w) => w.id)).toEqual(["kyc"]);
    expect(audit[0].message).toMatch(/CIN/);
  });

  it("flags the engagement letter for the FY: missing, draft, expired; not when issued or signed", () => {
    expect(clientWarnings(baseFacts({ engagementLetter: { fy: "2026-27", status: null } }))[0].message).toBe("No engagement letter for FY 2026-27.");
    expect(clientWarnings(baseFacts({ engagementLetter: { fy: "2026-27", status: "draft" } }))[0].message).toMatch(/still a draft/);
    expect(clientWarnings(baseFacts({ engagementLetter: { fy: "2026-27", status: "expired" } }))[0].message).toMatch(/expired/);
    expect(clientWarnings(baseFacts({ engagementLetter: { fy: "2026-27", status: "signed" } }))).toEqual([]);
    // No active services: nothing to engage for.
    expect(clientWarnings(baseFacts({ activeServices: [], engagementLetter: { fy: "2026-27", status: null } }))).toEqual([]);
  });

  it("flags a DSC expiring within 30 days, and an expired one as a danger", () => {
    const soon = clientWarnings(baseFacts({ dsc: [{ holder_name: "Ravi", expiry_date: "2026-11-10", status: "active" }] }));
    expect(soon[0]).toMatchObject({ id: "dsc", tone: "warning" });
    expect(soon[0].message).toMatch(/expires on 10 Nov 2026, in 18 days/);
    const gone = clientWarnings(baseFacts({ dsc: [{ holder_name: "Ravi", expiry_date: "2026-10-01", status: "active" }, { holder_name: "Anita", expiry_date: "2026-11-01", status: "active" }] }));
    expect(gone[0]).toMatchObject({ tone: "danger" });
    expect(gone[0].message).toMatch(/expired on 01 Oct 2026 \(and 1 other\)/);
    expect(clientWarnings(baseFacts({ dsc: [{ holder_name: "Old", expiry_date: "2026-10-01", status: "revoked" }] }))).toEqual([]);
    expect(clientWarnings(baseFacts({ dsc: [{ holder_name: "Later", expiry_date: "2027-06-30", status: "active" }] }))).toEqual([]);
  });

  it("flags an invite that was never used", () => {
    const client = { ...baseFacts().client, portal_user_id: "u1", portal_invited_at: "2026-10-12T05:00:00Z" };
    expect(clientWarnings(baseFacts({ client }))[0].message).toBe("The portal invite sent on 12 Oct 2026 hasn't been used yet.");
    expect(clientWarnings(baseFacts({ client: { ...client, portal_last_seen_at: "2026-10-13T05:00:00Z" } }))).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------------
// Next invoice preview (§7.3.3 tab 3, §6.4)
// -------------------------------------------------------------------------------------------------

const firm = { state_code: "29", default_tax_rate: 18, default_sac: "9982", sac_by_service: { audit: "998221", income_tax: "998231", income_tax_individual: "998232" } };
const svc = (over: Partial<NextInvoiceInput["service"]> = {}): NextInvoiceInput["service"] => ({
  service_type: "gst",
  custom_name: null,
  frequency: "monthly",
  billing_frequency: null,
  agreed_fee: "5000.00",
  sac_code: null,
  auto_invoice: true,
  next_billing_date: "2026-11-01",
  is_active: true,
  ...over,
});
const cl = (over: Partial<NextInvoiceInput["client"]> = {}): NextInvoiceInput["client"] => ({ gstin: "29AAXFT1811B1Z3", state_code: "29", entity_type: "partnership", status: "active", ...over });

describe("nextInvoicePreview", () => {
  it("splits CGST and SGST within Karnataka", () => {
    const p = nextInvoicePreview({ service: svc(), client: cl(), firm, today: "2026-10-23" });
    expect(p.kind).toBe("preview");
    if (p.kind !== "preview") return;
    expect(p).toMatchObject({ taxablePaise: 500000, cgstPaise: 45000, sgstPaise: 45000, igstPaise: 0, totalPaise: 590000, intraState: true, sac: "9982", periodLabel: "Nov 2026", billingDate: "2026-11-01" });
    expect(p.description).toBe("GST returns · Nov 2026");
    expect(p.basis).toMatch(/09:30 retainer run on the billing date/);
  });

  it("charges IGST to another state and uses the SAC override, then the map", () => {
    const igst = nextInvoicePreview({ service: svc({ agreed_fee: 12345.67, sac_code: "998222" }), client: cl({ gstin: "27AAXFT1811B1Z9", state_code: "27" }), firm, today: "2026-10-23" });
    if (igst.kind !== "preview") throw new Error("expected a preview");
    expect(igst).toMatchObject({ intraState: false, igstPaise: 222222, totalPaise: 1456789, sac: "998222" });
    expect(igst.placeOfSupply.code).toBe("27");
    const individual = nextInvoicePreview({ service: svc({ service_type: "income_tax", frequency: "annual", next_billing_date: "2027-07-01" }), client: cl({ entity_type: "individual", gstin: null }), firm, today: "2026-10-23" });
    if (individual.kind !== "preview") throw new Error("expected a preview");
    expect(individual.sac).toBe("998232");
    expect(individual.periodLabel).toBe("FY 2027-28");
  });

  it("explains when there is nothing to preview, or when billing is paused or by hand", () => {
    expect(nextInvoicePreview({ service: svc({ agreed_fee: null }), client: cl(), firm, today: "2026-10-23" })).toMatchObject({ kind: "none", reason: expect.stringMatching(/No fee agreed/) });
    expect(nextInvoicePreview({ service: svc({ is_active: false }), client: cl(), firm, today: "2026-10-23" })).toMatchObject({ kind: "none" });
    expect(nextInvoicePreview({ service: svc({ agreed_fee: 0 }), client: cl(), firm, today: "2026-10-23" })).toMatchObject({ kind: "none" });
    const held = nextInvoicePreview({ service: svc(), client: cl({ status: "on_hold" }), firm, today: "2026-10-23" });
    expect(held.kind === "preview" && held.paused).toMatch(/paused while the client is on hold/);
    const manual = nextInvoicePreview({ service: svc({ auto_invoice: false, frequency: "one_time", next_billing_date: null }), client: cl(), firm, today: "2026-10-23" });
    expect(manual).toMatchObject({ kind: "preview", billingDate: null, periodLabel: "One-time", description: "GST returns" });
    expect(manual.kind === "preview" && manual.basis).toMatch(/by hand/);
  });
});

// -------------------------------------------------------------------------------------------------
// Team (§5.3, §13)
// -------------------------------------------------------------------------------------------------

describe("team", () => {
  const a = "11111111-1111-4111-8111-111111111111";
  const b = "22222222-2222-4222-8222-222222222222";
  const c = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  it("signs the owner and team the way client_team_signature does (role, then id, C order)", () => {
    expect(teamSignature(a, [])).toBe(`owner:${a};`);
    expect(teamSignature(null, [])).toBe("owner:;");
    expect(
      teamSignature(a, [
        { employee_id: c, team_role: "preparer" },
        { employee_id: b, team_role: "review_manager" },
        { employee_id: a, team_role: "preparer" },
        { employee_id: b, team_role: "engagement_partner" },
      ]),
    ).toBe(`owner:${a};engagement_partner:${b},preparer:${a},preparer:${c},review_manager:${b}`);
  });

  it("picks one engagement partner and review manager, and every preparer", () => {
    expect(teamPickFrom(a, [{ employee_id: b, team_role: "engagement_partner" }, { employee_id: c, team_role: "preparer" }, { employee_id: a, team_role: "preparer" }])).toEqual({
      owner: a,
      engagementPartner: b,
      reviewManager: null,
      preparers: [c, a],
    });
  });

  it("describes a change in words", () => {
    const names: Record<string, string> = { [a]: "Anita Rao", [b]: "Ravi Kumar" };
    const label = (r: string) => (r === "preparer" ? "Preparer" : "Review manager");
    expect(
      describeTeamChange({ added: [{ employee_id: a, team_role: "preparer" }], removed: [{ employee_id: b, team_role: "review_manager" }], ownerChanged: true, owner: b }, (id) => names[id], label),
    ).toEqual(["Ravi Kumar is now the client owner", "Anita Rao added as preparer", "Ravi Kumar removed as review manager"]);
  });
});

// -------------------------------------------------------------------------------------------------
// Timeline (§7.3.3 tab 13)
// -------------------------------------------------------------------------------------------------

describe("timeline filters", () => {
  it("groups event types by their longest prefix; money-side groups are separate", () => {
    expect(groupOf("task_created")).toBe("work");
    expect(groupOf("invoice_message_sent")).toBe("billing");
    expect(groupOf("fee_changed")).toBe("billing");
    expect(groupOf("message_sent")).toBe("messages");
    expect(groupOf("portal_invited")).toBe("onboarding");
    expect(groupOf("portal_message_received")).toBe("messages");
    expect(groupOf("client_status_changed")).toBe("onboarding");
    expect(groupOf("kyc_verified")).toBe("team");
    expect(groupOf("something_new")).toBeNull();
  });

  it("never offers money-side groups to Employees, and drops them from the URL", () => {
    expect(timelineGroups(false).map((g) => g.id)).not.toContain("billing");
    expect(timelineGroups(false).map((g) => g.id)).not.toContain("sales");
    expect(parseTimelineFilters({ type: "billing,work" }, false).groups).toEqual(["work"]);
    expect(parseTimelineFilters({ type: "billing,work" }, true).groups).toEqual(["billing", "work"]);
  });

  it("reads the cover window (from/to), swapping a reversed range and dropping bad dates", () => {
    expect(parseTimelineFilters({ from: "2026-10-23", to: "2026-10-25" }, false)).toMatchObject({ from: "2026-10-23", to: "2026-10-25" });
    expect(parseTimelineFilters({ from: "2026-10-25", to: "2026-10-23" }, false)).toMatchObject({ from: "2026-10-23", to: "2026-10-25" });
    expect(parseTimelineFilters({ from: "25/10/2026" }, false).from).toBeNull();
    expect(hasTimelineFilters(parseTimelineFilters({}, false))).toBe(false);
    expect(hasTimelineFilters(parseTimelineFilters({ q: "  gst  " }, false))).toBe(true);
  });

  it("turns groups into a PostgREST or-filter and IST days into instants", () => {
    expect(groupOrFilter([])).toBeNull();
    expect(groupOrFilter(["work"])).toBe("event_type.like.task_*");
    expect(groupOrFilter(["compliance"])).toBe("event_type.like.compliance_*,event_type.like.filing_*,event_type.like.udin_*");
    expect(istRangeBounds("2026-10-23", "2026-10-25")).toEqual({ gte: "2026-10-22T18:30:00.000Z", lt: "2026-10-25T18:30:00.000Z" });
    expect(istRangeBounds(null, null)).toEqual({ gte: null, lt: null });
  });

  it("groups rows by day, keeping order", () => {
    const rows = [
      { d: "2026-10-23", t: "b" },
      { d: "2026-10-23", t: "a" },
      { d: "2026-10-21", t: "c" },
    ];
    expect(groupByDay(rows, (r) => r.d)).toEqual([
      { day: "2026-10-23", items: [rows[0], rows[1]] },
      { day: "2026-10-21", items: [rows[2]] },
    ]);
  });
});
