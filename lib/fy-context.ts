import "server-only";

import { cookies } from "next/headers";
import {
  financialYearOf,
  isFinancialYear,
  nextFinancialYear,
  parseFinancialYear,
  recentFinancialYears,
  todayIST,
  type FinancialYear,
} from "@/lib/domain/fy";

/**
 * The financial year chosen in the top bar's FY switcher (§3.3). It filters every FY-aware screen.
 * Stored in the `tw_fy` cookie (set by `setFinancialYear` in server/actions/preferences.ts); the
 * default is the current FY in IST (§0.1 rule 13).
 *
 *   const fy = await getSelectedFy();   // "2026-27"
 */

export const FY_COOKIE = "tw_fy";

/** How many past FYs the switcher offers besides the current one. */
const PAST_YEARS = 6;

/** The current FY and the ones before it, newest first, plus next FY (for advance planning). */
export function fyOptions(today: string = todayIST()): FinancialYear[] {
  const current = financialYearOf(today);
  return [nextFinancialYear(current), ...recentFinancialYears(today, PAST_YEARS + 1)];
}

/** True for an FY the switcher may select: a well-formed label from 2000-01 up to next FY. */
export function isSelectableFy(value: unknown, today: string = todayIST()): value is FinancialYear {
  if (!isFinancialYear(value)) return false;
  const start = parseFinancialYear(value);
  const limit = parseFinancialYear(nextFinancialYear(financialYearOf(today)));
  return start !== null && limit !== null && start >= 2000 && start <= limit;
}

/** The selected FY for this request, or the current FY when none (or an invalid one) is stored. */
export async function getSelectedFy(): Promise<FinancialYear> {
  const today = todayIST();
  try {
    const value = (await cookies()).get(FY_COOKIE)?.value;
    if (isSelectableFy(value, today)) return value;
  } catch {
    // Outside a request (a job or a test): the current FY.
  }
  return financialYearOf(today);
}

/** The current FY in IST, for marking "(current)" beside it. */
export function currentFy(): FinancialYear {
  return financialYearOf(todayIST());
}
