# Procurement Schema Map and Right-Sized V1 Spec

**Decision:** build one additive, project-scoped `MaterialItem` record. Do not replace or overload existing purchasing, finance, takeoff, or schedule records. This is a specification only: no DDL, code, or production mutation is authorized.

**Evidence time:** 2026-08-26 10:32 PDT. Production figures below came only from live ProBuild API responses.

## Part 1 — What exists now

### Production baseline

| Surface | Production count | API evidence |
|---|---:|---|
| Projects | 79 | `GET /api/projects` → 200 |
| Vendors | 26 | `GET /api/vendors` → 200 |
| Takeoffs | 0 | `GET /api/takeoffs` → 200 |
| Purchase orders | 30 | 79 calls to `GET /api/purchase-orders?projectId=…`; 0 failures |
| Purchase-order items | 33 | Items returned by that same PO sweep |
| Expenses | not countable | `GET /api/expenses` → 405; route is write-only |
| EstimateItemPurchaseOrder links | not countable | no exposed list/count API |
| PO messages/files | not countable | no exposed list/count API |

Do not fill the unavailable counts with SQL, Prisma console, or a dashboard. Add a protected read/count endpoint before a later migration needs them.

### Existing model map

| Model | Existing fields/contract | Current surface | V1 decision |
|---|---|---|---|
| `Takeoff` / `TakeoffFile` | name, description, Draft/In Progress/Completed, optional project or lead, optional estimate, AI data; files have name/url/type/size | takeoff API and takeoff workflow | Optional source only; zero live rows means it cannot be the sole intake. |
| `Vendor` | contact/address/payment fields, ACTIVE status, tags/files | vendors API and purchasing UI | Reuse as vendor master. Add `kind` only if a simple vendor/sub classification is required; do not add a separate Sub table in V1. |
| `PurchaseOrder` | projectId, required vendorId, Draft/Sent/Received/Cancelled, total, terms, files, messages, expenses | purchase-order API and PO screens | Reuse. PO document status is not material readiness status. Vendor delete is restricted. |
| `PurchaseOrderItem` | description, quantity, unitCost, total, order, optional cost code/type | returned in PO API | Reuse. Add a narrow MaterialItem↔PO-item join; do not add a second estimate↔PO relation. |
| `EstimateItemPurchaseOrder` | existing many-to-many estimate-item↔PO join; unique `(estimateItemId,purchaseOrderId)` | estimate/PO actions | Read this relation for estimate context. Never duplicate/backfill it. |
| `PurchaseOrderMessage` | PO, sender/body, Gmail ID, attachment URL | PO communication surface | Reuse for filed PO comms. Add a small project-filed-comms note only when there is no PO yet. |
| `TaskMaterial` | schedule task, text/qty/unit/location; `pending/staged/missing/resolved` | schedule task UI | Do not overload. It is a schedule checklist, not a procurement ledger. |
| `Expense` | required estimate, optional item/cost coding/vendor text/receipt URL; unique QBO purchase ID; optional `purchaseOrderId` | expense write API; QBO sync | Reuse as financial truth. It may be explicitly linked to MaterialItem but never used to infer readiness. |

### QBO receipt/expense truth

`Expense.purchaseOrderId` is optional (`prisma/schema.prisma:603-604`), but QBO sync does **not** set it or a ProBuild `vendorId`: `QboExpenseWrite` contains only vendor text (`src/lib/qbo-expense-sync.ts:490-500`), and both upserts omit `purchaseOrderId` (`:1032-1042`, `:1078-1088`). `qbPurchaseId` remains the unique financial idempotency key. Never match a QBO receipt to a PO from vendor text, amount, or date. Require an explicit reviewed link.

## Part 2 — Additive V1 delta

### One new table: `MaterialItem`

`MaterialItem` is the project-level operational record. Fields: immutable ID; `projectId`; nullable `estimateId`, `estimateItemId`, `takeoffId`; phase/location; description; part number/SKU; quantity, unit, waste percent; `vendorId`; quote reference; nullable `purchaseOrderId`; requested/quoted/approved/ordered/shipped/received dates; required-by date; source file/hash/sheet/row; flags/notes; created/updated/audit actor.

Primary `status` is **only** Kira’s controlled vocabulary: `REQUESTED`, `QUOTED`, `APPROVED`, `ORDERED`, `SHIPPED`, `RECEIVED`, `DELAYED`, `CLOSED`. `DELAYED` needs underlying stage and written blocker. Escalation is separate: `CLEAR`, `DATA GAP`, `SCHEDULE CHECK`, `AMBER`, `RED`. A DATA GAP starts `REQUESTED`; it is never a primary status.

Add append-only `MaterialItemEvidence` and `MaterialItemStatusEvent`; nullable evidence fields are allowed only for a REQUESTED/DATA GAP start. Add one narrow `MaterialItemPurchaseOrderItem` join and an explicit `MaterialItemExpense` join. Do not alter existing PO, Expense, or EstimateItemPurchaseOrder semantics.

### Intake and user surfaces

1. XLSX import supports Richard’s two known layouts from the build brief. Preserve original file, hash, sheet/cell/row values and parser warnings; stage/review before one explicit commit. Invalid project, quantity, scope, or layout becomes DATA GAP, never a guessed fact.
2. One per-job procurement board: phase, item, Kira status, evidence, owner, next action/due date, required-by date, escalation, vendor/quote/PO/receipt links. Mac sees only verified dates. Richard owns approval/vendor/outbound. No outbound vendor/Chat automation.
3. Reuse `PurchaseOrderMessage` for PO-linked filed comms; use a compact project material note only before a PO exists.

### DDL plan

No `prisma migrate`. Use a new guarded `scripts/apply-procurement-material-item.mjs`, modeled on `scripts/apply-bank-ledger.mjs`: require `--yes --expect-db --expect-host`, verify database identity before mutation, use idempotent additive SQL/checks/indexes, verify shape afterward, and take a verified backup before any destructive corrective work. Generate Prisma client only after guarded DDL succeeds.

## Part 3 — Codex blocker deferral matrix

| Review blocker | V1 | Reason |
|---|---|---|
| approval-revision parent graph | DEFER | Overbuilt approval engine; Richard’s explicit approval evidence/date is sufficient for V1. |
| seed commands / production seeding | DO-IN-V1 (reviewed only) | XLSX staging needs idempotent reviewed creation; no blind seed/backfill. |
| immutable PO revisions | DEFER | Existing PO remains authority; preserve files/messages and avoid revision system until real revision volume exists. |
| UOM catalog/conversion | DEFER | Store unit as validated text; no conversion math without an approved catalog. |
| arrival-gate evaluator | DEFER | Board exposes written ETA/receipt and required-by risk; no automatic schedule gate until proven data exists. |
| lock ordering / concurrent transition protocol | DO-IN-V1 | Protect status/evidence/PO-item link writes with transaction, unique joins, and deterministic lock order. |
| QBO PO matching | DO-IN-V1 boundary only | Explicit reviewed association only; no heuristic matching. |
| expense/estimate-PO API counts | DO-IN-V1 prerequisite | Required to measure production baseline without DB access. |
| vendor/sub capability hierarchy | DEFER | Use `Vendor.kind` if needed; no subcontractor graph. |
| quote normalization / price-history engine | DEFER | Keep quote reference/evidence; no catalog or pricing model yet. |
| PO-item material allocation | DO-IN-V1 | Narrow join is needed to prove which package was ordered. |
| evidence/status audit trail | DO-IN-V1 | Prevents false order/shipping/receipt claims. |
| takeoff OCR/AI extraction | DEFER | Two XLSX layouts plus review solve the current intake need. |
| multi-warehouse/receiving inventory | DEFER | Remodeler needs receipt evidence, not inventory accounting. |
| automated vendor/city communication | DEFER | Richard approval and Kira’s no-outbound gate remain mandatory. |
| profitability/budget reporting | DEFER | Beverly/Expense remains finance authority; tracker is operational only. |

## Acceptance for implementation card

The later implementation card must name the guarded DDL script, protected count endpoints, XLSX fixtures for both layouts, transition/evidence tests, explicit receipt-link rule, lock-order test, and Codex plus Kimi approvals. Browser evidence is required before any shipment. Build waits for `t_00e5d8b4`.
