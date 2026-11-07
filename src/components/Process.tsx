import { useEffect, useState } from 'react';
import type { AnalysisStats, FileMeta, MatchConfig, OutputConfig, Progress } from '../engine/types';
import { caps, downloadText, storageEstimate } from '../lib/files';
import { buildOfflineScript } from '../engine/sql';
import { csvNameFor, fmtBytes, fmtMs, fmtNum } from '../lib/format';
import { Icon, More, Note, PageHead, ProgressPanel, Stat } from './ui';

interface Props {
  files: FileMeta[];
  cfg: MatchConfig;
  out: OutputConfig;
  mode: 'A' | 'B';
  setMode: (m: 'A' | 'B') => void;
  chunkMB: number;
  setChunkMB: (n: number) => void;
  errors: string[];
  busy: string | null;
  progress: Progress | null;
  stats: AnalysisStats | null;
  issues: number;
  error: string | null;
  onAnalyze: () => void;
  onCancel: () => void;
  onNext: () => void;
}

const SQL_LIMIT_MB = 1200; // projected in-memory size above which Mode B is not recommended

function estimate(files: FileMeta[], cfg: MatchConfig, out: OutputConfig) {
  const A = files.filter((f) => f.group === 'A');
  const B = files.filter((f) => f.group === 'B');
  const rows = (fs: FileMeta[]) => fs.reduce((s, f) => s + (f.rows ?? Math.round(f.size / 80)), 0);
  const aRows = rows(A), bRows = rows(B);
  const avgRow = (fs: FileMeta[]) => (fs.reduce((s, f) => s + f.size, 0) / Math.max(1, rows(fs))) || 80;
  const bCols = out.columns.filter((c) => c.kind === 'field' && c.group === 'B').length;
  const bShare = Math.min(1, (bCols + 1) / Math.max(1, Math.max(...B.map((f) => f.headers.length), 1)));
  // Mode A: key map (~90 bytes + 2 bytes/char per unique key) + kept B projections
  const keyLen = 14;
  const keptB = cfg.operation === 'b_not_a' ? 0 : Math.min(aRows, bRows) * (cfg.dupB === 'all' ? 1.5 : 1);
  const modeA = aRows * (90 + keyLen * 2) + keptB * (avgRow(B) * bShare * 2 + 60) + (cfg.operation === 'b_not_a' ? bRows * (90 + keyLen * 2) : 0);
  // Mode B: projected tables for both groups held in DuckDB memory
  const aCols = out.columns.filter((c) => c.kind === 'field' && c.group === 'A').length;
  const aShare = Math.min(1, (aCols + 2) / Math.max(1, Math.max(...A.map((f) => f.headers.length), 1)));
  const modeB = aRows * (avgRow(A) * aShare + 40) * 1.6 + bRows * (avgRow(B) * Math.min(1, bShare + 0.1) + 40) * 1.6;
  return { aRows, bRows, modeA: modeA / 1048576, modeB: modeB / 1048576 };
}

export default function Process(p: Props) {
  const { files, cfg, out, mode, setMode, stats } = p;
  const est = estimate(files, cfg, out);
  const [store, setStore] = useState<{ usage: number; quota: number } | null>(null);
  useEffect(() => { storageEstimate().then(setStore); }, []);
  const ramGB = caps.deviceMemoryGB;
  const inputBytes = files.reduce((s, f) => s + f.size, 0);
  const running = p.busy === 'analyze' || p.busy === 'preview';
  const unmatched = cfg.operation === 'b_not_a' ? stats?.unmatchedBKeys : stats?.unmatchedAKeys;
  const blocked = !!stats && stats.cartesianKeys > 0 && !cfg.allowCartesian;
  const warnings: string[] = [];
  if (stats) {
    if (stats.malformedRows > 0) warnings.push(`${fmtNum(stats.malformedRows)} row(s) had a different number of cells than the heading; missing cells were treated as blank (see the data issue report).`);
    if (stats.badDates > 0) warnings.push(`${fmtNum(stats.badDates)} date(s) could not be read; those rows count as oldest for “keep newest”.`);
    warnings.push(...stats.missingFieldWarnings.slice(0, 5));
  }

  return (
    <>
      <PageHead title="Check and process" sub="Matches the files and counts everything first. Nothing is saved until you export." />
      <div className="stack">
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <h2>{stats && !running ? 'Done — results are ready' : running ? 'Processing…' : 'Ready to start'}</h2>
              <p className="lead" style={{ margin: 0 }}>{files.length} files · {fmtBytes(inputBytes)}</p>
            </div>
            <div className="row">
              {stats && !p.busy && <button className="btn" onClick={p.onNext}>Go to results →</button>}
              <button className={`btn ${stats ? '' : 'primary big'}`} disabled={p.errors.length > 0 || !!p.busy} onClick={p.onAnalyze}>
                <Icon name="play" size={15} /> {stats ? 'Run again' : 'Start analysis'}
              </button>
            </div>
          </div>
          {p.errors.length > 0 && !running && <Note kind="warn"><ul>{p.errors.map((e) => <li key={e}>{e}</li>)}</ul></Note>}
          {running && p.progress && <ProgressPanel p={p.progress} onCancel={p.onCancel} />}
          {p.busy === 'preview' && <Note kind="info">Building preview…</Note>}
          {p.error && <Note kind="err"><b>Could not finish.</b> {p.error}</Note>}

          {stats && !running && (
            <>
              <div className="summary" style={{ marginTop: 18 }}>
                <Stat label="Matched consumers" value={fmtNum(stats.matchedKeys)} hl />
                <Stat label={cfg.operation === 'b_not_a' ? 'In B, not in A' : 'Not found in B'} value={fmtNum(unmatched)} />
                <Stat label="Rows to export" value={fmtNum(stats.expectedOutputRows)} />
                <Stat label="Time taken" value={fmtMs(stats.analyzeMs)} />
              </div>
              {blocked && (
                <Note kind="err">
                  {fmtNum(stats.cartesianKeys)} consumer(s) repeat in both groups with “keep all” on both sides, so rows would multiply.
                  Allow it on the Matching step, or choose another duplicate rule.
                </Note>
              )}
              {warnings.length > 0 && <Note kind="warn"><ul>{warnings.map((w) => <li key={w}>{w}</li>)}</ul></Note>}
              <More title="All numbers">
                <div className="stat-grid">
                  <div className="stat"><div className="k">Group A rows</div><div className="v">{fmtNum(stats.aRows)}</div></div>
                  <div className="stat"><div className="k">Group B rows</div><div className="v">{fmtNum(stats.bRows)}</div></div>
                  <div className="stat"><div className="k">Unique Group A keys</div><div className="v">{fmtNum(stats.aUniqueKeys)}</div></div>
                  <div className="stat"><div className="k">Matched consumers (unique)</div><div className="v">{fmtNum(stats.matchedKeys)}</div></div>
                  <div className="stat"><div className="k">Duplicate keys A · extra rows</div><div className="v">{fmtNum(stats.aDuplicateKeys)} · {fmtNum(stats.aDuplicateRows)}</div></div>
                  <div className="stat"><div className="k">Duplicate keys B · extra rows</div><div className="v">{fmtNum(stats.bDuplicateKeys)} · {fmtNum(stats.bDuplicateRows)}</div></div>
                  <div className="stat"><div className="k">Blank keys A · B</div><div className="v">{fmtNum(stats.aBlankKeys)} · {fmtNum(stats.bBlankKeys)}</div></div>
                  <div className="stat"><div className="k">Left out by filters A · B</div><div className="v">{fmtNum(stats.aFiltered)} · {fmtNum(stats.bFiltered)}</div></div>
                  <div className="stat"><div className="k">Result rows to export</div><div className="v">{fmtNum(stats.expectedOutputRows)}</div></div>
                  <div className="stat"><div className="k">Analysis time</div><div className="v">{fmtMs(stats.analyzeMs)}</div></div>
                  {stats.peakHeapMB !== undefined && <div className="stat"><div className="k">Peak memory</div><div className="v">{fmtNum(stats.peakHeapMB)} MB</div></div>}
                </div>
                {stats.aBlankKeys + stats.bBlankKeys > 0 && (
                  <p className="small muted">Rows with a blank consumer number never match. {cfg.operation === 'common' ? 'They are not in a matched-consumers result.' : 'They appear in the result with status BLANK KEY.'}</p>
                )}
                {p.issues > 0 && <p className="small muted">{fmtNum(p.issues)} data issue(s) recorded — download the data issue report on the next step.</p>}
              </More>
            </>
          )}
        </div>

        <div className="card">
          <h2>Processing engine</h2>
          <div className="opts" style={{ marginTop: 12 }}>
            <label className={`opt ${mode === 'A' ? 'on' : ''}`}>
              <input type="radio" checked={mode === 'A'} onChange={() => setMode('A')} disabled={running} />
              <span><b>Standard <span className="tag good">Recommended</span></b><small>Fast and light on memory; handles the largest files.</small></span>
            </label>
            <label className={`opt ${mode === 'B' ? 'on' : ''}`}>
              <input type="radio" checked={mode === 'B'} onChange={() => setMode('B')} disabled={running} />
              <span><b>SQL engine (DuckDB)</b><small>Second engine, useful to double-check results on small and medium files.</small></span>
            </label>
          </div>
          {mode === 'B' && est.modeB > SQL_LIMIT_MB && (
            <Note kind="warn">These files need about {fmtNum(est.modeB)} MB in the SQL engine — more than browsers reliably allow. Use Standard.</Note>
          )}
          <More title="Details and offline option">
            <div className="stat-grid">
              <div className="stat"><div className="k">Estimated memory</div><div className="v">~{fmtNum(mode === 'A' ? est.modeA : est.modeB)} MB</div></div>
              <div className="stat"><div className="k">Computer memory</div><div className="v">{ramGB ? `${ramGB} GB+` : 'Not reported'}</div></div>
              <div className="stat"><div className="k">Browser storage free</div><div className="v">{store ? fmtBytes(Math.max(0, store.quota - store.usage)) : 'Not reported'}</div></div>
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <label className="field"><span>Read files in pieces of</span>
                <select value={p.chunkMB} onChange={(e) => p.setChunkMB(+e.target.value)} disabled={mode === 'B' || running}>
                  {[2, 4, 8, 16, 32].map((n) => <option key={n} value={n}>{n} MB</option>)}
                </select>
              </label>
            </div>
            <p className="small muted">
              If files are too large for this browser, the page may stop responding. Then export fewer Group B columns, use “keep first”, split Group A,
              or run the same job on your computer with the offline tool:
            </p>
            <button className="btn sm" disabled={p.errors.length > 0 || !!p.busy}
              onClick={() =>
                downloadText(
                  buildOfflineScript(files, cfg, out, 'matched_consumers.csv', ',', Object.fromEntries(files.map((f) => [f.id, csvNameFor(f)]))),
                  'matcher_job.sql',
                  'text/plain',
                )
              }>
              Download offline job (Python/DuckDB)
            </button>
            {files.some((f) => f.source) && <p className="small muted">For Excel sheets, save their CSV copies first (file settings ⚙ on the first step).</p>}
          </More>
        </div>
      </div>
    </>
  );
}
