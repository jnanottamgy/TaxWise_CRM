"use server";

import { z } from "zod";
import { defineAction, throwIfDbError, type ActionContext } from "@/lib/action";
import { ActionError, fail, ok, type ActionResult } from "@/lib/result";
import { log } from "@/lib/log";
import { canEndCover, coverBadge, coverQuickPicks, formatCoverUntil, validateCover, validateExtension, type CoverRecord } from "@/lib/domain/cover";
import { addDays, istDateOf, todayIST } from "@/lib/domain/fy";
import type { CoverKind } from "@/lib/domain/enums";
import { assessCapacity, type CapacityBand } from "@/lib/domain/capacity";
import { EndCoverSchema, ExtendCoverSchema, GrantCoverSchema, ReturnNoteSchema, coverEndDayText, coverWindowText, type GrantCoverValues } from "@/lib/schemas/covers";
import { getApprovedLeave, getCapacityFor, getWorkingCalendar } from "@/lib/data/capacity";
import { getClientsOfPerson, getCover, type CoverRow } from "@/lib/data/covers";
import { listActiveStaff } from "@/lib/data/people";
import { notify } from "@/server/notify";
import { addTimelineEvent } from "@/server/timeline";
import { sendEmail } from "@/server/email/send";

/**
 * Cover access (§4.7): grant (client cover, person cover, or a split into client covers), extend,
 * end now / "I'm back, end cover", and the cover person's note back. Partners and Managers grant,
 * extend and end; only a Partner ticks Include portal passwords; the absent person may end a cover
 * for them; the cover person may leave a return note (0040 policies and guard). Overlapping covers
 * merge on insert (0107). Every grant, extension and end writes a `permission_change` audit row and
 * a client timeline entry ("Anita is covering for Ravi until 25 Oct; granted by CA Vinay").
 */

const MANAGERS = ["partner", "manager"] as const;
const STAFF = ["partner", "manager", "employee"] as const;

type Person = { id: string; full_name: string; profile_id: string | null; email: string; active: boolean };

async function loadPeople(ctx: ActionContext, ids: ReadonlyArray<string | null | undefined>): Promise<Map<string, Person>> {
  const unique = Array.from(new Set(ids.filter((i): i is string => !!i)));
  const out = new Map<string, Person>();
  if (unique.length === 0) return out;
  const { data, error } = await ctx.supabase.from("people_overview").select("id, full_name, profile_id, email, login_status").in("id", unique);
  throwIfDbError(error);
  for (const p of data ?? []) {
    out.set(p.id as string, { id: p.id as string, full_name: p.full_name ?? "", profile_id: p.profile_id, email: p.email ?? "", active: p.login_status !== "disabled" });
  }
  return out;
}

const untilDate = coverEndDayText;

/** The clients a cover reaches now: its client, or every client the absent person owns or is on the team of. */
async function reachedClients(ctx: ActionContext, cover: { kind: CoverKind; client_id: string | null; absent_employee_id: string | null }): Promise<Array<{ id: string; display_name: string }>> {
  if (cover.kind === "client") {
    if (!cover.client_id) return [];
    const { data } = await ctx.supabase.from("clients").select("id, display_name").eq("id", cover.client_id).maybeSingle();
    return data ? [data] : [];
  }
  if (!cover.absent_employee_id) return [];
  return (await getClientsOfPerson(ctx.supabase, cover.absent_employee_id)).map((c) => ({ id: c.id, display_name: c.display_name }));
}

function clientLink(clientId: string): string {
  return `/clients/${clientId}`;
}

/** "See what changed": the client timeline filtered to the cover's window (§4.7 Ending). */
function changesLink(cover: { kind: CoverKind; client_id: string | null; absent_employee_id: string | null; id: string }, from: string, to: string): string {
  if (cover.kind === "client" && cover.client_id) return `/clients/${cover.client_id}?tab=timeline&from=${from}&to=${to}`;
  return `/people/${cover.absent_employee_id}?tab=work&changes=${cover.id}`;
}

// -------------------------------------------------------------------------------------------------
// Grant
// -------------------------------------------------------------------------------------------------

export interface GrantResult {
  ids: string[];
  /** True when a new cover merged with an existing one (§4.7: the later end wins). */
  merged: boolean;
}

export const grantCover = defineAction(
  { name: "covers.grant", schema: GrantCoverSchema, roles: MANAGERS },
  async (input: GrantCoverValues, ctx): Promise<ActionResult<GrantResult>> => {
    const now = new Date();
    const startsAt = new Date(input.starts_at);
    const endsAt = new Date(input.ends_at);

    // A client cover's "Covering for" defaults to the client's owner (§4.7 Fields).
    let absentId = input.absent_employee_id ?? null;
    if (input.mode === "client" && !absentId && input.client_id) {
      const { data: client, error } = await ctx.supabase.from("clients").select("owner_employee_id").eq("id", input.client_id).maybeSingle();
      throwIfDbError(error);
      if (!client) return fail("That client wasn't found.", { code: "not_found", fieldErrors: { client_id: ["That client wasn't found."] } });
      absentId = client.owner_employee_id === input.cover_employee_id ? null : client.owner_employee_id;
    }

    const drafts: Array<{ kind: CoverKind; client_id: string | null; cover_employee_id: string }> =
      input.mode === "split"
        ? (input.splits ?? []).filter((s) => s.cover_employee_id).map((s) => ({ kind: "client" as const, client_id: s.client_id, cover_employee_id: s.cover_employee_id as string }))
        : [{ kind: input.mode, client_id: input.mode === "client" ? (input.client_id ?? null) : null, cover_employee_id: input.cover_employee_id as string }];

    const people = await loadPeople(ctx, [absentId, ...drafts.map((d) => d.cover_employee_id)]);
    const leaves = await getApprovedLeave(ctx.supabase, Array.from(people.keys()), istDateOf(startsAt), istDateOf(endsAt));

    const warnings: string[] = [];
    for (const d of drafts) {
      const cover = people.get(d.cover_employee_id);
      const absent = absentId ? people.get(absentId) : null;
      const check = validateCover({
        draft: { kind: d.kind, clientId: d.client_id, absentEmployeeId: absentId, coverEmployeeId: d.cover_employee_id, startsAt, endsAt, includeVault: input.include_vault },
        actorRole: ctx.user.role,
        coverPerson: cover ? { isActive: cover.active, leaves: leaves.get(cover.id) ?? [] } : null,
        absentPerson: absent ? { isActive: absent.active } : null,
        now,
      });
      if (!check.ok) {
        const fieldErrors = input.mode === "split" ? { splits: [`${cover?.full_name ?? "A cover person"}: ${check.error}`] } : check.fieldErrors;
        return fail(check.error, { code: "validation", fieldErrors });
      }
      for (const w of check.warnings) warnings.push(input.mode === "split" && cover ? `${cover.full_name}: ${w}` : w);
    }

    const rows = drafts.map((d) => ({
      kind: d.kind,
      client_id: d.client_id,
      absent_employee_id: absentId,
      cover_employee_id: d.cover_employee_id,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      reason: input.reason,
      note: input.note,
      handover_note: input.handover_note,
      include_vault: ctx.user.role === "partner" ? input.include_vault : false,
      leave_id: input.leave_id ?? null,
      granted_by: ctx.user.id,
    }));
    const { data, error } = await ctx.supabase.from("client_covers").insert(rows).select("id, starts_at, ends_at, kind, client_id, absent_employee_id, cover_employee_id");
    throwIfDbError(error);
    const created = data ?? [];

    const { count: mergedCount } = await ctx.supabase
      .from("client_covers")
      .select("id", { count: "exact", head: true })
      .in("merged_into", created.map((c) => c.id));
    const merged = (mergedCount ?? 0) > 0;
    if (merged) warnings.push("This overlapped an existing cover for the same person, so the two were merged; the later end applies.");

    const absent = absentId ? people.get(absentId) : null;
    for (const c of created) {
      const cover = people.get(c.cover_employee_id);
      await ctx.audit({
        event: "permission_change",
        resourceType: "client_covers",
        resourceId: c.id,
        action: "covers.grant",
        details: {
          kind: c.kind,
          client_id: c.client_id,
          absent_employee_id: absentId,
          cover_employee_id: c.cover_employee_id,
          starts_at: c.starts_at,
          ends_at: c.ends_at,
          reason: input.reason,
          include_vault: rows[0].include_vault,
          merged,
          leave_id: input.leave_id ?? null,
        },
      });

      const window = coverWindowText(c.starts_at, c.ends_at);
      const title = `${cover?.full_name ?? "A colleague"} is covering${absent ? ` for ${absent.full_name}` : ""} until ${untilDate(c.ends_at)}; granted by ${ctx.user.fullName}`;
      ctx.after("Add the cover to the client timeline", async () => {
        const clients = await reachedClients(ctx, c);
        for (const client of clients) {
          await addTimelineEvent({
            clientId: client.id,
            eventType: "cover_granted",
            title,
            description: input.handover_note ? `Handover note: ${input.handover_note}` : undefined,
            metadata: { cover_id: c.id, kind: c.kind, cover_employee_id: c.cover_employee_id, absent_employee_id: absentId, starts_at: c.starts_at, ends_at: c.ends_at },
            performedBy: ctx.user.id,
          });
        }
      });

      const starts = new Date(c.starts_at).getTime() > now.getTime() + 5 * 60_000 ? ` from ${formatCoverUntil(c.starts_at)}` : "";
      ctx.after("Tell the cover person", async () => {
        const what = c.kind === "client" ? (await reachedClients(ctx, c))[0]?.display_name ?? "a client" : `${absent?.full_name ?? "a colleague"}'s clients`;
        await notify({
          to: { employeeIds: [c.cover_employee_id] },
          type: "cover_started",
          title: `You're covering ${what}${starts}`,
          body: `${coverBadge(absent?.full_name ?? "a colleague", c.ends_at)}. Granted by ${ctx.user.fullName}.${input.handover_note ? ` Handover: ${input.handover_note}` : ""}`,
          linkUrl: c.kind === "client" && c.client_id ? clientLink(c.client_id) : "/clients?covering=1",
          entity: { type: "client_cover", id: c.id },
          clientId: c.client_id ?? undefined,
          dedupeKey: `cover-started:${c.id}:cover`,
        });
      });
      if (absentId) {
        ctx.after("Tell the person being covered", async () => {
          const what = c.kind === "client" ? (await reachedClients(ctx, c))[0]?.display_name ?? "one of your clients" : "your clients";
          await notify({
            to: { employeeIds: [absentId] },
            type: "cover_started",
            title: `${cover?.full_name ?? "A colleague"} is covering ${what}, ${window}`,
            body: `Granted by ${ctx.user.fullName}. You can end it from My day when you're back.`,
            linkUrl: `/people/${absentId}?tab=work`,
            entity: { type: "client_cover", id: c.id },
            dedupeKey: `cover-started:${c.id}:absent`,
          });
        });
      }
      if (input.email_cover_person && cover?.email) {
        ctx.after(
          "Email the cover person",
          async () => {
            const result = await sendEmail({
              to: cover.email,
              subject: `TaxWise Consultants | You're covering for ${absent?.full_name ?? "a colleague"} until ${untilDate(c.ends_at)}`,
              text: [
                `Hi ${cover.full_name.split(/\s+/)[0]},`,
                "",
                `${ctx.user.fullName} has asked you to cover ${c.kind === "client" ? "a client" : `${absent?.full_name ?? "a colleague"}'s clients`} ${window}.`,
                `${coverBadge(absent?.full_name ?? "a colleague", c.ends_at)}.`,
                input.handover_note ? `\nHandover note:\n${input.handover_note}` : "",
                "",
                "The clients appear in My clients while the cover is in force. Fees and invoices stay hidden as usual.",
              ].join("\n"),
              kind: "notification",
              related: { type: "client_cover", id: c.id },
              idempotencyKey: `cover-started:${c.id}`,
            });
            if (result.status === "failed") throw new Error(result.error ?? "email failed");
          },
          "The cover is saved, but the email to the cover person didn't go. Tell them by WhatsApp or in person.",
        );
      }
    }
    return ok({ ids: created.map((c) => c.id), merged }, warnings);
  },
);

// -------------------------------------------------------------------------------------------------
// Extend, end, return note
// -------------------------------------------------------------------------------------------------

async function loadCover(ctx: ActionContext, id: string): Promise<CoverRow> {
  const cover = await getCover(ctx.supabase, id);
  if (!cover) throw new ActionError("That cover wasn't found.", { code: "not_found" });
  return cover;
}

function asRecord(c: CoverRow): CoverRecord {
  return { id: c.id, kind: c.kind, clientId: c.client_id, absentEmployeeId: c.absent_employee_id, coverEmployeeId: c.cover_employee_id, startsAt: c.starts_at, endsAt: c.ends_at, revokedAt: c.revoked_at };
}

export const extendCover = defineAction(
  { name: "covers.extend", schema: ExtendCoverSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ updated_at: string }>> => {
    const cover = await loadCover(ctx, input.id);
    const check = validateExtension({ cover: asRecord(cover), newEndsAt: input.ends_at, actorRole: ctx.user.role, now: new Date() });
    if (!check.ok) return fail(check.error, { code: "validation", fieldErrors: { ends_at: [check.error] } });
    const { data, error } = await ctx.supabase
      .from("client_covers")
      .update({ ends_at: new Date(input.ends_at).toISOString(), ending_notified_at: null })
      .eq("id", cover.id)
      .eq("updated_at", input.updated_at)
      .select("updated_at");
    throwIfDbError(error);
    if (!data?.length) return fail("This cover was changed after you opened it. Reload to see the changes.", { code: "conflict" });

    await ctx.audit({ event: "permission_change", resourceType: "client_covers", resourceId: cover.id, action: "covers.extend", details: { before: cover.ends_at, after: input.ends_at } });
    const title = `${cover.cover_name}'s cover${cover.absent_name ? ` for ${cover.absent_name}` : ""} extended until ${untilDate(input.ends_at)} by ${ctx.user.fullName}`;
    ctx.after("Add the extension to the client timeline", async () => {
      for (const client of await reachedClients(ctx, cover)) {
        await addTimelineEvent({ clientId: client.id, eventType: "cover_extended", title, metadata: { cover_id: cover.id, ends_at: input.ends_at }, performedBy: ctx.user.id });
      }
    });
    ctx.after("Tell the cover person", () =>
      notify({
        to: { employeeIds: [cover.cover_employee_id] },
        type: "info",
        title: `Your cover${cover.absent_name ? ` for ${cover.absent_name}` : ""} now runs until ${formatCoverUntil(input.ends_at)}`,
        body: `${ctx.user.fullName} extended it.`,
        linkUrl: cover.client_id ? clientLink(cover.client_id) : "/clients?covering=1",
        entity: { type: "client_cover", id: cover.id },
      }),
    );
    return ok({ updated_at: data[0].updated_at });
  },
);

export const endCover = defineAction(
  { name: "covers.end", schema: EndCoverSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<{ ended: true }>> => {
    const cover = await loadCover(ctx, input.id);
    const check = canEndCover({ cover: asRecord(cover), actorRole: ctx.user.role, actorEmployeeId: ctx.user.employeeId, now: new Date() });
    if (!check.ok) return fail(check.error, { code: "blocked" });
    const imBack = ctx.user.employeeId !== null && ctx.user.employeeId === cover.absent_employee_id;
    const now = new Date();
    const { data, error } = await ctx.supabase
      .from("client_covers")
      .update({
        revoked_at: now.toISOString(),
        revoked_by: ctx.user.id,
        revoke_reason: input.reason ?? (imBack ? "Back at work" : "Ended early"),
      })
      .eq("id", cover.id)
      .eq("updated_at", input.updated_at)
      .is("revoked_at", null)
      .select("id");
    throwIfDbError(error);
    if (!data?.length) return fail("This cover was changed after you opened it. Reload to see the changes.", { code: "conflict" });

    await ctx.audit({ event: "permission_change", resourceType: "client_covers", resourceId: cover.id, action: imBack ? "covers.end_im_back" : "covers.end", details: { reason: input.reason ?? null, planned_end: cover.ends_at } });
    const from = istDateOf(cover.starts_at);
    const to = todayIST(now);
    const window = coverWindowText(cover.starts_at, now);
    const title = imBack
      ? `${cover.absent_name ?? "The person covered"} is back; ${cover.cover_name}'s cover ended`
      : `${cover.cover_name}'s cover${cover.absent_name ? ` for ${cover.absent_name}` : ""} ended early by ${ctx.user.fullName}`;
    ctx.after("Add the end to the client timeline", async () => {
      for (const client of await reachedClients(ctx, cover)) {
        await addTimelineEvent({ clientId: client.id, eventType: "cover_ended", title, metadata: { cover_id: cover.id, ended_at: now.toISOString() }, performedBy: ctx.user.id });
      }
    });
    ctx.after("Tell the cover person", () =>
      notify({
        to: { employeeIds: [cover.cover_employee_id] },
        type: "cover_ended",
        title: `Your cover${cover.absent_name ? ` for ${cover.absent_name}` : ""} has ended`,
        body: `${imBack ? `${cover.absent_name ?? "They"} said they're back.` : `${ctx.user.fullName} ended it.`} Leave a note about what you did, if there's anything they should know.`,
        linkUrl: `/people/${cover.cover_employee_id}?tab=work&return_note=${cover.id}`,
        entity: { type: "client_cover", id: cover.id },
        dedupeKey: `cover-ended:${cover.id}:cover`,
      }),
    );
    if (cover.absent_employee_id && !imBack) {
      const absentId = cover.absent_employee_id;
      ctx.after("Tell the person who was covered", () =>
        notify({
          to: { employeeIds: [absentId] },
          type: "cover_ended",
          title: `${cover.cover_name} covered ${cover.client_name ?? "your clients"} for you, ${window}`,
          body: "See what changed while you were away.",
          linkUrl: changesLink(cover, from, to),
          entity: { type: "client_cover", id: cover.id },
          dedupeKey: `cover-ended:${cover.id}:absent`,
        }),
      );
    }
    return ok({ ended: true as const });
  },
);

export const saveReturnNote = defineAction(
  { name: "covers.return_note", schema: ReturnNoteSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<{ saved: true }>> => {
    const cover = await loadCover(ctx, input.id);
    const mine = ctx.user.employeeId !== null && ctx.user.employeeId === cover.cover_employee_id;
    if (!mine && ctx.user.role !== "partner" && ctx.user.role !== "manager") {
      return fail("Only the cover person leaves the note back.", { code: "forbidden" });
    }
    const { data, error } = await ctx.supabase.from("client_covers").update({ return_note: input.return_note }).eq("id", cover.id).select("id");
    throwIfDbError(error);
    if (!data?.length) return fail("The note couldn't be saved. Reload and try again.", { code: "forbidden" });
    await ctx.audit({ event: "data_update", resourceType: "client_covers", resourceId: cover.id, action: "covers.return_note" });
    if (cover.absent_employee_id) {
      const absentId = cover.absent_employee_id;
      ctx.after("Tell the person who was covered", () =>
        notify({
          to: { employeeIds: [absentId] },
          type: "info",
          title: `${cover.cover_name} left you a note about the cover`,
          body: input.return_note.length > 240 ? `${input.return_note.slice(0, 237)}…` : input.return_note,
          linkUrl: changesLink(cover, istDateOf(cover.starts_at), istDateOf(cover.revoked_at ?? cover.ends_at)),
          entity: { type: "client_cover", id: cover.id },
        }),
      );
    }
    return ok({ saved: true as const });
  },
);

// -------------------------------------------------------------------------------------------------
// Form context: cover people with their capacity band and leave in the window, and the quick picks
// -------------------------------------------------------------------------------------------------

export interface CoverCandidate {
  id: string;
  full_name: string;
  designation: string | null;
  band: CapacityBand;
  arithmetic: string;
  onLeave: string | null;
}

export interface CoverFormContext {
  candidates: CoverCandidate[];
  quickPicks: Array<{ key: string; label: string; endsAt: string }>;
  absentLeaves: Array<{ start: string; end: string }>;
}

const ContextSchema = z.object({ absent_employee_id: z.uuid().nullish(), starts_at: z.string().nullish(), ends_at: z.string().nullish() });

export const loadCoverFormContext = defineAction(
  { name: "covers.form_context", schema: ContextSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<CoverFormContext>> => {
    const now = new Date();
    const today = todayIST(now);
    const from = input.starts_at ? istDateOf(input.starts_at) : today;
    const to = input.ends_at ? istDateOf(input.ends_at) : addDays(today, 14);
    const staff = (await listActiveStaff(ctx.supabase)).filter((s) => s.id !== input.absent_employee_id);
    const ids = staff.map((s) => s.id);
    const [capacity, leave, calendar, absentLeave] = await Promise.all([
      getCapacityFor(ctx.supabase, ids, today),
      getApprovedLeave(ctx.supabase, ids, from, to),
      getWorkingCalendar(ctx.supabase, today, addDays(today, 7)),
      input.absent_employee_id ? getApprovedLeave(ctx.supabase, [input.absent_employee_id], today, addDays(today, 90)) : Promise.resolve(new Map()),
    ]);
    const absentLeaves = (absentLeave.get(input.absent_employee_id ?? "") ?? []).map((l: { start: string; end: string }) => ({ start: l.start, end: l.end }));
    const picks = coverQuickPicks({ now, weekdays: calendar.weekdays, absentLeaves: absentLeaves.map((l: { start: string; end: string }) => ({ ...l, status: "approved" })) });
    return ok({
      candidates: staff.map((s) => {
        const cap = capacity.get(s.id) ?? assessCapacity(0, 1, calendar.thresholds);
        const l = (leave.get(s.id) ?? [])[0];
        return {
          id: s.id,
          full_name: s.full_name,
          designation: s.designation,
          band: cap.band,
          arithmetic: cap.arithmetic,
          onLeave: l ? coverWindowText(`${l.start}T00:00:00+05:30`, `${addDays(l.end, 1)}T00:00:00+05:30`) : null,
        };
      }),
      quickPicks: picks.map((p) => ({ key: p.key, label: p.label, endsAt: p.endsAt.toISOString() })),
      absentLeaves,
    });
  },
);

/** The split table for People → person → Cover their clients, and the leave prompt (§4.7). */
export const loadPersonClients = defineAction(
  { name: "covers.person_clients", schema: z.object({ employee_id: z.uuid() }), roles: MANAGERS },
  async ({ employee_id }, ctx) => {
    try {
      return ok(await getClientsOfPerson(ctx.supabase, employee_id));
    } catch (err) {
      log("error", "person clients load failed", { source: "action:covers.person_clients", userId: ctx.user.id, err });
      throw err;
    }
  },
);
