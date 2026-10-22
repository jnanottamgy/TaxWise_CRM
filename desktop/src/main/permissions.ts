/**
 * Permission rules per session partition (§7.25.3), applied to both
 * setPermissionRequestHandler and setPermissionCheckHandler.
 *
 * WhatsApp partitions: notifications (only when the role allows it, §7.25.5), media for audio only
 * (voice notes), clipboard-sanitized-write. CRM partition: notifications, clipboard-sanitized-write.
 * Everything else is denied, and so is anything from an unexpected origin.
 */

import type { Session } from "electron";
import { CRM_PARTITION, WHATSAPP_ORIGIN } from "../shared/config";
import type { AppRole } from "../shared/types";
import { originOf } from "../shared/url";

export type PartitionKind = "crm" | "whatsapp" | "panel";

export interface PermissionPolicy {
  /** Role of the signed-in CRM user; null when nobody is signed in. */
  role: AppRole | null;
  /** Settings → WhatsApp → Employee notifications. */
  employeeNotifications: boolean;
}

export interface PermissionQuery {
  partition: PartitionKind;
  permission: string;
  /** Origin of the requesting frame. */
  origin: string;
  /** Request handler: the media types asked for. */
  mediaTypes?: readonly string[];
  /** Check handler: the media type being checked. */
  mediaType?: string;
}

/** Which rule set a partition gets. Unknown partitions get the panel's (deny everything). */
export function partitionKind(partition: string): PartitionKind {
  if (partition === CRM_PARTITION) return "crm";
  if (/^persist:wa-[A-Za-z0-9-]{1,64}$/.test(partition)) return "whatsapp";
  return "panel";
}

/** Notifications in WhatsApp: Partners and Managers yes; Employees only if a Partner turned them on. */
export function whatsappNotificationsAllowed(policy: PermissionPolicy): boolean {
  if (policy.role === "partner" || policy.role === "manager") return true;
  if (policy.role === "employee") return policy.employeeNotifications;
  return false;
}

function audioOnly(q: PermissionQuery): boolean {
  if (q.mediaTypes !== undefined) {
    return q.mediaTypes.length > 0 && q.mediaTypes.every((t) => t === "audio");
  }
  return q.mediaType === "audio";
}

export function decidePermission(q: PermissionQuery, policy: PermissionPolicy, appOrigin: string): boolean {
  const origin = originOf(q.origin);

  if (q.partition === "whatsapp") {
    if (origin !== WHATSAPP_ORIGIN) return false;
    if (policy.role === null || policy.role === "client") return false;
    switch (q.permission) {
      case "notifications":
        return whatsappNotificationsAllowed(policy);
      case "media":
        return audioOnly(q);
      case "clipboard-sanitized-write":
        return true;
      default:
        return false;
    }
  }

  if (q.partition === "crm") {
    if (origin !== appOrigin) return false;
    return q.permission === "notifications" || q.permission === "clipboard-sanitized-write";
  }

  // The panel header (and any other session) gets nothing.
  return false;
}

type PermissionSession = Pick<Session, "setPermissionRequestHandler" | "setPermissionCheckHandler" | "setDevicePermissionHandler">;

/** Installs both handlers on a session. `getPolicy` is read on every decision, so role changes apply at once. */
export function installPermissionHandlers(
  ses: PermissionSession,
  partition: PartitionKind,
  getPolicy: () => PermissionPolicy,
  appOrigin: string,
): void {
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const mediaTypes = "mediaTypes" in details ? (details.mediaTypes ?? []) : undefined;
    const origin = details.requestingUrl || webContents.getURL();
    callback(decidePermission({ partition, permission, origin, mediaTypes }, getPolicy(), appOrigin));
  });
  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    const origin = requestingOrigin || details.securityOrigin || details.requestingUrl || "";
    return decidePermission({ partition, permission, origin, mediaType: details.mediaType }, getPolicy(), appOrigin);
  });
  // HID, serial and USB devices: never.
  ses.setDevicePermissionHandler(() => false);
}
