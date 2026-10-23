/**
 * Client 360 (§7.3.3, §4.7, §5.3, §6.6, §6.8, §6.10, §7.22): migration 0115 — exactly one primary
 * contact (the guard trigger and set_primary_contact), the owner and engagement team in one
 * transaction (set_client_team with its signature check), the Partner-only tax-audit decision, the
 * portal revoked marker, the cover chip every viewer of the client gets (client_cover_badges), and
 * the KYC guards (never a full Aadhaar number).
 */
import { describe, expect, it } from "vitest";
import { C, SQLSTATE, U, fid, setupTestDatabase, userMessage, type Session } from "./helpers";

const db = setupTestDatabase("client360");

const CONTACT_A = fid("contact:A");

async function primaries(s: Session, clientId: string): Promise<string[]> {
  const rows = await s.rows<{ id: string }>("select id from client_contacts where client_id = $1 and is_primary order by id", [clientId]);
  return rows.map((r) => r.id);
}

async function addContact(s: Session, clientId: string, name: string, primary = false): Promise<string> {
  return s.value<string>("insert into client_contacts (client_id, name, is_primary) values ($1, $2, $3) returning id", [clientId, name, primary]);
}

// -------------------------------------------------------------------------------------------------
// Primary contact (§5.3 "one primary per client"; §7.3.3 "primary (exactly one)")
// -------------------------------------------------------------------------------------------------

describe("primary contact", () => {
  it("makes the first contact primary and keeps exactly one", async () => {
    await db.asRole(U.M1, async (s) => {
      expect(await primaries(s, C.A)).toEqual([CONTACT_A]);
      const second = await addContact(s, C.A, "Second contact");
      expect(await primaries(s, C.A)).toEqual([CONTACT_A]);

      const r = await s.value<{ changed: boolean; previous_id: string }>("select set_primary_contact($1)", [second]);
      expect(r.changed).toBe(true);
      expect(r.previous_id).toBe(CONTACT_A);
      expect(await primaries(s, C.A)).toEqual([second]);

      // Calling it again is a no-op.
      const again = await s.value<{ changed: boolean }>("select set_primary_contact($1)", [second]);
      expect(again.changed).toBe(false);
    });
  });

  it("a new primary contact demotes the old one in the same statement", async () => {
    await db.asRole(U.P1, async (s) => {
      const fresh = await addContact(s, C.B, "New director", true);
      expect(await primaries(s, C.B)).toEqual([fresh]);
    });
  });

  it("the primary can't simply be unset, and a contact never moves to another client", async () => {
    await db.asRole(U.M1, async (s) => {
      const e = await s.fails("update client_contacts set is_primary = false where id = $1", [CONTACT_A]);
      expect(e.code).toBe(SQLSTATE.raiseException);
      expect(userMessage(e)).toMatch(/needs one primary contact/);

      const moved = await s.fails("update client_contacts set client_id = $1 where id = $2", [C.B, CONTACT_A]);
      expect(userMessage(moved)).toMatch(/can't be moved to another client/);
    });
  });

  it("deleting the primary promotes the oldest remaining contact; deleting the last leaves none", async () => {
    await db.asRole(U.M1, async (s) => {
      // One transaction has one now(), so the ages are set explicitly.
      const second = await s.value<string>("insert into client_contacts (client_id, name, created_at) values ($1, 'Older remaining', now() - interval '2 days') returning id", [C.C]);
      await s.value<string>("insert into client_contacts (client_id, name, created_at) values ($1, 'Newest', now() - interval '1 day') returning id", [C.C]);
      await s.exec("delete from client_contacts where id = $1", [fid("contact:C")]);
      expect(await primaries(s, C.C)).toEqual([second]);

      await s.exec("delete from client_contacts where client_id = $1", [C.C]);
      expect(await s.value<number>("select count(*)::int from client_contacts where client_id = $1", [C.C])).toBe(0);
    });
  });

  it("refuses a stale contact and anyone but a Partner or Manager", async () => {
    await db.asRole(U.M1, async (s) => {
      const second = await addContact(s, C.A, "Stale target");
      const e = await s.fails("select set_primary_contact($1, $2)", [second, "2020-01-01T00:00:00Z"]);
      expect(userMessage(e)).toMatch(/changed by someone else/);
    });
    await db.asRole(U.E1, async (s) => {
      const e = await s.fails("select set_primary_contact($1)", [CONTACT_A]);
      expect(userMessage(e)).toMatch(/Only Partners and Managers/);
      // Employees can't add contacts at all (RLS).
      const ins = await s.fails("insert into client_contacts (client_id, name) values ($1, 'Sneaky')", [C.A]);
      expect(ins.code).toBe(SQLSTATE.insufficientPrivilege);
    });
  });

  it("deleting the client (purge) cascades without tripping the guard", async () => {
    await db.asSuper(async (s) => {
      await addContact(s, C.Z, "Zeta one");
      await addContact(s, C.Z, "Zeta two");
      expect(await s.exec("delete from clients where id = $1", [C.Z])).toBe(1);
    });
  });
});

// -------------------------------------------------------------------------------------------------
// Owner and engagement team (§5.3, §7.3.3 Team)
// -------------------------------------------------------------------------------------------------

describe("set_client_team", () => {
  const callTeam = (s: Session, args: { owner: string | null; ep?: string | null; rm?: string | null; preparers?: string[]; signature?: string | null; client?: string }) =>
    s.attempt<{ set_client_team: { added: Array<{ employee_id: string; team_role: string }>; removed: Array<{ employee_id: string; team_role: string }>; owner_changed: boolean; signature: string } }>(
      "select set_client_team($1, $2, $3, $4, $5::uuid[], $6)",
      [args.client ?? C.A, args.owner, args.ep ?? null, args.rm ?? null, args.preparers ?? [], args.signature ?? null],
    );

  it("sets owner, engagement partner, review manager and preparers in one go", async () => {
    await db.asRole(U.M1, async (s) => {
      const before = await s.value<string>("select client_team_signature($1)", [C.A]);
      expect(before).toBe(`owner:${U.E1.employeeId};preparer:${U.D.employeeId}`);

      const r = await callTeam(s, { owner: U.E4.employeeId!, ep: U.P1.employeeId, rm: U.M2.employeeId, preparers: [U.E1.employeeId!, U.E1.employeeId!], signature: before });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const out = r.rows[0].set_client_team;
      expect(out.owner_changed).toBe(true);
      expect(out.removed).toEqual([{ employee_id: U.D.employeeId, team_role: "preparer" }]);
      expect(out.added.map((a) => a.team_role).sort()).toEqual(["engagement_partner", "preparer", "review_manager"]);

      const team = await s.rows<{ employee_id: string; team_role: string }>(
        "select employee_id, team_role::text from client_team_members where client_id = $1 order by team_role::text, employee_id",
        [C.A],
      );
      expect(team).toEqual(
        [
          { employee_id: U.P1.employeeId, team_role: "engagement_partner" },
          { employee_id: U.E1.employeeId, team_role: "preparer" },
          { employee_id: U.M2.employeeId, team_role: "review_manager" },
        ].sort((a, b) => (a.team_role === b.team_role ? 0 : a.team_role < b.team_role ? -1 : 1)),
      );
      expect(await s.value<string>("select owner_employee_id from clients where id = $1", [C.A])).toBe(U.E4.employeeId);
      expect(out.signature).toBe(await s.value<string>("select client_team_signature($1)", [C.A]));
    });
  });

  it("checks the roles, active people and a stale signature", async () => {
    await db.asRole(U.P1, async (s) => {
      const notPartner = await callTeam(s, { owner: U.E1.employeeId!, ep: U.M1.employeeId });
      expect(notPartner.ok || userMessage(notPartner)).toMatch(/engagement partner must be a Partner/);

      const notManager = await callTeam(s, { owner: U.E1.employeeId!, rm: U.E2.employeeId });
      expect(notManager.ok || userMessage(notManager)).toMatch(/review manager must be a Partner or a Manager/);

      const disabled = await callTeam(s, { owner: U.E1.employeeId!, preparers: [U.D.employeeId!] });
      expect(disabled.ok || userMessage(disabled)).toMatch(/active member/);

      const noOwner = await callTeam(s, { owner: null });
      expect(noOwner.ok || userMessage(noOwner)).toMatch(/Choose the client owner/);

      const stale = await callTeam(s, { owner: U.E1.employeeId!, signature: "owner:;" });
      expect(stale.ok || userMessage(stale)).toMatch(/Someone else changed this client's team/);

      const deleted = await callTeam(s, { client: C.Z, owner: U.E1.employeeId! });
      expect(deleted.ok || userMessage(deleted)).toMatch(/recycle bin/);
    });
  });

  it("Employees can't change a team, even on their own client", async () => {
    await db.asRole(U.E1, async (s) => {
      const r = await callTeam(s, { owner: U.E1.employeeId! });
      expect(r.ok || userMessage(r)).toMatch(/Only Partners and Managers/);
    });
  });
});

// -------------------------------------------------------------------------------------------------
// The partner's tax-audit decision (§6.6) and the portal revoked marker (§7.22)
// -------------------------------------------------------------------------------------------------

describe("tax-audit decision", () => {
  it("only a Partner changes it, and who and when are stamped", async () => {
    await db.asRole(U.M1, async (s) => {
      const e = await s.fails("update clients set tax_audit_applicable = 'yes' where id = $1", [C.A]);
      expect(userMessage(e)).toMatch(/Only a Partner can record the tax-audit decision/);
      // Other edits by a Manager are untouched by the guard.
      expect(await s.exec("update clients set city = 'Mysuru' where id = $1", [C.A])).toBe(1);
    });
    await db.asRole(U.P1, async (s) => {
      expect(await s.exec("update clients set tax_audit_applicable = 'review', tax_audit_note = 'Cash share unclear' where id = $1", [C.A])).toBe(1);
      const row = await s.one<{ by: string; at: string | null }>("select tax_audit_decided_by as by, tax_audit_decided_at::text as at from clients where id = $1", [C.A]);
      expect(row.by).toBe(U.P1.id);
      expect(row.at).not.toBeNull();
      // The stamps can't be set by hand.
      await s.exec("update clients set tax_audit_decided_by = $2 where id = $1", [C.A, U.P2.id]);
      expect(await s.value<string>("select tax_audit_decided_by from clients where id = $1", [C.A])).toBe(U.P1.id);
    });
  });

  it("an Employee still edits only notes", async () => {
    await db.asRole(U.E1, async (s) => {
      expect(await s.exec("update clients set notes = 'Prefers calls after 4 pm' where id = $1", [C.A])).toBe(1);
      const e = await s.fails("update clients set tax_audit_applicable = 'no' where id = $1", [C.A]);
      expect(e.code).toBe(SQLSTATE.raiseException);
    });
  });

  it("linking a portal login again clears the revoked marker", async () => {
    await db.asSuper(async (s) => {
      await s.exec("update clients set portal_user_id = null, portal_revoked_at = now(), portal_revoked_by = $2, portal_revoked_user_id = $3 where id = $1", [C.A, U.P1.id, U.CA.id]);
      expect(await s.value<string | null>("select portal_revoked_at::text from clients where id = $1", [C.A])).not.toBeNull();
      await s.exec("update clients set portal_user_id = $2 where id = $1", [C.A, U.CA.id]);
      const row = await s.one<{ at: string | null; by: string | null; old: string | null }>(
        "select portal_revoked_at::text as at, portal_revoked_by as by, portal_revoked_user_id as old from clients where id = $1",
        [C.A],
      );
      expect(row).toEqual({ at: null, by: null, old: null });
    });
  });
});

// -------------------------------------------------------------------------------------------------
// Cover chip (§4.7 "The client header shows the same chip to everyone")
// -------------------------------------------------------------------------------------------------

describe("client_cover_badges", () => {
  it("shows a person cover for the owner to everyone who can see the client; the handover note only to the cover person and managers", async () => {
    const coverId = await db.commitAsSuper((s) =>
      s.value<string>(
        `insert into client_covers (kind, absent_employee_id, cover_employee_id, ends_at, reason, granted_by, handover_note)
         values ('person', $1, $2, now() + interval '2 days', 'leave', $3, 'GSTR-3B data is with the accountant') returning id`,
        [U.E1.employeeId, U.E2.employeeId, U.P1.id],
      ),
    );
    try {
      type Badge = { cover_id: string; kind: string; cover_name: string; absent_name: string; handover_note: string | null };
      const badges = (s: Session) => s.rows<Badge>("select * from client_cover_badges($1)", [C.A]);

      await db.asRole(U.E2, async (s) => {
        const b = await badges(s);
        expect(b.map((x) => x.cover_id)).toContain(coverId);
        expect(b.find((x) => x.cover_id === coverId)?.handover_note).toBe("GSTR-3B data is with the accountant");
      });
      await db.asRole(U.E1, async (s) => {
        const b = (await badges(s)).find((x) => x.cover_id === coverId);
        expect(b?.absent_name).toBe("Test E1");
        expect(b?.cover_name).toBe("Test E2");
        expect(b?.handover_note).toBeNull();
      });
      await db.asRole(U.M1, async (s) => {
        expect((await badges(s)).find((x) => x.cover_id === coverId)?.handover_note).toBe("GSTR-3B data is with the accountant");
      });
      // Someone who can't see client A gets nothing; neither does a portal user.
      await db.asRole(U.E4, async (s) => expect(await badges(s)).toEqual([]));
      await db.asRole(U.CA, async (s) => expect(await badges(s)).toEqual([]));
      // The expired fixture cover never shows.
      await db.asRole(U.M1, async (s) => {
        const ids = (await badges(s)).map((x) => x.cover_id);
        expect(ids).not.toContain(fid("cover:expired"));
      });
    } finally {
      await db.commitAsSuper((s) => s.exec("delete from client_covers where id = $1", [coverId]));
    }
  });

  it("a client cover defaults its absent person to the client's owner", async () => {
    await db.asRole(U.P1, async (s) => {
      await s.exec(
        `insert into client_covers (kind, client_id, cover_employee_id, ends_at, reason, granted_by) values ('client', $1, $2, now() + interval '1 day', 'workload', $3)`,
        [C.B, U.E3.employeeId, U.P1.id],
      );
      const rows = await s.rows<{ kind: string; absent_employee_id: string; absent_name: string }>("select kind::text, absent_employee_id, absent_name from client_cover_badges($1)", [C.B]);
      expect(rows).toEqual([{ kind: "client", absent_employee_id: U.E4.employeeId, absent_name: "Test E4" }]);
    });
  });
});

// -------------------------------------------------------------------------------------------------
// KYC (§6.8, §6.10)
// -------------------------------------------------------------------------------------------------

describe("client_kyc guards", () => {
  it("refuses a full Aadhaar number anywhere and keeps principal persons a list", async () => {
    await db.asRole(U.M1, async (s) => {
      const persons = (aadhaar: string) => JSON.stringify([{ name: "R Sharma", address: "Bengaluru", din: "01234567", aadhaar_last4: aadhaar }]);
      expect(await s.exec("update client_kyc set principal_persons = $2::jsonb where client_id = $1", [C.A, persons("4321")])).toBe(1);

      const full = await s.fails("update client_kyc set principal_persons = $2::jsonb where client_id = $1", [C.A, persons("2345 6789 0123")]);
      expect(userMessage(full)).toMatch(/full Aadhaar number/);
      const inText = await s.fails("update client_kyc set business_description = 'Aadhaar 234567890123 on file' where client_id = $1", [C.A]);
      expect(userMessage(inText)).toMatch(/full Aadhaar number/);

      const notList = await s.fails(`update client_kyc set principal_persons = '{"name": "x"}'::jsonb where client_id = $1`, [C.A]);
      expect(notList.code).toBe(SQLSTATE.checkViolation);
    });
    await db.asRole(U.E1, async (s) => {
      // Employees read KYC for their clients but never write it.
      expect(await s.value<number>("select count(*)::int from client_kyc where client_id = $1", [C.A])).toBe(1);
      expect(await s.exec("update client_kyc set business_description = 'x' where client_id = $1", [C.A])).toBe(0);
    });
  });

  it("contains_full_aadhaar mirrors the TS validator", async () => {
    await db.asRole(U.M1, async (s) => {
      const check = (t: string) => s.value<boolean>("select contains_full_aadhaar($1)", [t]);
      expect(await check("2345 6789 0123")).toBe(true);
      expect(await check("2345-6789-0123")).toBe(true);
      expect(await check("XXXX XXXX 0123")).toBe(false);
      expect(await check("1234 5678 9012")).toBe(false); // can't start with 0 or 1
      expect(await check("DIN 01234567")).toBe(false);
      expect(await check("ref 23456789012345")).toBe(false); // part of a longer run of digits
    });
  });
});
