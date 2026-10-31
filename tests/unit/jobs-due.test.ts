import { describe, expect, it } from "vitest";
import { MAX_ATTEMPTS, STALE_RUN_MINUTES, dueRuns, isStale, type RecentRun } from "@/server/jobs/due";
import { UNLIMITED, outOfTime } from "@/server/jobs/context";

const NOW = new Date("2026-10-31T03:31:20Z"); // Saturday, 09:01 IST
const run = (name: string, started_at: string, status = "succeeded", resume_cursor: string | null = null): RecentRun => ({ name, started_at, status, resume_cursor });
const jobs = (runs: RecentRun[] = [], now = NOW) => dueRuns(now, runs).map((d) => d.job);
const one = (job: string, runs: RecentRun[], now = NOW) => dueRuns(now, runs).find((d) => d.job === job);

describe("dueRuns: what the scheduler's check runs", () => {
  it("with nothing run yet, runs everything that came due in the look-back, oldest first", () => {
    expect(jobs()).toEqual([
      "workforce-sweep", // 00:15 IST
      "upload-cleanup", // 03:00 IST
      "recurring-tasks", // 07:00 IST
      "receivables-sweep",
      "escalation",
      "digest",
      "cover-lifecycle", // hourly, :07
      "lead-follow-ups", // hourly, 09:00 IST
      "reminders", // 09:00 IST, after lead-follow-ups in schedule order
    ]);
  });

  it("skips a job that finished after its time, and runs one whose last run was before it", () => {
    expect(jobs([run("reminders", "2026-10-31T03:30:05Z")])).not.toContain("reminders");
    expect(jobs([run("reminders", "2026-10-30T03:30:05Z")])).toContain("reminders");
    // A partial run (some records failed and were logged) still counts as done.
    expect(jobs([run("reminders", "2026-10-31T03:30:05Z", "partial")])).not.toContain("reminders");
  });

  it("continues a run that stopped at its time budget, from its cursor", () => {
    expect(one("recurring-tasks", [run("recurring-tasks", "2026-10-31T01:45:00Z", "succeeded", "more")])).toMatchObject({ cursor: "more", attempt: 1 });
    const chain = [run("recurring-tasks", "2026-10-31T01:45:00Z", "succeeded", "more"), run("recurring-tasks", "2026-10-31T02:00:00Z")];
    expect(jobs(chain)).not.toContain("recurring-tasks");
  });

  it("retries a failed run up to MAX_ATTEMPTS in a row, then leaves it for Diagnostics", () => {
    const tries = ["2026-10-31T02:30:10Z", "2026-10-31T02:45:10Z", "2026-10-31T03:00:10Z"];
    const failures = (n: number) => tries.slice(0, n).map((t) => run("escalation", t, "failed"));
    expect(one("escalation", failures(1))).toMatchObject({ attempt: 2, cursor: null });
    expect(one("escalation", failures(MAX_ATTEMPTS - 1))).toMatchObject({ attempt: MAX_ATTEMPTS });
    expect(one("escalation", failures(MAX_ATTEMPTS))).toBeUndefined();
  });

  it("retries a failed continuation from the last good cursor", () => {
    const runs = [run("recurring-tasks", "2026-10-31T01:45:00Z", "succeeded", "more"), run("recurring-tasks", "2026-10-31T02:00:00Z", "failed")];
    expect(one("recurring-tasks", runs)).toMatchObject({ cursor: "more", attempt: 2 });
  });

  it("doesn't run a job again for a time it already finished, whatever came after", () => {
    const runs = [run("escalation", "2026-10-31T02:31:00Z"), run("escalation", "2026-10-31T03:00:00Z", "failed")];
    expect(jobs(runs)).not.toContain("escalation");
  });

  it("leaves a run that is still going, and counts one the host stopped as a failed attempt", () => {
    const recent = run("reminders", "2026-10-31T03:30:30Z", "running");
    expect(jobs([recent])).not.toContain("reminders");
    const stopped = run("reminders", "2026-10-31T03:30:30Z", "running");
    const later = new Date(Date.parse(stopped.started_at) + (STALE_RUN_MINUTES + 1) * 60_000);
    expect(one("reminders", [stopped], later)).toMatchObject({ attempt: 2 });
  });

  it("runs absent-without-cover once when both of its times are due together", () => {
    const at = new Date("2026-10-31T05:01:00Z");
    const due = dueRuns(at, []).filter((d) => d.job === "absent-without-cover");
    expect(due).toHaveLength(1);
    expect(due[0].scheduledFor.toISOString()).toBe("2026-10-31T04:30:00.000Z");
    // After the 10:00 IST run, the 10:30 pass is still due.
    expect(jobs([run("absent-without-cover", "2026-10-31T04:30:10Z")], at)).toContain("absent-without-cover");
  });

  it("catches up the monthly top-up within three days, and not after", () => {
    expect(jobs([], new Date("2026-11-03T02:00:00Z"))).toContain("compliance-top-up");
    expect(jobs([], new Date("2026-11-04T04:00:00Z"))).not.toContain("compliance-top-up");
  });
});

describe("isStale and outOfTime", () => {
  it("calls a run stale only after the limit", () => {
    const started = "2026-10-31T03:00:00Z";
    expect(isStale({ status: "running", started_at: started }, new Date("2026-10-31T03:09:00Z"))).toBe(false);
    expect(isStale({ status: "running", started_at: started }, new Date("2026-10-31T03:11:00Z"))).toBe(true);
    expect(isStale({ status: "failed", started_at: started }, new Date("2026-10-31T05:00:00Z"))).toBe(false);
  });

  it("stops a second before the deadline, and never without one", () => {
    expect(outOfTime({ deadline: 10_000, cursor: null }, 8_999)).toBe(false);
    expect(outOfTime({ deadline: 10_000, cursor: null }, 9_001)).toBe(true);
    expect(outOfTime(UNLIMITED)).toBe(false);
  });
});
