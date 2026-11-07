import { useRef, useState } from 'react';
import type { Encoding, Group } from '../engine/types';
import type { Entry } from '../App';
import { DELIMS, fmtBytes, fmtNum } from '../lib/format';
import { Icon, PageHead } from './ui';

interface Props {
  entries: Entry[];
  onAdd: (g: Group, files: File[]) => void;
  onRemove: (id: string) => void;
  onChange: (id: string, patch: { delimiter?: string; encoding?: Encoding }) => void;
  onSheet: (id: string, sheetPath: string) => void;
  onOtherSheets: (id: string) => void;
  onSaveCsv: (id: string) => void;
}

const ENCODINGS: { v: Encoding; label: string }[] = [
  { v: 'utf-8', label: 'UTF-8' },
  { v: 'windows-1252', label: 'Windows-1252 / ANSI' },
  { v: 'utf-16le', label: 'UTF-16 LE' },
  { v: 'utf-16be', label: 'UTF-16 BE' },
];
const delimName = (d: string) => DELIMS.find((x) => x.v === d)?.label.split(' ')[0] ?? d;

function FileItem({ e, entries, p }: { e: Entry; entries: Entry[]; p: Props }) {
  const [open, setOpen] = useState(false);
  const m = e.meta;
  const xl = !!m.source || !!e.sheets;
  const otherSheets = e.sheets
    ? e.sheets.filter((sh) => !sh.hidden && !entries.some((x) => x.file === e.file && x.meta.source?.sheetPath === sh.path)).length
    : 0;
  const busy = m.status === 'reading' || m.status === 'converting' || m.status === 'counting';
  const progress =
    m.status === 'converting'
      ? `${e.convStage ?? 'Converting'}${e.countPct !== undefined ? ` ${e.countPct.toFixed(0)}%` : ''}`
      : m.status === 'counting'
        ? `Counting rows${e.countPct !== undefined ? ` ${e.countPct.toFixed(0)}%` : ''}`
        : m.status === 'reading'
          ? 'Reading'
          : '';
  const details = xl ? `Excel · ${fmtBytes(e.file.size)}` : `${delimName(m.delimiter)} · ${ENCODINGS.find((x) => x.v === m.encoding)?.label} · ${fmtBytes(e.file.size)}`;
  return (
    <div className="file">
      <div className="file-row">
        <Icon name="file" size={18} />
        <div className="file-main">
          <div className="fname" title={m.name}>{m.name}</div>
          <div className="fmeta">
            {m.rows !== undefined ? `${fmtNum(m.rows)} rows · ${m.headers.length} columns · ` : ''}
            {details}
          </div>
        </div>
        {m.status === 'ready' && <span className="tag good">Ready</span>}
        {m.status === 'reading' && <span className="tag none">Reading</span>}
        {m.status === 'converting' && <span className="tag watch">Converting</span>}
        {m.status === 'counting' && <span className="tag watch">Counting</span>}
        {m.status === 'error' && <span className="tag bad">Error</span>}
        {!busy && m.status !== 'error' && (
          <button className="btn icon sm" title="File settings" onClick={() => setOpen(!open)}><Icon name="gear" size={15} /></button>
        )}
        <button className="btn icon sm" title="Remove" onClick={() => p.onRemove(m.id)} disabled={m.status === 'converting'}><Icon name="x" size={15} /></button>
      </div>
      {busy && progress && <div className="fmeta" style={{ marginTop: 4 }}>{progress}</div>}
      {m.error && <div className="err-text">{m.error}</div>}
      {m.warnings.length > 0 && <ul className="warn-list">{m.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
      {otherSheets > 0 && !busy && (
        <button className="btn link" onClick={() => p.onOtherSheets(m.id)}>+ add {otherSheets} more sheet{otherSheets > 1 ? 's' : ''}</button>
      )}
      {open && (
        <div className="file-settings">
          {xl ? (
            <>
              {e.sheets && (
                <label className="field"><span>Sheet</span>
                  <select value={m.source?.sheetPath ?? ''} onChange={(ev) => p.onSheet(m.id, ev.target.value)}>
                    {e.sheets.map((sh) => <option key={sh.path} value={sh.path}>{sh.name}{sh.hidden ? ' (hidden)' : ''}</option>)}
                  </select>
                </label>
              )}
              {e.csv && (
                <label className="field"><span>Copy</span>
                  <button className="btn sm" title="Save this sheet as a CSV file (e.g. for the offline tool)" onClick={() => p.onSaveCsv(m.id)}>Save as CSV</button>
                </label>
              )}
            </>
          ) : (
            <>
              <label className="field"><span>Delimiter</span>
                <select value={m.delimiter} onChange={(ev) => p.onChange(m.id, { delimiter: ev.target.value })}>
                  {DELIMS.map((d) => <option key={d.v} value={d.v}>{d.label}</option>)}
                </select>
              </label>
              <label className="field"><span>Encoding</span>
                <select value={m.encoding} onChange={(ev) => p.onChange(m.id, { encoding: ev.target.value as Encoding })}>
                  {ENCODINGS.map((d) => <option key={d.v} value={d.v}>{d.label}</option>)}
                </select>
              </label>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Zone({ group, p }: { group: Group; p: Props }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const list = p.entries.filter((e) => e.meta.group === group);
  const totalRows = list.length && list.every((e) => e.meta.rows !== undefined) ? list.reduce((s, e) => s + (e.meta.rows ?? 0), 0) : undefined;
  return (
    <div className="card">
      <h2>{group === 'A' ? 'Group A · Target consumers' : 'Group B · Master data'}</h2>
      <p className="lead">{group === 'A' ? 'The consumers you need information for.' : 'Files that hold the consumer details.'}</p>
      <div
        className={`drop ${over ? 'over' : ''}`}
        onClick={() => input.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const files = Array.from(e.dataTransfer.files).filter((f) => /\.(csv|txt|tsv|xlsx|xlsm|xls|xlsb|ods)$/i.test(f.name) || f.type.includes('csv') || f.type === 'text/plain');
          if (files.length) p.onAdd(group, files);
        }}
      >
        <Icon name="upload" size={22} />
        <b>Drop files here or click to choose</b>
        <span>CSV or Excel (.xlsx) · several files allowed</span>
        <input ref={input} type="file" multiple accept=".csv,.txt,.tsv,text/csv,.xlsx,.xlsm,.xls,.xlsb,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="hidden"
          onChange={(e) => { if (e.target.files?.length) p.onAdd(group, Array.from(e.target.files)); e.target.value = ''; }} />
      </div>
      {list.length > 0 && (
        <>
          <div className="files">{list.map((e) => <FileItem key={e.meta.id} e={e} entries={p.entries} p={p} />)}</div>
          <div className="totals">
            <span>{list.length} file{list.length > 1 ? 's' : ''}</span>
            <span>{totalRows === undefined ? 'Counting rows…' : `${fmtNum(totalRows)} rows in total`}</span>
          </div>
        </>
      )}
    </div>
  );
}

export default function Upload(p: Props) {
  return (
    <>
      <PageHead title="Add your files" sub="Files are read on this computer only — nothing is uploaded anywhere." />
      <div className="grid2">
        <Zone group="A" p={p} />
        <Zone group="B" p={p} />
      </div>
    </>
  );
}
