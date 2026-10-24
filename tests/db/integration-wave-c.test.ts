/**
 * Wave C integration in the database: who hears about an Employee's leave when the firm has no
 * active Manager (0221), and that the anonymous role can't call it; the client list's aged
 * receivables flag behind Firm today's at-risk clients (0222), never shown to an Employee.
 * The retainer anchor day (0220) is tested with the billing run in collections.test.ts.
 */
import { describe, expect, it } from "vitest";
import { C, U, setupTestDatabase } from "./helpers";

const db = setupTestDatabase("integration_wave_c");

describe("leave_approver_role (0221)", () => {
  it("names the Managers for an Employee's leave and the Partners for a Manager's or Partner's", async () => {
    await db.asRole(U.E1, async (s) => {
      expect(await s.value("select public.leave_approver_role($1)", [U.E1.employeeId])).toBe("manager");
      expect(await s.value("select public.leave_approver_role($1)", [U.M1.employeeId])).toBe("partner");
      expect(await s.value("select public.leave_approver_role($1)", [U.P1.employeeId])).toBe("partner");
    });
  });

  it("falls back to the Partners when no Manager can sign in", async () => {
    await db.asSuper(async (s) => {
      await s.exec("update profiles set is_active = false where role = 'manager'");
      await s.as(U.E1);
      expect(await s.value("select public.leave_approver_role($1)", [U.E1.employeeId])).toBe("partner");
      await s.as("super");
      await s.exec("update profiles set is_active = true where id = $1", [U.M1.id]);
      await s.exec("update employees set is_active = false where id = $1", [U.M1.employeeId]);
      await s.as(U.E2);
      expect(await s.value("select public.leave_approver_role($1)", [U.E2.employeeId])).toBe("partner");
    });
  });

  it("is refused to portal users and the anonymous role", async () => {
    await db.asRole(U.CA, async (s) => {
      expect((await s.attempt("select public.leave_approver_role($1)", [U.E1.employeeId])).ok).toBe(false);
    });
    await db.asAnon(async (s) => {
      expect((await s.attempt("select public.leave_approver_role($1)", [U.E1.employeeId])).ok).toBe(false);
    });
  });
});

describe("clients_list.has_aged_receivables (0222)", () => {
  it("is true for money owed on an invoice issued over 90 days ago, for Partners and Managers only", async () => {
    await db.asSuper(async (s) => {
      const aged = async (who: typeof U.P1) => {
        await s.as(who);
        const v = await s.value<boolean | null>("select has_aged_receivables from clients_list where id = $1", [C.B]);
        await s.as("super");
        return v;
      };
      // Client B's fixture invoice was issued on 1 Sep 2026, within 90 days of today.
      expect(await aged(U.P1)).toBe(false);
      await s.exec(
        `insert into invoices (client_id, issue_date, due_date, status, place_of_supply_code, taxable_amount, cgst_amount, sgst_amount, total_amount, created_by)
         values ($1, public.today_ist() - 91, public.today_ist() - 76, 'sent', '29', 1000, 90, 90, 1180, $2)`,
        [C.B, U.P1.id],
      );
      expect(await aged(U.P1)).toBe(true);
      expect(await aged(U.M1)).toBe(true);
      // Employees never receive money data (§4.1): the column is null for them (E2 works on client B).
      expect(await aged(U.E2)).toBeNull();
    });
  });
});
