// Test helpers: an intentionally simple in-memory reference implementation of the
// matching semantics, used to verify the streaming engine on randomised data.

import { MatchEngine, type EngineFile } from '../src/engine/core';
import { memoryFactory } from '../src/engine/sink';
import { cleanHeaders, CsvStreamParser } from '../src/engine/csv';
import { makeKeyBuilder, parseDate, displayKey, upperSimple } from '../src/engine/normalize';
import type { ExportOptions, FileMeta, MatchConfig, OutputConfig, Group } from '../src/engine/types';

export function csv(rows: string[][], d = ','): string {
  return rows
    .map((r) =>
      r.map((v) => (/["\r\n]/.test(v) || v.includes(d) ? '"' + v.replace(/"/g, '""') + '"' : v)).join(d),
    )
    .join('\r\n') + '\r\n';
}

export function makeFile(id: string, group: Group, name: string, text: string, d = ','): EngineFile {
  const blob = new Blob([text]);
  const rows: string[][] = [];
  const p = new CsvStreamParser(d, (f) => rows.push(f));
  p.push(text, true);
  const { headers } = cleanHeaders(rows[0]);
  const meta: FileMeta = {
    id, group, name, size: blob.size, delimiter: d, encoding: 'utf-8', headers, rawHeaders: rows[0],
    rows: rows.length - 1, status: 'ready', warnings: [],
  };
  return { meta, blob };
}

export const baseCfg = (over: Partial<MatchConfig> = {}): MatchConfig => ({
  keyColumns: {},
  normalize: { trim: true, collapseSpaces: false, ignoreCase: false, stripLeadingZeros: false },
  operation: 'common',
  dupA: 'first',
  dupB: 'first',
  dateColumns: {},
  dateOrder: 'DMY',
  bCombine: 'union',
  allowCartesian: false,
  filters: [],
  ...over,
});

export const exportOpts: ExportOptions = {
  format: 'csv', fileName: 'out', delimiter: ',', bom: false, formulaGuard: false, splitRows: 0, target: 'download',
};

export const hooks = (chunkBytes = 64) => ({
  progress: () => {},
  cancelled: () => false,
  chunkBytes,
});

export async function runEngine(files: EngineFile[], cfg: MatchConfig, out: OutputConfig, chunk = 64) {
  const e = new MatchEngine(files, cfg, out, hooks(chunk));
  const stats = await e.analyze();
  const f = memoryFactory();
  const res = await e.export(f, exportOpts);
  const text = await f.blobs!.get('out.csv')!.text();
  const rows: string[][] = [];
  const p = new CsvStreamParser(',', (r) => rows.push(r));
  p.push(text, true);
  return { stats, res, rows: rows.slice(1), header: rows[0], engine: e };
}

/** Straightforward reference: everything in memory, nested logic, no indexes. */
export function reference(files: EngineFile[], texts: Map<string, string>, cfg: MatchConfig, out: OutputConfig): string[][] {
  type R = { f: string[]; file: EngineFile; fi: number; rec: number; key: string; date: number };
  const load = (g: Group) => {
    const res: R[] = [];
    files.filter((x) => x.meta.group === g).forEach((file, fi) => {
      const rows: string[][] = [];
      const p = new CsvStreamParser(file.meta.delimiter, (r) => rows.push(r));
      p.push(texts.get(file.meta.id)!, true);
      const kb = makeKeyBuilder(cfg.normalize, cfg.keyColumns[file.meta.id].map((c) => file.meta.headers.indexOf(c)));
      const di = cfg.dateColumns[file.meta.id] ? file.meta.headers.indexOf(cfg.dateColumns[file.meta.id]) : -1;
      const rules = cfg.filters.filter((x) => x.group === g);
      const norm = (v: string) => upperSimple(v.replace(/^[ \t\r\n\f\v\u00a0]+|[ \t\r\n\f\v\u00a0]+$/g, ''));
      const ok = (f: string[]) =>
        rules.every((x) => {
          const i = file.meta.headers.indexOf(x.column);
          const v = norm(i < 0 ? '' : f[i] ?? '');
          const val = norm(x.value);
          return x.op === 'equals' ? v === val : x.op === 'not_equals' ? v !== val : x.op === 'contains' ? v.includes(val)
            : x.op === 'starts_with' ? v.startsWith(val) : x.op === 'blank' ? v === '' : v !== '';
        });
      rows.slice(1).forEach((f, i) => {
        if (!ok(f)) return;
        const t = di >= 0 ? parseDate(f[di] ?? '', cfg.dateOrder) : NaN;
        res.push({ f, file, fi, rec: i + 1, key: kb(f), date: Number.isNaN(t) ? -Infinity : t });
      });
    });
    return res;
  };
  const A = load('A');
  const B = load('B');
  const select = (rows: R[], pol: string): R[] => {
    if (pol === 'all') return rows;
    const groups = new Map<string, R[]>();
    for (const r of rows) {
      if (!r.key) continue;
      if (!groups.has(r.key)) groups.set(r.key, []);
      groups.get(r.key)!.push(r);
    }
    const keep = new Set<R>();
    for (const g of groups.values()) {
      if (pol === 'first' || pol === 'unique') keep.add(g[0]);
      else if (pol === 'last') keep.add(g[g.length - 1]);
      else {
        let best = g[0];
        for (const r of g) if (r.date > best.date) best = r;
        keep.add(best);
      }
    }
    return rows.filter((r) => !r.key || keep.has(r));
  };
  const mv = out.missingValue;
  const get = (r: R, col: any) => {
    const i = r.file.meta.headers.indexOf(col.perFile?.[r.file.meta.id] ?? col.column);
    return i < 0 ? undefined : r.f[i] ?? '';
  };
  const Bfiles = files.filter((x) => x.meta.group === 'B');
  const row = (a: R | null, bs: (R | null)[], key: string, status: string, ca: string, cb: string) =>
    out.columns.map((c) => {
      if (c.kind === 'field') {
        if (c.group === 'A') return a ? get(a, c) ?? mv : mv;
        for (const b of bs) {
          if (!b) continue;
          if (cfg.bCombine === 'join' && c.fromFile && c.fromFile !== b.file.meta.id) continue;
          const v = get(b, c);
          if (v !== undefined) return v;
        }
        return mv;
      }
      switch (c.meta) {
        case 'match_key': return key ? displayKey(key) : '';
        case 'match_status': return status;
        case 'source_file_a': return a?.file.meta.name ?? '';
        case 'source_file_b': return bs.filter(Boolean).map((b) => b!.file.meta.name).join('; ');
        case 'count_a': return ca;
        case 'count_b': return cb;
        case 'row_number_a': return a ? String(a.rec) : '';
        case 'row_number_b': return bs.filter(Boolean).map((b) => String(b!.rec)).join('; ');
      }
      return '';
    });
  const result: string[][] = [];
  const aKeys = new Map<string, number>();
  for (const a of A) if (a.key) aKeys.set(a.key, (aKeys.get(a.key) ?? 0) + 1);
  if (cfg.operation === 'b_not_a') {
    const only = B.filter((b) => !b.key || !aKeys.has(b.key));
    const cnt = new Map<string, number>();
    for (const b of only) if (b.key) cnt.set(b.key, (cnt.get(b.key) ?? 0) + 1);
    for (const b of select(only, cfg.dupB))
      result.push(row(null, [b], b.key, b.key ? 'NOT IN GROUP A' : 'BLANK KEY', '0', b.key ? String(cnt.get(b.key)) : ''));
    return result;
  }
  const bCnt = new Map<string, number>();
  for (const b of B) if (b.key) bCnt.set(b.key, (bCnt.get(b.key) ?? 0) + 1);
  for (const a of select(A, cfg.dupA)) {
    if (!a.key) {
      if (cfg.operation !== 'common') result.push(row(a, [], '', 'BLANK KEY', '', '0'));
      continue;
    }
    const ca = String(aKeys.get(a.key));
    const matches = B.filter((b) => b.key === a.key);
    if (!matches.length) {
      if (cfg.operation !== 'common') result.push(row(a, [], a.key, 'NOT FOUND', ca, '0'));
      continue;
    }
    if (cfg.operation === 'a_not_b') continue;
    const cb = String(bCnt.get(a.key));
    if (cfg.bCombine === 'union') {
      for (const b of select(matches, cfg.dupB)) result.push(row(a, [b], a.key, 'MATCHED', ca, cb));
    } else {
      const per = Bfiles.map((_, j) => select(matches.filter((b) => b.fi === j), cfg.dupB)[0] ?? null);
      result.push(row(a, per, a.key, 'MATCHED', ca, cb));
    }
  }
  return result;
}
