/**
 * Collections in the database (§7.9.5, §7.9.6, §7.9.9, §7.9.10, §4.1): the retainer billing run
 * (skip reasons, the catch-up cap, already-billed periods, next_billing_date, the approval hold),
 * the reminder slots, the collection forecast, the payments dashboard (Partner only), the revenue
 * ledger, TDS credit marking and the 26AS / AIS import, and that none of it reaches an Employee or a
 * portal user.
 */
import { describe, expect, it } from "vitest";
import { C, F, U, SQLSTATE, fid, setupTestDatabase, userMessage, type Session } from "./helpers";

const db = setupTestDatabase("collections");

type RunResult = {
  run_id: string;
  counts: Record<string, number>;
  capped: Array<{ client_service_id: string; periods_left: number; next_billing_date: string }>;
  errors: unknown[];
  drafts_created: number;
  drafts_total: string;
};

async function runRetainer(s: Session, today: string): Promise<RunResult> {
  await s.as("super");
  return s.value<RunResult>("select public.generate_retainer_drafts($1::date, 3)", [today]);
}

/** Extra engagements on client A, one per §7.9.6 skip reason. */
async function addSkipCases(s: Session) {
  await s.as("super");
  await s.exec(`
    insert into client_services (client_id, service_type, frequency, agreed_fee, auto_invoice, next_billing_date, is_active)
    values ('${C.A}', 'income_tax', 'annual', 20000, false, '2026-04-01', true),          -- not enabled
           ('${C.A}', 'payroll', 'monthly', 3000, true, '2026-10-01', false),             -- service inactive
           ('${C.A}', 'bookkeeping', 'monthly', null, true, '2026-10-01', true),          -- no agreed fee
           ('${C.A}', 'incorporation', 'one_time', 15000, true, '2026-10-01', true);      -- one-time
    insert into client_services (client_id, service_type, frequency, agreed_fee, auto_invoice, next_billing_date)
    values ('${C.C}', 'audit', 'annual', 50000, true, '2026-04-01');                       -- client on hold (below)
    update clients set status = 'on_hold' where id = '${C.C}';
  `);
}

describe("generate_retainer_drafts (§7.9.6)", () => {
  it("drafts every due period up to the cap of 3, skips an already-billed period, advances next_billing_date and reports the cap", async () => {
    await db.asSuper(async (s) => {
      await addSkipCases(s);
      // Client A's GST retainer is due from 1 Jul 2026; Sep 2026 is already invoiced (fixture).
      await s.exec("update client_services set next_billing_date = '2026-07-01' where id = $1", [F.service("A")]);
      const r = await runRetainer(s, "2026-10-23");

      expect(r.counts).toMatchObject({
        drafts_created: 2,
        already_billed: 1,
        engagements_billed: 1,
        capped: 1,
        failed: 0,
        skipped_not_enabled: 1,
        skipped_service_inactive: 1,
        // Client C is on hold: its audit and its GST retainer both wait.
        skipped_client_inactive_or_on_hold: 2,
        skipped_no_agreed_fee: 1,
        skipped_one_time_service: 1,
        // Client B's GST retainer is next due on 1 Nov 2026.
        skipped_not_yet_due: 1,
      });
      expect(r.capped).toHaveLength(1);
      expect(r.capped[0]).toMatchObject({ client_service_id: F.service("A"), next_billing_date: "2026-10-01", periods_left: 1 });
      expect(await s.value("select next_billing_date::text from client_services where id = $1", [F.service("A")])).toBe("2026-10-01");

      const drafts = await s.rows<{ billing_period_label: string; status: string; taxable_amount: string; cgst_amount: string; sgst_amount: string; total_amount: string; issue_date: string; invoice_number: string | null; created_by: string }>(
        `select i.billing_period_label, i.status::text, i.taxable_amount::text, i.cgst_amount::text, i.sgst_amount::text, i.total_amount::text,
                i.issue_date::text, i.invoice_number, i.created_by::text
           from retainer_drafts d join invoices i on i.id = d.invoice_id where d.run_id = $1 order by d.billing_date`,
        [r.run_id],
      );
      expect(drafts.map((d) => d.billing_period_label)).toEqual(["Jul 2026", "Aug 2026"]);
      for (const d of drafts) {
        expect(d).toMatchObject({ status: "draft", taxable_amount: "5000.00", cgst_amount: "450.00", sgst_amount: "450.00", total_amount: "5900.00", issue_date: "2026-10-23", invoice_number: null });
        // Client A's owner is an Employee, and it has no engagement partner: the first Partner raises it.
        expect([U.P1.id, U.P2.id]).toContain(d.created_by);
      }
      const line = await s.one<{ description: string; sac_code: string; tax_rate: string }>(
        "select ii.description, ii.sac_code, ii.tax_rate::text from invoice_items ii join retainer_drafts d on d.invoice_id = ii.invoice_id where d.run_id = $1 and d.period_label = 'Jul 2026'",
        [r.run_id],
      );
      expect(line).toEqual({ description: "GST returns for Jul 2026", sac_code: "998231", tax_rate: "18.00" });
      expect(await s.value("select count(*)::int from client_timeline_events where client_id = $1 and event_type = 'invoice_drafted'", [C.A])).toBe(2);

      // The next run catches up the last period, and the one after finds nothing due.
      const second = await runRetainer(s, "2026-10-23");
      expect(second.counts).toMatchObject({ drafts_created: 1, capped: 0 });
      expect(await s.value("select next_billing_date::text from client_services where id = $1", [F.service("A")])).toBe("2026-11-01");
      const third = await runRetainer(s, "2026-10-23");
      expect(third.counts.drafts_created).toBe(0);
      expect(third.counts.skipped_not_yet_due).toBe(2);
    });
  });

  it("keeps a 31st on month ends, labels quarters and years, and bills IGST out of state", async () => {
    // Client B's Sep 2026 is already invoiced (fixture), so the run bills Aug and Oct and moves past Sep.
    await db.asSuper(async (s) => {
      await s.exec("update clients set gst_registration = 'registered', gstin = '27AABCB1234C1Z5' where id = $1", [C.B]);
      await s.exec("update client_services set next_billing_date = '2026-08-31', frequency = 'monthly', billing_frequency = 'monthly' where id = $1", [F.service("B")]);
      const r = await runRetainer(s, "2026-10-31");
      const b = await s.rows<{ period_label: string; billing_date: string; igst_amount: string }>(
        "select d.period_label, d.billing_date::text, i.igst_amount::text from retainer_drafts d join invoices i on i.id = d.invoice_id where d.run_id = $1 and i.client_id = $2 order by d.billing_date",
        [r.run_id, C.B],
      );
      expect(b).toEqual([
        { period_label: "Aug 2026", billing_date: "2026-08-31", igst_amount: "900.00" },
        { period_label: "Oct 2026", billing_date: "2026-10-31", igst_amount: "900.00" },
      ]);
      expect(r.counts.already_billed).toBe(1);
      expect(await s.value("select next_billing_date::text from client_services where id = $1", [F.service("B")])).toBe("2026-11-30");
      expect(await s.value("select public.retainer_period_label('2026-11-15', 'quarterly')")).toBe("Q3 2026-27");
      expect(await s.value("select public.retainer_period_label('2027-02-15', 'annual')")).toBe("FY 2026-27");
    });
  });

  it("holds a draft over the invoice approval limit for a Partner, and a Manager can't issue it", async () => {
    await db.asSuper(async (s) => {
      await s.exec("update firm_settings set invoice_approval_limit = 5000, gstin = '29AAXFT1811B1Z3', address = 'MG Road, Bengaluru' where id = 1");
      await s.exec("update client_services set next_billing_date = '2026-10-01' where id = $1", [F.service("A")]);
      const r = await runRetainer(s, "2026-10-23");
      const draft = await s.one<{ invoice_id: string; requires_approval: boolean; updated_at: string }>(
        "select d.invoice_id, i.requires_approval, i.updated_at::text from retainer_drafts d join invoices i on i.id = d.invoice_id where d.run_id = $1",
        [r.run_id],
      );
      expect(draft.requires_approval).toBe(true);
      await s.as(U.M1);
      const e = await s.fails("select public.issue_invoice($1, $2::timestamptz, null)", [draft.invoice_id, draft.updated_at]);
      expect(userMessage(e)).toMatch(/approval limit/);
    });
  });

  it("is the job's alone: staff can't run it or write the run tables, and only Partners and Managers read them", async () => {
    await db.asSuper(async (s) => {
      await s.exec("update client_services set next_billing_date = '2026-10-01' where id = $1", [F.service("A")]);
      await runRetainer(s, "2026-10-23");
      for (const who of [U.P1, U.M1]) {
        await s.as(who);
        expect((await s.attempt("select public.generate_retainer_drafts('2026-10-23', 3)")).ok).toBe(false);
        expect(await s.value<number>("select count(*)::int from retainer_drafts")).toBeGreaterThan(0);
        expect(await s.value<number>("select count(*)::int from retainer_draft_queue")).toBeGreaterThan(0);
        expect((await s.attempt("insert into retainer_runs (run_date) values ('2026-10-23')")).ok).toBe(false);
      }
      for (const who of [U.E1, U.E4, U.X, U.CA]) {
        await s.as(who);
        expect(await s.value<number>("select count(*)::int from retainer_runs")).toBe(0);
        expect(await s.value<number>("select count(*)::int from retainer_drafts")).toBe(0);
        expect(await s.value<number>("select count(*)::int from retainer_draft_queue")).toBe(0);
        expect(await s.value<number>("select count(*)::int from client_timeline_events where event_type = 'invoice_drafted'")).toBe(0);
      }
    });
  });
});

describe("invoice reminders and the collection forecast (§7.9.5)", () => {
  it("keeps one row per reminder slot and only known statuses", async () => {
    await db.asRole(U.M1, async (s) => {
      const insert = (key: string, status = "sent") =>
        s.attempt(
          "insert into invoice_reminders (invoice_id, kind, scheduled_for, channel, reminder_key, offset_days, due_date, status) values ($1, 'after_due', now(), 'email', $2, 7, '2026-09-15', $3)",
          [F.invoiceSent("A"), key, status],
        );
      expect((await insert("after_due:7")).ok).toBe(true);
      const dup = await insert("after_due:7");
      expect(dup.ok).toBe(false);
      if (!dup.ok) expect(dup.code).toBe(SQLSTATE.uniqueViolation);
      const bad = await insert("after_due:15", "delivered");
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.code).toBe(SQLSTATE.checkViolation);
      const dismissed = await s.attempt(
        "insert into invoice_reminders (invoice_id, kind, scheduled_for, channel, reminder_key, status) values ($1, 'after_due', now(), 'whatsapp_handoff', 'after_due:1', 'dismissed')",
        [F.invoiceSent("A")],
      );
      expect(dismissed.ok).toBe(false);
    });
  });

  it("forecasts from the latest promise: the balance when promised, what came in since, kept or open", async () => {
    await db.asRole(U.M1, async (s) => {
      await s.exec(
        "insert into invoice_follow_ups (invoice_id, channel, notes, promised_payment_date, by_user) values ($1, 'call', 'Accountant will pay by month end', '2099-12-31', $2)",
        [F.invoiceSent("A"), U.M1.id],
      );
      const f = await s.one<{ promised_amount: string; settled_since_promise: string; promise_status: string; outstanding_amount: string }>(
        "select promised_amount::text, settled_since_promise::text, promise_status, outstanding_amount::text from collection_forecast where invoice_id = $1",
        [F.invoiceSent("A")],
      );
      expect(f).toMatchObject({ settled_since_promise: "0.00", promise_status: "open" });
      expect(f.promised_amount).toBe(f.outstanding_amount);
      // A later follow-up without a promise doesn't replace the promise.
      await s.exec("insert into invoice_follow_ups (invoice_id, channel, notes, by_user) values ($1, 'email', 'Sent the statement', $2)", [F.invoiceSent("A"), U.M1.id]);
      expect(await s.value("select promised_payment_date::text from collection_forecast where invoice_id = $1", [F.invoiceSent("A")])).toBe("2099-12-31");
      for (const who of [U.E1, U.CA]) {
        await s.as(who);
        expect(await s.value<number>("select count(*)::int from collection_forecast")).toBe(0);
        expect((await s.attempt("insert into invoice_follow_ups (invoice_id, channel, notes, by_user) values ($1, 'call', 'x', $2)", [F.invoiceSent("A"), who.id])).ok).toBe(false);
      }
    });
  });
});

describe("payments_dashboard and revenue_ledger (§7.9.5, §7.9.10)", () => {
  it("gives a Partner the receivables picture and refuses a Manager and an Employee", async () => {
    await db.asRole(U.P1, async (s) => {
      const d = await s.value<{
        receivables: { outstanding: string; count: number; overdue_count: number };
        ageing: Array<{ bucket: string; count: number; amount: string }>;
        top_debtors: Array<{ client_id: string; outstanding: string }>;
        monthly: Array<{ month: string; collected: string }>;
        collection: Record<string, string>;
      }>("select public.payments_dashboard('2026-10-23')");
      // Each fixture client's sent invoice: 5,900 − 1,000 received − 118 credited = 4,782 outstanding.
      expect(d.receivables).toMatchObject({ outstanding: "14346.00", count: 3, overdue_count: 3 });
      expect(d.ageing.map((a) => a.bucket)).toEqual(["0_30", "31_60", "61_90", "90_plus"]);
      expect(d.ageing.find((a) => a.bucket === "31_60")).toMatchObject({ count: 3, amount: "14346.00" });
      expect(d.top_debtors).toHaveLength(3);
      expect(d.monthly).toHaveLength(12);
      expect(d.monthly.find((m) => m.month === "2026-09")?.collected).toBe("3000.00");
      expect(d.collection.collected).toBe("3000.00");
      expect(d.collection.billed).toBe("17700.00");

      for (const who of [U.M1, U.E1, U.CA]) {
        await s.as(who);
        expect(userMessage(await s.fails("select public.payments_dashboard('2026-10-23')"))).toMatch(/for Partners/);
      }
    });
  });

  it("lists the invoice, receipt and credit-note ledgers with totals for Partners and Managers only", async () => {
    await db.asRole(U.M1, async (s) => {
      // The three fixture invoices that were sent; the drafts are left out.
      const inv = await s.value<{ total: number; totals: Record<string, string | number>; rows: Array<{ client_id: string }> }>(
        "select public.revenue_ledger($1::jsonb)",
        [JSON.stringify({ kind: "invoices", from: "2026-04-01", to: "2027-03-31", sort: "client", dir: "asc" })],
      );
      expect(inv.total).toBe(3);
      expect(inv.rows.map((r) => r.client_id)).toEqual([C.A, C.B, C.C]);
      expect(inv.totals).toMatchObject({ taxable: "15000.00", cgst: "1350.00", sgst: "1350.00", total: "17700.00", received: "3000.00", credited: "354.00", outstanding: "14346.00" });
      const one = await s.value<{ total: number }>("select public.revenue_ledger($1::jsonb)", [JSON.stringify({ kind: "invoices", from: "2026-04-01", to: "2027-03-31", q: "Beta" })]);
      expect(one.total).toBe(1);
      const rec = await s.value<{ total: number; totals: Record<string, string | number> }>("select public.revenue_ledger($1::jsonb)", [
        JSON.stringify({ kind: "receipts", from: "2026-04-01", to: "2027-03-31" }),
      ]);
      expect(rec).toMatchObject({ total: 3, totals: { received: "3000.00", tds: "0.00" } });
      const cn = await s.value<{ total: number; totals: Record<string, string | number> }>("select public.revenue_ledger($1::jsonb)", [
        JSON.stringify({ kind: "credit_notes", from: "2026-01-01", to: "2027-12-31", q: "Alpha" }),
      ]);
      expect(cn.total).toBe(1);
      expect(userMessage(await s.fails("select public.revenue_ledger($1::jsonb)", [JSON.stringify({ kind: "invoices", from: "2026-10-01", to: "2026-09-01" })]))).toMatch(/Choose a period/);
      await s.as(U.E1);
      expect(userMessage(await s.fails("select public.revenue_ledger($1::jsonb)", [JSON.stringify({ kind: "invoices", from: "2026-04-01", to: "2027-03-31" })]))).toMatch(/Partners and Managers/);
    });
  });
});

describe("TDS credits (§7.9.9)", () => {
  async function receiptWithTds(s: Session, tds: number, opts: { tan?: string | null; quarter?: string } = {}): Promise<{ id: string; updated_at: string }> {
    await s.as("super");
    const id = fid(`tds-receipt:${Math.random()}`);
    await s.exec(
      `insert into payment_receipts (id, receipt_number, invoice_id, payment_date, amount_received, tds_amount, tds_section, method, recorded_by, tds_quarter, deductor_tan)
       values ($1, $2, $3, '2026-10-05', 0, $4, '194J', 'bank_transfer', $5, $6, $7)`,
      [id, `TW-R/26-27/T${Math.floor(Math.random() * 1e6)}`, F.invoiceSent("A"), tds, U.P1.id, opts.quarter ?? "Q3 2026-27", opts.tan === undefined ? "BLRA12345B" : opts.tan],
    );
    return s.one<{ id: string; updated_at: string }>("select id, updated_at::text from payment_receipts where id = $1", [id]);
  }

  it("moves Expected → Reflected → Claimed by hand, refuses a claim before it reflects, and refuses stale rows", async () => {
    await db.asSuper(async (s) => {
      const r = await receiptWithTds(s, 500);
      await s.as(U.M1);
      const item = () => s.value<{ id: string; updated_at: string }>("select jsonb_build_object('id', id, 'updated_at', updated_at) from payment_receipts where id = $1", [r.id]);
      expect(userMessage(await s.fails("select public.set_tds_credit_status(jsonb_build_array($1::jsonb), 'claimed', null, null, 'ITR for tax year 2026-27')", [JSON.stringify(await item())]))).toMatch(
        /Mark it Reflected first/,
      );
      const stale = { id: r.id, updated_at: "2020-01-01T00:00:00Z" };
      expect(userMessage(await s.fails("select public.set_tds_credit_status(jsonb_build_array($1::jsonb), 'reflected')", [JSON.stringify(stale)]))).toMatch(/changed since you loaded/);
      const ok = await s.value<{ updated: number }>("select public.set_tds_credit_status(jsonb_build_array($1::jsonb), 'reflected', '2026-10-20', 'Seen in 26AS')", [JSON.stringify(await item())]);
      expect(ok.updated).toBe(1);
      expect(await s.one("select tds_status, tds_reflected_on::text from payment_receipts where id = $1", [r.id])).toEqual({ tds_status: "reflected", tds_reflected_on: "2026-10-20" });
      expect(userMessage(await s.fails("select public.set_tds_credit_status(jsonb_build_array($1::jsonb), 'claimed')", [JSON.stringify(await item())]))).toMatch(/Say where the credit was claimed/);
      await s.value("select public.set_tds_credit_status(jsonb_build_array($1::jsonb), 'claimed', null, null, 'ITR for tax year 2026-27')", [JSON.stringify(await item())]);
      expect(await s.value("select tds_claimed_in from payment_receipts where id = $1", [r.id])).toBe("ITR for tax year 2026-27");
      expect(await s.value("select tds_status from tds_credit_register where id = $1", [r.id])).toBe("claimed");

      await s.as(U.E1);
      expect(await s.value<number>("select count(*)::int from tds_credit_register")).toBe(0);
      expect((await s.attempt("select public.set_tds_credit_status(jsonb_build_array($1::jsonb), 'expected')", [JSON.stringify({ id: r.id, updated_at: r.updated_at })])).ok).toBe(false);
    });
  });

  it("imports a statement: re-checks each match, reflects the matched receipts, records mismatches and skips duplicates", async () => {
    await db.asSuper(async (s) => {
      const a = await receiptWithTds(s, 1000);
      const b1 = await receiptWithTds(s, 300);
      const b2 = await receiptWithTds(s, 200);
      const reversed = await receiptWithTds(s, 700);
      await s.exec("update payment_receipts set reversed_at = now(), reversed_by = $2, reversal_reason = 'Cheque bounced' where id = $1", [reversed.id, U.P1.id]);
      await s.as(U.M1);
      const payload = {
        financial_year: "2026-27",
        source: "26as",
        file_name: "26AS-2026-27.txt",
        entries: [
          { tan: "BLRA12345B", name: "Alpha Traders", section: "194J", transaction_date: "2026-10-05", amount_paid: "10000", tds_amount: "1000.00", booking_status: "F", booking_date: "2026-10-18", match: { status: "matched", receipt_ids: [a.id] } },
          { tan: "BLRA12345B", name: "Alpha Traders", section: "194J", transaction_date: "2026-10-06", amount_paid: "5000", tds_amount: "500.00", match: { status: "matched", receipt_ids: [b1.id, b2.id] } },
          { tan: "BLRA12345B", name: "Alpha Traders", section: "194J", transaction_date: "2026-10-07", amount_paid: "7000", tds_amount: "700.00", match: { status: "matched", receipt_ids: [reversed.id] } },
          { tan: "MUMB99999Z", name: "Someone Else", section: "194J", transaction_date: "2026-10-07", tds_amount: "250.00", match: { status: "unmatched" } },
        ],
      };
      const r = await s.value<Record<string, number>>("select public.import_tds_statement($1::jsonb)", [JSON.stringify(payload)]);
      expect(r).toMatchObject({ rows: 4, matched: 2, unmatched: 2, duplicates: 0, receipts_reflected: 3 });
      expect(await s.rows("select tds_status, tds_reflected_on::text from payment_receipts where id = any($1) order by tds_amount", [[a.id, b1.id, b2.id]])).toEqual([
        { tds_status: "reflected", tds_reflected_on: expect.any(String) },
        { tds_status: "reflected", tds_reflected_on: expect.any(String) },
        { tds_status: "reflected", tds_reflected_on: "2026-10-18" },
      ]);
      expect(await s.value<number>("select count(*)::int from tds_statement_matches")).toBe(3);
      expect(await s.value("select match_status from tds_statement_entries where tds_amount = 700")).toBe("unmatched");

      const again = await s.value<Record<string, number>>("select public.import_tds_statement($1::jsonb)", [JSON.stringify(payload)]);
      expect(again).toMatchObject({ rows: 0, duplicates: 4 });

      // Undoing a match by hand puts the line back to unmatched.
      const item = await s.value("select jsonb_build_object('id', id, 'updated_at', updated_at) from payment_receipts where id = $1", [a.id]);
      await s.value("select public.set_tds_credit_status(jsonb_build_array($1::jsonb), 'expected')", [JSON.stringify(item)]);
      expect(await s.value("select match_status from tds_statement_entries where tds_amount = 1000")).toBe("unmatched");

      const other = await s.value<string>("select id from tds_statement_entries where deductor_tan = 'MUMB99999Z'");
      expect(userMessage(await s.fails("select public.set_tds_entry_status($1, 'ignored')", [other]))).toMatch(/Say why/);
      expect(await s.value("select (public.set_tds_entry_status($1, 'ignored', 'Not a client: a supplier''s refund')) ->> 'match_status'", [other])).toBe("ignored");

      await s.as(U.E1);
      expect(await s.value<number>("select count(*)::int from tds_statement_imports")).toBe(0);
      expect(await s.value<number>("select count(*)::int from tds_statement_matches")).toBe(0);
      expect((await s.attempt("select public.import_tds_statement($1::jsonb)", [JSON.stringify(payload)])).ok).toBe(false);
    });
  });

  it("records the deductor's TAN on a receipt that has none, with the concurrency check", async () => {
    await db.asSuper(async (s) => {
      const r = await receiptWithTds(s, 400, { tan: null });
      await s.as(U.M1);
      expect(userMessage(await s.fails("select public.set_receipt_deductor_tan($1, 'BAD', $2::timestamptz)", [r.id, r.updated_at]))).toMatch(/4 letters, 5 digits/);
      expect(userMessage(await s.fails("select public.set_receipt_deductor_tan($1, 'BLRA12345B', '2020-01-01')", [r.id]))).toMatch(/changed since/);
      const ok = await s.value<{ deductor_tan: string }>("select public.set_receipt_deductor_tan($1, ' blra12345b ', $2::timestamptz)", [r.id, r.updated_at]);
      expect(ok.deductor_tan).toBe("BLRA12345B");
    });
  });
});
