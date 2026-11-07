import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { classifyFormat, convertSheetToCsv, formatNumber, readWorkbook, serialToDate, xmlText } from '../src/engine/xlsx';
import { CsvStreamParser } from '../src/engine/csv';
import { MatchEngine } from '../src/engine/core';
import { memoryFactory, RowWriter } from '../src/engine/sink';
import { baseCfg, exportOpts, hooks, makeFile } from './helpers';

async function toCsv(blob: Blob, sheetPath: string) {
  const parts: Uint8Array[] = [];
  const res = await convertSheetToCsv(blob, sheetPath, async (b) => void parts.push(b));
  const text = new TextDecoder().decode(await new Blob(parts as BlobPart[]).arrayBuffer());
  const rows: string[][] = [];
  const p = new CsvStreamParser(',', (r) => rows.push(r));
  p.push(text, true);
  return { res, rows, text };
}

function fixture(name: string) {
  return new Blob([fs.readFileSync(path.join(__dirname, 'fixtures', name))]);
}

describe('xlsx helpers', () => {
  it('formats numbers like Excel stores them, without exponent notation', () => {
    expect(formatNumber('123456789012')).toBe('123456789012');
    expect(formatNumber('1.23456789012E+11')).toBe('123456789012');
    expect(formatNumber('0.30000000000000004')).toBe('0.3');
    expect(formatNumber('-125.5')).toBe('-125.5');
    expect(formatNumber('1E-7')).toBe('0.0000001');
    expect(formatNumber('1.234567890123457e+18')).toBe('1234567890123460000');
    expect(formatNumber('-1E+16')).toBe('-10000000000000000');
  });
  it('converts date serials (1900 and 1904 systems)', () => {
    expect(serialToDate(45356, false, { time: false, dateOnly: true })).toBe('2024-03-05');
    expect(serialToDate(45291.4375, false, { time: true, dateOnly: false })).toBe('2023-12-31 10:30:00');
    expect(serialToDate(43894, true, { time: false, dateOnly: true })).toBe('2024-03-05');
  });
  it('classifies number formats', () => {
    expect(classifyFormat(14, undefined).kind).toBe('date');
    expect(classifyFormat(164, 'dd/mm/yyyy').kind).toBe('date');
    expect(classifyFormat(165, '[$-409]d-mmm-yy;@').kind).toBe('date');
    expect(classifyFormat(166, '000000000000')).toEqual({ kind: 'zeros', width: 12 });
    expect(classifyFormat(167, '#,##0.00 "kWh"').kind).toBe('general');
    expect(classifyFormat(168, '0.00E+00').kind).toBe('general');
    expect(classifyFormat(169, '[Red]#,##0').kind).toBe('general');
  });
  it('decodes XML and Excel escapes', () => {
    expect(xmlText('a &amp; b &lt;c&gt; &#x928; _x000D_x')).toBe('a & b <c> न \rx');
  });
});

describe('openpyxl workbook', () => {
  it('lists sheets with hidden state', async () => {
    const wb = await readWorkbook(fixture('openpyxl-sample.xlsx'));
    expect(wb.sheets.map((s) => [s.name, s.hidden])).toEqual([['Consumers', false], ['Second', false], ['Hidden', true]]);
  });
  it('converts every kind of cell exactly', async () => {
    const blob = fixture('openpyxl-sample.xlsx');
    const wb = await readWorkbook(blob);
    const { res, rows } = await toCsv(blob, wb.sheets[0].path);
    expect(rows).toEqual([
      ['Consumer ID', 'Name', 'Arrear', 'Last Payment', 'Meter', 'Active', 'Note'],
      ['00123456789012', 'Ram, Kumar', '-125.5', '2024-03-05', '123456789012', 'TRUE', 'He said "hi"\nnext line'],
      ['100000007920', 'राम', '0.3', '2023-12-31 10:30:00', '1234567890123460000', 'FALSE', ''],
      ['000000004567', '', '', '', '', '', 'tail'],
      ['X1', '', '0.0000001', '', '3', '', ''],
    ]);
    expect(res.rows).toBe(4);
    expect(res.numericColumns).toEqual(['Consumer ID', 'Arrear', 'Last Payment', 'Meter']);
    expect(res.warnings.join(' ')).toMatch(/"Meter" has 1 number/);
    expect(res.warnings.join(' ')).toMatch(/1 formula cell/);
  });
});

// Hand-built workbook: namespace prefixes, inline strings, rich text, missing r= refs,
// 1904 dates, self-closing cells/rows, error and formula-string cells.
function handMade(): Blob {
  const ns = 'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<Types/>'),
    'xl/workbook.xml': strToU8(`<x:workbook ${ns}><x:workbookPr date1904="1"/><x:sheets><x:sheet name="Data &amp; More" sheetId="1" r:id="rId7"/></x:sheets></x:workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId7" Target="/xl/worksheets/data.xml" Type="ws"/></Relationships>'),
    'xl/styles.xml': strToU8('<x:styleSheet><x:numFmts count="1"><x:numFmt numFmtId="170" formatCode="dd\\-mm\\-yyyy"/></x:numFmts><x:cellXfs count="2"><x:xf numFmtId="0"/><x:xf numFmtId="170" applyNumberFormat="1"/></x:cellXfs></x:styleSheet>'),
    'xl/sharedStrings.xml': strToU8('<x:sst><x:si><x:t>CA No</x:t></x:si><x:si><x:r><x:t>Ra</x:t></x:r><x:r><x:rPr/><x:t xml:space="preserve">m </x:t></x:r><x:rPh><x:t>ignored</x:t></x:rPh></x:si><x:si/></x:sst>'),
    'xl/worksheets/data.xml': strToU8(
      `<x:worksheet ${ns}><x:sheetData>` +
        '<x:row r="1"><x:c t="s"><x:v>0</x:v></x:c><x:c t="inlineStr"><x:is><x:t>Name</x:t></x:is></x:c><x:c t="inlineStr"><x:is><x:t>Paid On</x:t></x:is></x:c><x:c t="inlineStr"><x:is><x:t>Calc</x:t></x:is></x:c></x:row>' +
        '<x:row r="2"/>' +
        '<x:row r="3"><x:c r="A3" t="str"><x:f>A1</x:f><x:v>0012</x:v></x:c><x:c r="B3" t="s"><x:v>1</x:v></x:c><x:c r="C3" s="1"><x:v>43894</x:v></x:c><x:c r="D3" t="e"><x:v>#N/A</x:v></x:c></x:row>' +
        '<x:row r="4"><x:c r="D4" t="s"><x:v>2</x:v></x:c><x:c r="B4"/></x:row>' +
        '<x:row r="5"><x:c r="A5" t="inlineStr"><x:is><x:t>L&amp;T</x:t></x:is></x:c></x:row>' +
        '</x:sheetData></x:worksheet>',
    ),
  };
  return new Blob([zipSync(files, { level: 6 })]);
}

describe('hand-made workbook', () => {
  it('handles prefixes, rich text, inline strings, 1904 dates and sparse cells', async () => {
    const blob = handMade();
    const wb = await readWorkbook(blob);
    expect(wb.sheets).toEqual([{ name: 'Data & More', path: 'xl/worksheets/data.xml', hidden: false }]);
    expect(wb.date1904).toBe(true);
    const { rows, res } = await toCsv(blob, wb.sheets[0].path);
    expect(rows).toEqual([
      ['CA No', 'Name', 'Paid On', 'Calc'],
      ['0012', 'Ram ', '2024-03-05', '#N/A'],
      ['L&T', '', '', ''],
    ]);
    expect(res.rows).toBe(2); // row 4 has only empty values and is skipped
  });

  it('rejects non-xlsx input with a clear message', async () => {
    await expect(readWorkbook(new Blob(['ID,Name\n1,a\n']))).rejects.toThrow(/not a valid \.xlsx/);
  });
});

describe('Excel input end-to-end through the engine', () => {
  it('matches a converted Excel sheet against a CSV file', async () => {
    const blob = handMade();
    const { text } = await toCsv(blob, 'xl/worksheets/data.xml');
    const a = makeFile('a', 'A', 'targets.csv', 'Consumer\r\n12\r\n0012\r\nL&T\r\n');
    const b = makeFile('b', 'B', 'book.xlsx › Data', text);
    const cfg = baseCfg({ keyColumns: { a: ['Consumer'], b: ['CA No'] } });
    const out = {
      columns: [
        { id: '1', kind: 'field' as const, group: 'A' as const, column: 'Consumer', label: 'Consumer' },
        { id: '2', kind: 'field' as const, group: 'B' as const, column: 'Paid On', label: 'Paid On' },
        { id: '3', kind: 'meta' as const, meta: 'source_file_b' as const, label: 'Source' },
      ],
      missingValue: '',
      warnOnMissing: true,
    };
    const e = new MatchEngine([a, b], cfg, out, hooks());
    await e.analyze();
    const f = memoryFactory();
    await e.export(f, exportOpts);
    expect(await f.blobs!.get('out.csv')!.text()).toBe('Consumer,Paid On,Source\r\n0012,2024-03-05,book.xlsx › Data\r\nL&T,,book.xlsx › Data\r\n');
    void RowWriter;
  });
});
