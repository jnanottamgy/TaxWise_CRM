import { describe, expect, it } from "vitest";
import type { ApiResult } from "../src/main/api";
import { parseContext } from "../src/main/contract";
import {
  buildClientModePolicy,
  chatsToClose,
  clientForTitle,
  ContextService,
  diffContext,
  effectiveClientMode,
  type ContextState,
} from "../src/main/context";
import { CONTEXT_REFRESH_MS, CONTEXT_STALE_MS } from "../src/shared/config";
import type { DesktopContext } from "../src/shared/types";
import { employeeContext, group, NUMBERS, partnerContext, PATEL, SHARMA, XYZ } from "./helpers";

const xyz = group("c-xyz", "XYZ Traders", XYZ);
const sharma = group("c-sharma", "Sharma Exports", SHARMA);
const session = { sessionChats: [] as string[], pendingHandoff: null, notice: null };

describe("context diff (§4.7, §7.25.5)", () => {
  it("a cover that ended removes its group", () => {
    const d = diffContext(employeeContext([xyz, sharma]), employeeContext([xyz]));
    expect(d.removedGroups).toEqual([SHARMA]);
    expect(d.addedGroups).toEqual([]);
    expect(d.userChanged).toBe(false);
  });

  it("a new cover adds a group", () => {
    expect(diffContext(employeeContext([xyz]), employeeContext([xyz, sharma])).addedGroups).toEqual([SHARMA]);
  });

  it("signing out removes every group", () => {
    expect(diffContext(employeeContext([xyz, sharma]), null).removedGroups.sort()).toEqual([SHARMA, XYZ].sort());
    expect(diffContext(employeeContext([xyz]), null).userChanged).toBe(true);
  });

  it("sees a different user, role, client-mode switch and number change", () => {
    const a = employeeContext([xyz]);
    const b: DesktopContext = { ...employeeContext([xyz]), user: { ...a.user, id: "u-emp4" } };
    expect(diffContext(a, b).userChanged).toBe(true);
    expect(diffContext(a, { ...a, clientMode: false }).clientModeChanged).toBe(true);
    expect(diffContext(a, { ...a, employeeNotifications: true }).notificationsChanged).toBe(true);
    expect(diffContext(a, { ...a, numbers: [NUMBERS.staff!, NUMBERS.managers!] }).numbersChanged).toBe(true);
    expect(diffContext(a, partnerContext()).roleChanged).toBe(true);
  });

  it("closes the open chat of a cover that ended, and only that one", () => {
    const now = Date.UTC(2026, 9, 23, 18, 35);
    const after = buildClientModePolicy(employeeContext([xyz]), session, now, now);
    const open = [
      { numberId: "n-staff", title: SHARMA },
      { numberId: "n-staff", title: XYZ },
    ];
    expect(chatsToClose(open, after, now)).toEqual([{ numberId: "n-staff", title: SHARMA }]);
  });

  it("a pending hand-off doesn't keep a no-longer-allowed group open", () => {
    const now = Date.UTC(2026, 9, 23);
    const after = buildClientModePolicy(employeeContext([xyz]), { ...session, pendingHandoff: { phoneDigits: "919845012345", expiresAt: now + 60_000 } }, now, now);
    expect(chatsToClose([{ numberId: "n-staff", title: SHARMA }], after, now)).toHaveLength(1);
  });

  it("closes nothing for Partners and Managers", () => {
    const now = Date.UTC(2026, 9, 23);
    const p = buildClientModePolicy(partnerContext(), session, now, now);
    expect(p.enabled).toBe(false);
    expect(chatsToClose([{ numberId: "n-vinay", title: PATEL }], p, now)).toEqual([]);
  });
});

describe("client mode policy", () => {
  const now = Date.UTC(2026, 9, 22, 10);

  it("runs for Employees only while the setting is on", () => {
    expect(effectiveClientMode(employeeContext([xyz]))).toBe(true);
    expect(effectiveClientMode(employeeContext([xyz], { clientMode: false }))).toBe(false);
    expect(effectiveClientMode(partnerContext())).toBe(false);
    expect(effectiveClientMode({ ...partnerContext(), user: { ...partnerContext().user, role: "manager" } })).toBe(false);
  });

  it("lists the allowed group names and session chats", () => {
    const p = buildClientModePolicy(employeeContext([xyz, sharma]), { ...session, sessionChats: ["+91 98450 12345"] }, now, now);
    expect(p).toEqual({ enabled: true, allowedGroupNames: [XYZ, SHARMA], sessionChats: ["+91 98450 12345"], pendingHandoff: null, notice: null });
  });

  it("fails closed when the context hasn't refreshed for too long", () => {
    const p = buildClientModePolicy(employeeContext([xyz]), { ...session, sessionChats: ["x"] }, now - CONTEXT_STALE_MS - 1, now);
    expect(p.enabled).toBe(true);
    expect(p.allowedGroupNames).toEqual([]);
    expect(p.sessionChats).toEqual([]);
  });

  it("is off with no context", () => {
    expect(buildClientModePolicy(null, session, 0, now).enabled).toBe(false);
  });
});

describe("which client a chat belongs to", () => {
  it("uses the allow-list, then chats opened this session", () => {
    const ctx = employeeContext([xyz]);
    expect(clientForTitle(XYZ, ctx, new Map())).toEqual({ clientId: "c-xyz", clientName: "XYZ Traders" });
    expect(clientForTitle(PATEL, partnerContext(), new Map([[PATEL, { clientId: "c-patel", clientName: "Patel Builders" }]]))).toEqual({
      clientId: "c-patel",
      clientName: "Patel Builders",
    });
    expect(clientForTitle("Someone", ctx, new Map())).toBeNull();
    expect(clientForTitle(null, ctx, new Map())).toBeNull();
  });
});

describe("reading /api/desktop/context", () => {
  const good = {
    user: { id: "u1", employeeId: "e1", name: "Anita", role: "employee" },
    clientMode: true,
    employeeNotifications: false,
    numbers: [{ id: "n-staff", label: "Staff office", kind: "staff_office", usableBy: ["partner", "manager", "employee"], ownerEmployeeId: null }],
    allowedGroups: [{ clientId: "c1", clientName: "XYZ Traders", groupName: XYZ }],
  };

  it("accepts the contract shape", () => {
    expect(parseContext(good)?.allowedGroups).toHaveLength(1);
    expect(parseContext({ ...good, user: { ...good.user, role: "partner" }, allowedGroups: null })?.allowedGroups).toBeNull();
  });

  it("refuses an Employee with allowedGroups null (that would mean all groups)", () => {
    expect(parseContext({ ...good, allowedGroups: null })).toBeNull();
  });

  it("refuses anything malformed rather than half-using it", () => {
    expect(parseContext(null)).toBeNull();
    expect(parseContext({ ...good, clientMode: "yes" })).toBeNull();
    expect(parseContext({ ...good, user: { ...good.user, role: "admin" } })).toBeNull();
    expect(parseContext({ ...good, numbers: [{ ...good.numbers[0], kind: "personal" }] })).toBeNull();
    expect(parseContext({ ...good, numbers: [{ ...good.numbers[0], id: "../x" }] })).toBeNull();
    expect(parseContext({ ...good, allowedGroups: [{ clientId: "c1" }] })).toBeNull();
  });
});

describe("ContextService", () => {
  function service(results: Array<ApiResult<DesktopContext>>) {
    const seen: Array<{ state: ContextState; removed: string[]; error: string | null }> = [];
    let t = Date.UTC(2026, 9, 22, 9);
    let tick: (() => void) | null = null;
    let calls = 0;
    const s = new ContextService({
      load: async () => results[Math.min(calls++, results.length - 1)]!,
      onResult: (state, diff, error) => seen.push({ state, removed: diff.removedGroups, error }),
      now: () => t,
      setInterval: (fn, ms) => {
        expect(ms).toBe(CONTEXT_REFRESH_MS);
        tick = fn;
        return 1;
      },
      clearInterval: () => (tick = null),
    });
    return { s, seen, advance: (ms: number) => (t += ms), tick: () => tick?.(), calls: () => calls };
  }

  it("refreshes every 5 minutes and reports the diff", async () => {
    const h = service([
      { kind: "ok", data: employeeContext([xyz, sharma]) },
      { kind: "ok", data: employeeContext([xyz]) },
    ]);
    h.s.start();
    await h.s.refresh();
    h.advance(CONTEXT_REFRESH_MS);
    h.tick();
    await h.s.refresh();
    expect(h.seen.map((x) => x.removed)).toContainEqual([SHARMA]);
    expect(h.s.context?.allowedGroups).toEqual([xyz]);
  });

  it("shares one request between concurrent callers", async () => {
    const h = service([{ kind: "ok", data: employeeContext([xyz]) }]);
    await Promise.all([h.s.refresh(), h.s.refresh(), h.s.refresh()]);
    expect(h.calls()).toBe(1);
  });

  it("401 → signed out; 403 revoked → revoked", async () => {
    const a = service([{ kind: "ok", data: employeeContext([xyz]) }, { kind: "signed-out" }]);
    await a.s.refresh();
    await a.s.refresh();
    expect(a.s.state.kind).toBe("signed-out");
    expect(a.s.lastGoodAt).toBe(0);
    const b = service([{ kind: "revoked" }]);
    await b.s.refresh();
    expect(b.s.state.kind).toBe("revoked");
  });

  it("keeps the last context on a network error (the policy then goes stale and fails closed)", async () => {
    const h = service([{ kind: "ok", data: employeeContext([xyz]) }, { kind: "error", message: "offline", ref: null }]);
    await h.s.refresh();
    const good = h.s.lastGoodAt;
    h.advance(CONTEXT_REFRESH_MS);
    await h.s.refresh();
    expect(h.s.state.kind).toBe("signed-in");
    expect(h.s.lastGoodAt).toBe(good);
    expect(h.seen.at(-1)?.error).toBe("offline");
  });

  it("markSignedOut acts at once", async () => {
    const h = service([{ kind: "ok", data: employeeContext([xyz]) }]);
    await h.s.refresh();
    h.s.markSignedOut();
    expect(h.s.state.kind).toBe("signed-out");
    expect(h.seen.at(-1)?.removed).toEqual([XYZ]);
  });
});
