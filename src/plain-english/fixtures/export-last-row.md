TRIAGE REPORT

## What happens

Exports over 500 rows stop one row short: the last row of the report is missing from the CSV file.

## Where

Reports → Export, CSV only; XLSX is complete. The exporter in `src/export/csv.ts` throws `RangeError: offset out of bounds` on the final page:

```
RangeError: offset out of bounds
    at Pager.next (src/export/pager.ts:41:11)
    at exportCsv (src/export/csv.ts:88:13)
```

## Why

The exporter fetches rows 500 at a time and stops when a page comes back full, so the last, partly filled page is never fetched.

## Scope

Every CSV export over 500 rows, on every account. A defect, not configuration: the harness fails on a fresh seed.

## Workaround

Export as XLSX, which includes every row.

## Confidence

High — reproduced on main, and the candidate change makes the harness pass.
