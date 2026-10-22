/**
 * Small JSON files in app.getPath("userData"): the window size and panel width (§7.25.3 "remembers
 * the window size and panel width"), and this PC's own record of which numbers are linked here,
 * whether a Partner removed it, and every WhatsApp partition it has ever created (so a revoked PC
 * can wipe them all). Parsing is defensive: a damaged file falls back to defaults.
 */

import { PANEL, WINDOW } from "../shared/config";
import type { Rect } from "./layout";

export interface WindowState {
  bounds: Rect | null;
  maximized: boolean;
  panelWidth: number;
  panelVisible: boolean;
  popoutBounds: Rect | null;
  /** user id → number id last used in the panel */
  lastNumberByUser: Record<string, string>;
}

export const DEFAULT_WINDOW_STATE: WindowState = {
  bounds: null,
  maximized: false,
  panelWidth: PANEL.defaultWidth,
  panelVisible: true,
  popoutBounds: null,
  lastNumberByUser: {},
};

export interface DeviceState {
  /** number id → when this PC saw that number's chat list (linked here). */
  linked: Record<string, number>;
  revoked: boolean;
  /** Every WhatsApp partition this PC has created. */
  partitions: string[];
  /** Link/unlink reports the API hasn't accepted yet. */
  pendingLinkReports: Array<{ numberId: string; linked: boolean }>;
}

export const DEFAULT_DEVICE_STATE: DeviceState = { linked: {}, revoked: false, partitions: [], pendingLinkReports: [] };

const ID = /^[A-Za-z0-9-]{1,64}$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseRect(v: unknown, minW: number, minH: number): Rect | null {
  if (!isObj(v)) return null;
  const { x, y, width, height } = v;
  if (![x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  if ((width as number) < minW || (height as number) < minH || (width as number) > 20000 || (height as number) > 20000) return null;
  return { x: Math.round(x as number), y: Math.round(y as number), width: Math.round(width as number), height: Math.round(height as number) };
}

export function parseWindowState(raw: unknown): WindowState {
  if (!isObj(raw)) return { ...DEFAULT_WINDOW_STATE, lastNumberByUser: {} };
  const panelWidth =
    typeof raw.panelWidth === "number" && Number.isFinite(raw.panelWidth)
      ? Math.min(PANEL.maxWidth, Math.max(PANEL.minWidth, Math.round(raw.panelWidth)))
      : PANEL.defaultWidth;
  const lastNumberByUser: Record<string, string> = {};
  if (isObj(raw.lastNumberByUser)) {
    for (const [k, v] of Object.entries(raw.lastNumberByUser)) {
      if (ID.test(k) && typeof v === "string" && ID.test(v)) lastNumberByUser[k] = v;
    }
  }
  return {
    bounds: parseRect(raw.bounds, WINDOW.minWidth, WINDOW.minHeight),
    maximized: raw.maximized === true,
    panelWidth,
    panelVisible: raw.panelVisible !== false,
    popoutBounds: parseRect(raw.popoutBounds, PANEL.minWidth, 300),
    lastNumberByUser,
  };
}

export function parseDeviceState(raw: unknown): DeviceState {
  if (!isObj(raw)) return { linked: {}, revoked: false, partitions: [], pendingLinkReports: [] };
  const linked: Record<string, number> = {};
  if (isObj(raw.linked)) {
    for (const [k, v] of Object.entries(raw.linked)) {
      if (ID.test(k) && typeof v === "number" && Number.isFinite(v)) linked[k] = v;
    }
  }
  const partitions = Array.isArray(raw.partitions)
    ? [...new Set(raw.partitions.filter((p): p is string => typeof p === "string" && /^persist:wa-[A-Za-z0-9-]{1,64}$/.test(p)))]
    : [];
  const pendingLinkReports = Array.isArray(raw.pendingLinkReports)
    ? raw.pendingLinkReports
        .filter((r): r is { numberId: string; linked: boolean } => isObj(r) && typeof r.numberId === "string" && ID.test(r.numberId) && typeof r.linked === "boolean")
        .map((r) => ({ numberId: r.numberId, linked: r.linked }))
        .slice(-50)
    : [];
  return { linked, revoked: raw.revoked === true, partitions, pendingLinkReports };
}

/** Keep saved bounds only if a usable part of them is on a connected display. */
export function ensureVisible(bounds: Rect | null, workAreas: Rect[]): Rect | null {
  if (!bounds) return null;
  const visible = workAreas.some((a) => {
    const w = Math.min(bounds.x + bounds.width, a.x + a.width) - Math.max(bounds.x, a.x);
    const h = Math.min(bounds.y + bounds.height, a.y + a.height) - Math.max(bounds.y, a.y);
    return w >= 200 && h >= 100;
  });
  return visible ? bounds : null;
}

export interface FileSystem {
  readFileSync(path: string, encoding: "utf8"): string;
  writeFileSync(path: string, data: string, options: { encoding: "utf8"; mode: number }): void;
  renameSync(from: string, to: string): void;
}

/** A JSON file written atomically (temp file + rename), so a crash never leaves half a file. */
export class JsonFile<T> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: T | null = null;

  constructor(
    private readonly path: string,
    private readonly parse: (raw: unknown) => T,
    private readonly fs: FileSystem,
    private readonly delayMs = 400,
  ) {}

  load(): T {
    try {
      return this.parse(JSON.parse(this.fs.readFileSync(this.path, "utf8")));
    } catch {
      return this.parse(undefined);
    }
  }

  saveNow(value: T): void {
    const tmp = `${this.path}.tmp`;
    this.fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
    this.fs.renameSync(tmp, this.path);
  }

  /** Debounced save (window resizes fire many times a second). */
  save(value: T): void {
    this.pending = value;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pending !== null) {
      const value = this.pending;
      this.pending = null;
      try {
        this.saveNow(value);
      } catch {
        // Losing a window size is not worth crashing for.
      }
    }
  }
}
