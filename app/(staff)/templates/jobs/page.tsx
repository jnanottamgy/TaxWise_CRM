import type { Metadata } from "next"
import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { requireStaff } from "@/lib/auth/guards"
import { can } from "@/lib/auth/roles"
import { logUnexpected } from "@/lib/log"
import { cn } from "@/lib/utils"
import { SERVICE_TYPE_LABELS, SERVICE_TYPES } from "@/lib/domain/enums"
import { readParam, readParamList } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { FilterBar } from "@/components/app/filter-bar"
import { ErrorBlock } from "@/components/app/error-block"
import { PageGuide } from "@/components/shell/page-slots"
import { listAutomations, listJobTemplatesWithItems } from "@/lib/data/job-templates"
import { getTaskFormOptions } from "@/lib/data/tasks"
import { TemplatesList } from "@/components/job-templates/templates-list"
import { NewTemplateButton } from "@/components/job-templates/template-form"
import { AutomationsList } from "@/components/job-templates/automations-list"
import { NewAutomationButton, type AutomationOptions } from "@/components/job-templates/automation-form"

export const metadata: Metadata = { title: "Job templates" }

type SearchParams = Record<string, string | string[] | undefined>

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/templates/jobs:${source}`, userId }) }
  }
}

/**
 * Job templates (§7.6.2, §5.5) and recurring tasks (§7.6.7). A template is a list of steps dated
 * from a job's due date; applying it to a task fills the checklist. A recurring task creates a
 * client's task every period from a title and, optionally, a template. Partners and Managers manage
 * both; Employees see the templates (§4.1 "use only").
 */
export default async function JobTemplatesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, supabase } = await requireStaff()
  const sp = await searchParams
  const canManage = can.manageTemplates(user.role)
  const view = canManage && readParam(sp, "view") === "recurring" ? "recurring" : "templates"
  const q = (readParam(sp, "q") ?? "").trim()
  const service = readParamList(sp, "service").filter((s) => (SERVICE_TYPES as readonly string[]).includes(s))
  const state = readParam(sp, "state")
  const stateFilter = state === "active" || state === "inactive" ? state : null

  const [templates, automations, form] = await Promise.all([
    view === "templates" ? attempt("templates", user.id, () => listJobTemplatesWithItems(supabase, { q, service, state: stateFilter })) : Promise.resolve(null),
    view === "recurring" ? attempt("automations", user.id, () => listAutomations(supabase)) : Promise.resolve(null),
    canManage ? attempt("options", user.id, () => getTaskFormOptions(supabase, user.role)) : Promise.resolve(null),
  ])

  const options: AutomationOptions | null =
    form && form.ok
      ? {
          staff: form.data.staff,
          reviewers: form.data.reviewers,
          templates: form.data.templates.map((t) => ({ id: t.id, name: t.name, service_type: t.service_type, default_lead_days: t.default_lead_days })),
        }
      : null

  return (
    <div className="flex min-w-0 flex-col">
      <PageGuide title="Job templates">
        <p>A template lists the steps of a job, each so many days before (or after) the job&apos;s due date. Apply it when creating a task, or from the task&apos;s checklist, and every step gets its own date.</p>
        <p className="mt-2">Recurring tasks create a client&apos;s task every period, such as “GSTR-3B: {"{period}"}” on the 1st of every month for the month just ended. Each period&apos;s task is created once, even if the daily run repeats.</p>
      </PageGuide>
      <PageHeader
        title="Job templates"
        description={view === "recurring" ? "Tasks created for clients every period, on a schedule." : "Reusable checklists for recurring kinds of work, dated from the due date."}
        actions={canManage ? view === "recurring" ? options ? <NewAutomationButton options={options} /> : null : <NewTemplateButton /> : null}
      />
      {canManage ? (
        <nav aria-label="Job templates views" className="mb-3">
          <ul className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-surface-2 p-0.5">
            {[
              { id: "templates", label: "Templates", href: "/templates/jobs" },
              { id: "recurring", label: "Recurring tasks", href: "/templates/jobs?view=recurring" },
            ].map((it) => (
              <li key={it.id}>
                <Link
                  href={it.href}
                  aria-current={view === it.id ? "page" : undefined}
                  className={cn(
                    "inline-flex h-8 items-center rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors duration-150 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:h-10",
                    view === it.id ? "bg-surface text-text ring-1 ring-border" : "text-text-muted hover:text-text",
                  )}
                >
                  {it.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}

      {view === "templates" ? (
        <>
          <FilterBar
            searchLabel="Search templates"
            searchPlaceholder="Name or description"
            filters={[
              { id: "service", label: "Service", options: SERVICE_TYPES.map((s) => ({ value: s, label: SERVICE_TYPE_LABELS[s] })) },
              ...(canManage ? [{ id: "state", label: "State", multi: false, options: [{ value: "active", label: "Active" }, { value: "inactive", label: "Inactive" }] }] : []),
            ]}
          />
          {templates && templates.ok ? (
            <TemplatesList templates={canManage ? templates.data : templates.data.filter((t) => t.is_active)} canManage={canManage} filtered={Boolean(q || service.length || stateFilter)} />
          ) : (
            <div className="rounded-lg border border-border bg-surface">
              <ErrorBlock message="Couldn't load the job templates." errorRef={templates && !templates.ok ? templates.ref : null} />
            </div>
          )}
        </>
      ) : automations && automations.ok && options ? (
        <section aria-label="Recurring tasks" className="overflow-hidden rounded-lg border border-border bg-surface">
          <AutomationsList automations={automations.data} options={options} />
        </section>
      ) : (
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load the recurring tasks." errorRef={automations && !automations.ok ? automations.ref : form && !form.ok ? form.ref : null} />
        </div>
      )}
    </div>
  )
}
