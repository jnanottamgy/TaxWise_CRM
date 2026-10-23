import type { AppRole } from "@/lib/auth/roles";
import { can } from "@/lib/auth/roles";

/**
 * The Client 360 tabs in §7.3.3 order, selected with `?tab=`. Tabs marked `money` (Services & fees,
 * Billing, Engagement) are Partner/Manager only: hidden for Employees, and an Employee who asks for
 * one by URL gets the Overview instead, so their data is never loaded (§4.1). Pure and client-safe.
 */
export const CLIENT_TABS = [
  { id: "overview", label: "Overview", money: false },
  { id: "profile", label: "Profile & contacts", money: false },
  { id: "services", label: "Services & fees", money: true },
  { id: "tasks", label: "Tasks", money: false },
  { id: "compliance", label: "Compliance", money: false },
  { id: "documents", label: "Documents", money: false },
  { id: "workpapers", label: "Workpapers", money: false },
  { id: "registers", label: "Registers", money: false },
  { id: "billing", label: "Billing", money: true },
  { id: "engagement", label: "Engagement", money: true },
  { id: "communication", label: "Communication", money: false },
  { id: "whatsapp", label: "WhatsApp group", money: false },
  { id: "timeline", label: "Timeline", money: false },
] as const;

export type ClientTabId = (typeof CLIENT_TABS)[number]["id"];

/** The tabs this role sees, in order. */
export function visibleTabs(role: AppRole): Array<(typeof CLIENT_TABS)[number]> {
  const money = can.seeMoney(role);
  return CLIENT_TABS.filter((t) => money || !t.money);
}

/** The tab to show for `?tab=`: the requested one when this role may see it, otherwise the Overview. */
export function resolveTab(raw: string | string[] | undefined, role: AppRole): ClientTabId {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const tab = visibleTabs(role).find((t) => t.id === value);
  return tab ? tab.id : "overview";
}

/** The page URL for a tab (other params are dropped: each tab owns its own). */
export function tabHref(clientId: string, tab: ClientTabId, extra?: Record<string, string>): string {
  const qs = new URLSearchParams(tab === "overview" ? {} : { tab });
  for (const [k, v] of Object.entries(extra ?? {})) qs.set(k, v);
  const s = qs.toString();
  return s ? `/clients/${clientId}?${s}` : `/clients/${clientId}`;
}
