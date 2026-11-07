import { useMemo, useState } from 'react';
import type { FileMeta, Group, MatchConfig, MetaKind, OutputColumn, OutputConfig } from '../engine/types';
import { uid } from '../lib/format';
import { Icon, Note, PageHead } from './ui';

interface Props {
  files: FileMeta[];
  cfg: MatchConfig;
  out: OutputConfig;
  setOut: (o: OutputConfig) => void;
}

const METAS: { m: MetaKind; label: string; d: string }[] = [
  { m: 'match_key', label: 'Matching Key', d: 'Normalised key used for matching' },
  { m: 'match_status', label: 'Match Status', d: 'MATCHED / NOT FOUND / BLANK KEY' },
  { m: 'source_file_a', label: 'Source File (A)', d: 'Group A file name' },
  { m: 'source_file_b', label: 'Source File (B)', d: 'Group B file name(s)' },
  { m: 'count_a', label: 'Occurrences in A', d: 'Rows with this key in Group A' },
  { m: 'count_b', label: 'Occurrences in B', d: 'Rows with this key in Group B' },
  { m: 'row_number_a', label: 'Row No. (A)', d: 'Record number in the A file' },
  { m: 'row_number_b', label: 'Row No. (B)', d: 'Record number in the B file' },
];

export default function Output({ files, cfg, out, setOut }: Props) {
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const g = (x: Group) => {
      const fs = files.filter((f) => f.group === x);
      const cols: { name: string; missingIn: FileMeta[] }[] = [];
      const seen = new Set<string>();
      for (const f of fs)
        for (const h of f.headers)
          if (!seen.has(h)) {
            seen.add(h);
            cols.push({ name: h, missingIn: fs.filter((o) => !o.headers.includes(h)) });
          }
      return { files: fs, cols };
    };
    return { A: g('A'), B: g('B') };
  }, [files]);

  const isOn = (g: Group, name: string) => out.columns.some((c) => c.kind === 'field' && c.group === g && c.column === name);
  // Suggest a same-meaning heading in files that lack the column ("Mobile" -> "Mobile No").
  // The suggestion is shown in the row and can be changed or cleared.
  const suggest = (g: Group, name: string): Record<string, string> | undefined => {
    const n = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
    const want = n(name);
    if (want.length < 3) return undefined;
    const map: Record<string, string> = {};
    for (const f of groups[g].files) {
      if (f.headers.includes(name)) continue;
      const hit = f.headers.find((h) => n(h).length >= 3 && (n(h).includes(want) || want.includes(n(h))));
      if (hit) map[f.id] = hit;
    }
    return Object.keys(map).length ? map : undefined;
  };
  const toggle = (g: Group, name: string) => {
    if (isOn(g, name)) setOut({ ...out, columns: out.columns.filter((c) => !(c.kind === 'field' && c.group === g && c.column === name)) });
    else {
      const dup = out.columns.some((c) => c.label === name);
      setOut({ ...out, columns: [...out.columns, { id: uid(), kind: 'field', group: g, column: name, label: dup ? `${name} (${g})` : name, perFile: suggest(g, name) }] });
    }
  };
  const metaOn = (m: MetaKind) => out.columns.some((c) => c.kind === 'meta' && c.meta === m);
  const toggleMeta = (m: MetaKind, label: string) =>
    setOut({
      ...out,
      columns: metaOn(m) ? out.columns.filter((c) => !(c.kind === 'meta' && c.meta === m)) : [...out.columns, { id: uid(), kind: 'meta', meta: m, label }],
    });
  const update = (id: string, patch: Partial<OutputColumn>) => setOut({ ...out, columns: out.columns.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  const move = (i: number, d: number) => {
    const cols = [...out.columns];
    const j = i + d;
    if (j < 0 || j >= cols.length) return;
    [cols[i], cols[j]] = [cols[j], cols[i]];
    setOut({ ...out, columns: cols });
  };
  const addAll = (g: Group) => {
    const add = groups[g].cols.filter((c) => !isOn(g, c.name)).map((c) => ({ id: uid(), kind: 'field' as const, group: g, column: c.name, label: out.columns.some((x) => x.label === c.name) ? `${c.name} (${g})` : c.name, perFile: suggest(g, c.name) }));
    setOut({ ...out, columns: [...out.columns, ...add] });
  };
  const labels = out.columns.map((c) => c.label.trim());
  const dupLabels = labels.filter((l, i) => labels.indexOf(l) !== i);
  const ql = q.toLowerCase();

  const missing = out.columns.flatMap((c) => {
    if (c.kind !== 'field') return [];
    return files
      .filter((f) => f.group === c.group && !(cfg.bCombine === 'join' && c.group === 'B' && c.fromFile && c.fromFile !== f.id))
      .filter((f) => !f.headers.includes(c.perFile?.[f.id] ?? c.column!))
      .map((f) => ({ c, f }));
  });

  return (
    <>
    <PageHead title="Which columns do you want?" sub="Tick columns on the left. On the right, rename them and set the order — the file is written exactly like this." />
    <div className="builder">
      <div className="card">
        <h2>Available columns</h2>
        <div className="row" style={{ margin: '8px 0' }}>
          <input type="search" placeholder="Search headings…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
        </div>
        <div className="avail">
          {(['A', 'B'] as Group[]).map((g) => (
            <div key={g}>
              <div className="grp row" style={{ justifyContent: 'space-between' }}>
                <span>GROUP {g} · {groups[g].cols.length} columns</span>
                <button className="btn sm" onClick={() => addAll(g)}>Add all</button>
              </div>
              {groups[g].cols.filter((c) => c.name.toLowerCase().includes(ql)).map((c) => (
                <label key={c.name}>
                  <input type="checkbox" checked={isOn(g, c.name)} onChange={() => toggle(g, c.name)} />
                  <span>{c.name}</span>
                  {c.missingIn.length > 0 && <span className="miss" title={c.missingIn.map((f) => f.name).join(', ')}>not in {c.missingIn.length} file(s)</span>}
                </label>
              ))}
            </div>
          ))}
          <div className="grp">EXTRA INFORMATION (OPTIONAL)</div>
          {METAS.filter((m) => m.label.toLowerCase().includes(ql)).map((m) => (
            <label key={m.m} title={m.d}>
              <input type="checkbox" checked={metaOn(m.m)} onChange={() => toggleMeta(m.m, m.label)} />
              <span>{m.label}</span><span className="miss" style={{ color: 'var(--muted)' }}>{m.d}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="card">
        <h2>Your output <span className="tag none">{out.columns.length} columns</span></h2>
        {out.columns.length === 0 && <p className="muted" style={{ padding: '30px 0', textAlign: 'center' }}>Nothing selected yet — tick columns on the left.</p>}
        {out.columns.map((c, i) => {
          const gFiles = c.kind === 'field' ? files.filter((f) => f.group === c.group) : [];
          const lacking = gFiles.filter((f) => !f.headers.includes(c.column!));
          return (
            <div key={c.id} className="sel-row">
              <div className="idx">{i + 1}</div>
              <div>{c.kind === 'field' ? <span className={`tag ${c.group === 'A' ? 'a' : 'b'}`}>{c.group}</span> : <span className="tag none">Info</span>}</div>
              <div className="src" title={c.column ?? c.meta}>{c.kind === 'field' ? c.column : METAS.find((m) => m.m === c.meta)?.label}</div>
              <input type="text" value={c.label} onChange={(e) => update(c.id, { label: e.target.value })} aria-label="Output heading" />
              <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                <button className="btn icon sm" title="Move up" onClick={() => move(i, -1)}><Icon name="up" size={14} /></button>
                <button className="btn icon sm" title="Move down" onClick={() => move(i, 1)}><Icon name="down" size={14} /></button>
                <button className="btn icon sm" title="Remove" onClick={() => setOut({ ...out, columns: out.columns.filter((x) => x.id !== c.id) })}><Icon name="x" size={14} /></button>
              </div>
              {c.kind === 'field' && (lacking.length > 0 || (cfg.bCombine === 'join' && c.group === 'B' && gFiles.length > 1)) && (
                <div className="perfile">
                  {cfg.bCombine === 'join' && c.group === 'B' && gFiles.length > 1 && (
                    <label>Take from
                      <select value={c.fromFile ?? ''} onChange={(e) => update(c.id, { fromFile: e.target.value || undefined })}>
                        <option value="">first file that has the consumer</option>
                        {gFiles.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                      </select>
                    </label>
                  )}
                  {lacking.filter((f) => !(cfg.bCombine === 'join' && c.group === 'B' && c.fromFile && c.fromFile !== f.id)).map((f) => (
                    <label key={f.id}>In <b>{f.name}</b> use
                      <select value={c.perFile?.[f.id] ?? ''} onChange={(e) => update(c.id, { perFile: { ...(c.perFile ?? {}), [f.id]: e.target.value } })}>
                        <option value="">— not available —</option>
                        {f.headers.map((h) => <option key={h}>{h}</option>)}
                      </select>
                    </label>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        <div className="row" style={{ marginTop: 14 }}>
          <label className="field"><span>Write this when a value is missing</span>
            <input type="text" value={out.missingValue} placeholder="(blank)" onChange={(e) => setOut({ ...out, missingValue: e.target.value })} />
          </label>
        </div>
        {dupLabels.length > 0 && <Note kind="warn">Duplicate output headings: {Array.from(new Set(dupLabels)).join(', ')}. Rename them so the columns can be told apart.</Note>}
        {missing.length > 0 && (
          <Note kind="warn">
            Some selected fields are missing in some files; “{out.missingValue || '(blank)'}” will be written for those rows:
            <ul>{missing.slice(0, 8).map(({ c, f }) => <li key={c.id + f.id}>{c.label} — {f.name}</li>)}</ul>
            {missing.length > 8 && <div>…and {missing.length - 8} more</div>}
          </Note>
        )}
      </div>
    </div>
    </>
  );
}
