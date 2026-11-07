// Reusable matching templates. Only configuration (column names and options) is
// stored in localStorage — never any consumer data.

import type { FileMeta, MatchConfig, OutputConfig } from '../engine/types';

const KEY = 'csv-matcher-templates-v1';

interface FileRule {
  group: 'A' | 'B';
  fileName: string;
  key: string[];
  date?: string;
}

export interface Template {
  name: string;
  savedAt: string;
  files: FileRule[];
  cfg: Omit<MatchConfig, 'keyColumns' | 'dateColumns'>;
  out: OutputConfig; // perFile / fromFile keyed by file name
}

export function listTemplates(): Template[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]');
  } catch {
    return [];
  }
}

export function saveTemplate(name: string, files: FileMeta[], cfg: MatchConfig, out: OutputConfig) {
  const byId = new Map(files.map((f) => [f.id, f.name]));
  const t: Template = {
    name,
    savedAt: new Date().toISOString(),
    files: files.map((f) => ({ group: f.group, fileName: f.name, key: cfg.keyColumns[f.id] ?? [], date: cfg.dateColumns[f.id] })),
    cfg: (({ keyColumns: _k, dateColumns: _d, ...rest }) => rest)(cfg),
    out: {
      ...out,
      columns: out.columns.map((c) => ({
        ...c,
        perFile: c.perFile ? Object.fromEntries(Object.entries(c.perFile).map(([id, h]) => [byId.get(id) ?? id, h])) : undefined,
        fromFile: c.fromFile ? byId.get(c.fromFile) ?? c.fromFile : undefined,
      })),
    },
  };
  const all = listTemplates().filter((x) => x.name !== name);
  all.push(t);
  localStorage.setItem(KEY, JSON.stringify(all));
}

export function deleteTemplate(name: string) {
  localStorage.setItem(KEY, JSON.stringify(listTemplates().filter((x) => x.name !== name)));
}

/** Applies a template to the current files: by file name first, otherwise any rule whose columns exist. */
export function applyTemplate(t: Template, files: FileMeta[]): { cfg: MatchConfig; out: OutputConfig; unmatched: string[] } {
  const keyColumns: Record<string, string[]> = {};
  const dateColumns: Record<string, string> = {};
  const unmatched: string[] = [];
  const idByName = new Map(files.map((f) => [f.name, f.id]));
  for (const f of files) {
    const rules = t.files.filter((r) => r.group === f.group);
    const rule = rules.find((r) => r.fileName === f.name) ?? rules.find((r) => r.key.length && r.key.every((k) => f.headers.includes(k)));
    if (rule && rule.key.every((k) => f.headers.includes(k))) {
      keyColumns[f.id] = [...rule.key];
      if (rule.date && f.headers.includes(rule.date)) dateColumns[f.id] = rule.date;
    } else unmatched.push(f.name);
  }
  const out: OutputConfig = {
    ...t.out,
    columns: t.out.columns.map((c) => ({
      ...c,
      perFile: c.perFile
        ? Object.fromEntries(Object.entries(c.perFile).flatMap(([n, h]) => (idByName.has(n) ? [[idByName.get(n)!, h]] : [])))
        : undefined,
      fromFile: c.fromFile ? idByName.get(c.fromFile) : undefined,
    })),
  };
  return { cfg: { ...t.cfg, keyColumns, dateColumns }, out, unmatched };
}
