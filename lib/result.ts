/**
 * The result contract for every server action and API handler (§0.1 rule 2).
 *
 * Safe to import from client components (no server-only code here).
 */

export type FieldErrors = Record<string, string[]>;

export type ActionErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "must_change_password"
  | "validation"
  | "not_found"
  | "conflict" // optimistic concurrency (§13): the row changed since it was loaded
  | "rate_limited"
  | "blocked" // a business rule refused the change (e.g. "registered client with no GSTIN")
  | "unexpected";

export type ActionSuccess<T> = {
  ok: true;
  data: T;
  /** Work after the save that did not go through (§0.1 rule 5). Show as warnings, never as errors. */
  warnings?: string[];
};

export type ActionFailure = {
  ok: false;
  /** One plain sentence for the user. Never a stack trace or a database message. */
  error: string;
  code?: ActionErrorCode;
  fieldErrors?: FieldErrors;
  /** Present for unexpected errors: the reference the user can quote (§13). */
  ref?: string;
};

export type ActionResult<T = void> = ActionSuccess<T> | ActionFailure;

export function ok<T>(data: T, warnings?: string[]): ActionSuccess<T> {
  return warnings && warnings.length > 0 ? { ok: true, data, warnings } : { ok: true, data };
}

export function fail(error: string, opts: { code?: ActionErrorCode; fieldErrors?: FieldErrors; ref?: string } = {}): ActionFailure {
  return { ok: false, error, ...opts };
}

/**
 * Throw from inside an action handler for a known, user-facing failure.
 * The action wrapper converts it into an ActionFailure (it is NOT logged as unexpected).
 */
export class ActionError extends Error {
  readonly code: ActionErrorCode;
  readonly fieldErrors?: FieldErrors;
  constructor(message: string, opts: { code?: ActionErrorCode; fieldErrors?: FieldErrors } = {}) {
    super(message);
    this.name = "ActionError";
    this.code = opts.code ?? "blocked";
    this.fieldErrors = opts.fieldErrors;
  }
}

/** The user-facing sentence for an unexpected error, with its Ref. */
export function unexpectedMessage(ref: string): string {
  return `Something went wrong on our side. Please try again, and if it keeps happening, quote Ref ${ref}.`;
}
