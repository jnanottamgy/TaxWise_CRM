/**
 * Work tracker and timesheet functions (migrations 0130–0133): create_task, apply_job_template,
 * bulk_update_tasks, file_task (§7.6.2, §7.6.5, §7.6.7), the assignment record and escalation
 * re-arm, tasks_list (§7.6.1), the timer, manual entries, week approval and locking, unbilled time
 * (§7.10), job templates and recurring-task automations.
 */
import { describe, expect, it } from "vitest";
import { C, F, SQLSTATE, U, isDenied, setupTestDatabase, userMessage, type Session, type TestUser } from "./helpers";

const db = setupTestDatabase("work");

let seq = 0;

type NewTask = {
  client?: string;
  title?: string;
  status?: string;
  assignee?: TestUser | null;
  reviewer?: TestUser | null;
  acceptance?: "pending" | "accepted" | "declined";
  service?: string | null;
  due?: string | null;
  event?: string | null;
  escalation?: number;
};

/** Insert a task as the superuser (no guards), then switch to `as`. */
async function newTask(s: Session, t: NewTask = {}, as: TestUser | "super" = "super"): Promise<string> {
  await s.as("super");
  const id = await s.value<string>(
    `insert into tasks (task_number, client_id, title, status, assigned_employee_id, reviewer_employee_id, acceptance_status,
                        accepted_at, service_type, due_date, compliance_event_id, escalation_level, escalated_at, created_by)
     values ($1, $2, $3, $4::task_status, $5, $6, $7::task_acceptance, case when $7::task_acceptance = 'accepted' then now() end,
             $8::service_type, $9::date, $10, $11::int, case when $11::int > 0 then now() end, $12)
     returning id`,
    [
      `T-7${String(++seq).padStart(5, "0")}`,
      t.client ?? C.A,
      t.title ?? `Work task ${seq}`,
      t.status ?? "in_progress",
      t.assignee === undefined ? U.E1.employeeId : (t.assignee?.employeeId ?? null),
      t.reviewer?.employeeId ?? null,
      t.acceptance ?? "accepted",
      t.service ?? null,
      t.due ?? null,
      t.event ?? null,
      t.escalation ?? 0,
      U.P1.id,
    ],
  );
  if (as !== "super") await s.as(as);
  return id;
}

const createTask = (s: Session, p: Record<string, unknown>) => s.value<Record<string, unknown>>("select create_task($1::jsonb)", [JSON.stringify(p)]);
const refusal = async (s: Session, sql: string, params: unknown[] = []) => userMessage(await s.fails(sql, params));

/** A Monday n weeks before the current IST week. */
const mondayAgo = (s: Session, weeks: number) => s.value<string>("select to_char(ist_week_start(now()) - $1::int * 7, 'YYYY-MM-DD')", [weeks]);

// =================================================================================================
// create_task (§7.6.2)
// =================================================================================================
describe("create_task (§7.6.2)", () => {
  it("only Partners and Managers create tasks", async () => {
    await db.asRole(U.E1, async (s) => {
      expect(await refusal(s, "select create_task($1::jsonb)", [JSON.stringify({ client_id: C.A, title: "x" })])).toBe("Only a Partner or Manager can create tasks.");
    });
  });

  it("creates the task with its number, the assigner, a pending acceptance and the template's steps with their offsets", async () => {
    await db.asRole(U.M1, async (s) => {
      const tpl = await s.value<string>("select id from job_templates where name = 'Monthly GST filing'");
      const r = await createTask(s, {
        client_id: C.A,
        title: "GSTR-3B: Oct 2026",
        service_type: "gst",
        financial_year: "2026-27",
        period_label: "Oct 2026",
        due_date: "2026-11-20",
        assigned_employee_id: U.E1.employeeId,
        reviewer_employee_id: U.M2.employeeId,
        template_id: tpl,
        checklist: [{ title: "Call the client about advances" }],
      });
      expect(r.task_number).toMatch(/^T-\d{6}$/);
      const t = await s.one<Record<string, unknown>>("select * from tasks where id = $1", [r.id]);
      expect(t.acceptance_status).toBe("pending");
      expect(t.assigned_by).toBe(U.M1.id);
      expect(t.created_by).toBe(U.M1.id);
      expect(t.source_template_id).toBe(tpl);
      const items = await s.rows<{ title: string; due_offset_days: number | null; sort_order: number }>(
        "select title, due_offset_days, sort_order from task_checklist_items where task_id = $1 order by sort_order",
        [r.id],
      );
      const templateSteps = await s.value<number>("select count(*)::int from job_template_items where template_id = $1", [tpl]);
      expect(items).toHaveLength(templateSteps + 1);
      expect(items[0]).toMatchObject({ title: "Collect sales register", due_offset_days: 9, sort_order: 0 });
      expect(items[items.length - 1]).toMatchObject({ title: "Call the client about advances", due_offset_days: null });
    });
  });

  it("blocks a disabled assignee and a reviewer who is the assignee", async () => {
    await db.asRole(U.M1, async (s) => {
      expect(await refusal(s, "select create_task($1::jsonb)", [JSON.stringify({ client_id: C.A, title: "x", assigned_employee_id: U.D.employeeId })])).toBe(
        "That person's account is disabled, so the work would be lost. Choose someone active.",
      );
      expect(
        await refusal(s, "select create_task($1::jsonb)", [
          JSON.stringify({ client_id: C.A, title: "x", assigned_employee_id: U.E1.employeeId, reviewer_employee_id: U.E1.employeeId }),
        ]),
      ).toBe("The reviewer can't also be the assignee: nobody reviews their own work.");
    });
  });

  it("links the deadline both ways, refuses another client's deadline, and records blockers", async () => {
    await db.asRole(U.P1, async (s) => {
      const event = await s.value<string>("select id from compliance_events where client_id = $1 and type = 'gstr_3b'", [C.A]);
      const other = await s.value<string>("select id from compliance_events where client_id = $1 and type = 'gstr_3b'", [C.B]);
      expect(await refusal(s, "select create_task($1::jsonb)", [JSON.stringify({ client_id: C.A, title: "x", compliance_event_id: other })])).toBe(
        "That deadline belongs to another client.",
      );
      const r = await createTask(s, { client_id: C.A, title: "File GSTR-3B", compliance_event_id: event, blocker_ids: [F.task("A")] });
      expect(await s.value("select task_id from compliance_events where id = $1", [event])).toBe(r.id);
      expect(await s.value("select count(*)::int from task_dependencies where task_id = $1 and blocker_task_id = $2", [r.id, F.task("A")])).toBe(1);
    });
  });
});

// =================================================================================================
// Assignment record and escalation re-arm (0130)
// =================================================================================================
describe("tasks_track_assignment", () => {
  it("records who reassigned a task, and API callers can't rewrite it", async () => {
    await db.asSuper(async (s) => {
      const id = await newTask(s, { assignee: U.E1 }, U.M2);
      await s.exec("update tasks set assigned_employee_id = $2 where id = $1", [id, U.E3.employeeId]);
      const t = await s.one<{ assigned_by: string; acceptance_status: string }>("select assigned_by, acceptance_status from tasks where id = $1", [id]);
      expect(t).toEqual({ assigned_by: U.M2.id, acceptance_status: "pending" });
      await s.exec("update tasks set assigned_by = $2 where id = $1", [id, U.P1.id]);
      expect(await s.value("select assigned_by from tasks where id = $1", [id])).toBe(U.M2.id);
    });
  });

  it("a decline keeps the assigner, so they can be told", async () => {
    await db.asSuper(async (s) => {
      const id = await newTask(s, { assignee: U.E1, acceptance: "pending" }, U.M1);
      await s.exec("update tasks set assigned_employee_id = $2 where id = $1", [id, U.E3.employeeId]);
      await s.as(U.E3);
      await s.value("select respond_to_task($1, false, 'no_capacity', null)", [id]);
      await s.as("super");
      const t = await s.one<{ assigned_by: string; assigned_employee_id: string | null }>("select assigned_by, assigned_employee_id from tasks where id = $1", [id]);
      expect(t).toEqual({ assigned_by: U.M1.id, assigned_employee_id: null });
    });
  });

  it("a due-date change re-arms escalation (§7.6.7)", async () => {
    await db.asSuper(async (s) => {
      const id = await newTask(s, { due: "2026-09-01", escalation: 2 }, U.M1);
      await s.exec("update tasks set due_date = '2026-12-01' where id = $1", [id]);
      const t = await s.one<{ escalation_level: number; escalated_at: string | null }>("select escalation_level, escalated_at from tasks where id = $1", [id]);
      expect(t).toEqual({ escalation_level: 0, escalated_at: null });
      await s.exec("update tasks set title = 'Renamed' where id = $1", [id]);
      await s.exec("update tasks set escalation_level = 1, escalated_at = now() where id = $1", [id]);
      await s.exec("update tasks set title = 'Renamed again' where id = $1", [id]);
      expect(await s.value("select escalation_level from tasks where id = $1", [id])).toBe(1);
    });
  });
});

// =================================================================================================
// tasks_list (§7.6.1)
// =================================================================================================
describe("tasks_list", () => {
  it("Employees see their own tasks, with the client's name even when the client is outside their scope", async () => {
    await db.asSuper(async (s) => {
      const id = await newTask(s, { assignee: U.E3, client: C.A, title: "Help with Alpha" }, U.E3);
      const rows = await s.rows<{ id: string; client_name: string; client_code: string }>("select id, client_name, client_code from tasks_list where deleted_at is null");
      expect(rows.map((r) => r.id)).toEqual([id]);
      expect(rows[0]).toMatchObject({ client_name: "Alpha Traders", client_code: "TW-C-9001" });
      await s.as(U.E4);
      expect(await s.value("select count(*)::int from tasks_list where id = $1", [id])).toBe(0);
    });
  });

  it("counts open blockers and everyone's logged time, and derives overdue", async () => {
    await db.asSuper(async (s) => {
      const blocker = await newTask(s, { assignee: U.E4, client: C.B, status: "data_awaited" });
      const id = await newTask(s, { assignee: U.E1, due: "2020-01-01" });
      await s.exec("insert into task_dependencies (task_id, blocker_task_id) values ($1, $2)", [id, blocker]);
      await s.exec(
        `insert into time_entries (employee_id, client_id, task_id, started_at, ended_at)
         values ($1, $3, $4, now() - interval '3 hours', now() - interval '2 hours'),
                ($2, $3, $4, now() - interval '2 hours', now() - interval '90 minutes')`,
        [U.E1.employeeId, U.E2.employeeId, C.A, id],
      );
      await s.as(U.E1);
      const r = await s.one<{ open_blockers: number; logged_minutes: number; is_overdue: boolean }>(
        "select open_blockers, logged_minutes, is_overdue from tasks_list where id = $1",
        [id],
      );
      expect(r).toEqual({ open_blockers: 1, logged_minutes: 90, is_overdue: true });
      const deps = await s.rows<{ direction: string; title: string; visible: boolean }>("select direction, title, visible from task_dependency_list($1)", [id]);
      expect(deps).toHaveLength(1);
      expect(deps[0].direction).toBe("blocked_by");
      expect(deps[0].visible).toBe(false);
    });
  });

  it("a portal user sees nothing", async () => {
    await db.asRole(U.CA, async (s) => {
      expect(await s.value("select count(*)::int from tasks_list")).toBe(0);
    });
  });
});

// =================================================================================================
// apply_job_template
// =================================================================================================
describe("apply_job_template", () => {
  it("adds the steps once; a second run skips steps already on the checklist", async () => {
    await db.asSuper(async (s) => {
      const id = await newTask(s, {}, U.M1);
      const tpl = await s.value<string>("select id from job_templates where name = 'Monthly GST filing'");
      const first = await s.value<{ added: number; skipped: number }>("select apply_job_template($1, $2)", [id, tpl]);
      expect(first.added).toBeGreaterThan(0);
      expect(first.skipped).toBe(0);
      const second = await s.value<{ added: number; skipped: number }>("select apply_job_template($1, $2)", [id, tpl]);
      expect(second).toMatchObject({ added: 0, skipped: first.added });
      await s.as(U.E1);
      expect(await refusal(s, "select apply_job_template($1, $2)", [id, tpl])).toBe("Only a Partner or Manager can apply a job template.");
    });
  });
});

// =================================================================================================
// bulk_update_tasks (§7.6.7)
// =================================================================================================
describe("bulk_update_tasks", () => {
  it("a due-date change needs a reason, and is logged on each task", async () => {
    await db.asSuper(async (s) => {
      const a = await newTask(s, { due: "2026-11-01" });
      const b = await newTask(s, { due: "2026-11-02" }, U.M1);
      expect(await refusal(s, "select bulk_update_tasks($1, $2::jsonb, null)", [[a, b], JSON.stringify({ due_date: "2026-11-10" })])).toBe(
        "Give a reason for changing the due date.",
      );
      const r = await s.value<{ updated: unknown[]; skipped: unknown[] }>("select bulk_update_tasks($1, $2::jsonb, $3)", [
        [a, b],
        JSON.stringify({ due_date: "2026-11-10" }),
        "Client asked for more time",
      ]);
      expect(r.updated).toHaveLength(2);
      expect(await s.value("select count(*)::int from tasks where id = any($1) and due_date = '2026-11-10'", [[a, b]])).toBe(2);
      const log = await s.value<string>("select description from activity_logs where entity_id = $1 and action = 'bulk_updated'", [a]);
      expect(log).toBe("Due date 01 Nov 2026 → 10 Nov 2026: Client asked for more time");
    });
  });

  it("skips tasks the person reviews and filed tasks; assigning resets acceptance", async () => {
    await db.asSuper(async (s) => {
      const reviews = await newTask(s, { assignee: U.E1, reviewer: U.E3 });
      const filed = await newTask(s, { status: "filed_done" });
      const fine = await newTask(s, { assignee: U.E1 }, U.M1);
      const r = await s.value<{ updated: Array<{ id: string }>; skipped: Array<{ id: string; reason: string }> }>(
        "select bulk_update_tasks($1, $2::jsonb, null)",
        [[reviews, filed, fine], JSON.stringify({ assigned_employee_id: U.E3.employeeId })],
      );
      expect(r.updated.map((u) => u.id)).toEqual([fine]);
      expect(r.skipped.map((x) => x.reason).sort()).toEqual(["Already filed", "They are its reviewer: nobody reviews their own work"]);
      expect(await s.value("select acceptance_status from tasks where id = $1", [fine])).toBe("pending");
    });
  });

  it("refuses Employees and disabled assignees", async () => {
    await db.asSuper(async (s) => {
      const id = await newTask(s, {}, U.M1);
      expect(await refusal(s, "select bulk_update_tasks($1, $2::jsonb, null)", [[id], JSON.stringify({ assigned_employee_id: U.D.employeeId })])).toMatch(/disabled/);
      await s.as(U.E1);
      expect(await refusal(s, "select bulk_update_tasks($1, $2::jsonb, null)", [[id], JSON.stringify({ priority: "high" })])).toBe(
        "Only a Partner or Manager can change tasks in bulk.",
      );
    });
  });
});

// =================================================================================================
// file_task (§7.6.5)
// =================================================================================================
describe("file_task (§7.6.5)", () => {
  const filing = { filing_type: "ITR-4", period: "2025-26", financial_year: "2025-26", filed_on: "2026-07-20", acknowledgement_no: "123456789012345" };

  it("records the filing and files the task in one go", async () => {
    await db.asSuper(async (s) => {
      const id = await newTask(s, { status: "under_review", service: "income_tax" }, U.M1);
      const r = await s.value<Record<string, unknown>>("select file_task($1, $2::jsonb)", [id, JSON.stringify(filing)]);
      expect(r.to_status).toBe("filed_done");
      const rec = await s.one<{ task_id: string; filing_type: string; acknowledgement_no: string; service_type: string }>(
        "select task_id, filing_type, acknowledgement_no, service_type from filing_records where id = $1",
        [r.filing_record_id],
      );
      expect(rec).toEqual({ task_id: id, filing_type: "ITR-4", acknowledgement_no: "123456789012345", service_type: "income_tax" });
    });
  });

  it("marks the linked deadline Filed through record_compliance_filing", async () => {
    await db.asSuper(async (s) => {
      const event = await s.value<string>("select id from compliance_events where client_id = $1 and type = 'gstr_3b'", [C.A]);
      const id = await newTask(s, { status: "under_review", service: "gst", event }, U.P1);
      const r = await s.value<Record<string, unknown>>("select file_task($1, $2::jsonb)", [
        id,
        JSON.stringify({ filing_type: "GSTR-3B", period: "Oct 2026", financial_year: "2026-27", filed_on: "2026-10-20", acknowledgement_no: "AA2910260012345" }),
      ]);
      expect(await s.value("select workflow_status from compliance_events where id = $1", [event])).toBe("filed");
      expect(await s.value("select task_id from filing_records where id = $1", [r.filing_record_id])).toBe(id);
    });
  });

  it("can be skipped with a reason for work with nothing to file", async () => {
    await db.asSuper(async (s) => {
      const id = await newTask(s, { status: "under_review", service: "bookkeeping" }, U.M1);
      expect(await refusal(s, "select file_task($1, null, null)", [id])).toBe("Enter the filing details, or skip them with a reason.");
      const r = await s.value<Record<string, unknown>>("select file_task($1, null, $2)", [id, "Books closed; nothing filed"]);
      expect(r.filing_skipped).toBe(true);
      expect(await s.value("select filing_skipped_reason from tasks where id = $1", [id])).toBe("Books closed; nothing filed");
    });
  });

  it("the status rules still apply, and a refusal leaves no filing record behind", async () => {
    await db.asSuper(async (s) => {
      const own = await newTask(s, { status: "under_review", assignee: U.M1, client: C.C, service: "income_tax" }, U.M1);
      expect(await refusal(s, "select file_task($1, $2::jsonb)", [own, JSON.stringify(filing)])).toBe("Nobody files their own work. Ask another Manager or a Partner to file it.");
      expect(await s.value("select count(*)::int from filing_records where task_id = $1", [own])).toBe(0);
      const mine = await newTask(s, { status: "under_review", service: "income_tax" }, U.E1);
      expect(await refusal(s, "select file_task($1, $2::jsonb)", [mine, JSON.stringify(filing)])).toBe(
        "Employees can't set Filed/Done. Submit it for review (Under review) instead.",
      );
    });
  });

  it("refuses a stale edit and a filed-on date in the future", async () => {
    await db.asSuper(async (s) => {
      const id = await newTask(s, { status: "under_review" }, U.M1);
      expect(await refusal(s, "select file_task($1, $2::jsonb, null, '2000-01-01T00:00:00Z')", [id, JSON.stringify(filing)])).toBe(
        "This task was changed by someone else. Reload to see their changes.",
      );
      expect(await refusal(s, "select file_task($1, $2::jsonb)", [id, JSON.stringify({ ...filing, filed_on: "2999-01-01" })])).toBe(
        "The filed-on date can't be in the future.",
      );
    });
  });
});

// =================================================================================================
// Timer (§7.10)
// =================================================================================================
describe("timer (§7.10)", () => {
  it("one running timer per person: starting another stops the first", async () => {
    await db.asRole(U.E1, async (s) => {
      const first = await s.value<{ entry_id: string; stopped_entry_id: string | null }>("select start_timer($1, null, 'Working', null)", [F.task("A")]);
      expect(first.stopped_entry_id).toBeNull();
      const second = await s.value<{ entry_id: string; stopped_entry_id: string | null }>("select start_timer(null, $1, null, null)", [C.A]);
      expect(second.stopped_entry_id).toBe(first.entry_id);
      expect(await s.value("select count(*)::int from time_entries where employee_id = $1 and ended_at is null", [U.E1.employeeId])).toBe(1);
      const firstRow = await s.one<{ client_id: string; billable: boolean; entry_source: string }>("select client_id, billable, entry_source from time_entries where id = $1", [first.entry_id]);
      expect(firstRow).toEqual({ client_id: C.A, billable: true, entry_source: "timer" });
      const stopped = await s.value<{ entry_id: string }>("select stop_timer('Done')");
      expect(stopped.entry_id).toBe(second.entry_id);
      expect(await refusal(s, "select stop_timer(null)")).toBe("No timer is running.");
    });
  });

  it("time without a client isn't billable; an Employee times a task assigned to them on a client outside their scope", async () => {
    await db.asSuper(async (s) => {
      const id = await newTask(s, { assignee: U.E3, client: C.B }, U.E3);
      const r = await s.value<{ entry_id: string; client_id: string }>("select start_timer($1, null, null, null)", [id]);
      expect(r.client_id).toBe(C.B);
      await s.value("select stop_timer(null)");
      const internal = await s.value<{ entry_id: string }>("select start_timer(null, null, 'Training', true)");
      expect(await s.value("select billable from time_entries where id = $1", [internal.entry_id])).toBe(false);
    });
  });

  it("refuses a task the person can't see", async () => {
    await db.asRole(U.E1, async (s) => {
      expect(await refusal(s, "select start_timer($1, null, null, null)", [F.task("B")])).toBe("That task doesn't exist, or it isn't one of yours.");
    });
  });
});

// =================================================================================================
// Manual entries (§7.10)
// =================================================================================================
describe("manual entries", () => {
  it("a duration entry gets its end from the duration; a range entry gets its minutes from the times", async () => {
    await db.asRole(U.E1, async (s) => {
      const d = await s.one<{ minutes: number; ended: boolean }>(
        `insert into time_entries (employee_id, client_id, started_at, minutes, entry_source)
         values ($1, $2, (current_date - 1)::timestamp at time zone 'Asia/Kolkata', 95, 'manual_duration')
         returning minutes, ended_at = started_at + interval '95 minutes' as ended`,
        [U.E1.employeeId, C.A],
      );
      expect(d).toEqual({ minutes: 95, ended: true });
      const r = await s.value<number>(
        `insert into time_entries (employee_id, client_id, started_at, ended_at, minutes)
         values ($1, $2, now() - interval '150 minutes', now() - interval '30 minutes', 5) returning minutes`,
        [U.E1.employeeId, C.A],
      );
      expect(r).toBe(120);
    });
  });

  it("refuses more than 24 hours, the future, and a task of another client", async () => {
    await db.asRole(U.E1, async (s) => {
      expect(
        await refusal(
          s,
          `insert into time_entries (employee_id, client_id, started_at, minutes, entry_source) values ($1, $2, now() - interval '2 days', 1500, 'manual_duration')`,
          [U.E1.employeeId, C.A],
        ),
      ).toBe("One entry can't be longer than 24 hours. Split it across the days.");
      expect(
        await refusal(s, `insert into time_entries (employee_id, client_id, started_at, ended_at) values ($1, $2, now() + interval '1 hour', now() + interval '2 hours')`, [
          U.E1.employeeId,
          C.A,
        ]),
      ).toBe("Time can't be logged for later than now.");
    });
    await db.asRole(U.P1, async (s) => {
      expect(
        await refusal(s, `insert into time_entries (employee_id, client_id, task_id, started_at, ended_at) values ($1, $2, $3, now() - interval '2 hours', now() - interval '1 hour')`, [
          U.P1.employeeId,
          C.B,
          F.task("A"),
        ]),
      ).toBe("That task belongs to another client. Choose the client or the task again.");
    });
  });
});

// =================================================================================================
// Week approval and locking (§7.10)
// =================================================================================================
describe("week approval and locking", () => {
  async function lastWeekEntry(s: Session, who: TestUser): Promise<{ id: string; monday: string }> {
    const monday = await mondayAgo(s, 1);
    await s.as("super");
    const id = await s.value<string>(
      `insert into time_entries (employee_id, client_id, started_at, ended_at)
       values ($1, $2, ($3::date + 1)::timestamp at time zone 'Asia/Kolkata' + interval '10 hours',
                       ($3::date + 1)::timestamp at time zone 'Asia/Kolkata' + interval '12 hours') returning id`,
      [who.employeeId, C.A, monday],
    );
    return { id, monday };
  }

  it("a Manager approves an Employee's week, which locks it; the Employee can't change, delete or add to it", async () => {
    await db.asSuper(async (s) => {
      const { id, monday } = await lastWeekEntry(s, U.E1);
      await s.as(U.M1);
      const r = await s.value<{ entries: number; minutes: number }>("select approve_timesheet_week($1, $2::date, null)", [U.E1.employeeId, monday]);
      expect(r).toMatchObject({ entries: 1, minutes: 120 });
      expect(await s.value("select locked from time_entries where id = $1", [id])).toBe(true);
      expect(await refusal(s, "select approve_timesheet_week($1, $2::date, null)", [U.E1.employeeId, monday])).toBe("This week is already approved.");

      await s.as(U.E1);
      expect(await s.exec("update time_entries set description = 'x' where id = $1", [id])).toBe(0); // RLS: locked rows aren't theirs to update
      await s.as(U.M1);
      expect(await refusal(s, "update time_entries set description = 'x' where id = $1", [id])).toBe(
        "This time entry is locked (billed, or in an approved week), so it can't be changed.",
      );
      expect(await refusal(s, "delete from time_entries where id = $1", [id])).toMatch(/locked/);
      await s.as(U.E1);
      expect(
        await refusal(
          s,
          `insert into time_entries (employee_id, client_id, started_at, minutes, entry_source) values ($1, $2, ($3::date + 2)::timestamp at time zone 'Asia/Kolkata', 30, 'manual_duration')`,
          [U.E1.employeeId, C.A, monday],
        ),
      ).toMatch(/is approved and locked/);
    });
  });

  it("Managers don't approve their own week or a Partner's; a running timer blocks approval", async () => {
    await db.asSuper(async (s) => {
      const monday = await mondayAgo(s, 1);
      await s.as(U.M1);
      expect(await refusal(s, "select approve_timesheet_week($1, $2::date, null)", [U.M1.employeeId, monday])).toBe(
        "Nobody approves their own timesheet. Ask another Manager or a Partner.",
      );
      expect(await refusal(s, "select approve_timesheet_week($1, $2::date, null)", [U.P1.employeeId, monday])).toBe(
        "A Manager approves Employees' weeks. Ask a Partner to approve this one.",
      );
      await s.as(U.E4);
      await s.value("select start_timer(null, null, null, null)");
      await s.as(U.P1);
      const thisMonday = await mondayAgo(s, 0);
      expect(await refusal(s, "select approve_timesheet_week($1, $2::date, null)", [U.E4.employeeId, thisMonday])).toBe("A timer is still running in this week. Stop it first.");
      await s.as(U.E1);
      expect(await refusal(s, "select approve_timesheet_week($1, $2::date, null)", [U.E2.employeeId, monday])).toBe(
        "Only a Partner or Manager can approve or reopen a timesheet week.",
      );
    });
  });

  it("reopening needs a reason and unlocks the entries that aren't billed", async () => {
    await db.asSuper(async (s) => {
      const { id, monday } = await lastWeekEntry(s, U.E2);
      const billed = await lastWeekEntry(s, U.E2);
      const invoice = await s.value<string>("select id from invoices where client_id = $1 limit 1", [C.A]);
      await s.exec("update time_entries set invoice_id = $2, invoiced_at = now() where id = $1", [billed.id, invoice]);
      await s.as(U.P1);
      await s.value("select approve_timesheet_week($1, $2::date, 'Checked')", [U.E2.employeeId, monday]);
      expect(await refusal(s, "select reopen_timesheet_week($1, $2::date, ' ')", [U.E2.employeeId, monday])).toBe("Give a reason for reopening this week.");
      const r = await s.value<{ unlocked: number; billed_still_locked: number }>("select reopen_timesheet_week($1, $2::date, 'Correction')", [U.E2.employeeId, monday]);
      expect(r).toMatchObject({ unlocked: 1, billed_still_locked: 1 });
      expect(await s.value("select locked from time_entries where id = $1", [id])).toBe(false);
      expect(await s.value("select locked from time_entries where id = $1", [billed.id])).toBe(true);
    });
  });

  it("a billed entry is read-only except its billing link, which only Partners and Managers change", async () => {
    await db.asSuper(async (s) => {
      const entry = await s.value<string>("select id from time_entries where employee_id = $1 and task_id = $2", [U.E1.employeeId, F.task("A")]);
      const invoice = await s.value<string>("select id from invoices where client_id = $1 limit 1", [C.A]);
      await s.exec("update time_entries set invoice_id = $2, invoiced_at = now(), locked = true where id = $1", [entry, invoice]);
      await s.as(U.M1);
      expect(await refusal(s, "update time_entries set minutes = 5, description = 'x' where id = $1", [entry])).toMatch(/locked/);
      expect(await s.exec("update time_entries set invoice_id = null, invoiced_at = null, locked = false where id = $1", [entry])).toBe(1);
    });
  });

  it("approvals are visible to the person and to Partners and Managers, and written only through the functions", async () => {
    await db.asSuper(async (s) => {
      const { monday } = await lastWeekEntry(s, U.E1);
      await s.as(U.P1);
      await s.value("select approve_timesheet_week($1, $2::date, null)", [U.E1.employeeId, monday]);
      await s.as(U.E1);
      expect(await s.value("select count(*)::int from timesheet_week_approvals")).toBe(1);
      await s.as(U.E2);
      expect(await s.value("select count(*)::int from timesheet_week_approvals")).toBe(0);
      await s.as(U.M1);
      expect(isDenied(await s.attempt("delete from timesheet_week_approvals"))).toBe(true);
    });
  });
});

// =================================================================================================
// Unbilled time (§7.10)
// =================================================================================================
describe("unbilled time", () => {
  it("Partners and Managers see minutes × billing rate; Employees see nothing", async () => {
    await db.asRole(U.P1, async (s) => {
      const row = await s.one<{ minutes: number; amount: string; entries: number }>("select minutes, amount::text, entries from unbilled_time_by_client where client_id = $1", [C.A]);
      expect(row).toEqual({ minutes: 60, amount: "2000.00", entries: 1 });
    });
    for (const who of [U.E1, U.E2, U.CA]) {
      await db.asRole(who, async (s) => {
        expect(await s.value("select count(*)::int from unbilled_time_entries")).toBe(0);
        expect(await s.value("select count(*)::int from unbilled_time_by_client")).toBe(0);
      });
    }
  });

  it("rounds each entry half-up to the paisa", async () => {
    await db.asSuper(async (s) => {
      await s.exec("update employees set billing_rate_per_hour = 1234.55 where id = $1", [U.E1.employeeId]);
      await s.as(U.M1);
      // 60 minutes at ₹1,234.55 = ₹1,234.55; a 7-minute entry = 144.0308… → 144.03
      await s.as("super");
      await s.exec(
        `insert into time_entries (employee_id, client_id, started_at, ended_at) values ($1, $2, now() - interval '20 minutes', now() - interval '13 minutes')`,
        [U.E1.employeeId, C.A],
      );
      await s.as(U.M1);
      const amounts = await s.rows<{ amount: string }>("select amount::text from unbilled_time_entries where client_id = $1 order by minutes", [C.A]);
      expect(amounts.map((a) => a.amount)).toEqual(["144.03", "1234.55"]);
    });
  });
});

// =================================================================================================
// Job templates and automations
// =================================================================================================
describe("job templates", () => {
  it("creates and edits a template with its steps; a stale save is refused", async () => {
    await db.asRole(U.M1, async (s) => {
      const r = await s.value<{ id: string; updated_at: string }>("select save_job_template($1::jsonb, null)", [
        JSON.stringify({ name: "TDS quarterly", service_type: "tds", default_lead_days: 7, items: [{ title: "Collect challans", offset_days: 10 }, { title: "File 24Q", offset_days: 0 }] }),
      ]);
      const items = await s.rows<{ id: string; title: string }>("select id, title from job_template_items where template_id = $1 order by sort_order", [r.id]);
      expect(items.map((i) => i.title)).toEqual(["Collect challans", "File 24Q"]);
      const r2 = await s.value<{ items: number }>("select save_job_template($1::jsonb, $2)", [
        JSON.stringify({ id: r.id, name: "TDS quarterly", service_type: "tds", items: [{ id: items[1].id, title: "File 24Q and 26Q", offset_days: -1 }, { title: "Issue Form 16A", offset_days: -15 }] }),
        r.updated_at,
      ]);
      expect(r2.items).toBe(2);
      const after = await s.rows<{ id: string; title: string; offset_days: number }>("select id, title, offset_days from job_template_items where template_id = $1 order by sort_order", [r.id]);
      expect(after[0]).toEqual({ id: items[1].id, title: "File 24Q and 26Q", offset_days: -1 });
      expect(after.map((a) => a.title)).toEqual(["File 24Q and 26Q", "Issue Form 16A"]);
      expect(await refusal(s, "select save_job_template($1::jsonb, '2000-01-01T00:00:00Z')", [JSON.stringify({ id: r.id, name: "TDS quarterly", service_type: "tds", items: [{ title: "x" }] })])).toBe(
        "This template was changed by someone else. Reload to see their changes.",
      );
    });
  });

  it("Employees use templates but can't change them", async () => {
    await db.asRole(U.E1, async (s) => {
      expect(await s.value<number>("select count(*)::int from job_templates")).toBeGreaterThan(0);
      expect(await refusal(s, "select save_job_template($1::jsonb, null)", [JSON.stringify({ name: "Mine", service_type: "gst", items: [{ title: "x" }] })])).toBe(
        "Only a Partner or Manager can change job templates.",
      );
    });
  });

  it("a recurring-task automation records who set it up and needs a client and a title", async () => {
    await db.asRole(U.M1, async (s) => {
      const id = await s.value<string>(
        `insert into task_automations (client_id, type, frequency, config, created_by) values ($1, 'recurring_task', 'monthly', $2::jsonb, $3) returning id`,
        [C.A, JSON.stringify({ title: "GSTR-3B: {period}" }), U.P1.id],
      );
      expect(await s.value("select created_by from task_automations where id = $1", [id])).toBe(U.M1.id);
      expect(await refusal(s, `insert into task_automations (client_id, type, frequency, config) values (null, 'recurring_task', 'monthly', '{"title":"x"}')`)).toBe(
        "Choose the client the recurring task is for.",
      );
      await s.as(U.E1);
      expect(isDenied(await s.attempt(`insert into task_automations (client_id, type, frequency, config) values ($1, 'recurring_task', 'monthly', '{"title":"x"}')`, [C.A]))).toBe(true);
    });
  });

  it("the recurring job creates one task per automation and period", async () => {
    await db.asSuper(async (s) => {
      const auto = await s.value<string>(
        `insert into task_automations (client_id, type, frequency, config, created_by) values ($1, 'recurring_task', 'monthly', '{"title":"GSTR-3B: {period}"}', $2) returning id`,
        [C.A, U.M1.id],
      );
      await s.exec("set local role service_role");
      const p = { client_id: C.A, title: "GSTR-3B: Oct 2026", period_label: "Oct 2026", automation_id: auto, created_by: U.M1.id, assigned_employee_id: U.E1.employeeId };
      const first = await createTask(s, p);
      expect(first.existed).toBe(false);
      const again = await createTask(s, p);
      expect(again).toMatchObject({ existed: true, id: null });
      await s.as("super");
      expect(await s.value("select created_by from tasks where id = $1", [first.id])).toBe(U.M1.id);
    });
  });
});

describe("timesheet week rows", () => {
  it("each person keeps their own rows", async () => {
    await db.asRole(U.E1, async (s) => {
      const monday = await mondayAgo(s, 0);
      await s.exec("insert into timesheet_week_rows (employee_id, week_start, task_id) values ($1, $2::date, $3)", [U.E1.employeeId, monday, F.task("A")]);
      expect(await s.value("select client_id from timesheet_week_rows where task_id = $1", [F.task("A")])).toBe(C.A);
      expect(isDenied(await s.attempt("insert into timesheet_week_rows (employee_id, week_start, client_id) values ($1, $2::date, $3)", [U.E2.employeeId, monday, C.A]))).toBe(true);
      expect(isDenied(await s.attempt("insert into timesheet_week_rows (employee_id, week_start, client_id) values ($1, $2::date, $3)", [U.E1.employeeId, monday, C.B]))).toBe(true);
      await s.as(U.E2);
      expect(await s.value("select count(*)::int from timesheet_week_rows")).toBe(0);
    });
  });
});

void SQLSTATE;
