import { describe, expect, it } from "vitest";
import {
  checkPassword,
  generateTemporaryPassword,
  meetsPasswordPolicy,
  PASSWORD_MAX_LENGTH,
  passwordPolicyMessage,
  TEMPORARY_PASSWORD_ALPHABET,
  TEMPORARY_PASSWORD_LENGTH,
} from "@/lib/auth/password-policy";
import { ChangePasswordSchema, NewPasswordSchema, SetupSchema } from "@/lib/schemas/auth";

const status = (pw: string) => Object.fromEntries(checkPassword(pw).map((c) => [c.rule, c.ok]));

describe("checkPassword (§4.4 live checklist)", () => {
  it("lists the five rules in checklist order", () => {
    expect(checkPassword("").map((c) => c.rule)).toEqual(["length", "upper", "lower", "digit", "symbol"]);
  });

  it("marks nothing met for an empty password", () => {
    expect(checkPassword("").every((c) => !c.ok)).toBe(true);
  });

  it("checks each rule on its own", () => {
    expect(status("abcdefgh")).toEqual({ length: true, upper: false, lower: true, digit: false, symbol: false });
    expect(status("ABC")).toEqual({ length: false, upper: true, lower: false, digit: false, symbol: false });
    expect(status("1234567")).toEqual({ length: false, upper: false, lower: false, digit: true, symbol: false });
    expect(status("!")).toEqual({ length: false, upper: false, lower: false, digit: false, symbol: true });
  });

  it("needs exactly 8 characters at minimum", () => {
    expect(status("Aa1!aaa").length).toBe(false); // 7
    expect(status("Aa1!aaaa").length).toBe(true); // 8
  });

  it("counts every printable ASCII punctuation mark as a symbol, but not spaces or letters", () => {
    for (const ch of "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~") expect(status(ch).symbol).toBe(true);
    expect(status(" ").symbol).toBe(false);
    expect(status("é").symbol).toBe(false);
  });

  it("uses ASCII letter classes (matches Supabase's own requirement)", () => {
    expect(status("É").upper).toBe(false);
    expect(status("é").lower).toBe(false);
  });
});

describe("meetsPasswordPolicy and passwordPolicyMessage", () => {
  it("accepts a password that meets every rule", () => {
    expect(meetsPasswordPolicy("Taxwise@2026")).toBe(true);
    expect(passwordPolicyMessage("Taxwise@2026")).toBeNull();
  });

  it("names everything that is missing in one sentence", () => {
    expect(passwordPolicyMessage("taxwise")).toBe("Your password needs at least 8 characters, an uppercase letter, a number and a symbol.");
    expect(passwordPolicyMessage("Taxwise2026")).toBe("Your password needs a symbol.");
    expect(passwordPolicyMessage("TAXWISE@2026")).toBe("Your password needs a lowercase letter.");
  });

  it("asks for a password when empty", () => {
    expect(passwordPolicyMessage("")).toBe("Enter a password.");
  });

  it("refuses passwords longer than bcrypt can use", () => {
    const long = `Aa1!${"a".repeat(PASSWORD_MAX_LENGTH)}`;
    expect(meetsPasswordPolicy(long)).toBe(false);
    expect(passwordPolicyMessage(long)).toBe(`Use ${PASSWORD_MAX_LENGTH} characters or fewer.`);
    expect(meetsPasswordPolicy(`Aa1!${"a".repeat(PASSWORD_MAX_LENGTH - 4)}`)).toBe(true);
  });
});

describe("generateTemporaryPassword (§4.5)", () => {
  const all = Object.values(TEMPORARY_PASSWORD_ALPHABET).join("");

  it("always meets the policy", () => {
    for (let i = 0; i < 2000; i++) expect(meetsPasswordPolicy(generateTemporaryPassword())).toBe(true);
  });

  it("has the default length and clamps requested lengths to 12–64", () => {
    expect(generateTemporaryPassword()).toHaveLength(TEMPORARY_PASSWORD_LENGTH);
    expect(generateTemporaryPassword(4)).toHaveLength(12);
    expect(generateTemporaryPassword(20)).toHaveLength(20);
    expect(generateTemporaryPassword(500)).toHaveLength(64);
  });

  it("uses only easy-to-read characters, none that WhatsApp turns into formatting", () => {
    for (let i = 0; i < 500; i++) {
      const pw = generateTemporaryPassword();
      for (const ch of pw) expect(all).toContain(ch);
      expect(pw).not.toMatch(/[0O1lI*_~`'" \\]/);
    }
  });

  it("is random: no repeats across many draws, and every character class position varies", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateTemporaryPassword());
    expect(seen.size).toBe(1000);
    // The guaranteed characters are shuffled, so the first character is not always uppercase.
    const firsts = new Set(Array.from(seen, (p) => (/[A-Z]/.test(p[0]) ? "U" : /[a-z]/.test(p[0]) ? "L" : /[0-9]/.test(p[0]) ? "D" : "S")));
    expect(firsts.size).toBeGreaterThan(2);
  });
});

describe("password schemas", () => {
  it("NewPasswordSchema applies the policy and the confirmation", () => {
    expect(NewPasswordSchema.safeParse({ password: "Taxwise@2026", confirm: "Taxwise@2026" }).success).toBe(true);
    const weak = NewPasswordSchema.safeParse({ password: "taxwise", confirm: "taxwise" });
    expect(weak.success).toBe(false);
    expect(weak.error?.issues[0]?.path).toEqual(["password"]);
    const mismatch = NewPasswordSchema.safeParse({ password: "Taxwise@2026", confirm: "Taxwise@2027" });
    expect(mismatch.success).toBe(false);
    expect(mismatch.error?.issues.map((i) => i.path.join("."))).toContain("confirm");
  });

  it("ChangePasswordSchema refuses reusing the current password", () => {
    const r = ChangePasswordSchema.safeParse({ current: "Taxwise@2026", password: "Taxwise@2026", confirm: "Taxwise@2026" });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path.join("."))).toContain("password");
  });

  it("SetupSchema accepts the §1 firm details and normalises identifiers", () => {
    const r = SetupSchema.safeParse({
      fullName: "Vinay H Karlagere",
      email: " Partner@TWChartered.com ",
      password: "Taxwise@2026",
      confirm: "Taxwise@2026",
      firmName: "TaxWise Consultants",
      tagline: "Chartered Accountants · Bengaluru",
      address: "307, 14th Main Rd, Raj Mahal Vilas Extension, Sadashiva Nagar",
      city: "Bengaluru",
      stateCode: "29",
      pincode: "560 080",
      phone: "+91 97405 40239",
      firmEmail: "info@twchartered.com",
      website: "https://www.twchartered.com/",
      gstin: "29aaxft1811b1z3",
      pan: "aaxft1811b",
    });
    expect(r.success).toBe(true);
    expect(r.data?.email).toBe("partner@twchartered.com");
    expect(r.data?.gstin).toBe("29AAXFT1811B1Z3");
    expect(r.data?.pan).toBe("AAXFT1811B");
    expect(r.data?.pincode).toBe("560080");
  });

  it("SetupSchema catches a GSTIN whose PAN or state disagrees", () => {
    const r = SetupSchema.safeParse({
      fullName: "Vinay H Karlagere",
      email: "partner@twchartered.com",
      password: "Taxwise@2026",
      confirm: "Taxwise@2026",
      firmName: "TaxWise Consultants",
      address: "307, 14th Main Rd, Sadashiva Nagar",
      city: "Bengaluru",
      stateCode: "27",
      pincode: "560080",
      firmEmail: "info@twchartered.com",
      gstin: "29AAXFT1811B1Z3",
      pan: "AAXFT1811C",
    });
    expect(r.success).toBe(false);
    const paths = r.error?.issues.map((i) => i.path.join(".")) ?? [];
    expect(paths).toContain("stateCode");
  });
});
