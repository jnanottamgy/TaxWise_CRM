/**
 * The WhatsApp panel (§7.25.3–§7.25.7): one WebContentsView per firm number, the panel header
 * view, the splitter, pop-out, number switching, linking, Open chat, hand-offs and client mode's
 * main-process side. Decisions come from the pure modules; this file only applies them.
 */

import { randomUUID } from "node:crypto";
import { BaseWindow, WebContentsView, session, type Session, type WebContents } from "electron";
import { ARG, PUSH } from "../shared/channels";
import { normalizeTitle } from "../shared/chat-rules";
import { HANDOFF_ADOPT_MS, PANEL, POLICY_RECHECK_MS, SELECTOR_CHECK_MS, WHATSAPP_HOME } from "../shared/config";
import { COPY } from "../shared/copy";
import type { DesktopContext, OpenChatResult, PanelViewState, WhatsAppConfig, WhatsAppPageState } from "../shared/types";
import type { DesktopApi } from "./api";
import { buildClientModePolicy, chatsToClose, clientForTitle, effectiveClientMode, type ContextDiff, type ContextService, type ContextState } from "./context";
import type { OpenClient } from "./downloads";
import { acceptAdoption, inputCancelsHandoff, type PendingHandoff } from "./handoff";
import { bannerHeight, clampPanelWidth, dockedLayout, hiddenLayout, poppedLayout, widthFromScreenX } from "./layout";
import type { DeviceState, JsonFile, WindowState } from "./local-state";
import type { Logger } from "./log";
import type { ViewKind } from "./navigation";
import { defaultNumberId, firstToLink, numbersForPanel } from "./numbers";
import { ClientModeReporter } from "./reporters";
import { buildPanelState } from "./panel-state";
import { waPartition } from "./partitions";
import type { ViewRegistry } from "./registry";
import { clearCacheAndReload, userAgentMatches } from "./user-agent";
import { secureWebPreferences } from "./web-preferences";
import { clientModeCss, clientModeGuardCss } from "../whatsapp/client-mode-css";
import { inviteFallbackUrl } from "../whatsapp/open-chat";

export interface PanelDeps {
  win: BaseWindow;
  crmView: WebContentsView;
  headerView: WebContentsView;
  isDev: boolean;
  version: string;
  waPreload: string;
  userAgent: string;
  api: DesktopApi;
  context: ContextService;
  device: { state: DeviceState; file: JsonFile<DeviceState> };
  windowState: { state: WindowState; file: JsonFile<WindowState> };
  registry: ViewRegistry;
  log: Logger;
  /** Permission handlers, user agent, downloads (once per session). */
  prepareWhatsAppSession(ses: Session): void;
  guardWebContents(kind: ViewKind, wc: WebContents): void;
  backgroundColor: string;
}

interface WaView {
  numberId: string;
  view: WebContentsView;
  clientMode: boolean;
  pageState: WhatsAppPageState | null;
  openTitle: string | null;
  openVerdict: string | null;
  uaRetried: boolean;
  /** Callers waiting for the page to settle (QR screen or chat list). */
  settled: Array<(state: WhatsAppPageState) => void>;
}

type Waiter<T> = { resolve: (v: T) => void; timer: ReturnType<typeof setTimeout> };

export class WhatsAppPanel {
  private visible: boolean;
  private mode: "docked" | "popped" = "docked";
  private width: number;
  private dragging = false;
  private popout: BaseWindow | null = null;
  private readonly views = new Map<string, WaView>();
  private attachedId: string | null = null;
  private activeNumberId: string | null = null;
  private linkingNumberId: string | null = null;
  private notice: { tone: "info" | "warning" | "danger"; text: string } | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly failing = new Map<string, string[]>();
  private revoked: boolean;
  private offline = false;
  private crmListeners = 0;
  private lastView: PanelViewState | null = null;
  private lastPolicyKey = "";

  private readonly sessionChats = new Set<string>();
  private pendingHandoff: PendingHandoff | null = null;
  private deniedNotice: "not-allowed" | null = null;
  private readonly opened = new Map<string, { clientId: string; clientName: string }>();
  /** Chats the app itself is closing because a context refresh removed them (not an access attempt). */
  private readonly closingForPolicy = new Set<string>();

  private readonly openWaiters = new Map<string, Waiter<{ ok: boolean; reason: string | null }>>();
  private readonly titleWaiters = new Map<string, Waiter<string | null>>();
  private readonly reporter: ClientModeReporter;
  /** WhatsApp webContents not yet destroyed (a removed PC's wipe waits for them). */
  private readonly liveContents = new Set<WebContents>();
  private readonly closedWaiters: Array<() => void> = [];
  private readonly recheckTimer: ReturnType<typeof setInterval>;

  constructor(private readonly d: PanelDeps) {
    this.visible = d.windowState.state.panelVisible;
    this.width = d.windowState.state.panelWidth;
    this.revoked = d.device.state.revoked;
    this.reporter = new ClientModeReporter(d.api, (kind) => this.handleAuthResult(kind));
    d.win.on("resize", () => this.layout());
    d.headerView.webContents.on("did-finish-load", () => this.refresh());
    // Client mode fails closed once the context is stale (§7.25.5 covers end within minutes):
    // re-check on a short timer, not only when a refresh result arrives.
    this.recheckTimer = setInterval(() => this.pushPolicy(false, true), POLICY_RECHECK_MS);
  }

  /* ---------------------------------------------------------------- */
  /* State                                                             */
  /* ---------------------------------------------------------------- */

  private get ctx(): DesktopContext | null {
    return this.d.context.context;
  }

  private linkedHere(): Set<string> {
    return new Set(Object.keys(this.d.device.state.linked));
  }

  private isShown(): boolean {
    return this.visible && (this.ctx !== null || this.revoked);
  }

  role() {
    return this.ctx?.user.role ?? null;
  }

  crmReady(): boolean {
    return this.crmListeners > 0 && this.ctx !== null;
  }

  setCrmListeners(count: number): void {
    this.crmListeners = count;
  }

  viewState(): PanelViewState {
    return this.compute().view;
  }

  private compute() {
    const active = this.linkingNumberId ?? this.activeNumberId;
    const v = active ? this.views.get(active) : undefined;
    const openClient = v ? clientForTitle(v.openTitle, this.ctx, this.opened) : null;
    const bounds = this.d.win.getContentBounds();
    const docked = dockedLayout(bounds, this.width, 0, this.dragging);
    return buildPanelState({
      mode: this.mode,
      width: clampPanelWidth(this.width, bounds.width),
      dragging: this.dragging,
      offsetX: this.dragging ? docked.panelX : 0,
      ctx: this.ctx,
      linkedHere: this.linkedHere(),
      activeNumberId: this.activeNumberId,
      linkingNumberId: this.linkingNumberId,
      revoked: this.revoked,
      offline: this.offline,
      clientModeFailed: active ? this.failing.has(active) : false,
      activePageState: v?.pageState ?? null,
      openClientName: openClient?.clientName ?? null,
      notice: this.notice,
    });
  }

  /** Recompute everything and apply it: views, layout, header. */
  refresh(): void {
    if (this.d.win.isDestroyed()) return; // late async results while quitting
    const out = this.compute();
    this.applyViews(out.view, out.showNumberId);
    this.lastView = out.view;
    this.layout();
    if (!this.d.headerView.webContents.isDestroyed()) this.d.headerView.webContents.send(PUSH.panelState, out.view);
  }

  /* ---------------------------------------------------------------- */
  /* Views                                                             */
  /* ---------------------------------------------------------------- */

  private container(): BaseWindow {
    return this.mode === "popped" && this.popout ? this.popout : this.d.win;
  }

  private applyViews(_view: PanelViewState, showId: string | null): void {
    const target = this.isShown() ? showId : null;
    if (target === null) {
      if (this.attachedId) this.detach(this.attachedId);
      return;
    }
    const v = this.ensureView(target);
    if (this.attachedId && this.attachedId !== target) this.detach(this.attachedId);
    if (this.attachedId !== target) {
      this.container().contentView.addChildView(v.view);
      this.attachedId = target;
    }
    v.view.setVisible(true);
  }

  private detach(numberId: string): void {
    const v = this.views.get(numberId);
    if (v) {
      v.view.setVisible(false);
      for (const w of [this.d.win, this.popout]) {
        if (w && !w.isDestroyed() && w.contentView.children.includes(v.view)) w.contentView.removeChildView(v.view);
      }
    }
    if (this.attachedId === numberId) this.attachedId = null;
  }

  private ensureView(numberId: string): WaView {
    const ctx = this.ctx;
    const clientMode = ctx ? effectiveClientMode(ctx) : true;
    const existing = this.views.get(numberId);
    if (existing && existing.clientMode === clientMode && !existing.view.webContents.isDestroyed()) return existing;
    if (existing) this.destroyView(numberId);

    const partition = waPartition(numberId);
    const ses = session.fromPartition(partition);
    this.d.prepareWhatsAppSession(ses);
    const dev = this.d.device.state;
    if (!dev.partitions.includes(partition)) {
      dev.partitions.push(partition);
      this.d.device.file.saveNow(dev);
    }

    const view = new WebContentsView({
      webPreferences: secureWebPreferences({
        partition,
        preload: this.d.waPreload,
        devTools: this.d.isDev,
        additionalArguments: [`${ARG.version}${this.d.version}`, `${ARG.clientMode}${clientMode ? "1" : "0"}`],
        backgroundThrottling: false,
        spellcheck: true,
      }),
    });
    view.setBackgroundColor(this.d.backgroundColor);
    const wc = view.webContents;
    this.d.registry.add("whatsapp", wc.id, numberId);
    this.d.guardWebContents("whatsapp", wc);
    const id = wc.id;
    this.liveContents.add(wc);
    wc.once("destroyed", () => {
      this.d.registry.remove(id);
      this.liveContents.delete(wc);
      if (this.liveContents.size === 0) for (const resolve of this.closedWaiters.splice(0)) resolve();
    });
    wc.on("render-process-gone", () => {
      this.d.log("whatsapp: renderer gone", { numberId });
      this.destroyView(numberId);
      this.refresh();
    });
    const entry: WaView = { numberId, view, clientMode, pageState: null, openTitle: null, openVerdict: null, uaRetried: false, settled: [] };
    // Client mode's hiding rules at user origin: WhatsApp's CSP can't block them and its own
    // !important rules can't override them. They match only while the preload marks <html>.
    wc.on("dom-ready", () => {
      void wc.insertCSS(clientModeCss(), { cssOrigin: "user" }).catch(() => undefined);
      // In client mode the page stays hidden until the preload is running on it (fail closed).
      if (clientMode) void wc.insertCSS(clientModeGuardCss(), { cssOrigin: "user" }).catch(() => undefined);
    });
    wc.on("did-navigate", () => {
      // The page a hand-off loaded is now the one showing (handoff.ts: only it may adopt).
      if (this.pendingHandoff && this.pendingHandoff.numberId === numberId) this.pendingHandoff.committed = true;
    });
    wc.on("did-start-navigation", (e) => {
      // A new document: its preload reports again once it has settled.
      if (e.isMainFrame && !e.isSameDocument) {
        entry.pageState = null;
        entry.openTitle = null;
        entry.openVerdict = null;
      }
    });
    this.views.set(numberId, entry);
    void wc.loadURL(WHATSAPP_HOME);
    return entry;
  }

  private destroyView(numberId: string): void {
    const v = this.views.get(numberId);
    if (!v) return;
    this.detach(numberId);
    this.views.delete(numberId);
    this.failing.delete(numberId);
    this.d.registry.remove(v.view.webContents.id);
    if (!v.view.webContents.isDestroyed()) v.view.webContents.close();
  }

  private destroyAllViews(): void {
    for (const id of [...this.views.keys()]) this.destroyView(id);
  }

  configFor(webContentsId: number): WhatsAppConfig | null {
    const numberId = this.d.registry.numberOf(webContentsId);
    const ctx = this.ctx;
    if (!numberId || !ctx) return null;
    const n = ctx.numbers.find((x) => x.id === numberId);
    return {
      numberId,
      numberLabel: n?.label ?? "WhatsApp",
      policy: this.policy(),
      selectorCheckMs: SELECTOR_CHECK_MS,
    };
  }

  private policy() {
    return buildClientModePolicy(
      this.ctx,
      {
        sessionChats: [...this.sessionChats],
        pendingHandoff: this.pendingHandoff
          ? { phoneDigits: this.pendingHandoff.phoneDigits, expiresAt: this.pendingHandoff.expiresAt, armedAt: this.pendingHandoff.armedAt }
          : null,
        notice: this.deniedNotice,
      },
      this.d.context.lastGoodAt,
      Date.now(),
    );
  }

  /**
   * Send the current policy to every WhatsApp view (only when it changed). After a context refresh,
   * an allowed chat that the new policy refuses (a cover that ended) is closed by the preload; that
   * close is the app's doing, so it is not logged as an access attempt.
   */
  private pushPolicy(force = false, fromContext = false): void {
    const policy = this.policy();
    const key = JSON.stringify(policy);
    if (!force && key === this.lastPolicyKey) return;
    this.lastPolicyKey = key;
    if (fromContext) {
      const open = [...this.views.values()]
        .filter((v) => v.openTitle !== null && v.openVerdict === "allow")
        .map((v) => ({ numberId: v.numberId, title: v.openTitle! }));
      for (const c of chatsToClose(open, policy, Date.now())) {
        this.closingForPolicy.add(`${c.numberId}|${normalizeTitle(c.title)}`);
        this.d.log("client mode: closing a chat no longer allowed", { numberId: c.numberId });
      }
    }
    for (const v of this.views.values()) {
      const cfg = this.configFor(v.view.webContents.id);
      if (cfg && !v.view.webContents.isDestroyed()) v.view.webContents.send(PUSH.waConfig, cfg);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Layout                                                            */
  /* ---------------------------------------------------------------- */

  layout(): void {
    const { win, crmView, headerView } = this.d;
    if (win.isDestroyed()) return;
    const content = win.getContentBounds();
    const banner = bannerHeight(this.lastView?.banner ?? null);
    const active = this.attachedId ? this.views.get(this.attachedId) : undefined;

    if (!this.isShown()) {
      crmView.setBounds(hiddenLayout(content).crm);
      headerView.setVisible(false);
      return;
    }
    if (this.mode === "popped" && this.popout && !this.popout.isDestroyed()) {
      crmView.setBounds(hiddenLayout(content).crm);
      const p = poppedLayout(this.popout.getContentBounds(), banner);
      headerView.setBounds(p.header);
      headerView.setVisible(true);
      active?.view.setBounds(p.whatsapp);
      return;
    }
    const L = dockedLayout(content, this.width, banner, this.dragging);
    crmView.setBounds(L.crm);
    headerView.setBounds(L.header);
    headerView.setVisible(true);
    active?.view.setBounds(L.whatsapp);
  }

  /* ---------------------------------------------------------------- */
  /* Show, hide, pop out, resize                                       */
  /* ---------------------------------------------------------------- */

  toggle(): { visible: boolean } {
    if (this.isShown()) this.hide();
    else this.show();
    return { visible: this.isShown() };
  }

  show(): void {
    if (!this.visible) {
      this.visible = true;
      this.saveWindowState();
    }
    this.refresh();
    if (this.mode === "popped") this.popout?.focus();
    const v = this.attachedId ? this.views.get(this.attachedId) : undefined;
    v?.view.webContents.focus();
  }

  hide(): void {
    if (this.mode === "popped") this.dock();
    this.visible = false;
    this.saveWindowState();
    this.refresh();
    this.d.crmView.webContents.focus();
  }

  popOut(): void {
    if (this.mode === "popped" && this.popout) {
      this.popout.focus();
      return;
    }
    const saved = this.d.windowState.state.popoutBounds;
    const pop = new BaseWindow({
      title: "WhatsApp · TaxWise Desktop",
      width: saved?.width ?? Math.max(PANEL.minWidth, this.width),
      height: saved?.height ?? this.d.win.getContentBounds().height,
      ...(saved ? { x: saved.x, y: saved.y } : {}),
      minWidth: PANEL.minWidth,
      minHeight: 400,
      backgroundColor: this.d.backgroundColor,
      autoHideMenuBar: true,
    });
    this.popout = pop;
    this.mode = "popped";
    this.d.win.contentView.removeChildView(this.d.headerView);
    pop.contentView.addChildView(this.d.headerView);
    if (this.attachedId) {
      const v = this.views.get(this.attachedId);
      if (v) {
        this.d.win.contentView.removeChildView(v.view);
        pop.contentView.addChildView(v.view);
      }
    }
    pop.on("resize", () => this.layout());
    pop.on("close", () => {
      // The user closed the pop-out window: WhatsApp goes back beside TaxWise.
      if (this.popout === pop) this.dock(true);
    });
    this.visible = true;
    this.refresh();
    pop.focus();
  }

  dock(closing = false): void {
    const pop = this.popout;
    if (!pop) return;
    this.popout = null;
    this.mode = "docked";
    if (!pop.isDestroyed()) {
      this.d.windowState.state.popoutBounds = pop.getBounds();
      // Take the views out first: closing a window must not take WhatsApp's page with it.
      for (const child of [...pop.contentView.children]) pop.contentView.removeChildView(child);
    }
    this.d.win.contentView.addChildView(this.d.headerView);
    if (this.attachedId) {
      const v = this.views.get(this.attachedId);
      if (v) this.d.win.contentView.addChildView(v.view);
    }
    if (!closing && !pop.isDestroyed()) pop.destroy();
    this.saveWindowState();
    this.refresh();
  }

  drag(phase: "start" | "move" | "end", screenX: number): void {
    if (this.mode !== "docked" || !this.isShown()) return;
    if (phase === "start") {
      this.dragging = true;
      this.d.win.contentView.addChildView(this.d.headerView); // on top, covering the window
      this.refresh();
      return;
    }
    if (!this.dragging) return;
    this.width = widthFromScreenX(screenX, this.d.win.getContentBounds());
    if (phase === "end") {
      this.dragging = false;
      if (this.attachedId) {
        const v = this.views.get(this.attachedId);
        if (v) this.d.win.contentView.addChildView(v.view); // WhatsApp back on top of the header
      }
      this.saveWindowState();
    }
    this.refresh();
  }

  setWidth(width: number): void {
    this.width = clampPanelWidth(width, this.d.win.getContentBounds().width);
    this.saveWindowState();
    this.refresh();
  }

  private saveWindowState(): void {
    const s = this.d.windowState.state;
    s.panelVisible = this.visible;
    s.panelWidth = Math.min(PANEL.maxWidth, Math.max(PANEL.minWidth, this.width));
    this.d.windowState.file.save(s);
  }

  /* ---------------------------------------------------------------- */
  /* Numbers                                                           */
  /* ---------------------------------------------------------------- */

  switchNumber(numberId: string): void {
    const { visible } = numbersForPanel(this.ctx, this.linkedHere());
    if (!visible.some((n) => n.id === numberId)) return;
    this.activeNumberId = numberId;
    this.linkingNumberId = null;
    const user = this.ctx?.user;
    if (user) {
      this.d.windowState.state.lastNumberByUser[user.id] = numberId;
      this.d.windowState.file.save(this.d.windowState.state);
    }
    this.refresh();
  }

  linkNumber(numberId: string): void {
    const { linkable } = numbersForPanel(this.ctx, this.linkedHere());
    if (!linkable.some((n) => n.id === numberId)) return;
    this.linkingNumberId = numberId;
    this.show();
  }

  /* ---------------------------------------------------------------- */
  /* Context                                                           */
  /* ---------------------------------------------------------------- */

  onContext(state: ContextState, diff: ContextDiff, error: string | null): void {
    if (state.kind === "signed-out") {
      this.signOut();
      return;
    }
    if (state.kind === "revoked") {
      this.revokeView();
      return;
    }
    if (state.kind !== "signed-in") {
      this.offline = error !== null;
      this.refresh();
      return;
    }
    this.offline = false;
    if (this.revoked) {
      // The API accepts this PC again (a Partner re-added it).
      this.revoked = false;
    }
    if (diff.userChanged) {
      this.resetSession();
      this.destroyAllViews();
      this.activeNumberId = null;
      this.linkingNumberId = null;
    }
    const { visible, linkable } = numbersForPanel(state.ctx, this.linkedHere());
    const usable = new Set([...visible, ...linkable].map((n) => n.id));
    for (const id of [...this.views.keys()]) if (!usable.has(id)) this.destroyView(id);
    if (this.linkingNumberId && !linkable.some((n) => n.id === this.linkingNumberId)) this.linkingNumberId = null;
    if (!this.activeNumberId || !visible.some((n) => n.id === this.activeNumberId)) {
      this.activeNumberId = defaultNumberId(state.ctx.user, visible, this.d.windowState.state.lastNumberByUser[state.ctx.user.id] ?? null);
    }
    if (!this.activeNumberId && !this.linkingNumberId) this.linkingNumberId = firstToLink(state.ctx.user, linkable)?.id ?? null;
    this.pushPolicy(diff.userChanged || diff.clientModeChanged, true);
    this.refresh();
  }

  private resetSession(): void {
    this.sessionChats.clear();
    this.pendingHandoff = null;
    this.deniedNotice = null;
    this.opened.clear();
    this.closingForPolicy.clear();
    this.lastPolicyKey = "";
    this.clearNotice();
  }

  /** CRM sign-out: hide WhatsApp at once. The numbers stay linked on this PC for the next person. */
  signOut(): void {
    this.resetSession();
    this.destroyAllViews();
    this.activeNumberId = null;
    this.linkingNumberId = null;
    this.failing.clear();
    if (this.mode === "popped") this.dock();
    this.refresh();
  }

  /** A Partner removed this PC: drop every WhatsApp view and show the removed-PC screen. */
  revokeView(): void {
    this.revoked = true;
    this.resetSession();
    this.destroyAllViews();
    this.activeNumberId = null;
    this.linkingNumberId = null;
    this.visible = true;
    this.refresh();
  }

  /* ---------------------------------------------------------------- */
  /* Notices                                                           */
  /* ---------------------------------------------------------------- */

  private setNotice(tone: "info" | "warning" | "danger", text: string, ms = 15000): void {
    this.notice = { tone, text };
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => this.clearNotice(true), ms);
    this.refresh();
  }

  clearNotice(apply = false): void {
    this.notice = null;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
    if (apply) this.refresh();
  }

  /* ---------------------------------------------------------------- */
  /* Messages from the WhatsApp preload (sender already checked)       */
  /* ---------------------------------------------------------------- */

  private viewFor(webContentsId: number): WaView | null {
    const numberId = this.d.registry.numberOf(webContentsId);
    return numberId ? (this.views.get(numberId) ?? null) : null;
  }

  onPageState(webContentsId: number, state: WhatsAppPageState, userAgent: string | null): void {
    const v = this.viewFor(webContentsId);
    if (!v) return;
    v.pageState = state;
    if (state === "chats" || state === "qr") for (const resolve of v.settled.splice(0)) resolve(state);
    const wc = v.view.webContents;
    if ((userAgent !== null && !userAgentMatches(userAgent, this.d.userAgent)) || state === "unsupported") {
      this.d.log("whatsapp: browser not accepted, clearing cache", { numberId: v.numberId, uaOk: userAgentMatches(userAgent, this.d.userAgent) });
      const tried = v.uaRetried;
      v.uaRetried = true;
      void clearCacheAndReload(wc.session, wc, tried);
    }
    const dev = this.d.device.state;
    if (state === "chats") {
      if (!(v.numberId in dev.linked)) {
        dev.linked[v.numberId] = Date.now();
        this.d.device.file.saveNow(dev);
        void this.reportLink(v.numberId, true);
      }
      if (this.linkingNumberId === v.numberId) {
        this.linkingNumberId = null;
        this.activeNumberId = v.numberId;
      }
    } else if (state === "qr") {
      if (v.numberId in dev.linked) {
        // The phone removed this PC (or the 14-day rule): it isn't linked here any more.
        delete dev.linked[v.numberId];
        this.d.device.file.saveNow(dev);
        void this.reportLink(v.numberId, false);
        if (this.activeNumberId === v.numberId) this.linkingNumberId = v.numberId;
      }
    }
    this.refresh();
  }

  onOpenTitle(webContentsId: number, title: string | null, decision: string): void {
    const v = this.viewFor(webContentsId);
    if (!v) return;
    v.openTitle = title;
    v.openVerdict = decision;
    if (decision === "allow" && this.deniedNotice) {
      this.deniedNotice = null;
      this.pushPolicy();
    }
    this.refresh();
  }

  onAdopt(webContentsId: number, title: string): void {
    const v = this.viewFor(webContentsId);
    if (!v) return;
    const ok = acceptAdoption(this.pendingHandoff, v.numberId, title, this.policy(), Date.now());
    // Single use either way: the page proposed a chat for this hand-off.
    this.pendingHandoff = null;
    if (ok) {
      this.sessionChats.add(title);
      this.pushPolicy();
      return;
    }
    // Refused: resend the policy so the page drops the chat it adopted and closes it.
    this.d.log("client mode: refused a hand-off adoption", { numberId: v.numberId });
    this.pushPolicy(true);
  }

  /** Keyboard input reached a WhatsApp view (before-input-event): a pending hand-off ends here. */
  onWhatsAppInput(webContentsId: number, input: { type: string }): void {
    if (!this.pendingHandoff || !inputCancelsHandoff(input)) return;
    if (!this.viewFor(webContentsId)) return;
    this.pendingHandoff = null;
    this.pushPolicy();
  }

  onAccessDenied(webContentsId: number, title: string): void {
    const v = this.viewFor(webContentsId);
    if (!v) return;
    const key = `${v.numberId}|${normalizeTitle(title)}`;
    if (this.closingForPolicy.delete(key)) return; // closed because a cover ended, not an attempt
    this.deniedNotice = "not-allowed";
    this.pushPolicy();
    void this.reporter.accessDenied(v.numberId, title, Date.now());
  }

  onSelectors(webContentsId: number, ok: boolean, failing: string[]): void {
    const v = this.viewFor(webContentsId);
    if (!v) return;
    if (ok) {
      this.failing.delete(v.numberId);
    } else {
      this.failing.set(v.numberId, failing);
      this.d.log("client mode: selectors failed, failing closed", { numberId: v.numberId, failing });
      void this.reporter.selectorsFailed(v.numberId, failing, Date.now());
    }
    this.refresh();
  }

  onReset(webContentsId: number): void {
    const v = this.viewFor(webContentsId);
    if (v) void v.view.webContents.loadURL(WHATSAPP_HOME);
  }

  onOpenChatResult(requestId: string, ok: boolean, reason: string | null): void {
    const w = this.openWaiters.get(requestId);
    if (!w) return;
    clearTimeout(w.timer);
    this.openWaiters.delete(requestId);
    w.resolve({ ok, reason });
  }

  onTitleResult(requestId: string, title: string | null): void {
    const w = this.titleWaiters.get(requestId);
    if (!w) return;
    clearTimeout(w.timer);
    this.titleWaiters.delete(requestId);
    w.resolve(title);
  }

  private handleAuthResult(kind: string): void {
    if (kind === "signed-out") this.d.context.markSignedOut();
    if (kind === "revoked") this.d.context.markRevoked();
  }

  private async reportLink(numberId: string, linked: boolean): Promise<void> {
    const r = await this.d.api.link(numberId, linked);
    if (r.kind === "ok") return;
    this.handleAuthResult(r.kind);
    const dev = this.d.device.state;
    dev.pendingLinkReports = [...dev.pendingLinkReports.filter((p) => p.numberId !== numberId), { numberId, linked }];
    this.d.device.file.saveNow(dev);
  }

  /** Retry link reports the API didn't take (after a sign-in, say). */
  async flushLinkReports(): Promise<void> {
    const dev = this.d.device.state;
    const queue = dev.pendingLinkReports;
    if (queue.length === 0) return;
    dev.pendingLinkReports = [];
    this.d.device.file.saveNow(dev);
    for (const p of queue) await this.reportLink(p.numberId, p.linked);
  }

  /* ---------------------------------------------------------------- */
  /* Open chat and hand-offs                                           */
  /* ---------------------------------------------------------------- */

  /** Resolves once the page shows the chat list or the QR screen (null on timeout). */
  private whenSettled(v: WaView, timeoutMs: number): Promise<WhatsAppPageState | null> {
    if (v.pageState === "chats" || v.pageState === "qr") return Promise.resolve(v.pageState);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        v.settled = v.settled.filter((f) => f !== done);
        resolve(null);
      }, timeoutMs);
      const done = (state: WhatsAppPageState) => {
        clearTimeout(timer);
        resolve(state);
      };
      v.settled.push(done);
    });
  }

  private requestOpen(v: WaView, groupName: string, timeoutMs = 45_000): Promise<{ ok: boolean; reason: string | null }> {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.openWaiters.delete(requestId);
        resolve({ ok: false, reason: "timeout" });
      }, timeoutMs);
      this.openWaiters.set(requestId, { resolve, timer });
      v.view.webContents.send(PUSH.waOpenChat, { requestId, groupName });
    });
  }

  private queryTitle(v: WaView, timeoutMs = 3000): Promise<string | null> {
    if (v.view.webContents.isDestroyed()) return Promise.resolve(null);
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.titleWaiters.delete(requestId);
        resolve(null);
      }, timeoutMs);
      this.titleWaiters.set(requestId, { resolve, timer });
      v.view.webContents.send(PUSH.waQueryTitle, { requestId });
    });
  }

  private async waitForTitle(v: WaView, groupName: string, timeoutMs: number): Promise<boolean> {
    const want = normalizeTitle(groupName);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      if (!this.views.has(v.numberId)) return false;
      const t = await this.queryTitle(v);
      if (t !== null && normalizeTitle(t) === want) return true;
    }
    return false;
  }

  async openClientChat(clientId: string): Promise<OpenChatResult> {
    if (this.revoked) return { ok: false, error: COPY.pcRemoved };
    const state = await this.d.context.refresh();
    if (state.kind === "revoked") return { ok: false, error: COPY.pcRemoved };
    if (state.kind !== "signed-in") return { ok: false, error: COPY.signInFirst };
    const res = await this.d.api.openWhatsApp(clientId);
    if (res.kind === "signed-out") {
      this.d.context.markSignedOut();
      return { ok: false, error: COPY.signInFirst };
    }
    if (res.kind === "revoked") {
      this.d.context.markRevoked();
      return { ok: false, error: COPY.pcRemoved };
    }
    if (res.kind !== "ok") return { ok: false, error: res.message };
    const data = res.data;
    const ctx = state.ctx;

    const { visible, linkable } = numbersForPanel(ctx, this.linkedHere());
    const number = visible.find((n) => n.id === data.numberId);
    if (!number) {
      const toLink = linkable.find((n) => n.id === data.numberId);
      if (toLink) {
        this.linkingNumberId = toLink.id;
        this.show();
        return { ok: false, error: COPY.notLinkedHere(toLink.label) };
      }
      return { ok: false, error: COPY.numberNotYours };
    }

    const listed = ctx.allowedGroups?.find((g) => normalizeTitle(g.groupName) === normalizeTitle(data.groupName));
    this.opened.set(data.groupName, { clientId, clientName: data.clientName ?? listed?.clientName ?? data.groupName });
    this.activeNumberId = number.id;
    this.linkingNumberId = null;
    this.clearNotice();
    this.show();
    const v = this.views.get(number.id) ?? this.ensureView(number.id);

    // A new view's preload must be listening before it is asked to search.
    const settled = await this.whenSettled(v, 45_000);
    if (settled === "qr") {
      this.linkingNumberId = number.id;
      this.refresh();
      return { ok: false, error: COPY.notLinkedHere(number.label) };
    }
    if (settled === null) return { ok: false, error: COPY.whatsappNotReady };

    const first = await this.requestOpen(v, data.groupName);
    if (first.ok) return { ok: true };
    if (first.reason === "not-linked") return { ok: false, error: COPY.notLinkedHere(number.label) };
    if (first.reason === "not-ready" || first.reason === "timeout") {
      this.d.log("open chat: WhatsApp not ready", { reason: first.reason });
    }

    // Step 3: the invite link, loaded only in the WhatsApp view (never handed to the CRM page).
    const fallback = inviteFallbackUrl(data.inviteCode);
    if (fallback && this.views.has(number.id)) {
      void v.view.webContents.loadURL(fallback);
      if (await this.waitForTitle(v, data.groupName, 25_000)) return { ok: true };
    }
    const message = COPY.couldNotFind(data.groupName, number.label);
    this.setNotice("warning", message);
    return { ok: false, error: message };
  }

  /** A wa.me / api.whatsapp.com hand-off clicked in the CRM (§7.13.2), already rewritten and checked. */
  openHandoff(url: string, phone: string): void {
    const ctx = this.ctx;
    if (!ctx || this.revoked) return;
    const { visible } = numbersForPanel(ctx, this.linkedHere());
    const numberId = visible.some((n) => n.id === this.activeNumberId) ? this.activeNumberId : (visible[0]?.id ?? null);
    if (!numberId) {
      this.show();
      return;
    }
    this.activeNumberId = numberId;
    this.linkingNumberId = null;
    if (effectiveClientMode(ctx)) {
      const armedAt = Date.now();
      this.pendingHandoff = { numberId, phoneDigits: phone, armedAt, expiresAt: armedAt + HANDOFF_ADOPT_MS, committed: false };
      this.pushPolicy();
    }
    this.show();
    const v = this.views.get(numberId) ?? this.ensureView(numberId);
    void v.view.webContents.loadURL(url);
  }

  /** The client whose chat is open in the view that downloaded a file (§7.25.6). */
  async openClientFor(webContentsId: number): Promise<OpenClient | null> {
    const v = this.viewFor(webContentsId);
    const ctx = this.ctx;
    if (!v || !ctx) return null;
    const title = effectiveClientMode(ctx) ? v.openTitle : await this.queryTitle(v);
    return clientForTitle(title, ctx, this.opened);
  }

  /** Focus the WhatsApp view if it is showing. */
  focus(): void {
    const v = this.attachedId ? this.views.get(this.attachedId) : undefined;
    v?.view.webContents.focus();
  }

  /** Resolves once every WhatsApp page has been torn down (or after timeoutMs). */
  whenWhatsAppClosed(timeoutMs = 5000): Promise<void> {
    if (this.liveContents.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.closedWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  closeAll(): void {
    clearInterval(this.recheckTimer);
    this.destroyAllViews();
    if (this.popout && !this.popout.isDestroyed()) this.popout.destroy();
    this.popout = null;
  }
}
