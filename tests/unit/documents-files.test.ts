import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ACCEPT_ATTRIBUTE,
  ALLOWED_MIME,
  checkFile,
  documentStoragePath,
  extensionOf,
  fileTypeOfExtension,
  fileTypeOfMime,
  findDuplicates,
  formatFileSize,
  isInClientFolder,
  MAX_FILE_BYTES,
  objectNameOf,
  previewKind,
  sanitizeFileName,
  sha256Hex,
  sniffFileType,
  sniffMime,
  titleFromFileName,
  uploadRetention,
  withExtension,
} from "@/lib/domain/files";

// -------------------------------------------------------------------------------------------------
// Byte fixtures
// -------------------------------------------------------------------------------------------------

const bytes = (...parts: Array<number[] | string | Uint8Array>): Uint8Array => {
  const out: number[] = [];
  for (const p of parts) {
    if (typeof p === "string") for (const ch of p) out.push(ch.charCodeAt(0) & 0xff);
    else out.push(...p);
  }
  return Uint8Array.from(out);
};

const utf16 = (s: string) => Array.from(s).flatMap((c) => [c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8]);
const pad = (n: number, v = 0x20) => Array.from({ length: n }, () => v);

/** A ZIP local file header for `name` followed by a few bytes of "data". */
function zipEntry(name: string): number[] {
  const header = [0x50, 0x4b, 0x03, 0x04, ...pad(22, 0), name.length & 0xff, name.length >> 8, 0, 0];
  return [...header, ...Array.from(name, (c) => c.charCodeAt(0)), ...pad(16, 0x11)];
}
const zip = (...names: string[]) => bytes(...names.map(zipEntry));

const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ole = (...streams: string[]) => bytes(OLE, pad(500, 0), ...streams.map((s) => [...utf16(s), 0, 0, ...pad(40, 0)]));

const PDF = bytes("%PDF-1.7\n%âãÏÓ\n1 0 obj");
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], pad(20, 0));
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0], pad(20, 0));
const ftyp = (major: string, ...compat: string[]) => {
  const size = 16 + compat.length * 4;
  return bytes([0, 0, 0, size], "ftyp", major, [0, 0, 0, 0], ...compat, pad(32, 0));
};
const CSV = bytes("\ufeffName,PAN,Amount\r\nSharma Traders,AAKFS1234C,12500\r\n".replace("\ufeff", ""));

describe("allowed types (§5.8)", () => {
  it("lists exactly the nine kinds of the spec, by MIME and extension", () => {
    expect(ALLOWED_MIME).toEqual([
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/heic",
      "text/csv",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ]);
    for (const ext of ["pdf", "jpg", "jpeg", "png", "heic", "csv", "xls", "xlsx", "doc", "docx"]) {
      expect(ACCEPT_ATTRIBUTE.split(",")).toContain(`.${ext}`);
      expect(fileTypeOfExtension(ext), ext).not.toBeNull();
    }
    expect(fileTypeOfExtension("zip")).toBeNull();
    expect(fileTypeOfMime("image/heif")?.kind).toBe("heic");
    expect(fileTypeOfMime("application/pdf; charset=binary")?.kind).toBe("pdf");
  });

  it("previews PDFs and JPG/PNG images only (§7.14)", () => {
    expect(previewKind("application/pdf")).toBe("pdf");
    expect(previewKind("image/png")).toBe("image");
    expect(previewKind("image/jpeg")).toBe("image");
    expect(previewKind("image/heic")).toBeNull();
    expect(previewKind("text/csv")).toBeNull();
    expect(previewKind(null)).toBeNull();
  });
});

describe("magic bytes (§12 'MIME type checked by magic bytes, not just extension')", () => {
  it("recognises PDF, PNG, JPEG and HEIC whatever the name says", () => {
    expect(sniffFileType(PDF, { fileName: "notes.txt" })).toBe("pdf");
    expect(sniffFileType(bytes("\n\n  %PDF-1.4"))).toBe("pdf");
    expect(sniffFileType(PNG, { fileName: "scan.pdf" })).toBe("png");
    expect(sniffFileType(JPEG)).toBe("jpeg");
    expect(sniffFileType(ftyp("heic", "mif1", "heic"))).toBe("heic");
    expect(sniffFileType(ftyp("mif1", "mif1", "heic"))).toBe("heic");
    expect(sniffMime(PNG)).toBe("image/png");
  });

  it("refuses AVIF, video and other ftyp files", () => {
    expect(sniffFileType(ftyp("avif", "mif1", "avif"))).toBeNull();
    expect(sniffFileType(ftyp("mif1", "mif1", "avif"))).toBeNull();
    expect(sniffFileType(ftyp("isom", "mp41"))).toBeNull();
  });

  it("tells Word from Excel inside a ZIP container, and refuses PowerPoint and plain ZIPs", () => {
    expect(sniffFileType(zip("[Content_Types].xml", "_rels/.rels", "word/document.xml"), { complete: true })).toBe("docx");
    expect(sniffFileType(zip("[Content_Types].xml", "xl/workbook.xml"), { fileName: "Sales.docx", complete: true })).toBe("xlsx");
    expect(sniffFileType(zip("[Content_Types].xml", "ppt/presentation.xml"), { fileName: "deck.docx" })).toBeNull();
    expect(sniffFileType(zip("readme.txt", "data.bin"), { fileName: "archive.zip" })).toBeNull();
  });

  it("with only the leading bytes the name decides; the full file must show its parts", () => {
    const early = zip("[Content_Types].xml", "_rels/.rels");
    expect(sniffFileType(early, { fileName: "Ledger.xlsx" })).toBe("xlsx");
    expect(sniffFileType(early, { fileName: "Letter.docx" })).toBe("docx");
    expect(sniffFileType(early, { fileName: "Ledger.xlsx", complete: true })).toBeNull();
    expect(sniffFileType(early, { fileName: "archive.zip" })).toBeNull();
  });

  it("tells DOC from XLS inside an OLE2 compound file", () => {
    expect(sniffFileType(ole("Root Entry", "WordDocument", "1Table"), { complete: true })).toBe("doc");
    expect(sniffFileType(ole("Root Entry", "Workbook"), { complete: true })).toBe("xls");
    expect(sniffFileType(ole("Root Entry", "Book"), { fileName: "old.xls", complete: true })).toBe("xls");
    expect(sniffFileType(ole("Root Entry", "PowerPoint Document"), { fileName: "x.doc" })).toBeNull();
    expect(sniffFileType(ole("Root Entry"), { fileName: "scan.doc" })).toBe("doc");
    expect(sniffFileType(ole("Root Entry"), { fileName: "scan.doc", complete: true })).toBeNull();
    expect(sniffFileType(ole("Root Entry"), { fileName: "mail.msg" })).toBeNull();
  });

  it("accepts CSV only as plain text named .csv; never markup or binary", () => {
    expect(sniffFileType(CSV, { fileName: "clients.csv" })).toBe("csv");
    expect(sniffFileType(bytes([0xef, 0xbb, 0xbf], "a,b\n1,2\n"), { fileName: "bom.csv" })).toBe("csv");
    expect(sniffFileType(CSV, { fileName: "clients.txt" })).toBeNull();
    expect(sniffFileType(bytes("<!DOCTYPE html><script>alert(1)</script>"), { fileName: "evil.csv" })).toBeNull();
    expect(sniffFileType(bytes("  <svg onload=x>"), { fileName: "evil.csv" })).toBeNull();
    expect(sniffFileType(bytes("a,b", [0], "c"), { fileName: "bin.csv" })).toBeNull();
    expect(sniffFileType(bytes([1, 2, 3, 4, 5, 6, 7, 8], "abc"), { fileName: "bin.csv" })).toBeNull();
  });

  it("refuses executables, scripts and empty input", () => {
    expect(sniffFileType(bytes("MZ", pad(60, 0)), { fileName: "invoice.pdf" })).toBeNull();
    expect(sniffFileType(bytes("#!/bin/sh\nrm -rf /"), { fileName: "x.pdf" })).toBeNull();
    expect(sniffFileType(new Uint8Array(0), { fileName: "x.pdf" })).toBeNull();
  });
});

describe("checkFile (§5.8 'rejected files get the reason')", () => {
  it("accepts an allowed file and keeps its cleaned name", () => {
    const r = checkFile({ name: "GST certificate.pdf", size: 120_000, bytes: PDF });
    expect(r).toEqual({ ok: true, kind: "pdf", mime: "application/pdf", fileName: "GST certificate.pdf", note: null });
    expect(checkFile({ name: "photo.JPEG", size: 10, bytes: JPEG })).toMatchObject({ ok: true, fileName: "photo.JPEG", note: null });
  });

  it("corrects a wrong extension and says so", () => {
    const r = checkFile({ name: "IMG_2041.jpg", size: 900_000, bytes: ftyp("heic", "mif1", "heic") });
    expect(r).toMatchObject({ ok: true, kind: "heic", fileName: "IMG_2041.heic" });
    expect(r.ok && r.note).toBe("Saved as .heic: the file is a HEIC photo, not a .jpg file.");
    expect(checkFile({ name: "scan", size: 10, bytes: PDF })).toMatchObject({ ok: true, fileName: "scan.pdf" });
  });

  it("refuses empty, oversized and disallowed files with a reason", () => {
    expect(checkFile({ name: "a.pdf", size: 0, bytes: new Uint8Array(0) })).toMatchObject({ ok: false, code: "empty" });
    const big = checkFile({ name: "Bank statement.pdf", size: MAX_FILE_BYTES + 1, bytes: PDF });
    expect(big).toMatchObject({ ok: false, code: "too_large" });
    expect(!big.ok && big.reason).toMatch(/^This file is 25 MB\. Files can be at most 25 MB/);
    expect(checkFile({ name: "Bank statement.pdf", size: MAX_FILE_BYTES, bytes: PDF }).ok).toBe(true);
    const zipFile = checkFile({ name: "backup.zip", size: 100, bytes: zip("a.txt") });
    expect(zipFile).toMatchObject({ ok: false, code: "type" });
    expect(!zipFile.ok && zipFile.reason).toBe(".zip files can't be uploaded. Upload PDF, JPG, PNG, HEIC, CSV, Excel (XLS, XLSX) or Word (DOC, DOCX).");
    const fake = checkFile({ name: "invoice.pdf", size: 100, bytes: bytes("MZ", pad(10, 0)) });
    expect(fake).toMatchObject({ ok: false, code: "damaged" });
    expect(!fake.ok && fake.reason).toMatch(/named \.pdf but isn't a real PDF/);
  });
});

describe("file names and titles (§12, §7.14)", () => {
  it("strips folders, control and reserved characters, and keeps other scripts", () => {
    expect(sanitizeFileName("C:\\Users\\ravi\\Desktop\\GST cert.pdf")).toBe("GST cert.pdf");
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName('a<b>c:"d|e?f*.pdf')).toBe("a b c d e f.pdf");
    expect(sanitizeFileName("  ..hidden.pdf  ")).toBe("hidden.pdf");
    expect(sanitizeFileName("report\u0000\u202e.pdf")).toBe("report.pdf");
    expect(sanitizeFileName("बैंक स्टेटमेंट.pdf")).toBe("बैंक स्टेटमेंट.pdf");
    expect(sanitizeFileName("CON.pdf")).toBe("CON-file.pdf");
    expect(sanitizeFileName("")).toBe("document");
    expect(sanitizeFileName(".pdf")).toBe("pdf");
    const long = sanitizeFileName(`${"a".repeat(400)}.xlsx`);
    expect(long.length).toBe(150);
    expect(long.endsWith(".xlsx")).toBe(true);
  });

  it("reads and replaces extensions", () => {
    expect(extensionOf("Sales.Register.XLSX")).toBe("xlsx");
    expect(extensionOf("README")).toBe("");
    expect(extensionOf(".bashrc")).toBe("");
    expect(withExtension("IMG_1.jpg", "heic")).toBe("IMG_1.heic");
    expect(withExtension("noext", ".pdf")).toBe("noext.pdf");
  });

  it("titles a document from its file name, keeping hyphens and case", () => {
    expect(titleFromFileName("GSTR-3B_Sep_2026.pdf")).toBe("GSTR-3B Sep 2026");
    expect(titleFromFileName("bank   statement.final.pdf")).toBe("bank statement.final");
    expect(titleFromFileName("")).toBe("Untitled document");
  });

  it("formats sizes as people read them", () => {
    expect(formatFileSize(0)).toBe("0 bytes");
    expect(formatFileSize(1)).toBe("1 byte");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(820 * 1024)).toBe("820 KB");
    expect(formatFileSize(1.2 * 1024 * 1024)).toBe("1.2 MB");
    expect(formatFileSize(MAX_FILE_BYTES)).toBe("25 MB");
    expect(formatFileSize(null)).toBe("—");
  });
});

describe("storage paths (§5.8, 0043)", () => {
  const client = "0b6a1f6e-2d7c-4c1e-9f3a-5d8e7c6b5a40";
  const object = "9d3c2b1a-0f4e-4d5c-8b7a-6e5d4c3b2a10";

  it("builds <client_id>/<uuid>.<ext> and checks paths stay in the client's folder", () => {
    const path = documentStoragePath(client, object, "xlsx");
    expect(path).toBe(`${client}/${object}.xlsx`);
    expect(isInClientFolder(path, client)).toBe(true);
    expect(isInClientFolder(`client-documents/${path}`, client)).toBe(true);
    expect(objectNameOf(`client-documents/${path}`)).toBe(path);
    expect(isInClientFolder(`${client}/../${object}/x.pdf`, client)).toBe(false);
    expect(isInClientFolder(`${client}//x.pdf`, client)).toBe(false);
    expect(isInClientFolder(`${object}/x.pdf`, client)).toBe(false);
    expect(isInClientFolder("x.pdf", client)).toBe(false);
    expect(() => documentStoragePath("not-a-uuid", object, "pdf")).toThrow(RangeError);
  });
});

describe("SHA-256 duplicates (§7.14)", () => {
  it("hashes like node:crypto", async () => {
    const data = bytes("TaxWise Consultants");
    expect(await sha256Hex(data)).toBe(createHash("sha256").update(data).digest("hex"));
    expect(await sha256Hex(data.buffer.slice(0) as ArrayBuffer)).toBe(createHash("sha256").update(data).digest("hex"));
  });

  it("flags files already in the vault and repeats inside one upload", () => {
    const h = (c: string) => c.repeat(64);
    const existing = [
      { id: "d1", title: "GST certificate", sha256: h("a") },
      { id: "d2", title: "GST certificate (copy)", sha256: h("a") },
      { id: "d3", title: "PAN", sha256: null },
    ];
    const dup = findDuplicates(
      [
        { key: "f1", sha256: h("a") },
        { key: "f2", sha256: h("b") },
        { key: "f3", sha256: h("b") },
        { key: "f4", sha256: null },
      ],
      existing,
    );
    expect(dup.get("f1")).toEqual({ inVault: [existing[0], existing[1]], sameAsKey: null });
    expect(dup.has("f2")).toBe(false);
    expect(dup.get("f3")).toEqual({ inVault: [], sameAsKey: "f2" });
    expect(dup.has("f4")).toBe(false);
  });
});

describe("retention of a new document (§5.8, §6.8)", () => {
  const uploadedOn = "2026-10-23";

  it("defaults to the upload date + 7 years", () => {
    expect(uploadRetention({ uploadedOn, category: "kyc" })).toMatchObject({ rule: "default", until: "2033-10-23" });
    expect(uploadRetention({ uploadedOn, category: "gst", financialYear: null }).until).toBe("2033-10-23");
  });

  it("the 7-year floor wins when a statutory rule ends earlier", () => {
    // GST FY 2025-26: 72 months from 31 Dec 2026 = 31 Dec 2032, before the floor.
    const r = uploadRetention({ uploadedOn, category: "gst", financialYear: "2025-26" });
    expect(r).toMatchObject({ rule: "default", until: "2033-10-23" });
    expect(r.candidates.map((c) => c.rule)).toEqual(["gst_records", "default"]);
  });

  it("a statutory rule extends it when longer", () => {
    expect(uploadRetention({ uploadedOn, category: "gst", financialYear: "2027-28" })).toMatchObject({ rule: "gst_records", until: "2034-12-31" });
    expect(uploadRetention({ uploadedOn, category: "income_tax", financialYear: "2026-27" })).toMatchObject({ rule: "income_tax_records", until: "2034-03-31" });
    expect(uploadRetention({ uploadedOn, category: "tds", financialYear: "2026-27" }).rule).toBe("income_tax_records");
    expect(uploadRetention({ uploadedOn, category: "bank_statements", financialYear: "2026-27", entityType: "pvt_ltd" })).toMatchObject({ rule: "company_books", until: "2035-03-31" });
    // Not a company: the floor.
    expect(uploadRetention({ uploadedOn, category: "bank_statements", financialYear: "2026-27", entityType: "proprietorship" }).rule).toBe("default");
  });
});
