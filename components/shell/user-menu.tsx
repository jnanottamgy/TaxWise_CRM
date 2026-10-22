"use client";

import * as React from "react";
import Link from "next/link";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { ChevronsUpDownIcon, KeyboardIcon, Loader2Icon, LogOutIcon, UserRoundIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { RoleBadge } from "@/components/app/role-badge";
import type { AppRole } from "@/lib/auth/roles";
import {
  DENSITY_COMPACT_CLASS,
  DENSITY_COOKIE,
  writeDisplayCookie,
  type DensityPreference,
  type ThemePreference,
} from "@/lib/preferences";
import { saveDensity, saveTheme } from "@/server/actions/preferences";
import { signOut } from "@/server/actions/auth";
import { cn } from "@/lib/utils";

/**
 * The avatar menu at the foot of the sidebar (§3.3): Profile, Theme, Density, Keyboard shortcuts,
 * Sign out. The portal uses it with `variant="portal"` (Theme and Sign out only).
 */

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : "";
  return `${first}${last}`.toUpperCase();
}

export function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-8 flex-none select-none items-center justify-center rounded-full border border-border bg-surface-2 text-xs font-semibold text-text-muted",
        className,
      )}
    >
      {initialsOf(name)}
    </span>
  );
}

/** Applies a density to <html> now and remembers it (cookie for the next first paint, profile for other devices). */
export function applyDensity(density: DensityPreference, persist = true): void {
  try {
    document.documentElement.classList.toggle(DENSITY_COMPACT_CLASS, density === "compact");
  } catch {
    // No DOM: nothing to apply.
  }
  writeDisplayCookie(DENSITY_COOKIE, density);
  if (persist) void saveDensity({ density }).catch(() => undefined);
}

export function UserMenu({
  name,
  email,
  role,
  variant = "staff",
  rail = false,
  initialDensity = "comfortable",
  onShortcuts,
  onNavigate,
}: {
  name: string;
  email: string;
  role: AppRole;
  variant?: "staff" | "portal";
  rail?: boolean;
  initialDensity?: DensityPreference;
  onShortcuts?: () => void;
  onNavigate?: () => void;
}) {
  const { theme, setTheme } = useTheme();
  const [density, setDensity] = React.useState<DensityPreference>(initialDensity);
  const [signingOut, startSignOut] = React.useTransition();

  const chooseTheme = (value: string) => {
    const t = value as ThemePreference;
    setTheme(t);
    void saveTheme({ theme: t }).catch(() => undefined);
  };

  const chooseDensity = (value: string) => {
    const d = value as DensityPreference;
    setDensity(d);
    applyDensity(d);
  };

  const doSignOut = () =>
    startSignOut(async () => {
      try {
        const result = await signOut();
        if (result.ok) window.location.assign(result.data.redirectTo);
        else toast.error(result.error);
      } catch {
        toast.error("We couldn't reach TaxWise to sign you out. Check your connection and try again.");
      }
    });

  const trigger =
    variant === "portal" ? (
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Account menu for ${name}`}
          className="inline-flex size-9 cursor-pointer items-center justify-center rounded-full outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:size-11"
        >
          <Avatar name={name} />
        </button>
      </DropdownMenuTrigger>
    ) : rail ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Account menu for ${name}`}
              className="mx-auto flex size-10 cursor-pointer items-center justify-center rounded-md outline-none hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <Avatar name={name} />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="right">{name}</TooltipContent>
      </Tooltip>
    ) : (
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Account menu for ${name}`}
          className="flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left outline-none transition-colors duration-150 ease-out hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11"
        >
          <Avatar name={name} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-sm font-medium text-text">{name}</span>
            <RoleBadge role={role} className="self-start" />
          </span>
          <ChevronsUpDownIcon aria-hidden="true" className="size-4 flex-none text-text-muted" />
        </button>
      </DropdownMenuTrigger>
    );

  return (
    <DropdownMenu>
      {trigger}
      <DropdownMenuContent
        side={variant === "portal" ? "bottom" : rail ? "right" : "top"}
        align={variant === "portal" ? "end" : "start"}
        className="w-64"
      >
        <DropdownMenuLabel className="flex flex-col gap-0.5 font-normal">
          <span className="truncate text-sm font-medium text-text">{name}</span>
          <span className="truncate text-xs text-text-muted">{email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {variant === "staff" ? (
          <>
            <DropdownMenuItem asChild className="pointer-coarse:min-h-11">
              <Link href="/profile" onClick={onNavigate}>
                <UserRoundIcon aria-hidden="true" />
                Profile
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}

        <DropdownMenuGroup>
          <DropdownMenuLabel className="pb-1 text-xs font-medium text-text-muted">Theme</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={theme ?? "light"} onValueChange={chooseTheme}>
            <DropdownMenuRadioItem value="light" className="pointer-coarse:min-h-11">Light</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark" className="pointer-coarse:min-h-11">Dark</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="system" className="pointer-coarse:min-h-11">Same as this device</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>

        {variant === "staff" ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel className="pb-1 text-xs font-medium text-text-muted">Density</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={density} onValueChange={chooseDensity}>
                <DropdownMenuRadioItem value="comfortable" className="pointer-coarse:min-h-11">Comfortable</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="compact" className="pointer-coarse:min-h-11">Compact rows</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
            {onShortcuts ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => onShortcuts()} className="pointer-coarse:min-h-11">
                  <KeyboardIcon aria-hidden="true" />
                  Keyboard shortcuts
                  <DropdownMenuShortcut>?</DropdownMenuShortcut>
                </DropdownMenuItem>
              </>
            ) : null}
          </>
        ) : null}

        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={signingOut}
          onSelect={(e) => {
            e.preventDefault();
            doSignOut();
          }}
          className="pointer-coarse:min-h-11"
        >
          {signingOut ? <Loader2Icon aria-hidden="true" className="animate-spin" /> : <LogOutIcon aria-hidden="true" />}
          {signingOut ? "Signing out…" : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
