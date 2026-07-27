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

---

# Round 2 — Codex review fixes (PR #252, branch `feat/progress-billing-core`)

Codex BLOCKED PR #252 on round 1's implementation above. This section covers the fixes to items A–G of the round-2 brief, plus a mid-task course change from the orchestrator that removed change-order lines from progress billing entirely (see §2.5).

## 1. A — replaced the amount-mode contract

Deleted `amountMode` / `targetTotal` from `CreateProgressBillingInput`. New contract:

- `lines[].amount` is always in the milestone's OWN units: **GROSS** for legacy vintage (`Estimate.taxInclusiveMilestones === true`, or no estimate at all), **PRE-TAX** for new vintage.
- Optional `grossTotal?: number` — when supplied, the client pays exactly this; rejected if it differs from what the lines say they add up to (`expectedGross`) by more than 2 cents ("they must match").
- `total = grossTotal ?? expectedGross`; `subtotal`/`taxAmount` are always derived by reversing tax out of `total` (never by adding tax on top of a "pre-tax" input), which is what fixes the round-1 bug: a $108 legacy (tax-inclusive) milestone billed as "$100 preTax" used to carve only $100 of gross value out of a $108 milestone while the client was actually charged $108 — leaving a phantom $8 "still owed" on a milestone that was, in reality, fully paid. Under the new contract the caller enters the milestone's own gross amount directly, so the carve and the charge always agree.
- `ProgressBillingLine.amount` (persisted) is always pre-tax: each line's proportional share of `subtotal`, remainder on the last line, **every** line checked for `<= 0` (not just the last) — throws `"...rescaled amount is $0.00 or less..."`.
- Split amount (what's carved from the milestone) is a *separate* proportional allocation: of `total` for legacy, identical to the persisted amount for new-vintage. `sum(splitAmounts)` is asserted to equal `total` (legacy) / `subtotal` (new vintage) to the cent before commit.

## 2. B — consumption guard (double-billing / CO cap)

Before splitting, every `scheduleId` line now computes `committed` = sum of `ProgressBillingLine.amount` from every OTHER non-Void `ProgressBilling` that references the same `scheduleId`, converted into the milestone's own units (grossed up per **that line's own billing's** `taxRate`/`taxExempt`, not the current billing's), and rejects when `splitAmount > milestone.amount - committed + 0.005`, naming the amount already billed and the billing code(s) it's on.

This closes two real holes:
- **A milestone billed in FULL never triggers AUTO-SPLIT** (its `PaymentSchedule.amount` never changes), so a second billing referencing the same still-Pending row used to be allowed to bill it again for up to that same (unchanged) amount. Now `committed` equals the full amount and `available` is 0.
- **A milestone's post-split ORIGINAL row keeps exactly what was billed into it** as its new `amount` — so a second billing re-referencing that same (reduced) row for anything up to that reduced amount used to pass the old "does this exceed the row's current amount" check. `committed` closes this too.

`§4` documents why I deliberately did **not** use the task brief's literal "$700 against the same milestone" example for the partial-split test — it already throws under the pre-fix code for an unrelated reason (plain over-bill against the row's reduced amount), so it wouldn't demonstrate this guard.

The change-order half of item B (cap against `ChangeOrder.totalAmount`) was built in an earlier pass of this task and then **removed** per the orchestrator's course change — see §2.5.

## 3. C — materialize custom lines as milestones

Every line without a `scheduleId` (a "custom" line — change-order lines are rejected outright, §2.5) now gets a brand-new Pending `PaymentSchedule` at creation: `name` = the line's description, `amount` = the line's split amount (milestone units), no qb/stripe ids, `sourceScheduleId: null`. The invoice's `totalAmount`/`balanceDue` are incremented by the sum of all such materialized amounts in one update, mirroring `addInvoiceMilestone`'s status ladder (`Paid` → `Partially Paid`, else unchanged) exactly. Milestone-referencing lines are untouched — a split conserves the invoice total, it never grows it.

Result: `settleProgressBillingPaidCore` (see §3 QB settle path in round 1, extracted further below) needs no special case for a custom line — every `ProgressBillingLine` ends up with a `scheduleId`, so every line settles through the same milestone rail.

## 4. D — conditional claim on the split (closes the stale-read race)

Both the invoice-side `PaymentSchedule.update` and the estimate-side `EstimatePaymentSchedule.update` inside AUTO-SPLIT are now `updateMany` calls whose `WHERE` pins `{ id, status: "Pending", stripeSessionId: null, stripePaymentIntentId: null, amount: <exact amount read at the top of the transaction> }` (the invoice-side claim also pins `qbInvoiceId: null`). A miss (`count !== 1`) throws `"...changed while this billing was being built — refresh and try again."` instead of silently overwriting a concurrent write (e.g. the legacy `pushMilestoneToQuickBooks` linking a QBO invoice, or a settle, between validation and this write).

## 5. E — compensate an orphaned QBO invoice on staging failure

In `stageProgressBillingToQuickBooksCore`, everything after `createQBMilestoneInvoice` (the pay-link fetch, the conditional link claim, and the claim's own thrown error) is now inside one `try`. Any failure in that block attempts `deleteQBInvoice`; if the delete also fails, the re-thrown error names the doc number + QBO id so it can be removed by hand. Previously only the "claim missed" branch compensated — a failure in the pay-link fetch itself (a real network call) used to leave the just-created QBO invoice orphaned with no error mentioning it at all.

## 6. F — smaller fixes

1. **Billing code reuse.** Numbering switched from `count()` to parsing every existing code's `-P<n>` suffix and taking `max + 1`. A count-based scheme reused a code after a non-last Draft was deleted, colliding with an existing billing's QuickBooks `DocNumber`. Covered by the "billing codes do not repeat after deleting a middle draft" test.
2. **`taxExempt` no longer loses the rate.** `ProgressBilling.taxRate` is now *always* `toNum(invoice.taxRate)` at creation, regardless of `taxExempt` — `taxExempt` only zeroes the tax/total *computation*, never the stored rate. `updateProgressBillingCore` recomputes `taxAmount`/`total` off that stored rate whenever `taxExempt` flips, so un-exempting a billing that was saved exempt now correctly recomputes tax instead of staying stuck at 0. Covered by an added assertion in the existing update test (round-trip exempt → un-exempt).
3. **Cent-safe rounding.** `r2` is now `Math.round((x + Number.EPSILON) * 100) / 100` everywhere in this file (was a bare `Math.round(x*100)/100`, which under-rounds values like `1.005` due to float representation).
4. **Unlinked legacy schedules documented.** Added an `else if (invLink?.estimateId)` branch in AUTO-SPLIT (previously silent) with a comment explaining why a `PaymentSchedule` with no `sourceScheduleId` on an invoice that DOES have an estimate is deliberately not mirrored (nothing on the estimate side to split against) rather than a bug.

## 7. G — tests (all rewritten/added in `e2e/progress-billing.spec.ts`)

Every pre-existing test in the file was rewritten for the new contract (no `amountMode`/`targetTotal` anywhere — the pre-fix function signature doesn't even accept these calls, so every test in the file fails to compile/run against the pre-fix code on that basis alone). On top of the contract-shape change, these specifically exercise runtime bugs that are independent of the contract and would misbehave even against a hypothetically-adapted old implementation:

- `createProgressBillingCore — core cases`: full/partial/legacy-gross/new-vintage-mirror/taxExempt/qb-linked-rejected tests (rewritten), plus new: **unit-mismatch rejected** (`grossTotal: 50` vs lines summing to `$100`), **rescale-to-$0 rejected** (two custom lines + a synthetic 999% tax rate to force one line's proportional share of subtotal to round to `$0.00`).
- `createProgressBillingCore — consumption guard`: **double-billing rejected** (bill a milestone in FULL, bill it again), and **rejects re-billing a milestone's already-consumed original row after a partial split** — deliberately using `$300` against the reduced `$400` row rather than the brief's illustrative `$700`, because `$700` already exceeds the reduced row's `amount` under the *pre-fix* plain over-bill check too and wouldn't prove the new guard did anything (documented inline in the test).
- `createProgressBillingCore — consumption guard` also carries the new **change-order rejection test** required by the course change (§2.5) in place of the CO over-cap/duplicate-CO tests it replaced.
- `createProgressBillingCore — custom lines`: materializes a Pending milestone and raises `invoice.totalAmount`/`balanceDue`.
- `createProgressBillingCore — billing codes`: create P1/P2, delete P1, create again → must be P3, not a P2 collision (fails under the pre-fix count-based numbering).
- `updateProgressBillingCore / deleteProgressBillingCore`: rewritten for the new contract; the update test now also asserts a full exempt → un-exempt round-trip recomputes tax at the stored real rate (F.2).
- `settleProgressBillingPaidCore` (new, exported from `quickbooks-payments.ts` specifically so this could be tested without a live QuickBooks connection — see §2.6): settles a custom-only billing, asserts `invoice.balanceDue` drops to 0, the materialized `PaymentSchedule` goes `Paid`, and a second settle call is a no-op (idempotency).

**What I did NOT build**: a "pre-tax vintage split test [with] a real estimate-side schedule + sourceScheduleId" mirror test was added as required (`NEW vintage split creates a real estimate-side mirror`), replacing the old test that asserted nothing about mirroring.

### 2.5 — Course change: change orders removed from progress billing

Mid-implementation, the orchestrator flagged that `billChangeOrderCore` (`src/lib/billing-core.ts`) already bills an approved change order by adding it to the invoice as a normal `PaymentSchedule` milestone (`handleChangeOrderApproved` calls it on approval, with its own row lock and duplicate-idempotency outcome). A `changeOrderId` field on a progress-billing line would therefore be a **second rail for the same money** — a genuine double-billing hole — and would also collide with a separate session working on change orders concurrently.

Per that redirect, I:

1. Removed `changeOrderId` from `ProgressBillingLineInput` and from every code path in `createProgressBillingCore` (validation loop, resolution/caching loop, consumption guard, AUTO-SPLIT comments, materialization). A line that supplies one (checked via a runtime duck-type check, since the field no longer exists on the type — guards against a stale caller) is rejected with: *"Change orders are billed by approving them, which adds a milestone to the invoice — bill that milestone here."*
2. Dropped `changeOrderId` from the `ProgressBillingLine` Prisma model and from `scripts/apply-progress-billing-schema.mjs`'s `CREATE TABLE` statement. This column has never existed in any database (the table itself was never applied to prod), so this is a same-migration edit, not a drop-migration — nothing to backfill or roll back. Regenerated the Prisma client via PowerShell (`node_modules\.bin\prisma generate`) after the schema edit.
3. Kept custom-line materialization (item C) exactly as specified — unaffected by this change.
4. Deleted the CO-over-cap and duplicate-CO tests from `e2e/progress-billing.spec.ts` and replaced them with one test asserting a `changeOrderId` line is rejected with the message above (`createProgressBillingCore — consumption guard` describe block).
5. This report section documents the redirect and rationale, per the coordinator's instruction.

Everything else in the brief (A units, B milestone-only consumption guard, D conditional claim, E orphan compensation, F code numbering / taxExempt rate / cent-safe r2, remaining G tests) is unchanged by this course change.

### 2.6 — `settleProgressBillingPaidCore` extraction (`src/lib/quickbooks-payments.ts`)

The progress-billing settle transaction that used to be inlined in `syncQuickBooksPayments`'s second loop is now an exported standalone function, `settleProgressBillingPaidCore(billingId, payment)`, used both by `syncQuickBooksPayments` (unchanged behavior — same claim, same per-line settle via `settleMilestonePaidInTx`) and directly by the new e2e settle test, which simulates a Staged billing (no live QuickBooks in the test DB, same pattern the pre-existing "draft-only guard" test already used) rather than trying to fake a QBO probe response.

## 8. What I ran, and what I could not

- **`npm run build`** (PowerShell, `tsc --noEmit && next build`) — **passed, 0 errors**, run twice: once right after the A–F implementation, once again after the §2.5 course-change edits (schema + code + Prisma regen). Tail of the second run confirmed the full static/dynamic route listing completed with no `error TS`/`Failed to compile`/`Type error` lines (grepped explicitly, zero matches).
- **`node_modules\.bin\prisma generate`** (PowerShell, per this repo's rule — never Git Bash) — succeeded after the `changeOrderId` column removal from `schema.prisma`.
- **`npx playwright test --list e2e/progress-billing.spec.ts`** — succeeded, discovered and listed all 23 tests across 3 files (the 2 shared fixtures + 21 in this spec), confirming imports resolve and the file is syntactically well-formed. This does **not** type-check the file — `e2e/` is excluded from `tsconfig.json`'s `include`, so `npm run build`'s `tsc` pass never touches it, and Playwright's own loader (esbuild-based) strips types without checking them. I do not have independent type-level verification of the spec file beyond careful manual review.
- **`npx playwright test` (actual execution against a throwaway Postgres) — did NOT run.** Docker CLI is present but the daemon was not running. I started Docker Desktop and polled `docker info` across three separate waits (roughly 2 min, 4.5 min, and a background poll up to ~6.5 min) — the daemon never came up in this environment within that combined ~13 minutes. **I could not execute any test in this file, round 1's tests, `e2e/money-pipeline.spec.ts`, or `e2e/milestone-rebalance.spec.ts`.** Per the task's own instruction ("If Docker/Postgres is unavailable, say so explicitly... CI runs them on the PR"), this is disclosed rather than papered over. All money-math assertions in the new/changed tests were hand-computed against the implementation's formulas (shown inline as comments in the test file, e.g. `108/1.088 = 100.0`, `25000 * 1.088 = 27200`) but are **not machine-verified**. This is the single biggest residual risk in this deliverable — CI will run the real suite on the PR and must be checked before merge.
- Did not touch prod/Supabase at any point, per the hard constraint.

## 9. Remaining risks

- **Unexecuted test suite** (see §8) — the highest-priority thing to check once CI runs.
- **`updateProgressBillingCore`'s narrow scope** (round-1 deviation, still true): line composition still isn't editable after creation; unchanged by this round.
- **Committed-amount conversion for the consumption guard uses each historical line's OWN billing's `taxRate`/`taxExempt`** to gross it back up to milestone units (for legacy vintage) rather than the current billing's rate. This is correct as long as `taxRate`/`taxExempt` are immutable per billing after creation (they are, except `taxExempt` can flip via `updateProgressBillingCore`, which does NOT touch the stored `taxRate` — see F.2 — so the conversion stays correct even after an update). Flagging the reasoning here in case a future change to `updateProgressBillingCore` ever lets `taxRate` itself change.
- **RLS on `ProgressBilling`/`ProgressBillingLine`** — unchanged from round 1 (off, matching the Invoice/PaymentSchedule precedent).
- Change-order billing itself (via `billChangeOrderCore`/`handleChangeOrderApproved`) was not touched by this task and is owned by the concurrent session referenced in §2.5.
