"use client"

import * as React from "react"
import { BellIcon, UsersIcon } from "lucide-react"
import { toast } from "sonner"
import { statusOptions } from "@/lib/status"
import { ok } from "@/lib/result"
import { Button } from "@/components/ui/button"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import { ColumnChooser } from "@/components/app/data-table/column-chooser"
import { ExportButton } from "@/components/app/data-table/export-button"
import type { SortDir } from "@/components/app/data-table/params"
import { FilterBar } from "@/components/app/filter-bar"
import { SavedViewsMenu } from "@/components/app/saved-views"
import { StatusChip } from "@/components/app/status-chip"
import { MonoId } from "@/components/app/mono-id"
import { Money } from "@/components/app/money"
import { DateText } from "@/components/app/date-text"
import { EmptyState } from "@/components/app/empty-state"
import { WhatsAppButton } from "@/components/app/messaging/whatsapp-button"
import { KIT_OWNERS, KIT_VIEWS, type KitClientRow } from "@/components/app/kit/sample-data"

const TODAY = "2026-10-22"

const kitWhatsAppUrl = (digits: string, text: string) => `https://wa.me/${digits}?text=${encodeURIComponent(text)}`

const columns: DataTableColumn<KitClientRow>[] = [
  { id: "name", header: "Client", cell: (r) => r.name, sortable: true, hideable: false, mobile: "primary", width: "26%" },
  { id: "code", header: "Code", cell: (r) => <MonoId value={r.code} copy label="client code" />, sortable: true, mobile: "secondary" },
  { id: "gstin", header: "GSTIN", cell: (r) => <MonoId value={r.gstin} copy label="GSTIN" />, hideBelow: "xl", defaultHidden: true },
  { id: "status", header: "Status", cell: (r) => <StatusChip kind="client_status" value={r.status} />, mobile: "trailing" },
  { id: "owner", header: "Assigned to", cell: (r) => <span className="text-text-muted">{r.owner}</span>, hideBelow: "lg", mobile: "secondary" },
  { id: "next_filing", header: "Next filing", cell: (r) => r.nextFiling, hideBelow: "lg" },
  {
    id: "next_due",
    header: "Due",
    align: "right",
    sortable: true,
    cell: (r) => <DateText date={r.nextDue} withRelative stacked today={TODAY} />,
    mobileCell: (r) => <DateText date={r.nextDue} withRelative today={TODAY} />,
    mobile: "secondary",
  },
  { id: "fee", header: "Monthly fee", align: "right", sortable: true, cell: (r) => <Money value={r.fee} />, defaultHidden: true },
  { id: "outstanding", header: "Outstanding", align: "right", sortable: true, cell: (r) => <Money value={r.outstanding} /> },
  {
    id: "whatsapp",
    header: "Message",
    align: "right",
    width: "4.5rem",
    cell: (r) => (
      <WhatsAppButton
        iconOnly
        variant="outline"
        recipientName={r.name}
        number={r.gstin ? `9198450${r.code.slice(-4).replace(/\D/g, "0")}1` : null}
        draft={`Hi, for your ${r.nextFiling} we still need your purchase invoices. You can upload them on the TaxWise portal.`}
        buildUrl={kitWhatsAppUrl}
      />
    ),
  },
]

export function KitTable(props: {
  rows: KitClientRow[]
  total: number
  page: number
  pageSize: number
  sort: string | null
  dir: SortDir
}) {
  return (
    <div>
      <FilterBar
        searchLabel="Search clients"
        searchPlaceholder="Name, code or GSTIN"
        filters={[
          { id: "status", label: "Status", options: statusOptions("client_status") },
          { id: "owner", label: "Assigned to", options: KIT_OWNERS.map((o) => ({ value: o, label: o })), multi: false },
        ]}
        savedViews={
          <SavedViewsMenu
            views={KIT_VIEWS}
            canShare
            onSave={async (name) => {
              toast.message(`The kit doesn't store views. “${name}” would be saved to saved_views.`)
              return ok(null)
            }}
          />
        }
        columns={<ColumnChooser tableId="kit-clients" columns={columns} />}
        exportSlot={
          <ExportButton
            onExport={async () => {
              await new Promise((r) => setTimeout(r, 800))
              toast.success("clients.csv would download here, with the current filters.")
            }}
          />
        }
      />
      <DataTable
        id="kit-clients"
        caption="Clients"
        columns={columns}
        getRowId={(r) => r.id}
        getRowHref={(r) => `/kit#${r.code}`}
        countLabel={(n, t) => `${n} ${t === 1 ? "client" : "clients"}`}
        defaultSort={{ sort: "name", dir: "asc" }}
        selectable
        bulkActions={({ selectedIds, clear }) => (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                toast.success(`Reminder queue built for ${selectedIds.length} clients.`)
                clear()
              }}
            >
              <BellIcon aria-hidden="true" />
              Send reminders
            </Button>
          </>
        )}
        empty={
          <EmptyState
            icon={<UsersIcon />}
            message="No clients yet. Add your first client to start tracking their filings."
            action={<Button size="sm">Add client</Button>}
          />
        }
        {...props}
      />
    </div>
  )
}

const stateColumns = columns.filter((c) => ["name", "code", "status", "next_due", "outstanding"].includes(c.id))

/** Every non-happy state of the table, side by side. */
export function KitTableStates() {
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
      <div>
        <h3 className="mb-2 text-sm font-medium text-text-muted">Loading</h3>
        <DataTable id="kit-loading" caption="Clients (loading)" columns={stateColumns} rows={[]} getRowId={(r) => r.id} total={0} page={1} pageSize={25} loading maxHeight="none" />
      </div>
      <div>
        <h3 className="mb-2 text-sm font-medium text-text-muted">First run (empty)</h3>
        <DataTable
          id="kit-empty"
          caption="Clients (empty)"
          columns={stateColumns}
          rows={[]}
          getRowId={(r) => r.id}
          total={0}
          page={1}
          pageSize={25}
          isFiltered={false}
          countLabel={(n) => `${n} clients`}
          empty={
            <EmptyState
              icon={<UsersIcon />}
              message="No clients yet. Add your first client to start tracking their filings."
              action={<Button size="sm">Add client</Button>}
            />
          }
        />
      </div>
      <div>
        <h3 className="mb-2 text-sm font-medium text-text-muted">Filtered to nothing</h3>
        <DataTable
          id="kit-filtered"
          caption="Clients (filtered)"
          columns={stateColumns}
          rows={[]}
          getRowId={(r) => r.id}
          total={0}
          page={1}
          pageSize={25}
          isFiltered
          countLabel={(n) => `${n} clients`}
        />
      </div>
      <div>
        <h3 className="mb-2 text-sm font-medium text-text-muted">Failed to load</h3>
        <DataTable
          id="kit-error"
          caption="Clients (error)"
          columns={stateColumns}
          rows={[]}
          getRowId={(r) => r.id}
          total={0}
          page={1}
          pageSize={25}
          error={{ message: "Couldn't load clients.", ref: "K7Q2M9XD", onRetry: () => void toast.message("Retrying…") }}
        />
      </div>
    </div>
  )
}
