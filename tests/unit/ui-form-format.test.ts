import { describe, expect, it } from "vitest"
import {
  clampPercent,
  cleanMoneyTyping,
  formatMoneyDisplay,
  moneyValueFromTyping,
  parseDateInput,
} from "@/components/app/form/format"

describe("money typing", () => {
  it("keeps digits and one decimal point, two decimals at most", () => {
    expect(cleanMoneyTyping("₹ 1,23,456.789")).toBe("123456.78")
    expect(cleanMoneyTyping("12.")).toBe("12.")
    expect(cleanMoneyTyping("1.2.3")).toBe("1.23")
    expect(cleanMoneyTyping("abc")).toBe("")
    expect(cleanMoneyTyping("0005")).toBe("5")
    expect(cleanMoneyTyping(".5")).toBe("0.5")
  })

  it("drops a minus unless negatives are allowed", () => {
    expect(cleanMoneyTyping("-500")).toBe("500")
    expect(cleanMoneyTyping("-500", { allowNegative: true })).toBe("-500")
  })

  it("stores the number without grouping or a trailing dot", () => {
    expect(moneyValueFromTyping("1,23,456.50")).toBe("123456.50")
    expect(moneyValueFromTyping("12.")).toBe("12")
    expect(moneyValueFromTyping("")).toBe("")
    expect(moneyValueFromTyping("-", { allowNegative: true })).toBe("")
  })

  it("displays with Indian grouping and two decimals", () => {
    expect(formatMoneyDisplay("123456.5")).toBe("1,23,456.50")
    expect(formatMoneyDisplay(12500)).toBe("12,500.00")
    expect(formatMoneyDisplay("0")).toBe("0.00")
    expect(formatMoneyDisplay("-1234567.891")).toBe("-12,34,567.89")
    expect(formatMoneyDisplay("")).toBe("")
    expect(formatMoneyDisplay(null)).toBe("")
  })

  it("leaves text that isn't a number alone (the schema reports it)", () => {
    expect(formatMoneyDisplay("12a")).toBe("12a")
  })
})

describe("percent", () => {
  it("clamps to the range on blur", () => {
    expect(clampPercent("120")).toBe("100")
    expect(clampPercent("12.")).toBe("12")
    expect(clampPercent("")).toBe("")
    expect(clampPercent("18")).toBe("18")
    expect(clampPercent("5", 100, 10)).toBe("10")
  })
})

describe("parseDateInput", () => {
  it("reads ISO dates", () => {
    expect(parseDateInput("2026-10-22")).toBe("2026-10-22")
    expect(parseDateInput("2026-1-5")).toBe("2026-01-05")
  })

  it("reads day-first numeric dates the way an Indian office types them", () => {
    expect(parseDateInput("22/10/2026")).toBe("2026-10-22")
    expect(parseDateInput("22-10-26")).toBe("2026-10-22")
    expect(parseDateInput("22.10.2026")).toBe("2026-10-22")
    expect(parseDateInput("5/4/2027")).toBe("2027-04-05")
  })

  it("reads month names", () => {
    expect(parseDateInput("22 Oct 2026")).toBe("2026-10-22")
    expect(parseDateInput("22-oct-2026")).toBe("2026-10-22")
    expect(parseDateInput("22 October 26")).toBe("2026-10-22")
    expect(parseDateInput("1 Sept 2026")).toBe("2026-09-01")
    expect(parseDateInput("22Oct2026")).toBe("2026-10-22")
  })

  it("refuses dates that don't exist", () => {
    expect(parseDateInput("31/02/2026")).toBeNull()
    expect(parseDateInput("29 Feb 2027")).toBeNull()
    expect(parseDateInput("29 Feb 2028")).toBe("2028-02-29")
    expect(parseDateInput("13/13/2026")).toBeNull()
    expect(parseDateInput("tomorrow")).toBeNull()
    expect(parseDateInput("")).toBeNull()
  })
})
