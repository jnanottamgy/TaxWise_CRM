/**
 * Hand-offs in client mode (§7.25.5, §7.13.2): a wa.me link clicked in the CRM opens that one-to-one
 * chat in the panel, and that chat, and only that chat, is then allowed for the session. Pure.
 *
 * The main process decides, not the page: the WhatsApp preload proposes the chat it adopted, and
 * the main process accepts it only while the hand-off it started is still pending, on the same
 * number, from the page the hand-off loaded, and the title passes the client-mode rule. A
 * hand-off is single-use and is cancelled the moment the user types anything into WhatsApp
 * before its chat opens. Otherwise a hand-off to a
 * number that isn't on WhatsApp (no chat opens) would leave the window open for the next chat
 * the user reached with WhatsApp's own keyboard shortcuts (next chat, search, new chat), and
 * that chat, perhaps another client's group, would be adopted for the whole session.
 */

import { decideChat } from "../shared/chat-rules";
import type { ClientModePolicy } from "../shared/types";

export interface PendingHandoff {
  /** The firm number whose WhatsApp view the hand-off was opened in. */
  numberId: string;
  phoneDigits: string;
  armedAt: number;
  expiresAt: number;
  /**
   * The hand-off's view has committed a new page since the hand-off started. Until then the old
   * page (perhaps an allowed group, fully interactive) is still showing, and a chat opened from
   * it (a group member's name, a forwarded contact) must not be taken for the hand-off's chat.
   */
  committed: boolean;
}

/** Accept the chat a WhatsApp view says it adopted? */
export function acceptAdoption(
  pending: PendingHandoff | null,
  senderNumberId: string | null,
  title: string,
  policy: ClientModePolicy,
  now: number,
): boolean {
  if (!pending || senderNumberId === null || pending.numberId !== senderNumberId) return false;
  if (!pending.committed || now > pending.expiresAt) return false;
  if (!policy.enabled || !policy.pendingHandoff) return false;
  return decideChat(title, policy, now) === "adopt";
}

/** Keyboard input in a WhatsApp view while a hand-off is pending cancels the hand-off. */
export function inputCancelsHandoff(input: { type: string }): boolean {
  return input.type === "keyDown" || input.type === "rawKeyDown" || input.type === "char";
}
