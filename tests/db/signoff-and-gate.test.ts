/**
 * What the end-to-end break-it run found, pinned (migrations 0242 and 0243):
 *  - task sign-off holds for a caller who goes around the app with their own login: acceptance is
 *    the assignee's act, filing work is filed through file_task, Employees don't reopen filed work,
 *    one filing is one record;
 *  - the database API gate: open until armed, then only requests carrying a registered token pass.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { C, U, setupTestDatabase, userMessage, type Session, type TestUser } from "./helpers";

const db = setupTestDatabase("signoff");

type NewTask = {
  status?: string;
  assignee?: TestUser | null;
  acceptance?: "pending" | "accepted" | "declined";
  service?: string | null;
};

let seq = 0;

/** Insert a task as the superuser (no guards), then return to `as`. */
async function newTask(s: Session, t: NewTask, as: TestUser | "super" = "super"): Promise<string> {
  await s.as("super");
  const id = await s.value<string>(
    `insert into tasks (task_number, client_id, title, status, service_type, assigned_employee_id, acceptance_status, accepted_at, created_by)
     values ($1, $2, $3, $4::task_status, $5::service_type, $6, $7::task_acceptance,
             case when $7::task_acceptance = 'accepted' then now() end, $8)
     returning id`,
    [
      `T-7${String(++seq).padStart(5, "0")}`,
      C.A,
      `Sign-off ${seq}`,
      t.status ?? "under_review",
      t.service ?? null,
      t.assignee === undefined ? U.E1.employeeId : t.assignee?.employeeId ?? null,
      t.acceptance ?? "accepted",
      U.P1.id,
    ],
  );
  if (as !== "super") await s.as(as);
  return id;
}

const move = (s: Session, id: string, to: string, reason: string | null = null) =>
  s.value<Record<string, unknown>>("select change_task_status($1, $2::task_status, $3)", [id, to, reason]);
const refusal = async (s: Session, sql: string, params: unknown[]) => userMessage(await s.fails(sql, params));
const acceptance = (s: Session, id: string) =>
  s.one<{ acceptance_status: string; accepted_at: string | null; assigned_employee_id: string | null }>(
    "select acceptance_status::text, accepted_at, assigned_employee_id from tasks where id = $1", [id]);

const GSTR3B = { filing_type: "GSTR-3B", period: "Oct 2026", financial_year: "2026-27", filed_on: "2026-11-10", acknowledgement_no: "AA291126000001" };

describe("acceptance is the assignee's own act (0242)", () => {
  it("a Manager can't keep an acceptance while unassigning their own work, so they can't file it", async () => {
    await db.asSuper(async (s) => {
      const id = await newTask(s, { assignee: U.M1 }, U.M1);
      expect(await refusal(s, "select change_task_status($1, 'filed_done', null)", [id])).toMatch(/Nobody files their own work/);
      await s.exec("update tasks set assigned_employee_id = null, acceptance_status = 'accepted' where id = $1", [id]);
      expect(await acceptance(s, id)).toMatchObject({ acceptance_status: "pending", accepted_at: null, assigned_employee_id: null });
      expect(await refusal(s, "select change_task_status($1, 'filed_done', null)", [id])).toMatch(/waiting for acceptance/);
    });
  });

  it("a Manager or Partner can't accept or decline for someone else, on update or insert", async () => {
    for (const actor of [U.M1, U.P1]) {
      await db.asSuper(async (s) => {
        const pending = await newTask(s, { status: "not_started", acceptance: "pending" }, actor);
        const forged = "Only the person a task is assigned to can accept or decline it.";
        expect(await refusal(s, "update tasks set acceptance_status = 'accepted', accepted_at = now() where id = $1", [pending])).toBe(forged);
        expect(await refusal(s, "update tasks set assigned_employee_id = $2, acceptance_status = 'accepted', accepted_at = now() where id = $1", [pending, U.E2.employeeId])).toBe(forged);
        expect(await refusal(s, "update tasks set declined_by_employee_id = $2, declined_at = now() where id = $1", [pending, U.E1.employeeId])).toBe(forged);
        expect(
          await refusal(s, "insert into tasks (client_id, title, assigned_employee_id, acceptance_status, accepted_at, created_by) values ($1, 'x', $2, 'accepted', now(), $3)", [C.A, U.E1.employeeId, actor.id]),
        ).toMatch(/waits for the person it's assigned to/);
      });
    }
  });

  it("reassigning through the API always waits for the new assignee; the assignee's own answers still work", async () => {
    await db.asSuper(async (s) => {
      const id = await newTask(s, { status: "in_progress" }, U.M1);
      await s.exec("update tasks set assigned_employee_id = $2 where id = $1", [id, U.E2.employeeId]);
      expect(await acceptance(s, id)).toMatchObject({ acceptance_status: "pending", accepted_at: null, assigned_employee_id: U.E2.employeeId });
      await s.as(U.E2);
      await s.value("select respond_to_task($1, true)", [id]);
      expect((await acceptance(s, id)).acceptance_status).toBe("accepted");

      // An Employee accepting their own task by a direct update is the same act (§4.6).
      const own = await newTask(s, { status: "not_started", acceptance: "pending" }, U.E1);
      await s.exec("update tasks set acceptance_status = 'accepted', accepted_at = now() where id = $1", [own]);
      expect((await acceptance(s, own)).acceptance_status).toBe("accepted");
    });
  });
});

describe("filing work is filed through file_task (0242)", () => {
  it("change_task_status alone refuses Filed/Done on a filing service; file_task records it or the reason", async () => {
    await db.asSuper(async (s) => {
      const gst = await newTask(s, { service: "gst" }, U.M1);
      expect(await refusal(s, "select change_task_status($1, 'filed_done', null)", [gst])).toMatch(/Record the filing details/);
      const r = await s.value<Record<string, unknown>>("select file_task($1, null, $2)", [gst, "Nil return: the client filed it themselves"]);
      expect(r).toMatchObject({ to_status: "filed_done", filing_skipped: true });
      expect(await s.value("select filing_skipped_reason from tasks where id = $1", [gst])).toBe("Nil return: the client filed it themselves");

      // The marker is spent: another filing task in the same transaction still needs file_task.
      const tds = await newTask(s, { service: "tds" }, U.M1);
      expect(await refusal(s, "select change_task_status($1, 'filed_done', null)", [tds])).toMatch(/Record the filing details/);

      // Work with nothing to file moves as before.
      const plain = await newTask(s, { service: "bookkeeping" }, U.M1);
      expect((await move(s, plain, "filed_done")).kind).toBe("file");
    });
  });

  it("filing again after a reopen updates the task's record; a new acknowledgement is a new filing; one acknowledgement can't sit on two tasks", async () => {
    await db.asSuper(async (s) => {
      const id = await newTask(s, { service: "gst" }, U.M1);
      const first = await s.value<{ filing_record_id: string }>("select file_task($1, $2::jsonb)", [id, JSON.stringify(GSTR3B)]);
      await s.as(U.M2);
      await move(s, id, "in_progress", "Wrong period ticked on the portal");
      await s.as(U.E1);
      await move(s, id, "under_review");
      await s.as(U.M1);
      const again = await s.value<{ filing_record_id: string }>("select file_task($1, $2::jsonb)", [id, JSON.stringify({ ...GSTR3B, filed_on: "2026-11-11" })]);
      expect(again.filing_record_id).toBe(first.filing_record_id);
      expect(await s.value<string>("select count(*)::text from filing_records where task_id = $1", [id])).toBe("1");
      expect(await s.value<string>("select filed_on::text from filing_records where id = $1", [first.filing_record_id])).toBe("2026-11-11");

      // A revised return has its own acknowledgement number: a filing of its own.
      await s.as(U.M2);
      await move(s, id, "in_progress", "Revised return");
      await s.as(U.E1);
      await move(s, id, "under_review");
      await s.as(U.M1);
      const revised = await s.value<{ filing_record_id: string }>("select file_task($1, $2::jsonb)", [id, JSON.stringify({ ...GSTR3B, acknowledgement_no: "AA291126000777" })]);
      expect(revised.filing_record_id).not.toBe(first.filing_record_id);

      const other = await newTask(s, { service: "gst" }, U.M1);
      expect(await refusal(s, "select file_task($1, $2::jsonb)", [other, JSON.stringify(GSTR3B)])).toMatch(/already recorded on task T-7/);
    });
  });
});

describe("reopening filed work (0242)", () => {
  it("an Employee can't; a Manager can with a reason, and the result names who filed it", async () => {
    await db.asSuper(async (s) => {
      const id = await newTask(s, { service: "bookkeeping" }, U.M1);
      await move(s, id, "filed_done");
      await s.as(U.E1);
      expect(await refusal(s, "select change_task_status($1, 'in_progress', $2)", [id, "oops"])).toBe("This task is filed. Ask a Manager or Partner to reopen it.");
      await s.as(U.M2);
      expect(await refusal(s, "select change_task_status($1, 'in_progress', null)", [id])).toBe("Give a reason for reopening this task.");
      const r = await move(s, id, "in_progress", "Client sent a corrected ledger");
      expect(r).toMatchObject({ kind: "reopen", filed_by_employee_id: U.M1.employeeId, assigned_employee_id: U.E1.employeeId });
    });
  });
});

describe("the database API gate (0243)", () => {
  const token = "a".repeat(64);
  const hash = createHash("sha256").update(token, "utf8").digest("hex");
  const header = (s: Session, value: string | null) =>
    s.exec("select set_config('request.headers', $1, true)", [value === null ? "{}" : JSON.stringify({ "x-taxwise-app": value, accept: "application/json" })]);

  it("is open until armed, then lets through only requests that carry a registered token", async () => {
    await db.asSuper(async (s) => {
      await s.as(U.E1);
      await header(s, null);
      await s.exec("select api_gate()"); // open by default
      expect(await s.value("select api_gate_sees_app()")).toBe(false);

      await s.as("super");
      expect(await refusal(s, "select api_gate_register(null, true)", [])).toMatch(/Register the app's token/);
      expect(await s.value("select api_gate_register($1, true)", [hash])).toMatchObject({ enforce: true, tokens: 1 });
      expect(await s.value<{ enforce: boolean }>("select api_gate_status()")).toMatchObject({ enforce: true, tokens: 1 });

      for (const who of [U.E1, U.M1, U.P1, U.CA, "anon"] as const) {
        await s.as(who);
        await header(s, null);
        const e = await s.fails("select api_gate()");
        expect(e.code, String(typeof who === "string" ? who : who.key)).toBe("PT403");
        expect(e.message).toMatch(/^TWGATE/);
        await header(s, "b".repeat(64));
        expect((await s.fails("select api_gate()")).code).toBe("PT403");
        await header(s, token);
        await s.exec("select api_gate()");
        expect(await s.value("select api_gate_sees_app()")).toBe(true);
      }

      // The firm's own server and the database's own roles are not API logins.
      await s.as("super");
      await header(s, null);
      await s.exec("select api_gate()");

      // Switching it off opens it again; the token stays registered.
      expect(await s.value("select api_gate_register(null, false)")).toMatchObject({ enforce: false, tokens: 1 });
      await s.as(U.E1);
      await header(s, null);
      await s.exec("select api_gate()");
    });
  });

  it("only the service role registers tokens, reads the status or sees the table", async () => {
    await db.asRole(U.P1, async (s) => {
      expect((await s.fails("select api_gate_register($1, true)", [hash])).code).toBe("42501");
      expect((await s.fails("select api_gate_status()")).code).toBe("42501");
      expect((await s.fails("select * from private.api_gate")).code).toBe("42501");
    });
  });

  it("keeps the three newest tokens", async () => {
    await db.asSuper(async (s) => {
      for (const c of ["1", "2", "3", "4"]) await s.value("select api_gate_register($1, null)", [c.repeat(64)]);
      expect(await s.value<string[]>("select token_hashes from private.api_gate")).toEqual(["4".repeat(64), "3".repeat(64), "2".repeat(64)]);
    });
  });
});

describe("a day's time has to be possible (0244)", () => {
  const entry = (s: Session, who: TestUser, start: string, end: string | null, minutes: number | null, source = "manual_range") =>
    s.attempt(
      `insert into time_entries (employee_id, client_id, started_at, ended_at, minutes, entry_source, billable)
       values ($1, $2, $3::timestamptz, $4::timestamptz, coalesce($5::int, 0), $6, true) returning id`,
      [who.employeeId, C.A, start, end, minutes, source],
    );

  it("refuses more than 24 hours in one day and overlapping timed entries; durations and adjacent entries are fine", async () => {
    await db.asRole(U.E1, async (s) => {
      expect((await entry(s, U.E1, "2026-11-02T04:00:00Z", "2026-11-02T08:00:00Z", null)).ok).toBe(true); // 09:30–13:30 IST
      expect((await entry(s, U.E1, "2026-11-02T08:00:00Z", "2026-11-02T10:00:00Z", null)).ok).toBe(true); // adjacent: fine
      const overlap = await entry(s, U.E1, "2026-11-02T07:00:00Z", "2026-11-02T09:00:00Z", null);
      expect(overlap.ok).toBe(false);
      if (!overlap.ok) expect(userMessage(overlap)).toMatch(/overlaps another entry \(02 Nov 09:30 to 13:30\)/);
      // A duration entry carries no real times, so it can't overlap, but it counts towards the day.
      expect((await entry(s, U.E1, "2026-11-02T03:30:00Z", null, 600, "manual_duration")).ok).toBe(true); // 6 h + 10 h = 16 h
      const tooMuch = await entry(s, U.E1, "2026-11-02T03:30:00Z", null, 500, "manual_duration"); // + 8 h 20 min
      expect(tooMuch.ok).toBe(false);
      if (!tooMuch.ok) expect(userMessage(tooMuch)).toMatch(/24 h 20 min on 02 Nov 2026, more than 24 hours in a day/);
      // The next day starts from nothing.
      expect((await entry(s, U.E1, "2026-11-03T03:30:00Z", null, 480, "manual_duration")).ok).toBe(true);
    });
  });

  it("counts a timer stopped after more than 12 hours as 12 hours, and says so", async () => {
    await db.asSuper(async (s) => {
      const id = await s.value<string>(
        `insert into time_entries (employee_id, client_id, started_at, entry_source, description, billable)
         values ($1, $2, now() - interval '30 hours', 'timer', 'GSTR-3B working', true) returning id`,
        [U.E2.employeeId, C.B],
      );
      await s.as(U.E2);
      await s.value("select stop_timer(null)");
      const row = await s.one<{ minutes: number; description: string; hours: string }>(
        "select minutes, description, (extract(epoch from (ended_at - started_at)) / 3600)::text as hours from time_entries where id = $1", [id]);
      expect(row.minutes).toBe(720);
      expect(Number(row.hours)).toBe(12);
      expect(row.description).toBe("GSTR-3B working (Timer left running: counted as 12 hours. Correct it if the work was shorter or longer.)");
    });
  });
});

describe("the tribunal appeal period (0245)", () => {
  it("counts two months from the end of the order's month since 1 October 2024, and 60 days before", async () => {
    await db.asRole(U.M1, async (s) => {
      const last = (forum: string, order: string) => s.value<string>("select notice_appeal_limitation($1, $2::date)::text", [forum, order]);
      expect(await last("income_tax_tribunal", "2025-12-31")).toBe("2026-02-28");
      expect(await last("income_tax_tribunal", "2026-10-01")).toBe("2026-12-31");
      expect(await last("income_tax_tribunal", "2027-12-15")).toBe("2028-02-29");
      expect(await last("income_tax_tribunal", "2024-08-20")).toBe("2024-10-19"); // the 60-day rule in force then
      // The other forums are unchanged.
      expect(await last("income_tax_first_appeal", "2026-10-01")).toBe("2026-10-31");
      expect(await last("gst_first_appeal", "2026-11-30")).toBe("2027-02-28");
    });
  });
});
