import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { KpiGrid, MoneyText, figure, money } from "@/components/home/kpi-grid";
import { toPaise } from "@/lib/domain/money";

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe("the home pages' KPI grid", () => {
  it("formats figures in Indian grouping and amounts compactly with the full value", () => {
    expect(figure(1234567)).toBe("12,34,567");
    expect(money(toPaise("1234567"))).toEqual({ short: "₹12.3L", full: "₹12,34,567.00" });
  });

  it("links every figure to its list and gives screen readers the full amount", () => {
    const out = html(
      createElement(KpiGrid, {
        "aria-label": "The firm's figures",
        lead: true,
        cols: 3,
        items: [
          { label: "Overdue receivables", value: money(toPaise("345600")), sub: "5 invoices past the due date", href: "/invoices?status=overdue", tone: "danger" },
          { label: "Active clients", value: figure(84), href: "/clients?status=active" },
          { label: "Team online now", value: figure(0) },
        ],
      }),
    );
    expect(out).toContain('role="group"');
    expect(out).toContain('aria-label="The firm&#x27;s figures"');
    expect(out).toContain('href="/invoices?status=overdue"');
    expect(out).toContain('href="/clients?status=active"');
    // The compact amount is shown, the full one is read out.
    expect(out).toContain('<span aria-hidden="true">₹3.5L</span><span class="sr-only">₹3,45,600.00</span>');
    // The lead is the one 40px figure; the rest are 30px, all in the serif; the overdue amount carries the status colour.
    expect(out.match(/text-\[40px\]/g)).toHaveLength(1);
    expect(out).toContain("font-serif");
    expect(out).toContain("text-danger-text");
    // An honest zero, printed like any figure.
    expect(out).toContain(">0<");
    // Nothing focusable inside a link.
    expect(out).not.toMatch(/<a[^>]*>[^]*?tabindex[^]*?<\/a>/);
  });

  it("lets an odd last figure span both columns on phones so no cell is orphaned", () => {
    const four = html(createElement(KpiGrid, { lead: true, items: ["a", "b", "c", "d"].map((l) => ({ label: l, value: "1" })) }));
    // Lead + 3: the lead spans, and so does the last of the three.
    expect(four.match(/max-md:col-span-2/g)).toHaveLength(2);
    const five = html(createElement(KpiGrid, { lead: true, items: ["a", "b", "c", "d", "e"].map((l) => ({ label: l, value: "1" })) }));
    expect(five.match(/max-md:col-span-2/g)).toHaveLength(1);
  });

  it("shows a compact amount inline with its full value as the title", () => {
    expect(html(createElement(MoneyText, { paise: toPaise("1180000") }))).toContain('title="₹11,80,000.00"');
    expect(html(createElement(MoneyText, { paise: toPaise("590") }))).toContain('<span aria-hidden="true">₹590</span><span class="sr-only">₹590.00</span>');
    expect(html(createElement(MoneyText, { paise: 0 }))).toContain("₹0");
  });
});
