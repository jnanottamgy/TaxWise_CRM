import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * The credential vault (§12): portal passwords and other stored secrets, encrypted at rest.
 *
 * - AES-256-GCM, a fresh random 12-byte IV per secret, the 16-byte auth tag kept with it.
 * - Key from `CREDENTIAL_VAULT_KEY` (64 hex characters = 32 bytes). Keep an offline copy: losing it
 *   makes every stored password unreadable.
 * - Stored form: `<version>:<base64 iv>.<base64 tag>.<base64 ciphertext>`, e.g. `v1:…`. The version
 *   names the key that sealed it, so the key can be rotated without losing data:
 *     1. set the new key as CREDENTIAL_VAULT_KEY with CREDENTIAL_VAULT_KEY_VERSION=v2, and move the old
 *        one to CREDENTIAL_VAULT_PREVIOUS_KEYS=v1:<64 hex>;
 *     2. run the re-encryption job (`reencryptSecret` on every stored value);
 *     3. remove the old key once nothing reports `needsReencryption`.
 * - An optional `context` (for example the credential row's id) is bound in as associated data, so
 *   a sealed value copied onto another row will not open there.
 *
 * Server-only: never import this from a client component.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const VERSION_PATTERN = /^v[1-9][0-9]{0,3}$/;
const HEX_KEY_PATTERN = /^[0-9a-fA-F]{64}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export type VaultErrorCode =
  | "missing_key" // CREDENTIAL_VAULT_KEY isn't set
  | "invalid_key" // a key isn't 64 hex characters, or a version label is malformed
  | "malformed" // the stored value isn't in the v<n>:iv.tag.ct form
  | "unknown_version" // sealed with a key version this server doesn't hold
  | "tampered"; // authentication failed: the value was altered, or the key is wrong

/** A vault failure. `message` is safe to log; it never contains a key or a secret. */
export class VaultError extends Error {
  readonly code: VaultErrorCode;
  constructor(code: VaultErrorCode, message: string) {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}

export interface VaultKeyring {
  /** The version new values are sealed with, e.g. "v1". */
  current: string;
  /** Every key this server can open, by version (the current one included). */
  keys: ReadonlyMap<string, Buffer>;
}

/** True for a version label like `v1`, `v2` … `v9999`. */
export function isVaultVersion(value: unknown): value is string {
  return typeof value === "string" && VERSION_PATTERN.test(value);
}

/** Reads a 64-hex-character key into 32 bytes, or throws `invalid_key`. */
export function parseVaultKey(hex: string, name = "CREDENTIAL_VAULT_KEY"): Buffer {
  const trimmed = hex.trim();
  if (!HEX_KEY_PATTERN.test(trimmed)) {
    throw new VaultError("invalid_key", `${name} must be exactly 64 hexadecimal characters (32 bytes).`);
  }
  const key = Buffer.from(trimmed, "hex");
  if (key.length !== KEY_BYTES) throw new VaultError("invalid_key", `${name} must decode to 32 bytes.`);
  return key;
}

/** Builds a keyring from explicit keys (tests and the rotation job use this). */
export function createKeyring(current: string, keys: Record<string, string | Buffer>): VaultKeyring {
  if (!isVaultVersion(current)) throw new VaultError("invalid_key", `The vault key version must look like v1, v2 …; got "${current}".`);
  const map = new Map<string, Buffer>();
  for (const [version, key] of Object.entries(keys)) {
    if (!isVaultVersion(version)) throw new VaultError("invalid_key", `The vault key version must look like v1, v2 …; got "${version}".`);
    const buf = typeof key === "string" ? parseVaultKey(key, `vault key ${version}`) : Buffer.from(key);
    if (buf.length !== KEY_BYTES) throw new VaultError("invalid_key", `Vault key ${version} must be 32 bytes.`);
    map.set(version, buf);
  }
  if (!map.has(current)) throw new VaultError("missing_key", `There is no vault key for the current version ${current}.`);
  return { current, keys: map };
}

/**
 * The keyring from the environment (§17):
 * - `CREDENTIAL_VAULT_KEY` (required): the current key, 64 hex characters;
 * - `CREDENTIAL_VAULT_KEY_VERSION` (default `v1`): its version label;
 * - `CREDENTIAL_VAULT_PREVIOUS_KEYS` (only while rotating): `v1:<64 hex>,v2:<64 hex>`.
 */
export function keyringFromEnv(env: Record<string, string | undefined> = process.env): VaultKeyring {
  const currentHex = env.CREDENTIAL_VAULT_KEY?.trim();
  if (!currentHex) {
    throw new VaultError("missing_key", "CREDENTIAL_VAULT_KEY is not set, so stored passwords can't be saved or shown. See .env.example.");
  }
  const current = (env.CREDENTIAL_VAULT_KEY_VERSION?.trim() || "v1").toLowerCase();
  const keys: Record<string, string> = {};
  const previous = env.CREDENTIAL_VAULT_PREVIOUS_KEYS?.trim();
  if (previous) {
    for (const entry of previous.split(",")) {
      const item = entry.trim();
      if (!item) continue;
      const sep = item.indexOf(":");
      if (sep <= 0) throw new VaultError("invalid_key", "CREDENTIAL_VAULT_PREVIOUS_KEYS must look like v1:<64 hex>,v2:<64 hex>.");
      keys[item.slice(0, sep).trim().toLowerCase()] = item.slice(sep + 1).trim();
    }
  }
  keys[current] = currentHex;
  return createKeyring(current, keys);
}

export interface SealedParts {
  version: string;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

function decodeBase64(part: string, what: string): Buffer {
  if (!BASE64_PATTERN.test(part) || part.length % 4 !== 0) {
    throw new VaultError("malformed", `The stored value's ${what} isn't valid base64.`);
  }
  return Buffer.from(part, "base64");
}

/** Splits a stored value into its parts, or throws `malformed`. Does not decrypt. */
export function parseSealed(payload: string): SealedParts {
  if (typeof payload !== "string" || payload.length === 0) throw new VaultError("malformed", "The stored value is empty.");
  const sep = payload.indexOf(":");
  if (sep <= 0) throw new VaultError("malformed", "The stored value has no key version prefix (v1:…).");
  const version = payload.slice(0, sep);
  if (!isVaultVersion(version)) throw new VaultError("malformed", "The stored value's key version prefix is malformed.");
  const parts = payload.slice(sep + 1).split(".");
  if (parts.length !== 3) throw new VaultError("malformed", "The stored value must have three parts: iv.tag.ciphertext.");
  const iv = decodeBase64(parts[0], "IV");
  const tag = decodeBase64(parts[1], "auth tag");
  const ciphertext = decodeBase64(parts[2], "ciphertext");
  if (iv.length !== IV_BYTES) throw new VaultError("malformed", `The stored value's IV must be ${IV_BYTES} bytes.`);
  if (tag.length !== TAG_BYTES) throw new VaultError("malformed", `The stored value's auth tag must be ${TAG_BYTES} bytes.`);
  return { version, iv, tag, ciphertext };
}

/** The key version a stored value was sealed with (`v1`), or null when it isn't a vault value. */
export function vaultVersionOf(payload: string): string | null {
  try {
    return parseSealed(payload).version;
  } catch {
    return null;
  }
}

/** True for a string in the vault's stored form (it does not check that it opens). */
export function isSealed(payload: unknown): payload is string {
  return typeof payload === "string" && vaultVersionOf(payload) !== null;
}

function aadOf(version: string, context: string | undefined): Buffer {
  // The version is always authenticated, so the prefix can't be swapped for another key's label.
  return Buffer.from(context ? `${version}|${context}` : version, "utf8");
}

/** Seals `plaintext` with the current key. Each call uses a fresh random IV. */
export function encryptSecret(plaintext: string, opts: { keyring?: VaultKeyring; context?: string } = {}): string {
  if (typeof plaintext !== "string") throw new TypeError("encryptSecret expects a string.");
  const keyring = opts.keyring ?? keyringFromEnv();
  const key = keyring.keys.get(keyring.current);
  if (!key) throw new VaultError("missing_key", `There is no vault key for the current version ${keyring.current}.`);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aadOf(keyring.current, opts.context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${keyring.current}:${iv.toString("base64")}.${tag.toString("base64")}.${ciphertext.toString("base64")}`;
}

/**
 * Opens a stored value. Throws `malformed` for a value not in the vault's form, `unknown_version` for
 * a key this server doesn't hold, and `tampered` when authentication fails (altered value, wrong key
 * or wrong context). Never returns partial plaintext.
 */
export function decryptSecret(payload: string, opts: { keyring?: VaultKeyring; context?: string } = {}): string {
  const parts = parseSealed(payload);
  const keyring = opts.keyring ?? keyringFromEnv();
  const key = keyring.keys.get(parts.version);
  if (!key) {
    throw new VaultError(
      "unknown_version",
      `This value was sealed with vault key ${parts.version}, which this server doesn't have. Add it to CREDENTIAL_VAULT_PREVIOUS_KEYS.`,
    );
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, parts.iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aadOf(parts.version, opts.context));
    decipher.setAuthTag(parts.tag);
    return Buffer.concat([decipher.update(parts.ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new VaultError("tampered", "The stored value couldn't be opened: it was altered, or the vault key is wrong.");
  }
}

/** True when a stored value was sealed with an older key and should be re-encrypted. */
export function needsReencryption(payload: string, keyring: VaultKeyring = keyringFromEnv()): boolean {
  return parseSealed(payload).version !== keyring.current;
}

/**
 * Re-seals a stored value with the current key (the rotation job, §12). A value already on the
 * current key is returned unchanged with `changed: false`, so the job is safe to run twice.
 */
export function reencryptSecret(
  payload: string,
  opts: { keyring?: VaultKeyring; context?: string } = {},
): { value: string; changed: boolean } {
  const keyring = opts.keyring ?? keyringFromEnv();
  const parts = parseSealed(payload);
  if (parts.version === keyring.current) {
    // Still prove it opens, so the job reports damaged values instead of skipping them silently.
    decryptSecret(payload, { keyring, context: opts.context });
    return { value: payload, changed: false };
  }
  const plaintext = decryptSecret(payload, { keyring, context: opts.context });
  return { value: encryptSecret(plaintext, { keyring, context: opts.context }), changed: true };
}

/** Short names for the three operations (§12: encrypt / decrypt / re-encrypt for rotation). */
export const encrypt = encryptSecret;
export const decrypt = decryptSecret;
export const reencrypt = reencryptSecret;
