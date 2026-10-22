/**
 * Messaging hand-offs: WhatsApp click-to-chat, Gmail compose, mailto and the UPI pay link
 * (§7.13.1–§7.13.3, §7.22, §7.25.10).
 *
 * Nothing here sends anything: each function builds the link a person opens and then presses Send
 * in WhatsApp or Gmail themselves, so the app may only ever claim "handed off" (§7.13.1).
 *
 * Pure and client-safe.
 */

import { paiseToDecimalString, type Paise } from "@/lib/domain/money";

/**
 * Seed values (§5.2, §7.13.2, §7.13.3): the default country code (`firm_settings.whatsapp_country_code`),
 * the E.164 length bounds, Gmail's practical compose-URL cap, and the WhatsApp signature format
 * (`firm_settings.whatsapp_signature`).
 */
export const MESSAGING_DEFAULTS = {
  countryCode: "91",
  e164MinDigits: 8,
  e164MaxDigits: 15,
  composeUrlMaxLength: 1900,
  whatsappSignature: "– {first_name}",
} as const;

/** The tooltip on a disabled WhatsApp button (§7.13.2). */
export const NO_WHATSAPP_NUMBER_MESSAGE = "No WhatsApp number for this client. Add one in Contacts.";

// -------------------------------------------------------------------------------------------------
// WhatsApp number normalisation (§7.13.2)
// -------------------------------------------------------------------------------------------------

const INDIAN_MOBILE_FIRST = /^[6-9]/;

/**
 * Normalises a phone number for WhatsApp, exactly as §7.13.2 lays out, returning the digits for
 * `wa.me` (E.164 without the `+`) or null ("no WhatsApp number"):
 * 1. Trim. A leading `+` means the country code is present; strip everything but digits.
 * 2. Without `+`: 11 digits starting `0` → drop the `0` (trunk prefix); more than 12 digits
 *    starting `00` → drop the `00`; exactly 10 digits (including after dropping the trunk `0`) →
 *    must start with 6–9 (an Indian mobile; landlines aren't on WhatsApp) → prefix `91`.
 * 3. With `+` and a leading `00` → drop it.
 * 4. The result must be 8–15 digits (E.164, so it can't start with 0).
 * 5. If it starts `91` and is 12 digits, the subscriber part must start with 6–9.
 * 6. Anything else → null.
 */
export function normalizeWhatsAppNumber(
  input: string | null | undefined,
  opts: { countryCode?: string } = {},
): string | null {
  if (input === null || input === undefined) return null;
  const countryCode = opts.countryCode ?? MESSAGING_DEFAULTS.countryCode;
  // 1.
  const text = input.trim();
  const hasPlus = text.startsWith("+");
  let digits = text.replace(/\D/g, "");
  if (digits === "") return null;

  if (!hasPlus) {
    // 2.
    if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
    else if (digits.length > 12 && digits.startsWith("00")) digits = digits.slice(2);
    if (digits.length === 10) {
      if (!INDIAN_MOBILE_FIRST.test(digits)) return null;
      digits = `${countryCode}${digits}`;
    }
  } else if (digits.startsWith("00")) {
    // 3.
    digits = digits.slice(2);
  }

  // 4.
  if (digits.length < MESSAGING_DEFAULTS.e164MinDigits || digits.length > MESSAGING_DEFAULTS.e164MaxDigits) return null;
  if (digits.startsWith("0")) return null;
  // 5.
  if (digits.startsWith("91") && digits.length === 12 && !INDIAN_MOBILE_FIRST.test(digits.slice(2))) return null;
  return digits;
}

/** `+91 98765 43210` for display, from normalised digits (Indian numbers grouped 5-5; others as `+<digits>`). */
export function formatWhatsAppNumber(digits: string): string {
  if (digits.startsWith("91") && digits.length === 12) return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  return `+${digits}`;
}

export type NumberSource = "contact_whatsapp" | "contact_phone" | "client_whatsapp" | "client_phone";

export type PickedNumber = { digits: string; source: NumberSource; raw: string };

type HasNumbers = { whatsapp?: string | null; phone?: string | null };

/**
 * The number a WhatsApp button uses (§7.13.2): contact `whatsapp` → contact `phone` → client
 * `whatsapp` → client `phone`, the first that normalises to a usable number. Per-contact buttons
 * pass `contactOnly` so they use that contact's own number and never the client's. Null when there
 * is no usable number (the button stays visible but disabled, `NO_WHATSAPP_NUMBER_MESSAGE`).
 */
export function pickWhatsAppNumber(
  contact: HasNumbers | null | undefined,
  client: HasNumbers | null | undefined,
  opts: { contactOnly?: boolean; countryCode?: string } = {},
): PickedNumber | null {
  const candidates: Array<[string | null | undefined, NumberSource]> = [
    [contact?.whatsapp, "contact_whatsapp"],
    [contact?.phone, "contact_phone"],
  ];
  if (!opts.contactOnly) candidates.push([client?.whatsapp, "client_whatsapp"], [client?.phone, "client_phone"]);
  for (const [raw, source] of candidates) {
    const digits = normalizeWhatsAppNumber(raw, { countryCode: opts.countryCode });
    if (digits && raw) return { digits, source, raw };
  }
  return null;
}

export type ContactForService = {
  isPrimary?: boolean;
  /** `client_contacts.handles` (service types): the services this person answers for; empty = general. */
  handles?: readonly string[] | null;
};

/**
 * The contact to message about a service (§5.3, §7.13.2: "The handles field picks the right contact
 * for a service"): a contact who handles it (the primary one first), otherwise a general contact
 * (empty `handles`; primary first), otherwise the primary contact, otherwise the first. Null when
 * there are no contacts. Without a service, the primary contact (or the first).
 */
export function pickContactForService<C extends ContactForService>(contacts: readonly C[], serviceType?: string | null): C | null {
  if (contacts.length === 0) return null;
  const primaryFirst = (list: readonly C[]): C | undefined => list.find((c) => c.isPrimary) ?? list[0];
  if (serviceType) {
    const handlers = contacts.filter((c) => (c.handles ?? []).includes(serviceType));
    if (handlers.length > 0) return primaryFirst(handlers) ?? null;
    const general = contacts.filter((c) => (c.handles ?? []).length === 0);
    if (general.length > 0) return primaryFirst(general) ?? null;
  }
  return primaryFirst(contacts) ?? null;
}

// -------------------------------------------------------------------------------------------------
// wa.me (§7.13.2)
// -------------------------------------------------------------------------------------------------

/** Replaces unpaired UTF-16 surrogates with U+FFFD, so `encodeURIComponent` never throws. */
function wellFormed(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i] + text[i + 1];
        i += 1;
        continue;
      }
      out += "�";
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      out += "�";
    } else {
      out += text[i];
    }
  }
  return out;
}

/** LF line breaks (CRLF and CR become LF) in well-formed text. */
function normaliseLineBreaks(text: string): string {
  return wellFormed(text).replace(/\r\n?/g, "\n");
}

/**
 * `https://wa.me/<digits>?text=<encodeURIComponent(draft)>` (§7.13.2). Line breaks are kept (`%0A`;
 * CRLF becomes LF). An empty draft opens the chat with no text. `wa.me` routes itself to the phone
 * app, WhatsApp Web or desktop (never hard-code `web.whatsapp.com`).
 */
export function waMeUrl(digits: string, draft = ""): string {
  if (!/^[1-9]\d{7,14}$/.test(digits)) throw new RangeError("waMeUrl needs a normalised number (8–15 digits, from normalizeWhatsAppNumber).");
  const text = normaliseLineBreaks(draft);
  return text === "" ? `https://wa.me/${digits}` : `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

// -------------------------------------------------------------------------------------------------
// Signature on shared numbers (§7.13.2, §7.25.10)
// -------------------------------------------------------------------------------------------------

const HONORIFICS = new Set(["ca", "cs", "cma", "mr", "mrs", "ms", "miss", "dr", "shri", "smt", "sri", "kum"]);

/** The first name from a full name, skipping titles: `CA Vinay H Karlagere` → `Vinay`. */
export function firstNameOf(fullName: string | null | undefined): string {
  const words = (fullName ?? "").trim().split(/\s+/).filter(Boolean);
  const name = words.find((w) => !HONORIFICS.has(w.replace(/\.$/, "").toLowerCase()));
  return name ?? "";
}

/**
 * Ends a WhatsApp draft with the sender's signature (§7.13.2, §7.25.10): the format (default
 * `– {first_name}`) with `{first_name}` filled in, after a blank line. Unchanged when there is no
 * first name or the draft already ends with the signature, so applying it twice is harmless.
 */
export function applySignature(draft: string, format: string = MESSAGING_DEFAULTS.whatsappSignature, firstName = ""): string {
  const name = firstName.trim();
  if (name === "") return draft;
  const signature = format.replace(/\{first_name\}/g, name).trim();
  if (signature === "") return draft;
  const body = normaliseLineBreaks(draft).replace(/\s+$/, "");
  if (body.endsWith(signature)) return body;
  return body === "" ? signature : `${body}\n\n${signature}`;
}

// -------------------------------------------------------------------------------------------------
// Gmail compose and mailto (§7.13.3)
// -------------------------------------------------------------------------------------------------

export type ComposeInput = {
  to: string | readonly string[];
  cc?: string | readonly string[] | null;
  bcc?: string | readonly string[] | null;
  subject?: string | null;
  body?: string | null;
};

export type ComposeUrl = {
  url: string;
  /** True when the body was shortened to fit the cap. */
  bodyTrimmed: boolean;
};

/** The marker added where a body was cut short. */
export const TRIMMED_BODY_MARKER = "…";

const GMAIL_COMPOSE_BASE = "https://mail.google.com/mail/?view=cm&fs=1&tf=1";

function addressList(value: string | readonly string[] | null | undefined): string {
  const list = typeof value === "string" ? value.split(/[,;]/) : value ?? [];
  return list.map((a) => a.trim()).filter(Boolean).join(",");
}

/**
 * The longest prefix of `body` whose encoded form fits in `budget` URL characters, cut only between
 * code points (never inside a surrogate pair or a multi-byte percent-escape such as ₹ = `%E2%82%B9`).
 * When it has to cut, it appends `TRIMMED_BODY_MARKER` within the budget.
 */
function fitBody(body: string, budget: number, encode: (s: string) => string): { encoded: string; trimmed: boolean } {
  const full = encode(body);
  if (full.length <= budget) return { encoded: full, trimmed: false };
  const marker = encode(TRIMMED_BODY_MARKER);
  const room = budget - marker.length;
  if (room <= 0) return { encoded: "", trimmed: true };
  let used = 0;
  let out = "";
  for (const ch of body) {
    const piece = encode(ch);
    if (used + piece.length > room) break;
    out += piece;
    used += piece.length;
  }
  return { encoded: out.replace(/(%20|%0A|%0D)+$/i, "") + marker, trimmed: true };
}

/**
 * The Gmail compose hand-off (§7.13.3):
 * `https://mail.google.com/mail/?view=cm&fs=1&tf=1&to=…&su=…&body=…` (plus `cc` / `bcc`). Gmail
 * drops very long compose URLs, so the URL is capped at about 1,900 characters by trimming **only
 * the body**, UTF-8 aware; the recipients and subject are never cut (if they alone exceed the cap,
 * the body is left empty).
 */
export function buildGmailCompose(input: ComposeInput, opts: { maxLength?: number } = {}): ComposeUrl {
  const max = opts.maxLength ?? MESSAGING_DEFAULTS.composeUrlMaxLength;
  const params: string[] = [`to=${encodeURIComponent(addressList(input.to))}`];
  const cc = addressList(input.cc);
  const bcc = addressList(input.bcc);
  if (cc) params.push(`cc=${encodeURIComponent(cc)}`);
  if (bcc) params.push(`bcc=${encodeURIComponent(bcc)}`);
  if (input.subject) params.push(`su=${encodeURIComponent(wellFormed(input.subject))}`);
  const head = `${GMAIL_COMPOSE_BASE}&${params.join("&")}`;
  const body = normaliseLineBreaks(input.body ?? "");
  if (body === "") return { url: head, bodyTrimmed: false };
  const prefix = `${head}&body=`;
  const { encoded, trimmed } = fitBody(body, max - prefix.length, encodeURIComponent);
  return { url: encoded === "" ? head : `${prefix}${encoded}`, bodyTrimmed: trimmed };
}

/** The Gmail compose URL string (§7.13.3); see `buildGmailCompose`. */
export function gmailComposeUrl(input: ComposeInput, opts: { maxLength?: number } = {}): string {
  return buildGmailCompose(input, opts).url;
}

function encodeAddressForMailto(address: string): string {
  return encodeURIComponent(address).replace(/%40/g, "@");
}

/** RFC 6068 encoding for mailto fields: line breaks become `%0D%0A`. */
function encodeMailtoText(text: string): string {
  return encodeURIComponent(text).replace(/%0A/g, "%0D%0A");
}

/**
 * The `mailto:` fallback for people who don't use Gmail (§7.13.3, profile "I use Outlook / default
 * mail app"). Line breaks are `%0D%0A` (RFC 6068). The body is trimmed to the same cap as Gmail.
 */
export function buildMailto(input: ComposeInput, opts: { maxLength?: number } = {}): ComposeUrl {
  const max = opts.maxLength ?? MESSAGING_DEFAULTS.composeUrlMaxLength;
  const to = addressList(input.to)
    .split(",")
    .filter(Boolean)
    .map(encodeAddressForMailto)
    .join(",");
  const params: string[] = [];
  const cc = addressList(input.cc);
  const bcc = addressList(input.bcc);
  if (cc) params.push(`cc=${cc.split(",").map(encodeAddressForMailto).join(",")}`);
  if (bcc) params.push(`bcc=${bcc.split(",").map(encodeAddressForMailto).join(",")}`);
  if (input.subject) params.push(`subject=${encodeMailtoText(normaliseLineBreaks(input.subject))}`);
  const head = `mailto:${to}${params.length > 0 ? `?${params.join("&")}` : ""}`;
  const body = normaliseLineBreaks(input.body ?? "");
  if (body === "") return { url: head, bodyTrimmed: false };
  const prefix = `${head}${params.length > 0 ? "&" : "?"}body=`;
  const { encoded, trimmed } = fitBody(body, max - prefix.length, encodeMailtoText);
  return { url: encoded === "" ? head : `${prefix}${encoded}`, bodyTrimmed: trimmed };
}

/** The `mailto:` URL string (§7.13.3); see `buildMailto`. */
export function mailtoUrl(input: ComposeInput, opts: { maxLength?: number } = {}): string {
  return buildMailto(input, opts).url;
}

// -------------------------------------------------------------------------------------------------
// UPI deep link (§7.22)
// -------------------------------------------------------------------------------------------------

/** A UPI ID (VPA): `name@bank`. */
export const UPI_ID_PATTERN = /^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9.-]{1,63}$/;

/** True for a well-formed UPI ID. */
export function isValidUpiId(value: string): boolean {
  return UPI_ID_PATTERN.test(value.trim());
}

/**
 * The UPI pay link for the portal Pay dialog and WhatsApp invoice drafts (§7.22):
 * `upi://pay?pa=<upi_id>&pn=<payee>&am=<amount>&tn=<invoice no>&cu=INR`. The amount is rupees with
 * two decimals (`1234.50`); it's left out when not given, so the payer types it. Throws a RangeError
 * for a malformed UPI ID or an amount that isn't more than 0.
 */
export function upiPayUrl(input: { upiId: string; payee: string; amountPaise?: Paise | null; note?: string | null }): string {
  const pa = input.upiId.trim();
  if (!isValidUpiId(pa)) throw new RangeError("The firm's UPI ID isn't valid. Check it in Settings → Bank & UPI.");
  const parts = [`pa=${encodeURIComponent(pa).replace(/%40/g, "@")}`, `pn=${encodeURIComponent(input.payee.trim())}`];
  if (input.amountPaise !== null && input.amountPaise !== undefined) {
    if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0) throw new RangeError("A UPI amount must be more than 0.");
    parts.push(`am=${paiseToDecimalString(input.amountPaise)}`);
  }
  const note = input.note?.trim();
  if (note) parts.push(`tn=${encodeURIComponent(note)}`);
  parts.push("cu=INR");
  return `upi://pay?${parts.join("&")}`;
}
