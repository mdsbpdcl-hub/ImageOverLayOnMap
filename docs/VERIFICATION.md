# Verification report — full bug check (7 November 2026)

Goal: nothing left unchecked. Both processing engines, the reference implementation,
the optional offline tool and the real browser were compared against each other for
every setting the app offers, on deliberately awkward files. Everything listed below
was actually run; the commands to repeat it are at the end.

## What was compared

| # | Comparison | Scope | Result |
|---|---|---|---|
| 1 | **Mode A = Mode B = reference implementation** — every output row (values and order), all 19 statistics shown to the user, the duplicate report, the preview | **2,880 setting combinations**: 4 operations × 5 Group A duplicate rules × 9 Group B rule/combine choices (union with 5 rules, side-by-side join with 4) × 4 key-normalisation variants × 4 filter variants, alternating DMY/MDY dates | ✅ all identical |
| 2 | Same, on every `npm test` run (CI, before each deployment) | 180 combinations (every operation × duplicate rule × combine mode) | ✅ |
| 3 | **App engine = native DuckDB** (offline Python tool) | 36 settings on the sample files: all operations, all Group B rules, union and join, normalisation variants, newest-by-date | ✅ 36/36 identical |
| 4 | **Real Chrome, both engines, every export path** | 27 checks — see below | ✅ 27/27 |
| 5 | Unit tests | parser at every chunk boundary, encodings, line endings, normaliser, dates, CSV/XLSX writers, Excel reader, splitting, cartesian guard | ✅ 49/49 |
| 6 | Large-data regression after the fixes (Chrome) | 50 lakh + 10 lakh rows in Mode A and Mode B; 10-lakh-row Excel sheet | ✅ correct rows, leading zeros intact |

### Awkward test files used in comparison 1

Seven files, chosen to break parsers:
UTF-8 with BOM · CRLF, LF, CR-only and **mixed** line endings · comma, semicolon, tab
and pipe delimiters · **Windows-1252 (“ANSI”)** with curly quotes, dash and € ·
**UTF-16** with Hindi text · a **heading-only** file · quoted values with commas,
escaped quotes and **line breaks inside cells** · **blank lines**, a line of spaces,
a line of only delimiters · rows with **fewer and more columns** than the heading ·
a **duplicate heading** (`Consumer ID` twice) · keys with spaces, non-breaking spaces,
double spaces, leading zeros, `000` vs `0`, mixed case, `ß`, a formula-like value ·
blank keys · valid, invalid and missing dates in several formats · a file name with
an apostrophe.

### Browser checks (comparison 4)

Run in headless Chrome against the production build. The *Save As* and *folder*
pickers were replaced by real file/folder handles in browser storage, so the app's
own writing code ran unchanged.

- Windows-1252 file detected; mixed line endings detected; key columns auto-detected.
- Five scenarios (common; all-with-status with keep-all × keep-all; B-not-in-A with newest-by-date; A-not-in-B with case/leading-zero normalisation; side-by-side join with filter) — for each: **Mode A file = Mode B file**, and **browser file = engine run in Node**, byte for byte.
- XLSX export: valid workbook, same row count as CSV, IDs stored as text with leading zeros.
- Folder export in both engines = Save As result; browser download = Save As result.
- Duplicate report, data-issue report and summary downloaded; duplicate report Mode A = Mode B.
- Cancel during Mode B (including the UTF-8 preparation step), then run again.
- Template saved, page reloaded, files re-added, template applied: key columns and all output columns restored.
- *Clear temporary data* removes all export and conversion copies from browser storage.
- No JavaScript errors.

## Bugs found and fixed in this check

| # | Problem | Who was affected | Fix |
|---|---|---|---|
| 1 | Mode B stopped with “Expected Number of Columns” when any row had **more cells than the heading** | Mode B | DuckDB's strict mode switched off; extra cells are ignored, exactly like Mode A |
| 2 | Mode B **lost the first character of a row** after a lone CR line ending inside a CRLF/LF file (old-Mac line endings mixed in) | Mode B | Mixed line endings are detected while counting rows; such files get a clean UTF-8 copy before DuckDB reads them |
| 3 | Mode B failed on **Windows-1252 (“ANSI”) files**: “File is not latin-1 encoded” (reported by you) | Mode B | Non-UTF-8 files are copied to UTF-8 first |
| 4 | **Case-insensitive matching differed** between engines for some non-English letters (`ß1` matched `SS1` in one engine only) | both | Both engines now fold only A–Z (consumer numbers and Hindi text are unaffected); option renamed “Ignore upper/lower case (A–Z)” |
| 5 | The line-ending detector **missed a lone CR inside a CRLF file** (found by the new unit test) | Mode B | Counts CRLF separately |
| 6 | Analysis could be **started while files were still being counted**, so Mode B could miss fix 2 | Mode B | Start waits until every file is read |
| 7 | With multiplication blocked, the **preview step showed an error** | both | Preview is skipped with an explanation |
| 8 | **Cancel** did not stop the UTF-8 preparation step | Mode B | Cancel now stops it |
| 9 | Switching to another Excel sheet with the same row count **kept the old analysis** | both | Analysis resets whenever a file, sheet or setting changes |
| 10 | An empty or unreadable file produced a confusing message | both | Clear message naming the file |

Earlier today (already delivered): cancel affecting the next run; memory retention
(50 lakh run 1,452 MB → 591 MB); “File is not latin-1 encoded”.

## Known, intentional differences (not bugs)

- **Malformed-row count** (rows whose cell count differs from the heading) and the **data-issue report** come from Mode A only; Mode B shows “—”.
- The **offline tool** writes plain CSV: no UTF-8 BOM and no spreadsheet-formula protection, and it needs UTF-8 files (it tells you if a file is not).
- A file whose text is cut off inside an **unclosed quote** is rejected by both engines with an error naming the record.

## Performance after the fixes

The fixes do not touch the Mode A hot path. The large runs were repeated on a
restarted test machine with a slower CPU (Xeon 2.1 GHz instead of 2.3 GHz), so times
are ~20–30 % higher than in [BENCHMARK.md](BENCHMARK.md); results were correct:

| Run (Chrome) | Matching | Export | Result rows | Leading-zero IDs |
|---|---|---|---|---|
| 50L, Mode A | 11.4 s | 3.5 s | 5,82,874 ✓ | 87,452 ✓ |
| 50L, Mode B | 12.8 s | 10.5 s | 5,82,874 ✓ | 87,452 ✓ |
| 10-lakh-row Excel sheet, Mode A (import incl. conversion 17.1 s) | 2.1 s | 1.0 s | 1,16,528 ✓ | 17,272 ✓ |

## Repeat it yourself

```bash
npm test                    # 49 tests incl. 180-combination engine comparison
npm run test:full           # all 2,880 combinations (~5 minutes)
npm run compare:offline     # app engine vs native DuckDB (needs: pip install duckdb)
npm run build && npm run test:browser   # 27 checks in real Chrome (CHROME_PATH=...)
```
