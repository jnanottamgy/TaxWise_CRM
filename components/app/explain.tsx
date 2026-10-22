"use client"

import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"

/**
 * An explanation that opens on hover (mouse), on keyboard focus, AND on tap (§3.4: "Hovering (or
 * tapping) a chip explains what the status means"). A plain Tooltip never opens on touch, so this is
 * a small non-modal popover. Clicks on the trigger don't bubble, so it is safe inside clickable rows.
 *
 *   <Explain content="Data awaited: blocked on the client.">
 *     <button type="button">Data awaited</button>
 *   </Explain>
 *
 * The child must be a single focusable element that accepts a ref (a <button>).
 */
export function Explain({
  content,
  children,
  side = "top",
  align = "center",
  className,
}: {
  content: React.ReactNode
  children: React.ReactElement
  side?: "top" | "right" | "bottom" | "left"
  align?: "start" | "center" | "end"
  className?: string
}) {
  const [open, setOpen] = React.useState(false)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const openedByHover = React.useRef(false)

  const clear = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  const openSoon = (byHover: boolean) => {
    clear()
    timer.current = setTimeout(() => {
      openedByHover.current = byHover
      setOpen(true)
    }, 120)
  }
  const closeSoon = () => {
    clear()
    timer.current = setTimeout(() => setOpen(false), 150)
  }

  React.useEffect(() => clear, [])

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        clear()
        openedByHover.current = false
        setOpen(next)
      }}
    >
      <PopoverPrimitive.Trigger
        asChild
        onPointerEnter={(e) => {
          if (e.pointerType === "mouse") openSoon(true)
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === "mouse" && openedByHover.current) closeSoon()
        }}
        onFocus={(e) => {
          if (e.currentTarget.matches(":focus-visible")) openSoon(true)
        }}
        onBlur={() => {
          if (openedByHover.current) closeSoon()
        }}
        onClick={(e) => {
          e.stopPropagation()
          // A click on a chip the mouse already opened pins it open instead of toggling it shut.
          if (open && openedByHover.current) {
            e.preventDefault()
            openedByHover.current = false
          }
        }}
      >
        {children}
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={12}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onPointerEnter={(e) => {
            if (e.pointerType === "mouse") clear()
          }}
          onPointerLeave={(e) => {
            if (e.pointerType === "mouse" && openedByHover.current) closeSoon()
          }}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "z-50 max-w-72 rounded-lg border bg-popover px-3 py-2 text-sm leading-5 text-text shadow-2 outline-none transition-opacity duration-150 ease-out starting:opacity-0",
            className
          )}
        >
          {content}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}
