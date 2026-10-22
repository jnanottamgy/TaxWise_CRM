/**
 * Opening a client's group in WhatsApp Web without reloading the page (§7.25.5 step 2): focus the
 * search box, insert the group name with document.execCommand('insertText') so WhatsApp's editor
 * registers it, wait for results, and click the result whose title matches exactly.
 *
 * Step 3 (the invite-code fallback) runs in the main process, because the invite code never
 * reaches any page but WhatsApp's own accept URL.
 */

import { normalizeTitle } from "../shared/chat-rules";
import { INVITE_CODE } from "../main/contract";
import { WHATSAPP_ORIGIN } from "../shared/config";
import { q, qa, readConversationTitle, SelectorError } from "./page";
import { SELECTORS } from "./selectors";

export type OpenOutcome = { ok: true } | { ok: false; reason: "no-search-box" | "not-found" | "not-opened" | "selectors" };

export interface OpenChatDeps {
  doc: Document;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Inserts text into the focused editor. Default: document.execCommand('insertText'). */
  insertText?(doc: Document, text: string): boolean;
  resultTimeoutMs?: number;
  openTimeoutMs?: number;
  pollMs?: number;
}

/** A result row's chat name: the first title span in the row (the name comes before any preview). */
export function resultTitle(row: Element): string | null {
  const el = row.querySelector(SELECTORS.resultTitle.css);
  const t = el?.getAttribute("title") ?? null;
  return t && t.trim() ? t : null;
}

/** The first row whose title equals the group name exactly (after Unicode/whitespace normalisation). */
export function findExactResult(rows: readonly Element[], groupName: string): Element | null {
  const want = normalizeTitle(groupName);
  return rows.find((r) => {
    const t = resultTitle(r);
    return t !== null && normalizeTitle(t) === want;
  }) ?? null;
}

function defaultInsertText(doc: Document, text: string): boolean {
  // Deprecated but still the only way to type into WhatsApp's editor so that its own handlers run.
  return doc.execCommand("insertText", false, text);
}

function selectAllIn(doc: Document, el: Element): void {
  const sel = doc.getSelection();
  if (!sel) return;
  const range = doc.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
}

export function focusAndReplace(doc: Document, box: HTMLElement, text: string, insertText: (doc: Document, text: string) => boolean): boolean {
  box.focus();
  selectAllIn(doc, box);
  return insertText(doc, text);
}

/** Mouse events in the order a real click sends them; WhatsApp listens on mousedown for rows. */
export function clickLikeAUser(el: Element): void {
  const view = el.ownerDocument.defaultView;
  const opts = { bubbles: true, cancelable: true, composed: true, button: 0, view };
  const Pointer = view && "PointerEvent" in view ? (view as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent : null;
  const Mouse = (view as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
  if (Pointer) el.dispatchEvent(new Pointer("pointerdown", { ...opts, pointerType: "mouse", isPrimary: true }));
  el.dispatchEvent(new Mouse("mousedown", opts));
  if (Pointer) el.dispatchEvent(new Pointer("pointerup", { ...opts, pointerType: "mouse", isPrimary: true }));
  el.dispatchEvent(new Mouse("mouseup", opts));
  el.dispatchEvent(new Mouse("click", opts));
}

function openTitle(doc: Document): string | null {
  try {
    return readConversationTitle(doc);
  } catch {
    return null;
  }
}

export async function openChatBySearch(groupName: string, deps: OpenChatDeps): Promise<OpenOutcome> {
  const { doc } = deps;
  const insert = deps.insertText ?? defaultInsertText;
  const poll = deps.pollMs ?? 150;
  const want = normalizeTitle(groupName);

  const current = openTitle(doc);
  if (current !== null && normalizeTitle(current) === want) return { ok: true };

  const box = q(doc, "searchBox") as HTMLElement | null;
  if (!box) return { ok: false, reason: "no-search-box" };
  focusAndReplace(doc, box, groupName, insert);

  let row: Element | null = null;
  const resultDeadline = deps.now() + (deps.resultTimeoutMs ?? 6000);
  while (deps.now() <= resultDeadline) {
    row = findExactResult(qa(doc, "searchResult"), groupName);
    if (row) break;
    await deps.sleep(poll);
  }
  if (!row) {
    focusAndReplace(doc, box, "", (d) => d.execCommand?.("delete") ?? false);
    return { ok: false, reason: "not-found" };
  }

  const target = (row.querySelector('[tabindex], [role="button"]') as Element | null) ?? row;
  clickLikeAUser(target);

  const openDeadline = deps.now() + (deps.openTimeoutMs ?? 5000);
  while (deps.now() <= openDeadline) {
    let t: string | null;
    try {
      t = readConversationTitle(doc);
    } catch (err) {
      if (err instanceof SelectorError) return { ok: false, reason: "selectors" };
      throw err;
    }
    if (t !== null && normalizeTitle(t) === want) return { ok: true };
    await deps.sleep(poll);
  }
  // The row was there and clicked, but no conversation with that title opened.
  return { ok: false, reason: q(doc, "conversation") ? "not-opened" : "selectors" };
}

/** Step 3: https://web.whatsapp.com/accept?code=<invite code>, or null for a code that isn't one. */
export function inviteFallbackUrl(code: string | null | undefined): string | null {
  if (!code || !INVITE_CODE.test(code)) return null;
  return `${WHATSAPP_ORIGIN}/accept?code=${encodeURIComponent(code)}`;
}
