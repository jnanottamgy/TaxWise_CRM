import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { draftKeyFor } from "@/components/clients/onboarding/types";

/**
 * Wave A review: the rules behind fixes that have no better home.
 *   - The onboarding wizard's draft on this device is per person (§0.1 rule 15).
 *   - Server actions never notify with `security_alert`: insert_notifications (0101) refuses it from a
 *     signed-in session (only the system raises one), so the notice would silently never arrive.
 */

describe("onboarding draft key (§0.1 rule 15)", () => {
  it("differs per person, so one user's draft is never offered to another on the same browser", () => {
    const a = draftKeyFor({ kind: "new" }, "11111111-1111-4111-8111-111111111111");
    const b = draftKeyFor({ kind: "new" }, "22222222-2222-4222-8222-222222222222");
    expect(a).not.toBe(b);
    expect(a).toContain("11111111-1111-4111-8111-111111111111");
  });

  it("keeps the source in the key", () => {
    const viewer = "11111111-1111-4111-8111-111111111111";
    expect(draftKeyFor({ kind: "quotation", id: "q1", number: "TW-Q-0001", leadId: null }, viewer)).toBe(`client-wizard:${viewer}:quotation:q1`);
    expect(draftKeyFor({ kind: "lead", id: "l1", number: null }, viewer)).toBe(`client-wizard:${viewer}:lead:l1`);
    expect(draftKeyFor({ kind: "new" }, null)).toBe("client-wizard:anyone:new");
  });
});

describe("notifications from server actions", () => {
  it("never use the security_alert type (the database refuses it from a session)", () => {
    const dir = join(process.cwd(), "server", "actions");
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => /type:\s*"security_alert"/.test(readFileSync(join(dir, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
