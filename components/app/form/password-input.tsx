"use client"

import * as React from "react"
import { CheckIcon, EyeIcon, EyeOffIcon, MinusIcon } from "lucide-react"
import { cn } from "@/lib/utils"

type InputProps = Omit<React.ComponentProps<"input">, "type">

/**
 * Password input with show/hide (§3.5). `checklist` is an optional slot under the field for the live
 * policy checklist (<PasswordChecklist />); the policy itself belongs to the auth feature.
 *
 *   <PasswordInput value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password"
 *     checklist={<PasswordChecklist items={[{ label: "At least 12 characters", met: pw.length >= 12 }]} />} />
 */
export function PasswordInput({
  className,
  checklist,
  ...props
}: InputProps & { checklist?: React.ReactNode }) {
  const [visible, setVisible] = React.useState(false)
  return (
    <div className="flex flex-col gap-2">
      <div className={cn("relative w-full", className)}>
        <input
          {...props}
          type={visible ? "text" : "password"}
          spellCheck={false}
          autoCapitalize="none"
          className="h-9 w-full min-w-0 rounded-md border border-text-muted/30 bg-surface pr-11 pl-3 text-base text-text transition-[border-color,box-shadow] duration-150 outline-none placeholder:text-text-muted focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-text-muted aria-invalid:border-danger aria-invalid:ring-danger/20 max-md:text-md pointer-coarse:h-11"
        />
        <button
          type="button"
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
          onClick={() => setVisible((v) => !v)}
          className="absolute top-1/2 right-1 inline-flex size-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:size-10"
        >
          {visible ? <EyeOffIcon className="size-4" aria-hidden="true" /> : <EyeIcon className="size-4" aria-hidden="true" />}
        </button>
      </div>
      {checklist}
    </div>
  )
}

/**
 * A live password-policy checklist (§4.4, §7.1). Each item is met or not; announced politely.
 *
 *   <PasswordChecklist items={[{ label: "At least 12 characters", met: pw.length >= 12 }, …]} />
 */
export function PasswordChecklist({ items, className }: { items: Array<{ label: string; met: boolean }>; className?: string }) {
  return (
    <ul aria-live="polite" className={cn("flex flex-col gap-1 text-sm", className)}>
      {items.map((it) => (
        <li key={it.label} className={cn("flex items-center gap-2", it.met ? "text-success-text" : "text-text-muted")}>
          {it.met ? <CheckIcon aria-hidden="true" className="size-3.5" /> : <MinusIcon aria-hidden="true" className="size-3.5" />}
          <span>
            {it.label}
            <span className="sr-only">{it.met ? " (done)" : " (not yet)"}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}
