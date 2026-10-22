/**
 * Platform tables (§4.6, §5.11, §7.11, §7.17, §7.20, §7.21): the insert-only audit log, own-only
 * notifications, people tables, firm settings, the money-side filter on the timeline and message
 * history (§4.1), storage buckets (§12).
 */
import { describe, expect, it } from "vitest";
import { C, F, SQLSTATE, U, setupTestDatabase, userMessage } from "./helpers";

const db = setupTestDatabase("platform");

describe("audit_logs (§4.6, §7.20): insert-only, through log_audit_event, Partner reads", () => {
  it("every signed-in user can log an event; who is taken from the session, not the arguments", async () => {
    await db.asSuper(async (s) => {
      for (const user of [U.P1, U.M1, U.E1, U.CA]) {
        await s.as(user);
        await s.value("select log_audit_event('data_update', 'client', $1, 'update', '{\"x\":1}'::jsonb)", [C.A]);
      }
      await s.as("super");
      const rows = await s.rows<{ user_id: string; user_email: string; user_role: string }>(
        "select user_id, user_email, user_role from audit_logs where event = 'data_update' order by user_email");
      expect(rows).toEqual([
        { user_id: U.CA.id, user_email: U.CA.email, user_role: "client" },
        { user_id: U.E1.id, user_email: U.E1.email, user_role: "employee" },
        { user_id: U.M1.id, user_email: U.M1.email, user_role: "manager" },
        { user_id: U.P1.id, user_email: U.P1.email, user_role: "partner" },
      ]);
    });
  });

  it("nobody inserts directly, and nobody — Partner included — updates or deletes", async () => {
    for (const user of [U.P1, U.M1, U.E1, U.CA]) {
      await db.asRole(user, async (s) => {
        expect((await s.fails("insert into audit_logs (event, user_id) values ('login_success', $1)", [U.P1.id])).code, user.key).toBe(SQLSTATE.insufficientPrivilege);
        expect((await s.fails("update audit_logs set action = 'x'")).code, user.key).toBe(SQLSTATE.insufficientPrivilege);
        expect((await s.fails("delete from audit_logs")).code, user.key).toBe(SQLSTATE.insufficientPrivilege);
        expect((await s.fails("truncate audit_logs")).code, user.key).toBe(SQLSTATE.insufficientPrivilege);
      });
    }
  });

  it("even the service role and the database owner can't change or delete an entry", async () => {
    await db.asSuper(async (s) => {
      expect(userMessage(await s.fails("update audit_logs set action = 'x' where id = $1", [F.auditLog]))).toBe("Audit log entries can't be changed or deleted.");
      expect(userMessage(await s.fails("delete from audit_logs where id = $1", [F.auditLog]))).toBe("Audit log entries can't be changed or deleted.");
      await s.exec("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)");
      await s.exec("set local role service_role");
      expect(userMessage(await s.fails("delete from audit_logs where id = $1", [F.auditLog]))).toMatch(/can't be changed or deleted/);
    });
  });

  it("only Partners read the audit log", async () => {
    expect(await db.asRole(U.P1, (s) => s.value<number>("select count(*)::int from audit_logs"))).toBeGreaterThan(0);
    for (const user of [U.M1, U.E1, U.CA, U.X]) {
      expect(await db.asRole(user, (s) => s.value<number>("select count(*)::int from audit_logs")), user.key).toBe(0);
    }
  });
});

describe("notifications (§4.6 'each user sees their own only', §9)", () => {
  it("each user sees, reads and deletes only their own", async () => {
    for (const user of [U.P1, U.E1, U.CA]) {
      await db.asRole(user, async (s) => {
        expect(await s.rows("select user_id from notifications")).toEqual([{ user_id: user.id }]);
        expect(await s.exec("update notifications set read_at = now()")).toBe(1);
        expect(await s.exec("delete from notifications where user_id <> $1", [user.id])).toBe(0);
      });
    }
  });

  it("a notification's content can't be rewritten by its reader", async () => {
    await db.asRole(U.E1, async (s) => {
      expect(userMessage(await s.fails("update notifications set title = 'x'"))).toMatch(/title/);
    });
  });

  it("staff notify colleagues and their own clients' portal users; links stay in-app", async () => {
    const ins = "insert into notifications (user_id, type, title, body, link_url) values ($1, $2::notification_type, 't', 'b', $3)";
    await db.asRole(U.E1, async (s) => {
      expect(await s.exec(ins, [U.E2.id, "info", "/work"])).toBe(1);
      expect(await s.exec(ins, [U.CA.id, "info", "/portal"])).toBe(1); // A is E1's client
      expect((await s.attempt(ins, [U.CB.id, "info", "/portal"])).ok).toBe(false); // B isn't
      expect((await s.attempt(ins, [U.E2.id, "info", "https://evil.example.com"])).ok).toBe(false);
      expect((await s.attempt(ins, [U.E2.id, "info", "//evil.example.com"])).ok).toBe(false);
      expect((await s.attempt(ins, [U.D.id, "info", "/work"])).ok).toBe(false); // disabled colleague
    });
    await db.asRole(U.CA, async (s) => {
      expect(await s.exec(ins, [U.E1.id, "document_uploaded", "/clients"])).toBe(1);
      expect((await s.attempt(ins, [U.E1.id, "task_assigned", "/work"])).ok).toBe(false);
      expect((await s.attempt(ins, [U.CB.id, "info", "/portal"])).ok).toBe(false);
    });
  });
});

describe("money-side history stays away from Employees (§4.1, §18.3)", () => {
  it("Employees see the client timeline without lead, quotation, invoice or payment events", async () => {
    const types = await db.asRole(U.E1, (s) => s.rows<{ event_type: string }>("select event_type from client_timeline_events order by 1"));
    expect(types.map((t) => t.event_type)).toEqual(["task_created"]);
    expect(await db.asRole(U.M1, (s) => s.value<number>("select count(*)::int from client_timeline_events where client_id = $1", [C.A]))).toBe(4);
  });

  it("Employees don't read messages about invoices or quotations, nor their events and attachments", async () => {
    await db.asSuper(async (s) => {
      const tpl = await s.value<string>("select id from message_templates where type = 'payment_reminder' limit 1");
      await s.exec(
        "insert into messages (client_id, channel, direction, body, status, sent_by, template_id) values ($1, 'whatsapp_handoff', 'outbound', 'Reminder: Rs 5,900 due', 'handed_off', $2, $3)",
        [C.A, U.P1.id, tpl],
      );
      await s.exec("insert into message_events (message_id, status) values ($1, 'delivered')", [`${await s.value("select id from messages where related_entity_type = 'invoice' and client_id = $1", [C.A])}`]);
      await s.as(U.E1);
      const bodies = (await s.rows<{ body: string }>("select body from messages order by body")).map((m) => m.body);
      expect(bodies).toEqual(["Email hello A", "Internal note A", "Portal hello A"]);
      expect(await s.value<number>("select count(*)::int from message_events")).toBe(1);
      await s.as(U.M1);
      expect(await s.value<number>("select count(*)::int from messages where client_id = $1", [C.A])).toBe(5);
    });
  });

  it("Employees can't write money-side history either", async () => {
    await db.asRole(U.E1, async (s) => {
      expect((await s.attempt("insert into client_timeline_events (client_id, event_type, title, performed_by) values ($1, 'invoice_sent', 'x', $2)", [C.A, U.E1.id])).ok).toBe(false);
      expect(await s.exec("insert into client_timeline_events (client_id, event_type, title, performed_by) values ($1, 'note_added', 'Called', $2)", [C.A, U.E1.id])).toBe(1);
      expect((await s.attempt("insert into messages (client_id, channel, direction, body, status, sent_by, related_entity_type) values ($1, 'email', 'outbound', 'x', 'sent', $2, 'quotation')", [C.A, U.E1.id])).ok).toBe(false);
      expect(await s.exec("update messages set status = 'failed' where related_entity_type = 'invoice'")).toBe(0);
    });
  });

  it("the portal still reads its own client's portal messages and never the timeline", async () => {
    await db.asRole(U.CA, async (s) => {
      expect(await s.value<number>("select count(*)::int from messages")).toBe(1);
      expect(await s.value<number>("select count(*)::int from client_timeline_events")).toBe(0);
    });
  });
});

describe("people (§4.6, §7.11, §7.12)", () => {
  it("Employees see their own leave, sessions, attendance, activity and time; Managers see all", async () => {
    for (const t of ["employee_leave", "employee_sessions", "attendance_records", "employee_activities", "time_entries", "independence_declarations"]) {
      expect(await db.asRole(U.E1, (s) => s.value<number>(`select count(*)::int from ${t} where employee_id <> $1`, [U.E1.employeeId])), t).toBe(0);
      expect(await db.asRole(U.E1, (s) => s.value<number>(`select count(*)::int from ${t}`)), t).toBeGreaterThan(0);
      expect(await db.asRole(U.M1, (s) => s.value<number>(`select count(*)::int from ${t} where employee_id <> $1`, [U.E1.employeeId])), t).toBeGreaterThan(0);
      expect(await db.asRole(U.CA, (s) => s.value<number>(`select count(*)::int from ${t}`)), t).toBe(0);
    }
  });

  it("an Employee requests and cancels their own leave but can't approve it", async () => {
    await db.asRole(U.E1, async (s) => {
      const id = await s.value<string>("insert into employee_leave (employee_id, start_date, end_date) values ($1, '2026-12-01', '2026-12-02') returning id", [U.E1.employeeId]);
      expect(userMessage(await s.fails("update employee_leave set status = 'approved' where id = $1", [id]))).toMatch(/not approve or decline/);
      expect(userMessage(await s.fails("update employee_leave set decided_by = $2 where id = $1", [id, U.E1.id]))).toMatch(/decided by/);
      expect(await s.exec("update employee_leave set status = 'cancelled' where id = $1", [id])).toBe(1);
      expect((await s.attempt("insert into employee_leave (employee_id, start_date, end_date, status) values ($1, '2026-12-01', '2026-12-02', 'approved')", [U.E1.employeeId])).ok).toBe(false);
      expect((await s.attempt("insert into employee_leave (employee_id, start_date, end_date) values ($1, '2026-12-01', '2026-12-02')", [U.E2.employeeId])).ok).toBe(false);
    });
  });

  it("Managers decide Employees' leave; a Partner decides Managers'", async () => {
    await db.asSuper(async (s) => {
      const mLeave = await s.value<string>("insert into employee_leave (employee_id, start_date, end_date) values ($1, '2026-12-01', '2026-12-01') returning id", [U.M2.employeeId]);
      await s.as(U.M1);
      expect(await s.exec("update employee_leave set status = 'approved', decided_by = $2, decided_at = now() where employee_id = $1 and status = 'requested'", [U.E1.employeeId, U.M1.id])).toBe(1);
      expect(userMessage(await s.fails("update employee_leave set status = 'approved', decided_by = $2 where id = $1", [mLeave, U.M1.id]))).toMatch(/a Partner decides leave for Managers/);
      await s.as(U.P1);
      expect(await s.exec("update employee_leave set status = 'approved', decided_by = $2 where id = $1", [mLeave, U.P1.id])).toBe(1);
    });
  });

  it("presence sessions are written only by the server", async () => {
    for (const user of [U.P1, U.E1]) {
      await db.asRole(user, async (s) => {
        expect((await s.fails("insert into employee_sessions (employee_id, user_id) values ($1, $2)", [user.employeeId, user.id])).code).toBe(SQLSTATE.insufficientPrivilege);
      });
    }
  });
});

describe("firm settings (§4.6, §7.21)", () => {
  it("all staff read; only a Partner updates; clients read only the public profile", async () => {
    for (const user of [U.P1, U.M1, U.E1]) {
      expect(await db.asRole(user, (s) => s.value<number>("select count(*)::int from firm_settings")), user.key).toBe(1);
    }
    expect(await db.asRole(U.P1, (s) => s.exec("update firm_settings set tagline = 'x'"))).toBe(1);
    expect(await db.asRole(U.M1, (s) => s.exec("update firm_settings set tagline = 'x'"))).toBe(0);
    await db.asRole(U.CA, async (s) => {
      expect(await s.value<number>("select count(*)::int from firm_settings")).toBe(0);
      expect(await s.value("select firm_name from public_firm_profile()")).toBe("TaxWise Consultants");
    });
  });

  it("anon reads only the public firm profile (name, contact, bank/UPI), nothing else", async () => {
    await db.asAnon(async (s) => {
      const row = await s.one<Record<string, unknown>>("select * from public_firm_profile()");
      expect(row.firm_name).toBe("TaxWise Consultants");
      for (const col of ["invoice_approval_limit", "resend_domain_id", "whatsapp_house_rules", "pan", "tan"]) expect(Object.keys(row)).not.toContain(col);
      expect((await s.fails("select app_role()")).code).toBe(SQLSTATE.insufficientPrivilege);
      expect((await s.fails("select log_audit_event('login_failure')")).code).toBe(SQLSTATE.insufficientPrivilege);
    });
  });
});

describe("storage buckets (§12)", () => {
  it("generated PDFs (may hold invoices) are Partner/Manager only; branding is public", async () => {
    await db.asSuper(async (s) => {
      await s.exec("insert into storage.objects (bucket_id, name) values ('generated', 'invoices/inv.pdf'), ('branding', 'logo.png'), ('task-files', $1)", [`${F.task("B")}/wp.xlsx`]);
      for (const [user, generated, task] of [[U.P1, 1, 1], [U.M1, 1, 1], [U.E1, 0, 0], [U.E2, 0, 1], [U.CA, 0, 0]] as const) {
        await s.as(user);
        expect(await s.value<number>("select count(*)::int from storage.objects where bucket_id = 'generated'"), user.key).toBe(generated);
        expect(await s.value<number>("select count(*)::int from storage.objects where bucket_id = 'task-files'"), user.key).toBe(task);
        expect(await s.value<number>("select count(*)::int from storage.objects where bucket_id = 'branding'"), user.key).toBe(1);
      }
      await s.as("anon");
      expect(await s.value<number>("select count(*)::int from storage.objects")).toBe(1);
    });
  });

  it("a portal user uploads only into their own client's folder; staff only into visible clients'", async () => {
    await db.asRole(U.CA, async (s) => {
      expect(await s.exec("insert into storage.objects (bucket_id, name, owner) values ('client-documents', $1, $2)", [`${C.A}/upload.pdf`, U.CA.id])).toBe(1);
      expect((await s.attempt("insert into storage.objects (bucket_id, name, owner) values ('client-documents', $1, $2)", [`${C.B}/upload.pdf`, U.CA.id])).ok).toBe(false);
      expect((await s.attempt("insert into storage.objects (bucket_id, name, owner) values ('branding', 'logo2.png', $1)", [U.CA.id])).ok).toBe(false);
    });
    await db.asRole(U.E1, async (s) => {
      expect(await s.exec("insert into storage.objects (bucket_id, name) values ('client-documents', $1)", [`${C.A}/x.pdf`])).toBe(1);
      expect((await s.attempt("insert into storage.objects (bucket_id, name) values ('client-documents', $1)", [`${C.C}/x.pdf`])).ok).toBe(false);
      expect((await s.attempt("insert into storage.objects (bucket_id, name) values ('generated', 'x.pdf')")).ok).toBe(false);
    });
  });
});
