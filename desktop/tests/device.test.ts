import { describe, expect, it } from "vitest";
import {
  describeDevice,
  DeviceKeyUnavailableError,
  generateDeviceKey,
  isValidDeviceKey,
  loadOrCreateDeviceKey,
  osCredentialStoreAvailable,
  type SecretStore,
} from "../src/main/device";

/** Stands in for safeStorage (the OS credential store). */
function fakeStore(available = true): SecretStore & { encrypted: string[] } {
  const encrypted: string[] = [];
  return {
    encrypted,
    isEncryptionAvailable: () => available,
    encryptString: (s) => {
      encrypted.push(s);
      return Buffer.from(`enc:${Buffer.from(s).toString("base64")}`);
    },
    decryptString: (b) => {
      const t = b.toString();
      if (!t.startsWith("enc:")) throw new Error("bad");
      return Buffer.from(t.slice(4), "base64").toString();
    },
  };
}

function memoryFile(initial: Buffer | null = null) {
  let data = initial;
  return { read: () => data, write: (b: Buffer) => void (data = b), get: () => data };
}

describe("device key (§5.13)", () => {
  it("is 32 random bytes as 64 lowercase hex characters", () => {
    const key = generateDeviceKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(isValidDeviceKey(key)).toBe(true);
  });

  it("comes from the random source, and differs every time", () => {
    expect(generateDeviceKey(() => new Uint8Array(32).fill(0xab))).toBe("ab".repeat(32));
    const keys = new Set(Array.from({ length: 50 }, () => generateDeviceKey()));
    expect(keys.size).toBe(50);
    expect(() => generateDeviceKey(() => new Uint8Array(16))).toThrow();
  });

  it("validates the format", () => {
    expect(isValidDeviceKey("AB".repeat(32))).toBe(false);
    expect(isValidDeviceKey("ab".repeat(31))).toBe(false);
    expect(isValidDeviceKey(null)).toBe(false);
  });

  it("is created once, kept encrypted by the OS credential store, and read back", () => {
    const store = fakeStore();
    const file = memoryFile();
    const first = loadOrCreateDeviceKey(store, file);
    expect(first).toMatchObject({ created: true, encrypted: true });
    const saved = JSON.parse(file.get()!.toString());
    expect(saved.enc).toBe("safeStorage");
    expect(file.get()!.toString()).not.toContain(first.key); // never stored in clear
    const again = loadOrCreateDeviceKey(store, file);
    expect(again).toEqual({ key: first.key, created: false, encrypted: true });
  });

  it("replaces a key it can't read back", () => {
    const file = memoryFile(Buffer.from('{"v":1,"enc":"safeStorage","data":"Z2FyYmFnZQ=="}'));
    const r = loadOrCreateDeviceKey(fakeStore(), file);
    expect(r.created).toBe(true);
    expect(isValidDeviceKey(r.key)).toBe(true);
    const junk = memoryFile(Buffer.from("not json"));
    expect(loadOrCreateDeviceKey(fakeStore(), junk).created).toBe(true);
  });

  it("falls back to a plain file only in a development run where the OS has no credential store", () => {
    const file = memoryFile();
    const r = loadOrCreateDeviceKey(fakeStore(false), file, { allowPlain: true });
    expect(r.encrypted).toBe(false);
    expect(JSON.parse(file.get()!.toString())).toMatchObject({ enc: "plain", data: r.key });
  });

  it("a locked-down run never writes the key in clear (§5.13: the OS credential store)", () => {
    const file = memoryFile();
    expect(() => loadOrCreateDeviceKey(fakeStore(false), file)).toThrow(DeviceKeyUnavailableError);
    expect(file.get()).toBeNull();
    const plain = memoryFile(Buffer.from(JSON.stringify({ v: 1, enc: "plain", data: "ab".repeat(32) })));
    expect(() => loadOrCreateDeviceKey(fakeStore(false), plain)).toThrow(DeviceKeyUnavailableError);
  });

  it("never replaces an encrypted key while the credential store is locked (no new PC, no clear-text downgrade)", () => {
    const store = fakeStore();
    const file = memoryFile();
    const first = loadOrCreateDeviceKey(store, file);
    const before = file.get()!.toString();
    const locked = fakeStore(false);
    expect(() => loadOrCreateDeviceKey(locked, file, { allowPlain: true })).toThrow(DeviceKeyUnavailableError);
    expect(file.get()!.toString()).toBe(before);
    expect(loadOrCreateDeviceKey(store, file).key).toBe(first.key);
  });

  it("encrypts a plain key from an earlier run as soon as the store is available", () => {
    const key = "cd".repeat(32);
    const file = memoryFile(Buffer.from(JSON.stringify({ v: 1, enc: "plain", data: key })));
    const r = loadOrCreateDeviceKey(fakeStore(), file);
    expect(r).toEqual({ key, created: false, encrypted: true });
    expect(JSON.parse(file.get()!.toString()).enc).toBe("safeStorage");
    expect(file.get()!.toString()).not.toContain(key);
  });

  it("doesn't count Linux's hard-coded-password fallback as a credential store", () => {
    expect(osCredentialStoreAvailable("win32", true, null)).toBe(true);
    expect(osCredentialStoreAvailable("darwin", true, null)).toBe(true);
    expect(osCredentialStoreAvailable("win32", false, null)).toBe(false);
    expect(osCredentialStoreAvailable("linux", true, "gnome_libsecret")).toBe(true);
    expect(osCredentialStoreAvailable("linux", true, "basic_text")).toBe(false);
    expect(osCredentialStoreAvailable("linux", true, "unknown")).toBe(false);
  });

  it("describes the PC for check-in", () => {
    expect(describeDevice("FRONTDESK-2", "win32", "10.0.26100", "0.1.0")).toEqual({ deviceName: "FRONTDESK-2", os: "Windows 10.0.26100", appVersion: "0.1.0" });
    expect(describeDevice("  ", "darwin", "24.1.0", "0.1.0").deviceName).toBe("Unnamed PC");
  });
});
