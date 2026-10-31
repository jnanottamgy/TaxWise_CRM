import type { Metadata } from "next"
import { unstable_rethrow } from "next/navigation"
import { requireStaff } from "@/lib/auth/guards"
import { can } from "@/lib/auth/roles"
import { env } from "@/lib/env"
import { logUnexpected } from "@/lib/log"
import { formatNumber } from "@/lib/format"
import { parseTableParams, readParam } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { FilterBar } from "@/components/app/filter-bar"
import { ErrorBlock } from "@/components/app/error-block"
import { PageGuide } from "@/components/shell/page-slots"
import { readWhatsAppSignaturePreference } from "@/lib/schemas/profile"
import {
  TEMPLATE_CHANNELS,
  TEMPLATE_CHANNEL_LABELS,
  TEMPLATE_FILTERS,
  TEMPLATE_SORTABLE,
  TEMPLATE_TYPE_LABELS,
  previewValues,
  templateTypesFor,
} from "@/lib/schemas/message-templates"
import { countTemplatesByState, getTemplatePreviewContext, listMessageTemplates } from "@/lib/data/message-templates"
import { TemplatesTable } from "@/components/templates/templates-table"
import { NewTemplateButton, type TemplateEditorContext } from "@/components/templates/template-form"

export const metadata: Metadata = { title: "Message templates" }

type SearchParams = Record<string, string | string[] | undefined>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/templates/messages:${source}`, userId }) }
  }
}

/**
 * Message templates (§7.13.4): "What does each reminder say, and which ones are offered?" The
 * firm's wording for every type of message, with {{variables}} filled in per client when someone
 * drafts. Partners and Managers add, edit, copy, switch off and delete; Employees use them
 * (§4.1) and see only the active templates that aren't about money. Defaults for every type are
 * seeded (§16).
 */
export default async function MessageTemplatesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, supabase } = await requireStaff()
  const sp = await searchParams
  const canManage = can.manageTemplates(user.role)
  const t = parseTableParams(sp, { sortable: TEMPLATE_SORTABLE, defaultSort: { sort: "name", dir: "asc" }, filters: TEMPLATE_FILTERS })
  const openId = readParam(sp, "open")

  const [list, preview, tally] = await Promise.all([
    attempt("list", user.id, () => listMessageTemplates(supabase, user, t)),
    attempt("preview", user.id, () => getTemplatePreviewContext(supabase)),
    canManage ? attempt("tally", user.id, () => countTemplatesByState(supabase)) : Promise.resolve(null),
  ])

  const firm = preview.ok ? preview.data : { firmName: "TaxWise Consultants", firmPhone: null, signatureFormat: "– {first_name}" }
  const ctx: TemplateEditorContext = {
    role: user.role,
    values: previewValues({ firmName: firm.firmName, firmPhone: firm.firmPhone, senderName: user.fullName, portalLink: `${env.appUrl().replace(/\/+$/, "")}/portal` }),
    signature: readWhatsAppSignaturePreference(user.preferences, user.role) ? firm.signatureFormat : null,
    senderName: user.fullName,
  }
  const types = templateTypesFor(user.role)
  const description =
    tally && tally.ok
      ? `${formatNumber(tally.data.active)} active, ${formatNumber(tally.data.inactive)} switched off. Variables like {{client_name}} are filled in for each client when someone drafts a message.`
      : "The wording your team starts from. Variables like {{client_name}} are filled in for each client when someone drafts a message."

  return (
    <div className="flex min-w-0 flex-col">
      <PageGuide title="Message templates">
        <p>A template is the starting wording for a reminder or update. When someone drafts a WhatsApp or portal message, they pick a template and its variables are filled in for that client: {"{{contact_name}}"}, {"{{period}}"}, {"{{due_date}}"} and so on.</p>
        <p className="mt-2">Only the variables in the picker can be used; anything else is refused on save. The preview fills the template in for a sample client, with your own name as the sender.</p>
        <p className="mt-2">Payment reminders and quotations are seen by Partners and Managers only.</p>
      </PageGuide>
      <PageHeader title="Message templates" description={description} actions={canManage ? <NewTemplateButton ctx={ctx} /> : null} />
      <FilterBar
        searchLabel="Search templates"
        searchPlaceholder="Name, subject or wording"
        filters={[
          { id: "type", label: "Type", options: types.map((x) => ({ value: x, label: TEMPLATE_TYPE_LABELS[x] })) },
          { id: "channel", label: "Channel", options: TEMPLATE_CHANNELS.map((c) => ({ value: c, label: TEMPLATE_CHANNEL_LABELS[c] })) },
          ...(canManage ? [{ id: "state", label: "Status", multi: false, options: [{ value: "active", label: "Active" }, { value: "inactive", label: "Switched off" }] }] : []),
        ]}
      />
      {list.ok ? (
        <TemplatesTable
          rows={list.data.rows}
          total={list.data.total}
          page={t.page}
          pageSize={t.pageSize}
          sort={t.sort}
          dir={t.dir}
          canManage={canManage}
          ctx={ctx}
          initialOpenId={openId && UUID.test(openId) ? openId : null}
        />
      ) : (
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load the message templates." errorRef={list.ref} />
        </div>
      )}
    </div>
  )
}
