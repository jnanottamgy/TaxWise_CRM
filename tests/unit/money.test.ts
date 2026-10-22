import { describe, expect, it } from "vitest";
import {
  amountInWords,
  divideRoundHalfUp,
  formatINR,
  formatINRCompact,
  fromPaise,
  groupIndian,
  isPaise,
  multiplyPaise,
  numberInWordsIndian,
  paiseToDecimalString,
  parseAmount,
  percentOf,
  roundHalfUp,
  roundOffToRupee,
  splitEvenly,
  sumPaise,
  toPaise,
  toPaiseOrNull,
} from "@/lib/domain/money";

describe("toPaise (exact, §0.1 rule 7)", () => {
  it("converts numbers and numeric strings", () => {
    expect(toPaise(123.45)).toBe(12345);
    expect(toPaise("123.45")).toBe(12345);
    expect(toPaise("1234.50")).toBe(123450);
    expect(toPaise(0)).toBe(0);
    expect(toPaise("0.00")).toBe(0);
    expect(toPaise(7)).toBe(700);
    expect(toPaise(".5")).toBe(50);
    expect(toPaise("5.")).toBe(500);
    expect(toPaise("-12.34")).toBe(-1234);
    expect(toPaise("+12.34")).toBe(1234);
  });

  it("ignores ₹, commas and spaces", () => {
    expect(toPaise("₹1,23,456.78")).toBe(12345678);
    expect(toPaise(" ₹ 12,500 ")).toBe(1250000);
  });

  it("has no float error", () => {
    expect(toPaise(0.1 + 0.2)).toBe(30);
    expect(toPaise(1.005)).toBe(101); // the decimal 1.005, rounded half-up
    expect(toPaise(19.99)).toBe(1999);
    expect(toPaise(1.15)).toBe(115);
    expect(toPaise(999999999999.99)).toBe(99999999999999); // numeric(14,2) maximum
  });

  it("rounds a third decimal half-up (away from zero)", () => {
    expect(toPaise("2.345")).toBe(235);
    expect(toPaise("2.344")).toBe(234);
    expect(toPaise("-2.345")).toBe(-235);
    expect(toPaise("0.005")).toBe(1);
    expect(toPaise("0.0049")).toBe(0);
  });

  it("accepts exponent notation", () => {
    expect(toPaise("1e3")).toBe(100000);
    expect(toPaise(1e-7)).toBe(0);
    expect(toPaise("1.5E2")).toBe(15000);
  });

  it("throws for things that aren't amounts", () => {
    for (const bad of ["abc", "", "1.2.3", "12-3", "--1", "."]) expect(() => toPaise(bad), bad).toThrow(TypeError);
    expect(() => toPaise(Number.NaN)).toThrow(TypeError);
    expect(() => toPaise(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => toPaise("1e30")).toThrow(RangeError);
  });

  it("toPaiseOrNull keeps null", () => {
    expect(toPaiseOrNull(null)).toBeNull();
    expect(toPaiseOrNull(undefined)).toBeNull();
    expect(toPaiseOrNull("")).toBeNull();
    expect(toPaiseOrNull("10.00")).toBe(1000);
  });
});

describe("fromPaise and paiseToDecimalString", () => {
  it("returns rupees", () => {
    expect(fromPaise(12345)).toBe(123.45);
    expect(fromPaise(-5)).toBe(-0.05);
    expect(fromPaise(0)).toBe(0);
  });
  it("writes the exact numeric string", () => {
    expect(paiseToDecimalString(12345)).toBe("123.45");
    expect(paiseToDecimalString(5)).toBe("0.05");
    expect(paiseToDecimalString(-5)).toBe("-0.05");
    expect(paiseToDecimalString(0)).toBe("0.00");
    expect(paiseToDecimalString(99999999999999)).toBe("999999999999.99");
  });
  it("rejects non-integer paise", () => {
    expect(() => paiseToDecimalString(1.5)).toThrow(RangeError);
    expect(isPaise(1.5)).toBe(false);
    expect(isPaise(15)).toBe(true);
    expect(isPaise("15")).toBe(false);
  });
});

describe("parseAmount (form input)", () => {
  it("accepts rupees as typed", () => {
    expect(parseAmount("12500")).toEqual({ ok: true, paise: 1250000 });
    expect(parseAmount("12,500.50")).toEqual({ ok: true, paise: 1250050 });
    expect(parseAmount("₹ 1,23,456")).toEqual({ ok: true, paise: 12345600 });
    expect(parseAmount("0")).toEqual({ ok: true, paise: 0 });
    expect(parseAmount("-0")).toEqual({ ok: true, paise: 0 });
  });
  it("explains what's wrong", () => {
    expect(parseAmount("")).toEqual({ ok: false, error: "Enter an amount." });
    expect(parseAmount("abc")).toEqual({ ok: false, error: "Enter the amount in rupees, for example 12,500 or 12500.50." });
    expect(parseAmount("1e3").ok).toBe(false);
    expect(parseAmount("10.555")).toEqual({ ok: false, error: "Use at most 2 decimal places (paise)." });
    expect(parseAmount("-10")).toEqual({ ok: false, error: "The amount can't be negative." });
  });
  it("allows negatives when asked", () => {
    expect(parseAmount("-10.50", { allowNegative: true })).toEqual({ ok: true, paise: -1050 });
  });
});

describe("rounding (half-up)", () => {
  it("roundHalfUp is exact on decimals", () => {
    expect(roundHalfUp(1.005, 2)).toBe(1.01);
    expect(roundHalfUp(2.5)).toBe(3);
    expect(roundHalfUp(-2.5)).toBe(-3);
    expect(roundHalfUp(2.4)).toBe(2);
    expect(roundHalfUp(1.2345, 3)).toBe(1.235);
    expect(roundHalfUp("0.125", 2)).toBe(0.13);
    expect(roundHalfUp(1234, 0)).toBe(1234);
    expect(() => roundHalfUp("x")).toThrow(TypeError);
  });

  it("divideRoundHalfUp", () => {
    expect(divideRoundHalfUp(5, 2)).toBe(3);
    expect(divideRoundHalfUp(-5, 2)).toBe(-3);
    expect(divideRoundHalfUp(4, 3)).toBe(1);
    expect(divideRoundHalfUp(5, 3)).toBe(2);
    expect(divideRoundHalfUp(1, 3)).toBe(0);
    expect(divideRoundHalfUp(7, -2)).toBe(-4);
    expect(divideRoundHalfUp(0, 7)).toBe(0);
    expect(() => divideRoundHalfUp(1, 0)).toThrow(RangeError);
    expect(() => divideRoundHalfUp(1.5, 2)).toThrow(RangeError);
  });
});

describe("percentOf (paise × rate% → paise)", () => {
  it("applies the rate and rounds half-up at the paisa", () => {
    expect(percentOf(100050, 18)).toBe(18009); // ₹1,000.50 × 18% = ₹180.09
    expect(percentOf(100000, "18.00")).toBe(18000);
    expect(percentOf(100000, 2.5)).toBe(2500);
    expect(percentOf(33, 50)).toBe(17); // 16.5 → 17
    expect(percentOf(1, 18)).toBe(0); // 0.18 → 0
    expect(percentOf(3, 18)).toBe(1); // 0.54 → 1
    expect(percentOf(250, 9)).toBe(23); // 22.5 → 23
    expect(percentOf(-250, 9)).toBe(-23);
    expect(percentOf(123456, 0)).toBe(0);
    expect(percentOf(99999999999999, 18)).toBe(18000000000000); // no overflow at the numeric(14,2) limit
  });
  it("handles rates with more decimals exactly", () => {
    expect(percentOf(1000000, "0.1")).toBe(1000);
    expect(percentOf(1000000, "12.345")).toBe(123450);
  });
  it("rejects bad input", () => {
    expect(() => percentOf(1.5, 18)).toThrow(RangeError);
    expect(() => percentOf(100, "abc")).toThrow(TypeError);
  });
});

describe("multiplyPaise (qty × rate)", () => {
  it("multiplies by a decimal factor and rounds half-up", () => {
    expect(multiplyPaise(100000, 1.5)).toBe(150000);
    expect(multiplyPaise(333, "0.5")).toBe(167);
    expect(multiplyPaise(12345, 3)).toBe(37035);
    expect(multiplyPaise(100, "0.333")).toBe(33);
    expect(multiplyPaise(100, 0)).toBe(0);
    expect(multiplyPaise(101, -0.5)).toBe(-51);
  });
});

describe("sumPaise, splitEvenly, roundOffToRupee", () => {
  it("sums exactly", () => {
    expect(sumPaise([1, 2, 3])).toBe(6);
    expect(sumPaise([])).toBe(0);
    expect(sumPaise([10, -10, 5])).toBe(5);
    expect(() => sumPaise([1, 0.5])).toThrow(RangeError);
  });

  it("splits so the shares add up exactly", () => {
    expect(splitEvenly(1000, 3)).toEqual([334, 333, 333]);
    expect(splitEvenly(-1000, 3)).toEqual([-334, -333, -333]);
    expect(splitEvenly(2, 3)).toEqual([1, 1, 0]);
    expect(splitEvenly(0, 2)).toEqual([0, 0]);
    expect(splitEvenly(5, 1)).toEqual([5]);
    for (const [total, parts] of [[100001, 7], [-99, 4], [12345678, 12]] as const) {
      const shares = splitEvenly(total, parts);
      expect(sumPaise(shares)).toBe(total);
      expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1);
    }
    expect(() => splitEvenly(100, 0)).toThrow(RangeError);
    expect(() => splitEvenly(100, 1.5)).toThrow(RangeError);
  });

  it("rounds to whole rupees with a round-off line within ±₹0.99 (§6.3)", () => {
    expect(roundOffToRupee(123450)).toEqual({ total: 123500, roundOff: 50 });
    expect(roundOffToRupee(123449)).toEqual({ total: 123400, roundOff: -49 });
    expect(roundOffToRupee(123400)).toEqual({ total: 123400, roundOff: 0 });
    expect(roundOffToRupee(123499)).toEqual({ total: 123500, roundOff: 1 });
    expect(roundOffToRupee(-150)).toEqual({ total: -200, roundOff: -50 });
    for (let p = 0; p < 300; p++) expect(Math.abs(roundOffToRupee(p).roundOff)).toBeLessThanOrEqual(99);
  });
});

describe("formatINR (§3.4, §6.3)", () => {
  it("groups the Indian way", () => {
    expect(groupIndian("1")).toBe("1");
    expect(groupIndian("123")).toBe("123");
    expect(groupIndian("1234")).toBe("1,234");
    expect(groupIndian("123456")).toBe("1,23,456");
    expect(groupIndian("1234567")).toBe("12,34,567");
    expect(groupIndian("123456789")).toBe("12,34,56,789");
    expect(groupIndian("1234567890")).toBe("1,23,45,67,890");
  });

  it("formats with ₹ and two decimals", () => {
    expect(formatINR(12345600)).toBe("₹1,23,456.00");
    expect(formatINR(123456789)).toBe("₹12,34,567.89");
    expect(formatINR(1234567890)).toBe("₹1,23,45,678.90");
    expect(formatINR(123456789 * 100 + 0)).toBe("₹12,34,56,789.00"); // the §6.3 example
    expect(formatINR(0)).toBe("₹0.00");
    expect(formatINR(5)).toBe("₹0.05");
    expect(formatINR(99)).toBe("₹0.99");
    expect(formatINR(100000)).toBe("₹1,000.00");
  });

  it("puts the minus sign first", () => {
    expect(formatINR(-50000)).toBe("-₹500.00");
    expect(formatINR(-5)).toBe("-₹0.05");
  });

  it("can drop the symbol or the paise", () => {
    expect(formatINR(12345600, { symbol: false })).toBe("1,23,456.00");
    expect(formatINR(12345650, { decimals: 0 })).toBe("₹1,23,457"); // half-up
    expect(formatINR(12345649, { decimals: 0 })).toBe("₹1,23,456");
    expect(formatINR(-150, { decimals: 0 })).toBe("-₹2");
    expect(formatINR(40, { decimals: 0 })).toBe("₹0");
  });

  it("rejects non-integer paise", () => {
    expect(() => formatINR(1.5)).toThrow(RangeError);
  });
});

describe("formatINRCompact (dashboard tiles only, §3.4)", () => {
  it("shows whole rupees below a lakh", () => {
    expect(formatINRCompact(4560000)).toBe("₹45,600");
    expect(formatINRCompact(0)).toBe("₹0");
    expect(formatINRCompact(9999999)).toBe("₹1,00,000"); // ₹99,999.99 rounds to the rupee
  });
  it("uses L between a lakh and a crore", () => {
    expect(formatINRCompact(10000000)).toBe("₹1L");
    expect(formatINRCompact(123000000)).toBe("₹12.3L");
    expect(formatINRCompact(123499999)).toBe("₹12.3L");
    expect(formatINRCompact(123500000)).toBe("₹12.4L"); // half-up
    expect(formatINRCompact(1200000000 - 1)).toBe("₹1.2Cr");
  });
  it("uses Cr from a crore, including values that round up to it", () => {
    expect(formatINRCompact(1000000000)).toBe("₹1Cr");
    expect(formatINRCompact(999500000)).toBe("₹1Cr"); // 99.95L would read 100.0L
    expect(formatINRCompact(1200000000)).toBe("₹1.2Cr");
    expect(formatINRCompact(123456000000)).toBe("₹123.5Cr");
    expect(formatINRCompact(1234560000000)).toBe("₹1,234.6Cr");
  });
  it("keeps the sign", () => {
    expect(formatINRCompact(-123000000)).toBe("-₹12.3L");
    expect(formatINRCompact(-4560000)).toBe("-₹45,600");
  });
});

describe("amountInWords (Indian system, §6.3)", () => {
  it("matches the spec's example", () => {
    expect(amountInWords(123456750)).toBe(
      "Rupees Twelve Lakh Thirty-Four Thousand Five Hundred Sixty-Seven and Fifty Paise Only",
    );
  });

  it("writes whole rupees without paise", () => {
    expect(amountInWords(10000)).toBe("Rupees One Hundred Only");
    expect(amountInWords(0)).toBe("Rupees Zero Only");
    expect(amountInWords(10100)).toBe("Rupees One Hundred One Only");
    expect(amountInWords(11000)).toBe("Rupees One Hundred Ten Only");
    expect(amountInWords(2100)).toBe("Rupees Twenty-One Only");
    expect(amountInWords(9900)).toBe("Rupees Ninety-Nine Only");
    expect(amountInWords(1900)).toBe("Rupees Nineteen Only");
  });

  it("uses thousand, lakh and crore", () => {
    expect(amountInWords(100000)).toBe("Rupees One Thousand Only");
    expect(amountInWords(10000000)).toBe("Rupees One Lakh Only");
    expect(amountInWords(1000000000)).toBe("Rupees One Crore Only");
    expect(amountInWords(10000000000)).toBe("Rupees Ten Crore Only");
    expect(amountInWords(1180000)).toBe("Rupees Eleven Thousand Eight Hundred Only");
    expect(amountInWords(12345678901)).toBe(
      "Rupees Twelve Crore Thirty-Four Lakh Fifty-Six Thousand Seven Hundred Eighty-Nine and One Paisa Only",
    );
    expect(amountInWords(100000000000 * 10)).toBe("Rupees One Thousand Crore Only");
    expect(amountInWords(99999999999999)).toBe(
      "Rupees Ninety-Nine Thousand Nine Hundred Ninety-Nine Crore Ninety-Nine Lakh Ninety-Nine Thousand Nine Hundred Ninety-Nine and Ninety-Nine Paise Only",
    );
  });

  it("handles paise alone and negatives", () => {
    expect(amountInWords(50)).toBe("Rupees Zero and Fifty Paise Only");
    expect(amountInWords(1)).toBe("Rupees Zero and One Paisa Only");
    expect(amountInWords(-150)).toBe("Minus Rupees One and Fifty Paise Only");
  });

  it("numberInWordsIndian", () => {
    expect(numberInWordsIndian(0)).toBe("Zero");
    expect(numberInWordsIndian(1234567)).toBe("Twelve Lakh Thirty-Four Thousand Five Hundred Sixty-Seven");
    expect(numberInWordsIndian(100100)).toBe("One Lakh One Hundred");
    expect(() => numberInWordsIndian(-1)).toThrow(RangeError);
    expect(() => numberInWordsIndian(1.5)).toThrow(RangeError);
  });
});
