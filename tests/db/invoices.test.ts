/**
 * Invoicing in the database (§6.3–§6.5, §7.9.1–§7.9.4, §7.9.7, §18.3 Partner 5–6, Manager 5):
 * save_invoice_draft's totals and checks, the approval gate through approve / return / issue, the
 * number and snapshots at issue, unbilled time, receipts with TDS and the ₹1 tolerance, reversals,
 * credit notes and the s.34 deadline, cancel & reissue before GSTR-1 reporting, disputes, waivers,
 * the list with its totals, the portal's line and credit-note views, and role refusals.
 */
import { describe, expect, it } from "vitest";
import { C, F, U, setupTestDatabase, userMessage, type Session } from "./helpers";

const db = setupTestDatabase("invoices");

type Saved = { id: string; status: string; updated_at: string; requires_approval: boolean; total_amount: string; taxable_amount: string; cgst_amount: string; sgst_amount: string; igst_amount: string; reimbursement_amount: string; round_off: string };

function line(over: Record<string, unknown> = {}) {
  return { description: "GST compliance for October 2026", service_type: "gst", sac_code: "998231", quantity: 1, rate: 10000, tax_rate: 18, is_reimbursement: false, ...over };
}

async function save(s: Session, payload: Record<string, unknown>): Promise<Saved> {
  return s.value<Saved>("select public.save_invoice_draft($1::jsonb)", [JSON.stringify({ client_id: C.A, lines: [line()], ...payload })]);
}

async function issue(s: Session, id: string, channel: string | null = null) {
  const at = await s.value<string>("select updated_at::text from invoices where id = $1", [id]);
  return s.value<{ invoice_number: string; status: string; updated_at: string }>("select public.issue_invoice($1, $2::timestamptz, $3)", [id, at, channel]);
}

async function updatedAt(s: Session, id: string): Promise<string> {
  return s.value<string>("select updated_at::text from invoices where id = $1", [id]);
}

async function asSuperThen(s: Session, sql: string, params: unknown[], then: typeof U.P1) {
  await s.as("super");
  await s.exec(sql, params);
  await s.as(then);
}

describe("save_invoice_draft (§6.3, §6.4, §7.9.2)", () => {
  it("computes the totals per line: CGST + SGST in Karnataka, reimbursements untaxed and outside the taxable value", async () => {
    await db.asRole(U.M1, async (s) => {
      const r = await save(s, {
        lines: [line(), line({ description: "ROC filing fee paid on your behalf", sac_code: "9982", rate: 600, tax_rate: 18, is_reimbursement: true })],
      });
      expect(r).toMatchObject({ status: "draft", taxable_amount: 10000, cgst_amount: 900, sgst_amount: 900, igst_amount: 0, reimbursement_amount: 600, total_amount: 12400 });
      const items = await s.rows<{ tax_rate: string; is_reimbursement: boolean; amount: string }>("select tax_rate::text, is_reimbursement, amount::text from invoice_items where invoice_id = $1 order by sort_order", [r.id]);
      expect(items).toEqual([
        { tax_rate: "18.00", is_reimbursement: false, amount: "10000.00" },
        { tax_rate: "0.00", is_reimbursement: true, amount: "600.00" },
      ]);
      expect(await s.value("select invoice_number from invoices where id = $1", [r.id])).toBeNull();
    });
  });

  it("rounds each line half-up and splits odd paise so CGST + SGST equals the tax", async () => {
    await db.asRole(U.M1, async (s) => {
      // 100.05 × 18% = 18.009 → 18.01; CGST round(9.005) = 9.01, SGST 9.00.
      const r = await save(s, { lines: [line({ rate: 100.05 })] });
      expect(r).toMatchObject({ taxable_amount: 100.05, cgst_amount: 9.01, sgst_amount: 9, total_amount: 118.06 });
      const ro = await save(s, { lines: [line({ rate: 100.05 })], round_off: true });
      expect(ro).toMatchObject({ round_off: -0.06, total_amount: 118 });
    });
  });

  it("charges IGST when the client's GSTIN is in another state", async () => {
    await db.asRole(U.M1, async (s) => {
      await asSuperThen(s, "update clients set gst_registration = 'registered', gstin = '27AABCB1234C1Z5' where id = $1", [C.B], U.M1);
      const r = await save(s, { client_id: C.B });
      expect(r).toMatchObject({ cgst_amount: 0, sgst_amount: 0, igst_amount: 1800, total_amount: 11800 });
      expect(await s.value("select place_of_supply_code from invoices where id = $1", [r.id])).toBe("27");
    });
  });

  it("needs a reason to override the place of supply, and for a GST rate outside the picker", async () => {
    await db.asRole(U.M1, async (s) => {
      expect(userMessage(await s.fails("select public.save_invoice_draft($1::jsonb)", [JSON.stringify({ client_id: C.A, place_of_supply_code: "33", lines: [line()] })]))).toBe(
        "Say why the place of supply is Tamil Nadu (33) rather than Karnataka (29).",
      );
      const ok = await save(s, { place_of_supply_code: "33", place_of_supply_reason: "Services performed for the Chennai branch" });
      expect(ok.igst_amount).toBe(1800);
      expect(userMessage(await s.fails("select public.save_invoice_draft($1::jsonb)", [JSON.stringify({ client_id: C.A, lines: [line({ tax_rate: 12 })] })]))).toBe(
        "Give a reason for the 12% GST rate on line 1.",
      );
    });
  });

  it("fills the SAC from the firm's map when a line has none", async () => {
    await db.asRole(U.M1, async (s) => {
      const r = await save(s, { lines: [line({ service_type: "audit", sac_code: "" })] });
      expect(await s.value("select sac_code from invoice_items where invoice_id = $1", [r.id])).toBe("998221");
    });
  });

  it("blocks the same engagement period on a second invoice (normalised label)", async () => {
    await db.asRole(U.M1, async (s) => {
      const e = await s.fails("select public.save_invoice_draft($1::jsonb)", [
        JSON.stringify({ client_id: C.A, billing_period_label: "sep  2026", lines: [line({ client_service_id: F.service("A") })] }),
      ]);
      expect(userMessage(e)).toMatch(/^sep {2}2026 is already billed for this engagement on .+\. Open it instead of raising another\.$/);
    });
  });

  it("refuses a stale edit with who changed it and when (§13)", async () => {
    await db.asRole(U.M1, async (s) => {
      const r = await save(s, {});
      const e = await s.fails("select public.save_invoice_draft($1::jsonb)", [
        JSON.stringify({ id: r.id, updated_at: "2020-01-01T00:00:00Z", client_id: C.A, lines: [line()] }),
      ]);
      expect(userMessage(e)).toMatch(/^Changed by Test M1 at \d{2}:\d{2}\. Reload to see their changes\.$/);
      const again = await save(s, { id: r.id, updated_at: r.updated_at, lines: [line({ rate: 20000 })] });
      expect(again.total_amount).toBe(23600);
    });
  });

  it("is refused for Employees and portal users", async () => {
    for (const who of [U.E1, U.CA]) {
      await db.asRole(who, async (s) => {
        expect(userMessage(await s.fails("select public.save_invoice_draft($1::jsonb)", [JSON.stringify({ client_id: C.A, lines: [line()] })]))).toBe(
          "Only Partners and Managers raise invoices.",
        );
      });
    }
  });
});

describe("approval gate (§7.9.2, §18.3 Partner 5)", () => {
  it("holds a Manager's invoice over the limit until a Partner approves; then it is sendable", async () => {
    await db.asRole(U.M1, async (s) => {
      await s.as("super");
      await s.exec("update firm_settings set invoice_approval_limit = 50000 where id = 1");
      await s.exec("update clients set address = '12, MG Road', city = 'Bengaluru', state_code = '29', pincode = '560001' where id = $1", [C.A]);
      await s.as(U.M1);
      const draft = await save(s, { lines: [line({ rate: 50000 })] }); // 59,000 incl. GST
      expect(draft).toMatchObject({ status: "draft", requires_approval: true });
      expect(userMessage(await s.fails("select public.issue_invoice($1, $2::timestamptz)", [draft.id, draft.updated_at]))).toBe(
        "This invoice is over the approval limit and waits for a Partner's approval before it can be sent.",
      );
      const submitted = await save(s, { id: draft.id, updated_at: draft.updated_at, lines: [line({ rate: 50000 })], submit: true });
      expect(submitted.status).toBe("awaiting_approval");

      // A Manager can't approve it.
      expect(userMessage(await s.fails("select public.approve_invoice($1, $2::timestamptz)", [draft.id, submitted.updated_at]))).toBe(
        "Only a Partner can approve an invoice that is awaiting approval.",
      );
      await s.as(U.P1);
      const approved = await s.value<{ status: string }>("select public.approve_invoice($1, $2::timestamptz)", [draft.id, submitted.updated_at]);
      expect(approved.status).toBe("draft");
      await s.as(U.M1);
      const issued = await issue(s, draft.id, "in_person");
      expect(issued.status).toBe("sent");
      expect(issued.invoice_number).toMatch(/^TW\/\d{2}-\d{2}\/\d{4}$/);
    });
  });

  it("a Partner returns a held invoice with a note; it stays gated", async () => {
    await db.asRole(U.M1, async (s) => {
      await asSuperThen(s, "update firm_settings set invoice_approval_limit = 1000 where id = 1", [], U.M1);
      const r = await save(s, { submit: true });
      expect(r.status).toBe("awaiting_approval");
      await s.as(U.P1);
      expect(userMessage(await s.fails("select public.return_invoice($1, '', $2::timestamptz)", [r.id, r.updated_at]))).toMatch(/Write a note/);
      const back = await s.value<{ status: string }>("select public.return_invoice($1, 'Bill September separately', $2::timestamptz)", [r.id, r.updated_at]);
      expect(back.status).toBe("draft");
      const row = await s.one<{ approval_note: string; requires_approval: boolean }>("select approval_note, requires_approval from invoices where id = $1", [r.id]);
      expect(row).toEqual({ approval_note: "Bill September separately", requires_approval: true });
    });
  });
});

describe("issue_invoice (§6.4 Rule 46, §7.9.2, §7.9.3)", () => {
  it("numbers it from the locked series and snapshots the client and firm", async () => {
    await db.asRole(U.P1, async (s) => {
      await asSuperThen(s, "update clients set address = '12, MG Road', city = 'Bengaluru', state_code = '29', pincode = '560001', legal_name = 'Alpha Traders Private Limited' where id = $1", [C.A], U.P1);
      const r = await save(s, {});
      const issued = await issue(s, r.id, "in_person");
      const row = await s.one<Record<string, unknown>>(
        "select invoice_number, status::text, client_name_snapshot, client_address_snapshot, client_state_snapshot, firm_gstin_snapshot::text, signatory_name, sent_channels, issued_by from invoices where id = $1",
        [r.id],
      );
      expect(row).toMatchObject({
        invoice_number: issued.invoice_number,
        status: "sent",
        client_name_snapshot: "Alpha Traders Private Limited",
        client_address_snapshot: "12, MG Road, Bengaluru, Karnataka 560001",
        client_state_snapshot: "29",
        firm_gstin_snapshot: "29AAXFT1811B1Z3",
        signatory_name: "Test P1",
        sent_channels: ["in_person"],
        issued_by: U.P1.id,
      });
      expect(String(row.invoice_number).length).toBeLessThanOrEqual(16);
    });
  });

  it("an issued invoice is never edited: lines and printed content are frozen", async () => {
    await db.asRole(U.P1, async (s) => {
      const r = await save(s, {});
      await issue(s, r.id);
      expect(userMessage(await s.fails("update invoices set notes = 'changed' where id = $1", [r.id]))).toBe(
        "An issued invoice can't be edited. Cancel and reissue it, or raise a credit or debit note.",
      );
      expect(userMessage(await s.fails("update invoice_items set description = 'x' where invoice_id = $1", [r.id]))).toMatch(/lines of an issued invoice/);
      expect(userMessage(await s.fails("select public.save_invoice_draft($1::jsonb)", [JSON.stringify({ id: r.id, updated_at: await updatedAt(s, r.id), client_id: C.A, lines: [line()] })]))).toMatch(
        /An issued invoice can't be edited/,
      );
    });
  });

  it("refuses an unregistered client's invoice over ₹50,000 without their address and state", async () => {
    await db.asRole(U.P1, async (s) => {
      const r = await save(s, { client_id: C.C, lines: [line({ rate: 60000 })] });
      expect(userMessage(await s.fails("select public.issue_invoice($1, $2::timestamptz)", [r.id, r.updated_at]))).toBe(
        "Add the client's address and state on their profile: an invoice over ₹50,000.00 to an unregistered client must show them (Rule 46).",
      );
    });
  });

  it("bills the unbilled time on its lines, and releases it on cancel & reissue", async () => {
    await db.asRole(U.M1, async (s) => {
      await s.as("super");
      const entry = await s.value<string>(
        "insert into time_entries (employee_id, client_id, started_at, ended_at, minutes, billable) values ($1, $2, now() - interval '3 hours', now() - interval '1 hour', 120, true) returning id",
        [U.E1.employeeId, C.A],
      );
      await s.as(U.M1);
      const r = await save(s, { lines: [line({ description: "Time: GST reconciliation (2 h)", quantity: 2, rate: 2000, time_entry_ids: [entry] })] });
      // The same time can't go on a second invoice.
      expect(userMessage(await s.fails("select public.save_invoice_draft($1::jsonb)", [JSON.stringify({ client_id: C.A, lines: [line({ time_entry_ids: [entry] })] })]))).toMatch(
        /^Some of this time is already on a draft invoice dated/,
      );
      const issued = await issue(s, r.id, "in_person");
      expect(await s.one("select invoice_id, locked from time_entries where id = $1", [entry])).toEqual({ invoice_id: r.id, locked: true });

      const at = await updatedAt(s, r.id);
      const cr = await s.value<{ new_id: string; time_entries_released: number }>("select public.cancel_and_reissue($1, 'Wrong period on the invoice', $2::timestamptz)", [r.id, at]);
      expect(cr.time_entries_released).toBe(1);
      expect(await s.one("select invoice_id, locked from time_entries where id = $1", [entry])).toEqual({ invoice_id: null, locked: false });
      const orig = await s.one<{ invoice_number: string; display: string }>(
        "select invoice_number, case when cancelled_at is not null then 'cancelled' else status::text end as display from invoices where id = $1",
        [r.id],
      );
      expect(orig).toEqual({ invoice_number: issued.invoice_number, display: "cancelled" });
      const copy = await s.one<{ status: string; revised_from_id: string; revision_number: number; invoice_number: string | null; lines: string }>(
        "select status::text, revised_from_id, revision_number, invoice_number, (select count(*)::text from invoice_items where invoice_id = i.id) as lines from invoices i where id = $1",
        [cr.new_id],
      );
      expect(copy).toEqual({ status: "draft", revised_from_id: r.id, revision_number: 1, invoice_number: null, lines: "1" });
    });
  });
});

describe("receipts (§6.5, §7.9.4, §18.3 Manager 5)", () => {
  async function sentInvoice(s: Session): Promise<string> {
    const r = await save(s, {});
    await issue(s, r.id, "in_person");
    return r.id;
  }

  it("a receipt with TDS on the taxable value settles the invoice; the status derives to Paid", async () => {
    await db.asRole(U.M1, async (s) => {
      const id = await sentInvoice(s);
      const r = await s.value<{ receipt_number: string; status: string; outstanding_amount: number }>(
        "select public.record_receipt($1::jsonb)",
        [JSON.stringify({ invoice_id: id, payment_date: "2026-10-20", amount_received: 10800, tds_amount: 1000, tds_section: "393", method: "bank_transfer", reference: "UTR123" })],
      );
      expect(r.status).toBe("paid");
      expect(r.outstanding_amount).toBe(0);
      expect(r.receipt_number).toMatch(/^TW-R\/\d{2}-\d{2}\/\d{4}$/);
      expect(await s.one("select tds_quarter, tds_status from payment_receipts where invoice_id = $1", [id])).toEqual({ tds_quarter: "Q3 2026-27", tds_status: "expected" });
    });
  });

  it("refuses received + TDS above the outstanding + ₹1, with the advance guidance; allows up to ₹1 over", async () => {
    await db.asRole(U.M1, async (s) => {
      const id = await sentInvoice(s);
      const e = await s.fails("select public.record_receipt($1::jsonb)", [JSON.stringify({ invoice_id: id, payment_date: "2026-10-20", amount_received: 11802, method: "upi" })]);
      expect(userMessage(e)).toBe(
        "₹11,802.00 received and deducted is more than the ₹11,800.00 outstanding. Record only what settles this invoice, and record the advance separately.",
      );
      const ok = await s.value<{ status: string }>("select public.record_receipt($1::jsonb)", [JSON.stringify({ invoice_id: id, payment_date: "2026-10-20", amount_received: 11801, method: "upi" })]);
      expect(ok.status).toBe("paid");
    });
  });

  it("TDS needs its section; receipts are reversed with a reason and the balance comes back", async () => {
    await db.asRole(U.M1, async (s) => {
      const id = await sentInvoice(s);
      expect(userMessage(await s.fails("select public.record_receipt($1::jsonb)", [JSON.stringify({ invoice_id: id, payment_date: "2026-10-20", amount_received: 0, tds_amount: 1000, method: "other" })]))).toBe(
        "Choose the section the client deducted TDS under.",
      );
      const r = await s.value<{ receipt_id: string; status: string }>("select public.record_receipt($1::jsonb)", [
        JSON.stringify({ invoice_id: id, payment_date: "2026-10-20", amount_received: 5000, method: "cheque", reference: "000123" }),
      ]);
      expect(r.status).toBe("partially_paid");
      expect(userMessage(await s.fails("select public.reverse_receipt($1, '  ')", [r.receipt_id]))).toMatch(/Say why/);
      const rev = await s.value<{ status: string; outstanding_amount: number }>("select public.reverse_receipt($1, 'Cheque bounced')", [r.receipt_id]);
      expect(rev).toMatchObject({ status: "sent", outstanding_amount: 11800 });
      // Never deleted: the API roles have no DELETE on receipts, and the trigger refuses it for everyone else.
      expect((await s.fails("delete from payment_receipts where id = $1", [r.receipt_id])).code).toBe("42501");
      await s.as("super");
      expect(userMessage(await s.fails("delete from payment_receipts where id = $1", [r.receipt_id]))).toMatch(/never deleted/);
    });
  });

  it("refuses receipts on drafts and on waived invoices", async () => {
    await db.asRole(U.P1, async (s) => {
      const draft = await save(s, {});
      expect(userMessage(await s.fails("select public.record_receipt($1::jsonb)", [JSON.stringify({ invoice_id: draft.id, payment_date: "2026-10-20", amount_received: 100, method: "upi" })]))).toBe(
        "Issue the invoice before recording a payment against it.",
      );
      const id = await sentInvoice(s);
      await s.value("select public.waive_invoice($1, 'Client closed down', $2::timestamptz)", [id, await updatedAt(s, id)]);
      expect(userMessage(await s.fails("select public.record_receipt($1::jsonb)", [JSON.stringify({ invoice_id: id, payment_date: "2026-10-20", amount_received: 100, method: "upi" })]))).toMatch(/was waived/);
    });
  });
});

describe("credit notes and the s.34 deadline (§6.4, §7.9.7, §18.3 Partner 6)", () => {
  it("credit_note_deadline: 30 Nov after the FY, or the annual return's date if earlier", async () => {
    await db.asRole(U.P1, async (s) => {
      expect(await s.value("select public.credit_note_deadline('2026-10-01'::date)::text")).toBe("2027-11-30");
      expect(await s.value("select public.credit_note_deadline('2027-02-15'::date)::text")).toBe("2027-11-30");
      expect(await s.value("select public.credit_note_deadline('2026-10-01'::date, '2027-10-15'::date)::text")).toBe("2027-10-15");
    });
  });

  it("a Partner credits within the window, at the invoice's rate and split; more than the remaining taxable value is refused", async () => {
    await db.asRole(U.P1, async (s) => {
      const r = await save(s, {});
      await issue(s, r.id, "in_person");
      const cn = await s.value<{ credit_note_number: string; total_amount: number; outstanding_amount: number; status: string }>("select public.issue_credit_note($1::jsonb)", [
        JSON.stringify({ invoice_id: r.id, reason_code: "fee_reduction", reason: "Agreed reduction for the delayed filing", taxable_amount: 1000 }),
      ]);
      expect(cn).toMatchObject({ total_amount: 1180, outstanding_amount: 10620, status: "partially_paid" });
      expect(cn.credit_note_number).toMatch(/^TW-CN\/\d{2}-\d{2}\/\d{4}$/);
      expect(await s.one("select cgst_amount::text, sgst_amount::text, igst_amount::text from credit_notes where invoice_id = $1", [r.id])).toEqual({ cgst_amount: "90.00", sgst_amount: "90.00", igst_amount: "0.00" });
      expect(userMessage(await s.fails("select public.issue_credit_note($1::jsonb)", [JSON.stringify({ invoice_id: r.id, reason_code: "error", reason: "x", taxable_amount: 9500 })]))).toBe(
        "You can credit at most ₹9,000.00, the taxable value at 18.00% not yet credited on this invoice.",
      );
      // Managers can't issue credit notes (§4.1).
      await s.as(U.M1);
      expect(userMessage(await s.fails("select public.issue_credit_note($1::jsonb)", [JSON.stringify({ invoice_id: r.id, reason_code: "error", reason: "x", taxable_amount: 10 })]))).toBe(
        "Only a Partner can issue a credit note.",
      );
    });
  });

  it("refuses a tax-reducing credit note after the deadline, and allows a commercial credit", async () => {
    await db.asRole(U.P1, async (s) => {
      await s.as("super");
      const id = await s.value<string>(
        `insert into invoices (invoice_number, client_id, issue_date, due_date, status, place_of_supply_code, taxable_amount, cgst_amount, sgst_amount, total_amount, created_by)
         values ('TW/24-25/0099', $1, '2024-06-01', '2024-06-16', 'draft', '29', 10000, 900, 900, 11800, $2) returning id`,
        [C.A, U.P1.id],
      );
      await s.exec("insert into invoice_items (invoice_id, description, sac_code, rate, amount, tax_rate) values ($1, 'Audit fee', '998221', 10000, 10000, 18)", [id]);
      await s.exec("update invoices set status = 'sent' where id = $1", [id]);
      await s.as(U.P1);
      expect(userMessage(await s.fails("select public.issue_credit_note($1::jsonb)", [JSON.stringify({ invoice_id: id, reason_code: "goodwill", reason: "Goodwill", taxable_amount: 1000 })]))).toBe(
        "A credit note that reduces GST had to be issued by 30 Nov 2025 (s.34 deadline). You can still give a commercial credit, which reduces what the client owes but not the GST.",
      );
      const cn = await s.value<{ total_amount: number; reduces_gst: boolean }>("select public.issue_credit_note($1::jsonb)", [
        JSON.stringify({ invoice_id: id, reason_code: "goodwill", reason: "Goodwill", taxable_amount: 1000, reduces_gst: false }),
      ]);
      expect(cn).toEqual(expect.objectContaining({ total_amount: 1000, reduces_gst: false }));
    });
  });
});

describe("cancel & reissue, disputes and waivers (§7.9.3)", () => {
  it("refuses cancel & reissue once the invoice's month is reported in GSTR-1", async () => {
    await db.asRole(U.M1, async (s) => {
      const r = await save(s, {});
      const issued = await issue(s, r.id, "in_person");
      const month = await s.value<string>("select to_char(issue_date, 'YYYY-MM') from invoices where id = $1", [r.id]);
      await asSuperThen(s, "update firm_settings set last_gstr1_reported_month = $1 where id = 1", [month], U.M1);
      const e = await s.fails("select public.cancel_and_reissue($1, 'Wrong client', $2::timestamptz)", [r.id, await updatedAt(s, r.id)]);
      expect(userMessage(e)).toMatch(new RegExp(`^Invoice ${issued.invoice_number.replace(/\//g, "\\/")} is dated .+ so it is already reported\\. Correct it with a credit note or a debit note instead\\.$`));
    });
  });

  it("refuses cancel & reissue while receipts are recorded", async () => {
    await db.asRole(U.M1, async (s) => {
      const r = await save(s, {});
      await issue(s, r.id, "in_person");
      await s.value("select public.record_receipt($1::jsonb)", [JSON.stringify({ invoice_id: r.id, payment_date: "2026-10-20", amount_received: 100, method: "upi" })]);
      expect(userMessage(await s.fails("select public.cancel_and_reissue($1, 'x', $2::timestamptz)", [r.id, await updatedAt(s, r.id)]))).toMatch(/^Payments are recorded against invoice/);
    });
  });

  it("disputed with a reason, then resolved back to the settled state; only a Partner waives", async () => {
    await db.asRole(U.M1, async (s) => {
      const r = await save(s, {});
      await issue(s, r.id, "in_person");
      const d = await s.value<{ status: string }>("select public.mark_invoice_disputed($1, 'Client says the fee was agreed at ₹8,000', $2::timestamptz)", [r.id, await updatedAt(s, r.id)]);
      expect(d.status).toBe("disputed");
      expect(userMessage(await s.fails("select public.waive_invoice($1, 'x', $2::timestamptz)", [r.id, await updatedAt(s, r.id)]))).toBe("Only a Partner can waive an invoice.");
      const back = await s.value<{ status: string }>("select public.resolve_invoice_dispute($1, $2::timestamptz)", [r.id, await updatedAt(s, r.id)]);
      expect(back.status).toBe("sent");
      await s.as(U.P1);
      const w = await s.value<{ status: string; waived_amount: number }>("select public.waive_invoice($1, 'Written off: client closed', $2::timestamptz)", [r.id, await updatedAt(s, r.id)]);
      expect(w).toMatchObject({ status: "waived", waived_amount: 11800 });
    });
  });

  it("a debit note is a draft against the original, same client and place of supply", async () => {
    await db.asRole(U.M1, async (s) => {
      const r = await save(s, {});
      const issued = await issue(s, r.id, "in_person");
      const dn = await s.value<{ id: string }>("select public.create_debit_note($1, 'Additional work on the September return')", [r.id]);
      const row = await s.one<Record<string, unknown>>("select invoice_kind, original_invoice_id, client_id, place_of_supply_code, status::text, notes from invoices where id = $1", [dn.id]);
      expect(row).toMatchObject({ invoice_kind: "debit_note", original_invoice_id: r.id, client_id: C.A, place_of_supply_code: "29", status: "draft" });
      expect(String(row.notes)).toContain(`against invoice ${issued.invoice_number}`);
      const saved = await save(s, { id: dn.id, updated_at: await updatedAt(s, dn.id), lines: [line({ rate: 2000 })] });
      expect(saved.total_amount).toBe(2360);
      const dnIssued = await issue(s, dn.id, "in_person");
      expect(dnIssued.status).toBe("sent");
    });
  });
});

describe("invoice_list (§7.9.1)", () => {
  it("filters by derived overdue and cancelled; totals leave cancelled invoices out", async () => {
    await db.asRole(U.P1, async (s) => {
      const all = await s.value<{ total: number; rows: Array<{ display_status: string }> }>("select public.invoice_list($1::jsonb)", [JSON.stringify({ limit: 100 })]);
      expect(all.total).toBeGreaterThanOrEqual(6);
      // Fixture sent invoices are dated 1 Sep 2026, due 15 Sep 2026: overdue.
      const overdue = await s.value<{ total: number; rows: Array<{ display_status: string; days_overdue: number }> }>("select public.invoice_list($1::jsonb)", [JSON.stringify({ status: ["overdue"] })]);
      expect(overdue.total).toBe(3);
      expect(overdue.rows.every((r) => r.display_status === "overdue" && r.days_overdue > 0)).toBe(true);

      const r = await save(s, {});
      await issue(s, r.id, "in_person");
      await s.value("select public.cancel_and_reissue($1, 'Wrong amount', $2::timestamptz)", [r.id, await updatedAt(s, r.id)]);
      const cancelled = await s.value<{ total: number; totals: { total: number } }>("select public.invoice_list($1::jsonb)", [JSON.stringify({ status: ["cancelled"] })]);
      expect(cancelled.total).toBe(1);
      expect(cancelled.totals.total).toBe(0);
      const sent = await s.value<{ rows: Array<{ id: string }> }>("select public.invoice_list($1::jsonb)", [JSON.stringify({ status: ["sent", "partially_paid", "disputed"], limit: 100 })]);
      expect(sent.rows.some((x) => x.id === r.id)).toBe(false);
      const search = await s.value<{ total: number }>("select public.invoice_list($1::jsonb)", [JSON.stringify({ q: "Beta" })]);
      expect(search.total).toBeGreaterThanOrEqual(2);
    });
  });

  it("gives Employees and portal users nothing", async () => {
    for (const who of [U.E1, U.CA]) {
      await db.asRole(who, async (s) => {
        const r = await s.value<{ total: number; rows: unknown[] }>("select public.invoice_list('{}'::jsonb)");
        expect(r.total).toBe(0);
        expect(r.rows).toEqual([]);
      });
    }
  });
});

describe("portal views (§7.22)", () => {
  it("a client reads the lines and credit notes of their own issued invoices only", async () => {
    await db.asRole(U.CA, async (s) => {
      // The fixture draft of client A has a line; drafts are never shown.
      expect(await s.value("select count(*)::int from portal_invoice_items where invoice_id = $1", [F.invoiceDraft("A")])).toBe(0);
      const cn = await s.rows<{ invoice_id: string }>("select invoice_id from portal_credit_notes");
      expect(cn.map((r) => r.invoice_id)).toEqual([F.invoiceSent("A")]);
    });
    await db.asRole(U.CB, async (s) => {
      expect(await s.value("select count(*)::int from portal_credit_notes where invoice_id = $1", [F.invoiceSent("A")])).toBe(0);
    });
    await db.asRole(U.E1, async (s) => {
      expect(await s.value("select count(*)::int from portal_invoice_items")).toBe(0);
      expect(await s.value("select count(*)::int from portal_credit_notes")).toBe(0);
    });
  });

  it("views are read-only for API roles", async () => {
    await db.asSuper(async (s) => {
      for (const view of ["portal_invoice_items", "portal_credit_notes"]) {
        for (const role of ["authenticated", "anon"]) {
          for (const priv of ["INSERT", "UPDATE", "DELETE"]) {
            expect(await s.value("select has_table_privilege($1, $2, $3)", [role, `public.${view}`, priv])).toBe(false);
          }
        }
        expect(await s.value("select has_table_privilege('anon', $1, 'SELECT')", [`public.${view}`])).toBe(false);
        expect(await s.value("select has_table_privilege('authenticated', $1, 'SELECT')", [`public.${view}`])).toBe(true);
      }
    });
  });
});

describe("helpers", () => {
  it("format_inr writes Indian grouping with two decimals", async () => {
    await db.asRole(U.P1, async (s) => {
      expect(await s.value("select public.format_inr(1234567.5)")).toBe("₹12,34,567.50");
      expect(await s.value("select public.format_inr(100000)")).toBe("₹1,00,000.00");
      expect(await s.value("select public.format_inr(999)")).toBe("₹999.00");
      expect(await s.value("select public.format_inr(0)")).toBe("₹0.00");
      expect(await s.value("select public.format_inr(123456789012.34)")).toBe("₹1,23,45,67,89,012.34");
    });
  });

  it("gst_annual_returns: Partners record, Managers read, Employees see nothing", async () => {
    await db.asRole(U.P1, async (s) => {
      await s.exec("insert into gst_annual_returns (financial_year, filed_on) values ('2025-26', '2026-10-10')");
      await s.as(U.M1);
      expect(await s.value("select count(*)::int from gst_annual_returns")).toBe(1);
      expect((await s.fails("insert into gst_annual_returns (financial_year, filed_on) values ('2024-25', '2025-10-10')")).code).toBe("42501");
      await s.as(U.E1);
      expect(await s.value("select count(*)::int from gst_annual_returns")).toBe(0);
    });
  });
});
