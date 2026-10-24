import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { MONEY_SEARCH_TYPES, RememberSearchSchema, SEARCH_TYPES, normaliseQuery, searchTypesFor } from "@/lib/schemas/search";
import { searchHref } from "@/lib/data/search";
import { parseSearchResponse, searchPageHref } from "@/components/shell/search-contract";

describe("searchTypesFor (§4.1)", () => {
  it("never lets an Employee search leads, invoices or quotations", () => {
    const types = searchTypesFor("employee");
    for (const t of MONEY_SEARCH_TYPES) expect(types).not.toContain(t);
    expect(types).toEqual(["client", "contact", "task", "document", "employee"]);
  });

  it("gives Partners and Managers every type, and the portal none", () => {
    expect(searchTypesFor("partner")).toEqual([...SEARCH_TYPES]);
    expect(searchTypesFor("manager")).toEqual([...SEARCH_TYPES]);
    expect(searchTypesFor("client")).toEqual([]);
  });
});

describe("normaliseQuery and RememberSearchSchema", () => {
  it("trims, collapses spaces and caps the length", () => {
    expect(normaliseQuery("  Sharma   Traders ")).toBe("Sharma Traders");
    expect(normaliseQuery(null)).toBe("");
    expect(normaliseQuery("x".repeat(150))).toHaveLength(100);
  });

  it("refuses a one-character query", () => {
    expect(RememberSearchSchema.safeParse({ query: " a " }).success).toBe(false);
    expect(RememberSearchSchema.safeParse({ query: "  ab  " })).toMatchObject({ success: true, data: { query: "ab" } });
  });
});

describe("searchHref (§7.18 deep links)", () => {
  const client = "11111111-1111-4111-8111-111111111111";
  const id = "22222222-2222-4222-8222-222222222222";
  it("opens each record where it lives", () => {
    expect(searchHref("client", { id: client, client_id: client }, "partner")).toBe(`/clients/${client}`);
    expect(searchHref("contact", { id, client_id: client }, "employee")).toBe(`/clients/${client}?tab=profile`);
    expect(searchHref("task", { id, client_id: client }, "employee")).toBe(`/work/${id}`);
    expect(searchHref("document", { id, client_id: client }, "employee")).toBe(`/clients/${client}?tab=documents&doc=${id}`);
    expect(searchHref("invoice", { id, client_id: client }, "manager")).toBe(`/invoices/${id}`);
    expect(searchHref("quotation", { id, client_id: null }, "manager")).toBe(`/quotations/${id}`);
    expect(searchHref("lead", { id, client_id: null }, "partner")).toBe(`/leads/${id}`);
  });

  it("sends an Employee's own person result to their profile, others' to People", () => {
    expect(searchHref("employee", { id, client_id: null }, "employee")).toBe("/profile");
    expect(searchHref("employee", { id, client_id: null }, "manager")).toBe(`/people/${id}`);
  });
});

describe("the palette contract (components/shell/search-contract.ts)", () => {
  it("accepts what the route sends and builds the See all link", () => {
    const body = { ok: true, data: { groups: [{ type: "client", label: "Clients", total: 7, items: [{ id: "a", title: "Alpha", subtitle: "TW-C-0001", href: "/clients/a" }] }] } };
    expect(parseSearchResponse(body)).toEqual(body);
    expect(searchPageHref("alpha", "client")).toBe("/search?q=alpha&type=client");
  });
});
