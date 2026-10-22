/**
 * Auto-update with electron-updater (§7.25.3): check at start and every 6 hours. The feed comes
 * from electron-builder's publish config (GitHub Releases or a static URL), baked into
 * app-update.yml at build time.
 *
 * Updates must be signed (§12 "Signed installers and updates"), and the app only auto-updates
 * when the update's signature is actually checked:
 * - Windows: electron-updater compares the downloaded installer's Authenticode signature with
 *   app-update.yml's `publisherName`, but skips the check without a word when `publisherName` is
 *   missing, which is exactly what an unsigned build writes. So an install whose app-update.yml
 *   names no publisher never auto-updates (updateTrustProblem); otherwise anyone who could write
 *   to the update host could push any installer to every PC. `npm run release` also sets
 *   forceCodeSigning, so an unsigned release can't be published.
 * - macOS: Squirrel.Mac refuses an update not signed with the same Developer ID as the app.
 * - Anything else (Linux): no signature check exists, so no auto-update.
 */

import { UPDATE_CHECK_MS } from "../shared/config";

export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdatesAndNotify(): Promise<unknown>;
  on(event: "error", listener: (err: Error) => void): unknown;
}

export interface UpdaterOptions {
  updater: UpdaterLike;
  isPackaged: boolean;
  /** From updateTrustProblem(): why updates can't be trusted on this install, or null. */
  trustProblem?: string | null;
  log(message: string, details?: Record<string, unknown>): void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

/** The publisher names in an app-update.yml (`publisherName: X` or a YAML list), in order. */
export function publisherNames(appUpdateYml: string): string[] {
  const lines = appUpdateYml.split(/\r?\n/);
  const i = lines.findIndex((l) => /^publisherName\s*:/.test(l));
  if (i < 0) return [];
  const unquote = (v: string) => v.trim().replace(/^(['"])(.*)\1$/, "$2").trim();
  const inline = unquote(lines[i]!.replace(/^publisherName\s*:/, ""));
  if (inline && inline !== "null" && inline !== "~" && inline !== "[]") {
    if (inline.startsWith("[") && inline.endsWith("]")) {
      return inline.slice(1, -1).split(",").map(unquote).filter(Boolean);
    }
    return [inline];
  }
  const names: string[] = [];
  for (const line of lines.slice(i + 1)) {
    const m = /^\s+-\s*(.*)$/.exec(line);
    if (!m) break;
    const v = unquote(m[1]!);
    if (v) names.push(v);
  }
  return names;
}

/** Why this install must not auto-update, or null if the update's signature is checked. */
export function updateTrustProblem(platform: string, appUpdateYml: string | null): string | null {
  if (platform === "darwin") return null;
  if (platform !== "win32") return "updates aren't signature-checked on this platform";
  if (appUpdateYml === null) return "this build has no app-update.yml";
  if (publisherNames(appUpdateYml).length === 0) return "this build isn't code-signed, so updates couldn't be signature-checked";
  return null;
}

/** Starts checking; returns a stop function and a manual check. Development builds never check. */
export function startUpdater(opts: UpdaterOptions): { stop(): void; checkNow(): Promise<void> } {
  if (!opts.isPackaged) {
    return { stop: () => undefined, checkNow: async () => opts.log("updater: development build, not checking") };
  }
  if (opts.trustProblem) {
    const problem = opts.trustProblem;
    opts.log("updater: off", { reason: problem });
    return { stop: () => undefined, checkNow: async () => opts.log("updater: off", { reason: problem }) };
  }
  const u = opts.updater;
  u.autoDownload = true;
  u.autoInstallOnAppQuit = true;
  u.on("error", (err) => opts.log("updater: error", { err: err.message }));
  const checkNow = async () => {
    try {
      await u.checkForUpdatesAndNotify();
    } catch (err) {
      opts.log("updater: check failed", { err: String(err) });
    }
  };
  void checkNow();
  const set = opts.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clear = opts.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  const handle = set(() => void checkNow(), UPDATE_CHECK_MS);
  return { stop: () => clear(handle), checkNow };
}
