# Code Review — Pin QBO TxnTaxCodeRef from the estimate's jurisdiction

- **Review Date**: 2026-08-30
- **Version**: PR #432, branch `fix/qbo-milestone-tax-code` @ `8cd8745b` (stacked on #431 `fix/qbo-milestone-ship-addr`)
- **Target**: `qbo-tax-code-pin` (unplanned fix from the 2026-08-29 tax investigation)
- **Reviewer**: Codex (`gpt-5.6-sol`, effort xhigh), thread `01a04ff3-1545-7813-8750-6962b35d9a2e`

## Files Reviewed

- `src/lib/quickbooks.ts` — new `resolveQBTaxCodeId()`; `createQBMilestoneInvoice` gains optional `taxCodeId` → `TxnTaxDetail.TxnTaxCodeRef`
- `src/lib/quickbooks-payments.ts` — `pushMilestoneToQuickBooks` selects `estimate.taxRateName`, resolves and passes the code
- `src/lib/progress-billing.ts` — `stageProgressBillingToQuickBooksCore` likewise
- `tests/qbo-tax-code-pin.test.ts` — new; registered in `package.json` `test:unit`
- Out-of-repo helper reviewed in the same thread: `I:\My Drive\Claude\qbo-access.mjs` `--post` mode

## Plan

No plan — unplanned change. Root cause: QBO milestone invoices carried `TotalTax` but no `TxnTaxCodeRef`, so QBO recomputed tax at its default code's rate (Berg ADU INV-00177-2: Vancouver 8.9% on a Winlock 8.0% job, phantom $125 balance).

## Findings

| # | Severity | Location | Finding | Disposition |
|---|---|---|---|---|
| 1 | Major | `src/lib/quickbooks.ts:249` | New money-path logic had no tracked tests or verification summary | fixed — `tests/qbo-tax-code-pin.test.ts` (7 cases: matching, inactive/no-match/error fallbacks, escaping, three payload shapes); 7/7 pass, `tsc --noEmit` clean |
| 2 | Major | (round 2) | Diff appeared empty | not a defect — reviewer saw the restored shared checkout; work lives on the PR branch/worktree |
| 3 | Major | `qbo-access.mjs:84` | `argv` join+split broke quoted paths and Git Bash-rewritten entity paths | fixed — positional `process.argv` parsing, exactly two operands enforced |
| 4 | Major | `qbo-access.mjs:95` | `--post` forwarded arbitrary payloads; could create/full-replace instead of sparse update | fixed — payload must be a non-array object with `sparse:true`, `Id`, non-empty `SyncToken` |

## Checklist

- [x] 1. Correctness — tax math unchanged; code ref emitted only on taxed invoices; 401 retry persists rotated refresh token before retrying
- [x] 2. Security / safety — lookup failures fail soft to the prior payload; no authorization surface changed; helper refuses non-sparse payloads
- [x] 3. Plan / intent conformance — both milestone rails pin the estimate jurisdiction; no-match keeps today's behavior with a warning
- [x] 4. Practical concerns — one bounded QBO lookup per taxed push; no N+1, mirror, notification, schema, or concurrency changes

Caveat: requires the QBO TaxCode name to equal ProBuild's `taxRateName` (today "Winlock" ↔ 13, "Vancouver City" ↔ 5); unmatched names log a warning and fall back.

## Verdict

`APPROVED` (rounds: 1 REQUEST_CHANGES → tests added; 3 APPROVED for the PR diff; 4 REQUEST_CHANGES on the helper → fixed; 5 APPROVED, no new findings)
