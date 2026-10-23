import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("server-only", () => ({}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => "/whatsapp-groups",
  useSearchParams: () => new URLSearchParams(),
  useSelectedLayoutSegment: () => "whatsapp",
}));
vi.mock("@/server/actions/whatsapp-groups", () => {
  const fn = () => vi.fn(async () => ({ ok: true, data: {} }));
  return {
    startWhatsAppGroup: fn(),
    updateWhatsAppGroup: fn(),
    tickWhatsAppStep: fn(),
    saveWhatsAppContacts: fn(),
    markWhatsAppGroupCreated: fn(),
    closeWhatsAppGroup: fn(),
    setPrimaryWhatsAppGroup: fn(),
    openWhatsAppChat: fn(),
    revealWhatsAppInviteLink: fn(),
    saveWhatsAppInviteLink: fn(),
    addWhatsAppMember: fn(),
    updateWhatsAppMember: fn(),
    removeNumberFromGroups: fn(),
    searchWhatsAppFileClients: fn(),
  };
});
vi.mock("@/server/actions/whatsapp-settings", () => ({ saveWhatsAppSettings: vi.fn(), saveFirmWhatsAppNumber: vi.fn(), recordWhatsAppDevicesReview: vi.fn() }));
vi.mock("@/server/actions/desktop-devices", () => ({ removeDesktopPc: vi.fn(), renameDesktopPc: vi.fn() }));

import { GroupCard, type GroupCardGroup } from "@/components/whatsapp/group-card";
import { RegisterTable } from "@/components/whatsapp/register-table";
import { NumbersCard } from "@/components/settings/whatsapp/numbers-card";
import { LinkedPcsCard } from "@/components/settings/whatsapp/linked-pcs-card";
import { WhatsAppGeneralSummary } from "@/components/settings/whatsapp/general-summary";
import { checklistProgress, parseChecklist } from "@/lib/domain/whatsapp";
import type { FirmNumberRow, RegisterRow } from "@/lib/data/whatsapp";

/** Server render of the WhatsApp screens' parts: they render without throwing and say the spec's words. */

const P1 = "11111111-1111-4111-8111-111111111111";
const ME = "99999999-9999-4999-8999-999999999999";

function num(over: Partial<FirmNumberRow> & Pick<FirmNumberRow, "id" | "label" | "kind">): FirmNumberRow {
  return {
    number: "919876500001",
    employee_id: null,
    custodian_employee_id: null,
    in_every_client_group: true,
    group_admin: false,
    shared: false,
    usable_by: ["partner"],
    two_step_verification_on: true,
    devices_reviewed_at: null,
    is_active: true,
    updated_at: "2026-10-22T05:00:00Z",
    owner_name: null,
    custodian_name: null,
    ...over,
  };
}

const NUMBERS: FirmNumberRow[] = [
  num({ id: "n-p1", label: "CA Vinay H Karlagere (Partner)", kind: "partner", employee_id: P1, owner_name: "CA Vinay H Karlagere" }),
  num({ id: "n-mgr", label: "Managers' office", kind: "managers_office", number: "919876500004", group_admin: true, shared: true, usable_by: ["partner", "manager"], custodian_employee_id: ME, custodian_name: "Anita Desai" }),
  num({ id: "n-staff", label: "Staff office", kind: "staff_office", number: "919876500005", shared: true, usable_by: ["partner", "manager", "employee"] }),
  num({ id: "n-p3", label: "Partner 3", kind: "partner", number: null, is_active: false }),
];

const CONTACTS = [{ id: "c0000000-0000-4000-8000-000000000001", name: "Ramesh", role: "Director", whatsapp: "98450 12345", phone: null, is_primary: true }];

function group(over: Partial<GroupCardGroup> = {}): GroupCardGroup {
  const checklist = parseChecklist({ group_name: { done: true, by: ME, at: "2026-10-22T05:00:00.000Z" } });
  return {
    id: "g0000000-0000-4000-8000-000000000001",
    name: "TW · TW-C-0142 · XYZ Traders",
    purpose: "All work",
    is_primary: true,
    status: "to_create",
    created_on: null,
    created_by_label: null,
    checklist,
    progress: checklistProgress(checklist),
    last_opened_at: null,
    last_opened_by_name: null,
    closed_at: null,
    closed_reason: null,
    notes: null,
    updated_at: "2026-10-22T05:00:00Z",
    has_invite_link: false,
    members: [],
    former: [],
    ...over,
  };
}

const card = (g: GroupCardGroup, canManage = true) =>
  renderToStaticMarkup(
    React.createElement(GroupCard, {
      clientId: "client-1",
      clientCode: "TW-C-0142",
      group: g,
      canManage,
      browserAllowed: true,
      viewerId: ME,
      names: { [ME]: "Anita Desai" },
      firmNumbers: NUMBERS,
      contacts: CONTACTS,
      shortName: "XYZ Traders",
      countryCode: "91",
      welcomeText: "Welcome to the TaxWise Consultants group for XYZ Traders.",
    }),
  );

describe("the client WhatsApp group card (§7.25.1–§7.25.2)", () => {
  it("shows a To create group with its seven-step checklist open", () => {
    const html = card(group());
    expect(html).toContain("TW · TW-C-0142 · XYZ Traders");
    expect(html).toContain("To create");
    expect(html).toContain("1/7");
    for (const step of ["Group name", "Save the contacts first", "Add these numbers", "Group settings", "Make the Managers&#x27; office number an admin", "Post the welcome message", "Mark the group created"]) {
      expect(html).toContain(step);
    }
    expect(html).toContain("Done by you");
    expect(html).toContain("/api/whatsapp/vcf/client-1?group=g0000000-0000-4000-8000-000000000001");
    expect(html).toContain("+91 98450 12345");
    expect(html).toContain("Only admins");
    expect(html).not.toContain("Open chat");
  });

  it("shows an Active group's members, admins, last opened and Open chat", () => {
    const html = card(
      group({
        status: "active",
        created_on: "2026-10-22",
        created_by_label: "Managers' office",
        last_opened_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
        last_opened_by_name: "Anita Desai",
        has_invite_link: true,
        members: [
          { id: "m1", kind: "firm_number", firm_kind: "partner", display_name: "CA Vinay H Karlagere (Partner)", number: "919876500001", display: "+91 98765 00001", is_admin: false, added_on: "2026-10-22", removed_on: null, source: "checklist", updated_at: "x" },
          { id: "m2", kind: "firm_number", firm_kind: "managers_office", display_name: "Managers' office", number: "919876500004", display: "+91 98765 00004", is_admin: true, added_on: "2026-10-22", removed_on: null, source: "checklist", updated_at: "x" },
          { id: "m3", kind: "client_contact", firm_kind: null, display_name: "Ramesh (Director)", number: "919845012345", display: "+91 98450 12345", is_admin: false, added_on: "2026-10-22", removed_on: null, source: "checklist", updated_at: "x" },
        ],
      }),
    );
    expect(html).toContain("Active");
    expect(html).toContain("Last opened 2 hours ago by Anita");
    expect(html).toContain("Open chat");
    expect(html).toContain("· Admin");
    expect(html).toContain("Reveal");
    expect(html).not.toContain("chat.whatsapp.com");
    expect(html).toContain("Close group");
  });

  it("gives Employees no management actions and no invite link row", () => {
    const html = card(group({ status: "active", created_on: "2026-10-22", has_invite_link: true }), false);
    expect(html).not.toContain("Close group");
    expect(html).not.toContain("Reveal");
    expect(html).not.toContain("Invite link");
  });
});

describe("the WhatsApp groups register (§7.25.1)", () => {
  it("lists groups and clients with no group", () => {
    const rows: RegisterRow[] = [
      { row_id: "r1", group_id: null, client_id: "c1", client_code: "TW-C-0150", client_name: "Delta Foods", client_status: "active", onboarded_at: null, engagement_partner_name: null, group_name: null, purpose: null, is_primary: false, status: "none", created_on: null, closed_at: null, closed_reason: null, last_opened_at: null, last_opened_by_name: null, member_count: 0, admin_count: 0, firm_number_ids: [], member_names: [], checklist_done: 0 },
      { row_id: "r2", group_id: "g2", client_id: "c2", client_code: "TW-C-0142", client_name: "XYZ Traders", client_status: "active", onboarded_at: null, engagement_partner_name: "CA Vinay H Karlagere", group_name: "TW · TW-C-0142 · XYZ Traders", purpose: null, is_primary: true, status: "active", created_on: "2026-10-22", closed_at: null, closed_reason: null, last_opened_at: "2026-10-23T05:00:00Z", last_opened_by_name: "Anita Desai", member_count: 6, admin_count: 2, firm_number_ids: [], member_names: [], checklist_done: 7 },
    ];
    const html = renderToStaticMarkup(React.createElement(RegisterTable, { rows, total: 2, page: 1, pageSize: 25, sort: null, dir: "asc", numberFilter: null }));
    expect(html).toContain("No group yet");
    expect(html).toContain("XYZ Traders");
    expect(html).toContain("2 admins");
    expect(html).toContain("/clients/c2?tab=whatsapp");
  });
});

describe("Settings → WhatsApp (§7.21)", () => {
  it("lists the numbers with who may use them and the custodian", () => {
    const html = renderToStaticMarkup(
      React.createElement(NumbersCard, {
        numbers: NUMBERS,
        canEdit: true,
        viewerEmployeeId: ME,
        partners: [],
        staff: [],
        countryCode: "91",
        links: [{ number_id: "n-staff", label: "Staff office", kind: "staff_office", active_links: 3, device_limit: 4, at_limit: false, over_limit: false }],
      }),
    );
    expect(html).toContain("Firm WhatsApp numbers");
    expect(html).toContain("CA Vinay H Karlagere&#x27;s own number");
    expect(html).toContain("TaxWise Desktop: Partners, Managers, Employees");
    expect(html).toContain("Linked PCs: 3 of 4");
    expect(html).toContain("Custodian: Anita Desai");
    expect(html).toContain("No number yet");
    expect(html).toContain("Record review");
  });

  it("lists linked PCs and flags one not seen for 30 days", () => {
    const html = renderToStaticMarkup(
      React.createElement(LinkedPcsCard, {
        canRemove: true,
        devices: [
          { id: "d1", device_name: "FRONTDESK-2", os: "Windows 10.0", app_version: "1.4.0", last_user_name: "Ravi Kumar", last_seen_at: new Date(Date.now() - 40 * 86_400_000).toISOString(), revoked_at: null, revoked_by_name: null, failing_checks: null, created_at: "2026-06-01T00:00:00Z", links: [{ link_id: "l1", number_id: "n-staff", label: "Staff office", kind: "staff_office", linked_at: "2026-06-01T00:00:00Z", linked_by_name: "Ravi Kumar" }] },
          { id: "d2", device_name: "OLD-PC", os: null, app_version: null, last_user_name: null, last_seen_at: null, revoked_at: "2026-09-01T00:00:00Z", revoked_by_name: "CA Vinay H Karlagere", failing_checks: null, created_at: "2026-01-01T00:00:00Z", links: [] },
        ],
      }),
    );
    expect(html).toContain("FRONTDESK-2");
    expect(html).toContain("Not seen for 40 days");
    expect(html).toContain("Last used by Ravi Kumar");
    expect(html).toContain("Removed");
  });

  it("shows Managers and Employees the settings as facts", () => {
    const html = renderToStaticMarkup(
      React.createElement(WhatsAppGeneralSummary, {
        row: {
          whatsapp_country_code: "91",
          whatsapp_group_name_format: "TW · {client_code} · {short_name}",
          whatsapp_signature: "– {first_name}",
          whatsapp_client_mode: true,
          whatsapp_employee_notifications: false,
          whatsapp_employee_browser_window: false,
          whatsapp_linked_device_limit: 4,
          whatsapp_house_rules: "1. Same firm numbers in every client group.",
          desktop_download_url: null,
          updated_at: "2026-10-22T05:00:00Z",
          updated_by: null,
        },
      }),
    );
    expect(html).toContain("TW · TW-C-0142 · XYZ Traders");
    expect(html).toContain("Not allowed");
    expect(html).toContain("4 PCs per number");
    expect(html).toContain("Same firm numbers in every client group.");
  });
});
