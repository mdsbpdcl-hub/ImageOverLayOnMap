// Output destinations. Rows are encoded in ~1 MB batches and written straight to
// disk (File System Access API / Origin Private File System) so a large result is
// never built as one big string in memory.

import { CsvEncoder, XlsxStreamWriter, XLSX_MAX_ROWS } from './writer';
import type { ExportOptions } from './types';

export interface ByteSink {
  write(b: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface SinkFactory {
  kind: 'file' | 'directory' | 'opfs' | 'memory' | 'node';
  open(name: string): Promise<ByteSink>;
  /** For memory sinks: collected blobs by name. */
  blobs?: Map<string, Blob>;
}

/* ---------- File System Access API (Save As / folder) ---------- */

async function writableSink(handle: FileSystemFileHandle): Promise<ByteSink> {
  const w = await (handle as any).createWritable();
  return {
    write: (b) => w.write(b),
    close: () => w.close(),
  };
}

export function fileHandleFactory(handle: FileSystemFileHandle): SinkFactory {
  let used = false;
  return {
    kind: 'file',
    async open() {
      if (used) throw new Error('Output splitting needs a folder: choose "Save to folder" or "Download".');
      used = true;
      return writableSink(handle);
    },
  };
}

export function directoryFactory(dir: FileSystemDirectoryHandle): SinkFactory {
  return {
    kind: 'directory',
    async open(name) {
      const h = await dir.getFileHandle(name, { create: true });
      return writableSink(h);
    },
  };
}

/* ---------- Origin Private File System (browser-local, disk backed) ---------- */

export const OPFS_DIR = 'csv-matcher-exports';

export async function opfsDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_DIR, { create: true });
}

export async function opfsAvailable(): Promise<boolean> {
  try {
    if (!navigator.storage?.getDirectory) return false;
    await opfsDir();
    return true;
  } catch {
    return false;
  }
}

export function opfsFactory(): SinkFactory {
  return {
    kind: 'opfs',
    async open(name) {
      const dir = await opfsDir();
      const h = await dir.getFileHandle(name, { create: true });
      // Fast synchronous handle exists only inside workers.
      if (typeof (h as any).createSyncAccessHandle === 'function' && typeof (globalThis as any).WorkerGlobalScope !== 'undefined') {
        const ah = await (h as any).createSyncAccessHandle();
        ah.truncate(0);
        let pos = 0;
        return {
          async write(b) {
            let off = 0;
            while (off < b.length) {
              const n = ah.write(off === 0 ? b : b.subarray(off), { at: pos });
              if (n <= 0) throw new Error('Browser storage is full');
              pos += n;
              off += n;
            }
          },
          async close() {
            ah.flush();
            ah.close();
          },
        };
      }
      return writableSink(h);
    },
  };
}

/** Temporary CSV copies of Excel worksheets. */
export const OPFS_CONVERTED = 'csv-matcher-converted';

export async function clearOpfs(which: 'exports' | 'converted' | 'all' = 'all'): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const dirs = which === 'all' ? [OPFS_DIR, OPFS_CONVERTED] : [which === 'exports' ? OPFS_DIR : OPFS_CONVERTED];
  for (const d of dirs) {
    try {
      await root.removeEntry(d, { recursive: true });
    } catch {
      /* nothing to clear */
    }
  }
}

export async function removeConverted(name: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(OPFS_CONVERTED);
    await dir.removeEntry(name);
  } catch {
    /* already gone */
  }
}

/* ---------- In-memory fallback (small results, tests) ---------- */

export function memoryFactory(): SinkFactory {
  const blobs = new Map<string, Blob>();
  return {
    kind: 'memory',
    blobs,
    async open(name) {
      const parts: Uint8Array[] = [];
      return {
        async write(b) {
          parts.push(b.slice());
        },
        async close() {
          blobs.set(name, new Blob(parts as BlobPart[]));
        },
      };
    },
  };
}

/* ---------- Row writer: formats, headers, splitting ---------- */

const BOM = new Uint8Array([0xef, 0xbb, 0xbf]);

export interface WrittenFile {
  name: string;
  rows: number;
  bytes: number;
}

export class RowWriter {
  files: WrittenFile[] = [];
  rows = 0;
  private part = 0;
  private partRows = 0;
  private sink: ByteSink | null = null;
  private xlsx: XlsxStreamWriter | null = null;
  private csv: CsvEncoder;
  private buf = '';
  private enc = new TextEncoder();
  private cur!: WrittenFile;
  private readonly limit: number;
  warnings: string[] = [];

  constructor(
    private readonly factory: SinkFactory,
    private readonly opts: ExportOptions,
    private readonly header: string[],
  ) {
    this.csv = new CsvEncoder(opts);
    const maxXlsx = XLSX_MAX_ROWS - 1;
    this.limit = opts.splitRows > 0 ? opts.splitRows : opts.format === 'xlsx' ? maxXlsx : Infinity;
    if (opts.format === 'xlsx' && this.limit > maxXlsx) this.limit = maxXlsx;
  }

  private partName(): string {
    const ext = this.opts.format === 'xlsx' ? 'xlsx' : 'csv';
    const base = this.opts.fileName.replace(/\.(csv|xlsx)$/i, '') || 'matched_consumers';
    return this.part === 1 && this.opts.splitRows <= 0 ? `${base}.${ext}` : `${base}_part${String(this.part).padStart(3, '0')}.${ext}`;
  }

  private async openPart() {
    this.part++;
    this.partRows = 0;
    if (this.part === 2 && this.opts.splitRows <= 0) {
      // only reachable for xlsx overflow: rename not possible, so warn
      this.warnings.push('Result exceeded the XLSX row limit and was continued in additional parts.');
    }
    const name = this.partName();
    this.cur = { name, rows: 0, bytes: 0 };
    this.files.push(this.cur);
    const sink = await this.factory.open(name);
    this.sink = {
      write: async (b) => {
        this.cur.bytes += b.length;
        await sink.write(b);
      },
      close: () => sink.close(),
    };
    if (this.opts.format === 'xlsx') {
      this.xlsx = new XlsxStreamWriter((b) => this.sink!.write(b), this.opts.formulaGuard);
      await this.xlsx.row(this.header, true);
    } else {
      if (this.opts.bom) await this.sink.write(BOM);
      this.buf = this.csv.line(this.header);
    }
  }

  private async flushCsv() {
    if (this.buf) {
      const b = this.enc.encode(this.buf);
      this.buf = '';
      await this.sink!.write(b);
    }
  }

  private async closePart() {
    if (!this.sink) return;
    if (this.xlsx) {
      await this.xlsx.close();
      if (this.xlsx.truncatedCells)
        this.warnings.push(`${this.xlsx.truncatedCells} cell(s) longer than 32,767 characters were shortened to fit Excel.`);
      this.xlsx = null;
    } else await this.flushCsv();
    await this.sink.close();
    this.sink = null;
  }

  async write(values: string[]): Promise<void> {
    if (!this.sink || this.partRows >= this.limit) {
      await this.closePart();
      await this.openPart();
    }
    this.partRows++;
    this.cur.rows++;
    this.rows++;
    if (this.xlsx) await this.xlsx.row(values);
    else {
      this.buf += this.csv.line(values);
      if (this.buf.length > 1 << 20) await this.flushCsv();
    }
  }

  async close(): Promise<WrittenFile[]> {
    if (!this.sink && this.files.length === 0) await this.openPart(); // header-only output
    await this.closePart();
    if (this.csv.guarded)
      this.warnings.push(
        `${this.csv.guarded.toLocaleString('en-IN')} value(s) starting with = + - @ were prefixed with ' so spreadsheets do not run them as formulas.`,
      );
    return this.files;
  }

  async abort(): Promise<void> {
    try {
      await this.closePart();
    } catch {
      /* ignore */
    }
  }
}
