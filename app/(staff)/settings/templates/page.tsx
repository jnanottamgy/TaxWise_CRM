import type { Metadata } from "next"
import Link from "next/link"
import { requirePartner } from "@/lib/auth/guards"
import { TEMPLATE_TYPE_LABELS } from "@/lib/schemas/message-templates"
import { formatCount } from "@/components/app/data-table/params"
import { SectionCard } from "@/components/app/section-card"
import { ErrorBlock } from "@/components/app/error-block"
import { loadSection, SectionHeader } from "@/components/settings/settings-page"

export const metadata: Metadata = { title: "Templates · Settings" }

type Count = { total: number; active: number }

function Figures({ items }: { items: Array<{ label: string; value: number; href: string }> }) {
  return (
    <dl className="grid grid-cols-2 divide-x divide-border border-t border-border">
      {items.map((f) => (
        <div key={f.label} className="min-w-0">
          <Link
            href={f.href}
            className="block px-4 py-3 transition-colors duration-150 hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring md:px-5"
          >
            <dt className="text-sm text-text-muted">{f.label}</dt>
            <dd className="num mt-0.5 text-xl leading-8 font-semibold text-text">{formatCount(f.value)}</dd>
          </Link>
        </div>
      ))}
    </dl>
  )
}

/**
 * Settings → Templates (§7.21 "Job templates and message templates (also reachable from
 * Practice)"): where each kind is kept, with how many are in use, opening the two template pages
 * (/templates/jobs, /templates/messages) where they are edited. Partners only, like the other firm
 * sections; Managers reach the same pages from Practice in the sidebar.
 */
export default async function TemplatesSettingsPage() {
  const { supabase } = await requirePartner()
  const count = (table: "job_templates" | "message_templates") =>
    loadSection(`templates:${table}`, async (): Promise<Count> => {
      const [all, active] = await Promise.all([
        supabase.from(table).select("id", { count: "exact", head: true }),
        supabase.from(table).select("id", { count: "exact", head: true }).eq("is_active", true),
      ])
      if (all.error) throw all.error
      if (active.error) throw active.error
      return { total: all.count ?? 0, active: active.count ?? 0 }
    })
  const [jobs, messages] = await Promise.all([count("job_templates"), count("message_templates")])
  const types = Object.values(TEMPLATE_TYPE_LABELS)

  return (
    <div className="flex min-w-0 flex-col gap-4 md:gap-5">
      <SectionHeader title="Templates" description="The standard jobs tasks are created from, and the wording of reminders and updates to clients." />

      <SectionCard
        title="Job templates"
        description="Checklists with offset days, used to create tasks and recurring work."
        viewAll={{ href: "/templates/jobs", label: "Open job templates" }}
        flush
      >
        {jobs.ok ? (
          <Figures
            items={[
              { label: "Active", value: jobs.data.active, href: "/templates/jobs" },
              { label: "Inactive", value: jobs.data.total - jobs.data.active, href: "/templates/jobs?state=inactive" },
            ]}
          />
        ) : (
          <ErrorBlock message="Couldn't load the job templates." errorRef={jobs.ref} size="compact" />
        )}
      </SectionCard>

      <SectionCard
        title="Message templates"
        description={`WhatsApp and portal wording, with variables filled in when sent: ${types.slice(0, -1).join(", ").toLowerCase()} and ${types[types.length - 1].toLowerCase()}.`}
        viewAll={{ href: "/templates/messages", label: "Open message templates" }}
        flush
      >
        {messages.ok ? (
          <Figures
            items={[
              { label: "Active", value: messages.data.active, href: "/templates/messages?state=active" },
              { label: "Inactive", value: messages.data.total - messages.data.active, href: "/templates/messages?state=inactive" },
            ]}
          />
        ) : (
          <ErrorBlock message="Couldn't load the message templates." errorRef={messages.ref} size="compact" />
        )}
      </SectionCard>
    </div>
  )
}
