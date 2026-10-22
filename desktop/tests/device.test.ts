import { describe, expect, it } from "vitest";
import { describeDevice, generateDeviceKey, isValidDeviceKey, loadOrCreateDeviceKey, type SecretStore } from "../src/main/device";

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

  it("falls back to a plain file only where the OS has no credential store", () => {
    const file = memoryFile();
    const r = loadOrCreateDeviceKey(fakeStore(false), file);
    expect(r.encrypted).toBe(false);
    expect(JSON.parse(file.get()!.toString())).toMatchObject({ enc: "plain", data: r.key });
  });

  it("describes the PC for check-in", () => {
    expect(describeDevice("FRONTDESK-2", "win32", "10.0.26100", "0.1.0")).toEqual({ deviceName: "FRONTDESK-2", os: "Windows 10.0.26100", appVersion: "0.1.0" });
    expect(describeDevice("  ", "darwin", "24.1.0", "0.1.0").deviceName).toBe("Unnamed PC");
  });
});
