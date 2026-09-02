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
    if (expense.costCodeId) return expense.costCodeId;
    if (!expense.itemId) return null;
    return itemCostCodeById.get(expense.itemId) ?? null;
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
