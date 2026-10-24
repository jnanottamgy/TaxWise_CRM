/**
 * Typed access to environment variables (§17). Values are read lazily so that a missing
 * optional variable never breaks an unrelated page. `npm run env:check` validates them all.
 */

export type AppEnv = "production" | "staging" | "development" | "test";

export function appEnv(): AppEnv {
  const v = process.env.APP_ENV;
  if (v === "production" || v === "staging" || v === "test") return v;
  return "development";
}

export function isProduction(): boolean {
  return appEnv() === "production";
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing environment variable ${name}. See .env.example.`);
  }
  return v;
}

export const env = {
  appUrl: () => process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  supabaseUrl: () => required("NEXT_PUBLIC_SUPABASE_URL"),
  supabaseAnonKey: () => required("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  /** Only server/admin.ts may call this. */
  supabaseServiceRoleKey: () => required("SUPABASE_SERVICE_ROLE_KEY"),
  cronSecret: () => required("CRON_SECRET"),
  vaultKey: () => required("CREDENTIAL_VAULT_KEY"),
  vaultKeyVersion: () => process.env.CREDENTIAL_VAULT_KEY_VERSION ?? "v1",
  resendApiKey: () => process.env.RESEND_API_KEY ?? null,
  resendWebhookSecret: () => process.env.RESEND_WEBHOOK_SECRET ?? null,
  emailFrom: () => process.env.EMAIL_FROM ?? "TaxWise Consultants <noreply@twchartered.com>",
  emailReplyTo: () => process.env.EMAIL_REPLY_TO ?? "info@twchartered.com",
  firstPartnerEmail: () => process.env.FIRST_PARTNER_EMAIL ?? null,
  desktopDownloadUrl: () => process.env.NEXT_PUBLIC_DESKTOP_DOWNLOAD_URL ?? null,
  sentryDsn: () => process.env.SENTRY_DSN ?? null,
} as const;

/** The schema version this build of the code expects (§0.1 rule 1). Bump with every migration. */
export const EXPECTED_SCHEMA_VERSION = "0239";
