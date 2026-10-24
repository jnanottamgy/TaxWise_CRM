import "server-only";

import { untyped } from "@/lib/supabase/untyped";
import { CSV_BOM, CSV_LINE_END, csvFileName, csvRow } from "@/lib/domain/csv";
import { ZipStoreWriter } from "@/lib/domain/zip";
import { CLIENT_DOCUMENTS_BUCKET } from "@/lib/domain/files";
import { DOCUMENT_CATEGORY_LABELS, type DocumentCategory } from "@/lib/domain/enums";
import { formatDate } from "@/lib/format";

/**
 * The full data export (§7.21 Settings → Data: "full export (ZIP of CSVs for every table + documents
 * manifest)"). Partners only; the route checks the role and two-step sign-in and writes the
 * export_run audit row first (§12).
 *
 * What goes in is decided by the database, never by a list here: full_export_catalog() (0214) names
 * every table the caller's account may read, with exactly the columns it may read (the vault's
 * ciphertext, cost rates in `employees`, quotation link tokens and desktop device keys stay out), and
 * every row is read through the caller's own session, so RLS decides what each file holds.
 *
 * The archive (store method, lib/domain/zip.ts) is streamed: tables are read in pages of 1,000 by
 * their key, each file is written as soon as it is complete, and a table past 100,000 rows or about
 * 24 MB is split into parts, so at most one part is ever held in memory.
 *
 *   tables/<table>.csv, tables/<table>-part-2.csv …   one per readable table (and its parts)
 *   documents-manifest.csv (and parts)                  every file in the document vault, each version
 *   README.txt                                          what is in the archive, file by file
 */

export const EXPORT_BATCH = 1000;
export const PART_MAX_ROWS = 100_000;
export const PART_MAX_CHARS = 24 * 1024 * 1024;

const IDENT = /^[a-z_][a-z0-9_]*$/;

export type ExportTable = {
  name: string;
  kind: "table" | "view";
  columns: string[];
  /** The primary key to page by; null when the table has none. */
  key: string[] | null;
};

/** The catalog as full_export_catalog() returns it, checked: unknown shapes and odd names are dropped. */
export function parseCatalog(raw: unknown): ExportTable[] {
  if (!Array.isArray(raw)) return [];
  const out: ExportTable[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name : "";
    if (!IDENT.test(name) || seen.has(name)) continue;
    const columns = Array.isArray(r.columns) ? r.columns.filter((c): c is string => typeof c === "string" && c.length > 0) : [];
    if (columns.length === 0) continue;
    const key = Array.isArray(r.key) ? r.key.filter((c): c is string => typeof c === "string" && c.length > 0) : [];
    seen.add(name);
    out.push({ name, kind: r.kind === "view" ? "view" : "table", columns, key: key.length ? key : null });
  }
  return out;
}

/** The archive path of one part of a table's file: `tables/clients.csv`, then `tables/clients-part-2.csv`. */
export function tableFileName(table: string, part: number): string {
  const base = csvFileName(table, "csv").replace(/\.csv$/, "");
  return part <= 1 ? `tables/${base}.csv` : `tables/${base}-part-${part}.csv`;
}

/** A column as PostgREST's `select` takes it: plain when it is a simple identifier, quoted otherwise. */
export function selectColumn(name: string): string {
  return IDENT.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

/** How a table is paged: by its single key column (keyset), else by offset in key (or column) order. */
export function pagingPlan(t: ExportTable): { mode: "keyset"; key: string } | { mode: "offset"; order: string[] } {
  const key = (t.key ?? []).filter((k) => t.columns.includes(k));
  if (t.key && t.key.length === 1 && key.length === 1) return { mode: "keyset", key: key[0] };
  if (t.key && key.length === t.key.length) return { mode: "offset", order: key };
  return { mode: "offset", order: t.columns };
}

type Db = ReturnType<typeof untyped>;
type Row = Record<string, unknown>;

function readError(what: string, error: { message?: string; code?: string }): Error {
  const err = new Error(`The full export couldn't read ${what}: ${error.message ?? "unknown error"}${error.code ? ` (${error.code})` : ""}`);
  err.name = "FullExportReadError";
  return err;
}

/**
 * Every row of one table, a page at a time, in key order. Stops on an empty page rather than a short
 * one, so a server row cap smaller than the batch never cuts a table short.
 */
export async function* tablePages(db: Db, t: ExportTable, batch = EXPORT_BATCH): AsyncGenerator<Row[]> {
  const select = t.columns.map(selectColumn).join(",");
  const plan = pagingPlan(t);
  if (plan.mode === "keyset") {
    let last: unknown = undefined;
    for (;;) {
      let q = db.from(t.name).select(select).order(plan.key, { ascending: true }).limit(batch);
      if (last !== undefined) q = q.gt(plan.key, last as string);
      const { data, error } = await q;
      if (error) throw readError(t.name, error);
      const rows = (data ?? []) as unknown as Row[];
      if (rows.length === 0) return;
      yield rows;
      const next = rows[rows.length - 1][plan.key];
      if (next === null || next === undefined) throw readError(t.name, { message: `a row has no ${plan.key}` });
      last = next;
    }
  }
  let offset = 0;
  for (;;) {
    let q = db.from(t.name).select(select);
    for (const c of plan.order) q = q.order(c, { ascending: true, nullsFirst: false });
    const { data, error } = await q.range(offset, offset + batch - 1);
    if (error) throw readError(t.name, error);
    const rows = (data ?? []) as unknown as Row[];
    if (rows.length === 0) return;
    yield rows;
    offset += rows.length;
  }
}

// -------------------------------------------------------------------------------------------------
// The documents manifest
// -------------------------------------------------------------------------------------------------

export const MANIFEST_HEADERS = [
  "Client code",
  "Client",
  "Document id",
  "Title",
  "Category",
  "Financial year",
  "Period",
  "Version",
  "Current version",
  "File name",
  "Size (bytes)",
  "Type",
  "SHA-256",
  "Bucket",
  "Storage path",
  "Uploaded by",
  "Uploaded at (IST)",
  "Confidential",
  "Shared with client",
  "Keep until",
  "In recycle bin since (IST)",
] as const;

export type ManifestVersion = {
  version: number;
  file_name: string;
  file_size: number | null;
  mime_type: string | null;
  sha256: string | null;
  storage_path: string;
  uploaded_by: string | null;
  created_at: string | null;
};

export type ManifestDocument = {
  id: string;
  client_id: string;
  title: string | null;
  category: string | null;
  financial_year: string | null;
  period: string | null;
  file_name: string;
  file_size: number | null;
  mime_type: string | null;
  sha256: string | null;
  version: number;
  storage_path: string;
  uploaded_by: string | null;
  created_at: string | null;
  updated_at: string | null;
  retention_until: string | null;
  deleted_at: string | null;
  is_confidential: boolean | null;
  shareable_with_client: boolean | null;
  client: { client_code: string | null; display_name: string | null } | null;
  document_versions: ManifestVersion[] | null;
};

const IST_MS = 330 * 60 * 1000;

/** `2026-10-22 14:05:33`, read in IST: sorts as text and opens as a date-time in a spreadsheet. */
export function istStamp(at: string | null | undefined): string {
  if (!at) return "";
  const ms = new Date(at).getTime();
  if (!Number.isFinite(ms)) return "";
  return new Date(ms + IST_MS).toISOString().slice(0, 19).replace("T", " ");
}

function categoryLabel(c: string | null): string {
  if (!c) return "";
  return (DOCUMENT_CATEGORY_LABELS as Record<string, string>)[c as DocumentCategory] ?? c;
}

/**
 * The manifest rows of one document: every stored version, newest first, the current one marked.
 * A document made before versions were kept has no version row for its current file; that file is
 * listed from the document itself.
 */
export function manifestRows(d: ManifestDocument, names: ReadonlyMap<string, string>): unknown[][] {
  const versions = [...(d.document_versions ?? [])];
  if (!versions.some((v) => v.version === d.version)) {
    versions.push({
      version: d.version,
      file_name: d.file_name,
      file_size: d.file_size,
      mime_type: d.mime_type,
      sha256: d.sha256,
      storage_path: d.storage_path,
      uploaded_by: d.uploaded_by,
      created_at: d.updated_at ?? d.created_at,
    });
  }
  versions.sort((a, b) => b.version - a.version);
  return versions.map((v) => [
    d.client?.client_code ?? "",
    d.client?.display_name ?? "",
    d.id,
    d.title ?? "",
    categoryLabel(d.category),
    d.financial_year ?? "",
    d.period ?? "",
    v.version,
    v.version === d.version ? "Yes" : "No",
    v.file_name,
    v.file_size ?? "",
    v.mime_type ?? "",
    v.sha256 ?? "",
    CLIENT_DOCUMENTS_BUCKET,
    v.storage_path,
    v.uploaded_by ? (names.get(v.uploaded_by) ?? v.uploaded_by) : "",
    istStamp(v.created_at),
    d.is_confidential ? "Yes" : "No",
    d.shareable_with_client ? "Yes" : "No",
    d.retention_until ?? "",
    istStamp(d.deleted_at),
  ]);
}

const MANIFEST_SELECT =
  "id, client_id, title, category, financial_year, period, file_name, file_size, mime_type, sha256, version, storage_path, uploaded_by, created_at, updated_at, retention_until, deleted_at, is_confidential, shareable_with_client, " +
  "client:clients(client_code, display_name), document_versions(version, file_name, file_size, mime_type, sha256, storage_path, uploaded_by, created_at)";

async function* documentPages(db: Db, batch: number): AsyncGenerator<ManifestDocument[]> {
  let last: string | null = null;
  for (;;) {
    let q = db.from("documents").select(MANIFEST_SELECT).order("id", { ascending: true }).limit(batch);
    if (last) q = q.gt("id", last);
    const { data, error } = await q;
    if (error) throw readError("the document vault", error);
    const rows = (data ?? []) as unknown as ManifestDocument[];
    if (rows.length === 0) return;
    yield rows;
    last = rows[rows.length - 1].id;
  }
}

/** Who is who, for the manifest's "Uploaded by": every profile the caller may read. */
async function profileNames(db: Db, batch: number): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for await (const page of tablePages(db, { name: "profiles", kind: "table", columns: ["id", "full_name", "email"], key: ["id"] }, batch)) {
    for (const p of page) {
      const id = typeof p.id === "string" ? p.id : null;
      const name = typeof p.full_name === "string" && p.full_name ? p.full_name : typeof p.email === "string" ? p.email : null;
      if (id && name) names.set(id, name);
    }
  }
  return names;
}

// -------------------------------------------------------------------------------------------------
// README
// -------------------------------------------------------------------------------------------------

export type ExportFile = { file: string; source: string; rows: number };

export type ReadmeInput = {
  firmName: string;
  preparedBy: { name: string; email: string };
  preparedAt: Date;
  files: readonly ExportFile[];
  documents: number;
};

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;
}

/** The archive's README: who made it and when, how to read the files, what is left out, every file. */
export function readmeText(r: ReadmeInput): string {
  const stamp = istStamp(r.preparedAt.toISOString());
  const day = formatDate(stamp.slice(0, 10));
  const tables = r.files.filter((f) => f.file.startsWith("tables/"));
  const sources = new Set(tables.map((f) => f.source));
  const width = Math.max(...r.files.map((f) => f.file.length), 20);
  const lines: string[] = [
    `${r.firmName}: full data export from TaxWise CRM`,
    "",
    `Prepared on ${day} at ${stamp.slice(11, 16)} IST by ${r.preparedBy.name} (${r.preparedBy.email}).`,
    `${plural(sources.size, "table")} in ${plural(tables.length, "file")}, and a manifest of ${plural(r.documents, "file")} in the document vault.`,
    "",
    "This archive holds clients' personal data and the firm's fees. Keep it encrypted, share it with no",
    "one who would not see the same in the CRM, and delete it once it has served its purpose.",
    "",
    "WHAT IS IN IT",
    "",
    "tables/       One CSV file for every table this account can read, with every column it can read.",
    "              A large table (over 100,000 rows or about 24 MB) is split into parts: <table>.csv,",
    "              <table>-part-2.csv and so on, each starting with the header row.",
    "documents-manifest.csv",
    "              Every file in the document vault, each version on its own row, with where it is",
    "              stored (bucket and path). The files themselves are not in this archive: download them",
    "              from the vault in the CRM. Files attached to tasks, messages and notices are listed",
    "              in their own tables.",
    "",
    "READING THE FILES",
    "",
    "- UTF-8 with a byte-order mark, comma-separated, one row per line (CRLF). The first row names the",
    "  columns as they are in the database.",
    "- Times are ISO 8601 in UTC (2026-10-22T08:35:33+00:00); the manifest's times are IST. Dates are",
    "  YYYY-MM-DD. Amounts are in rupees, as stored.",
    "- Lists and structured values are written as JSON.",
    "- A text value that starts with =, +, -, @ or a tab has an apostrophe put in front, so a spreadsheet",
    "  can't run it as a formula. Plain negative numbers are left as they are.",
    "",
    "LEFT OUT",
    "",
    "- Saved government-portal passwords. The vault is in client_credentials_list.csv without them.",
    "- Quotation link tokens and desktop device keys, which work as keys rather than records.",
    "- Employees' cost rates are not in employees.csv; they are in employee_cost_rates.csv.",
    "- Anything this account can't open in the CRM.",
    "",
    "FILES",
    "",
    ...r.files.map((f) => `${f.file.padEnd(width)}  ${plural(f.rows, "row")}`),
    "",
  ];
  return lines.join(CSV_LINE_END);
}

// -------------------------------------------------------------------------------------------------
// The archive
// -------------------------------------------------------------------------------------------------

/** The manifest's archive path: `documents-manifest.csv`, then `documents-manifest-part-2.csv`. */
export function manifestFileName(part: number): string {
  return part <= 1 ? "documents-manifest.csv" : `documents-manifest-part-${part}.csv`;
}

/**
 * Collects one CSV file's lines and says when a part is full (`maxRows` rows or about `maxChars`
 * characters). Each part starts with the header row.
 */
export class CsvParts {
  private lines: string[] = [];
  private chars = 0;
  private count = 0;
  private part = 1;

  constructor(
    private readonly fileName: (part: number) => string,
    private readonly header: string,
    private readonly maxRows: number,
    private readonly maxChars: number,
  ) {}

  /** Adds a row (already a CSV line); true when the part is now full. */
  push(line: string): boolean {
    this.lines.push(line);
    this.chars += line.length;
    this.count += 1;
    return this.count >= this.maxRows || this.chars >= this.maxChars;
  }

  /** True while the file still needs writing: rows waiting, or nothing written yet (header only). */
  get pending(): boolean {
    return this.count > 0 || this.part === 1;
  }

  /** The part's name, text and row count; the next push starts the next part. */
  take(): { file: string; text: string; rows: number } {
    const out = { file: this.fileName(this.part), text: CSV_BOM + this.header + this.lines.join(""), rows: this.count };
    this.lines = [];
    this.chars = 0;
    this.count = 0;
    this.part += 1;
    return out;
  }
}

export type FullExportOptions = {
  firmName: string;
  preparedBy: { name: string; email: string };
  /** For tests. */
  now?: Date;
  batch?: number;
  partRows?: number;
  partChars?: number;
};

/**
 * The archive's bytes, in order, as they are ready. Reads through `supabase` (the caller's session).
 * Throws (the stream then errors and the download fails) rather than finishing a partial archive
 * that could be mistaken for a complete one.
 */
export async function* fullExportChunks(supabase: unknown, catalog: readonly ExportTable[], opts: FullExportOptions): AsyncGenerator<Uint8Array> {
  const db = untyped(supabase);
  const now = opts.now ?? new Date();
  const batch = opts.batch ?? EXPORT_BATCH;
  const partRows = opts.partRows ?? PART_MAX_ROWS;
  const partChars = opts.partChars ?? PART_MAX_CHARS;
  const encoder = new TextEncoder();
  const zip = new ZipStoreWriter();
  const files: ExportFile[] = [];

  function* write(parts: CsvParts, source: string): Generator<Uint8Array> {
    const p = parts.take();
    for (const chunk of zip.add(p.file, encoder.encode(p.text), now)) yield chunk;
    files.push({ file: p.file, source, rows: p.rows });
  }

  for (const t of catalog) {
    const parts = new CsvParts((n) => tableFileName(t.name, n), csvRow(t.columns), partRows, partChars);
    for await (const page of tablePages(db, t, batch)) {
      for (const r of page) {
        if (parts.push(csvRow(t.columns.map((c) => r[c])))) yield* write(parts, t.name);
      }
    }
    if (parts.pending) yield* write(parts, t.name);
  }

  let documents = 0;
  if (catalog.some((t) => t.name === "documents")) {
    const names = catalog.some((t) => t.name === "profiles") ? await profileNames(db, batch) : new Map<string, string>();
    const parts = new CsvParts(manifestFileName, csvRow(MANIFEST_HEADERS), partRows, partChars);
    for await (const page of documentPages(db, Math.min(batch, 500))) {
      for (const d of page) {
        documents += 1;
        for (const row of manifestRows(d, names)) {
          if (parts.push(csvRow(row))) yield* write(parts, "documents");
        }
      }
    }
    if (parts.pending) yield* write(parts, "documents");
  }

  const readme = readmeText({ firmName: opts.firmName, preparedBy: opts.preparedBy, preparedAt: now, files, documents });
  for (const chunk of zip.add("README.txt", encoder.encode(readme), now)) yield chunk;
  yield zip.finish(`${opts.firmName}: TaxWise CRM full export, ${formatDate(istStamp(now.toISOString()).slice(0, 10))}`);
}

/** The archive as a byte stream for a Response. Pull-based, so a slow download slows the reads. */
export function fullExportStream(chunks: AsyncGenerator<Uint8Array>, onError: (err: unknown) => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await chunks.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (err) {
        onError(err);
        controller.error(err);
      }
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
}
