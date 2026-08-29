# Christensen XLSX parser validation

Validation was rerun locally against the two provided Christensen source workbooks on 2026-08-27. It exercised `parseProcurementXlsx()` only. No authenticated POST was sent and no database row or secure-storage object was created.

Auditable command and captured output: `bun C:/Users/jat00/AppData/Local/Temp/validate-christensen-procurement-t_be9f2be2.ts > C:/Users/jat00/AppData/Local/Temp/christensen-procurement-validation-t_be9f2be2.jsonl`. The run exited `0`; both parser calls completed with zero thrown parser errors.

| Source workbook | Selected sheet | Header row | Parser layout | Parsed rows | Persisted import rows | Result |
| --- | --- | ---: | --- | ---: | ---: | --- |
| `I:\My Drive\Customers\Christensen\Simpson Hardware Takeoff - 2220 E ST.xlsx` | `Order List` | 5 | `v3-simpson-hardware` | 32 | 0 | Passed |
| `I:\My Drive\Customers\Christensen\Takeoffs - 2220 E ST VANCOUVER - WA.xlsx` | `Takeoff Breakdown` | 6 | `v4-takeoff-breakdown` | 122 | 0 | Passed |

The two source paths, layout versions, row totals, and gap totals above are the exact JSONL fields recorded by that run.

## Warning and import-result interpretation

`parseProcurementXlsx()` has no warning return channel. Both files parsed without an exception. The following source-data gaps were observed from the parsed rows and are intentionally retained for the import-review stage:

- Simpson: all 32 rows have no source project reference and no unit cost; quantities were numeric on all 32 rows.
- Takeoff Breakdown: all 122 rows have no source project reference; one row has a non-numeric or empty quantity and 108 rows have a non-numeric or empty unit cost. These values parse as `null`, rather than being invented or rejected.

For either workbook, a real authenticated import would stage every parsed row (`MaterialImportRun.rowCount` of 32 or 122) and mark every row `DATA_GAP` because no source project reference is present. This validation deliberately reports zero persisted import rows: exercising the POST route would retain raw cost data in secure storage and create production-like database records, which was outside the local parser proof.

The parser’s explicit numeric `Line`/`Item #` rule excludes the prose footer rows observed in these source workbooks.
