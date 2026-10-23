import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { BriefcaseBusinessIcon } from "lucide-react"
import type { CurrentUser } from "@/lib/auth/current-user"
import type { ServerSupabase } from "@/lib/supabase/server"
import { logUnexpected } from "@/lib/log"
import { formatDateTime, formatTimeAgo } from "@/lib/format"
import { SectionCard } from "@/components/app/section-card"
import { DefinitionList } from "@/components/app/definition-list"
import { KpiStrip } from "@/components/app/kpi-strip"
import { Money } from "@/components/app/money"
import { DateText } from "@/components/app/date-text"
import { StatusChip } from "@/components/app/status-chip"
import { MonoId } from "@/components/app/mono-id"
import { ErrorBlock } from "@/components/app/error-block"
import { EmptyState } from "@/components/app/empty-state"
import { RoleBadge } from "@/components/app/role-badge"
import { getPersonHistory, getPersonWork, type PersonDetail } from "@/lib/data/people"
import { getCoverWindowEvents, getCoversForPerson, getCover } from "@/lib/data/covers"
import { CoverList } from "@/components/covers/cover-list"

/**
 * Person detail tabs (§7.11.2), part one: Profile and Work. Each tab is an async Server Component
 * that loads its own data and never throws (a failed block shows its Ref). They are shown to the
 * person themselves too, so the people being measured can see it.
 */

export interface PersonTabProps {
  person: PersonDetail
  viewer: CurrentUser
  supabase: ServerSupabase
  searchParams: Record<string, string | string[] | undefined>
}

async function attempt<T>(source: string, viewer: CurrentUser, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/people/[id]:${source}`, userId: viewer.id, role: viewer.role }) }
  }
}

function first(v: string | string[] | undefined): string | null {
  return (Array.isArray(v) ? v[0] : v) ?? null
}

function BlockError({ what, errorRef }: { what: string; errorRef: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface">
      <ErrorBlock message={`Couldn't load ${what}.`} errorRef={errorRef} />
    </div>
  )
}

// -------------------------------------------------------------------------------------------------
// Profile (§4.5 fields)
// -------------------------------------------------------------------------------------------------

export async function PersonProfileTab({ person, viewer, supabase }: PersonTabProps) {
  const manager = viewer.role === "partner" || viewer.role === "manager"
  const history = manager ? await attempt("history", viewer, () => getPersonHistory(supabase, person.id)) : null
  const details = [
    { term: "Full name", value: person.full_name },
    { term: "Email", value: <MonoId value={person.email} copy label="email" /> },
    { term: "Phone", value: person.phone },
    { term: "WhatsApp", value: person.whatsapp },
    { term: "Role", value: <RoleBadge role={person.role} /> },
    { term: "Designation", value: person.designation },
    { term: "Department", value: person.department },
    { term: "Date of joining", value: person.date_of_joining ? <DateText date={person.date_of_joining} /> : null },
    ...(person.role === "partner" ? [{ term: "ICAI membership number", value: person.icai_membership_no ? <MonoId value={person.icai_membership_no} copy label="membership number" /> : null }] : []),
  ]
  const access = [
    {
      term: "Sign-in",
      value:
        person.login_status === "no_login"
          ? "No login yet"
          : person.login_status === "disabled"
            ? "Disabled"
            : person.must_change_password
              ? "Temporary password: they set their own at next sign-in"
              : "Active",
    },
    { term: "Last sign-in", value: person.last_login_at ? formatDateTime(person.last_login_at) : null },
    { term: "Last active", value: person.last_seen_at ? formatTimeAgo(person.last_seen_at) : null },
    { term: "Vault access", value: person.vault_access ? "Yes: can reveal stored portal passwords of their own clients" : "No" },
    ...(manager
      ? [{ term: "Billing rate", value: person.billing_rate_per_hour === null ? "Not billed hourly" : <span><Money value={person.billing_rate_per_hour} /> an hour</span> }]
      : []),
    ...(viewer.role === "partner"
      ? [{ term: "Cost rate", value: person.cost_rate_per_hour === null ? null : <span><Money value={person.cost_rate_per_hour} /> an hour</span> }]
      : []),
  ]
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <SectionCard title="Details">
        <DefinitionList items={details} />
      </SectionCard>
      <SectionCard title="Access and rates" description={manager ? "Rates are never shown to Employees." : undefined}>
        <DefinitionList items={access} />
      </SectionCard>
      {history ? (
        <SectionCard title="History" description="Changes to this person's record and access." className="xl:col-span-2">
          {!history.ok ? (
            <ErrorBlock message="Couldn't load the history." errorRef={history.ref} size="compact" />
          ) : history.data.length === 0 ? (
            <EmptyState size="compact" message="No changes recorded yet." />
          ) : (
            <ol className="flex flex-col divide-y divide-border/70">
              {history.data.map((h) => (
                <li key={h.id} className="flex flex-wrap items-baseline justify-between gap-x-4 py-2 first:pt-0 last:pb-0">
                  <span className="min-w-0 text-base text-text">{h.description}</span>
                  <span className="num text-sm text-text-muted">
                    {h.user_name ? `${h.user_name} · ` : ""}
                    {formatDateTime(h.at)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </SectionCard>
      ) : null}
    </div>
  )
}

// -------------------------------------------------------------------------------------------------
// Work: open tasks, review items, clients, covers (§7.11.2)
// -------------------------------------------------------------------------------------------------

export async function PersonWorkTab({ person, viewer, supabase, searchParams }: PersonTabProps) {
  const changesId = first(searchParams.changes)
  const returnNoteId = first(searchParams.return_note)
  const [work, covers, changes] = await Promise.all([
    attempt("work", viewer, () => getPersonWork(supabase, person.id)),
    attempt("covers", viewer, () => getCoversForPerson(supabase, person.id)),
    changesId && /^[0-9a-f-]{36}$/i.test(changesId)
      ? attempt("changes", viewer, async () => {
          const cover = await getCover(supabase, changesId)
          if (!cover) return null
          return { cover, events: await getCoverWindowEvents(supabase, cover) }
        })
      : Promise.resolve(null),
  ])
  const viewerShape = { role: viewer.role, employeeId: viewer.employeeId }
  const self = viewer.employeeId === person.id
  const name = self ? "You" : person.full_name.split(" ")[0]

  return (
    <div className="flex flex-col gap-4">
      {changes && changes.ok && changes.data ? (
        <SectionCard
          title={`What changed while ${changes.data.cover.cover_name} covered`}
          description={`${changes.data.cover.kind === "client" ? (changes.data.cover.client_name ?? "The client") : "Your clients"}, ${formatDateTime(changes.data.cover.starts_at)} to ${formatDateTime(changes.data.cover.revoked_at ?? changes.data.cover.ends_at)}`}
        >
          {changes.data.cover.return_note ? (
            <p className="mb-3 rounded-md bg-surface-2 px-3 py-2 text-sm text-text">
              <span className="font-medium">Note back: </span>
              <span className="whitespace-pre-line">{changes.data.cover.return_note}</span>
            </p>
          ) : null}
          {changes.data.events.length === 0 ? (
            <EmptyState size="compact" message="Nothing was recorded on these clients' timelines during the cover." />
          ) : (
            <ol className="flex flex-col divide-y divide-border/70">
              {changes.data.events.map((e) => (
                <li key={e.id} className="flex flex-col gap-0.5 py-2 first:pt-0 last:pb-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                  <span className="min-w-0 text-base text-text">
                    {e.client_id ? (
                      <Link href={`/clients/${e.client_id}?tab=timeline`} className="font-medium hover:underline">
                        {e.client_name ?? "Client"}
                      </Link>
                    ) : null}
                    {e.client_id ? ": " : ""}
                    {e.title}
                  </span>
                  <span className="num flex-none text-sm text-text-muted">
                    {e.performed_by_name ? `${e.performed_by_name} · ` : ""}
                    {formatDateTime(e.created_at)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </SectionCard>
      ) : changes && !changes.ok ? (
        <BlockError what="what changed during the cover" errorRef={changes.ref} />
      ) : null}

      {!work.ok ? (
        <BlockError what="their work" errorRef={work.ref} />
      ) : (
        <>
          <KpiStrip
            aria-label="Open work"
            items={[
              { label: "Open tasks", value: person.open_tasks, sub: "assigned and not filed" },
              { label: "To review", value: person.review_tasks, sub: "as the named reviewer" },
              { label: "Clients", value: work.data.clientTotal, sub: "owner or on the team" },
              {
                label: "Covering now",
                value: covers.ok ? covers.data.holding.filter((c) => c.state === "in_force").length : "—",
                sub: covers.ok && covers.data.forThem.some((c) => c.state === "in_force") ? `${name === "You" ? "You are" : `${name} is`} covered too` : "covers held",
              },
            ]}
          />
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <SectionCard title="Open tasks" viewAll={person.open_tasks > work.data.assigned.length ? { href: `/work?assignee=${person.id}`, label: `View all ${person.open_tasks}` } : undefined} flush>
              <TaskList tasks={work.data.assigned} empty={self ? "You have no open tasks." : `${person.full_name} has no open tasks.`} />
            </SectionCard>
            <SectionCard title="Review items" viewAll={person.review_tasks > work.data.reviewing.length ? { href: `/work?view=review&reviewer=${person.id}`, label: `View all ${person.review_tasks}` } : undefined} flush>
              <TaskList tasks={work.data.reviewing} empty="Nothing waiting for review." />
            </SectionCard>
            <SectionCard title="Clients" description="Owned, or on the engagement team" flush>
              {work.data.clients.length === 0 ? (
                <div className="px-4 pb-4 md:px-5">
                  <EmptyState size="compact" icon={<BriefcaseBusinessIcon />} message="Not on any client yet." />
                </div>
              ) : (
                <ul className="divide-y divide-border/70 border-t border-border/70">
                  {work.data.clients.map((c) => (
                    <li key={c.id} className="flex min-h-11 items-center justify-between gap-3 px-4 py-2 md:px-5">
                      <span className="min-w-0">
                        <Link href={`/clients/${c.id}`} className="block truncate text-base text-text hover:underline">
                          {c.display_name}
                        </Link>
                        <span className="text-xs text-text-muted">
                          {c.client_code} · {c.relation === "owner" ? "Owner" : "On the team"}
                        </span>
                      </span>
                      <span className="num flex-none text-sm text-text-muted">{c.open_tasks} open</span>
                    </li>
                  ))}
                  {work.data.clientTotal > work.data.clients.length ? (
                    <li className="px-4 py-2 text-sm text-text-muted md:px-5">and {work.data.clientTotal - work.data.clients.length} more</li>
                  ) : null}
                </ul>
              )}
            </SectionCard>
            <SectionCard title="Covers" description="Covers they hold, and covers for their clients">
              {!covers.ok ? (
                <ErrorBlock message="Couldn't load the covers." errorRef={covers.ref} size="compact" />
              ) : (
                <div className="flex flex-col gap-4">
                  <div>
                    <h3 className="mb-2 text-sm font-medium text-text-muted">{self ? "You're covering" : `${person.full_name.split(" ")[0]} is covering`}</h3>
                    <CoverList covers={covers.data.holding} viewer={viewerShape} emptyText="No covers in the last 60 days." autoReturnNoteFor={returnNoteId} />
                  </div>
                  <div>
                    <h3 className="mb-2 text-sm font-medium text-text-muted">{self ? "Covering for you" : `Covering for ${person.full_name.split(" ")[0]}`}</h3>
                    <CoverList covers={covers.data.forThem} viewer={viewerShape} emptyText="Nobody has covered for them in the last 60 days." />
                  </div>
                </div>
              )}
            </SectionCard>
          </div>
        </>
      )}
    </div>
  )
}

function TaskList({ tasks, empty }: { tasks: Awaited<ReturnType<typeof getPersonWork>>["assigned"]; empty: string }) {
  if (tasks.length === 0)
    return (
      <div className="px-4 pb-4 md:px-5">
        <EmptyState size="compact" message={empty} />
      </div>
    )
  return (
    <ul className="divide-y divide-border/70 border-t border-border/70">
      {tasks.map((t) => (
        <li key={t.id} className="flex min-h-11 items-center justify-between gap-3 px-4 py-2 md:px-5">
          <span className="min-w-0">
            <Link href={`/work/${t.id}`} className="block truncate text-base text-text hover:underline">
              {t.title}
            </Link>
            <span className="block truncate text-xs text-text-muted">
              {t.task_number}
              {t.client_name ? ` · ${t.client_name}` : ""}
              {t.acceptance_status === "pending" ? " · waiting for acceptance" : ""}
            </span>
          </span>
          <span className="flex flex-none flex-col items-end gap-0.5">
            <StatusChip kind="task_status" value={t.status} />
            {t.due_date ? <DateText date={t.due_date} withRelative className="text-xs" /> : null}
          </span>
        </li>
      ))}
    </ul>
  )
}
