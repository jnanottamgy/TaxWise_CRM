/**
 * Strict readers for what the CRM's desktop API returns (§7.25.1). A response that doesn't fit
 * is treated as an error, never half-used: client mode must not run on a guessed allow-list.
 */

import type { AllowedGroup, AppRole, DesktopContext, FirmNumber, NumberKind, OpenWhatsAppData } from "../shared/types";

const ROLES: readonly AppRole[] = ["partner", "manager", "employee", "client"];
const KINDS: readonly NumberKind[] = ["partner", "managers_office", "staff_office", "other"];
const ID = /^[A-Za-z0-9-]{1,64}$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isStr(v: unknown, max = 512): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max;
}
function isId(v: unknown): v is string {
  return typeof v === "string" && ID.test(v);
}

function parseNumber(v: unknown): FirmNumber | null {
  if (!isObj(v)) return null;
  if (!isId(v.id) || !isStr(v.label, 200)) return null;
  if (typeof v.kind !== "string" || !(KINDS as readonly string[]).includes(v.kind)) return null;
  if (!Array.isArray(v.usableBy) || !v.usableBy.every((r) => typeof r === "string" && (ROLES as readonly string[]).includes(r))) return null;
  if (!(v.ownerEmployeeId === null || v.ownerEmployeeId === undefined || isId(v.ownerEmployeeId))) return null;
  return {
    id: v.id,
    label: v.label,
    kind: v.kind as NumberKind,
    usableBy: v.usableBy as AppRole[],
    ownerEmployeeId: (v.ownerEmployeeId as string | null | undefined) ?? null,
  };
}

function parseGroup(v: unknown): AllowedGroup | null {
  if (!isObj(v)) return null;
  if (!isId(v.clientId) || !isStr(v.clientName, 300) || !isStr(v.groupName, 300)) return null;
  return { clientId: v.clientId, clientName: v.clientName, groupName: v.groupName };
}

export function parseContext(data: unknown): DesktopContext | null {
  if (!isObj(data)) return null;
  const u = data.user;
  if (!isObj(u)) return null;
  if (!isId(u.id) || !isStr(u.name, 200)) return null;
  if (typeof u.role !== "string" || !(ROLES as readonly string[]).includes(u.role)) return null;
  if (!(u.employeeId === null || u.employeeId === undefined || isId(u.employeeId))) return null;
  if (typeof data.clientMode !== "boolean" || typeof data.employeeNotifications !== "boolean") return null;
  if (!Array.isArray(data.numbers)) return null;
  const numbers: FirmNumber[] = [];
  for (const n of data.numbers) {
    const parsed = parseNumber(n);
    if (!parsed) return null;
    numbers.push(parsed);
  }
  let allowedGroups: AllowedGroup[] | null = null;
  if (data.allowedGroups !== null) {
    if (!Array.isArray(data.allowedGroups)) return null;
    allowedGroups = [];
    for (const g of data.allowedGroups) {
      const parsed = parseGroup(g);
      if (!parsed) return null;
      allowedGroups.push(parsed);
    }
  }
  const role = u.role as AppRole;
  // "null means all" is only ever true for Partners and Managers. An Employee with null is a server bug: refuse it.
  if (allowedGroups === null && role !== "partner" && role !== "manager") return null;
  return {
    user: { id: u.id, employeeId: (u.employeeId as string | null | undefined) ?? null, name: u.name, role },
    clientMode: data.clientMode,
    employeeNotifications: data.employeeNotifications,
    numbers,
    allowedGroups,
  };
}

/** WhatsApp invite codes are short base-62 strings (chat.whatsapp.com/<code>). */
export const INVITE_CODE = /^[A-Za-z0-9]{10,40}$/;

export function parseOpenData(data: unknown): OpenWhatsAppData | null {
  if (!isObj(data)) return null;
  if (!isStr(data.groupName, 300) || !isId(data.numberId)) return null;
  const inviteCode = typeof data.inviteCode === "string" && INVITE_CODE.test(data.inviteCode) ? data.inviteCode : null;
  const clientName = isStr(data.clientName, 300) ? data.clientName : null;
  return { groupName: data.groupName, numberId: data.numberId, inviteCode, clientName };
}
