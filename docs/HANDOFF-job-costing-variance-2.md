# Job Costing → Estimate-Item Variance — Session 2 Handoff

_Written 2026-08-19, continuing from `HANDOFF-job-costing-variance.md`._
_Read that one first for background; this one records what CHANGED._

## What shipped this session

| # | Item | State |
|---|---|---|
| 1 | `resolveCostCode` extracted from PR #117 | ✅ `src/lib/cost-coding.ts` + `-db.ts`, 14 tests |
| 2 | Estimate cleanup backfill | ✅ 15 items, $33,525, applied to prod, idempotency proven |
| 3 | Variance engine (labor **and materials**) | ✅ `src/lib/job-variance.ts`, 20 tests |
| 4 | `/manager/variance` rebuilt on it | ✅ visually verified against live data |
| 5 | Field audit of the crew clock-in | ✅ phases-only confirmed on the live app |

Gates: **site 430/430 unit tests, `npm run build` clean, mobile 255/255 + `tsc` 0 errors.**

---

## Two corrections to the previous handoff

### 1. It said "34 of 163 eligible items have no cost code." That number was wrong.

Of those 34:
- **17 are Section header rows.** They roll up their children's totals. Coding one
  **double-counts its entire phase** — `isEstimateSectionRow()` exists precisely to
  exclude them, and the old variance page already used it. They must stay uncoded.
- **2 are blank-name junk rows** ($0, no name). Delete candidates, not backfill targets.
- **15 were real gaps.** Those are now fixed.

Anything that re-derives this number must filter sections first, or it will
propose corrupting the estimate. `scripts/audit-uncoded-items.mjs` does it correctly.

### 2. The old `/manager/variance` page was materially misleading.

It summed **only** `timeEntry.laborCost + burdenCost` as "actual" and never queried
`Expense` at all. On a remodel, materials and subs are most of the cost — so every job
displayed a large favourable variance that was really just unmeasured spend. Anyone who
read that page believed jobs were healthier than they were. The rebuild counts both sides.

---

## The finding that matters most: coverage, not variance

Running the real engine over live prod data:

```
job                    budget      actual     variance   attributed
Berg ADU              $33,880     $39,354     -$5,474        41%
Christensen Remodel  $225,000     $11,349   +$213,651        98%
Hoppe Bathroom        $95,925     $12,758    +$83,167        56%
Mesplay Kitchen      $239,875    $167,385    +$72,490        43%
Robbins Electrical     $4,596      $2,930     +$1,666       100%
Shop                  $12,511     $71,991    -$59,480         0%
```

(Berg's budget includes its approved $4,629.63 change order — see review finding 0.
An earlier draft of this doc reported −$10,104 before that bug was found and fixed.)

**Berg ADU is genuinely over budget** (−$5,474, 116% used) — and note *why* it is legible: four phases
(`20-CLEAN`, `23-SITEWORK`, `17-CONCRETE`, `06-INSUL`) carry real spend and appear
**nowhere in the estimate**. That is a bidding gap, exactly the kind of "why" the
whole project exists to surface.

But the `attributed` column is the real headline. At 41–56% coverage, the variance
numbers are directionally useful and **not yet decision-grade**. This is why the report
now leads with a data-coverage bar instead of a number: a tidy variance computed on
half the money is not a result, and the UI must not let it look like one.

`Shop` is the overhead bucket (0% attributed by design) — it is not a job and should
probably be excluded from this report entirely.

---

## What still blocks decision-grade numbers

Ranked by dollars unlocked:

1. **`expense.itemId` is 0 / 562.** Materials are the missing half. Every material
   dollar can currently reach a *phase* at best, never a line item — which is why so
   many item rows render "⚠ at least". This is the single biggest lever.
2. **`expense.costCodeId` is 89 / 562.** 473 expenses cannot reach even a phase.
   `~/cost-code-review.csv` (140 rows, $94,937.88) is the human-review queue for this.
3. **10 legacy time entries** carry neither a cost code nor an item (all pre-dating
   phase-only clock-in, on Holloway/Mueller/Mesplay). Small dollars, easy cleanup.
4. **Optional item step in the crew app** — measured live: **51.9% of phases have
   exactly ONE item**, so half of all clock-ins would gain the item link at zero extra
   taps. Max items in any one phase is 5. This remains the right design and is NOT yet
   built.

---

## Audit results for the crew app (verified on the LIVE app, not from code)

Logged into `app.goldentouchremodeling.com` as Test Field Crew:

- ✅ Phase dropdown lists **phases only** (`01-DEMO`, `02-FRAME`, `03-PLUMB`, …).
  No estimate line items leak into it.
- ✅ The daily-log suggestion works and is honest about being a suggestion:
  "Suggested: electrical rough in → 04-ELEC" with its reasoning shown, and the crew
  can override it. Good AGENCY behaviour.
- ✅ Project list shows In Progress jobs plus Logistics.
- ✅ Every In Progress job has a working phase list (2–23 phases); none are empty,
  so no job can strand a crew member who cannot clock in.
- ✅ `32-SAFETY` is present on all 9 In Progress jobs.

### One real drift trap found (documented, not removed)

`src/app/api/mobile/projects/[id]/phases/route.ts` is **dead code** — nothing calls it.
The crew app calls `GET /api/projects/[id]/cost-codes` instead. The two use
**different rules**: the live one unions every eligible estimate and appends Safety;
the dead one picks a single canonical Approved estimate and never adds Safety.

It was left in place (an older deployed client could still call it) with a prominent
warning comment in `src/lib/phase-options.ts`. **Do not wire anything to it without
reconciling it against `project-phases.ts` first**, or the picker and the clock-in
validator will start rejecting each other's phases.

---

## Peer review (required by AGENTS.md for money-path changes)

An independent reviewer read the new code, ran the tests, and typechecked. It found
**three real bugs that the green test suite did not cover**, all now fixed with
regression tests (suite grew 20 → 25 on the variance engine):

0. **HIGH — approved CHANGE ORDERS were counted as cost but never as budget.**
   Budget came only from `EstimateItem`; approved change-order scope lives in the
   separate `ChangeOrderItem` table and was never read, while the costs for that work
   still landed on the job. **Berg ADU's overrun was overstated by $4,629.63** — it
   reads **−$5,474 (116% used)**, not −$10,104 (134%). Fixed by including
   `ChangeOrderItem` rows from **Approved** change orders only (Draft/Sent are
   proposals — prod holds $67k of those, and counting them would hide real overruns).
   `ChangeOrderItem` is flat, so there are no section rows to exclude.
1. **CRITICAL — item/phase mismatch double-counted.** When a posting carried an explicit
   `costCodeId` for phase A *and* an `estimateItemId` whose item lived under phase B, the
   money landed on **phase A's total** while crediting **an item under phase B**. That
   broke the invariant "a phase's actuals ≥ the sum of its own items' actuals" and
   silently cleared the ⚠ floor warning on an item nobody had measured.
   Fixed by `reconcileAttribution()`: the explicit code still wins for the phase, but an
   item is credited **only when it belongs to that phase**; a mismatched link is dropped
   and the cost is treated as phase-only.
2. **`attributedShare` was unbounded.** `Expense.amount` can be negative (refunds,
   credits, voids), so the total could net toward zero while the unattributed portion
   stayed large — producing shares like 1.4 or −3 and an impossible progress bar.
   Now clamped to 0..1, with `ratio()` hardened against non-finite values.
3. **`ratio()` could return a non-finite number.** Now returns `null` instead.
4. **Coverage was measured on NET dollars.** `Expense.amount` is signed, so a job with
   a $500 uncoded charge and a $500 coded refund netted to $0 and the guard reported
   **"100% attributed — Trustworthy"** on data that was 0% attributed. Coverage is now
   computed over **absolute** dollars moved.
5. **A phase with a NEGATIVE budget** (a discount/credit line under one cost code)
   silently lost both its "% used" line and its warning label. Now flagged explicitly
   as "negative budget — check the estimate" via `hasNegativeBudget`.
6. **The trust bar rounded UP.** 99.6% rendered as "100% attributed / Trustworthy"
   while hundreds of dollars were unplaced. Now `Math.floor`, so coverage can never
   flatter itself into the trustworthy band. The floor-flag float threshold is also
   `Math.abs()` now — one-sided comparison could suppress a warning that should fire.
7. **`Number(x) || 0` turned corrupt amounts into a confident $0 of spend.** Non-finite
   values are now counted into `coverage.malformedRows` and rendered as a red warning.
   (Prod currently has zero such rows — the guard is preventive.)

`scripts/variance-report.ts` was also rewritten to call the SAME loader the page uses.
It previously duplicated the queries and silently missed the change-order fix — exactly
the drift this repo has been bitten by before.

### One review recommendation was tested and DELIBERATELY REJECTED

The reviewer proposed applying `PHASE_ELIGIBLE_ESTIMATE_WHERE` to the **expense** query
so both sides use the same predicate. It was implemented, then reverted after checking
prod:

```
EXPENSES ON INELIGIBLE (Draft) ESTIMATES: 320 rows, $84,741.62
   Hoppe Bathroom Remodel [Draft]: $12,757.73   <- 100% of that job's spend
   Shop [Draft]:                   $71,983.89
```

Applying the filter would have hidden **all** of Hoppe's spend and made the job look
perfectly on budget — the precise failure mode this rebuild exists to eliminate.

**The asymmetry is intentional and is now documented in the code:** an estimate's status
governs what we *promised* (budget), never what we *paid* (actual). A cost is real the
moment it leaves the bank. Spend with no matching budget surfaces honestly as an
"unbudgeted phase" or in the unattributed bucket rather than being dropped.

## Second peer review — Kimi 3 (K3), POST-DEPLOY

Run after the code was already live, via the newly-installed Kimi CLI
(`kimi -m kimi-code/k3 -p ...`). It independently ran the suite (45/45) and
typecheck (clean), then found **three more issues the first review missed** —
two of them regressions introduced BY the first round of fixes:

1. **The `Math.abs()` floor-flag fix over-fired.** Round one changed
   `unassigned > 0.005` to `Math.abs(unassigned) > 0.005` to catch float residue
   in both directions. But a NEGATIVE remainder means the items account for MORE
   than the phase nets (item-linked refunds exceeding phase-level spend) — they
   are fully attributed, and flagging them warns about unmeasured money that does
   not exist. Reverted to a positive-only test, with the sign logic explained.
2. **The trust bar could contradict itself.** `unattributedTotal` is NET while
   `attributedShare` is ABSOLUTE, so a $1,000 uncoded charge plus a $1,000
   uncoded refund rendered "$0 spent with no phase" directly beside "0%
   attributed" — both true, flatly contradictory. Added
   `coverage.unattributedGross`; the UI shows it whenever netting hides activity.
3. **Item links on ineligible estimates were discarded** (latent). The expense
   query deliberately counts spend on Draft estimates, but the item pool was
   built only from BUDGET rows, so an expense carrying an `itemId` into a Draft
   estimate's coded item lost its link and inflated "unattributed". Harmless
   today (prod: 0/562 expenses carry an itemId; 1 time entry affected) but it
   goes live the moment material item-coding starts — which is the next task.
   Fixed with an attribution-only item pool carrying `total: 0` (no budget).

### The one finding Kimi said to check before trusting these numbers — CHECKED, CLEAR

`ChangeOrderItem` has **no provenance column** (no `sourceEstimateItemId`), so
nothing structurally stops a CO generated *from* estimate lines from duplicating
scope the estimate already budgets — which would inflate the budget and hide a
real overrun. Verified against prod: both approved COs are genuinely additional
scope with no same-named estimate line —

```
Berg ADU  "Deposit for Added Items"  $4,629.63   no matching estimate line
Shop      "Added items"              $1,000.00   no matching estimate line
```

So **Berg's −$5,474 stands**. The risk is documented in `job-variance-db.ts`;
re-check it if change orders ever start being generated from estimate rows.

Kimi's verdict on the deliberate expense-filter asymmetry: **defensible**, same
conclusion reached independently. It also flagged that `Shop` is an overhead
bucket rather than a job, and its −$59,480 / 0%-attributed row is "the largest,
least actionable number on the page" — worth excluding from this report.

---

### Known, accepted

`Mesplay Kitchen`, `Hoppe`, and `Shop` each have **two eligible estimates**. Their items
are unioned into one budget, which is correct today (the second estimate is a change
order or revision carrying its own items). If a revision ever *duplicates* an original's
items rather than replacing them, that budget would double-count. Worth a guard when
estimate revisions get formalised.

---

## New files

| File | Purpose |
|---|---|
| `src/lib/cost-coding.ts` | The gate: resolve a cost code or REJECT. DI-testable. |
| `src/lib/cost-coding-db.ts` | Its Prisma adapter. |
| `src/lib/job-variance.ts` | Variance rules (budget/actual/coverage). Pure. |
| `src/lib/job-variance-db.ts` | Loads prod data into the engine. |
| `tests/cost-coding.test.ts` | 14 tests |
| `tests/job-variance.test.ts` | 20 tests |
| `scripts/audit-job-costing.mjs` | READ-ONLY field-readiness audit |
| `scripts/audit-uncoded-items.mjs` | READ-ONLY true-gap finder (excludes sections) |
| `scripts/backfill-estimate-item-cost-codes.mjs` | The applied backfill (dry-run default) |
| `scripts/variance-report.ts` | Runs the engine against prod, prints to console |
| `scripts/set-test-crew-pin.mjs` | Sets a QA PIN on the existing test crew user |

`resolveCostCode` is deliberately **not yet wired into a route** — `/api/time-entries`
already validates phases correctly via `isCostCodeAllowedForProject`, and changing the
live clock-in path is a separate, riskier change than adding the report. It is ready for
the expense side and for the optional item step.

## PR #117

Everything worth salvaging is now extracted. **#117 can be closed.**

## Hard rules (unchanged — see CLAUDE.md / AGENTS.md)

- `main` auto-deploys. Batch into ONE push.
- No `prisma db push` / `migrate dev` (IPv6-only `DIRECT_URL`).
- `DATABASE_URL` needs `?pgbouncer=true`.
- Never pass `--token` to the vercel CLI.
- Scripts must load `.env.local` themselves.
