// Builds an offline DuckDB job (same as the app's "Download offline job") for a
// generated dataset, using the benchmark's default settings. Used to cross-check
// the browser result against native DuckDB.
import fs from 'node:fs';
import path from 'node:path';
import { cleanHeaders, inspectHeader } from '../src/engine/csv';
import { buildOfflineScript } from '../src/engine/sql';
import type { FileMeta, MatchConfig, OutputConfig } from '../src/engine/types';

const dir = path.resolve(process.argv[2] ?? 'test-data/tiny');
const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const metas: FileMeta[] = [];
for (const [name, group] of [...m.groupA.files.map((f: string) => [f, 'A']), ...m.groupB.files.map((f: string) => [f, 'B'])]) {
  const blob = await (fs as any).openAsBlob(path.join(dir, name));
  const h = await inspectHeader(blob);
  metas.push({ id: name, group, name, size: blob.size, delimiter: h.delimiter, encoding: h.encoding, headers: cleanHeaders(h.rawHeaders).headers, rawHeaders: h.rawHeaders, status: 'ready', warnings: [] });
}
const key = (h: string[]) => h.find((x) => ['Consumer ID', 'CA Number', 'CA No', 'Account No'].includes(x))!;
const cfg: MatchConfig = {
  keyColumns: Object.fromEntries(metas.map((f) => [f.id, [key(f.headers)]])),
  normalize: { trim: true, collapseSpaces: false, ignoreCase: false, stripLeadingZeros: false },
  operation: 'common', dupA: 'first', dupB: 'first', dateColumns: {}, dateOrder: 'DMY', bCombine: 'union', allowCartesian: false, filters: [],
};
const pf = (h: string) => Object.fromEntries(metas.filter((f) => f.headers.includes(h)).map((f) => [f.id, h]));
const out: OutputConfig = {
  columns: [
    { id: '1', kind: 'field', group: 'A', column: 'Consumer ID', label: 'Consumer ID' },
    { id: '2', kind: 'field', group: 'A', column: 'Division', label: 'Division' },
    { id: '3', kind: 'field', group: 'B', column: 'Consumer Name', label: 'Consumer Name', perFile: pf('Name') },
    { id: '4', kind: 'field', group: 'B', column: 'Mobile', label: 'Mobile', perFile: pf('Mobile No') },
    { id: '5', kind: 'field', group: 'B', column: 'Arrear', label: 'Arrear' },
    { id: '6', kind: 'meta', meta: 'source_file_b', label: 'Source File (B)' },
  ],
  missingValue: '', warnOnMissing: true,
};
fs.writeFileSync(process.argv[3] ?? '/tmp/job.sql', buildOfflineScript(metas, cfg, out, process.argv[4] ?? '/tmp/offline_out.csv', ','));
