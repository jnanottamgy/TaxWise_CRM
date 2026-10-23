"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { SendIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Explain } from "@/components/app/explain"
import { sendTestEmail } from "@/server/actions/email-settings"

type Outcome = { tone: "success" | "warning" | "danger"; text: string }

/**
 * Settings → Email → Send test email (§7.13.5 "Send test email (to yourself)"). Available once the
 * domain is verified; until then the button says why it can't be used. The result stays on the
 * card, and the email appears in the delivery log below.
 */
export function TestEmailCard({ to, ready, notReadyReason }: { to: string; ready: boolean; notReadyReason: string | null }) {
  const router = useRouter()
  const [pending, setPending] = React.useState(false)
  const [outcome, setOutcome] = React.useState<Outcome | null>(null)

  const send = async () => {
    setPending(true)
    setOutcome(null)
    try {
      const r = await sendTestEmail({})
      if (!r.ok) {
        setOutcome({ tone: "danger", text: r.ref ? `${r.error} (Ref ${r.ref})` : r.error })
        return
      }
      if (r.data.status === "sent") {
        setOutcome({ tone: "success", text: `Sent to ${r.data.to}. Check your inbox (and spam); the delivery log below shows Delivered once your mail server accepts it.` })
        toast.success("Test email sent")
      } else if (r.data.status === "not_configured") {
        setOutcome({ tone: "warning", text: r.data.error ?? "Email isn't set up yet." })
      } else {
        setOutcome({ tone: "danger", text: r.data.error ?? "The test email wasn't sent." })
      }
      router.refresh()
    } catch {
      setOutcome({ tone: "danger", text: "We couldn't reach the server. Check your connection and try again." })
    } finally {
      setPending(false)
    }
  }

  const tone = outcome?.tone
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-base text-text">
          Sends a short email to you at <span className="font-medium break-all">{to}</span>, from the sender above.
        </p>
        {ready ? (
          <Button type="button" variant="outline" onClick={send} disabled={pending} aria-busy={pending} className="self-start sm:self-auto">
            {pending ? <Spinner /> : <SendIcon aria-hidden="true" />}
            Send test email
          </Button>
        ) : (
          <Explain content={<p>{notReadyReason ?? "Email isn't set up yet."}</p>}>
            <Button type="button" variant="outline" aria-disabled="true" className="self-start sm:self-auto">
              <SendIcon aria-hidden="true" />
              Send test email
              <span className="sr-only">: unavailable. {notReadyReason}</span>
            </Button>
          </Explain>
        )}
      </div>
      {!ready ? <p className="text-sm text-text-muted">{notReadyReason}</p> : null}
      <div role="status" aria-live="polite">
        {outcome ? (
          <p
            className={
              tone === "success"
                ? "rounded-md border border-success/25 bg-success-soft px-3 py-2 text-base text-text"
                : tone === "warning"
                  ? "rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-base text-text"
                  : "rounded-md border border-danger/25 bg-danger-soft px-3 py-2 text-base text-text"
            }
          >
            {outcome.text}
          </p>
        ) : null}
      </div>
    </div>
  )
}
