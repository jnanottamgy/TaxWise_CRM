/**
 * Tasks (§4.1, §4.6, §7.6.2–§7.6.4): change_task_status enforces every status rule, in the same
 * order and wording as lib/domain/transitions.ts; respond_to_task (acceptance); Employees'
 * column-limited updates; task visibility; dependency cycles.
 */
import { describe, expect, it } from "vitest";
import { canTransition } from "@/lib/domain/transitions";
import { C, F, SQLSTATE, U, setupTestDatabase, userMessage, type Session, type TestUser } from "./helpers";

const db = setupTestDatabase("tasks");

type NewTask = {
  client?: string;
  title?: string;
  status?: string;
  assignee?: TestUser | null;
  reviewer?: TestUser | null;
  acceptance?: "pending" | "accepted" | "declined";
  declinedBy?: TestUser | null;
  completion?: string | null;
  escalation?: number;
};

let seq = 0;

/** Insert a task as the superuser (no guards), then return to `as`. */
async function newTask(s: Session, t: NewTask, as: TestUser | "super" = "super"): Promise<string> {
  await s.as("super");
  const id = await s.value<string>(
    `insert into tasks (task_number, client_id, title, status, assigned_employee_id, reviewer_employee_id, acceptance_status,
                        accepted_at, declined_by_employee_id, completion_date, escalation_level, escalated_at, created_by)
     values ($1, $2, $3, $4::task_status, $5, $6, $7::task_acceptance, case when $7::task_acceptance = 'accepted' then now() end,
             $8, $9::timestamptz, $10::int, case when $10::int > 0 then now() end, $11)
     returning id`,
    [
      `T-8${String(++seq).padStart(5, "0")}`,
      t.client ?? C.A,
      t.title ?? `Task ${seq}`,
      t.status ?? "in_progress",
      t.assignee === undefined ? U.E1.employeeId : t.assignee?.employeeId ?? null,
      t.reviewer?.employeeId ?? null,
      t.acceptance ?? "accepted",
      t.declinedBy?.employeeId ?? null,
      t.completion ?? null,
      t.escalation ?? 0,
      U.P1.id,
    ],
  );
  if (as !== "super") await s.as(as);
  return id;
}

const move = (s: Session, id: string, to: string, reason: string | null = null) =>
  s.value<Record<string, unknown>>("select change_task_status($1, $2::task_status, $3)", [id, to, reason]);
const refusal = async (s: Session, id: string, to: string, reason: string | null = null) =>
  userMessage(await s.fails("select change_task_status($1, $2::task_status, $3)", [id, to, reason]));

describe("change_task_status: who and when (§7.6.3, §7.6.4)", () => {
  it("only staff can change a status", async () => {
    await db.asSuper(async (s) => {
      const id = await newTask(s, {}, U.CA);
      expect(await refusal(s, id, "under_review")).toBe("Only the firm's staff can change a task's status.");
      await s.as(U.X);
      expect(await refusal(s, id, "under_review")).toBe("Only the firm's staff can change a task's status.");
    });
  });

  it("a no-op is refused, not silently written", async () => {
    await db.asSuper(async (s) => {
      const id = await newTask(s, { status: "in_progress" }, U.E1);
      expect(await refusal(s, id, "in_progress")).toBe("This task is already In progress.");
    });
  });

  it("status can't change until the task is accepted; a declined task can't move", async () => {
    await db.asSuper(async (s) => {
      const pending = await newTask(s, { acceptance: "pending" }, U.P1);
      expect(await refusal(s, pending, "under_review")).toMatch(/waiting for acceptance/);
      const declined = await newTask(s, { acceptance: "declined", assignee: null, declinedBy: U.E1 }, U.P1);
      expect(await refusal(s, declined, "under_review")).toMatch(/This task was declined/);
    });
  });

  it("the decliner can't update a task they declined, unless it was handed back and they accepted it", async () => {
    await db.asSuper(async (s) => {
      const id = await newTask(s, { assignee: U.E3, declinedBy: U.E1 }, U.E1);
      expect(await refusal(s, id, "under_review")).toBe("You declined this task, so you can't update it.");
      const back = await newTask(s, { assignee: U.E1, declinedBy: U.E1, acceptance: "accepted" }, U.E1);
      expect((await move(s, back, "under_review")).to_status).toBe("under_review");
    });
  });

  it("Employees change only tasks assigned to them, and can't touch tasks they can't see", async () => {
    await db.asSuper(async (s) => {
      const other = await newTask(s, { assignee: U.D, client: C.A }, U.E1); // on E1's client, assigned to someone else
      expect(await refusal(s, other, "under_review")).toBe("You can only change the status of tasks assigned to you.");
      const hidden = await newTask(s, { assignee: U.E4, client: C.B }, U.E1);
      expect(await refusal(s, hidden, "under_review")).toBe("That task doesn't exist, or it isn't one of yours.");
    });
  });

  it("Filed/Done → Not started is refused (reopen to In progress)", async () => {
    await db.asSuper(async (s) => {
      const id = await newTask(s, { status: "filed_done", completion: "2026-10-01T10:00:00Z" }, U.P1);
      expect(await refusal(s, id, "not_started", "redo")).toBe("This task is already done and filed; reopen it to In progress instead.");
    });
  });

  it("Employees can't set Filed/Done; they submit Under review", async () => {
    await db.asSuper(async (s) => {
      const id = await newTask(s, { status: "under_review" }, U.E1);
      expect(await refusal(s, id, "filed_done")).toBe("Employees can't set Filed/Done. Submit it for review (Under review) instead.");
    });
  });

  it("Managers file work they didn't do, but nobody files their own", async () => {
    await db.asSuper(async (s) => {
      const own = await newTask(s, { status: "under_review", assignee: U.M1, client: C.C }, U.M1);
      expect(await refusal(s, own, "filed_done")).toBe("Nobody files their own work. Ask another Manager or a Partner to file it.");
      const others = await newTask(s, { status: "under_review", assignee: U.E1 }, U.M1);
      expect((await move(s, others, "filed_done")).kind).toBe("file");
    });
  });

  it("Partners may file anything, including their own work", async () => {
    await db.asSuper(async (s) => {
      const own = await newTask(s, { status: "under_review", assignee: U.P1, client: C.C }, U.P1);
      expect((await move(s, own, "filed_done")).to_status).toBe("filed_done");
    });
  });
});

describe("change_task_status: dependencies (§7.6.4)", () => {
  it("can't move to In progress / Under review / Filed/Done while a blocker is open; the error names it", async () => {
    await db.asSuper(async (s) => {
      const blocker = await newTask(s, { title: "Collect bank statements", status: "data_awaited" });
      const id = await newTask(s, { status: "not_started" });
      await s.exec("insert into task_dependencies (task_id, blocker_task_id) values ($1, $2)", [id, blocker]);
      await s.as(U.E1);
      for (const to of ["in_progress", "under_review"]) {
        expect(await refusal(s, id, to)).toBe("Blocked by “Collect bank statements”, which isn't Filed/Done yet.");
      }
      await s.as(U.P1);
      expect(await refusal(s, id, "filed_done")).toBe("Blocked by “Collect bank statements”, which isn't Filed/Done yet.");
      // moves outside the gated set are fine
      await s.as(U.E1);
      expect((await move(s, id, "data_awaited")).kind).toBe("data_awaited");
    });
  });

  it("names every open blocker, and lets the move through once they're Filed/Done", async () => {
    await db.asSuper(async (s) => {
      const b1 = await newTask(s, { title: "First", status: "in_progress" });
      const b2 = await newTask(s, { title: "Second", status: "not_started" });
      const id = await newTask(s, { status: "not_started" });
      await s.exec("insert into task_dependencies (task_id, blocker_task_id) values ($1, $2), ($1, $3)", [id, b1, b2]);
      await s.as(U.E1);
      // both edges were added in one transaction (same created_at), so their order isn't fixed
      expect(await refusal(s, id, "in_progress")).toMatch(/^Blocked by “(First” and “Second|Second” and “First)”, which aren't Filed\/Done yet\.$/);
      await s.as("super");
      await s.exec("update tasks set status = 'filed_done' where id in ($1, $2)", [b1, b2]);
      await s.as(U.E1);
      expect((await move(s, id, "in_progress")).to_status).toBe("in_progress");
    });
  });
});

describe("change_task_status: reasons (§7.6.4)", () => {
  it("sending back, reopening and putting On hold need a reason; whitespace isn't one", async () => {
    await db.asSuper(async (s) => {
      const review = await newTask(s, { status: "under_review" }, U.M1);
      expect(await refusal(s, review, "in_progress")).toBe("Give a reason for sending this back; the assignee sees it.");
      expect(await refusal(s, review, "in_progress", "   ")).toBe("Give a reason for sending this back; the assignee sees it.");
      const back = await move(s, review, "in_progress", "Figures don't tie to 2B");
      expect(back).toMatchObject({ kind: "send_back", reason: "Figures don't tie to 2B" });

      const filed = await newTask(s, { status: "filed_done", completion: "2026-10-01T10:00:00Z" }, U.P1);
      expect(await refusal(s, filed, "in_progress")).toBe("Give a reason for reopening this task.");

      const open = await newTask(s, { status: "in_progress" }, U.E1);
      expect(await refusal(s, open, "on_hold")).toBe("Give a reason for putting this task on hold.");
      expect((await move(s, open, "on_hold", "Client travelling")).kind).toBe("hold");
      expect((await move(s, open, "in_progress")).kind).toBe("move");
    });
  });

  it("the database and lib/domain/transitions.ts give the same answer and wording", async () => {
    await db.asSuper(async (s) => {
      const statuses = ["not_started", "in_progress", "data_awaited", "under_review", "filed_done", "on_hold"] as const;
      for (const actor of [U.P1, U.M1, U.E1]) {
        for (const from of statuses) {
          for (const to of statuses) {
            const id = await newTask(s, { status: from, completion: from === "filed_done" ? "2026-10-01T10:00:00Z" : null, assignee: U.E1 }, actor);
            const db = await s.attempt("select change_task_status($1, $2::task_status, null)", [id, to]);
            const domain = canTransition({
              from, to, reason: null,
              actorRole: actor.profileRole, actorEmployeeId: actor.employeeId, assigneeEmployeeId: U.E1.employeeId,
              acceptance: "accepted", declinedByEmployeeId: null, blockers: [],
            });
            const label = `${actor.key} ${from}→${to}`;
            expect(db.ok, label).toBe(domain.ok);
            if (!db.ok && !domain.ok) expect(db.message.replace(/^USER: /, ""), label).toBe(domain.error);
          }
        }
      }
    });
  });
});

describe("change_task_status: derived values and history (§7.6.4)", () => {
  it("completion_date is set when first Filed/Done, kept on re-file, cleared on reopen; escalation resets on reopen", async () => {
    await db.asSuper(async (s) => {
      const id = await newTask(s, { status: "under_review", escalation: 2 }, U.P1);
      const filed = await move(s, id, "filed_done");
      expect(filed.completion_date).not.toBeNull();
      const t1 = await s.one<{ completion_date: Date; escalation_level: number }>("select completion_date, escalation_level from tasks where id = $1", [id]);
      expect(t1.escalation_level).toBe(2);

      const reopened = await move(s, id, "in_progress", "Revised figures");
      expect(reopened).toMatchObject({ kind: "reopen", completion_date: null, reset_escalation: true });
      const t2 = await s.one<{ completion_date: Date | null; escalation_level: number; escalated_at: Date | null }>(
        "select completion_date, escalation_level, escalated_at from tasks where id = $1", [id]);
      expect(t2).toEqual({ completion_date: null, escalation_level: 0, escalated_at: null });

      // a completion date already recorded (e.g. imported) is kept when the task is filed
      const kept = await newTask(s, { status: "under_review", completion: "2026-09-30T12:00:00Z" }, U.P1);
      await move(s, kept, "filed_done");
      expect((await s.value<Date>("select completion_date from tasks where id = $1", [kept])).toISOString()).toBe("2026-09-30T12:00:00.000Z");
    });
  });

  it("On hold records the reason and clears it on leaving; every change writes task_status_history", async () => {
    await db.asSuper(async (s) => {
      const id = await newTask(s, { status: "in_progress" }, U.E1);
      await move(s, id, "on_hold", "Waiting for the client");
      expect(await s.value("select on_hold_reason from tasks where id = $1", [id])).toBe("Waiting for the client");
      await move(s, id, "in_progress");
      expect(await s.value("select on_hold_reason from tasks where id = $1", [id])).toBeNull();
      await move(s, id, "under_review");
      const hist = await s.rows<{ from_status: string; to_status: string; reason: string | null; changed_by: string }>(
        "select from_status::text, to_status::text, reason, changed_by from task_status_history where task_id = $1 order by changed_at, id", [id]);
      expect(hist.map((h) => `${h.from_status}>${h.to_status}`).sort()).toEqual(["in_progress>on_hold", "on_hold>in_progress", "in_progress>under_review"].sort());
      expect(hist.every((h) => h.changed_by === U.E1.id)).toBe(true);
      expect(hist.find((h) => h.to_status === "on_hold")?.reason).toBe("Waiting for the client");
    });
  });

  it("returns what the after-commit notifications need (§0.1 rule 5)", async () => {
    await db.asSuper(async (s) => {
      const id = await newTask(s, { status: "in_progress", reviewer: U.E2 }, U.E1);
      const r = await move(s, id, "under_review");
      expect(r).toMatchObject({
        kind: "submit_for_review", client_id: C.A, actor_employee_id: U.E1.employeeId,
        assigned_employee_id: U.E1.employeeId, reviewer_employee_id: U.E2.employeeId, client_owner_employee_id: U.E1.employeeId,
      });
      expect((await move(s, await newTask(s, {}, U.E1), "data_awaited")).adds_to_call_list).toBe(true);
    });
  });

  it("nobody changes status or completion_date by a direct UPDATE, Partners included", async () => {
    for (const user of [U.P1, U.M1, U.E1]) {
      await db.asRole(user, async (s) => {
        for (const set of ["status = 'filed_done'", "completion_date = now()"]) {
          const e = await s.fails(`update tasks set ${set} where id = $1`, [F.task("A")]);
          expect(userMessage(e), `${user.key} ${set}`).toMatch(/changes only through Change status/);
        }
      });
    }
    const e = await db.asRole(U.P1, (s) =>
      s.fails("insert into tasks (client_id, title, status, created_by) values ($1, 'x', 'filed_done', $2)", [C.A, U.P1.id]));
    expect(userMessage(e)).toMatch(/can't start as Filed\/Done/);
  });
});

describe("acceptance: respond_to_task (§7.6.3)", () => {
  it("the assignee accepts, or declines with a reason (a note for 'other'); declining unassigns", async () => {
    await db.asSuper(async (s) => {
      const a = await newTask(s, { acceptance: "pending" }, U.E1);
      expect((await s.value<{ acceptance_status: string }>("select respond_to_task($1, true)", [a])).acceptance_status).toBe("accepted");
      expect(userMessage(await s.fails("select respond_to_task($1, true)", [a]))).toMatch(/already accepted/);

      const d = await newTask(s, { acceptance: "pending" }, U.E1);
      expect(userMessage(await s.fails("select respond_to_task($1, false)", [d]))).toMatch(/Choose a reason/);
      expect(userMessage(await s.fails("select respond_to_task($1, false, 'other', '  ')", [d]))).toMatch(/Add a note/);
      await s.value("select respond_to_task($1, false, 'no_capacity')", [d]);
      const row = await s.one("select assigned_employee_id, acceptance_status::text, declined_by_employee_id, decline_reason::text from tasks where id = $1", [d]);
      expect(row).toEqual({ assigned_employee_id: null, acceptance_status: "declined", declined_by_employee_id: U.E1.employeeId, decline_reason: "no_capacity" });
    });
  });

  it("only the assignee can respond", async () => {
    await db.asSuper(async (s) => {
      const id = await newTask(s, { acceptance: "pending", assignee: U.D }, U.E1);
      expect(userMessage(await s.fails("select respond_to_task($1, true)", [id]))).toMatch(/Only the person this task is assigned to/);
      await s.as(U.P1);
      expect(userMessage(await s.fails("select respond_to_task($1, true)", [id]))).toMatch(/Only the person this task is assigned to/);
    });
  });

  it("reassigning puts acceptance back to pending (§7.6.3)", async () => {
    await db.asSuper(async (s) => {
      const id = await newTask(s, { acceptance: "accepted" }, U.M1);
      await s.exec("update tasks set assigned_employee_id = $2 where id = $1", [id, U.E3.employeeId]);
      expect(await s.one("select acceptance_status::text, accepted_at from tasks where id = $1", [id])).toEqual({ acceptance_status: "pending", accepted_at: null });
    });
  });
});

describe("Employees' direct task updates are column-limited (§4.6)", () => {
  it("remarks yes; due date, title, reviewer, client or reassignment no", async () => {
    await db.asRole(U.E1, async (s) => {
      expect(await s.exec("update tasks set remarks = 'Waiting on 2B' where id = $1", [F.task("A")])).toBe(1);
      for (const set of ["due_date = '2027-01-01'", "title = 'x'", `reviewer_employee_id = '${U.E2.employeeId}'`, `client_id = '${C.B}'`, "priority = 'urgent'"]) {
        const e = await s.fails(`update tasks set ${set} where id = $1`, [F.task("A")]);
        expect(e.code, set).toBe(SQLSTATE.raiseException);
      }
      expect(userMessage(await s.fails("update tasks set assigned_employee_id = $2 where id = $1", [F.task("A"), U.E3.employeeId]))).toMatch(/Only a Partner or Manager can reassign/);
    });
  });

  it("an Employee can't update tasks not assigned to them, even on their own client", async () => {
    await db.asSuper(async (s) => {
      const id = await newTask(s, { assignee: U.D, client: C.A }, U.E1);
      expect(await s.exec("update tasks set remarks = 'x' where id = $1", [id])).toBe(0);
    });
  });

  it("Employees can't create or delete tasks; Managers create; only Partners delete", async () => {
    await db.asRole(U.E1, async (s) => {
      const ins = await s.attempt("insert into tasks (client_id, title, created_by) values ($1, 'x', $2)", [C.A, U.E1.id]);
      expect(ins.ok).toBe(false);
      expect(await s.exec("delete from tasks")).toBe(0);
    });
    await db.asRole(U.M1, async (s) => {
      const n = await s.value<string>("insert into tasks (client_id, title, created_by) values ($1, 'New', $2) returning task_number", [C.A, U.M1.id]);
      expect(n).toMatch(/^T-\d{6}$/);
      expect(await s.exec("delete from tasks where id = $1", [F.task("A")])).toBe(0);
    });
  });

  it("checklist: the assignee ticks items done, nothing more", async () => {
    await db.asRole(U.E1, async (s) => {
      expect(await s.exec("update task_checklist_items set done = true, done_at = now(), done_by = $2 where task_id = $1", [F.task("A"), U.E1.id])).toBe(1);
      expect(userMessage(await s.fails("update task_checklist_items set title = 'x' where task_id = $1", [F.task("A")]))).toMatch(/title/);
    });
  });
});

describe("task visibility (§4.1)", () => {
  it("an Employee sees tasks assigned to them or naming them reviewer, even on a client they can't see", async () => {
    await db.asSuper(async (s) => {
      const assigned = await newTask(s, { client: C.C, assignee: U.E3 });
      const reviewing = await newTask(s, { client: C.C, assignee: U.M2, reviewer: U.E3 });
      await s.as(U.E3);
      expect(new Set((await s.rows<{ id: string }>("select id from tasks")).map((r) => r.id))).toEqual(new Set([assigned, reviewing]));
      expect(await s.value<number>("select count(*)::int from clients")).toBe(0);
      expect(await s.value<number>("select count(*)::int from tasks_view")).toBe(2);
    });
  });

  it("task children follow the task", async () => {
    await db.asRole(U.E1, async (s) => {
      for (const t of ["task_comments", "task_checklist_items", "task_attachments", "task_status_history"]) {
        const ids = new Set((await s.rows<{ task_id: string }>(`select task_id from ${t}`)).map((r) => r.task_id));
        expect(ids, t).toEqual(new Set([F.task("A")]));
      }
    });
    await db.asRole(U.CA, async (s) => {
      for (const t of ["tasks", "task_comments", "task_checklist_items", "task_attachments", "task_status_history", "task_dependencies"]) {
        expect(await s.value<number>(`select count(*)::int from ${t}`), t).toBe(0);
      }
    });
  });

  it("an Employee comments as themselves on tasks they can see only", async () => {
    await db.asRole(U.E1, async (s) => {
      expect(await s.exec("insert into task_comments (task_id, author_id, body) values ($1, $2, 'hi')", [F.task("A"), U.E1.id])).toBe(1);
      expect((await s.attempt("insert into task_comments (task_id, author_id, body) values ($1, $2, 'hi')", [F.task("A"), U.E2.id])).ok).toBe(false);
      expect((await s.attempt("insert into task_comments (task_id, author_id, body) values ($1, $2, 'hi')", [F.task("B"), U.E1.id])).ok).toBe(false);
    });
  });
});

describe("task dependencies (§5.5, §7.6.2)", () => {
  it("rejects a task blocked by itself and any cycle", async () => {
    await db.asSuper(async (s) => {
      const a = await newTask(s, {});
      const b = await newTask(s, {});
      const c = await newTask(s, {});
      await s.as(U.M1);
      expect(userMessage(await s.fails("insert into task_dependencies (task_id, blocker_task_id) values ($1, $1)", [a]))).toMatch(/blocked by itself/);
      await s.exec("insert into task_dependencies (task_id, blocker_task_id) values ($1, $2), ($2, $3)", [a, b, c]); // a waits on b, b on c
      expect(userMessage(await s.fails("insert into task_dependencies (task_id, blocker_task_id) values ($1, $2)", [c, a]))).toMatch(/loop/);
      expect(userMessage(await s.fails("insert into task_dependencies (task_id, blocker_task_id) values ($1, $2)", [b, a]))).toMatch(/loop/);
      // re-pointing an edge into a loop is caught too
      const edge = await s.value<string>("select id from task_dependencies where task_id = $1", [b]);
      expect(userMessage(await s.fails("update task_dependencies set blocker_task_id = $2 where id = $1", [edge, a]))).toMatch(/loop/);
      // a diamond is not a cycle
      await s.exec("insert into task_dependencies (task_id, blocker_task_id) values ($1, $2)", [a, c]);
    });
  });

  it("only Partners and Managers set dependencies", async () => {
    await db.asRole(U.E1, async (s) => {
      expect((await s.attempt("insert into task_dependencies (task_id, blocker_task_id) values ($1, $2)", [F.task("A"), F.task("B")])).ok).toBe(false);
    });
  });
});
