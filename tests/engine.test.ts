import { describe, it, expect } from 'vitest';
import { CsvStreamParser, countRecords, detectDelimiter, cleanHeaders, detectEncoding } from '../src/engine/csv';
import { makeKeyBuilder, parseDate } from '../src/engine/normalize';
import { CsvEncoder, isFormulaLike } from '../src/engine/writer';
import { MatchEngine } from '../src/engine/core';
import { memoryFactory } from '../src/engine/sink';
import { unzipSync, strFromU8 } from 'fflate';
import type { DupPolicy, MatchConfig, Operation, OutputConfig, OutputColumn } from '../src/engine/types';
import { baseCfg, csv, exportOpts, hooks, makeFile, reference, runEngine } from './helpers';

function parseAll(text: string, d = ',', chunk = 7) {
  const rows: string[][] = [];
  const p = new CsvStreamParser(d, (r) => rows.push(r));
  for (let i = 0; i < text.length; i += chunk) p.push(text.slice(i, i + chunk));
  p.finish();
  return rows;
}

describe('CSV parser', () => {
  it('handles quotes, escaped quotes, multiline cells and mixed newlines at any chunk boundary', () => {
    const text = 'id,name,note\r\n001,"Ram, Kumar","line1\nline2"\n002,"He said ""hi""",x\r003,,\r\n\r\n004,"",end';
    const expected = [
      ['id', 'name', 'note'],
      ['001', 'Ram, Kumar', 'line1\nline2'],
      ['002', 'He said "hi"', 'x'],
      ['003', '', ''],
      ['004', '', 'end'],
    ];
    for (let chunk = 1; chunk <= text.length; chunk++) expect(parseAll(text, ',', chunk)).toEqual(expected);
  });

  it('supports semicolon and tab delimiters and detects them', () => {
    expect(detectDelimiter('a;b;c\n1;2;3\n')).toBe(';');
    expect(detectDelimiter('a\tb\n1\t2\n')).toBe('\t');
    expect(detectDelimiter('a,b\n"1;2",3\n')).toBe(',');
    expect(parseAll('a;b\n1;"x;y"\n', ';')).toEqual([['a', 'b'], ['1', 'x;y']]);
  });

  it('never converts identifiers', () => {
    const rows = parseAll('id\n00012345678901234567\n1E5\n9.90\n');
    expect(rows.slice(1).map((r) => r[0])).toEqual(['00012345678901234567', '1E5', '9.90']);
  });

  it('counts records exactly like the parser (quote aware)', async () => {
    const text = 'h1,h2\n1,"a\nb"\r\n2,x\n\n3,"q""\n"\n4,y';
    const n = await countRecords(new Blob([text]), 'utf-8', ',', 3);
    expect(n).toBe(parseAll(text).length - 1);
  });

  it('cleans blank and duplicate headings', () => {
    expect(cleanHeaders(['ID', '', 'id', 'Name']).headers).toEqual(['ID', 'Column 2', 'id (2)', 'Name']);
  });

  it('detects encodings', () => {
    expect(detectEncoding(new Uint8Array([0xef, 0xbb, 0xbf, 65])).encoding).toBe('utf-8');
    expect(detectEncoding(new Uint8Array([0x41, 0xe9, 0x42])).encoding).toBe('windows-1252');
    expect(detectEncoding(new TextEncoder().encode('नमस्ते')).encoding).toBe('utf-8');
  });
});

describe('normalisation', () => {
  const o = { trim: true, collapseSpaces: true, ignoreCase: true, stripLeadingZeros: true };
  it('normalises according to options', () => {
    const k = makeKeyBuilder(o, [0]);
    expect(k(['  00ab  cd '])).toBe('AB CD');
    expect(k(['000'])).toBe('0');
    expect(makeKeyBuilder({ ...o, stripLeadingZeros: false }, [0])(['007'])).toBe('007');
  });
  it('blank or partially blank composite keys are blank', () => {
    const k = makeKeyBuilder(o, [0, 1]);
    expect(k(['1', ''])).toBe('');
    expect(k(['', ''])).toBe('');
    expect(k(['1', '2'])).toBe('1\u001f2');
  });
  it('parses dates per order', () => {
    expect(parseDate('05-01-2024', 'DMY')).toBe(Date.UTC(2024, 0, 5));
    expect(parseDate('05/01/2024', 'MDY')).toBe(Date.UTC(2024, 4, 1));
    expect(parseDate('2024-01-05 10:30', 'DMY')).toBe(Date.UTC(2024, 0, 5, 10, 30));
    expect(parseDate('05-Jan-2024', 'DMY')).toBe(Date.UTC(2024, 0, 5));
    expect(parseDate('31-02-2024', 'DMY')).toBeNaN();
    expect(parseDate('garbage', 'DMY')).toBeNaN();
  });
});

describe('CSV writer', () => {
  it('quotes correctly and guards formulas but keeps numbers', () => {
    const e = new CsvEncoder({ delimiter: ',', formulaGuard: true });
    expect(e.line(['a,b', 'x"y', 'l1\nl2', '=SUM(A1)', '-125.50', '+919876543210', '@cmd', '-x'])).toBe(
      '"a,b","x""y","l1\nl2",\'=SUM(A1),-125.50,+919876543210,\'@cmd,\'-x\r\n',
    );
    expect(isFormulaLike('0012')).toBe(false);
  });
});

// ---------------------------------------------------------------- engine scenarios
function fixture() {
  const a1 = csv([
    ['Consumer ID', 'Division'],
    ['C001', 'Patna'], ['C002', 'Gaya'], ['c003 ', 'Nalanda'], ['C001', 'Patna-2'], ['', 'Blank'], ['C009', 'Arrah'],
  ]);
  const b1 = csv([
    ['CA Number', 'Name', 'Mobile', 'Arrear', 'Updated'],
    ['C001', 'Ram', '9000000001', '100', '01-01-2024'],
    ['C002', 'Sita', '9000000002', '-25.5', '01-01-2024'],
    ['C001', 'Ram K', '9000000011', '150', '05-03-2024'],
    ['C777', 'Other', '9', '0', ''],
    ['', 'NoKey', '', '', ''],
  ]);
  const b2 = csv([
    ['CA No', 'Name', 'Mobile No', 'Load'],
    ['C003', 'Gita', '9000000003', '2kW'],
    ['C002', 'Sita Devi', '9000000022', '1kW'],
    ['C888', 'X', '', ''],
  ]);
  const files = [makeFile('a1', 'A', 'targets.csv', a1), makeFile('b1', 'B', 'master1.csv', b1), makeFile('b2', 'B', 'master2.csv', b2)];
  const texts = new Map([['a1', a1], ['b1', b1], ['b2', b2]]);
  const keyColumns = { a1: ['Consumer ID'], b1: ['CA Number'], b2: ['CA No'] };
  return { files, texts, keyColumns };
}

const col = (id: string, group: 'A' | 'B', column: string, label = column, extra: Partial<OutputColumn> = {}): OutputColumn => ({
  id, kind: 'field', group, column, label, ...extra,
});
const meta = (m: OutputColumn['meta'], label: string): OutputColumn => ({ id: 'm_' + m, kind: 'meta', meta: m, label });

describe('Mode A engine', () => {
  it('matches the specification example and preserves column order and headings', async () => {
    const { files, keyColumns } = fixture();
    const out: OutputConfig = {
      columns: [
        col('1', 'A', 'Consumer ID', 'CA Number'),
        col('2', 'A', 'Division'),
        col('3', 'B', 'Name'),
        col('4', 'B', 'Arrear', 'Outstanding Amount'),
      ],
      missingValue: '',
      warnOnMissing: true,
    };
    const r = await runEngine(files, baseCfg({ keyColumns }), out);
    expect(r.header).toEqual(['CA Number', 'Division', 'Name', 'Outstanding Amount']);
    expect(r.rows).toEqual([
      ['C001', 'Patna', 'Ram', '100'],
      ['C002', 'Gaya', 'Sita', '-25.5'],
    ]);
    expect(r.stats.aBlankKeys).toBe(1);
    expect(r.stats.matchedKeys).toBe(2); // c003 differs in case
    expect(r.stats.aDuplicateKeys).toBe(1);
    expect(r.stats.missingFieldWarnings.length).toBe(1); // Arrear not in master2
  });

  it('case-insensitive matching and per-file column mapping', async () => {
    const { files, keyColumns } = fixture();
    const out: OutputConfig = {
      columns: [col('1', 'A', 'Consumer ID'), col('2', 'B', 'Mobile', 'Mobile', { perFile: { b2: 'Mobile No' } }), meta('source_file_b', 'Source')],
      missingValue: 'NA',
      warnOnMissing: true,
    };
    const r = await runEngine(files, baseCfg({ keyColumns, normalize: { trim: true, collapseSpaces: false, ignoreCase: true, stripLeadingZeros: false } }), out);
    expect(r.rows).toEqual([
      ['C001', '9000000001', 'master1.csv'],
      ['C002', '9000000002', 'master1.csv'],
      ['c003 ', '9000000003', 'master2.csv'],
    ]);
  });

  it('refuses accidental cartesian multiplication unless allowed', async () => {
    const { files, keyColumns } = fixture();
    const out: OutputConfig = { columns: [col('1', 'A', 'Division'), col('2', 'B', 'Name')], missingValue: '', warnOnMissing: true };
    const e = new MatchEngine(files, baseCfg({ keyColumns, dupA: 'all', dupB: 'all' }), out, hooks());
    const s = await e.analyze();
    expect(s.cartesianKeys).toBe(1);
    expect(s.expectedOutputRows).toBe(2 * 2 + 1 * 2); // C001: 2 A rows x 2 B rows, C002: 1 x 2
    await expect(e.export(memoryFactory(), exportOpts)).rejects.toThrow(/multiplies rows/);
  });

  it('writes valid XLSX with text cells', async () => {
    const { files, keyColumns } = fixture();
    const out: OutputConfig = { columns: [col('1', 'A', 'Consumer ID'), col('2', 'B', 'Mobile')], missingValue: '', warnOnMissing: true };
    const e = new MatchEngine(files, baseCfg({ keyColumns }), out, hooks());
    await e.analyze();
    const f = memoryFactory();
    const res = await e.export(f, { ...exportOpts, format: 'xlsx' });
    expect(res.rows).toBe(2);
    const zip = unzipSync(new Uint8Array(await f.blobs!.get('out.xlsx')!.arrayBuffer()));
    const sheet = strFromU8(zip['xl/worksheets/sheet1.xml']);
    expect(sheet).toContain('<t xml:space="preserve">9000000001</t>');
    expect(sheet).toContain('t="inlineStr"');
  });

  it('splits large output into parts with headers', async () => {
    const { files, keyColumns } = fixture();
    const out: OutputConfig = { columns: [col('1', 'A', 'Consumer ID'), meta('match_status', 'Status')], missingValue: '', warnOnMissing: true };
    const e = new MatchEngine(files, baseCfg({ keyColumns, operation: 'a_with_status', dupA: 'all' }), out, hooks());
    await e.analyze();
    const f = memoryFactory();
    const res = await e.export(f, { ...exportOpts, splitRows: 2 });
    expect(res.rows).toBe(6);
    expect(res.files.map((x) => x.name)).toEqual(['out_part001.csv', 'out_part002.csv', 'out_part003.csv']);
    expect(await f.blobs!.get('out_part002.csv')!.text()).toBe('Consumer ID,Status\r\n"c003 ",NOT FOUND\r\nC001,MATCHED\r\n');
  });
});

// ---------------------------------------------------------------- randomised equivalence
function rnd(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

describe('randomised equivalence with reference implementation', () => {
  const ops: Operation[] = ['common', 'a_not_b', 'b_not_a', 'a_with_status'];
  const pols: DupPolicy[] = ['first', 'last', 'all', 'newest', 'unique'];
  let caseNo = 0;
  for (let seed = 1; seed <= 12; seed++) {
    it(`seed ${seed}`, async () => {
      const r = rnd(seed);
      const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
      const ids = Array.from({ length: 25 }, (_, i) => (r() < 0.2 ? '0' : '') + 'K' + i);
      const date = () => (r() < 0.1 ? 'bad' : `${1 + Math.floor(r() * 28)}-${1 + Math.floor(r() * 12)}-20${10 + Math.floor(r() * 15)}`);
      const mk = (n: number, hdr: string[], f: () => string[]) => csv([hdr, ...Array.from({ length: n }, f)]);
      const a1 = mk(40, ['ID', 'Zone', 'Dt'], () => [r() < 0.05 ? '' : pick(ids) + (r() < 0.1 ? ' ' : ''), 'z' + Math.floor(r() * 9), date()]);
      const a2 = mk(15, ['Zone', 'ID', 'Dt'], () => ['q' + Math.floor(r() * 9), pick(ids).toLowerCase(), date()]);
      const b1 = mk(50, ['CA', 'Name', 'Amt', 'When'], () => [pick(ids), 'n' + Math.floor(r() * 99), String(Math.floor(r() * 1000) - 500), date()]);
      const b2 = mk(30, ['Account', 'Name', 'Phone', 'When'], () => [r() < 0.05 ? '' : pick(ids), 'm' + Math.floor(r() * 99), '9' + Math.floor(r() * 1e9), date()]);
      const files = [makeFile('a1', 'A', 'a1.csv', a1), makeFile('a2', 'A', 'a2.csv', a2), makeFile('b1', 'B', 'b1.csv', b1), makeFile('b2', 'B', 'b2.csv', b2)];
      const texts = new Map([['a1', a1], ['a2', a2], ['b1', b1], ['b2', b2]]);
      for (let k = 0; k < 8; k++) {
        caseNo++;
        const bCombine = r() < 0.3 ? 'join' : 'union';
        const cfg: MatchConfig = baseCfg({
          keyColumns: { a1: ['ID'], a2: ['ID'], b1: ['CA'], b2: ['Account'] },
          normalize: { trim: r() < 0.5, collapseSpaces: false, ignoreCase: r() < 0.5, stripLeadingZeros: r() < 0.5 },
          operation: pick(ops),
          dupA: pick(pols),
          dupB: bCombine === 'join' ? pick(pols.filter((p) => p !== 'all')) : pick(pols),
          dateColumns: { a1: 'Dt', a2: 'Dt', b1: 'When', b2: 'When' },
          bCombine,
          allowCartesian: true,
          filters: r() < 0.4 ? [{ id: 'f', group: r() < 0.5 ? 'A' : 'B', column: r() < 0.5 ? 'Zone' : 'Name', op: pick(['contains', 'starts_with', 'not_equals', 'blank', 'not_blank', 'equals'] as const), value: r() < 0.5 ? 'Z1' : 'n1' }] : [],
        });
        const out: OutputConfig = {
          columns: [
            meta('match_key', 'Key'), col('1', 'A', 'ID'), col('2', 'A', 'Zone'), col('3', 'B', 'Name'),
            col('4', 'B', 'Amt'), col('5', 'B', 'Phone', 'Phone', bCombine === 'join' ? { fromFile: 'b2' } : {}),
            meta('match_status', 'S'), meta('count_a', 'CA'), meta('count_b', 'CB'), meta('source_file_a', 'FA'),
            meta('source_file_b', 'FB'), meta('row_number_a', 'RA'), meta('row_number_b', 'RB'),
          ],
          missingValue: '#',
          warnOnMissing: true,
        };
        const got = await runEngine(files, cfg, out, 1 + Math.floor(r() * 50));
        const want = reference(files, texts, cfg, out);
        expect({ caseNo, cfg: JSON.stringify(cfg), rows: got.rows }).toEqual({ caseNo, cfg: JSON.stringify(cfg), rows: want });
        expect(got.stats.expectedOutputRows).toBe(want.length);
      }
    });
  }
});

describe('line endings', () => {
  it('detects mixed lone-CR / LF record endings and normalises them at any chunk size', async () => {
    const { transcodeToUtf8 } = await import('../src/engine/csv');
    const text = 'a,b\r\nk1,"x\ry"\rk2,z\nk3,w\r';
    const le = { cr: 0, lf: 0, crlf: 0 };
    await countRecords(new Blob([text]), 'utf-8', ',', 3, undefined, undefined, le);
    expect(le).toEqual({ cr: 2, lf: 1, crlf: 1 });
    for (let c = 1; c <= text.length; c++) {
      const parts: Uint8Array[] = [];
      await transcodeToUtf8(new Blob([text]), 'utf-8', async (b) => void parts.push(b), { chunkBytes: c, normalizeNewlines: true });
      expect(await new Blob(parts as BlobPart[]).text()).toBe('a,b\r\nk1,"x\ry"\nk2,z\nk3,w\n');
    }
  });
});
