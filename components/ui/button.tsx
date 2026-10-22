import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

/**
 * Buttons (§3.2, DESIGN.md §3): one filled `default` (primary blue) per screen region; `outline` for
 * secondary; `ghost` / `link` for tertiary. `destructive` fills with the danger token; prefer
 * `destructive-outline` for destructive actions that sit in a settings section. `whatsapp` is the
 * green hand-off button (§7.13.2). Radius 8px; visible outline focus ring; at least 44px tall on
 * touch screens.
 *
 *   <Button>Save client</Button>
 *   <Button variant="outline" size="sm"><DownloadIcon /> Export CSV</Button>
 *   <Button variant="whatsapp"><MessageCircleIcon /> WhatsApp</Button>
 */
const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color] duration-150 ease-out outline-none select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-60 aria-disabled:cursor-not-allowed aria-disabled:opacity-60 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:outline-destructive",
        "destructive-outline":
          "border border-danger/40 bg-surface text-danger-text hover:bg-danger-soft focus-visible:outline-destructive",
        outline:
          "border border-text-muted/30 bg-surface text-text hover:border-text-muted/45 hover:bg-surface-2",
        secondary: "bg-surface-2 text-text hover:bg-surface-2/70",
        ghost: "text-text hover:bg-surface-2",
        link: "h-auto px-0 text-primary underline-offset-4 hover:underline has-[>svg]:px-0",
        whatsapp: "bg-success-text text-surface hover:bg-success-text/90",
      },
      size: {
        default: "h-9 px-4 has-[>svg]:px-3 pointer-coarse:min-h-11",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5 pointer-coarse:min-h-11",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4 pointer-coarse:min-h-11",
        icon: "size-9 pointer-coarse:size-11",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8 pointer-coarse:size-11",
        "icon-lg": "size-10 pointer-coarse:size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
