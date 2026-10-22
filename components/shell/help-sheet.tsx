"use client";

import { usePathname } from "next/navigation";
import { KeyboardIcon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Keys } from "@/components/app/shortcut-sheet";
import { findActiveNav } from "@/lib/nav";
import { useShell, useSlot } from "./shell-context";

/**
 * Help for the page being shown (§3.3): the page's own guide (<PageGuide>), or the sidebar item's
 * one-line description when the page has none, then where to go next.
 */
export function HelpSheet() {
  const { isOpen, setOpen } = useShell();
  const open = isOpen("help");
  return (
    <Sheet open={open} onOpenChange={(o) => setOpen("help", o)}>
      <SheetContent side="right" className="gap-0 p-0">{open ? <HelpBody /> : null}</SheetContent>
    </Sheet>
  );
}

function HelpBody() {
  const { user, slots, setOpen } = useShell();
  const pathname = usePathname() ?? "/";
  const guide = useSlot(slots, "guide");
  const active = findActiveNav(pathname, user.role);
  const pageName = guide?.title ?? active?.item.label ?? "This page";

  return (
    <>
      <SheetHeader className="border-b border-border px-5 pt-5 pr-14 pb-4">
        <SheetTitle>Help: {pageName}</SheetTitle>
        <SheetDescription>{active?.item.description ?? "How this page works, and where to go next."}</SheetDescription>
      </SheetHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-base leading-6 text-text [&_li]:mt-1 [&_p+p]:mt-3 [&_ul]:mt-2 [&_ul]:list-disc [&_ul]:pl-5">
        {guide ? (
          guide.body
        ) : (
          <p className="text-text-muted">There&apos;s no written guide for this page yet. Ask a Partner if something here isn&apos;t clear.</p>
        )}
      </div>
      <div className="flex flex-col gap-2 border-t border-border px-5 py-4">
        <Button
          variant="outline"
          className="justify-start"
          onClick={() => setOpen("palette", true)}
        >
          <SearchIcon aria-hidden="true" />
          Search or jump to a page
          <span className="ml-auto">
            <Keys keys={["mod", "K"]} />
          </span>
        </Button>
        <Button variant="outline" className="justify-start" onClick={() => setOpen("shortcuts", true)}>
          <KeyboardIcon aria-hidden="true" />
          Keyboard shortcuts
          <span className="ml-auto">
            <Keys keys={["?"]} />
          </span>
        </Button>
      </div>
    </>
  );
}
