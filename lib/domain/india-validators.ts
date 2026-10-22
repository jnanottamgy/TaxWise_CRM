/**
 * Indian identifiers: GSTIN, PAN, TAN, IFSC, pincode, CIN, LLPIN, DIN, UDIN and Aadhaar (§6.2, §6.10).
 *
 * Every validator takes what the user typed, normalises it (trims, removes spaces, upper-cases) and
 * returns a discriminated result: `{ ok: true, value, ... }` with the normalised value to store, or
 * `{ ok: false, error }` with one plain sentence for the field. Warnings never block (`warning`).
 *
 * Pure and client-safe: forms use these for inline validation, actions use them again on the server.
 */

import type { EntityType } from "@/lib/domain/enums";

/** A failed validation: one plain sentence to show at the field. */
export type InvalidId = { ok: false; error: string };

/** Upper-cases and strips every whitespace character (people paste "29AAXFT 1811B1Z3"). */
export function normaliseIdentifier(input: string): string {
  return input.replace(/\s+/g, "").toUpperCase();
}

function invalid(error: string): InvalidId {
  return { ok: false, error };
}

// -------------------------------------------------------------------------------------------------
// States (§6.2)
// -------------------------------------------------------------------------------------------------

/** GST state codes and names (§6.2). Names follow the spec; "J&K" is written out. */
export const STATE_CODES: Readonly<Record<string, string>> = {
  "01": "Jammu & Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "25": "Daman & Diu (legacy)",
  "26": "Dadra & Nagar Haveli and Daman & Diu",
  "27": "Maharashtra",
  "28": "Andhra Pradesh (old)",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman & Nicobar",
  "36": "Telangana",
  "37": "Andhra Pradesh",
  "38": "Ladakh",
  "97": "Other Territory",
  "99": "Centre Jurisdiction",
};

/** Codes that exist for old registrations only: show them, but don't offer them for new clients. */
export const LEGACY_STATE_CODES: readonly string[] = ["25", "28"];

export type StateOption = { code: string; name: string; legacy: boolean };

/** The state list for a place-of-supply select, in code order (§6.2). */
export function stateOptions(opts: { includeLegacy?: boolean } = {}): StateOption[] {
  return Object.keys(STATE_CODES)
    .sort()
    .map((code) => ({ code, name: STATE_CODES[code], legacy: LEGACY_STATE_CODES.includes(code) }))
    .filter((s) => opts.includeLegacy || !s.legacy);
}

/** True for a two-digit code in the §6.2 table. */
export function isValidStateCode(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(STATE_CODES, code);
}

/** The state's name for a GST state code, or null when the code isn't in the table. */
export function stateName(code: string): string | null {
  return isValidStateCode(code) ? STATE_CODES[code] : null;
}

/** "Karnataka (29)": how a place of supply is printed on an invoice (§6.4). */
export function formatStateWithCode(code: string): string {
  const name = stateName(code);
  return name ? `${name} (${code})` : code;
}

// -------------------------------------------------------------------------------------------------
// GSTIN (§6.2)
// -------------------------------------------------------------------------------------------------

export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const GSTIN_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * The GSTIN check character (§6.2): Luhn mod 36 over the first 14 characters with the alphabet
 * `0-9A-Z`. Factor 1 on even positions and 2 on odd (0-based); each product p adds
 * `floor(p/36) + p%36`; the check is `(36 − sum%36) % 36`. Returns null if a character is outside
 * the alphabet or fewer than 14 characters are given.
 */
export function gstinCheckCharacter(first14: string): string | null {
  if (first14.length < 14) return null;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GSTIN_ALPHABET.indexOf(first14[i]);
    if (v < 0) return null;
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return GSTIN_ALPHABET[(36 - (sum % 36)) % 36];
}

export type GstinParts = { stateCode: string; stateName: string; pan: string };
export type GstinResult = ({ ok: true; value: string } & GstinParts) | InvalidId;

/**
 * Validates a GSTIN (§6.2): the pattern, a known state code and the check character. On success it
 * returns the derived state and PAN (characters 3–12), shown as soon as a valid GSTIN is typed.
 */
export function validateGstin(input: string): GstinResult {
  const value = normaliseIdentifier(input);
  if (value === "") return invalid("Enter the GSTIN.");
  if (value.length !== 15) return invalid(`A GSTIN has 15 characters; this one has ${value.length}.`);
  if (!GSTIN_PATTERN.test(value)) {
    return invalid("This isn't a valid GSTIN. It should look like 29AAXFT1811B1Z3: state code, PAN, entity number, Z, check character.");
  }
  const stateCode = value.slice(0, 2);
  const name = stateName(stateCode);
  if (!name) return invalid(`This GSTIN starts with ${stateCode}, which isn't an Indian GST state code.`);
  if (gstinCheckCharacter(value) !== value[14]) {
    return invalid("This GSTIN's check character doesn't match. Check it for a typing mistake.");
  }
  return { ok: true, value, stateCode, stateName: name, pan: value.slice(2, 12) };
}

/** True when the GSTIN is valid (§6.2). */
export function isValidGstin(input: string): boolean {
  return validateGstin(input).ok;
}

/** State code, state name and PAN from a valid GSTIN; null when the GSTIN isn't valid (§6.2). */
export function deriveFromGstin(input: string): GstinParts | null {
  const r = validateGstin(input);
  return r.ok ? { stateCode: r.stateCode, stateName: r.stateName, pan: r.pan } : null;
}

/**
 * The §5.3 rule: when both are present, characters 3–12 of the GSTIN must equal the PAN.
 * Returns null when they agree (or either is missing), otherwise the sentence to show.
 */
export function gstinPanMismatch(gstin: string | null | undefined, pan: string | null | undefined): string | null {
  if (!gstin || !pan) return null;
  const g = normaliseIdentifier(gstin);
  const p = normaliseIdentifier(pan);
  if (g.length < 12) return null;
  const embedded = g.slice(2, 12);
  return embedded === p ? null : `The GSTIN contains the PAN ${embedded}, which doesn't match the PAN entered (${p}).`;
}

// -------------------------------------------------------------------------------------------------
// PAN (§6.2)
// -------------------------------------------------------------------------------------------------

export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/** The PAN's 4th character: who holds it (§6.2). */
export const PAN_HOLDER_TYPES = {
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
} as const;
export type PanHolderType = keyof typeof PAN_HOLDER_TYPES;

/**
 * The PAN holder types each entity type normally has. `other` has no expectation. A proprietorship's
 * PAN is the proprietor's own (P). AOP also accepts B, since BOI has no entity type of its own.
 */
export const EXPECTED_PAN_HOLDER: Readonly<Record<EntityType, readonly PanHolderType[] | null>> = {
  proprietorship: ["P"],
  individual: ["P"],
  partnership: ["F"],
  llp: ["F"],
  pvt_ltd: ["C"],
  public_ltd: ["C"],
  section_8: ["C"],
  trust: ["T"],
  aop: ["A", "B"],
  huf: ["H"],
  other: null,
};

const ENTITY_WORDS: Readonly<Record<EntityType, string>> = {
  proprietorship: "a sole proprietorship",
  individual: "an individual",
  partnership: "a partnership firm",
  llp: "an LLP",
  pvt_ltd: "a private limited company",
  public_ltd: "a public company",
  section_8: "a Section 8 company",
  trust: "a trust",
  aop: "an AOP",
  huf: "an HUF",
  other: "other",
};

function isHolderType(c: string): c is PanHolderType {
  return Object.prototype.hasOwnProperty.call(PAN_HOLDER_TYPES, c);
}

export type PanResult =
  | {
      ok: true;
      value: string;
      /** From the 4th character; null when that character isn't in the §6.2 table. */
      holderType: PanHolderType | null;
      holderLabel: string | null;
      warning?: string;
    }
  | InvalidId;

/**
 * Validates a PAN (§6.2) and reads the holder type from its 4th character. Warnings never block:
 * - the 4th character isn't a known holder type;
 * - `entityType` is given and disagrees (e.g. a private limited company whose PAN isn't a C).
 */
export function validatePan(input: string, opts: { entityType?: EntityType | null } = {}): PanResult {
  const value = normaliseIdentifier(input);
  if (value === "") return invalid("Enter the PAN.");
  if (value.length !== 10) return invalid(`A PAN has 10 characters; this one has ${value.length}.`);
  if (!PAN_PATTERN.test(value)) return invalid("This isn't a valid PAN. It should look like AAXFT1811B: 5 letters, 4 digits, 1 letter.");
  const fourth = value[3];
  if (!isHolderType(fourth)) {
    return {
      ok: true,
      value,
      holderType: null,
      holderLabel: null,
      warning: `The 4th character of a PAN shows who holds it (P, C, H, F, A, T, B, L, J or G); ${fourth} isn't one of them. Check the PAN.`,
    };
  }
  const result: PanResult = { ok: true, value, holderType: fourth, holderLabel: PAN_HOLDER_TYPES[fourth] };
  const warning = opts.entityType ? panEntityMismatch(fourth, opts.entityType) : null;
  return warning ? { ...result, warning } : result;
}

/** True when the PAN is valid (§6.2). */
export function isValidPan(input: string): boolean {
  return validatePan(input).ok;
}

/**
 * The warning for a PAN whose holder type disagrees with the chosen entity type (§6.2), or null.
 */
export function panEntityMismatch(holderType: PanHolderType, entityType: EntityType): string | null {
  const expected = EXPECTED_PAN_HOLDER[entityType];
  if (!expected || expected.includes(holderType)) return null;
  const want = expected.map((c) => `${c} (${PAN_HOLDER_TYPES[c]})`).join(" or ");
  return `This PAN belongs to a ${PAN_HOLDER_TYPES[holderType]} (4th character ${holderType}), but the client is ${ENTITY_WORDS[entityType]}, which normally has ${want}. Check the PAN or the entity type.`;
}

// -------------------------------------------------------------------------------------------------
// TAN, IFSC, pincode (§6.2)
// -------------------------------------------------------------------------------------------------

export const TAN_PATTERN = /^[A-Z]{4}[0-9]{5}[A-Z]$/;

export type SimpleIdResult = { ok: true; value: string } | InvalidId;

/** Validates a TAN (§6.2): 4 letters, 5 digits, 1 letter. */
export function validateTan(input: string): SimpleIdResult {
  const value = normaliseIdentifier(input);
  if (value === "") return invalid("Enter the TAN.");
  if (value.length !== 10) return invalid(`A TAN has 10 characters; this one has ${value.length}.`);
  if (!TAN_PATTERN.test(value)) return invalid("This isn't a valid TAN. It should look like BLRT12345A: 4 letters, 5 digits, 1 letter.");
  return { ok: true, value };
}

/** True when the TAN is valid (§6.2). */
export function isValidTan(input: string): boolean {
  return validateTan(input).ok;
}

export const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;

/**
 * Bank names by the first four letters of the IFSC (§6.2): the major Indian banks, plus the codes of
 * banks merged since 2019 that still appear on old cheques and statements.
 */
export const IFSC_BANKS: Readonly<Record<string, string>> = {
  // Public sector
  SBIN: "State Bank of India",
  PUNB: "Punjab National Bank",
  BARB: "Bank of Baroda",
  CNRB: "Canara Bank",
  UBIN: "Union Bank of India",
  BKID: "Bank of India",
  IDIB: "Indian Bank",
  CBIN: "Central Bank of India",
  IOBA: "Indian Overseas Bank",
  UCBA: "UCO Bank",
  MAHB: "Bank of Maharashtra",
  PSIB: "Punjab & Sind Bank",
  IBKL: "IDBI Bank",
  // Private sector
  HDFC: "HDFC Bank",
  ICIC: "ICICI Bank",
  UTIB: "Axis Bank",
  KKBK: "Kotak Mahindra Bank",
  INDB: "IndusInd Bank",
  YESB: "Yes Bank",
  IDFB: "IDFC FIRST Bank",
  FDRL: "Federal Bank",
  RATN: "RBL Bank",
  BDBL: "Bandhan Bank",
  KARB: "Karnataka Bank",
  KVBL: "Karur Vysya Bank",
  CIUB: "City Union Bank",
  SIBL: "South Indian Bank",
  TMBL: "Tamilnad Mercantile Bank",
  DLXB: "Dhanlaxmi Bank",
  CSBK: "CSB Bank",
  JAKA: "Jammu & Kashmir Bank",
  DCBL: "DCB Bank",
  // Small finance and payments banks
  AUBL: "AU Small Finance Bank",
  ESFB: "Equitas Small Finance Bank",
  UJVN: "Ujjivan Small Finance Bank",
  JSFB: "Jana Small Finance Bank",
  SURY: "Suryoday Small Finance Bank",
  IPOS: "India Post Payments Bank",
  AIRP: "Airtel Payments Bank",
  PYTM: "Paytm Payments Bank",
  FINO: "Fino Payments Bank",
  // Foreign banks
  SCBL: "Standard Chartered Bank",
  HSBC: "HSBC",
  CITI: "Citibank",
  DBSS: "DBS Bank India",
  DEUT: "Deutsche Bank",
  // Co-operative and regional rural banks common in Karnataka and Maharashtra
  SVCB: "SVC Co-operative Bank",
  SRCB: "Saraswat Co-operative Bank",
  COSB: "Cosmos Co-operative Bank",
  TJSB: "TJSB Sahakari Bank",
  NKGS: "NKGSB Co-operative Bank",
  KVGB: "Karnataka Vikas Grameena Bank",
  PKGB: "Karnataka Gramin Bank",
  // Merged banks (legacy codes)
  ANDB: "Andhra Bank (now Union Bank of India)",
  CORP: "Corporation Bank (now Union Bank of India)",
  VIJB: "Vijaya Bank (now Bank of Baroda)",
  BKDN: "Dena Bank (now Bank of Baroda)",
  ORBC: "Oriental Bank of Commerce (now Punjab National Bank)",
  UTBI: "United Bank of India (now Punjab National Bank)",
  ALLA: "Allahabad Bank (now Indian Bank)",
  SYNB: "Syndicate Bank (now Canara Bank)",
  LAVB: "Lakshmi Vilas Bank (now DBS Bank India)",
};

/** The bank's name from an IFSC's first four letters, or null when it isn't in the table. */
export function bankFromIfsc(ifsc: string): string | null {
  const code = normaliseIdentifier(ifsc).slice(0, 4);
  return Object.prototype.hasOwnProperty.call(IFSC_BANKS, code) ? IFSC_BANKS[code] : null;
}

export type IfscResult = { ok: true; value: string; bankCode: string; bankName: string | null } | InvalidId;

/**
 * Validates an IFSC (§6.2): 4 letters, a zero, then 6 letters or digits. On success it names the
 * bank when the first four letters are a known bank (`bankName` is null otherwise; still valid).
 */
export function validateIfsc(input: string): IfscResult {
  const value = normaliseIdentifier(input);
  if (value === "") return invalid("Enter the IFSC.");
  if (value.length !== 11) return invalid(`An IFSC has 11 characters; this one has ${value.length}.`);
  if (!IFSC_PATTERN.test(value)) {
    return invalid("This isn't a valid IFSC. It should look like HDFC0001234: 4 letters, a zero, then 6 letters or digits.");
  }
  return { ok: true, value, bankCode: value.slice(0, 4), bankName: bankFromIfsc(value) };
}

/** True when the IFSC is valid (§6.2). */
export function isValidIfsc(input: string): boolean {
  return validateIfsc(input).ok;
}

export const PINCODE_PATTERN = /^[1-9][0-9]{5}$/;

/** Validates an Indian pincode (§6.2): six digits, not starting with 0. */
export function validatePincode(input: string): SimpleIdResult {
  const value = input.replace(/\s+/g, "");
  if (value === "") return invalid("Enter the pincode.");
  if (!/^[0-9]+$/.test(value) || value.length !== 6) return invalid("A pincode has 6 digits.");
  if (!PINCODE_PATTERN.test(value)) return invalid("A pincode can't start with 0.");
  return { ok: true, value };
}

/** True when the pincode is valid (§6.2). */
export function isValidPincode(input: string): boolean {
  return validatePincode(input).ok;
}

// -------------------------------------------------------------------------------------------------
// CIN, LLPIN, DIN (§6.2)
// -------------------------------------------------------------------------------------------------

export const CIN_PATTERN = /^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/;

export type CinResult =
  | {
      ok: true;
      value: string;
      /** L = listed, U = unlisted. */
      listed: boolean;
      /** Two-letter state of the registrar, e.g. KA. */
      stateAbbr: string;
      /** Year of incorporation. */
      year: number;
      /** Ownership class, e.g. PTC (private), PLC (public), OPC, NPL (Section 8). */
      ownership: string;
    }
  | InvalidId;

/** Validates a company CIN (§6.2): 21 characters, `L/U + 5 digits + state + year + class + 6 digits`. */
export function validateCin(input: string): CinResult {
  const value = normaliseIdentifier(input);
  if (value === "") return invalid("Enter the CIN.");
  if (value.length !== 21) return invalid(`A CIN has 21 characters; this one has ${value.length}.`);
  if (!CIN_PATTERN.test(value)) return invalid("This isn't a valid CIN. It should look like U74999KA2020PTC123456.");
  return {
    ok: true,
    value,
    listed: value[0] === "L",
    stateAbbr: value.slice(6, 8),
    year: Number(value.slice(8, 12)),
    ownership: value.slice(12, 15),
  };
}

/** True when the CIN is valid (§6.2). */
export function isValidCin(input: string): boolean {
  return validateCin(input).ok;
}

export const LLPIN_PATTERN = /^[A-Z]{3}-[0-9]{4}$/;

/** Validates an LLPIN (§6.2): `AAA-1234`. A missing hyphen is put back (`AAB1234` → `AAB-1234`). */
export function validateLlpin(input: string): SimpleIdResult {
  let value = normaliseIdentifier(input);
  if (value === "") return invalid("Enter the LLPIN.");
  if (/^[A-Z]{3}[0-9]{4}$/.test(value)) value = `${value.slice(0, 3)}-${value.slice(3)}`;
  if (!LLPIN_PATTERN.test(value)) return invalid("This isn't a valid LLPIN. It should look like AAB-1234: 3 letters, a hyphen, 4 digits.");
  return { ok: true, value };
}

/** True when the LLPIN is valid (§6.2). */
export function isValidLlpin(input: string): boolean {
  return validateLlpin(input).ok;
}

export const DIN_PATTERN = /^[0-9]{8}$/;

/** Validates a Director Identification Number (§6.2): 8 digits. */
export function validateDin(input: string): SimpleIdResult {
  const value = input.replace(/\s+/g, "");
  if (value === "") return invalid("Enter the DIN.");
  if (!DIN_PATTERN.test(value)) return invalid("A DIN has 8 digits.");
  return { ok: true, value };
}

/** True when the DIN is valid (§6.2). */
export function isValidDin(input: string): boolean {
  return validateDin(input).ok;
}

// -------------------------------------------------------------------------------------------------
// UDIN (§6.2) [verify]
// -------------------------------------------------------------------------------------------------

export const UDIN_PATTERN = /^[0-9]{2}[0-9]{6}[A-Z0-9]{10}$/;

export type UdinResult =
  | {
      ok: true;
      /** Upper-cased, as stored. */
      value: string;
      /** The 2-digit year at the start, e.g. "26". */
      yearDigits: string;
      /** Characters 3–8: the signing member's membership number. */
      membershipNo: string;
      warning?: string;
    }
  | InvalidId;

/** An ICAI membership number as six digits (leading zeros kept), or null if it isn't 1–6 digits. */
export function normaliseMembershipNo(input: string): string | null {
  const digits = input.replace(/\s+/g, "");
  if (!/^[0-9]{1,6}$/.test(digits)) return null;
  return digits.padStart(6, "0");
}

/**
 * Validates a UDIN (§6.2): 18 characters, stored upper-case: 2-digit year, the signing member's
 * 6-digit membership number, then 10 letters or digits. When `membershipNo` is given (the signing
 * partner's) and characters 3–8 differ, it adds a `warning` [verify]; the UDIN is still accepted.
 */
export function validateUdin(input: string, opts: { membershipNo?: string | null } = {}): UdinResult {
  const value = normaliseIdentifier(input);
  if (value === "") return invalid("Enter the UDIN.");
  if (value.length !== 18) return invalid(`A UDIN has 18 characters; this one has ${value.length}.`);
  if (!UDIN_PATTERN.test(value)) {
    return invalid("This isn't a valid UDIN. It should be the 2-digit year, the 6-digit membership number, then 10 letters or digits.");
  }
  const membershipNo = value.slice(2, 8);
  const result: UdinResult = { ok: true, value, yearDigits: value.slice(0, 2), membershipNo };
  if (opts.membershipNo) {
    const expected = normaliseMembershipNo(opts.membershipNo);
    if (expected && expected !== membershipNo) {
      return {
        ...result,
        warning: `This UDIN carries membership number ${membershipNo}, but the signing partner's is ${expected}. Check the UDIN or the signing partner.`,
      };
    }
  }
  return result;
}

/** True when the UDIN is valid (§6.2). */
export function isValidUdin(input: string): boolean {
  return validateUdin(input).ok;
}

// -------------------------------------------------------------------------------------------------
// Aadhaar (§6.2, §6.10): never stored in full
// -------------------------------------------------------------------------------------------------

/**
 * A full Aadhaar number anywhere in the text: 12 digits (first digit 2–9), written together or in
 * 4-4-4 groups separated by a space or a hyphen, not part of a longer run of digits. Used to refuse
 * input before it is saved (§6.10). Deliberately no checksum test: a mistyped full number is still
 * personal data.
 */
export function containsFullAadhaar(text: string): boolean {
  return /(?:^|[^0-9])[2-9][0-9]{3}[ -]?[0-9]{4}[ -]?[0-9]{4}(?![0-9])/.test(text);
}

export const AADHAAR_FULL_NUMBER_ERROR =
  "Don't enter the full Aadhaar number. Keep only the last 4 digits here, and keep the copy in the confidential document vault.";

/**
 * Validates the only Aadhaar value the app stores: its last 4 digits, as text (§6.2). A full
 * 12-digit number is refused with a sentence that says why.
 */
export function validateAadhaarLast4(input: string): SimpleIdResult {
  const trimmed = input.trim();
  if (trimmed === "") return invalid("Enter the last 4 digits of the Aadhaar number.");
  if (containsFullAadhaar(trimmed)) return invalid(AADHAAR_FULL_NUMBER_ERROR);
  const digits = trimmed.replace(/[\s-]+/g, "");
  if (!/^[0-9]{4}$/.test(digits)) return invalid("Enter only the last 4 digits of the Aadhaar number.");
  return { ok: true, value: digits };
}

/** How the last four digits are shown: `XXXX XXXX 1234`. */
export function maskAadhaarLast4(last4: string): string {
  return `XXXX XXXX ${last4}`;
}
