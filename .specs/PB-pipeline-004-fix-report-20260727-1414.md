# PB-pipeline-004 Round-1 Fix Report

- Date: 2026-07-27 14:14 America/Los_Angeles
- Baseline: b7fbad2
- Scope: findings F1-F6 from .specs/PB-pipeline-004-fix-brief-round1.md
- Database safety: no production URL, ALLOW_PROD_E2E was not set, and no deploy/commit/push was performed.

## Findings fixed

### F1 - CO-backed invoice deletion and re-splitting

Added assertInvoiceHasNoChangeOrderBilling and invoke it inside the existing locked transactions for both deleteInvoice and splitInvoiceMilestones. It rejects schedules with sourceChangeOrderId, sourceCoScheduleId, or coBilling, with the explicit void/rebill direction. Added CPCO-F1 coverage for both UI operations and preservation of the invoice/schedule.

### F2 - CO-tagged/already-billed labor invoice selection

createInvoiceFromTimeEntries now runs in a retryable transaction, scopes rows to the requested project, requires changeOrderId, invoiceId, and invoicedAt to be null, and claims them with a conditional updateMany, rejecting concurrent/partial claims. TimeTab now disables ineligible row selection and provides explanatory titles. Added CPCO-F2 coverage for eligible, tagged, and billed rows.

### F3 - Company-local date-only actuals

Extended company-timezone.ts with validated wall-clock conversion and dateOnlyInTimeZone, consistently storing date-only time and expense values at company-local noon. Existing end-of-day conversion remains company-local and includes the selected date. Added CPCO-F3 coverage proving March 8 is included through March 8 and March 9 is excluded.

### F4 - Server-authoritative labor and burden

Added createTimeEntryFromStoredRatesCore, which reads the selected user's stored hourly and burden rates and reuses calculateCrewTimeCosts. The web action no longer accepts client-provided labor/burden costs; the modal only displays a preview. Added CPCO-F4 coverage for stored-rate labor and burden calculation.

### F5 - Change-order line-item ownership

createExpenseCore now verifies any supplied EstimateItem belongs to the resolved estimate after change-order resolution. The modal clears the item selection and switches the estimate when the change order changes. Added CPCO-F5 coverage for a cross-estimate item rejection.

### F6 - Receipt attachment failure state

New receipt selection immediately clears the prior receiptFileId. Upload, storage, and registration failures now produce a sonner error and inline error state; submit is disabled while scanning/uploading or while an attachment error remains, with a clear-receipt recovery action. Added CPCO-F6 source regression coverage.

## Files changed

- src/lib/actions.ts
- src/lib/company-timezone.ts
- src/lib/time-expense-core.ts
- src/lib/time-expense-actions.ts
- src/app/projects/[id]/time-expenses/TimeTab.tsx
- src/app/projects/[id]/time-expenses/NewTimeEntryModal.tsx
- src/app/projects/[id]/time-expenses/NewExpenseEntryModal.tsx
- src/app/projects/[id]/time-expenses/TimeExpensesClient.tsx
- e2e/cost-plus-change-order.spec.ts

No Prisma schema or migration change was needed.

## Verification evidence

| Check | Result | Evidence |
|---|---|---|
| npm run typecheck | PASS | Exit 0; tsc --noEmit completed. |
| Changed-file ESLint | PASS | Exit 0; 0 errors and 111 warnings. Warnings are the repository's existing any/unused-symbol baseline; F7 was explicitly out of scope. |
| Playwright discovery | PASS | npx playwright test e2e/cost-plus-change-order.spec.ts e2e/money-pipeline.spec.ts --project=chromium --list exit 0; 50 tests listed, including CPCO-F1 through CPCO-F6. |
| git -c core.whitespace=cr-at-eol diff --check | PASS | Exit 0. |
| npm run build | BLOCKED | Typecheck phase passed, then Next.js failed fetching pre-existing next/font/google Geist/Geist Mono resources because this sandbox cannot reach fonts.googleapis.com. No application/type error was reported. |
| Required Playwright execution | BLOCKED | Safe localhost URL was used: 127.0.0.1:5433, with local-only credentials. Docker is unavailable (dockerDesktopLinuxEngine pipe missing). The test runner also cannot spawn its worker process in this restricted sandbox (Error: spawn EPERM), including --workers=1. No test ran against a database. |

The implementation diff is intentionally left uncommitted on top of b7fbad2, as required.
