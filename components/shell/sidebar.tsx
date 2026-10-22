"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { HistoryIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, StarIcon, XIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { navItemByHref, navMatchScore, type NavItem } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { FirmMark, PoweredBy } from "./brand";
import { FySwitcher } from "./fy-switcher";
import { NewSplitButton } from "./new-menu";
import { useShell } from "./shell-context";
import { UserMenu } from "./user-menu";

/**
 * The staff sidebar (§3.3, DESIGN.md §3): the navy brand band with the firm's mark and name, "+ New",
 * Favourites and Recent, the role's grouped navigation (§4.2), then the user card and "Powered by
 * J-TACS". 260px wide, or a 64px icon rail; inside the phone drawer it is always full width.
 */

export interface SidebarProps {
  /** The 64px icon rail (desktop only). */
  rail?: boolean;
  /** Rendered inside the phone drawer: touch-sized rows, a close button, the FY switcher. */
  inDrawer?: boolean;
  /** Called when a link is followed (closes the drawer). */
  onNavigate?: () => void;
  onClose?: () => void;
}

function formatCount(n: number): string {
  return n > 99 ? "99+" : String(n);
}

export function Sidebar({ rail = false, inDrawer = false, onNavigate, onClose }: SidebarProps) {
  const shell = useShell();
  const { user, firm, nav, favourites, recent, unreadCount, collapsed, setCollapsed, setOpen } = shell;
  const pathname = usePathname() ?? "/";

  // The one active item: the longest match across the whole sidebar (so /clients/groups is not "Clients").
  const activeHref = React.useMemo(() => {
    let best: string | null = null;
    let score = -1;
    for (const g of nav) {
      for (const i of g.items) {
        const s = navMatchScore(pathname, i);
        if (s > score) {
          score = s;
          best = i.href;
        }
      }
    }
    return best;
  }, [nav, pathname]);

  const favouriteItems = favourites.map((href) => navItemByHref(user.role, href)).filter((i): i is NavItem => i !== null);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      {/* Brand band: the one navy moment in the app shell. */}
      <div className={cn("flex h-14 flex-none items-center gap-2.5 bg-brand-navy text-white", rail ? "justify-center px-0" : "px-4")}>
        <Link
          href="/"
          onClick={onNavigate}
          aria-label={`${firm.name}: home`}
          className="flex min-w-0 items-center gap-2.5 rounded-md outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
        >
          <FirmMark logoUrl={firm.logoUrl} firmName={firm.name} />
          {rail ? null : <span className="truncate text-base font-semibold tracking-[-0.01em]">{firm.name}</span>}
        </Link>
        {inDrawer && onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="ml-auto inline-flex size-11 flex-none cursor-pointer items-center justify-center rounded-md text-white/80 outline-none hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-gold"
          >
            <XIcon aria-hidden="true" className="size-4" />
          </button>
        ) : null}
      </div>

      <div className={cn("flex-none pt-3 pb-1", rail ? "px-2" : "px-3")}>
        <NewSplitButton rail={rail} onNavigate={onNavigate} />
      </div>

      <nav aria-label="Main" className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain pb-3", rail ? "px-2" : "px-3")}>
        {!rail && favouriteItems.length > 0 ? (
          <NavSection id="favourites" label="Favourites">
            {favouriteItems.map((item) => (
              <NavRow
                key={`fav-${item.href}`}
                item={item}
                active={item.href === activeHref}
                inDrawer={inDrawer}
                starred
                count={item.badge === "inbox" ? unreadCount : null}
                onNavigate={onNavigate}
              />
            ))}
          </NavSection>
        ) : null}

        {!rail && recent.length > 0 ? (
          <NavSection id="recent" label="Recent">
            {recent.map((place) => {
              const known = navItemByHref(user.role, place.href);
              const Icon = known?.icon ?? HistoryIcon;
              return (
                <li key={`recent-${place.href}`}>
                  <Link
                    href={place.href}
                    onClick={onNavigate}
                    className={cn(
                      "flex h-8 items-center gap-2.5 rounded-md px-2 text-base text-text outline-none transition-colors duration-150 ease-out hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                      inDrawer && "h-11",
                    )}
                  >
                    <Icon aria-hidden="true" className="size-4 flex-none text-text-muted" />
                    <span className="min-w-0 flex-1 truncate">{place.title}</span>
                  </Link>
                </li>
              );
            })}
          </NavSection>
        ) : null}

        {nav.map((group, gi) =>
          rail ? (
            <React.Fragment key={group.id}>
              {gi > 0 ? <div aria-hidden="true" className="mx-auto my-2 h-px w-8 bg-border" /> : null}
              <ul aria-label={group.label ?? undefined} className="flex flex-col gap-0.5 pt-1">
                {group.items.map((item) => (
                  <NavRow
                    key={item.href}
                    item={item}
                    rail
                    active={item.href === activeHref}
                    count={item.badge === "inbox" ? unreadCount : null}
                    onNavigate={onNavigate}
                  />
                ))}
              </ul>
            </React.Fragment>
          ) : (
            <NavSection key={group.id} id={`group-${group.id}`} label={group.label} divider={gi > 0}>
              {group.items.map((item) => (
                <NavRow
                  key={item.href}
                  item={item}
                  active={item.href === activeHref}
                  inDrawer={inDrawer}
                  starred={favourites.includes(item.href)}
                  showStar
                  count={item.badge === "inbox" ? unreadCount : null}
                  onNavigate={onNavigate}
                />
              ))}
            </NavSection>
          ),
        )}
      </nav>

      <div className={cn("flex flex-none flex-col gap-1 border-t border-border py-2", rail ? "px-2" : "px-3")}>
        {inDrawer ? (
          <div className="flex items-center justify-between gap-2 px-2 pb-1">
            <span className="text-sm text-text-muted">Financial year</span>
            <FySwitcher />
          </div>
        ) : (
          <RailToggle rail={rail} collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
        )}
        <UserMenu
          name={user.fullName}
          email={user.email}
          role={user.role}
          rail={rail}
          initialDensity={shell.density}
          onShortcuts={() => setOpen("shortcuts", true)}
          onNavigate={onNavigate}
        />
        {rail ? (
          <p className="pt-1 text-center text-xs font-semibold tracking-[0.02em] text-gold-text" aria-label="Powered by J-TACS">
            J-TACS
          </p>
        ) : (
          <PoweredBy className="px-2 pt-1" />
        )}
      </div>
    </div>
  );
}

function NavSection({
  id,
  label,
  divider = false,
  children,
}: {
  id: string;
  label: string | null;
  divider?: boolean;
  children: React.ReactNode;
}) {
  const labelId = `nav-${id}`;
  return (
    <div className={cn(label ? "pt-4" : divider ? "mt-3 border-t border-border pt-3" : "pt-1")}>
      {label ? (
        <p id={labelId} className="px-2 pb-1 text-xs font-medium text-text-muted">
          {label}
        </p>
      ) : null}
      <ul aria-labelledby={label ? labelId : undefined} className="flex flex-col gap-0.5">
        {children}
      </ul>
    </div>
  );
}

function NavRow({
  item,
  active,
  rail = false,
  inDrawer = false,
  starred = false,
  showStar = false,
  count,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  rail?: boolean;
  inDrawer?: boolean;
  starred?: boolean;
  /** Offer the star toggle (the main list); Favourites rows always offer "remove". */
  showStar?: boolean;
  count: number | null;
  onNavigate?: () => void;
}) {
  const { toggleFavourite } = useShell();
  const Icon = item.icon;
  const hasCount = count !== null && count > 0;
  const accessibleName = hasCount ? `${item.label}, ${count} unread` : item.label;

  const link = (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      aria-label={rail || hasCount ? accessibleName : undefined}
      className={cn(
        "relative flex items-center rounded-md outline-none transition-colors duration-150 ease-out focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
        rail
          ? "mx-auto size-10 justify-center"
          : cn("h-8 gap-2.5 px-2 text-base", inDrawer && "h-11", (showStar || starred) && "pr-8 pointer-coarse:pr-12"),
        active ? "bg-primary-soft font-medium text-primary" : "text-text hover:bg-surface-2",
      )}
    >
      <Icon aria-hidden="true" className={cn("size-4 flex-none", active ? "text-primary" : "text-text-muted")} />
      {rail ? (
        hasCount ? <span aria-hidden="true" className="absolute top-1.5 right-1.5 size-2 rounded-full bg-primary" /> : null
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          {hasCount ? (
            <span aria-hidden="true" className="num flex-none rounded-full bg-primary-soft px-1.5 text-xs leading-5 font-medium text-primary">
              {formatCount(count)}
            </span>
          ) : null}
        </>
      )}
    </Link>
  );

  if (rail) {
    return (
      <li>
        <Tooltip>
          <TooltipTrigger asChild>{link}</TooltipTrigger>
          <TooltipContent side="right">{hasCount ? `${item.label} · ${formatCount(count)} unread` : item.label}</TooltipContent>
        </Tooltip>
      </li>
    );
  }

  return (
    <li className="group/row relative">
      {link}
      {showStar || starred ? (
        <button
          type="button"
          onClick={() => toggleFavourite(item.href)}
          aria-pressed={starred}
          aria-label={starred ? `Remove ${item.label} from favourites` : `Add ${item.label} to favourites`}
          className={cn(
            "absolute top-1/2 right-1 inline-flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-sm text-text-muted outline-none transition-opacity duration-150 ease-out hover:bg-surface-2 hover:text-text focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring",
            // Touch screens: always visible, and a full 44px target (DESIGN.md §6).
            "opacity-0 group-hover/row:opacity-100 pointer-coarse:right-0 pointer-coarse:size-11 pointer-coarse:opacity-100",
          )}
        >
          <StarIcon aria-hidden="true" className={cn("size-3.5", starred && "fill-current text-gold-text")} />
        </button>
      ) : null}
    </li>
  );
}

function RailToggle({ rail, collapsed, onToggle }: { rail: boolean; collapsed: boolean; onToggle: () => void }) {
  const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
  const button = (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      aria-controls="tw-sidebar"
      aria-expanded={!collapsed}
      className={cn(
        "flex cursor-pointer items-center gap-2.5 rounded-md text-sm text-text-muted outline-none transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
        rail ? "mx-auto size-10 justify-center" : "h-8 px-2",
      )}
    >
      {collapsed ? <PanelLeftOpenIcon aria-hidden="true" className="size-4" /> : <PanelLeftCloseIcon aria-hidden="true" className="size-4" />}
      {rail ? null : "Collapse"}
    </button>
  );
  if (!rail) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}
