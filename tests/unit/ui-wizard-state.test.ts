import { describe, expect, it } from "vitest"
import { canComplete, canOpenStep, stepLabel, stepStates } from "@/components/app/wizard-state"

const steps = (...valid: boolean[]) => valid.map((v) => ({ valid: v }))

describe("stepStates", () => {
  it("locks every step after the first invalid one", () => {
    expect(stepStates(steps(false, false, false), 0)).toEqual(["current", "locked", "locked"])
    expect(stepStates(steps(true, false, false), 1)).toEqual(["complete", "current", "locked"])
  })

  it("marks valid reachable steps complete and the rest available", () => {
    expect(stepStates(steps(true, true, false, false), 3)).toEqual(["complete", "complete", "available", "current"])
  })

  it("treats optional steps as passable", () => {
    const s = [{ valid: true }, { valid: false, optional: true }, { valid: false }]
    expect(stepStates(s, 0)).toEqual(["current", "available", "available"])
  })

  it("locks later steps when the current step becomes invalid again", () => {
    expect(stepStates(steps(false, true, true), 0)).toEqual(["current", "locked", "locked"])
  })
})

describe("canOpenStep / canComplete / stepLabel", () => {
  it("allows only reachable steps", () => {
    const s = steps(true, false, true)
    expect(canOpenStep(s, 0, 1)).toBe(true)
    expect(canOpenStep(s, 0, 2)).toBe(false)
    expect(canOpenStep(s, 1, 1)).toBe(true)
    expect(canOpenStep(s, 1, 5)).toBe(false)
  })

  it("completes only when every required step is valid", () => {
    expect(canComplete(steps(true, true))).toBe(true)
    expect(canComplete(steps(true, false))).toBe(false)
    expect(canComplete([{ valid: true }, { valid: false, optional: true }])).toBe(true)
  })

  it("labels the step", () => {
    expect(stepLabel(1, 5)).toBe("Step 2 of 5")
  })
})
