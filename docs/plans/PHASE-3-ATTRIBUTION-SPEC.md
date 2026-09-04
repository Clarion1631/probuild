# Phase 3: Attribution — Implementation Spec

Date: 2026-09-01. Parent plan: `docs/plans/RECEIPT-PIPELINE-V2-PLAN.md` (Phase 3 row;
decisions 4 and 7, "Tax paid at source" section). Sibling: `docs/plans/PHASE-1-INTAKE-CORE-SPEC.md`
(being built on another branch — plan against its spec, not its code).
Planner output for the executor: build exactly this; do not guess.

## Verified code facts

- `Expense` (prisma/schema.prisma:580) has NO `projectId` — it reaches a project only via
  required `estimateId` (FK, Cascade). Has `itemId?`, `costCodeId?`, `costTypeId?`,
  `qbPurchaseId? @unique`, `status` default "Pending". No tax columns of any kind.
- **Every Expense writer today** (grep `expense.create|update|updateMany` in src/):
  | writer | file:line | knows project? | sets costCodeId? |
  |---|---|---|---|
  | QBO sync upsert | `src/lib/qbo-expense-sync.ts:609,612` (via `upsertQboExpense`; `QboExpenseWrite` :490 has NO projectId/costCodeId — `match.projectId` is computed at :434-488 then DROPPED, only `estimateId` survives) | yes (match / overhead bucket) | never |
  | QBO sync deactivate | `src/lib/qbo-expense-sync.ts:666` (zeroes amount) | n/a | no |
  | v1 Apps Script ingest | `src/app/api/integrations/receipt-ingest/route.ts:108` | yes (`matchProjectByName` :72) | yes via `matchCostCode` :99 (AI-split category from the Apps Script Gemini read) |
  | manual/mobile expense API | `src/app/api/expenses/route.ts:98` | yes (`projectId` resolved :29-61) | NO — the route does not even accept a costCodeId field |
  | mobile AI parse auto-create | `src/app/api/receipts/parse/route.ts:290` | yes (`projectId` param) | never |
  | server-action core (web forms, CO paths) | `src/lib/time-expense-core.ts:184` (`createExpenseCore`; callers in `src/lib/time-expense-actions.ts`) | yes (estimate.projectId resolved :148-152) | yes when caller passes it (human-picked) |
  | expense edit API | `src/app/api/expenses/[id]/route.ts:57` | n/a (edit) | yes (human edit) |
  | Phase 1 `bookReceipt` | Phase 1 spec §4 `src/lib/receipt-intake/book.ts` (unbuilt) | yes (`ReceiptIntake.projectId`) | yes: chosen or `matchCostCode(suggestedPhaseCode)` |
  | non-attribution writers (no change) | `billing-core.ts:1384` (invoice stamp), `qbo-receipt-attachments.ts:76` (receiptUrl), `expenses/[id]/approve:21` + `[id]/receipt:79` (status/receipt), `time-expense-core.ts:243` (CO tag) | — | — |
- **Readers that resolve an expense's project through the estimate** (`estimate: { projectId }`):
  `src/lib/job-variance-db.ts:143,191` (+ the :4-6 header comment saying projectId doesn't exist),
  `src/lib/project-financials.ts:70`, `src/app/projects/[id]/costing/page.tsx:57` (feeds
  JobCostingClient), `src/app/reports/profitability/page.tsx:76-92`,
  `src/lib/company-financials-charts.ts:292,307,341`, `src/lib/payouts-report.ts:65`,
  `src/lib/transactions-report.ts:92,114`, `src/lib/time-expense-actions.ts:225,306,332`,
  `src/app/api/projects/[id]/financial-overview/route.ts:63`, `src/lib/budget-actions.ts:44`,
  plus display-only includes (`manager/receipts/page.tsx:19,30,41`, `register-data.ts:89`,
  `automation-events.ts:685,840`, `qbo-bank-register.ts:232`, `review-alert-evaluator.ts:65`,
  `schedule-core.ts:1978,2212`, `api/ai/cost-forecast:29`, `api/ai/business-summary:35`,
  `api/automation/ai-review:355,578`). NOTE: `actions.ts:7431` matches the grep but is an
  EstimateItem query, not Expense — leave it alone. There is NO margin-digest in src/ yet
  (that is parent-plan Phase 4); the resolver below is what it will consume.
- **Item→costCode fallback** lives in `computeProjectVariance` (`src/lib/job-variance.ts`
  ~:279-330): an expense uses its own `costCodeId`, else its `itemId` item's cost code
  (via the item pool including "attribution-only" rows, job-variance-db.ts:141-166), else
  it lands in `unattributed*` (coverage struct :104-139, `attributedShare`).
- **`src/lib/cost-coding.ts`** = `resolveCostCode(dataSource, {costCodeId?, lineItemId?})`:
  explicit-id (validated + isActive) → line-item derivation → REJECT. DI, pure, no AI.
  Used at capture time. **`src/lib/project-match.ts`** = fuzzy `matchProjectByName` /
  `findBestProjectNameMatches` (used by QBO sync + receipt-ingest) and `matchCostCode`
  (category string → cost code). CORRECTION to the task premise: the QBO sync does NOT run
  any cost-code AI today — it only project-matches; cost codes on synced expenses are
  always null at import.
- **Scripts (2026-08-18/19)**: `scripts/suggest-expense-cost-codes.mjs` — RULE-based (regex
  vendor rules + line-keyword rules, NOT a model), dry-run default, `--apply` wrote the
  confident matches; scope = active customer jobs excluding "Shop"; header records 555/562
  uncoded before it ran; ~89/562 carry a code today (task premise; treat the exact number
  as re-measured by the backfill's before table). Everything ambiguous was left NULL for a
  human (CSV). `scripts/backfill-estimate-item-cost-codes.mjs` — coded 15 named ESTIMATE
  ITEMS (not expenses) on In Progress jobs, id+name asserted, dry-run default; it widened
  the item→costCode fallback's reach, but expenses rarely carry `itemId` (prod: 0/562 per
  the job-variance-db.ts:132 comment).
- **Mobile** (`gtr-probuild-mobile`): `apps/mobile/app/(tabs)/expenses.tsx` — picks a
  project from `useAuthStore().assignedProjects` (In Progress filter :57), photo →
  `POST /api/files/signed-upload` + storage PUT → `api.expenses.create` (=`POST
  /api/expenses`) with `{projectId, itemId:null, amount, vendor, date, description,
  receiptUrl}` (:176-184). Comment :27: "No phase / cost code attribution required on
  mobile". `lib/phasePicker.ts` is the PURE label/selection lib the Time Clock uses
  (crew-facing code-only labels); the phase list itself comes over the already-proxied
  `/api/projects/[id]/cost-codes` + `/api/projects/[id]/estimate-items` routes
  (site `src/proxy.ts:25`). ASSUMPTION: the clocked-in project is readable from the active
  entry state (`lib/activeEntry.ts` / snapshot) — executor confirms the accessor in that repo.
- **Tax paid at source**: `I:\My Drive\Expenses\Processed Receipts\Tax Paid at Source\`
  holds `TaxPaidAtSource_2012-06.csv` (filename and Date column say 2012 — they are
  2026-06 receipts, e.g. `"2012-06-26","Harbor Freight","Mesplay Kitchen",
  "001916749100246","207.74","4.79","0.43","16.55",...`; a date bug in whatever wrote it).
  Columns: Date, Vendor, Job, Invoice, Receipt Total, **Material Amount (deduction base)**,
  **Recoverable Tax**, **Consumable Tax**, Receipt File. NO code in src/ mentions
  tax-paid-at-source or carries tax on Expense today. Phase 1 stores `taxCents` on
  ReceiptIntake but its Prisma model has NO `taxAtSource`/`installedAtCustomer` columns —
  Phase 3 adds them there too.
- Overhead bucket: `src/lib/overhead-project.ts` (`OVERHEAD_PROJECT_ID`, `isOverheadProject`).
- Existing sync tests: `tests/qbo-expense-sync.test.ts` (node:test; CI is Node 20 — no
  `mock.module`, DI only).

## 1. Goals and acceptance criteria

1. **Schema live**: `Expense.projectId` (+FK, index), `taxAmount`, `taxAtSource`,
   `installedAtCustomer`, `costCodeSource`, `costCodeConfidence`; `ReceiptIntake.taxAtSource`
   + `installedAtCustomer`. Verify: `node scripts/apply-expense-attribution.mjs` twice
   (second run all "already exists" / 0 rows updated); CI `migrations` job green;
   `prisma generate` + `npx tsc --noEmit` clean.
   **DEPLOYMENT IS NOT DONE AT MERGE.** The pre-deploy run above has to happen
   BEFORE the build that selects these columns ships (CLAUDE.md pre-deploy rule
   #2), which means it necessarily runs before the OLD build has stopped
   writing. Every Expense the old build creates or updates in that window lands
   NULL-projectId and UTC-midnight, after the backfills already passed over the
   table. Closing that gap is a MANDATORY second pass, not an optional
   follow-up: once the new build is live and the previous Vercel deployment has
   drained, run
   `node scripts/apply-expense-attribution.mjs --post-deploy --yes --expect-db <name> --expect-host <host>`.
   Verify: the script's own output — "verified backfill: 0 expenses left
   unattributed" and "verified re-anchor: 0 expenses left at UTC midnight" —
   both reporting zero is the proof, not merely that the command exited 0.

   **THE FOUR STEPS, IN ORDER, AND WHAT EACH ONE IS FOR.** The window between
   them can put a single expense on two different jobs at once, so the order is
   not a suggestion:

   | # | Step | Why it cannot move |
   |---|------|--------------------|
   | 1 | **pre-deploy**: `node scripts/apply-expense-attribution.mjs --yes --expect-db <name> --expect-host <host>` | Adds the columns and installs the split-job guard BEFORE the backfill gives `projectId` any values. |
   | 2 | **merge** (auto-deploy ships `main`) | The new build starts serving; it sets `projectId` and `estimateId` together from one locked read. |
   | 3 | **drain** — wait for the previous Vercel deployment to stop serving | Until it does, an old instance is still writing rows that know nothing about `projectId`. |
   | 4 | **post-deploy**: same command with `--post-deploy` | Re-runs the three backfills for what the old build wrote in the window, then REMOVES the guard. |

   **The window step 1→3 leaves open, and why the guard is in step 1 rather
   than step 4.** The pre-deploy backfill sets `Expense.projectId` while the old
   build is still live. That build's QBO sync rewrites the whole expense record
   on every changed purchase (`transaction.expense.update({ data: write })`) and
   `write` carries `estimateId` — but its Prisma client predates `projectId`, so
   it cannot carry that. It re-points the row at another job's estimate and
   leaves the projectId step 1 just wrote. The row is then `projectId = job A,
   estimateId = job B`, and every reader that trusts one of the two reports the
   other job's money.

   The post-deploy pass **cannot clean that up afterwards**: its projectId fill
   matches `"projectId" IS NULL`, and these rows have a projectId. It is a
   non-null WRONG answer, the one shape a null-guarded backfill is blind to. So
   the window is closed instead of repaired — step 1 installs a BEFORE UPDATE OF
   `"estimateId"` trigger (`probuild_expense_estimate_pair_guard`) that
   re-derives the pair for any writer that moves the estimate without saying
   anything about the job. That is precisely the old build and precisely nothing
   in the new one, because the trigger fires only when `NEW."projectId" IS NOT
   DISTINCT FROM OLD."projectId"`. Step 4 drops it again: it is compatibility
   scaffolding for one deploy, and left standing it would overrule a future
   writer that legitimately moves an estimate.

   **If a database DID go out without the guard** (an earlier run of this
   script, or a deploy that predates this fix), the post-deploy verifier reports
   the count — "verified pair: N expense(s) disagree with their estimate's
   project" — and fails. Repairing it is **opt-in**, via
   `--post-deploy --repair-split-jobs`, and deliberately not the default: once
   the new build is live, that same shape has two causes the row cannot tell
   apart. Either the rollout window (the estimate is right, the projectId is
   stale) or a bookkeeper re-attributing an expense to another job (the
   projectId IS the human's answer, and the estimate belongs to the job the row
   LEFT — see the "RE-ATTRIBUTED expense" note in
   `src/app/api/expenses/[id]/route.ts`). Running the repair unasked would mean
   overwriting human decisions whenever the guess went the wrong way, on a
   money-attribution column, with nothing recording that it happened. **Read the
   rows before passing the flag.** The repair is scoped to
   `qbPurchaseId IS NOT NULL` regardless, because the old QBO sync is the only
   writer that can produce the damage.
2. **Every writer stamps projectId** (§3): after deploy, a new expense from each writer has
   `projectId` set. Verify: writer unit tests + one prod row per path spot-checked.
3. **Capture/manual codes are never overwritten** (§3): the QBO sync and the backfill only
   fill NULL `costCodeId` and never touch rows with `costCodeSource` in
   ("capture","manual"). Verify: `tests/qbo-expense-sync.test.ts` cases (§8).
4. **One shared resolver** (§4): all listed money-path readers resolve project/cost code
   through `src/lib/expense-attribution.ts`; outputs are byte-identical for rows with
   `projectId` NULL. Verify: resolver table test + `npm run build` + before/after diff of
   the variance page data for one project (checker step).
5. **Mobile capture carries job + phase** (§5, separate repo PR): receipt photo posts to
   `/api/receipts/intake` with projectId (defaulted to the clocked-in job), costCodeId, and
   installedAtCustomer. Verify: manual device test; intake row shows the fields.
6. **Backfill executed** (§6): dry-run reviewed by Justin, then `--apply`; re-run reports 0
   changes. **HEADLINE METRIC**: variance-page phase coverage — share of actual-cost
   DOLLARS with a resolvable cost code (computeProjectVariance `coverage.attributedShare`
   basis) across In Progress jobs (Shop excluded) **> 80%** after backfill + one week of
   captured intake (today ~89/562 expenses coded). The backfill prints this number before
   and after.
7. **Tax report ships** (§7): `/reports/tax-paid-at-source` renders per-period-per-job sums
   and exports CSV; gated by `financialReports`.

## 2. Schema

`prisma/schema.prisma` — add to `model Expense` (existing fields untouched):

```prisma
  // Phase 3 attribution: born-with-a-job. Nullable + backfilled; estimateId
  // stays the required parent, projectId is the denormalized truth readers use.
  projectId           String?
  project             Project? @relation(fields: [projectId], references: [id], onDelete: SetNull)
  taxAmount           Decimal? // sales tax read off the receipt (WA excise: tax paid at source)
  taxAtSource         Boolean  @default(false)
  installedAtCustomer Boolean? // null = unknown/legacy; drives the deduction report
  costCodeSource      String?  // capture | ai | manual | backfill
  costCodeConfidence  Decimal?

  @@index([projectId])
```

Add back-relation `expenses Expense[]` on `Project`. Add to `model ReceiptIntake` (Phase 1
branch — coordinate; if Phase 1 is unmerged when this lands, put these in the Phase 1 PR
instead): `taxAtSource Boolean @default(false)`, `installedAtCustomer Boolean?`.

`scripts/apply-expense-attribution.mjs` (additive, idempotent, `$executeRawUnsafe` over the
pooler, run against prod BEFORE merge — CLAUDE.md pre-deploy rule 2) and byte-identical
`prisma/migrations/<ts>_expense_attribution/migration.sql`:

```sql
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "projectId" TEXT;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "taxAmount" DECIMAL(65,30);
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "taxAtSource" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "installedAtCustomer" BOOLEAN;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "costCodeSource" TEXT;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "costCodeConfidence" DECIMAL(65,30);
CREATE INDEX IF NOT EXISTS "Expense_projectId_idx" ON "Expense"("projectId");
-- guarded FK (DO $$ ... pg_constraint IF NOT EXISTS block, per prior apply scripts):
--   "Expense_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"(id)
--   ON DELETE SET NULL ON UPDATE CASCADE
-- Fill projectId for existing rows from the owning estimate. Idempotent
-- (WHERE projectId IS NULL) and a no-op on CI's empty database.
UPDATE "Expense" e SET "projectId" = est."projectId"
FROM "Estimate" est
WHERE e."estimateId" = est.id AND e."projectId" IS NULL AND est."projectId" IS NOT NULL;
ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "taxAtSource" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "installedAtCustomer" BOOLEAN;
```

(If Phase 1's table is not in prod yet when the apply script runs, wrap the two
ReceiptIntake lines in a `to_regclass('"ReceiptIntake"')` guard so the script is runnable
in either merge order; the checked-in migration for those two columns then belongs to
whichever PR ships second.)

**AS BUILT — the source document's identity is its OWN column (Codex round 34).** The
Drive ingest deduped with `receiptUrl contains fileId` while storing a CALLER-SUPPLIED
`fileUrl`, so it was asking whether a value the caller controls happened to embed the
identity. Two ways that fails, and neither is hypothetical: a url that does not contain
the id (a resourcekey link, a `/uc?export=...` form) matched nothing, so every
re-delivery booked the whole receipt again — the advisory lock added in round 33 cannot
help, because both deliveries agree there is no prior row when the query cannot see one;
and `contains` is a substring test, so file id `abc` matched a stored url carrying
`abcd` and the second, unrelated document was silently dropped. As built:

```prisma
  sourceFileId        String?  // the Drive file id, exactly as received; compared by EQUALITY
  sourceGroupIndex    Int?     // which AI-split category group of that document this row is
  @@index([sourceFileId])
```

```sql
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "sourceFileId" TEXT;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "sourceGroupIndex" INTEGER;
CREATE INDEX IF NOT EXISTS "Expense_sourceFileId_idx" ON "Expense"("sourceFileId");
CREATE UNIQUE INDEX IF NOT EXISTS "Expense_sourceFileId_sourceGroupIndex_key"
  ON "Expense"("sourceFileId", "sourceGroupIndex") WHERE "sourceFileId" IS NOT NULL;
```

Round 33 recorded that no unique index could back the ingest lock, because every group of
one receipt shared a `receiptUrl` and there was no per-group ordinal. Both columns exist
now, so there is one: the partial unique index above makes a duplicate group
unrepresentable even for a writer that never takes the lock. It is PARTIAL so manual and
QBO-imported expenses are outside it entirely, and NULLS-DISTINCT (the btree default)
because rows backfilled from an existing `receiptUrl` have no knowable group ordinal —
they neither collide with each other nor gain the constraint's protection, and the
file-level dedupe is what keeps a re-delivery of those idempotent. Prisma cannot express a
partial index, so it is SQL-only and recorded in `prisma/prisma-blind-spots.json`, the
same treatment `BankImage_driveFileId_key` gets.

The backfill parses the id out of `receiptUrl` only where it is unambiguous (`/d/<id>`
or `id=<id>`) and leaves it NULL otherwise: a guessed id would dedupe two unrelated
documents against each other, which is the failure the column exists to end. It is part of
the POST-DEPLOY set for the same reason the `projectId` fill is — the old build keeps
writing receipt expenses with a url and no `sourceFileId` while it drains, and a row left
in that shape is invisible to the new equality dedupe.

## 3. Writers

Rule: **every writer sets `projectId` from the project it already knows**, and sets
`costCodeSource` whenever it sets `costCodeId`. Precedence: capture = manual > ai =
backfill > null. Nothing but a human edit may change a row whose `costCodeSource` is
"capture" or "manual".

1. **QBO sync** (`src/lib/qbo-expense-sync.ts`): add `projectId` to `QboExpenseWrite`
   (:490); populate from `match.projectId` (:1078 block) and from the overhead project id
   (:1032 block). In `upsertQboExpense`: on CREATE write it; on UPDATE set `projectId` only
   when the existing row's is NULL (a manual re-attribution must survive a re-sync — same
   posture as the deliberate receiptUrl omission, :578-580 comment). Extend the
   `findUnique` select with `projectId` and adjust `expenseMatchesQboWrite` so "unchanged"
   detection stays correct (compare projectId only when the update would write it).
   **AS BUILT — stricter than the line above (Codex round 2). ATTRIBUTION IS
   WRITE-ONCE.** `projectId` and `estimateId` are the same fact said twice, so they are
   written *together*, by one `updateMany` whose own predicate is `projectId: null`, and
   never again afterwards. The guarantee lives in the SQL rather than in a value read
   earlier in the transaction. An interim version also refreshed `estimateId` when the
   stored project and the incoming QBO match *agreed* — "same job, newer estimate", the
   sync's long-standing attach-to-the-active-estimate behaviour. **That carve-out was
   dropped.** It bought a row following its job to a newer estimate, and paid for it by
   making the rule conditional, which is exactly how the original cross-job bug got in
   (`projectId` kept, `estimateId` overwritten → the row on job B for every reader and on
   job A's estimate for cascade-delete and billing). Re-pointing an estimate belongs to an
   explicit re-attribution path, not to an import.
   **Follow-up: re-attribution.** Write-once means this phase ships with no
   supported way to MOVE an already-attributed row — a fuzzy customer/job match
   that landed on the wrong project has no in-app correction path. An
   authorized atomic action that re-points `projectId` and `estimateId`
   together (the same two-column, same-fact guarantee the writers keep) is
   deferred to a follow-up rather than bolted on here under review pressure.
   **AS BUILT (Codex round 42, item 4).** Two things landed early because the
   alternative was a documented hazard rather than a missing feature. (1) The
   move itself has ONE implementation, `reattributeExpense` in
   `src/lib/expense-attribution.ts`: it locks both jobs' parents in the
   canonical order, RESOLVES the target job's own estimate (or writes
   `estimateId: null` when that job has none), and compare-and-sets on the
   attribution it decided from — so the pair can never be half-moved. It has no
   caller yet; `tests/attribution-lock-order.test.ts` fails any expense write
   that moves `projectId` on an already-attributed row without moving
   `estimateId` with it, so the path built next has to be this one. (2)
   `Expense.estimateId` is now NULLABLE with `ON DELETE SET NULL` rather than
   NOT NULL with `ON DELETE CASCADE`: with re-attribution keeping a row on an
   estimate belonging to a job it has left, deleting that estimate DELETED
   another job's spend. SET NULL over RESTRICT because the row keeps its
   `projectId` — the primary attribution every reader already prefers — and
   RESTRICT would block deleting a PROJECT, since Project cascades to its
   Estimates. `Invoice.estimateId` and `Takeoff.estimateId` already take the
   SET NULL stance in this schema.
   Until it exists, a bad match is corrected one of two ways: (1) fix the
   customer/job field on the purchase in QBO and let it re-sync — this only
   reaches the row if `projectId` is STILL null, since that is the guard's own
   predicate, so it only helps a row nobody has attributed yet, not one
   already locked onto the wrong job; or (2) a one-off script for a row that
   is already locked in, run by hand against prod like the other scripts in
   this doc.
   **Cost-code suggestion**: extract `VENDOR_RULES`, `LINE_RULES`, `suggestCode` from
   `scripts/suggest-expense-cost-codes.mjs` into a new pure module
   `src/lib/expense-cost-suggest.ts` (the script imports it back — one copy). After a
   successful upsert where the row's `costCodeId` IS NULL and `costCodeSource` is not
   capture/manual, run `suggestCode({vendor, description})`; on a hit write `costCodeId`,
   `costCodeSource: "ai"`, `costCodeConfidence`: 0.9 for a vendor-rule hit, 0.75 for a
   line-rule hit (the rules are binary; fixed tiers make the §6 threshold meaningful).
   Overhead-bucket rows are excluded (same scope rule as the script). Never on the
   deactivate path.
2. **Phase 1 `bookReceipt`** (spec §4 step 5 — coordinate with that branch): the Expense
   create additionally carries `projectId: row.projectId`, `taxAmount: taxCents/100` (when
   read), `taxAtSource: row.taxAtSource`, `installedAtCustomer: row.installedAtCustomer`,
   and `costCodeSource`/`costCodeConfidence`: "capture" (confidence null) when a human
   chose `costCodeId` at capture; "ai" + `suggestedConfidence` when it fell back to
   `matchCostCode(suggestedPhaseCode)`. `POST /api/receipts/intake` accepts
   `installedAtCustomer?: boolean` (**no default — see the TAX POSITION note below**; an
   absent answer stays NULL and the excise report skips the row), and for drive/email/chat sources
   the read step sets `taxAtSource = taxCents > 0`.
3. **receipt-ingest v1** (`receipt-ingest/route.ts:108`): add `projectId: project.id`,
   `costCodeSource: costCode ? "ai" : null`, `costCodeConfidence: null` (the category is
   an Apps Script Gemini read, not a human). Minimal — this path retires at Phase 1 cutover.
4. **`/api/expenses` POST** (:98): add `projectId` (already resolved in both branches);
   accept optional `costCodeId` + `costTypeId` validated through `resolveCostCode`
   (cost-coding.ts) AND `isCostCodeAllowedForProject` (project-phases.ts) — both checks,
   per the cost-coding.ts SCOPE note — with `costCodeSource: "capture"`. Do NOT make the
   code required here; this route serves legacy mobile builds and the no-photo path.
5. **`/api/receipts/parse`** (:290): add `projectId` (in scope), leave cost code null.
6. **`createExpenseCore`** (`time-expense-core.ts:184`): add
   `projectId: estimate.projectId` and `costCodeSource: data.costCodeId ? "manual" : null`.
7. **Expense edit** (`api/expenses/[id]/route.ts:57`): when the PATCH changes `costCodeId`,
   set `costCodeSource: "manual"`, `costCodeConfidence: null`. Never let any client set
   `costCodeSource` directly on any route.

## 4. Readers — one shared resolver

New `src/lib/expense-attribution.ts` (pure, no I/O):

```ts
export function resolveExpenseProjectId(e: { projectId: string | null;
    estimate?: { projectId: string | null } | null }): string | null;
    // e.projectId ?? e.estimate?.projectId ?? null
export function resolveExpenseCostCodeId(e: { costCodeId: string | null; itemId: string | null },
    itemCostCodeById: ReadonlyMap<string, string | null>): string | null;
    // e.costCodeId ?? (e.itemId ? itemCostCodeById.get(e.itemId) ?? null : null)
export function expenseForProjectWhere(projectId: string): Prisma.ExpenseWhereInput;
    // { OR: [ { projectId }, { projectId: null, estimate: { projectId } } ] }
    // ONE OR key built in one object literal — never spread two conditional ORs
    // (prisma-where-or-key-collision lesson).
```

Behaviour contract: for every row with `projectId` NULL these resolve exactly what the
current `estimate.projectId` traversal resolves — existing outputs must be identical.
`resolveExpenseCostCodeId` is the SAME fallback `computeProjectVariance` implements today;
refactor job-variance.ts's inline version (~:316-330) to call it so there is one copy.

Call sites to change (mechanical swap, no behavior change):
- `src/lib/job-variance-db.ts:143,191` → `expenseForProjectWhere(project.id)`; rewrite the
  :4-6 header comment (it becomes false the moment the column exists).
- `src/lib/project-financials.ts:70`, `src/app/api/projects/[id]/financial-overview/route.ts:63`,
  `src/app/projects/[id]/costing/page.tsx:57`, `src/lib/budget-actions.ts:44`,
  `src/lib/time-expense-actions.ts:225,306,332` → `expenseForProjectWhere(projectId)`.
- `src/lib/payouts-report.ts:65`, `src/lib/transactions-report.ts:92,114` → same, inside
  their existing conditional filter.
- `src/app/reports/profitability/page.tsx:76-92` → select `projectId` too; bucket rows by
  `resolveExpenseProjectId(e)`; widen the :77 where to the OR form
  (`{ OR: [{ projectId: { not: null } }, { estimate: { projectId: { not: null } } }] }`).
- `src/lib/company-financials-charts.ts:292,307` → the OR predicate over the id set; :341
  is a `groupBy` on the relation filter — keep its shape and add a comment that
  post-backfill it can become a plain `groupBy(["projectId"])` (do NOT change it in this
  PR; identical-output rule).
- Display-only includes (manager/receipts, register-data, automation-events,
  qbo-bank-register, review-alert-evaluator, schedule-core, ai routes): NO change now —
  they read `estimate.project` for labels and stay correct either way.
- Future margin-digest (parent-plan Phase 4) consumes this resolver; it has no code today.

## 5. Mobile receipt capture (gtr-probuild-mobile, separate PR)

File-level diff:
- `apps/mobile/app/(tabs)/expenses.tsx`:
  (a) default the project dropdown to the clocked-in project when a shift is active
  (active-entry state; else keep the current first-active default);
  (b) add a phase picker under the project field reusing the Time Clock's phase-list fetch
  (`/api/projects/[id]/cost-codes` + `/api/projects/[id]/estimate-items` — already in the
  site proxy allowlist, src/proxy.ts:25) and `lib/phasePicker.ts` labels
  (`phaseCodeLabel`); optional but encouraged (inline nudge), never blocking;
  (c) add an "Installed at customer job" toggle. **SUPERSEDED — see the as-built note
  below.** This line originally said "default TRUE for a real job, FALSE when the selected
  project is Shop/overhead". That default was REMOVED: the toggle now starts UNSET and the
  app must send an explicit answer (or nothing at all);
  (d) when a PHOTO is attached, submit via a new `api.receipts.intake` →
  `POST /api/receipts/intake` (JSON `fileBase64`, `source:"mobile"`, `projectId`,
  `costCodeId?`, `installedAtCustomer`) instead of the signed-upload + `/api/expenses`
  pair — the intake pipeline creates the Expense at booking. Keep the `/api/expenses`
  path ONLY for the no-photo case (it stamps projectId per §3.4).
- `apps/mobile/lib/api.ts` + `lib/api-types.ts`: add `receipts.intake(...)` and the
  overhead-project-id field.
- Auth: `/api/receipts/intake` bypasses the proxy (Phase 1 §3) and calls
  `authenticateMobileOrSession` — the crew Bearer token works with no proxy change.
- Gate on Phase 1 being deployed; until then ship (a)-(c) with the existing
  `/api/expenses` POST carrying `costCodeId` (§3.4 accepts it).

### AS-BUILT (site side, 2026-09-01) — what the mobile PR can rely on

The mobile repo was **not** touched by this PR. Everything the app needs now
exists and is deployed with the site, so the mobile diff is purely client-side.

Server contracts the app can call today:

| what the app needs | endpoint / field | state |
|---|---|---|
| overhead project id (to default the toggle) | `GET /api/mobile/me` → `overheadProjectId` (new) | **done**, `src/app/api/mobile/me/route.ts` |
| phase list for the picker | `GET /api/projects/[id]/cost-codes` + `/estimate-items` | already existed, already proxied (`src/proxy.ts`) |
| no-photo expense WITH a phase | `POST /api/expenses` now accepts `costCodeId` | **done** — validated through `resolveCostCode` AND `isCostCodeAllowedForProject`, stored with `costCodeSource: "capture"`. Rejections are `{error, code}` with `COST_CODE_NOT_FOUND` / `COST_CODE_INACTIVE` / `PHASE_NOT_ON_PROJECT`, so the app can show a useful message |
| photo expense through the pipeline | `POST /api/receipts/intake` accepts `projectId`, `costCodeId`, `installedAtCustomer` | **done** — `installedAtCustomer` is read from JSON (`true`/`false`) or multipart (`"true"`/`"false"`); anything else means "the caller did not say" |
| the toggle's answer | server-side `resolveInstalledAtCustomer` (`src/lib/expense-attribution.ts`) | **done, and it has NO DEFAULT** — silence stays NULL on every source, including a receipt filed against a real job. See the tax-position note below. The app MUST show the toggle and send a real answer; there is no server-side fallback to lean on |

Auth is unchanged: `/api/receipts/intake` is on the proxy's exact-match public
bypass and calls `authenticateMobileOrSession` itself, so the crew Bearer token
works with no proxy change.

**TAX POSITION — `installedAtCustomer` has no default (Codex round 2, PR #442).**
An earlier build of this branch defaulted it to TRUE for any non-overhead project, exactly
as §5c above originally specified. That was wrong in the one direction a tax figure must
never fail in: WAC 458-20-102(12)(b) allows the cost of the articles actually RESOLD, and a
receipt coded to a live job is just as likely to be consumables, tools, fuel, dump fees or a
service. Defaulting it turned "nobody looked at this" into a deduction claimed on a state
return. As built:

* silence is `NULL` on every source — mobile, web, Drive, email, chat;
* `/reports/tax-paid-at-source` counts ONLY an explicit `true`;
* `Expense.taxDeductibleBase` (added in this PR) holds the resold portion of a MIXED
  receipt, and the report uses it in place of the pre-tax total when it is set;
* **`Expense.taxSource` is a four-state column**, not a label. It governs `taxAmount`
  and nothing else — the deduction base has its own `Expense.taxDeductibleBaseSource`
  (below), and `installedAtCustomer` is its own evidence, since a non-null value already
  means somebody answered.

  | state | meaning | who writes it | may an automated pass overwrite the figures? |
  |---|---|---|---|
  | `null` | nobody has looked, or nobody has looked SINCE the figures were invalidated | the initial insert | yes |
  | `"ocr"` | the intake pipeline read the figures off the receipt | booking | yes — it is a guess, and re-readable |
  | `"manual"` | a person supplied an amount | the PATCH, when the request carries a tax figure | **no** |
  | `"manual-none"` | a person looked and said this receipt carries NO sales tax | the PATCH, when the request carries `taxAmount: null` | **no** |

  The last two are `HUMAN_TAX_SOURCES` (`src/lib/expense-attribution.ts`); booking and the
  QBO sync both compose `taxNotHumanDecidedWhere()` rather than testing for one of them by
  hand. `"manual-none"` exists because a null `taxAmount` alone cannot say whether a person
  decided there is no tax or nobody has looked yet — and OCR overwriting the first of those
  is a bookkeeper's answer silently replaced by a machine's guess.

  OMITTING the `taxAmount` key leaves `taxSource` untouched: that request said nothing
  about tax, so nobody decided anything and a later read may still fill it.
* **`Expense.taxDeductibleBaseSource` governs the deduction BASE, and only it.** The two
  figures are decided separately, often by different parties, and one column could not
  say so. A `taxDeductibleBase`-only PATCH deliberately leaves `taxSource` alone — the
  base is a portion of the tax figure, not an answer about it, and stamping "manual"
  there would lock an OCR read out of a row nobody has spoken to tax about. Booking then
  fills `taxAmount` and stamps `taxSource: "ocr"`. While `taxSource` governed both
  figures, that combination stored a claim that OCR had decided a base a bookkeeper had
  typed by hand.

  So: the PATCH stamps `taxDeductibleBaseSource: "manual"` whenever it leaves a base
  standing (including the server-computed `amount − taxAmount`, which is the person's
  "all of it" written out), and `null` when it clears the base back to blank. Booking
  never writes the column at all: it supplies no base, so it has nothing to say about
  one, and a human base keeps its own provenance through any number of OCR tax fills.
  The "I do not know" retraction clears BOTH provenances with both figures.

  **So does every QBO invalidation (Codex round 34).** `planQboExpenseUpdate` has two
  branches that throw a figure away — a gross too small to carry the recorded tax, and a
  hand allocation stranded above the new pre-tax remainder — and `deactivateQboExpense`
  retires the lot when QuickBooks says the purchase never happened. Each of them now
  clears `taxDeductibleBaseSource` in the SAME statement that clears
  `taxDeductibleBase`, and deactivation counts it in "is this row already retired?" as
  well. Leaving it standing left the row saying "base NULL, and a person decided that
  base" — provenance for a figure that does not exist, which `book.ts` reads to decide
  whether an automated pass may touch the allocation and the correction UI shows a
  bookkeeper as their own answer.

  Rows that predate the column are backfilled to `"manual"` where a base stands beside a
  human `taxSource` — before the split a human base could only exist on a row a human had
  also answered about tax, so that is the conservative reading. Rows with an OCR or
  absent `taxSource` stay null.
* **A blank deduction base means "the whole pre-tax total", and the SERVER stores it.**
  Not a null with a remembered meaning: when a PATCH writes the tax figures and leaves
  `taxDeductibleBase` blank, the row is saved with `amount − taxAmount` (sign intact, so a
  refund's base is negative). Legacy nulls stay readable and the report still treats them
  as the whole pre-tax total; nothing new is added to them.
* **`Expense.needsTaxReview` is cleared only by an explicit acknowledgement.** A re-sync
  that moves the gross on a classified row raises it, and the report skips flagged rows.
  Clearing it requires `taxReviewAck: true` AND, on a flagged row, ALL THREE of the
  `taxAmount`, `taxDeductibleBase` and `installedAtCustomer` keys in the same request —
  each either a coherent figure/answer (→ `"manual"` for `taxAmount`) or an explicit `null`
  (→ `"manual-none"` for `taxAmount`; for `taxDeductibleBase`, null means "the whole pre-tax
  total", as above; for `installedAtCustomer`, null means "I do not know whether this was
  resold", which the report reads as not deductible). The flag means the WHOLE
  classification is in doubt, and those three fields are the whole classification, so
  certifying part of it while staying silent about the rest is the half-answer the flag
  exists to prevent — a request that omits any of the three on a flagged row is a 400
  (`TAX_REVIEW_ACK_MALFORMED`): it has nothing to certify. `installedAtCustomer` is NOT the
  optional one it looks like: it is the single field the excise report keys on, so omitting
  it preserves a stored `true` and silently re-admits the receipt (round 43, item 1). On an
  UNFLAGGED row (an ack sent alongside an ordinary edit, with nothing to clear), only
  `taxAmount` is required. A partial correction without the ack is still accepted; it just
  leaves the flag standing. Enforced by `taxReviewAckIsComplete`
  (`src/lib/expense-attribution.ts`), which the route calls only when
  `expense.needsTaxReview` is true.
* **`ReceiptIntake.costCodeSource` records WHO captured a phase**: `"user"` (a signed-in
  person, through the app or the mobile capture screen) or `"machine"` (a shared-secret
  forwarder resolving it from a Drive folder or a mail rule). Booking copies the
  distinction onto the Expense — a user's capture books as `capture` and is untouchable, a
  machine's books as `machine` and stays correctable by the backfill and the QBO
  suggester. It is derived from the CALLER at every door (`captureActorSource(auth.via)`),
  never read off a request body, and a row captured before the column existed is treated
  as a machine guess.
* **Phase validity is a transactional invariant.** `assertPhaseOfProjectTx`
  (`src/lib/phase-invariant.ts`) share-locks `Project` → `Estimate` → `EstimateItem` →
  `CostCode` in that fixed order and then answers on the CALLER'S transaction, so an
  estimate archived or reassigned, or a cost code deactivated, between the check and the
  write cannot be written into job cost. Every Expense writer that sets a cost code calls
  it inside its write transaction: the POST route, the PATCH, the legacy PUT,
  `createExpenseCore`, the Drive receipt ingest, receipt booking (which parks the row as
  `phase-changed:<reason>` rather than booking an uncoded receipt) and the QBO suggester.
  `tests/expense-writer-phase-guard.test.ts` fails when a new writer appears without it.

  **The attribution backfill is the eighth (Codex round 34).** It was the last writer
  deciding phase membership from a list it fetched for itself — a plain
  `estimateItem.findMany` taken inside its write transaction but holding nothing. Under
  READ COMMITTED a concurrent transaction can insert an estimate and a line item and
  commit them after this script's lock scans, and the next statement sees them; the
  verdict then rested on a row nobody had locked, so it could be deleted, or its estimate
  archived or moved to another job, before the `UPDATE` committed. It now calls
  `provePhaseMembershipTx` on its own transaction immediately before the write, whose
  `FOR SHARE OF ei, e` clause holds the exact pair that answered.
  `provePhaseMembershipTx` rather than the whole `assertPhaseOfProjectTx` on purpose:
  the latter also admits the company Safety phase on an In Progress job with no estimate
  item behind it, and this pass deliberately does not — a materials receipt is never a
  safety meeting. `tests/phase-invariant-db.test.ts` drives the interleaving against a
  real Postgres in CI's `migrations` job.
* the correction path is **`PATCH /api/expenses/[id]`**, NOT the PUT on that route. PUT is
  guarded by `assertExpenseMutableOutsideQbo`, and every expense the pipeline books carries a
  `qbPurchaseId` — so PUT cannot reach a single row the tax report is made of, and it now
  rejects these fields outright rather than appearing to accept them. PATCH edits ONLY
  `installedAtCustomer`, `taxDeductibleBase`, `taxAmount` and `costCodeId` (all
  ProBuild-only: nothing syncs them to QuickBooks) and requires the `financialReports`
  permission on top of project access. **`taxAtSource` is DERIVED, never supplied** — it is
  exactly "`taxAmount` is present and non-zero", the database CHECK
  `Expense_taxAtSource_check` says so, and a request carrying the key is a 400 rather than
  a silent no-op (round 20, item 1). The figures are validated SIGNED against the ROW the
  request leaves behind, because a vendor credit is a NEGATIVE expense carrying negative
  tax: each of `taxAmount` and `taxDeductibleBase` is either zero or of the SAME SIGN as
  `amount`, `|taxAmount| ≤ 12% of |amount|` (`MAX_PLAUSIBLE_TAX_RATE`), and
  `|taxDeductibleBase| ≤ |amount − taxAmount|`. Written as `0 ≤ base ≤ amount − taxAmount`
  those bounds would reject every legitimate refund. The invariant is
  ALSO a database CHECK (`Expense_taxDeductibleBase_check`), because a concurrent QBO sync
  could otherwise strand it between the handler's read and its write.
* booking persists only the tax `buildGroups` accepted, so a check or a nonsense
  `tax >= total` lands with NO tax and stays out of the report until a human supplies the
  real figure through that PATCH.

The mobile PR must therefore ship the toggle as a real three-state question, not as a
pre-answered switch, and `overheadProjectId` on `/api/mobile/me` is now only a UI hint for
which way to lean the copy — it no longer decides anything.

Remaining mobile-repo diff (a separate PR in `gtr-probuild-mobile`):
- `apps/mobile/app/(tabs)/expenses.tsx` — (a) default the project dropdown to
  the clocked-in job; (b) add the phase picker (`lib/phasePicker.ts` labels);
  (c) add the "Installed at customer job" toggle — UNSET by default, never
  pre-answered (see the tax-position note below); (d) when a PHOTO is attached, submit via
  `api.receipts.intake` instead of the signed-upload + `/api/expenses` pair.
- `apps/mobile/lib/api.ts` + `lib/api-types.ts` — add `receipts.intake(...)`
  and the `overheadProjectId` field on the `/me` response type.
- The `/api/expenses` no-photo path keeps working unchanged for older builds;
  `costCodeId` is optional there on purpose, so a legacy app is never broken.

## 6. Backfill — `scripts/backfill-expense-attribution.ts`

One-shot, dry-run DEFAULT (`--apply` to write, `--csv <path>`), same shape and .env
loading as `suggest-expense-cost-codes.ts`. It is TypeScript and runs under the tsx
loader:

```
node --import=tsx scripts/backfill-expense-attribution.ts          # dry run
node --import=tsx scripts/backfill-expense-attribution.ts --apply  # write
```

Steps:
(a) `projectId` from `estimate.projectId` where NULL (same UPDATE as the apply script —
    belt and braces; report rows touched).
(b) Item fallback: expenses with `costCodeId` NULL and a coded `itemId` → copy the item's
    cost code, `costCodeSource: "backfill"`, confidence null. (Prod expects ~0 rows —
    run it anyway; it becomes live when item-level capture starts.)
(c) Rule suggester for the rest: `suggestCode` from `src/lib/expense-cost-suggest.ts`,
    scope = In Progress customer jobs, overhead excluded by `OVERHEAD_PROJECT_ID` (id,
    not the name list). Write only when confidence >= 0.7 (both current tiers pass; the
    threshold guards future tiers), `costCodeSource: "ai"` + the tier confidence.
    NEVER touch rows whose `costCodeSource` is capture/manual or whose `costCodeId` is
    already set.
(d) Print a before/after coverage table — per project: expenses coded/total (count AND
    dollars) and the overall dollar share (the §1.6 metric) — and write the remainder
    (still-NULL rows: id, project, date, vendor, amount, description head) to the CSV for
    Marge.
Re-run after `--apply` must report 0 changes (backfill-estimate-item-cost-codes proof rule).

**The backfill's before/after % is not the same number as the variance page's
coverage, and should not be read as one.** The backfill's dollar share (step
(d), the §1.6 metric it prints) measures STRICT write eligibility: rows this
script is actually allowed to touch — `costCodeId` NULL, `costCodeSource` not
capture/manual, project In Progress and non-overhead. The variance page's
`coverage.attributedShare` counts a wider universe, including draft/archived
jobs' coded items as attribution-only rows the backfill never scopes into.
The backfill's number is therefore a CONSERVATIVE LOWER BOUND on the variance
page's coverage, not an estimate of it — the variance page will read equal or
higher, never lower, and the two should never be reconciled to match exactly.

**AS BUILT — there is exactly ONE writer of `costCodeId` among the scripts.**
`scripts/suggest-expense-cost-codes.ts` (the older rule-suggester) had its own
`--apply`, which made it a second writer of the same column — one with no
per-expense lock, no row-version compare-and-set, no re-plan under that lock and
no project-scoped phase check. Its `--apply` is REMOVED (Codex round 12): it is
report-only now, reads attribution through `resolveExpenseProjectId`, excludes
the overhead bucket by `OVERHEAD_PROJECT_ID` rather than by the name "Shop",
reports a match only when the writer would accept it, and emits its CSV through
`csv-safe`. `tests/scripts-runtime-smoke.test.ts` fails if a write or an
`--apply` flag ever comes back.

Both scripts are `.ts` and run under `node --import=tsx` — they import
TypeScript from `src/`, and tsx hands a `.ts` module to an `.mjs` file as CJS,
so named imports fail outright from a `.mjs` wrapper.

## 7. Tax paid at source report — `/reports/tax-paid-at-source`

- `src/app/reports/tax-paid-at-source/page.tsx` (server component, List layout per
  DESIGN_SYSTEM.md) + `src/lib/tax-at-source-report.ts` (pure aggregation, unit-tested).
- Gate: the `financialReports` permission (`src/lib/permissions.ts:110,173`) — same check
  pattern as the sibling reports pages.
- Data: expenses where `taxAtSource = true AND installedAtCustomer = true AND
  taxAmount != 0 AND needsTaxReview = false` (the first two POSITIVE — a NULL
  `installedAtCustomer` is "nobody said" and is never claimed), grouped by month (from
  `date`, company timezone) × project. **`taxAmount != 0`, not `> 0`:** a return or vendor
  credit is a negative expense carrying negative tax and belongs on the filing as a
  SUBTRACTION; excluding it would claim a deduction for tax that was refunded. A zero is an
  answer ("no tax"), not an absence, so it is excluded. `needsTaxReview = false` is the one
  NEGATIVE condition and it is about lifecycle rather than content: a QBO re-sync that
  moves the gross under a recorded tax retires the classification, and until a human
  answers again the row is not a deduction — in particular the "a null `taxDeductibleBase`
  means the whole pre-tax total" rule must not fire on it.
  **DEPENDENCY ON PHASE 1:** the report treats `Expense.date` as a COMPANY-TIMEZONE calendar
  day — it filters on company-midnight bounds and buckets with `dayKeyInTimeZone`. That is
  only correct if the value was stored as company-local midnight for the receipt's calendar
  day. Phase 1 owns that write (`ReceiptIntake.txnDate` is `@db.Date`, which Prisma returns
  as UTC midnight, and `book.ts` copies it into the timestamp column); storing UTC midnight
  would shift every Pacific receipt one day earlier and drop the first day of a quarter. The
  fix lives on the Phase 1 branch and lands here on rebase
  (`resolveExpenseProjectId`), summing `taxAmount`. Columns: Month, Job, Receipts (count),
  Taxable amount (Σ `amount` — see risk 1), Tax paid at source (Σ `taxAmount`). Month and
  grand totals. Period filter, default current quarter. CSV export mirroring the existing
  workbook columns (Date, Vendor, Job, Invoice, Receipt Total, deduction base, Tax) so
  Vanessa's handoff file shape survives — reuse the register CSV-export pattern.
- Footnote: "Sales tax already paid on materials resold as part of customer work is
  deductible on the WA excise return line 'taxable amount for tax paid at source'. Only
  receipts flagged installed-at-customer count; Shop and consumable purchases are excluded."

## 8. Tests (node:test in `tests/`, DI stubs — NO mock.module, CI is Node 20)

- `tests/expense-attribution.test.ts`: resolver table — projectId set / null+estimate /
  null+null; cost code explicit / item-fallback / neither; `expenseForProjectWhere` shape
  (single OR key, two branches).
- `tests/qbo-expense-sync.test.ts` (extend): (1) create writes projectId; (2) update
  leaves a non-null projectId alone; (3) suggester fills a NULL code with source "ai" +
  confidence; (4) a row with costCodeSource "capture" (and "manual") is NEVER rewritten by
  the sync, even when the suggester has an answer; (5) overhead rows get no suggestion;
  (6) deactivate path never touches attribution fields.
- `tests/backfill-expense-attribution.test.ts`: script core with an injected prisma-shaped
  stub — dry-run makes ZERO write calls; apply respects the capture/manual guard and the
  0.7 threshold.
- `tests/tax-at-source-report.test.ts`: sums per month×job; excludes installedAtCustomer
  false/null, taxAtSource false, and zero/null taxAmount.
- Acceptance for §1.4 (identical outputs): checker captures the variance report data for
  one prod project before and after the reader PR and diffs it.

## 9. Risks / open questions (max 5)

1. **`Expense.amount` semantics are MIXED and this spec keeps them mixed.** Phase 1 decided
   amount = PRE-TAX when the receipt's tax is split (its §4 step 5 and risk 2, mirroring
   the QBO COGS line under the reseller-permit rule); the QBO sync writes GROSS `TotalAmt`
   (`qbo-expense-sync.ts:1084`). So the tax report's "Taxable amount" column (Σ amount) is
   exact for intake-born rows and tax-inclusive for legacy QBO-imported rows — which
   mostly carry `taxAmount` NULL and are therefore excluded from the report anyway.
   Recommendation: accept and document on the report page. HUMAN DECISION only if Justin
   wants gross normalized instead.
2. **projectId can drift from estimateId** once both exist (estimateId stays required and
   still Cascade-deletes the expense). Writers set them together; any future "move
   expense" feature must move both. The resolver prefers projectId, so a bad manual
   projectId wins silently. Mitigations: §3.1's null-only update rule and the backfill's
   re-run-reports-zero check.
3. **The "AI" suggester is regex rules** with a proven failure mode (the $3,317.78 Mesplay
   excavator→20-CLEAN mis-book caught only in dry-run — script comment :86-90). The
   capture/manual guard plus mandatory dry-run review contain it, but coded-by-rule is not
   verified-by-human; the CSV remainder plus Marge is the correction loop.
4. **Receipt-level `installedAtCustomer` is coarser than the current workbook**, which
   splits Recoverable vs Consumable tax WITHIN one receipt (the Harbor Freight row carries
   $0.43 recoverable AND $16.55 consumable). A mixed receipt must be flagged
   whole-or-nothing in v1. Acceptable? If not, this becomes a line-level model and a much
   bigger change.
5. **Cross-branch coordination with Phase 1**: `bookReceipt` and the intake route are being
   built elsewhere; §3.2's fields must land in THAT code, and the two PRs must not both
   edit `src/lib/receipt-intake/book.ts`. The §2 to_regclass guard keeps the apply script
   safe in either merge order.

Rollout order: apply script on prod → writers + resolver PR (identical-output, Codex
review on the sync and resolver diffs — money path) → backfill dry-run → Justin reviews
the table → `--apply` → mobile PR → tax report PR.
