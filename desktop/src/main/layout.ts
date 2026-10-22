/**
 * Where the three views sit (§7.25.3). Pure geometry, in DIP.
 *
 * Docked:  [ CRM view ][ splitter | header bar ][ … ]
 *                      [ splitter | WhatsApp view   ]
 * The panel header view spans the whole panel column (its left strip is the splitter, its top
 * 36 px the header bar, and under the WhatsApp view it shows full-panel messages when WhatsApp is
 * hidden). The WhatsApp view sits on top of it, below the header bar and any banner.
 */

import { PANEL } from "../shared/config";
import type { PanelBanner } from "../shared/types";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export const ZERO: Rect = { x: 0, y: 0, width: 0, height: 0 };

export function bannerHeight(banner: PanelBanner | null): number {
  if (!banner) return 0;
  return banner.kind === "link" ? 88 : 76;
}

/** Clamp to 360–720, and keep the CRM at least minCrmWidth wide when the window allows it. */
export function clampPanelWidth(width: number, windowWidth: number): number {
  const room = windowWidth - PANEL.splitterWidth - PANEL.minCrmWidth;
  const upper = Math.max(PANEL.minWidth, Math.min(PANEL.maxWidth, room));
  const w = Number.isFinite(width) ? Math.round(width) : PANEL.defaultWidth;
  return Math.min(upper, Math.max(PANEL.minWidth, w));
}

export interface DockedLayout {
  crm: Rect;
  header: Rect;
  whatsapp: Rect;
  /** x of the panel column (splitter included) in window coordinates. */
  panelX: number;
  panelWidth: number;
}

export function dockedLayout(content: Size, requestedWidth: number, banner: number, dragging: boolean): DockedLayout {
  const W = Math.max(0, Math.round(content.width));
  const H = Math.max(0, Math.round(content.height));
  const P = clampPanelWidth(requestedWidth, W);
  const S = PANEL.splitterWidth;
  const panelX = Math.max(0, W - P - S);
  const top = PANEL.headerHeight + banner;
  return {
    crm: { x: 0, y: 0, width: panelX, height: H },
    header: dragging ? { x: 0, y: 0, width: W, height: H } : { x: panelX, y: 0, width: W - panelX, height: H },
    whatsapp: { x: panelX + S, y: top, width: Math.max(0, W - panelX - S), height: Math.max(0, H - top) },
    panelX,
    panelWidth: P,
  };
}

export function hiddenLayout(content: Size): { crm: Rect } {
  return { crm: { x: 0, y: 0, width: Math.round(content.width), height: Math.round(content.height) } };
}

export function poppedLayout(content: Size, banner: number): { header: Rect; whatsapp: Rect } {
  const W = Math.round(content.width);
  const H = Math.round(content.height);
  const top = PANEL.headerHeight + banner;
  return {
    header: { x: 0, y: 0, width: W, height: H },
    whatsapp: { x: 0, y: top, width: W, height: Math.max(0, H - top) },
  };
}

/** Panel width for a splitter dragged to screenX, given the window's content bounds on screen. */
export function widthFromScreenX(screenX: number, contentBounds: Rect): number {
  const right = contentBounds.x + contentBounds.width;
  return clampPanelWidth(right - screenX - PANEL.splitterWidth / 2, contentBounds.width);
}
