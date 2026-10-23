import { describe, expect, it } from "vitest";
import {
  CHECKLIST_STEP_IDS,
  DEFAULT_GROUP_NAME_FORMAT,
  GROUP_NAME_MAX,
  buildVCard,
  buildVCardFile,
  checklistProgress,
  checklistToJson,
  chooseOpenNumber,
  contactCardName,
  contactCards,
  contextNumbers,
  copyAllNumbersText,
  defaultSelectedContactIds,
  devicesReviewDue,
  escapeVCardText,
  firmNumberCardName,
  foldVCardLine,
  groupNameHasCode,
  groupReminderDue,
  inviteCodeFromLink,
  isDeviceKey,
  isDeviceStale,
  isoWeekKey,
  lastOpenedSentence,
  linkedLabel,
  memberTone,
  membersFromChecklist,
  nextOpenStep,
  normaliseInviteLink,
  numbersToAdd,
  parseChecklist,
  partnerShortName,
  renderGroupName,
  renderWelcomeMessage,
  secondaryGroupName,
  shortClientName,
  stampCreated,
  tickChecklist,
  validateGroupName,
  validateGroupNameFormat,
  vcfFileName,
  whatsappWindowFeatures,
  type ContactLike,
  type FirmNumberLike,
} from "@/lib/domain/whatsapp";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const ME = "33333333-3333-4333-8333-333333333333";

function n(over: Partial<FirmNumberLike> & Pick<FirmNumberLike, "id" | "label" | "kind">): FirmNumberLike {
  return {
    number: "919876500001",
    employee_id: null,
    in_every_client_group: true,
    group_admin: false,
    is_active: true,
    usable_by: ["partner"],
    ...over,
  };
}

const FIRM: FirmNumberLike[] = [
  n({ id: "num-staff", label: "Staff office", kind: "staff_office", number: "919876500005", usable_by: ["partner", "manager", "employee"] }),
  n({ id: "num-p1", label: "CA Vinay H Karlagere (Partner)", kind: "partner", number: "919876500001", employee_id: P1 }),
  n({ id: "num-p2", label: "Partner 2", kind: "partner", number: "919876500002", employee_id: P2 }),
  n({ id: "num-p3", label: "Partner 3", kind: "partner", number: null, is_active: false, employee_id: null }),
  n({ id: "num-mgr", label: "Managers' office", kind: "managers_office", number: "919876500004", group_admin: true, usable_by: ["partner", "manager"] }),
];

const CONTACTS: ContactLike[] = [
  { id: "c0000000-0000-4000-8000-000000000001", name: "Ramesh", role: "Director", whatsapp: "98450 12345", phone: null, is_primary: true },
  { id: "c0000000-0000-4000-8000-000000000002", name: "Suma Rao", role: "Accountant", whatsapp: null, phone: "+91 99000 11122", is_primary: false },
  { id: "c0000000-0000-4000-8000-000000000003", name: "Office", role: null, whatsapp: null, phone: "044 2345 6789", is_primary: false },
];

describe("group names (§7.25.2 step 1)", () => {
  it("renders the default format exactly as the spec's example", () => {
    expect(renderGroupName(DEFAULT_GROUP_NAME_FORMAT, { clientCode: "TW-C-0142", displayName: "XYZ Traders" })).toBe("TW · TW-C-0142 · XYZ Traders");
  });

  it("uses the short name: legal forms and M/s are dropped", () => {
    expect(shortClientName("XYZ Traders Private Limited")).toBe("XYZ Traders");
    expect(shortClientName("Sharma Exports Pvt. Ltd.")).toBe("Sharma Exports");
    expect(shortClientName("M/s Kaveri Foods (P) Ltd")).toBe("Kaveri Foods");
    expect(shortClientName("Gamma Advisors LLP")).toBe("Gamma Advisors");
    expect(shortClientName("Bharat Steel Limited")).toBe("Bharat Steel");
    expect(shortClientName("Ravi Kumar")).toBe("Ravi Kumar");
    expect(shortClientName("Limited")).toBe("Limited");
    expect(renderGroupName(DEFAULT_GROUP_NAME_FORMAT, { clientCode: "TW-C-0007", displayName: "XYZ Traders Private Limited" })).toBe("TW · TW-C-0007 · XYZ Traders");
  });

  it("supports {client_name} and falls back to the default for an invalid format", () => {
    expect(renderGroupName("{client_code} {client_name}", { clientCode: "TW-C-1", displayName: "XYZ Traders Pvt Ltd" })).toBe("TW-C-1 XYZ Traders Pvt Ltd");
    expect(renderGroupName("TW {short_name}", { clientCode: "TW-C-1", displayName: "XYZ" })).toBe("TW · TW-C-1 · XYZ");
  });

  it("never exceeds WhatsApp's limit and keeps the client code", () => {
    const long = "A".repeat(150);
    const name = renderGroupName(DEFAULT_GROUP_NAME_FORMAT, { clientCode: "TW-C-0142", displayName: long });
    expect(name.length).toBeLessThanOrEqual(GROUP_NAME_MAX);
    expect(name.startsWith("TW · TW-C-0142 · ")).toBe(true);
    expect(name.endsWith("…")).toBe(true);
  });

  it("validates formats: placeholders and the required client code", () => {
    expect(validateGroupNameFormat(DEFAULT_GROUP_NAME_FORMAT)).toEqual({ ok: true });
    expect(validateGroupNameFormat("TW · {short_name}")).toMatchObject({ ok: false, error: expect.stringContaining("{client_code}") });
    expect(validateGroupNameFormat("TW · {client_code} · {name}")).toMatchObject({ ok: false, error: expect.stringContaining("{name}") });
    expect(validateGroupNameFormat("TW · {client_code} } x")).toMatchObject({ ok: false });
    expect(validateGroupNameFormat("   ")).toMatchObject({ ok: false });
    expect(validateGroupNameFormat(`{client_code}${"x".repeat(90)}`)).toMatchObject({ ok: false });
  });

  it("checks typed names carry the code", () => {
    expect(groupNameHasCode("TW · tw-c-0142 · XYZ", "TW-C-0142")).toBe(true);
    expect(validateGroupName("XYZ Traders", "TW-C-0142")).toMatchObject({ ok: false, error: expect.stringContaining("TW-C-0142") });
    expect(validateGroupName("TW · TW-C-0142 · XYZ", "TW-C-0142")).toEqual({ ok: true });
    expect(secondaryGroupName("TW · TW-C-0142 · XYZ Traders", "Statutory audit FY 2025-26")).toBe("TW · TW-C-0142 · XYZ Traders · Statutory audit FY 2025-26");
    expect(secondaryGroupName("TW · TW-C-0142 · XYZ Traders", "  ")).toBe("TW · TW-C-0142 · XYZ Traders");
  });
});

describe("the setup checklist (§7.25.2)", () => {
  it("has the seven steps in order", () => {
    expect(CHECKLIST_STEP_IDS).toEqual(["group_name", "save_contacts", "add_numbers", "group_settings", "managers_admin", "welcome_message", "mark_created"]);
  });

  it("parses anything into seven stamps, and stores exactly seven keys", () => {
    const parsed = parseChecklist({ group_name: { done: true, by: P1, at: "2026-10-22T05:00:00.000Z" }, junk: { done: true }, save_contacts: "yes" });
    expect(parsed.steps.group_name).toEqual({ done: true, by: P1, at: "2026-10-22T05:00:00.000Z" });
    expect(parsed.steps.save_contacts.done).toBe(false);
    expect(parsed.contactIds).toBeNull();
    const json = checklistToJson(parsed);
    expect(Object.keys(json)).toEqual([...CHECKLIST_STEP_IDS]);
    expect(checklistProgress(json)).toEqual({ done: 1, total: 7 });
    expect(parseChecklist(null).steps.mark_created.done).toBe(false);
    expect(parseChecklist([1, 2]).contactIds).toBeNull();
  });

  it("stamps who and when; unticking clears the stamp; step 7 only through Mark created", () => {
    let s = parseChecklist({});
    s = tickChecklist(s, "group_name", true, P1, "2026-10-22T05:00:00.000Z");
    s = tickChecklist(s, "save_contacts", true, P2, "2026-10-22T05:10:00.000Z");
    expect(nextOpenStep(s)).toBe("add_numbers");
    s = tickChecklist(s, "save_contacts", false, P2, "2026-10-22T05:11:00.000Z");
    expect(s.steps.save_contacts).toEqual({ done: false, by: null, at: null });
    expect(() => tickChecklist(s, "mark_created", true, P1, "x")).toThrow();
    const done = CHECKLIST_STEP_IDS.slice(0, 6).reduce((acc, id) => tickChecklist(acc, id as never, true, P1, "2026-10-22T05:00:00.000Z"), s);
    expect(checklistProgress(done)).toEqual({ done: 6, total: 7 });
    expect(nextOpenStep(stampCreated(done, P1, "2026-10-22T06:00:00.000Z"))).toBeNull();
  });

  it("keeps the contacts ticked in step 3 on that step", () => {
    const s = { ...parseChecklist({}), contactIds: [CONTACTS[0].id] };
    const json = checklistToJson(s);
    expect(json.add_numbers.contact_ids).toEqual([CONTACTS[0].id]);
    expect(parseChecklist(json).contactIds).toEqual([CONTACTS[0].id]);
    expect(checklistProgress(json).total).toBe(7);
  });
});

describe("contact cards (§7.25.2 step 2)", () => {
  it("names client contacts and firm numbers as the spec says", () => {
    expect(contactCardName("XYZ Traders", { name: "Ramesh", role: "Director" })).toBe("XYZ Traders – Ramesh (Director)");
    expect(contactCardName("XYZ Traders", { name: "  Suma   Rao ", role: null })).toBe("XYZ Traders – Suma Rao");
    expect(firmNumberCardName({ kind: "partner", label: "CA Vinay H Karlagere (Partner)" })).toBe("TW Partner – CA Vinay");
    expect(firmNumberCardName({ kind: "partner", label: "Partner 2" }, "CA Anil Kumar")).toBe("TW Partner – CA Anil");
    expect(firmNumberCardName({ kind: "managers_office", label: "Managers' office" })).toBe("TW Managers' office");
    expect(firmNumberCardName({ kind: "staff_office", label: "Staff office" })).toBe("TW Staff office");
    expect(firmNumberCardName({ kind: "other", label: "Audit desk" })).toBe("TW Audit desk");
    expect(partnerShortName("Dr. Meera Iyer")).toBe("Dr Meera");
    expect(partnerShortName("Vinay Karlagere")).toBe("Vinay");
  });

  it("escapes and folds vCard text", () => {
    expect(escapeVCardText("A, B; C\\D\nE")).toBe("A\\, B\\; C\\\\D\\nE");
    const long = `FN:${"₹".repeat(40)}`;
    const folded = foldVCardLine(long);
    for (const line of folded.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(folded.split("\r\n").slice(1).every((l) => l.startsWith(" "))).toBe(true);
    expect(folded.replace(/\r\n /g, "")).toBe(long);
  });

  it("builds vCard 3.0 with CRLF endings", () => {
    const card = buildVCard({ fullName: "XYZ Traders – Ramesh (Director)", digits: "919845012345", org: "XYZ Traders" });
    expect(card).toBe(
      "BEGIN:VCARD\r\nVERSION:3.0\r\nN:;XYZ Traders – Ramesh (Director);;;\r\nFN:XYZ Traders – Ramesh (Director)\r\nORG:XYZ Traders\r\nTEL;TYPE=CELL:+919845012345\r\nEND:VCARD\r\n",
    );
    expect(() => buildVCard({ fullName: "x", digits: "123" })).toThrow();
    expect(buildVCardFile([{ fullName: "A", digits: "919845012345" }, { fullName: "B", digits: "919845012346" }]).match(/BEGIN:VCARD/g)).toHaveLength(2);
    expect(vcfFileName("TW-C-0142")).toBe("TW-C-0142-whatsapp-contacts.vcf");
    expect(vcfFileName("TW/C 01", "firm")).toBe("TW-C-01-firm-numbers.vcf");
  });
});

describe("numbers to add and members (§7.25.2 steps 3 and 7)", () => {
  it("defaults to the primary contact", () => {
    expect(defaultSelectedContactIds(CONTACTS)).toEqual([CONTACTS[0].id]);
    expect(defaultSelectedContactIds([{ ...CONTACTS[0], whatsapp: null, phone: null }])).toEqual([]);
  });

  it("lists every active firm number in every group, then the ticked contacts with usable numbers", () => {
    const list = numbersToAdd({
      firmNumbers: FIRM,
      contacts: CONTACTS,
      selectedContactIds: CONTACTS.map((c) => c.id),
      shortName: "XYZ Traders",
      ownerNames: new Map([[P2, "CA Anil Kumar"]]),
    });
    expect(list.map((x) => x.cardName)).toEqual([
      "TW Partner – CA Vinay",
      "TW Partner – CA Anil",
      "TW Managers' office",
      "TW Staff office",
      "XYZ Traders – Ramesh (Director)",
      "XYZ Traders – Suma Rao (Accountant)",
    ]);
    // the landline (044…) isn't on WhatsApp and is left out
    expect(list.find((x) => x.refId === CONTACTS[2].id)).toBeUndefined();
    expect(list.find((x) => x.refId === "num-mgr")?.isAdmin).toBe(true);
    expect(list[4].display).toBe("+91 98450 12345");
    expect(copyAllNumbersText(list).split("\n")).toHaveLength(6);
  });

  it("makes the creating number an admin, and lists a shared number once", () => {
    const members = membersFromChecklist({
      firmNumbers: FIRM,
      contacts: [{ ...CONTACTS[0], whatsapp: "+91 98765 00005" }],
      selectedContactIds: null,
      shortName: "XYZ Traders",
      createdByNumberId: "num-p1",
    });
    expect(members).toHaveLength(4);
    expect(members.filter((m) => m.is_admin).map((m) => m.firm_number_id).sort()).toEqual(["num-mgr", "num-p1"]);
    expect(members.every((m) => /^[1-9]\d{7,14}$/.test(m.number))).toBe(true);
    expect(members.find((m) => m.kind === "client_contact")).toBeUndefined();
  });

  it("fills six members for the acceptance test (three Partners, two office numbers, one contact)", () => {
    const firm = FIRM.map((f) => (f.id === "num-p3" ? { ...f, number: "919876500003", is_active: true, employee_id: ME } : f));
    const members = membersFromChecklist({ firmNumbers: firm, contacts: CONTACTS, selectedContactIds: null, shortName: "XYZ Traders" });
    expect(members).toHaveLength(6);
    expect(members.filter((m) => m.kind === "firm_number")).toHaveLength(5);
    expect(members.find((m) => m.kind === "client_contact")?.display_name).toBe("Ramesh (Director)");
  });

  it("turns the list into cards for the download", () => {
    const list = numbersToAdd({ firmNumbers: FIRM, contacts: CONTACTS, selectedContactIds: null, shortName: "XYZ Traders" });
    const cards = contactCards(list, { firmName: "TaxWise Consultants", clientName: "XYZ Traders" });
    expect(cards[0]).toMatchObject({ org: "TaxWise Consultants" });
    expect(cards.at(-1)).toMatchObject({ fullName: "XYZ Traders – Ramesh (Director)", org: "XYZ Traders" });
  });
});

describe("member chips (§7.25.1)", () => {
  it("colours by kind", () => {
    expect(memberTone({ kind: "firm_number", firmKind: "partner" })).toBe("partner");
    expect(memberTone({ kind: "firm_number", firmKind: "managers_office" })).toBe("managers");
    expect(memberTone({ kind: "firm_number", firmKind: "staff_office" })).toBe("staff");
    expect(memberTone({ kind: "client_contact" })).toBe("client");
    expect(memberTone({ kind: "other_person" })).toBe("other");
  });
});

describe("welcome message (§7.25.2 step 6, §16)", () => {
  it("renders the template with the firm and client", () => {
    const text = renderWelcomeMessage(null, { firmName: "TaxWise Consultants", clientName: "XYZ Traders", firmPhone: "+91 97405 40239" });
    expect(text).toBe(
      "Welcome to the TaxWise Consultants group for XYZ Traders. Our Partners, our Managers' desk and our team desk are all here, and our team sign their messages with their name. For anything urgent, please call +91 97405 40239.",
    );
    expect(renderWelcomeMessage("Hi {{client_name}} ({{client_code}})", { firmName: "T", clientName: "XYZ", clientCode: "TW-C-1", firmPhone: null })).toBe("Hi XYZ (TW-C-1)");
  });
});

describe("invite links", () => {
  it("extracts only the code", () => {
    expect(inviteCodeFromLink("https://chat.whatsapp.com/AbCdEf0123456789XyZ")).toBe("AbCdEf0123456789XyZ");
    expect(inviteCodeFromLink("chat.whatsapp.com/AbCdEf0123456789XyZ?x=1")).toBe("AbCdEf0123456789XyZ");
    expect(inviteCodeFromLink("https://evil.example/AbCdEf0123456789XyZ")).toBeNull();
    expect(inviteCodeFromLink("http://chat.whatsapp.com/AbCdEf0123456789XyZ")).toBeNull();
    expect(inviteCodeFromLink("https://chat.whatsapp.com/short")).toBeNull();
    expect(inviteCodeFromLink("https://u:p@chat.whatsapp.com/AbCdEf0123456789XyZ")).toBeNull();
    expect(inviteCodeFromLink(null)).toBeNull();
    expect(normaliseInviteLink(" AbCdEf0123456789XyZ ")).toBe("https://chat.whatsapp.com/AbCdEf0123456789XyZ");
    expect(normaliseInviteLink("chat.whatsapp.com/AbCdEf0123456789XyZ")).toBe("https://chat.whatsapp.com/AbCdEf0123456789XyZ");
    expect(normaliseInviteLink("not a link")).toBeNull();
  });
});

describe("TaxWise Desktop numbers (§7.25.4)", () => {
  it("gives each role its numbers; a Partner's own number only to its owner", () => {
    expect(contextNumbers(FIRM, "employee", ME).map((x) => x.id)).toEqual(["num-staff"]);
    expect(contextNumbers(FIRM, "manager", ME).map((x) => x.id)).toEqual(["num-mgr", "num-staff"]);
    expect(contextNumbers(FIRM, "partner", P1).map((x) => x.id)).toEqual(["num-p1", "num-mgr", "num-staff"]);
    expect(contextNumbers(FIRM, "partner", P2).map((x) => x.id)).toEqual(["num-p2", "num-mgr", "num-staff"]);
    expect(contextNumbers(FIRM, "client", null)).toEqual([]);
    // an owned number never reaches anyone else, whatever usable_by says
    const leaky = [n({ id: "num-x", label: "X", kind: "partner", employee_id: P1, usable_by: ["partner", "manager", "employee"] })];
    expect(contextNumbers(leaky, "manager", ME)).toEqual([]);
    expect(contextNumbers(leaky, "partner", P2)).toEqual([]);
    expect(contextNumbers(FIRM, "partner", P1)[0]).toEqual({ id: "num-p1", label: "CA Vinay H Karlagere (Partner)", kind: "partner", usableBy: ["partner"], ownerEmployeeId: P1 });
  });

  it("chooses the number Open chat uses", () => {
    const members = new Set(["num-p1", "num-mgr", "num-staff"]);
    expect(chooseOpenNumber("employee", ME, contextNumbers(FIRM, "employee", ME), members)).toBe("num-staff");
    expect(chooseOpenNumber("manager", ME, contextNumbers(FIRM, "manager", ME), members)).toBe("num-mgr");
    expect(chooseOpenNumber("partner", P1, contextNumbers(FIRM, "partner", P1), members)).toBe("num-p1");
    // Partner 2's number isn't in this group: the Managers' office
    expect(chooseOpenNumber("partner", P2, contextNumbers(FIRM, "partner", P2), members)).toBe("num-mgr");
    expect(chooseOpenNumber("employee", ME, [], members)).toBeNull();
    // a Manager without the Managers' office falls back to the Staff office
    const noMgr = contextNumbers(FIRM.filter((f) => f.kind !== "managers_office"), "manager", ME);
    expect(chooseOpenNumber("manager", ME, noMgr, members)).toBe("num-staff");
  });

  it("checks device keys and flags idle PCs", () => {
    expect(isDeviceKey("a".repeat(64))).toBe(true);
    expect(isDeviceKey("A".repeat(64))).toBe(false);
    expect(isDeviceKey("device-key-1")).toBe(false);
    const now = new Date("2026-10-23T06:00:00Z");
    expect(isDeviceStale({ last_seen_at: "2026-09-22T06:00:00Z" }, now)).toBe(true);
    expect(isDeviceStale({ last_seen_at: "2026-09-24T06:00:00Z" }, now)).toBe(false);
    expect(isDeviceStale({ last_seen_at: null, created_at: "2026-08-01T00:00:00Z" }, now)).toBe(true);
    expect(isDeviceStale({ last_seen_at: null }, now)).toBe(false);
    expect(linkedLabel("Staff office", 3, 4)).toBe("Staff office: 3 of 4");
  });
});

describe("the browser window and last opened (§7.25.8, §7.25.1)", () => {
  it("opens WhatsApp Web on the right half of the screen", () => {
    expect(whatsappWindowFeatures({ availWidth: 1366, availHeight: 728 })).toBe("popup,width=683,height=728,left=683,top=0");
  });

  it("says who opened the group and when", () => {
    const now = new Date("2026-10-23T10:00:00Z");
    expect(lastOpenedSentence("2026-10-23T08:00:00Z", "Anita Desai", now)).toBe("Last opened 2 hours ago by Anita");
    expect(lastOpenedSentence(null, null, now)).toBe("Not opened from the CRM yet");
  });
});

describe("weekly housekeeping (§8)", () => {
  it("keys weeks and reminders", () => {
    expect(isoWeekKey("2026-10-19")).toBe("2026-W43");
    expect(isoWeekKey("2026-10-25")).toBe("2026-W43");
    expect(isoWeekKey("2027-01-01")).toBe("2026-W53");
    expect(groupReminderDue("2026-10-21", "2026-10-23")).toBe(true);
    expect(groupReminderDue("2026-10-22", "2026-10-23")).toBe(false);
    expect(groupReminderDue(null, "2026-10-23")).toBe(false);
    const now = new Date("2026-10-23T06:00:00Z");
    expect(devicesReviewDue(null, now)).toBe(true);
    expect(devicesReviewDue("2026-10-20T06:00:00Z", now)).toBe(false);
    expect(devicesReviewDue("2026-10-15T06:00:00Z", now)).toBe(true);
  });
});
