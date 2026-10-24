"use server";

import { z } from "zod";
import { defineAction, throwIfDbError } from "@/lib/action";
import { fail, ok, type ActionResult } from "@/lib/result";
import { financialYearOf, isFinancialYear, todayIST } from "@/lib/domain/fy";
import { IndependenceSchema, storedAnswers } from "@/lib/schemas/quality";
import { getIndependenceRegister } from "@/lib/data/quality";
import { notify } from "@/server/notify";

/**
 * Independence declarations (§6.8 "independence is required for attest work", §7.15.4: annual, per
 * staff member, a yes/no questionnaire plus details). Every member of staff declares for themselves
 * (RLS 0039); any "yes" needs the details and the safeguards (0197 guard). A Partner can remind
 * everyone who hasn't declared for the year.
 */

const STAFF = ["partner", "manager", "employee"] as const;

export const saveDeclaration = defineAction(
  { name: "independence.declare", schema: IndependenceSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<{ id: string; declaredAt: string }>> => {
    const employeeId = ctx.user.employeeId;
    if (!employeeId) return fail("Your login isn't linked to a staff record. Ask a Partner.", { code: "forbidden" });
    if (input.employeeId && input.employeeId !== employeeId) return fail("Each person declares their own independence.", { code: "forbidden" });
    const current = financialYearOf(todayIST());
    if (input.financialYear > current) return fail("Declare for the current or an earlier financial year.", { code: "validation", fieldErrors: { financialYear: ["Choose this year or an earlier one."] } });

    const answers = storedAnswers(input.answers);
    const { data: existing, error: readError } = await ctx.supabase
      .from("independence_declarations")
      .select("id, updated_at")
      .eq("employee_id", employeeId)
      .eq("financial_year", input.financialYear)
      .maybeSingle();
    throwIfDbError(readError);

    let row: { id: string; declared_at: string };
    if (existing) {
      if (input.updatedAt && existing.updated_at !== input.updatedAt) return fail("Your declaration was changed in another window. Reload to see it.", { code: "conflict" });
      const { data, error } = await ctx.supabase.from("independence_declarations").update({ answers, details: input.details }).eq("id", existing.id).eq("updated_at", existing.updated_at).select("id, declared_at");
      throwIfDbError(error);
      if (!data?.length) return fail("Your declaration was changed in another window. Reload to see it.", { code: "conflict" });
      row = data[0];
    } else {
      const { data, error } = await ctx.supabase
        .from("independence_declarations")
        .insert({ employee_id: employeeId, financial_year: input.financialYear, answers, details: input.details })
        .select("id, declared_at")
        .single();
      throwIfDbError(error, { uniqueMessage: "You have already declared for this year. Reload to see it." });
      row = data!;
    }
    const exceptions = Object.entries(answers).filter(([, v]) => v).map(([k]) => k);
    await ctx.audit({ event: existing ? "data_update" : "data_create", resourceType: "independence_declaration", resourceId: row.id, details: { financial_year: input.financialYear, exceptions } });
    if (exceptions.length) {
      ctx.after("Tell the Partners about the exceptions", () =>
        notify({
          to: { roles: ["partner"] },
          type: "warning",
          title: `Independence: ${ctx.user.fullName} answered yes to ${exceptions.length} ${exceptions.length === 1 ? "question" : "questions"}`,
          body: `Their FY ${input.financialYear} declaration lists ${exceptions.length === 1 ? "an exception" : "exceptions"} with details and safeguards. Check them against the engagement teams.`,
          linkUrl: `/quality?tab=independence&fy=${input.financialYear}`,
          entity: { type: "independence_declaration", id: row.id },
          dedupeKey: `independence_exceptions:${row.id}:${row.declared_at}`,
        }),
      );
    }
    return ok({ id: row.id, declaredAt: row.declared_at });
  },
);

export const remindIndependence = defineAction(
  { name: "independence.remind", schema: z.object({ financialYear: z.string().refine(isFinancialYear, { error: "Choose the financial year." }) }), roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<{ reminded: number }>> => {
    const register = await getIndependenceRegister(ctx.supabase, input.financialYear);
    const pending = register.filter((r) => !r.declaration_id).map((r) => r.employee_id);
    if (!pending.length) return ok({ reminded: 0 });
    await ctx.audit({ event: "data_update", resourceType: "independence_declaration", action: "independence.remind", details: { financial_year: input.financialYear, people: pending.length } });
    ctx.after("Send the reminders", () =>
      notify({
        to: { employeeIds: pending },
        type: "info",
        title: `Your independence declaration for FY ${input.financialYear}`,
        body: `${ctx.user.fullName} asks everyone to complete the annual independence declaration: eight yes/no questions, with details for any yes.`,
        linkUrl: `/quality?tab=independence&fy=${input.financialYear}`,
        dedupeKey: `independence_reminder:${input.financialYear}:${todayIST()}`,
      }),
    );
    return ok({ reminded: pending.length });
  },
);
