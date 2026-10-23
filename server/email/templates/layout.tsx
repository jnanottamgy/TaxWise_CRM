import "server-only";

import { createElement } from "react";
import type * as React from "react";
import { BRAND, POWERED_BY, displayWebsite, formatFirmAddress, type FirmProfile } from "@/server/firm";
import { renderEmailDocument, renderToHtml } from "@/server/email/render";

/**
 * The branded frame and building blocks every email uses (§10, §7.13.5, DESIGN.md §2).
 *
 * A template describes its content once as blocks (heading, paragraph, button, details, list,
 * callout, link, small print); `renderEmail` turns the same blocks into the HTML part and the
 * plain-text alternative, so the two never drift apart. Every email ends with the footer §7.13.5
 * asks for: the firm's name, address and phone · "This message was sent by <firm>" · a small
 * "Powered by J-TACS". Subjects are "<firm> | <item>" (§10).
 *
 * Markup is table-based with inline styles (what Outlook and Gmail render reliably), 600px wide,
 * one primary button per email, light palette from §3.1 with the *-text colours for status text.
 */

/** What the frame shows about the firm. Built from FirmProfile with `emailFirm`. */
export interface EmailFirm {
  firmName: string;
  tagline: string | null;
  /** One line: street, city, state PIN. */
  address: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  logoUrl: string | null;
}

export function emailFirm(profile: FirmProfile): EmailFirm {
  return {
    firmName: profile.firmName,
    tagline: profile.tagline,
    address: formatFirmAddress(profile),
    phone: profile.phone,
    email: profile.email,
    website: profile.website,
    logoUrl: profile.logoUrl,
  };
}

export interface DetailRow {
  label: string;
  value: string;
  /** Amounts and dates: tabular figures, right-aligned. */
  numeric?: boolean;
  /** The row that matters (the total, the amount due). */
  emphasis?: boolean;
  /** Codes, passwords and links in a monospace face. */
  mono?: boolean;
}

export interface ListItem {
  title: string;
  detail?: string | null;
}

export type EmailBlock =
  | { kind: "heading"; text: string }
  | { kind: "subheading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "button"; label: string; url: string }
  | { kind: "details"; rows: DetailRow[]; title?: string }
  | { kind: "list"; items: ListItem[]; title?: string; ordered?: boolean }
  | { kind: "callout"; tone: "info" | "warning" | "danger"; text: string }
  | { kind: "link"; label: string; url: string }
  | { kind: "small"; text: string }
  | { kind: "divider" };

export interface EmailContent {
  /** The item after "<firm> | ". */
  subjectItem: string;
  /** The inbox preview line. */
  preheader: string;
  /** "Dear Rakesh," — omitted when null. */
  greeting?: string | null;
  blocks: EmailBlock[];
  /** "Regards," + the signer lines. */
  signOff?: { closing?: string; lines: string[] } | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** The footer marker sendEmail looks for before adding a footer itself. */
export const FOOTER_MARKER = "This message was sent by";

export function emailSubject(firm: Pick<EmailFirm, "firmName">, item: string): string {
  const clean = item.replace(/\s+/g, " ").trim();
  return `${firm.firmName} | ${clean}`;
}

/** "TW" for TaxWise Consultants: the capitals of the first word, else the first two initials. */
export function monogram(firmName: string): string {
  const words = firmName.trim().split(/\s+/).filter(Boolean);
  const caps = (words[0] ?? "").replace(/[^A-Z]/g, "");
  if (caps.length >= 2) return caps.slice(0, 2);
  const initials = words.slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");
  return initials || "TW";
}

const FONT = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

/** The legacy `bgcolor` attribute (Outlook ignores CSS backgrounds on some cells); not in React's td types. */
function legacyBg(color: string): React.TdHTMLAttributes<HTMLTableCellElement> {
  return { bgcolor: color } as unknown as React.TdHTMLAttributes<HTMLTableCellElement>;
}

const TONE: Record<"info" | "warning" | "danger", { bg: string; border: string; text: string }> = {
  info: { bg: BRAND.primarySoft, border: "#C9D6FB", text: BRAND.text },
  warning: { bg: BRAND.warningSoft, border: "#F2D9A6", text: BRAND.text },
  danger: { bg: BRAND.dangerSoft, border: "#F5C2BD", text: BRAND.text },
};

function Lines({ text }: { text: string }) {
  const parts = text.split("\n");
  return (
    <>
      {parts.map((line, i) => (
        <span key={i}>
          {line}
          {i < parts.length - 1 ? <br /> : null}
        </span>
      ))}
    </>
  );
}

function Paragraph({ children, muted, small }: { children: React.ReactNode; muted?: boolean; small?: boolean }) {
  return (
    <p
      style={{
        margin: "0 0 16px",
        fontFamily: FONT,
        fontSize: small ? 13 : 15,
        lineHeight: small ? "20px" : "24px",
        color: muted ? BRAND.textMuted : BRAND.text,
      }}
    >
      {children}
    </p>
  );
}

function Button({ label, url }: { label: string; url: string }) {
  return (
    <table role="presentation" cellPadding={0} cellSpacing={0} border={0} style={{ margin: "8px 0 24px", borderCollapse: "separate" }}>
      <tbody>
        <tr>
          <td {...legacyBg(BRAND.primary)} style={{ borderRadius: 8, backgroundColor: BRAND.primary }}>
            <a
              href={url}
              target="_blank"
              style={{
                display: "inline-block",
                padding: "12px 22px",
                fontFamily: FONT,
                fontSize: 15,
                fontWeight: 600,
                lineHeight: "20px",
                color: "#FFFFFF",
                textDecoration: "none",
                borderRadius: 8,
              }}
            >
              {label}
            </a>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function Details({ rows, title }: { rows: DetailRow[]; title?: string }) {
  return (
    <>
      {title ? <SectionTitle text={title} /> : null}
      <table
        role="presentation"
        width="100%"
        cellPadding={0}
        cellSpacing={0}
        border={0}
        style={{ margin: "0 0 20px", borderCollapse: "collapse", border: `1px solid ${BRAND.border}`, borderRadius: 8 }}
      >
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.label}-${i}`}>
              <td
                style={{
                  padding: "10px 14px",
                  borderTop: i === 0 ? "none" : `1px solid ${BRAND.border}`,
                  fontFamily: FONT,
                  fontSize: 13,
                  lineHeight: "20px",
                  color: BRAND.textMuted,
                  verticalAlign: "top",
                  width: "42%",
                }}
              >
                {r.label}
              </td>
              <td
                align={r.numeric ? "right" : "left"}
                style={{
                  padding: "10px 14px",
                  borderTop: i === 0 ? "none" : `1px solid ${BRAND.border}`,
                  fontFamily: r.mono ? MONO : FONT,
                  fontSize: r.emphasis ? 16 : 14,
                  fontWeight: r.emphasis ? 600 : 400,
                  lineHeight: "20px",
                  color: BRAND.text,
                  fontVariantNumeric: "tabular-nums",
                  wordBreak: "break-word",
                  verticalAlign: "top",
                }}
              >
                <Lines text={r.value} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function SectionTitle({ text }: { text: string }) {
  return (
    <p style={{ margin: "0 0 8px", fontFamily: FONT, fontSize: 13, fontWeight: 600, lineHeight: "20px", color: BRAND.text }}>{text}</p>
  );
}

function List({ items, title, ordered }: { items: ListItem[]; title?: string; ordered?: boolean }) {
  return (
    <>
      {title ? <SectionTitle text={title} /> : null}
      <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0} style={{ margin: "0 0 20px", borderCollapse: "collapse" }}>
        <tbody>
          {items.map((it, i) => (
            <tr key={`${it.title}-${i}`}>
              <td
                style={{
                  width: 24,
                  padding: "6px 0",
                  verticalAlign: "top",
                  fontFamily: FONT,
                  fontSize: 14,
                  lineHeight: "22px",
                  color: BRAND.textMuted,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {ordered ? `${i + 1}.` : "•"}
              </td>
              <td style={{ padding: "6px 0", verticalAlign: "top", fontFamily: FONT, fontSize: 14, lineHeight: "22px", color: BRAND.text }}>
                <Lines text={it.title} />
                {it.detail ? (
                  <span style={{ display: "block", fontSize: 13, lineHeight: "20px", color: BRAND.textMuted }}>
                    <Lines text={it.detail} />
                  </span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Callout({ tone, text }: { tone: "info" | "warning" | "danger"; text: string }) {
  const t = TONE[tone];
  return (
    <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0} style={{ margin: "0 0 20px", borderCollapse: "separate" }}>
      <tbody>
        <tr>
          <td
            style={{
              padding: "12px 14px",
              backgroundColor: t.bg,
              border: `1px solid ${t.border}`,
              borderRadius: 8,
              fontFamily: FONT,
              fontSize: 14,
              lineHeight: "22px",
              color: t.text,
            }}
          >
            <Lines text={text} />
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function Block({ block }: { block: EmailBlock }) {
  switch (block.kind) {
    case "heading":
      return (
        <h1 style={{ margin: "0 0 16px", fontFamily: FONT, fontSize: 20, fontWeight: 600, lineHeight: "28px", letterSpacing: "-0.01em", color: BRAND.text }}>
          {block.text}
        </h1>
      );
    case "subheading":
      return (
        <p style={{ margin: "8px 0 8px", fontFamily: FONT, fontSize: 15, fontWeight: 600, lineHeight: "22px", color: BRAND.text }}>{block.text}</p>
      );
    case "paragraph":
      return (
        <Paragraph>
          <Lines text={block.text} />
        </Paragraph>
      );
    case "button":
      return <Button label={block.label} url={block.url} />;
    case "details":
      return <Details rows={block.rows} title={block.title} />;
    case "list":
      return <List items={block.items} title={block.title} ordered={block.ordered} />;
    case "callout":
      return <Callout tone={block.tone} text={block.text} />;
    case "link":
      return (
        <Paragraph muted small>
          {block.label}{" "}
          <a href={block.url} target="_blank" style={{ color: BRAND.primary, textDecoration: "underline", wordBreak: "break-all" }}>
            {block.url}
          </a>
        </Paragraph>
      );
    case "small":
      return (
        <Paragraph muted small>
          <Lines text={block.text} />
        </Paragraph>
      );
    case "divider":
      return <hr style={{ border: "none", borderTop: `1px solid ${BRAND.border}`, margin: "8px 0 20px" }} />;
  }
}

function Header({ firm }: { firm: EmailFirm }) {
  return (
    <tr>
      <td {...legacyBg(BRAND.navy)} style={{ backgroundColor: BRAND.navy, padding: "20px 28px", borderRadius: "12px 12px 0 0" }}>
        <table role="presentation" cellPadding={0} cellSpacing={0} border={0} style={{ borderCollapse: "collapse" }}>
          <tbody>
            <tr>
              <td style={{ verticalAlign: "middle", paddingRight: 12 }}>
                {firm.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- email markup, not a Next.js page
                  <img src={firm.logoUrl} alt={firm.firmName} height={32} style={{ display: "block", height: 32, maxWidth: 160, border: 0 }} />
                ) : (
                  <span
                    style={{
                      display: "inline-block",
                      width: 36,
                      height: 36,
                      lineHeight: "36px",
                      textAlign: "center",
                      borderRadius: 8,
                      border: `1px solid ${BRAND.gold}`,
                      fontFamily: FONT,
                      fontSize: 15,
                      fontWeight: 700,
                      letterSpacing: "0.02em",
                      color: BRAND.gold,
                    }}
                  >
                    {monogram(firm.firmName)}
                  </span>
                )}
              </td>
              <td style={{ verticalAlign: "middle" }}>
                <span style={{ display: "block", fontFamily: FONT, fontSize: 17, fontWeight: 600, lineHeight: "22px", color: "#FFFFFF" }}>
                  {firm.firmName}
                </span>
                {firm.tagline ? (
                  <span style={{ display: "block", fontFamily: FONT, fontSize: 12, lineHeight: "18px", color: "#C9D2E3" }}>{firm.tagline}</span>
                ) : null}
              </td>
            </tr>
          </tbody>
        </table>
      </td>
    </tr>
  );
}

/** "+91 97405 40239 · info@twchartered.com · www.twchartered.com" */
function contactLine(firm: EmailFirm): string {
  return [firm.phone, firm.email, displayWebsite(firm.website)].filter(Boolean).join(" · ");
}

function Footer({ firm }: { firm: EmailFirm }) {
  const contact = contactLine(firm);
  return (
    <tr>
      <td style={{ padding: "20px 28px 24px", borderTop: `1px solid ${BRAND.border}` }}>
        <p style={{ margin: "0 0 4px", fontFamily: FONT, fontSize: 13, fontWeight: 600, lineHeight: "20px", color: BRAND.text }}>{firm.firmName}</p>
        {firm.address ? <p style={{ margin: "0 0 4px", fontFamily: FONT, fontSize: 12, lineHeight: "18px", color: BRAND.textMuted }}>{firm.address}</p> : null}
        {contact ? <p style={{ margin: "0 0 12px", fontFamily: FONT, fontSize: 12, lineHeight: "18px", color: BRAND.textMuted }}>{contact}</p> : null}
        <p style={{ margin: "0 0 4px", fontFamily: FONT, fontSize: 12, lineHeight: "18px", color: BRAND.textMuted }}>
          {FOOTER_MARKER} {firm.firmName}.
        </p>
        <p style={{ margin: 0, fontFamily: FONT, fontSize: 11, lineHeight: "16px", color: BRAND.goldText }}>{POWERED_BY}</p>
      </td>
    </tr>
  );
}

function Frame({ firm, preheader, title, children }: { firm: EmailFirm; preheader: string; title: string; children: React.ReactNode }) {
  return (
    <html lang="en">
      {/* eslint-disable-next-line @next/next/no-head-element -- email markup, not a Next.js page */}
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light" />
        <meta name="supported-color-schemes" content="light" />
        <title>{title}</title>
      </head>
      <body style={{ margin: 0, padding: 0, backgroundColor: BRAND.bg, WebkitTextSizeAdjust: "100%" }}>
        <div style={{ display: "none", maxHeight: 0, overflow: "hidden", opacity: 0, color: "transparent", fontSize: 1, lineHeight: "1px" }}>
          {preheader}
        </div>
        <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0} bgcolor={BRAND.bg} style={{ backgroundColor: BRAND.bg, borderCollapse: "collapse" }}>
          <tbody>
            <tr>
              <td align="center" style={{ padding: "24px 12px" }}>
                <table
                  role="presentation"
                  width="100%"
                  cellPadding={0}
                  cellSpacing={0}
                  border={0}
                  bgcolor={BRAND.surface}
                  style={{
                    maxWidth: 600,
                    backgroundColor: BRAND.surface,
                    border: `1px solid ${BRAND.border}`,
                    borderRadius: 12,
                    borderCollapse: "separate",
                  }}
                >
                  <tbody>
                    <Header firm={firm} />
                    <tr>
                      <td style={{ padding: "28px 28px 8px" }}>{children}</td>
                    </tr>
                    <Footer firm={firm} />
                  </tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>
      </body>
    </html>
  );
}

// -------------------------------------------------------------------------------------------------
// Plain text
// -------------------------------------------------------------------------------------------------

function textBlock(block: EmailBlock): string {
  switch (block.kind) {
    case "heading":
    case "subheading":
      return block.text;
    case "paragraph":
    case "small":
      return block.text;
    case "callout":
      return block.text;
    case "button":
      return `${block.label}: ${block.url}`;
    case "link":
      return `${block.label} ${block.url}`;
    case "details": {
      const width = Math.min(28, Math.max(...block.rows.map((r) => r.label.length)));
      const rows = block.rows.map((r) => `${`${r.label}:`.padEnd(width + 2)}${r.value.replace(/\n/g, `\n${" ".repeat(width + 2)}`)}`);
      return [block.title, ...rows].filter(Boolean).join("\n");
    }
    case "list": {
      const items = block.items.map((it, i) => {
        const bullet = block.ordered ? `${i + 1}.` : "-";
        return it.detail ? `${bullet} ${it.title}\n  ${it.detail}` : `${bullet} ${it.title}`;
      });
      return [block.title, ...items].filter(Boolean).join("\n");
    }
    case "divider":
      return "—";
  }
}

/** The plain-text footer (§7.13.5). */
export function textFooter(firm: EmailFirm): string {
  return ["--", firm.firmName, firm.address, contactLine(firm), `${FOOTER_MARKER} ${firm.firmName}.`, POWERED_BY]
    .filter((l) => l && l.trim())
    .join("\n");
}

// -------------------------------------------------------------------------------------------------
// Rendering
// -------------------------------------------------------------------------------------------------

function renderWithSubject(content: EmailContent, firm: EmailFirm, subject: string): RenderedEmail {
  const sign = content.signOff ? [content.signOff.closing ?? "Regards,", ...content.signOff.lines] : [];

  const html = renderEmailDocument(
    <Frame firm={firm} preheader={content.preheader} title={subject}>
      {content.greeting ? (
        <Paragraph>
          <Lines text={content.greeting} />
        </Paragraph>
      ) : null}
      {content.blocks.map((b, i) => (
        <Block key={i} block={b} />
      ))}
      {sign.length ? (
        <Paragraph>
          <Lines text={sign.join("\n")} />
        </Paragraph>
      ) : null}
    </Frame>,
  );

  const text = [content.greeting ?? null, ...content.blocks.map(textBlock), sign.length ? sign.join("\n") : null, textFooter(firm)]
    .filter((p): p is string => typeof p === "string" && p.trim() !== "")
    .join("\n\n");

  return { subject, html, text };
}

export function renderEmail(content: EmailContent, firm: EmailFirm): RenderedEmail {
  return renderWithSubject(content, firm, emailSubject(firm, content.subjectItem));
}

function paragraphsOf(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Wraps plain text a caller wrote itself (a note typed by a person, a notification) in the branded
 * frame, one paragraph per blank-line-separated block.
 */
export function renderPlainText(input: { subjectItem: string; text: string; preheader?: string }, firm: EmailFirm): RenderedEmail {
  const paragraphs = paragraphsOf(input.text);
  return renderEmail(
    {
      subjectItem: input.subjectItem,
      preheader: input.preheader ?? paragraphs[0]?.slice(0, 120) ?? input.subjectItem,
      blocks: paragraphs.map((text) => ({ kind: "paragraph" as const, text })),
    },
    firm,
  );
}

const RAW_SLOT = "tw-raw-html";

/** The footer as an HTML fragment (a one-row table), for HTML a caller built without one. */
export function footerHtml(firm: EmailFirm): string {
  return renderToHtml(
    <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0} style={{ maxWidth: 600, margin: "0 auto", borderCollapse: "collapse" }}>
      <tbody>
        <Footer firm={firm} />
      </tbody>
    </table>,
  );
}

/**
 * Makes sure an email carries the §7.13.5 footer in both parts, whatever the caller built:
 *   - text without the footer gets the plain-text footer;
 *   - no HTML: the text, paragraph by paragraph, in the branded frame;
 *   - a full HTML document without the footer: the footer before </body>;
 *   - an HTML fragment: placed inside the branded frame.
 */
export function withFooter(mail: { subject: string; text: string; html?: string | null }, firm: EmailFirm): { html: string; text: string } {
  const text = mail.text.includes(FOOTER_MARKER) ? mail.text : `${mail.text.trimEnd()}\n\n${textFooter(firm)}`;
  const raw = mail.html?.trim();
  if (!raw) {
    const paragraphs = paragraphsOf(mail.text.split(/\n--\n/)[0] ?? mail.text);
    const html = renderWithSubject(
      { subjectItem: mail.subject, preheader: paragraphs[0]?.slice(0, 120) ?? mail.subject, blocks: paragraphs.map((t) => ({ kind: "paragraph" as const, text: t })) },
      firm,
      mail.subject,
    ).html;
    return { html, text };
  }
  if (raw.includes(FOOTER_MARKER)) return { html: raw, text };
  if (/<\/body>/i.test(raw)) return { html: raw.replace(/<\/body>/i, `${footerHtml(firm)}</body>`), text };
  const framed = renderEmailDocument(
    <Frame firm={firm} preheader={paragraphsOf(mail.text)[0]?.slice(0, 120) ?? mail.subject} title={mail.subject}>
      {createElement(RAW_SLOT)}
    </Frame>,
  );
  return { html: framed.replace(`<${RAW_SLOT}></${RAW_SLOT}>`, raw), text };
}
