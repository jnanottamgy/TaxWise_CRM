/**
 * The local QA stack (scripts/local-stack/README.md): Postgres database `taxwise_qa` with the QA
 * dataset, PostgREST, a Supabase stand-in and the app, all on this machine.
 *
 *   npx tsx scripts/local-stack/stack.ts up [--dev] [--fresh] [--rebuild]
 *   npx tsx scripts/local-stack/stack.ts down [--purge]
 *   npx tsx scripts/local-stack/stack.ts status
 *   npx tsx scripts/local-stack/stack.ts reset-data
 *
 * `up` is idempotent: it loads the database only when it doesn't hold a complete QA load (or with
 * --fresh), starts only what isn't already running, and rebuilds the app only when the source tree,
 * the stack's keys or the build in .next changed (or with --rebuild). --dev runs `next dev` instead
 * of a production build, for fixing pages with hot reload.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { adminUrl, dbUrl } from "../db-local";
import {
  APP_URL,
  BIN_DIR,
  DOWNLOADS,
  LOG_DIR,
  PID_DIR,
  PORTS,
  POSTGREST_URL,
  QA_DB,
  ROOT,
  STATE_DIR,
  STATE_FILES,
  SUPABASE_URL,
  chromeBin,
  ensureStateDir,
  loadOrCreateSecrets,
  postgrestBin,
  readSecrets,
  type StackSecrets,
  QA_TOTP_CODE,
} from "./config";

import { apiKey, fixtureAuthUsers } from "./jwt";

type Service = "postgrest" | "mock" | "app";
const SERVICES: Service[] = ["postgrest", "mock", "app"];
const TSX = join(ROOT, "node_modules", ".bin", "tsx");
const NEXT = join(ROOT, "node_modules", ".bin", "next");

// -------------------------------------------------------------------------------------------------
// Processes
// -------------------------------------------------------------------------------------------------

const pidFile = (s: Service) => join(PID_DIR, `${s}.pid`);
const logFile = (s: Service | "build" | "data") => join(LOG_DIR, `${s}.log`);

function readPid(s: Service): number | null {
  try {
    const n = Number(readFileSync(pidFile(s), "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function alive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function httpOk(url: string, timeoutMs = 3000): Promise<number | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    return res.status;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs: number, logPath?: string): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await sleep(500);
  }
  const tail = logPath && existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").slice(-25).join("\n") : "";
  throw new Error(`${what} didn't come up within ${Math.round(timeoutMs / 1000)}s.${tail ? `\n--- ${logPath}\n${tail}` : ""}`);
}

function startDetached(s: Service, cmd: string, args: string[], env: NodeJS.ProcessEnv): number {
  const out = openSync(logFile(s), "a");
  writeFileSync(out, `\n===== ${new Date().toISOString()} ${cmd} ${args.join(" ")}\n`);
  const child = spawn(cmd, args, { cwd: ROOT, env, detached: true, stdio: ["ignore", out, out] });
  closeSync(out);
  if (!child.pid) throw new Error(`Couldn't start ${s}.`);
  child.unref();
  writeFileSync(pidFile(s), String(child.pid));
  return child.pid;
}

async function stop(s: Service): Promise<boolean> {
  const pid = readPid(s);
  rmSync(pidFile(s), { force: true });
  if (!alive(pid)) return false;
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid!, sig); // the whole process group (npm/next spawn children)
    } catch {
      try {
        process.kill(pid!, sig);
      } catch {
        // already gone
      }
    }
  };
  signal("SIGTERM");
  for (let i = 0; i < 20 && alive(pid); i++) await sleep(250);
  if (alive(pid)) signal("SIGKILL");
  return true;
}

// -------------------------------------------------------------------------------------------------
// Database
// -------------------------------------------------------------------------------------------------

async function withDb<T>(dbName: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: dbName === "postgres" ? adminUrl() : dbUrl(dbName) });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** The QA load marker (app_meta.qa_stack_loaded_at), or null when the database is missing or incomplete. */
async function loadedAt(): Promise<string | null> {
  try {
    const exists = await withDb("postgres", (c) => c.query("select 1 from pg_database where datname = $1", [QA_DB]));
    if (exists.rowCount === 0) return null;
    return await withDb(QA_DB, async (c) => {
      const r = await c.query<{ value: string }>("select value from public.app_meta where key = 'qa_stack_loaded_at'");
      return r.rows[0]?.value ?? null;
    });
  } catch {
    return null;
  }
}

function loadData(secrets: StackSecrets): void {
  console.log(`• Resetting ${QA_DB} (migrations, seed, fixtures, QA dataset) …`);
  const out = openSync(logFile("data"), "w");
  const r = spawnSync(TSX, ["--conditions=react-server", join(__dirname, "qa-data.ts"), "reset", QA_DB], {
    cwd: ROOT,
    env: { ...process.env, CREDENTIAL_VAULT_KEY: secrets.vaultKey, CREDENTIAL_VAULT_KEY_VERSION: "v1", APP_ENV: "development" },
    stdio: ["ignore", out, out],
  });
  closeSync(out);
  const log = readFileSync(logFile("data"), "utf8");
  if (r.status !== 0) throw new Error(`Loading the QA data failed (exit ${r.status}).\n--- ${logFile("data")}\n${log.split("\n").slice(-30).join("\n")}`);
  const summary = log.split("\n").filter((l) => l.startsWith("  "));
  console.log(summary.join("\n"));
}

async function ensureAuthenticator(secrets: StackSecrets): Promise<void> {
  await withDb(QA_DB, async (c) => {
    await c.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit; end if; end $$;`);
    await c.query(`alter role authenticator with login noinherit password '${secrets.authenticatorPassword}'`);
    await c.query("grant anon, authenticated, service_role to authenticator");
    await c.query(`grant connect on database "${QA_DB}" to authenticator`);
  });
}

// -------------------------------------------------------------------------------------------------
// Services
// -------------------------------------------------------------------------------------------------

async function startPostgrest(secrets: StackSecrets): Promise<void> {
  if (alive(readPid("postgrest")) && (await httpOk(`${POSTGREST_URL}/`)) !== null) {
    console.log(`• PostgREST already running on ${POSTGREST_URL}`);
    return;
  }
  await stop("postgrest");
  const bin = postgrestBin();
  if (!bin) throw new Error(`PostgREST 12.2.3 isn't installed. See README.md ("Binaries"): put it at ${join(BIN_DIR, "postgrest")} or set QA_POSTGREST_BIN.\n  ${DOWNLOADS.postgrest}`);
  const pg = new URL(adminUrl());
  const conf = [
    `db-uri = "postgres://authenticator:${secrets.authenticatorPassword}@${pg.hostname}:${pg.port || 5432}/${QA_DB}"`,
    `db-schemas = "public"`,
    `db-anon-role = "anon"`,
    `db-extra-search-path = "public, extensions"`,
    `db-max-rows = 1000`,
    `db-pool = 20`,
    `jwt-secret = "${secrets.jwtSecret}"`,
    `server-host = "127.0.0.1"`,
    `server-port = ${PORTS.postgrest}`,
    `log-level = "warn"`,
  ].join("\n");
  writeFileSync(STATE_FILES.postgrestConf, `${conf}\n`, { mode: 0o600 });
  startDetached("postgrest", bin, [STATE_FILES.postgrestConf], process.env);
  await waitFor("PostgREST", async () => (await httpOk(`${POSTGREST_URL}/`)) === 200, 30_000, logFile("postgrest"));
  console.log(`• PostgREST on ${POSTGREST_URL} (database ${QA_DB})`);
}

async function startMock(): Promise<void> {
  if (alive(readPid("mock")) && (await httpOk(`${SUPABASE_URL}/health`)) === 200) {
    console.log(`• Supabase stand-in already running on ${SUPABASE_URL}`);
    return;
  }
  await stop("mock");
  startDetached("mock", TSX, [join(__dirname, "mock-supabase.ts")], process.env);
  await waitFor("Supabase stand-in", async () => (await httpOk(`${SUPABASE_URL}/health`)) === 200, 30_000, logFile("mock"));
  console.log(`• Supabase stand-in on ${SUPABASE_URL}`);
}

export function appEnv(secrets: StackSecrets): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: apiKey("anon", secrets.jwtSecret),
    SUPABASE_SERVICE_ROLE_KEY: apiKey("service_role", secrets.jwtSecret),
    CREDENTIAL_VAULT_KEY: secrets.vaultKey,
    CREDENTIAL_VAULT_KEY_VERSION: "v1",
    CRON_SECRET: secrets.cronSecret,
    APP_ENV: "development",
    NEXT_PUBLIC_APP_URL: APP_URL,
    NEXT_TELEMETRY_DISABLED: "1",
    // Never send mail from a QA run.
    RESEND_API_KEY: "",
  };
}

/** What a production build depends on: HEAD, the working tree's changes, and the keys baked into it. */
function buildFingerprint(secrets: StackSecrets): string {
  const h = createHash("sha256");
  h.update(spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout ?? "");
  const changed = (spawnSync("git", ["ls-files", "-m", "-o", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" }).stdout ?? "")
    .split("\n")
    .filter(Boolean)
    // Not part of the Next build: this harness, tests, docs, and TaxWise Desktop (its own package).
    .filter((f) => !["scripts/local-stack/", "tests/", "docs/", "desktop/", ".claude/"].some((dir) => f.startsWith(dir)))
    .sort();
  for (const f of changed) {
    const p = join(ROOT, f);
    h.update(f);
    if (existsSync(p)) h.update(readFileSync(p));
  }
  h.update(SUPABASE_URL);
  h.update(APP_URL);
  h.update(apiKey("anon", secrets.jwtSecret).split(".")[0]);
  h.update(secrets.jwtSecret);
  return h.digest("hex");
}

function currentBuildId(): string | null {
  try {
    return readFileSync(join(ROOT, ".next", "BUILD_ID"), "utf8").trim();
  } catch {
    return null;
  }
}

async function build(secrets: StackSecrets, force: boolean): Promise<void> {
  const fingerprint = buildFingerprint(secrets);
  let stamp: { fingerprint: string; buildId: string } | null = null;
  try {
    stamp = JSON.parse(readFileSync(STATE_FILES.buildStamp, "utf8"));
  } catch {
    stamp = null;
  }
  if (!force && stamp && stamp.fingerprint === fingerprint && stamp.buildId === currentBuildId()) {
    console.log(`• Production build is current (.next, BUILD_ID ${stamp.buildId})`);
    return;
  }
  console.log(`• Building the app (npm run build; log in ${logFile("build")}) …`);
  const started = Date.now();
  const out = openSync(logFile("build"), "w");
  const r = spawnSync("npm", ["run", "build"], { cwd: ROOT, env: { ...appEnv(secrets), NODE_ENV: "production" }, stdio: ["ignore", out, out] });
  closeSync(out);
  if (r.status !== 0) {
    const tail = readFileSync(logFile("build"), "utf8").split("\n").slice(-40).join("\n");
    throw new Error(`npm run build failed (exit ${r.status}).\n${tail}`);
  }
  writeFileSync(STATE_FILES.buildStamp, JSON.stringify({ fingerprint, buildId: currentBuildId(), builtAt: new Date().toISOString() }, null, 2));
  console.log(`  built in ${Math.round((Date.now() - started) / 1000)}s`);
}

function appMode(): string | null {
  try {
    return readFileSync(STATE_FILES.appMode, "utf8").trim();
  } catch {
    return null;
  }
}

async function startApp(secrets: StackSecrets, opts: { dev: boolean; rebuild: boolean }): Promise<void> {
  const mode = opts.dev ? "dev" : "production";
  const running = alive(readPid("app")) && (await httpOk(`${APP_URL}/api/health`, 10_000)) === 200;
  if (running && appMode() === mode && !opts.rebuild) {
    if (mode === "dev") {
      console.log(`• App already running (next dev) on ${APP_URL}`);
      return;
    }
    // A production server keeps serving the build it started with: rebuild when the tree moved on.
    // Anyone else's `npm run build` replaces .next under the running server too (its pages would then
    // load another build's chunks), so the build in .next must still be the one the stamp recorded.
    let stamp: { fingerprint: string; buildId?: string } | null = null;
    try {
      stamp = JSON.parse(readFileSync(STATE_FILES.buildStamp, "utf8"));
    } catch {
      stamp = null;
    }
    if (stamp?.fingerprint === buildFingerprint(secrets) && stamp.buildId === currentBuildId()) {
      console.log(`• App already running (next start) on ${APP_URL}`);
      return;
    }
    console.log("• The source tree or .next changed since the running build: rebuilding.");
  }
  await stop("app");
  if (mode === "production") await build(secrets, opts.rebuild);
  const args = mode === "dev" ? ["dev", "-p", String(PORTS.app)] : ["start", "-p", String(PORTS.app)];
  startDetached("app", NEXT, args, appEnv(secrets));
  writeFileSync(STATE_FILES.appMode, mode);
  await waitFor(`The app (next ${args[0]})`, async () => (await httpOk(`${APP_URL}/api/health`, 10_000)) === 200, mode === "dev" ? 180_000 : 90_000, logFile("app"));
  console.log(`• App (next ${args[0]}) on ${APP_URL}`);
}

// -------------------------------------------------------------------------------------------------
// Commands
// -------------------------------------------------------------------------------------------------

async function checkPostgres(): Promise<void> {
  try {
    await withDb("postgres", (c) => c.query("select 1"));
  } catch (err) {
    throw new Error(`Local Postgres isn't reachable (${err instanceof Error ? err.message : String(err)}). Start it with: pg_ctlcluster 16 main start`);
  }
}

async function up(flags: Set<string>): Promise<void> {
  ensureStateDir();
  const secrets = loadOrCreateSecrets();
  writeFileSync(STATE_FILES.users, JSON.stringify(fixtureAuthUsers(), null, 2));
  await checkPostgres();
  const loaded = await loadedAt();
  if (!loaded || flags.has("--fresh")) {
    if (alive(readPid("postgrest"))) await stop("postgrest"); // it holds connections to the database being dropped
    loadData(secrets);
  } else {
    console.log(`• ${QA_DB} already holds the QA data (loaded ${loaded}); use reset-data or --fresh to reload`);
  }
  await ensureAuthenticator(secrets);
  await startPostgrest(secrets);
  await startMock();
  await startApp(secrets, { dev: flags.has("--dev"), rebuild: flags.has("--rebuild") });
  console.log(`\nQA stack is up. Sign in as a fixture user:\n  npx tsx scripts/local-stack/sessions.ts P1    # cookie header; see README.md\n  ${APP_URL}`);
}

async function down(flags: Set<string>): Promise<void> {
  for (const s of [...SERVICES].reverse()) {
    const stopped = await stop(s);
    console.log(`• ${s}: ${stopped ? "stopped" : "not running"}`);
  }
  rmSync(STATE_FILES.appMode, { force: true });
  if (flags.has("--purge")) {
    try {
      await withDb("postgres", async (c) => {
        await c.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()", [QA_DB]);
        await c.query(`drop database if exists "${QA_DB}"`);
      });
      console.log(`• dropped ${QA_DB}`);
    } catch (err) {
      console.log(`• couldn't drop ${QA_DB}: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const f of [STATE_FILES.secrets, STATE_FILES.users, STATE_FILES.postgrestConf, STATE_FILES.buildStamp]) rmSync(f, { force: true });
    console.log(`• removed the stack's secrets (binaries in ${BIN_DIR} kept)`);
  }
}

async function status(): Promise<void> {
  const secrets = readSecrets();
  console.log(`State: ${STATE_DIR}${secrets ? ` (secrets from ${secrets.createdAt})` : " (no secrets yet: run up)"}`);
  if (secrets) console.log(`Sign-in on /login (local stack only): any fixture email, password ${secrets.qaPassword}, code ${QA_TOTP_CODE}`);
  const checks: Array<[Service, string]> = [
    ["postgrest", `${POSTGREST_URL}/`],
    ["mock", `${SUPABASE_URL}/health`],
    ["app", `${APP_URL}/api/health`],
  ];
  for (const [s, url] of checks) {
    const pid = readPid(s);
    const code = await httpOk(url, 5000);
    const extra = s === "app" && appMode() ? ` mode=${appMode()}` : "";
    console.log(`  ${s.padEnd(10)} pid=${pid ?? "-"} ${alive(pid) ? "alive" : "dead "} ${url} → ${code ?? "no answer"}${extra}`);
  }
  try {
    const counts = await withDb(QA_DB, (c) =>
      c.query<{ t: string; n: number }>(
        `select 'clients' t, count(*)::int n from clients union all select 'tasks', count(*)::int from tasks
         union all select 'invoices', count(*)::int from invoices union all select 'compliance_events', count(*)::int from compliance_events
         union all select 'documents', count(*)::int from documents`,
      ),
    );
    console.log(`  ${QA_DB}: loaded ${(await loadedAt()) ?? "NO QA LOAD"}; ${counts.rows.map((r) => `${r.t}=${r.n}`).join(" ")}`);
  } catch {
    console.log(`  ${QA_DB}: not reachable`);
  }
  console.log(`  postgrest binary: ${postgrestBin() ?? "MISSING"}\n  chrome binary:    ${chromeBin() ?? "MISSING"}`);
}

async function resetData(): Promise<void> {
  ensureStateDir();
  const secrets = loadOrCreateSecrets();
  await checkPostgres();
  // PostgREST holds connections to the database being dropped; it comes back afterwards (even when the
  // load fails) whenever the rest of the stack is up.
  const restart = alive(readPid("postgrest")) || alive(readPid("mock")) || alive(readPid("app"));
  await stop("postgrest");
  try {
    loadData(secrets);
  } finally {
    if (restart && (await loadedAt())) {
      await ensureAuthenticator(secrets);
      await startPostgrest(secrets);
    }
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = new Set(rest);
  if (!existsSync(join(ROOT, "node_modules"))) throw new Error("node_modules is missing: run npm ci first.");
  switch (cmd) {
    case "up":
      return up(flags);
    case "down":
      return down(flags);
    case "status":
      return status();
    case "reset-data":
      return resetData();
    default:
      console.log("usage: npx tsx scripts/local-stack/stack.ts up [--dev] [--fresh] [--rebuild] | down [--purge] | status | reset-data");
      process.exitCode = cmd ? 1 : 0;
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

export { httpOk };
