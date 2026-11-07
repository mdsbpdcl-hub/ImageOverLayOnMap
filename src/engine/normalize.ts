import { KEY_SEP, type DateOrder, type NormalizeOptions } from './types';

// Whitespace class kept identical to the DuckDB (RE2) expression in sql.ts.
const WS_EDGE = /^[ \t\r\n\f\v ]+|[ \t\r\n\f\v ]+$/g;
const WS_RUN = /[ \t\r\n\f\v ]+/g;
const LEADING_ZEROS = /^0+(.)/;

const NON_ASCII = /[^\x00-\x7f]/;
const LOWER_ASCII = /[a-z]+/g;

/**
 * Case-insensitive comparison folds only the letters a–z to A–Z, in both engines
 * (DuckDB uses translate() with the same 26 letters). Unicode upper-casing differs
 * between JavaScript and DuckDB for some letters (JavaScript: "ß" → "SS", DuckDB:
 * "ß" → "ẞ"), which would make the two engines disagree about matches. Consumer
 * numbers and Hindi text are unaffected; accented Latin letters keep their case.
 */
export function upperSimple(s: string): string {
  if (!NON_ASCII.test(s)) return s.toUpperCase();
  return s.replace(LOWER_ASCII, (m) => m.toUpperCase());
}

/** Returns a function that normalises one key part. Values always stay strings. */
export function makePartNormalizer(o: NormalizeOptions): (v: string) => string {
  return (v: string) => {
    let s = v;
    if (o.trim) s = s.replace(WS_EDGE, '');
    if (o.collapseSpaces) s = s.replace(WS_RUN, ' ');
    if (o.ignoreCase) s = upperSimple(s);
    if (o.stripLeadingZeros) s = s.replace(LEADING_ZEROS, '$1');
    return s;
  };
}

/**
 * Builds the composite key for a row. Returns '' (blank key) when ANY part is blank:
 * an incomplete key is never matched against anything, including other blank keys.
 */
export function makeKeyBuilder(o: NormalizeOptions, idx: number[]): (fields: string[]) => string {
  const norm = makePartNormalizer(o);
  if (idx.length === 1) {
    const i = idx[0];
    return (f) => (i < 0 ? '' : norm(f[i] ?? ''));
  }
  return (f) => {
    let key = '';
    for (let p = 0; p < idx.length; p++) {
      const i = idx[p];
      const v = i < 0 ? '' : norm(f[i] ?? '');
      if (v === '') return '';
      key = p === 0 ? v : key + KEY_SEP + v;
    }
    return key;
  };
}

export function displayKey(k: string): string {
  return k.split(KEY_SEP).join(' | ');
}

const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

/**
 * Parses dates for the "keep newest" rule. Accepted (separators - / . ):
 *   YYYY-MM-DD, and per dateOrder DD-MM-YYYY / MM-DD-YYYY, DD-Mon-YYYY,
 *   each optionally followed by ' HH:MM' or ' HH:MM:SS' (or 'T' for ISO).
 * Returns NaN when the value cannot be parsed. Mirrors sql.ts dateExpr().
 */
export function parseDate(raw: string, order: DateOrder): number {
  const s = raw.trim();
  if (!s) return NaN;
  const m = /^(\d{1,4})[-/.]([A-Za-z]{3}|\d{1,2})[-/.](\d{1,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (!m) return NaN;
  let y: number, mo: number, d: number;
  const a = m[1], b = m[2], c = m[3];
  const bMonth = /[A-Za-z]/.test(b) ? MONTHS[b.toUpperCase()] : undefined;
  if (/[A-Za-z]/.test(b) && !bMonth) return NaN;
  if (a.length === 4) {
    if (bMonth) return NaN;
    y = +a; mo = +b; d = +c;
    if (c.length > 2) return NaN;
  } else {
    if (c.length !== 4) return NaN;
    y = +c;
    if (bMonth) {
      if (order === 'YMD') return NaN;
      d = +a; mo = bMonth;
    } else if (order === 'MDY') {
      mo = +a; d = +b;
    } else if (order === 'DMY') {
      d = +a; mo = +b;
    } else return NaN;
  }
  const hh = m[4] ? +m[4] : 0, mi = m[5] ? +m[5] : 0, ss = m[6] ? +m[6] : 0;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59 || ss > 59) return NaN;
  const t = Date.UTC(y, mo - 1, d, hh, mi, ss);
  const chk = new Date(t);
  if (chk.getUTCDate() !== d) return NaN; // 31-02-2024 etc.
  return t;
}
