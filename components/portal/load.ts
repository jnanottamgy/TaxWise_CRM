import "server-only";

import { unstable_rethrow } from "next/navigation";
import { logUnexpected } from "@/lib/log";
import type { Loaded } from "@/components/portal/portal-ui";

/**
 * Runs one block's load for a portal page and never throws (§0.1 rules 2–3): a failure is logged
 * with a Ref and the block shows its own error with Retry, while the rest of the page renders.
 * Next's redirect / not-found signals pass through.
 */
export async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, data: await load() };
  } catch (err) {
    unstable_rethrow(err);
    return { ok: false, ref: logUnexpected(err, { source: `page:/portal:${source}`, userId, role: "client" }) };
  }
}
