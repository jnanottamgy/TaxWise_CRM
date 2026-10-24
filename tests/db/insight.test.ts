/**
 * Insight in the database (§7.16 reports, §7.18 search, §7.19 recycle bin, §7.20 audit log, §7.21
 * full export, §4.1): search stays inside each role's RLS scope and never shows an Employee a lead,
 * invoice or quotation; recent searches are per user; the recycle bin is Partners' and Managers',
 * restores bring a client's children back, purges are a Partner's and are blocked by retention and
 * the GST record-keeping period; the audit log reads are Partner only; every report refuses anyone
 * but a Partner or a Manager; the export catalogue never offers credential ciphertext or cost rates.
 */
import { describe, expect, it } from "vitest";
import { C, F, U, SQLSTATE, fid, setupTestDatabase, userMessage, type Session } from "./helpers";

const db = setupTestDatabase("insight");

type Group = { type: string; total: number; items: Array<{ id: string; title: string; subtitle: string | null; client_id: string | null }> };

async function search(s: Session, q: string, limit = 5, types: string[] | null = null, offset = 0): Promise<Group[]> {
  const r = await s.value<{ groups: Group[] }>("select public.search_everything($1, $2, $3, $4)", [q, limit, types, offset]);
  return r.groups;
}

const group = (groups: Group[], type: string) => groups.find((g) => g.type === type);

/** Test set-up that the invoice guards would refuse (numbering a fixture invoice, settling one): triggers off for one statement, as the superuser. */
async function rawUpdate(s: Session, sql: string, params: unknown[] = []) {
  await s.as("super");
  await s.exec("set local session_replication_role = replica");
  await s.exec(sql, params);
  await s.exec("set local session_replication_role = origin");
}

/** Client C's sent invoice paid in full, so delete_client lets the client go to the bin. */
async function settleC(s: Session) {
  await rawUpdate(s, "update invoices set status = 'paid', outstanding_amount = 0 where id = $1", [F.invoiceSent("C")]);
}

// =================================================================================================
// Search (§7.18)
// =================================================================================================
describe("search_everything (§7.18)", () => {
  it("finds a client by name, code, PAN, GSTIN, email and phone digits for a Partner", async () => {
    await db.asRole(U.P1, async (s) => {
      await s.as("super");
      await s.exec("update clients set pan = 'AAAPA1234A', email = 'accounts@alpha.example', phone = '+91 98450 12345' where id = $1", [C.A]);
      await s.as(U.P1);
      for (const q of ["Alpha", "TW-C-9001", "aaapa1234a", "accounts@alpha", "98450 12345", "9845012345"]) {
        const g = group(await search(s, q), "client");
        expect(g?.items.map((i) => i.id), q).toContain(C.A);
      }
      // An exact code ranks first.
      const exact = group(await search(s, "TW-C-9002"), "client");
      expect(exact?.items[0]?.id).toBe(C.B);
    });
  });

  it("keeps soft-deleted clients out of every result", async () => {
    await db.asRole(U.P1, async (s) => {
      const g = group(await search(s, "Zeta"), "client");
      expect(g?.total ?? 0).toBe(0);
    });
  });

  it("limits an Employee to their own clients and their tasks, documents and contacts", async () => {
    await db.asRole(U.E1, async (s) => {
      const clients = group(await search(s, "TW-C-900"), "client");
      expect(clients?.items.map((i) => i.id)).toEqual([C.A]);
      expect(clients?.total).toBe(1);
      const tasks = group(await search(s, "GST return"), "task");
      expect(tasks?.items.every((i) => i.client_id === C.A)).toBe(true);
      const docs = group(await search(s, "Private"), "document");
      expect(docs?.items.map((i) => i.client_id)).toEqual([C.A]);
      const contacts = group(await search(s, "Contact"), "contact");
      expect(contacts?.items.map((i) => i.client_id)).toEqual([C.A]);
      // Their own employee row only.
      const people = group(await search(s, "Test"), "employee");
      expect(people?.items.map((i) => i.id)).toEqual([U.E1.employeeId]);
    });
  });

  it("never returns leads, invoices or quotations to an Employee, even when asked for them", async () => {
    await db.asRole(U.E1, async (s) => {
      const groups = await search(s, "TW", 5, ["lead", "invoice", "quotation", "client"]);
      expect(groups.map((g) => g.type)).toEqual(["client"]);
      const all = await search(s, "9001");
      expect(all.some((g) => ["lead", "invoice", "quotation"].includes(g.type))).toBe(false);
    });
  });

  it("searches invoices by number and quotations by number for Partners and Managers", async () => {
    await db.asRole(U.M1, async (s) => {
      await rawUpdate(s, "update invoices set invoice_number = 'TW/26-27/9001' where id = $1", [F.invoiceSent("A")]);
      await s.as(U.M1);
      const inv = group(await search(s, "TW/26-27/9001"), "invoice");
      expect(inv?.items[0]?.id).toBe(F.invoiceSent("A"));
      const quo = group(await search(s, "TW-Q/26-27/902"), "quotation");
      expect(quo?.items.map((i) => i.id)).toEqual([fid("quotation:B")]);
      const leads = group(await search(s, "Lead One"), "lead");
      expect(leads?.total).toBe(1);
    });
  });

  it("refuses a portal user and an anonymous caller", async () => {
    await db.asRole(U.CA, async (s) => {
      const e = await s.fails("select public.search_everything('Alpha', 5)");
      expect(e.code).toBe(SQLSTATE.raiseException);
    });
    await db.asAnon(async (s) => {
      const e = await s.fails("select public.search_everything('Alpha', 5)");
      expect(e.code).toBe(SQLSTATE.insufficientPrivilege);
    });
  });

  it("pages one type with an offset, and treats LIKE wildcards as text", async () => {
    await db.asRole(U.P1, async (s) => {
      const first = group(await search(s, "TW-C-900", 2, ["client"], 0), "client");
      const second = group(await search(s, "TW-C-900", 2, ["client"], 2), "client");
      expect(first?.total).toBe(3);
      expect(first?.items).toHaveLength(2);
      expect(second?.items).toHaveLength(1);
      expect(new Set([...(first?.items ?? []), ...(second?.items ?? [])].map((i) => i.id)).size).toBe(3);
      expect(group(await search(s, "%%"), "client")?.total ?? 0).toBe(0);
    });
  });
});

describe("remember_search (§7.18 recent searches, per user)", () => {
  it("keeps the newest 10, without duplicates, and only for the caller", async () => {
    await db.asRole(U.M1, async (s) => {
      for (let i = 1; i <= 12; i++) await s.exec("select public.remember_search($1)", [`query ${i}`]);
      await s.exec("select public.remember_search('QUERY 5')");
      const rows = await s.rows<{ query: string }>("select query from recent_searches order by searched_at desc, id desc");
      expect(rows).toHaveLength(10);
      expect(rows[0].query).toBe("QUERY 5");
      expect(rows.filter((r) => r.query.toLowerCase() === "query 5")).toHaveLength(1);
      // P1's fixture search is not M1's to see.
      expect(rows.some((r) => r.query === "alpha")).toBe(false);
    });
  });

  it("is refused for a portal user", async () => {
    await db.asRole(U.CB, async (s) => {
      const e = await s.fails("select public.remember_search('beta')");
      expect(e.code).toBe(SQLSTATE.raiseException);
    });
  });
});

// =================================================================================================
// Recycle bin (§7.19)
// =================================================================================================
type BinRow = { entity: string; id: string; title: string; with_client: boolean; parent_in_bin: boolean; tasks_with: number; documents_with: number; invoices_with: number; deleted_by_name: string | null };

describe("recycle_bin_items (§7.19)", () => {
  it("lists the deleted client with who deleted it, for Partners and Managers only", async () => {
    for (const who of [U.P1, U.M1]) {
      await db.asRole(who, async (s) => {
        const rows = await s.rows<BinRow>("select * from recycle_bin_items");
        const z = rows.find((r) => r.id === C.Z);
        expect(z).toMatchObject({ entity: "client", title: "Zeta (deleted)", deleted_by_name: "Test P1" });
      });
    }
    for (const who of [U.E1, U.E2, U.CA, U.X]) {
      await db.asRole(who, async (s) => {
        // E1 owns client Z: RLS would show its deleted tasks, but the bin itself stays shut.
        expect(await s.rows("select * from recycle_bin_items")).toHaveLength(0);
      });
    }
  });

  it("folds what was deleted with a client into the client's row", async () => {
    await db.asRole(U.P1, async (s) => {
      await settleC(s);
      await s.as(U.P1);
      const r = await s.one<{ delete_client: { tasks: number } }>("select public.delete_client($1, null)", [C.C]);
      expect(r.delete_client.tasks).toBe(1);
      const rows = await s.rows<BinRow>("select * from recycle_bin_items where client_id = $1", [C.C]);
      const client = rows.find((x) => x.entity === "client");
      expect(client).toMatchObject({ tasks_with: 1, documents_with: 2 });
      expect(rows.filter((x) => x.entity !== "client").every((x) => x.with_client && x.parent_in_bin)).toBe(true);
    });
  });
});

describe("restore_deleted (§7.19 Restore, Partner/Manager)", () => {
  it("brings a client back with the tasks, documents and invoices deleted with it, but not ones deleted before", async () => {
    await db.asRole(U.P1, async (s) => {
      // A document deleted on its own a day earlier stays in the bin.
      await settleC(s);
      await s.exec("update documents set deleted_at = now() - interval '1 day', deleted_by = $2 where id = $1", [F.docShared("C"), U.P1.id]);
      await s.as(U.P1);
      await s.exec("select public.delete_client($1, null)", [C.C]);

      await s.as(U.M1);
      const updatedAt = await s.value<string>("select updated_at from clients where id = $1", [C.C]);
      const r = await s.value<{ tasks: number; documents: number; invoices: number }>("select public.restore_deleted('client', $1, $2)", [C.C, updatedAt]);
      expect(r).toMatchObject({ tasks: 1, documents: 1, invoices: 2 });
      expect(await s.value("select deleted_at from clients where id = $1", [C.C])).toBeNull();
      expect(await s.value("select deleted_at from tasks where id = $1", [F.task("C")])).toBeNull();
      expect(await s.value("select deleted_at is not null from documents where id = $1", [F.docShared("C")])).toBe(true);
      expect(await s.value("select deleted_at from documents where id = $1", [F.docPrivate("C")])).toBeNull();
    });
  });

  it("refuses a task while its client is in the bin, a stale updated_at, and a second restore", async () => {
    await db.asRole(U.P1, async (s) => {
      await settleC(s);
      await s.as(U.P1);
      await s.exec("select public.delete_client($1, null)", [C.C]);
      const taskAt = await s.value<string>("select updated_at from tasks where id = $1", [F.task("C")]);
      const e1 = await s.fails("select public.restore_deleted('task', $1, $2)", [F.task("C"), taskAt]);
      expect(userMessage(e1)).toMatch(/Gamma LLP is in the recycle bin\. Restore the client first/);

      const e2 = await s.fails("select public.restore_deleted('client', $1, $2)", [C.C, "2020-01-01T00:00:00Z"]);
      expect(userMessage(e2)).toMatch(/^Changed by .* Reload the recycle bin/);

      const at = await s.value<string>("select updated_at from clients where id = $1", [C.C]);
      await s.exec("select public.restore_deleted('client', $1, $2)", [C.C, at]);
      const e3 = await s.fails("select public.restore_deleted('client', $1, $2)", [C.C, at]);
      expect(userMessage(e3)).toMatch(/isn't in the recycle bin any more/);
    });
  });

  it("restores a lead, and a quotation only once its lead is back", async () => {
    await db.asRole(U.M1, async (s) => {
      await s.as("super");
      const lead = await s.value<string>("select id from leads where lead_number = 'L-9001'");
      await s.exec("update quotations set lead_id = $1 where id = $2", [lead, fid("quotation:A")]);
      await s.exec("update leads set deleted_at = now(), deleted_by = $2 where id = $1", [lead, U.M1.id]);
      await s.exec("update quotations set deleted_at = now(), deleted_by = $2 where id = $1", [fid("quotation:A"), U.M1.id]);
      await s.as(U.M1);
      const qAt = await s.value<string>("select updated_at from quotations where id = $1", [fid("quotation:A")]);
      const e = await s.fails("select public.restore_deleted('quotation', $1, $2)", [fid("quotation:A"), qAt]);
      expect(userMessage(e)).toMatch(/Its lead Lead One is in the recycle bin/);
      const lAt = await s.value<string>("select updated_at from leads where id = $1", [lead]);
      await s.exec("select public.restore_deleted('lead', $1, $2)", [lead, lAt]);
      await s.exec("select public.restore_deleted('quotation', $1, $2)", [fid("quotation:A"), qAt]);
      expect(await s.value("select deleted_at from quotations where id = $1", [fid("quotation:A")])).toBeNull();
    });
  });

  it("is refused for an Employee", async () => {
    await db.asRole(U.E1, async (s) => {
      const e = await s.fails("select public.restore_deleted('client', $1, now())", [C.Z]);
      expect(userMessage(e)).toMatch(/Only Partners and Managers restore/);
    });
  });
});

describe("purge_deleted (§7.19 Purge, Partner only, §6.8 retention)", () => {
  it("is refused for a Manager and an Employee", async () => {
    for (const who of [U.M1, U.E1]) {
      await db.asRole(who, async (s) => {
        const e = await s.fails("select public.purge_deleted('client', $1, now())", [C.Z]);
        expect(userMessage(e)).toMatch(/Only a Partner can purge/);
      });
    }
  });

  it("refuses anything that isn't in the bin", async () => {
    await db.asRole(U.P1, async (s) => {
      const at = await s.value<string>("select updated_at from clients where id = $1", [C.A]);
      const e = await s.fails("select public.purge_deleted('client', $1, $2)", [C.A, at]);
      expect(userMessage(e)).toMatch(/isn't in the recycle bin, so it can't be purged/);
    });
  });

  it("blocks a client whose documents, invoices and registers are still under retention, naming each reason", async () => {
    await db.asRole(U.P1, async (s) => {
      await settleC(s);
      await s.as(U.P1);
      await s.exec("select public.delete_client($1, null)", [C.C]);
      const blockers = await s.value<Array<{ code: string; message: string }>>("select public.recycle_bin_blockers('client', $1)", [C.C]);
      const codes = blockers.map((b) => b.code);
      expect(codes).toEqual(expect.arrayContaining(["documents_retention", "settlements", "udin_register", "filing_history", "engagement_letters"]));
      const at = await s.value<string>("select updated_at from clients where id = $1", [C.C]);
      const e = await s.fails("select public.purge_deleted('client', $1, $2)", [C.C, at]);
      expect(userMessage(e)).toMatch(/^Gamma LLP \(TW-C-9003\) can't be purged yet\. .*documents must be kept until/);
      expect(await s.value("select count(*)::int from clients where id = $1", [C.C])).toBe(1);
    });
  });

  it("blocks an issued invoice inside the GST record-keeping period and one with receipts", async () => {
    await db.asRole(U.P1, async (s) => {
      await rawUpdate(s, "update invoices set invoice_number = 'TW/26-27/9002', deleted_at = now(), deleted_by = $2 where id = $1", [F.invoiceSent("B"), U.P1.id]);
      await s.as(U.P1);
      const blockers = await s.value<Array<{ code: string; until?: string; message: string }>>("select public.recycle_bin_blockers('invoice', $1)", [F.invoiceSent("B")]);
      const gst = blockers.find((b) => b.code === "gst_records");
      // FY 2026-27: the annual return is due 31 Dec 2027; 72 months later is 31 Dec 2033.
      expect(gst?.until).toBe("2033-12-31");
      expect(gst?.message).toMatch(/CGST Act s\.36/);
      expect(blockers.some((b) => b.code === "settlements")).toBe(true);
    });
  });

  it("moves the GST period with a recorded GSTR-9 extension", async () => {
    await db.asSuper(async (s) => {
      expect(await s.value("select public.gst_records_kept_until('2025-26')::text")).toBe("2032-12-31");
      await s.exec("insert into due_date_overrides (rule_code, period_label, original_due, extended_due, source_ref) values ('GSTR9', 'FY 2025-26', '2026-12-31', '2027-02-28', 'Notification 01/2027-CT')");
      expect(await s.value("select public.gst_records_kept_until('2025-26')::text")).toBe("2033-02-28");
    });
  });

  it("purges a deleted draft invoice, a lead and a task for good", async () => {
    await db.asRole(U.P1, async (s) => {
      await s.as("super");
      await s.exec("update invoices set deleted_at = now(), deleted_by = $2 where id = $1", [F.invoiceDraft("A"), U.P1.id]);
      await s.exec("update tasks set deleted_at = now(), deleted_by = $2 where id = $1", [F.task("A"), U.P1.id]);
      const lead = await s.value<string>("select id from leads where lead_number = 'L-9002'");
      await s.exec("update leads set deleted_at = now(), deleted_by = $2 where id = $1", [lead, U.P1.id]);
      await s.as(U.P1);
      for (const [entity, id] of [["invoice", F.invoiceDraft("A")], ["task", F.task("A")], ["lead", lead]] as const) {
        const table = entity === "invoice" ? "invoices" : entity === "task" ? "tasks" : "leads";
        const at = await s.value<string>(`select updated_at from ${table} where id = $1`, [id]);
        const r = await s.value<{ entity: string }>("select public.purge_deleted($1, $2, $3)", [entity, id, at]);
        expect(r.entity).toBe(entity);
        expect(await s.value(`select count(*)::int from ${table} where id = $1`, [id])).toBe(0);
      }
      // The task's time stays with the person, without the task.
      expect(await s.value("select count(*)::int from time_entries where employee_id = $1 and task_id is null", [U.E1.employeeId])).toBe(1);
    });
  });

  it("purges a document only once its retention has run out, and returns its files", async () => {
    await db.asRole(U.P1, async (s) => {
      await s.as("super");
      await s.exec("update documents set deleted_at = now(), deleted_by = $2 where id = $1", [F.docPrivate("B"), U.P1.id]);
      await s.as(U.P1);
      let at = await s.value<string>("select updated_at from documents where id = $1", [F.docPrivate("B")]);
      const e = await s.fails("select public.purge_deleted('document', $1, $2)", [F.docPrivate("B"), at]);
      expect(userMessage(e)).toMatch(/must be kept until .* under the retention rules/);

      await s.as("super");
      await s.exec("update documents set retention_until = today_ist() - 1 where id = $1", [F.docPrivate("B")]);
      await s.as(U.P1);
      at = await s.value<string>("select updated_at from documents where id = $1", [F.docPrivate("B")]);
      const r = await s.value<{ storage_paths: string[] }>("select public.purge_deleted('document', $1, $2)", [F.docPrivate("B"), at]);
      expect(r.storage_paths).toEqual(expect.arrayContaining([`client-documents/${C.B}/private.pdf`, `client-documents/${C.B}/private-v1.pdf`]));
      expect(await s.value("select count(*)::int from documents where id = $1", [F.docPrivate("B")])).toBe(0);
    });
  });

  it("purges a duplicate client that holds nothing under retention, with its rows and files", async () => {
    await db.asRole(U.P1, async (s) => {
      await s.as("super");
      const dup = fid("client:dup");
      await s.exec(`insert into clients (id, client_code, display_name, entity_type, owner_employee_id, status) values ($1, 'TW-C-9100', 'Alpha Traders (duplicate)', 'proprietorship', $2, 'pending')`, [dup, U.E1.employeeId]);
      await s.exec("insert into client_contacts (client_id, name) values ($1, 'Dup contact')", [dup]);
      await s.exec(`insert into documents (client_id, title, file_name, file_size, mime_type, storage_path, uploaded_by, retention_until)
                    values ($1::uuid, 'PAN copy', 'pan.pdf', 10, 'application/pdf', 'client-documents/' || $1::text || '/pan.pdf', $2, today_ist() - 1)`, [dup, U.P1.id]);
      await s.exec("insert into tasks (task_number, client_id, title, created_by) values ('T-999001', $1, 'Onboarding checks', $2)", [dup, U.P1.id]);
      await s.as(U.P1);
      await s.exec("select public.delete_client($1, null)", [dup]);
      expect(await s.value("select public.recycle_bin_blockers('client', $1)", [dup])).toEqual([]);
      const at = await s.value<string>("select updated_at from clients where id = $1", [dup]);
      const r = await s.value<{ storage_paths: string[]; counts: Record<string, number> }>("select public.purge_deleted('client', $1, $2)", [dup, at]);
      expect(r.storage_paths).toEqual([`client-documents/${dup}/pan.pdf`]);
      expect(r.counts).toMatchObject({ documents: 1, tasks: 1 });
      await s.as("super");
      expect(await s.value("select count(*)::int from clients where id = $1", [dup])).toBe(0);
      expect(await s.value("select count(*)::int from client_contacts where client_id = $1", [dup])).toBe(0);
    });
  });
});

// =================================================================================================
// Audit log (§7.20)
// =================================================================================================
describe("audit_log_page and audit_log_facets (§7.20)", () => {
  it("pages and filters the log for a Partner", async () => {
    await db.asRole(U.P1, async (s) => {
      await s.exec("select public.log_audit_event('data_update', 'client', $1, 'clients.update', '{\"before\": {\"status\": \"pending\"}, \"after\": {\"status\": \"active\"}}'::jsonb)", [C.A]);
      const all = await s.value<{ total: number; rows: Array<{ event: string; user_name: string | null; details: unknown }> }>("select public.audit_log_page('{}'::jsonb)");
      expect(all.total).toBeGreaterThanOrEqual(2);
      expect(all.rows[0]).toMatchObject({ event: "data_update", user_name: "Test P1" });
      const filtered = await s.value<{ total: number }>("select public.audit_log_page($1::jsonb)", [JSON.stringify({ events: ["login_success"] })]);
      expect(filtered.total).toBe(1);
      const byResource = await s.value<{ total: number }>("select public.audit_log_page($1::jsonb)", [JSON.stringify({ resource_type: "client", resource_id: C.A })]);
      expect(byResource.total).toBe(1);
      const q = await s.value<{ total: number }>("select public.audit_log_page($1::jsonb)", [JSON.stringify({ q: "clients.upd" })]);
      expect(q.total).toBe(1);
      const facets = await s.value<{ users: Array<{ id: string }>; resource_types: Array<{ value: string }> }>("select public.audit_log_facets()");
      expect(facets.users.map((u) => u.id)).toContain(U.P1.id);
      expect(facets.resource_types.map((r) => r.value)).toContain("client");
    });
  });

  it("is Partner only, and the log stays insert-only", async () => {
    for (const who of [U.M1, U.E1, U.CA]) {
      await db.asRole(who, async (s) => {
        const e = await s.fails("select public.audit_log_page('{}'::jsonb)");
        expect(userMessage(e)).toMatch(/The audit log is for Partners/);
      });
    }
    await db.asRole(U.P1, async (s) => {
      expect((await s.attempt("update audit_logs set action = 'x' where id = $1", [F.auditLog])).ok).toBe(false);
      expect((await s.attempt("delete from audit_logs where id = $1", [F.auditLog])).ok).toBe(false);
    });
  });
});

// =================================================================================================
// Reports (§7.16)
// =================================================================================================
const REPORTS = ["report_compliance", "report_work", "report_clients", "report_collections", "report_people", "report_pipeline", "report_practice"] as const;

describe("reports (§7.16)", () => {
  it("every report runs for a Partner and a Manager, and refuses everyone else", async () => {
    for (const who of [U.P1, U.M1]) {
      await db.asRole(who, async (s) => {
        for (const fn of REPORTS) {
          const r = await s.value<Record<string, unknown>>(`select public.${fn}($1::jsonb)`, [JSON.stringify({ from: "2026-04-01", to: "2027-03-31" })]);
          expect(r, fn).toHaveProperty("from", "2026-04-01");
        }
      });
    }
    for (const who of [U.E1, U.X, U.CA]) {
      await db.asRole(who, async (s) => {
        for (const fn of REPORTS) {
          const e = await s.fails(`select public.${fn}('{}'::jsonb)`);
          expect(userMessage(e), fn).toMatch(/Reports are for Partners and Managers/);
        }
      });
    }
  });

  it("refuses a period that ends before it starts", async () => {
    await db.asRole(U.P1, async (s) => {
      const e = await s.fails("select public.report_work($1::jsonb)", [JSON.stringify({ from: "2026-10-01", to: "2026-09-01" })]);
      expect(userMessage(e)).toBe("Choose a period that ends after it starts.");
    });
  });

  it("compliance: counts filed on time, filed late and overdue per return", async () => {
    await db.asRole(U.P1, async (s) => {
      await s.as("super");
      await s.exec(`insert into compliance_events (client_id, type, form_code, title, due_date, source, is_statutory, financial_year, filing_period, status, completed_at)
        values ($1, 'gstr_3b', 'GSTR-3B', 'GSTR-3B Aug', '2026-09-20', 'manual', true, '2026-27', 'Aug 2026', 'completed', '2026-09-18 10:00+05:30'),
               ($2, 'gstr_3b', 'GSTR-3B', 'GSTR-3B Aug', '2026-09-20', 'manual', true, '2026-27', 'Aug 2026', 'completed', '2026-09-25 10:00+05:30'),
               ($3, 'gstr_3b', 'GSTR-3B', 'GSTR-3B Aug', '2026-09-20', 'manual', true, '2026-27', 'Aug 2026', 'pending', null)`, [C.A, C.B, C.C]);
      await s.as(U.P1);
      const r = await s.value<{ by_return: Array<{ form_code: string; filing_period: string; due: number; filed: number; on_time: number; late: number; overdue: number }>; kpis: Record<string, number> }>(
        "select public.report_compliance($1::jsonb)", [JSON.stringify({ from: "2026-09-01", to: "2026-09-30" })]);
      expect(r.by_return).toEqual([expect.objectContaining({ form_code: "GSTR-3B", filing_period: "Aug 2026", due: 3, filed: 2, on_time: 1, late: 1, overdue: 1 })]);
      expect(r.kpis).toMatchObject({ due: 3, filed: 2, on_time: 1, late: 1 });
      const onlyA = await s.value<{ kpis: Record<string, number> }>("select public.report_compliance($1::jsonb)", [JSON.stringify({ from: "2026-09-01", to: "2026-09-30", client_id: C.A })]);
      expect(onlyA.kpis).toMatchObject({ due: 1, on_time: 1 });
    });
  });

  it("work: counts submissions and send-backs per person", async () => {
    await db.asRole(U.M1, async (s) => {
      await s.as("super");
      await s.exec(`insert into task_status_history (task_id, from_status, to_status, changed_by, changed_at)
        values ($1, 'in_progress', 'under_review', $2, now()), ($1, 'under_review', 'in_progress', $2, now()), ($1, 'in_progress', 'under_review', $2, now())`, [F.task("A"), U.E1.id]);
      await s.as(U.M1);
      const today = await s.value<string>("select today_ist()::text");
      const r = await s.value<{ by_person: Array<{ employee_id: string; submitted: number; sent_back: number; open_now: number }> }>(
        "select public.report_work($1::jsonb)", [JSON.stringify({ from: "2026-04-01", to: today })]);
      expect(r.by_person.find((x) => x.employee_id === U.E1.employeeId)).toMatchObject({ submitted: 2, sent_back: 1, open_now: 1 });
    });
  });

  it("practice: reads the UDIN register for the period and the letter coverage for the FY", async () => {
    await db.asRole(U.P1, async (s) => {
      const r = await s.value<{ udin: { total: number; rows: Array<{ udin: string }> }; letters: { clients: number; draft: number; missing_total: number }; ceiling: Array<{ member_profile_id: string; total: number }> }>(
        "select public.report_practice($1::jsonb)", [JSON.stringify({ from: "2026-04-01", to: "2027-03-31", fy: "2026-27", limit: 2 })]);
      expect(r.udin.total).toBe(3);
      expect(r.udin.rows).toHaveLength(2);
      expect(r.letters).toMatchObject({ clients: 3, draft: 3, missing_total: 3 });
      expect(r.ceiling.map((c) => c.member_profile_id)).toEqual(expect.arrayContaining([U.P1.id, U.P2.id]));
    });
  });

  it("collections: ages the receivables and keeps money to Partners and Managers", async () => {
    await db.asRole(U.P1, async (s) => {
      const r = await s.value<{ receivables: { count: number; outstanding: string }; ageing: Array<{ bucket: string; count: number }> }>(
        "select public.report_collections($1::jsonb)", [JSON.stringify({ from: "2026-04-01", to: "2027-03-31" })]);
      // The three fixture invoices are Sent with 5,900 − 1,000 received − 118 credited outstanding.
      expect(r.receivables.count).toBe(3);
      expect(Number(r.receivables.outstanding)).toBeCloseTo(3 * 4782, 2);
      expect(r.ageing.map((a) => a.bucket)).toEqual(["d0_30", "d31_60", "d61_90", "d90_plus"]);
    });
  });
});

// =================================================================================================
// Full export catalogue (§7.21)
// =================================================================================================
describe("full_export_catalog (§7.21)", () => {
  it("lists the readable tables with their readable columns, never ciphertext or cost rates", async () => {
    await db.asRole(U.P1, async (s) => {
      const cat = await s.value<Array<{ name: string; kind: string; columns: string[]; key: string[] | null }>>("select public.full_export_catalog()");
      const names = cat.map((c) => c.name);
      expect(names).toEqual(expect.arrayContaining(["clients", "invoices", "audit_logs", "documents", "client_credentials_list", "employee_cost_rates"]));
      expect(names).not.toContain("client_credentials");
      expect(names).not.toContain("rate_limits");
      const employees = cat.find((c) => c.name === "employees");
      expect(employees?.columns).not.toContain("cost_rate_per_hour");
      expect(cat.find((c) => c.name === "client_credentials_list")?.columns).not.toContain("password_ciphertext");
      expect(cat.find((c) => c.name === "clients")?.key).toEqual(["id"]);
      expect(cat.find((c) => c.name === "quotations")?.columns).not.toContain("token");
      expect(cat.find((c) => c.name === "quotations")?.columns).toContain("total");
      expect(cat.find((c) => c.name === "desktop_devices")?.columns).not.toContain("device_key");
    });
  });

  it("is Partner only", async () => {
    for (const who of [U.M1, U.E1, U.CA]) {
      await db.asRole(who, async (s) => {
        const e = await s.fails("select public.full_export_catalog()");
        expect(userMessage(e)).toMatch(/Only a Partner can export/);
      });
    }
  });
});
