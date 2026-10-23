import "server-only";

import { env } from "@/lib/env";
import { RETRY_DELAYS_MS, isRetryableSendError, type ResendDnsRecord } from "@/server/email/policy";

/**
 * The Resend API calls the app makes (§7.13.5, §13): send one email with an idempotency key and
 * retries, and the domain calls behind the Settings → Email wizard. Nothing here touches the
 * database; server/email/send.ts and server/actions/email-settings.ts record what happened.
 *
 * It talks to the REST API with fetch rather than through the `resend` package: the package pulls
 * in an optional `@react-email/render` import that bundlers try to resolve, and we render our own
 * HTML anyway (server/email/render.ts). Same endpoints, same error shape ({ statusCode, name,
 * message }), plus a timeout on every request.
 *
 * Every call returns `{ ok, … }` / `{ ok: false, error }`; none throws.
 */

const RESEND_API = "https://api.resend.com";
const REQUEST_TIMEOUT_MS = 15_000;

export type ResendFailure = { name: string | null; message: string; statusCode: number | null };

export function resendConfigured(): boolean {
  return Boolean(env.resendApiKey()?.trim());
}

const NOT_CONFIGURED: ResendFailure = { name: "missing_api_key", message: "RESEND_API_KEY isn't set on this deployment.", statusCode: null };

type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ResendFailure };

async function call<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, opts: { idempotencyKey?: string } = {}): Promise<ApiResult<T>> {
  const key = env.resendApiKey()?.trim();
  if (!key) return { ok: false, error: NOT_CONFIGURED };
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    "User-Agent": "taxwise-practice-os",
  };
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(`${RESEND_API}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return { ok: false, error: { name: null, statusCode: null, message: timedOut ? "Resend didn't answer in time." : "Resend couldn't be reached." } };
  }
  let parsed: unknown = null;
  try {
    const raw = await res.text();
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const e = (parsed ?? {}) as { name?: unknown; message?: unknown };
    return {
      ok: false,
      error: {
        name: typeof e.name === "string" ? e.name : res.status >= 500 ? "internal_server_error" : null,
        message: typeof e.message === "string" ? e.message : res.statusText || `HTTP ${res.status}`,
        statusCode: res.status,
      },
    };
  }
  return { ok: true, data: parsed as T };
}

// -------------------------------------------------------------------------------------------------
// Sending
// -------------------------------------------------------------------------------------------------

export interface ResendEmailPayload {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
  reply_to?: string[];
  headers?: Record<string, string>;
  tags?: Array<{ name: string; value: string }>;
  attachments?: Array<{ filename: string; content: string; content_type?: string }>;
}

export interface SendAttemptResult {
  ok: boolean;
  providerMessageId: string | null;
  error: ResendFailure | null;
  /** How many requests were made (1 + retries). */
  attempts: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends one email: the first try plus up to three retries with backoff (500 ms, 1.5 s, 4 s, each
 * with up to 20% jitter) for rate limits, Resend's own errors, timeouts and network failures.
 * Every try carries the same Idempotency-Key, so a retry after a lost response never sends twice.
 */
export async function sendWithRetry(
  payload: ResendEmailPayload,
  idempotencyKey: string,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<SendAttemptResult> {
  if (!resendConfigured()) return { ok: false, providerMessageId: null, error: NOT_CONFIGURED, attempts: 0 };
  const wait = opts.sleep ?? sleep;
  let attempts = 0;
  let last: ResendFailure | null = null;
  for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
    if (i > 0) {
      const base = RETRY_DELAYS_MS[i - 1];
      await wait(base + Math.floor(Math.random() * base * 0.2));
    }
    attempts += 1;
    const r = await call<{ id?: string }>("POST", "/emails", payload, { idempotencyKey });
    if (r.ok && r.data?.id) return { ok: true, providerMessageId: r.data.id, error: null, attempts };
    last = r.ok ? { name: "application_error", message: "Resend returned no message id.", statusCode: null } : r.error;
    if (!isRetryableSendError(last)) break;
  }
  return { ok: false, providerMessageId: null, error: last, attempts };
}

// -------------------------------------------------------------------------------------------------
// Domains (Settings → Email)
// -------------------------------------------------------------------------------------------------

export type ResendRegion = "us-east-1" | "eu-west-1" | "sa-east-1" | "ap-northeast-1";

export const RESEND_REGIONS: ReadonlyArray<{ value: ResendRegion; label: string }> = [
  { value: "ap-northeast-1", label: "Tokyo (closest to India)" },
  { value: "us-east-1", label: "North Virginia (Resend's default)" },
  { value: "eu-west-1", label: "Ireland" },
  { value: "sa-east-1", label: "São Paulo" },
];

export function isResendRegion(v: unknown): v is ResendRegion {
  return typeof v === "string" && RESEND_REGIONS.some((r) => r.value === v);
}

export interface ResendDomain {
  id: string;
  name: string;
  /** Resend's own status: not_started, pending, verified, failed, partially_verified, partially_failed. */
  status: string;
  region: string | null;
  createdAt: string | null;
  records: ResendDnsRecord[];
}

export type DomainResult = { ok: true; domain: ResendDomain } | { ok: false; error: ResendFailure };

type RawDomain = {
  id?: string;
  name?: string;
  status?: string;
  region?: string | null;
  created_at?: string | null;
  records?: Array<{ record?: string; name?: string; type?: string; value?: string; ttl?: string | null; status?: string | null; priority?: number | null }>;
};

function toDomain(raw: RawDomain): ResendDomain | null {
  if (!raw?.id || !raw.name) return null;
  return {
    id: raw.id,
    name: raw.name,
    status: raw.status ?? "not_started",
    region: raw.region ?? null,
    createdAt: raw.created_at ?? null,
    records: (raw.records ?? [])
      .filter((r) => r.record && r.type && typeof r.value === "string")
      .map((r) => ({
        record: r.record as string,
        name: r.name ?? "",
        type: r.type as string,
        value: r.value as string,
        ttl: r.ttl ?? null,
        status: r.status ?? null,
        priority: typeof r.priority === "number" ? r.priority : null,
      })),
  };
}

function domainResult(r: ApiResult<RawDomain>): DomainResult {
  if (!r.ok) return r;
  const domain = toDomain(r.data);
  return domain ? { ok: true, domain } : { ok: false, error: { name: "application_error", message: "Resend returned no domain.", statusCode: null } };
}

/** A domain with its DNS records and their status. */
export async function getDomain(id: string): Promise<DomainResult> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) return { ok: false, error: { name: "invalid_parameter", message: "That isn't a Resend domain id.", statusCode: null } };
  return domainResult(await call<RawDomain>("GET", `/domains/${id}`));
}

/** The domain already in the Resend account with this name, or null. */
export async function findDomainByName(name: string): Promise<DomainResult | null> {
  const r = await call<{ data?: RawDomain[] }>("GET", "/domains");
  if (!r.ok) return r;
  const hit = (r.data?.data ?? []).find((d) => d.name?.toLowerCase() === name.toLowerCase());
  return hit?.id ? getDomain(hit.id) : null;
}

/**
 * Adds the sending domain to Resend (sending only, open tracking on for the "opened" status of
 * §7.13.1, click tracking off so links in our emails stay as written), or picks up the domain
 * already in the account with the same name.
 */
export async function createDomain(name: string, region: ResendRegion): Promise<DomainResult> {
  const created = domainResult(
    await call<RawDomain>("POST", "/domains", {
      name,
      region,
      capabilities: { sending: "enabled", receiving: "disabled" },
      open_tracking: true,
      click_tracking: false,
    }),
  );
  if (created.ok) return created;
  const existing = await findDomainByName(name);
  return existing ?? created;
}

/** Asks Resend to check the DNS records now (it also checks on its own schedule). */
export async function verifyDomain(id: string): Promise<{ ok: true } | { ok: false; error: ResendFailure }> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) return { ok: false, error: { name: "invalid_parameter", message: "That isn't a Resend domain id.", statusCode: null } };
  const r = await call<unknown>("POST", `/domains/${id}/verify`);
  return r.ok ? { ok: true } : r;
}

/** Removes the domain from Resend (to start again with another name). A domain already gone counts as removed. */
export async function removeDomain(id: string): Promise<{ ok: true } | { ok: false; error: ResendFailure }> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) return { ok: true };
  const r = await call<unknown>("DELETE", `/domains/${id}`);
  if (r.ok || r.error.statusCode === 404 || r.error.name === "not_found") return { ok: true };
  return r;
}
