import "server-only";

import { renderEmail, type EmailBlock, type EmailFirm, type ListItem, type RenderedEmail } from "@/server/email/templates/layout";
import { day, greeting, signOff } from "@/server/email/templates/parts";

/**
 * §10.11 Document request and its reminders (§7.14 PBC lists): the item list and the upload link
 * (the portal request page). Reminders repeat only what is still pending, and items the firm
 * rejected show the reason so the client knows what to send instead.
 */

export interface DocumentRequestItem {
  title: string;
  helpText?: string | null;
  status: "pending" | "uploaded" | "accepted" | "rejected";
  rejectionReason?: string | null;
  required?: boolean;
}

export interface DocumentRequestData {
  recipientName: string;
  clientName: string;
  title: string;
  items: DocumentRequestItem[];
  /** YYYY-MM-DD */
  dueDate?: string | null;
  /** Absolute URL of the portal request page. */
  uploadUrl: string;
  notes?: string | null;
  senderName?: string | null;
  /** Set for the reminders: how many have gone before this one. */
  reminderNumber?: number | null;
}

function itemLines(items: DocumentRequestItem[]): ListItem[] {
  return items.map((it) => {
    if (it.status === "rejected") {
      return { title: `${it.title} (please upload again)`, detail: it.rejectionReason?.trim() ? `Why: ${it.rejectionReason.trim()}` : it.helpText ?? null };
    }
    return { title: it.required === false ? `${it.title} (if you have it)` : it.title, detail: it.helpText ?? null };
  });
}

export function documentRequestEmail(d: DocumentRequestData, firm: EmailFirm): RenderedEmail {
  const reminder = typeof d.reminderNumber === "number" && d.reminderNumber > 0;
  const open = d.items.filter((it) => it.status === "pending" || it.status === "rejected");
  const list = reminder ? open : d.items.filter((it) => it.status !== "accepted");
  const by = d.dueDate ? ` by ${day(d.dueDate)}` : "";
  const blocks: EmailBlock[] = [
    {
      kind: "paragraph",
      text: reminder
        ? `We're still waiting for ${open.length === 1 ? "one item" : `${open.length} items`} for "${d.title}"${by}:`
        : `To complete "${d.title}" for ${d.clientName}, we need the following from you${by}:`,
    },
    { kind: "list", items: itemLines(list), ordered: true },
  ];
  if (!reminder && d.notes?.trim()) blocks.push({ kind: "paragraph", text: d.notes.trim() });
  blocks.push(
    { kind: "button", label: "Upload documents", url: d.uploadUrl },
    {
      kind: "small",
      text: "Upload from your phone or computer (PDF, photos, Excel or Word, up to 25 MB each). Each item shows as received once you upload it; we'll tell you if anything needs to be sent again.",
    },
  );
  return renderEmail(
    {
      subjectItem: reminder ? `Reminder: documents still needed for ${d.title}` : `Documents needed: ${d.title}`,
      preheader: `${list.length === 1 ? "1 item" : `${list.length} items`}${by}.`,
      greeting: greeting(d.recipientName),
      blocks,
      signOff: signOff(firm, d.senderName),
    },
    firm,
  );
}
