import type { ReactNode } from 'react';
import type { Progress } from '../engine/types';
import { fmtBytes, fmtMs, fmtNum } from '../lib/format';

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const p: Record<string, ReactNode> = {
    bolt: <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />,
    upload: <><path d="M12 16V4" /><path d="m6 10 6-6 6 6" /><path d="M4 20h16" /></>,
    link: <><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" /><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" /></>,
    columns: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M15 4v16" /></>,
    play: <path d="M7 4v16l13-8z" />,
    download: <><path d="M12 4v12" /><path d="m6 10 6 6 6-6" /><path d="M4 20h16" /></>,
    shield: <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" />,
    x: <><path d="M6 6l12 12M18 6 6 18" /></>,
    up: <path d="m6 15 6-6 6 6" />,
    down: <path d="m6 9 6 6 6-6" />,
    trash: <><path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13" /><path d="M9 7V4h6v3" /></>,
    file: <><path d="M6 2h9l5 5v15H6z" /><path d="M14 2v6h6" /></>,
    check: <path d="m5 12 5 5 9-10" />,
    gear: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" /></>,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {p[name]}
    </svg>
  );
}

export function Note({ kind = 'info', children }: { kind?: 'info' | 'warn' | 'err' | 'ok'; children: ReactNode }) {
  return <div className={`note ${kind}`}>{children}</div>;
}

export function Stat({ label, value, hl }: { label: string; value: string; hl?: boolean }) {
  return (
    <div className={`stat ${hl ? 'hl' : ''}`}>
      <div className="k">{label}</div>
      <div className="v">{value}</div>
    </div>
  );
}

/** Closed-by-default section for less-used options. */
export function More({ title, children, open }: { title: string; children: ReactNode; open?: boolean }) {
  return (
    <details className="more" open={open}>
      <summary>{title}</summary>
      <div className="more-body">{children}</div>
    </details>
  );
}

export function PageHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="page-head">
      <h1>{title}</h1>
      {sub && <p>{sub}</p>}
    </div>
  );
}

export function ProgressPanel({ p, onCancel }: { p: Progress; onCancel?: () => void }) {
  const pct = p.percent;
  return (
    <div className="prog">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <span>
          <b>{p.stage}</b>
          {p.file ? <span className="muted"> · {p.file}</span> : null}
        </span>
        {onCancel && <button className="btn sm danger" onClick={onCancel}>Cancel</button>}
      </div>
      <div className={`bar-track ${pct === undefined ? 'indet' : ''}`}>
        <div style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
      </div>
      <div className="prog-line">
        <span>{pct === undefined ? 'Progress not measurable yet' : <b>{pct.toFixed(0)}%</b>}</span>
        <span>Rows <b>{fmtNum(p.rowsDone)}</b>{p.rowsTotal !== undefined && <> of <b>{fmtNum(p.rowsTotal)}</b></>}</span>
        {p.bytesTotal !== undefined && <span>Read <b>{fmtBytes(p.bytesDone ?? 0)}</b> of {fmtBytes(p.bytesTotal)}</span>}
        <span>Time <b>{fmtMs(p.elapsedMs)}</b></span>
      </div>
    </div>
  );
}
