/**
 * ITR computations and the notices register (§5.10, §6.11, §7.8.2, §7.8.4): migrations 0205–0207 —
 * save_itr_computation with the rule set copied from statutory_parameters (never trusted from the
 * caller), Draft → Reviewed (regime chosen by someone other than the preparer) → Final (Manager or
 * Partner) with Final locked; save_tax_notice and set_tax_notice_status with the column limits, the
 * running log, appeal limitation from the parameters and the automatic appeal task; and the read
 * models under each viewer's RLS (Employees: their own clients, §4.1).
 */
import { describe, expect, it } from "vitest";
import { C, F, SQLSTATE, U, setupTestDatabase, userMessage, type Session } from "./helpers";
import { addDays, addMonths, fyStart, todayIST } from "@/lib/domain/fy";
import { parseRuleSet } from "@/lib/domain/itr-rulesets";
import { ItrFormSchema, blankItrForm, computeStored, formToStoredInputs } from "@/lib/schemas/itr";

const db = setupTestDatabase("workpapers_itr_notices");
const today = todayIST();

// =================================================================================================
// ITR helpers
// =================================================================================================

type RuleRow = { id: string; value: unknown };

async function ruleRow(s: Session, fy: string): Promise<RuleRow> {
  return s.one<RuleRow>("select id, value from statutory_parameters where key = 'itr.ruleset' and effective_from = $1", [fyStart(fy)]);
}

function itrPayload(clientId: string, fy: string, rule: RuleRow, salary: string, extra: Record<string, unknown> = {}) {
  const parsed = parseRuleSet(rule.value);
  if (!parsed.ok) throw new Error(parsed.errors.join(" "));
  const startYear = Number(fy.slice(0, 4));
  const values = ItrFormSchema.parse(
    blankItrForm({ clientId, financialYear: fy, ageBand: "below_60", ageBandSource: "auto", filingDate: `${startYear + 1}-07-20`, dueDate: `${startYear + 1}-07-31`, returnKind: "non_business" }),
  );
  values.income.salaryGross = salary;
  const stored = formToStoredInputs(values, "individual");
  if (!stored.ok) throw new Error("inputs");
  const c = computeStored(stored.stored, parsed.ruleSet);
  if (!c.ok) throw new Error("compute");
  return { client_id: clientId, financial_year: fy, label: "Return as filed", inputs: stored.stored, results: c.result, rule_set: rule.value, rule_set_param_id: rule.id, ...extra };
}

type Saved = { id: string; status: string; updated_at: string; back_to_draft: boolean; created: boolean };

async function saveItr(s: Session, payload: object): Promise<Saved> {
  return s.value<Saved>("select save_itr_computation($1::jsonb)", [JSON.stringify(payload)]);
}

async function itrStatus(s: Session, id: string, status: string, regime: string | null = null, note: string | null = null) {
  const ts = await s.value<string>("select updated_at::text from itr_computations where id = $1", [id]);
  return s.value<{ status: string; updated_at: string; regime_chosen: string | null }>("select set_itr_computation_status($1, $2::timestamptz, $3, $4, $5)", [id, ts, status, regime, note]);
}

// =================================================================================================
// ITR computations
// =================================================================================================

describe("save_itr_computation", () => {
  it("saves a draft for an Employee's own individual client with the rule set in force copied from the law tables", async () => {
    await db.asRole(U.E1, async (s) => {
      const rule = await ruleRow(s, "2025-26");
      const r = await saveItr(s, itrPayload(C.A, "2025-26", rule, "1275000"));
      expect(r).toMatchObject({ status: "draft", created: true, back_to_draft: false });
      const row = await s.one<{ prepared_by: string; rule_set_param_id: string; rule_set_verified: boolean; same_rules: boolean; computed: boolean; label: string }>(
        `select i.prepared_by, i.rule_set_param_id, i.rule_set_verified, i.rule_set = sp.value as same_rules, i.computed_at is not null as computed, i.label
         from itr_computations i join statutory_parameters sp on sp.id = i.rule_set_param_id where i.id = $1`,
        [r.id],
      );
      expect(row).toEqual({ prepared_by: U.E1.id, rule_set_param_id: rule.id, rule_set_verified: true, same_rules: true, computed: true, label: "Return as filed" });
      const list = await s.one<{ year_label: string; recommended_regime: string; balance_paise: string; effective_regime: string }>(
        "select year_label, recommended_regime, balance_paise::text, effective_regime from itr_computations_list where id = $1",
        [r.id],
      );
      expect(list).toMatchObject({ year_label: "AY 2026-27", recommended_regime: "new", effective_regime: "new" });
    });
  });

  it("marks a computation under an unverified rule set (tax year 2026-27, §6.1 [verify])", async () => {
    await db.asRole(U.M1, async (s) => {
      const rule = await ruleRow(s, "2026-27");
      const r = await saveItr(s, itrPayload(C.A, "2026-27", rule, "900000"));
      expect(await s.value("select rule_set_verified from itr_computations where id = $1", [r.id])).toBe(false);
      expect(await s.value("select year_label from itr_computations_list where id = $1", [r.id])).toBe("Tax year 2026-27");
    });
  });

  it("refuses another kind of client, a client the caller can't see, portal users and anon", async () => {
    await db.asRole(U.M1, async (s) => {
      const rule = await ruleRow(s, "2025-26");
      expect(userMessage(await s.fails("select save_itr_computation($1::jsonb)", [JSON.stringify(itrPayload(C.B, "2025-26", rule, "500000"))]))).toMatch(/individuals and HUFs/);
    });
    await db.asRole(U.E4, async (s) => {
      const rule = await ruleRow(s, "2025-26");
      expect(userMessage(await s.fails("select save_itr_computation($1::jsonb)", [JSON.stringify(itrPayload(C.A, "2025-26", rule, "500000"))]))).toMatch(/isn't one of yours/);
    });
    await db.asRole(U.CA, async (s) => {
      const e = await s.fails("select save_itr_computation($1::jsonb)", [JSON.stringify({ client_id: C.A })]);
      expect(userMessage(e)).toMatch(/Only the firm's staff/);
    });
    await db.asAnon(async (s) => {
      expect((await s.fails("select save_itr_computation('{}'::jsonb)")).code).toBe(SQLSTATE.insufficientPrivilege);
    });
  });

  it("never takes a rule set or results from the caller that the law tables don't hold", async () => {
    await db.asRole(U.E1, async (s) => {
      const r25 = await ruleRow(s, "2025-26");
      const r24 = await ruleRow(s, "2024-25");
      // The FY 2024-25 rule set named for FY 2025-26 figures.
      const wrongRow = await s.fails("select save_itr_computation($1::jsonb)", [JSON.stringify({ ...itrPayload(C.A, "2025-26", r25, "800000"), rule_set_param_id: r24.id })]);
      expect(userMessage(wrongRow)).toMatch(/changed on the Law & rules page/);
      // A doctored copy of the right row.
      const doctored = { ...(r25.value as Record<string, unknown>), cessRate: 0 };
      const wrongValue = await s.fails("select save_itr_computation($1::jsonb)", [JSON.stringify({ ...itrPayload(C.A, "2025-26", r25, "800000"), rule_set: doctored })]);
      expect(userMessage(wrongValue)).toMatch(/changed on the Law & rules page/);
      // Results for another year.
      const other = itrPayload(C.A, "2024-25", r24, "800000");
      const mixed = await s.fails("select save_itr_computation($1::jsonb)", [JSON.stringify({ ...itrPayload(C.A, "2025-26", r25, "800000"), results: other.results })]);
      expect(userMessage(mixed)).toMatch(/must be for FY 2025-26/);
      // A direct insert gets the same checks (the guard, not the function, is the control).
      const direct = await s.attempt(
        "insert into itr_computations (client_id, financial_year, inputs, results, rule_set, rule_set_param_id, created_by) values ($1, '2025-26', $2::jsonb, $3::jsonb, $4::jsonb, $5, $6)",
        [C.A, JSON.stringify(itrPayload(C.A, "2025-26", r25, "800000").inputs), JSON.stringify(itrPayload(C.A, "2025-26", r25, "800000").results), JSON.stringify(doctored), r25.id, U.E1.id],
      );
      expect(direct.ok).toBe(false);
    });
  });

  it("refuses a stale save with who changed it and when (§13), and keeps a computation with its client and year", async () => {
    await db.asRole(U.E1, async (s) => {
      const rule = await ruleRow(s, "2025-26");
      const r = await saveItr(s, itrPayload(C.A, "2025-26", rule, "700000"));
      await saveItr(s, { ...itrPayload(C.A, "2025-26", rule, "710000"), id: r.id, updated_at: r.updated_at });
      // One transaction here, so a stale copy is one loaded a moment earlier.
      const earlier = new Date(Date.parse(r.updated_at) - 1000).toISOString();
      const stale = await s.fails("select save_itr_computation($1::jsonb)", [JSON.stringify({ ...itrPayload(C.A, "2025-26", rule, "720000"), id: r.id, updated_at: earlier })]);
      expect(userMessage(stale)).toMatch(/^Changed by Test E1 at \d{2}:\d{2}\. Reload/);
      const fresh = await s.value<string>("select updated_at::text from itr_computations where id = $1", [r.id]);
      const moved = await s.fails("select save_itr_computation($1::jsonb)", [JSON.stringify({ ...itrPayload(C.A, "2024-25", await ruleRow(s, "2024-25"), "720000"), id: r.id, updated_at: fresh })]);
      expect(userMessage(moved)).toMatch(/stays with its year/);
    });
  });
});

describe("the ITR workflow (§7.8.2)", () => {
  it("is reviewed by someone other than the preparer, who records the regime; Final by a Manager or Partner; Final is locked", async () => {
    await db.asRole(U.E1, async (s) => {
      const rule = await ruleRow(s, "2025-26");
      const r = await saveItr(s, itrPayload(C.A, "2025-26", rule, "1500000"));
      // The preparer can't review their own work.
      const own = await s.fails("select set_itr_computation_status($1, $2::timestamptz, 'reviewed', 'new', null)", [r.id, r.updated_at]);
      expect(userMessage(own)).toMatch(/Someone other than the preparer/);
      // Draft can't jump to Final.
      await s.as(U.M1);
      const jump = await s.fails("select set_itr_computation_status($1, $2::timestamptz, 'final', null, null)", [r.id, r.updated_at]);
      expect(userMessage(jump)).toMatch(/reviewed before it is marked final/);
      // A review needs a regime.
      const noRegime = await s.fails("select set_itr_computation_status($1, $2::timestamptz, 'reviewed', null, null)", [r.id, r.updated_at]);
      expect(userMessage(noRegime)).toMatch(/Choose the regime/);
      const reviewed = await itrStatus(s, r.id, "reviewed", "old");
      expect(reviewed).toMatchObject({ status: "reviewed", regime_chosen: "old" });
      expect(await s.one("select reviewed_by, regime_chosen_by from itr_computations where id = $1", [r.id])).toEqual({ reviewed_by: U.M1.id, regime_chosen_by: U.M1.id });
      // An Employee can't mark it final.
      await s.as(U.E1);
      expect(userMessage(await s.fails("select set_itr_computation_status($1, $2::timestamptz, 'final', null, null)", [r.id, reviewed.updated_at]))).toMatch(/Only a Manager or Partner/);
      await s.as(U.P1);
      const final = await itrStatus(s, r.id, "final");
      expect(final.status).toBe("final");
      expect(await s.value("select finalised_by from itr_computations where id = $1", [r.id])).toBe(U.P1.id);
      // Locked: no new figures, no delete, no reopening by an Employee.
      const locked = await s.fails("select save_itr_computation($1::jsonb)", [JSON.stringify({ ...itrPayload(C.A, "2025-26", rule, "1600000"), id: r.id, updated_at: final.updated_at })]);
      expect(userMessage(locked)).toMatch(/is final/);
      expect(userMessage(await s.fails("select delete_itr_computation($1, $2::timestamptz)", [r.id, final.updated_at]))).toMatch(/can't be deleted/);
      await s.as(U.E1);
      expect(userMessage(await s.fails("select set_itr_computation_status($1, $2::timestamptz, 'draft', null, 'Change')", [r.id, final.updated_at]))).toMatch(/Only a Manager or Partner can reopen/);
      // A Manager reopens it with a reason; the review and the regime go.
      await s.as(U.M1);
      expect(userMessage(await s.fails("select set_itr_computation_status($1, $2::timestamptz, 'draft', null, null)", [r.id, final.updated_at]))).toMatch(/Say why/);
      const reopened = await itrStatus(s, r.id, "draft", null, "Form 16 revised by the employer.");
      expect(reopened).toMatchObject({ status: "draft", regime_chosen: null });
      expect(await s.one("select reviewed_by, finalised_by, review_note from itr_computations where id = $1", [r.id])).toEqual({ reviewed_by: null, finalised_by: null, review_note: "Form 16 revised by the employer." });
    });
  });

  it("sends a reviewed computation back to Draft when its figures change, and lets a Partner review their own", async () => {
    await db.asRole(U.P1, async (s) => {
      const rule = await ruleRow(s, "2025-26");
      const r = await saveItr(s, itrPayload(C.A, "2025-26", rule, "1000000"));
      const reviewed = await itrStatus(s, r.id, "reviewed", "new");
      expect(reviewed.status).toBe("reviewed");
      const changed = await saveItr(s, { ...itrPayload(C.A, "2025-26", rule, "1100000"), id: r.id, updated_at: reviewed.updated_at });
      expect(changed).toMatchObject({ status: "draft", back_to_draft: true });
      expect(await s.one("select regime_chosen, reviewed_by from itr_computations where id = $1", [r.id])).toEqual({ regime_chosen: null, reviewed_by: null });
    });
  });

  it("keeps who prepared and reviewed it out of the caller's hands", async () => {
    await db.asRole(U.E1, async (s) => {
      const rule = await ruleRow(s, "2025-26");
      const r = await saveItr(s, itrPayload(C.A, "2025-26", rule, "600000"));
      const forged = await s.fails("update itr_computations set reviewed_by = $2 where id = $1", [r.id, U.P1.id]);
      expect(userMessage(forged)).toMatch(/recorded by the app/);
      const regime = await s.fails("update itr_computations set regime_chosen = 'old' where id = $1", [r.id]);
      expect(userMessage(regime)).toMatch(/chosen when the computation is reviewed/);
    });
  });

  it("lets only a Partner or Manager delete a computation", async () => {
    await db.asRole(U.E1, async (s) => {
      const rule = await ruleRow(s, "2025-26");
      const r = await saveItr(s, itrPayload(C.A, "2025-26", rule, "600000"));
      expect(userMessage(await s.fails("select delete_itr_computation($1, $2::timestamptz)", [r.id, r.updated_at]))).toMatch(/Only a Manager or Partner/);
      expect(await s.exec("delete from itr_computations where id = $1", [r.id])).toBe(0);
      await s.as(U.M1);
      const d = await s.value<{ client_id: string }>("select delete_itr_computation($1, $2::timestamptz)", [r.id, r.updated_at]);
      expect(d.client_id).toBe(C.A);
      expect(await s.value("select count(*)::int from itr_computations where id = $1", [r.id])).toBe(0);
    });
  });

  it("shows an Employee only their own clients' computations", async () => {
    const id = await db.asRole(U.M1, async (s) => {
      const rule = await ruleRow(s, "2025-26");
      const r = await saveItr(s, itrPayload(C.A, "2025-26", rule, "600000"));
      await s.as(U.E4);
      expect(await s.value("select count(*)::int from itr_computations_list where id = $1", [r.id])).toBe(0);
      expect(await s.value("select count(*)::int from itr_computations where id = $1", [r.id])).toBe(0);
      expect(userMessage(await s.fails("select set_itr_computation_status($1, now(), 'reviewed', 'new', null)", [r.id]))).toMatch(/isn't one of yours/);
      await s.as(U.E1);
      expect(await s.value("select count(*)::int from itr_computations_list where id = $1", [r.id])).toBe(1);
      return r.id;
    });
    expect(id).toBeTruthy();
  });
});

// =================================================================================================
// Notices
// =================================================================================================

function noticePayload(clientId: string, extra: Record<string, unknown> = {}) {
  return {
    client_id: clientId,
    notice_type: "IT 143(2)",
    tax_area: "income_tax",
    section: "143(2)",
    authority: "ACIT, Circle 4(1), Bengaluru",
    reference_no: "ITBA/AST/S/143(2)/2026-27/1000012345(1)",
    financial_year: "2024-25",
    notice_date: addDays(today, -20),
    received_date: addDays(today, -18),
    reply_due_date: addDays(today, 10),
    demand_amount: "125000.50",
    description: "Scrutiny: large cash deposits.",
    ...extra,
  };
}

type SavedNotice = { id: string; status: string; updated_at: string; created: boolean; assigned_employee_id: string | null };

async function saveNotice(s: Session, payload: object): Promise<SavedNotice> {
  return s.value<SavedNotice>("select save_tax_notice($1::jsonb)", [JSON.stringify(payload)]);
}

async function noticeStatus(s: Session, id: string, status: string, payload: object = {}) {
  const ts = await s.value<string>("select updated_at::text from tax_notices where id = $1", [id]);
  return s.value<{ status: string; updated_at: string; appeal_task_id: string | null; task_created: boolean; limitation_date: string | null; task_assignee_id: string | null }>(
    "select set_tax_notice_status($1, $2::timestamptz, $3::notice_status, $4::jsonb)",
    [id, ts, status, JSON.stringify(payload)],
  );
}

describe("save_tax_notice", () => {
  it("logs a notice for an Employee's own client, with the log line written by the database", async () => {
    await db.asRole(U.E1, async (s) => {
      const r = await saveNotice(s, noticePayload(C.A, { assigned_employee_id: U.E1.employeeId }));
      expect(r).toMatchObject({ status: "open", created: true, assigned_employee_id: U.E1.employeeId });
      const row = await s.one<{ demand_amount: string; created_by: string; updated_by: string }>("select demand_amount::text, created_by, updated_by from tax_notices where id = $1", [r.id]);
      expect(row).toEqual({ demand_amount: "125000.50", created_by: U.E1.id, updated_by: U.E1.id });
      const log = await s.rows<{ kind: string; body: string; author_id: string }>("select kind, body, author_id from tax_notice_notes where notice_id = $1", [r.id]);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ kind: "logged", author_id: U.E1.id });
      expect(log[0].body).toMatch(/^Notice logged: IT 143\(2\), ref\. ITBA/);
    });
  });

  it("needs a type and a reply due date, sensible dates and a hearing date for a Hearing", async () => {
    await db.asRole(U.E1, async (s) => {
      expect(userMessage(await s.fails("select save_tax_notice($1::jsonb)", [JSON.stringify(noticePayload(C.A, { notice_type: " " }))]))).toMatch(/notice type/);
      expect(userMessage(await s.fails("select save_tax_notice($1::jsonb)", [JSON.stringify(noticePayload(C.A, { reply_due_date: null }))]))).toMatch(/reply due date/);
      expect(userMessage(await s.fails("select save_tax_notice($1::jsonb)", [JSON.stringify(noticePayload(C.A, { received_date: addDays(today, -30) }))]))).toMatch(/received before its date/);
      expect(userMessage(await s.fails("select save_tax_notice($1::jsonb)", [JSON.stringify(noticePayload(C.A, { status: "hearing" }))]))).toMatch(/hearing date/);
      expect(userMessage(await s.fails("select save_tax_notice($1::jsonb)", [JSON.stringify(noticePayload(C.A, { status: "closed_favourable" }))]))).toMatch(/Log the notice first/);
    });
  });

  it("lets only a Partner or Manager assign a notice to someone else, and keeps it with its client", async () => {
    await db.asRole(U.E1, async (s) => {
      expect(userMessage(await s.fails("select save_tax_notice($1::jsonb)", [JSON.stringify(noticePayload(C.A, { assigned_employee_id: U.E4.employeeId }))]))).toMatch(/Only a Partner or Manager assigns/);
      const r = await saveNotice(s, noticePayload(C.A));
      const reassign = await s.fails("select save_tax_notice($1::jsonb)", [JSON.stringify({ ...noticePayload(C.A, { assigned_employee_id: U.E4.employeeId }), id: r.id, updated_at: r.updated_at })]);
      expect(userMessage(reassign)).toMatch(/Only a Partner or Manager reassigns/);
      await s.as(U.M1);
      const m = await saveNotice(s, { ...noticePayload(C.A, { assigned_employee_id: U.E4.employeeId }), id: r.id, updated_at: r.updated_at });
      expect(m.assigned_employee_id).toBe(U.E4.employeeId);
      const lines = await s.rows<{ kind: string; body: string }>("select kind, body from tax_notice_notes where notice_id = $1 and kind = 'assigned'", [r.id]);
      expect(lines.map((l) => l.body)).toEqual(["Assigned to Test E4."]);
      const moved = await s.fails("update tax_notices set client_id = $2 where id = $1", [r.id, C.B]);
      expect(userMessage(moved)).toMatch(/stays with its client/);
    });
  });

  it("closes the status, outcome and appeal columns to direct writes", async () => {
    await db.asRole(U.M1, async (s) => {
      const r = await saveNotice(s, noticePayload(C.A));
      const e = await s.fails("update tax_notices set status = 'closed_favourable' where id = $1", [r.id]);
      expect(userMessage(e)).toMatch(/change through Change status/);
      const t = await s.fails("update tax_notices set limitation_date = current_date where id = $1", [r.id]);
      expect(userMessage(t)).toMatch(/change through Change status/);
    });
  });

  it("records moved dates in the log and refuses a stale save", async () => {
    await db.asRole(U.E1, async (s) => {
      const r = await saveNotice(s, noticePayload(C.A));
      const moved = await saveNotice(s, { ...noticePayload(C.A, { reply_due_date: addDays(today, 20), hearing_date: `${addDays(today, 12)}T11:30:00+05:30` }), id: r.id, updated_at: r.updated_at });
      const lines = await s.rows<{ body: string }>("select body from tax_notice_notes where notice_id = $1 and kind = 'dates' order by body", [r.id]);
      expect(lines).toHaveLength(2);
      expect(lines.some((l) => /^Reply due date moved from/.test(l.body))).toBe(true);
      expect(lines.some((l) => /^Hearing fixed for .*11:30\.$/.test(l.body))).toBe(true);
      const earlier = new Date(Date.parse(moved.updated_at) - 1000).toISOString();
      const stale = await s.fails("select save_tax_notice($1::jsonb)", [JSON.stringify({ ...noticePayload(C.A), id: r.id, updated_at: earlier })]);
      expect(userMessage(stale)).toMatch(/^Changed by Test E1 at/);
    });
  });
});

describe("set_tax_notice_status (§7.8.4)", () => {
  it("walks Open → Reply drafted → Replied → Hearing, each step with what it needs", async () => {
    await db.asRole(U.E1, async (s) => {
      const r = await saveNotice(s, noticePayload(C.A));
      expect((await noticeStatus(s, r.id, "reply_drafted", { note: "Draft reply shared with the client." })).status).toBe("reply_drafted");
      await noticeStatus(s, r.id, "replied");
      expect(await s.value("select replied_on::text from tax_notices where id = $1", [r.id])).toBe(today);
      const noDate = await s.fails("select set_tax_notice_status($1, (select updated_at from tax_notices where id = $1), 'hearing', '{}'::jsonb)", [r.id]);
      expect(userMessage(noDate)).toMatch(/hearing date/);
      await noticeStatus(s, r.id, "hearing", { hearing_date: `${addDays(today, 5)}T15:00:00+05:30` });
      const lines = await s.rows<{ kind: string; body: string }>("select kind, body from tax_notice_notes where notice_id = $1 and kind = 'status' order by created_at", [r.id]);
      expect(lines.map((l) => l.body)).toEqual([
        "Status: Open → Reply drafted. Draft reply shared with the client.",
        `Status: Reply drafted → Replied. Replied on ${Number(today.slice(8, 10))} ${new Date(`${today}T00:00:00Z`).toLocaleString("en-GB", { month: "short", timeZone: "UTC" })} ${today.slice(0, 4)}.`,
        "Status: Replied → Hearing.",
      ]);
      const list = await s.one<{ hearing_upcoming: boolean; next_action_date: string; reply_pending: boolean }>("select hearing_upcoming, next_action_date::text, reply_pending from tax_notices_list where id = $1", [r.id]);
      expect(list).toEqual({ hearing_upcoming: true, next_action_date: addDays(today, 5), reply_pending: false });
    });
  });

  it("closing unfavourably needs the order date and the appeal decision, computes the limitation from the parameters and creates the appeal task", async () => {
    await db.asRole(U.E1, async (s) => {
      const r = await saveNotice(s, noticePayload(C.A, { assigned_employee_id: U.E1.employeeId }));
      const order = addDays(today, -5);
      const noOrder = await s.fails("select set_tax_notice_status($1, (select updated_at from tax_notices where id = $1), 'closed_unfavourable', '{}'::jsonb)", [r.id]);
      expect(userMessage(noOrder)).toMatch(/date of the order/);
      const noDecision = await s.fails("select set_tax_notice_status($1, (select updated_at from tax_notices where id = $1), 'closed_unfavourable', $2::jsonb)", [r.id, JSON.stringify({ order_date: order })]);
      expect(userMessage(noDecision)).toMatch(/whether the client will appeal/);
      const future = await s.fails("select set_tax_notice_status($1, (select updated_at from tax_notices where id = $1), 'closed_unfavourable', $2::jsonb)", [
        r.id,
        JSON.stringify({ order_date: addDays(today, 1), appeal: { decision: "appeal", forum: "income_tax_first_appeal" } }),
      ]);
      expect(userMessage(future)).toMatch(/can't be in the future/);

      const closed = await noticeStatus(s, r.id, "closed_unfavourable", { order_date: order, appeal: { decision: "appeal", forum: "income_tax_first_appeal" } });
      expect(closed).toMatchObject({ status: "closed_unfavourable", task_created: true, limitation_date: addDays(order, 30), task_assignee_id: U.E1.employeeId });
      const task = await s.one<{ client_id: string; due_date: string; service_type: string; financial_year: string; assigned_employee_id: string; created_by: string; title: string }>(
        "select client_id, due_date::text, service_type::text, financial_year, assigned_employee_id, created_by, title from tasks where id = $1",
        [closed.appeal_task_id],
      );
      expect(task).toMatchObject({ client_id: C.A, due_date: addDays(order, 30), service_type: "income_tax", financial_year: "2024-25", assigned_employee_id: U.E1.employeeId, created_by: U.E1.id });
      expect(task.title).toMatch(/^Appeal to the Commissioner \(Appeals\): IT 143\(2\) order of/);
      const n = await s.one<{ closed_by: string; limitation_manual: boolean; appeal_open: boolean; days_to_limitation: number }>(
        "select closed_by, limitation_manual, appeal_open, days_to_limitation from tax_notices_list where id = $1",
        [r.id],
      );
      expect(n).toEqual({ closed_by: U.E1.id, limitation_manual: false, appeal_open: true, days_to_limitation: 25 });

      // Correcting the order date moves the task; no second task.
      const fixed = await noticeStatus(s, r.id, "closed_unfavourable", { order_date: addDays(today, -3), appeal: { decision: "appeal", forum: "income_tax_tribunal" } });
      expect(fixed).toMatchObject({ task_created: false, appeal_task_id: closed.appeal_task_id, limitation_date: addDays(addDays(today, -3), 60) });
      expect(await s.value("select due_date::text from tasks where id = $1", [closed.appeal_task_id])).toBe(addDays(addDays(today, -3), 60));
      expect(await s.value("select count(*)::int from tasks where client_id = $1 and title like 'Appeal to %'", [C.A])).toBe(1);
    });
  });

  it("uses calendar months for GST forums, needs a date for another forum, and a reason for not appealing", async () => {
    await db.asRole(U.M1, async (s) => {
      const gst = await saveNotice(s, noticePayload(C.A, { notice_type: "GST DRC-01", tax_area: "gst", section: "73", notice_date: "2026-01-02", received_date: "2026-01-03", reply_due_date: "2026-01-20" }));
      const closed = await noticeStatus(s, gst.id, "closed_unfavourable", { order_date: "2026-01-31", appeal: { decision: "appeal", forum: "gst_first_appeal" } });
      expect(closed.limitation_date).toBe(addMonths("2026-01-31", 3));
      expect(closed.limitation_date).toBe("2026-04-30");
      expect(await s.value("select service_type::text from tasks where id = $1", [closed.appeal_task_id])).toBe("gst");

      const other = await saveNotice(s, noticePayload(C.A));
      const noDate = await s.fails("select set_tax_notice_status($1, (select updated_at from tax_notices where id = $1), 'closed_partial', $2::jsonb)", [
        other.id,
        JSON.stringify({ order_date: addDays(today, -2), appeal: { decision: "appeal", forum: "other" } }),
      ]);
      expect(userMessage(noDate)).toMatch(/Enter the limitation date/);
      const byHand = await noticeStatus(s, other.id, "closed_partial", { order_date: addDays(today, -2), appeal: { decision: "appeal", forum: "other", limitation_date: addDays(today, 40) } });
      expect(byHand.limitation_date).toBe(addDays(today, 40));
      expect(await s.value("select limitation_manual from tax_notices where id = $1", [other.id])).toBe(true);

      const third = await saveNotice(s, noticePayload(C.A));
      const noReason = await s.fails("select set_tax_notice_status($1, (select updated_at from tax_notices where id = $1), 'closed_unfavourable', $2::jsonb)", [
        third.id,
        JSON.stringify({ order_date: addDays(today, -2), appeal: { decision: "no_appeal" } }),
      ]);
      expect(userMessage(noReason)).toMatch(/why the client won't appeal/);
      const accepted = await noticeStatus(s, third.id, "closed_unfavourable", { order_date: addDays(today, -2), appeal: { decision: "no_appeal", note: "Demand accepted and paid." } });
      expect(accepted).toMatchObject({ task_created: false, appeal_task_id: null, limitation_date: null });
      expect(await s.value("select body from tax_notice_notes where notice_id = $1 and kind = 'appeal'", [third.id])).toMatch(/No appeal: Demand accepted and paid\./);
    });
  });

  it("asks for a date by hand when no limitation period is recorded", async () => {
    await db.asRole(U.M1, async (s) => {
      await s.as("super");
      await s.exec("delete from statutory_parameters where key = 'appeal.income_tax.tribunal'");
      await s.as(U.M1);
      expect(await s.value("select notice_appeal_limitation('income_tax_tribunal', current_date)")).toBeNull();
      expect(await s.value("select notice_appeal_limitation('income_tax_first_appeal', '2026-09-01')::text")).toBe("2026-10-01");
      const r = await saveNotice(s, noticePayload(C.A));
      const e = await s.fails("select set_tax_notice_status($1, (select updated_at from tax_notices where id = $1), 'closed_unfavourable', $2::jsonb)", [
        r.id,
        JSON.stringify({ order_date: addDays(today, -2), appeal: { decision: "appeal", forum: "income_tax_tribunal" } }),
      ]);
      expect(userMessage(e)).toMatch(/no limitation period is recorded/);
    });
  });

  it("lets only a Partner or Manager reopen a closed notice, with a reason", async () => {
    await db.asRole(U.E1, async (s) => {
      const r = await saveNotice(s, noticePayload(C.A));
      await noticeStatus(s, r.id, "closed_favourable", { order_date: addDays(today, -1) });
      const favourable = await s.fails("select set_tax_notice_status($1, (select updated_at from tax_notices where id = $1), 'closed_favourable', '{}'::jsonb)", [r.id]);
      expect(userMessage(favourable)).toMatch(/already at that status/);
      const reopen = await s.fails("select set_tax_notice_status($1, (select updated_at from tax_notices where id = $1), 'open', $2::jsonb)", [r.id, JSON.stringify({ note: "Remanded" })]);
      expect(userMessage(reopen)).toMatch(/Only a Manager or Partner can reopen/);
      await s.as(U.M1);
      const noReason = await s.fails("select set_tax_notice_status($1, (select updated_at from tax_notices where id = $1), 'open', '{}'::jsonb)", [r.id]);
      expect(userMessage(noReason)).toMatch(/Say why the notice is reopened/);
      const reopened = await noticeStatus(s, r.id, "open", { note: "Order set aside on rectification." });
      expect(reopened.status).toBe("open");
      expect(await s.one("select closed_at, closed_by from tax_notices where id = $1", [r.id])).toEqual({ closed_at: null, closed_by: null });
    });
  });

  it("refuses a notice the caller can't see, a stale change and anon", async () => {
    const id = await db.asRole(U.M1, async (s) => (await saveNotice(s, noticePayload(C.A))).id);
    expect(id).toBeTruthy();
    await db.asRole(U.E4, async (s) => {
      expect(userMessage(await s.fails("select set_tax_notice_status($1, now(), 'replied', '{}'::jsonb)", [F.task("A")]))).toMatch(/no longer exists, or isn't one of yours/);
    });
    await db.asRole(U.E1, async (s) => {
      const r = await saveNotice(s, noticePayload(C.A));
      const stale = await s.fails("select set_tax_notice_status($1, $2::timestamptz - interval '1 second', 'replied', '{}'::jsonb)", [r.id, r.updated_at]);
      expect(userMessage(stale)).toMatch(/^Changed by Test E1 at/);
    });
    await db.asAnon(async (s) => {
      expect((await s.fails("select set_tax_notice_status(gen_random_uuid(), now(), 'open', '{}'::jsonb)")).code).toBe(SQLSTATE.insufficientPrivilege);
    });
  });
});

describe("the running log and attachments", () => {
  it("takes people's notes in their own name, and leaves the other lines to the database", async () => {
    await db.asRole(U.E1, async (s) => {
      const r = await saveNotice(s, noticePayload(C.A));
      const ok = await s.attempt("insert into tax_notice_notes (notice_id, client_id, noted_on, body, author_id) values ($1, $2, current_date, 'Called the officer; adjournment to next week.', $3) returning client_id", [r.id, C.B, U.E1.id]);
      expect(ok.ok && ok.rows[0]).toEqual({ client_id: C.A });
      const kind = await s.fails("insert into tax_notice_notes (notice_id, client_id, body, kind, author_id) values ($1, $2, 'Status: Open → Closed.', 'status', $3)", [r.id, C.A, U.E1.id]);
      expect(userMessage(kind)).toMatch(/Only notes can be added/);
      const spoof = await s.fails("insert into tax_notice_notes (notice_id, client_id, body, author_id) values ($1, $2, 'A note', $3)", [r.id, C.A, U.P1.id]);
      expect(userMessage(spoof)).toMatch(/your own name/);
      const future = await s.fails("insert into tax_notice_notes (notice_id, client_id, noted_on, body, author_id) values ($1, $2, current_date + 2, 'Later', $3)", [r.id, C.A, U.E1.id]);
      expect(userMessage(future)).toMatch(/future/);
      const edit = await s.attempt("update tax_notice_notes set body = 'changed' where notice_id = $1", [r.id]);
      expect(!edit.ok && edit.code).toBe(SQLSTATE.insufficientPrivilege);
      expect(await s.exec("delete from tax_notice_notes where notice_id = $1", [r.id])).toBe(0);
      await s.as(U.E4);
      expect(await s.value("select count(*)::int from tax_notice_notes_list where notice_id = $1", [r.id])).toBe(0);
      const other = await s.fails("insert into tax_notice_notes (notice_id, client_id, body, author_id) values ($1, $2, 'Not mine', $3)", [r.id, C.A, U.E4.id]);
      expect(userMessage(other)).toMatch(/isn't one of yours/);
      await s.as(U.M1);
      expect(await s.exec("delete from tax_notice_notes where notice_id = $1 and kind = 'note'", [r.id])).toBe(1);
    });
  });

  it("attaches only the same client's documents, with a log line", async () => {
    await db.asRole(U.M1, async (s) => {
      const r = await saveNotice(s, noticePayload(C.A));
      const wrong = await s.fails("insert into tax_notice_documents (notice_id, document_id, kind) values ($1, $2, 'order')", [r.id, F.docShared("B")]);
      expect(userMessage(wrong)).toMatch(/this client's own documents/);
      expect(await s.exec("insert into tax_notice_documents (notice_id, document_id, kind) values ($1, $2, 'order')", [r.id, F.docShared("A")])).toBe(1);
      expect(await s.value("select body from tax_notice_notes where notice_id = $1 and kind = 'document'", [r.id])).toMatch(/^Attached the order: /);
      expect(await s.value("select documents_count from tax_notices_list where id = $1", [r.id])).toBe(1);
    });
  });
});

describe("the register's read model", () => {
  it("derives an overdue reply and keeps other clients' notices from an Employee", async () => {
    const id = await db.asRole(U.M1, async (s) => {
      const r = await saveNotice(s, noticePayload(C.A, { notice_date: addDays(today, -40), received_date: addDays(today, -39), reply_due_date: addDays(today, -3) }));
      const row = await s.one<{ reply_overdue: boolean; days_to_reply: number; next_action_date: string; notes_count: number }>(
        "select reply_overdue, days_to_reply, next_action_date::text, notes_count from tax_notices_list where id = $1",
        [r.id],
      );
      expect(row).toEqual({ reply_overdue: true, days_to_reply: -3, next_action_date: addDays(today, -3), notes_count: 1 });
      await noticeStatus(s, r.id, "replied", { replied_on: today });
      expect(await s.value("select reply_overdue from tax_notices_list where id = $1", [r.id])).toBe(false);
      return r.id;
    });
    await db.asRole(U.E4, async (s) => {
      expect(await s.value("select count(*)::int from tax_notices_list where id = $1", [id])).toBe(0);
      expect(await s.value("select count(*)::int from tax_notices_list where client_id = $1", [C.A])).toBe(0);
    });
    await db.asRole(U.CA, async (s) => {
      expect(await s.value("select count(*)::int from tax_notices_list")).toBe(0);
      expect(await s.value("select count(*)::int from itr_computations_list")).toBe(0);
    });
  });
});
