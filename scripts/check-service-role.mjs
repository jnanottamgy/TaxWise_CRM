#!/usr/bin/env node
/**
 * Build check (§0.1 rule 8, §12): the Supabase service-role key must never reach the browser.
 *
 * Run after `next build`:  node scripts/check-service-role.mjs [buildDir]
 *
 * Scans every file the browser can download (`<buildDir>/static/**`, default `.next/static`) and
 * fails (exit 1) when one contains:
 *   - the string SUPABASE_SERVICE_ROLE_KEY (the variable name, i.e. code that reads it was bundled);
 *   - a JWT whose payload says "role":"service_role" (a service-role key inlined as a literal);
 *   - a Supabase secret key (sb_secret_…);
 *   - the actual value of SUPABASE_SERVICE_ROLE_KEY, when it is set in this environment.
 * Exits 2 when there is no build to check. Prints file paths and what matched, never the key.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const SCANNED_EXTENSIONS = /\.(?:js|mjs|cjs|json|map|html|txt|css)$/i;
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{8,}\.(eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{8,}/g;
const SECRET_KEY_PATTERN = /sb_secret_[A-Za-z0-9_-]{8,}/;
const VARIABLE_NAME = "SUPABASE_SERVICE_ROLE_KEY";

/** Decodes a JWT payload segment and reports whether it is a service-role token. */
function isServiceRolePayload(segment) {
  try {
    const json = Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return /"role"\s*:\s*"service_role"/.test(json);
  } catch {
    return false;
  }
}

/**
 * Pure: what in `text` would leak the service role. Exported for tests.
 * @param {string} text
 * @param {{ secretValue?: string | null }} [opts]
 * @returns {string[]} reasons (empty when clean)
 */
export function findLeaks(text, opts = {}) {
  const reasons = [];
  if (text.includes(VARIABLE_NAME)) reasons.push(`mentions ${VARIABLE_NAME}`);
  for (const m of text.matchAll(JWT_PATTERN)) {
    if (isServiceRolePayload(m[1])) {
      reasons.push("contains a JWT with role service_role");
      break;
    }
  }
  if (SECRET_KEY_PATTERN.test(text)) reasons.push("contains a Supabase secret key (sb_secret_…)");
  const secret = opts.secretValue?.trim();
  if (secret && secret.length >= 20 && text.includes(secret)) reasons.push("contains the value of SUPABASE_SERVICE_ROLE_KEY");
  return reasons;
}

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && SCANNED_EXTENSIONS.test(entry.name)) yield full;
  }
}

async function main() {
  const buildDir = resolve(process.argv[2] ?? ".next");
  const staticDir = join(buildDir, "static");
  try {
    const s = await stat(staticDir);
    if (!s.isDirectory()) throw new Error("not a directory");
  } catch {
    console.error(`check-service-role: no client bundle at ${relative(process.cwd(), staticDir) || staticDir}. Run "next build" first.`);
    process.exitCode = 2;
    return;
  }

  const secretValue = process.env.SUPABASE_SERVICE_ROLE_KEY ?? null;
  let scanned = 0;
  const failures = [];
  for await (const file of walk(staticDir)) {
    scanned += 1;
    const text = await readFile(file, "utf8");
    const reasons = findLeaks(text, { secretValue });
    if (reasons.length) failures.push({ file: relative(process.cwd(), file), reasons });
  }

  if (failures.length) {
    console.error(`check-service-role: FAILED. The service-role key can reach the browser through ${failures.length} file(s):`);
    for (const f of failures) console.error(`  ${f.file}: ${f.reasons.join("; ")}`);
    console.error("Only server/admin.ts may read it, and nothing a client component imports may import that file.");
    process.exitCode = 1;
    return;
  }
  console.log(`check-service-role: ok (${scanned} client files scanned, no service-role key or reference found).`);
}

const invokedDirectly = /check-service-role\.mjs$/.test(process.argv[1] ?? "");
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`check-service-role crashed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
