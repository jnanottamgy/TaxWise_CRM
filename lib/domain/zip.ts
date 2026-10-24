/**
 * A small ZIP writer for the full data export (§7.21): the "store" method (no compression), CRC-32,
 * UTF-8 names, and no ZIP64. Each entry is written whole (header, then data), so its size and CRC are
 * known before its header goes out and no data descriptor is needed: every unzip tool, Windows
 * Explorer and macOS Archive Utility included, reads the result. The caller streams the chunks it
 * returns, keeping only one entry in memory at a time (the export splits large tables into parts).
 *
 *   const zip = new ZipStoreWriter();
 *   for (const chunk of zip.add("clients.csv", bytes, new Date())) stream.enqueue(chunk);
 *   stream.enqueue(zip.finish());
 *
 * Limits of the classic format, enforced: 65,535 entries; each entry and the whole archive under
 * 4 GiB. Pure (Uint8Array and DataView only), no I/O.
 */

// -------------------------------------------------------------------------------------------------
// CRC-32 (IEEE 802.3, the polynomial ZIP uses: 0xEDB88320 reflected)
// -------------------------------------------------------------------------------------------------

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 of `data`; pass the previous result as `seed` to continue over several chunks. */
export function crc32(data: Uint8Array, seed = 0): number {
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// -------------------------------------------------------------------------------------------------
// Dates: MS-DOS date and time, in the firm's time zone (IST, §0.1 rule 13)
// -------------------------------------------------------------------------------------------------

const IST_OFFSET_MS = 330 * 60 * 1000;

/** The MS-DOS `time` and `date` words for an instant, read in IST; clamped to 1980–2107. */
export function dosDateTime(at: Date): { time: number; date: number } {
  const ms = at.getTime();
  const d = new Date((Number.isFinite(ms) ? ms : 0) + IST_OFFSET_MS);
  let year = d.getUTCFullYear();
  let month = d.getUTCMonth() + 1;
  let day = d.getUTCDate();
  let hours = d.getUTCHours();
  let minutes = d.getUTCMinutes();
  let seconds = d.getUTCSeconds();
  if (year < 1980) {
    year = 1980;
    month = 1;
    day = 1;
    hours = 0;
    minutes = 0;
    seconds = 0;
  } else if (year > 2107) {
    year = 2107;
    month = 12;
    day = 31;
    hours = 23;
    minutes = 59;
    seconds = 58;
  }
  return {
    time: ((hours << 11) | (minutes << 5) | Math.floor(seconds / 2)) & 0xffff,
    date: (((year - 1980) << 9) | (month << 5) | day) & 0xffff,
  };
}

// -------------------------------------------------------------------------------------------------
// Names
// -------------------------------------------------------------------------------------------------

const encoder = new TextEncoder();

/**
 * A name as stored in the archive: forward slashes, no leading slash, no `.` or `..` segments, no
 * control characters, at most 255 bytes. Throws for a name that would escape the folder it unzips
 * into (zip-slip) or that is empty.
 */
export function zipEntryName(name: string): string {
  const parts = name.replace(/\\/g, "/").split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0) throw new RangeError("A ZIP entry needs a name.");
  if (parts.some((p) => p === "..")) throw new RangeError(`The ZIP entry name "${name}" points outside the archive.`);
  if (parts.some((p) => /[\u0000-\u001f\u007f]/.test(p))) throw new RangeError(`The ZIP entry name "${name}" has control characters.`);
  const clean = parts.join("/");
  if (encoder.encode(clean).length > 255) throw new RangeError(`The ZIP entry name "${name}" is too long.`);
  return clean;
}

// -------------------------------------------------------------------------------------------------
// The writer
// -------------------------------------------------------------------------------------------------

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const VERSION_NEEDED = 20; // 2.0
const VERSION_MADE_BY = (3 << 8) | 20; // Unix, spec 2.0: lets unzip apply the file mode below
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const FILE_MODE = (0o100644 << 16) >>> 0; // a regular file, rw-r--r--
const MAX_U32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;

type CentralRecord = { name: Uint8Array; crc: number; size: number; offset: number; time: number; date: number };

export class ZipStoreWriter {
  private offset = 0;
  private readonly records: CentralRecord[] = [];
  private readonly names = new Set<string>();
  private finished = false;

  /** Bytes written so far (local headers and data). */
  get bytesWritten(): number {
    return this.offset;
  }

  /** Entries added so far. */
  get entryCount(): number {
    return this.records.length;
  }

  /**
   * Adds one file. Returns the chunks to write, in order: the local header and the data. Throws for a
   * duplicate or unsafe name, and when an archive limit would be passed.
   */
  add(name: string, data: Uint8Array, modified: Date = new Date()): Uint8Array[] {
    if (this.finished) throw new Error("The ZIP archive is already finished.");
    const clean = zipEntryName(name);
    if (this.names.has(clean)) throw new RangeError(`The ZIP archive already has an entry called "${clean}".`);
    if (this.records.length >= MAX_ENTRIES) throw new RangeError("A ZIP archive holds at most 65,535 entries.");
    if (data.length > MAX_U32) throw new RangeError(`"${clean}" is larger than a ZIP entry can hold.`);
    const nameBytes = encoder.encode(clean);
    const headerSize = 30 + nameBytes.length;
    if (this.offset + headerSize + data.length > MAX_U32) throw new RangeError("The ZIP archive would pass 4 GiB.");

    const crc = crc32(data);
    const { time, date } = dosDateTime(modified);
    const header = new Uint8Array(headerSize);
    const v = new DataView(header.buffer);
    v.setUint32(0, SIG_LOCAL, true);
    v.setUint16(4, VERSION_NEEDED, true);
    v.setUint16(6, FLAG_UTF8, true);
    v.setUint16(8, METHOD_STORE, true);
    v.setUint16(10, time, true);
    v.setUint16(12, date, true);
    v.setUint32(14, crc, true);
    v.setUint32(18, data.length, true); // compressed size = stored size
    v.setUint32(22, data.length, true);
    v.setUint16(26, nameBytes.length, true);
    v.setUint16(28, 0, true); // no extra field
    header.set(nameBytes, 30);

    this.records.push({ name: nameBytes, crc, size: data.length, offset: this.offset, time, date });
    this.names.add(clean);
    this.offset += headerSize + data.length;
    return data.length > 0 ? [header, data] : [header];
  }

  /** The central directory and the end record. Call once, after the last entry. */
  finish(comment = ""): Uint8Array {
    if (this.finished) throw new Error("The ZIP archive is already finished.");
    this.finished = true;
    const commentBytes = encoder.encode(comment).slice(0, 0xffff);
    const centralSize = this.records.reduce((n, r) => n + 46 + r.name.length, 0);
    if (this.offset + centralSize + 22 + commentBytes.length > MAX_U32) throw new RangeError("The ZIP archive would pass 4 GiB.");

    const out = new Uint8Array(centralSize + 22 + commentBytes.length);
    const v = new DataView(out.buffer);
    let p = 0;
    for (const r of this.records) {
      v.setUint32(p, SIG_CENTRAL, true);
      v.setUint16(p + 4, VERSION_MADE_BY, true);
      v.setUint16(p + 6, VERSION_NEEDED, true);
      v.setUint16(p + 8, FLAG_UTF8, true);
      v.setUint16(p + 10, METHOD_STORE, true);
      v.setUint16(p + 12, r.time, true);
      v.setUint16(p + 14, r.date, true);
      v.setUint32(p + 16, r.crc, true);
      v.setUint32(p + 20, r.size, true);
      v.setUint32(p + 24, r.size, true);
      v.setUint16(p + 28, r.name.length, true);
      v.setUint16(p + 30, 0, true); // extra
      v.setUint16(p + 32, 0, true); // comment
      v.setUint16(p + 34, 0, true); // disk number start
      v.setUint16(p + 36, 0, true); // internal attributes
      v.setUint32(p + 38, FILE_MODE, true); // external attributes
      v.setUint32(p + 42, r.offset, true);
      out.set(r.name, p + 46);
      p += 46 + r.name.length;
    }
    v.setUint32(p, SIG_END, true);
    v.setUint16(p + 4, 0, true); // this disk
    v.setUint16(p + 6, 0, true); // disk with the central directory
    v.setUint16(p + 8, this.records.length, true);
    v.setUint16(p + 10, this.records.length, true);
    v.setUint32(p + 12, centralSize, true);
    v.setUint32(p + 16, this.offset, true);
    v.setUint16(p + 20, commentBytes.length, true);
    out.set(commentBytes, p + 22);
    this.offset += out.length;
    return out;
  }
}

/** Builds a whole archive in memory (tests and small archives). */
export function zipStore(entries: ReadonlyArray<{ name: string; data: Uint8Array; modified?: Date }>, comment = ""): Uint8Array {
  const zip = new ZipStoreWriter();
  const chunks: Uint8Array[] = [];
  for (const e of entries) chunks.push(...zip.add(e.name, e.data, e.modified));
  chunks.push(zip.finish(comment));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}
