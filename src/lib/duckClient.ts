// Mode B — DuckDB-Wasm engine. DuckDB runs in its own Web Worker (single-threaded
// MVP/EH builds, which work on GitHub Pages without cross-origin isolation).
// The library and .wasm files are bundled with the app and loaded only on demand.

import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import { buildPlan, statsFromRow, type SqlPlan } from '../engine/sql';
import { RowWriter, type SinkFactory } from '../engine/sink';
import type { AnalysisStats, ExportOptions, ExportResult, FileMeta, MatchConfig, OutputConfig, Progress } from '../engine/types';

let dbP: Promise<{ db: AsyncDuckDB; duck: typeof import('@duckdb/duckdb-wasm') }> | null = null;

async function load() {
  const duck = await import('@duckdb/duckdb-wasm');
  const [mvpWasm, mvpWorker, ehWasm, ehWorker] = await Promise.all([
    import('@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url'),
    import('@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url'),
    import('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url'),
    import('@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url'),
  ]);
  const bundle = await duck.selectBundle({
    mvp: { mainModule: mvpWasm.default, mainWorker: mvpWorker.default },
    eh: { mainModule: ehWasm.default, mainWorker: ehWorker.default },
  });
  const worker = new Worker(bundle.mainWorker!);
  const db = new duck.AsyncDuckDB(new duck.VoidLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  return { db, duck };
}

export class DuckEngine {
  private conn: AsyncDuckDBConnection | null = null;
  private plan: SqlPlan | null = null;
  private files: { meta: FileMeta; file: File }[] = [];
  stats: AnalysisStats | null = null;
  private cancelled = false;
  private allowCartesian = false;

  async analyze(
    files: { meta: FileMeta; file: File }[],
    cfg: MatchConfig,
    out: OutputConfig,
    onProgress: (p: Progress) => void,
  ): Promise<AnalysisStats> {
    const t0 = Date.now();
    this.cancelled = false;
    this.allowCartesian = cfg.allowCartesian;
    this.files = files;
    const prog = (stage: string, extra: Partial<Progress> = {}) =>
      onProgress({ stage, rowsDone: 0, elapsedMs: Date.now() - t0, ...extra });
    prog('Loading the SQL engine');
    if (!dbP) dbP = load();
    let db: AsyncDuckDB, duck: typeof import('@duckdb/duckdb-wasm');
    try {
      ({ db, duck } = await dbP);
    } catch (e) {
      dbP = null;
      throw new Error(`The SQL engine could not start in this browser (${(e as Error).message}). Use the streaming engine (Mode A).`);
    }
    if (this.conn) await this.conn.close();
    this.conn = await db.connect();
    // Never fetch extensions from the internet (the page's security policy also blocks it).
    await this.conn.query('SET autoinstall_known_extensions = false; SET autoload_known_extensions = false;').catch(() => {});
    const reg: Record<string, string> = {};
    for (const f of files) {
      reg[f.meta.id] = `f_${f.meta.id}.csv`;
      await db.dropFile(reg[f.meta.id]).catch(() => {});
      await db.registerFileHandle(reg[f.meta.id], f.file, duck.DuckDBDataProtocol.BROWSER_FILEREADER, true);
    }
    this.plan = buildPlan(files.map((f) => f.meta), reg, cfg, out);
    // Split table creation per file so the user sees which file is being loaded.
    const setup = this.plan.setup;
    const totalBytes = files.reduce((s, f) => s + f.file.size, 0);
    let doneBytes = 0;
    for (const stmt of setup) {
      if (this.cancelled) throw new Error('Processing was cancelled.');
      const tbl = /CREATE OR REPLACE TABLE (cm_a|cm_b) AS /.exec(stmt);
      if (tbl) {
        const group = tbl[1] === 'cm_a' ? 'A' : 'B';
        const gf = files.filter((f) => f.meta.group === group);
        // run file by file: first CREATE from file 0, then INSERT the rest
        const parts = splitUnion(stmt.slice(tbl[0].length));
        for (let i = 0; i < parts.length; i++) {
          if (this.cancelled) throw new Error('Processing was cancelled.');
          prog(`Loading Group ${group} into DuckDB`, {
            file: gf[i]?.meta.name,
            bytesDone: doneBytes,
            bytesTotal: totalBytes,
            percent: totalBytes ? (doneBytes / totalBytes) * 100 : undefined,
          });
          await this.conn.query(i === 0 ? `CREATE OR REPLACE TABLE ${tbl[1]} AS ${parts[i]}` : `INSERT INTO ${tbl[1]} ${parts[i]}`);
          doneBytes += gf[i]?.file.size ?? 0;
        }
      } else {
        prog('Building key index');
        await this.conn.query(stmt);
      }
    }
    prog('Computing statistics', { bytesDone: totalBytes, bytesTotal: totalBytes, percent: 100 });
    const s = (await this.conn.query(this.plan.statsSql[0])).toArray()[0].toJSON();
    const n = (await this.conn.query(this.plan.countSql)).toArray()[0].toJSON();
    this.stats = statsFromRow(s, n.n, files.map((f) => f.meta), cfg, out, Date.now() - t0);
    return this.stats;
  }

  private async *rows(sql: string): AsyncGenerator<string[][]> {
    const reader = await this.conn!.send(sql);
    for await (const batch of reader) {
      const cols = batch.schema.fields.map((_, i) => batch.getChildAt(i)!);
      const out: string[][] = new Array(batch.numRows);
      for (let r = 0; r < batch.numRows; r++) {
        const row = new Array(cols.length);
        for (let c = 0; c < cols.length; c++) {
          const v = cols[c].get(r);
          row[c] = v === null || v === undefined ? '' : String(v);
        }
        out[r] = row;
      }
      yield out;
    }
  }

  async preview(limit: number): Promise<{ header: string[]; rows: string[][] }> {
    const rows: string[][] = [];
    for await (const b of this.rows(`${this.plan!.exportSql} LIMIT ${limit}`)) rows.push(...b);
    return { header: this.plan!.header, rows };
  }

  async export(
    factory: SinkFactory,
    opts: ExportOptions,
    onProgress: (p: Progress) => void,
    report?: 'duplicates',
  ): Promise<ExportResult> {
    if (!this.plan || !this.stats) throw new Error('Run the analysis first.');
    if (!report && this.stats.cartesianKeys > 0 && !this.allowCartesian)
      throw new Error('Rows would multiply for keys repeated in both groups. Confirm one-to-many multiplication on the Matching step.');
    this.cancelled = false;
    const t0 = Date.now();
    const header = report ? ['Matching Key', 'Group', 'Rows In Group A', 'Rows In Group B'] : this.plan.header;
    const w = new RowWriter(factory, report ? { ...opts, splitRows: 0 } : opts, header);
    const total = report ? undefined : this.stats.expectedOutputRows;
    try {
      for await (const batch of this.rows(report ? this.plan.dupReportSql : this.plan.exportSql)) {
        if (this.cancelled) throw new Error('Processing was cancelled.');
        for (const r of batch) await w.write(r);
        onProgress({
          stage: report ? 'Writing duplicate report' : 'Writing output',
          rowsDone: w.rows,
          rowsTotal: total,
          percent: total ? (w.rows / total) * 100 : undefined,
          elapsedMs: Date.now() - t0,
        });
        await new Promise((r) => setTimeout(r, 0)); // keep the UI responsive
      }
      const files = await w.close();
      const warnings = [...w.warnings];
      if (!report && w.rows !== this.stats.expectedOutputRows)
        warnings.push(`Rows written (${w.rows}) differ from the analysed count (${this.stats.expectedOutputRows}).`);
      return { files, rows: w.rows, ms: Date.now() - t0, warnings };
    } catch (e) {
      await w.abort();
      throw e;
    }
  }

  async cancel() {
    this.cancelled = true;
    try {
      await this.conn?.cancelSent();
    } catch {
      /* ignore */
    }
  }

  /** Drops all tables and registered files (frees DuckDB memory). */
  async clear() {
    if (!dbP) return;
    const { db } = await dbP;
    try {
      if (this.conn) {
        await this.conn.query('DROP TABLE IF EXISTS cm_a; DROP TABLE IF EXISTS cm_b; DROP TABLE IF EXISTS cm_ac; DROP TABLE IF EXISTS cm_bc;');
        await this.conn.close();
      }
      for (const f of this.files) await db.dropFile(`f_${f.meta.id}.csv`).catch(() => {});
    } catch {
      /* ignore */
    }
    this.conn = null;
    this.plan = null;
    this.stats = null;
  }
}

function splitUnion(body: string): string[] {
  // body is "(SELECT ...) UNION ALL (SELECT ...)" with balanced parentheses
  const parts: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      if (c === "'") {
        if (body[i + 1] === "'") i++;
        else inStr = false;
      }
      continue;
    }
    if (c === "'") inStr = true;
    else if (c === '(') {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (c === ')') {
      depth--;
      if (depth === 0) parts.push(body.slice(start, i));
    }
  }
  return parts;
}

export function estimateDuckMB(files: FileMeta[], out: OutputConfig): number {
  // projected size: share of columns kept × file size × overhead factor
  let mb = 0;
  for (const f of files) {
    const kept = out.columns.filter((c) => c.kind === 'field' && c.group === f.group).length + 3;
    const share = Math.min(1, kept / Math.max(1, f.headers.length));
    mb += (f.size / 1048576) * share * 2.2;
  }
  return Math.round(mb);
}
