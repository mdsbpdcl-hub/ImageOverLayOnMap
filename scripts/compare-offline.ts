// Compares the streaming engine with the optional offline tool (native DuckDB via
// python/offline_matcher.py) for many settings on the sample files.
//   npx tsx scripts/compare-offline.ts [data-dir]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { MatchEngine, type EngineFile } from '../src/engine/core';
import { cleanHeaders, CsvStreamParser, inspectHeader } from '../src/engine/csv';
import { buildOfflineScript } from '../src/engine/sql';
import { memoryFactory } from '../src/engine/sink';
import type { DupPolicy, FileMeta, MatchConfig, Operation, OutputConfig } from '../src/engine/types';

const dir = path.resolve(process.argv[2] ?? 'samples');
const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const parse = (t: string) => {
  const rows: string[][] = [];
  const p = new CsvStreamParser(',', (r) => rows.push(r));
  p.push(t.replace(/^﻿/, ''), true);
  return rows;
};

const files: EngineFile[] = [];
for (const [name, group] of [...m.groupA.files.map((f: string) => [f, 'A']), ...m.groupB.files.map((f: string) => [f, 'B'])]) {
  const blob = new Blob([fs.readFileSync(path.join(dir, name))]);
  const h = await inspectHeader(blob);
  const meta: FileMeta = { id: name, group, name, size: blob.size, delimiter: h.delimiter, encoding: h.encoding, headers: cleanHeaders(h.rawHeaders).headers, rawHeaders: h.rawHeaders, status: 'ready', warnings: [] };
  files.push({ meta, blob });
}
const metas = files.map((f) => f.meta);
const key = (h: string[]) => h.find((x) => ['Consumer ID', 'CA Number', 'CA No', 'Account No'].includes(x))!;
const pf = (h: string) => Object.fromEntries(metas.filter((f) => f.headers.includes(h)).map((f) => [f.id, h]));
const out: OutputConfig = {
  columns: [
    { id: '1', kind: 'field', group: 'A', column: 'Consumer ID', label: 'Consumer ID' },
    { id: '2', kind: 'field', group: 'A', column: 'Division', label: 'Division' },
    { id: '3', kind: 'field', group: 'B', column: 'Consumer Name', label: 'Name', perFile: pf('Name') },
    { id: '4', kind: 'field', group: 'B', column: 'Mobile', label: 'Mobile', perFile: pf('Mobile No') },
    { id: '5', kind: 'field', group: 'B', column: 'Address', label: 'Address' },
    { id: '6', kind: 'field', group: 'B', column: 'Last Payment Date', label: 'Paid' },
    ...(['match_key', 'match_status', 'source_file_a', 'source_file_b', 'count_a', 'count_b', 'row_number_a', 'row_number_b'] as const).map((x) => ({ id: x, kind: 'meta' as const, meta: x, label: x })),
  ],
  missingValue: 'NA',
  warnOnMissing: true,
};
const ops: Operation[] = ['common', 'a_not_b', 'b_not_a', 'a_with_status'];
const pols: DupPolicy[] = ['first', 'last', 'all', 'newest', 'unique'];
let ok = 0, n = 0;
for (const operation of ops)
  for (const dupB of pols)
    for (const bCombine of ['union', 'join'] as const) {
      if (bCombine === 'join' && dupB === 'all') continue;
      n++;
      const cfg: MatchConfig = {
        keyColumns: Object.fromEntries(metas.map((f) => [f.id, [key(f.headers)]])),
        normalize: { trim: true, collapseSpaces: n % 2 === 0, ignoreCase: n % 3 === 0, stripLeadingZeros: n % 4 === 0 },
        operation, dupA: pols[n % 5], dupB, bCombine, allowCartesian: true, filters: [], dateOrder: 'DMY',
        dateColumns: Object.fromEntries(metas.map((f) => [f.id, f.group === 'B' ? 'Last Payment Date' : 'Division'])),
      };
      if (cfg.dupA === 'newest') cfg.dupA = 'first'; // targets have no date column
      const e = new MatchEngine(files, cfg, out, { progress: () => {}, cancelled: () => false, chunkBytes: 1 << 16 });
      await e.analyze();
      const f = memoryFactory();
      await e.export(f, { format: 'csv', fileName: 'o', delimiter: ',', bom: false, formulaGuard: false, splitRows: 0, target: 'download' });
      const mine = parse(await f.blobs!.get('o.csv')!.text());
      fs.writeFileSync('/tmp/cmp_job.sql', buildOfflineScript(metas, cfg, out, '/tmp/cmp_offline.csv', ','));
      execFileSync('python3', ['python/offline_matcher.py', '--temp-dir', '/tmp/cm_tmp', 'job', '/tmp/cmp_job.sql', '--data-dir', dir], { stdio: 'ignore' });
      const theirs = parse(fs.readFileSync('/tmp/cmp_offline.csv', 'utf8'));
      const same = JSON.stringify(mine) === JSON.stringify(theirs);
      if (same) ok++;
      else console.log('DIFFERENT', JSON.stringify({ operation, dupA: cfg.dupA, dupB, bCombine, rows: [mine.length, theirs.length] }));
    }
console.log(`${ok}/${n} settings identical between the app engine and native DuckDB (offline tool)`);
