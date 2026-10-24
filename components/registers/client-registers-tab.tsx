import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { ArrowUpRightIcon } from "lucide-react"
import type { ClientTabProps } from "@/components/client360/types"
import { isManagerOrPartner, isPartner } from "@/lib/auth/roles"
import { logUnexpected } from "@/lib/log"
import { todayIST } from "@/lib/domain/fy"
import { formatCount, parseTableParams } from "@/components/app/data-table/params"
import { ErrorBlock } from "@/components/app/error-block"
import { REGISTER_TAB_LABEL, registersHref, type RegisterTab } from "@/lib/schemas/registers"
import { getClientLabel, listCredentials, listDscs, listFilings, listRegistrations, listSigningMembers, listUdins } from "@/lib/data/registers"
import { AddCredentialButton, CredentialsTable } from "@/components/registers/credentials-table"
import { RegistrationsTable } from "@/components/registers/registrations-table"
import { AddRegistrationButton } from "@/components/registers/registration-dialog"
import { DscTable } from "@/components/registers/dsc-table"
import { AddDscButton } from "@/components/registers/dsc-dialog"
import { UdinTable } from "@/components/registers/udin-table"
import { LogUdinButton } from "@/components/registers/udin-dialog"
import { FilingsTable } from "@/components/registers/filings-table"
import { ImportFilingsDialog } from "@/components/registers/import-filings-dialog"

const LIMIT = 100

type Loaded<T> = { ok: true; data: T } | { ok: false; ref: string }

/** The client's own copy of a register: its title, the add action, and "Open in the register" when there is more. */
function Block({ id, title, description, total, shown, clientId, tab, action, children }: { id: string; title: string; description: string; total: number | null; shown: number; clientId: string; tab: RegisterTab; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`${id}-title`} className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 id={`${id}-title`} className="text-md leading-6 font-semibold text-text">
            {title}
          </h2>
          <p className="text-sm text-text-muted">{description}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {total !== null && total > shown ? (
            <Link href={registersHref(tab, { client: clientId })} className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
              All {formatCount(total)} in the register
              <ArrowUpRightIcon aria-hidden="true" className="size-3.5" />
            </Link>
          ) : (
            <Link href={registersHref(tab, { client: clientId })} className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text">
              Open in {REGISTER_TAB_LABEL[tab]}
              <ArrowUpRightIcon aria-hidden="true" className="size-3.5" />
            </Link>
          )}
          {action}
        </div>
      </div>
      {children}
    </section>
  )
}

function Failed({ what, errorRef }: { what: string; errorRef: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface">
      <ErrorBlock message={`Couldn't load ${what}.`} errorRef={errorRef} />
    </div>
  )
}

/**
 * Client 360 → Registers (§7.3.3, §7.15.1, §7.15.2): this client's stored portal logins (Reveal for
 * 30 seconds, logged), statutory registrations, DSCs, UDINs and filing history, with "Import prior
 * filings" for a client moving from another CA. Each block is the register narrowed to the client,
 * under the viewer's RLS: an Employee reads their own client's rows, logs a UDIN they signed, and
 * reveals a password only with Vault access (§4.1). Never throws: a block that fails shows its Ref.
 */
export default async function ClientRegistersTab({ clientId, user, supabase }: ClientTabProps) {
  const today = todayIST()
  const canManage = isManagerOrPartner(user.role)
  const partner = isPartner(user.role)
  const t = parseTableParams({}, { defaultSort: { sort: "client_name", dir: "asc" } })
  const one = { ...t, page: 1, pageSize: LIMIT as 100, from: 0, to: LIMIT - 1, filters: {} }

  const load = async <T,>(source: string, fn: () => Promise<T>): Promise<Loaded<T>> => {
    try {
      return { ok: true, data: await fn() }
    } catch (err) {
      unstable_rethrow(err)
      return { ok: false, ref: logUnexpected(err, { source: `client360:registers:${source}`, userId: user.id, role: user.role, clientId }) }
    }
  }

  const [client, creds, regs, dscs, udins, filings, members] = await Promise.all([
    load("client", () => getClientLabel(supabase, clientId)),
    load("vault", () => listCredentials(supabase, { ...one, sort: "portal" }, { clientId })),
    load("registrations", () => listRegistrations(supabase, { ...one, sort: "registration_type" }, { today, clientId })),
    load("dsc", () => listDscs(supabase, { ...one, sort: "expiry_date" }, { today, clientId })),
    load("udin", () => listUdins(supabase, { ...one, sort: "signed_on", dir: "desc" }, { clientId })),
    load("filings", () => listFilings(supabase, { ...one, sort: "filed_on", dir: "desc" }, { clientId })),
    load("members", () => listSigningMembers(supabase, user)),
  ])
  const fixed = client.ok && client.data ? { id: client.data.id, name: client.data.name } : { id: clientId, name: "this client" }
  const memberList = members.ok ? members.data : []

  return (
    <div className="flex flex-col gap-8">
      <Block
        id="client-vault"
        title="Portal credentials"
        description="GST, Income Tax, TRACES, MCA and other logins. Reveal shows a password for 30 seconds and logs it."
        total={creds.ok ? creds.data.total : null}
        shown={creds.ok ? creds.data.rows.length : 0}
        clientId={clientId}
        tab="vault"
        action={canManage ? <AddCredentialButton fixedClient={fixed} variant="outline" /> : undefined}
      >
        {creds.ok ? (
          <CredentialsTable rows={creds.data.rows} total={creds.data.rows.length} page={1} pageSize={LIMIT} sort={null} dir="asc" canManage={canManage} showClient={false} fixedClient={fixed} compact />
        ) : (
          <Failed what="this client's stored logins" errorRef={creds.ref} />
        )}
      </Block>

      <Block
        id="client-registrations"
        title="Registrations"
        description="Statutory registrations with their expiry reminders, and DIR-3 KYC Web for each DIN."
        total={regs.ok ? regs.data.total : null}
        shown={regs.ok ? regs.data.rows.length : 0}
        clientId={clientId}
        tab="registrations"
        action={canManage ? <AddRegistrationButton fixedClient={fixed} variant="outline" /> : undefined}
      >
        {regs.ok ? (
          <RegistrationsTable rows={regs.data.rows} total={regs.data.rows.length} page={1} pageSize={LIMIT} sort={null} dir="asc" today={today} canManage={canManage} showClient={false} fixedClient={fixed} compact />
        ) : (
          <Failed what="this client's registrations" errorRef={regs.ref} />
        )}
      </Block>

      <Block
        id="client-dsc"
        title="DSCs"
        description="Who holds each token and when it expires. Alerts go at 30, 15 and 7 days."
        total={dscs.ok ? dscs.data.total : null}
        shown={dscs.ok ? dscs.data.rows.length : 0}
        clientId={clientId}
        tab="dsc"
        action={canManage ? <AddDscButton fixedClient={fixed} variant="outline" /> : undefined}
      >
        {dscs.ok ? (
          <DscTable rows={dscs.data.rows} total={dscs.data.rows.length} page={1} pageSize={LIMIT} sort={null} dir="asc" today={today} canManage={canManage} showClient={false} fixedClient={fixed} compact />
        ) : (
          <Failed what="this client's DSCs" errorRef={dscs.ref} />
        )}
      </Block>

      <Block
        id="client-udin"
        title="UDINs"
        description="Reports and certificates signed for this client, with the signing partner and the linked filing or audit."
        total={udins.ok ? udins.data.total : null}
        shown={udins.ok ? udins.data.rows.length : 0}
        clientId={clientId}
        tab="udin"
        action={memberList.length ? <LogUdinButton members={memberList} isPartner={partner} fixedClient={fixed} variant="outline" /> : undefined}
      >
        {udins.ok ? (
          <UdinTable rows={udins.data.rows} total={udins.data.rows.length} page={1} pageSize={LIMIT} sort={null} dir="desc" canManage={canManage} isPartner={partner} members={memberList} showClient={false} fixedClient={fixed} compact />
        ) : (
          <Failed what="this client's UDINs" errorRef={udins.ref} />
        )}
      </Block>

      <Block
        id="client-filings"
        title="Filing history"
        description="What was filed for this client, by us or by a previous CA."
        total={filings.ok ? filings.data.total : null}
        shown={filings.ok ? filings.data.rows.length : 0}
        clientId={clientId}
        tab="filings"
        action={canManage ? <ImportFilingsDialog fixedClient={fixed} /> : undefined}
      >
        {filings.ok ? (
          <FilingsTable rows={filings.data.rows} total={filings.data.rows.length} page={1} pageSize={LIMIT} sort={null} dir="desc" canManage={canManage} showClient={false} fixedClient={fixed} compact />
        ) : (
          <Failed what="this client's filing history" errorRef={filings.ref} />
        )}
      </Block>
    </div>
  )
}
