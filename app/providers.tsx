"use client";

import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/app/toaster";

/**
 * App-wide client providers: the theme (light by default, dark, or the device's setting, §3.1),
 * tooltips, and the toast region (§3.4).
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange>
      <TooltipProvider delayDuration={300}>
        {children}
        <Toaster />
      </TooltipProvider>
    </ThemeProvider>
  );
}
