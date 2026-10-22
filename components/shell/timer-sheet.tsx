"use client";

import Link from "next/link";
import { ClockIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { useShell } from "./shell-context";

/**
 * The timer sheet (§7.10: start a timer from the top bar; §3.3: the Employees' bottom-bar Timer tab).
 * The timesheet module provides the running-timer panel through the staff layout's `timerPanel`;
 * until then the sheet offers the timesheet and manual entry.
 */
export function TimerSheet({ panel }: { panel?: React.ReactNode }) {
  const { isOpen, setOpen } = useShell();
  const mobile = useIsMobile();
  const close = () => setOpen("timer", false);
  return (
    <Sheet open={isOpen("timer")} onOpenChange={(o) => setOpen("timer", o)}>
      <SheetContent side={mobile ? "bottom" : "right"} className="gap-0 p-0">
        <SheetHeader className="border-b border-border px-5 pt-5 pr-14 pb-4">
          <SheetTitle>Timer</SheetTitle>
          <SheetDescription>One timer runs at a time. It keeps running when you move between pages.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {panel ?? (
            <p className="text-base text-text-muted">
              Start a timer from a task or a client, or log time you have already spent.
            </p>
          )}
        </div>
        <div className="flex flex-col-reverse gap-2 border-t border-border px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:flex-row sm:justify-end">
          <Button asChild variant="outline">
            <Link href="/timesheet" onClick={close}>
              <ClockIcon aria-hidden="true" />
              Open timesheet
            </Link>
          </Button>
          <Button asChild>
            <Link href="/timesheet?new=1" onClick={close}>
              <PlusIcon aria-hidden="true" />
              Log time
            </Link>
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
