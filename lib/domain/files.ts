/**
 * Files in the document vault (§5.8, §7.14, §12): which files may be uploaded, how a file's real
 * type is read from its first bytes (never from its extension alone), how file names are cleaned,
 * the title a file gets by default, where it is stored, the SHA-256 duplicate check and the
 * retention date a new document gets.
 *
 * - **Allowed** (§5.8): PDF, JPG/JPEG, PNG, HEIC, CSV, XLS, XLSX, DOC, DOCX, at most 25 MB. Anything
 *   else is refused with the reason (`checkFile`).
 * - **Type by magic bytes** (§12): `sniffFileType` reads the signature (PDF, PNG, JPEG, the HEIF
 *   `ftyp` box, the ZIP container of DOCX/XLSX and its `word/` or `xl/` entries, the OLE2 container
 *   of DOC/XLS and its `WordDocument` / `Workbook` streams, plain text for CSV). The browser checks
 *   the first `SNIFF_BYTES` before uploading; the server checks the whole stored object again before
 *   the document exists (`complete: true` makes the container checks strict).
 * - **A wrong extension is corrected**, not refused: a HEIC photo named `.jpg` is stored as `.heic`
 *   and the person is told.
 * - **Storage path** (§5.8, 0043): `<client_id>/<uuid>.<ext>` in the private `client-documents`
 *   bucket; the database refuses any path outside the document's client folder.
 * - **Retention** (§5.8, §6.8): every vault document is at least engagement documentation (SQC 1), so
 *   the upload date + 7 years always applies; the statutory rule for the document's category and FY
 *   (GST records, income-tax records, a company's books) extends it when longer.
 *
 * Pure and client-safe; `sha256Hex` uses Web Crypto, which browsers and Node both provide.
 */

import type { DocumentCategory, EntityType } from "@/lib/domain/enums";
import { diffDays, isFinancialYear, type DateString } from "@/lib/domain/fy";
import { RETENTION_DEFAULTS, retentionUntil, type RetentionContext, type RetentionParams, type RetentionResult } from "@/lib/domain/retention";

// -------------------------------------------------------------------------------------------------
// Limits and allowed types (§5.8)
// -------------------------------------------------------------------------------------------------

/** 25 MB (the `documents_file_size_limit` check and the bucket's file_size_limit). */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Same limit under the name the platform contract uses. */
export const MAX_BYTES = MAX_FILE_BYTES;
/** How many leading bytes the browser reads to check a file before uploading it. */
export const SNIFF_BYTES = 64 * 1024;
/** Files one upload may carry at once (the drop zone refuses more). */
export const MAX_FILES_PER_UPLOAD = 20;
/** The private bucket of the vault (0041). */
export const CLIENT_DOCUMENTS_BUCKET = "client-documents";

export const FILE_KINDS = ["pdf", "jpeg", "png", "heic", "csv", "xls", "xlsx", "doc", "docx"] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export interface FileTypeInfo {
  kind: FileKind;
  /** The MIME type stored and served for this kind. */
  mime: string;
  /** The extension the stored object gets. */
  ext: string;
  /** Every extension that names this kind (lower case, no dot). */
  extensions: readonly string[];
  /** What people call it: "PDF", "Excel workbook". */
  label: string;
  /** Inline preview (§7.14 "Preview for PDF and images"); HEIC isn't shown by most browsers. */
  preview: "pdf" | "image" | null;
}

export const FILE_TYPES: Readonly<Record<FileKind, FileTypeInfo>> = {
  pdf: { kind: "pdf", mime: "application/pdf", ext: "pdf", extensions: ["pdf"], label: "PDF", preview: "pdf" },
  jpeg: { kind: "jpeg", mime: "image/jpeg", ext: "jpg", extensions: ["jpg", "jpeg"], label: "JPG image", preview: "image" },
  png: { kind: "png", mime: "image/png", ext: "png", extensions: ["png"], label: "PNG image", preview: "image" },
  heic: { kind: "heic", mime: "image/heic", ext: "heic", extensions: ["heic", "heif"], label: "HEIC photo", preview: null },
  csv: { kind: "csv", mime: "text/csv", ext: "csv", extensions: ["csv"], label: "CSV file", preview: null },
  xls: { kind: "xls", mime: "application/vnd.ms-excel", ext: "xls", extensions: ["xls"], label: "Excel workbook (XLS)", preview: null },
  xlsx: {
    kind: "xlsx",
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ext: "xlsx",
    extensions: ["xlsx"],
    label: "Excel workbook",
    preview: null,
  },
  doc: { kind: "doc", mime: "application/msword", ext: "doc", extensions: ["doc"], label: "Word document (DOC)", preview: null },
  docx: {
    kind: "docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ext: "docx",
    extensions: ["docx"],
    label: "Word document",
    preview: null,
  },
};

/** Every MIME type the vault stores. */
export const ALLOWED_MIME: readonly string[] = FILE_KINDS.map((k) => FILE_TYPES[k].mime);
/** Every extension the vault accepts (lower case, no dot). */
export const ALLOWED_EXTENSIONS: readonly string[] = FILE_KINDS.flatMap((k) => FILE_TYPES[k].extensions);
/** For `<input type="file" accept>`: extensions and MIME types (some phones only match MIME types). */
export const ACCEPT_ATTRIBUTE = [...ALLOWED_EXTENSIONS.map((e) => `.${e}`), ...ALLOWED_MIME, "image/heif"].join(",");
/** The allowed types in a sentence, for helper text and refusals. */
export const ALLOWED_TYPES_SENTENCE = "PDF, JPG, PNG, HEIC, CSV, Excel (XLS, XLSX) or Word (DOC, DOCX)";

export function isFileKind(v: unknown): v is FileKind {
  return typeof v === "string" && (FILE_KINDS as readonly string[]).includes(v);
}

/** The kind stored under a MIME type, or null. */
export function fileTypeOfMime(mime: string | null | undefined): FileTypeInfo | null {
  if (!mime) return null;
  const m = mime.split(";")[0].trim().toLowerCase();
  if (m === "image/heif") return FILE_TYPES.heic;
  return FILE_KINDS.map((k) => FILE_TYPES[k]).find((t) => t.mime === m) ?? null;
}

/** The kind an extension names, or null. */
export function fileTypeOfExtension(ext: string | null | undefined): FileTypeInfo | null {
  if (!ext) return null;
  const e = ext.replace(/^\./, "").toLowerCase();
  return FILE_KINDS.map((k) => FILE_TYPES[k]).find((t) => t.extensions.includes(e)) ?? null;
}

/** How a stored document can be previewed in the app (§7.14): PDF and JPG/PNG images. */
export function previewKind(mime: string | null | undefined): "pdf" | "image" | null {
  return fileTypeOfMime(mime)?.preview ?? null;
}

// -------------------------------------------------------------------------------------------------
// File names (§12 "filenames sanitised") and default titles (§7.14)
// -------------------------------------------------------------------------------------------------

const MAX_FILE_NAME = 150;
const MAX_TITLE = 200;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** The extension of a file name, lower case without the dot ("" when there is none). */
export function extensionOf(name: string | null | undefined): string {
  if (!name) return "";
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

function splitName(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return { base: name, ext: "" };
  return { base: name.slice(0, dot), ext: name.slice(dot + 1) };
}

/**
 * A file name that is safe to store and to offer back as a download (§12): no folder parts, no
 * control characters, none of `< > : " / \ | ? *`, single spaces, no leading or trailing dots, at most
 * 150 characters (the extension kept), never empty and never a reserved device name. Letters of any
 * script are kept, so "बैंक स्टेटमेंट.pdf" stays readable.
 */
export function sanitizeFileName(raw: string | null | undefined, fallback = "document"): string {
  let name = String(raw ?? "")
    .split(/[\\/]/)
    .pop()!
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, "")
    .replace(/[<>:"|?*]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "");
  let { base, ext } = splitName(name);
  base = base.trim().replace(/[.\s]+$/, "");
  ext = ext.replace(/[^A-Za-z0-9]/g, "").slice(0, 10);
  if (!base) base = fallback;
  if (WINDOWS_RESERVED.test(base)) base = `${base}-file`;
  const suffix = ext ? `.${ext}` : "";
  const room = MAX_FILE_NAME - suffix.length;
  if (base.length > room) base = Array.from(base).slice(0, room).join("").trim();
  name = `${base}${suffix}`;
  return name;
}

/** The same name with another extension: `withExtension("IMG_2041.jpg", "heic")` → `IMG_2041.heic`. */
export function withExtension(name: string, ext: string): string {
  const { base } = splitName(name);
  return `${base || "document"}.${ext.replace(/^\./, "")}`;
}

/**
 * The title a file gets by default (§7.14 "title (defaults from the file name)"): the name without
 * its extension, underscores and runs of spaces as single spaces. Hyphens stay, so "GSTR-3B" is kept.
 */
export function titleFromFileName(name: string | null | undefined): string {
  const clean = sanitizeFileName(name, "");
  const { base } = splitName(clean);
  const title = base.replace(/_+/g, " ").replace(/\s+/g, " ").trim();
  return title ? Array.from(title).slice(0, MAX_TITLE).join("") : "Untitled document";
}

// -------------------------------------------------------------------------------------------------
// Magic bytes (§12 "MIME type checked by magic bytes, not just extension")
// -------------------------------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP_LOCAL = [0x50, 0x4b, 0x03, 0x04];
const ZIP_CENTRAL = [0x50, 0x4b, 0x01, 0x02];
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"]);
const HEIF_GENERIC_BRANDS = new Set(["mif1", "msf1"]);

function startsWith(bytes: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[offset + i] !== sig[i]) return false;
  return true;
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  let s = "";
  for (let i = from; i < Math.min(to, bytes.length); i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function indexOfBytes(bytes: Uint8Array, needle: readonly number[], from = 0, limit = bytes.length): number {
  const end = Math.min(limit, bytes.length) - needle.length;
  outer: for (let i = from; i <= end; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function utf16le(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) out.push(ch.charCodeAt(0) & 0xff, ch.charCodeAt(0) >> 8);
  return out;
}

/** PDF: "%PDF-" within the first 1024 bytes (readers accept a short preamble). */
function isPdf(bytes: Uint8Array): boolean {
  return indexOfBytes(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d], 0, 1024 + 5) >= 0;
}

/** HEIC/HEIF: an `ftyp` box whose major or compatible brands are HEVC-coded HEIF (not AVIF). */
function isHeic(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || ascii(bytes, 4, 8) !== "ftyp") return false;
  const boxSize = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  const major = ascii(bytes, 8, 12);
  if (HEIC_BRANDS.has(major)) return true;
  if (!HEIF_GENERIC_BRANDS.has(major)) return false;
  const end = Math.min(boxSize >= 16 ? boxSize : 16, bytes.length, 256);
  for (let i = 16; i + 4 <= end; i += 4) {
    if (HEIC_BRANDS.has(ascii(bytes, i, i + 4))) return true;
  }
  return false;
}

/** The kind of an Office Open XML container, from its entry names (`word/…` or `xl/…`). */
function zipOfficeKind(bytes: Uint8Array): "docx" | "xlsx" | "other" | null {
  let sawOther = false;
  const visit = (name: string): "docx" | "xlsx" | null => {
    if (name.startsWith("word/")) return "docx";
    if (name.startsWith("xl/")) return "xlsx";
    if (name.startsWith("ppt/") || name.startsWith("visio/")) sawOther = true;
    return null;
  };
  for (const [sig, lenAt, nameAt] of [
    [ZIP_LOCAL, 26, 30],
    [ZIP_CENTRAL, 28, 46],
  ] as const) {
    let at = indexOfBytes(bytes, sig);
    let guard = 0;
    while (at >= 0 && guard++ < 5000) {
      if (at + nameAt <= bytes.length) {
        const nameLen = bytes[at + lenAt] | (bytes[at + lenAt + 1] << 8);
        if (nameLen > 0 && nameLen < 512 && at + nameAt + nameLen <= bytes.length) {
          const found = visit(ascii(bytes, at + nameAt, at + nameAt + nameLen));
          if (found) return found;
        }
      }
      at = indexOfBytes(bytes, sig, at + 4);
    }
  }
  return sawOther ? "other" : null;
}

/** The kind of a legacy Office (OLE2 compound file) document, from its stream names. */
function oleOfficeKind(bytes: Uint8Array): "doc" | "xls" | "book" | "other" | null {
  if (indexOfBytes(bytes, utf16le("WordDocument")) >= 0) return "doc";
  if (indexOfBytes(bytes, utf16le("Workbook")) >= 0) return "xls";
  if (indexOfBytes(bytes, utf16le("PowerPoint Document")) >= 0) return "other";
  if (indexOfBytes(bytes, utf16le("Book")) >= 0) return "book";
  return null;
}

/** Plain text that is safe to call CSV: no NUL bytes, almost no control characters, not markup. */
function looksLikeCsvText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  let start = 0;
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) start = 3;
  let control = 0;
  const end = Math.min(bytes.length, SNIFF_BYTES);
  for (let i = start; i < end; i++) {
    const b = bytes[i];
    if (b === 0) return false;
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) control++;
  }
  if (control > Math.max(2, (end - start) / 100)) return false;
  const head = ascii(bytes, start, start + 64).trimStart().toLowerCase();
  return !/^<(!doctype|html|head|body|script|svg|\?xml|iframe|object)/.test(head);
}

export interface SniffOptions {
  /** The file's name: decides between container kinds the leading bytes can't tell apart. */
  fileName?: string | null;
  /**
   * The bytes are the whole file (the server's check). Then a ZIP or OLE2 file must show its Word
   * or Excel parts; with only the leading bytes (the browser's check) the extension decides.
   */
  complete?: boolean;
}

/**
 * The real kind of a file from its bytes (§12), or null when it isn't one the vault accepts.
 *
 *   sniffFileType(bytes)                                    → "pdf" | "png" | "jpeg" | "heic" | …
 *   sniffFileType(zipBytes, { fileName: "Sales.xlsx" })     → "xlsx" (browser, leading bytes)
 *   sniffFileType(zipBytes, { complete: true })             → "xlsx" only if it has xl/ parts
 */
export function sniffFileType(bytes: Uint8Array, opts: SniffOptions = {}): FileKind | null {
  if (!bytes || bytes.length === 0) return null;
  const ext = extensionOf(opts.fileName);
  if (startsWith(bytes, PNG_SIGNATURE)) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (isHeic(bytes)) return "heic";
  if (startsWith(bytes, ZIP_LOCAL)) {
    const kind = zipOfficeKind(bytes);
    if (kind === "docx" || kind === "xlsx") return kind;
    if (kind === "other" || opts.complete) return null;
    return ext === "docx" ? "docx" : ext === "xlsx" ? "xlsx" : null;
  }
  if (startsWith(bytes, OLE_SIGNATURE)) {
    const kind = oleOfficeKind(bytes);
    if (kind === "doc" || kind === "xls") return kind;
    if (kind === "other") return null;
    // "Book" is the stream of Excel 5/95 workbooks; with only the leading bytes a Word file's
    // directory may not have been read yet, so the name decides until the server sees it all.
    if (kind === "book") return ext === "doc" && !opts.complete ? "doc" : "xls";
    if (opts.complete) return null;
    return ext === "doc" ? "doc" : ext === "xls" ? "xls" : null;
  }
  if (isPdf(bytes)) return "pdf";
  if (ext === "csv" && looksLikeCsvText(bytes)) return "csv";
  return null;
}

/** The MIME type of a file from its bytes (the platform contract's `sniffMime`), or null. */
export function sniffMime(bytes: Uint8Array, opts: SniffOptions = {}): string | null {
  const kind = sniffFileType(bytes, opts);
  return kind ? FILE_TYPES[kind].mime : null;
}

// -------------------------------------------------------------------------------------------------
// The whole check (§5.8 "Reject anything else with the reason")
// -------------------------------------------------------------------------------------------------

export type FileRejection = "empty" | "too_large" | "type" | "damaged";

export type FileCheck =
  | {
      ok: true;
      kind: FileKind;
      mime: string;
      /** The cleaned name, with the extension corrected to the real type when it was wrong. */
      fileName: string;
      /** A note for the person when the name was changed ("Saved as .heic: …"). */
      note: string | null;
    }
  | { ok: false; code: FileRejection; reason: string };

/** "820 KB", "1.2 MB", "25 MB": sizes as people read them (binary units, as Windows shows them). */
export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1).replace(/\.0$/, "") : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1).replace(/\.0$/, "") : Math.round(mb)} MB`;
}

/**
 * Checks one file against the vault's rules: not empty, at most 25 MB, and really one of the
 * allowed types by its bytes. Returns the cleaned file name and MIME type to store, or the reason
 * in a sentence the person can act on.
 */
export function checkFile(input: { name: string; size: number; bytes: Uint8Array; complete?: boolean }): FileCheck {
  const cleaned = sanitizeFileName(input.name);
  if (!Number.isFinite(input.size) || input.size <= 0 || input.bytes.length === 0) {
    return { ok: false, code: "empty", reason: "This file is empty. Check it opens on your computer, then try again." };
  }
  if (input.size > MAX_FILE_BYTES) {
    return { ok: false, code: "too_large", reason: `This file is ${formatFileSize(input.size)}. Files can be at most 25 MB: split it, or save a smaller copy.` };
  }
  const kind = sniffFileType(input.bytes, { fileName: cleaned, complete: input.complete });
  const ext = extensionOf(cleaned);
  const named = fileTypeOfExtension(ext);
  if (!kind) {
    if (named) {
      return {
        ok: false,
        code: "damaged",
        reason: `This file is named .${ext} but isn't a real ${named.label}. It may be damaged, password-protected in an unusual way, or renamed from another type.`,
      };
    }
    return {
      ok: false,
      code: "type",
      reason: `${ext ? `.${ext} files` : "Files of this type"} can't be uploaded. Upload ${ALLOWED_TYPES_SENTENCE}.`,
    };
  }
  const type = FILE_TYPES[kind];
  if (named?.kind === kind) return { ok: true, kind, mime: type.mime, fileName: cleaned, note: null };
  const fileName = withExtension(cleaned, type.ext);
  return {
    ok: true,
    kind,
    mime: type.mime,
    fileName,
    note: ext ? `Saved as .${type.ext}: the file is a ${type.label}, not a .${ext} file.` : `Saved as .${type.ext}: the file is a ${type.label}.`,
  };
}

// -------------------------------------------------------------------------------------------------
// Storage paths (§5.8, 0043 storage_path_in_client_folder)
// -------------------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

/** `<client_id>/<object_id>.<ext>`: where a new vault file is stored (§5.8). */
export function documentStoragePath(clientId: string, objectId: string, kind: FileKind): string {
  if (!isUuid(clientId) || !isUuid(objectId)) throw new RangeError("Storage paths are built from a client id and a new uuid.");
  return `${clientId.toLowerCase()}/${objectId.toLowerCase()}.${FILE_TYPES[kind].ext}`;
}

/** The object's name inside the bucket: older rows store `client-documents/<client_id>/…`. */
export function objectNameOf(storagePath: string): string {
  return storagePath.startsWith(`${CLIENT_DOCUMENTS_BUCKET}/`) ? storagePath.slice(CLIENT_DOCUMENTS_BUCKET.length + 1) : storagePath;
}

/**
 * True when a path is inside the client's folder with no `.`/`..`/empty segments (mirrors
 * storage_path_in_client_folder in 0043, which the database enforces on every row).
 */
export function isInClientFolder(storagePath: string, clientId: string): boolean {
  if (!isUuid(clientId) || typeof storagePath !== "string") return false;
  const name = objectNameOf(storagePath);
  const parts = name.split("/");
  if (parts.length < 2 || parts[0].toLowerCase() !== clientId.toLowerCase()) return false;
  return parts.slice(1).every((p) => p !== "" && p !== "." && p !== "..");
}

// -------------------------------------------------------------------------------------------------
// SHA-256 and duplicates (§7.14 "Duplicate warning by SHA-256")
// -------------------------------------------------------------------------------------------------

export function isSha256Hex(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
}

/** The SHA-256 of a file's bytes as lower-case hex (Web Crypto: browser and server). */
export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const view = data instanceof Uint8Array ? data : new Uint8Array(data);
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ExistingFile {
  sha256: string | null;
}

/**
 * Which of the files about to be uploaded are already in the vault, or repeat an earlier file of
 * the same batch. `files` are keyed by the caller (a row id in the uploader); `existing` are the
 * client's documents with the same hashes (from the RLS-scoped lookup).
 */
export function findDuplicates<E extends ExistingFile>(
  files: ReadonlyArray<{ key: string; sha256: string | null }>,
  existing: readonly E[],
): Map<string, { inVault: E[]; sameAsKey: string | null }> {
  const byHash = new Map<string, E[]>();
  for (const e of existing) {
    if (!e.sha256) continue;
    const list = byHash.get(e.sha256) ?? [];
    list.push(e);
    byHash.set(e.sha256, list);
  }
  const firstInBatch = new Map<string, string>();
  const out = new Map<string, { inVault: E[]; sameAsKey: string | null }>();
  for (const f of files) {
    if (!f.sha256) continue;
    const inVault = byHash.get(f.sha256) ?? [];
    const earlier = firstInBatch.get(f.sha256) ?? null;
    if (!earlier) firstInBatch.set(f.sha256, f.key);
    if (inVault.length > 0 || earlier) out.set(f.key, { inVault, sameAsKey: earlier });
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// Retention of a new document (§5.8, §6.8)
// -------------------------------------------------------------------------------------------------

const COMPANY_ENTITIES: ReadonlySet<EntityType> = new Set<EntityType>(["pvt_ltd", "public_ltd", "section_8"]);
const COMPANY_BOOK_CATEGORIES: ReadonlySet<DocumentCategory> = new Set<DocumentCategory>(["bank_statements", "invoices", "payroll"]);

export interface UploadRetentionInput {
  /** The upload date in IST. */
  uploadedOn: DateString;
  category: DocumentCategory;
  /** The FY the document relates to ("2025-26"), when known. */
  financialYear?: string | null;
  /** The client's entity type: a company's books are kept 8 FYs (s.128(5)). */
  entityType?: EntityType | null;
}

/**
 * `retention_until` for a new document (§5.8 default upload date + 7 years; §6.8 the longest rule
 * that applies): the 7-year floor always counts, and the category's statutory rule extends it:
 * GST documents of an FY → 72 months from that FY's annual return due date (s.36); income-tax and
 * TDS documents → 6 years from the end of the assessment year; a company's bank statements,
 * invoices and payroll → the end of FY + 8 (s.128(5)).
 */
export function uploadRetention(input: UploadRetentionInput, params: RetentionParams = RETENTION_DEFAULTS): RetentionResult {
  const fy = input.financialYear && isFinancialYear(input.financialYear) ? input.financialYear : null;
  const ctx: RetentionContext = { uploadedOn: input.uploadedOn };
  if (fy && input.category === "gst") ctx.gstFinancialYear = fy;
  if (fy && (input.category === "income_tax" || input.category === "tds")) ctx.incomeTaxFinancialYear = fy;
  if (fy && input.entityType && COMPANY_ENTITIES.has(input.entityType) && COMPANY_BOOK_CATEGORIES.has(input.category)) {
    ctx.companyBooksFinancialYear = fy;
  }
  const floor = retentionUntil({ uploadedOn: input.uploadedOn }, params);
  const rule = retentionUntil(ctx, params);
  if (rule.rule === "default") return floor;
  const candidates = [...rule.candidates, ...floor.candidates];
  return diffDays(rule.until, floor.until) > 0 ? { ...rule, candidates } : { ...floor, candidates };
}
