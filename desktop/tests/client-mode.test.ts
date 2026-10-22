import { afterEach, describe, expect, it } from "vitest";
import { buildClientModePolicy, chatsToClose, diffContext } from "../src/main/context";
import { ClientModeReporter } from "../src/main/reporters";
import { decideChat } from "../src/shared/chat-rules";
import { COPY } from "../src/shared/copy";
import { CLIENT_MODE_ATTR, ClientModeController, clientModeCss, DISABLED_POLICY, OPENING_ATTR } from "../src/whatsapp/client-mode";
import { checkSelectors, detectPageState } from "../src/whatsapp/page";
import { ALLOWED_MARK } from "../src/whatsapp/selectors";
import type { ClientModePolicy } from "../src/shared/types";
import {
  employeeContext,
  escapeClosesChat,
  FakeTimers,
  flush,
  group,
  loadFixture,
  PATEL,
  policy,
  recordingBridge,
  SHARMA,
  XYZ,
} from "./helpers";

let windows: Array<{ happyDOM: { close(): Promise<void> } }> = [];
afterEach(async () => {
  for (const w of windows) await w.happyDOM.close();
  windows = [];
});

function setup(fixture: string, p: ClientModePolicy | "pending", opts: { escapeWorks?: boolean } = {}) {
  const { window, doc } = loadFixture(fixture);
  windows.push(window as never);
  if (opts.escapeWorks !== false) escapeClosesChat(doc);
  const timers = new FakeTimers();
  const { bridge, rec } = recordingBridge();
  const c = new ClientModeController({ doc, bridge, timers, selectorCheckMs: 10 * 60 * 1000, loadingTimeoutMs: 60_000, closeVerifyMs: 600 });
  c.start(p);
  return { doc, c, rec, timers };
}

const main = (doc: Document) => doc.querySelector("#main");

describe("the rule (pure)", () => {
  const now = Date.UTC(2026, 9, 22);
  it("allows an allowed group, by exact name only", () => {
    expect(decideChat(XYZ, policy(), now)).toBe("allow");
    expect(decideChat(`  ${XYZ.replace(/ /g, " ")} `, policy(), now)).toBe("allow");
    expect(decideChat("‎" + XYZ, policy(), now)).toBe("allow");
    expect(decideChat(XYZ.toLowerCase(), policy(), now)).toBe("deny");
    expect(decideChat(`${XYZ} (old)`, policy(), now)).toBe("deny");
    expect(decideChat("TW · TW-C-0142 · XYZ", policy(), now)).toBe("deny");
  });
  it("no chat open is not a denial", () => {
    expect(decideChat(null, policy(), now)).toBe("none");
  });
  it("client mode off allows everything", () => {
    expect(decideChat(PATEL, DISABLED_POLICY, now)).toBe("allow");
  });
  it("a hand-off adopts the next chat; a different unsaved number is refused", () => {
    const p = policy({ pendingHandoff: { phoneDigits: "919845012345", expiresAt: now + 60_000 } });
    expect(decideChat("+91 98450 12345", p, now)).toBe("adopt");
    expect(decideChat("XYZ Traders – Ramesh (Director)", p, now)).toBe("adopt");
    expect(decideChat("+91 90000 00000", p, now)).toBe("deny");
    expect(decideChat("+91 98450 12345", p, now + 61_000)).toBe("deny");
  });
});

describe("page state and selector self-check against fixtures", () => {
  it("reads each fixture's state", () => {
    const cases: Array<[string, string]> = [
      ["qr.html", "qr"],
      ["chats.html", "chats"],
      ["group-open.html", "chats"],
      ["changed-everything.html", "loading"],
    ];
    for (const [f, state] of cases) {
      const { window, doc } = loadFixture(f);
      windows.push(window as never);
      expect(detectPageState(doc), f).toBe(state);
    }
  });

  it("passes on the current WhatsApp structure", () => {
    for (const f of ["qr.html", "chats.html", "group-open.html", "other-chat-open.html", "one-to-one-open.html"]) {
      const { window, doc } = loadFixture(f);
      windows.push(window as never);
      expect(checkSelectors(doc, false), f).toMatchObject({ ok: true, failing: [] });
    }
  });

  it("names what broke", () => {
    const a = loadFixture("changed-search-box.html");
    const b = loadFixture("changed-title.html");
    const c = loadFixture("changed-everything.html");
    windows.push(a.window as never, b.window as never, c.window as never);
    expect(checkSelectors(a.doc, false).failing).toEqual(["searchBox"]);
    expect(checkSelectors(b.doc, false).failing).toEqual(["conversationTitle"]);
    expect(checkSelectors(c.doc, false).ok).toBe(true); // still loading: not judged yet
    expect(checkSelectors(c.doc, true).failing).toEqual(["qrCode", "chatList"]);
  });
});

describe("client mode on WhatsApp Web fixtures (§7.25.5, §18.3 Employee 8)", () => {
  it("an allowed group shows; the chat list stays hidden", async () => {
    const { doc, c, rec } = setup("group-open.html", policy());
    await flush();
    expect(c.shieldState).toBe("hidden");
    expect(main(doc)?.getAttribute(ALLOWED_MARK)).toBe(XYZ);
    expect(rec.titles.at(-1)).toEqual({ title: XYZ, verdict: "allow" });
    expect(rec.denied).toEqual([]);
    expect(doc.documentElement.hasAttribute(CLIENT_MODE_ATTR)).toBe(true);
    expect(doc.documentElement.hasAttribute(OPENING_ATTR)).toBe(false);
    const sheets = [...doc.adoptedStyleSheets].map((s) => [...s.cssRules].map((r) => r.cssText).join("\n")).join("\n");
    const css = sheets || doc.getElementById("taxwise-client-mode-style")?.textContent || "";
    expect(css).toContain("#side");
    expect(css).toContain("display: none");
  });

  it("any other chat is closed, the panel says 'Not one of your clients', and access_denied is reported", async () => {
    const { doc, c, rec, timers } = setup("other-chat-open.html", policy());
    await flush();
    expect(rec.denied).toEqual([PATEL]);
    expect(main(doc)).toBeNull(); // Escape closed it
    expect(c.shieldState).toBe("denied");
    expect(c.shield.covering).toBe(true);
    expect(c.shield.text).toContain(COPY.notOneOfYourClients);
    timers.advance(1000);
    expect(rec.resets).toBe(0);
  });

  it("reloads WhatsApp Web if Escape didn't close a refused chat", async () => {
    const { doc, c, rec, timers } = setup("other-chat-open.html", policy(), { escapeWorks: false });
    await flush();
    expect(main(doc)).not.toBeNull();
    expect(main(doc)?.hasAttribute(ALLOWED_MARK)).toBe(false); // hidden by CSS until allowed
    expect(c.shieldState).toBe("denied");
    timers.advance(600);
    expect(rec.resets).toBe(1);
  });

  it("closes the refused chat again each time it reappears", async () => {
    const { doc, rec } = setup("group-open.html", policy());
    await flush();
    const title = doc.querySelector("#main header span[dir='auto']")!;
    title.setAttribute("title", PATEL);
    title.textContent = PATEL;
    await flush();
    expect(rec.denied).toEqual([PATEL]);
    expect(main(doc)).toBeNull();
  });

  it("a covered client's group is allowed while the cover is in force, and closes when it ends", async () => {
    const withCover = employeeContext([group("c-xyz", "XYZ Traders", XYZ), group("c-sharma", "Sharma Exports", SHARMA)]);
    const afterCover = employeeContext([group("c-xyz", "XYZ Traders", XYZ)]);
    const t0 = Date.UTC(2026, 9, 22, 6);
    const session = { sessionChats: [], pendingHandoff: null, notice: null };
    const before = buildClientModePolicy(withCover, session, t0, t0);

    const { doc, c, rec } = setup("covered-group-open.html", before);
    await flush();
    expect(c.shieldState).toBe("hidden");
    expect(rec.denied).toEqual([]);

    // The next context refresh no longer lists the covered group.
    const diff = diffContext(withCover, afterCover);
    expect(diff.removedGroups).toEqual([SHARMA]);
    const after = buildClientModePolicy(afterCover, session, t0 + 5 * 60_000, t0 + 5 * 60_000);
    expect(chatsToClose([{ numberId: "n-staff", title: SHARMA }], after, t0)).toEqual([{ numberId: "n-staff", title: SHARMA }]);

    c.setPolicy(after);
    await flush();
    expect(main(doc)).toBeNull();
    expect(c.shieldState).toBe("denied");
  });

  it("a one-to-one chat the CRM opened (a hand-off) is allowed for the session", async () => {
    const now = new FakeTimers().now();
    const p = policy({ pendingHandoff: { phoneDigits: "919845012345", expiresAt: now + 60_000 } });
    const { doc, c, rec } = setup("one-to-one-open.html", p);
    await flush();
    expect(rec.adopted).toEqual(["+91 98450 12345"]);
    expect(c.shieldState).toBe("hidden");
    expect(main(doc)?.getAttribute(ALLOWED_MARK)).toBe("+91 98450 12345");

    // Main records it as a session chat and clears the hand-off: it stays allowed.
    c.setPolicy(policy({ sessionChats: ["+91 98450 12345"] }));
    await flush();
    expect(c.shieldState).toBe("hidden");
    expect(rec.denied).toEqual([]);
  });

  it("a hand-off adopts only one chat", async () => {
    const now = new FakeTimers().now();
    const p = policy({ pendingHandoff: { phoneDigits: "919845012345", expiresAt: now + 60_000 } });
    const { doc, rec } = setup("one-to-one-open.html", p);
    await flush();
    const title = doc.querySelector("#main header span[dir='auto']")!;
    title.setAttribute("title", "Someone Else");
    await flush();
    expect(rec.adopted).toEqual(["+91 98450 12345"]);
    expect(rec.denied).toEqual(["Someone Else"]);
  });

  it("a one-to-one chat the CRM did not open is refused", async () => {
    const { rec } = setup("one-to-one-open.html", policy());
    await flush();
    expect(rec.denied).toEqual(["+91 98450 12345"]);
  });

  it("with no chat open, the page is covered", async () => {
    const { c } = setup("chats.html", policy());
    await flush();
    expect(c.shieldState).toBe("idle");
    expect(c.shield.text).toContain(COPY.clientModeIdleTitle);
  });

  it("the QR screen stays visible so the number can be linked", async () => {
    const { c, rec } = setup("qr.html", policy());
    await flush();
    expect(c.shieldState).toBe("hidden");
    expect(rec.pageStates).toContain("qr");
  });

  it("covers the page while a chat is being opened, even once it has opened, until the search pane is hidden again", async () => {
    const { doc, c } = setup("chats.html", policy());
    await flush();
    c.beginOpening(XYZ);
    expect(c.shieldState).toBe("opening");
    expect(c.shield.covering).toBe(true);
    expect(doc.documentElement.hasAttribute(OPENING_ATTR)).toBe(true);
    // The group opens (WhatsApp renders the conversation) while the search pane is still showing.
    const main = doc.createElement("div");
    main.id = "main";
    main.innerHTML = `<header><span dir="auto" title="${XYZ}">${XYZ}</span></header>`;
    doc.querySelector("#app .two")!.append(main);
    await flush();
    expect(c.shieldState).toBe("opening");
    c.endOpening();
    expect(doc.documentElement.hasAttribute(OPENING_ATTR)).toBe(false);
    expect(c.shieldState).toBe("hidden");
  });

  it("before the app sends its policy, an Employee's panel is covered, and nothing is closed or logged on a guess", async () => {
    const { doc, c, rec } = setup("group-open.html", "pending");
    await flush();
    expect(c.shieldState).toBe("loading");
    expect(rec.denied).toEqual([]);
    expect(main(doc)).not.toBeNull();
    expect(main(doc)?.hasAttribute(ALLOWED_MARK)).toBe(false);
    c.setPolicy(policy());
    await flush();
    expect(c.shieldState).toBe("hidden");
  });

  it("an empty allow-list (e.g. a stale context) refuses every chat", async () => {
    const { rec } = setup("group-open.html", { ...DISABLED_POLICY, enabled: true });
    await flush();
    expect(rec.denied).toEqual([XYZ]);
  });

  it("Partners and Managers (client mode off): nothing is hidden, covered or reported", async () => {
    const { doc, c, rec } = setup("other-chat-open.html", DISABLED_POLICY);
    await flush();
    expect(c.shieldState).toBe("hidden");
    expect(doc.documentElement.hasAttribute(CLIENT_MODE_ATTR)).toBe(false);
    expect(rec.titles).toEqual([]);
    expect(rec.denied).toEqual([]);
    expect(main(doc)).not.toBeNull();
  });
});

describe("client mode fails closed when WhatsApp changes its page (§18.3 Employee 10)", () => {
  it("a missing search box: cover up, Partners told via /api/desktop/health", async () => {
    const { c, rec } = setup("changed-search-box.html", policy());
    await flush();
    expect(c.shieldState).toBe("unavailable");
    expect(c.shield.text).toBe(COPY.clientModeUnavailable);
    expect(rec.selectors).toEqual([{ ok: false, failing: ["searchBox"] }]);

    // The main process side: one health report a day per failure, carrying the failing selectors.
    const calls: string[][] = [];
    const reporter = new ClientModeReporter({
      health: async (failing) => {
        calls.push([...failing]);
        return { kind: "ok", data: {} };
      },
      accessDenied: async () => ({ kind: "ok", data: {} }),
    });
    const now = Date.UTC(2026, 9, 22, 6);
    expect(await reporter.selectorsFailed("n-staff", rec.selectors[0]!.failing, now)).toBe(true);
    expect(await reporter.selectorsFailed("n-staff", rec.selectors[0]!.failing, now + 3_600_000)).toBe(false);
    expect(calls).toEqual([["searchBox"]]);
  });

  it("an unreadable conversation title fails closed at once", async () => {
    const { doc, c, rec } = setup("changed-title.html", policy());
    await flush();
    expect(c.shieldState).toBe("unavailable");
    expect(rec.selectors.at(-1)).toEqual({ ok: false, failing: ["conversationTitle"] });
    expect(main(doc)?.hasAttribute(ALLOWED_MARK)).toBe(false);
  });

  it("an unrecognisable page fails closed once the load times out", async () => {
    const { c, rec, timers } = setup("changed-everything.html", policy());
    await flush();
    expect(c.shieldState).toBe("loading");
    timers.advance(60_000);
    expect(c.shieldState).toBe("unavailable");
    expect(rec.selectors.at(-1)).toEqual({ ok: false, failing: ["qrCode", "chatList"] });
  });

  it("re-checks every 10 minutes", async () => {
    const { doc, c, rec, timers } = setup("group-open.html", policy());
    await flush();
    expect(c.shieldState).toBe("hidden");
    doc.querySelector("#side [contenteditable='true'][role='textbox']")?.remove();
    timers.advance(10 * 60 * 1000);
    expect(c.shieldState).toBe("unavailable");
    expect(rec.selectors.at(-1)).toEqual({ ok: false, failing: ["searchBox"] });
  });

  it("a deliberately broken selector (selectors.ts edited) fails closed", async () => {
    const { SELECTORS } = await import("../src/whatsapp/selectors");
    const original = SELECTORS.chatList.css;
    (SELECTORS.chatList as { css: string }).css = "#pane-side-renamed";
    try {
      const { c, rec } = setup("group-open.html", policy());
      await flush();
      expect(c.shieldState).toBe("unavailable");
      expect(rec.selectors.at(-1)?.failing).toEqual(["chatList"]);
    } finally {
      (SELECTORS.chatList as { css: string }).css = original;
    }
  });

  it("CSS hides the chat list, search, archive and any conversation not yet allowed, scoped to client mode", () => {
    const css = clientModeCss();
    for (const s of ["#side", '[aria-label="Archived" i]', `:is(#main):not([${ALLOWED_MARK}])`, `html[${CLIENT_MODE_ATTR}]:not([${OPENING_ATTR}])`]) {
      expect(css).toContain(s);
    }
  });
});
