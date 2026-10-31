import { describe, expect, it } from "vitest";
import {
  MembershipSchema,
  NOTIFICATION_EVENTS,
  PROFILE_IMAGE_LIMITS,
  ProfileDetailsSchema,
  checkProfileImage,
  notificationEventsFor,
  profileImagePathPattern,
  readWhatsAppSignaturePreference,
  sniffImageFormat,
} from "@/lib/schemas/profile";
import { NOTIFICATION_TYPES } from "@/lib/domain/enums";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0, 0, 0, 0]);

const UID = "11111111-1111-4111-8111-111111111111";
const FILE = "22222222-2222-4222-8222-222222222222";

describe("profile images (§7.1, §12 magic bytes)", () => {
  it("knows an image by its first bytes, not its name", () => {
    expect(sniffImageFormat(PNG)).toBe("png");
    expect(sniffImageFormat(JPEG)).toBe("jpeg");
    expect(sniffImageFormat(WEBP)).toBe("webp");
    expect(sniffImageFormat(GIF)).toBeNull();
    expect(sniffImageFormat(PDF)).toBeNull();
    expect(sniffImageFormat(new Uint8Array([0x89, 0x50]))).toBeNull();
  });

  it("photos take PNG, JPG or WebP up to 2 MB; signatures PNG or JPG up to 1 MB", () => {
    expect(checkProfileImage("avatar", WEBP)).toEqual({ ok: true, format: "webp" });
    expect(checkProfileImage("signature", PNG)).toEqual({ ok: true, format: "png" });
    expect(checkProfileImage("signature", WEBP)).toEqual({ ok: false, error: "Upload a PNG or JPG image of your signature." });
    expect(checkProfileImage("avatar", PDF)).toEqual({ ok: false, error: "Upload a PNG, JPG or WebP image." });
    expect(checkProfileImage("avatar", PNG, 0)).toEqual({ ok: false, error: "The file is empty." });
    const big = checkProfileImage("avatar", PNG, PROFILE_IMAGE_LIMITS.avatar.maxBytes + 1);
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.error).toMatch(/at most 2 MB/);
    const bigSig = checkProfileImage("signature", PNG, 1.5 * 1024 * 1024);
    expect(bigSig.ok).toBe(false);
    if (!bigSig.ok) expect(bigSig.error).toBe("The signature is 1.5 MB. Use a file of at most 1 MB.");
  });

  it("paths follow the bucket rules: <user_id>/avatar-<uuid>.<ext>", () => {
    expect(profileImagePathPattern("avatar").test(`${UID}/avatar-${FILE}.webp`)).toBe(true);
    expect(profileImagePathPattern("avatar").test(`${UID}/avatar-${FILE}.gif`)).toBe(false);
    expect(profileImagePathPattern("avatar").test(`../${UID}/avatar-${FILE}.png`)).toBe(false);
    expect(profileImagePathPattern("signature").test(`${UID}/signature-${FILE}.jpg`)).toBe(true);
    expect(profileImagePathPattern("signature").test(`${UID}/signature-${FILE}.webp`)).toBe(false);
    expect(profileImagePathPattern("signature").test(`${UID}/avatar-${FILE}.png`)).toBe(false);
  });
});

describe("name, phone and membership number (§7.1)", () => {
  it("the details form keeps what it showed for the concurrency check", () => {
    const r = ProfileDetailsSchema.safeParse({ was_full_name: "Ravi Kumar", was_phone: "", full_name: " Ravi K ", phone: "" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.full_name).toBe("Ravi K");
      expect(r.data.phone).toBeNull();
      expect(r.data.was_phone).toBeNull();
    }
    expect(ProfileDetailsSchema.safeParse({ was_full_name: "Ravi", full_name: "R" }).success).toBe(false);
    expect(ProfileDetailsSchema.safeParse({ was_full_name: "Ravi", full_name: "Ravi Kumar", phone: "call me" }).success).toBe(false);
  });

  it("a membership number is six digits with leading zeros kept; blank clears it", () => {
    const r = MembershipSchema.safeParse({ icai_membership_no: "21234" });
    expect(r.success && r.data.icai_membership_no).toBe("021234");
    const blank = MembershipSchema.safeParse({ icai_membership_no: "" });
    expect(blank.success && blank.data.icai_membership_no).toBeNull();
    expect(MembershipSchema.safeParse({ icai_membership_no: "M-21234" }).success).toBe(false);
  });
});

describe("notification events (§7.1, §9, §4.1)", () => {
  it("every notification type has an event row", () => {
    expect(NOTIFICATION_EVENTS.map((e) => e.type).sort()).toEqual([...NOTIFICATION_TYPES].sort());
  });

  it("Employees are never offered money notices", () => {
    const types = notificationEventsFor("employee").map((e) => e.type);
    for (const money of ["invoice_awaiting_approval", "invoice_overdue", "payment_received", "quotation_viewed", "quotation_responded"]) {
      expect(types).not.toContain(money);
    }
    expect(NOTIFICATION_EVENTS.filter((e) => e.group === "Money").every((e) => !e.roles.includes("employee"))).toBe(true);
    expect(types).toEqual(expect.arrayContaining(["task_assigned", "leave_decided", "cover_started", "cover_ended"]));
  });

  it("only Partners are offered invoice approvals and security alerts; Managers see leave requests", () => {
    expect(notificationEventsFor("partner").map((e) => e.type)).toEqual(expect.arrayContaining(["invoice_awaiting_approval", "security_alert"]));
    expect(notificationEventsFor("manager").map((e) => e.type)).not.toContain("invoice_awaiting_approval");
    expect(notificationEventsFor("manager").map((e) => e.type)).toContain("leave_requested");
    expect(notificationEventsFor("client")).toEqual([]);
  });

  it("WhatsApp signature: on by default for Managers and Employees, off for Partners", () => {
    expect(readWhatsAppSignaturePreference({}, "employee")).toBe(true);
    expect(readWhatsAppSignaturePreference({}, "manager")).toBe(true);
    expect(readWhatsAppSignaturePreference(null, "partner")).toBe(false);
    expect(readWhatsAppSignaturePreference({ messaging: { whatsapp_signature: false } }, "employee")).toBe(false);
    expect(readWhatsAppSignaturePreference({ messaging: { whatsapp_signature: true } }, "partner")).toBe(true);
  });
});
