/**
 * Axis helpers for the chart cards (DESIGN.md chart rules: 3–5 faint gridlines, round even steps,
 * the top tick above the maximum, zero as the baseline). Pure; tested in tests/unit/ui-chart-scale.test.ts.
 */
import { formatMoneyCompact, formatNumber, formatPercent } from "@/lib/format"

const NICE = [1, 2, 2.5, 5, 10]

/** The smallest "nice" step (1, 2, 2.5, 5 × 10^k) at or above `raw`. Integers only when `integer`. */
export function niceStep(raw: number, integer = false): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1
  const exp = Math.floor(Math.log10(raw))
  const base = 10 ** exp
  for (const n of NICE) {
    const step = n * base
    if (step >= raw - 1e-9 && (!integer || Number.isInteger(step))) return step
  }
  return 10 * base
}

export interface NiceScale {
  min: number
  max: number
  step: number
  ticks: number[]
}

/**
 * Round ticks covering [min(0, dataMin), dataMax] with about `target` intervals (default 4, so 5
 * ticks including zero). The top tick is strictly above the data maximum, so a line never touches
 * the top of the plot. Counts (`integer`) never get fractional ticks.
 *
 *   niceTicks([12, 37, 41]) → { min: 0, max: 50, step: 10, ticks: [0, 10, 20, 30, 40, 50] }
 *   niceTicks([0, 0, 0])    → { min: 0, max: 4, step: 1, ticks: [0, 1, 2, 3, 4] }
 */
export function niceTicks(values: readonly number[], opts: { target?: number; integer?: boolean } = {}): NiceScale {
  const target = Math.max(2, opts.target ?? 4)
  const finite = values.filter((v) => Number.isFinite(v))
  const dataMax = finite.length ? Math.max(...finite) : 0
  const dataMin = finite.length ? Math.min(...finite) : 0
  const lo = Math.min(0, dataMin)
  const hi = Math.max(0, dataMax)
  if (hi === lo) {
    const step = 1
    return { min: 0, max: target * step, step, ticks: Array.from({ length: target + 1 }, (_, i) => i * step) }
  }
  // Try the nice steps around the ideal one; keep 3–7 ticks and the least empty headroom above the data.
  const raw = (hi - lo) / target
  const candidates = Array.from(new Set([0.5, 0.75, 1, 1.5].map((f) => niceStep(raw * f, opts.integer))))
  let best: { step: number; min: number; max: number; headroom: number } | null = null
  for (const step of candidates) {
    const min = Math.floor(lo / step) * step
    let max = Math.ceil(hi / step) * step
    if (max <= hi) max += step
    const intervals = Math.round((max - min) / step)
    // 2–5 intervals: at most five gridlines above the baseline (DESIGN.md: 3–5 faint gridlines).
    if (intervals < 2 || intervals > 5) continue
    const headroom = (max - hi) / (max - min)
    if (!best || headroom < best.headroom - 1e-9 || (Math.abs(headroom - best.headroom) < 1e-9 && step > best.step)) {
      best = { step, min, max, headroom }
    }
  }
  if (!best) {
    const step = niceStep(raw, opts.integer)
    const min = Math.floor(lo / step) * step
    let max = Math.ceil(hi / step) * step
    if (max <= hi) max += step
    best = { step, min, max, headroom: 0 }
  }
  const { step, min, max } = best
  const ticks: number[] = []
  for (let v = min; v <= max + step / 1e6; v += step) ticks.push(Number(v.toFixed(10)))
  return { min, max, step, ticks }
}

export type ValueFormat = "number" | "money" | "percent" | ((value: number) => string)

/** Formats a tick or tooltip value. Money values are rupees (use fromPaise before charting). */
export function formatValue(value: number, format: ValueFormat = "number", where: "tick" | "tooltip" = "tooltip"): string {
  if (typeof format === "function") return format(value)
  if (!Number.isFinite(value)) return "—"
  if (format === "money") {
    const m = formatMoneyCompact(value)
    return where === "tick" ? m.compact : m.full
  }
  if (format === "percent") return formatPercent(value, { decimals: where === "tick" ? 0 : 1 })
  return formatNumber(value, { maxDecimals: where === "tick" ? 0 : 2 })
}

/** How many category labels to skip so 4–8 show on the x axis (recharts `interval`). */
export function xLabelInterval(count: number, maxLabels = 7): number {
  if (count <= maxLabels) return 0
  return Math.ceil(count / maxLabels) - 1
}
