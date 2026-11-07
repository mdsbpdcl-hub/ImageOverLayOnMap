// Shared types for the matching engines (Mode A worker and Mode B DuckDB).
// Everything here is plain data so it can be posted to a Web Worker.

export type Group = 'A' | 'B';
export type Encoding = 'utf-8' | 'windows-1252' | 'utf-16le' | 'utf-16be';

export interface FileMeta {
  id: string;
  group: Group;
  name: string;
  size: number;
  delimiter: string; // ',', ';', '\t', '|'
  encoding: Encoding;
  headers: string[]; // de-duplicated header names as shown in the UI
  rawHeaders: string[];
  rows?: number; // physical data rows (excludes header) once counted
  status: 'reading' | 'converting' | 'counting' | 'ready' | 'error';
  error?: string;
  warnings: string[];
  /** set when the data comes from an Excel worksheet (converted to a temporary CSV) */
  source?: { kind: 'xlsx'; workbook: string; sheet: string; sheetPath: string; origSize: number };
  /** records end with a mix of lone CR and LF characters (old Mac + Windows/Unix line endings) */
  mixedNewlines?: boolean;
  /** Excel only: headings of columns that contain cells stored as numbers */
  numericColumns?: string[];
}

export interface NormalizeOptions {
  trim: boolean; // trim leading/trailing whitespace
  collapseSpaces: boolean; // collapse internal runs of whitespace into one space
  ignoreCase: boolean; // case-insensitive
  stripLeadingZeros: boolean; // "000123" == "123" (off by default)
}

/** How to choose rows when a key repeats inside one group. */
export type DupPolicy = 'first' | 'last' | 'all' | 'newest' | 'unique';

export type Operation = 'common' | 'a_not_b' | 'b_not_a' | 'a_with_status';

/** union: all Group B files form one logical dataset.
 *  join:  each Group B file is joined separately (one row per key per file) so
 *         different files contribute different fields to the same output row. */
export type BCombine = 'union' | 'join';

export type DateOrder = 'DMY' | 'MDY' | 'YMD';

export interface FilterRule {
  id: string;
  group: Group;
  column: string; // logical column (header name)
  op: 'equals' | 'not_equals' | 'contains' | 'starts_with' | 'blank' | 'not_blank';
  value: string;
}

export interface MatchConfig {
  /** For every file: the ordered list of columns that form its key (composite keys = several). */
  keyColumns: Record<string, string[]>;
  normalize: NormalizeOptions;
  operation: Operation;
  dupA: DupPolicy;
  dupB: DupPolicy;
  /** date column per file, used by the 'newest' policy */
  dateColumns: Record<string, string>;
  dateOrder: DateOrder;
  bCombine: BCombine;
  allowCartesian: boolean; // must be true to allow dupA='all' together with dupB='all'
  filters: FilterRule[];
}

export type MetaKind =
  | 'match_key'
  | 'match_status'
  | 'source_file_a'
  | 'source_file_b'
  | 'count_a'
  | 'count_b'
  | 'row_number_a'
  | 'row_number_b';

export interface OutputColumn {
  id: string;
  kind: 'field' | 'meta';
  group?: Group; // for fields
  column?: string; // logical header (for fields)
  /** per-file override: fileId -> header in that file (different headings across files) */
  perFile?: Record<string, string>;
  /** join mode: take this field only from one B file */
  fromFile?: string;
  meta?: MetaKind;
  label: string; // output heading
}

export interface OutputConfig {
  columns: OutputColumn[];
  missingValue: string; // value written when a selected field does not exist / no match
  warnOnMissing: boolean;
}

export interface ExportOptions {
  format: 'csv' | 'xlsx';
  fileName: string; // base name without extension
  delimiter: string;
  bom: boolean; // write UTF-8 BOM (helps Excel show Hindi/Unicode correctly)
  formulaGuard: boolean; // neutralise values Excel could run as formulas
  splitRows: number; // 0 = no splitting
  target: 'file' | 'directory' | 'download';
}

export interface Progress {
  stage: string;
  file?: string;
  rowsDone: number;
  rowsTotal?: number; // only when known
  bytesDone?: number;
  bytesTotal?: number;
  percent?: number; // only when measurable
  elapsedMs: number;
}

export interface AnalysisStats {
  aRows: number;
  bRows: number;
  aUniqueKeys: number;
  bUniqueKeys: number; // unique B keys seen (all, matched or not) when tracked
  matchedKeys: number; // unique keys present in both groups
  unmatchedAKeys: number;
  unmatchedBKeys: number;
  aDuplicateKeys: number; // keys occurring >1 time in A
  aDuplicateRows: number; // extra rows beyond first
  bDuplicateKeys: number;
  bDuplicateRows: number;
  aBlankKeys: number;
  bBlankKeys: number;
  aFiltered: number;
  bFiltered: number;
  malformedRows: number;
  badDates: number;
  expectedOutputRows: number;
  cartesianKeys: number; // keys with >1 row on both sides that will multiply
  missingFieldWarnings: string[];
  analyzeMs: number;
  engine: 'A' | 'B';
  peakHeapMB?: number;
}

export interface ExportResult {
  files: { name: string; rows: number; bytes: number; url?: string }[];
  rows: number;
  ms: number;
  warnings: string[];
}

export interface IssueRow {
  file: string;
  record: number;
  issue: string;
  detail: string;
}

export const KEY_SEP = '\u001f';
