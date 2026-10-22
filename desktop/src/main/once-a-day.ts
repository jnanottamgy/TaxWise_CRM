/**
 * "Once per chat per day" (access_denied, §7.25.5) and "at most once a day per PC" (health,
 * §7.25.1), counted in Indian Standard Time.
 */

import { istDay } from "../shared/chat-rules";

export class OncePerDay {
  private day = "";
  private readonly seen = new Set<string>();

  /** True the first time `key` is seen on an IST day. */
  shouldRun(key: string, now: number): boolean {
    const d = istDay(now);
    if (d !== this.day) {
      this.day = d;
      this.seen.clear();
    }
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  /** Allow `key` again today (e.g. the report failed to send). */
  forget(key: string): void {
    this.seen.delete(key);
  }
}
