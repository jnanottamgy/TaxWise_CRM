"use client"

import { useEffect } from "react"
import { CircleAlertIcon, RotateCwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { errorDigest } from "@/components/shell/route-error"

/**
 * The client's quotation page failed (§0.1 rule 3). The layout is static, so the TaxWise band stays;
 * this says what to do and gives the Ref to quote, in words for a client rather than staff.
 */
export default function PublicQuotationError({ error, retry }: { error: unknown; retry: () => void }) {
  const ref = errorDigest(error)
  useEffect(() => {
    console.error(JSON.stringify({ level: "error", msg: "public quotation page error", source: "boundary:/q/[token]", ref }))
  }, [ref])
  return (
    <section role="alert" className="flex flex-col gap-4 rounded-lg border border-danger/30 bg-danger-soft px-4 py-4 md:px-6">
      <div className="flex gap-3">
        <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-5 flex-none text-danger-text" />
        <div className="min-w-0">
          <h1 className="text-md leading-6 font-semibold text-text">This quotation didn&apos;t load</h1>
          <p className="mt-0.5 text-base text-text">
            Something went wrong on our side. Please try again in a few minutes.
            {ref ? (
              <>
                {" "}If it keeps happening, contact TaxWise and quote Ref <span className="font-mono text-[13px]">{ref}</span>.
              </>
            ) : (
              " If it keeps happening, contact TaxWise."
            )}
          </p>
        </div>
      </div>
      <div>
        <Button type="button" size="lg" onClick={() => retry()}>
          <RotateCwIcon aria-hidden="true" />
          Try again
        </Button>
      </div>
    </section>
  )
}
