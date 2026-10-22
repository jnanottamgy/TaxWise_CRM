/**
 * Reading WhatsApp Web's page state through selectors.ts only. Reads titles and structure, never
 * message content.
 */

import type { WhatsAppPageState } from "../shared/types";
import { SELECTORS, UNSUPPORTED_BROWSER_TEXT, type SelectorName } from "./selectors";

export function q(root: ParentNode, name: SelectorName): Element | null {
  return root.querySelector(SELECTORS[name].css);
}

export function qa(root: ParentNode, name: SelectorName): Element[] {
  return Array.from(root.querySelectorAll(SELECTORS[name].css));
}

export function detectPageState(doc: Document): WhatsAppPageState {
  if (q(doc, "chatList") || q(doc, "sidePane")) return "chats";
  if (q(doc, "qrCode")) return "qr";
  const text = doc.body?.textContent ?? "";
  if (text.length < 20000 && UNSUPPORTED_BROWSER_TEXT.test(text)) return "unsupported";
  return "loading";
}

/** The open conversation's title, or null if no conversation is open. Throws if a chat is open but its title can't be read. */
export function readConversationTitle(doc: Document): string | null {
  const pane = q(doc, "conversation");
  if (!pane) return null;
  const el = q(doc, "conversationTitle");
  if (!el) throw new SelectorError(["conversationTitle"]);
  const title = (el.getAttribute("title") || el.textContent || "").trim();
  if (!title) throw new SelectorError(["conversationTitle"]);
  return title;
}

export class SelectorError extends Error {
  constructor(readonly failing: string[]) {
    super(`WhatsApp selectors failed: ${failing.join(", ")}`);
    this.name = "SelectorError";
  }
}

export interface SelectorCheck {
  ok: boolean;
  failing: SelectorName[];
  state: WhatsAppPageState;
}

/**
 * The self-check (§7.25.5): every checked selector that applies to the current page state must
 * match. `loadingTooLong` turns a page that never became the QR screen or the chat list into a
 * failure (WhatsApp changed both).
 */
export function checkSelectors(doc: Document, loadingTooLong: boolean): SelectorCheck {
  const state = detectPageState(doc);
  const failing: SelectorName[] = [];
  if (!q(doc, "app")) failing.push("app");
  if (state === "loading" && loadingTooLong) failing.push("qrCode", "chatList");
  if (state === "chats") {
    for (const name of ["sidePane", "chatList", "searchBox"] as const) if (!q(doc, name)) failing.push(name);
    if (q(doc, "conversation") && !q(doc, "conversationTitle")) failing.push("conversationTitle");
  }
  return { ok: failing.length === 0, failing, state };
}
