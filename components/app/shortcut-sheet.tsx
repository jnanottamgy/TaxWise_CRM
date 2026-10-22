"use client"

import * as React from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Kbd } from "@/components/ui/kbd"

export interface Shortcut {
  /** Key sequence: ["mod", "K"] (mod = ⌘ on Mac, Ctrl elsewhere), ["G", "C"] (one after the other). */
  keys: string[]
  /** "then" between keys pressed one after another; "+" for keys held together. */
  sequence?: boolean
  label: string
}

/** The keyboard shortcuts of §3.4. The shell binds them; this sheet lists them. */
export const SHORTCUT_GROUPS: Array<{ title: string; items: Shortcut[] }> = [
  {
    title: "Anywhere",
    items: [
      { keys: ["mod", "K"], label: "Search clients, tasks, invoices and commands" },
      { keys: ["N"], label: "Open the New menu" },
      { keys: ["?"], label: "Show these shortcuts" },
      { keys: ["Esc"], label: "Close a dialog, sheet or menu" },
    ],
  },
  {
    title: "Go to",
    items: [
      { keys: ["G", "C"], sequence: true, label: "Clients" },
      { keys: ["G", "T"], sequence: true, label: "Tasks" },
      { keys: ["G", "I"], sequence: true, label: "Invoices" },
    ],
  },
]

const subscribeNoop = () => () => {}
function useIsMac(): boolean {
  return React.useSyncExternalStore(
    subscribeNoop,
    () => /Mac|iPhone|iPad/i.test(navigator.userAgent),
    () => false
  )
}

/**
 * A keyboard key, or a shortcut: <Keys keys={["mod", "K"]} /> renders ⌘ K on a Mac and Ctrl K elsewhere.
 */
export function Keys({ keys, sequence = false }: { keys: string[]; sequence?: boolean }) {
  const mac = useIsMac()
  return (
    <span className="inline-flex items-center gap-1">
      {keys.map((k, i) => (
        <React.Fragment key={`${k}-${i}`}>
          {i > 0 && sequence ? <span className="text-xs text-text-muted">then</span> : null}
          <Kbd>{k === "mod" ? (mac ? "⌘" : "Ctrl") : k}</Kbd>
        </React.Fragment>
      ))}
    </span>
  )
}

/**
 * The shortcut sheet (§3.4: `?` shows it). Controlled; the shell opens it on `?` and from the user
 * menu's "Keyboard shortcuts".
 *
 *   <ShortcutSheet open={open} onOpenChange={setOpen} />
 */
export function ShortcutSheet({
  open,
  onOpenChange,
  groups = SHORTCUT_GROUPS,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  groups?: Array<{ title: string; items: Shortcut[] }>
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(92dvh,40rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Shortcuts work anywhere except while you are typing in a field.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-5">
          {groups.map((g) => (
            <section key={g.title}>
              <h3 className="mb-1 text-sm font-medium text-text-muted">{g.title}</h3>
              <ul>
                {g.items.map((s) => (
                  <li key={s.label} className="flex min-h-10 items-center justify-between gap-4 border-b border-border/70 last:border-b-0">
                    <span className="text-base text-text">{s.label}</span>
                    <Keys keys={s.keys} sequence={s.sequence} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
