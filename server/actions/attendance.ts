"use server";

import { defineAction, throwIfDbError } from "@/lib/action";
import { fail, ok, type ActionResult } from "@/lib/result";
import { ATTENDANCE_STATUS_LABELS, attendanceCorrectionError } from "@/lib/domain/attendance";
import type { AttendanceStatus } from "@/lib/domain/enums";
import { AttendanceCorrectionSchema } from "@/lib/schemas/leave";
import { canManagePerson, manageRefusal, type StaffRole } from "@/lib/schemas/people";
import { formatDate } from "@/lib/format";
import { notify } from "@/server/notify";

/**
 * Attendance corrections (§7.12): a Partner or Manager corrects a day's status with a reason,
 * stored on the record and in the audit log. Managers correct Employees only (§4.1; the 0105
 * guard refuses the rest too). Jobs write everything else.
 */
export const correctAttendance = defineAction(
  { name: "attendance.correct", schema: AttendanceCorrectionSchema, roles: ["partner", "manager"] },
  async (input, ctx): Promise<ActionResult<{ updated_at: string }>> => {
    const problem = attendanceCorrectionError({ actorRole: ctx.user.role, status: input.status, reason: input.reason });
    if (problem) return fail(problem, { code: "validation", fieldErrors: { reason: [problem] } });

    const { data: person, error: pError } = await ctx.supabase.from("people_overview").select("id, full_name, role, profile_id").eq("id", input.employee_id).maybeSingle();
    throwIfDbError(pError);
    if (!person) return fail("That person wasn't found.", { code: "not_found" });
    if (!canManagePerson(ctx.user.role, (person.role ?? "employee") as StaffRole)) return fail(manageRefusal(ctx.user.role), { code: "forbidden" });
    if (person.profile_id === ctx.user.id && ctx.user.role !== "partner") return fail("Ask a Partner to correct your own attendance.", { code: "forbidden" });

    const { data: before, error: bError } = await ctx.supabase
      .from("attendance_records")
      .select("status, updated_at")
      .eq("employee_id", input.employee_id)
      .eq("date", input.date)
      .maybeSingle();
    throwIfDbError(bError);

    const values = { status: input.status as AttendanceStatus, corrected_by: ctx.user.id, correction_reason: input.reason };
    let updatedAt: string;
    if (before) {
      if (!input.updated_at || Date.parse(input.updated_at) !== Date.parse(before.updated_at)) {
        return fail("This day was changed after you opened it. Reload to see the changes.", { code: "conflict" });
      }
      const { data, error } = await ctx.supabase
        .from("attendance_records")
        .update(values)
        .eq("employee_id", input.employee_id)
        .eq("date", input.date)
        .eq("updated_at", before.updated_at)
        .select("updated_at");
      throwIfDbError(error);
      if (!data?.length) return fail("This day was changed after you opened it. Reload to see the changes.", { code: "conflict" });
      updatedAt = data[0].updated_at;
    } else {
      const { data, error } = await ctx.supabase
        .from("attendance_records")
        .insert({ employee_id: input.employee_id, date: input.date, ...values })
        .select("updated_at")
        .single();
      throwIfDbError(error, { uniqueMessage: "A record for this day was added meanwhile. Reload to see it." });
      updatedAt = data!.updated_at;
    }

    await ctx.audit({
      event: "data_update",
      resourceType: "attendance_records",
      resourceId: `${input.employee_id}:${input.date}`,
      action: "attendance.correct",
      details: { employee_id: input.employee_id, date: input.date, before: before?.status ?? null, after: input.status, reason: input.reason },
    });
    if (person.profile_id && person.profile_id !== ctx.user.id) {
      const userId = person.profile_id;
      ctx.after("Tell them about the correction", () =>
        notify({
          to: { userIds: [userId] },
          type: "info",
          title: `Your attendance for ${formatDate(input.date)} is now ${ATTENDANCE_STATUS_LABELS[input.status as AttendanceStatus]}`,
          body: `${ctx.user.fullName} corrected it: ${input.reason}`,
          linkUrl: `/people/${input.employee_id}?tab=attendance&month=${input.date.slice(0, 7)}`,
          entity: { type: "employee", id: input.employee_id },
        }),
      );
    }
    return ok({ updated_at: updatedAt });
  },
);
