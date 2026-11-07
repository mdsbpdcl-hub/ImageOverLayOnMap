# Benchmark report

Measured on **7 November 2026**. All numbers below are actual measurements from the
runs recorded in [`bench-results/browser.json`](../bench-results/browser.json) and
[`bench-results/node.json`](../bench-results/node.json). No run failed; nothing
below is a target or an extrapolation.

## Test machine

| | |
|---|---|
| Computer | Cloud Linux VM — Intel Xeon @ 2.30 GHz, **2 vCPU**, **8 GB RAM**, SSD |
| OS | Linux 6.18 |
| Browser | Google Chrome for Testing **153.0.8010.12**, headless, driven by Puppeteer |
| Node.js | 22.23 (engine benchmark) |
| Python / DuckDB | 3.x / DuckDB 2.0.0 (offline cross-check) |
| App build | production build (`npm run build`), served locally |

A typical office laptop (4–8 cores, 8–16 GB RAM, Chrome/Edge) should be similar or
faster; slower disks or many open tabs will increase the times. Results on your own
computer can be produced with the commands at the end of this page.

## Datasets

Synthetic, fictitious consumer data from `scripts/generate-test-data.ts`: 12–14 digit
consumer numbers (≈15 % with leading zeros), English and Hindi names, addresses
containing commas, quotes and line breaks (≈5 % multiline), negative arrears, dates.
Group B is split over three files with **different headings** for the same fields
(`CA Number` / `CA No` / `Account No`, `Consumer Name` / `Name`, `Mobile` / `Mobile No`).

| Dataset | Group A rows (files) | Group B rows (files) | CSV size | Scenario |
|---|---|---|---|---|
| 1L | 20,000 (1) | 99,925 (3) | 8 MB | 60 % of targets match, 3 % duplicates |
| 5L | 1,00,000 (1) | 4,99,512 (3) | 42 MB | same |
| 10L | 2,00,000 (1) | 9,98,885 (3) | 84 MB | same |
| 20L | 4,00,000 (1) | 19,97,858 (3) | 168 MB | same |
| 50L | 10,00,000 (1) | 49,94,656 (3) | 421 MB | same |
| 10L-single | 2,00,000 (1) | 9,98,885 (**1**) | 100 MB | single-file workload |
| 50L-bigA | 10,00,000 (**2**) | 49,94,656 (3) | 421 MB | multiple Group A files |
| 10L-rare | 2,00,000 | 9,98,992 | 84 MB | **matches rare** (2 %) |
| 10L-most | 2,00,000 | 9,99,486 | 84 MB | **most match** (95 %) |
| 10L-dups | 2,00,000 | 9,09,678 | 77 MB | **many duplicates** (30 %) |

## 1. Full application in Chrome (user workflow)

Each run drives the real UI: upload all files → automatic key detection → choose
output columns (including per-file mapping of differently named columns) → analyse
→ export CSV by browser download → verify the downloaded file.
Settings: *common consumers*, keep first in both groups, trim spaces.

| Dataset | Engine | A rows (files) | B rows (files) | MB | Import¹ | Matching² | Export³ | Peak JS heap⁴ | Max UI stall⁵ (analyse / export) | Result rows | Correct⁶ |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1L | Mode A | 20,000 (1) | 99,925 (3) | 8 | 0.6 s | 0.14 s | 0.5 s | 16 MB | 1 / 2 ms | 11,668 | ✓ |
| 5L | Mode A | 1,00,000 (1) | 4,99,512 (3) | 42 | 0.6 s | 0.7 s | 1.0 s | 58 MB | 4 / 4 ms | 57,952 | ✓ |
| 10L | Mode A | 2,00,000 (1) | 9,98,885 (3) | 84 | 0.6 s | 1.2 s | 1.0 s | 120 MB | 1 / 3 ms | 1,16,528 | ✓ |
| 20L | Mode A | 4,00,000 (1) | 19,97,858 (3) | 168 | 1.1 s | 2.7 s | 1.5 s | 187 MB | 7 / 5 ms | 2,32,933 | ✓ |
| **50L** | **Mode A** | 10,00,000 (1) | 49,94,656 (3) | 421 | 1.6 s | **8.8 s** | 2.5 s | **348 MB** | 5 / 9 ms | 5,82,874 | ✓ |
| 10L-single | Mode A | 2,00,000 (1) | 9,98,885 (1) | 100 | 0.6 s | 1.5 s | 1.0 s | 99 MB | 7 / 3 ms | 1,16,528 | ✓ |
| 50L-bigA | Mode A | 10,00,000 (2) | 49,94,656 (3) | 421 | 1.6 s | 8.3 s | 2.5 s | 368 MB | 4 / 4 ms | 5,82,874 | ✓ |
| 10L-rare | Mode A | 2,00,000 | 9,98,992 | 84 | 0.6 s | 1.3 s | 1.0 s | 104 MB | 8 / 7 ms | 3,937 | ✓ |
| 10L-most | Mode A | 2,00,000 | 9,99,486 | 84 | 0.6 s | 1.4 s | 1.0 s | 125 MB | 7 / 7 ms | 1,84,344 | ✓ |
| 10L-dups | Mode A | 2,00,000 | 9,09,678 | 77 | 0.6 s | 1.2 s | 1.0 s | 121 MB | 3 / 0 ms | 83,959 | ✓ |
| 1L | Mode B | 20,000 | 99,925 | 8 | 0.6 s | 2.0 s | 1.0 s | 61 MB⁷ | 16 / 18 ms | 11,668 | ✓ |
| 5L | Mode B | 1,00,000 | 4,99,512 | 42 | 0.7 s | 3.0 s | 1.5 s | 55 MB⁷ | 32 / 15 ms | 57,952 | ✓ |
| 10L | Mode B | 2,00,000 | 9,98,885 | 84 | 0.6 s | 3.5 s | 2.0 s | 65 MB⁷ | 19 / 87 ms | 1,16,528 | ✓ |
| 20L | Mode B | 4,00,000 | 19,97,858 | 168 | 1.1 s | 4.5 s | 4.0 s | 72 MB⁷ | 7 / 131 ms | 2,32,933 | ✓ |
| 50L | Mode B | 10,00,000 | 49,94,656 | 421 | 1.6 s | 9.5 s | 8.0 s | 75 MB⁷ | 32 / 110 ms | 5,82,874 | ✓ |

1. Time from selecting the files until every file shows *Ready* (heading detection + exact, quote-aware row count in a worker).
2. Analysis time reported by the app: index building, matching, duplicate statistics and exact result-row count. Mode B includes loading DuckDB (first use) and the files into it.
3. Wall-clock time from pressing *Export* until the downloaded file is complete on disk (measured in 0.5 s polling steps).
4. Highest JavaScript heap of the page **plus its workers**, sampled every 250 ms through the Chrome DevTools protocol.
5. Longest delay of a 50 ms timer on the main thread while processing — a measure of UI responsiveness (under ~50 ms is not noticeable; 100–130 ms is a short hitch).
6. Downloaded file has exactly the number of rows given by the generator's ground truth; leading-zero IDs present unchanged (e.g. 87,452 such IDs in the 50L output); no page errors.
7. Mode B: JS heap only. DuckDB's WebAssembly memory is not included in this measurement.

**Cancellation and recovery.** On 20L, analysis was started, cancelled after 1.5 s,
and started again: the cancel was acknowledged, the UI stayed usable, and the second
run produced the correct 2,32,933 rows (run marked *cancel + rerun* in the JSON).
A defect found by this test (a delayed cancel check could stop the *next* run) was
fixed before the final runs.

**GitHub Pages layout.** The production build with `BASE_PATH=/consumer-csv-matcher/`
was served from that sub-path by a plain static server (as GitHub Pages does) and
the 5L workflow passed in both engines, including loading DuckDB-Wasm under the
strict Content-Security-Policy.

### Excel input

Workbooks made from the same generated data with openpyxl (IDs and mobiles as text
cells, arrears as numbers, payment dates as real Excel dates). *Import* now includes
converting every sheet to its temporary CSV copy.

| Dataset | Engine | Workbooks · sheets | Rows (A / B) | .xlsx size | Import incl. conversion | Matching | Export | Peak JS heap¹ | Result rows | Correct² |
|---|---|---|---|---|---|---|---|---|---|---|
| 10L-xlsx | Mode A | 2 · 2 (B in one 10-lakh-row sheet) | 2,00,000 / 9,98,885 | 60 MB | 17.1 s | 2.1 s | 1.0 s | 224 MB | 1,16,528 | ✓ |
| 10L-xlsx | Mode B | same | same | 60 MB | 16.6 s | 3.8 s | 2.5 s | 256 MB | 1,16,528 | ✓ |
| 20L-xlsx-sheets | Mode A | 3 · 4 (B: one workbook with 2 sheets + one with 1, added with “+ add more sheets”) | 4,00,000 / 19,97,858 | 109 MB | 29.1 s | 3.7 s | 1.5 s | 378 MB | 2,32,933 | ✓ |

1. Sampled from opening the page, so it includes the conversion.
2. Same result-row count **and** the same number of leading-zero IDs (17,272 / 34,769) as the CSV runs of the same data.

Engine-level (Node, `npm run bench:xlsx`): converting the 55 MB, 9,98,885-row sheet
took 16.8 s, produced a 92 MB CSV and peaked at 732 MB process memory. The converted
rows were compared with the source CSV: identical apart from number formatting
(`26541.20` → `26541.2`, as Excel stores it) and dates (`03-04-2021` → `2021-04-03`).

## 2. Engine benchmark (Node.js, same engine code)

`npm run bench` runs the Mode A engine directly on the files (disk-backed Blobs, 8 MB
chunks) and reports process memory (RSS, includes the Node runtime ≈ 50–80 MB).

| Dataset | Operation · duplicates A/B | A rows | B rows | MB | Count rows | Matching | Export | Peak RSS | Result rows | Correct |
|---|---|---|---|---|---|---|---|---|---|---|
| 1L | common · first/first | 20,000 | 99,925 | 8 | 0.1 s | 0.1 s | 0.1 s | 101 MB | 11,668 | ✓ |
| 5L | common · first/first | 1,00,000 | 4,99,512 | 42 | 0.2 s | 0.6 s | 0.2 s | 268 MB | 57,952 | ✓ |
| 10L | common · first/first | 2,00,000 | 9,98,885 | 84 | 0.3 s | 1.3 s | 0.4 s | 290 MB | 1,16,528 | ✓ |
| 20L | common · first/first | 4,00,000 | 19,97,858 | 168 | 0.6 s | 2.9 s | 0.8 s | 369 MB | 2,32,933 | ✓ |
| 50L | common · first/first | 10,00,000 | 49,94,656 | 421 | 1.3 s | 8.8 s | 2.2 s | 591 MB | 5,82,874 | ✓ |
| 10L-single | common · first/first | 2,00,000 | 9,98,885 | 100 | 0.3 s | 1.5 s | 0.3 s | 302 MB | 1,16,528 | ✓ |
| 10L-rare | common · first/first | 2,00,000 | 9,98,992 | 84 | 0.4 s | 1.1 s | 0.1 s | 264 MB | 3,937 | ✓ |
| 10L-most | common · first/first | 2,00,000 | 9,99,486 | 84 | 0.3 s | 1.4 s | 0.5 s | 296 MB | 1,84,344 | ✓ |
| 10L-dups | common · first/first | 2,00,000 | 9,09,678 | 77 | 0.3 s | 1.1 s | 0.3 s | 299 MB | 83,959 | ✓ |
| 50L-bigA | common · first/first | 10,00,000 | 49,94,656 | 421 | 1.3 s | 8.6 s | 2.0 s | 581 MB | 5,82,874 | ✓ |
| 10L-dups | common · **all/all** (one-to-many) | 2,00,000 | 9,09,678 | 77 | 0.3 s | 1.0 s | 0.4 s | 291 MB | 1,56,092 | ✓ |
| 10L | **A not in B** · first | 2,00,000 | 9,98,885 | 84 | 0.3 s | 1.1 s | 0.2 s | 290 MB | 77,472 | ✓ |

**Memory fix found by benchmarking.** The first 50L engine run peaked at 1,452 MB.
Investigation showed that retained keys and field values were V8 "sliced" strings
that kept their entire 8 MB parser chunk alive. Copying retained strings into
compact buffers (`copyStr` in `src/engine/core.ts`) reduced the 50L peak to 591 MB
and made matching ~10 % faster. All numbers above are after the fix.

## 3. Correctness checks

A later, complete bug check (2,880 setting combinations, native DuckDB comparison, 27 browser checks, 10 fixes) is in [VERIFICATION.md](VERIFICATION.md).


- **Automated tests** (`npm test`, 47 tests, run in CI before every deployment):
  parser edge cases at every chunk boundary (quotes, escaped quotes, multiline,
  CR/LF/CRLF), delimiter/encoding detection, normalisation, dates, CSV quoting and
  formula protection, XLSX validity, output splitting, the Excel reader (an openpyxl workbook and a hand-built one: shared/inline/rich text, namespaced XML, sparse cells, 1900/1904 dates, zero-padded formats, 16+ digit numbers, formulas, hidden sheets, damaged input) and an Excel sheet matched end-to-end, cartesian blocking, and
  **randomised equivalence**: 96 random configurations for Mode A and 80 for Mode B
  (running inside the real DuckDB-Wasm engine) compared row-by-row with a simple
  in-memory reference implementation — every operation, duplicate rule (incl.
  newest-by-date with DMY/MDY/YMD), union/join of Group B files, normalisation
  options, filters, missing columns, per-file mapping and all extra columns.
- **Ground truth**: every benchmark run's result-row count and matched-key count
  equal the generator's ground truth.
- **Independent engine cross-check**: for 10L and 50L, the Mode A output is
  identical in every data row (5,82,874 rows at 50L; compared after normalising line endings) to the output
  of the same job run by **native DuckDB** via `python/offline_matcher.py`.

## 4. Limits not reached / not tested

- No run hit a memory or storage limit on this machine, including Mode B at 50L.
  Larger inputs (e.g. 1 crore+ Group A consumers, or 50L with *keep all* and many
  long Group B columns) were not tested; see [MEMORY.md](MEMORY.md) for the factors
  that drive memory and what happens near the limit.
- Firefox and Safari were not benchmarked; Save As / folder export are Chrome/Edge features.
- XLSX export was verified by tests, not benchmarked at lakh scale. Excel input was tested with workbooks written by openpyxl and by hand, not with files saved by Microsoft Excel itself (the format is the same standard; real Excel files additionally contain cached formula results, which are used).
- Times exclude the browser's own download prompt (none in headless mode).

## Reproduce

```bash
npm install && npm run build
npm run gen:data -- --a 200000 --b 1000000 --bfiles 3 --match 0.6 --dups 0.03 --out test-data/10L
npm run bench -- --data test-data/10L                       # engine (Node)
npm run bench:browser -- --data test-data/10L --mode A      # full UI in Chrome (CHROME_PATH=...)
npm run bench:browser -- --data test-data/20L --mode A --cancel-test
npx tsx scripts/make-offline-job.ts test-data/10L job.sql out.csv && python python/offline_matcher.py job job.sql --data-dir test-data/10L
```
