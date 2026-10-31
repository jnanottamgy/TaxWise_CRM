"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useWatch } from "react-hook-form"
import { CalendarClockIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { ComboboxField, SelectField, SwitchField, TextareaField } from "@/components/app/form/fields"
import { DateText } from "@/components/app/date-text"
import { ErrorBlock } from "@/components/app/error-block"
import { useActionForm } from "@/hooks/use-action-form"
import { CAPACITY_BAND_LABELS } from "@/lib/domain/capacity"
import { COVER_REASON_OPTIONS, GrantCoverSchema } from "@/lib/schemas/covers"
import type { AppRole } from "@/lib/auth/roles"
import type { CoverClientRow } from "@/lib/data/covers"
import { grantCover, loadCoverFormContext, loadPersonClients, type CoverFormContext } from "@/server/actions/covers"
import { DateTimeField } from "@/components/covers/date-time-field"
import { cn } from "@/lib/utils"

export type CoverTarget =
  | { kind: "client"; clientId: string; clientName: string; ownerEmployeeId: string | null; ownerName: string | null }
  | { kind: "person"; employeeId: string; name: string; leave?: { id: string; start: string; end: string } | null }

/**
 * Grant cover (§4.7 Fields): Cover person (with their capacity band, and a warning if they're on
 * leave in the window) · Covering for · Client (client cover) · From (default now) · Until, with
 * quick picks (end of today, end of tomorrow, end of this week, until their leave ends; at most 90
 * days) · Reason · Note · Handover note · Include portal passwords (Partner) · Also email the cover
 * person (default on).
 *
 * For a person (People → person → Cover their clients, the leave approval prompt, Absent today
 * without cover): one person for all their clients (a person cover, which also reaches clients
 * assigned to them during the cover), or split client by client in a table with each client's open
 * tasks and next deadline (client covers).
 */
export function CoverDialog({
  target,
  actorRole,
  open,
  onOpenChange,
  title,
  description,
  onDone,
  extraFooter,
}: {
  target: CoverTarget
  actorRole: AppRole
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: string
  description?: React.ReactNode
  onDone?: () => void
  /** Left side of the footer (the leave prompt's "No cover needed"). */
  extraFooter?: React.ReactNode
}) {
  const router = useRouter()
  // Each load is keyed by what it asked for: loading is "the key shown isn't the key wanted".
  const [context, setContext] = React.useState<{ key: string | null; data: CoverFormContext | null; error: LoadError | null }>({ key: null, data: null, error: null })
  const [contextTry, setContextTry] = React.useState(0)
  const [clients, setClients] = React.useState<{ key: string | null; rows: CoverClientRow[] | null; error: LoadError | null }>({ key: null, rows: null, error: null })
  const [clientsTry, setClientsTry] = React.useState(0)

  // Mount this dialog only while it is open (the callers do), so each opening starts from "now".
  const [nowIso] = React.useState(() => new Date(Math.ceil(Date.now() / 60_000) * 60_000).toISOString())
  const leave = target.kind === "person" ? target.leave : null
  const defaultStart = leave ? new Date(Math.max(Date.parse(`${leave.start}T00:00:00+05:30`), Date.parse(nowIso))).toISOString() : nowIso
  const defaultEnd = leave ? new Date(Date.parse(`${leave.end}T23:59:00+05:30`)).toISOString() : ""

  const f = useActionForm(GrantCoverSchema, grantCover, {
    defaultValues: {
      mode: target.kind === "client" ? "client" : "person",
      cover_employee_id: null,
      absent_employee_id: target.kind === "client" ? target.ownerEmployeeId : target.employeeId,
      client_id: target.kind === "client" ? target.clientId : null,
      splits: [],
      starts_at: defaultStart,
      ends_at: defaultEnd,
      reason: leave ? "leave" : target.kind === "person" ? "absent_today" : "leave",
      note: "",
      handover_note: "",
      include_vault: false,
      email_cover_person: true,
      leave_id: leave?.id ?? null,
    },
    resetOnSuccess: false,
    successMessage: (d) => (d.ids.length > 1 ? `${d.ids.length} covers granted.` : "Cover granted."),
    onSuccess: () => {
      onOpenChange(false)
      onDone?.()
      router.refresh()
    },
  })

  const mode = useWatch({ control: f.control, name: "mode" })
  const absentId = useWatch({ control: f.control, name: "absent_employee_id" })
  const startsAt = useWatch({ control: f.control, name: "starts_at" })
  const endsAt = useWatch({ control: f.control, name: "ends_at" })
  const splits = useWatch({ control: f.control, name: "splits" }) ?? []

  // Candidates and quick picks: on open, and when the window or the absent person changes.
  const contextKey = open ? JSON.stringify([absentId ?? null, startsAt || null, endsAt || null, contextTry]) : null
  const contextLoading = contextKey !== null && context.key !== contextKey
  React.useEffect(() => {
    if (contextKey === null) return
    let cancelled = false
    const t = setTimeout(() => {
      void loadCoverFormContext({ absent_employee_id: absentId ?? null, starts_at: startsAt || null, ends_at: endsAt || null }).then((r) => {
        if (cancelled) return
        setContext((c) => (r.ok ? { key: contextKey, data: r.data, error: null } : { key: contextKey, data: c.data, error: { message: r.error, ref: r.ref } }))
      })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [contextKey, absentId, startsAt, endsAt])

  // The split table's clients (person target only), loaded once per opening.
  const personId = target.kind === "person" ? target.employeeId : null
  const clientsKey = open && personId && mode === "split" ? `${personId}:${clientsTry}` : null
  const clientsLoading = clientsKey !== null && clients.key !== clientsKey
  React.useEffect(() => {
    if (clientsKey === null || !personId || clients.key === clientsKey) return
    let cancelled = false
    void loadPersonClients({ employee_id: personId }).then((r) => {
      if (cancelled) return
      if (!r.ok) {
        setClients({ key: clientsKey, rows: null, error: { message: r.error, ref: r.ref } })
        return
      }
      setClients({ key: clientsKey, rows: r.data, error: null })
      f.form.setValue("splits", r.data.map((c) => ({ client_id: c.id, cover_employee_id: null })), { shouldDirty: false })
    })
    return () => {
      cancelled = true
    }
  }, [clientsKey, personId, clients.key, f.form])

  const candidates = context.data?.candidates ?? []
  const options = candidates.map((c) => ({
    value: c.id,
    label: c.full_name,
    description: [`${CAPACITY_BAND_LABELS[c.band]} · ${c.arithmetic}`, c.onLeave ? `On leave ${c.onLeave}` : null].filter(Boolean).join(" · "),
  }))
  const coverId = useWatch({ control: f.control, name: "cover_employee_id" })
  const chosen = candidates.find((c) => c.id === coverId)

  const absentName = target.kind === "person" ? target.name : target.ownerName
  const heading =
    title ??
    (target.kind === "client" ? `Add cover for ${target.clientName}` : `Cover ${target.name}'s clients`)

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size={mode === "split" ? "xl" : "lg"}
      title={heading}
      description={description ?? "While the cover is in force, the cover person works on the clients as if they were on the team. They still never see fees. Access ends by itself at Until."}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel={mode === "split" ? splitLabel(splits.filter((s) => s.cover_employee_id).length) : "Grant cover"}
      footerStart={extraFooter}
    >
      <FormAlert state={f} />
      <div className="flex flex-col gap-5">
        {target.kind === "person" ? (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-sm font-medium text-text">Who covers</legend>
            <RadioGroup value={mode} onValueChange={(v) => f.form.setValue("mode", v as "person" | "split", { shouldDirty: true })} className="grid gap-2 md:grid-cols-2">
              {(
                [
                  { value: "person", label: "One person for all of them", hint: `Also reaches clients assigned to ${target.name} during the cover.` },
                  { value: "split", label: "Split client by client", hint: "Choose a cover person per client, seeing each client's open tasks and next deadline." },
                ] as const
              ).map((o) => (
                <label key={o.value} htmlFor={`cover-mode-${o.value}`} className={cn("flex cursor-pointer gap-3 rounded-md border p-3", mode === o.value ? "border-primary bg-primary-soft" : "border-border hover:bg-surface-2")}>
                  <RadioGroupItem id={`cover-mode-${o.value}`} value={o.value} className="mt-0.5" />
                  <span>
                    <span className="block text-base font-medium text-text">{o.label}</span>
                    <span className="mt-0.5 block text-sm text-text-muted">{o.hint}</span>
                  </span>
                </label>
              ))}
            </RadioGroup>
          </fieldset>
        ) : null}

        {context.error && !contextLoading ? <ErrorBlock message="Couldn't load the team's capacity." errorRef={context.error.ref} size="compact" onRetry={() => setContextTry((n) => n + 1)} /> : null}

        {mode !== "split" ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <ComboboxField
              control={f.control}
              name="cover_employee_id"
              label="Cover person"
              required
              options={options}
              placeholder={contextLoading && !context.data ? "Loading the team…" : "Choose who covers"}
              searchPlaceholder="Search the team"
              helper={chosen ? `${CAPACITY_BAND_LABELS[chosen.band]}: ${chosen.arithmetic}.${chosen.onLeave ? ` On leave ${chosen.onLeave}.` : ""}` : "Their capacity band shows beside each name."}
            />
            {target.kind === "client" ? (
              <ComboboxField
                control={f.control}
                name="absent_employee_id"
                label="Covering for"
                options={[
                  ...(target.ownerEmployeeId && target.ownerName && !candidates.some((c) => c.id === target.ownerEmployeeId) ? [{ value: target.ownerEmployeeId, label: target.ownerName, description: "Owner" }] : []),
                  ...candidates.map((c) => ({ value: c.id, label: c.full_name, description: c.id === target.ownerEmployeeId ? "Owner" : undefined })),
                ]}
                placeholder="No one in particular"
                helper="Defaults to the client's owner. Notifications that go to them also go to the cover person."
              />
            ) : (
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-text">Covering for</span>
                <span className="flex h-9 items-center text-base text-text">{absentName}</span>
              </div>
            )}
          </div>
        ) : (
          <SplitTable
            loading={clientsLoading}
            error={clients.error}
            onRetry={() => setClientsTry((n) => n + 1)}
            rows={clients.rows ?? []}
            splits={splits}
            options={options}
            onChange={(i, v) => f.form.setValue(`splits.${i}.cover_employee_id`, v || null, { shouldDirty: true })}
            onAll={(v) => f.form.setValue("splits", splits.map((s) => ({ ...s, cover_employee_id: v || null })), { shouldDirty: true })}
            error2={f.form.formState.errors.splits?.message ?? f.form.formState.errors.splits?.root?.message}
          />
        )}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <DateTimeField control={f.control} name="starts_at" label="From" required helper="Now, unless the cover starts later." />
          <DateTimeField control={f.control} name="ends_at" label="Until" required helper="Access ends by itself at this time. At most 90 days.">
            <div className="flex flex-wrap gap-1.5 pt-0.5">
              {context.data
                ? context.data.quickPicks.map((p) => (
                    <Button key={p.key} type="button" size="xs" variant={endsAt === p.endsAt ? "secondary" : "outline"} onClick={() => f.form.setValue("ends_at", p.endsAt, { shouldDirty: true, shouldValidate: true })}>
                      <CalendarClockIcon aria-hidden="true" />
                      {p.label}
                    </Button>
                  ))
                : Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-6 w-24" />)}
            </div>
          </DateTimeField>
          <SelectField control={f.control} name="reason" label="Reason" required options={COVER_REASON_OPTIONS} />
          <TextareaField control={f.control} name="note" label="Note" rows={2} helper="For the record: why, and anything the granter should remember." />
          <TextareaField control={f.control} name="handover_note" label="Handover note" rows={3} className="md:col-span-2" helper="Shown to the cover person at the top of the client page: what's pending, who to call." />
        </div>
        <div className="flex flex-col gap-2">
          {actorRole === "partner" ? (
            <SwitchField
              control={f.control}
              name="include_vault"
              label="Include portal passwords"
              description="Lets the cover person reveal these clients' stored portal passwords, only if they already have Vault access. Every reveal is logged."
            />
          ) : null}
          <SwitchField control={f.control} name="email_cover_person" label="Also email the cover person" description="They get an in-app notification either way." />
        </div>
      </div>
    </FormDialog>
  )
}

function splitLabel(n: number): string {
  if (n === 0) return "Grant covers"
  return n === 1 ? "Grant 1 cover" : `Grant ${n} covers`
}

type LoadError = { message: string; ref?: string }

function SplitTable({
  loading,
  error,
  onRetry,
  rows,
  splits,
  options,
  onChange,
  onAll,
  error2,
}: {
  loading: boolean
  error: LoadError | null
  onRetry: () => void
  rows: CoverClientRow[]
  splits: Array<{ client_id: string; cover_employee_id?: string | null }>
  options: Array<{ value: string; label: string; description?: string }>
  onChange: (index: number, value: string) => void
  onAll: (value: string) => void
  error2?: string
}) {
  const allId = React.useId()
  if (loading) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    )
  }
  if (error) return <ErrorBlock message="Couldn't load their clients." errorRef={error.ref} size="compact" onRetry={onRetry} />
  if (rows.length === 0) return <p className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-text-muted">They don&apos;t own or sit on the team of any client, so there is nothing to split.</p>
  const select = "h-9 w-full cursor-pointer rounded-md border border-text-muted/30 bg-surface px-2 text-sm text-text outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 pointer-coarse:h-11"
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-text-muted">
          {rows.length} {rows.length === 1 ? "client" : "clients"}. Leave a client blank to skip it.
        </p>
        <div className="flex items-center gap-2">
          <label htmlFor={allId} className="text-sm text-text-muted">
            Set all to
          </label>
          <select id={allId} className={cn(select, "w-48")} defaultValue="" onChange={(e) => onAll(e.target.value)}>
            <option value="">No one</option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error2 ? (
        <p role="alert" className="text-sm text-danger-text">
          {error2}
        </p>
      ) : null}
      <div className="max-h-[min(40dvh,22rem)] overflow-auto rounded-md border border-border">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <caption className="sr-only">Their clients and who covers each</caption>
          <thead>
            <tr>
              {["Client", "Open tasks", "Next deadline", "Cover person"].map((h, i) => (
                <th key={h} scope="col" className={cn("sticky top-0 z-10 h-9 bg-surface-2 px-3 text-left text-xs font-medium whitespace-nowrap text-text-muted shadow-[inset_0_-1px_0_var(--border)]", (i === 1 || i === 2) && "text-right")}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const index = splits.findIndex((s) => s.client_id === r.id)
              return (
                <tr key={r.id}>
                  <td className="border-b border-border/70 px-3 py-1.5">
                    <span className="block text-base text-text">{r.display_name}</span>
                    <span className="block text-xs text-text-muted">
                      {r.client_code} · {r.relation === "owner" ? "Owner" : "On the team"}
                    </span>
                  </td>
                  <td className="num border-b border-border/70 px-3 py-1.5 text-right">{r.open_tasks}</td>
                  <td className="border-b border-border/70 px-3 py-1.5 text-right">
                    {r.next_deadline ? (
                      <span className="flex flex-col items-end">
                        <DateText date={r.next_deadline} withRelative stacked />
                        <span className="max-w-[12rem] truncate text-xs text-text-muted" title={r.next_deadline_title ?? undefined}>
                          {r.next_deadline_title}
                        </span>
                      </span>
                    ) : (
                      <span className="text-text-muted">—</span>
                    )}
                  </td>
                  <td className="border-b border-border/70 px-3 py-1.5">
                    <select
                      aria-label={`Cover person for ${r.display_name}`}
                      className={select}
                      value={index >= 0 ? (splits[index].cover_employee_id ?? "") : ""}
                      onChange={(e) => index >= 0 && onChange(index, e.target.value)}
                    >
                      <option value="">No cover</option>
                      {options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
