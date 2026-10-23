import { describe, expect, it } from "vitest";
import { parseInline, parseNotice } from "@/components/portal/markdown";

describe("parseInline", () => {
  it("splits bold spans from plain text", () => {
    expect(parseInline("Email **info@twchartered.com** with the subject")).toEqual([
      { text: "Email ", bold: false },
      { text: "info@twchartered.com", bold: true },
      { text: " with the subject", bold: false },
    ]);
  });

  it("keeps a link's words and shows its address; never produces markup", () => {
    expect(parseInline("See [our site](https://www.twchartered.com) today")).toEqual([{ text: "See our site (https://www.twchartered.com) today", bold: false }]);
    expect(parseInline("<script>alert(1)</script>")).toEqual([{ text: "<script>alert(1)</script>", bold: false }]);
  });

  it("drops stray emphasis markers but leaves words with underscores alone", () => {
    expect(parseInline("_italic_ and file_name")).toEqual([{ text: "italic and file_name", bold: false }]);
  });
});

describe("parseNotice", () => {
  it("reads headings, paragraphs and lists", () => {
    const blocks = parseNotice(
      ["# Privacy notice", "", "We are the Data Fiduciary", "for this data.", "", "## What we collect", "- **Identity:** name", "- PAN, TAN", "", "1. First", "2. Second"].join("\n"),
    );
    expect(blocks.map((b) => b.kind)).toEqual(["h1", "p", "h2", "ul", "ol"]);
    expect(blocks[1]).toEqual({ kind: "p", text: [{ text: "We are the Data Fiduciary for this data.", bold: false }] });
    expect(blocks[3]).toEqual({
      kind: "ul",
      items: [
        [
          { text: "Identity:", bold: true },
          { text: " name", bold: false },
        ],
        [{ text: "PAN, TAN", bold: false }],
      ],
    });
  });

  it("joins a wrapped list item and handles Windows line endings", () => {
    const blocks = parseNotice("- audit working papers: at least 7 years\r\n  from the date of the report\r\n- GST records: 72 months");
    expect(blocks).toEqual([
      {
        kind: "ul",
        items: [[{ text: "audit working papers: at least 7 years from the date of the report", bold: false }], [{ text: "GST records: 72 months", bold: false }]],
      },
    ]);
  });

  it("is empty for an empty notice", () => {
    expect(parseNotice("")).toEqual([]);
    expect(parseNotice(null)).toEqual([]);
  });
});
