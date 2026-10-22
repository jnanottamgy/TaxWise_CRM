import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkEnv, EXAMPLE_VALUES, formatReport, jwtRole, looksLikeExample, resolveAppEnv, VARIABLES } from "@/scripts/env-check";
import { findLeaks } from "@/scripts/check-service-role.mjs";

/** An unsigned JWT-shaped token with the given role (only the payload is read by the check). */
function fakeJwt(role: string): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: "supabase", role, ref: "abcdefghijklmnop" })}.c2lnbmF0dXJl`;
}

const VAULT_KEY = "4f1c2a9b7e3d5c8a0b6e2f4d9c1a7b3e5d8f0a2c4e6b8d1f3a5c7e9b0d2f4a6c";

/** A complete, valid production environment. */
function production(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    APP_ENV: "production",
    NEXT_PUBLIC_APP_URL: "https://app.twchartered.com",
    NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnop.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: fakeJwt("anon"),
    SUPABASE_SERVICE_ROLE_KEY: fakeJwt("service_role"),
    DATABASE_URL: "postgresql://postgres.abcdefghijklmnop:s3cret@aws-0-ap-south-1.pooler.supabase.com:6543/postgres",
    DIRECT_URL: "postgresql://postgres.abcdefghijklmnop:s3cret@aws-0-ap-south-1.pooler.supabase.com:5432/postgres",
    CREDENTIAL_VAULT_KEY: VAULT_KEY,
    CREDENTIAL_VAULT_KEY_VERSION: "v1",
    CRON_SECRET: "9d2c7a1e4b8f3d6c0a5e2b7f1c4d8a3e",
    RESEND_API_KEY: "re_Ab12Cd34Ef56Gh78",
    RESEND_WEBHOOK_SECRET: "whsec_Zx98Yw76Vu54",
    EMAIL_FROM: "TaxWise Consultants <noreply@twchartered.com>",
    EMAIL_REPLY_TO: "info@twchartered.com",
    FIRST_PARTNER_EMAIL: "partner@twchartered.com",
    ...overrides,
  };
}

const names = (issues: { name: string }[]) => issues.map((i) => i.name);

describe("env-check: APP_ENV", () => {
  it("resolves known values and falls back to development", () => {
    expect(resolveAppEnv({ APP_ENV: "production" })).toBe("production");
    expect(resolveAppEnv({ APP_ENV: "staging" })).toBe("staging");
    expect(resolveAppEnv({})).toBe("development");
    expect(resolveAppEnv({ APP_ENV: "prod" })).toBe("development");
  });

  it("fails on an unknown APP_ENV", () => {
    const r = checkEnv(production({ APP_ENV: "prod" }));
    expect(r.ok).toBe(false);
    expect(names(r.errors)).toContain("APP_ENV");
  });
});

describe("env-check: a complete production environment", () => {
  it("passes", () => {
    const r = checkEnv(production());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("reports presence as booleans only", () => {
    const r = checkEnv(production());
    expect(r.present.CREDENTIAL_VAULT_KEY).toBe(true);
    expect(r.present.SENTRY_DSN).toBe(false);
    expect(Object.values(r.present).every((v) => typeof v === "boolean")).toBe(true);
  });

  it("never prints a value", () => {
    const env = production();
    const text = formatReport(checkEnv(env)).join("\n");
    for (const name of ["CREDENTIAL_VAULT_KEY", "SUPABASE_SERVICE_ROLE_KEY", "CRON_SECRET", "RESEND_API_KEY", "DATABASE_URL"]) {
      expect(text).not.toContain(env[name] as string);
    }
  });
});

describe("env-check: required set depends on APP_ENV", () => {
  it("production needs the vault key, cron secret, Resend and the webhook secret", () => {
    for (const name of ["CREDENTIAL_VAULT_KEY", "CRON_SECRET", "RESEND_API_KEY", "RESEND_WEBHOOK_SECRET", "EMAIL_FROM", "NEXT_PUBLIC_APP_URL"]) {
      const r = checkEnv(production({ [name]: undefined }));
      expect(r.ok, name).toBe(false);
      expect(names(r.errors), name).toContain(name);
    }
  });

  it("staging needs the vault key but only recommends the webhook secret", () => {
    const staging = production({ APP_ENV: "staging", RESEND_WEBHOOK_SECRET: undefined });
    const r = checkEnv(staging);
    expect(r.ok).toBe(true);
    expect(names(r.warnings)).toContain("RESEND_WEBHOOK_SECRET");
    expect(checkEnv({ ...staging, CREDENTIAL_VAULT_KEY: undefined }).ok).toBe(false);
  });

  it("development needs only Supabase", () => {
    const dev = {
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: fakeJwt("anon"),
      SUPABASE_SERVICE_ROLE_KEY: fakeJwt("service_role"),
    };
    const r = checkEnv(dev);
    expect(r.appEnv).toBe("development");
    expect(r.ok).toBe(true);
    expect(names(r.warnings)).toEqual(expect.arrayContaining(["CREDENTIAL_VAULT_KEY", "RESEND_API_KEY"]));
    expect(checkEnv({ ...dev, NEXT_PUBLIC_SUPABASE_URL: undefined }).ok).toBe(false);
  });

  it("DIRECT_URL and DATABASE_URL are recommended, not required, when deployed", () => {
    const r = checkEnv(production({ DIRECT_URL: undefined, DATABASE_URL: undefined }));
    expect(r.ok).toBe(true);
    expect(names(r.warnings)).toEqual(expect.arrayContaining(["DIRECT_URL", "DATABASE_URL"]));
  });
});

describe("env-check: malformed values", () => {
  it("vault key must be 64 hex characters", () => {
    for (const bad of [VAULT_KEY.slice(2), `${VAULT_KEY}ab`, VAULT_KEY.replace("4", "z"), "a".repeat(64)]) {
      const r = checkEnv(production({ CREDENTIAL_VAULT_KEY: bad }));
      expect(r.ok, bad).toBe(false);
      expect(names(r.errors)).toContain("CREDENTIAL_VAULT_KEY");
    }
  });

  it("a malformed optional value still fails, even in development", () => {
    const r = checkEnv({
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: fakeJwt("anon"),
      SUPABASE_SERVICE_ROLE_KEY: fakeJwt("service_role"),
      CREDENTIAL_VAULT_KEY: "too-short",
      CREDENTIAL_VAULT_KEY_VERSION: "1",
      SENTRY_DSN: "not a url",
    });
    expect(names(r.errors)).toEqual(expect.arrayContaining(["CREDENTIAL_VAULT_KEY", "CREDENTIAL_VAULT_KEY_VERSION", "SENTRY_DSN"]));
  });

  it("URLs must be valid, https and not localhost when deployed", () => {
    expect(checkEnv(production({ NEXT_PUBLIC_APP_URL: "app.twchartered.com" })).ok).toBe(false);
    expect(checkEnv(production({ NEXT_PUBLIC_APP_URL: "http://app.twchartered.com" })).ok).toBe(false);
    expect(checkEnv(production({ NEXT_PUBLIC_APP_URL: "https://localhost:3000" })).ok).toBe(false);
    expect(checkEnv(production({ NEXT_PUBLIC_SUPABASE_URL: "http://abcdefghijklmnop.supabase.co" })).ok).toBe(false);
    expect(checkEnv(production({ NEXT_PUBLIC_APP_URL: "https://app.twchartered.com/dashboard" })).ok).toBe(false);
  });

  it("refuses the service-role key in the browser-visible anon slot", () => {
    const r = checkEnv(production({ NEXT_PUBLIC_SUPABASE_ANON_KEY: fakeJwt("service_role") }));
    expect(r.ok).toBe(false);
    expect(r.errors.find((e) => e.name === "NEXT_PUBLIC_SUPABASE_ANON_KEY")?.message).toMatch(/service-role/);
    expect(checkEnv(production({ NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_secret_abc123" })).ok).toBe(false);
    expect(checkEnv(production({ NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_abc123" })).ok).toBe(true);
  });

  it("refuses an anon key pasted as the service-role key", () => {
    const anon = fakeJwt("anon");
    expect(checkEnv(production({ SUPABASE_SERVICE_ROLE_KEY: anon })).ok).toBe(false);
    expect(checkEnv(production({ NEXT_PUBLIC_SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_ROLE_KEY: anon })).ok).toBe(false);
    expect(checkEnv(production({ SUPABASE_SERVICE_ROLE_KEY: "sb_secret_abc123" })).ok).toBe(true);
  });

  it("checks key prefixes, email formats, the cron secret length and connection strings", () => {
    expect(names(checkEnv(production({ RESEND_API_KEY: "sk_live_123" })).errors)).toContain("RESEND_API_KEY");
    expect(names(checkEnv(production({ RESEND_WEBHOOK_SECRET: "abc" })).errors)).toContain("RESEND_WEBHOOK_SECRET");
    expect(names(checkEnv(production({ EMAIL_FROM: "TaxWise <not-an-email>" })).errors)).toContain("EMAIL_FROM");
    expect(names(checkEnv(production({ EMAIL_FROM: "<noreply@twchartered.com>" })).errors)).toContain("EMAIL_FROM");
    expect(checkEnv(production({ EMAIL_FROM: "noreply@twchartered.com" })).ok).toBe(true);
    expect(names(checkEnv(production({ EMAIL_REPLY_TO: "info at twchartered" })).errors)).toContain("EMAIL_REPLY_TO");
    expect(names(checkEnv(production({ CRON_SECRET: "short" })).errors)).toContain("CRON_SECRET");
    expect(names(checkEnv(production({ DIRECT_URL: "mysql://x" })).errors)).toContain("DIRECT_URL");
  });

  it("checks the previous vault keys list used during rotation", () => {
    const other = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
    expect(checkEnv(production({ CREDENTIAL_VAULT_KEY_VERSION: "v2", CREDENTIAL_VAULT_PREVIOUS_KEYS: `v1:${other}` })).ok).toBe(true);
    expect(checkEnv(production({ CREDENTIAL_VAULT_KEY_VERSION: "v2", CREDENTIAL_VAULT_PREVIOUS_KEYS: other })).ok).toBe(false);
    expect(checkEnv(production({ CREDENTIAL_VAULT_KEY_VERSION: "v2", CREDENTIAL_VAULT_PREVIOUS_KEYS: `v2:${other}` })).ok).toBe(false);
  });
});

describe("env-check: example values left in place", () => {
  it("are errors in production", () => {
    const r = checkEnv(production({ CRON_SECRET: EXAMPLE_VALUES.CRON_SECRET, RESEND_API_KEY: EXAMPLE_VALUES.RESEND_API_KEY }));
    expect(r.ok).toBe(false);
    expect(names(r.errors)).toEqual(expect.arrayContaining(["CRON_SECRET", "RESEND_API_KEY"]));
    expect(r.errors.find((e) => e.name === "CRON_SECRET")?.message).toMatch(/example value/);
  });

  it("are warnings in development", () => {
    const r = checkEnv({
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: fakeJwt("anon"),
      SUPABASE_SERVICE_ROLE_KEY: fakeJwt("service_role"),
      CREDENTIAL_VAULT_KEY: EXAMPLE_VALUES.CREDENTIAL_VAULT_KEY,
    });
    expect(r.ok).toBe(true);
    expect(names(r.warnings)).toContain("CREDENTIAL_VAULT_KEY");
  });

  it("recognise placeholder wording and leave the firm's real defaults alone", () => {
    expect(looksLikeExample("NEXT_PUBLIC_SUPABASE_URL", "https://your-project-ref.supabase.co")).toBe(true);
    expect(looksLikeExample("CRON_SECRET", "changeme-please")).toBe(true);
    expect(looksLikeExample("EMAIL_FROM", EXAMPLE_VALUES.EMAIL_FROM)).toBe(false);
    expect(looksLikeExample("EMAIL_REPLY_TO", EXAMPLE_VALUES.EMAIL_REPLY_TO)).toBe(false);
    expect(looksLikeExample("CRON_SECRET", "9d2c7a1e4b8f3d6c0a5e2b7f1c4d8a3e")).toBe(false);
  });
});

describe("env-check: production sanity", () => {
  it("refuses a staging Supabase project in production", () => {
    expect(checkEnv(production({ NEXT_PUBLIC_SUPABASE_URL: "https://taxwise-staging.supabase.co" })).ok).toBe(false);
  });

  it("warns about a vercel.app address in production", () => {
    const r = checkEnv(production({ NEXT_PUBLIC_APP_URL: "https://taxwise.vercel.app" }));
    expect(r.ok).toBe(true);
    expect(names(r.warnings)).toContain("NEXT_PUBLIC_APP_URL");
  });
});

describe("env-check: jwtRole", () => {
  it("reads the role claim and tolerates junk", () => {
    expect(jwtRole(fakeJwt("anon"))).toBe("anon");
    expect(jwtRole(fakeJwt("service_role"))).toBe("service_role");
    expect(jwtRole("not-a-jwt")).toBeNull();
    expect(jwtRole("a.b.c")).toBeNull();
  });
});

describe(".env.example documents every variable (§17)", () => {
  const text = readFileSync(join(process.cwd(), ".env.example"), "utf8");
  const documented = [...text.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)].map((m) => ({ name: m[1], value: m[2] }));

  it("lists exactly the variables env-check knows", () => {
    expect(documented.map((d) => d.name).sort()).toEqual(VARIABLES.map((v) => v.name).sort());
  });

  it("uses the example values env-check flags", () => {
    for (const d of documented) expect(EXAMPLE_VALUES[d.name], d.name).toBe(d.value);
  });

  it("explains each variable with what breaks without it", () => {
    for (const v of VARIABLES) {
      const idx = text.indexOf(`\n${v.name}=`);
      expect(idx, v.name).toBeGreaterThan(0);
      const preceding = text.slice(Math.max(0, idx - 600), idx);
      expect(preceding, v.name).toMatch(/Without it|Without them/);
    }
  });

  it("holds no real secrets", () => {
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./);
    expect(text).not.toMatch(/(^|=)[0-9a-f]{64}$/m);
    expect(text).not.toMatch(/re_[A-Za-z0-9]{20,}/);
  });
});

describe("check-service-role: what may never reach a client bundle (§0.1 rule 8, §12)", () => {
  it("passes ordinary client code, including the anon key", () => {
    expect(findLeaks(`const url = process.env.NEXT_PUBLIC_SUPABASE_URL; const k = "${fakeJwt("anon")}";`)).toEqual([]);
  });

  it("flags code that reads the service-role variable", () => {
    expect(findLeaks("const k = process.env.SUPABASE_SERVICE_ROLE_KEY")).toEqual(["mentions SUPABASE_SERVICE_ROLE_KEY"]);
  });

  it("flags an inlined service-role JWT and a Supabase secret key", () => {
    expect(findLeaks(`createClient(u, "${fakeJwt("service_role")}")`)).toContain("contains a JWT with role service_role");
    expect(findLeaks('const k = "sb_secret_abcdefghijklmnop"')).toContain("contains a Supabase secret key (sb_secret_…)");
  });

  it("flags the deployment's actual key value, and ignores a value too short to be one", () => {
    const secret = "a-real-looking-service-key-value-0123456789";
    expect(findLeaks(`x="${secret}"`, { secretValue: secret })).toContain("contains the value of SUPABASE_SERVICE_ROLE_KEY");
    expect(findLeaks('x="short"', { secretValue: "short" })).toEqual([]);
  });
});
