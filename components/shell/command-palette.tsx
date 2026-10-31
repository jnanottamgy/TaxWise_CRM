"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { Command as CommandPrimitive } from "cmdk";
import {
  ArrowRightIcon,
  Building2Icon,
  CircleAlertIcon,
  CircleHelpIcon,
  ContactRoundIcon,
  FileTextIcon,
  FolderOpenIcon,
  HistoryIcon,
  KeyboardIcon,
  ListChecksIcon,
  Loader2Icon,
  MessageCircleIcon,
  MoonIcon,
  ReceiptTextIcon,
  RotateCwIcon,
  SearchIcon,
  SunIcon,
  TargetIcon,
  TimerIcon,
  UserRoundIcon,
  type LucideIcon,
} from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Command, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { Skeleton } from "@/components/ui/skeleton";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { saveTheme } from "@/server/actions/preferences";
import { useShell } from "./shell-context";
import { useRecentSearches } from "./use-recent";
import {
  MIN_SEARCH_LENGTH,
  parseSearchResponse,
  searchPageHref,
  whatsAppCommandLabel,
  type SearchResultGroup,
} from "./search-contract";

/**
 * The command palette (§7.18), opened with ⌘K / Ctrl K or the top bar's search box. One box:
 * - empty: recent searches, create commands, actions and every "Go to" destination for the role;
 * - typing: matching commands, then server results grouped by type (top 5 each) with
 *   "See all N results", which opens /search?q=.
 */
export function CommandPalette() {
  const { isOpen, setOpen } = useShell();
  const open = isOpen("palette");
  return (
    <Dialog open={open} onOpenChange={(o) => setOpen("palette", o)}>
      <DialogContent
        showCloseButton={false}
        className="top-3 flex max-h-[min(86dvh,36rem)] translate-y-0 flex-col gap-0 overflow-hidden p-0 sm:top-[10dvh] sm:max-w-[640px]"
      >
        <DialogTitle className="sr-only">Search and commands</DialogTitle>
        <DialogDescription className="sr-only">
          Search clients, tasks and people, or type a command. Use the arrow keys to move and Enter to open.
        </DialogDescription>
        {open ? <PaletteBody onDone={() => setOpen("palette", false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

// -------------------------------------------------------------------------------------------------
// Commands
// -------------------------------------------------------------------------------------------------

interface PaletteCommand {
  id: string;
  group: "Create" | "Actions" | "Go to";
  label: string;
  icon: LucideIcon;
  hint?: string;
  keywords: readonly string[];
  run: () => void;
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9&()/.\- ]+/g, " ").replace(/\s+/g, " ").trim();
}

const COMMAND_PREFIX = /^(go to|goto|open|show|jump to)\s+/;

/** 0 = no match; higher is better. Every word of the query must start a word of the label or keywords. */
export function commandScore(query: string, label: string, keywords: readonly string[]): number {
  const q = normalise(query).replace(COMMAND_PREFIX, "");
  if (!q) return 1;
  const l = normalise(label);
  if (l.startsWith(q)) return 4;
  const words = [l, ...keywords.map(normalise)].join(" ").split(" ");
  const tokens = q.split(" ");
  const all = tokens.every((t) => words.some((w) => w.startsWith(t)));
  if (all) return l.split(" ").some((w) => w.startsWith(tokens[0])) ? 3 : 2;
  return l.includes(q) ? 1 : 0;
}

/** How many client results get an "Open … WhatsApp" command. */
const WHATSAPP_COMMANDS = 3;

const TYPE_ICON: Record<string, LucideIcon> = {
  client: Building2Icon,
  contact: ContactRoundIcon,
  task: ListChecksIcon,
  lead: TargetIcon,
  document: FolderOpenIcon,
  employee: UserRoundIcon,
  invoice: ReceiptTextIcon,
  quotation: FileTextIcon,
};

type SearchState =
  | { status: "idle" }
  | { status: "ok"; query: string; groups: SearchResultGroup[] }
  | { status: "error"; query: string; error: string; ref?: string };

const ITEM_CLASS =
  "min-h-10 gap-3 rounded-md px-3 text-base text-text data-[selected=true]:bg-primary-soft data-[selected=true]:text-text pointer-coarse:min-h-11 [&_svg:not([class*='size-'])]:size-4";

function PaletteBody({ onDone }: { onDone: () => void }) {
  const shell = useShell();
  const { user, goTo, newActions, nav, setOpen } = shell;
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const { searches, remember, forget, clear } = useRecentSearches(user.id);
  const [selected, setSelected] = React.useState("");

  const [query, setQuery] = React.useState("");
  const [state, setState] = React.useState<SearchState>({ status: "idle" });
  const [attempt, setAttempt] = React.useState(0);
  const trimmed = query.trim();
  const searching = trimmed.length >= MIN_SEARCH_LENGTH;

  React.useEffect(() => {
    if (trimmed.length < MIN_SEARCH_LENGTH) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`, {
          signal: controller.signal,
          headers: { accept: "application/json" },
          cache: "no-store",
        });
        let body: unknown = null;
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        const parsed = parseSearchResponse(body);
        if (controller.signal.aborted) return;
        setState(
          parsed.ok
            ? { status: "ok", query: trimmed, groups: parsed.data.groups }
            : { status: "error", query: trimmed, error: parsed.error, ref: parsed.ref },
        );
      } catch {
        if (controller.signal.aborted) return;
        setState({ status: "error", query: trimmed, error: "Search didn't respond. Check your connection and try again." });
      }
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed, attempt]);

  const go = React.useCallback(
    (href: string) => {
      onDone();
      router.push(href);
    },
    [onDone, router],
  );

  const groupOf = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const g of nav) for (const i of g.items) if (g.label) m.set(i.href, g.label);
    return m;
  }, [nav]);

  const commands = React.useMemo<PaletteCommand[]>(() => {
    const out: PaletteCommand[] = [];
    for (const a of newActions) {
      out.push({ id: `new-${a.id}`, group: "Create", label: a.label, icon: a.icon, keywords: ["new", "create", "add", ...(a.keywords ?? [])], run: () => go(a.href) });
    }
    out.push({
      id: "start-timer",
      group: "Actions",
      label: "Start timer",
      icon: TimerIcon,
      keywords: ["timer", "time", "clock"],
      run: () => setOpen("timer", true),
    });
    out.push({
      id: "theme",
      group: "Actions",
      label: resolvedTheme === "dark" ? "Switch to light theme" : "Switch to dark theme",
      icon: resolvedTheme === "dark" ? SunIcon : MoonIcon,
      keywords: ["theme", "dark", "light", "mode"],
      run: () => {
        const next = resolvedTheme === "dark" ? "light" : "dark";
        setTheme(next);
        // Kept with the profile like the user menu's choice, so a new device opens in the same theme.
        void saveTheme({ theme: next }).catch(() => undefined);
        onDone();
      },
    });
    out.push({ id: "shortcuts", group: "Actions", label: "Keyboard shortcuts", icon: KeyboardIcon, keywords: ["keys", "hotkeys"], run: () => setOpen("shortcuts", true) });
    out.push({ id: "help", group: "Actions", label: "Help for this page", icon: CircleHelpIcon, keywords: ["guide", "how"], run: () => setOpen("help", true) });
    for (const item of goTo) {
      out.push({
        id: `go-${item.id}`,
        group: "Go to",
        label: item.label,
        hint: groupOf.get(item.href),
        icon: item.icon,
        keywords: ["go", ...(item.keywords ?? [])],
        run: () => go(item.href),
      });
    }
    return out;
  }, [newActions, goTo, groupOf, go, resolvedTheme, setTheme, setOpen, onDone]);

  const visible = React.useMemo(() => {
    if (!trimmed) return commands;
    const limits: Record<PaletteCommand["group"], number> = { Create: 6, Actions: 3, "Go to": 6 };
    const scored = commands
      .map((c) => ({ c, s: commandScore(trimmed, c.label, c.keywords) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    const counts: Record<string, number> = {};
    return scored
      .filter(({ c }) => {
        counts[c.group] = (counts[c.group] ?? 0) + 1;
        return counts[c.group] <= limits[c.group];
      })
      .map(({ c }) => c);
  }, [commands, trimmed]);

  const byGroup = (g: PaletteCommand["group"]) => visible.filter((c) => c.group === g);
  const results = searching && state.status === "ok" ? state.groups.filter((g) => g.items.length > 0) : [];
  const resultsCurrent = state.status !== "idle" && state.query === trimmed;
  const pending = searching && !resultsCurrent;
  const error = searching && state.status === "error" && resultsCurrent ? state : null;
  const totalResults = results.reduce((n, g) => n + g.total, 0);
  const nothing = searching && resultsCurrent && state.status === "ok" && results.length === 0 && visible.length === 0;

  const openResult = (href: string) => {
    remember(trimmed);
    go(href);
  };

  // §7.25.5 Open chat from ⌘K: lands on the client's WhatsApp group tab, whose Open chat button
  // makes the access check and opens WhatsApp Web (or the phone app) with the group's name copied.
  const openWhatsApp = (clientId: string) => {
    remember(trimmed);
    go(`/clients/${clientId}?tab=whatsapp`);
  };
  const whatsAppClients = user.role === "client" ? [] : (results.find((g) => g.type === "client")?.items ?? []).slice(0, WHATSAPP_COMMANDS);

  // Results first when searching (people search for records more than for commands).
  const resultGroups = results.map((g) => {
    const Icon = TYPE_ICON[g.type] ?? SearchIcon;
    return (
      <CommandGroup key={`r-${g.type}`} heading={g.label}>
        {g.items.slice(0, 5).map((item) => (
          <CommandItem key={`${g.type}-${item.id}`} value={`result:${g.type}:${item.id}`} className={ITEM_CLASS} onSelect={() => openResult(item.href)}>
            <Icon aria-hidden="true" className="text-text-muted" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{item.title}</span>
              {item.subtitle ? <span className="truncate text-xs text-text-muted">{item.subtitle}</span> : null}
            </span>
          </CommandItem>
        ))}
        {g.total > Math.min(5, g.items.length) ? (
          <CommandItem value={`seeall:${g.type}`} className={cn(ITEM_CLASS, "text-primary")} onSelect={() => openResult(searchPageHref(trimmed, g.type))}>
            <ArrowRightIcon aria-hidden="true" className="text-primary" />
            <span className="num">
              See all {g.total} {g.label.toLowerCase()}
            </span>
          </CommandItem>
        ) : null}
      </CommandGroup>
    );
  });

  const commandGroup = (g: PaletteCommand["group"], heading?: string) => {
    const items = byGroup(g);
    if (items.length === 0) return null;
    return (
      <CommandGroup heading={heading ?? g}>
        {items.map((c) => {
          const Icon = c.icon;
          return (
            <CommandItem key={c.id} value={`cmd:${c.id}`} className={ITEM_CLASS} onSelect={c.run}>
              <Icon aria-hidden="true" className="text-text-muted" />
              <span className="min-w-0 flex-1 truncate">{c.label}</span>
              {c.hint ? <span className="flex-none text-xs text-text-muted">{c.hint}</span> : null}
            </CommandItem>
          );
        })}
      </CommandGroup>
    );
  };

  return (
    <Command
      shouldFilter={false}
      loop
      value={selected}
      onValueChange={setSelected}
      onKeyDown={(e) => {
        // Delete (or Shift + Backspace) forgets the highlighted recent search.
        if (trimmed || !selected.startsWith("recent:item:")) return;
        if (e.key === "Delete" || (e.key === "Backspace" && e.shiftKey)) {
          e.preventDefault();
          forget(selected.slice("recent:item:".length));
        }
      }}
      className="flex min-h-0 flex-1 flex-col rounded-none bg-surface"
    >
      <div className="flex h-12 flex-none items-center gap-2 border-b border-border px-4">
        {pending ? (
          <Loader2Icon aria-hidden="true" className="size-4 flex-none animate-spin text-text-muted" />
        ) : (
          <SearchIcon aria-hidden="true" className="size-4 flex-none text-text-muted" />
        )}
        <CommandPrimitive.Input
          value={query}
          onValueChange={setQuery}
          autoFocus
          maxLength={200}
          placeholder={
            user.role === "employee"
              ? "Search your clients, tasks and documents, or type a command"
              : "Search clients, tasks, invoices and people, or type a command"
          }
          aria-label="Search or type a command"
          className="h-full min-w-0 flex-1 bg-transparent text-base text-text outline-none placeholder:text-text-muted"
        />
        <Kbd className="hidden sm:inline-flex">Esc</Kbd>
      </div>

      <CommandList className="max-h-none min-h-0 flex-1 overflow-y-auto overscroll-contain p-2" aria-busy={pending || undefined}>
        {!trimmed && searches.length > 0 ? (
          <CommandGroup heading="Recent searches">
            {searches.map((s) => (
              <CommandItem
                key={`recent-${s.id}`}
                value={`recent:item:${s.id}`}
                className={cn(ITEM_CLASS, "group")}
                onSelect={() => setQuery(s.query)}
                aria-keyshortcuts="Delete"
              >
                <HistoryIcon aria-hidden="true" className="text-text-muted" />
                <span className="min-w-0 flex-1 truncate">{s.query}</span>
                <span className="hidden flex-none text-xs text-text-muted group-data-[selected=true]:sm:inline">
                  <Kbd>Del</Kbd> to forget
                </span>
              </CommandItem>
            ))}
            <CommandItem value="recent:clear" className={cn(ITEM_CLASS, "text-sm text-text-muted")} onSelect={clear}>
              <span className="pl-7">Clear recent searches</span>
            </CommandItem>
          </CommandGroup>
        ) : null}

        {searching ? resultGroups : null}

        {searching && whatsAppClients.length > 0 ? (
          <CommandGroup heading="WhatsApp">
            {whatsAppClients.map((item) => (
              <CommandItem key={`wa-${item.id}`} value={`whatsapp:${item.id}`} className={ITEM_CLASS} onSelect={() => openWhatsApp(item.id)}>
                <MessageCircleIcon aria-hidden="true" className="text-text-muted" />
                <span className="min-w-0 flex-1 truncate">{whatsAppCommandLabel(item.title)}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}

        {searching && pending && results.length === 0 ? (
          <div className="px-3 py-2" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex h-10 items-center gap-3">
                <Skeleton className="size-4 rounded-sm" />
                <Skeleton className={cn("h-3.5", i === 1 ? "w-[45%]" : "w-[62%]")} />
              </div>
            ))}
          </div>
        ) : null}

        {error ? (
          <div role="alert" className="flex items-start gap-3 px-3 py-3 text-base">
            <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 flex-none text-danger-text" />
            <div className="min-w-0 flex-1">
              <p className="text-text">{error.error}</p>
              {error.ref ? (
                <p className="mt-1 text-sm text-text-muted">
                  Ref <span className="font-mono text-text">{error.ref}</span>
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
        {error ? (
          <CommandGroup>
            <CommandItem
              value="search:retry"
              className={cn(ITEM_CLASS, "text-primary")}
              onSelect={() => {
                setState({ status: "idle" });
                setAttempt((n) => n + 1);
              }}
            >
              <RotateCwIcon aria-hidden="true" className="text-primary" />
              Try the search again
            </CommandItem>
          </CommandGroup>
        ) : null}

        {commandGroup("Create")}
        {commandGroup("Actions")}
        {commandGroup("Go to")}

        {searching && resultsCurrent && totalResults > 0 ? (
          <CommandGroup>
            <CommandItem value="search:all" className={cn(ITEM_CLASS, "text-primary")} onSelect={() => openResult(searchPageHref(trimmed))}>
              <SearchIcon aria-hidden="true" className="text-primary" />
              <span className="min-w-0 flex-1 truncate">
                See all <span className="num">{totalResults}</span> results for “{trimmed}”
              </span>
            </CommandItem>
          </CommandGroup>
        ) : null}

        {nothing ? (
          <div className="px-3 py-8 text-center">
            <p className="text-base text-text">No results for “{trimmed}”.</p>
            <p className="mt-1 text-sm text-text-muted">Check the spelling, or search by client code, PAN, GSTIN or task number.</p>
          </div>
        ) : null}

        {trimmed.length > 0 && !searching && visible.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-text-muted">Keep typing to search records.</p>
        ) : null}
      </CommandList>

      <div className="hidden flex-none items-center gap-4 border-t border-border px-4 py-2 text-xs text-text-muted sm:flex">
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> to move
        </span>
        <span className="flex items-center gap-1">
          <Kbd>Enter</Kbd> to open
        </span>
        <span className="flex items-center gap-1">
          <Kbd>Esc</Kbd> to close
        </span>
      </div>
    </Command>
  );
}
