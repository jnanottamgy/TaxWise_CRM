import "server-only";

import { unstable_rethrow } from "next/navigation";
import { headers } from "next/headers";
import type { z } from "zod";
import { getSession, type CurrentUser } from "@/lib/auth/current-user";
import type { AppRole } from "@/lib/auth/roles";
import type { ServerSupabase } from "@/lib/supabase/server";
import { ActionError, fail, ok, unexpectedMessage, type ActionResult, type FieldErrors } from "@/lib/result";
import { log, logUnexpected } from "@/lib/log";

/** audit_event enum (§5.1). */
export type AuditEvent =
  | "login_success" | "login_failure" | "logout" | "password_change" | "access_denied"
  | "permission_change" | "data_create" | "data_update" | "data_delete" | "file_upload"
  | "file_download" | "credential_viewed" | "config_change" | "user_create" | "user_update"
  | "user_disable" | "export_run" | "record_viewed";

export interface AuditEntry {
  event: AuditEvent;
  resourceType: string;
  resourceId?: string | null;
  action?: string;
  details?: Record<string, unknown>;
  success?: boolean;
  error?: string;
}

export interface ActionContext {
  user: CurrentUser;
  /** The user's own session client: RLS applies to everything done through it. */
  supabase: ServerSupabase;
  ip: string | null;
  userAgent: string | null;
  /**
   * Queue work that must run AFTER the main write and must never fail it (§0.1 rule 5):
   * emails, notifications, timeline entries, compliance generation. If `fn` throws, the action
   * still succeeds and `warning` is returned to the user (default: "<label> didn't go through.").
   */
  after(label: string, fn: () => Promise<unknown>, warning?: string): void;
  /** Writes an audit row through the insert-only `log_audit_event` function (§0.1 rule 12). Never throws. */
  audit(entry: AuditEntry): Promise<void>;
}

export interface ActionConfig<S extends z.ZodType> {
  /** Used in logs: "<module>.<verb>", e.g. "clients.create". */
  name: string;
  schema: S;
  /** Roles allowed to call this action. Checked against profiles.role. Omit = any signed-in active user. */
  roles?: readonly AppRole[];
  /** Only /set-password's action sets this: everything else refuses until the password is changed (§4.4). */
  allowMustChangePassword?: boolean;
}

function zodFieldErrors(error: z.ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? issue.path.join(".") : "_form";
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

/**
 * Wraps a server action so it can never let an exception reach the user (§0.1 rule 2):
 * session + role check (profiles.role) → forced-password-change gate → zod parse → handler →
 * after-effects as warnings. Framework redirect / notFound signals are re-thrown.
 *
 * Usage (in a "use server" file):
 *   export const createClient = defineAction(
 *     { name: "clients.create", schema: ClientSchema, roles: ["partner", "manager"] },
 *     async (input, ctx) => { ...; ctx.after("Notify the owner", () => notify(...)); return ok({ id }); },
 *   );
 */
export function defineAction<S extends z.ZodType, T>(
  config: ActionConfig<S>,
  handler: (input: z.output<S>, ctx: ActionContext) => Promise<ActionResult<T>>,
): (input: z.input<S>) => Promise<ActionResult<T>> {
  return async (rawInput: z.input<S>): Promise<ActionResult<T>> => {
    let userId: string | null = null;
    let role: string | null = null;
    try {
      const session = await getSession();
      if (session.status === "anonymous") {
        return fail("Your session has ended. Please sign in again.", { code: "unauthenticated" });
      }
      if (session.status === "no_profile") {
        return fail("Your account isn't set up yet. Ask a Partner.", { code: "forbidden" });
      }
      if (session.status === "inactive") {
        return fail("Your access has been disabled. Ask a Partner.", { code: "forbidden" });
      }
      const { user, supabase } = session;
      userId = user.id;
      role = user.role;

      if (user.mustChangePassword && !config.allowMustChangePassword) {
        return fail("Set your own password first.", { code: "must_change_password" });
      }

      const h = await headers();
      const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? null;
      const userAgent = h.get("user-agent");

      const audit = async (entry: AuditEntry) => {
        try {
          const { error } = await supabase.rpc("log_audit_event", {
            p_event: entry.event,
            p_resource_type: entry.resourceType,
            p_resource_id: entry.resourceId ?? null,
            p_action: entry.action ?? config.name,
            p_details: (entry.details ?? {}) as never,
            p_success: entry.success ?? true,
            p_error: entry.error ?? null,
            p_ip: ip,
            p_user_agent: userAgent,
          });
          if (error) throw error;
        } catch (err) {
          log("error", "audit write failed", { source: `action:${config.name}`, userId, role, err });
        }
      };

      if (config.roles && !config.roles.includes(user.role)) {
        await audit({ event: "access_denied", resourceType: "action", action: config.name, success: false });
        return fail("You don't have permission to do that.", { code: "forbidden" });
      }

      const parsed = config.schema.safeParse(rawInput);
      if (!parsed.success) {
        return fail("Please check the highlighted fields.", {
          code: "validation",
          fieldErrors: zodFieldErrors(parsed.error),
        });
      }

      const afterQueue: Array<{ label: string; fn: () => Promise<unknown>; warning?: string }> = [];
      const ctx: ActionContext = {
        user,
        supabase,
        ip,
        userAgent,
        after: (label, fn, warning) => afterQueue.push({ label, fn, warning }),
        audit,
      };

      const result = await handler(parsed.data, ctx);
      if (!result.ok) return result;

      const warnings = [...(result.warnings ?? [])];
      for (const job of afterQueue) {
        try {
          await job.fn();
        } catch (err) {
          const ref = logUnexpected(err, { source: `action:${config.name}:after:${job.label}`, userId, role });
          warnings.push(`${job.warning ?? `${job.label} didn't go through. Please do it by hand.`} (Ref ${ref})`);
        }
      }
      return ok(result.data, warnings);
    } catch (err) {
      unstable_rethrow(err); // redirect(), notFound() and friends must propagate
      if (err instanceof ActionError) {
        return fail(err.message, { code: err.code, fieldErrors: err.fieldErrors });
      }
      const ref = logUnexpected(err, { source: `action:${config.name}`, userId, role });
      return fail(unexpectedMessage(ref), { code: "unexpected", ref });
    }
  };
}

/**
 * Turns a Supabase/PostgREST error into an ActionError when it is a known, user-facing failure
 * (RLS refusal, unique violation, check violation, a function's RAISE with a USER: prefix), and
 * re-throws anything else as unexpected. Database functions raise user-facing messages as
 *   RAISE EXCEPTION 'USER: <plain sentence>' USING ERRCODE = 'P0001';
 */
export function throwIfDbError(error: { code?: string; message?: string; details?: string } | null, opts: { uniqueField?: string; uniqueMessage?: string } = {}): void {
  if (!error) return;
  const msg = error.message ?? "";
  if (msg.startsWith("USER: ")) throw new ActionError(msg.slice(6));
  if (error.code === "42501") throw new ActionError("You don't have permission to do that.", { code: "forbidden" });
  if (error.code === "23505") {
    const m = opts.uniqueMessage ?? "That already exists.";
    throw new ActionError(m, { code: "conflict", fieldErrors: opts.uniqueField ? { [opts.uniqueField]: [m] } : undefined });
  }
  if (error.code === "PGRST116") throw new ActionError("That record no longer exists.", { code: "not_found" });
  throw Object.assign(new Error(msg || "database error"), error);
}
