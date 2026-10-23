/**
 * Communication (0170–0173): message templates (the variable check, who may write them, Employees
 * never see the money templates), the Inbox's notification actions, "Needs your action"
 * (inbox_action_items: who gets which item, never money for Employees), the notification
 * partition, staff message threads (RLS scope, unread counts, read receipts) and the number-series
 * behaviour the new-FY job relies on (§4.1, §7.13, §7.17, §8).
 */
import { describe, expect, it } from "vitest";
import { TEMPLATE_VARIABLES } from "@/lib/domain/templates";
import { C, F, SQLSTATE, U, fid, isDenied, setupTestDatabase, userMessage, type Session } from "./helpers";

const db = setupTestDatabase("comms");

const keysOf = (rows: Array<{ kind: string; entity_id: string }>) => rows.map((r) => `${r.kind}:${r.entity_id}`).sort();

describe("message templates (0170)", () => {
  it("the database's variable list is the app's (§7.13.4)", async () => {
    const list = await db.asSuper((s) => s.value<string[]>("select public.message_template_variables()"));
    expect(list).toEqual([...TEMPLATE_VARIABLES]);
  });

  it("finds unknown variables and malformed placeholders, once each, in order", async () => {
    const problems = await db.asSuper((s) =>
      s.value<string[]>("select public.message_template_problems($1)", ["Hi {{client_name}} {{client_email}} {{ bad name }} {{client_email}} {{Client_Name}} {{"]),
    );
    expect(problems).toEqual(["{{client_email}}", "{{ bad name }}", "{{Client_Name}}", "{{"]);
    expect(await db.asSuper((s) => s.value<string[]>("select public.message_template_problems($1)", ["Dear {{ contact_name }}, {{portal_link}}"]))).toEqual([]);
  });

  it("every seeded default passes the check (§16)", async () => {
    const bad = await db.asSuper((s) =>
      s.rows<{ name: string }>("select name from message_templates where cardinality(message_template_problems(body) || message_template_problems(coalesce(subject, ''))) > 0"),
    );
    expect(bad).toEqual([]);
    const types = await db.asSuper((s) => s.rows<{ type: string }>("select distinct type::text as type from message_templates order by 1"));
    expect(types.map((t) => t.type)).toEqual(["compliance_reminder", "custom", "document_reminder", "overdue_notification", "payment_reminder", "quotation", "task_assignment", "welcome"]);
  });

  it("a Manager adds a template; unknown variables are refused in plain words", async () => {
    await db.asRole(U.M1, async (s) => {
      const refused = await s.fails("insert into message_templates (name, type, channel, body) values ('Bad one', 'custom', 'any', 'Hi {{client_email}}')");
      expect(refused.code).toBe(SQLSTATE.raiseException);
      expect(userMessage(refused)).toContain("{{client_email}}");
      const empty = await s.fails("insert into message_templates (name, type, channel, body) values ('Empty', 'custom', 'any', '   ')");
      expect(userMessage(empty)).toBe("Write the message.");

      const row = await s.one<{ created_by: string; updated_by: string; subject: string | null; name: string }>(
        "insert into message_templates (name, type, channel, subject, body, created_by) values ('  GST data (WhatsApp)  ', 'document_reminder', 'whatsapp', 'Ignored subject', 'Hi {{contact_name}}, we need {{missing_items}}', $1) returning created_by, updated_by, subject, name::text",
        [U.P1.id],
      );
      expect(row).toEqual({ created_by: U.M1.id, updated_by: U.M1.id, subject: null, name: "GST data (WhatsApp)" });
    });
  });

  it("Employees use templates but can't write them, and never see payment reminders or quotations (§4.1)", async () => {
    await db.asRole(U.E1, async (s) => {
      const types = await s.rows<{ type: string }>("select distinct type::text as type from message_templates");
      expect(types.map((t) => t.type)).not.toContain("payment_reminder");
      expect(types.map((t) => t.type)).not.toContain("quotation");
      expect(types.length).toBeGreaterThan(0);
      expect(isDenied(await s.attempt("insert into message_templates (name, type, channel, body) values ('Mine', 'custom', 'any', 'Hello')"))).toBe(true);
      expect(await s.exec("update message_templates set body = 'changed' where type = 'custom'")).toBe(0);
    });
    await db.asRole(U.M1, async (s) => {
      expect(await s.value<number>("select count(*)::int from message_templates where type in ('payment_reminder', 'quotation')")).toBeGreaterThan(0);
    });
    await db.asRole(U.CA, async (s) => {
      expect(await s.value<number>("select count(*)::int from message_templates")).toBe(0);
    });
  });
});

describe("notification actions (0171)", () => {
  async function seed(s: Session) {
    await s.as("super");
    const mine = await s.rows<{ id: string }>(
      "insert into notifications (user_id, type, title, body, link_url, entity_type, entity_id) values ($1, 'info', 'One', 'b', '/work', 'task', $2), ($1, 'info', 'Two', 'b', '/work', null, null) returning id",
      [U.E1.id, F.task("A")],
    );
    const theirs = await s.one<{ id: string }>("insert into notifications (user_id, type, title, body, link_url) values ($1, 'info', 'Not yours', 'b', '/work') returning id", [U.P1.id]);
    await s.as(U.E1);
    return { mine: mine.map((m) => m.id), theirs: theirs.id };
  }

  it("marks your own notifications read, unread, archived and back; someone else's are untouched", async () => {
    await db.asRole(U.E1, async (s) => {
      const { mine, theirs } = await seed(s);
      expect(await s.value<number>("select mark_notifications($1::uuid[], 'read')", [[...mine, theirs]])).toBe(2);
      expect(await s.value<number>("select mark_notifications($1::uuid[], 'read')", [mine])).toBe(0);
      expect(await s.value<number>("select mark_notifications($1::uuid[], 'unread')", [[mine[0]]])).toBe(1);
      expect(await s.value<number>("select mark_notifications($1::uuid[], 'archived')", [mine])).toBe(2);
      expect(await s.value<number>("select mark_notifications($1::uuid[], 'unarchived')", [[mine[1]]])).toBe(1);
      await s.as("super");
      const other = await s.one<{ read_at: string | null }>("select read_at from notifications where id = $1", [theirs]);
      expect(other.read_at).toBeNull();
      const rows = await s.rows<{ id: string; read: boolean; archived: boolean }>("select id, read_at is not null as read, archived_at is not null as archived from notifications where id = any($1::uuid[]) order by title", [mine]);
      expect(rows.map((r) => [r.read, r.archived])).toEqual([
        [false, true],
        [true, false],
      ]);
    });
  });

  it("refuses an unknown action and more than 500 at once", async () => {
    await db.asRole(U.E1, async (s) => {
      expect(userMessage(await s.fails("select mark_notifications(array[gen_random_uuid()], 'starred')"))).toContain("Choose read, unread");
      expect(userMessage(await s.fails("select mark_notifications(array(select gen_random_uuid() from generate_series(1, 501)), 'read')"))).toContain("at most 500");
      expect(await s.value<number>("select mark_notifications('{}'::uuid[], 'read')")).toBe(0);
    });
  });

  it("Mark all read and 'opened from the inbox' touch only your unread, unarchived ones", async () => {
    await db.asRole(U.E1, async (s) => {
      const { mine } = await seed(s);
      expect(await s.value<number>("select mark_entity_notifications_read('task', $1)", [F.task("A")])).toBe(1);
      const before = await s.value<number>("select count(*)::int from notifications where user_id = $1 and read_at is null and archived_at is null", [U.E1.id]);
      expect(before).toBeGreaterThan(0);
      expect(await s.value<number>("select mark_all_notifications_read()")).toBe(before);
      expect(await s.value<number>("select mark_all_notifications_read()")).toBe(0);
      expect(mine.length).toBe(2);
    });
  });

  it("you can delete your own notifications, and only yours", async () => {
    await db.asRole(U.E1, async (s) => {
      const { mine, theirs } = await seed(s);
      expect(await s.exec("delete from notifications where id = any($1::uuid[])", [[mine[0], theirs]])).toBe(1);
      await s.as("super");
      expect(await s.value<number>("select count(*)::int from notifications where id = $1", [theirs])).toBe(1);
    });
  });

  it("anon can't call them", async () => {
    await db.asAnon(async (s) => {
      expect(isDenied(await s.attempt("select mark_all_notifications_read()"))).toBe(true);
      expect(isDenied(await s.attempt("select mark_notifications(array[gen_random_uuid()], 'read')"))).toBe(true);
    });
  });
});

describe("Needs your action (inbox_action_items, 0172)", () => {
  const T = {
    review: fid("comms:task:review"),
    accept: fid("comms:task:accept"),
    declined: fid("comms:task:declined"),
    msgA: fid("comms:msg:a:in"),
    msgC: fid("comms:msg:c:in"),
  };

  async function scene(s: Session) {
    await s.as("super");
    await s.exec("update invoices set status = 'awaiting_approval', requires_approval = true where id = $1", [F.invoiceDraft("A")]);
    await s.exec("update quotations set status = 'pending_approval' where id = $1", [fid("quotation:B")]);
    await s.exec(
      `insert into tasks (id, task_number, client_id, title, status, assigned_employee_id, reviewer_employee_id, acceptance_status, accepted_at, created_by, due_date)
       values ($1, 'T-970001', $2, 'Review me', 'under_review', $3, $4, 'accepted', now(), $5, '2026-11-20')`,
      [T.review, C.A, U.E1.employeeId, U.M1.employeeId, U.P1.id],
    );
    await s.exec(
      `insert into tasks (id, task_number, client_id, title, status, assigned_employee_id, acceptance_status, created_by, due_date, assigned_by)
       values ($1, 'T-970002', $2, 'Accept me', 'not_started', $3, 'pending', $4, '2026-11-25', $4)`,
      [T.accept, C.B, U.E2.employeeId, U.M1.id],
    );
    // Assigned by P2, then declined by E4 (respond_to_task unassigns it and keeps who assigned it).
    await s.exec(
      `insert into tasks (id, task_number, client_id, title, status, assigned_employee_id, acceptance_status, created_by, due_date, assigned_by)
       values ($1, 'T-970003', $2, 'Reassign me', 'not_started', $3, 'pending', $4, '2026-11-28', $4)`,
      [T.declined, C.C, U.E4.employeeId, U.P2.id],
    );
    await s.exec(
      "update tasks set acceptance_status = 'declined', declined_at = now(), decline_reason = 'no_capacity', declined_by_employee_id = assigned_employee_id, assigned_employee_id = null where id = $1",
      [T.declined],
    );
    await s.exec(
      `insert into messages (id, client_id, channel, direction, body, status, sent_by)
       values ($1, $2, 'portal', 'inbound', 'Uploaded the bank statement', 'sent', $3), ($4, $5, 'portal', 'inbound', 'Please call me', 'sent', $6)`,
      [T.msgA, C.A, U.CA.id, T.msgC, C.C, U.P1.id],
    );
  }

  async function itemsFor(s: Session, who: (typeof U)[keyof typeof U]) {
    await s.as(who);
    return s.rows<{ kind: string; entity_id: string; amount: string | null }>("select kind, entity_id, amount from inbox_action_items");
  }

  it("Partners get approvals, data requests and the declined tasks they assigned", async () => {
    await db.asRole(U.P1, async (s) => {
      await scene(s);
      const p1 = await itemsFor(s, U.P1);
      const kinds = new Set(p1.map((r) => r.kind));
      expect(p1.find((r) => r.kind === "invoice_approval")?.entity_id).toBe(F.invoiceDraft("A"));
      expect(Number(p1.find((r) => r.kind === "invoice_approval")?.amount)).toBe(1180);
      expect(p1.find((r) => r.kind === "quotation_approval")?.entity_id).toBe(fid("quotation:B"));
      expect(kinds.has("data_request")).toBe(true);
      expect(kinds.has("leave_approval")).toBe(true);
      expect(kinds.has("declined")).toBe(false); // P2 assigned it
      expect(kinds.has("review")).toBe(false); // M1 is the named reviewer
      expect(kinds.has("client_message")).toBe(false); // A and C have active owners
      const p2 = await itemsFor(s, U.P2);
      expect(keysOf(p2.filter((r) => r.kind === "declined"))).toEqual([`declined:${T.declined}`]);
    });
  });

  it("Managers get reviews named to them, every declined task, Employees' leave and their own clients' messages; never invoice approvals", async () => {
    await db.asRole(U.M1, async (s) => {
      await scene(s);
      const m1 = await itemsFor(s, U.M1);
      expect(keysOf(m1.filter((r) => r.kind === "review"))).toEqual([`review:${T.review}`]);
      expect(keysOf(m1.filter((r) => r.kind === "declined"))).toEqual([`declined:${T.declined}`]);
      expect(keysOf(m1.filter((r) => r.kind === "client_message"))).toEqual([`client_message:${C.C}`]); // M1 owns C
      expect(m1.filter((r) => r.kind === "leave_approval").length).toBe(2);
      expect(m1.some((r) => r.kind === "invoice_approval" || r.kind === "quotation_approval" || r.kind === "data_request")).toBe(false);
      const m2 = await itemsFor(s, U.M2);
      expect(m2.some((r) => r.kind === "review")).toBe(false);
      expect(m2.some((r) => r.kind === "client_message")).toBe(false);
    });
  });

  it("Employees get tasks to accept and their own clients' messages, and nothing about money", async () => {
    await db.asRole(U.E1, async (s) => {
      await scene(s);
      const e1 = await itemsFor(s, U.E1);
      expect(keysOf(e1)).toEqual([`client_message:${C.A}`]);
      expect(e1.every((r) => r.amount === null)).toBe(true);
      const e2 = await itemsFor(s, U.E2);
      expect(keysOf(e2)).toEqual([`acceptance:${T.accept}`]);
      const e4 = await itemsFor(s, U.E4);
      expect(e4).toEqual([]);
    });
  });

  it("an item leaves the list as soon as it is dealt with", async () => {
    await db.asRole(U.E1, async (s) => {
      await scene(s);
      await s.as(U.E1);
      expect(await s.value<number>("select count(*)::int from inbox_action_items where kind = 'client_message'")).toBe(1);
      await s.as("super");
      await s.exec("update messages set read_at = now() where id = $1", [T.msgA]);
      await s.as(U.E1);
      expect(await s.value<number>("select count(*)::int from inbox_action_items where kind = 'client_message'")).toBe(0);
    });
  });

  it("inbox_notifications flags notices about open action items, so Updates doesn't list them twice", async () => {
    await db.asRole(U.P1, async (s) => {
      await scene(s);
      await s.as("super");
      await s.exec(
        "insert into notifications (user_id, type, title, body, link_url, entity_type, entity_id) values ($1, 'invoice_awaiting_approval', 'Approve', 'b', '/invoices', 'invoice', $2), ($1, 'info', 'Plain', 'b', '/work', 'task', $3)",
        [U.P1.id, F.invoiceDraft("A"), F.task("A")],
      );
      await s.as(U.P1);
      const rows = await s.rows<{ title: string; needs_action: boolean }>("select title, needs_action from inbox_notifications where title in ('Approve', 'Plain') order by title");
      expect(rows).toEqual([
        { title: "Approve", needs_action: true },
        { title: "Plain", needs_action: false },
      ]);
      await s.as(U.E1);
      expect(await s.value<number>("select count(*)::int from inbox_notifications where user_id <> $1", [U.E1.id])).toBe(0);
    });
  });

  it("the views are read-only for the API roles", async () => {
    await db.asSuper(async (s) => {
      for (const view of ["inbox_action_items", "inbox_notifications", "message_threads"]) {
        for (const priv of ["insert", "update", "delete"]) {
          expect(await s.value<boolean>(`select has_table_privilege('authenticated', 'public.${view}', '${priv}')`)).toBe(false);
        }
        expect(await s.value<boolean>(`select has_table_privilege('anon', 'public.${view}', 'select')`)).toBe(false);
        expect(await s.value<boolean>(`select has_table_privilege('authenticated', 'public.${view}', 'select')`)).toBe(true);
      }
    });
  });
});

describe("message threads (0173)", () => {
  const IN = fid("comms:thread:a:in");
  const MONEY = fid("comms:thread:a:money");

  async function scene(s: Session) {
    await s.as("super");
    await s.exec("insert into messages (id, client_id, channel, direction, body, status, sent_by, created_at) values ($1, $2, 'portal', 'inbound', 'Sent the purchase register', 'sent', $3, now() + interval '1 minute')", [IN, C.A, U.CA.id]);
    await s.exec(
      "insert into messages (id, client_id, channel, direction, body, status, sent_by, related_entity_type, related_entity_id, created_at) values ($1, $2, 'email', 'outbound', 'Your invoice for Rs 5,900', 'sent', $3, 'invoice', $4, now() + interval '2 minutes')",
      [MONEY, C.A, U.P1.id, F.invoiceSent("A")],
    );
  }

  it("each person lists only the clients they can see; Employees never see a money message as the latest", async () => {
    await db.asRole(U.E1, async (s) => {
      await scene(s);
      await s.as(U.E1);
      const e1 = await s.rows<{ client_id: string; last_message_id: string; unread_count: number; has_unread: boolean }>("select client_id, last_message_id, unread_count, has_unread from message_threads");
      expect(e1.map((r) => r.client_id)).toEqual([C.A]);
      expect(e1[0].last_message_id).toBe(IN);
      expect(e1[0].unread_count).toBe(1);
      expect(e1[0].has_unread).toBe(true);
      await s.as(U.P1);
      const p1 = await s.rows<{ client_id: string; last_message_id: string }>("select client_id, last_message_id from message_threads order by client_name");
      expect(p1.map((r) => r.client_id).sort()).toEqual([C.A, C.B, C.C].sort());
      expect(p1.find((r) => r.client_id === C.A)?.last_message_id).toBe(MONEY);
      await s.as(U.E2);
      expect((await s.rows<{ client_id: string }>("select client_id from message_threads")).map((r) => r.client_id)).toEqual([C.B]);
      await s.as(U.CA);
      expect(await s.value<number>("select count(*)::int from message_threads")).toBe(0);
    });
  });

  it("opening a thread marks the client's portal messages read and stamps the reader", async () => {
    await db.asRole(U.E1, async (s) => {
      await scene(s);
      await s.as(U.E1);
      const first = await s.value<{ marked: number }>("select mark_thread_read($1)", [C.A]);
      expect(first.marked).toBe(1);
      expect((await s.value<{ marked: number }>("select mark_thread_read($1)", [C.A])).marked).toBe(0);
      expect(await s.value<boolean>("select read_at is not null from messages where id = $1", [IN])).toBe(true);
      const thread = await s.one<{ unread_count: number; my_last_read_at: string | null; new_for_me: boolean }>("select unread_count, my_last_read_at, new_for_me from message_threads where client_id = $1", [C.A]);
      expect(thread.unread_count).toBe(0);
      expect(thread.my_last_read_at).not.toBeNull();
      await s.as(U.M1);
      expect(await s.value<number>("select count(*)::int from message_thread_reads where client_id = $1 and user_id = $2", [C.A, U.E1.id])).toBe(1);
      await s.as(U.E2);
      expect(await s.value<number>("select count(*)::int from message_thread_reads where client_id = $1", [C.A])).toBe(0);
    });
  });

  it("nobody opens a thread for a client they can't see, nor writes someone else's read row", async () => {
    await db.asRole(U.E2, async (s) => {
      expect(userMessage(await s.fails("select mark_thread_read($1)", [C.A]))).toBe("Not one of your clients.");
      expect(isDenied(await s.attempt("insert into message_thread_reads (client_id, user_id) values ($1, $2)", [C.B, U.E4.id]))).toBe(true);
      expect(isDenied(await s.attempt("insert into message_thread_reads (client_id, user_id) values ($1, $2)", [C.A, U.E2.id]))).toBe(true);
      await s.as(U.CA);
      expect(userMessage(await s.fails("select mark_thread_read($1)", [C.A]))).toBe("Only the firm's staff open client threads.");
    });
  });

  it("a staff portal reply is allowed for a visible client, and an Employee can't send from a payment template", async () => {
    await db.asRole(U.E1, async (s) => {
      const ok = await s.attempt("insert into messages (client_id, channel, direction, body, status, sent_by) values ($1, 'portal', 'outbound', 'We have received it, thank you.', 'sent', $2)", [C.A, U.E1.id]);
      expect(ok.ok).toBe(true);
      await s.as("super");
      const tpl = await s.value<string>("select id from message_templates where type = 'payment_reminder' limit 1");
      await s.as(U.E1);
      const money = await s.attempt("insert into messages (client_id, channel, direction, body, status, sent_by, template_id) values ($1, 'portal', 'outbound', 'Pay up', 'sent', $2, $3)", [C.A, U.E1.id, tpl]);
      expect(isDenied(money)).toBe(true);
      const other = await s.attempt("insert into messages (client_id, channel, direction, body, status, sent_by) values ($1, 'portal', 'outbound', 'Hello', 'sent', $2)", [C.B, U.E1.id]);
      expect(isDenied(other)).toBe(true);
    });
  });
});

describe("number series across a new FY (what the new-FY job relies on, §8)", () => {
  it("an FY-scoped series restarts at 0001 with the first document dated in the new year, and won't go back", async () => {
    await db.asSuper(async (s) => {
      expect(await s.value<string>("select next_document_number('receipt', '2026-10-10')")).toMatch(/\/26-27\/\d{4}$/);
      expect(await s.value<string>("select next_document_number('receipt', '2027-04-02')")).toMatch(/\/27-28\/0001$/);
      expect(await s.value<string>("select next_document_number('receipt', '2027-04-03')")).toMatch(/\/27-28\/0002$/);
      const back = await s.fails("select next_document_number('receipt', '2027-03-31')");
      expect(userMessage(back)).toContain("moved on to FY 2027-28");
    });
  });
});
