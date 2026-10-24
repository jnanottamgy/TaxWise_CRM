import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as React from "react";
import { Text, View } from "@react-pdf/renderer";
import { defaultFirmProfile } from "@/server/firm";
import { PdfDocument } from "@/server/pdf/document";
import { renderPdf } from "@/server/pdf/render";

/**
 * The shared footer (§11 "the footer on every page") repeats on every page of a multi-page document,
 * with "Page n of N", in portrait and landscape. react-pdf 4 dropped the old bottom-anchored footer
 * from every page once the page style carried a lineHeight. Read back with pdftotext (poppler) where
 * it is installed; the PDF is still rendered everywhere else.
 */

function hasPdftotext(): boolean {
  try {
    execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function render(lines: number, landscape: boolean): Promise<Buffer> {
  const rows = Array.from({ length: lines }, (_, i) => React.createElement(View, { key: i }, React.createElement(Text, null, `Line ${i + 1} of the working paper.`)));
  const props = { firm: defaultFirmProfile(), documentTitle: "Footer check", title: "Footer check", footerNote: "Computer-generated", landscape } as React.ComponentProps<typeof PdfDocument>;
  return renderPdf(React.createElement(PdfDocument, props, ...rows));
}

function pageTexts(pdf: Buffer): string[] {
  const dir = mkdtempSync(join(tmpdir(), "tw-pdf-"));
  try {
    const file = join(dir, "doc.pdf");
    writeFileSync(file, pdf);
    return execFileSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8" }).split("\f").filter((p) => p.trim().length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("PDF footer on every page (§11)", () => {
  it.skipIf(!hasPdftotext())("repeats with the page number on a three-page portrait document", async () => {
    const pages = pageTexts(await render(140, false));
    expect(pages.length).toBe(3);
    pages.forEach((p, i) => {
      expect(p).toContain("Computer-generated · TaxWise Consultants · Powered by J-TACS");
      expect(p).toContain(`Page ${i + 1} of 3`);
    });
  });

  it.skipIf(!hasPdftotext())("repeats on landscape pages, and a one-page document has no page number", async () => {
    const wide = pageTexts(await render(90, true));
    expect(wide.length).toBeGreaterThan(1);
    wide.forEach((p, i) => expect(p).toContain(`Page ${i + 1} of ${wide.length}`));
    const one = pageTexts(await render(5, false));
    expect(one.length).toBe(1);
    expect(one[0]).toContain("Powered by J-TACS");
    expect(one[0]).not.toMatch(/Page 1 of/);
  });

  it("renders a PDF either way", async () => {
    const pdf = await render(60, false);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });
});
