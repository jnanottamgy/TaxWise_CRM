import { afterEach, describe, expect, it } from "vitest";
import { COPY } from "../src/shared/copy";
import { findExactResult, inviteFallbackUrl, openChatBySearch, resultTitle } from "../src/whatsapp/open-chat";
import { loadFixture, XYZ } from "./helpers";

let windows: Array<{ happyDOM: { close(): Promise<void> } }> = [];
afterEach(async () => {
  for (const w of windows) await w.happyDOM.close();
  windows = [];
});

function row(doc: Document, title: string): Element {
  const r = doc.createElement("div");
  r.setAttribute("role", "row");
  const inner = doc.createElement("div");
  inner.setAttribute("tabindex", "-1");
  const name = doc.createElement("span");
  name.setAttribute("dir", "auto");
  name.setAttribute("title", title);
  name.textContent = title;
  // A last-message preview after the name: never read, never matched.
  const preview = doc.createElement("span");
  preview.setAttribute("dir", "auto");
  preview.setAttribute("title", "Please send the purchase register");
  inner.append(name, preview);
  r.append(inner);
  return r;
}

/**
 * WhatsApp's search, simulated: typing into the search box shows these results after a moment;
 * mousedown on a result opens that chat.
 */
function simulateWhatsApp(doc: Document, results: string[], opts: { opens?: boolean } = {}) {
  const typed: string[] = [];
  const clicked: string[] = [];
  const list = doc.querySelector("#pane-side")!;
  const insertText = (_d: Document, text: string) => {
    const box = doc.activeElement as HTMLElement;
    box.textContent = text;
    typed.push(text);
    setTimeout(() => {
      list.replaceChildren(...results.map((t) => row(doc, t)));
      for (const r of Array.from(list.children)) {
        r.addEventListener("mousedown", () => {
          const t = r.querySelector("span[title]")!.getAttribute("title")!;
          clicked.push(t);
          if (opts.opens === false) return;
          doc.querySelector("#main")?.remove();
          const main = doc.createElement("div");
          main.id = "main";
          main.innerHTML = `<header><div role="button"><span dir="auto"></span></div></header>`;
          const span = main.querySelector("span")!;
          span.setAttribute("title", t);
          span.textContent = t;
          doc.querySelector("#app .two")!.append(main);
        });
      }
    }, 5);
    return true;
  };
  return { typed, clicked, insertText };
}

const realTime = { sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), now: () => Date.now(), pollMs: 5, resultTimeoutMs: 300, openTimeoutMs: 300 };

describe("exact-title matching (§7.25.5 step 2)", () => {
  it("picks only the result whose title matches exactly", () => {
    const { window, doc } = loadFixture("search.html");
    windows.push(window as never);
    const rows = [
      row(doc, `${XYZ} (old)`),
      row(doc, "TW · TW-C-01420 · XYZ Traders"),
      row(doc, "tw · tw-c-0142 · xyz traders"),
      row(doc, XYZ),
      row(doc, XYZ),
    ];
    expect(findExactResult(rows, XYZ)).toBe(rows[3]);
    expect(findExactResult(rows.slice(0, 3), XYZ)).toBeNull();
  });

  it("ignores direction marks and non-breaking spaces WhatsApp may add, but not case or extra words", () => {
    const { window, doc } = loadFixture("search.html");
    windows.push(window as never);
    expect(findExactResult([row(doc, `‎${XYZ.replace(/ /g, " ")}`)], XYZ)).not.toBeNull();
    expect(findExactResult([row(doc, `${XYZ} `)], XYZ)).not.toBeNull();
    expect(findExactResult([row(doc, XYZ.toUpperCase())], XYZ)).toBeNull();
  });

  it("reads the chat name, not the message preview", () => {
    const { window, doc } = loadFixture("search.html");
    windows.push(window as never);
    expect(resultTitle(row(doc, XYZ))).toBe(XYZ);
  });
});

describe("in-page search on a fixture", () => {
  it("types the group name into the search box and clicks the exact match", async () => {
    const { window, doc } = loadFixture("search.html");
    windows.push(window as never);
    const wa = simulateWhatsApp(doc, [`${XYZ} (old)`, "TW · TW-C-01420 · XYZ Traders", XYZ]);
    const res = await openChatBySearch(XYZ, { doc, insertText: wa.insertText, ...realTime });
    expect(res).toEqual({ ok: true });
    expect(wa.typed).toEqual([XYZ]);
    expect(wa.clicked).toEqual([XYZ]);
    expect(doc.querySelector("#main header span")?.getAttribute("title")).toBe(XYZ);
  });

  it("does nothing if the group is already open", async () => {
    const { window, doc } = loadFixture("group-open.html");
    windows.push(window as never);
    const wa = simulateWhatsApp(doc, [XYZ]);
    expect(await openChatBySearch(XYZ, { doc, insertText: wa.insertText, ...realTime })).toEqual({ ok: true });
    expect(wa.typed).toEqual([]);
  });

  it("reports not-found when no result matches exactly, and clears the search", async () => {
    const { window, doc } = loadFixture("search.html");
    windows.push(window as never);
    const wa = simulateWhatsApp(doc, [`${XYZ} (old)`]);
    expect(await openChatBySearch(XYZ, { doc, insertText: wa.insertText, ...realTime })).toEqual({ ok: false, reason: "not-found" });
    expect(wa.clicked).toEqual([]);
  });

  it("reports a missing search box", async () => {
    const { window, doc } = loadFixture("changed-search-box.html");
    windows.push(window as never);
    expect(await openChatBySearch(XYZ, { doc, insertText: () => true, ...realTime })).toEqual({ ok: false, reason: "no-search-box" });
  });

  it("reports broken selectors when a clicked result never opens a conversation", async () => {
    const { window, doc } = loadFixture("search.html");
    windows.push(window as never);
    const wa = simulateWhatsApp(doc, [XYZ], { opens: false });
    expect(await openChatBySearch(XYZ, { doc, insertText: wa.insertText, ...realTime })).toEqual({ ok: false, reason: "selectors" });
    expect(wa.clicked).toEqual([XYZ]);
  });
});

describe("fallback and failure message", () => {
  it("builds the invite fallback only for a real invite code", () => {
    expect(inviteFallbackUrl("AbCdEfGhIjKlMnOpQrStUv")).toBe("https://web.whatsapp.com/accept?code=AbCdEfGhIjKlMnOpQrStUv");
    expect(inviteFallbackUrl(null)).toBeNull();
    expect(inviteFallbackUrl("abc")).toBeNull();
    expect(inviteFallbackUrl("AbCdEfGhIj&x=1")).toBeNull();
    expect(inviteFallbackUrl("https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv")).toBeNull();
  });

  it("says exactly what the spec says", () => {
    expect(COPY.couldNotFind(XYZ, "Staff office")).toBe(
      "Couldn't find 'TW · TW-C-0142 · XYZ Traders' on the Staff office WhatsApp. Check the group name, or that this number is in the group.",
    );
    expect(COPY.linkThisPc("Staff office")).toBe(
      "Link this PC: on the Staff office phone, open WhatsApp → Settings → Linked devices → Link a device, and scan this code.",
    );
    expect(COPY.clientModeUnavailable).toBe("Client mode is unavailable because WhatsApp changed its page. A Partner has been told.");
    expect(COPY.clientModeChip("XYZ Traders")).toBe("XYZ Traders · client mode");
  });
});
