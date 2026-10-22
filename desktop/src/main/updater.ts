/**
 * Auto-update with electron-updater (§7.25.3): check at start and every 6 hours. The feed comes
 * from electron-builder's publish config (GitHub Releases or a static URL), baked into
 * app-update.yml at build time. Updates are signed; electron-updater refuses an update whose
 * signature doesn't match the installed app's publisher.
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
  log(message: string, details?: Record<string, unknown>): void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

/** Starts checking; returns a stop function and a manual check. Development builds never check. */
export function startUpdater(opts: UpdaterOptions): { stop(): void; checkNow(): Promise<void> } {
  if (!opts.isPackaged) {
    return { stop: () => undefined, checkNow: async () => opts.log("updater: development build, not checking") };
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
