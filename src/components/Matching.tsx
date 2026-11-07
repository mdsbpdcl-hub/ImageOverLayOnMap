import { useState } from 'react';
import type { DupPolicy, FilterRule, MatchConfig, Operation, OutputConfig } from '../engine/types';
import type { Entry } from '../App';
import { uid } from '../lib/format';
import { applyTemplate, deleteTemplate, listTemplates, saveTemplate } from '../lib/templates';
import { More, Note, PageHead } from './ui';

interface Props {
  entries: Entry[];
  cfg: MatchConfig;
  setCfg: (c: MatchConfig) => void;
  out: OutputConfig;
  setOut: (o: OutputConfig) => void;
}

const OPS: { v: Operation; t: string; d: string }[] = [
  { v: 'common', t: 'Matched consumers', d: 'Found in both groups' },
  { v: 'a_with_status', t: 'All targets with status', d: 'Every Group A consumer, marked found or not' },
  { v: 'a_not_b', t: 'Targets not found', d: 'Group A consumers missing from Group B' },
  { v: 'b_not_a', t: 'Extra in master', d: 'Group B consumers not in Group A' },
];

const POLICIES: { v: DupPolicy; t: string }[] = [
  { v: 'first', t: 'Keep first occurrence' },
  { v: 'last', t: 'Keep last occurrence' },
  { v: 'all', t: 'Keep all matching rows' },
  { v: 'newest', t: 'Keep newest (by a date column)' },
  { v: 'unique', t: 'One record per unique consumer' },
];

export default function Matching({ entries, cfg, setCfg, out, setOut }: Props) {
  const [tplName, setTplName] = useState('');
  const [tpls, setTpls] = useState(listTemplates());
  const [tplMsg, setTplMsg] = useState('');
  const parts = Math.max(1, ...entries.map((e) => (cfg.keyColumns[e.meta.id] ?? []).length));
  const metas = entries.map((e) => e.meta);

  const setKey = (fileId: string, part: number, col: string) => {
    const keyColumns = { ...cfg.keyColumns };
    const cur = [...(keyColumns[fileId] ?? [])];
    while (cur.length < parts) cur.push('');
    cur[part] = col;
    keyColumns[fileId] = cur;
    // apply the same heading to other files of the group that have it and are unset
    const g = metas.find((m) => m.id === fileId)!.group;
    for (const m of metas) {
      if (m.id === fileId || m.group !== g || !m.headers.includes(col)) continue;
      const other = [...(keyColumns[m.id] ?? [])];
      while (other.length < parts) other.push('');
      if (!other[part]) {
        other[part] = col;
        keyColumns[m.id] = other;
      }
    }
    setCfg({ ...cfg, keyColumns });
  };

  const setParts = (n: number) => {
    const keyColumns: Record<string, string[]> = {};
    for (const m of metas) {
      const cur = [...(cfg.keyColumns[m.id] ?? [])].slice(0, n);
      while (cur.length < n) cur.push('');
      keyColumns[m.id] = cur;
    }
    setCfg({ ...cfg, keyColumns });
  };

  const needDate = (g: 'A' | 'B') => (g === 'A' ? cfg.dupA : cfg.dupB) === 'newest';
  const cartesian = cfg.dupA === 'all' && cfg.dupB === 'all' && cfg.bCombine === 'union';
  const groupLabel = (g: 'A' | 'B') => (g === 'A' ? 'a' : 'b');

  const addFilter = () =>
    setCfg({ ...cfg, filters: [...cfg.filters, { id: uid(), group: 'B', column: metas.find((m) => m.group === 'B')?.headers[0] ?? '', op: 'not_blank', value: '' }] });
  const setFilter = (id: string, patch: Partial<FilterRule>) =>
    setCfg({ ...cfg, filters: cfg.filters.map((f) => (f.id === id ? { ...f, ...patch } : f)) });
  const groupHeaders = (g: 'A' | 'B') => Array.from(new Set(metas.filter((m) => m.group === g).flatMap((m) => m.headers)));

  const numericKeys = metas.flatMap((m) =>
    (cfg.keyColumns[m.id] ?? []).filter((c) => c && m.numericColumns?.includes(c)).map((c) => `“${c}” in ${m.name}`),
  );
  const advancedUsed =
    cfg.filters.length > 0 || cfg.bCombine === 'join' || cfg.normalize.ignoreCase || cfg.normalize.stripLeadingZeros || cfg.normalize.collapseSpaces || !cfg.normalize.trim;

  return (
    <>
      <PageHead title="How should consumers be matched?" sub="Pick the column that identifies a consumer in each file. Headings may differ between files." />
      <div className="stack">
        <div className="card">
          <h2>Matching column</h2>
          <div className="tbl-wrap" style={{ marginTop: 12 }}>
            <table>
              <thead>
                <tr>
                  <th>File</th>
                  {Array.from({ length: parts }, (_, i) => <th key={i}>{parts > 1 ? `Key part ${i + 1}` : 'Consumer number column'}</th>)}
                  {(needDate('A') || needDate('B')) && <th>Date column (for “newest”)</th>}
                </tr>
              </thead>
              <tbody>
                {metas.map((m) => (
                  <tr key={m.id}>
                    <td><span className={`tag ${groupLabel(m.group)}`}>{m.group}</span> <span title={m.name}>{m.name}</span></td>
                    {Array.from({ length: parts }, (_, i) => (
                      <td key={i}>
                        <select value={cfg.keyColumns[m.id]?.[i] ?? ''} onChange={(e) => setKey(m.id, i, e.target.value)}>
                          <option value="">— choose —</option>
                          {m.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                        </select>
                      </td>
                    ))}
                    {(needDate('A') || needDate('B')) && (
                      <td>
                        {needDate(m.group) ? (
                          <select value={cfg.dateColumns[m.id] ?? ''} onChange={(e) => setCfg({ ...cfg, dateColumns: { ...cfg.dateColumns, [m.id]: e.target.value } })}>
                            <option value="">— choose —</option>
                            {m.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                          </select>
                        ) : <span className="muted small">—</span>}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <span className="small muted">Several columns together identify a consumer?</span>
            <select value={parts} onChange={(e) => setParts(+e.target.value)} aria-label="Number of key columns">
              <option value={1}>One column</option>
              <option value={2}>2 columns</option>
              <option value={3}>3 columns</option>
              <option value={4}>4 columns</option>
            </select>
          </div>
          {numericKeys.length > 0 && (
            <Note kind="warn">
              {numericKeys.join(', ')} {numericKeys.length > 1 ? 'are' : 'is'} stored as numbers in Excel, so leading zeros may be missing.
              If other files have leading zeros, turn on “Ignore leading zeros” under Advanced options.
            </Note>
          )}
        </div>

        <div className="card">
          <h2>What do you want in the result?</h2>
          <div className="opts" style={{ marginTop: 12 }}>
            {OPS.map((o) => (
              <label key={o.v} className={`opt ${cfg.operation === o.v ? 'on' : ''}`}>
                <input type="radio" name="op" checked={cfg.operation === o.v} onChange={() => setCfg({ ...cfg, operation: o.v })} />
                <span><b>{o.t}</b><small>{o.d}</small></span>
              </label>
            ))}
          </div>

          <h3>If a consumer appears more than once</h3>
          <div className="grid2" style={{ gap: 12 }}>
            <label className="field"><span>In Group A</span>
              <select value={cfg.dupA} onChange={(e) => setCfg({ ...cfg, dupA: e.target.value as DupPolicy })}>
                {POLICIES.map((p) => <option key={p.v} value={p.v}>{p.t}</option>)}
              </select>
            </label>
            <label className="field"><span>In Group B</span>
              <select value={cfg.dupB} onChange={(e) => setCfg({ ...cfg, dupB: e.target.value as DupPolicy })}>
                {POLICIES.filter((p) => cfg.bCombine === 'union' || p.v !== 'all').map((p) => <option key={p.v} value={p.v}>{p.t}</option>)}
              </select>
            </label>
          </div>
          {(needDate('A') || needDate('B')) && (
            <label className="field" style={{ marginTop: 12, maxWidth: 300 }}><span>Date format in the files</span>
              <select value={cfg.dateOrder} onChange={(e) => setCfg({ ...cfg, dateOrder: e.target.value as MatchConfig['dateOrder'] })}>
                <option value="DMY">Day-Month-Year (31-12-2024)</option>
                <option value="MDY">Month-Day-Year (12-31-2024)</option>
                <option value="YMD">Year-Month-Day only (2024-12-31)</option>
              </select>
            </label>
          )}
          {cartesian && (
            <Note kind="warn">
              “Keep all” on both sides multiplies rows: a consumer twice in A and three times in B gives 6 rows.
              <label className="check" style={{ marginTop: 6 }}>
                <input type="checkbox" checked={cfg.allowCartesian} onChange={(e) => setCfg({ ...cfg, allowCartesian: e.target.checked })} />
                Yes, allow this
              </label>
            </Note>
          )}

          <More title={`Advanced options${advancedUsed ? ' (in use)' : ''}`} open={advancedUsed}>
            <h3 style={{ marginTop: 0 }}>Compare consumer numbers</h3>
            <div className="row" style={{ gap: 18 }}>
              {([
                ['trim', 'Ignore spaces at start/end'],
                ['collapseSpaces', 'Treat double spaces as one'],
                ['ignoreCase', 'Ignore upper/lower case (A–Z)'],
                ['stripLeadingZeros', 'Ignore leading zeros (0012 = 12)'],
              ] as const).map(([k, t]) => (
                <label key={k} className="check">
                  <input type="checkbox" checked={cfg.normalize[k]} onChange={(e) => setCfg({ ...cfg, normalize: { ...cfg.normalize, [k]: e.target.checked } })} />
                  {t}
                </label>
              ))}
            </div>
            <p className="small muted" style={{ margin: '8px 0 0' }}>Numbers are always compared as text, never converted. Blank numbers never match.</p>

            <h3>Several Group B files</h3>
            <div className="opts">
              <label className={`opt ${cfg.bCombine === 'union' ? 'on' : ''}`}>
                <input type="radio" name="comb" checked={cfg.bCombine === 'union'} onChange={() => setCfg({ ...cfg, bCombine: 'union' })} />
                <span><b>Combine as one list</b><small>A consumer is found in whichever file has them</small></span>
              </label>
              <label className={`opt ${cfg.bCombine === 'join' ? 'on' : ''}`}>
                <input type="radio" name="comb" checked={cfg.bCombine === 'join'}
                  onChange={() => setCfg({ ...cfg, bCombine: 'join', dupB: cfg.dupB === 'all' ? 'first' : cfg.dupB })} />
                <span><b>Join side by side</b><small>Each file adds its own columns to the same row</small></span>
              </label>
            </div>

            <h3>Only use some rows (filters)</h3>
            {cfg.filters.map((f) => (
              <div key={f.id} className="row" style={{ marginBottom: 8 }}>
                <select value={f.group} onChange={(e) => setFilter(f.id, { group: e.target.value as 'A' | 'B', column: groupHeaders(e.target.value as 'A' | 'B')[0] ?? '' })}>
                  <option value="A">Group A</option><option value="B">Group B</option>
                </select>
                <select value={f.column} onChange={(e) => setFilter(f.id, { column: e.target.value })}>
                  {groupHeaders(f.group).map((h) => <option key={h}>{h}</option>)}
                </select>
                <select value={f.op} onChange={(e) => setFilter(f.id, { op: e.target.value as FilterRule['op'] })}>
                  <option value="equals">equals</option><option value="not_equals">does not equal</option>
                  <option value="contains">contains</option><option value="starts_with">starts with</option>
                  <option value="blank">is blank</option><option value="not_blank">is not blank</option>
                </select>
                {!['blank', 'not_blank'].includes(f.op) && <input type="text" value={f.value} onChange={(e) => setFilter(f.id, { value: e.target.value })} style={{ width: 140 }} />}
                <button className="btn sm" onClick={() => setCfg({ ...cfg, filters: cfg.filters.filter((x) => x.id !== f.id) })}>Remove</button>
              </div>
            ))}
            <button className="btn sm" onClick={addFilter}>+ Add filter</button>
          </More>
        </div>

        <div className="card">
          <h2>Templates</h2>
          <p className="lead">Save these settings to reuse next time (settings only, never data).</p>
          <div className="row">
            <input type="text" placeholder="Template name" value={tplName} onChange={(e) => setTplName(e.target.value)} />
            <button className="btn" disabled={!tplName.trim()} onClick={() => { saveTemplate(tplName.trim(), metas, cfg, out); setTpls(listTemplates()); setTplMsg(`Saved “${tplName.trim()}”.`); }}>Save</button>
          </div>
          {tpls.length > 0 && (
            <div className="files">
              {tpls.map((t) => (
                <div key={t.name} className="file file-row">
                  <div className="file-main">
                    <div className="fname">{t.name}</div>
                    <div className="fmeta">{new Date(t.savedAt).toLocaleString('en-IN')}</div>
                  </div>
                  <button className="btn sm" onClick={() => {
                    const r = applyTemplate(t, metas);
                    setCfg(r.cfg);
                    setOut(r.out);
                    setTplMsg(r.unmatched.length ? `Applied. Choose the matching column for: ${r.unmatched.join(', ')}` : `Applied “${t.name}”.`);
                  }}>Apply</button>
                  <button className="btn sm danger" onClick={() => { deleteTemplate(t.name); setTpls(listTemplates()); }}>Delete</button>
                </div>
              ))}
            </div>
          )}
          {tplMsg && <Note kind="ok">{tplMsg}</Note>}
        </div>
      </div>
    </>
  );
}
