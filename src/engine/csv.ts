// Streaming CSV reading: chunked file reads, incremental decoding, RFC-4180 style
// parsing (quoted values, escaped quotes, multiline cells, CRLF/LF/CR), delimiter
// and encoding detection and a fast byte-level record counter.
// Works in Web Workers, the main thread and Node (Blob API).

import type { Encoding } from './types';

export class CsvError extends Error {}

export const MAX_RECORD_CHARS = 16 * 1024 * 1024; // a single record larger than this is treated as malformed

/**
 * Incremental parser. Feed text chunks with push(); complete records are delivered
 * to onRow. A partially received record is carried over to the next chunk.
 */
export class CsvStreamParser {
  private carry = '';
  private skipLeadingLF = false;
  private readonly d: number;
  records = 0;

  constructor(
    delimiter: string,
    private readonly onRow: (fields: string[]) => void,
  ) {
    if (delimiter.length !== 1) throw new CsvError('Delimiter must be a single character');
    this.d = delimiter.charCodeAt(0);
  }

  push(chunk: string, final = false): void {
    let s = this.carry.length ? this.carry + chunk : chunk;
    this.carry = '';
    let i = 0;
    if (this.skipLeadingLF && s.charCodeAt(0) === 10) i = 1;
    this.skipLeadingLF = false;
    const n = s.length;
    const D = this.d;

    while (i < n) {
      const rowStart = i;
      const fields: string[] = [];
      let complete = false;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        let value: string;
        let k: number; // index of the terminator (delimiter / newline) or n
        if (s.charCodeAt(i) === 34) {
          // quoted field
          let j = i + 1;
          let buf = '';
          let closed = false;
          while (true) {
            const q = s.indexOf('"', j);
            if (q < 0) break; // need more data
            if (q + 1 < n && s.charCodeAt(q + 1) === 34) {
              buf += s.slice(j, q + 1);
              j = q + 2;
              continue;
            }
            if (q + 1 >= n && !final) break; // cannot tell whether "" follows
            buf += s.slice(j, q);
            j = q + 1;
            closed = true;
            break;
          }
          if (!closed) {
            if (final) throw new CsvError('Unterminated quoted value at end of file');
            break; // incomplete record
          }
          // lenient: characters after a closing quote up to the terminator are appended
          k = j;
          while (k < n) {
            const c = s.charCodeAt(k);
            if (c === D || c === 10 || c === 13) break;
            k++;
          }
          if (k > j) buf += s.slice(j, k);
          value = buf;
        } else {
          k = i;
          while (k < n) {
            const c = s.charCodeAt(k);
            if (c === D || c === 10 || c === 13) break;
            k++;
          }
          value = s.slice(i, k);
        }
        if (k >= n) {
          if (!final) break; // incomplete
          fields.push(value);
          i = n;
          complete = true;
          break;
        }
        fields.push(value);
        const c = s.charCodeAt(k);
        if (c === D) {
          i = k + 1;
          if (i >= n) {
            if (!final) break;
            fields.push('');
            complete = true;
            break;
          }
          continue;
        }
        // newline
        if (c === 13) {
          if (k + 1 < n) i = s.charCodeAt(k + 1) === 10 ? k + 2 : k + 1;
          else {
            i = k + 1;
            this.skipLeadingLF = true;
          }
        } else i = k + 1;
        complete = true;
        break;
      }
      if (!complete) {
        this.carry = s.slice(rowStart);
        if (this.carry.length > MAX_RECORD_CHARS)
          throw new CsvError(
            `A single record exceeds ${MAX_RECORD_CHARS / 1048576} MB (record ${this.records + 1}). ` +
              'This usually means an unclosed quote or a wrong delimiter.',
          );
        this.skipLeadingLF = false;
        return;
      }
      // skip completely empty lines
      if (fields.length === 1 && fields[0] === '') continue;
      this.records++;
      this.onRow(fields);
    }
    s = '';
  }

  finish(): void {
    if (this.carry.length) {
      const c = this.carry;
      this.carry = '';
      this.push(c, true);
    }
  }
}

export interface ReadOptions {
  encoding: Encoding;
  chunkBytes: number;
  onChunk?: (bytesDone: number, bytesTotal: number) => void;
  isCancelled?: () => boolean;
}

export class CancelledError extends Error {
  constructor() {
    super('Cancelled by user');
  }
}

/** Stream-decode a Blob in chunks. Never loads the whole file. */
export async function readTextChunks(blob: Blob, opts: ReadOptions, onText: (t: string, last: boolean) => void) {
  const dec = new TextDecoder(opts.encoding);
  const total = blob.size;
  let off = 0;
  if (total === 0) {
    onText('', true);
    return;
  }
  while (off < total) {
    if (opts.isCancelled?.()) throw new CancelledError();
    const end = Math.min(total, off + opts.chunkBytes);
    const buf = await blob.slice(off, end).arrayBuffer();
    off = end;
    const last = off >= total;
    const text = dec.decode(buf, { stream: !last });
    onText(text, last);
    opts.onChunk?.(off, total);
  }
}

/** Parse a whole Blob as a stream, calling onRow for every record (header included). */
export async function parseBlob(
  blob: Blob,
  delimiter: string,
  opts: ReadOptions,
  onRow: (fields: string[]) => void,
): Promise<number> {
  const p = new CsvStreamParser(delimiter, onRow);
  await readTextChunks(blob, opts, (t, last) => {
    p.push(t, false);
    if (last) p.finish();
  });
  return p.records;
}

export function detectEncoding(sample: Uint8Array): { encoding: Encoding; bom: boolean } {
  if (sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) return { encoding: 'utf-8', bom: true };
  if (sample[0] === 0xff && sample[1] === 0xfe) return { encoding: 'utf-16le', bom: true };
  if (sample[0] === 0xfe && sample[1] === 0xff) return { encoding: 'utf-16be', bom: true };
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: true });
    return { encoding: 'utf-8', bom: false };
  } catch {
    return { encoding: 'windows-1252', bom: false };
  }
}

const CANDIDATES = [',', ';', '\t', '|'];

export function detectDelimiter(text: string): string {
  const lines: string[] = [];
  // split on newlines outside quotes for the first ~30 records
  let inQ = false;
  let start = 0;
  for (let i = 0; i < text.length && lines.length < 30; i++) {
    const c = text[i];
    if (c === '"') inQ = !inQ;
    else if (!inQ && (c === '\n' || c === '\r')) {
      if (i > start) lines.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (lines.length === 0) lines.push(text);
  let best = ',';
  let bestScore = -1;
  for (const d of CANDIDATES) {
    const counts = lines.map((l) => countOutsideQuotes(l, d));
    if (counts[0] === 0) continue;
    const mode = counts[0];
    const consistent = counts.filter((c) => c === mode).length / counts.length;
    const score = consistent * 1000 + mode;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

function countOutsideQuotes(line: string, d: string): number {
  let inQ = false;
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (!inQ && c === d) n++;
  }
  return n;
}

/** Make header names unique and non-empty, as shown in the UI and used in configs. */
export function cleanHeaders(raw: string[]): { headers: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const seen = new Map<string, number>();
  const headers = raw.map((h, i) => {
    let name = h.replace(/^﻿/, '').trim();
    if (!name) {
      name = `Column ${i + 1}`;
      warnings.push(`Blank heading in column ${i + 1} named "${name}"`);
    }
    const base = name;
    let n = seen.get(base.toLowerCase()) ?? 0;
    if (n > 0) {
      while (seen.has(`${base} (${n + 1})`.toLowerCase())) n++;
      name = `${base} (${n + 1})`;
      warnings.push(`Duplicate heading "${base}" renamed to "${name}"`);
    }
    seen.set(base.toLowerCase(), n + 1);
    seen.set(name.toLowerCase(), 1);
    return name;
  });
  return { headers, warnings };
}

/** Read the first record (header) and sniff delimiter/encoding from the first 256 KB. */
export async function inspectHeader(blob: Blob): Promise<{
  encoding: Encoding;
  delimiter: string;
  rawHeaders: string[];
  sampleRows: string[][];
}> {
  const head = new Uint8Array(await blob.slice(0, 256 * 1024).arrayBuffer());
  const { encoding } = detectEncoding(head);
  const text = new TextDecoder(encoding).decode(head, { stream: true });
  const delimiter = detectDelimiter(text);
  const rows = parseSample(text, delimiter, 6);
  return { encoding, delimiter, rawHeaders: rows[0] ?? [], sampleRows: rows.slice(1) };
}

export function parseSample(text: string, delimiter: string, maxRows: number): string[][] {
  const rows: string[][] = [];
  const p = new CsvStreamParser(delimiter, (f) => {
    if (rows.length < maxRows) rows.push(f);
  });
  try {
    p.push(text, false);
  } catch {
    /* a sample may end inside an oversized record */
  }
  return rows;
}

/**
 * Fast, quote-aware record counter working directly on bytes (ASCII-compatible
 * encodings). Counts records the same way the parser does (empty lines skipped).
 * Returns data rows (header excluded).
 */
export async function countRecords(
  blob: Blob,
  encoding: Encoding,
  delimiter: string,
  chunkBytes: number,
  onProgress?: (done: number, total: number) => void,
  isCancelled?: () => boolean,
  lineEndings?: { cr: number; lf: number; crlf: number }, // filled with counts of record-ending styles
): Promise<number> {
  if (encoding === 'utf-16le' || encoding === 'utf-16be') {
    const n = await parseBlob(blob, delimiter, { encoding, chunkBytes, onChunk: onProgress, isCancelled }, () => {});
    return Math.max(0, n - 1);
  }
  let records = 0;
  let inQ = false;
  let content = false; // current record has a non-newline byte
  let prevCR = false;
  let off = 0;
  const total = blob.size;
  // skip UTF-8 BOM
  while (off < total) {
    if (isCancelled?.()) throw new CancelledError();
    const end = Math.min(total, off + chunkBytes);
    const b = new Uint8Array(await blob.slice(off, end).arrayBuffer());
    let i = 0;
    if (off === 0 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
    for (; i < b.length; i++) {
      const c = b[i];
      if (c === 34) {
        inQ = !inQ; // "" toggles twice, fine
        content = true;
        prevCR = false;
      } else if (!inQ && (c === 10 || c === 13)) {
        if (c === 10 && prevCR) {
          prevCR = false;
          if (lineEndings) {
            lineEndings.cr--; // it was CRLF after all
            lineEndings.crlf++;
          }
          continue;
        }
        if (lineEndings) {
          if (c === 13) lineEndings.cr++;
          else lineEndings.lf++;
        }
        if (content) records++;
        content = false;
        prevCR = c === 13;
      } else {
        content = true;
        prevCR = false;
      }
    }
    off = end;
    onProgress?.(off, total);
  }
  if (content) records++;
  return Math.max(0, records - 1);
}

/**
 * Streams a non-UTF-8 text file into UTF-8, chunk by chunk. Used before handing a
 * file to DuckDB, whose Latin-1 reader rejects Windows-1252 characters in the
 * 0x80–0x9F range (curly quotes, dashes, € …) that Excel "ANSI" CSV files contain.
 */
export async function transcodeToUtf8(
  blob: Blob,
  encoding: Encoding,
  write: (b: Uint8Array) => Promise<void>,
  opts: {
    chunkBytes?: number;
    onProgress?: (done: number, total: number) => void;
    isCancelled?: () => boolean;
    /** turn record-ending lone CR characters (outside quotes) into LF */
    normalizeNewlines?: boolean;
  } = {},
): Promise<void> {
  const dec = new TextDecoder(encoding);
  const enc = new TextEncoder();
  const chunk = opts.chunkBytes ?? 8 << 20;
  const total = blob.size;
  let inQ = false;
  let pendingCR = false; // chunk ended with a CR outside quotes
  const fix = (t: string): string => {
    if (!t) return t;
    let out = '';
    let from = 0;
    let i = 0;
    if (pendingCR) {
      out += t.charCodeAt(0) === 10 ? '\r' : '\n';
      pendingCR = false;
    }
    for (; i < t.length; i++) {
      const c = t.charCodeAt(i);
      if (c === 34) inQ = !inQ;
      else if (c === 13 && !inQ) {
        if (i + 1 < t.length) {
          if (t.charCodeAt(i + 1) !== 10) {
            out += t.slice(from, i) + '\n';
            from = i + 1;
          }
        } else {
          out += t.slice(from, i);
          from = i + 1;
          pendingCR = true;
        }
      }
    }
    return out + t.slice(from);
  };
  for (let off = 0; off < total; ) {
    if (opts.isCancelled?.()) throw new CancelledError();
    const end = Math.min(total, off + chunk);
    const buf = await blob.slice(off, end).arrayBuffer();
    off = end;
    let text = dec.decode(buf, { stream: off < total });
    if (opts.normalizeNewlines) text = fix(text);
    if (text) await write(enc.encode(text));
    opts.onProgress?.(off, total);
  }
  if (pendingCR) await write(enc.encode('\n'));
}
