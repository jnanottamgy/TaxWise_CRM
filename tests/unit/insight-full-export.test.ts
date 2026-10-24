import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  CsvParts,
  MANIFEST_HEADERS,
  fullExportChunks,
  fullExportStream,
  istStamp,
  manifestFileName,
  manifestRows,
  pagingPlan,
  parseCatalog,
  readmeText,
  selectColumn,
  tableFileName,
  tablePages,
  type ExportTable,
  type ManifestDocument,
} from "@/server/exports/full-export";
import { untyped } from "@/lib/supabase/untyped";

const dec = new TextDecoder("utf-8", { ignoreBOM: true });
const BOM = "﻿";

// -------------------------------------------------------------------------------------------------
// An in-memory stand-in for the PostgREST query builder: select / order / gt / limit / range, with
// an optional server row cap, and every call recorded.
// -------------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Call = { table: string; select: string; orders: string[]; gt: [string, unknown] | null; limit: number | null; range: [number, number] | null };

function cmp(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  return (a as string | number) < (b as string | number) ? -1 : 1;
}

function fakeDb(tables: Record<string, Row[]>, opts: { cap?: number; failOn?: string } = {}) {
  const calls: Call[] = [];
  const run = (c: Call): { data: Row[] | null; error: { message: string; code?: string } | null } => {
    if (opts.failOn === c.table) return { data: null, error: { message: "permission denied", code: "42501" } };
    let rows = [...(tables[c.table] ?? [])];
    if (c.orders.length) rows.sort((a, b) => c.orders.reduce((n, k) => n || cmp(a[k], b[k]), 0));
    if (c.gt) {
      const [k, v] = c.gt;
      rows = rows.filter((r) => cmp(r[k], v) > 0);
    }
    if (c.range) rows = rows.slice(c.range[0], c.range[1] + 1);
    if (c.limit !== null) rows = rows.slice(0, c.limit);
    if (opts.cap) rows = rows.slice(0, opts.cap);
    if (!c.select.includes("(")) {
      const cols = c.select.split(",");
      rows = rows.map((r) => Object.fromEntries(cols.map((k) => [k, r[k]])));
    }
    return { data: rows, error: null };
  };
  const client = {
    from(table: string) {
      const call: Call = { table, select: "*", orders: [], gt: null, limit: null, range: null };
      const b = {
        select(s: string) {
          call.select = s;
          return b;
        },
        order(k: string) {
          call.orders.push(k);
          return b;
        },
        gt(k: string, v: unknown) {
          call.gt = [k, v];
          return b;
        },
        limit(n: number) {
          call.limit = n;
          return b;
        },
        range(a: number, z: number) {
          call.range = [a, z];
          return b;
        },
        then<T>(resolve: (v: ReturnType<typeof run>) => T) {
          calls.push(call);
          return Promise.resolve(run(call)).then(resolve);
        },
      };
      return b;
    },
  };
  return { client, calls };
}

// A minimal ZIP reader (central directory, then each local header and its data).
function readZip(bytes: Uint8Array): { comment: string; files: Map<string, string> } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("no end record");
  const count = v.getUint16(end + 10, true);
  const files = new Map<string, string>();
  let p = v.getUint32(end + 16, true);
  for (let i = 0; i < count; i++) {
    const size = v.getUint32(p + 24, true);
    const nameLength = v.getUint16(p + 28, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLength));
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    files.set(name, dec.decode(bytes.subarray(start, start + size)));
    p += 46 + nameLength;
  }
  return { comment: dec.decode(bytes.subarray(end + 22, end + 22 + v.getUint16(end + 20, true))), files };
}

async function collect(gen: AsyncGenerator<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const c of gen) parts.push(c);
  const out = new Uint8Array(parts.reduce((n, c) => n + c.length, 0));
  let p = 0;
  for (const c of parts) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

// -------------------------------------------------------------------------------------------------

describe("parseCatalog", () => {
  it("keeps well-formed tables and drops anything odd", () => {
    const c = parseCatalog([
      { name: "clients", kind: "table", columns: ["id", "client_code"], key: ["id"] },
      { name: "clients", kind: "table", columns: ["id"], key: ["id"] },
      { name: "Robert'); drop table", kind: "table", columns: ["id"], key: ["id"] },
      { name: "empty_cols", kind: "table", columns: [], key: ["id"] },
      { name: "client_credentials_list", kind: "view", columns: ["id", "username"], key: ["id"] },
      { name: "holidays", kind: "table", columns: ["date", "name"], key: null },
      "nonsense",
      null,
    ]);
    expect(c).toEqual([
      { name: "clients", kind: "table", columns: ["id", "client_code"], key: ["id"] },
      { name: "client_credentials_list", kind: "view", columns: ["id", "username"], key: ["id"] },
      { name: "holidays", kind: "table", columns: ["date", "name"], key: null },
    ]);
    expect(parseCatalog(null)).toEqual([]);
    expect(parseCatalog({ name: "clients" })).toEqual([]);
  });
});

describe("names and paging", () => {
  it("names table files and their parts inside tables/", () => {
    expect(tableFileName("clients", 1)).toBe("tables/clients.csv");
    expect(tableFileName("audit_logs", 3)).toBe("tables/audit_logs-part-3.csv");
    expect(manifestFileName(1)).toBe("documents-manifest.csv");
    expect(manifestFileName(2)).toBe("documents-manifest-part-2.csv");
  });

  it("quotes a column only when it isn't a plain identifier", () => {
    expect(selectColumn("client_code")).toBe("client_code");
    expect(selectColumn('Odd "name"')).toBe('"Odd ""name"""');
  });

  it("pages by a single readable key, else by offset in key or column order", () => {
    expect(pagingPlan({ name: "t", kind: "table", columns: ["id", "a"], key: ["id"] })).toEqual({ mode: "keyset", key: "id" });
    expect(pagingPlan({ name: "t", kind: "table", columns: ["a", "b", "c"], key: ["a", "b"] })).toEqual({ mode: "offset", order: ["a", "b"] });
    expect(pagingPlan({ name: "t", kind: "table", columns: ["a", "b"], key: ["id"] })).toEqual({ mode: "offset", order: ["a", "b"] });
    expect(pagingPlan({ name: "t", kind: "table", columns: ["a", "b"], key: null })).toEqual({ mode: "offset", order: ["a", "b"] });
  });
});

describe("tablePages", () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({ id: `r${i}`, n: i }));

  it("reads every row by key, even when the server caps a page below the batch", async () => {
    const { client, calls } = fakeDb({ things: rows }, { cap: 2 });
    const t: ExportTable = { name: "things", kind: "table", columns: ["id", "n"], key: ["id"] };
    const got: Row[] = [];
    for await (const page of tablePages(untyped(client), t, 5)) got.push(...page);
    expect(got.map((r) => r.n)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(calls[0]).toMatchObject({ select: "id,n", orders: ["id"], gt: null, limit: 5 });
    expect(calls[1].gt).toEqual(["id", "r1"]);
    expect(calls.at(-1)?.gt).toEqual(["id", "r6"]); // the empty page that ends it
  });

  it("pages by offset when the key has several columns", async () => {
    const pairs = [
      { a: 2, b: 1, v: "x" },
      { a: 1, b: 2, v: "y" },
      { a: 1, b: 1, v: "z" },
    ];
    const { client, calls } = fakeDb({ pairs });
    const t: ExportTable = { name: "pairs", kind: "table", columns: ["a", "b", "v"], key: ["a", "b"] };
    const got: Row[] = [];
    for await (const page of tablePages(untyped(client), t, 2)) got.push(...page);
    expect(got.map((r) => r.v)).toEqual(["z", "y", "x"]);
    expect(calls.map((c) => c.range)).toEqual([
      [0, 1],
      [2, 3],
      [3, 4],
    ]);
  });

  it("says which table it couldn't read", async () => {
    const { client } = fakeDb({}, { failOn: "invoices" });
    const t: ExportTable = { name: "invoices", kind: "table", columns: ["id"], key: ["id"] };
    await expect(async () => {
      for await (const _ of tablePages(untyped(client), t)) void _;
    }).rejects.toThrow(/couldn't read invoices: permission denied \(42501\)/);
  });
});

describe("CsvParts", () => {
  it("starts each part with the header and says when a part is full", () => {
    const p = new CsvParts(manifestFileName, "a,b\r\n", 2, 1000);
    expect(p.pending).toBe(true);
    expect(p.push("1,2\r\n")).toBe(false);
    expect(p.push("3,4\r\n")).toBe(true);
    expect(p.take()).toEqual({ file: "documents-manifest.csv", text: `${BOM}a,b\r\n1,2\r\n3,4\r\n`, rows: 2 });
    expect(p.pending).toBe(false);
    p.push("5,6\r\n");
    expect(p.take()).toMatchObject({ file: "documents-manifest-part-2.csv", rows: 1 });
  });

  it("splits by size as well as by rows", () => {
    const p = new CsvParts(manifestFileName, "a\r\n", 1000, 10);
    expect(p.push("12345\r\n")).toBe(false);
    expect(p.push("12345\r\n")).toBe(true);
  });
});

describe("the documents manifest", () => {
  const doc: ManifestDocument = {
    id: "d1",
    client_id: "c1",
    title: "GSTR-3B acknowledgement",
    category: "gst",
    financial_year: "2026-27",
    period: "Sep 2026",
    file_name: "3b-sep-v2.pdf",
    file_size: 2048,
    mime_type: "application/pdf",
    sha256: "bb",
    version: 2,
    storage_path: "c1/v2.pdf",
    uploaded_by: "u1",
    created_at: "2026-10-01T05:00:00+00:00",
    updated_at: "2026-10-20T09:30:00+00:00",
    retention_until: "2034-03-31",
    deleted_at: null,
    is_confidential: false,
    shareable_with_client: true,
    client: { client_code: "TW-0042", display_name: "Sharma Traders" },
    document_versions: [
      { version: 1, file_name: "3b-sep.pdf", file_size: 1024, mime_type: "application/pdf", sha256: "aa", storage_path: "c1/v1.pdf", uploaded_by: "u2", created_at: "2026-10-01T05:00:00+00:00" },
      { version: 2, file_name: "3b-sep-v2.pdf", file_size: 2048, mime_type: "application/pdf", sha256: "bb", storage_path: "c1/v2.pdf", uploaded_by: "u1", created_at: "2026-10-20T09:30:00+00:00" },
    ],
  };
  const names = new Map([
    ["u1", "Asha Rao"],
    ["u2", "Vikram Shah"],
  ]);

  it("lists every version, newest first, the current one marked, times in IST", () => {
    const rows = manifestRows(doc, names);
    expect(rows).toHaveLength(2);
    expect(rows[0].length).toBe(MANIFEST_HEADERS.length);
    const col = (r: unknown[], h: (typeof MANIFEST_HEADERS)[number]) => r[MANIFEST_HEADERS.indexOf(h)];
    expect(col(rows[0], "Version")).toBe(2);
    expect(col(rows[0], "Current version")).toBe("Yes");
    expect(col(rows[1], "Current version")).toBe("No");
    expect(col(rows[1], "Storage path")).toBe("c1/v1.pdf");
    expect(col(rows[1], "Uploaded by")).toBe("Vikram Shah");
    expect(col(rows[0], "Uploaded at (IST)")).toBe("2026-10-20 15:00:00");
    expect(col(rows[0], "Category")).toBe("GST");
    expect(col(rows[0], "Client code")).toBe("TW-0042");
    expect(col(rows[0], "Bucket")).toBe("client-documents");
    expect(col(rows[0], "Shared with client")).toBe("Yes");
  });

  it("lists the current file from the document when no version row was kept for it", () => {
    const rows = manifestRows({ ...doc, version: 3, file_name: "3b-final.pdf", storage_path: "c1/v3.pdf", uploaded_by: "u9", document_versions: [] }, names);
    expect(rows).toHaveLength(1);
    expect(rows[0][MANIFEST_HEADERS.indexOf("File name")]).toBe("3b-final.pdf");
    expect(rows[0][MANIFEST_HEADERS.indexOf("Current version")]).toBe("Yes");
    expect(rows[0][MANIFEST_HEADERS.indexOf("Uploaded by")]).toBe("u9"); // no name known: the id
  });

  it("reads instants in IST", () => {
    expect(istStamp("2026-10-22T18:45:10Z")).toBe("2026-10-23 00:15:10");
    expect(istStamp(null)).toBe("");
    expect(istStamp("not a time")).toBe("");
  });
});

describe("readmeText", () => {
  it("says who made it, how to read it, what is left out, and every file", () => {
    const text = readmeText({
      firmName: "TaxWise Consultants",
      preparedBy: { name: "Asha Rao", email: "asha@twchartered.com" },
      preparedAt: new Date("2026-10-24T10:00:00Z"),
      files: [
        { file: "tables/clients.csv", source: "clients", rows: 1240 },
        { file: "tables/audit_logs.csv", source: "audit_logs", rows: 100000 },
        { file: "tables/audit_logs-part-2.csv", source: "audit_logs", rows: 1 },
        { file: "documents-manifest.csv", source: "documents", rows: 3 },
      ],
      documents: 2,
    });
    expect(text).toContain("TaxWise Consultants: full data export from TaxWise CRM");
    expect(text).toContain("Prepared on 24 Oct 2026 at 15:30 IST by Asha Rao (asha@twchartered.com).");
    expect(text).toContain("2 tables in 3 files, and a manifest of 2 files in the document vault.");
    expect(text).toContain("government-portal passwords");
    expect(text).toMatch(/tables\/audit_logs-part-2\.csv\s+1 row\r\n/);
    expect(text).toMatch(/tables\/audit_logs\.csv\s+1,00,000 rows/);
    expect(text).not.toMatch(/[^\x09\x0a\x0d\x20-\x7e]/); // plain ASCII: opens anywhere
  });
});

describe("fullExportChunks", () => {
  const catalog: ExportTable[] = [
    { name: "clients", kind: "table", columns: ["id", "client_code", "display_name", "notes", "notify_channels", "annual_turnover"], key: ["id"] },
    { name: "documents", kind: "table", columns: ["id", "client_id", "file_name"], key: ["id"] },
    { name: "holidays", kind: "table", columns: ["date", "name"], key: ["date"] },
    { name: "profiles", kind: "table", columns: ["id", "full_name", "email"], key: ["id"] },
    { name: "recent_searches", kind: "table", columns: ["id", "query"], key: ["id"] },
  ];
  const clients = [
    { id: "a1", client_code: "TW-0001", display_name: "Sharma Traders", notes: "=HYPERLINK(\"x\")", notify_channels: ["email", "whatsapp"], annual_turnover: -125000.5 },
    { id: "a2", client_code: "TW-0002", display_name: 'Rao & Sons, "Bengaluru"', notes: null, notify_channels: [], annual_turnover: 0 },
    { id: "a3", client_code: "TW-0003", display_name: "Mehta LLP", notes: "Line one\nLine two", notify_channels: ["email"], annual_turnover: null },
  ];
  const documents = [
    {
      id: "d1",
      client_id: "a1",
      title: "PAN card",
      category: "kyc",
      financial_year: null,
      period: null,
      file_name: "pan.pdf",
      file_size: 10,
      mime_type: "application/pdf",
      sha256: null,
      version: 1,
      storage_path: "a1/pan.pdf",
      uploaded_by: "p1",
      created_at: "2026-04-02T04:30:00Z",
      updated_at: "2026-04-02T04:30:00Z",
      retention_until: null,
      deleted_at: null,
      is_confidential: true,
      shareable_with_client: false,
      client: { client_code: "TW-0001", display_name: "Sharma Traders" },
      document_versions: [],
    },
  ];
  const tables = {
    clients,
    documents,
    holidays: [
      { date: "2026-10-02", name: "Gandhi Jayanti" },
      { date: "2026-08-15", name: "Independence Day" },
    ],
    profiles: [{ id: "p1", full_name: "Asha Rao", email: "asha@twchartered.com" }],
    recent_searches: [],
  };
  const opts = { firmName: "TaxWise Consultants", preparedBy: { name: "Asha Rao", email: "asha@twchartered.com" }, now: new Date("2026-10-24T10:00:00Z") };

  it("writes a CSV per table with the readable columns, the manifest and the README", async () => {
    const { client } = fakeDb(tables);
    const zip = readZip(await collect(fullExportChunks(client, catalog, opts)));
    expect([...zip.files.keys()]).toEqual([
      "tables/clients.csv",
      "tables/documents.csv",
      "tables/holidays.csv",
      "tables/profiles.csv",
      "tables/recent_searches.csv",
      "documents-manifest.csv",
      "README.txt",
    ]);
    const csv = zip.files.get("tables/clients.csv")!;
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv.slice(1).split("\r\n")).toEqual([
      "id,client_code,display_name,notes,notify_channels,annual_turnover",
      `a1,TW-0001,Sharma Traders,"'=HYPERLINK(""x"")","[""email"",""whatsapp""]",-125000.5`,
      `a2,TW-0002,"Rao & Sons, ""Bengaluru""",,[],0`,
      `a3,TW-0003,Mehta LLP,"Line one\nLine two","[""email""]",`,
      "",
    ]);
    // An empty table still has its file, with the header row.
    expect(zip.files.get("tables/recent_searches.csv")).toBe(`${BOM}id,query\r\n`);
    // Keyed by date: read in date order.
    expect(zip.files.get("tables/holidays.csv")!.split("\r\n").slice(1, 3)).toEqual(["2026-08-15,Independence Day", "2026-10-02,Gandhi Jayanti"]);

    const manifest = zip.files.get("documents-manifest.csv")!.slice(1).split("\r\n");
    expect(manifest[0]).toBe(MANIFEST_HEADERS.join(","));
    expect(manifest[1]).toContain("TW-0001,Sharma Traders,d1,PAN card,KYC,,,1,Yes,pan.pdf,10,application/pdf,,client-documents,a1/pan.pdf,Asha Rao,2026-04-02 10:00:00,Yes,No,,");

    const readme = zip.files.get("README.txt")!;
    expect(readme).toContain("5 tables in 5 files, and a manifest of 1 file in the document vault.");
    expect(readme).toMatch(/tables\/clients\.csv\s+3 rows/);
    expect(readme).toMatch(/documents-manifest\.csv\s+1 row/);
    expect(zip.comment).toBe("TaxWise Consultants: TaxWise CRM full export, 24 Oct 2026");
  });

  it("splits a large table into parts, each with the header", async () => {
    const { client } = fakeDb(tables);
    const zip = readZip(await collect(fullExportChunks(client, [catalog[0]], { ...opts, partRows: 2, batch: 2 })));
    expect([...zip.files.keys()]).toEqual(["tables/clients.csv", "tables/clients-part-2.csv", "README.txt"]);
    expect(zip.files.get("tables/clients.csv")!.split("\r\n").length).toBe(4); // header, 2 rows, trailing
    expect(zip.files.get("tables/clients-part-2.csv")!.split("\r\n")[0]).toBe(`${BOM}id,client_code,display_name,notes,notify_channels,annual_turnover`);
    expect(zip.files.get("README.txt")).toMatch(/tables\/clients-part-2\.csv\s+1 row/);
  });

  it("writes no empty trailing part when a table fills its last part exactly", async () => {
    const { client } = fakeDb(tables);
    const zip = readZip(await collect(fullExportChunks(client, [catalog[2]], { ...opts, partRows: 2 })));
    expect([...zip.files.keys()]).toEqual(["tables/holidays.csv", "README.txt"]);
  });

  it("leaves out the manifest when the account can't read the vault", async () => {
    const { client } = fakeDb(tables);
    const zip = readZip(await collect(fullExportChunks(client, [catalog[0]], opts)));
    expect(zip.files.has("documents-manifest.csv")).toBe(false);
  });

  it("fails rather than finishing a short archive", async () => {
    const { client } = fakeDb(tables, { failOn: "holidays" });
    await expect(collect(fullExportChunks(client, catalog, opts))).rejects.toThrow(/couldn't read holidays/);
  });
});

describe("fullExportStream", () => {
  it("streams the chunks, then closes", async () => {
    async function* gen() {
      yield new Uint8Array([1, 2]);
      yield new Uint8Array([3]);
    }
    const res = new Response(fullExportStream(gen(), () => {}));
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it("reports an error and errors the stream", async () => {
    const onError = vi.fn();
    async function* gen(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array([1]);
      throw new Error("read failed");
    }
    const res = new Response(fullExportStream(gen(), onError));
    await expect(res.arrayBuffer()).rejects.toThrow();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "read failed" }));
  });

  it("stops reading when the download is cancelled", async () => {
    let finished = false;
    async function* gen(): AsyncGenerator<Uint8Array> {
      try {
        for (;;) yield new Uint8Array([0]);
      } finally {
        finished = true;
      }
    }
    const reader = fullExportStream(gen(), () => {}).getReader();
    await reader.read();
    await reader.cancel();
    expect(finished).toBe(true);
  });
});
