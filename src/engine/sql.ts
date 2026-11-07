// Mode B — SQL plan generation for DuckDB-Wasm. Produces exactly the same output
// as the Mode A engine (verified by tests/duckdb.test.ts against the reference).
// Only the needed columns are materialised (column projection); everything is
// read as VARCHAR so identifiers are never converted to numbers.

import type { AnalysisStats, FileMeta, FilterRule, MatchConfig, OutputColumn, OutputConfig, DupPolicy } from './types';
import { resolveIndex } from './core';
import { upperSimple } from './normalize';

const WS = '[ \\t\\r\\n\\f\\v\\x{00A0}]';
export const lit = (s: string) => "'" + s.replace(/'/g, "''") + "'";
const WS_EDGE_JS = /^[ \t\r\n\f\v ]+|[ \t\r\n\f\v ]+$/g;

/** Folds only a–z to A–Z (same as upperSimple in normalize.ts). */
function upperAscii(e: string) {
  return `translate(${e}, 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')`;
}

function trimWs(e: string) {
  return `regexp_replace(${e}, '^${WS}+|${WS}+$', '', 'g')`;
}

function normExpr(col: string, cfg: MatchConfig): string {
  let e = `coalesce(${col}, '')`;
  const o = cfg.normalize;
  if (o.trim) e = trimWs(e);
  if (o.collapseSpaces) e = `regexp_replace(${e}, '${WS}+', ' ', 'g')`;
  if (o.ignoreCase) e = upperAscii(e);
  if (o.stripLeadingZeros) e = `regexp_replace(${e}, '^0+(.)', '\\1')`;
  return e;
}

function encodingOf(f: FileMeta): string {
  switch (f.encoding) {
    case 'utf-8': return 'utf-8';
    case 'windows-1252': return 'latin-1';
    case 'utf-16le': return 'utf-16';
    default: throw new Error(`${f.name}: UTF-16 big-endian files are not supported by the SQL engine; use the streaming engine (Mode A).`);
  }
}

export function readCsv(f: FileMeta, regName: string): string {
  const cols = f.headers.map((_, i) => `'c${i}': 'VARCHAR'`).join(', ');
  return (
    `read_csv(${lit(regName)}, header = true, delim = ${lit(f.delimiter)}, quote = '"', escape = '"', ` +
    `columns = {${cols}}, auto_detect = false, null_padding = true, strict_mode = false, parallel = false, ` +
    `max_line_size = 16777216, encoding = ${lit(encodingOf(f))})`
  );
}

function filterExpr(rules: FilterRule[], f: FileMeta): string {
  const rs = rules.filter((r) => r.group === f.group);
  if (!rs.length) return 'true';
  return rs
    .map((r) => {
      const i = f.headers.indexOf(r.column);
      const v = i < 0 ? "''" : upperAscii(trimWs(`coalesce(c${i}, '')`));
      const val = lit(upperSimple(r.value.replace(WS_EDGE_JS, '')));
      switch (r.op) {
        case 'equals': return `(${v} = ${val})`;
        case 'not_equals': return `(${v} <> ${val})`;
        case 'contains': return `contains(${v}, ${val})`;
        case 'starts_with': return `starts_with(${v}, ${val})`;
        case 'blank': return `(${v} = '')`;
        case 'not_blank': return `(${v} <> '')`;
      }
    })
    .join(' AND ');
}

export function macros(cfg: MatchConfig): string[] {
  const re = `^(\\d{1,4})[-/.]([A-Za-z]{3}|\\d{1,2})[-/.](\\d{1,4})(?:[ T](\\d{1,2}):(\\d{2})(?::(\\d{2}))?)?$`;
  const ord = lit(cfg.dateOrder);
  return [
    `CREATE OR REPLACE MACRO cm_parts(s) AS regexp_extract(${trimWs("coalesce(s, '')")}, '${re}', ['a','b','c','h','mi','se'])`,
    `CREATE OR REPLACE MACRO cm_mk(y, m, d, h, mi, se) AS CASE WHEN m BETWEEN 1 AND 12 AND d BETWEEN 1 AND 31 AND h <= 23 AND mi <= 59 AND se <= 59 ` +
      `THEN try_strptime(printf('%04d-%02d-%02d %02d:%02d:%02d', y, m, d, h, mi, se), '%Y-%m-%d %H:%M:%S') END`,
    `CREATE OR REPLACE MACRO cm_i(x) AS TRY_CAST(x AS INTEGER)`,
    `CREATE OR REPLACE MACRO cm_mon(b) AS list_position(['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'], upper(b))`,
    `CREATE OR REPLACE MACRO cm_d2(p) AS CASE
       WHEN p.a = '' THEN NULL
       WHEN length(p.a) = 4 THEN CASE WHEN regexp_matches(p.b, '[A-Za-z]') OR length(p.c) > 2 THEN NULL
            ELSE cm_mk(cm_i(p.a), cm_i(p.b), cm_i(p.c), coalesce(cm_i(nullif(p.h, '')), 0), coalesce(cm_i(nullif(p.mi, '')), 0), coalesce(cm_i(nullif(p.se, '')), 0)) END
       WHEN length(p.c) <> 4 THEN NULL
       WHEN regexp_matches(p.b, '[A-Za-z]') THEN CASE WHEN ${ord} = 'YMD' THEN NULL
            ELSE cm_mk(cm_i(p.c), cm_mon(p.b), cm_i(p.a), coalesce(cm_i(nullif(p.h, '')), 0), coalesce(cm_i(nullif(p.mi, '')), 0), coalesce(cm_i(nullif(p.se, '')), 0)) END
       WHEN ${ord} = 'MDY' THEN cm_mk(cm_i(p.c), cm_i(p.a), cm_i(p.b), coalesce(cm_i(nullif(p.h, '')), 0), coalesce(cm_i(nullif(p.mi, '')), 0), coalesce(cm_i(nullif(p.se, '')), 0))
       WHEN ${ord} = 'DMY' THEN cm_mk(cm_i(p.c), cm_i(p.b), cm_i(p.a), coalesce(cm_i(nullif(p.h, '')), 0), coalesce(cm_i(nullif(p.mi, '')), 0), coalesce(cm_i(nullif(p.se, '')), 0))
       ELSE NULL END`,
    `CREATE OR REPLACE MACRO cm_date(s) AS cm_d2(cm_parts(s))`,
  ];
}

export interface SqlPlan {
  setup: string[];
  exportSql: string;
  countSql: string;
  statsSql: string[];
  dupReportSql: string;
  header: string[];
}

function sel(t: string, pol: DupPolicy, where: string, keepBlank: boolean): string {
  if (pol === 'all') return `SELECT * FROM ${t} WHERE ${where}`;
  const order =
    pol === 'last' ? '__f DESC, __r DESC' : pol === 'newest' ? '__d DESC NULLS LAST, __f, __r' : '__f, __r';
  const keyed = `SELECT * FROM ${t} WHERE ${where} AND __k IS NOT NULL QUALIFY row_number() OVER (PARTITION BY __k ORDER BY ${order}) = 1`;
  return keepBlank ? `${keyed} UNION ALL SELECT * FROM ${t} WHERE ${where} AND __k IS NULL` : keyed;
}

/**
 * @param regNames fileId -> name the file is registered under in DuckDB
 */
export function buildPlan(files: FileMeta[], regNames: Record<string, string>, cfg: MatchConfig, out: OutputConfig): SqlPlan {
  const A = files.filter((f) => f.group === 'A');
  const B = files.filter((f) => f.group === 'B');
  const aCols = out.columns.filter((c) => c.kind === 'field' && c.group === 'A');
  const bCols = out.columns.filter((c) => c.kind === 'field' && c.group === 'B');
  const join = cfg.bCombine === 'join';

  const groupTable = (name: string, group: FileMeta[], cols: OutputColumn[], pol: DupPolicy) => {
    const selects = group.map((f, fi) => {
      const kIdx = (cfg.keyColumns[f.id] ?? []).map((c) => f.headers.indexOf(c));
      const parts = kIdx.map((i) => (i < 0 ? "''" : normExpr(`c${i}`, cfg)));
      const key =
        parts.length === 1
          ? `nullif(${parts[0]}, '')`
          : `CASE WHEN ${parts.map((p) => `${p} = ''`).join(' OR ')} THEN NULL ELSE ${parts.join(" || chr(31) || ")} END`;
      const dc = cfg.dateColumns[f.id];
      const di = dc ? f.headers.indexOf(dc) : -1;
      const date = pol === 'newest' && di >= 0 ? `cm_date(c${di})` : 'NULL::TIMESTAMP';
      const fields = cols.map((c, ci) => {
        if (join && c.group === 'B' && c.fromFile && c.fromFile !== f.id) return `NULL::VARCHAR AS f${ci}`;
        const i = resolveIndex(f, c);
        return i < 0 ? `NULL::VARCHAR AS f${ci}` : `coalesce(c${i}, '') AS f${ci}`;
      });
      return (
        `SELECT ${fi}::INTEGER AS __f, row_number() OVER () AS __r, ${key} AS __k, ${date} AS __d, ` +
        `(${filterExpr(cfg.filters, f)}) AS __ok${fields.length ? ', ' + fields.join(', ') : ''} FROM ${readCsv(f, regNames[f.id])}`
      );
    });
    return `CREATE OR REPLACE TABLE ${name} AS ${selects.map((s) => `(${s})`).join(' UNION ALL ')}`;
  };

  const setup = [
    ...macros(cfg),
    groupTable('cm_a', A, aCols, cfg.dupA),
    groupTable('cm_b', B, bCols, cfg.dupB),
    `CREATE OR REPLACE TABLE cm_ac AS SELECT __k, count(*) AS n FROM cm_a WHERE __ok AND __k IS NOT NULL GROUP BY __k`,
    `CREATE OR REPLACE TABLE cm_bc AS SELECT __k, count(*) AS n FROM cm_b WHERE __ok AND __k IS NOT NULL GROUP BY __k`,
  ];

  const mv = lit(out.missingValue);
  const aNames = `[${A.map((f) => lit(f.name)).join(', ')}]`;
  const bNames = `[${B.map((f) => lit(f.name)).join(', ')}]`;
  const header = out.columns.map((c) => c.label);
  const fieldPos = (c: OutputColumn, list: OutputColumn[]) => list.indexOf(c);

  let exportSql: string;
  if (cfg.operation === 'b_not_a') {
    const cols = out.columns.map((c, i) => {
      let e: string;
      if (c.kind === 'field') e = c.group === 'A' ? mv : `coalesce(s.f${fieldPos(c, bCols)}, ${mv})`;
      else
        switch (c.meta) {
          case 'match_key': e = `coalesce(replace(s.__k, chr(31), ' | '), '')`; break;
          case 'match_status': e = `CASE WHEN s.__k IS NULL THEN 'BLANK KEY' ELSE 'NOT IN GROUP A' END`; break;
          case 'source_file_a': e = `''`; break;
          case 'source_file_b': e = `list_extract(${bNames}, s.__f + 1)`; break;
          case 'count_a': e = `'0'`; break;
          case 'count_b': e = `CASE WHEN s.__k IS NULL THEN '' ELSE cnt.n::VARCHAR END`; break;
          case 'row_number_a': e = `''`; break;
          case 'row_number_b': e = `s.__r::VARCHAR`; break;
          default: e = `''`;
        }
      return `${e} AS o${i}`;
    });
    exportSql =
      `WITH bo AS (SELECT * FROM cm_b WHERE __ok AND (__k IS NULL OR __k NOT IN (SELECT __k FROM cm_ac))), ` +
      `cnt AS (SELECT __k, count(*) AS n FROM bo WHERE __k IS NOT NULL GROUP BY __k), ` +
      `s AS (${sel('bo', cfg.dupB, 'true', true)}) ` +
      `SELECT ${cols.join(', ')} FROM s LEFT JOIN cnt ON cnt.__k = s.__k ORDER BY s.__f, s.__r`;
  } else {
    const bAliases = join ? B.map((_, j) => `b${j}`) : ['b'];
    const bCtes = join
      ? B.map((_, j) => `b${j} AS (${sel('cm_b', cfg.dupB, `__ok AND __f = ${j}`, false)})`)
      : [`b AS (${sel('cm_b', cfg.dupB, '__ok', false)})`];
    const cols = out.columns.map((c, i) => {
      let e: string;
      if (c.kind === 'field') {
        if (c.group === 'A') e = `coalesce(a.f${fieldPos(c, aCols)}, ${mv})`;
        else e = `coalesce(${bAliases.map((b) => `${b}.f${fieldPos(c, bCols)}`).join(', ')}, ${mv})`;
      } else
        switch (c.meta) {
          case 'match_key': e = `coalesce(replace(a.__k, chr(31), ' | '), '')`; break;
          case 'match_status': e = `CASE WHEN a.__k IS NULL THEN 'BLANK KEY' WHEN bc.n IS NOT NULL THEN 'MATCHED' ELSE 'NOT FOUND' END`; break;
          case 'source_file_a': e = `list_extract(${aNames}, a.__f + 1)`; break;
          case 'source_file_b':
            e = join
              ? `coalesce(concat_ws('; ', ${B.map((f, j) => `CASE WHEN b${j}.__k IS NOT NULL THEN ${lit(f.name)} END`).join(', ')}), '')`
              : `CASE WHEN b.__k IS NULL THEN '' ELSE list_extract(${bNames}, b.__f + 1) END`;
            break;
          case 'count_a': e = `CASE WHEN a.__k IS NULL THEN '' ELSE ac.n::VARCHAR END`; break;
          case 'count_b': e = `coalesce(bc.n, 0)::VARCHAR`; break;
          case 'row_number_a': e = `a.__r::VARCHAR`; break;
          case 'row_number_b':
            e = join
              ? `coalesce(concat_ws('; ', ${bAliases.map((b) => `${b}.__r::VARCHAR`).join(', ')}), '')`
              : `coalesce(b.__r::VARCHAR, '')`;
            break;
          default: e = `''`;
        }
      return `${e} AS o${i}`;
    });
    const where =
      cfg.operation === 'common' ? 'bc.n IS NOT NULL' : cfg.operation === 'a_not_b' ? 'bc.n IS NULL' : 'true';
    const joins = bAliases.map((b) => `LEFT JOIN ${b} ON ${b}.__k = a.__k`).join(' ');
    const order = ['a.__f', 'a.__r', ...(join ? [] : ['b.__f', 'b.__r'])].join(', ');
    exportSql =
      `WITH a AS (${sel('cm_a', cfg.dupA, '__ok', true)}), ${bCtes.join(', ')} ` +
      `SELECT ${cols.join(', ')} FROM a ${joins} LEFT JOIN cm_ac ac ON ac.__k = a.__k LEFT JOIN cm_bc bc ON bc.__k = a.__k ` +
      `WHERE ${where} ORDER BY ${order}`;
  }

  const bOnlyMode = cfg.operation === 'b_not_a';
  const cartesian = cfg.dupA === 'all' && cfg.dupB === 'all' && !join;
  const statsSql = [
    `SELECT
      (SELECT count(*) FROM cm_a) AS a_rows,
      (SELECT count(*) FROM cm_b) AS b_rows,
      (SELECT count(*) FROM cm_a WHERE NOT __ok) AS a_filtered,
      (SELECT count(*) FROM cm_b WHERE NOT __ok) AS b_filtered,
      (SELECT count(*) FROM cm_a WHERE __ok AND __k IS NULL) AS a_blank,
      (SELECT count(*) FROM cm_b WHERE __ok AND __k IS NULL) AS b_blank,
      (SELECT count(*) FROM cm_ac) AS a_keys,
      (SELECT count(*) FILTER (WHERE n > 1) FROM cm_ac) AS a_dup_keys,
      (SELECT coalesce(sum(n - 1), 0) FROM cm_ac) AS a_dup_rows,
      (SELECT count(*) FROM cm_ac JOIN cm_bc USING (__k)) AS matched,
      (SELECT count(*) FROM cm_bc) AS b_keys,
      (SELECT count(*) FILTER (WHERE bc.n > 1) FROM cm_bc bc ${bOnlyMode ? '' : 'JOIN cm_ac USING (__k)'}) AS b_dup_keys,
      (SELECT coalesce(sum(bc.n - 1), 0) FROM cm_bc bc ${bOnlyMode ? '' : 'JOIN cm_ac USING (__k)'}) AS b_dup_rows,
      (SELECT ${cartesian ? 'count(*) FROM cm_ac JOIN cm_bc USING (__k) WHERE cm_ac.n > 1 AND cm_bc.n > 1' : '0'}) AS cartesian,
      (SELECT ${cfg.dupA === 'newest' ? "count(*) FROM cm_a WHERE __ok AND __k IS NOT NULL AND __d IS NULL" : '0'}) +
      (SELECT ${cfg.dupB === 'newest' ? `count(*) FROM cm_b WHERE __ok AND __k IS NOT NULL AND __d IS NULL AND __k ${bOnlyMode ? 'NOT IN' : 'IN'} (SELECT __k FROM cm_ac)` : '0'}) AS bad_dates`,
  ];

  const dupReportSql =
    `SELECT replace(__k, chr(31), ' | ') AS k, ` +
    `CASE WHEN ac.n IS NULL THEN 'B only' WHEN bc.n IS NULL THEN 'A only' ELSE 'A and B' END AS g, ` +
    `coalesce(ac.n, 0)::VARCHAR AS na, coalesce(bc.n, 0)::VARCHAR AS nb ` +
    `FROM cm_ac ac FULL JOIN cm_bc bc USING (__k) WHERE (coalesce(ac.n, 0) > 1 OR coalesce(bc.n, 0) > 1) ` +
    (bOnlyMode ? '' : 'AND ac.n IS NOT NULL ') +
    `ORDER BY 1`;

  return { setup, exportSql, countSql: `SELECT count(*) AS n FROM (${exportSql})`, statsSql, dupReportSql, header };
}

/**
 * A self-contained DuckDB script for the optional offline tool (python/offline_matcher.py
 * or the duckdb CLI). CSV paths are the plain file names, resolved from the folder the
 * script runs in. Loading is single-threaded so record numbers follow file order.
 */
export function buildOfflineScript(
  files: FileMeta[],
  cfg: MatchConfig,
  out: OutputConfig,
  outputName: string,
  delimiter: string,
  paths: Record<string, string> = {}, // fileId -> CSV file name on disk (Excel sheets: their saved CSV copy)
): string {
  const reg = Object.fromEntries(files.map((f) => [f.id, paths[f.id] ?? f.name]));
  const plan = buildPlan(files, reg, cfg, out);
  const ident = (s: string) => '"' + s.replace(/"/g, '""') + '"';
  const cols = plan.header.map((h, i) => `o${i} AS ${ident(h)}`).join(', ');
  return [
    '-- Consumer CSV Matcher: offline job generated ' + new Date().toISOString(),
    '-- Run:  python offline_matcher.py job.sql --data-dir <folder with the CSV files>',
    '-- Files: ' + files.map((f) => `${f.group}: ${reg[f.id]}`).join(' | '),
    ...(files.some((f) => f.source)
      ? ['-- Excel sheets: save each one with the "CSV" button on the Upload step (it uses the file name listed above).']
      : []),
    'SET preserve_insertion_order = true;',
    'SET threads = 1;',
    ...plan.setup.map((s) => s + ';'),
    'RESET threads;',
    `COPY (SELECT ${cols} FROM (${plan.exportSql})) TO ${lit(outputName)} (HEADER, DELIMITER ${lit(delimiter)}, QUOTE '"');`,
    '',
  ].join('\n\n');
}

export function missingWarnings(files: FileMeta[], cfg: MatchConfig, out: OutputConfig): string[] {
  const res: string[] = [];
  for (const c of out.columns) {
    if (c.kind !== 'field') continue;
    for (const f of files.filter((x) => x.group === c.group)) {
      if (cfg.bCombine === 'join' && c.group === 'B' && c.fromFile && c.fromFile !== f.id) continue;
      if (resolveIndex(f, c) < 0)
        res.push(`"${c.label}" is not present in ${f.name}; "${out.missingValue || '(blank)'}" will be written for its rows.`);
    }
  }
  return res;
}

/** Turns the row returned by statsSql[0] (+ the exact output count) into AnalysisStats. */
export function statsFromRow(s: Record<string, unknown>, outputRows: unknown, files: FileMeta[], cfg: MatchConfig, out: OutputConfig, ms: number): AnalysisStats {
  const num = (v: unknown) => Number(v ?? 0);
  const bOnly = cfg.operation === 'b_not_a';
  return {
    engine: 'B',
    aRows: num(s.a_rows),
    bRows: num(s.b_rows),
    aUniqueKeys: num(s.a_keys),
    bUniqueKeys: bOnly ? num(s.b_keys) : -1,
    matchedKeys: num(s.matched),
    unmatchedAKeys: num(s.a_keys) - num(s.matched),
    unmatchedBKeys: bOnly ? num(s.b_keys) - num(s.matched) : -1,
    aDuplicateKeys: num(s.a_dup_keys),
    aDuplicateRows: num(s.a_dup_rows),
    bDuplicateKeys: num(s.b_dup_keys),
    bDuplicateRows: num(s.b_dup_rows),
    aBlankKeys: num(s.a_blank),
    bBlankKeys: num(s.b_blank),
    aFiltered: num(s.a_filtered),
    bFiltered: num(s.b_filtered),
    malformedRows: -1,
    badDates: num(s.bad_dates),
    expectedOutputRows: num(outputRows),
    cartesianKeys: num(s.cartesian),
    missingFieldWarnings: missingWarnings(files, cfg, out),
    analyzeMs: ms,
  };
}
