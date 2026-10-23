import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/server/notify", () => ({ notify: vi.fn() }));
vi.mock("@/lib/auth/current-user", () => ({ getSession: vi.fn(async () => ({ status: "anonymous" })) }));

import { scrubMoneyMetadata } from "@/server/activity";
import { bounceNoticeTarget } from "@/server/email/events";
import { sendWithRetry } from "@/server/email/resend";
import { defaultFirmProfile, displayWebsite, formatFirmAddress, toFirmProfile } from "@/server/firm";

describe("history never carries fees for non-money events (§4.1)", () => {
  it("drops money-named keys, nested too, and reports them", () => {
    const { metadata, dropped } = scrubMoneyMetadata(
      { status: "filed", agreed_fee: 5000, amount: 1, details: { total_amount: 2, arn: "AA29" }, lines: [{ rate: 18, title: "x" }], tds: 3 },
      false,
    );
    expect(metadata).toEqual({ status: "filed", details: { arn: "AA29" }, lines: [{ title: "x" }] });
    expect(dropped.sort()).toEqual(["agreed_fee", "amount", "details.total_amount", "lines[0].rate", "tds"]);
  });

  it("keeps everything for money-side events, and null stays null", () => {
    expect(scrubMoneyMetadata({ amount: 5900 }, true)).toEqual({ metadata: { amount: 5900 }, dropped: [] });
    expect(scrubMoneyMetadata(null, false)).toEqual({ metadata: null, dropped: [] });
  });
});

describe("bounce notices (§9 'Email bounced → Sender + owner')", () => {
  const base = { id: "11111111-1111-4111-8111-111111111111", client_id: null as string | null, related_entity_type: null as string | null, related_entity_id: null as string | null };

  it("link to the record, keeping money records as the entity so Employees never get them", () => {
    expect(bounceNoticeTarget({ ...base, kind: "invoice", related_entity_type: "invoice", related_entity_id: "22222222-2222-4222-8222-222222222222" })).toEqual({
      linkUrl: "/invoices/22222222-2222-4222-8222-222222222222",
      entity: { type: "invoice", id: "22222222-2222-4222-8222-222222222222" },
    });
    // a money email without a related record still counts as money (fee_*)
    expect(bounceNoticeTarget({ ...base, kind: "payment_reminder", client_id: "33333333-3333-4333-8333-333333333333" })).toEqual({
      linkUrl: "/clients/33333333-3333-4333-8333-333333333333?tab=communication",
      entity: { type: "fee_email", id: base.id },
    });
    expect(bounceNoticeTarget({ ...base, kind: "document_request", client_id: "33333333-3333-4333-8333-333333333333" }).entity).toEqual({ type: "email_delivery", id: base.id });
    expect(bounceNoticeTarget({ ...base, kind: "staff_invite", related_entity_type: "employee", related_entity_id: "44444444-4444-4444-8444-444444444444" }).linkUrl).toBe(
      "/people/44444444-4444-4444-8444-444444444444",
    );
    expect(bounceNoticeTarget({ ...base, kind: "test" }).linkUrl).toBe("/settings/email");
  });
});

describe("Resend sending: retries with one idempotency key (§13)", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test_key_123456789012345";
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
  });
  const payload = { from: "TaxWise Consultants <noreply@twchartered.com>", to: ["a@b.com"], subject: "s", html: "<p>h</p>", text: "t" };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("retries rate limits and server errors (up to three times), always with the same key", async () => {
    const calls: Array<{ key: string | null; auth: string | null }> = [];
    const answers = [json(429, { name: "rate_limit_exceeded", message: "slow down" }), json(500, { name: "internal_server_error", message: "x" }), json(200, { id: "re_ok_1" })];
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      calls.push({ key: h.get("Idempotency-Key"), auth: h.get("Authorization") });
      return answers.shift()!;
    }) as typeof fetch;
    const waits: number[] = [];
    const r = await sendWithRetry(payload, "invoice:1:issue", { sleep: async (ms) => void waits.push(ms) });
    expect(r).toEqual({ ok: true, providerMessageId: "re_ok_1", error: null, attempts: 3 });
    expect(calls.map((c) => c.key)).toEqual(["invoice:1:issue", "invoice:1:issue", "invoice:1:issue"]);
    expect(calls[0].auth).toBe("Bearer re_test_key_123456789012345");
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeGreaterThanOrEqual(500);
    expect(waits[1]).toBeGreaterThanOrEqual(1500);
  });

  it("gives up after the first try plus three retries", async () => {
    globalThis.fetch = vi.fn(async () => json(503, { message: "unavailable" })) as typeof fetch;
    const r = await sendWithRetry(payload, "k", { sleep: async () => undefined });
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(4);
    expect(r.error).toMatchObject({ statusCode: 503 });
  });

  it("doesn't retry a refusal, and network errors are retried", async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n += 1;
      return json(422, { name: "validation_error", message: "Invalid `to` field." });
    }) as typeof fetch;
    const r = await sendWithRetry(payload, "k", { sleep: async () => undefined });
    expect(n).toBe(1);
    expect(r).toMatchObject({ ok: false, attempts: 1, error: { name: "validation_error" } });

    let m = 0;
    globalThis.fetch = vi.fn(async () => {
      m += 1;
      if (m < 2) throw new TypeError("fetch failed");
      return json(200, { id: "re_2" });
    }) as typeof fetch;
    expect(await sendWithRetry(payload, "k", { sleep: async () => undefined })).toMatchObject({ ok: true, providerMessageId: "re_2", attempts: 2 });
  });

  it("without RESEND_API_KEY nothing is attempted", async () => {
    delete process.env.RESEND_API_KEY;
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const r = await sendWithRetry(payload, "k");
    expect(r).toMatchObject({ ok: false, attempts: 0, error: { name: "missing_api_key" } });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("the firm as documents show it (§1, §4.6)", () => {
  it("shapes the public profile, with bank and UPI only when filled in", () => {
    const row = {
      firm_name: "TaxWise Consultants",
      legal_name: null,
      tagline: "Chartered Accountants · Bengaluru",
      address: "307, 14th Main Rd",
      city: "Bengaluru",
      state_code: "29",
      pincode: "560080",
      phone: "+91 97405 40239",
      email: "info@twchartered.com",
      website: "https://www.twchartered.com/",
      gstin: "29AAXFT1811B1Z3",
      logo_path: null,
      logo_updated_at: null,
      bank_name: " ",
      bank_account_name: null,
      bank_account_number: null,
      bank_ifsc: null,
      bank_branch: null,
      upi_id: "taxwise@hdfcbank",
      upi_payee_name: null,
    };
    const p = toFirmProfile(row, null);
    expect(p).toMatchObject({ stateName: "Karnataka", bank: null, upi: { id: "taxwise@hdfcbank", payeeName: "TaxWise Consultants" } });
    expect(formatFirmAddress(p)).toBe("307, 14th Main Rd, Bengaluru, Karnataka 560080");
    expect(toFirmProfile({ ...row, bank_ifsc: "HDFC0001234", upi_id: null }, null)).toMatchObject({ bank: { ifsc: "HDFC0001234", name: null }, upi: null });
  });

  it("falls back to the §1 identity", () => {
    expect(defaultFirmProfile()).toMatchObject({ firmName: "TaxWise Consultants", gstin: "29AAXFT1811B1Z3", stateName: "Karnataka" });
    expect(displayWebsite("https://www.twchartered.com/")).toBe("www.twchartered.com");
    expect(displayWebsite("  ")).toBeNull();
  });
});
