/**
 * This PC's device key (§5.13 desktop_devices.device_key, §7.25.7): 32 random bytes, generated on
 * the first run after install and kept encrypted with Electron's safeStorage, which uses the
 * operating system's credential store (Windows DPAPI, macOS Keychain, the Linux secret service).
 * Only a development run may fall back to a plain file where there is no credential store.
 */

import { randomBytes as nodeRandomBytes } from "node:crypto";

export const DEVICE_KEY_PATTERN = /^[0-9a-f]{64}$/;

export function generateDeviceKey(randomBytes: (n: number) => Uint8Array = nodeRandomBytes): string {
  const bytes = randomBytes(32);
  if (bytes.length !== 32) throw new Error("expected 32 random bytes");
  return Buffer.from(bytes).toString("hex");
}

export function isValidDeviceKey(key: unknown): key is string {
  return typeof key === "string" && DEVICE_KEY_PATTERN.test(key);
}

export interface SecretStore {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface KeyFileIO {
  read(): Buffer | null;
  write(data: Buffer): void;
}

interface StoredKey {
  v: 1;
  /** "safeStorage": encrypted by the OS credential store. "plain": development runs without a store only. */
  enc: "safeStorage" | "plain";
  data: string;
}

export interface LoadedKey {
  key: string;
  created: boolean;
  encrypted: boolean;
}

/** The OS credential store can't be used right now (locked, denied, or none on this system). */
export class DeviceKeyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceKeyUnavailableError";
  }
}

/**
 * Whether safeStorage really is the operating system's credential store (§5.13). On Linux,
 * Electron falls back to a hard-coded password ("basic_text") when there is no keyring; that
 * reports as available but protects nothing.
 */
export function osCredentialStoreAvailable(platform: string, encryptionAvailable: boolean, linuxBackend: string | null): boolean {
  if (!encryptionAvailable) return false;
  if (platform === "linux") return linuxBackend !== null && linuxBackend !== "basic_text" && linuxBackend !== "unknown";
  return true;
}

function parseStored(file: Buffer): StoredKey | null {
  try {
    const stored = JSON.parse(file.toString("utf8")) as StoredKey;
    if (stored?.v !== 1 || typeof stored.data !== "string" || (stored.enc !== "safeStorage" && stored.enc !== "plain")) return null;
    return stored;
  } catch {
    return null;
  }
}

function encryptedFile(store: SecretStore, key: string): Buffer {
  const stored: StoredKey = { v: 1, enc: "safeStorage", data: store.encryptString(key).toString("base64") };
  return Buffer.from(JSON.stringify(stored), "utf8");
}

export interface DeviceKeyOptions {
  /**
   * Development runs only: keep the key in a plain file where the OS has no credential store.
   * A locked-down run (hardening.ts) refuses instead, as §5.13 requires the credential store.
   */
  allowPlain?: boolean;
  randomBytes?: (n: number) => Uint8Array;
}

const UNAVAILABLE =
  "TaxWise Desktop can't open this PC's credential store (the Windows user profile's protected storage or the macOS Keychain), where it keeps this PC's key. Unlock it or allow TaxWise Desktop to use it, then start TaxWise Desktop again.";

/**
 * Reads the key, or creates and saves a new one.
 * - A key encrypted by the credential store is never replaced while the store is unavailable
 *   (a locked keychain): that would turn this PC into a new, unknown PC, and on a run that
 *   allows plain files it would also write the new key in clear. It throws instead.
 * - A key the store can't decrypt although it is available (a profile copied from another PC
 *   or user, a reset store) is replaced: the CRM then sees a new PC, which a Partner can name.
 * - A plain key from an earlier run is encrypted as soon as the store is available.
 */
export function loadOrCreateDeviceKey(store: SecretStore, io: KeyFileIO, options: DeviceKeyOptions = {}): LoadedKey {
  const allowPlain = options.allowPlain === true;
  const available = store.isEncryptionAvailable();
  const existing = io.read();
  const stored = existing ? parseStored(existing) : null;

  if (stored?.enc === "safeStorage") {
    if (!available) throw new DeviceKeyUnavailableError(UNAVAILABLE);
    let key: string | null = null;
    try {
      key = store.decryptString(Buffer.from(stored.data, "base64"));
    } catch {
      key = null;
    }
    if (isValidDeviceKey(key)) return { key, created: false, encrypted: true };
  } else if (stored?.enc === "plain" && isValidDeviceKey(stored.data)) {
    if (available) {
      io.write(encryptedFile(store, stored.data));
      return { key: stored.data, created: false, encrypted: true };
    }
    if (allowPlain) return { key: stored.data, created: false, encrypted: false };
    throw new DeviceKeyUnavailableError(UNAVAILABLE);
  }

  const key = generateDeviceKey(options.randomBytes);
  if (available) {
    io.write(encryptedFile(store, key));
    return { key, created: true, encrypted: true };
  }
  if (!allowPlain) throw new DeviceKeyUnavailableError(UNAVAILABLE);
  const plain: StoredKey = { v: 1, enc: "plain", data: key };
  io.write(Buffer.from(JSON.stringify(plain), "utf8"));
  return { key, created: true, encrypted: false };
}

/** What /api/desktop/devices/checkin receives about this PC. */
export function describeDevice(hostname: string, platform: string, release: string, appVersion: string) {
  const osName = platform === "win32" ? "Windows" : platform === "darwin" ? "macOS" : platform === "linux" ? "Linux" : platform;
  return {
    deviceName: (hostname.trim() || "Unnamed PC").slice(0, 100),
    os: `${osName} ${release}`.trim().slice(0, 100),
    appVersion,
  };
}
