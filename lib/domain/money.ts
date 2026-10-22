/**
 * Money (§0.1 rule 7, §3.4, §6.3). The database stores `numeric(14,2)`; in TypeScript every amount is
 * converted to integer paise before any arithmetic, rounded half-up, and displayed in Indian grouping
 * (`₹1,23,456.00`) with amounts in words in lakh and crore.
 *
 * Half-up means half away from zero (`2.5 → 3`, `-2.5 → -3`), the same as Postgres `round(numeric)`,
 * so the SQL functions and this module always agree.
 *
 * Pure and client-safe. No floats are used for arithmetic: decimals are parsed from their string form
 * and multiplied as BigInt.
 */

/** An amount in paise. Always a safe integer. */
export type Paise = number;

/** True when `v` is a safe integer (a valid paise amount). */
export function isPaise(v: unknown): v is Paise {
  return typeof v === "number" && Number.isSafeInteger(v);
}

function assertPaise(v: number, what = "amount"): Paise {
  if (!Number.isSafeInteger(v)) throw new RangeError(`The ${what} must be a whole number of paise; got ${v}.`);
  return v;
}

// -------------------------------------------------------------------------------------------------
// Exact decimal parsing and rounding
// -------------------------------------------------------------------------------------------------

type Decimal = { mantissa: bigint; scale: number }; // value = mantissa × 10^(−scale)

const DECIMAL_PATTERN = /^([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

const BIG = (n: number | string): bigint => BigInt(n);
const pow10 = (n: number): bigint => BIG(10) ** BIG(n);

/** Parses a decimal string (or a finite number via its shortest round-trip form) exactly. */
function parseDecimal(value: number | string): Decimal | null {
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    text = String(value);
  } else {
    text = value.trim();
  }
  const m = DECIMAL_PATTERN.exec(text);
  if (!m) return null;
  const [, sign, int = "", frac = "", exp] = m;
  if (int === "" && frac === "") return null;
  let mantissa = BIG(`${int}${frac}` || "0");
  if (sign === "-") mantissa = -mantissa;
  return { mantissa, scale: frac.length - (exp ? Number(exp) : 0) };
}

const ZERO = BIG(0);
const ONE = BIG(1);
const TWO = BIG(2);

/** Integer division rounded half away from zero. */
function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === ZERO) throw new RangeError("Division by zero.");
  const negative = numerator < ZERO !== denominator < ZERO;
  const n = numerator < ZERO ? -numerator : numerator;
  const d = denominator < ZERO ? -denominator : denominator;
  let q = n / d;
  if ((n % d) * TWO >= d) q += ONE;
  return negative ? -q : q;
}

/** Rescales a decimal to `decimals` places, rounding half-up, and returns the scaled integer. */
function rescale(d: Decimal, decimals: number): bigint {
  const shift = decimals - d.scale;
  return shift >= 0 ? d.mantissa * pow10(shift) : divRoundHalfUp(d.mantissa, pow10(-shift));
}

function toSafeNumber(v: bigint, what: string): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new RangeError(`The ${what} is too large.`);
  return n;
}

/**
 * Integer division of two whole numbers, rounded half-up (half away from zero). Use it for every
 * "share of an amount" calculation, e.g. `divideRoundHalfUp(tax, 2)` for a CGST half.
 */
export function divideRoundHalfUp(numerator: number, denominator: number): number {
  assertPaise(numerator, "numerator");
  assertPaise(denominator, "denominator");
  return toSafeNumber(divRoundHalfUp(BIG(numerator), BIG(denominator)), "result");
}

/**
 * Rounds a number or decimal string to `decimals` places, half-up, exactly (no float error:
 * `roundHalfUp(1.005, 2) === 1.01`, where `Math.round(1.005 * 100) / 100` gives 1).
 */
export function roundHalfUp(value: number | string, decimals = 0): number {
  const d = parseDecimal(value);
  if (!d) throw new TypeError(`Not a number: ${String(value)}`);
  const scaled = rescale(d, decimals);
  // Build the decimal string and let Number parse it: the closest double to the exact result.
  return Number(decimalString(scaled, decimals));
}

/** The integer `scaled` (in units of 10^−decimals) written as a plain decimal string. */
function decimalString(scaled: bigint, decimals: number): string {
  const negative = scaled < ZERO;
  const digits = (negative ? -scaled : scaled).toString().padStart(decimals + 1, "0");
  const int = decimals > 0 ? digits.slice(0, -decimals) : digits;
  const frac = decimals > 0 ? `.${digits.slice(-decimals)}` : "";
  return `${negative ? "-" : ""}${int}${frac}`;
}

// -------------------------------------------------------------------------------------------------
// Conversions
// -------------------------------------------------------------------------------------------------

/**
 * Converts rupees to paise exactly. Accepts a number or a decimal string as Postgres returns
 * `numeric` (`"1234.50"`); `₹`, commas and spaces are ignored. More than two decimals are rounded
 * half-up to the paisa. Throws a TypeError for anything that isn't a number.
 */
export function toPaise(value: number | string): Paise {
  const cleaned = typeof value === "string" ? value.replace(/[₹,\s]/g, "") : value;
  const d = parseDecimal(cleaned);
  if (!d) throw new TypeError(`Not an amount: ${String(value)}`);
  return toSafeNumber(rescale(d, 2), "amount");
}

/** `toPaise` for nullable database columns: null and undefined stay null. */
export function toPaiseOrNull(value: number | string | null | undefined): Paise | null {
  return value === null || value === undefined || value === "" ? null : toPaise(value);
}

/** Paise to rupees as a number (`12345 → 123.45`), for charts and JSON. Never compute with it. */
export function fromPaise(paise: Paise): number {
  return Number(paiseToDecimalString(paise));
}

/** Paise as the exact decimal string a `numeric(14,2)` column takes (`12345 → "123.45"`). */
export function paiseToDecimalString(paise: Paise): string {
  assertPaise(paise);
  return decimalString(BIG(paise), 2);
}

export type AmountParse = { ok: true; paise: Paise } | { ok: false; error: string };

/**
 * Parses an amount typed into a form (in rupees). Accepts `12500`, `12,500.50`, `₹ 1,23,456`.
 * Refuses more than two decimal places and, unless `allowNegative`, negative amounts.
 */
export function parseAmount(input: string, opts: { allowNegative?: boolean } = {}): AmountParse {
  const cleaned = input.replace(/[₹,\s]/g, "");
  if (cleaned === "") return { ok: false, error: "Enter an amount." };
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(cleaned)) {
    return { ok: false, error: "Enter the amount in rupees, for example 12,500 or 12500.50." };
  }
  const frac = cleaned.split(".")[1] ?? "";
  if (frac.length > 2) return { ok: false, error: "Use at most 2 decimal places (paise)." };
  const paise = toPaise(cleaned);
  if (paise < 0 && !opts.allowNegative) return { ok: false, error: "The amount can't be negative." };
  return { ok: true, paise: paise === 0 ? 0 : paise };
}

// -------------------------------------------------------------------------------------------------
// Arithmetic
// -------------------------------------------------------------------------------------------------

/**
 * `ratePercent` % of an amount, rounded half-up to the paisa (§6.3, §6.4):
 * `percentOf(100050, 18) === 18009` (₹1,000.50 × 18% = ₹180.09).
 * The rate may be a number or a numeric string (`"18.00"`, `2.5`).
 */
export function percentOf(paise: Paise, ratePercent: number | string): Paise {
  assertPaise(paise);
  const rate = parseDecimal(ratePercent);
  if (!rate) throw new TypeError(`Not a rate: ${String(ratePercent)}`);
  // paise × mantissa × 10^−scale / 100
  const numerator = BIG(paise) * rate.mantissa;
  const denominator = pow10(rate.scale + 2);
  if (rate.scale + 2 >= 0) return toSafeNumber(divRoundHalfUp(numerator, denominator), "amount");
  return toSafeNumber(numerator * pow10(-(rate.scale + 2)), "amount");
}

/**
 * An amount times a decimal factor (a quantity such as `1.5`, or `"0.25"`), rounded half-up to the
 * paisa: the line amount of `qty × rate` (§6.3).
 */
export function multiplyPaise(paise: Paise, factor: number | string): Paise {
  assertPaise(paise);
  const f = parseDecimal(factor);
  if (!f) throw new TypeError(`Not a number: ${String(factor)}`);
  const product = BIG(paise) * f.mantissa;
  if (f.scale >= 0) return toSafeNumber(divRoundHalfUp(product, pow10(f.scale)), "amount");
  return toSafeNumber(product * pow10(-f.scale), "amount");
}

/** The exact sum of paise amounts (§6.3: totals are sums of rounded lines). */
export function sumPaise(values: readonly Paise[]): Paise {
  let total = 0;
  for (const v of values) total += assertPaise(v);
  return assertPaise(total, "total");
}

/**
 * Splits an amount into `parts` shares that add up exactly to it. The remainder paise go one each to
 * the first shares: `splitEvenly(1000, 3)` → `[334, 333, 333]`.
 */
export function splitEvenly(total: Paise, parts: number): Paise[] {
  assertPaise(total);
  if (!Number.isSafeInteger(parts) || parts < 1) throw new RangeError("parts must be a whole number of at least 1.");
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const base = Math.floor(abs / parts);
  const remainder = abs - base * parts;
  return Array.from({ length: parts }, (_, i) => {
    const share = sign * (base + (i < remainder ? 1 : 0));
    return share === 0 ? 0 : share; // never -0
  });
}

/**
 * Rounds a total to whole rupees (half-up) and returns the round-off line (§6.3; at most ±₹0.50,
 * inside the ±₹0.99 the spec allows): `roundOffToRupee(123450)` → `{ total: 123500, roundOff: 50 }`.
 */
export function roundOffToRupee(paise: Paise): { total: Paise; roundOff: Paise } {
  assertPaise(paise);
  const total = divideRoundHalfUp(paise, 100) * 100;
  const roundOff = total - paise;
  return { total: total === 0 ? 0 : total, roundOff: roundOff === 0 ? 0 : roundOff };
}

// -------------------------------------------------------------------------------------------------
// Display
// -------------------------------------------------------------------------------------------------

/**
 * Indian digit grouping of a string of digits: the last three, then pairs (`1234567` → `12,34,567`).
 */
export function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  let rest = digits.slice(0, -3);
  const pairs: string[] = [];
  while (rest.length > 2) {
    pairs.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest) pairs.unshift(rest);
  return `${pairs.join(",")},${last3}`;
}

export type FormatINROptions = {
  /** Prefix with ₹ (default true). */
  symbol?: boolean;
  /** 2 (default) shows paise; 0 rounds half-up to whole rupees. */
  decimals?: 0 | 2;
};

/**
 * `₹1,23,456.00`: Indian grouping, two decimals, minus sign before the symbol (`-₹500.00`) (§3.4).
 */
export function formatINR(paise: Paise, opts: FormatINROptions = {}): string {
  assertPaise(paise);
  const { symbol = true, decimals = 2 } = opts;
  const scaled = decimals === 2 ? paise : divideRoundHalfUp(paise, 100);
  const negative = scaled < 0;
  const abs = Math.abs(scaled).toString();
  const body =
    decimals === 2
      ? `${groupIndian(abs.padStart(3, "0").slice(0, -2))}.${abs.padStart(3, "0").slice(-2)}`
      : groupIndian(abs);
  return `${negative ? "-" : ""}${symbol ? "₹" : ""}${body}`;
}

/**
 * Compact amount for dashboard tiles only (§3.4): `₹45,600` below a lakh, then `₹12.3L` and
 * `₹1.2Cr` (one decimal, half-up, `.0` dropped). Always show the full `formatINR` value on hover.
 */
export function formatINRCompact(paise: Paise): string {
  assertPaise(paise);
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  const LAKH = 100_000 * 100;
  const CRORE = 10_000_000 * 100;
  if (abs < LAKH) return `${sign}${formatINR(abs, { decimals: 0 })}`;
  const tenths = (t: number, unit: string) => {
    const whole = Math.floor(t / 10);
    const dec = t % 10;
    return `${sign}₹${groupIndian(String(whole))}${dec ? `.${dec}` : ""}${unit}`;
  };
  const lakhTenths = divideRoundHalfUp(abs, LAKH / 10);
  if (lakhTenths < 1000) return tenths(lakhTenths, "L");
  return tenths(divideRoundHalfUp(abs, CRORE / 10), "Cr");
}

const ONES = [
  "Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function belowHundred(n: number): string {
  if (n < 20) return ONES[n];
  const t = TENS[Math.floor(n / 10)];
  return n % 10 ? `${t}-${ONES[n % 10]}` : t;
}

function belowThousand(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts: string[] = [];
  if (h) parts.push(`${ONES[h]} Hundred`);
  if (r) parts.push(belowHundred(r));
  return parts.join(" ");
}

/**
 * A whole number in words in the Indian system (`1234567` → "Twelve Lakh Thirty-Four Thousand Five
 * Hundred Sixty-Seven"). Crores above 99 are counted in the same system ("One Thousand Two Hundred
 * Crore").
 */
export function numberInWordsIndian(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError("Only whole numbers of zero or more can be written in words.");
  if (n === 0) return "Zero";
  const crore = Math.floor(n / 10_000_000);
  const rest = n % 10_000_000;
  const lakh = Math.floor(rest / 100_000);
  const thousand = Math.floor((rest % 100_000) / 1000);
  const units = rest % 1000;
  const parts: string[] = [];
  if (crore) parts.push(`${numberInWordsIndian(crore)} Crore`);
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`);
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`);
  if (units) parts.push(belowThousand(units));
  return parts.join(" ");
}

/**
 * The amount in words for invoices, quotations and receipts (§0.1 rule 7, §6.3):
 * `123456750` → "Rupees Twelve Lakh Thirty-Four Thousand Five Hundred Sixty-Seven and Fifty Paise Only".
 * Whole rupees omit the paise ("Rupees One Hundred Only"); one paisa is "One Paisa"; a negative
 * amount starts "Minus".
 */
export function amountInWords(paise: Paise): string {
  assertPaise(paise);
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const p = abs % 100;
  const paiseWords = p ? ` and ${belowHundred(p)} ${p === 1 ? "Paisa" : "Paise"}` : "";
  const words = `Rupees ${numberInWordsIndian(rupees)}${paiseWords} Only`;
  return paise < 0 ? `Minus ${words}` : words;
}
