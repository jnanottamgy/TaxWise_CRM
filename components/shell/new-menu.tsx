"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Kbd } from "@/components/ui/kbd";
import { defaultNewAction, type NewAction } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { useShell } from "./shell-context";
import { useMediaQuery } from "./use-media";

/**
 * The sidebar's "+ New" split button (§3.3): the main half does the role's everyday action (New task
 * for Partners and Managers, Log time for Employees); the chevron opens every New item the role may
 * use. `N` opens the menu (§3.4). In the 64px rail it is one "+" button that opens the menu. Outlined, so
 * the page's own primary action stays the one filled button on the screen (DESIGN.md §3).
 */
export function NewSplitButton({
  rail = false,
  placement = "sidebar",
  onNavigate,
}: {
  rail?: boolean;
  /** Which copy of the sidebar this sits in: only the one on screen answers `N` (the others are display:none). */
  placement?: "sidebar" | "tablet-rail" | "drawer";
  onNavigate?: () => void;
}) {
  const { user, newActions, isOpen, setOpen } = useShell();
  const wide = useMediaQuery("(min-width: 1024px)", true);
  const tablet = useMediaQuery("(min-width: 768px) and (max-width: 1023.98px)", false);
  // Inside the phone drawer the menu keeps its own state: the shared "new" panel would close the
  // drawer it sits in (on phones `N` opens search instead).
  const [drawerMenuOpen, setDrawerMenuOpen] = React.useState(false);
  const inDrawer = placement === "drawer";
  const onScreen = placement === "tablet-rail" ? tablet : wide;
  const open = inDrawer ? drawerMenuOpen : onScreen && isOpen("new");
  const onOpenChange = (o: boolean) => (inDrawer ? setDrawerMenuOpen(o) : setOpen("new", o));
  const main = defaultNewAction(user.role);
  if (!main) return null;

  const menu = (trigger: React.ReactNode, side: "bottom" | "right") => (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      {trigger}
      <DropdownMenuContent side={side} align="start" className="w-56">
        <DropdownMenuLabel className="flex items-center justify-between text-xs font-medium text-text-muted">
          New
          <Kbd>N</Kbd>
        </DropdownMenuLabel>
        {newActions.map((a) => (
          <NewItem key={a.id} action={a} onNavigate={onNavigate} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  if (rail) {
    return menu(
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="outline" className="mx-auto flex [&_svg]:text-primary" aria-label="New">
              <PlusIcon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="right">New</TooltipContent>
      </Tooltip>,
      "right",
    );
  }

  const mainButton = (
    <Button
      asChild
      size="sm"
      variant="outline"
      className={cn("min-w-0 flex-1 justify-start [&_svg]:text-primary", newActions.length > 1 && "rounded-r-none")}
    >
      <Link href={main.href} onClick={onNavigate}>
        <PlusIcon aria-hidden="true" />
        <span className="truncate">{main.label}</span>
      </Link>
    </Button>
  );

  if (newActions.length <= 1) return <div className="flex">{mainButton}</div>;

  return (
    <div className="flex">
      {mainButton}
      {menu(
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" variant="outline" className="-ml-px rounded-l-none text-text-muted" aria-label="More new items">
            <ChevronDownIcon aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>,
        "bottom",
      )}
    </div>
  );
}

function NewItem({ action, onNavigate }: { action: NewAction; onNavigate?: () => void }) {
  const Icon = action.icon;
  return (
    <DropdownMenuItem asChild className="pointer-coarse:min-h-11">
      <Link href={action.href} onClick={onNavigate}>
        <Icon aria-hidden="true" />
        {action.label}
      </Link>
    </DropdownMenuItem>
  );
}
