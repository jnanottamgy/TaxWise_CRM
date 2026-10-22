/**
 * Fixed values for TaxWise Desktop (§7.25.3). Nothing here is secret.
 */

export const APP_ID = "in.taxwise.desktop";

/** WhatsApp Web: the only origin a WhatsApp panel may show. */
export const WHATSAPP_ORIGIN = "https://web.whatsapp.com";
export const WHATSAPP_HOME = "https://web.whatsapp.com/";

/** The CRM view's persistent session (cookies survive restarts). */
export const CRM_PARTITION = "persist:crm";

/** The panel header's in-memory session (local HTML from the app bundle only). */
export const PANEL_PARTITION = "taxwise-panel";

/** Privileged scheme that serves the panel header from the app bundle (never file://). */
export const PANEL_SCHEME = "taxwise";
export const PANEL_HOST = "panel";
export const PANEL_ORIGIN = `${PANEL_SCHEME}://${PANEL_HOST}`;
export const PANEL_URL = `${PANEL_ORIGIN}/panel-header.html`;

/** Panel geometry in DIP (§7.25.3). */
export const PANEL = {
  minWidth: 360,
  maxWidth: 720,
  defaultWidth: 440,
  headerHeight: 36,
  splitterWidth: 6,
  /** Keeps the CRM usable when the window is narrow. */
  minCrmWidth: 480,
  keyboardStep: 16,
  keyboardPageStep: 64,
} as const;

export const WINDOW = {
  defaultWidth: 1366,
  defaultHeight: 768,
  minWidth: 900,
  minHeight: 600,
} as const;

/** Timers. */
export const CONTEXT_REFRESH_MS = 5 * 60 * 1000;
/** After this long without a good context, client mode allows nothing (fails closed). */
export const CONTEXT_STALE_MS = 2 * CONTEXT_REFRESH_MS;
/** How often the main process re-checks client mode's policy (so a stale context closes chats on time). */
export const POLICY_RECHECK_MS = 30 * 1000;
export const SELECTOR_CHECK_MS = 10 * 60 * 1000;
export const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;
export const DOWNLOAD_TTL_MS = 10 * 60 * 1000;
export const HANDOFF_ADOPT_MS = 60 * 1000;
export const API_TIMEOUT_MS = 15 * 1000;

/** The CRM refuses files over 25 MB (§12). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Indian Standard Time: "today" for once-a-day rules. */
export const FIRM_TIME_ZONE = "Asia/Kolkata";
