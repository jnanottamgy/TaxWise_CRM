import "server-only";

import { untyped } from "@/lib/supabase/untyped";
import { unstable_rethrow } from "next/navigation";
import { createClient, type ServerSupabase } from "@/lib/supabase/server";
import { EXPECTED_SCHEMA_VERSION, appEnv } from "@/lib/env";
import { SCHEDULED_JOBS } from "@/server/jobs/schedule";
import { EXPECTED_TABLES, EXPECTED_VIEWS } from "@/server/diagnostics-relations";
import { logUnexpected, scrub } from "@/lib/log";
import { DB_ENUMS, type DbEnumName } from "@/lib/domain/enums";
import { todayIST } from "@/lib/domain/fy";
import { checkEnv, VARIABLES } from "@/scripts/env-check";

/**
 * Diagnostics (§7.24, §0.1 rule 1): checks that answer "is this deployment healthy?" even when the
 * database is broken. Partner only, and **gated on the Supabase session alone**: the role comes from
 * the verified token's `app_metadata.role` (writable only by the service role), so a missing or
 * half-migrated `profiles` table can't lock the Partner out of the page that would explain why.
 * When `profiles` does answer, it must agree.
 *
 * Each check runs on its own (the page asks for them one at a time) and reports pass / warn / fail
 * with the database error code. Messages are truncated and scrubbed of connection strings, JWTs
 * and API keys (lib/log.ts scrub). Environment variables are reported as booleans, never values.
 */

export type CheckStatus = "pass" | "warn" | "fail";

export interface DiagnosticItem {
  label: string;
  status: CheckStatus;
  /** Postgres / PostgREST / Storage error code, when there is one. */
  code?: string | null;
  detail?: string | null;
}

export interface DiagnosticResult {
  id: DiagnosticCheckId;
  status: CheckStatus;
  /** One sentence for the row. */
  summary: string;
  code?: string | null;
  items: DiagnosticItem[];
  ms: number;
}

export interface DiagnosticCheckInfo {
  id: DiagnosticCheckId;
  label: string;
  description: string;
}

export const DIAGNOSTIC_CHECKS = [
  { id: "db_connection", label: "Database connection", description: "The app can reach the database through Supabase." },
  { id: "schema_version", label: "Schema version", description: `app_meta.schema_version against the version this code expects (${EXPECTED_SCHEMA_VERSION}).` },
  { id: "tables", label: "Tables and views", description: "A read of every table and view the app uses. A missing one shows as 42P01." },
  { id: "enums", label: "Enum values", description: "Every value the app filters on exists in its Postgres enum (catches a partly migrated database)." },
  { id: "columns", label: "Recently added columns", description: "The newest columns the code reads are there." },
  { id: "rls_helpers", label: "Row-level security helpers", description: "app_role(), is_partner(), can_see_client() and the other helpers exist and answer for you." },
  { id: "storage", label: "Storage buckets", description: "client-documents, task-files, branding and generated exist, with the right visibility." },
  { id: "email", label: "Email", description: "The resolved sender, the sending domain's status and the last delivery error." },
  { id: "env", label: "Environment variables", description: "Required variables for this environment are set and well-formed (shown as yes/no only)." },
  { id: "cron", label: "Scheduled jobs", description: "The last run of each scheduled job and its result." },
] as const satisfies ReadonlyArray<{ id: string; label: string; description: string }>;

export type DiagnosticCheckId = (typeof DIAGNOSTIC_CHECKS)[number]["id"];

export function isDiagnosticCheckId(v: unknown): v is DiagnosticCheckId {
  return typeof v === "string" && DIAGNOSTIC_CHECKS.some((c) => c.id === v);
}

// -------------------------------------------------------------------------------------------------
// The gate
// -------------------------------------------------------------------------------------------------

export type DiagnosticsAccess =
  | { ok: true; supabase: ServerSupabase; userId: string; email: string | null; profileChecked: boolean }
  | { ok: false; reason: "anonymous" | "forbidden" | "unconfigured"; message: string; ref?: string };

/**
 * Partner, from the session alone: `auth.getUser()` (verified by the Auth server) and its
 * `app_metadata.role`. When the profiles table answers, an inactive or non-Partner profile is
 * refused; when it doesn't, the token's role is enough to open diagnostics.
 */
export async function diagnosticsAccess(): Promise<DiagnosticsAccess> {
  let supabase: ServerSupabase;
  try {
    supabase = await createClient();
  } catch (err) {
    unstable_rethrow(err); // cookies() during prerender is Next's dynamic-rendering signal, not a failure
    const ref = logUnexpected(err, { source: "diagnostics:gate" });
    return { ok: false, reason: "unconfigured", message: "Supabase isn't configured on this deployment (NEXT_PUBLIC_SUPABASE_URL or the anon key is missing).", ref };
  }
  let user: { id: string; email?: string | null; app_metadata?: Record<string, unknown> } | null = null;
  try {
    const { data, error } = await supabase.auth.getUser();
    if (!error) user = data.user;
  } catch (err) {
    unstable_rethrow(err);
    user = null;
  }
  if (!user) return { ok: false, reason: "anonymous", message: "Your session has ended. Please sign in again." };
  const role = (user.app_metadata ?? {}).role;
  if (role !== "partner") return { ok: false, reason: "forbidden", message: "Only Partners can open diagnostics." };

  let profileChecked = false;
  try {
    const { data, error } = await supabase.from("profiles").select("role, is_active").eq("id", user.id).maybeSingle();
    if (!error && data) {
      profileChecked = true;
      const p = data as { role: string; is_active: boolean };
      if (p.role !== "partner" || !p.is_active) return { ok: false, reason: "forbidden", message: "Only Partners can open diagnostics." };
    }
  } catch (err) {
    unstable_rethrow(err);
    // The database is unreachable: the verified token decides.
  }
  return { ok: true, supabase, userId: user.id, email: user.email ?? null, profileChecked };
}

// -------------------------------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------------------------------

const MAX_MESSAGE = 200;

/** Scrubbed and truncated, safe to show a Partner. */
export function safeMessage(text: unknown): string {
  const raw = typeof text === "string" ? text : text instanceof Error ? text.message : text == null ? "" : String(text);
  const clean = scrub(raw.replace(/\s+/g, " ").trim());
  return clean.length > MAX_MESSAGE ? `${clean.slice(0, MAX_MESSAGE - 1)}…` : clean;
}

interface DbError {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
}

/** The error code to show: Postgres codes as they are, PostgREST schema-cache misses as 42P01. */
export function errorCode(error: DbError | null | undefined): string {
  if (!error) return "";
  const code = (error.code ?? "").trim();
  const msg = `${error.message ?? ""}`;
  if (code === "PGRST205" || code === "42P01") return code === "42P01" ? "42P01" : "42P01 (PGRST205)";
  if (code === "PGRST204" || code === "42703") return code === "42703" ? "42703" : "42703 (PGRST204)";
  if (code) return code;
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network/i.test(msg)) return "NETWORK";
  return "UNKNOWN";
}

function isMissingRelation(error: DbError): boolean {
  const code = error.code ?? "";
  return code === "42P01" || code === "PGRST205" || /does not exist|could not find the table/i.test(error.message ?? "");
}

function describe(error: DbError): string {
  const parts = [error.message, error.details, error.hint].filter((p): p is string => typeof p === "string" && p.trim().length > 0);
  return safeMessage(parts.join(" · "));
}

/** Runs `fn` over `items`, `limit` at a time, keeping the order of results. */
async function inBatches<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function worst(items: readonly { status: CheckStatus }[]): CheckStatus {
  if (items.some((i) => i.status === "fail")) return "fail";
  if (items.some((i) => i.status === "warn")) return "warn";
  return "pass";
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;
}

// -------------------------------------------------------------------------------------------------
// What the code expects (keep in step with supabase/migrations)
// -------------------------------------------------------------------------------------------------

export { EXPECTED_TABLES, EXPECTED_VIEWS } from "@/server/diagnostics-relations";

/** Where each §5.1 enum can be filtered: a column of that type. */
export const ENUM_COLUMNS: Readonly<Record<DbEnumName, { table: string; column: string }>> = {
  app_role: { table: "profiles", column: "role" },
  client_status: { table: "clients", column: "status" },
  client_priority: { table: "clients", column: "priority" },
  entity_type: { table: "clients", column: "entity_type" },
  gst_registration: { table: "clients", column: "gst_registration" },
  gst_scheme: { table: "clients", column: "gst_scheme" },
  service_type: { table: "client_services", column: "service_type" },
  service_frequency: { table: "client_services", column: "frequency" },
  team_role: { table: "client_team_members", column: "team_role" },
  task_status: { table: "tasks", column: "status" },
  task_priority: { table: "tasks", column: "priority" },
  task_acceptance: { table: "tasks", column: "acceptance_status" },
  decline_reason: { table: "tasks", column: "decline_reason" },
  automation_type: { table: "task_automations", column: "type" },
  automation_frequency: { table: "task_automations", column: "frequency" },
  compliance_type: { table: "compliance_events", column: "type" },
  compliance_status: { table: "compliance_events", column: "status" },
  compliance_workflow: { table: "compliance_events", column: "workflow_status" },
  compliance_source: { table: "compliance_events", column: "source" },
  lead_status: { table: "leads", column: "status" },
  lead_source: { table: "leads", column: "source" },
  quotation_status: { table: "quotations", column: "status" },
  invoice_status: { table: "invoices", column: "status" },
  payment_method: { table: "payment_receipts", column: "method" },
  credit_note_reason: { table: "credit_notes", column: "reason_code" },
  document_category: { table: "documents", column: "category" },
  document_activity: { table: "document_activities", column: "activity" },
  request_status: { table: "document_requests", column: "status" },
  request_item_status: { table: "document_request_items", column: "status" },
  message_channel: { table: "messages", column: "channel" },
  message_direction: { table: "messages", column: "direction" },
  message_status: { table: "messages", column: "status" },
  template_type: { table: "message_templates", column: "type" },
  notification_type: { table: "notifications", column: "type" },
  attendance_status: { table: "attendance_records", column: "status" },
  leave_type: { table: "employee_leave", column: "type" },
  leave_status: { table: "employee_leave", column: "status" },
  engagement_status: { table: "engagement_letters", column: "status" },
  notice_status: { table: "tax_notices", column: "status" },
  registration_status: { table: "statutory_registrations", column: "status" },
  dsc_status: { table: "dsc_records", column: "status" },
  acceptance_outcome: { table: "client_acceptances", column: "outcome" },
  peer_review_status: { table: "peer_reviews", column: "status" },
  audit_event: { table: "audit_logs", column: "event" },
  whatsapp_number_kind: { table: "firm_whatsapp_numbers", column: "kind" },
  whatsapp_group_status: { table: "client_whatsapp_groups", column: "status" },
  whatsapp_member_kind: { table: "client_whatsapp_group_members", column: "kind" },
  cover_kind: { table: "client_covers", column: "kind" },
  cover_reason: { table: "client_covers", column: "reason" },
};

/**
 * The newest columns the code depends on. Add the columns of each migration that alters an existing
 * table here, so a database that missed it says so instead of failing later with "column does not
 * exist" (§0.1 rule 1).
 */
export const RECENT_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: "firm_settings", column: "law_last_reviewed_at" },
  { table: "firm_settings", column: "quality_framework" },
  { table: "firm_settings", column: "digest_enabled" },
  { table: "firm_settings", column: "capacity_thresholds" },
  { table: "firm_settings", column: "round_off_enabled" },
  { table: "firm_settings", column: "e_invoicing_applies" },
  { table: "firm_settings", column: "last_gstr1_reported_month" },
  { table: "firm_settings", column: "quotation_follow_up_days" },
  { table: "firm_settings", column: "whatsapp_linked_device_limit" },
  { table: "profiles", column: "signature_path" },
  { table: "compliance_events", column: "rule_code" },
  { table: "compliance_events", column: "override_id" },
  { table: "compliance_events", column: "original_due_date" },
  { table: "compliance_events", column: "reminder_sent_at" },
  { table: "due_date_rules", column: "verified" },
  { table: "statutory_parameters", column: "verified" },
  { table: "invoices", column: "irn" },
  { table: "udin_records", column: "signed_on" },
  { table: "client_covers", column: "expiry_logged_at" },
  { table: "desktop_devices", column: "revoked_at" },
];

/** The RLS helpers (§4.6) and the arguments to call them with. */
export const RLS_HELPERS: ReadonlyArray<{ name: string; args?: Record<string, unknown>; expectPartner?: boolean }> = [
  { name: "app_role", expectPartner: true },
  { name: "is_partner", expectPartner: true },
  { name: "is_manager_or_partner", expectPartner: true },
  { name: "is_staff", expectPartner: true },
  { name: "is_client" },
  { name: "my_employee_id" },
  { name: "can_see_client", args: { cid: "00000000-0000-0000-0000-000000000000" } },
  { name: "can_open_whatsapp", args: { cid: "00000000-0000-0000-0000-000000000000" } },
];

/** The four private-or-public buckets (§2.3). Only branding is public (for the logo). */
export const EXPECTED_BUCKETS: ReadonlyArray<{ id: string; public: boolean }> = [
  { id: "client-documents", public: false },
  { id: "task-files", public: false },
  { id: "branding", public: true },
  { id: "generated", public: false },
];

/** How stale a job may be before it is flagged, by job name (§8). Names the jobs don't use are ignored. */
const JOB_STALE_HOURS: Readonly<Record<string, number>> = {
  "cover-lifecycle": 3,
  "lead-follow-ups": 3,
  "workforce-sweep": 30,
  "recurring-tasks": 30,
  "upload-cleanup": 30,
  "receivables-sweep": 30,
  escalation: 30,
  digest: 30,
  reminders: 30,
  "retainer-billing": 30,
  "invoice-reminders": 30,
  "absent-without-cover": 30,
  attendance: 30,
  quotations: 30,
  "compliance-top-up": 24 * 32,
  "team-health": 24 * 8,
  "whatsapp-housekeeping": 24 * 8,
  "access-review": 24 * 93,
  "new-fy": 24 * 367,
};

// -------------------------------------------------------------------------------------------------
// The checks
// -------------------------------------------------------------------------------------------------

type CheckFn = (supabase: ServerSupabase) => Promise<Omit<DiagnosticResult, "id" | "ms">>;

const CHECKS: Record<DiagnosticCheckId, CheckFn> = {
  async db_connection(supabase) {
    const started = Date.now();
    const { error } = await supabase.from("app_meta").select("key").limit(1);
    const ms = Date.now() - started;
    if (!error) return { status: ms > 1500 ? "warn" : "pass", summary: `Connected in ${ms} ms.${ms > 1500 ? " That is slow." : ""}`, items: [] };
    if (isMissingRelation(error)) {
      return {
        status: "warn",
        summary: "Connected, but the app_meta table is missing: the migrations haven't been applied.",
        code: errorCode(error),
        items: [],
      };
    }
    return { status: "fail", summary: `Couldn't reach the database: ${describe(error)}`, code: errorCode(error), items: [] };
  },

  async schema_version(supabase) {
    const { data, error } = await supabase.from("app_meta").select("value").eq("key", "schema_version").maybeSingle();
    if (error) return { status: "fail", summary: `Couldn't read app_meta.schema_version: ${describe(error)}`, code: errorCode(error), items: [] };
    const actual = (data as { value: string | null } | null)?.value ?? null;
    const items: DiagnosticItem[] = [
      { label: "Database", status: actual ? "pass" : "fail", detail: actual ?? "not recorded" },
      { label: "This code expects", status: "pass", detail: EXPECTED_SCHEMA_VERSION },
    ];
    if (!actual) return { status: "fail", summary: "The database doesn't record a schema version. Apply the migrations in order.", items };
    if (actual === EXPECTED_SCHEMA_VERSION) return { status: "pass", summary: `Schema ${actual}, as this code expects.`, items };
    const behind = actual.localeCompare(EXPECTED_SCHEMA_VERSION, "en", { numeric: true }) < 0;
    return behind
      ? { status: "fail", summary: `The database is at ${actual}; this code expects ${EXPECTED_SCHEMA_VERSION}. Apply the missing migrations.`, items }
      : { status: "warn", summary: `The database is at ${actual}, newer than this code (${EXPECTED_SCHEMA_VERSION}). Deploy the matching code.`, items };
  },

  async tables(supabase) {
    const names = [...EXPECTED_TABLES.map((n) => ({ name: n, kind: "table" })), ...EXPECTED_VIEWS.map((n) => ({ name: n, kind: "view" }))];
    const items = await inBatches(names, 8, async ({ name, kind }): Promise<DiagnosticItem> => {
      const { error } = await untyped(supabase).from(name).select("*").limit(0);
      if (!error) return { label: name, status: "pass" };
      if (error.code === "42501") return { label: name, status: "pass", code: "42501", detail: `The ${kind} exists; Partners can't read it directly, by design.` };
      return { label: name, status: "fail", code: errorCode(error), detail: isMissingRelation(error) ? `The ${kind} is missing.` : describe(error) };
    });
    const failed = items.filter((i) => i.status === "fail");
    return {
      status: worst(items),
      summary: failed.length
        ? `${failed.length.toLocaleString("en-IN")} of ${plural(items.length, "table and view", "tables and views")} didn't answer.`
        : `All ${plural(items.length, "table and view", "tables and views")} answered.`,
      code: failed[0]?.code ?? null,
      items: failed.length ? failed : [],
    };
  },

  async enums(supabase) {
    const names = Object.keys(DB_ENUMS) as DbEnumName[];
    const results = await inBatches(names, 6, async (name): Promise<DiagnosticItem> => {
      const { table, column } = ENUM_COLUMNS[name];
      const values = DB_ENUMS[name] as readonly string[];
      const { error } = await untyped(supabase).from(table).select(column).in(column, [...values]).limit(0);
      if (!error) return { label: name, status: "pass" };
      if (error.code !== "22P02") return { label: name, status: "fail", code: errorCode(error), detail: `${table}.${column}: ${describe(error)}` };
      // One or more values are missing: find which.
      const missing: string[] = [];
      for (const v of values) {
        const one = await untyped(supabase).from(table).select(column).eq(column, v).limit(0);
        if (one.error?.code === "22P02") missing.push(v);
      }
      return { label: name, status: "fail", code: "22P02", detail: `Missing value${missing.length === 1 ? "" : "s"}: ${missing.join(", ") || "unknown"}.` };
    });
    const failed = results.filter((r) => r.status === "fail");
    const total = names.reduce((n, k) => n + DB_ENUMS[k].length, 0);
    return {
      status: worst(results),
      summary: failed.length ? `${plural(failed.length, "enum doesn't", "enums don't")} match the code.` : `${plural(names.length, "enum")} and all ${total.toLocaleString("en-IN")} values are there.`,
      code: failed[0]?.code ?? null,
      items: failed,
    };
  },

  async columns(supabase) {
    const items = await inBatches(RECENT_COLUMNS, 6, async ({ table, column }): Promise<DiagnosticItem> => {
      const { error } = await untyped(supabase).from(table).select(column).limit(0);
      const label = `${table}.${column}`;
      if (!error) return { label, status: "pass" };
      return { label, status: "fail", code: errorCode(error), detail: describe(error) };
    });
    const failed = items.filter((i) => i.status === "fail");
    return {
      status: worst(items),
      summary: failed.length ? `${plural(failed.length, "column is", "columns are")} missing.` : `All ${plural(items.length, "recent column")} are there.`,
      code: failed[0]?.code ?? null,
      items,
    };
  },

  async rls_helpers(supabase) {
    const items: DiagnosticItem[] = [];
    for (const helper of RLS_HELPERS) {
      const { data, error } = await untyped(supabase).rpc(helper.name, helper.args ?? {});
      if (error) {
        const exists = error.code === "PGRST202" && new RegExp(`\\b${helper.name}\\b`).test(`${error.hint ?? ""}`);
        items.push(
          exists
            ? { label: `${helper.name}()`, status: "warn", code: error.code, detail: `Exists with different arguments: ${safeMessage(error.hint)}` }
            : { label: `${helper.name}()`, status: "fail", code: error.code === "PGRST202" ? "42883 (PGRST202)" : errorCode(error), detail: error.code === "PGRST202" ? "The function is missing." : describe(error) },
        );
        continue;
      }
      if (helper.expectPartner) {
        const answer = helper.name === "app_role" ? data : Boolean(data);
        const good = helper.name === "app_role" ? answer === "partner" : answer === true;
        items.push({
          label: `${helper.name}()`,
          status: good ? "pass" : "fail",
          detail: good ? `Answers ${JSON.stringify(answer)} for you.` : `Answers ${JSON.stringify(answer)} for you, a Partner: row-level security will hide data you should see.`,
        });
      } else {
        items.push({ label: `${helper.name}()`, status: "pass", detail: `Answers ${JSON.stringify(data ?? null)}.` });
      }
    }
    const failed = items.filter((i) => i.status === "fail");
    return {
      status: worst(items),
      summary: failed.length ? `${plural(failed.length, "helper is", "helpers are")} missing or wrong.` : `All ${plural(items.length, "helper")} exist and answer correctly for you.`,
      code: failed[0]?.code ?? null,
      items,
    };
  },

  async storage() {
    let admin: { storage: { getBucket: (id: string) => Promise<{ data: { public: boolean } | null; error: { message: string; statusCode?: string } | null }> } };
    try {
      const mod = await import("@/server/admin");
      admin = mod.createAdminClient() as unknown as typeof admin;
    } catch (err) {
      return { status: "fail", summary: `Couldn't check the buckets: ${safeMessage(err)}`, code: "CONFIG", items: [] };
    }
    const items = await inBatches(EXPECTED_BUCKETS, 4, async (b): Promise<DiagnosticItem> => {
      const { data, error } = await admin.storage.getBucket(b.id);
      if (error || !data) {
        const msg = safeMessage(error?.message ?? "not found");
        return { label: b.id, status: "fail", code: error?.statusCode ?? "404", detail: /not found/i.test(msg) ? "The bucket is missing." : msg };
      }
      if (data.public !== b.public) {
        return {
          label: b.id,
          status: b.public ? "warn" : "fail",
          detail: b.public ? "The bucket is private: the logo won't show on invoices and emails." : "The bucket is PUBLIC: anyone with a link can read its files. Make it private.",
        };
      }
      return { label: b.id, status: "pass", detail: b.public ? "Exists, public-read (logo only)." : "Exists, private." };
    });
    const failed = items.filter((i) => i.status !== "pass");
    return {
      status: worst(items),
      summary: failed.length ? `${plural(failed.length, "bucket needs", "buckets need")} attention.` : "All four buckets exist with the right visibility.",
      code: items.find((i) => i.status === "fail")?.code ?? null,
      items,
    };
  },

  async email(supabase) {
    const items: DiagnosticItem[] = [];
    const deployed = appEnv() === "production" || appEnv() === "staging";
    const settings = await supabase
      .from("firm_settings")
      .select("email_from_name, email_from_address, email_reply_to, sending_domain, domain_status, domain_verified_at")
      .eq("id", 1)
      .maybeSingle();
    if (settings.error) {
      items.push({ label: "Sender", status: "fail", code: errorCode(settings.error), detail: describe(settings.error) });
    } else {
      const s = settings.data as {
        email_from_name: string | null;
        email_from_address: string | null;
        email_reply_to: string | null;
        sending_domain: string | null;
        domain_status: string | null;
        domain_verified_at: string | null;
      } | null;
      const sender = s?.email_from_address ? `${s.email_from_name ?? "TaxWise Consultants"} <${s.email_from_address}>` : (process.env.EMAIL_FROM ?? "TaxWise Consultants <noreply@twchartered.com>");
      items.push({ label: "Sender", status: "pass", detail: safeMessage(sender) });
      items.push({ label: "Reply-to", status: "pass", detail: safeMessage(s?.email_reply_to ?? process.env.EMAIL_REPLY_TO ?? "info@twchartered.com") });
      const status = s?.domain_status ?? "not_started";
      items.push({
        label: `Domain ${s?.sending_domain ?? "twchartered.com"}`,
        status: status === "verified" ? "pass" : status === "failed" ? "fail" : "warn",
        detail:
          status === "verified"
            ? "Verified in Resend."
            : status === "pending"
              ? "Waiting for Resend to see the DNS records (Settings → Email)."
              : status === "failed"
                ? "Resend couldn't verify the DNS records. Check them in Settings → Email."
                : "Not set up yet (Settings → Email).",
      });
    }
    const hasKey = Boolean(process.env.RESEND_API_KEY?.trim());
    items.push({ label: "RESEND_API_KEY set", status: hasKey ? "pass" : deployed ? "fail" : "warn", detail: hasKey ? "yes" : "no" });

    // Every email the app sends is in the delivery ledger (client emails, staff invites, digests,
    // test sends), so the last failure or bounce is read there, not from client messages only.
    const last = await supabase
      .from("email_deliveries")
      .select("kind, status, error, failed_at, bounced_at, updated_at")
      .in("status", ["failed", "bounced"])
      .order("updated_at", { ascending: false })
      .limit(1);
    if (last.error) {
      items.push({ label: "Last delivery error", status: "warn", code: errorCode(last.error), detail: describe(last.error) });
    } else {
      const row = (last.data ?? [])[0];
      const at = row ? (row.status === "bounced" ? row.bounced_at : row.failed_at) ?? row.updated_at : null;
      items.push(
        row
          ? {
              label: "Last delivery error",
              status: "warn",
              detail: `${at ? new Date(at).toISOString().slice(0, 16).replace("T", " ") + " UTC: " : ""}${row.status === "bounced" ? "bounced" : "failed"} (${safeMessage(row.kind.replace(/_/g, " "))}): ${safeMessage(row.error ?? "no message recorded")}`,
            }
          : { label: "Last delivery error", status: "pass", detail: "None recorded." },
      );
    }
    const status = worst(items.filter((i) => i.label !== "Last delivery error"));
    return {
      status,
      summary: status === "pass" ? "Email is configured and the domain is verified." : status === "warn" ? "Email works with gaps: see the items." : "Email can't be sent from this deployment.",
      items,
    };
  },

  async env() {
    const report = checkEnv(process.env);
    const errorNames = new Set(report.errors.map((e) => e.name));
    const items: DiagnosticItem[] = VARIABLES.map((v) => {
      const required = v.requiredIn.includes(report.appEnv);
      const set = report.present[v.name] ?? false;
      const wellFormed = !errorNames.has(v.name);
      const status: CheckStatus = !wellFormed ? "fail" : !set && (required || v.recommendedIn?.includes(report.appEnv)) ? "warn" : "pass";
      return { label: v.name, status, detail: `set: ${set ? "yes" : "no"} · required here: ${required ? "yes" : "no"} · well-formed: ${wellFormed ? "yes" : "no"}` };
    });
    return {
      status: worst(items),
      summary: report.ok
        ? `Every required variable for APP_ENV=${report.appEnv} is set and well-formed.`
        : `${plural(report.errors.length, "variable needs", "variables need")} fixing for APP_ENV=${report.appEnv}. Run npm run env:check on the server for details.`,
      items,
    };
  },

  async cron(supabase) {
    const { data, error } = await supabase.from("job_runs").select("name, started_at, finished_at, status, error").order("started_at", { ascending: false }).limit(500);
    if (error) return { status: "fail", summary: `Couldn't read job_runs: ${describe(error)}`, code: errorCode(error), items: [] };
    const latest = new Map<string, { name: string; started_at: string; finished_at: string | null; status: string; error: string | null }>();
    for (const r of (data ?? []) as Array<{ name: string; started_at: string; finished_at: string | null; status: string; error: string | null }>) {
      if (!latest.has(r.name)) latest.set(r.name, r);
    }
    if (latest.size === 0) {
      return {
        status: "warn",
        summary: "No scheduled job has run yet. Register the cron jobs and run each once.",
        items: Object.entries(SCHEDULED_JOBS).map(([name, when]) => ({ label: name, status: "warn" as const, detail: `Never run (${when} IST).` })),
      };
    }
    const now = Date.now();
    const items: DiagnosticItem[] = [...latest.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((r) => {
        const when = new Date(r.started_at);
        const ageHours = (now - when.getTime()) / 3_600_000;
        const stale = JOB_STALE_HOURS[r.name] !== undefined && ageHours > JOB_STALE_HOURS[r.name];
        const failed = r.status === "failed";
        const running = r.status === "running" && !r.finished_at && ageHours > 1;
        const status: CheckStatus = failed ? "fail" : stale || running || r.status === "partial" ? "warn" : "pass";
        const stamp = `${when.toISOString().slice(0, 16).replace("T", " ")} UTC`;
        const note = failed && r.error ? `: ${safeMessage(r.error)}` : running ? ": still marked running after an hour" : stale ? ": overdue for its next run" : "";
        return { label: r.name, status, detail: `Last run ${stamp}, ${r.status}${note}` };
      });
    // §18.2: every registered job has run once successfully before go-live.
    for (const [name, when] of Object.entries(SCHEDULED_JOBS)) {
      if (!latest.has(name)) items.push({ label: name, status: "warn", detail: `Never run (${when} IST).` });
    }
    const failed = items.filter((i) => i.status === "fail");
    return {
      status: worst(items),
      summary: failed.length ? `${plural(failed.length, "job")} failed on the last run.` : `${plural(latest.size, "job")} reported; none failed on its last run.`,
      items,
    };
  },
};

/** Runs one check. Never throws: an unexpected failure becomes a failed result with its Ref. */
export async function runCheck(id: DiagnosticCheckId, supabase: ServerSupabase): Promise<DiagnosticResult> {
  const started = Date.now();
  try {
    const result = await CHECKS[id](supabase);
    return { id, ...result, ms: Date.now() - started };
  } catch (err) {
    const ref = logUnexpected(err, { source: `diagnostics:${id}` });
    return { id, status: "fail", summary: `The check itself failed: ${safeMessage(err)} (Ref ${ref})`, code: "UNEXPECTED", items: [], ms: Date.now() - started };
  }
}

/** For the copyable report: "2026-10-22 · production". */
export function diagnosticsContext(): { today: string; appEnv: string; expectedSchema: string } {
  return { today: todayIST(), appEnv: appEnv(), expectedSchema: EXPECTED_SCHEMA_VERSION };
}
