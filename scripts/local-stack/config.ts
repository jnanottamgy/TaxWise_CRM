/**
 * Shared settings for the local QA stack (scripts/local-stack/README.md).
 *
 * Everything here points at this machine: a local Postgres database, PostgREST and a small stand-in
 * for the Supabase HTTP API. Nothing in the stack ever talks to a real Supabase project.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const ROOT = resolve(__dirname, "..", "..");

/** Runtime state: secrets, pid files, logs, PostgREST config. Ignores itself in git (see ensureStateDir). */
export const STATE_DIR = process.env.QA_STACK_DIR ? resolve(process.env.QA_STACK_DIR) : join(ROOT, ".local-stack");
export const PID_DIR = join(STATE_DIR, "pids");
/**
 * Logs live outside the project tree: `next dev` (Turbopack + Tailwind's source scan) treats a file
 * changing anywhere in the project as a change to the CSS, and the app log changes on every request,
 * so a log inside the project put every open page into a reload loop. $QA_LOG_DIR overrides.
 */
export const LOG_DIR = process.env.QA_LOG_DIR ? resolve(process.env.QA_LOG_DIR) : join(tmpdir(), "taxwise-qa-stack", "logs");
export const BIN_DIR = join(STATE_DIR, "bin");

export const QA_DB = process.env.QA_DB ?? "taxwise_qa";

export const PORTS = {
  postgrest: Number(process.env.QA_POSTGREST_PORT ?? 3333),
  mock: Number(process.env.QA_MOCK_PORT ?? 54321),
  app: Number(process.env.QA_APP_PORT ?? 3100),
} as const;

/** What the app is told the Supabase project is. The cookie name derives from it (sb-127-auth-token). */
export const SUPABASE_URL = `http://127.0.0.1:${PORTS.mock}`;
export const POSTGREST_URL = `http://127.0.0.1:${PORTS.postgrest}`;
export const APP_URL = `http://localhost:${PORTS.app}`;

/** The one authenticator-app code the stand-in accepts on /mfa (local stack only). */
export const QA_TOTP_CODE = "123456";

export const STATE_FILES = {
  secrets: join(STATE_DIR, "secrets.json"),
  users: join(STATE_DIR, "users.json"),
  postgrestConf: join(STATE_DIR, "postgrest.conf"),
  buildStamp: join(STATE_DIR, "build-stamp.json"),
  appMode: join(STATE_DIR, "app-mode"),
} as const;

export function ensureStateDir(): void {
  for (const d of [STATE_DIR, PID_DIR, LOG_DIR, BIN_DIR]) mkdirSync(d, { recursive: true });
  const ignore = join(STATE_DIR, ".gitignore");
  // A self-ignoring directory: git never sees the secrets, logs or binaries in it.
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
}

export type StackSecrets = {
  /** HS256 secret shared by PostgREST and the auth stand-in. Throwaway, made on first `up`. */
  jwtSecret: string;
  /** CREDENTIAL_VAULT_KEY for the app and the QA dataset (64 hex). Throwaway. */
  vaultKey: string;
  cronSecret: string;
  /** Password of the cluster-wide `authenticator` login role PostgREST connects as. */
  authenticatorPassword: string;
  /** The one password the auth stand-in accepts for every fixture user on /login. Random per stack (§0.1 rule 14). */
  qaPassword: string;
  createdAt: string;
};

export function readSecrets(): StackSecrets | null {
  if (!existsSync(STATE_FILES.secrets)) return null;
  const secrets = JSON.parse(readFileSync(STATE_FILES.secrets, "utf8")) as StackSecrets;
  if (!secrets.qaPassword) {
    // Secrets written before the sign-in password moved here: add one and keep everything else.
    secrets.qaPassword = randomBytes(9).toString("base64url");
    writeFileSync(STATE_FILES.secrets, JSON.stringify(secrets, null, 2));
    chmodSync(STATE_FILES.secrets, 0o600);
  }
  return secrets;
}

/** The stack's secrets, generated on first use and kept until `down --purge`. */
export function loadOrCreateSecrets(): StackSecrets {
  const existing = readSecrets();
  if (existing) return existing;
  ensureStateDir();
  const secrets: StackSecrets = {
    jwtSecret: randomBytes(32).toString("hex"),
    vaultKey: randomBytes(32).toString("hex"),
    cronSecret: randomBytes(24).toString("hex"),
    authenticatorPassword: randomBytes(16).toString("hex"),
    qaPassword: randomBytes(9).toString("base64url"),
    createdAt: new Date().toISOString(),
  };
  writeFileSync(STATE_FILES.secrets, JSON.stringify(secrets, null, 2));
  chmodSync(STATE_FILES.secrets, 0o600);
  return secrets;
}

function firstExisting(paths: Array<string | undefined>): string | null {
  for (const p of paths) if (p && existsSync(p)) return p;
  return null;
}

/** PostgREST 12.2.3 static binary: $QA_POSTGREST_BIN, else .local-stack/bin/postgrest. */
export function postgrestBin(): string | null {
  return firstExisting([process.env.QA_POSTGREST_BIN, join(BIN_DIR, "postgrest")]);
}

/** chrome-headless-shell for Playwright: $QA_CHROME_BIN, else .local-stack/bin/chrome-headless-shell-linux64/… */
export function chromeBin(): string | null {
  return firstExisting([
    process.env.QA_CHROME_BIN,
    join(BIN_DIR, "chrome-headless-shell-linux64", "chrome-headless-shell"),
    join(BIN_DIR, "chrome-headless-shell"),
  ]);
}

export const DOWNLOADS = {
  postgrest: "https://github.com/PostgREST/postgrest/releases/download/v12.2.3/postgrest-v12.2.3-linux-static-x64.tar.xz",
  chrome: "https://storage.googleapis.com/chrome-for-testing-public/131.0.6778.204/linux64/chrome-headless-shell-linux64.zip",
} as const;
