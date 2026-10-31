/**
 * The home pages' database readers (§7.2, migrations 0215–0218): Firm today (Partner only), Team
 * today (Partners and Managers), My day (any staff member, no money), and the shared task rows,
 * review queue and deadlines. Every one is SECURITY INVOKER, so the tests check both the refusals
 * and that RLS still decides what each person's figures are made of (§4.1, §4.6).
 */
import { describe, expect, it } from "vitest";
import { addDays, todayIST } from "@/lib/domain/fy";
import { C, F, U, SQLSTATE, fid, setupTestDatabase, userMessage, type Session, type TestUser } from "./helpers";

const db = setupTestDatabase("dashboard");

type Json = Record<string, unknown>;

const firm = (s: Session, today: string, fy: string | null = null) =>
  s.value<Json>("select public.dashboard_firm_today($1, $2::date)", [fy, today]);
const team = (s: Session, today: string) => s.value<Json>("select public.dashboard_team_today($1::date)", [today]);
const myDay = (s: Session, today: string) => s.value<Json>("select public.dashboard_my_day($1::date)", [today]);

/** A task on a client, inserted as the superuser (the guards keep their rules for API callers only). */
async function addTask(
  s: Session,
  t: { key: string; client: string; status?: string; assignee?: TestUser | null; reviewer?: TestUser | null; acceptance?: string; due?: string | null },
): Promise<string> {
  const id = fid(`dash-task:${t.key}`);
  await s.as("super");
  await s.exec(
    `insert into tasks (id, task_number, client_id, title, status, assigned_employee_id, reviewer_employee_id, acceptance_status, created_by, due_date)
     values ($1, $2, $3, $4, $5::task_status, $6, $7, $8::task_acceptance, $9, $10::date)`,
    [
      id,
      `T-95${String(Math.abs(hash(t.key)) % 10000).padStart(4, "0")}`,
      t.client,
      `Dashboard task ${t.key}`,
      t.status ?? "not_started",
      t.assignee ? t.assignee.employeeId : null,
      t.reviewer ? t.reviewer.employeeId : null,
      t.acceptance ?? (t.assignee ? "accepted" : "pending"),
      U.P1.id,
      t.due === undefined ? "2026-11-30" : t.due,
    ],
  );
  return id;
}

function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

const rowIds = (block: unknown): string[] => ((block as { rows: Array<{ id: string }> }).rows ?? []).map((r) => r.id);

// =================================================================================================
// Who may call what
// =================================================================================================

describe("who may open each home page's reader", () => {
  it("Firm today is the Partner's alone", async () => {
    await db.asRole(U.P1, async (s) => {
      const r = await firm(s, "2026-10-24");
      expect(r.financial_year).toBe("2026-27");
    });
    for (const u of [U.M1, U.E1, U.CA]) {
      await db.asRole(u, async (s) => {
        const e = await s.fails("select public.dashboard_firm_today(null, '2026-10-24'::date)");
        expect(e.code).toBe(SQLSTATE.raiseException);
        expect(userMessage(e)).toMatch(/Firm today is for Partners/);
      });
    }
    // A JWT that says Partner over an Employee profile is not a Partner (§4.6 app_role cross-check).
    await db.asRole(U.X, async (s) => {
      expect(userMessage(await s.fails("select public.dashboard_firm_today(null, '2026-10-24'::date)"))).toMatch(/for Partners/);
    });
  });

  it("Team today is for Partners and Managers", async () => {
    for (const u of [U.P1, U.M1]) await db.asRole(u, async (s) => expect((await team(s, "2026-10-24")).today).toBe("2026-10-24"));
    for (const u of [U.E1, U.CA, U.D]) {
      await db.asRole(u, async (s) => expect(userMessage(await s.fails("select public.dashboard_team_today('2026-10-24'::date)"))).toMatch(/Partners and Managers/));
    }
  });

  it("My day is for the team, not for clients or disabled logins", async () => {
    for (const u of [U.P1, U.M1, U.E1]) await db.asRole(u, async (s) => expect((await myDay(s, "2026-10-24")).linked).toBe(true));
    for (const u of [U.CA, U.D]) {
      await db.asRole(u, async (s) => expect(userMessage(await s.fails("select public.dashboard_my_day('2026-10-24'::date)"))).toMatch(/firm's team/));
    }
  });

  it("anon can call none of them", async () => {
    await db.asAnon(async (s) => {
      for (const sql of [
        "select public.dashboard_firm_today()",
        "select public.dashboard_team_today()",
        "select public.dashboard_my_day()",
        "select public.dashboard_review_queue()",
        "select public.dashboard_deadlines('2026-10-01'::date, '2026-12-31'::date)",
        "select public.dashboard_task_rows(array[]::uuid[])",
      ]) {
        expect((await s.fails(sql)).code).toBe(SQLSTATE.insufficientPrivilege);
      }
    });
  });

  it("refuses a financial year that isn't one", async () => {
    await db.asRole(U.P1, async (s) => {
      expect(userMessage(await s.fails("select public.dashboard_firm_today('last year', '2026-10-24'::date)"))).toMatch(/financial year like 2026-27/);
    });
  });
});

// =================================================================================================
// Firm today
// =================================================================================================

describe("Firm today (§7.2 Partner)", () => {
  it("agrees with the payments dashboard on receivables, ageing, collections and unbilled time", async () => {
    await db.asRole(U.P1, async (s) => {
      // An older invoice so the ageing has more than one bucket, and a receipt with TDS this month.
      await s.as("super");
      await s.exec(
        `insert into invoices (id, client_id, issue_date, due_date, status, place_of_supply_code, taxable_amount, cgst_amount, sgst_amount, total_amount, created_by)
         values ($1, $2, '2026-06-01', '2026-06-15', 'sent', '29', 10000, 900, 900, 11800, $3)`,
        [fid("dash-inv:old"), C.B, U.P1.id],
      );
      await s.exec(
        `insert into payment_receipts (receipt_number, invoice_id, payment_date, amount_received, tds_amount, method, recorded_by)
         values ('TW-R/26-27/9500', $1, '2026-10-05', 900, 100, 'upi', $2)`,
        [F.invoiceSent("A"), U.P1.id],
      );
      await s.as(U.P1);
      const today = "2026-10-24";
      const r = await firm(s, today);
      const p = await s.value<Json>("select public.payments_dashboard($1::date)", [today]);
      const k = r.kpis as Json;
      const recv = p.receivables as Json;
      const coll = p.collection as Json;
      expect(k.outstanding).toBe(recv.outstanding);
      expect(k.outstanding_count).toBe(recv.count);
      expect(k.overdue).toBe(recv.overdue);
      expect(k.overdue_count).toBe(recv.overdue_count);
      expect(k.collected_month).toBe(coll.collected_month);
      expect(k.tds_month).toBe(coll.tds_month);
      expect(k.collected_month).toBe("1000.00");
      expect(k.tds_month).toBe("100.00");
      expect(k.unbilled).toBe((p.unbilled as Json).amount);
      expect(r.ageing).toEqual(p.ageing);
      const ageing = r.ageing as Array<{ bucket: string; count: number }>;
      expect(ageing.map((a) => a.bucket)).toEqual(["0_30", "31_60", "61_90", "90_plus"]);
      expect(ageing.find((a) => a.bucket === "31_60")?.count).toBe(3);
      expect(ageing.find((a) => a.bucket === "90_plus")?.count).toBe(1);
    });
  });

  it("sums the FY's invoices by month, leaving months not yet begun empty", async () => {
    await db.asRole(U.P1, async (s) => {
      const r = await firm(s, "2026-10-24", "2026-27");
      const k = r.kpis as Json;
      // Three sent invoices of ₹5,900 dated 1 Sep 2026 (drafts are not invoiced).
      expect(k.invoiced_fy).toBe("17700.00");
      expect(k.invoiced_fy_count).toBe(3);
      const months = r.months as Array<{ month: string; invoiced: string | null; collected: string | null }>;
      expect(months).toHaveLength(12);
      expect(months[0].month).toBe("2026-04");
      expect(months.find((m) => m.month === "2026-09")).toEqual({ month: "2026-09", invoiced: "17700.00", collected: "3000.00" });
      expect(months.find((m) => m.month === "2026-10")).toEqual({ month: "2026-10", invoiced: "0", collected: "0" });
      expect(months.find((m) => m.month === "2026-11")).toEqual({ month: "2026-11", invoiced: null, collected: null });
      // Another FY: nothing invoiced, every month already past.
      const last = await firm(s, "2026-10-24", "2025-26");
      expect((last.kpis as Json).invoiced_fy).toBe("0");
      expect((last.months as Array<{ invoiced: string | null }>).every((m) => m.invoiced === "0")).toBe(true);
    });
  });

  it("reports the setup checklist's facts", async () => {
    await db.asRole(U.P1, async (s) => {
      let setup = (await firm(s, "2026-10-24")).setup as Json;
      expect(setup).toMatchObject({ has_logo: false, has_frn: false, domain_status: "not_started", law_reviewed_at: null, partners: 2, clients_onboarded: 0, invoices_issued: 3 });
      expect((setup.partners_missing_membership as Array<{ name: string }>).map((p) => p.name)).toEqual(["Test P1", "Test P2"]);
      expect(setup.team_members).toBeGreaterThan(1);

      await s.as("super");
      await s.exec("update firm_settings set logo_path = 'firm/logo.png', icai_frn = '012345S', bank_account_number = '1234567890', bank_ifsc = 'HDFC0001234', upi_id = 'taxwise@hdfcbank', law_last_reviewed_at = now() where id = 1");
      await s.exec("update profiles set icai_membership_no = '212345' where id = $1", [U.P1.id]);
      await s.exec("update clients set onboarded_at = now() where id = $1", [C.A]);
      await s.exec("update firm_whatsapp_numbers set number = '919845012345', is_active = true where label = 'Staff office'");
      await s.as(U.P1);
      setup = (await firm(s, "2026-10-24")).setup as Json;
      expect(setup).toMatchObject({ has_logo: true, has_frn: true, has_bank: true, has_upi: true, clients_onboarded: 1, whatsapp_numbers: 1 });
      expect(setup.law_reviewed_at).not.toBeNull();
      expect((setup.partners_missing_membership as Array<{ profile_id: string; employee_id: string }>)).toEqual([
        expect.objectContaining({ profile_id: U.P2.id, employee_id: U.P2.employeeId }),
      ]);
    });
  });

  it("counts approvals waiting for the Partner, but not their own leave", async () => {
    await db.asRole(U.P1, async (s) => {
      await s.as("super");
      await s.exec(
        `insert into invoices (client_id, issue_date, due_date, status, place_of_supply_code, taxable_amount, cgst_amount, sgst_amount, total_amount, created_by)
         values ($1, '2026-10-20', '2026-11-04', 'awaiting_approval', '29', 100000, 9000, 9000, 118000, $2)`,
        [C.A, U.M1.id],
      );
      await s.exec("update quotations set status = 'pending_approval' where id = $1", [fid("quotation:A")]);
      await s.exec("insert into employee_leave (employee_id, start_date, end_date, status) values ($1, '2026-11-10', '2026-11-11', 'requested')", [U.P1.employeeId]);
      await s.as(U.P1);
      const a = (await firm(s, "2026-10-24")).approvals as Json;
      expect(a).toMatchObject({ invoices: 1, invoices_value: "118000.00", quotations: 1, quotations_value: "11800.00" });
      const fixtureLeave = await s.value<number>("select count(*)::int from employee_leave where status = 'requested' and employee_id <> $1", [U.P1.employeeId]);
      expect(a.leave).toBe(fixtureLeave);
      expect(a.data_requests).toBe(1);
    });
  });

  it("lists at-risk clients: 3+ overdue tasks, or receivables over 90 days", async () => {
    await db.asRole(U.P1, async (s) => {
      for (const n of [1, 2, 3]) await addTask(s, { key: `risk-${n}`, client: C.B, assignee: U.E2, due: "2026-10-01" });
      await addTask(s, { key: "risk-c", client: C.C, assignee: U.M2, due: "2026-10-01" });
      await s.exec(
        `insert into invoices (client_id, issue_date, due_date, status, place_of_supply_code, taxable_amount, cgst_amount, sgst_amount, total_amount, created_by)
         values ($1, '2026-06-01', '2026-06-15', 'sent', '29', 10000, 900, 900, 11800, $2)`,
        [C.C, U.P1.id],
      );
      await s.as(U.P1);
      const risk = (await firm(s, "2026-10-24")).at_risk as { total: number; rows: Array<{ client_id: string; overdue_tasks: number; receivables_old: string }> };
      expect(risk.total).toBe(2);
      expect(risk.rows.map((r) => r.client_id)).toEqual([C.B, C.C]);
      expect(risk.rows[0]).toMatchObject({ overdue_tasks: 3, receivables_old: "0" });
      expect(risk.rows[1]).toMatchObject({ overdue_tasks: 1, receivables_old: "11800.00" });
      expect((await firm(s, "2026-10-24")).kpis).toMatchObject({ overdue_tasks: 4 });
    });
  });

  it("groups this month's deadlines for the filing status chart and counts filings due in 7 days", async () => {
    await db.asRole(U.P1, async (s) => {
      await s.as("super");
      await s.exec("update compliance_events set status = 'completed' where id = $1", [fid("ce:A:stat")]);
      await s.as(U.P1);
      const r = await firm(s, "2026-11-21");
      const groups = r.filing as Array<{ type: string; filed: number; pending: number; overdue: number }>;
      expect(groups.find((g) => g.type === "gstr_3b")).toMatchObject({ filed: 1, pending: 0, overdue: 2 });
      expect(groups.find((g) => g.type === "custom")).toMatchObject({ filed: 0, pending: 3, overdue: 0 });
      // Due 25 Nov: the three internal follow-ups (deleted client Z's are left out).
      expect((r.kpis as Json).filings_due_7).toBe(3);
      const week = r.week as { from: string; to: string; total: number; rows: Array<{ id: string; client_name: string }> };
      expect(week).toMatchObject({ from: "2026-11-16", to: "2026-11-22" });
      expect(week.total).toBe(2);
    });
  });

  it("summarises the pipeline and the FY's quotation decisions", async () => {
    await db.asRole(U.P1, async (s) => {
      await s.as("super");
      await s.exec("update quotations set status = 'accepted' where id = $1", [fid("quotation:A")]);
      await s.exec("update quotations set status = 'rejected', rejection_reason = 'Fee' where id = $1", [fid("quotation:B")]);
      await s.exec("update quotations set status = 'sent', sent_at = now() where id = $1", [fid("quotation:C")]);
      await s.as(U.P1);
      const p = (await firm(s, "2026-10-24", "2026-27")).pipeline as Json;
      expect(p).toMatchObject({ open_leads: 2, quotations_sent: 1, quotations_sent_value: "11800.00", accepted: 1, rejected: 1, expired: 0 });
      expect((await firm(s, "2026-10-24", "2025-26")).pipeline).toMatchObject({ accepted: 0, rejected: 0 });
    });
  });
});

// =================================================================================================
// Team today
// =================================================================================================

describe("Team today (§7.2 Manager)", () => {
  it("counts each queue the way its /work list does, with the first rows", async () => {
    await db.asRole(U.M1, async (s) => {
      const unassigned = await addTask(s, { key: "t-unassigned", client: C.A, assignee: null, due: "2026-10-30" });
      // Due after the real today, so the row's own is_overdue (the list view's, against today) stays false.
      const waiting = await addTask(s, { key: "t-waiting", client: C.A, assignee: U.E1, acceptance: "pending", due: addDays(todayIST(), 7) });
      const declined = await addTask(s, { key: "t-declined", client: C.B, assignee: null, acceptance: "declined", due: "2026-10-29" });
      await addTask(s, { key: "t-data", client: C.B, assignee: U.E2, status: "data_awaited", due: "2026-10-20" });
      await addTask(s, { key: "t-filed", client: C.B, assignee: null, status: "filed_done", due: "2026-10-01" });
      await s.as(U.M1);
      const r = await team(s, "2026-10-24");
      expect(r.unassigned).toMatchObject({ total: 2 });
      expect(rowIds(r.unassigned)).toEqual([declined, unassigned]);
      expect(r.waiting).toMatchObject({ total: 1 });
      expect(rowIds(r.waiting)).toEqual([waiting]);
      expect(rowIds(r.declined)).toEqual([declined]);
      expect(r.data_awaited).toBe(1);
      expect(r.overdue).toBe(1);
      const row = (r.waiting as { rows: Json[] }).rows[0];
      expect(row).toMatchObject({ client_name: "Alpha Traders", assignee_name: "Test E1", acceptance_status: "pending", is_overdue: false });
    });
  });

  it("puts overdue tasks against each person, unassigned last", async () => {
    await db.asRole(U.M1, async (s) => {
      await addTask(s, { key: "o-1", client: C.B, assignee: U.E2, due: "2026-10-01" });
      await addTask(s, { key: "o-2", client: C.B, assignee: U.E2, due: "2026-10-02" });
      await addTask(s, { key: "o-3", client: C.A, assignee: U.E1, due: "2026-10-03" });
      await addTask(s, { key: "o-4", client: C.C, assignee: null, due: "2026-10-04" });
      await s.as(U.M1);
      expect((await team(s, "2026-10-24")).overdue_by_person).toEqual([
        { employee_id: U.E2.employeeId, name: "Test E2", count: 2 },
        { employee_id: U.E1.employeeId, name: "Test E1", count: 1 },
        { employee_id: null, name: "Unassigned", count: 1 },
      ]);
    });
  });

  it("sums the sales strip: invoices issued this month, quotations awaiting a response, stale leads", async () => {
    await db.asRole(U.M1, async (s) => {
      await s.as("super");
      await s.exec("update quotations set status = 'sent', sent_at = now() - interval '3 days' where id in ($1, $2)", [fid("quotation:A"), fid("quotation:B")]);
      await s.exec("update leads set created_at = now() - interval '30 days', last_activity_at = now() - interval '20 days' where lead_number = 'L-9001'");
      await s.as(U.M1);
      const sales = (await team(s, "2026-09-30")).sales as Json;
      expect(sales).toMatchObject({ invoices_month: 3, invoices_month_total: "17700.00", quotations_awaiting: 2, quotations_awaiting_value: "23600.00", stale_leads: 1 });
      expect((sales.stale_rows as Array<{ name: string }>).map((l) => l.name)).toEqual(["Lead One"]);
      expect((sales.quotation_rows as Json[]).length).toBe(2);
      expect((await team(s, "2026-10-24")).sales).toMatchObject({ invoices_month: 0, invoices_month_total: "0" });
    });
  });
});

// =================================================================================================
// The review queue
// =================================================================================================

describe("the review queue (same rule as /work?view=review)", () => {
  it("shows tasks named to me, unnamed ones to Partners and Managers, and never my own", async () => {
    await db.asRole(U.M1, async (s) => {
      const toM1 = await addTask(s, { key: "r-m1", client: C.A, assignee: U.E1, reviewer: U.M1, status: "under_review" });
      const unnamed = await addTask(s, { key: "r-none", client: C.B, assignee: U.E2, reviewer: null, status: "under_review" });
      const mine = await addTask(s, { key: "r-own", client: C.C, assignee: U.M1, reviewer: null, status: "under_review" });
      const toE2 = await addTask(s, { key: "r-e2", client: C.B, assignee: U.E4, reviewer: U.E2, status: "under_review" });

      await s.as(U.M1);
      const m1 = await s.value<{ total: number; rows: Array<{ id: string }> }>("select public.dashboard_review_queue(10)");
      expect(m1.rows.map((r) => r.id).sort()).toEqual([toM1, unnamed].sort());
      expect(m1.rows.map((r) => r.id)).not.toContain(mine);

      await s.as(U.M2);
      const m2 = await s.value<{ rows: Array<{ id: string }> }>("select public.dashboard_review_queue(10)");
      expect(m2.rows.map((r) => r.id).sort()).toEqual([unnamed, mine].sort());

      // An Employee reviews only what is named to them.
      await s.as(U.E2);
      const e2 = await s.value<{ total: number; rows: Array<{ id: string }> }>("select public.dashboard_review_queue(10)");
      expect(e2.rows.map((r) => r.id)).toEqual([toE2]);
    });
  });
});

// =================================================================================================
// My day
// =================================================================================================

describe("My day (§7.2 Employee)", () => {
  it("holds only my own tasks, split into waiting, due now and sent back", async () => {
    await db.asRole(U.E1, async (s) => {
      const waiting = await addTask(s, { key: "m-wait", client: C.A, assignee: U.E1, acceptance: "pending", due: "2026-10-30" });
      const overdue = await addTask(s, { key: "m-late", client: C.A, assignee: U.E1, due: "2026-10-20" });
      const dueToday = await addTask(s, { key: "m-today", client: C.A, assignee: U.E1, due: "2026-10-24" });
      await addTask(s, { key: "m-other", client: C.B, assignee: U.E2, due: "2026-10-20" });
      // Sent back by M1 with a reason. The second task was sent back too, but it has moved since (put
      // on hold, then resumed): its latest change is not a send-back, so it isn't "sent back" now.
      const sentBack = await addTask(s, { key: "m-back", client: C.A, assignee: U.E1, status: "in_progress", due: "2026-11-05" });
      const resumed = await addTask(s, { key: "m-again", client: C.A, assignee: U.E1, status: "in_progress", due: "2026-11-06" });
      await s.exec(
        `insert into task_status_history (task_id, from_status, to_status, reason, changed_by, changed_at) values
           ($1, 'in_progress', 'under_review', null, $3, now() - interval '2 days'),
           ($1, 'under_review', 'in_progress', 'Attach the bank reconciliation', $4, now() - interval '1 day'),
           ($2, 'under_review', 'in_progress', 'Wrong period', $4, now() - interval '3 days'),
           ($2, 'in_progress', 'on_hold', null, $4, now() - interval '2 days'),
           ($2, 'on_hold', 'in_progress', null, $4, now() - interval '1 hour')`,
        [sentBack, resumed, U.E1.id, U.M1.id],
      );

      await s.as(U.E1);
      const r = await myDay(s, "2026-10-24");
      expect(rowIds(r.waiting)).toEqual([waiting]);
      const due = r.due_now as { total: number; overdue: number; today: number };
      expect(due).toMatchObject({ overdue: 1, today: 1 });
      expect(rowIds(r.due_now)).toEqual([overdue, dueToday]);
      const back = r.sent_back as { total: number; rows: Array<{ id: string }>; meta: Array<{ task_id: string; reason: string; by_name: string }> };
      expect(back.total).toBe(1);
      expect(back.rows.map((t) => t.id)).toEqual([sentBack]);
      expect(back.meta[0]).toMatchObject({ task_id: sentBack, reason: "Attach the bank reconciliation", by_name: "Test M1" });
    });
  });

  it("lists my clients' deadlines: an Employee's by RLS, a Manager's by ownership", async () => {
    await db.asRole(U.E1, async (s) => {
      const d = (await myDay(s, "2026-11-15")).deadlines as { total: number; rows: Array<{ client_id: string }> };
      expect(new Set(d.rows.map((x) => x.client_id))).toEqual(new Set([C.A]));
      expect(d.total).toBe(2);
    });
    await db.asRole(U.E3, async (s) => {
      expect(((await myDay(s, "2026-11-15")).deadlines as { total: number }).total).toBe(0);
    });
    await db.asRole(U.M1, async (s) => {
      const d = (await myDay(s, "2026-11-15")).deadlines as { rows: Array<{ client_id: string }> };
      expect(new Set(d.rows.map((x) => x.client_id))).toEqual(new Set([C.C]));
    });
  });

  it("carries no money", async () => {
    await db.asRole(U.E1, async (s) => {
      const text = JSON.stringify(await myDay(s, "2026-10-24"));
      for (const word of ["fee", "amount", "invoice", "quotation", "receipt", "outstanding"]) expect(text.toLowerCase()).not.toContain(word);
    });
  });

  it("says when a login has no team-member record", async () => {
    await db.asRole(U.E1, async (s) => {
      await s.as("super");
      await s.exec("update employees set profile_id = null where id = $1", [U.E1.employeeId]);
      await s.as(U.E1);
      expect(await myDay(s, "2026-10-24")).toEqual({ linked: false, today: "2026-10-24" });
    });
  });
});

// =================================================================================================
// Shared readers keep RLS
// =================================================================================================

describe("the shared readers keep each person's RLS", () => {
  it("an Employee's deadlines and task rows are their own clients' only", async () => {
    await db.asRole(U.E2, async (s) => {
      const d = await s.value<{ rows: Array<{ client_id: string }> }>("select public.dashboard_deadlines('2026-11-01'::date, '2026-11-30'::date, 50)");
      expect(new Set(d.rows.map((x) => x.client_id))).toEqual(new Set([C.B]));
      const rows = await s.value<Array<{ id: string }>>("select public.dashboard_task_rows($1::uuid[])", [[F.task("A"), F.task("B"), F.task("C")]]);
      expect(rows.map((r) => r.id)).toEqual([F.task("B")]);
    });
  });

  it("task rows come back in the order asked for", async () => {
    await db.asRole(U.P1, async (s) => {
      const ids = [F.task("C"), F.task("A"), F.task("B")];
      const rows = await s.value<Array<{ id: string }>>("select public.dashboard_task_rows($1::uuid[])", [ids]);
      expect(rows.map((r) => r.id)).toEqual(ids);
    });
  });

  it("deadlines leave out cancelled ones and deleted clients'", async () => {
    await db.asRole(U.P1, async (s) => {
      await s.as("super");
      await s.exec("update compliance_events set status = 'cancelled' where id = $1", [fid("ce:B:ops")]);
      await s.exec(
        "insert into compliance_events (client_id, type, title, due_date, source, is_statutory, financial_year) values ($1, 'custom', 'On a deleted client', '2026-11-25', 'manual', false, '2026-27')",
        [C.Z],
      );
      await s.as(U.P1);
      const all = await s.value<{ total: number }>("select public.dashboard_deadlines('2026-11-25'::date, '2026-11-25'::date, 50, null, false)");
      expect(all.total).toBe(2);
    });
  });
});
