// Engine benchmark in Node (same TypeScript engine that runs in the browser worker,
// reading files through disk-backed Blobs). Verifies results against the
// generator's ground truth.
//
//   npm run bench -- --data test-data/10L [--op common] [--dupA first] [--dupB first]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MatchEngine, type EngineFile } from '../src/engine/core';
import { cleanHeaders, countRecords, inspectHeader } from '../src/engine/csv';
import type { ByteSink, SinkFactory } from '../src/engine/sink';
import type { FileMeta, MatchConfig, OutputConfig } from '../src/engine/types';

function arg(name: string, def: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}
const DATA = path.resolve(arg('data', 'test-data/tiny'));
const OP = arg('op', 'common') as MatchConfig['operation'];
const DUPA = arg('dupA', 'first') as MatchConfig['dupA'];
const DUPB = arg('dupB', 'first') as MatchConfig['dupB'];
const KEEP = arg('keep', '');
const OUT_JSON = path.resolve(arg('json', 'bench-results/node.json'));
const manifest = JSON.parse(fs.readFileSync(path.join(DATA, 'manifest.json'), 'utf8'));

let peakRss = 0;
const sampler = setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage().rss)), 100);

function nodeSink(dir: string): SinkFactory {
  return {
    kind: 'node',
    async open(name): Promise<ByteSink> {
      const fd = fs.openSync(path.join(dir, name), 'w');
      return {
        async write(b) {
          fs.writeSync(fd, b);
        },
        async close() {
          fs.closeSync(fd);
        },
      };
    },
  };
}

async function main() {
  const t0 = Date.now();
  const files: EngineFile[] = [];
  const groups: [string, 'A' | 'B'][] = [
    ...manifest.groupA.files.map((f: string) => [f, 'A'] as [string, 'A']),
    ...manifest.groupB.files.map((f: string) => [f, 'B'] as [string, 'B']),
  ];
  for (const [name, group] of groups) {
    const blob = await (fs as any).openAsBlob(path.join(DATA, name));
    const h = await inspectHeader(blob);
    const { headers } = cleanHeaders(h.rawHeaders);
    const meta: FileMeta = {
      id: name, group, name, size: blob.size, delimiter: h.delimiter, encoding: h.encoding, headers, rawHeaders: h.rawHeaders,
      status: 'ready', warnings: [],
    };
    meta.rows = await countRecords(blob, meta.encoding, meta.delimiter, 8 << 20);
    files.push({ meta, blob });
  }
  const importMs = Date.now() - t0;
  const keyOf = (h: string[]) => h.find((x) => ['Consumer ID', 'CA Number', 'CA No', 'Account No'].includes(x))!;
  const cfg: MatchConfig = {
    keyColumns: Object.fromEntries(files.map((f) => [f.meta.id, [keyOf(f.meta.headers)]])),
    normalize: { trim: true, collapseSpaces: false, ignoreCase: false, stripLeadingZeros: false },
    operation: OP, dupA: DUPA, dupB: DUPB, dateColumns: {}, dateOrder: 'DMY', bCombine: 'union', allowCartesian: true, filters: [],
  };
  const out: OutputConfig = {
    columns: [
      { id: '1', kind: 'field', group: 'A', column: 'Consumer ID', label: 'Consumer ID' },
      { id: '2', kind: 'field', group: 'A', column: 'Division', label: 'Division' },
      { id: '3', kind: 'field', group: 'B', column: 'Consumer Name', label: 'Name', perFile: Object.fromEntries(files.filter((f) => f.meta.headers.includes('Name')).map((f) => [f.meta.id, 'Name'])) },
      { id: '4', kind: 'field', group: 'B', column: 'Mobile', label: 'Mobile', perFile: Object.fromEntries(files.filter((f) => f.meta.headers.includes('Mobile No')).map((f) => [f.meta.id, 'Mobile No'])) },
      { id: '5', kind: 'field', group: 'B', column: 'Arrear', label: 'Outstanding Amount' },
      { id: '6', kind: 'meta', meta: 'source_file_b', label: 'Source File' },
    ],
    missingValue: '',
    warnOnMissing: true,
  };
  const e = new MatchEngine(files, cfg, out, { chunkBytes: 8 << 20, cancelled: () => false, progress: () => {} });
  const t1 = Date.now();
  const stats = await e.analyze();
  const matchMs = Date.now() - t1;
  const dir = fs.mkdtempSync('/tmp/cm-bench-');
  const t2 = Date.now();
  const res = await e.export(nodeSink(dir), {
    format: 'csv', fileName: 'out', delimiter: ',', bom: true, formulaGuard: true, splitRows: 0, target: 'download',
  });
  const exportMs = Date.now() - t2;
  clearInterval(sampler);
  const expected =
    OP === 'common' && DUPA === 'first' && DUPB === 'first' ? manifest.expected.commonFirstFirst
      : OP === 'common' && DUPA === 'all' && DUPB === 'all' ? manifest.expected.commonAllAll
        : OP === 'a_not_b' && DUPA === 'first' ? manifest.expected.aNotB : undefined;
  const r = {
    at: new Date().toISOString(),
    data: path.basename(DATA), op: OP, dupA: DUPA, dupB: DUPB,
    groupA: manifest.groupA.rows, groupB: manifest.groupB.rows, files: files.length,
    inputMB: Math.round(files.reduce((s, f) => s + f.blob.size, 0) / 1048576),
    importMs, matchMs, exportMs,
    peakRssMB: Math.round(peakRss / 1048576),
    resultRows: res.rows, expectedRows: expected,
    correct: expected === undefined ? 'not checked' : res.rows === expected && stats.matchedKeys === manifest.expected.matchedKeys,
    matchedKeys: stats.matchedKeys, aDuplicateKeys: stats.aDuplicateKeys, bDuplicateKeys: stats.bDuplicateKeys,
    node: process.version, cpu: os.cpus()[0].model, cores: os.cpus().length, ramGB: Math.round(os.totalmem() / 1e9),
  };
  if (KEEP) fs.copyFileSync(path.join(dir, 'out.csv'), KEEP);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(JSON.stringify(r, null, 2));
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  const all = fs.existsSync(OUT_JSON) ? JSON.parse(fs.readFileSync(OUT_JSON, 'utf8')) : [];
  all.push(r);
  fs.writeFileSync(OUT_JSON, JSON.stringify(all, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
