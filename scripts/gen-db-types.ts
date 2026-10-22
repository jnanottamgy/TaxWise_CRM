/**
 * Generates lib/database.types.ts from the migrated database, in the format `supabase gen types
 * typescript` produces, so supabase-js is fully typed (CONVENTIONS §4: run after schema changes).
 *
 *   npx tsx scripts/gen-db-types.ts            migrate a scratch database (taxwise_typegen) from
 *                                              supabase/migrations, introspect it, drop it
 *   npx tsx scripts/gen-db-types.ts --db NAME  introspect an existing local database instead
 *   npx tsx scripts/gen-db-types.ts --check    exit 1 if lib/database.types.ts is out of date
 *
 * What it reads (schema `public` only): pg_enum (Enums), tables and views with their columns
 * (pg_attribute: type, NOT NULL, default, identity, generated), foreign keys (Relationships), and
 * the functions the API roles may execute (Functions; trigger functions are left out).
 *
 * Conventions follow the Supabase CLI output:
 *   - Row: nullable columns are `T | null`; Insert: columns with a default, nullable, identity or
 *     filled by the numbering trigger are optional; generated columns are `?: never`;
 *     Update: everything optional.
 *   - Views carry Row only (every column `| null`, as Postgres can't vouch for view nullability) and
 *     no Insert/Update: views are SELECT-only for the API roles (0043).
 *   - Columns are sorted by name; numeric types are `number`, date/time types `string`,
 *     json/jsonb `Json`, enums `Database["public"]["Enums"][…]`, composite types the table's Row.
 *   - Functions: `Args: never` when there are none; a defaulted argument is optional; an argument
 *     accepts null unless the function is STRICT (PL/pgSQL and SQL functions take NULL for any
 *     argument, and e.g. save_client_credential(p_id => null) means "insert"); `setof` and
 *     `returns table (…)` return arrays.
 * Local harness only: refuses non-local hosts (scripts/db-local.ts adminUrl).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { adminUrl, dbUrl, resetDatabase } from "./db-local";

const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "lib", "database.types.ts");
const SCRATCH_DB = "taxwise_typegen";

/**
 * NOT NULL columns without a default that a BEFORE INSERT trigger fills (0031 assign_document_number:
 * "A number supplied by the caller is kept"). They are optional in Insert. Checked against pg_trigger.
 */
const TRIGGER_FILLED: Record<string, string[]> = {
  tasks: ["task_number"],
  clients: ["client_code"],
  quotations: ["quotation_number"],
  payment_receipts: ["receipt_number"],
  credit_notes: ["credit_note_number"],
};

type PgType = {
  oid: number;
  typname: string;
  nspname: string;
  typtype: string;
  typcategory: string;
  typelem: number;
  typbasetype: number;
  relname: string | null;
  relkind: string | null;
};

type Column = {
  relname: string;
  attname: string;
  atttypid: number;
  attnotnull: boolean;
  atthasdef: boolean;
  attidentity: string;
  attgenerated: string;
};

type Fk = { conname: string; relname: string; columns: string[]; ref_table: string; ref_columns: string[]; one_to_one: boolean };

type Fn = {
  proname: string;
  signature: string;
  prorettype: number;
  proretset: boolean;
  proargnames: string[] | null;
  proargmodes: string[] | null;
  proallargtypes: number[] | null;
  proargtypes: number[];
  pronargdefaults: number;
  proisstrict: boolean;
};

const NUMBER_TYPES = new Set(["int2", "int4", "int8", "float4", "float8", "numeric", "oid", "money"]);
const STRING_TYPES = new Set([
  "text", "varchar", "bpchar", "char", "name", "citext", "uuid", "date", "time", "timetz", "timestamp", "timestamptz",
  "interval", "inet", "cidr", "macaddr", "bytea", "tsvector", "xml", "regclass", "regtype", "regproc",
]);

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const key = (name: string) => (IDENT.test(name) ? name : JSON.stringify(name));

class TypeResolver {
  constructor(private readonly types: Map<number, PgType>) {}

  ts(oid: number): string {
    const t = this.types.get(oid);
    if (!t) return "unknown";
    if (t.typcategory === "A" && t.typelem) {
      const inner = this.ts(t.typelem);
      return /[|&\s]/.test(inner) && !inner.startsWith("Database[") ? `(${inner})[]` : `${inner}[]`;
    }
    if (t.typtype === "d") return this.ts(t.typbasetype);
    if (t.typtype === "e") return t.nspname === "public" ? `Database["public"]["Enums"][${JSON.stringify(t.typname)}]` : "string";
    if (t.typtype === "c" && t.relname && t.nspname === "public") {
      const group = t.relkind === "v" || t.relkind === "m" ? "Views" : t.relkind === "c" ? "CompositeTypes" : "Tables";
      return group === "CompositeTypes"
        ? `Database["public"]["CompositeTypes"][${JSON.stringify(t.typname)}]`
        : `Database["public"][${JSON.stringify(group)}][${JSON.stringify(t.relname)}]["Row"]`;
    }
    if (t.typname === "bool") return "boolean";
    if (NUMBER_TYPES.has(t.typname)) return "number";
    if (STRING_TYPES.has(t.typname)) return "string";
    if (t.typname === "json" || t.typname === "jsonb") return "Json";
    if (t.typname === "void") return "undefined";
    if (t.typname === "record") return "Record<string, unknown>";
    return "unknown";
  }
}

/** Reads enums, relations, columns, foreign keys and callable functions of schema public. */
export async function introspect(c: Client) {
  const types = new Map<number, PgType>();
  for (const t of (
    await c.query<PgType>(
      `select t.oid::int as oid, t.typname, n.nspname, t.typtype, t.typcategory, t.typelem::int as typelem,
              t.typbasetype::int as typbasetype, cl.relname, cl.relkind
       from pg_type t join pg_namespace n on n.oid = t.typnamespace
       left join pg_class cl on cl.oid = t.typrelid`,
    )
  ).rows) {
    types.set(Number(t.oid), { ...t, oid: Number(t.oid), typelem: Number(t.typelem), typbasetype: Number(t.typbasetype) });
  }

  const enums = (
    await c.query<{ name: string; values: string[] }>(
      `select t.typname as name, array_agg(e.enumlabel::text order by e.enumsortorder) as values
       from pg_type t join pg_enum e on e.enumtypid = t.oid join pg_namespace n on n.oid = t.typnamespace
       where n.nspname = 'public' group by t.typname order by t.typname`,
    )
  ).rows;

  const relations = (
    await c.query<{ relname: string; relkind: string }>(
      `select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm') order by c.relname`,
    )
  ).rows;

  const columns = (
    await c.query<Column>(
      `select c.relname, a.attname, a.atttypid::int as atttypid, a.attnotnull, a.atthasdef, a.attidentity::text, a.attgenerated::text
       from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm') and a.attnum > 0 and not a.attisdropped
       order by c.relname, a.attname`,
    )
  ).rows.map((r) => ({ ...r, atttypid: Number(r.atttypid) }));

  const fks = (
    await c.query<Fk>(
      `select con.conname, cl.relname,
              array(select a.attname::text from unnest(con.conkey) with ordinality k(attnum, ord)
                    join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum order by k.ord) as columns,
              rcl.relname as ref_table,
              array(select a.attname::text from unnest(con.confkey) with ordinality k(attnum, ord)
                    join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum order by k.ord) as ref_columns,
              exists (
                select 1 from pg_index i
                where i.indrelid = con.conrelid and i.indisunique and i.indpred is null
                  and (select array_agg(x order by x) from unnest(i.indkey::int2[]) x) = (select array_agg(x order by x) from unnest(con.conkey) x)
              ) as one_to_one
       from pg_constraint con
       join pg_class cl on cl.oid = con.conrelid join pg_namespace n on n.oid = cl.relnamespace
       join pg_class rcl on rcl.oid = con.confrelid join pg_namespace rn on rn.oid = rcl.relnamespace
       where con.contype = 'f' and n.nspname = 'public' and rn.nspname = 'public'
       order by cl.relname, con.conname`,
    )
  ).rows;

  const functions = (
    await c.query<Fn>(
      `select p.proname, p.oid::regprocedure::text as signature, p.prorettype::int as prorettype, p.proretset,
              p.proargnames::text[] as proargnames, p.proargmodes::text[] as proargmodes,
              p.proallargtypes::int[] as proallargtypes, p.proargtypes::int[] as proargtypes, p.pronargdefaults, p.proisstrict
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prokind = 'f'
         and p.prorettype not in ('trigger'::regtype, 'event_trigger'::regtype)
         and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute'))
       order by p.proname, p.oid::regprocedure::text`,
    )
  ).rows;

  const triggerFilled = (
    await c.query<{ relname: string }>(
      `select c.relname from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and t.tgname = 'assign_document_number' and not t.tgisinternal`,
    )
  ).rows.map((r) => r.relname);

  const composites = (
    await c.query<{ typname: string; relid: number }>(
      `select t.typname, t.typrelid::int as relid from pg_type t join pg_namespace n on n.oid = t.typnamespace
       join pg_class c on c.oid = t.typrelid
       where n.nspname = 'public' and t.typtype = 'c' and c.relkind = 'c' order by t.typname`,
    )
  ).rows;
  const compositeFields = new Map<string, { name: string; type: number }[]>();
  for (const comp of composites) {
    const fields = (
      await c.query<{ attname: string; atttypid: number }>(
        `select attname, atttypid::int as atttypid from pg_attribute where attrelid = $1 and attnum > 0 and not attisdropped order by attnum`,
        [comp.relid],
      )
    ).rows;
    compositeFields.set(comp.typname, fields.map((f) => ({ name: f.attname, type: Number(f.atttypid) })));
  }

  return { types, enums, relations, columns, fks, functions, triggerFilled, compositeFields };
}

function indent(lines: string[], n: number): string[] {
  const pad = " ".repeat(n);
  return lines.map((l) => (l ? pad + l : l));
}

/** Renders the module text (pure: the same introspection gives byte-identical output). */
export function render(info: Awaited<ReturnType<typeof introspect>>): string {
  const r = new TypeResolver(info.types);
  const colsByRel = new Map<string, Column[]>();
  for (const col of info.columns) {
    const list = colsByRel.get(col.relname) ?? [];
    list.push(col);
    colsByRel.set(col.relname, list);
  }
  const fksByRel = new Map<string, Fk[]>();
  for (const fk of info.fks) {
    const list = fksByRel.get(fk.relname) ?? [];
    list.push(fk);
    fksByRel.set(fk.relname, list);
  }
  for (const [table, cols] of Object.entries(TRIGGER_FILLED)) {
    if (!info.triggerFilled.includes(table)) throw new Error(`gen-db-types: ${table} no longer has the assign_document_number trigger; update TRIGGER_FILLED (${cols.join(", ")}).`);
  }

  const relationships = (rel: string): string[] => {
    const fks = fksByRel.get(rel) ?? [];
    if (fks.length === 0) return ["Relationships: []"];
    const out = ["Relationships: ["];
    for (const fk of fks) {
      out.push(
        "  {",
        `    foreignKeyName: ${JSON.stringify(fk.conname)}`,
        `    columns: [${fk.columns.map((x) => JSON.stringify(x)).join(", ")}]`,
        `    isOneToOne: ${fk.one_to_one}`,
        `    referencedRelation: ${JSON.stringify(fk.ref_table)}`,
        `    referencedColumns: [${fk.ref_columns.map((x) => JSON.stringify(x)).join(", ")}]`,
        "  },",
      );
    }
    out.push("]");
    return out;
  };

  const tables: string[] = [];
  const views: string[] = [];
  for (const rel of info.relations) {
    const cols = colsByRel.get(rel.relname) ?? [];
    if (rel.relkind === "v" || rel.relkind === "m") {
      views.push(`${key(rel.relname)}: {`, "  Row: {");
      for (const col of cols) views.push(`    ${key(col.attname)}: ${r.ts(col.atttypid)} | null`);
      views.push("  }", ...indent(relationships(rel.relname), 2), "}");
      continue;
    }
    const filled = new Set(TRIGGER_FILLED[rel.relname] ?? []);
    const row: string[] = [];
    const insert: string[] = [];
    const update: string[] = [];
    for (const col of cols) {
      const t = r.ts(col.atttypid);
      const nullable = !col.attnotnull;
      const k = key(col.attname);
      row.push(`${k}: ${t}${nullable ? " | null" : ""}`);
      if (col.attgenerated === "s" || col.attidentity === "a") {
        insert.push(`${k}?: never`);
        update.push(`${k}?: never`);
        continue;
      }
      const optional = nullable || col.atthasdef || col.attidentity === "d" || filled.has(col.attname);
      insert.push(`${k}${optional ? "?" : ""}: ${t}${nullable ? " | null" : ""}`);
      update.push(`${k}?: ${t}${nullable ? " | null" : ""}`);
    }
    tables.push(
      `${key(rel.relname)}: {`,
      "  Row: {", ...indent(row, 4), "  }",
      "  Insert: {", ...indent(insert, 4), "  }",
      "  Update: {", ...indent(update, 4), "  }",
      ...indent(relationships(rel.relname), 2),
      "}",
    );
  }

  // Functions (overloads become a union, as the Supabase CLI does).
  const fnByName = new Map<string, string[]>();
  for (const fn of info.functions) {
    const allTypes = (fn.proallargtypes ?? fn.proargtypes).map(Number);
    const modes = fn.proargmodes ?? allTypes.map(() => "i");
    const names = fn.proargnames ?? [];
    const inArgs: { name: string; type: number }[] = [];
    const outArgs: { name: string; type: number }[] = [];
    allTypes.forEach((type, i) => {
      const mode = modes[i];
      const name = names[i] ?? "";
      if (mode === "i" || mode === "b" || mode === "v") inArgs.push({ name, type });
      if (mode === "o" || mode === "b" || mode === "t") outArgs.push({ name, type });
    });
    const firstDefault = inArgs.length - Number(fn.pronargdefaults);
    const args = inArgs.length === 0
      ? "never"
      : `{ ${inArgs.map((a, i) => `${key(a.name)}${i >= firstDefault ? "?" : ""}: ${r.ts(a.type)}${fn.proisstrict ? "" : " | null"}`).join("; ")} }`;
    let returns: string;
    if (outArgs.length > 0) {
      // a returned row's columns can be null (e.g. public_firm_profile() before Settings are filled in)
      const obj = `{ ${outArgs.map((a) => `${key(a.name)}: ${r.ts(a.type)} | null`).join("; ")} }`;
      returns = fn.proretset ? `${obj}[]` : obj;
    } else {
      const t = r.ts(Number(fn.prorettype));
      returns = fn.proretset ? (/[|&\s]/.test(t) && !t.startsWith("Database[") ? `(${t})[]` : `${t}[]`) : t;
    }
    const list = fnByName.get(fn.proname) ?? [];
    list.push(`{ Args: ${args}; Returns: ${returns} }`);
    fnByName.set(fn.proname, list);
  }
  const functions: string[] = [];
  for (const [name, sigs] of [...fnByName.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    functions.push(`${key(name)}: ${sigs.join(" | ")}`);
  }

  const enums = info.enums.map((e) => `${key(e.name)}: ${e.values.map((v) => JSON.stringify(v)).join(" | ")}`);
  const composites: string[] = [];
  for (const [name, fields] of info.compositeFields) {
    composites.push(`${key(name)}: {`, ...fields.map((f) => `  ${key(f.name)}: ${r.ts(f.type)} | null`), "}");
  }
  const constants = info.enums.map((e) => `${key(e.name)}: [${e.values.map((v) => JSON.stringify(v)).join(", ")}],`);

  const empty = ["[_ in never]: never"];
  const block = (name: string, body: string[]) => [`${name}: {`, ...indent(body.length ? body : empty, 2), "}"];

  return [
    "/**",
    " * Generated by scripts/gen-db-types.ts (`npm run db:types`) from supabase/migrations.",
    " * Do not edit by hand: change the migration, then regenerate.",
    " */",
    "",
    "export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]",
    "",
    "export type Database = {",
    "  // Lets createClient<Database>() pick the PostgREST version without a second type argument.",
    "  __InternalSupabase: {",
    '    PostgrestVersion: "12"',
    "  }",
    "  public: {",
    ...indent(block("Tables", tables), 4),
    ...indent(block("Views", views), 4),
    ...indent(block("Functions", functions), 4),
    ...indent(block("Enums", enums), 4),
    ...indent(block("CompositeTypes", composites), 4),
    "  }",
    "}",
    "",
    'type PublicSchema = Database["public"]',
    "",
    "/** A table's or view's row: Tables<'clients'>. */",
    'export type Tables<T extends keyof (PublicSchema["Tables"] & PublicSchema["Views"])> =',
    '  (PublicSchema["Tables"] & PublicSchema["Views"])[T] extends { Row: infer R } ? R : never',
    "",
    "/** The insert shape of a table: TablesInsert<'clients'>. */",
    'export type TablesInsert<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T]["Insert"]',
    "",
    "/** The update shape of a table: TablesUpdate<'clients'>. */",
    'export type TablesUpdate<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T]["Update"]',
    "",
    "/** An enum's values: Enums<'task_status'>. */",
    'export type Enums<T extends keyof PublicSchema["Enums"]> = PublicSchema["Enums"][T]',
    "",
    "/** A composite type: CompositeTypes<'name'>. */",
    'export type CompositeTypes<T extends keyof PublicSchema["CompositeTypes"]> = PublicSchema["CompositeTypes"][T]',
    "",
    "/** A function's arguments and result: FunctionArgs<'change_task_status'>, FunctionReturns<…>. */",
    'export type FunctionArgs<T extends keyof PublicSchema["Functions"]> = PublicSchema["Functions"][T]["Args"]',
    'export type FunctionReturns<T extends keyof PublicSchema["Functions"]> = PublicSchema["Functions"][T]["Returns"]',
    "",
    "/** Enum values at runtime, in database order. */",
    "export const Constants = {",
    "  public: {",
    "    Enums: {",
    ...indent(constants, 6),
    "    },",
    "  },",
    "} as const",
    "",
  ].join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes("--check");
  const dbIdx = argv.indexOf("--db");
  const existing = dbIdx >= 0 ? argv[dbIdx + 1] : null;
  if (dbIdx >= 0 && !existing) throw new Error("--db needs a database name");

  adminUrl(); // refuses non-local hosts and APP_ENV=production
  const dbName = existing ?? SCRATCH_DB;
  if (!existing) await resetDatabase(dbName, { seed: false, quiet: true });

  const c = new Client({ connectionString: dbUrl(dbName) });
  await c.connect();
  let text: string;
  try {
    text = render(await introspect(c));
  } finally {
    await c.end();
    if (!existing) {
      const admin = new Client({ connectionString: adminUrl() });
      await admin.connect();
      await admin.query(`drop database if exists "${SCRATCH_DB}"`);
      await admin.end();
    }
  }

  if (check) {
    const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
    if (current !== text) {
      console.error("lib/database.types.ts is out of date: run npm run db:types");
      process.exit(1);
    }
    console.log("lib/database.types.ts is up to date");
    return;
  }
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT.replace(ROOT + "/", "")} (${text.split("\n").length} lines)`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
