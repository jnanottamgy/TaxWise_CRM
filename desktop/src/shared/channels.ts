/**
 * Every IPC channel TaxWise Desktop uses, with the one kind of sender allowed on it and a
 * validator for its payload. The main process registers handlers only through this table
 * (see src/main/ipc.ts), so an untyped or unvalidated channel cannot exist.
 */

import type { WhatsAppPageState } from "./types";

export type SenderKind = "crm" | "whatsapp" | "panel";

export class PayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadError";
  }
}

type Validator<T> = (value: unknown) => T;

function obj(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new PayloadError("expected an object");
  return value as Record<string, unknown>;
}

function str(value: unknown, max: number, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new PayloadError("expected a string");
  if (pattern && !pattern.test(value)) throw new PayloadError("string has the wrong format");
  return value;
}

function optStr(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > max) throw new PayloadError("expected a string or null");
  return value;
}

function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw new PayloadError("expected a boolean");
  return value;
}

function num(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new PayloadError("expected a number in range");
  return value;
}

function oneOf<T extends string>(value: unknown, options: readonly T[]): T {
  if (typeof value !== "string" || !(options as readonly string[]).includes(value)) throw new PayloadError("unexpected value");
  return value as T;
}

function none(value: unknown): void {
  if (value !== undefined && value !== null) throw new PayloadError("expected no payload");
}

/** Ids from the CRM are uuids; be strict so nothing odd reaches a URL or a partition name. */
export const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

const PAGE_STATES: readonly WhatsAppPageState[] = ["loading", "qr", "chats", "unsupported"];
const DECISIONS = ["allow", "adopt", "deny", "none"] as const;
const DRAG_PHASES = ["start", "move", "end"] as const;

/* ------------------------------------------------------------------ */
/* Renderer → main: request/response (ipcRenderer.invoke)              */
/* ------------------------------------------------------------------ */

export const INVOKE = {
  /** CRM page: window.taxwiseDesktop.openClientChat(clientId) */
  "crm:open-client-chat": {
    sender: "crm",
    parse: ((v: unknown) => ({ clientId: str(obj(v).clientId, 64, ID_PATTERN) })) as Validator<{ clientId: string }>,
  },
  /** CRM page: window.taxwiseDesktop.toggleWhatsApp() */
  "crm:toggle-whatsapp": { sender: "crm", parse: none as Validator<void> },
  /** CRM page: window.taxwiseDesktop.refreshContext() */
  "crm:refresh-context": { sender: "crm", parse: none as Validator<void> },
  /** Panel header asks for its first state. */
  "panel:ready": { sender: "panel", parse: none as Validator<void> },
  /** WhatsApp preload asks which number and policy it runs under. */
  "wa:hello": { sender: "whatsapp", parse: none as Validator<void> },
} as const;

/* ------------------------------------------------------------------ */
/* Renderer → main: one-way (ipcRenderer.send)                         */
/* ------------------------------------------------------------------ */

export const SEND = {
  "crm:download-complete": {
    sender: "crm",
    parse: ((v: unknown) => {
      const o = obj(v);
      return { id: str(o.id, 64, ID_PATTERN), uploaded: bool(o.uploaded) };
    }) as Validator<{ id: string; uploaded: boolean }>,
  },
  "crm:download-listeners": {
    sender: "crm",
    parse: ((v: unknown) => ({ count: num(obj(v).count, 0, 1000) })) as Validator<{ count: number }>,
  },

  "panel:switch-number": {
    sender: "panel",
    parse: ((v: unknown) => ({ numberId: str(obj(v).numberId, 64, ID_PATTERN) })) as Validator<{ numberId: string }>,
  },
  "panel:link-number": {
    sender: "panel",
    parse: ((v: unknown) => ({ numberId: str(obj(v).numberId, 64, ID_PATTERN) })) as Validator<{ numberId: string }>,
  },
  "panel:pop-out": { sender: "panel", parse: none as Validator<void> },
  "panel:dock": { sender: "panel", parse: none as Validator<void> },
  "panel:close": { sender: "panel", parse: none as Validator<void> },
  "panel:retry": { sender: "panel", parse: none as Validator<void> },
  "panel:dismiss-notice": { sender: "panel", parse: none as Validator<void> },
  "panel:drag": {
    sender: "panel",
    parse: ((v: unknown) => {
      const o = obj(v);
      return { phase: oneOf(o.phase, DRAG_PHASES), screenX: num(o.screenX, -100000, 100000) };
    }) as Validator<{ phase: (typeof DRAG_PHASES)[number]; screenX: number }>,
  },
  "panel:set-width": {
    sender: "panel",
    parse: ((v: unknown) => ({ width: num(obj(v).width, 0, 100000) })) as Validator<{ width: number }>,
  },

  "wa:page-state": {
    sender: "whatsapp",
    parse: ((v: unknown) => {
      const o = obj(v);
      return { state: oneOf(o.state, PAGE_STATES), userAgent: optStr(o.userAgent, 512) };
    }) as Validator<{ state: WhatsAppPageState; userAgent: string | null }>,
  },
  "wa:open-title": {
    sender: "whatsapp",
    parse: ((v: unknown) => {
      const o = obj(v);
      return { title: optStr(o.title, 512), decision: oneOf(o.decision, DECISIONS) };
    }) as Validator<{ title: string | null; decision: (typeof DECISIONS)[number] }>,
  },
  "wa:adopt-chat": {
    sender: "whatsapp",
    parse: ((v: unknown) => ({ title: str(obj(v).title, 512) })) as Validator<{ title: string }>,
  },
  "wa:access-denied": {
    sender: "whatsapp",
    parse: ((v: unknown) => ({ title: str(obj(v).title, 512) })) as Validator<{ title: string }>,
  },
  "wa:selectors": {
    sender: "whatsapp",
    parse: ((v: unknown) => {
      const o = obj(v);
      if (!Array.isArray(o.failing) || o.failing.length > 50) throw new PayloadError("expected a list");
      return { ok: bool(o.ok), failing: o.failing.map((f) => str(f, 64, /^[A-Za-z0-9_.-]+$/)) };
    }) as Validator<{ ok: boolean; failing: string[] }>,
  },
  "wa:reset": { sender: "whatsapp", parse: none as Validator<void> },
  "wa:open-chat-result": {
    sender: "whatsapp",
    parse: ((v: unknown) => {
      const o = obj(v);
      return {
        requestId: str(o.requestId, 64, ID_PATTERN),
        ok: bool(o.ok),
        reason: optStr(o.reason, 64),
      };
    }) as Validator<{ requestId: string; ok: boolean; reason: string | null }>,
  },
  "wa:title-result": {
    sender: "whatsapp",
    parse: ((v: unknown) => {
      const o = obj(v);
      return { requestId: str(o.requestId, 64, ID_PATTERN), title: optStr(o.title, 512) };
    }) as Validator<{ requestId: string; title: string | null }>,
  },
} as const;

/* ------------------------------------------------------------------ */
/* Main → renderer pushes (webContents.send)                           */
/* ------------------------------------------------------------------ */

export const PUSH = {
  crmDownload: "crm:download",
  panelState: "panel:state",
  waConfig: "wa:config",
  waOpenChat: "wa:open-chat",
  waQueryTitle: "wa:query-title",
} as const;

export type InvokeChannel = keyof typeof INVOKE;
export type SendChannel = keyof typeof SEND;
export type InvokePayload<C extends InvokeChannel> = ReturnType<(typeof INVOKE)[C]["parse"]>;
export type SendPayload<C extends SendChannel> = ReturnType<(typeof SEND)[C]["parse"]>;

/** Arguments the main process gives each preload through webPreferences.additionalArguments. */
export const ARG = {
  version: "--taxwise-version=",
  clientMode: "--taxwise-client-mode=",
} as const;

export function readArg(argv: readonly string[], prefix: string): string | null {
  const hit = argv.find((a) => a.startsWith(prefix));
  return hit === undefined ? null : hit.slice(prefix.length);
}
