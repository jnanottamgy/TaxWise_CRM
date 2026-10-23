import "server-only";

import type { CurrentUser } from "@/lib/auth/current-user";
import type { ServerSupabase } from "@/lib/supabase/server";
import { DESKTOP_ID_PATTERN, contextNumbers, type ContextNumber, type FirmNumberLike } from "@/lib/domain/whatsapp";

/**
 * Reads for the TaxWise Desktop API (§7.25.1, §7.25.4–§7.25.5, docs/DESKTOP-API.md), under the
 * signed-in person's session (RLS applies). The route handlers do their own device and session
 * checks first (server/desktop.ts).
 */

export interface AllowedGroup {
  clientId: string;
  clientName: string;
  groupName: string;
}

export interface DesktopContextData {
  clientMode: boolean;
  employeeNotifications: boolean;
  numbers: ContextNumber[];
  /** Employees: the groups of clients they can see, covers in force included. Partners and Managers: null (all). */
  allowedGroups: AllowedGroup[] | null;
}

/** The firm numbers this person may use in TaxWise Desktop (§7.25.4). */
export async function getDesktopNumbers(supabase: ServerSupabase, user: Pick<CurrentUser, "role" | "employeeId">): Promise<ContextNumber[]> {
  const { data, error } = await supabase
    .from("firm_whatsapp_numbers")
    .select("id, label, number, kind, employee_id, in_every_client_group, group_admin, is_active, usable_by")
    .eq("is_active", true)
    .limit(100);
  if (error) throw error;
  const rows = (data ?? []).map((r) => ({ ...r, usable_by: (r.usable_by ?? []) as string[] })) as FirmNumberLike[];
  return contextNumbers(rows, user.role, user.employeeId);
}

/**
 * Every open group (not closed, not deleted; primary and others) of the clients an Employee can
 * see right now. client_whatsapp_groups_public already applies can_open_whatsapp, which counts
 * covers in force (§4.7), so a cover that ended drops out at the next refresh.
 */
export async function getAllowedGroups(supabase: ServerSupabase): Promise<AllowedGroup[]> {
  const out: AllowedGroup[] = [];
  const pageSize = 1000;
  for (let from = 0; from < 20_000; from += pageSize) {
    const { data, error } = await supabase
      .from("client_whatsapp_groups_public")
      .select("id, client_id, name, status")
      .neq("status", "closed")
      .is("deleted_at", null)
      .order("id")
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const rows = (data ?? []) as Array<{ id: string; client_id: string; name: string; status: string }>;
    if (rows.length) {
      const clientIds = [...new Set(rows.map((r) => r.client_id))];
      const names = new Map<string, string>();
      for (let i = 0; i < clientIds.length; i += 200) {
        const { data: clients, error: clientsError } = await supabase
          .from("clients")
          .select("id, display_name")
          .in("id", clientIds.slice(i, i + 200))
          .is("deleted_at", null);
        if (clientsError) throw clientsError;
        for (const c of clients ?? []) names.set(c.id, c.display_name);
      }
      for (const r of rows) {
        const clientName = names.get(r.client_id);
        // A client the person can't see (or one in the recycle bin) never reaches the app.
        if (!clientName || !DESKTOP_ID_PATTERN.test(r.client_id)) continue;
        out.push({ clientId: r.client_id, clientName: clientName.slice(0, 300), groupName: r.name.slice(0, 300) });
      }
    }
    if (rows.length < pageSize) break;
  }
  return out.sort((a, b) => a.clientName.localeCompare(b.clientName, "en-IN") || a.groupName.localeCompare(b.groupName, "en-IN"));
}

/** GET /api/desktop/context's data (docs/DESKTOP-API.md 1), apart from `user`. */
export async function getDesktopContextData(supabase: ServerSupabase, user: Pick<CurrentUser, "role" | "employeeId">): Promise<DesktopContextData> {
  const [settings, numbers] = await Promise.all([
    supabase.from("firm_settings").select("whatsapp_client_mode, whatsapp_employee_notifications").eq("id", 1).maybeSingle(),
    getDesktopNumbers(supabase, user),
  ]);
  if (settings.error) throw settings.error;
  const allowedGroups = user.role === "partner" || user.role === "manager" ? null : await getAllowedGroups(supabase);
  return {
    // Fail closed: a missing settings row means client mode on and Employee notifications off.
    clientMode: settings.data?.whatsapp_client_mode ?? true,
    employeeNotifications: settings.data?.whatsapp_employee_notifications ?? false,
    numbers,
    allowedGroups,
  };
}
