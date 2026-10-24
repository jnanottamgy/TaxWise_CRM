/**
 * Starts TaxWise Desktop for an end-to-end test, with the Chromium sandbox on, as in production.
 *
 * Playwright adds --no-sandbox on Linux unless told otherwise (`chromiumSandbox: true` here). That
 * would run every renderer without the OS sandbox, which a release build refuses (hardening.ts).
 *
 * Chromium can't sandbox a process running as root, and the app asks for the sandbox on every renderer
 * (`app.enableSandbox()`, §7.25.3): as root (a container, or a CI job running as root) every renderer
 * aborts with "Running as root without --no-sandbox is not supported", even with --no-sandbox, and no
 * page ever loads. So, as root on Linux, the suite starts Electron as an unprivileged user instead:
 * `TAXWISE_E2E_UID` / `TAXWISE_E2E_GID`, else the user who ran sudo, else `nobody`. That user gets its
 * own HOME and a copy of xvfb-run's X authority file (which only root can read). The run directory
 * stays root's, so that user can't swap the wrapper script root starts; only its user-data and home
 * folders are handed over.
 */

import { chmodSync, chownSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { _electron as electron, type ElectronApplication } from "@playwright/test";

const NOBODY = 65534;

export interface RunDir {
  /** The app's user data folder (TAXWISE_USER_DATA_DIR). */
  userData: string;
  launch(options: { appDir: string; env: Record<string, string> }): Promise<ElectronApplication>;
  remove(): void;
}

interface Account {
  uid: number;
  gid: number;
}

function idFrom(...values: Array<string | undefined>): number | null {
  for (const v of values) {
    if (v && /^\d+$/.test(v.trim())) return Number(v.trim());
  }
  return null;
}

/** The account to run Electron as, or null to run it as the current user. */
export function unprivilegedAccount(env: NodeJS.ProcessEnv, platform = process.platform, uid = process.getuid?.()): Account | null {
  if (platform !== "linux" || uid !== 0) return null;
  const runUid = idFrom(env.TAXWISE_E2E_UID, env.SUDO_UID) ?? NOBODY;
  const runGid = idFrom(env.TAXWISE_E2E_GID, env.SUDO_GID) ?? NOBODY;
  if (runUid === 0) throw new Error("TAXWISE_E2E_UID must not be 0: Chromium can't sandbox root.");
  return { uid: runUid, gid: runGid };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Playwright's Electron loader, which it adds itself unless it is given an executablePath. */
function playwrightElectronLoader(): string {
  const loader = join(dirname(require.resolve("playwright-core/package.json")), "lib/server/electron/loader.js");
  if (!existsSync(loader)) throw new Error(`Playwright's Electron loader isn't at ${loader}; update e2e/electron-launch.ts for this Playwright version.`);
  return loader;
}

function setprivPath(): string {
  for (const p of ["/usr/bin/setpriv", "/bin/setpriv"]) if (existsSync(p)) return p;
  throw new Error("Running the end-to-end tests as root needs setpriv (util-linux), or run them as an ordinary user.");
}

export function createRunDir(env: NodeJS.ProcessEnv = process.env): RunDir {
  const account = unprivilegedAccount(env);
  // /tmp rather than os.tmpdir(): an unprivileged user must be able to reach it.
  const base = mkdtempSync(join(account ? "/tmp" : tmpdir(), "taxwise-e2e-"));
  const userData = join(base, "user-data");
  const home = join(base, "home");
  mkdirSync(userData);
  mkdirSync(home);
  if (account) chmodSync(base, 0o755);

  return {
    userData,
    // Retries: after a forced kill, the app's processes may still be writing their last files.
    remove: () => rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
    launch: async ({ appDir, env: appEnv }) => {
      if (!account) return electron.launch({ args: [appDir], cwd: appDir, env: appEnv, chromiumSandbox: true });

      const extraEnv: Record<string, string> = { HOME: home };
      if (appEnv.XAUTHORITY && existsSync(appEnv.XAUTHORITY)) {
        const xauth = join(home, ".Xauthority");
        copyFileSync(appEnv.XAUTHORITY, xauth);
        chmodSync(xauth, 0o600);
        extraEnv.XAUTHORITY = xauth;
      }
      // It may name a file only root can read (Electron then complains at every start); the tests talk
      // only to the local mock CRM.
      const { NODE_EXTRA_CA_CERTS: _rootOnly, ...rest } = appEnv;

      const binary = require("electron") as unknown as string;
      const wrapper = join(base, "electron-unprivileged");
      writeFileSync(
        wrapper,
        `#!/bin/sh\nexec ${shellQuote(setprivPath())} --reuid=${account.uid} --regid=${account.gid} --clear-groups -- ` +
          `${shellQuote(binary)} -r ${shellQuote(playwrightElectronLoader())} "$@"\n`,
        { mode: 0o755 },
      );
      for (const p of [userData, home, ...(extraEnv.XAUTHORITY ? [extraEnv.XAUTHORITY] : [])]) chownSync(p, account.uid, account.gid);

      return electron.launch({ executablePath: wrapper, args: [appDir], cwd: appDir, env: { ...rest, ...extraEnv }, chromiumSandbox: true });
    },
  };
}
