"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useWatch, type FieldPath } from "react-hook-form"
import { HistoryIcon } from "lucide-react"
import { toast } from "sonner"
import { deriveFromGstin } from "@/lib/domain/india-validators"
import { duplicateBlocks } from "@/lib/domain/conflict"
import { formatDateTime } from "@/lib/format"
import type { ServiceType } from "@/lib/domain/enums"
import {
  ONBOARDING_STEPS,
  allIssues,
  emptyOnboardingValues,
  gstFrequencyLock,
  mergeChecklist,
  newServiceEntry,
  onboardingSchema,
  schemeDecisionFor,
  stepOfPath,
  taxAuditFor,
  type ChecklistItemValue,
  type FieldIssue,
  type OnboardingData,
  type OnboardingStepId,
  type OnboardingValues,
} from "@/lib/schemas/onboarding"
import { checkClientCode, checkClientDuplicates, completeOnboarding, suggestNextClientCode, type OnboardingResult } from "@/server/actions/clients"
import { useActionForm, type FormError } from "@/hooks/use-action-form"
import { clearDraft, readDraft, useAutosave, type StoredDraft } from "@/hooks/use-autosave"
import { Button } from "@/components/ui/button"
import { WizardDialog, type WizardStep } from "@/components/app/wizard"
import { DraftStamp } from "@/components/app/draft-stamp"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { StepBasics, type CodeStatus } from "@/components/clients/onboarding/step-basics"
import { StepServices } from "@/components/clients/onboarding/step-services"
import { StepConfigure } from "@/components/clients/onboarding/step-configure"
import { StepChecklist } from "@/components/clients/onboarding/step-checklist"
import { StepReview } from "@/components/clients/onboarding/step-review"
import { ConflictCheckDialog, type AcceptanceResult } from "@/components/clients/onboarding/conflict-check-dialog"
import { OnboardingSuccess } from "@/components/clients/onboarding/onboarding-success"
import { useDeadlinePreview } from "@/components/clients/onboarding/use-deadline-preview"
import { useChecklistUploads } from "@/components/clients/onboarding/use-checklist-uploads"
import type { DuplicateState } from "@/components/clients/onboarding/duplicate-guard"
import { draftKeyFor, type WizardSetup, type WizardSource } from "@/components/clients/onboarding/types"

const STEP_INDEX: Record<OnboardingStepId, number> = Object.fromEntries(ONBOARDING_STEPS.map((s, i) => [s.id, i])) as Record<OnboardingStepId, number>
/** Issues with no field of their own: shown in the step (and the alert), never via setError. */
const UNPLACED = new Set(["services", "acceptance_id", "independence", "_form"])
/**
 * What the step's alert says when the only problem is a field that sits below the fold: the alert
 * takes focus (and the scroll) on a failed Continue, so "the highlighted field" alone would point
 * at nothing on screen.
 */
const ALERT_FOR: Partial<Record<string, string>> = {
  checklist_reviewed: "Tick “I’ve reviewed this checklist” at the end of the list to continue.",
}
const NETWORK = "We couldn't reach the server. Check your connection and try again."
const noSubscription = () => () => undefined
const onClient = () => true
const onServer = () => false

function dedupe(issues: FieldIssue[]): FieldIssue[] {
  const seen = new Set<string>()
  return issues.filter((i) => {
    const k = `${i.path}|${i.message}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** "basics" holds `display_name`, "configure" holds `services.2.agreed_fee` (the first error's step). */
function firstStepOf(paths: string[]): number | null {
  let best: number | null = null
  for (const p of paths) {
    const i = STEP_INDEX[stepOfPath(p)]
    if (best === null || i < best) best = i
  }
  return best
}


/**
 * The add-client wizard (§7.3.2) in its full-screen dialog: five steps that unlock in order with a
 * ✓ when valid, a sticky footer (Back · Save draft · Continue / Complete), the draft autosaved on
 * this device every 5 seconds (offered back on the next visit), the duplicate guard and the code
 * check on blur, the conflict check, and Complete behind a confirm. Complete runs one transaction
 * on the server; what follows it (notifications, the welcome email, the portal invite, the
 * WhatsApp group to-do) comes back as the success screen, with any failure as a warning.
 */
export function OnboardingWizard({ setup, initial, source, servicesLocked }: { setup: WizardSetup; initial: OnboardingValues; source: WizardSource; servicesLocked: boolean }) {
  const router = useRouter()
  const today = setup.today
  const isPartner = setup.viewer.role === "partner"
  const schema = React.useMemo(() => onboardingSchema(today), [today])
  const f = useActionForm(schema, completeOnboarding, {
    defaultValues: initial,
    mode: "onBlur",
  })
  const form = f.form
  const control = f.control
  const values = useWatch({ control }) as OnboardingValues
  const isDirty = form.formState.isDirty
  const draftKey = draftKeyFor(source, setup.viewer.employeeId)

  const [step, setStep] = React.useState(0)
  const [suggestedCode, setSuggestedCode] = React.useState(setup.clientCode)
  const [attempted, setAttempted] = React.useState<Partial<Record<OnboardingStepId, boolean>>>({})
  const [alert, setAlert] = React.useState<FormError | null>(null)
  const alertRef = React.useRef<HTMLDivElement | null>(null)
  const [confirming, setConfirming] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [conflictOpen, setConflictOpen] = React.useState(false)
  const [files, setFiles] = React.useState<Record<string, File>>({})
  const [success, setSuccess] = React.useState<{
    result: OnboardingResult
    warnings: string[]
  } | null>(null)
  const uploads = useChecklistUploads()

  // ---- The draft (§7.3.2 "The draft autosaves"): offered back once, before anything is saved over it.
  const [startDraft, setStartDraft] = React.useState<{
    checked: boolean
    draft: StoredDraft<OnboardingValues> | null
    decided: boolean
  }>({
    checked: false,
    draft: null,
    decided: false,
  })
  const hydrated = React.useSyncExternalStore(noSubscription, onClient, onServer)
  if (hydrated && !startDraft.checked)
    setStartDraft({
      checked: true,
      draft: readDraft<OnboardingValues>(draftKey),
      decided: false,
    })
  const offeringDraft = startDraft.checked && !!startDraft.draft && !startDraft.decided
  const draft = useAutosave({
    key: draftKey,
    value: values,
    enabled: startDraft.checked && !offeringDraft && isDirty && !success,
  })

  // ---- Duplicate guard (§7.3.2) and code check.
  const [dups, setDups] = React.useState<DuplicateState & { key: string }>({
    status: "idle",
    duplicates: [],
    error: null,
    key: "",
  })
  const [continuingDup, setContinuingDup] = React.useState(!!initial.duplicate_reason)
  const [codeStatus, setCodeStatus] = React.useState<CodeStatus>("idle")
  const dupSeq = React.useRef(0)

  const dupKey = (v: Pick<OnboardingValues, "pan" | "gstin" | "display_name">) =>
    `${(v.pan ?? "").trim().toUpperCase()}|${(v.gstin ?? "").trim().toUpperCase()}|${(v.display_name ?? "").trim().toLowerCase()}`

  const runDuplicateCheck = async (force = false): Promise<DuplicateState> => {
    const v = form.getValues()
    const key = dupKey(v)
    if (!force && key === dups.key && dups.status === "ready") return dups
    const seq = ++dupSeq.current
    setDups((d) => ({ ...d, status: "checking", key }))
    try {
      const r = await checkClientDuplicates({
        pan: (v.pan ?? "").trim(),
        gstin: (v.gstin ?? "").trim(),
        name: (v.display_name ?? "").trim(),
      })
      const next: DuplicateState & { key: string } = r.ok
        ? { status: "ready", duplicates: r.data.duplicates, error: null, key }
        : { status: "error", duplicates: [], error: r.error, key }
      if (seq === dupSeq.current) setDups(next)
      return next
    } catch {
      const next = {
        status: "error" as const,
        duplicates: [],
        error: "Couldn't check for an existing client with these details.",
        key,
      }
      if (seq === dupSeq.current) setDups(next)
      return next
    }
  }

  const runCodeCheck = async () => {
    const v = form.getValues()
    if (v.client_code_auto !== false) return
    const code = (v.client_code ?? "").trim().toUpperCase()
    if (!code) return
    setCodeStatus("checking")
    try {
      const r = await checkClientCode({ code })
      if (!r.ok) {
        setCodeStatus("error")
        return
      }
      if (form.getValues("client_code")?.trim().toUpperCase() !== code) return
      if (r.data.available) setCodeStatus("free")
      else {
        setCodeStatus("taken")
        form.setError("client_code", {
          type: "server",
          message: `${code} is already in use. Choose another, or use ${suggestedCode}.`,
        })
      }
    } catch {
      setCodeStatus("error")
    }
  }

  // ---- Field automation: upper-case identifiers, GSTIN → state and PAN, a typed code is "manual".
  React.useEffect(() => {
    const sub = form.watch((v, { name }) => {
      if (name === "pan" || name === "tan" || name === "gstin") {
        const raw = (v[name] as string | undefined) ?? ""
        const up = raw.toUpperCase().replace(/\s+/g, "")
        if (up !== raw) form.setValue(name, up, { shouldDirty: true })
        if (name === "gstin") {
          const parts = deriveFromGstin(up)
          if (parts) {
            if (v.state_code !== parts.stateCode)
              form.setValue("state_code", parts.stateCode, {
                shouldDirty: true,
              })
            if (!v.pan) form.setValue("pan", parts.pan, { shouldDirty: true })
            if (!v.gst_registration)
              form.setValue("gst_registration", "registered", {
                shouldDirty: true,
              })
          }
        }
      }
      if (name === "client_code") {
        const auto = ((v.client_code as string | undefined) ?? "").trim().toUpperCase() === suggestedCode
        if ((v.client_code_auto !== false) !== auto) form.setValue("client_code_auto", auto)
        setCodeStatus("idle")
      }
    })
    return () => sub.unsubscribe()
  }, [form, suggestedCode])

  // ---- Derived facts (§6.6) and the deadline preview (§6.7).
  const decision = schemeDecisionFor(values, setup.scale)
  const indication = taxAuditFor(values, setup.scale)
  const services = values.services ?? []
  const types = services.map((s) => s.service_type)
  const audit = types.includes("audit")
  const calendarInputs = {
    entity_type: values.entity_type ?? "",
    gst_registration: values.gst_registration ?? "",
    gstin: values.gstin ?? "",
    state_code: values.state_code ?? "",
    annual_turnover: values.annual_turnover ?? "",
    gst_scheme_choice: values.gst_scheme_choice ?? "auto",
    tax_audit_decision: isPartner ? (values.tax_audit_decision ?? "review") : ("review" as const),
    income_nature: values.income_nature ?? "",
    services: types.map((t) => ({ service_type: t })),
  }
  const preview = useDeadlinePreview(calendarInputs, step >= 2 && types.length > 0 && !success)

  // ---- Validation: the shared schema, plus every step rule even when a field's shape is wrong.
  const issues = React.useMemo(() => {
    const parsed = schema.safeParse(values)
    const base: FieldIssue[] = parsed.success
      ? []
      : parsed.error.issues.map((i) => ({
          path: i.path.map(String).join("."),
          message: i.message,
        }))
    const filled = {
      ...emptyOnboardingValues({
        clientCode: suggestedCode,
        reminderDays: setup.reminderDays,
        notifyChannels: setup.notifyChannels,
      }),
      ...values,
    } as unknown as OnboardingData
    return dedupe([...base, ...allIssues(filled, today)])
  }, [schema, values, suggestedCode, setup.reminderDays, setup.notifyChannels, today])
  const issuesFor = (id: OnboardingStepId) => issues.filter((i) => stepOfPath(i.path) === id)

  const blockingDup = dups.duplicates.some(duplicateBlocks)
  const needsDupReason = dups.duplicates.length > 0 && !blockingDup && !(values.duplicate_reason ?? "").trim()
  const declined = values.acceptance_outcome === "declined"
  const auditNeedsAcceptance = audit && values.acceptance_outcome !== "accepted"

  const valid: Record<OnboardingStepId, boolean> = {
    basics: issuesFor("basics").length === 0 && !blockingDup && !needsDupReason && !declined && dups.status !== "checking",
    services: issuesFor("services").length === 0 && !auditNeedsAcceptance && !declined,
    configure: issuesFor("configure").length === 0,
    checklist: issuesFor("checklist").length === 0,
    review: issuesFor("review").length === 0,
  }
  const steps: WizardStep[] = ONBOARDING_STEPS.map((s) => ({
    id: s.id,
    title: s.title,
    description: s.description,
    valid: valid[s.id],
  }))
  const stepId = ONBOARDING_STEPS[step].id

  const showAlert = (e: FormError) => {
    setAlert(e)
    requestAnimationFrame(() => alertRef.current?.focus())
  }

  /** Puts a step's issues on its fields (focusing the first) and says what's left. */
  const markStep = (id: OnboardingStepId, list: FieldIssue[]): void => {
    setAttempted((a) => ({ ...a, [id]: true }))
    let focused = false
    for (const issue of list) {
      if (UNPLACED.has(issue.path)) continue
      form.setError(issue.path as FieldPath<OnboardingValues>, { type: "manual", message: issue.message }, { shouldFocus: !focused })
      focused = true
    }
  }

  const validateStep = async (id: OnboardingStepId): Promise<boolean> => {
    let list = issuesFor(id)
    if (id === "basics") {
      const d = await runDuplicateCheck()
      const blocks = d.duplicates.some(duplicateBlocks)
      if (blocks)
        list = [
          ...list,
          {
            path: "_form",
            message: "This looks like a client that already exists. Open it instead, or correct the PAN or GSTIN.",
          },
        ]
      else if (d.duplicates.length && !(form.getValues("duplicate_reason") ?? "").trim()) {
        setContinuingDup(true)
        list = [
          ...list,
          {
            path: "duplicate_reason",
            message: "Say why this is a different client from the one it looks like.",
          },
        ]
      }
      if (declined)
        list = [
          ...list,
          {
            path: "acceptance_id",
            message: "The conflict check was declined, so this client can't be onboarded.",
          },
        ]
    }
    if (id === "services" && auditNeedsAcceptance) {
      list = [
        ...list,
        {
          path: "acceptance_id",
          message: "Audit work needs the conflict check with the decision Accept. Run it before you continue.",
        },
      ]
    }
    if (list.length === 0) {
      setAlert(null)
      return true
    }
    markStep(id, list)
    const unplaced = list.filter((i) => UNPLACED.has(i.path))
    const placed = list.length - unplaced.length
    const onlyPlaced = placed === 1 ? list.find((i) => !UNPLACED.has(i.path)) : undefined
    showAlert({
      message:
        unplaced[0]?.message ??
        (onlyPlaced && ALERT_FOR[onlyPlaced.path]) ??
        (placed > 1 ? `Please check the ${placed} highlighted fields.` : "Please check the highlighted field."),
      client: true,
    })
    return false
  }

  const goTo = (i: number) => {
    setAlert(null)
    setStep(i)
  }

  // ---- Step 2 actions: services keep the checklist and GST frequency in step (§7.3.2).
  const setServices = (next: OnboardingValues["services"]) => {
    const list = next ?? []
    form.setValue("services", list, { shouldDirty: true })
    const merged = mergeChecklist(
      (form.getValues("checklist") ?? []) as ChecklistItemValue[],
      list.map((s) => s.service_type),
    )
    const before = JSON.stringify(form.getValues("checklist") ?? [])
    if (JSON.stringify(merged) !== before) {
      form.setValue("checklist", merged, { shouldDirty: true })
      if (form.getValues("checklist_reviewed")) form.setValue("checklist_reviewed", false, { shouldDirty: true })
    }
    if (list.some((s) => s.service_type === "tds")) form.setValue("show_tan", true)
    form.clearErrors("services")
  }
  const toggleService = (s: ServiceType) => {
    if (servicesLocked) return
    const current = form.getValues("services") ?? []
    if (current.some((x) => x.service_type === s)) setServices(current.filter((x) => x.service_type !== s))
    else setServices([...current, newServiceEntry(s, decision.scheme)])
  }

  const onChecklistChange = (next: ChecklistItemValue[]) => {
    form.setValue("checklist", next, { shouldDirty: true })
    setFiles((fs) => Object.fromEntries(Object.entries(fs).filter(([k]) => next.some((i) => i.key === k && i.included && i.collected))))
  }

  const onAcceptance = (r: AcceptanceResult) => {
    form.setValue("acceptance_id", r.acceptanceId, { shouldDirty: true })
    form.setValue("acceptance_outcome", r.outcome, { shouldDirty: true })
    form.setValue("acceptance_summary", r.summary.slice(0, 300), {
      shouldDirty: true,
    })
    if (r.outcome === "accepted") toast.success("Conflict check accepted.")
  }

  // ---- Complete (§7.3.2): every step again, a confirm, then one transaction.
  const openConfirm = async () => {
    for (const s of ONBOARDING_STEPS) {
      if (!(await validateStep(s.id))) {
        setStep(STEP_INDEX[s.id])
        return
      }
    }
    setConfirming(true)
  }

  const submit = async (): Promise<boolean> => {
    setSubmitting(true)
    setAlert(null)
    const v = form.getValues()
    const lock = gstFrequencyLock(schemeDecisionFor(v, setup.scale))
    const payload: OnboardingValues = {
      ...v,
      services: (v.services ?? []).map((s) => (s.service_type === "gst" ? { ...s, frequency: lock.frequency } : s)),
      tax_audit_decision: isPartner ? v.tax_audit_decision : "review",
    }
    try {
      const r = await completeOnboarding(payload)
      if (!r.ok) {
        const entries = Object.entries(r.fieldErrors ?? {})
        let focused = false
        for (const [path, messages] of entries) {
          const message = messages[0]
          if (!message || UNPLACED.has(path)) continue
          form.setError(path as FieldPath<OnboardingValues>, { type: "server", message }, { shouldFocus: !focused })
          focused = true
        }
        if (r.fieldErrors?.duplicate_reason) setContinuingDup(true)
        if (r.fieldErrors?.pan || r.fieldErrors?.gstin) void runDuplicateCheck(true)
        const target = firstStepOf(entries.map(([p]) => p))
        if (target !== null) {
          setStep(target)
          setAttempted((a) => ({ ...a, [ONBOARDING_STEPS[target].id]: true }))
        }
        setConfirming(false)
        showAlert({ message: r.error, ref: r.ref })
        return false
      }
      draft.clear()
      clearDraft(draftKey)
      setConfirming(false)
      setSuccess({ result: r.data, warnings: r.warnings ?? [] })
      // Files picked in step 4 go to the new client's vault (the checklist rows come back in order).
      const included = (v.checklist ?? []).filter((i) => i.included)
      const jobs = included
        .map((item, idx) => ({ item, row: r.data.checklist[idx] }))
        .filter(({ item, row }) => row && files[item.key] && row.label === item.label)
        .map(({ item, row }) => ({
          itemId: row.id,
          label: row.label,
          file: files[item.key],
        }))
      if (jobs.length) void uploads.start(r.data.clientId, jobs)
      return true
    } catch {
      setConfirming(false)
      showAlert({ message: NETWORK })
      return false
    } finally {
      setSubmitting(false)
    }
  }

  const close = () => {
    router.push(source.kind === "quotation" ? `/quotations/${source.id}` : source.kind === "lead" ? `/leads/${source.id}` : "/clients")
  }

  const addAnother = async () => {
    if (source.kind !== "new") {
      router.push("/clients/new")
      return
    }
    let code = suggestedCode
    try {
      const r = await suggestNextClientCode({})
      if (r.ok) code = r.data.code
    } catch {
      // The server takes the next free number at Complete anyway.
    }
    setSuggestedCode(code)
    form.reset(
      emptyOnboardingValues({
        clientCode: code,
        reminderDays: setup.reminderDays,
        notifyChannels: setup.notifyChannels,
      }),
    )
    setFiles({})
    setDups({ status: "idle", duplicates: [], error: null, key: "" })
    setContinuingDup(false)
    setCodeStatus("idle")
    setAttempted({})
    setAlert(null)
    setStep(0)
    setSuccess(null)
  }

  if (success) {
    const owner = setup.staff.find((s) => s.id === form.getValues("owner_employee_id"))?.name ?? null
    const partner = setup.staff.find((s) => s.id === form.getValues("engagement_partner_id"))?.name ?? null
    return (
      <OnboardingSuccess
        result={success.result}
        warnings={success.warnings}
        ownerName={owner}
        partnerName={partner}
        uploads={uploads.jobs}
        onRetryUpload={(i) => void uploads.retry(i)}
        onAddAnother={() => void addAnother()}
      />
    )
  }

  const servicesError = attempted.services ? (issues.find((i) => i.path === "services")?.message ?? null) : null
  const errorPaths = Object.keys(form.formState.errors).length ? issues.map((i) => i.path) : []
  const fileCount = Object.keys(files).length

  return (
    <WizardDialog
      open
      onOpenChange={(o) => {
        if (!o) close()
      }}
      dirty={isDirty}
      title={
        source.kind === "quotation"
          ? `Add client from quotation ${source.number}`
          : source.kind === "lead"
            ? `Convert lead${source.number ? ` ${source.number}` : ""} to a client`
            : "Add client"
      }
      steps={steps}
      current={step}
      onStepChange={goTo}
      onContinue={() => validateStep(stepId)}
      onComplete={openConfirm}
      onSaveDraft={async () => {
        await draft.saveNow()
        toast.success("Draft saved on this device.")
      }}
      draftStatus={<DraftStamp savedAt={draft.savedAt} saving={draft.saving} error={draft.error} />}
      completeLabel="Complete onboarding"
      pending={submitting}
    >
      {offeringDraft && startDraft.draft ? (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-info/40 bg-info-soft px-4 py-3">
          <HistoryIcon aria-hidden="true" className="size-4 flex-none text-info-text" />
          <p className="min-w-0 flex-1 text-base text-text">
            You have a draft from <span className="num tabular-nums">{formatDateTime(startDraft.draft.at)}</span> on this device.
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => {
                const saved = startDraft.draft
                if (!saved) return
                // A code left to "next free number" takes today's suggestion, not the one the draft saw.
                const restored = { ...initial, ...saved.value }
                if (restored.client_code_auto !== false) restored.client_code = suggestedCode
                form.reset(restored, { keepDefaultValues: true })
                if (saved.value.duplicate_reason) setContinuingDup(true)
                setStartDraft((d) => ({ ...d, decided: true }))
                goTo(0)
                toast.success("Draft restored. Attached files aren't kept in drafts; attach them again in step 4.")
              }}
            >
              Restore it
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                clearDraft(draftKey)
                setStartDraft((d) => ({ ...d, decided: true }))
              }}
            >
              Start fresh
            </Button>
          </div>
        </div>
      ) : null}

      <FormAlert state={{ formError: alert, alertRef }} />

      {stepId === "basics" ? (
        <StepBasics
          control={control}
          values={values}
          today={today}
          isPartner={isPartner}
          suggestedCode={suggestedCode}
          decision={decision}
          indication={indication}
          tdsSelected={types.includes("tds")}
          attest={audit}
          duplicates={dups}
          continuingDuplicate={continuingDup}
          onContinueAnyway={() => setContinuingDup(true)}
          onRetryDuplicates={() => void runDuplicateCheck(true)}
          onIdentityBlur={() => void runDuplicateCheck()}
          codeStatus={codeStatus}
          onCodeBlur={() => void runCodeCheck()}
          onUseSuggestedCode={() => {
            form.setValue("client_code", suggestedCode, { shouldDirty: true })
            form.setValue("client_code_auto", true)
            form.clearErrors("client_code")
          }}
          onShowTan={() => form.setValue("show_tan", true)}
          acceptance={
            values.acceptance_id
              ? {
                  acceptanceId: values.acceptance_id,
                  outcome: values.acceptance_outcome ?? "pending",
                  summary: values.acceptance_summary ?? "",
                }
              : null
          }
          onOpenConflictCheck={() => setConflictOpen(true)}
        />
      ) : stepId === "services" ? (
        <StepServices
          control={control}
          values={values}
          locked={servicesLocked}
          servicesError={servicesError}
          onToggle={toggleService}
          onAddOther={() => setServices([...(form.getValues("services") ?? []), newServiceEntry("other", decision.scheme)])}
          onRemoveAt={(i) => setServices((form.getValues("services") ?? []).filter((_, k) => k !== i))}
          acceptanceOutcome={values.acceptance_outcome ?? ""}
          onOpenConflictCheck={() => setConflictOpen(true)}
        />
      ) : stepId === "configure" ? (
        <StepConfigure
          control={control}
          values={values}
          today={today}
          decision={decision}
          preview={preview}
          staff={setup.staff}
          sacByService={setup.sacByService}
          defaultSac={setup.defaultSac}
          seesFees
          errorPaths={errorPaths}
        />
      ) : stepId === "checklist" ? (
        <StepChecklist
          control={control}
          values={values}
          onChange={onChecklistChange}
          files={files}
          onFile={(key, file) =>
            setFiles((fs) => {
              const next = { ...fs }
              if (file) next[key] = file
              else delete next[key]
              return next
            })
          }
        />
      ) : (
        <StepReview
          control={control}
          values={values}
          today={today}
          decision={decision}
          indication={indication}
          preview={preview}
          staff={setup.staff}
          suggestedCode={suggestedCode}
          files={fileCount}
          seesFees
          onEdit={goTo}
        />
      )}

      <ConflictCheckDialog
        open={conflictOpen}
        onOpenChange={setConflictOpen}
        prospectName={values.display_name ?? ""}
        legalName={values.legal_name ?? ""}
        pan={values.pan ?? ""}
        gstin={values.gstin ?? ""}
        leadId={values.source_lead_id || null}
        attest={audit}
        current={
          values.acceptance_id
            ? {
                acceptanceId: values.acceptance_id,
                outcome: values.acceptance_outcome ?? "pending",
                summary: values.acceptance_summary ?? "",
              }
            : null
        }
        onDecided={onAcceptance}
      />
      <ConfirmDialog
        open={confirming}
        onOpenChange={(o) => {
          if (!submitting) setConfirming(o)
        }}
        title={`Onboard ${values.display_name || "this client"}?`}
        description={`This creates the client with ${services.length} ${services.length === 1 ? "service" : "services"}, its team, the document checklist, the deadlines for the next 12 months and the first tasks for the owner, all at once.`}
        details={
          <ul className="list-disc pl-4 text-sm text-text-muted">
            {values.invite_portal ? <li>A portal login is created and shown once on the next screen.</li> : null}
            {values.send_welcome && values.email ? <li>The welcome email goes to {values.email}.</li> : null}
            {source.kind !== "new" ? <li>The {source.kind} is marked as converted.</li> : null}
            {fileCount ? <li>{fileCount === 1 ? "The attached file is" : `The ${fileCount} attached files are`} filed in the client&apos;s documents.</li> : null}
          </ul>
        }
        confirmLabel="Complete onboarding"
        onConfirm={submit}
      />
    </WizardDialog>
  )
}
