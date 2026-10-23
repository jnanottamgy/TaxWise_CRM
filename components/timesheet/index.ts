/**
 * Timesheet pieces other modules reuse (My day, task pages, the shell):
 *   TimerButton      Start / Stop timer on a task or client (one running timer per person, §7.10)
 *   TimeEntryDialog  manual time entry (Log time)
 * The shell's running-timer panel is components/timesheet/timer-panel.tsx (server, never throws),
 * which the staff layout imports directly.
 */
export { TimerButton, type RunningRef } from "@/components/timesheet/timer-button"
export { TimeEntryDialog, type EntryInitial } from "@/components/timesheet/time-entry-dialog"
