// Synthetic consumer data generator.
//
//   npm run gen:data -- --a 100000 --b 1000000 --bfiles 3 --match 0.6 --dups 0.05 --out test-data/1L
//
// Writes Group A (targets) and Group B (masters, split over several files with
// different headings) plus manifest.json holding the ground truth used by the
// benchmark to verify correctness. Data is fictitious.

import fs from 'node:fs';
import path from 'node:path';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

const A_ROWS = +arg('a', '100000');
const B_ROWS = +arg('b', '1000000');
const A_FILES = +arg('afiles', '1');
const B_FILES = +arg('bfiles', '3');
const MATCH = +arg('match', '0.6'); // share of distinct A consumers that exist in B
const DUPS = +arg('dups', '0.03'); // share of rows that repeat an earlier consumer (both groups)
const OUT = arg('out', 'test-data/sample');
const SEED = +arg('seed', '42');

let s = SEED >>> 0 || 1;
const rnd = () => {
  s ^= s << 13; s >>>= 0;
  s ^= s >>> 17;
  s ^= s << 5; s >>>= 0;
  return s / 4294967296;
};
const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];

const FIRST = ['Ram', 'Sita', 'Mohan', 'Geeta', 'Suresh', 'Anita', 'Rajesh', 'Pooja', 'Amit', 'Kiran', 'Vijay', 'Rekha', 'Manoj', 'Sunita', 'Arjun', 'राम', 'सीता'];
const LAST = ['Kumar', 'Singh', 'Prasad', 'Yadav', 'Sharma', 'Devi', 'Gupta', 'Mishra', 'Paswan', 'Mahto', 'Jha', 'Sinha'];
const DIV = ['Patna East', 'Patna West', 'Gaya Urban', 'Nalanda', 'Bhojpur', 'Rohtas', 'Aurangabad', 'Nawada', 'Jehanabad', 'Buxar', 'Kaimur'];
const TARIFF = ['DS-I', 'DS-II', 'NDS-I', 'NDS-II', 'LTIS', 'IAS'];

// 12-digit consumer numbers; ~15% have leading zeros, which must survive untouched.
function consumerId(n: number): string {
  const base = String(100000000000 + n * 7919 + (n % 97));
  return rnd() < 0.15 ? '00' + base : base; // different length, so still unique
}

function esc(v: string) {
  return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

class Out {
  private buf: string[] = [];
  private len = 0;
  private fd: number;
  bytes = 0;
  constructor(file: string) {
    this.fd = fs.openSync(file, 'w');
  }
  line(vals: string[], d = ',') {
    const l = vals.map(esc).join(d) + '\r\n';
    this.buf.push(l);
    this.len += l.length;
    if (this.len > 4 << 20) this.flush();
  }
  flush() {
    const b = Buffer.from(this.buf.join(''), 'utf8');
    fs.writeSync(this.fd, b);
    this.bytes += b.length;
    this.buf = [];
    this.len = 0;
  }
  close() {
    this.flush();
    fs.closeSync(this.fd);
  }
}

fs.mkdirSync(OUT, { recursive: true });

// Distinct consumers of Group A, then which of them exist in B.
const distinctA = Math.max(1, Math.round(A_ROWS * (1 - DUPS)));
const aIds: string[] = new Array(distinctA);
for (let i = 0; i < distinctA; i++) aIds[i] = consumerId(i);
const inB = new Uint8Array(distinctA);
for (let i = 0; i < distinctA; i++) inB[i] = rnd() < MATCH ? 1 : 0;

// Group A
const aHeader = ['Consumer ID', 'Division', 'Sub Division', 'Meter No'];
const aPer = Math.ceil(A_ROWS / A_FILES);
const aFiles: string[] = [];
const aKeyCount = new Map<number, number>();
let written = 0;
for (let f = 0; f < A_FILES; f++) {
  const name = `group_a_targets_${f + 1}.csv`;
  aFiles.push(name);
  const o = new Out(path.join(OUT, name));
  o.line(aHeader);
  for (let r = 0; r < aPer && written < A_ROWS; r++, written++) {
    const idx = written < distinctA ? written : Math.floor(rnd() * distinctA);
    aKeyCount.set(idx, (aKeyCount.get(idx) ?? 0) + 1);
    o.line([aIds[idx], pick(DIV), 'SD-' + (1 + Math.floor(rnd() * 40)), 'M' + Math.floor(rnd() * 1e9)]);
  }
  o.close();
}

// Group B: matched A consumers + extra consumers + duplicates, shuffled across files.
const matchedIdx: number[] = [];
for (let i = 0; i < distinctA; i++) if (inB[i]) matchedIdx.push(i);
const bHeaders = [
  ['CA Number', 'Consumer Name', 'Father Name', 'Address', 'Mobile', 'Arrear', 'Tariff', 'Last Payment Date'],
  ['CA No', 'Name', 'Address', 'Mobile No', 'Arrear', 'Load KW', 'Last Payment Date'],
  ['Account No', 'Consumer Name', 'Mobile', 'Arrear', 'Tariff', 'Last Payment Date'],
];
const bFiles: string[] = [];
const outs: Out[] = [];
for (let f = 0; f < B_FILES; f++) {
  const name = `group_b_master_${f + 1}.csv`;
  bFiles.push(name);
  const o = new Out(path.join(OUT, name));
  o.line(bHeaders[f % bHeaders.length]);
  outs.push(o);
}
const bDistinct = Math.max(matchedIdx.length, Math.round(B_ROWS * (1 - DUPS)));
let bWritten = 0;
const bMatchedRowCount = new Map<number, number>(); // rows in B for each matched A consumer
const emitB = (id: string, aIdx: number) => {
  const f = Math.floor(rnd() * B_FILES);
  const h = bHeaders[f % bHeaders.length];
  const name = `${pick(FIRST)} ${pick(LAST)}`;
  const vals: Record<string, string> = {
    'CA Number': id, 'CA No': id, 'Account No': id,
    'Consumer Name': name, Name: name,
    'Father Name': `${pick(FIRST)} ${pick(LAST)}`,
    Address: rnd() < 0.05 ? `Ward ${Math.floor(rnd() * 50)}, "Near Temple"\nVillage ${pick(DIV)}` : `Ward ${Math.floor(rnd() * 50)}, ${pick(DIV)}`,
    Mobile: '9' + String(Math.floor(rnd() * 1e9)).padStart(9, '0'),
    'Mobile No': '9' + String(Math.floor(rnd() * 1e9)).padStart(9, '0'),
    Arrear: (rnd() < 0.1 ? '-' : '') + (rnd() * 50000).toFixed(2),
    Tariff: pick(TARIFF),
    'Load KW': (1 + Math.floor(rnd() * 10)).toString(),
    'Last Payment Date': `${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')}-${String(1 + Math.floor(rnd() * 12)).padStart(2, '0')}-20${20 + Math.floor(rnd() * 6)}`,
  };
  outs[f].line(h.map((c) => vals[c] ?? ''));
  bWritten++;
  if (aIdx >= 0) bMatchedRowCount.set(aIdx, (bMatchedRowCount.get(aIdx) ?? 0) + 1);
};
// interleave matched and extra consumers deterministically
const extra = Math.max(0, bDistinct - matchedIdx.length);
let mi = 0, ei = 0;
const seen: { id: string; a: number }[] = [];
while (mi < matchedIdx.length || ei < extra) {
  const takeMatched = mi < matchedIdx.length && (ei >= extra || rnd() < matchedIdx.length / (matchedIdx.length + extra));
  let rec: { id: string; a: number };
  if (takeMatched) rec = { id: aIds[matchedIdx[mi++]], a: matchedIdx[mi - 1] };
  else rec = { id: consumerId(distinctA + 1_000_000 + ei++), a: -1 };
  emitB(rec.id, rec.a);
  if (seen.length < 200000) seen.push(rec);
  else if (rnd() < 0.01) seen[Math.floor(rnd() * seen.length)] = rec;
  if (bWritten < B_ROWS && rnd() < DUPS) {
    const d = pick(seen);
    emitB(d.id, d.a);
  }
}
for (const o of outs) o.close();

// Ground truth for the default benchmark configuration
// (common consumers, keep first in A, keep first in B, exact match).
const matchedKeys = matchedIdx.length;
let aDupKeys = 0;
for (const c of aKeyCount.values()) if (c > 1) aDupKeys++;
const manifest = {
  generated: new Date().toISOString(),
  seed: SEED,
  groupA: { files: aFiles, rows: written, distinctKeys: distinctA, duplicateKeys: aDupKeys },
  groupB: { files: bFiles, rows: bWritten, headers: bHeaders.slice(0, B_FILES) },
  expected: {
    commonFirstFirst: matchedKeys, // one output row per matched distinct A key
    aNotB: distinctA - matchedKeys,
    matchedKeys,
    commonAllAll: Array.from(bMatchedRowCount.entries()).reduce((sum, [a, n]) => sum + n * (aKeyCount.get(a) ?? 0), 0),
  },
  bytes: Object.fromEntries([...aFiles, ...bFiles].map((f) => [f, fs.statSync(path.join(OUT, f)).size])),
};
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Wrote ${OUT}: A ${written} rows in ${A_FILES} file(s), B ${bWritten} rows in ${B_FILES} file(s); matched keys ${matchedKeys}`);
