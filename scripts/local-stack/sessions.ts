/**
 * Prints the sign-in cookie for a fixture user of the local QA stack (README.md).
 *
 *   npx tsx scripts/local-stack/sessions.ts P1            Cookie header value (curl -H "Cookie: …")
 *   npx tsx scripts/local-stack/sessions.ts E1 --json     [{ name, value, domain, path }] for Playwright
 *   npx tsx scripts/local-stack/sessions.ts CA --aal1     without the authenticator-app step
 *
 * Keys: P1 P2 (Partners), M1 M2 (Managers), E1–E4 (Employees), CA CB (portal users); see
 * tests/db/fixtures.ts. The token is signed with the stack's throwaway secret and lasts 12 hours.
 */
import { readSecrets } from "./config";
import { authCookies, cookieHeader, fixtureAuthUsers, sessionFor, type Session } from "./jwt";

export function sessionForKey(key: string, opts: { aal?: "aal1" | "aal2" } = {}): Session {
  const secrets = readSecrets();
  if (!secrets) throw new Error("The QA stack has no secrets yet: run `npx tsx scripts/local-stack/stack.ts up` first.");
  const u = fixtureAuthUsers().find((x) => x.key === key.toUpperCase());
  if (!u) throw new Error(`Unknown fixture user ${key}. Use one of ${fixtureAuthUsers().map((x) => x.key).join(", ")}.`);
  return sessionFor(u, secrets.jwtSecret, opts);
}

export function playwrightCookies(session: Session, domain = "localhost") {
  return authCookies(session).map((c) => ({ ...c, domain, path: "/", httpOnly: true, sameSite: "Lax" as const }));
}

function main() {
  const args = process.argv.slice(2);
  const key = args.find((a) => !a.startsWith("--"));
  if (!key) {
    console.error("usage: npx tsx scripts/local-stack/sessions.ts <P1|P2|M1|M2|E1|E2|E3|E4|CA|CB> [--json] [--aal1]");
    process.exit(1);
  }
  const session = sessionForKey(key, { aal: args.includes("--aal1") ? "aal1" : undefined });
  process.stdout.write(args.includes("--json") ? `${JSON.stringify(playwrightCookies(session), null, 2)}\n` : cookieHeader(session));
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
