/**
 * Client WhatsApp groups and TaxWise Desktop (§4.6, §5.13, §7.25, §18.3 Partner 10–13, Employee 8–10):
 *   - group integrity: the name carries the client code, one live group per name, invite links are
 *     chat.whatsapp.com links, a closed group stays closed, Open chat alone stamps last_opened;
 *   - mark_whatsapp_group_created: Active, members from the checklist, the creator an admin;
 *   - set_primary / close_whatsapp_group: one primary per client, the next open group promoted;
 *   - record_whatsapp_open: can_open_whatsapp (covers in force count), Employees in a browser only
 *     when a Partner allows it, only Active groups open, audit rows, the invite link only for
 *     Partners and Managers;
 *   - the desktop functions: check-in, revocation, number links by §7.25.4, health once a day,
 *     access_denied audit;
 *   - firm numbers: a Partner's number is theirs alone; the custodian records device reviews;
 *   - the register and linked-PC views are Partner/Manager only and SELECT-only.
 */
import { describe, expect, it } from "vitest";
import { C, F, SQLSTATE, U, setupTestDatabase, userMessage, type Session } from "./helpers";

const db = setupTestDatabase("whatsapp");

const KEY1 = "a".repeat(64);
const KEY2 = "b".repeat(64);

type Numbers = { p1: string; p2: string; mgr: string; staff: string };

/** Fills the seeded slots (§16) as the firm would in Settings → WhatsApp. Superuser, same transaction. */
async function setUpNumbers(s: Session): Promise<Numbers> {
  await s.as("super");
  const id = (label: string) => s.value<string>("select id from firm_whatsapp_numbers where label = $1", [label]);
  const ids = {
    p1: await id("CA Vinay H Karlagere (Partner)"),
    p2: await id("Partner 2"),
    mgr: await id("Managers' office"),
    staff: await id("Staff office"),
  };
  await s.exec("update firm_whatsapp_numbers set number = '919876500001', is_active = true, employee_id = $2 where id = $1", [ids.p1, U.P1.employeeId]);
  await s.exec("update firm_whatsapp_numbers set number = '919876500002', is_active = true, employee_id = $2 where id = $1", [ids.p2, U.P2.employeeId]);
  await s.exec("update firm_whatsapp_numbers set number = '919876500004', is_active = true, custodian_employee_id = $2 where id = $1", [ids.mgr, U.M1.employeeId]);
  await s.exec("update firm_whatsapp_numbers set number = '919876500005', is_active = true, custodian_employee_id = $2 where id = $1", [ids.staff, U.E1.employeeId]);
  return ids;
}

/** A to_create group for client B (B's fixture group closed first so this one can be primary). */
async function newGroupForB(s: Session): Promise<{ id: string; updated_at: string }> {
  await s.as("super");
  await s.exec("update client_whatsapp_groups set status = 'closed', closed_at = now(), closed_reason = 'test', is_primary = false where id = $1", [F.waGroup("B")]);
  await s.exec("update client_contacts set whatsapp = '98450 12345', role = 'Director' where client_id = $1", [C.B]);
  await s.as(U.M1);
  return s.one<{ id: string; updated_at: string }>(
    "insert into client_whatsapp_groups (client_id, name, purpose) values ($1, 'TW · TW-C-9002 · Beta Industries', 'All work') returning id, updated_at",
    [C.B],
  );
}

function membersFor(n: Numbers, contactId: string) {
  return JSON.stringify([
    { kind: "firm_number", firm_number_id: n.p1, display_name: "CA Vinay H Karlagere (Partner)", number: "919876500001", is_admin: false },
    { kind: "firm_number", firm_number_id: n.p2, display_name: "Partner 2", number: "919876500002", is_admin: false },
    { kind: "firm_number", firm_number_id: n.mgr, display_name: "Managers' office", number: "919876500004", is_admin: true },
    { kind: "firm_number", firm_number_id: n.staff, display_name: "Staff office", number: "919876500005", is_admin: false },
    { kind: "client_contact", contact_id: contactId, display_name: "Contact B (Director)", number: "919845012345", is_admin: false },
  ]);
}

describe("WhatsApp group integrity (§5.13)", () => {
  it("the name must carry the client code, and one live group per name", async () => {
    await db.asRole(U.M1, async (s) => {
      const bad = await s.fails("insert into client_whatsapp_groups (client_id, name, is_primary) values ($1, 'Alpha Traders', false)", [C.A]);
      expect(userMessage(bad)).toMatch(/Keep the client code TW-C-9001/);
      expect(await s.exec("insert into client_whatsapp_groups (client_id, name, is_primary) values ($1, 'TW · tw-c-9001 · Alpha Traders · Audit', false)", [C.A])).toBe(1);
      const dup = await s.fails("insert into client_whatsapp_groups (client_id, name, is_primary) values ($1, 'TW · TW-C-9001 · ALPHA TRADERS · audit', false)", [C.A]);
      expect(dup.code).toBe(SQLSTATE.uniqueViolation);
      // a second primary among open groups is refused by the partial unique index
      expect((await s.fails("insert into client_whatsapp_groups (client_id, name) values ($1, 'TW · TW-C-9001 · Second')", [C.A])).code).toBe(SQLSTATE.uniqueViolation);
    });
  });

  it("invite links are chat.whatsapp.com links; the checklist holds only the seven steps", async () => {
    await db.asRole(U.M1, async (s) => {
      expect(userMessage(await s.fails("update client_whatsapp_groups set invite_link = 'https://evil.example/x' where id = $1", [F.waGroup("A")]))).toMatch(/chat\.whatsapp\.com/);
      expect(await s.exec("update client_whatsapp_groups set invite_link = 'https://chat.whatsapp.com/AbCdEf0123456789' where id = $1", [F.waGroup("A")])).toBe(1);
      expect(userMessage(await s.fails(`update client_whatsapp_groups set checklist = '{"hack": {"done": true}}' where id = $1`, [F.waGroup("A")]))).toMatch(/doesn't know \(hack\)/);
      expect(await s.exec(`update client_whatsapp_groups set checklist = '{"group_name": {"done": true}}' where id = $1`, [F.waGroup("A")])).toBe(1);
      expect(userMessage(await s.fails("update client_whatsapp_groups set client_id = $2 where id = $1", [F.waGroup("A"), C.B]))).toMatch(/stays with its client/);
    });
  });

  it("the guard's code lookup tells nobody another client's code", async () => {
    expect(await db.asRole(U.E1, (s) => s.value("select client_code_of($1)", [C.B]))).toBeNull();
    expect(await db.asRole(U.E1, (s) => s.value("select client_code_of($1)", [C.A]))).toBe("TW-C-9001");
    expect(await db.asRole(U.CB, (s) => s.value("select client_code_of($1)", [C.A]))).toBeNull();
    await db.asAnon(async (s) => {
      expect((await s.fails("select client_code_of($1)", [C.A])).code).toBe(SQLSTATE.insufficientPrivilege);
    });
  });

  it("only Open chat records when a group was last opened", async () => {
    await db.asRole(U.P1, async (s) => {
      expect(userMessage(await s.fails("update client_whatsapp_groups set last_opened_at = now() where id = $1", [F.waGroup("A")]))).toMatch(/Open chat only/);
    });
  });

  it("Employees can't create or edit groups", async () => {
    await db.asRole(U.E1, async (s) => {
      expect((await s.fails("insert into client_whatsapp_groups (client_id, name, is_primary) values ($1, 'TW · TW-C-9001 · x', false)", [C.A])).code).toBe(SQLSTATE.insufficientPrivilege);
      expect(await s.exec("update client_whatsapp_groups set notes = 'x'")).toBe(0);
      expect(userMessage(await s.fails("select set_primary_whatsapp_group($1)", [F.waGroup("A")]))).toMatch(/Only Partners and Managers/);
    });
  });
});

describe("Close group and the primary group (§7.25.2)", () => {
  it("closing needs a reason and a date not in the future; the next open group becomes primary; closed stays closed", async () => {
    await db.asRole(U.M1, async (s) => {
      const second = await s.value<string>("insert into client_whatsapp_groups (client_id, name, is_primary) values ($1, 'TW · TW-C-9001 · Alpha · Audit', false) returning id", [C.A]);
      const loaded = await s.value<string>("select updated_at::text from client_whatsapp_groups where id = $1", [F.waGroup("A")]);
      expect(userMessage(await s.fails("select close_whatsapp_group($1, $2::timestamptz, current_date, '  ')", [F.waGroup("A"), loaded]))).toMatch(/Say why/);
      expect(userMessage(await s.fails("select close_whatsapp_group($1, $2::timestamptz, current_date + 5, 'Engagement ended')", [F.waGroup("A"), loaded]))).toMatch(/future/);
      expect(userMessage(await s.fails("select close_whatsapp_group($1, '2020-01-01'::timestamptz, current_date, 'Engagement ended')", [F.waGroup("A")]))).toMatch(/changed by someone else/);
      const r = await s.value<{ promoted_id: string; was_status: string }>("select close_whatsapp_group($1, $2::timestamptz, current_date, 'Engagement ended')", [F.waGroup("A"), loaded]);
      expect(r.promoted_id).toBe(second);
      expect(await s.one("select status, is_primary, closed_reason from client_whatsapp_groups where id = $1", [F.waGroup("A")])).toEqual({ status: "closed", is_primary: false, closed_reason: "Engagement ended" });
      expect(await s.value("select is_primary from client_whatsapp_groups where id = $1", [second])).toBe(true);
      expect(userMessage(await s.fails("update client_whatsapp_groups set status = 'active' where id = $1", [F.waGroup("A")]))).toMatch(/closed group stays closed/);
      expect(userMessage(await s.fails("select set_primary_whatsapp_group($1)", [F.waGroup("A")]))).toMatch(/closed group can't be the primary/);
    });
  });

  it("set_primary_whatsapp_group swaps the primary in one go", async () => {
    await db.asRole(U.P1, async (s) => {
      const other = await s.value<string>("insert into client_whatsapp_groups (client_id, name, is_primary) values ($1, 'TW · TW-C-9001 · Alpha · Audit', false) returning id", [C.A]);
      const r = await s.value<{ changed: boolean; previous_id: string }>("select set_primary_whatsapp_group($1)", [other]);
      expect(r).toMatchObject({ changed: true, previous_id: F.waGroup("A") });
      expect(await s.rows("select id from client_whatsapp_groups where client_id = $1 and is_primary", [C.A])).toEqual([{ id: other }]);
      expect((await s.value<{ changed: boolean }>("select set_primary_whatsapp_group($1)", [other])).changed).toBe(false);
    });
  });
});

describe("mark_whatsapp_group_created (§7.25.2 step 7, §18.3 Partner 10)", () => {
  it("makes the group Active with six members and the creating number an admin", async () => {
    await db.asRole(U.P1, async (s) => {
      const n = await setUpNumbers(s);
      const g = await newGroupForB(s);
      await s.as(U.P1);
      const r = await s.value<{ members: number; admins: number; created_by_label: string }>(
        "select mark_whatsapp_group_created($1, $2::timestamptz, current_date, $3, 'https://chat.whatsapp.com/AbCdEf0123456789', $4::jsonb)",
        [g.id, g.updated_at, n.p1, membersFor(n, `${(await s.value<string>("select id from client_contacts where client_id = $1", [C.B]))}`)],
      );
      expect(r).toMatchObject({ members: 5, admins: 2, created_by_label: "CA Vinay H Karlagere (Partner)" });
      const row = await s.one<{ status: string; created_by_number_id: string; invite_link: string; done: boolean }>(
        "select status, created_by_number_id, invite_link, (checklist -> 'mark_created' ->> 'done')::boolean as done from client_whatsapp_groups where id = $1",
        [g.id],
      );
      expect(row).toEqual({ status: "active", created_by_number_id: n.p1, invite_link: "https://chat.whatsapp.com/AbCdEf0123456789", done: true });
      const admins = await s.rows<{ firm_number_id: string }>("select firm_number_id from client_whatsapp_group_members where group_id = $1 and is_admin order by firm_number_id", [g.id]);
      expect(admins.map((a) => a.firm_number_id).sort()).toEqual([n.p1, n.mgr].sort());
      expect(userMessage(await s.fails("select mark_whatsapp_group_created($1, null, current_date, $2, null, '[]')", [g.id, n.p1]))).toMatch(/already marked created/);
    });
  });

  it("adds the creating number when the list leaves it out, and checks every member", async () => {
    await db.asRole(U.M1, async (s) => {
      const n = await setUpNumbers(s);
      const g = await newGroupForB(s);
      const contactA = await s.value<string>("select id from client_contacts where client_id = $1", [C.A]);
      await s.as(U.M1);
      const foreign = JSON.stringify([{ kind: "client_contact", contact_id: contactA, display_name: "Contact A", number: "919845099999" }]);
      expect(userMessage(await s.fails("select mark_whatsapp_group_created($1, null, current_date, $2, null, $3::jsonb)", [g.id, n.mgr, foreign]))).toMatch(/contacts changed/);
      const wrongDigits = JSON.stringify([{ kind: "firm_number", firm_number_id: n.staff, display_name: "Staff office", number: "919876599999" }]);
      expect(userMessage(await s.fails("select mark_whatsapp_group_created($1, null, current_date, $2, null, $3::jsonb)", [g.id, n.mgr, wrongDigits]))).toMatch(/numbers changed/);
      expect(userMessage(await s.fails("select mark_whatsapp_group_created($1, '2020-01-01', current_date, $2, null, '[]')", [g.id, n.mgr]))).toMatch(/changed by someone else/);
      expect(userMessage(await s.fails("select mark_whatsapp_group_created($1, null, today_ist() + 1, $2, null, '[]')", [g.id, n.mgr]))).toMatch(/future/);
      expect(userMessage(await s.fails("select mark_whatsapp_group_created($1, null, current_date, $2, 'not a link', '[]')", [g.id, n.mgr]))).toMatch(/invite link/);
      const r = await s.value<{ members: number; admins: number }>("select mark_whatsapp_group_created($1, null, current_date, $2, null, '[]')", [g.id, n.mgr]);
      expect(r).toMatchObject({ members: 1, admins: 1 });
    });
  });

  it("is Partner/Manager only", async () => {
    await db.asRole(U.E2, async (s) => {
      expect(userMessage(await s.fails("select mark_whatsapp_group_created($1, null, current_date, $1, null, '[]')", [F.waGroup("B")]))).toMatch(/Only Partners and Managers/);
    });
  });

  it("remove_firm_number_from_groups records a departed Partner's number as removed", async () => {
    await db.asRole(U.P1, async (s) => {
      const n = await setUpNumbers(s);
      const g = await newGroupForB(s);
      const contactB = await s.value<string>("select id from client_contacts where client_id = $1", [C.B]);
      await s.as(U.P1);
      await s.value("select mark_whatsapp_group_created($1, null, current_date, $2, null, $3::jsonb)", [g.id, n.p1, membersFor(n, contactB)]);
      expect(await s.value<number>("select remove_firm_number_from_groups($1, array[$2]::uuid[])", [n.p2, g.id])).toBe(1);
      expect(await s.value<number>("select count(*)::int from client_whatsapp_group_members where group_id = $1 and removed_on is null", [g.id])).toBe(4);
      await s.as(U.E2);
      expect(userMessage(await s.fails("select remove_firm_number_from_groups($1, array[$2]::uuid[])", [n.p1, g.id]))).toMatch(/Only Partners and Managers/);
    });
  });
});

describe("Open chat: record_whatsapp_open (§7.25.1, §7.25.8, §18.3 Partner 11–12)", () => {
  it("an Employee opens their own client's group in TaxWise Desktop; it is audited and stamped", async () => {
    await db.asRole(U.E1, async (s) => {
      const r = await s.value<{ status: string; group: { id: string; invite_link: string | null }; member_number_ids: string[] }>(
        "select record_whatsapp_open($1, null, 'desktop', '10.0.0.1', 'TaxWise Desktop')",
        [C.A],
      );
      expect(r.status).toBe("ok");
      expect(r.group.id).toBe(F.waGroup("A"));
      expect(r.group.invite_link).toBeNull();
      expect(JSON.stringify(r)).not.toContain("chat.whatsapp.com");
      await s.as("super");
      expect(await s.value("select last_opened_by from client_whatsapp_groups where id = $1", [F.waGroup("A")])).toBe(U.E1.id);
      const audit = await s.one<{ event: string; resource_type: string; details: { via: string } }>(
        "select event, resource_type, details from audit_logs where user_id = $1 and action = 'whatsapp.open' order by at desc limit 1",
        [U.E1.id],
      );
      expect(audit).toMatchObject({ event: "record_viewed", resource_type: "client_whatsapp_group", details: { via: "desktop" } });
    });
  });

  it("refuses another client's group with an access_denied audit row", async () => {
    await db.asRole(U.E1, async (s) => {
      const r = await s.value<{ status: string; error: string }>("select record_whatsapp_open($1, null, 'desktop')", [C.B]);
      expect(r).toEqual({ status: "forbidden", error: "Not one of your clients." });
      await s.as("super");
      expect(await s.value("select event from audit_logs where user_id = $1 and action = 'whatsapp.open' order by at desc limit 1", [U.E1.id])).toBe("access_denied");
      expect(await s.value("select last_opened_at from client_whatsapp_groups where id = $1", [F.waGroup("B")])).toBeNull();
    });
  });

  it("Employees open in a browser only when a Partner allows it", async () => {
    await db.asRole(U.E1, async (s) => {
      expect((await s.value<{ status: string }>("select record_whatsapp_open($1, null, 'browser')", [C.A])).status).toBe("forbidden");
      expect((await s.value<{ status: string }>("select record_whatsapp_open($1, null, 'phone')", [C.A])).status).toBe("forbidden");
      await s.as("super");
      await s.exec("update firm_settings set whatsapp_employee_browser_window = true where id = 1");
      await s.as(U.E1);
      expect((await s.value<{ status: string }>("select record_whatsapp_open($1, null, 'browser')", [C.A])).status).toBe("ok");
    });
    // Partners and Managers always may, and they get the invite link
    await db.asRole(U.M1, async (s) => {
      const r = await s.value<{ status: string; group: { invite_link: string } }>("select record_whatsapp_open($1, null, 'browser')", [C.A]);
      expect(r.status).toBe("ok");
      expect(r.group.invite_link).toBe("https://chat.whatsapp.com/inviteA");
    });
  });

  it("a cover in force lets the cover person open the group; nobody else", async () => {
    await db.asRole(U.P1, async (s) => {
      await s.exec(
        "insert into client_covers (kind, client_id, cover_employee_id, ends_at, reason, granted_by) values ('client', $1, $2, now() + interval '1 day', 'leave', $3)",
        [C.A, U.E3.employeeId, U.P1.id],
      );
      await s.as(U.E3);
      expect((await s.value<{ status: string }>("select record_whatsapp_open($1, null, 'desktop')", [C.A])).status).toBe("ok");
      await s.as(U.E4);
      expect((await s.value<{ status: string }>("select record_whatsapp_open($1, null, 'desktop')", [C.A])).status).toBe("forbidden");
    });
  });

  it("clients never open WhatsApp; only an Active group opens", async () => {
    await db.asRole(U.CA, async (s) => {
      expect((await s.value<{ status: string }>("select record_whatsapp_open($1, null, 'browser')", [C.A])).status).toBe("forbidden");
    });
    await db.asRole(U.M1, async (s) => {
      await s.as("super");
      await s.exec("update client_whatsapp_groups set status = 'to_create' where id = $1", [F.waGroup("C")]);
      await s.as(U.M1);
      const r = await s.value<{ status: string; error: string }>("select record_whatsapp_open($1, null, 'desktop')", [C.C]);
      expect(r.status).toBe("no_group");
      expect(r.error).toMatch(/isn't marked created yet/);
      await s.as("super");
      await s.exec("update client_whatsapp_groups set deleted_at = now() where client_id = $1", [C.C]);
      await s.as(U.M1);
      expect((await s.value<{ error: string }>("select record_whatsapp_open($1, null, 'desktop')", [C.C])).error).toMatch(/Gamma LLP has no WhatsApp group yet/);
      expect(userMessage(await s.fails("select record_whatsapp_open($1, null, 'fax')", [C.A]))).toMatch(/TaxWise Desktop, a browser window or the phone app/);
    });
  });
});

describe("TaxWise Desktop functions (§7.25.3–§7.25.7, §18.3 Partner 11 and 13)", () => {
  it("check-in creates the PC, records the last user, keeps a Partner's rename", async () => {
    await db.asRole(U.E1, async (s) => {
      const r = await s.value<{ status: string; device_id: string; created: boolean }>("select desktop_checkin($1, 'FRONTDESK-2', 'Windows 10.0', '1.4.0')", [KEY1]);
      expect(r).toMatchObject({ status: "ok", created: true });
      await s.as(U.P1);
      expect((await s.value<{ after: string }>("select rename_desktop_device($1, '  Front desk 2 ')", [r.device_id])).after).toBe("Front desk 2");
      await s.as(U.E2);
      expect((await s.value<{ created: boolean }>("select desktop_checkin($1, 'FRONTDESK-2', 'Windows 10.0', '1.4.1')", [KEY1])).created).toBe(false);
      await s.as("super");
      expect(await s.one("select device_name, app_version, last_user_id from desktop_devices where id = $1", [r.device_id])).toEqual({
        device_name: "Front desk 2",
        app_version: "1.4.1",
        last_user_id: U.E2.id,
      });
      await s.as(U.M1);
      expect(userMessage(await s.fails("select rename_desktop_device($1, 'X2')", [r.device_id]))).toMatch(/Only a Partner/);
    });
  });

  it("refuses clients and malformed keys", async () => {
    await db.asRole(U.CA, async (s) => {
      expect(userMessage(await s.fails("select desktop_checkin($1, 'PC', null, null)", [KEY1]))).toMatch(/firm's staff/);
    });
    await db.asRole(U.E1, async (s) => {
      expect(userMessage(await s.fails("select desktop_checkin('not-a-key', 'PC', null, null)"))).toMatch(/key isn't valid/);
    });
  });

  it("links follow §7.25.4: Staff office for Employees, a Partner's number only for its owner", async () => {
    await db.asRole(U.E1, async (s) => {
      const n = await setUpNumbers(s);
      await s.as(U.E1);
      expect((await s.value<{ status: string }>("select desktop_link_number($1, $2, true)", [KEY2, n.staff])).status).toBe("not_found");
      await s.value("select desktop_checkin($1, 'FRONTDESK-2', null, null)", [KEY1]);
      const first = await s.value<{ status: string; changed: boolean; active_links: number; device_limit: number; number_label: string }>(
        "select desktop_link_number($1, $2, true)",
        [KEY1, n.staff],
      );
      expect(first).toMatchObject({ status: "ok", changed: true, active_links: 1, device_limit: 4, number_label: "Staff office" });
      expect((await s.value<{ changed: boolean }>("select desktop_link_number($1, $2, true)", [KEY1, n.staff])).changed).toBe(false);
      const p1 = await s.value<{ status: string; error: string }>("select desktop_link_number($1, $2, true)", [KEY1, n.p1]);
      expect(p1.status).toBe("forbidden");
      expect(p1.error).toMatch(/CA Vinay H Karlagere \(Partner\)/);
      expect((await s.value<{ status: string }>("select desktop_link_number($1, $2, true)", [KEY1, n.mgr])).status).toBe("forbidden");
      await s.as(U.P2);
      expect((await s.value<{ status: string }>("select desktop_link_number($1, $2, true)", [KEY1, n.p1])).status).toBe("forbidden");
      await s.as(U.P1);
      expect((await s.value<{ status: string; changed: boolean }>("select desktop_link_number($1, $2, true)", [KEY1, n.p1])).changed).toBe(true);
      expect((await s.value<{ changed: boolean }>("select desktop_link_number($1, $2, false)", [KEY1, n.p1])).changed).toBe(true);
      await s.as("super");
      expect(await s.value<string>("select linked_by from desktop_device_numbers where number_id = $1 and unlinked_at is null", [n.staff])).toBe(U.E1.id);
    });
  });

  it("a removed PC is refused everywhere (§18.3 Partner 13)", async () => {
    await db.asRole(U.E1, async (s) => {
      const n = await setUpNumbers(s);
      await s.as(U.E1);
      const r = await s.value<{ device_id: string }>("select desktop_checkin($1, 'FRONTDESK-2', null, null)", [KEY1]);
      await s.value("select desktop_link_number($1, $2, true)", [KEY1, n.staff]);
      await s.as(U.P1);
      expect(await s.value("select revoke_desktop_device($1)", [r.device_id])).toBe(true);
      await s.as(U.E1);
      expect((await s.value<{ status: string }>("select desktop_checkin($1, 'FRONTDESK-2', null, null)", [KEY1])).status).toBe("revoked");
      expect((await s.value<{ status: string }>("select desktop_touch_device($1)", [KEY1])).status).toBe("revoked");
      expect((await s.value<{ status: string }>("select desktop_link_number($1, $2, true)", [KEY1, n.staff])).status).toBe("revoked");
      expect((await s.value<{ status: string }>("select desktop_report_health($1, array['searchBox'])", [KEY1])).status).toBe("revoked");
      expect((await s.value<{ status: string }>("select desktop_log_access_denied($1, $2, 'x')", [KEY1, n.staff])).status).toBe("revoked");
      await s.as("super");
      expect(await s.value<number>("select count(*)::int from desktop_device_numbers where device_id = $1 and unlinked_at is null", [r.device_id])).toBe(0);
    });
  });

  it("health reports tell Partners at most once a day per PC (§18.3 Employee 10)", async () => {
    await db.asRole(U.E1, async (s) => {
      await s.value("select desktop_checkin($1, 'FRONTDESK-2', null, null)", [KEY1]);
      const first = await s.value<{ notify: boolean; failing: string[] }>("select desktop_report_health($1, array['searchBox', 'searchBox', 'bad selector!', 'conversationTitle'])", [KEY1]);
      expect(first).toMatchObject({ notify: true, failing: ["conversationTitle", "searchBox"] });
      expect((await s.value<{ notify: boolean }>("select desktop_report_health($1, array['searchBox'])", [KEY1])).notify).toBe(false);
      await s.as("super");
      expect(await s.value("select failing_checks from desktop_devices where device_key = $1", [KEY1])).toEqual(["searchBox"]);
      await s.exec("update desktop_devices set last_health_alert_at = now() - interval '1 day' where device_key = $1", [KEY1]);
      await s.as(U.E1);
      expect((await s.value<{ notify: boolean }>("select desktop_report_health($1, array['searchBox'])", [KEY1])).notify).toBe(true);
      expect((await s.value<{ notify: boolean }>("select desktop_report_health($1, array[]::text[])", [KEY1])).notify).toBe(false);
      await s.as("super");
      expect(await s.value("select failing_checks from desktop_devices where device_key = $1", [KEY1])).toBeNull();
    });
  });

  it("access_denied is audited on the client's group when the title is one (§18.3 Employee 8)", async () => {
    await db.asRole(U.E1, async (s) => {
      const n = await setUpNumbers(s);
      await s.as(U.E1);
      await s.value("select desktop_checkin($1, 'FRONTDESK-2', null, null)", [KEY1]);
      await s.value("select desktop_log_access_denied($1, $2, ' TW · B ')", [KEY1, n.staff]);
      await s.value("select desktop_log_access_denied($1, $2, 'Family group')", [KEY1, n.staff]);
      await s.as("super");
      const rows = await s.rows<{ resource_type: string; resource_id: string | null; details: Record<string, unknown> }>(
        "select resource_type, resource_id, details from audit_logs where user_id = $1 and action = 'desktop.access_denied' order by resource_type",
        [U.E1.id],
      );
      expect(rows).toHaveLength(2);
      const byType = Object.fromEntries(rows.map((r) => [r.resource_type, r]));
      expect(byType.client_whatsapp_group).toMatchObject({ resource_id: F.waGroup("B"), details: { chat_title: "TW · B", number_label: "Staff office", device_name: "FRONTDESK-2", client_id: C.B } });
      expect(byType.whatsapp_chat).toMatchObject({ resource_id: null, details: { chat_title: "Family group" } });
    });
  });
});

describe("Firm WhatsApp numbers (§5.13, §7.21, §7.25.10)", () => {
  it("a Partner's own number is theirs alone", async () => {
    await db.asRole(U.P1, async (s) => {
      const p2 = await s.value<string>("select id from firm_whatsapp_numbers where label = 'Partner 2'");
      const staff = await s.value<string>("select id from firm_whatsapp_numbers where label = 'Staff office'");
      expect(userMessage(await s.fails("update firm_whatsapp_numbers set usable_by = '{partner,manager}' where id = $1", [p2]))).toMatch(/Partners only/);
      expect(userMessage(await s.fails("update firm_whatsapp_numbers set number = '919876500002', is_active = true where id = $1", [p2]))).toMatch(/Choose the Partner/);
      expect(userMessage(await s.fails("update firm_whatsapp_numbers set employee_id = $2 where id = $1", [staff, U.P1.employeeId]))).toMatch(/Only a Partner's own number has an owner/);
      expect(userMessage(await s.fails("update firm_whatsapp_numbers set employee_id = $2 where id = $1", [p2, U.E1.employeeId]))).toMatch(/active Partner/);
      expect(await s.exec("update firm_whatsapp_numbers set number = '919876500002', is_active = true, employee_id = $2 where id = $1", [p2, U.P2.employeeId])).toBe(1);
    });
    await db.asRole(U.M1, async (s) => {
      expect(await s.exec("update firm_whatsapp_numbers set two_step_verification_on = true")).toBe(0);
    });
  });

  it("the custodian or a Partner records the linked devices review", async () => {
    await db.asRole(U.E1, async (s) => {
      const n = await setUpNumbers(s);
      await s.as(U.E1);
      expect((await s.value<{ label: string }>("select record_whatsapp_devices_review($1)", [n.staff])).label).toBe("Staff office");
      await s.as(U.E2);
      expect(userMessage(await s.fails("select record_whatsapp_devices_review($1)", [n.staff]))).toMatch(/custodian or a Partner/);
      await s.as(U.M1);
      expect(userMessage(await s.fails("select record_whatsapp_devices_review($1)", [n.staff]))).toMatch(/custodian or a Partner/);
      expect((await s.value<{ label: string }>("select record_whatsapp_devices_review($1)", [n.mgr])).label).toBe("Managers' office");
      await s.as(U.P1);
      expect((await s.value<{ label: string }>("select record_whatsapp_devices_review($1)", [n.staff])).label).toBe("Staff office");
      await s.as("super");
      expect(await s.value<boolean>("select devices_reviewed_at is not null from firm_whatsapp_numbers where id = $1", [n.staff])).toBe(true);
    });
  });
});

describe("Register and linked-PC views (§7.25.1, §7.25.7)", () => {
  it("the register lists every group and the clients with no group, for Partners and Managers only", async () => {
    await db.asRole(U.P1, async (s) => {
      await s.as("super");
      await s.exec("insert into clients (id, client_code, display_name, entity_type, status) values ($1, 'TW-C-9005', 'Delta Foods', 'pvt_ltd', 'active')", [
        "d0000000-0000-4000-8000-000000000005",
      ]);
      await s.as(U.P1);
      const rows = await s.rows<{ status: string; client_name: string; member_count: number; checklist_done: number }>(
        "select status, client_name, member_count, checklist_done from whatsapp_group_register order by status_rank, client_name",
      );
      expect(rows[0]).toMatchObject({ status: "none", client_name: "Delta Foods" });
      expect(rows.filter((r) => r.status === "active").map((r) => r.client_name)).toEqual(["Alpha Traders", "Beta Industries", "Gamma LLP"]);
      expect(rows.find((r) => r.client_name === "Alpha Traders")?.member_count).toBe(1);
      // SELECT-only for the API roles (0043 §1)
      expect((await s.attempt("update whatsapp_group_register set group_name = 'x'")).ok).toBe(false);
      for (const view of ["whatsapp_group_register", "desktop_devices_overview"]) {
        for (const priv of ["INSERT", "UPDATE", "DELETE"]) {
          expect(await s.value<boolean>("select has_table_privilege('authenticated', $1, $2)", [`public.${view}`, priv]), `${view} ${priv}`).toBe(false);
        }
        expect(await s.value<boolean>("select has_table_privilege('anon', $1, 'SELECT')", [`public.${view}`])).toBe(false);
      }
    });
    expect(await db.asRole(U.E1, (s) => s.value<number>("select count(*)::int from whatsapp_group_register"))).toBe(0);
    expect(await db.asRole(U.CA, (s) => s.value<number>("select count(*)::int from whatsapp_group_register"))).toBe(0);
    await db.asAnon(async (s) => {
      expect((await s.fails("select * from whatsapp_group_register")).code).toBe(SQLSTATE.insufficientPrivilege);
    });
  });

  it("linked PCs are visible to Partners and Managers only", async () => {
    const row = await db.asRole(U.M1, (s) => s.one<{ device_name: string; link_count: number; links: Array<{ label: string }> }>("select device_name, link_count, links from desktop_devices_overview where id = $1", [F.device]));
    expect(row.device_name).toBe("Front desk PC");
    expect(row.link_count).toBe(1);
    expect(row.links[0].label).toBeTruthy();
    expect(await db.asRole(U.E1, (s) => s.value<number>("select count(*)::int from desktop_devices_overview"))).toBe(0);
  });
});
