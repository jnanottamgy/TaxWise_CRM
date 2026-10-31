"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BellIcon, ChevronRightIcon, CircleHelpIcon, MenuIcon, SearchIcon, TimerIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Keys } from "@/components/app/shortcut-sheet";
import type { Crumb } from "@/components/app/page-header";
import { findActiveNav } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { FySwitcher } from "./fy-switcher";
import { useShell, useSlot } from "./shell-context";

/**
 * The top bar (§3.3): where you are (breadcrumb slot), global search (⌘K), the FY switcher, the
 * timer, the Inbox bell (§7.17) and Help. On phones: the menu button, the page name, search, the
 * bell and Help.
 */
export function TopBar() {
  const { user, slots, setOpen, unreadCount } = useShell();
  const pathname = usePathname() ?? "/";
  const slotTitle = useSlot(slots, "title");

  const crumbs = React.useMemo<Crumb[]>(() => {
    if (slotTitle && slotTitle.length > 0) return slotTitle;
    const active = findActiveNav(pathname, user.role);
    if (!active) return [];
    const exact = active.item.href.split("?")[0] === pathname;
    const out: Crumb[] = [];
    const home = active.parent ?? active;
    if (home.group?.label) out.push({ label: home.group.label });
    let label = active.item.label;
    if (active.parent) {
      out.push({ label: active.parent.item.label, href: active.parent.item.href });
      // "Settings: Bank & UPI" under "Settings" reads as "Bank & UPI".
      const prefix = `${active.parent.item.label}: `;
      if (label.startsWith(prefix)) label = label.slice(prefix.length);
    }
    out.push(exact ? { label } : { label, href: active.item.href });
    return out;
  }, [slotTitle, pathname, user.role]);

  const current = crumbs.length > 0 ? crumbs[crumbs.length - 1] : null;

  return (
    // On the navy frame, above the paper sheet (DESIGN.md §2).
    <header className="on-frame sticky top-0 z-30 flex h-14 flex-none items-center gap-1 bg-frame px-2 sm:gap-2 md:pr-0 md:pl-8 xl:pl-10">
      <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open navigation" onClick={() => setOpen("drawer", true)}>
        <MenuIcon aria-hidden="true" />
      </Button>

      {/* Phones: the page's name. Wider screens: the breadcrumb. */}
      <p className="min-w-0 flex-1 truncate px-1 text-md font-semibold text-text md:hidden">{current?.label ?? ""}</p>
      <nav aria-label="Breadcrumb" className="hidden min-w-0 flex-1 md:block">
        <ol className="flex min-w-0 items-center gap-1.5 text-sm">
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            return (
              <li key={`${c.label}-${i}`} className={cn("flex min-w-0 items-center gap-1.5", last ? "flex-1" : "flex-none")}>
                {i > 0 ? <ChevronRightIcon aria-hidden="true" className="size-3.5 flex-none text-text-muted" /> : null}
                {last && !c.href ? (
                  <span aria-current="page" className="truncate font-medium text-text">
                    {c.label}
                  </span>
                ) : c.href ? (
                  <Link
                    href={c.href}
                    className="truncate rounded-sm text-text-muted outline-none hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    {c.label}
                  </Link>
                ) : (
                  <span className="truncate text-text-muted">{c.label}</span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>

      <button
        type="button"
        onClick={() => setOpen("palette", true)}
        className="hidden h-9 w-56 flex-none cursor-pointer items-center gap-2 rounded-md border border-border bg-surface-2 px-3 text-sm text-text-muted outline-none transition-colors duration-150 ease-out hover:border-text-muted/40 hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:flex lg:w-72"
      >
        <SearchIcon aria-hidden="true" className="size-4 flex-none" />
        <span className="flex-1 truncate text-left">Search or jump to…</span>
        <Keys keys={["mod", "K"]} />
      </button>
      <IconAction label="Search" className="md:hidden" onClick={() => setOpen("palette", true)}>
        <SearchIcon aria-hidden="true" />
      </IconAction>

      <FySwitcher className="hidden md:inline-flex" />

      <IconAction label="Timer" className="hidden md:inline-flex" onClick={() => setOpen("timer", true)}>
        <TimerIcon aria-hidden="true" />
      </IconAction>

      <InboxBell count={unreadCount} />

      <IconAction label="Help for this page" onClick={() => setOpen("help", true)}>
        <CircleHelpIcon aria-hidden="true" />
      </IconAction>
    </header>
  );
}

function IconAction({
  label,
  className,
  onClick,
  children,
}: {
  label: string;
  className?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn("flex-none text-text-muted hover:text-text", className)}
          aria-label={label}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** The bell opens the Inbox (§7.17). The badge shows only when something is unread. */
function InboxBell({ count }: { count: number | null }) {
  const unread = count !== null && count > 0;
  const label = unread ? `Inbox, ${count} unread` : "Inbox";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button asChild variant="ghost" size="icon" className="relative flex-none text-text-muted hover:text-text">
          <Link href="/inbox" aria-label={label}>
            <BellIcon aria-hidden="true" />
            {unread ? (
              <span
                aria-hidden="true"
                className="num absolute top-1 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-gold px-1 text-[11px] leading-none font-semibold text-[#0c1830] pointer-coarse:top-2 pointer-coarse:right-1.5"
              >
                {count > 99 ? "99+" : count}
              </span>
            ) : null}
          </Link>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
