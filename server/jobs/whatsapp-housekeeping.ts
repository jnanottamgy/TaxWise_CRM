import "server-only";

import type { AdminSupabase } from "@/server/admin";
import { istDateOf, todayIST } from "@/lib/domain/fy";
import { formatDate } from "@/lib/format";
import { daysSince, groupReminderDue, isDeviceStale, isoWeekKey, STALE_DEVICE_DAYS } from "@/lib/domain/whatsapp";
import { notify } from "@/server/notify";
import { log } from "@/lib/log";

/**
 * WhatsApp housekeeping, Mondays 08:45 IST (§8, §7.25.7, §7.25.10, §9):
 *   1. a linked-devices review reminder to each office number's custodian (house rule 5: check the
 *      phone's Linked devices list against Settings → Linked PCs and remove anything unknown);
 *      an office number with no active custodian is reported to the Partners instead;
 *   2. PCs not seen for 30 days → the Partners, flagged for unlinking;
 *   3. clients onboarded 2 or more days ago that still have no Active WhatsApp group → their
 *      engagement partner (the owner when there is none, the Partners when neither is set).
 *
 * Idempotent: every notice carries a dedupe key for the ISO week (`…:2026-W43`), so a retried or
 * doubled run tells each person once. One bad record is logged and counted as `failed` (a partial
 * run); the rest carry on.
 */

const OFFICE_KINDS = new Set(["managers_office", "staff_office"]);
const PAGE = 1000;

export async function run(admin: AdminSupabase, now: Date = new Date()): Promise<{ counts: Record<string, number> }> {
  const today = todayIST(now);
  const week = isoWeekKey(today);
  const counts = { review_reminders: 0, no_custodian: 0, stale_pcs: 0, groups_missing: 0, failed: 0 };

  // 1. Linked-devices review reminders ------------------------------------------------------------
  const { data: numbers, error: numbersError } = await admin
    .from("firm_whatsapp_numbers")
    .select("id, label, kind, shared, is_active, custodian_employee_id, devices_reviewed_at")
    .eq("is_active", true);
  if (numbersError) throw numbersError;
  const offices = (numbers ?? []).filter((n) => n.shared || OFFICE_KINDS.has(n.kind));
  const custodianIds = [...new Set(offices.map((n) => n.custodian_employee_id).filter((v): v is string => !!v))];
  const activeCustodians = new Set<string>();
  if (custodianIds.length) {
    const { data: emps, error } = await admin.from("employees").select("id, is_active, deleted_at").in("id", custodianIds);
    if (error) throw error;
    for (const e of emps ?? []) if (e.is_active && !e.deleted_at) activeCustodians.add(e.id);
  }
  for (const n of offices) {
    try {
      const last = n.devices_reviewed_at ? `It was last checked on ${formatDate(n.devices_reviewed_at)}.` : "It hasn't been checked in TaxWise yet.";
      if (n.custodian_employee_id && activeCustodians.has(n.custodian_employee_id)) {
        await notify({
          to: { employeeIds: [n.custodian_employee_id] },
          type: "info",
          title: `Check the ${n.label} phone's linked devices`,
          body: `On the ${n.label} phone, open WhatsApp → Settings → Linked devices and compare the list with Settings → WhatsApp → Linked PCs. Log out anything you don't recognise, then record the review there. ${last}`,
          linkUrl: "/settings/whatsapp#numbers",
          entity: { type: "firm_whatsapp_number", id: n.id },
          dedupeKey: `whatsapp_devices_review:${n.id}:${week}`,
        });
        counts.review_reminders += 1;
      } else {
        await notify({
          to: { roles: ["partner"] },
          type: "info",
          title: `The ${n.label} number has no custodian`,
          body: `Nobody was reminded to check the ${n.label} phone's linked devices this week. Name the person who keeps the phone in Settings → WhatsApp. ${last}`,
          linkUrl: "/settings/whatsapp#numbers",
          entity: { type: "firm_whatsapp_number", id: n.id },
          dedupeKey: `whatsapp_no_custodian:${n.id}:${week}`,
        });
        counts.no_custodian += 1;
      }
    } catch (err) {
      counts.failed += 1;
      log("error", "devices review reminder failed", { source: "job:whatsapp-housekeeping", numberId: n.id, err });
    }
  }

  // 2. PCs not seen for 30 days ---------------------------------------------------------------------
  try {
    const { data: devices, error } = await admin.from("desktop_devices").select("id, device_name, last_seen_at, created_at").is("revoked_at", null).limit(PAGE);
    if (error) throw error;
    const stale = (devices ?? [])
      .filter((d) => isDeviceStale(d, now))
      .map((d) => ({ name: d.device_name, days: daysSince(d.last_seen_at ?? d.created_at, now) }))
      .sort((a, b) => b.days - a.days);
    if (stale.length) {
      const list = stale
        .slice(0, 10)
        .map((d) => `${d.name} (${d.days} days)`)
        .join(", ");
      await notify({
        to: { roles: ["partner"] },
        type: "warning",
        title: `${stale.length} ${stale.length === 1 ? "PC hasn't" : "PCs haven't"} been seen for ${STALE_DEVICE_DAYS} days`,
        body: `${list}${stale.length > 10 ? ` and ${stale.length - 10} more` : ""}. Remove each one in Settings → WhatsApp → Linked PCs, then from the phones' Linked devices lists, so it doesn't use up WhatsApp's device limit.`,
        linkUrl: "/settings/whatsapp#linked-pcs",
        entity: null,
        dedupeKey: `whatsapp_stale_pcs:${week}`,
      });
      counts.stale_pcs = stale.length;
    }
  } catch (err) {
    counts.failed += 1;
    log("error", "stale PC check failed", { source: "job:whatsapp-housekeeping", err });
  }

  // 3. Clients onboarded 2+ days ago with no Active group -------------------------------------------
  const withGroup = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin.from("client_whatsapp_groups").select("client_id").eq("status", "active").is("deleted_at", null).order("id").range(from, from + PAGE - 1);
    if (error) throw error;
    for (const g of data ?? []) withGroup.add(g.client_id);
    if ((data ?? []).length < PAGE) break;
  }
  const cutoff = new Date(now.getTime() - 2 * 86_400_000).toISOString();
  for (let from = 0; ; from += PAGE) {
    const { data: clients, error } = await admin
      .from("clients")
      .select("id, display_name, onboarded_at, owner_employee_id")
      .is("deleted_at", null)
      .in("status", ["active", "on_hold"])
      .not("onboarded_at", "is", null)
      .lte("onboarded_at", cutoff)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const missing = (clients ?? []).filter((c) => !withGroup.has(c.id) && groupReminderDue(c.onboarded_at ? istDateOf(c.onboarded_at) : null, today));
    if (missing.length) {
      const { data: team, error: teamError } = await admin
        .from("client_team_members")
        .select("client_id, employee_id")
        .eq("team_role", "engagement_partner")
        .in(
          "client_id",
          missing.map((c) => c.id),
        );
      if (teamError) throw teamError;
      const partnerOf = new Map<string, string[]>();
      for (const t of team ?? []) partnerOf.set(t.client_id, [...(partnerOf.get(t.client_id) ?? []), t.employee_id]);
      for (const c of missing) {
        try {
          const ep = partnerOf.get(c.id) ?? [];
          const to = ep.length ? { employeeIds: ep } : c.owner_employee_id ? { employeeIds: [c.owner_employee_id] } : { roles: ["partner" as const] };
          await notify({
            to,
            type: "whatsapp_group_missing",
            title: `${c.display_name} has no WhatsApp group yet`,
            body: `Onboarded on ${formatDate(c.onboarded_at)}. Set the group up with the checklist on the client's WhatsApp group tab: the firm's numbers, the client's people and the welcome message.`,
            linkUrl: `/clients/${c.id}?tab=whatsapp`,
            entity: { type: "client", id: c.id },
            clientId: c.id,
            dedupeKey: `whatsapp_group_missing:${c.id}:${week}`,
          });
          counts.groups_missing += 1;
        } catch (err) {
          counts.failed += 1;
          log("error", "no-group reminder failed", { source: "job:whatsapp-housekeeping", clientId: c.id, err });
        }
      }
    }
    if ((clients ?? []).length < PAGE) break;
  }

  return { counts };
}
