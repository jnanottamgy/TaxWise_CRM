"use client";

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

/**
 * The sidebar's "+ New" split button (§3.3): the main half does the role's everyday action (New task
 * for Partners and Managers, Log time for Employees); the chevron opens every New item the role may
 * use. `N` opens the menu (§3.4). In the 64px rail it is one "+" button that opens the menu.
 */
export function NewSplitButton({ rail = false, onNavigate }: { rail?: boolean; onNavigate?: () => void }) {
  const { user, newActions, isOpen, setOpen } = useShell();
  const main = defaultNewAction(user.role);
  if (!main) return null;

  const menu = (trigger: React.ReactNode, side: "bottom" | "right") => (
    <DropdownMenu open={isOpen("new")} onOpenChange={(o) => setOpen("new", o)}>
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
            <Button size="icon" className="mx-auto flex" aria-label="New">
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
    <Button asChild size="sm" className={cn("min-w-0 flex-1 justify-start", newActions.length > 1 && "rounded-r-none")}>
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
          <Button size="icon-sm" className="rounded-l-none border-l border-primary-foreground/25" aria-label="More new items">
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
