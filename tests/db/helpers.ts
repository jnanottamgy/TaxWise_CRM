/**
 * Database test harness (§14 "Database tests").
 *
 * - `setupTestDatabase(label)` gives each test file its own freshly migrated and seeded database
 *   (scripts/db-local.ts resetDatabase, unique name), loads the fixtures in tests/db/fixtures.ts as
 *   the superuser, and drops the database when the file is done.
 * - `asRole(user, fn)` runs `fn` inside a transaction that impersonates a signed-in Supabase user the
 *   way PostgREST does: `set local role authenticated` plus `request.jwt.claims` =
 *   {sub, role: 'authenticated', email, app_metadata: {role}, user_metadata}. The transaction is
 *   always rolled back, so tests never leak changes into each other.
 * - `asAnon(fn)` does the same for the anon role; `asSuper(fn)` runs as the superuser (rolled back).
 * - Inside a session, `s.as(other)` switches identity mid-transaction (e.g. a Partner sets something
 *   up, then an Employee is checked against it), and `s.attempt(...)` runs a statement in a savepoint
 *   so an expected refusal doesn't abort the transaction.
 */
import { Client, Pool, type PoolClient, type QueryResultRow } from "pg";
import { afterAll, beforeAll } from "vitest";
import { adminUrl, dbUrl, resetDatabase } from "@/scripts/db-local";
import { fixtureSql, type AppRoleName, type TestUser } from "./fixtures";

export * from "./fixtures";

/** Postgres SQLSTATEs the suite asserts on. */
export const SQLSTATE = {
  /** permission denied (missing table/column/function privilege) and RLS WITH CHECK violations */
  insufficientPrivilege: "42501",
  /** 'USER: …' refusals raised by our functions and triggers (CONVENTIONS §3.4) */
  raiseException: "P0001",
  checkViolation: "23514",
  uniqueViolation: "23505",
} as const;

export type DbError = { code: string; message: string };

export type Attempt<T extends QueryResultRow = QueryResultRow> =
  | { ok: true; rows: T[]; rowCount: number }
  | { ok: false; code: string; message: string };

/** Identity options for a session. `appRole` overrides the JWT's app_metadata.role. */
export type IdentityOptions = {
  appRole?: AppRoleName | string | null;
  userMetadata?: Record<string, unknown>;
};

export type Identity = TestUser | "anon" | "super";

export interface Session {
  /** Rows of a query (throws on error). */
  rows<T extends QueryResultRow = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Exactly one row. */
  one<T extends QueryResultRow = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T>;
  /** The first column of the first row. */
  value<T = unknown>(sql: string, params?: unknown[]): Promise<T>;
  /** Rows affected by an INSERT/UPDATE/DELETE (throws on error). */
  exec(sql: string, params?: unknown[]): Promise<number>;
  /** Runs the statement in a savepoint and reports success or the error, never throwing. */
  attempt<T extends QueryResultRow = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<Attempt<T>>;
  /** Runs the statement in a savepoint and returns its error; throws if it succeeded. */
  fails(sql: string, params?: unknown[]): Promise<DbError>;
  /** Switch identity inside the same transaction. */
  as(who: Identity, opts?: IdentityOptions): Promise<void>;
  /** The underlying connection (for advanced cases such as concurrency tests). */
  client: PoolClient;
}

/** The JWT claims PostgREST would set for this user (§4.6: app_metadata is the only role source). */
export function jwtClaims(u: TestUser, opts: IdentityOptions = {}): Record<string, unknown> {
  const appRole = opts.appRole === undefined ? u.jwtRole : opts.appRole;
  return {
    sub: u.id,
    role: "authenticated",
    aud: "authenticated",
    email: u.email,
    app_metadata: appRole === null ? { provider: "email" } : { role: appRole, provider: "email" },
    user_metadata: opts.userMetadata ?? u.userMetadata,
  };
}

async function setIdentity(c: PoolClient, who: Identity, opts: IdentityOptions = {}) {
  await c.query("reset role");
  if (who === "super") {
    await c.query("select set_config('request.jwt.claims', '', true)");
    return;
  }
  if (who === "anon") {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "anon" })]);
    await c.query("set local role anon");
    return;
  }
  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(jwtClaims(who, opts))]);
  await c.query("set local role authenticated");
}

let savepointSeq = 0;

function makeSession(c: PoolClient): Session {
  const session: Session = {
    client: c,
    async rows(sql, params) {
      return (await c.query(sql, params)).rows;
    },
    async one(sql, params) {
      const r = await c.query(sql, params);
      if (r.rows.length !== 1) throw new Error(`expected exactly one row, got ${r.rows.length}: ${sql}`);
      return r.rows[0];
    },
    async value(sql, params) {
      const r = await c.query(sql, params);
      const row = r.rows[0] as Record<string, unknown> | undefined;
      return (row ? Object.values(row)[0] : undefined) as never;
    },
    async exec(sql, params) {
      return (await c.query(sql, params)).rowCount ?? 0;
    },
    async attempt(sql, params) {
      const sp = `sp_${++savepointSeq}`;
      await c.query(`savepoint ${sp}`);
      try {
        const r = await c.query(sql, params);
        await c.query(`release savepoint ${sp}`);
        return { ok: true, rows: r.rows, rowCount: r.rowCount ?? 0 };
      } catch (err) {
        await c.query(`rollback to savepoint ${sp}`);
        const e = err as { code?: string; message?: string };
        return { ok: false, code: e.code ?? "", message: e.message ?? String(err) };
      }
    },
    async fails(sql, params) {
      const r = await session.attempt(sql, params);
      if (r.ok) throw new Error(`expected the statement to fail, but it succeeded (${r.rowCount} rows): ${sql}`);
      return { code: r.code, message: r.message };
    },
    async as(who, opts) {
      await setIdentity(c, who, opts);
    },
  };
  return session;
}

export type TestDatabase = {
  readonly name: string;
  readonly pool: Pool;
  /** Run fn as a signed-in user, in a transaction that is rolled back. */
  asRole<T>(user: TestUser, fn: (s: Session) => Promise<T>, opts?: IdentityOptions): Promise<T>;
  /** Run fn as anon (no session), rolled back. */
  asAnon<T>(fn: (s: Session) => Promise<T>): Promise<T>;
  /** Run fn as the superuser (RLS bypassed), rolled back. */
  asSuper<T>(fn: (s: Session) => Promise<T>): Promise<T>;
  /** Run fn as the superuser and COMMIT (for state that several transactions must see). */
  commitAsSuper<T>(fn: (s: Session) => Promise<T>): Promise<T>;
  /** A fresh connection with a session already impersonating `who`, in an open transaction. */
  openSession(who: Identity, opts?: IdentityOptions): Promise<Session & { commit(): Promise<void>; rollback(): Promise<void> }>;
};

async function inTransaction<T>(pool: Pool, who: Identity, opts: IdentityOptions, fn: (s: Session) => Promise<T>, commit = false): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await setIdentity(c, who, opts);
    const result = await fn(makeSession(c));
    await c.query(commit ? "commit" : "rollback");
    return result;
  } catch (err) {
    await c.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

async function dropDatabase(name: string) {
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    await admin.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()", [name]);
    await admin.query(`drop database if exists "${name}"`);
  } finally {
    await admin.end();
  }
}

/**
 * Registers beforeAll/afterAll hooks that create (migrations + seed + fixtures) and drop a database
 * private to this test file. Use the returned object only inside tests.
 */
export function setupTestDatabase(label: string, opts: { fixtures?: boolean } = {}): TestDatabase {
  const name = `taxwise_t_${label.replace(/[^a-z0-9]/gi, "_").toLowerCase()}_${process.pid}`.slice(0, 63);
  let pool: Pool | null = null;

  beforeAll(async () => {
    await resetDatabase(name, { quiet: true });
    pool = new Pool({ connectionString: dbUrl(name), max: 6 });
    if (opts.fixtures !== false) {
      const c = await pool.connect();
      try {
        await c.query(fixtureSql());
      } finally {
        c.release();
      }
    }
  });

  afterAll(async () => {
    if (pool) await pool.end();
    await dropDatabase(name);
  });

  const need = () => {
    if (!pool) throw new Error("test database not ready (use it inside a test)");
    return pool;
  };

  return {
    name,
    get pool() {
      return need();
    },
    asRole: (user, fn, o = {}) => inTransaction(need(), user, o, fn),
    asAnon: (fn) => inTransaction(need(), "anon", {}, fn),
    asSuper: (fn) => inTransaction(need(), "super", {}, fn),
    commitAsSuper: (fn) => inTransaction(need(), "super", {}, fn, true),
    async openSession(who, o = {}) {
      const c = await need().connect();
      await c.query("begin");
      await setIdentity(c, who, o);
      const s = makeSession(c);
      let done = false;
      const finish = async (sql: string) => {
        if (done) return;
        done = true;
        try {
          await c.query(sql);
        } finally {
          c.release();
        }
      };
      return Object.assign(s, { commit: () => finish("commit"), rollback: () => finish("rollback") });
    },
  };
}

/** True when an attempt was refused for lack of privilege (42501) — table/column/function grants or RLS WITH CHECK. */
export function isDenied(a: Attempt): boolean {
  return !a.ok && a.code === SQLSTATE.insufficientPrivilege;
}

/** Rows a SELECT returned, or 0 when the role isn't allowed to run it at all. */
export function visibleCount(a: Attempt): number {
  if (a.ok) return a.rows.length;
  if (a.code === SQLSTATE.insufficientPrivilege) return 0;
  throw new Error(`unexpected error ${a.code}: ${a.message}`);
}

/** The user-facing sentence of a 'USER: …' refusal. */
export function userMessage(e: DbError): string {
  return e.message.replace(/^USER:\s*/, "");
}
