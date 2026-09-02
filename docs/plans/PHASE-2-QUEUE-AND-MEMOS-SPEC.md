# Phase 2: Receipts tab + missing-receipt requests + Chat cards + auto-close

Date: 2026-09-01. Parent plan: `docs/plans/RECEIPT-PIPELINE-V2-PLAN.md` (Phase 2 row).
Builds against the Phase 1 spec's `ReceiptIntake` schema (`docs/plans/PHASE-1-INTAKE-CORE-SPEC.md`
§2-3 — Phase 1 is in flight on another branch; import from it, never fork its shapes).
Planner output for the executor: build exactly this; do not guess.

## Verified code facts (cite these, don't re-derive)

- `/automation` is ONE server-component page (`src/app/automation/page.tsx`), gated by
  `getCurrentUserWithPermissions()` + `hasPermission(user,"financialReports")` (:149-151).
  Filters are URL searchParams rendered as `FilterChip` anchors (:64-85, :596-608); data
  loaders live in sibling modules (`register-data.ts`), pure filter predicates in their own
  testable module (`register-filters.ts`). QBO purchase deep-link precedent:
  `https://qbo.intuit.com/app/expense?txnId=<id>` (:688).
- There is NO shared `TabButton`/`EmptyState` export anywhere in `src/` despite
  DESIGN_SYSTEM.md naming them — the page's own `FilterChip` + `StatCard`
  (`automation/components/shared/stat-card`) are the real conventions. Use those.
- `ReviewIssue` (`prisma/schema.prisma:2624`): `@@unique([targetType,targetKey])`, `version`
  OCC, `reasonCodes`/`reasonHash`/`acknowledgedCodes` (JSON strings), `displayDetails`
  (never hashed), `clearedAt`, `absentSince`. NO CHECK constraint exists on `targetType` or
  `reasonCodes` (`scripts/apply-review-alerts-schema.mjs` CHECKs only the status columns) —
  a new targetType and reason code need ZERO DDL.
- Reason codes are a CLOSED set: `decodeReasonCodes` (`src/lib/review-alert-reasons.ts:58`)
  runs `parsed.filter(isReasonCode)`, so a code missing from `KNOWN_CODES` decodes to `[]`
  — which the lifecycle reads as "cleared". A new code MUST be added to the `ReasonCode`
  union and `KNOWN_CODES` or every issue carrying it self-destructs on read.
- Lifecycle: `evaluateReviewIssue(targetType, targetKey, codes, displayDetails, opts)`
  (`src/lib/review-alert-lifecycle.ts:231`) — ordered decision tree, OCC-retried; empty
  codes → clear (step 1), new target → create gen 1 (2), cleared+non-empty → reopen gen+1
  (3), acked ⊇ current → suppress (4), same hash → touch (5), changed hash → supersede (6).
  `options.episodeStatus` accepts `"PENDING" | "SUPPRESSED"` (:201).
- Delivery: `drainReviewAlerts` (`src/lib/review-alert-outbox.ts:341`) sends ONE card PER
  EPISODE (per issue), ceiling `EPISODE_RATE_CEILING = 10`/run (:90), and is hard-blocked
  until the `RolloutGate` baseline is complete (:354) and a real `ReviewAlertSender` exists
  (none does — `unconfiguredSender`, :77). Absence/grace: `ABSENCE_GRACE_MS = 6h`,
  coverage-gate floor 5 (`review-alert-evaluator.ts:228,242`) — but `reconcileIssueAbsences`
  filters `targetType === "qbo-purchase"` (:284), so it never touches other target types.
- Bank data: `BankLine` (schema:2743, signed `amountCents`, `postedDate`, `rawDescriptor`,
  immutable amounts), `BankLineObservation` (schema:2792; `source` STATEMENT|QBO_REGISTER,
  QBO rows carry `sourceLineId` = qbTxnId). Canonical `BankLine` rows are minted ONLY from
  STATEMENT observations (schema comment :2686-2699); QBO register rows arrive as
  observations via `POST /api/integrations/bank-ledger/ingest` (route :504-553). No
  bank-register cron exists in `vercel.json` — QBO observations are pushed by the external
  `post-qbo-register.mjs` runner today; the nightly server-side pull is Phase 6.
- Pure receipt libs ALREADY EXIST — reuse, do not duplicate:
  - `src/lib/receipt-policy.ts`: `classifyReceiptRequirement` (loan/fee/insurance/tax/
    owner-transfer exemptions, verbatim from the prod survey), `resolveReceiptOwner` +
    `CARD_OWNERS = {8516:"CJ", 6098:"Richard", 4297:"Justin"}` (:183 — this IS the config
    map; reference it, never re-declare the tails in logic), `classifyPersonToPersonPayment`.
  - `src/lib/receipt-match.ts`: `extractCardRail`, exact-id BankLine→Expense receipt matcher.
    Its house rule ("exact-match joins only, never amount/date/rails heuristics") guards
    BankLine STATE advancement — Phase 2's fuzzy match only opens/closes a human chase
    request and must never advance `BankLine.state` or write links.
  - `src/lib/bank-ledger.ts:27`: `normalizePayee(raw)` (rail markers, card refs, phones,
    dates, 6+-digit refs stripped; "" = no identity, never match on it).
- `Expense` (schema:580): `amount Decimal`, `date DateTime?`, `vendor String?`,
  `receiptUrl`, `qbPurchaseId @unique`. Parse Decimal → cents from the STRING form
  (UNIFIED-REGISTER-PLAN.md §2 cent-exactness rule), never `Number(d)*100`.
- Cron auth: `isCronAuthorized(request)` in `src/lib/cron-auth.ts` (Phase 0, fail-closed,
  constant-time). `/api/cron/*` is excluded from the proxy matcher (Phase 1 spec facts).
  Non-overlap pattern: `pg_try_advisory_xact_lock` short claim tx (Phase 1 spec §5).
- Chat side (verified in the two source files):
  - Space: `spaces/AAQAKhvMYtg` (`qbo-clasp/sweepChatReceipts.js:69`). NOTE:
    UNIFIED-REGISTER-PLAN.md §4 writes `AAQAKhvMYTg` (capital T) — that is a typo; the
    running sweep's constant is authoritative.
  - Bridge files in Drive folder `1WwPPvveXlweQ3LI4J-EhfdD5f7x1zzko` (Claude/Bookeeping/
    reports): `affidavit-threads.json` — Beverly WRITES, sweep READS; shape
    `{threads: {"<thread.name>": {owner, owner_user, message_name, items:[{n, fingerprint,
    date, vendor, cents, amount}]}}}` (sweepChatReceipts.js:95,108-110). And
    `chat-job-answers.json` — sweep/affidavit-app APPEND, Beverly READS; records carry
    `{fingerprint, job, by, by_user, signer_email, at, message, thread, text, purpose,
    signed, pdf_id, pdf_url}`, deduped on (fingerprint, message)
    (beverly-chat-app/chatAffidavitApp.js:601-629).
  - Sign flow: interactive `cardsV2` cards with `cardId: "affidavit-<fingerprint>"` are
    posted by Beverly's bot; clicks are handled by the SEPARATE "Beverly Chat App" Apps
    Script (`chatAffidavitApp.js` — signAffidavit/haveReceipt), which generates
    `MissingReceiptAffidavit_<date>_<vendor>_<amount>_<name>.pdf` into the Drive
    "Missing Receipt Memos" folder (:524-573). (The name "SIGNED-chat.pdf" from earlier
    notes appears in NEITHER file — the convention above is what actually runs.)
    Only the card's owner or Justin (`users/104715603105220955392`) may sign (:211).
  - ProBuild's own Chat app can POST (service-account key env `GOOGLE_CHAT_SA_KEY`,
    UNIFIED-REGISTER-PLAN §4) but has NO interactive endpoint (`/api/chat/events` does not
    exist) — buttons on ProBuild-posted cards cannot work. Interactive signing stays with
    Beverly's app. (BACKGROUND FACT ONLY — Phase 2 does not use that service account; it
    posts through an incoming webhook, `RECEIPTS_CHAT_WEBHOOK`. See §4 "Posting".)

## 1. Goals and acceptance criteria

1. **Receipts tab live on `/automation`** (`?tab=receipts`), grouped queue over
   `ReceiptIntake` + missing-receipt issues, same `financialReports` gate as the register.
   Technical: `npm run build` 0 errors; tab loader unit-tested; e2e: ADMIN sees the tab,
   a FIELD_CREW session is redirected off `/automation` entirely (existing gate).
2. **Missing-receipt matcher** opens exactly one `ReviewIssue` per unmatched bank debit,
   auto-closes on match, reopens on unmatch. Technical: full node:test table (§7) green;
   two consecutive runs over identical input produce zero new issues/episodes.
3. **Per-owner weekday Chat card** listing that owner's open items with the three reply
   options; sign handoff via the Beverly thread contract (§4). Technical: card builder
   unit-tested (grouping, ack suppression, ≤10 cards, deterministic requestId); cron
   returns `{skipped:"disabled"}` until `RECEIPT_REQUEST_CARDS_ENABLED=true`.
4. **No emailed PDFs anywhere** — grep gate: the new modules import no mail helper.
5. **VISUAL (gauntlet-verify consumes these verbatim; deployed preview, ADMIN session):**
   - `/automation?tab=receipts` renders a "Receipts" tab control next to the existing
     register view, with a count badge per group: "Needs job", "Needs review", "Booking",
     "Booked today", "Missing receipts", "Duplicates".
   - With no rows in a selected group, the group shows a centered muted empty message
     ("Nothing here" wording, matching the register's empty-state style), not a blank
     panel and not an error boundary.
   - A row in "Needs job" shows vendor, date, amount, source, and a "Set job" control;
     choosing a project moves the row out of the group without a full-page error.
   - A row in "Booking" shows its stateReason/lastError text and a "Retry now" button.
   - A row in "Booked today" shows an "Open receipt ↗" link and a "QuickBooks ↗" link
     whose href starts with `https://qbo.intuit.com/app/expense?txnId=`.
   - The "Missing receipts" group is sub-grouped by owner (e.g. a "CJ" heading and a
     "Richard" heading), each row showing posted date, payee, amount, and card tail.
   - A "Duplicates" row shows a "duplicate of" reference and a "Not a duplicate" action.

## 2. Receipts tab

- **Routing**: extend `parseFilters` in `page.tsx` with `tab: "register" | "receipts"`
  (default `"register"`); `filterHref` preserves it. Register JSX untouched when
  `tab=register`. The Receipts branch renders `<ReceiptsTab .../>` from
  `src/app/automation/components/receipts/receipts-tab.tsx` (server component).
- **Loader** `src/app/automation/receipts-data.ts` (mirrors `register-data.ts` glue style):
  - `fetchReceiptQueue(filters)` → one object with the six groups. Reuse the Phase 1
    exported list select/serializer from the intake GET route module (Phase 1 spec §3
    says it is exported for exactly this reuse) — never a second field list.
  - Groups (states per Phase 1 §2): Needs job = `NEEDS_JOB`; Needs review =
    `NEEDS_REVIEW` + `NON_RECEIPT`; Booking = `BOOKING` (surface `stateReason`,
    `lastError`, `attempts`, `nextRetryAt`); Booked today = `BOOKED`/`ARCHIVED` with
    `bookedAt` >= today 00:00 America/Los_Angeles (compute the boundary with the
    en-CA / America/Los_Angeles idiom already in page.tsx:207); Duplicates =
    `DUPLICATE` (+ `duplicateOfId`); Missing receipts = open `ReviewIssue` rows
    `{targetType:"bank-line", clearedAt:null}` decoded via `decodeReasonCodes`, grouped by
    `displayDetails.owner`, sorted CJ, Richard, office, Justin.
  - Caps: `take` 100 per group, newest first; count badges from count queries, not from
    capped lists. Whole loader wrapped in the page's degrade-honestly convention (its own
    try/catch + "unavailable" card), never taking the register down.
- **Server-side filters**: searchParams `group` (one of the six, default all),
  `projectId`, `owner`. Pure parser/predicate in
  `src/app/automation/receipts-filters.ts` (unit-testable, mirroring
  `register-filters.ts`'s reason for existing).
- **Row actions** — server actions in `src/lib/actions.ts` (repo default; the
  mark-reviewed API route pattern stays for the register). Every action: session via
  `getCurrentUserWithPermissions()`, `hasPermission(user,"financialReports")`, else throw;
  then a guarded compare-and-swap on `state` so a racing intake worker can't be
  overwritten (conditional `updateMany({where:{id, state: expectedState}})`; treat count 0
  as a stale-view error surfaced as a toast, never a silent no-op):
  - `setReceiptIntakeJob(id, projectId, costCodeId?)` — allowed from
    `NEEDS_JOB`/`NEEDS_REVIEW`; also `userCanAccessProject`; writes projectId/costCodeId
    and state → `READ` (the worker re-routes/books from there; never jump straight to
    `BOOKING` — routing owns dedup).
  - `markReceiptIntakeDuplicate(id, duplicateOfId)` → state `DUPLICATE`;
    `unmarkReceiptIntakeDuplicate(id)` → back to `READ` (re-runs dedup/route).
  - `voidReceiptIntake(id)` → `VOID`, allowed from any non-BOOKED state (a BOOKED row is
    money history — refuse).
  - `retryReceiptIntake(id)` — from `BOOKING` (or `NEEDS_REVIEW` with a retryable
    stateReason): `nextRetryAt = now`, `lastError = null`; the 5-min worker picks it up.
    This is the "resend/retry" action; it never calls QBO inline.
  - "Open receipt" is a render-time short-lived signed URL from
    `resolveDocUrl(storagePath)` (`src/lib/secure-storage.ts`) — no action needed.
  - "QuickBooks ↗" uses the page.tsx:688 deep-link pattern with `qbPurchaseId`.
  - Missing-receipt rows: "Acknowledge" reuses the existing mark-reviewed contract
    (`{id, version, reasonHash}` → `markReviewed`) — do NOT hand-roll ack writes.
- Buttons that appear on hover MUST carry the `[@media(hover:none)]` visibility classes
  (CLAUDE.md hover rule).

## 3. Missing-receipt matcher — `src/lib/receipt-requests.ts` (pure, no I/O)

- **Reason code**: add `"MISSING_RECEIPT"` to the `ReasonCode` union AND `KNOWN_CODES` in
  `src/lib/review-alert-reasons.ts` (closed-set fact above). `deriveReasonCodes` is
  qbo-purchase-only — do not touch it. New constant
  `RECEIPT_REQUEST_TARGET_TYPE = "bank-line"`; targetKey = `BankLine.id`.
- **Inputs** (plain rows, caller-queried): bank lines `{id, postedDate:"YYYY-MM-DD",
  amountCents, rawDescriptor, checkNumber}`; expenses `{amountCents, date, vendor}`;
  receipt intakes `{totalCents, txnDate, vendor, state}` (live states only — exclude
  DUPLICATE/VOID/NON_RECEIPT); open issues `{targetKey}`; `now`.
- **Candidate rule**: `amountCents < 0` AND `postedDate` at least 3 calendar days before
  `now` AND `classifyReceiptRequirement(line).requirement === "receipt_expected"`
  (receipt-policy exemptions and money-in drop out — and an exempt or credit line with an
  open issue emits a close).
- **Match rule** (suppresses creation AND drives auto-close). A bank line is "satisfied"
  when some Expense or live ReceiptIntake has ALL of:
  1. amount exact: `expenseCents === -line.amountCents` (Expense.amount Decimal parsed
     from its string form to integer cents; ReceiptIntake.totalCents used directly);
  2. date within ±2 calendar days of `postedDate` (null date = no match);
  3. payee agreement: `payeeMatches(normalizePayee(line.rawDescriptor), vendor)` where
     `payeeMatches(a, b)` tokenizes both as
     `s.toUpperCase().replace(/[^A-Z0-9 ]/g," ").split(/\s+/)` filtered to tokens of
     length >= 3 that are not pure digits; match iff the token lists share >= 1 token,
     OR one side's first token is a prefix (>= 4 chars) of the other's first token
     (covers "LOWES #02516" vs "Lowe's Home Improvement", "HOMEDEPOT.COM" vs "Home
     Depot"). Empty normalized payee or null/empty vendor NEVER matches (bank-ledger's
     empty-string-is-not-an-identity rule). Amount+date alone is deliberately
     insufficient — the Chevron/Cash App lesson (schema:2698); this fuzzy match only
     opens/closes a chase request, never links records or advances `BankLine.state`.
- **Owner**: `resolveReceiptOwner(rawDescriptor)` (receipt-policy.ts:189). The tail→name
  map stays that module's single exported `CARD_OWNERS` const — the matcher takes the
  resolved owner as data and contains no tail literals.
- **Output**: `{ open: [{targetKey, displayDetails}], close: [targetKey] }` where
  `displayDetails = {owner, cardTail, postedDate, amountCents, payee, rawDescriptor,
  fingerprint: "pb-" + bankLineId}` (display-only; amounts/dates here never churn the
  reason hash since the code set is always exactly `["MISSING_RECEIPT"]`).
- **Persistence (cron, §5)**: each `open` → `evaluateReviewIssue("bank-line", key,
  ["MISSING_RECEIPT"], details, { episodeStatus: "SUPPRESSED" })`; each `close` → same
  call with `[]`. Idempotency and never-duplicate-an-open-issue come from
  `@@unique([targetType,targetKey])` + lifecycle steps 5/1; reopen-after-expense-deleted
  is lifecycle step 3 (gen+1). `episodeStatus:"SUPPRESSED"` keeps these issues OUT of the
  future per-issue card drain (one card per bank line is exactly what we don't want, and
  the qbo-purchase RolloutGate must not acquire a second meaning); delivery is §4's
  per-owner digest instead.

## 4. Chat cards + Beverly sign handoff

- **Cadence**: one card per owner (CJ, Richard only — `office` and `Justin` items are
  page-only per receipt-policy.ts:170-175) per weekday morning, listing their open,
  UNACKNOWLEDGED `bank-line` issues numbered 1..n. Reply options in the card text:
  "reply here with a photo", "reply 'N <job name>'", "reply 'sign N' to sign a memo
  instead". Never email a PDF.
- **Reused batching/grace rules**: at most `EPISODE_RATE_CEILING` (10) cards per run
  (owners are 2 — assert anyway); acknowledged issues suppressed (lifecycle step 4
  semantics, computed exactly as `reviewIssueByPurchaseId` does — register-data.ts:224);
  the 3-day matcher age is the grace window; a cleared issue never appears (loader filters
  `clearedAt:null`). Deliberate divergence, called out: cards do NOT ride
  `drainReviewAlerts` — that drainer is one-card-per-issue and blocked by the qbo-purchase
  RolloutGate; the digest posts directly with Chat's own idempotency:
  requestId/messageId = `receipt-req-<owner>-<YYYY-MM-DD Pacific>` (a repeated id returns
  the existing message), so a retried cron can never double-post.
- **Posting** (AS BUILT — this supersedes the service-account plan above it): new
  `src/lib/receipt-request-cards.ts` — pure exported builder + a poster using a Google
  Chat **incoming webhook** on the Receipts Need Review space `spaces/AAQAKhvMYtg` (the
  sweep's constant, NOT the plan doc's `...YTg` typo), read from env
  `RECEIPTS_CHAT_WEBHOOK`. Unset ⇒ the cron returns `{skipped:"no-webhook"}` and fails
  soft; the queue page still shows every item. The URL is held to `chat-webhook.ts`'s
  SSRF allowlist (https, `chat.googleapis.com`, `/v1/spaces/…`). `GOOGLE_CHAT_SA_KEY` /
  `GOOGLE_CHAT_REVIEW_SPACE` are NOT used — the webhook choice is final, and a service
  account would add a credential for a capability nothing here needs (ProBuild cards
  carry no working buttons either way; see the sign step below).
  Each owner's card starts a NEW thread (threadKey `receipt-req-<owner>-<date>`);
  capture the returned `message.name` + `thread.name` and store
  `{threadName, messageName, n, date}` on each listed issue's `displayDetails`.
- **Replay-guard consequence of the webhook.** An incoming webhook offers no
  message-level idempotency — there is no `requestId`/`messageId` to hand it, so a
  retried cron CANNOT be made safe by Chat. `threadKey` only guarantees a retry lands in
  the same thread, never that it doesn't post twice into it. The guard that actually
  holds is therefore ours and lives in the database: every listed item records
  `displayDetails.card.date`, and `buildOwnerCards` skips an owner whose items were ALL
  already listed on today's Pacific date. Do not treat the deterministic requestId as
  the idempotency mechanism; it is a thread key that happens to be stable.
- **Bridge contract (what keeps ProBuild and the sweep/Beverly in sync)** — the sweep only
  understands threads present in `affidavit-threads.json`, and ProBuild has no Drive
  writer, so a qbo-clasp mirror closes the gap (same pattern as Phase 1 §6):
  1. ProBuild exposes `GET /api/automation/receipt-requests/threads` (auth:
     `x-receipt-intake-secret`, Phase 1's machine secret; proxy public-bypass exact-match
     like `api/office-tasks/ingest`) returning EXACTLY the threads-map shape from
     sweepChatReceipts.js:108-110: `{threads: {"<thread.name>": {owner, owner_user,
     message_name, items: [{n, fingerprint, date, vendor, cents, amount}]}}}` for cards
     posted in the last 14 days. `fingerprint = "pb-" + bankLineId` (stable across
     generations; safe inside `cardId` and PDF filenames). `owner_user` = the owner's
     Chat `users/<id>` from a new env-backed map `RECEIPT_OWNER_CHAT_USERS` (JSON, e.g.
     `{"CJ":"users/...","Richard":"users/..."}`) — config, not code. ASSUMPTION: CJ's and
     Richard's user ids must be collected once (Justin's is users/104715603105220955392).
  2. qbo-clasp gains `mirrorReceiptRequestThreads()` (separate Apps Script PR): poll the
     endpoint after 7:45 AM, MERGE by thread key into `affidavit-threads.json` (never
     clobber Beverly's own entries), write atomically like `chatSweepAppendAnswer_`.
  3. From there the EXISTING machinery runs unchanged: photo replies in the thread are
     filed by the sweep (and, under Phase 1 §7, forwarded to intake with `source:"chat"` +
     threadName), job-name replies resolve items, and every resolution is appended to
     `chat-job-answers.json`.
- **Sign step**: signing stays with Beverly's interactive cards (ProBuild cards cannot
  carry working buttons — no `/api/chat/events`). Contract: a "sign N" text reply is
  recorded by the sweep into `chat-job-answers.json`; Beverly's runner, which already
  reads that file, posts her `cardId: "affidavit-<fingerprint>"` card into the SAME
  thread for that item; `chatAffidavitApp.js` handles the click, enforces owner-or-Justin,
  and writes the signed record + `MissingReceiptAffidavit_*.pdf` to "Missing Receipt
  Memos". ASSUMPTION / companion change: Beverly's Python runner (not in any repo here —
  it runs on Justin's PC) needs the small "post sign card on request" trigger; flag it in
  the PR description as a required companion, never silently assume it.
- **Close the loop**: `POST /api/automation/receipt-requests/answers` (same machine
  secret) accepting `{fingerprint, signed?, pdf_url?, job?, at, message, thread}` — a
  qbo-clasp forwarder posts each NEW `chat-job-answers.json` record. For
  `fingerprint = "pb-<bankLineId>"` with `signed:true`: record
  `{resolution:"memo-signed", pdfUrl}` into the issue's `displayDetails`, then
  `evaluateReviewIssue("bank-line", key, [], details)` to clear it. Photo answers need no
  handling here — the resulting Expense/ReceiptIntake closes the issue via the nightly
  matcher. Unknown fingerprints (Beverly's own) → `{ok:true, ignored:true}`.

## 5. Crons — `vercel.json` additions

- **AS BUILT — the chaser runs as TWO invocations of one route.**
  - `/api/cron/receipt-requests`, `"0 13 * * *"` — the full sweep. One
    predictable slot a day.
  - `/api/cron/receipt-requests?continue=1`, `"*/15 * * * *"` — the RESUME pass.
    It does no work of its own: if no cursor is parked it returns
    `{skipped:"nothing-in-progress"}` immediately, checked before the lease so a
    no-op resume cannot even briefly block the real run. It exists because the
    sweep is time-budgeted (200-line batches, a 45s budget, the cursor
    checkpointed after every batch), so a backlog too big for one invocation
    drains over the following quarter-hours instead of dying at the same point
    every night. Once the cursor clears, the resume passes cost one indexed
    read each until the next full sweep.
  - Open issues are reconciled in their OWN pass on every run, before the cursor
    is even read: closing must never wait for the cursor to lap round to an
    issue opened months ago.
- ORIGINAL PLAN (superseded by the two entries above):
  `/api/cron/receipt-requests`, `"0 13 * * *"` (6 AM Pacific, after the overnight QBO
  register push lands; NOTE: no in-repo register cron exists yet — ordering vs the
  external `post-qbo-register.mjs` run is operational; restate it in the route comment).
  Auth `isCronAuthorized` (cron-auth.ts, Phase 0); `maxDuration 60`;
  `pg_try_advisory_xact_lock(hashtextextended('receipt-requests', 0))` claim (Phase 1 §5
  pattern — pgbouncer forbids session locks). Loads: BankLine debits from the last 60
  days + their receipt-policy inputs; Expenses and live ReceiptIntakes over the same
  window ±2 days; open bank-line issues. Runs the pure matcher; applies opens/closes via
  `evaluateReviewIssue`; returns `{opened, closed, touched, skipped}` counts.
- `/api/cron/receipt-request-cards`, `"30 14 * * 1-5"` (7:30 AM Pacific in PDT; drifts to
  6:30 in PST — accepted, same as every other cron here). Gated on
  `RECEIPT_REQUEST_CARDS_ENABLED === "true"` (ships unset → `{skipped:"disabled"}`), so
  the matcher and page run silently for a shakedown week before any Chat noise.

## 6. Migration / env

- **No schema change.** Reason code + `displayDetails` JSON ride existing `ReviewIssue`
  columns (no CHECK blocks them — verified above); the queue reads Phase 1's
  `ReceiptIntake` as-is. No `scripts/apply-*.mjs`, no `prisma/migrations/` entry.
- New env (Vercel prod), AS BUILT:
  - `RECEIPTS_CHAT_WEBHOOK` — the incoming-webhook URL for `spaces/AAQAKhvMYtg`. Unset ⇒
    `{skipped:"no-webhook"}`, fails soft. Justin creates it in the space and sets it;
    Claude never handles the value. This REPLACES `GOOGLE_CHAT_SA_KEY` +
    `GOOGLE_CHAT_REVIEW_SPACE`, which are not used by anything in Phase 2 — the webhook
    choice is final. Because a webhook has no message-level idempotency, the day's
    replay guard is `displayDetails.card.date` in the database, not anything Chat does
    (see §4).
  - `RECEIPT_OWNER_CHAT_USERS` — `{"CJ":"users/…","Richard":"users/…"}`. Still needs
    collecting once; a wrong id locks that owner out of signing their own memo
    (chatAffidavitApp.js:211 gates on it). Malformed ⇒ empty map, and `owner_user`
    serializes as `""` rather than breaking the bridge JSON.
  - `RECEIPT_REQUEST_CARDS_ENABLED` — unset initially; must be exactly `"true"` to arm.
  - `BANK_LINE_MINT_FROM_QBO` — unset initially; `"true"` lets the nightly pull
    mint canonical `BankLine` rows from QBO register observations (Justin,
    decision 3). Off ships as an ABSENT dependency in the pull, not a disabled
    branch. Turn it on only AFTER `scripts/apply-phase2-receipt-queue.mjs` has
    run — the mint writes `sourceOfRecord`.
  - `RECEIPT_BRIDGE_SECRET` — gates BOTH bridge endpoints
    (`GET /api/automation/receipt-requests/threads`, `POST .../answers`). A
    THIRD secret, not Phase 1's intake key: the bridge runs inside Beverly's
    Apps Script project, and that project must not be able to book a Purchase.
    The complete capability list for each of the three keys lives in
    `src/lib/receipt-intake/intake-auth.ts` and `.env.example`; the rule is that
    a route needing something off its key's list needs a DIFFERENT key, never a
    wider one. Presenting the intake or archive key to a bridge endpoint (or the
    bridge key to an intake endpoint) is a **403** naming both capabilities, so
    a mis-wired script reads as a mis-wiring rather than a rotation problem.
    Setting any two of the three to the same value is refused at runtime.

- **Schema (this DID change, contrary to the original §6).** Two additive
  objects, in `scripts/apply-phase2-receipt-queue.mjs` +
  `prisma/migrations/20260901120000_phase2_receipt_queue`:
  `BankLine.sourceOfRecord` (default `'STATEMENT'`, CHECK in
  `('STATEMENT','QBO')`) and `ReceiptRequestCard` (UNIQUE `(owner, pacificDate)`
  — the durable per-day claim for the Chat digest; it also carries
  `status`, the post-claim (`claimedAt`/`claimToken`) and `overflowExact`,
  which says whether that card's "and N more" was a total or a floor). Run the script against prod
  BEFORE the deploy that selects them, per CLAUDE.md pre-deploy rule #2.

## 7. Tests (node:test, `test/receipt-requests/*.test.mjs`; no `mock.module` — CI is Node 20)

- `matcher.test.mjs` table:
  | case | expect |
  |---|---|
  | debit, 4 days old, no expense | open MISSING_RECEIPT, owner from tail |
  | same, matching expense (exact cents, same date, "LOWES #02516" vs "Lowe's Home Improvement") | no open; close if issue exists |
  | expense date +2 / -2 days | match (close) |
  | expense date +3 days | no match (open) |
  | amount off by 1 cent | open |
  | payee tokens disjoint ("CHEVRON" vs "CASH APP KANDI") with equal amount+date | open — amount+date alone never matches |
  | credit line (amountCents > 0) | ignored; close emitted if an issue exists |
  | debit 2 days old | ignored (grace) |
  | loan payment / insurance / DOR descriptor | exempt via receipt-policy; close emitted if an issue exists |
  | live ReceiptIntake match (totalCents/txnDate/vendor) | close |
  | DUPLICATE / VOID intake rows | never satisfy a line |
  | expense with null vendor or null date | never matches |
  | expense deleted since last run (was matched, now absent) | line re-opens |
- `idempotency.test.mjs`: matcher + a fake lifecycle run twice on identical input —
  second pass yields zero opens/closes (all same-hash touches); the open-issue input list
  is respected (no duplicate open for an already-open targetKey).
- `owner.test.mjs`: `C#8516`→CJ, `C# 6098`→Richard, `C#4297`→Justin (excluded from
  cards), no tail→office (excluded from cards), double-tail descriptor→no single owner.
- `cards.test.mjs`: builder groups by owner, numbers items, skips acked issues, caps at
  10 cards, requestId deterministic per owner+Pacific-date; threads-endpoint serializer
  emits the exact affidavit-threads.json shape (snapshot against a literal copied from
  sweepChatReceipts.js:109).
- `receipts-filters.test.mjs`: group/owner/project predicates.
- e2e (CI postgres, teardown per docs/TESTING.md): `/automation?tab=receipts` renders the
  six group headings for ADMIN; the threads/answers endpoints 401 with no auth AND with a
  bogus session cookie (getclients-auth-gate lesson).

## 8. Risks / open questions (max 5)

1. **Data freshness**: matcher truth is `BankLine`, which today fills only from monthly
   statement imports; QBO register rows are observations without canonical lines. The
   3-day chase is therefore late until Phase 6's nightly pull (or until unlinked
   QBO_REGISTER observations also feed the matcher — deliberately NOT done here, to avoid
   dual-identity issues when a statement later mints the canonical line). Confirm Phase 6
   ordering is acceptable, or ask for the observation-feed variant as a follow-up.
2. **Beverly companion change** (§4 sign step) lives outside every repo here (Hermes
   runner on Justin's PC). Until it ships, "sign N" replies are recorded but no sign card
   appears — photo/job replies work day one. HUMAN DECISION on sequencing.
3. **Chat user ids for CJ/Richard** must be collected once for `RECEIPT_OWNER_CHAT_USERS`
   (owner_user gates who may sign in chatAffidavitApp.js:211 — a wrong id locks the owner
   out of signing their own memos).
4. **Fuzzy-match false closes**: exact-cents + ±2-day + payee. NARROWED — payee
   agreement is no longer token overlap: it needs the same name (spacing- and
   possessive-insensitive), the same leading bigram, or one side being a lone brand
   token that leads the other. HOME DEPOT no longer agrees with HOME GOODS, nor
   PACIFIC PLUMBING with PACIFIC SUPPLY. What remains is a same-vendor,
   same-amount, same-week DIFFERENT purchase; accepted, because a close only
   silences a chase and the register/variance edges still surface unmatched
   purchases independently.
5. **Two chase surfaces during transition**: Beverly's own missing-receipt asks and
   ProBuild's cards could both fire while Phase 2 shakes down. Mitigation: cards ship
   behind `RECEIPT_REQUEST_CARDS_ENABLED`; Justin turns Beverly's ask generation off in
   the same step he enables the flag (one-line runbook item in the PR).


## 9. Operator checklist (before the flags go on)

Every one of these is a human step. None of it happens by merging.

1. **Run the schema scripts against prod, in this order, BEFORE the deploy that
   selects the new columns** (CLAUDE.md pre-deploy rule #2):
   `node scripts/apply-receipt-intake.mjs` then
   `node scripts/apply-phase2-receipt-queue.mjs`.
2. **Set `RECEIPT_BRIDGE_SECRET` in Vercel (production).** It is a NEW, REQUIRED,
   DISTINCT secret — not Phase 1's intake key, and not the archive key. Both bridge
   endpoints (`/api/automation/receipt-requests/threads` and `.../answers`) accept
   ONLY this one; presenting either other key is a 403. Generate a fresh long random
   value; Claude never handles it.
3. **Set the same value on the Apps Script side.** Beverly's bridge posts the
   `x-receipt-intake-secret` header, and it must now carry the BRIDGE secret. Until
   both sides are updated the bridge gets a clean 401/403 and signed memos stop being
   recorded — so change Vercel and Apps Script together, and re-run one thread export
   to confirm.
4. **Collect the Chat user ids** for `RECEIPT_OWNER_CHAT_USERS` (CJ, Richard). A wrong
   id locks that owner out of signing their own memo.
5. **Create the incoming webhook** in `spaces/AAQAKhvMYtg` and set
   `RECEIPTS_CHAT_WEBHOOK`. Unset ⇒ the cron answers `{skipped:"no-webhook"}`.
6. **Only then** set `RECEIPT_REQUEST_CARDS_ENABLED=true`, and turn Beverly's own
   missing-receipt asks OFF in the same step (risk 5).
7. `BANK_LINE_MINT_FROM_QBO` stays unset until somebody is watching the first run:
   minting creates canonical ledger rows and `amountCents` is immutable by trigger.
