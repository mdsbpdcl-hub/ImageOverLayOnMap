// End-to-end browser benchmark: drives the built app in real (headless) Chrome
// exactly as a user would — upload, choose columns, analyse, export — and checks
// the downloaded file against the generator's ground truth.
//
//   npm run build && npm run bench:browser -- --data test-data/1L --mode A
//
// Needs Google Chrome/Chromium (set CHROME_PATH if not at /usr/bin/google-chrome).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer, { type Page } from 'puppeteer-core';

function arg(name: string, def: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}
const DATA = path.resolve(arg('data', 'test-data/tiny'));
const MODE = arg('mode', 'A');
const PORT = +arg('port', '4173');
const BASE = arg('base', '/');
const HOST = arg('host', 'localhost');
const OUT_JSON = path.resolve(arg('json', 'bench-results/browser.json'));
const CANCEL_TEST = process.argv.includes('--cancel-test');
const manifest = JSON.parse(fs.readFileSync(path.join(DATA, 'manifest.json'), 'utf8'));

const step = (s: string) => console.error(`[e2e ${new Date().toISOString().slice(11, 19)}] ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function clickText(page: Page, text: string) {
  await page.locator(`::-p-text(${text})`).click();
}

async function waitFor(page: Page, fn: string, timeout = 3_600_000) {
  await page.waitForFunction(fn, { timeout, polling: 500 });
}

async function main() {
  step('starting preview server');
  // --external-server: use an already running static server (e.g. one mimicking GitHub Pages)
  const server = process.argv.includes('--external-server') ? null : spawn(process.execPath, [path.resolve('node_modules/vite/bin/vite.js'), 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`http://${HOST}:${PORT}${BASE}`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (i > 100) throw new Error('preview server did not start');
    await sleep(200);
  }
  step('server up');
  const dl = fs.mkdtempSync('/tmp/cm-dl-');
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--no-proxy-server', '--enable-precise-memory-info', '--js-flags=--max-old-space-size=4096'],
    protocolTimeout: 3_600_000,
  });
  let sampler: NodeJS.Timeout | undefined;
  const result: Record<string, unknown> = { data: path.basename(DATA), mode: MODE, groupA: manifest.groupA.rows, groupB: manifest.groupB.rows };
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    const cdp = await page.createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl, eventsEnabled: true } as any);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    step('open app');
    await page.goto(`http://${HOST}:${PORT}${BASE}`, { waitUntil: 'networkidle0' });

    // main-thread responsiveness probe: longest gap between 50 ms timer ticks
    await page.evaluate(() => {
      (window as any).__lag = 0;
      let last = performance.now();
      setInterval(() => {
        const now = performance.now();
        (window as any).__lag = Math.max((window as any).__lag, now - last - 50);
        last = now;
      }, 50);
    });

    // sample JS heap of the page and its workers via DevTools protocol (measurement only)
    let peakHeap = 0;
    sampler = setInterval(async () => {
      try {
        let total = 0;
        for (const w of page.workers()) {
          const u = await (w as any).client.send('Runtime.getHeapUsage');
          total += u.usedSize;
        }
        const m = await cdp.send('Runtime.getHeapUsage' as any) as any;
        total += m.usedSize;
        peakHeap = Math.max(peakHeap, total);
      } catch {
        /* worker may be gone */
      }
    }, 250);
    step('upload');
    // 1 · Upload
    const t0 = Date.now();
    const inputs = await page.$$('input[type=file]');
    await (inputs[0] as any).uploadFile(...manifest.groupA.files.map((f: string) => path.join(DATA, f)));
    await (inputs[1] as any).uploadFile(...manifest.groupB.files.map((f: string) => path.join(DATA, f)));
    const nFiles = manifest.groupA.files.length + manifest.groupB.files.length;
    const settled = (n: number) =>
      `document.querySelectorAll('.tag.good').length + document.querySelectorAll('.tag.bad').length >= ${n} && ` +
      `!document.body.innerText.match(/\\bConverting\\b|\\bCounting\\b|\\bReading\\b/)`;
    await waitFor(page, settled(nFiles));
    if (process.argv.includes('--all-sheets')) {
      // Excel workbooks with several sheets: add the remaining sheets as separate files
      for (;;) {
        const clicked = await page.evaluate(() => {
          const b = Array.from(document.querySelectorAll('button')).find((x) => /^\+ add \d+ more sheet/.test(x.textContent ?? ''));
          if (b) (b as HTMLButtonElement).click();
          return !!b;
        });
        if (!clicked) break;
        await sleep(1000);
        await waitFor(page, settled(1));
      }
    }
    const bad = await page.$$eval('.tag.bad', (t) => t.length);
    if (bad) throw new Error('A file could not be read: ' + (await page.$eval('.warn-list', (w) => w.textContent)));
    result.importMs = Date.now() - t0;
    result.countedRows = await page.$$eval('td.num', (tds) => tds.map((t) => t.textContent));

    step('matching');
    // 2 · Matching (key columns are auto-detected: Consumer ID / CA Number / CA No / Account No)
    await clickText(page, 'Next: Match');
    await sleep(300);
    const chosen = await page.$$eval('tbody select', (s) => (s as HTMLSelectElement[]).map((x) => x.value));
    result.autoKeys = chosen;

    step('output');
    // 3 · Output columns
    await clickText(page, 'Next: Columns');
    await sleep(300);
    const tick = async (group: 'A' | 'B', name: string) => {
      await page.evaluate((group, name) => {
        const blocks = Array.from(document.querySelectorAll('.avail > div'));
        const block = blocks.find((b) => b.querySelector('.grp')?.textContent?.startsWith(`GROUP ${group}`))!;
        const label = Array.from(block.querySelectorAll('label')).find((l) => l.querySelector('span')?.textContent === name)!;
        (label.querySelector('input') as HTMLInputElement).click();
      }, group, name);
      await sleep(50);
    };
    await tick('A', 'Consumer ID');
    await tick('A', 'Division');
    await tick('B', 'Consumer Name');
    await tick('B', 'Mobile');
    await tick('B', 'Arrear');
    await page.evaluate(() => {
      const l = Array.from(document.querySelectorAll('.avail label')).find((x) => x.textContent?.startsWith('Source File (B)'))!;
      (l.querySelector('input') as HTMLInputElement).click();
    });
    await sleep(100);
    // per-file mapping: "Consumer Name" -> "Name" and "Mobile" -> "Mobile No" in master_2
    await page.evaluate(() => {
      for (const sel of Array.from(document.querySelectorAll('.perfile select')) as HTMLSelectElement[]) {
        const row = sel.closest('.sel-row')!;
        const src = row.querySelector('.src')!.textContent;
        const want = src === 'Consumer Name' ? 'Name' : src === 'Mobile' ? 'Mobile No' : null;
        if (want && Array.from(sel.options).some((o) => o.value === want)) {
          const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
          setter.call(sel, want);
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    });
    await sleep(200);

    step('process');
    // 4 · Process
    await clickText(page, 'Next: Process');
    await sleep(300);
    if (MODE === 'B') await clickText(page, 'SQL engine (DuckDB)');
    await page.evaluate(() => ((window as any).__lag = 0));
    const tA = Date.now();
    await clickText(page, 'Start analysis');
    if (CANCEL_TEST) {
      await sleep(1500);
      await clickText(page, 'Cancel');
      await waitFor(page, `document.body.innerText.includes('cancelled')`, 30_000);
      result.cancelRecovered = true;
      await clickText(page, 'Start analysis');
    }
    await waitFor(page, `document.body.innerText.includes('Go to results') || document.querySelector('.note.err')`);
    result.analyzeWallMs = Date.now() - tA;
    const err = await page.$eval('body', (b) => b.querySelector('.note.err')?.textContent ?? null);
    if (err) throw new Error('Analysis failed in browser: ' + err);
    const stats = await page.$$eval('.stat', (els) => Object.fromEntries(els.map((e) => [e.querySelector('.k')!.textContent, e.querySelector('.v')!.textContent])));
    result.stats = stats;
    result.maxUiLagMsDuringAnalysis = Math.round(await page.evaluate(() => (window as any).__lag));

    step('export');
    // 5 · Export (browser download)
    await clickText(page, 'Go to results');
    await sleep(500);
    await page.evaluate(() => {
      const sel = Array.from(document.querySelectorAll('label.field')).find((l) => l.textContent?.startsWith('Save to'))?.querySelector('select') as HTMLSelectElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(sel, 'download');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sleep(200);
    await page.evaluate(() => ((window as any).__lag = 0));
    const tE = Date.now();
    await page.evaluate(() => (Array.from(document.querySelectorAll('button')).find((b) => /^\s*Export [\d,]+ rows/.test(b.textContent ?? ''))! as HTMLButtonElement).click());
    await waitFor(page, `document.body.innerText.includes('rows exported') || document.querySelector('.note.err')`);
    const exportErr = await page.$eval('body', (b) => b.querySelector('.note.err')?.textContent ?? null);
    if (exportErr) throw new Error('Export failed in browser: ' + exportErr);
    // wait for the download to land
    let file = '';
    for (let i = 0; i < 3600; i++) {
      const fs_ = fs.readdirSync(dl);
      file = fs_.find((f) => f.endsWith('.csv')) ?? '';
      if (file && !fs_.some((f) => f.endsWith('.crdownload'))) break;
      await sleep(500);
    }
    result.exportWallMs = Date.now() - tE;
    result.maxUiLagMsDuringExport = Math.round(await page.evaluate(() => (window as any).__lag));
    result.exportNote = await page.$eval('.note.ok, .note.warn', (n) => n.textContent);

    step('verify');
    // verify: count rows and check IDs kept exactly
    const outPath = path.join(dl, file);
    const text = fs.readFileSync(outPath, 'utf8');
    let lines = 0, quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 34) quoted = !quoted;
      else if (c === 10 && !quoted) lines++;
    }
    const dataRows = lines - 1;
    const leadingZeroIds = (text.match(/\r\n00\d{12},/g) ?? []).length;
    result.outputBytes = fs.statSync(outPath).size;
    result.outputRows = dataRows;
    result.expectedRows = manifest.expected.commonFirstFirst;
    result.correctRowCount = dataRows === manifest.expected.commonFirstFirst;
    result.leadingZeroIdsPreserved = leadingZeroIds;
    result.header = text.slice(0, 200).split('\r\n')[0];
    clearInterval(sampler);
    result.peakJsHeapMB = Math.round(peakHeap / 1048576);
    result.pageErrors = errors;
    result.totalMs = Date.now() - t0;
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    result.failure = String(e);
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } finally {
    clearInterval(sampler);
    await browser.close();
    server?.kill();
    fs.rmSync(dl, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
    const all = fs.existsSync(OUT_JSON) ? JSON.parse(fs.readFileSync(OUT_JSON, 'utf8')) : [];
    all.push({ at: new Date().toISOString(), ...result });
    fs.writeFileSync(OUT_JSON, JSON.stringify(all, null, 2));
  }
}

main();
