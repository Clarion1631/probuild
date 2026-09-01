# Phase 4 — Percent Complete + Earned Margin + Monday Card + "Dragging Us" Line

Date: 2026-09-01. Parent plans: `RECEIPT-PIPELINE-V2-PLAN.md` (decisions 5, 10; "Percent complete and earned margin" section), `PROFIT-LOOP-PLAN.md` Phase 4.
All facts below verified in-repo on this worktree; assumptions are marked ASSUMPTION.

## Root cause / why

The dashboard (`src/lib/project-financials.ts` -> `/reports/company-financials` and the per-project Financial Overview route `src/app/api/projects/[id]/financial-overview/route.ts`) shows **cash margin only** (`currentMargin` = collected minus expenses, no % complete). Mid-flight jobs cannot answer "are we profitable". Fix: store a per-project percent complete (auto-computed from phase budgets x schedule-task progress, manually overridable), derive earned revenue/margin from it, and surface it in three places: dashboard tiles, a Monday Google Chat card, and a weekly email.

## 1. Goals (numbered, checkable)

1. `Project` carries percent-complete columns; a nightly cron fills the auto value for every active job; manual override by ADMIN/MANAGER wins until auto drifts > 5 points from the auto value captured at override time.
2. `computeProjectFinancials` returns four NEW fields (`earnedRevenue`, `earnedMargin`, `receiptCompleteness`, `phaseCoverage`) — every EXISTING field in the `ProjectFinancials` interface (lines 11-42 of `src/lib/project-financials.ts`) keeps its exact current meaning and value. Checkable: existing consumers (`company-financials/page.tsx`, `api/projects/[id]/financial-overview/route.ts`, `company-financials-charts.ts`) render identical numbers for the old fields before/after.
3. `/reports/company-financials` gains an Earned Margin tile and a Receipt Completeness tile, plus per-job columns "% Compl." and "Earned Margin".
4. Project Financial Overview page gains a Percent Complete card with an ADMIN/MANAGER edit control (server action in `src/lib/actions.ts`).
5. Monday 14:00 UTC: one Chat message to the Main Office webhook, one line per active job with auto %, last manual % + date, earned margin, and a job link.
6. Same Monday run: "dragging us" email to `PIPELINE_DIGEST_TO` — bottom two active jobs by earned margin, each with its biggest unattributed cost.
7. Unit tests for the pure formula and a Decimal-serialization check pass in `npm run test:unit`.

## 2. Schema

New columns on `Project` (schema.prisma `model Project`, line ~234) — all nullable, additive:

| Column | Type | Meaning |
|---|---|---|
| `percentComplete` | `Decimal(5,2)?` | the EFFECTIVE value shown everywhere (auto or manual) |
| `percentCompleteSource` | enum `PercentCompleteSource` (`AUTO`, `MANUAL`)? | who set `percentComplete` |
| `percentCompleteAsOf` | `DateTime?` | when `percentComplete` was last written |
| `percentCompleteAuto` | `Decimal(5,2)?` | last machine-computed value; nightly cron always updates this, even under a manual override |
| `percentCompleteAutoAtOverride` | `Decimal(5,2)?` | snapshot of `percentCompleteAuto` taken when a manual override is saved. PLANNER ADDITION beyond the requested field list: the >5-point drift rule compares "auto now" to "auto at override time", which is unrecoverable without this snapshot. |
| `percentCompleteUpdatedById` | `String?` FK -> `User.id` ON DELETE SET NULL | who overrode (null for AUTO writes) |

`needsReview` is DERIVED, not stored: `source === MANUAL && auto != null && autoAtOverride != null && abs(auto - autoAtOverride) > 5`. Helper `percentCompleteNeedsReview()` in `src/lib/percent-complete.ts`.

**Migration** — two artifacts, same SQL (repo rule: additive idempotent script + real migration file):
- `scripts/apply-percent-complete.mjs` — pattern of `scripts/apply-bank-ledger.mjs` (`$executeRawUnsafe` over the pooler; never `db push`).
- `prisma/migrations/<timestamp>_percent_complete/migration.sql`.

```sql
DO $$ BEGIN
  CREATE TYPE "PercentCompleteSource" AS ENUM ('AUTO', 'MANUAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "percentComplete" DECIMAL(5,2);
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "percentCompleteSource" "PercentCompleteSource";
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "percentCompleteAsOf" TIMESTAMP(3);
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "percentCompleteAuto" DECIMAL(5,2);
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "percentCompleteAutoAtOverride" DECIMAL(5,2);
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "percentCompleteUpdatedById" TEXT;
DO $$ BEGIN
  ALTER TABLE "Project" ADD CONSTRAINT "Project_percentCompleteUpdatedById_fkey"
    FOREIGN KEY ("percentCompleteUpdatedById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
```

Update `schema.prisma` to match (enum + 6 fields + User back-relation, e.g. `percentCompleteUpdates Project[] @relation("PercentCompleteUpdatedBy")`). Run the apply script against prod BEFORE merge (CLAUDE.md pre-deploy checklist step 2).

## 3. Auto formula — `src/lib/percent-complete.ts` (pure, no Prisma)

Phase budgets REUSE the variance basis: `loadProjectVariance([projectId])` (`src/lib/job-variance-db.ts`) already builds per-phase `totalBudget` from leaf `EstimateItem` rows (section headers excluded via `isEstimateSectionRow`, `PHASE_ELIGIBLE_ESTIMATE_WHERE` eligibility) plus **Approved** `ChangeOrderItem` rows, keyed by `costCodeId`. Do not re-derive budgets.

```ts
export interface PhaseProgressInput {
  costCodeId: string;
  budget: number;              // PhaseVariance.totalBudget
  totalTasks: number;          // ScheduleTasks in this phase (see mapping below)
  doneTasks: number;           // of those, status === "Complete"
  hasDailyLogMention: boolean; // any DailyLog.aiSuggestedTaskId resolving into this phase
}
export function computeAutoPercentComplete(input: {
  phases: PhaseProgressInput[];
  uncodedBudget: number;       // ProjectVariance.uncodedBudget
}): number | null
```

Rules (each is a test case):
- Weight: `w_p = max(budget,0) / sum(max(budget,0))` over coded phases. Negative-budget phases (see `hasNegativeBudget` in job-variance.ts) contribute 0 weight. `uncodedBudget` is excluded from weights.
- **Trust gate:** if coded positive budget is 0, OR coded positive budget < 50% of (coded positive + uncoded) budget, return `null` — a weight built from a sliver of the estimate is a guess, not a measurement (same honesty rule as `VarianceCoverage`). Jobs without an eligible estimate therefore return null.
- Phase progress: `doneTasks / totalTasks` when `totalTasks > 0` ("done" = `ScheduleTask.status === "Complete"`, the canonical value in `SCHEDULE_TASK_STATUSES`, `src/lib/schedule-task-core.ts:16`).
- Fallback when `totalTasks === 0`: `0.5` if `hasDailyLogMention` (work has evidently started; half is the stated coarse convention — see Open Questions), else `0`.
- Result: `sum(w_p * progress_p) * 100`, clamped 0-100, rounded to 2 dp.

Task-to-phase mapping (done by the cron, DB side): `ScheduleTask.estimateItemId` (unique FK, schema.prisma:1115) -> `EstimateItem.costCodeId`. Tasks with no `estimateItemId` or an uncoded item belong to no phase and are ignored; so are `type` "milestone"/"appointment" rows. Daily-log mention: `DailyLog.aiSuggestedTaskId` (schema.prisma:2112, written by `src/lib/daily-log-task-match.ts`) -> same task-to-phase mapping. NOTE: the nightly Chat-to-daily-log ingest (`~/.claude/scheduled-tasks/nightly-daily-log-ingest/SKILL.md`) is currently DISABLED; re-enabling it is an ops step for Justin, not code — until then mentions only come from manually written logs.

Override rule: while `percentCompleteSource === MANUAL`, the cron writes `percentCompleteAuto` only and never touches `percentComplete` (or `percentCompleteAsOf`, which stays the manual timestamp). `needsReview` fires when auto has moved > 5.00 points (strictly greater) from `percentCompleteAutoAtOverride`. Nothing auto-reverts a manual value; the Monday card and the UI badge flag it for a human.

## 4. New fields in `src/lib/project-financials.ts` (additive only)

Extend the `ProjectFinancials` interface and return object; touch NO existing computation. Return plain `number | null` — never a Prisma Decimal (memory: Decimal serialization sweep; use `Number()` like the rest of the file; `toNum` in `src/lib/prisma-helpers` also available).

- `percentComplete: number | null`, `percentCompleteSource: "AUTO" | "MANUAL" | null`, `percentCompleteNeedsReview: boolean` — read from the stored `Project` columns (one added `prisma.project.findUnique` select in the existing `Promise.all`). Pages NEVER compute auto; only the cron does.
- `contractValue: number`: sum of `estimate.totalAmount` for statuses `Approved | Invoiced | Partially Paid | Paid` (already fetched — `validEstimateStatuses` covers them all) + sum of Approved `ChangeOrder.totalAmount` (one added query). CAVEAT: estimate `totalAmount` is tax-inclusive once a rate is set; `ChangeOrder.totalAmount` is pre-tax (CLAUDE.md money invariants) — accepted approximation, document in code.
- `earnedRevenue: number | null` = `contractValue * percentComplete / 100`; null when `percentComplete` is null or `contractValue === 0`.
- `earnedMargin: number | null` = `earnedRevenue - (totalExpenses + totalTimeCost)`; null when `earnedRevenue` is null. (Unlike `currentMargin`, this DOES include labor — say so in the tile subtitle.)
- `receiptCompleteness: number | null` (0..1): **`BankLine` has NO job FK** (schema.prisma:2743 — only a free-text `projectName` and an untyped `probuildExpenseId`), so per the plan's stated fallback this is defined as: sum of abs(`expense.amount`) where `receiptUrl` is non-empty, divided by sum of abs(`expense.amount`) over the job's expenses (`Expense.receiptUrl` exists, schema.prisma:594; Expense has no projectId — it reaches the job via `estimate.projectId`, already how this file queries). Null when the job has no expenses. Absolute dollars so refunds cannot fake completeness (same reasoning as `VarianceCoverage.unattributedGross`).
- `phaseCoverage: number | null` (0..1): (sum abs(`expense.amount`) with `costCodeId` set + sum abs(`laborCost`+`burdenCost`) of time entries with `costCodeId` set) / total absolute actual dollars. Add `receiptUrl` and `costCodeId` to the existing expense query's select; the timeEntry findMany already returns full rows. NOTE: deliberately simpler than variance's `attributedShare` (no item-link reconciliation) — may differ by a hair from the variance page; document in code.
- Shop/Shed exclusion happens at the CALLER, as today: `OVERHEAD_PROJECT_ID` from `src/lib/overhead-project.ts` (env `QBO_EXPENSE_OVERHEAD_PROJECT_ID`, fallback the prod Shop id — `company-financials/page.tsx:21` should be repointed at that shared module while touching the file, it still has its own inline copy). "Shed" has no code representation anywhere in `src/` (only a name-collision comment in `qbo-expense-sync.ts:447`) — ASSUMPTION: Shed is off-books and not a ProBuild project, so no new exclusion is needed. `Project.isLogistics` additionally excludes logistics buckets (see "active job" below).

## 5. UI

1. **Edit control** — new client component `src/app/projects/[id]/financial-overview/components/PercentCompleteCard.tsx`, rendered from that route's `page.tsx`. Shows: effective % (large), source badge (Auto / Manual by {name} on {date}), the current auto value when overridden, and an amber "auto has moved — review" badge when `needsReview`. ADMIN/MANAGER only (pass a `canEdit` prop computed server-side from the session role; roles live in `src/lib/permissions.ts`): number input (0-100, step 0.5), Save, and a "Use auto" reset button. Any hover-hidden button MUST carry `[@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto` (CLAUDE.md rule); simplest compliant choice: keep these buttons always visible.
2. **Server actions** in `src/lib/actions.ts` (repo rule — no new action files):
   - `updateProjectPercentComplete(projectId, value)` — session + role in {ADMIN, MANAGER} or throw; clamp 0-100; writes `percentComplete=value, percentCompleteSource=MANUAL, percentCompleteAsOf=now, percentCompleteAutoAtOverride=percentCompleteAuto, percentCompleteUpdatedById=user.id`; `revalidatePath` the financial-overview page. Money-path-inert: no notifier, no client visibility, no portal effect.
   - `resetProjectPercentCompleteToAuto(projectId)` — same gate; sets `percentComplete=percentCompleteAuto, source=AUTO, autoAtOverride=null, updatedById=null, asOf=now`.
3. **`/reports/company-financials`** (`page.tsx`): extend `buildRow` (it already calls `computeProjectFinancials`); tiles grid `md:grid-cols-5` -> `md:grid-cols-7` (or wrap to two rows): "Earned Margin" tile = sum of `earnedMargin` over jobs with a non-null value, sub "x of y jobs have a % complete; includes labor"; "Receipt Completeness" tile = company-wide expense-dollar share with receipts. Jobs table: two new columns after "Margin %": "% Compl." (value + an `M` marker when manual, an amber dot when needsReview, em dash when null) and "Earned Margin" (green/red tone like Margin $). Bump the empty-state `colSpan={9}` to `{11}` and extend both `tfoot` rows.
4. `/reports/profitability/page.tsx` is a separate ADMIN/MANAGER/FINANCE page with its own row math — deliberately UNTOUCHED this phase.

## 6. Crons (add to `vercel.json` `crons`; auth = the exact `ar-digest` pattern: Bearer `CRON_SECRET`, fail-closed when `VERCEL_ENV` is set — `src/app/api/cron/ar-digest/route.ts:16`; `export const maxDuration = 60`)

**Active job** (one helper, e.g. `activeJobWhere()` in a new `src/lib/percent-complete-db.ts`): `status: "In Progress"` AND `id != OVERHEAD_PROJECT_ID` AND `isLogistics: false`.

1. `/api/cron/percent-complete-recalc` — `"0 9 * * *"` (nightly, 1-2 AM Pacific). For each active job: `loadProjectVariance([id])` for phase budgets; query `ScheduleTask` (projectId, estimateItemId -> costCodeId, status, type) and `DailyLog.aiSuggestedTaskId` mentions; call `computeAutoPercentComplete`; write `percentCompleteAuto` — and when source is `AUTO` or null, also `percentComplete`, `percentCompleteSource=AUTO`, `percentCompleteAsOf=now`. Never overwrites a MANUAL `percentComplete`. Returns per-job results JSON for the cron log.
2. `/api/cron/monday-margin-card` — `"0 14 * * 1"` (7 AM PDT Monday). Posts ONE message to `process.env.MAIN_OFFICE_CHAT_WEBHOOK` (ASSUMPTION: Justin creates the incoming webhook on the Main Office space `spaces/AAQANtlYOBY` and sets the Vercel env var). Validate with `isValidChatWebhookUrl` and reuse the fetch/timeout pattern from `src/lib/chat-webhook.ts` — extract a small `postTextToWebhook(url, text)` export there; the existing per-project daily-log poster stays untouched. One line per active job: `Berg ADU — auto 62%, manual 60% (8/25) — earned margin $12,400 — <url|adjust>` linking to `https://probuild.goldentouchremodeling.com/projects/<id>/financial-overview`; append a review flag on needsReview; jobs with a null % listed as `no % yet (estimate uncoded or no schedule)`. Env var unset/invalid -> `{sent:false, reason}` + console log, never a throw.
3. `/api/cron/dragging-line` — `"5 14 * * 1"` (staggered 5 min after the card). Bottom TWO active jobs by `earnedMargin` (null-margin jobs excluded from ranking but counted in a footer line "n jobs have no % complete yet"). For each: the single largest unattributed cost = max abs(`amount`) among that job's expenses with `costCodeId IS NULL` (show vendor, amount, date). Email to `process.env.PIPELINE_DIGEST_TO` (NEW env var — Justin's address; grep confirms it does not exist anywhere yet) via `sendNotification`, following the `sendArDigest` shape (`src/lib/billing-core.ts:183`). Env var unset -> skip with log. Never posts to Chat, never notifies a client (CLAUDE.md money-path rule).

## 7. Tests (`tests/percent-complete.test.ts`, runner `tsx --test`, added to the `test:unit` list in package.json; prisma-mocking pattern of `tests/job-variance-db.test.ts`)

Formula table cases: (a) no phases / zero coded budget -> null; (b) coded budget below 50% of total -> null (trust gate; boundary at exactly 50% -> NOT null); (c) one phase, all tasks Complete -> 100; (d) two phases with 75/25 budgets, first fully done, second untouched -> 75; (e) phase with 0 tasks + a log mention -> 0.5 progress; without a mention -> 0; (f) negative-budget phase carries 0 weight; (g) clamp and 2 dp rounding. Override cases: manual wins (recalc leaves `percentComplete` alone); drift of exactly 5.00 -> no needsReview; 5.01 -> needsReview; reset-to-auto clears it. Serialization: `computeProjectFinancials` with mocked prisma returning `Prisma.Decimal` amounts — every NEW field is `typeof "number"` or null, and `JSON.parse(JSON.stringify(result))` round-trips identically (memory: Decimal serialization on this repo). Cron route: 401 without the Bearer secret when `VERCEL_ENV` is set.

## 8. Acceptance criteria

**Technical:** `npm run build` 0 errors; `npm run test:unit` green including the new file; `scripts/apply-percent-complete.mjs` runs twice against a dev DB without error (idempotence proof); CI `migrations` job green (`scripts/check-migrations-match.mjs`); Codex peer review on the money-math diff (project-financials + percent-complete + actions) per CLAUDE.md before merge.

**VISUAL (deployed preview; consumed verbatim by gauntlet-verify):**
1. `/projects/<Shop-id>/financial-overview` shows a "Percent Complete" card with a percentage (or an em dash), an Auto or Manual badge, and — for an ADMIN session — a visible number input with Save and "Use auto" buttons.
2. After typing 60 and saving, the card shows "60%" with a "Manual" badge plus the editor's name and date; reloading the page keeps 60%.
3. `/reports/company-financials` shows an "Earned Margin" tile and a "Receipt Completeness" tile, and the jobs table has "% Compl." and "Earned Margin" column headers; a job with no percent complete shows an em dash in both new columns, not 0.
4. The five existing tiles (Total Incoming, Total Job Costs, Overhead (Shop), Net Position, Blended Margin) still render with unchanged values for the same data.
5. A FIELD_CREW-role session sees the Percent Complete card WITHOUT any input or buttons (read-only).

## 9. Risks / open questions (max 5)

1. **Cold-start truth:** a prod survey (memory, Aug 2026) found 307/307 schedule tasks "Not Started" — auto will read near 0% on most jobs until task statuses are maintained and the nightly log ingest is re-enabled (ops step, Justin). The phase gate ("Richard adjusts at least once and the number sticks") absorbs this, but the first Monday card may look silly. Mitigation: the trust gate keeps uncoded jobs off the card as numbers.
2. **Mixed tax bases in `contractValue`** (estimate totals tax-inclusive, approved CO totals pre-tax) slightly misstate earned revenue on jobs with COs. Accepted approximation, documented in code; fixing it properly means recomputing CO tax per the `co-totalamount-pretax` rule.
3. **Two new env vars are human steps:** `MAIN_OFFICE_CHAT_WEBHOOK` (Justin creates the webhook in Main Office) and `PIPELINE_DIGEST_TO`. Both crons fail soft (logged skip) until set — detectable in cron logs, not an error page.
4. **Per-job `loadProjectVariance` in the nightly cron** runs one-project-at-a-time queries (~6 queries/job across ~6 active jobs) — fine at GTR scale, but it must NEVER be called from page render paths; pages read the stored columns only.
5. **OPEN (one constant, decide any time):** the 0.5 progress convention for a task-less phase with a daily-log mention is coarse. Executor ships 0.5 in `percent-complete.ts` unless Justin picks a different convention; it is a single named constant with a test.
