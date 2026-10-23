import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createElement, Fragment } from "react";
import { escapeHtml, renderEmailDocument, renderToHtml, styleToCss } from "@/server/email/render";

describe("email renderer (server/email/render.ts)", () => {
  it("escapes text and attribute values", () => {
    expect(escapeHtml(`<b>"Tom" & 'Jerry'</b>`)).toBe("&lt;b&gt;&quot;Tom&quot; &amp; &#39;Jerry&#39;&lt;/b&gt;");
    const html = renderToHtml(createElement("a", { href: `https://x.test/?a=1&b="2"` }, "<script>alert(1)</script>"));
    expect(html).toBe(`<a href="https://x.test/?a=1&amp;b=&quot;2&quot;">&lt;script&gt;alert(1)&lt;/script&gt;</a>`);
  });

  it("turns style objects into inline CSS, numbers into px except unitless properties", () => {
    expect(styleToCss({ fontSize: 14, lineHeight: 1.4, fontWeight: 600, margin: 0, padding: "4px 8px", WebkitTextSizeAdjust: "100%" })).toBe(
      "font-size:14px;line-height:1.4;font-weight:600;margin:0;padding:4px 8px;-webkit-text-size-adjust:100%",
    );
    expect(styleToCss({ color: undefined, border: null, display: "" })).toBe("");
  });

  it("maps React prop names, drops handlers, false and null, keeps boolean attributes", () => {
    const html = renderToHtml(
      createElement("table", { cellPadding: 0, cellSpacing: 0, className: "x", onClick: () => undefined, hidden: false, title: null, border: 0 },
        createElement("tbody", null, createElement("tr", null, createElement("td", { colSpan: 2, align: "right" }, "x")))),
    );
    expect(html).toBe(`<table cellpadding="0" cellspacing="0" class="x" border="0"><tbody><tr><td colspan="2" align="right">x</td></tr></tbody></table>`);
    expect(renderToHtml(createElement("input", { disabled: true, value: "a" }))).toBe(`<input disabled value="a">`);
  });

  it("renders void elements without a closing tag", () => {
    expect(renderToHtml(createElement("p", null, "a", createElement("br"), "b"))).toBe("<p>a<br>b</p>");
    expect(renderToHtml(createElement("img", { src: "x.png", alt: "" }))).toBe(`<img src="x.png" alt="">`);
  });

  it("renders function components, fragments, arrays and numbers; skips booleans and null", () => {
    const Item = ({ n }: { n: number }) => createElement("li", null, "Item ", n);
    const html = renderToHtml(createElement(Fragment, null, createElement("ul", null, [1, 2].map((n) => createElement(Item, { key: n, n }))), false, null, 0));
    expect(html).toBe("<ul><li>Item 1</li><li>Item 2</li></ul>0");
  });

  it("never renders raw HTML", () => {
    expect(() => renderToHtml(createElement("div", { dangerouslySetInnerHTML: { __html: "<b>x</b>" } }))).toThrow(/raw HTML/);
  });

  it("refuses invalid tag names", () => {
    expect(() => renderToHtml(createElement("bad tag" as "div"))).toThrow(/Invalid tag/);
  });

  it("prefixes the doctype for a document", () => {
    expect(renderEmailDocument(createElement("html", null))).toBe("<!DOCTYPE html><html></html>");
  });
});
