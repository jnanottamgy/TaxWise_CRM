/**
 * Regressions for the security review of the database layer (0044_security_review.sql).
 *
 *   1. A Manager can't issue an invoice above the approval limit without a Partner (§4.1, §7.9.2).
 *   2. A Manager can't approve, or send without approval, a quotation that needs it (§4.1, §7.5.2).
 *   3. Employees don't read (or write) the history of money-side records in activity_logs (§4.1).
 *   4. Portal users can't delete files from the documents vault (§0.1 rule 11, §7.22).
 *   5. audit_logs can't be emptied with TRUNCATE, not even by the service role (§4.6).
 *   6. Managers manage Employees' leave only, not Partners' or other Managers' (§0, §4.1).
 */
import { describe, expect, it } from "vitest";
import { canSeeClient, type CoverRecord } from "@/lib/domain/cover";
import type { AppRole, InvoiceStatus, TaskStatus } from "@/lib/domain/enums";
import { daysOverdue as taskDaysOverdue } from "@/lib/domain/escalation";
import { daysOverdue as invoiceDaysOverdue, deriveInvoiceStatus, isInvoiceOverdue } from "@/lib/domain/invoice";
import { invoiceNeedsApproval, quotationNeedsApproval } from "@/lib/domain/approvals";
import { toPaise, toPaiseOrNull } from "@/lib/domain/money";
import { C, SQLSTATE, U, fid, setupTestDatabase, userMessage, type Session } from "./helpers";

const db = setupTestDatabase("secreview");

// -------------------------------------------------------------------------------------------------
// 0. can_see_client (SQL) and canSeeClient (lib/domain/cover.ts) agree (§4.6, §4.7)
// -------------------------------------------------------------------------------------------------

describe("can_see_client() and canSeeClient() give the same answer (§4.7 'the SQL helper applies the same rules')", () => {
  it("for every fixture user and client, with live, revoked, future and expired covers, and a deleted client", async () => {
    await db.asSuper(async (s) => {
      // E3 covers client B (in force); E2 covers everything E1 owns or is on the team of (in force);
      // E4 had a cover for A that was revoked; E4 has one for C that starts tomorrow; E3 covers Z (deleted).
      await s.exec(
        `insert into client_covers (kind, client_id, absent_employee_id, cover_employee_id, starts_at, ends_at, reason, granted_by, revoked_at)
         values ('client', $1, $2, $3, now() - interval '1 hour', now() + interval '1 day', 'leave', $9, null),
                ('person', null, $4, $5, now() - interval '1 hour', now() + interval '2 days', 'absent_today', $9, null),
                ('client', $6, $4, $7, now() - interval '1 hour', now() + interval '1 day', 'workload', $9, now() - interval '1 minute'),
                ('client', $8, null, $7, now() + interval '1 day', now() + interval '2 days', 'other', $9, null),
                ('client', $10, $4, $3, now() - interval '1 hour', now() + interval '1 day', 'leave', $9, null)`,
        [C.B, U.E4.employeeId, U.E3.employeeId, U.E1.employeeId, U.E2.employeeId, C.A, U.E4.employeeId, C.C, U.P1.id, C.Z],
      );
      const now = await s.value<Date>("select now()");
      const clients = await s.rows<{ id: string; owner_employee_id: string | null; portal_user_id: string | null; deleted_at: Date | null }>(
        "select id, owner_employee_id, portal_user_id, deleted_at from clients where id = any($1)",
        [Object.values(C)],
      );
      const teams = (await s.rows<{ client_id: string; employee_id: string }>("select client_id, employee_id from client_team_members")).map((t) => ({
        clientId: t.client_id,
        employeeId: t.employee_id,
      }));
      const covers: CoverRecord[] = (
        await s.rows<{ kind: "client" | "person"; client_id: string | null; absent_employee_id: string | null; cover_employee_id: string; starts_at: Date; ends_at: Date; revoked_at: Date | null }>(
          "select kind::text, client_id, absent_employee_id, cover_employee_id, starts_at, ends_at, revoked_at from client_covers",
        )
      ).map((c) => ({
        kind: c.kind,
        clientId: c.client_id,
        absentEmployeeId: c.absent_employee_id,
        coverEmployeeId: c.cover_employee_id,
        startsAt: c.starts_at,
        endsAt: c.ends_at,
        revokedAt: c.revoked_at,
      }));

      let compared = 0;
      for (const user of Object.values(U)) {
        await s.as(user);
        const me = await s.one<{ role: AppRole | null; employee_id: string | null }>("select app_role()::text as role, my_employee_id() as employee_id");
        for (const client of clients) {
          const sql = await s.value<boolean>("select can_see_client($1)", [client.id]);
          const ts = canSeeClient(
            { role: me.role, isActive: me.role !== null, employeeId: me.employee_id, userId: user.id },
            { id: client.id, ownerEmployeeId: client.owner_employee_id, portalUserId: client.portal_user_id, deletedAt: client.deleted_at },
            teams,
            covers,
            now,
          );
          expect(ts, `${user.key} → ${client.id}`).toBe(sql);
          compared += 1;
        }
      }
      expect(compared).toBe(Object.keys(U).length * Object.keys(C).length);
      // The covers above really decide something (the comparison isn't vacuous).
      await s.as(U.E3);
      expect(await s.value("select can_see_client($1)", [C.B])).toBe(true);
      expect(await s.value("select can_see_client($1)", [C.Z])).toBe(false);
      await s.as(U.E2);
      expect(await s.value("select can_see_client($1)", [C.A])).toBe(true);
      await s.as(U.E4);
      expect(await s.value("select can_see_client($1)", [C.A])).toBe(false);
      expect(await s.value("select can_see_client($1)", [C.C])).toBe(false);
    });
  });
});

describe("no money column reaches an Employee, through any table or view (§4.1 'never, anywhere')", () => {
  /** Columns that carry fees, invoice, receipt, credit note, quotation or lead amounts. */
  const MONEY_COLUMN = /^(agreed_fee|fee_agreed|estimated_value|subtotal|total|unit_price|rate|amount|tds_amount|amount_received|amount_paid|tds_credited|credit_noted|outstanding_amount|taxable_amount|cgst_amount|sgst_amount|igst_amount|reimbursement_amount|round_off|total_amount|tax_amount|cost_rate_per_hour|billing_rate_per_hour|invoice_approval_limit|quotation_approval_limit)$/;
  /** Readable by spec: an Employee's own employees row (§4.6), firm settings for all staff (§4.6). */
  const ALLOWED = new Set(["employees.billing_rate_per_hour", "firm_settings.invoice_approval_limit", "firm_settings.quotation_approval_limit"]);

  it("every money-like column an Employee can select is empty for them", async () => {
    const columns = await db.asSuper((s) =>
      s.rows<{ rel: string; col: string }>(
        `select c.relname as rel, a.attname as col
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
         where n.nspname = 'public' and c.relkind in ('r', 'v', 'm') order by 1, 2`,
      ),
    );
    const money = columns.filter((c) => MONEY_COLUMN.test(c.col));
    expect(money.length).toBeGreaterThan(40);
    // Sanity: a Partner does read amounts (the check below is not vacuous).
    expect(await db.asRole(U.P1, (s) => s.value<number>("select count(*)::int from invoices where total_amount is not null"))).toBeGreaterThan(0);
    for (const user of [U.E1, U.E2, U.E3, U.E4, U.X, U.D]) {
      await db.asRole(user, async (s) => {
        for (const { rel, col } of money) {
          if (ALLOWED.has(`${rel}.${col}`)) continue;
          const a = await s.attempt<{ n: number }>(`select count(*)::int as n from public.${rel} where ${col} is not null`);
          const seen = a.ok ? a.rows[0].n : a.code === SQLSTATE.insufficientPrivilege ? 0 : Number.NaN;
          expect(seen, `${user.key} reads ${rel}.${col}${a.ok ? "" : ` (${a.message})`}`).toBe(0);
        }
      });
    }
  });
});

describe("derived overdue: the views and lib/domain agree (§0.1 rule 10, §5.5, §5.7)", () => {
  it("invoices_view matches isInvoiceOverdue / deriveInvoiceStatus / daysOverdue (a draft is never overdue)", async () => {
    await db.asSuper(async (s) => {
      // due: a date, or null for today (IST); the fixtures add partially paid ones past their due date.
      const add = (status: string, due: string | null, cancelled = false) =>
        s.exec(
          `insert into invoices (client_id, issue_date, due_date, status, place_of_supply_code, taxable_amount, cgst_amount, sgst_amount, total_amount, created_by,
                                cancelled_at, cancel_reason, disputed_reason, waived_reason)
           values ($1, '2026-04-01', coalesce($2::date, today_ist()), $3::invoice_status, '29', 1000, 90, 90, 1180, $4,
                   case when $5::boolean then now() end, case when $5::boolean then 'Wrong GSTIN' end,
                   case when $3 = 'disputed' then 'Scope' end, case when $3 = 'waived' then 'Goodwill' end)`,
          [C.B, due, status, U.P1.id, cancelled],
        );
      for (const due of ["2026-04-15", null, "2099-01-01"]) {
        for (const status of ["draft", "awaiting_approval", "sent", "disputed", "waived"]) await add(status, due);
        await add("sent", due, true);
      }
      const today = await s.value<string>("select today_ist()::text");
      const rows = await s.rows<{ status: InvoiceStatus; outstanding_amount: string; due_date: string; cancelled: boolean; is_overdue: boolean; days_overdue: number; display_status: string }>(
        "select status, outstanding_amount::text, due_date::text, cancelled_at is not null as cancelled, is_overdue, days_overdue, display_status from invoices_view",
      );
      expect(rows.length).toBeGreaterThan(12);
      expect(rows.some((r) => r.is_overdue)).toBe(true);
      expect(rows.some((r) => !r.is_overdue)).toBe(true);
      for (const r of rows) {
        const args = [r.status, toPaise(r.outstanding_amount), r.due_date, today, { cancelled: r.cancelled }] as const;
        const label = JSON.stringify(r);
        expect(isInvoiceOverdue(...args), label).toBe(r.is_overdue);
        expect(invoiceDaysOverdue(...args), label).toBe(r.days_overdue);
        expect(deriveInvoiceStatus(...args), label).toBe(r.display_status);
        if (r.status === "draft") expect(r.is_overdue, label).toBe(false);
      }
    });
  });

  it("tasks_view matches daysOverdue in lib/domain/escalation.ts", async () => {
    await db.asSuper(async (s) => {
      for (const status of ["not_started", "in_progress", "data_awaited", "under_review", "filed_done", "on_hold"]) {
        for (const due of ["2026-04-15", null, "2099-01-01"]) {
          await s.exec(
            `insert into tasks (client_id, title, status, due_date, created_by, completion_date) values ($1, 'Agreement', $2::task_status, $3::date, $4, case when $2 = 'filed_done' then now() end)`,
            [C.B, status, due, U.P1.id],
          );
        }
        await s.exec(`insert into tasks (client_id, title, status, due_date, created_by, completion_date) values ($1, 'Due today', $2::task_status, today_ist(), $3, case when $2 = 'filed_done' then now() end)`, [C.B, status, U.P1.id]);
      }
      const today = await s.value<string>("select today_ist()::text");
      const rows = await s.rows<{ status: TaskStatus; due_date: string | null; is_overdue: boolean; days_overdue: number }>(
        "select status, due_date::text, is_overdue, days_overdue from tasks_view",
      );
      expect(rows.filter((r) => r.is_overdue).length).toBe(5);
      for (const r of rows) {
        const days = taskDaysOverdue(r.due_date, today, r.status);
        expect(days, JSON.stringify(r)).toBe(r.days_overdue);
        expect(days > 0, JSON.stringify(r)).toBe(r.is_overdue);
      }
    });
  });
});

// -------------------------------------------------------------------------------------------------
// 1. Invoice approval gate
// -------------------------------------------------------------------------------------------------

/** An intra-state invoice for client A as the current identity; ₹10,000 + GST = ₹11,800 unless given. */
async function invoice(s: Session, by: (typeof U)[keyof typeof U], opts: { status?: string; total?: number } = {}): Promise<string> {
  const total = opts.total ?? 11800;
  const taxable = Math.round((total / 1.18) * 100) / 100;
  const half = Math.round(((total - taxable) / 2) * 100) / 100;
  const status = opts.status ?? "draft";
  // A session creates invoices as drafts (0190): an issued one is a draft issued through issue_invoice.
  const id = await s.value<string>(
    `insert into invoices (client_id, issue_date, due_date, status, place_of_supply_code, taxable_amount, cgst_amount, sgst_amount, total_amount, created_by)
     values ($1, '2026-10-01', '2026-10-16', $2::invoice_status, '29', $3, $4, $4, $5, $6) returning id`,
    [C.A, status === "sent" ? "draft" : status, taxable, half, total, by.id],
  );
  // An unissued invoice carries the line its totals come from (0190: it is issued only when they match).
  await s.exec("insert into invoice_items (invoice_id, description, sac_code, quantity, rate, amount, tax_rate) values ($1, 'Professional fees', '998231', 1, $2, $2, 18)", [id, taxable]);
  if (status === "sent") await issueInvoice(s, id);
  return id;
}

/** Issues a draft the way the app does (issue_invoice: number, snapshots, Rule 46 checks). */
async function issueInvoice(s: Session, id: string): Promise<void> {
  await s.value("select public.issue_invoice($1, (select updated_at from invoices where id = $1), null)", [id]);
}

const approvalOf = (s: Session, id: string) =>
  s.one<{ status: string; requires_approval: boolean }>("select status::text, requires_approval from invoices where id = $1", [id]);

describe("invoice approval gate (§4.1 'Raise an invoice above the approval limit without approval': Manager ❌)", () => {
  it("a Manager's invoice above the limit is held at creation and can't be sent straight away", async () => {
    await db.asSuper(async (s) => {
      await s.exec("update firm_settings set invoice_approval_limit = 10000");
      await s.as(U.M1);
      const sent = await s.attempt(
        `insert into invoices (client_id, issue_date, due_date, status, place_of_supply_code, taxable_amount, cgst_amount, sgst_amount, total_amount, created_by)
         values ($1, '2026-10-01', '2026-10-16', 'sent', '29', 10000, 900, 900, 11800, $2)`,
        [C.A, U.M1.id],
      );
      expect(sent.ok).toBe(false);
      if (!sent.ok) expect(sent.message).toMatch(/waits for a Partner's approval/);

      const id = await invoice(s, U.M1);
      expect(await approvalOf(s, id)).toEqual({ status: "draft", requires_approval: true });
    });
  });

  it("a Manager can't clear the gate, or slip a held invoice out through Draft", async () => {
    await db.asSuper(async (s) => {
      await s.exec("update firm_settings set invoice_approval_limit = 10000");
      await s.as(U.M1);
      const id = await invoice(s, U.M1, { status: "awaiting_approval" });
      expect(userMessage(await s.fails("update invoices set requires_approval = false where id = $1", [id]))).toMatch(/fixed when it is created/);
      expect(await s.exec("update invoices set status = 'draft' where id = $1", [id])).toBe(1);
      expect(userMessage(await s.fails("update invoices set status = 'sent' where id = $1", [id]))).toMatch(/waiting for a Partner's approval/);
      expect(userMessage(await s.fails("update invoices set status = 'sent', requires_approval = false where id = $1", [id]))).toMatch(/fixed when it is created|waiting for a Partner's approval/);
      expect(await approvalOf(s, id)).toEqual({ status: "draft", requires_approval: true });
    });
  });

  it("raising a Manager's draft above the limit holds it too", async () => {
    await db.asSuper(async (s) => {
      await s.exec("update firm_settings set invoice_approval_limit = 10000");
      await s.as(U.M1);
      const id = await invoice(s, U.M1, { total: 5900 });
      expect(await approvalOf(s, id)).toEqual({ status: "draft", requires_approval: false });
      await s.exec("update invoices set taxable_amount = 10000, cgst_amount = 900, sgst_amount = 900, total_amount = 11800 where id = $1", [id]);
      expect(await approvalOf(s, id)).toEqual({ status: "draft", requires_approval: true });
      expect(userMessage(await s.fails("update invoices set status = 'sent' where id = $1", [id]))).toMatch(/waiting for a Partner's approval/);
    });
  });

  it("once a Partner approves, the Manager sends it; the approved amount can't then be changed by a Manager", async () => {
    await db.asSuper(async (s) => {
      await s.exec("update firm_settings set invoice_approval_limit = 10000");
      await s.as(U.M1);
      const id = await invoice(s, U.M1, { status: "awaiting_approval" });
      const other = await invoice(s, U.M1, { status: "awaiting_approval" });
      await s.as(U.P1);
      expect(await s.exec("update invoices set approved_by = $2, approved_at = now(), status = 'draft' where id in ($1, $3)", [id, U.P1.id, other])).toBe(2);
      await s.as(U.M1);
      expect(userMessage(await s.fails("update invoices set total_amount = 118000, taxable_amount = 100000, cgst_amount = 9000, sgst_amount = 9000 where id = $1", [other]))).toMatch(/approved/);
      await issueInvoice(s, id);
      expect(await s.value("select invoice_number is not null from invoices where id = $1", [id])).toBe(true);
    });
  });

  it("Partners raise and send above the limit; with no limit, Managers send freely; a lower limit later doesn't re-gate", async () => {
    await db.asSuper(async (s) => {
      await s.exec("update firm_settings set invoice_approval_limit = 10000");
      await s.as(U.P1);
      const byPartner = await invoice(s, U.P1, { status: "sent" });
      expect((await approvalOf(s, byPartner)).requires_approval).toBe(false);

      await s.as("super");
      await s.exec("update firm_settings set invoice_approval_limit = null");
      await s.as(U.M1);
      const free = await invoice(s, U.M1);
      expect((await approvalOf(s, free)).requires_approval).toBe(false);
      await s.as("super");
      await s.exec("update firm_settings set invoice_approval_limit = 100");
      await s.as(U.M1);
      expect(await s.exec("update invoices set notes = 'Thanks' where id = $1", [free])).toBe(1);
      await issueInvoice(s, free);
      expect((await approvalOf(s, free)).status).toBe("sent");
    });
  });
});

// -------------------------------------------------------------------------------------------------
// 2. Quotation approval gate
// -------------------------------------------------------------------------------------------------

async function quotation(s: Session, by: (typeof U)[keyof typeof U], opts: { total?: number; status?: string } = {}): Promise<string> {
  // A quotation starts as a Draft and its totals are its lines' (0190), so the helper adds one line
  // (no GST) worth the total, and touches the draft so the totals follow it.
  const id = await s.value<string>(
    `insert into quotations (client_id, client_name, client_email, valid_until, issue_date, created_by)
     values ($1, 'Alpha Traders', 'alpha@example.com', '2026-12-31', '2026-10-22', $2) returning id`,
    [C.A, by.id],
  );
  await s.exec("insert into quotation_items (quotation_id, description, quantity, unit_price, tax_rate, tax_amount, total) values ($1, 'Annual compliance', 1, $2, 0, 0, 0)", [id, opts.total ?? 11800]);
  await s.exec("update quotations set notes = 'Fees as discussed' where id = $1", [id]);
  if (opts.status && opts.status !== "draft") await s.exec("update quotations set status = $2::quotation_status where id = $1", [id, opts.status]);
  return id;
}

describe("quotation approval gate (§4.1 'Send a quotation': Manager only under the limit, else held)", () => {
  it("only a Partner approves a quotation", async () => {
    await db.asRole(U.M1, async (s) => {
      const id = await quotation(s, U.M1);
      expect(userMessage(await s.fails("update quotations set status = 'approved' where id = $1", [id]))).toMatch(/Only a Partner can approve a quotation/);
      expect(userMessage(await s.fails("update quotations set approved_by = $2, approved_at = now() where id = $1", [id, U.M1.id]))).toMatch(/Only a Partner can approve a quotation/);
      expect(userMessage(await s.fails(
        `insert into quotations (client_name, client_email, valid_until, created_by, approved_by, approved_at) values ('X', 'x@example.com', '2026-12-31', $1, $1, now())`,
        [U.M1.id],
      ))).toMatch(/Only a Partner can approve a quotation/);
    });
  });

  it("with no limit set, a Manager's quotation always waits for a Partner before it is sent", async () => {
    await db.asRole(U.M1, async (s) => {
      expect(await s.value("select quotation_approval_limit from firm_settings")).toBeNull();
      const id = await quotation(s, U.M1);
      for (const status of ["sent", "viewed", "accepted"]) {
        expect(userMessage(await s.fails(`update quotations set status = '${status}' where id = $1`, [id])), status).toMatch(/over the quotation approval limit/);
      }
      expect(userMessage(await s.fails(
        `insert into quotations (client_name, client_email, valid_until, created_by, total, status) values ('X', 'x@example.com', '2026-12-31', $1, 100, 'sent')`,
        [U.M1.id],
      ))).toMatch(/over the quotation approval limit|starts as a draft/);
      expect(await s.exec("update quotations set status = 'pending_approval' where id = $1", [id])).toBe(1);
      await s.as(U.P1);
      expect(await s.exec("update quotations set status = 'approved', approved_by = $2, approved_at = now() where id = $1", [id, U.P1.id])).toBe(1);
      await s.as(U.M1);
      expect(await s.exec("update quotations set status = 'sent', sent_at = now() where id = $1", [id])).toBe(1);
    });
  });

  it("a limit of 0 never holds; otherwise only totals above the limit wait", async () => {
    await db.asSuper(async (s) => {
      await s.exec("update firm_settings set quotation_approval_limit = 0");
      await s.as(U.M1);
      const a = await quotation(s, U.M1, { total: 500000 });
      expect(await s.exec("update quotations set status = 'sent' where id = $1", [a])).toBe(1);
      await s.as("super");
      await s.exec("update firm_settings set quotation_approval_limit = 20000");
      await s.as(U.M1);
      const under = await quotation(s, U.M1, { total: 20000 });
      const over = await quotation(s, U.M1, { total: 20000.01 });
      expect(await s.exec("update quotations set status = 'sent' where id = $1", [under])).toBe(1);
      expect(userMessage(await s.fails("update quotations set status = 'sent' where id = $1", [over]))).toMatch(/over the quotation approval limit/);
    });
  });

  it("a Partner's own quotation needs no approval, whoever sends it; a Manager can't pass theirs off as a Partner's", async () => {
    await db.asRole(U.P1, async (s) => {
      const byPartner = await quotation(s, U.P1, { total: 500000 });
      expect(await s.exec("update quotations set status = 'sent' where id = $1", [await quotation(s, U.P1)])).toBe(1);
      await s.as(U.M1);
      expect(await s.exec("update quotations set status = 'sent' where id = $1", [byPartner])).toBe(1);
      expect(userMessage(await s.fails(
        `insert into quotations (client_name, client_email, valid_until, created_by) values ('X', 'x@example.com', '2026-12-31', $1)`,
        [U.P1.id],
      ))).toMatch(/in your own name/);
      const mine = await quotation(s, U.M1);
      expect(userMessage(await s.fails("update quotations set created_by = $2 where id = $1", [mine, U.P1.id]))).toMatch(/in your own name/);
    });
  });
});

describe("the approval gates agree with lib/domain/approvals.ts", () => {
  it("invoices: requires_approval at creation = invoiceNeedsApproval(creator, total, limit)", async () => {
    for (const limit of [null, 0, 10000]) {
      for (const total of [0, 9999.99, 10000, 10000.01, 250000]) {
        for (const by of [U.P1, U.M1]) {
          await db.asSuper(async (s) => {
            await s.exec("update firm_settings set invoice_approval_limit = $1", [limit]);
            await s.as(by);
            const held = await s.value<boolean>(
              `insert into invoices (client_id, issue_date, due_date, status, place_of_supply_code, taxable_amount, total_amount, created_by)
               values ($1, '2026-10-01', '2026-10-16', 'draft', '29', $2, $2, $3) returning requires_approval`,
              [C.A, total, by.id],
            );
            const want = invoiceNeedsApproval(by.profileRole, toPaise(total), toPaiseOrNull(limit));
            expect(held, JSON.stringify({ limit, total, by: by.key })).toBe(want);
          });
        }
      }
    }
  });

  it("quotations: sending without approval is allowed exactly when quotationNeedsApproval(creator, total, limit) is false", async () => {
    for (const limit of [null, 0, 20000]) {
      for (const total of [100, 20000, 20000.01]) {
        for (const by of [U.P1, U.M1]) {
          await db.asSuper(async (s) => {
            await s.exec("update firm_settings set quotation_approval_limit = $1", [limit]);
            await s.as(by);
            const id = await quotation(s, by, { total });
            await s.as(U.M1);
            const sent = await s.attempt("update quotations set status = 'sent' where id = $1", [id]);
            const needs = quotationNeedsApproval(by.profileRole, toPaise(total), toPaiseOrNull(limit));
            expect(sent.ok, JSON.stringify({ limit, total, by: by.key, sent })).toBe(!needs);
          });
        }
      }
    }
  });
});

// -------------------------------------------------------------------------------------------------
// 3. activity_logs: money-side history
// -------------------------------------------------------------------------------------------------

describe("activity_logs keep money-side history away from Employees (§4.1 'never, anywhere')", () => {
  it("an Employee doesn't read the history of an invoice email, or a money-side action on their client", async () => {
    await db.asSuper(async (s) => {
      await s.exec(
        `insert into activity_logs (entity_type, entity_id, action, description, user_id) values
           ('message', $1, 'sent', 'Invoice email sent: Rs 5,900', $3),
           ('message', $2, 'sent', 'Reminder email sent', $3),
           ('client', $4, 'invoice_created', 'Invoice TW/26-27/0042 for Rs 5,900', $3),
           ('client', $4, 'fee_changed', 'GST fee Rs 5,000 → Rs 6,000', $3)`,
        [fid("msg:A:invoice"), fid("msg:A:email"), U.P1.id, C.A],
      );
      await s.as(U.E1);
      const rows = await s.rows<{ description: string }>("select description from activity_logs order by description");
      expect(rows.map((r) => r.description)).toEqual(["Edited A", "Reminder email sent"]);
      expect(await s.value("select can_see_entity('message', $1)", [fid("msg:A:invoice")])).toBe(false);
      expect(await s.value("select can_see_entity('message', $1)", [fid("msg:A:email")])).toBe(true);
      await s.as(U.M1);
      expect(await s.value<number>("select count(*)::int from activity_logs where entity_id in ($1, $2)", [fid("msg:A:invoice"), C.A])).toBe(4);
    });
  });

  it("an Employee can't write money-side history either", async () => {
    await db.asRole(U.E1, async (s) => {
      const sql = "insert into activity_logs (entity_type, entity_id, action, description, user_id) values ($1, $2, $3, 'x', $4)";
      expect((await s.fails(sql, ["client", C.A, "invoice_created", U.E1.id])).code).toBe(SQLSTATE.insufficientPrivilege);
      expect((await s.fails(sql, ["message", fid("msg:A:invoice"), "sent", U.E1.id])).code).toBe(SQLSTATE.insufficientPrivilege);
      expect(await s.exec(sql, ["client", C.A, "note_added", U.E1.id])).toBe(1);
    });
  });
});

// -------------------------------------------------------------------------------------------------
// 4. Storage: portal users don't delete vault files
// -------------------------------------------------------------------------------------------------

describe("client-documents files (§0.1 rule 11, §7.22)", () => {
  it("a portal user can't delete a file, even one they uploaded; staff remove their own uploads", async () => {
    await db.asRole(U.CA, async (s) => {
      expect(await s.exec("insert into storage.objects (bucket_id, name, owner) values ('client-documents', $1, $2)", [`${C.A}/upload.pdf`, U.CA.id])).toBe(1);
      // The upload is registered as the client's document, so the portal can read the file back.
      await s.exec(
        `insert into documents (client_id, title, file_name, file_size, mime_type, storage_path, uploaded_by, source)
         values ($1, 'Bank statement', 'upload.pdf', 100, 'application/pdf', $2, $3, 'client_portal')`,
        [C.A, `client-documents/${C.A}/upload.pdf`, U.CA.id],
      );
      expect(await s.value<number>("select count(*)::int from storage.objects where bucket_id = 'client-documents' and name = $1", [`${C.A}/upload.pdf`])).toBe(1);
      expect(await s.exec("delete from storage.objects where bucket_id = 'client-documents' and name = $1", [`${C.A}/upload.pdf`])).toBe(0);
      await s.as(U.E1);
      expect(await s.exec("insert into storage.objects (bucket_id, name, owner) values ('client-documents', $1, $2)", [`${C.A}/mine.pdf`, U.E1.id])).toBe(1);
      expect(await s.exec("delete from storage.objects where bucket_id = 'client-documents' and name = $1", [`${C.A}/upload.pdf`])).toBe(0);
      expect(await s.exec("delete from storage.objects where bucket_id = 'client-documents' and name = $1", [`${C.A}/mine.pdf`])).toBe(1);
      await s.as(U.M1);
      expect(await s.exec("delete from storage.objects where bucket_id = 'client-documents' and name = $1", [`${C.A}/upload.pdf`])).toBe(1);
    });
  });
});

// -------------------------------------------------------------------------------------------------
// 5. audit_logs: no TRUNCATE
// -------------------------------------------------------------------------------------------------

describe("audit_logs can't be emptied (§4.6 'no UPDATE or DELETE for anyone')", () => {
  it("TRUNCATE is refused for the database owner and the service role", async () => {
    await db.asSuper(async (s) => {
      expect(userMessage(await s.fails("truncate audit_logs"))).toBe("Audit log entries can't be changed or deleted.");
      await s.exec("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)");
      await s.exec("set local role service_role");
      expect((await s.fails("truncate audit_logs")).code).toMatch(new RegExp(`^(${SQLSTATE.insufficientPrivilege}|${SQLSTATE.raiseException})$`));
      await s.exec("reset role");
      expect(await s.value<number>("select count(*)::int from audit_logs")).toBeGreaterThan(0);
    });
  });
});

// -------------------------------------------------------------------------------------------------
// 6. Leave: Managers manage Employees' leave only
// -------------------------------------------------------------------------------------------------

describe("leave records of Partners and Managers (§0 'Manager: … not other Managers or Partners')", () => {
  it("a Manager can't edit or delete a Partner's or another Manager's leave, but manages Employees' and their own", async () => {
    await db.asSuper(async (s) => {
      const ids = await s.rows<{ id: string; who: string }>(
        `insert into employee_leave (employee_id, start_date, end_date) values
           ($1, '2026-12-07', '2026-12-08'), ($2, '2026-12-09', '2026-12-09'), ($3, '2026-12-10', '2026-12-10'), ($4, '2026-12-11', '2026-12-11')
         returning id, case employee_id when $1 then 'P2' when $2 then 'M2' when $3 then 'M1' else 'E2' end as who`,
        [U.P2.employeeId, U.M2.employeeId, U.M1.employeeId, U.E2.employeeId],
      );
      const id = (who: string) => ids.find((r) => r.who === who)!.id;
      await s.as(U.M1);
      for (const who of ["P2", "M2"]) {
        expect(userMessage(await s.fails("update employee_leave set end_date = '2026-12-31' where id = $1", [id(who)])), who).toMatch(/a Partner decides leave for Managers/);
        expect(userMessage(await s.fails("delete from employee_leave where id = $1", [id(who)])), who).toMatch(/a Partner decides leave for Managers/);
      }
      expect(await s.exec("update employee_leave set end_date = '2026-12-11' where id = $1", [id("M1")])).toBe(1);
      expect(await s.exec("update employee_leave set end_date = '2026-12-12' where id = $1", [id("E2")])).toBe(1);
      expect(await s.exec("delete from employee_leave where id = $1", [id("E2")])).toBe(1);
      await s.as(U.P1);
      expect(await s.exec("update employee_leave set end_date = '2026-12-31' where id = $1", [id("M2")])).toBe(1);
      expect(await s.exec("delete from employee_leave where id = $1", [id("P2")])).toBe(1);
    });
  });
});
