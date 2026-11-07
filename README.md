# Consumer CSV Matcher

A browser-only application for finding common consumers between two groups of CSV
files — lakhs to millions of records — and exporting exactly the columns you need.
It runs as a static site on GitHub Pages. **Consumer files never leave the user's
computer**: they are read from disk by the page itself, and nothing is uploaded.

```
Group A (targets)          Group B (masters)              Output
Consumer ID, Division  ×   CA Number, Name, Mobile …  →   CA Number, Division, Name, Outstanding Amount
```

---

## Contents

1. [Features](#features)
2. [Data privacy](#data-privacy)
3. [Quick start (local)](#quick-start-local)
4. [Deploy to GitHub Pages](#deploy-to-github-pages)
5. [Using the application](#using-the-application)
6. [How it works](#how-it-works)
7. [Browser compatibility](#browser-compatibility)
8. [Limits, memory and recovery](#limits-memory-and-recovery) (details: [docs/MEMORY.md](docs/MEMORY.md))
9. [Offline alternative (Python + DuckDB)](#offline-alternative-python--duckdb)
10. [Tests and benchmarks](#tests-and-benchmarks) (results: [docs/BENCHMARK.md](docs/BENCHMARK.md), full bug check: [docs/VERIFICATION.md](docs/VERIFICATION.md))
11. [Project structure](#project-structure)

---

## Features

- **Two upload areas** (Group A targets, Group B masters), multiple files each, drag and drop, add/remove individual files.
- Per-file **name, size, row count, column count**, heading detection, validation warnings (blank/duplicate headings, single-column files, empty files, duplicate uploads).
- **Excel input**: `.xlsx` / `.xlsm` workbooks (up to Excel's 10,48,576 rows per sheet), with a sheet picker and “add the other sheets” for multi-sheet workbooks — see [Excel files](#excel-files).
- **Comma, semicolon, tab and pipe** delimiters; CRLF, LF, CR and mixed line endings (auto-detected, can be changed); quoted values, `""` escapes, **multiline cells**, CRLF/LF/CR; UTF-8 (with/without BOM), Windows-1252/ANSI (as saved by Excel's “CSV (Comma delimited)”) and UTF-16. For the SQL engine, non-UTF-8 files are first copied to UTF-8 in the background, because DuckDB rejects Windows-1252 characters such as curly quotes, dashes and €.
- **Dynamic key selection**: different heading names per file, **composite keys** (2–4 columns), optional trim / space-collapsing / case-insensitive / leading-zero normalisation (leading-zero normalisation is off by default).
- **Identifiers are always text** — never converted to numbers or scientific notation. **Blank keys never match** (also not each other).
- Operations: **common consumers**, **A not found in B**, **B not found in A**, **all A with match status**.
- Duplicate rules per group: keep **first**, **last**, **all**, **newest by date column**, or **one record per consumer**. Duplicate counts are shown before export.
- Group B files can be **combined as one dataset** or **joined side by side** (each file contributes its own fields).
- **Cartesian protection**: “keep all” on both sides is blocked unless explicitly allowed; the exact output row count is always calculated before export.
- **Output column designer**: pick from every column of both groups, search, rename, reorder, remove; per-file column mapping when headings differ (`Mobile` ↔ `Mobile No`); extra columns for source file, matching key, match status, occurrence counts and source row numbers; configurable value for missing fields with explicit warnings.
- Optional **row filters** (equals / contains / starts with / blank …).
- **Reusable templates** (saved in the browser; settings only, never data).
- **Two engines** — a streaming key-index engine (Mode A) and DuckDB-Wasm SQL (Mode B) — that produce byte-identical output (verified by automated tests).
- **Progress** with stage, current file, rows processed, total rows, percentage (only when measurable), elapsed time and **Cancel**.
- **Export**: CSV (primary) or XLSX (text cells, up to 10,48,575 rows per file); Save As, folder selection or normal download; optional splitting into parts; UTF-8 BOM; spreadsheet-formula protection; matching summary, duplicate report and data-issue report.
- **Offline job export** for the optional Python/DuckDB tool when a workload is too large for a browser.

## Data privacy

- Opening the hosted app downloads only the app's own static files (HTML, JavaScript, fonts, the DuckDB engine) from GitHub Pages. **Selecting CSV files does not upload them**: browsers give the page a handle to read the file locally, exactly like opening it in a desktop program.
- No server-side processing, no analytics, no remote logging, no third-party CDNs; all libraries and fonts are bundled.
- The production build sends a strict **Content-Security-Policy** (`connect-src 'self'`): the page is technically unable to send data to any other server. DuckDB extension auto-loading is switched off.
- Nothing is stored permanently. Temporary export copies kept in the browser's private storage (OPFS) are removed on the next start of the app or with **Clear temporary data**. Templates contain column names and options only.
- You can verify this yourself: open the browser's developer tools → *Network* tab while processing — no requests are made with your data.

## Quick start (local)

Requirements: [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # unit tests + engine-equivalence tests (incl. DuckDB-Wasm)
npm run build        # production build in dist/
npm run preview      # serve the production build locally
```

## Deploy to GitHub Pages

1. Create a repository on GitHub (e.g. `consumer-csv-matcher`) and push this folder to its `main` branch:
   ```bash
   git init && git add . && git commit -m "Consumer CSV Matcher"
   git branch -M main
   git remote add origin https://github.com/<user>/consumer-csv-matcher.git
   git push -u origin main
   ```
2. On GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. The workflow [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) runs on every push to `main`: installs dependencies, runs all tests, builds with the correct base path and publishes `dist/`.
4. The app appears at `https://<user>.github.io/<repository-name>/` (see the *Actions* tab for progress).

**Base path.** Project repositories are served from `/<repository-name>/`; the workflow sets `BASE_PATH` from the repository name automatically (and uses `/` for a `<user>.github.io` repository). To build manually for another path: `BASE_PATH=/my-path/ npm run build`.

No server, database, account or paid service is needed. GitHub Pages serves `.wasm` files with the correct `application/wasm` type, and the app does **not** need multi-threaded WebAssembly or cross-origin isolation (which GitHub Pages cannot provide): DuckDB runs in its single-threaded `eh`/`mvp` builds inside a Web Worker.

## Using the application

The interface is deliberately simple: five steps, one accent colour, and less-used settings (normalisation, several-B-files mode, filters, split/separator export options, engine details) folded under *Advanced options* / *More …* links.

1. **Files** — drop target files into *Group A* and master files into *Group B*. Rows are counted in the background; delimiter and encoding can be corrected per file.
2. **Match** — choose the key column for each file (obvious ones such as `Consumer ID`, `CA Number`, `CA No`, `Account No` are pre-selected). Use *Composite* for multi-column keys. Pick the operation, duplicate rules and, if needed, filters. Save as a template for next time.
3. **Columns** — tick the columns to export, rename headings, reorder them, map differently-named columns per file, add status/source/count columns.
4. **Process** — choose the engine (**Standard** = Mode A, recommended; **SQL engine (DuckDB)** = Mode B) and run the analysis. You see matched consumers, duplicates, blank keys and the exact number of result rows. Nothing is exported yet.
5. **Results** — check the preview, choose name/format/destination and export. A completion message lists every file written with row counts, sizes and warnings. Reports (summary, duplicates, data issues) are separate downloads.

### Excel files

Excel workbooks (`.xlsx`, `.xlsm`) can be dropped into either group, alone or mixed with CSV files.

- Each worksheet becomes one input “file” (`book.xlsx › Sheet1`). The first visible sheet is taken; another sheet can be chosen in the *Delimiter / Sheet* column, and **+ add N more sheets** adds the remaining sheets of the workbook (useful when 50 lakh records are split over several sheets).
- The sheet is converted once, in the background, into a temporary CSV copy kept in the browser's private storage. Conversion streams the sheet; only the workbook's shared-text table is held in memory. Afterwards everything works exactly as for CSV files. The copy is deleted when the file is removed, with *Clear temporary data*, or when the app is reopened. The **CSV** button saves the copy (e.g. for the offline tool).
- Values are taken as stored in the workbook: text as text; numbers without thousands separators and never in exponent form; dates as `YYYY-MM-DD` (with time if present); TRUE/FALSE; formula cells use their saved result. Numbers shown with a zero-padded format (e.g. `000000000000`) keep their leading zeros.
- **Warnings** are shown when an ID column is stored as numbers (leading zeros can only exist via the number format), when numbers have 16+ digits (Excel has already cut them to 15 significant digits — that cannot be undone), and when formula cells have no saved result.
- Not supported: old `.xls`, `.xlsb`, `.ods` and password-protected workbooks — save them as `.xlsx` or CSV. The first non-empty row of a sheet is used as the heading row.

**Row counts vs. consumers.** *Rows* are physical lines in the files; *consumers* are unique keys. A target list of 2,00,000 rows may contain 1,94,000 unique consumers; both numbers are shown.

**Excel tip.** Excel converts long numbers to scientific notation when it *opens* a CSV. The CSV itself keeps every digit. Use XLSX export (IDs are stored as text) or Excel's *Data → From Text/CSV* with the ID column set to *Text*.

## How it works

```
 UI (React, main thread)  ──postMessage──►  Engine Web Worker (Mode A)
   – never parses data                        File.slice() chunks → TextDecoder(stream) → CSV state machine
                                              Pass 1: Group A → Map<normalisedKey, slot> + Int32/Float64 arrays
                                              Pass 2: Group B → hash probe; keep only projected fields of matched rows
                                              Export: re-stream driving group → CSV/XLSX encoder → disk (FS Access / OPFS)

 Mode B: DuckDB-Wasm (own worker) ── registerFileHandle (lazy reads) → read_csv(all VARCHAR, projected columns)
         → window-function de-duplication → joins → Arrow batches → same CSV/XLSX writer
```

- **No quadratic comparisons**: every lookup is a hash probe (Mode A) or a hash join (Mode B).
- **Minimum memory**: Group A rows are not kept, only their keys; Group B rows are kept only if they match, and only the selected output fields. Retained strings are compacted so they do not pin multi-megabyte parser chunks.
- **Streaming output**: rows are encoded in ~1 MB batches and written directly to the destination file; the result is never assembled as one big string.
- **Engine choice**: Mode A has the lowest memory use for every workload and is the default. Mode B (DuckDB) loads the needed columns into an in-browser database; it is useful for cross-checking and for small/medium data. The *Process* step shows a memory estimate for each and warns when Mode B is unsuitable.
- **Correctness**: both engines are compared with each other and with a deliberately simple reference implementation for **all 2,880 combinations** of operation, duplicate rules, combine mode, normalisation and filters on deliberately awkward files — output rows, every statistic and the duplicate report. See [docs/VERIFICATION.md](docs/VERIFICATION.md).

## Browser compatibility

| Feature | Chrome / Edge | Firefox | Safari | Used for | Fallback |
|---|---|---|---|---|---|
| File API (`File.slice`, `TextDecoder` stream) | ✓ | ✓ | ✓ | reading files in chunks | — (required) |
| Module Web Workers | 80+ | 114+ | 15+ | background processing | — (required) |
| WebAssembly (MVP / exceptions) | ✓ | ✓ | ✓ | DuckDB (Mode B) | Mode A needs no WebAssembly |
| `showSaveFilePicker`, `showDirectoryPicker` | 86+ | ✗ | ✗ | Save As / folder export | browser download |
| OPFS `createSyncAccessHandle` (worker) | 102+ | 111+ | 15.2+ | disk-backed temporary export | in-memory blob |
| `createWritable` | 86+ | 111+ | 26+ | writing to chosen file/folder | — |

**Recommended: current Chrome or Edge on a desktop/laptop** (Save As and folder output, highest memory limits). Firefox and Safari work with browser downloads. Mobile browsers are not a target for lakh-scale files. Multi-threaded WebAssembly is intentionally not used.

## Limits, memory and recovery

This tool does **not** claim unlimited capacity. A browser tab has a memory ceiling (roughly 4 GB for a 64-bit Chrome tab, often less). What matters is mostly the number of **unique Group A keys** and the size of the **selected Group B fields for matched rows** — not the total file size. Measured examples are in [docs/BENCHMARK.md](docs/BENCHMARK.md); for practical guidance and what to do when a run fails, see [docs/MEMORY.md](docs/MEMORY.md). In short:

- Errors are reported in plain words (file could not be read, storage full, out of memory, malformed quoted value …) and the app stays usable; *Cancel* stops a run at the next chunk.
- To reduce memory: export fewer Group B columns, use “keep first” instead of “keep all”, process Group A in parts, or use the offline tool.
- **Clear temporary data** releases the index, DuckDB tables and temporary export files.

## Offline alternative (Python + DuckDB)

For workloads beyond practical browser limits, [`python/offline_matcher.py`](python/offline_matcher.py) runs the **same matching job** with native, multi-threaded DuckDB that can spill to disk. It is optional and not needed for the web app.

```bash
pip install duckdb
# In the app: Process step → "Download offline job" → matcher_job.sql
python python/offline_matcher.py job matcher_job.sql --data-dir "D:/consumer_files"
# or a quick single-key match without the app:
python python/offline_matcher.py match --a targets.csv --a-key "Consumer ID" \
    --b master1.csv master2.csv --b-key "CA Number" "CA No" --a-cols "Consumer ID" Division \
    --b-cols Name Arrear --out matched.csv
```

## Tests and benchmarks

```bash
npm test                                        # 49 tests: parser, normaliser, writer, XLSX, splitting,
                                                # Excel reader, Mode A and Mode B (real DuckDB-Wasm) vs. reference,
                                                # 180-combination engine comparison
npm run test:full                               # all 2,880 setting combinations compared (~5 min)
npm run compare:offline                         # app engine vs native DuckDB offline tool
npm run test:browser                            # 27 feature checks in headless Chrome (after npm run build)
npm run gen:data -- --a 200000 --b 1000000 --bfiles 3 --match 0.6 --dups 0.03 --out test-data/10L
npm run bench -- --data test-data/10L           # engine benchmark (Node), verified against ground truth
npm run build && npm run bench:browser -- --data test-data/10L --mode A   # full UI run in headless Chrome
```

Small ready-made sample files are in [`samples/`](samples/): 2,000 targets and 10,010 master rows in three CSV files with different headings, plus the same data as Excel workbooks (the masters as one workbook with three sheets).

The generator writes realistic fictitious consumer data (12–14 digit IDs with leading zeros, Hindi names, addresses with commas, quotes and line breaks, negative arrears, dates) plus a `manifest.json` with the ground truth. The browser benchmark drives the real UI (upload → matching → output → analyse → export), measures time, UI responsiveness and JS heap, and checks the downloaded file.

## Project structure

```
src/engine/        types · csv (streaming parser, counter, detection) · xlsx (streaming Excel reader) · normalize · writer (CSV, XLSX)
                   sink (FS Access, OPFS, memory) · core (Mode A engine) · sql (Mode B plan, offline job)
src/workers/       engine.worker.ts — inspection, counting, analysis, preview, export
src/lib/           engineClient (worker wrapper) · duckClient (DuckDB-Wasm) · files · templates · format
src/components/    Upload · Matching · Output · Process · Results · ui
tests/             engine.test.ts · duckdb.test.ts · xlsx.test.ts · compare.test.ts · helpers.ts (reference implementation) · fixtures/
scripts/           generate-test-data · csv-to-xlsx.py · benchmark · bench-xlsx · browser-e2e · browser-features (headless Chrome) · compare-offline · make-offline-job
python/            offline_matcher.py
docs/              MEMORY.md · BENCHMARK.md · VERIFICATION.md
samples/           small synthetic Group A / Group B files + manifest
bench-results/     raw benchmark measurements (JSON)
```

License: MIT.
