# Procurement V1 Build Order

## Purpose

This sequence implements the canonical `MaterialItem` contract in [PROCUREMENT-SCHEMA-MAP-AND-SPEC.md](./PROCUREMENT-SCHEMA-MAP-AND-SPEC.md). That map is the sole V1 authority for model names, fields, status vocabulary, links, staging records, and integrity rules.

This document authorizes no DDL, code, production mutation, vendor outreach, or Chat message.

## Non-negotiable boundaries

- Preserve `Vendor`, `PurchaseOrder`, `PurchaseOrderItem`, `EstimateItemPurchaseOrder`, `Expense`, `Takeoff`, and `TaskMaterial` contracts.
- PO document lifecycle and TaskMaterial schedule status are not Kira material status.
- Never match QBO/vendor text, amount, or date to a PO/receipt. `MaterialItemExpense` requires the reviewed association record defined in the schema map.
- A parser stages data. It never assigns a material item to a blank/conflicting project or manufactures status, quantity, vendor, quote, ETA, receipt, or evidence.
- No destructive operation proceeds without a verified backup.
- Do not run `prisma migrate` or `prisma db push`. After guarded DDL verification, run `powershell.exe -NoProfile -Command "npx prisma generate"`; never run Prisma generation in Git Bash.

## Gate 0 — reproducible inputs and pre-DDL proof

1. Create `docs/procurement/INPUT-CONTRACT.md` and versioned fixtures in `tests/fixtures/procurement/xlsx/`. They must define both supported XLSX layout versions, columns, source acceptance, storage adapter/retention, and staging/commit behavior.
2. Add least-privilege authenticated count/read endpoints, make a dated baseline measurement, and attach that artifact to the implementation card. Historical planning numbers are not current evidence.
3. Name a guarded additive script such as `scripts/apply-procurement-material-item.mjs`. It requires `--yes`, `--expect-db`, and `--expect-host`, checks target identity, uses idempotent SQL/checks/indexes, verifies applied shape, then runs the approved PowerShell Prisma-generate step.
4. Write the test matrix: transitions; delayed/data-gap rules; initial source evidence; idempotency; field/audit events; import project precedence/conflicts; same-project links; authorization; reviewed expense links; and deterministic lock ordering.
5. Obtain fresh Codex and Kimi reviews for money-adjacent schema/code. Independently verify each claim before acting on it.

## Slice 1 — additive schema and authorization

1. Add exactly these records: `MaterialImportRun`, `MaterialImportRow`, `MaterialItem`, `MaterialItemEvidence`, `MaterialItemEvent`, `MaterialItemPurchaseOrderItem`, `MaterialItemExpense`, and `MaterialItemSource`.
2. Add indexes for import resolution, project/status, project/phase, next-action due date, escalation, PO-item join, and source import row.
3. Enforce the map's same-project rules in each mutation transaction. Reject a project mismatch; do not silently relink an estimate, takeoff, schedule task, PO item, or expense.
4. Enforce server authorization using actual roles/permissions: approval/vendor decisions require `ADMIN` or `MANAGER`; expense review requires `FINANCE` or `ADMIN`; names are never authorization. Test allow and deny paths.
5. Add append-only `MaterialItemEvent` entries for every field, transition, association, import-resolution, and correction mutation with actor, timestamp, reason, and prior/new snapshot as applicable.

## Slice 2 — XLSX staging and review

1. Preserve each accepted XLSX through the input contract's approved storage adapter and create a `MaterialImportRun`.
2. Parse to `MaterialImportRow`, retaining source coordinates, raw/normalized values, warnings, and selected-project validation.
3. Blank project data remains a row-level `DATA GAP`; it does not create `MaterialItem`. A row whose explicit project conflicts with the selected import-run project blocks until a user records a resolution.
4. Show reviewed source provenance and one explicit commit action.
5. Commit creates `MaterialItem`, `MaterialItemSource`, `MaterialItemEvidence(kind=SOURCE_IMPORT)`, and matching initial `MaterialItemEvent` in one transaction. Evidence-free creation is only permitted for `REQUESTED` + `DATA GAP`.

## Slice 3 — operational board

1. Render phase, item, primary status, evidence, owner, next action/due date, required-by date, escalation, and explicit vendor/quote/PO/receipt links.
2. Render `SCHEDULE CHECK` as amber triage, not a delivery or schedule-blocking claim.
3. Keep PO and TaskMaterial statuses visibly separate from material status.
4. Provide server-projected read-only verified-date views; do not implement name-based client-side permissions.

## Slice 4 — integrations without semantic drift

1. Link PO evidence only through `MaterialItemPurchaseOrderItem`; no material-level mutable `purchaseOrderId`.
2. Link finance evidence only through `MaterialItemExpense` after an authorized reviewer records decision, identity, timestamp, reason, and `MaterialItemEvidence` reference. QBO `qbPurchaseId` idempotency remains untouched.
3. Read `EstimateItemPurchaseOrder` for context without creating a duplicate relation or blind backfill.
4. Show already-filed PO communication in read-only fashion only. Do not call the PO send-message route, compose a vendor email, or create any Chat/vendor message.

## Slice 5 — rollout and proof

1. Create material items only from reviewed staged rows. No blind production import.
2. Run tests in the permitted non-production environment; E2E never targets production.
3. For a production shipment, browser-verify live user paths and authorization gates, capture evidence, and obtain independent reviewer confirmation before calling it done.

## Explicit non-goals

No automatic vendor/city communication, PO approval, commitment, inferred ETA/receipt/block, heuristic QBO matching, profitability reporting, UOM conversion, inventory, OCR/AI extraction, unreviewed backfill, or destructive data operation.

## Implementation-card acceptance evidence

Before work begins, the card must identify the guarded script, PowerShell Prisma-generation command, protected-count artifact, input contract and fixtures, transition/evidence/auth/same-project/audit/lock-order tests, reviewed receipt-link rule, backup rule, and current Codex/Kimi reviews. A production release requires browser-verified evidence plus reviewer confirmation.