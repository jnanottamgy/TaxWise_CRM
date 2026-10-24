import { describe, expect, it } from "vitest";
import { APPEAL_DEFAULTS } from "@/lib/domain/escalation";
import {
  NoticeFormSchema,
  NoticeStatusSchema,
  appealForumsFor,
  hearingIso,
  isClosed,
  limitationPreview,
  needsAppealDecision,
  nextNoticeAction,
  nextNoticeStep,
  noticeMoves,
  noticePayload,
  noticeYearLabel,
  planNoticeReminders,
  presetFor,
  splitHearing,
  statusPayload,
  type NoticeDates,
} from "@/lib/schemas/notices";

const CLIENT = "8c0a9d0e-1d6f-4d8a-9a52-0d1f1c2b3a4e";
const ID = "8c0a9d0e-1d6f-4d8a-9a52-0d1f1c2b3a4f";

describe("hearing date and time (IST)", () => {
  it("stores the entered IST date and time, and reads them back", () => {
    expect(hearingIso("2026-10-30", "11:30")).toBe("2026-10-30T11:30:00+05:30");
    expect(hearingIso("2026-10-30", "")).toBe("2026-10-30T10:30:00+05:30");
    expect(hearingIso("", "11:30")).toBeNull();
    expect(splitHearing("2026-10-30T06:00:00Z")).toEqual({ date: "2026-10-30", time: "11:30" });
    expect(splitHearing("2026-10-30T20:00:00Z")).toEqual({ date: "2026-10-31", time: "01:30" });
    expect(splitHearing(null)).toEqual({ date: "", time: "" });
  });
});

describe("the workflow's moves (§3.6)", () => {
  it("lets an open notice move to any other status", () => {
    expect(noticeMoves("open", "employee")).toEqual(["reply_drafted", "replied", "hearing", "closed_favourable", "closed_unfavourable", "closed_partial"]);
  });
  it("reopens a closed notice only for a Partner or Manager; an unfavourable one can have its appeal updated", () => {
    expect(noticeMoves("closed_favourable", "employee")).toEqual([]);
    expect(noticeMoves("closed_favourable", "manager")).toEqual(["open", "hearing"]);
    expect(noticeMoves("closed_unfavourable", "employee")).toEqual(["closed_unfavourable"]);
    expect(noticeMoves("closed_partial", "partner")).toEqual(["open", "hearing", "closed_partial"]);
  });
  it("suggests the usual next step", () => {
    expect(nextNoticeStep("open")).toBe("reply_drafted");
    expect(nextNoticeStep("reply_drafted")).toBe("replied");
    expect(nextNoticeStep("hearing")).toBe("closed_favourable");
    expect(nextNoticeStep("closed_partial")).toBeNull();
    expect(isClosed("closed_partial")).toBe(true);
    expect(needsAppealDecision("closed_favourable")).toBe(false);
  });
});

describe("appeal forums and limitation (§7.8.4)", () => {
  it("offers the forums of the notice's area", () => {
    expect(appealForumsFor("gst")).toEqual(["gst_first_appeal", "gst_tribunal", "other"]);
    expect(appealForumsFor("tds")).toEqual(["income_tax_first_appeal", "income_tax_tribunal", "other"]);
    expect(appealForumsFor(null)).toHaveLength(5);
  });
  it("counts days for income tax and calendar months (clamped to month end) for GST, as the database does", () => {
    expect(limitationPreview("income_tax_first_appeal", "2026-09-01")).toBe("2026-10-01");
    expect(limitationPreview("income_tax_tribunal", "2026-09-01")).toBe("2026-10-31");
    expect(limitationPreview("gst_first_appeal", "2026-01-31")).toBe("2026-04-30");
    expect(limitationPreview("gst_tribunal", "2026-11-30", { ...APPEAL_DEFAULTS, gst_tribunal: { months: 1 } })).toBe("2026-12-30");
    expect(limitationPreview("other", "2026-09-01")).toBeNull();
    expect(limitationPreview("income_tax_first_appeal", "")).toBeNull();
  });
  it("labels the year a notice is about by statute (§6.1)", () => {
    expect(noticeYearLabel("2024-25")).toBe("AY 2025-26");
    expect(noticeYearLabel("2026-27")).toBe("Tax year 2026-27");
    expect(noticeYearLabel("")).toBeNull();
  });
  it("knows the common notice types", () => {
    expect(presetFor("GST DRC-01")).toMatchObject({ area: "gst" });
    expect(presetFor("IT 148A")).toMatchObject({ area: "income_tax", section: "148A" });
    expect(presetFor("Something else")).toBeNull();
  });
});

describe("the notice form", () => {
  const base = {
    client_id: CLIENT,
    notice_type: "IT 143(2)",
    reply_due_date: "2026-11-05",
  };
  it("needs a client, a type and a reply due date", () => {
    const r = NoticeFormSchema.safeParse({ client_id: "", notice_type: "", reply_due_date: "" });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.map((i) => i.path.join(".")).sort()).toEqual(["client_id", "notice_type", "reply_due_date"]);
  });
  it("checks the dates against each other", () => {
    const r = NoticeFormSchema.safeParse({ ...base, notice_date: "2026-10-10", received_date: "2026-10-01", hearing_time: "11:00" });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.map((i) => i.path.join(".")).sort()).toEqual(["hearing_date", "received_date"]);
    expect(NoticeFormSchema.safeParse({ ...base, notice_date: "2026-11-10" }).success).toBe(false);
    expect(NoticeFormSchema.safeParse({ ...base, status: "hearing" }).success).toBe(false);
  });
  it("sends the demand as an exact decimal and the hearing in IST", () => {
    const v = NoticeFormSchema.parse({ ...base, demand_amount: "1,25,000.5", hearing_date: "2026-11-01", hearing_time: "15:15", tax_area: "income_tax" });
    expect(noticePayload(v, { creating: true })).toMatchObject({
      demand_amount: "125000.50",
      hearing_date: "2026-11-01T15:15:00+05:30",
      tax_area: "income_tax",
      status: "open",
      section: null,
    });
    expect(noticePayload(v, { creating: false })).not.toHaveProperty("status");
    expect(NoticeFormSchema.safeParse({ ...base, demand_amount: "12.345" }).success).toBe(false);
  });
});

describe("the status change", () => {
  const ref = { id: ID, updatedAt: "2026-10-24T05:00:00.000Z" };
  it("needs the order date and the decision to close against the client", () => {
    const r = NoticeStatusSchema.safeParse({ ...ref, status: "closed_unfavourable" });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.map((i) => i.path[0]).sort()).toEqual(["appeal_decision", "order_date"]);
  });
  it("needs a forum to appeal, a date for another forum, and a reason not to appeal", () => {
    const paths = (v: object) => {
      const r = NoticeStatusSchema.safeParse({ ...ref, status: "closed_partial", order_date: "2026-10-01", ...v });
      return r.success ? [] : r.error.issues.map((i) => i.path[0]);
    };
    expect(paths({ appeal_decision: "appeal" })).toEqual(["appeal_forum"]);
    expect(paths({ appeal_decision: "appeal", appeal_forum: "other" })).toEqual(["limitation_date"]);
    expect(paths({ appeal_decision: "appeal", appeal_forum: "other", limitation_date: "2026-09-01" })).toEqual(["limitation_date"]);
    expect(paths({ appeal_decision: "no_appeal" })).toEqual(["appeal_note"]);
    expect(paths({ appeal_decision: "appeal", appeal_forum: "gst_first_appeal" })).toEqual([]);
  });
  it("needs a reason to reopen, and a hearing date for a new Hearing", () => {
    expect(NoticeStatusSchema.safeParse({ ...ref, status: "open", from_status: "closed_favourable" }).success).toBe(false);
    expect(NoticeStatusSchema.safeParse({ ...ref, status: "open", from_status: "closed_favourable", note: "Remanded." }).success).toBe(true);
    expect(NoticeStatusSchema.safeParse({ ...ref, status: "hearing", from_status: "replied" }).success).toBe(false);
  });
  it("sends the appeal only when closing against the client", () => {
    const v = NoticeStatusSchema.parse({ ...ref, status: "closed_unfavourable", order_date: "2026-10-01", appeal_decision: "appeal", appeal_forum: "income_tax_first_appeal", limitation_date: "2026-11-15" });
    expect(statusPayload(v)).toEqual({
      note: null,
      replied_on: null,
      hearing_date: null,
      order_date: "2026-10-01",
      appeal: { decision: "appeal", forum: "income_tax_first_appeal", limitation_date: "2026-11-15", note: null },
    });
    const r = NoticeStatusSchema.parse({ ...ref, status: "replied", replied_on: "2026-10-20" });
    expect(statusPayload(r)).toEqual({ note: null, replied_on: "2026-10-20", hearing_date: null, order_date: null });
  });
});

describe("reminders (§7.8.4: 7 and 2 days before; overdue replies flagged)", () => {
  const open = (o: Partial<NoticeDates>): NoticeDates => ({
    status: "open",
    replyDueDate: null,
    hearingOn: null,
    appealDecision: null,
    limitationDate: null,
    appealFiled: false,
    ...o,
  });
  const today = "2026-10-24";

  it("reminds about the reply 7 days before, catches up a missed day, and sends the 2-day one nearer the date", () => {
    expect(planNoticeReminders(ID, open({ replyDueDate: "2026-10-31" }), today)).toEqual([
      { kind: "reply", lead: 7, date: "2026-10-31", daysLeft: 7, dedupeKey: `notice_reply:${ID}:2026-10-31:7` },
    ]);
    expect(planNoticeReminders(ID, open({ replyDueDate: "2026-10-29" }), today).map((r) => r.lead)).toEqual([7]);
    expect(planNoticeReminders(ID, open({ replyDueDate: "2026-10-26" }), today).map((r) => r.lead)).toEqual([2]);
    expect(planNoticeReminders(ID, open({ replyDueDate: "2026-10-24" }), today).map((r) => [r.kind, r.lead])).toEqual([["reply", 2]]);
    expect(planNoticeReminders(ID, open({ replyDueDate: "2026-11-05" }), today)).toEqual([]);
  });

  it("flags an overdue reply once per due date, and stops once replied", () => {
    expect(planNoticeReminders(ID, open({ replyDueDate: "2026-10-20" }), today)).toEqual([
      { kind: "reply_overdue", lead: 0, date: "2026-10-20", daysLeft: -4, dedupeKey: `notice_reply_overdue:${ID}:2026-10-20` },
    ]);
    expect(planNoticeReminders(ID, open({ status: "replied", replyDueDate: "2026-10-20" }), today)).toEqual([]);
  });

  it("reminds about a hearing and an appeal limitation the same way, until the appeal is filed", () => {
    const n = open({ status: "hearing", hearingOn: "2026-10-26", replyDueDate: "2026-10-01" });
    expect(planNoticeReminders(ID, n, today).map((r) => `${r.kind}:${r.lead}`)).toEqual(["hearing:2"]);
    const appeal = open({ status: "closed_unfavourable", appealDecision: "appeal", limitationDate: "2026-10-30" });
    expect(planNoticeReminders(ID, appeal, today).map((r) => `${r.kind}:${r.lead}`)).toEqual(["appeal:7"]);
    expect(planNoticeReminders(ID, { ...appeal, appealFiled: true }, today)).toEqual([]);
    expect(planNoticeReminders(ID, { ...appeal, limitationDate: "2026-10-20" }, today).map((r) => r.kind)).toEqual(["appeal_overdue"]);
    expect(planNoticeReminders(ID, { ...appeal, appealDecision: "no_appeal" }, today)).toEqual([]);
  });

  it("starts afresh when a date moves (the dedupe key names the date)", () => {
    const a = planNoticeReminders(ID, open({ replyDueDate: "2026-10-30" }), today)[0];
    const b = planNoticeReminders(ID, open({ replyDueDate: "2026-10-31" }), today)[0];
    expect(a.dedupeKey).not.toBe(b.dedupeKey);
  });

  it("names the next date to act on", () => {
    expect(nextNoticeAction(open({ replyDueDate: "2026-10-20", hearingOn: "2026-10-28" }), today)).toEqual({ kind: "reply", date: "2026-10-20", daysLeft: -4, overdue: true });
    expect(nextNoticeAction(open({ status: "replied", replyDueDate: "2026-10-20", hearingOn: "2026-10-28" }), today)).toEqual({ kind: "hearing", date: "2026-10-28", daysLeft: 4, overdue: false });
    expect(nextNoticeAction(open({ status: "closed_favourable" }), today)).toBeNull();
  });
});
