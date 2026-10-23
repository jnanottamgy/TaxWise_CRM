import { z } from "zod";
import {
  COMPLIANCE_TYPES,
  COMPLIANCE_TYPE_LABELS,
  DECLINE_REASON_LABELS,
  LEAVE_TYPE_LABELS,
  SERVICE_TYPES,
  SERVICE_TYPE_LABELS,
  type ComplianceType,
  type DeclineReason,
  type LeaveType,
  type NotificationType,
  type ServiceType,
} from "@/lib/domain/enums";
import { addDays, diffDays, isDateString, istDateOf, type DateString } from "@/lib/domain/fy";
import { applySignature, firstNameOf, normalizeWhatsAppNumber, pickContactForService } from "@/lib/domain/messaging";
import { renderTemplate, type TemplateValues } from "@/lib/domain/templates";
import { formatDate, formatMoney, formatTimeAgo } from "@/lib/format";
import { NOTIFICATION_EVENTS, type NotificationEvent } from "@/lib/schemas/profile";
import type { AppRole } from "@/lib/auth/roles";

/**
 * The Inbox (§7.17), staff message threads (§7.13.1, /messages, Client 360 → Communication) and the
 * bulk WhatsApp reminder queue (§7.13.2): the schemas shared by forms and actions, and the pure
 * helpers the screens use (what each action item says, how a thread is laid out, how a reminder
 * draft is filled in). Client-safe.
 */

// =================================================================================================
// Needs your action (inbox_action_items, 0172)
// =================================================================================================

export const ACTION_KINDS = [
  "invoice_approval",
  "quotation_approval",
  "leave_approval",
  "review",
  "acceptance",
  "declined",
  "client_message",
  "data_request",
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export function isActionKind(v: unknown): v is ActionKind {
  return typeof v === "string" && (ACTION_KINDS as readonly string[]).includes(v);
}

/** One row of inbox_action_items. */
export type ActionItem = {
  kind: ActionKind;
  entity_type: string;
  entity_id: string;
  client_id: string | null;
  client_name: string | null;
  reference: string | null;
  title: string | null;
  person_name: string | null;
  /** Only on the Partner-only approval rows. */
  amount: number | string | null;
  due_date: string | null;
  since: string;
  reason: string | null;
  note: string | null;
  item_count: number | null;
  link_url: string;
};

/** Each kind's heading, what it means, and the list behind it (dashboards link to the same filters). */
export const ACTION_KIND_META: Record<ActionKind, { label: string; explain: string; viewAll: string; viewAllLabel: string }> = {
  invoice_approval: {
    label: "Invoices to approve",
    explain: "Invoices over the approval limit wait for a Partner before they can be sent.",
    viewAll: "/invoices?status=awaiting_approval",
    viewAllLabel: "All invoices awaiting approval",
  },
  quotation_approval: {
    label: "Quotations to approve",
    explain: "Quotations over the quotation approval limit wait for a Partner before they can be sent.",
    viewAll: "/quotations?status=pending_approval",
    viewAllLabel: "All quotations pending approval",
  },
  leave_approval: {
    label: "Leave to decide",
    explain: "Leave requests waiting for you to approve or decline.",
    viewAll: "/leave?status=requested",
    viewAllLabel: "All leave requests",
  },
  review: {
    label: "Waiting for your review",
    explain: "Work submitted Under review with you as the reviewer, or with no named reviewer.",
    viewAll: "/work?view=review",
    viewAllLabel: "Your review queue",
  },
  acceptance: {
    label: "Waiting for you to accept",
    explain: "Tasks assigned to you. Accept them, or decline with a reason so your Manager can reassign.",
    viewAll: "/work?assignee=me&acceptance=pending",
    viewAllLabel: "All tasks waiting for acceptance",
  },
  declined: {
    label: "Declined, to reassign",
    explain: "Tasks the assignee declined. They have nobody on them until someone reassigns them.",
    viewAll: "/work?acceptance=declined&assignee=none",
    viewAllLabel: "All declined tasks",
  },
  client_message: {
    label: "Client messages",
    explain: "Portal messages from your clients that nobody at the firm has read yet.",
    viewAll: "/messages?unread=1",
    viewAllLabel: "All unread threads",
  },
  data_request: {
    label: "Data requests",
    explain: "Requests under the DPDP Act (access, correction, erasure, grievance, nomination) that are still open.",
    viewAll: "/quality?tab=data-requests",
    viewAllLabel: "All data requests",
  },
};

/** How many rows each kind shows in the Inbox before "View all". */
export const ACTION_ROWS_PER_KIND = 5;

export type ActionGroup = { kind: ActionKind; total: number; items: ActionItem[] };

/** Groups action items by kind, in ACTION_KINDS order, newest first within a kind, capped per kind. */
export function groupActionItems(items: readonly ActionItem[], perKind = ACTION_ROWS_PER_KIND): ActionGroup[] {
  const out: ActionGroup[] = [];
  for (const kind of ACTION_KINDS) {
    const rows = items.filter((i) => i.kind === kind).sort((a, b) => Date.parse(b.since) - Date.parse(a.since));
    if (rows.length > 0) out.push({ kind, total: rows.length, items: rows.slice(0, perKind) });
  }
  return out;
}

const DATA_REQUEST_LABELS: Record<string, string> = {
  access: "Access request",
  correction: "Correction request",
  erasure: "Erasure request",
  grievance: "Grievance",
  nomination: "Nomination",
};

export type ActionItemView = {
  /** The identity: the task, the client, the person on leave. */
  primary: string;
  /** Grey second line, already joined with " · ". */
  secondary: string;
  /** The key fact at the right. */
  trailing: { kind: "due"; date: DateString } | { kind: "amount"; text: string } | { kind: "ago"; text: string } | { kind: "date"; text: string } | null;
  /** Shown to screen readers and on hover: what to do. */
  verb: string;
};

const join = (parts: Array<string | null | undefined | false>) => parts.filter((p): p is string => typeof p === "string" && p.trim().length > 0).join(" · ");

/** What an action item says (pure; `now` for "2 hours ago"). */
export function describeActionItem(item: ActionItem, now: Date = new Date()): ActionItemView {
  const due = item.due_date && isDateString(item.due_date) ? item.due_date : null;
  switch (item.kind) {
    case "invoice_approval":
      return {
        primary: item.client_name ?? "Invoice",
        secondary: join([item.reference ? `Invoice ${item.reference}` : "Invoice not yet numbered", item.title, item.person_name ? `raised by ${item.person_name}` : null, item.note ? `last returned: ${item.note}` : null]),
        trailing: item.amount !== null && item.amount !== undefined ? { kind: "amount", text: formatMoney(item.amount) } : null,
        verb: "Approve or return",
      };
    case "quotation_approval":
      return {
        primary: item.client_name ?? "Quotation",
        secondary: join([item.reference ? `Quotation ${item.reference}` : "Quotation", item.person_name ? `prepared by ${item.person_name}` : null, due ? `valid until ${formatDate(due)}` : null]),
        trailing: item.amount !== null && item.amount !== undefined ? { kind: "amount", text: formatMoney(item.amount) } : null,
        verb: "Approve or return",
      };
    case "leave_approval": {
      const type = item.title && item.title in LEAVE_TYPE_LABELS ? LEAVE_TYPE_LABELS[item.title as LeaveType] : null;
      const days = item.reason === "half_day" ? "Half day" : item.item_count ? `${item.item_count} ${item.item_count === 1 ? "day" : "days"}` : null;
      return {
        primary: item.person_name ?? "Leave request",
        secondary: join([type ? `${type} leave` : "Leave", days, item.note]),
        trailing: due ? { kind: "date", text: `from ${formatDate(due)}` } : null,
        verb: "Approve or decline",
      };
    }
    case "review":
      return {
        primary: item.title ?? "Task",
        secondary: join([item.reference, item.client_name, item.person_name ? `from ${item.person_name}` : null]),
        trailing: due ? { kind: "due", date: due } : null,
        verb: "Review: file it or send it back",
      };
    case "acceptance":
      return {
        primary: item.title ?? "Task",
        secondary: join([item.reference, item.client_name, item.person_name ? `assigned by ${item.person_name}` : null]),
        trailing: due ? { kind: "due", date: due } : null,
        verb: "Accept or decline",
      };
    case "declined": {
      const reason = item.reason && item.reason in DECLINE_REASON_LABELS ? DECLINE_REASON_LABELS[item.reason as DeclineReason] : null;
      return {
        primary: item.title ?? "Task",
        secondary: join([item.reference, item.client_name, item.person_name ? `declined by ${item.person_name}` : "declined", reason ? (item.note ? `${reason}: ${item.note}` : reason) : item.note]),
        trailing: due ? { kind: "due", date: due } : null,
        verb: "Reassign",
      };
    }
    case "client_message": {
      const n = item.item_count ?? 1;
      return {
        primary: item.client_name ?? "Client",
        secondary: join([`${n} unread ${n === 1 ? "message" : "messages"}`, item.title, item.note ? item.note.replace(/\s+/g, " ").slice(0, 120) : null]),
        trailing: { kind: "ago", text: formatTimeAgo(item.since, now) },
        verb: "Read and reply",
      };
    }
    case "data_request":
      return {
        primary: item.title ?? "Data request",
        secondary: join([item.reference ? (DATA_REQUEST_LABELS[item.reference] ?? item.reference) : "Data request", `received ${formatDate(istDateOf(item.since))}`, item.reason && item.reason !== "open" ? item.reason.replace(/_/g, " ") : null]),
        trailing: due ? { kind: "due", date: due } : null,
        verb: "Respond",
      };
  }
}

// =================================================================================================
// Updates (inbox_notifications, 0172)
// =================================================================================================

export const NOTIFICATION_GROUP_SLUGS = {
  work: "Work",
  clients: "Clients and compliance",
  money: "Money",
  team: "Team",
  whatsapp: "WhatsApp and security",
  general: "General",
} as const satisfies Record<string, NotificationEvent["group"]>;
export type NotificationGroupSlug = keyof typeof NOTIFICATION_GROUP_SLUGS;

/** The notification types in a group (Profile → Notifications uses the same groups). */
export function notificationTypesInGroup(slug: NotificationGroupSlug): NotificationType[] {
  const name = NOTIFICATION_GROUP_SLUGS[slug];
  return NOTIFICATION_EVENTS.filter((e) => e.group === name).map((e) => e.type);
}

/** The groups a role can receive (Employees never get money notices, §4.1). */
export function notificationGroupsFor(role: AppRole): NotificationGroupSlug[] {
  const types = new Set(NOTIFICATION_EVENTS.filter((e) => e.roles.includes(role)).map((e) => e.group));
  return (Object.keys(NOTIFICATION_GROUP_SLUGS) as NotificationGroupSlug[]).filter((s) => types.has(NOTIFICATION_GROUP_SLUGS[s]));
}

/** The group a notification type belongs to. */
export function notificationGroupOf(type: string): NotificationGroupSlug {
  const event = NOTIFICATION_EVENTS.find((e) => e.type === type);
  const slug = (Object.keys(NOTIFICATION_GROUP_SLUGS) as NotificationGroupSlug[]).find((s) => NOTIFICATION_GROUP_SLUGS[s] === event?.group);
  return slug ?? "general";
}

export const INBOX_SHOW = ["inbox", "unread", "archived"] as const;
export type InboxShow = (typeof INBOX_SHOW)[number];

export const INBOX_FILTERS = {
  show: INBOX_SHOW as readonly string[],
  group: Object.keys(NOTIFICATION_GROUP_SLUGS) as readonly string[],
};
export const INBOX_FILTER_NAMES = Object.keys(INBOX_FILTERS);

export const NOTIFICATION_ACTIONS = ["read", "unread", "archived", "unarchived"] as const;
export type NotificationAction = (typeof NOTIFICATION_ACTIONS)[number];

export const MAX_NOTIFICATIONS_PER_CALL = 500;

const ids = z
  .array(z.uuid({ error: "That notification id isn't valid." }))
  .min(1, { error: "Choose at least one notification." })
  .max(MAX_NOTIFICATIONS_PER_CALL, { error: `Choose at most ${MAX_NOTIFICATIONS_PER_CALL} notifications at a time.` });

export const MarkNotificationsSchema = z.object({ ids, action: z.enum(NOTIFICATION_ACTIONS) });
export type MarkNotificationsInput = z.input<typeof MarkNotificationsSchema>;

export const NotificationIdsSchema = z.object({ ids });

export const EmptySchema = z.object({});

export const OpenEntitySchema = z.object({
  entityType: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, { error: "That isn't a record type the app knows." }),
  entityId: z.uuid({ error: "That record id isn't valid." }),
});

/** The words for what a bulk change did ("3 marked read"). */
export function notificationActionResult(action: NotificationAction, count: number): string {
  const n = `${count} ${count === 1 ? "notification" : "notifications"}`;
  switch (action) {
    case "read":
      return count ? `${n} marked read.` : "Already read.";
    case "unread":
      return count ? `${n} marked unread.` : "Already unread.";
    case "archived":
      return count ? `${n} archived.` : "Already archived.";
    case "unarchived":
      return count ? `${n} moved back to the inbox.` : "Already in the inbox.";
  }
}

/** A notification's link is an in-app path (insert_notifications only stores those); anything else goes to the Inbox. */
export function safeInboxLink(link: string | null | undefined): string {
  return typeof link === "string" && /^\/(?![/\\])/.test(link) ? link : "/inbox";
}

// =================================================================================================
// Threads (message_threads, 0173; Client 360 → Communication)
// =================================================================================================

/** The Communication tab's channel filter (`?comm_channel=`). */
export const COMM_CHANNEL_FILTERS = {
  email: { label: "Email", channels: ["email"] },
  whatsapp: { label: "WhatsApp", channels: ["whatsapp_handoff"] },
  gmail: { label: "Gmail", channels: ["gmail_handoff"] },
  portal: { label: "Portal", channels: ["portal"] },
  calls: { label: "Calls and notes", channels: ["call_log", "internal_note"] },
} as const;
export type CommChannelFilter = keyof typeof COMM_CHANNEL_FILTERS;

export function isCommChannelFilter(v: unknown): v is CommChannelFilter {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(COMM_CHANNEL_FILTERS, v);
}

/** Messages per page of a thread; "Show older" adds another page. */
export const THREAD_PAGE = 40;
export const THREAD_MAX_PAGES = 10;

/** The /messages list's filters. */
export const THREAD_FILTERS = {
  unread: ["1"] as readonly string[],
  mine: ["1"] as readonly string[],
};
export const THREAD_FILTER_NAMES = Object.keys(THREAD_FILTERS);

export type ThreadMessage = {
  id: string;
  channel: string;
  direction: "inbound" | "outbound";
  status: string;
  subject: string | null;
  body: string;
  recipient: string | null;
  /** When it happened (a logged call's time), else when it was recorded. */
  at: string;
  created_at: string;
  sent_by: string | null;
  /** The staff member who sent or logged it; null for the client's own portal messages. */
  sender_name: string | null;
  contact_name: string | null;
  template_name: string | null;
  related_entity_type: string | null;
  read_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
  error: string | null;
  attachments: Array<{ id: string; title: string }>;
};

export type ThreadEntry =
  | { kind: "day"; key: string; label: string }
  | { kind: "new"; key: string }
  | { kind: "message"; key: string; message: ThreadMessage; mine: boolean };

/** "Today", "Yesterday" or "22 Oct 2026" for a day divider (IST). */
export function dayLabel(date: DateString, today: DateString): string {
  if (date === today) return "Today";
  if (date === addDays(today, -1)) return "Yesterday";
  return formatDate(date);
}

/**
 * Lays a thread out oldest first: a divider at each IST day, and a "New" marker before the first
 * message someone else added after `newSince` (when this person last opened the thread; null when
 * they never have, which marks nothing so a first visit isn't one long "new" block).
 */
export function threadEntries(messages: readonly ThreadMessage[], opts: { newSince: string | null; me: string; today: DateString }): ThreadEntry[] {
  const sorted = [...messages].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id));
  const out: ThreadEntry[] = [];
  let lastDay: string | null = null;
  let newPlaced = false;
  const since = opts.newSince ? Date.parse(opts.newSince) : null;
  for (const m of sorted) {
    const day = istDateOf(m.created_at);
    if (day !== lastDay) {
      out.push({ kind: "day", key: `day-${day}`, label: dayLabel(day, opts.today) });
      lastDay = day;
    }
    const mine = m.sent_by === opts.me && m.direction === "outbound";
    if (!newPlaced && since !== null && !mine && Date.parse(m.created_at) > since) {
      out.push({ kind: "new", key: `new-${m.id}` });
      newPlaced = true;
    }
    out.push({ kind: "message", key: m.id, message: m, mine });
  }
  return out;
}

/** Who a message is from, as the thread says it. */
export function senderLabel(m: Pick<ThreadMessage, "direction" | "channel" | "sender_name" | "contact_name">, clientName: string): string {
  if (m.direction === "inbound") {
    if (m.channel === "portal") return m.contact_name ? `${m.contact_name} (portal)` : `${clientName} (portal)`;
    if (m.channel === "call_log") return m.contact_name ? `${m.contact_name} called` : `${clientName} called`;
    return m.contact_name ?? clientName;
  }
  return m.sender_name ?? "The firm";
}

export const REPLY_BODY_MAX = 5000;

const optionalUuid = z.union([z.uuid(), z.literal(""), z.null()]).optional().transform((v) => (v ? v : null));

export const PortalReplySchema = z.object({
  clientId: z.uuid({ error: "Choose the client." }),
  body: z.string().trim().min(1, { error: "Write the message." }).max(REPLY_BODY_MAX, { error: `Keep the message under ${REPLY_BODY_MAX.toLocaleString("en-IN")} characters.` }),
  templateId: optionalUuid,
});
export type PortalReplyInput = z.input<typeof PortalReplySchema>;

export const ThreadClientSchema = z.object({ clientId: z.uuid({ error: "Choose the client." }) });

// =================================================================================================
// Bulk WhatsApp reminders (§7.13.2 "for a filtered list … the app builds a queue of personalised
// drafts. The user steps through them … each logged. Nothing is sent without a person pressing Send.")
// =================================================================================================

export const BULK_SOURCE_KINDS = ["data_awaited", "compliance_due", "document_requests"] as const;
export type BulkSourceKind = (typeof BULK_SOURCE_KINDS)[number];

export const BULK_SOURCE_LABELS: Record<BulkSourceKind, { label: string; hint: string; templateType: "document_reminder" | "compliance_reminder" }> = {
  data_awaited: { label: "Data awaited", hint: "Tasks in Data awaited: ask for what's still missing.", templateType: "document_reminder" },
  compliance_due: { label: "Compliance due soon", hint: "Pending returns and filings due in the next few days.", templateType: "compliance_reminder" },
  document_requests: { label: "Pending document requests", hint: "Document requests with items still to upload.", templateType: "document_reminder" },
};

export const BULK_MAX_STEPS = 200;

const idList = z.array(z.uuid()).min(1, { error: "Choose at least one." }).max(BULK_MAX_STEPS, { error: `Choose at most ${BULK_MAX_STEPS} at a time.` });

export const BulkSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("data_awaited"), service: z.enum(SERVICE_TYPES).nullish().transform((v) => v ?? null), mine: z.boolean().default(false) }),
  z.object({
    kind: z.literal("compliance_due"),
    withinDays: z.coerce.number().int({ error: "Whole days only." }).min(0, { error: "Zero or more days." }).max(60, { error: "At most 60 days ahead." }).default(7),
    complianceType: z.enum(COMPLIANCE_TYPES).nullish().transform((v) => v ?? null),
    mine: z.boolean().default(false),
  }),
  z.object({ kind: z.literal("document_requests"), mine: z.boolean().default(false) }),
  /** Launched from another module's list: these tasks (Data awaited), events or requests. */
  z.object({ kind: z.literal("tasks"), ids: idList }),
  z.object({ kind: z.literal("compliance_events"), ids: idList }),
  z.object({ kind: z.literal("request_ids"), ids: idList }),
]);
export type BulkSource = z.input<typeof BulkSourceSchema>;

export const PrepareQueueSchema = z.object({ source: BulkSourceSchema, templateId: optionalUuid });
export type PrepareQueueInput = z.input<typeof PrepareQueueSchema>;

/** One reminder in the queue. */
export type QueueStep = {
  key: string;
  clientId: string;
  clientName: string;
  contactId: string | null;
  contactName: string | null;
  /** Normalised WhatsApp digits, or null ("no WhatsApp number"). */
  number: string | null;
  /** What the reminder is about: "GSTR-3B · Sep 2026". */
  label: string;
  draft: string;
  templateId: string | null;
  related: { type: string; id: string } | null;
};

/** A reminder that couldn't go in the queue, and why. */
export type QueueSkip = { clientName: string; label: string; reason: string };

export type QueueFacts = {
  kind: "data_awaited" | "compliance_due" | "document_request";
  clientName: string;
  clientCode: string;
  contactName: string | null;
  serviceType: ServiceType | null;
  complianceType: ComplianceType | null;
  /** The form or title, e.g. "GSTR-3B" (falls back to the compliance type's label). */
  formLabel: string | null;
  period: string | null;
  dueDate: DateString | null;
  taskTitle: string | null;
  priority: string | null;
  missing: readonly string[];
  portalLink: string;
};

export type QueueContext = {
  firmName: string;
  firmPhone: string | null;
  senderName: string;
  today: DateString;
  countryCode: string;
  /** The sender's signature on shared numbers (§7.13.2), or null when they don't add it. */
  signature: { format: string } | null;
};

/** The default drafts (§7.13.2 "Where it appears, and the default draft"). */
export const DEFAULT_QUEUE_DRAFTS: Record<QueueFacts["kind"], string> = {
  data_awaited: "Hi {{contact_name}}, for your {{service_type}} for {{period}} we still need:\n{{missing_items}}\n\nYou can upload them here: {{portal_link}}",
  compliance_due:
    "Hi {{contact_name}}, {{compliance_type}} for {{period}} is due on {{due_date}}. If we still need anything from you, please share it soon so we can file on time. You can upload documents here: {{portal_link}}",
  document_request: "Hi {{contact_name}}, we are still waiting for these documents:\n{{missing_items}}\n\nYou can upload them here: {{portal_link}}",
};

/** "• item" per line; the work itself when nothing is listed. */
export function missingItemLines(missing: readonly string[], fallback: string): string {
  const items = missing.map((m) => m.trim()).filter(Boolean);
  return (items.length ? items : [fallback]).map((m) => `• ${m}`).join("\n");
}

/** The template values for one reminder (§7.13.4 variables). */
export function queueValues(f: QueueFacts, ctx: Pick<QueueContext, "firmName" | "firmPhone" | "senderName" | "today">): TemplateValues {
  const days = f.dueDate ? diffDays(f.dueDate, ctx.today) : null;
  const compliance = f.formLabel ?? (f.complianceType ? COMPLIANCE_TYPE_LABELS[f.complianceType] : null);
  const what = f.taskTitle ?? compliance ?? "your work";
  return {
    client_name: f.clientName,
    client_code: f.clientCode,
    contact_name: f.contactName ? firstNameOf(f.contactName) || f.contactName : "",
    service_type: f.serviceType ? SERVICE_TYPE_LABELS[f.serviceType] : "",
    compliance_type: compliance ?? "",
    period: f.period ?? "",
    due_date: f.dueDate ? formatDate(f.dueDate) : "",
    days_until_due: days !== null && days >= 0 ? String(days) : "",
    days_overdue: days !== null && days < 0 ? String(-days) : "",
    task_title: f.taskTitle ?? "",
    missing_items: missingItemLines(f.missing, `The data and documents for ${what}`),
    priority: f.priority ?? "",
    portal_link: f.portalLink,
    firm_name: ctx.firmName,
    firm_phone: ctx.firmPhone ?? "",
    sender_name: ctx.senderName,
  };
}

/**
 * The draft for one reminder: the chosen template (or the default draft for the kind), filled in,
 * with "Hi ," tidied when there is no contact name, then the sender's signature on shared numbers.
 */
export function buildQueueDraft(f: QueueFacts, ctx: QueueContext, template: { body: string } | null): string {
  const text = renderTemplate(template?.body ?? DEFAULT_QUEUE_DRAFTS[f.kind], queueValues(f, ctx))
    .replace(/^(Hi|Hello|Dear) ,/m, "$1,")
    .replace(/ {2,}/g, " ")
    .trim();
  return ctx.signature ? applySignature(text, ctx.signature.format, firstNameOf(ctx.senderName)) : text;
}

/** "GSTR-3B · Sep 2026", "GST return · due 20 Oct 2026". */
export function queueLabel(f: QueueFacts): string {
  const what = f.kind === "compliance_due" ? (f.formLabel ?? (f.complianceType ? COMPLIANCE_TYPE_LABELS[f.complianceType] : "Compliance")) : (f.taskTitle ?? "Documents");
  return join([what, f.period, f.dueDate ? `due ${formatDate(f.dueDate)}` : null]);
}

export type QueueContact = { id: string; name: string; phone: string | null; whatsapp: string | null; isPrimary: boolean; handles: readonly string[] };
export type QueueClient = { id: string; name: string; code: string; phone: string | null; whatsapp: string | null; status: string };

/**
 * One queue step, or why there isn't one: a client on hold or inactive gets no client-facing
 * reminders (§7.3.4). The contact who handles the service gets it (§7.13.2 `handles`); the number
 * is that contact's WhatsApp, then phone, then the client's. A step with no usable number stays in
 * the queue so the person sees it, and can only be skipped.
 */
export function planQueueStep(input: {
  key: string;
  facts: Omit<QueueFacts, "contactName" | "clientName" | "clientCode">;
  client: QueueClient;
  contacts: readonly QueueContact[];
  ctx: QueueContext;
  template: { id: string; body: string } | null;
  related: { type: string; id: string } | null;
}): { step: QueueStep } | { skip: QueueSkip } {
  const facts: QueueFacts = { ...input.facts, clientName: input.client.name, clientCode: input.client.code, contactName: null };
  const label = queueLabel(facts);
  if (input.client.status === "on_hold" || input.client.status === "inactive") {
    return { skip: { clientName: input.client.name, label, reason: input.client.status === "on_hold" ? "Client is on hold: reminders are paused." : "Client is inactive." } };
  }
  const contact = pickContactForService(input.contacts, facts.serviceType);
  facts.contactName = contact?.name ?? null;
  const number =
    normalizeWhatsAppNumber(contact?.whatsapp, { countryCode: input.ctx.countryCode }) ??
    normalizeWhatsAppNumber(contact?.phone, { countryCode: input.ctx.countryCode }) ??
    normalizeWhatsAppNumber(input.client.whatsapp, { countryCode: input.ctx.countryCode }) ??
    normalizeWhatsAppNumber(input.client.phone, { countryCode: input.ctx.countryCode });
  return {
    step: {
      key: input.key,
      clientId: input.client.id,
      clientName: input.client.name,
      contactId: contact?.id ?? null,
      contactName: contact?.name ?? null,
      number,
      label,
      draft: buildQueueDraft(facts, input.ctx, input.template),
      templateId: input.template?.id ?? null,
      related: input.related,
    },
  };
}

/** Steps sorted for stepping through: by client, then by what it's about. */
export function sortQueue(steps: readonly QueueStep[]): QueueStep[] {
  return [...steps].sort((a, b) => a.clientName.localeCompare(b.clientName, "en-IN") || a.label.localeCompare(b.label, "en-IN"));
}

/** Days ahead the compliance source looks, as the builder offers them. */
export const COMPLIANCE_WINDOWS = [3, 7, 15, 30] as const;

/** The last date a compliance reminder covers. */
export function complianceWindowEnd(today: DateString, withinDays: number): DateString {
  return addDays(today, Math.max(0, Math.min(60, Math.trunc(withinDays))));
}
