/**
 * Shapes shared by the main process, the preloads and the panel header.
 * The desktop API shapes mirror §7.25.1; see README "Desktop API contract".
 */

export type AppRole = "partner" | "manager" | "employee" | "client";
export type NumberKind = "partner" | "managers_office" | "staff_office" | "other";

export interface DesktopUser {
  /** profiles.id (the auth user id). */
  id: string;
  /** employees.id, or null for a user who is not staff. */
  employeeId: string | null;
  name: string;
  role: AppRole;
}

export interface FirmNumber {
  id: string;
  label: string;
  kind: NumberKind;
  /** firm_whatsapp_numbers.usable_by */
  usableBy: AppRole[];
  /** firm_whatsapp_numbers.employee_id: the Partner whose own number this is (null for office numbers). */
  ownerEmployeeId: string | null;
}

export interface AllowedGroup {
  clientId: string;
  clientName: string;
  groupName: string;
}

/** GET /api/desktop/context → data */
export interface DesktopContext {
  user: DesktopUser;
  clientMode: boolean;
  employeeNotifications: boolean;
  numbers: FirmNumber[];
  /** null = all groups (Partners and Managers). */
  allowedGroups: AllowedGroup[] | null;
}

/** POST /api/desktop/whatsapp/open → data */
export interface OpenWhatsAppData {
  groupName: string;
  inviteCode?: string | null;
  numberId: string;
  clientName?: string | null;
}

/** What window.taxwiseDesktop.openClientChat resolves to. */
export type OpenChatResult = { ok: true } | { ok: false; error: string };

/** A file from the WhatsApp panel, handed to the CRM page (window.taxwiseDesktop.onDownload). */
export interface DesktopDownloadPayload {
  id: string;
  /** The client to file it under; null means "ask which client" (Save to another client…). */
  clientId: string | null;
  clientName: string | null;
  fileName: string;
  mimeType: string;
  size: number;
  bytes: Uint8Array;
  source: "whatsapp";
}

export interface DownloadCompletion {
  id: string;
  uploaded: boolean;
}

/* ------------------------------------------------------------------ */
/* WhatsApp page state, reported by the WhatsApp preload               */
/* ------------------------------------------------------------------ */

export type WhatsAppPageState = "loading" | "qr" | "chats" | "unsupported";

export interface ClientModePolicy {
  /** True only for Employees while client mode is on (§7.25.5). */
  enabled: boolean;
  /** Exact WhatsApp group names the user may see. */
  allowedGroupNames: string[];
  /** One-to-one chats the CRM opened in this session (hand-offs), by conversation title. */
  sessionChats: string[];
  /**
   * A hand-off the CRM just started: the first chat that opens in the page the hand-off loaded is
   * adopted. `armedAt` is when it started; a page that was already open then can't adopt.
   */
  pendingHandoff: { phoneDigits: string; expiresAt: number; armedAt?: number } | null;
  /** A message to keep showing after a reload (e.g. "Not one of your clients"). */
  notice: "not-allowed" | null;
}

export interface WhatsAppConfig {
  numberId: string;
  numberLabel: string;
  policy: ClientModePolicy;
  selectorCheckMs: number;
}

/* ------------------------------------------------------------------ */
/* Panel header state (main → panel header)                            */
/* ------------------------------------------------------------------ */

export interface PanelNumberOption {
  id: string;
  label: string;
  kind: NumberKind;
}

export type PanelBanner =
  | { kind: "link"; numberLabel: string; partnerOwn: boolean }
  | { kind: "notice"; tone: "info" | "warning" | "danger"; text: string };

export type PanelScreen =
  | { kind: "loading" }
  | { kind: "no-numbers"; linkable: PanelNumberOption[] }
  | { kind: "removed" }
  | { kind: "client-mode-unavailable" }
  | { kind: "offline" };

export interface PanelViewState {
  mode: "docked" | "popped";
  numbers: PanelNumberOption[];
  linkable: PanelNumberOption[];
  activeNumberId: string | null;
  /** null when client mode is off; clientName null when no client chat is open. */
  chip: { clientName: string | null } | null;
  banner: PanelBanner | null;
  screen: PanelScreen | null;
  width: number;
  minWidth: number;
  maxWidth: number;
  dragging: boolean;
  /** Where the panel column starts inside the header view (non-zero only while dragging). */
  offsetX: number;
}
