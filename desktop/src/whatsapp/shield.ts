/**
 * The client-mode cover (§7.25.5). An opaque layer over the whole WhatsApp page, shown whenever no
 * allowed conversation is open, so the chat list and other clients' chats are never on screen.
 * It lives in a closed shadow root, so WhatsApp's styles can't reach it, and it re-attaches itself
 * if the page removes it. Whatever covers the page is set through the CSSOM (element.style), which
 * no Content-Security-Policy can block; the stylesheet only adds typography.
 */

import { COPY } from "../shared/copy";

export type ShieldState = "hidden" | "loading" | "idle" | "opening" | "denied" | "unavailable";

const HOST_TAG = "taxwise-client-mode";

const STYLE = `
:host { all: initial; }
.cover {
  align-items: center; justify-content: center;
  padding: 24px; box-sizing: border-box; color: #0f172a;
  font: 14px/20px "Inter Variable", Inter, "Segoe UI", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.card {
  max-width: 320px; text-align: left;
  background: #ffffff; border: 1px solid #e4e7ee; border-radius: 12px; padding: 20px;
}
.mark { width: 20px; height: 20px; color: #5b6476; margin-bottom: 12px; display: block; }
.mark.danger { color: #b42318; }
.mark.warning { color: #8f5a02; }
h1 { font-size: 16px; line-height: 24px; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 4px; }
p { margin: 0; font-size: 13px; line-height: 18px; color: #5b6476; }
p.message { font-size: 14px; line-height: 20px; font-weight: 500; color: #0f172a; }
@media (prefers-color-scheme: dark) {
  .cover { color: #e6eaf2; }
  .card { background: #121826; border-color: #253049; }
  .mark, p { color: #9aa4b8; }
  p.message { color: #e6eaf2; }
  .mark.danger { color: #f87171; }
  .mark.warning { color: #fbbf24; }
}
`;

type IconPart = [tag: "path" | "circle" | "rect", attrs: Record<string, string>];

/** Lucide outline icons (lock, ban, triangle-alert, clock), built element by element: no innerHTML on WhatsApp's page. */
const ICONS: Record<"lock" | "ban" | "alert" | "clock", IconPart[]> = {
  lock: [
    ["path", { d: "M7 11V7a5 5 0 0 1 10 0v4" }],
    ["rect", { x: "3", y: "11", width: "18", height: "11", rx: "2" }],
  ],
  ban: [
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["path", { d: "m4.9 4.9 14.2 14.2" }],
  ],
  alert: [
    ["path", { d: "M12 9v4" }],
    ["path", { d: "M12 17h.01" }],
    ["path", { d: "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" }],
  ],
  clock: [
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["path", { d: "M12 6v6l4 2" }],
  ],
};

interface Content {
  icon: keyof typeof ICONS;
  tone: "" | "danger" | "warning";
  title: string;
  detail: string;
  live: "polite" | "assertive";
}

export function shieldContent(state: Exclude<ShieldState, "hidden">, openingName: string | null): Content {
  switch (state) {
    case "loading":
      return { icon: "clock", tone: "", title: COPY.loading, detail: COPY.clientModeIdleDetail, live: "polite" };
    case "idle":
      return { icon: "lock", tone: "", title: COPY.clientModeIdleTitle, detail: COPY.clientModeIdleDetail, live: "polite" };
    case "opening":
      return { icon: "clock", tone: "", title: COPY.opening(openingName ?? "the chat"), detail: COPY.clientModeIdleDetail, live: "polite" };
    case "denied":
      return { icon: "ban", tone: "danger", title: COPY.notOneOfYourClients, detail: COPY.notOneOfYourClientsDetail, live: "assertive" };
    case "unavailable":
      return { icon: "alert", tone: "warning", title: "", detail: COPY.clientModeUnavailable, live: "assertive" };
  }
}

export class Shield {
  private host: HTMLElement | null = null;
  private root: ShadowRoot | null = null;
  private cover: HTMLElement | null = null;
  private current: ShieldState = "hidden";
  private openingName: string | null = null;

  constructor(private readonly doc: Document) {}

  get state(): ShieldState {
    return this.current;
  }

  /** The text on the cover, for tests and logs (never page content). */
  get text(): string {
    if (this.current === "hidden") return "";
    const c = shieldContent(this.current, this.openingName);
    return [c.title, c.detail].filter(Boolean).join(" ");
  }

  show(state: Exclude<ShieldState, "hidden">, openingName: string | null = null): void {
    // Before <html> exists the cover can't be built yet; render it fully once it can.
    const hadCover = this.cover !== null;
    this.ensureAttached();
    if (hadCover && state === this.current && openingName === this.openingName) return;
    this.current = state;
    this.openingName = openingName;
    this.render();
  }

  hide(): void {
    if (this.current === "hidden") return;
    this.current = "hidden";
    this.render();
  }

  /** Put the cover back if the page removed it. */
  ensureAttached(): void {
    const parent = this.doc.documentElement;
    if (!parent) return;
    if (!this.host) {
      this.host = this.doc.createElement(HOST_TAG);
      // Inline !important beats any page stylesheet that might target the host.
      this.host.style.setProperty("display", "block", "important");
      this.host.style.setProperty("visibility", "visible", "important");
      this.host.style.setProperty("opacity", "1", "important");
      this.root = this.host.attachShadow({ mode: "closed" });
      const style = this.doc.createElement("style");
      style.textContent = STYLE;
      const cover = this.doc.createElement("div");
      cover.className = "cover";
      cover.setAttribute("role", "status");
      this.root.append(style, cover);
      this.cover = cover;
      this.applyCoverStyle();
    }
    if (this.host.parentNode !== parent) parent.appendChild(this.host);
  }

  /** The part that hides the page, set through the CSSOM so a page CSP can't stop it. */
  private applyCoverStyle(): void {
    const cover = this.cover;
    if (!cover) return;
    const dark = this.doc.defaultView?.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
    const s = cover.style;
    s.setProperty("position", "fixed", "important");
    s.setProperty("inset", "0", "important");
    s.setProperty("z-index", "2147483647", "important");
    s.setProperty("background", dark ? "#0b0f17" : "#f6f7fb", "important");
    s.setProperty("pointer-events", "auto", "important");
    s.setProperty("display", this.current === "hidden" ? "none" : "flex", "important");
  }

  private render(): void {
    this.ensureAttached();
    const cover = this.cover;
    if (!cover) return;
    this.applyCoverStyle();
    if (this.current === "hidden") {
      cover.replaceChildren();
      return;
    }
    const c = shieldContent(this.current, this.openingName);
    cover.setAttribute("aria-live", c.live);
    const card = this.doc.createElement("div");
    card.className = "card";
    const svgNs = "http://www.w3.org/2000/svg";
    const svg = this.doc.createElementNS(svgNs, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", `mark ${c.tone}`.trim());
    for (const [tag, attrs] of ICONS[c.icon]) {
      const part = this.doc.createElementNS(svgNs, tag);
      for (const [k, v] of Object.entries(attrs)) part.setAttribute(k, v);
      svg.append(part);
    }
    card.append(svg);
    if (c.title) {
      const h = this.doc.createElement("h1");
      h.textContent = c.title;
      card.append(h);
    }
    if (c.detail) {
      const p = this.doc.createElement("p");
      p.textContent = c.detail;
      if (!c.title) p.className = "message";
      card.append(p);
    }
    cover.replaceChildren(card);
  }

  /** True if the cover is actually up (for tests: display set through the CSSOM). */
  get covering(): boolean {
    return this.current !== "hidden" && this.cover?.style.getPropertyValue("display") === "flex" && this.host?.isConnected === true;
  }

  detach(): void {
    this.host?.remove();
    this.host = null;
    this.root = null;
    this.cover = null;
    this.current = "hidden";
  }
}
