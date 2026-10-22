"use client";

import * as React from "react";
import type { AppRole } from "@/lib/auth/roles";
import type { NavGroup, NavItem, NewAction } from "@/lib/nav";
import type { DensityPreference } from "@/lib/preferences";
import type { Crumb } from "@/components/app/page-header";
import type { RecentPlace } from "./use-recent";

/**
 * Shared state for the staff shell: who is signed in, the panels the shell owns (command palette,
 * New menu, help, timer, shortcuts, mobile drawer), favourites, the unread count, and the slots
 * pages fill (top-bar breadcrumb, help guide). Pages use the slot components in ./page-slots.
 */

export interface ShellUser {
  id: string;
  fullName: string;
  email: string;
  role: AppRole;
}

export type ShellPanel = "palette" | "new" | "help" | "timer" | "shortcuts" | "drawer";

export interface ShellGuide {
  title?: string;
  body: React.ReactNode;
}

export interface ShellSlots {
  title: Crumb[] | null;
  guide: ShellGuide | null;
}

type SlotKey = keyof ShellSlots;

/** A tiny external store, so pages can fill slots from effects without re-rendering the shell tree. */
export interface SlotStore {
  get<K extends SlotKey>(key: K): ShellSlots[K];
  /** Returns a token; `clear` only clears a value still owned by that token. */
  set<K extends SlotKey>(key: K, value: ShellSlots[K]): number;
  clear(key: SlotKey, token: number): void;
  subscribe(listener: () => void): () => void;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // Breadcrumbs are plain data: compare by content so inline arrays don't notify on every render.
  if (Array.isArray(a) && Array.isArray(b)) {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

export function createSlotStore(): SlotStore {
  const values: ShellSlots = { title: null, guide: null };
  const owners: Record<SlotKey, number> = { title: 0, guide: 0 };
  const listeners = new Set<() => void>();
  let counter = 0;
  const emit = () => {
    for (const l of listeners) l();
  };
  return {
    get: (key) => values[key],
    set(key, value) {
      counter += 1;
      owners[key] = counter;
      if (!sameValue(values[key], value)) {
        values[key] = value;
        emit();
      }
      return counter;
    },
    clear(key, token) {
      if (owners[key] !== token) return;
      owners[key] = 0;
      if (values[key] !== null) {
        values[key] = null;
        emit();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export interface ShellContextValue {
  user: ShellUser;
  firm: { name: string; logoUrl: string | null };
  nav: NavGroup[];
  goTo: NavItem[];
  newActions: NewAction[];
  isOpen: (panel: ShellPanel) => boolean;
  setOpen: (panel: ShellPanel, open: boolean) => void;
  favourites: string[];
  toggleFavourite: (href: string) => void;
  unreadCount: number | null;
  refreshUnread: () => void;
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  /** The last 5 places, newest first, without the current page. */
  recent: RecentPlace[];
  /** Density when the page loaded; the user menu owns changes from then on. */
  density: DensityPreference;
  fy: ShellFy;
  slots: SlotStore;
}

export interface ShellFy {
  selected: string;
  current: string;
  /** Newest first. */
  options: string[];
  /** True while a new year is being saved. */
  pending: boolean;
  choose: (fy: string) => void;
}

export const ShellContext = React.createContext<ShellContextValue | null>(null);

/** The staff shell's context. Throws outside the shell: only shell components use it. */
export function useShell(): ShellContextValue {
  const ctx = React.useContext(ShellContext);
  if (!ctx) throw new Error("useShell must be used inside the staff shell.");
  return ctx;
}

/** The staff shell's context, or null (the portal, an error page). For components that may live anywhere. */
export function useOptionalShell(): ShellContextValue | null {
  return React.useContext(ShellContext);
}

const noopSubscribe = () => () => {};

/** Reads one slot and re-renders when it changes. */
export function useSlot<K extends SlotKey>(store: SlotStore | null, key: K): ShellSlots[K] | null {
  const subscribe = store ? store.subscribe : noopSubscribe;
  return React.useSyncExternalStore(
    subscribe,
    () => (store ? store.get(key) : null),
    () => null,
  );
}
