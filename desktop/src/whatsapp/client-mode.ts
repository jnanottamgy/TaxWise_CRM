/**
 * Client mode for Employees (§7.25.5), enforced on WhatsApp Web's page by the WhatsApp preload.
 *
 * - Only one conversation shows: the chat list, search and archive are hidden, and a cover hides
 *   the whole page whenever no allowed conversation is open.
 * - The open conversation's title is watched (synchronously on every DOM change, before the next
 *   paint). A chat is allowed if it is in allowedGroups, or is a one-to-one chat the CRM opened in
 *   this session. Anything else is closed, the panel shows "Not one of your clients", and the main
 *   process logs access_denied (once per chat per day).
 * - Selector self-check on load and every 10 minutes. If one fails, client mode fails CLOSED:
 *   "Client mode is unavailable because WhatsApp changed its page. A Partner has been told."
 *
 * Never reads, copies or stores message content; never sends; never scrapes.
 */

import { decideChat, normalizeTitle, type ChatVerdict } from "../shared/chat-rules";
import { COPY } from "../shared/copy";
import type { ClientModePolicy, WhatsAppPageState } from "../shared/types";
import { checkSelectors, detectPageState, q, readConversationTitle, SelectorError } from "./page";
import { CLIENT_MODE_ATTR, clientModeCss, OPENING_ATTR, READY_ATTR } from "./client-mode-css";
import { ALLOWED_MARK } from "./selectors";
import { Shield, type ShieldState } from "./shield";

export { COPY, clientModeCss, CLIENT_MODE_ATTR, OPENING_ATTR, READY_ATTR };

export interface ClientModeBridge {
  pageState(state: WhatsAppPageState): void;
  openTitle(title: string | null, verdict: ChatVerdict): void;
  adopt(title: string): void;
  accessDenied(title: string): void;
  selectors(ok: boolean, failing: string[]): void;
  /** Escape didn't close a refused chat: reload WhatsApp Web's home page. */
  resetPage(): void;
}

export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface ClientModeOptions {
  doc: Document;
  bridge: ClientModeBridge;
  timers: Timers;
  selectorCheckMs: number;
  /** A page that is neither the QR screen nor the chat list after this long fails the self-check. */
  loadingTimeoutMs?: number;
  /** How long Escape gets to close a refused chat before the page is reloaded. */
  closeVerifyMs?: number;
}

const STYLE_ID = "taxwise-client-mode-style";

export const DISABLED_POLICY: ClientModePolicy = {
  enabled: false,
  allowedGroupNames: [],
  sessionChats: [],
  pendingHandoff: null,
  notice: null,
};

export class ClientModeController {
  private policy: ClientModePolicy = DISABLED_POLICY;
  /** Client mode is on but the app hasn't sent the policy yet: cover everything, decide nothing. */
  private pending = false;
  readonly shield: Shield;
  private failing: string[] | null = null;
  private opening: string | null = null;
  private lastState: WhatsAppPageState | null = null;
  private lastReported: { title: string | null; verdict: ChatVerdict } | null = null;
  private deniedTitle: string | null = null;
  private adoptConsumed = false;
  private handoffKey: number | null = null;
  private observer: MutationObserver | null = null;
  private checkTimer: unknown = null;
  private closeTimer: unknown = null;
  private loadTimer: unknown = null;
  private readonly startedAt: number;
  private loadCheckDone = false;
  private styleApplied = false;

  constructor(private readonly opts: ClientModeOptions) {
    this.shield = new Shield(opts.doc);
    this.startedAt = opts.timers.now();
  }

  get shieldState(): ShieldState {
    return this.shield.state;
  }

  get failingSelectors(): string[] | null {
    return this.failing;
  }

  /**
   * Start watching. Call at document start: the cover goes up before WhatsApp paints anything.
   * "pending" (an Employee's panel before the app has sent the policy) covers the page and
   * decides nothing, so a chat is neither shown nor closed on a guess.
   */
  start(policy: ClientModePolicy | "pending"): void {
    if (policy === "pending") {
      this.pending = true;
      this.policy = { ...DISABLED_POLICY, enabled: true };
    } else {
      this.setPolicy(policy);
    }
    const view = this.opts.doc.defaultView;
    const MO = (view as unknown as { MutationObserver?: typeof MutationObserver } | null)?.MutationObserver ?? globalThis.MutationObserver;
    this.observer = new MO(() => this.evaluate());
    this.observer.observe(this.opts.doc, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["title"] });
    this.checkTimer = this.opts.timers.setInterval(() => this.runSelfCheck(), this.opts.selectorCheckMs);
    // If the page never settles, the on-load check still runs (and fails closed).
    this.loadTimer = this.opts.timers.setTimeout(() => {
      this.loadTimer = null;
      this.evaluate();
    }, this.opts.loadingTimeoutMs ?? 60_000);
    this.evaluate();
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.checkTimer !== null) this.opts.timers.clearInterval(this.checkTimer);
    if (this.closeTimer !== null) this.opts.timers.clearTimeout(this.closeTimer);
    if (this.loadTimer !== null) this.opts.timers.clearTimeout(this.loadTimer);
    this.checkTimer = null;
    this.closeTimer = null;
    this.loadTimer = null;
  }

  setPolicy(policy: ClientModePolicy): void {
    this.pending = false;
    const key = policy.pendingHandoff?.expiresAt ?? null;
    if (key !== this.handoffKey) {
      this.handoffKey = key;
      this.adoptConsumed = false;
    }
    this.policy = policy;
    if (!policy.enabled) {
      this.failing = null;
      this.deniedTitle = null;
    }
    this.evaluate();
  }

  /** The self-check (§7.25.5). Also runs once on load, as soon as the page settles or times out. */
  runSelfCheck(): { ok: boolean; failing: string[] } {
    if (!this.policy.enabled || this.pending) return { ok: true, failing: [] };
    const tooLong = this.opts.timers.now() - this.startedAt >= (this.opts.loadingTimeoutMs ?? 60_000);
    const res = checkSelectors(this.opts.doc, tooLong);
    if (res.state === "loading" && !tooLong) return { ok: true, failing: [] };
    this.loadCheckDone = true;
    if (!res.ok) this.fail(res.failing);
    else if (this.failing) {
      this.failing = null;
      this.opts.bridge.selectors(true, []);
      this.evaluate();
    } else {
      this.opts.bridge.selectors(true, []);
    }
    return { ok: res.ok, failing: res.failing };
  }

  /** Something the self-check can't see broke (e.g. a clicked result never opened a conversation). */
  reportBroken(failing: string[]): void {
    if (this.policy.enabled) this.fail(failing);
  }

  /** Main asked to open a group: cover the page and allow the search box to work. */
  beginOpening(groupName: string): void {
    this.opening = groupName;
    this.evaluate();
  }

  endOpening(): void {
    this.opening = null;
    this.evaluate();
  }

  /**
   * Re-check everything now. Runs synchronously from the MutationObserver, before the next paint.
   * Any unexpected error fails closed: the page stays covered and no conversation is marked allowed.
   */
  evaluate(): void {
    try {
      this.evaluateOnce();
    } catch {
      if (!this.policy.enabled) return;
      try {
        this.unmark();
        this.shield.show("unavailable");
      } catch {
        // nothing more can be done from here; the main process still hides an unavailable panel
      }
      if (!this.failing) {
        this.failing = ["client-mode"];
        try {
          this.opts.bridge.selectors(false, this.failing);
        } catch {
          // reported again by the next self-check
        }
      }
    }
  }

  private evaluateOnce(): void {
    const { doc, bridge } = this.opts;
    // The main process's guard stylesheet keeps the page hidden until this is set (fail closed).
    const root = doc.documentElement;
    if (root && !root.hasAttribute(READY_ATTR)) root.setAttribute(READY_ATTR, "");
    const state = detectPageState(doc);
    if (state !== this.lastState) {
      this.lastState = state;
      bridge.pageState(state);
    }

    if (!this.policy.enabled) {
      this.removeStyle();
      this.shield.hide();
      this.unmark();
      return;
    }
    this.ensureStyle();

    if (this.pending) {
      this.unmark();
      if (state === "qr") this.shield.hide();
      else this.shield.show("loading");
      return;
    }

    if (!this.loadCheckDone && state !== "loading") this.runSelfCheck();
    if (this.failing) {
      this.unmark();
      this.shield.show("unavailable");
      return;
    }

    if (state === "qr" || state === "unsupported") {
      // Nothing of any client shows on these screens; the user needs to see the QR code to link.
      this.shield.hide();
      return;
    }
    if (state === "loading") {
      const tooLong = this.opts.timers.now() - this.startedAt >= (this.opts.loadingTimeoutMs ?? 60_000);
      if (tooLong) this.runSelfCheck();
      if (!this.failing) this.shield.show("loading");
      return;
    }

    let title: string | null;
    try {
      title = readConversationTitle(doc);
    } catch (err) {
      if (err instanceof SelectorError) {
        this.fail(err.failing);
        return;
      }
      throw err;
    }

    let verdict = decideChat(title, this.policy, this.opts.timers.now());
    if (verdict === "adopt") {
      const armedAt = this.policy.pendingHandoff?.armedAt;
      // Only the page the hand-off loaded may adopt: one already open when it started can't.
      const pageOlderThanHandoff = armedAt !== undefined && this.startedAt < armedAt;
      if (this.adoptConsumed || title === null || pageOlderThanHandoff) {
        verdict = "deny";
      } else {
        this.adoptConsumed = true;
        this.policy = { ...this.policy, sessionChats: [...this.policy.sessionChats, title], pendingHandoff: null };
        bridge.adopt(title);
        verdict = "allow";
      }
    } else if (verdict === "deny" && this.policy.pendingHandoff) {
      // A hand-off adopts the first chat that opens, or nothing: a refused chat uses it up.
      this.adoptConsumed = true;
      this.policy = { ...this.policy, pendingHandoff: null };
    }

    const isNew = this.report(title, verdict);

    if (verdict === "allow") {
      this.deniedTitle = null;
      this.mark(title!);
      // While opening, the search pane is un-hidden (its results can show other chats' message
      // snippets): the cover stays up until endOpening() hides the pane again.
      if (this.opening) this.shield.show("opening", this.opening);
      else this.shield.hide();
      return;
    }

    this.unmark();
    if (verdict === "none") {
      if (this.opening) this.shield.show("opening", this.opening);
      else this.shield.show(this.policy.notice === "not-allowed" || this.deniedTitle ? "denied" : "idle");
      return;
    }

    // deny: every time a refused chat appears, close it again (the main process logs once a day).
    this.shield.show("denied");
    this.deniedTitle = title;
    if (isNew) {
      bridge.accessDenied(title!);
      this.closeChat(title!);
    }
  }

  /** Tells the main process what is open; returns false if nothing changed since the last report. */
  private report(title: string | null, verdict: ChatVerdict): boolean {
    const last = this.lastReported;
    if (last && last.title === title && last.verdict === verdict) return false;
    this.lastReported = { title, verdict };
    this.opts.bridge.openTitle(title, verdict);
    return true;
  }

  private fail(failing: string[]): void {
    const changed = !this.failing || this.failing.join() !== failing.join();
    this.failing = failing;
    this.unmark();
    this.shield.show("unavailable");
    if (changed) this.opts.bridge.selectors(false, failing);
  }

  /** Close the refused chat the way a user would (Escape); reload the page if that didn't work. */
  private closeChat(title: string): void {
    const { doc, timers } = this.opts;
    const target = (doc.activeElement as HTMLElement | null) ?? doc.body;
    const KE = (doc.defaultView as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
    const init = { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true, composed: true };
    target?.dispatchEvent(new KE("keydown", init));
    target?.dispatchEvent(new KE("keyup", init));
    if (this.closeTimer !== null) timers.clearTimeout(this.closeTimer);
    this.closeTimer = timers.setTimeout(() => {
      this.closeTimer = null;
      let still: string | null = null;
      try {
        still = readConversationTitle(doc);
      } catch {
        still = null;
      }
      if (still !== null && normalizeTitle(still) === normalizeTitle(title)) this.opts.bridge.resetPage();
    }, this.opts.closeVerifyMs ?? 600);
  }

  private mark(title: string): void {
    const pane = q(this.opts.doc, "conversation");
    if (pane && pane.getAttribute(ALLOWED_MARK) !== normalizeTitle(title)) pane.setAttribute(ALLOWED_MARK, normalizeTitle(title));
  }

  private unmark(): void {
    const pane = q(this.opts.doc, "conversation");
    if (pane?.hasAttribute(ALLOWED_MARK)) pane.removeAttribute(ALLOWED_MARK);
  }

  /**
   * Client mode's rules apply through attributes on <html>; the static CSS is added once, as a
   * constructed stylesheet (not subject to the page's CSP), or a <style> where that isn't
   * supported. The main process injects the same CSS with insertCSS as well.
   */
  private ensureStyle(): void {
    const doc = this.opts.doc;
    const root = doc.documentElement;
    // At document start (where the preload runs) <html> may not exist yet; the
    // MutationObserver calls evaluate() again as soon as it does.
    if (!root) return;
    if (!root.hasAttribute(CLIENT_MODE_ATTR)) root.setAttribute(CLIENT_MODE_ATTR, "");
    if (this.opening !== null) {
      if (!root.hasAttribute(OPENING_ATTR)) root.setAttribute(OPENING_ATTR, "");
    } else if (root.hasAttribute(OPENING_ATTR)) {
      root.removeAttribute(OPENING_ATTR);
    }
    if (this.styleApplied) return;
    this.styleApplied = true;
    const view = doc.defaultView as (Window & { CSSStyleSheet?: typeof CSSStyleSheet }) | null;
    try {
      const sheet = new view!.CSSStyleSheet!();
      sheet.replaceSync(clientModeCss());
      doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
      return;
    } catch {
      // fall back to a <style> element
    }
    if (doc.getElementById(STYLE_ID)) return;
    const el = doc.createElement("style");
    el.id = STYLE_ID;
    el.textContent = clientModeCss();
    (doc.head ?? doc.documentElement).appendChild(el);
  }

  /** Client mode off: drop the attributes (the scoped CSS then matches nothing). */
  private removeStyle(): void {
    const root = this.opts.doc.documentElement;
    if (!root) return;
    root.removeAttribute(CLIENT_MODE_ATTR);
    root.removeAttribute(OPENING_ATTR);
  }
}
