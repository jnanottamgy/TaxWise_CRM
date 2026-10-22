"use client"

import * as React from "react"
import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts"
import { ChartFrame, ChartLegend, ChartTooltipBox, type ChartTable } from "@/components/app/charts/chart-frame"
import { formatValue, niceTicks, xLabelInterval, type ValueFormat } from "@/components/app/charts/scale"
import { EmptyState } from "@/components/app/empty-state"

/*
 * Chart cards over Recharts 3 with the house rules built in (DESIGN.md §3): one hue (var(--chart-1)),
 * 3–5 faint horizontal gridlines, no y-axis line, no legend for one series, straight lines, square
 * bars, round ticks above the maximum, a plain tooltip, no entrance animation, and a "View as table"
 * toggle on every chart (§13). Money values are RUPEES as numbers (fromPaise) and format as ₹12.3L
 * on ticks and the full ₹12,34,567.00 in tooltips and the table.
 */

export type ChartDatum = Record<string, string | number | null>

interface BaseCardProps {
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  data: ChartDatum[]
  /** The category / time key ("month"). Its values are the x labels ("Apr", "May" or "Sep 2026"). */
  xKey: string
  /** Header for the x column in the table view. */
  xLabel?: string
  valueFormat?: ValueFormat
  /** Counts: integer ticks. */
  integer?: boolean
  height?: number
  /** One sentence for screen readers ("Collections rose from ₹4.1L in April to ₹6.8L in September"). */
  summary?: string
  /** Shown in the frame when `data` is empty. */
  emptyMessage?: string
  className?: string
}

const AXIS_TICK = { fill: "var(--text-muted)", fontSize: 12 }
const GRID = "var(--border)"

function num(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN
  return Number.isFinite(n) ? n : 0
}

function tableFor(data: ChartDatum[], xKey: string, xLabel: string, series: Array<{ key: string; label: string }>, fmt: ValueFormat): ChartTable {
  return {
    columns: [{ label: xLabel }, ...series.map((s) => ({ label: s.label, align: "right" as const }))],
    rows: data.map((d) => [String(d[xKey] ?? ""), ...series.map((s) => (d[s.key] === null || d[s.key] === undefined ? "—" : formatValue(num(d[s.key]), fmt)))]),
  }
}

function yAxisWidth(ticks: number[], fmt: ValueFormat): number {
  const longest = Math.max(...ticks.map((t) => formatValue(t, fmt, "tick").length))
  return Math.min(80, Math.max(28, longest * 7 + 8))
}

// -------------------------------------------------------------------------------------------------

/**
 * Is it moving over time? One 2px straight line in var(--chart-1). A second series (e.g. last year)
 * is drawn grey and dashed, with a legend.
 *
 *   <LineChartCard title="Collections" description="FY 2026-27, by month" xKey="month"
 *     data={[{ month: "Apr", collected: 412000 }, …]} series={[{ key: "collected", label: "Collected" }]}
 *     valueFormat="money" />
 */
export function LineChartCard({
  series,
  reference,
  ...p
}: BaseCardProps & {
  series: Array<{ key: string; label: string }>
  /** A 1px dashed reference line (a target, a capacity) with its label at the end. */
  reference?: { value: number; label: string }
}) {
  const fmt = p.valueFormat ?? "number"
  const values = p.data.flatMap((d) => series.map((s) => num(d[s.key])))
  const scale = niceTicks(reference ? [...values, reference.value] : values, { integer: p.integer })
  const height = p.height ?? 200
  const colors = series.map((_, i) => (i === 0 ? "var(--chart-1)" : "var(--text-muted)"))
  return (
    <ChartFrame
      title={p.title}
      description={p.description}
      action={p.action}
      summary={p.summary}
      className={p.className}
      legend={series.length > 1 ? <ChartLegend items={series.map((s, i) => ({ label: s.label, color: colors[i] }))} /> : undefined}
      table={tableFor(p.data, p.xKey, p.xLabel ?? "Period", series, fmt)}
      empty={p.data.length === 0 ? <EmptyState size="compact" message={p.emptyMessage ?? "Nothing to show for this period yet."} /> : undefined}
    >
      <LineChart responsive data={p.data} style={{ width: "100%", height }} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis
          dataKey={p.xKey}
          tickLine={false}
          axisLine={{ stroke: "var(--text-muted)", strokeOpacity: 0.35 }}
          tick={AXIS_TICK}
          interval={xLabelInterval(p.data.length)}
          tickMargin={8}
          padding={{ left: 8, right: 8 }}
        />
        <YAxis
          domain={[scale.min, scale.max]}
          ticks={scale.ticks}
          tickLine={false}
          axisLine={false}
          tick={AXIS_TICK}
          width={yAxisWidth(scale.ticks, fmt)}
          tickFormatter={(v: number) => formatValue(v, fmt, "tick")}
          allowDecimals={!p.integer}
        />
        <Tooltip
          cursor={{ stroke: "var(--text-muted)", strokeOpacity: 0.4, strokeWidth: 1 }}
          isAnimationActive={false}
          content={({ active, payload, label }) =>
            active && payload?.length ? (
              <ChartTooltipBox
                label={label}
                rows={payload.map((pl, i) => ({
                  name: series.find((s) => s.key === pl.dataKey)?.label ?? String(pl.name ?? ""),
                  value: formatValue(num(pl.value), fmt),
                  color: series.length > 1 ? colors[i] : undefined,
                }))}
              />
            ) : null
          }
        />
        {reference ? (
          <ReferenceLine
            y={reference.value}
            stroke="var(--text-muted)"
            strokeDasharray="4 4"
            label={{ value: reference.label, position: "insideTopRight", fill: "var(--text-muted)", fontSize: 12 }}
          />
        ) : null}
        {series.map((s, i) => (
          <Line
            key={s.key}
            type="linear"
            dataKey={s.key}
            name={s.label}
            stroke={colors[i]}
            strokeWidth={2}
            strokeDasharray={i === 0 ? undefined : "4 3"}
            dot={false}
            activeDot={{ r: 4, stroke: "var(--surface)", strokeWidth: 2, fill: colors[i] }}
            isAnimationActive={false}
            connectNulls={false}
          />
        ))}
      </LineChart>
    </ChartFrame>
  )
}

/**
 * How much per period? Square columns in var(--chart-1). `highlight` keeps one bar (the current
 * period) in the full hue and softens the rest.
 *
 *   <BarChartCard title="Returns filed" xKey="month" data={rows} series={{ key: "filed", label: "Filed" }} integer />
 */
export function BarChartCard({
  series,
  highlight,
  ...p
}: BaseCardProps & {
  series: { key: string; label: string }
  /** Index of the bar to emphasise. */
  highlight?: number
}) {
  const fmt = p.valueFormat ?? "number"
  const scale = niceTicks(
    p.data.map((d) => num(d[series.key])),
    { integer: p.integer }
  )
  const height = p.height ?? 200
  return (
    <ChartFrame
      title={p.title}
      description={p.description}
      action={p.action}
      summary={p.summary}
      className={p.className}
      table={tableFor(p.data, p.xKey, p.xLabel ?? "Period", [series], fmt)}
      empty={p.data.length === 0 ? <EmptyState size="compact" message={p.emptyMessage ?? "Nothing to show for this period yet."} /> : undefined}
    >
      <BarChart responsive data={p.data} style={{ width: "100%", height }} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barCategoryGap="28%">
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis
          dataKey={p.xKey}
          tickLine={false}
          axisLine={{ stroke: "var(--text-muted)", strokeOpacity: 0.35 }}
          tick={AXIS_TICK}
          interval={xLabelInterval(p.data.length)}
          tickMargin={8}
        />
        <YAxis
          domain={[scale.min, scale.max]}
          ticks={scale.ticks}
          tickLine={false}
          axisLine={false}
          tick={AXIS_TICK}
          width={yAxisWidth(scale.ticks, fmt)}
          tickFormatter={(v: number) => formatValue(v, fmt, "tick")}
          allowDecimals={!p.integer}
        />
        <Tooltip
          cursor={{ fill: "var(--surface-2)" }}
          isAnimationActive={false}
          content={({ active, payload, label }) =>
            active && payload?.length ? (
              <ChartTooltipBox label={label} rows={[{ name: series.label, value: formatValue(num(payload[0].value), fmt) }]} />
            ) : null
          }
        />
        <Bar
          dataKey={series.key}
          name={series.label}
          fill="var(--chart-1)"
          radius={0}
          isAnimationActive={false}
          shape={
            highlight === undefined
              ? undefined
              : (props: unknown) => {
                  const b = props as { x: number; y: number; width: number; height: number; index: number }
                  return (
                    <rect
                      x={b.x}
                      y={b.y}
                      width={b.width}
                      height={Math.max(0, b.height)}
                      fill={b.index === highlight ? "var(--chart-1)" : "color-mix(in srgb, var(--chart-1) 45%, var(--surface))"}
                    />
                  )
                }
          }
        />
      </BarChart>
    </ChartFrame>
  )
}

/**
 * One hue in three lightness steps (an ordinal ramp validated against both surfaces), then a neutral
 * grey for a fourth "Other" part; seams in the surface colour.
 */
export const STACK_COLORS = [
  "var(--chart-1)",
  "color-mix(in srgb, var(--chart-1) 62%, var(--surface))",
  "color-mix(in srgb, var(--chart-1) 45%, var(--surface))",
  "color-mix(in srgb, var(--text-muted) 45%, var(--surface))",
] as const

/**
 * What share, per period? Stacked square columns in steps of one hue (2px seams, at most four
 * parts; the fourth is grey, for "Other") with a dot legend in the header. Put the part that
 * matters most first.
 *
 *   <StackedBarCard title="Billing by service" xKey="month" valueFormat="money" data={rows}
 *     series={[{ key: "gst", label: "GST" }, { key: "income_tax", label: "Income tax" }, { key: "audit", label: "Audit" }]} />
 */
export function StackedBarCard({
  series,
  showTotal = true,
  ...p
}: BaseCardProps & {
  /** Two to four parts; extra parts should be folded into "Other" before charting. */
  series: Array<{ key: string; label: string }>
  /** Add a Total column to the table view. */
  showTotal?: boolean
}) {
  const fmt = p.valueFormat ?? "number"
  const parts = series.slice(0, 4)
  const totals = p.data.map((d) => parts.reduce((sum, s) => sum + num(d[s.key]), 0))
  const scale = niceTicks(totals, { integer: p.integer })
  const height = p.height ?? 220
  const table = tableFor(p.data, p.xKey, p.xLabel ?? "Period", parts, fmt)
  if (showTotal) {
    table.columns.push({ label: "Total", align: "right" })
    table.rows.forEach((r, i) => r.push(formatValue(totals[i], fmt)))
  }
  return (
    <ChartFrame
      title={p.title}
      description={p.description}
      action={p.action}
      summary={p.summary}
      className={p.className}
      legend={<ChartLegend items={parts.map((s, i) => ({ label: s.label, color: STACK_COLORS[i] }))} />}
      table={table}
      empty={p.data.length === 0 ? <EmptyState size="compact" message={p.emptyMessage ?? "Nothing to show for this period yet."} /> : undefined}
    >
      <BarChart responsive data={p.data} style={{ width: "100%", height }} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barCategoryGap="28%">
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis
          dataKey={p.xKey}
          tickLine={false}
          axisLine={{ stroke: "var(--text-muted)", strokeOpacity: 0.35 }}
          tick={AXIS_TICK}
          interval={xLabelInterval(p.data.length)}
          tickMargin={8}
        />
        <YAxis
          domain={[scale.min, scale.max]}
          ticks={scale.ticks}
          tickLine={false}
          axisLine={false}
          tick={AXIS_TICK}
          width={yAxisWidth(scale.ticks, fmt)}
          tickFormatter={(v: number) => formatValue(v, fmt, "tick")}
        />
        <Tooltip
          cursor={{ fill: "var(--surface-2)" }}
          isAnimationActive={false}
          content={({ active, payload, label }) =>
            active && payload?.length ? (
              <ChartTooltipBox
                label={label}
                rows={[...payload].reverse().map((pl) => {
                  const idx = parts.findIndex((s) => s.key === pl.dataKey)
                  return { name: parts[idx]?.label ?? String(pl.name ?? ""), value: formatValue(num(pl.value), fmt), color: STACK_COLORS[idx] }
                })}
              />
            ) : null
          }
        />
        {parts.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.label}
            stackId="stack"
            fill={STACK_COLORS[i]}
            stroke="var(--surface)"
            strokeWidth={2}
            radius={0}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ChartFrame>
  )
}
