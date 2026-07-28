# PB-pipeline-004 Cost-Plus Change Orders - Implementation Report

Generated: 2026-07-21 00:56 America/Los_Angeles  
Worktree: `C:\Users\jat00\workspaces\golden-touch\active\gtr-probuild-site\.claude\worktrees\intelligent-mcnulty-14a55c`  
Branch: `claude/cost-plus-milestone-cos-c717be`  
Git state: implementation intentionally left as an uncommitted diff; no commit, push, deployment, Git configuration change, or production database action was performed.

## 1. Outcome and summary

All requested implementation work from spec sections 4-9 and amendments A-D is present in the assigned worktree. The feature now supports both fixed-price and cost-plus change orders, cost-plus actuals sourced from tagged time and expenses, frozen billing snapshots, split fixed-price milestones, invoice aggregation, QuickBooks handoff rules, backup T&M PDFs, staff and portal UI, and MCP v1.9.0 operations.

Money calculations use integer cents. `ChangeOrder.totalAmount` remains pre-tax. Billing uses the existing canonical `Estimate -> Invoice -> schedule` lock order through `lockMoneyParents`/`withTxRetry`, and this change did not introduce another paid-milestone lifecycle writer; existing paid side effects continue through `notifyMilestonePaid()`.

Functional verification is green: the new feature suite and the existing money pipeline pass together (44/44), the production build passes, type checking passes, Prisma validates and generates, the migration applies twice to a disposable PostgreSQL 16 database, and changed/new TypeScript files have zero lint errors. The independent Security Engineer gate passed.

Strict QAS status is **NOT Approved for RTE** only because the required repository-wide `npm run lint` command has a pre-existing baseline of 275 errors outside this feature. The changed/new TypeScript files have 0 errors (191 warnings). No unrelated files were rewritten or lint rules suppressed to conceal that baseline.

## 2. Behavior implemented

- Added `FIXED` and `COST_PLUS` pricing with optional markup, edit/send state rules, immutable sent terms, zero-dollar scope support, and cost-plus approval without fabricated fixed-price line items.
- Added fixed split schedules with cent-exact remainder handling and one-to-one `sourceCoScheduleId` links on generated invoice milestones.
- Added project/change-order tagging for time and expenses, mobile-shaped crew time handling, receipt ownership checks, billable controls, and mutation/retag/delete protection once either `invoiceId` or `invoicedAt` marks a row billed.
- Added cost-plus preview and billing cores with eligible-row locks, token/fingerprint drift rejection, frozen labor/expense/markup/tax snapshots, row stamping, source links, invoice aggregate recomputation, and idempotent "nothing to bill" behavior.
- Added company IANA timezone resolution in DB -> `COMPANY_TIMEZONE` -> `America/Los_Angeles` order and DST-safe local end-of-day conversion for `throughDate`.
- Added split-aware cash-basis tax reporting. Stored split tax is reported directly, while only residual invoice tax is allocated across unsplit payments with final-row rounding absorption.
- Added split-aware QBO reconciliation. Split-bearing milestones are rejected with void/rebill guidance, while reconciliation of unsplit milestones preserves frozen CO tax in mixed invoices.
- Added a single-email QuickBooks send path by appending the ProBuild pay URL to QBO `CustomerMemo` before QBO sends the invoice.
- Added honest cost-plus PDFs and T&M backup billing PDFs. The backup route validates staff access or exact portal client/invoice/change-order/billing ownership and returns 404 for every mismatch.
- Added staff Actuals/billing history and schedule editing, time/expense CO selectors and bulk actions, portal cost-plus/schedule copy, invoice backup links, and MCP tools for listing COs, logging actuals, and billing with two-step confirmation bound to the billing fingerprint.

## 3. File-by-file changes and rationale

- `prisma/schema.prisma` - Added cost-plus, tagging, source-split, timezone, and frozen `ChangeOrderBilling` schema fields/relations/indexes.
- `migrations/004_cost_plus_change_orders.sql` - Added the hand-written, rerunnable SQL counterpart with matching columns, indexes, unique constraints, foreign keys, and delete behavior.
- `src/lib/time-expense-core.ts` - New session-free time/expense core (intentionally no `"use server"`) for direct and MCP reuse, tagging, crew entries, eligibility, and receipt ownership.
- `src/lib/time-expense-actions.ts` - Kept authenticated wrappers in the server-action module; added Zod validation, project-access checks, safe receipt-field whitelisting, bulk tagging, and billed-row guards.
- `src/lib/company-timezone.ts` - New company/env/default timezone resolver and DST-safe local end-of-day conversion.
- `src/lib/billing-core.ts` - Implemented preview/fingerprint, cost-plus bill creation, immutable snapshot/stamping, fixed lump/split billing, parent/row locking, retry handling, invoice aggregation, approval coordination, and QBO send sequencing.
- `src/lib/change-order-core.ts` - Added pricing/markup/schedule inputs, fixed split validation, sent-term locking, sent-to-draft editing, and cost-plus empty-item/zero-line behavior.
- `src/lib/actions.ts` - Extended authenticated change-order operations to pass and return the new pricing, schedule, preview, and billing data.
- `src/lib/quickbooks.ts` - Added idempotent sparse QBO `CustomerMemo` update support for the pay URL.
- `src/lib/quickbooks-payments.ts` - Added stored-split reconciliation rejection, 21-character document numbering, and split-aware invoice aggregate tax recomputation.
- `src/lib/sales-tax-report.ts` - Implemented amendment A's direct stored-tax rows and residual-only allocation for mixed invoices.
- `src/lib/pdf.ts` - Added cost-plus-aware CO presentation and the frozen T&M backup invoice PDF.
- `src/app/api/pdf/change-orders/[id]/billing/[billingId]/route.ts` - Added no-store PDF delivery with strict staff/portal ownership checks and non-leaking 404 responses.
- `src/proxy.ts` - Added the exact backup-PDF route bypass so the route can perform its own staff/token authorization.
- `src/app/api/mcp/[transport]/route.ts` - Advanced MCP to v1.9.0; extended create/send/bill and added `list_change_orders`, `log_time`, and `log_expense`, including burden defaults and fingerprint-bound confirmation.
- `src/app/projects/[id]/change-orders/[coId]/ChangeOrderEditor.tsx` - Added fixed/cost-plus editing, markup and split schedules, Actuals preview, billing action/history, and honest pricing labels.
- `src/app/projects/[id]/time-expenses/TimeExpensesClient.tsx` - Supplied project CO choices and tagging actions to both tabs.
- `src/app/projects/[id]/time-expenses/TimeTab.tsx` - Added CO/billable display, selection, bulk tagging, and billed-row affordance protection.
- `src/app/projects/[id]/time-expenses/ExpensesTab.tsx` - Added matching expense selection/tagging and billed-row protections.
- `src/app/projects/[id]/time-expenses/NewTimeEntryModal.tsx` - Added CO and billable inputs for new time entries.
- `src/app/projects/[id]/time-expenses/NewExpenseEntryModal.tsx` - Added CO/billable inputs and safe receipt association for new expenses.
- `src/app/portal/change-orders/[id]/page.tsx` - Serialized new decimal-backed CO data before crossing the server/client boundary.
- `src/app/portal/change-orders/[id]/PortalChangeOrderClient.tsx` - Added cost-plus language and schedule presentation without implying a fixed total.
- `src/app/portal/invoices/[id]/PortalInvoiceClient.tsx` - Added backup-detail links for milestones backed by frozen CO billing.
- `e2e/cost-plus-change-order.spec.ts` - Added serial, teardown-safe coverage for the requested lifecycle and amendments A-D, including authorization denials and legacy billed markers.

No change was made to `src/lib/payment-notifications.ts`; the existing canonical notification writer was reused.

## 4. Deviations and review gates

There are no intentional functional deviations from the requested spec/amendments.

The following execution differences or gate exceptions are disclosed:

1. The production manual "Shop Test" was not run because the request explicitly places it out of scope and forbids production actions.
2. Live QBO email delivery, live payment links, and live Supabase Storage were not invoked. Automated tests use dependency injection/local signature persistence while exercising the same approval, URL composition, billing, and authorization code paths.
3. The repository does not contain the referenced RLS helper/policy pattern library for these Prisma-backed tables. Tenant isolation is therefore enforced at the application query/action/route layer, consistent with existing repository code. The independent security review accepted the implementation but records this as a residual architectural risk.
4. QAS cannot issue "Approved for RTE" under the strict gate because repository-wide lint fails in unrelated baseline files. Examples independently confirmed include `e2e/qa-navigation-audit.spec.ts:155`, `src/app/api/messages/route.ts:46`, and `src/lib/gmail-sync.ts:56`. The feature's changed/new TypeScript files have no lint errors.
5. An existing portal invoice server/client Decimal serialization warning appears during the existing money-pipeline browser flow. It predates and is outside this CO implementation; all tests and build still pass. The new portal change-order page serializes its newly added Decimal-backed values.
6. Pattern-library and RLS guide paths named by repository instructions were absent in this worktree. Discovery used the source spec and existing implementation patterns. Independent architecture review approved the chosen approach and did not require a new ADR.

Independent gates:

- System Architect: approved the implementation approach; no architecture conflict or ADR requirement identified.
- Security Engineer: **PASS**. Verified staff/portal ownership, non-leaking 404s, project access, receipt ownership, billed-row guards, fingerprint drift, locking, QBO split refusal, and lack of duplicate paid-event writers.
- QAS: functional suites/typecheck/build/changed-file lint accepted, but overall **NOT Approved for RTE** due solely to the existing full-repository lint baseline described above.

## 5. Verification evidence

Secrets below are represented as local placeholders; no secret was written to this report or repository.

### Prisma schema and client

Command:

```powershell
npx prisma validate
```

Tail:

```text
Prisma schema loaded from prisma\schema.prisma
The schema at prisma\schema.prisma is valid
PRISMA_VALIDATE_EXIT=0
```

Required PowerShell generation command:

```powershell
powershell -Command "cd '<assigned-worktree>'; node_modules\.bin\prisma generate"
```

Tail:

```text
Generated Prisma Client (v5.22.0)
PRISMA_GENERATE_EXIT=0
```

### Disposable database and migration

Commands (only against local Docker PostgreSQL 16 on `localhost:5433`):

```powershell
$env:DATABASE_URL='<disposable-local-postgres-url>'
$env:DIRECT_URL=$env:DATABASE_URL
npx prisma db push
npx prisma db execute --file migrations/004_cost_plus_change_orders.sql --schema prisma/schema.prisma
npx prisma db execute --file migrations/004_cost_plus_change_orders.sql --schema prisma/schema.prisma
```

Tails:

```text
Your database is now in sync with your Prisma schema. Done in 2.23s
DB_PUSH_EXIT=0
Script executed successfully.
FIRST_MIGRATION_EXIT=0
Script executed successfully.
SECOND_MIGRATION_EXIT=0
```

The exact disposable container was removed after verification:

```text
probuild-e2e
DOCKER_CLEANUP_EXIT=0
```

### Typecheck and build

Commands:

```powershell
npm run type-check
$env:DATABASE_URL='<disposable-local-runtime-url-with-pgbouncer=true>'
$env:DIRECT_URL='<disposable-local-direct-url>'
$env:NEXTAUTH_SECRET='<local-build-only-secret>'
$env:CLERK_SECRET_KEY='<local-test-key>'
npm run build
```

Result tails:

```text
TYPECHECK_EXIT=0
Compiled successfully
Generating static pages using 15 workers (96/96)
BUILD_EXIT=0
```

The build route manifest included `/api/pdf/change-orders/[id]/billing/[billingId]`.

### Lint

Required repository command:

```powershell
npm run lint
```

Tail:

```text
4703 problems (275 errors, 4428 warnings)
LINT_EXIT=1
```

Independent QAS rechecked without its generated QA report and still found 90 pre-existing source errors. No reported error was introduced by this feature.

Changed/new TypeScript-only command:

```powershell
$files = @(git status --short | ForEach-Object { $_.Substring(3) } | Where-Object { $_ -match '\.(ts|tsx)$' })
npx eslint -- $files
```

Tail:

```text
191 problems (0 errors, 191 warnings)
CHANGED_TS_LINT_EXIT=0
```

Warnings are existing patterns such as `no-explicit-any`, legacy `<img>` use, and existing unused values in touched files; no lint rule was disabled for this feature.

### Playwright

All browser/data tests used the disposable PostgreSQL container. `ALLOW_PROD_E2E` was never set.

Commands:

```powershell
npx playwright test e2e/cost-plus-change-order.spec.ts --project=chromium
npx playwright test e2e/money-pipeline.spec.ts --project=chromium
$env:DATABASE_URL='<disposable-local-runtime-url-with-pgbouncer=true>'
$env:DIRECT_URL='<disposable-local-direct-url>'
$env:NEXTAUTH_SECRET='<local-test-only-secret>'
$env:PLAYWRIGHT_TEST_SECRET='<local-test-only-secret>'
npx playwright test e2e/cost-plus-change-order.spec.ts e2e/money-pipeline.spec.ts --project=chromium
```

Result tails:

```text
12 passed (28.3s)
FEATURE_E2E_EXIT=0
34 passed (48.4s)
MONEY_PIPELINE_EXIT=0
44 passed (53.8s)
COMBINED_E2E_EXIT=0
```

The combined count includes the existing data/auth setup projects. Coverage includes: draft/send/approval with empty items and a $0 scope line; mobile-shaped labor plus burden; receipt expense; token drift; snapshot/stamps/aggregates; legacy `invoicedAt` exclusion; second-bill idempotency; DST inclusion; fixed lump and cent-exact split schedules/source links; mixed-invoice cash tax; QBO split rejection and mixed aggregation; staff/portal PDF access plus missing/mismatched/cross-client denial; and MCP schema/core behavior.

The final diff check was also clean using the repository's CRLF-aware setting:

```powershell
git -c core.whitespace=cr-at-eol diff --check
```

```text
DIFF_CHECK_EXIT=0
```

## 6. Migration notes

`migrations/004_cost_plus_change_orders.sql` is additive and rerunnable:

- `CompanySettings`: `timeZone TEXT NOT NULL DEFAULT 'America/Los_Angeles'`.
- `ChangeOrder`: `pricingType TEXT NOT NULL DEFAULT 'FIXED'`, nullable `markupPercent`.
- `TimeEntry`: nullable `changeOrderId`, nullable `invoiceId`, nullable `notes`, and `isBillable BOOLEAN NOT NULL DEFAULT false`.
- `Expense`: nullable `changeOrderId`, nullable `invoiceId`, nullable `invoicedAt`, and `isBillable BOOLEAN NOT NULL DEFAULT false`.
- `PaymentSchedule`: nullable `pretaxAmount`, `taxAmount`, `sourceChangeOrderId`, and `sourceCoScheduleId`.
- New `ChangeOrderBilling`: cents-based frozen totals, JSON snapshot, creator/audit timestamp, required CO relation, and optional one-to-one payment schedule relation.
- Unique indexes: `PaymentSchedule_sourceCoScheduleId_key` and `ChangeOrderBilling_paymentScheduleId_key`.
- Lookup indexes: both tagged-actual CO fields, payment source CO, and billing CO.
- `ON DELETE SET NULL`: time/expense CO tags, invoice source CO schedule, and billing payment-schedule link.
- `ON DELETE CASCADE`: a `ChangeOrderBilling` belongs to its `ChangeOrder` and is removed with that parent.
- Column/index statements use `IF NOT EXISTS`; named foreign keys are guarded through `pg_constraint`. Applying the migration twice succeeded.

No migration was applied to a remote or production database. No destructive/backfill operation is included. Existing rows retain `FIXED`, non-billable, or null defaults, preserving legacy behavior.

## 7. Not done

- No manual production Shop Test, deployment, Vercel command, live database mutation, live QBO mutation/email, or live payment was performed.
- No mobile application UI, Stripe rail, or NTE cap was added; all are explicitly out of scope.
- No commit, push, branch rewrite, staging operation, or Git configuration change was performed.
- The source specification was not modified.
- Unrelated repository lint errors and portal invoice Decimal warnings were not changed because doing so would broaden this feature's scope and overwrite unrelated work.

## 8. Risks and edge cases

- Database-level RLS is not present for these Prisma models in this worktree. Application-layer checks are comprehensive, but a future alternate database access path must repeat tenant authorization unless RLS is added.
- The existing MCP bearer secret is accepted through the existing transport/query mechanism; URLs or infrastructure logs could expose a query-carried secret. This is inherited behavior, not introduced here.
- QBO reconciliation deliberately cannot mutate a frozen split billing. Operators must void/rebill in ProBuild; this protects auditability but is a procedural constraint that should be documented for support.
- The live QBO API can still reject a sparse memo update for account-specific reasons not reproducible locally. The operation is idempotent and occurs before the single QBO email call, so failures do not produce a second email path.
- IANA timezone resolution falls back safely, but reviewers should ensure `CompanySettings.timeZone` is populated with a valid zone for companies outside Los Angeles.
- Cost-plus billing locks and rechecks eligible rows and is idempotent; the suite validates repeated billing but does not intentionally manufacture every possible database deadlock topology.
- `CREATE TABLE IF NOT EXISTS` is rerunnable for the expected migration sequence but would not repair an independently created, structurally incompatible table with the same name.
- Existing portal invoice Decimal serialization warnings should be handled in a separate cleanup to prevent a future framework version from making them fatal.

## 9. Open questions for the reviewer

1. Should the current repository-wide lint baseline receive a documented waiver for this review, or should a separate cleanup ticket be completed before RTE approval?
2. Is application-layer tenant isolation acceptable for this release, or should a follow-up database RLS migration be required before deployment?
3. Should QBO void/rebill operator guidance and the inability to reconcile frozen split milestones be added to the support runbook?
4. Should the existing portal invoice Decimal serialization warnings be addressed before this feature is merged, despite being outside PB-pipeline-004?

## Reviewer disposition

Implementation and feature verification are complete. Security is approved. The work is ready for human code review as an uncommitted diff, but it is not eligible for the strict "Approved for RTE" exit state until the reviewer resolves the repository-wide lint gate by remediation or an explicit baseline waiver.
