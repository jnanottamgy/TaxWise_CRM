/**
 * GST reconciliation and financial statements workpapers (§5.10, §6.12, §6.13, §7.8.1, §7.8.3):
 * migrations 0200–0203 — a run and its lines saved in one transaction (save_gst_recon_run) with
 * carry-forward clearing of last month's lines, fixed results (guards), resolutions and IMS
 * decisions with the §13 concurrency check, remembered mappings (save_import_mapping), one
 * statement per client and FY with Draft → Reviewed → Final (Final by Manager/Partner only, every
 * check passed, Final locked, reviewer ≠ preparer), and the read models under each viewer's RLS.
 */
import { describe, expect, it } from "vitest";
import { C, F, SQLSTATE, U, fid, setupTestDatabase, userMessage, type Session } from "./helpers";

const db = setupTestDatabase("workpapers_recon_fs");

const SUPPLIER = "29AAXFT1811B1Z3";

function doc(section: string, number: string, date: string, taxable: number, igst: number) {
  return { section, supplierGstin: SUPPLIER, docType: "invoice", docNumber: number, docDate: date, taxable, igst, cgst: 0, sgst: 0, cess: 0, ref: number };
}

function entry(key: string, bucket: string, opts: { portal?: object | null; books?: object | null; tier?: string | null; ims?: [string, string] | null; resolution?: string; note?: string; origin?: string; firstSeen?: string } = {}) {
  const portal = opts.portal ?? null;
  const books = opts.books ?? null;
  const itc = { portal: portal ? (portal as { igst: number }).igst : 0, books: books ? (books as { igst: number }).igst : 0 };
  return {
    entry_key: key,
    bucket,
    match_tier: opts.tier ?? null,
    supplier_gstin: SUPPLIER,
    supplier_name: "Tumkur Steel",
    data: { portal, books, itc, notes: [] },
    resolution: opts.resolution ?? "open",
    resolution_note: opts.note ?? null,
    ims_action: opts.ims?.[0] ?? null,
    ims_reason: opts.ims?.[1] ?? null,
    origin: opts.origin ?? "current",
    first_seen_period: opts.firstSeen ?? null,
  };
}

function payload(clientId: string, period: string, entries: object[], extra: Record<string, unknown> = {}) {
  return {
    client_id: clientId,
    period,
    portal_gstin: "29ABCDE1234F1Z5",
    summary: { version: 1, summary: { buckets: { matched: { count: 1 }, mismatch: { count: 0 }, missing_in_books: { count: 1 }, missing_in_2b: { count: 1 } }, itc: { per2b: 36000, perBooks: 18000, atRisk: 9000, unclaimed: 18000 } } },
    diagnostics: { gstr2b: [], register: [], warnings: [] },
    source_files: { gstr2b: { bucket: "task-files", path: `${clientId}/gstr2b/x.json` } },
    entries,
    ...extra,
  };
}

const AUG_ENTRIES = [
  entry(`${SUPPLIER}|debit|INV1`, "matched", { portal: doc("b2b", "INV/1", "2026-08-03", 100000, 18000), books: doc("register", "INV-1", "2026-08-03", 100000, 18000), tier: "loose", ims: ["accept", "Matches the purchase register."] }),
  entry(`${SUPPLIER}|debit|INV2`, "missing_in_2b", { books: doc("register", "INV/2", "2026-08-10", 50000, 9000) }),
  entry(`${SUPPLIER}|debit|INV3`, "missing_in_books", { portal: doc("b2b", "INV/3", "2026-08-12", 100000, 18000), ims: ["keep_pending", "Not in the purchase register."] }),
];

async function saveRun(s: Session, p: object): Promise<{ id: string; entries: number; cleared_previous: number; reopened_previous: number }> {
  return s.value("select save_gst_recon_run($1::jsonb)", [JSON.stringify(p)]);
}

async function entriesOf(s: Session, runId: string) {
  return s.rows<{ id: string; entry_key: string; bucket: string; resolution: string; resolution_note: string | null; updated_at: string; cleared_by_run_id: string | null; resolved_by: string | null }>(
    "select id, entry_key, bucket, resolution, resolution_note, updated_at::text, cleared_by_run_id, resolved_by from gst_recon_entries where run_id = $1 order by entry_key",
    [runId],
  );
}

// =================================================================================================
// save_gst_recon_run (§6.12 "Runs are saved per client and period")
// =================================================================================================

describe("save_gst_recon_run", () => {
  it("saves the run and every line in one call, for an Employee's own client", async () => {
    await db.asRole(U.E1, async (s) => {
      const r = await saveRun(s, payload(C.A, "082026", AUG_ENTRIES));
      expect(r.entries).toBe(3);
      const run = await s.one<{ created_by: string; period: string; portal_gstin: string }>("select created_by, period, portal_gstin::text from gst_recon_runs where id = $1", [r.id]);
      expect(run).toEqual({ created_by: U.E1.id, period: "082026", portal_gstin: "29ABCDE1234F1Z5" });
      const lines = await entriesOf(s, r.id);
      expect(lines.map((l) => l.bucket)).toEqual(["matched", "missing_in_2b", "missing_in_books"]);
      expect(lines.every((l) => l.resolution === "open")).toBe(true);
      const ims = await s.rows<{ ims_action: string | null; ims_decided_by: string | null }>("select ims_action, ims_decided_by from gst_recon_entries where run_id = $1 order by entry_key", [r.id]);
      expect(ims).toEqual([
        { ims_action: "accept", ims_decided_by: null },
        { ims_action: null, ims_decided_by: null },
        { ims_action: "keep_pending", ims_decided_by: null },
      ]);
    });
  });

  it("saves an import of goods (IMPG bill of entry), which has no supplier GSTIN (0234)", async () => {
    await db.asRole(U.E1, async (s) => {
      const boe = { section: "impg", supplierGstin: "", docType: "bill_of_entry", docNumber: "4581237", docDate: "2026-08-05", taxable: 250000, igst: 45000, cgst: 0, sgst: 0, cess: 0, ref: "4581237" };
      const impg = { ...entry("|debit|4581237", "missing_in_books", { portal: boe }), supplier_gstin: "", supplier_name: null };
      const r = await saveRun(s, payload(C.A, "082026", [...AUG_ENTRIES, impg]));
      expect(r.entries).toBe(4);
      const stored = await s.one<{ supplier_gstin: string | null }>("select supplier_gstin::text from gst_recon_entries where run_id = $1 and entry_key = '|debit|4581237'", [r.id]);
      expect(stored.supplier_gstin).toBeNull();
      // The read models hand the app '' for "no GSTIN", and the roll-up keeps the imports in one row.
      const line = await s.one<{ supplier_gstin: string; doc_type: string; portal_section: string }>("select supplier_gstin, doc_type, portal_section from gst_recon_entry_list where run_id = $1 and entry_key = '|debit|4581237'", [r.id]);
      expect(line).toEqual({ supplier_gstin: "", doc_type: "bill_of_entry", portal_section: "impg" });
      const rollup = await s.rows<{ supplier_gstin: string; line_count: number }>("select supplier_gstin, line_count from gst_recon_supplier_rollup where run_id = $1 order by supplier_gstin", [r.id]);
      expect(rollup).toEqual([
        { supplier_gstin: "", line_count: 1 },
        { supplier_gstin: SUPPLIER, line_count: 3 },
      ]);
    });
  });

  it("refuses a client the caller can't see, portal users and malformed runs", async () => {
    await db.asRole(U.E1, async (s) => {
      expect(userMessage(await s.fails("select save_gst_recon_run($1::jsonb)", [JSON.stringify(payload(C.B, "082026", AUG_ENTRIES))]))).toMatch(/isn't one of yours/);
      expect(userMessage(await s.fails("select save_gst_recon_run($1::jsonb)", [JSON.stringify(payload(C.A, "132026", AUG_ENTRIES))]))).toMatch(/Choose the month/);
      expect(userMessage(await s.fails("select save_gst_recon_run($1::jsonb)", [JSON.stringify({ ...payload(C.A, "082026", AUG_ENTRIES), entries: null })]))).toMatch(/no lines/);
      // The register must be this client's document.
      const other = await s.fails("select save_gst_recon_run($1::jsonb)", [JSON.stringify(payload(C.A, "082026", AUG_ENTRIES, { register_document_id: F.docShared("B") }))]);
      expect(userMessage(other)).toMatch(/isn't in this client's documents/);
    });
    await db.asRole(U.E3, async (s) => {
      expect(userMessage(await s.fails("select save_gst_recon_run($1::jsonb)", [JSON.stringify(payload(C.A, "082026", AUG_ENTRIES))]))).toMatch(/isn't one of yours/);
    });
    await db.asRole(U.CA, async (s) => {
      const e = await s.fails("select save_gst_recon_run($1::jsonb)", [JSON.stringify(payload(C.A, "082026", AUG_ENTRIES))]);
      expect(userMessage(e)).toMatch(/Only the firm's staff/);
    });
    await db.asAnon(async (s) => {
      const e = await s.fails("select save_gst_recon_run($1::jsonb)", [JSON.stringify(payload(C.A, "082026", AUG_ENTRIES))]);
      expect(e.code).toBe(SQLSTATE.insufficientPrivilege);
    });
  });

  it("carries forward only from an earlier month of the same client", async () => {
    await db.asRole(U.M1, async (s) => {
      const aug = await saveRun(s, payload(C.A, "082026", AUG_ENTRIES));
      const sameMonth = await s.fails("select save_gst_recon_run($1::jsonb)", [JSON.stringify(payload(C.A, "082026", AUG_ENTRIES, { previous_run_id: aug.id }))]);
      expect(userMessage(sameMonth)).toMatch(/only from an earlier month/);
      const otherClient = await s.fails("select save_gst_recon_run($1::jsonb)", [JSON.stringify(payload(C.B, "092026", AUG_ENTRIES, { previous_run_id: aug.id }))]);
      expect(userMessage(otherClient)).toMatch(/isn't this client's/);
    });
  });

  it("marks last month's lines this month's files clear, and reopens them when the month is run again", async () => {
    await db.asRole(U.E1, async (s) => {
      const aug = await saveRun(s, payload(C.A, "082026", AUG_ENTRIES));
      const augLines = await entriesOf(s, aug.id);
      const missingIn2b = augLines.find((l) => l.bucket === "missing_in_2b")!;
      const missingInBooks = augLines.find((l) => l.bucket === "missing_in_books")!;
      const matched = augLines.find((l) => l.bucket === "matched")!;

      const sep1 = await saveRun(
        s,
        payload(C.A, "092026", [entry(`${SUPPLIER}|debit|INV2`, "missing_in_books", { portal: doc("b2b", "INV/2", "2026-08-10", 50000, 9000), resolution: "accepted", note: "Cleared" })], {
          previous_run_id: aug.id,
          clear_previous: [
            { entry_id: missingIn2b.id, note: "The supplier has now reported it in this month's GSTR-2B." },
            { entry_id: matched.id, note: "Matched lines are never cleared." },
          ],
        }),
      );
      expect(sep1.cleared_previous).toBe(1);
      const after = await entriesOf(s, aug.id);
      expect(after.find((l) => l.id === missingIn2b.id)).toMatchObject({ resolution: "accepted", cleared_by_run_id: sep1.id, resolved_by: U.E1.id });
      expect(after.find((l) => l.id === missingInBooks.id)?.resolution).toBe("open");
      expect(after.find((l) => l.id === matched.id)?.resolution).toBe("open");

      // Running September again without the clearing reopens what the first September run cleared.
      const sep2 = await saveRun(s, payload(C.A, "092026", [entry(`${SUPPLIER}|debit|INV9`, "missing_in_2b", { books: doc("register", "INV/9", "2026-09-10", 1000, 180) })], { previous_run_id: aug.id }));
      expect(sep2.reopened_previous).toBe(1);
      const again = await entriesOf(s, aug.id);
      expect(again.find((l) => l.id === missingIn2b.id)).toMatchObject({ resolution: "open", cleared_by_run_id: null, resolved_by: null });

      const list = await s.rows<{ id: string; is_latest: boolean }>("select id, is_latest from gst_recon_runs_list where client_id = $1 and period = '092026' order by created_at, id", [C.A]);
      expect(list.filter((r) => r.is_latest).map((r) => r.id)).toHaveLength(1);
    });
  });
});

// =================================================================================================
// Guards: results are fixed (§6.12 history), lines are only resolved
// =================================================================================================

describe("saved results never change", () => {
  it("refuses changes to a run's results and a line's figures, for everyone", async () => {
    for (const user of [U.E1, U.P1]) {
      await db.asRole(user, async (s) => {
        const r = await saveRun(s, payload(C.A, "082026", AUG_ENTRIES));
        expect(userMessage(await s.fails("update gst_recon_runs set summary = '{}' where id = $1", [r.id]))).toMatch(/can't be changed/);
        expect(userMessage(await s.fails("update gst_recon_runs set period = '072026' where id = $1", [r.id]))).toMatch(/can't be changed/);
        const line = (await entriesOf(s, r.id))[1];
        expect(userMessage(await s.fails("update gst_recon_entries set data = '{}' where id = $1", [line.id]))).toMatch(/only resolved/);
        expect(userMessage(await s.fails("update gst_recon_entries set bucket = 'matched' where id = $1", [line.id]))).toMatch(/only resolved/);
        expect(userMessage(await s.fails("update gst_recon_entries set ims_decided_by = $2 where id = $1", [line.id, user.id]))).toMatch(/IMS decision/);
      });
    }
  });

  it("Employees can't delete runs (a Partner/Manager act)", async () => {
    await db.asRole(U.E1, async (s) => {
      const r = await saveRun(s, payload(C.A, "082026", AUG_ENTRIES));
      expect(await s.exec("delete from gst_recon_runs where id = $1", [r.id])).toBe(0);
    });
  });
});

// =================================================================================================
// set_gst_recon_resolution (§7.8.1 "mark rows resolved with notes")
// =================================================================================================

describe("set_gst_recon_resolution", () => {
  it("resolves lines with a note, stamps who did it, and checks each line's version", async () => {
    await db.asRole(U.E1, async (s) => {
      const r = await saveRun(s, payload(C.A, "082026", AUG_ENTRIES));
      const lines = await entriesOf(s, r.id);
      const open = lines.filter((l) => l.bucket !== "matched");
      const arg = JSON.stringify(open.map((l) => ({ id: l.id, updated_at: l.updated_at })));

      const done = await s.value<{ updated: number; entries: Array<{ id: string; resolution: string }> }>("select set_gst_recon_resolution($1, $2::jsonb, 'follow_up_supplier', 'Asked the supplier to file GSTR-1')", [r.id, arg]);
      expect(done.updated).toBe(2);
      expect(done.entries.every((e) => e.resolution === "follow_up_supplier")).toBe(true);
      const stamped = await entriesOf(s, r.id);
      expect(stamped.filter((l) => l.bucket !== "matched").every((l) => l.resolved_by === U.E1.id && l.resolution_note === "Asked the supplier to file GSTR-1")).toBe(true);

      // A version someone else has since moved past (one transaction has one now(), so the stale
      // version is set explicitly).
      const staleArg = JSON.stringify(open.map((l) => ({ id: l.id, updated_at: "2020-01-01T00:00:00Z" })));
      const stale = await s.fails("select set_gst_recon_resolution($1, $2::jsonb, 'accepted', 'Booked')", [r.id, staleArg]);
      expect(userMessage(stale)).toMatch(/^Changed by Test E1 at \d\d:\d\d\. Reload to see their changes\.$/);

      // Back to open clears the note and the stamp.
      const fresh = JSON.stringify(stamped.filter((l) => l.bucket !== "matched").map((l) => ({ id: l.id, updated_at: l.updated_at })));
      await s.value("select set_gst_recon_resolution($1, $2::jsonb, 'open', null)", [r.id, fresh]);
      const reopened = await entriesOf(s, r.id);
      expect(reopened.filter((l) => l.bucket !== "matched").every((l) => l.resolution === "open" && l.resolution_note === null && l.resolved_by === null)).toBe(true);
    });
  });

  it("asks why a line is ignored, and leaves matched lines alone", async () => {
    await db.asRole(U.M1, async (s) => {
      const r = await saveRun(s, payload(C.A, "082026", AUG_ENTRIES));
      const lines = await entriesOf(s, r.id);
      const one = (l: { id: string; updated_at: string }) => JSON.stringify([{ id: l.id, updated_at: l.updated_at }]);
      const missing = lines.find((l) => l.bucket === "missing_in_books")!;
      expect(userMessage(await s.fails("select set_gst_recon_resolution($1, $2::jsonb, 'ignore', '  ')", [r.id, one(missing)]))).toMatch(/Say why/);
      expect(userMessage(await s.fails("select set_gst_recon_resolution($1, $2::jsonb, 'done', 'x')", [r.id, one(missing)]))).toMatch(/Choose how/);
      const matched = lines.find((l) => l.bucket === "matched")!;
      expect(userMessage(await s.fails("select set_gst_recon_resolution($1, $2::jsonb, 'accepted', 'x')", [r.id, one(matched)]))).toMatch(/Matched lines need no resolution/);
      expect(userMessage(await s.fails("select set_gst_recon_resolution($1, '[]'::jsonb, 'accepted', 'x')", [r.id]))).toMatch(/Choose the lines/);
    });
  });

  it("another Employee can't reach the lines of a client that isn't theirs", async () => {
    const saved = await db.asRole(U.P1, async (s) => {
      const r = await saveRun(s, payload(C.A, "082026", AUG_ENTRIES));
      const lines = await entriesOf(s, r.id);
      // Switch identity inside the same transaction: E2 sees client B only.
      await s.as(U.E2);
      const e = await s.fails("select set_gst_recon_resolution($1, $2::jsonb, 'accepted', 'x')", [r.id, JSON.stringify([{ id: lines[1].id, updated_at: lines[1].updated_at }])]);
      return userMessage(e);
    });
    expect(saved).toMatch(/no longer in this reconciliation/);
  });
});

// =================================================================================================
// set_gst_recon_ims_action (§6.12 "IMS action list (accept / reject / keep pending, with reasons)")
// =================================================================================================

describe("set_gst_recon_ims_action", () => {
  it("records a person's decision with its reason, on IMS documents only", async () => {
    await db.asRole(U.E1, async (s) => {
      const r = await saveRun(
        s,
        payload(C.A, "082026", [
          ...AUG_ENTRIES,
          entry(`IMPG|debit|BOE1`, "missing_in_books", { portal: { ...doc("impg", "BOE1", "2026-08-01", 1000, 180), supplierGstin: "" } }),
          entry(`${SUPPLIER}|debit|OLD1`, "missing_in_books", { portal: doc("b2b", "OLD1", "2026-06-01", 1000, 180), origin: "carried", firstSeen: "062026" }),
        ]),
      );
      const lines = await s.rows<{ id: string; entry_key: string; updated_at: string }>("select id, entry_key, updated_at::text from gst_recon_entries where run_id = $1", [r.id]);
      const byKey = (k: string) => lines.find((l) => l.entry_key.endsWith(k))!;

      const target = byKey("INV3");
      expect(userMessage(await s.fails("select set_gst_recon_ims_action($1, $2, 'reject', '')", [target.id, target.updated_at]))).toMatch(/Give the reason/);
      const out = await s.value<{ ims_action: string; ims_reason: string }>("select set_gst_recon_ims_action($1, $2, 'reject', 'Not the client''s purchase: wrong GSTIN quoted by the supplier')", [target.id, target.updated_at]);
      expect(out.ims_action).toBe("reject");
      const row = await s.one<{ ims_decided_by: string }>("select ims_decided_by from gst_recon_entries where id = $1", [target.id]);
      expect(row.ims_decided_by).toBe(U.E1.id);
      expect(userMessage(await s.fails("select set_gst_recon_ims_action($1, $2, 'accept', 'Booked now')", [target.id, "2020-01-01T00:00:00Z"]))).toMatch(/^Changed by Test E1/);

      const boe = byKey("BOE1");
      expect(userMessage(await s.fails("select set_gst_recon_ims_action($1, $2, 'accept', 'x')", [boe.id, boe.updated_at]))).toMatch(/IMS acts only/);
      const books = byKey("INV2");
      expect(userMessage(await s.fails("select set_gst_recon_ims_action($1, $2, 'accept', 'x')", [books.id, books.updated_at]))).toMatch(/IMS acts only/);
      const carried = byKey("OLD1");
      expect(userMessage(await s.fails("select set_gst_recon_ims_action($1, $2, 'accept', 'x')", [carried.id, carried.updated_at]))).toMatch(/IMS acts only/);
    });
  });
});

// =================================================================================================
// save_import_mapping (§6.12, §6.13 "remembered per client")
// =================================================================================================

describe("save_import_mapping", () => {
  it("replaces column mappings as given and merges ledger choices", async () => {
    await db.asRole(U.E1, async (s) => {
      const columns = { version: 1, columns: { supplierGstin: "GSTIN of supplier", cess: null } };
      await s.value("select save_import_mapping($1, 'purchase_register', $2::jsonb, false)", [C.A, JSON.stringify(columns)]);
      const stored = await s.one<{ mapping: unknown; updated_by: string }>("select mapping, updated_by from register_portal_mappings where client_id = $1 and kind = 'purchase_register'", [C.A]);
      expect(stored).toEqual({ mapping: columns, updated_by: U.E1.id });

      await s.value("select save_import_mapping($1, 'ledger_buckets', $2::jsonb, true)", [C.A, JSON.stringify({ "rent paid": "other_expenses", "hdfc bank": "cash_bank" })]);
      await s.value("select save_import_mapping($1, 'ledger_buckets', $2::jsonb, true)", [C.A, JSON.stringify({ "hdfc bank": null, "sales": "revenue_from_operations" })]);
      const merged = await s.value("select mapping from register_portal_mappings where client_id = $1 and kind = 'ledger_buckets'", [C.A]);
      expect(merged).toEqual({ "rent paid": "other_expenses", sales: "revenue_from_operations" });
      expect(userMessage(await s.fails("select save_import_mapping($1, 'gstr1', '{}'::jsonb, false)", [C.A]))).toMatch(/kind of mapping/);
      expect(userMessage(await s.fails("select save_import_mapping($1, 'trial_balance', '[]'::jsonb, false)", [C.A]))).toMatch(/expected form/);
      expect(userMessage(await s.fails("update register_portal_mappings set client_id = $1 where client_id = $2", [C.Z, C.A]))).toMatch(/belongs to one client/);
    });
    for (const user of [U.E2, U.CA]) {
      await db.asRole(user, async (s) => {
        expect((await s.attempt("select save_import_mapping($1, 'trial_balance', '{}'::jsonb, false)", [C.A])).ok).toBe(false);
      });
    }
  });
});

// =================================================================================================
// Financial statements (§7.8.3 "Draft → Reviewed → Final (Final only Manager/Partner)")
// =================================================================================================

type FsRow = { id: string; status: string; updated_at: string };

function statement(clientId: string, fy: string, opts: { passed?: boolean; id?: string; updatedAt?: string; ledgers?: object[]; inputs?: object } = {}) {
  return JSON.stringify({
    id: opts.id ?? null,
    updated_at: opts.updatedAt ?? null,
    client_id: clientId,
    financial_year: fy,
    ledgers: opts.ledgers ?? [{ name: "Sales", group: "Sales Accounts", debit: 0, credit: 100000, bucket: "revenue_from_operations", matched: true }],
    statements: { allChecksPassed: opts.passed ?? true, checks: [{ code: "tb_balanced", status: (opts.passed ?? true) ? "pass" : "fail" }], totals: { current: { profit: 100000, assets: 0, totalIncome: 100000 } } },
    inputs: opts.inputs ?? { version: 1 },
  });
}

async function saveFs(s: Session, body: string): Promise<FsRow> {
  const r = await s.value<{ id: string; status: string; updated_at: string }>("select save_financial_statement($1::jsonb)", [body]);
  return { id: r.id, status: r.status, updated_at: r.updated_at };
}

async function fsNow(s: Session, id: string): Promise<FsRow & { reviewed_by: string | null; finalised_by: string | null; prepared_by: string | null; review_note: string | null }> {
  return s.one("select id, status, updated_at::text, reviewed_by, finalised_by, prepared_by, review_note from financial_statements where id = $1", [id]);
}

async function setStatus(s: Session, row: { id: string; updated_at: string }, to: string, note: string | null = null) {
  return s.value<{ status: string; updated_at: string }>("select set_financial_statement_status($1, $2, $3, $4)", [row.id, row.updated_at, to, note]);
}

describe("financial statements", () => {
  it("one statement per client and FY, created as a draft, with the §13 concurrency check", async () => {
    await db.asRole(U.E1, async (s) => {
      const created = await saveFs(s, statement(C.A, "2026-27"));
      expect(created.status).toBe("draft");
      const dup = await s.fails("select save_financial_statement($1::jsonb)", [statement(C.A, "2026-27")]);
      expect(userMessage(dup)).toBe("This client already has a statement for FY 2026-27. Open it to upload a new trial balance.");

      const now = await fsNow(s, created.id);
      const updated = await saveFs(s, statement(C.A, "2026-27", { id: created.id, updatedAt: now.updated_at, inputs: { version: 1, closingStock: 5000 } }));
      expect(updated.id).toBe(created.id);
      const stale = await s.fails("select save_financial_statement($1::jsonb)", [statement(C.A, "2026-27", { id: created.id, updatedAt: "2020-01-01T00:00:00Z" })]);
      expect(userMessage(stale)).toMatch(/^Changed by Test E1 at \d\d:\d\d\. Reload to see their changes\.$/);

      expect(userMessage(await s.fails("select save_financial_statement($1::jsonb)", [statement(C.B, "2026-27")]))).toMatch(/isn't one of yours/);
      expect(userMessage(await s.fails("insert into financial_statements (client_id, financial_year, ledgers, statements, status, created_by) values ($1, '2027-28', '[]', '{}', 'final', $2)", [C.A, U.E1.id]))).toMatch(/starts as a draft/);
      const prev = await s.value<string>("select id from financial_statements where client_id = $1 and financial_year = '2025-26'", [C.A]);
      const wrongPrev = await s.fails("select save_financial_statement($1::jsonb)", [JSON.stringify({ ...JSON.parse(statement(C.A, "2024-25")), previous_statement_id: prev })]);
      expect(userMessage(wrongPrev)).toMatch(/earlier year/);
    });
  });

  it("someone other than the preparer reviews; only a Manager or Partner marks it final, with every check passed", async () => {
    await db.asRole(U.E1, async (s) => {
      const created = await saveFs(s, statement(C.A, "2026-27", { passed: false }));
      expect(userMessage(await s.fails("select set_financial_statement_status($1, $2, 'reviewed', null)", [created.id, (await fsNow(s, created.id)).updated_at]))).toMatch(/Someone other than the preparer/);

      await s.as(U.M1);
      const reviewed = await setStatus(s, await fsNow(s, created.id), "reviewed");
      expect(reviewed.status).toBe("reviewed");
      expect((await fsNow(s, created.id)).reviewed_by).toBe(U.M1.id);
      expect(userMessage(await s.fails("select set_financial_statement_status($1, $2, 'final', null)", [created.id, reviewed.updated_at]))).toMatch(/Every check must pass/);

      // Fixing the figures sends it back to Draft; then it is reviewed again and finalised.
      await s.as(U.E1);
      const fixed = await saveFs(s, statement(C.A, "2026-27", { id: created.id, updatedAt: reviewed.updated_at, passed: true }));
      expect(fixed.status).toBe("draft");
      expect((await fsNow(s, created.id)).reviewed_by).toBeNull();
      await s.as(U.M1);
      const again = await setStatus(s, await fsNow(s, created.id), "reviewed");
      await s.as(U.E1);
      expect(userMessage(await s.fails("select set_financial_statement_status($1, $2, 'final', null)", [created.id, again.updated_at]))).toMatch(/Only a Manager or Partner can mark/);
      await s.as(U.M1);
      const final = await setStatus(s, await fsNow(s, created.id), "final");
      expect(final.status).toBe("final");
      expect((await fsNow(s, created.id)).finalised_by).toBe(U.M1.id);

      // Final is locked; only a Partner or Manager reopens it, with a note.
      await s.as(U.E1);
      const locked = await s.fails("select save_financial_statement($1::jsonb)", [statement(C.A, "2026-27", { id: created.id, updatedAt: final.updated_at, inputs: { version: 1, closingStock: 100 } })]);
      expect(userMessage(locked)).toMatch(/This statement is final/);
      expect(userMessage(await s.fails("select set_financial_statement_status($1, $2, 'draft', 'Change the depreciation')", [created.id, final.updated_at]))).toMatch(/Only a Manager or Partner can reopen/);
      await s.as(U.M1);
      expect(userMessage(await s.fails("select set_financial_statement_status($1, $2, 'draft', null)", [created.id, final.updated_at]))).toMatch(/Say why/);
      expect(userMessage(await s.fails("select set_financial_statement_status($1, $2, 'reviewed', null)", [created.id, final.updated_at]))).toMatch(/Reopen a final statement as a draft/);
      const reopened = await setStatus(s, await fsNow(s, created.id), "draft", "Depreciation on the new machine is missing");
      expect(reopened.status).toBe("draft");
      const row = await fsNow(s, created.id);
      expect(row).toMatchObject({ reviewed_by: null, finalised_by: null, review_note: "Depreciation on the new machine is missing" });
    });
  });

  it("final straight from draft is refused, and a Partner may review their own work", async () => {
    await db.asRole(U.P1, async (s) => {
      const created = await saveFs(s, statement(C.C, "2026-27"));
      expect(userMessage(await s.fails("select set_financial_statement_status($1, $2, 'final', null)", [created.id, (await fsNow(s, created.id)).updated_at]))).toMatch(/reviewed before it is marked final/);
      const reviewed = await setStatus(s, await fsNow(s, created.id), "reviewed");
      expect(reviewed.status).toBe("reviewed");
      expect((await setStatus(s, await fsNow(s, created.id), "final")).status).toBe("final");
      expect(userMessage(await s.fails("update financial_statements set reviewed_by = null where id = $1", [created.id]))).toMatch(/recorded by the app/);
      expect(userMessage(await s.fails("update financial_statements set financial_year = '2027-28' where id = $1", [created.id]))).toMatch(/stays with its client and year/);
    });
  });
});

// =================================================================================================
// Read models (§4.1 Employees: own clients only)
// =================================================================================================

describe("read models", () => {
  it("show each viewer only the rows of clients they may see", async () => {
    const counts = async (user: (typeof U)[keyof typeof U]) =>
      db.asRole(user, async (s) => ({
        runs: await s.rows<{ client_id: string }>("select distinct client_id from gst_recon_runs_list"),
        entries: await s.rows<{ client_id: string }>("select distinct client_id from gst_recon_entry_list"),
        statements: await s.rows<{ client_id: string }>("select distinct client_id from financial_statements_list"),
      }));
    const e1 = await counts(U.E1);
    expect(e1.runs.map((r) => r.client_id)).toEqual([C.A]);
    expect(e1.entries.map((r) => r.client_id)).toEqual([C.A]);
    expect(e1.statements.map((r) => r.client_id)).toEqual([C.A]);
    const e3 = await counts(U.E3);
    expect([e3.runs.length, e3.entries.length, e3.statements.length]).toEqual([0, 0, 0]);
    const ca = await counts(U.CA);
    expect([ca.runs.length, ca.entries.length, ca.statements.length]).toEqual([0, 0, 0]);
    const p1 = await counts(U.P1);
    expect(p1.runs.length).toBeGreaterThanOrEqual(3);
  });

  it("derive the counts, the ITC figures and the sortable columns", async () => {
    await db.asRole(U.E1, async (s) => {
      const r = await saveRun(s, payload(C.A, "082026", AUG_ENTRIES));
      const run = await s.one<Record<string, unknown>>(
        "select matched_count, missing_in_books_count, missing_in_2b_count, itc_per_2b_paise, itc_at_risk_paise, open_count, is_latest, gstin_mismatch, created_by_name from gst_recon_runs_list where id = $1",
        [r.id],
      );
      expect(run).toMatchObject({ matched_count: 1, missing_in_books_count: 1, missing_in_2b_count: 1, open_count: 2, is_latest: true, created_by_name: "Test E1" });
      expect(Number(run.itc_per_2b_paise)).toBe(36000);
      expect(Number(run.itc_at_risk_paise)).toBe(9000);
      const lines = await s.rows<Record<string, unknown>>(
        "select entry_key, doc_number, doc_date::text, portal_doc_number, books_doc_number, itc_paise, itc_difference_paise, is_open from gst_recon_entry_list where run_id = $1 order by itc_paise desc, entry_key",
        [r.id],
      );
      expect(lines.map((l) => [l.doc_number, l.doc_date, Number(l.itc_paise), Number(l.itc_difference_paise), l.is_open])).toEqual([
        ["INV/1", "2026-08-03", 18000, 0, false],
        ["INV/3", "2026-08-12", 18000, 18000, true],
        ["INV/2", "2026-08-10", 9000, -9000, true],
      ]);
      const fs = await s.one<Record<string, unknown>>("select ledger_count, unmapped_count, all_checks_passed, failed_checks from financial_statements_list where client_id = $1 and financial_year = '2025-26'", [C.A]);
      expect(fs).toEqual({ ledger_count: 0, unmapped_count: 0, all_checks_passed: false, failed_checks: 0 });
    });
  });

  it("roll up suppliers from the open lines, so a resolution moves the figures", async () => {
    await db.asRole(U.E1, async (s) => {
      const r = await saveRun(s, payload(C.A, "082026", AUG_ENTRIES));
      const roll = () =>
        s.one<Record<string, unknown>>(
          "select matched_count, missing_in_2b_count, missing_in_books_count, open_count, chase_count, itc_at_risk_paise, unclaimed_itc_paise from gst_recon_supplier_rollup where run_id = $1 and supplier_gstin = $2",
          [r.id, SUPPLIER],
        );
      expect(await roll()).toMatchObject({ matched_count: 1, missing_in_2b_count: 1, missing_in_books_count: 1, open_count: 2, chase_count: 1 });
      expect(Number((await roll()).itc_at_risk_paise)).toBe(9000);
      expect(Number((await roll()).unclaimed_itc_paise)).toBe(18000);
      const line = (await entriesOf(s, r.id)).find((l) => l.bucket === "missing_in_2b")!;
      await s.value("select set_gst_recon_resolution($1, $2::jsonb, 'accepted', 'Supplier filed late; claimed in October')", [r.id, JSON.stringify([{ id: line.id, updated_at: line.updated_at }])]);
      expect(await roll()).toMatchObject({ open_count: 1, chase_count: 0 });
      expect(Number((await roll()).itc_at_risk_paise)).toBe(0);
    });
    await db.asRole(U.E2, async (s) => {
      expect(await s.value("select count(*)::int from gst_recon_supplier_rollup where client_id = $1", [C.A])).toBe(0);
    });
  });

  it("the fixture run of each client stays visible with empty summaries", async () => {
    await db.asRole(U.E2, async (s) => {
      const r = await s.one<Record<string, unknown>>("select matched_count, open_count, itc_per_2b_paise from gst_recon_runs_list where id = $1", [fid("recon:B")]);
      expect(r).toEqual({ matched_count: 0, open_count: 0, itc_per_2b_paise: "0" });
    });
  });
});
