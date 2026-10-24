"use client"

import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts"
import { ChartTooltipBox } from "@/components/app/charts/chart-frame"
import { formatValue, niceTicks, xLabelInterval } from "@/components/app/charts/scale"

const AXIS_TICK = { fill: "var(--text-muted)", fontSize: 12 }

/**
 * A section's chart (DESIGN.md §3): square columns in the one chart hue, 3–5 faint horizontal
 * gridlines, no y-axis line, round ticks above the maximum, flat x labels, a plain tooltip, no
 * entrance. The section's own table under it is the table alternative (§13). Money arrives in
 * rupees.
 */
export function ReportChart({
  data,
  label,
  format,
  summary,
  height = 180,
}: {
  data: Array<{ x: string; y: number }>
  label: string
  format: "number" | "money"
  summary: string
  height?: number
}) {
  const scale = niceTicks(
    data.map((d) => d.y),
    { integer: format === "number" }
  )
  const longest = Math.max(...scale.ticks.map((t) => formatValue(t, format, "tick").length))
  return (
    <figure role="img" aria-label={summary} className="m-0 px-2 pb-2 md:px-3">
      <BarChart responsive data={data} style={{ width: "100%", height }} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barCategoryGap="28%">
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis dataKey="x" tickLine={false} axisLine={{ stroke: "var(--text-muted)", strokeOpacity: 0.35 }} tick={AXIS_TICK} interval={xLabelInterval(data.length, 6)} tickMargin={8} />
        <YAxis
          domain={[scale.min, scale.max]}
          ticks={scale.ticks}
          tickLine={false}
          axisLine={false}
          tick={AXIS_TICK}
          width={Math.min(80, Math.max(28, longest * 7 + 8))}
          tickFormatter={(v: number) => formatValue(v, format, "tick")}
          allowDecimals={format !== "number"}
        />
        <Tooltip
          cursor={{ fill: "var(--surface-2)" }}
          isAnimationActive={false}
          content={({ active, payload, label: x }) =>
            active && payload?.length ? <ChartTooltipBox label={x} rows={[{ name: label, value: formatValue(Number(payload[0].value), format) }]} /> : null
          }
        />
        <Bar dataKey="y" name={label} fill="var(--chart-1)" radius={0} isAnimationActive={false} />
      </BarChart>
    </figure>
  )
}
