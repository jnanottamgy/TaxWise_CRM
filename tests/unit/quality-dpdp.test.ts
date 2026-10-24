import { describe, expect, it } from "vitest";
import {
  CLOSED_REQUEST_STATUSES,
  DATA_REQUEST_STATUSES,
  DPDP_DEFAULTS,
  DPDP_SEED_PARAMETERS,
  boardReportDueAt,
  boardReportReminder,
  calendarQuarterBounds,
  calendarQuarterOf,
  closeRequirements,
  consentLive,
  dataRequestDueBy,
  dataRequestUrgency,
  incidentCloseBlockers,
  incidentDateProblems,
  incidentStepsDone,
  incidentSummary,
  isClosedRequestStatus,
  nextNoticeVersion,
  noticeMissingTopics,
  noticeState,
  noticeVersionNumber,
  resolveDpdpParams,
  restoreDrillReminder,
  retainedExplanation,
  starterNotice,
  type IncidentFacts,
} from "@/lib/domain/dpdp";
import type { StatutoryParameterRow } from "@/lib/domain/gst";

/**
 * Personal data under the DPDP Act 2023 / Rules 2025 (§6.10): request due dates and the closed
 * words the inbox counts by, what closing a request needs (erasure: what statutory retention keeps
 * back), the breach checklist and the Board's deadline, notice versions and the first notice, and
 * the quarterly restore drill (§12).
 */

const rows: StatutoryParameterRow[] = DPDP_SEED_PARAMETERS.map((r) => ({ key: r.key, value: r.value, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo, verified: r.verified }));

describe("data requests", () => {
  it("are due 90 days after the IST day they arrive [verify]", () => {
    expect(dataRequestDueBy("access", "2026-10-24")).toBe("2027-01-22");
    expect(dataRequestDueBy("grievance", "2026-12-31")).toBe("2027-03-31");
    const p = resolveDpdpParams(rows, "2026-10-24");
    expect(p.params).toEqual(DPDP_DEFAULTS);
    expect(p.unverified).toEqual(expect.arrayContaining(["dpdp.request_response_days", "dpdp.breach_board_report_hours"]));
    expect(resolveDpdpParams([], "2026-10-24").missing.length).toBe(3);
  });

  it("close only with the words the inbox treats as closed", () => {
    expect(CLOSED_REQUEST_STATUSES).toEqual(["closed", "completed", "resolved", "rejected", "withdrawn"]);
    expect(DATA_REQUEST_STATUSES.filter(isClosedRequestStatus)).toEqual(["completed", "resolved", "rejected", "withdrawn"]);
    expect(isClosedRequestStatus("in_progress")).toBe(false);
  });

  it("are overdue, due soon or open by their due date; closed ones are just closed", () => {
    expect(dataRequestUrgency({ status: "completed", dueBy: "2026-10-01", today: "2026-10-24" })).toEqual({ urgency: "closed", daysLeft: null });
    expect(dataRequestUrgency({ status: "open", dueBy: "2026-10-20", today: "2026-10-24" })).toEqual({ urgency: "overdue", daysLeft: -4 });
    expect(dataRequestUrgency({ status: "in_progress", dueBy: "2026-10-31", today: "2026-10-24" })).toEqual({ urgency: "due_soon", daysLeft: 7 });
    expect(dataRequestUrgency({ status: "open", dueBy: "2026-11-01", today: "2026-10-24" })).toEqual({ urgency: "open", daysLeft: 8 });
    expect(dataRequestUrgency({ status: "open", dueBy: null, today: "2026-10-24" }).urgency).toBe("open");
  });

  it("need the response to close, and for an erasure what is retained and why", () => {
    expect(closeRequirements({ type: "access", toStatus: "in_progress", response: null, retainedExplanation: null })).toEqual([]);
    expect(closeRequirements({ type: "access", toStatus: "completed", response: " ", retainedExplanation: null })).toEqual(["the response given to the requester"]);
    expect(closeRequirements({ type: "access", toStatus: "withdrawn", response: null, retainedExplanation: null })).toEqual([]);
    expect(closeRequirements({ type: "erasure", toStatus: "completed", response: "Done", retainedExplanation: null })).toEqual(["what is retained and why (or that nothing is retained)"]);
    expect(closeRequirements({ type: "erasure", toStatus: "rejected", response: "Refused", retainedExplanation: "GST records" })).toEqual([]);
    expect(closeRequirements({ type: "erasure", toStatus: "resolved", response: "Done", retainedExplanation: null })).toEqual([]);
  });

  it("tells an erasure requester what the law keeps", () => {
    expect(retainedExplanation([])).toContain("Nothing is retained");
    const t = retainedExplanation(["gst", "audit"]);
    expect(t).toContain("72 months");
    expect(t).toContain("7 years");
    expect(t).not.toContain("Rule 6F");
  });
});

describe("breach response", () => {
  const base: IncidentFacts = { detectedAt: "2026-10-20T10:00:00.000Z", containedAt: null, assessedAt: null, boardNotifiedAt: null, principalsNotifiedAt: null, rootCause: null, closedAt: null };

  it("puts the Board's report 72 hours after detection [verify]", () => {
    expect(boardReportDueAt(base.detectedAt)).toBe("2026-10-23T10:00:00.000Z");
  });

  it("tracks the checklist and what still blocks closing", () => {
    expect(incidentCloseBlockers(base)).toEqual(["contain", "assess", "notify_board", "notify_people", "root_cause"]);
    const done: IncidentFacts = { ...base, containedAt: "2026-10-20T11:00:00Z", assessedAt: "2026-10-20T15:00:00Z", boardNotifiedAt: "2026-10-21T09:00:00Z", principalsNotifiedAt: "2026-10-21T12:00:00Z", rootCause: "An unencrypted laptop." };
    expect(Object.values(incidentStepsDone(done)).every(Boolean)).toBe(true);
    expect(incidentCloseBlockers(done)).toEqual([]);
    expect(incidentCloseBlockers({ ...done, rootCause: "   " })).toEqual(["root_cause"]);
  });

  it("counts hours to the Board's report and marks it late", () => {
    const s = incidentSummary(base, new Date("2026-10-22T10:00:00Z"));
    expect(s).toMatchObject({ done: 0, total: 5, open: true, boardHoursLeft: 24, boardLate: false });
    expect(incidentSummary(base, new Date("2026-10-24T10:00:00Z")).boardLate).toBe(true);
    expect(incidentSummary({ ...base, boardNotifiedAt: "2026-10-24T00:00:00Z" }, new Date("2026-10-25T00:00:00Z"))).toMatchObject({ boardHoursLeft: null, boardLate: true });
    expect(boardReportReminder(base, new Date("2026-10-21T09:00:00Z"))).toBeNull();
    expect(boardReportReminder(base, new Date("2026-10-22T11:00:00Z"))).toBe("due_soon");
    expect(boardReportReminder(base, new Date("2026-10-23T11:00:00Z"))).toBe("late");
    expect(boardReportReminder({ ...base, boardNotifiedAt: "2026-10-21T00:00:00Z" }, new Date("2026-10-24T00:00:00Z"))).toBeNull();
  });

  it("refuses steps dated before detection", () => {
    expect(incidentDateProblems({ ...base, containedAt: "2026-10-19T10:00:00Z" })).toEqual(["Contained can't be before the breach was detected."]);
    expect(incidentDateProblems({ ...base, containedAt: "2026-10-20T10:00:00Z" })).toEqual([]);
  });
});

describe("privacy notices and consent", () => {
  it("numbers versions v1, v2 … and knows a draft from the current and superseded ones", () => {
    expect(nextNoticeVersion([])).toBe("v1");
    expect(nextNoticeVersion(["v1", "v2"])).toBe("v3");
    expect(nextNoticeVersion(["v9", "v10", "draft"])).toBe("v11");
    expect(noticeVersionNumber("V4")).toBe(4);
    expect(noticeVersionNumber("4")).toBeNull();
    expect(noticeState({ publishedAt: null, isCurrent: false })).toBe("draft");
    expect(noticeState({ publishedAt: "2026-10-01T00:00:00Z", isCurrent: true })).toBe("current");
    expect(noticeState({ publishedAt: "2026-04-01T00:00:00Z", isCurrent: false })).toBe("superseded");
  });

  it("starts the first notice from the firm's own facts, covering every item §6.10 lists", () => {
    const body = starterNotice({ name: "TaxWise Consultants", email: "office@twchartered.com", address: "Bengaluru 560001" });
    expect(noticeMissingTopics(body)).toEqual([]);
    expect(body).toContain("office@twchartered.com");
    expect(body).toContain("never store a full Aadhaar number");
    expect(body.length).toBeGreaterThan(200);
    expect(noticeMissingTopics("We hold your name.")).toEqual(expect.arrayContaining(["How long we keep it", "How to complain to the Data Protection Board"]));
    expect(starterNotice({ name: "TaxWise Consultants", email: null, address: null })).toContain("contact our office");
  });

  it("treats consent as live until withdrawn", () => {
    expect(consentLive({ givenAt: "2026-10-01T00:00:00Z", withdrawnAt: null })).toBe(true);
    expect(consentLive({ givenAt: "2026-10-01T00:00:00Z", withdrawnAt: "2026-10-02T00:00:00Z" })).toBe(false);
    expect(consentLive({ givenAt: null, withdrawnAt: null })).toBe(false);
  });
});

describe("the quarterly restore drill (§12)", () => {
  it("knows the calendar quarter and its bounds", () => {
    expect(calendarQuarterOf("2026-10-01")).toBe("2026-Q4");
    expect(calendarQuarterOf("2027-03-31")).toBe("2027-Q1");
    expect(calendarQuarterBounds("2026-11-15")).toEqual({ start: "2026-10-01", end: "2026-12-31" });
    expect(calendarQuarterBounds("2027-02-10")).toEqual({ start: "2027-01-01", end: "2027-03-31" });
    expect(calendarQuarterBounds("2026-05-31")).toEqual({ start: "2026-04-01", end: "2026-06-30" });
  });

  it("reminds early in the quarter and again near its end, until a drill is recorded", () => {
    expect(restoreDrillReminder("2026-10-05", null)).toEqual({ quarter: "2026-Q4", kind: "start", quarterEnds: "2026-12-31" });
    expect(restoreDrillReminder("2026-10-05", "2026-10-02")).toBeNull();
    expect(restoreDrillReminder("2026-11-20", "2026-07-01")).toBeNull();
    expect(restoreDrillReminder("2026-12-20", "2026-09-30")).toEqual({ quarter: "2026-Q4", kind: "closing", quarterEnds: "2026-12-31" });
    expect(restoreDrillReminder("2026-10-15", null)?.kind).toBe("start");
    expect(restoreDrillReminder("2026-10-16", null)).toBeNull();
  });
});
