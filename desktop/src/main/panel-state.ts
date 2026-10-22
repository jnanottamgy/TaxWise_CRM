/**
 * What the WhatsApp panel shows, as one pure function of the app's state: the header's numbers
 * and chip, the banner, and whether WhatsApp itself is visible or a full-panel screen replaces it.
 */

import { PANEL } from "../shared/config";
import type { DesktopContext, PanelBanner, PanelScreen, PanelViewState, WhatsAppPageState } from "../shared/types";
import { effectiveClientMode } from "./context";
import { isPartnersOwnNumber, numbersForPanel, toOption } from "./numbers";

export interface PanelInput {
  mode: "docked" | "popped";
  width: number;
  dragging: boolean;
  offsetX: number;
  ctx: DesktopContext | null;
  linkedHere: ReadonlySet<string>;
  activeNumberId: string | null;
  /** A usable number the user chose to link (its QR screen is showing). */
  linkingNumberId: string | null;
  revoked: boolean;
  /** The last context load failed and there is no context to work from. */
  offline: boolean;
  /** Client mode failed its self-check on the number in use. */
  clientModeFailed: boolean;
  activePageState: WhatsAppPageState | null;
  /** Client of the open conversation (client mode chip). */
  openClientName: string | null;
  notice: { tone: "info" | "warning" | "danger"; text: string } | null;
}

export interface PanelOutput {
  view: PanelViewState;
  /** Show the WhatsApp view for this number (null: a screen replaces WhatsApp). */
  showNumberId: string | null;
}

export function buildPanelState(input: PanelInput): PanelOutput {
  const { ctx } = input;
  const { visible, linkable } = numbersForPanel(ctx, input.linkedHere);
  const linking = input.linkingNumberId ? (linkable.find((n) => n.id === input.linkingNumberId) ?? null) : null;
  const active = linking ?? visible.find((n) => n.id === input.activeNumberId) ?? null;

  let screen: PanelScreen | null = null;
  if (input.revoked) screen = { kind: "removed" };
  else if (!ctx) screen = input.offline ? { kind: "offline" } : { kind: "loading" };
  else if (!active) screen = { kind: "no-numbers", linkable: linkable.map(toOption) };
  else if (effectiveClientMode(ctx) && input.clientModeFailed) screen = { kind: "client-mode-unavailable" };

  let banner: PanelBanner | null = null;
  if (input.notice) banner = { kind: "notice", tone: input.notice.tone, text: input.notice.text };
  else if (screen === null && active && input.activePageState === "qr") {
    banner = { kind: "link", numberLabel: active.label, partnerOwn: isPartnersOwnNumber(active) };
  }

  const view: PanelViewState = {
    mode: input.mode,
    numbers: visible.map(toOption),
    linkable: linkable.map(toOption),
    activeNumberId: active?.id ?? null,
    chip: ctx && effectiveClientMode(ctx) && !input.revoked ? { clientName: input.openClientName } : null,
    banner,
    screen,
    width: input.width,
    minWidth: PANEL.minWidth,
    maxWidth: PANEL.maxWidth,
    dragging: input.dragging,
    offsetX: input.offsetX,
  };
  return { view, showNumberId: screen === null && active ? active.id : null };
}
