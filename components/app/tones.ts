/**
 * Tone → token classes for chips, dots and urgency text (DESIGN.md §2). Text always uses the
 * `*-text` tokens (AA contrast); dots and fills use the base token. Pure and server-safe.
 *
 *   const t = toneClasses("warning")  // { text: "text-warning-text", dot: "bg-warning", soft: "bg-warning-soft", … }
 */
import type { StatusTone } from "@/lib/status"
import type { DueUrgency } from "@/lib/format"

export type Tone = StatusTone

export interface ToneClasses {
  /** Label colour (≥ 4.5:1 on surface, surface-2 and bg). */
  text: string
  /** The 8px dot. Muted is a hollow ring so "nothing happening" reads as empty. */
  dot: string
  /** Pale fill for the pill variant. */
  soft: string
  /** Hairline for the pill variant. */
  border: string
}

const TONES: Record<Tone, ToneClasses> = {
  success: { text: "text-success-text", dot: "bg-success", soft: "bg-success-soft", border: "border-success/25" },
  warning: { text: "text-warning-text", dot: "bg-warning", soft: "bg-warning-soft", border: "border-warning/30" },
  danger: { text: "text-danger-text", dot: "bg-danger", soft: "bg-danger-soft", border: "border-danger/25" },
  info: { text: "text-info-text", dot: "bg-info", soft: "bg-info-soft", border: "border-info/25" },
  violet: { text: "text-violet-text", dot: "bg-violet", soft: "bg-violet-soft", border: "border-violet/25" },
  muted: {
    text: "text-text-muted",
    dot: "bg-transparent ring-[1.5px] ring-inset ring-text-muted",
    soft: "bg-surface-2",
    border: "border-border",
  },
  neutral: { text: "text-text", dot: "bg-text-muted", soft: "bg-surface-2", border: "border-border" },
}

export function toneClasses(tone: Tone | null | undefined): ToneClasses {
  return TONES[tone ?? "neutral"] ?? TONES.neutral
}

/** Text colour for a relative due date (§3.4): overdue = danger, ≤ 3 days = warning, ≤ 7 days = info. */
export function urgencyTextClass(urgency: DueUrgency): string {
  switch (urgency) {
    case "overdue":
      return "text-danger-text"
    case "soon":
      return "text-warning-text"
    case "week":
      return "text-info-text"
    default:
      return "text-text-muted"
  }
}
