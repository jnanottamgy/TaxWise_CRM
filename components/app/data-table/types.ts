import type * as React from "react"

/**
 * A DataTable column. Columns hold render functions, so define them in a "use client" file next to
 * the feature's table component (functions can't be passed from a Server Component).
 */
export interface DataTableColumn<T> {
  /** Stable id: the column chooser key and (unless `sortKey` is set) the `?sort=` value. */
  id: string
  /** Sentence-case header text ("Due date", not "DUE DATE"). Also the column chooser label. */
  header: string
  cell: (row: T) => React.ReactNode
  /** Numbers, amounts and dates align right (DESIGN.md §3). */
  align?: "left" | "right" | "center"
  /** Server-side sortable: `id` (or `sortKey`) must be in the page's parseTableParams `sortable` list. */
  sortable?: boolean
  sortKey?: string
  /** Hide the column below this breakpoint (on top of the phone card layout below 768px). `2xl` (1536px) keeps a column off 1366px screens. */
  hideBelow?: "lg" | "xl" | "2xl"
  /**
   * Where the column goes in the stacked card below 768px: `primary` (line 1, left: the identity),
   * `trailing` (line 1, right: the key number or status), `secondary` (line 2, grey, joined with " · ").
   * Columns without a slot are left out of the card. If no column has a slot, the first column is
   * primary and the next two are secondary.
   */
  mobile?: "primary" | "trailing" | "secondary"
  /** A different rendering for the phone card (e.g. a one-line date instead of the stacked one). */
  mobileCell?: (row: T) => React.ReactNode
  /** CSS width for the column ("34%", "8rem"). The identity column should get the most room. */
  width?: string
  /** Can the user hide it with the column chooser? Default true; the identity column should say false. */
  hideable?: boolean
  /** Hidden until the user turns it on in the column chooser. */
  defaultHidden?: boolean
  /** Wrap this cell's content in the row's detail link (default: the first visible column). */
  rowLink?: boolean
  /** Extra classes on every body cell of the column. */
  className?: string
}
