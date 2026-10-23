"use server";

import { defineAction, throwIfDbError } from "@/lib/action";
import { ActionError, fail, ok, type ActionResult } from "@/lib/result";
import { STAFF_ROLES } from "@/lib/auth/roles";
import { addDays, diffDays, istDayBounds, todayIST, type DateString } from "@/lib/domain/fy";
import { formatMinutes } from "@/lib/format";
import {
  AddRowSchema,
  ApproveWeekSchema,
  CopyLastWeekSchema,
  DeleteEntrySchema,
  MAX_ENTRY_MINUTES,
  RemoveRowSchema,
  ReopenWeekSchema,
  SetCellSchema,
  StartTimerSchema,
  StopTimerSchema,
  TimeEntrySchema,
  entryTimes,
  parseDuration,
  rowsToCopy,
  weekLabel,
} from "@/lib/schemas/timesheet";
import { getRowsOfWeek } from "@/lib/data/timesheet";
import { logEmployeeActivity } from "@/server/activity";
import type { ActionContext } from "@/lib/action";

/**
 * Timesheet mutations (§7.10): the timer (one running timer per person, kept on the server, so it
 * survives reloads and devices), manual entries (start and end, or a duration), the week grid's
 * cells and rows, copying last week's rows, and Partners' and Managers' week approval and reopening
 * (which lock and unlock the week's entries). Billed entries and approved weeks are read-only; the
 * database refuses changes to them for everyone (time_entries_guard, 0132).
 */

const PM = ["partner", "manager"] as const;

function me(ctx: ActionContext): string {
  if (!ctx.user.employeeId) throw new ActionError("Your team record is missing, so time can't be logged. Ask a Partner.", { code: "forbidden" });
  return ctx.user.employeeId;
}

/** Puts the database's refusals on the right field of the entry form. */
function entryError(error: { message?: string; code?: string } | null): void {
  const msg = error?.message ?? "";
  if (!msg.startsWith("USER: ")) return;
  const text = msg.slice(6);
  const field = /approved and locked|future date/.test(text)
    ? "date"
    : /later than now|end time/.test(text)
      ? "end"
      : /24 hours|how long/.test(text)
        ? "duration"
        : /another client/.test(text)
          ? "task_id"
          : null;
  throw new ActionError(text, { code: /locked/.test(text) ? "blocked" : "validation", fieldErrors: field ? { [field]: [text] } : undefined });
}

// =================================================================================================
// Timer
// =================================================================================================

export const startTimer = defineAction(
  { name: "timesheet.timer.start", schema: StartTimerSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<{ entry_id: string; started_at: string; stopped_minutes: number | null }>> => {
    me(ctx);
    const { data, error } = await ctx.supabase.rpc("start_timer", {
      p_task_id: input.task_id ?? undefined,
      p_client_id: input.client_id ?? undefined,
      p_description: input.description ?? undefined,
      p_billable: input.billable ?? undefined,
    });
    if (error?.code === "23505") return fail("A timer is already running. Reload to see it.", { code: "conflict" });
    throwIfDbError(error);
    const r = data as { entry_id: string; started_at: string; stopped_entry_id: string | null; stopped_minutes: number | null; task_id: string | null; client_id: string | null };
    await ctx.audit({ event: "data_create", resourceType: "time_entry", resourceId: r.entry_id, action: "timesheet.timer.start", details: { task_id: r.task_id, client_id: r.client_id, stopped_entry_id: r.stopped_entry_id } });
    ctx.after("Add to your activity", () =>
      logEmployeeActivity({ activityType: "timer_started", description: r.stopped_entry_id ? `Switched the timer (stopped after ${formatMinutes(r.stopped_minutes)})` : "Started the timer", entityType: r.task_id ? "task" : r.client_id ? "client" : null, entityId: r.task_id ?? r.client_id }),
    );
    return ok({ entry_id: r.entry_id, started_at: r.started_at, stopped_minutes: r.stopped_entry_id ? r.stopped_minutes : null });
  },
);

export const stopTimer = defineAction(
  { name: "timesheet.timer.stop", schema: StopTimerSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<{ entry_id: string; minutes: number }>> => {
    me(ctx);
    const { data, error } = await ctx.supabase.rpc("stop_timer", { p_description: input.description ?? undefined });
    throwIfDbError(error);
    const r = data as { entry_id: string; minutes: number; task_id: string | null; client_id: string | null };
    await ctx.audit({ event: "data_update", resourceType: "time_entry", resourceId: r.entry_id, action: "timesheet.timer.stop", details: { minutes: r.minutes, task_id: r.task_id } });
    ctx.after("Add to your activity", () =>
      logEmployeeActivity({ activityType: "time_logged", description: `Logged ${formatMinutes(r.minutes)} with the timer`, entityType: r.task_id ? "task" : r.client_id ? "client" : null, entityId: r.task_id ?? r.client_id }),
    );
    return ok({ entry_id: r.entry_id, minutes: r.minutes });
  },
);

// =================================================================================================
// Manual entries (§7.10 "Manual entry")
// =================================================================================================

export const saveTimeEntry = defineAction(
  { name: "timesheet.entry.save", schema: TimeEntrySchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<{ id: string; minutes: number }>> => {
    const employeeId = me(ctx);
    if (diffDays(input.date, todayIST()) > 0) return fail("Time can't be logged for a future date.", { code: "validation", fieldErrors: { date: ["Choose today or an earlier date."] } });
    const t = entryTimes(input);
    if (!t.ok) return fail(t.error, { code: "validation", fieldErrors: { [t.field]: [t.error] } });
    const row = {
      client_id: input.client_id,
      task_id: input.task_id,
      description: input.description,
      started_at: t.started_at,
      ended_at: t.ended_at,
      minutes: t.minutes,
      billable: input.client_id || input.task_id ? input.billable : false,
      entry_source: t.entry_source,
    };
    if (input.id) {
      let q = ctx.supabase.from("time_entries").update(row).eq("id", input.id).eq("employee_id", employeeId);
      if (input.expected_updated_at) q = q.eq("updated_at", input.expected_updated_at);
      const { data, error } = await q.select("id, minutes");
      entryError(error);
      throwIfDbError(error);
      if (!data || data.length === 0) {
        const { data: still } = await ctx.supabase.from("time_entries").select("locked, invoice_id, employee_id").eq("id", input.id).maybeSingle();
        if (!still) return fail("That entry no longer exists.", { code: "not_found" });
        if (still.locked || still.invoice_id) return fail("This entry is locked (billed, or in an approved week), so it can't be changed.", { code: "blocked" });
        if (still.employee_id !== employeeId) return fail("You can change only your own time.", { code: "forbidden" });
        return fail("This entry was changed somewhere else. Reload to see the latest.", { code: "conflict" });
      }
      await ctx.audit({ event: "data_update", resourceType: "time_entry", resourceId: input.id, details: { minutes: data[0].minutes, date: input.date, task_id: input.task_id, client_id: input.client_id } });
      return ok({ id: input.id, minutes: data[0].minutes });
    }
    const { data, error } = await ctx.supabase.from("time_entries").insert({ ...row, employee_id: employeeId }).select("id, minutes").single();
    entryError(error);
    throwIfDbError(error);
    await ctx.audit({ event: "data_create", resourceType: "time_entry", resourceId: data!.id, details: { minutes: data!.minutes, date: input.date, task_id: input.task_id, client_id: input.client_id, source: t.entry_source } });
    ctx.after("Add to your activity", () =>
      logEmployeeActivity({ activityType: "time_logged", description: `Logged ${formatMinutes(data!.minutes)} for ${input.date}`, entityType: input.task_id ? "task" : input.client_id ? "client" : null, entityId: input.task_id ?? input.client_id }),
    );
    return ok({ id: data!.id, minutes: data!.minutes });
  },
);

export const deleteTimeEntry = defineAction(
  { name: "timesheet.entry.delete", schema: DeleteEntrySchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const employeeId = me(ctx);
    const { data, error } = await ctx.supabase.from("time_entries").delete().eq("id", input.id).eq("employee_id", employeeId).select("id, minutes");
    entryError(error);
    throwIfDbError(error);
    if (!data || data.length === 0) return fail("That entry is locked or no longer yours to remove.", { code: "blocked" });
    await ctx.audit({ event: "data_delete", resourceType: "time_entry", resourceId: input.id, details: { minutes: data[0].minutes } });
    return ok({ id: input.id });
  },
);

// =================================================================================================
// Week grid (§7.10 "My timesheet")
// =================================================================================================

function inWeek(monday: DateString, date: DateString): boolean {
  const d = diffDays(date, monday);
  return d >= 0 && d <= 6;
}

/** A grid cell typed in: sets the day's duration for the row (one duration entry), or clears it. */
export const setGridCell = defineAction(
  { name: "timesheet.grid.cell", schema: SetCellSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<{ id: string | null; minutes: number }>> => {
    const employeeId = me(ctx);
    if (!inWeek(input.week_start, input.date)) return fail("That day isn't in this week.", { code: "validation" });
    if (diffDays(input.date, todayIST()) > 0) return fail("Time can't be logged for a future date.", { code: "validation", fieldErrors: { duration: ["Not a future day."] } });
    const minutes = input.duration.trim() === "" ? 0 : parseDuration(input.duration);
    if (minutes === null || minutes < 0) return fail("Enter time like 1:30 or 1h 30m.", { code: "validation", fieldErrors: { duration: ["Enter time like 1:30 or 1h 30m."] } });
    if (minutes > MAX_ENTRY_MINUTES) return fail("A day can't hold more than 24 hours.", { code: "validation", fieldErrors: { duration: ["At most 24 hours."] } });

    if (input.entry_id) {
      if (minutes === 0) {
        const { data, error } = await ctx.supabase.from("time_entries").delete().eq("id", input.entry_id).eq("employee_id", employeeId).eq("entry_source", "manual_duration").select("id");
        entryError(error);
        throwIfDbError(error);
        if (!data?.length) return fail("That time is locked or no longer there. Reload to see the latest.", { code: "conflict" });
        await ctx.audit({ event: "data_delete", resourceType: "time_entry", resourceId: input.entry_id, action: "timesheet.grid.cell" });
        return ok({ id: null, minutes: 0 });
      }
      const { data, error } = await ctx.supabase.from("time_entries").update({ minutes }).eq("id", input.entry_id).eq("employee_id", employeeId).eq("entry_source", "manual_duration").select("id, minutes");
      entryError(error);
      throwIfDbError(error);
      if (!data?.length) return fail("That time is locked or no longer there. Reload to see the latest.", { code: "conflict" });
      await ctx.audit({ event: "data_update", resourceType: "time_entry", resourceId: input.entry_id, action: "timesheet.grid.cell", details: { minutes } });
      return ok({ id: input.entry_id, minutes });
    }
    if (minutes === 0) return ok({ id: null, minutes: 0 });
    const { data, error } = await ctx.supabase
      .from("time_entries")
      .insert({
        employee_id: employeeId,
        client_id: input.client_id,
        task_id: input.task_id,
        started_at: istDayBounds(input.date).start.toISOString(),
        minutes,
        billable: input.client_id || input.task_id ? input.billable : false,
        entry_source: "manual_duration",
      })
      .select("id, minutes")
      .single();
    entryError(error);
    throwIfDbError(error);
    await ctx.audit({ event: "data_create", resourceType: "time_entry", resourceId: data!.id, action: "timesheet.grid.cell", details: { minutes, date: input.date } });
    return ok({ id: data!.id, minutes: data!.minutes });
  },
);

export const addGridRow = defineAction(
  { name: "timesheet.grid.add_row", schema: AddRowSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const employeeId = me(ctx);
    const { data: last } = await ctx.supabase.from("timesheet_week_rows").select("sort_order").eq("employee_id", employeeId).eq("week_start", input.week_start).order("sort_order", { ascending: false }).limit(1);
    const { data, error } = await ctx.supabase
      .from("timesheet_week_rows")
      .insert({ employee_id: employeeId, week_start: input.week_start, client_id: input.client_id, task_id: input.task_id, billable: input.billable, sort_order: (last?.[0]?.sort_order ?? -1) + 1 })
      .select("id")
      .single();
    throwIfDbError(error, { uniqueMessage: "That row is already on this week." });
    await ctx.audit({ event: "data_create", resourceType: "timesheet_week_row", resourceId: data!.id, details: { week_start: input.week_start, client_id: input.client_id, task_id: input.task_id } });
    return ok({ id: data!.id });
  },
);

export const removeGridRow = defineAction(
  { name: "timesheet.grid.remove_row", schema: RemoveRowSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const employeeId = me(ctx);
    const { data, error } = await ctx.supabase.from("timesheet_week_rows").delete().eq("id", input.id).eq("employee_id", employeeId).select("id");
    throwIfDbError(error);
    if (data?.length) await ctx.audit({ event: "data_delete", resourceType: "timesheet_week_row", resourceId: input.id });
    return ok({ id: input.id });
  },
);

/** §7.10 "copy last week's rows": the clients and tasks of last week appear on this week's grid, empty. */
export const copyLastWeekRows = defineAction(
  { name: "timesheet.grid.copy_last_week", schema: CopyLastWeekSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<{ added: number }>> => {
    const employeeId = me(ctx);
    const [last, current] = await Promise.all([getRowsOfWeek(ctx.supabase, employeeId, addDays(input.week_start, -7)), getRowsOfWeek(ctx.supabase, employeeId, input.week_start)]);
    // Filed tasks don't come along: nothing more to log on them.
    const taskIds = last.map((r) => r.task_id).filter((v): v is string => Boolean(v));
    const filed = new Set<string>();
    if (taskIds.length) {
      const { data } = await ctx.supabase.from("tasks").select("id, status, deleted_at").in("id", taskIds);
      for (const t of data ?? []) if (t.status === "filed_done" || t.deleted_at) filed.add(t.id);
    }
    const copy = rowsToCopy(last.filter((r) => !r.task_id || !filed.has(r.task_id)), current);
    if (copy.length === 0) return ok({ added: 0 });
    const { data: tail } = await ctx.supabase.from("timesheet_week_rows").select("sort_order").eq("employee_id", employeeId).eq("week_start", input.week_start).order("sort_order", { ascending: false }).limit(1);
    const start = (tail?.[0]?.sort_order ?? -1) + 1;
    const { error } = await ctx.supabase
      .from("timesheet_week_rows")
      .insert(copy.map((r, i) => ({ employee_id: employeeId, week_start: input.week_start, client_id: r.client_id, task_id: r.task_id, billable: r.billable, sort_order: start + i })));
    throwIfDbError(error, { uniqueMessage: "Some of those rows are already on this week. Reload to see them." });
    await ctx.audit({ event: "data_create", resourceType: "timesheet_week_row", action: "timesheet.grid.copy_last_week", details: { week_start: input.week_start, rows: copy.length } });
    return ok({ added: copy.length });
  },
);

// =================================================================================================
// Week approval (§7.10 "A Partner/Manager can approve a week, which locks it")
// =================================================================================================

export const approveTimesheetWeek = defineAction(
  { name: "timesheet.week.approve", schema: ApproveWeekSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ entries: number; minutes: number }>> => {
    const { data, error } = await ctx.supabase.rpc("approve_timesheet_week", { p_employee_id: input.employee_id, p_week_start: input.week_start, p_note: input.note ?? undefined });
    throwIfDbError(error);
    const r = data as { approval_id: string; entries: number; minutes: number; locked: number };
    await ctx.audit({
      event: "data_update",
      resourceType: "timesheet_week",
      resourceId: r.approval_id,
      action: "timesheet.week.approve",
      details: { employee_id: input.employee_id, week_start: input.week_start, week: weekLabel(input.week_start), entries: r.entries, minutes: r.minutes, locked: r.locked },
    });
    return ok({ entries: r.entries, minutes: r.minutes });
  },
);

export const reopenTimesheetWeek = defineAction(
  { name: "timesheet.week.reopen", schema: ReopenWeekSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ unlocked: number; billed: number }>> => {
    const { data, error } = await ctx.supabase.rpc("reopen_timesheet_week", { p_employee_id: input.employee_id, p_week_start: input.week_start, p_reason: input.reason });
    if (error?.message?.startsWith("USER: Give a reason")) throw new ActionError(error.message.slice(6), { code: "validation", fieldErrors: { reason: [error.message.slice(6)] } });
    throwIfDbError(error);
    const r = data as { approval_id: string; unlocked: number; billed_still_locked: number };
    await ctx.audit({
      event: "data_update",
      resourceType: "timesheet_week",
      resourceId: r.approval_id,
      action: "timesheet.week.reopen",
      details: { employee_id: input.employee_id, week_start: input.week_start, reason: input.reason, unlocked: r.unlocked, billed_still_locked: r.billed_still_locked },
    });
    return ok({ unlocked: r.unlocked, billed: r.billed_still_locked });
  },
);
