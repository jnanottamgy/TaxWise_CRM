import { describe, expect, it } from "vitest";
import {
  buildClientAccessRows,
  canEndCover,
  canSeeClient,
  clientsCoveredBy,
  clientsOfEmployee,
  clientsReachedByPersonCover,
  COVER_DEFAULTS,
  coverBadge,
  coverQuickPicks,
  coverRecipientsFor,
  coverState,
  coversInForce,
  defaultAbsentEmployee,
  endOfDayIST,
  endsTomorrow,
  formatCoverUntil,
  isAbsentWithoutCover,
  isInForce,
  mergeCovers,
  needsExpiryLog,
  planCoverGrant,
  validateCover,
  validateExtension,
  windowsOverlap,
  type ClientAccessRow,
  type CoverRecord,
  type CoverValidationInput,
} from "@/lib/domain/cover";

const ist = (local: string) => new Date(`${local}+05:30`);
// Thursday 22 Oct 2026, 10:00 IST.
const NOW = ist("2026-10-22T10:00:00");
const FRI_END = ist("2026-10-23T23:59:00");

const E2 = "emp-2";
const E3 = "emp-3";
const E4 = "emp-4";
const XYZ = "client-xyz";
const ABC = "client-abc";
const NEW = "client-new";

function cover(over: Partial<CoverRecord> = {}): CoverRecord {
  return {
    id: "cov-1",
    kind: "client",
    clientId: XYZ,
    absentEmployeeId: E3,
    coverEmployeeId: E2,
    startsAt: NOW,
    endsAt: FRI_END,
    revokedAt: null,
    ...over,
  };
}

describe("isInForce (§4.7, covers_in_force)", () => {
  it("is in force from starts_at (inclusive) until ends_at (exclusive)", () => {
    const c = cover();
    expect(isInForce(c, new Date(NOW.getTime() - 1))).toBe(false);
    expect(isInForce(c, NOW)).toBe(true);
    expect(isInForce(c, ist("2026-10-23T23:58:59"))).toBe(true);
    expect(isInForce(c, FRI_END)).toBe(false);
    expect(isInForce(c, ist("2026-10-24T00:00:00"))).toBe(false);
  });

  it("is never in force once revoked", () => {
    expect(isInForce(cover({ revokedAt: ist("2026-10-22T12:00:00") }), ist("2026-10-22T11:00:00"))).toBe(false);
    expect(isInForce(cover({ revokedAt: "2026-10-22T06:30:00Z" }), NOW)).toBe(false);
  });

  it("accepts ISO strings as Postgres returns them", () => {
    expect(isInForce(cover({ startsAt: "2026-10-22T04:30:00Z", endsAt: "2026-10-23T18:29:00Z" }), "2026-10-23T10:00:00Z")).toBe(true);
  });

  it("names the cover's state", () => {
    expect(coverState(cover(), ist("2026-10-22T09:00:00"))).toBe("scheduled");
    expect(coverState(cover(), NOW)).toBe("in_force");
    expect(coverState(cover(), FRI_END)).toBe("ended");
    expect(coverState(cover({ revokedAt: NOW }), NOW)).toBe("revoked");
    expect(coversInForce([cover(), cover({ id: "x", revokedAt: NOW })], NOW).map((c) => c.id)).toEqual(["cov-1"]);
  });

  it("flags the automatic end for the hourly job once, and 'ends tomorrow' for the granter", () => {
    expect(needsExpiryLog(cover(), ist("2026-10-24T01:00:00"))).toBe(true);
    expect(needsExpiryLog(cover({ expiryLoggedAt: ist("2026-10-24T00:05:00") }), ist("2026-10-24T01:00:00"))).toBe(false);
    expect(needsExpiryLog(cover(), NOW)).toBe(false);
    expect(needsExpiryLog(cover({ revokedAt: NOW }), ist("2026-10-24T01:00:00"))).toBe(false);
    expect(endsTomorrow(cover(), NOW)).toBe(true);
    expect(endsTomorrow(cover(), ist("2026-10-23T08:00:00"))).toBe(false);
    expect(endsTomorrow(cover({ revokedAt: NOW }), NOW)).toBe(false);
  });
});

describe("the spec's example (§4.7): Employee 2 covers XYZ Traders for Employee 3 until Friday", () => {
  const teams = [{ clientId: XYZ, employeeId: E3 }];
  const xyz = { id: XYZ, ownerEmployeeId: "emp-9", portalUserId: null };
  const covers = [cover()];
  const emp = (id: string) => ({ role: "employee" as const, isActive: true, employeeId: id });

  it("Employee 2 can open XYZ Traders straight away; Employee 4 still can't", () => {
    expect(canSeeClient(emp(E2), xyz, teams, covers, NOW)).toBe(true);
    expect(canSeeClient(emp(E4), xyz, teams, covers, NOW)).toBe(false);
    expect(canSeeClient(emp(E3), xyz, teams, covers, NOW)).toBe(true);
  });

  it("on Friday night Employee 2 can't either", () => {
    expect(canSeeClient(emp(E2), xyz, teams, covers, ist("2026-10-23T23:58:00"))).toBe(true);
    expect(canSeeClient(emp(E2), xyz, teams, covers, ist("2026-10-24T00:00:00"))).toBe(false);
  });
});

describe("canSeeClient mirrors can_see_client (§4.6)", () => {
  const teams = [
    { clientId: ABC, employeeId: E3 },
    { clientId: XYZ, employeeId: "emp-7" },
  ];
  const abc = { id: ABC, ownerEmployeeId: "emp-8" };
  const xyz = { id: XYZ, ownerEmployeeId: E3, portalUserId: "portal-user-xyz" };

  it("Partners and Managers see every client; a disabled or role-less profile sees none", () => {
    expect(canSeeClient({ role: "partner", isActive: true }, abc, [], [], NOW)).toBe(true);
    expect(canSeeClient({ role: "manager", isActive: true }, abc, [], [], NOW)).toBe(true);
    expect(canSeeClient({ role: "partner", isActive: false }, abc, [], [], NOW)).toBe(false);
    expect(canSeeClient({ role: null, isActive: true, employeeId: "emp-8" }, abc, [], [], NOW)).toBe(false);
  });

  it("an Employee sees clients they own or are on the team of", () => {
    expect(canSeeClient({ role: "employee", isActive: true, employeeId: "emp-8" }, abc, teams, [], NOW)).toBe(true);
    expect(canSeeClient({ role: "employee", isActive: true, employeeId: E3 }, abc, teams, [], NOW)).toBe(true);
    expect(canSeeClient({ role: "employee", isActive: true, employeeId: E4 }, abc, teams, [], NOW)).toBe(false);
    expect(canSeeClient({ role: "employee", isActive: true, employeeId: null }, abc, teams, [], NOW)).toBe(false);
  });

  it("a person cover reaches clients the absent person owns AND those they're on the team of", () => {
    const person = cover({ kind: "person", clientId: null, absentEmployeeId: E3, coverEmployeeId: E2 });
    const e2 = { role: "employee" as const, isActive: true, employeeId: E2 };
    expect(canSeeClient(e2, xyz, teams, [person], NOW)).toBe(true); // E3 owns XYZ
    expect(canSeeClient(e2, abc, teams, [person], NOW)).toBe(true); // E3 is on ABC's team
    expect(canSeeClient(e2, { id: NEW, ownerEmployeeId: "emp-8" }, teams, [person], NOW)).toBe(false);
    expect(canSeeClient(e2, xyz, teams, [person], ist("2026-10-24T00:00:00"))).toBe(false);
  });

  it("a cover held by someone else gives nothing", () => {
    const c = cover({ clientId: ABC, coverEmployeeId: E4 });
    expect(canSeeClient({ role: "employee", isActive: true, employeeId: E2 }, abc, teams, [c], NOW)).toBe(false);
  });

  it("a soft-deleted client is visible to Partners and Managers only (recycle bin, §4.1)", () => {
    const deleted = { ...xyz, deletedAt: "2026-10-21T10:00:00Z" };
    const person = { kind: "person" as const, clientId: null, absentEmployeeId: E3, coverEmployeeId: E2, startsAt: ist("2026-10-22T09:00:00"), endsAt: ist("2026-10-24T00:00:00") };
    expect(canSeeClient({ role: "partner", isActive: true }, deleted, teams, [], NOW)).toBe(true);
    expect(canSeeClient({ role: "manager", isActive: true }, deleted, teams, [], NOW)).toBe(true);
    expect(canSeeClient({ role: "employee", isActive: true, employeeId: E3 }, deleted, teams, [], NOW)).toBe(false);
    expect(canSeeClient({ role: "employee", isActive: true, employeeId: E2 }, deleted, teams, [person], NOW)).toBe(false);
    expect(canSeeClient({ role: "client", isActive: true, userId: "portal-user-xyz" }, deleted, [], [], NOW)).toBe(false);
    expect(canSeeClient({ role: "employee", isActive: true, employeeId: E3 }, { ...xyz, deletedAt: null }, teams, [], NOW)).toBe(true);
  });

  it("a client sees only their own client record (portal_user_id)", () => {
    expect(canSeeClient({ role: "client", isActive: true, userId: "portal-user-xyz" }, xyz, [], [], NOW)).toBe(true);
    expect(canSeeClient({ role: "client", isActive: true, userId: "portal-user-xyz" }, abc, [], [], NOW)).toBe(false);
    expect(canSeeClient({ role: "client", isActive: true, userId: null }, { id: NEW, ownerEmployeeId: null, portalUserId: null }, [], [], NOW)).toBe(false);
  });
});

describe("which clients a person cover reaches (§4.7)", () => {
  const rows: ClientAccessRow[] = buildClientAccessRows(
    [
      { id: XYZ, ownerEmployeeId: E3 },
      { id: ABC, ownerEmployeeId: "emp-8" },
      { id: "client-other", ownerEmployeeId: "emp-8" },
    ],
    [
      { clientId: ABC, employeeId: E3 },
      { clientId: ABC, employeeId: E3 }, // duplicate role rows collapse
      { clientId: "client-other", employeeId: E4 },
    ],
  );
  const person = cover({ kind: "person", clientId: null, absentEmployeeId: E3, coverEmployeeId: E2, endsAt: ist("2026-10-25T23:59:00") });

  it("reaches every client the absent person owns or is on the team of", () => {
    expect(rows.find((r) => r.clientId === ABC)?.teamEmployeeIds).toEqual([E3]);
    expect(clientsReachedByPersonCover(person, rows, NOW)).toEqual([XYZ, ABC]);
    expect(clientsOfEmployee(E3, rows)).toEqual([XYZ, ABC]);
  });

  it("includes clients assigned to the absent person during the cover", () => {
    const later = ist("2026-10-24T11:00:00");
    const assignedDuring = [...rows, { clientId: NEW, ownerEmployeeId: E3, teamEmployeeIds: [] }];
    expect(clientsReachedByPersonCover(person, assignedDuring, later)).toEqual([XYZ, ABC, NEW]);
    expect(canSeeClient({ role: "employee", isActive: true, employeeId: E2 }, { id: NEW, ownerEmployeeId: E3 }, [], [person], later)).toBe(true);
  });

  it("reaches nothing when not in force, or for a client cover", () => {
    expect(clientsReachedByPersonCover(person, rows, ist("2026-10-26T00:00:00"))).toEqual([]);
    expect(clientsReachedByPersonCover({ ...person, revokedAt: NOW }, rows, NOW)).toEqual([]);
    expect(clientsReachedByPersonCover(cover(), rows, NOW)).toEqual([]);
  });

  it("lists everything a cover person reaches through covers in force", () => {
    const clientCover = cover({ id: "c2", clientId: "client-other", absentEmployeeId: E4 });
    expect(clientsCoveredBy(E2, [person, clientCover], rows, NOW)).toEqual([XYZ, ABC, "client-other"]);
    expect(clientsCoveredBy(E4, [person, clientCover], rows, NOW)).toEqual([]);
  });

  it("copies notifications meant for the absent person to the cover person (§9)", () => {
    const xyzRow = rows[0];
    expect(coverRecipientsFor([E3], xyzRow, [person], NOW)).toEqual([E2]);
    expect(coverRecipientsFor([E3, E2], xyzRow, [person], NOW)).toEqual([]);
    expect(coverRecipientsFor(["emp-8"], xyzRow, [person], NOW)).toEqual([]);
    expect(coverRecipientsFor([E3], xyzRow, [person], ist("2026-10-26T00:00:00"))).toEqual([]);
    // A client cover with nobody named stands in for the client's owner.
    expect(coverRecipientsFor([E3], xyzRow, [cover({ absentEmployeeId: null })], NOW)).toEqual([E2]);
    expect(defaultAbsentEmployee(E3)).toBe(E3);
  });
});

describe("validateCover (§4.7, §5.13 checks)", () => {
  function v(over: Partial<CoverValidationInput["draft"]> = {}, rest: Partial<Omit<CoverValidationInput, "draft">> = {}) {
    return validateCover({
      draft: { kind: "client", clientId: XYZ, absentEmployeeId: E3, coverEmployeeId: E2, startsAt: NOW, endsAt: FRI_END, includeVault: false, ...over },
      actorRole: "manager",
      coverPerson: { isActive: true },
      absentPerson: { isActive: true },
      now: NOW,
      ...rest,
    });
  }

  it("accepts a valid client cover and a valid person cover", () => {
    expect(v()).toEqual({ ok: true, warnings: [] });
    expect(v({ kind: "person", clientId: null })).toEqual({ ok: true, warnings: [] });
  });

  it("only Partners and Managers grant; only a Partner includes portal passwords", () => {
    expect(v({}, { actorRole: "employee" })).toMatchObject({ ok: false, error: "Only Partners and Managers can grant cover." });
    expect(v({ includeVault: true })).toMatchObject({ ok: false, fieldErrors: { include_vault: ["Only a Partner can include portal passwords."] } });
    expect(v({ includeVault: true }, { actorRole: "partner" })).toEqual({ ok: true, warnings: [] });
  });

  it("no covering yourself", () => {
    expect(v({ coverEmployeeId: E3 })).toMatchObject({ ok: false, error: "Nobody can cover for themselves." });
  });

  it("no cover for or by a disabled person", () => {
    expect(v({}, { coverPerson: { isActive: false } })).toMatchObject({ ok: false, fieldErrors: { cover_employee_id: ["That person's account is disabled, so they can't cover."] } });
    expect(v({}, { absentPerson: { isActive: false } })).toMatchObject({ ok: false, fieldErrors: { absent_employee_id: [expect.stringContaining("disabled")] } });
    expect(v({ coverEmployeeId: null })).toMatchObject({ ok: false, fieldErrors: { cover_employee_id: ["Choose who covers."] } });
  });

  it("a person cover needs the absent person (and no client); a client cover needs the client", () => {
    expect(v({ kind: "person", clientId: null, absentEmployeeId: null })).toMatchObject({ ok: false, fieldErrors: { absent_employee_id: [expect.any(String)] } });
    expect(v({ kind: "person", clientId: XYZ })).toMatchObject({ ok: false, fieldErrors: { client_id: [expect.any(String)] } });
    expect(v({ kind: "client", clientId: null })).toMatchObject({ ok: false, fieldErrors: { client_id: ["Choose the client."] } });
  });

  it("Until must be after From", () => {
    expect(v({ endsAt: NOW })).toMatchObject({ ok: false, fieldErrors: { ends_at: ["The cover must end after it starts."] } });
    expect(v({ endsAt: ist("2026-10-22T09:00:00") })).toMatchObject({ ok: false, fieldErrors: { ends_at: ["The cover must end after it starts."] } });
  });

  it("caps a cover at 90 days", () => {
    const ninety = new Date(NOW.getTime() + 90 * 86_400_000);
    expect(COVER_DEFAULTS.maxDays).toBe(90);
    expect(v({ endsAt: ninety })).toEqual({ ok: true, warnings: [] });
    expect(v({ endsAt: new Date(ninety.getTime() + 60_000) })).toMatchObject({ ok: false, fieldErrors: { ends_at: ["A cover can last at most 90 days."] } });
  });

  it("From can't be in the past (a few minutes' grace for the form's 'now' default)", () => {
    expect(v({ startsAt: new Date(NOW.getTime() - 4 * 60_000) })).toEqual({ ok: true, warnings: [] });
    expect(v({ startsAt: ist("2026-10-22T09:00:00") })).toMatchObject({ ok: false, fieldErrors: { starts_at: ["The cover can't start in the past."] } });
    expect(v({ startsAt: null })).toMatchObject({ ok: false, fieldErrors: { starts_at: [expect.any(String)] } });
  });

  it("warns when the cover person is on leave during the window", () => {
    const r = v({}, { coverPerson: { isActive: true, leaves: [{ start: "2026-10-23", end: "2026-10-27", status: "approved" }] } });
    expect(r).toEqual({ ok: true, warnings: ["The cover person is on leave during this window (23 Oct to 27 Oct)."] });
    expect(v({}, { coverPerson: { isActive: true, leaves: [{ start: "2026-10-23", end: "2026-10-27", status: "requested" }] } }).warnings).toEqual([]);
    expect(v({}, { coverPerson: { isActive: true, leaves: [{ start: "2026-10-24", end: "2026-10-27" }] } }).warnings).toEqual([]);
  });
});

describe("extending and ending (§4.7)", () => {
  it("extends a live cover to a later Until within 90 days of its From", () => {
    expect(validateExtension({ cover: cover(), newEndsAt: ist("2026-10-25T23:59:00"), actorRole: "manager", now: NOW })).toEqual({ ok: true });
    expect(validateExtension({ cover: cover(), newEndsAt: ist("2026-10-25T23:59:00"), actorRole: "employee", now: NOW })).toMatchObject({ ok: false });
    expect(validateExtension({ cover: cover(), newEndsAt: ist("2026-10-23T10:00:00"), actorRole: "partner", now: NOW })).toMatchObject({ ok: false, error: "Choose an end later than the current one." });
    expect(validateExtension({ cover: cover(), newEndsAt: new Date(NOW.getTime() + 91 * 86_400_000), actorRole: "partner", now: NOW })).toMatchObject({ ok: false });
    expect(validateExtension({ cover: cover(), newEndsAt: ist("2026-10-30T23:59:00"), actorRole: "partner", now: ist("2026-10-24T01:00:00") })).toMatchObject({ ok: false, error: "This cover has ended. Add a new cover instead." });
    expect(validateExtension({ cover: cover({ revokedAt: NOW }), newEndsAt: ist("2026-10-30T23:59:00"), actorRole: "partner", now: NOW })).toMatchObject({ ok: false });
  });

  it("End now: Partners, Managers, or the absent person ('I'm back, end cover')", () => {
    expect(canEndCover({ cover: cover(), actorRole: "manager", actorEmployeeId: "mgr", now: NOW })).toEqual({ ok: true });
    expect(canEndCover({ cover: cover(), actorRole: "employee", actorEmployeeId: E3, now: NOW })).toEqual({ ok: true });
    expect(canEndCover({ cover: cover(), actorRole: "employee", actorEmployeeId: E2, now: NOW })).toMatchObject({ ok: false });
    expect(canEndCover({ cover: cover(), actorRole: "partner", actorEmployeeId: "p", now: ist("2026-10-24T01:00:00") })).toMatchObject({ ok: false, error: "This cover has already ended." });
  });
});

describe("merging overlapping covers (§4.7)", () => {
  const c = (id: string, start: string, end: string, over: Partial<CoverRecord> = {}): CoverRecord => cover({ id, startsAt: ist(start), endsAt: ist(end), ...over });

  it("merges overlapping covers for the same client and cover person; the later end wins", () => {
    const merged = mergeCovers([c("a", "2026-10-22T10:00:00", "2026-10-24T23:59:00"), c("b", "2026-10-23T09:00:00", "2026-10-27T23:59:00")]);
    expect(merged).toHaveLength(1);
    expect(merged[0].startsAt).toEqual(ist("2026-10-22T10:00:00"));
    expect(merged[0].endsAt).toEqual(ist("2026-10-27T23:59:00"));
    expect(merged[0].members.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("keeps the longer end when the later cover ends sooner", () => {
    const merged = mergeCovers([c("a", "2026-10-22T10:00:00", "2026-10-30T23:59:00"), c("b", "2026-10-23T09:00:00", "2026-10-24T23:59:00")]);
    expect(merged).toHaveLength(1);
    expect(merged[0].endsAt).toEqual(ist("2026-10-30T23:59:00"));
  });

  it("merges person covers for the same absent person and cover person", () => {
    const p = { kind: "person" as const, clientId: null };
    const merged = mergeCovers([c("a", "2026-10-22T10:00:00", "2026-10-24T23:59:00", p), c("b", "2026-10-24T09:00:00", "2026-10-26T23:59:00", p)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].kind).toBe("person");
  });

  it("doesn't merge different cover people, different clients, kinds, gaps or touching windows", () => {
    expect(mergeCovers([c("a", "2026-10-22T10:00:00", "2026-10-24T23:59:00"), c("b", "2026-10-23T09:00:00", "2026-10-27T23:59:00", { coverEmployeeId: E4 })])).toHaveLength(2);
    expect(mergeCovers([c("a", "2026-10-22T10:00:00", "2026-10-24T23:59:00"), c("b", "2026-10-23T09:00:00", "2026-10-27T23:59:00", { clientId: ABC })])).toHaveLength(2);
    expect(mergeCovers([c("a", "2026-10-22T10:00:00", "2026-10-24T23:59:00"), c("b", "2026-10-23T09:00:00", "2026-10-27T23:59:00", { kind: "person", clientId: null })])).toHaveLength(2);
    expect(mergeCovers([c("a", "2026-10-22T10:00:00", "2026-10-22T18:00:00"), c("b", "2026-10-23T09:00:00", "2026-10-23T18:00:00")])).toHaveLength(2);
    expect(windowsOverlap(c("a", "2026-10-22T10:00:00", "2026-10-23T09:00:00"), c("b", "2026-10-23T09:00:00", "2026-10-23T18:00:00"))).toBe(false);
  });

  it("chains several overlapping covers and leaves revoked ones out", () => {
    const merged = mergeCovers([
      c("c", "2026-10-25T09:00:00", "2026-10-28T23:59:00"),
      c("a", "2026-10-22T10:00:00", "2026-10-24T23:59:00"),
      c("b", "2026-10-24T09:00:00", "2026-10-25T23:59:00"),
      c("r", "2026-10-22T10:00:00", "2026-11-30T23:59:00", { revokedAt: NOW }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].members.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(merged[0].endsAt).toEqual(ist("2026-10-28T23:59:00"));
  });

  it("plans a grant: create, merge into the earliest (absorbing a bridged one), or refuse past 90 days", () => {
    const existing = [c("a", "2026-10-22T10:00:00", "2026-10-24T23:59:00"), c("b", "2026-10-26T09:00:00", "2026-10-28T23:59:00")];
    expect(planCoverGrant(c("n", "2026-10-29T09:00:00", "2026-10-30T23:59:00"), existing)).toEqual({ action: "create" });
    expect(planCoverGrant(c("n", "2026-10-23T09:00:00", "2026-10-25T23:59:00", { coverEmployeeId: E4 }), existing)).toEqual({ action: "create" });
    expect(planCoverGrant(c("n", "2026-10-23T09:00:00", "2026-10-25T23:59:00"), existing)).toEqual({
      action: "merge",
      keepId: "a",
      startsAt: ist("2026-10-22T10:00:00"),
      endsAt: ist("2026-10-25T23:59:00"),
      revokeIds: [],
    });
    // Bridging both: a is widened to the end of b, and b is absorbed.
    expect(planCoverGrant(c("n", "2026-10-24T09:00:00", "2026-10-27T23:59:00"), existing)).toEqual({
      action: "merge",
      keepId: "a",
      startsAt: ist("2026-10-22T10:00:00"),
      endsAt: ist("2026-10-28T23:59:00"),
      revokeIds: ["b"],
    });
    const long = [c("a", "2026-10-22T10:00:00", "2026-12-31T23:59:00")];
    expect(planCoverGrant(c("n", "2026-12-30T09:00:00", "2027-01-31T23:59:00"), long)).toMatchObject({ action: "refuse" });
    expect(planCoverGrant(c("n", "2026-10-23T09:00:00", "2026-10-25T23:59:00"), [c("a", "2026-10-22T10:00:00", "2026-10-24T23:59:00", { revokedAt: NOW })])).toEqual({ action: "create" });
  });
});

describe("Until quick picks (§4.7)", () => {
  const MON_SAT = [1, 2, 3, 4, 5, 6];

  it("end of today and tomorrow are 23:59 IST", () => {
    expect(endOfDayIST("2026-10-22")).toEqual(new Date("2026-10-22T18:29:00.000Z"));
    const picks = coverQuickPicks({ now: NOW, weekdays: MON_SAT });
    expect(picks.map((p) => [p.key, p.endsAt.toISOString()])).toEqual([
      ["end_of_today", "2026-10-22T18:29:00.000Z"],
      ["end_of_tomorrow", "2026-10-23T18:29:00.000Z"],
      ["end_of_week", "2026-10-24T18:29:00.000Z"],
    ]);
    expect(picks.map((p) => p.label)).toEqual(["End of today", "End of tomorrow", "End of this week"]);
  });

  it("end of this week is the week's last working day (Friday for a Mon–Fri firm; a duplicate pick is dropped)", () => {
    const picks = coverQuickPicks({ now: ist("2026-10-20T10:00:00"), weekdays: [1, 2, 3, 4, 5] });
    expect(picks.find((p) => p.key === "end_of_week")?.endsAt).toEqual(ist("2026-10-23T23:59:00"));
    const thursday = coverQuickPicks({ now: NOW, weekdays: [1, 2, 3, 4, 5] });
    expect(thursday.map((p) => p.key)).toEqual(["end_of_today", "end_of_tomorrow"]);
  });

  it("on a Sunday the week ends that day", () => {
    const picks = coverQuickPicks({ now: ist("2026-10-25T10:00:00"), weekdays: MON_SAT });
    expect(picks.map((p) => p.key)).toEqual(["end_of_today", "end_of_tomorrow"]);
  });

  it("until their leave ends: the leave in progress, else the next one", () => {
    const leaves = [
      { start: "2026-10-01", end: "2026-10-05", status: "approved" },
      { start: "2026-10-21", end: "2026-10-27", status: "approved" },
      { start: "2026-11-10", end: "2026-11-12", status: "approved" },
    ];
    const pick = coverQuickPicks({ now: NOW, weekdays: MON_SAT, absentLeaves: leaves }).find((p) => p.key === "until_leave_ends");
    expect(pick).toEqual({ key: "until_leave_ends", label: "Until their leave ends (27 Oct)", endsAt: ist("2026-10-27T23:59:00") });
    const next = coverQuickPicks({ now: NOW, weekdays: MON_SAT, absentLeaves: [leaves[2], { start: "2026-10-28", end: "2026-10-29", status: "requested" }] }).find((p) => p.key === "until_leave_ends");
    expect(next?.endsAt).toEqual(ist("2026-11-12T23:59:00"));
    expect(coverQuickPicks({ now: NOW, weekdays: MON_SAT, absentLeaves: [leaves[0]] }).some((p) => p.key === "until_leave_ends")).toBe(false);
  });

  it("leaves out picks already past", () => {
    const late = coverQuickPicks({ now: ist("2026-10-22T23:59:30"), weekdays: MON_SAT });
    expect(late.map((p) => p.key)).toEqual(["end_of_tomorrow", "end_of_week"]);
  });
});

describe("cover wording (§4.7)", () => {
  it("shows the badge with the IST end", () => {
    expect(formatCoverUntil(ist("2026-10-24T23:59:00"))).toBe("Sat 24 Oct, 11:59 pm");
    expect(formatCoverUntil(ist("2026-10-05T00:05:00"))).toBe("Mon 05 Oct, 12:05 am");
    expect(formatCoverUntil("2026-10-23T06:30:00Z")).toBe("Fri 23 Oct, 12:00 pm");
    expect(coverBadge("Ravi", ist("2026-10-24T23:59:00"))).toBe("Covering for Ravi · until Sat 24 Oct, 11:59 pm");
  });
});

describe("absent today without cover (§7.2, §8)", () => {
  const base = {
    now: ist("2026-10-22T10:30:00"),
    isWorkingDay: true,
    onLeaveToday: false,
    signedInAt: null,
    workDayStart: "09:30",
    lateGraceMinutes: 15,
    hasTasksDueSoon: true,
    hasCoverInForce: false,
  };

  it("lists people on leave, or not signed in by start + grace + 30 minutes, whose clients have work due", () => {
    expect(isAbsentWithoutCover(base)).toBe(true); // 10:30 > 10:15
    expect(isAbsentWithoutCover({ ...base, now: ist("2026-10-22T10:15:00") })).toBe(false);
    expect(isAbsentWithoutCover({ ...base, now: ist("2026-10-22T10:16:00") })).toBe(true);
    expect(isAbsentWithoutCover({ ...base, now: ist("2026-10-22T08:00:00"), onLeaveToday: true })).toBe(true);
  });

  it("skips people who signed in, have cover, have nothing due, or on a non-working day", () => {
    expect(isAbsentWithoutCover({ ...base, signedInAt: ist("2026-10-22T10:20:00") })).toBe(false);
    expect(isAbsentWithoutCover({ ...base, hasCoverInForce: true })).toBe(false);
    expect(isAbsentWithoutCover({ ...base, hasTasksDueSoon: false })).toBe(false);
    expect(isAbsentWithoutCover({ ...base, isWorkingDay: false })).toBe(false);
    expect(COVER_DEFAULTS.tasksDueWithinDays).toBe(2);
  });
});
