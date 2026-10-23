/**
 * Cover access forms (§4.7, §5.13 client_covers): granting a client cover, a person cover, or a
 * split (one client cover per client), extending, ending, and the cover person's return note.
 * The rules are lib/domain/cover.ts (validateCover, validateExtension, canEndCover, the quick
 * picks); these schemas carry the form and the IST date-and-time conversion. Client-safe.
 */

import { z } from "zod";
import { COVER_REASONS, type CoverReason } from "@/lib/domain/enums";
import { istDayBounds, isDateString, nowIST, type DateString } from "@/lib/domain/fy";
import { parseTimeOfDay } from "@/lib/domain/attendance";

export const COVER_REASON_LABELS: Record<CoverReason, string> = {
  leave: "On leave",
  absent_today: "Absent today",
  workload: "Workload",
  other: "Other",
};

export const COVER_REASON_OPTIONS = COVER_REASONS.map((r) => ({ value: r, label: COVER_REASON_LABELS[r] }));

// -------------------------------------------------------------------------------------------------
// Date and time in IST (§0.1 rule 13): the form shows a date and a time; the database holds instants.
// -------------------------------------------------------------------------------------------------

/** The instant for an IST date and `HH:MM`, or null when either is unreadable. */
export function istInstant(date: string, time: string): Date | null {
  if (!isDateString(date)) return null;
  let minutes: number;
  try {
    minutes = parseTimeOfDay(time);
  } catch {
    return null;
  }
  return new Date(istDayBounds(date as DateString).start.getTime() + minutes * 60_000);
}

/** An instant as the IST date and `HH:MM` the form shows. */
export function istDateTimeParts(instant: Date | string): { date: DateString; time: string } {
  const p = nowIST(typeof instant === "string" ? new Date(instant) : instant);
  return { date: p.date, time: `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}` };
}

// -------------------------------------------------------------------------------------------------
// Schemas
// -------------------------------------------------------------------------------------------------

const idField = z.uuid({ error: "Reload the page and try again." });
const tokenField = z.string({ error: "Reload the page and try again." }).min(1, { error: "Reload the page and try again." });
const instantField = (what: string) =>
  z
    .string({ error: `Choose when the cover ${what}.` })
    .min(1, { error: `Choose when the cover ${what}.` })
    .refine((v) => !Number.isNaN(Date.parse(v)), { error: `Choose when the cover ${what}.` });

const optionalNote = (max: number) =>
  z
    .string()
    .trim()
    .max(max, { error: `Keep it under ${max.toLocaleString("en-IN")} characters.` })
    .nullish()
    .transform((v) => (v ? v : null));

export const COVER_SPLIT_MAX = 200;

/**
 * One grant (§4.7 Fields): a client cover, a person cover, or a split of a person's clients into
 * client covers (People → person → Cover their clients). The window, reason and notes apply to all.
 */
export const GrantCoverSchema = z
  .object({
    mode: z.enum(["client", "person", "split"]),
    cover_employee_id: z.uuid({ error: "Choose who covers." }).nullish(),
    absent_employee_id: z.uuid({ error: "Choose who is away." }).nullish(),
    client_id: z.uuid({ error: "Choose the client." }).nullish(),
    splits: z
      .array(z.object({ client_id: idField, cover_employee_id: z.uuid().nullish() }))
      .max(COVER_SPLIT_MAX, { error: `Split at most ${COVER_SPLIT_MAX} clients at a time.` })
      .optional(),
    starts_at: instantField("starts"),
    ends_at: instantField("ends"),
    reason: z.enum(COVER_REASONS, { error: "Choose the reason." }),
    note: optionalNote(1000),
    handover_note: optionalNote(2000),
    include_vault: z.boolean().default(false),
    email_cover_person: z.boolean().default(true),
    leave_id: z.uuid().nullish(),
  })
  .superRefine((d, ctx) => {
    if (d.mode === "split") {
      if (!d.absent_employee_id) ctx.addIssue({ code: "custom", path: ["absent_employee_id"], message: "Choose who is away." });
      const chosen = (d.splits ?? []).filter((s) => s.cover_employee_id);
      if (chosen.length === 0) ctx.addIssue({ code: "custom", path: ["splits"], message: "Choose who covers at least one client." });
      if (chosen.some((s) => s.cover_employee_id === d.absent_employee_id)) {
        ctx.addIssue({ code: "custom", path: ["splits"], message: "Nobody can cover for themselves." });
      }
      return;
    }
    if (!d.cover_employee_id) ctx.addIssue({ code: "custom", path: ["cover_employee_id"], message: "Choose who covers." });
    if (d.mode === "person" && !d.absent_employee_id) {
      ctx.addIssue({ code: "custom", path: ["absent_employee_id"], message: "Choose who is away: a person cover is for someone's clients." });
    }
    if (d.mode === "client" && !d.client_id) ctx.addIssue({ code: "custom", path: ["client_id"], message: "Choose the client." });
  });
export type GrantCoverInput = z.input<typeof GrantCoverSchema>;
export type GrantCoverValues = z.output<typeof GrantCoverSchema>;

/** Extend (§4.7, Partner/Manager): a later Until, at most 90 days from the cover's From. */
export const ExtendCoverSchema = z.object({ id: idField, updated_at: tokenField, ends_at: instantField("ends") });
export type ExtendCoverInput = z.input<typeof ExtendCoverSchema>;

/** End now (Partner/Manager) or "I'm back, end cover" (the absent person). */
export const EndCoverSchema = z.object({
  id: idField,
  updated_at: tokenField,
  reason: optionalNote(300),
});
export type EndCoverInput = z.input<typeof EndCoverSchema>;

/** The cover person's optional note back (§4.7 "asked for an optional note back"). */
export const ReturnNoteSchema = z.object({
  id: idField,
  return_note: z
    .string({ error: "Write the note, or close this." })
    .trim()
    .min(1, { error: "Write the note, or close this." })
    .max(2000, { error: "Keep it under 2,000 characters." }),
});
export type ReturnNoteInput = z.input<typeof ReturnNoteSchema>;

/** "Anita covers all of Ravi's clients, 23–25 Oct" style windows for titles and timeline entries. */
export function coverWindowText(startsAt: Date | string, endsAt: Date | string): string {
  const s = istDateTimeParts(startsAt).date;
  const e = istDateTimeParts(new Date(new Date(endsAt).getTime() - 1)).date;
  const fmt = (d: string, withMonth: boolean) => {
    const [, m, day] = d.split("-").map(Number);
    const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1];
    return withMonth ? `${day} ${mon}` : String(day);
  };
  if (s === e) return fmt(s, true);
  const sameMonth = s.slice(0, 7) === e.slice(0, 7);
  return sameMonth ? `${fmt(s, false)}–${fmt(e, true)}` : `${fmt(s, true)} – ${fmt(e, true)}`;
}

/**
 * The last day a cover reaches, as "25 Oct", for "until 25 Oct" in titles and emails. A cover that
 * ends exactly at midnight reaches the day before (the window is half-open, like covers_in_force).
 */
export function coverEndDayText(endsAt: Date | string): string {
  const end = new Date(endsAt);
  return coverWindowText(new Date(end.getTime() - 1), end);
}
