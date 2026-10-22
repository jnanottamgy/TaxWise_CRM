"use client";

import * as React from "react";
import type { Crumb } from "@/components/app/page-header";
import { useOptionalShell } from "./shell-context";

/**
 * Slots a page fills in the staff shell. Both render nothing themselves and are no-ops outside the
 * shell, so they are safe in shared components.
 *
 * The top bar shows where you are. By default it is the sidebar group and item for the path
 * ("Work › Work tracker"); a detail page names the record:
 *
 *   <ShellTitle crumbs={[{ label: "Clients", href: "/clients" }, { label: "Sharma Traders" }]} />
 *
 * The Help button opens the page's guide. Without one, it shows the sidebar item's one-line
 * description:
 *
 *   <PageGuide title="Filings grid">
 *     <p>Each cell is one return for one period…</p>
 *   </PageGuide>
 */

export function ShellTitle({ crumbs }: { crumbs: Crumb[] }) {
  const shell = useOptionalShell();
  const store = shell?.slots ?? null;
  // Keyed by content, so an inline array doesn't re-fill the slot on every render.
  const key = JSON.stringify(crumbs.map((c) => [c.label, c.href ?? null]));
  React.useEffect(() => {
    if (!store) return;
    const value = (JSON.parse(key) as Array<[string, string | null]>).map(([label, href]): Crumb => (href ? { label, href } : { label }));
    const token = store.set("title", value);
    return () => store.clear("title", token);
  }, [store, key]);
  return null;
}

export function PageGuide({ title, children }: { title?: string; children: React.ReactNode }) {
  const shell = useOptionalShell();
  const store = shell?.slots ?? null;
  React.useEffect(() => {
    if (!store) return;
    const token = store.set("guide", { title, body: children });
    return () => store.clear("guide", token);
  }, [store, title, children]);
  return null;
}
