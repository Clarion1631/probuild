# Progress Billing Core — Implementation Report

Branch: `feat/progress-billing-core` (created off `origin/main` @ `5f8812b`, fetched fresh). Not pushed. No UI in this pass, per the task.

## 1. Schema — additive only

`prisma/schema.prisma`:
- New model `ProgressBilling` (invoiceId FK → Invoice `onDelete: Cascade`, code, description, status, subtotal/taxExempt/taxRate/taxAmount/total, qb* fields, sentAt/paidAt, `lines` relation). Indexes on `invoiceId`, `status`.
- New model `ProgressBillingLine` (billingId FK → ProgressBilling `onDelete: Cascade`, optional scheduleId/changeOrderId, description, amount, order). Indexes on `billingId`, `scheduleId`.
- `Estimate.taxInclusiveMilestones Boolean @default(true)` — one new column, nullable-safe default preserves legacy rows' meaning.
- `Invoice.progressBillings ProgressBilling[]` back-relation (no column, just the Prisma relation field).

No existing column, table, or relation was dropped, renamed, or made non-additive. Verified by re-reading the full diff after commit (see `git diff HEAD~3 HEAD~2 -- prisma/schema.prisma` — the diff also shows a lot of *unchanged* lines flagged as modified; that's a pre-existing CRLF/LF mix in the file being normalized by git's line-ending handling on commit, not a content change — confirmed with `git show <rev>:prisma/schema.prisma` on both sides, byte-identical after normalization).

`scripts/apply-progress-billing-schema.mjs` — follows the repo's established `$executeRawUnsafe` pattern (see `scripts/apply-task-materials-schema.mjs` for the model this mirrors): `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, guarded `DO $$ ... IF NOT EXISTS (SELECT 1 FROM pg_constraint ...) THEN ADD CONSTRAINT`. Idempotent — safe to run twice. **Not run against prod** by this work (per the task's hard constraint against touching production/Supabase). It must be run before deploy, per `CLAUDE.md`'s pre-deploy checklist, whenever this branch ships.

Deviation: I did **not** add `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` for the two new tables. About a third of the repo's `apply-*.mjs` scripts do this (`TaskMaterial`, dispatch/portal-tracker/mcp-confirmation tables); the majority, including every script touching Invoice/PaymentSchedule-adjacent tables, do not. Since `ProgressBilling`/`ProgressBillingLine` are a direct extension of `Invoice`/`PaymentSchedule` (which have no RLS enabled), I matched that precedent rather than the minority pattern. Flagging this as a judgment call in case the team's convention is actually "always RLS on new tables" and I picked the wrong sibling to match.

## 2. Core logic — `src/lib/progress-billing.ts` (new file)

Session-free cores, no auth checks, `withTxRetry` + `lockMoneyParents` in canonical Estimate→Invoice order for every transaction, cent-rounding via `Math.round(x*100)/100` everywhere. No network calls inside any transaction.

- **`createProgressBillingCore(invoiceId, input)`** — validates lines (existence/ownership/Pending/no-qbInvoiceId/no-in-flight-Stripe for milestone lines; project+Approved for change-order lines), rejects over-billing, auto-splits a milestone billed for less than its full amount (reduces the original row, creates a new remainder row, never deletes, mirrors the split onto the linked `EstimatePaymentSchedule` when `sourceScheduleId` is set, points the new invoice-side remainder's `sourceScheduleId` at the new estimate-side row), computes tax for `preTax` and `targetTotal` modes, asserts `subtotal+taxAmount===total` and `sum(lines)===subtotal` to the cent before commit, and persists the billing + lines.
- **`updateProgressBillingCore`** / **`deleteProgressBillingCore`** — Draft-only, no-`qbInvoiceId` guards.
- **`stageProgressBillingToQuickBooksCore`** — resolves customer/item via the now-exported `resolveCustomerAndItem` (`quickbooks-payments.ts`), creates one QBO invoice, links it back with a conditional claim (id + Draft + no-qbInvoiceId + content snapshot of subtotal/total/description), compensates by deleting the orphaned QBO invoice on a claim miss. **Sends no email** — verified by grep: this file contains no call to `sendNotification`, `notifyMilestonePaid`, `drainPaymentNotifications`, or any Gmail/Resend send path, and `createQBMilestoneInvoice` (unlike the milestone rail's own flow) is called with a `billEmail` but ProBuild never triggers QBO's own invoice-email send — same as `pushMilestoneToQuickBooks`, which stages without sending.

### Deviations / judgment calls (flagged per the task, not silently decided)

1. **`updateProgressBillingCore` scope.** The spec said "Draft-only ... else throw" but didn't fully specify what fields are editable. Re-running AUTO-SPLIT against a changed line set is a genuine design fork (does a shrinking line un-split a milestone? does a growing line need a fresh over-billing check against whatever the milestone now looks like, possibly after a *different* billing already split it?) that I judged out of scope for a "no judgment calls, mechanical execution" pass. I implemented `updateProgressBillingCore` to edit **only `description` and `taxExempt`** (recomputing tax off the existing, unchanged subtotal). To change which milestones/amounts/change-orders make up a billing, the caller deletes the Draft (safe, tested — see below) and creates a new one. This is a real, working implementation, not a stub — but it is narrower than "input: CreateProgressBillingInput" might have implied. **If line-composition editing is actually required, this needs a follow-up decision**, not a guess from me.
2. **Split uses the raw (pre-tax-mode) line amount, not the final persisted line amount, in `targetTotal` mode.** The over-billing check and AUTO-SPLIT both run on the amount the caller typed per line; the tax-math step (which only rescales in `targetTotal` mode) runs afterward and can shift the *persisted* `ProgressBillingLine.amount` away from the raw amount that was actually carved out of the milestone. In `preTax` mode these are always identical (no rescale happens), so this only matters for `targetTotal` + a partial-bill line combined — a combination no test in this pass exercises. I chose this ordering because it's what the task's procedural description literally specifies (validate → auto-split → *then* tax math), and it has a defensible reading (the split reflects what the user picked against the milestone; the tax-mode rescale is about hitting a specific client-facing total, not about renegotiating what the milestone gave up). But it is a real inconsistency worth a product decision before this ships a UI: if a user partially bills a milestone under `targetTotal` mode, the dollars removed from the milestone and the dollars that show up on the persisted billing line can differ by the rescale factor (typically well under a dollar, but not always). Flagged, not fixed.
3. **Duplicate-`scheduleId` guard added.** The spec doesn't mention this; I added a rejection when the same milestone is referenced by two lines in one request, since the validation-then-split two-pass design would otherwise let both lines validate against the milestone's original (pre-split) amount and then double-split it. Low-risk defensive addition, not requested but not surgical-scope-violating either (it's inside the new file only).
4. **`finalAmounts[last] <= 0` guard added** in `targetTotal` rescale — not in the spec's literal assertion list, added because a negative/zero persisted money line is a real bug class, not because a test requires it.
5. **RLS** — see schema section above.

## 3. QuickBooks settle-path extension — `src/lib/quickbooks-payments.ts`

- `resolveCustomerAndItem` is now `export`ed (was file-private) so `progress-billing.ts` can reuse it, per the task's explicit instruction to use "the same helper `pushMilestoneToQuickBooks` uses."
- Factored `markMilestonePaidFromQB`'s claim/recompute/mirror body into a new **caller-locked** helper `settleMilestonePaidInTx(t, paymentScheduleId, invoiceId, payment)` that does no locking of its own (the caller must already hold `lockMoneyParents`). `markMilestonePaidFromQB` now: locks → calls the helper → enqueues the paid notification (unchanged external behavior/signature). This is the single existing writer for the milestone-paid lifecycle; the new progress-billing settle path calls the **same** helper and does **not** call `enqueueMilestonePaid` — a `TODO(progress-billing)` comment marks exactly where that would go, per the hard constraint against sending/enqueueing notifications this pass.
- `syncQuickBooksPayments` gained a second loop, after the existing milestone loop (left fully intact): fetches `ProgressBilling` rows with `qbInvoiceId != null` and `status in (Staged, Sent)`, probes each via `probeQBInvoice`, and on a fully-settled invoice (`total > 0 && balance <= 0`) runs one `withTxRetry`+`lockMoneyParents` transaction per billing that claims the `ProgressBilling` row (`updateMany` guarded on `status in (Staged,Sent)` and `qbPaymentId: null`) and then calls `settleMilestonePaidInTx` for every line that carries a `scheduleId` (custom/change-order lines are skipped — no milestone to settle). One lock covers every line of a billing because `createProgressBillingCore` only ever references milestones on the billing's own invoice.
- `QBPaymentSyncResult` gained a new field, `progressBillingsSettled: number` (did not repurpose `settled`, which still counts individual milestones from the original per-milestone rail).
- Verified no existing caller of `syncQuickBooksPayments` breaks: grepped all 6 callers in `src/`, none destructure/assert an exact result shape; `npm run build` compiles all of them cleanly against the extended interface.

## 4. Tests — `e2e/progress-billing.spec.ts`

Modeled on `e2e/milestone-rebalance.spec.ts` (`PFX = "pb-e2e"`, serial describes, direct core imports, `afterAll` cleanup by prefix — `ProgressBilling`/`ProgressBillingLine` cleaned via `invoiceId: startsWith` since their ids are auto-generated cuids, not prefixed; cascade delete on `Invoice` would also catch them as a backstop). 11 test cases, matching every item on the task's cover list:

1. over-billing rejected, DB unchanged
2. full bill: no split, one line, milestone stays Pending, invoice totals unchanged
3. partial bill: auto-split (original reduced, `(remaining)` row created, sums to original, estimate mirror split the same way with the new invoice row pointing at the new estimate row, invoice totals unchanged, nothing deleted)
4. `preTax` math at 8.8%
5. `targetTotal` math: 33000 @ 8.8% → subtotal 30330.88, tax 2669.12, total 33000.00 exactly, lines sum to subtotal (uses two FULL-bill lines deliberately, to isolate the tax/rescale math from the auto-split mechanic — see deviation #2 above for why mixing them is a known open question)
6. `taxExempt: true` overrides a non-zero invoice tax rate
7. legacy `qbInvoiceId` milestone rejected with the Break-QB-Link message
8. draft-only guards on both update and delete (once `status`/`qbInvoiceId` simulate "Staged")
9. update recomputes tax off description/taxExempt only
10. delete leaves an already-applied split intact
11. `stageProgressBillingToQuickBooksCore` rejects with "QuickBooks is not connected" (no Integration row in the test DB) before any write, billing stays Draft with no `qbInvoiceId`

**Not covered** (gap, noted rather than silently skipped): a change-order line (`changeOrderId` path) has no dedicated test — not on the task's explicit cover list, and I stayed in scope rather than adding uncalled-for surface area.

### What I actually ran vs. did not run

- `npm run build` (PowerShell) — **passed, 0 errors.** Tail:
  ```
  ✓ Compiled successfully in 27.2s
    Collecting page data using 1 worker ...
    Generating static pages using 1 worker (0/96) ...
    ...
  ✓ Generating static pages using 1 worker (96/96) in 926ms
  Route (app)
  ...
  ```
  Full route listing omitted here for length; re-run with `npm run build` to reproduce. Confirmed exit code 0 via a second run piping to `$LASTEXITCODE`.
- `npx playwright test --list e2e/progress-billing.spec.ts` — **ran successfully**, listed all 13 tests (11 new + the shared `data.setup`/`auth.setup` fixtures), confirming the file parses and every `test()` is discovered:
  ```
  [chromium] › progress-billing.spec.ts:60:9 › createProgressBillingCore › rejects over-billing a milestone; DB unchanged
  [chromium] › progress-billing.spec.ts:85:9 › ... bills a milestone in FULL ...
  [chromium] › progress-billing.spec.ts:119:9 › ... PARTIAL bill auto-splits ...
  [chromium] › progress-billing.spec.ts:190:9 › ... preTax ... = total
  [chromium] › progress-billing.spec.ts:213:9 › ... targetTotal ... 33000 ...
  [chromium] › progress-billing.spec.ts:256:9 › ... taxExempt: true ...
  [chromium] › progress-billing.spec.ts:281:9 › ... rejects a milestone carrying a legacy qbInvoiceId ...
  [chromium] › progress-billing.spec.ts:327:9 › ... draft-only guard ...
  [chromium] › progress-billing.spec.ts:345:9 › ... updates description/taxExempt ...
  [chromium] › progress-billing.spec.ts:370:9 › ... delete leaves an already-applied split intact
  [chromium] › progress-billing.spec.ts:412:9 › ... rejects with QuickBooks-not-connected ...
  Total: 13 tests in 3 files
  ```
- **`npx playwright test` (actual execution) — did NOT run. I could not stand up a throwaway Postgres in this environment.** Docker CLI is present (`docker version` succeeds) but the daemon was not running (`npipe:////./pipe/dockerDesktopLinuxEngine` connection refused). I launched Docker Desktop and polled `docker info` for roughly 9 minutes total across two waits; the daemon never came up in that window. I did not find another local Postgres to point at. **Do not treat the passing build/list output above as evidence the test logic is correct at runtime — it is only evidence the code compiles and the test file is well-formed.** The money-math assertions (split arithmetic, the two tax-mode formulas, the estimate-mirror pointer) are hand-verified by me against the spec's formulas (shown inline in the report and in code comments) but not machine-verified by an actual run. This is the single biggest risk in this deliverable — I'd want a real run before merging.
- `e2e/money-pipeline.spec.ts` and `e2e/milestone-rebalance.spec.ts` — not run for the same Docker reason. I did verify by inspection that neither spec calls `syncQuickBooksPayments` or asserts an exact shape of `QBPaymentSyncResult`, so the additive interface change should not affect them, and `npm run build` type-checks every file that imports from `quickbooks-payments.ts` cleanly. But "should not affect" is inference, not a run.

## 5. Known gaps / risks

- **targetTotal + partial-split interaction** (deviation #2 above) — the split amount and the persisted billing-line amount can diverge by the rescale factor. No test exercises this combination. Needs a product decision, not a guess.
- **`updateProgressBillingCore`'s narrow scope** (deviation #1) — if the real requirement is "edit which lines make up a Draft billing," this needs new design, not just new code.
- **E2E suite unexecuted** — see above. The `--list` output and my manual formula verification are the only evidence right now.
- **RLS on the two new tables** — matched the Invoice/PaymentSchedule precedent (off); flag if that's the wrong call.
- **Change-order line path is implemented but untested** in this pass.
- **`stageProgressBillingToQuickBooksCore` was never invoked against a live QuickBooks sandbox** (no such environment here, and doing so would violate the "nothing against production/Supabase" constraint even if a sandbox existed for this task) — its correctness against a real QBO response shape is inferred from mirroring `pushMilestoneToQuickBooks`'s already-proven pattern, not independently verified.

## 6. Commits on this branch (not pushed)

```
714b925 test(billing): add e2e regression net for progress billing core
9741735 feat(billing): add progress billing core logic (create/update/delete/stage)
8f5ba1c feat(billing): add progress billing schema (ProgressBilling, ProgressBillingLine)
```

## 7. Files touched

- `prisma/schema.prisma` — additive (see §1)
- `scripts/apply-progress-billing-schema.mjs` — new
- `src/lib/progress-billing.ts` — new
- `src/lib/quickbooks-payments.ts` — extended (export + refactor + new settle loop, see §3)
- `e2e/progress-billing.spec.ts` — new
