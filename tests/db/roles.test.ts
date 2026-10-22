/**
 * Roles come from the JWT's app_metadata AND a matching active profile; user_metadata grants
 * nothing and is reported (§0.1 rule 9, §4.4, §4.6, §14 "editing user_metadata.role grants
 * nothing"). Also the profile self-edit guard (§4.4, §4.5).
 */
import { describe, expect, it } from "vitest";
import { C, SQLSTATE, U, setupTestDatabase, userMessage } from "./helpers";

const db = setupTestDatabase("roles");

type Helpers = {
  app_role: string | null;
  is_partner: boolean;
  is_manager_or_partner: boolean;
  is_staff: boolean;
  is_client: boolean;
  my_employee_id: string | null;
};

const HELPERS_SQL = `select app_role()::text as app_role, is_partner(), is_manager_or_partner(), is_staff(), is_client(), my_employee_id()`;

describe("app_role() and the role helpers (§4.6)", () => {
  it("returns each role when app_metadata and an active profile agree", async () => {
    const cases = [
      [U.P1, "partner", true, true, true, false],
      [U.M1, "manager", false, true, true, false],
      [U.E1, "employee", false, false, true, false],
      [U.CA, "client", false, false, false, true],
    ] as const;
    for (const [user, role, partner, mgr, staff, client] of cases) {
      const h = await db.asRole(user, (s) => s.one<Helpers>(HELPERS_SQL));
      expect(h, user.key).toEqual({
        app_role: role,
        is_partner: partner,
        is_manager_or_partner: mgr,
        is_staff: staff,
        is_client: client,
        my_employee_id: user.employeeId,
      });
    }
  });

  it("is null when app_metadata.role disagrees with profiles.role (X: JWT partner, profile employee)", async () => {
    const h = await db.asRole(U.X, (s) => s.one<Helpers>(HELPERS_SQL));
    expect(h).toMatchObject({ app_role: null, is_partner: false, is_manager_or_partner: false, is_staff: false, is_client: false });
  });

  it("the mismatched user gets no Partner power: no money, no people, no audit log, no other clients", async () => {
    await db.asRole(U.X, async (s) => {
      for (const t of ["invoices", "payment_receipts", "quotations", "leads", "audit_logs", "clients", "tasks", "client_services_public"]) {
        expect(await s.value<number>(`select count(*)::int from ${t}`), t).toBe(0);
      }
      expect(await s.value<number>("select count(*)::int from employees")).toBe(1); // their own row only
      expect(await s.value<number>("select count(*)::int from profiles")).toBe(1);
      const e = await s.fails("select next_document_number('invoice')");
      expect(userMessage(e)).toMatch(/permission to take a document number/);
    });
  });

  it("once app_metadata is repaired to the profile's role, X gets exactly Employee access", async () => {
    await db.asRole(
      U.X,
      async (s) => {
        expect(await s.value("select app_role()::text")).toBe("employee");
        expect((await s.rows<{ id: string }>("select id from clients")).map((r) => r.id)).toEqual([C.C]); // on C's team
        expect(await s.value<number>("select count(*)::int from invoices")).toBe(0);
        expect(await s.value<number>("select count(*)::int from audit_logs")).toBe(0);
      },
      { appRole: "employee" },
    );
  });

  it("a stale app_metadata role of 'partner' never wins over profiles.role, for any profile role", async () => {
    for (const user of [U.M1, U.E1, U.CA]) {
      const h = await db.asRole(user, (s) => s.one<Helpers>(HELPERS_SQL), { appRole: "partner" });
      expect(h.app_role, user.key).toBeNull();
      expect(h.is_partner, user.key).toBe(false);
    }
  });

  it("is null for a disabled profile (D), and for a JWT with no app_metadata role", async () => {
    expect((await db.asRole(U.D, (s) => s.one<Helpers>(HELPERS_SQL))).app_role).toBeNull();
    expect((await db.asRole(U.E1, (s) => s.one<Helpers>(HELPERS_SQL), { appRole: null })).app_role).toBeNull();
  });

  it("is null for a signed-in user with no profile row", async () => {
    await db.asSuper(async (s) => {
      const ghost = { ...U.P1, id: "00000000-0000-4000-8000-00000000dead", email: "ghost@taxwise.test" };
      await s.exec("insert into auth.users (id, email, raw_app_meta_data) values ($1, $2, '{\"role\":\"partner\"}')", [ghost.id, ghost.email]);
      await s.as(ghost);
      expect(await s.value("select app_role()::text")).toBeNull();
      expect(await s.value<number>("select count(*)::int from firm_settings")).toBe(0);
    });
  });

  it("a disabled Partner loses Partner access at once", async () => {
    await db.asSuper(async (s) => {
      await s.exec("update profiles set is_active = false where id = $1", [U.P2.id]);
      await s.as(U.P2);
      expect(await s.value("select app_role()::text")).toBeNull();
      expect(await s.value<number>("select count(*)::int from invoices")).toBe(0);
    });
  });
});

describe("user_metadata.role grants nothing (§0.1 rule 9, §14)", () => {
  it("a portal user claiming 'partner' in user_metadata (CB) gets only client access", async () => {
    await db.asRole(U.CB, async (s) => {
      expect(await s.value("select app_role()::text")).toBe("client");
      expect(await s.value("select is_partner()")).toBe(false);
      expect(await s.value<number>("select count(*)::int from invoices")).toBe(0);
      expect(await s.value<number>("select count(*)::int from clients")).toBe(0);
      expect(await s.value<number>("select count(*)::int from audit_logs")).toBe(0);
      expect(await s.value<number>("select count(*)::int from firm_settings")).toBe(0);
      expect((await s.rows<{ id: string }>("select id from portal_my_client")).map((r) => r.id)).toEqual([C.B]);
      expect(new Set((await s.rows<{ client_id: string }>("select client_id from portal_invoices")).map((r) => r.client_id))).toEqual(new Set([C.B]));
    });
  });

  it("it doesn't matter where the claim sits: JWT user_metadata role/app_role/is_admin are all ignored", async () => {
    for (const meta of [{ role: "partner" }, { app_role: "partner" }, { role: "partner", is_admin: true, app_metadata: { role: "partner" } }]) {
      const h = await db.asRole(U.E1, (s) => s.one<Helpers>(HELPERS_SQL), { userMetadata: meta });
      expect(h.app_role).toBe("employee");
      expect(h.is_partner).toBe(false);
      expect(await db.asRole(U.E1, (s) => s.value<number>("select count(*)::int from invoices"), { userMetadata: meta })).toBe(0);
    }
  });

  it("a client whose JWT app_metadata were forged to 'partner' still gets nothing (profile says client)", async () => {
    await db.asRole(
      U.CA,
      async (s) => {
        expect(await s.value("select app_role()::text")).toBeNull();
        expect(await s.value<number>("select count(*)::int from invoices")).toBe(0);
        expect(await s.value<number>("select count(*)::int from portal_invoices")).toBe(0);
      },
      { appRole: "partner" },
    );
  });
});

describe("report_role_claim() (§4.4)", () => {
  it("writes one access_denied audit row and one security_alert per active Partner, once per day", async () => {
    await db.asSuper(async (s) => {
      const partners = await s.value<number>("select count(*)::int from profiles where role = 'partner' and is_active");
      await s.as(U.CB);
      expect(await s.value("select report_role_claim()")).toBe(true);
      expect(await s.value("select report_role_claim()")).toBe(false); // same IST day: nothing new
      await s.as("super");
      const audit = await s.rows<{ event: string; user_id: string; user_role: string; action: string; success: boolean; details: { claimed_role: string } }>(
        "select event::text, user_id, user_role, action, success, details from audit_logs where action = 'role_claim.ignored'",
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ event: "access_denied", user_id: U.CB.id, user_role: "client", success: false });
      expect(audit[0].details.claimed_role).toBe("partner");
      const alerts = await s.rows<{ user_id: string; link_url: string }>(
        "select user_id, link_url from notifications where type = 'security_alert'",
      );
      expect(alerts).toHaveLength(partners);
      expect(new Set(alerts.map((a) => a.user_id))).toEqual(new Set([U.P1.id, U.P2.id]));
      expect(alerts.every((a) => a.link_url.startsWith("/audit-log"))).toBe(true);
      // the claim itself changed nothing
      await s.as(U.CB);
      expect(await s.value("select app_role()::text")).toBe("client");
    });
  });

  it("reports again on a later day", async () => {
    await db.asSuper(async (s) => {
      await s.as(U.CB);
      expect(await s.value("select report_role_claim()")).toBe(true);
      await s.as("super");
      await s.exec("alter table audit_logs disable trigger audit_logs_immutable");
      await s.exec("update audit_logs set at = at - interval '1 day' where action = 'role_claim.ignored'");
      await s.exec("alter table audit_logs enable trigger audit_logs_immutable");
      await s.as(U.CB);
      expect(await s.value("select report_role_claim()")).toBe(true);
      await s.as("super");
      expect(await s.value<number>("select count(*)::int from audit_logs where action = 'role_claim.ignored'")).toBe(2);
    });
  });

  it("does nothing for a user without a role claim", async () => {
    await db.asSuper(async (s) => {
      await s.as(U.E1);
      expect(await s.value("select report_role_claim()")).toBe(false);
      await s.as("super");
      expect(await s.value<number>("select count(*)::int from audit_logs where action = 'role_claim.ignored'")).toBe(0);
      expect(await s.value<number>("select count(*)::int from notifications where type = 'security_alert'")).toBe(0);
    });
  });

  it("nobody can forge a security_alert themselves", async () => {
    for (const user of [U.P1, U.E1, U.CA]) {
      const e = await db.asRole(user, (s) =>
        s.fails(
          "insert into notifications (user_id, type, title, body, link_url) values ($1, 'security_alert', 'x', 'y', '/inbox')",
          [U.P1.id],
        ),
      );
      expect(e.code, user.key).toBe(SQLSTATE.insufficientPrivilege);
    }
  });

  it("anon can't call it", async () => {
    const e = await db.asAnon((s) => s.fails("select report_role_claim()"));
    expect(e.code).toBe(SQLSTATE.insufficientPrivilege);
  });
});

describe("profiles: nobody changes their own role, access or forced-password flag (§4.4, §4.5)", () => {
  for (const user of [U.P1, U.M1, U.E1, U.CA]) {
    it(`${user.key} can edit their name and preferences but not role / is_active / must_change_password / email`, async () => {
      await db.asRole(user, async (s) => {
        expect(await s.exec("update profiles set full_name = 'New name', phone = '9999', preferences = '{\"theme\":\"dark\"}' where id = $1", [user.id])).toBe(1);
        for (const set of ["role = (case when role = 'partner' then 'employee' else 'partner' end)::app_role", "is_active = false", "must_change_password = true", "email = 'other@taxwise.test'"]) {
          const e = await s.fails(`update profiles set ${set} where id = $1`, [user.id]);
          expect(e.code, set).toBe(SQLSTATE.raiseException);
          expect(userMessage(e)).toMatch(/managed by a Partner/);
        }
      });
    });
  }

  it("a user can't edit someone else's profile", async () => {
    await db.asRole(U.E1, async (s) => {
      expect(await s.exec("update profiles set full_name = 'x' where id = $1", [U.E2.id])).toBe(0);
    });
    await db.asRole(U.CA, async (s) => {
      expect(await s.exec("update profiles set full_name = 'x' where id = $1", [U.CB.id])).toBe(0);
    });
  });

  it("a Partner changes another staff member's role; never to client", async () => {
    await db.asRole(U.P1, async (s) => {
      expect(await s.exec("update profiles set role = 'manager' where id = $1", [U.E3.id])).toBe(1);
      const e = await s.fails("update profiles set role = 'client' where id = $1", [U.E4.id]);
      expect(e.code).toBe(SQLSTATE.insufficientPrivilege);
    });
  });

  it("a Manager manages Employees' profiles but can't promote anyone or touch Partners/Managers", async () => {
    await db.asRole(U.M1, async (s) => {
      expect(await s.exec("update profiles set is_active = false where id = $1", [U.E3.id])).toBe(1);
      const e = await s.fails("update profiles set role = 'partner' where id = $1", [U.E4.id]);
      expect(e.code).toBe(SQLSTATE.insufficientPrivilege);
      expect(await s.exec("update profiles set is_active = false where id = $1", [U.P1.id])).toBe(0);
      expect(await s.exec("update profiles set full_name = 'x' where id = $1", [U.M2.id])).toBe(0);
    });
  });

  it("no one creates or deletes profiles through the API", async () => {
    for (const user of [U.P1, U.M1, U.E1]) {
      await db.asRole(user, async (s) => {
        const ins = await s.attempt("insert into profiles (id, full_name, email, role) values ($1, 'x', 'x@x.test', 'partner')", [U.P1.id]);
        expect(ins.ok).toBe(false);
        expect(await s.exec("delete from profiles where id = $1", [U.E4.id])).toBe(0);
      });
    }
  });

  it("Employees and clients see only their own profile; staff profiles are visible to Partners/Managers", async () => {
    expect(await db.asRole(U.E1, (s) => s.value<number>("select count(*)::int from profiles"))).toBe(1);
    expect(await db.asRole(U.CA, (s) => s.value<number>("select count(*)::int from profiles"))).toBe(1);
    const staff = await db.asSuper((s) => s.value<number>("select count(*)::int from profiles where role <> 'client'"));
    expect(await db.asRole(U.M1, (s) => s.value<number>("select count(*)::int from profiles"))).toBe(staff);
  });
});

describe("employees: column and row limits (§4.5, §5.2)", () => {
  it("Employees read their own row and the colleague directory only", async () => {
    await db.asRole(U.E1, async (s) => {
      expect(await s.rows("select id from employees")).toEqual([{ id: U.E1.employeeId }]);
      const dir = await s.rows<{ id: string }>("select * from employee_directory");
      expect(dir.length).toBeGreaterThan(5);
      expect(Object.keys((await s.rows("select * from employee_directory limit 1"))[0]).sort()).toEqual(
        ["avatar_path", "designation", "full_name", "id", "is_active", "profile_id"].sort(),
      );
    });
  });

  it("Managers can't grant vault access, set cost rates, change roles or delete people", async () => {
    await db.asRole(U.M1, async (s) => {
      expect(await s.exec("update employees set designation = 'Senior' where id = $1", [U.E3.employeeId])).toBe(1);
      for (const set of ["vault_access = true", "cost_rate_per_hour = 1", "deleted_at = now()"]) {
        const e = await s.fails(`update employees set ${set} where id = $1`, [U.E3.employeeId]);
        expect(userMessage(e), set).toMatch(/Only a Partner/);
      }
      expect(await s.exec("update employees set designation = 'x' where id = $1", [U.P1.employeeId])).toBe(0);
      expect(await s.exec("delete from employees where id = $1", [U.E3.employeeId])).toBe(0);
    });
  });

  it("an Employee can't edit any employees row, including their own", async () => {
    await db.asRole(U.E1, async (s) => {
      expect(await s.exec("update employees set vault_access = true where id = $1", [U.E1.employeeId])).toBe(0);
      expect(await s.exec("update employees set designation = 'x'")).toBe(0);
    });
  });

  it("a Partner reads cost rates through employee_cost_rates only", async () => {
    await db.asRole(U.P1, async (s) => {
      expect(await s.value("select cost_rate_per_hour::text from employee_cost_rates where id = $1", [U.E1.employeeId])).toBe("900.00");
    });
  });
});
