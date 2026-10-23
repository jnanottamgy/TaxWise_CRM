/**
 * Clients module (§7.3, §7.4, §7.5.4): migrations 0110–0113.
 *   - onboard_client: one transaction creates the client, services, primary contact, team,
 *     checklist, the statutory engine's deadlines, the initial tasks and the KYC shell; converts the
 *     source lead or quotation once; refuses Employees, foreign deadlines, audit work without an
 *     accepted conflict check, a Manager's tax audit decision and a code in use;
 *   - find_client_duplicates (recycle bin included) and conflict_candidates (Partner/Manager only);
 *   - the acceptance guard freezes a decision and needs a rationale;
 *   - change_client_status keeps a history with the reason; delete_client is the Partner's and is
 *     refused while an issued invoice is unpaid;
 *   - import_clients imports valid rows only, each in its own savepoint;
 *   - clients_list / client_groups_overview never show outstanding to an Employee.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { C, F, U, fid, setupTestDatabase, userMessage, type Session } from "./helpers";
import { todayIST } from "@/lib/domain/fy";
import { resolveScaleParams } from "@/lib/domain/scale";
import {
  CALENDAR_DEFAULTS,
  generateEvents,
  parseDueDateOverrideRow,
  parseDueDateRuleRow,
  resolveCalendarParams,
  type CalendarEvent,
  type DueDateOverride,
  type DueDateRule,
  type DueDateRuleRow,
  type DueDateOverrideRow,
} from "@/lib/domain/statutory-calendar";
import type { StatutoryParameterRow } from "@/lib/domain/gst";
import {
  DEFAULT_SCALE_CONTEXT,
  calendarProfileFor,
  emptyOnboardingValues,
  mergeChecklist,
  newServiceEntry,
  onboardingSchema,
  type OnboardingData,
  type OnboardingValues,
} from "@/lib/schemas/onboarding";
import { buildOnboardPayload } from "@/server/onboarding";

const db = setupTestDatabase("onboarding");
const TODAY = todayIST();

// -------------------------------------------------------------------------------------------------
// The statutory engine, read from the law tables the way server/onboarding.ts does (§5.12, §6.7)
// -------------------------------------------------------------------------------------------------

async function engine(s: Session) {
  const ruleRows = await s.rows<DueDateRuleRow>(
    `select code, title, compliance_type::text, form_code, applies_to, frequency::text, rule, reminder_days,
            effective_from::text, effective_to::text, source_ref, verified, is_active
       from due_date_rules where is_active`,
  );
  const overrideRows = await s.rows<DueDateOverrideRow>("select id, rule_code, period_label, original_due::text, extended_due::text, scope, source_ref from due_date_overrides");
  const params = await s.rows<{ key: string; value: unknown; effective_from: string; effective_to: string | null; verified: boolean }>(
    "select key, value, effective_from::text, effective_to::text, verified from statutory_parameters",
  );
  const paramRows: StatutoryParameterRow[] = params.map((p) => ({
    key: p.key,
    value: p.value,
    effectiveFrom: p.effective_from,
    effectiveTo: p.effective_to,
    verified: p.verified,
  }));
  const rules = ruleRows.map(parseDueDateRuleRow).flatMap((r) => (r.ok ? [r.value] : [])) as DueDateRule[];
  const overrides = overrideRows.map(parseDueDateOverrideRow).flatMap((r) => (r.ok ? [r.value] : [])) as DueDateOverride[];
  const scale = resolveScaleParams(paramRows, TODAY);
  return { rules, overrides, params: { ...resolveCalendarParams(paramRows, TODAY, CALENDAR_DEFAULTS), scale: { qrmpMaxTurnoverPaise: scale.qrmpMaxTurnoverPaise } } };
}

function wizard(over: Partial<OnboardingValues> = {}): OnboardingData {
  const services = over.services ?? [newServiceEntry("gst", "monthly"), newServiceEntry("income_tax", "monthly", { agreed_fee: "3500" })];
  const v: OnboardingValues = {
    ...emptyOnboardingValues({ clientCode: "TW-C-0001", reminderDays: 7, notifyChannels: ["email"] }),
    display_name: "Kaveri Steel Works",
    legal_name: "Kaveri Steel Works Private Limited",
    entity_type: "pvt_ltd",
    pan: "AAECS1234K",
    gst_registration: "registered",
    gstin: "29AAECS1234K1Z9",
    email: "accounts@kaveristeel.in",
    phone: "98450 12345",
    contact_name: "Ravi Kumar",
    contact_role: "Director",
    annual_turnover: "3,20,00,000",
    turnover_fy: "2025-26",
    checklist: mergeChecklist(
      [],
      services.map((s) => s.service_type),
    ),
    checklist_reviewed: true,
    owner_employee_id: U.E1.employeeId!,
    engagement_partner_id: U.P1.employeeId!,
    review_manager_id: U.M2.employeeId!,
    preparer_ids: [U.E2.employeeId!],
    ...over,
    services,
  };
  return onboardingSchema(TODAY).parse(v);
}

async function payloadFor(s: Session, values: OnboardingData, opts: { clientId?: string; isPartner?: boolean; acceptanceId?: string | null; events?: CalendarEvent[] } = {}) {
  const clientId = opts.clientId ?? randomUUID();
  const e = await engine(s);
  const events = opts.events ?? generateEvents(calendarProfileFor(values, clientId), e.rules, e.overrides, { today: TODAY, params: e.params });
  return {
    clientId,
    events,
    payload: buildOnboardPayload(values, {
      clientId,
      events,
      today: TODAY,
      scale: DEFAULT_SCALE_CONTEXT,
      isPartner: opts.isPartner ?? false,
      acceptanceId: opts.acceptanceId ?? null,
      ip: "127.0.0.1",
      userAgent: "vitest",
    }),
  };
}

type OnboardResult = {
  client_id: string;
  client_code: string;
  service_ids: string[];
  contact_id: string;
  task_ids: string[];
  checklist: Array<{ id: string; label: string; sort_order: number }>;
  event_count: number;
  kyc_id: string | null;
};

const onboard = (s: Session, payload: unknown) => s.value<OnboardResult>("select onboard_client($1::jsonb)", [JSON.stringify(payload)]);
const onboardFails = (s: Session, payload: unknown) => s.fails("select onboard_client($1::jsonb)", [JSON.stringify(payload)]);

// -------------------------------------------------------------------------------------------------
// onboard_client (§7.3.2 "Complete onboarding … in one transaction")
// -------------------------------------------------------------------------------------------------

describe("onboard_client", () => {
  it("creates everything at once, with the engine's deadlines and the next client code", async () => {
    await db.asRole(U.M1, async (s) => {
      const values = wizard();
      const { clientId, payload, events } = await payloadFor(s, values);
      expect(events.length).toBeGreaterThan(0);
      const r = await onboard(s, payload);

      expect(r.client_id).toBe(clientId);
      expect(r.client_code).toMatch(/^TW-C-\d{4}$/);
      const client = await s.one<{
        status: string;
        owner_employee_id: string;
        onboarded_by: string;
        gst_scheme: string | null;
        tax_audit_applicable: string | null;
        state_code: string;
      }>("select status::text, owner_employee_id, onboarded_by, gst_scheme::text, tax_audit_applicable::text, state_code from clients where id = $1", [clientId]);
      expect(client).toMatchObject({
        status: "active",
        owner_employee_id: U.E1.employeeId,
        onboarded_by: U.M1.id,
        gst_scheme: null,
        tax_audit_applicable: "review",
        state_code: "29",
      });

      const services = await s.rows<{ service_type: string; frequency: string; agreed_fee: string | null; next_due_date: string | null }>(
        "select service_type::text, frequency::text, agreed_fee::text, next_due_date::text from client_services where client_id = $1 order by service_type",
        [clientId],
      );
      // §6.6: ₹3.2 crore is within the QRMP limit, so GST is quarterly whatever the browser sent.
      expect(services.map((x) => [x.service_type, x.frequency])).toEqual([
        ["gst", "quarterly"],
        ["income_tax", "annual"],
      ]);
      expect(services.find((x) => x.service_type === "income_tax")?.agreed_fee).toBe("3500.00");
      expect(services.every((x) => x.next_due_date !== null)).toBe(true);

      const contacts = await s.rows<{ name: string; is_primary: boolean }>("select name, is_primary from client_contacts where client_id = $1", [clientId]);
      expect(contacts).toEqual([{ name: "Ravi Kumar", is_primary: true }]);
      const team = await s.rows<{ team_role: string }>("select team_role::text from client_team_members where client_id = $1 order by team_role", [clientId]);
      expect(team.map((t) => t.team_role)).toEqual(["engagement_partner", "preparer", "review_manager"]);

      expect(r.checklist.map((c) => c.label)).toEqual(values.checklist.filter((i) => i.included).map((i) => i.label));
      expect(r.event_count).toBe(events.length);
      expect(await s.value<number>("select count(*)::int from compliance_events where client_id = $1", [clientId])).toBe(events.length);

      // §18.3 Partner 3: a QRMP client in Karnataka (29) files GSTR-3B on the 22nd after the quarter.
      const gstr3b = await s.rows<{ day: number; extended: boolean }>(
        "select extract(day from due_date)::int as day, original_due_date is not null as extended from compliance_events where client_id = $1 and form_code = 'GSTR-3B'",
        [clientId],
      );
      expect(gstr3b.length).toBeGreaterThan(0);
      expect(gstr3b.filter((g) => !g.extended).every((g) => g.day === 22)).toBe(true);

      const tasks = await s.rows<{ title: string; assigned_employee_id: string; acceptance_status: string; due_date: string }>(
        "select title, assigned_employee_id, acceptance_status::text, due_date::text from tasks where client_id = $1 order by title",
        [clientId],
      );
      expect(tasks.map((t) => t.title)).toEqual(["Collect documents for GST returns", "Collect documents for Income tax"]);
      expect(tasks.every((t) => t.assigned_employee_id === U.E1.employeeId && t.acceptance_status === "pending")).toBe(true);
      expect(r.kyc_id).not.toBeNull();

      // The timeline never carries fees (Employees on the team read it, §4.1).
      const tl = await s.one<{ metadata: Record<string, unknown> }>("select metadata from client_timeline_events where client_id = $1 and event_type = 'client_onboarded'", [
        clientId,
      ]);
      expect(JSON.stringify(tl.metadata)).not.toMatch(/3500|fee/);
      await s.as("super");
      expect(await s.value<number>("select count(*)::int from audit_logs where resource_id = $1 and action = 'clients.onboard'", [clientId])).toBe(1);
    });
  });

  it("is a Partner/Manager action only", async () => {
    await db.asRole(U.M1, async (s) => {
      const { payload } = await payloadFor(s, wizard({ display_name: "Employee attempt", pan: "", gstin: "", gst_registration: "unknown" }));
      await s.as(U.E1);
      expect(userMessage(await onboardFails(s, payload))).toMatch(/Only Partners and Managers/);
    });
  });

  it("refuses deadlines generated for another client", async () => {
    await db.asRole(U.M1, async (s) => {
      const values = wizard({ display_name: "Foreign events", pan: "", gstin: "", gst_registration: "unknown" });
      const other = await payloadFor(s, values);
      const { payload } = await payloadFor(s, values, { events: other.events });
      expect(other.events.length).toBeGreaterThan(0);
      expect(userMessage(await onboardFails(s, payload))).toMatch(/don't belong to this client/);
    });
  });

  it("needs an accepted conflict check for audit work, and links it to the client", async () => {
    await db.asRole(U.P1, async (s) => {
      const audit = wizard({
        display_name: "Audit prospect",
        pan: "",
        gstin: "",
        gst_registration: "unknown",
        services: [newServiceEntry("audit", "monthly")],
        audit_kinds: ["statutory"],
      });
      expect(userMessage(await onboardFails(s, (await payloadFor(s, audit)).payload))).toMatch(/Audit work needs a conflict check/);

      const pending = await s.value<string>("insert into client_acceptances (prospect_name, conflicts_found, created_by) values ('Audit prospect', '[]', $1) returning id", [
        U.P1.id,
      ]);
      const withPending = await payloadFor(s, audit, { acceptanceId: pending });
      expect(userMessage(await onboardFails(s, withPending.payload))).toMatch(/Audit work needs a conflict check/);

      await s.exec("update client_acceptances set outcome = 'accepted' where id = $1", [pending]);
      const ok = await payloadFor(s, audit, { acceptanceId: pending, isPartner: true });
      const r = await onboard(s, ok.payload);
      expect(await s.value<string>("select client_id from client_acceptances where id = $1", [pending])).toBe(r.client_id);

      // The same check can't onboard a second client.
      const again = await payloadFor(s, { ...audit, display_name: "Second audit prospect" }, { acceptanceId: pending, isPartner: true });
      expect(userMessage(await onboardFails(s, again.payload))).toMatch(/already belongs to another client/);
    });
  });

  it("refuses a declined prospect", async () => {
    await db.asRole(U.M1, async (s) => {
      const declined = await s.value<string>(
        "insert into client_acceptances (prospect_name, conflicts_found, outcome, rationale, created_by) values ('Declined prospect', '[]', 'declined', 'Conflict with an existing client', $1) returning id",
        [U.M1.id],
      );
      const { payload } = await payloadFor(s, wizard({ display_name: "Declined prospect", pan: "", gstin: "", gst_registration: "unknown" }), { acceptanceId: declined });
      expect(userMessage(await onboardFails(s, payload))).toMatch(/Decline/);
    });
  });

  it("leaves the tax audit decision to a Partner", async () => {
    await db.asRole(U.M1, async (s) => {
      const values = wizard({ display_name: "Tax audit case", pan: "", gstin: "", gst_registration: "unknown", annual_turnover: "2,50,00,000", tax_audit_decision: "yes" });
      const asManager = await payloadFor(s, values, { isPartner: true });
      expect(userMessage(await onboardFails(s, asManager.payload))).toMatch(/Only a Partner can confirm/);
      await s.as(U.P1);
      const asPartner = await payloadFor(s, values, { isPartner: true });
      const r = await onboard(s, asPartner.payload);
      expect(await s.value<string>("select tax_audit_applicable::text from clients where id = $1", [r.client_id])).toBe("yes");
    });
  });

  it("refuses a client code typed by hand that is already in use", async () => {
    await db.asRole(U.M1, async (s) => {
      const { payload } = await payloadFor(
        s,
        wizard({ display_name: "Code clash", pan: "", gstin: "", gst_registration: "unknown", client_code: "TW-C-9001", client_code_auto: false }),
      );
      expect(userMessage(await onboardFails(s, payload))).toMatch(/TW-C-9001 is already in use/);
    });
  });

  it("converts an accepted quotation once, with its lead", async () => {
    await db.asRole(U.P1, async (s) => {
      const lead = await s.value<string>("insert into leads (lead_number, name, email, created_by) values ('L-9101', 'Nandi Foods', 'hello@nandifoods.in', $1) returning id", [
        U.P1.id,
      ]);
      const quote = await s.value<string>(
        `insert into quotations (quotation_number, lead_id, client_name, client_email, valid_until, issue_date, created_by, total, status)
         values ('TW-Q/26-27/9101', $1, 'Nandi Foods', 'hello@nandifoods.in', current_date + 30, current_date, $2, 4130, 'accepted') returning id`,
        [lead, U.P1.id],
      );
      const line = await s.value<string>(
        "insert into quotation_items (quotation_id, description, service_type, frequency, unit_price, tax_amount, total) values ($1, 'GST returns', 'gst', 'monthly', 3500, 630, 4130) returning id",
        [quote],
      );
      const values = wizard({
        display_name: "Nandi Foods",
        pan: "",
        gstin: "",
        gst_registration: "unknown",
        services: [newServiceEntry("gst", "monthly", { agreed_fee: "3500", source_quotation_item_id: line })],
        source_quotation_id: quote,
        source_lead_id: lead,
      });
      const first = await payloadFor(s, values, { isPartner: true });
      const r = await onboard(s, first.payload);
      expect(await s.value<string>("select converted_client_id from quotations where id = $1", [quote])).toBe(r.client_id);
      const l = await s.one<{ status: string; converted_client_id: string }>("select status::text, converted_client_id from leads where id = $1", [lead]);
      expect(l).toEqual({ status: "won", converted_client_id: r.client_id });
      expect(
        await s.value<number>("select count(*)::int from client_timeline_events where client_id = $1 and event_type in ('lead_converted', 'quotation_converted')", [r.client_id]),
      ).toBe(2);

      const second = await payloadFor(s, { ...values, display_name: "Nandi Foods again" }, { isPartner: true });
      expect(userMessage(await onboardFails(s, second.payload))).toMatch(/already been converted/);
    });
  });

  it("refuses a service pointing at another quotation's line", async () => {
    await db.asRole(U.P1, async (s) => {
      const quote = await s.value<string>(
        `insert into quotations (quotation_number, client_name, client_email, valid_until, issue_date, created_by, total, status)
         values ('TW-Q/26-27/9102', 'Hampi Tours', 'ops@hampitours.in', current_date + 30, current_date, $1, 1180, 'accepted') returning id`,
        [U.P1.id],
      );
      const foreignLine = await s.value<string>("select id from quotation_items where quotation_id = $1 limit 1", [fid("quotation:A")]);
      const values = wizard({
        display_name: "Hampi Tours",
        pan: "",
        gstin: "",
        gst_registration: "unknown",
        services: [newServiceEntry("gst", "monthly", { source_quotation_item_id: foreignLine })],
        source_quotation_id: quote,
      });
      expect(userMessage(await onboardFails(s, (await payloadFor(s, values, { isPartner: true })).payload))).toMatch(/different quotation/);
    });
  });
});

// -------------------------------------------------------------------------------------------------
// Duplicate guard and conflict check (§7.3.2, §7.5.4)
// -------------------------------------------------------------------------------------------------

describe("find_client_duplicates", () => {
  it("finds the same PAN (inside a GSTIN too) and a close name, the recycle bin included", async () => {
    await db.asRole(U.M1, async (s) => {
      await s.as("super");
      await s.exec("update clients set pan = 'AAKFZ1234C' where id = $1", [C.Z]);
      await s.as(U.M1);
      const byPan = await s.rows<{ client_id: string; matched_on: string; in_recycle_bin: boolean }>("select * from find_client_duplicates($1, null, null, null)", ["aakfz1234c"]);
      expect(byPan).toEqual([expect.objectContaining({ client_id: C.Z, matched_on: "pan", in_recycle_bin: true })]);

      const byName = await s.rows<{ client_id: string; matched_on: string; score: string }>("select * from find_client_duplicates(null, null, $1, null)", [
        "M/s Alpha Traders Pvt. Ltd.",
      ]);
      expect(byName[0]).toMatchObject({ client_id: C.A, matched_on: "name" });
      expect(Number(byName[0].score)).toBe(1);

      expect(await s.rows("select * from find_client_duplicates(null, null, $1, $2)", ["Alpha Traders", C.A])).toEqual([]);
    });
  });

  it("only shows an Employee the clients they can see", async () => {
    await db.asRole(U.E2, async (s) => {
      expect(await s.rows("select * from find_client_duplicates(null, null, $1, null)", ["Alpha Traders"])).toEqual([]);
    });
  });
});

describe("conflict_candidates", () => {
  it("matches client names and contacts, and is Partner/Manager only", async () => {
    await db.asRole(U.P1, async (s) => {
      const rows = await s.rows<{ kind: string; client_id: string; candidate_name: string | null }>("select * from conflict_candidates($1, null, null, $2)", [
        "Beta Industries",
        ["Contact A"],
      ]);
      expect(rows.some((r) => r.kind === "client" && r.client_id === C.B)).toBe(true);
      expect(rows.some((r) => r.kind === "contact" && r.client_id === C.A)).toBe(true);
      await s.as(U.E1);
      expect(userMessage(await s.fails("select * from conflict_candidates($1)", ["Beta Industries"]))).toMatch(/Only Partners and Managers/);
    });
  });
});

describe("client_acceptances guard (§7.5.4)", () => {
  it("needs a rationale to decline, records the decider and freezes the decision", async () => {
    await db.asRole(U.M1, async (s) => {
      const id = await s.value<string>("insert into client_acceptances (prospect_name, conflicts_found, created_by) values ('Frozen prospect', $1, $2) returning id", [
        JSON.stringify([{ kind: "client", record_id: C.A, title: "Client Alpha Traders", strength: "possible", reasons: ["A close name"] }]),
        U.M1.id,
      ]);
      expect(userMessage(await s.fails("update client_acceptances set outcome = 'declined' where id = $1", [id]))).toMatch(/reason for declining/);
      expect(userMessage(await s.fails("update client_acceptances set outcome = 'accepted' where id = $1", [id]))).toMatch(/despite the matches/);
      await s.exec("update client_acceptances set outcome = 'accepted', rationale = 'Different business, same family name' where id = $1", [id]);
      const row = await s.one<{ decided_by: string; decided_at: string | null }>("select decided_by, decided_at from client_acceptances where id = $1", [id]);
      expect(row.decided_by).toBe(U.M1.id);
      expect(row.decided_at).not.toBeNull();
      expect(userMessage(await s.fails("update client_acceptances set rationale = 'changed' where id = $1", [id]))).toMatch(/can't be changed/);
      expect(userMessage(await s.fails("update client_acceptances set conflicts_found = '[]' where id = $1", [id]))).toMatch(/can't be changed/);
    });
  });
});

// -------------------------------------------------------------------------------------------------
// Status and delete (§7.3.4)
// -------------------------------------------------------------------------------------------------

describe("change_client_status", () => {
  it("needs a reason, keeps the history and the timeline, and checks updated_at", async () => {
    await db.asRole(U.M1, async (s) => {
      expect(userMessage(await s.fails("select change_client_status($1, 'on_hold', '  ')", [C.C]))).toMatch(/Give a reason/);
      expect(userMessage(await s.fails("select change_client_status($1, 'on_hold', 'Paused', '2020-01-01T00:00:00Z')", [C.C]))).toMatch(/Reload to see their changes/);
      const r = await s.value<{ from: string; to: string }>("select change_client_status($1, 'on_hold', 'Engagement paused until April')", [C.C]);
      expect(r).toMatchObject({ from: "active", to: "on_hold" });
      const h = await s.one<{ from_status: string; to_status: string; reason: string; changed_by: string }>(
        "select from_status::text, to_status::text, reason, changed_by from client_status_history where client_id = $1",
        [C.C],
      );
      expect(h).toEqual({ from_status: "active", to_status: "on_hold", reason: "Engagement paused until April", changed_by: U.M1.id });
      expect(await s.value<number>("select count(*)::int from client_timeline_events where client_id = $1 and event_type = 'client_status_changed'", [C.C])).toBe(1);
      expect(userMessage(await s.fails("select change_client_status($1, 'on_hold', 'Again')", [C.C]))).toMatch(/already On hold/);
    });
  });

  it("is refused to an Employee, who can't write the history either", async () => {
    await db.asRole(U.E1, async (s) => {
      expect(userMessage(await s.fails("select change_client_status($1, 'inactive', 'Not mine to change')", [C.A]))).toMatch(/Only Partners and Managers/);
      const e = await s.attempt("insert into client_status_history (client_id, from_status, to_status, reason, changed_by) values ($1, 'active', 'inactive', 'x', $2)", [
        C.A,
        U.E1.id,
      ]);
      expect(e.ok).toBe(false);
    });
  });

  it("shows an Employee the history of their own clients only", async () => {
    await db.asRole(U.M1, async (s) => {
      await s.exec("select change_client_status($1, 'on_hold', 'Waiting for the books')", [C.A]);
      await s.exec("select change_client_status($1, 'on_hold', 'Waiting for the books')", [C.B]);
      await s.as(U.E1);
      const ids = (await s.rows<{ client_id: string }>("select client_id from client_status_history")).map((r) => r.client_id);
      expect(ids).toEqual([C.A]);
    });
  });
});

describe("delete_client", () => {
  it("is the Partner's, and refused while an issued invoice is unpaid", async () => {
    await db.asRole(U.M1, async (s) => {
      expect(userMessage(await s.fails("select delete_client($1)", [C.C]))).toMatch(/Only a Partner/);
      await s.as(U.P1);
      expect(userMessage(await s.fails("select delete_client($1)", [C.C]))).toMatch(/1 unpaid invoice\b/);
    });
  });

  it("moves the client and everything under it to the recycle bin with one deleted_at", async () => {
    await db.asRole(U.P1, async (s) => {
      // Settle the fixture invoice without the receipt workflow (triggers off for this one statement).
      await s.as("super");
      await s.exec("set local session_replication_role = replica");
      await s.exec("update invoices set status = 'paid' where id = $1", [F.invoiceSent("C")]);
      await s.exec("set local session_replication_role = origin");
      await s.as(U.P1);
      const r = await s.value<{ tasks: number; documents: number; invoices: number; whatsapp_groups: number; deleted_at: string }>("select delete_client($1)", [C.C]);
      expect(r.tasks).toBeGreaterThan(0);
      expect(r.whatsapp_groups).toBe(1);
      await s.as("super");
      const stamps = await s.rows<{ d: string }>(
        `select deleted_at::text d from clients where id = $1
         union select deleted_at::text from tasks where client_id = $1
         union select deleted_at::text from invoices where client_id = $1
         union select deleted_at::text from client_whatsapp_groups where client_id = $1`,
        [C.C],
      );
      expect(stamps).toHaveLength(1);
      expect(stamps[0].d).not.toBeNull();
    });
  });
});

// -------------------------------------------------------------------------------------------------
// Import, the list view and groups (§7.3.1, §7.3.4, §7.4)
// -------------------------------------------------------------------------------------------------

describe("import_clients", () => {
  it("imports the valid rows and reports each failed row", async () => {
    await db.asRole(U.M1, async (s) => {
      const rows = [
        { row: 2, display_name: "Tunga Textiles", client_code: null, owner_employee_id: U.E1.employeeId, services: [{ service_type: "gst", frequency: "monthly" }] },
        { row: 3, display_name: "Code taken", client_code: "TW-C-9001" },
        { row: 4, display_name: "Inactive owner", owner_employee_id: U.D.employeeId },
      ];
      const r = await s.value<{ imported: number; failed: number; results: Array<{ row: number; ok: boolean; error?: string; client_id?: string }> }>(
        'select import_clients($1::jsonb, \'{"file_name":"clients.csv"}\')',
        [JSON.stringify(rows)],
      );
      expect(r.imported).toBe(1);
      expect(r.failed).toBe(2);
      expect(r.results.find((x) => x.row === 3)?.error).toMatch(/already in use/);
      expect(r.results.find((x) => x.row === 4)?.error).toMatch(/owner isn't an active member/);
      const id = r.results.find((x) => x.ok)!.client_id!;
      expect(await s.value<number>("select count(*)::int from client_services where client_id = $1", [id])).toBe(1);
      await s.as(U.E1);
      expect(userMessage(await s.fails("select import_clients($1::jsonb)", [JSON.stringify(rows.slice(0, 1))]))).toMatch(/Only Partners and Managers/);
    });
  });
});

describe("clients_list and client_groups_overview", () => {
  it("give Partners and Managers the outstanding, and Employees null", async () => {
    await db.asRole(U.M1, async (s) => {
      const m = await s.one<{ outstanding: string | null; has_overdue_invoices: boolean | null }>(
        "select outstanding::text, has_overdue_invoices from clients_list where id = $1",
        [C.A],
      );
      expect(Number(m.outstanding)).toBeGreaterThan(0);
      const g = await s.one<{ members: number; outstanding: string | null }>("select members, outstanding::text from client_groups_overview where id = $1", [fid("group:1")]);
      expect(g.members).toBe(1);
      expect(Number(g.outstanding)).toBeGreaterThan(0);
      await s.as(U.E1);
      const e = await s.one<{ outstanding: string | null; has_overdue_invoices: boolean | null }>(
        "select outstanding::text, has_overdue_invoices from clients_list where id = $1",
        [C.A],
      );
      expect(e).toEqual({ outstanding: null, has_overdue_invoices: null });
      expect((await s.rows("select id from clients_list")).length).toBe(1);
    });
  });

  it("flags a client nobody can reach", async () => {
    await db.asRole(U.M1, async (s) => {
      await s.as("super");
      await s.exec("update client_contacts set email = null, phone = null, whatsapp = null where client_id = $1", [C.B]);
      await s.exec("update clients set email = null, phone = null, whatsapp = null where id = $1", [C.B]);
      await s.as(U.M1);
      expect(await s.value<boolean>("select unreachable from clients_list where id = $1", [C.B])).toBe(true);
      expect(await s.value<boolean>("select unreachable from clients_list where id = $1", [C.A])).toBe(false);
    });
  });
});
