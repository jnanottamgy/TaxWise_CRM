/**
 * The WhatsApp panel's header (§7.25.3): number switcher (only numbers this user may use and that
 * are linked on this PC), the client-mode chip, Pop out and Close; the link-this-PC instructions
 * over WhatsApp's QR screen; and the full-panel screens shown while WhatsApp is hidden.
 * All text is set with textContent; nothing from the CRM is parsed as HTML.
 */

import { COPY } from "../shared/copy";
import type { TaxwisePanelBridge } from "../preload/panel";
import type { PanelBanner, PanelNumberOption, PanelScreen, PanelViewState } from "../shared/types";

declare global {
  interface Window {
    taxwisePanel: TaxwisePanelBridge;
  }
}

type IconPart = [tag: "path" | "circle" | "rect", attrs: Record<string, string>];

/** Lucide outline icons, 2px stroke. */
const ICONS: Record<string, IconPart[]> = {
  phone: [
    ["rect", { x: "5", y: "2", width: "14", height: "20", rx: "2" }],
    ["path", { d: "M12 18h.01" }],
  ],
  chevron: [["path", { d: "m6 9 6 6 6-6" }]],
  popOut: [
    ["path", { d: "M15 3h6v6" }],
    ["path", { d: "M10 14 21 3" }],
    ["path", { d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" }],
  ],
  dock: [
    ["rect", { x: "3", y: "3", width: "18", height: "18", rx: "2" }],
    ["path", { d: "M15 3v18" }],
  ],
  close: [
    ["path", { d: "M18 6 6 18" }],
    ["path", { d: "m6 6 12 12" }],
  ],
  qr: [
    ["rect", { x: "3", y: "3", width: "5", height: "5", rx: "1" }],
    ["rect", { x: "16", y: "3", width: "5", height: "5", rx: "1" }],
    ["rect", { x: "3", y: "16", width: "5", height: "5", rx: "1" }],
    ["path", { d: "M21 16h-3a2 2 0 0 0-2 2v3" }],
    ["path", { d: "M21 21v.01" }],
    ["path", { d: "M12 7v3a2 2 0 0 1-2 2H7" }],
    ["path", { d: "M3 12h.01" }],
    ["path", { d: "M12 3h.01" }],
    ["path", { d: "M12 16v.01" }],
    ["path", { d: "M16 12h1" }],
    ["path", { d: "M21 12v.01" }],
    ["path", { d: "M12 21v-1" }],
  ],
  info: [
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["path", { d: "M12 16v-4" }],
    ["path", { d: "M12 8h.01" }],
  ],
  alert: [
    ["path", { d: "M12 9v4" }],
    ["path", { d: "M12 17h.01" }],
    ["path", { d: "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" }],
  ],
  removed: [
    ["rect", { x: "2", y: "3", width: "20", height: "14", rx: "2" }],
    ["path", { d: "M8 21h8" }],
    ["path", { d: "M12 17v4" }],
    ["path", { d: "m14.5 7.5-5 5" }],
    ["path", { d: "m9.5 7.5 5 5" }],
  ],
  offline: [
    ["path", { d: "M12 20h.01" }],
    ["path", { d: "M8.5 16.4a5 5 0 0 1 7 0" }],
    ["path", { d: "M5 12.9a10 10 0 0 1 5.2-2.7" }],
    ["path", { d: "M19 12.9a10 10 0 0 0-2-1.5" }],
    ["path", { d: "M2 8.8a15 15 0 0 1 4.2-2.6" }],
    ["path", { d: "M22 8.8a15 15 0 0 0-11.3-3.8" }],
    ["path", { d: "m2 2 20 20" }],
  ],
  link: [
    ["path", { d: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" }],
    ["path", { d: "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" }],
  ],
  retry: [
    ["path", { d: "M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" }],
    ["path", { d: "M21 3v5h-5" }],
  ],
};

const SVG_NS = "http://www.w3.org/2000/svg";

function icon(name: keyof typeof ICONS, className = ""): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  if (className) svg.setAttribute("class", className);
  for (const [tag, attrs] of ICONS[name]!) {
    const part = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) part.setAttribute(k, v);
    svg.append(part);
  }
  return svg;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

const bridge = window.taxwisePanel;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const splitter = $("splitter");
const numberSlot = $("number-slot");
const chip = $("chip");
const chipLabel = $("chip-label");
const popBtn = $<HTMLButtonElement>("pop");
const closeBtn = $<HTMLButtonElement>("close");
const banner = $("banner");
const screen = $("screen");

let state: PanelViewState | null = null;

/* ---- number switcher ---------------------------------------------- */

const LINK_PREFIX = "link:";

function renderNumbers(numbers: PanelNumberOption[], linkable: PanelNumberOption[], activeId: string | null): void {
  numberSlot.replaceChildren();
  const linking = linkable.find((n) => n.id === activeId);
  if (linking && numbers.length === 0) {
    // Its QR screen is showing: name the number being linked.
    numberSlot.append(
      el("span", { className: "number-static", title: `${linking.label}: ${COPY.notLinkedYet}` }, icon("phone"), el("span", { textContent: linking.label }), el("span", { className: "state", textContent: `· ${COPY.notLinkedYet}` })),
    );
    return;
  }
  if (numbers.length === 0) return;
  if (numbers.length === 1 && linkable.length === 0) {
    const n = numbers[0]!;
    numberSlot.append(el("span", { className: "number-static", title: `WhatsApp number: ${n.label}` }, icon("phone"), el("span", { textContent: n.label })));
    return;
  }
  const select = el("select", { id: "number-select", title: "WhatsApp number in use" });
  select.setAttribute("aria-label", "WhatsApp number");
  for (const n of numbers) select.append(el("option", { value: n.id, textContent: n.label, selected: n.id === activeId }));
  if (linking) select.prepend(el("option", { value: `${LINK_PREFIX}${linking.id}`, textContent: `${linking.label} (${COPY.notLinkedYet})`, selected: true }));
  const others = linkable.filter((n) => n.id !== linking?.id);
  if (others.length > 0) {
    const group = el("optgroup", { label: "Link on this PC" });
    for (const n of others) group.append(el("option", { value: `${LINK_PREFIX}${n.id}`, textContent: COPY.linkNumber(n.label) }));
    select.append(group);
  }
  const current = linking ? `${LINK_PREFIX}${linking.id}` : activeId;
  select.addEventListener("change", () => {
    const v = select.value;
    if (v.startsWith(LINK_PREFIX)) {
      bridge.linkNumber(v.slice(LINK_PREFIX.length));
      if (current) select.value = current;
    } else {
      bridge.switchNumber(v);
    }
  });
  numberSlot.append(el("span", { className: "select-wrap" }, icon("phone", "lead"), select, icon("chevron", "chev")));
}

/* ---- banner ------------------------------------------------------- */

function renderBanner(b: PanelBanner | null): void {
  banner.replaceChildren();
  banner.className = "banner";
  banner.removeAttribute("role");
  if (!b) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  if (b.kind === "link") {
    banner.classList.add("link");
    const text = el("div", { className: "text" }, el("div", { className: "lead-line", textContent: COPY.linkThisPc(b.numberLabel) }));
    const sub = [b.partnerOwn ? COPY.linkOwnNumberOnlyHere : null, COPY.fourteenDayRule].filter(Boolean).join(" ");
    text.append(el("div", { className: "sub", textContent: sub }));
    banner.append(icon("qr"), text);
    return;
  }
  banner.classList.add("notice", `tone-${b.tone}`);
  banner.setAttribute("role", b.tone === "danger" ? "alert" : "status");
  const dismiss = el("button", { className: "icon-btn notice-close", type: "button", title: "Dismiss" });
  dismiss.setAttribute("aria-label", "Dismiss this message");
  dismiss.append(icon("close"));
  dismiss.addEventListener("click", () => bridge.dismissNotice());
  banner.append(icon(b.tone === "info" ? "info" : "alert"), el("div", { className: "text", textContent: b.text, title: b.text }), dismiss);
}

/* ---- screens ------------------------------------------------------ */

function card(iconName: keyof typeof ICONS, tone: "" | "warning" | "danger", title: string | null, detail: string | null, ...extra: Node[]): HTMLElement {
  const c = el("div", { className: `card${tone ? ` tone-${tone}` : ""}` });
  c.setAttribute("role", tone ? "alert" : "status");
  c.append(icon(iconName));
  if (title) c.append(el("h1", { textContent: title }));
  if (detail) c.append(el("p", { textContent: detail, className: title ? "" : "message" }));
  c.append(...extra);
  return c;
}

function button(label: string, primary: boolean, onClick: () => void, iconName?: keyof typeof ICONS): HTMLButtonElement {
  const b = el("button", { className: `btn${primary ? " primary" : ""}`, type: "button" });
  if (iconName) b.append(icon(iconName));
  b.append(label);
  b.addEventListener("click", onClick);
  return b;
}

function renderScreen(s: PanelScreen | null): void {
  screen.replaceChildren();
  if (!s) {
    screen.hidden = true;
    return;
  }
  screen.hidden = false;
  switch (s.kind) {
    case "loading":
      screen.append(el("div", { className: "loading-line", textContent: COPY.loading }));
      break;
    case "no-numbers": {
      if (s.linkable.length === 0) {
        screen.append(card("phone", "", COPY.noNumbersTitle, COPY.noNumbersDetail));
        break;
      }
      // Office numbers first; a Partner's own number is linked only on their own PC (house rule 4).
      const ordered = [...s.linkable].sort((a, b) => Number(a.kind === "partner") - Number(b.kind === "partner"));
      const actions = el("div", { className: "actions" });
      ordered.forEach((n, i) => actions.append(button(COPY.linkNumber(n.label), i === 0, () => bridge.linkNumber(n.id), "link")));
      const extra: Node[] = [actions];
      if (ordered.some((n) => n.kind === "partner")) extra.push(el("p", { className: "hint", textContent: COPY.linkOwnNumberOnlyHere }));
      screen.append(card("link", "", COPY.linkTitle, COPY.linkDetail, ...extra));
      break;
    }
    case "removed":
      screen.append(card("removed", "danger", COPY.removedTitle, COPY.removedDetail, el("div", { className: "note", textContent: COPY.removedPartnerReminder })));
      break;
    case "client-mode-unavailable":
      screen.append(card("alert", "warning", null, COPY.clientModeUnavailable));
      break;
    case "offline": {
      const actions = el("div", { className: "actions" }, button("Try again", true, () => bridge.retry(), "retry"));
      screen.append(card("offline", "", COPY.offlineTitle, COPY.offlineDetail, actions));
      break;
    }
  }
}

/* ---- whole state -------------------------------------------------- */

function render(next: PanelViewState): void {
  const prev = state;
  state = next;
  const root = document.documentElement;
  root.classList.toggle("dragging", next.dragging);
  root.classList.toggle("popped", next.mode === "popped");
  root.style.setProperty("--offset-x", `${next.offsetX}px`);
  root.style.setProperty("--panel-w", `${next.width}px`);

  splitter.setAttribute("aria-valuenow", String(next.width));
  splitter.setAttribute("aria-valuemin", String(next.minWidth));
  splitter.setAttribute("aria-valuemax", String(next.maxWidth));
  splitter.setAttribute("aria-valuetext", `${next.width} pixels wide`);

  const numbersKey = JSON.stringify([next.numbers, next.linkable, next.activeNumberId]);
  if (!prev || numbersKey !== JSON.stringify([prev.numbers, prev.linkable, prev.activeNumberId])) {
    renderNumbers(next.numbers, next.linkable, next.activeNumberId);
  }

  if (next.chip) {
    const text = next.chip.clientName ? COPY.clientModeChip(next.chip.clientName) : COPY.clientModeChipIdle;
    if (chipLabel.textContent !== text) chipLabel.textContent = text;
    chip.title = text;
    chip.hidden = false;
  } else {
    chip.hidden = true;
  }

  if (!prev || prev.mode !== next.mode) {
    popBtn.replaceChildren(icon(next.mode === "docked" ? "popOut" : "dock"));
    const label = next.mode === "docked" ? "Pop out WhatsApp into its own window" : "Put WhatsApp back beside TaxWise";
    popBtn.setAttribute("aria-label", label);
    popBtn.title = next.mode === "docked" ? "Pop out" : "Dock";
  }

  if (!prev || JSON.stringify(prev.banner) !== JSON.stringify(next.banner)) renderBanner(next.banner);
  if (!prev || JSON.stringify(prev.screen) !== JSON.stringify(next.screen)) renderScreen(next.screen);
}

closeBtn.append(icon("close"));
closeBtn.addEventListener("click", () => bridge.close());
popBtn.addEventListener("click", () => (state?.mode === "popped" ? bridge.dock() : bridge.popOut()));

/* ---- splitter: pointer drag, plus a keyboard alternative (WCAG 2.2 dragging movements) ---- */

let dragging = false;
let pendingX: number | null = null;

function flushMove(): void {
  if (pendingX !== null && dragging) bridge.drag("move", pendingX);
  pendingX = null;
}

splitter.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || state?.mode !== "docked") return;
  e.preventDefault();
  dragging = true;
  splitter.setPointerCapture(e.pointerId);
  bridge.drag("start", e.screenX);
});

splitter.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  if (pendingX === null) requestAnimationFrame(flushMove);
  pendingX = e.screenX;
});

function endDrag(e: PointerEvent): void {
  if (!dragging) return;
  dragging = false;
  pendingX = null;
  bridge.drag("end", e.screenX);
}

splitter.addEventListener("pointerup", endDrag);
splitter.addEventListener("pointercancel", endDrag);
splitter.addEventListener("lostpointercapture", endDrag);

splitter.addEventListener("dblclick", () => {
  if (state) bridge.setWidth(440);
});

splitter.addEventListener("keydown", (e) => {
  if (!state) return;
  const step = e.shiftKey ? 64 : 16;
  let width: number | null = null;
  // The panel is on the right: moving the splitter left makes it wider.
  if (e.key === "ArrowLeft") width = state.width + step;
  else if (e.key === "ArrowRight") width = state.width - step;
  else if (e.key === "Home") width = state.minWidth;
  else if (e.key === "End") width = state.maxWidth;
  if (width === null) return;
  e.preventDefault();
  bridge.setWidth(Math.max(state.minWidth, Math.min(state.maxWidth, width)));
});

bridge.onState(render);
