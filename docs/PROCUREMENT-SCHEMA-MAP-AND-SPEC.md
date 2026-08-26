# Procurement Schema Map and Right-Sized V1 Spec

## Decision and scope

Build one additive, project-scoped `MaterialItem` record. It is the operational material/package record for the Kira workflow; it does not replace or overload `Vendor`, `PurchaseOrder`, `PurchaseOrderItem`, `EstimateItemPurchaseOrder`, `Expense`, `Takeoff`, or `TaskMaterial`.

This is a design record only. It authorizes no DDL, application code, production mutation, vendor outreach, or Chat message. The companion sequence is [PROCUREMENT-V1-BUILD-ORDER.md](./PROCUREMENT-V1-BUILD-ORDER.md). This schema map is the sole V1 naming and relationship authority.

## Existing contracts that V1 preserves

| Model | Verified current contract | V1 rule |
|---|---|---|
| `Takeoff` / `TakeoffFile` | Optional project or lead; `Draft`, `In Progress`, `Completed`; file `mimeType` | Optional source only; never the sole intake path. |
| `Vendor` | Existing master; default `ACTIVE`; delete restricted | Reuse. A future simple `kind` is acceptable only if needed; no subcontractor graph. |
| `PurchaseOrder` | Project and required vendor; `Draft`, `Sent`, `Received`, `Cancelled`; `totalAmount`, terms, files, messages, expenses | Reuse. Document status is never material readiness. |
| `PurchaseOrderItem` | Description, quantity, `unitCost`, `total`, ordering, optional cost-code/type | Reuse with an explicit PO-item association. |
| `EstimateItemPurchaseOrder` | Existing unique `(estimateItemId, purchaseOrderId)` join | Read for context; never duplicate or blind-backfill. |
| `TaskMaterial` | Schedule checklist: `pending`, `staged`, `missing`, `resolved` | Remains a schedule surface, not procurement truth. |
| `Expense` | Required estimate, optional `purchaseOrderId`, unique QBO identity | Financial truth; link only through reviewed association. |

### QBO / receipt boundary

The current QBO expense sync uses vendor text, does not set a ProBuild vendor ID or `purchaseOrderId`, and keys financial idempotency by `qbPurchaseId`. Its customer-name-to-project result is triage only: a `MaterialItemExpense` reviewer must independently confirm the project and may not treat the existing expense's estimate/project or `Expense.status` as that proof. `QboPurchaseClassification` is import-triage metadata, not MaterialItem evidence or review evidence. V1 must never infer a PO/receipt association from vendor text, amount, date, or that heuristic project match.

No current retained API-sweep artifact proves a complete production baseline for procurement. Before DDL or rollout, the implementation card must add least-privilege authenticated count/read support, make a dated measurement, and retain that measurement with the card. Direct production SQL, Prisma console output, and dashboard estimates are not substitutes.

## Canonical V1 record set

All names below are canonical. There is no `MaterialRequirement` model.

### `MaterialImportRun` and `MaterialImportRow`

XLSX data exists in staging before a material item exists, so staging is explicit rather than hidden in `MaterialItemSource`.

- `MaterialImportRun`: immutable ID, selected `projectId`, source file reference/hash, parser version, uploader, started/completed timestamps, and status.
- `MaterialImportRow`: import-run ID, source sheet/row/cell coordinates, raw and normalized values, parse warnings, selected-project check result, resolution state, and actor/timestamps.

A user selects the project when creating the import run. A row with blank project data remains a staging `DATA GAP`; it creates no `MaterialItem`. A row with an explicit project that conflicts with the selected project is blocked until a user resolves it with a recorded reason. The run's selected project is the only project assignment allowed at commit.

### `MaterialItem`

A stable, human-readable record with immutable ID and immutable `projectId`; material/package name; optional phase/location; quantity/unit only when known; SKU; quote reference; required-by date; optional vendor; next action/owner/due date; status; nullable `underlyingStage` and `exceptionBlocker` permitted only while status is `DELAYED`; escalation; notes; and actor/timestamps.

Optional source links are allowed only under these integrity rules:

- An estimate/estimate item must belong to the material item's project.
- A takeoff may link only when its project equals the material item's project; a lead-only takeoff is not linkable until project resolution.
- A schedule task must belong to the material item's project.
- A PO item must inherit a PO whose project equals the material item's project.
- An expense must belong to an estimate whose project equals the material item's project.

The implementation enforces these checks in one transaction and in guarded SQL where a cross-table constraint cannot express them. A rejected link is an error, never a silent reassignment.

`MaterialItem` has no mutable direct `purchaseOrderId`; PO evidence is line-level via the explicit join below.

### Status, escalation, evidence, and audit

Primary statuses are exactly:

`REQUESTED`, `QUOTED`, `APPROVED`, `ORDERED`, `SHIPPED`, `RECEIVED`, `DELAYED`, `CLOSED`.

Normal progression: `REQUESTED → QUOTED → APPROVED → ORDERED → SHIPPED → RECEIVED → CLOSED`.

`DELAYED` requires an `underlyingStage` and written `exceptionBlocker`. Escalation is separate: `CLEAR`, `DATA GAP`, `SCHEDULE CHECK`, `AMBER`, `RED`. `DATA GAP` begins at `REQUESTED` and is never a primary status. Every non-closed item requires next action, owner, and due date.

- `MaterialItemEvidence` holds only durable source/quote/approval/shipping/receipt proof (kind, reference, captured date, source actor, note). It does not create a PO or expense association.
- `MaterialItemEvent` is append-only and covers status, escalation, field, link, import-resolution, and correction changes. It records event kind, changed field/value snapshot where applicable, from/to status, evidence ID when applicable, actor, reason, timestamp, and idempotency/correlation key.

Every normal initial `REQUESTED` item must create `MaterialItemEvidence(kind=SOURCE_IMPORT)` from its reviewed staging row and a matching initial event. The only evidence-free start is `REQUESTED` with `DATA GAP`. Any later claimed procurement progress requires evidence. Schedule text and verbal statements cannot advance status or display `RED`.

### Explicit association records

- `MaterialItemPurchaseOrderItem`: material item + `PurchaseOrderItem`, ordered quantity, note, audit fields. It is the only authoritative operational PO link.
- `MaterialItemExpense`: material item + `Expense` plus required `reviewDecision`, `reviewedByUserId`, `reviewedAt`, `reviewEvidenceId`, reason, and audit fields. It is created only after an explicit human review; `Expense.status` is not acceptable review proof.
- `MaterialItemSource`: material item + committed import row, file/hash, source coordinates, raw/normalized snapshot, and audit fields.

These records have unique/idempotent keys. The server rechecks the same-project rules before writing each relation. Evidence may cite a durable receipt or PO file, but it cannot bypass the reviewed join.

## Enforceable authority boundaries

Names describe work assignments, never authorization. The implementation must resolve each actor through actual account roles/permissions and test every server action:

- Approval, vendor choice, and any future outbound decision: `ADMIN` or `MANAGER` authority.
- Tracking/evidence entry: authorized staff role, constrained to evidence and transition rules.
- Finance/expense review: `FINANCE` or `ADMIN` authority; the reviewer identity is stored on `MaterialItemExpense`.
- Read-only verified-date presentation: a server-projected read surface; no client-side name check.

“Richard,” “Kira,” “Mac,” and “Beverly” are operating assignments, not role names and not access-control checks. The existing PO-create and expense-approve routes do not establish this V1 authority model; V1 must use new or explicitly tightened server actions rather than reusing their current authorization unchanged.

## Input, UI, and deferrals

Before implementation, create and version a repository input contract at `docs/procurement/INPUT-CONTRACT.md` and fixtures under `tests/fixtures/procurement/xlsx/`. The contract must identify both supported layout versions, required columns, source-file acceptance rules, storage adapter/retention behavior, and the staging-to-commit action. Until then, no claim is made that an unknown XLSX layout is supported.

The board displays phase, item, status, evidence, owner, next action/due date, required-by risk, escalation, and explicit links. It reads already-filed PO communication only; it must not invoke `src/app/api/projects/[id]/purchase-orders/[poId]/send-message/route.ts`, compose a message, or create a Chat/vendor message.

Defer approval-revision graphs, immutable PO revisions, UOM conversion, automated arrival gates, heuristic QBO matching, quote-price history, OCR/AI extraction, warehouse inventory, automation, and profitability reporting.

## Implementation entry gate

The implementation card must name guarded additive SQL; protected count endpoints; versioned XLSX contract and fixtures; transition, authorization, same-project, audit, and lock-order tests; explicit reviewed receipt-link rule; backup verification for any destructive correction; and fresh Codex/Kimi review outputs. It must prohibit both `prisma migrate` and `prisma db push`; after guarded DDL verification, from the target repository root run `powershell.exe -NoProfile -Command ".\\node_modules\\.bin\\prisma generate"` on Windows, never Git Bash. Non-Windows CI uses `npx prisma generate` from the repository root. Production shipment still requires browser-verified live evidence and independent review.