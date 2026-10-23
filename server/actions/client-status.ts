"use server";

import { defineAction, throwIfDbError } from "@/lib/action";
import { ok, type ActionResult } from "@/lib/result";
import type { ClientStatus } from "@/lib/domain/enums";
import { getStatus } from "@/lib/status";
import { ClientStatusChangeSchema, DeleteClientSchema } from "@/lib/schemas/clients";
import { logActivity, logEmployeeActivity } from "@/server/activity";

/**
 * The Client 360 header menu (§7.3.4):
 *
 *   changeClientStatus  Partner/Manager: a new status with a reason. change_client_status (0110)
 *                       writes the status, client_status_history and the timeline entry in one
 *                       transaction, with optimistic concurrency (§13). On hold and Inactive pause
 *                       auto-invoicing and client-facing reminders (the jobs read the status).
 *   deleteClient        Partner: moves the client and everything under it to the recycle bin
 *                       (delete_client, 0110), refused while an issued invoice is unpaid.
 */

const MANAGERS = ["partner", "manager"] as const;

export const changeClientStatus = defineAction(
  { name: "clients.change_status_360", schema: ClientStatusChangeSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ updatedAt: string; from: ClientStatus; to: ClientStatus }>> => {
    const { data, error } = await ctx.supabase.rpc("change_client_status", {
      p_client_id: input.clientId,
      p_to: input.to,
      p_reason: input.reason,
      p_updated_at: input.updatedAt,
    });
    throwIfDbError(error);
    const r = (data ?? {}) as { updated_at?: string; from?: ClientStatus; to?: ClientStatus; display_name?: string };
    const from = (r.from ?? input.to) as ClientStatus;
    const to = (r.to ?? input.to) as ClientStatus;

    await ctx.audit({
      event: "data_update",
      resourceType: "client",
      resourceId: input.clientId,
      action: "clients.change_status",
      details: { from, to, reason: input.reason },
    });
    ctx.after("Record the change in the client's history", () =>
      logActivity({
        entityType: "client",
        entityId: input.clientId,
        action: "status_changed",
        description: `Status changed from ${getStatus("client_status", from).label} to ${getStatus("client_status", to).label}: ${input.reason}`,
        metadata: { from, to },
      }),
    );
    ctx.after("Add to your activity", () =>
      logEmployeeActivity({
        activityType: "client_updated",
        description: `Changed ${r.display_name ?? "a client"} to ${getStatus("client_status", to).label}`,
        entityType: "client",
        entityId: input.clientId,
        entityName: r.display_name ?? null,
      }),
    );
    return ok({ updatedAt: r.updated_at ?? new Date().toISOString(), from, to });
  },
);

export const deleteClient = defineAction(
  { name: "clients.delete_360", schema: DeleteClientSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<{ redirectTo: string; displayName: string }>> => {
    const { data, error } = await ctx.supabase.rpc("delete_client", { p_client_id: input.clientId, p_updated_at: input.updatedAt });
    throwIfDbError(error);
    const r = (data ?? {}) as { display_name?: string; client_code?: string; tasks?: number; documents?: number; invoices?: number; whatsapp_groups?: number };
    const name = r.display_name ?? "The client";

    await ctx.audit({
      event: "data_delete",
      resourceType: "client",
      resourceId: input.clientId,
      action: "clients.delete",
      details: { client_code: r.client_code ?? null, tasks: r.tasks ?? 0, documents: r.documents ?? 0, invoices: r.invoices ?? 0, whatsapp_groups: r.whatsapp_groups ?? 0 },
    });
    ctx.after("Add to your activity", () =>
      logEmployeeActivity({ activityType: "client_updated", description: `Moved ${name} to the recycle bin`, entityType: "client", entityId: input.clientId, entityName: name }),
    );
    return ok({ redirectTo: "/clients", displayName: name });
  },
);
