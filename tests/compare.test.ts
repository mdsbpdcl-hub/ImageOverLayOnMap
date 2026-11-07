// Exhaustive comparison: Mode A (streaming engine), Mode B (SQL plan inside the real
// DuckDB-Wasm engine) and the simple reference implementation must agree on
//   • every output row (values and order),
//   • every statistic shown to the user,
//   • the duplicate report,
// for every combination of operation × duplicate rule A × duplicate rule B ×
// Group B combine mode × key normalisation × filters, on deliberately awkward data
// (BOM, CRLF/LF/CR, semicolon/tab/pipe, Windows-1252, quotes, multiline cells,
// blank lines, short and long rows, NBSP, duplicate headings, bad dates …).
//
// The default run covers every combination of operation and duplicate rules; set
// FULL=1 to also multiply by every normalisation and filter variant (~4,300 cases).

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';
import { MatchEngine, type EngineFile } from '../src/engine/core';
import { cleanHeaders, CsvStreamParser, transcodeToUtf8 } from '../src/engine/csv';
import { buildPlan, statsFromRow } from '../src/engine/sql';
import { memoryFactory } from '../src/engine/sink';
import type { AnalysisStats, BCombine, DupPolicy, Encoding, FileMeta, FilterRule, Group, MatchConfig, NormalizeOptions, Operation, OutputColumn, OutputConfig } from '../src/engine/types';
import { baseCfg, exportOpts, hooks, reference } from './helpers';

const require = createRequire(import.meta.url);
const duckdb = require('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');
const dist = path.resolve('node_modules/@duckdb/duckdb-wasm/dist');
let db: any;
let conn: any;

beforeAll(async () => {
  db = await duckdb.createDuckDB(
    {
      mvp: { mainModule: path.join(dist, 'duckdb-mvp.wasm'), mainWorker: path.join(dist, 'duckdb-node-mvp.worker.cjs') },
      eh: { mainModule: path.join(dist, 'duckdb-eh.wasm'), mainWorker: path.join(dist, 'duckdb-node-eh.worker.cjs') },
    },
    new duckdb.VoidLogger(),
    duckdb.NODE_RUNTIME,
  );
  await db.instantiate(() => {});
  conn = db.connect();
});

function q(sql: string): string[][] {
  const t = conn.query(sql);
  const cols = t.schema.fields.map((_: unknown, i: number) => t.getChildAt(i));
  const out: string[][] = [];
  for (let r = 0; r < t.numRows; r++) out.push(cols.map((c: any) => { const v = c.get(r); return v === null ? '' : String(v); }));
  return out;
}

/* ------------------------------------------------------------------ test data */

const cp1252 = (s: string) => {
  const map: Record<string, number> = { '“': 0x93, '”': 0x94, '–': 0x96, '€': 0x80, é: 0xe9 };
  return new Uint8Array([...s].map((ch) => map[ch] ?? ch.charCodeAt(0)));
};

const RAW: { id: string; group: Group; name: string; delim: string; enc: Encoding; bytes: Uint8Array }[] = [
  {
    id: 'a1', group: 'A', name: 'a1.csv', delim: ',', enc: 'utf-8',
    bytes: new TextEncoder().encode(
      '﻿Consumer ID,Division,Dt,Name\r\n' +
        '00123,Patna,05-01-2024,"Ram, K"\r\n' +
        '123,Gaya,2024-01-06,"multi\r\nline ""quoted"""\r\n' +
        ' abc ,Nalanda,07/01/2024,x\r\n' +
        '\r\n' +
        'ABC,Arrah,bad,y\r\n' +
        ',Blank,01-01-2024,z\r\n' +
        '00123,Patna2,06-01-2024 10:30,w\r\n' +
        ' k9 ,Buxar,,v\r\n' +
        'k  10,Rohtas,13-01-2024,u\r\n' +
        'K 10,Kaimur,12-01-2024,t\r\n' +
        '000,Zero,,s\r\n' +
        '0,Zero2,05-Jan-2024,r\r\n' +
        '"=1+2",Formula,,q\r\n' +
        'k11\r\n' +
        'ß1,Street,,p\r\n' +
        'k12,Long,,o\r\n' +
        'k13,TooLong,,o,EXTRA,MORE\r\n' +
        '   \r\n' +
        ',,,\r\n' +
        '"""",Quotes,,n\n' +
        'k14,MixedLF,,m\r' +
        'k15,"quoted, ""heading""",01-01-2024,l',
    ),
  },
  { id: 'a3', group: 'A', name: 'a3_header_only.csv', delim: ',', enc: 'utf-8', bytes: new TextEncoder().encode('Consumer ID,Division\r\n') },
  {
    id: 'a4', group: 'A', name: 'a4_utf16.csv', delim: ',', enc: 'utf-16le',
    bytes: (() => {
      const t = '﻿Consumer ID,Division\r\nk9,U16\r\nनया,हिंदी\r\n';
      const b = new Uint8Array(t.length * 2);
      for (let i = 0; i < t.length; i++) {
        b[i * 2] = t.charCodeAt(i) & 255;
        b[i * 2 + 1] = t.charCodeAt(i) >> 8;
      }
      return b;
    })(),
  },
  {
    id: 'a2', group: 'A', name: "a'2.csv", delim: ';', enc: 'utf-8',
    bytes: new TextEncoder().encode('Name;Consumer ID;Consumer ID;Dt\np;k9;dup;2023-12-31\nq;ABC;x;01-02-2024\nr;new1;;\ns;123;;31-12-2023\n'),
  },
  {
    id: 'b1', group: 'B', name: 'b1.csv', delim: ',', enc: 'utf-8',
    bytes: new TextEncoder().encode(
      'CA,Name,Amt,When\r\n' +
        '123,Sita,-25.5,01-03-2024\r\n' +
        '00123,Gita,100,02-03-2024\r\n' +
        'abc,lower,1,03-03-2024\r\n' +
        'ABC,Upper,2,02-03-2024\r\n' +
        '123,Sita2,7,05-03-2024\r\n' +
        ',NoKey,0,\r\n' +
        'k9,Nine,9,bad\r\n' +
        'K 10,Ten,10,\r\n' +
        '0,Z,0,01-01-2020\r\n' +
        'SS1,Strasse,5,\r\n' +
        'only-b,Extra,3,\r\n' +
        'only-b,Extra2,4,01-01-2021\r\n',
    ),
  },
  {
    id: 'b2', group: 'B', name: 'b2.tsv', delim: '\t', enc: 'utf-8',
    bytes: new TextEncoder().encode('Account\tName\tPhone\tWhen\r123\tT1\t9000000001\t2024-02-01\r00123\tT2\t\t2024-04-01 08:00\rnew1\tT3\t9000000003\t\r   \tSpace\t\t\rABC\tT4\t+919999\t\r'),
  },
  {
    id: 'b3', group: 'B', name: 'b3.csv', delim: '|', enc: 'windows-1252',
    bytes: cp1252('Account|Name|Phone|When\r\n123|“Ram” – €|900|04-03-2024\r\nk9|Café|=cmd|\r\nonly-b|B3|1|\r\n000|Zeros|2|01-01-2019\r\n'),
  },
];

let files: EngineFile[];
let texts: Map<string, string>;
const reg: Record<string, string> = {};

async function setupFiles() {
  files = [];
  texts = new Map();
  for (const r of RAW) {
    const text = new TextDecoder(r.enc).decode(r.bytes);
    texts.set(r.id, text);
    const rows: string[][] = [];
    const p = new CsvStreamParser(r.delim, (f) => rows.push(f));
    p.push(text, true);
    const { headers } = cleanHeaders(rows[0]);
    const meta: FileMeta = {
      id: r.id, group: r.group, name: r.name, size: r.bytes.length, delimiter: r.delim, encoding: r.enc, headers,
      rawHeaders: rows[0], rows: rows.length - 1, status: 'ready', warnings: [],
    };
    files.push({ meta, blob: new Blob([r.bytes as BlobPart]) });
    // Mode B gets UTF-8, exactly as the app prepares it
    const parts: Uint8Array[] = [];
    // (the app makes the same copy for non-UTF-8 files and files with mixed line endings)
    await transcodeToUtf8(new Blob([r.bytes as BlobPart]), r.enc, async (b) => void parts.push(b), { normalizeNewlines: true, chunkBytes: 5 });
    reg[r.id] = `cmp_${r.id}.csv`;
    db.registerFileBuffer(reg[r.id], new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer()));
  }
}

/* ------------------------------------------------------------------ configs */

const OPS: Operation[] = ['common', 'a_not_b', 'b_not_a', 'a_with_status'];
const POLS: DupPolicy[] = ['first', 'last', 'all', 'newest', 'unique'];
const NORMS: NormalizeOptions[] = [
  { trim: true, collapseSpaces: false, ignoreCase: false, stripLeadingZeros: false },
  { trim: true, collapseSpaces: true, ignoreCase: true, stripLeadingZeros: true },
  { trim: false, collapseSpaces: false, ignoreCase: false, stripLeadingZeros: false },
  { trim: false, collapseSpaces: true, ignoreCase: true, stripLeadingZeros: false },
];
const FILTERS: FilterRule[][] = [
  [],
  [{ id: 'f1', group: 'A', column: 'Division', op: 'not_equals', value: ' patna ' }],
  [{ id: 'f2', group: 'B', column: 'Name', op: 'contains', value: 'T' }, { id: 'f3', group: 'B', column: 'Phone', op: 'blank', value: '' }],
  [{ id: 'f4', group: 'B', column: 'When', op: 'not_blank', value: '' }, { id: 'f5', group: 'A', column: 'Dt', op: 'starts_with', value: '0' }],
];

const col = (id: string, group: Group, column: string, extra: Partial<OutputColumn> = {}): OutputColumn => ({ id, kind: 'field', group, column, label: `${group}:${column}`, ...extra });
const meta = (m: OutputColumn['meta']): OutputColumn => ({ id: 'm_' + m, kind: 'meta', meta: m, label: String(m) });

function outFor(bCombine: BCombine): OutputConfig {
  return {
    columns: [
      meta('match_key'), col('1', 'A', 'Consumer ID'), col('2', 'A', 'Division'), col('3', 'A', 'Name'), col('3b', 'A', 'Consumer ID (2)'),
      col('4', 'B', 'Name'), col('5', 'B', 'Amt'), col('6', 'B', 'Phone', bCombine === 'join' ? { fromFile: 'b3' } : {}),
      col('7', 'B', 'When', { perFile: { b2: 'When' } }), meta('match_status'), meta('count_a'), meta('count_b'),
      meta('source_file_a'), meta('source_file_b'), meta('row_number_a'), meta('row_number_b'),
    ],
    missingValue: '·',
    warnOnMissing: true,
  };
}

function configs(full: boolean): MatchConfig[] {
  const list: MatchConfig[] = [];
  let k = 0;
  for (const operation of OPS)
    for (const dupA of POLS)
      for (const bCombine of ['union', 'join'] as BCombine[])
        for (const dupB of POLS) {
          if (bCombine === 'join' && dupB === 'all') continue;
          const variants = full ? NORMS.flatMap((n) => FILTERS.map((f) => [n, f] as const)) : [[NORMS[k % NORMS.length], FILTERS[k % FILTERS.length]] as const];
          for (const [normalize, filters] of variants) {
            k++;
            list.push(
              baseCfg({
                keyColumns: { a1: ['Consumer ID'], a2: ['Consumer ID'], a3: ['Consumer ID'], a4: ['Consumer ID'], b1: ['CA'], b2: ['Account'], b3: ['Account'] },
                normalize, operation, dupA, dupB, bCombine, filters,
                dateColumns: { a1: 'Dt', a2: 'Dt', a3: 'Division', a4: 'Division', b1: 'When', b2: 'When', b3: 'When' },
                dateOrder: k % 3 === 0 ? 'MDY' : 'DMY',
                allowCartesian: true,
              }),
            );
          }
        }
  return list;
}

const STAT_KEYS: (keyof AnalysisStats)[] = [
  'aRows', 'bRows', 'aUniqueKeys', 'bUniqueKeys', 'matchedKeys', 'unmatchedAKeys', 'unmatchedBKeys', 'aDuplicateKeys',
  'aDuplicateRows', 'bDuplicateKeys', 'bDuplicateRows', 'aBlankKeys', 'bBlankKeys', 'aFiltered', 'bFiltered',
  'badDates', 'expectedOutputRows', 'cartesianKeys', 'missingFieldWarnings',
];

async function runA(cfg: MatchConfig, out: OutputConfig) {
  const e = new MatchEngine(files, cfg, out, hooks(7));
  const stats = await e.analyze();
  const f = memoryFactory();
  await e.export(f, exportOpts);
  const rows: string[][] = [];
  const p = new CsvStreamParser(',', (r) => rows.push(r));
  p.push(await f.blobs!.get('out.csv')!.text(), true);
  const df = memoryFactory();
  await e.duplicateReport(df, exportOpts);
  const dup: string[][] = [];
  const p2 = new CsvStreamParser(',', (r) => dup.push(r));
  p2.push(await df.blobs!.get('out.csv')!.text(), true);
  const preview = await e.preview(3);
  return { stats, rows: rows.slice(1), dup: dup.slice(1).map((r) => r.join('|')).sort(), preview };
}

function runB(cfg: MatchConfig, out: OutputConfig) {
  // the app hands DuckDB UTF-8 copies of non-UTF-8 files (see App.analyze)
  const metas = files.map((f) => ({ ...f.meta, encoding: 'utf-8' as const }));
  const plan = buildPlan(metas, reg, cfg, out);
  for (const s of plan.setup) conn.query(s);
  const rows = q(plan.exportSql);
  const s = conn.query(plan.statsSql[0]).toArray()[0].toJSON();
  const n = q(plan.countSql)[0][0];
  const stats = statsFromRow(s, n, metas, cfg, out, 0);
  const dup = q(plan.dupReportSql).map((r) => r.join('|')).sort();
  return { stats, rows, dup };
}

describe('Mode A = Mode B = reference, for every option combination', () => {
  beforeAll(setupFiles);
  const full = process.env.FULL === '1';
  const list = configs(full);
  it(`compares ${full ? 'every' : 'every operation × duplicate-rule'} combination (${list.length} cases)`, async () => {
    let compared = 0;
    for (const cfg of list) {
      const out = outFor(cfg.bCombine);
      const label = `${cfg.operation} A:${cfg.dupA} B:${cfg.dupB} ${cfg.bCombine} norm:${JSON.stringify(cfg.normalize)} filters:${cfg.filters.map((f) => f.id)} ${cfg.dateOrder}`;
      const a = await runA(cfg, out);
      const b = runB(cfg, out);
      const ref = reference(files, texts, cfg, out);
      expect({ label, rows: a.rows }).toEqual({ label, rows: ref });
      expect({ label, rows: b.rows }).toEqual({ label, rows: ref });
      for (const k of STAT_KEYS) {
        const av = a.stats[k], bv = b.stats[k];
        expect({ label, stat: k, value: av }).toEqual({ label, stat: k, value: bv });
      }
      expect({ label, dup: a.dup }).toEqual({ label, dup: b.dup });
      expect({ label, preview: a.preview }).toEqual({ label, preview: ref.slice(0, 3) });
      compared++;
    }
    expect(compared).toBe(list.length);
  }, 600_000);
});
