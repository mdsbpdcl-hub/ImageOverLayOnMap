import { useState } from 'react';
import type { AnalysisStats, ExportOptions, MatchConfig, Progress } from '../engine/types';
import type { ExportRecord } from '../App';
import { caps } from '../lib/files';
import { DELIMS, fmtBytes, fmtMs, fmtNum } from '../lib/format';
import { XLSX_MAX_ROWS } from '../engine/writer';
import { Icon, More, Note, PageHead, ProgressPanel, Stat } from './ui';

interface Props {
  stats: AnalysisStats;
  cfg: MatchConfig;
  preview: { header: string[]; rows: string[][] } | null;
  opts: ExportOptions;
  setOpts: (o: ExportOptions) => void;
  busy: string | null;
  progress: Progress | null;
  error: string | null;
  exports: ExportRecord[];
  issues: number;
  mode: 'A' | 'B';
  onExport: () => void;
  onReport: (r: 'duplicates' | 'issues') => void;
  onSummary: () => void;
  onCancel: () => void;
  onClear: () => void;
}

const PAGE = 50;

export default function Results(p: Props) {
  const { stats, opts, setOpts } = p;
  const [page, setPage] = useState(0);
  const rows = p.preview?.rows ?? [];
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const xlsxTooBig = opts.format === 'xlsx' && stats.expectedOutputRows > XLSX_MAX_ROWS - 1 && !opts.splitRows;
  const blocked = stats.cartesianKeys > 0 && !p.cfg.allowCartesian;
  const unmatched = p.cfg.operation === 'b_not_a' ? stats.unmatchedBKeys : stats.unmatchedAKeys;
  const lastExport = p.exports.find((x) => x.label === 'Matched output');

  return (
    <>
      <PageHead title="Results" sub="Check the preview, then save the file." />
      <div className="stack">
        <div className="summary">
          <Stat label="Matched consumers" value={fmtNum(stats.matchedKeys)} hl />
          <Stat label={p.cfg.operation === 'b_not_a' ? 'In B, not in A' : 'Not found in B'} value={fmtNum(unmatched)} />
          <Stat label="Rows in result" value={fmtNum(lastExport?.result.rows ?? stats.expectedOutputRows)} />
          <Stat label="Repeated consumers (A · B)" value={`${fmtNum(stats.aDuplicateKeys)} · ${fmtNum(stats.bDuplicateKeys)}`} />
        </div>

        <div className="card">
          <h2>Save the result</h2>
          <div className="grid3" style={{ gap: 12, marginTop: 12 }}>
            <label className="field"><span>File name</span>
              <input type="text" value={opts.fileName} onChange={(e) => setOpts({ ...opts, fileName: e.target.value.replace(/[\\/:*?"<>|]/g, '_') })} />
            </label>
            <label className="field"><span>Format</span>
              <select value={opts.format} onChange={(e) => setOpts({ ...opts, format: e.target.value as ExportOptions['format'] })}>
                <option value="csv">CSV (recommended)</option>
                <option value="xlsx">Excel (.xlsx)</option>
              </select>
            </label>
            <label className="field"><span>Save to</span>
              <select value={opts.target} onChange={(e) => setOpts({ ...opts, target: e.target.value as ExportOptions['target'] })}>
                {caps.saveAs && <option value="file">Choose where to save…</option>}
                {caps.folder && <option value="directory">Choose a folder…</option>}
                <option value="download">Downloads folder</option>
              </select>
            </label>
          </div>
          <More title="More export options">
            <div className="grid3" style={{ gap: 12 }}>
              <label className="field"><span>Split into files of</span>
                <select value={opts.splitRows} onChange={(e) => setOpts({ ...opts, splitRows: +e.target.value })}>
                  <option value={0}>Do not split</option>
                  {[100000, 500000, 1000000, 1048575].map((n) => <option key={n} value={n}>{fmtNum(n)} rows</option>)}
                </select>
              </label>
              {opts.format === 'csv' && (
                <label className="field"><span>Separator</span>
                  <select value={opts.delimiter} onChange={(e) => setOpts({ ...opts, delimiter: e.target.value })}>
                    {DELIMS.map((d) => <option key={d.v} value={d.v}>{d.label}</option>)}
                  </select>
                </label>
              )}
            </div>
            {opts.format === 'csv' && (
              <div className="row" style={{ gap: 18, marginTop: 12 }}>
                <label className="check"><input type="checkbox" checked={opts.bom} onChange={(e) => setOpts({ ...opts, bom: e.target.checked })} />Excel-friendly (shows Hindi correctly)</label>
                <label className="check"><input type="checkbox" checked={opts.formulaGuard} onChange={(e) => setOpts({ ...opts, formulaGuard: e.target.checked })} />Protect against spreadsheet formulas</label>
              </div>
            )}
            {opts.format === 'csv' && <p className="small muted">Excel may show long numbers like 1.23E+11 when it opens a CSV; the file itself keeps every digit. Choose Excel (.xlsx) to avoid this.</p>}
          </More>
          {opts.target === 'file' && opts.splitRows > 0 && <Note kind="warn">Splitting makes several files: choose a folder or the Downloads folder.</Note>}
          {xlsxTooBig && <Note kind="err">The result has {fmtNum(stats.expectedOutputRows)} rows — more than one Excel sheet can hold. Choose CSV, or split under More export options.</Note>}
          {blocked && <Note kind="err">Rows would multiply. Allow it on the Matching step, or choose another duplicate rule.</Note>}
          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn primary big" disabled={!!p.busy || xlsxTooBig || blocked || (opts.target === 'file' && opts.splitRows > 0)} onClick={p.onExport}>
              <Icon name="download" size={16} /> Export {fmtNum(stats.expectedOutputRows)} rows
            </button>
          </div>
          {p.busy === 'export' && p.progress && <ProgressPanel p={p.progress} onCancel={p.onCancel} />}
          {p.error && <Note kind="err"><b>The export did not finish.</b> {p.error}</Note>}
          {p.exports.map((x, i) => (
            <Note key={i} kind={x.result.warnings.length ? 'warn' : 'ok'}>
              <b>{x.label}: {fmtNum(x.result.rows)} rows exported</b> <span className="muted">· {x.at} · {fmtMs(x.result.ms)}</span>
              <ul>{x.result.files.map((f) => <li key={f.name}>{f.name} · {fmtNum(f.rows)} rows · {fmtBytes(f.bytes)}</li>)}</ul>
              {x.result.warnings.map((w) => <div key={w}>⚠ {w}</div>)}
            </Note>
          ))}
        </div>

        <div className="card">
          <h2>Preview <span className="tag none">first {fmtNum(rows.length)} of {fmtNum(stats.expectedOutputRows)} rows</span></h2>
          {!p.preview && <p className="muted">Loading</p>}
          {p.preview && rows.length === 0 && (
            <p className="muted">{blocked ? 'No preview: the result is blocked because rows would multiply.' : 'No data yet — the result has no rows for these settings.'}</p>
          )}
          {p.preview && rows.length > 0 && (
            <>
              <div className="tbl-wrap preview" style={{ marginTop: 10 }}>
                <table>
                  <thead><tr><th className="num">#</th>{p.preview.header.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
                  <tbody>
                    {rows.slice(page * PAGE, page * PAGE + PAGE).map((r, i) => (
                      <tr key={i}><td className="num muted">{page * PAGE + i + 1}</td>{r.map((v, j) => <td key={j}>{v}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {pages > 1 && (
                <div className="pager">
                  <button className="btn sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
                  <span>Page {page + 1} of {pages}</span>
                  <button className="btn sm" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>Next</button>
                </div>
              )}
            </>
          )}
        </div>

        <div className="card">
          <h2>Reports</h2>
          <p className="lead">Extra files for checking and records.</p>
          <div className="row">
            <button className="btn" disabled={!!p.busy} onClick={p.onSummary}><Icon name="file" size={15} /> Matching summary</button>
            <button className="btn" disabled={!!p.busy} onClick={() => p.onReport('duplicates')}><Icon name="file" size={15} /> Duplicate report</button>
            <button className="btn" disabled={!!p.busy || p.mode === 'B'} title={p.mode === 'B' ? 'Available with the Standard engine' : ''} onClick={() => p.onReport('issues')}>
              <Icon name="file" size={15} /> Data issue report{p.issues ? ` (${fmtNum(p.issues)})` : ''}
            </button>
          </div>
          <More title="Privacy: clear temporary data">
            <p className="small muted" style={{ marginTop: 0 }}>Removes the in-browser index, SQL tables and temporary copies (exports, Excel sheet copies). Excel files must then be added again.</p>
            <button className="btn danger" disabled={!!p.busy} onClick={p.onClear}><Icon name="trash" size={15} /> Clear temporary data</button>
          </More>
        </div>
      </div>
    </>
  );
}
