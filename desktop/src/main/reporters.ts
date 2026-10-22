/**
 * Reports the main process sends to the CRM about client mode:
 * - access_denied: once per chat per day (§7.25.5);
 * - health: client mode can't run on this PC (selectors failed), at most once a day per number
 *   and set of failing selectors; the CRM itself notifies Partners at most once a day per PC.
 * A report that doesn't go through may be retried the same day.
 */

import { normalizeTitle } from "../shared/chat-rules";
import type { ApiResult, DesktopApi } from "./api";
import { OncePerDay } from "./once-a-day";

type Kind = ApiResult<unknown>["kind"];

export class ClientModeReporter {
  private readonly denied = new OncePerDay();
  private readonly health = new OncePerDay();

  constructor(
    private readonly api: Pick<DesktopApi, "accessDenied" | "health">,
    private readonly onAuth: (kind: Kind) => void = () => undefined,
  ) {}

  /** Returns true if a report was sent (not a repeat today). */
  async accessDenied(numberId: string, chatTitle: string, now: number): Promise<boolean> {
    const key = `${numberId}|${normalizeTitle(chatTitle)}`;
    if (!this.denied.shouldRun(key, now)) return false;
    const r = await this.api.accessDenied(numberId, chatTitle);
    if (r.kind !== "ok") this.denied.forget(key);
    this.onAuth(r.kind);
    return true;
  }

  async selectorsFailed(numberId: string, failing: readonly string[], now: number): Promise<boolean> {
    const list = [...failing].sort();
    const key = `${numberId}|${list.join(",")}`;
    if (!this.health.shouldRun(key, now)) return false;
    const r = await this.api.health(list);
    if (r.kind !== "ok") this.health.forget(key);
    this.onAuth(r.kind);
    return true;
  }
}
