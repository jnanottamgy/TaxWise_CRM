import { describe, expect, it } from "vitest";
import { recipientLabel } from "@/components/app/messaging/whatsapp-button";

describe("Send on WhatsApp: who it goes to", () => {
  it("names the contact and the client once each", () => {
    expect(recipientLabel("Rakesh Sharma · Sharma Traders")).toBe("Rakesh Sharma · Sharma Traders");
    expect(recipientLabel("Divya Pai · Divya Pai")).toBe("Divya Pai");
    expect(recipientLabel("Divya Pai · divya pai ")).toBe("Divya Pai");
    expect(recipientLabel("Client")).toBe("Client");
  });
});
