"use server";

import { defineAction, throwIfDbError } from "@/lib/action";
import { fail, ok } from "@/lib/result";
import { DeviceIdSchema, RenameDeviceSchema } from "@/lib/schemas/whatsapp";

/**
 * Settings → WhatsApp → Linked PCs (§7.25.7). Partner only (§4.1 "Remove a PC from TaxWise Desktop";
 * revoke_desktop_device and rename_desktop_device refuse anyone else in the database too).
 *
 * Remove PC revokes it: the desktop API refuses it from now on (403 device_revoked, before any
 * session check) and the app clears every WhatsApp partition on it at its next start; its number
 * links end now. The answer lists the numbers that were linked, so the page can remind the Partner
 * to remove the PC from each phone's Linked devices list too.
 */

export const removeDesktopPc = defineAction({ name: "desktop.remove_pc", schema: DeviceIdSchema, roles: ["partner"] }, async (input, ctx) => {
  const { data: device, error } = await ctx.supabase.from("desktop_devices_overview").select("id, device_name, revoked_at, links").eq("id", input.deviceId).maybeSingle();
  throwIfDbError(error);
  if (!device) return fail("That PC is no longer listed. Reload the page.", { code: "not_found" });
  const numbers = (Array.isArray(device.links) ? (device.links as Array<{ label?: string }>) : []).map((l) => l.label ?? "").filter(Boolean);
  if (device.revoked_at) return ok({ deviceName: device.device_name ?? "", numbers, alreadyRemoved: true });

  const { data: revoked, error: revokeError } = await ctx.supabase.rpc("revoke_desktop_device", { p_device_id: input.deviceId });
  throwIfDbError(revokeError);
  if (revoked) {
    await ctx.audit({
      event: "permission_change",
      resourceType: "desktop_device",
      resourceId: input.deviceId,
      action: "desktop.remove_pc",
      details: { device_name: device.device_name, numbers },
    });
  }
  return ok({ deviceName: device.device_name ?? "", numbers, alreadyRemoved: !revoked });
});

export const renameDesktopPc = defineAction({ name: "desktop.rename_pc", schema: RenameDeviceSchema, roles: ["partner"] }, async (input, ctx) => {
  const { data, error } = await ctx.supabase.rpc("rename_desktop_device", { p_device_id: input.deviceId, p_name: input.name });
  throwIfDbError(error);
  const r = data as { before: string; after: string };
  if (r.before !== r.after) {
    await ctx.audit({ event: "config_change", resourceType: "desktop_device", resourceId: input.deviceId, action: "desktop.rename_pc", details: { before: r.before, after: r.after } });
  }
  return ok({ name: r.after });
});
