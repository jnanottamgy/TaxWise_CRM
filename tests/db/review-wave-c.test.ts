/**
 * Review of wave C in the database (0230):
 *   - engagement documents (category 'engagement', or a letter's signed copy) never reach an
 *     Employee: not the row, not its versions, not the stored file, not the search; and an Employee
 *     can't file a document under 'engagement' (§4.1 "Fees, engagement terms … never, anywhere");
 *   - a client's purge waits while its workpapers are inside their record-keeping period (§6.8, §7.19);
 *   - a Form 26 UDIN counts towards the ceiling by its s.44AB-equivalent category (§6.8);
 *   - an Employee logs a UDIN only as a member who signs (§4.1 "UDIN add if signing staff").
 */
import { describe, expect, it } from "vitest";
import { C, F, U, fid, setupTestDatabase, userMessage, type Session } from "./helpers";

const db = setupTestDatabase("review-wave-c");

async function engagementDoc(s: Session, opts: { id: string; client: string; category?: string; path: string }) {
  await s.exec(
    `insert into documents (id, client_id, title, file_name, file_size, mime_type, storage_path, uploaded_by, category)
     values ($1, $2, 'Signed engagement letter FY 2026-27', 'letter.pdf', 100, 'application/pdf', $3, $4, $5::document_category)`,
    [opts.id, opts.client, opts.path, U.P1.id, opts.category ?? "engagement"],
  );
  await s.exec("insert into storage.objects (bucket_id, name, owner) values ('client-documents', $1, $2)", [opts.path, U.P1.id]);
}

describe("engagement documents are Partners' and Managers' only (§4.1)", () => {
  it("hides a document filed under 'engagement' from the Employee on the client, file included", async () => {
    await db.asSuper(async (s) => {
      const id = fid("doc:engagement:A");
      const path = `${C.A}/engagement-letter.pdf`;
      await engagementDoc(s, { id, client: C.A, path });
      await s.exec("insert into document_versions (document_id, version, file_name, file_size, storage_path, uploaded_by) values ($1, 1, 'letter-v1.pdf', 100, $2, $3)", [id, `${C.A}/engagement-letter-v1.pdf`, U.P1.id]);
      await s.exec("insert into storage.objects (bucket_id, name, owner) values ('client-documents', $1, $2)", [`${C.A}/engagement-letter-v1.pdf`, U.P1.id]);

      for (const u of [U.P1, U.M1]) {
        await s.as(u);
        expect(await s.value<number>("select count(*)::int from documents where id = $1", [id])).toBe(1);
        expect(await s.value<number>("select count(*)::int from storage.objects where name = $1", [path])).toBe(1);
      }

      // E1 owns client A: the client's other documents stay, the engagement document is gone.
      await s.as(U.E1);
      expect(await s.value<number>("select count(*)::int from documents where id = $1", [id])).toBe(0);
      expect(await s.value<number>("select count(*)::int from documents where id = $1", [F.docPrivate("A")])).toBe(1);
      expect(await s.value<number>("select count(*)::int from document_versions where document_id = $1", [id])).toBe(0);
      expect(await s.value<number>("select count(*)::int from storage.objects where name in ($1, $2)", [path, `${C.A}/engagement-letter-v1.pdf`])).toBe(0);
      expect(await s.value<boolean>("select can_see_document($1)", [id])).toBe(false);
      expect(await s.value<boolean>("select can_see_document($1)", [F.docPrivate("A")])).toBe(true);
      expect(await s.exec("update documents set title = 'Renamed' where id = $1", [id])).toBe(0);

      const found = await s.value<{ groups: Array<{ type: string; items: Array<{ id: string }> }> }>("select search_everything('engagement letter', 10, array['document'], 0)");
      expect(found.groups.flatMap((g) => g.items.map((i) => i.id))).not.toContain(id);
    });
  });

  it("hides an engagement letter's signed copy whatever category it was filed under", async () => {
    await db.asSuper(async (s) => {
      const id = fid("doc:signed-copy:A");
      await engagementDoc(s, { id, client: C.A, category: "agreements", path: `${C.A}/signed-copy.pdf` });
      await s.as(U.E1);
      expect(await s.value<number>("select count(*)::int from documents where id = $1", [id])).toBe(1);
      await s.as("super");
      await s.exec("update engagement_letters set document_id = $1 where client_id = $2", [id, C.A]);
      await s.as(U.E1);
      expect(await s.value<number>("select count(*)::int from documents where id = $1", [id])).toBe(0);
      expect(await s.value<number>("select count(*)::int from storage.objects where name = $1", [`${C.A}/signed-copy.pdf`])).toBe(0);
      await s.as(U.M1);
      expect(await s.value<number>("select count(*)::int from documents where id = $1", [id])).toBe(1);
    });
  });

  it("refuses an Employee filing a document, or an upload, under 'engagement'; a Manager may", async () => {
    await db.asRole(U.E1, async (s) => {
      const e = await s.fails(
        `insert into documents (client_id, title, file_name, file_size, mime_type, storage_path, uploaded_by, category)
         values ($1, 'Engagement letter', 'x.pdf', 10, 'application/pdf', $2, $3, 'engagement')`,
        [C.A, `${C.A}/x.pdf`, U.E1.id],
      );
      expect(userMessage(e)).toMatch(/Engagement documents .* are kept by Partners and Managers/);
      const move = await s.fails("update documents set category = 'engagement' where id = $1", [F.docPrivate("A")]);
      expect(userMessage(move)).toMatch(/Choose another category/);
    });
    await db.asRole(U.M1, async (s) => {
      const r = await s.attempt(
        `insert into documents (client_id, title, file_name, file_size, mime_type, storage_path, uploaded_by, category)
         values ($1, 'Engagement letter', 'y.pdf', 10, 'application/pdf', $2, $3, 'engagement') returning id`,
        [C.A, `${C.A}/y.pdf`, U.M1.id],
      );
      expect(r.ok).toBe(true);
    });
  });
});

describe("a client's purge waits for its workpapers' retention (§6.8, §7.19)", () => {
  it("names the workpapers still inside their record-keeping period", async () => {
    await db.asRole(U.P1, async (s) => {
      await s.as("super");
      const dup = fid("client:wp-dup");
      await s.exec(`insert into clients (id, client_code, display_name, entity_type, owner_employee_id, status) values ($1, 'TW-C-9200', 'Workpaper Traders', 'individual', $2, 'pending')`, [dup, U.E1.employeeId]);
      await s.as(U.P1);
      await s.exec("select public.delete_client($1, null)", [dup]);
      expect(await s.value("select public.recycle_bin_blockers('client', $1)", [dup])).toEqual([]);

      await s.as("super");
      await s.exec("insert into itr_computations (client_id, financial_year, inputs, results, created_by) values ($1, '2025-26', '{}', '{}', $2)", [dup, U.P1.id]);
      await s.exec("insert into gst_recon_runs (client_id, period, summary, created_by) values ($1, '092026', '{}', $2)", [dup, U.P1.id]);
      await s.as(U.P1);
      const blockers = await s.value<Array<{ code: string; until: string; message: string }>>("select public.recycle_bin_blockers('client', $1)", [dup]);
      const wp = blockers.find((b) => b.code === "workpapers");
      expect(wp?.message).toMatch(/^Its workpapers \(GST reconciliations, ITR computations\) must be kept until/);
      // GST records of FY 2026-27: 72 months from 31 Dec 2027 (the GSTR-9 due date) → 31 Dec 2033.
      expect(wp?.until).toBe("2033-12-31");
      const at = await s.value<string>("select updated_at from clients where id = $1", [dup]);
      const e = await s.fails("select public.purge_deleted('client', $1, $2)", [dup, at]);
      expect(userMessage(e)).toMatch(/can't be purged yet\. Its workpapers/);
    });
  });

  it("lets the purge through once the workpapers' periods have run out", async () => {
    await db.asRole(U.P1, async (s) => {
      await s.as("super");
      const old = fid("client:wp-old");
      await s.exec(`insert into clients (id, client_code, display_name, entity_type, owner_employee_id, status) values ($1, 'TW-C-9201', 'Old Workpapers', 'individual', $2, 'pending')`, [old, U.E1.employeeId]);
      await s.exec("insert into itr_computations (client_id, financial_year, inputs, results, created_by) values ($1, '2010-11', '{}', '{}', $2)", [old, U.P1.id]);
      await s.exec("insert into tax_notices (client_id, notice_type, notice_date, created_by) values ($1, 'IT 143(1)', '2012-01-10', $2)", [old, U.P1.id]);
      await s.as(U.P1);
      await s.exec("select public.delete_client($1, null)", [old]);
      const blockers = await s.value<Array<{ code: string }>>("select public.recycle_bin_blockers('client', $1)", [old]);
      expect(blockers.map((b) => b.code)).not.toContain("workpapers");
    });
  });

  it("reads the FY of a return period written MMYYYY", async () => {
    await db.asSuper(async (s) => {
      expect(await s.value("select gst_recon_period_fy('032026')")).toBe("2025-26");
      expect(await s.value("select gst_recon_period_fy('042026')")).toBe("2026-27");
      expect(await s.value("select gst_recon_period_fy('13x')")).toBeNull();
    });
  });
});

describe("Form 26 reports count by their category (§6.8)", () => {
  async function form26(s: Session, n: number, category: string | null, counts: boolean | null) {
    return s.value<boolean | null>(
      `insert into udin_records (client_id, udin, document_type, document_date, signed_on, generated_on, signing_partner_id, report_form, form26_category, counts_towards_tax_audit_ceiling, financial_year)
       values ($1, $2, 'Tax audit report', '2027-09-01', '2027-09-01', '2027-09-01', $3, 'FORM_26', $4, $5, '2026-27') returning counts_towards_tax_audit_ceiling`,
      [C.A, `27123456${String(n).padStart(10, "0")}`, U.P1.id, category, counts],
    );
  }

  it("counts (a), (b) and combined, and never (c), (d) or (e), whatever the writer sends", async () => {
    await db.asRole(U.P1, async (s) => {
      expect(await form26(s, 1, "a", false)).toBe(true);
      expect(await form26(s, 2, "combined", null)).toBe(true);
      expect(await form26(s, 3, "c", true)).toBe(false);
      expect(await form26(s, 4, "e", true)).toBe(false);
      // No category recorded yet: the writer's choice, counted by default.
      expect(await form26(s, 5, null, null)).toBe(true);
      expect(await form26(s, 6, null, false)).toBe(false);
    });
  });
});

describe("an Employee logs a UDIN only as a member who signs (§4.1)", () => {
  const insert = (signer: string) =>
    `insert into udin_records (client_id, udin, document_type, document_date, signed_on, generated_on, signing_partner_id, report_form)
     values ('${C.A}', '26654321${String(Math.floor(Math.random() * 1e9)).padStart(10, "0")}', 'Certificate', '2026-10-01', '2026-10-01', '2026-10-01', '${signer}', null)`;

  it("refuses an Employee without an ICAI membership number, and allows one with it", async () => {
    await db.asSuper(async (s) => {
      await s.exec("update profiles set icai_membership_no = null where id = $1", [U.E1.id]);
      await s.as(U.E1);
      const e = await s.attempt(insert(U.E1.id));
      expect(e.ok).toBe(false);
      await s.as("super");
      await s.exec("update profiles set icai_membership_no = '654321' where id = $1", [U.E1.id]);
      await s.as(U.E1);
      expect((await s.attempt(insert(U.E1.id))).ok).toBe(true);
      // Never as someone else.
      expect((await s.attempt(insert(U.P1.id))).ok).toBe(false);
    });
  });
});

describe("Filings due in 7 days matches the agenda it opens (§7.2)", () => {
  it("counts and lists the same not-yet-filed deadlines", async () => {
    await db.asSuper(async (s) => {
      const today = await s.value<string>("select to_char(today_ist(), 'YYYY-MM-DD')");
      const inDays = (n: number) => `(date '${today}' + ${n})`;
      await s.exec(
        `insert into compliance_events (client_id, type, title, due_date, source, is_statutory, financial_year, status, workflow_status) values
           ($1, 'gstr_3b', 'GSTR-3B pending', ${inDays(2)}, 'manual', true, '2026-27', 'pending', 'in_progress'),
           ($1, 'gstr_1', 'GSTR-1 filed', ${inDays(3)}, 'manual', true, '2026-27', 'completed', 'filed'),
           ($2, 'tds', 'TDS pending', ${inDays(7)}, 'manual', true, '2026-27', 'pending', 'not_started'),
           ($2, 'tds', 'TDS later', ${inDays(8)}, 'manual', true, '2026-27', 'pending', 'not_started')`,
        [C.A, C.B],
      );
      await s.as(U.P1);
      const fy = await s.value<string>("select financial_year_label(today_ist())");
      const kpi = await s.value<{ kpis: { filings_due_7: number } }>("select dashboard_firm_today($1)", [fy]);
      const all = await s.value<{ total: number }>(`select compliance_agenda(today_ist(), today_ist() + 7, null, null, null, null, null, false, 100, 0)`);
      const pending = await s.value<{ total: number; rows: Array<{ title: string; status: string }> }>(
        `select compliance_agenda(today_ist(), today_ist() + 7, null, null, null, null, null, false, 100, 0, true)`,
      );
      expect(pending.total).toBe(kpi.kpis.filings_due_7);
      expect(all.total).toBeGreaterThan(pending.total);
      expect(pending.rows.every((r) => r.status === "pending")).toBe(true);
      expect(pending.rows.map((r) => r.title)).toEqual(expect.arrayContaining(["GSTR-3B pending", "TDS pending"]));
      expect(pending.rows.map((r) => r.title)).not.toContain("GSTR-1 filed");
    });
  });
});
