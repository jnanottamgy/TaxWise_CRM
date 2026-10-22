import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "TaxWise Consultants", template: "%s · TaxWise" },
  description: "TaxWise Consultants practice workspace. Powered by J-TACS.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-IN" suppressHydrationWarning>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
