/**
 * Documents vault, requests and checklist (§5.8, §6.8, §7.14, §7.19, §7.22, §12): migrations 0120–0123.
 *
 *   - upload slots: only someone who may add files for the client gets one; a portal user's slot is
 *     never confidential, never a new version; slots can't be edited through the API;
 *   - confirm_document_upload: a slot becomes a document (v1 + tags + activity), a new version (the
 *     old file kept as a version) or a request item's upload; idempotent; refuses someone else's
 *     slot, a type mismatch and a client the caller can no longer see;
 *   - the duplicate lookup by SHA-256, under the caller's RLS;
 *   - purge: only from the recycle bin and only after retention_until;
 *   - confidential files: Partners/Managers and the client's own people only;
 *   - requests: created with items in one go, accept/reject with a reason, completes by itself when
 *     every required item is accepted and reopens when it no longer is, cancel stamps;
 *   - checklist: tick, link (same client only), stamps; add/remove are Partner/Manager.
 */
import { describe, expect, it } from "vitest";
import { C, F, SQLSTATE, U, fid, setupTestDatabase, userMessage, type Session, type TestUser } from "./helpers";

const db = setupTestDatabase("documents");

const SHA = (c: string) => c.repeat(64);
const PDF = "application/pdf";
let seq = 0;
const objectId = () => {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
};

type SlotOpts = {
  client?: string;
  purpose?: "new_document" | "new_version" | "request_item";
  documentId?: string | null;
  itemId?: string | null;
  confidential?: boolean;
  source?: string;
  tags?: string[];
  title?: string;
  accept?: boolean;
  mime?: string;
};

async function slot(s: Session, o: SlotOpts = {}): Promise<{ id: string; path: string }> {
  const client = o.client ?? C.A;
  const path = `${client}/${objectId()}.pdf`;
  const id = await s.value<string>(
    `insert into document_uploads (client_id, storage_path, file_name, file_size, mime_type, purpose, document_id, request_item_id,
                                   title, category, financial_year, tags, is_confidential, source, accept_item)
     values ($1, $2, 'Bank statement.pdf', 1000, $3, $4, $5, $6, $7, 'bank_statements', '2026-27', $8, $9, $10, $11) returning id`,
    [client, path, o.mime ?? PDF, o.purpose ?? "new_document", o.documentId ?? null, o.itemId ?? null, o.title ?? "Bank statement", o.tags ?? [], o.confidential ?? false, o.source ?? "staff", o.accept ?? false],
  );
  return { id, path };
}

async function confirm(s: Session, uploadId: string, sha = SHA("a"), mime = PDF): Promise<Record<string, unknown>> {
  return s.value("select confirm_document_upload($1, 1000, $2, $3)", [uploadId, mime, sha]);
}

async function newRequest(s: Session, client: string, items: Array<{ title: string; is_required?: boolean }>): Promise<string> {
  return s.value<string>("select create_document_request($1, 'Audit PBC FY 2026-27', null, null, 3, null, $2::jsonb)", [client, JSON.stringify(items)]);
}

const items = (s: Session, request: string) =>
  s.rows<{ id: string; title: string; status: string; updated_at: string }>("select id, title, status, updated_at from document_request_items where request_id = $1 order by sort_order", [request]);
const requestStatus = (s: Session, request: string) => s.value<string>("select status::text from document_requests where id = $1", [request]);

// -------------------------------------------------------------------------------------------------
// Upload slots (0120)
// -------------------------------------------------------------------------------------------------

describe("upload slots", () => {
  it("staff get a slot only for clients they can see", async () => {
    await db.asRole(U.E1, async (s) => {
      expect((await slot(s)).id).toMatch(/[0-9a-f-]{36}/);
      expect((await s.attempt("insert into document_uploads (client_id, storage_path, file_name, file_size, mime_type, purpose) values ($1, $2, 'x.pdf', 1, $3, 'new_document')", [C.B, `${C.B}/${objectId()}.pdf`, PDF])).ok).toBe(false);
    });
    await db.asRole(U.E3, async (s) => {
      const e = await s.fails("insert into document_uploads (client_id, storage_path, file_name, file_size, mime_type, purpose) values ($1, $2, 'x.pdf', 1, $3, 'new_document')", [C.A, `${C.A}/${objectId()}.pdf`, PDF]);
      expect(e.code).toBe(SQLSTATE.insufficientPrivilege);
    });
    await db.asRole(U.X, async (s) => {
      // JWT says partner, profile says employee: nothing for client A.
      expect((await s.attempt("insert into document_uploads (client_id, storage_path, file_name, file_size, mime_type, purpose) values ($1, $2, 'x.pdf', 1, $3, 'new_document')", [C.A, `${C.A}/${objectId()}.pdf`, PDF])).ok).toBe(false);
    });
  });

  it("a portal user's slot is for their own client, from the portal, never confidential or a new version", async () => {
    await db.asRole(U.CA, async (s) => {
      expect((await slot(s, { source: "client_portal" })).id).toBeTruthy();
      for (const bad of [
        { source: "staff" },
        { source: "client_portal", confidential: true },
        { source: "client_portal", tags: ["x"] },
        { source: "client_portal", client: C.B },
        { source: "client_portal", purpose: "new_version" as const, documentId: F.docShared("A") },
      ]) {
        const r = await s.attempt(
          `insert into document_uploads (client_id, storage_path, file_name, file_size, mime_type, purpose, document_id, tags, is_confidential, source)
           values ($1, $2, 'x.pdf', 1, $3, $4, $5, $6, $7, $8)`,
          [bad.client ?? C.A, `${bad.client ?? C.A}/${objectId()}.pdf`, PDF, bad.purpose ?? "new_document", bad.documentId ?? null, bad.tags ?? [], bad.confidential ?? false, bad.source],
        );
        expect(r.ok, JSON.stringify(bad)).toBe(false);
      }
    });
  });

  it("paths stay in the client's folder, types are the allowed ones, and the lifecycle is the system's", async () => {
    await db.asRole(U.P1, async (s) => {
      const outside = await s.fails("insert into document_uploads (client_id, storage_path, file_name, file_size, mime_type, purpose) values ($1, $2, 'x.pdf', 1, $3, 'new_document')", [C.A, `${C.B}/${objectId()}.pdf`, PDF]);
      expect(outside.code).toBe(SQLSTATE.checkViolation);
      const exe = await s.fails("insert into document_uploads (client_id, storage_path, file_name, file_size, mime_type, purpose) values ($1, $2, 'x.exe', 1, 'application/x-msdownload', 'new_document')", [C.A, `${C.A}/${objectId()}.exe`]);
      expect(exe.code).toBe(SQLSTATE.checkViolation);
      const big = await s.fails("insert into document_uploads (client_id, storage_path, file_name, file_size, mime_type, purpose) values ($1, $2, 'x.pdf', 26214401, $3, 'new_document')", [C.A, `${C.A}/${objectId()}.pdf`, PDF]);
      expect(big.code).toBe(SQLSTATE.checkViolation);
      const r = await s.one<{ confirmed_at: string | null; created_by: string; long: boolean }>(
        `insert into document_uploads (client_id, storage_path, file_name, file_size, mime_type, purpose, confirmed_at, created_by, expires_at)
         values ($1, $2, 'x.pdf', 1, $3, 'new_document', now(), $4, now() + interval '30 days')
         returning confirmed_at, created_by, expires_at > now() + interval '3 hours' as long`,
        [C.A, `${C.A}/${objectId()}.pdf`, PDF, U.P1.id],
      );
      // The guard resets the lifecycle; the policy then sees an unconfirmed slot.
      expect(r).toEqual({ confirmed_at: null, created_by: U.P1.id, long: false });
      const { id } = await slot(s);
      expect((await s.fails("update document_uploads set file_size = 2 where id = $1", [id])).code).toBe(SQLSTATE.insufficientPrivilege);
      expect((await s.fails("delete from document_uploads where id = $1", [id])).code).toBe(SQLSTATE.insufficientPrivilege);
    });
  });

  it("a request item slot needs an open item of the same client; a version slot a live document of it", async () => {
    await db.asRole(U.P1, async (s) => {
      const itemB = await s.value<string>("select id from document_request_items where request_id = $1", [fid("docreq:B")]);
      expect(userMessage(await s.fails(
        "insert into document_uploads (client_id, storage_path, file_name, file_size, mime_type, purpose, request_item_id) values ($1, $2, 'x.pdf', 1, $3, 'request_item', $4)",
        [C.A, `${C.A}/${objectId()}.pdf`, PDF, itemB],
      ))).toMatch(/isn't one of this client's/);
      expect(userMessage(await s.fails(
        "insert into document_uploads (client_id, storage_path, file_name, file_size, mime_type, purpose, document_id) values ($1, $2, 'x.pdf', 1, $3, 'new_version', $4)",
        [C.A, `${C.A}/${objectId()}.pdf`, PDF, F.docPrivate("B")],
      ))).toMatch(/no longer in this client's vault/);
    });
  });
});

// -------------------------------------------------------------------------------------------------
// confirm_document_upload (0121)
// -------------------------------------------------------------------------------------------------

describe("confirm_document_upload", () => {
  it("makes a document with its first version, tags and an 'uploaded' activity; calling it again changes nothing", async () => {
    await db.asRole(U.E1, async (s) => {
      const u = await slot(s, { tags: ["Bank", "FY 2026-27", " "] });
      const r = await confirm(s, u.id, SHA("b"));
      expect(r).toMatchObject({ purpose: "new_document", version: 1, client_id: C.A, title: "Bank statement", already: false });
      const doc = await s.one<Record<string, unknown>>(
        "select title, file_name, file_size, mime_type, storage_path, sha256, version, source, is_confidential, uploaded_by, retention_until > today_ist() + 365 * 6 as kept from documents where id = $1",
        [r.document_id],
      );
      expect(doc).toEqual({ title: "Bank statement", file_name: "Bank statement.pdf", file_size: 1000, mime_type: PDF, storage_path: u.path, sha256: SHA("b"), version: 1, source: "staff", is_confidential: false, uploaded_by: U.E1.id, kept: true });
      expect(await s.rows("select version, storage_path, sha256 from document_versions where document_id = $1", [r.document_id])).toEqual([{ version: 1, storage_path: u.path, sha256: SHA("b") }]);
      expect((await s.rows<{ tag: string }>("select tag::text from document_tags where document_id = $1 order by tag", [r.document_id])).map((t) => t.tag)).toEqual(["Bank", "FY 2026-27"]);
      expect(await s.rows("select activity::text, user_id from document_activities where document_id = $1", [r.document_id])).toEqual([{ activity: "uploaded", user_id: U.E1.id }]);

      const again = await confirm(s, u.id, SHA("b"));
      expect(again).toMatchObject({ document_id: r.document_id, already: true });
      expect(await s.value<number>("select count(*)::int from documents where storage_path = $1", [u.path])).toBe(1);
    });
  });

  it("refuses another person's slot, a type that changed, a missing hash, and a client the caller can no longer see", async () => {
    await db.asSuper(async (s) => {
      await s.as(U.E1);
      const u = await slot(s);
      await s.as(U.P1);
      expect(userMessage(await s.fails("select confirm_document_upload($1, 1000, $2, $3)", [u.id, PDF, SHA("c")]))).toMatch(/isn't one of yours/);
      await s.as(U.E1);
      expect(userMessage(await s.fails("select confirm_document_upload($1, 1000, 'image/png', $2)", [u.id, SHA("c")]))).toMatch(/isn't the type it was declared/);
      expect(userMessage(await s.fails("select confirm_document_upload($1, 1000, $2, 'nope')", [u.id, PDF]))).toMatch(/checksum/);
      expect(userMessage(await s.fails("select confirm_document_upload($1, 26214401, $2, $3)", [u.id, PDF, SHA("c")]))).toMatch(/at most 25 MB/);
      // E1 stops owning client A before confirming.
      await s.as("super");
      await s.exec("update clients set owner_employee_id = $2 where id = $1", [C.A, U.E4.employeeId]);
      await s.as(U.E1);
      expect(userMessage(await s.fails("select confirm_document_upload($1, 1000, $2, $3)", [u.id, PDF, SHA("c")]))).toMatch(/can't add files for this client/);
    });
  });

  it("a portal upload is the client's own, from the portal, and visible to them", async () => {
    await db.asRole(U.CA, async (s) => {
      const u = await slot(s, { source: "client_portal" });
      const r = await confirm(s, u.id, SHA("d"));
      const doc = await s.one<{ source: string; is_confidential: boolean; uploaded_by: string }>("select source, is_confidential, uploaded_by from documents where id = $1", [r.document_id]);
      expect(doc).toEqual({ source: "client_portal", is_confidential: false, uploaded_by: U.CA.id });
      // The portal never reads versions.
      expect(await s.rows("select id from document_versions")).toEqual([]);
    });
  });

  it("a new version keeps the old file as a version and moves the document to the new one", async () => {
    await db.asRole(U.E1, async (s) => {
      const first = await confirm(s, (await slot(s)).id, SHA("e"));
      const v2 = await slot(s, { purpose: "new_version", documentId: first.document_id as string });
      const r = await confirm(s, v2.id, SHA("f"));
      expect(r).toMatchObject({ purpose: "new_version", version: 2, document_id: first.document_id });
      expect(await s.one("select version, storage_path, sha256 from documents where id = $1", [first.document_id])).toEqual({ version: 2, storage_path: v2.path, sha256: SHA("f") });
      expect((await s.rows<{ version: number }>("select version from document_versions where document_id = $1 order by version", [first.document_id])).map((v) => v.version)).toEqual([1, 2]);
      expect((await s.rows<{ activity: string }>("select activity::text from document_activities where document_id = $1 order by created_at, activity", [first.document_id])).map((a) => a.activity).sort()).toEqual(["uploaded", "version_created"]);
    });
  });

  it("versioning a document that has no version rows records its current file first", async () => {
    await db.asRole(U.P1, async (s) => {
      await s.as("super");
      await s.exec("delete from document_versions where document_id = $1", [F.docShared("A")]);
      await s.as(U.P1);
      const v = await slot(s, { purpose: "new_version", documentId: F.docShared("A") });
      await confirm(s, v.id, SHA("1"));
      expect(await s.rows("select version, storage_path, uploaded_by from document_versions where document_id = $1 order by version", [F.docShared("A")])).toEqual([
        { version: 1, storage_path: `client-documents/${C.A}/shared.pdf`, uploaded_by: U.P1.id },
        { version: 2, storage_path: v.path, uploaded_by: U.P1.id },
      ]);
    });
  });

  it("discard marks the slot refused and hands back its path; a refused slot can't be confirmed", async () => {
    await db.asRole(U.E1, async (s) => {
      const u = await slot(s);
      expect(await s.value("select discard_document_upload($1, 'Not a real PDF')", [u.id])).toBe(u.path);
      expect(await s.value("select discard_document_upload($1, 'again')", [u.id])).toBeNull();
      expect(userMessage(await s.fails("select confirm_document_upload($1, 1000, $2, $3)", [u.id, PDF, SHA("2")]))).toMatch(/refused: Not a real PDF/);
    });
  });
});

// -------------------------------------------------------------------------------------------------
// Duplicates, confidentiality, purge
// -------------------------------------------------------------------------------------------------

describe("duplicates by SHA-256", () => {
  it("finds current files and older versions of the same client, under the caller's RLS", async () => {
    await db.asSuper(async (s) => {
      await s.as(U.E1);
      const d = await confirm(s, (await slot(s)).id, SHA("3"));
      await confirm(s, (await slot(s, { purpose: "new_version", documentId: d.document_id as string })).id, SHA("4"));
      const rows = await s.rows<{ document_id: string; version: number; is_current: boolean }>(
        "select document_id, version, is_current from find_document_duplicates($1, $2)",
        [C.A, [SHA("3"), SHA("4"), "not-a-hash"]],
      );
      expect(rows.map((r) => [r.version, r.is_current]).sort()).toEqual([[1, false], [2, true]]);
      await s.as(U.E3);
      expect(await s.rows("select * from find_document_duplicates($1, $2)", [C.A, [SHA("3")]])).toEqual([]);
      await s.as(U.CB);
      expect(await s.rows("select * from find_document_duplicates($1, $2)", [C.A, [SHA("3")]])).toEqual([]);
    });
  });
});

describe("confidential files (§7.14)", () => {
  it("are seen by Partners, Managers and the client's own people only", async () => {
    await db.asSuper(async (s) => {
      await s.as(U.P1);
      const d = await confirm(s, (await slot(s, { confidential: true })).id, SHA("5"));
      const sees = async (who: TestUser) => {
        await s.as(who);
        return (await s.rows("select id from documents where id = $1", [d.document_id])).length === 1;
      };
      expect(await sees(U.M1)).toBe(true);
      expect(await sees(U.E1)).toBe(true); // owner of A
      expect(await sees(U.E2)).toBe(false); // B's team
      expect(await sees(U.E3)).toBe(false); // expired cover only
      expect(await sees(U.CA)).toBe(false); // not shared with the client
      expect(await sees(U.X)).toBe(false);
      // A cover in force makes the cover person one of the client's people (§4.7).
      await s.as("super");
      await s.exec("insert into client_covers (kind, client_id, absent_employee_id, cover_employee_id, ends_at, reason, granted_by) values ('client', $1, $2, $3, now() + interval '1 day', 'leave', $4)", [C.A, U.E1.employeeId, U.E3.employeeId, U.P1.id]);
      expect(await sees(U.E3)).toBe(true);
    });
  });

  it("an Employee can't make a document confidential or share it with the client", async () => {
    await db.asRole(U.E1, async (s) => {
      expect(userMessage(await s.fails("update documents set is_confidential = true where id = $1", [F.docPrivate("A")]))).toMatch(/is confidential/);
    });
  });
});

describe("purging (§6.8, §7.19)", () => {
  it("only from the recycle bin, only after retention_until, only by a Partner", async () => {
    await db.asRole(U.P1, async (s) => {
      expect(userMessage(await s.fails("delete from documents where id = $1", [F.docPrivate("A")]))).toMatch(/recycle bin before purging/);
      await s.exec("update documents set deleted_at = now(), deleted_by = $2 where id = $1", [F.docPrivate("A"), U.P1.id]);
      expect(userMessage(await s.fails("delete from documents where id = $1", [F.docPrivate("A")]))).toMatch(/must be kept until \d{2} [A-Z][a-z]{2} \d{4}/);
      await s.exec("update documents set retention_until = today_ist() where id = $1", [F.docPrivate("A")]);
      expect(userMessage(await s.fails("delete from documents where id = $1", [F.docPrivate("A")]))).toMatch(/must be kept until/);
      await s.exec("update documents set retention_until = today_ist() - 1 where id = $1", [F.docPrivate("A")]);
      expect(await s.exec("delete from documents where id = $1", [F.docPrivate("A")])).toBe(1);
    });
    await db.asRole(U.M1, async (s) => {
      await s.exec("update documents set deleted_at = now(), retention_until = today_ist() - 1 where id = $1", [F.docPrivate("B")]);
      expect(await s.exec("delete from documents where id = $1", [F.docPrivate("B")])).toBe(0);
    });
  });

  it("holds for the system too: nothing is deleted automatically before its time", async () => {
    await db.asSuper(async (s) => {
      expect(userMessage(await s.fails("delete from documents where id = $1", [F.docShared("C")]))).toMatch(/recycle bin/);
    });
  });
});

// -------------------------------------------------------------------------------------------------
// Document requests (0122)
// -------------------------------------------------------------------------------------------------

describe("document requests", () => {
  it("are created with their items in one go by staff who can see the client", async () => {
    await db.asRole(U.E1, async (s) => {
      const id = await newRequest(s, C.A, [{ title: "Bank statement April–September" }, { title: "Rent agreement", is_required: false }]);
      expect((await items(s, id)).map((i) => [i.title, i.status])).toEqual([["Bank statement April–September", "pending"], ["Rent agreement", "pending"]]);
      expect(await s.one("select status::text, created_by, reminder_every_days, reminder_count from document_requests where id = $1", [id])).toEqual({ status: "open", created_by: U.E1.id, reminder_every_days: 3, reminder_count: 0 });
      expect(userMessage(await s.fails("select create_document_request($1, 'x', null, null, 3, null, '[]'::jsonb)", [C.A]))).toMatch(/at least one item/);
      expect(userMessage(await s.fails("select create_document_request($1, ' ', null, null, 3, null, '[{\"title\":\"a\"}]'::jsonb)", [C.A]))).toMatch(/title/);
      expect(userMessage(await s.fails("select create_document_request($1, 'x', current_date - 1, null, 3, null, '[{\"title\":\"a\"}]'::jsonb)", [C.A]))).toMatch(/due date from today/);
      expect(userMessage(await s.fails("select create_document_request($1, 'x', null, null, 3, $2, '[{\"title\":\"a\"}]'::jsonb)", [C.A, fid("contact:B")]))).toMatch(/this client's contacts/);
      expect((await s.fails("select create_document_request($1, 'x', null, null, 3, null, '[{\"title\":\"a\"}]'::jsonb)", [C.B])).code).toBe(SQLSTATE.insufficientPrivilege);
    });
    await db.asRole(U.CA, async (s) => {
      expect(userMessage(await s.fails("select create_document_request($1, 'x', null, null, 3, null, '[{\"title\":\"a\"}]'::jsonb)", [C.A]))).toMatch(/Only the firm's staff/);
    });
  });

  it("the client uploads, staff accept or reject with a reason, and the request completes and reopens by itself", async () => {
    await db.asSuper(async (s) => {
      await s.as(U.M1);
      const req = await newRequest(s, C.A, [{ title: "Bank statement" }, { title: "Rent agreement", is_required: false }]);
      const [bank, rent] = await items(s, req);

      // Accepting needs a file.
      expect(userMessage(await s.fails("select review_document_request_item($1, 'accept')", [bank.id]))).toMatch(/Upload or link the file/);
      expect(userMessage(await s.fails("select review_document_request_item($1, 'reject', 'blurry')", [bank.id]))).toMatch(/Nothing has been uploaded/);

      await s.as(U.CA);
      const up = await confirm(s, (await slot(s, { source: "client_portal", purpose: "request_item", itemId: bank.id })).id, SHA("6"));
      expect(up).toMatchObject({ purpose: "request_item", item_status: "uploaded", request_id: req });

      await s.as(U.E1);
      expect(userMessage(await s.fails("select review_document_request_item($1, 'reject', '  ')", [bank.id]))).toMatch(/Say why/);
      expect(userMessage(await s.fails("select review_document_request_item($1, 'accept', null, null, '2020-01-01')", [bank.id]))).toMatch(/changed by someone else/);
      const rejected = await s.value<Record<string, unknown>>("select review_document_request_item($1, 'reject', 'Pages 3 to 5 are missing')", [bank.id]);
      expect(rejected).toMatchObject({ item_status: "rejected", request_status: "open" });
      expect(await s.one("select reviewed_by, rejection_reason from document_request_items where id = $1", [bank.id])).toEqual({ reviewed_by: U.E1.id, rejection_reason: "Pages 3 to 5 are missing" });

      await s.as(U.CA);
      await confirm(s, (await slot(s, { source: "client_portal", purpose: "request_item", itemId: bank.id })).id, SHA("7"));
      await s.as(U.E1);
      const accepted = await s.value<Record<string, unknown>>("select review_document_request_item($1, 'accept')", [bank.id]);
      // The only required item is accepted: the request completes (the optional one can still come).
      expect(accepted).toMatchObject({ item_status: "accepted", request_status: "completed" });
      expect(await s.value("select completed_at is not null from document_requests where id = $1", [req])).toBe(true);
      expect(await s.value("select rejection_reason from document_request_items where id = $1", [bank.id])).toBeNull();

      // Rejecting an accepted item reopens it; a new required item does too.
      await s.value("select review_document_request_item($1, 'reject', 'Wrong year')", [bank.id]);
      expect(await requestStatus(s, req)).toBe("open");
      await s.value("select review_document_request_item($1, 'accept', null, $2)", [bank.id, up.document_id]);
      expect(await requestStatus(s, req)).toBe("completed");
      await s.as(U.M1);
      await s.exec("insert into document_request_items (request_id, title, sort_order) values ($1, 'Fixed asset register', 5)", [req]);
      expect(await requestStatus(s, req)).toBe("open");
      void rent;
    });
  });

  it("a request of optional items only completes when all of them are accepted", async () => {
    await db.asRole(U.P1, async (s) => {
      const req = await newRequest(s, C.A, [{ title: "A", is_required: false }, { title: "B", is_required: false }]);
      const [a, b] = await items(s, req);
      const doc = F.docPrivate("A");
      await s.value("select review_document_request_item($1, 'accept', null, $2)", [a.id, doc]);
      expect(await requestStatus(s, req)).toBe("open");
      await s.value("select review_document_request_item($1, 'accept', null, $2)", [b.id, doc]);
      expect(await requestStatus(s, req)).toBe("completed");
    });
  });

  it("can't be completed by hand, starts open, and stamps a cancel; a cancelled request takes no items or uploads", async () => {
    await db.asRole(U.E1, async (s) => {
      const req = await newRequest(s, C.A, [{ title: "PAN card" }]);
      expect(userMessage(await s.fails("update document_requests set status = 'completed' where id = $1", [req]))).toMatch(/completes by itself/);
      expect(userMessage(await s.fails("insert into document_requests (client_id, title, created_by, status) values ($1, 'x', $2, 'cancelled')", [C.A, U.E1.id]))).toMatch(/starts open/);
      await s.exec("update document_requests set status = 'cancelled', cancel_reason = 'Client sent it by courier' where id = $1", [req]);
      expect(await s.one("select cancelled_by, cancel_reason, cancelled_at is not null as stamped from document_requests where id = $1", [req])).toEqual({ cancelled_by: U.E1.id, cancel_reason: "Client sent it by courier", stamped: true });
      const [item] = await items(s, req);
      expect(userMessage(await s.fails("select review_document_request_item($1, 'accept', null, $2)", [item.id, F.docPrivate("A")]))).toMatch(/cancelled/);
      expect(userMessage(await s.fails(
        "insert into document_uploads (client_id, storage_path, file_name, file_size, mime_type, purpose, request_item_id) values ($1, $2, 'x.pdf', 1, $3, 'request_item', $4)",
        [C.A, `${C.A}/${objectId()}.pdf`, PDF, item.id],
      ))).toMatch(/cancelled/);
      // An Employee may set who it goes to and count reminders, but not the stamps.
      await s.exec("update document_requests set status = 'open' where id = $1", [req]);
      expect(await s.one("select status::text, cancelled_at, cancel_reason from document_requests where id = $1", [req])).toEqual({ status: "open", cancelled_at: null, cancel_reason: null });
      expect(await s.exec("update document_requests set contact_id = $2, reminder_count = reminder_count + 1, last_reminded_at = now() where id = $1", [req, fid("contact:A")])).toBe(1);
      expect(userMessage(await s.fails("update document_requests set completed_at = now() where id = $1", [req]))).toMatch(/completed at/);
    });
    await db.asRole(U.M1, async (s) => {
      const req = await newRequest(s, C.A, [{ title: "PAN card" }]);
      await s.exec("update document_requests set status = 'cancelled' where id = $1", [req]);
      expect(userMessage(await s.fails("insert into document_request_items (request_id, title) values ($1, 'x')", [req]))).toMatch(/Reopen it before adding/);
    });
  });

  it("other clients' requests are out of reach", async () => {
    await db.asRole(U.E1, async (s) => {
      const itemB = await s.value<string | undefined>("select id from document_request_items where request_id = $1", [fid("docreq:B")]);
      expect(itemB).toBeUndefined();
    });
    await db.asRole(U.CB, async (s) => {
      const itemA = await db.asSuper((x) => x.value<string>("select id from document_request_items where request_id = $1", [fid("docreq:A")]));
      expect(userMessage(await s.fails("select review_document_request_item($1, 'accept')", [itemA]))).toMatch(/Only the firm's staff/);
    });
  });
});

// -------------------------------------------------------------------------------------------------
// Checklist (0123)
// -------------------------------------------------------------------------------------------------

describe("document checklist", () => {
  it("anyone on the client ticks items and links its documents; the stamps follow", async () => {
    await db.asRole(U.E1, async (s) => {
      const id = await s.value<string>("select id from client_document_checklist_items where client_id = $1", [C.A]);
      expect(await s.exec("update client_document_checklist_items set collected = true, document_id = $2 where id = $1", [id, F.docPrivate("A")])).toBe(1);
      expect(await s.one("select collected, collected_by, collected_at is not null as at, document_id from client_document_checklist_items where id = $1", [id])).toEqual({ collected: true, collected_by: U.E1.id, at: true, document_id: F.docPrivate("A") });
      await s.exec("update client_document_checklist_items set collected = false where id = $1", [id]);
      expect(await s.one("select collected_by, collected_at from client_document_checklist_items where id = $1", [id])).toEqual({ collected_by: null, collected_at: null });
      expect(userMessage(await s.fails("update client_document_checklist_items set label = 'x' where id = $1", [id]))).toMatch(/label/);
      expect((await s.fails("insert into client_document_checklist_items (client_id, label) values ($1, 'Partnership deed')", [C.A])).code).toBe(SQLSTATE.insufficientPrivilege);
      expect(await s.exec("delete from client_document_checklist_items where id = $1", [id])).toBe(0);
    });
  });

  it("links only the same client's documents in the vault", async () => {
    await db.asRole(U.M1, async (s) => {
      const id = await s.value<string>("select id from client_document_checklist_items where client_id = $1", [C.A]);
      expect(userMessage(await s.fails("update client_document_checklist_items set document_id = $2 where id = $1", [id, F.docPrivate("B")]))).toMatch(/this client's documents/);
      await s.exec("update documents set deleted_at = now() where id = $1", [F.docShared("A")]);
      expect(userMessage(await s.fails("update client_document_checklist_items set document_id = $2 where id = $1", [id, F.docShared("A")]))).toMatch(/this client's documents/);
      expect(userMessage(await s.fails("update client_document_checklist_items set client_id = $2 where id = $1", [id, C.B]))).toMatch(/moved to another client/);
      const added = await s.value<string>("insert into client_document_checklist_items (client_id, label, collected, sort_order) values ($1, 'Partnership deed', true, 9) returning collected_by::text", [C.A]);
      expect(added).toBe(U.M1.id);
      expect((await s.fails("insert into client_document_checklist_items (client_id, label) values ($1, '  ')", [C.A])).code).toBe(SQLSTATE.checkViolation);
    });
  });
});
