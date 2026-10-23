/**
 * Wave A integration (0100–0140): what the scheduled jobs write with the service role passes the
 * modules' guards, the jobs' run log is the service role's to write and the Partner's to read, the
 * firm's new-client notify channels hold only known values, and every table and view diagnostics
 * checks for exists (§7.24, §8, §7.3.2 step 5).
 */
import { describe, expect, it } from "vitest";
import { C, SQLSTATE, U, setupTestDatabase, type Session } from "./helpers";
import { fid } from "./fixtures";
import { EXPECTED_TABLES, EXPECTED_VIEWS } from "@/server/diagnostics-relations";

const db = setupTestDatabase("integration");

async function asService(s: Session) {
  await s.as("super");
  await s.exec("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)");
  await s.exec("set local role service_role");
}

describe("the reminders job's writes (service role)", () => {
  it("marks a compliance deadline reminded without tripping the workflow guard", async () => {
    await db.asSuper(async (s) => {
      await asService(s);
      const id = fid("ce:A:stat");
      const n = await s.value<number>("with u as (update compliance_events set reminder_sent_at = now() where id = $1 and reminder_sent_at is null returning 1) select count(*)::int from u", [id]);
      expect(n).toBe(1);
      await s.as("super");
      const [row] = await s.rows<{ status: string; workflow_status: string; reminder_sent_at: string | null }>("select status, workflow_status, reminder_sent_at from compliance_events where id = $1", [id]);
      expect(row.status).toBe("pending");
      expect(row.reminder_sent_at).not.toBeNull();
    });
  });

  it("restarts a document request's cadence and counts the reminder", async () => {
    await db.asSuper(async (s) => {
      await asService(s);
      const id = fid("docreq:A");
      const n = await s.value<number>(
        "with u as (update document_requests set last_reminded_at = now(), reminder_count = reminder_count + 1 where id = $1 and reminder_count = 0 returning 1) select count(*)::int from u",
        [id],
      );
      expect(n).toBe(1);
      await s.as("super");
      const [row] = await s.rows<{ status: string; reminder_count: number }>("select status, reminder_count from document_requests where id = $1", [id]);
      expect(row).toEqual({ status: "open", reminder_count: 1 });
    });
  });
});

describe("job_runs (§8, §7.24)", () => {
  it("the service role opens and closes a run; Partners read it; nobody else writes it", async () => {
    await db.asSuper(async (s) => {
      await asService(s);
      const id = await s.value<string>("insert into job_runs (name, status) values ('reminders', 'running') returning id");
      await s.exec("update job_runs set finished_at = now(), status = 'succeeded', counts = '{\"failed\": 0}'::jsonb where id = $1", [id]);
      await s.as(U.P1);
      expect(await s.value<string>("select status from job_runs where id = $1", [id])).toBe("succeeded");
      await s.as(U.M1);
      expect(await s.value<number>("select count(*)::int from job_runs where id = $1", [id])).toBe(0);
      await s.as(U.P1);
      const e = await s.fails("insert into job_runs (name, status) values ('reminders', 'running')");
      expect(e.code).toBe(SQLSTATE.insufficientPrivilege);
    });
  });
});

describe("firm_settings.client_notify_channels (Settings → Reminders)", () => {
  it("a Partner saves email, WhatsApp and portal; anything else is refused", async () => {
    await db.asRole(U.P1, async (s) => {
      await s.exec("update firm_settings set client_notify_channels = '{email,portal}' where id = 1");
      expect(await s.value<string[]>("select client_notify_channels from firm_settings where id = 1")).toEqual(["email", "portal"]);
      const e = await s.fails("update firm_settings set client_notify_channels = '{email,sms}' where id = 1");
      expect(e.code).toBe(SQLSTATE.checkViolation);
    });
  });

  it("a Manager can't change it", async () => {
    await db.asRole(U.M1, async (s) => {
      const n = await s.value<number>("with u as (update firm_settings set client_notify_channels = '{portal}' where id = 1 returning 1) select count(*)::int from u");
      expect(n).toBe(0);
    });
  });
});

describe("diagnostics' expected relations (§7.24)", () => {
  it("every table and view the Tables check reads exists", async () => {
    await db.asSuper(async (s) => {
      const rows = await s.rows<{ relname: string; relkind: string }>(
        "select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')",
      );
      const tables = new Set(rows.filter((r) => r.relkind === "r" || r.relkind === "p").map((r) => r.relname));
      const views = new Set(rows.filter((r) => r.relkind === "v" || r.relkind === "m").map((r) => r.relname));
      expect(EXPECTED_TABLES.filter((t) => !tables.has(t))).toEqual([]);
      expect(EXPECTED_VIEWS.filter((v) => !views.has(v))).toEqual([]);
    });
  });

  it("clients covered by the viewer show through covers_in_force (My clients ?covering=1)", async () => {
    await db.asSuper(async (s) => {
      await s.exec(
        `insert into client_covers (kind, client_id, absent_employee_id, cover_employee_id, ends_at, reason, granted_by)
         values ('client', $1, $2, $3, now() + interval '1 day', 'leave', $4)`,
        [C.A, U.E1.employeeId, U.E3.employeeId, U.P1.id],
      );
      await s.as(U.E3);
      const covers = await s.rows<{ client_id: string }>("select client_id from covers_in_force where cover_employee_id = $1", [U.E3.employeeId]);
      expect(covers.map((c) => c.client_id)).toEqual([C.A]);
      expect(await s.value<number>("select count(*)::int from clients_list where id = $1", [C.A])).toBe(1);
    });
  });
});
