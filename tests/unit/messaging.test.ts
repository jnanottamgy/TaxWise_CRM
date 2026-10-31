import { describe, expect, it } from "vitest";
import {
  applySignature,
  firstNameOf,
  formatWhatsAppNumber,
  isValidUpiId,
  MESSAGING_DEFAULTS,
  NO_WHATSAPP_NUMBER_MESSAGE,
  normalizeWhatsAppNumber,
  pickContactForService,
  pickWhatsAppNumber,
  upiPayUrl,
  waMeUrl,
} from "@/lib/domain/messaging";

// -------------------------------------------------------------------------------------------------
// normalizeWhatsAppNumber: every §7.13.2 step
// -------------------------------------------------------------------------------------------------

describe("normalizeWhatsAppNumber (§7.13.2)", () => {
  describe("step 1: trim; a leading + means the country code is present; strip everything but digits", () => {
    it("removes spaces, dashes, dots and brackets", () => {
      expect(normalizeWhatsAppNumber("  98765 43210  ")).toBe("919876543210");
      expect(normalizeWhatsAppNumber("98765-43210")).toBe("919876543210");
      expect(normalizeWhatsAppNumber("(987) 654.3210")).toBe("919876543210");
      expect(normalizeWhatsAppNumber("\t+91 98765 43210\n")).toBe("919876543210");
      expect(normalizeWhatsAppNumber("+91-98765-43210")).toBe("919876543210");
    });

    it("treats + as a country-code marker only when it leads", () => {
      // "+" not leading: no country code assumed, so the 12 digits stand as typed.
      expect(normalizeWhatsAppNumber("(+91) 98765 43210")).toBe("919876543210");
      // A leading + with a 10-digit Indian mobile is NOT prefixed with 91 (the + says the code is there).
      expect(normalizeWhatsAppNumber("+9876543210")).toBe("9876543210");
    });
  });

  describe("step 2: without +", () => {
    it("11 digits starting 0 → drop the trunk 0 (then the 10-digit rule)", () => {
      expect(normalizeWhatsAppNumber("09876543210")).toBe("919876543210");
      expect(normalizeWhatsAppNumber("0 98765 43210")).toBe("919876543210");
      expect(normalizeWhatsAppNumber("05876543210")).toBeNull(); // subscriber starts 5: not a mobile
    });

    it("more than 12 digits starting 00 → drop the 00", () => {
      expect(normalizeWhatsAppNumber("00919876543210")).toBe("919876543210");
      expect(normalizeWhatsAppNumber("00 44 7911 123456")).toBe("447911123456");
      expect(normalizeWhatsAppNumber("0091 12345 67890")).toBeNull(); // then step 5 rejects it
      // 12 digits starting 00 is not "more than 12": nothing is dropped, and E.164 can't start with 0.
      expect(normalizeWhatsAppNumber("009198765432")).toBeNull();
    });

    it("exactly 10 digits → must start with 6–9 → prefix 91", () => {
      expect(normalizeWhatsAppNumber("9876543210")).toBe("919876543210");
      expect(normalizeWhatsAppNumber("8123456789")).toBe("918123456789");
      expect(normalizeWhatsAppNumber("7000000000")).toBe("917000000000");
      expect(normalizeWhatsAppNumber("6000000000")).toBe("916000000000");
      expect(normalizeWhatsAppNumber("5876543210")).toBeNull(); // landline-like
      expect(normalizeWhatsAppNumber("1234567890")).toBeNull();
      expect(normalizeWhatsAppNumber("0801234567")).toBeNull();
    });

    it("uses the firm's country code for 10-digit numbers", () => {
      expect(normalizeWhatsAppNumber("9876543210", { countryCode: "91" })).toBe("919876543210");
      expect(MESSAGING_DEFAULTS.countryCode).toBe("91");
    });

    it("leaves other lengths to steps 4 and 5", () => {
      expect(normalizeWhatsAppNumber("919876543210")).toBe("919876543210");
      expect(normalizeWhatsAppNumber("447911123456")).toBe("447911123456");
      expect(normalizeWhatsAppNumber("98765432101")).toBe("98765432101"); // 11 digits not starting 0
      expect(normalizeWhatsAppNumber("12345678")).toBe("12345678"); // 8 digits: E.164 minimum
    });
  });

  describe("step 3: with + and a leading 00 → drop it", () => {
    it("drops 00 after +", () => {
      expect(normalizeWhatsAppNumber("+0091 98765 43210")).toBe("919876543210");
      expect(normalizeWhatsAppNumber("+00447911123456")).toBe("447911123456");
    });

    it("keeps international numbers with +", () => {
      expect(normalizeWhatsAppNumber("+1 (415) 555-2671")).toBe("14155552671");
      expect(normalizeWhatsAppNumber("+44 20 7946 0958")).toBe("442079460958");
      expect(normalizeWhatsAppNumber("+971 50 123 4567")).toBe("971501234567");
    });
  });

  describe("step 4: the result must be 8–15 digits (E.164)", () => {
    it("enforces the length bounds", () => {
      expect(normalizeWhatsAppNumber("+1234567")).toBeNull(); // 7
      expect(normalizeWhatsAppNumber("+12345678")).toBe("12345678"); // 8
      expect(normalizeWhatsAppNumber("+123456789012345")).toBe("123456789012345"); // 15
      expect(normalizeWhatsAppNumber("+1234567890123456")).toBeNull(); // 16
      expect(normalizeWhatsAppNumber("+91 98765")).toBeNull();
      expect(normalizeWhatsAppNumber("1234567")).toBeNull();
      expect(normalizeWhatsAppNumber("1234567890123456")).toBeNull();
    });

    it("rejects a result starting with 0 (not E.164)", () => {
      expect(normalizeWhatsAppNumber("+0 98765 43210")).toBeNull();
      expect(normalizeWhatsAppNumber("012345678")).toBeNull();
      expect(normalizeWhatsAppNumber("+000919876543210")).toBeNull();
    });
  });

  describe("step 5: 12 digits starting 91 → the subscriber part must start with 6–9", () => {
    it("checks Indian mobiles however they were typed", () => {
      expect(normalizeWhatsAppNumber("+91 98765 43210")).toBe("919876543210");
      expect(normalizeWhatsAppNumber("+91 61234 56789")).toBe("916123456789");
      expect(normalizeWhatsAppNumber("+91 12345 67890")).toBeNull();
      expect(normalizeWhatsAppNumber("+91 11 2345 6789")).toBeNull(); // Delhi landline
      expect(normalizeWhatsAppNumber("+91 44 2345 6789")).toBeNull(); // Chennai landline
      expect(normalizeWhatsAppNumber("911234567890")).toBeNull();
      expect(normalizeWhatsAppNumber("00911234567890")).toBeNull();
    });

    it("can't tell a Bengaluru (080) landline from a mobile: the rule as specified accepts it", () => {
      // 080 numbers start with 8 after the trunk 0, which the 6–9 rule allows (known limitation of §7.13.2).
      expect(normalizeWhatsAppNumber("080 2345 6789")).toBe("918023456789");
      expect(normalizeWhatsAppNumber("+91 80 2345 6789")).toBe("918023456789");
    });

    it("applies only to 12-digit numbers starting 91", () => {
      expect(normalizeWhatsAppNumber("+9112345678901")).toBe("9112345678901"); // 13 digits
      expect(normalizeWhatsAppNumber("+9112345678")).toBe("9112345678"); // 10 digits with +
    });
  });

  describe("step 6: anything else → null", () => {
    it("returns null for empty and non-numeric input", () => {
      expect(normalizeWhatsAppNumber(null)).toBeNull();
      expect(normalizeWhatsAppNumber(undefined)).toBeNull();
      expect(normalizeWhatsAppNumber("")).toBeNull();
      expect(normalizeWhatsAppNumber("   ")).toBeNull();
      expect(normalizeWhatsAppNumber("+")).toBeNull();
      expect(normalizeWhatsAppNumber("not a number")).toBeNull();
      expect(normalizeWhatsAppNumber("N/A")).toBeNull();
    });
  });

  it("formats a normalised number for display", () => {
    expect(formatWhatsAppNumber("919876543210")).toBe("+91 98765 43210");
    expect(formatWhatsAppNumber("447911123456")).toBe("+447911123456");
  });
});

// -------------------------------------------------------------------------------------------------
// Which number, which contact (§7.13.2)
// -------------------------------------------------------------------------------------------------

describe("pickWhatsAppNumber (§7.13.2: contact whatsapp → contact phone → client whatsapp → client phone)", () => {
  const contact = { whatsapp: "98450 11111", phone: "98450 22222" };
  const client = { whatsapp: "98450 33333", phone: "98450 44444" };

  it("follows the order", () => {
    expect(pickWhatsAppNumber(contact, client)).toEqual({ digits: "919845011111", source: "contact_whatsapp", raw: "98450 11111" });
    expect(pickWhatsAppNumber({ ...contact, whatsapp: null }, client)?.source).toBe("contact_phone");
    expect(pickWhatsAppNumber({ whatsapp: "", phone: null }, client)?.source).toBe("client_whatsapp");
    expect(pickWhatsAppNumber({}, { whatsapp: null, phone: "98450 44444" })?.source).toBe("client_phone");
    expect(pickWhatsAppNumber(null, client)?.source).toBe("client_whatsapp");
  });

  it("skips numbers that don't normalise (e.g. a landline in the phone field)", () => {
    expect(pickWhatsAppNumber({ whatsapp: null, phone: "011 2345 6789" }, client)?.source).toBe("client_whatsapp");
    expect(pickWhatsAppNumber({ whatsapp: "12345", phone: "98450 22222" }, null)?.source).toBe("contact_phone");
  });

  it("uses only the contact's own numbers for per-contact buttons", () => {
    expect(pickWhatsAppNumber({ whatsapp: null, phone: null }, client, { contactOnly: true })).toBeNull();
    expect(pickWhatsAppNumber(contact, client, { contactOnly: true })?.source).toBe("contact_whatsapp");
  });

  it("returns null when there is no usable number (the button is disabled with a tooltip)", () => {
    expect(pickWhatsAppNumber(null, null)).toBeNull();
    expect(pickWhatsAppNumber({ phone: "044 2345 6789" }, { phone: "n/a" })).toBeNull();
    expect(NO_WHATSAPP_NUMBER_MESSAGE).toBe("No WhatsApp number for this client. Add one in Contacts.");
  });
});

describe("pickContactForService (§5.3 handles, §7.13.2)", () => {
  const owner = { name: "Owner", isPrimary: true, handles: [] as string[] };
  const gstAccountant = { name: "GST accountant", isPrimary: false, handles: ["gst"] };
  const gstLead = { name: "GST lead", isPrimary: true, handles: ["gst", "tds"] };
  const cfo = { name: "CFO", isPrimary: false, handles: ["audit"] };

  it("prefers a contact who handles the service, primary first", () => {
    expect(pickContactForService([owner, gstAccountant, cfo], "gst")?.name).toBe("GST accountant");
    expect(pickContactForService([gstAccountant, gstLead], "gst")?.name).toBe("GST lead");
  });

  it("falls back to a general contact, then the primary, then the first", () => {
    expect(pickContactForService([cfo, owner], "payroll")?.name).toBe("Owner");
    expect(pickContactForService([cfo, { ...gstAccountant, isPrimary: true }], "payroll")?.name).toBe("GST accountant");
    expect(pickContactForService([cfo, gstAccountant], "payroll")?.name).toBe("CFO");
  });

  it("without a service, picks the primary contact", () => {
    expect(pickContactForService([cfo, owner])?.name).toBe("Owner");
    expect(pickContactForService([])).toBeNull();
    expect(pickContactForService([{ name: "Only", handles: null }], "gst")?.name).toBe("Only");
  });
});

// -------------------------------------------------------------------------------------------------
// wa.me and the signature (§7.13.2, §7.25.10)
// -------------------------------------------------------------------------------------------------

describe("waMeUrl (§7.13.2)", () => {
  it("encodes the draft and keeps line breaks as %0A", () => {
    expect(waMeUrl("919876543210", "Hi Priya,\nPlease send the sales register.")).toBe(
      "https://wa.me/919876543210?text=Hi%20Priya%2C%0APlease%20send%20the%20sales%20register.",
    );
    expect(waMeUrl("919876543210", "Line 1\r\nLine 2\rLine 3")).toBe("https://wa.me/919876543210?text=Line%201%0ALine%202%0ALine%203");
  });

  it("encodes ₹, &, ? and # safely", () => {
    expect(waMeUrl("919876543210", "₹11,800 due? Pay & reply #42")).toBe(
      "https://wa.me/919876543210?text=%E2%82%B911%2C800%20due%3F%20Pay%20%26%20reply%20%2342",
    );
  });

  it("opens the chat with no text for an empty draft, and refuses an unnormalised number", () => {
    expect(waMeUrl("919876543210")).toBe("https://wa.me/919876543210");
    expect(waMeUrl("919876543210", "")).toBe("https://wa.me/919876543210");
    expect(() => waMeUrl("+91 98765 43210", "x")).toThrow(RangeError);
    expect(() => waMeUrl("0919876543210", "x")).toThrow(RangeError);
  });

  it("works end to end with the normaliser and never uses web.whatsapp.com", () => {
    const digits = normalizeWhatsAppNumber("098765 43210");
    expect(digits).not.toBeNull();
    const url = waMeUrl(digits as string, "Hello");
    expect(url).toBe("https://wa.me/919876543210?text=Hello");
    expect(url).not.toContain("web.whatsapp.com");
  });
});

describe("applySignature (§7.13.2, §7.25.10)", () => {
  it("ends the draft with the signature after a blank line", () => {
    expect(applySignature("Hi Priya, the return is filed.", "– {first_name}", "Ravi")).toBe("Hi Priya, the return is filed.\n\n– Ravi");
    expect(applySignature("Hi", undefined, "Ravi")).toBe("Hi\n\n– Ravi");
    expect(MESSAGING_DEFAULTS.whatsappSignature).toBe("– {first_name}");
  });

  it("is idempotent and tidies trailing whitespace", () => {
    const once = applySignature("Hi Priya.  \n\n", "– {first_name}", "Ravi");
    expect(once).toBe("Hi Priya.\n\n– Ravi");
    expect(applySignature(once, "– {first_name}", "Ravi")).toBe(once);
  });

  it("supports a custom format and leaves the draft alone without a first name", () => {
    expect(applySignature("Hi", "— {first_name}, TaxWise", "Asha")).toBe("Hi\n\n— Asha, TaxWise");
    expect(applySignature("Hi", "– {first_name}", "")).toBe("Hi");
    expect(applySignature("Hi", "– {first_name}", "   ")).toBe("Hi");
    expect(applySignature("", "– {first_name}", "Ravi")).toBe("– Ravi");
  });

  it("takes the first name from a full name, skipping titles", () => {
    expect(firstNameOf("CA Vinay H Karlagere")).toBe("Vinay");
    expect(firstNameOf("Mr. Ravi Kumar")).toBe("Ravi");
    expect(firstNameOf("Dr Asha Rao")).toBe("Asha");
    expect(firstNameOf("Priya")).toBe("Priya");
    expect(firstNameOf("")).toBe("");
    expect(firstNameOf(null)).toBe("");
  });
});

// -------------------------------------------------------------------------------------------------
// UPI (§7.22)
// -------------------------------------------------------------------------------------------------

describe("upiPayUrl (§7.22)", () => {
  it("builds upi://pay?pa=&pn=&am=&tn=&cu=INR", () => {
    expect(upiPayUrl({ upiId: "taxwise@icici", payee: "TaxWise Consultants", amountPaise: 11_800_00, note: "TW/26-27/0042" })).toBe(
      "upi://pay?pa=taxwise@icici&pn=TaxWise%20Consultants&am=11800.00&tn=TW%2F26-27%2F0042&cu=INR",
    );
  });

  it("writes the amount in rupees with two decimals", () => {
    expect(upiPayUrl({ upiId: "tw@okaxis", payee: "TW", amountPaise: 123_450 })).toBe("upi://pay?pa=tw@okaxis&pn=TW&am=1234.50&cu=INR");
    expect(upiPayUrl({ upiId: "tw@okaxis", payee: "TW", amountPaise: 1 })).toContain("am=0.01&");
  });

  it("leaves out the amount and note when not given", () => {
    expect(upiPayUrl({ upiId: "tw@okaxis", payee: "TaxWise", amountPaise: null, note: " " })).toBe("upi://pay?pa=tw@okaxis&pn=TaxWise&cu=INR");
  });

  it("refuses a malformed UPI ID or a non-positive amount", () => {
    expect(() => upiPayUrl({ upiId: "taxwise", payee: "TW", amountPaise: 100 })).toThrow(RangeError);
    expect(() => upiPayUrl({ upiId: "tw@okaxis", payee: "TW", amountPaise: 0 })).toThrow(RangeError);
    expect(() => upiPayUrl({ upiId: "tw@okaxis", payee: "TW", amountPaise: -100 })).toThrow(RangeError);
    expect(isValidUpiId("name.surname-1@oksbi")).toBe(true);
    expect(isValidUpiId("a@b")).toBe(false);
    expect(isValidUpiId("has space@upi")).toBe(false);
  });
});
