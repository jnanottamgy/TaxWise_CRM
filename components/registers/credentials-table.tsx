"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { ExternalLinkIcon, HistoryIcon, KeyRoundIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import type { SortDir } from "@/components/app/data-table/params"
import { EmptyState } from "@/components/app/empty-state"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { CopyButton } from "@/components/app/copy-button"
import { DateText } from "@/components/app/date-text"
import { Button } from "@/components/ui/button"
import { EMPTY } from "@/lib/format"
import { portalName } from "@/lib/schemas/registers"
import type { CredentialRow } from "@/lib/data/registers"
import { deleteCredential } from "@/server/actions/credentials"
import { RevealPassword } from "@/components/registers/reveal-password"
import { CreateCredentialDialog, EditCredentialDialog } from "@/components/registers/credential-dialog"
import { CredentialTrailSheet } from "@/components/registers/credential-trail-sheet"
import { RowMenu, toastResult } from "@/components/registers/shared"

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "")
  } catch {
    return url
  }
}

/**
 * The portal credentials vault (§7.15.1): client, portal, username, the password behind Reveal (30
 * seconds, logged), the login page, and (Partners and Managers) when it was last revealed. Partners
 * and Managers add, change and delete logins and open each one's access trail. The ciphertext never
 * reaches the browser; the list never carries a password.
 */
export function CredentialsTable(props: {
  rows: CredentialRow[]
  total: number
  page: number
  pageSize: number
  sort: string | null
  dir: SortDir
  canManage: boolean
  showClient?: boolean
  /** On Client 360: the client, for the empty state's Add button. */
  fixedClient?: { id: string; name: string } | null
  /** A fixed list on Client 360: no sorting. */
  compact?: boolean
}) {
  const { rows, canManage, showClient = true, fixedClient = null, compact = false } = props
  const router = useRouter()
  const [dialog, setDialog] = React.useState<{ kind: "edit" | "trail" | "delete"; row: CredentialRow } | null>(null)
  const [adding, setAdding] = React.useState(false)

  const columns = React.useMemo<DataTableColumn<CredentialRow>[]>(() => {
    const cols: DataTableColumn<CredentialRow>[] = []
    if (showClient) {
      cols.push({
        id: "client_name",
        header: "Client",
        sortable: !compact,
        hideable: false,
        mobile: "primary",
        width: "24%",
        cell: (r) => (
          <span className="inline-flex min-w-0 flex-col leading-5" title={`${r.client_code} · ${r.client_name}`}>
            <span className="truncate">{r.client_name}</span>
            <span className="text-xs text-text-muted">{r.client_code}</span>
          </span>
        ),
        // On a phone the portal leads the second line ("GST · a_gst_login"), so a long client name
        // can truncate without hiding which portal the login is for.
        mobileCell: (r) => r.client_name,
      })
    }
    cols.push(
      {
        id: "portal",
        header: "Portal",
        sortable: !compact,
        hideable: false,
        mobile: showClient ? "secondary" : "primary",
        cell: (r) => <span className="font-medium text-text">{portalName(r.portal, r.portal_label)}</span>,
      },
      {
        id: "username",
        header: "Username",
        sortable: !compact,
        mobile: "secondary",
        cell: (r) => (
          <span className="inline-flex max-w-[16rem] items-center gap-1">
            <span className="truncate font-mono text-sm">{r.username}</span>
            <CopyButton value={r.username} label="username" />
          </span>
        ),
        mobileCell: (r) => <span className="font-mono">{r.username}</span>,
      },
      {
        id: "password",
        header: "Password",
        mobile: "trailing",
        cell: (r) => <RevealPassword credentialId={r.id} canReveal={r.can_reveal} portalName={portalName(r.portal, r.portal_label)} />,
      },
      {
        id: "login_url",
        header: "Login page",
        hideBelow: "lg",
        cell: (r) =>
          r.login_url ? (
            <a href={r.login_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-primary hover:underline" onClick={(e) => e.stopPropagation()}>
              {hostOf(r.login_url)}
              <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          ) : (
            <span className="text-text-muted">{EMPTY}</span>
          ),
      },
    )
    if (canManage) {
      cols.push({
        id: "last_viewed_at",
        header: "Last revealed",
        sortable: !compact,
        align: "right",
        hideBelow: "xl",
        cell: (r) =>
          r.last_viewed_at ? (
            <span className="inline-flex flex-col items-end leading-5">
              <DateText date={r.last_viewed_at} />
              <span className="text-xs text-text-muted">
                {r.view_count ?? 0} {r.view_count === 1 ? "time" : "times"}
              </span>
            </span>
          ) : (
            <span className="text-text-muted">Never</span>
          ),
      })
    }
    cols.push({
      id: "updated_at",
      header: "Changed",
      sortable: !compact,
      align: "right",
      hideBelow: "2xl",
      cell: (r) => (
        <span className="inline-flex flex-col items-end leading-5">
          <DateText date={r.updated_at} />
          {r.updated_by_name ? <span className="text-xs text-text-muted">{r.updated_by_name}</span> : null}
        </span>
      ),
    })
    if (canManage) {
      cols.push({
        id: "actions",
        header: "Actions",
        align: "right",
        hideable: false,
        mobile: "trailing",
        width: "3.5rem",
        cell: (r) => (
          <RowMenu
            label={`Actions for the ${portalName(r.portal, r.portal_label)} login of ${r.client_name}`}
            items={[
              { key: "trail", label: "Access trail", icon: <HistoryIcon aria-hidden="true" />, onSelect: () => setDialog({ kind: "trail", row: r }) },
              { key: "edit", label: "Edit login", icon: <PencilIcon aria-hidden="true" />, onSelect: () => setDialog({ kind: "edit", row: r }) },
              { key: "delete", label: "Delete login", icon: <Trash2Icon aria-hidden="true" />, onSelect: () => setDialog({ kind: "delete", row: r }), danger: true },
            ]}
          />
        ),
      })
    }
    return cols
  }, [showClient, canManage, compact])

  const d = dialog
  return (
    <>
      <DataTable
        id={showClient ? "register-vault" : "client-vault"}
        caption="Portal credentials"
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        total={props.total}
        page={props.page}
        pageSize={props.pageSize}
        sort={props.sort}
        dir={props.dir}
        defaultSort={{ sort: "client_name", dir: "asc" }}
        countLabel={(n, t) => `${n} stored ${t === 1 ? "login" : "logins"}`}
        columnChooser={!compact}
        maxHeight={compact ? "none" : "viewport"}
        empty={
          <EmptyState
            icon={<KeyRoundIcon />}
            message={fixedClient ? "No portal logins stored for this client yet." : "No portal logins stored yet. Store a client's GST, Income Tax or TRACES login to keep it encrypted and logged."}
            action={
              canManage && !compact ? (
                <Button onClick={() => setAdding(true)}>
                  <PlusIcon aria-hidden="true" />
                  Add a login
                </Button>
              ) : undefined
            }
          />
        }
      />
      {canManage ? <CreateCredentialDialog open={adding} onOpenChange={setAdding} fixedClient={fixedClient} /> : null}
      {d?.kind === "edit" ? <EditCredentialDialog key={d.row.id} open onOpenChange={(o) => !o && setDialog(null)} row={d.row} /> : null}
      {d?.kind === "trail" ? (
        <CredentialTrailSheet open onOpenChange={(o) => !o && setDialog(null)} credentialId={d.row.id} title={`${portalName(d.row.portal, d.row.portal_label)} · ${d.row.username} · ${d.row.client_name}`} />
      ) : null}
      <ConfirmDialog
        open={d?.kind === "delete"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={d ? `Delete the ${portalName(d.row.portal, d.row.portal_label)} login of ${d.row.client_name}?` : "Delete this login?"}
        description="The stored username and password are removed from the vault and can't be recovered. The access trail stays in the audit log."
        confirmLabel="Delete login"
        destructive
        onConfirm={async () => {
          if (!d) return
          const r = await deleteCredential({ id: d.row.id, updatedAt: d.row.updated_at })
          if (!toastResult(r, "Login deleted")) return false
          setDialog(null)
          router.refresh()
        }}
      />
    </>
  )
}

/** The page header's "Add a login" (Partners and Managers). */
export function AddCredentialButton({ fixedClient, variant = "default" }: { fixedClient?: { id: string; name: string } | null; variant?: "default" | "outline" }) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)}>
        <PlusIcon aria-hidden="true" />
        Add a login
      </Button>
      <CreateCredentialDialog open={open} onOpenChange={setOpen} fixedClient={fixedClient} />
    </>
  )
}
