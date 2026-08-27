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

The current QBO expense sync uses vendor text, does not set a ProBuild vendor ID or `purchaseOrderId`, and keys financial idempotency by `qbPurchaseId`. Its customer-name-to-project result is triage only: a `MaterialItemExpense` reviewer must independently confirm the project and may not treat the existing expense's estimate/project or `Expense.status` as that proof. `QboPurchaseClassification` is import-triage metadata, not MaterialItem evidence or review evidence. V1 must never infer a PO/receipt association from vendor text, amount, date, or that heuristic project match. QuickBooks remains read-only from this feature: V1 writes no QBO record, classification, vendor, expense, or estimate.

### Procurement-linked QBO expense guard

Creating `MaterialItemExpense` requires a human-reviewed, immutable procurement snapshot: required `lockedExpenseEstimateId` and `lockedProjectId`, each equal to the reviewed `Expense.estimateId` and its project at link time. The relation is unique per `(materialItemId, expenseId)`, has a reverse `@@index([expenseId])` for the QBO guard lookup, and the snapshot is immutable after insert; the server also requires `lockedProjectId = MaterialItem.projectId`. These fields are a mapping guard, not a claim that QBO owns or may rewrite ProBuild project assignment.

`syncQboExpenses` is the sole mutation owner for QBO-originated `Expense.estimateId` updates. A QBO-originated `MaterialItemExpense` link creation, the sync, and every authorized conflict-correction transaction must all call the shared `lockQboExpense` helper from `src/lib/qbo-expense-sync.ts` before reading the expense or linked snapshots; that helper must retain its existing `pg_advisory_xact_lock(hashtextextended($1, 0))` identity derived from `qbPurchaseId` (not a `hashtext` or project/material lock). Where other material/expense locks are also needed, acquire the QBO lock first and then acquire every material lock in ascending immutable material-ID order. Before it writes an incoming estimate, the sync must look up every procurement-linked `MaterialItemExpense`. If the incoming estimate or its project differs from any locked snapshot, the affected purchase is a per-purchase `PROCUREMENT_LINKED_EXPENSE_PROJECT_CONFLICT` outcome in the aggregate sync result, not a top-level sync failure; it leaves `Expense.estimateId` and all material links unchanged, and appends a `MaterialItemEvent(kind=QBO_PROJECT_CONFLICT)` for each affected material with the incoming and locked IDs, source `qbPurchaseId` and `qbSyncToken`, timestamp, and deterministic correlation key `qbo-conflict:<qbPurchaseId>:<qbSyncToken>:<incomingEstimateId>`; a retry of that QBO revision therefore returns the existing event while a later revision gets a new event. A `FINANCE` or `ADMIN` reviewer resolves that conflict only in a new, audited correction transaction under that same QBO lock; the QBO retry may not resolve it and no handler may silently rehome the expense, material, or project.

Tests must prove the initial reviewed same-project link, a later QBO correction to a different estimate or project that is rejected without changing either assignment, immutable snapshot enforcement, one auditable conflict event per linked material per QBO revision, a concurrent link-creation/remap/correction race serialized by the shared lock, and an authorized explicit correction path. The QBO sync must remain a reader of this guard, not an authorization bypass.

No current retained API-sweep artifact proves a complete production baseline for procurement. Before DDL or rollout, the implementation card must add least-privilege authenticated count/read support, make a dated measurement, and retain that measurement with the card. Direct production SQL, Prisma console output, and dashboard estimates are not substitutes.

## Canonical V1 record set

All names below are canonical. There is no `MaterialRequirement` model.

### `MaterialImportRun` and `MaterialImportRow`

Every accepted input (XLSX, Gmail attachment, Drive file, authenticated manual action, or PO revision) has an explicit ingest run before it may create a material item, evidence, relation, or event; staging is never hidden in `MaterialItemSource`.

- `MaterialImportRun`: immutable ID, selected `projectId`, source file/reference, parser version where applicable, uploader, started/completed timestamps, status, and the non-null immutable `ingestPath`, `requestKey`, `sourceHash`, and `commitScopeHash` described below. `commitScopeHash` covers every non-file input that changes the result, including selected project and parser/layout version.
- `MaterialImportRow`: import-run ID, source sheet/row/cell coordinates, raw and normalized values, parse warnings, selected-project check result, resolution state, and actor/timestamps.

A user selects the project when creating the import run. A row with blank project data remains a staging `DATA GAP`; it creates no `MaterialItem`. A row with an explicit project that conflicts with the selected project is blocked until a user resolves it with a recorded reason. The run's selected project is the only project assignment allowed at commit.

### `MaterialItem`

A stable, human-readable record with immutable ID and immutable `projectId`; material/package name; optional phase/location; quantity/unit only when known; SKU; quote reference; required-by date; optional vendor; next action/owner/due date; status; nullable `underlyingStage` and `exceptionBlocker` permitted only while status is `DELAYED`; escalation; notes; nullable `receivedAt` (set only by the guarded `RECEIVED` transition from the authoritative receipt date, and cleared only by an audited reversal from `RECEIVED`); and actor/timestamps. Any new money or price snapshot is stored in integer cents, never floating point; existing financial records are read through their current contract and are not rescaled or rewritten by V1.

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

`RECEIVED` is never a legacy exception. It requires both current authoritative `DELIVERY_RECEIPT` evidence and a non-null `receivedAt` delivery/receipt date in the same guarded transition. A legacy row, import, AI extraction, verbal statement, or stale receipt that claims receipt without both requirements stays out of `RECEIVED`: use `DELAYED` with the last proven pre-receipt `underlyingStage`, `exceptionBlocker=LEGACY_RECEIPT_UNVERIFIED`, and `DATA GAP` escalation (or `AMBER`/`RED` only by the ordinary dated risk rule). The explicit remediation is a staff review that captures valid proof and date, then performs the normal received transition; it is not a bulk backfill or inferred correction.

- `MaterialImportRun` covers every ingest path, not just XLSX. It includes non-null immutable `ingestPath`, `requestKey`, and `sourceHash`, with `@@unique([ingestPath, requestKey])`; a retry returns this run rather than creating another run.
- `MaterialItemEvidence` holds only durable source/quote/approval/shipping/receipt proof (kind, reference, captured date, source actor, note). It does not create a PO or expense association. It includes immutable `ingestPath`, `sourceIdentity`, and `sourceHash`; `ingestPath + sourceIdentity` is globally unique, all three are non-null, and replacement never mutates an existing proof. `APPROVAL_DECISION` additionally has required immutable `approvedQuoteEvidenceId`, an FK to the exact `VENDOR_QUOTE` evidence version it approves; its transition validator requires that evidence to be current. For one source that produces multiple material items, each evidence atom uses the stable per-item identity `requestKey:item:<immutable-source-line-or-item-id>` (XLSX/attachment/Drive row: immutable `MaterialImportRow` ID; PO revision: immutable PO-revision line key, not the mutable physical `PurchaseOrderItem` row ID; manual batch: caller-supplied immutable entry ID). The run retains the unsuffixed canonical request key. A single-item proof may use its request key unchanged.
- `MaterialItemEvent` is append-only and covers status, escalation, field, link, import-resolution, and correction changes. It records event kind, changed field/value snapshot where applicable, from/to status, evidence ID when applicable, actor, reason, timestamp, and non-null immutable correlation key; `@@unique([materialItemId, correlationKey])` prevents duplicate event delivery for one material.

Every normal initial `REQUESTED` item must create `MaterialItemEvidence(kind=SOURCE_IMPORT)` from its reviewed staging row and a matching initial event. The only evidence-free start is `REQUESTED` with `DATA GAP`. Any later claimed procurement progress requires evidence. Schedule text and verbal statements cannot advance status or display `RED`.

#### Typed authoritative state evidence

Only evidence listed below may advance the named state. It must be durable, immutable, tied to the same project/material (and PO item where applicable), captured with its source identity and hash, and current: evidence marked superseded, retracted, conflict-held, cross-project, or replaced by a newer authoritative source is stale and cannot support a transition. Imports and AI/OCR output are staging aids only; they may create `SOURCE_IMPORT` or warnings but are never authoritative state evidence. A manual entry requires the listed proof plus `RICHARD_CONFIRMATION` made by the authenticated user whose immutable `User.id` equals the active `ProcurementAuthorityConfig.richardUserId`; a typed name in a note is not confirmation. Only `ADMIN` may rotate that config binding, and every rotation and confirmation is append-only audited with actor ID, prior/new binding where applicable, reason, and timestamp.

| Target status | Required authoritative kind(s) and permitted provenance | Rejected as evidence |
|---|---|---|
| `QUOTED` | `VENDOR_QUOTE`: a vendor-issued quote/document or authenticated vendor portal quote, captured by authorized staff; manual capture also requires current `RICHARD_CONFIRMATION`. | import row, AI/OCR extraction, vendor text alone, expired/superseded quote |
| `APPROVED` | `APPROVAL_DECISION`: authenticated `ADMIN`/`MANAGER` approval with immutable `approvedQuoteEvidenceId` bound to the current `VENDOR_QUOTE` evidence version; a manual approval also requires current `RICHARD_CONFIRMATION`. | PO status, email summary, stale approval for a changed quote, an inferred budget match |
| `ORDERED` | `PO_ORDER_CONFIRMATION` bound to `MaterialItemPurchaseOrderItem`, or a vendor-issued order confirmation bound to the same PO item; manual capture also requires current `RICHARD_CONFIRMATION`. | a `PurchaseOrder` document status alone, draft PO, import/AI inference, unlinked PO item |
| `SHIPPED` | `VENDOR_SHIPMENT_NOTICE` or carrier tracking event from the vendor/carrier, bound to the ordered item; manual capture also requires current `RICHARD_CONFIRMATION`. | a promised ETA, schedule text, inferred carrier date, stale tracking event |
| `RECEIVED` | current `DELIVERY_RECEIPT` from carrier/vendor/authorized receiving record **and** non-null `receivedAt`; manual capture also requires current `RICHARD_CONFIRMATION`. | any legacy status, verbal claim, shipment notice, import/AI inference, receipt without date, stale/retracted receipt |

Transition tests must cover every allowed type/provenance, every rejected source above, a superseded/stale proof, a replacement quote that invalidates its old approval, missing/mismatched Richard confirmation for each manual path, configuration-rotation authorization, and all authorization failures. No client-facing action and no outbound action is implied by a transition. Kira may not contact a vendor or any other recipient: any future outbound action requires a separate current Richard confirmation and `ADMIN` or `MANAGER` authorization, and remains deferred in V1.

### Explicit association records

- `MaterialItemPurchaseOrderItem`: material item + `PurchaseOrderItem`, immutable PO-revision line key, ordered quantity, note, audit fields. It is the only authoritative operational PO link. The PO editor must reconcile existing referenced lines in place (or explicitly retain their immutable procurement line key and association); it must not silently delete/recreate a referenced line on an unrelated save. A changed/replaced line creates a new PO revision/evidence identity and retires the old association only through an audited transition.
- `MaterialItemExpense`: material item + `Expense` plus required `reviewDecision`, `reviewedByUserId`, `reviewedAt`, `reviewEvidenceId`, `lockedExpenseEstimateId`, `lockedProjectId`, reason, and audit fields. The two locked fields are immutable, same-project snapshots used by the QBO guard above. It is created only after an explicit human review; `Expense.status` is not acceptable review proof.
- `MaterialItemSource`: material item + committed import row, file/hash, source coordinates, raw/normalized snapshot, and audit fields.

These records have unique/idempotent keys. The server rechecks the same-project rules before writing each relation. Evidence may cite a durable receipt or PO file, but it cannot bypass the reviewed join.

### Ingest identities, retries, and replacements

Every ingest entry point supplies a non-null immutable identity/request key, source hash, and `commitScopeHash` before any row/event is written. The implementation writes the canonical identity to `MaterialImportRun.requestKey`; each per-material evidence atom and event correlation is deterministically derived from that key and its immutable source line/item ID, never from a generated material ID. The path-plus-key unique constraints above own deduplication. The canonical identities are: authenticated direct XLSX-upload request UUID (`xlsx:<requestUuid>`), which the client retains and resubmits on retry; Gmail message plus attachment immutable IDs (`gmail:<messageId>:<attachmentId>`); Drive file plus immutable revision ID or, only when Drive cannot supply one, canonical SHA-256 of the retained immutable file bytes (`drive:<fileId>:<immutableRevisionId-or-sha256-file-bytes>`); authenticated manual Richard action request UUID (`richard:<requestUuid>`); and PO revision (`po:<purchaseOrderId>:<immutableRevisionId-or-canonical-revision-hash>`). A source hash is computed from the immutable source payload/version and is never a filename, amount, vendor text, or date heuristic. `commitScopeHash` is a canonical hash of selected `projectId` and every non-file input that changes the committed result; it prevents a replay token from silently returning or writing a run for a different project.

For an exact duplicate key, source hash, and `commitScopeHash`, a retry returns the original run/result and creates no second material, evidence, association, or event. The same identity with a different source hash or `commitScopeHash` (including a selected-project change) is an explicit source-version/replacement conflict: it creates neither a silent overwrite nor a status advance. A reviewer may record a new versioned evidence record with a new immutable identity, mark the old proof superseded through an append-only event, and re-evaluate every transition that depended on it. Replaced Gmail/Drive attachments are retained as distinct immutable files/evidence; same-name attachments never replace prior proof. Tests must cover duplicate delivery/retry for all five paths, one multi-item source producing distinct stable evidence identities, unique-constraint races, selected-project/result-scope conflict, changed-content conflict, explicit reviewed replacement, and prevention of duplicate events/links.

## Enforceable authority boundaries

Names describe work assignments, never authorization. The implementation must resolve each actor through actual account roles/permissions and test every server action:

- Approval, vendor choice, and any future outbound decision: `ADMIN` or `MANAGER` authority.
- Tracking/evidence entry: authorized staff role, constrained to evidence and transition rules.
- Finance/expense review: `FINANCE` or `ADMIN` authority; the reviewer identity is stored on `MaterialItemExpense`.
- Richard confirmation: only the authenticated `User.id` currently configured as `ProcurementAuthorityConfig.richardUserId`; `ADMIN` may rotate that binding only through the audited configuration action. This is a principal binding, never a display-name comparison.
- Read-only verified-date presentation: a server-projected read surface; no client-side name check.

“Richard,” “Kira,” “Mac,” and “Beverly” are operating assignments, not role names and not access-control checks. The existing PO-create and expense-approve routes do not establish this V1 authority model; V1 must use new or explicitly tightened server actions rather than reusing their current authorization unchanged.

## Input, UI, and deferrals

Before implementation, create and version a repository input contract at `docs/procurement/INPUT-CONTRACT.md` and fixtures under `tests/fixtures/procurement/xlsx/`. The contract must identify both supported layout versions, required columns, source-file acceptance rules, storage adapter/retention behavior, the staging-to-commit action, and the immutable ingest identity/hash for each accepted input. Until then, no claim is made that an unknown XLSX layout is supported.

The board displays phase, item, status, evidence, owner, next action/due date, required-by risk, escalation, and explicit links. It reads already-filed PO communication only; it must not invoke `src/app/api/projects/[id]/purchase-orders/[poId]/send-message/route.ts`, compose a message, or create a Chat/vendor message.

Defer approval-revision graphs, UOM conversion, automated arrival gates, heuristic QBO matching, quote-price history, OCR/AI extraction, warehouse inventory, automation, profitability reporting, and all outbound/vendor/client communication. The PO revision identity required for idempotent ingest is a provenance key only; it does not create an immutable PO revision graph or authorize PO mutation.

## Implementation entry gate

The implementation card must name guarded additive SQL; protected count endpoints; versioned XLSX contract and fixtures; transition/rejection/authoritative-evidence tests; authorization, same-project, QBO-conflict, snapshot-immutability, idempotency/retry/replacement, audit, and lock-order tests; explicit reviewed receipt-link rule; backup verification for any destructive correction; and fresh Codex/Kimi review outputs. It must prohibit both `prisma migrate` and `prisma db push`; after guarded DDL verification, from the target repository root run `powershell.exe -NoProfile -Command ".\\node_modules\\.bin\\prisma generate"` on Windows, never Git Bash. Non-Windows CI uses `npx prisma generate` from the repository root. Production shipment still requires browser-verified live evidence and independent review.