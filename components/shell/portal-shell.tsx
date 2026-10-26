"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PORTAL_NAV, navMatchScore } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { FirmMark, PoweredBy } from "./brand";
import { UserMenu } from "./user-menu";

/**
 * The client portal's shell (§7.22): the firm's mark and name, the client's name, a top navigation
 * bar, mobile-first. Lighter than the staff shell: no sidebar, no search, no FY switcher.
 * On the first-sign-in welcome page the navigation is hidden until the privacy notice is acknowledged.
 */

export interface PortalShellProps {
  firm: { name: string; logoUrl: string | null };
  user: { fullName: string; email: string };
  /** The client's display name, or null when the login isn't linked to a client file. */
  clientName: string | null;
  children: React.ReactNode;
}

export function PortalShell({ firm, user, clientName, children }: PortalShellProps) {
  const pathname = usePathname() ?? "/portal";
  const welcome = pathname === "/portal/welcome" || pathname.startsWith("/portal/welcome/");

  // The longest match wins, so /portal/documents is "Documents", not "Home".
  let activeHref: string | null = null;
  let best = -1;
  for (const item of PORTAL_NAV) {
    const score = navMatchScore(pathname, item);
    if (score > best) {
      best = score;
      activeHref = item.href;
    }
  }

  // Phones: the active tab can sit past the right edge of the scrolling bar (Documents, Invoices,
  // Messages, Help at 390px). Bring it into view on every navigation so the client sees where they are.
  const navRef = React.useRef<HTMLUListElement>(null);
  React.useEffect(() => {
    const list = navRef.current;
    const active = list?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!list || !active || list.scrollWidth <= list.clientWidth) return;
    const left = active.offsetLeft - (list.clientWidth - active.offsetWidth) / 2;
    list.scrollTo({ left: Math.max(0, left), behavior: "instant" });
  }, [activeHref]);

  const brand = (
    <>
      <FirmMark logoUrl={firm.logoUrl} firmName={firm.name} className="size-8" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-serif text-[17px] leading-6 font-medium tracking-[-0.01em] text-text">{firm.name}</span>
        {/* Phones: the client's name under the firm's, instead of a row of its own in the sticky header. */}
        {clientName ? (
          <span aria-hidden="true" className="truncate text-xs text-text-muted sm:hidden">
            {clientName}
          </span>
        ) : null}
      </span>
    </>
  );

  return (
    // The navy binder (DESIGN.md §2): the firm's band on the navy frame, the client's pages on a paper sheet.
    <div className="flex min-h-dvh flex-col bg-frame">
      <a
        href="#main"
        className="sr-only rounded-md bg-surface px-3 py-2 text-sm font-medium text-primary shadow-2 focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:outline-2 focus:outline-ring"
      >
        Skip to main content
      </a>
      <header className="on-frame sticky top-0 z-30 bg-frame">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-3 px-4 md:px-6">
          {welcome ? (
            // Until the privacy notice is acknowledged there is nowhere else to go: a link home here would
            // be a client-side navigation, which skips the layout's welcome check.
            <div className="flex min-w-0 items-center gap-2.5">{brand}</div>
          ) : (
            <Link
              href="/portal"
              aria-label={`${firm.name}: home`}
              className="flex min-w-0 items-center gap-2.5 rounded-md outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {brand}
            </Link>
          )}
          <div className="ml-auto flex min-w-0 items-center gap-2">
            {clientName ? (
              <p className="sr-only min-w-0 truncate text-right text-sm text-text-muted sm:not-sr-only">
                <span className="sr-only">Signed in for </span>
                <span className="font-medium text-text">{clientName}</span>
              </p>
            ) : null}
            <UserMenu name={user.fullName} email={user.email} role="client" variant="portal" />
          </div>
        </div>
        {welcome ? null : (
          <nav aria-label="Portal" className="mx-auto w-full max-w-5xl">
            <ul ref={navRef} className="flex gap-1 overflow-x-auto overscroll-x-contain px-2 [scrollbar-width:none] md:px-4 [&::-webkit-scrollbar]:hidden">
              {PORTAL_NAV.map((item) => {
                const active = item.href === activeHref;
                const Icon = item.icon;
                return (
                  <li key={item.href} className="flex-none">
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "relative flex h-11 items-center gap-2 rounded-t-md px-3 text-base outline-none transition-colors duration-150 ease-out focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                        active
                          ? "font-medium text-text after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-gold"
                          : "text-text-muted hover:text-text",
                      )}
                    >
                      <Icon aria-hidden="true" className="size-4 flex-none" />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}
      </header>

      <div className="flex flex-1 flex-col bg-bg md:mx-2.5 md:mb-2.5 md:rounded-2xl">
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 outline-none md:px-6 md:py-10">
          {children}
        </main>

        <footer className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 border-t border-border px-4 py-4 md:px-6">
          <p className="text-xs text-text-muted">{firm.name}</p>
          <PoweredBy />
        </footer>
      </div>
    </div>
  );
}
