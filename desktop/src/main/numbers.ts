/**
 * Which firm WhatsApp numbers the panel offers (§7.25.4). Pure.
 *
 * - Employees: Staff office. Managers: Managers' office (and Staff office if a Partner adds
 *   `manager` to its usable_by). Partners: their own number, plus numbers usable by Partners.
 * - A Partner's own number never appears for anyone else, even on the same PC, whatever its
 *   usable_by says.
 * - The panel shows a number only if the user may use it AND it is linked on this PC. Numbers the
 *   user may use but that aren't linked here yet are offered separately, for linking.
 *
 * The server already filters `numbers` by the same rules; this is the app's own check.
 */

import type { DesktopContext, DesktopUser, FirmNumber, PanelNumberOption } from "../shared/types";

export function isPartnersOwnNumber(n: FirmNumber): boolean {
  return n.kind === "partner" || n.ownerEmployeeId !== null;
}

export function mayUseNumber(user: DesktopUser, n: FirmNumber): boolean {
  if (user.role === "client") return false;
  if (isPartnersOwnNumber(n)) {
    return user.role === "partner" && user.employeeId !== null && n.ownerEmployeeId === user.employeeId;
  }
  return n.usableBy.includes(user.role);
}

export interface PanelNumbers {
  /** Usable and linked on this PC: the switcher. */
  visible: FirmNumber[];
  /** Usable but not linked on this PC yet: offered for linking. */
  linkable: FirmNumber[];
}

const KIND_ORDER: Record<FirmNumber["kind"], number> = { partner: 0, managers_office: 1, staff_office: 2, other: 3 };

function byKindThenLabel(a: FirmNumber, b: FirmNumber): number {
  return KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.label.localeCompare(b.label);
}

export function numbersForPanel(ctx: DesktopContext | null, linkedHere: ReadonlySet<string>): PanelNumbers {
  if (!ctx) return { visible: [], linkable: [] };
  const usable = ctx.numbers.filter((n) => mayUseNumber(ctx.user, n)).sort(byKindThenLabel);
  return {
    visible: usable.filter((n) => linkedHere.has(n.id)),
    linkable: usable.filter((n) => !linkedHere.has(n.id)),
  };
}

/** The number a user lands on: their last choice if still visible, else the one their role works from. */
export function defaultNumberId(user: DesktopUser, visible: FirmNumber[], lastChoice: string | null): string | null {
  if (lastChoice && visible.some((n) => n.id === lastChoice)) return lastChoice;
  const preferredKind: FirmNumber["kind"] =
    user.role === "partner" ? "partner" : user.role === "manager" ? "managers_office" : "staff_office";
  const preferred = visible.find((n) => n.kind === preferredKind);
  return (preferred ?? visible[0])?.id ?? null;
}

/**
 * The office number whose QR screen opens by itself when nothing is linked on this PC. A Partner's
 * own number is never offered this way: they link it on their own PC by choosing it (house rule 4).
 */
export function firstToLink(user: DesktopUser, linkable: FirmNumber[]): FirmNumber | null {
  const office = linkable.filter((n) => !isPartnersOwnNumber(n));
  const id = defaultNumberId(user, office, null);
  return office.find((n) => n.id === id) ?? null;
}

export function toOption(n: FirmNumber): PanelNumberOption {
  return { id: n.id, label: n.label, kind: n.kind };
}
