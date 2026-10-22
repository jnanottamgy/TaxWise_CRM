/**
 * lib/database.types.ts matches the migrations (CONVENTIONS §4 "After schema changes run
 * npm run db:types"), and the generated types say what the schema says (compile-time checks,
 * enforced by `npx tsc --noEmit -p .`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { describe, expect, expectTypeOf, it } from "vitest";
import { dbUrl } from "@/scripts/db-local";
import { introspect, render } from "@/scripts/gen-db-types";
import { Constants, type Database, type Enums, type FunctionArgs, type Tables, type TablesInsert } from "@/lib/database.types";
import { TASK_STATUSES } from "@/lib/domain/enums";
import { setupTestDatabase } from "./helpers";

const db = setupTestDatabase("types", { fixtures: false });

describe("lib/database.types.ts", () => {
  it("is up to date with supabase/migrations (run npm run db:types if this fails)", async () => {
    const c = new Client({ connectionString: dbUrl(db.name) });
    await c.connect();
    try {
      const expected = render(await introspect(c));
      const actual = readFileSync(join(__dirname, "..", "..", "lib", "database.types.ts"), "utf8");
      expect(actual === expected, "lib/database.types.ts is stale: run npm run db:types").toBe(true);
    } finally {
      await c.end();
    }
  });

  it("enum constants match the database and lib/domain/enums.ts", async () => {
    const statuses = await db.asSuper((s) => s.value<string[]>("select enum_range(null::task_status)::text[]"));
    expect([...Constants.public.Enums.task_status]).toEqual(statuses);
    expect([...Constants.public.Enums.task_status]).toEqual([...TASK_STATUSES]);
  });

  it("types say what the schema says", () => {
    // Row: NOT NULL columns are plain, nullable ones carry null, enums are unions.
    expectTypeOf<Tables<"clients">["display_name"]>().toEqualTypeOf<string>();
    expectTypeOf<Tables<"clients">["owner_employee_id"]>().toEqualTypeOf<string | null>();
    expectTypeOf<Tables<"tasks">["status"]>().toEqualTypeOf<Enums<"task_status">>();
    expectTypeOf<Tables<"invoices">["total_amount"]>().toEqualTypeOf<number>();
    expectTypeOf<Tables<"messages">["related_entity_id"]>().toEqualTypeOf<string | null>();
    // Insert: defaults and numbering-trigger columns are optional; required columns stay required.
    expectTypeOf<TablesInsert<"tasks">>().toHaveProperty("client_id").toEqualTypeOf<string>();
    expectTypeOf<TablesInsert<"tasks">["task_number"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<TablesInsert<"clients">["client_code"]>().toEqualTypeOf<string | undefined>();
    // Generated columns can't be written.
    expectTypeOf<TablesInsert<"audit_engagements">["file_assembly_due"]>().toEqualTypeOf<undefined>();
    // Views: Row only, no fee columns in the Employees' view, no ciphertext in the vault list.
    expectTypeOf<Tables<"client_services_public">>().not.toHaveProperty("agreed_fee");
    expectTypeOf<Tables<"client_credentials_list">>().not.toHaveProperty("password_ciphertext");
    expectTypeOf<Database["public"]["Views"]["tasks_view"]>().not.toHaveProperty("Insert");
    // Functions: defaulted arguments are optional and take null.
    expectTypeOf<FunctionArgs<"change_task_status">>().toEqualTypeOf<{
      p_task_id: string | null;
      p_to: Enums<"task_status"> | null;
      p_reason?: string | null;
    }>();
    expect(true).toBe(true);
  });
});
