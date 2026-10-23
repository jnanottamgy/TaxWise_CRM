import "server-only";

import { formatINR, type Paise } from "@/lib/domain/money";
import { formatDate, formatDateTime } from "@/lib/format";
import { firstNameOf } from "@/lib/domain/messaging";
import type { DetailRow, EmailContent, EmailFirm } from "@/server/email/templates/layout";

/**
 * Small pieces the §10 templates share: the greeting, the sign-off, money and dates in the house
 * style (₹1,23,456.00 · 22 Oct 2026), and bank / UPI details for paying.
 */

/** "Dear Rakesh," from "Mr Rakesh Sharma"; "Hello," without a usable name. */
export function greeting(name: string | null | undefined): string {
  const first = firstNameOf(name);
  return first ? `Dear ${first},` : "Hello,";
}

/** Regards, the sender (when a person sent it) and the firm. */
export function signOff(firm: EmailFirm, senderName?: string | null): NonNullable<EmailContent["signOff"]> {
  const sender = senderName?.trim();
  return { closing: "Regards,", lines: sender ? [sender, firm.firmName] : [firm.firmName] };
}

/** ₹ from integer paise (lib/domain/money). */
export function rupees(paise: Paise): string {
  return formatINR(paise);
}

/** 22 Oct 2026 */
export function day(date: string | Date): string {
  return formatDate(date);
}

/** 22 Oct 2026, 14:05 (IST) */
export function dayTime(date: string | Date): string {
  return formatDateTime(date);
}

export interface PayingDetails {
  bank?: {
    name?: string | null;
    accountName?: string | null;
    accountNumber?: string | null;
    ifsc?: string | null;
    branch?: string | null;
  } | null;
  upi?: { id: string; payeeName?: string | null } | null;
}

/** Bank transfer rows (only the filled-in ones), or null when there are none. */
export function bankRows(bank: PayingDetails["bank"]): DetailRow[] | null {
  if (!bank) return null;
  const rows: DetailRow[] = [];
  if (bank.accountName) rows.push({ label: "Account name", value: bank.accountName });
  if (bank.accountNumber) rows.push({ label: "Account number", value: bank.accountNumber, mono: true });
  if (bank.ifsc) rows.push({ label: "IFSC", value: bank.ifsc, mono: true });
  if (bank.name) rows.push({ label: "Bank", value: bank.branch ? `${bank.name}, ${bank.branch}` : bank.name });
  return rows.length ? rows : null;
}

/** Joins non-empty parts with a separator. */
export function joinParts(parts: Array<string | null | undefined | false>, sep = " "): string {
  return parts.filter((p): p is string => typeof p === "string" && p.trim() !== "").join(sep);
}
