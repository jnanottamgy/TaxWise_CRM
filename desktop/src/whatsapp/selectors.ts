/**
 * EVERY DOM selector TaxWise Desktop uses on WhatsApp Web lives in this file (§7.25.5).
 *
 * WhatsApp changes its page often. When it does, client mode fails closed for Employees ("Client
 * mode is unavailable because WhatsApp changed its page. A Partner has been told.") and the fix is
 * made here and nowhere else. Check each entry against the live page on a test number before
 * shipping a change (see README, "Fixing selectors.ts").
 *
 * `when` says in which page state a selector must match; the self-check (on load and every
 * 10 minutes) tests each one in its state. Entries marked `checked: false` only hide extra parts
 * of the page in client mode: client mode does not depend on them, because every conversation
 * is checked by title and anything not allowed is covered and closed.
 *
 * Never add a selector that reads message text, contacts or the chat list's contents: the app
 * reads only the open conversation's title and, while opening a chat, search-result titles.
 */

export type SelectorState = "always" | "unlinked" | "linked" | "chat-open" | "search-results";

export interface SelectorSpec {
  css: string;
  when: SelectorState;
  /** false: cosmetic (hidden in client mode if present), not part of the self-check. */
  checked: boolean;
  purpose: string;
}

export const SELECTORS = {
  app: {
    css: "#app",
    when: "always",
    checked: true,
    purpose: "WhatsApp Web's root element.",
  },
  qrCode: {
    css: 'canvas[aria-label*="scan" i], div[data-ref] canvas',
    when: "unlinked",
    checked: true,
    purpose: "The link-a-device QR code (this number isn't linked on this PC).",
  },
  sidePane: {
    css: "#side",
    when: "linked",
    checked: true,
    purpose: "Left column: search box, archive and chat list. Hidden in client mode.",
  },
  chatList: {
    css: "#pane-side",
    when: "linked",
    checked: true,
    purpose: "The chat list. Its presence means the number is linked and loaded.",
  },
  searchBox: {
    css: '#side div[contenteditable="true"][role="textbox"], #side div[contenteditable="true"][data-tab="3"]',
    when: "linked",
    checked: true,
    purpose: "Search box used to open a client's group by its exact name.",
  },
  searchResult: {
    css: '#pane-side [role="listitem"], #pane-side [role="row"]',
    when: "search-results",
    checked: true,
    purpose: "One search result row.",
  },
  resultTitle: {
    css: 'span[dir="auto"][title]',
    when: "search-results",
    checked: true,
    purpose: "Inside a result row: the chat's name (its title attribute).",
  },
  conversation: {
    css: "#main",
    when: "chat-open",
    checked: true,
    purpose: "The open conversation pane.",
  },
  conversationTitle: {
    css: '#main header span[dir="auto"]',
    when: "chat-open",
    checked: true,
    purpose: "The open conversation's name, matched exactly against the allowed groups.",
  },
  navRail: {
    css: 'header[data-tab="2"], div[data-js-navbar="true"]',
    when: "linked",
    checked: false,
    purpose: "Left navigation rail (Chats, Status, Channels, Communities). Hidden in client mode if present.",
  },
  archivedEntry: {
    css: '#side [aria-label="Archived" i]',
    when: "linked",
    checked: false,
    purpose: "The Archived entry. Inside sidePane, so already hidden; listed so the intent is explicit.",
  },
} as const satisfies Record<string, SelectorSpec>;

export type SelectorName = keyof typeof SELECTORS;

/** Shown on the page when WhatsApp refuses the browser (the user-agent fallback looks for it). */
export const UNSUPPORTED_BROWSER_TEXT = /WhatsApp works with Google Chrome/i;

/** Parts of the page hidden while client mode is on (§7.25.5: chat list, search and archive). */
export const HIDDEN_IN_CLIENT_MODE: readonly SelectorName[] = ["sidePane", "navRail", "archivedEntry"];

/** Data attribute the client-mode controller puts on the conversation pane once it is allowed. */
export const ALLOWED_MARK = "data-taxwise-allowed";
