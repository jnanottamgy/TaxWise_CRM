"use client";

import { RouteError } from "@/components/shell/route-error";

/** Error boundary for the client portal (§0.1 rule 3): the portal's header and menu stay on screen. */
export default function PortalError({ error, retry }: { error: unknown; retry: () => void }) {
  return <RouteError error={error} retry={retry} source="boundary:(portal)" homeHref="/portal" homeLabel="Go to portal home" />;
}
