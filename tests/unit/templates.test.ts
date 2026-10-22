import { describe, expect, it } from "vitest";
import {
  extractVariables,
  isTemplateVariable,
  missingMarker,
  missingVariables,
  renderTemplate,
  SAMPLE_TEMPLATE_VALUES,
  TEMPLATE_VARIABLE_GROUPS,
  TEMPLATE_VARIABLES,
  validateTemplate,
  variableToken,
} from "@/lib/domain/templates";

describe("the allowed variables (§7.13.4)", () => {
  it("are exactly the spec's list, grouped as the picker shows them", () => {
    expect(TEMPLATE_VARIABLE_GROUPS.map((g) => [g.group, [...g.variables]])).toEqual([
      ["Client", ["client_name", "client_code", "contact_name"]],
      ["Work", ["service_type", "compliance_type", "period", "due_date", "days_until_due", "days_overdue", "task_title", "missing_items", "priority"]],
      ["Money", ["invoice_number", "amount", "payment_link", "upi_link"]],
      ["Links", ["portal_link", "quotation_link"]],
      ["Firm", ["firm_name", "firm_phone", "sender_name"]],
    ]);
    expect(TEMPLATE_VARIABLES).toHaveLength(21);
    expect(new Set(TEMPLATE_VARIABLES).size).toBe(21);
  });

  it("recognises allowed names only", () => {
    expect(isTemplateVariable("client_name")).toBe(true);
    expect(isTemplateVariable("upi_link")).toBe(true);
    expect(isTemplateVariable("client_email")).toBe(false);
    expect(isTemplateVariable("Client_Name")).toBe(false);
    expect(isTemplateVariable("{{client_name}}")).toBe(false);
    expect(variableToken("due_date")).toBe("{{due_date}}");
  });
});

describe("extractVariables", () => {
  it("lists variables in order of first use, once each, allowing spaces inside the braces", () => {
    expect(extractVariables("Hi {{contact_name}}, {{ period }} is due on {{due_date}}. {{contact_name}}")).toEqual([
      "contact_name",
      "period",
      "due_date",
    ]);
  });

  it("includes unknown names but not malformed placeholders", () => {
    expect(extractVariables("{{client_email}} {{client name}} {{}} {{client_name}")).toEqual(["client_email"]);
    expect(extractVariables("No variables here.")).toEqual([]);
  });
});

describe("validateTemplate (§7.13.4: unknown variables are rejected on save)", () => {
  it("accepts a template using only allowed variables, and lists them", () => {
    const body = "Hi {{contact_name}}, for your {{service_type}} for {{period}} we still need: {{missing_items}}. You can upload them here: {{portal_link}}";
    expect(validateTemplate(body)).toEqual({ ok: true, variables: ["contact_name", "service_type", "period", "missing_items", "portal_link"] });
    const welcome =
      "Welcome to the {{firm_name}} group for {{client_name}}. Our Partners, our Managers' desk and our team desk are all here, and our team sign their messages with their name. For anything urgent, please call {{firm_phone}}.";
    expect(validateTemplate(welcome).ok).toBe(true);
    expect(validateTemplate("Invoice {{invoice_number}}", "{{firm_name}}: invoice {{invoice_number}}")).toEqual({
      ok: true,
      variables: ["firm_name", "invoice_number"],
    });
  });

  it("rejects unknown variables in the body and says which", () => {
    const r = validateTemplate("Dear {{client_email}}, pay {{amount}} by {{pay_by}}.");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.unknown).toEqual(["client_email", "pay_by"]);
      expect(r.malformed).toEqual([]);
      expect(r.fieldErrors.body?.[0]).toBe("These variables aren't available: {{client_email}}, {{pay_by}}. Pick variables from the list.");
      expect(r.error).toBe(r.fieldErrors.body?.[0]);
    }
  });

  it("rejects unknown variables in the subject on the subject field", () => {
    const r = validateTemplate("Hi {{contact_name}}", "Re: {{ticket_no}}");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.fieldErrors).toEqual({ subject: ["This variable isn't available: {{ticket_no}}. Pick variables from the list."] });
      expect(r.unknown).toEqual(["ticket_no"]);
    }
  });

  it("suggests the right case", () => {
    const r = validateTemplate("Hi {{Client_Name}}");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("{{Client_Name}} (did you mean {{client_name}}?)");
  });

  it("rejects malformed placeholders", () => {
    for (const body of ["Hi {{client name}}", "Hi {{}}", "Hi {{client_name}", "Hi client_name}}", "Hi {{ 1st }}"]) {
      const r = validateTemplate(body);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.unknown).toEqual([]);
        expect(r.malformed.length).toBeGreaterThan(0);
        expect(r.fieldErrors.body?.[0]).toContain("write variables as {{name}}");
      }
    }
  });

  it("requires a body", () => {
    const r = validateTemplate("   ", "Subject");
    expect(r).toMatchObject({ ok: false, error: "Write the message.", fieldErrors: { body: ["Write the message."] } });
  });

  it("reports body and subject problems together", () => {
    const r = validateTemplate("{{nope}}", "{{also_nope}} {{x y}}");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(Object.keys(r.fieldErrors).sort()).toEqual(["body", "subject"]);
      expect(r.unknown).toEqual(["nope", "also_nope"]);
      expect(r.malformed).toEqual(["{{x y}}"]);
    }
  });
});

describe("renderTemplate (§7.13.4, plain text)", () => {
  const body = "Hi {{contact_name}},\n{{compliance_type}} for {{ period }} is due on {{due_date}} ({{days_until_due}} days).";

  it("fills every variable, keeping line breaks", () => {
    expect(renderTemplate(body, { contact_name: "Priya", compliance_type: "GSTR-3B", period: "Sep 2026", due_date: "20 Oct 2026", days_until_due: 5 })).toBe(
      "Hi Priya,\nGSTR-3B for Sep 2026 is due on 20 Oct 2026 (5 days).",
    );
  });

  it("renders missing values as empty, or marked for previews", () => {
    expect(renderTemplate("Hi {{contact_name}}!", {})).toBe("Hi !");
    expect(renderTemplate("Hi {{contact_name}}!", { contact_name: null })).toBe("Hi !");
    expect(renderTemplate("Hi {{contact_name}}!", { contact_name: "" }, { missing: "mark" })).toBe("Hi [contact_name]!");
    expect(renderTemplate("Hi {{contact_name}}!", {}, { missing: "mark" })).toBe(`Hi ${missingMarker("contact_name")}!`);
    expect(renderTemplate("{{days_overdue}}", { days_overdue: 0 })).toBe("0"); // 0 is a value
  });

  it("treats unknown variables as missing and leaves malformed placeholders as written", () => {
    expect(renderTemplate("A{{client_email}}B", {})).toBe("AB");
    expect(renderTemplate("A{{client_email}}B", {}, { missing: "mark" })).toBe("A[client_email]B");
    expect(renderTemplate("Hi {{client name}} {{}}", { client_name: "X" })).toBe("Hi {{client name}} {{}}");
  });

  it("doesn't escape HTML (plain text) and doesn't re-expand values", () => {
    expect(renderTemplate("{{client_name}}", { client_name: "<b>A & B</b>" })).toBe("<b>A & B</b>");
    expect(renderTemplate("{{client_name}}", { client_name: "{{firm_name}}" })).toBe("{{firm_name}}");
  });

  it("names the variables a preview should point out", () => {
    expect(missingVariables(body, { contact_name: "Priya", period: "" })).toEqual(["compliance_type", "period", "due_date", "days_until_due"]);
    expect(missingVariables("{{client_email}}", {})).toEqual(["client_email"]);
  });

  it("renders a full preview from the sample client with nothing missing", () => {
    expect(Object.keys(SAMPLE_TEMPLATE_VALUES).sort()).toEqual([...TEMPLATE_VARIABLES].sort());
    const all = TEMPLATE_VARIABLES.map((v) => variableToken(v)).join(" | ");
    const out = renderTemplate(all, SAMPLE_TEMPLATE_VALUES, { missing: "mark" });
    expect(out).not.toMatch(/\[[a-z_]+\]/);
    expect(out).not.toContain("{{");
  });
});
