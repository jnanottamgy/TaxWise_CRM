import { describe, expect, it } from "vitest";
import { DownloadManager, downloadChoices, isExpired, sanitizeFileName, type DownloadChoiceId, type DownloadDeps } from "../src/main/downloads";
import { DOWNLOAD_TTL_MS, MAX_UPLOAD_BYTES } from "../src/shared/config";
import type { AppRole, DesktopDownloadPayload } from "../src/shared/types";

const xyz = { clientId: "c-xyz", clientName: "XYZ Traders" };
const ids = (r: ReturnType<typeof downloadChoices>) => r.choices.map((c) => c.id);

describe("download choices (§7.25.6)", () => {
  it("Employees: the open client's documents, another client, or nothing; never this PC (§18.3 Employee 9)", () => {
    const r = downloadChoices({ role: "employee", openClient: xyz, size: 120_000, crmReady: true });
    expect(ids(r)).toEqual(["client", "other-client", "cancel"]);
    expect(r.choices[0]!.label).toBe("Save to XYZ Traders documents");
    expect(r.choices[1]!.label).toBe("Save to another client…");
    expect(r.choices.at(-1)!.label).toBe("Don't save");
  });

  it("Partners and Managers may also save to this PC", () => {
    expect(ids(downloadChoices({ role: "partner", openClient: xyz, size: 1, crmReady: true }))).toEqual(["client", "other-client", "pc", "cancel"]);
    expect(ids(downloadChoices({ role: "manager", openClient: null, size: 1, crmReady: true }))).toEqual(["other-client", "pc", "cancel"]);
  });

  it("without an open client chat, offers to pick a client", () => {
    const r = downloadChoices({ role: "employee", openClient: null, size: 1, crmReady: true });
    expect(r.choices[0]).toEqual({ id: "other-client", label: "Save to a client's documents…" });
  });

  it("files over 25 MB can't go to the CRM", () => {
    const r = downloadChoices({ role: "employee", openClient: xyz, size: MAX_UPLOAD_BYTES + 1, crmReady: true });
    expect(ids(r)).toEqual(["cancel"]);
    expect(r.note).toContain("25 MB");
    expect(ids(downloadChoices({ role: "partner", openClient: xyz, size: MAX_UPLOAD_BYTES + 1, crmReady: true }))).toEqual(["pc", "cancel"]);
  });

  it("nothing but close when signed out or the CRM isn't ready", () => {
    expect(ids(downloadChoices({ role: null, openClient: xyz, size: 1, crmReady: true }))).toEqual(["cancel"]);
    expect(ids(downloadChoices({ role: "employee", openClient: xyz, size: 1, crmReady: false }))).toEqual(["cancel"]);
  });
});

describe("file names", () => {
  it("are made safe for any OS", () => {
    expect(sanitizeFileName("GSTR-2B Sep 2026.pdf")).toBe("GSTR-2B Sep 2026.pdf");
    expect(sanitizeFileName("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(sanitizeFileName("a:b*c?.pdf")).toBe("a_b_c_.pdf");
    expect(sanitizeFileName("CON.txt")).toBe("whatsapp-file-CON.txt");
    expect(sanitizeFileName("   ")).toBe("whatsapp-file");
    expect(sanitizeFileName(`${"x".repeat(200)}.pdf`)).toMatch(/^x{116}\.pdf$/);
  });

  it("drops direction controls that would disguise the real extension", () => {
    expect(sanitizeFileName("Invoice\u202Efdp.exe")).toBe("Invoicefdp.exe");
    expect(sanitizeFileName("\u2067report\u2069.pdf\u200F")).toBe("report.pdf");
  });
});

function harness(role: AppRole | null, answer: DownloadChoiceId, opts: { savePath?: string | null } = {}) {
  const files = new Map<string, Buffer>();
  const timers = new Map<number, () => void>();
  let seq = 0;
  const sent: DesktopDownloadPayload[] = [];
  const asked: string[][] = [];
  const copies: Array<[string, string]> = [];
  const deps: DownloadDeps = {
    tempDir: "/tmp/tw",
    join: (...p) => p.join("/"),
    fs: {
      mkdirSync: () => undefined,
      readFileSync: (p) => files.get(p)!,
      unlinkSync: (p) => {
        if (!files.delete(p)) throw new Error("ENOENT");
      },
      copyFileSync: (a, b) => void copies.push([a, b]),
      readdirSync: () => [...files.keys()].map((k) => k.split("/").pop()!),
      statSync: () => ({ mtimeMs: 0 }),
    },
    randomId: () => `id${++seq}`,
    now: () => DOWNLOAD_TTL_MS + 1,
    setTimeout: (fn) => {
      const id = ++seq;
      timers.set(id, fn);
      return id;
    },
    clearTimeout: (h) => void timers.delete(h as number),
    role: () => role,
    crmReady: () => true,
    ask: async (_f, choices) => {
      asked.push(choices.map((c) => c.id));
      return answer;
    },
    askSavePath: async () => (opts.savePath === undefined ? "/home/user/Downloads/x.pdf" : opts.savePath),
    sendToCrm: (p) => void sent.push(p),
    log: () => undefined,
  };
  const m = new DownloadManager(deps);
  const item = (name: string, size: number) => {
    let done: ((e: unknown, state: string) => void) | null = null;
    let path = "";
    return {
      getFilename: () => name,
      getMimeType: () => "application/pdf",
      getTotalBytes: () => size,
      setSavePath: (p: string) => void (path = p),
      once: (_ev: string, fn: (e: unknown, state: string) => void) => {
        done = fn;
      },
      finish(state = "completed") {
        files.set(path, Buffer.from("%PDF-1.7"));
        done!({}, state);
      },
      get path() {
        return path;
      },
    };
  };
  return { m, item, files, timers, sent, asked, copies };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("DownloadManager", () => {
  it("hands the file to the CRM page for the open client, and deletes it after the upload", async () => {
    const h = harness("employee", "client");
    const it1 = h.item("Form 16.pdf", 8);
    h.m.handle(it1 as never, async () => xyz);
    expect(it1.path).toBe("/tmp/tw/id1-Form 16.pdf");
    it1.finish();
    await settle();
    expect(h.asked).toEqual([["client", "other-client", "cancel"]]);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ id: "id1", clientId: "c-xyz", clientName: "XYZ Traders", fileName: "Form 16.pdf", mimeType: "application/pdf", source: "whatsapp" });
    expect(Buffer.from(h.sent[0]!.bytes).toString()).toBe("%PDF-1.7");
    expect(h.files.size).toBe(1);
    h.m.complete("id1");
    expect(h.files.size).toBe(0);
  });

  it("deletes the temp file after 10 minutes if the page never finishes", async () => {
    const h = harness("employee", "other-client");
    const it1 = h.item("a.pdf", 8);
    h.m.handle(it1 as never, async () => null);
    it1.finish();
    await settle();
    expect(h.sent[0]!.clientId).toBeNull();
    expect(h.files.size).toBe(1);
    for (const fn of h.timers.values()) fn();
    expect(h.files.size).toBe(0);
  });

  it("an Employee choosing nothing leaves nothing on the PC", async () => {
    const h = harness("employee", "cancel");
    const it1 = h.item("a.pdf", 8);
    h.m.handle(it1 as never, async () => xyz);
    it1.finish();
    await settle();
    expect(h.sent).toEqual([]);
    expect(h.files.size).toBe(0);
  });

  it("an Employee can't save to the PC even if asked to", async () => {
    const h = harness("employee", "pc");
    const it1 = h.item("a.pdf", 8);
    h.m.handle(it1 as never, async () => xyz);
    it1.finish();
    await settle();
    expect(h.copies).toEqual([]);
    expect(h.files.size).toBe(0);
  });

  it("a Partner saves to this PC", async () => {
    const h = harness("partner", "pc");
    const it1 = h.item("a.pdf", 8);
    h.m.handle(it1 as never, async () => xyz);
    it1.finish();
    await settle();
    expect(h.copies).toEqual([["/tmp/tw/id1-a.pdf", "/home/user/Downloads/x.pdf"]]);
    expect(h.files.size).toBe(0);
  });

  it("a cancelled download leaves nothing", async () => {
    const h = harness("partner", "client");
    const it1 = h.item("a.pdf", 8);
    h.m.handle(it1 as never, async () => xyz);
    it1.finish("cancelled");
    await settle();
    expect(h.asked).toEqual([]);
    expect(h.files.size).toBe(0);
  });

  it("knows when a temp file has expired", () => {
    expect(isExpired(0, DOWNLOAD_TTL_MS)).toBe(true);
    expect(isExpired(0, DOWNLOAD_TTL_MS - 1)).toBe(false);
  });
});
