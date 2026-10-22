"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building2Icon, ListChecksIcon, MenuIcon, SunIcon, TimerIcon, type LucideIcon } from "lucide-react";
import { navMatchScore } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { useShell } from "./shell-context";

/**
 * The Employees' bottom tab bar on phones (§3.3): Today · Tasks · Timer · Clients · More.
 * Timer opens the timer sheet; More opens the navigation drawer.
 */

const LINKS: Array<{ label: string; href: string; icon: LucideIcon }> = [
  { label: "Today", href: "/my-day", icon: SunIcon },
  { label: "Tasks", href: "/work", icon: ListChecksIcon },
  { label: "Clients", href: "/clients", icon: Building2Icon },
];

const TAB_CLASS =
  "flex min-h-14 flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-md text-xs font-medium outline-none transition-colors duration-150 ease-out focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";

export function MobileTabBar() {
  const { setOpen, isOpen } = useShell();
  const pathname = usePathname() ?? "/";

  const link = (index: number) => {
    const { label, href, icon: Icon } = LINKS[index];
    const active = navMatchScore(pathname, { href }) >= 0;
    return (
      <Link href={href} aria-current={active ? "page" : undefined} className={cn(TAB_CLASS, active ? "text-primary" : "text-text-muted hover:text-text")}>
        <Icon aria-hidden="true" className="size-5" />
        {label}
      </Link>
    );
  };

  return (
    <nav
      aria-label="Quick"
      className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-surface px-1 pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {link(0)}
      {link(1)}
      <button
        type="button"
        onClick={() => setOpen("timer", true)}
        aria-expanded={isOpen("timer")}
        className={cn(TAB_CLASS, isOpen("timer") ? "text-primary" : "text-text-muted hover:text-text")}
      >
        <TimerIcon aria-hidden="true" className="size-5" />
        Timer
      </button>
      {link(2)}
      <button
        type="button"
        onClick={() => setOpen("drawer", true)}
        aria-expanded={isOpen("drawer")}
        className={cn(TAB_CLASS, isOpen("drawer") ? "text-primary" : "text-text-muted hover:text-text")}
      >
        <MenuIcon aria-hidden="true" className="size-5" />
        More
      </button>
    </nav>
  );
}
