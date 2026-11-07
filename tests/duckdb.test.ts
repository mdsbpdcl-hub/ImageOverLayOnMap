// Runs the Mode B SQL plan inside the real DuckDB-Wasm engine (Node build of the
// same .wasm used in the browser) and checks it gives identical results to the
// reference implementation and therefore to Mode A.

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildPlan } from '../src/engine/sql';
import type { DupPolicy, MatchConfig, Operation, OutputConfig, OutputColumn } from '../src/engine/types';
import { baseCfg, csv, makeFile, reference } from './helpers';

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

function rows(sql: string): string[][] {
  const t = conn.query(sql);
  const out: string[][] = [];
  const cols = t.schema.fields.map((_: unknown, i: number) => t.getChildAt(i));
  for (let r = 0; r < t.numRows; r++) out.push(cols.map((c: any) => String(c.get(r))));
  return out;
}

function rnd(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}
const col = (id: string, group: 'A' | 'B', column: string, extra: Partial<OutputColumn> = {}): OutputColumn => ({
  id, kind: 'field', group, column, label: column, ...extra,
});
const meta = (m: OutputColumn['meta']): OutputColumn => ({ id: 'm_' + m, kind: 'meta', meta: m, label: String(m) });

describe('Mode B (DuckDB-Wasm) equals reference', () => {
  const ops: Operation[] = ['common', 'a_not_b', 'b_not_a', 'a_with_status'];
  const pols: DupPolicy[] = ['first', 'last', 'all', 'newest', 'unique'];
  for (let seed = 1; seed <= 10; seed++) {
    it(`seed ${seed}`, () => {
      const r = rnd(seed * 7);
      const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
      const ids = Array.from({ length: 20 }, (_, i) => (r() < 0.2 ? '00' : '') + 'k' + i);
      const date = () => pick(['', 'bad', '2024-01-0' + (1 + Math.floor(r() * 9)), `${1 + Math.floor(r() * 28)}/0${1 + Math.floor(r() * 9)}/2023`, '12-Mar-2022 10:15']);
      const mk = (n: number, hdr: string[], f: () => string[], d = ',') => csv([hdr, ...Array.from({ length: n }, f)], d);
      const a1 = mk(30, ['ID', 'Zone', 'Dt'], () => [r() < 0.05 ? '' : pick(ids) + (r() < 0.2 ? '  ' : ''), 'z,' + Math.floor(r() * 9), date()]);
      const a2 = mk(12, ['Zone', 'ID', 'Dt'], () => ['"q"\n' + Math.floor(r() * 9), pick(ids).toUpperCase(), date()], ';');
      const b1 = mk(40, ['CA', 'Name', 'Amt', 'When'], () => [pick(ids), 'n' + Math.floor(r() * 99), r() < 0.2 ? '' : String(Math.floor(r() * 1000) - 500), date()]);
      const b2 = mk(25, ['Account', 'Name', 'Phone', 'When'], () => [r() < 0.05 ? ' ' : pick(ids), 'm' + Math.floor(r() * 99), '0' + Math.floor(r() * 1e9), date()], '\t');
      const files = [
        makeFile('a1', 'A', 'a1.csv', a1), makeFile('a2', 'A', "a'2.csv", a2, ';'),
        makeFile('b1', 'B', 'b1.csv', b1), makeFile('b2', 'B', 'b2.tsv', b2, '\t'),
      ];
      const texts = new Map([['a1', a1], ['a2', a2], ['b1', b1], ['b2', b2]]);
      const reg: Record<string, string> = {};
      for (const f of files) {
        reg[f.meta.id] = `t${seed}_${f.meta.id}.csv`;
        db.registerFileText(reg[f.meta.id], texts.get(f.meta.id)!);
      }
      for (let k = 0; k < 8; k++) {
        const bCombine = r() < 0.35 ? 'join' : 'union';
        const cfg: MatchConfig = baseCfg({
          keyColumns: { a1: ['ID'], a2: ['ID'], b1: ['CA'], b2: ['Account'] },
          normalize: { trim: r() < 0.6, collapseSpaces: r() < 0.3, ignoreCase: r() < 0.5, stripLeadingZeros: r() < 0.5 },
          operation: pick(ops),
          dupA: pick(pols),
          dupB: bCombine === 'join' ? pick(pols.filter((p) => p !== 'all')) : pick(pols),
          dateColumns: { a1: 'Dt', a2: 'Dt', b1: 'When', b2: 'When' },
          dateOrder: pick(['DMY', 'MDY', 'YMD'] as const),
          bCombine,
          allowCartesian: true,
          filters: r() < 0.4 ? [{ id: 'f', group: 'B', column: 'Name', op: pick(['contains', 'starts_with', 'not_equals'] as const), value: 'N1' }] : [],
        });
        const out: OutputConfig = {
          columns: [
            meta('match_key'), col('1', 'A', 'ID'), col('2', 'A', 'Zone'), col('3', 'B', 'Name'), col('4', 'B', 'Amt'),
            col('5', 'B', 'Phone', bCombine === 'join' ? { fromFile: 'b2' } : {}), meta('match_status'), meta('count_a'),
            meta('count_b'), meta('source_file_a'), meta('source_file_b'), meta('row_number_a'), meta('row_number_b'),
          ],
          missingValue: 'N/A',
          warnOnMissing: true,
        };
        const plan = buildPlan(files.map((f) => f.meta), reg, cfg, out);
        for (const s of plan.setup) conn.query(s);
        const got = rows(plan.exportSql);
        const want = reference(files, texts, cfg, out);
        expect({ k, cfg: JSON.stringify(cfg), got }).toEqual({ k, cfg: JSON.stringify(cfg), got: want });
        expect(Number(rows(plan.countSql)[0][0])).toBe(want.length);
        rows(plan.statsSql[0]);
        rows(plan.dupReportSql);
      }
    });
  }
});

describe('Windows-1252 ("ANSI") files in Mode B', () => {
  it('DuckDB rejects them as latin-1, the UTF-8 copy matches correctly', async () => {
    const { transcodeToUtf8 } = await import('../src/engine/csv');
    // “Ram” – €5 written by Excel as ANSI: bytes 0x93, 0x94, 0x96, 0x80
    const ansi = new Uint8Array([...new TextEncoder().encode('CA,Name\r\n001,'), 0x93, 0x52, 0x61, 0x6d, 0x94, 0x20, 0x96, 0x20, 0x80, 0x35, 0x0d, 0x0a]);
    db.registerFileBuffer('ansi.csv', ansi);
    expect(() => conn.query(`SELECT * FROM read_csv('ansi.csv', encoding = 'latin-1', all_varchar = true)`)).toThrow(/latin-1/);
    const parts: Uint8Array[] = [];
    await transcodeToUtf8(new Blob([ansi]), 'windows-1252', async (b) => void parts.push(b), { chunkBytes: 5 });
    const utf8 = new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer());
    db.registerFileBuffer('ansi_utf8.csv', utf8);
    const a = makeFile('a', 'A', 'a.csv', 'ID\r\n001\r\n');
    const b = makeFile('b', 'B', 'ansi.csv', new TextDecoder().decode(utf8));
    const plan = buildPlan([a.meta, b.meta], { a: 'ansi_a.csv', b: 'ansi_utf8.csv' }, baseCfg({ keyColumns: { a: ['ID'], b: ['CA'] } }), {
      columns: [col('1', 'A', 'ID'), col('2', 'B', 'Name')],
      missingValue: '',
      warnOnMissing: true,
    });
    db.registerFileText('ansi_a.csv', 'ID\r\n001\r\n');
    for (const s of plan.setup) conn.query(s);
    expect(rows(plan.exportSql)).toEqual([['001', '“Ram” – €5']]);
  });
});
