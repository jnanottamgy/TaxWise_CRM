/**
 * `npm run env:check` (§17, §18.2): checks the environment before a deployment goes live.
 *
 * - Exits non-zero when a required value is missing or malformed: the vault key must be 64 hex
 *   characters, URLs must be valid (https outside development), APP_ENV must be a known value, keys
 *   must look like what they claim to be.
 * - Flags example values copied from .env.example and left in place (an error in production and
 *   staging, a warning elsewhere).
 * - The required set depends on APP_ENV: development and test need only what the app can't start
 *   without; staging and production need everything the firm relies on (the scheduler, the vault).
 * - Never prints a value: only the variable's name and what is wrong with it.
 *
 * Loads .env, .env.local and .env.<mode>.local like Next.js does (pass --no-dotenv to check only the
 * shell environment). The pure check (`checkEnv`) is unit-tested in tests/unit/env-check.test.ts.
 */

export type AppEnvName = "production" | "staging" | "development" | "test";
export const APP_ENV_VALUES: readonly AppEnvName[] = ["production", "staging", "development", "test"];

type Level = "required" | "recommended" | "optional";
type Env = Record<string, string | undefined>;

export interface VariableSpec {
  name: string;
  /** What breaks without it (printed with a missing-value error). */
  breaks: string;
  /** Required in which APP_ENV values; recommended (warning when missing) in which. */
  requiredIn: readonly AppEnvName[];
  recommendedIn?: readonly AppEnvName[];
  /** Returns a sentence when the value is malformed, else null. */
  validate?: (value: string, ctx: { appEnv: AppEnvName; env: Env }) => string | null;
}

export interface EnvIssue {
  name: string;
  level: "error" | "warning";
  message: string;
}

export interface EnvReport {
  appEnv: AppEnvName;
  ok: boolean;
  errors: EnvIssue[];
  warnings: EnvIssue[];
  /** Every known variable and whether it is set (booleans only, never values). */
  present: Record<string, boolean>;
}

const ALL: readonly AppEnvName[] = APP_ENV_VALUES;
const DEPLOYED: readonly AppEnvName[] = ["production", "staging"];
const LOCAL: readonly AppEnvName[] = ["development", "test"];

// -------------------------------------------------------------------------------------------------
// Validators
// -------------------------------------------------------------------------------------------------

function parseUrl(value: string): URL | null {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

function isLocalHost(u: URL): boolean {
  return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "0.0.0.0" || u.hostname.endsWith(".local");
}

function httpUrl(opts: { httpsWhenDeployed: boolean; noLocalhostWhenDeployed?: boolean; noTrailingPath?: boolean }) {
  return (value: string, ctx: { appEnv: AppEnvName }): string | null => {
    const u = parseUrl(value);
    if (!u) return "must be a full http(s) URL, like https://example.com";
    const deployed = ctx.appEnv === "production" || ctx.appEnv === "staging";
    if (deployed && opts.httpsWhenDeployed && u.protocol !== "https:") return `must use https in ${ctx.appEnv}`;
    if (deployed && opts.noLocalhostWhenDeployed && isLocalHost(u)) return `points at ${u.hostname}, which can't be right in ${ctx.appEnv}`;
    if (opts.noTrailingPath && u.pathname !== "/" && u.pathname !== "") return "must be the bare origin, without a path";
    return null;
  };
}

function postgresUrl(value: string): string | null {
  if (!/^postgres(ql)?:\/\/[^\s]+$/.test(value)) return "must be a postgres:// or postgresql:// connection string";
  try {
    const u = new URL(value);
    if (!u.hostname) return "has no host";
  } catch {
    return "isn't a valid connection string";
  }
  return null;
}

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function emailAddress(value: string): string | null {
  return EMAIL_RE.test(value.trim()) ? null : "must be an email address, like info@twchartered.com";
}

/** Decodes a JWT's payload without verifying it (only to catch a key pasted into the wrong place). */
export function jwtRole(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const payload = JSON.parse(json) as { role?: unknown };
    return typeof payload.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

function supabaseAnonKey(value: string): string | null {
  if (value.startsWith("sb_secret_")) return "is a Supabase secret key; this one is shipped to every browser, so it must be the anon/publishable key";
  if (value.startsWith("sb_publishable_")) return null;
  const role = jwtRole(value);
  if (role === null) return "must be the project's anon key (a JWT) or a sb_publishable_ key";
  if (role === "service_role") return "is the service-role key; this one is shipped to every browser, so it must be the anon key";
  if (role !== "anon") return `is a JWT for role "${role}"; expected the anon key`;
  return null;
}

function supabaseServiceKey(value: string, ctx: { env: Env }): string | null {
  if (value === ctx.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) return "is the same as the anon key; paste the service-role (secret) key";
  if (value.startsWith("sb_secret_")) return null;
  if (value.startsWith("sb_publishable_")) return "is a publishable key; paste the secret (service-role) key";
  const role = jwtRole(value);
  if (role === null) return "must be the project's service-role key (a JWT) or a sb_secret_ key";
  if (role !== "service_role") return `is a JWT for role "${role}"; expected the service-role key`;
  return null;
}

function vaultKey(value: string): string | null {
  if (!/^[0-9a-fA-F]{64}$/.test(value.trim())) return "must be exactly 64 hexadecimal characters (generate with: openssl rand -hex 32)";
  if (/^(.)\1{63}$/.test(value.trim())) return "is one character repeated; generate a random key with: openssl rand -hex 32";
  return null;
}

function vaultVersion(value: string): string | null {
  return /^v[1-9][0-9]{0,3}$/.test(value.trim()) ? null : "must look like v1, v2 …";
}

function previousVaultKeys(value: string, ctx: { env: Env }): string | null {
  const current = (ctx.env.CREDENTIAL_VAULT_KEY_VERSION?.trim() || "v1").toLowerCase();
  for (const entry of value.split(",").map((s) => s.trim()).filter(Boolean)) {
    const sep = entry.indexOf(":");
    if (sep <= 0) return "must look like v1:<64 hex>,v2:<64 hex>";
    const version = entry.slice(0, sep).trim().toLowerCase();
    if (vaultVersion(version)) return `has a malformed version label "${version}"`;
    if (version === current) return `repeats the current version ${current}; list only older keys`;
    if (vaultKey(entry.slice(sep + 1))) return `key ${version} must be 64 hexadecimal characters`;
  }
  return null;
}

function minLength(n: number, what: string) {
  return (value: string): string | null => (value.length >= n ? null : `must be at least ${n} characters (${what})`);
}

// -------------------------------------------------------------------------------------------------
// The variables (§17). Keep in step with .env.example (a unit test checks both lists match).
// -------------------------------------------------------------------------------------------------

export const VARIABLES: readonly VariableSpec[] = [
  {
    name: "APP_ENV",
    breaks: "Without it the app assumes development: staging banners and seed-script guards don't know where they are.",
    requiredIn: DEPLOYED,
    recommendedIn: LOCAL,
    validate: (v) => ((APP_ENV_VALUES as readonly string[]).includes(v) ? null : `must be one of ${APP_ENV_VALUES.join(", ")}`),
  },
  {
    name: "NEXT_PUBLIC_APP_URL",
    breaks: "Links in WhatsApp messages, documents and the client portal point at http://localhost:3000.",
    requiredIn: DEPLOYED,
    recommendedIn: LOCAL,
    validate: httpUrl({ httpsWhenDeployed: true, noLocalhostWhenDeployed: true, noTrailingPath: true }),
  },
  {
    name: "NEXT_PUBLIC_SUPABASE_URL",
    breaks: "Nothing works: no sign-in, no data.",
    requiredIn: ALL,
    validate: httpUrl({ httpsWhenDeployed: true, noLocalhostWhenDeployed: true, noTrailingPath: true }),
  },
  {
    name: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    breaks: "Nothing works: no sign-in, no data.",
    requiredIn: ALL,
    validate: supabaseAnonKey,
  },
  {
    name: "SUPABASE_SERVICE_ROLE_KEY",
    breaks: "First-run setup, adding staff, inviting portal users, scheduled jobs and the credential vault fail.",
    requiredIn: ALL,
    validate: supabaseServiceKey,
  },
  {
    name: "DATABASE_URL",
    breaks: "Database scripts and exports that connect directly (not through Supabase) can't reach the database.",
    requiredIn: [],
    recommendedIn: DEPLOYED,
    validate: postgresUrl,
  },
  {
    name: "DIRECT_URL",
    breaks: "Migrations can't run: schema changes hang through the transaction pooler.",
    requiredIn: [],
    recommendedIn: DEPLOYED,
    validate: postgresUrl,
  },
  {
    name: "CREDENTIAL_VAULT_KEY",
    breaks: "Client portal passwords can't be saved or shown. Losing it makes every stored password unreadable: keep an offline copy.",
    requiredIn: DEPLOYED,
    recommendedIn: LOCAL,
    validate: vaultKey,
  },
  {
    name: "CREDENTIAL_VAULT_KEY_VERSION",
    breaks: "Defaults to v1. Set it when rotating the vault key.",
    requiredIn: [],
    validate: vaultVersion,
  },
  {
    name: "CREDENTIAL_VAULT_PREVIOUS_KEYS",
    breaks: "Only needed while rotating the vault key: without the old key, values sealed with it can't be re-encrypted.",
    requiredIn: [],
    validate: previousVaultKeys,
  },
  {
    name: "CRON_SECRET",
    breaks: "Scheduled jobs (reminders, escalations, retainer drafts, attendance) refuse to run: nothing happens on schedule.",
    requiredIn: DEPLOYED,
    validate: minLength(32, "generate with: openssl rand -hex 32"),
  },
  {
    name: "FIRST_PARTNER_EMAIL",
    breaks: "Bootstrap only: without it, whoever opens /setup first while no users exist becomes the first Partner.",
    requiredIn: [],
    recommendedIn: DEPLOYED,
    validate: emailAddress,
  },
  {
    name: "APP_BUILD_ID",
    breaks: "Optional: /api/health reports the package version only (plus the commit on Netlify, which sets COMMIT_REF during the build).",
    requiredIn: [],
    validate: (v) => (/^[0-9a-zA-Z._-]{1,64}$/.test(v) ? null : "must be 1 to 64 letters, digits, dots, dashes or underscores"),
  },
  {
    name: "SENTRY_DSN",
    breaks: "Optional: errors are only in the server logs (each with its Ref).",
    requiredIn: [],
    validate: httpUrl({ httpsWhenDeployed: true }),
  },
];

/**
 * The placeholder values written in .env.example. A value still equal to one of these was copied
 * and never filled in.
 */
export const EXAMPLE_VALUES: Readonly<Record<string, string>> = {
  APP_ENV: "development",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  NEXT_PUBLIC_SUPABASE_URL: "https://your-project-ref.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "your-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "your-service-role-key",
  DATABASE_URL: "postgresql://postgres.your-project-ref:your-db-password@aws-0-ap-south-1.pooler.supabase.com:6543/postgres",
  DIRECT_URL: "postgresql://postgres.your-project-ref:your-db-password@aws-0-ap-south-1.pooler.supabase.com:5432/postgres",
  CREDENTIAL_VAULT_KEY: "replace-with-64-hex-characters-from-openssl-rand-hex-32",
  CREDENTIAL_VAULT_KEY_VERSION: "v1",
  CREDENTIAL_VAULT_PREVIOUS_KEYS: "",
  CRON_SECRET: "replace-with-a-long-random-string",
  FIRST_PARTNER_EMAIL: "",
  APP_BUILD_ID: "",
  SENTRY_DSN: "",
};

/** Example values that are also legitimate real values (the firm's own defaults), never flagged. */
const EXAMPLE_VALUES_THAT_ARE_REAL = new Set([
  "APP_ENV",
  "NEXT_PUBLIC_APP_URL", // localhost is right for development; the URL check refuses it when deployed
  "CREDENTIAL_VAULT_KEY_VERSION",
]);

/** Placeholder wording that means "not filled in", wherever it appears. */
const PLACEHOLDER_MARKERS = [/your[-_]/i, /replace[-_ ]?(me|with)/i, /changeme/i, /<[^>]*here>/i, /x{8,}/i, /example\.(com|org)/i];

export function looksLikeExample(name: string, value: string): boolean {
  if (EXAMPLE_VALUES_THAT_ARE_REAL.has(name)) return false;
  const example = EXAMPLE_VALUES[name];
  if (example && value === example) return true;
  return PLACEHOLDER_MARKERS.some((re) => re.test(value));
}

/** Resolves APP_ENV; an unknown value is reported by the APP_ENV check and treated as development. */
export function resolveAppEnv(env: Env): AppEnvName {
  const v = env.APP_ENV?.trim();
  return v && (APP_ENV_VALUES as readonly string[]).includes(v) ? (v as AppEnvName) : "development";
}

/** The pure check: no I/O, no printing. */
export function checkEnv(env: Env): EnvReport {
  const appEnv = resolveAppEnv(env);
  const deployed = appEnv === "production" || appEnv === "staging";
  const errors: EnvIssue[] = [];
  const warnings: EnvIssue[] = [];
  const present: Record<string, boolean> = {};

  for (const spec of VARIABLES) {
    const raw = env[spec.name];
    const value = raw?.trim() ?? "";
    present[spec.name] = value !== "";
    const level: Level = spec.requiredIn.includes(appEnv)
      ? "required"
      : spec.recommendedIn?.includes(appEnv)
        ? "recommended"
        : "optional";

    if (!value) {
      if (level === "required") errors.push({ name: spec.name, level: "error", message: `is missing. ${spec.breaks}` });
      else if (level === "recommended") warnings.push({ name: spec.name, level: "warning", message: `is not set. ${spec.breaks}` });
      continue;
    }

    if (looksLikeExample(spec.name, value)) {
      const issue: EnvIssue = {
        name: spec.name,
        level: deployed ? "error" : "warning",
        message: "still has the example value from .env.example. Replace it with the real value.",
      };
      (deployed ? errors : warnings).push(issue);
      continue;
    }

    const problem = spec.validate?.(value, { appEnv, env });
    if (problem) {
      // A malformed value is wrong whatever the environment: it would fail when used.
      errors.push({ name: spec.name, level: "error", message: problem });
    }
  }

  if (env.APP_ENV?.trim() && !APP_ENV_VALUES.includes(env.APP_ENV.trim() as AppEnvName)) {
    // Already reported by the APP_ENV validator; make the fallback explicit.
    warnings.push({ name: "APP_ENV", level: "warning", message: "is unknown, so the other checks ran as development." });
  }

  if (appEnv === "production") {
    const supa = parseUrl(env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "");
    const app = parseUrl(env.NEXT_PUBLIC_APP_URL?.trim() ?? "");
    const host = app ? /(^|\.)((netlify|vercel)\.app)$/.exec(app.hostname) : null;
    if (host) {
      warnings.push({
        name: "NEXT_PUBLIC_APP_URL",
        level: "warning",
        message: `is a ${host[2]} address. The live firm uses its own domain only (§18.2).`,
      });
    }
    if (supa && /staging/i.test(supa.hostname)) {
      errors.push({ name: "NEXT_PUBLIC_SUPABASE_URL", level: "error", message: "looks like the staging project; production must use its own Supabase project." });
    }
  }

  return { appEnv, ok: errors.length === 0, errors, warnings, present };
}

/** The report as text lines (names and problems only, never values). */
export function formatReport(report: EnvReport): string[] {
  const lines: string[] = [];
  lines.push(`Environment check for APP_ENV=${report.appEnv}`);
  lines.push("");
  const issueFor = new Map<string, EnvIssue[]>();
  for (const i of [...report.errors, ...report.warnings]) {
    const list = issueFor.get(i.name) ?? [];
    list.push(i);
    issueFor.set(i.name, list);
  }
  const width = Math.max(...VARIABLES.map((v) => v.name.length));
  for (const spec of VARIABLES) {
    const issues = issueFor.get(spec.name) ?? [];
    const status = issues.some((i) => i.level === "error")
      ? "FAIL"
      : issues.length
        ? "WARN"
        : report.present[spec.name]
          ? "ok"
          : "-";
    const first = issues[0];
    lines.push(`  ${status.padEnd(4)}  ${spec.name.padEnd(width)}  ${first ? first.message : report.present[spec.name] ? "set" : "not set (optional here)"}`);
    for (const extra of issues.slice(1)) lines.push(`  ${"".padEnd(4)}  ${"".padEnd(width)}  ${extra.message}`);
  }
  lines.push("");
  lines.push(
    report.ok
      ? `Passed with ${report.warnings.length} warning${report.warnings.length === 1 ? "" : "s"}.`
      : `Failed: ${report.errors.length} problem${report.errors.length === 1 ? "" : "s"} to fix before this environment is used.`,
  );
  return lines;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.includes("--no-dotenv")) {
    try {
      const { loadEnvConfig } = await import("@next/env");
      const dev = (process.env.APP_ENV ?? "development") !== "production";
      loadEnvConfig(process.cwd(), dev, { info: () => undefined, error: console.error });
    } catch {
      // @next/env ships with Next.js; without it, check the shell environment only.
    }
  }
  const report = checkEnv(process.env);
  for (const line of formatReport(report)) console.log(line);
  process.exitCode = report.ok ? 0 : 1;
}

const invokedDirectly = typeof process !== "undefined" && /env-check\.(?:ts|js|mjs|cjs)$/.test(process.argv[1] ?? "");
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(`env-check crashed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
