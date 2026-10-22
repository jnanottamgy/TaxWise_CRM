"use client";

import { useEffect } from "react";

/**
 * The last-resort boundary: it replaces the root layout when that layout itself fails, so it brings
 * its own <html>, <body> and minimal styles (the app's stylesheet and theme are not loaded here).
 * The colours are the spec's tokens (§3.1), written out because no stylesheet is available.
 */

const COLORS = {
  navy: "#14284b",
  gold: "#b8892e",
  bg: "#f6f7fb",
  surface: "#ffffff",
  border: "#e4e7ee",
  text: "#0f172a",
  muted: "#5b6476",
  primary: "#1f4fd8",
};

const DARK_CSS = `
@media (prefers-color-scheme: dark) {
  body { background: #0b0f17 !important; color: #e6eaf2 !important; }
  .tw-ge-card { background: #121826 !important; border-color: #253049 !important; }
  .tw-ge-band { background: #0b1630 !important; }
  .tw-ge-muted { color: #9aa4b8 !important; }
  .tw-ge-primary { background: #5b8cff !important; color: #0b0f17 !important; }
  .tw-ge-outline { background: #121826 !important; color: #e6eaf2 !important; border-color: #253049 !important; }
}
.tw-ge-primary:focus-visible, .tw-ge-outline:focus-visible { outline: 2px solid ${COLORS.primary}; outline-offset: 2px; }
`;

function digestOf(error: unknown): string | null {
  if (error && typeof error === "object" && "digest" in error) {
    const d = (error as { digest?: unknown }).digest;
    if (typeof d === "string" && d) return d;
  }
  return null;
}

export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  const ref = digestOf(error);

  useEffect(() => {
    console.error(JSON.stringify({ level: "error", msg: "global error boundary", source: "boundary:global", ref }));
  }, [ref]);

  const button: React.CSSProperties = {
    height: 40,
    padding: "0 16px",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 500,
    cursor: "pointer",
    font: "inherit",
  };

  return (
    <html lang="en-IN">
      <head>
        <title>Something went wrong · TaxWise</title>
        <meta name="robots" content="noindex, nofollow" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>{DARK_CSS}</style>
      </head>
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
          boxSizing: "border-box",
          background: COLORS.bg,
          color: COLORS.text,
          fontFamily: "'Inter Variable', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
          fontSize: 14,
          lineHeight: "20px",
        }}
      >
        <main
          role="alert"
          className="tw-ge-card"
          style={{
            width: "100%",
            maxWidth: 480,
            background: COLORS.surface,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 16,
            overflow: "hidden",
          }}
        >
          <div
            className="tw-ge-band"
            style={{ background: COLORS.navy, color: "#ffffff", height: 56, display: "flex", alignItems: "center", gap: 10, padding: "0 20px" }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 30,
                height: 30,
                borderRadius: 7,
                border: `1.5px solid ${COLORS.gold}`,
                color: COLORS.gold,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: 600,
                fontSize: 13,
                letterSpacing: "0.04em",
              }}
            >
              TW
            </span>
            <span style={{ fontWeight: 600, fontSize: 16 }}>TaxWise Consultants</span>
          </div>
          <div style={{ padding: "24px 20px" }}>
            <h1 style={{ margin: 0, fontSize: 20, lineHeight: "28px", fontWeight: 600 }}>TaxWise didn&apos;t load</h1>
            <p className="tw-ge-muted" style={{ margin: "8px 0 0", color: COLORS.muted }}>
              Something went wrong on our side. Please try again, and if it keeps happening, quote the Ref below to a Partner.
            </p>
            {ref ? (
              <p className="tw-ge-muted" style={{ margin: "12px 0 0", color: COLORS.muted, fontSize: 13 }}>
                Ref <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", color: "inherit", userSelect: "all" }}>{ref}</span>
              </p>
            ) : null}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "flex-end", marginTop: 24 }}>
              {/* A full navigation, not a client one: the app's own layout is what failed. */}
              <a
                href="/"
                className="tw-ge-outline"
                style={{
                  ...button,
                  display: "inline-flex",
                  alignItems: "center",
                  textDecoration: "none",
                  color: COLORS.text,
                  background: COLORS.surface,
                  border: `1px solid ${COLORS.border}`,
                }}
              >
                Go home
              </a>
              <button
                type="button"
                className="tw-ge-primary"
                onClick={() => retry()}
                style={{ ...button, border: "none", background: COLORS.primary, color: "#ffffff" }}
              >
                Try again
              </button>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
