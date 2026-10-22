import { describe, expect, it } from "vitest";
import {
  ATTENDANCE_DEFAULTS,
  attendanceCorrectionError,
  deriveAttendance,
  isOnTime,
  onTimeUntilMinute,
  parseTimeOfDay,
  summariseDay,
  summariseMonth,
  type AttendanceInput,
} from "@/lib/domain/attendance";

const ist = (time: string, date = "2026-10-22") => new Date(`${date}T${time}+05:30`);

function day(over: Partial<AttendanceInput> = {}): AttendanceInput {
  return {
    ...ATTENDANCE_DEFAULTS,
    firstActivity: ist("09:20:00"),
    totalActiveMinutes: 420,
    isWorkingDay: true,
    onApprovedLeave: false,
    ...over,
  };
}

describe("deriveAttendance (§7.12)", () => {
  it("uses the firm defaults: 09:30 start, 15 minutes' grace, half day under 240 minutes", () => {
    expect(ATTENDANCE_DEFAULTS).toEqual({ workDayStart: "09:30", lateGraceMinutes: 15, halfDayMinutes: 240 });
    expect(onTimeUntilMinute(ATTENDANCE_DEFAULTS)).toBe(9 * 60 + 45);
  });

  it("Present when the first activity is on or before start + grace", () => {
    expect(deriveAttendance(day({ firstActivity: ist("08:55:00") }))).toBe("present");
    expect(deriveAttendance(day({ firstActivity: ist("09:30:00") }))).toBe("present");
    expect(deriveAttendance(day({ firstActivity: ist("09:45:00") }))).toBe("present");
    expect(deriveAttendance(day({ firstActivity: ist("09:45:59") }))).toBe("present");
  });

  it("Late login after start + grace", () => {
    expect(deriveAttendance(day({ firstActivity: ist("09:46:00") }))).toBe("late_login");
    expect(deriveAttendance(day({ firstActivity: ist("13:00:00") }))).toBe("late_login");
  });

  it("reads the first activity in IST, whatever the timestamp's own offset", () => {
    expect(deriveAttendance(day({ firstActivity: "2026-10-22T04:15:00Z" }))).toBe("present"); // 09:45 IST
    expect(deriveAttendance(day({ firstActivity: "2026-10-22T04:16:00.000Z" }))).toBe("late_login"); // 09:46 IST
  });

  it("Half day when total active minutes are under half_day_minutes at day end (it wins over late)", () => {
    expect(deriveAttendance(day({ totalActiveMinutes: 239 }))).toBe("half_day");
    expect(deriveAttendance(day({ totalActiveMinutes: 240 }))).toBe("present");
    expect(deriveAttendance(day({ firstActivity: ist("11:00:00"), totalActiveMinutes: 100 }))).toBe("half_day");
    expect(deriveAttendance(day({ totalActiveMinutes: 0 }))).toBe("half_day");
  });

  it("decides Half day only at day end: during the day it shows Present or Late login", () => {
    expect(deriveAttendance(day({ totalActiveMinutes: 30, dayComplete: false }))).toBe("present");
    expect(deriveAttendance(day({ firstActivity: ist("10:30:00"), totalActiveMinutes: 30, dayComplete: false }))).toBe("late_login");
  });

  it("Absent when there was no activity on a working day (no record yet while the day runs)", () => {
    expect(deriveAttendance(day({ firstActivity: null, totalActiveMinutes: 0 }))).toBe("absent");
    expect(deriveAttendance(day({ firstActivity: null, totalActiveMinutes: 0, dayComplete: false }))).toBeNull();
  });

  it("On leave wins over everything else", () => {
    expect(deriveAttendance(day({ onApprovedLeave: true }))).toBe("on_leave");
    expect(deriveAttendance(day({ onApprovedLeave: true, firstActivity: null }))).toBe("on_leave");
    expect(deriveAttendance(day({ onApprovedLeave: true, totalActiveMinutes: 10 }))).toBe("on_leave");
    expect(deriveAttendance(day({ onApprovedLeave: true, firstActivity: ist("12:00:00") }))).toBe("on_leave");
  });

  it("non-working days and holidays create no record", () => {
    expect(deriveAttendance(day({ isWorkingDay: false }))).toBeNull();
    expect(deriveAttendance(day({ isWorkingDay: false, firstActivity: null }))).toBeNull();
    expect(deriveAttendance(day({ isWorkingDay: false, onApprovedLeave: true }))).toBeNull();
  });

  it("follows edited working hours", () => {
    const p = { workDayStart: "10:00:00", lateGraceMinutes: 0, halfDayMinutes: 300 };
    expect(deriveAttendance(day({ ...p, firstActivity: ist("10:00:00") }))).toBe("present");
    expect(deriveAttendance(day({ ...p, firstActivity: ist("10:01:00") }))).toBe("late_login");
    expect(deriveAttendance(day({ ...p, totalActiveMinutes: 299 }))).toBe("half_day");
    expect(isOnTime(ist("09:59:00"), p)).toBe(true);
  });
});

describe("parseTimeOfDay", () => {
  it("reads HH:MM and Postgres time values", () => {
    expect(parseTimeOfDay("09:30")).toBe(570);
    expect(parseTimeOfDay("09:30:00")).toBe(570);
    expect(parseTimeOfDay("23:59:59.5")).toBe(1439);
    expect(parseTimeOfDay(" 00:00 ")).toBe(0);
  });

  it("refuses anything else", () => {
    expect(() => parseTimeOfDay("9:30")).toThrow(RangeError);
    expect(() => parseTimeOfDay("24:00")).toThrow(RangeError);
    expect(() => parseTimeOfDay("09:60")).toThrow(RangeError);
    expect(() => parseTimeOfDay("half past nine")).toThrow(RangeError);
  });
});

describe("summariseDay: from sessions to the day's facts", () => {
  it("takes the first login, the last activity and the active minutes of sessions begun that IST day", () => {
    const sessions = [
      { loginAt: ist("14:00:00"), lastActiveAt: ist("17:30:00"), activeMinutes: 200 },
      { loginAt: ist("09:40:00"), lastActiveAt: ist("13:00:00"), activeMinutes: 190 },
      { loginAt: ist("23:50:00", "2026-10-21"), lastActiveAt: ist("00:10:00"), activeMinutes: 20 },
      { loginAt: "2026-10-22T18:40:00Z", lastActiveAt: "2026-10-22T18:50:00Z", activeMinutes: 10 }, // 00:10 IST on the 23rd
    ];
    const s = summariseDay(sessions, "2026-10-22");
    expect(s).toEqual({ firstActivity: ist("09:40:00"), lastActivity: ist("17:30:00"), totalActiveMinutes: 390 });
    expect(deriveAttendance(day({ firstActivity: s.firstActivity, totalActiveMinutes: s.totalActiveMinutes }))).toBe("present");
  });

  it("has no first activity when nobody signed in that day", () => {
    expect(summariseDay([], "2026-10-22")).toEqual({ firstActivity: null, lastActivity: null, totalActiveMinutes: 0 });
  });
});

describe("corrections and the monthly summary (§7.12)", () => {
  it("only Partners and Managers correct, with a status and a reason", () => {
    expect(attendanceCorrectionError({ actorRole: "manager", status: "present", reason: "Worked from the client's office" })).toBeNull();
    expect(attendanceCorrectionError({ actorRole: "partner", status: "on_leave", reason: "Leave approved late" })).toBeNull();
    expect(attendanceCorrectionError({ actorRole: "employee", status: "present", reason: "x" })).toBe("Only Partners and Managers can correct attendance.");
    expect(attendanceCorrectionError({ actorRole: "manager", status: "holiday", reason: "x" })).toBe("Choose the corrected status.");
    expect(attendanceCorrectionError({ actorRole: "manager", status: "present", reason: "  " })).toBe("Give a reason for the correction.");
  });

  it("counts each status and sums the minutes", () => {
    expect(
      summariseMonth([
        { status: "present", workMinutes: 480 },
        { status: "present", workMinutes: 470 },
        { status: "late_login", workMinutes: 400 },
        { status: "half_day", workMinutes: 200 },
        { status: "absent" },
        { status: "on_leave", workMinutes: null },
      ]),
    ).toEqual({ present: 2, lateLogin: 1, halfDay: 1, absent: 1, onLeave: 1, workMinutes: 1550 });
  });
});
