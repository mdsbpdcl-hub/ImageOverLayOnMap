import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { AnalysisStats, Encoding, ExportOptions, ExportResult, FileMeta, Group, MatchConfig, OutputConfig, Progress } from './engine/types';
import { validateConfig } from './engine/core';
import { EngineClient, EngineError } from './lib/engineClient';
import type { DuckEngine } from './lib/duckClient';
import { directoryFactory, fileHandleFactory, memoryFactory, opfsFactory, type SinkFactory } from './engine/sink';
import { caps, clearTemporary, deliver, downloadText, pickTarget } from './lib/files';
import { csvNameFor, fmtMs, isExcel, isOldExcel, uid } from './lib/format';
import { cleanHeaders } from './engine/csv';
import { removeConverted } from './engine/sink';
import Upload from './components/Upload';
import Matching from './components/Matching';
import Output from './components/Output';
import Process from './components/Process';
import Results from './components/Results';
import { Icon } from './components/ui';

export interface Entry {
  meta: FileMeta;
  file: File; // the file as selected by the user (CSV or Excel workbook)
  csv?: File; // Excel only: temporary CSV copy of the chosen worksheet (disk-backed)
  utf8?: { encoding: string; file: File }; // UTF-8 copy for the SQL engine (non-UTF-8 CSV files only)
  sheets?: { name: string; path: string; hidden: boolean }[];
  countPct?: number;
  convStage?: string;
}

export interface ExportRecord {
  label: string;
  result: ExportResult;
  sink: string;
  at: string;
}

const KEY_GUESS = /^(consumer|con|ca|account|acct|cust(omer)?)[\s_.-]*(id|no|num|number|code)?$|^(ca|consumer)[\s_.-]*(no|number|id)/i;

const defaultCfg: MatchConfig = {
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
};

const STEPS = [
  { l: 'Files', s: 'Group A and Group B', i: 'upload' },
  { l: 'Match', s: 'Keys and rules', i: 'link' },
  { l: 'Columns', s: 'Columns and headings', i: 'columns' },
  { l: 'Process', s: 'Analyse and check', i: 'play' },
  { l: 'Results', s: 'Preview and save', i: 'download' },
];

export default function App() {

  const [step, setStep] = useState(0);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [cfg, setCfg] = useState<MatchConfig>(defaultCfg);
  const [out, setOut] = useState<OutputConfig>({ columns: [], missingValue: '', warnOnMissing: true });
  const [mode, setMode] = useState<'A' | 'B'>('A');
  const [chunkMB, setChunkMB] = useState(8);
  const [busy, setBusy] = useState<null | 'analyze' | 'export' | 'preview'>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [stats, setStats] = useState<AnalysisStats | null>(null);
  const [issues, setIssues] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ header: string[]; rows: string[][] } | null>(null);
  const [exports, setExports] = useState<ExportRecord[]>([]);
  const [exportOpts, setExportOpts] = useState<ExportOptions>({
    format: 'csv', fileName: 'matched_consumers', delimiter: ',', bom: true, formulaGuard: true, splitRows: 0,
    target: caps.saveAs ? 'file' : 'download',
  });

  const inspector = useRef<EngineClient>();
  const engine = useRef<EngineClient>();
  const duck = useRef<DuckEngine>();
  if (!inspector.current) inspector.current = new EngineClient();
  if (!engine.current) engine.current = new EngineClient();

  const metas = useMemo(() => entries.map((e) => e.meta), [entries]);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const patchMeta = (id: string, p: Partial<FileMeta>, extra: Partial<Entry> = {}) =>
    setEntries((es) => es.map((e) => (e.meta.id === id ? { ...e, ...extra, meta: { ...e.meta, ...p } } : e)));

  // Analysis becomes stale whenever files or settings change.
  const sig = JSON.stringify([metas.map((m) => [m.id, m.delimiter, m.encoding, m.rows, m.size, m.headers.length, m.source?.sheetPath]), cfg, out, mode]);
  const lastSig = useRef(sig);
  useEffect(() => {
    if (sig !== lastSig.current) {
      lastSig.current = sig;
      setStats(null);
      setPreview(null);
    }
  }, [sig]);

  // auto-select an obvious key column (same as other files of the group, or a typical heading)
  function guessKey(id: string, group: Group, headers: string[]) {
    setCfg((c) => {
      if (c.keyColumns[id]?.some(Boolean)) return c;
      const sameGroup = entriesRef.current.filter((x) => x.meta.group === group && x.meta.id !== id && c.keyColumns[x.meta.id]?.[0]);
      const prev = sameGroup.map((x) => c.keyColumns[x.meta.id]).find((k) => k.every((col) => headers.includes(col)));
      const hit = headers.find((x) => KEY_GUESS.test(x.trim()));
      const guess = prev ?? (hit ? [hit] : null);
      return guess ? { ...c, keyColumns: { ...c.keyColumns, [id]: [...guess] } } : c;
    });
  }

  /** Converts the chosen worksheet of an Excel workbook into a temporary CSV copy. */
  async function convertEntry(e: Entry, sheet: { name: string; path: string }) {
    const id = e.meta.id;
    const source = { kind: 'xlsx' as const, workbook: e.file.name, sheet: sheet.name, sheetPath: sheet.path, origSize: e.file.size };
    patchMeta(id, { status: 'converting', name: `${e.file.name} › ${sheet.name}`, source, rows: undefined, error: undefined, headers: [], warnings: [] }, { countPct: 0, convStage: 'Opening workbook', csv: undefined });
    try {
      const r = await inspector.current!.convert(e.file, sheet.path, `${id}.csv`, (stage, done, total) =>
        patchMeta(id, {}, { convStage: stage, countPct: total ? (done / total) * 100 : undefined }),
      );
      const { headers, warnings } = cleanHeaders(r.headers);
      const w = [...warnings, ...r.warnings];
      if (r.rows === 0 && r.headers.length) w.push('No data rows (heading only).');
      patchMeta(
        id,
        { status: 'ready', size: r.file.size, delimiter: ',', encoding: 'utf-8', headers, rawHeaders: r.headers, rows: r.rows, numericColumns: r.numericColumns, warnings: w },
        { csv: r.file, countPct: undefined, convStage: undefined },
      );
      guessKey(id, e.meta.group, headers);
    } catch (err) {
      patchMeta(id, { status: 'error', error: (err as Error).message }, { countPct: undefined, convStage: undefined });
    }
  }

  async function addWorkbook(group: Group, file: File) {
    const id = uid();
    const base: Entry = {
      file,
      meta: { id, group, name: file.name, size: file.size, delimiter: ',', encoding: 'utf-8', headers: [], rawHeaders: [], status: 'converting', warnings: [] },
    };
    setEntries((es) => [...es, base]);
    try {
      const { sheets } = await inspector.current!.sheets(file);
      const first = sheets.find((s) => !s.hidden) ?? sheets[0];
      setEntries((es) => es.map((x) => (x.meta.id === id ? { ...x, sheets } : x)));
      await convertEntry({ ...base, sheets }, first);
    } catch (err) {
      patchMeta(id, { status: 'error', error: (err as Error).message });
    }
  }

  async function addOtherSheets(id: string) {
    const e = entriesRef.current.find((x) => x.meta.id === id);
    if (!e?.sheets) return;
    const used = new Set(entriesRef.current.filter((x) => x.file === e.file).map((x) => x.meta.source?.sheetPath));
    for (const sh of e.sheets.filter((s) => !s.hidden && !used.has(s.path))) {
      const ne: Entry = {
        file: e.file,
        sheets: e.sheets,
        meta: { id: uid(), group: e.meta.group, name: `${e.file.name} › ${sh.name}`, size: e.file.size, delimiter: ',', encoding: 'utf-8', headers: [], rawHeaders: [], status: 'converting', warnings: [] },
      };
      setEntries((es) => [...es, ne]);
      await convertEntry(ne, sh);
    }
  }

  function changeSheet(id: string, path: string) {
    const e = entriesRef.current.find((x) => x.meta.id === id);
    const sh = e?.sheets?.find((s) => s.path === path);
    if (!e || !sh) return;
    setCfg((c) => {
      const keyColumns = { ...c.keyColumns }; delete keyColumns[id];
      return { ...c, keyColumns };
    });
    convertEntry(e, sh);
  }

  async function inspectEntry(e: Entry, override?: { delimiter?: string; encoding?: Encoding }) {
    const id = e.meta.id;
    try {
      const h = await inspector.current!.inspect(e.file);
      const encoding = override?.encoding ?? h.encoding;
      let headers = h.headers, rawHeaders = h.rawHeaders, warnings = h.warnings, delimiter = override?.delimiter ?? h.delimiter;
      if (override) {
        // re-read the heading with the chosen delimiter/encoding
        const { inspectWith } = await import('./lib/inspect');
        const r = await inspectWith(e.file, delimiter, encoding);
        headers = r.headers; rawHeaders = r.rawHeaders; warnings = r.warnings;
      }
      if (e.file.size === 0) warnings = [...warnings, 'The file is empty.'];
      const meta: Partial<FileMeta> = { encoding, delimiter, headers, rawHeaders, warnings, status: 'counting', rows: undefined, error: undefined };
      patchMeta(id, meta, { countPct: 0 });
      guessKey(id, e.meta.group, headers);
      const res = await inspector.current!.count(e.file, { ...e.meta, ...meta } as FileMeta, (done, total) =>
        patchMeta(id, {}, { countPct: total ? (done / total) * 100 : 100 }),
      );
      patchMeta(id, { rows: res.rows, mixedNewlines: res.mixedNewlines, status: 'ready', warnings: res.rows === 0 ? [...warnings, 'No data rows (heading only).'] : warnings }, { countPct: undefined });
    } catch (err) {
      patchMeta(id, { status: 'error', error: (err as Error).message });
    }
  }

  function addFiles(group: Group, all: File[]) {
    const old = all.filter((f) => isOldExcel(f.name));
    if (old.length)
      setEntries((es) => [
        ...es,
        ...old.map((file) => ({
          file,
          meta: {
            id: uid(), group, name: file.name, size: file.size, delimiter: ',', encoding: 'utf-8' as const, headers: [], rawHeaders: [], status: 'error' as const, warnings: [],
            error: 'This older spreadsheet format (.xls / .xlsb / .ods) cannot be read. Open it in Excel and save it as .xlsx or CSV.',
          },
        })),
      ]);
    (async () => { for (const f of all.filter((x) => isExcel(x.name))) await addWorkbook(group, f); })();
    const files = all.filter((f) => !isExcel(f.name) && !isOldExcel(f.name));
    const fresh: Entry[] = files.map((file) => ({
      file,
      meta: { id: uid(), group, name: file.name, size: file.size, delimiter: ',', encoding: 'utf-8', headers: [], rawHeaders: [], status: 'reading', warnings: [] },
    }));
    const dupNames = fresh.filter((f) => entries.some((e) => e.meta.group === group && e.meta.name === f.meta.name && e.meta.size === f.meta.size));
    for (const d of dupNames) d.meta.warnings.push('A file with the same name and size is already added to this group.');
    setEntries((es) => [...es, ...fresh]);
    (async () => { for (const e of fresh) await inspectEntry(e); })();
  }

  function removeFile(id: string) {
    const e = entriesRef.current.find((x) => x.meta.id === id);
    if (e?.csv) removeConverted(`${id}.csv`);
    if (e?.utf8) removeConverted(`${id}.utf8.csv`);
    setEntries((es) => es.filter((e) => e.meta.id !== id));
    setCfg((c) => {
      const keyColumns = { ...c.keyColumns }; delete keyColumns[id];
      const dateColumns = { ...c.dateColumns }; delete dateColumns[id];
      return { ...c, keyColumns, dateColumns };
    });
  }

  function changeFile(id: string, patch: { delimiter?: string; encoding?: Encoding }) {
    const e = entries.find((x) => x.meta.id === id);
    if (!e) return;
    patchMeta(id, { ...patch, status: 'reading' });
    inspectEntry({ ...e, meta: { ...e.meta, ...patch } }, { delimiter: patch.delimiter ?? e.meta.delimiter, encoding: patch.encoding ?? e.meta.encoding });
  }

  const errors = useMemo(() => {
    if (!entries.length) return ['Add files to begin.'];
    const errs = validateConfig(metas, cfg, out);
    const busyFiles = metas.filter((m) => m.status === 'counting' || m.status === 'reading' || m.status === 'converting');
    if (busyFiles.length) errs.unshift(`Please wait: ${busyFiles.map((m) => m.name).join(', ')} ${busyFiles.length > 1 ? 'are' : 'is'} still being read.`);
    return errs;
  }, [metas, cfg, out, entries.length]);
  const filesReady =
    entries.length > 0 &&
    entries.every((e) => e.meta.status === 'ready' || e.meta.status === 'counting') &&
    entries.some((e) => e.meta.group === 'A') &&
    entries.some((e) => e.meta.group === 'B');

  async function analyze() {
    setError(null); setBusy('analyze'); setStats(null); setPreview(null);
    setProgress({ stage: 'Starting', rowsDone: 0, elapsedMs: 0 });
    let payload = entries.map((e) => ({ meta: e.meta, file: e.csv ?? e.file }));
    try {
      if (mode === 'B') {
        // DuckDB reads UTF-8 reliably; other encodings (and mixed line endings) are first copied to clean UTF-8 in the background.
        const t0 = Date.now();
        payload = [];
        for (const e of entriesRef.current) {
          // DuckDB also mis-reads records that end with a lone CR inside a CRLF/LF file
          if (e.csv || (e.meta.encoding === 'utf-8' && !e.meta.mixedNewlines)) {
            payload.push({ meta: e.meta, file: e.csv ?? e.file });
            continue;
          }
          let copy = e.utf8?.encoding === e.meta.encoding ? e.utf8.file : undefined;
          if (!copy) {
            const r = await inspector.current!.transcode(e.file, e.meta.encoding, `${e.meta.id}.utf8.csv`, (done, total) =>
              setProgress({ stage: 'Preparing for the SQL engine (converting to UTF-8)', file: e.meta.name, rowsDone: 0, bytesDone: done, bytesTotal: total, percent: (done / Math.max(1, total)) * 100, elapsedMs: Date.now() - t0 }),
            );
            copy = r.file;
            const enc = e.meta.encoding;
            setEntries((es) => es.map((x) => (x.meta.id === e.meta.id ? { ...x, utf8: { encoding: enc, file: copy! } } : x)));
          }
          payload.push({ meta: { ...e.meta, encoding: 'utf-8', size: copy.size }, file: copy });
        }
      }
      let s: AnalysisStats;
      if (mode === 'A') {
        engine.current!.onProgress = setProgress;
        const r = await engine.current!.analyze(payload, cfg, out, chunkMB << 20);
        s = r.stats; setIssues(r.issues);
      } else {
        if (!duck.current) duck.current = new (await import('./lib/duckClient')).DuckEngine();
        s = await duck.current.analyze(payload, cfg, out, setProgress);
        setIssues(0);
      }
      setStats(s);
      lastSig.current = sig;
      if (s.cartesianKeys > 0 && !cfg.allowCartesian) {
        // the result is blocked until multiplication is allowed, so there is nothing to preview
        setPreview({ header: out.columns.map((c) => c.label), rows: [] });
      } else {
        setBusy('preview');
        const pv = mode === 'A' ? await engine.current!.preview(500) : await duck.current!.preview(500);
        setPreview(pv);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null); setProgress(null);
    }
  }

  async function cancel() {
    if (mode === 'A' || busy === 'export') await engine.current!.cancel();
    if (mode === 'B') {
      await duck.current?.cancel();
      await inspector.current!.cancel(); // stops a UTF-8 preparation copy, if one is running
    }
  }

  async function doExport(report?: 'duplicates' | 'issues') {
    setError(null);
    const opts: ExportOptions = report
      ? { ...exportOpts, format: 'csv', fileName: `${exportOpts.fileName || 'matched_consumers'}_${report}`, target: 'download', splitRows: 0 }
      : exportOpts;
    let handle: FileSystemHandle | null = null;
    try {
      handle = await pickTarget(opts);
    } catch {
      return; // user closed the picker
    }
    setBusy('export');
    setProgress({ stage: 'Writing output', rowsDone: 0, rowsTotal: report ? undefined : stats?.expectedOutputRows, elapsedMs: 0 });
    const label = report === 'duplicates' ? 'Duplicate report' : report === 'issues' ? 'Data issue report' : 'Matched output';
    try {
      let result: ExportResult, sink: string, blobs: Record<string, Blob> = {};
      if (mode === 'A') {
        engine.current!.onProgress = setProgress;
        const r = await engine.current!.export(opts, handle, report);
        result = r.result; sink = r.sink; blobs = r.blobs;
      } else {
        let factory: SinkFactory;
        if (handle && (handle as any).kind === 'directory') factory = directoryFactory(handle as FileSystemDirectoryHandle);
        else if (handle) factory = fileHandleFactory(handle as FileSystemFileHandle);
        else factory = caps.opfs && typeof (FileSystemFileHandle.prototype as any).createWritable === 'function' ? opfsFactory() : memoryFactory();
        if (report === 'issues') throw new Error('The data-issue report is produced by the streaming engine (Mode A).');
        result = await duck.current!.export(factory, opts, setProgress, report);
        sink = factory.kind;
        if (factory.blobs) for (const [k, v] of factory.blobs) blobs[k] = v;
      }
      if (sink === 'opfs' || sink === 'memory') await deliver(sink, result.files.map((f) => f.name), blobs);
      setExports((x) => [{ label, result, sink, at: new Date().toLocaleTimeString('en-IN') }, ...x]);
    } catch (e) {
      setError(e instanceof EngineError || e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null); setProgress(null);
    }
  }

  function exportSummary() {
    if (!stats) return;
    const lines: [string, string][] = [
      ['Generated', new Date().toLocaleString('en-IN')],
      ['Engine', stats.engine === 'A' ? 'Streaming key index (Mode A)' : 'DuckDB SQL (Mode B)'],
      ['Operation', cfg.operation],
      ['Group A files', metas.filter((m) => m.group === 'A').map((m) => m.name).join('; ')],
      ['Group B files', metas.filter((m) => m.group === 'B').map((m) => m.name).join('; ')],
      ['Group A rows', String(stats.aRows)], ['Group B rows', String(stats.bRows)],
      ['Unique Group A keys', String(stats.aUniqueKeys)], ['Matched consumers (unique keys)', String(stats.matchedKeys)],
      ['Unmatched Group A keys', String(stats.unmatchedAKeys)],
      ['Group A duplicate keys', String(stats.aDuplicateKeys)], ['Group A extra duplicate rows', String(stats.aDuplicateRows)],
      ['Group B duplicate keys', String(stats.bDuplicateKeys)], ['Group B extra duplicate rows', String(stats.bDuplicateRows)],
      ['Group A blank keys', String(stats.aBlankKeys)], ['Group B blank keys', String(stats.bBlankKeys)],
      ['Rows excluded by filters (A / B)', `${stats.aFiltered} / ${stats.bFiltered}`],
      ['Malformed rows', stats.malformedRows < 0 ? 'not measured' : String(stats.malformedRows)],
      ['Result rows', String(stats.expectedOutputRows)], ['Analysis time', fmtMs(stats.analyzeMs)],
      ...exports.map((x) => [`Export: ${x.label}`, `${x.result.rows} rows in ${x.result.files.map((f) => f.name).join(', ')}`] as [string, string]),
    ];
    const csv = '﻿Item,Value\r\n' + lines.map(([k, v]) => `"${k.replace(/"/g, '""')}","${v.replace(/"/g, '""')}"`).join('\r\n') + '\r\n';
    downloadText(csv, `${exportOpts.fileName || 'matched_consumers'}_summary.csv`);
  }

  async function clearAll() {
    await cancel().catch(() => {});
    engine.current!.restart();
    await duck.current?.clear();
    await clearTemporary('all');
    // Excel sheets were converted into temporary copies that are now deleted: those files must be added again.
    setEntries((es) => es.map((e) => (e.utf8 ? { ...e, utf8: undefined } : e))); // UTF-8 copies were deleted too
    const excelIds = entriesRef.current.filter((e) => e.meta.source).map((e) => e.meta.id);
    if (excelIds.length) {
      setEntries((es) => es.filter((e) => !e.meta.source));
      setCfg((c) => {
        const keyColumns = { ...c.keyColumns };
        for (const id of excelIds) delete keyColumns[id];
        return { ...c, keyColumns };
      });
      setStep(0);
    }
    setStats(null); setPreview(null); setExports([]);
  }

  function saveConvertedCsv(id: string) {
    const e = entriesRef.current.find((x) => x.meta.id === id);
    if (!e?.csv) return;
    const url = URL.createObjectURL(e.csv);
    const a = document.createElement('a');
    a.href = url;
    a.download = csvNameFor(e.meta);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  // Test hook for the automated browser tests (only when the page is opened with ?e2e).
  useEffect(() => {
    if (new URLSearchParams(location.search).has('e2e'))
      (window as any).__cm = { cfg, out, metas, mode, stats, setCfg, setOut, setMode, setExportOpts, exportOpts };
  });


  const nextHint =
    step === 0 && !filesReady
      ? entries.some((e) => e.meta.group === 'A') && entries.some((e) => e.meta.group === 'B')
        ? 'Reading files…'
        : 'Add at least one file to each group'
      : step === 3 && !stats
        ? 'Run the analysis to continue'
        : '';

  const canGo = (i: number) =>
    i === 0 || (i === 1 && filesReady) || (i === 2 && filesReady) || (i === 3 && filesReady) || (i === 4 && !!stats);

  return (
    <>
      <header className="top">
        <div className="top-in">
          <div className="logo"><Icon name="bolt" size={16} /></div>
          <div className="title">Consumer CSV Matcher</div>
          <div className="spacer" />
          <span className="privacy"><Icon name="shield" size={15} /><span>Files stay on this computer</span></span>
        </div>
      </header>
      <main>
        <nav className="steps" aria-label="Steps">
          {STEPS.map((s, i) => (
            <Fragment key={s.l}>
              {i > 0 && <span className={`bar ${i <= step ? 'done' : ''}`} />}
              <button className={`step ${step === i ? 'on' : ''} ${i < step ? 'done' : ''}`} disabled={!canGo(i) || !!busy} onClick={() => setStep(i)} aria-current={step === i ? 'step' : undefined}>
                <span className="n">{i < step ? <Icon name="check" size={14} /> : i + 1}</span>
                <span className="l">{s.l}</span>
                <span className="s">{s.s}</span>
              </button>
            </Fragment>
          ))}
        </nav>

        {step === 0 && (
          <Upload entries={entries} onAdd={addFiles} onRemove={removeFile} onChange={changeFile}
            onSheet={changeSheet} onOtherSheets={addOtherSheets} onSaveCsv={saveConvertedCsv} />
        )}
        {step === 1 && <Matching entries={entries} cfg={cfg} setCfg={setCfg} out={out} setOut={setOut} />}
        {step === 2 && <Output files={metas} cfg={cfg} out={out} setOut={setOut} />}
        {step === 3 && (
          <Process
            files={metas} cfg={cfg} out={out} mode={mode} setMode={setMode} chunkMB={chunkMB} setChunkMB={setChunkMB}
            errors={errors} busy={busy} progress={progress} stats={stats} issues={issues} error={error}
            onAnalyze={analyze} onCancel={cancel} onNext={() => setStep(4)}
          />
        )}
        {step === 4 && stats && (
          <Results
            stats={stats} cfg={cfg} preview={preview} opts={exportOpts} setOpts={setExportOpts} busy={busy} progress={progress}
            error={error} exports={exports} issues={issues} mode={mode}
            onExport={() => doExport()} onReport={(r) => doExport(r)} onSummary={exportSummary} onCancel={cancel} onClear={clearAll}
          />
        )}

      </main>
      <div className="actions">
        <div className="actions-in">
          <button className="btn" disabled={step === 0 || !!busy} onClick={() => setStep(step - 1)}>← Back</button>
          <span className="hint">{nextHint}</span>
          {step < 3 && (
            <button className="btn primary" disabled={!canGo(step + 1) || !!busy} onClick={() => setStep(step + 1)}>
              Next: {STEPS[step + 1].l} →
            </button>
          )}
          {step === 3 && (
            <button className="btn primary" disabled={!stats || !!busy} onClick={() => setStep(4)}>Next: {STEPS[4].l} →</button>
          )}
        </div>
      </div>
    </>
  );
}
