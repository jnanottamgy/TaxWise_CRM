/**
 * Compliance module (§7.7, §7.6.5, §5.6, §6.7, §4.1): migrations 0125–0127.
 *   - compliance_events_guard: status follows the workflow (Filed/Completed → completed, a reopen →
 *     pending), so a filed return is never "overdue"; Employees can't file, reopen or add closed
 *     deadlines; a filed deadline can't be cancelled; a deadline never moves to another client;
 *   - upsert_compliance_events: idempotent by dedupe_key, rewrites only flagged unfiled rows of the
 *     same source (never for an Employee), never touches filed rows, refuses foreign or manual rows,
 *     clears the reminder stamp and writes a history line when the date moves; end to end with the
 *     seeded rules, a Karnataka QRMP client's GSTR-3B lands on the 22nd (§18.3 Partner 3);
 *   - change_compliance_workflow: no no-ops, Filed only by Partners/Managers and only with a filing
 *     record for a client's statutory deadline, reopening needs a reason, optimistic concurrency;
 *   - record_compliance_filing: creates or links the filing record, links a UDIN, marks Filed,
 *     refuses Employees, future dates, foreign documents and UDINs;
 *   - filings_grid: Partner/Manager only, pages clients, filters by owner / search / status, and
 *     the summary covers every client;
 *   - compliance_coverage: upcoming statutory deadlines only, under RLS.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { C, F, SQLSTATE, U, fid, setupTestDatabase, userMessage, type Session } from "./helpers";
import { todayIST } from "@/lib/domain/fy";
import {
  CALENDAR_DEFAULTS,
  generateEvents,
  parseDueDateOverrideRow,
  parseDueDateRuleRow,
  toComplianceEventInsert,
  type DueDateOverride,
  type DueDateOverrideRow,
  type DueDateRule,
  type DueDateRuleRow,
} from "@/lib/domain/statutory-calendar";

const db = setupTestDatabase("compliance");

const STAT_A = fid("ce:A:stat");
const OPS_A = fid("ce:A:ops");
const STAT_B = fid("ce:B:stat");

type Row = Record<string, unknown>;

function row(clientId: string, key: string, overrides: Row = {}): Row {
  return {
    client_id: clientId,
    type: "gstr_3b",
    form_code: "GSTR-3B",
    title: `GSTR-3B (monthly) for ${key}`,
    description: null,
    financial_year: "2026-27",
    filing_period: key,
    period_start: "2026-10-01",
    period_end: "2026-10-31",
    due_date: "2026-11-20",
    is_statutory: true,
    source: "statutory_engine",
    reminder_days: 7,
    notes: null,
    dedupe_key: `${clientId}|GSTR-3B|${key}`,
    rule_code: "GSTR3B_MONTHLY",
    source_ref: "CGST Rules r.61",
    original_due_date: null,
    override_id: null,
    agm_date: null,
    is_provisional: false,
    ...overrides,
  };
}

async function upsert(s: Session, rows: Row[]) {
  return s.value<{ inserted: number; updated: number; locked: number; unchanged: number; skipped: number }>(
    "select upsert_compliance_events($1::jsonb)",
    [JSON.stringify(rows)],
  );
}

async function event(s: Session, id: string) {
  return s.one<{ status: string; workflow_status: string; completed_at: string | null; due_date: string; updated_at: string; reminder_sent_at: string | null }>(
    "select status, workflow_status, completed_at, to_char(due_date, 'YYYY-MM-DD') as due_date, updated_at, reminder_sent_at from compliance_events where id = $1",
    [id],
  );
}

// -------------------------------------------------------------------------------------------------
// The guard trigger
// -------------------------------------------------------------------------------------------------

describe("compliance_events_guard", () => {
  it("status follows the workflow, so a filed return is never overdue", async () => {
    await db.asRole(U.M1, async (s) => {
      await s.exec("update compliance_events set due_date = today_ist() - 10 where id = $1", [STAT_A]);
      expect(await s.value("select is_overdue from compliance_events_view where id = $1", [STAT_A])).toBe(true);

      await s.exec("update compliance_events set workflow_status = 'filed' where id = $1", [STAT_A]);
      const filed = await event(s, STAT_A);
      expect(filed.status).toBe("completed");
      expect(filed.completed_at).not.toBeNull();
      expect(await s.value("select is_overdue from compliance_events_view where id = $1", [STAT_A])).toBe(false);

      await s.exec("update compliance_events set workflow_status = 'in_progress' where id = $1", [STAT_A]);
      const reopened = await event(s, STAT_A);
      expect(reopened.status).toBe("pending");
      expect(reopened.completed_at).toBeNull();
      expect(await s.value("select is_overdue from compliance_events_view where id = $1", [STAT_A])).toBe(true);
    });
  });

  it("setting the status to completed directly closes the workflow too", async () => {
    await db.asRole(U.P1, async (s) => {
      await s.exec("update compliance_events set status = 'completed' where id = $1", [OPS_A]);
      const e = await event(s, OPS_A);
      expect(e.workflow_status).toBe("completed");
      expect(e.completed_at).not.toBeNull();
    });
  });

  it("an Employee moves their client's deadline along but can't file, reopen or add a closed one", async () => {
    await db.asRole(U.E1, async (s) => {
      expect(await s.exec("update compliance_events set workflow_status = 'under_review' where id = $1", [STAT_A])).toBe(1);

      const file = await s.fails("update compliance_events set workflow_status = 'filed' where id = $1", [STAT_A]);
      expect(file.code).toBe(SQLSTATE.raiseException);
      expect(userMessage(file)).toMatch(/Only a Partner or Manager can mark a deadline filed/);

      const closed = await s.fails(
        "insert into compliance_events (client_id, type, title, due_date, source, workflow_status) values ($1, 'custom', 'Closed', today_ist(), 'manual', 'completed')",
        [C.A],
      );
      expect(userMessage(closed)).toMatch(/already filed or closed/);

      // Another client's deadline isn't theirs to touch at all.
      expect(await s.exec("update compliance_events set notes = 'x' where id = $1", [STAT_B])).toBe(0);

      await s.as(U.M1);
      await s.exec("update compliance_events set workflow_status = 'filed' where id = $1", [STAT_A]);
      await s.as(U.E1);
      const reopen = await s.fails("update compliance_events set workflow_status = 'in_progress' where id = $1", [STAT_A]);
      expect(userMessage(reopen)).toMatch(/Only a Partner or Manager can reopen/);
    });
  });

  it("a filed deadline can't be cancelled, and no deadline moves to another client", async () => {
    await db.asRole(U.P1, async (s) => {
      await s.exec("update compliance_events set workflow_status = 'filed' where id = $1", [STAT_A]);
      const cancel = await s.fails("update compliance_events set status = 'cancelled' where id = $1", [STAT_A]);
      expect(userMessage(cancel)).toMatch(/filed deadline can't be cancelled/);

      const move = await s.fails("update compliance_events set client_id = $1 where id = $2", [C.B, OPS_A]);
      expect(userMessage(move)).toMatch(/can't be moved to another client/);
    });
  });
});

// -------------------------------------------------------------------------------------------------
// upsert_compliance_events
// -------------------------------------------------------------------------------------------------

describe("upsert_compliance_events", () => {
  it("inserts new keys once and is idempotent", async () => {
    await db.asRole(U.M1, async (s) => {
      const rows = [row(C.A, "Oct 2026"), row(C.A, "Nov 2026", { period_start: "2026-11-01", period_end: "2026-11-30", due_date: "2026-12-20" })];
      expect(await upsert(s, rows)).toEqual({ inserted: 2, updated: 0, locked: 0, unchanged: 0, skipped: 0 });
      expect(await upsert(s, rows)).toEqual({ inserted: 0, updated: 0, locked: 0, unchanged: 2, skipped: 0 });
      expect(await s.value("select count(*)::int from compliance_events where dedupe_key like $1", [`${C.A}|GSTR-3B|%`])).toBe(2);
    });
  });

  it("rewrites a flagged unfiled row, clears its reminder stamp and writes the history line", async () => {
    await db.asRole(U.M1, async (s) => {
      await upsert(s, [row(C.A, "Oct 2026", { is_provisional: true, notes: "Provisional: dated from an AGM on 30 Sep 2026." })]);
      const id = await s.value<string>("select id from compliance_events where dedupe_key = $1", [`${C.A}|GSTR-3B|Oct 2026`]);
      await s.exec("update compliance_events set reminder_sent_at = now(), description = 'kept?' where id = $1", [id]);

      const r = await upsert(s, [row(C.A, "Oct 2026", { due_date: "2026-11-25", description: "Held on 10 Sep 2026.", update_reason: "The AGM date was entered." })]);
      expect(r.updated).toBe(1);
      const e = await s.one<{ due: string; reminder_sent_at: string | null; notes: string | null; description: string | null; is_provisional: boolean }>(
        "select to_char(due_date, 'YYYY-MM-DD') as due, reminder_sent_at, notes, description, is_provisional from compliance_events where id = $1",
        [id],
      );
      expect(e).toEqual({ due: "2026-11-25", reminder_sent_at: null, notes: null, description: "Held on 10 Sep 2026.", is_provisional: false });
      const log = await s.one<{ action: string; description: string }>(
        "select action, description from activity_logs where entity_type = 'compliance_event' and entity_id = $1",
        [id],
      );
      expect(log.action).toBe("due_date_regenerated");
      expect(log.description).toMatch(/moved from 20 Nov 2026 to 25 Nov 2026\. The AGM date was entered\./);
    });
  });

  it("keeps a person's notes when it rewrites the date", async () => {
    await db.asRole(U.P1, async (s) => {
      await upsert(s, [row(C.A, "Dec 2026", { due_date: "2027-01-20" })]);
      await s.exec("update compliance_events set notes = 'Client travels in January' where dedupe_key = $1", [`${C.A}|GSTR-3B|Dec 2026`]);
      await upsert(s, [row(C.A, "Dec 2026", { due_date: "2027-01-22", update_reason: "A different rule now applies to this client." })]);
      expect(await s.value("select notes from compliance_events where dedupe_key = $1", [`${C.A}|GSTR-3B|Dec 2026`])).toBe("Client travels in January");
    });
  });

  it("never touches a filed, completed or cancelled row, nor one from another source", async () => {
    await db.asRole(U.M1, async (s) => {
      await upsert(s, [row(C.A, "Oct 2026"), row(C.A, "Nov 2026", { due_date: "2026-12-20" })]);
      await s.exec("update compliance_events set workflow_status = 'filed' where dedupe_key = $1", [`${C.A}|GSTR-3B|Oct 2026`]);
      const r = await upsert(s, [
        row(C.A, "Oct 2026", { due_date: "2026-11-30", update_reason: "A different rule now applies to this client." }),
        row(C.A, "Nov 2026", { source: "ops_template", due_date: "2026-12-30", update_reason: "A different rule now applies to this client." }),
      ]);
      expect(r).toMatchObject({ updated: 0, locked: 1, unchanged: 1 });
      expect(await s.value("select to_char(due_date, 'YYYY-MM-DD') from compliance_events where dedupe_key = $1", [`${C.A}|GSTR-3B|Oct 2026`])).toBe("2026-11-20");
    });
  });

  it("refuses rows that don't belong to their client, manual rows and a non-list", async () => {
    await db.asRole(U.M1, async (s) => {
      const foreign = await s.fails("select upsert_compliance_events($1::jsonb)", [JSON.stringify([row(C.A, "Oct 2026", { dedupe_key: `${C.B}|GSTR-3B|Oct 2026` })])]);
      expect(userMessage(foreign)).toMatch(/doesn't belong to its client/);
      const manual = await s.fails("select upsert_compliance_events($1::jsonb)", [JSON.stringify([row(C.A, "Oct 2026", { source: "manual" })])]);
      expect(userMessage(manual)).toMatch(/Only the statutory calendar and ops templates/);
      const notList = await s.fails("select upsert_compliance_events($1::jsonb)", [JSON.stringify({ a: 1 })]);
      expect(userMessage(notList)).toMatch(/must be a list/);
    });
  });

  it("an Employee plans new deadlines for their own client but never rewrites dates", async () => {
    await db.asRole(U.E1, async (s) => {
      expect((await upsert(s, [row(C.A, "Jan 2027", { due_date: "2027-02-20" })])).inserted).toBe(1);
      const r = await upsert(s, [row(C.A, "Jan 2027", { due_date: "2027-02-22", update_reason: "A different rule now applies to this client." })]);
      expect(r).toMatchObject({ updated: 0, skipped: 1 });
      const other = await s.fails("select upsert_compliance_events($1::jsonb)", [JSON.stringify([row(C.B, "Jan 2027")])]);
      expect(other.code).toBe(SQLSTATE.insufficientPrivilege);
    });
  });

  it("a portal user can't plan deadlines", async () => {
    await db.asRole(U.CA, async (s) => {
      const e = await s.fails("select upsert_compliance_events($1::jsonb)", [JSON.stringify([row(C.A, "Jan 2027")])]);
      expect(userMessage(e)).toMatch(/Only staff can plan deadlines/);
    });
  });

  it("the job (no API role) plans for every client", async () => {
    await db.asSuper(async (s) => {
      const r = await upsert(s, [row(C.A, "Feb 2027", { due_date: "2027-03-20" }), row(C.B, "Feb 2027", { due_date: "2027-03-20" })]);
      expect(r.inserted).toBe(2);
    });
  });

  it("end to end: a Karnataka QRMP client's GSTR-3B is due on the 22nd and the plan is idempotent (§18.3 Partner 3)", async () => {
    await db.asRole(U.P1, async (s) => {
      await s.exec("update clients set gst_registration = 'registered', gstin = '29AAXFT1811B1Z3', pan = 'AAXFT1811B', state_code = '29', gst_scheme = 'qrmp' where id = $1", [C.B]);
      const ruleRows = await s.rows<DueDateRuleRow>(
        "select code, title, compliance_type::text, form_code, applies_to, frequency::text, rule, reminder_days, to_char(effective_from, 'YYYY-MM-DD') as effective_from, to_char(effective_to, 'YYYY-MM-DD') as effective_to, source_ref, verified, is_active from due_date_rules where is_active",
      );
      const rules = ruleRows.map(parseDueDateRuleRow).filter((r): r is { ok: true; value: DueDateRule } => r.ok).map((r) => r.value);
      const overrideRows = await s.rows<DueDateOverrideRow>(
        "select id, rule_code, period_label, to_char(original_due, 'YYYY-MM-DD') as original_due, to_char(extended_due, 'YYYY-MM-DD') as extended_due, scope, source_ref from due_date_overrides",
      );
      const overrides = overrideRows.map(parseDueDateOverrideRow).filter((r): r is { ok: true; value: DueDateOverride } => r.ok).map((r) => r.value);
      expect(rules.length).toBeGreaterThan(20);

      const events = generateEvents(
        { id: C.B, serviceTypes: ["gst", "income_tax"], entityType: "pvt_ltd", gstScheme: "qrmp", stateCode: "29", turnover: null, taxAuditApplicable: null },
        rules,
        overrides,
        { today: todayIST(), params: CALENDAR_DEFAULTS },
      );
      const qrmp3b = events.filter((e) => e.ruleCode === "GSTR3B_QRMP");
      expect(qrmp3b.length).toBeGreaterThan(0);
      for (const e of qrmp3b) expect(e.dueDate.slice(8)).toBe("22");

      const rows = events.map((e) => ({ ...toComplianceEventInsert(e), description: e.notes, notes: null }));
      const first = await upsert(s, rows);
      expect(first.inserted).toBe(rows.length);
      const second = await upsert(s, rows);
      expect(second).toMatchObject({ inserted: 0, unchanged: rows.length });
    });
  });
});

// -------------------------------------------------------------------------------------------------
// change_compliance_workflow
// -------------------------------------------------------------------------------------------------

describe("change_compliance_workflow", () => {
  const change = (s: Session, id: string, to: string, reason: string | null = null, expected: string | null = null) =>
    s.value<{ from: string; to: string; status: string; updated_at: string }>(
      "select change_compliance_workflow($1, $2::compliance_workflow, $3, $4::timestamptz)",
      [id, to, reason, expected],
    );

  it("moves along the workflow, records history, and refuses a no-op", async () => {
    await db.asRole(U.E1, async (s) => {
      const r = await change(s, STAT_A, "documents_awaited");
      expect(r).toMatchObject({ from: "not_started", to: "documents_awaited", status: "pending" });
      const log = await s.one<{ description: string }>("select description from activity_logs where entity_id = $1 and action = 'workflow_changed'", [STAT_A]);
      expect(log.description).toBe("Not started → Documents awaited.");
      const noop = await s.fails("select change_compliance_workflow($1, 'documents_awaited')", [STAT_A]);
      expect(userMessage(noop)).toBe("It is already Documents awaited.");
    });
  });

  it("Filed is for Partners and Managers, and needs the filing record on a client's statutory deadline", async () => {
    await db.asRole(U.E1, async (s) => {
      const e = await s.fails("select change_compliance_workflow($1, 'filed')", [STAT_A]);
      expect(userMessage(e)).toMatch(/Only a Partner or Manager can mark a deadline filed/);
    });
    await db.asRole(U.M1, async (s) => {
      const e = await s.fails("select change_compliance_workflow($1, 'filed')", [STAT_A]);
      expect(userMessage(e)).toMatch(/Record the filing details first/);
      // An internal (non-statutory) step closes without a filing record.
      expect((await change(s, OPS_A, "completed")).status).toBe("completed");
      // With a filing record linked, Filed goes through.
      await s.exec("insert into filing_records (client_id, financial_year, filing_type, compliance_event_id) values ($1, '2026-27', 'GSTR-3B', $2)", [C.A, STAT_A]);
      expect((await change(s, STAT_A, "filed")).status).toBe("completed");
    });
  });

  it("reopening needs a reason; a stale edit and a cancelled deadline are refused", async () => {
    await db.asRole(U.M1, async (s) => {
      await s.exec("insert into filing_records (client_id, financial_year, filing_type, compliance_event_id) values ($1, '2026-27', 'GSTR-3B', $2)", [C.A, STAT_A]);
      await change(s, STAT_A, "filed");
      const noReason = await s.fails("select change_compliance_workflow($1, 'in_progress')", [STAT_A]);
      expect(userMessage(noReason)).toBe("Say why you are reopening it.");
      const r = await change(s, STAT_A, "in_progress", "Figures corrected by the client");
      expect(r.status).toBe("pending");
      expect(await s.value("select description from activity_logs where entity_id = $1 and action = 'reopened'", [STAT_A])).toBe("Filed → In progress: Figures corrected by the client");

      const stale = await s.fails("select change_compliance_workflow($1, 'under_review', null, $2::timestamptz)", [STAT_A, "2020-01-01T00:00:00Z"]);
      expect(userMessage(stale)).toMatch(/changed by someone else/);
      const current = (await event(s, STAT_A)).updated_at;
      expect((await change(s, STAT_A, "under_review", null, new Date(current).toISOString())).to).toBe("under_review");

      await s.exec("update compliance_events set status = 'cancelled' where id = $1", [OPS_A]);
      const cancelled = await s.fails("select change_compliance_workflow($1, 'in_progress')", [OPS_A]);
      expect(userMessage(cancelled)).toMatch(/cancelled\. Restore it/);
    });
  });

  it("a deadline the caller can't see doesn't exist for them", async () => {
    await db.asRole(U.E1, async (s) => {
      const e = await s.fails("select change_compliance_workflow($1, 'in_progress')", [STAT_B]);
      expect(userMessage(e)).toMatch(/no longer exists/);
    });
  });
});

// -------------------------------------------------------------------------------------------------
// record_compliance_filing
// -------------------------------------------------------------------------------------------------

describe("record_compliance_filing", () => {
  const filing = (overrides: Row = {}) =>
    JSON.stringify({ filing_type: "GSTR-3B", period: "Oct 2026", financial_year: "2026-27", filed_on: todayIST(), acknowledgement_no: "AA291026123456X", service_type: "gst", ...overrides });

  it("creates the filing record, links the task and marks the deadline Filed", async () => {
    await db.asRole(U.M1, async (s) => {
      await s.exec("update compliance_events set task_id = $1, due_date = today_ist() - 2 where id = $2", [F.task("A"), STAT_A]);
      const r = await s.value<{ filing_record_id: string; workflow_status: string; status: string; on_time: boolean }>(
        "select record_compliance_filing($1, $2::jsonb)",
        [STAT_A, filing({ document_id: F.docPrivate("A") })],
      );
      expect(r).toMatchObject({ workflow_status: "filed", status: "completed", on_time: false });
      const fr = await s.one<{ compliance_event_id: string; task_id: string; acknowledgement_no: string; document_id: string; created_by: string }>(
        "select compliance_event_id, task_id, acknowledgement_no, document_id, created_by from filing_records where id = $1",
        [r.filing_record_id],
      );
      expect(fr).toEqual({ compliance_event_id: STAT_A, task_id: F.task("A"), acknowledgement_no: "AA291026123456X", document_id: F.docPrivate("A"), created_by: U.M1.id });
      const log = await s.value<string>("select description from activity_logs where entity_id = $1 and action = 'filed'", [STAT_A]);
      expect(log).toMatch(/^Filed on .+ · acknowledgement AA291026123456X · 2 days late\.$/);
    });
  });

  it("marks Completed when asked, and links a UDIN of the same client", async () => {
    await db.asRole(U.P1, async (s) => {
      const udin = await s.value<string>("select id from udin_records where client_id = $1", [C.A]);
      const r = await s.value<{ filing_record_id: string; workflow_status: string }>(
        "select record_compliance_filing($1, $2::jsonb)",
        [STAT_A, filing({ complete: true, udin_record_id: udin })],
      );
      expect(r.workflow_status).toBe("completed");
      expect(await s.value("select filing_record_id from udin_records where id = $1", [udin])).toBe(r.filing_record_id);

      const otherUdin = await s.value<string>("select id from udin_records where client_id = $1", [C.B]);
      const e = await s.fails("select record_compliance_filing($1, $2::jsonb)", [OPS_A, filing({ udin_record_id: otherUdin })]);
      expect(userMessage(e)).toMatch(/UDIN is linked to another filing or belongs to another client/);
    });
  });

  it("links an existing filing record instead of creating one, once", async () => {
    await db.asRole(U.M1, async (s) => {
      const existing = await s.value<string>("select id from filing_records where client_id = $1 and filing_type = 'GSTR-1'", [C.A]);
      const r = await s.value<{ filing_record_id: string }>("select record_compliance_filing($1, $2::jsonb)", [STAT_A, JSON.stringify({ filing_record_id: existing })]);
      expect(r.filing_record_id).toBe(existing);
      expect(await s.value("select compliance_event_id from filing_records where id = $1", [existing])).toBe(STAT_A);
      const again = await s.fails("select record_compliance_filing($1, $2::jsonb)", [OPS_A, JSON.stringify({ filing_record_id: existing })]);
      expect(userMessage(again)).toMatch(/already linked to another deadline/);
      const foreign = await s.value<string>("select id from filing_records where client_id = $1 limit 1", [C.B]);
      const e = await s.fails("select record_compliance_filing($1, $2::jsonb)", [OPS_A, JSON.stringify({ filing_record_id: foreign })]);
      expect(userMessage(e)).toMatch(/isn't this client's/);
    });
  });

  it("refuses Employees, a future date, missing details and another client's document", async () => {
    await db.asRole(U.E1, async (s) => {
      const e = await s.fails("select record_compliance_filing($1, $2::jsonb)", [STAT_A, filing()]);
      expect(userMessage(e)).toMatch(/Only a Partner or Manager can record a filing/);
    });
    await db.asRole(U.M1, async (s) => {
      const future = await s.fails("select record_compliance_filing($1, $2::jsonb)", [STAT_A, filing({ filed_on: "2099-01-01" })]);
      expect(userMessage(future)).toMatch(/can't be in the future/);
      const noType = await s.fails("select record_compliance_filing($1, $2::jsonb)", [STAT_A, filing({ filing_type: " " })]);
      expect(userMessage(noType)).toMatch(/return or form/);
      const badFy = await s.fails("select record_compliance_filing($1, $2::jsonb)", [STAT_A, filing({ financial_year: "2026" })]);
      expect(userMessage(badFy)).toMatch(/YYYY-YY/);
      const doc = await s.fails("select record_compliance_filing($1, $2::jsonb)", [STAT_A, filing({ document_id: F.docPrivate("B") })]);
      expect(userMessage(doc)).toMatch(/isn't in this client's documents/);
      const firm = await s.value<string>("insert into compliance_events (type, title, due_date, source) values ('custom', 'Firm GSTR-3B', today_ist(), 'manual') returning id");
      const firmLevel = await s.fails("select record_compliance_filing($1, $2::jsonb)", [firm, filing()]);
      expect(userMessage(firmLevel)).toMatch(/firm-level deadline/);
    });
  });
});

// -------------------------------------------------------------------------------------------------
// filings_grid
// -------------------------------------------------------------------------------------------------

describe("filings_grid", () => {
  const grid = (s: Session, args: { owner?: string | null; q?: string | null; status?: string | null; limit?: number; offset?: number } = {}) =>
    s.value<{ total: number; clients: Array<{ id: string; owner_name: string | null }>; events: Array<{ client_id: string; has_filing: boolean }>; summary: unknown[] }>(
      "select filings_grid('2026-27', array['gstr_3b']::compliance_type[], '^GSTR-3B$', null, $1, false, $2, $3, $4, $5)",
      [args.owner ?? null, args.q ?? null, args.status ?? null, args.limit ?? 25, args.offset ?? 0],
    );

  async function seed(s: Session) {
    await s.exec("update compliance_events set form_code = 'GSTR-3B', due_date = today_ist() - 3 where id = $1", [STAT_A]);
    await s.exec("update compliance_events set form_code = 'GSTR-3B', due_date = today_ist() + 3 where id = $1", [STAT_B]);
    await s.exec("update compliance_events set form_code = 'GSTR-3B' where id = $1", [fid("ce:C:stat")]);
  }

  it("is for Partners and Managers", async () => {
    await db.asRole(U.E1, async (s) => {
      const e = await s.fails("select filings_grid('2026-27', array['gstr_3b']::compliance_type[])");
      expect(userMessage(e)).toMatch(/for Partners and Managers/);
    });
  });

  it("pages clients, filters by owner, search and status, and summarises every client", async () => {
    await db.asRole(U.M1, async (s) => {
      await seed(s);
      const all = await grid(s);
      expect(all.total).toBe(3);
      expect(all.summary).toHaveLength(3);
      expect(all.clients.map((c) => c.id)).toEqual([C.A, C.B, C.C]);
      expect(all.clients[0].owner_name).toBe("Test E1");

      const page = await grid(s, { limit: 1, offset: 1 });
      expect(page.total).toBe(3);
      expect(page.clients.map((c) => c.id)).toEqual([C.B]);
      expect(page.events.every((e) => e.client_id === C.B)).toBe(true);
      expect(page.summary).toHaveLength(3);

      expect((await grid(s, { owner: U.E4.employeeId })).clients.map((c) => c.id)).toEqual([C.B]);
      expect((await grid(s, { q: "gamma" })).clients.map((c) => c.id)).toEqual([C.C]);
      expect((await grid(s, { status: "overdue" })).clients.map((c) => c.id)).toEqual([C.A]);
      expect((await grid(s, { q: "100%_" })).total).toBe(0);
    });
  });

  it("marks cells that have a filing record and leaves out cancelled deadlines", async () => {
    await db.asRole(U.P1, async (s) => {
      await seed(s);
      await s.exec("insert into filing_records (client_id, financial_year, filing_type, compliance_event_id) values ($1, '2026-27', 'GSTR-3B', $2)", [C.A, STAT_A]);
      await s.exec("update compliance_events set status = 'cancelled' where id = $1", [STAT_B]);
      const r = await grid(s);
      expect(r.clients.map((c) => c.id)).toEqual([C.A, C.C]);
      expect(r.events.find((e) => e.client_id === C.A)?.has_filing).toBe(true);
    });
  });

  it("refuses a missing FY, no return type and an unknown status", async () => {
    await db.asRole(U.M1, async (s) => {
      expect(userMessage(await s.fails("select filings_grid('2026', array['gstr_3b']::compliance_type[])"))).toMatch(/financial year/);
      expect(userMessage(await s.fails("select filings_grid('2026-27', array[]::compliance_type[])"))).toMatch(/return type/);
      expect(userMessage(await s.fails("select filings_grid('2026-27', array['gstr_3b']::compliance_type[], null, null, null, false, null, 'late')"))).toMatch(/Unknown status/);
    });
  });
});

// -------------------------------------------------------------------------------------------------
// compliance_coverage
// -------------------------------------------------------------------------------------------------

describe("compliance_coverage", () => {
  type Cover = { client_id: string; type: string; upcoming: number; last_due: string };
  const coverage = (s: Session, ids: string[] | null) => s.value<Cover[]>("select compliance_coverage($1::uuid[])", [ids]);

  it("counts upcoming statutory deadlines only, under the caller's RLS", async () => {
    await db.asRole(U.M1, async (s) => {
      await s.exec("update compliance_events set due_date = today_ist() + 30 where id in ($1, $2)", [STAT_A, OPS_A]);
      await s.exec(
        "insert into compliance_events (client_id, type, form_code, title, due_date, source, is_statutory, status) values ($1, 'gstr_3b', 'GSTR-3B', 'Cancelled', today_ist() + 60, 'statutory_engine', true, 'cancelled'), ($1, 'gstr_3b', 'GSTR-3B', 'Past', today_ist() - 60, 'statutory_engine', true, 'pending')",
        [C.A],
      );
      const rows = await coverage(s, [C.A]);
      expect(rows.map((r) => ({ client_id: r.client_id, type: r.type, upcoming: r.upcoming }))).toEqual([{ client_id: C.A, type: "gstr_3b", upcoming: 1 }]);
    });
    await db.asRole(U.E1, async (s) => {
      const rows = await coverage(s, null);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.client_id === C.A)).toBe(true);
    });
  });

  it("the job reads every client; anonymous callers get nothing", async () => {
    await db.asSuper(async (s) => {
      await s.exec("update compliance_events set due_date = today_ist() + 5 where id in ($1, $2)", [STAT_A, STAT_B]);
      const ids = new Set((await coverage(s, null)).map((r) => r.client_id));
      expect(ids.has(C.A) && ids.has(C.B)).toBe(true);
    });
    await db.asAnon(async (s) => {
      const e = await s.fails("select compliance_coverage(null)");
      expect(e.code).toBe(SQLSTATE.insufficientPrivilege);
    });
  });

  it("returns an empty list for an unknown client", async () => {
    await db.asRole(U.P1, async (s) => {
      expect(await coverage(s, [randomUUID()])).toEqual([]);
    });
  });
});

// -------------------------------------------------------------------------------------------------
// Calendar reads
// -------------------------------------------------------------------------------------------------

describe("calendar", () => {
  type Group = { date: string; label: string; total: number; done: number; overdue: number; extended: number; event: { id: string; client_name: string | null } | null };
  const days = (s: Session, from: string, to: string, extra: { client?: string | null; owner?: string | null; statutory?: boolean | null } = {}) =>
    s.value<{ groups: Group[] }>("select compliance_calendar_days($1::date, $2::date, $3, $4, null, $5)", [from, to, extra.client ?? null, extra.owner ?? null, extra.statutory ?? null]);

  async function seedDay(s: Session) {
    // Three GSTR-3B returns on one day (one filed, one overdue-looking), one internal step.
    await s.exec("update compliance_events set form_code = 'GSTR-3B', due_date = '2026-09-20' where id in ($1, $2, $3)", [STAT_A, STAT_B, fid("ce:C:stat")]);
    await s.exec("update compliance_events set due_date = '2026-09-20' where id = $1", [OPS_A]);
    await s.exec("insert into filing_records (client_id, financial_year, filing_type, compliance_event_id) values ($1, '2026-27', 'GSTR-3B', $2)", [C.A, STAT_A]);
    await s.exec("update compliance_events set workflow_status = 'filed' where id = $1", [STAT_A]);
  }

  it("groups a day's returns with their counts; a group of one carries its event", async () => {
    await db.asRole(U.P1, async (s) => {
      await seedDay(s);
      const r = await days(s, "2026-09-01", "2026-09-30");
      const gst = r.groups.find((g) => g.label === "GSTR-3B")!;
      expect(gst).toMatchObject({ date: "2026-09-20", total: 3, done: 1, overdue: 2, event: null });
      const internal = r.groups.find((g) => g.label === "Internal follow-up A")!;
      expect(internal.total).toBe(1);
      expect(internal.event).toMatchObject({ id: OPS_A, client_name: "Alpha Traders" });
      expect((await days(s, "2026-09-01", "2026-09-30", { statutory: false })).groups.map((g) => g.label)).toEqual(["Internal follow-up A"]);
      expect((await days(s, "2026-09-01", "2026-09-30", { owner: U.E4.employeeId })).groups.map((g) => g.total)).toEqual([1]);
    });
  });

  it("an Employee sees only their clients, and the range is capped", async () => {
    await db.asRole(U.P1, async (s) => {
      await seedDay(s);
      await s.as(U.E1);
      const r = await days(s, "2026-09-01", "2026-09-30");
      expect(r.groups.find((g) => g.label === "GSTR-3B")?.total).toBe(1);
      const e = await s.fails("select compliance_calendar_days('2026-01-01', '2026-06-30')");
      expect(userMessage(e)).toMatch(/at most two months/);
    });
    await db.asRole(U.CA, async (s) => {
      const e = await s.fails("select compliance_calendar_days('2026-09-01', '2026-09-30')");
      expect(userMessage(e)).toMatch(/for staff/);
    });
  });

  it("the agenda pages rows in order, filters by return and lists overdue work", async () => {
    await db.asRole(U.M1, async (s) => {
      await seedDay(s);
      const all = await s.value<{ total: number; rows: Array<{ id: string; client_name: string; has_filing: boolean }> }>(
        "select compliance_agenda('2026-09-20', '2026-09-20', null, null, null, null, 'GSTR-3B', false, 2, 0)",
      );
      expect(all.total).toBe(3);
      expect(all.rows.map((r) => r.client_name)).toEqual(["Alpha Traders", "Beta Industries"]);
      expect(all.rows[0].has_filing).toBe(true);
      const overdue = await s.value<{ total: number; rows: Array<{ id: string }> }>(
        "select compliance_agenda(null, null, null, null, array['gstr_3b']::compliance_type[], null, null, true, 25, 0)",
      );
      expect(overdue.rows.map((r) => r.id).sort()).toEqual([STAT_B, fid("ce:C:stat")].sort());
    });
  });
});
