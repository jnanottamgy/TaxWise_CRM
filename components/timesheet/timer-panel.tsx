import type { CurrentUser } from "@/lib/auth/current-user";

/**
 * The running-timer panel shown in the shell's timer sheet (§7.10). Rendered by the staff layout for
 * every page, so it must never throw: catch its own data load and fall back to the hint text.
 * Owned by the timesheet module.
 */
export async function TimerPanel({ user }: { user: CurrentUser }) {
  void user;
  return (
    <p className="text-base text-text-muted">
      Start a timer from a task or a client, or log time you have already spent.
    </p>
  );
}
