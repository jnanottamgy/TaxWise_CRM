import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
}));

import { TemplatePreview } from "@/components/templates/template-preview";
import { ThreadView } from "@/components/comms/thread-view";
import { previewValues } from "@/lib/schemas/message-templates";
import type { ThreadMessage } from "@/lib/schemas/inbox";

/** The comms screens' pure presentational parts render what the spec says they show. */

describe("TemplatePreview", () => {
  it("fills variables with the sample client, marks unknown ones, and signs WhatsApp drafts", () => {
    const html = renderToStaticMarkup(
      React.createElement(TemplatePreview, {
        channel: "whatsapp",
        subject: "ignored",
        body: "Hi {{contact_name}}, {{compliance_type}} is due on {{due_date}}. {{client_email}}",
        values: previewValues({ firmName: "TaxWise Consultants", senderName: "Ravi Kumar" }),
        signature: "– {first_name}",
        senderName: "Ravi Kumar",
      }),
    );
    expect(html).toContain("Priya");
    expect(html).toContain("GSTR-3B");
    expect(html).toContain("20 Oct 2026");
    expect(html).toContain("{{client_email}}");
    expect(html).toContain("– Ravi");
    expect(html).not.toContain("Subject:");
  });

  it("shows the subject for email and no signature", () => {
    const html = renderToStaticMarkup(
      React.createElement(TemplatePreview, { channel: "email", subject: "{{firm_name}} | Reminder", body: "Dear {{contact_name}}", values: previewValues({ firmName: "TaxWise Consultants" }), signature: "– {first_name}", senderName: "Ravi Kumar" }),
    );
    expect(html).toContain("Subject:");
    expect(html).toContain("TaxWise Consultants");
    expect(html).not.toContain("– Ravi");
  });
});

describe("ThreadView", () => {
  const base: ThreadMessage = {
    id: "m1",
    channel: "whatsapp_handoff",
    direction: "outbound",
    status: "handed_off",
    subject: null,
    body: "Hi Rakesh, we still need the sales register.",
    recipient: "919845012345",
    at: "2026-10-22T05:00:00Z",
    created_at: "2026-10-22T05:00:00Z",
    sent_by: "u1",
    sender_name: "Anita Rao",
    contact_name: "Rakesh",
    template_name: "Data awaited (WhatsApp)",
    related_entity_type: "task",
    read_at: null,
    delivered_at: null,
    failed_at: null,
    error: null,
    attachments: [],
  };

  it("says Handed off for a WhatsApp hand-off and Logged for a call, never Delivered", () => {
    const html = renderToStaticMarkup(
      React.createElement(ThreadView, {
        messages: [
          base,
          { ...base, id: "m2", channel: "call_log", direction: "inbound", status: "sent", recipient: null, body: "Will send it tomorrow", created_at: "2026-10-22T06:00:00Z", at: "2026-10-22T06:00:00Z", template_name: null },
          { ...base, id: "m3", channel: "portal", direction: "inbound", status: "sent", recipient: null, sender_name: null, contact_name: null, body: "Uploaded", created_at: "2026-10-23T04:00:00Z", at: "2026-10-23T04:00:00Z", template_name: null, attachments: [{ id: "d1", title: "Sales register Sep" }] },
        ],
        clientId: "c1",
        clientName: "Sharma Traders",
        me: "someone-else",
        newSince: "2026-10-22T05:30:00Z",
        today: "2026-10-23",
        emptyMessage: "Nothing yet",
      }),
    );
    expect(html).toContain("Handed off");
    expect(html).toContain("Logged");
    expect(html).not.toContain("Delivered");
    expect(html).toContain("+91 98450 12345");
    expect(html).toContain("Rakesh called");
    expect(html).toContain("Sharma Traders (portal)");
    expect(html).toContain("New since you last looked");
    expect(html).toContain("Yesterday");
    expect(html).toContain("Today");
    expect(html).toContain("/clients/c1?tab=documents&amp;doc=d1");
    expect(html).toContain("From the template “Data awaited (WhatsApp)”");
  });

  it("shows its empty message with no messages", () => {
    const html = renderToStaticMarkup(React.createElement(ThreadView, { messages: [], clientId: "c1", clientName: "X", me: "u1", newSince: null, today: "2026-10-23", emptyMessage: "No messages with X yet." }));
    expect(html).toContain("No messages with X yet.");
  });
});
