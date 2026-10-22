/**
 * Cover access: letting a colleague work on an absent person's clients for a fixed period (§4.7,
 * §5.13 `client_covers`, §4.6 `can_see_client`).
 *
 * - **Two kinds:** a client cover (one client) and a person cover (every client the absent person
 *   owns or is on the team of, including clients assigned to them during the cover).
 * - **In force** while `now ≥ starts_at`, `now < ends_at` and not revoked (`covers_in_force`). Access
 *   ends by itself at Until; nothing has to be switched off.
 * - **Limits:** Partners and Managers grant; only a Partner ticks Include portal passwords; no
 *   covering yourself; no cover for or by a disabled person; Until after From, at most 90 days;
 *   From can't be in the past; a person cover needs the absent person, a client cover the client.
 * - **Merging:** overlapping covers for the same client (or the same absent person) and the same
 *   cover person merge into one, and the later end wins.
 * - **Quick picks** for Until: end of today (23:59 IST) · end of tomorrow · end of this week · until
 *   their leave ends.
 * - `canSeeClient` mirrors the SQL helper `can_see_client(cid)` (§4.6) and must stay in step with it.
 *
 * The 90-day cap, the end-of-day time and the no-show grace are parameters (`COVER_DEFAULTS`).
 * Pure and client-safe; "now" is always passed in.
 */

import type { AppRole, CoverKind } from "@/lib/domain/enums";
import { addDays, diffDays, istDateOf, istDayBounds, isoWeekday, MONTH_ABBR, nowIST, todayIST, type DateString } from "@/lib/domain/fy";
import { instantMs, type Instant } from "@/lib/domain/presence";
import { parseTimeOfDay } from "@/lib/domain/attendance";
import { formatDayMonth } from "@/lib/domain/leave";
import type { FieldErrors } from "@/lib/result";

export type CoverParams = {
  /** A cover lasts at most this many days (`ends_at <= starts_at + interval '90 days'`). */
  maxDays: number;
  /** Quick picks end the day at this IST time ("end of today 23:59 IST"). */
  endOfDayTime: string;
  /** From may be this many minutes behind now (the form's "now" default ages while it is filled in). */
  startGraceMinutes: number;
  /** Absent without cover: not signed in by start + grace + this many minutes (§8, 10:00 job). */
  noShowAfterMinutes: number;
  /** Absent without cover: their clients have tasks due within this many days (§7.2, §8). */
  tasksDueWithinDays: number;
};

/** The §4.7 / §8 values. */
export const COVER_DEFAULTS: CoverParams = {
  maxDays: 90,
  endOfDayTime: "23:59",
  startGraceMinutes: 5,
  noShowAfterMinutes: 30,
  tasksDueWithinDays: 2,
};

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** The `client_covers` columns these rules read. */
export type CoverRecord = {
  id?: string;
  kind: CoverKind;
  clientId: string | null;
  absentEmployeeId: string | null;
  coverEmployeeId: string;
  startsAt: Instant;
  endsAt: Instant;
  revokedAt?: Instant | null;
  expiryLoggedAt?: Instant | null;
  includeVault?: boolean;
};

// -------------------------------------------------------------------------------------------------
// In force (§4.7, `covers_in_force`)
// -------------------------------------------------------------------------------------------------

/** True while the cover is in force: `now ≥ starts_at`, `now < ends_at`, and never revoked. */
export function isInForce(cover: Pick<CoverRecord, "startsAt" | "endsAt" | "revokedAt">, now: Instant): boolean {
  if (cover.revokedAt !== null && cover.revokedAt !== undefined) return false;
  const t = instantMs(now);
  return t >= instantMs(cover.startsAt) && t < instantMs(cover.endsAt);
}

export type CoverState = "scheduled" | "in_force" | "ended" | "revoked";

/** Where the cover is in its life: revoked (ended early), scheduled, in force, or ended at Until. */
export function coverState(cover: Pick<CoverRecord, "startsAt" | "endsAt" | "revokedAt">, now: Instant): CoverState {
  if (cover.revokedAt !== null && cover.revokedAt !== undefined) return "revoked";
  const t = instantMs(now);
  if (t < instantMs(cover.startsAt)) return "scheduled";
  return t < instantMs(cover.endsAt) ? "in_force" : "ended";
}

/** The covers in force now (the `covers_in_force` view). */
export function coversInForce<C extends CoverRecord>(covers: readonly C[], now: Instant): C[] {
  return covers.filter((c) => isInForce(c, now));
}

/** The hourly job records the automatic end once (§8): ended at Until, not revoked, not yet logged. */
export function needsExpiryLog(cover: CoverRecord, now: Instant): boolean {
  return coverState(cover, now) === "ended" && (cover.expiryLoggedAt === null || cover.expiryLoggedAt === undefined);
}

/** "Cover ends tomorrow" goes to the granter (§8): the cover is live and its Until falls on tomorrow's IST date. */
export function endsTomorrow(cover: CoverRecord, now: Instant): boolean {
  const state = coverState(cover, now);
  if (state !== "in_force" && state !== "scheduled") return false;
  return istDateOf(new Date(instantMs(cover.endsAt))) === addDays(todayIST(new Date(instantMs(now))), 1);
}

// -------------------------------------------------------------------------------------------------
// Which clients a cover reaches (§4.7)
// -------------------------------------------------------------------------------------------------

/** One client's owner and engagement team (`clients.owner_employee_id`, `client_team_members`). */
export type ClientAccessRow = { clientId: string; ownerEmployeeId: string | null; teamEmployeeIds: readonly string[] };

/** A `client_team_members` row. */
export type TeamRow = { clientId: string; employeeId: string };

/** Builds `ClientAccessRow`s from client rows and team rows as the database returns them. */
export function buildClientAccessRows(clients: readonly { id: string; ownerEmployeeId: string | null }[], team: readonly TeamRow[]): ClientAccessRow[] {
  const byClient = new Map<string, string[]>();
  for (const t of team) {
    const list = byClient.get(t.clientId) ?? [];
    if (!list.includes(t.employeeId)) list.push(t.employeeId);
    byClient.set(t.clientId, list);
  }
  return clients.map((c) => ({ clientId: c.id, ownerEmployeeId: c.ownerEmployeeId, teamEmployeeIds: byClient.get(c.id) ?? [] }));
}

/** True when the employee owns the client or is on its team. */
export function isOwnerOrTeam(employeeId: string, row: ClientAccessRow): boolean {
  return row.ownerEmployeeId === employeeId || row.teamEmployeeIds.includes(employeeId);
}

/** The clients an employee owns or is on the team of, in the order given. */
export function clientsOfEmployee(employeeId: string, rows: readonly ClientAccessRow[]): string[] {
  return rows.filter((r) => isOwnerOrTeam(employeeId, r)).map((r) => r.clientId);
}

/**
 * The clients a person cover reaches now (§4.7): every client the absent person owns or is on the
 * team of **today**, so clients assigned to them during the cover are included. Empty when the
 * cover isn't a person cover or isn't in force.
 */
export function clientsReachedByPersonCover(cover: CoverRecord, rows: readonly ClientAccessRow[], now: Instant): string[] {
  if (cover.kind !== "person" || !cover.absentEmployeeId || !isInForce(cover, now)) return [];
  return clientsOfEmployee(cover.absentEmployeeId, rows);
}

/** True when this cover (in force or not) reaches the client: its client, or the absent person's. */
export function coverReachesClient(cover: CoverRecord, row: ClientAccessRow): boolean {
  if (cover.kind === "client") return cover.clientId === row.clientId;
  return cover.absentEmployeeId !== null && isOwnerOrTeam(cover.absentEmployeeId, row);
}

/** The clients a cover person reaches through covers in force (client covers and person covers). */
export function clientsCoveredBy(coverEmployeeId: string, covers: readonly CoverRecord[], rows: readonly ClientAccessRow[], now: Instant): string[] {
  const live = covers.filter((c) => c.coverEmployeeId === coverEmployeeId && isInForce(c, now));
  return rows.filter((r) => live.some((c) => coverReachesClient(c, r))).map((r) => r.clientId);
}

// -------------------------------------------------------------------------------------------------
// can_see_client (§4.6)
// -------------------------------------------------------------------------------------------------

/** The signed-in person, as `app_role()` and `my_employee_id()` see them. */
export type ClientViewer = {
  role: AppRole | null;
  /** `profiles.is_active`: `app_role()` is null for a disabled profile. */
  isActive: boolean;
  employeeId?: string | null;
  /** `auth.uid()`, for the portal check. */
  userId?: string | null;
};

export type ViewedClient = { id: string; ownerEmployeeId: string | null; portalUserId?: string | null };

/**
 * Mirrors `can_see_client(cid)` (§4.6): Partners and Managers see every client. An Employee sees a
 * client they own or are on the team of, or one reached by a cover in force that they hold (a
 * client cover for it, or a person cover for a colleague who owns it or is on its team). A Client
 * sees only the client whose `portal_user_id` is theirs. A disabled or role-less profile sees none.
 */
export function canSeeClient(viewer: ClientViewer, client: ViewedClient, teams: readonly TeamRow[], covers: readonly CoverRecord[], now: Instant): boolean {
  if (!viewer.isActive || viewer.role === null) return false;
  if (viewer.role === "partner" || viewer.role === "manager") return true;
  if (viewer.role === "client") return !!viewer.userId && client.portalUserId === viewer.userId;
  const me = viewer.employeeId;
  if (!me) return false;
  const row: ClientAccessRow = {
    clientId: client.id,
    ownerEmployeeId: client.ownerEmployeeId,
    teamEmployeeIds: teams.filter((t) => t.clientId === client.id).map((t) => t.employeeId),
  };
  if (isOwnerOrTeam(me, row)) return true;
  return covers.some((c) => c.coverEmployeeId === me && isInForce(c, now) && coverReachesClient(c, row));
}

/**
 * Notifications about a covered client that go to the absent person also go to the cover person
 * while the cover is in force (§4.7, §9). Returns the cover people to add (not already listed). A
 * client cover with no absent person named stands in for the client's owner.
 */
export function coverRecipientsFor(recipientEmployeeIds: readonly string[], client: ClientAccessRow, covers: readonly CoverRecord[], now: Instant): string[] {
  const recipients = new Set(recipientEmployeeIds);
  const extra: string[] = [];
  for (const c of covers) {
    if (!isInForce(c, now) || !coverReachesClient(c, client)) continue;
    const absent = c.absentEmployeeId ?? (c.kind === "client" ? client.ownerEmployeeId : null);
    if (!absent || !recipients.has(absent)) continue;
    if (!recipients.has(c.coverEmployeeId) && !extra.includes(c.coverEmployeeId)) extra.push(c.coverEmployeeId);
  }
  return extra;
}

// -------------------------------------------------------------------------------------------------
// Validation (§4.7, §5.13 checks)
// -------------------------------------------------------------------------------------------------

export type CoverPerson = { isActive: boolean; leaves?: readonly { start: DateString; end: DateString; status?: string }[] };

export type CoverDraft = {
  kind: CoverKind;
  clientId: string | null;
  absentEmployeeId: string | null;
  coverEmployeeId: string | null;
  startsAt: Instant | null;
  endsAt: Instant | null;
  includeVault?: boolean;
};

export type CoverValidationInput = {
  draft: CoverDraft;
  actorRole: AppRole | null;
  /** The cover person's facts; null when not found. */
  coverPerson: CoverPerson | null;
  /** The absent person's facts; null when none is named or not found. */
  absentPerson: CoverPerson | null;
  now: Instant;
};

export type CoverValidation =
  | { ok: true; warnings: string[] }
  | { ok: false; error: string; fieldErrors: FieldErrors; warnings: string[] };

/** True when an approved (or status-less) leave of the person overlaps the window's IST dates. */
function onLeaveDuring(person: CoverPerson | null, startsAt: Instant, endsAt: Instant): { start: DateString; end: DateString } | null {
  if (!person?.leaves) return null;
  const first = istDateOf(new Date(instantMs(startsAt)));
  const last = istDateOf(new Date(instantMs(endsAt) - 1));
  return person.leaves.find((l) => (l.status === undefined || l.status === "approved") && diffDays(l.start, last) <= 0 && diffDays(first, l.end) <= 0) ?? null;
}

/**
 * Checks a new cover (§4.7, §5.13): who may grant it; Include portal passwords is Partner only; a
 * cover person who is active and isn't the absent person; an active absent person; the client for a
 * client cover and the absent person (and no client) for a person cover; From not in the past (a few
 * minutes' grace); Until after From and at most `maxDays` later. Warns (doesn't refuse) when the
 * cover person is on leave during the window.
 */
export function validateCover(input: CoverValidationInput, params: CoverParams = COVER_DEFAULTS): CoverValidation {
  const { draft } = input;
  const fieldErrors: FieldErrors = {};
  const warnings: string[] = [];
  const add = (field: string, message: string) => {
    (fieldErrors[field] ??= []).push(message);
  };

  if (input.actorRole !== "partner" && input.actorRole !== "manager") {
    return { ok: false, error: "Only Partners and Managers can grant cover.", fieldErrors: {}, warnings };
  }
  if (draft.includeVault && input.actorRole !== "partner") add("include_vault", "Only a Partner can include portal passwords.");

  if (!draft.coverEmployeeId) add("cover_employee_id", "Choose who covers.");
  else if (!input.coverPerson) add("cover_employee_id", "That person wasn't found.");
  else if (!input.coverPerson.isActive) add("cover_employee_id", "That person's account is disabled, so they can't cover.");

  if (draft.kind === "person") {
    if (!draft.absentEmployeeId) add("absent_employee_id", "Choose who is away: a person cover is for someone's clients.");
    if (draft.clientId) add("client_id", "A person cover covers all of their clients; leave the client empty.");
  } else if (!draft.clientId) {
    add("client_id", "Choose the client.");
  }
  if (draft.absentEmployeeId && draft.coverEmployeeId && draft.absentEmployeeId === draft.coverEmployeeId) {
    add("cover_employee_id", "Nobody can cover for themselves.");
  } else if (draft.absentEmployeeId && input.absentPerson && !input.absentPerson.isActive) {
    add("absent_employee_id", "That person's account is disabled. Reassign their work instead of covering it.");
  }

  if (!draft.startsAt) add("starts_at", "Choose when the cover starts.");
  if (!draft.endsAt) add("ends_at", "Choose when the cover ends.");
  if (draft.startsAt && draft.endsAt) {
    const start = instantMs(draft.startsAt);
    const end = instantMs(draft.endsAt);
    if (start < instantMs(input.now) - params.startGraceMinutes * MINUTE_MS) add("starts_at", "The cover can't start in the past.");
    if (end <= start) add("ends_at", "The cover must end after it starts.");
    else if (end - start > params.maxDays * DAY_MS) add("ends_at", `A cover can last at most ${params.maxDays} days.`);
    else {
      const leave = onLeaveDuring(input.coverPerson, draft.startsAt, draft.endsAt);
      if (leave) warnings.push(`The cover person is on leave during this window (${formatDayMonth(leave.start)} to ${formatDayMonth(leave.end)}).`);
    }
  }

  const fields = Object.keys(fieldErrors);
  if (fields.length === 0) return { ok: true, warnings };
  return { ok: false, error: fieldErrors[fields[0]][0], fieldErrors, warnings };
}

/**
 * Checks an Extend (§4.7, Partner/Manager): a live cover (not revoked, not ended) gets a later Until,
 * still at most `maxDays` after its From. A cover that has ended needs a new cover instead.
 */
export function validateExtension(
  input: { cover: CoverRecord; newEndsAt: Instant; actorRole: AppRole | null; now: Instant },
  params: CoverParams = COVER_DEFAULTS,
): { ok: true } | { ok: false; error: string } {
  if (input.actorRole !== "partner" && input.actorRole !== "manager") return { ok: false, error: "Only Partners and Managers can extend a cover." };
  const state = coverState(input.cover, input.now);
  if (state === "revoked") return { ok: false, error: "This cover was ended early. Add a new cover instead." };
  if (state === "ended") return { ok: false, error: "This cover has ended. Add a new cover instead." };
  const end = instantMs(input.newEndsAt);
  if (end <= instantMs(input.cover.endsAt)) return { ok: false, error: "Choose an end later than the current one." };
  if (end - instantMs(input.cover.startsAt) > params.maxDays * DAY_MS) return { ok: false, error: `A cover can last at most ${params.maxDays} days from its start.` };
  return { ok: true };
}

/**
 * Who may End now (§4.7): Partners and Managers, or the absent person ("I'm back, end cover"). Only a
 * cover that is still live can be ended.
 */
export function canEndCover(input: { cover: CoverRecord; actorRole: AppRole | null; actorEmployeeId: string | null; now: Instant }): { ok: true } | { ok: false; error: string } {
  const state = coverState(input.cover, input.now);
  if (state === "revoked" || state === "ended") return { ok: false, error: "This cover has already ended." };
  if (input.actorRole === "partner" || input.actorRole === "manager") return { ok: true };
  if (input.actorRole === "employee" && input.actorEmployeeId !== null && input.actorEmployeeId === input.cover.absentEmployeeId) return { ok: true };
  return { ok: false, error: "Only Partners, Managers or the person being covered can end a cover." };
}

/** The client cover's "Covering for" default: the client's owner (§4.7). */
export function defaultAbsentEmployee(clientOwnerEmployeeId: string | null): string | null {
  return clientOwnerEmployeeId;
}

// -------------------------------------------------------------------------------------------------
// Merging (§4.7 limits)
// -------------------------------------------------------------------------------------------------

/** Covers merge only with the same kind, the same client or absent person, and the same cover person. */
export function coverMergeKey(cover: Pick<CoverRecord, "kind" | "clientId" | "absentEmployeeId" | "coverEmployeeId">): string {
  return cover.kind === "client" ? `client|${cover.clientId ?? ""}|${cover.coverEmployeeId}` : `person|${cover.absentEmployeeId ?? ""}|${cover.coverEmployeeId}`;
}

/** True when two windows overlap (`[start, end)`; touching ends don't overlap). */
export function windowsOverlap(a: Pick<CoverRecord, "startsAt" | "endsAt">, b: Pick<CoverRecord, "startsAt" | "endsAt">): boolean {
  return instantMs(a.startsAt) < instantMs(b.endsAt) && instantMs(b.startsAt) < instantMs(a.endsAt);
}

export type MergedCover<C extends CoverRecord> = {
  kind: CoverKind;
  clientId: string | null;
  absentEmployeeId: string | null;
  coverEmployeeId: string;
  startsAt: Date;
  /** The later end wins. */
  endsAt: Date;
  /** The covers merged into this one, earliest first. */
  members: C[];
};

/**
 * Merges overlapping covers for the same client (or the same absent person) and the same cover
 * person into one each: earliest start, later end wins (§4.7). Revoked covers are left out. Result
 * ordered by start.
 */
export function mergeCovers<C extends CoverRecord>(covers: readonly C[]): MergedCover<C>[] {
  const groups = new Map<string, C[]>();
  for (const c of covers) {
    if (c.revokedAt !== null && c.revokedAt !== undefined) continue;
    const key = coverMergeKey(c);
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const out: MergedCover<C>[] = [];
  for (const list of groups.values()) {
    const sorted = [...list].sort((a, b) => instantMs(a.startsAt) - instantMs(b.startsAt));
    let current: MergedCover<C> | null = null;
    for (const c of sorted) {
      const start = instantMs(c.startsAt);
      const end = instantMs(c.endsAt);
      if (current && start < current.endsAt.getTime()) {
        if (end > current.endsAt.getTime()) current.endsAt = new Date(end);
        current.members.push(c);
        continue;
      }
      current = {
        kind: c.kind,
        clientId: c.clientId,
        absentEmployeeId: c.absentEmployeeId,
        coverEmployeeId: c.coverEmployeeId,
        startsAt: new Date(start),
        endsAt: new Date(end),
        members: [c],
      };
      out.push(current);
    }
  }
  return out.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

export type CoverGrantPlan =
  | { action: "create" }
  /** Widen the kept cover to the merged window and revoke the others it absorbed. */
  | { action: "merge"; keepId: string; startsAt: Date; endsAt: Date; revokeIds: string[] }
  | { action: "refuse"; error: string };

/**
 * How a new cover is saved against the existing ones (§4.7 merging): no overlap → create it; an
 * overlap with live covers of the same key → widen the earliest of them to the merged window (the
 * later end wins) and revoke any others it absorbs; refused when the merged cover would run past
 * `maxDays`. Existing covers must carry ids.
 */
export function planCoverGrant(draft: CoverRecord, existing: readonly CoverRecord[], params: CoverParams = COVER_DEFAULTS): CoverGrantPlan {
  const key = coverMergeKey(draft);
  const window = { startsAt: instantMs(draft.startsAt), endsAt: instantMs(draft.endsAt) };
  let overlapping = existing.filter((c) => (c.revokedAt === null || c.revokedAt === undefined) && coverMergeKey(c) === key && c.id);
  // Grow the window until no further same-key cover overlaps it (a new cover can bridge two).
  const absorbed: CoverRecord[] = [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of overlapping) {
      const s = instantMs(c.startsAt);
      const e = instantMs(c.endsAt);
      if (s < window.endsAt && window.startsAt < e) {
        window.startsAt = Math.min(window.startsAt, s);
        window.endsAt = Math.max(window.endsAt, e);
        absorbed.push(c);
        grew = true;
      }
    }
    overlapping = overlapping.filter((c) => !absorbed.includes(c));
  }
  if (absorbed.length === 0) return { action: "create" };
  if (window.endsAt - window.startsAt > params.maxDays * DAY_MS) {
    return { action: "refuse", error: `This overlaps an existing cover for the same person, and together they would run past ${params.maxDays} days. Shorten it or end the existing cover first.` };
  }
  const ordered = [...absorbed].sort((a, b) => instantMs(a.startsAt) - instantMs(b.startsAt));
  return {
    action: "merge",
    keepId: ordered[0].id as string,
    startsAt: new Date(window.startsAt),
    endsAt: new Date(window.endsAt),
    revokeIds: ordered.slice(1).map((c) => c.id as string),
  };
}

// -------------------------------------------------------------------------------------------------
// Quick picks and wording (§4.7)
// -------------------------------------------------------------------------------------------------

/** The instant an IST date ends for covers: `endOfDayTime` (23:59) IST on that date. */
export function endOfDayIST(date: DateString, params: CoverParams = COVER_DEFAULTS): Date {
  return new Date(istDayBounds(date).start.getTime() + parseTimeOfDay(params.endOfDayTime) * MINUTE_MS);
}

export type CoverQuickPickKey = "end_of_today" | "end_of_tomorrow" | "end_of_week" | "until_leave_ends";

export type CoverQuickPick = { key: CoverQuickPickKey; label: string; endsAt: Date };

export type QuickPickInput = {
  now: Instant;
  /** `firm_settings.working_weekdays`: "end of this week" is the end of the week's last working day. */
  weekdays: readonly number[];
  /** The absent person's leave (approved, or given without a status). */
  absentLeaves?: readonly { start: DateString; end: DateString; status?: string }[];
};

/**
 * The Until quick picks (§4.7): end of today (23:59 IST), end of tomorrow, end of this week (the
 * last working weekday of this Monday–Sunday week still ahead; Sunday when none is), and until the
 * absent person's leave ends (the leave in progress, else the next one). Picks already in the past
 * are left out; duplicates of an earlier pick are dropped.
 */
export function coverQuickPicks(input: QuickPickInput, params: CoverParams = COVER_DEFAULTS): CoverQuickPick[] {
  const nowMs = instantMs(input.now);
  const today = todayIST(new Date(nowMs));
  const picks: CoverQuickPick[] = [
    { key: "end_of_today", label: "End of today", endsAt: endOfDayIST(today, params) },
    { key: "end_of_tomorrow", label: "End of tomorrow", endsAt: endOfDayIST(addDays(today, 1), params) },
  ];

  const weekday = isoWeekday(today);
  const sunday = addDays(today, 7 - weekday);
  let weekEnd = sunday;
  for (let d = sunday; diffDays(d, today) >= 0; d = addDays(d, -1)) {
    if (input.weekdays.includes(isoWeekday(d))) {
      weekEnd = d;
      break;
    }
  }
  picks.push({ key: "end_of_week", label: "End of this week", endsAt: endOfDayIST(weekEnd, params) });

  const leaves = (input.absentLeaves ?? [])
    .filter((l) => (l.status === undefined || l.status === "approved") && diffDays(l.end, today) >= 0)
    .sort((a, b) => diffDays(a.start, b.start));
  const leave = leaves.find((l) => diffDays(today, l.start) >= 0) ?? leaves[0];
  if (leave) picks.push({ key: "until_leave_ends", label: `Until their leave ends (${formatDayMonth(leave.end)})`, endsAt: endOfDayIST(leave.end, params) });

  const seen = new Set<number>();
  return picks.filter((p) => {
    const t = p.endsAt.getTime();
    if (t <= nowMs || seen.has(t)) return false;
    seen.add(t);
    return true;
  });
}

const WEEKDAY_ABBR = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** `"Sat 25 Oct, 11:59 pm"`: an instant in IST as cover badges show it. */
export function formatCoverUntil(endsAt: Instant): string {
  const p = nowIST(new Date(instantMs(endsAt)));
  const hour12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const ampm = p.hour < 12 ? "am" : "pm";
  return `${WEEKDAY_ABBR[p.isoWeekday - 1]} ${String(p.day).padStart(2, "0")} ${MONTH_ABBR[p.month - 1]}, ${hour12}:${String(p.minute).padStart(2, "0")} ${ampm}`;
}

/** The badge on a covered client (§4.7): `"Covering for Ravi · until Sat 25 Oct, 11:59 pm"`. */
export function coverBadge(absentName: string, endsAt: Instant): string {
  return `Covering for ${absentName} · until ${formatCoverUntil(endsAt)}`;
}

// -------------------------------------------------------------------------------------------------
// Absent today without cover (§7.2, §8 10:00 job)
// -------------------------------------------------------------------------------------------------

export type AbsentWithoutCoverInput = {
  now: Instant;
  isWorkingDay: boolean;
  onLeaveToday: boolean;
  /** The person's first sign-in today, or null. */
  signedInAt: Instant | null;
  /** `firm_settings.work_day_start` and `late_grace_minutes`. */
  workDayStart: string;
  lateGraceMinutes: number;
  /** Their clients have open tasks due within `tasksDueWithinDays` (the caller counts them). */
  hasTasksDueSoon: boolean;
  /** A cover in force (or starting today) already reaches those clients. */
  hasCoverInForce: boolean;
};

/**
 * True when a person belongs on the Manager's "Absent today without cover" list (§7.2, §8): a
 * working day, on leave or not signed in by start + grace + `noShowAfterMinutes`, their clients
 * have tasks due soon, and no cover is in force.
 */
export function isAbsentWithoutCover(input: AbsentWithoutCoverInput, params: CoverParams = COVER_DEFAULTS): boolean {
  if (!input.isWorkingDay || !input.hasTasksDueSoon || input.hasCoverInForce) return false;
  if (input.onLeaveToday) return true;
  if (input.signedInAt !== null) return false;
  const cutoff = parseTimeOfDay(input.workDayStart) + input.lateGraceMinutes + params.noShowAfterMinutes;
  return nowIST(new Date(instantMs(input.now))).minutesOfDay > cutoff;
}
