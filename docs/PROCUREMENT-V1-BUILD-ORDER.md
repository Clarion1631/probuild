# Procurement V1 Build Order

## Purpose

This sequence implements the canonical `MaterialItem` contract in [PROCUREMENT-SCHEMA-MAP-AND-SPEC.md](./PROCUREMENT-SCHEMA-MAP-AND-SPEC.md). That map is the sole V1 authority for model names, fields, status vocabulary, links, staging records, and integrity rules.

This document authorizes no DDL, code, production mutation, vendor outreach, or Chat message.

## Non-negotiable boundaries

- Preserve `Vendor`, `PurchaseOrder`, `PurchaseOrderItem`, `EstimateItemPurchaseOrder`, `Expense`, `Takeoff`, and `TaskMaterial` contracts.
- PO document lifecycle and TaskMaterial schedule status are not Kira material status.
- Never match QBO/vendor text, amount, date, or a QBO customer-name project match to a PO/receipt. A `MaterialItemExpense` reviewer independently confirms its project; `QboPurchaseClassification` and `Expense.status` are not review evidence. QuickBooks is read-only from V1.
- A parser stages data. It never assigns a material item to a blank/conflicting project or manufactures status, quantity, vendor, quote, ETA, receipt, or evidence.
- No destructive operation proceeds without a verified backup.
- New money and price snapshots use integer cents, never floating point. V1 creates no client-facing action and Kira sends no vendor/outbound message without a separate current Richard confirmation plus `ADMIN` or `MANAGER` authorization; outbound remains deferred.
- Do not run `prisma migrate` or `prisma db push`. From the target repository root after guarded DDL verification, run `powershell.exe -NoProfile -Command ".\\node_modules\\.bin\\prisma generate"` on Windows; never use Git Bash. Non-Windows CI uses `npx prisma generate` from the repository root.

## Gate 0 — reproducible inputs and pre-DDL proof

1. Create `docs/procurement/INPUT-CONTRACT.md` and versioned fixtures in `tests/fixtures/procurement/xlsx/`. They must define both supported XLSX layout versions, columns, source acceptance, storage adapter/retention, staging/commit behavior, and the immutable ingest identity/hash for each accepted input, including the persisted direct-upload request UUID used for retry.
2. Add least-privilege authenticated count/read endpoints, make a dated baseline measurement, and attach that artifact to the implementation card. Historical planning numbers are not current evidence.
3. Name a guarded additive script such as `scripts/apply-procurement-material-item.mjs`. It requires `--yes`, `--expect-db`, and `--expect-host`, checks target identity, uses idempotent SQL/checks/indexes, verifies applied shape, then runs the approved PowerShell Prisma-generate step.
4. Write the test matrix: transitions and rejection by authoritative evidence type/provenance, including approval-to-exact-quote-version binding and the configured Richard principal; delayed/data-gap and legacy-unverified-receipt rules; initial source evidence; idempotency/retry/replacement for direct XLSX uploads, Gmail attachments, versioned Drive files, manual Richard entries, and PO revisions; source/project-scope replay conflicts; field/audit events; import project precedence/conflicts; same-project links; authorization/configuration rotation; reviewed expense links; immutable QBO expense snapshots, QBO project-conflict handling, and link-creation/remap/correction race serialization; and deterministic lock ordering.
5. Obtain fresh Codex and Kimi reviews for money-adjacent schema/code. Independently verify each claim before acting on it.

## Slice 1 — additive schema and authorization

1. Add exactly these records: `MaterialImportRun`, `MaterialImportRow`, `MaterialItem`, `MaterialItemEvidence`, `MaterialItemEvent`, `MaterialItemPurchaseOrderItem`, `MaterialItemExpense`, `MaterialItemSource`, and singleton `ProcurementAuthorityConfig`. `MaterialItemExpense` includes immutable required `lockedExpenseEstimateId` and `lockedProjectId`, unique `(materialItemId, expenseId)`, and reverse index `[expenseId]`; `MaterialImportRun` includes non-null immutable `ingestPath`, `requestKey`, `sourceHash`, and `commitScopeHash` with a unique path/key constraint; `MaterialItem` owns nullable lifecycle-controlled `receivedAt`; `MaterialItemEvidence` includes non-null immutable `ingestPath`, `sourceIdentity`, `sourceHash`, and (for approval evidence) immutable `approvedQuoteEvidenceId`; `MaterialItemPurchaseOrderItem` has an immutable PO-revision line key; and `MaterialItemEvent` has a non-null immutable correlation key unique per material item.
2. Add indexes for import resolution, project/status, project/phase, next-action due date, escalation, PO-item join, and source import row.
3. Enforce the map's same-project rules in each mutation transaction. Reject a project mismatch; do not silently relink an estimate, takeoff, schedule task, PO item, or expense.
4. Enforce server authorization using actual roles/permissions: approval/vendor decisions require `ADMIN` or `MANAGER`; expense review requires `FINANCE` or `ADMIN`; `RICHARD_CONFIRMATION` requires the authenticated principal whose immutable user ID matches `ProcurementAuthorityConfig.richardUserId`; only `ADMIN` may rotate that binding through an audited action. Names are never authorization. Existing PO-create and expense-approve authorization is insufficient for this rule, so create or explicitly tighten V1 server actions. Test allow and deny paths.
5. Add append-only `MaterialItemEvent` entries for every field, transition, association, import-resolution, and correction mutation with actor, timestamp, reason, and prior/new snapshot as applicable.
6. Make `syncQboExpenses` the sole QBO-update owner. It, QBO-originated `MaterialItemExpense` link creation, and every authorized correction transaction call the shared `lockQboExpense` helper from `src/lib/qbo-expense-sync.ts`, retaining its `pg_advisory_xact_lock(hashtextextended($1, 0))` lock identity from `qbPurchaseId`, before reading either the expense or its links; do not substitute `hashtext` or another lock. Acquire that QBO lock first, then any material locks in ascending immutable material-ID order. Before an incoming QBO estimate update, the sync reads all linked immutable snapshots. A different incoming estimate/project is a per-purchase `PROCUREMENT_LINKED_EXPENSE_PROJECT_CONFLICT` outcome in the aggregate sync result, changes neither `Expense.estimateId` nor procurement links, and appends one deterministically keyed `QBO_PROJECT_CONFLICT` event per affected material using `qbPurchaseId`, `qbSyncToken`, and incoming estimate ID. Only a new audited `FINANCE`/`ADMIN` correction transaction under that same lock may resolve it; QBO retry cannot.

## Slice 2 — XLSX staging and review

1. Preserve each accepted XLSX through the input contract's approved storage adapter and create a `MaterialImportRun` using the direct-upload request UUID retained by the client for retries.
2. Parse to `MaterialImportRow`, retaining source coordinates, raw/normalized values, warnings, and selected-project validation.
3. Blank project data remains a row-level `DATA GAP`; it does not create `MaterialItem`. A row whose explicit project conflicts with the selected import-run project blocks until a user records a resolution.
4. Show reviewed source provenance and one explicit commit action.
5. Commit creates `MaterialItem`, `MaterialItemSource`, `MaterialItemEvidence(kind=SOURCE_IMPORT)`, and matching initial `MaterialItemEvent` in one transaction. Evidence-free creation is only permitted for `REQUESTED` + `DATA GAP`.
6. Enforce every named ingest identity before parse/commit: direct XLSX request UUID retained across retry; Gmail `messageId + attachmentId`; Drive `fileId + immutableRevisionId`, or only when that ID is unavailable `fileId + SHA-256 of retained immutable file bytes`; manual Richard request UUID; and PO `purchaseOrderId + immutableRevisionId-or-canonical-revision-hash`. Store that unsuffixed canonical key and an immutable `commitScopeHash` (selected project plus every non-file result-affecting input) on the run. When one source creates multiple material items, each `MaterialItemEvidence.sourceIdentity` must be the canonical key plus a stable source-item suffix: a `MaterialImportRow` ID for XLSX/attachment/Drive rows, an immutable PO-revision line key for a PO revision (not a recreated physical PO-item ID), or caller-supplied immutable entry ID for a manual batch. Exact duplicate identity/source-hash/scope-hash retries return the prior result without duplicate rows/events. Same identity with changed content or scope is a conflict/hold, never an overwrite; an explicit reviewed replacement creates a new immutable evidence version, supersedes the old proof by event, and rechecks dependent states. Reconcile referenced PO lines in place; do not delete/recreate them on an unrelated PO save. Test one multi-item source for distinct stable evidence identities as well as all retry/replacement races.

## Slice 3 — operational board

1. Render phase, item, primary status, evidence, owner, next action/due date, required-by date, escalation, and explicit vendor/quote/PO/receipt links.
2. Render `SCHEDULE CHECK` as amber triage, not a delivery or schedule-blocking claim.
3. Keep PO and TaskMaterial statuses visibly separate from material status.
4. Provide server-projected read-only verified-date views; do not implement name-based client-side permissions.

## Slice 4 — integrations without semantic drift

1. Link PO evidence only through `MaterialItemPurchaseOrderItem`; no material-level mutable `purchaseOrderId`.
2. Link finance evidence only through `MaterialItemExpense` after an authorized reviewer records decision, identity, timestamp, reason, and `MaterialItemEvidence` reference. QBO `qbPurchaseId` idempotency remains untouched.
3. Read `EstimateItemPurchaseOrder` for context without creating a duplicate relation or blind backfill.
4. Show already-filed PO communication in read-only fashion only. Do not call `src/app/api/projects/[id]/purchase-orders/[poId]/send-message/route.ts`, compose a vendor email, or create any Chat/vendor message.
5. Advance `QUOTED`, `APPROVED`, `ORDERED`, `SHIPPED`, and `RECEIVED` only with the map's typed current authoritative evidence. Imports, AI/OCR output, stale/superseded evidence, and unconfirmed manual claims reject rather than advance. Every manual path includes current Richard confirmation. `RECEIVED` additionally requires a delivery/receipt date; incomplete legacy receipt claims remain `DELAYED`/`LEGACY_RECEIPT_UNVERIFIED` with the defined escalation and remediation route.

## Slice 5 — rollout and proof

1. Create material items only from reviewed staged rows. No blind production import.
2. Run tests in the permitted non-production environment; E2E never targets production.
3. For a production shipment, browser-verify live user paths and authorization gates, capture evidence, and obtain independent reviewer confirmation before calling it done.

## Explicit non-goals

No automatic vendor/city/client communication, PO approval, commitment, inferred ETA/receipt/block, heuristic QBO matching, profitability reporting, UOM conversion, inventory, OCR/AI extraction, unreviewed backfill, immutable PO revision graph, or destructive data operation. QBO writes are out of scope; this feature reads QBO-originated data only through guarded sync behavior.

## Implementation-card acceptance evidence

Before work begins, the card must identify the guarded script, PowerShell Prisma-generation command, protected-count artifact, input contract and fixtures, typed transition/rejection evidence tests, idempotency/retry/replacement tests, immutable QBO-snapshot/conflict tests, authorization/same-project/audit/lock-order tests, reviewed receipt-link rule, backup rule, and current Codex/Kimi reviews. A production release requires browser-verified evidence plus reviewer confirmation.