// Output encoding: CSV escaping with spreadsheet-formula protection, and a
// streaming XLSX writer (inline strings, so IDs stay text in Excel).

import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import type { ExportOptions } from './types';

const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** True when Excel/Sheets could evaluate the value as a formula. */
export function isFormulaLike(v: string): boolean {
  if (!v) return false;
  const c = v.charCodeAt(0);
  if (c === 61 /* = */ || c === 64 /* @ */ || c === 9 || c === 13) return true;
  if (c === 43 /* + */ || c === 45 /* - */) return !NUMERIC.test(v); // keep -125.50 and +919876543210 as they are
  return false;
}

export class CsvEncoder {
  guarded = 0;
  private readonly d: string;
  private readonly needs: RegExp;
  constructor(private readonly opts: Pick<ExportOptions, 'delimiter' | 'formulaGuard'>) {
    this.d = opts.delimiter;
    const esc = this.d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    this.needs = new RegExp(`["\\r\\n${esc}]`);
  }
  field(v: string): string {
    if (this.opts.formulaGuard && isFormulaLike(v)) {
      this.guarded++;
      v = "'" + v;
    }
    // also quote leading/trailing spaces so no reader trims them away
    if (this.needs.test(v) || (v.length && (v.charCodeAt(0) === 32 || v.charCodeAt(v.length - 1) === 32)))
      return '"' + v.replace(/"/g, '""') + '"';
    return v;
  }
  line(values: string[]): string {
    let s = '';
    for (let i = 0; i < values.length; i++) {
      if (i) s += this.d;
      s += this.field(values[i]);
    }
    return s + '\r\n';
  }
}

// XML 1.0 forbids most control characters.
const XML_BAD = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;
export const XLSX_MAX_ROWS = 1_048_576;
const XLSX_MAX_CELL = 32_767;

function xmlEsc(v: string): string {
  return v.replace(XML_BAD, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function colName(i: number): string {
  let s = '';
  i++;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

/**
 * Streaming XLSX writer. Rows are pushed into a deflate stream; compressed bytes
 * are handed to `emit` as they are produced, so the workbook is never held whole.
 */
export class XlsxStreamWriter {
  private zip: Zip;
  private sheet: ZipDeflate;
  private pending: Uint8Array[] = [];
  private enc = new TextEncoder();
  private buf: string[] = [];
  private bufLen = 0;
  private rowNo = 0;
  truncatedCells = 0;
  guarded = 0;
  private done!: Promise<void>;

  constructor(
    private readonly emit: (b: Uint8Array) => Promise<void>,
    _formulaGuard: boolean, // XLSX inline strings are never evaluated, nothing to guard
    private readonly sheetName = 'Result',
  ) {
    let resolveDone!: () => void;
    let rejectDone!: (e: Error) => void;
    this.done = new Promise((res, rej) => {
      resolveDone = res;
      rejectDone = rej;
    });
    this.zip = new Zip((err, data, final) => {
      if (err) return rejectDone(err);
      this.pending.push(data);
      if (final) resolveDone();
    });
    const add = (name: string, xml: string) => {
      const f = new ZipPassThrough(name);
      this.zip.add(f);
      f.push(this.enc.encode(xml), true);
    };
    add(
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    );
    add(
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    );
    add(
      'xl/workbook.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEsc(this.sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    );
    add(
      'xl/_rels/workbook.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    );
    add(
      'xl/styles.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf/><xf fontId="1" applyFont="1"/><xf numFmtId="49" applyNumberFormat="1"/></cellXfs></styleSheet>',
    );
    this.sheet = new ZipDeflate('xl/worksheets/sheet1.xml', { level: 3 });
    this.zip.add(this.sheet);
    this.raw(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>',
    );
  }

  private raw(s: string) {
    this.buf.push(s);
    this.bufLen += s.length;
  }

  async row(values: string[], header = false): Promise<void> {
    if (this.rowNo >= XLSX_MAX_ROWS) throw new Error('XLSX row limit (1,048,576) exceeded');
    this.rowNo++;
    let s = `<row r="${this.rowNo}">`;
    for (let i = 0; i < values.length; i++) {
      let v = values[i] ?? '';
      if (v.length > XLSX_MAX_CELL) {
        v = v.slice(0, XLSX_MAX_CELL);
        this.truncatedCells++;
      }
      // inline strings are never evaluated as formulas, so no value needs altering here
      s += `<c r="${colName(i)}${this.rowNo}" t="inlineStr"${header ? ' s="1"' : ' s="2"'}><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
    }
    this.raw(s + '</row>');
    if (this.bufLen > 1 << 20) await this.flush(false);
  }

  private async flush(final: boolean) {
    const s = this.buf.join('');
    this.buf = [];
    this.bufLen = 0;
    this.sheet.push(this.enc.encode(s), final);
    await this.drain();
  }

  private async drain() {
    while (this.pending.length) {
      const b = this.pending.shift()!;
      await this.emit(b);
    }
  }

  async close(): Promise<void> {
    this.raw('</sheetData></worksheet>');
    await this.flush(true);
    this.zip.end();
    await this.done;
    await this.drain();
  }
}
