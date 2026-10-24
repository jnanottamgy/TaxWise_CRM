import { describe, expect, it } from "vitest";
import {
  MessageTemplateSchema,
  bodySnippet,
  channelFits,
  copyName,
  insertVariable,
  isMoneyTemplateType,
  previewValues,
  templateTypesFor,
  usedVariables,
  variableGroupsFor,
} from "@/lib/schemas/message-templates";
import { SAMPLE_TEMPLATE_VALUES } from "@/lib/domain/templates";

/** Message templates (§7.13.4): the editor's schema and helpers. */

const base = { id: "", expected_updated_at: null, name: "GST data (WhatsApp)", type: "document_reminder", channel: "whatsapp", subject: "", body: "Hi {{contact_name}}", is_active: true } as const;

describe("MessageTemplateSchema", () => {
  it("accepts a template that uses only the listed variables", () => {
    const r = MessageTemplateSchema.safeParse({ ...base, body: "Hi {{contact_name}}, for {{period}} we need:\n{{missing_items}}\n\n" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.body).toBe("Hi {{contact_name}}, for {{period}} we need:\n{{missing_items}}");
  });

  it("rejects unknown variables on the field that has them, naming them (§7.13.4)", () => {
    const r = MessageTemplateSchema.safeParse({ ...base, channel: "email", subject: "{{firm_name}} | {{client_email}}", body: "Dear {{Contact_Name}}" });
    expect(r.success).toBe(false);
    if (!r.success) {
      const byField = Object.fromEntries(r.error.issues.map((i) => [i.path.join("."), i.message]));
      expect(byField.subject).toContain("{{client_email}}");
      expect(byField.body).toContain("did you mean {{contact_name}}");
    }
  });

  it("drops the subject of a WhatsApp template and refuses an empty message", () => {
    const ok = MessageTemplateSchema.safeParse({ ...base, subject: "{{not_checked}}" });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.subject).toBeNull();
    const empty = MessageTemplateSchema.safeParse({ ...base, body: "   " });
    expect(empty.success).toBe(false);
    if (!empty.success) expect(empty.error.issues[0].message).toBe("Write the message.");
  });

  it("needs a name, a known type and channel", () => {
    expect(MessageTemplateSchema.safeParse({ ...base, name: " " }).success).toBe(false);
    expect(MessageTemplateSchema.safeParse({ ...base, type: "reminder" }).success).toBe(false);
    expect(MessageTemplateSchema.safeParse({ ...base, channel: "sms" }).success).toBe(false);
  });
});

describe("who sees which types (§4.1)", () => {
  it("Employees never get payment reminders or quotations, nor the Money variables", () => {
    expect(templateTypesFor("employee")).not.toContain("payment_reminder");
    expect(templateTypesFor("employee")).not.toContain("quotation");
    expect(templateTypesFor("manager")).toContain("payment_reminder");
    expect(isMoneyTemplateType("quotation")).toBe(true);
    expect(isMoneyTemplateType("welcome")).toBe(false);
    expect(variableGroupsFor("employee").map((g) => g.group)).toEqual(["Client", "Work", "Links", "Firm"]);
    expect(variableGroupsFor("partner").map((g) => g.group)).toContain("Money");
  });
});

describe("channelFits", () => {
  it("offers Any everywhere, WhatsApp templates for WhatsApp, email ones for email", () => {
    expect(channelFits("any", "whatsapp")).toBe(true);
    expect(channelFits("whatsapp", "whatsapp")).toBe(true);
    expect(channelFits("email", "whatsapp")).toBe(false);
    expect(channelFits("email", "email")).toBe(true);
    expect(channelFits("whatsapp", "email")).toBe(false);
    expect(channelFits("email", "portal")).toBe(true);
    expect(channelFits("whatsapp", "portal")).toBe(true);
  });
});

describe("insertVariable", () => {
  it("inserts at the cursor and replaces a selection", () => {
    expect(insertVariable("Hi , thanks", "contact_name", 3)).toEqual({ text: "Hi {{contact_name}}, thanks", cursor: 19 });
    expect(insertVariable("Hi NAME!", "contact_name", 3, 7)).toEqual({ text: "Hi {{contact_name}}!", cursor: 19 });
    expect(insertVariable("Hello", "firm_name", null)).toEqual({ text: "Hello{{firm_name}}", cursor: 18 });
    expect(insertVariable("ab", "period", 99, 120).text).toBe("ab{{period}}");
  });
});

describe("helpers", () => {
  it("lists the variables used, subject first, once each", () => {
    expect(usedVariables("{{period}} {{contact_name}} {{period}} {{nope}}", "{{firm_name}}")).toEqual(["firm_name", "period", "contact_name"]);
  });

  it("fills the preview with the sample client but the firm's real name and the sender", () => {
    const v = previewValues({ firmName: "TaxWise Consultants", firmPhone: "+91 80 4123 4567", senderName: "Anita Rao", portalLink: "https://crm.twchartered.com/portal" });
    expect(v.client_name).toBe(SAMPLE_TEMPLATE_VALUES.client_name);
    expect(v.firm_phone).toBe("+91 80 4123 4567");
    expect(v.sender_name).toBe("Anita Rao");
    expect(v.portal_link).toBe("https://crm.twchartered.com/portal");
    expect(previewValues({}).firm_phone).toBe(SAMPLE_TEMPLATE_VALUES.firm_phone);
  });

  it("names a copy without clashing (case-insensitive, like citext)", () => {
    expect(copyName("Welcome (email)", [])).toBe("Welcome (email) (copy)");
    expect(copyName("Welcome (email)", ["welcome (email) (copy)"])).toBe("Welcome (email) (copy 2)");
    expect(copyName("Welcome (email) (copy)", ["Welcome (email) (copy)", "Welcome (email) (copy 2)"])).toBe("Welcome (email) (copy 3)");
    expect(copyName("x".repeat(120), []).length).toBeLessThanOrEqual(120);
  });

  it("shows the first line of the body that says something, trimmed", () => {
    expect(bodySnippet("\n\n  Dear {{contact_name}},\n\nYour {{compliance_type}} is due.")).toBe("Your {{compliance_type}} is due.");
    expect(bodySnippet("Dear {{contact_name}},")).toBe("Dear {{contact_name}},");
    expect(bodySnippet("Hi {{contact_name}}, a gentle reminder\nmore")).toBe("Hi {{contact_name}}, a gentle reminder");
    expect(bodySnippet("a".repeat(200), 20)).toBe(`${"a".repeat(19)}…`);
  });
});
