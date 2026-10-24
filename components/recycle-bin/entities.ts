/**
 * What the recycle bin holds (§7.19, §0.1 rule 11): the six soft-deletable records, their names,
 * where each opens once it is back, and what to type before a purge. Pure and client-safe (the
 * server action and the page share it).
 */

export const BIN_ENTITIES = ["client", "task", "document", "invoice", "lead", "quotation"] as const;
export type BinEntity = (typeof BIN_ENTITIES)[number];

export function isBinEntity(v: unknown): v is BinEntity {
  return typeof v === "string" && (BIN_ENTITIES as readonly string[]).includes(v);
}

export const BIN_ENTITY_LABEL: Readonly<Record<BinEntity, { one: string; many: string }>> = {
  client: { one: "Client", many: "Clients" },
  task: { one: "Task", many: "Tasks" },
  document: { one: "Document", many: "Documents" },
  invoice: { one: "Invoice", many: "Invoices" },
  lead: { one: "Lead", many: "Leads" },
  quotation: { one: "Quotation", many: "Quotations" },
};

/** Money-side records (§4.1): the bin is Partners' and Managers' anyway, but nothing else may show them. */
export const MONEY_BIN_ENTITIES: readonly BinEntity[] = ["invoice", "lead", "quotation"];

/** Where a restored record opens. */
export function binItemHref(entity: BinEntity, id: string, clientId: string | null): string {
  switch (entity) {
    case "client":
      return `/clients/${id}`;
    case "task":
      return `/work/${id}`;
    case "document":
      return clientId ? `/clients/${clientId}?tab=documents&doc=${id}` : "/clients";
    case "invoice":
      return `/invoices/${id}`;
    case "lead":
      return `/leads/${id}`;
    case "quotation":
      return `/quotations/${id}`;
  }
}

/** The phrase to type before a purge (§3.4 "type-to-confirm"): the record's code or number, or PURGE. */
export function purgeConfirmPhrase(item: { entity: BinEntity; reference: string | null; title: string }): string {
  switch (item.entity) {
    case "client":
    case "task":
    case "lead":
      return item.reference?.trim() || "PURGE";
    case "invoice":
    case "quotation":
      return /^Draft /.test(item.title) ? "PURGE" : item.title.trim() || "PURGE";
    case "document":
      return "PURGE";
  }
}

/** True when what was typed matches the phrase (case and outer spaces don't matter). */
export function purgeConfirmed(typed: string, phrase: string): boolean {
  return typed.trim().toUpperCase() === phrase.trim().toUpperCase() && phrase.trim().length > 0;
}

export const BIN_PERIODS = ["7", "30", "90"] as const;
export type BinPeriod = (typeof BIN_PERIODS)[number];
export const BIN_PERIOD_LABEL: Readonly<Record<BinPeriod, string>> = { "7": "Last 7 days", "30": "Last 30 days", "90": "Last 90 days" };

export const BIN_SORTABLE = ["deleted_at", "title", "entity"] as const;
export type BinSort = (typeof BIN_SORTABLE)[number];
