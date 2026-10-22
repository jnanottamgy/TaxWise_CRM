import { describe, expect, it } from "vitest"
import { formatValue, niceStep, niceTicks, xLabelInterval } from "@/components/app/charts/scale"

describe("niceStep", () => {
  it("rounds up to 1, 2, 2.5, 5 × 10^k", () => {
    expect(niceStep(0.7)).toBe(1)
    expect(niceStep(1.3)).toBe(2)
    expect(niceStep(2.2)).toBe(2.5)
    expect(niceStep(3)).toBe(5)
    expect(niceStep(7)).toBe(10)
    expect(niceStep(130)).toBe(200)
    expect(niceStep(240000)).toBe(250000)
  })

  it("skips fractional steps for counts", () => {
    expect(niceStep(2.2, true)).toBe(5)
    expect(niceStep(0.3, true)).toBe(1)
  })
})

describe("niceTicks", () => {
  it("starts at zero and puts the top tick above the maximum", () => {
    const s = niceTicks([12, 37, 41])
    expect(s.min).toBe(0)
    expect(s.max).toBeGreaterThan(41)
    expect(s.ticks[0]).toBe(0)
    expect(s.ticks.at(-1)).toBe(s.max)
    expect(s.ticks).toEqual([0, 10, 20, 30, 40, 50])
  })

  it("adds a step when the maximum lands exactly on a tick", () => {
    const s = niceTicks([0, 40])
    expect(s.max).toBeGreaterThan(40)
  })

  it("keeps 3 to 6 ticks", () => {
    for (const max of [1, 3, 7, 18, 99, 1234, 98765, 1234567]) {
      const s = niceTicks([0, max])
      expect(s.ticks.length).toBeGreaterThanOrEqual(3)
      expect(s.ticks.length).toBeLessThanOrEqual(6)
    }
  })

  it("draws an all-zero series honestly on a small scale", () => {
    expect(niceTicks([0, 0, 0]).ticks).toEqual([0, 1, 2, 3, 4])
    expect(niceTicks([]).ticks).toEqual([0, 1, 2, 3, 4])
  })

  it("uses integer steps for counts", () => {
    const s = niceTicks([1, 2, 3], { integer: true })
    expect(s.ticks.every((t) => Number.isInteger(t))).toBe(true)
  })

  it("covers negative values", () => {
    const s = niceTicks([-15, 30])
    expect(s.min).toBeLessThanOrEqual(-15)
    expect(s.max).toBeGreaterThan(30)
    expect(s.ticks).toContain(0)
  })
})

describe("formatValue", () => {
  it("formats money compact on ticks and in full in tooltips", () => {
    expect(formatValue(1234567, "money", "tick")).toBe("₹12.3L")
    expect(formatValue(1234567, "money", "tooltip")).toBe("₹12,34,567.00")
  })

  it("formats counts and percents", () => {
    expect(formatValue(128400, "number", "tick")).toBe("1,28,400")
    expect(formatValue(12.5, "percent", "tooltip")).toBe("12.5%")
    expect(formatValue(7, (v) => `${v} returns`)).toBe("7 returns")
  })
})

describe("xLabelInterval", () => {
  it("shows every label up to seven, then skips", () => {
    expect(xLabelInterval(6)).toBe(0)
    expect(xLabelInterval(12)).toBe(1)
    expect(xLabelInterval(31)).toBe(4)
  })
})
