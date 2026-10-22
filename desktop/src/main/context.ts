/**
 * The signed-in user's desktop context (§7.25.3): loaded after CRM sign-in, every 5 minutes, and
 * whenever the CRM page calls refreshContext(). A refresh that drops a group (a cover that ended,
 * §4.7) closes that chat if it is open.
 */

import { CONTEXT_REFRESH_MS, CONTEXT_STALE_MS } from "../shared/config";
import { decideChat, normalizeTitle } from "../shared/chat-rules";
import type { ClientModePolicy, DesktopContext } from "../shared/types";
import type { ApiResult } from "./api";

export type ContextState =
  | { kind: "unknown" }
  | { kind: "signed-in"; ctx: DesktopContext }
  | { kind: "signed-out" }
  | { kind: "revoked" };

export interface ContextDiff {
  userChanged: boolean;
  roleChanged: boolean;
  clientModeChanged: boolean;
  notificationsChanged: boolean;
  numbersChanged: boolean;
  /** Group names no longer allowed (Employees). */
  removedGroups: string[];
  addedGroups: string[];
}

function groupNames(ctx: DesktopContext | null): Set<string> | null {
  if (!ctx || ctx.allowedGroups === null) return null;
  return new Set(ctx.allowedGroups.map((g) => normalizeTitle(g.groupName)));
}

function numbersKey(ctx: DesktopContext | null): string {
  if (!ctx) return "";
  return ctx.numbers
    .map((n) => `${n.id}|${n.label}|${n.kind}|${[...n.usableBy].sort().join(",")}|${n.ownerEmployeeId ?? ""}`)
    .sort()
    .join(";");
}

export function diffContext(prev: DesktopContext | null, next: DesktopContext | null): ContextDiff {
  const before = groupNames(prev);
  const after = groupNames(next);
  // "all" (null) → a list removes everything not on the list; a list → "all" removes nothing.
  const removed = before === null ? [] : [...before].filter((g) => after !== null && !after.has(g));
  const added = after === null ? [] : [...after].filter((g) => before === null || !before.has(g));
  if (before !== null && next === null) removed.push(...before);
  return {
    userChanged: (prev?.user.id ?? null) !== (next?.user.id ?? null),
    roleChanged: (prev?.user.role ?? null) !== (next?.user.role ?? null),
    clientModeChanged: (prev ? effectiveClientMode(prev) : false) !== (next ? effectiveClientMode(next) : false),
    notificationsChanged: (prev?.employeeNotifications ?? false) !== (next?.employeeNotifications ?? false),
    numbersChanged: numbersKey(prev) !== numbersKey(next),
    removedGroups: [...new Set(removed)],
    addedGroups: added,
  };
}

/** Client mode runs for Employees while Settings → WhatsApp → client mode is on. */
export function effectiveClientMode(ctx: DesktopContext): boolean {
  return ctx.user.role === "employee" && ctx.clientMode;
}

export interface SessionChats {
  sessionChats: string[];
  pendingHandoff: ClientModePolicy["pendingHandoff"];
  notice: ClientModePolicy["notice"];
}

/**
 * The policy the WhatsApp preload enforces. If the context hasn't refreshed for too long, client
 * mode allows nothing: a cover that ended must not stay open because the network is down.
 */
export function buildClientModePolicy(ctx: DesktopContext | null, session: SessionChats, lastGoodAt: number, now: number): ClientModePolicy {
  if (!ctx || !effectiveClientMode(ctx)) {
    return { enabled: false, allowedGroupNames: [], sessionChats: [], pendingHandoff: null, notice: null };
  }
  const stale = now - lastGoodAt > CONTEXT_STALE_MS;
  return {
    enabled: true,
    allowedGroupNames: stale ? [] : (ctx.allowedGroups ?? []).map((g) => g.groupName),
    sessionChats: stale ? [] : session.sessionChats,
    pendingHandoff: stale ? null : session.pendingHandoff,
    notice: session.notice,
  };
}

export interface OpenChat {
  numberId: string;
  title: string;
}

/** Open chats that a new policy no longer allows. */
export function chatsToClose(open: OpenChat[], policy: ClientModePolicy, now: number): OpenChat[] {
  if (!policy.enabled) return [];
  const strict: ClientModePolicy = { ...policy, pendingHandoff: null };
  return open.filter((c) => decideChat(c.title, strict, now) === "deny");
}

/** The client a conversation title belongs to, from the allow-list or the chats opened this session. */
export function clientForTitle(
  title: string | null,
  ctx: DesktopContext | null,
  openedThisSession: ReadonlyMap<string, { clientId: string; clientName: string }>,
): { clientId: string; clientName: string } | null {
  if (!title) return null;
  const t = normalizeTitle(title);
  for (const [name, client] of openedThisSession) {
    if (normalizeTitle(name) === t) return client;
  }
  const g = ctx?.allowedGroups?.find((x) => normalizeTitle(x.groupName) === t);
  return g ? { clientId: g.clientId, clientName: g.clientName } : null;
}

export interface ContextServiceOptions {
  load: () => Promise<ApiResult<DesktopContext>>;
  onResult: (state: ContextState, diff: ContextDiff, error: string | null) => void;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  intervalMs?: number;
}

export class ContextService {
  private current: ContextState = { kind: "unknown" };
  private inFlight: Promise<ContextState> | null = null;
  private timer: unknown = null;
  private goodAt = 0;
  private readonly now: () => number;

  constructor(private readonly opts: ContextServiceOptions) {
    this.now = opts.now ?? Date.now;
  }

  get state(): ContextState {
    return this.current;
  }

  get context(): DesktopContext | null {
    return this.current.kind === "signed-in" ? this.current.ctx : null;
  }

  /** When the context was last loaded successfully (0 if never). */
  get lastGoodAt(): number {
    return this.goodAt;
  }

  start(): void {
    if (this.timer !== null) return;
    const set = this.opts.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
    this.timer = set(() => void this.refresh(), this.opts.intervalMs ?? CONTEXT_REFRESH_MS);
  }

  stop(): void {
    if (this.timer === null) return;
    const clear = this.opts.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
    clear(this.timer);
    this.timer = null;
  }

  /** Concurrent callers share one request. */
  refresh(): Promise<ContextState> {
    if (!this.inFlight) {
      this.inFlight = this.run().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  /** The CRM showed its sign-in page: act at once, without waiting for the API. */
  markSignedOut(): void {
    this.transition({ kind: "signed-out" }, null);
  }

  markRevoked(): void {
    this.transition({ kind: "revoked" }, null);
  }

  private async run(): Promise<ContextState> {
    const res = await this.opts.load();
    switch (res.kind) {
      case "ok":
        this.goodAt = this.now();
        this.transition({ kind: "signed-in", ctx: res.data }, null);
        break;
      case "signed-out":
        this.transition({ kind: "signed-out" }, null);
        break;
      case "revoked":
        this.transition({ kind: "revoked" }, null);
        break;
      case "refused":
        // e.g. a client portal user signed in: no desktop context for them.
        this.transition({ kind: "signed-out" }, res.message);
        break;
      case "error":
        // Keep what we had; the policy builder fails closed once it is stale.
        this.transition(this.current, res.message);
        break;
    }
    return this.current;
  }

  private transition(next: ContextState, error: string | null): void {
    const prevCtx = this.context;
    if (next.kind !== "signed-in" && this.current.kind === "signed-in") this.goodAt = 0;
    this.current = next;
    const nextCtx = next.kind === "signed-in" ? next.ctx : null;
    this.opts.onResult(next, diffContext(prevCtx, nextCtx), error);
  }
}
