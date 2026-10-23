"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useWatch } from "react-hook-form"
import { toast } from "sonner"
import { RotateCwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { FormAlert } from "@/components/app/form/form-alert"
import { TextField } from "@/components/app/form/fields"
import { UnsavedChangesGuard } from "@/components/app/unsaved-changes"
import { useActionForm } from "@/hooks/use-action-form"
import { formatSender } from "@/server/email/policy"
import { saveSenderSettings } from "@/server/actions/email-settings"
import { SenderSchema, type SenderInput } from "@/components/settings/email/schemas"
import { SettingPreview } from "@/components/settings/settings-card"

/**
 * Settings → Email → Sender (§7.21 "from-name/address, reply-to"; §1 default
 * `TaxWise Consultants <noreply@twchartered.com>`, reply-to info@twchartered.com). Beside the
 * fields, how the email arrives in a client's inbox. One Save for the panel.
 */
export function SenderForm({
  fromName,
  fromAddress,
  replyTo,
  sendingDomain,
  firmName,
}: {
  fromName: string
  fromAddress: string
  replyTo: string
  sendingDomain: string
  firmName: string
}) {
  const router = useRouter()
  const [conflict, setConflict] = React.useState(false)
  const defaults: SenderInput = {
    email_from_name: fromName,
    email_from_address: fromAddress,
    email_reply_to: replyTo,
    was_from_name: fromName,
    was_from_address: fromAddress,
    was_reply_to: replyTo,
  }
  const action = React.useCallback(async (input: SenderInput) => {
    const r = await saveSenderSettings(input)
    setConflict(!r.ok && r.code === "conflict")
    return r
  }, [])
  const f = useActionForm(SenderSchema, action, {
    defaultValues: defaults,
    resetOnSuccess: false,
    onSuccess: (data, values) => {
      // The saved values are now what the next save compares against.
      f.form.reset({
        ...values,
        email_from_address: values.email_from_address.trim().toLowerCase(),
        email_reply_to: values.email_reply_to.trim().toLowerCase(),
        was_from_name: values.email_from_name.trim(),
        was_from_address: values.email_from_address.trim().toLowerCase(),
        was_reply_to: values.email_reply_to.trim().toLowerCase(),
      })
      if (data.changed === 0) toast.info("Nothing had changed, so nothing was saved.")
      else toast.success("Sender saved")
      router.refresh()
    },
  })
  const v = useWatch({ control: f.control }) as Partial<SenderInput>
  const dirty = f.form.formState.isDirty
  const previewFrom = formatSender(v.email_from_name?.trim() || fromName, v.email_from_address?.trim() || fromAddress)

  return (
    <form noValidate onSubmit={f.onSubmit} className="flex min-w-0 flex-col gap-4">
      <UnsavedChangesGuard when={dirty && !f.pending} />
      {f.formError ? (
        <div>
          <FormAlert state={f} className="mb-0" />
          {conflict ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => {
                f.form.reset()
                f.clearFormError()
                setConflict(false)
                router.refresh()
              }}
            >
              <RotateCwIcon aria-hidden="true" />
              Reload to see their changes
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2">
        <TextField control={f.control} name="email_from_name" label="From name" required helper="What clients see as the sender." autoComplete="organization" />
        <TextField
          control={f.control}
          name="email_from_address"
          label="From address"
          required
          inputMode="email"
          autoComplete="off"
          spellCheck={false}
          helper={`Must end in @${sendingDomain}. Nobody reads it, so clients' replies go to the reply-to address.`}
        />
        <TextField
          control={f.control}
          name="email_reply_to"
          label="Reply-to address"
          required
          inputMode="email"
          autoComplete="email"
          spellCheck={false}
          helper="A mailbox the office reads. Replies to every automatic email land here."
        />
        <SettingPreview label="In the client's inbox" wide={false}>
          <p className="truncate font-medium text-text">{previewFrom}</p>
          <p className="truncate text-text">{firmName} | Invoice TW/26-27/0042 for September fees</p>
          <p className="truncate text-sm text-text-muted">Replies go to {v.email_reply_to?.trim() || replyTo}</p>
        </SettingPreview>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
        {dirty ? (
          <span className="mr-auto text-sm font-medium text-warning-text" aria-live="polite">
            Unsaved changes
          </span>
        ) : null}
        {dirty ? (
          <Button type="button" variant="outline" disabled={f.pending} onClick={() => f.form.reset()}>
            Discard
          </Button>
        ) : null}
        <Button type="submit" disabled={f.pending || !dirty} aria-busy={f.pending}>
          {f.pending ? <Spinner /> : null}
          Save sender
        </Button>
      </div>
    </form>
  )
}
