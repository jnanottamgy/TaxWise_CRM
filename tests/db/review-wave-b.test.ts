/**
 * Wave B review: the holes the adversarial review found, each pinned by a test.
 */
import { describe, expect, it } from "vitest";
import { C, U, setupTestDatabase, userMessage, type Session } from "./helpers";

const db = setupTestDatabase("review_wave_b");

function invLine(over: Record<string, unknown> = {}) {
  return { description: "GST compliance for October 2026", service_type: "gst", sac_code: "998231", quantity: 1, rate: 10000, tax_rate: 18, is_reimbursement: false, ...over };
}

async function limits(s: Session, back: typeof U.P1, invoice: number | null, quotation: number | null) {
  await s.as("super");
  await s.exec("update firm_settings set invoice_approval_limit = $1, quotation_approval_limit = $2 where id = 1", [invoice, quotation]);
  await s.as(back);
}

async function saveInvoice(s: Session, payload: Record<string, unknown>) {
  return s.value<{ id: string; updated_at: string; total_amount: number; requires_approval: boolean }>("select public.save_invoice_draft($1::jsonb)", [
    JSON.stringify({ client_id: C.A, lines: [invLine()], ...payload }),
  ]);
}

async function invoiceAt(s: Session, id: string) {
  return s.value<string>("select updated_at::text from invoices where id = $1", [id]);
}

const header = (over: Record<string, unknown> = {}) => ({
  client_id: C.A,
  client_name: "Client A",
  client_email: "a@client.test",
  valid_until: "2099-12-31",
  ...over,
});
const qLine = (over: Record<string, unknown> = {}) => ({ description: "Annual GST compliance", service_type: "gst", frequency: "annual", quantity: 1, unit_price: 100000, tax_rate: 18, ...over });

async function saveQuotation(s: Session, items: unknown[]) {
  return s.one<{ id: string; updated_at: string; total: string }>("select * from public.save_quotation(null, null, $1::jsonb, $2::jsonb)", [JSON.stringify(header()), JSON.stringify(items)]);
}

describe("invoice approval gate can't be bypassed with direct writes (§7.9.2)", () => {
  it("lines added straight to a draft under the limit don't let it issue without approval", async () => {
    await db.asRole(U.M1, async (s) => {
      await limits(s, U.M1, 50000, 50000);
      const r = await saveInvoice(s, {});
      expect(r.requires_approval).toBe(false);
      await s.exec(
        "insert into invoice_items (invoice_id, description, sac_code, quantity, rate, amount, tax_rate, sort_order) values ($1, 'Statutory audit', '998221', 1, 500000, 500000, 18, 2)",
        [r.id],
      );
      const e = await s.fails("select public.issue_invoice($1, $2::timestamptz, null)", [r.id, await invoiceAt(s, r.id)]);
      expect(userMessage(e)).toMatch(/lines don't add up to the invoice's totals/);
    });
  });

  it("a total lowered by hand on a draft doesn't let it issue", async () => {
    await db.asRole(U.M1, async (s) => {
      await limits(s, U.M1, 50000, 50000);
      const r = await saveInvoice(s, { lines: [invLine({ rate: 40000 })] });
      await s.exec("update invoices set taxable_amount = 100, cgst_amount = 9, sgst_amount = 9, total_amount = 118 where id = $1", [r.id]);
      const e = await s.fails("select public.issue_invoice($1, $2::timestamptz, null)", [r.id, await invoiceAt(s, r.id)]);
      expect(userMessage(e)).toMatch(/lines don't add up to the invoice's totals/);
    });
  });

  it("a line whose amount isn't quantity × rate is corrected when written", async () => {
    await db.asRole(U.M1, async (s) => {
      const r = await saveInvoice(s, {});
      await s.exec("update invoice_items set amount = 1 where invoice_id = $1", [r.id]);
      expect(await s.value("select amount::text from invoice_items where invoice_id = $1", [r.id])).toBe("10000.00");
    });
  });

  it("a session creates invoices only as drafts and issues them only through issue_invoice", async () => {
    await db.asRole(U.P1, async (s) => {
      const e = await s.fails(
        `insert into invoices (client_id, issue_date, due_date, status, place_of_supply_code, taxable_amount, cgst_amount, sgst_amount, total_amount, created_by)
         values ($1, '2026-10-01', '2026-10-16', 'sent', '29', 10000, 900, 900, 11800, $2)`,
        [C.A, U.P1.id],
      );
      expect(userMessage(e)).toBe("An invoice starts as a draft. Save it, then issue it: that is when it takes its number.");
      const r = await saveInvoice(s, {});
      expect(userMessage(await s.fails("update invoices set status = 'sent' where id = $1", [r.id]))).toBe(
        "Issue the invoice from its page. That is where it takes its number and the Rule 46 checks run.",
      );
      expect(await s.value("select invoice_number from invoices where id = $1", [r.id])).toBeNull();
    });
  });

  it("a draft saved through save_invoice_draft still issues", async () => {
    await db.asRole(U.M1, async (s) => {
      await limits(s, U.M1, 50000, 50000);
      const r = await saveInvoice(s, { lines: [invLine(), invLine({ description: "ROC fee paid on your behalf", sac_code: "9982", rate: 600, is_reimbursement: true })], round_off: true });
      const issued = await s.value<{ status: string }>("select public.issue_invoice($1, $2::timestamptz, null)", [r.id, await invoiceAt(s, r.id)]);
      expect(issued.status).toBe("sent");
    });
  });
});

describe("quotation approval gate can't be bypassed with direct writes (§7.5.2, §18.3 Manager 2)", () => {
  it("a total zeroed by hand doesn't let a Manager send an over-limit quotation", async () => {
    await db.asRole(U.M1, async (s) => {
      await limits(s, U.M1, 50000, 50000);
      const q = await saveQuotation(s, [qLine()]);
      await s.exec("update quotations set subtotal = 0, tax_amount = 0, total = 0 where id = $1", [q.id]);
      expect(await s.value("select total::text from quotations where id = $1", [q.id])).toBe("118000.00");
      const e = await s.fails("update quotations set status = 'sent', sent_at = now() where id = $1", [q.id]);
      expect(userMessage(e)).toBe("This quotation is over the quotation approval limit. Submit it for a Partner's approval first.");
    });
  });

  it("lines can't be added to an empty quotation after it was sent", async () => {
    await db.asRole(U.M1, async (s) => {
      await limits(s, U.M1, 50000, 50000);
      const q = await saveQuotation(s, []);
      await s.exec("update quotations set status = 'sent', sent_at = now() where id = $1", [q.id]);
      const e = await s.fails(
        "insert into quotation_items (quotation_id, description, quantity, unit_price, tax_rate, tax_amount, total) values ($1, 'Audit', 1, 900000, 18, 0, 0)",
        [q.id],
      );
      expect(userMessage(e)).toBe("This quotation is sent and its lines can't be changed. Revise it to change the terms.");
    });
  });

  it("revise still copies the lines into the new draft", async () => {
    await db.asRole(U.P1, async (s) => {
      const q = await saveQuotation(s, [qLine(), qLine({ description: "Tax audit", unit_price: 50000 })]);
      await s.rows("select * from public.mark_quotation_sent($1, null, 'internal_note', null)", [q.id]);
      const r = await s.one<{ id: string }>("select * from public.revise_quotation($1, null)", [q.id]);
      expect(await s.value("select count(*)::int from quotation_items where quotation_id = $1", [r.id])).toBe(2);
      expect(await s.value("select total::text from quotations where id = $1", [r.id])).toBe("177000.00");
    });
  });
});

async function issuedInvoice(s: Session, back: typeof U.P1, issueDate: string): Promise<string> {
  await s.as("super");
  const id = await s.value<string>(
    `insert into invoices (invoice_number, client_id, issue_date, due_date, status, place_of_supply_code, taxable_amount, cgst_amount, sgst_amount, total_amount, created_by)
     values ('TW/RV/' || substr(md5(random()::text), 1, 6), $1, $2::date, $2::date + 15, 'draft', '29', 10000, 900, 900, 11800, $3) returning id`,
    [C.A, issueDate, U.P1.id],
  );
  await s.exec("insert into invoice_items (invoice_id, description, sac_code, rate, amount, tax_rate) values ($1, 'Audit fee', '998221', 10000, 10000, 18)", [id]);
  await s.exec("update invoices set status = 'sent' where id = $1", [id]);
  await s.as(back);
  return id;
}

describe("s.34 is judged on the day a credit note is issued (§6.4, §18.3 Partner 6)", () => {
  it("a tax-reducing credit note backdated inside the deadline is refused once the deadline has passed", async () => {
    await db.asRole(U.P1, async (s) => {
      const today = await s.value<string>("select public.today_ist()::text");
      const yesterday = await s.value<string>("select (public.today_ist() - 1)::text");
      const sameFy = await s.value<boolean>("select public.financial_year_label(public.today_ist()) = public.financial_year_label(public.today_ist() - 1)");
      if (!sameFy) return; // 1 April: the credit-note series refuses a date in the old FY anyway.
      const id = await issuedInvoice(s, U.P1, await s.value<string>("select (public.today_ist() - 200)::text"));
      // The annual return for the invoice's FY was filed yesterday, so the s.34 deadline was yesterday.
      const e = await s.fails("select public.issue_credit_note($1::jsonb)", [
        JSON.stringify({ invoice_id: id, reason_code: "goodwill", reason: "Goodwill", taxable_amount: 1000, issue_date: yesterday, annual_return_filed_on: yesterday }),
      ]);
      expect(userMessage(e)).toMatch(/^A credit note that reduces GST had to be issued by .+ \(the annual return was filed\)\. You can still give a commercial credit/);
      const onTime = await s.attempt("select public.issue_credit_note($1::jsonb)", [
        JSON.stringify({ invoice_id: id, reason_code: "goodwill", reason: "Goodwill", taxable_amount: 1000, issue_date: today, reduces_gst: false }),
      ]);
      expect(onTime.ok).toBe(true);
    });
  });

  it("a credit note written straight into the table keeps to s.34 and the invoice's total", async () => {
    await db.asRole(U.P1, async (s) => {
      const old = await issuedInvoice(s, U.P1, "2024-06-01");
      const e = await s.fails(
        `insert into credit_notes (invoice_id, client_id, reason_code, reason, reduces_gst, taxable_amount, tax_rate, cgst_amount, sgst_amount, igst_amount, total_amount, place_of_supply_code, issue_date, issued_by)
         values ($1, $2, 'goodwill', 'x', true, 100, 18, 9, 9, 0, 118, '29', public.today_ist(), $3)`,
        [old, C.A, U.P1.id],
      );
      expect(userMessage(e)).toMatch(/^A credit note that reduces GST had to be issued by 30 Nov 2025/);
      const fresh = await issuedInvoice(s, U.P1, "2026-10-01");
      const over = await s.fails(
        `insert into credit_notes (invoice_id, client_id, reason_code, reason, reduces_gst, taxable_amount, tax_rate, cgst_amount, sgst_amount, igst_amount, total_amount, place_of_supply_code, issue_date, issued_by)
         values ($1, $2, 'goodwill', 'x', false, 20000, null, 0, 0, 0, 20000, '29', public.today_ist(), $3)`,
        [fresh, C.A, U.P1.id],
      );
      expect(userMessage(over)).toBe("Credit notes on this invoice would add up to more than its total of ₹11,800.00.");
    });
  });
});

describe("receipts keep §7.9.4's validation however they are written", () => {
  it("a receipt inserted directly can't overpay, be future-dated, or land on a draft", async () => {
    await db.asRole(U.M1, async (s) => {
      const id = await issuedInvoice(s, U.M1, "2026-10-01");
      const insert = (invoice: string, received: number, date = "2026-10-10") =>
        s.fails("insert into payment_receipts (invoice_id, payment_date, amount_received, method, recorded_by) values ($1, $2::date, $3, 'upi', $4)", [invoice, date, received, U.M1.id]);
      expect(userMessage(await insert(id, 50000))).toBe(
        "₹50,000.00 received and deducted is more than the ₹11,800.00 outstanding. Record only what settles this invoice, and record the advance separately.",
      );
      expect(userMessage(await insert(id, 100, "2099-01-01"))).toBe("The payment date can't be in the future.");
      const draft = await saveInvoice(s, {});
      expect(userMessage(await insert(draft.id, 100))).toBe("A payment is recorded only against an issued invoice that hasn't been cancelled or waived.");
      expect(await s.exec("insert into payment_receipts (invoice_id, payment_date, amount_received, method, recorded_by) values ($1, '2026-10-10', 11800, 'upi', $2)", [id, U.M1.id])).toBe(1);
      expect(await s.value("select status::text from invoices where id = $1", [id])).toBe("paid");
    });
  });
});
