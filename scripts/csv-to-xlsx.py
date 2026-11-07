#!/usr/bin/env python3
"""Test helper: converts generated CSV files to .xlsx workbooks (openpyxl, write-only).

  python scripts/csv-to-xlsx.py OUT.xlsx IN1.csv [IN2.csv ...]   # one sheet per CSV

Consumer numbers and mobiles stay text cells, Arrear becomes a number and
Last Payment Date a real Excel date — like typical exports from billing systems.
"""
import csv, datetime, sys
from openpyxl import Workbook

out, inputs = sys.argv[1], sys.argv[2:]
wb = Workbook(write_only=True)
for i, path in enumerate(inputs):
    ws = wb.create_sheet(f"Data{i + 1}" if len(inputs) > 1 else "Data")
    with open(path, newline='', encoding='utf-8') as fh:
        r = csv.reader(fh)
        header = next(r)
        ws.append(header)
        num = {j for j, h in enumerate(header) if h in ('Arrear', 'Load KW')}
        dat = {j for j, h in enumerate(header) if h == 'Last Payment Date'}
        for row in r:
            vals = []
            for j, v in enumerate(row):
                if j in num and v:
                    vals.append(float(v))
                elif j in dat and v:
                    d, m, y = v.split('-')
                    vals.append(datetime.date(int(y), int(m), int(d)))
                else:
                    vals.append(v)
            ws.append(vals)
wb.save(out)
print('wrote', out)
