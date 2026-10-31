import { describe, expect, it } from "vitest";
import { todayIST } from "@/lib/domain/fy";
import {
  AddMemberSchema,
  CloseGroupSchema,
  FirmNumberSchema,
  MarkCreatedSchema,
  OpenChatSchema,
  TickStepSchema,
  UpdateGroupSchema,
  WhatsAppSettingsSchema,
  type FirmNumberInput,
  type WhatsAppSettingsInput,
} from "@/lib/schemas/whatsapp";

const G = "11111111-1111-4111-8111-111111111111";
const N = "22222222-2222-4222-8222-222222222222";
const P = "33333333-3333-4333-8333-333333333333";

const firstError = (r: { success: boolean; error?: { issues: Array<{ message: string; path: PropertyKey[] }> } }, path?: string) =>
  r.success ? null : (r.error!.issues.find((i) => (path ? i.path.join(".") === path : true))?.message ?? null);

describe("group forms (§7.25.2)", () => {
  it("Mark created: a date not in the future, a number, an optional invite link normalised", () => {
    const base = { groupId: G, updatedAt: "2026-10-22T05:00:00Z", createdOn: todayIST(), createdByNumberId: N };
    expect(MarkCreatedSchema.parse({ ...base, inviteLink: "" }).inviteLink).toBeNull();
    expect(MarkCreatedSchema.parse({ ...base, inviteLink: " chat.whatsapp.com/AbCdEf0123456789 " }).inviteLink).toBe("https://chat.whatsapp.com/AbCdEf0123456789");
    expect(firstError(MarkCreatedSchema.safeParse({ ...base, inviteLink: "https://example.com/x" }), "inviteLink")).toMatch(/chat\.whatsapp\.com/);
    expect(firstError(MarkCreatedSchema.safeParse({ ...base, createdOn: "2099-01-01" }), "createdOn")).toMatch(/can't be in the future/);
    expect(firstError(MarkCreatedSchema.safeParse({ ...base, createdByNumberId: "" }), "createdByNumberId")).toMatch(/firm number/);
  });

  it("Close group: a reason and a closing date", () => {
    expect(firstError(CloseGroupSchema.safeParse({ groupId: G, updatedAt: "x", closedOn: todayIST(), reason: " " }), "reason")).toMatch(/Say why/);
    expect(CloseGroupSchema.safeParse({ groupId: G, updatedAt: "x", closedOn: todayIST(), reason: "Engagement ended" }).success).toBe(true);
  });

  it("ticks only steps 1–6; edits trim the name", () => {
    expect(TickStepSchema.safeParse({ groupId: G, updatedAt: "x", step: "mark_created", done: true }).success).toBe(false);
    expect(TickStepSchema.safeParse({ groupId: G, updatedAt: "x", step: "group_settings", done: true }).success).toBe(true);
    expect(UpdateGroupSchema.parse({ groupId: G, updatedAt: "x", name: "  TW ·  TW-C-1 ·  XYZ ", purpose: "", notes: "" })).toMatchObject({ name: "TW · TW-C-1 · XYZ", purpose: null, notes: null });
  });

  it("members added by hand need what their kind needs", () => {
    const base = { groupId: G, addedOn: todayIST(), isAdmin: false };
    expect(firstError(AddMemberSchema.safeParse({ ...base, kind: "firm_number" }), "firmNumberId")).toMatch(/firm number/);
    expect(firstError(AddMemberSchema.safeParse({ ...base, kind: "other_person", displayName: "Auditor", number: "12345" }), "number")).toMatch(/WhatsApp can use/);
    expect(AddMemberSchema.safeParse({ ...base, kind: "other_person", displayName: "Auditor", number: "+91 98765 43210" }).success).toBe(true);
  });

  it("Open chat goes by browser or phone", () => {
    expect(OpenChatSchema.parse({ clientId: G, via: "browser" }).groupId).toBeNull();
    expect(OpenChatSchema.safeParse({ clientId: G, via: "phone" }).success).toBe(true);
    expect(OpenChatSchema.safeParse({ clientId: G, via: "desktop" }).success).toBe(false);
    expect(OpenChatSchema.safeParse({ clientId: G, via: "iframe" }).success).toBe(false);
  });
});

describe("Settings → WhatsApp (§7.21)", () => {
  const settings: WhatsAppSettingsInput = {
    updated_at: "2026-10-22T05:00:00Z",
    whatsapp_country_code: "+91",
    whatsapp_group_name_format: "TW · {client_code} · {short_name}",
    whatsapp_signature: "– {first_name}",
    whatsapp_employee_browser_window: false,
    whatsapp_house_rules: "1. Same firm numbers in every client group, plus the client's people.",
  };

  it("accepts the seeded defaults, and writes nothing that only TaxWise Desktop used", () => {
    expect(WhatsAppSettingsSchema.parse(settings)).toMatchObject({ whatsapp_country_code: "91", whatsapp_employee_browser_window: false });
    const parsed = WhatsAppSettingsSchema.parse({ ...settings, whatsapp_client_mode: false, whatsapp_linked_device_limit: "10", desktop_download_url: "https://x.example/setup.exe" });
    expect(Object.keys(parsed).sort()).toEqual(["updated_at", "whatsapp_country_code", "whatsapp_employee_browser_window", "whatsapp_group_name_format", "whatsapp_house_rules", "whatsapp_signature"]);
  });

  it("refuses a format without the client code, an unknown placeholder, and a signature without {first_name}", () => {
    expect(firstError(WhatsAppSettingsSchema.safeParse({ ...settings, whatsapp_group_name_format: "TW · {short_name}" }), "whatsapp_group_name_format")).toMatch(/client_code/);
    expect(firstError(WhatsAppSettingsSchema.safeParse({ ...settings, whatsapp_signature: "– {name}" }), "whatsapp_signature")).toMatch(/\{name\}/);
    expect(firstError(WhatsAppSettingsSchema.safeParse({ ...settings, whatsapp_signature: "– Team" }), "whatsapp_signature")).toMatch(/first_name/);
  });

  it("takes the country code as 1 to 4 digits", () => {
    expect(firstError(WhatsAppSettingsSchema.safeParse({ ...settings, whatsapp_country_code: "091" }), "whatsapp_country_code")).toMatch(/country code/);
  });

  const number: FirmNumberInput = {
    id: N,
    updated_at: "2026-10-22T05:00:00Z",
    country_code: "91",
    label: "Staff office",
    number: "98765 00005",
    kind: "staff_office",
    employee_id: "",
    custodian_employee_id: "none",
    in_every_client_group: true,
    group_admin: false,
    shared: true,
    two_step_verification_on: true,
    is_active: true,
  };

  it("normalises the number, and drops who could use it in TaxWise Desktop", () => {
    expect(FirmNumberSchema.parse(number)).toMatchObject({ number: "919876500005", custodian_employee_id: null, employee_id: null });
    expect(FirmNumberSchema.parse({ ...number, usable_by: ["employee"] })).not.toHaveProperty("usable_by");
  });

  it("gives a Partner's own number its Partner, and only that kind an owner", () => {
    const partner = { ...number, kind: "partner" as const, label: "CA Vinay H Karlagere (Partner)" };
    expect(firstError(FirmNumberSchema.safeParse(partner), "employee_id")).toMatch(/Choose the Partner/);
    expect(FirmNumberSchema.safeParse({ ...partner, employee_id: P }).success).toBe(true);
    expect(firstError(FirmNumberSchema.safeParse({ ...number, employee_id: P }), "employee_id")).toMatch(/Only a Partner's own number/);
  });

  it("needs a usable number to switch on", () => {
    expect(firstError(FirmNumberSchema.safeParse({ ...number, number: "" }), "number")).toMatch(/before switching it on/);
    expect(firstError(FirmNumberSchema.safeParse({ ...number, number: "080 2345" }), "number")).toMatch(/WhatsApp can use/);
    expect(FirmNumberSchema.safeParse({ ...number, number: "", is_active: false }).success).toBe(true);
  });
});
