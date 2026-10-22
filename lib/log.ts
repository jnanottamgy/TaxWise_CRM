/**
 * Structured server logging and the error reference contract (§0.1 rule 2, §13).
 *
 * Every unexpected error is written as ONE JSON line with a short `ref` the user can quote.
 * Never log secrets, passwords, tokens or connection strings.
 */

const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I: easy to read aloud

export function newRef(length = 8): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += REF_ALPHABET[b % REF_ALPHABET.length];
  return out;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  source: string; // e.g. "action:clients.create", "cron:receivables", "route:/api/pdf/invoice"
  userId?: string | null;
  role?: string | null;
  [key: string]: unknown;
}

const SECRET_PATTERN = /(postgres(?:ql)?:\/\/[^\s"']+|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|re_[A-Za-z0-9_]{16,})/g;

/** Strips connection strings, JWTs and API keys from any message before it is logged or shown. */
export function scrub(text: string): string {
  return text.replace(SECRET_PATTERN, "[redacted]");
}

function serialiseError(err: unknown): Record<string, unknown> | undefined {
  if (err == null) return undefined;
  if (err instanceof Error) {
    const anyErr = err as Error & { code?: unknown; details?: unknown; hint?: unknown };
    return {
      name: err.name,
      message: scrub(err.message),
      code: anyErr.code,
      details: typeof anyErr.details === "string" ? scrub(anyErr.details) : anyErr.details,
      hint: anyErr.hint,
      stack: err.stack?.split("\n").slice(0, 6).join("\n"),
    };
  }
  if (typeof err === "object") {
    const o = err as Record<string, unknown>;
    return {
      message: typeof o.message === "string" ? scrub(o.message) : undefined,
      code: o.code,
      details: o.details,
      hint: o.hint,
    };
  }
  return { message: scrub(String(err)) };
}

export function log(level: LogLevel, message: string, ctx: LogContext & { ref?: string; err?: unknown }) {
  const { err, ...rest } = ctx;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: scrub(message),
    ...rest,
    err: serialiseError(err),
  };
  const out = JSON.stringify(line);
  if (level === "error") console.error(out);
  else if (level === "warn") console.warn(out);
  else console.log(out);
}

/** Logs an unexpected error and returns the ref to show the user. */
export function logUnexpected(err: unknown, ctx: LogContext): string {
  const ref = newRef();
  log("error", "unexpected error", { ...ctx, ref, err });
  return ref;
}
