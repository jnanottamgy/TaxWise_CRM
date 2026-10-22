import { describe, expect, it } from "vitest";
import {
  buildWhatsAppSendUrl,
  crmShowsSignedOutPage,
  decideNavigation,
  decideSubframeNavigation,
  decideWindowOpen,
  isAuthCookie,
  rewriteWhatsAppLink,
  safeExternalUrl,
} from "../src/main/navigation";

const opts = { appOrigin: "https://app.twchartered.com" };

describe("CRM view navigation (§7.25.3)", () => {
  it("stays inside TAXWISE_APP_URL's origin", () => {
    expect(decideNavigation("crm", "https://app.twchartered.com/clients/42?tab=whatsapp", opts)).toEqual({ action: "allow" });
    expect(decideNavigation("crm", "https://app.twchartered.com/login", opts)).toEqual({ action: "allow" });
  });

  it("sends other https links to the system browser", () => {
    expect(decideNavigation("crm", "https://www.incometax.gov.in/iec/foportal/", opts)).toEqual({
      action: "external",
      url: "https://www.incometax.gov.in/iec/foportal/",
    });
    expect(decideNavigation("crm", "https://mail.google.com/mail/?view=cm&fs=1&to=a@b.in", opts).action).toBe("external");
  });

  it("does not treat a look-alike host, another port or http as the CRM", () => {
    expect(decideNavigation("crm", "https://app.twchartered.com.evil.example/", opts).action).toBe("external");
    expect(decideNavigation("crm", "https://app.twchartered.com:8443/", opts).action).toBe("external");
    expect(decideNavigation("crm", "http://app.twchartered.com/", opts)).toMatchObject({ action: "deny" });
  });

  it("refuses non-https links instead of opening them", () => {
    for (const url of ["http://example.com/", "file:///C:/Windows/System32/calc.exe", "javascript:alert(1)", "mailto:ca@twchartered.com", "ftp://x.example/", "smb://server/share", "data:text/html,hi"]) {
      expect(decideNavigation("crm", url, opts).action, url).toBe("deny");
    }
    expect(decideNavigation("crm", "not a url", opts).action).toBe("deny");
  });

  it("opens wa.me hand-offs in the WhatsApp panel as web.whatsapp.com/send", () => {
    const text = "Hi Ramesh, for your GSTR-3B for Sep 2026 we still need:\n- purchase register\n– Ravi";
    const url = `https://wa.me/919845012345?text=${encodeURIComponent(text)}`;
    const d = decideNavigation("crm", url, opts);
    expect(d).toEqual({
      action: "whatsapp-send",
      phone: "919845012345",
      url: `https://web.whatsapp.com/send?phone=919845012345&text=${encodeURIComponent(text)}`,
    });
    // Line breaks survive (%0A).
    expect((d as { url: string }).url).toContain("%0A");
  });

  it("opens api.whatsapp.com/send hand-offs in the panel too", () => {
    expect(decideNavigation("crm", "https://api.whatsapp.com/send?phone=919845012345&text=Hello%20there", opts)).toEqual({
      action: "whatsapp-send",
      phone: "919845012345",
      url: "https://web.whatsapp.com/send?phone=919845012345&text=Hello%20there",
    });
    expect(decideNavigation("crm", "https://api.whatsapp.com/send/?phone=%2B919845012345", opts)).toEqual({
      action: "whatsapp-send",
      phone: "919845012345",
      url: "https://web.whatsapp.com/send?phone=919845012345",
    });
  });

  it("rewrites only valid numbers", () => {
    expect(rewriteWhatsAppLink("https://wa.me/12345")).toBeNull(); // too short
    expect(rewriteWhatsAppLink("https://wa.me/1234567890123456")).toBeNull(); // too long
    expect(rewriteWhatsAppLink("https://wa.me/message/ABCDEF")).toBeNull();
    expect(rewriteWhatsAppLink("https://api.whatsapp.com/send?phone=98-450")).toBeNull();
    expect(rewriteWhatsAppLink("https://user:pw@wa.me/919845012345")).toBeNull();
    expect(rewriteWhatsAppLink("https://wa.me/+919845012345")?.phone).toBe("919845012345");
  });

  it("re-encodes the draft so nothing else rides along in the URL", () => {
    const r = rewriteWhatsAppLink("https://wa.me/919845012345?text=a%26phone%3D911111111111&phone=922222222222");
    expect(r?.url).toBe("https://web.whatsapp.com/send?phone=919845012345&text=a%26phone%3D911111111111");
  });

  it("shows the panel for other WhatsApp Web links from the CRM, without navigating it", () => {
    expect(decideNavigation("crm", "https://web.whatsapp.com/", opts)).toEqual({ action: "show-whatsapp" });
  });

  it("builds the send URL", () => {
    expect(buildWhatsAppSendUrl("919845012345", null)).toBe("https://web.whatsapp.com/send?phone=919845012345");
    expect(buildWhatsAppSendUrl("919845012345", "a b")).toBe("https://web.whatsapp.com/send?phone=919845012345&text=a%20b");
  });
});

describe("WhatsApp view navigation", () => {
  it("stays inside https://web.whatsapp.com", () => {
    expect(decideNavigation("whatsapp", "https://web.whatsapp.com/", opts)).toEqual({ action: "allow" });
    expect(decideNavigation("whatsapp", "https://web.whatsapp.com/accept?code=AbCdEfGhIjKlMnOpQrStUv", opts)).toEqual({ action: "allow" });
    expect(decideNavigation("whatsapp", "https://web.whatsapp.com/send?phone=919845012345", opts)).toEqual({ action: "allow" });
  });

  it("sends links clicked in a chat to the system browser (https only)", () => {
    expect(decideNavigation("whatsapp", "https://www.gst.gov.in/", opts)).toEqual({ action: "external", url: "https://www.gst.gov.in/" });
    expect(decideNavigation("whatsapp", "https://app.twchartered.com/", opts).action).toBe("external");
    expect(decideNavigation("whatsapp", "http://phishing.example/", opts).action).toBe("deny");
    expect(decideNavigation("whatsapp", "http://web.whatsapp.com/", opts).action).toBe("deny");
  });
});

describe("panel header navigation", () => {
  it("shows only its own bundled page", () => {
    expect(decideNavigation("panel", "taxwise://panel/panel-header.html", opts)).toEqual({ action: "allow" });
    expect(decideNavigation("panel", "https://web.whatsapp.com/", opts).action).toBe("deny");
    expect(decideNavigation("panel", "file:///etc/passwd", opts).action).toBe("deny");
  });
});

describe("new windows", () => {
  it("never opens a new Electron window", () => {
    for (const view of ["crm", "whatsapp", "panel"] as const) {
      for (const url of ["https://app.twchartered.com/x", "https://web.whatsapp.com/x", "https://example.com/", "taxwise://panel/x.html"]) {
        expect(decideWindowOpen(view, url, opts).action).not.toBe("allow");
      }
    }
  });

  it("loads a CRM page in the CRM view instead, and routes the rest", () => {
    expect(decideWindowOpen("crm", "https://app.twchartered.com/clients/42", opts)).toEqual({ action: "navigate-crm", url: "https://app.twchartered.com/clients/42" });
    expect(decideWindowOpen("crm", "https://example.com/", opts)).toEqual({ action: "external", url: "https://example.com/" });
    expect(decideWindowOpen("crm", "https://wa.me/919845012345", opts).action).toBe("whatsapp-send");
    expect(decideWindowOpen("whatsapp", "https://web.whatsapp.com/popup", opts).action).toBe("deny");
    expect(decideWindowOpen("whatsapp", "https://youtube.com/watch?v=x", opts).action).toBe("external");
    expect(decideWindowOpen("crm", "http://example.com/", opts).action).toBe("deny");
  });
});

describe("sign-out detection", () => {
  it("recognises the CRM's signed-out pages", () => {
    expect(crmShowsSignedOutPage("https://app.twchartered.com/login", opts.appOrigin)).toBe(true);
    expect(crmShowsSignedOutPage("https://app.twchartered.com/login?next=/clients", opts.appOrigin)).toBe(true);
    expect(crmShowsSignedOutPage("https://app.twchartered.com/set-password", opts.appOrigin)).toBe(true);
    expect(crmShowsSignedOutPage("https://app.twchartered.com/clients", opts.appOrigin)).toBe(false);
    expect(crmShowsSignedOutPage("https://app.twchartered.com/login-help", opts.appOrigin)).toBe(false);
    expect(crmShowsSignedOutPage("https://other.example/login", opts.appOrigin)).toBe(false);
  });

  it("recognises Supabase's session cookie", () => {
    expect(isAuthCookie("sb-abcdefgh-auth-token")).toBe(true);
    expect(isAuthCookie("sb-abcdefgh-auth-token.0")).toBe(true);
    expect(isAuthCookie("sb-abcdefgh-auth-token-code-verifier")).toBe(false);
    expect(isAuthCookie("theme")).toBe(false);
  });
});

describe("blob:, data: and filesystem: documents never replace a view's page", () => {
  it("refuses them in the CRM and WhatsApp main frames, even when their creator was that origin", () => {
    for (const url of [
      "blob:https://app.twchartered.com/6a1f0c4e-1111-4000-8000-000000000001",
      "filesystem:https://app.twchartered.com/temporary/x.html",
      "data:text/html,<script>alert(1)</script>",
    ]) {
      expect(decideNavigation("crm", url, opts).action, url).toBe("deny");
      expect(decideWindowOpen("crm", url, opts).action, url).toBe("deny");
    }
    for (const url of ["blob:https://web.whatsapp.com/6a1f0c4e-1111-4000-8000-000000000001", "filesystem:https://web.whatsapp.com/temporary/x"]) {
      expect(decideNavigation("whatsapp", url, opts).action, url).toBe("deny");
      expect(decideWindowOpen("whatsapp", url, opts).action, url).toBe("deny");
    }
  });
});

describe("subframe navigation (will-frame-navigate)", () => {
  it("lets iframes load web pages and in-page previews", () => {
    for (const url of ["https://www.youtube.com/embed/x", "about:blank", "about:srcdoc", "blob:https://app.twchartered.com/abc", "data:application/pdf;base64,JVBERi0="]) {
      expect(decideSubframeNavigation("crm", url, opts).action, url).toBe("allow");
    }
    expect(decideSubframeNavigation("whatsapp", "https://web.whatsapp.com/frame", opts).action).toBe("allow");
  });

  it("refuses local files, the panel's scheme, plain http and other apps' protocols", () => {
    for (const url of [
      "file:///C:/Windows/System32/calc.exe",
      "taxwise://panel/panel-header.html",
      "http://example.com/",
      "ms-msdt:/id PCWDiagnostic",
      "search-ms:query=x",
      "chrome://settings",
      "devtools://devtools/bundled/inspector.html",
      "not a url",
    ]) {
      expect(decideSubframeNavigation("crm", url, opts).action, url).toBe("deny");
      expect(decideSubframeNavigation("whatsapp", url, opts).action, url).toBe("deny");
    }
  });

  it("allows http only for the CRM's own development origin, and gives the panel header no frames", () => {
    const dev = { appOrigin: "http://localhost:3000" };
    expect(decideSubframeNavigation("crm", "http://localhost:3000/preview", dev).action).toBe("allow");
    expect(decideSubframeNavigation("whatsapp", "http://localhost:3000/preview", dev).action).toBe("deny");
    expect(decideSubframeNavigation("panel", "https://example.com/", opts).action).toBe("deny");
    expect(decideSubframeNavigation("panel", "about:blank", opts).action).toBe("allow");
  });
});

describe("shell.openExternal input", () => {
  it("is https only, without credentials, re-serialised", () => {
    expect(safeExternalUrl("https://www.gst.gov.in/")).toBe("https://www.gst.gov.in/");
    expect(safeExternalUrl("HTTPS://WWW.GST.GOV.IN/a b")).toBe("https://www.gst.gov.in/a%20b");
    for (const bad of [
      "http://example.com/",
      "file:///C:/Windows/System32/calc.exe",
      "javascript:alert(1)",
      "ms-msdt:/id PCWDiagnostic",
      "search-ms:query=x",
      "mailto:ca@twchartered.com",
      "https://user:pw@example.com/",
      "https://",
      "not a url",
    ]) {
      expect(safeExternalUrl(bad), bad).toBeNull();
    }
    expect(decideNavigation("crm", "https://user:pw@example.com/", opts).action).toBe("deny");
  });
});
