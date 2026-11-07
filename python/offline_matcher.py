#!/usr/bin/env python3
"""
Consumer CSV Matcher — optional offline processor (native DuckDB).

Use this only when a workload is larger than a browser can handle. It is not
needed for the GitHub Pages application. Everything runs on your own computer.

Two ways to use it:

1) Run a job exported from the web app (Process step -> "Download offline job"):

       python offline_matcher.py job matcher_job.sql --data-dir "D:/consumer_files"

   The job holds exactly the matching and output settings chosen in the app and
   produces the same result as the app.

2) Quick match from the command line (single key column, common consumers,
   first occurrence kept on both sides):

       python offline_matcher.py match \
           --a targets.csv --a-key "Consumer ID" \
           --b master1.csv master2.csv --b-key "CA Number" "CA No" \
           --a-cols "Consumer ID" Division --b-cols Name Arrear \
           --out matched.csv

Install once:   pip install duckdb
"""
from __future__ import annotations

import argparse
import os
import sys
import time


def connect(memory_limit: str | None, temp_dir: str):
    try:
        import duckdb  # type: ignore
    except ImportError:
        sys.exit("DuckDB is not installed. Run:  pip install duckdb")
    con = duckdb.connect()
    os.makedirs(temp_dir, exist_ok=True)
    con.execute(f"SET temp_directory = '{temp_dir.replace(chr(39), chr(39) * 2)}'")  # spill to disk instead of failing
    if memory_limit:
        con.execute(f"SET memory_limit = '{memory_limit}'")
    return con


def split_statements(sql: str) -> list[str]:
    """Split on semicolons outside quotes and comments."""
    out, cur, i, q = [], [], 0, None
    while i < len(sql):
        c = sql[i]
        if q:
            cur.append(c)
            if c == q:
                if i + 1 < len(sql) and sql[i + 1] == q:
                    cur.append(sql[i + 1])
                    i += 1
                else:
                    q = None
        elif c in ("'", '"'):
            q = c
            cur.append(c)
        elif c == '-' and sql[i:i + 2] == '--':
            j = sql.find('\n', i)
            i = len(sql) if j < 0 else j
            continue
        elif c == ';':
            s = ''.join(cur).strip()
            if s:
                out.append(s)
            cur = []
        else:
            cur.append(c)
        i += 1
    s = ''.join(cur).strip()
    if s:
        out.append(s)
    return out


def run_job(args) -> None:
    with open(args.job, encoding='utf-8') as fh:
        stmts = split_statements(fh.read())
    os.chdir(args.data_dir)
    con = connect(args.memory_limit, args.temp_dir)
    t0 = time.time()
    for n, s in enumerate(stmts, 1):
        label = s.split('\n', 1)[0][:70]
        t = time.time()
        try:
            con.execute(s)
        except Exception as e:  # noqa: BLE001
            if 'latin-1' in str(e) or 'encoded' in str(e):
                sys.exit(f"{e}\nA CSV file is not UTF-8. Open it in Excel and use Save As -> 'CSV UTF-8 (Comma delimited)', then run again.")
            raise
        print(f"[{n}/{len(stmts)}] {time.time() - t:6.1f}s  {label}")
    rows = con.execute("SELECT count(*) FROM cm_a").fetchone()[0], con.execute("SELECT count(*) FROM cm_b").fetchone()[0]
    print(f"Done in {time.time() - t0:.1f}s. Group A rows: {rows[0]:,}  Group B rows: {rows[1]:,}")


def q(s: str) -> str:
    return '"' + s.replace('"', '""') + '"'


def lit(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def run_match(args) -> None:
    if len(args.b_key) not in (1, len(args.b)):
        sys.exit('--b-key needs one column name, or one per --b file')
    if len(args.a_key) not in (1, len(args.a)):
        sys.exit('--a-key needs one column name, or one per --a file')
    con = connect(args.memory_limit, args.temp_dir)
    con.execute('SET threads = 1')  # keep file order while loading

    def norm(col: str) -> str:
        e = f"coalesce({col}, '')"
        if not args.exact:
            e = f"trim({e})"
        return e

    def load(table: str, paths: list[str], keys: list[str], cols: list[str]):
        parts = []
        for i, p in enumerate(paths):
            key = keys[i] if len(keys) > 1 else keys[0]
            sel = ', '.join(f"coalesce({q(c)}, '') AS {q(c)}" for c in cols) or "NULL AS __none"
            parts.append(
                f"SELECT {i} AS __f, row_number() OVER () AS __r, nullif({norm(q(key))}, '') AS __k, {sel}, {lit(os.path.basename(p))} AS __file "
                f"FROM read_csv({lit(p)}, header = true, all_varchar = true, parallel = false, union_by_name = false)"
            )
        con.execute(f"CREATE TABLE {table} AS " + ' UNION ALL BY NAME '.join(f'({x})' for x in parts))

    t0 = time.time()
    load('a', args.a, args.a_key, args.a_cols)
    load('b', args.b, args.b_key, args.b_cols)
    con.execute('RESET threads')
    a_cols = ', '.join(f'a.{q(c)}' for c in args.a_cols)
    b_cols = ', '.join(f'coalesce(b.{q(c)}, {lit(args.missing)}) AS {q(c if c not in args.a_cols else c + " (B)")}' for c in args.b_cols)
    sql = (
        "WITH a1 AS (SELECT * FROM a WHERE __k IS NOT NULL QUALIFY row_number() OVER (PARTITION BY __k ORDER BY __f, __r) = 1), "
        "b1 AS (SELECT * FROM b WHERE __k IS NOT NULL QUALIFY row_number() OVER (PARTITION BY __k ORDER BY __f, __r) = 1) "
        f"SELECT {', '.join(x for x in [a_cols, b_cols, 'b.__file AS \"Source File\"'] if x)} "
        "FROM a1 a JOIN b1 b ON a.__k = b.__k ORDER BY a.__f, a.__r"
    )
    con.execute(f"COPY ({sql}) TO {lit(args.out)} (HEADER, DELIMITER ',')")
    n = con.execute(f"SELECT count(*) FROM read_csv({lit(args.out)}, all_varchar = true)").fetchone()[0]
    print(f"Wrote {n:,} matched rows to {args.out} in {time.time() - t0:.1f}s")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--memory-limit', default=None, help="e.g. 6GB (default: DuckDB's own limit, ~80%% of RAM)")
    ap.add_argument('--temp-dir', default='.duckdb_tmp', help='folder for temporary spill files')
    sub = ap.add_subparsers(dest='cmd', required=True)

    j = sub.add_parser('job', help='run a job exported from the web app')
    j.add_argument('job')
    j.add_argument('--data-dir', default='.', help='folder that contains the CSV files named in the job')
    j.set_defaults(fn=run_job)

    m = sub.add_parser('match', help='quick command-line match')
    m.add_argument('--a', nargs='+', required=True)
    m.add_argument('--a-key', nargs='+', required=True)
    m.add_argument('--b', nargs='+', required=True)
    m.add_argument('--b-key', nargs='+', required=True)
    m.add_argument('--a-cols', nargs='*', default=[])
    m.add_argument('--b-cols', nargs='*', default=[])
    m.add_argument('--missing', default='')
    m.add_argument('--exact', action='store_true', help='do not trim spaces around keys')
    m.add_argument('--out', required=True)
    m.set_defaults(fn=run_match)

    args = ap.parse_args()
    args.temp_dir = os.path.abspath(args.temp_dir)
    args.fn(args)


if __name__ == '__main__':
    main()
