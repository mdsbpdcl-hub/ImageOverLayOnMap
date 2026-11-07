// Streaming Excel (.xlsx / .xlsm) reader.
//
// An .xlsx file is a ZIP archive of XML parts. This reader locates the parts it
// needs through the ZIP central directory (random access via File.slice), inflates
// a worksheet in chunks and turns its rows into CSV text as they arrive — the
// workbook is never loaded as a whole. Only the shared-strings table (the list of
// distinct texts used in the workbook) has to be kept in memory while converting.
//
// Cell values are written as they are stored: texts as text, numbers without
// thousands separators, dates as YYYY-MM-DD (HH:MM:SS), booleans as TRUE/FALSE.
// Numbers formatted with a zero-padded format such as 000000000000 keep their
// leading zeros, as Excel displays them.

import { Inflate } from 'fflate';
import { CancelledError } from './csv';
import { CsvEncoder } from './writer';

export class XlsxError extends Error {}

interface ZipEntry {
  name: string;
  method: number;
  csize: number;
  offset: number; // local header offset
}

const u16 = (b: DataView, o: number) => b.getUint16(o, true);
const u32 = (b: DataView, o: number) => b.getUint32(o, true);
const u64 = (b: DataView, o: number) => b.getUint32(o, true) + b.getUint32(o + 4, true) * 2 ** 32;

async function bytes(blob: Blob, start: number, end: number): Promise<DataView> {
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

export async function readZipIndex(blob: Blob): Promise<Map<string, ZipEntry>> {
  const size = blob.size;
  const tailStart = Math.max(0, size - 65_557);
  const tail = await bytes(blob, tailStart, size);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (u32(tail, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new XlsxError('This is not a valid .xlsx file (it may be an old .xls file, password-protected, or damaged).');
  let count = u16(tail, eocd + 10);
  let cdSize = u32(tail, eocd + 12);
  let cdOffset = u32(tail, eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff || cdSize === 0xffffffff) {
    const loc = eocd - 20;
    if (loc >= 0 && u32(tail, loc) === 0x07064b50) {
      const z64off = u64(tail, loc + 8);
      const z = await bytes(blob, z64off, z64off + 56);
      if (u32(z, 0) === 0x06064b50) {
        count = u64(z, 32);
        cdSize = u64(z, 40);
        cdOffset = u64(z, 48);
      }
    }
  }
  const cd = await bytes(blob, cdOffset, cdOffset + cdSize);
  const dec = new TextDecoder();
  const map = new Map<string, ZipEntry>();
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.byteLength; n++) {
    if (u32(cd, p) !== 0x02014b50) break;
    const flags = u16(cd, p + 8);
    const method = u16(cd, p + 10);
    let csize = u32(cd, p + 20);
    const usize = u32(cd, p + 24);
    const nl = u16(cd, p + 28), el = u16(cd, p + 30), cl = u16(cd, p + 32);
    let offset = u32(cd, p + 42);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nl)).replace(/\\/g, '/').replace(/^\//, '');
    // ZIP64 extra field
    let e = p + 46 + nl;
    const eEnd = e + el;
    while (e + 4 <= eEnd) {
      const id = u16(cd, e), len = u16(cd, e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (usize === 0xffffffff) q += 8;
        if (csize === 0xffffffff) { csize = u64(cd, q); q += 8; }
        if (offset === 0xffffffff) offset = u64(cd, q);
      }
      e += 4 + len;
    }
    if (flags & 1) throw new XlsxError('The workbook is password-protected. Remove the password in Excel and save again.');
    map.set(name, { name, method, csize, offset });
    p += 46 + nl + el + cl;
  }
  return map;
}

/** Streams the uncompressed text of one ZIP entry in pieces. */
async function streamEntry(
  blob: Blob,
  e: ZipEntry,
  onText: (t: string) => void,
  opts: { chunk?: number; onProgress?: (done: number, total: number) => void; isCancelled?: () => boolean; afterChunk?: () => Promise<void> } = {},
) {
  const lh = await bytes(blob, e.offset, e.offset + 30);
  if (u32(lh, 0) !== 0x04034b50) throw new XlsxError('The .xlsx file is damaged (bad entry header).');
  const start = e.offset + 30 + u16(lh, 26) + u16(lh, 28);
  const end = start + e.csize;
  const dec = new TextDecoder('utf-8');
  const chunk = opts.chunk ?? 4 << 20;
  let inflate: Inflate | null = null;
  if (e.method === 8) {
    inflate = new Inflate((data) => onText(dec.decode(data, { stream: true })));
  } else if (e.method !== 0) throw new XlsxError(`Unsupported compression in the .xlsx file (method ${e.method}).`);
  for (let off = start; off < end; ) {
    if (opts.isCancelled?.()) throw new CancelledError();
    const stop = Math.min(end, off + chunk);
    const buf = new Uint8Array(await blob.slice(off, stop).arrayBuffer());
    off = stop;
    if (inflate) inflate.push(buf, off >= end);
    else onText(dec.decode(buf, { stream: true }));
    opts.onProgress?.(off - start, e.csize);
    if (opts.afterChunk) await opts.afterChunk();
  }
  if (e.csize === 0 && inflate) inflate.push(new Uint8Array(0), true);
  onText(dec.decode());
}

async function entryText(blob: Blob, idx: Map<string, ZipEntry>, name: string): Promise<string | null> {
  const e = idx.get(name);
  if (!e) return null;
  const parts: string[] = [];
  await streamEntry(blob, e, (t) => parts.push(t));
  return parts.join('');
}

/* ---------------- XML helpers ---------------- */

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function xmlText(s: string): string {
  if (s.indexOf('&') >= 0)
    s = s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e: string) =>
      e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e] ?? m,
    );
  if (s.indexOf('_x') >= 0) s = s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  return s;
}

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)(?:\\w+:)?${name}="([^"]*)"`).exec(attrs);
  return m ? xmlText(m[1]) : undefined;
}

const T_RE = /<(?:\w+:)?t\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?t>)/g;
const RPH_RE = /<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g;
function richText(inner: string): string {
  if (inner.indexOf('rPh') >= 0) inner = inner.replace(RPH_RE, '');
  let s = '';
  T_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = T_RE.exec(inner))) s += m[1] ? xmlText(m[1]) : '';
  return s;
}

/* ---------------- workbook structure ---------------- */

export interface SheetInfo {
  name: string;
  path: string;
  hidden: boolean;
}

export interface Workbook {
  sheets: SheetInfo[];
  date1904: boolean;
}

export async function readWorkbook(blob: Blob): Promise<Workbook> {
  const idx = await readZipIndex(blob);
  const wb = await entryText(blob, idx, 'xl/workbook.xml');
  if (wb === null) throw new XlsxError('No workbook found inside the file. Only .xlsx / .xlsm workbooks are supported (not .xlsb or .xls).');
  const rels = (await entryText(blob, idx, 'xl/_rels/workbook.xml.rels')) ?? '';
  const targets = new Map<string, string>();
  for (const m of rels.matchAll(/<(?:\w+:)?Relationship\b([^>]*?)\/?>/g)) {
    const id = attr(m[1], 'Id'), t = attr(m[1], 'Target');
    if (id && t) targets.set(id, t);
  }
  const sheets: SheetInfo[] = [];
  for (const m of wb.matchAll(/<(?:\w+:)?sheet\b([^>]*?)\/?>/g)) {
    const a = m[1];
    const name = attr(a, 'name') ?? `Sheet${sheets.length + 1}`;
    const rid = /\s[\w]+:id="([^"]*)"/.exec(a)?.[1];
    let t = rid ? targets.get(rid) : undefined;
    if (!t) continue;
    t = t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
    if (!idx.has(t)) continue; // chart sheets, dialog sheets, missing parts
    sheets.push({ name, path: t, hidden: (attr(a, 'state') ?? 'visible') !== 'visible' });
  }
  if (!sheets.length) throw new XlsxError('The workbook contains no worksheets.');
  const date1904 = /<(?:\w+:)?workbookPr\b[^>]*\bdate1904="(1|true)"/.test(wb);
  return { sheets, date1904 };
}

/* ---------------- number formats ---------------- */

type Fmt = { kind: 'general' } | { kind: 'date'; time: boolean; dateOnly: boolean } | { kind: 'zeros'; width: number };

const BUILTIN_DATE = new Set([14, 15, 16, 17, 22, 27, 30, 36, 50, 57]);
const BUILTIN_TIME = new Set([18, 19, 20, 21, 45, 46, 47]);

export function classifyFormat(id: number, code: string | undefined): Fmt {
  if (code === undefined) {
    if (BUILTIN_DATE.has(id)) return { kind: 'date', time: id === 22, dateOnly: id !== 22 };
    if (BUILTIN_TIME.has(id)) return { kind: 'date', time: true, dateOnly: false };
    return { kind: 'general' };
  }
  const section = code.split(';')[0];
  const bare = section
    .replace(/"[^"]*"/g, '') // literal text
    .replace(/\\./g, '') // escaped characters
    .replace(/\[(h+|m+|s+)\]/gi, '$1') // elapsed time [h]
    .replace(/\[[^\]]*\]/g, '') // colours, locales, conditions
    .trim();
  if (/^0+$/.test(bare)) return { kind: 'zeros', width: bare.length };
  if (/general/i.test(bare)) return { kind: 'general' };
  const hasDate = /[dy]/i.test(bare) || (/m/i.test(bare) && !/[hs]/i.test(bare) && !/e[+-]/i.test(bare));
  const hasTime = /[hs]/i.test(bare);
  if (hasDate || hasTime) return { kind: 'date', time: hasTime, dateOnly: hasDate && !hasTime };
  return { kind: 'general' };
}

async function readStyles(blob: Blob, idx: Map<string, ZipEntry>): Promise<Fmt[]> {
  const xml = await entryText(blob, idx, 'xl/styles.xml');
  if (!xml) return [];
  const codes = new Map<number, string>();
  for (const m of xml.matchAll(/<(?:\w+:)?numFmt\b([^>]*?)\/?>/g)) {
    const id = attr(m[1], 'numFmtId'), code = attr(m[1], 'formatCode');
    if (id && code !== undefined) codes.set(+id, code);
  }
  const xfs = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/.exec(xml)?.[1] ?? '';
  const out: Fmt[] = [];
  for (const m of xfs.matchAll(/<(?:\w+:)?xf\b([^>]*?)(?:\/>|>)/g)) {
    const id = +(attr(m[1], 'numFmtId') ?? 0);
    out.push(classifyFormat(id, codes.get(id)));
  }
  return out;
}

async function readSharedStrings(
  blob: Blob,
  idx: Map<string, ZipEntry>,
  onProgress?: (d: number, t: number) => void,
  isCancelled?: () => boolean,
): Promise<string[]> {
  const e = idx.get('xl/sharedStrings.xml');
  if (!e) return [];
  const out: string[] = [];
  let buf = '';
  const SI = /<(?:\w+:)?si\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?si>)/g;
  const take = (final: boolean) => {
    const cut = final ? buf.length : buf.lastIndexOf('si>') + 3;
    if (cut <= 2) return;
    const seg = buf.slice(0, cut);
    buf = buf.slice(cut);
    SI.lastIndex = 0;
    let m: RegExpExecArray | null;
    // copy so that kept strings do not pin the decoded chunk (see copyStr in core.ts)
    while ((m = SI.exec(seg))) out.push((' ' + (m[1] ? richText(m[1]) : '')).slice(1));
  };
  await streamEntry(blob, e, (t) => {
    buf += t;
    if (buf.length > 1 << 20) take(false);
  }, { onProgress, isCancelled });
  take(true);
  return out;
}

/* ---------------- value formatting ---------------- */

function pad2(n: number) {
  return n < 10 ? '0' + n : String(n);
}

export function serialToDate(serial: number, date1904: boolean, fmt: { time: boolean; dateOnly: boolean }): string {
  const days = date1904 ? serial + 1462 : serial;
  const ms = Math.round((days - 25569) * 86400) * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  const date = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  const time = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
  if (serial < 1 && !fmt.dateOnly) return time;
  if (fmt.dateOnly || (!fmt.time && time === '00:00:00')) return date;
  return `${date} ${time}`;
}

/** Number as Excel shows it with the General format, but never in exponent notation:
 *  at most 15 significant digits (Excel's precision), no thousands separators. */
export function formatNumber(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  if (Number.isInteger(n)) {
    if (Math.abs(n) < 1e15) return String(n);
    const [m, e] = n.toExponential(14).split('e');
    const digits = m.replace('-', '').replace('.', '').replace(/0+$/, '');
    return (n < 0 ? '-' : '') + digits.padEnd(+e + 1, '0');
  }
  const s = String(parseFloat(n.toPrecision(15)));
  if (!/e/i.test(s)) return s;
  return n.toFixed(Math.min(20, Math.max(0, 15 - Math.floor(Math.log10(Math.abs(n))))))
    .replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

/* ---------------- sheet → CSV ---------------- */

export interface ConvertResult {
  rows: number; // data rows (heading excluded)
  headers: string[];
  numericColumns: string[]; // headings of columns that contain numeric cells
  warnings: string[];
}

function colIndex(ref: string): number {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/**
 * Converts one worksheet to CSV (comma, UTF-8, CRLF). `write` receives encoded
 * bytes in ~1 MB batches. The first non-empty row is treated as the heading row.
 */
export async function convertSheetToCsv(
  blob: Blob,
  sheetPath: string,
  write: (b: Uint8Array) => Promise<void>,
  opts: { onProgress?: (stage: string, done: number, total: number) => void; isCancelled?: () => boolean } = {},
): Promise<ConvertResult> {
  const idx = await readZipIndex(blob);
  const entry = idx.get(sheetPath);
  if (!entry) throw new XlsxError(`Sheet part ${sheetPath} not found in the workbook.`);
  const wbXml = (await entryText(blob, idx, 'xl/workbook.xml')) ?? '';
  const date1904 = /<(?:\w+:)?workbookPr\b[^>]*\bdate1904="(1|true)"/.test(wbXml);
  const styles = await readStyles(blob, idx);
  const sst = await readSharedStrings(blob, idx, (d, t) => opts.onProgress?.('Reading shared texts', d, t), opts.isCancelled);

  const enc = new TextEncoder();
  const csv = new CsvEncoder({ delimiter: ',', formulaGuard: false });
  let out = '';
  const flush = async () => {
    if (out) {
      const b = enc.encode(out);
      out = '';
      await write(b);
    }
  };

  let headers: string[] | null = null;
  let rows = 0;
  let width = 0;
  const numeric: number[] = [];
  const bigNumbers: number[] = [];
  let noCachedValue = 0;
  let buf = '';
  let closeTag = '</row>';
  let prefixKnown = false;

  const ROW = /<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g;
  const CELL = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
  const V = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/;
  const IS = /<(?:\w+:)?is\b[^>]*>([\s\S]*?)<\/(?:\w+:)?is>/;

  const parseRows = (seg: string) => {
    ROW.lastIndex = 0;
    let rm: RegExpExecArray | null;
    while ((rm = ROW.exec(seg))) {
      const inner = rm[2];
      if (!inner) continue;
      const vals: string[] = [];
      let next = 0;
      CELL.lastIndex = 0;
      let cm: RegExpExecArray | null;
      let any = false;
      while ((cm = CELL.exec(inner))) {
        const a = cm[1];
        const ref = /(?:^|\s)r="([A-Z]+)/.exec(a)?.[1];
        const ci = ref ? colIndex(ref) : next;
        next = ci + 1;
        const body = cm[2] ?? '';
        const t = /(?:^|\s)t="(\w+)"/.exec(a)?.[1] ?? 'n';
        let v = '';
        let isNum = false;
        if (t === 'inlineStr') {
          const is = IS.exec(body);
          v = is ? richText(is[1]) : '';
        } else {
          const vm = V.exec(body);
          const raw = vm ? vm[1] : '';
          if (!raw && body.indexOf('<f') >= 0) noCachedValue++;
          if (t === 's') v = raw ? sst[+raw] ?? '' : '';
          else if (t === 'str' || t === 'e' || t === 'd') v = xmlText(raw);
          else if (t === 'b') v = raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : raw;
          else if (raw !== '') {
            isNum = true;
            const s = /(?:^|\s)s="(\d+)"/.exec(a)?.[1];
            const f = s ? styles[+s] : undefined;
            if (f?.kind === 'date') v = serialToDate(Number(raw), date1904, f);
            else {
              v = formatNumber(raw);
              if (f?.kind === 'zeros' && /^\d+$/.test(v) && v.length < f.width) v = v.padStart(f.width, '0');
              if (Math.abs(Number(raw)) >= 1e15) bigNumbers[ci] = (bigNumbers[ci] ?? 0) + 1;
            }
          }
        }
        while (vals.length < ci) vals.push('');
        vals[ci] = v;
        if (v !== '') any = true;
        if (isNum && headers) numeric[ci] = (numeric[ci] ?? 0) + 1;
      }
      if (!any) continue;
      if (!headers) {
        headers = vals;
        width = vals.length;
      } else {
        rows++;
        while (vals.length < width) vals.push('');
      }
      out += csv.line(vals);
    }
  };

  await streamEntry(
    blob,
    entry,
    (t) => {
      buf += t;
      if (!prefixKnown) {
        const m = /<(\w+:)?sheetData\b/.exec(buf);
        if (m) {
          closeTag = `</${m[1] ?? ''}row>`;
          prefixKnown = true;
        }
      }
      const cut = buf.lastIndexOf(closeTag);
      if (cut >= 0) {
        const end = cut + closeTag.length;
        parseRows(buf.slice(0, end));
        buf = buf.slice(end);
      } else if (buf.length > 64 << 20) throw new XlsxError('A single worksheet row is larger than 64 MB; the file looks damaged.');
    },
    {
      onProgress: (d, t) => opts.onProgress?.('Converting sheet', d, t),
      isCancelled: opts.isCancelled,
      afterChunk: flush, // write converted rows to disk after every input chunk
    },
  );
  parseRows(buf);
  buf = '';
  await flush();

  const hdr = (headers ?? []) as string[];
  const warnings: string[] = [];
  const name = (i: number) => hdr[i] || `Column ${i + 1}`;
  const numericColumns = numeric.map((n, i) => (n ? name(i) : '')).filter(Boolean);
  bigNumbers.forEach((n, i) => {
    if (n)
      warnings.push(
        `Column "${name(i)}" has ${n.toLocaleString('en-IN')} number(s) with 16 or more digits stored as numbers. Excel keeps only 15 significant digits, so their last digits may already be wrong in the workbook. Store such IDs as text in Excel.`,
      );
  });
  if (!headers) warnings.push('The sheet is empty.');
  if (noCachedValue)
    warnings.push(
      `${noCachedValue.toLocaleString('en-IN')} formula cell(s) have no saved result (the file was not saved by Excel) and were left blank. Open and save the file in Excel to fix this.`,
    );
  return { rows, headers: hdr, numericColumns, warnings };
}
