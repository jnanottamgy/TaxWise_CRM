/**
 * The client portal's database layer (migrations 0175–0176, §4.6, §7.22, §18.3 Client 1–7).
 *
 *   - portal_compliance_events / portal_filing_records / portal_messages: the signed-in client's own
 *     rows only, portal-safe columns only; staff, anon, a forged JWT role and another client's login
 *     see nothing of it (§18.3 Client 2 and 6);
 *   - the base tables compliance_events and filing_records no longer answer a portal user;
 *   - mark_portal_message_read: the firm's messages to this client only, with a read event each;
 *   - submit_portal_payment_claim and the claims insert policy: the caller's own payable invoice,
 *     a reference and a date, no duplicates, a screenshot that is their own upload; the invoice is
 *     never marked paid (§18.3 Client 4);
 *   - payment proofs are hidden from Employees (document, versions, activities, stored object) and
 *     stay visible to Partners, Managers and the client (§4.1).
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { C, F, U, fid, isDenied, setupTestDatabase, userMessage, type Session } from "./helpers";

const db = setupTestDatabase("portal");

const PORTAL_VIEWS = ["portal_compliance_events", "portal_filing_records", "portal_messages"] as const;

async function clientIdsIn(s: Session, view: string): Promise<string[]> {
  const rows = await s.rows<{ client_id: string }>(`select distinct client_id from public.${view}`);
  return rows.map((r) => r.client_id).sort();
}

async function viewColumns(s: Session, view: string): Promise<string[]> {
  const rows = await s.rows<{ column_name: string }>(
    "select column_name from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position",
    [view],
  );
  return rows.map((r) => r.column_name);
}

/** A portal upload slot for client A by CA, as the documents module reserves it (0120). */
async function slotForCA(s: Session, mime = "image/png"): Promise<{ id: string; path: string }> {
  await s.as(U.CA);
  const path = `${C.A}/${randomUUID()}.png`;
  const id = await s.value<string>(
    `insert into document_uploads (client_id, storage_path, file_name, file_size, mime_type, purpose, title, category, source)
     values ($1, $2, 'payment.png', 2048, $3, 'new_document', 'Payment proof', 'other', 'client_portal') returning id`,
    [C.A, path, mime],
  );
  return { id, path };
}

const SHA = "a".repeat(64);

const submitClaim = (s: Session, invoice: string, reference: string, opts: { paidOn?: string; upload?: string | null } = {}) =>
  s.attempt<{ r: Record<string, string | null> }>(
    `select submit_portal_payment_claim($1, $2, coalesce($3::date, public.today_ist()), 'Paid by UPI', $4, 2048, 'image/png', $5) as r`,
    [invoice, reference, opts.paidOn ?? null, opts.upload ?? null, opts.upload ? SHA : null],
  );

describe("portal views: own client, portal-safe columns (§4.6, §7.22)", () => {
  it("each portal user sees only their own client's rows, and the checks aren't vacuous", async () => {
    for (const [user, client] of [
      [U.CA, C.A],
      [U.CB, C.B],
    ] as const) {
      await db.asRole(user, async (s) => {
        for (const v of PORTAL_VIEWS) {
          expect(await clientIdsIn(s, v), `${user.key} ${v}`).toEqual([client]);
        }
      });
    }
  });

  it("deadlines are the statutory ones only; the firm's internal steps never show", async () => {
    await db.asRole(U.CA, async (s) => {
      const ids = (await s.rows<{ id: string }>("select id from portal_compliance_events")).map((r) => r.id);
      expect(ids).toContain(fid("ce:A:stat"));
      expect(ids).not.toContain(fid("ce:A:ops"));
    });
  });

  it("messages are the portal channel only: never email, internal notes or invoice emails", async () => {
    await db.asRole(U.CA, async (s) => {
      const ids = (await s.rows<{ id: string }>("select id from portal_messages")).map((r) => r.id);
      expect(ids).toEqual([fid("msg:A:portal")]);
      const m = await s.one<{ sender_name: string | null; attachment_count: number }>("select sender_name, attachment_count from portal_messages");
      expect(m.sender_name).toBe(U.P1.fullName);
      expect(m.attachment_count).toBe(1);
    });
  });

  it("no staff notes, workflow internals, task ids or provider ids in any portal view", async () => {
    await db.asSuper(async (s) => {
      const forbidden = ["notes", "workflow_status", "task_id", "dedupe_key", "reminder_sent_at", "rule_code", "override_id", "created_by",
        "template_id", "provider_message_id", "error", "related_entity_type", "related_entity_id", "sent_by", "document_id", "shareable_with_client"];
      for (const v of PORTAL_VIEWS) {
        const cols = await viewColumns(s, v);
        expect(cols.length, v).toBeGreaterThan(0);
        expect(cols.filter((c) => forbidden.includes(c)), v).toEqual([]);
      }
    });
  });

  it("every filing is listed with its acknowledgement number; the document only when shareable", async () => {
    await db.asRole(U.CA, async (s) => {
      await s.as("super");
      await s.exec("update filing_records set acknowledgement_no = 'AA2910260012345', document_id = $2 where client_id = $1 and filing_type = 'GSTR-3B'", [C.A, F.docPrivate("A")]);
      await s.exec("update filing_records set acknowledgement_no = 'AA2910260054321', document_id = $2 where client_id = $1 and filing_type = 'GSTR-1'", [C.A, F.docShared("A")]);
      await s.as(U.CA);
      const rows = await s.rows<{ filing_type: string; acknowledgement_no: string; acknowledgement_document_id: string | null }>(
        "select filing_type, acknowledgement_no, acknowledgement_document_id from portal_filing_records order by filing_type",
      );
      expect(rows).toEqual([
        { filing_type: "GSTR-1", acknowledgement_no: "AA2910260054321", acknowledgement_document_id: null },
        { filing_type: "GSTR-3B", acknowledgement_no: "AA2910260012345", acknowledgement_document_id: F.docPrivate("A") },
      ]);
    });
  });

  it("a deadline carries its filing, a coarse progress and the extension that moved it", async () => {
    await db.asRole(U.CA, async (s) => {
      await s.as("super");
      const ev = fid("ce:A:stat");
      await s.exec("update compliance_events set workflow_status = 'documents_awaited' where id = $1", [ev]);
      await s.as(U.CA);
      expect(await s.value("select progress from portal_compliance_events where id = $1", [ev])).toBe("waiting_on_you");

      await s.as("super");
      await s.exec("update compliance_events set workflow_status = 'under_review' where id = $1", [ev]);
      await s.as(U.CA);
      expect(await s.value("select progress from portal_compliance_events where id = $1", [ev])).toBe("in_progress");

      await s.as("super");
      const override = await s.value<string>(
        `insert into due_date_overrides (rule_code, period_label, original_due, extended_due, source_ref)
         values ('GSTR3B_MONTHLY', 'Oct 2026', '2026-11-20', '2026-11-27', 'Notification 99/2026-Central Tax') returning id`,
      );
      await s.exec("update compliance_events set original_due_date = '2026-11-20', due_date = '2026-11-27', override_id = $2 where id = $1", [ev, override]);
      await s.exec(
        `insert into filing_records (client_id, financial_year, filing_type, filed_on, acknowledgement_no, compliance_event_id, shareable_with_client, document_id)
         values ($1, '2026-27', 'GSTR-3B', '2026-11-25', 'AA291026ARN0001', $2, true, $3)`,
        [C.A, ev, F.docShared("A")],
      );
      await s.exec("update compliance_events set workflow_status = 'filed' where id = $1", [ev]);
      await s.as(U.CA);
      const row = await s.one<Record<string, unknown>>(
        "select progress, status, is_extended, extension_ref, acknowledgement_no, acknowledgement_document_id, is_overdue from portal_compliance_events where id = $1",
        [ev],
      );
      expect(row).toMatchObject({
        progress: "filed",
        status: "completed",
        is_extended: true,
        extension_ref: "Notification 99/2026-Central Tax",
        acknowledgement_no: "AA291026ARN0001",
        acknowledgement_document_id: F.docShared("A"),
        is_overdue: false,
      });
    });
  });

  it("staff, anon and users without a valid role read nothing through the portal views", async () => {
    for (const user of [U.P1, U.M1, U.E1, U.X, U.D]) {
      await db.asRole(user, async (s) => {
        for (const v of PORTAL_VIEWS) expect(await s.value<number>(`select count(*)::int from public.${v}`), `${user.key} ${v}`).toBe(0);
      });
    }
    await db.asAnon(async (s) => {
      for (const v of PORTAL_VIEWS) expect(isDenied(await s.attempt(`select 1 from public.${v}`)), v).toBe(true);
    });
  });

  it("the views are read-only for signed-in users", async () => {
    await db.asSuper(async (s) => {
      for (const v of PORTAL_VIEWS) {
        for (const priv of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
          expect(await s.value<boolean>("select has_table_privilege('authenticated', $1, $2)", [`public.${v}`, priv]), `${v} ${priv}`).toBe(false);
        }
        expect(await s.value<boolean>("select has_table_privilege('authenticated', $1, 'SELECT')", [`public.${v}`])).toBe(true);
        expect(await s.value<boolean>("select has_table_privilege('anon', $1, 'SELECT')", [`public.${v}`])).toBe(false);
      }
    });
    await db.asRole(U.CA, async (s) => {
      expect((await s.attempt("delete from portal_compliance_events")).ok).toBe(false);
      expect((await s.attempt("update portal_filing_records set acknowledgement_no = 'X'")).ok).toBe(false);
      expect((await s.attempt("insert into portal_messages (id) values (gen_random_uuid())")).ok).toBe(false);
    });
  });
});

describe("§18.3 Client 6: a role claim the client can edit grants nothing", () => {
  it("CB carries role 'partner' in user_metadata and still sees only client B, and no staff data", async () => {
    await db.asRole(U.CB, async (s) => {
      expect(await s.value("select app_role()")).toBe("client");
      for (const v of PORTAL_VIEWS) expect(await clientIdsIn(s, v)).toEqual([C.B]);
      expect(await s.value<number>("select count(*)::int from clients")).toBe(0);
      expect(await s.value<number>("select count(*)::int from portal_compliance_events where client_id = $1", [C.A])).toBe(0);
    });
  });

  it("a forged JWT role ('partner' in app_metadata, profile says client) sees nothing at all", async () => {
    await db.asRole(
      U.CA,
      async (s) => {
        expect(await s.value("select app_role()")).toBeNull();
        for (const v of [...PORTAL_VIEWS, "portal_invoices", "portal_my_client", "compliance_events", "filing_records", "clients"]) {
          expect(await s.value<number>(`select count(*)::int from public.${v}`), v).toBe(0);
        }
      },
      { appRole: "partner" },
    );
  });

  it("asking for another client's rows by id returns nothing", async () => {
    await db.asRole(U.CA, async (s) => {
      expect(await s.value<number>("select count(*)::int from portal_compliance_events where client_id = $1", [C.B])).toBe(0);
      expect(await s.value<number>("select count(*)::int from portal_filing_records where client_id = $1", [C.B])).toBe(0);
      expect(await s.value<number>("select count(*)::int from portal_messages where id = $1", [fid("msg:B:portal")])).toBe(0);
    });
  });
});

describe("base compliance tables no longer answer the portal", () => {
  it("compliance_events and filing_records: portal users read none; staff still read theirs", async () => {
    for (const user of [U.CA, U.CB]) {
      await db.asRole(user, async (s) => {
        expect(await s.value<number>("select count(*)::int from compliance_events")).toBe(0);
        expect(await s.value<number>("select count(*)::int from filing_records")).toBe(0);
        expect(await s.value<number>("select count(*)::int from compliance_events_view")).toBe(0);
      });
    }
    await db.asRole(U.E1, async (s) => {
      expect(await s.value<number>("select count(*)::int from compliance_events where client_id = $1", [C.A])).toBeGreaterThan(0);
      expect(await s.value<number>("select count(*)::int from filing_records where client_id = $1", [C.A])).toBeGreaterThan(0);
    });
  });

  it("a shareable acknowledgement still downloads in the portal (portal_document_ids is unaffected)", async () => {
    await db.asRole(U.CA, async (s) => {
      await s.as("super");
      await s.exec("update filing_records set document_id = $2 where client_id = $1 and shareable_with_client", [C.A, F.docPrivate("A")]);
      await s.as(U.CA);
      expect(await s.value<boolean>("select can_see_document($1)", [F.docPrivate("A")])).toBe(true);
    });
  });
});

describe("mark_portal_message_read (§7.22 read receipts)", () => {
  it("marks the firm's unread portal messages of the caller's client, once, with a read event", async () => {
    await db.asRole(U.CA, async (s) => {
      await s.as("super");
      const inbound = await s.value<string>(
        "insert into messages (client_id, channel, direction, body, status, sent_by) values ($1, 'portal', 'inbound', 'From the client', 'sent', $2) returning id",
        [C.A, U.CA.id],
      );
      await s.as(U.CA);
      expect(await s.value<number>("select mark_portal_message_read()")).toBe(1);
      expect(await s.value<number>("select mark_portal_message_read()")).toBe(0);
      expect(await s.value("select read_at is not null from portal_messages where id = $1", [fid("msg:A:portal")])).toBe(true);
      expect(await s.value("select read_at is null from portal_messages where id = $1", [inbound])).toBe(true);
      await s.as("super");
      expect(await s.value<number>("select count(*)::int from message_events where message_id = $1 and status = 'read'", [fid("msg:A:portal")])).toBe(1);
      // Only the portal channel: the email and the note to client A are untouched.
      expect(await s.value<number>("select count(*)::int from messages where client_id = $1 and channel <> 'portal' and read_at is not null", [C.A])).toBe(0);
    });
  });

  it("never reaches another client's messages, even by id", async () => {
    await db.asRole(U.CA, async (s) => {
      expect(await s.value<number>("select mark_portal_message_read(array[$1]::uuid[])", [fid("msg:B:portal")])).toBe(0);
      await s.as("super");
      expect(await s.value("select read_at from messages where id = $1", [fid("msg:B:portal")])).toBeNull();
    });
  });

  it("is the portal user's: staff and anon are refused", async () => {
    await db.asRole(U.P1, async (s) => {
      expect(userMessage(await s.fails("select mark_portal_message_read()"))).toMatch(/Only the client/);
    });
    await db.asAnon(async (s) => {
      expect(isDenied(await s.attempt("select mark_portal_message_read()"))).toBe(true);
    });
  });
});

describe("\"I've paid\": submit_portal_payment_claim and the claims insert policy (§7.22, §18.3 Client 4)", () => {
  it("records a pending claim on the client's own invoice and never marks it paid", async () => {
    await db.asRole(U.CA, async (s) => {
      const before = await s.one<{ status: string; outstanding_amount: string }>("select status, outstanding_amount from portal_invoices where id = $1", [F.invoiceSent("A")]);
      expect(Number(before.outstanding_amount)).toBeGreaterThan(0);
      const r = await submitClaim(s, F.invoiceSent("A"), "UTR 412345678901");
      expect(r.ok).toBe(true);
      const claim = r.ok ? r.rows[0].r : null;
      expect(claim?.invoice_id).toBe(F.invoiceSent("A"));
      const row = await s.one<{ status: string; reference: string; created_by: string }>("select status, reference, created_by from portal_payment_claims where id = $1", [claim?.claim_id]);
      expect(row).toEqual({ status: "pending", reference: "UTR 412345678901", created_by: U.CA.id });
      const after = await s.one<{ status: string; outstanding_amount: string }>("select status, outstanding_amount from portal_invoices where id = $1", [F.invoiceSent("A")]);
      expect(after).toEqual(before);
    });
  });

  it("refuses the same reference twice while it waits, a future date and an empty reference", async () => {
    await db.asRole(U.CA, async (s) => {
      expect((await submitClaim(s, F.invoiceSent("A"), "UPI-REF-77")).ok).toBe(true);
      const dup = await submitClaim(s, F.invoiceSent("A"), " upi-ref-77 ");
      expect(!dup.ok && userMessage(dup)).toMatch(/already told us/);
      const future = await submitClaim(s, F.invoiceSent("A"), "UPI-REF-78", { paidOn: "2099-01-01" });
      expect(!future.ok && userMessage(future)).toMatch(/future/);
      const empty = await submitClaim(s, F.invoiceSent("A"), "   ");
      expect(!empty.ok && userMessage(empty)).toMatch(/payment reference/);
    });
  });

  it("another client's invoice, a draft or a settled invoice can't take a claim", async () => {
    await db.asRole(U.CA, async (s) => {
      const other = await submitClaim(s, F.invoiceSent("B"), "UTR-1");
      expect(!other.ok && userMessage(other)).toMatch(/isn't one of yours/);
      const draft = await submitClaim(s, F.invoiceDraft("A"), "UTR-2");
      expect(!draft.ok && userMessage(draft)).toMatch(/isn't one of yours/);
      await s.as("super");
      await s.exec("alter table invoices disable trigger user");
      await s.exec("update invoices set outstanding_amount = 0, status = 'paid' where id = $1", [F.invoiceSent("A")]);
      await s.exec("alter table invoices enable trigger user");
      await s.as(U.CA);
      const settled = await submitClaim(s, F.invoiceSent("A"), "UTR-3");
      expect(!settled.ok && userMessage(settled)).toMatch(/already settled/);
    });
  });

  it("staff can't report a payment for the client", async () => {
    await db.asRole(U.P1, async (s) => {
      const r = await submitClaim(s, F.invoiceSent("A"), "UTR-STAFF");
      expect(!r.ok && userMessage(r)).toMatch(/reported by the client/);
    });
  });

  it("the insert policy refuses a staff-side field, a missing date, another client's file or a staff document", async () => {
    await db.asRole(U.CA, async (s) => {
      const base = { invoice: F.invoiceSent("A"), client: C.A, by: U.CA.id };
      const ins = (extra: string, values: string) =>
        s.attempt(
          `insert into portal_payment_claims (invoice_id, client_id, created_by, reference, paid_on${extra}) values ($1, $2, $3, 'UTR-POL', public.today_ist()${values})`,
          [base.invoice, base.client, base.by],
        );
      expect((await ins("", "")).ok).toBe(true);
      expect(isDenied(await ins(", review_note", ", 'Looks fine'"))).toBe(true);
      expect(isDenied(await ins(", status", ", 'verified'"))).toBe(true);
      expect(isDenied(await ins(", screenshot_document_id", `, '${F.docShared("A")}'`))).toBe(true); // uploaded by the firm
      expect(isDenied(await ins(", screenshot_document_id", `, '${F.docShared("B")}'`))).toBe(true); // another client's
      expect(
        isDenied(
          await s.attempt("insert into portal_payment_claims (invoice_id, client_id, created_by, reference) values ($1, $2, $3, 'UTR-NODATE')", [base.invoice, base.client, base.by]),
        ),
      ).toBe(true);
      expect(
        isDenied(
          await s.attempt("insert into portal_payment_claims (invoice_id, client_id, created_by, reference, paid_on) values ($1, $2, $3, 'UTR-B', public.today_ist())", [
            F.invoiceSent("B"),
            C.B,
            U.CA.id,
          ]),
        ),
      ).toBe(true);
      // And no client edits a claim once made.
      const upd = await s.attempt("update portal_payment_claims set status = 'verified' where client_id = $1", [C.A]);
      expect(upd.ok && upd.rowCount).toBe(0);
    });
  });
});

describe("payment proofs stay on the money side (§4.1)", () => {
  it("the screenshot becomes a document of the claim in the same transaction", async () => {
    await db.asRole(U.CA, async (s) => {
      const slot = await slotForCA(s);
      const r = await submitClaim(s, F.invoiceSent("A"), "UTR-SHOT-1", { upload: slot.id });
      expect(r.ok).toBe(true);
      const claim = r.ok ? r.rows[0].r : null;
      expect(claim?.document_id).toBeTruthy();
      expect(await s.value("select screenshot_document_id from portal_payment_claims where id = $1", [claim?.claim_id])).toBe(claim?.document_id);
      expect(await s.value("select source from documents where id = $1", [claim?.document_id])).toBe("client_portal");
    });
  });

  it("a failed claim leaves no document behind", async () => {
    await db.asRole(U.CA, async (s) => {
      const slot = await slotForCA(s);
      const r = await submitClaim(s, F.invoiceSent("A"), "UTR-SHOT-F", { upload: slot.id, paidOn: "2099-01-01" });
      expect(r.ok).toBe(false);
      await s.as("super");
      expect(await s.value<number>("select count(*)::int from documents where storage_path = $1", [slot.path])).toBe(0);
      expect(await s.value("select confirmed_at from document_uploads where id = $1", [slot.id])).toBeNull();
    });
  });

  it("Employees on the client never see the proof, its versions, activities or file; the firm's managers and the client do", async () => {
    await db.asRole(U.CA, async (s) => {
      const slot = await slotForCA(s);
      const r = await submitClaim(s, F.invoiceSent("A"), "UTR-SHOT-2", { upload: slot.id });
      const doc = r.ok ? r.rows[0].r.document_id : null;
      expect(doc).toBeTruthy();
      await s.as("super");
      await s.exec("insert into storage.objects (bucket_id, name) values ('client-documents', $1)", [slot.path]);

      // E1 owns client A and sees its other documents and files…
      await s.as(U.E1);
      expect(await s.value<number>("select count(*)::int from documents where id = $1", [F.docPrivate("A")])).toBe(1);
      // …but not the payment proof.
      expect(await s.value<number>("select count(*)::int from documents where id = $1", [doc])).toBe(0);
      expect(await s.value<number>("select count(*)::int from document_versions where document_id = $1", [doc])).toBe(0);
      expect(await s.value<number>("select count(*)::int from document_activities where document_id = $1", [doc])).toBe(0);
      expect(await s.value<number>("select count(*)::int from storage.objects where name = $1", [slot.path])).toBe(0);
      expect(await s.value<number>("select count(*)::int from documents where client_id = $1", [C.A])).toBeGreaterThan(0);
      const upd = await s.attempt("update documents set title = 'Renamed' where id = $1", [doc]);
      expect(upd.ok && upd.rowCount).toBe(0);

      for (const user of [U.P1, U.M1, U.CA]) {
        await s.as(user);
        expect(await s.value<number>("select count(*)::int from documents where id = $1", [doc]), user.key).toBe(1);
      }
      await s.as(U.P1);
      expect(await s.value<number>("select count(*)::int from storage.objects where name = $1", [slot.path])).toBe(1);
      expect(await s.value<number>("select count(*)::int from document_versions where document_id = $1", [doc])).toBe(1);
    });
  });

  it("the guard functions answer nothing to anon", async () => {
    await db.asAnon(async (s) => {
      expect(isDenied(await s.attempt("select * from payment_proof_document_ids()"))).toBe(true);
      expect(isDenied(await s.attempt("select is_payment_proof_object('x')"))).toBe(true);
      expect(isDenied(await s.attempt("select submit_portal_payment_claim(gen_random_uuid(), 'x', current_date)"))).toBe(true);
    });
  });
});

describe("the portal's other writes go through the existing policies (§6.10, §7.22)", () => {
  it("privacy notices: a portal user reads published ones only, and records consent only for themselves", async () => {
    await db.asRole(U.CA, async (s) => {
      // The seeded v1 is a draft until a Partner publishes it.
      expect(await s.value<number>("select count(*)::int from privacy_notices")).toBe(0);
      await s.as("super");
      await s.exec("update privacy_notices set published_at = now() where version = 'v1'");
      await s.as(U.CA);
      expect(await s.value<number>("select count(*)::int from privacy_notices")).toBe(1);
      const own = await s.attempt(
        "insert into consent_records (subject_type, subject_id, notice_version, purposes, channel, ip) values ('portal_user', $1, 'v1', '{service_delivery}', 'portal', '203.0.113.7')",
        [U.CA.id],
      );
      expect(own.ok).toBe(true);
      const other = await s.attempt("insert into consent_records (subject_type, subject_id, notice_version, channel) values ('portal_user', $1, 'v1', 'portal')", [U.CB.id]);
      expect(isDenied(other)).toBe(true);
      expect(await s.value<number>("select count(*)::int from consent_records where subject_id <> $1", [U.CA.id])).toBe(0);
    });
  });

  it("messages: the client writes inbound portal messages for their own client and attaches only their own uploads", async () => {
    await db.asRole(U.CA, async (s) => {
      const id = await s.value<string>(
        "insert into messages (client_id, channel, direction, body, status, sent_by, sent_at) values ($1, 'portal', 'inbound', 'Here are the bank statements', 'sent', $2, now()) returning id",
        [C.A, U.CA.id],
      );
      expect(await s.value<number>("select count(*)::int from portal_messages where id = $1", [id])).toBe(1);
      // Not as the firm, not another channel, not another client.
      expect(isDenied(await s.attempt("insert into messages (client_id, channel, direction, body, status, sent_by) values ($1, 'portal', 'outbound', 'x', 'sent', $2)", [C.A, U.CA.id]))).toBe(true);
      expect(isDenied(await s.attempt("insert into messages (client_id, channel, direction, body, status, sent_by) values ($1, 'whatsapp_handoff', 'inbound', 'x', 'sent', $2)", [C.A, U.CA.id]))).toBe(true);
      expect(isDenied(await s.attempt("insert into messages (client_id, channel, direction, body, status, sent_by) values ($1, 'portal', 'inbound', 'x', 'sent', $2)", [C.B, U.CA.id]))).toBe(true);
      // A file the firm uploaded can't be passed off as the client's attachment.
      expect(isDenied(await s.attempt("insert into message_attachments (message_id, document_id) values ($1, $2)", [id, F.docShared("A")]))).toBe(true);
      // The client can't fake the firm's read receipt on their own message.
      const upd = await s.attempt("update messages set read_at = now() where id = $1", [id]);
      expect(upd.ok && upd.rowCount).toBe(0);
    });
  });
});
