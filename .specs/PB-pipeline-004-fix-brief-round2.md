# PB-pipeline-004 — TRIP-2 round-2 fix brief (final)

Round-2 review confirmed F1, F2, F4, F6 fixed and F3/F7 mostly fixed. Three items remain. Same
working rules as `.specs/PB-pipeline-004-fix-brief-round1.md`: worktree only, no commit/push, no
prod, surgical changes, integer cents, PowerShell-only prisma generate.

## G1 [Major] Fixed-split billing drops signed due dates (round-1 finding, omitted from the prior brief)

`pretaxPlans` (src/lib/billing-core.ts:~1347) drops each `ChangeOrderPaymentSchedule.dueDate`,
milestone creation (~1403) never sets it, and schedule date-only parsing in
src/lib/change-order-core.ts:~70 is UTC-based.
**Fix:** carry `dueDate` from each CO schedule row through the split plan into the created
`PaymentSchedule.dueDate`. Parse date-only schedule dates with calendar-date semantics in the
company timezone (reuse `dateOnlyInTimeZone` from src/lib/company-timezone.ts), consistent with
the F3 fix. Extend the split e2e test to assert created milestones carry the signed due dates.

## G2 [Major] Overlapping receipt uploads can attach the wrong file

NewExpenseEntryModal.tsx (~48, ~102, ~111, ~163): the file picker stays active during an upload,
so two `handleReceiptOCR` calls can overlap; the last finisher overwrites shared
`receiptFileId`/error state and the first can clear `ocrLoading` while the second still runs.
**Fix:** disable the file input while an upload is in flight AND add a request-generation token
(incrementing ref); completions whose token is stale are ignored entirely (no state writes).

## G3 [Major] Form default dates use UTC "today" — evening entries default to tomorrow

NewTimeEntryModal.tsx:~21 and NewExpenseEntryModal.tsx:~24 default the date field from
`new Date().toISOString()`. After 17:00 PDT that is tomorrow's date, and with company-local-noon
persistence the entry genuinely lands on the wrong day.
**Fix:** default the date to "today" in the company timezone. Pass the resolved company time zone
(server-side, same resolution chain as company-timezone.ts) into these client components — or
compute the local date string via `Intl.DateTimeFormat` with the company zone provided by the
server — and use it for the default value. Do not silently fall back to UTC.

## Verification required

- `npm run typecheck` → 0 errors; changed-file eslint → 0 errors.
- Playwright `e2e/cost-plus-change-order.spec.ts` + `e2e/money-pipeline.spec.ts` (chromium)
  against the disposable Docker PG if available; if the sandbox blocks Docker/spawn, list exactly
  which tests could not run — the requester re-runs them outside the sandbox.
- Extend tests: G1 due-date assertion (required); G2/G3 covered by source-level regression checks
  if browser-level simulation is impractical.

## Final deliverable

Write `.specs/PB-pipeline-004-fix-report-round2-<YYYYMMDD-HHMM>.md` (unique timestamp) with the
per-finding fixes, files touched, and verification evidence tails. Print the full contents
between ===REPORT START=== and ===REPORT END=== as your final output.
