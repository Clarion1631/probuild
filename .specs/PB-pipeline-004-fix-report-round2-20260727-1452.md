# PB-pipeline-004 Round-2 Fix Report

- Date: 2026-07-27 14:52 America/Los_Angeles
- Baseline: `b7fbad2`
- Scope: findings G1–G3 from `.specs/PB-pipeline-004-fix-brief-round2.md`
- Worktree safety: no production URL, no deploy, no commit, no push, and no schema/migration change.
- Existing round-1 uncommitted work was preserved.

## Findings fixed

### G1 — Fixed-split billing preserves signed due dates

- Added `dateInputInTimeZone()` on top of the existing `dateOnlyInTimeZone()` helper. `YYYY-MM-DD` schedule inputs now become company-local noon instants, while full timestamp inputs retain their explicit instant.
- Applied the company-timezone parser in `updateChangeOrderCore`; the change-order draft path uses the same parser for consistent schedule semantics.
- Added each `ChangeOrderPaymentSchedule.dueDate` to the fixed split plan and writes it to the created `PaymentSchedule.dueDate`.
- Extended `CPCO6` to create date-only signed schedule inputs through `updateChangeOrderCore` and assert the created `Start` and `Finish` milestones retain both signed dates.

Files: `src/lib/company-timezone.ts`, `src/lib/change-order-core.ts`, `src/lib/billing-core.ts`, `e2e/cost-plus-change-order.spec.ts`.

### G2 — Receipt uploads serialize and ignore stale completions

- Added an incrementing `useRef` request-generation token.
- Every asynchronous OCR/upload/registration completion checks its token before state or toast writes; stale requests return without changing shared form state.
- Disabled the file input and guarded the picker click while OCR/upload is in flight.
- Clearing a receipt also invalidates the active generation.

Files: `src/app/projects/[id]/time-expenses/NewExpenseEntryModal.tsx`, `e2e/cost-plus-change-order.spec.ts`.

### G3 — Form defaults use the company-local calendar date

- The server page resolves the company timezone through `resolveCompanyTimeZone()` and passes it through `TimeExpensesClient` to both modals.
- Both modals derive their initial date with `Intl.DateTimeFormat({ timeZone })`; neither uses a UTC ISO-date fallback.

Files: `src/app/projects/[id]/time-expenses/page.tsx`, `src/app/projects/[id]/time-expenses/TimeExpensesClient.tsx`, `src/app/projects/[id]/time-expenses/NewTimeEntryModal.tsx`, `src/app/projects/[id]/time-expenses/NewExpenseEntryModal.tsx`, `e2e/cost-plus-change-order.spec.ts`.

## Files touched in the worktree

Round-2 changes are in the files listed above. The following existing round-1 files remained part of the intentionally uncommitted worktree diff and were not reverted: `src/lib/actions.ts`, `src/app/projects/[id]/time-expenses/TimeTab.tsx`, `src/lib/time-expense-actions.ts`, and `src/lib/time-expense-core.ts`.

## Verification evidence tails

| Check | Result | Evidence tail |
|---|---|---|
| `npm run typecheck` | PASS | `> goldentouch-pro@0.1.0 typecheck` / `> tsc --noEmit`; exit code 0. |
| Changed-file ESLint | PASS | `✖ 119 problems (0 errors, 119 warnings)`; exit code 0. Warnings are the existing any/unused-symbol baseline. |
| G1/G2/G3 source regression checks | PASS | `G1/G2/G3 source regression checks: PASS`; exit code 0. |
| Playwright discovery | PASS | `Total: 52 tests in 4 files`; exit code 0. The new G2/G3 checks and updated CPCO6 are listed. |
| Required Playwright execution | BLOCKED | Local-only run started with `Running 52 tests using 1 worker`, then failed before any test ran: `Error: spawn EPERM` in Playwright `processHost.js`. |
| Docker disposable Postgres | BLOCKED | `failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`; Docker was unavailable. |
| `git -c core.whitespace=cr-at-eol diff --check` | PASS | Exit code 0. |

The exact requested browser tests not executed were all Chromium tests in `e2e/cost-plus-change-order.spec.ts` (18 listed tests) and `e2e/money-pipeline.spec.ts` (32 listed tests). The requester should rerun those two specs outside the sandbox with disposable Docker Postgres and worker spawning available.

The implementation diff remains uncommitted on top of `b7fbad2`, as required.