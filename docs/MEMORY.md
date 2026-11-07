# Browser memory limits and recovery

The application processes everything inside the browser tab. That keeps data
private, but it also means the work must fit within what a browser allows. This
page explains what uses memory, what the limits are, how failures show up and
what to do about them.

## What uses memory

### Mode A — streaming key index (default)

| Item | Kept in memory? | Approximate cost |
|---|---|---|
| Input files | **No.** Read in chunks (default 8 MB) straight from disk. | one chunk at a time |
| Group A rows | **No.** Only each unique key and a few counters. | ~100–150 bytes per unique key |
| Group B rows that do **not** match | **No.** | 0 (except for *B not found in A*, where each unmatched key is tracked: ~100–150 bytes per key) |
| Group B rows that match | Only the **selected output fields** of the row(s) kept by the duplicate rule. | size of those fields × 1–2 + ~60 bytes |
| Output | **No.** Written to disk in ~1 MB batches. | ~1–3 MB |

So memory grows with **unique Group A consumers** and with **how many Group B
fields you export for matched consumers** — not with total file size. Measured:
50 lakh Group B rows + 10 lakh Group A rows (421 MB of CSV) used about 0.6 GB of
process memory in the engine benchmark (see [BENCHMARK.md](BENCHMARK.md)).

Things that increase memory noticeably:

- *Keep all matching rows* for Group B (every matching B row is kept, not one).
- Exporting many or long Group B columns (addresses, remarks).
- *Group B not found in A* on very large Group B files (all unmatched keys are tracked).

### Excel input

An Excel sheet is converted to a temporary CSV copy once, when it is added.
During conversion the workbook's **shared-text table** (every distinct text used
in the workbook — names, addresses, IDs stored as text) must be held in memory;
the sheet itself is streamed. Measured: a 55 MB workbook with one 10-lakh-row
sheet peaked at about 0.7 GB of process memory in Node and under 0.4 GB of
JavaScript heap in Chrome. After conversion that memory is released and the
sheet behaves like any CSV file. Very large workbooks with mostly unique texts
need proportionally more memory; saving them as CSV from Excel avoids this step.

### Mode B — DuckDB SQL

DuckDB loads the key, date and selected columns of **every** row of both groups
into its in-browser database before joining. Memory is therefore roughly
proportional to the total size of the projected columns of all files, and the
WebAssembly build is limited to 4 GB of address space (less in practice). Use
Mode B for cross-checking and for small/medium workloads; the *Process* step
shows an estimate and warns when Mode B is unsuitable.

## Browser limits

- A 64-bit Chrome/Edge tab can typically use up to about 4 GB of JavaScript heap
  per worker; the real ceiling depends on the computer's free RAM and other tabs.
- Firefox and Safari have similar but less predictable limits.
- JavaScript `Map` objects hold at most about 1.67 crore (16.7 million) entries,
  so Mode A supports up to ~1.6 crore unique Group A consumers (and, for *B not
  found in A*, unique unmatched Group B consumers). Beyond that, use the offline tool.
- Browser storage (OPFS) is used for temporary export copies when downloading.
  Its quota is shown on the *Process* step. *Save As* / folder output writes
  directly to your disk instead.
- Excel sheets hold at most 10,48,576 rows; XLSX export splits or refuses larger
  results (CSV has no such limit).

## How problems are reported

| Situation | What you see | Recovery |
|---|---|---|
| A file changed, moved or was deleted after adding it | “A file could not be read …” | Remove the file and add it again |
| Old `.xls` / `.xlsb` / `.ods`, password-protected or damaged workbook | Error on the file row explaining what to do | Save as `.xlsx` or CSV from Excel |
| IDs stored as numbers / 16+ digit numbers / formulas without saved results in Excel | Warning on the file row and on the Matching step | Store IDs as text in Excel; open and save the workbook in Excel |
| “File is not latin-1 encoded” (older versions, Mode B) | — | Fixed: non-UTF-8 files are converted to UTF-8 before the SQL engine reads them. In the offline tool, save the file as “CSV UTF-8” in Excel |
| Unclosed quote / wrong delimiter (one record > 16 MB) | “A single record exceeds 16 MB …” | Check the delimiter on the Upload step; fix the file |
| Rows with too many/few columns | Count on the Process step, listed in the *data issue report* | Rows are still processed (missing cells blank) |
| Unreadable dates for “keep newest” | Count on the Process step, listed in the issue report | Change the date format option or fix the data |
| Browser storage full while downloading | “Browser storage is full …” | Use *Save As* / folder output, free disk space, *Clear temporary data* |
| Out of memory (caught) | “The browser ran out of memory …” | See below |
| Out of memory (tab or worker killed by the browser) | “The processing worker stopped unexpectedly …”, or the tab reloads | See below |
| Rows would multiply (keep all × keep all) | Export blocked with an explanation and exact row count | Allow multiplication explicitly or change a duplicate rule |
| You press Cancel | “Processing was cancelled.” | Adjust settings and run again |

The engine never reports success before the export has been fully written: the
completion message lists every file with its row count and size, and a warning
appears if the number of rows written differs from the analysed count.

## Reducing memory use

1. Use **Mode A**.
2. Export only the Group B columns you need.
3. Prefer *keep first/last/newest* over *keep all* for Group B.
4. Split a very large Group A into parts (e.g. by division) and run them one after another.
5. Close other heavy tabs; use Chrome or Edge on a desktop/laptop with 8 GB+ RAM.
6. Press **Clear temporary data** between large runs.
7. For workloads that still do not fit, use **Download offline job** and run it with
   `python/offline_matcher.py` (native DuckDB spills to disk and uses all CPU cores).
