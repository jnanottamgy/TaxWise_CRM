"use client";

import { RouteError } from "@/components/shell/route-error";

/**
 * The root error boundary. It catches what the route groups' own boundaries can't: an error thrown
 * by a group's layout, and errors in pages outside any group (§0.1 rule 3).
 */
export default function RootError({ error, retry }: { error: unknown; retry: () => void }) {
  return <RouteError error={error} retry={retry} source="boundary:root" standalone />;
}
