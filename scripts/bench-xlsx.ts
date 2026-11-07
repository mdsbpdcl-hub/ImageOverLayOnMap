// Excel conversion benchmark (Node): npm run bench:xlsx -- path/to/book.xlsx
import fs from 'node:fs';
import { convertSheetToCsv, readWorkbook } from '../src/engine/xlsx';

const file = process.argv[2];
let peak = 0;
const t = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 50);
const blob = await (fs as any).openAsBlob(file);
const t0 = Date.now();
const wb = await readWorkbook(blob);
for (const sh of wb.sheets) {
  const fd = fs.openSync('/tmp/xlsx-bench.csv', 'w');
  let bytes = 0;
  const r = await convertSheetToCsv(blob, sh.path, async (b) => { fs.writeSync(fd, b); bytes += b.length; });
  fs.closeSync(fd);
  console.log(JSON.stringify({ file, sheet: sh.name, xlsxMB: +(blob.size / 1048576).toFixed(1), rows: r.rows, csvMB: +(bytes / 1048576).toFixed(1), ms: Date.now() - t0, peakRssMB: Math.round(peak / 1048576), warnings: r.warnings.length }));
}
clearInterval(t);
