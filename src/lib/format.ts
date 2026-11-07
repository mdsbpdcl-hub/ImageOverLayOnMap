export const fmtNum = (n: number | undefined | null) =>
  n === undefined || n === null || n < 0 || Number.isNaN(n) ? '—' : Math.round(n).toLocaleString('en-IN');

export function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}

export function fmtMs(ms: number | undefined): string {
  if (ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}

/** Indian-style short form: 12.5 L, 1.2 Cr */
export function fmtLakh(n: number): string {
  if (n >= 1e7) return `${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `${(n / 1e5).toFixed(2)} L`;
  return fmtNum(n);
}

export const uid = () => Math.random().toString(36).slice(2, 10);

export const DELIMS: { v: string; label: string }[] = [
  { v: ',', label: 'Comma ,' },
  { v: ';', label: 'Semicolon ;' },
  { v: '\t', label: 'Tab' },
  { v: '|', label: 'Pipe |' },
];

/** File name used for an Excel sheet's CSV copy (Save as CSV and the offline job). */
export function csvNameFor(meta: { name: string; source?: { workbook: string; sheet: string } }): string {
  if (!meta.source) return meta.name;
  const base = meta.source.workbook.replace(/\.(xlsx|xlsm)$/i, '');
  return `${base}__${meta.source.sheet}`.replace(/[\\/:*?"<>|]/g, '_') + '.csv';
}

export const isExcel = (name: string) => /\.(xlsx|xlsm)$/i.test(name);
export const isOldExcel = (name: string) => /\.(xls|xlsb|ods)$/i.test(name);
