/**
 * This PC's device key (§5.13 desktop_devices.device_key, §7.25.7): 32 random bytes, generated on
 * the first run after install and kept encrypted with Electron's safeStorage, which uses the
 * operating system's credential store (Windows DPAPI, macOS Keychain, the Linux secret service).
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
  /** "safeStorage": encrypted by the OS credential store. "plain": only where the OS offers no store. */
  enc: "safeStorage" | "plain";
  data: string;
}

export interface LoadedKey {
  key: string;
  created: boolean;
  encrypted: boolean;
}

function decode(file: Buffer, store: SecretStore): string | null {
  let stored: StoredKey;
  try {
    stored = JSON.parse(file.toString("utf8")) as StoredKey;
  } catch {
    return null;
  }
  if (stored?.v !== 1 || typeof stored.data !== "string") return null;
  try {
    const key =
      stored.enc === "safeStorage"
        ? store.isEncryptionAvailable()
          ? store.decryptString(Buffer.from(stored.data, "base64"))
          : null
        : stored.enc === "plain"
          ? stored.data
          : null;
    return isValidDeviceKey(key) ? key : null;
  } catch {
    return null;
  }
}

/**
 * Reads the key, or creates and saves a new one. A key that can't be read back (a moved profile,
 * a reset credential store) is replaced: the CRM then sees a new PC, which a Partner can name.
 */
export function loadOrCreateDeviceKey(store: SecretStore, io: KeyFileIO, randomBytes?: (n: number) => Uint8Array): LoadedKey {
  const existing = io.read();
  if (existing) {
    const key = decode(existing, store);
    if (key) return { key, created: false, encrypted: JSON.parse(existing.toString("utf8")).enc === "safeStorage" };
  }
  const key = generateDeviceKey(randomBytes);
  const encrypted = store.isEncryptionAvailable();
  const stored: StoredKey = encrypted
    ? { v: 1, enc: "safeStorage", data: store.encryptString(key).toString("base64") }
    : { v: 1, enc: "plain", data: key };
  io.write(Buffer.from(JSON.stringify(stored), "utf8"));
  return { key, created: true, encrypted };
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
