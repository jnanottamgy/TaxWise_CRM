import { describe, expect, it } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import { applicationMenuTemplate, contextMenuTemplate, isToggleShortcut, TOGGLE_ACCELERATOR } from "../src/main/menu";

const actions = { toggleWhatsApp: () => undefined, reloadCrm: () => undefined, checkForUpdates: () => undefined, showAbout: () => undefined };

function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((i) => [i, ...(Array.isArray(i.submenu) ? flatten(i.submenu) : [])]);
}

const params = (over: Partial<Parameters<typeof contextMenuTemplate>[0]> = {}) => ({
  isEditable: false,
  selectionText: "",
  misspelledWord: "",
  dictionarySuggestions: [] as string[],
  editFlags: { canUndo: true, canRedo: true, canCut: true, canCopy: true, canPaste: true, canDelete: true, canSelectAll: true, canEditRichly: true },
  ...over,
});

describe("no DevTools and no Inspect in production (§7.25.3)", () => {
  it("the production menu has no DevTools", () => {
    for (const isMac of [true, false]) {
      const all = flatten(applicationMenuTemplate({ isMac, isDev: false, appName: "TaxWise Desktop" }, actions));
      expect(all.some((i) => i.role === "toggleDevTools")).toBe(false);
      expect(all.some((i) => /inspect|developer/i.test(String(i.label ?? "")))).toBe(false);
    }
  });

  it("development builds keep DevTools", () => {
    const all = flatten(applicationMenuTemplate({ isMac: false, isDev: true, appName: "TaxWise Desktop" }, actions));
    expect(all.some((i) => i.role === "toggleDevTools")).toBe(true);
  });

  it("the production context menu never offers Inspect", () => {
    for (const p of [params(), params({ isEditable: true }), params({ selectionText: "GSTIN" }), params({ isEditable: true, misspelledWord: "recieve", dictionarySuggestions: ["receive"] })]) {
      const items = contextMenuTemplate(p, { isDev: false }, { replaceMisspelling: () => undefined, addToDictionary: () => undefined, inspect: () => undefined });
      expect(items.some((i) => /inspect/i.test(String(i.label ?? "")))).toBe(false);
    }
  });

  it("offers edit commands and spelling only", () => {
    const items = contextMenuTemplate(params({ isEditable: true, misspelledWord: "recieve", dictionarySuggestions: ["receive", "relieve"] }), { isDev: false }, {
      replaceMisspelling: () => undefined,
      addToDictionary: () => undefined,
    });
    expect(items.map((i) => i.label ?? i.role ?? i.type)).toEqual(["receive", "relieve", "Add to dictionary", "separator", "cut", "copy", "paste", "separator", "selectAll"]);
    expect(contextMenuTemplate(params({ selectionText: "29AAXFT1811B1Z3" }), { isDev: false }, { replaceMisspelling: () => undefined, addToDictionary: () => undefined }).map((i) => i.role)).toEqual(["copy"]);
    expect(contextMenuTemplate(params(), { isDev: false }, { replaceMisspelling: () => undefined, addToDictionary: () => undefined })).toEqual([]);
  });
});

describe("Ctrl+Shift+W", () => {
  const key = (over: object) => ({ type: "keyDown", key: "W", control: true, meta: false, shift: true, alt: false, ...over }) as Parameters<typeof isToggleShortcut>[0];
  it("toggles the panel", () => {
    expect(isToggleShortcut(key({}), false)).toBe(true);
    expect(isToggleShortcut(key({ key: "w" }), false)).toBe(true);
    expect(isToggleShortcut(key({ control: false, meta: true }), true)).toBe(true);
    expect(TOGGLE_ACCELERATOR).toBe("CmdOrCtrl+Shift+W");
  });
  it("ignores other keys", () => {
    expect(isToggleShortcut(key({ shift: false }), false)).toBe(false);
    expect(isToggleShortcut(key({ alt: true }), false)).toBe(false);
    expect(isToggleShortcut(key({ type: "keyUp" }), false)).toBe(false);
    expect(isToggleShortcut(key({ key: "Q" }), false)).toBe(false);
    expect(isToggleShortcut(key({ control: false, meta: true }), false)).toBe(false);
  });
});
