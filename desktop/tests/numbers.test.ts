import { describe, expect, it } from "vitest";
import { defaultNumberId, firstToLink, mayUseNumber, numbersForPanel } from "../src/main/numbers";
import type { DesktopContext, DesktopUser, FirmNumber } from "../src/shared/types";
import { NUMBERS } from "./helpers";

const ALL = Object.values(NUMBERS);
const vinay: DesktopUser = { id: "u-vinay", employeeId: "e-vinay", name: "CA Vinay", role: "partner" };
const asha: DesktopUser = { id: "u-asha", employeeId: "e-asha", name: "CA Asha", role: "partner" };
const manager: DesktopUser = { id: "u-m1", employeeId: "e-m1", name: "Manager 1", role: "manager" };
const employee: DesktopUser = { id: "u-e2", employeeId: "e-e2", name: "Employee 2", role: "employee" };

function ctx(user: DesktopUser, numbers: FirmNumber[] = ALL): DesktopContext {
  return { user, clientMode: true, employeeNotifications: false, numbers, allowedGroups: user.role === "employee" ? [] : null };
}

const ids = (list: FirmNumber[]) => list.map((n) => n.id);
const everywhere = new Set(ALL.map((n) => n.id));

describe("which numbers each role may use (§7.25.4)", () => {
  it("Employees: Staff office only", () => {
    expect(ALL.filter((n) => mayUseNumber(employee, n)).map((n) => n.id)).toEqual(["n-staff"]);
  });

  it("Managers: Managers' office, plus Staff office (usable_by includes manager by default)", () => {
    expect(ALL.filter((n) => mayUseNumber(manager, n)).map((n) => n.id).sort()).toEqual(["n-managers", "n-staff"]);
  });

  it("Managers lose Staff office if a Partner removes manager from its usable_by", () => {
    const staff = { ...NUMBERS.staff!, usableBy: ["partner", "employee"] as FirmNumber["usableBy"] };
    expect(mayUseNumber(manager, staff)).toBe(false);
  });

  it("Partners: their own number plus numbers usable by Partners, never another Partner's", () => {
    expect(ALL.filter((n) => mayUseNumber(vinay, n)).map((n) => n.id).sort()).toEqual(["n-managers", "n-staff", "n-vinay"]);
    expect(ALL.filter((n) => mayUseNumber(asha, n)).map((n) => n.id).sort()).toEqual(["n-asha", "n-managers", "n-staff"]);
  });

  it("a Partner's own number never appears for anyone else, whatever its usable_by says", () => {
    const widened: FirmNumber = { ...NUMBERS.vinay!, usableBy: ["partner", "manager", "employee"] };
    expect(mayUseNumber(asha, widened)).toBe(false);
    expect(mayUseNumber(manager, widened)).toBe(false);
    expect(mayUseNumber(employee, widened)).toBe(false);
    expect(mayUseNumber(vinay, widened)).toBe(true);
    // An owner set on a number of another kind still makes it that Partner's alone.
    const owned: FirmNumber = { ...NUMBERS.staff!, id: "n-x", kind: "other", ownerEmployeeId: "e-vinay" };
    expect(mayUseNumber(employee, owned)).toBe(false);
    expect(mayUseNumber(vinay, owned)).toBe(true);
  });

  it("a Partner without an employee record gets no Partner number", () => {
    expect(mayUseNumber({ ...vinay, employeeId: null }, NUMBERS.vinay!)).toBe(false);
  });

  it("client users get nothing", () => {
    const client: DesktopUser = { id: "u-c", employeeId: null, name: "Client", role: "client" };
    expect(ALL.some((n) => mayUseNumber(client, { ...n, usableBy: ["client"] }))).toBe(false);
  });
});

describe("what the panel shows on this PC", () => {
  it("only numbers the user may use AND that are linked here", () => {
    const linkedHere = new Set(["n-staff", "n-vinay"]);
    const r = numbersForPanel(ctx(manager), linkedHere);
    expect(ids(r.visible)).toEqual(["n-staff"]);
    expect(ids(r.linkable)).toEqual(["n-managers"]);
  });

  it("Partner's own number only on their own PC (where it is linked), never for others on that PC", () => {
    const vinaysPc = new Set(["n-vinay", "n-managers"]);
    expect(ids(numbersForPanel(ctx(vinay), vinaysPc).visible)).toEqual(["n-vinay", "n-managers"]);
    // Another Partner signs in on Vinay's PC: Vinay's number isn't even offered for linking.
    const forAsha = numbersForPanel(ctx(asha), vinaysPc);
    expect(ids(forAsha.visible)).toEqual(["n-managers"]);
    expect(ids(forAsha.linkable)).toEqual(["n-asha", "n-staff"]);
    // An Employee and a Manager on Vinay's PC.
    expect(ids(numbersForPanel(ctx(employee), vinaysPc).visible)).toEqual([]);
    expect(ids(numbersForPanel(ctx(manager), vinaysPc).visible)).toEqual(["n-managers"]);
    // On a front-desk PC where Vinay's number isn't linked, Vinay sees only office numbers.
    const frontDesk = new Set(["n-staff"]);
    expect(ids(numbersForPanel(ctx(vinay), frontDesk).visible)).toEqual(["n-staff"]);
  });

  it("Managers' office for Managers, Staff office for Employees, when linked", () => {
    expect(ids(numbersForPanel(ctx(manager), everywhere).visible)).toEqual(["n-managers", "n-staff"]);
    expect(ids(numbersForPanel(ctx(employee), everywhere).visible)).toEqual(["n-staff"]);
  });

  it("re-checks the server's list (defence in depth)", () => {
    // A server bug sends a Partner's number to an Employee: the panel still won't show it.
    expect(ids(numbersForPanel(ctx(employee, [NUMBERS.vinay!, NUMBERS.staff!]), everywhere).visible)).toEqual(["n-staff"]);
  });

  it("shows nothing before sign-in", () => {
    expect(numbersForPanel(null, everywhere)).toEqual({ visible: [], linkable: [] });
  });
});

describe("default number", () => {
  it("lands each role on the number it works from", () => {
    const all = ALL;
    expect(defaultNumberId(employee, all.filter((n) => mayUseNumber(employee, n)), null)).toBe("n-staff");
    expect(defaultNumberId(manager, all.filter((n) => mayUseNumber(manager, n)), null)).toBe("n-managers");
    expect(defaultNumberId(vinay, all.filter((n) => mayUseNumber(vinay, n)), null)).toBe("n-vinay");
  });

  it("keeps the last choice while it is still visible", () => {
    const visible = [NUMBERS.managers!, NUMBERS.staff!];
    expect(defaultNumberId(manager, visible, "n-staff")).toBe("n-staff");
    expect(defaultNumberId(manager, visible, "n-vinay")).toBe("n-managers");
    expect(defaultNumberId(manager, [], null)).toBeNull();
  });

  it("opens the QR screen by itself only for office numbers", () => {
    expect(firstToLink(vinay, [NUMBERS.vinay!, NUMBERS.staff!])?.id).toBe("n-staff");
    expect(firstToLink(vinay, [NUMBERS.vinay!])).toBeNull();
    expect(firstToLink(employee, [NUMBERS.staff!])?.id).toBe("n-staff");
  });
});
