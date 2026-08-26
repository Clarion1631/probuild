# Procurement V1: Build Order and Schema Decision Record

**Status:** Part 1 design gate — no DDL and no production mutation authorized by this document.

**Prepared:** 2026-08-26 10:32 PDT

## Decision in one sentence

Build procurement around a new, evidence-backed `MaterialRequirement` record. Keep existing `Vendor`, `PurchaseOrder`, `PurchaseOrderItem`, `EstimateItemPurchaseOrder`, `Expense`, `Takeoff`, and `TaskMaterial` contracts intact. Do not repurpose any of their status fields as the Kira workflow.

This is a build order, not permission to run a migration. The pre-DDL contract and its reviewer gates remain required.

## Authority and evidence read

This decision record reconciles:

1. `C:\Users\jat00\workspaces\golden-touch\docs\PROCUREMENT-BUILDOUT-BRIEF-2026-08-26.md`
2. `C:\Users\jat00\workspaces\golden-touch\docs\PROCUREMENT-PIPELINE-VISION.md`
3. `MATERIAL-STATUS-WORKFLOW.md` (Kira v2, 2026-08-24)
4. `PROCUREMENT-PIPELINE-SCHEMA-DESIGN-FINAL.md` and `PROCUREMENT-PIPELINE-SCHEMA-DESIGN-FINAL-REVISED.md`
5. `PROCUREMENT-MATERIAL-GATE-PRE-DDL-CONTRACT-R2.md`
6. Both available Codex rereviews of the revised final design:
   - `CODEX-PROCUREMENT-REVISED-FINAL-REREVIEW.txt`
   - `CODEX-PROCUREMENT-REVISED-FINAL-REREVIEW-2.txt`
7. The current `prisma/schema.prisma`, `src/lib/qbo-expense-sync.ts`, and API routes at commit `adc3763aa86a56f40914acf1df183056395595f4`.

The reviewed designs are useful input, but the current schema and sync code decide what already exists. Where they conflict, the implementation must preserve the live contract and record the discrepancy rather than silently overwrite it.

## Production baseline — API-only reality check

Collected 2026-08-26 10:32 PDT through the live ProBuild API. No SQL, direct database connection, Prisma console, or dashboard count was used.

| Surface | Result | How it was observed | Consequence |
|---|---:|---|---|
| Projects | 79 | `GET /api/projects` returned 200 | Purchase-order collection was scoped across all 79 project IDs. |
| Vendors | 26 | `GET /api/vendors` returned 200 | Vendor master data exists and must remain the PO vendor authority. |
| Takeoffs | 0 | `GET /api/takeoffs` returned 200 | V1 must support XLSX/manual evidence without assuming a Takeoff exists. |
| Purchase orders | 30 | `GET /api/purchase-orders?projectId=…` for all 79 projects; all responses 200 | Existing purchase-order records need additive integration, not a replacement. |
| Purchase-order items | 33 | Same 79-project API sweep | A PO item has quantity/cost data but no material-requirement relation today. |
| Expenses | not countable by the exposed API | `GET /api/expenses` returned 405; the route exposes write behavior, not a list/count API | Do not invent an Expense count or use the database to get one. Add a protected read/count endpoint before a later migration needs this baseline. |
| Estimate-item/PO links | not countable by the exposed API | There is no exposed list/count endpoint for `EstimateItemPurchaseOrder` | Same rule: add a protected count endpoint; do not substitute a direct DB query. |
| PO messages/files | not countable by the exposed API | No list/count endpoint was exposed | Treat as existing evidence containers, not migration targets. |

The purchase-order sweep returned no failed project calls. The 30/33 counts are therefore complete for the exposed per-project route at the stated time.

## What already exists — preserve it

### Vendor and purchase orders

`Vendor` is the vendor master. `PurchaseOrder` already requires `projectId` and `vendorId`; deleting a vendor is restricted, not cascaded. A PO already owns `items`, `files`, `messages`, `expenses`, the legacy estimate-item relation, and the newer `EstimateItemPurchaseOrder` relation.

`PurchaseOrder.status` is **not** the Kira material status. It is a document/order lifecycle with only `Draft`, `Sent`, `Received`, and `Cancelled`. Retaining that distinction avoids claiming that one received PO proves every material package is delivered and checked.

`PurchaseOrderItem` has description, quantity, unit cost, total, display order, and optional cost code/type. It has no link to a material requirement. That missing line-level relationship is the narrow additive gap.

### Existing estimate-to-PO linkage

`EstimateItemPurchaseOrder` already allows a many-to-many relationship between estimate items and POs and has a unique `(estimateItemId, purchaseOrderId)` constraint. It replaces the old one-PO-per-estimate-item cap.

Do not create a second estimate-item/PO join or backfill a duplicate. Any procurement view that needs estimate context reads this established join. A later requirement-to-PO-item link is separate because an estimate line and a physical material package are not the same thing.

### Expenses and QBO sync

`Expense` already has optional `purchaseOrderId`, plus a nullable unique `qbPurchaseId` used to preserve finalized QBO money-out identity. The schema supports a manual PO-to-receipt/expense link, but that link cannot be assumed to be populated for QBO-imported expenses.

The current QBO expense sync writes an expense with `qbPurchaseId`, `qbSyncToken`, `qbSyncedAt`, `estimateId`, amount, vendor text, date, description, and `Reviewed` status. It **does not write `purchaseOrderId`**. This is correct evidence that a QBO purchase is not automatically matched to a ProBuild PO today.

V1 must not guess a PO match from vendor text, amount, or date. The first receipt-linking implementation must require an explicit PO selection or a separately reviewed, deterministic matching contract. It must retain `qbPurchaseId` idempotency and may only add a link after that check.

### Takeoffs and task materials

`Takeoff` is optional to a project or lead and currently has zero production rows. It can feed evidence when present, but cannot be the required V1 intake source.

`TaskMaterial` is a schedule-task checklist with lower-case `pending | staged | missing | resolved` statuses. It is not a procurement record, lacks vendor/PO/evidence/approval fields, and must not be renamed or overloaded. It may later display a material requirement summary by project/phase, but it remains a separate scheduling surface.

## The V1 procurement contract

### New record: `MaterialRequirement`

Create a project-scoped, stable, human-readable material/package record. It is the system of record for the Kira workflow and for whether a phase has evidence-backed material readiness.

Required fields:

- Stable immutable ID; `projectId`; material/package name; optional phase/location.
- Quantity and unit when known; neither may be fabricated from schedule text.
- `primaryStatus` from the exact controlled vocabulary below.
- `underlyingStage` only when `primaryStatus = DELAYED`, so the exception does not erase the true stage.
- Evidence URL/reference, evidence type, evidence date, `lastVerifiedAt`, and verifier. These fields are nullable for a `REQUESTED` record whose `escalationState = DATA GAP`; they become required when a transition claims evidence-backed procurement progress.
- `nextAction`, `actionOwner`, and `nextActionDueAt` for every non-closed row.
- `escalationState` and `exceptionBlocker` where required.
- Optional `vendorId`; optional links to takeoff, estimate item, source import row, and schedule task. All are nullable because a valid request can begin with a data gap.
- Created/updated/audit actor and timestamps.

Primary status values are exactly the Kira v2 controlled vocabulary:

`REQUESTED`, `QUOTED`, `APPROVED`, `ORDERED`, `SHIPPED`, `RECEIVED`, `DELAYED`, `CLOSED`.

The normal transition is:

`REQUESTED → QUOTED → APPROVED → ORDERED → SHIPPED → RECEIVED → CLOSED`

`DELAYED` is an evidence-backed exception overlay. When it is the only field shown, `underlyingStage` and `exceptionBlocker` are mandatory. A schedule candidate alone is never enough to advance a status or show RED.

Escalation values are exactly:

`CLEAR`, `DATA GAP`, `SCHEDULE CHECK`, `AMBER`, `RED`.

### New append-only evidence and event records

Use separate append-only records rather than putting mutable history in free text:

- `MaterialEvidence`: requirement ID, evidence kind, file/URL/reference, captured date, source actor, optional vendor/PO/expense relation, and note.
- `MaterialStatusEvent`: requirement ID, from status, to status, underlying stage when delayed, escalation state, evidence ID, changed by, and timestamp.

A status change without supporting evidence must fail server-side except when creating a `REQUESTED` record with `escalationState = DATA GAP`. `DATA GAP` is never a primary status. This is the trust boundary that stops a stale schedule or oral statement from becoming a false delivery fact.

### New narrow association joins

Do not add an ambiguous single foreign key where the real cardinality is many-to-many.

1. `MaterialRequirementPurchaseOrderItem` links a material requirement to one or more `PurchaseOrderItem` rows. It may carry ordered quantity and a note. This is the line-level evidence missing from the existing PO models.
2. `MaterialRequirementExpense` links a requirement to one or more existing `Expense` rows only after an explicit, reviewed PO/receipt association. It does not replace `Expense.purchaseOrderId` or the QBO unique identity.
3. `MaterialRequirementSource` records XLSX row provenance (import ID, source filename/hash, sheet, row, normalized fields, and parse warnings). Keep raw imported value plus normalized value; never silently overwrite source truth.

These links let one purchase order and one receipt cover several material packages while keeping the financial record authoritative in `Expense` and the operational record authoritative in `MaterialRequirement`.

## XLSX extraction belongs before broad workflow rollout

The build brief requires spreadsheet extraction. Build it before any bulk workflow UI or data seeding:

1. Upload and preserve the original XLSX file through the approved Storage path.
2. Create an import run with source hash, uploader, parser version, and job/project selection.
3. Parse rows to staging/provenance records; report blank project IDs, ambiguous package names, invalid quantities, and conflicting rows as `DATA GAP` rather than choosing for the user.
4. Show a review screen with source-cell provenance and a single explicit “create requirements” action.
5. Only then create `MaterialRequirement` rows in one transaction and emit initial `REQUESTED` events/evidence.

No parser may infer `QUOTED`, `APPROVED`, `ORDERED`, `SHIPPED`, or `RECEIVED` from a worksheet label unless the required written evidence is linked.

## Exact implementation order

### Gate 0 — pre-DDL proof

- Reconcile all items in the R2 pre-DDL contract and both Codex rereview reports into implementation tests.
- Add protected API count/read support for Expenses and estimate-item/PO links so the required production baseline can be measured without direct database access.
- Produce and verify a backup before any destructive operation. There is no destructive operation in V1’s proposed additive schema, but this gate still applies to corrective or rollback work.
- Write guarded, idempotent SQL following the repo's `scripts/apply-*.mjs` convention: require `--yes`, `--expect-db`, and `--expect-host`; verify target identity before mutation; and verify the applied shape afterward. Do **not** run `prisma migrate`.
- Obtain required independent reviews before merging money-path code: Codex CLI and Kimi CLI.

### Slice 1 — schema and server contract

- Add the new requirement, evidence, event, source, and narrow join models.
- Add indexes for project/status, project/phase, next-action due date, escalation, PO-item join, and source import row.
- Implement server-side transition validation and actor/audit recording.
- Write unit tests for allowed transitions, DELAYED overlay requirements, evidence requirements, and idempotent XLSX row creation.

### Slice 2 — XLSX import and review

- Add upload, parse, staged validation, and review/commit endpoints.
- Preserve raw source values and row references.
- Add tests for duplicate re-import, invalid rows, blank project IDs, and all data-gap behavior.

### Slice 3 — operational material board

- Build the project material board with status, evidence, owner, next action, due date, escalation, and phase exposure.
- Surface `SCHEDULE CHECK` as amber triage; do not present it as a delivery claim.
- Keep PO document status and TaskMaterial checklist status visibly separate.

### Slice 4 — existing-record integration

- Add explicit PO-item-to-material linking.
- Add explicit receipt/expense linking that protects QBO `qbPurchaseId` idempotency.
- Add non-destructive views that traverse `EstimateItemPurchaseOrder`; do not backfill a new estimate-to-PO relation.

### Slice 5 — rollout and proof

- Seed only reviewed spreadsheet rows; no blind production backfill.
- Verify role boundaries: Richard approval, Kira tracking/evidence, Mac read-only verified dates, and Beverly finance facts.
- Browser-verify the live user paths, capture screenshots, and have an independent reviewer verify the evidence before declaring the feature shipped.

## Blockers that must remain blockers

| Blocker | Why it blocks | Required resolution |
|---|---|---|
| Expense and estimate-item/PO-link counts are not exposed by API | The stated API-only baseline cannot be completed honestly for those tables. | Add authenticated read/count endpoints with least-privilege response shape, then record counts. |
| No live Takeoff rows | Takeoff cannot be assumed as the sole intake source. | XLSX/manual import stays first-class; takeoff linkage remains optional. |
| QBO sync has no PO-match contract | Automatic match would misstate money and receipt provenance. | Explicit user link or separately reviewed deterministic matching design and tests. |
| Existing status vocabularies conflict | Reusing PO or TaskMaterial statuses creates false operational claims. | Maintain separate Kira enum/validation and clear UI labels. |
| Existing PO items lack material-requirement relation | PO-level links cannot prove which package was ordered or received. | Add the narrow join table; do not alter or duplicate the estimate-item/PO join. |
| XLSX source quality is unknown | A broad import can create false material facts. | Stage, validate, show provenance, and route ambiguity to `DATA GAP`. |
| Pre-DDL contract/reviewer findings | A money-adjacent schema change must not bypass review or recovery controls. | Close every R2 and rereview item with tests and a guarded DDL plan before merge. |

## Explicit non-goals for V1

- No automatic vendor outreach or city communication.
- No automatic PO approval or purchase commitment.
- No profitability/budget reporting in the material tracker.
- No inferred receipt, ETA, or schedule-blocked claim.
- No replacement of QBO, Expense, Vendor, PurchaseOrder, or estimate-to-PO authority.
- No unreviewed backfill and no destructive data operation.

## Acceptance evidence for the next implementation card

The first implementation card may start only when it names the exact guarded DDL script (following the `scripts/apply-*.mjs` identity-check pattern), the protected count endpoint(s), the transition test matrix, the XLSX parser fixtures, the QBO receipt-linking rule, and the two independent reviewer outputs. A completed build must include browser evidence of the live material board and a reviewer-confirmed verification record.
