import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createKeyring,
  decryptSecret,
  encryptSecret,
  isSealed,
  keyringFromEnv,
  needsReencryption,
  parseSealed,
  parseVaultKey,
  reencryptSecret,
  vaultVersionOf,
  VaultError,
} from "@/server/vault";

// Fixed test keys (never used anywhere else). 64 hex characters each.
const KEY_A = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const KEY_B = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";

const ringA = createKeyring("v1", { v1: KEY_A });
const ringB = createKeyring("v1", { v1: KEY_B });

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof VaultError ? err.code : `not a VaultError: ${String(err)}`;
  }
}

describe("credential vault: round trip (§12)", () => {
  it("opens what it sealed", () => {
    const sealed = encryptSecret("Gst@Portal#2026", { keyring: ringA });
    expect(decryptSecret(sealed, { keyring: ringA })).toBe("Gst@Portal#2026");
  });

  it("handles unicode, long and empty secrets", () => {
    for (const secret of ["पासवर्ड ₹ 1,23,456", "x".repeat(4096), ""]) {
      expect(decryptSecret(encryptSecret(secret, { keyring: ringA }), { keyring: ringA })).toBe(secret);
    }
  });

  it("uses a fresh random 12-byte IV every time", () => {
    const a = encryptSecret("same", { keyring: ringA });
    const b = encryptSecret("same", { keyring: ringA });
    expect(a).not.toBe(b);
    const pa = parseSealed(a);
    const pb = parseSealed(b);
    expect(pa.iv).toHaveLength(12);
    expect(pa.tag).toHaveLength(16);
    expect(pa.iv.equals(pb.iv)).toBe(false);
  });

  it("never contains the plaintext", () => {
    const sealed = encryptSecret("VerySecretPassword", { keyring: ringA });
    expect(sealed).not.toContain("VerySecretPassword");
    expect(sealed).not.toContain(Buffer.from("VerySecretPassword").toString("base64"));
  });
});

describe("credential vault: stored form and version prefix", () => {
  it("is v1:<base64 iv>.<base64 tag>.<base64 ct>", () => {
    const sealed = encryptSecret("abc", { keyring: ringA });
    expect(sealed).toMatch(/^v1:[A-Za-z0-9+/]+={0,2}\.[A-Za-z0-9+/]+={0,2}\.[A-Za-z0-9+/]*={0,2}$/);
    expect(vaultVersionOf(sealed)).toBe("v1");
    expect(isSealed(sealed)).toBe(true);
  });

  it("prefixes with the current version of the keyring", () => {
    const ring = createKeyring("v7", { v7: KEY_B });
    expect(encryptSecret("abc", { keyring: ring }).startsWith("v7:")).toBe(true);
  });

  it("rejects values without a valid prefix or with missing parts", () => {
    const sealed = encryptSecret("abc", { keyring: ringA });
    const body = sealed.slice(3);
    expect(codeOf(() => decryptSecret(body, { keyring: ringA }))).toBe("malformed");
    expect(codeOf(() => decryptSecret(`x1:${body}`, { keyring: ringA }))).toBe("malformed");
    expect(codeOf(() => decryptSecret(`v1:${body.split(".").slice(0, 2).join(".")}`, { keyring: ringA }))).toBe("malformed");
    expect(codeOf(() => decryptSecret("", { keyring: ringA }))).toBe("malformed");
    expect(codeOf(() => decryptSecret("plain text password", { keyring: ringA }))).toBe("malformed");
    expect(isSealed("plain text password")).toBe(false);
    expect(vaultVersionOf("v1:not.base64!.at-all")).toBeNull();
  });

  it("refuses a version this server doesn't hold", () => {
    const ring2 = createKeyring("v2", { v2: KEY_B });
    const sealed = encryptSecret("abc", { keyring: ring2 });
    expect(codeOf(() => decryptSecret(sealed, { keyring: ringA }))).toBe("unknown_version");
  });
});

describe("credential vault: tamper detection", () => {
  const sealed = encryptSecret("Income-tax portal password", { keyring: ringA });
  const [prefix, rest] = [sealed.slice(0, 3), sealed.slice(3)];
  const [iv, tag, ct] = rest.split(".");

  function flipFirstByte(b64: string): string {
    const buf = Buffer.from(b64, "base64");
    buf[0] ^= 0x01;
    return buf.toString("base64");
  }

  it("detects a changed ciphertext", () => {
    expect(codeOf(() => decryptSecret(`${prefix}${iv}.${tag}.${flipFirstByte(ct)}`, { keyring: ringA }))).toBe("tampered");
  });

  it("detects a changed auth tag", () => {
    expect(codeOf(() => decryptSecret(`${prefix}${iv}.${flipFirstByte(tag)}.${ct}`, { keyring: ringA }))).toBe("tampered");
  });

  it("detects a changed IV", () => {
    expect(codeOf(() => decryptSecret(`${prefix}${flipFirstByte(iv)}.${tag}.${ct}`, { keyring: ringA }))).toBe("tampered");
  });

  it("detects a relabelled version prefix", () => {
    const both = createKeyring("v1", { v1: KEY_A, v2: KEY_A });
    // Same key under another label: the version is authenticated, so the swap is caught.
    expect(codeOf(() => decryptSecret(`v2:${rest}`, { keyring: both }))).toBe("tampered");
  });

  it("binds the optional context (a value copied to another row won't open)", () => {
    const bound = encryptSecret("secret", { keyring: ringA, context: "credential:1" });
    expect(decryptSecret(bound, { keyring: ringA, context: "credential:1" })).toBe("secret");
    expect(codeOf(() => decryptSecret(bound, { keyring: ringA, context: "credential:2" }))).toBe("tampered");
    expect(codeOf(() => decryptSecret(bound, { keyring: ringA }))).toBe("tampered");
  });
});

describe("credential vault: wrong key", () => {
  it("refuses to open with a different key of the same version", () => {
    const sealed = encryptSecret("abc", { keyring: ringA });
    expect(codeOf(() => decryptSecret(sealed, { keyring: ringB }))).toBe("tampered");
  });

  it("validates keys: exactly 64 hex characters", () => {
    expect(parseVaultKey(KEY_A)).toHaveLength(32);
    expect(codeOf(() => parseVaultKey(KEY_A.slice(1)))).toBe("invalid_key");
    expect(codeOf(() => parseVaultKey(`${KEY_A}00`))).toBe("invalid_key");
    expect(codeOf(() => parseVaultKey(KEY_A.replace("0", "g")))).toBe("invalid_key");
    expect(codeOf(() => parseVaultKey(""))).toBe("invalid_key");
  });

  it("validates version labels", () => {
    expect(codeOf(() => createKeyring("1", { "1": KEY_A }))).toBe("invalid_key");
    expect(codeOf(() => createKeyring("v1", { v2: KEY_A }))).toBe("missing_key");
  });
});

describe("credential vault: keyring from the environment (§17)", () => {
  it("needs CREDENTIAL_VAULT_KEY", () => {
    expect(codeOf(() => keyringFromEnv({}))).toBe("missing_key");
  });

  it("defaults the version to v1", () => {
    const ring = keyringFromEnv({ CREDENTIAL_VAULT_KEY: KEY_A });
    expect(ring.current).toBe("v1");
    expect(encryptSecret("x", { keyring: ring }).startsWith("v1:")).toBe(true);
  });

  it("reads the version and previous keys", () => {
    const ring = keyringFromEnv({
      CREDENTIAL_VAULT_KEY: KEY_B,
      CREDENTIAL_VAULT_KEY_VERSION: "v2",
      CREDENTIAL_VAULT_PREVIOUS_KEYS: `v1:${KEY_A}`,
    });
    expect(ring.current).toBe("v2");
    expect([...ring.keys.keys()].sort()).toEqual(["v1", "v2"]);
  });

  it("rejects a malformed key or previous-keys list", () => {
    expect(codeOf(() => keyringFromEnv({ CREDENTIAL_VAULT_KEY: "short" }))).toBe("invalid_key");
    expect(codeOf(() => keyringFromEnv({ CREDENTIAL_VAULT_KEY: KEY_A, CREDENTIAL_VAULT_PREVIOUS_KEYS: KEY_B }))).toBe("invalid_key");
  });
});

describe("credential vault: rotation (re-encryption)", () => {
  const oldRing = createKeyring("v1", { v1: KEY_A });
  const rotating = createKeyring("v2", { v1: KEY_A, v2: KEY_B });
  const newOnly = createKeyring("v2", { v2: KEY_B });

  it("re-seals an old value with the current key, and it opens without the old key", () => {
    const old = encryptSecret("TRACES password", { keyring: oldRing });
    expect(needsReencryption(old, rotating)).toBe(true);
    const { value, changed } = reencryptSecret(old, { keyring: rotating });
    expect(changed).toBe(true);
    expect(value.startsWith("v2:")).toBe(true);
    expect(needsReencryption(value, rotating)).toBe(false);
    expect(decryptSecret(value, { keyring: newOnly })).toBe("TRACES password");
  });

  it("leaves a current value unchanged (safe to run twice)", () => {
    const current = encryptSecret("MCA password", { keyring: rotating });
    expect(reencryptSecret(current, { keyring: rotating })).toEqual({ value: current, changed: false });
  });

  it("keeps the context through rotation", () => {
    const old = encryptSecret("bound", { keyring: oldRing, context: "row-9" });
    const { value } = reencryptSecret(old, { keyring: rotating, context: "row-9" });
    expect(decryptSecret(value, { keyring: newOnly, context: "row-9" })).toBe("bound");
  });

  it("reports a damaged value instead of skipping it", () => {
    const current = encryptSecret("x", { keyring: rotating });
    const damaged = `${current.slice(0, -2)}AA`;
    expect(codeOf(() => reencryptSecret(damaged, { keyring: rotating }))).toBe("tampered");
  });
});
