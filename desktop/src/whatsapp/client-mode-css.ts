/**
 * Client mode's page rules (§7.25.5: the chat list, search and archive are hidden; a conversation
 * is hidden until it has been checked). Scoped by attributes the WhatsApp preload sets on <html>,
 * so the same static CSS can be injected twice: by the main process (webContents.insertCSS at user
 * origin, which WhatsApp's CSP and stylesheets can't block or override) and by the preload itself
 * (a constructed stylesheet) in case the first arrives late. Pure: no DOM access.
 */

import { ALLOWED_MARK, HIDDEN_IN_CLIENT_MODE, SELECTORS } from "./selectors";

/** On <html> while client mode is on. */
export const CLIENT_MODE_ATTR = "data-taxwise-client-mode";
/** On <html> while a chat is being opened (the search box must stay focusable; the cover hides it). */
export const OPENING_ATTR = "data-taxwise-opening";

export function clientModeCss(): string {
  const hidden = HIDDEN_IN_CLIENT_MODE.map((n) => SELECTORS[n].css).join(", ");
  return [
    `html[${CLIENT_MODE_ATTR}]:not([${OPENING_ATTR}]) :is(${hidden}) { display: none !important; }`,
    `html[${CLIENT_MODE_ATTR}] :is(${SELECTORS.conversation.css}):not([${ALLOWED_MARK}]) { visibility: hidden !important; }`,
  ].join("\n");
}
