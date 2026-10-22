import type { Metadata, Viewport } from "next";
import { DENSITY_COMPACT_CLASS, DENSITY_COOKIE } from "@/lib/preferences";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "TaxWise Consultants", template: "%s · TaxWise" },
  description: "TaxWise Consultants practice workspace. Powered by J-TACS.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Lets the phone tab bar and sheets pad themselves clear of the home indicator.
  viewportFit: "cover",
};

/**
 * Compact rows (§3.2) must be on <html> before the first paint, and React must never own that class
 * (next-themes adds `light`/`dark` to the same element). A static inline script reads the display
 * cookie the user menu writes; it runs once, during parsing, before anything is drawn.
 */
const DENSITY_SCRIPT = `(function(){try{var m=document.cookie.match(/(?:^|;\\s*)${DENSITY_COOKIE}=([^;]*)/);if(m&&decodeURIComponent(m[1])==="compact"){document.documentElement.classList.add("${DENSITY_COMPACT_CLASS}")}}catch(e){}})();`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-IN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: DENSITY_SCRIPT }} />
      </head>
      <body className="min-h-dvh">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
