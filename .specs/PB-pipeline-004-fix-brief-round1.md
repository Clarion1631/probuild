# PB-pipeline-004 — TRIP-2 round-1 fix brief

You are fixing code-review findings on the cost-plus/milestone change-order feature you implemented
(committed as `b7fbad2` on this branch). Spec: `.specs/PB-pipeline-004-cost-plus-change-orders.md`.
Your implementation report: `.specs/PB-pipeline-004-implementation-report-20260721-0056.md`.
The review below is authoritative; fix findings 1–6. Do NOT attempt to fix the repository-wide lint
baseline (finding 7 in the review) — it is pre-existing and handled by a human waiver decision.

## Working rules (unchanged from the original brief)

- Work ONLY in this worktree. Do NOT commit, push, or touch git config — leave fixes as an
  uncommitted diff on top of `b7fbad2`.
- Money math in integer cents. `ChangeOrder.totalAmount` is pre-tax. Locks via
  `lockMoneyParents`/`withTxRetry` in canonical Estimate→Invoice→schedule order. All paid-milestone
  side effects only through `notifyMilestonePaid()`. Never touch prod DB, never `ALLOW_PROD_E2E=1`,
  no deploys. Prisma client regen via PowerShell only. Schema/migration changes (if any) must be
  additive, rerunnable, and mirrored between `prisma/schema.prisma` and
  `migrations/004_cost_plus_change_orders.sql`.
- Match existing style; surgical changes only — do not refactor unrelated code.

## Findings to fix

### F1 [Critical] Deleting or re-splitting a CO invoice orphans frozen billing
`deleteInvoice` (src/lib/actions.ts:~2570) deletes an invoice without checking CO-backed payments,
cascading its milestones while `ChangeOrderBilling.paymentScheduleId` goes null; re-split
(src/lib/actions.ts:~4177, `splitInvoiceMilestones` path) similarly deletes unpaid milestones.
Source actuals stay stamped (`invoiceId`/`invoicedAt`) so they can never be billed again and no
collectible milestone remains.
**Fix:** refuse BOTH operations when any of the invoice's payment schedules has
`sourceChangeOrderId`, `sourceCoScheduleId`, or a `coBilling` relation. Return a clear error
directing the operator to void/rebill the change-order billing instead. Do not build a
void/rebill flow in this pass — just the guard. Keep the guard inside the same transaction that
performs the deletion so a concurrent billing run can't slip through.

### F2 [Critical] "Create Invoice" accepts CO-tagged and already-billed time
In TimeTab (src/app/projects/[id]/time-expenses/TimeTab.tsx:~196, ~271) every row is selectable,
and the server action (src/lib/actions.ts:~3264-3271) has no `changeOrderId`/`invoiceId`/
`invoicedAt`/project filter. It invoices labor only (omitting burden/markup/CO tax), stamps
`invoicedAt`, and double-bills rows already billed by a CO run.
**Fix:** server-side, the create-labor-invoice action must select ONLY rows that belong to the
requested project AND have `changeOrderId IS NULL` AND `invoiceId IS NULL` AND `invoicedAt IS NULL`,
claiming them transactionally (updateMany with those conditions; reject/skip rows that fail).
Client-side, disable selection of CO-tagged or billed rows with an explanatory tooltip/badge.

### F3 [Major] Date-only actuals stored as UTC instants defeat the company-timezone cutoff
src/lib/time-expense-core.ts:~67 and ~137 parse date-only values (e.g. "2026-07-20") as UTC
midnight, which is the previous day 17:00 in America/Los_Angeles, so "bill through July 19" can
include July 20 work.
**Fix:** interpret date-only inputs in the company timezone using the existing helpers in
`src/lib/company-timezone.ts` (extend them if needed) so a date-only value means that calendar
date in company-local time (store a canonical instant, e.g. local noon or local midnight —
choose one, apply consistently, and make sure the throughDate end-of-day comparison includes
same-day entries). Add/extend a test proving a date-only entry on the throughDate is included and
one on throughDate+1 is excluded.

### F4 [Major] Manual web time entries omit crew burden
NewTimeEntryModal (src/app/projects/[id]/time-expenses/NewTimeEntryModal.tsx:~48) sends only
`hours × hourlyRate` computed client-side, and the core defaults burden to 0
(src/lib/time-expense-core.ts:~88; wrapper src/lib/time-expense-actions.ts:~315) — underbilling
cost-plus work from the primary UI.
**Fix:** compute BOTH laborCost and burdenCost server-side from the selected user's stored
`hourlyRate`/`burdenRate` (same as the MCP `log_time` path — reuse `calculateCrewTimeCosts`).
Do not trust client-supplied cost values for this path.

### F5 [Major] A CO expense can retain a line item from another estimate
Selecting a CO replaces `estimateId` with the CO's estimate, but the independently selected
`itemId` persists without validation (src/lib/time-expense-core.ts:~116, ~143;
NewExpenseEntryModal.tsx:~170).
**Fix:** server-side, when `itemId` is provided, verify `EstimateItem.estimateId` equals the
resolved estimate; reject otherwise. Client-side, clear/reload the item picker when the CO
selection changes.

### F6 [Major] Receipt attachment failures are silently accepted
NewExpenseEntryModal.tsx (~36, ~85, ~245): a new file selection doesn't clear the previous
`receiptFileId`, upload/register failures are swallowed, and submit stays enabled mid-upload —
an expense can save with no receipt or the previous receipt while showing the new filename.
**Fix:** reset `receiptFileId` when a new file is chosen; surface upload/registration errors to
the user (sonner toast + inline state); disable submit while an upload is in flight or failed
until resolved/cleared.

## Verification required (run yourself, report honestly)

- `npm run typecheck` → 0 errors.
- `npm run build` → 0 errors (local disposable env vars as before).
- Changed-file eslint → 0 errors.
- Playwright: `e2e/cost-plus-change-order.spec.ts` AND `e2e/money-pipeline.spec.ts` against the
  disposable Docker PG per docs/TESTING.md — all green. Extend the feature spec to cover F1
  (delete/re-split refusal), F2 (tagged/billed rows excluded and unselectable), and F3
  (date-only boundary) at minimum.

## Final deliverable

Write `.specs/PB-pipeline-004-fix-report-<YYYYMMDD-HHMM>.md` (unique timestamp) describing each
finding, the fix, files touched, and verification evidence tails. Then print the full report
contents between ===REPORT START=== and ===REPORT END=== as your final output.
