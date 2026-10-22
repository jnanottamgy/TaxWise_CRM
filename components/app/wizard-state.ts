/**
 * Step logic for the Wizard (§7.3.2: steps unlock in order, ✓ when valid). Pure; tested in
 * tests/unit/ui-wizard-state.test.ts.
 */

export type StepState = "complete" | "current" | "available" | "locked"

export interface StepLike {
  /** The step's fields pass validation. */
  valid: boolean
  /** Can be skipped: counts as valid for unlocking later steps. */
  optional?: boolean
}

/**
 * The state of each step given the current index:
 * - `current`: the step on screen;
 * - `complete`: valid (shows ✓) and reachable;
 * - `available`: reachable but not yet valid;
 * - `locked`: an earlier step isn't valid yet, so it can't be opened.
 * A step is reachable when every step before it is valid or optional.
 */
export function stepStates(steps: readonly StepLike[], current: number): StepState[] {
  const out: StepState[] = []
  let reachable = true
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    if (i === current) out.push("current")
    else if (!reachable) out.push("locked")
    else out.push(s.valid ? "complete" : "available")
    if (!(s.valid || s.optional)) reachable = false
  }
  return out
}

/** True when the user may jump to `target` from where they are. */
export function canOpenStep(steps: readonly StepLike[], current: number, target: number): boolean {
  if (target < 0 || target >= steps.length) return false
  if (target === current) return true
  return stepStates(steps, current)[target] !== "locked"
}

/** Every required step is valid: the Complete button may submit. */
export function canComplete(steps: readonly StepLike[]): boolean {
  return steps.every((s) => s.valid || s.optional)
}

/** "Step 2 of 5" for the phone stepper and screen readers. */
export function stepLabel(current: number, total: number): string {
  return `Step ${Math.min(current + 1, total)} of ${total}`
}
