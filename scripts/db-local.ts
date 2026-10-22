/**
 * Local database harness (development and tests only; never points at Supabase).
 *
 *   npx tsx scripts/db-local.ts reset [dbName]   drop + create the database, apply the Supabase shim,
 *                                                 every migration in order, then supabase/seed/*.sql in order
 *   npx tsx scripts/db-local.ts migrate [dbName] apply migrations not yet applied
 *
 * Needs LOCAL_PG_ADMIN_URL (a superuser URL to the local server's `postgres` database), e.g. in
 * .env.test.local. It refuses to run against anything that isn't localhost, and when APP_ENV=production.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

const ROOT = join(__dirname, "..");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");
const SHIM = join(ROOT, "tests", "db", "shim", "supabase-shim.sql");
const SEED_DIR = join(ROOT, "supabase", "seed");

function loadEnvFile() {
  const p = join(ROOT, ".env.test.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

export function adminUrl(): string {
  loadEnvFile();
  const url = process.env.LOCAL_PG_ADMIN_URL;
  if (!url) throw new Error("Set LOCAL_PG_ADMIN_URL (see .env.example).");
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error(`Refusing to touch non-local host ${host}.`);
  if (process.env.APP_ENV === "production") throw new Error("Refusing to run with APP_ENV=production.");
  return url;
}

export function dbUrl(dbName: string): string {
  const u = new URL(adminUrl());
  u.pathname = `/${dbName}`;
  return u.toString();
}

export function seedFiles(): string[] {
  if (!existsSync(SEED_DIR)) return [];
  return readdirSync(SEED_DIR).filter((f) => /^\d{2}_.+\.sql$/.test(f)).sort();
}

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
}

export async function resetDatabase(dbName: string, opts: { seed?: boolean; quiet?: boolean } = {}) {
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`, [dbName]);
  await admin.query(`drop database if exists "${dbName}"`);
  await admin.query(`create database "${dbName}"`);
  await admin.end();

  const db = new Client({ connectionString: dbUrl(dbName) });
  await db.connect();
  try {
    await db.query(readFileSync(SHIM, "utf8"));
    for (const f of migrationFiles()) {
      if (!opts.quiet) console.log(`applying ${f}`);
      try {
        await db.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
      } catch (err) {
        const e = err as Error & { position?: string; where?: string };
        throw new Error(`Migration ${f} failed: ${e.message}${e.where ? `\n  where: ${e.where}` : ""}${e.position ? `\n  position: ${e.position}` : ""}`);
      }
    }
    if (opts.seed !== false) {
      for (const f of seedFiles()) {
        if (!opts.quiet) console.log(`seeding ${f}`);
        try {
          await db.query(readFileSync(join(SEED_DIR, f), "utf8"));
        } catch (err) {
          const e = err as Error & { where?: string };
          throw new Error(`Seed ${f} failed: ${e.message}${e.where ? `\n  where: ${e.where}` : ""}`);
        }
      }
    }
  } finally {
    await db.end();
  }
}

async function main() {
  const [cmd = "reset", dbName = "taxwise_local"] = process.argv.slice(2);
  if (cmd === "reset") {
    await resetDatabase(dbName);
    console.log(`database ${dbName} is ready`);
  } else if (cmd === "migrate-only") {
    await resetDatabase(dbName, { seed: false });
    console.log(`database ${dbName} migrated (no seed)`);
  } else {
    console.error(`unknown command ${cmd}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
