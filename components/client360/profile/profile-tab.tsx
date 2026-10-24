import { Suspense } from "react"
import { unstable_rethrow } from "next/navigation"
import { SectionCard } from "@/components/app/section-card"
import { DefinitionList } from "@/components/app/definition-list"
import { StatusChip } from "@/components/app/status-chip"
import { PriorityChip } from "@/components/app/priority-chip"
import { MonoId } from "@/components/app/mono-id"
import { DateText } from "@/components/app/date-text"
import { Money } from "@/components/app/money"
import { ErrorBlock } from "@/components/app/error-block"
import { Skeleton } from "@/components/ui/skeleton"
import { can } from "@/lib/auth/roles"
import type { CurrentUser } from "@/lib/auth/current-user"
import type { ServerSupabase } from "@/lib/supabase/server"
import { env } from "@/lib/env"
import { logUnexpected } from "@/lib/log"
import { ENTITY_TYPE_LABELS, GST_REGISTRATION_LABELS, GST_SCHEME_LABELS, TEAM_ROLE_LABELS } from "@/lib/domain/enums"
import { stateName, maskAadhaarLast4 } from "@/lib/domain/india-validators"
import { todayIST } from "@/lib/domain/fy"
import { resolveScaleParams } from "@/lib/domain/scale"
import { formatDate } from "@/lib/format"
import { listGroupOptions, listStaffOptions, loadScaleParameterRows, type MessagingContext } from "@/lib/data/clients"
import { getKycDocumentOptions, getProfileNames, type Client360 } from "@/lib/data/client360"
import { KYC_CATEGORY_LABELS, PRINCIPAL_ROLES, engagementTypeLabel, readEngagementTypes, kycCategoryFor, readPrincipalPersons, principalPersonsLabel, type SaveKycInput } from "@/lib/schemas/client-kyc"
import { MONTH_NAMES, incomeNatureLabel, masterDataDefaults } from "@/components/client360/logic/master-data"
import { teamPickFrom } from "@/components/client360/logic/team"
import { MasterDataActions } from "@/components/client360/profile/master-data-actions"
import { ContactsSection } from "@/components/client360/profile/contacts-section"
import { TeamEditButton } from "@/components/client360/profile/team-dialog"
import { GroupSection } from "@/components/client360/profile/group-section"
import { KycActions } from "@/components/client360/profile/kyc-actions"
import ClientTeamCovers from "@/components/covers/client-team-covers"

/**
 * Client 360 → Profile & contacts (§7.3.3 tab 2): master data (edit form = the wizard's step 1
 * fields), contacts (exactly one primary), the team with cover access (§4.7), the group (§7.4) and
 * KYC (§6.8). Partners and Managers edit; Employees read, and edit the notes. Never throws.
 */
export async function ProfileTab({ data, user, supabase, messaging }: { data: Client360; user: CurrentUser; supabase: ServerSupabase; messaging: MessagingContext }) {
  const { client, contacts, team, kyc, kycCheck } = data
  const manage = can.editClients(user.role)

  let loaded: {
    staff: Awaited<ReturnType<typeof listStaffOptions>>
    groups: Awaited<ReturnType<typeof listGroupOptions>>
    documents: Awaited<ReturnType<typeof getKycDocumentOptions>>
    names: Map<string, string>
    qrmpMaxTurnoverPaise: number
    fsTitle: string | null
  }
  try {
    const [staff, groups, documents, names, params, fs] = await Promise.all([
      manage ? listStaffOptions(supabase, user.role) : Promise.resolve([]),
      manage ? listGroupOptions(supabase) : Promise.resolve([]),
      manage ? getKycDocumentOptions(supabase, client.id) : Promise.resolve([]),
      getProfileNames(supabase, [kyc?.verified_by]),
      manage ? loadScaleParameterRows(supabase) : Promise.resolve([]),
      kyc?.last_audited_fs_document_id
        ? supabase.from("documents").select("title").eq("id", kyc.last_audited_fs_document_id).is("deleted_at", null).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ])
    if (fs.error) throw fs.error
    loaded = {
      staff,
      groups,
      documents,
      names,
      qrmpMaxTurnoverPaise: resolveScaleParams(params, todayIST()).qrmpMaxTurnoverPaise,
      fsTitle: (fs.data as { title: string } | null)?.title ?? null,
    }
  } catch (err) {
    unstable_rethrow(err)
    const ref = logUnexpected(err, { source: "client360:profile", userId: user.id, role: user.role, clientId: client.id })
    return (
      <div className="rounded-lg border border-border bg-surface">
        <ErrorBlock message="Couldn't load this client's profile." errorRef={ref} />
      </div>
    )
  }

  const portalLink = `${env.appUrl().replace(/\/+$/, "")}/portal`
  const persons = readPrincipalPersons(kyc?.principal_persons ?? null)
  const category = kyc?.entity_category ?? kycCategoryFor(client.entity_type)
  const kycDefaults: SaveKycInput = {
    clientId: client.id,
    updatedAt: kyc?.updated_at ?? null,
    entityCategory: category,
    pan: kyc?.pan ?? client.pan ?? "",
    cinLlpin: kyc?.cin_llpin ?? "",
    businessDescription: kyc?.business_description ?? "",
    registeredAddress: kyc?.registered_address ?? client.address ?? "",
    lastAuditedFsDocumentId: kyc?.last_audited_fs_document_id ?? null,
    engagementTypes: readEngagementTypes(kyc?.engagement_types),
    principalPersons: persons.map((p) => ({
      name: p.name ?? "",
      // A role the list doesn't know (written elsewhere) is shown as Other rather than lost silently.
      role: p.role ? ((PRINCIPAL_ROLES as readonly string[]).includes(p.role) ? (p.role as (typeof PRINCIPAL_ROLES)[number]) : "Other") : "",
      address: p.address ?? "",
      pan: p.pan ?? "",
      din: p.din ?? "",
      aadhaarLast4: p.aadhaarLast4 ?? "",
    })),
    nextReviewOn: kyc?.next_review_on ?? "",
  }
  const kycState = !kyc
    ? { label: "Not started", tone: "muted" as const, meaning: "No KYC record yet. Audit and certification work can't move past acceptance until it is complete." }
    : !kycCheck?.complete
      ? { label: "Incomplete", tone: "warning" as const, meaning: "Some details the KYC Norms ask for are missing. Audit and certification work can't move past acceptance until they are filled in." }
      : kycCheck.reviewDue
        ? { label: "Review due", tone: "warning" as const, meaning: "KYC is re-confirmed every year, and this one is due. Check the details and mark it verified again." }
        : { label: "Complete", tone: "success" as const, meaning: "Complete and verified within the year." }
  const owner = teamPickFrom(client.owner_employee_id, team)
  const byRole = (role: "engagement_partner" | "review_manager" | "preparer") => team.filter((t) => t.team_role === role).map((t) => t.name)

  return (
    <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-4">
        <SectionCard
          id="master-data"
          title="Master data"
          description={client.updated_by_name ? `Last changed by ${client.updated_by_name} on ${formatDate(client.updated_at)}` : `Last changed on ${formatDate(client.updated_at)}`}
          action={<MasterDataActions canEdit={manage} defaults={masterDataDefaults(client)} clientName={client.display_name} qrmpMaxTurnoverPaise={loaded.qrmpMaxTurnoverPaise} notes={client.notes} />}
        >
          <div className="flex flex-col gap-4">
            <Group title="Identity">
              <DefinitionList
                items={[
                  { term: "Display name", value: client.display_name },
                  { term: "Legal name", value: client.legal_name },
                  { term: "Client code", value: <MonoId value={client.client_code} copy label="client code" /> },
                  { term: "Entity type", value: client.entity_type ? (client.entity_type === "other" ? client.entity_type_other : ENTITY_TYPE_LABELS[client.entity_type]) : null },
                  {
                    term: client.entity_type === "individual" || client.entity_type === "proprietorship" ? "Date of birth" : "Incorporated on",
                    value: client.date_of_birth_or_incorporation ? <DateText date={client.date_of_birth_or_incorporation} /> : client.is_incorporated ? null : "Not yet incorporated",
                  },
                  { term: "Priority", value: <PriorityChip kind="client_priority" value={client.priority} /> },
                ]}
              />
            </Group>
            <Group title="Tax registrations">
              <DefinitionList
                items={[
                  { term: "PAN", value: <MonoId value={client.pan} copy label="PAN" /> },
                  { term: "GST registration", value: GST_REGISTRATION_LABELS[client.gst_registration] },
                  { term: "GSTIN", value: client.gstin ? <MonoId value={client.gstin} copy label="GSTIN" /> : null },
                  { term: "State (place of supply)", value: client.state_code ? `${stateName(client.state_code) ?? client.state_code} (${client.state_code})` : null },
                  { term: "TAN", value: client.tan ? <MonoId value={client.tan} copy label="TAN" /> : null },
                ]}
              />
            </Group>
            <Group title="Contact">
              <DefinitionList
                items={[
                  { term: "Email", value: client.email },
                  { term: "Phone", value: client.phone ? <span className="num tabular-nums">{client.phone}</span> : null },
                  { term: "WhatsApp", value: client.whatsapp ? <span className="num tabular-nums">{client.whatsapp}</span> : null },
                  { term: "Address", value: [client.address, client.city, client.pincode].filter(Boolean).join(", ") || null },
                ]}
              />
            </Group>
            <Group title="Scale">
              <DefinitionList
                items={[
                  { term: "Financial year ends in", value: MONTH_NAMES[client.fy_end_month - 1] ?? null },
                  { term: "Annual turnover", value: client.annual_turnover !== null ? <Money value={client.annual_turnover} /> : null },
                  { term: "Turnover for FY", value: client.turnover_fy ? `FY ${client.turnover_fy}` : null },
                  { term: "GST filing scheme", value: client.gst_registration === "registered" ? (client.gst_scheme ? GST_SCHEME_LABELS[client.gst_scheme] : "Auto from turnover") : null },
                  { term: "Income is earned from", value: incomeNatureLabel(client.income_nature) },
                ]}
              />
            </Group>
            <Group title="Notes">
              {client.notes ? <p className="text-base whitespace-pre-line text-text">{client.notes}</p> : <p className="text-sm text-text-muted">No notes.</p>}
            </Group>
          </div>
        </SectionCard>

        <SectionCard
          id="kyc"
          title="KYC"
          description="ICAI KYC Norms: complete before audit or certification work moves past acceptance; re-confirmed every year"
          action={
            manage ? (
              <KycActions
                clientId={client.id}
                clientName={client.display_name}
                entityType={client.entity_type}
                defaults={kycDefaults}
                documents={loaded.documents.map((d) => ({ id: d.id, label: d.title, description: [d.financial_year ? `FY ${d.financial_year}` : null, formatDate(d.created_at)].filter(Boolean).join(" · ") }))}
                complete={!!kycCheck?.complete}
                updatedAt={kyc?.updated_at ?? null}
                verified={!!kyc?.verified_on}
              />
            ) : undefined
          }
        >
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <StatusChip label={kycState.label} tone={kycState.tone} meaning={kycState.meaning} variant="pill" className="self-start" />
              {kyc && kycCheck && !kycCheck.complete ? <p className="text-sm text-text-muted">Missing: {kycCheck.missing.join(", ")}.</p> : null}
            </div>
            {kyc ? (
              <>
                <DefinitionList
                  items={[
                    { term: "Category", value: KYC_CATEGORY_LABELS[kyc.entity_category] },
                    { term: "PAN", value: kyc.pan ? <MonoId value={kyc.pan} copy label="PAN" /> : null },
                    ...(kyc.entity_category === "corporate" ? [{ term: client.entity_type === "llp" ? "LLPIN" : "CIN", value: kyc.cin_llpin ? <MonoId value={kyc.cin_llpin} copy label="CIN" /> : null }] : []),
                    { term: "Business", value: kyc.business_description },
                    { term: "Registered address", value: kyc.registered_address },
                    { term: "Last audited financial statements", value: loaded.fsTitle },
                    { term: "Engagement types", value: kyc.engagement_types?.length ? kyc.engagement_types.map(engagementTypeLabel).join(", ") : null },
                    {
                      term: "Verified",
                      value: kyc.verified_on ? `${formatDate(kyc.verified_on)}${kyc.verified_by && loaded.names.get(kyc.verified_by) ? ` by ${loaded.names.get(kyc.verified_by)}` : ""}` : "Not verified yet",
                    },
                    { term: "Next review", value: kyc.next_review_on ? <DateText date={kyc.next_review_on} withRelative /> : null },
                  ]}
                />
                <div className="flex flex-col gap-2">
                  <h3 className="text-sm font-medium text-text">{principalPersonsLabel(kyc.entity_category, client.entity_type)}</h3>
                  {persons.length === 0 ? (
                    <p className="text-sm text-text-muted">No one recorded.</p>
                  ) : (
                    <ul className="divide-y divide-border/70 rounded-md border border-border">
                      {persons.map((p, i) => (
                        <li key={i} className="flex flex-col gap-0.5 px-3 py-2">
                          <p className="text-base text-text">
                            {p.name}
                            {p.role ? <span className="text-sm text-text-muted"> · {p.role}</span> : null}
                          </p>
                          <p className="flex flex-wrap gap-x-4 text-sm text-text-muted">
                            {p.pan ? <span>PAN <span className="font-mono text-text">{p.pan}</span></span> : null}
                            {p.din ? <span>DIN <span className="font-mono text-text">{p.din}</span></span> : null}
                            {p.aadhaarLast4 ? <span>Aadhaar <span className="font-mono text-text">{maskAadhaarLast4(p.aadhaarLast4)}</span></span> : null}
                          </p>
                          {p.address ? <p className="text-sm text-text-muted">{p.address}</p> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            ) : (
              <p className="text-sm text-text-muted">{manage ? "Start the KYC record for this client: required for audit and certification work." : "No KYC record yet. A Manager or Partner fills it in."}</p>
            )}
          </div>
        </SectionCard>
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        <ContactsSection
          clientId={client.id}
          clientName={client.display_name}
          contacts={contacts}
          canManage={manage}
          messaging={{
            firmName: messaging.firmName,
            firmPhone: messaging.firmPhone,
            senderName: messaging.senderName,
            countryCode: messaging.countryCode,
            signatureFormat: messaging.signatureFormat,
            addSignature: messaging.addSignature,
            portalLink,
            clientCode: client.client_code,
            templates: messaging.templates.map((t) => ({ id: t.id, name: t.name, body: t.body, channel: t.channel })),
          }}
        />

        <SectionCard
          id="team"
          title="Team"
          description="Who works on this client; Employees see only the clients they are on or covering"
          action={
            manage ? (
              <TeamEditButton
                clientId={client.id}
                clientName={client.display_name}
                signature={data.teamSignature}
                current={owner}
                staff={loaded.staff.map((s) => ({ id: s.id, name: s.name, role: s.role, designation: s.designation }))}
              />
            ) : undefined
          }
        >
          <div className="flex flex-col gap-4">
            <DefinitionList
              items={[
                { term: "Client owner", value: client.owner_name },
                { term: TEAM_ROLE_LABELS.engagement_partner, value: byRole("engagement_partner").join(", ") || null },
                { term: TEAM_ROLE_LABELS.review_manager, value: byRole("review_manager").join(", ") || null },
                { term: "Preparers", value: byRole("preparer").join(", ") || null },
              ]}
            />
            <div className="border-t border-border pt-4">
              <Suspense fallback={<CoversSkeleton />}>
                <ClientTeamCovers clientId={client.id} user={user} supabase={supabase} />
              </Suspense>
            </div>
          </div>
        </SectionCard>

        <GroupSection
          clientId={client.id}
          clientName={client.display_name}
          updatedAt={client.updated_at}
          group={client.group_id && client.group_name ? { id: client.group_id, name: client.group_name } : null}
          groups={loaded.groups}
          canManage={manage}
        />
      </div>
    </div>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-sm font-medium text-text-muted">{title}</h3>
      {children}
    </section>
  )
}

function CoversSkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col gap-2">
      <div className="text-base font-semibold text-text">Cover access</div>
      <Skeleton className="h-4 w-64 max-w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  )
}
