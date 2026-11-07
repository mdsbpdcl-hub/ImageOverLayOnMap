// Promise-based wrapper around the Mode A worker. Cancel first asks the worker to
// stop at the next chunk; if it does not answer quickly the worker is terminated.

import type { AnalysisStats, ExportOptions, ExportResult, FileMeta, MatchConfig, OutputConfig, Progress } from '../engine/types';

export class EngineError extends Error {
  constructor(public kind: string, message: string) {
    super(message);
  }
}

type Pending = { resolve: (v: any) => void; reject: (e: any) => void; onProgress?: (d: any) => void };

function newWorker() {
  return new Worker(new URL('../workers/engine.worker.ts', import.meta.url), { type: 'module' });
}

export class EngineClient {
  private w: Worker;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private analyzeP: Pending | null = null;
  onProgress: (p: Progress) => void = () => {};

  constructor() {
    this.w = this.spawn();
  }

  private spawn() {
    const w = newWorker();
    w.onmessage = (ev) => this.handle(ev.data);
    w.onerror = (ev) => {
      const err = new EngineError('crash', `The processing worker stopped unexpectedly (${ev.message || 'possibly out of memory'}). Reduce the workload or try the SQL engine/offline tool.`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.analyzeP?.reject(err);
      this.analyzeP = null;
    };
    return w;
  }

  private handle(m: any) {
    if (m.type === 'progress') return this.onProgress(m.progress);
    if (m.type === 'analyzed') {
      this.analyzeP?.resolve(m);
      this.analyzeP = null;
      return;
    }
    if (m.type === 'error' && m.reqId === undefined) {
      this.analyzeP?.reject(new EngineError(m.kind, m.message));
      this.analyzeP = null;
      return;
    }
    const p = this.pending.get(m.reqId);
    if (!p) return;
    if (m.type === 'countProgress' || m.type === 'convertProgress') return p.onProgress?.(m);
    this.pending.delete(m.reqId);
    if (m.type === 'error') p.reject(new EngineError(m.kind, m.message));
    else p.resolve(m);
  }

  private call<T = any>(msg: any, onProgress?: (d: any) => void): Promise<T> {
    const reqId = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject, onProgress });
      this.w.postMessage({ ...msg, reqId });
    });
  }

  inspect(file: File) {
    return this.call<{ encoding: FileMeta['encoding']; delimiter: string; rawHeaders: string[]; headers: string[]; warnings: string[]; sample: string[][] }>({ type: 'inspect', file });
  }

  sheets(file: File) {
    return this.call<{ sheets: { name: string; path: string; hidden: boolean }[] }>({ type: 'sheets', file });
  }

  convert(file: File, sheetPath: string, outName: string, onProgress: (stage: string, done: number, total: number) => void) {
    return this.call<{ file: File; rows: number; headers: string[]; numericColumns: string[]; warnings: string[]; ms: number }>(
      { type: 'convert', file, sheetPath, outName },
      (m) => onProgress(m.stage, m.done, m.total),
    );
  }

  transcode(file: File, encoding: FileMeta['encoding'], outName: string, onProgress: (done: number, total: number) => void) {
    return this.call<{ file: File }>({ type: 'transcode', file, encoding, outName }, (m) => onProgress(m.done, m.total));
  }

  count(file: File, meta: FileMeta, onProgress: (done: number, total: number) => void) {
    return this.call<{ rows: number; mixedNewlines: boolean; ms: number }>({ type: 'count', file, meta }, (m) => onProgress(m.done, m.total));
  }

  analyze(files: { meta: FileMeta; file: File }[], cfg: MatchConfig, out: OutputConfig, chunkBytes: number): Promise<{ stats: AnalysisStats; issues: number }> {
    return new Promise((resolve, reject) => {
      this.analyzeP = { resolve, reject };
      this.w.postMessage({ type: 'analyze', files, cfg, out, chunkBytes });
    });
  }

  preview(limit: number) {
    return this.call<{ header: string[]; rows: string[][] }>({ type: 'preview', limit });
  }

  export(opts: ExportOptions, handle: FileSystemHandle | null, report?: 'duplicates' | 'issues') {
    return this.call<{ result: ExportResult; sink: string; blobs: Record<string, Blob> }>({ type: 'export', opts, handle, report });
  }

  /** Stops the running job. Resolves once the worker is idle (or replaced). */
  async cancel(): Promise<void> {
    // remember which jobs were running, so a job started after this cancel is never affected
    const job = this.analyzeP;
    const reqs = new Set(this.pending.keys());
    this.w.postMessage({ type: 'cancel' });
    await new Promise((r) => setTimeout(r, 1500));
    const stillRunning = (job && this.analyzeP === job) || [...reqs].some((id) => this.pending.has(id));
    if (stillRunning) this.restart(new EngineError('cancelled', 'Processing was cancelled.'));
  }

  restart(reason?: EngineError) {
    this.w.terminate();
    const err = reason ?? new EngineError('cancelled', 'Processing was cancelled.');
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.analyzeP?.reject(err);
    this.analyzeP = null;
    this.w = this.spawn();
  }

  dispose() {
    this.w.terminate();
  }
}
