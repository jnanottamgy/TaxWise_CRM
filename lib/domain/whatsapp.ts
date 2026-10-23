/**
 * Client WhatsApp groups and TaxWise Desktop (§7.25): the rules that don't need a database.
 *
 * - Group names from the Settings format, default `TW · {client_code} · {short_name}` (§7.25.2
 *   step 1, §7.21). The client code is what makes a group findable in WhatsApp search, and how
 *   TaxWise Desktop finds it (§7.25.5), so every format and every name must carry it.
 * - The seven-step setup checklist (§7.25.2), stored in `client_whatsapp_groups.checklist` as
 *   `{ <step>: { done, by, at } }`; the client contacts ticked in step 3 ride on that step.
 * - Contact cards (vCard 3.0) named `XYZ Traders – Ramesh (Director)` for the client's people and
 *   `TW Partner – CA Vinay`, `TW Managers' office`, `TW Staff office` for the firm's numbers.
 * - The members a group gets when it is marked created, from the checklist.
 * - TaxWise Desktop: which firm numbers a person may use (§7.25.4), which one Open chat uses, invite
 *   codes, device keys, stale PCs (§7.25.7), the browser window of §7.25.8.
 *
 * Pure and client-safe.
 */

import { firstNameOf, formatWhatsAppNumber, pickWhatsAppNumber } from "@/lib/domain/messaging";
import { renderTemplate } from "@/lib/domain/templates";
import { addDays, compareDates, parseDateString, type DateString } from "@/lib/domain/fy";
import { formatTimeAgo } from "@/lib/format";

// -------------------------------------------------------------------------------------------------
// Kinds
// -------------------------------------------------------------------------------------------------

export const WHATSAPP_NUMBER_KINDS = ["partner", "managers_office", "staff_office", "other"] as const;
export type WhatsAppNumberKind = (typeof WHATSAPP_NUMBER_KINDS)[number];

export const WHATSAPP_NUMBER_KIND_LABEL: Record<WhatsAppNumberKind, string> = {
  partner: "Partner's own number",
  managers_office: "Managers' office",
  staff_office: "Staff office",
  other: "Other firm number",
};

export const WHATSAPP_MEMBER_KINDS = ["firm_number", "client_contact", "other_person"] as const;
export type WhatsAppMemberKind = (typeof WHATSAPP_MEMBER_KINDS)[number];

/** The roles that may open a firm number in TaxWise Desktop (`usable_by`; clients never, §4.6). */
export const DESKTOP_ROLES = ["partner", "manager", "employee"] as const;
export type DesktopRole = (typeof DESKTOP_ROLES)[number];

export const DESKTOP_ROLE_LABEL: Record<DesktopRole, string> = { partner: "Partners", manager: "Managers", employee: "Employees" };

const KIND_ORDER: Record<string, number> = { partner: 0, managers_office: 1, staff_office: 2, other: 3 };

/** Partners' numbers first, then the Managers' office, the Staff office, others; by label within a kind. */
export function compareFirmNumbers(a: { kind: string; label: string }, b: { kind: string; label: string }): number {
  return (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || a.label.localeCompare(b.label, "en-IN");
}

/**
 * How a member chip is coloured (§7.25.1): Partners `--accent-gold`, the Managers' office
 * `--brand-navy`, the Staff office `--text-muted`, the client's people `--info`.
 */
export type MemberTone = "partner" | "managers" | "staff" | "client" | "other";

export function memberTone(member: { kind: string; firmKind?: string | null }): MemberTone {
  if (member.kind === "client_contact") return "client";
  if (member.kind === "firm_number") {
    if (member.firmKind === "partner") return "partner";
    if (member.firmKind === "managers_office") return "managers";
    if (member.firmKind === "staff_office") return "staff";
  }
  return "other";
}

export const MEMBER_TONE_LABEL: Record<MemberTone, string> = {
  partner: "Partner",
  managers: "Managers' office",
  staff: "Staff office",
  client: "Client's person",
  other: "Other",
};

// -------------------------------------------------------------------------------------------------
// Group names (§7.25.2 step 1, §7.21)
// -------------------------------------------------------------------------------------------------

export const DEFAULT_GROUP_NAME_FORMAT = "TW · {client_code} · {short_name}";
/** The placeholders a name format may use. `{client_code}` is required. */
export const GROUP_NAME_TOKENS = ["client_code", "short_name", "client_name"] as const;
export type GroupNameToken = (typeof GROUP_NAME_TOKENS)[number];
/** WhatsApp allows group names (subjects) of up to 100 characters [verify]. */
export const GROUP_NAME_MAX = 100;
export const GROUP_NAME_FORMAT_MAX = 80;

const FORMAT_TOKEN = /\{([^{}]*)\}/g;

/** Checks a group name format (Settings → WhatsApp): known placeholders only, `{client_code}` required. */
export function validateGroupNameFormat(format: string): { ok: true } | { ok: false; error: string } {
  const f = (format ?? "").trim();
  if (f === "") return { ok: false, error: "Enter the group name format, for example TW · {client_code} · {short_name}." };
  if (f.length > GROUP_NAME_FORMAT_MAX) return { ok: false, error: `Use ${GROUP_NAME_FORMAT_MAX} characters or fewer.` };
  const unknown: string[] = [];
  for (const m of f.matchAll(FORMAT_TOKEN)) {
    const name = m[1].trim();
    if (!(GROUP_NAME_TOKENS as readonly string[]).includes(name)) unknown.push(`{${m[1]}}`);
  }
  if (unknown.length) {
    return { ok: false, error: `${unknown.join(", ")} isn't a placeholder the format can use. Use {client_code}, {short_name} or {client_name}.` };
  }
  const rest = f.replace(FORMAT_TOKEN, "");
  if (rest.includes("{") || rest.includes("}")) return { ok: false, error: "A brace is left unmatched. Placeholders look like {client_code}." };
  if (!/\{\s*client_code\s*\}/.test(f)) {
    return { ok: false, error: "Include {client_code}: it makes the group findable in WhatsApp search, and it is how TaxWise Desktop finds the group." };
  }
  return { ok: true };
}

const LEGAL_SUFFIXES = [
  /[\s,]*\(?\bopc\)?\s*(?:private|pvt\.?)\s*(?:limited|ltd\.?)\.?$/i,
  /[\s,]*(?:\b(?:private|pvt\.?|p\.)|\(p\))\s*(?:limited|ltd\.?)\.?$/i,
  /[\s,]*\b(?:limited|ltd\.?)$/i,
  /[\s,]*\bllp\.?$/i,
];

/**
 * The client's name as people say it, for group names and contact cards: the display name without
 * a leading "M/s" or a trailing legal form ("Private Limited", "Pvt. Ltd.", "Ltd", "LLP").
 * `XYZ Traders Private Limited` → `XYZ Traders`.
 */
export function shortClientName(displayName: string | null | undefined): string {
  const original = (displayName ?? "").replace(/\s+/g, " ").trim();
  let s = original.replace(/^m\/s\.?\s+/i, "");
  for (const re of LEGAL_SUFFIXES) s = s.replace(re, "");
  s = s.replace(/[\s,.–-]+$/u, "").trim();
  return s || original;
}

function fill(format: string, values: Record<GroupNameToken, string>): string {
  return format
    .replace(FORMAT_TOKEN, (raw, inner: string) => {
      const name = inner.trim() as GroupNameToken;
      return (GROUP_NAME_TOKENS as readonly string[]).includes(name) ? values[name] : raw;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The group's name from the Settings format (§7.25.2 step 1), e.g. `TW · TW-C-0142 · XYZ Traders`.
 * Never longer than `GROUP_NAME_MAX`: the client's names are shortened (ending "…"), the client
 * code never. An invalid format falls back to the default.
 */
export function renderGroupName(format: string | null | undefined, client: { clientCode: string; displayName: string }): string {
  const f = format && validateGroupNameFormat(format).ok ? format.trim() : DEFAULT_GROUP_NAME_FORMAT;
  const code = client.clientCode.trim();
  const full = client.displayName.replace(/\s+/g, " ").trim();
  const short = shortClientName(full);
  const name = fill(f, { client_code: code, short_name: short, client_name: full });
  if (name.length <= GROUP_NAME_MAX) return name;
  // Share the room left after the code and the fixed text between the name placeholders.
  const slots = [...f.matchAll(FORMAT_TOKEN)].filter((m) => m[1].trim() !== "client_code").length;
  const fixed = fill(f, { client_code: code, short_name: "", client_name: "" }).length + slots;
  const budget = Math.max(2, Math.floor((GROUP_NAME_MAX - fixed) / Math.max(1, slots)));
  const shorter = fill(f, { client_code: code, short_name: clip(short, budget), client_name: clip(full, budget) });
  return shorter.length <= GROUP_NAME_MAX ? shorter : shorter.slice(0, GROUP_NAME_MAX);
}

/** `s` in at most `max` characters, ending "…" when cut (never inside a character). */
function clip(s: string, max: number): string {
  const chars = [...s];
  if (chars.length <= max) return s;
  return `${chars.slice(0, Math.max(1, max - 1)).join("").trimEnd()}…`;
}

/** A name for a second group of the same client (§7.25.2: "a separate group for a statutory audit"). */
export function secondaryGroupName(primaryStyleName: string, purpose: string | null | undefined): string {
  const p = (purpose ?? "").replace(/\s+/g, " ").trim();
  if (!p) return primaryStyleName;
  const candidate = `${primaryStyleName} · ${p}`;
  return candidate.length <= GROUP_NAME_MAX ? candidate : candidate.slice(0, GROUP_NAME_MAX).trimEnd();
}

/** True when the name carries the client's code (§5.13 "must contain the client code"). Case-insensitive. */
export function groupNameHasCode(name: string, clientCode: string): boolean {
  const code = clientCode.trim().toLowerCase();
  return code.length > 0 && name.toLowerCase().includes(code);
}

/** Checks a group name typed by hand. */
export function validateGroupName(name: string, clientCode: string): { ok: true } | { ok: false; error: string } {
  const n = (name ?? "").replace(/\s+/g, " ").trim();
  if (n.length < 3) return { ok: false, error: "Enter the group's name." };
  if (n.length > GROUP_NAME_MAX) return { ok: false, error: `WhatsApp group names are at most ${GROUP_NAME_MAX} characters.` };
  if (!groupNameHasCode(n, clientCode)) {
    return { ok: false, error: `Keep the client code ${clientCode} in the name: TaxWise Desktop finds the group by it.` };
  }
  return { ok: true };
}

// -------------------------------------------------------------------------------------------------
// The setup checklist (§7.25.2)
// -------------------------------------------------------------------------------------------------

export const CHECKLIST_STEPS = [
  {
    id: "group_name",
    title: "Group name",
    description: "Create the group on the creating number's phone with exactly this name. The client code makes it findable in WhatsApp search, and it is how TaxWise Desktop finds it.",
  },
  {
    id: "save_contacts",
    title: "Save the contacts first",
    description: "WhatsApp only adds saved contacts. Download the contact cards and open the file on the phone: it saves them in one tap.",
  },
  {
    id: "add_numbers",
    title: "Add these numbers",
    description: "Every active firm number marked \"in every client group\", plus the client contacts ticked here.",
  },
  {
    id: "group_settings",
    title: "Group settings",
    description: "Edit group settings → Only admins, so nobody else can rename the group (TaxWise Desktop finds it by name). Approve new participants → On. Disappearing messages → Off.",
  },
  {
    id: "managers_admin",
    title: "Make the Managers' office number an admin",
    description: "So the group never depends on one Partner's phone.",
  },
  {
    id: "welcome_message",
    title: "Post the welcome message",
    description: "Copy it into the group. It says who is in the group, that staff sign their messages, and gives the office phone for anything urgent.",
  },
  {
    id: "mark_created",
    title: "Mark the group created",
    description: "The date, the firm number that created it and the invite link. The group becomes Active and its members fill in from this checklist.",
  },
] as const;

export type ChecklistStepId = (typeof CHECKLIST_STEPS)[number]["id"];
export const CHECKLIST_STEP_IDS: readonly ChecklistStepId[] = CHECKLIST_STEPS.map((s) => s.id);
export const CHECKLIST_TOTAL = CHECKLIST_STEPS.length;

export function isChecklistStepId(v: unknown): v is ChecklistStepId {
  return typeof v === "string" && (CHECKLIST_STEP_IDS as readonly string[]).includes(v);
}

/** Who ticked a step and when (profiles.id, ISO timestamp). */
export interface ChecklistStamp {
  done: boolean;
  by: string | null;
  at: string | null;
}

export interface ChecklistState {
  steps: Record<ChecklistStepId, ChecklistStamp>;
  /** The client contacts ticked in step 3 (null: not chosen yet, so the primary contact is the default). */
  contactIds: string[] | null;
}

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function emptyStamp(): ChecklistStamp {
  return { done: false, by: null, at: null };
}

/** Reads `client_whatsapp_groups.checklist` whatever shape it is in; unknown keys are dropped. */
export function parseChecklist(json: unknown): ChecklistState {
  const steps = Object.fromEntries(CHECKLIST_STEP_IDS.map((id) => [id, emptyStamp()])) as Record<ChecklistStepId, ChecklistStamp>;
  let contactIds: string[] | null = null;
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const o = json as Record<string, unknown>;
    for (const id of CHECKLIST_STEP_IDS) {
      const v = o[id];
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      const s = v as Record<string, unknown>;
      steps[id] = {
        done: s.done === true,
        by: typeof s.by === "string" && UUIDISH.test(s.by) ? s.by : null,
        at: typeof s.at === "string" && !Number.isNaN(Date.parse(s.at)) ? s.at : null,
      };
      if (id === "add_numbers" && Array.isArray(s.contact_ids)) {
        contactIds = [...new Set(s.contact_ids.filter((x): x is string => typeof x === "string" && UUIDISH.test(x)))];
      }
    }
  }
  return { steps, contactIds };
}

/** The jsonb to store: exactly the seven step keys (so progress always counts out of seven). */
export function checklistToJson(state: ChecklistState): Record<ChecklistStepId, Record<string, unknown>> {
  const out = {} as Record<ChecklistStepId, Record<string, unknown>>;
  for (const id of CHECKLIST_STEP_IDS) {
    const s = state.steps[id] ?? emptyStamp();
    const entry: Record<string, unknown> = { done: s.done, by: s.by, at: s.at };
    if (id === "add_numbers" && state.contactIds !== null) entry.contact_ids = state.contactIds;
    out[id] = entry;
  }
  return out;
}

export function checklistProgress(checklist: ChecklistState | unknown): { done: number; total: number } {
  const state = isChecklistState(checklist) ? checklist : parseChecklist(checklist);
  const done = CHECKLIST_STEP_IDS.filter((id) => state.steps[id].done).length;
  return { done, total: CHECKLIST_TOTAL };
}

function isChecklistState(v: unknown): v is ChecklistState {
  return !!v && typeof v === "object" && "steps" in (v as object) && "contactIds" in (v as object);
}

/**
 * Ticks or unticks one step, stamped with who and when. Step 7 is ticked only by marking the group
 * created (it carries the date, the number and the members), so it is refused here.
 */
export function tickChecklist(state: ChecklistState, step: ChecklistStepId, done: boolean, by: string, at: string): ChecklistState {
  if (step === "mark_created") throw new RangeError("Mark the group created with its own form.");
  return {
    contactIds: state.contactIds,
    steps: { ...state.steps, [step]: done ? { done: true, by, at } : emptyStamp() },
  };
}

/** Stamps step 7 (done when the group was marked created). */
export function stampCreated(state: ChecklistState, by: string, at: string): ChecklistState {
  return { contactIds: state.contactIds, steps: { ...state.steps, mark_created: { done: true, by, at } } };
}

/** The first step not done yet, or null when all seven are. */
export function nextOpenStep(state: ChecklistState): ChecklistStepId | null {
  return CHECKLIST_STEP_IDS.find((id) => !state.steps[id].done) ?? null;
}

// -------------------------------------------------------------------------------------------------
// Firm numbers, client contacts and the numbers to add (§7.25.2 steps 2–3)
// -------------------------------------------------------------------------------------------------

export interface FirmNumberLike {
  id: string;
  label: string;
  kind: string;
  number: string | null;
  employee_id: string | null;
  in_every_client_group: boolean;
  group_admin: boolean;
  is_active: boolean;
  usable_by: readonly string[];
}

export interface ContactLike {
  id: string;
  name: string;
  role: string | null;
  whatsapp: string | null;
  phone: string | null;
  is_primary: boolean;
}

/** Every active firm number marked "in every client group", in display order (§7.25.2 step 3). */
export function groupFirmNumbers<N extends FirmNumberLike>(numbers: readonly N[]): N[] {
  return numbers.filter((n) => n.is_active && n.in_every_client_group && !!n.number).sort(compareFirmNumbers);
}

/** The contact's own WhatsApp digits (WhatsApp, else phone; never the client's), or null. */
export function contactWhatsAppDigits(contact: Pick<ContactLike, "whatsapp" | "phone">, countryCode?: string): string | null {
  return pickWhatsAppNumber(contact, null, { contactOnly: true, countryCode })?.digits ?? null;
}

/** Step 3's default: the primary contact, when they have a number WhatsApp can use. */
export function defaultSelectedContactIds(contacts: readonly ContactLike[], countryCode?: string): string[] {
  const primary = contacts.find((c) => c.is_primary) ?? null;
  return primary && contactWhatsAppDigits(primary, countryCode) ? [primary.id] : [];
}

const TITLES: Readonly<Record<string, string>> = {
  ca: "CA",
  cs: "CS",
  cma: "CMA",
  dr: "Dr",
  mr: "Mr",
  mrs: "Mrs",
  ms: "Ms",
  shri: "Shri",
  smt: "Smt",
  sri: "Sri",
};

/**
 * A Partner's name as their contact card has it: their title and first name, `CA Vinay H Karlagere`
 * → `CA Vinay`; a trailing "(Partner)" is dropped. Without a title, the first name.
 */
export function partnerShortName(fullName: string): string {
  const clean = fullName.replace(/\(\s*partner\s*\)/i, "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const first = firstNameOf(clean);
  if (!first) return clean;
  const title = TITLES[clean.split(" ")[0].replace(/\.$/, "").toLowerCase()];
  return title ? `${title} ${first}` : first;
}

/**
 * A firm number's contact card name (§7.25.2 step 2): `TW Partner – CA Vinay`, `TW Managers' office`,
 * `TW Staff office`; another firm number is `TW <label>`.
 */
export function firmNumberCardName(n: { kind: string; label: string }, ownerName?: string | null): string {
  switch (n.kind) {
    case "partner": {
      const who = partnerShortName(ownerName && ownerName.trim() ? ownerName : n.label) || n.label.trim();
      return `TW Partner – ${who}`;
    }
    case "managers_office":
      return "TW Managers' office";
    case "staff_office":
      return "TW Staff office";
    default:
      return `TW ${n.label.replace(/\s+/g, " ").trim()}`;
  }
}

/** A client contact's card name (§7.25.2 step 2): `XYZ Traders – Ramesh (Director)`. */
export function contactCardName(shortName: string, contact: { name: string; role: string | null }): string {
  const name = contact.name.replace(/\s+/g, " ").trim();
  const role = (contact.role ?? "").replace(/\s+/g, " ").trim();
  const client = shortName.replace(/\s+/g, " ").trim();
  return `${client} – ${name}${role ? ` (${role})` : ""}`;
}

/** One number to add to the group (step 3) and to save as a contact (step 2). */
export interface NumberToAdd {
  /** `firm:<id>` or `contact:<id>`. */
  key: string;
  kind: "firm_number" | "client_contact";
  /** firm_whatsapp_numbers.id or client_contacts.id. */
  refId: string;
  /** How the phone saves it (the vCard name). */
  cardName: string;
  /** The member's name as the group card shows it. */
  displayName: string;
  /** Normalised digits (E.164 without `+`). */
  digits: string;
  /** `+91 98765 43210`. */
  display: string;
  isAdmin: boolean;
  /** firm_whatsapp_numbers.kind for firm numbers. */
  firmKind: string | null;
}

export interface NumbersInput {
  firmNumbers: readonly FirmNumberLike[];
  contacts: readonly ContactLike[];
  /** The contacts ticked in step 3; null = the default (the primary contact). */
  selectedContactIds: readonly string[] | null;
  shortName: string;
  countryCode?: string;
  /** Names of the Partners who own partner numbers, by employees.id. */
  ownerNames?: ReadonlyMap<string, string>;
  /** The firm number that creates the group: WhatsApp makes it an admin. */
  createdByNumberId?: string | null;
}

/**
 * The numbers to add (§7.25.2 step 3): every active firm number "in every client group", then the
 * ticked client contacts that have a number WhatsApp can use. A number appears once (the first
 * holder wins), so a contact sharing a firm number is not listed twice.
 */
export function numbersToAdd(input: NumbersInput): NumberToAdd[] {
  const out: NumberToAdd[] = [];
  const seen = new Set<string>();
  for (const n of groupFirmNumbers(input.firmNumbers)) {
    const digits = n.number!;
    if (seen.has(digits)) continue;
    seen.add(digits);
    const owner = n.employee_id ? (input.ownerNames?.get(n.employee_id) ?? null) : null;
    out.push({
      key: `firm:${n.id}`,
      kind: "firm_number",
      refId: n.id,
      cardName: firmNumberCardName(n, owner),
      displayName: n.label.replace(/\s+/g, " ").trim(),
      digits,
      display: formatWhatsAppNumber(digits),
      isAdmin: n.group_admin || (!!input.createdByNumberId && n.id === input.createdByNumberId),
      firmKind: n.kind,
    });
  }
  const selected = new Set(input.selectedContactIds ?? defaultSelectedContactIds(input.contacts, input.countryCode));
  const contacts = [...input.contacts].sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || a.name.localeCompare(b.name, "en-IN"));
  for (const c of contacts) {
    if (!selected.has(c.id)) continue;
    const digits = contactWhatsAppDigits(c, input.countryCode);
    if (!digits || seen.has(digits)) continue;
    seen.add(digits);
    const role = (c.role ?? "").trim();
    out.push({
      key: `contact:${c.id}`,
      kind: "client_contact",
      refId: c.id,
      cardName: contactCardName(input.shortName, c),
      displayName: `${c.name.replace(/\s+/g, " ").trim()}${role ? ` (${role})` : ""}`,
      digits,
      display: formatWhatsAppNumber(digits),
      isAdmin: false,
      firmKind: null,
    });
  }
  return out;
}

/** "Copy all" (step 3): one number per line, as `+91 98765 43210`. */
export function copyAllNumbersText(list: readonly Pick<NumberToAdd, "display">[]): string {
  return list.map((n) => n.display).join("\n");
}

/** A member row to insert when the group is marked created (§7.25.2 step 7). */
export interface MemberDraft {
  kind: "firm_number" | "client_contact";
  firm_number_id: string | null;
  contact_id: string | null;
  display_name: string;
  number: string;
  is_admin: boolean;
}

/** The members a group gets from its checklist (§7.25.2 step 7): the step 3 list, as rows. */
export function membersFromChecklist(input: NumbersInput): MemberDraft[] {
  return numbersToAdd(input).map((n) => ({
    kind: n.kind,
    firm_number_id: n.kind === "firm_number" ? n.refId : null,
    contact_id: n.kind === "client_contact" ? n.refId : null,
    display_name: n.displayName.slice(0, 200),
    number: n.digits,
    is_admin: n.isAdmin,
  }));
}

// -------------------------------------------------------------------------------------------------
// Contact cards: vCard 3.0 (RFC 2426)
// -------------------------------------------------------------------------------------------------

export const VCARD_CONTENT_TYPE = "text/vcard; charset=utf-8";

/** Escapes a vCard text value: backslash, comma, semicolon and line breaks (RFC 2426 §4). */
export function escapeVCardText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n?|\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

const encoder = new TextEncoder();

/**
 * Folds a content line at 75 octets (UTF-8), never inside a character: continuation lines start
 * with one space (RFC 2425 §5.8.1).
 */
export function foldVCardLine(line: string): string {
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let size = 0;
  let limit = 75;
  for (const ch of line) {
    const n = encoder.encode(ch).length;
    if (size + n > limit) {
      parts.push(current);
      current = "";
      size = 0;
      limit = 74; // the leading space of a continuation line counts
    }
    current += ch;
    size += n;
  }
  if (current) parts.push(current);
  return parts.join("\r\n ");
}

export interface VCardInput {
  /** The name the phone saves: `XYZ Traders – Ramesh (Director)`. */
  fullName: string;
  /** Normalised digits (E.164 without `+`). */
  digits: string;
  org?: string | null;
  note?: string | null;
}

/** One vCard 3.0, CRLF line endings, folded and escaped. */
export function buildVCard(card: VCardInput): string {
  if (!/^[1-9]\d{7,14}$/.test(card.digits)) throw new RangeError("A contact card needs a normalised number (8–15 digits).");
  const name = escapeVCardText(card.fullName.replace(/\s+/g, " ").trim());
  const lines = ["BEGIN:VCARD", "VERSION:3.0", `N:;${name};;;`, `FN:${name}`];
  if (card.org && card.org.trim()) lines.push(`ORG:${escapeVCardText(card.org.replace(/\s+/g, " ").trim())}`);
  lines.push(`TEL;TYPE=CELL:+${card.digits}`);
  if (card.note && card.note.trim()) lines.push(`NOTE:${escapeVCardText(card.note.trim())}`);
  lines.push("END:VCARD");
  return lines.map(foldVCardLine).join("\r\n") + "\r\n";
}

/** Several cards in one `.vcf` file (a phone imports them in one go). */
export function buildVCardFile(cards: readonly VCardInput[]): string {
  return cards.map(buildVCard).join("");
}

/** The cards for the step 2 download: every number to add, named for the phone. */
export function contactCards(list: readonly NumberToAdd[], opts: { firmName: string; clientName: string }): VCardInput[] {
  return list.map((n) => ({
    fullName: n.cardName,
    digits: n.digits,
    org: n.kind === "firm_number" ? opts.firmName : opts.clientName,
  }));
}

/** `TW-C-0142-whatsapp-contacts.vcf` (ASCII only, safe in Content-Disposition). */
export function vcfFileName(clientCode: string, set: "all" | "client" | "firm" = "all"): string {
  const code = clientCode.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "client";
  const suffix = set === "client" ? "client-contacts" : set === "firm" ? "firm-numbers" : "whatsapp-contacts";
  return `${code}-${suffix}.vcf`;
}

// -------------------------------------------------------------------------------------------------
// The welcome message (§7.25.2 step 6, §16)
// -------------------------------------------------------------------------------------------------

export const WELCOME_TEMPLATE_NAME = "WhatsApp group welcome";
/** The §16 text, used if the template is missing or switched off. */
export const DEFAULT_WELCOME_TEMPLATE =
  "Welcome to the {{firm_name}} group for {{client_name}}. Our Partners, our Managers' desk and our team desk are all here, and our team sign their messages with their name. For anything urgent, please call {{firm_phone}}.";

export function renderWelcomeMessage(
  body: string | null | undefined,
  values: { firmName: string; clientName: string; clientCode?: string | null; firmPhone: string | null; senderName?: string | null },
): string {
  const text = body && body.trim() ? body : DEFAULT_WELCOME_TEMPLATE;
  return renderTemplate(text, {
    firm_name: values.firmName,
    client_name: values.clientName,
    client_code: values.clientCode ?? null,
    firm_phone: values.firmPhone,
    sender_name: values.senderName ?? null,
  }).trim();
}

// -------------------------------------------------------------------------------------------------
// Invite links (§5.13: Partner/Manager only; TaxWise Desktop gets only the code)
// -------------------------------------------------------------------------------------------------

/** The code part of chat.whatsapp.com/<code>: 10–40 letters and digits (docs/DESKTOP-API.md). */
export const INVITE_CODE_PATTERN = /^[A-Za-z0-9]{10,40}$/;

/** The code of a chat.whatsapp.com invite link, or null when it isn't one. */
export function inviteCodeFromLink(link: string | null | undefined): string | null {
  const raw = (link ?? "").trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "chat.whatsapp.com" || url.username || url.password || url.port) return null;
  const code = url.pathname.replace(/^\/+|\/+$/g, "");
  return INVITE_CODE_PATTERN.test(code) ? code : null;
}

/** `https://chat.whatsapp.com/<code>` from whatever was pasted (a link with or without https, or the code), or null. */
export function normaliseInviteLink(input: string | null | undefined): string | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  const code = INVITE_CODE_PATTERN.test(raw) ? raw : inviteCodeFromLink(raw);
  return code ? `https://chat.whatsapp.com/${code}` : null;
}

// -------------------------------------------------------------------------------------------------
// TaxWise Desktop (§7.25.4, §7.25.7, docs/DESKTOP-API.md)
// -------------------------------------------------------------------------------------------------

/** X-TaxWise-Device: 64 lowercase hex characters. */
export const DEVICE_KEY_PATTERN = /^[0-9a-f]{64}$/;
/** Ids the app accepts (uuids are fine). */
export const DESKTOP_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
/** X-TaxWise-Desktop: the app's version. */
export const DESKTOP_VERSION_PATTERN = /^[0-9A-Za-z.+_-]{1,40}$/;

export function isDeviceKey(v: unknown): v is string {
  return typeof v === "string" && DEVICE_KEY_PATTERN.test(v);
}

/** A number as the desktop context sends it. */
export interface ContextNumber {
  id: string;
  label: string;
  kind: WhatsAppNumberKind;
  usableBy: DesktopRole[];
  ownerEmployeeId: string | null;
}

/**
 * The firm numbers a person may use in TaxWise Desktop (§7.25.4, docs/DESKTOP-API.md): active
 * numbers whose `usable_by` holds their role, except that a number with an owner (`employee_id`) is
 * returned only to that Partner. Clients get none. Display order.
 */
export function contextNumbers(rows: readonly FirmNumberLike[], role: string, employeeId: string | null): ContextNumber[] {
  if (!(DESKTOP_ROLES as readonly string[]).includes(role)) return [];
  return rows
    .filter((n) => n.is_active && !!n.number && n.usable_by.includes(role))
    .filter((n) => (n.employee_id ? role === "partner" && !!employeeId && n.employee_id === employeeId : true))
    .filter((n) => (WHATSAPP_NUMBER_KINDS as readonly string[]).includes(n.kind) && DESKTOP_ID_PATTERN.test(n.id))
    .sort(compareFirmNumbers)
    .map((n) => ({
      id: n.id,
      label: n.label,
      kind: n.kind as WhatsAppNumberKind,
      usableBy: n.usable_by.filter((r): r is DesktopRole => (DESKTOP_ROLES as readonly string[]).includes(r)),
      ownerEmployeeId: n.employee_id,
    }));
}

/**
 * The number Open chat uses (docs/DESKTOP-API.md 2): an Employee the Staff office; a Manager the
 * Managers' office (then the Staff office if they may use it); a Partner their own number if it is
 * in the group, else the Managers' office. Always one of `numbers` (the person's context numbers);
 * among numbers of one kind, one that is in the group first. Null when there is none.
 */
export function chooseOpenNumber(
  role: string,
  employeeId: string | null,
  numbers: readonly ContextNumber[],
  memberNumberIds: ReadonlySet<string>,
): string | null {
  if (numbers.length === 0) return null;
  const ofKind = (kind: WhatsAppNumberKind) => {
    const list = numbers.filter((n) => n.kind === kind);
    return list.find((n) => memberNumberIds.has(n.id)) ?? list[0] ?? null;
  };
  const inGroup = numbers.find((n) => memberNumberIds.has(n.id)) ?? null;
  const own = role === "partner" && employeeId ? numbers.find((n) => n.kind === "partner" && n.ownerEmployeeId === employeeId) ?? null : null;
  let pick: ContextNumber | null = null;
  if (role === "employee") pick = ofKind("staff_office") ?? inGroup;
  else if (role === "manager") pick = ofKind("managers_office") ?? ofKind("staff_office") ?? inGroup;
  else if (role === "partner") pick = (own && memberNumberIds.has(own.id) ? own : null) ?? ofKind("managers_office") ?? own ?? inGroup;
  return (pick ?? numbers[0]).id;
}

/** PCs not seen for this many days are flagged for unlinking (§7.25.7). */
export const STALE_DEVICE_DAYS = 30;

/** Whole days since `at` (0 when in the future or missing). */
export function daysSince(at: string | null | undefined, now: Date): number {
  if (!at) return 0;
  const t = Date.parse(at);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

/** True for a PC not seen (or, if never seen, not checked in) for 30 days or more. */
export function isDeviceStale(device: { last_seen_at: string | null; created_at?: string | null }, now: Date, days = STALE_DEVICE_DAYS): boolean {
  const ref = device.last_seen_at ?? device.created_at ?? null;
  if (!ref) return false;
  return daysSince(ref, now) >= days;
}

/** `Staff office: 3 of 4` (§7.25.1). */
export function linkedLabel(label: string, active: number, limit: number | null): string {
  return limit ? `${label}: ${active} of ${limit}` : `${label}: ${active}`;
}

/** The device limits Settings offers (§7.25.7): WhatsApp's 4, or 10 with Meta Verified multi-agent. */
export const DEVICE_LIMIT_OPTIONS = [4, 10] as const;

// -------------------------------------------------------------------------------------------------
// Open chat without the desktop app (§7.25.8)
// -------------------------------------------------------------------------------------------------

export const WHATSAPP_WEB_URL = "https://web.whatsapp.com/";
/** One window, reused, so windows don't multiply. */
export const WHATSAPP_WINDOW_NAME = "taxwise-whatsapp";
/** Opens the WhatsApp app on a phone [verify]. */
export const WHATSAPP_APP_URL = "whatsapp://";

export interface ScreenLike {
  availWidth: number;
  availHeight: number;
  availLeft?: number;
  availTop?: number;
}

/** `popup,width=<half the screen>,height=<screen height>,left=<half the screen>,top=0` (§7.25.8). */
export function whatsappWindowFeatures(screen: ScreenLike): string {
  const width = Math.max(360, Math.floor(screen.availWidth / 2));
  const height = Math.max(400, Math.floor(screen.availHeight));
  const left = Math.max(0, Math.floor((screen.availLeft ?? 0) + screen.availWidth / 2));
  const top = Math.max(0, Math.floor(screen.availTop ?? 0));
  return `popup,width=${width},height=${height},left=${left},top=${top}`;
}

/** "Last opened 2 hours ago by Anita" (§7.25.1). */
export function lastOpenedSentence(at: string | null | undefined, byName: string | null | undefined, now: Date = new Date()): string {
  if (!at) return "Not opened from the CRM yet";
  const who = byName ? firstNameOf(byName) || byName.trim() : "";
  return `Last opened ${formatTimeAgo(at, now)}${who ? ` by ${who}` : ""}`;
}

// -------------------------------------------------------------------------------------------------
// The register (WhatsApp groups page, §7.25.1)
// -------------------------------------------------------------------------------------------------

/** Register filter values: clients with no group yet, then the group statuses. */
export const REGISTER_STATUSES = ["none", "to_create", "active", "closed"] as const;
export type RegisterStatus = (typeof REGISTER_STATUSES)[number];

export const REGISTER_STATUS_LABEL: Record<RegisterStatus, string> = {
  none: "No group yet",
  to_create: "To create",
  active: "Active",
  closed: "Closed",
};

// -------------------------------------------------------------------------------------------------
// Weekly housekeeping (§8 Mon 08:45)
// -------------------------------------------------------------------------------------------------

/** Clients onboarded this many days ago or more without a WhatsApp group are reminded (§9). */
export const GROUP_MISSING_AFTER_DAYS = 2;

/** ISO week key `2026-W43` (Monday-based), for once-a-week dedupe keys. */
export function isoWeekKey(date: DateString): string {
  const { year, month, day } = parseDateString(date);
  const d = new Date(Date.UTC(year, month - 1, day));
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow);
  const isoYear = d.getUTCFullYear();
  const jan1 = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((d.getTime() - jan1) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** True when a client onboarded on `onboardedOn` (IST date) is due its "no WhatsApp group" reminder on `today`. */
export function groupReminderDue(onboardedOn: DateString | null, today: DateString): boolean {
  if (!onboardedOn) return false;
  return compareDates(addDays(onboardedOn, GROUP_MISSING_AFTER_DAYS), today) <= 0;
}

/** A device review is due when the number was never reviewed or not in the last 7 days. */
export function devicesReviewDue(reviewedAt: string | null | undefined, now: Date): boolean {
  if (!reviewedAt) return true;
  return daysSince(reviewedAt, now) >= 7;
}

