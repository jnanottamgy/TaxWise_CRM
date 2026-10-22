import { describe, expect, it } from "vitest";
import { bannerHeight, clampPanelWidth, dockedLayout, hiddenLayout, poppedLayout, widthFromScreenX } from "../src/main/layout";
import { ensureVisible, JsonFile, parseDeviceState, parseWindowState } from "../src/main/local-state";
import { buildPanelState, type PanelInput } from "../src/main/panel-state";
import { PANEL } from "../src/shared/config";
import { employeeContext, group, NUMBERS, partnerContext, XYZ } from "./helpers";

describe("panel width (§7.25.3: default 440, 360–720)", () => {
  it("clamps to 360–720", () => {
    expect(clampPanelWidth(440, 1366)).toBe(440);
    expect(clampPanelWidth(100, 1366)).toBe(360);
    expect(clampPanelWidth(5000, 1920)).toBe(720);
    expect(clampPanelWidth(Number.NaN, 1366)).toBe(PANEL.defaultWidth);
  });
  it("keeps the CRM usable on a narrow window, but never goes below 360", () => {
    expect(clampPanelWidth(720, 1000)).toBe(1000 - PANEL.splitterWidth - PANEL.minCrmWidth);
    expect(clampPanelWidth(720, 700)).toBe(360);
  });
  it("follows the splitter", () => {
    const content = { x: 100, y: 50, width: 1366, height: 768 };
    expect(widthFromScreenX(100 + 1366 - 443, content)).toBe(440);
    expect(widthFromScreenX(0, content)).toBe(720);
    expect(widthFromScreenX(100 + 1366, content)).toBe(360);
  });
});

describe("view bounds", () => {
  it("docked: CRM left, panel column right, WhatsApp under the 36 px header", () => {
    const L = dockedLayout({ width: 1366, height: 768 }, 440, 0, false);
    expect(L.crm).toEqual({ x: 0, y: 0, width: 920, height: 768 });
    expect(L.header).toEqual({ x: 920, y: 0, width: 446, height: 768 });
    expect(L.whatsapp).toEqual({ x: 926, y: 36, width: 440, height: 732 });
  });
  it("leaves room for a banner", () => {
    expect(dockedLayout({ width: 1366, height: 768 }, 440, bannerHeight({ kind: "link", numberLabel: "Staff office", partnerOwn: false }), false).whatsapp.y).toBe(36 + 88);
    expect(bannerHeight({ kind: "notice", tone: "warning", text: "x" })).toBe(76);
    expect(bannerHeight(null)).toBe(0);
  });
  it("while dragging, the header covers the window so it keeps the pointer", () => {
    expect(dockedLayout({ width: 1366, height: 768 }, 440, 0, true).header).toEqual({ x: 0, y: 0, width: 1366, height: 768 });
  });
  it("hidden and popped out", () => {
    expect(hiddenLayout({ width: 1366, height: 768 }).crm).toEqual({ x: 0, y: 0, width: 1366, height: 768 });
    expect(poppedLayout({ width: 500, height: 900 }, 0)).toEqual({ header: { x: 0, y: 0, width: 500, height: 900 }, whatsapp: { x: 0, y: 36, width: 500, height: 864 } });
  });
});

describe("remembered window size and panel width", () => {
  it("parses and clamps what was saved", () => {
    const s = parseWindowState({ bounds: { x: 10, y: 20, width: 1400, height: 800 }, maximized: true, panelWidth: 9999, panelVisible: false, lastNumberByUser: { "u-1": "n-staff", "bad key!": "x" } });
    expect(s).toEqual({ bounds: { x: 10, y: 20, width: 1400, height: 800 }, maximized: true, panelWidth: 720, panelVisible: false, popoutBounds: null, lastNumberByUser: { "u-1": "n-staff" } });
  });
  it("falls back to defaults on a damaged file", () => {
    expect(parseWindowState("garbage").panelWidth).toBe(440);
    expect(parseWindowState({ bounds: { x: 0, y: 0, width: 10, height: 10 } }).bounds).toBeNull();
  });
  it("drops bounds that are off every screen", () => {
    const screen = [{ x: 0, y: 0, width: 1920, height: 1040 }];
    expect(ensureVisible({ x: 100, y: 100, width: 1200, height: 700 }, screen)).not.toBeNull();
    expect(ensureVisible({ x: 3000, y: 100, width: 1200, height: 700 }, screen)).toBeNull();
  });
  it("device state keeps only valid entries", () => {
    expect(
      parseDeviceState({ linked: { "n-staff": 1, "../x": 2 }, revoked: true, partitions: ["persist:wa-n-staff", "persist:crm"], pendingLinkReports: [{ numberId: "n-staff", linked: true }, { numberId: 3 }] }),
    ).toEqual({ linked: { "n-staff": 1 }, revoked: true, partitions: ["persist:wa-n-staff"], pendingLinkReports: [{ numberId: "n-staff", linked: true }] });
  });
  it("writes atomically through a temp file", () => {
    const ops: string[] = [];
    const f = new JsonFile("/u/window-state.json", parseWindowState, {
      readFileSync: () => {
        throw new Error("ENOENT");
      },
      writeFileSync: (p) => void ops.push(`write ${p}`),
      renameSync: (a, b) => void ops.push(`rename ${a} ${b}`),
    });
    expect(f.load().panelWidth).toBe(440);
    f.saveNow(f.load());
    expect(ops).toEqual(["write /u/window-state.json.tmp", "rename /u/window-state.json.tmp /u/window-state.json"]);
  });
});

describe("what the panel shows", () => {
  const base: PanelInput = {
    mode: "docked",
    width: 440,
    dragging: false,
    offsetX: 0,
    ctx: employeeContext([group("c-xyz", "XYZ Traders", XYZ)]),
    linkedHere: new Set(["n-staff"]),
    activeNumberId: "n-staff",
    linkingNumberId: null,
    revoked: false,
    offline: false,
    clientModeFailed: false,
    activePageState: "chats",
    openClientName: "XYZ Traders",
    notice: null,
  };

  it("an Employee in client mode: Staff office and the client-mode chip", () => {
    const { view, showNumberId } = buildPanelState(base);
    expect(showNumberId).toBe("n-staff");
    expect(view.numbers.map((n) => n.id)).toEqual(["n-staff"]);
    expect(view.chip).toEqual({ clientName: "XYZ Traders" });
    expect(view.screen).toBeNull();
  });

  it("fails closed: WhatsApp hidden behind the 'unavailable' screen", () => {
    const r = buildPanelState({ ...base, clientModeFailed: true });
    expect(r.showNumberId).toBeNull();
    expect(r.view.screen).toEqual({ kind: "client-mode-unavailable" });
  });

  it("a removed PC shows the removed screen and no WhatsApp", () => {
    const r = buildPanelState({ ...base, revoked: true });
    expect(r.view.screen).toEqual({ kind: "removed" });
    expect(r.showNumberId).toBeNull();
    expect(r.view.chip).toBeNull();
  });

  it("the QR screen gets the link instructions", () => {
    const r = buildPanelState({ ...base, linkedHere: new Set(), activeNumberId: null, linkingNumberId: "n-staff", activePageState: "qr" });
    expect(r.showNumberId).toBe("n-staff");
    expect(r.view.banner).toEqual({ kind: "link", numberLabel: "Staff office", partnerOwn: false });
  });

  it("a Partner linking their own number is reminded to do it only on their own PC; no chip for Partners", () => {
    const r = buildPanelState({ ...base, ctx: partnerContext(), linkedHere: new Set(), activeNumberId: null, linkingNumberId: "n-vinay", activePageState: "qr" });
    expect(r.view.banner).toEqual({ kind: "link", numberLabel: NUMBERS.vinay!.label, partnerOwn: true });
    expect(r.view.chip).toBeNull();
  });

  it("nothing linked and nothing chosen: offer the numbers to link", () => {
    const r = buildPanelState({ ...base, ctx: partnerContext(), linkedHere: new Set(), activeNumberId: null });
    expect(r.view.screen?.kind).toBe("no-numbers");
    expect(r.showNumberId).toBeNull();
  });

  it("before the context loads: loading, or offline after a failure", () => {
    expect(buildPanelState({ ...base, ctx: null }).view.screen).toEqual({ kind: "loading" });
    expect(buildPanelState({ ...base, ctx: null, offline: true }).view.screen).toEqual({ kind: "offline" });
  });

  it("a notice replaces the link banner", () => {
    const r = buildPanelState({ ...base, notice: { tone: "warning", text: "Couldn't find it" } });
    expect(r.view.banner).toEqual({ kind: "notice", tone: "warning", text: "Couldn't find it" });
  });
});
