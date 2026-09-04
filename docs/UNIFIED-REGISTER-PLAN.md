# Unified Money Register — plan v4 (final; build from this)

Merges `/automation` and `/automation/bank` into one drill-downable dashboard with the bank
register as the **spine**.

Review history: v1 blocker (8B/5M) → v2 blocker (3 not-fixed, 4 new B) → v3 blocker (7 not-fixed,
14-item punch list). v4 applies the punch list. **No round 4 on prose** — remaining design detail
is pinned down in code, where Codex reviews concrete implementations at the step 4 and step 10
gates. Three rounds of prose review produced diminishing returns; a durable job state machine is
specified more reliably by typed code + tests than by markdown.

## Framing
> **QuickBooks WTB account register** — posted QuickBooks entries affecting account 154, fetched
> at [time]. This view cannot see bank transactions that are pending, excluded, or missing from
> QuickBooks. Bank-side completeness requires the daily WTB CSV compare (decision 3 as amended
> 2026-09-02 — the export runs daily, and is also the money-IN trigger for the deposit sweep).

Spine = information architecture, not completeness. No "true north", no "no dollar can hide".

---

## 1. Three independent edges

**Scope:** purchase-like rows with non-null `qbTxnId` only (`qbo-bank-register.ts:25,199`).

| Edge | Source | Absent ⇒ |
|---|---|---|
| receipt | `AutomationEvent` (`kind:"receipt-push"`, `status` ∈ {`created`,`already-exists`}) → `qbPurchaseId` | `unknown` (grey, "no audit record") — **never** `fail` |
| job cost | `Expense.qbPurchaseId` (`@unique`, `schema.prisma:522`) | `fail` |
| amount | cent-exact vs `-row.amountCents` | `n/a` when no job-cost edge |

`logAutomationEvent` swallows insert failures (`automation-events.ts:61`), so a missing event is
not evidence of a missing receipt.

### Promote evidence out of JSON
`qbPurchaseId` / `fileId` live inside the `detail` **String** blob (`schema.prisma:2180`). Add
typed nullable columns `qbPurchaseId`, `driveFileId` to `AutomationEvent`.

**Rollout order (punch 12) — non-negotiable:** add nullable columns → deploy dual-write logger →
batch historical backfill with checkpoints and malformed-row handling → catch-up pass over
remaining nulls → create indexes non-blockingly. Backfilling before dual-write leaves live inserts
null. Display caps (5,000 events / 200 journeys) are **not** table-size bounds — the backfill scans
JSON-in-TEXT and must be batched.

### Provenance — full ID only
Join on full `driveFileId`. **Never** `docNumber` = `fileId.slice(0,21)` (`create/route.ts:120`),
which collides by the code's own admission (`qbo-receipt-push.ts:477`).

**Pre-existing prod bug (punch 5):** `ai-review/route.ts:203-230` searches by the 21-char prefix and
`receiptJourneys` aggregates by it (`automation-events.ts:280-308,351-355`) — both can select or
merge the wrong receipt **today**. Re-key both to typed `driveFileId`/`qbPurchaseId`.

Legacy rows without `driveFileId`: prefix fallback yields **`unknown` + "possible prefix collision
— unconfirmed"** and may never produce a receipt edge. Fix `backfill-automation-events.mjs:101` to
dedupe by full `fileId`.

### Marker preservation (punch 5) — corrected shape
v3 said "reserve marker space". **Wrong**: `qboExpenseDescription` receives a memo that already
contains the marker, prepends a prefix, appends line text, then slices the whole thing
(`qbo-expense-sync.ts:770-783`). Correct transformation:
1. Extract the complete `[gtr-file:…]` marker from `purchase.memo`.
2. Remove it from the descriptive body.
3. Truncate prefix + body + line suffix to `4000 - marker.length - 1`.
4. Append the marker **last**.

Severity note, unchanged: the trigger needs a ~3,950-char memo, so this is a real mechanism with an
implausible trigger. Fixed anyway — the marker is load-bearing for idempotency.

### Orphan receipts — three-valued
**Reconciled** (matched by Purchase ID) · **Exception** (parked/quarantined/errored/email-booked,
matched by full Drive ID + final state) · **Unknown** (no audit evidence — **never** orphaned).

---

## 2. Register status — explicit sign × type matrix (punch 8)

v3's catch-all mapped all `other` → `not-applicable`, which **hid real money-out** (negative
Deposit/Payment/Sales Receipt, Refund Receipt, unknown negative types all land in `other` —
`qbo-bank-register.ts:199-214,250-295`). Replaced with an exhaustive matrix. **Default is
`needs-review`, never `not-applicable`** — an unrecognized outflow must surface, not vanish.

| Row | Status |
|---|---|
| purchase-like, non-null id, amount < 0, all edges pass | `documented` |
| purchase-like, non-null id, amount < 0, job-cost + amount pass, receipt `unknown` | `job-cost-matched` (Codex code review) — in denominator `M`, **not** in `documented` `N`, **not** in the actionable queue. Surfaced as its own "receipt provenance unverified" count. Covers expenses keyed straight into QuickBooks with a paper receipt, which never touch the receipt-push pipeline and so have no `AutomationEvent` — ever. |
| purchase-like, non-null id, amount < 0, any edge fails | `needs-review` |
| purchase-like, non-null id, amount < 0, classifier = overhead/owner-draw, job cost does **not** pass | `not-applicable` (counted separately as "expected non-job spend") |
| purchase-like, non-null id, classifier = overhead/owner-draw **but job cost passes** | `needs-review` — **classification conflict**, included in denominator. A matched Expense contradicts "non-job spend". Codex's probe showed the unguarded version collapsing the denominator to 0. |
| purchase-like, non-null id, classification **unknown** | `needs-review` (punch 7 — never documented, never hidden) |
| purchase-like, amount = 0 | `unclassifiable` — not spend, excluded from denominator |
| purchase-like, amount > 0 (reversal/refund) | `needs-review`, labelled "money came back" — excluded from spend denominator |
| purchase-like, **null** `qbTxnId` | `unclassifiable` — cannot join or alert; counted + rendered honestly |
| known money-in type, amount > 0 | `not-applicable` (money in) |
| known money-in type, amount **< 0** | `needs-review` — sign/type conflict, real outflow |
| Transfer / Journal / tax payment / bill payment | `not-applicable`, typed verdict |
| Refund Receipt, unknown `other`, amount < 0 | `needs-review` — **unrecognized outflow** |
| unknown `other`, amount > 0 | `not-applicable` (money in) |

**Denominator:** `M` = purchase-like, non-null id, amount < 0, excluding classifier-marked
overhead/owner-draw **that do not conflict** (a conflicting row stays in `M`). `job-cost-matched`
rows stay in `M` too. Tile reads *"N of M job-costable spend rows"*. Unknown-classification and
receipt-provenance-unverified counts reported separately.

**Cent-exactness (Codex code review):** amounts must be parsed from the Decimal's *string* form
straight into integer cents. `Math.round(Number(d) * 100)` is float-lossy — `10.075` yields 1007,
not 1008. Fractional-cent, unparseable, or unsafe-magnitude values **fail closed**: they become an
indeterminate amount edge routed to `needs-review` with a stated reason, never a silent mismatch
and never a `pass`.

**Purity:** the shared `PURCHASE_TYPES` / `MONEY_IN_TYPES` sets live in a pure leaf module imported
by both `qbo-bank-register.ts` and `register-merge.ts`. They must **not** be imported from
`qbo-bank-register.ts` directly — that would pull Prisma and QBO deps into the pure module.

---

## 3. Page structure — `/automation`

**Redirect:** `/automation/bank` → **307**, translating `range` + `view` (`bank/page.tsx:140,152`).

**Tiles:** Money in · Money out · Documented (of job-costable spend) · Needs review · Orphan
exceptions. **Range:** 30d / 60d / 90d (`All` removed — contradicted the 92-day QBO cap).

**Table:** Date · Type · Doc/Check # · Payee · Amount · Documentation (3 pips; `unknown` grey) ·
Links. Non-pip statuses render typed text.

**Drill-down:** QuickBooks · ProBuild job cost · Receipt provenance timeline · Actions.

**Extract, don't reimplement** (`StateChip` private, timeline inline — `journey-list.tsx:122-130`):
verify panel (`:436-485`), AI review + fix suggestions (`:769-808`), filters (`:162`), five-hour
stale detection (`:132-136`), saved-hours strip (`page.tsx:290-297`), guide link (`page.tsx:243`),
admin Sync Now (`page.tsx:251-255`). *(v3 miscited stale detection, guide and Sync Now — punch 12.)*

**Pipeline health (collapsible):** the four displaced metrics (no consumer outside this page),
intake chart, sync-runs table, pause/resume.

---

## 4. Notifications — Google Chat app

**Console state (verified in browser, 2026-08-03):** project `probuild-487805` in the Golden Touch
Remodeling org. Chat API enabled. App "ProBuild", App ID `907285576178`, status LIVE. Visibility
now `jadkins@` + `gtrsupport@` (Marge) — **changed this session**. Service account
`probuild-chat@probuild-487805.iam.gserviceaccount.com` — **created this session**, no keys yet;
key generation and Vercel install are Justin's (credential, never handled here). The configured
endpoint `/api/chat/events` **does not exist in the repo** — outbound posting does not need it,
interactive buttons do. Not in scope here.

Env: `GOOGLE_CHAT_SA_KEY`, `GOOGLE_CHAT_REVIEW_SPACE` (`spaces/AAQAKhvMYTg`),
`REVIEW_ALERTS_ENABLED` (ships `false`).

### Reason codes, not display text (punch 9)
v3's comma-joined string collides: `["a,b","c"]` and `["a","b,c"]` canonicalize identically. And
hashing text containing amounts/dates churns a new generation on every evaluation.

Use stable **reason codes** (`NO_RECEIPT`, `NO_JOB_COST`, `AMOUNT_MISMATCH`, `DUPLICATE`,
`UNCLASSIFIED`, …), sorted, encoded as canonical JSON, hashed with untruncated SHA-256. Amounts
and dates live in a separate display-details field that is **not** hashed.

**Acknowledgement is per-code, not whole-set:** store the acknowledged code set. Removing one
acknowledged reason must not re-alert the remaining acknowledged subset; a genuinely new code must.

### Schema
`ReviewIssue` (current state, `@@unique([targetType,targetKey])`, `version` for optimistic
concurrency, `reasonCodes`, `reasonHash`, `acknowledgedCodes`, `firstObservedAt`, `clearedAt`,
`absentSince` — when the target first went missing from a trustworthy snapshot; age-out
bookkeeping only, deliberately does NOT bump `version`) ·
`ReviewAlertEpisode` (immutable snapshot, `@@unique([issueId,generation])`, full retry state) ·
`ReviewAlertBatch` (same complete retry model, FK + index from episodes) ·
`QboPurchaseClassification` (keyed by `qbPurchaseId`: classification, reason, syncToken, timestamps)
· `RolloutGate` (durable lease row).

All statuses constrained by idempotently-added PostgreSQL **CHECK constraints** rather than
unvalidated strings (punch 10) — fits the additive `scripts/apply-*.mjs` workflow. No `String[]`:
this repo has no scalar-list precedent.

### Lifecycle — ordered decision tree (punch 1)
v3's seven-row table overlapped and had no evaluation order. Evaluate **in this order**, short
circuit on first match, all inside one short transaction guarded by `version`:
1. set empty → `clearedAt`, clear ack, cancel open episodes
2. no issue → create, `generation=1`, PENDING episode
3. issue cleared, set non-empty → un-clear, `generation+1`, PENDING episode
4. acknowledged codes ⊇ current codes → suppress, no episode
5. same `reasonHash` → touch only
6. changed hash → `SUPERSEDED` open episode (if not SENT), open `generation+1`

Statuses gain `SUPERSEDED` and `CANCELLED`. `Mark reviewed` conditionally updates by
`{id, version, reasonHash}` so a stale request cannot repopulate ack fields after clearing.

**CLAIMED semantics (punch 2):** a claim already crossing the network cannot be cancelled — fencing
only blocks its *database* completion. An old immutable episode may still post. Always enqueue the
new generation regardless.

#### Absence is not resolution

A target missing from the register (deleted in QBO, retyped off this domain, aged out of the
trailing window) does NOT map to step 1's clear branch on the next sweep it's absent from. It maps
to the clear branch only once BOTH hold: the target has been continuously absent from a
trustworthy snapshot for a grace window (`ABSENCE_GRACE_MS`, review-alert-evaluator.ts —
long enough to outlive the register cache, the QBO-failure cooldown, and at least two independent
backstop sweeps), AND the snapshot driving that clear itself passed a freshness check (not served
`stale` after a QBO error) and a coverage check (at least half of currently-open issue keys still
present — the circuit breaker for a misconfigured bank account id or an empty-but-structurally-valid
report). The coverage check only applies once there are at least `COVERAGE_GATE_MIN_OPEN_ISSUES`
(5) open issues — below that floor the ratio's denominator is too small to carry signal (a single
open issue whose target genuinely vanished scores 0/1 = 0%, permanently below the 50% threshold,
so it would never age out), and "mass disappearance" isn't a meaningful concept at 1-4 open issues
anyway. Below the floor, absence tracking proceeds on the `stale` gate and the grace window alone.
Rationale, so it isn't re-litigated: step 1's clear branch wipes `acknowledgedCodes` and
`acknowledgedAt`, and a subsequent reopen (step 3) mints a new `requestId` (`issueId:generation`)
that Chat's own dedupe can't catch — so a single transient or bad snapshot, acted on immediately,
would both destroy a bookkeeper's "I reviewed this" decision and send her a duplicate card. The
grace window and trust gates exist specifically to make that single-bad-sweep failure mode
impossible; don't remove them to "simplify" the reconciliation path.

### Delivery — mirror the real drainer (punch 3)
v3 wrote failures as `FAILED` + `nextAttemptAt` but only claimed `PENDING` — **failures were
stranded permanently**. Mirror `payment-outbox.ts:24-31,82-123,133-151` faithfully:
background/scoped candidate modes · due-retry and stale-claim predicates · FIFO ordering · take
limit · attempts incremented **in** the claim · post-claim read-back · configurable
`MAX_ATTEMPTS` · **retry as PENDING until the cap, terminal FAILED only after** · completion
updates caught and fenced by `claimToken`.

Send outside any transaction (Prisma interactive transactions default 5s, pool caps at 5 —
`prisma.ts:26-31`). Deterministic Chat `requestId` = `issueId:generation`; a repeated `requestId`
returns the existing message. Google documents no finite dedupe window — do not invent one.

### Rate ceiling
Max 10 cards/run; overflow → `BATCHED` with `batchId` → one summary card through the same
claim/fence/retry path. Cleared or superseded episodes are excluded/cancelled before the payload is
built, so a stale issue cannot appear in the summary.

### Rollout (punch 11)
Not a long transaction or session advisory lock — neither survives pgbouncer pooling. A durable
`RolloutGate` row every evaluator checks: gate on → write baseline SUPPRESSED episodes → final
catch-up → persist completion → gate off. Then alert on state transition via `firstObservedAt`.
Transaction date is display data only (CDC deliberately catches backdated purchases —
`quickbooks.ts:572`). Today's backlog (15 + 9) absorbed: visible, zero cards.

---

## 5. Build order

1. **State machines** — register matrix (§2) + lifecycle (§4) as typed code with tests.
2. **`AutomationEvent` typed columns** — the 5-phase rollout in §1. Fix backfill prefix dedupe.
   Attach `{fileId}` via the common event builder to every outcome after successful auth + body
   validation; explicitly exclude unauthorized/invalid-body (punch 13). Marker fix (§1).
3. **`QboPurchaseClassification`** — persist at sync time before project matching, covering
   purchases, skips, removals, deactivations. Bulk-backfill every Purchase ID in the register
   window. Unknown ⇒ `needs-review` (punch 6, 7).
4. **`src/lib/register-merge.ts`** — edges, full status matrix, three-valued orphans. Pure, no I/O,
   unit-tested (prefix collision, unknown paths, every matrix row). → **Codex review** (money math).
5. **Extract shared components** with the existing page still green.
6. **Page shell + tiles + register table.**
7. **Pipeline-health + 307 redirect with param translation.**
8. **Schema + outbox + evaluators.** Internal order: apply schema → deploy evaluator disabled →
   baseline → catch-up → enable. `Mark reviewed` / manual-send APIs carry their **own**
   `financialReports`/admin checks — RLS is not authorization here, Prisma connects as a bypassing
   role (`apply-automation-events.mjs:49`). Plus a **periodic receipt-exception backstop** so an
   ingest-path failure cannot permanently skip alert creation (punch 14).
9. **Drill-down + `?focus=` + row actions** — after 8; the actions need those APIs.
10. **Chat integration** behind `REVIEW_ALERTS_ENABLED`. → **Codex review** (external integration).

Steps 1-7 ship the dashboard and are independently useful. 8-10 add alerting.

## 6. Standing constraints
- Register **read-only against QBO**. No new writes to the books.
- One GL report call per render, cached. No per-row QBO calls.
- Never cache `TempDownloadUri`.
- Claude never enters bank credentials, never handles the Chat service-account key.
- `financialReports` gates the page; new APIs carry their own checks.
