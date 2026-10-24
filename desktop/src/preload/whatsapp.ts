/**
 * Preload for each WhatsApp panel (sandboxed, context-isolated). Exposes nothing to WhatsApp's
 * page. It only:
 * - reports the page state (QR screen / chat list) so the app can record a link;
 * - runs the search-and-open step when the CRM asks to open a client's chat;
 * - runs client mode for Employees (cover, title check, selector self-check).
 * It never reads, copies or stores message content, never sends, and never scrapes.
 */

import { ipcRenderer } from "electron";
import { ARG, PUSH, readArg, type SendChannel, type SendPayload } from "../shared/channels";
import type { WhatsAppConfig } from "../shared/types";
import { preloadMayRun } from "../shared/url";
import { ClientModeController, DISABLED_POLICY } from "../whatsapp/client-mode";
import { openChatBySearch } from "../whatsapp/open-chat";
import { detectPageState, readConversationTitle } from "../whatsapp/page";

function send<C extends SendChannel>(channel: C, payload: SendPayload<C>): void {
  ipcRenderer.send(channel, payload);
}

/**
 * Runs only on WhatsApp Web itself (preloadMayRun), never in the view's initial empty document. In
 * client mode, a page the preload never marks stays blank under the main process's guard stylesheet.
 */
function start(): void {
  const startsInClientMode = readArg(process.argv, ARG.clientMode) === "1";

  const controller = new ClientModeController({
    doc: document,
    selectorCheckMs: 10 * 60 * 1000,
    timers: {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    },
    bridge: {
      pageState: (state) => send("wa:page-state", { state, userAgent: navigator.userAgent }),
      openTitle: (title, decision) => send("wa:open-title", { title, decision }),
      adopt: (title) => send("wa:adopt-chat", { title }),
      accessDenied: (title) => send("wa:access-denied", { title }),
      selectors: (ok, failing) => send("wa:selectors", { ok, failing }),
      resetPage: () => send("wa:reset", undefined),
    },
  });

  // Until the main process sends the policy, an Employee's panel is covered (fail closed).
  controller.start(startsInClientMode ? "pending" : DISABLED_POLICY);

  let config: WhatsAppConfig | null = null;

  function applyConfig(next: WhatsAppConfig | null): void {
    config = next;
    // No config (the app didn't answer): an Employee's panel stays covered.
    if (next) controller.setPolicy(next.policy);
  }

  void ipcRenderer.invoke("wa:hello").then(
    (c: WhatsAppConfig | null) => applyConfig(c),
    () => applyConfig(null),
  );

  ipcRenderer.on(PUSH.waConfig, (_e, c: WhatsAppConfig) => applyConfig(c));

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  async function waitForChats(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (detectPageState(document) === "chats") return true;
      await sleep(250);
    }
    return false;
  }

  ipcRenderer.on(PUSH.waOpenChat, (_e, msg: { requestId: string; groupName: string }) => {
    void (async () => {
      const { requestId, groupName } = msg;
      if (!(await waitForChats(30_000))) {
        send("wa:open-chat-result", { requestId, ok: false, reason: detectPageState(document) === "qr" ? "not-linked" : "not-ready" });
        return;
      }
      controller.beginOpening(groupName);
      try {
        const outcome = await openChatBySearch(groupName, { doc: document, sleep, now: () => Date.now() });
        if (!outcome.ok && outcome.reason === "selectors" && config?.policy.enabled) controller.reportBroken(["conversation"]);
        send("wa:open-chat-result", { requestId, ok: outcome.ok, reason: outcome.ok ? null : outcome.reason });
      } catch {
        send("wa:open-chat-result", { requestId, ok: false, reason: "error" });
      } finally {
        controller.endOpening();
      }
    })();
  });

  ipcRenderer.on(PUSH.waQueryTitle, (_e, msg: { requestId: string }) => {
    let title: string | null = null;
    try {
      title = readConversationTitle(document);
    } catch {
      title = null;
    }
    send("wa:title-result", { requestId: msg.requestId, title });
  });
}

if (preloadMayRun(location.href)) start();
