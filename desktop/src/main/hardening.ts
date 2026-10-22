/**
 * Whether this run is locked down (§7.25.3 security: no DevTools in production builds), and which
 * command-line switches a locked-down run refuses. Pure, so both are unit-tested.
 *
 * A run is locked down when the bundle was built with `--release` (baked in by scripts/build.mjs)
 * or when Electron reports the app as packaged. `app.isPackaged` alone is not enough: Electron
 * decides it from the executable's file name, so a copy of the installed app renamed to
 * electron.exe would report "not packaged" and get development behaviour (DevTools, the Inspect
 * menu, TAXWISE_APP_URL from the environment, local WhatsApp fixtures).
 */

export interface BuildMode {
  /** Production rules: no DevTools, no environment overrides, no debugging switches. */
  lockedDown: boolean;
  devTools: boolean;
  /** TAXWISE_APP_URL, TAXWISE_USER_DATA_DIR and the e2e fixtures may come from the environment. */
  envOverrides: boolean;
}

export function buildMode(releaseBuild: boolean, isPackaged: boolean): BuildMode {
  const lockedDown = releaseBuild || isPackaged;
  return { lockedDown, devTools: !lockedDown, envOverrides: !lockedDown };
}

/**
 * Chromium and Node switches that would let whoever starts the app script its pages (DevTools
 * over a port or pipe, the Node inspector) or switch off its protections. The fuses already block
 * the Node ones (EnableNodeCliInspectArguments off); remote debugging is Chromium's and has no fuse.
 * On a shared office PC this matters: an Employee could start the app with
 * --remote-debugging-port and read every chat that client mode hides.
 */
export const FORBIDDEN_SWITCHES: readonly string[] = [
  "remote-debugging-port",
  "remote-debugging-pipe",
  "remote-debugging-address",
  "remote-debugging-io-pipes",
  "remote-allow-origins",
  "auto-open-devtools-for-tabs",
  "inspect",
  "inspect-brk",
  "inspect-port",
  "inspect-publish-uid",
  "debug",
  "debug-brk",
  "js-flags",
  "disable-web-security",
  "ignore-certificate-errors",
  "ignore-certificate-errors-spki-list",
  "allow-insecure-localhost",
  "host-rules",
  "host-resolver-rules",
];

/**
 * The forbidden switches present in argv. Chromium accepts `--name`, `-name` and, on Windows,
 * `/name`, with or without `=value`, and compares names case-insensitively on Windows; this
 * matches all of those everywhere (refusing too much is safe, refusing too little is not).
 */
export function forbiddenSwitches(argv: readonly string[]): string[] {
  const found = new Set<string>();
  for (const arg of argv) {
    const m = /^(?:--|-|\/)([A-Za-z0-9][A-Za-z0-9-]*)(?:=|$)/.exec(arg.trim());
    if (!m) continue;
    const name = m[1]!.toLowerCase();
    if (FORBIDDEN_SWITCHES.includes(name)) found.add(name);
  }
  return [...found].sort();
}
