"use client"

import * as React from "react"
import { XIcon } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Free-text tags (document tags, lead labels). Enter, comma or Tab adds the typed tag; Backspace in
 * an empty box removes the last one; each tag has its own remove button.
 *
 *   <TagInput value={tags} onChange={setTags} id="tags" placeholder="Add a tag" suggestions={["GST", "Bank"]} />
 */
export function TagInput({
  value,
  onChange,
  id,
  placeholder = "Add a tag",
  suggestions,
  maxTags = 20,
  maxLength = 40,
  disabled,
  className,
  ref,
  ...aria
}: {
  value: string[]
  onChange: (tags: string[]) => void
  id?: string
  ref?: React.Ref<HTMLInputElement>
  placeholder?: string
  suggestions?: string[]
  maxTags?: number
  maxLength?: number
  disabled?: boolean
  className?: string
  "aria-describedby"?: string
  "aria-invalid"?: boolean
  "aria-required"?: boolean
  "aria-label"?: string
}) {
  const [draft, setDraft] = React.useState("")
  const inputRef = React.useRef<HTMLInputElement>(null)
  const listId = React.useId()

  const add = (raw: string) => {
    const t = raw.trim().replace(/\s+/g, " ").slice(0, maxLength)
    if (!t) return
    if (value.some((v) => v.toLowerCase() === t.toLowerCase())) {
      setDraft("")
      return
    }
    if (value.length >= maxTags) return
    onChange([...value, t])
    setDraft("")
  }

  return (
    <div
      onClick={() => inputRef.current?.focus()}
      className={cn(
        "flex min-h-9 w-full cursor-text flex-wrap items-center gap-1.5 rounded-md border border-text-muted/30 bg-surface px-2 py-1 transition-[border-color,box-shadow] duration-150 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20 has-[[aria-invalid=true]]:border-danger pointer-coarse:min-h-11",
        disabled && "cursor-not-allowed bg-surface-2",
        className
      )}
    >
      {value.map((t) => (
        <span key={t} className="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-surface-2 pr-1 pl-2 text-sm text-text">
          {t}
          <button
            type="button"
            disabled={disabled}
            aria-label={`Remove ${t}`}
            onClick={(e) => {
              e.stopPropagation()
              onChange(value.filter((v) => v !== t))
            }}
            className="relative inline-flex size-4 cursor-pointer items-center justify-center rounded-full text-text-muted hover:bg-border hover:text-text focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:after:absolute pointer-coarse:after:-inset-3 pointer-coarse:after:content-['']"
          >
            <XIcon className="size-3" aria-hidden="true" />
          </button>
        </span>
      ))}
      <input
        ref={(el) => {
          inputRef.current = el
          if (typeof ref === "function") ref(el)
          else if (ref) ref.current = el
        }}
        id={id}
        {...aria}
        disabled={disabled}
        value={draft}
        list={suggestions?.length ? listId : undefined}
        placeholder={value.length ? "" : placeholder}
        maxLength={maxLength}
        onChange={(e) => {
          const v = e.target.value
          if (v.endsWith(",")) add(v.slice(0, -1))
          else setDraft(v)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || (e.key === "Tab" && draft.trim())) {
            if (draft.trim()) {
              e.preventDefault()
              add(draft)
            }
          } else if (e.key === "Backspace" && !draft && value.length) {
            onChange(value.slice(0, -1))
          }
        }}
        onBlur={() => add(draft)}
        className="h-7 min-w-24 flex-1 bg-transparent text-base text-text outline-none placeholder:text-text-muted max-md:text-md"
      />
      {suggestions?.length ? (
        <datalist id={listId}>
          {suggestions
            .filter((s) => !value.includes(s))
            .map((s) => (
              <option key={s} value={s} />
            ))}
        </datalist>
      ) : null}
    </div>
  )
}
