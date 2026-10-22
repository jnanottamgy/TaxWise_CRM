"use client";

import { ChevronDownIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useShell } from "./shell-context";

/**
 * The FY switcher (§3.3): defaults to the current FY and filters every FY-aware screen. Choosing a
 * year sets the `tw_fy` cookie on the server, which re-renders the page with that year. The state
 * lives in the shell, so the top bar and the phone drawer always agree.
 */
export function FySwitcher({ className }: { className?: string }) {
  const { fy } = useShell();
  const { selected, pending } = fy;
  const options = fy.options.includes(selected) ? fy.options : [selected, ...fy.options];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn("gap-1.5 px-2.5", className)}
          aria-label={`Financial year ${selected}. Change year`}
          aria-busy={pending || undefined}
        >
          <span className="text-text-muted">FY</span>
          <span className="num font-medium">{selected}</span>
          {pending ? (
            <Loader2Icon aria-hidden="true" className="size-3.5 animate-spin text-text-muted" />
          ) : (
            <ChevronDownIcon aria-hidden="true" className="size-3.5 text-text-muted" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel className="text-xs font-medium text-text-muted">Financial year</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={selected} onValueChange={fy.choose}>
          {options.map((o) => (
            <DropdownMenuRadioItem key={o} value={o} className="pointer-coarse:min-h-11">
              <span className="num">{o}</span>
              {o === fy.current ? <span className="ml-auto text-xs text-text-muted">Current</span> : null}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
