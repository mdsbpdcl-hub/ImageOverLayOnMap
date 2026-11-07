/// <reference lib="webworker" />
// Mode A worker: file inspection, row counting, analysis, preview and export.
// All parsing and matching happens here, off the UI thread.

import { CancelledError, cleanHeaders, countRecords, inspectHeader, transcodeToUtf8 } from '../engine/csv';
import { MatchEngine, type EngineFile } from '../engine/core';
import { directoryFactory, fileHandleFactory, memoryFactory, opfsAvailable, opfsFactory, OPFS_CONVERTED, type SinkFactory } from '../engine/sink';
import { convertSheetToCsv, readWorkbook, XlsxError } from '../engine/xlsx';
import type { ExportOptions, FileMeta, MatchConfig, OutputConfig } from '../engine/types';

declare const self: DedicatedWorkerGlobalScope;

let engine: MatchEngine | null = null;
let cancelled = false;

export class MemoryLimitError extends Error {}

function heap(): { used: number; limit: number } | null {
  const m = (performance as any).memory;
  return m && m.jsHeapSizeLimit ? { used: m.usedJSHeapSize, limit: m.jsHeapSizeLimit } : null;
}
let peak = 0;
function memoryCheck() {
  const h = heap();
  if (!h) return;
  if (h.used > peak) peak = h.used;
  if (h.used > h.limit * 0.88)
    throw new MemoryLimitError(
      `Browser memory is nearly exhausted (${Math.round(h.used / 1048576)} MB of ${Math.round(h.limit / 1048576)} MB). ` +
        'Reduce the selected output columns, use "keep first" instead of "keep all", process fewer Group A files at a time, or use the offline Python tool.',
    );
}

function post(msg: any, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer);
}

function classify(e: unknown): { kind: string; message: string } {
  if (e instanceof CancelledError) return { kind: 'cancelled', message: 'Processing was cancelled.' };
  if (e instanceof MemoryLimitError) return { kind: 'memory', message: e.message };
  const msg = e instanceof Error ? e.message : String(e);
  if (/Map maximum size|Invalid array length|out of memory|Array buffer allocation failed|Invalid string length/i.test(msg))
    return {
      kind: 'memory',
      message: `The browser ran out of memory (${msg}). Reduce output columns or duplicates kept, split Group A, or use the offline Python tool.`,
    };
  if (/NotReadableError|could not be read/i.test(msg))
    return { kind: 'file', message: 'A file could not be read. It may have been moved, changed or deleted after it was added. Remove and add it again.' };
  if (e instanceof XlsxError) return { kind: 'file', message: msg };
  if (/QuotaExceeded|storage is full/i.test(msg))
    return { kind: 'storage', message: 'Browser storage is full. Choose "Save As" / folder output, free disk space, or clear temporary data.' };
  return { kind: 'error', message: msg };
}

async function sinkFor(opts: ExportOptions, handle: any): Promise<SinkFactory> {
  if (handle && handle.kind === 'directory') return directoryFactory(handle);
  if (handle && handle.kind === 'file') return fileHandleFactory(handle);
  if (await opfsAvailable()) return opfsFactory();
  return memoryFactory();
}

/** A temporary, disk-backed output file in the browser's private storage (memory fallback). */
async function tempOutput(name: string) {
  let pos = 0;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(OPFS_CONVERTED, { create: true });
    const fh = await dir.getFileHandle(name, { create: true });
    let ah: any = await (fh as any).createSyncAccessHandle();
    ah.truncate(0);
    return {
      write: async (b: Uint8Array) => {
        let off = 0;
        while (off < b.length) {
          const n = ah.write(off ? b.subarray(off) : b, { at: pos });
          if (n <= 0) throw new Error('Browser storage is full');
          pos += n;
          off += n;
        }
      },
      finish: async (): Promise<File> => {
        ah.flush();
        ah.close();
        ah = null;
        return fh.getFile(); // disk-backed File, not held in memory
      },
      abort: () => {
        try { ah?.close(); } catch { /* ignore */ }
      },
    };
  } catch {
    const parts: Uint8Array[] = [];
    return {
      write: async (b: Uint8Array) => void parts.push(b),
      finish: async () => new File(parts as BlobPart[], name, { type: 'text/csv' }),
      abort: () => {},
    };
  }
}

self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data;
  const t0 = Date.now();
  try {
    switch (m.type) {
      case 'inspect': {
        const file: File = m.file;
        const h = await inspectHeader(file);
        const { headers, warnings } = cleanHeaders(h.rawHeaders);
        if (!h.rawHeaders.length || (h.rawHeaders.length === 1 && !h.rawHeaders[0])) warnings.push('No heading row found.');
        if (headers.length === 1) warnings.push('Only one column detected: check the delimiter.');
        post({ type: 'inspected', reqId: m.reqId, encoding: h.encoding, delimiter: h.delimiter, rawHeaders: h.rawHeaders, headers, warnings, sample: h.sampleRows });
        break;
      }
      case 'sheets': {
        const wb = await readWorkbook(m.file);
        post({ type: 'sheets', reqId: m.reqId, sheets: wb.sheets });
        break;
      }
      case 'convert': {
        cancelled = false;
        const { write, finish, abort } = await tempOutput(m.outName);
        let last = 0;
        try {
          const res = await convertSheetToCsv(m.file, m.sheetPath, write, {
            isCancelled: () => cancelled,
            onProgress: (stage, done, total) => {
              const now = Date.now();
              if (now - last > 150 || done === total) {
                last = now;
                post({ type: 'convertProgress', reqId: m.reqId, stage, done, total });
              }
            },
          });
          const file = await finish();
          post({ type: 'converted', reqId: m.reqId, file, ...res, ms: Date.now() - t0 });
        } catch (e) {
          abort();
          throw e;
        }
        break;
      }
      case 'transcode': {
        cancelled = false;
        const { write, finish, abort } = await tempOutput(m.outName);
        let last = 0;
        try {
          await transcodeToUtf8(m.file, m.encoding, write, {
            normalizeNewlines: true,
            isCancelled: () => cancelled,
            onProgress: (done, total) => {
              const now = Date.now();
              if (now - last > 150 || done === total) {
                last = now;
                post({ type: 'convertProgress', reqId: m.reqId, stage: 'Converting to UTF-8', done, total });
              }
            },
          });
          post({ type: 'transcoded', reqId: m.reqId, file: await finish() });
        } catch (e) {
          abort();
          throw e;
        }
        break;
      }
      case 'count': {
        cancelled = false;
        const meta: FileMeta = m.meta;
        const le = { cr: 0, lf: 0, crlf: 0 };
        const rows = await countRecords(m.file, meta.encoding, meta.delimiter, 8 << 20, (done, total) => {
          post({ type: 'countProgress', reqId: m.reqId, done, total });
        }, undefined, le);
        post({ type: 'counted', reqId: m.reqId, rows, mixedNewlines: le.cr > 0 && le.lf + le.crlf > 0, ms: Date.now() - t0 });
        break;
      }
      case 'analyze': {
        cancelled = false;
        peak = 0;
        const files: EngineFile[] = m.files.map((f: { meta: FileMeta; file: File }) => ({ meta: f.meta, blob: f.file }));
        const cfg: MatchConfig = m.cfg;
        const out: OutputConfig = m.out;
        let last = 0;
        engine = new MatchEngine(files, cfg, out, {
          chunkBytes: m.chunkBytes,
          cancelled: () => cancelled,
          memoryCheck,
          heapMB: () => (peak ? Math.round(peak / 1048576) : undefined),
          progress: (p) => {
            const now = Date.now();
            if (now - last > 120 || p.bytesDone === p.bytesTotal) {
              last = now;
              post({ type: 'progress', progress: p });
            }
          },
        });
        const stats = await engine.analyze();
        post({ type: 'analyzed', stats, issues: engine.totalIssues });
        break;
      }
      case 'preview': {
        if (!engine) throw new Error('Run the analysis first.');
        const rows = await engine.preview(m.limit);
        post({ type: 'preview', reqId: m.reqId, header: engine.header(), rows });
        break;
      }
      case 'export': {
        if (!engine) throw new Error('Run the analysis first.');
        cancelled = false;
        const opts: ExportOptions = m.opts;
        const factory = await sinkFor(opts, m.handle);
        const res =
          m.report === 'duplicates'
            ? await engine.duplicateReport(factory, opts)
            : m.report === 'issues'
              ? await engine.issueReport(factory, opts)
              : await engine.export(factory, opts);
        const blobs: Record<string, Blob> = {};
        if (factory.blobs) for (const [k, v] of factory.blobs) blobs[k] = v;
        post({ type: 'exported', reqId: m.reqId, result: res, sink: factory.kind, blobs });
        break;
      }
      case 'cancel':
        cancelled = true;
        break;
      case 'reset':
        engine = null;
        post({ type: 'reset', reqId: m.reqId });
        break;
    }
  } catch (e) {
    const c = classify(e);
    post({ type: 'error', reqId: m.reqId, ...c });
  }
};
