import { describe, expect, it } from "vitest";
import { FuseV1Options } from "@electron/fuses";
import { electronBinaryPath, FUSES } from "../scripts/fuses";
import { resolveAppUrl } from "../src/main/app-url";
import { contentTypeFor, resolveBundledAsset } from "../src/main/assets";
import { createLogger, scrub } from "../src/main/log";
import { OncePerDay } from "../src/main/once-a-day";
import { partitionsToWipe, waPartition, waPartitionsFromDirNames, wipeWhatsAppPartitions } from "../src/main/partitions";
import { ClientModeReporter } from "../src/main/reporters";
import { ViewRegistry } from "../src/main/registry";
import { startUpdater } from "../src/main/updater";
import { applyWhatsAppUserAgent, chromeMajor, chromeUserAgent, clearCacheAndReload, looksLikeElectron, userAgentMatches } from "../src/main/user-agent";
import { secureWebPreferences } from "../src/main/web-preferences";
import { istDay } from "../src/shared/chat-rules";
import { UPDATE_CHECK_MS } from "../src/shared/config";

describe("user agent (§7.25.3)", () => {
  it("is the bundled Chromium's Chrome string", () => {
    expect(chromeUserAgent("138.0.7204.35", "win32")).toBe(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
    );
    expect(chromeUserAgent("140.0.1.2", "darwin")).toContain("Macintosh; Intel Mac OS X 10_15_7");
    expect(looksLikeElectron(chromeUserAgent("140.0.1.2", "linux"))).toBe(false);
    expect(chromeMajor("141.0.7390.7")).toBe("141");
    expect(() => chromeMajor(undefined)).toThrow();
  });

  it("is set on the session and forced onto every WhatsApp request header", () => {
    let ua = "";
    let listener: ((d: { requestHeaders: Record<string, string> }, cb: (r: { requestHeaders: Record<string, string> }) => void) => void) | null = null;
    let filter: unknown = null;
    applyWhatsAppUserAgent(
      {
        setUserAgent: (u: string) => void (ua = u),
        webRequest: { onBeforeSendHeaders: (f: unknown, l: typeof listener) => ((filter = f), (listener = l)) },
      } as never,
      "UA/1",
    );
    expect(ua).toBe("UA/1");
    expect(filter).toEqual({ urls: ["https://*.whatsapp.com/*", "https://*.whatsapp.net/*"] });
    let out: Record<string, string> = {};
    listener!({ requestHeaders: { "User-Agent": "Electron/45", Accept: "*/*" } }, (r) => (out = r.requestHeaders));
    expect(out).toEqual({ "User-Agent": "UA/1", Accept: "*/*" });
    expect(userAgentMatches("UA/1", "UA/1")).toBe(true);
    expect(userAgentMatches(null, "UA/1")).toBe(false);
  });

  it("clears the cache and reloads once if WhatsApp still refuses the browser", async () => {
    const calls: string[] = [];
    const ses = { clearCache: async () => void calls.push("clear") };
    const wc = { reloadIgnoringCache: () => void calls.push("reload") };
    expect(await clearCacheAndReload(ses, wc, false)).toBe(true);
    expect(await clearCacheAndReload(ses, wc, true)).toBe(false);
    expect(calls).toEqual(["clear", "reload"]);
  });
});

describe("every view's preferences follow the security checklist (§7.25.3, §12)", () => {
  it("isolated, sandboxed, no Node, web security on, nothing insecure or experimental", () => {
    for (const devTools of [false, true]) {
      const p = secureWebPreferences({ partition: "persist:crm", preload: "/app/preload/crm.js", devTools });
      expect(p).toMatchObject({
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        webviewTag: false,
        devTools,
      });
    }
  });
});

describe("partitions", () => {
  it("one per number, never a strange name", () => {
    expect(waPartition("3f1c2b9e-0000-4000-8000-000000000001")).toBe("persist:wa-3f1c2b9e-0000-4000-8000-000000000001");
    expect(() => waPartition("../crm")).toThrow();
    expect(() => waPartition("")).toThrow();
  });

  it("a removed PC wipes every WhatsApp partition, recorded or found on disk, and nothing else", async () => {
    expect(waPartitionsFromDirNames(["crm", "wa-n1", "wa-n2", "taxwise-panel", "wa-../x"])).toEqual(["persist:wa-n1", "persist:wa-n2"]);
    const names = partitionsToWipe(["persist:wa-n1", "persist:crm"], ["wa-n1", "wa-n3"]);
    expect(names).toEqual(["persist:wa-n1", "persist:wa-n3"]);
    const cleared: string[] = [];
    const wiped = await wipeWhatsAppPartitions([...names, "persist:crm"], (n) => ({
      clearStorageData: async () => void cleared.push(`${n}:storage`),
      clearCache: async () => void cleared.push(`${n}:cache`),
      clearAuthCache: async () => void cleared.push(`${n}:auth`),
    }));
    expect(wiped).toEqual(["persist:wa-n1", "persist:wa-n3"]);
    expect(cleared.filter((c) => c.startsWith("persist:crm"))).toEqual([]);
    expect(cleared).toContain("persist:wa-n3:storage");
  });
});

describe("the panel header is served from the bundle only", () => {
  it("resolves taxwise://panel files and nothing else", () => {
    expect(resolveBundledAsset("taxwise://panel/panel-header.html")).toBe("panel-header.html");
    expect(resolveBundledAsset("taxwise://panel/fonts/inter-latin-wght-normal.woff2")).toBe("fonts/inter-latin-wght-normal.woff2");
    // Dot segments are resolved by the URL parser itself, so they can't climb out of the folder.
    for (const climbing of ["taxwise://panel/../main/main.js", "taxwise://panel/%2e%2e/main/main.js", "taxwise://panel/a/../../../x.js"]) {
      const rel = resolveBundledAsset(climbing);
      expect(rel === null || !rel.split("/").includes(".."), climbing).toBe(true);
    }
    for (const bad of [
      "taxwise://panel/..%2fmain.js",
      "taxwise://panel/%5c..%5cmain.js",
      "taxwise://other/panel-header.html",
      "taxwise://panel/.env",
      "taxwise://panel/",
      "taxwise://panel/x.exe",
      "https://panel/panel-header.html",
      "file:///panel-header.html",
    ]) {
      expect(resolveBundledAsset(bad), bad).toBeNull();
    }
    expect(contentTypeFor("a.js")).toBe("text/javascript; charset=utf-8");
  });
});

describe("TAXWISE_APP_URL (§17)", () => {
  it("a packaged app uses only the baked https URL", () => {
    expect(resolveAppUrl("https://app.twchartered.com", "http://localhost:3000", true)).toMatchObject({ ok: true });
    expect((resolveAppUrl("https://app.twchartered.com", "http://localhost:3000", true) as { url: URL }).url.origin).toBe("https://app.twchartered.com");
    expect(resolveAppUrl("http://app.twchartered.com", undefined, true).ok).toBe(false);
    expect(resolveAppUrl("", undefined, true).ok).toBe(false);
    expect(resolveAppUrl("https://u:p@app.twchartered.com", undefined, true).ok).toBe(false);
  });
  it("development may use a local CRM", () => {
    expect(resolveAppUrl("", "http://localhost:3000", false).ok).toBe(true);
    expect(resolveAppUrl("", "http://127.0.0.1:3000", false).ok).toBe(true);
    expect(resolveAppUrl("", "http://192.168.1.10:3000", false).ok).toBe(false);
  });
});

describe("fuses (§7.25.3)", () => {
  it("are exactly as the spec says, plus NODE_OPTIONS ignored and no file:// privileges", () => {
    expect(FUSES[FuseV1Options.RunAsNode]).toBe(false);
    expect(FUSES[FuseV1Options.EnableNodeCliInspectArguments]).toBe(false);
    expect(FUSES[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]).toBe(true);
    expect(FUSES[FuseV1Options.OnlyLoadAppFromAsar]).toBe(true);
    expect(FUSES[FuseV1Options.EnableCookieEncryption]).toBe(true);
    expect(FUSES[FuseV1Options.EnableNodeOptionsEnvironmentVariable]).toBe(false);
    expect(FUSES[FuseV1Options.GrantFileProtocolExtraPrivileges]).toBe(false);
  });
  it("find the binary electron-builder produced", () => {
    expect(electronBinaryPath("win32", "/out/win-unpacked", "TaxWise Desktop", "taxwise-desktop")).toMatch(/win-unpacked[\\/]TaxWise Desktop\.exe$/);
    expect(electronBinaryPath("darwin", "/out/mac", "TaxWise Desktop", "taxwise-desktop")).toMatch(/mac[\\/]TaxWise Desktop\.app$/);
    expect(electronBinaryPath("linux", "/out/linux", "TaxWise Desktop", "taxwise-desktop")).toMatch(/linux[\\/]taxwise-desktop$/);
  });
});

describe("updates (§7.25.3: at start and every 6 hours)", () => {
  it("checks at start and on a 6-hour timer, only when packaged", async () => {
    let checks = 0;
    let interval = 0;
    const updater = { autoDownload: false, autoInstallOnAppQuit: false, checkForUpdatesAndNotify: async () => void checks++, on: () => undefined };
    const u = startUpdater({ updater, isPackaged: true, log: () => undefined, setInterval: (_fn, ms) => ((interval = ms), 1), clearInterval: () => undefined });
    await Promise.resolve();
    expect(checks).toBe(1);
    expect(interval).toBe(UPDATE_CHECK_MS);
    expect(UPDATE_CHECK_MS).toBe(6 * 60 * 60 * 1000);
    expect(updater.autoDownload).toBe(true);
    u.stop();
    let devChecks = 0;
    startUpdater({ updater: { ...updater, checkForUpdatesAndNotify: async () => void devChecks++ }, isPackaged: false, log: () => undefined });
    expect(devChecks).toBe(0);
  });
});

describe("once a day (IST)", () => {
  it("counts days in Indian Standard Time", () => {
    expect(istDay(Date.UTC(2026, 9, 22, 18, 29))).toBe("2026-10-22");
    expect(istDay(Date.UTC(2026, 9, 22, 18, 31))).toBe("2026-10-23");
    const o = new OncePerDay();
    const t = Date.UTC(2026, 9, 22, 6);
    expect(o.shouldRun("chat-a", t)).toBe(true);
    expect(o.shouldRun("chat-a", t + 1000)).toBe(false);
    expect(o.shouldRun("chat-b", t)).toBe(true);
    expect(o.shouldRun("chat-a", t + 24 * 3600 * 1000)).toBe(true);
    o.forget("chat-b");
    expect(o.shouldRun("chat-b", t + 24 * 3600 * 1000)).toBe(true);
  });

  it("access_denied is logged once per chat per day, retried if it didn't go through", async () => {
    const sent: string[] = [];
    let fail = true;
    const r = new ClientModeReporter({
      accessDenied: async (_n, title) => {
        sent.push(title);
        return fail ? { kind: "error", message: "offline", ref: null } : { kind: "ok", data: {} };
      },
      health: async () => ({ kind: "ok", data: {} }),
    });
    const t = Date.UTC(2026, 9, 22, 6);
    await r.accessDenied("n-staff", "Patel Builders", t);
    fail = false;
    await r.accessDenied("n-staff", "Patel Builders", t + 1);
    await r.accessDenied("n-staff", " Patel  Builders ", t + 2);
    expect(sent).toEqual(["Patel Builders", "Patel Builders"]);
  });
});

describe("registry and log", () => {
  it("remembers which view is which, and a WhatsApp view's number", () => {
    const r = new ViewRegistry();
    r.add("whatsapp", 7, "n-staff");
    expect(r.isKnown("whatsapp", 7)).toBe(true);
    expect(r.isKnown("crm", 7)).toBe(false);
    expect(r.numberOf(7)).toBe("n-staff");
    r.remove(7);
    expect(r.kindOf(7)).toBeNull();
  });

  it("never writes a device key, invite code or token", () => {
    expect(scrub(`key ${"ab".repeat(32)} url accept?code=AbCdEfGhIjKlMnOpQrStUv`)).toBe("key [redacted] url accept?[redacted]");
    const lines: string[] = [];
    const log = createLogger("/l", { appendFileSync: (_p, d) => void lines.push(d), statSync: () => ({ size: 0 }), renameSync: () => undefined }, false);
    log("x", { deviceKey: "cd".repeat(32) });
    expect(lines[0]).not.toContain("cd".repeat(32));
  });
});
