import { LinkIcon } from "lucide-react"
import { PublicNotice } from "@/components/quotations/public/public-notice"

/** A link that isn't a quotation we can show: mistyped, deleted, or not sent yet (§7.23). */
export default function PublicQuotationNotFound() {
  return (
    <PublicNotice tone="muted" icon={<LinkIcon className="text-text-muted" />} title="This link isn't valid any more">
      Check that the whole link from our message was opened. If it was, the quotation may have been withdrawn: please contact TaxWise Consultants for a new one.
    </PublicNotice>
  )
}
