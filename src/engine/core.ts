// Mode A — key-index streaming engine.
//
// Pass 1  reads Group A and builds a compact index: normalised key -> slot, with
//         per-slot counters in typed arrays (no A row contents are kept).
// Pass 2  streams Group B; only rows whose key exists in the index are kept, and
//         only the projected output fields of those rows (joined into one string).
// Export  re-streams the driving group (A, or B for "B not in A") and writes the
//         output rows in original file order directly to the sink.
// Memory is therefore O(unique A keys + kept B rows × selected B fields), never
// O(total input size). No pairwise comparisons: every lookup is a hash probe.

import { parseBlob, CancelledError, CsvStreamParser } from './csv';
import { makeKeyBuilder, displayKey, parseDate, upperSimple } from './normalize';
import { RowWriter, type SinkFactory } from './sink';
import type {
  AnalysisStats, ExportOptions, ExportResult, FileMeta, FilterRule, IssueRow,
  MatchConfig, OutputColumn, OutputConfig, Progress,
} from './types';

export interface EngineFile {
  meta: FileMeta;
  blob: Blob;
}

export interface EngineHooks {
  progress(p: Progress): void;
  cancelled(): boolean;
  chunkBytes: number;
  /** throws when memory is close to exhausted */
  memoryCheck?(): void;
  heapMB?(): number | undefined;
}

const SEP = '\u0000';
const ABSENT = '\u0002';
const ISSUE_LIMIT = 20_000;
const WS_EDGE = /^[ \t\r\n\f\v ]+|[ \t\r\n\f\v ]+$/g;

/**
 * Returns a compact copy of a string. Fields produced by the parser are V8 "sliced"
 * strings that keep their whole multi-megabyte source chunk alive; concatenations are
 * "cons" trees of such slices. Retaining them would silently keep most of the input
 * file in memory. Slicing a fresh concatenation forces V8 to flatten it into a new,
 * independent buffer, so only the characters we actually need are retained.
 */
export function copyStr(s: string): string {
  return (' ' + s).slice(1);
}

class Grow {
  i32: Int32Array;
  constructor(n = 1024, fill = 0) {
    this.i32 = new Int32Array(n);
    if (fill) this.i32.fill(fill);
    this.fill = fill;
  }
  private fill: number;
  ensure(n: number) {
    if (n <= this.i32.length) return;
    let len = this.i32.length;
    while (len < n) len *= 2;
    const a = new Int32Array(len);
    if (this.fill) a.fill(this.fill);
    a.set(this.i32);
    this.i32 = a;
  }
}
class GrowF {
  f64: Float64Array;
  constructor(n = 1024) {
    this.f64 = new Float64Array(n).fill(-Infinity);
  }
  ensure(n: number) {
    if (n <= this.f64.length) return;
    let len = this.f64.length;
    while (len < n) len *= 2;
    const a = new Float64Array(len).fill(-Infinity);
    a.set(this.f64);
    this.f64 = a;
  }
}

type Pred = (f: string[]) => boolean;

function compileFilters(rules: FilterRule[], meta: FileMeta): Pred | null {
  const rs = rules.filter((r) => r.group === meta.group);
  if (!rs.length) return null;
  const tests = rs.map((r) => {
    const idx = meta.headers.indexOf(r.column);
    const val = upperSimple(r.value.replace(WS_EDGE, ''));
    const get = (f: string[]) => (idx < 0 ? '' : upperSimple((f[idx] ?? '').replace(WS_EDGE, '')));
    switch (r.op) {
      case 'equals': return (f: string[]) => get(f) === val;
      case 'not_equals': return (f: string[]) => get(f) !== val;
      case 'contains': return (f: string[]) => get(f).includes(val);
      case 'starts_with': return (f: string[]) => get(f).startsWith(val);
      case 'blank': return (f: string[]) => get(f) === '';
      case 'not_blank': return (f: string[]) => get(f) !== '';
    }
  });
  return (f) => {
    for (const t of tests) if (!t(f)) return false;
    return true;
  };
}

export function resolveIndex(meta: FileMeta, col: OutputColumn): number {
  const name = col.perFile?.[meta.id] ?? col.column ?? '';
  return meta.headers.indexOf(name);
}

export function validateConfig(files: FileMeta[], cfg: MatchConfig, out: OutputConfig): string[] {
  const errs: string[] = [];
  const A = files.filter((f) => f.group === 'A');
  const B = files.filter((f) => f.group === 'B');
  if (!A.length) errs.push('Add at least one Group A (target) file.');
  if (!B.length) errs.push('Add at least one Group B (master) file.');
  let parts = -1;
  for (const f of files) {
    if (f.status === 'error') {
      errs.push(`"${f.name}" could not be read — remove it or add it again.`);
      continue;
    }
    if (!f.headers.length) {
      errs.push(`"${f.name}" has no heading row (empty file) — remove it.`);
      continue;
    }
    const k = cfg.keyColumns[f.id] ?? [];
    if (!k.length || k.some((c) => !c)) errs.push(`Choose the matching column(s) for "${f.name}".`);
    else if (k.some((c) => !f.headers.includes(c))) errs.push(`A matching column for "${f.name}" is not in that file.`);
    if (parts === -1) parts = k.length;
    else if (k.length !== parts) errs.push('Every file must use the same number of matching columns.');
    if (((f.group === 'A' && cfg.dupA === 'newest') || (f.group === 'B' && cfg.dupB === 'newest')) && !cfg.dateColumns[f.id])
      errs.push(`Choose the date column for "${f.name}" (needed for "keep newest").`);
  }
  if (!out.columns.length) errs.push('Select at least one output column.');
  if (cfg.bCombine === 'join' && cfg.dupB === 'all')
    errs.push('"Keep all matching rows" is not available when joining Group B files side by side.');
  return errs;
}

export class MatchEngine {
  readonly A: EngineFile[];
  readonly B: EngineFile[];
  private keyMap = new Map<string, number>();
  private n = 0;
  private aCount = new Grow();
  private aSel = new Grow(1024, -1);
  private aBest = new GrowF();
  private bCount = new Grow();
  private bBest = new GrowF();
  private bStore = new Map<number, string | string[]>(); // union
  private bStoreF: Map<number, string>[] = []; // join, per B file
  private bBestF: Map<number, number>[] = [];
  private bCountF: Map<number, number>[] = [];
  // B keys absent from A (only for operation b_not_a)
  private bOnly = new Map<string, number>();
  private boN = 0;
  private boCount = new Grow();
  private boSel = new Grow(1024, -1);
  private boBest = new GrowF();

  private bCols: OutputColumn[];
  private aCols: OutputColumn[];
  issues: IssueRow[] = [];
  private issueCount = 0;
  stats!: AnalysisStats;
  analyzed = false;

  constructor(
    files: EngineFile[],
    private readonly cfg: MatchConfig,
    private readonly out: OutputConfig,
    private readonly hooks: EngineHooks,
  ) {
    this.A = files.filter((f) => f.meta.group === 'A');
    this.B = files.filter((f) => f.meta.group === 'B');
    this.aCols = out.columns.filter((c) => c.kind === 'field' && c.group === 'A');
    this.bCols = out.columns.filter((c) => c.kind === 'field' && c.group === 'B');
    for (let j = 0; j < this.B.length; j++) {
      this.bStoreF.push(new Map());
      this.bBestF.push(new Map());
      this.bCountF.push(new Map());
    }
  }

  private issue(file: string, record: number, issue: string, detail: string) {
    this.issueCount++;
    if (this.issues.length < ISSUE_LIMIT) this.issues.push({ file, record, issue, detail });
  }

  private keyIdx(f: EngineFile): number[] {
    return (this.cfg.keyColumns[f.meta.id] ?? []).map((c) => f.meta.headers.indexOf(c));
  }

  private dateIdx(f: EngineFile): number {
    const c = this.cfg.dateColumns[f.meta.id];
    return c ? f.meta.headers.indexOf(c) : -1;
  }

  /** Stream one group's files. cb receives fields, file index, record number, global row index. */
  private async scan(
    files: EngineFile[],
    stage: string,
    cb: (f: string[], fi: number, rec: number, g: number) => void,
  ) {
    const t0 = Date.now();
    const totalBytes = files.reduce((s, f) => s + f.blob.size, 0);
    const totalRows = files.every((f) => f.meta.rows !== undefined)
      ? files.reduce((s, f) => s + (f.meta.rows ?? 0), 0)
      : undefined;
    let doneBytes = 0;
    let g = 0;
    let rowsDone = 0;
    for (let fi = 0; fi < files.length; fi++) {
      const f = files[fi];
      let header = true;
      let rec = 0;
      const width = f.meta.headers.length;
      await parseBlob(
        f.blob,
        f.meta.delimiter,
        {
          encoding: f.meta.encoding,
          chunkBytes: this.hooks.chunkBytes,
          isCancelled: this.hooks.cancelled,
          onChunk: (done, total) => {
            this.hooks.memoryCheck?.();
            const bytesDone = doneBytes + done;
            this.hooks.progress({
              stage,
              file: f.meta.name,
              rowsDone,
              rowsTotal: totalRows,
              bytesDone,
              bytesTotal: totalBytes,
              percent: totalBytes ? (bytesDone / totalBytes) * 100 : undefined,
              elapsedMs: Date.now() - t0,
            });
            if (done === total) doneBytes += total;
          },
        },
        (fields) => {
          if (header) {
            header = false;
            return;
          }
          rec++;
          rowsDone++;
          if (fields.length !== width && !this.analyzed) {
            this.malformed++;
            this.issue(f.meta.name, rec, 'Column count mismatch', `expected ${width}, found ${fields.length}`);
          }
          cb(fields, fi, rec, g++);
        },
      );
      if (this.hooks.cancelled()) throw new CancelledError();
    }
  }

  private malformed = 0;
  private badDates = 0;

  private date(raw: string, file: string, rec: number): number {
    const t = parseDate(raw, this.cfg.dateOrder);
    if (Number.isNaN(t)) {
      if (!this.analyzed) {
        this.badDates++;
        if (raw.trim()) this.issue(file, rec, 'Unreadable date', raw.slice(0, 60));
      }
      return -Infinity;
    }
    return t;
  }

  private projectB(fields: string[], fileIdx: number, rec: number, idx: number[]): string {
    let s = '';
    for (let c = 0; c < idx.length; c++) {
      const i = idx[c];
      const v = i < 0 ? ABSENT : (fields[i] ?? '');
      s += (v.indexOf(SEP) >= 0 ? v.split(SEP).join('') : v) + SEP;
    }
    return copyStr(s + fileIdx + SEP + rec);
  }

  private bProjectionIdx(f: EngineFile, j: number): number[] {
    return this.bCols.map((c) => {
      if (this.cfg.bCombine === 'join' && c.fromFile && c.fromFile !== f.meta.id) return -1;
      void j;
      return resolveIndex(f.meta, c);
    });
  }

  async analyze(): Promise<AnalysisStats> {
    const t0 = Date.now();
    const cfg = this.cfg;
    let aRows = 0, aBlank = 0, aFiltered = 0;
    // ---------------- Pass 1: Group A index
    const aKeys = this.A.map((f) => makeKeyBuilder(cfg.normalize, this.keyIdx(f)));
    const aPred = this.A.map((f) => compileFilters(cfg.filters, f.meta));
    const aDate = this.A.map((f) => this.dateIdx(f));
    await this.scan(this.A, 'Indexing Group A', (f, fi, rec, g) => {
      aRows++;
      const pred = aPred[fi];
      if (pred && !pred(f)) {
        aFiltered++;
        return;
      }
      const key = aKeys[fi](f);
      if (!key) {
        aBlank++;
        return;
      }
      let id = this.keyMap.get(key);
      if (id === undefined) {
        id = this.n++;
        this.keyMap.set(copyStr(key), id);
        this.aCount.ensure(this.n);
        this.aSel.ensure(this.n);
        if (cfg.dupA === 'newest') this.aBest.ensure(this.n);
      }
      const c = ++this.aCount.i32[id];
      switch (cfg.dupA) {
        case 'first':
        case 'unique':
          if (c === 1) this.aSel.i32[id] = g;
          break;
        case 'last':
          this.aSel.i32[id] = g;
          break;
        case 'newest': {
          const d = this.date(f[aDate[fi]] ?? '', this.A[fi].meta.name, rec);
          if (c === 1 || d > this.aBest.f64[id]) {
            this.aBest.f64[id] = d;
            this.aSel.i32[id] = g;
          }
          break;
        }
      }
    });
    this.bCount.ensure(this.n);
    if (cfg.dupB === 'newest' && cfg.bCombine === 'union') this.bBest.ensure(this.n);

    // ---------------- Pass 2: Group B scan
    let bRows = 0, bBlank = 0, bFiltered = 0, bUnmatchedRows = 0;
    const bKeys = this.B.map((f) => makeKeyBuilder(cfg.normalize, this.keyIdx(f)));
    const bPred = this.B.map((f) => compileFilters(cfg.filters, f.meta));
    const bDate = this.B.map((f) => this.dateIdx(f));
    const bProj = this.B.map((f, j) => this.bProjectionIdx(f, j));
    const trackBOnly = cfg.operation === 'b_not_a';
    const union = cfg.bCombine === 'union';
    const policy = cfg.dupB;
    await this.scan(this.B, 'Scanning Group B', (f, j, rec, h) => {
      bRows++;
      const pred = bPred[j];
      if (pred && !pred(f)) {
        bFiltered++;
        return;
      }
      const key = bKeys[j](f);
      if (!key) {
        bBlank++;
        return;
      }
      const id = this.keyMap.get(key);
      if (id === undefined) {
        bUnmatchedRows++;
        if (!trackBOnly) return;
        let bo = this.bOnly.get(key);
        if (bo === undefined) {
          bo = this.boN++;
          this.bOnly.set(copyStr(key), bo);
          this.boCount.ensure(this.boN);
          this.boSel.ensure(this.boN);
          if (policy === 'newest') this.boBest.ensure(this.boN);
        }
        const c = ++this.boCount.i32[bo];
        if (policy === 'first' || policy === 'unique') {
          if (c === 1) this.boSel.i32[bo] = h;
        } else if (policy === 'last') this.boSel.i32[bo] = h;
        else if (policy === 'newest') {
          const d = this.date(f[bDate[j]] ?? '', this.B[j].meta.name, rec);
          if (c === 1 || d > this.boBest.f64[bo]) {
            this.boBest.f64[bo] = d;
            this.boSel.i32[bo] = h;
          }
        }
        return;
      }
      const c = ++this.bCount.i32[id];
      if (trackBOnly) return; // matched B rows are not output for b_not_a
      if (union) {
        switch (policy) {
          case 'first':
          case 'unique':
            if (c === 1) this.bStore.set(id, this.projectB(f, j, rec, bProj[j]));
            break;
          case 'last':
            this.bStore.set(id, this.projectB(f, j, rec, bProj[j]));
            break;
          case 'newest': {
            const d = this.date(f[bDate[j]] ?? '', this.B[j].meta.name, rec);
            if (c === 1 || d > this.bBest.f64[id]) {
              this.bBest.f64[id] = d;
              this.bStore.set(id, this.projectB(f, j, rec, bProj[j]));
            }
            break;
          }
          case 'all': {
            const p = this.projectB(f, j, rec, bProj[j]);
            const cur = this.bStore.get(id);
            if (cur === undefined) this.bStore.set(id, p);
            else if (typeof cur === 'string') this.bStore.set(id, [cur, p]);
            else cur.push(p);
            break;
          }
        }
      } else {
        const cf = (this.bCountF[j].get(id) ?? 0) + 1;
        this.bCountF[j].set(id, cf);
        const store = this.bStoreF[j];
        if (policy === 'first' || policy === 'unique') {
          if (cf === 1) store.set(id, this.projectB(f, j, rec, bProj[j]));
        } else if (policy === 'last') store.set(id, this.projectB(f, j, rec, bProj[j]));
        else if (policy === 'newest') {
          const d = this.date(f[bDate[j]] ?? '', this.B[j].meta.name, rec);
          const best = this.bBestF[j].get(id);
          if (cf === 1 || d > (best ?? -Infinity)) {
            this.bBestF[j].set(id, d);
            store.set(id, this.projectB(f, j, rec, bProj[j]));
          }
        }
      }
    });

    // ---------------- Statistics and expected output size
    const aC = this.aCount.i32, bC = this.bCount.i32;
    let matched = 0, aDupKeys = 0, aDupRows = 0, bDupKeys = 0, bDupRows = 0, cart = 0, expected = 0;
    for (let id = 0; id < this.n; id++) {
      const a = aC[id], b = bC[id];
      if (a > 1) { aDupKeys++; aDupRows += a - 1; }
      if (b > 1) { bDupKeys++; bDupRows += b - 1; }
      const aE = cfg.dupA === 'all' ? a : 1;
      const bK = b === 0 ? 0 : union && policy === 'all' ? b : 1;
      if (b > 0) {
        matched++;
        if (a > 1 && b > 1 && cfg.dupA === 'all' && union && policy === 'all') cart++;
        if (cfg.operation === 'common' || cfg.operation === 'a_with_status') expected += aE * bK;
      } else if (cfg.operation === 'a_not_b' || cfg.operation === 'a_with_status') expected += aE;
    }
    if (cfg.operation === 'a_not_b' || cfg.operation === 'a_with_status') expected += aBlank;
    if (trackBOnly) {
      for (let i = 0; i < this.boN; i++) {
        const c = this.boCount.i32[i];
        if (c > 1) { bDupKeys++; bDupRows += c - 1; }
        expected += policy === 'all' ? c : 1;
      }
      expected += bBlank;
    }

    const missing: string[] = [];
    for (const c of this.out.columns) {
      if (c.kind !== 'field') continue;
      const files = c.group === 'A' ? this.A : this.B;
      for (const f of files) {
        if (cfg.bCombine === 'join' && c.group === 'B' && c.fromFile && c.fromFile !== f.meta.id) continue;
        if (resolveIndex(f.meta, c) < 0)
          missing.push(`"${c.label}" is not present in ${f.meta.name}; "${this.out.missingValue || '(blank)'}" will be written for its rows.`);
      }
    }

    this.analyzed = true;
    this.stats = {
      engine: 'A',
      aRows, bRows,
      aUniqueKeys: this.n,
      bUniqueKeys: trackBOnly ? matched + this.boN : -1,
      matchedKeys: matched,
      unmatchedAKeys: this.n - matched,
      unmatchedBKeys: trackBOnly ? this.boN : -1,
      aDuplicateKeys: aDupKeys, aDuplicateRows: aDupRows,
      bDuplicateKeys: bDupKeys, bDuplicateRows: bDupRows,
      aBlankKeys: aBlank, bBlankKeys: bBlank,
      aFiltered, bFiltered,
      malformedRows: this.malformed,
      badDates: this.badDates,
      expectedOutputRows: expected,
      cartesianKeys: cart,
      missingFieldWarnings: missing,
      analyzeMs: Date.now() - t0,
      peakHeapMB: this.hooks.heapMB?.(),
    };
    void bUnmatchedRows;
    return this.stats;
  }

  header(): string[] {
    return this.out.columns.map((c) => c.label);
  }

  /** Builds the output row. bRows: union -> [parsed] or []; join -> per-file parsed|null. */
  private assemble(
    aFields: string[] | null,
    aFile: EngineFile | null,
    aRec: number,
    key: string,
    status: string,
    bParsed: (string[] | null)[],
    countA: string,
    countB: string,
  ): string[] {
    const mv = this.out.missingValue;
    const out: string[] = new Array(this.out.columns.length);
    let bi = 0;
    for (let c = 0; c < this.out.columns.length; c++) {
      const col = this.out.columns[c];
      if (col.kind === 'field') {
        if (col.group === 'A') {
          if (!aFields || !aFile) out[c] = mv;
          else {
            const i = this.aIdxCache.get(aFile.meta.id)![this.aCols.indexOf(col)];
            out[c] = i < 0 ? mv : (aFields[i] ?? '');
          }
        } else {
          const pos = bi++;
          let v: string | undefined;
          for (const p of bParsed) {
            if (!p) continue;
            const x = p[pos];
            if (x !== ABSENT) {
              v = x;
              break;
            }
          }
          out[c] = v === undefined ? mv : v;
        }
        continue;
      }
      switch (col.meta) {
        case 'match_key': out[c] = key ? displayKey(key) : ''; break;
        case 'match_status': out[c] = status; break;
        case 'source_file_a': out[c] = aFile?.meta.name ?? ''; break;
        case 'source_file_b': out[c] = bParsed.filter(Boolean).map((p) => this.B[+p![p!.length - 2]].meta.name).join('; '); break;
        case 'count_a': out[c] = countA; break;
        case 'count_b': out[c] = countB; break;
        case 'row_number_a': out[c] = aRec ? String(aRec) : ''; break;
        case 'row_number_b': out[c] = bParsed.filter(Boolean).map((p) => p![p!.length - 1]).join('; '); break;
        default: out[c] = '';
      }
    }
    return out;
  }

  private aIdxCache = new Map<string, number[]>();

  /**
   * Generates output rows in order. emit() may return false to stop early (preview).
   */
  async generate(emit: (row: string[]) => Promise<boolean | void> | boolean | void): Promise<number> {
    if (!this.analyzed) throw new Error('Run the analysis first');
    const cfg = this.cfg;
    const s = this.stats;
    if (s.cartesianKeys > 0 && !cfg.allowCartesian)
      throw new Error(
        `${s.cartesianKeys.toLocaleString('en-IN')} consumer key(s) repeat in both groups and "keep all" is selected on both sides; ` +
          'this multiplies rows. Confirm "Allow one-to-many multiplication" or choose another duplicate rule.',
      );
    let written = 0;
    const STOP = Symbol('stop');
    const push = async (r: string[]) => {
      written++;
      const res = await emit(r);
      if (res === false) {
        throw STOP;
      }
    };
    // async row callbacks: buffer rows per chunk, then flush (parse callbacks are sync)
    const queue: string[][] = [];
    const flush = async () => {
      for (const r of queue) await push(r);
      queue.length = 0;
    };
    try {
      if (cfg.operation === 'b_not_a') await this.generateBOnly(queue, flush);
      else await this.generateA(queue, flush);
      await flush();
    } catch (e) {
      if (e !== STOP) throw e;
    }
    return written;
  }

  private async generateA(queue: string[][], flush: () => Promise<void>) {
    const cfg = this.cfg;
    const union = cfg.bCombine === 'union';
    const aKeys = this.A.map((f) => makeKeyBuilder(cfg.normalize, this.keyIdx(f)));
    const aPred = this.A.map((f) => compileFilters(cfg.filters, f.meta));
    for (const f of this.A) this.aIdxCache.set(f.meta.id, this.aCols.map((c) => resolveIndex(f.meta, c)));
    const op = cfg.operation;
    const wantMatched = op === 'common' || op === 'a_with_status';
    const wantUnmatched = op === 'a_not_b' || op === 'a_with_status';
    const parse = (s: string) => s.split(SEP);
    await this.scanWithFlush(this.A, 'Writing output', flush, (f, fi, rec, g) => {
      if (aPred[fi] && !aPred[fi]!(f)) return;
      const key = aKeys[fi](f);
      const file = this.A[fi];
      if (!key) {
        if (wantUnmatched) queue.push(this.assemble(f, file, rec, '', 'BLANK KEY', [], '', '0'));
        return;
      }
      const id = this.keyMap.get(key)!;
      if (cfg.dupA !== 'all' && this.aSel.i32[id] !== g) return;
      const countA = String(this.aCount.i32[id]);
      const bc = this.bCount.i32[id];
      if (bc === 0) {
        if (wantUnmatched) queue.push(this.assemble(f, file, rec, key, 'NOT FOUND', [], countA, '0'));
        return;
      }
      if (!wantMatched) return;
      if (union) {
        const st = this.bStore.get(id);
        const list = st === undefined ? [] : typeof st === 'string' ? [st] : st;
        for (const p of list) queue.push(this.assemble(f, file, rec, key, 'MATCHED', [parse(p)], countA, String(bc)));
      } else {
        const per = this.bStoreF.map((m) => {
          const p = m.get(id);
          return p === undefined ? null : parse(p);
        });
        queue.push(this.assemble(f, file, rec, key, 'MATCHED', per, countA, String(bc)));
      }
    });
  }

  private async generateBOnly(queue: string[][], flush: () => Promise<void>) {
    const cfg = this.cfg;
    const bKeys = this.B.map((f) => makeKeyBuilder(cfg.normalize, this.keyIdx(f)));
    const bPred = this.B.map((f) => compileFilters(cfg.filters, f.meta));
    const bProj = this.B.map((f, j) => this.bProjectionIdx(f, j));
    await this.scanWithFlush(this.B, 'Writing output', flush, (f, j, rec, h) => {
      if (bPred[j] && !bPred[j]!(f)) return;
      const key = bKeys[j](f);
      const parsed = () => this.projectB(f, j, rec, bProj[j]).split(SEP);
      if (!key) {
        queue.push(this.assemble(null, null, 0, '', 'BLANK KEY', [parsed()], '0', ''));
        return;
      }
      if (this.keyMap.has(key)) return;
      const bo = this.bOnly.get(key)!;
      if (cfg.dupB !== 'all' && this.boSel.i32[bo] !== h) return;
      queue.push(this.assemble(null, null, 0, key, 'NOT IN GROUP A', [parsed()], '0', String(this.boCount.i32[bo])));
    });
  }

  /** scan() variant that drains the async output queue after every chunk. */
  private async scanWithFlush(
    files: EngineFile[],
    stage: string,
    flush: () => Promise<void>,
    cb: (f: string[], fi: number, rec: number, g: number) => void,
  ) {
    // Rows arrive synchronously per chunk; the queue is drained (awaiting the sink)
    // before the next chunk is read, which gives natural back-pressure.
    const hooks = this.hooks;
    const origProgress = hooks.progress;
    const t0 = Date.now();
    const totalBytes = files.reduce((s, f) => s + f.blob.size, 0);
    const totalRows = files.every((f) => f.meta.rows !== undefined) ? files.reduce((s, f) => s + (f.meta.rows ?? 0), 0) : undefined;
    let doneBytes = 0;
    let g = 0;
    let rowsDone = 0;
    for (let fi = 0; fi < files.length; fi++) {
      const f = files[fi];
      let header = true;
      let rec = 0;
      const parser = new CsvStreamParser(f.meta.delimiter, (fields) => {
        if (header) {
          header = false;
          return;
        }
        rec++;
        rowsDone++;
        cb(fields, fi, rec, g++);
      });
      const dec = new TextDecoder(f.meta.encoding);
      const total = f.blob.size;
      let off = 0;
      if (total === 0) parser.finish();
      while (off < total) {
        if (hooks.cancelled()) throw new CancelledError();
        const end = Math.min(total, off + hooks.chunkBytes);
        const buf = await f.blob.slice(off, end).arrayBuffer();
        off = end;
        const last = off >= total;
        parser.push(dec.decode(buf, { stream: !last }), false);
        if (last) parser.finish();
        await flush();
        hooks.memoryCheck?.();
        const bytesDone = doneBytes + off;
        origProgress({
          stage, file: f.meta.name, rowsDone, rowsTotal: totalRows, bytesDone, bytesTotal: totalBytes,
          percent: totalBytes ? (bytesDone / totalBytes) * 100 : undefined, elapsedMs: Date.now() - t0,
        });
      }
      doneBytes += total;
    }
  }

  async export(factory: SinkFactory, opts: ExportOptions): Promise<ExportResult> {
    const t0 = Date.now();
    const w = new RowWriter(factory, opts, this.header());
    try {
      await this.generate((r) => w.write(r));
      const files = await w.close();
      const warnings = [...w.warnings];
      if (w.rows !== this.stats.expectedOutputRows)
        warnings.push(
          `Rows written (${w.rows.toLocaleString('en-IN')}) differ from the analysed estimate (${this.stats.expectedOutputRows.toLocaleString('en-IN')}). The input files may have changed after analysis.`,
        );
      return { files, rows: w.rows, ms: Date.now() - t0, warnings };
    } catch (e) {
      await w.abort();
      throw e;
    }
  }

  async preview(limit: number): Promise<string[][]> {
    const rows: string[][] = [];
    await this.generate((r) => {
      rows.push(r);
      return rows.length < limit;
    });
    return rows;
  }

  /** Keys that repeat in either group, with their counts. */
  async duplicateReport(factory: SinkFactory, opts: ExportOptions): Promise<ExportResult> {
    const t0 = Date.now();
    const w = new RowWriter(factory, { ...opts, splitRows: 0 }, ['Matching Key', 'Group', 'Rows In Group A', 'Rows In Group B']);
    for (const [key, id] of this.keyMap) {
      const a = this.aCount.i32[id], b = this.bCount.i32[id];
      if (a > 1 || b > 1) await w.write([displayKey(key), b > 0 ? 'A and B' : 'A only', String(a), String(b)]);
    }
    for (const [key, bo] of this.bOnly) {
      const c = this.boCount.i32[bo];
      if (c > 1) await w.write([displayKey(key), 'B only', '0', String(c)]);
    }
    const files = await w.close();
    return { files, rows: w.rows, ms: Date.now() - t0, warnings: w.warnings };
  }

  async issueReport(factory: SinkFactory, opts: ExportOptions): Promise<ExportResult> {
    const t0 = Date.now();
    const w = new RowWriter(factory, { ...opts, splitRows: 0 }, ['File', 'Record Number', 'Issue', 'Detail']);
    for (const i of this.issues) await w.write([i.file, String(i.record), i.issue, i.detail]);
    const files = await w.close();
    const warnings = [...w.warnings];
    if (this.issueCount > this.issues.length)
      warnings.push(`Only the first ${this.issues.length.toLocaleString('en-IN')} of ${this.issueCount.toLocaleString('en-IN')} issues are listed.`);
    return { files, rows: w.rows, ms: Date.now() - t0, warnings };
  }

  get totalIssues() {
    return this.issueCount;
  }
}
