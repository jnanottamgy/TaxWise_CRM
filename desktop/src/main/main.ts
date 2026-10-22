/**
 * TaxWise Desktop: the CRM with WhatsApp Web beside it (§7.25.3).
 *
 * One BaseWindow, three kinds of WebContentsView (never BrowserView):
 *   1. CRM view (persist:crm) loading TAXWISE_APP_URL, baked in at build time;
 *   2. WhatsApp panel, one persistent partition per firm number (persist:wa-<number_id>);
 *   3. panel header, local HTML from the app bundle.
 * This file wires Electron to the pure modules; it decides nothing itself.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  app,
  BaseWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  WebContentsView,
  type Session,
  type WebContents,
} from "electron";
import { autoUpdater } from "electron-updater";
import { ARG, PUSH } from "../shared/channels";
import { APP_ID, CRM_PARTITION, PANEL_PARTITION, PANEL_SCHEME, PANEL_URL, WINDOW } from "../shared/config";
import { COPY } from "../shared/copy";
import { createDesktopApi } from "./api";
import { resolveAppUrl } from "./app-url";
import { contentTypeFor, PANEL_CSP, resolveBundledAsset } from "./assets";
import { ContextService, type ContextDiff, type ContextState } from "./context";
import { describeDevice, loadOrCreateDeviceKey } from "./device";
import { DownloadManager } from "./downloads";
import { e2eFixtureDir, serveWhatsAppFixtures } from "./e2e";
import { registerInvoke, registerSend, type SenderRules } from "./ipc";
import { JsonFile, ensureVisible, parseDeviceState, parseWindowState } from "./local-state";
import { createLogger } from "./log";
import { applicationMenuTemplate, contextMenuTemplate, isToggleShortcut } from "./menu";
import { crmShowsSignedOutPage, decideNavigation, decideWindowOpen, isAuthCookie, type NavDecision, type ViewKind } from "./navigation";
import { WhatsAppPanel } from "./panel";
import { partitionsToWipe, wipeWhatsAppPartitions } from "./partitions";
import { installPermissionHandlers, type PermissionPolicy } from "./permissions";
import { ViewRegistry } from "./registry";
import { startUpdater } from "./updater";
import { applyWhatsAppUserAgent, chromeUserAgent } from "./user-agent";
import { secureWebPreferences } from "./web-preferences";

const isDev = !app.isPackaged;
const isMac = process.platform === "darwin";

// Development and end-to-end runs may keep their data elsewhere; a packaged app never reads this.
if (isDev && process.env.TAXWISE_USER_DATA_DIR) app.setPath("userData", process.env.TAXWISE_USER_DATA_DIR);

protocol.registerSchemesAsPrivileged([{ scheme: PANEL_SCHEME, privileges: { standard: true, secure: true } }]);
app.enableSandbox();

const registry = new ViewRegistry();

// Belt and braces for any webContents, including ones we didn't create: no <webview>, no new
// windows, no navigation unless the view is one of ours (ours get their own guard below).
app.on("web-contents-created", (_e, wc) => {
  wc.on("will-attach-webview", (e) => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("will-navigate", (e) => {
    if (registry.kindOf(wc.id) === null) e.preventDefault();
  });
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId(APP_ID);
  app.whenReady().then(start, (err: unknown) => {
    dialog.showErrorBox("TaxWise Desktop", `TaxWise Desktop couldn't start: ${String(err)}`);
    app.quit();
  });
}

function readOrNull(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

async function start(): Promise<void> {
  const urlResult = resolveAppUrl(__TAXWISE_APP_URL__, process.env.TAXWISE_APP_URL, app.isPackaged);
  if (!urlResult.ok) {
    dialog.showErrorBox("TaxWise Desktop", urlResult.error);
    app.quit();
    return;
  }
  const appUrl = urlResult.url;
  const appOrigin = appUrl.origin;
  const version = app.getVersion();
  const userData = app.getPath("userData");
  const log = createLogger(path.join(app.getPath("logs"), "taxwise-desktop.log"), fs, isDev);
  const dist = path.join(__dirname, "..");
  const rendererDir = path.join(dist, "renderer");
  const background = nativeTheme.shouldUseDarkColors ? "#0b0f17" : "#f6f7fb";

  /* ---- local state ------------------------------------------------ */

  const windowFile = new JsonFile(path.join(userData, "window-state.json"), parseWindowState, fs);
  const windowState = windowFile.load();
  const deviceFile = new JsonFile(path.join(userData, "device-state.json"), parseDeviceState, fs);
  const deviceState = deviceFile.load();

  const keyFile = path.join(userData, "device-key.json");
  const deviceKey = loadOrCreateDeviceKey(safeStorage, {
    read: () => readOrNull(keyFile),
    write: (data) => fs.writeFileSync(keyFile, data, { mode: 0o600 }),
  });
  if (deviceKey.created) log("device: new device key created");
  if (!deviceKey.encrypted) log("device: the OS credential store is unavailable; the key is protected by file permissions only");

  /* ---- sessions --------------------------------------------------- */

  let contextRef: ContextService | null = null;
  const policy = (): PermissionPolicy => ({
    role: contextRef?.context?.user.role ?? null,
    employeeNotifications: contextRef?.context?.employeeNotifications ?? false,
  });

  const crmSession = session.fromPartition(CRM_PARTITION);
  const panelSession = session.fromPartition(PANEL_PARTITION);
  installPermissionHandlers(crmSession, "crm", policy, appOrigin);
  installPermissionHandlers(panelSession, "panel", policy, appOrigin);
  installPermissionHandlers(session.defaultSession, "panel", policy, appOrigin);

  panelSession.protocol.handle(PANEL_SCHEME, (req) => {
    const rel = resolveBundledAsset(req.url);
    const file = rel ? path.join(rendererDir, rel) : null;
    if (!rel || !file || !file.startsWith(rendererDir + path.sep)) return new Response("Not found", { status: 404 });
    const body = readOrNull(file);
    if (!body) return new Response("Not found", { status: 404 });
    return new Response(new Uint8Array(body), {
      headers: {
        "content-type": contentTypeFor(rel)!,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": PANEL_CSP,
      },
    });
  });

  const api = createDesktopApi({
    fetch: (url, init) => crmSession.fetch(url, init),
    appOrigin,
    deviceKey: deviceKey.key,
    appVersion: version,
  });

  /* ---- window and views ------------------------------------------- */

  const bounds = ensureVisible(
    windowState.bounds,
    screen.getAllDisplays().map((d) => d.workArea),
  );
  const win = new BaseWindow({
    title: "TaxWise",
    width: bounds?.width ?? WINDOW.defaultWidth,
    height: bounds?.height ?? WINDOW.defaultHeight,
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: WINDOW.minWidth,
    minHeight: WINDOW.minHeight,
    backgroundColor: background,
    autoHideMenuBar: !isMac,
  });
  if (windowState.maximized) win.maximize();

  const crmView = new WebContentsView({
    webPreferences: secureWebPreferences({
      partition: CRM_PARTITION,
      preload: path.join(dist, "preload", "crm.js"),
      devTools: isDev,
      additionalArguments: [`${ARG.version}${version}`],
      spellcheck: true,
    }),
  });
  crmView.setBackgroundColor(background);
  const headerView = new WebContentsView({
    webPreferences: secureWebPreferences({
      partition: PANEL_PARTITION,
      preload: path.join(dist, "preload", "panel.js"),
      devTools: isDev,
    }),
  });
  headerView.setBackgroundColor("#00000000");
  win.contentView.addChildView(crmView);
  win.contentView.addChildView(headerView);
  registry.add("crm", crmView.webContents.id);
  registry.add("panel", headerView.webContents.id);

  /* ---- context, downloads, panel ---------------------------------- */

  let panel: WhatsAppPanel | null = null;
  let checkedIn = false;

  const context = new ContextService({
    load: () => api.getContext(),
    onResult: (state, diff, error) => onContext(state, diff, error),
  });
  contextRef = context;

  const downloads = new DownloadManager({
    tempDir: path.join(app.getPath("temp"), "taxwise-whatsapp"),
    join: path.join,
    fs,
    randomId: () => randomUUID(),
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    role: () => context.context?.user.role ?? null,
    crmReady: () => panel?.crmReady() ?? false,
    ask: async (fileName, choices, note) => {
      const cancelId = Math.max(0, choices.findIndex((c) => c.id === "cancel"));
      const { response } = await dialog.showMessageBox(win, {
        type: "question",
        title: COPY.downloadTitle,
        message: COPY.downloadTitle,
        detail: note ? `${fileName}\n\n${note}` : fileName,
        buttons: choices.map((c) => c.label),
        defaultId: 0,
        cancelId,
        noLink: true,
      });
      return choices[response]?.id ?? "cancel";
    },
    askSavePath: async (fileName) => {
      const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath("downloads"), fileName) });
      return canceled || !filePath ? null : filePath;
    },
    sendToCrm: (payload) => {
      crmView.webContents.send(PUSH.crmDownload, payload);
      crmView.webContents.focus();
    },
    log,
  });

  const fixtures = e2eFixtureDir(app.isPackaged, process.env);
  const userAgent = chromeUserAgent(process.versions.chrome, process.platform);
  const prepared = new WeakSet<Session>();
  const prepareWhatsAppSession = (ses: Session) => {
    if (prepared.has(ses)) return;
    prepared.add(ses);
    installPermissionHandlers(ses, "whatsapp", policy, appOrigin);
    applyWhatsAppUserAgent(ses, userAgent);
    ses.on("will-download", (_e, item, wc) => downloads.handle(item, () => panel?.openClientFor(wc.id) ?? Promise.resolve(null)));
    if (fixtures) serveWhatsAppFixtures(ses, fixtures);
  };

  const act = (kind: ViewKind, d: NavDecision) => {
    switch (d.action) {
      case "external":
        if (d.url.startsWith("https:")) void shell.openExternal(d.url);
        break;
      case "whatsapp-send":
        if (kind === "crm") panel?.openHandoff(d.url, d.phone);
        break;
      case "show-whatsapp":
        if (kind === "crm") panel?.show();
        break;
      case "navigate-crm":
        if (kind === "crm") void crmView.webContents.loadURL(d.url);
        break;
      case "deny":
        log("navigation refused", { view: kind, reason: d.reason });
        break;
      case "allow":
        break;
    }
  };

  const guardWebContents = (kind: ViewKind, wc: WebContents) => {
    const opts = { appOrigin };
    wc.on("will-navigate", (e) => {
      const d = decideNavigation(kind, e.url, opts);
      if (d.action !== "allow") {
        e.preventDefault();
        act(kind, d);
      }
    });
    wc.on("will-redirect", (e) => {
      if (!e.isMainFrame) return;
      const d = decideNavigation(kind, e.url, opts);
      if (d.action !== "allow") {
        e.preventDefault();
        act(kind, d);
      }
    });
    wc.setWindowOpenHandler(({ url }) => {
      act(kind, decideWindowOpen(kind, url, opts));
      return { action: "deny" };
    });
    wc.on("before-input-event", (e, input) => {
      if (isToggleShortcut(input, isMac)) {
        e.preventDefault();
        panel?.toggle();
      }
    });
    wc.on("context-menu", (_e, params) => {
      const template = contextMenuTemplate(params, { isDev }, {
        replaceMisspelling: (w) => wc.replaceMisspelling(w),
        addToDictionary: (w) => void wc.session.addWordToSpellCheckerDictionary(w),
        inspect: isDev ? () => wc.inspectElement(params.x, params.y) : undefined,
      });
      if (template.length > 0) Menu.buildFromTemplate(template).popup();
    });
    if (!isDev) wc.on("devtools-opened", () => wc.closeDevTools());
  };

  guardWebContents("crm", crmView.webContents);
  guardWebContents("panel", headerView.webContents);

  panel = new WhatsAppPanel({
    win,
    crmView,
    headerView,
    isDev,
    version,
    waPreload: path.join(dist, "preload", "whatsapp.js"),
    userAgent,
    api,
    context,
    device: { state: deviceState, file: deviceFile },
    windowState: { state: windowState, file: windowFile },
    registry,
    log,
    prepareWhatsAppSession,
    guardWebContents,
    backgroundColor: background,
  });

  async function checkin(): Promise<void> {
    const r = await api.checkin(describeDevice(os.hostname(), process.platform, os.release(), version));
    if (r.kind === "ok") {
      checkedIn = true;
      if (deviceState.revoked) {
        deviceState.revoked = false;
        deviceFile.saveNow(deviceState);
      }
    } else if (r.kind === "revoked") {
      context.markRevoked();
    }
  }

  async function wipeAll(): Promise<void> {
    deviceState.revoked = true;
    deviceState.linked = {};
    deviceState.pendingLinkReports = [];
    deviceFile.saveNow(deviceState);
    downloads.discardAll();
    let onDisk: string[] = [];
    try {
      onDisk = fs.readdirSync(path.join(userData, "Partitions"));
    } catch {
      onDisk = [];
    }
    const names = partitionsToWipe(deviceState.partitions, onDisk);
    const wiped = await wipeWhatsAppPartitions(names, (n) => session.fromPartition(n));
    log("device: removed by a Partner; WhatsApp data cleared", { partitions: wiped.length });
  }

  function onContext(state: ContextState, diff: ContextDiff, error: string | null): void {
    if (state.kind === "revoked") void wipeAll();
    if (state.kind === "signed-out") downloads.discardAll();
    panel?.onContext(state, diff, error);
    if (state.kind === "signed-in") {
      if (!checkedIn) void checkin();
      void panel?.flushLinkReports();
    }
    if (error) log("context: refresh failed", { error });
  }

  /* ---- CRM sign-in and sign-out ----------------------------------- */

  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  const refreshSoon = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void context.refresh(), 400);
  };
  const onCrmUrl = (url: string) => {
    if (crmShowsSignedOutPage(url, appOrigin)) {
      if (context.state.kind === "signed-in") context.markSignedOut();
      return;
    }
    if (context.state.kind !== "signed-in" && context.state.kind !== "revoked") refreshSoon();
  };
  crmView.webContents.on("did-navigate", (_e, url) => onCrmUrl(url));
  crmView.webContents.on("did-navigate-in-page", (_e, url, isMainFrame) => {
    if (isMainFrame) onCrmUrl(url);
  });
  crmSession.cookies.on("changed", (_e, cookie, _cause, removed) => {
    if (!isAuthCookie(cookie.name)) return;
    const domain = (cookie.domain ?? "").replace(/^\./, "");
    if (domain && domain !== appUrl.hostname && !appUrl.hostname.endsWith(`.${domain}`)) return;
    if (removed && context.state.kind === "signed-in") context.markSignedOut();
    refreshSoon();
  });

  /* ---- IPC -------------------------------------------------------- */

  const rules: SenderRules = { appOrigin, isKnownWebContents: (kind, id) => registry.isKnown(kind, id) };
  const p = panel;

  registerInvoke(ipcMain, "crm:open-client-chat", rules, log, ({ clientId }) => p.openClientChat(clientId));
  registerInvoke(ipcMain, "crm:toggle-whatsapp", rules, log, () => p.toggle());
  registerInvoke(ipcMain, "crm:refresh-context", rules, log, async () => {
    await context.refresh();
  });
  registerInvoke(ipcMain, "panel:ready", rules, log, () => p.viewState());
  registerInvoke(ipcMain, "wa:hello", rules, log, (_x, e) => p.configFor(e.sender.id));

  registerSend(ipcMain, "crm:download-complete", rules, log, ({ id }) => downloads.complete(id));
  registerSend(ipcMain, "crm:download-listeners", rules, log, ({ count }) => p.setCrmListeners(count));
  registerSend(ipcMain, "panel:switch-number", rules, log, ({ numberId }) => p.switchNumber(numberId));
  registerSend(ipcMain, "panel:link-number", rules, log, ({ numberId }) => p.linkNumber(numberId));
  registerSend(ipcMain, "panel:pop-out", rules, log, () => p.popOut());
  registerSend(ipcMain, "panel:dock", rules, log, () => p.dock());
  registerSend(ipcMain, "panel:close", rules, log, () => p.hide());
  registerSend(ipcMain, "panel:retry", rules, log, () => void context.refresh());
  registerSend(ipcMain, "panel:dismiss-notice", rules, log, () => p.clearNotice(true));
  registerSend(ipcMain, "panel:drag", rules, log, ({ phase, screenX }) => p.drag(phase, screenX));
  registerSend(ipcMain, "panel:set-width", rules, log, ({ width }) => p.setWidth(width));
  registerSend(ipcMain, "wa:page-state", rules, log, ({ state, userAgent: ua }, e) => p.onPageState(e.sender.id, state, ua));
  registerSend(ipcMain, "wa:open-title", rules, log, ({ title, decision }, e) => p.onOpenTitle(e.sender.id, title, decision));
  registerSend(ipcMain, "wa:adopt-chat", rules, log, ({ title }, e) => p.onAdopt(e.sender.id, title));
  registerSend(ipcMain, "wa:access-denied", rules, log, ({ title }, e) => p.onAccessDenied(e.sender.id, title));
  registerSend(ipcMain, "wa:selectors", rules, log, ({ ok, failing }, e) => p.onSelectors(e.sender.id, ok, failing));
  registerSend(ipcMain, "wa:reset", rules, log, (_x, e) => p.onReset(e.sender.id));
  registerSend(ipcMain, "wa:open-chat-result", rules, log, ({ requestId, ok, reason }) => p.onOpenChatResult(requestId, ok, reason));
  registerSend(ipcMain, "wa:title-result", rules, log, ({ requestId, title }) => p.onTitleResult(requestId, title));

  /* ---- menu, updates, window state -------------------------------- */

  const updater = startUpdater({ updater: autoUpdater, isPackaged: app.isPackaged, log });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      applicationMenuTemplate(
        { isMac, isDev, appName: "TaxWise Desktop" },
        {
          toggleWhatsApp: () => p.toggle(),
          reloadCrm: () => crmView.webContents.reload(),
          checkForUpdates: () => void updater.checkNow(),
          showAbout: () =>
            void dialog.showMessageBox(win, {
              type: "info",
              title: "About TaxWise Desktop",
              message: "TaxWise Desktop",
              detail: `Version ${version}\nTaxWise Consultants · www.twchartered.com\nPowered by J-TACS`,
            }),
        },
      ),
    ),
  );

  const saveBounds = () => {
    if (win.isDestroyed()) return;
    windowState.maximized = win.isMaximized();
    if (!windowState.maximized && !win.isMinimized()) windowState.bounds = win.getBounds();
    windowFile.save(windowState);
  };
  win.on("resize", saveBounds);
  win.on("move", saveBounds);
  win.on("close", () => {
    saveBounds();
    windowFile.flush();
    context.stop();
    updater.stop();
    p.closeAll();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("second-instance", () => {
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  /* ---- go --------------------------------------------------------- */

  downloads.purgeStale();
  if (deviceState.revoked) void wipeAll();
  void headerView.webContents.loadURL(PANEL_URL);
  void crmView.webContents.loadURL(appUrl.href);
  p.refresh();
  context.start();
  void context.refresh();
  void checkin();
}
