# Procurement XLSX Input Contract

Version: 1.0
Status: implemented parser contract; no production import may run until the guarded
schema script has completed against the named target with a verified backup manifest.

## Purpose

This is the only accepted direct-upload XLSX contract for Procurement V1. A file that
does not match one listed layout is rejected before an import run is created. We do
not infer column meaning or guess a project from a description. Layouts v3 and v4 are
named source layouts for the Christensen takeoff formats; they are explicit mappings,
not a general header-guessing fallback.

## File acceptance

- One `.xlsx` workbook, maximum 15 MiB. MIME is advisory; workbook parsing is the
  real acceptance check.
- The first worksheet must contain one recognized header row and at least one material
  row. Layouts v1 and v2 require row 1; v3 and v4 name both the worksheet and header
  row below.
- Blank rows are ignored. A non-blank row without Description is rejected.
- Numeric quantity and unit price must be non-negative if supplied. `Need By` is
  accepted only as ISO `YYYY-MM-DD` (or an actual XLSX date cell).
- The source bytes are SHA-256 hashed before staging. Content is kept at
  `procurement/imports/<projectId>/<sourceHash>/<safeFilename>` in the existing
  ProBuild Supabase Storage bucket. The database stores the immutable storage path,
  not a browser-provided URL. Retention is seven years; it is never silently
  overwritten or deleted by a retry.

## Supported layouts

### Layout v1

Required headers, case and extra whitespace ignored:

| Meaning | Header |
|---|---|
| description | `Description` |
| vendor | `Vendor` |
| quantity | `Quantity` |
| unit cost | `Unit Cost` |
| need-by | `Need By` |
| source project | `Project` |

### Layout v2

| Meaning | Header |
|---|---|
| description | `Item Description` |
| vendor | `Vendor Name` |
| quantity | `Qty` |
| unit cost | `Unit Price` |
| need-by | `Need By Date` |
| source project | `Project` |

`Project` can be blank. A blank project produces a visible `DATA_GAP`; it never
falls back to a fuzzy project match. A non-blank source project that differs from
the project selected in the review screen produces `PROJECT_CONFLICT` and cannot
be committed.

### Layout v3 — Simpson Hardware Takeoff

This layout is recognized only on worksheet `Order List`, with its header at row 5.
It maps numeric `Line` as the source-row identifier, `Description` as description, and
`Supplier Qty` as quantity. The source has no vendor, unit-cost, need-by, or explicit
ProBuild project-ID columns, so those values remain blank and are displayed as data
gaps in staging. The title/address cells are not treated as a project match.

### Layout v4 — Takeoff Breakdown

This layout is recognized only on worksheet `Takeoff Breakdown`, with its header at
row 6. It maps numeric `ITEM #` as the source-row identifier, `DESCRIPTION` as description,
`QUANTITY (W/ Wastage)` as quantity, and `UNIT COST (Material)` as unit cost. Section
labels and subtotals have no item number and are not material rows. Vendor, need-by,
and ProBuild project-ID values remain blank rather than being inferred from workbook
metadata.

## Immutable identity and retry rules

Each direct upload creates a client UUID before its first POST. The same UUID is
retained across a network retry. The server stores:

- `ingestPath`: `DIRECT_XLSX`
- `requestKey`: canonical `xlsx:<client UUID>`. The client only submits and
  retains the UUID; the server adds the documented immutable ingest-path prefix
  and never adds a generated retry suffix.
- `sourceHash`: SHA-256 of the retained byte stream
- `commitScopeHash`: SHA-256 of canonical selected project ID, layout version, and
  every result-affecting option

`MaterialImportRun` is unique on `(ingestPath, requestKey)`. A retry returns the
same run only if source hash and commit-scope hash agree. A different file or
selected project for the same UUID is rejected, not treated as a new import.

Per-row source evidence and events use deterministic keys derived from that run key
and the immutable row number. The system never uses a generated MaterialItem ID as
an ingest identity.

## Staging and commit

1. Upload and retain the original file.
2. Parse only a supported layout and write `MaterialImportRun` plus
   `MaterialImportRow` records in `STAGED` state.
3. Render each row, including source project, selected project, validation state,
   and the exact reason for every data gap or conflict.
4. A permitted staff member explicitly commits. Commit uses one transaction and
   only rows with matching selected/source project. It writes the item, immutable
   source evidence, source relation, and audit event together.
5. Commit never creates, changes, or links a QBO expense or a purchase order.

## Fixtures

`tests/fixtures/procurement/xlsx/` contains minimal synthetic examples for both
accepted layouts and an unsupported layout. They prove the parser contract only.
They are not a Christensen job export and are not evidence that a real customer
spreadsheet has been accepted. A real Christensen export must be supplied and run
through the staging screen before release proof can claim it passed.
