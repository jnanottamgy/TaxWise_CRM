import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import type { ClientModeBridge, Timers } from "../src/whatsapp/client-mode";
import type { AllowedGroup, ClientModePolicy, DesktopContext, FirmNumber } from "../src/shared/types";

/** A fresh WhatsApp-Web-like page from tests/fixtures (no scripts run). */
export function loadFixture(name: string): { window: Window; doc: Document } {
  const window = new Window({ url: "https://web.whatsapp.com/" });
  const html = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
  window.document.write(html);
  return { window, doc: window.document as unknown as Document };
}

/** Let MutationObserver callbacks run. */
export const flush = () => new Promise<void>((r) => setTimeout(r, 0));

export class FakeTimers implements Timers {
  t = Date.UTC(2026, 9, 22, 6, 0, 0);
  private seq = 0;
  private readonly tasks = new Map<number, { at: number; fn: () => void; every: number | null }>();

  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => this.add(fn, ms, null);
  setInterval = (fn: () => void, ms: number) => this.add(fn, ms, ms);
  clearTimeout = (h: unknown) => void this.tasks.delete(h as number);
  clearInterval = (h: unknown) => void this.tasks.delete(h as number);

  private add(fn: () => void, ms: number, every: number | null): number {
    const id = ++this.seq;
    this.tasks.set(id, { at: this.t + ms, fn, every });
    return id;
  }

  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const next = [...this.tasks.entries()].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, task] = next;
      this.t = task.at;
      if (task.every === null) this.tasks.delete(id);
      else task.at += task.every;
      task.fn();
    }
    this.t = end;
  }
}

export interface Recorded {
  pageStates: string[];
  titles: Array<{ title: string | null; verdict: string }>;
  adopted: string[];
  denied: string[];
  selectors: Array<{ ok: boolean; failing: string[] }>;
  resets: number;
}

export function recordingBridge(): { bridge: ClientModeBridge; rec: Recorded } {
  const rec: Recorded = { pageStates: [], titles: [], adopted: [], denied: [], selectors: [], resets: 0 };
  return {
    rec,
    bridge: {
      pageState: (s) => rec.pageStates.push(s),
      openTitle: (title, verdict) => rec.titles.push({ title, verdict }),
      adopt: (t) => rec.adopted.push(t),
      accessDenied: (t) => rec.denied.push(t),
      selectors: (ok, failing) => rec.selectors.push({ ok, failing }),
      resetPage: () => void rec.resets++,
    },
  };
}

/** WhatsApp's own behaviour, simulated: Escape closes the open conversation. */
export function escapeClosesChat(doc: Document): void {
  doc.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Escape") doc.querySelector("#main")?.remove();
  });
}

export const XYZ = "TW · TW-C-0142 · XYZ Traders";
export const SHARMA = "TW · TW-C-0177 · Sharma Exports";
export const PATEL = "TW · TW-C-0201 · Patel Builders";

export function policy(over: Partial<ClientModePolicy> = {}): ClientModePolicy {
  return { enabled: true, allowedGroupNames: [XYZ], sessionChats: [], pendingHandoff: null, notice: null, ...over };
}

export const NUMBERS: Record<string, FirmNumber> = {
  vinay: { id: "n-vinay", label: "CA Vinay H Karlagere (Partner)", kind: "partner", usableBy: ["partner"], ownerEmployeeId: "e-vinay" },
  asha: { id: "n-asha", label: "CA Asha Rao (Partner)", kind: "partner", usableBy: ["partner"], ownerEmployeeId: "e-asha" },
  managers: { id: "n-managers", label: "Managers' office", kind: "managers_office", usableBy: ["partner", "manager"], ownerEmployeeId: null },
  staff: { id: "n-staff", label: "Staff office", kind: "staff_office", usableBy: ["partner", "manager", "employee"], ownerEmployeeId: null },
};

export function group(clientId: string, clientName: string, groupName: string): AllowedGroup {
  return { clientId, clientName, groupName };
}

export function employeeContext(groups: AllowedGroup[], over: Partial<DesktopContext> = {}): DesktopContext {
  return {
    user: { id: "u-emp2", employeeId: "e-emp2", name: "Employee 2", role: "employee" },
    clientMode: true,
    employeeNotifications: false,
    numbers: [NUMBERS.staff!],
    allowedGroups: groups,
    ...over,
  };
}

export function partnerContext(employeeId = "e-vinay"): DesktopContext {
  return {
    user: { id: `u-${employeeId}`, employeeId, name: "CA Vinay H Karlagere", role: "partner" },
    clientMode: true,
    employeeNotifications: false,
    numbers: Object.values(NUMBERS),
    allowedGroups: null,
  };
}
