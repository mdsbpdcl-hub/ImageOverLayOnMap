// Browser capability checks, Save As / folder pickers and download of results.

import { OPFS_DIR, clearOpfs } from '../engine/sink';
import type { ExportOptions } from '../engine/types';

export const caps = {
  saveAs: typeof (window as any).showSaveFilePicker === 'function',
  folder: typeof (window as any).showDirectoryPicker === 'function',
  opfs: !!navigator.storage?.getDirectory,
  heap: !!(performance as any).memory,
  deviceMemoryGB: (navigator as any).deviceMemory as number | undefined,
};

export async function pickTarget(opts: ExportOptions): Promise<FileSystemHandle | null> {
  if (opts.target === 'file') {
    const ext = opts.format === 'xlsx' ? '.xlsx' : '.csv';
    return (window as any).showSaveFilePicker({
      suggestedName: (opts.fileName || 'matched_consumers').replace(/\.(csv|xlsx)$/i, '') + ext,
      types: [
        opts.format === 'xlsx'
          ? { description: 'Excel workbook', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } }
          : { description: 'CSV file', accept: { 'text/csv': ['.csv'] } },
      ],
    });
  }
  if (opts.target === 'directory') return (window as any).showDirectoryPicker({ mode: 'readwrite' });
  return null;
}

function triggerDownload(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Hands finished files to the browser's download manager. */
export async function deliver(sink: string, names: string[], blobs: Record<string, Blob> = {}) {
  for (const name of names) {
    if (sink === 'opfs') {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(OPFS_DIR);
      const f = await (await dir.getFileHandle(name)).getFile(); // disk-backed, not copied into memory
      triggerDownload(f, name);
    } else if (sink === 'memory' && blobs[name]) triggerDownload(blobs[name], name);
    await new Promise((r) => setTimeout(r, 400)); // browsers throttle rapid multiple downloads
  }
}

export function downloadText(text: string, name: string, type = 'text/csv') {
  triggerDownload(new Blob([text], { type }), name);
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const e = await navigator.storage.estimate();
    return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
  } catch {
    return null;
  }
}

export async function clearTemporary(which: 'exports' | 'converted' | 'all' = 'all') {
  if (caps.opfs) await clearOpfs(which);
}
