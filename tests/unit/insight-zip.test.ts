import { describe, expect, it } from "vitest";
import { ZipStoreWriter, crc32, dosDateTime, zipEntryName, zipStore } from "@/lib/domain/zip";

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { ignoreBOM: true });

type Parsed = { comment: string; entries: Array<{ name: string; crc: number; size: number; data: Uint8Array; flags: number; method: number; time: number; date: number }> };

/** A minimal reader: the end record, the central directory, then each local header and its data. */
function readZip(bytes: Uint8Array): Parsed {
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
  const cdSize = v.getUint32(end + 12, true);
  const cdOffset = v.getUint32(end + 16, true);
  const commentLength = v.getUint16(end + 20, true);
  expect(cdOffset + cdSize).toBe(end);
  const entries: Parsed["entries"] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(p, true)).toBe(0x02014b50);
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const time = v.getUint16(p + 12, true);
    const date = v.getUint16(p + 14, true);
    const crc = v.getUint32(p + 16, true);
    const size = v.getUint32(p + 24, true);
    const nameLength = v.getUint16(p + 28, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLength));
    // The local header agrees with the central record.
    expect(v.getUint32(local, true)).toBe(0x04034b50);
    expect(v.getUint32(local + 14, true)).toBe(crc);
    expect(v.getUint32(local + 22, true)).toBe(size);
    const localName = v.getUint16(local + 26, true);
    const extra = v.getUint16(local + 28, true);
    const start = local + 30 + localName + extra;
    entries.push({ name, crc, size, data: bytes.subarray(start, start + size), flags, method, time, date });
    p += 46 + nameLength;
  }
  return { comment: dec.decode(bytes.subarray(end + 22, end + 22 + commentLength)), entries };
}

describe("crc32", () => {
  it("matches the standard check values", () => {
    expect(crc32(enc.encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
    expect(crc32(enc.encode("The quick brown fox jumps over the lazy dog"))).toBe(0x414fa339);
  });

  it("continues over chunks", () => {
    const all = enc.encode("TaxWise Consultants, Bengaluru");
    expect(crc32(all.subarray(8), crc32(all.subarray(0, 8)))).toBe(crc32(all));
  });
});

describe("dosDateTime", () => {
  it("encodes the IST wall-clock time", () => {
    // 22 Oct 2026, 09:30:14 UTC = 15:00:14 IST.
    const { time, date } = dosDateTime(new Date("2026-10-22T09:30:14Z"));
    expect(date).toBe(((2026 - 1980) << 9) | (10 << 5) | 22);
    expect(time).toBe((15 << 11) | (0 << 5) | 7);
  });

  it("clamps dates outside 1980–2107", () => {
    expect(dosDateTime(new Date("1970-01-01T00:00:00Z")).date).toBe((0 << 9) | (1 << 5) | 1);
    expect(dosDateTime(new Date("2200-01-01T00:00:00Z")).date).toBe((127 << 9) | (12 << 5) | 31);
  });
});

describe("zipEntryName", () => {
  it("normalises separators and refuses names that escape the archive", () => {
    expect(zipEntryName("tables\\clients.csv")).toBe("tables/clients.csv");
    expect(zipEntryName("/tables/./clients.csv")).toBe("tables/clients.csv");
    expect(() => zipEntryName("../evil.csv")).toThrow(/outside the archive/);
    expect(() => zipEntryName("tables/../../evil.csv")).toThrow(/outside the archive/);
    expect(() => zipEntryName("")).toThrow(/needs a name/);
    expect(() => zipEntryName("bad\u0000name.csv")).toThrow(/control characters/);
    expect(() => zipEntryName("x".repeat(300))).toThrow(/too long/);
  });
});

describe("ZipStoreWriter", () => {
  it("writes an archive every reader can open: stored entries, UTF-8 names, matching CRCs", () => {
    const at = new Date("2026-10-22T09:30:14Z");
    const bytes = zipStore(
      [
        { name: "README.txt", data: enc.encode("TaxWise Consultants full export\r\n"), modified: at },
        { name: "tables/clients.csv", data: enc.encode("﻿id,display_name\r\n1,Sharma & Co\r\n"), modified: at },
        { name: "tables/empty.csv", data: new Uint8Array(), modified: at },
        { name: "tables/ಕನ್ನಡ.csv", data: enc.encode("ok"), modified: at },
      ],
      "Generated 22 Oct 2026",
    );
    const z = readZip(bytes);
    expect(z.comment).toBe("Generated 22 Oct 2026");
    expect(z.entries.map((e) => e.name)).toEqual(["README.txt", "tables/clients.csv", "tables/empty.csv", "tables/ಕನ್ನಡ.csv"]);
    for (const e of z.entries) {
      expect(e.method).toBe(0);
      expect(e.flags & 0x0800).toBe(0x0800);
      expect(crc32(e.data)).toBe(e.crc);
      expect(e.data.length).toBe(e.size);
      expect(e.date).toBe(dosDateTime(at).date);
    }
    expect(dec.decode(z.entries[1].data)).toBe("﻿id,display_name\r\n1,Sharma & Co\r\n");
    expect(z.entries[2].size).toBe(0);
  });

  it("streams the same bytes as building it whole, and counts what it wrote", () => {
    const files = [
      { name: "a.csv", data: enc.encode("a\r\n1\r\n") },
      { name: "b.csv", data: enc.encode("b\r\n2\r\n") },
    ];
    const at = new Date("2026-01-01T00:00:00Z");
    const w = new ZipStoreWriter();
    const chunks: Uint8Array[] = [];
    for (const f of files) chunks.push(...w.add(f.name, f.data, at));
    expect(w.entryCount).toBe(2);
    const before = w.bytesWritten;
    chunks.push(w.finish());
    const streamed = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let p = 0;
    for (const c of chunks) {
      streamed.set(c, p);
      p += c.length;
    }
    expect(Array.from(streamed)).toEqual(Array.from(zipStore(files.map((f) => ({ ...f, modified: at })))));
    expect(w.bytesWritten).toBe(streamed.length);
    expect(before).toBeLessThan(streamed.length);
  });

  it("refuses a duplicate name and anything after finish", () => {
    const w = new ZipStoreWriter();
    w.add("a.csv", enc.encode("x"));
    expect(() => w.add("./a.csv", enc.encode("y"))).toThrow(/already has an entry/);
    w.finish();
    expect(() => w.add("b.csv", enc.encode("z"))).toThrow(/already finished/);
    expect(() => w.finish()).toThrow(/already finished/);
  });

  it("writes a valid empty archive", () => {
    const z = readZip(zipStore([]));
    expect(z.entries).toEqual([]);
  });
});
