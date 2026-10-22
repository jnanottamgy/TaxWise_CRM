"use client";

import { RouteError } from "@/components/shell/route-error";

/**
 * Error boundary for the firm's app (§0.1 rule 3). The staff layout stays on screen: the sidebar and
 * top bar keep working, and this replaces only the page that failed.
 */
export default function StaffError({ error, retry }: { error: unknown; retry: () => void }) {
  return <RouteError error={error} retry={retry} source="boundary:(staff)" homeHref="/" homeLabel="Go to my home page" />;
}
