import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("server-only", () => ({}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode; scroll?: boolean }) => {
    const props: Record<string, unknown> = { ...rest };
    delete props.scroll;
    return React.createElement("a", { href, ...props }, children);
  },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => "/inbox",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/server/actions/messages", () => ({ logHandoff: vi.fn(), logCallNote: vi.fn() }));
vi.mock("@/server/actions/threads", () => ({ sendPortalReply: vi.fn(), markThreadRead: vi.fn(async () => ({ ok: true, data: { marked: 0, lastReadAt: null } })) }));
vi.mock("@/server/actions/inbox", () => ({ markNotifications: vi.fn(), deleteNotifications: vi.fn(), markAllNotificationsRead: vi.fn(), openActionItem: vi.fn() }));

import { Composer } from "@/components/comms/composer";
import { ActionItems } from "@/components/inbox/action-items";
import { UpdatesList } from "@/components/inbox/updates-list";
import { ThreadsList } from "@/components/comms/threads-list";
import { groupActionItems } from "@/lib/schemas/inbox";

/** Server render of the comms screens' client parts: they render without throwing and say the right things. */

const messaging = {
  firmName: "TaxWise Consultants",
  firmPhone: "+91 80 4123 4567",
  countryCode: "91",
  signatureFormat: "– {first_name}",
  addSignature: true,
  senderName: "Ravi Kumar",
  templates: [
    { id: "t1", name: "Document reminder (WhatsApp)", type: "document_reminder", channel: "whatsapp", subject: null, body: "Hi {{contact_name}}, for {{period}} we need {{missing_items}}" },
    { id: "t2", name: "Welcome (email)", type: "welcome", channel: "email", subject: "Welcome to {{firm_name}}", body: "Dear {{contact_name}}" },
  ],
};

describe("Composer", () => {
  it("starts on the portal for a portal client, offering portal-fit templates and Log a call", () => {
    const html = renderToStaticMarkup(
      React.createElement(Composer, {
        client: { id: "c1", name: "Sharma Traders", code: "TW-C-0012", onPortal: true, phone: null, whatsapp: null },
        contacts: [{ id: "k1", name: "Rakesh Sharma", role: "Director", phone: "98450 12345", whatsapp: null, is_primary: true }],
        messaging,
        portalLink: "https://crm.twchartered.com/portal",
      }),
    );
    expect(html).toContain("Send to portal");
    expect(html).toContain("Log a call or note");
    expect(html).toContain("Document reminder (WhatsApp)");
    expect(html).toContain('aria-pressed="true"');
  });

  it("explains a client who isn't on the portal and starts on WhatsApp", () => {
    const html = renderToStaticMarkup(
      React.createElement(Composer, {
        client: { id: "c1", name: "Sharma Traders", code: "TW-C-0012", onPortal: false, phone: null, whatsapp: null },
        contacts: [],
        messaging,
        portalLink: "https://crm.twchartered.com/portal",
      }),
    );
    expect(html).toContain("No WhatsApp number for this client. Add one in Contacts.");
    expect(html).toContain("Open WhatsApp");
  });
});

describe("Inbox", () => {
  it("lists action items with their deep links and a New mark", () => {
    const groups = groupActionItems([
      { kind: "acceptance", entity_type: "task", entity_id: "t1", client_id: "c1", client_name: "Sharma Traders", reference: "T-000123", title: "GSTR-3B for Sep 2026", person_name: "Anita Rao", amount: null, due_date: "2026-10-25", since: "2026-10-22T05:00:00Z", reason: null, note: null, item_count: null, link_url: "/work/t1" },
    ]);
    const html = renderToStaticMarkup(React.createElement(ActionItems, { groups, unread: { "task:t1": 1 }, today: "2026-10-23" }));
    expect(html).toContain("Waiting for you to accept");
    expect(html).toContain('href="/work/t1"');
    expect(html).toContain("assigned by Anita Rao");
    expect(html).toContain("New.");
  });

  it("says when nothing needs action", () => {
    const html = renderToStaticMarkup(React.createElement(ActionItems, { groups: [], unread: {}, today: "2026-10-23" }));
    expect(html).toContain("Nothing needs your action right now.");
  });

  it("lists updates with read state and actions, and an empty state per tab", () => {
    const row = { id: "n1", type: "task_overdue" as const, title: "Overdue by 4 days: GSTR-3B", body: "T-000123 for Sharma Traders was due 20 Oct 2026.", link_url: "/work/t1", entity_type: "task", entity_id: "t1", read_at: null, archived_at: null, emailed_at: null, created_at: "2026-10-23T02:30:00Z" };
    const html = renderToStaticMarkup(React.createElement(UpdatesList, { rows: [row], total: 1, page: 1, pageSize: 25, show: "inbox", filtered: false }));
    expect(html).toContain("Overdue by 4 days: GSTR-3B");
    expect(html).toContain("(unread)");
    expect(html).toContain("Work");
    const empty = renderToStaticMarkup(React.createElement(UpdatesList, { rows: [], total: 0, page: 1, pageSize: 25, show: "unread", filtered: false }));
    expect(empty).toContain("up to date. Nothing unread.");
  });
});

describe("ThreadsList", () => {
  it("shows unread counts and the latest message", () => {
    const html = renderToStaticMarkup(
      React.createElement(ThreadsList, {
        rows: [
          { client_id: "c1", client_name: "Sharma Traders", client_code: "TW-C-0012", client_status: "active", on_portal: true, last_channel: "portal", last_direction: "inbound", last_status: "sent", last_subject: null, last_preview: "Uploaded the bank statement", last_at: "2026-10-23T04:00:00Z", last_sender_name: null, unread_count: 2, has_unread: true, new_for_me: true },
        ],
        total: 1,
        page: 1,
        pageSize: 25,
        selectedId: "c1",
        hrefFor: { c1: "/messages?client=c1" },
        filtered: false,
        canFilterMine: true,
      }),
    );
    expect(html).toContain("Sharma Traders");
    expect(html).toContain("2 unread");
    expect(html).toContain("Portal · Client: Uploaded the bank statement");
    expect(html).toContain('aria-current="page"');
  });
});
