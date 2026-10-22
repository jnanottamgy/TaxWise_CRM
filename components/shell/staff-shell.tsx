"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { TriangleAlertIcon } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { SHORTCUT_GROUPS, ShortcutSheet } from "@/components/app/shortcut-sheet";
import { CopyButton } from "@/components/app/copy-button";
import { can } from "@/lib/auth/roles";
import { getGoToItems, getNav, getNewActions } from "@/lib/nav";
import {
  DENSITY_COOKIE,
  SIDEBAR_COOKIE,
  readCookie,
  toggleFavourite as toggleFavouriteList,
  writeDisplayCookie,
  type DensityPreference,
  type ShellPreferences,
} from "@/lib/preferences";
import { refreshUnreadCount, saveSidebarCollapsed, setFavourite, setFinancialYear } from "@/server/actions/preferences";
import { cn } from "@/lib/utils";
import { CommandPalette } from "./command-palette";
import { HelpSheet } from "./help-sheet";
import { MobileTabBar } from "./mobile-tab-bar";
import { ShellContext, createSlotStore, type ShellContextValue, type ShellPanel, type ShellUser } from "./shell-context";
import { Sidebar } from "./sidebar";
import { TimerSheet } from "./timer-sheet";
import { TopBar } from "./top-bar";
import { applyDensity } from "./user-menu";
import { useRecentPlaces } from "./use-recent";
import { useShellShortcuts } from "./use-shortcuts";

/**
 * The staff app shell (§3.3, DESIGN.md §3): sidebar (260px, or a 64px rail), top bar, the page,
 * and the panels the shell owns. Rendered by app/(staff)/layout.tsx with data it loaded and
 * already degraded on failure (§0.1 rule 3).
 */

export interface StaffShellProps {
  user: ShellUser;
  firm: { name: string; logoUrl: string | null };
  preferences: ShellPreferences;
  /** From the sidebar cookie, else the profile; decided on the server so the first paint is right. */
  initialCollapsed: boolean;
  density: DensityPreference;
  unreadCount: number | null;
  fy: { selected: string; current: string; options: string[] };
  /** A quiet note when part of the shell's data didn't load. */
  warning: { message: string; ref: string } | null;
  /** The running-timer panel, supplied by the timesheet module. */
  timerPanel?: React.ReactNode;
  children: React.ReactNode;
}

/** The Inbox count refreshes at most this often (on focus and navigation, never on a timer). */
const UNREAD_REFRESH_MS = 60_000;

export function StaffShell({
  user,
  firm,
  preferences,
  initialCollapsed,
  density,
  unreadCount: initialUnread,
  fy: initialFy,
  warning,
  timerPanel,
  children,
}: StaffShellProps) {
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const { setTheme } = useTheme();
  const role = user.role;

  const nav = React.useMemo(() => getNav(role), [role]);
  const goTo = React.useMemo(() => getGoToItems(role), [role]);
  const newActions = React.useMemo(() => getNewActions(role), [role]);
  const navHrefs = React.useMemo(() => new Set(nav.flatMap((g) => g.items.map((i) => i.href))), [nav]);

  const [slots] = React.useState(createSlotStore);
  const [panel, setPanel] = React.useState<ShellPanel | null>(null);
  const [collapsed, setCollapsedState] = React.useState(initialCollapsed);
  const [favourites, setFavourites] = React.useState(() => preferences.favourites.filter((f) => navHrefs.has(f)));
  const [unreadCount, setUnreadCount] = React.useState(initialUnread);
  const [selectedFy, setSelectedFy] = React.useState(initialFy.selected);
  const [fyPending, startFyTransition] = React.useTransition();

  // ---- Panels -----------------------------------------------------------------------------------
  const isOpen = React.useCallback((p: ShellPanel) => panel === p, [panel]);
  const setOpen = React.useCallback((p: ShellPanel, open: boolean) => {
    setPanel((current) => (open ? p : current === p ? null : current));
  }, []);

  // ---- Sidebar ----------------------------------------------------------------------------------
  const setCollapsed = React.useCallback((next: boolean) => {
    setCollapsedState(next);
    writeDisplayCookie(SIDEBAR_COOKIE, next ? "collapsed" : "expanded");
    void saveSidebarCollapsed({ collapsed: next }).catch(() => undefined);
  }, []);

  const toggleFavourite = React.useCallback(
    (href: string) => {
      const on = !favourites.includes(href);
      setFavourites((current) => toggleFavouriteList(current, href, on));
      void setFavourite({ href, on })
        .then((result) => {
          if (result.ok) setFavourites(result.data.favourites.filter((f) => navHrefs.has(f)));
          else toast.warning(result.error);
        })
        .catch(() => toast.warning("Favourites couldn't be saved to your profile. Check your connection."));
    },
    [favourites, navHrefs],
  );

  // ---- Inbox count (§7.17) ----------------------------------------------------------------------
  const lastRefresh = React.useRef(0);
  React.useEffect(() => {
    // The layout has just loaded the count: the first refresh is due a minute from now.
    lastRefresh.current = Date.now();
  }, []);
  const refreshUnread = React.useCallback(() => {
    lastRefresh.current = Date.now();
    void refreshUnreadCount({})
      .then((result) => {
        if (result.ok) setUnreadCount(result.data.count);
      })
      .catch(() => undefined);
  }, []);

  React.useEffect(() => {
    const maybeRefresh = () => {
      if (document.visibilityState === "visible" && Date.now() - lastRefresh.current > UNREAD_REFRESH_MS) refreshUnread();
    };
    // The Inbox page (and anything that marks notifications read) can ask for an immediate update.
    const onChanged = () => refreshUnread();
    window.addEventListener("focus", maybeRefresh);
    document.addEventListener("visibilitychange", maybeRefresh);
    window.addEventListener("tw:inbox-changed", onChanged);
    return () => {
      window.removeEventListener("focus", maybeRefresh);
      document.removeEventListener("visibilitychange", maybeRefresh);
      window.removeEventListener("tw:inbox-changed", onChanged);
    };
  }, [refreshUnread]);

  React.useEffect(() => {
    if (Date.now() - lastRefresh.current > UNREAD_REFRESH_MS) refreshUnread();
  }, [pathname, refreshUnread]);

  // ---- Theme and density from the profile on a new device ---------------------------------------
  React.useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem("theme");
    } catch {
      stored = null;
    }
    if (!stored && preferences.theme) setTheme(preferences.theme);
    if (readCookie(DENSITY_COOKIE) === null && preferences.density === "compact") applyDensity("compact", false);
  }, [preferences.theme, preferences.density, setTheme]);

  // ---- FY switcher -----------------------------------------------------------------------------
  const chooseFy = React.useCallback(
    (value: string) => {
      if (value === selectedFy) return;
      const previous = selectedFy;
      setSelectedFy(value);
      startFyTransition(async () => {
        try {
          const result = await setFinancialYear({ fy: value });
          if (!result.ok) {
            setSelectedFy(previous);
            toast.error(result.error);
          }
        } catch {
          setSelectedFy(previous);
          toast.error("We couldn't reach TaxWise to change the year. Check your connection and try again.");
        }
      });
    },
    [selectedFy],
  );

  // ---- Recent places ----------------------------------------------------------------------------
  const labelFor = React.useCallback(
    (path: string) => goTo.find((i) => i.href.split("?")[0] === path)?.label ?? null,
    [goTo],
  );
  const recent = useRecentPlaces(user.id, labelFor);

  // ---- Keyboard (§3.4) --------------------------------------------------------------------------
  useShellShortcuts({
    onPalette: () => setPanel((p) => (p === "palette" ? null : "palette")),
    onNew: () => {
      if (newActions.length === 0) return;
      const wide = window.matchMedia("(min-width: 768px)").matches;
      if (!wide) setPanel("palette");
      else if (newActions.length === 1) router.push(newActions[0].href);
      else setPanel("new");
    },
    onShortcutSheet: () => setPanel("shortcuts"),
    onGo: (key) => {
      if (key === "c") router.push("/clients");
      else if (key === "t") router.push("/work");
      else if (key === "i" && can.seeMoney(role)) router.push("/invoices");
    },
  });

  const shortcutGroups = React.useMemo(
    () =>
      SHORTCUT_GROUPS.map((g) => ({
        ...g,
        items: g.items
          .filter((s) => !(s.keys[0] === "G" && s.keys[1] === "I" && !can.seeMoney(role)))
          // §4.1: Employees never see invoices, so the search line doesn't promise them.
          .map((s) =>
            s.keys[0] === "mod" && s.keys[1] === "K" && !can.seeMoney(role) ? { ...s, label: "Search clients, tasks and commands" } : s,
          ),
      })),
    [role],
  );

  const value = React.useMemo<ShellContextValue>(
    () => ({
      user,
      firm,
      nav,
      goTo,
      newActions,
      isOpen,
      setOpen,
      favourites,
      toggleFavourite,
      unreadCount,
      refreshUnread,
      collapsed,
      setCollapsed,
      recent,
      density,
      fy: { ...initialFy, selected: selectedFy, pending: fyPending, choose: chooseFy },
      slots,
    }),
    [
      user,
      firm,
      nav,
      goTo,
      newActions,
      isOpen,
      setOpen,
      favourites,
      toggleFavourite,
      unreadCount,
      refreshUnread,
      collapsed,
      setCollapsed,
      recent,
      density,
      initialFy,
      selectedFy,
      fyPending,
      chooseFy,
      slots,
    ],
  );

  const employee = role === "employee";

  return (
    <ShellContext.Provider value={value}>
      <a
        href="#main"
        className="sr-only rounded-md bg-surface px-3 py-2 text-sm font-medium text-primary shadow-2 focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:outline-2 focus:outline-ring"
      >
        Skip to main content
      </a>
      <div className="flex min-h-dvh bg-bg">
        <aside
          id="tw-sidebar"
          aria-label="Sidebar"
          className={cn(
            "sticky top-0 hidden h-dvh flex-none overflow-hidden border-r border-border bg-surface transition-[width] duration-200 ease-out md:block",
            collapsed ? "w-16" : "w-[260px]",
          )}
        >
          <Sidebar rail={collapsed} />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          {warning ? <ShellWarning message={warning.message} errorRef={warning.ref} /> : null}
          <main id="main" tabIndex={-1} className={cn("min-w-0 flex-1 px-4 py-4 outline-none md:px-6 md:py-6", employee && "pb-24 md:pb-6")}>
            {children}
          </main>
        </div>
      </div>

      {employee ? <MobileTabBar /> : null}

      <Sheet open={panel === "drawer"} onOpenChange={(o) => setOpen("drawer", o)}>
        <SheetContent side="left" showCloseButton={false} className="w-[min(86vw,18rem)] gap-0 p-0 md:hidden">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">Pages, favourites and your account.</SheetDescription>
          <Sidebar inDrawer onNavigate={() => setOpen("drawer", false)} onClose={() => setOpen("drawer", false)} />
        </SheetContent>
      </Sheet>

      <CommandPalette />
      <HelpSheet />
      <TimerSheet panel={timerPanel} />
      <ShortcutSheet open={panel === "shortcuts"} onOpenChange={(o) => setOpen("shortcuts", o)} groups={shortcutGroups} />
    </ShellContext.Provider>
  );
}

/** Part of the shell's data didn't load: say so quietly, with the Ref, and keep working (§0.1 rule 3). */
function ShellWarning({ message, errorRef }: { message: string; errorRef: string }) {
  return (
    <div className="flex items-center gap-2 border-b border-border bg-surface px-4 py-1.5 text-sm text-text-muted md:px-6">
      <TriangleAlertIcon aria-hidden="true" className="size-3.5 flex-none text-warning-text" />
      <p className="min-w-0 flex-1">
        {message} <span className="whitespace-nowrap">Ref <span className="font-mono text-text">{errorRef}</span></span>
      </p>
      <CopyButton value={errorRef} label="Ref" />
    </div>
  );
}
