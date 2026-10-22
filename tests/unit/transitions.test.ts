import { describe, expect, it } from "vitest";
import { TASK_STATUSES, type TaskStatus } from "@/lib/domain/enums";
import {
  allowedNextStatuses,
  canTransition,
  isReopen,
  isSendBack,
  nextStatusOptions,
  openBlockers,
  requiresReason,
  transitionEffects,
  transitionKind,
  type TransitionContext,
  type TransitionRequest,
} from "@/lib/domain/transitions";

const EMP = "emp-1";
const EMP2 = "emp-2";
const MGR = "mgr-1";
const PTR = "ptr-1";

/** An accepted task assigned to Employee 1, moved by Employee 1. */
function req(over: Partial<TransitionRequest> & { to: TaskStatus }): TransitionRequest {
  return {
    from: "in_progress",
    actorRole: "employee",
    actorEmployeeId: EMP,
    assigneeEmployeeId: EMP,
    acceptance: "accepted",
    declinedByEmployeeId: null,
    blockers: [],
    reason: null,
    ...over,
  };
}

describe("canTransition: moves (§7.6.4)", () => {
  it("allows any move, including backwards", () => {
    expect(canTransition(req({ from: "not_started", to: "in_progress" }))).toEqual({ ok: true });
    expect(canTransition(req({ from: "in_progress", to: "data_awaited" }))).toEqual({ ok: true });
    expect(canTransition(req({ from: "data_awaited", to: "in_progress" }))).toEqual({ ok: true });
    expect(canTransition(req({ from: "in_progress", to: "under_review" }))).toEqual({ ok: true });
    expect(canTransition(req({ from: "under_review", to: "not_started" }))).toEqual({ ok: true });
    expect(canTransition(req({ from: "in_progress", to: "not_started" }))).toEqual({ ok: true });
    expect(canTransition(req({ from: "on_hold", to: "in_progress" }))).toEqual({ ok: true });
  });

  it("refuses a no-op instead of silently writing it", () => {
    for (const s of TASK_STATUSES) {
      const r = canTransition(req({ actorRole: "partner", actorEmployeeId: PTR, from: s, to: s, reason: "x" }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("noop");
    }
    const r = canTransition(req({ from: "in_progress", to: "in_progress" }));
    expect(r).toEqual({ ok: false, code: "noop", error: "This task is already In progress." });
  });

  it("refuses Filed/Done → Not started with the spec's message, for everyone", () => {
    for (const role of ["partner", "manager"] as const) {
      const r = canTransition(req({ actorRole: role, actorEmployeeId: role === "partner" ? PTR : MGR, from: "filed_done", to: "not_started", reason: "wrong figures" }));
      expect(r).toEqual({ ok: false, code: "reopen_to_not_started", error: "This task is already done and filed; reopen it to In progress instead." });
    }
  });

  it("refuses anyone who isn't staff", () => {
    expect(canTransition(req({ actorRole: "client", to: "under_review" }))).toMatchObject({ ok: false, code: "forbidden" });
    expect(canTransition(req({ actorRole: null, to: "under_review" }))).toMatchObject({ ok: false, code: "forbidden" });
  });
});

describe("canTransition: required reasons (§7.6.4)", () => {
  it("requires a reason to send back (Under review → In progress)", () => {
    const base = { actorRole: "manager" as const, actorEmployeeId: MGR, from: "under_review" as const, to: "in_progress" as const };
    expect(canTransition(req({ ...base, reason: null }))).toEqual({
      ok: false,
      code: "reason_required",
      field: "reason",
      error: "Give a reason for sending this back; the assignee sees it.",
    });
    expect(canTransition(req({ ...base, reason: "   " }))).toMatchObject({ ok: false, code: "reason_required" });
    expect(canTransition(req({ ...base, reason: "Turnover doesn't match the GSTR-1" }))).toEqual({ ok: true });
  });

  it("requires a reason to reopen from Filed/Done to anything", () => {
    for (const to of ["in_progress", "data_awaited", "under_review", "on_hold"] as const) {
      const base = { actorRole: "partner" as const, actorEmployeeId: PTR, from: "filed_done" as const, to };
      const r = canTransition(req({ ...base }));
      expect(r).toMatchObject({ ok: false, code: "reason_required", field: "reason" });
      if (!r.ok) expect(r.error).toBe("Give a reason for reopening this task.");
      expect(canTransition(req({ ...base, reason: "Revised return needed" }))).toEqual({ ok: true });
    }
  });

  it("requires a reason to put a task On hold", () => {
    expect(canTransition(req({ to: "on_hold" }))).toEqual({ ok: false, code: "reason_required", field: "reason", error: "Give a reason for putting this task on hold." });
    expect(canTransition(req({ to: "on_hold", reason: "Client travelling" }))).toEqual({ ok: true });
  });

  it("needs no reason for other moves", () => {
    expect(canTransition(req({ from: "not_started", to: "in_progress" }))).toEqual({ ok: true });
    expect(canTransition(req({ from: "under_review", to: "data_awaited" }))).toEqual({ ok: true });
    expect(canTransition(req({ from: "on_hold", to: "not_started" }))).toEqual({ ok: true });
  });

  it("requiresReason matches the rules", () => {
    expect(requiresReason("under_review", "in_progress")).toBe(true);
    expect(requiresReason("filed_done", "in_progress")).toBe(true);
    expect(requiresReason("filed_done", "on_hold")).toBe(true);
    expect(requiresReason("in_progress", "on_hold")).toBe(true);
    expect(requiresReason("under_review", "data_awaited")).toBe(false);
    expect(requiresReason("in_progress", "under_review")).toBe(false);
    expect(requiresReason("on_hold", "on_hold")).toBe(false);
    expect(isSendBack("under_review", "in_progress")).toBe(true);
    expect(isSendBack("data_awaited", "in_progress")).toBe(false);
    expect(isReopen("filed_done", "in_progress")).toBe(true);
    expect(isReopen("filed_done", "filed_done")).toBe(false);
  });
});

describe("canTransition: who can file (§7.6.4, §4.1)", () => {
  it("Employees cannot set Filed/Done; they submit Under review", () => {
    const r = canTransition(req({ from: "under_review", to: "filed_done" }));
    expect(r).toEqual({ ok: false, code: "employee_cannot_file", error: "Employees can't set Filed/Done. Submit it for review (Under review) instead." });
    expect(canTransition(req({ from: "in_progress", to: "under_review" }))).toEqual({ ok: true });
  });

  it("Managers may file work they didn't do", () => {
    expect(canTransition(req({ actorRole: "manager", actorEmployeeId: MGR, assigneeEmployeeId: EMP, from: "under_review", to: "filed_done" }))).toEqual({ ok: true });
    // Including unassigned or someone else's work.
    expect(canTransition(req({ actorRole: "manager", actorEmployeeId: MGR, assigneeEmployeeId: EMP2, from: "in_progress", to: "filed_done" }))).toEqual({ ok: true });
  });

  it("nobody files their own work (a Manager assigned to it can't)", () => {
    const r = canTransition(req({ actorRole: "manager", actorEmployeeId: MGR, assigneeEmployeeId: MGR, from: "under_review", to: "filed_done" }));
    expect(r).toEqual({ ok: false, code: "own_work", error: "Nobody files their own work. Ask another Manager or a Partner to file it." });
  });

  it("Partners may file anything, including their own", () => {
    expect(canTransition(req({ actorRole: "partner", actorEmployeeId: PTR, assigneeEmployeeId: PTR, from: "in_progress", to: "filed_done" }))).toEqual({ ok: true });
    expect(canTransition(req({ actorRole: "partner", actorEmployeeId: PTR, assigneeEmployeeId: EMP, from: "under_review", to: "filed_done" }))).toEqual({ ok: true });
  });
});

describe("canTransition: acceptance and the decliner (§7.6.3)", () => {
  it("status can't change until the task is accepted", () => {
    const pending = canTransition(req({ acceptance: "pending", from: "not_started", to: "in_progress" }));
    expect(pending).toMatchObject({ ok: false, code: "not_accepted" });
    if (!pending.ok) expect(pending.error).toContain("waiting for acceptance");
    // Not even a Partner can move a task nobody has accepted.
    expect(canTransition(req({ actorRole: "partner", actorEmployeeId: PTR, acceptance: "pending", from: "not_started", to: "on_hold", reason: "x" }))).toMatchObject({ ok: false, code: "not_accepted" });
    const declined = canTransition(req({ actorRole: "manager", actorEmployeeId: MGR, assigneeEmployeeId: null, acceptance: "declined", from: "not_started", to: "in_progress" }));
    expect(declined).toMatchObject({ ok: false, code: "not_accepted" });
    if (!declined.ok) expect(declined.error).toContain("declined");
  });

  it("the decliner can't update a task they declined, even after someone else accepts it", () => {
    const r = canTransition(req({ actorEmployeeId: EMP, assigneeEmployeeId: EMP2, declinedByEmployeeId: EMP, acceptance: "accepted", to: "under_review" }));
    expect(r).toEqual({ ok: false, code: "declined_by_you", error: "You declined this task, so you can't update it." });
    const pending = canTransition(req({ actorEmployeeId: EMP, assigneeEmployeeId: null, declinedByEmployeeId: EMP, acceptance: "declined", from: "not_started", to: "in_progress" }));
    expect(pending).toMatchObject({ ok: false, code: "declined_by_you" });
  });

  it("a decliner who is later reassigned the task and accepts it can work on it", () => {
    expect(canTransition(req({ actorEmployeeId: EMP, assigneeEmployeeId: EMP, declinedByEmployeeId: EMP, acceptance: "accepted", to: "under_review" }))).toEqual({ ok: true });
  });

  it("Employees can only change tasks assigned to them (§4.6)", () => {
    expect(canTransition(req({ actorEmployeeId: EMP2, assigneeEmployeeId: EMP, to: "under_review" }))).toEqual({
      ok: false,
      code: "not_assignee",
      error: "You can only change the status of tasks assigned to you.",
    });
    expect(canTransition(req({ actorEmployeeId: null, to: "under_review" }))).toMatchObject({ ok: false, code: "not_assignee" });
    // Managers and Partners can move tasks assigned to others.
    expect(canTransition(req({ actorRole: "manager", actorEmployeeId: MGR, assigneeEmployeeId: EMP, to: "data_awaited" }))).toEqual({ ok: true });
  });
});

describe("canTransition: dependencies (§7.6.4)", () => {
  const open = { id: "t-9", title: "GSTR-1 Sep 2026", status: "in_progress" as const };
  const filed = { id: "t-8", title: "Sales register Sep 2026", status: "filed_done" as const };

  it("blocks In progress, Under review and Filed/Done while a blocker isn't Filed/Done, naming it", () => {
    for (const to of ["in_progress", "under_review", "filed_done"] as const) {
      const r = canTransition(req({ actorRole: "partner", actorEmployeeId: PTR, from: "not_started", to, blockers: [open, filed] }));
      expect(r).toEqual({ ok: false, code: "blocked", error: "Blocked by “GSTR-1 Sep 2026”, which isn't Filed/Done yet." });
    }
  });

  it("names every open blocker", () => {
    const blockers = [open, { id: "t-10", title: "2B recon", status: "data_awaited" as const }, { id: "t-11", title: "Purchase register", status: "on_hold" as const }];
    const r = canTransition(req({ from: "not_started", to: "in_progress", blockers }));
    expect(r).toMatchObject({ ok: false, code: "blocked", error: "Blocked by “GSTR-1 Sep 2026”, “2B recon” and “Purchase register”, which aren't Filed/Done yet." });
    expect(openBlockers(blockers)).toHaveLength(3);
  });

  it("doesn't block once every blocker is Filed/Done", () => {
    expect(canTransition(req({ from: "not_started", to: "in_progress", blockers: [filed] }))).toEqual({ ok: true });
  });

  it("doesn't gate Data awaited, On hold or Not started", () => {
    expect(canTransition(req({ from: "not_started", to: "data_awaited", blockers: [open] }))).toEqual({ ok: true });
    expect(canTransition(req({ from: "not_started", to: "on_hold", reason: "waiting", blockers: [open] }))).toEqual({ ok: true });
    expect(canTransition(req({ from: "in_progress", to: "not_started", blockers: [open] }))).toEqual({ ok: true });
  });

  it("reports the blocker before a missing reason", () => {
    const r = canTransition(req({ actorRole: "partner", actorEmployeeId: PTR, from: "filed_done", to: "in_progress", blockers: [open] }));
    expect(r).toMatchObject({ ok: false, code: "blocked" });
  });
});

describe("allowedNextStatuses / nextStatusOptions (§7.6.6)", () => {
  const ctx = (over: Partial<TransitionContext>): TransitionContext => ({
    from: "in_progress",
    actorRole: "employee",
    actorEmployeeId: EMP,
    assigneeEmployeeId: EMP,
    acceptance: "accepted",
    blockers: [],
    ...over,
  });

  it("an Employee on their own task: everything except Filed/Done, with On hold needing a reason", () => {
    expect(allowedNextStatuses(ctx({}))).toEqual([
      { status: "not_started", requiresReason: false },
      { status: "data_awaited", requiresReason: false },
      { status: "under_review", requiresReason: false },
      { status: "on_hold", requiresReason: true },
    ]);
  });

  it("a Partner on a filed task: reopen moves only, each needing a reason", () => {
    expect(allowedNextStatuses(ctx({ actorRole: "partner", actorEmployeeId: PTR, from: "filed_done" }))).toEqual([
      { status: "in_progress", requiresReason: true },
      { status: "data_awaited", requiresReason: true },
      { status: "under_review", requiresReason: true },
      { status: "on_hold", requiresReason: true },
    ]);
  });

  it("a Manager reviewing: send back needs a reason, filing is allowed", () => {
    const opts = allowedNextStatuses(ctx({ actorRole: "manager", actorEmployeeId: MGR, from: "under_review" }));
    expect(opts).toContainEqual({ status: "in_progress", requiresReason: true });
    expect(opts).toContainEqual({ status: "filed_done", requiresReason: false });
  });

  it("nothing is allowed before acceptance; the options say why", () => {
    expect(allowedNextStatuses(ctx({ acceptance: "pending", from: "not_started" }))).toEqual([]);
    const options = nextStatusOptions(ctx({ acceptance: "pending", from: "not_started" }));
    expect(options).toHaveLength(5);
    expect(options.every((o) => !o.allowed && typeof o.error === "string")).toBe(true);
  });

  it("disabled options carry the refusal (e.g. the blocker)", () => {
    const options = nextStatusOptions(ctx({ from: "not_started", blockers: [{ id: "x", title: "TDS challans", status: "in_progress" }] }));
    const inProgress = options.find((o) => o.status === "in_progress");
    expect(inProgress).toMatchObject({ allowed: false, error: "Blocked by “TDS challans”, which isn't Filed/Done yet." });
    expect(options.find((o) => o.status === "filed_done")?.error).toContain("Employees can't set Filed/Done");
    expect(options.find((o) => o.status === "data_awaited")).toMatchObject({ allowed: true, requiresReason: false });
  });
});

describe("transitionEffects: derived values (§7.6.4)", () => {
  const now = new Date("2026-10-22T06:30:00.000Z");
  const base = {
    reason: null,
    now,
    currentCompletionDate: null,
    actorEmployeeId: MGR,
    assigneeEmployeeId: EMP,
    reviewerEmployeeId: MGR,
    clientOwnerEmployeeId: EMP2,
  };

  it("sets completion_date when first Filed/Done", () => {
    const e = transitionEffects({ ...base, from: "under_review", to: "filed_done" });
    expect(e.completionDate).toBe("2026-10-22T06:30:00.000Z");
    expect(e.kind).toBe("file");
  });

  it("keeps completion_date on a re-save", () => {
    const e = transitionEffects({ ...base, from: "under_review", to: "filed_done", currentCompletionDate: "2026-09-20T10:00:00.000Z" });
    expect(e.completionDate).toBe("2026-09-20T10:00:00.000Z");
    const d = transitionEffects({ ...base, from: "under_review", to: "filed_done", currentCompletionDate: new Date("2026-09-20T10:00:00.000Z") });
    expect(d.completionDate).toBe("2026-09-20T10:00:00.000Z");
  });

  it("clears completion_date and resets escalation on reopen", () => {
    const e = transitionEffects({ ...base, from: "filed_done", to: "in_progress", reason: "Revised", currentCompletionDate: "2026-09-20T10:00:00.000Z" });
    expect(e.completionDate).toBeNull();
    expect(e.resetEscalation).toBe(true);
    expect(e.kind).toBe("reopen");
  });

  it("leaves completion_date and escalation alone on other moves", () => {
    const e = transitionEffects({ ...base, from: "in_progress", to: "data_awaited" });
    expect(e.completionDate).toBeNull();
    expect(e.resetEscalation).toBe(false);
    expect(e.onHoldReason).toBeUndefined();
  });

  it("stores the on-hold reason, and clears it when the task leaves On hold", () => {
    expect(transitionEffects({ ...base, from: "in_progress", to: "on_hold", reason: "  Client away  " }).onHoldReason).toBe("Client away");
    expect(transitionEffects({ ...base, from: "on_hold", to: "in_progress" }).onHoldReason).toBeNull();
  });

  it("writes the history row with the trimmed reason", () => {
    expect(transitionEffects({ ...base, from: "under_review", to: "in_progress", reason: " Wrong ITC " }).history).toEqual({
      fromStatus: "under_review",
      toStatus: "in_progress",
      reason: "Wrong ITC",
    });
    expect(transitionEffects({ ...base, from: "not_started", to: "in_progress", reason: "" }).history.reason).toBeNull();
  });

  it("names each kind of move", () => {
    expect(transitionKind("in_progress", "under_review")).toBe("submit_for_review");
    expect(transitionKind("under_review", "in_progress")).toBe("send_back");
    expect(transitionKind("in_progress", "on_hold")).toBe("hold");
    expect(transitionKind("in_progress", "data_awaited")).toBe("data_awaited");
    expect(transitionKind("not_started", "in_progress")).toBe("move");
    expect(transitionKind("filed_done", "on_hold")).toBe("reopen");
  });
});

describe("transitionEffects: notifications (§7.6.4, §9)", () => {
  const now = new Date("2026-10-22T06:30:00.000Z");
  const base = { reason: null, now, currentCompletionDate: null, assigneeEmployeeId: EMP, clientOwnerEmployeeId: EMP2 };

  it("Under review → the named reviewer, personally", () => {
    const e = transitionEffects({ ...base, from: "in_progress", to: "under_review", actorEmployeeId: EMP, reviewerEmployeeId: MGR });
    expect(e.notifications).toEqual([{ type: "review_requested", targets: [{ kind: "employee", employeeId: MGR }] }]);
  });

  it("Under review with no reviewer → all Managers", () => {
    const e = transitionEffects({ ...base, from: "in_progress", to: "under_review", actorEmployeeId: EMP, reviewerEmployeeId: null });
    expect(e.notifications).toEqual([{ type: "review_requested", targets: [{ kind: "role", role: "manager" }] }]);
  });

  it("Sent back → the assignee, with the reason", () => {
    const e = transitionEffects({ ...base, from: "under_review", to: "in_progress", reason: "Recheck ITC", actorEmployeeId: MGR, reviewerEmployeeId: MGR });
    expect(e.notifications).toEqual([{ type: "task_sent_back", targets: [{ kind: "employee", employeeId: EMP }], reason: "Recheck ITC" }]);
  });

  it("Filed → the assignee, plus the owner if different", () => {
    const e = transitionEffects({ ...base, from: "under_review", to: "filed_done", actorEmployeeId: MGR, reviewerEmployeeId: MGR });
    expect(e.notifications).toEqual([
      { type: "task_approved", targets: [{ kind: "employee", employeeId: EMP }, { kind: "employee", employeeId: EMP2 }] },
    ]);
    const same = transitionEffects({ ...base, clientOwnerEmployeeId: EMP, from: "under_review", to: "filed_done", actorEmployeeId: MGR, reviewerEmployeeId: MGR });
    expect(same.notifications).toEqual([{ type: "task_approved", targets: [{ kind: "employee", employeeId: EMP }] }]);
  });

  it("never notifies the person who made the change", () => {
    // A Partner files their own task for a client they own: nobody else to tell.
    const e = transitionEffects({ ...base, assigneeEmployeeId: PTR, clientOwnerEmployeeId: PTR, from: "in_progress", to: "filed_done", actorEmployeeId: PTR, reviewerEmployeeId: null });
    expect(e.notifications).toEqual([]);
  });

  it("Data awaited goes on the Manager's call list; other moves notify nobody", () => {
    const e = transitionEffects({ ...base, from: "in_progress", to: "data_awaited", actorEmployeeId: EMP, reviewerEmployeeId: MGR });
    expect(e.addsToCallList).toBe(true);
    expect(e.notifications).toEqual([]);
    expect(transitionEffects({ ...base, from: "not_started", to: "in_progress", actorEmployeeId: EMP, reviewerEmployeeId: MGR }).addsToCallList).toBe(false);
  });
});
