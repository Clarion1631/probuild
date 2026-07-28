# PB-pipeline-004 — Cost-Plus & Milestone Change Orders (Voice-First via MCP)

**Status:** TRIP-1 plan gate (Codex review: gpt-5.6-sol, xhigh) — Rev 2 (round-1 findings addressed)
**Date:** 2026-07-20
**Author:** Kimi (for Justin)

---

## 1. Goal

Change orders today are implicitly fixed-price: `qty × unitCost` line items + tax, billed as
one lump milestone. GTR actually runs three kinds of COs:

1. **Fixed price** — today's behavior (keep, unchanged default).
2. **Cost-plus** ("cost plus 10") — customer approves *scope + markup terms*; the crew then
   logs time and expenses against the CO; billing = (labor cost + expenses) × (1 + markup) + tax,
   with itemized backup, sent to the customer for payment.
3. **Milestone** — a fixed-price CO split into 2+ payments using the existing (currently unused)
   `ChangeOrderPaymentSchedule` model instead of one lump milestone.

The primary creation surface is **voice**: Richard in the field talks to his AI, which drives
the existing MCP server (`/api/mcp`, v1.8.0) to draft, preview, confirm, and send the CO, and
later to log time/expenses and bill actuals.

**QuickBooks side is in scope**: every billed milestone (lump, split, or cost-plus T&M) must flow
through the existing QB rail (`pushMilestoneToQuickBooks` → `qbInvoiceId`/`qbInvoiceLink` →
`sendMilestoneInvoicesCore` email → `syncQuickBooksPayments` reconciliation). No new payment rail.

## 2. Current state (verified 2026-07-20)

- `ChangeOrder` (schema.prisma:1233): `status` Draft/Sent/Approved/Declined, `totalAmount` =
  pre-tax subtotal, `items ChangeOrderItem[]` (qty/unitCost, plus unused-per-CO `baseCost` +
  `markupPercent default 25`), `paymentSchedules ChangeOrderPaymentSchedule[]` (defined, never
  rendered or billed).
- No pricing-type concept anywhere; every CO is fixed price.
- `approveChangeOrderCore` (change-order-core.ts:~222) rejects COs with empty/non-positive
  items — must branch by `pricingType` for COST_PLUS ($0/empty scope lines are legal there).
- `TimeEntry` (schema:633): `laborCost` and `burdenCost` stored **separately** (mobile-created
  entries carry both), `invoicedAt` timestamp but **no** `invoiceId`, **no** `isBillable`,
  **no** `changeOrderId`, **no** notes column. `NewTimeEntryModal` Billable/Taxable checkboxes
  silently dropped (`time-expense-actions.ts:19-48`).
- `Expense` (schema:491): attaches to an **Estimate**, `receiptUrl` exists; **no**
  `changeOrderId`, `isBillable`, `invoiceId`; expenses are never invoiced.
- `billChangeOrderCore` (billing-core.ts:960): Approved CO → ONE tax-inclusive milestone named
  `{code} — {title}` on the estimate's invoice (else newest project invoice). Idempotency =
  milestone-name prefix match only (no FK). Increments invoice `totalAmount`/`balanceDue` but
  **not** `subtotal`/`taxAmount`. Does not send; `handleChangeOrderApproved`
  (billing-core.ts:1107) auto-bills + auto-sends on signature; on any bill/send failure its
  notification reports a generic action-needed problem (`sent=false` path).
- `createChangeOrderDraft` (billing-core.ts:1346): requires `items[]` with quantity+unitCost;
  integer-cents math; cost-code warnings. Exposed as MCP `create_change_order`.
- `send_change_order` MCP: two-step confirmToken preview (invalidated by any edit via
  `updatedAt` pinning) — already voice-safe.
- `PaymentSchedule` (schema:546): full QB rail fields (`qbInvoiceId`, `qbInvoiceLink`,
  `qbPaymentId`, `qbSyncedAt`, `qbSyncError`), `sourceScheduleId` pattern exists for estimates.
- `sendMilestoneInvoicesCore` (billing-core.ts:666): per-milestone QB push/status-check, drift
  guard (±$0.05), one branded email with portal link, `Draft → Issued`. QB tax split is
  reconstructed from **`invoice.taxRate`** inside `createQBMilestoneInvoice` — the fallback
  invoice may carry a different rate than the CO's estimate.
- CO PDF: `src/lib/pdf.ts:1013` (pdf-lib). PDF routes under `/api/pdf/**` are staff-auth only.
- MCP auth: shared-secret bearer (not NextAuth) — server actions cannot be called from MCP;
  shared session-free cores are required.
- `upload_file` MCP tool returns a file id/record parked on the job's Files tab; it is not
  automatically associable with an `Expense` today.
- Tests: Playwright only; seeded "Test Project — DO NOT DELETE" fixture; `docs/TESTING.md`
  disposable-DB rule (Docker PG :5433); `data.setup.ts` refuses prod unless `ALLOW_PROD_E2E=1`.
- Production has a real "Shop Test" job used for manual end-to-end tests (not in repo fixtures).

## 3. Design decisions

**D1 — `pricingType` on the CO, default FIXED.** `"FIXED" | "COST_PLUS"`. FIXED keeps every
existing behavior bit-for-bit (editor, PDF, send, approval, bill, portal). COST_PLUS changes
what approval means (scope + markup terms, not a locked total) and defers billing until
actuals exist.

**D2 — Markup stored per CO.** `markupPercent Float?` — set at creation (voice: "cost plus 10"
→ 10), editable while Draft. Fallback when null: 10.

**D3 — Actuals are tagged, not duplicated.** Time and expenses stay in their existing tables;
they gain `changeOrderId`, `isBillable`, `invoiceId`. Billing collects
`WHERE changeOrderId = ? AND isBillable AND invoiceId IS NULL`. The dead "Billable" checkbox in
`NewTimeEntryModal` becomes real (default **off** for time, default **on** for expenses tagged
to a CO).

**D4 — Documented labor cost = `laborCost + COALESCE(burdenCost, 0)`.** Burden is a real labor
cost and belongs in the cost-plus basis. Expenses bill at `Expense.amount`. Sell =
documented cost × (1 + markup). A mobile-created entry carrying both `laborCost` and
`burdenCost` is an explicit test case.

**D5 — Billing runs are first-class (`ChangeOrderBilling`).** Each "Bill actuals" creates one
row: label, labor/expense/markup/tax cents, total cents, the created milestone via a **unique
1:1 relation** to `PaymentSchedule`, and a frozen JSON snapshot of included rows (ids, names,
dates, hours, cost+ burden, receipt URLs). Audit trail, "billed to date", and the backup PDF
all read from this — immune to later edits of source rows.

**D6 — One invoice, many milestones — unchanged target selection, upgraded bookkeeping.**
Cost-plus bills onto the same invoice the fixed flow uses (estimate's invoice, else newest).
Milestone name: `{code} — {title} (T&M through {YYYY-MM-DD})`.
- New nullable `PaymentSchedule.pretaxAmount` + `PaymentSchedule.taxAmount` columns, populated
  by all CO billing paths (lump, split, T&M); QB push uses these when present instead of
  reconstructing tax from `invoice.taxRate`, eliminating ProBuild↔QB divergence when the
  fallback invoice's rate differs. When the picked invoice's `taxRate` disagrees with the CO
  estimate's rate, the CO's rate still wins (persisted per-milestone) — no silent drift.
- The increment path now also updates invoice `subtotal` += pretax and `taxAmount` += tax so
  ProBuild invoice aggregates stay consistent.
- `src/lib/sales-tax-report.ts` (cash-basis, currently allocates invoice-level tax
  proportionally across payments, lines ~156-190): milestones with persisted
  `pretaxAmount`/`taxAmount` are reported from those columns directly; proportional
  allocation is retained only for legacy rows without them.
- Idempotency: `ChangeOrderBilling.paymentScheduleId` unique relation (T&M runs) and
  `PaymentSchedule.sourceCoScheduleId` unique nullable (split rows) replace name-prefix matching
  for new rows; name-prefix kept as legacy fallback for pre-migration data.

**D7 — Approval and billing semantics per type.**
- FIXED, no schedule rows: today's lump behavior, unchanged.
- FIXED, with schedule rows: `billChangeOrderCore` creates one milestone per
  `ChangeOrderPaymentSchedule` row named `{code} — {scheduleName}`, each linked via
  `sourceCoScheduleId`. **Amount contract (pricing-type-discriminated validation):**
  COST_PLUS COs must have **zero** schedule rows (rejected at save/create). FIXED splits
  require **≥ 2 rows, every row amount > 0**, amounts are pre-tax splits of the CO subtotal,
  and the computed final-row remainder (`subtotal − Σ explicit rows`) must itself be **> 0** —
  so no earlier row may push the running sum to or past the subtotal. Integer-cents
  throughout. Each billed milestone is tax-inclusive (its pre-tax share × (1 + CO tax rate));
  per-milestone tax is rounded to cents and the tax rounding remainder is absorbed into the
  last milestone so the tax-inclusive sum equals the signed revised amount. Schedules are
  shown on the send email, portal signature page, and PDF **before** signature. On approval,
  auto-bill + auto-send covers **every** created milestone id.
- COST_PLUS: approval records scope + markup terms only. `approveChangeOrderCore` branches:
  skips the non-empty/positive-items requirement for COST_PLUS. `handleChangeOrderApproved`
  skips billing and completes with a distinct **"approved — awaiting actuals"** outcome and
  notification copy (no generic action-needed false alarm). Billing is explicit later via UI or
  MCP.

**D8 — Voice-first, two-step everywhere money moves — with bound previews.** MCP money actions
reuse the confirmToken pattern. For `bill_change_order` on COST_PLUS the token payload is:
`{ changeOrderId, throughDate, invoiceId, markupPercent, taxRate, fingerprint }` where
`fingerprint = sha256(sorted [rowKind:rowId:cents] for every included time entry + expense)`.
Confirm re-queries and re-fingerprints; any drift (newly tagged row, edited amount) rejects the
token with a fresh preview. `throughDate` is frozen at preview time.

**D9 — Customer-facing honesty for cost-plus.** Send email, portal signature page, and PDF for
a COST_PLUS CO show: scope description, markup %, "billed from actual time & materials at
cost + X% + tax", scope lines as non-binding estimates (no Revised Amount lock).

**D10 — T&M backup delivery is resolved at send time, server-side.**
`sendMilestoneInvoicesCore` accepts no ad-hoc attachment argument; instead, when sending it
looks up `ChangeOrderBilling` by `paymentScheduleId` for each milestone and, when found,
includes a **signed, expiring backup URL** in the email + portal milestone view. The backup PDF
route `/api/pdf/change-orders/[id]/billing/[billingId]` authorizes either staff session **or**
the client-portal token mechanism (`signClientPortalToken` / `/api/portal/verify`, same pattern
as invoice portal links), so customers can open it without a staff login and links expire like
other portal links. **`src/proxy.ts` currently intercepts `/api/pdf/change-orders/**`
(lines ~47-64) before route-level auth: add an exact-path bypass for
`/api/pdf/change-orders/:id/billing/:billingId` and perform BOTH authorizations (staff session
or valid portal token) inside the route handler — no token, no PDF.**

**D11 — Receipts link explicitly.** `log_expense` (MCP) and the expense modal accept an optional
`receiptFileId` (returned by `upload_file`); the core validates the file belongs to the same
project as the CO, resolves its storage URL, and persists it to `Expense.receiptUrl` before
returning. The Shop Test receipt step exercises exactly this path.

**D12 — Session-free cores for time/expense writes.** Create a NEW module
`src/lib/time-expense-core.ts` that is **NOT** a `"use server"` file (the existing
`time-expense-actions.ts` is `"use server"` — exporting unauthenticated write cores from it
would expose them as client-callable server actions). The cores
(`createTimeEntryCore`, `createExpenseCore`, `tagTimeEntriesToChangeOrderCore`,
`tagExpensesToChangeOrderCore`) take plain args + actor string and do all validation.
Authenticated server-action wrappers stay in `time-expense-actions.ts`; MCP tools call the
cores directly. Add `notes String?` to `TimeEntry` so `log_time.note` persists.

## 4. Schema changes (`prisma/schema.prisma` + `migrations/004_cost_plus_change_orders.sql`)

```prisma
model ChangeOrder {
  // ...existing...
  pricingType   String   @default("FIXED") // FIXED | COST_PLUS
  markupPercent Float?                     // cost-plus markup, e.g. 10; editable while Draft
  timeEntries   TimeEntry[]
  expenses      Expense[]
  billings      ChangeOrderBilling[]
}

model TimeEntry {
  // ...existing...
  changeOrderId String?
  changeOrder   ChangeOrder? @relation(fields: [changeOrderId], references: [id], onDelete: SetNull)
  isBillable    Boolean  @default(false)
  invoiceId     String?
  notes         String?
  @@index([changeOrderId])
}

model Expense {
  // ...existing...
  changeOrderId String?
  changeOrder   ChangeOrder? @relation(fields: [changeOrderId], references: [id], onDelete: SetNull)
  isBillable    Boolean  @default(false)
  invoiceId     String?
  invoicedAt    DateTime?
  @@index([changeOrderId])
}

model ChangeOrderPaymentSchedule {
  // ...existing (name, amount, dueDate, order)...
  billedMilestone PaymentSchedule? @relation("CoScheduleBilling")
}

model PaymentSchedule {
  // ...existing...
  pretaxAmount        Decimal?  // set by CO billing paths; QB push prefers these over invoice.taxRate reconstruction
  taxAmount           Decimal?
  sourceChangeOrderId String?   // CO whose billing created this milestone (all CO paths)
  sourceCoScheduleId  String? @unique // ChangeOrderPaymentSchedule row this milestone bills (split path)
  sourceCoSchedule    ChangeOrderPaymentSchedule? @relation("CoScheduleBilling", fields: [sourceCoScheduleId], references: [id], onDelete: SetNull)
  coBilling           ChangeOrderBilling?
  @@index([sourceChangeOrderId])
}

model ChangeOrderBilling {
  id                String   @id @default(cuid())
  changeOrderId     String
  changeOrder       ChangeOrder @relation(fields: [changeOrderId], references: [id], onDelete: Cascade)
  paymentScheduleId String?  @unique
  paymentSchedule   PaymentSchedule? @relation(fields: [paymentScheduleId], references: [id], onDelete: SetNull)
  label             String    // "T&M through 2026-07-31"
  laborCents        Int
  expenseCents      Int
  markupCents       Int
  taxCents          Int
  totalCents        Int       // tax-inclusive milestone amount
  snapshot          Json      // frozen line detail for audit + backup PDF
  createdAt         DateTime @default(now())
  createdBy         String?
  @@index([changeOrderId])
}
```

- SQL migration adds real constraints matching the Prisma relations exactly (so
  `prisma db push` test databases and migrated production stay structurally identical):
  `UNIQUE` on `ChangeOrderBilling.paymentScheduleId` and `PaymentSchedule.sourceCoScheduleId`,
  FKs with `ON DELETE SET NULL` (billing history survives milestone cancellation).
- All other columns additive/nullable or defaulted → zero-downtime; legacy rows behave exactly
  as today.
- Follow repo convention: Prisma schema edit + hand-written SQL in `migrations/`.

## 5. Core logic

**`src/lib/billing-core.ts` / `src/lib/change-order-core.ts`**
- `createChangeOrderDraft`: accept `pricingType`, `markupPercent`, `paymentSchedules[]`
  (name/amount/dueDate/order, pre-tax split semantics per D7, sum validated cent-exact against
  items subtotal); COST_PLUS allows `items: []` and $0 scope lines.
- `updateChangeOrderCore`: `pricingType`/`markupPercent`/`paymentSchedules` editable while
  Draft only; any terms change on a Sent CO keeps the flip-to-Draft behavior. Schedule-row
  rounding remainder absorbed into the final row at save (D7).
- `approveChangeOrderCore`: branch validation by `pricingType` — COST_PLUS skips
  empty/non-positive-items rejection (explicitly tested: empty items AND $0 lines).
- `sendChangeOrderToClientCore`: COST_PLUS skips the "items must total > 0" pricing sync check;
  email + portal copy switches to cost-plus terms (D9); schedule table included when rows exist.
- `handleChangeOrderApproved`: COST_PLUS → no billing; distinct "approved — awaiting actuals"
  outcome + notification copy (D7). FIXED+schedules → bill + send every created milestone id.
- `billChangeOrderCore`: FIXED+schedules → per-row milestones with `sourceCoScheduleId` links
  (re-run skips already-linked rows → natural idempotency); COST_PLUS → error pointing at
  `bill_cost_plus_change_order`. Invoice-picking logic extracted into a shared helper.
- **New `billCostPlusChangeOrderCore(changeOrderId, { throughDate, actor })`**: one tx, CO row
  lock `FOR UPDATE`; collect billable unbilled rows — time entries filtered on
  **`TimeEntry.startTime`** (the actual schema field) ≤ throughDate; expenses filtered on
  **`COALESCE(Expense.date, Expense.createdAt)`** ≤ throughDate so undated expenses are never
  silently excluded; throughDate is interpreted as **end-of-day in the company timezone**
  (explicit boundary, not server-local midnight). Empty → "nothing to bill". Labor cents =
  Σ(laborCost + burdenCost), expense cents = Σ amount, markup, then tax on marked-up subtotal
  via `coTaxRate(co.estimate)`; create milestone with `pretaxAmount`/`taxAmount` set +
  `sourceChangeOrderId`; create `ChangeOrderBilling` with snapshot; stamp `invoiceId` +
  `invoicedAt` on **both** included time entries and expenses; increment invoice `totalAmount`,
  `balanceDue`, `subtotal`, `taxAmount` via `lockMoneyParents`.
- **`sendMilestoneInvoicesCore`**: resolves `ChangeOrderBilling` by milestone id → appends
  signed expiring T&M backup URL (D10) to email + portal payload. QB push prefers milestone
  `pretaxAmount`/`taxAmount` when present (D6).
- Same increment/aggregate fixes applied to the existing lump path so all three paths update
  `subtotal`/`taxAmount` identically.

**`src/lib/time-expense-core.ts` (new, non-"use server") + `time-expense-actions.ts` wrappers (D12)**
- Cores accept + persist `changeOrderId` (validate CO ↔ project match; expense inherits CO's
  `estimateId`), `isBillable`, `notes`, `receiptFileId` (D11). Fix the silent-drop bug.

## 6. MCP surface (`src/app/api/mcp/[transport]/route.ts`, bump to v1.9.0)

- `create_change_order`: + `pricingType`, `markupPercent`, `paymentSchedules[]`; items optional
  for COST_PLUS. Description teaches the voice mapping ("cost plus 10" → `markupPercent: 10`;
  "two payments, half up front" → schedule rows).
- `send_change_order`: preview gains `pricingType`, `markupPercent`, schedule rows, and for
  COST_PLUS replaces `revisedAmountCustomerSigns` with `terms: "cost + 10% + tax, billed from
  actuals"`.
- `list_change_orders` **(new, read-only)**: per project — code, title, status, pricingType,
  totals, signature state, actuals-to-date (billable unbilled $, hours), billed-to-date.
- `log_time` **(new)**: projectId **or** changeOrderId, crew member name (explicit, or resolves
  uniquely against the project crew; ambiguous/missing → error listing crew), date, hours,
  note → `createTimeEntryCore` (`isBillable: true` when tagged to a COST_PLUS CO).
- `log_expense` **(new)**: changeOrderId (or estimateId), amount, vendor, date, description,
  optional `receiptFileId` (D11); `isBillable: true` when tagged to a COST_PLUS CO.
- `bill_change_order`: COST_PLUS → D8-bound two-step (freeze throughDate, fingerprint rows;
  drift rejects) → `billCostPlusChangeOrderCore`; returns milestoneId + backup-URL note. FIXED
  behavior unchanged (now including split rows).
- All new write tools validate ids and return ProBuild URLs for human follow-up.

## 7. UI / PDF

- **ChangeOrderEditor**: pricing-type selector + markup input (Draft only); milestone-schedule
  editor (add/remove rows, name/amount/dueDate, live "sums to subtotal" validation with
  last-row remainder note); COST_PLUS mode: items table labeled "Scope estimate (not a fixed
  price)", **Actuals** section (tagged time/expenses, hours, $, billed/unbilled), "Bill
  actuals…" button (preview modal → confirm), billing history list. Scope-lock rules extend to
  pricingType/markup/schedules.
- **Time & Expenses tabs**: CO picker (project's Sent/Approved COST_PLUS COs), working Billable
  checkbox, CO tag + billed-state badge, bulk "Tag to change order", receipt attach via
  `receiptFileId`.
- **CO PDF** (`pdf.ts`): COST_PLUS variant (terms block, scope lines marked "estimate", no
  Revised Amount lock); FIXED PDF renders schedule table when rows exist.
- **T&M backup PDF**: `/api/pdf/change-orders/[id]/billing/[billingId]` — staff session or
  signed portal token (D10); itemized time (name/date/hours/cost+burden) + expenses
  (date/vendor/$, receipt links), subtotal, markup, tax, total.
- **Portal**: CO signature page cost-plus copy + schedule table; milestone view "View itemized
  backup" link when a billing exists.

## 8. QuickBooks side (explicit checklist)

- All CO milestone kinds reuse `pushMilestoneToQuickBooks`; per-milestone `pretaxAmount`/
  `taxAmount` (when set) drive `TxnTaxDetail` instead of reconstructing from `invoice.taxRate`
  (D6) — ProBuild and QBO totals match to the cent even when the fallback invoice's rate
  differs from the CO estimate's.
- DocNumber `{invoice.code}-{position}` ≤ 21 chars — assert with split rows adding positions.
- Drift guard (±$0.05) applies; billing-run cents math equals milestone `amount` exactly.
- `syncQuickBooksPayments` / `markMilestonePaidFromQB` unchanged; confirm paid T&M + split
  milestones reconcile on Shop Test.
- QB disconnected: billing run still creates the milestone; send surfaces the existing
  "QuickBooks is not connected" error — documented, not silently skipped.

## 9. Testing

**Automated (Playwright, disposable Docker PG :5433 per docs/TESTING.md):**
- Regression: FIXED lump CO lifecycle unchanged.
- New `e2e/cost-plus-change-order.spec.ts`: draft COST_PLUS → send → portal sign (incl.
  **empty-items approval** and **$0-scope-line approval** cases) → mobile-shaped time entry
  (`laborCost` + `burdenCost` both set) + expense tagged to CO → bill → milestone +
  `ChangeOrderBilling` snapshot + stamped rows + invoice `subtotal`/`taxAmount` aggregates →
  second bill run → "nothing to bill" → backup PDF 200s via staff AND via signed portal token.
- Token-drift test: tag a new expense between preview and confirm → confirm rejected.
- Split: FIXED CO with 2 schedules → two milestones, cent-exact sums (pre-tax and
  tax-inclusive), `sourceCoScheduleId` links, both auto-sent on approval.
- MCP tool-shape tests where the harness allows.
- `npm run typecheck` + `npm run lint` clean.

**Manual — Shop Test change orders (production, full loop):**
1. Voice-style via MCP: cost-plus-10 CO on Shop Test → draft → preview read-back → confirm
   send → sign as the Shop Test customer (test mailbox) → verify "awaiting actuals"
   notification copy.
2. `log_time` × 2 + `log_expense` × 1 with `receiptFileId` from `upload_file` (D11).
3. `bill_change_order` → hand-check preview math (labor+burden, expenses, 10% markup, 8.8% tax)
   → confirm → `send_milestone_invoice` → verify **QBO invoice totals match ProBuild to the
   cent**, live pay link, email + portal T&M backup link opens without staff login.
4. FIXED + 2-milestone split CO on Shop Test → schedule shown before signature → sign → both
   milestones billed and sent → QBO reconcile.
5. Cleanup: void test QBO invoices / cancel test milestones per repo testing etiquette; leave
   Shop Test tidy.

## 10. Rollout & safety

- Additive migration; deploy order: migration → app. No backfill (legacy COs = FIXED).
- All behavior changes gated on `pricingType` or presence of schedule rows / new columns;
  in-flight FIXED COs untouched.
- Gates: this plan → Codex TRIP-1 review (gpt-5.6-sol, xhigh) → implement →
  `codex-code-review` TRIP-2 gate (same model/effort) on the uncommitted diff → then commit.

## 11. Out of scope (v1)

- Mobile-app CO picker (voice/MCP covers the field; native UI later).
- Per-line `baseCost`/`markupPercent` editing on CO items.
- Stripe rail for CO milestones (QB is the operating rail).
- NTE (not-to-exceed) caps — likely v1.1.

## 12. Resolved decisions (was open questions)

1. **Tax base:** markup-then-tax (tax on the marked-up subtotal) — GTR's existing lump path
   already taxes the full subtotal; cost-plus follows suit.
2. **`log_time` crew resolution:** explicit name, or auto-resolve only when the project crew
   yields exactly one match; otherwise error listing crew (voice-friendly).
3. **Snapshot:** JSON freeze on `ChangeOrderBilling` (audit-true) + relational links for
   idempotency — both, per D5/D6.
