import type { QueueStep } from "@/lib/schemas/inbox"

/**
 * The bulk WhatsApp queue's state (§7.13.2: "The user steps through them ('Open WhatsApp → mark
 * handed off → next'), each logged. Nothing is sent without a person pressing Send."). Pure and
 * client-safe; the dialog drives it and unit tests pin it down.
 *
 *   pending ──open──▶ opened ──log──▶ logging ──ok──▶ handed_off (moves on)
 *      │                │                  └─fail─▶ failed (stays; retry or skip)
 *      └──────skip──────┴──────────────────────────▶ skipped (moves on)
 *
 * A step with no WhatsApp number can only be skipped. Moving on goes to the next step that still
 * needs doing; when none is left the queue is done.
 */

export type StepStatus = "pending" | "opened" | "logging" | "handed_off" | "skipped" | "failed"

export type QueueItem = { step: QueueStep; draft: string; status: StepStatus; error: string | null }

export type QueueState = { items: QueueItem[]; index: number }

export type QueueAction =
  | { type: "edit"; draft: string }
  | { type: "opened" }
  | { type: "logging" }
  | { type: "logged" }
  | { type: "log_failed"; error: string }
  | { type: "skip" }
  | { type: "back" }
  | { type: "goto"; index: number }
  | { type: "reset"; steps: readonly QueueStep[] }

const OPEN: ReadonlySet<StepStatus> = new Set(["pending", "opened", "failed"])

export function initQueue(steps: readonly QueueStep[]): QueueState {
  return { items: steps.map((step) => ({ step, draft: step.draft, status: "pending", error: null })), index: 0 }
}

/** The next step after `from` that still needs doing, or items.length when none is left. */
export function nextOpenIndex(items: readonly QueueItem[], from: number): number {
  for (let i = from + 1; i < items.length; i++) if (OPEN.has(items[i].status)) return i
  for (let i = 0; i <= Math.min(from, items.length - 1); i++) if (OPEN.has(items[i].status)) return i
  return items.length
}

function patch(state: QueueState, change: Partial<QueueItem>): QueueItem[] {
  return state.items.map((it, i) => (i === state.index ? { ...it, ...change } : it))
}

export function isQueueDone(state: QueueState): boolean {
  return state.index >= state.items.length
}

export function currentItem(state: QueueState): QueueItem | null {
  return state.items[state.index] ?? null
}

export function queueReducer(state: QueueState, action: QueueAction): QueueState {
  if (action.type === "reset") return initQueue(action.steps)
  if (action.type === "goto") {
    if (action.index < 0 || action.index >= state.items.length) return state
    return { ...state, index: action.index }
  }
  const item = currentItem(state)
  if (!item) return state
  switch (action.type) {
    case "edit":
      if (item.status === "handed_off" || item.status === "logging") return state
      return { ...state, items: patch(state, { draft: action.draft }) }
    case "opened":
      if (!item.step.number || item.status === "handed_off" || item.status === "logging") return state
      return { ...state, items: patch(state, { status: "opened", error: null }) }
    case "logging":
      if (item.status !== "opened" && item.status !== "failed") return state
      return { ...state, items: patch(state, { status: "logging", error: null }) }
    case "logged": {
      if (item.status !== "logging") return state
      const items = patch(state, { status: "handed_off", error: null })
      return { items, index: nextOpenIndex(items, state.index) }
    }
    case "log_failed":
      if (item.status !== "logging") return state
      return { ...state, items: patch(state, { status: "failed", error: action.error }) }
    case "skip": {
      if (item.status === "handed_off" || item.status === "logging") return { ...state, index: nextOpenIndex(state.items, state.index) }
      const items = patch(state, { status: "skipped", error: null })
      return { items, index: nextOpenIndex(items, state.index) }
    }
    case "back":
      return { ...state, index: Math.max(0, state.index - 1) }
  }
}

export type QueueTally = { total: number; handedOff: number; skipped: number; failed: number; remaining: number; opened: number }

export function queueTally(state: QueueState): QueueTally {
  const t: QueueTally = { total: state.items.length, handedOff: 0, skipped: 0, failed: 0, remaining: 0, opened: 0 }
  for (const it of state.items) {
    if (it.status === "handed_off") t.handedOff++
    else if (it.status === "skipped") t.skipped++
    else if (it.status === "failed") t.failed++
    if (it.status === "opened") t.opened++
    if (OPEN.has(it.status) || it.status === "logging") t.remaining++
  }
  return t
}

/** "3 of 12 · 2 handed off · 1 skipped". */
export function queueProgressLabel(state: QueueState): string {
  const t = queueTally(state)
  const position = isQueueDone(state) ? `${t.total} of ${t.total}` : `${state.index + 1} of ${t.total}`
  return [position, t.handedOff ? `${t.handedOff} handed off` : null, t.skipped ? `${t.skipped} skipped` : null, t.failed ? `${t.failed} not logged` : null].filter(Boolean).join(" · ")
}
