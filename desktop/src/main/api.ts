/**
 * The CRM desktop API client (§7.25.1, §7.25.3). The main process calls it with the CRM view's
 * own session cookies (session.fetch on persist:crm with credentials: "include"). It never takes
 * a token from the page.
 *
 * Results:
 * - 401 (or a redirect to the sign-in page) → "signed-out": hide the WhatsApp panel.
 * - 403 with code "device_revoked" → "revoked": wipe every WhatsApp partition, show the removed-PC screen.
 * - any other refusal → "refused" with the CRM's own sentence.
 */

import { API_TIMEOUT_MS } from "../shared/config";
import type { DesktopContext, OpenWhatsAppData } from "../shared/types";
import { parseContext, parseOpenData } from "./contract";

export type ApiResult<T> =
  | { kind: "ok"; data: T }
  | { kind: "signed-out" }
  | { kind: "revoked" }
  | { kind: "refused"; status: number; message: string; code: string | null }
  | { kind: "error"; message: string; ref: string | null };

export type FetchLike = (url: string, init: RequestInit) => Promise<Pick<Response, "status" | "headers" | "json">>;

export interface ApiDeps {
  fetch: FetchLike;
  appOrigin: string;
  deviceKey: string;
  appVersion: string;
  timeoutMs?: number;
}

const GENERIC = "TaxWise didn't answer. Check the internet connection and try again.";

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Turns a status and a parsed body ({ ok, data | error, code?, ref? }) into a result. Pure. */
export function interpretResponse<T>(status: number, body: unknown, parse: (data: unknown) => T | null): ApiResult<T> {
  if (status === 0 || (status >= 300 && status < 400)) return { kind: "signed-out" };
  if (status === 401) return { kind: "signed-out" };
  const b = isObj(body) ? body : {};
  const code = typeof b.code === "string" ? b.code : null;
  const message = typeof b.error === "string" && b.error.length > 0 ? b.error : null;
  const ref = typeof b.ref === "string" ? b.ref : null;
  if (status === 403 && code === "device_revoked") return { kind: "revoked" };
  if (status >= 200 && status < 300 && b.ok === true) {
    const data = parse(b.data);
    return data === null ? { kind: "error", message: "TaxWise sent an answer this app doesn't understand. Update TaxWise Desktop.", ref } : { kind: "ok", data };
  }
  if (status >= 200 && status < 500) {
    return { kind: "refused", status, message: message ?? "TaxWise refused this.", code };
  }
  return { kind: "error", message: message ?? GENERIC, ref };
}

/** For endpoints whose data the app doesn't use. */
const anyData = (d: unknown): unknown => d ?? {};

export interface DeviceInfo {
  deviceName: string;
  os: string;
  appVersion: string;
}

export function createDesktopApi(deps: ApiDeps) {
  const base = `${deps.appOrigin}/api/desktop`;

  async function call<T>(method: "GET" | "POST", path: string, body: unknown, parse: (d: unknown) => T | null): Promise<ApiResult<T>> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      // Same-origin to the CRM's own CSRF checks; the request carries the CRM session's cookies.
      Origin: deps.appOrigin,
      "X-TaxWise-Desktop": deps.appVersion,
      "X-TaxWise-Device": deps.deviceKey,
    };
    const init: RequestInit = {
      method,
      headers,
      credentials: "include",
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(deps.timeoutMs ?? API_TIMEOUT_MS),
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let res: Pick<Response, "status" | "headers" | "json">;
    try {
      res = await deps.fetch(`${base}${path}`, init);
    } catch {
      return { kind: "error", message: GENERIC, ref: null };
    }
    let json: unknown = null;
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("application/json")) {
      try {
        json = await res.json();
      } catch {
        json = null;
      }
    }
    return interpretResponse(res.status, json, parse);
  }

  return {
    getContext: (): Promise<ApiResult<DesktopContext>> => call("GET", "/context", undefined, parseContext),
    openWhatsApp: (clientId: string): Promise<ApiResult<OpenWhatsAppData>> => call("POST", "/whatsapp/open", { clientId }, parseOpenData),
    checkin: (info: DeviceInfo): Promise<ApiResult<unknown>> => call("POST", "/devices/checkin", { deviceKey: deps.deviceKey, ...info }, anyData),
    link: (numberId: string, linked: boolean): Promise<ApiResult<unknown>> =>
      call("POST", "/devices/link", { deviceKey: deps.deviceKey, numberId, linked }, anyData),
    health: (failing: string[]): Promise<ApiResult<unknown>> => call("POST", "/health", { deviceKey: deps.deviceKey, failing }, anyData),
    accessDenied: (numberId: string, chatTitle: string): Promise<ApiResult<unknown>> =>
      call("POST", "/access-denied", { deviceKey: deps.deviceKey, numberId, chatTitle }, anyData),
  };
}

export type DesktopApi = ReturnType<typeof createDesktopApi>;
