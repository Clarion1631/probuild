# Spec: Client-facing per-line-item approve / reject on estimates (money-path aware)

**ID:** 20260717-per-item-approve
**Date:** 2026-07-17
**Status:** draft

## Context

Today an estimate is approved **all-or-nothing**. In the client portal (`src/app/portal/estimates/[id]/PortalEstimateClient.tsx`) the client sees the full line-item breakdown, draws one signature, and clicks a single "Approve & Sign" button. That calls `approveEstimate(estimateId, signatureName, userAgent, signatureDataUrl, capturedPdfUrl)` (`src/lib/actions.ts:2283`), which flips the whole `Estimate.status` to "Approved", then `ensureProjectAndDepositInvoiceForEstimate` (`actions.ts:2183`) converts the lead, snapshots tax, and mirrors every `EstimatePaymentSchedule` milestone into invoice-side `PaymentSchedule` rows linked by `sourceScheduleId` (`createInvoiceFromEstimate`, `actions.ts:3164`). The client cannot say "yes to the kitchen scope, not the deck."

There **is** already a per-item flag on main, but it is a different, unrelated thing: `EstimateItem.approvalStatus` / `approvalNote` (schema:462–463) plus `updateItemApproval` / `bulkUpdateItemApproval` (`actions.ts:9106`, `9118`) and an internal toggle in the staff-facing `EstimateEditor.tsx`. That is an **internal estimator QA annotation** — no auth/role gate, wrapped in a swallow-all try/catch, never shown in the portal, and with **zero money-path effect** (it does not touch `totalAmount`, milestones, tax, or invoicing). This spec does **not** repurpose that flag; conflating an estimator's internal "I reviewed this row" with a client's contractual accept/reject would be a correctness trap (see Open Question 1).

The role this serves: the **client** (portal) wants to approve a subset of scope and sign only for what they accept; the **estimator / PM** needs the accepted subset to correctly drive the deposit invoice, milestone amounts, and tax — without ever letting a client's row-level choice desync the mirrored money rails. This is a money-path change, so it inherits the money-path review rigor (codex review + `e2e/money-pipeline.spec.ts` must stay green) and must resolve the open tax-null ambiguity tracked in draft PR #202 (`claude/tax-snapshot-fixes`).

## Goals

1. **Distinct client-decision data model.** Add a client-facing decision dimension on `EstimateItem` that is separate from the existing internal `approvalStatus`. Each contractable line item carries a client decision (`accepted` / `rejected` / `undecided`), a decision timestamp, and an optional client note — persisted without colliding with the estimator annotation. Rejected/undecided items are excluded from the "approved subset" (defined in Goal 4).
2. **Portal per-item UX + subset signature.** In `PortalEstimateClient.tsx` the client can toggle accept/reject per top-level line item (and, per Open Question 4, per sub-item), see a live running "approved subtotal / tax / total" that updates as they toggle, and sign **once** for the subset they accepted. The signed record must capture *which items were accepted at signing time* (an immutable snapshot), not just a pointer to mutable rows.
3. **Deterministic total & milestone recomputation.** On subset approval, `Estimate.totalAmount` (and `balanceDue`) is recomputed as the sum of accepted line-item totals, and the payment schedule is regenerated to match the reduced total using the **integer-cent largest-remainder allocation already used by PR #202** (so milestone sum lands exactly on the new grossed total, no cent drift, no negative rows). This runs inside the existing `withTxRetry` + `lockMoneyParents` (Estimate→Invoice) transaction so it is atomic with, and correctly ordered against, the milestone mirror.
4. **"Approved subset" is the single source of truth for invoicing.** `ensureProjectAndDepositInvoiceForEstimate` / `createInvoiceFromEstimate` build the deposit invoice from the recomputed (subset) total and the regenerated milestones only. Rejected items never appear in the invoice, the QuickBooks push, or the client's payable balance. Re-approval remains idempotent (one invoice per estimate) and can never re-gross or double-count an already-invoiced estimate.
5. **Tax gross-up runs on the subset total, unambiguously.** Tax snapshot (`applyEstimateTaxSnapshot` per PR #202) is applied to the **recomputed subset total**, using the resolution of PR #202's editor-vs-connector null-rate ambiguity (Open Question 2). Partial approval must not double-tax editor-created null-rate estimates.
6. **Auditable, re-negotiable lifecycle.** Rejected items are preserved (not deleted) with their client note so the estimator can see what was declined, revise, and re-send. Define what happens to a signed subset when the estimate is subsequently edited and re-sent (version/reset semantics — Open Question 5). All decisions and the subset signature are written to the existing activity log via the same single-writer path used for `signed_estimate` (never a second writer).

## Non-Goals

- Changing the **internal** estimator `approvalStatus` toggle in `EstimateEditor.tsx` or its actions — left exactly as-is (this spec adds a parallel client dimension, it does not migrate or remove the internal one).
- Milestone/deposit **restructuring UI** for the estimator (e.g. re-drawing the payment schedule by hand after a partial approval) — v1 regenerates milestones by proportional allocation only; bespoke re-scheduling is a later spec.
- Converting rejected items into a **Change Order** automatically — rejected scope simply stays declined on the estimate (auto-CO is a future enhancement; see Roadmap).
- **Partial approval of milestone-priced (non-line-item-derived) estimates** where milestones are fixed dollar figures unrelated to line-item totals — v1 gates per-item approval to estimates whose milestones are derivable from the line-item subtotal (Open Question 3); other estimates keep the all-or-nothing flow.
- Multi-party / multi-signer approval, counter-offers, or in-portal price negotiation.
- Any change to `e2e/money-pipeline.spec.ts` guarantees (sign→convert→invoice chain, mirror links, undo restore, exactly-once activity writers) — these must keep passing unchanged.

## Roadmap — later phases

- **Phase 2:** estimator-side milestone re-scheduling after partial approval; explicit "resend for re-approval" flow with diff highlighting of what changed.
- **Phase 3:** auto-generate a Change Order from rejected items so declined scope can be re-quoted and re-offered without a new estimate.
- **Phase 4:** partial approval on milestone-priced contracts (decouple accepted-scope tracking from the billing schedule so lump-sum contracts can also be partially accepted).

## Approach

**Data (prose only).** Add client-decision columns to `EstimateItem` — a nullable client decision enum-as-string (`accepted` | `rejected`, null = undecided), a `clientDecidedAt` timestamp, and a `clientDecisionNote`. Keep them strictly separate from the existing `approvalStatus`/`approvalNote`. Because line items can be edited after signing, the *binding* record of what was accepted is stored as an immutable snapshot on the estimate at signing time (a JSON column such as `approvedSubsetSnapshot`, or a small child table capturing item id + name + total + accepted-flag at the moment of signature) so a later edit of a line item cannot retroactively change what the client signed for. Applied via the `apply_schema.ps1` workflow, then `prisma generate` via PowerShell (never `prisma db push`). All additive/nullable.

**Portal UX.** Each top-level (and optionally sub-) line item gets accept/reject controls (must honor the no-hover-device rule from CLAUDE.md — no controls hidden only behind `:hover`). A live summary panel recomputes accepted subtotal, tax (using the same fallback rate constant the portal already displays), and total client-side as the user toggles — display only, never authoritative. The single "Approve & Sign" button is disabled until at least one item is accepted; on submit it passes the accepted-item id set (plus the existing signature/name/PDF payload) to a new server action.

**Server action (money-path core).** A new `approveEstimateSubset(estimateId, acceptedItemIds[], signatureName, userAgent, signatureDataUrl?, capturedPdfUrl?)` (or an extension of `approveEstimate` with an optional `acceptedItemIds`), which inside one `withTxRetry(() => prisma.$transaction(...))`:
1. `lockMoneyParents(tx, { estimateId })` first (canonical order), re-read the estimate + items under lock.
2. Validate the accepted set against the estimate's items (reject unknown/foreign ids — the current `updateItemApproval` has no ownership check; the new path must, to close that IDOR gap).
3. Write per-item client decisions; persist the immutable accepted-subset snapshot.
4. Recompute `totalAmount`/`balanceDue` from accepted-item totals.
5. Apply the tax snapshot (PR #202 logic) to the recomputed total under the OQ2 resolution.
6. Regenerate `EstimatePaymentSchedule` rows for the reduced total via integer-cent largest-remainder allocation.
7. Flip estimate status and stamp `approvedBy`/`approvedAt`/`approvalUserAgent`/`signatureUrl`.
Then, *after* the transaction (matching today's ordering), call `ensureProjectAndDepositInvoiceForEstimate`, which mirrors the regenerated milestones into `PaymentSchedule` and pushes to QuickBooks fail-soft. Guard so re-approval with a different subset on an already-invoiced estimate is rejected or explicitly versioned (Open Question 5), never silently re-grossed.

**Reconciliation invariant.** Because invoicing mirrors *milestones* (not line items) via `sourceScheduleId`, the only safe way to make "approved subset" authoritative for money is to force the milestone regeneration in step 6 to derive from the accepted-item subtotal. Per-item approval is therefore only offered when milestones are line-item-derivable (Open Question 3); otherwise the portal falls back to all-or-nothing.

## Files Touched

- `prisma/schema.prisma` — `EstimateItem` client-decision columns; `Estimate` accepted-subset snapshot (column or new child table).
- `src/lib/actions.ts` — new `approveEstimateSubset` (or `approveEstimate` extension); subset-aware total/milestone recompute helper; reuse `applyEstimateTaxSnapshot`, `lockMoneyParents`, `withTxRetry`, `createInvoiceFromEstimate`.
- `src/app/portal/estimates/[id]/PortalEstimateClient.tsx` — per-item accept/reject controls, live subset summary, subset signing.
- `src/lib/tax-constants.ts` — shared fallback rate (from PR #202) reused for portal display and billing.
- `e2e/money-pipeline.spec.ts` — extend (not weaken) with a partial-approval case: subset total, regenerated milestones sum-exact, invoice built from subset, rejected items absent.
- Possibly `src/app/projects/[id]/estimates/[estimateId]/EstimateEditor.tsx` — read-only display of client decisions to the estimator (not the internal toggle).

## Data Model Changes

```
EstimateItem: + clientDecision String?    // "accepted" | "rejected"; null = undecided
              + clientDecidedAt DateTime?
              + clientDecisionNote String?

Estimate:     + approvedSubsetSnapshot Json?   // immutable {itemId,name,total,accepted}[] captured at signing
              (alternative: new child table EstimateApprovalLineSnapshot)
```
Additive/nullable only. Apply via `apply_schema.ps1`; keep `schema.prisma` in sync. No change to the existing `approvalStatus`/`approvalNote` columns.

## Test Plan

- **Goal 1/2 (portal, throwaway-DB e2e):** render an estimate with 3 line items, reject 1, verify live summary updates, sign, verify per-item `clientDecision` persisted and the snapshot captured the accepted set.
- **Goal 3 (money math, unit + e2e):** accepted-subset total equals sum of accepted item totals; regenerated milestone amounts sum **exactly** to the grossed total (largest-remainder, no drift, no negative rows) — mirror PR #202's cent-exactness assertion.
- **Goal 4:** after subset approval, `createInvoiceFromEstimate` produces an invoice whose `totalAmount`/milestones equal the subset; rejected items appear nowhere in invoice or QB push; re-approval is idempotent (still one invoice).
- **Goal 5 (tax):** editor-created null-rate estimate with a partial approval does **not** double-tax (regression against PR #202's `$108.80 → $118.37` bug); configured 0% stays 0%.
- **Goal 6:** rejected items retained with note; activity log shows exactly one `signed_estimate`-class writer for the subset (no duplicate loggers); defined re-send/reset behavior verified.
- `npm run build` zero errors; **`e2e/money-pipeline.spec.ts` stays green** and is extended with the partial-approval case; run codex-peer-review on the diff.

## Rollback Plan

- Schema changes are additive nullable columns / an optional JSON column (or an unused child table) — safe to leave in place on revert.
- The new `approveEstimateSubset` path is additive; reverting to all-or-nothing = hide the per-item portal controls and route the portal "Approve & Sign" back to the existing `approveEstimate`. No existing estimate data is mutated by leaving the columns unused.
- Already-invoiced subset approvals are money records — do **not** auto-reverse on code rollback; document a manual reconciliation step if a partial-approval invoice must be undone (reuse the existing undo-restore path guarded by `money-pipeline.spec.ts`).

## Open Questions

1. **Two-actor collision.** Confirm the client decision must live on **new** columns (`clientDecision`) rather than reusing the estimator's `approvalStatus`. My strong recommendation is separate columns — an estimator marking a row "approved" internally is not the client accepting it contractually, and overloading one column would let one actor silently overwrite the other. Do you agree, or is there a single-status model you'd prefer?
2. **PR #202 null-rate ambiguity (blocking).** This spec's tax gross-up on the subset total inherits the exact ambiguity draft PR #202 is blocked on: editor-created estimates persist `taxRatePercent: null` while baking the 8.8% fallback into `totalAmount` (tax-inclusive), whereas connector estimates with null rate are tax-exclusive. Which resolution do we commit to — make the editor persist the displayed rate (PR #202's "preferred" fix + backfill), or another approach? Per-item approval cannot ship correctly until this is decided.
3. **Which estimates qualify?** Milestones mirror to invoices independently of line items. For estimates whose milestones are **fixed dollar figures not derived from line-item totals** (e.g. a hand-entered "Deposit $5,000"), how should a partial approval reduce them — proportionally, or should per-item approval simply be **disabled** for those estimates (my recommended v1: gate to line-item-derivable schedules only)?
4. **Granularity.** Accept/reject at **top-level line items only**, or also at **sub-item** level? Sub-item granularity is more flexible but complicates the "reject a category but keep some children" math and the client UX. Which do you want for v1?
5. **Re-negotiation / re-send semantics.** After a client signs a subset, if the estimator edits the estimate and re-sends: does the prior signature/subset **reset** (client must re-decide and re-sign), or is it a **new version**? And can a client change their accepted set *after* the deposit invoice exists, or is the subset frozen at first signature? (Affects idempotency guarantees in Goal 4.)
6. **Legal/contract framing.** Is a signed subset a binding contract for only the accepted scope, and do rejected items need explicit "declined" language on the signed PDF? This affects what the immutable snapshot and generated PDF must record.
7. **Deposit floor.** If a client rejects enough scope that the recomputed deposit milestone falls below a business minimum (or to zero), what should happen — allow it, enforce a floor, or block approval with a message?
