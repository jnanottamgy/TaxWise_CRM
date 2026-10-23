/**
 * Platform services (0100, 0101): sending notifications through insert_notifications (recipients,
 * cover forwarding, "no money to Employees", de-duplication, who may call it), the email delivery
 * ledger and webhook receipts (Partner reads, service role writes), and the sending-domain guard
 * on firm_settings (§4.1, §4.7, §7.13.5, §9, §13).
 */
import { describe, expect, it } from "vitest";
import { C, SQLSTATE, U, setupTestDatabase, userMessage, type Session } from "./helpers";

const db = setupTestDatabase("platform_services");

type NotifyArgs = {
  type?: string;
  title?: string;
  body?: string;
  link?: string;
  userIds?: string[] | null;
  roles?: string[] | null;
  employeeIds?: string[] | null;
  entityType?: string | null;
  entityId?: string | null;
  clientId?: string | null;
  dedupeKey?: string | null;
  exclude?: string | null;
};

const NOTIFY_SQL = `select notification_id, recipient_id, forwarded from insert_notifications(
  p_type => $1::notification_type, p_title => $2, p_body => $3, p_link_url => $4,
  p_user_ids => $5::uuid[], p_roles => $6::app_role[], p_employee_ids => $7::uuid[],
  p_entity_type => $8, p_entity_id => $9::uuid, p_client_id => $10::uuid,
  p_dedupe_key => $11, p_exclude_user_id => $12::uuid)`;

function params(a: NotifyArgs): unknown[] {
  return [
    a.type ?? "info",
    a.title ?? "Title",
    a.body ?? "Body",
    a.link ?? "/work",
    a.userIds ?? null,
    a.roles ?? null,
    a.employeeIds ?? null,
    a.entityType ?? null,
    a.entityId ?? null,
    a.clientId ?? null,
    a.dedupeKey ?? null,
    a.exclude ?? null,
  ];
}

type Row = { notification_id: string; recipient_id: string; forwarded: boolean };

async function notify(s: Session, a: NotifyArgs): Promise<Row[]> {
  return s.rows<Row>(NOTIFY_SQL, params(a));
}

/** Recipient keys (P1, E3 …) of the rows, sorted. */
function who(rows: Row[]): string[] {
  const byId = new Map(Object.values(U).map((u) => [u.id, u.key]));
  return rows.map((r) => byId.get(r.recipient_id) ?? r.recipient_id).sort();
}

async function asService(s: Session) {
  await s.as("super");
  await s.exec("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)");
  await s.exec("set local role service_role");
}

const emp = (k: keyof typeof U) => U[k].employeeId as string;

describe("insert_notifications: recipients (§9)", () => {
  it("Partners and Managers by role, people by profile or employee id; each once", async () => {
    await db.asRole(U.M1, async (s) => {
      expect(who(await notify(s, { roles: ["partner"] }))).toEqual(["P1", "P2"]);
      expect(who(await notify(s, { roles: ["manager"], userIds: [U.M2.id], employeeIds: [emp("M2")] }))).toEqual(["M1", "M2"]);
      expect(who(await notify(s, { employeeIds: [emp("E1"), emp("E2")], userIds: [U.E1.id] }))).toEqual(["E1", "E2"]);
      // a role that isn't Partner or Manager is ignored (Employees are named one by one)
      expect(who(await notify(s, { roles: ["employee", "client"] }))).toEqual([]);
    });
  });

  it("disabled people and the person who did the thing get nothing", async () => {
    await db.asRole(U.P1, async (s) => {
      expect(who(await notify(s, { userIds: [U.D.id], employeeIds: [emp("D")] }))).toEqual([]);
      expect(who(await notify(s, { roles: ["partner"], exclude: U.P1.id }))).toEqual(["P2"]);
    });
  });

  it("the rows are really written, one per recipient, with the link and entity", async () => {
    await db.asRole(U.M1, async (s) => {
      const rows = await notify(s, { type: "task_assigned", title: "Task assigned", body: "GST return A", link: "/work/abc", employeeIds: [emp("E1")], entityType: "task", clientId: C.A });
      expect(rows).toHaveLength(1);
      await s.as("super");
      const n = await s.one<{ user_id: string; type: string; link_url: string; entity_type: string; read_at: string | null }>(
        "select user_id, type::text, link_url, entity_type, read_at from notifications where id = $1", [rows[0].notification_id]);
      expect(n).toEqual({ user_id: U.E1.id, type: "task_assigned", link_url: "/work/abc", entity_type: "task", read_at: null });
    });
  });

  it("a portal user gets only notices about their own client that link into the portal", async () => {
    await db.asRole(U.P1, async (s) => {
      expect(who(await notify(s, { userIds: [U.CA.id], clientId: C.A, link: "/portal/documents" }))).toEqual(["CA"]);
      expect(who(await notify(s, { userIds: [U.CA.id], clientId: C.A, link: "/clients" }))).toEqual([]);
      expect(who(await notify(s, { userIds: [U.CA.id], clientId: C.B, link: "/portal" }))).toEqual([]);
      expect(who(await notify(s, { userIds: [U.CA.id], link: "/portal" }))).toEqual([]);
    });
  });
});

describe("insert_notifications: money notices never reach Employees (§4.1 beats §9)", () => {
  it("by type, by the entity it is about, and by the page it links to", async () => {
    await db.asRole(U.P1, async (s) => {
      const to = { employeeIds: [emp("E1"), emp("M1")], roles: ["partner"], exclude: U.P1.id };
      expect(who(await notify(s, { ...to, type: "payment_received", link: "/clients" }))).toEqual(["M1", "P2"]);
      expect(who(await notify(s, { ...to, type: "invoice_overdue", link: "/clients" }))).toEqual(["M1", "P2"]);
      expect(who(await notify(s, { ...to, type: "quotation_responded", link: "/clients" }))).toEqual(["M1", "P2"]);
      expect(who(await notify(s, { ...to, type: "expiry_alert", entityType: "engagement_letter", link: "/clients" }))).toEqual(["M1", "P2"]);
      expect(who(await notify(s, { ...to, type: "warning", entityType: "invoice", link: "/clients" }))).toEqual(["M1", "P2"]);
      expect(who(await notify(s, { ...to, type: "info", link: "/invoices/123" }))).toEqual(["M1", "P2"]);
      expect(who(await notify(s, { ...to, type: "info", link: "/leads" }))).toEqual(["M1", "P2"]);
      // the same notice about ordinary work reaches the Employee
      expect(who(await notify(s, { ...to, type: "task_overdue", entityType: "task", link: "/work/1" }))).toEqual(["E1", "M1", "P2"]);
    });
  });

  it("is_money_notification agrees with the rule", async () => {
    await db.asRole(U.E1, async (s) => {
      const q = "select is_money_notification($1::notification_type, $2, $3)";
      expect(await s.value(q, ["info", "invoice", "/clients"])).toBe(true);
      expect(await s.value(q, ["info", "lead_note", "/work"])).toBe(true);
      expect(await s.value(q, ["info", null, "/quotations?x=1"])).toBe(true);
      expect(await s.value(q, ["info", null, "/invoicesX"])).toBe(false);
      expect(await s.value(q, ["document_uploaded", "document", "/clients/1?tab=documents"])).toBe(false);
      expect(await s.value(q, ["payment_received", null, "/portal"])).toBe(true);
    });
  });
});

describe("insert_notifications: cover forwarding (§4.7, §9)", () => {
  it("a notice about a covered client that goes to the absent person also goes to the cover person", async () => {
    await db.asSuper(async (s) => {
      // E3 covers client A for E1 (its owner), in force now.
      await s.exec(
        `insert into client_covers (kind, client_id, absent_employee_id, cover_employee_id, starts_at, ends_at, reason, granted_by)
         values ('client', $1, $2, $3, now() - interval '1 hour', now() + interval '1 day', 'leave', $4)`,
        [C.A, emp("E1"), emp("E3"), U.P1.id],
      );
      await s.as(U.M1);
      const rows = await notify(s, { type: "task_overdue", employeeIds: [emp("E1")], clientId: C.A, entityType: "task", link: "/work/1" });
      expect(who(rows)).toEqual(["E1", "E3"]);
      expect(rows.find((r) => r.recipient_id === U.E3.id)?.forwarded).toBe(true);
      expect(rows.find((r) => r.recipient_id === U.E1.id)?.forwarded).toBe(false);
      // not about the client → not forwarded; about another client → not forwarded
      expect(who(await notify(s, { employeeIds: [emp("E1")] }))).toEqual(["E1"]);
      expect(who(await notify(s, { employeeIds: [emp("E1")], clientId: C.B }))).toEqual(["E1"]);
      // a money notice reaches neither Employee
      expect(who(await notify(s, { type: "payment_received", employeeIds: [emp("E1")], clientId: C.A, roles: ["partner"] }))).toEqual(["P1", "P2"]);
    });
  });

  it("an expired cover forwards nothing", async () => {
    // The fixture cover (E3 for E1 on client A) ended yesterday.
    await db.asRole(U.M1, async (s) => {
      expect(who(await notify(s, { employeeIds: [emp("E1")], clientId: C.A }))).toEqual(["E1"]);
    });
  });

  it("a person cover reaches the clients the absent person owns or is on the team of", async () => {
    await db.asSuper(async (s) => {
      // E3 covers all of E2's clients (E2 is on client B's team).
      await s.exec(
        `insert into client_covers (kind, absent_employee_id, cover_employee_id, starts_at, ends_at, reason, granted_by)
         values ('person', $1, $2, now() - interval '1 hour', now() + interval '2 days', 'absent_today', $3)`,
        [emp("E2"), emp("E3"), U.P1.id],
      );
      await s.as(U.M1);
      expect(who(await notify(s, { employeeIds: [emp("E2")], clientId: C.B }))).toEqual(["E2", "E3"]);
      expect(who(await notify(s, { employeeIds: [emp("E2")], clientId: C.A }))).toEqual(["E2"]);
    });
  });

  it("a client cover without an absent person covers for the client's owner", async () => {
    await db.asSuper(async (s) => {
      await s.exec(
        `insert into client_covers (kind, client_id, cover_employee_id, starts_at, ends_at, reason, granted_by)
         values ('client', $1, $2, now() - interval '1 hour', now() + interval '1 day', 'workload', $3)`,
        [C.B, emp("E3"), U.P1.id],
      );
      await s.as(U.P1);
      expect(who(await notify(s, { employeeIds: [emp("E4")], clientId: C.B }))).toEqual(["E3", "E4"]);
      // E2 is on B's team but isn't the owner, so a notice to E2 isn't forwarded by this cover
      expect(who(await notify(s, { employeeIds: [emp("E2")], clientId: C.B }))).toEqual(["E2"]);
    });
  });
});

describe("insert_notifications: de-duplication (§8 idempotent jobs)", () => {
  it("the same key notifies each person once; another key notifies again", async () => {
    await db.asRole(U.M1, async (s) => {
      expect(who(await notify(s, { roles: ["partner"], dedupeKey: "invoice_overdue:1:2026-10-22" }))).toEqual(["P1", "P2"]);
      expect(who(await notify(s, { roles: ["partner"], dedupeKey: "invoice_overdue:1:2026-10-22" }))).toEqual([]);
      expect(who(await notify(s, { roles: ["partner"], dedupeKey: "invoice_overdue:1:2026-10-23" }))).toEqual(["P1", "P2"]);
      // no key: no de-duplication
      expect(who(await notify(s, { roles: ["partner"] }))).toEqual(["P1", "P2"]);
      expect(who(await notify(s, { roles: ["partner"] }))).toEqual(["P1", "P2"]);
    });
  });

  it("the unique index holds for direct writers too", async () => {
    await db.asSuper(async (s) => {
      const ins = "insert into notifications (user_id, type, title, body, link_url, dedupe_key) values ($1, 'info', 't', 'b', '/inbox', 'same')";
      await s.exec(ins, [U.P1.id]);
      expect((await s.fails(ins, [U.P1.id])).code).toBe(SQLSTATE.uniqueViolation);
      await s.exec(ins, [U.P2.id]);
    });
  });
});

describe("insert_notifications: who may call it", () => {
  it("anon can't call it at all", async () => {
    const e = await db.asAnon((s) => s.fails(NOTIFY_SQL, params({ roles: ["partner"] })));
    expect(e.code).toBe(SQLSTATE.insufficientPrivilege);
  });

  it("a portal user sends only document_uploaded / info / payment_received about their own client", async () => {
    await db.asRole(U.CA, async (s) => {
      expect(who(await notify(s, { type: "document_uploaded", employeeIds: [emp("E1")], roles: ["partner"], clientId: C.A, link: "/clients/a?tab=documents" }))).toEqual(["E1", "P1", "P2"]);
      // "I've paid" from the portal: money, so the Employee owner isn't told
      expect(who(await notify(s, { type: "payment_received", employeeIds: [emp("E1")], roles: ["partner"], clientId: C.A, link: "/invoices/1" }))).toEqual(["P1", "P2"]);
      expect(userMessage(await s.fails(NOTIFY_SQL, params({ type: "task_assigned", employeeIds: [emp("E1")], clientId: C.A })))).toMatch(/permission/);
      expect(userMessage(await s.fails(NOTIFY_SQL, params({ type: "document_uploaded", employeeIds: [emp("E4")], clientId: C.B })))).toMatch(/permission/);
      expect(userMessage(await s.fails(NOTIFY_SQL, params({ type: "info", employeeIds: [emp("E1")] })))).toMatch(/permission/);
    });
  });

  it("an Employee reaches staff about any client their work touches, and a portal user only for clients they can see", async () => {
    await db.asRole(U.E1, async (s) => {
      expect(who(await notify(s, { type: "review_requested", roles: ["manager"], clientId: C.A }))).toEqual(["M1", "M2"]);
      // E1 can't see client B (e.g. a task on it was assigned to them): staff still hear about it…
      expect(who(await notify(s, { type: "review_requested", roles: ["manager"], clientId: C.B }))).toEqual(["M1", "M2"]);
      // …but B's portal user can't be reached through it
      expect(who(await notify(s, { userIds: [U.CB.id], clientId: C.B, link: "/portal" }))).toEqual([]);
      expect(who(await notify(s, { userIds: [U.CA.id], clientId: C.A, link: "/portal" }))).toEqual(["CA"]);
    });
  });

  it("security alerts come only from the system", async () => {
    await db.asRole(U.P1, async (s) => {
      expect(userMessage(await s.fails(NOTIFY_SQL, params({ type: "security_alert", roles: ["partner"] })))).toMatch(/system/);
    });
    await db.asSuper(async (s) => {
      await asService(s);
      expect(who(await notify(s, { type: "security_alert", roles: ["partner"], link: "/audit-log" }))).toEqual(["P1", "P2"]);
    });
  });

  it("someone whose JWT role doesn't match their profile can't call it", async () => {
    // X: JWT says partner, profile says employee → app_role() is null.
    const e = await db.asRole(U.X, (s) => s.fails(NOTIFY_SQL, params({ roles: ["partner"] })));
    expect(userMessage(e)).toMatch(/permission/);
  });

  it("links stay inside the app, and a notice needs a title and a message", async () => {
    await db.asRole(U.M1, async (s) => {
      for (const link of ["https://evil.example.com", "//evil.example.com", "/\\evil.example.com", "work", ""]) {
        expect(userMessage(await s.fails(NOTIFY_SQL, params({ roles: ["partner"], link }))), link).toMatch(/inside the app/);
      }
      expect(userMessage(await s.fails(NOTIFY_SQL, params({ roles: ["partner"], title: "  " })))).toMatch(/title and a message/);
    });
  });

  it("the service role (jobs, webhooks) sends anything to anyone eligible", async () => {
    await db.asSuper(async (s) => {
      await asService(s);
      expect(who(await notify(s, { type: "invoice_overdue", employeeIds: [emp("E1")], roles: ["partner", "manager"], link: "/invoices/1" }))).toEqual(["M1", "M2", "P1", "P2"]);
    });
  });
});

describe("email_deliveries and email_webhook_events (§7.13.5, §13)", () => {
  const insertDelivery = `insert into email_deliveries (idempotency_key, kind, recipient, subject, client_id)
    values ($1, 'invoice', 'contact.a@example.com', 'TaxWise Consultants | Invoice', $2) returning id`;

  it("only Partners read the ledger", async () => {
    await db.asSuper(async (s) => {
      await s.value(insertDelivery, ["k-read", C.A]);
      for (const user of [U.P1, U.P2]) {
        await s.as(user);
        expect(await s.value<number>("select count(*)::int from email_deliveries"), user.key).toBe(1);
      }
      for (const user of [U.M1, U.E1, U.CA, U.X]) {
        await s.as(user);
        expect(await s.value<number>("select count(*)::int from email_deliveries"), user.key).toBe(0);
      }
    });
  });

  it("nobody writes it through the API, Partners included; the service role does", async () => {
    await db.asSuper(async (s) => {
      const id = await s.value<string>(insertDelivery, ["k-write", C.A]);
      await s.as(U.P1);
      expect((await s.fails(insertDelivery, ["k-p1", C.A])).code).toBe(SQLSTATE.insufficientPrivilege);
      expect((await s.fails("update email_deliveries set status = 'delivered' where id = $1", [id])).code).toBe(SQLSTATE.insufficientPrivilege);
      expect((await s.fails("delete from email_deliveries where id = $1", [id])).code).toBe(SQLSTATE.insufficientPrivilege);
      await asService(s);
      expect(await s.exec("update email_deliveries set status = 'sent', attempts = 1, provider_message_id = 're-1' where id = $1", [id])).toBe(1);
      await s.exec("insert into email_webhook_events (webhook_id, event_type, provider_message_id, delivery_id) values ('msg_1', 'email.delivered', 're-1', $1)", [id]);
      expect((await s.fails("insert into email_webhook_events (webhook_id, event_type) values ('msg_1', 'email.delivered')")).code).toBe(SQLSTATE.uniqueViolation);
    });
  });

  it("an idempotency key is used once", async () => {
    await db.asSuper(async (s) => {
      await s.value(insertDelivery, ["k-once", C.A]);
      expect((await s.fails(insertDelivery, ["k-once", C.A])).code).toBe(SQLSTATE.uniqueViolation);
    });
  });

  it("webhook receipts: Partners read, nobody writes through the API", async () => {
    await db.asSuper(async (s) => {
      await s.exec("insert into email_webhook_events (webhook_id, event_type) values ('msg_read', 'email.opened')");
      await s.as(U.P1);
      expect(await s.value<number>("select count(*)::int from email_webhook_events")).toBe(1);
      expect((await s.fails("insert into email_webhook_events (webhook_id, event_type) values ('x', 'email.sent')")).code).toBe(SQLSTATE.insufficientPrivilege);
      await s.as(U.M1);
      expect(await s.value<number>("select count(*)::int from email_webhook_events")).toBe(0);
    });
  });

  it("purging a client removes its deliveries (DPDP), deleting a message keeps the delivery", async () => {
    await db.asSuper(async (s) => {
      const client = await s.value<string>("insert into clients (client_code, display_name) values ('TW-C-9100', 'Purge me') returning id");
      const msg = await s.value<string>(
        "insert into messages (client_id, channel, direction, body, status) values ($1, 'email', 'outbound', 'b', 'sent') returning id", [client]);
      const id = await s.value<string>(
        "insert into email_deliveries (idempotency_key, kind, recipient, subject, client_id, message_id) values ('k-purge', 'test', 'x@example.com', 's', $1, $2) returning id", [client, msg]);
      await s.exec("delete from messages where id = $1", [msg]);
      expect(await s.value("select message_id from email_deliveries where id = $1", [id])).toBeNull();
      await s.exec("delete from clients where id = $1", [client]);
      expect(await s.value<number>("select count(*)::int from email_deliveries where id = $1", [id])).toBe(0);
    });
  });
});

describe("firm_settings: the sending domain mirrors Resend (§5.2, §7.13.5)", () => {
  it("a Partner can't set the domain, its Resend id or its status by writing the row", async () => {
    await db.asRole(U.P1, async (s) => {
      for (const set of ["domain_status = 'verified'", "resend_domain_id = 'd_123'", "domain_verified_at = now()", "sending_domain = 'example.com'"]) {
        expect(userMessage(await s.fails(`update firm_settings set ${set} where id = 1`)), set).toMatch(/Resend/);
      }
      // the sender's name, address and reply-to are ordinary settings
      expect(await s.exec("update firm_settings set email_from_name = 'TaxWise Consultants LLP', email_reply_to = 'accounts@twchartered.com' where id = 1")).toBe(1);
    });
  });

  it("the service role mirrors what Resend said; Verified always has a Resend domain id", async () => {
    await db.asSuper(async (s) => {
      await asService(s);
      expect((await s.fails("update firm_settings set domain_status = 'verified' where id = 1")).code).toBe(SQLSTATE.checkViolation);
      expect(await s.exec("update firm_settings set resend_domain_id = 'd_123', domain_status = 'pending' where id = 1")).toBe(1);
      expect(await s.exec("update firm_settings set domain_status = 'verified', domain_verified_at = now() where id = 1")).toBe(1);
      expect(await s.value("select domain_status from firm_settings where id = 1")).toBe("verified");
    });
  });

  it("a Partner re-creating the settings row can't claim a verified domain", async () => {
    await db.asSuper(async (s) => {
      await s.exec("delete from firm_settings where id = 1");
      await s.as(U.P1);
      expect(userMessage(await s.fails("insert into firm_settings (id, resend_domain_id, domain_status) values (1, 'd_1', 'verified')"))).toMatch(/Resend/);
      expect(await s.exec("insert into firm_settings (id) values (1)")).toBe(1);
    });
  });
});
