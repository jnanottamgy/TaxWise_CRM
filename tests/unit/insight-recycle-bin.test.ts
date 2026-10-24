import { describe, expect, it } from "vitest";
import { BIN_ENTITIES, binItemHref, isBinEntity, purgeConfirmPhrase, purgeConfirmed } from "@/components/recycle-bin/entities";

describe("the recycle bin's records (§7.19)", () => {
  it("holds exactly the six soft-deletable records of §0.1 rule 11", () => {
    expect([...BIN_ENTITIES].sort()).toEqual(["client", "document", "invoice", "lead", "quotation", "task"]);
    expect(isBinEntity("client")).toBe(true);
    expect(isBinEntity("employee")).toBe(false);
  });

  it("opens a restored record where it lives", () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const client = "11111111-1111-4111-8111-111111111111";
    expect(binItemHref("client", id, id)).toBe(`/clients/${id}`);
    expect(binItemHref("task", id, client)).toBe(`/work/${id}`);
    expect(binItemHref("document", id, client)).toBe(`/clients/${client}?tab=documents&doc=${id}`);
    expect(binItemHref("invoice", id, client)).toBe(`/invoices/${id}`);
    expect(binItemHref("lead", id, null)).toBe(`/leads/${id}`);
    expect(binItemHref("quotation", id, null)).toBe(`/quotations/${id}`);
  });
});

describe("type-to-confirm for a purge (§3.4)", () => {
  it("asks for the record's own code or number", () => {
    expect(purgeConfirmPhrase({ entity: "client", reference: "TW-C-0042", title: "Sharma Traders" })).toBe("TW-C-0042");
    expect(purgeConfirmPhrase({ entity: "task", reference: "T-000123", title: "GSTR-3B Sep 2026" })).toBe("T-000123");
    expect(purgeConfirmPhrase({ entity: "lead", reference: "L-0007", title: "Ravi Kumar" })).toBe("L-0007");
    expect(purgeConfirmPhrase({ entity: "invoice", reference: "Sep 2026", title: "TW/26-27/0042" })).toBe("TW/26-27/0042");
    expect(purgeConfirmPhrase({ entity: "quotation", reference: "Sharma Traders", title: "TW-Q/26-27/0007" })).toBe("TW-Q/26-27/0007");
  });

  it("falls back to PURGE for a draft, a document, or a record with no code", () => {
    expect(purgeConfirmPhrase({ entity: "invoice", reference: null, title: "Draft invoice" })).toBe("PURGE");
    expect(purgeConfirmPhrase({ entity: "document", reference: "pan.pdf", title: "PAN card" })).toBe("PURGE");
    expect(purgeConfirmPhrase({ entity: "lead", reference: null, title: "Ravi Kumar" })).toBe("PURGE");
  });

  it("ignores case and outer spaces, and never accepts an empty phrase", () => {
    expect(purgeConfirmed(" tw-c-0042 ", "TW-C-0042")).toBe(true);
    expect(purgeConfirmed("TW-C-004", "TW-C-0042")).toBe(false);
    expect(purgeConfirmed("", "")).toBe(false);
  });
});
