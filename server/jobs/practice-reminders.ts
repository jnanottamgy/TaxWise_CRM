import "server-only";

import type { AdminSupabase } from "@/server/admin";
import { addDays, todayIST, type DateString } from "@/lib/domain/fy";
import { formatDate, formatDateTime } from "@/lib/format";
import { logUnexpected } from "@/lib/log";
import type { StatutoryParameterRow } from "@/lib/domain/gst";
import { CEILING_PARAM_KEYS, peerReviewStatus, resolveCeilingParams } from "@/lib/domain/ceiling";
import { AUDIT_PARAM_KEYS, AUDIT_TYPE_LABELS, fileAssemblyCountdown, isAuditType, kycReminder, kycReviewDate, resolveAuditParams } from "@/lib/domain/audit-stages";
import {
  DATA_REQUEST_TYPE_LABELS,
  DPDP_PARAM_KEYS,
  boardReportDueAt,
  boardReportReminder,
  dataRequestUrgency,
  isClosedRequestStatus,
  resolveDpdpParams,
  restoreDrillReminder,
  type DataRequestType,
} from "@/lib/domain/dpdp";
import { notify } from "@/server/notify";

/**
 * Practice reminders (§8 "Reminders": peer-review expiries; §6.8, §6.9, §6.10, §12), daily:
 *   1. Peer review: the firm's certificate expires within 90 days (peer_review.expiry_warning_days),
 *      or has expired, with no later certificate recorded → Partners (§6.8 "Warn 90 days before").
 *   2. Audit file assembly (SA 230): an engagement not archived whose 60-day assembly date is within
 *      14 days (audit.file_assembly_warn_days), or has passed → the engagement partner and the
 *      review manager.
 *   3. KYC re-confirmation (§6.8 "Re-confirm annually"): an attest client's KYC review date within 30
 *      days, or passed → the engagement partners and review managers of its open audits, else its
 *      owner, else the Partners.
 *   4. DPDP requests (§6.10): an open request due within 7 days (dpdp.request_warn_days), or overdue
 *      → Partners and whoever handles it.
 *   5. Breach reports (§6.10): an open incident whose Board report is due within 24 hours, or late,
 *      and the Board not yet told → Partners.
 *   6. The quarterly restore drill (§12): none recorded this calendar quarter → Partners, early in the
 *      quarter and again in its last two weeks.
 *
 * Idempotent: every notice has a dedupe key naming the record and its date (a re-run or a second
 * run the same day notifies nobody twice). A record that fails is logged with its Ref and the run
 * carries on (§8). Nothing here carries fee data.
 */

const PAGE = 1000;

type Counts = {
  peer_review: number;
  assembly_due: number;
  assembly_overdue: number;
  kyc_due_soon: number;
  kyc_due: number;
  requests_due_soon: number;
  requests_overdue: number;
  incidents_board: number;
  restore_drill: number;
  failed: number;
};

async function params(admin: AdminSupabase, today: DateString) {
  const keys = [...Object.values(CEILING_PARAM_KEYS), ...Object.values(AUDIT_PARAM_KEYS), ...Object.values(DPDP_PARAM_KEYS)];
  const { data, error } = await admin.from("statutory_parameters").select("key, value, effective_from, effective_to, verified").in("key", keys);
  if (error) throw error;
  const rows: StatutoryParameterRow[] = (data ?? []).map((r) => ({ key: r.key, value: r.value, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, verified: r.verified }));
  return { ceiling: resolveCeilingParams(rows, today).params, audit: resolveAuditParams(rows, today).params, dpdp: resolveDpdpParams(rows, today).params };
}

export async function run(admin: AdminSupabase, now: Date = new Date()): Promise<{ counts: Record<string, number> }> {
  const counts: Counts = {
    peer_review: 0,
    assembly_due: 0,
    assembly_overdue: 0,
    kyc_due_soon: 0,
    kyc_due: 0,
    requests_due_soon: 0,
    requests_overdue: 0,
    incidents_board: 0,
    restore_drill: 0,
    failed: 0,
  };
  const today = todayIST(now);
  const p = await params(admin, today);

  const step = async (source: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      counts.failed++;
      logUnexpected(err, { source: `job:practice-reminders:${source}` });
    }
  };

  // 1. Peer review -------------------------------------------------------------------------------
  await step("peer-review", async () => {
    const { data, error } = await admin
      .from("peer_reviews")
      .select("id, certificate_no, valid_until, reviewer_name")
      .eq("status", "completed")
      .not("valid_until", "is", null)
      .order("valid_until", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data?.valid_until) return;
    const s = peerReviewStatus(data.valid_until, today, p.ceiling);
    if (s.state !== "expiring" && s.state !== "expired") return;
    await notify({
      to: { roles: ["partner"] },
      type: "expiry_alert",
      title: s.state === "expired" ? "Peer review certificate has expired" : `Peer review certificate expires in ${s.daysLeft} ${s.daysLeft === 1 ? "day" : "days"}`,
      body:
        s.state === "expired"
          ? `Certificate ${data.certificate_no ?? ""} expired on ${formatDate(data.valid_until)}. Audits that need a peer-reviewed auditor can't be accepted until a new certificate is recorded.`.replace("  ", " ")
          : `Certificate ${data.certificate_no ?? ""} is valid until ${formatDate(data.valid_until)}. Plan the next review so audits that need a peer-reviewed auditor can still be accepted.`.replace("  ", " "),
      linkUrl: "/quality?tab=peer-reviews",
      entity: { type: "peer_review", id: data.id },
      dedupeKey: `peer_review_${s.state}:${data.id}:${data.valid_until}`,
    });
    counts.peer_review++;
  });

  // 2. File assembly (SA 230) --------------------------------------------------------------------
  await step("assembly", async () => {
    const { data, error } = await admin
      .from("audit_engagements")
      .select("id, client_id, audit_type, financial_year, report_date, file_assembly_due, engagement_partner_id, review_manager_id, clients!inner(display_name, deleted_at)")
      .is("archived_at", null)
      .not("report_date", "is", null)
      .lte("file_assembly_due", addDays(today, p.audit.fileAssemblyWarnDays))
      .limit(PAGE);
    if (error) throw error;
    for (const e of (data ?? []) as unknown as Array<{
      id: string;
      client_id: string;
      audit_type: string;
      financial_year: string;
      report_date: string;
      file_assembly_due: string;
      engagement_partner_id: string;
      review_manager_id: string | null;
      clients: { display_name: string; deleted_at: string | null };
    }>) {
      await step(`assembly:${e.id}`, async () => {
        if (e.clients.deleted_at) return;
        const c = fileAssemblyCountdown({ reportDate: e.report_date, archivedOn: null, today }, p.audit);
        if (c.state !== "due_soon" && c.state !== "overdue") return;
        const label = `${isAuditType(e.audit_type) ? AUDIT_TYPE_LABELS[e.audit_type] : "Audit"} FY ${e.financial_year}`;
        await notify({
          to: { employeeIds: [e.engagement_partner_id, e.review_manager_id].filter((x): x is string => !!x) },
          type: "warning",
          title: c.state === "overdue" ? `${label}: final file overdue (SA 230)` : `${label}: assemble the final file by ${formatDate(c.due!)}`,
          body:
            c.state === "overdue"
              ? `The final audit file of ${e.clients.display_name} was due ${c.daysLate} ${c.daysLate === 1 ? "day" : "days"} ago, 60 days after the report date of ${formatDate(e.report_date)}. Assemble and archive it now.`
              : `The final audit file of ${e.clients.display_name} is due in ${c.daysLeft} ${c.daysLeft === 1 ? "day" : "days"}, 60 days after the report date of ${formatDate(e.report_date)}.`,
          linkUrl: `/audits/${e.id}`,
          entity: { type: "audit_engagement", id: e.id },
          clientId: e.client_id,
          dedupeKey: `audit_assembly_${c.state}:${e.id}:${c.due}`,
        });
        if (c.state === "overdue") counts.assembly_overdue++;
        else counts.assembly_due++;
      });
    }
  });

  // 3. KYC re-confirmation -----------------------------------------------------------------------
  await step("kyc", async () => {
    const [kyc, audits] = await Promise.all([
      admin.from("kyc_register").select("client_id, client_name, owner_employee_id, kyc_id, verified_on, next_review_on, complete").not("kyc_id", "is", null).limit(5000),
      admin.from("audit_engagements").select("client_id, engagement_partner_id, review_manager_id").is("archived_at", null).limit(5000),
    ]);
    if (kyc.error) throw kyc.error;
    if (audits.error) throw audits.error;
    const team = new Map<string, Set<string>>();
    for (const a of audits.data ?? []) {
      const set = team.get(a.client_id) ?? new Set<string>();
      set.add(a.engagement_partner_id);
      if (a.review_manager_id) set.add(a.review_manager_id);
      team.set(a.client_id, set);
    }
    for (const k of kyc.data ?? []) {
      if (!k.client_id) continue;
      await step(`kyc:${k.client_id}`, async () => {
        const reviewOn = kycReviewDate(k.next_review_on, k.verified_on, p.ceiling.kycReconfirmMonths);
        const state = kycReminder(reviewOn, today);
        if (!state || !reviewOn) return;
        const people = [...(team.get(k.client_id!) ?? [])];
        const to = people.length ? { employeeIds: people } : k.owner_employee_id ? { employeeIds: [k.owner_employee_id] } : { roles: ["partner"] as Array<"partner"> };
        await notify({
          to,
          type: "expiry_alert",
          title: state === "due" ? `KYC re-confirmation overdue: ${k.client_name}` : `KYC re-confirmation due ${formatDate(reviewOn)}: ${k.client_name}`,
          body:
            state === "due"
              ? `The annual KYC re-confirmation was due on ${formatDate(reviewOn)}. Audit and certification work for the client stays at Acceptance until it is re-confirmed.`
              : `Check the KYC details are still right and re-confirm them by ${formatDate(reviewOn)} (ICAI KYC Norms).`,
          linkUrl: `/clients/${k.client_id}?tab=profile`,
          entity: { type: "client", id: k.client_id! },
          clientId: k.client_id,
          dedupeKey: `kyc_review_${state}:${k.client_id}:${reviewOn}`,
        });
        if (state === "due") counts.kyc_due++;
        else counts.kyc_due_soon++;
      });
    }
  });

  // 4. DPDP requests -----------------------------------------------------------------------------
  await step("data-requests", async () => {
    const { data, error } = await admin.from("data_requests").select("id, type, status, due_by, handled_by").not("due_by", "is", null).lte("due_by", addDays(today, p.dpdp.requestWarnDays)).limit(PAGE);
    if (error) throw error;
    for (const r of data ?? []) {
      if (isClosedRequestStatus(r.status)) continue;
      await step(`data-request:${r.id}`, async () => {
        const u = dataRequestUrgency({ status: r.status, dueBy: r.due_by, today }, p.dpdp);
        if (u.urgency !== "due_soon" && u.urgency !== "overdue") return;
        const type = (r.type in DATA_REQUEST_TYPE_LABELS ? DATA_REQUEST_TYPE_LABELS[r.type as DataRequestType] : "Data").toLowerCase();
        await notify({
          to: { roles: ["partner"], userIds: r.handled_by ? [r.handled_by] : [] },
          type: "warning",
          title: u.urgency === "overdue" ? `Data request overdue: ${type}` : `Data request due ${formatDate(r.due_by!)}: ${type}`,
          body:
            u.urgency === "overdue"
              ? `A data principal's ${r.type} request was due on ${formatDate(r.due_by!)} and is still open. Answer it and record the response.`
              : `A data principal's ${r.type} request is due in ${u.daysLeft} ${u.daysLeft === 1 ? "day" : "days"}. Answer it and record the response.`,
          linkUrl: `/quality?tab=data-requests&request=${r.id}`,
          entity: { type: "data_request", id: r.id },
          dedupeKey: `data_request_${u.urgency}:${r.id}:${r.due_by}`,
        });
        if (u.urgency === "overdue") counts.requests_overdue++;
        else counts.requests_due_soon++;
      });
    }
  });

  // 5. Breach reports to the Board ---------------------------------------------------------------
  await step("incidents", async () => {
    const { data, error } = await admin
      .from("data_incidents")
      .select("id, title, detected_at, contained_at, assessed_at, board_notified_at, principals_notified_at, root_cause, closed_at")
      .is("closed_at", null)
      .is("board_notified_at", null)
      .limit(PAGE);
    if (error) throw error;
    for (const i of data ?? []) {
      await step(`incident:${i.id}`, async () => {
        const facts = {
          detectedAt: i.detected_at,
          containedAt: i.contained_at,
          assessedAt: i.assessed_at,
          boardNotifiedAt: i.board_notified_at,
          principalsNotifiedAt: i.principals_notified_at,
          rootCause: i.root_cause,
          closedAt: i.closed_at,
        };
        const r = boardReportReminder(facts, now, p.dpdp);
        if (!r) return;
        const due = boardReportDueAt(i.detected_at, p.dpdp);
        await notify({
          to: { roles: ["partner"] },
          type: "security_alert",
          title: r === "late" ? `Breach report to the Board is late: ${i.title ?? "incident"}` : `Breach report to the Board due ${formatDateTime(due)}`,
          body:
            r === "late"
              ? `The Data Protection Board's report on the breach detected ${formatDateTime(i.detected_at)} was due ${formatDateTime(due)}. Send it and record it on the incident.`
              : `Report the breach detected ${formatDateTime(i.detected_at)} to the Data Protection Board by ${formatDateTime(due)}, and tell the people affected.`,
          linkUrl: `/quality?tab=incidents&incident=${i.id}`,
          entity: { type: "data_incident", id: i.id },
          dedupeKey: `data_incident_board_${r}:${i.id}`,
        });
        counts.incidents_board++;
      });
    }
  });

  // 6. Quarterly restore drill -------------------------------------------------------------------
  await step("restore-drill", async () => {
    const { data, error } = await admin.from("restore_drills").select("performed_on").order("performed_on", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    const reminder = restoreDrillReminder(today, data?.performed_on ?? null);
    if (!reminder) return;
    await notify({
      to: { roles: ["partner"] },
      type: "info",
      title: reminder.kind === "start" ? `Restore drill for ${reminder.quarter.replace("-", " ")}` : `Restore drill for ${reminder.quarter.replace("-", " ")} still to do`,
      body:
        reminder.kind === "start"
          ? `Restore last night's backup to a scratch database, check the client, task and document counts, and record the drill. Due by ${formatDate(reminder.quarterEnds)}.${data?.performed_on ? ` The last drill was on ${formatDate(data.performed_on)}.` : ""}`
          : `No restore drill is recorded this quarter. Run it and record it by ${formatDate(reminder.quarterEnds)} (§12).`,
      linkUrl: "/quality?tab=restore-drills",
      entity: null,
      dedupeKey: `restore_drill_${reminder.kind}:${reminder.quarter}`,
    });
    counts.restore_drill++;
  });

  return { counts };
}

