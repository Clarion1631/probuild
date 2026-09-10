# Receipt Purchase duplicate guard

## Incident and producer

The `[gtr-file:<driveId>]` memo and the Drive-derived DocNumber are written by
`src/lib/qbo-receipt-push.ts`. Both the legacy Apps Script API route and
`src/lib/receipt-intake/book.ts` call that writer. The Python `gtr-books`
`receipt_pipeline_watch.py` is an observer, not the Purchase producer.

The `receipt-bot-v33-hardening` memory describes a vendor + exact date + amount
NoInv key. `receipt-pipeline-v2-plan` describes migrating the Apps Script brain
to ProBuild. The v2 key code explicitly ports the old rules. A second Drive
capture therefore escapes file-id idempotency; vendor/date drift can also
escape content deduplication. Migration completion alone would not fix this.
This investigation did not establish the live cutover state or attribute each
historical Purchase to a particular caller.

## Agreed scope and implementation

1. Keep same-file idempotency first. Before any new Purchase or vendor/customer
   creation, read Purchases regardless of vendor, compare integer cents, and
   hold matches within seven days or on the same month/day in the current and
   preceding two calendar years. A wrong-year input also checks current years.
2. Use supported QBO TxnDate range queries with complete pagination and compare
   TotalAmt locally. The Intuit SDK marks TotalAmt filterability as QBW, not
   QBO; do not risk making the guard depend on an unsupported QBO amount filter.
   Invalid rows, incomplete response metadata, repeated pages, page limits, and
   query failures abort creation. A refused read cannot trigger email fallback.
3. Serialize same-amount work per QBO realm across both callers, in addition to
   the existing per-file lease. This protects simultaneous different captures
   through the check/create boundary among cooperating ProBuild workers.
   Persist an AutomationSetting create intent before the request as well. A lost
   response or killed worker leaves that intent intact after its lease expires;
   other captures matching amount/date are held with the unresolved source ID.
   Same-file retries keep their original QBO request ID. A first attempt that
   definitively never created a Purchase can clear its intent; a retry's refusal
   or failed ownership fence cannot clear evidence of an earlier unknown outcome.
   Acknowledged creates retain their QBO ID in the intent until the duplicate
   candidate query actually observes that ID. DocNumber visibility alone does
   not prove that the date query is current. Unknown outcomes remain protected.
   Changed amount/date on the original source requires review. No TTL guesses
   away an unknown create, and unrelated dates do not overwrite its evidence.
4. Persist an AutomationEvent review hold with candidate IDs before attempting
   an attachment. Attach only with exactly one candidate and no existing
   Purchase attachment. Unreadable attachment rows/references or an incomplete
   lookup leave the image unconfirmed and do not upload. Multiple candidates
   require human selection. Matching unresolved create intents are checked even
   when candidates are visible; either another source's pending create or this
   source's unresolved create makes automatic attachment unsafe. Review and dry
   run results retain both candidate QBO IDs and pending source IDs. The guard
   saves complete compact ID lists in linked audit chunks, each below the audit
   serializer's size limit; every chunk must persist before returning the hold.
   No existing
   Purchase fields, accounting lines, dates, or vendors are changed.
5. Return HTTP 409 to legacy callers so their 200/ok:false email fallback cannot
   double-book the held receipt. The Apps Script companion persists qboDuplicate,
   alerts with IDs, moves to `_Needs Review`, and never marks it emailed or archives
   it as sent. A terminal decline after a prior API attempt also parks: it cannot
   prove that the earlier request did not create a Purchase. First-attempt definite
   refusals retain the existing fallback. Alert failures retry only alert/move.
   V2 returns NEEDS_REVIEW with IDs.
6. Add a read-only health scan: recent 45-day seeds, seven-day neighbors (including
   just outside the seed range), and matching historical month/day partners.
   At least one Purchase must carry a gtr-file marker. The digest lists both IDs,
   dates, vendors, amount, and reason as possible duplicates. A failed or timed-out
   scan reports unavailable, never zero duplicates.

## Dry run and fixture acceptance

The authenticated receipt-create endpoint accepts boolean `dryRun: true`.
The creator performs lookups only: no Purchase/vendor/customer creation, attachment,
review-event write, send marker, or business lease. Token maintenance can still
refresh the existing connection. Dry-run responses use HTTP 409 to prevent old
Apps Script clients treating an ok:false response as permission to email.
`action` is `needs-review`, `would-create`, or `already-exists`; candidates include IDs.
`pendingFileIds` names unresolved creates whose QBO IDs are not yet known.
Invalid nonboolean dryRun is rejected rather than accidentally booking.

Run the hermetic fixture suite (no live QBO or production DB):

```sh
node --import tsx --test tests/qbo-receipt-duplicate-guard.test.ts
```

| Proposed capture | Existing candidates | Expected |
|---|---|---|
| Bigfoot 6729, $575, 2026-09-03 | 6728, same date, other vendor label | Hold |
| Bigfoot 6772, $575, 2026-09-08 | 6761, 2024-09-08 | Hold |
| Les Schwab 6632, $1,974.76, 2026-08-19 | 6608, 2026-08-13 (manual) | Hold |
| BIA 6717, $585, 2026-08-19 | 6718, same date, other vendor label | Hold |

Les Schwab 6555 (July 30) versus 6632 (August 19) is 20 days apart and is
outside this requested rule. The August 13 manual entry supplies the six-day
bridge. Tests explicitly retain that limit; the heuristic does not prove two
Purchases are the same receipt. Repeated legitimate amounts also need review.

## Rollout after PR review

- Do not merge or deploy as part of this investigation. Existing transactions
  stay untouched; Vanessa handles the supplied duplicate CSV.
- Once approved for release, deploy the ProBuild change, then update the four
  tracked Apps Script files in the active receipt bot: `sendToQBOviaAPI.gs`,
  `runReceiptAutomation.gs`, `requeueParkedReceipts.gs`, and `selfHeal.gs`.
  The requeue helpers reset the per-park beacon attempt marker so a new park is
  observable after recovery. Deploying ProBuild alone
  blocks new duplicate holds with HTTP 409, which the old API client retries.
  The companion update is also required to protect committed API retries from
  early terminal declines (paused/disabled/validation) before the writer runs.
- The guard covers the shared Purchase writer. Independently emailed receipts,
  manual QBO entries, and external writers do not participate in its amount lease.
- No schema migration. Do not run a live fixture through the non-dry-run endpoint:
  its intentional attachment behavior would modify an existing QBO attachment.
- If a create outcome is unknown, retry the ORIGINAL file to reconcile its
  deterministic QBO request. Other captures remain in review. If that original
  is unavailable, a bookkeeper must establish its QBO outcome before an operator
  clears its `qbo-receipt-push.intent:` setting; elapsed time is not proof of failure.
  A setting with `qbPurchaseId` records a known create whose date-query visibility
  has not yet been confirmed. A later matching duplicate scan clears it after
  observing that ID. There is no TTL or added post-create query; acknowledged
  settings for dates/amounts never scanned again can remain until reviewed.
  Pending alerts identify the source files; support can recover any known QBO
  ID from that source's `qbPurchaseId` in the durable intent. These alerts cover
  both an unknown create outcome and a known create awaiting query visibility.
- Verification: focused producer/intake/legacy/health suites, TypeScript, production
  build, the required independent codex-peer-review, and repository CI (including
  money-pipeline browser tests against disposable Postgres with QBO mocked).

## Initial implementation verification (520c7cb0)

- All four fixture dry runs held the receipt with zero write-side effects.
- 485 focused tests passed. The final identity-query refusal correction also
  passed the 152-test producer suite.
- Full unit run: 4,484 passed, 127 disposable-database tests skipped, and two
  existing Windows CRLF source-text failures. The unchanged HEAD versions of
  `apply-phase2-receipt-queue` and `receipt-intake-reject` reproduce the same
  failures with CRLF and satisfy the assertions with LF, as used in Linux CI.
- `npm run build` (including TypeScript) passed after the final source change,
  using test-only environment values and an unreachable dummy database.
- Independent `codex-peer-review` completed in blind-debate mode. All initial
  and follow-up findings were accepted and fixed; no critical, important, or
  contested findings remain. Final independent closure passed 16 mock-only
  checks, and the reviewer reran 28 guard/Apps Script tests successfully.
- No live QBO transaction or attachment was created, edited, or deleted.

## Review corrections

The GitHub review found that visible QBO candidates suppressed the unresolved
create-intent lookup. The guard now combines both sources of evidence and holds
without attaching whenever a matching create is unresolved. Legacy responses,
Apps Script parking, and v2 review reasons retain both kinds of identifier.

Independent review also reproduced an audit-size boundary: rich candidate data
could exceed the generic serializer's 4,000-character budget. The guard now saves
complete compact identifier lists in linked chunks of at most 3,500 characters,
with a review ID, chunk index/count, and total candidate/pending counts. Every
chunk must persist before a hold returns or an attachment is attempted. A failed
chunk aborts safely; v2 retains its complete queue reason whenever it fits.

- 457 focused producer, intake, legacy, health, and digest tests passed with no
  skips. Regressions include the actual audit serializer and a later-chunk write
  failure; all external services are mocked.
- Standalone TypeScript checking passed.
- Production build passed after the final source change, using only test values
  and an unreachable dummy database.
- Independent CLI closure completed successfully, including 188 isolated tests
  and audit-boundary checks. No critical, important, or contested findings remain.

## Fable review follow-up

Acknowledged creates now retain their durable intent until the duplicate date
query observes the acknowledged QBO ID. Same-source identity recovery records
the known-Purchase hook and ownership fence before any fallible intent storage.
Receipt totals exclude linked guard audit chunks. Parked receipts attempt their
beacon after the durable park, and both requeue helpers reset that attempt marker
for the next park. Alerts distinguish unresolved outcomes from query visibility.

- 468 focused tests passed, with zero failures or skips. Regressions cover lagging
  date queries despite visible DocNumber results, acknowledgment storage failure,
  actual-store compare-and-set behavior, hook ordering, count aggregation, and
  both real Apps Script requeue helpers.
- Production build passed after the final TypeScript behavior change. Final
  typechecking and the eight Apps Script tests passed after the companion changes.
- Fable review and final supplements used verified `claude-fable-5-1` and returned
  clear verdicts. These were static reviews with tools disabled.
- Targeted `codex-peer-review` completed two blind-debate rounds; both accepted
  findings were fixed and independently verified, with no new or contested issues.
- No live QBO/DB operations, merge, or deployment were performed for this follow-up.
