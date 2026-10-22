import { describe, expect, it } from "vitest";
import {
  AADHAAR_FULL_NUMBER_ERROR,
  bankFromIfsc,
  containsFullAadhaar,
  deriveFromGstin,
  EXPECTED_PAN_HOLDER,
  formatStateWithCode,
  gstinCheckCharacter,
  gstinPanMismatch,
  isValidCin,
  isValidDin,
  isValidGstin,
  isValidIfsc,
  isValidLlpin,
  isValidPan,
  isValidPincode,
  isValidStateCode,
  isValidTan,
  isValidUdin,
  maskAadhaarLast4,
  normaliseIdentifier,
  normaliseMembershipNo,
  PAN_HOLDER_TYPES,
  panEntityMismatch,
  STATE_CODES,
  stateName,
  stateOptions,
  validateAadhaarLast4,
  validateCin,
  validateDin,
  validateGstin,
  validateIfsc,
  validateLlpin,
  validatePan,
  validatePincode,
  validateTan,
  validateUdin,
} from "@/lib/domain/india-validators";
import { ENTITY_TYPES } from "@/lib/domain/enums";

const TAXWISE_GSTIN = "29AAXFT1811B1Z3";
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** A valid GSTIN for any state/PAN, by appending the computed check character. */
function makeGstin(first14: string): string {
  const check = gstinCheckCharacter(first14);
  if (!check) throw new Error("bad input");
  return first14 + check;
}

describe("normaliseIdentifier", () => {
  it("strips whitespace and upper-cases", () => {
    expect(normaliseIdentifier("  29aaxft 1811b1z3\t")).toBe(TAXWISE_GSTIN);
  });
});

describe("GSTIN (§6.2)", () => {
  it("accepts TaxWise's own GSTIN and derives state and PAN", () => {
    expect(validateGstin(TAXWISE_GSTIN)).toEqual({
      ok: true,
      value: TAXWISE_GSTIN,
      stateCode: "29",
      stateName: "Karnataka",
      pan: "AAXFT1811B",
    });
    expect(isValidGstin(TAXWISE_GSTIN)).toBe(true);
  });

  it("computes the check character with Luhn mod 36", () => {
    expect(gstinCheckCharacter("29AAXFT1811B1Z")).toBe("3");
    expect(gstinCheckCharacter("29AAXFT1811B1")).toBeNull(); // too short
    expect(gstinCheckCharacter("29AAXFT1811B1z")).toBeNull(); // outside the alphabet
  });

  it("normalises lower case and spaces before validating", () => {
    const r = validateGstin(" 29aaxft1811b1z3 ");
    expect(r.ok && r.value).toBe(TAXWISE_GSTIN);
  });

  it("rejects every single-character change at every position", () => {
    let tried = 0;
    for (let i = 0; i < TAXWISE_GSTIN.length; i++) {
      for (const c of ALPHABET) {
        if (c === TAXWISE_GSTIN[i]) continue;
        const changed = TAXWISE_GSTIN.slice(0, i) + c + TAXWISE_GSTIN.slice(i + 1);
        tried++;
        expect(isValidGstin(changed), `${changed} should be invalid`).toBe(false);
      }
    }
    expect(tried).toBe(15 * 35);
  });

  it("rejects an adjacent transposition of digits", () => {
    expect(isValidGstin("29AAXFT8111B1Z3")).toBe(false);
  });

  it("says when the check character doesn't match", () => {
    const r = validateGstin("29AAXFT1811B1Z4");
    expect(r).toEqual({ ok: false, error: expect.stringContaining("check character") });
  });

  it("explains a wrong length", () => {
    const r = validateGstin("29AAXFT1811B1Z");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("A GSTIN has 15 characters; this one has 14.");
  });

  it("asks for a value when empty", () => {
    expect(validateGstin("  ")).toEqual({ ok: false, error: "Enter the GSTIN." });
  });

  it("enforces the pattern: 13th character 1-9 or A-Z, 14th Z", () => {
    expect(isValidGstin(makeGstin("29AAXFT1811B0Z"))).toBe(false); // entity number 0
    expect(isValidGstin(makeGstin("29AAXFT1811B1Y"))).toBe(false); // 14th not Z
    expect(isValidGstin(makeGstin("29AAXFT1811BAZ"))).toBe(true); // entity number A
    expect(isValidGstin(makeGstin("2AAAXFT1811B1Z"))).toBe(false); // state code not 2 digits
    expect(isValidGstin(makeGstin("29AAXF91811B1Z"))).toBe(false); // embedded PAN malformed
  });

  it("rejects a GSTIN whose state code isn't in the table, even with a correct check character", () => {
    const g = makeGstin("00AAXFT1811B1Z");
    const r = validateGstin(g);
    expect(r).toEqual({ ok: false, error: "This GSTIN starts with 00, which isn't an Indian GST state code." });
    expect(isValidGstin(makeGstin("39AAXFT1811B1Z"))).toBe(false);
    expect(isValidGstin(makeGstin("98AAXFT1811B1Z"))).toBe(false);
  });

  it("accepts valid GSTINs from other states, including 97 and 99", () => {
    for (const code of ["01", "07", "27", "33", "36", "37", "38", "97", "99"]) {
      const g = makeGstin(`${code}AABCU9603R1Z`);
      expect(validateGstin(g)).toMatchObject({ ok: true, stateCode: code, stateName: STATE_CODES[code], pan: "AABCU9603R" });
    }
  });

  it("deriveFromGstin returns the parts, or null when invalid", () => {
    expect(deriveFromGstin(TAXWISE_GSTIN)).toEqual({ stateCode: "29", stateName: "Karnataka", pan: "AAXFT1811B" });
    expect(deriveFromGstin("29AAXFT1811B1Z4")).toBeNull();
    expect(deriveFromGstin("")).toBeNull();
  });

  it("gstinPanMismatch enforces characters 3–12 = PAN (§5.3)", () => {
    expect(gstinPanMismatch(TAXWISE_GSTIN, "AAXFT1811B")).toBeNull();
    expect(gstinPanMismatch(TAXWISE_GSTIN, "aaxft1811b")).toBeNull();
    expect(gstinPanMismatch(TAXWISE_GSTIN, "AAXFT1811C")).toBe(
      "The GSTIN contains the PAN AAXFT1811B, which doesn't match the PAN entered (AAXFT1811C).",
    );
    expect(gstinPanMismatch(null, "AAXFT1811B")).toBeNull();
    expect(gstinPanMismatch(TAXWISE_GSTIN, "")).toBeNull();
  });
});

describe("state codes (§6.2)", () => {
  it("has every code the spec lists", () => {
    const expected = [
      ...Array.from({ length: 38 }, (_, i) => String(i + 1).padStart(2, "0")),
      "97",
      "99",
    ];
    expect(Object.keys(STATE_CODES).sort()).toEqual(expected);
  });

  it("names the codes as the spec does", () => {
    expect(stateName("29")).toBe("Karnataka");
    expect(stateName("01")).toBe("Jammu & Kashmir");
    expect(stateName("25")).toBe("Daman & Diu (legacy)");
    expect(stateName("26")).toBe("Dadra & Nagar Haveli and Daman & Diu");
    expect(stateName("28")).toBe("Andhra Pradesh (old)");
    expect(stateName("37")).toBe("Andhra Pradesh");
    expect(stateName("38")).toBe("Ladakh");
    expect(stateName("97")).toBe("Other Territory");
    expect(stateName("99")).toBe("Centre Jurisdiction");
    expect(stateName("00")).toBeNull();
    expect(stateName("29 ")).toBeNull();
  });

  it("isValidStateCode", () => {
    expect(isValidStateCode("29")).toBe(true);
    expect(isValidStateCode("40")).toBe(false);
    expect(isValidStateCode("toString")).toBe(false);
  });

  it("stateOptions hides legacy codes unless asked", () => {
    const current = stateOptions();
    expect(current.map((s) => s.code)).not.toContain("25");
    expect(current.map((s) => s.code)).not.toContain("28");
    expect(current).toHaveLength(38);
    expect(current[0]).toEqual({ code: "01", name: "Jammu & Kashmir", legacy: false });
    const all = stateOptions({ includeLegacy: true });
    expect(all).toHaveLength(40);
    expect(all.find((s) => s.code === "28")?.legacy).toBe(true);
  });

  it("formatStateWithCode prints name and code", () => {
    expect(formatStateWithCode("29")).toBe("Karnataka (29)");
    expect(formatStateWithCode("00")).toBe("00");
  });
});

describe("PAN (§6.2)", () => {
  it("accepts a valid PAN and reads the holder type", () => {
    expect(validatePan("aaxft1811b")).toEqual({ ok: true, value: "AAXFT1811B", holderType: "F", holderLabel: "Firm/LLP" });
    expect(isValidPan("ABCPK1234L")).toBe(true);
  });

  it("knows every holder type in the spec table", () => {
    expect(PAN_HOLDER_TYPES).toEqual({
      P: "Individual",
      C: "Company",
      H: "HUF",
      F: "Firm/LLP",
      A: "AOP",
      T: "Trust",
      B: "BOI",
      L: "Local authority",
      J: "Artificial juridical person",
      G: "Government",
    });
    for (const [c, label] of Object.entries(PAN_HOLDER_TYPES)) {
      const r = validatePan(`ABC${c}K1234L`);
      expect(r).toMatchObject({ ok: true, holderType: c, holderLabel: label });
      expect(r.ok && r.warning).toBeFalsy();
    }
  });

  it("rejects malformed PANs", () => {
    expect(validatePan("")).toEqual({ ok: false, error: "Enter the PAN." });
    expect(validatePan("ABCPK1234")).toEqual({ ok: false, error: "A PAN has 10 characters; this one has 9." });
    for (const bad of ["1BCPK1234L", "ABCPK12345", "ABCPKX234L", "ABCPK1234-"]) {
      expect(isValidPan(bad), bad).toBe(false);
    }
  });

  it("accepts but warns when the 4th character is not a known holder type", () => {
    const r = validatePan("ABCXK1234L");
    expect(r).toMatchObject({ ok: true, holderType: null, holderLabel: null });
    expect(r.ok && r.warning).toContain("X isn't one of them");
  });

  it("warns (doesn't block) when the holder type disagrees with the entity type", () => {
    const r = validatePan("AAXFT1811B", { entityType: "pvt_ltd" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.warning).toBe(
      "This PAN belongs to a Firm/LLP (4th character F), but the client is a private limited company, which normally has C (Company). Check the PAN or the entity type.",
    );
  });

  it("does not warn when the holder type fits the entity type", () => {
    const fits: Array<[string, (typeof ENTITY_TYPES)[number]]> = [
      ["ABCCK1234L", "pvt_ltd"],
      ["ABCCK1234L", "public_ltd"],
      ["ABCCK1234L", "section_8"],
      ["ABCFK1234L", "partnership"],
      ["ABCFK1234L", "llp"],
      ["ABCPK1234L", "individual"],
      ["ABCPK1234L", "proprietorship"],
      ["ABCHK1234L", "huf"],
      ["ABCTK1234L", "trust"],
      ["ABCAK1234L", "aop"],
      ["ABCBK1234L", "aop"],
      ["ABCGK1234L", "other"],
    ];
    for (const [pan, entityType] of fits) {
      const r = validatePan(pan, { entityType });
      expect(r.ok && r.warning, `${pan} ${entityType}`).toBeFalsy();
    }
  });

  it("warns for each mismatching entity type", () => {
    for (const entityType of ENTITY_TYPES) {
      const expected = EXPECTED_PAN_HOLDER[entityType];
      if (!expected) {
        expect(panEntityMismatch("C", entityType)).toBeNull();
        continue;
      }
      const wrong = (Object.keys(PAN_HOLDER_TYPES) as Array<keyof typeof PAN_HOLDER_TYPES>).find((c) => !expected.includes(c))!;
      expect(panEntityMismatch(wrong, entityType), entityType).toMatch(/Check the PAN or the entity type\.$/);
    }
  });

  it("covers every entity type in the expectation table", () => {
    expect(Object.keys(EXPECTED_PAN_HOLDER).sort()).toEqual([...ENTITY_TYPES].sort());
  });
});

describe("TAN (§6.2)", () => {
  it("accepts 4 letters, 5 digits, 1 letter", () => {
    expect(validateTan(" blrt12345a ")).toEqual({ ok: true, value: "BLRT12345A" });
  });
  it("rejects anything else", () => {
    expect(validateTan("")).toEqual({ ok: false, error: "Enter the TAN." });
    expect(validateTan("BLR12345A").ok).toBe(false);
    for (const bad of ["BLR912345A", "BLRT1234AA", "BLRT123456", "1LRT12345A"]) expect(isValidTan(bad), bad).toBe(false);
  });
});

describe("IFSC (§6.2)", () => {
  it("accepts a valid IFSC and names the bank", () => {
    expect(validateIfsc("hdfc0001234")).toEqual({ ok: true, value: "HDFC0001234", bankCode: "HDFC", bankName: "HDFC Bank" });
    expect(validateIfsc("SBIN0040123")).toMatchObject({ ok: true, bankName: "State Bank of India" });
    expect(validateIfsc("UTIB0000123")).toMatchObject({ ok: true, bankName: "Axis Bank" });
    expect(validateIfsc("KARB0000001")).toMatchObject({ ok: true, bankName: "Karnataka Bank" });
  });

  it("is still valid for a bank not in the table", () => {
    expect(validateIfsc("ZZZZ0ABC123")).toEqual({ ok: true, value: "ZZZZ0ABC123", bankCode: "ZZZZ", bankName: null });
  });

  it("names merged banks with their successor", () => {
    expect(bankFromIfsc("VIJB0001234")).toBe("Vijaya Bank (now Bank of Baroda)");
    expect(bankFromIfsc("corp0000123")).toBe("Corporation Bank (now Union Bank of India)");
    expect(bankFromIfsc("XXXX0000000")).toBeNull();
  });

  it("requires the 5th character to be zero and 11 characters", () => {
    expect(isValidIfsc("HDFC1001234")).toBe(false);
    expect(isValidIfsc("HDF00001234")).toBe(false);
    expect(validateIfsc("HDFC000123")).toEqual({ ok: false, error: "An IFSC has 11 characters; this one has 10." });
    expect(validateIfsc("")).toEqual({ ok: false, error: "Enter the IFSC." });
  });
});

describe("pincode (§6.2)", () => {
  it("accepts six digits not starting with 0", () => {
    expect(validatePincode(" 560001 ")).toEqual({ ok: true, value: "560001" });
    expect(isValidPincode("110001")).toBe(true);
  });
  it("rejects a leading zero, wrong length and letters", () => {
    expect(validatePincode("060001")).toEqual({ ok: false, error: "A pincode can't start with 0." });
    expect(validatePincode("56001")).toEqual({ ok: false, error: "A pincode has 6 digits." });
    expect(validatePincode("5600011")).toEqual({ ok: false, error: "A pincode has 6 digits." });
    expect(validatePincode("56000A")).toEqual({ ok: false, error: "A pincode has 6 digits." });
    expect(validatePincode("")).toEqual({ ok: false, error: "Enter the pincode." });
  });
});

describe("CIN (§6.2)", () => {
  it("accepts a 21-character CIN and reads its parts", () => {
    expect(validateCin("u74999ka2020ptc123456")).toEqual({
      ok: true,
      value: "U74999KA2020PTC123456",
      listed: false,
      stateAbbr: "KA",
      year: 2020,
      ownership: "PTC",
    });
    expect(validateCin("L65920MH1994PLC080618")).toMatchObject({ ok: true, listed: true, ownership: "PLC" });
  });
  it("rejects malformed CINs", () => {
    expect(validateCin("")).toEqual({ ok: false, error: "Enter the CIN." });
    expect(validateCin("U74999KA2020PTC12345")).toEqual({ ok: false, error: "A CIN has 21 characters; this one has 20." });
    for (const bad of ["X74999KA2020PTC123456", "U7499AKA2020PTC123456", "U749991A2020PTC123456", "U74999KA20A0PTC123456", "U74999KA2020P1C123456"]) {
      expect(isValidCin(bad), bad).toBe(false);
    }
  });
});

describe("LLPIN (§6.2)", () => {
  it("accepts AAA-1234 and restores a missing hyphen", () => {
    expect(validateLlpin("AAB-1234")).toEqual({ ok: true, value: "AAB-1234" });
    expect(validateLlpin(" aab1234 ")).toEqual({ ok: true, value: "AAB-1234" });
  });
  it("rejects anything else", () => {
    for (const bad of ["AA-1234", "AAB-123", "AAB_1234", "1AB-1234", "AAB-12345"]) expect(isValidLlpin(bad), bad).toBe(false);
    expect(validateLlpin("")).toEqual({ ok: false, error: "Enter the LLPIN." });
  });
});

describe("DIN (§6.2)", () => {
  it("accepts 8 digits", () => {
    expect(validateDin("01234567")).toEqual({ ok: true, value: "01234567" });
  });
  it("rejects anything else", () => {
    expect(validateDin("1234567")).toEqual({ ok: false, error: "A DIN has 8 digits." });
    expect(isValidDin("123456789")).toBe(false);
    expect(isValidDin("1234567A")).toBe(false);
    expect(validateDin("")).toEqual({ ok: false, error: "Enter the DIN." });
  });
});

describe("UDIN (§6.2)", () => {
  const UDIN = "26234567ABCDE12345";

  it("accepts 18 characters and stores upper case", () => {
    expect(validateUdin(UDIN.toLowerCase())).toEqual({ ok: true, value: UDIN, yearDigits: "26", membershipNo: "234567" });
    expect(isValidUdin(UDIN)).toBe(true);
  });

  it("rejects the wrong length or shape", () => {
    expect(validateUdin(UDIN.slice(0, 17))).toEqual({ ok: false, error: "A UDIN has 18 characters; this one has 17." });
    expect(isValidUdin("2A234567ABCDE12345")).toBe(false); // year not digits
    expect(isValidUdin("2623456AABCDE12345")).toBe(false); // membership not 6 digits
    expect(isValidUdin("26234567ABCDE1234-")).toBe(false); // last 10 alphanumeric
    expect(validateUdin("")).toEqual({ ok: false, error: "Enter the UDIN." });
  });

  it("warns when characters 3–8 aren't the signing partner's membership number", () => {
    const r = validateUdin(UDIN, { membershipNo: "234568" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.warning).toBe(
      "This UDIN carries membership number 234567, but the signing partner's is 234568. Check the UDIN or the signing partner.",
    );
  });

  it("does not warn when they match, padding short membership numbers", () => {
    expect(validateUdin(UDIN, { membershipNo: "234567" })).not.toHaveProperty("warning");
    expect(validateUdin("26012345ABCDE12345", { membershipNo: "12345" })).not.toHaveProperty("warning");
    expect(validateUdin(UDIN, { membershipNo: null })).not.toHaveProperty("warning");
  });

  it("normaliseMembershipNo", () => {
    expect(normaliseMembershipNo("12345")).toBe("012345");
    expect(normaliseMembershipNo("234567")).toBe("234567");
    expect(normaliseMembershipNo("1234567")).toBeNull();
    expect(normaliseMembershipNo("12A45")).toBeNull();
  });
});

describe("Aadhaar (§6.2, §6.10)", () => {
  it("detects a full 12-digit number in any common layout", () => {
    for (const text of ["234567890123", "2345 6789 0123", "2345-6789-0123", "2345 6789-0123", "Aadhaar: 9876 5432 1098, verified"]) {
      expect(containsFullAadhaar(text), text).toBe(true);
    }
  });

  it("does not flag things that aren't an Aadhaar number", () => {
    for (const text of ["1234", "XXXX XXXX 1234", "123456789012", "023456789012", "2345678901234", "12345678901234567", "PAN AAXFT1811B"]) {
      expect(containsFullAadhaar(text), text).toBe(false);
    }
  });

  it("validateAadhaarLast4 keeps only the last 4 digits", () => {
    expect(validateAadhaarLast4(" 1234 ")).toEqual({ ok: true, value: "1234" });
  });

  it("refuses a full number with the reason", () => {
    expect(validateAadhaarLast4("2345 6789 0123")).toEqual({ ok: false, error: AADHAAR_FULL_NUMBER_ERROR });
    expect(AADHAAR_FULL_NUMBER_ERROR).toContain("last 4 digits");
  });

  it("refuses anything that isn't four digits", () => {
    expect(validateAadhaarLast4("")).toEqual({ ok: false, error: "Enter the last 4 digits of the Aadhaar number." });
    expect(validateAadhaarLast4("12345")).toEqual({ ok: false, error: "Enter only the last 4 digits of the Aadhaar number." });
    expect(validateAadhaarLast4("12a4").ok).toBe(false);
  });

  it("masks for display", () => {
    expect(maskAadhaarLast4("1234")).toBe("XXXX XXXX 1234");
  });
});
