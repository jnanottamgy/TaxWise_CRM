import "server-only";

import type * as React from "react";

/**
 * Renders an email's JSX to an HTML string (§10: branded HTML + a plain-text alternative).
 *
 * react-dom/server can't be imported where server actions and route handlers run (the React Server
 * Components layer refuses it), so emails use this small static renderer instead. It supports what
 * email markup needs and nothing more: host elements with attributes and inline `style` objects,
 * function components (called once, no hooks, no state), fragments, arrays, strings and numbers.
 * Text and attribute values are escaped; `dangerouslySetInnerHTML` is refused (we never render
 * user HTML, §12). Pure: no I/O.
 */

const ELEMENT = Symbol.for("react.transitional.element");
const LEGACY_ELEMENT = Symbol.for("react.element");
const FRAGMENT = Symbol.for("react.fragment");

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

/** React prop names → HTML attribute names, for the ones email markup uses. */
const ATTR_NAMES: Record<string, string> = {
  className: "class",
  htmlFor: "for",
  cellPadding: "cellpadding",
  cellSpacing: "cellspacing",
  colSpan: "colspan",
  rowSpan: "rowspan",
  bgcolor: "bgcolor",
  valign: "valign",
  charSet: "charset",
  httpEquiv: "http-equiv",
  tabIndex: "tabindex",
  crossOrigin: "crossorigin",
};

/** CSS properties that take a bare number as pixels. */
const UNITLESS = new Set(["fontWeight", "lineHeight", "opacity", "zIndex", "flex", "flexGrow", "flexShrink", "order"]);

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function cssName(prop: string): string {
  if (prop.startsWith("--")) return prop;
  return prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/^ms-/, "-ms-");
}

export function styleToCss(style: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [prop, raw] of Object.entries(style)) {
    if (raw === null || raw === undefined || raw === false || raw === "") continue;
    const value = typeof raw === "number" && raw !== 0 && !UNITLESS.has(prop) ? `${raw}px` : String(raw);
    parts.push(`${cssName(prop)}:${value}`);
  }
  return parts.join(";");
}

function renderAttributes(props: Record<string, unknown>): string {
  let out = "";
  for (const [key, value] of Object.entries(props)) {
    if (key === "children" || key === "key" || key === "ref") continue;
    if (key === "dangerouslySetInnerHTML") throw new Error("Email templates never render raw HTML.");
    if (value === null || value === undefined || value === false) continue;
    if (typeof value === "function" || typeof value === "symbol") continue;
    const name = ATTR_NAMES[key] ?? key;
    if (!/^[a-zA-Z][a-zA-Z0-9:_.-]*$/.test(name)) continue;
    if (key === "style" && typeof value === "object") {
      const css = styleToCss(value as Record<string, unknown>);
      if (css) out += ` style="${escapeHtml(css)}"`;
      continue;
    }
    if (value === true) {
      out += ` ${name}`;
      continue;
    }
    out += ` ${name}="${escapeHtml(String(value))}"`;
  }
  return out;
}

type AnyElement = { $$typeof: symbol; type: unknown; props: Record<string, unknown> };

function isElement(node: unknown): node is AnyElement {
  if (!node || typeof node !== "object") return false;
  const t = (node as { $$typeof?: unknown }).$$typeof;
  return t === ELEMENT || t === LEGACY_ELEMENT;
}

function renderNode(node: unknown, depth: number): string {
  if (depth > 200) throw new Error("Email markup is nested too deeply.");
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string") return escapeHtml(node);
  if (typeof node === "number" || typeof node === "bigint") return escapeHtml(String(node));
  if (Array.isArray(node)) return node.map((n) => renderNode(n, depth + 1)).join("");
  if (isElement(node)) {
    const { type, props } = node;
    if (type === FRAGMENT) return renderNode(props.children, depth + 1);
    if (typeof type === "function") {
      const fn = type as (p: Record<string, unknown>) => unknown;
      return renderNode(fn(props), depth + 1);
    }
    if (typeof type === "string") {
      const tag = type.toLowerCase();
      if (!/^[a-z][a-z0-9-]*$/.test(tag)) throw new Error(`Invalid tag <${type}> in an email.`);
      const attrs = renderAttributes(props);
      if (VOID.has(tag)) return `<${tag}${attrs}>`;
      return `<${tag}${attrs}>${renderNode(props.children, depth + 1)}</${tag}>`;
    }
    throw new Error("Email templates support host elements, function components and fragments only.");
  }
  if (typeof node === "object" && Symbol.iterator in (node as object)) {
    return Array.from(node as Iterable<unknown>, (n) => renderNode(n, depth + 1)).join("");
  }
  return "";
}

/** The HTML of an element tree (no doctype). */
export function renderToHtml(element: React.ReactNode): string {
  return renderNode(element, 0);
}

/** A complete HTML document for an email. */
export function renderEmailDocument(element: React.ReactNode): string {
  return `<!DOCTYPE html>${renderToHtml(element)}`;
}
