"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { MessageCircleIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { getDesktopBridge, useIsDesktopApp } from "@/components/shell/use-desktop"
import { useIsPhone } from "@/components/whatsapp/use-phone"
import { useCopy } from "@/hooks/use-copy"
import { WHATSAPP_APP_URL, WHATSAPP_WEB_URL, WHATSAPP_WINDOW_NAME, whatsappWindowFeatures } from "@/lib/domain/whatsapp"
import { openWhatsAppChat } from "@/server/actions/whatsapp-groups"

/**
 * Open chat (§7.25.1, §7.25.5, §7.25.8). Every path goes through the same server check
 * (record_whatsapp_open: can_open_whatsapp, the audit row and "last opened"):
 *
 * - In TaxWise Desktop: `window.taxwiseDesktop.openClientChat(clientId)`; the app calls
 *   /api/desktop/whatsapp/open and opens the client's primary group in its panel. Another group of
 *   the same client is checked here, its name copied, and the panel shown for the search.
 * - In a browser: WhatsApp Web in one reused window on the right half of the screen, and the group's
 *   name copied for its search. The window is opened inside the click (so pop-up blockers allow it)
 *   and only pointed at WhatsApp Web once the server says yes; a refusal closes it again.
 *   Employees get this button only if a Partner allows WhatsApp in a browser window.
 * - On a phone: the name is copied and the WhatsApp app opens (`whatsapp://` [verify]).
 *
 * The app's own panel is never an iframe of web.whatsapp.com: WhatsApp refuses that (§7.25.8).
 */
export function OpenChatButton({
  clientId,
  groupId,
  groupName,
  isPrimary,
  browserAllowed,
  variant = "default",
  size = "sm",
}: {
  clientId: string
  groupId: string
  groupName: string
  isPrimary: boolean
  /** Partners and Managers always; Employees when firm_settings.whatsapp_employee_browser_window. */
  browserAllowed: boolean
  variant?: "default" | "outline"
  size?: "sm" | "default"
}) {
  const router = useRouter()
  const desktop = useIsDesktopApp()
  const phone = useIsPhone()
  const { copy } = useCopy()
  const [pending, setPending] = React.useState(false)

  if (!desktop && !browserAllowed) return null

  const refused = (r: { error: string; ref?: string }) => toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)

  const openInDesktop = async () => {
    const bridge = getDesktopBridge()
    if (!bridge) return
    setPending(true)
    try {
      if (isPrimary) {
        const r = await bridge.openClientChat(clientId)
        if (!r.ok) toast.error(r.error)
      } else {
        void copy(groupName)
        const r = await openWhatsAppChat({ clientId, groupId, via: "desktop" })
        if (!r.ok) return refused(r)
        let panel = await bridge.toggleWhatsApp()
        if (!panel.visible) panel = await bridge.toggleWhatsApp()
        toast.success(`Copied "${groupName}". Paste it into the search in the WhatsApp panel.`)
      }
      router.refresh()
    } catch {
      toast.error("TaxWise Desktop didn't respond. Restart the app and try again.")
    } finally {
      setPending(false)
    }
  }

  const openInBrowser = () => {
    // Inside the click: copy, and open (or reuse) the named window, so the browser allows both.
    void copy(groupName)
    let win: Window | null = null
    try {
      const s = window.screen as Screen & { availLeft?: number; availTop?: number }
      win = window.open("", WHATSAPP_WINDOW_NAME, whatsappWindowFeatures({ availWidth: s.availWidth, availHeight: s.availHeight, availLeft: s.availLeft, availTop: s.availTop }))
    } catch {
      win = null
    }
    setPending(true)
    void (async () => {
      try {
        const r = await openWhatsAppChat({ clientId, groupId, via: "browser" })
        if (!r.ok) {
          if (win && isBlank(win)) win.close()
          return refused(r)
        }
        if (!win) {
          toast.error(`Your browser blocked the WhatsApp window. Allow pop-ups for TaxWise, or open ${WHATSAPP_WEB_URL} yourself; "${groupName}" is copied.`)
          return
        }
        if (isBlank(win)) {
          try {
            win.opener = null
          } catch {
            // Some browsers don't allow it; the window is ours either way.
          }
          win.location.replace(WHATSAPP_WEB_URL)
        }
        win.focus()
        toast.success(`Copied "${groupName}". Paste it into WhatsApp's search to open the group.`)
        router.refresh()
      } catch {
        if (win && isBlank(win)) win.close()
        toast.error("We couldn't reach the server. Check your connection and try again.")
      } finally {
        setPending(false)
      }
    })()
  }

  const openOnPhone = () => {
    void copy(groupName)
    setPending(true)
    void (async () => {
      try {
        const r = await openWhatsAppChat({ clientId, groupId, via: "phone" })
        if (!r.ok) return refused(r)
        toast.success(`Copied "${groupName}". Paste it into WhatsApp's search.`)
        router.refresh()
        window.location.href = WHATSAPP_APP_URL
      } catch {
        toast.error("We couldn't reach the server. Check your connection and try again.")
      } finally {
        setPending(false)
      }
    })()
  }

  const onClick = desktop ? openInDesktop : phone ? openOnPhone : openInBrowser
  return (
    <Button type="button" variant={variant} size={size} onClick={onClick} disabled={pending} aria-busy={pending || undefined}>
      {pending ? <Spinner /> : <MessageCircleIcon aria-hidden="true" />}
      {desktop ? "Open chat here" : "Open chat"}
    </Button>
  )
}

function isBlank(w: Window): boolean {
  try {
    return w.location.href === "about:blank"
  } catch {
    // Cross-origin: it already shows WhatsApp Web.
    return false
  }
}
