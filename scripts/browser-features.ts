// Feature test in real Chrome: every export path and option, both engines, compared
// with each other and with the engine run directly in Node on the same files.
//
//   npm run build && npx tsx scripts/browser-features.ts
//
// Save As / folder pickers cannot be clicked in an automated browser, so they are
// replaced by functions returning real file/folder handles in the browser's private
// storage — the app's own writing code (createWritable) is exercised unchanged.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer, { type Page } from 'puppeteer-core';
import { unzipSync, strFromU8 } from 'fflate';
import { MatchEngine, type EngineFile } from '../src/engine/core';
import { memoryFactory } from '../src/engine/sink';
import type { ExportOptions, FileMeta, MatchConfig, OutputConfig } from '../src/engine/types';

const DATA = path.resolve('test-data/features');
const PORT = 4175;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log('[features]', ...a);
const results: { check: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ check: name, ok, detail });
  log(ok ? 'PASS' : 'FAIL', name, detail ?? '');
};

async function clickButton(page: Page, re: RegExp) {
  const ok = await page.evaluate((src) => {
    const r = new RegExp(src);
    const b = Array.from(document.querySelectorAll('button')).find((x) => r.test((x.textContent ?? '').trim()) && !(x as HTMLButtonElement).disabled);
    if (b) (b as HTMLButtonElement).click();
    return !!b;
  }, re.source);
  if (!ok) throw new Error('button not found/enabled: ' + re);
}
const waitFor = (page: Page, fn: string, timeout = 120_000) => page.waitForFunction(fn, { timeout, polling: 200 });

async function opfsText(page: Page, dir: string, name: string): Promise<string> {
  return page.evaluate(async (dir, name) => {
    const root = await navigator.storage.getDirectory();
    const d = await root.getDirectoryHandle(dir);
    return (await (await d.getFileHandle(name)).getFile()).text();
  }, dir, name);
}
async function opfsBytes(page: Page, dir: string, name: string): Promise<Uint8Array> {
  const arr: number[] = await page.evaluate(async (dir, name) => {
    const root = await navigator.storage.getDirectory();
    const d = await root.getDirectoryHandle(dir);
    return Array.from(new Uint8Array(await (await (await d.getFileHandle(name)).getFile()).arrayBuffer()));
  }, dir, name);
  return new Uint8Array(arr);
}

async function upload(page: Page) {
  const inputs = await page.$$('input[type=file]');
  await (inputs[0] as any).uploadFile(path.join(DATA, 'targets.csv'));
  await (inputs[1] as any).uploadFile(...['master_crlf.csv', 'master_ansi.csv', 'master_mixed.csv'].map((f) => path.join(DATA, f)));
  await waitFor(page, `document.querySelectorAll('.tag.good').length === 4`);
}

async function analyse(page: Page, mode: 'A' | 'B') {
  await page.evaluate((m) => (window as any).__cm.setMode(m), mode);
  await sleep(150);
  await clickButton(page, /Analyse and check/);
  await sleep(150);
  await clickButton(page, /^(Start analysis|Run again)$/);
  await waitFor(page, `(document.body.innerText.includes('Go to results') && !document.body.innerText.includes('building preview')) || !!document.querySelector('.note.err')`);
  const err = await page.$eval('body', (b) => b.querySelector('.note.err')?.textContent ?? null);
  if (err) throw new Error(`analysis (${mode}) failed: ${err}`);
}

async function exportTo(page: Page, opts: Partial<ExportOptions>) {
  await clickButton(page, /Preview and save/);
  await sleep(200);
  await page.evaluate((o) => {
    const w = window as any;
    w.__cm.setExportOpts({ ...w.__cm.exportOpts, ...o });
  }, opts);
  await sleep(200);
  const before = await page.$$eval('.note.ok, .note.warn', (n) => n.filter((x) => x.textContent?.includes('rows exported')).length);
  await clickButton(page, /^Export [\d,]+ rows$/);
  await waitFor(page, `document.querySelectorAll('.note').length && (Array.from(document.querySelectorAll('.note.ok, .note.warn')).filter((x) => x.textContent.includes('rows exported')).length > ${before} || !!document.querySelector('.card .note.err'))`);
  const err = await page.$eval('body', (b) => b.querySelector('.card .note.err')?.textContent ?? null);
  if (err) throw new Error('export failed: ' + err);
}

function nodeRun(metas: FileMeta[], cfg: MatchConfig, out: OutputConfig, opts: ExportOptions) {
  const files: EngineFile[] = metas.map((m) => ({ meta: m, blob: new Blob([fs.readFileSync(path.join(DATA, m.name))]) }));
  return (async () => {
    const e = new MatchEngine(files, cfg, out, { progress: () => {}, cancelled: () => false, chunkBytes: 1 << 16 });
    await e.analyze();
    const f = memoryFactory();
    await e.export(f, { ...opts, splitRows: 0, format: 'csv' });
    return f.blobs!.values().next().value!.text();
  })();
}

async function main() {
  const server = spawn(process.execPath, [path.resolve('node_modules/vite/bin/vite.js'), 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch { /* starting */ }
    if (i > 100) throw new Error('server did not start');
    await sleep(200);
  }
  const dl = fs.mkdtempSync('/tmp/cm-feat-');
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--no-proxy-server'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000 });
    const cdp = await page.createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl } as any);
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await page.evaluateOnNewDocument(() => {
      (window as any).showSaveFilePicker = async (o: any) => {
        const root = await navigator.storage.getDirectory();
        const d = await root.getDirectoryHandle('e2e-save', { create: true });
        return d.getFileHandle(o.suggestedName, { create: true });
      };
      (window as any).showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('e2e-folder', { create: true });
    });
    await page.goto(`http://localhost:${PORT}/?e2e`, { waitUntil: 'networkidle0' });

    // ---------------- upload: encodings and line endings detected
    await upload(page);
    const metas: FileMeta[] = await page.evaluate(() => (window as any).__cm.metas);
    const byName = (n: string) => metas.find((m) => m.name === n)!;
    check('ANSI file detected as Windows-1252', byName('master_ansi.csv').encoding === 'windows-1252');
    check('Mixed line endings detected', byName('master_mixed.csv').mixedNewlines === true && !byName('master_crlf.csv').mixedNewlines);
    check('Key columns auto-detected for all files', await page.evaluate(() => Object.values((window as any).__cm.cfg.keyColumns).filter((k: any) => k[0]).length === 4));

    // ---------------- output structure (with per-file mapping and all extra columns)
    const id = (n: string) => byName(n).id;
    const out: OutputConfig = {
      columns: [
        { id: 'c1', kind: 'field', group: 'A', column: 'Consumer ID', label: 'Consumer ID' },
        { id: 'c2', kind: 'field', group: 'A', column: 'Division', label: 'Division' },
        { id: 'c3', kind: 'field', group: 'B', column: 'Consumer Name', label: 'Name', perFile: { [id('master_ansi.csv')]: 'Name' } },
        { id: 'c4', kind: 'field', group: 'B', column: 'Address', label: 'Address' },
        { id: 'c5', kind: 'field', group: 'B', column: 'Mobile', label: 'Mobile', perFile: { [id('master_ansi.csv')]: 'Mobile No' } },
        { id: 'c6', kind: 'field', group: 'B', column: 'Arrear', label: 'Outstanding' },
        { id: 'c7', kind: 'field', group: 'B', column: 'Last Payment Date', label: 'Paid On' },
        ...(['match_key', 'match_status', 'source_file_a', 'source_file_b', 'count_a', 'count_b', 'row_number_a', 'row_number_b'] as const).map(
          (m) => ({ id: m, kind: 'meta' as const, meta: m, label: m }),
        ),
      ],
      missingValue: 'NA',
      warnOnMissing: true,
    };
    await page.evaluate((o) => (window as any).__cm.setOut(o), out);
    await sleep(200);

    const dateCols = Object.fromEntries(metas.filter((m) => m.group === 'B').map((m) => [m.id, 'Last Payment Date']));
    const scenarios: { name: string; patch: Partial<MatchConfig> }[] = [
      { name: 'common, first/first', patch: {} },
      { name: 'all A with status, keep all × keep all', patch: { operation: 'a_with_status', dupA: 'all', dupB: 'all', allowCartesian: true } },
      { name: 'B not in A, newest', patch: { operation: 'b_not_a', dupB: 'newest', dateColumns: dateCols } },
      { name: 'A not in B, ignore case + leading zeros', patch: { operation: 'a_not_b', normalize: { trim: true, collapseSpaces: true, ignoreCase: true, stripLeadingZeros: true } } },
      { name: 'join side by side, last, B filter', patch: { bCombine: 'join', dupB: 'last', filters: [{ id: 'f', group: 'B', column: 'Arrear', op: 'starts_with', value: '1' }] } },
    ];
    const baseCfg: MatchConfig = await page.evaluate(() => (window as any).__cm.cfg);
    const exportBase: ExportOptions = await page.evaluate(() => (window as any).__cm.exportOpts);
    let n = 0;
    for (const sc of scenarios) {
      n++;
      const cfg = { ...baseCfg, ...sc.patch };
      await page.evaluate((c) => (window as any).__cm.setCfg(c), cfg);
      await sleep(200);
      const texts: Record<string, string> = {};
      for (const mode of ['A', 'B'] as const) {
        await analyse(page, mode);
        await exportTo(page, { target: 'file', format: 'csv', fileName: `s${n}_${mode}` });
        texts[mode] = await opfsText(page, 'e2e-save', `s${n}_${mode}.csv`);
      }
      const want = await nodeRun(metas, cfg, out, { ...exportBase, fileName: 'x' });
      const rows = want.split('\r\n').length - 2;
      check(`[${sc.name}] Mode A file = Mode B file (Save As)`, texts.A === texts.B, `${rows} rows`);
      check(`[${sc.name}] browser = engine run in Node`, texts.A === want);
    }

    // ---------------- XLSX via Save As
    await page.evaluate((c) => (window as any).__cm.setCfg(c), baseCfg);
    await sleep(200);
    await analyse(page, 'A');
    await exportTo(page, { target: 'file', format: 'xlsx', fileName: 'book' });
    const xl = unzipSync(await opfsBytes(page, 'e2e-save', 'book.xlsx'));
    const sheet = strFromU8(xl['xl/worksheets/sheet1.xml']);
    const csvA = await opfsText(page, 'e2e-save', 's1_A.csv');
    const csvRows = csvA.split('\r\n').length - 2;
    check('XLSX export: valid workbook with same row count as CSV', (sheet.match(/<row /g) ?? []).length - 1 === csvRows, `${csvRows} rows`);
    check('XLSX export: IDs are text cells with leading zeros', /<t xml:space="preserve">00\d{12}<\/t>/.test(sheet));

    // ---------------- folder target, both engines
    for (const mode of ['A', 'B'] as const) {
      await analyse(page, mode);
      await exportTo(page, { target: 'directory', format: 'csv', fileName: `folder_${mode}` });
      const t = await opfsText(page, 'e2e-folder', `folder_${mode}.csv`);
      check(`Folder export (${mode}) = Save As result`, t === csvA);
    }

    // ---------------- browser download + reports + summary (Mode A)
    await analyse(page, 'A');
    await exportTo(page, { target: 'download', format: 'csv', fileName: 'dl' });
    await clickButton(page, /Duplicate report/);
    await sleep(1500);
    await clickButton(page, /Data issue report/);
    await sleep(1500);
    await clickButton(page, /Matching summary/);
    await sleep(2500);
    const got = fs.readdirSync(dl);
    // Blob.text() in the page drops the UTF-8 BOM, Node keeps it: compare without it
    const dlText = got.includes('dl.csv') ? fs.readFileSync(path.join(dl, 'dl.csv'), 'utf8').replace(/^\uFEFF/, '') : '';
    check('Download export file', dlText === csvA, `files: ${got.join(', ')}; size ${dlText.length} vs ${csvA.length}`);
    check('Duplicate report downloaded', got.includes('dl_duplicates.csv') && fs.statSync(path.join(dl, 'dl_duplicates.csv')).size > 30);
    check('Data issue report downloaded', got.includes('dl_issues.csv'));
    check('Summary downloaded', got.includes('dl_summary.csv') && fs.readFileSync(path.join(dl, 'dl_summary.csv'), 'utf8').includes('Result rows'));
    // Mode B duplicate report = Mode A duplicate report (as sets)
    await analyse(page, 'B');
    await clickButton(page, /Preview and save/);
    await page.evaluate(() => { const w = window as any; w.__cm.setExportOpts({ ...w.__cm.exportOpts, fileName: 'dlB' }); });
    await sleep(200);
    await clickButton(page, /Duplicate report/);
    await sleep(2000);
    const dupA = fs.readFileSync(path.join(dl, 'dl_duplicates.csv'), 'utf8').split('\r\n').slice(1).sort().join('\n');
    const dupB = fs.existsSync(path.join(dl, 'dlB_duplicates.csv')) ? fs.readFileSync(path.join(dl, 'dlB_duplicates.csv'), 'utf8').split('\r\n').slice(1).sort().join('\n') : 'missing';
    check('Duplicate report: Mode A = Mode B', dupA === dupB);

    // ---------------- cancel + recover (Mode B, includes UTF-8 preparation)
    await page.evaluate(() => (window as any).__cm.setMode('B'));
    await clickButton(page, /Analyse and check/);
    await sleep(100);
    await clickButton(page, /^(Start analysis|Run again)$/);
    await sleep(30);
    await clickButton(page, /Cancel/).catch(() => {});
    await sleep(2500);
    await analyse(page, 'B');
    check('Cancel then run again works (Mode B)', true);

    // ---------------- templates survive a reload
    await clickButton(page, /Keys and rules/);
    await sleep(200);
    await page.type('input[placeholder="Template name"]', 'My template');
    await clickButton(page, /^Save$/);
    const cfgBefore = await page.evaluate(() => JSON.stringify((window as any).__cm.cfg.keyColumns && Object.values((window as any).__cm.cfg.keyColumns)));
    await page.reload({ waitUntil: 'networkidle0' });
    await upload(page);
    await clickButton(page, /Next: Match/);
    await sleep(200);
    await page.evaluate(() => (window as any).__cm.setCfg({ ...(window as any).__cm.cfg, keyColumns: {} }));
    await sleep(200);
    await clickButton(page, /^Apply$/);
    await sleep(300);
    const after = await page.evaluate(() => ({ keys: JSON.stringify(Object.values((window as any).__cm.cfg.keyColumns)), labels: (window as any).__cm.out.columns.map((c: any) => c.label) }));
    check('Template restores key columns after reload', after.keys === cfgBefore);
    check('Template restores output columns', JSON.stringify(after.labels) === JSON.stringify(out.columns.map((c) => c.label)));

    // ---------------- clear temporary data removes copies
    await clickButton(page, /Analyse and check/);
    await analyse(page, 'B');
    await clickButton(page, /Preview and save/);
    await sleep(200);
    await clickButton(page, /Clear temporary data/);
    await sleep(2500);
    const left = await page.evaluate(async () => {
      const names: string[] = [];
      const root = await navigator.storage.getDirectory();
      for await (const [n] of (root as any).entries()) names.push(n);
      return names;
    });
    check('Clear temporary data removes export and conversion copies', !left.includes('csv-matcher-exports') && !left.includes('csv-matcher-converted'), left.join(','));

    check('No JavaScript errors on the page', pageErrors.length === 0, pageErrors.join(' | '));
  } catch (e) {
    check('test run completed', false, String(e));
  } finally {
    await browser.close();
    server.kill();
    fs.rmSync(dl, { recursive: true, force: true });
    const failed = results.filter((r) => !r.ok);
    log(`${results.length - failed.length}/${results.length} checks passed`);
    fs.mkdirSync('bench-results', { recursive: true });
    fs.writeFileSync('bench-results/browser-features.json', JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
    process.exitCode = failed.length ? 1 : 0;
  }
}

main();
