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
import { lockMoneyParentsMany } from "./tx-retry";

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
 * Cost-code sources a MACHINE produced. The complement — "capture", "manual"
 * and "manual-none" — is a human's answer and is never rewritten by the sync
 * or the backfill.
 *
 * "manual-none" IS A DECISION, NOT AN ABSENCE (round 36, item 3). Clearing the
 * phase used to write `costCodeSource: null` alongside `costCodeId: null`, on
 * the reasoning that provenance for a null code has nothing to guard. It has
 * exactly one thing to guard: the person's answer. NULL provenance is the
 * state every automated pass reads as "machine-writable", so the QBO
 * suggester's very next run re-applied the same regex suggestion the
 * bookkeeper had just removed, and the backfill would do it again after that.
 * The clear was undone in minutes and looked like the sync had never been
 * told.
 *
 * So a human clearing the phase writes "manual-none" — the same shape and the
 * same meaning `taxSource` already uses for "a person looked and the answer is
 * nothing here" (see HUMAN_TAX_SOURCES below). A human later picking a real
 * phase overwrites it with "manual" normally; only the machines are held off.
 */
export const HUMAN_COST_CODE_SOURCES = ["capture", "manual", "manual-none"] as const;

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


/**
 * `Expense.taxSource` — WHO decided the two tax FIGURES (`taxAmount` and
 * `taxDeductibleBase`), as four explicit states rather than a boolean dressed
 * up as a string:
 *
 *   null          nobody has looked, or nobody has looked SINCE the figures
 *                 were invalidated. An automated read may fill them.
 *   "ocr"         the intake pipeline read them off the receipt. A guess, and
 *                 re-readable: a later pass or a person may replace it.
 *   "manual"      a person supplied an amount. Untouchable by any automated
 *                 pass.
 *   "manual-none" a person looked and said this receipt carries NO sales tax.
 *                 Also untouchable — and it is the state a null `taxAmount`
 *                 cannot express on its own, which is the entire reason this
 *                 column exists.
 *
 * The last two are the human states, and both must survive a booking, a
 * re-sync, and a backfill.
 */
export const HUMAN_TAX_SOURCES = ["manual", "manual-none"] as const;

/**
 * The `where` fragment for "an automated pass may write the tax figures here".
 *
 * The explicit NULL branch is not decoration: SQL `NOT IN (…)` is NULL for a
 * NULL column, so a bare `notIn` silently excludes every legacy row — which is
 * the exact opposite of the intent, since those are the rows most in need of a
 * first read.
 */
export function taxNotHumanDecidedWhere(): {
    OR: ({ taxSource: null } | { taxSource: { notIn: string[] } })[];
} {
    return {
        OR: [
            { taxSource: null },
            { taxSource: { notIn: [...HUMAN_TAX_SOURCES] } },
        ],
    };
}

/**
 * `taxAtSource` is the FACT that sales tax was charged on this receipt, and it
 * follows the figure rather than being a second thing to get wrong.
 *
 * Signed: a return carries NEGATIVE tax and the fact is just as true — the tax
 * was charged, and is now coming back. `> 0` read every credit as "no tax
 * here", which is how a refund's tax quietly left the filing.
 */
export function taxIsAtSource(taxAmount: number | null | undefined): boolean {
    if (taxAmount === null || taxAmount === undefined) return false;
    return Number.isFinite(taxAmount) && taxAmount !== 0;
}


/** The transaction-client subset the locked re-resolve needs. */
export interface ExpenseTxClient {
    $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
}

/**
 * RE-RESOLVE A FALLBACK-ATTRIBUTED EXPENSE'S JOB, UNDER LOCK.
 *
 * An expense with a `projectId` answers for itself and cannot move without a
 * write to its own row, which every mutating path already fences on. An expense
 * WITHOUT one answers through its estimate — and that estimate can be moved to
 * another project by somebody else while a request is deciding what it may do.
 *
 * The consequence is not academic: the request authorized the actor against the
 * job the estimate named when it was read, then wrote or deleted a row that now
 * belongs to a different job. The actor never had access to that one.
 *
 * So the estimate row is share-locked for the rest of the caller's transaction
 * and the project is read again from it. Callers then re-check access against
 * THIS answer and put it in the write predicate, so a row that moved in the gap
 * matches nothing instead of being written under a stale permission.
 *
 * Returns the resolved project id, or null when the estimate has none — which
 * every caller must treat as "no scope to authorize against", i.e. refuse.
 */
export async function resolveExpenseProjectUnderLock(
    tx: ExpenseTxClient,
    expense: { projectId: string | null; estimateId: string },
): Promise<string | null> {
    if (expense.projectId) return expense.projectId;
    await tx.$queryRawUnsafe(
        `SELECT id FROM "Estimate" WHERE id = $1 FOR SHARE`,
        expense.estimateId,
    );
    const rows = (await tx.$queryRawUnsafe(
        `SELECT "projectId" FROM "Estimate" WHERE id = $1`,
        expense.estimateId,
    )) as { projectId: string | null }[];
    return rows?.[0]?.projectId ?? null;
}

/**
 * The write predicate that pins a fallback-attributed row to the project the
 * caller was authorized against. For a row with its own `projectId` the column
 * is the answer; for one without, the estimate has to still point there.
 */
export function expenseStillOnProjectWhere(
    expense: { projectId: string | null },
    projectId: string,
): Record<string, unknown> {
    return expense.projectId
        ? { projectId }
        : { projectId: null, estimate: { is: { projectId } } };
}


/**
 * The attribution PAIR, re-read from a share-locked estimate.
 *
 * `projectId` and `estimateId` are the same fact said twice — the project is
 * the answer, the estimate is where it came from — so a writer that reads them
 * apart can persist a pair that never existed together. Every creator did:
 * resolve the estimate's project, do a few hundred milliseconds of other work
 * (a cost-code lookup, a QBO round trip), then insert both. An estimate moved
 * to another job in that window produced a row stamped with the OLD project and
 * the estimate that now belongs to a new one — an expense on two jobs at once,
 * which the resolver cannot reconcile and no report can be right about.
 *
 * Locking the estimate FOR SHARE holds the pair still for the rest of the
 * caller's transaction, and returning both together means the caller writes
 * what it just read rather than what it read earlier.
 *
 * `null` means the estimate has no project — no scope to attribute against, and
 * every caller must refuse rather than write half a pair.
 */
export async function lockEstimateAttribution(
    tx: ExpenseTxClient,
    estimateId: string,
): Promise<{ estimateId: string; projectId: string } | null> {
    await tx.$queryRawUnsafe(`SELECT id FROM "Estimate" WHERE id = $1 FOR SHARE`, estimateId);
    const rows = (await tx.$queryRawUnsafe(
        `SELECT "projectId" FROM "Estimate" WHERE id = $1`,
        estimateId,
    )) as { projectId: string | null }[];
    const projectId = rows?.[0]?.projectId ?? null;
    return projectId ? { estimateId, projectId } : null;
}

/** One job an estimate's expenses are already pinned to, and how many. */
export interface EstimateAttributionConflict {
    estimateId: string;
    projectId: string;
    expenses: number;
}

/**
 * The write-once pair, from the OTHER end (Codex round 32).
 *
 * `lockEstimateAttribution` stops a WRITER from persisting a stale pair. It
 * cannot stop anything from invalidating a pair that was already written
 * correctly — and moving the estimate does exactly that. `Expense.projectId` is
 * write-once; `Estimate.projectId` is not. Move an estimate from job A to job B
 * and every expense booked through it still says A, while the estimate, the
 * billing paths and the phase cascade all say B. The row is on two jobs at
 * once, which is the precise shape this whole feature exists to prevent, and no
 * variance or profitability report can be right about it.
 *
 * There are exactly two honest answers, and "silently move the expenses" is not
 * one of them: those rows carry a cost code from job A's phase list, a receipt
 * filed under job A, and possibly a QBO purchase classified for job A. Dragging
 * them across is a re-attribution, which is a deliberate operation with its own
 * rules (the documented Phase 3 follow-up), not a side effect of a lead
 * conversion. So the move is REFUSED and the operator is told what to fix.
 *
 * A NULL `Expense.projectId` is not a conflict. That row has no pinned job at
 * all — it resolves THROUGH the estimate (`resolveExpenseProjectId`), so the
 * move takes it along and is the thing that finally gives it an answer.
 *
 * A DELIBERATELY re-attributed expense also trips this, and that is accepted
 * rather than special-cased. A bookkeeper moving an expense to another job is a
 * supported operation and leaves the same shape — this check cannot tell the
 * two apart, and neither can any query. Refusing is still the right default:
 * the false refusal costs one operator one clear message naming the estimate
 * and the job, while the false acceptance silently splits a job's costs. Do not
 * "fix" it by exempting rows that look re-attributed; there is no such marker.
 *
 * The estimates are locked FOR UPDATE first, through the canonical money-path
 * helper, so the count cannot be taken and then falsified by a concurrent
 * booking before the move commits. `lockMoneyParentsMany` is used rather than a
 * hand-rolled scan precisely so this shares the Estimate → Invoice → children
 * acquisition order every other money path uses, and its ascending-id rule
 * within the table.
 */
export class EstimateAttributionPairConflictError extends Error {
    readonly targetProjectId: string;
    readonly conflicts: readonly EstimateAttributionConflict[];

    constructor(targetProjectId: string, conflicts: readonly EstimateAttributionConflict[]) {
        const total = conflicts.reduce((sum, conflict) => sum + conflict.expenses, 0);
        const detail = conflicts
            .map(conflict => `estimate ${conflict.estimateId} → job ${conflict.projectId} (${conflict.expenses})`)
            .join("; ");
        super(
            `Cannot move ${conflicts.length} estimate(s) to job ${targetProjectId}: ` +
            `${total} expense(s) are still attributed to their current job through them — ${detail}. ` +
            `Re-attribute those expenses to the new job first, then retry the move.`,
        );
        // NAME-BASED identity, deliberately. Node 20 + tsx can load this module
        // twice under different specifiers, which makes `instanceof` false for
        // an error this very file threw. Callers must use
        // `isEstimateAttributionPairConflict`.
        this.name = "EstimateAttributionPairConflictError";
        this.targetProjectId = targetProjectId;
        this.conflicts = conflicts;
    }
}

/** Identity by NAME, not `instanceof` — see the note in the constructor. */
export function isEstimateAttributionPairConflict(
    error: unknown,
): error is EstimateAttributionPairConflictError {
    return (
        error instanceof EstimateAttributionPairConflictError ||
        (error instanceof Error && error.name === "EstimateAttributionPairConflictError")
    );
}

/** The transaction-client subset the estimate-move guard needs. */
export type EstimateMoveTxClient = Prisma.TransactionClient;

/**
 * Refuse to move `estimateIds` onto `targetProjectId` while any expense booked
 * through them is still pinned to a DIFFERENT job. See
 * `EstimateAttributionPairConflictError` for why refusing is the answer.
 *
 * Call this INSIDE the transaction that performs the move, and move only the
 * ids it was given — a `where: { leadId }` re-scan can pick up an estimate this
 * never checked.
 */
export async function assertEstimateMoveKeepsAttributionPairs(
    tx: EstimateMoveTxClient,
    estimateIds: readonly string[],
    targetProjectId: string,
): Promise<void> {
    const ids = [...new Set(estimateIds)].filter(Boolean).sort();
    if (!ids.length) return;

    await lockMoneyParentsMany(tx, { estimateIds: ids });

    const conflicts = (await tx.$queryRawUnsafe(
        `SELECT e."estimateId" AS "estimateId",
                e."projectId"  AS "projectId",
                COUNT(*)::int  AS "expenses"
           FROM "Expense" e
          WHERE e."estimateId" = ANY($1::text[])
            AND e."projectId" IS NOT NULL
            AND e."projectId" <> $2
          GROUP BY e."estimateId", e."projectId"
          ORDER BY e."estimateId", e."projectId"`,
        ids,
        targetProjectId,
    )) as EstimateAttributionConflict[];

    if (conflicts?.length) {
        throw new EstimateAttributionPairConflictError(targetProjectId, conflicts);
    }
}

/**
 * Is this line item still on that estimate? Asked under the same lock, because
 * a re-parented item is how a cost code from another job reaches an expense.
 */
export async function itemBelongsToEstimateTx(
    tx: ExpenseTxClient,
    itemId: string,
    estimateId: string,
): Promise<boolean> {
    const rows = (await tx.$queryRawUnsafe(
        `SELECT id FROM "EstimateItem" WHERE id = $1 AND "estimateId" = $2 FOR SHARE`,
        itemId,
        estimateId,
    )) as unknown[];
    return Boolean(rows?.length);
}

/**
 * Is this line item on ANY estimate of that job? Asked under lock, on the
 * transaction that writes the link.
 *
 * The estimate-scoped question above is not this one. An edit path re-points an
 * expense's `itemId` and the only authority is the RESOLVED project — for a
 * re-attributed row the estimate belongs to the job it left, so scoping to the
 * estimate would admit exactly the cross-job link the check exists to stop.
 *
 * Both rows are locked, because the link can be broken from either end: the
 * item can be re-parented onto another estimate, and the estimate can be moved
 * to another job.
 */
export async function itemBelongsToProjectTx(
    tx: ExpenseTxClient,
    itemId: string,
    projectId: string,
): Promise<boolean> {
    const rows = (await tx.$queryRawUnsafe(
        `SELECT item.id
           FROM "EstimateItem" item
           JOIN "Estimate" est ON est.id = item."estimateId"
          WHERE item.id = $1 AND est."projectId" = $2
            FOR SHARE OF item, est`,
        itemId,
        projectId,
    )) as unknown[];
    return Boolean(rows?.length);
}
