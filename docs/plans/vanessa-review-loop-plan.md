# Plan: Vanessa review loop + end-to-end audit trail in /automation

Date: 2026-08-11. Owner: Justin. Model chosen: **Option A — book instantly, review after.**
The bot keeps booking receipts via the QBO API (project assigned, receipt attached).
Vanessa reviews posted records, not staged ones. Margaret no longer uploads receipts.

## Goals (numbered, verifiable)

### Goal 1 — Daily "posted yesterday" digest email to Vanessa
**REMOVED 2026-08-12 by owner decision — no email; review happens in the command center.**
Justin decided against an email digest: Vanessa reviews via the `/automation` audit timeline
(Goal 2) and QuickBooks directly instead. Everything below in this section (DigestRun table,
`src/lib/automation-digest.ts`, the `/api/automation/digest` cron route, the hourly `vercel.json`
entry, and the digest tests) was implemented, Codex-reviewed, and then deleted wholesale from
`feat/vanessa-review-loop` in a mechanical removal commit — the removal itself was not
re-reviewed by Codex (see `docs/code-review/CR_vanessa-review-loop.md`). Kept below only as a
record of what was built and why it was cut; none of it exists on the branch anymore.
- **Trigger:** hourly Vercel cron (`vercel.json`) hitting `src/app/api/automation/digest/route.ts`.
  The route computes the current date in `America/Los_Angeles` and claims that Pacific date
  via a `DigestRun` row (unique on `digestDate`) with `status` `PROCESSING → SENT/FAILED`,
  `attempts`, and `leaseExpiresAt`. A run marks `SENT` only after Resend accepts delivery;
  on any failure (QBO lookup, render, send) it records `FAILED` and the lease expires so a
  later hourly tick retries the same date (max 5 attempts; on the 5th failure it stays
  FAILED and sends a terminal-failure alert email to `DIGEST_CC_EMAIL` via the same Resend
  client, idempotency key `gtr-digest-alert-<digestDate>`; asserted in the unit tests).
  Claims are fenced: each claim writes a fresh `claimToken` via compare-and-swap, and a
  worker may only write `SENT`/`FAILED` where
  `{digestDate, status: PROCESSING, claimToken: <its own>}` still matches — an expired
  worker whose lease was taken over cannot overwrite the new worker's result.
  The Resend call uses deterministic idempotency key `gtr-digest-<digestDate>` so a retry
  after an ambiguous success cannot double-send. Send window: first hour at or after 06:00
  Pacific. This survives DST without dual crons.
- **Digest window:** the previous full Pacific calendar day (00:00:00–23:59:59.999
  America/Los_Angeles), converted to UTC for querying.
- **Source of truth:** query QBO directly for Purchases with `MetaData.CreateTime` in the
  window, filter to automation-created ones by the `[gtr-file:...]` marker in `PrivateNote`,
  and de-duplicate by Purchase ID. Local `automation_events` / synced expense rows are used
  only to enrich (Drive links, project names) — never as the primary list, because audit
  inserts are non-fatal (`src/lib/automation-events.ts`) and the expense sync lags up to 4 h.
- **Email:** Resend (`RESEND_API_KEY`). Recipients from required env vars `VANESSA_EMAIL`
  (to) and `DIGEST_CC_EMAIL` (cc). Both provisioned in Vercel prod before deploy; route
  validates at startup and returns 500 with a clear message when missing or when Resend
  reports failure — never a silent 200. Empty day sends the "Nothing posted yesterday"
  one-liner.
- **Row format:** date · vendor · amount · project · QBO deep link
  (`https://qbo.intuit.com/app/expense?txnId=<id>`) · Drive receipt link when known.
- Verify: unit tests for the Pacific-window math (including DST transition dates) and the
  claim logic; manual trigger sends a real email whose links open the right records.

### Goal 2 — Per-transaction audit timeline in the /automation register
- Each register row expands to a timeline built from existing data, labeled honestly:
  1. Drive intake — file name + link, timestamp (from `automation_events` when present;
     "not captured" when absent, never fabricated)
  2. Bot read — vendor/amount/project extracted, sourced from the matched
     `receipt-stage/read` row in `automation_events` (the classification table holds only
     classification/reason/SyncToken); "not captured" fallback when the event is absent
  3. QBO Purchase — id + deep link always; create time from a new nullable
     `qboCreateTime` column on the classification row, backfilled by a batched QBO fetch
     in `scripts/backfill-qbo-create-time.mjs` and written going forward by the sync;
     "not captured" when null
  4. **Reviewed** — from the new `PurchaseReview` record (Goal 2b)
  There is **no bank-feed matched/pending step**: the current GL-based source cannot observe
  pending or unmatched bank-feed state (`src/lib/qbo-bank-register.ts`). Bank-feed ingestion
  is explicitly out of scope; the guide (Goal 3) tells Vanessa to check the bank feed in QBO.
- **Goal 2b — real review stamps:** new append-only table `PurchaseReview`
  (`id, qboPurchaseId, qboSyncToken, reviewerId, reviewerName, reviewedAt`) via additive
  `scripts/apply-purchase-reviews.mjs`. **Writer:** a named server action
  `markPurchaseReviewed(qboPurchaseId, expectedSyncToken)` in `src/lib/actions.ts`, gated
  on the `financialReports` permission; reviewer identity derived server-side from the
  session (never from the client payload). `expectedSyncToken` is the SyncToken of the
  version Vanessa actually saw rendered. The action fetches the purchase's **current**
  SyncToken from QBO server-side and **rejects with a "record changed, please re-review"
  error when it differs from `expectedSyncToken`** — a review can never certify a version
  the reviewer did not see. On match it inserts atomically with a unique constraint on
  `(qboPurchaseId, qboSyncToken)` — a concurrent duplicate insert is a no-op. If QBO later
  changes the purchase (rendered SyncToken differs from the stamped one), the row shows
  "changed after review" and can be re-reviewed (new row, new SyncToken). Rows are never
  deleted or overwritten. This is separate from the existing ReviewIssue acknowledgements,
  which only cover flagged problems.
- Verify: unit test for stale-review detection (SyncToken mismatch); UI shows the timeline
  for one of today's bookings (Berg ADU $2,452.32) with working links.

### Goal 3 — "Validate it in QuickBooks" section in the ops guide
- Extend `docs/qbo-expense-sync-flow.html` → regenerate `src/app/automation/guide/guide-html.ts`
  (JSON.stringify one-liner) with an end-to-end validation checklist and deep links:
  1. Drive intake folders flowing (link)
  2. QBO Receipts "For review" queue near-zero (link)
  3. QBO Expenses list filtered by day (link)
  4. QBO bank feed: no unmatched items (link) — manual check, by design
  5. /automation register: proof dots green, rows carry review stamps
- Verify: renders in prod at /automation → How this pipeline works → anchor `#validate-qbo`.

## Implementation file map
- `vercel.json` — hourly cron entry
- `src/app/api/automation/digest/route.ts` — digest endpoint (auth: cron secret header)
- `prisma/schema.prisma` — add `DigestRun` (unique `digestDate`, `status`, `attempts`,
  `leaseExpiresAt`, `claimToken`) and `PurchaseReview` (unique compound `(qboPurchaseId, qboSyncToken)`,
  index on `qboPurchaseId`, no FK to synced expense rows — they can be re-imported); add
  nullable `qboCreateTime` to the classification model. Regenerate the client via
  PowerShell `node_modules\.bin\prisma generate` (never Git Bash) after applying SQL.
- `scripts/apply-digest-runs.mjs` — additive `DigestRun` table
- `scripts/apply-purchase-reviews.mjs` — additive `PurchaseReview` table + `qboCreateTime`
- `scripts/backfill-qbo-create-time.mjs` — batched QBO CreateTime backfill
- `src/lib/automation-digest.ts` — window math + QBO query + render (unit-tested)
- `src/lib/actions.ts` — `markPurchaseReviewed` server action (permission-gated)
- register components under `src/app/automation/` — timeline expander + review action
- `src/app/automation/guide/guide-html.ts` — regenerated
- tests: `src/lib/__tests__/automation-digest.test.ts` (Pacific/DST windows, dedupe, claim
  lease/retry, delivery-failure marks FAILED not SENT),
  `src/lib/__tests__/purchase-review.test.ts` (stale SyncToken, concurrent duplicate insert
  no-op, unauthorized caller rejected), digest route auth test

## Constraints
- Local checkout may NOT be on main — branch from origin/main, never deploy a dirty tree.
- Schema-first deploy rule (apply-*.mjs before vercel --prod), --archive=tgz, --force if
  generated files are stale. Money-path rules in CLAUDE.md apply.
- No new writers for lifecycle events — reuse notify/event pathways.
- Codex code review after implementation; keep e2e/money-pipeline.spec.ts green.

## Out of scope (parked)
- Bank-feed pending/matched ingestion (needs a new authoritative source; revisit later).
- Billable/sales-tax-reimbursable flags on bot bookings — waiting on Justin's answer on
  whether client billing lives in ProBuild or QBO.
- Month-close workspace (separate feature, next).
- The remaining ~40 judgment receipts in the QBO queue (worklist delivered to Vanessa).
