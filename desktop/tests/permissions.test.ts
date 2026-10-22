import { describe, expect, it } from "vitest";
import { decidePermission, installPermissionHandlers, partitionKind, whatsappNotificationsAllowed, type PermissionPolicy } from "../src/main/permissions";

const APP = "https://app.twchartered.com";
const WA = "https://web.whatsapp.com";
const partner: PermissionPolicy = { role: "partner", employeeNotifications: false };
const manager: PermissionPolicy = { role: "manager", employeeNotifications: false };
const employee: PermissionPolicy = { role: "employee", employeeNotifications: false };
const employeeWithNotifications: PermissionPolicy = { role: "employee", employeeNotifications: true };
const nobody: PermissionPolicy = { role: null, employeeNotifications: true };

const EVERYTHING_ELSE = [
  "geolocation",
  "clipboard-read",
  "display-capture",
  "fullscreen",
  "openExternal",
  "pointerLock",
  "keyboardLock",
  "midi",
  "midiSysex",
  "hid",
  "serial",
  "usb",
  "idle-detection",
  "fileSystem",
  "persistent-storage",
  "storage-access",
  "window-management",
  "mediaKeySystem",
  "unknown",
];

describe("partition kinds", () => {
  it("maps partitions to rule sets", () => {
    expect(partitionKind("persist:crm")).toBe("crm");
    expect(partitionKind("persist:wa-3f1c2b9e-0000-4000-8000-000000000001")).toBe("whatsapp");
    expect(partitionKind("taxwise-panel")).toBe("panel");
    expect(partitionKind("persist:wa-../../x")).toBe("panel");
    expect(partitionKind("")).toBe("panel");
  });
});

describe("WhatsApp partitions", () => {
  const wa = (permission: string, policy: PermissionPolicy, extra: { mediaTypes?: string[]; mediaType?: string; origin?: string } = {}) =>
    decidePermission({ partition: "whatsapp", permission, origin: extra.origin ?? WA, mediaTypes: extra.mediaTypes, mediaType: extra.mediaType }, policy, APP);

  it("allows notifications for Partners and Managers", () => {
    expect(wa("notifications", partner)).toBe(true);
    expect(wa("notifications", manager)).toBe(true);
  });

  it("blocks notifications for Employees unless a Partner turned on Employee notifications", () => {
    expect(wa("notifications", employee)).toBe(false);
    expect(wa("notifications", employeeWithNotifications)).toBe(true);
    expect(whatsappNotificationsAllowed(employee)).toBe(false);
  });

  it("allows the microphone for voice notes, never the camera", () => {
    expect(wa("media", employee, { mediaTypes: ["audio"] })).toBe(true);
    expect(wa("media", employee, { mediaTypes: ["video"] })).toBe(false);
    expect(wa("media", employee, { mediaTypes: ["audio", "video"] })).toBe(false);
    expect(wa("media", employee, { mediaTypes: [] })).toBe(false);
    expect(wa("media", partner, { mediaType: "audio" })).toBe(true);
    expect(wa("media", partner, { mediaType: "video" })).toBe(false);
    expect(wa("media", partner, { mediaType: "unknown" })).toBe(false);
  });

  it("allows sanitized clipboard writes", () => {
    expect(wa("clipboard-sanitized-write", employee)).toBe(true);
  });

  it("denies everything else", () => {
    for (const p of EVERYTHING_ELSE) {
      expect(wa(p, partner), p).toBe(false);
      expect(wa(p, employee), p).toBe(false);
    }
  });

  it("denies everything to another origin in a WhatsApp partition", () => {
    expect(wa("notifications", partner, { origin: "https://evil.example" })).toBe(false);
    expect(wa("clipboard-sanitized-write", partner, { origin: "https://evil.example/x" })).toBe(false);
    expect(wa("media", partner, { origin: "http://web.whatsapp.com", mediaTypes: ["audio"] })).toBe(false);
  });

  it("denies a blob: document whose creator was WhatsApp (its content is a file, not WhatsApp)", () => {
    expect(wa("notifications", partner, { origin: "blob:https://web.whatsapp.com/6a1f0c4e" })).toBe(false);
    expect(wa("media", partner, { origin: "blob:https://web.whatsapp.com/6a1f0c4e", mediaTypes: ["audio"] })).toBe(false);
    expect(decidePermission({ partition: "crm", permission: "notifications", origin: `blob:${APP}/x` }, partner, APP)).toBe(false);
  });

  it("denies everything when nobody is signed in", () => {
    expect(wa("notifications", nobody)).toBe(false);
    expect(wa("clipboard-sanitized-write", nobody)).toBe(false);
    expect(wa("media", nobody, { mediaTypes: ["audio"] })).toBe(false);
  });
});

describe("CRM partition", () => {
  const crm = (permission: string, origin = APP) => decidePermission({ partition: "crm", permission, origin }, employee, APP);

  it("allows notifications and sanitized clipboard writes", () => {
    expect(crm("notifications")).toBe(true);
    expect(crm("clipboard-sanitized-write")).toBe(true);
    expect(crm("notifications", `${APP}/clients/1`)).toBe(true);
  });

  it("denies the rest, including media", () => {
    expect(crm("media")).toBe(false);
    for (const p of EVERYTHING_ELSE) expect(crm(p), p).toBe(false);
  });

  it("denies another origin", () => {
    expect(crm("notifications", "https://example.com")).toBe(false);
  });
});

describe("panel header and unknown sessions", () => {
  it("get nothing", () => {
    for (const p of ["notifications", "clipboard-sanitized-write", "media", ...EVERYTHING_ELSE]) {
      expect(decidePermission({ partition: "panel", permission: p, origin: "taxwise://panel" }, partner, APP)).toBe(false);
    }
  });
});

describe("installPermissionHandlers", () => {
  it("installs both handlers and a device handler, reading the policy on each call", () => {
    let req: ((wc: unknown, p: string, cb: (ok: boolean) => void, d: unknown) => void) | null = null;
    let check: ((wc: unknown, p: string, origin: string, d: unknown) => boolean) | null = null;
    let device: (() => boolean) | null = null;
    const ses = {
      setPermissionRequestHandler: (h: typeof req) => void (req = h),
      setPermissionCheckHandler: (h: typeof check) => void (check = h),
      setDevicePermissionHandler: (h: typeof device) => void (device = h),
    };
    let policy: PermissionPolicy = employee;
    installPermissionHandlers(ses as never, "whatsapp", () => policy, APP);
    const wc = { getURL: () => `${WA}/` };

    const results: boolean[] = [];
    req!(wc, "notifications", (ok) => results.push(ok), { requestingUrl: `${WA}/`, isMainFrame: true });
    policy = partner;
    req!(wc, "notifications", (ok) => results.push(ok), { requestingUrl: `${WA}/`, isMainFrame: true });
    req!(wc, "media", (ok) => results.push(ok), { requestingUrl: `${WA}/`, isMainFrame: true, mediaTypes: ["video"] });
    expect(results).toEqual([false, true, false]);

    expect(check!(wc, "media", WA, { isMainFrame: true, mediaType: "audio" })).toBe(true);
    expect(check!(wc, "geolocation", WA, { isMainFrame: true })).toBe(false);
    expect(device!()).toBe(false);
  });
});
