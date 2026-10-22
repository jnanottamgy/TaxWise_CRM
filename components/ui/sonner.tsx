"use client"

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"

/**
 * The app's toast region (§3.4: toasts for background failures and warnings after a save).
 * Mount once, in the root or shell layout. Sonner renders an aria-live="polite" region.
 *
 *   <Toaster />
 *   toast.success("Client saved")
 *   toast.warning("Welcome email didn't go through. Send it by hand. (Ref 7KQ2M9)")
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const { resolvedTheme } = useTheme()

  return (
    <Sonner
      theme={(resolvedTheme as ToasterProps["theme"]) ?? "light"}
      className="toaster group"
      position="bottom-right"
      closeButton
      visibleToasts={4}
      icons={{
        success: <CircleCheckIcon className="size-4 text-success-text" />,
        info: <InfoIcon className="size-4 text-info-text" />,
        warning: <TriangleAlertIcon className="size-4 text-warning-text" />,
        error: <OctagonXIcon className="size-4 text-danger-text" />,
        loading: <Loader2Icon className="size-4 animate-spin text-text-muted" />,
      }}
      toastOptions={{
        classNames: {
          toast: "font-sans text-base",
          title: "font-medium text-text",
          description: "text-sm !text-text-muted",
          actionButton: "!bg-primary !text-primary-foreground !rounded-md !font-medium",
          cancelButton: "!bg-surface-2 !text-text !rounded-md",
          closeButton: "!bg-surface !border-border !text-text-muted hover:!text-text",
        },
        style: { boxShadow: "var(--elevation-2)" },
      }}
      style={
        {
          "--normal-bg": "var(--surface)",
          "--normal-text": "var(--text)",
          "--normal-border": "var(--border)",
          "--border-radius": "12px",
          "--width": "380px",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
