/**
 * Wave A review fixes (migration 0141 and later): the database half of what the review changed.
 *
 *   - An Employee holding a task on a client outside their scope (assigned, or the named reviewer)
 *     writes that task's timeline entries (task_*), never anything else there, and still can't read
 *     the client's timeline (§0.2, §4.1).
 *   - §18.3 Partner 4: a CBDT extension moves the matching unfiled deadlines, citing the circular,
 *     and leaves filed ones alone; only a Partner applies one (apply_due_date_override, 0050).
 */
import { describe, expect, it } from "vitest";
import { C, U, isDenied, setupTestDatabase, type Session, type TestUser } from "./helpers";

const db = setupTestDatabase("review-wave-a");

let seq = 0;

/** A live task on `client` for `assignee` (and optionally `reviewer`), inserted as the superuser. */
async function taskOn(s: Session, client: string, assignee: TestUser | null, reviewer: TestUser | null = null): Promise<string> {
  await s.as("super");
  return s.value<string>(
    `insert into tasks (task_number, client_id, title, status, assigned_employee_id, reviewer_employee_id, acceptance_status, created_by)
     values ($1, $2, 'Out-of-scope task', 'in_progress', $3, $4, 'accepted', $5) returning id`,
    [`T-R${String(++seq).padStart(5, "0")}`, client, assignee?.employeeId ?? null, reviewer?.employeeId ?? null, U.P1.id],
  );
}

const insertEvent = (s: Session, client: string, eventType: string, performedBy: string) =>
  s.attempt(`insert into client_timeline_events (client_id, event_type, title, performed_by) values ($1, $2, 'Review test', $3)`, [client, eventType, performedBy]);

describe("timeline entries for a task on a client outside the Employee's scope (0141)", () => {
  it("E3 (no clients) can't see client A, and without a task can't write to its timeline", async () => {
    await db.asRole(U.E3, async (s) => {
      expect(await s.value<boolean>("select can_see_client($1)", [C.A])).toBe(false);
      expect(isDenied(await insertEvent(s, C.A, "task_accepted", U.E3.id))).toBe(true);
    });
  });

  it("assigned a task on A, E3 writes its task_* entries there, and nothing else", async () => {
    await db.asRole(U.E3, async (s) => {
      await taskOn(s, C.A, U.E3);
      await s.as(U.E3);
      expect(await s.value<boolean>("select can_see_client($1)", [C.A])).toBe(false);
      expect((await insertEvent(s, C.A, "task_accepted", U.E3.id)).ok).toBe(true);
      expect((await insertEvent(s, C.A, "task_status_changed", U.E3.id)).ok).toBe(true);
      // Not a task event, a money-side event, or one in someone else's name.
      expect(isDenied(await insertEvent(s, C.A, "note_added", U.E3.id))).toBe(true);
      expect(isDenied(await insertEvent(s, C.A, "invoice_sent", U.E3.id))).toBe(true);
      expect(isDenied(await insertEvent(s, C.A, "task_accepted", U.E1.id))).toBe(true);
      // The client's timeline stays out of reach.
      expect(await s.value<number>("select count(*)::int from client_timeline_events where client_id = $1", [C.A])).toBe(0);
    });
  });

  it("the named reviewer of a task on A writes its entries too", async () => {
    await db.asRole(U.E3, async (s) => {
      await taskOn(s, C.A, U.E1, U.E3);
      await s.as(U.E3);
      expect((await insertEvent(s, C.A, "task_status_changed", U.E3.id)).ok).toBe(true);
    });
  });

  it("a deleted task or one on a client in the recycle bin opens nothing", async () => {
    await db.asRole(U.E3, async (s) => {
      const t = await taskOn(s, C.A, U.E3);
      await s.exec("update tasks set deleted_at = now() where id = $1", [t]);
      await s.as(U.E3);
      expect(isDenied(await insertEvent(s, C.A, "task_status_changed", U.E3.id))).toBe(true);

      await taskOn(s, C.Z, U.E3);
      await s.as(U.E3);
      expect(isDenied(await insertEvent(s, C.Z, "task_status_changed", U.E3.id))).toBe(true);
    });
  });

  it("staff_task_client_ids answers nothing for a portal user or anon", async () => {
    await db.asRole(U.CA, async (s) => {
      expect(await s.value<number>("select count(*)::int from staff_task_client_ids()")).toBe(0);
    });
    await db.asAnon(async (s) => {
      expect(isDenied(await s.attempt("select * from staff_task_client_ids()"))).toBe(true);
    });
  });
});

describe("§18.3 Partner 4: a CBDT extension moves the matching unfiled deadlines", () => {
  async function setUp(s: Session) {
    await s.as("super");
    const ins = (status: string, workflow: string, due: string) =>
      s.value<string>(
        `insert into compliance_events (client_id, type, form_code, title, due_date, source, is_statutory, financial_year, filing_period, rule_code, status, workflow_status, dedupe_key)
         values ($1, 'itr', 'ITR (audit)', 'Income tax return (audit case)', $2::date, 'statutory_engine', true, '2026-27', 'AY 2027-28', 'ITR_AUDIT',
                 $3::compliance_status, $4::compliance_workflow, $5) returning id`,
        [C.A, due, status, workflow, `${C.A}|ITR_AUDIT|AY 2027-28|${status}|${workflow}`],
      );
    const pending = await ins("pending", "in_progress", "2027-10-31");
    const filed = await ins("completed", "filed", "2027-10-31");
    const override = await s.value<string>(
      `insert into due_date_overrides (rule_code, period_label, original_due, extended_due, scope, source_ref)
       values ('ITR_AUDIT', 'AY 2027-28', '2027-10-31', '2027-12-10', 'Returns of audit cases', 'CBDT Circular 15/2027 dated 20 Oct 2027') returning id`,
    );
    return { pending, filed, override };
  }

  it("moves the unfiled event, keeps the original date, links the extension and cites the circular", async () => {
    await db.asRole(U.P1, async (s) => {
      const { pending, filed, override } = await setUp(s);
      await s.as(U.P1);
      expect(await s.value<number>("select apply_due_date_override($1)", [override])).toBe(1);
      const moved = await s.one<{ due: string; original: string; override_id: string }>(
        "select due_date::text as due, original_due_date::text as original, override_id from compliance_events where id = $1",
        [pending],
      );
      expect(moved).toEqual({ due: "2027-12-10", original: "2027-10-31", override_id: override });
      expect(await s.value<string>("select due_date::text from compliance_events where id = $1", [filed])).toBe("2027-10-31");
      const line = await s.value<string>("select description from activity_logs where entity_id = $1 and action = 'due_date_extended'", [pending]);
      expect(line).toContain("CBDT Circular 15/2027");
      // Running it again moves nothing more.
      expect(await s.value<number>("select apply_due_date_override($1)", [override])).toBe(0);
    });
  });

  it("only a Partner applies an extension", async () => {
    await db.asRole(U.M1, async (s) => {
      const { override } = await setUp(s);
      await s.as(U.M1);
      const err = await s.fails("select apply_due_date_override($1)", [override]);
      expect(err.message).toContain("Only a Partner");
    });
  });
});
