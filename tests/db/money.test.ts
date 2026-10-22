/**
 * Money in the database (§5.7, §6.5, §7.9): the settlement trigger (receipts with TDS, reversals,
 * credit notes; Paid / Partially paid only from receipts), invoices_view's derived overdue (a draft
 * is never overdue), the freeze on issued invoices, receipts that are never deleted, the
 * Partner-only acts (approve, waive, credit note) and the portal's invoice view.
 */
import { describe, expect, it } from "vitest";
import { C, F, SQLSTATE, U, setupTestDatabase, userMessage, type Session } from "./helpers";

const db = setupTestDatabase("money");

type Inv = { status: string; amount_received: string; tds_credited: string; credit_noted: string; outstanding_amount: string };

/** A sent intra-state invoice of ₹11,800 (₹10,000 + 9% CGST + 9% SGST) for client A, as M1. */
async function sentInvoice(s: Session, opts: { issue?: string; due?: string; status?: string } = {}): Promise<string> {
  await s.as(U.M1);
  return s.value<string>(
    `insert into invoices (client_id, issue_date, due_date, status, place_of_supply_code, taxable_amount, cgst_amount, sgst_amount, total_amount, created_by)
     values ($1, $2::date, $3::date, $4::invoice_status, '29', 10000, 900, 900, 11800, $5) returning id`,
    [C.A, opts.issue ?? "2026-10-01", opts.due ?? "2026-10-16", opts.status ?? "sent", U.M1.id],
  );
}

const settlement = (s: Session, id: string) =>
  s.one<Inv>("select status::text, amount_received::text, tds_credited::text, credit_noted::text, outstanding_amount::text from invoices where id = $1", [id]);

async function receipt(s: Session, invoiceId: string, amount: number, tds = 0): Promise<string> {
  return s.value<string>(
    `insert into payment_receipts (invoice_id, payment_date, amount_received, tds_amount, tds_section, method, recorded_by)
     values ($1, '2026-10-20', $2, $3, case when $3::numeric > 0 then '194J' end, 'bank_transfer', $4) returning id`,
    [invoiceId, amount, tds, U.M1.id],
  );
}

describe("settlement trigger (§6.5, §7.9.3, §7.9.4)", () => {
  it("a receipt with TDS settles the invoice: outstanding = total − received − TDS, and Paid is derived", async () => {
    await db.asSuper(async (s) => {
      const id = await sentInvoice(s);
      expect(await settlement(s, id)).toEqual({ status: "sent", amount_received: "0.00", tds_credited: "0.00", credit_noted: "0.00", outstanding_amount: "11800.00" });
      await receipt(s, id, 10800, 1000); // 10% TDS u/s 194J on ₹10,000
      expect(await settlement(s, id)).toEqual({ status: "paid", amount_received: "10800.00", tds_credited: "1000.00", credit_noted: "0.00", outstanding_amount: "0.00" });
    });
  });

  it("part-payments move it to Partially paid, then Paid; a reversal restores the balance", async () => {
    await db.asSuper(async (s) => {
      const id = await sentInvoice(s);
      const r1 = await receipt(s, id, 5000);
      expect(await settlement(s, id)).toMatchObject({ status: "partially_paid", outstanding_amount: "6800.00" });
      const r2 = await receipt(s, id, 6800);
      expect(await settlement(s, id)).toMatchObject({ status: "paid", outstanding_amount: "0.00" });
      await s.exec("update payment_receipts set reversed_at = now(), reversed_by = $2, reversal_reason = 'Cheque bounced' where id = $1", [r2, U.M1.id]);
      expect(await settlement(s, id)).toMatchObject({ status: "partially_paid", amount_received: "5000.00", outstanding_amount: "6800.00" });
      await s.exec("update payment_receipts set reversed_at = now(), reversed_by = $2, reversal_reason = 'Duplicate entry' where id = $1", [r1, U.M1.id]);
      expect(await settlement(s, id)).toEqual({ status: "sent", amount_received: "0.00", tds_credited: "0.00", credit_noted: "0.00", outstanding_amount: "11800.00" });
    });
  });

  it("a credit note reduces the outstanding (and can complete the settlement)", async () => {
    await db.asSuper(async (s) => {
      const id = await sentInvoice(s);
      await receipt(s, id, 10620);
      await s.as(U.P1);
      await s.exec(
        `insert into credit_notes (invoice_id, client_id, reason_code, reason, taxable_amount, cgst_amount, sgst_amount, total_amount, issued_by)
         values ($1, $2, 'fee_reduction', 'Agreed reduction', 1000, 90, 90, 1180, $3)`,
        [id, C.A, U.P1.id],
      );
      expect(await settlement(s, id)).toMatchObject({ status: "paid", credit_noted: "1180.00", outstanding_amount: "0.00" });
    });
  });

  it("Paid and Partially paid can't be set by hand against the settlement", async () => {
    await db.asSuper(async (s) => {
      const id = await sentInvoice(s);
      expect(userMessage(await s.fails("update invoices set status = 'paid' where id = $1", [id]))).toBe(
        "Paid and Partially paid come only from recorded receipts. With what has been received so far, this invoice is still unpaid.",
      );
      expect(userMessage(await s.fails("update invoices set status = 'partially_paid' where id = $1", [id]))).toMatch(/still unpaid/);
      await s.as(U.P1);
      expect(userMessage(await s.fails("update invoices set status = 'paid' where id = $1", [id]))).toMatch(/come only from recorded receipts/);
      await s.as("super");
      expect(userMessage(await s.fails("update invoices set status = 'paid' where id = $1", [id]))).toMatch(/come only from recorded receipts/);
      // hand-set settlement columns are recomputed, never trusted
      await s.as(U.M1);
      await s.exec("update invoices set outstanding_amount = 0, amount_received = 11800 where id = $1", [id]);
      expect(await settlement(s, id)).toMatchObject({ status: "sent", amount_received: "0.00", outstanding_amount: "11800.00" });
    });
  });

  it("receipts are never deleted and their amounts never change; a reversal needs a reason and stays reversed", async () => {
    await db.asSuper(async (s) => {
      const id = await sentInvoice(s);
      const r = await receipt(s, id, 1000);
      expect((await s.fails("delete from payment_receipts where id = $1", [r])).code).toBe(SQLSTATE.insufficientPrivilege);
      await s.as("super");
      expect(userMessage(await s.fails("delete from payment_receipts where id = $1", [r]))).toMatch(/never deleted/);
      await s.as(U.M1);
      expect(userMessage(await s.fails("update payment_receipts set amount_received = 2000 where id = $1", [r]))).toMatch(/can't be changed/);
      expect(userMessage(await s.fails("update payment_receipts set tds_amount = 10 where id = $1", [r]))).toMatch(/can't be changed/);
      expect((await s.fails("update payment_receipts set reversed_at = now() where id = $1", [r])).code).toBe(SQLSTATE.checkViolation);
      await s.exec("update payment_receipts set reversed_at = now(), reversed_by = $2, reversal_reason = 'Wrong invoice' where id = $1", [r, U.M1.id]);
      expect(userMessage(await s.fails("update payment_receipts set reversed_at = null where id = $1", [r]))).toMatch(/stays reversed/);
    });
  });

  it("a receipt is recorded in the recorder's own name, with a numbered receipt", async () => {
    await db.asSuper(async (s) => {
      const id = await sentInvoice(s);
      const forged = await s.attempt(
        "insert into payment_receipts (invoice_id, payment_date, amount_received, method, recorded_by) values ($1, '2026-10-20', 1, 'upi', $2)",
        [id, U.P1.id],
      );
      expect(forged.ok).toBe(false);
      const r = await receipt(s, id, 1);
      expect(await s.value("select receipt_number from payment_receipts where id = $1", [r])).toMatch(/^TW-R\/26-27\/\d{4}$/);
    });
  });
});

describe("invoices_view: derived overdue (§5.7, §14 'a draft invoice is never overdue')", () => {
  it("a draft past its due date is never overdue; a sent one with a balance is", async () => {
    await db.asRole(U.P1, async (s) => {
      const rows = await s.rows<{ id: string; is_overdue: boolean; display_status: string; days_overdue: number }>(
        "select id, is_overdue, display_status, days_overdue from invoices_view where id = any($1)",
        [[F.invoiceDraft("A"), F.invoiceSent("A")]],
      );
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      expect(byId[F.invoiceDraft("A")]).toMatchObject({ is_overdue: false, display_status: "draft", days_overdue: 0 });
      expect(byId[F.invoiceSent("A")]).toMatchObject({ is_overdue: true, display_status: "overdue" });
      expect(byId[F.invoiceSent("A")].days_overdue).toBeGreaterThan(0);
    });
  });

  it("not overdue once paid, cancelled, waived, disputed, awaiting approval, or before the due date", async () => {
    await db.asSuper(async (s) => {
      const paid = await sentInvoice(s, { issue: "2026-08-01", due: "2026-08-15" });
      await receipt(s, paid, 11800);
      const future = await sentInvoice(s, { issue: "2026-10-01", due: "2099-12-31" });
      const disputed = await sentInvoice(s, { issue: "2026-08-01", due: "2026-08-15" });
      await s.exec("update invoices set status = 'disputed', disputed_reason = 'Scope' where id = $1", [disputed]);
      const cancelled = await sentInvoice(s, { issue: "2026-08-01", due: "2026-08-15" });
      await s.exec("update invoices set cancelled_at = now(), cancelled_by = $2, cancel_reason = 'Reissued' where id = $1", [cancelled, U.M1.id]);
      const held = await sentInvoice(s, { issue: "2026-08-01", due: "2026-08-15", status: "awaiting_approval" });
      await s.as(U.P1);
      const waived = await sentInvoice(s, { issue: "2026-08-01", due: "2026-08-15" });
      await s.as(U.P1);
      await s.exec("update invoices set status = 'waived', waived_reason = 'Goodwill' where id = $1", [waived]);
      const rows = await s.rows<{ id: string; is_overdue: boolean; display_status: string }>(
        "select id, is_overdue, display_status from invoices_view where id = any($1)", [[paid, future, disputed, cancelled, held, waived]]);
      const by = Object.fromEntries(rows.map((r) => [r.id, r]));
      expect(by[paid]).toMatchObject({ is_overdue: false, display_status: "paid" });
      expect(by[future]).toMatchObject({ is_overdue: false, display_status: "sent" });
      expect(by[disputed]).toMatchObject({ is_overdue: false, display_status: "disputed" });
      expect(by[cancelled]).toMatchObject({ is_overdue: false, display_status: "cancelled" });
      expect(by[held]).toMatchObject({ is_overdue: false, display_status: "awaiting_approval" });
      expect(by[waived]).toMatchObject({ is_overdue: false, display_status: "waived" });
    });
  });

  it("the portal's view agrees and never lists drafts", async () => {
    await db.asRole(U.CA, async (s) => {
      expect(await s.rows("select id, is_overdue, display_status from portal_invoices")).toEqual([
        { id: F.invoiceSent("A"), is_overdue: true, display_status: "overdue" },
      ]);
    });
  });
});

describe("issued invoices are frozen (§7.9.3)", () => {
  it("numbers are assigned when an invoice leaves Draft; drafts have none", async () => {
    await db.asSuper(async (s) => {
      const id = await sentInvoice(s, { status: "draft" });
      expect(await s.value("select invoice_number from invoices where id = $1", [id])).toBeNull();
      await s.exec("update invoices set status = 'sent' where id = $1", [id]);
      expect(await s.value("select invoice_number from invoices where id = $1", [id])).toMatch(/^TW\/26-27\/\d{4}$/);
    });
  });

  it("amounts, client, number and lines can't change once issued; it can't go back to draft; cancelled stays cancelled", async () => {
    await db.asSuper(async (s) => {
      const id = await sentInvoice(s);
      for (const set of ["taxable_amount = 1, total_amount = 1801", `client_id = '${C.B}'`, "invoice_number = 'TW/26-27/9999'", "issue_date = '2026-10-02'"]) {
        expect(userMessage(await s.fails(`update invoices set ${set} where id = $1`, [id])), set).toMatch(/can't be edited/);
      }
      expect(userMessage(await s.fails("update invoices set status = 'draft' where id = $1", [id]))).toMatch(/can't go back to draft/);
      expect(userMessage(await s.fails(
        "insert into invoice_items (invoice_id, description, sac_code, rate, amount, tax_rate) values ($1, 'x', '998231', 1, 1, 18)", [id],
      ))).toMatch(/lines of an issued invoice/);
      // a line added while it was a draft is frozen once the invoice is issued
      const draft = await sentInvoice(s, { status: "draft" });
      await s.exec("insert into invoice_items (invoice_id, description, sac_code, rate, amount, tax_rate) values ($1, 'Fee', '998231', 10000, 10000, 18)", [draft]);
      await s.exec("update invoices set status = 'sent' where id = $1", [draft]);
      expect(userMessage(await s.fails("update invoice_items set amount = 1 where invoice_id = $1", [draft]))).toMatch(/lines of an issued invoice/);
      expect(userMessage(await s.fails("delete from invoice_items where invoice_id = $1", [draft]))).toMatch(/lines of an issued invoice/);
      await s.exec("update invoices set cancelled_at = now(), cancelled_by = $2, cancel_reason = 'Wrong GSTIN' where id = $1", [id, U.M1.id]);
      expect(userMessage(await s.fails("update invoices set cancelled_at = null where id = $1", [id]))).toMatch(/stays cancelled/);
    });
  });
});

describe("Partner-only acts (§4.1)", () => {
  it("only a Partner approves a held invoice, and a held invoice can't be sent before approval", async () => {
    await db.asSuper(async (s) => {
      const id = await sentInvoice(s, { status: "awaiting_approval" });
      await s.exec("update invoices set requires_approval = true where id = $1", [id]);
      expect(userMessage(await s.fails("update invoices set status = 'sent' where id = $1", [id]))).toMatch(/waiting for a Partner's approval/);
      expect(userMessage(await s.fails("update invoices set approved_by = $2, approved_at = now() where id = $1", [id, U.M1.id]))).toMatch(/Only a Partner can approve/);
      await s.as(U.P1);
      expect(await s.exec("update invoices set approved_by = $2, approved_at = now(), status = 'sent' where id = $1", [id, U.P1.id])).toBe(1);
    });
  });

  it("only a Partner waives an invoice", async () => {
    await db.asSuper(async (s) => {
      const id = await sentInvoice(s);
      expect(userMessage(await s.fails("update invoices set status = 'waived', waived_reason = 'x' where id = $1", [id]))).toMatch(/Only a Partner can waive/);
      await s.as(U.P1);
      expect(await s.exec("update invoices set status = 'waived', waived_reason = 'Goodwill' where id = $1", [id])).toBe(1);
    });
  });

  it("only a Partner issues a credit note, in their own name", async () => {
    await db.asSuper(async (s) => {
      const id = await sentInvoice(s);
      const sql = `insert into credit_notes (invoice_id, client_id, reason_code, reason, taxable_amount, total_amount, issued_by) values ($1, $2, 'error', 'Typo', 100, 118, $3)`;
      expect((await s.fails(sql, [id, C.A, U.M1.id])).code).toBe(SQLSTATE.insufficientPrivilege);
      await s.as(U.P1);
      expect((await s.fails(sql, [id, C.A, U.P2.id])).code).toBe(SQLSTATE.insufficientPrivilege);
      expect(await s.exec(sql, [id, C.A, U.P1.id])).toBe(1);
      expect(await s.value("select credit_note_number from credit_notes where invoice_id = $1", [id])).toMatch(/^TW-CN\/26-27\/\d{4}$/);
      expect((await s.fails("delete from credit_notes where invoice_id = $1", [id])).code).toBe(SQLSTATE.insufficientPrivilege);
    });
  });

  it("Managers raise and send invoices; only a Partner purges one", async () => {
    await db.asSuper(async (s) => {
      const id = await sentInvoice(s, { status: "draft" });
      expect(await s.exec("delete from invoices where id = $1", [id])).toBe(0);
      await s.as(U.P1);
      expect(await s.exec("delete from invoices where id = $1", [id])).toBe(1);
    });
  });
});

describe("portal payment claims (§7.22 'I've paid')", () => {
  it("a client claims payment on its own issued invoice; the claim never marks it paid", async () => {
    await db.asRole(U.CA, async (s) => {
      expect(await s.exec("insert into portal_payment_claims (invoice_id, client_id, created_by) values ($1, $2, $3)", [F.invoiceSent("A"), C.A, U.CA.id])).toBe(1);
      expect((await s.attempt("insert into portal_payment_claims (invoice_id, client_id, created_by) values ($1, $2, $3)", [F.invoiceDraft("A"), C.A, U.CA.id])).ok).toBe(false);
      expect((await s.attempt("insert into portal_payment_claims (invoice_id, client_id, created_by, status) values ($1, $2, $3, 'verified')", [F.invoiceSent("A"), C.A, U.CA.id])).ok).toBe(false);
      expect(await s.exec("update portal_payment_claims set status = 'verified'")).toBe(0);
      expect(await s.value("select status::text from portal_invoices where id = $1", [F.invoiceSent("A")])).toBe("partially_paid");
    });
  });
});
