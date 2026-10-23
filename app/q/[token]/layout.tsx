import type { Metadata } from "next"
import { PublicQuotationFrame } from "@/components/quotations/public/public-frame"

export const metadata: Metadata = {
  title: { absolute: "Quotation · TaxWise Consultants" },
  description: "A quotation from TaxWise Consultants, Chartered Accountants.",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
  // The link is the key to the quotation: never send it on to another site as a referrer.
  referrer: "no-referrer",
}

/**
 * The client's quotation link (§7.23): no login, TaxWise-branded, never indexed. Static on purpose
 * (it loads nothing, so it can never throw, §0.1 rule 3): the navy band with the firm's mark, the
 * page, and "Powered by J-TACS". Mobile-first; the quotation reads at 390 px.
 */
export default function PublicQuotationLayout({ children }: { children: React.ReactNode }) {
  return <PublicQuotationFrame>{children}</PublicQuotationFrame>
}
