import { migrationFiles } from "../../scripts/db-local";
import { EXPECTED_SCHEMA_VERSION } from "@/lib/env";
/**
 * Structural guarantees that hold for every table, view and function in `public` (§0.1 rule 8,
 * §4.6, §12, §14), so a table or view added later can't silently skip the access rules.
 */
import { describe, expect, it } from "vitest";
import { SQLSTATE, setupTestDatabase } from "./helpers";

const db = setupTestDatabase("structure", { fixtures: false });

/** Tables locked on purpose: RLS on, no policy, no API privileges (0042). */
const LOCKED_TABLES = ["client_credentials", "rate_limits"];

/** Functions anon may execute: pure helpers and the public firm profile (0032). */
const ANON_FUNCTIONS = [
  "financial_year_label(date)",
  "fy_end_date(text)",
  "fy_start_date(text)",
  "is_fy_label(text)",
  "jsonb_to_numeric(jsonb)",
  "public_firm_profile()",
  "statutory_param_value(text,date)",
  "today_ist()",
];

/** Views that run with their owner's rights; each carries its own row filter (reviewed). */
const DEFINER_VIEWS = [
  "client_credentials_list",
  "client_services_public",
  "client_whatsapp_groups_public",
  "employee_cost_rates",
  "employee_directory",
  "portal_invoices",
  "portal_my_client",
  "portal_payment_receipts",
];

describe("tables", () => {
  it("every public table has Row Level Security enabled", async () => {
    const off = await db.asSuper((s) =>
      s.rows<{ relname: string }>(
        `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity`,
      ),
    );
    expect(off).toEqual([]);
  });

  it("every table has at least one policy, except the two locked by design", async () => {
    const none = await db.asSuper((s) =>
      s.rows<{ relname: string }>(
        `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind in ('r', 'p')
           and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
         order by 1`,
      ),
    );
    expect(none.map((r) => r.relname)).toEqual(LOCKED_TABLES);
  });

  it("the locked tables grant the API roles nothing at all", async () => {
    const grants = await db.asSuper((s) =>
      s.rows(
        `select table_name, grantee, privilege_type from information_schema.role_table_grants
         where table_schema = 'public' and table_name = any($1) and grantee in ('anon', 'authenticated')`,
        [LOCKED_TABLES],
      ),
    );
    expect(grants).toEqual([]);
    const cols = await db.asSuper((s) =>
      s.rows(
        `select table_name, column_name, grantee from information_schema.column_privileges
         where table_schema = 'public' and table_name = any($1) and grantee in ('anon', 'authenticated')`,
        [LOCKED_TABLES],
      ),
    );
    expect(cols).toEqual([]);
  });

  it("every policy applies to authenticated only (never PUBLIC or anon)", async () => {
    const bad = await db.asSuper((s) =>
      s.rows<{ tbl: string; polname: string; roles: string[] }>(
        `select p.polrelid::regclass::text as tbl, p.polname,
                array(select coalesce(r.rolname::text, 'PUBLIC') from unnest(p.polroles) as u(oid) left join pg_roles r on r.oid = u.oid) as roles
         from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public'`,
      ),
    );
    expect(bad.filter((p) => p.roles.length !== 1 || p.roles[0] !== "authenticated")).toEqual([]);
  });

  it("anon holds no privilege on any table, view or sequence in public", async () => {
    const rows = await db.asSuper((s) =>
      s.rows<{ relname: string }>(
        `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
           and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert')
             or has_table_privilege('anon', c.oid, 'update') or has_table_privilege('anon', c.oid, 'delete')
             or has_table_privilege('anon', c.oid, 'truncate'))`,
      ),
    );
    expect(rows).toEqual([]);
  });
});

describe("views", () => {
  it("every view is read-only for authenticated (writes through a definer view would skip RLS)", async () => {
    const rows = await db.asSuper((s) =>
      s.rows<{ relname: string }>(
        `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind in ('v', 'm')
           and (has_table_privilege('authenticated', c.oid, 'insert') or has_table_privilege('authenticated', c.oid, 'update')
             or has_table_privilege('authenticated', c.oid, 'delete') or has_table_privilege('authenticated', c.oid, 'truncate'))`,
      ),
    );
    expect(rows).toEqual([]);
  });

  it("only the reviewed views run with their owner's rights; the rest are security_invoker", async () => {
    const rows = await db.asSuper((s) =>
      s.rows<{ relname: string; invoker: boolean; barrier: boolean }>(
        `select c.relname,
                coalesce((select option_value from pg_options_to_table(c.reloptions) where option_name = 'security_invoker'), 'false')::boolean as invoker,
                coalesce((select option_value from pg_options_to_table(c.reloptions) where option_name = 'security_barrier'), 'false')::boolean as barrier
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'v' order by 1`,
      ),
    );
    const definer = rows.filter((r) => !r.invoker);
    expect(definer.map((r) => r.relname)).toEqual(DEFINER_VIEWS);
    // A definer view filters rows itself, so it must be a security barrier (no leaky predicates).
    expect(definer.filter((r) => !r.barrier)).toEqual([]);
  });

  it("no view exposes credential ciphertext or invite links except where intended", async () => {
    const cols = await db.asSuper((s) =>
      s.rows<{ table_name: string; column_name: string }>(
        `select table_name, column_name from information_schema.columns
         where table_schema = 'public' and table_name in (select table_name from information_schema.views where table_schema = 'public')
           and column_name in ('password_ciphertext', 'invite_link', 'cost_rate_per_hour', 'agreed_fee', 'billing_frequency', 'auto_invoice', 'next_billing_date')
         order by 1, 2`,
      ),
    );
    expect(cols).toEqual([{ table_name: "employee_cost_rates", column_name: "cost_rate_per_hour" }]);
  });
});

describe("functions", () => {
  it("anon can execute only the pure helpers and public_firm_profile()", async () => {
    const rows = await db.asSuper((s) =>
      s.rows<{ fn: string }>(
        `select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute') order by 1`,
      ),
    );
    expect(rows.map((r) => r.fn)).toEqual(ANON_FUNCTIONS);
  });

  it("the only SECURITY DEFINER function anon can call is public_firm_profile()", async () => {
    const rows = await db.asSuper((s) =>
      s.rows<{ fn: string }>(
        `select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.prosecdef and has_function_privilege('anon', p.oid, 'execute')`,
      ),
    );
    expect(rows.map((r) => r.fn)).toEqual(["public_firm_profile()"]);
  });

  it("every SECURITY DEFINER function pins its search_path", async () => {
    const rows = await db.asSuper((s) =>
      s.rows<{ fn: string }>(
        `select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.prosecdef
           and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`,
      ),
    );
    expect(rows).toEqual([]);
  });

  it("trigger functions can't be called directly by API users", async () => {
    const rows = await db.asSuper((s) =>
      s.rows<{ fn: string }>(
        `select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.prorettype = 'trigger'::regtype
           and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))
         order by 1`,
      ),
    );
    // assign_document_number keeps no grant; the column-limit triggers run as the invoker but are
    // never callable as plain functions (trigger functions can't be called outside a trigger anyway).
    expect(rows).toEqual([]);
  });

  it("rate limiting is the service role's alone", async () => {
    await db.asSuper(async (s) => {
      expect(await s.value("select has_function_privilege('authenticated', 'public.check_rate_limit(text,int,int)', 'execute')")).toBe(false);
      expect(await s.value("select has_function_privilege('service_role', 'public.check_rate_limit(text,int,int)', 'execute')")).toBe(true);
    });
  });
});

describe("schema version and seeds", () => {
  it("app_meta.schema_version is set by the highest migration", async () => {
    const v = await db.asSuper((s) => s.value<string>("select value from app_meta where key = 'schema_version'"));
    const highest = migrationFiles().at(-1)!.slice(0, 4);
    expect(v).toBe(highest);
    expect(EXPECTED_SCHEMA_VERSION, "lib/env.ts EXPECTED_SCHEMA_VERSION must match the highest migration").toBe(highest);
  });

  it("the production seed holds no clients, people or logins (§16)", async () => {
    await db.asSuper(async (s) => {
      for (const t of ["clients", "profiles", "employees", "invoices", "tasks", "leads", "quotations"]) {
        expect(await s.value<number>(`select count(*)::int from public.${t}`), t).toBe(0);
      }
      expect(await s.value<number>("select count(*)::int from auth.users")).toBe(0);
      expect(await s.value<number>("select count(*)::int from firm_settings")).toBe(1);
    });
  });

  it("law rows: [verify] values are seeded unverified, and every concordance row awaits a Partner (§5.12, §16)", async () => {
    await db.asSuper(async (s) => {
      expect(await s.value<number>("select count(*)::int from section_concordance where verified")).toBe(0);
      expect(await s.value<number>("select count(*)::int from statutory_parameters")).toBeGreaterThan(0);
      expect(await s.value<number>("select count(*)::int from due_date_rules")).toBeGreaterThan(0);
    });
  });

  it("a refused statement surfaces the SQLSTATE the app maps (sanity check of the harness)", async () => {
    const e = await db.asAnon((s) => s.fails("select * from firm_settings"));
    expect(e.code).toBe(SQLSTATE.insufficientPrivilege);
  });
});
