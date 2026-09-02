// The ONE place that answers "which job is this expense on?" and "which phase?"
// (docs/plans/PHASE-3-ATTRIBUTION-SPEC.md §4).
//
// Before Phase 3, `Expense` had no `projectId` and every reader traversed
// `estimate.projectId` by hand — eleven separate call sites, each free to
// disagree. Now the column exists, but it is NULLABLE and backfilled, so both
// facts have to be true at once:
//
//   * a row that HAS `projectId` is answered by that column, and
//   * a row that does NOT must resolve to exactly what the old traversal
//     resolved — byte-identical outputs, or the variance and profitability
//     numbers move on a refactor that was supposed to change nothing.
//
// That contract is what makes this a mechanical swap rather than a behaviour
// change, and tests/expense-attribution.test.ts is where it is pinned down.
//
// Pure module: no I/O, no Prisma client, no clock. It builds `where` fragments
// and resolves in-memory rows; the callers own the queries.
import type { Prisma } from "@prisma/client";

/** The two ways a row can know its project. Both optional at the type level. */
export interface ExpenseProjectFacts {
    projectId: string | null;
    estimate?: { projectId: string | null } | null;
}

/**
 * The denormalized column wins.
 *
 * Deliberate, and it has a sharp edge worth naming (spec risk 2): once both
 * exist they CAN drift, and a wrong `projectId` silently beats a right
 * `estimate.projectId`. The containment is on the write side — the QBO sync
 * only ever fills a NULL, the backfill only ever fills a NULL, and every
 * capture path sets the two together — not here. A reader that "helpfully"
 * cross-checked them would just be a fourth opinion.
 */
export function resolveExpenseProjectId(expense: ExpenseProjectFacts): string | null {
    return expense.projectId ?? expense.estimate?.projectId ?? null;
}

/** The two ways a row can know its phase. */
export interface ExpenseCostCodeFacts {
    costCodeId: string | null;
    itemId: string | null;
}

/**
 * An expense's own cost code, else the code on the estimate item it is linked
 * to, else nothing.
 *
 * This is the SAME fallback `computeProjectVariance` has always implemented
 * inline (job-variance.ts `reconcileAttribution`); that function now calls this
 * one so there is a single copy. `itemCostCodeById` is the caller's item pool —
 * in the variance report that pool deliberately includes "attribution-only"
 * rows from Draft/archived estimates, because an expense's link is real even
 * when its estimate is not a budget (job-variance-db.ts).
 *
 * A missing map entry and an entry holding null are the same answer: the item
 * exists but carries no code. Both fall through to null rather than throwing —
 * an uncoded posting is a reportable fact, not an error.
 */
export function resolveExpenseCostCodeId(
    expense: ExpenseCostCodeFacts,
    itemCostCodeById: ReadonlyMap<string, string | null>,
): string | null {
    return resolveActualCostCodeId(
        expense.costCodeId,
        expense.itemId ? itemCostCodeById.get(expense.itemId) : null,
    );
}

/**
 * The same rule, one level down: an explicit code, else the linked item's, else
 * nothing. Phase 0 introduced this as `resolveActualCostCodeId` in
 * job-variance.ts while Phase 3 introduced the map-taking wrapper above, and
 * the two branches met at the rebase with one rule written twice. It lives HERE
 * — the pure module with no job-variance import — and job-variance re-exports
 * it, so margin-digest and the variance report keep their import path and there
 * is no cycle.
 */
export function resolveActualCostCodeId(
    explicitCostCodeId: string | null | undefined,
    linkedItemCostCodeId: string | null | undefined,
): string | null {
    return explicitCostCodeId ?? linkedItemCostCodeId ?? null;
}

/**
 * The `where` fragment for "every expense belonging to this project", covering
 * both shapes.
 *
 * ONE `OR` key, built in a single object literal. Never assemble this by
 * spreading two conditional `OR`s into the same object — the second silently
 * replaces the first and the query quietly widens or narrows (the
 * prisma-where-or-key-collision lesson). Callers that already have their own
 * `OR` (payouts-report, transactions-report) must nest this under `AND`
 * instead of spreading it.
 *
 * Note the second branch is `projectId: null` AND the estimate match, not just
 * the estimate match: keeping the branches disjoint means Postgres can use
 * `Expense_projectId_idx` for the first one.
 */
export function expenseForProjectWhere(projectId: string): Prisma.ExpenseWhereInput {
    return {
        OR: [
            { projectId },
            { projectId: null, estimate: { projectId } },
        ],
    };
}

/** Same, for a SET of projects — the company-wide charts read this shape. */
export function expenseForProjectsWhere(projectIds: string[]): Prisma.ExpenseWhereInput {
    return {
        OR: [
            { projectId: { in: projectIds } },
            { projectId: null, estimate: { projectId: { in: projectIds } } },
        ],
    };
}

/**
 * "This row does NOT resolve to `projectId`", written as three POSITIVE
 * branches rather than as `NOT expenseForProjectWhere(...)`.
 *
 * The negation looks equivalent and is not: SQL's `NOT (a = x OR (a IS NULL AND
 * b = x))` evaluates to NULL — and therefore excludes the row — when both
 * columns are NULL. That is exactly the fully-unattributed expense the tax
 * report shows as "(unassigned)", so the tidy form would silently drop the rows
 * a bookkeeper most needs to see.
 */
export function expenseNotOnProjectWhere(projectId: string): Prisma.ExpenseWhereInput {
    return {
        OR: [
            // Attributed directly, to some other job.
            { AND: [{ projectId: { not: null } }, { NOT: { projectId } }] },
            // Not attributed directly, and the estimate names no job either.
            { AND: [{ projectId: null }, { estimate: { projectId: null } }] },
            // Not attributed directly; the estimate names some other job.
            {
                AND: [
                    { projectId: null },
                    { estimate: { projectId: { not: null } } },
                    { NOT: { estimate: { projectId } } },
                ],
            },
        ],
    };
}

/** "This row is attributable to SOME project", either way round. */
export function expenseHasAnyProjectWhere(): Prisma.ExpenseWhereInput {
    return {
        OR: [
            { projectId: { not: null } },
            { projectId: null, estimate: { projectId: { not: null } } },
        ],
    };
}

/**
 * Cost-code sources a MACHINE produced. The complement — "capture" and
 * "manual" — is a human's answer and is never rewritten by the sync or the
 * backfill.
 */
export const HUMAN_COST_CODE_SOURCES = ["capture", "manual"] as const;

/**
 * "This row's cost code was not chosen by a human."
 *
 * Written as an explicit `OR` with a `null` branch on purpose. `{ costCodeSource:
 * { notIn: [...] } }` alone compiles to SQL `NOT IN`, and SQL says NULL NOT IN
 * (...) is NULL, not TRUE — so every legacy row (all 562 of them, source NULL)
 * would be EXCLUDED and the backfill would write nothing at all. The bug would
 * look like "the rules matched nothing", which is a plausible enough outcome to
 * go unnoticed.
 */
export function notHumanCodedExpenseWhere(): Prisma.ExpenseWhereInput {
    return {
        OR: [
            { costCodeSource: null },
            { costCodeSource: { notIn: [...HUMAN_COST_CODE_SOURCES] } },
        ],
    };
}

/**
 * NO DEFAULT. Silence means NULL, on every source, including a receipt that
 * arrived in a job folder.
 *
 * An earlier version defaulted this to TRUE for any non-overhead project, on
 * the reasoning that a job receipt is job material. That was wrong, and wrong
 * in the one direction a tax figure must never fail in: WAC 458-20-102(12)(b)
 * allows the cost of the articles actually RESOLD, and a receipt coded to a
 * live job is just as likely to be consumables, tools, fuel, dump fees, or a
 * service. Defaulting it turned "nobody looked at this" into a deduction
 * claimed on a state return.
 *
 * An explicit true/false from the caller is honoured — the crew member standing
 * in front of the material is the one person who actually knows — and a
 * bookkeeper can correct it afterwards on the expense edit route.
 */
export function resolveInstalledAtCustomer(declared: boolean | null): boolean | null {
    return declared;
}

/** The project facts a DISPLAY row needs: an id and a name, either way round. */
export interface ExpenseProjectLabel {
    projectId?: string | null;
    project?: { id?: string | null; name: string | null } | null;
    estimate?: { projectId?: string | null; project?: { id: string; name: string } | null } | null;
}

/**
 * The job to SHOW for an expense, resolved the same way the money is.
 *
 * Aggregation queries were converted first; these display paths were not, so a
 * re-attributed expense was still listed — and, in the review-alert case,
 * ROUTED — under the job it used to be on. A label that disagrees with the
 * ledger is worse than no label: it is a wrong answer that looks authoritative.
 *
 * Falls back to the estimate's project for the id AND the name together, so the
 * two can never come from different rows.
 */
export function resolveExpenseProjectLabel(
    expense: ExpenseProjectLabel,
): { projectId: string | null; projectName: string | null } {
    if (expense.projectId) {
        return {
            projectId: expense.projectId,
            // The direct relation when it was selected; otherwise the estimate's
            // name is only usable when the estimate agrees on the id.
            projectName:
                expense.project?.name ??
                (expense.estimate?.project?.id === expense.projectId
                    ? expense.estimate.project.name
                    : null),
        };
    }
    return {
        projectId: expense.estimate?.project?.id ?? expense.estimate?.projectId ?? null,
        projectName: expense.estimate?.project?.name ?? null,
    };
}


/**
 * THE ONE PLAUSIBILITY BOUND FOR A SALES-TAX FIGURE ON A RECEIPT.
 *
 * WA's combined rate tops out around 10.6%; 12% is deliberately loose so a
 * legitimate receipt is never refused, while a transposed or misread figure
 * (a $100 receipt "with" $90 of tax) cannot reach an excise return.
 *
 * It lives here because there are TWO writers of `Expense.taxAmount` and they
 * must not be able to disagree: the bookkeeper's PATCH, which refuses an
 * implausible figure outright, and the booking pipeline, which cannot refuse
 * anything (the Purchase is already in QuickBooks) and instead stores NULL and
 * flags the row for review. Same bound, different remedies.
 *
 * The rate is measured against the GROSS `Expense.amount`, which is what both
 * writers hold; on any receipt this side of the bound the difference from a
 * pre-tax basis is far smaller than the slack in the 12%.
 *
 * AMOUNTS ARE SIGNED. A refund, a return or a vendor credit is a NEGATIVE
 * expense, and the tax on it comes back too: -$50 with -$4 of tax is an
 * ordinary Lowe's return. Treating "negative" as "invalid" would have made
 * every credit unclassifiable and pushed a bookkeeper into recording it as a
 * positive, which the excise report would then ADD to the deduction instead of
 * subtracting it. So the rule is about DIRECTION and MAGNITUDE, not about
 * positivity: the tax must point the same way as the money, and it can never be
 * larger than the money.
 */
export const MAX_PLAUSIBLE_TAX_RATE = 0.12;

/**
 * The largest tax figure this receipt could plausibly carry, as a MAGNITUDE.
 * Compare it against `Math.abs(taxAmount)`; the sign is a separate rule.
 */
export function maxPlausibleTaxAmount(grossAmount: number): number {
    if (!Number.isFinite(grossAmount)) return 0;
    return Math.round(Math.abs(grossAmount) * MAX_PLAUSIBLE_TAX_RATE * 100) / 100;
}

/**
 * True when `taxAmount` is a believable amount of sales tax on `grossAmount`.
 *
 * Zero is always plausible ("this receipt had no tax"). Otherwise the tax must
 * carry the SAME SIGN as the amount — a positive tax on a refund is either a
 * dropped minus sign or a filing that claims a deduction for money that came
 * back — and its magnitude must be within the 12% band. The `<= |amount|`
 * half of the database CHECK is implied by that band and stated there too,
 * where nothing enforces the band itself.
 */
export function isPlausibleReceiptTax(taxAmount: number, grossAmount: number): boolean {
    if (!Number.isFinite(taxAmount) || !Number.isFinite(grossAmount)) return false;
    if (taxAmount === 0) return true;
    if (Math.sign(taxAmount) !== Math.sign(grossAmount)) return false;
    return Math.abs(taxAmount) <= maxPlausibleTaxAmount(grossAmount);
}
