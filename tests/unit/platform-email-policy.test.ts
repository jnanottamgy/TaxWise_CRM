import { describe, expect, it } from "vitest";
import {
  DELIVERY_STATUSES,
  describeSendError,
  dmarcRecommendation,
  dnsRecordRows,
  emailDomainOf,
  emailSendingReady,
  formatSender,
  fromAddressOnDomain,
  isDomainNotVerifiedError,
  isMoneyEmail,
  isMoneySideKind,
  isRetryableSendError,
  isValidEmailAddress,
  mapResendDomainStatus,
  messageStatusFor,
  nextDeliveryStatus,
  normaliseDomain,
  normaliseIdempotencyKey,
  parseRecipients,
  relativeHost,
  webhookEvent,
  type DeliveryStatus,
} from "@/server/email/policy";

describe("domain status mirrors Resend (§5.2, §7.13.5)", () => {
  it("only Resend's own 'verified' is Verified", () => {
    expect(mapResendDomainStatus("verified")).toBe("verified");
    expect(mapResendDomainStatus("pending")).toBe("pending");
    expect(mapResendDomainStatus("partially_verified")).toBe("pending");
    expect(mapResendDomainStatus("failed")).toBe("failed");
    expect(mapResendDomainStatus("partially_failed")).toBe("failed");
    expect(mapResendDomainStatus("temporary_failure")).toBe("failed");
    expect(mapResendDomainStatus("not_started")).toBe("not_started");
    expect(mapResendDomainStatus(undefined)).toBe("not_started");
    expect(mapResendDomainStatus("something_new")).toBe("not_started");
  });

  it("email is ready only with a key, a verified domain and a from address on it", () => {
    const base = { apiKeyPresent: true, domainStatus: "verified", sendingDomain: "twchartered.com", fromAddress: "noreply@twchartered.com" };
    expect(emailSendingReady(base)).toEqual({ ready: true });
    expect(emailSendingReady({ ...base, apiKeyPresent: false })).toMatchObject({ ready: false, reason: expect.stringMatching(/RESEND_API_KEY/) });
    for (const s of ["pending", "failed", "not_started", null]) {
      expect(emailSendingReady({ ...base, domainStatus: s })).toMatchObject({ ready: false, reason: expect.stringMatching(/isn't verified/) });
    }
    expect(emailSendingReady({ ...base, fromAddress: "noreply@gmail.com" })).toMatchObject({ ready: false, reason: expect.stringMatching(/twchartered\.com/) });
    expect(emailSendingReady({ ...base, fromAddress: "noreply@mail.twchartered.com" })).toMatchObject({ ready: false });
  });
});

describe("addresses", () => {
  it("validates, splits and de-duplicates recipients", () => {
    expect(isValidEmailAddress("info@twchartered.com")).toBe(true);
    expect(isValidEmailAddress("a.b+c@sub.example.co.in")).toBe(true);
    for (const bad of ["", "info", "info@", "@x.com", "a b@x.com", "a@x", "a@-x.com", "a<b>@x.com"]) expect(isValidEmailAddress(bad), bad).toBe(false);
    expect(parseRecipients(" a@x.com; B@x.com , a@X.com,, ")).toEqual(["a@x.com", "B@x.com"]);
    expect(parseRecipients(["a@x.com", "a@x.com"])).toEqual(["a@x.com"]);
  });

  it("knows the domain of an address and whether the sender is on the sending domain", () => {
    expect(emailDomainOf("NoReply@TWChartered.com")).toBe("twchartered.com");
    expect(emailDomainOf("nope")).toBeNull();
    expect(fromAddressOnDomain("noreply@twchartered.com", "TWChartered.com.")).toBe(true);
    expect(fromAddressOnDomain("noreply@mail.twchartered.com", "twchartered.com")).toBe(false);
  });

  it("normalises a typed domain", () => {
    expect(normaliseDomain(" https://www.TWChartered.com/contact ")).toBe("www.twchartered.com");
    expect(normaliseDomain("twchartered.com.")).toBe("twchartered.com");
    expect(normaliseDomain("mail.twchartered.co.in")).toBe("mail.twchartered.co.in");
    for (const bad of ["", "localhost", "twchartered", "-x.com", "x..com", "x.c"]) expect(normaliseDomain(bad), bad).toBeNull();
  });

  it("formats the sender, quoting names with special characters", () => {
    expect(formatSender("TaxWise Consultants", "noreply@twchartered.com")).toBe("TaxWise Consultants <noreply@twchartered.com>");
    expect(formatSender("TaxWise Consultants, Bengaluru", "noreply@twchartered.com")).toBe(`"TaxWise Consultants, Bengaluru" <noreply@twchartered.com>`);
    expect(formatSender(`Evil"<x>\nName`, "a@b.com")).toBe("Evilx Name <a@b.com>");
    expect(formatSender("  ", "a@b.com")).toBe("a@b.com");
  });
});

describe("idempotency and retries (§13)", () => {
  it("normalises idempotency keys", () => {
    expect(normaliseIdempotencyKey("  invoice:1:issue \n")).toBe("invoice:1:issue");
    expect(normaliseIdempotencyKey("\u0000\u0007")).toBeNull();
    expect(normaliseIdempotencyKey("x".repeat(300))).toHaveLength(256);
  });

  it("retries rate limits, Resend's own failures and network errors, not refusals", () => {
    expect(isRetryableSendError({ name: "rate_limit_exceeded", statusCode: 429 })).toBe(true);
    expect(isRetryableSendError({ name: "application_error", statusCode: null })).toBe(true);
    expect(isRetryableSendError({ name: "internal_server_error", statusCode: 500 })).toBe(true);
    expect(isRetryableSendError({ name: null, statusCode: null })).toBe(true);
    expect(isRetryableSendError({ name: null, statusCode: 503 })).toBe(true);
    expect(isRetryableSendError({ name: "validation_error", statusCode: 422 })).toBe(false);
    expect(isRetryableSendError({ name: "invalid_from_address", statusCode: 403 })).toBe(false);
    expect(isRetryableSendError({ name: "daily_quota_exceeded", statusCode: 429 })).toBe(false);
    expect(isRetryableSendError(null)).toBe(false);
  });

  it("explains refusals in plain words", () => {
    expect(describeSendError({ name: "invalid_from_address" })).toMatch(/Settings → Email/);
    expect(describeSendError({ name: "invalid_api_key" })).toMatch(/RESEND_API_KEY/);
    expect(describeSendError({ name: "validation_error", message: "Invalid `to` field." })).toBe("Resend refused the email: Invalid `to` field.");
    expect(describeSendError({ name: null, message: "" })).toBe("Resend couldn't be reached.");
    expect(isDomainNotVerifiedError({ name: "validation_error", statusCode: 403, message: "The twchartered.com domain is not verified." })).toBe(true);
    expect(isDomainNotVerifiedError({ name: "validation_error", statusCode: 422, message: "Invalid to" })).toBe(false);
  });
});

describe("money emails (§4.1)", () => {
  it("knows the money kinds and money-side records", () => {
    expect(isMoneyEmail("invoice")).toBe(true);
    expect(isMoneyEmail("payment_reminder")).toBe(true);
    expect(isMoneyEmail("partner_digest")).toBe(true);
    expect(isMoneyEmail("document_request")).toBe(false);
    expect(isMoneyEmail("notification", "invoice")).toBe(true);
    expect(isMoneyEmail("compliance_reminder", "task")).toBe(false);
    for (const k of ["lead", "quotation_item", "invoice", "payment_receipt", "receipt", "credit_note", "engagement_letter", "fee_changed", "tds_credit", "portal_payment_claim"]) {
      expect(isMoneySideKind(k), k).toBe(true);
    }
    for (const k of ["task", "client", "document", "message", null, ""]) expect(isMoneySideKind(k), String(k)).toBe(false);
  });
});

describe("DNS records for the wizard", () => {
  const records = [
    { record: "DKIM", name: "resend._domainkey", type: "TXT", value: "p=MIGf", ttl: "Auto", status: "verified" },
    { record: "SPF", name: "send", type: "MX", value: "feedback-smtp.ap-northeast-1.amazonses.com", ttl: "Auto", status: "pending", priority: 10 },
    { record: "SPF", name: "send.twchartered.com", type: "TXT", value: "v=spf1 include:amazonses.com ~all", ttl: "", status: "failed" },
  ];

  it("orders SPF, return path, DKIM, then the DMARC recommendation", () => {
    const rows = dnsRecordRows(records, "twchartered.com", "info@twchartered.com");
    expect(rows.map((r) => r.purpose)).toEqual(["SPF", "Return path (MX)", "DKIM", "DMARC (recommended)"]);
    expect(rows[0]).toMatchObject({ host: "send", fullName: "send.twchartered.com", status: "failed", ttl: "Auto", priority: null, advisory: false });
    expect(rows[1]).toMatchObject({ type: "MX", priority: 10, status: "pending" });
    expect(rows[3]).toMatchObject({ type: "TXT", host: "_dmarc", value: "v=DMARC1; p=none; rua=mailto:info@twchartered.com", status: "recommended", advisory: true });
  });

  it("makes hosts relative to the domain", () => {
    expect(relativeHost("send.twchartered.com.", "twchartered.com")).toBe("send");
    expect(relativeHost("@", "twchartered.com")).toBe("@");
    expect(relativeHost("twchartered.com", "twchartered.com")).toBe("@");
    expect(relativeHost("resend._domainkey", "twchartered.com")).toBe("resend._domainkey");
  });

  it("leaves the report address out of DMARC when there is no valid one", () => {
    expect(dmarcRecommendation("twchartered.com", null).value).toBe("v=DMARC1; p=none");
    expect(dmarcRecommendation("twchartered.com", "not an email").value).toBe("v=DMARC1; p=none");
  });
});

describe("delivery status (webhook events can arrive in any order)", () => {
  it("maps Resend event types", () => {
    expect(webhookEvent("email.delivered")).toBe("delivered");
    expect(webhookEvent("email.delivery_delayed")).toBe("delayed");
    expect(webhookEvent("email.suppressed")).toBe("suppressed");
    expect(webhookEvent("contact.created")).toBeNull();
  });

  it("moves forward only", () => {
    const step = (from: DeliveryStatus, ...events: Parameters<typeof nextDeliveryStatus>[1][]) =>
      events.reduce<DeliveryStatus>((s, e) => nextDeliveryStatus(s, e) ?? s, from);
    expect(step("queued", "sent", "delivered", "opened")).toBe("opened");
    expect(step("queued", "opened", "delivered", "sent")).toBe("opened");
    expect(step("sent", "delayed", "delivered")).toBe("delivered");
    expect(step("sent", "delivered", "delayed")).toBe("delivered");
    expect(step("sent", "clicked")).toBe("opened");
    expect(step("delivered", "complained", "opened")).toBe("complained");
    expect(step("opened", "bounced", "delivered", "complained", "opened")).toBe("bounced");
    expect(step("sent", "suppressed")).toBe("bounced");
    expect(step("sent", "failed")).toBe("failed");
    expect(step("delivered", "failed")).toBe("delivered");
    // our API call timed out (failed) but Resend did send it
    expect(step("failed", "sent", "delivered")).toBe("delivered");
    expect(nextDeliveryStatus("opened", "opened")).toBeNull();
  });

  it("shows each status in the Communication history's words", () => {
    const seen = new Set(DELIVERY_STATUSES.map(messageStatusFor));
    expect([...seen].sort()).toEqual(["delivered", "failed", "queued", "read", "sent"]);
    expect(messageStatusFor("opened")).toBe("read");
    expect(messageStatusFor("bounced")).toBe("failed");
    expect(messageStatusFor("complained")).toBe("delivered");
  });
});
