/**
 * Clients and client-owned data (§4.1 Employee scope, §4.6, §4.7 covers, §5.13, §7.22, §14):
 *   - an Employee sees a client only as owner, team member or while holding a cover in force;
 *   - covers end by themselves (ends_at), on revocation, and person covers reach the absent
 *     colleague's clients; WhatsApp follows the same rule; nobody but staff ever gets WhatsApp;
 *   - Employees never receive invite_link, fee columns, or credential ciphertext (nobody does);
 *   - Employees' updates are column-limited (notes only on clients);
 *   - a portal user never reads another client's data;
 *   - desktop device tables are Partner/Manager only.
 */
import { describe, expect, it } from "vitest";
import { C, F, SQLSTATE, U, fid, setupTestDatabase, userMessage, type Session, type TestUser } from "./helpers";

const db = setupTestDatabase("clients");

const clientIds = async (s: Session) => (await s.rows<{ id: string }>("select id from clients order by display_name")).map((r) => r.id);
const canSee = (s: Session, cid: string) => s.value<boolean>("select can_see_client($1)", [cid]);
const canWa = (s: Session, cid: string) => s.value<boolean>("select can_open_whatsapp($1)", [cid]);

/** Grant a cover as P1 within the current transaction, then continue as `as`. */
async function grantCover(
  s: Session,
  cover: { kind: "client" | "person"; clientId?: string; absent?: TestUser; cover: TestUser; starts?: string; ends?: string },
): Promise<string> {
  await s.as(U.P1);
  const id = await s.value<string>(
    `insert into client_covers (kind, client_id, absent_employee_id, cover_employee_id, starts_at, ends_at, reason, granted_by)
     values ($1, $2, $3, $4, coalesce($5::timestamptz, now()), coalesce($6::timestamptz, now() + interval '2 days'), 'leave', $7)
     returning id`,
    [cover.kind, cover.clientId ?? null, cover.absent?.employeeId ?? null, cover.cover.employeeId, cover.starts ?? null, cover.ends ?? null, U.P1.id],
  );
  return id;
}

describe("Employee scope (§4.1): owner, team, or cover in force", () => {
  it("owner (E1 → A), team member (E2 → B), owner (E4 → B), nobody (E3)", async () => {
    expect(await db.asRole(U.E1, clientIds)).toEqual([C.A]);
    expect(await db.asRole(U.E2, clientIds)).toEqual([C.B]);
    expect(await db.asRole(U.E4, clientIds)).toEqual([C.B]);
    expect(await db.asRole(U.E3, clientIds)).toEqual([]);
  });

  it("a soft-deleted client drops out of its owner's view (recycle bin is Partner/Manager)", async () => {
    await db.asRole(U.E1, async (s) => {
      expect(await canSee(s, C.Z)).toBe(false);
      expect(await s.value<number>("select count(*)::int from clients where id = $1", [C.Z])).toBe(0);
    });
    expect(await db.asRole(U.M1, (s) => s.value<number>("select count(*)::int from clients where id = $1", [C.Z]))).toBe(1);
  });

  it("an expired cover (fixture: E3 covered A until yesterday) grants nothing", async () => {
    await db.asRole(U.E3, async (s) => {
      expect(await canSee(s, C.A)).toBe(false);
      expect(await s.value<number>("select count(*)::int from covers_in_force")).toBe(0);
      // … but the cover person still sees their own cover row (§4.6 Covers)
      expect(await s.rows("select id from client_covers")).toEqual([{ id: F.expiredCover }]);
    });
  });

  it("a client cover in force lets E3 see and work on A, including WhatsApp, never fees", async () => {
    await db.asSuper(async (s) => {
      await grantCover(s, { kind: "client", clientId: C.A, absent: U.E1, cover: U.E3 });
      await s.as(U.E3);
      expect(await clientIds(s)).toEqual([C.A]);
      expect(await canSee(s, C.A)).toBe(true);
      expect(await canWa(s, C.A)).toBe(true);
      expect(await canSee(s, C.B)).toBe(false);
      expect(await s.value<number>("select count(*)::int from tasks where client_id = $1", [C.A])).toBe(1);
      expect(await s.value<number>("select count(*)::int from documents where client_id = $1", [C.A])).toBe(2);
      expect(await s.value<number>("select count(*)::int from compliance_events where client_id = $1", [C.A])).toBe(2);
      expect((await s.rows("select id from client_whatsapp_groups_public")).map((r) => r.id)).toEqual([F.waGroup("A")]);
      // fees stay out of reach (§4.7 "They still never see fees")
      for (const t of ["client_services", "invoices", "payment_receipts", "quotations", "engagement_letters"]) {
        expect(await s.value<number>(`select count(*)::int from ${t}`), t).toBe(0);
      }
      expect(await s.value<number>("select count(*)::int from client_services_public where client_id = $1", [C.A])).toBe(1);
    });
  });

  it("access ends by itself when ends_at passes (RLS compares with now())", async () => {
    await db.asSuper(async (s) => {
      const id = await grantCover(s, { kind: "client", clientId: C.A, absent: U.E1, cover: U.E3 });
      await s.as(U.E3);
      expect(await canSee(s, C.A)).toBe(true);
      await s.as("super");
      await s.exec("update client_covers set starts_at = now() - interval '3 days', ends_at = now() - interval '1 second' where id = $1", [id]);
      await s.as(U.E3);
      expect(await canSee(s, C.A)).toBe(false);
      expect(await canWa(s, C.A)).toBe(false);
      expect(await clientIds(s)).toEqual([]);
      expect(await s.value<number>("select count(*)::int from client_whatsapp_groups_public")).toBe(0);
    });
  });

  it("access ends when the cover is revoked ('End now')", async () => {
    await db.asSuper(async (s) => {
      const id = await grantCover(s, { kind: "client", clientId: C.A, absent: U.E1, cover: U.E3 });
      await s.exec("update client_covers set revoked_at = now(), revoked_by = $2 where id = $1", [id, U.P1.id]);
      await s.as(U.E3);
      expect(await canSee(s, C.A)).toBe(false);
      expect(await clientIds(s)).toEqual([]);
    });
  });

  it("a cover that starts tomorrow grants nothing yet", async () => {
    await db.asSuper(async (s) => {
      await grantCover(s, {
        kind: "client", clientId: C.A, absent: U.E1, cover: U.E3,
        starts: new Date(Date.now() + 86_400_000).toISOString(), ends: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      });
      await s.as(U.E3);
      expect(await canSee(s, C.A)).toBe(false);
    });
  });

  it("a person cover reaches every client the absent colleague owns or is on the team of", async () => {
    await db.asSuper(async (s) => {
      // E3 covers E4, who owns B
      await grantCover(s, { kind: "person", absent: U.E4, cover: U.E3 });
      await s.as(U.E3);
      expect(await clientIds(s)).toEqual([C.B]);
      expect(await canWa(s, C.B)).toBe(true);
    });
    await db.asSuper(async (s) => {
      // E3 covers E2, who is on B's team (not owner)
      await grantCover(s, { kind: "person", absent: U.E2, cover: U.E3 });
      await s.as(U.E3);
      expect(await clientIds(s)).toEqual([C.B]);
      // … including a client assigned to E2 during the cover
      await s.as(U.P1);
      await s.exec("insert into client_team_members (client_id, employee_id) values ($1, $2)", [C.C, U.E2.employeeId]);
      await s.as(U.E3);
      expect(new Set(await clientIds(s))).toEqual(new Set([C.B, C.C]));
    });
  });

  it("a cover never passes on: E3 covering E1 doesn't see clients E1 only covers", async () => {
    await db.asSuper(async (s) => {
      await grantCover(s, { kind: "client", clientId: C.B, absent: U.E4, cover: U.E1 });
      await grantCover(s, { kind: "person", absent: U.E1, cover: U.E3 });
      await s.as(U.E1);
      expect(new Set(await clientIds(s))).toEqual(new Set([C.A, C.B]));
      await s.as(U.E3);
      expect(await clientIds(s)).toEqual([C.A]);
    });
  });

  it("the rules agree between can_see_client(), staff_client_ids() and the clients policy", async () => {
    await db.asSuper(async (s) => {
      await grantCover(s, { kind: "person", absent: U.E4, cover: U.E3 });
      for (const user of [U.E1, U.E2, U.E3, U.E4, U.X, U.D]) {
        await s.as(user);
        const viaPolicy = new Set(await clientIds(s));
        const viaSet = new Set((await s.rows<{ id: string }>("select id from staff_client_ids() as t(id)")).map((r) => r.id));
        const viaScalar = new Set<string>();
        for (const cid of Object.values(C)) if (await canSee(s, cid)) viaScalar.add(cid);
        expect(viaSet, user.key).toEqual(viaPolicy);
        expect(viaScalar, user.key).toEqual(viaPolicy);
      }
    });
  });
});

describe("covers: who grants, and the limits (§4.6, §4.7)", () => {
  it("Employees can't grant covers; Managers can, but can't include portal passwords", async () => {
    const e = await db.asRole(U.E1, (s) =>
      s.fails(
        `insert into client_covers (kind, client_id, cover_employee_id, ends_at, reason, granted_by) values ('client', $1, $2, now() + interval '1 day', 'leave', $3)`,
        [C.A, U.E3.employeeId, U.E1.id],
      ),
    );
    expect(e.code).toBe(SQLSTATE.insufficientPrivilege);
    await db.asRole(U.M1, async (s) => {
      const sql = `insert into client_covers (kind, client_id, cover_employee_id, ends_at, reason, granted_by, include_vault) values ('client', $1, $2, now() + interval '1 day', 'leave', $3, $4)`;
      expect(await s.exec(sql, [C.A, U.E3.employeeId, U.M1.id, false])).toBe(1);
      const v = await s.fails(sql, [C.A, U.E3.employeeId, U.M1.id, true]);
      expect(userMessage(v)).toMatch(/Only a Partner can include portal passwords/);
    });
  });

  it("no cover for or by a disabled person, no covering yourself, at most 90 days", async () => {
    await db.asRole(U.P1, async (s) => {
      const sql = `insert into client_covers (kind, client_id, absent_employee_id, cover_employee_id, ends_at, reason, granted_by) values ('client', $1, $2, $3, now() + $4::interval, 'leave', $5)`;
      expect(userMessage(await s.fails(sql, [C.A, U.E1.employeeId, U.D.employeeId, "1 day", U.P1.id]))).toMatch(/disabled/);
      expect(userMessage(await s.fails(sql, [C.A, U.D.employeeId, U.E3.employeeId, "1 day", U.P1.id]))).toMatch(/disabled/);
      expect((await s.fails(sql, [C.A, U.E3.employeeId, U.E3.employeeId, "1 day", U.P1.id])).code).toBe(SQLSTATE.checkViolation);
      expect((await s.fails(sql, [C.A, U.E1.employeeId, U.E3.employeeId, "91 days", U.P1.id])).code).toBe(SQLSTATE.checkViolation);
      expect(await s.exec(sql, [C.A, U.E1.employeeId, U.E3.employeeId, "89 days", U.P1.id])).toBe(1);
    });
  });

  it("covers are never deleted; the absent person ends one, the cover person adds a return note, nothing else", async () => {
    await db.asSuper(async (s) => {
      const id = await grantCover(s, { kind: "client", clientId: C.A, absent: U.E1, cover: U.E3 });
      expect((await s.fails("delete from client_covers where id = $1", [id])).code).toBe(SQLSTATE.insufficientPrivilege);
      await s.as(U.M1);
      expect((await s.fails("delete from client_covers where id = $1", [id])).code).toBe(SQLSTATE.insufficientPrivilege);
    });
    await db.asSuper(async (s) => {
      const id = await grantCover(s, { kind: "client", clientId: C.A, absent: U.E1, cover: U.E3 });
      await s.as(U.E3);
      expect(await s.exec("update client_covers set return_note = 'All done' where id = $1", [id])).toBe(1);
      expect(userMessage(await s.fails("update client_covers set ends_at = ends_at + interval '1 day' where id = $1", [id]))).toMatch(/can't change ends at/);
      expect(userMessage(await s.fails("update client_covers set revoked_at = now(), revoked_by = $2 where id = $1", [id, U.E3.id]))).toMatch(/revoked at/);
      await s.as(U.E1);
      expect(userMessage(await s.fails("update client_covers set revoked_at = now(), revoked_by = $2 where id = $1", [id, U.E3.id]))).toMatch(/Record yourself/);
      expect(await s.exec("update client_covers set revoked_at = now(), revoked_by = $2 where id = $1", [id, U.E1.id])).toBe(1);
      await s.as(U.E3);
      expect(await canSee(s, C.A)).toBe(false);
      // a bystander employee sees no covers at all
      await s.as(U.E2);
      expect(await s.value<number>("select count(*)::int from client_covers")).toBe(0);
    });
  });
});

describe("WhatsApp groups and invite links (§4.6, §5.13, §14)", () => {
  it("Employees never receive invite_link: the base table gives them no rows; the public view has no such column", async () => {
    await db.asRole(U.E1, async (s) => {
      expect(await s.value<number>("select count(*)::int from client_whatsapp_groups")).toBe(0);
      expect(await s.rows("select invite_link from client_whatsapp_groups")).toEqual([]);
      const pub = await s.rows<Record<string, unknown>>("select * from client_whatsapp_groups_public");
      expect(pub.map((r) => r.id)).toEqual([F.waGroup("A")]);
      expect(Object.keys(pub[0])).not.toContain("invite_link");
      expect((await s.fails("select invite_link from client_whatsapp_groups_public")).message).toMatch(/does not exist/);
    });
  });

  it("an Employee opens a group only for their own or covered clients", async () => {
    await db.asRole(U.E1, async (s) => {
      expect(await canWa(s, C.A)).toBe(true);
      expect(await canWa(s, C.B)).toBe(false);
      const ok = await s.value<{ allowed: boolean; group: { id: string; invite_link?: string } }>("select record_whatsapp_group_opened($1)", [C.A]);
      expect(ok.allowed).toBe(true);
      expect(ok.group.id).toBe(F.waGroup("A"));
      expect(JSON.stringify(ok)).not.toContain("chat.whatsapp.com");
      const no = await s.value<{ allowed: boolean }>("select record_whatsapp_group_opened($1)", [C.B]);
      expect(no.allowed).toBe(false);
    });
  });

  it("Partners and Managers read groups with invite links; group members follow can_open_whatsapp", async () => {
    for (const user of [U.P1, U.M1]) {
      const links = await db.asRole(user, (s) => s.rows<{ invite_link: string }>("select invite_link from client_whatsapp_groups"));
      expect(links, user.key).toHaveLength(3);
    }
    expect(await db.asRole(U.E1, (s) => s.value<number>("select count(*)::int from client_whatsapp_group_members"))).toBe(1);
    expect(await db.asRole(U.E3, (s) => s.value<number>("select count(*)::int from client_whatsapp_group_members"))).toBe(0);
  });

  it("clients never get WhatsApp groups, not even their own", async () => {
    await db.asRole(U.CA, async (s) => {
      expect(await canWa(s, C.A)).toBe(false);
      for (const t of ["client_whatsapp_groups", "client_whatsapp_groups_public", "client_whatsapp_group_members", "firm_whatsapp_numbers"]) {
        expect(await s.value<number>(`select count(*)::int from ${t}`), t).toBe(0);
      }
      expect((await s.value<{ allowed: boolean }>("select record_whatsapp_group_opened($1)", [C.A])).allowed).toBe(false);
    });
  });

  it("only Partners and Managers write groups", async () => {
    await db.asRole(U.E1, async (s) => {
      expect(await s.exec("update client_whatsapp_groups set name = 'x'")).toBe(0);
      expect((await s.fails("update client_whatsapp_groups_public set name = 'x'")).code).toBe(SQLSTATE.insufficientPrivilege);
      expect((await s.fails("delete from client_whatsapp_groups_public")).code).toBe(SQLSTATE.insufficientPrivilege);
    });
    expect(await db.asRole(U.M1, (s) => s.exec("update client_whatsapp_groups set notes = 'x' where id = $1", [F.waGroup("A")]))).toBe(1);
  });
});

describe("TaxWise Desktop tables (§4.6, §14)", () => {
  it("are readable only by Partners and Managers", async () => {
    for (const user of [U.P1, U.M1]) {
      await db.asRole(user, async (s) => {
        expect(await s.value<number>("select count(*)::int from desktop_devices"), user.key).toBe(1);
        expect(await s.value<number>("select count(*)::int from desktop_device_numbers"), user.key).toBe(1);
      });
    }
    for (const user of [U.E1, U.E3, U.CA, U.X]) {
      await db.asRole(user, async (s) => {
        expect(await s.value<number>("select count(*)::int from desktop_devices"), user.key).toBe(0);
        expect(await s.value<number>("select count(*)::int from desktop_device_numbers"), user.key).toBe(0);
      });
    }
  });

  it("nobody writes them through the API; only a Partner revokes a PC", async () => {
    for (const user of [U.P1, U.M1, U.E1]) {
      await db.asRole(user, async (s) => {
        expect((await s.fails("update desktop_devices set device_name = 'x'")).code).toBe(SQLSTATE.insufficientPrivilege);
        expect((await s.fails("insert into desktop_devices (device_key, device_name) values ('k2', 'n')")).code).toBe(SQLSTATE.insufficientPrivilege);
        expect((await s.fails("delete from desktop_device_numbers")).code).toBe(SQLSTATE.insufficientPrivilege);
      });
    }
    expect(userMessage(await db.asRole(U.M1, (s) => s.fails("select revoke_desktop_device($1)", [F.device])))).toMatch(/Only a Partner/);
    await db.asRole(U.P1, async (s) => {
      expect(await s.value("select revoke_desktop_device($1)", [F.device])).toBe(true);
      expect(await s.value<number>("select count(*)::int from desktop_device_numbers where unlinked_at is null")).toBe(0);
      expect(await s.value("select revoke_desktop_device($1)", [F.device])).toBe(false);
    });
  });
});

describe("Employees' updates are column-limited (§4.6)", () => {
  it("on clients: notes only; owner, name, status and the rest are refused", async () => {
    await db.asRole(U.E1, async (s) => {
      expect(await s.exec("update clients set notes = 'called today' where id = $1", [C.A])).toBe(1);
      for (const set of [`owner_employee_id = '${U.E3.employeeId}'`, "display_name = 'Renamed'", "status = 'inactive'", "portal_user_id = null", "deleted_at = now()"]) {
        const e = await s.fails(`update clients set ${set} where id = $1`, [C.A]);
        expect(e.code, set).toBe(SQLSTATE.raiseException);
        expect(userMessage(e)).toMatch(/You can't change .* on this client/);
      }
      expect(await s.exec("update clients set notes = 'x' where id = $1", [C.B])).toBe(0);
    });
  });

  it("a fee can't be changed: client_services is invisible to Employees and the public view is read-only", async () => {
    await db.asRole(U.E1, async (s) => {
      expect(await s.exec("update client_services set agreed_fee = 1 where client_id = $1", [C.A])).toBe(0);
      expect((await s.fails("update client_services_public set is_active = false")).code).toBe(SQLSTATE.insufficientPrivilege);
      expect((await s.fails("insert into client_services_public (client_id, service_type, frequency) values ($1, 'tds', 'quarterly')", [C.A])).code).toBe(SQLSTATE.insufficientPrivilege);
    });
    expect(await db.asSuper((s) => s.value("select agreed_fee::text from client_services where id = $1", [F.service("A")]))).toBe("5000.00");
  });

  it("client_services_public carries no fee or billing column; client_services is Partner/Manager only", async () => {
    await db.asRole(U.E1, async (s) => {
      const row = (await s.rows<Record<string, unknown>>("select * from client_services_public"))[0];
      expect(Object.keys(row).sort()).toEqual(["client_id", "created_at", "frequency", "id", "is_active", "next_due_date", "service_type", "custom_name", "updated_at"].sort());
      for (const col of ["agreed_fee", "billing_frequency", "auto_invoice", "next_billing_date", "sac_code", "fee_agreed_at"]) {
        expect((await s.fails(`select ${col} from client_services_public`)).message, col).toMatch(/does not exist/);
      }
    });
    expect(await db.asRole(U.M1, (s) => s.value<number>("select count(*)::int from client_services where agreed_fee is not null"))).toBe(3);
  });

  it("on compliance events: workflow status and notes only", async () => {
    await db.asRole(U.E1, async (s) => {
      expect(await s.exec("update compliance_events set workflow_status = 'in_progress', notes = 'n' where client_id = $1", [C.A])).toBe(2);
      expect(userMessage(await s.fails("update compliance_events set due_date = due_date + 30 where client_id = $1", [C.A]))).toMatch(/due date/);
    });
  });

  it("on documents: describing and versioning only; sharing and confidentiality are Partner/Manager decisions", async () => {
    await db.asRole(U.E1, async (s) => {
      expect(await s.exec("update documents set title = 'Renamed' where id = $1", [F.docPrivate("A")])).toBe(1);
      expect(userMessage(await s.fails("update documents set shareable_with_client = true where id = $1", [F.docPrivate("A")]))).toMatch(/shareable with client/);
      expect(userMessage(await s.fails("update documents set is_confidential = true where id = $1", [F.docPrivate("A")]))).toMatch(/is confidential/);
    });
  });
});

describe("files stay in their client's folder (§5.8, §12)", () => {
  it("a document's storage_path must sit in its own client's folder", async () => {
    await db.asRole(U.P1, async (s) => {
      const sql = `insert into documents (client_id, title, file_name, file_size, mime_type, storage_path, uploaded_by) values ($1, 't', 'f.pdf', 1, 'application/pdf', $2, $3)`;
      expect(await s.exec(sql, [C.A, `client-documents/${C.A}/new.pdf`, U.P1.id])).toBe(1);
      expect(await s.exec(sql, [C.A, `${C.A}/new2.pdf`, U.P1.id])).toBe(1);
      for (const path of [`${C.B}/x.pdf`, `client-documents/${C.B}/x.pdf`, `${C.A}/../${C.B}/x.pdf`, "x.pdf", `${C.A}//x.pdf`]) {
        expect((await s.fails(sql, [C.A, path, U.P1.id])).code, path).toBe(SQLSTATE.checkViolation);
      }
      expect((await s.fails("update documents set storage_path = $2 where id = $1", [F.docPrivate("A"), `${C.B}/private.pdf`])).code).toBe(SQLSTATE.checkViolation);
      expect(userMessage(await s.fails(
        "insert into document_versions (document_id, version, file_name, file_size, storage_path, uploaded_by) values ($1, 2, 'f', 1, $2, $3)",
        [F.docPrivate("A"), `client-documents/${C.B}/private.pdf`, U.P1.id],
      ))).toMatch(/its client's folder/);
    });
  });

  it("a portal user can't reach another client's file by registering a document that points at it", async () => {
    await db.asSuper(async (s) => {
      await s.exec("insert into storage.objects (bucket_id, name) values ('client-documents', $1), ('client-documents', $2), ('client-documents', $3)", [
        `${C.B}/private.pdf`, `${C.A}/shared.pdf`, `${C.A}/private.pdf`,
      ]);
      await s.as(U.CA);
      const forged = await s.attempt(
        `insert into documents (client_id, title, file_name, file_size, mime_type, storage_path, uploaded_by, source) values ($1, 'x', 'x.pdf', 10, 'application/pdf', $2, $3, 'client_portal')`,
        [C.A, `${C.B}/private.pdf`, U.CA.id],
      );
      expect(forged.ok).toBe(false);
      // CA reads exactly the shared file of their own client
      expect((await s.rows<{ name: string }>("select name from storage.objects where bucket_id = 'client-documents'")).map((r) => r.name)).toEqual([`${C.A}/shared.pdf`]);
      await s.as(U.E1);
      expect(new Set((await s.rows<{ name: string }>("select name from storage.objects")).map((r) => r.name))).toEqual(new Set([`${C.A}/shared.pdf`, `${C.A}/private.pdf`]));
      await s.as(U.E3);
      expect(await s.rows("select name from storage.objects")).toEqual([]);
    });
  });
});

describe("stored portal credentials (§4.6, §14 'nobody can read credential ciphertext')", () => {
  for (const user of [U.P1, U.P2, U.M1, U.E1, U.CA, U.X]) {
    it(`${user.key} can't select client_credentials at all`, async () => {
      const e = await db.asRole(user, (s) => s.fails("select password_ciphertext from client_credentials"));
      expect(e.code).toBe(SQLSTATE.insufficientPrivilege);
      const e2 = await db.asRole(user, (s) => s.fails("select id from client_credentials"));
      expect(e2.code).toBe(SQLSTATE.insufficientPrivilege);
    });
  }

  it("the list view never has the ciphertext, and shows staff only their visible clients' logins", async () => {
    await db.asRole(U.P1, async (s) => {
      expect((await s.fails("select password_ciphertext from client_credentials_list")).message).toMatch(/does not exist/);
      expect(await s.value<number>("select count(*)::int from client_credentials_list")).toBe(3);
    });
    expect(await db.asRole(U.E1, (s) => s.rows("select id from client_credentials_list"))).toEqual([{ id: F.credential("A") }]);
    expect(await db.asRole(U.CA, (s) => s.value<number>("select count(*)::int from client_credentials_list"))).toBe(0);
  });

  it("no function hands the ciphertext back, and only Partners/Managers save or delete logins", async () => {
    await db.asRole(U.M1, async (s) => {
      const id = await s.value<string>("select save_client_credential(null, $1, 'MCA', null, 'mca_user', 'v1:a.b.c')", [C.A]);
      expect(id).toMatch(/[0-9a-f-]{36}/);
      expect(await s.value<number>("select count(*)::int from credential_access_logs where credential_id = $1 and action = 'created'", [id])).toBe(1);
      expect(await s.value("select delete_client_credential($1)", [id])).toBe(true);
    });
    await db.asRole(U.E1, async (s) => {
      expect(userMessage(await s.fails("select save_client_credential(null, $1, 'MCA', null, 'u', 'v1:a.b.c')", [C.A]))).toMatch(/Only Partners and Managers/);
      expect(userMessage(await s.fails("select delete_client_credential($1)", [F.credential("A")]))).toMatch(/Only Partners and Managers/);
      expect((await s.fails("delete from client_credentials_list")).code).toBe(SQLSTATE.insufficientPrivilege);
    });
    // nothing in the schema returns the ciphertext column to API roles
    const leaks = await db.asSuper((s) =>
      s.rows(
        `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute')
           and p.prosrc ilike '%password_ciphertext%' and p.proname not in ('save_client_credential')`,
      ),
    );
    expect(leaks).toEqual([]);
  });
});

describe("portal isolation (§7.22, §14 'a client can never read another client's data')", () => {
  const pairs = [
    [U.CA, C.A, C.B],
    [U.CB, C.B, C.A],
  ] as const;

  for (const [user, own, other] of pairs) {
    it(`${user.key} sees only its own client in every portal surface`, async () => {
      await db.asRole(user, async (s) => {
        expect((await s.rows<{ id: string }>("select id from portal_my_client")).map((r) => r.id)).toEqual([own]);
        for (const t of ["portal_invoices", "portal_payment_claims", "portal_compliance_events", "portal_filing_records", "portal_messages", "documents", "document_requests", "messages"]) {
          const ids = new Set((await s.rows<{ client_id: string }>(`select client_id from ${t}`)).map((r) => r.client_id));
          expect(ids, t).toEqual(new Set([own]));
        }
        // Since 0175 the portal reads compliance only through its views; the base tables show nothing.
        expect(await s.value<number>("select count(*)::int from compliance_events")).toBe(0);
        expect(await s.value<number>("select count(*)::int from filing_records")).toBe(0);
        expect(await s.value<number>("select count(*)::int from portal_payment_receipts r join portal_invoices i on i.id = r.invoice_id where i.client_id = $1", [other])).toBe(0);
        expect(await s.value<boolean>("select can_see_client($1)", [other])).toBe(false);
        expect(await s.value<boolean>("select can_see_client($1)", [own])).toBe(true);
      });
    });
  }

  it("portal users get only what the firm shares: statutory deadlines, shareable filings and documents, the portal channel", async () => {
    await db.asSuper(async (s) => {
      // Attach an acknowledgement to both of A's filings: only the shareable one may download.
      await s.exec("update filing_records set document_id = $2 where client_id = $1 and shareable_with_client", [C.A, F.docShared("A")]);
      await s.exec("update filing_records set document_id = $2 where client_id = $1 and not shareable_with_client", [C.A, F.docPrivate("A")]);
      await s.as(U.CA);
      // Statutory deadlines only: the firm's internal follow-up never reaches the portal.
      expect(await s.value<number>("select count(*)::int from portal_compliance_events where id = $1", [fid("ce:A:ops")])).toBe(0);
      expect((await s.rows<{ id: string }>("select id from portal_compliance_events")).map((r) => r.id)).toEqual([fid("ce:A:stat")]);
      // Every filing shows (form, period, acknowledgement number); the document only when shareable.
      const filings = await s.rows<{ filing_type: string; acknowledgement_document_id: string | null }>(
        "select filing_type, acknowledgement_document_id from portal_filing_records order by filing_type",
      );
      expect(filings).toEqual([
        { filing_type: "GSTR-1", acknowledgement_document_id: null },
        { filing_type: "GSTR-3B", acknowledgement_document_id: F.docShared("A") },
      ]);
      expect((await s.rows<{ id: string }>("select id from documents")).map((r) => r.id)).toEqual([F.docShared("A")]);
      expect(await s.rows("select channel::text from messages")).toEqual([{ channel: "portal" }]);
      expect((await s.rows<{ id: string }>("select id from portal_messages")).map((r) => r.id)).toEqual([fid("msg:A:portal")]);
      expect(await s.value<number>("select count(*)::int from clients")).toBe(0); // internal notes stay internal
      expect(await s.value<number>("select count(*)::int from client_timeline_events")).toBe(0);
      expect(await s.value<number>("select count(*)::int from tasks")).toBe(0);
      expect(await s.value<number>("select count(*)::int from client_contacts")).toBe(0);
    });
  });

  it("portal invoices exclude drafts and show portal-safe columns only", async () => {
    await db.asRole(U.CA, async (s) => {
      const rows = await s.rows<Record<string, unknown>>("select * from portal_invoices");
      expect(rows.map((r) => r.id)).toEqual([F.invoiceSent("A")]);
      for (const col of ["created_by", "approved_by", "approval_note", "waived_reason", "disputed_reason", "cancel_reason", "source_task_id", "client_service_id", "deleted_at"]) {
        expect(Object.keys(rows[0]), col).not.toContain(col);
      }
    });
  });

  it("a portal user can't write into another client's records", async () => {
    await db.asRole(U.CA, async (s) => {
      const msg = await s.attempt("insert into messages (client_id, channel, direction, body, status, sent_by) values ($1, 'portal', 'inbound', 'hi', 'sent', $2)", [C.B, U.CA.id]);
      expect(msg.ok).toBe(false);
      expect(await s.exec("insert into messages (client_id, channel, direction, body, status, sent_by) values ($1, 'portal', 'inbound', 'hi', 'sent', $2)", [C.A, U.CA.id])).toBe(1);
      const claim = await s.attempt("insert into portal_payment_claims (invoice_id, client_id, created_by) values ($1, $2, $3)", [F.invoiceSent("B"), C.B, U.CA.id]);
      expect(claim.ok).toBe(false);
      const crossClaim = await s.attempt("insert into portal_payment_claims (invoice_id, client_id, created_by) values ($1, $2, $3)", [F.invoiceSent("B"), C.A, U.CA.id]);
      expect(crossClaim.ok).toBe(false);
      expect(await s.exec("update document_request_items set status = 'uploaded' where request_id in (select id from document_requests where client_id = $1)", [C.B])).toBe(0);
      expect(await s.exec("update messages set read_at = now() where client_id = $1", [C.B])).toBe(0);
    });
  });
});
