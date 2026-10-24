import { z } from "zod";
import type { AppRole } from "@/lib/auth/roles";

/**
 * Global search (§7.18): the result types, who may search which, the full results page's URL state,
 * and the recent-search inputs. Client-safe.
 *
 * Employees never search leads, invoices or quotations (§4.1 "never, anywhere"); the database
 * function refuses them those types as well (0210).
 */

export const SEARCH_TYPES = ["client", "contact", "task", "document", "employee", "lead", "invoice", "quotation"] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export const MONEY_SEARCH_TYPES: readonly SearchType[] = ["lead", "invoice", "quotation"];

export const SEARCH_TYPE_LABEL: Readonly<Record<SearchType, { one: string; many: string }>> = {
  client: { one: "Client", many: "Clients" },
  contact: { one: "Contact", many: "Contacts" },
  task: { one: "Task", many: "Tasks" },
  document: { one: "Document", many: "Documents" },
  employee: { one: "Person", many: "People" },
  lead: { one: "Lead", many: "Leads" },
  invoice: { one: "Invoice", many: "Invoices" },
  quotation: { one: "Quotation", many: "Quotations" },
};

/** What each type is matched on, for the results page's hint. */
export const SEARCH_TYPE_FIELDS: Readonly<Record<SearchType, string>> = {
  client: "name, code, PAN, GSTIN, email or phone",
  contact: "name, email or phone",
  task: "task number or title",
  document: "title or tag",
  employee: "name or email",
  lead: "name, company, number, email or phone",
  invoice: "invoice number",
  quotation: "quotation number",
};

export function isSearchType(v: unknown): v is SearchType {
  return typeof v === "string" && (SEARCH_TYPES as readonly string[]).includes(v);
}

/** The types a role may search (§4.1). Portal users have no search at all. */
export function searchTypesFor(role: AppRole): SearchType[] {
  if (role === "client") return [];
  if (role === "employee") return SEARCH_TYPES.filter((t) => !MONEY_SEARCH_TYPES.includes(t));
  return [...SEARCH_TYPES];
}

/** The shortest query searched (matches the palette's MIN_SEARCH_LENGTH). */
export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_MAX_LENGTH = 100;

/** Trims, collapses spaces and caps the length; "" when there is nothing to search. */
export function normaliseQuery(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, " ").trim().slice(0, SEARCH_MAX_LENGTH);
}

/** Items per group in the palette (§7.18 "top 5 each"), on the results page per group, and per page of one type. */
export const PALETTE_ITEMS = 5;
export const PAGE_GROUP_ITEMS = 8;
export const TYPE_PAGE_SIZES = [25, 50, 100] as const;

export const RememberSearchSchema = z.object({
  query: z
    .string()
    .transform((s) => normaliseQuery(s))
    .pipe(z.string().min(SEARCH_MIN_LENGTH, { error: "Type at least two characters." }).max(SEARCH_MAX_LENGTH)),
});
export type RememberSearchInput = z.input<typeof RememberSearchSchema>;

export const RemoveRecentSearchSchema = z.object({ id: z.uuid({ error: "That search isn't in your history." }) });
export type RemoveRecentSearchInput = z.input<typeof RemoveRecentSearchSchema>;
