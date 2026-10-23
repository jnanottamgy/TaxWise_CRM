"use server"

import { headers } from "next/headers"
import type { RespondInput } from "@/lib/schemas/quotations"
import { clientIp, respondPublic, type RespondResult } from "@/server/quotations-public"

/**
 * The client's Accept or Decline from their link (§7.23). No session: the token is the key, checked
 * and rate-limited (10 an hour per token + IP, §13) in server/quotations-public.ts, which records the
 * response through the security-definer function and tells the firm. Never throws.
 */
export async function respondToQuotation(token: string, input: RespondInput): Promise<RespondResult> {
  const h = await headers()
  return respondPublic(token, input, clientIp(h), h.get("user-agent"))
}
