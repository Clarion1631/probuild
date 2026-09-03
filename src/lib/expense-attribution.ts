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
import { lockAttributionParents } from "./phase-invariant";

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

/** The two ways a row can know its phase, and who decided the first one. */
export interface ExpenseCostCodeFacts {
    costCodeId: string | null;
    itemId: string | null;
    /**
     * `manual-none` here means a person cleared the phase, which is a decision
     * ABOUT THE ROW and not merely an empty column — see
     * `resolveActualCostCodeId`.
     */
    costCodeSource?: string | null;
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
        expense.costCodeSource ?? null,
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
    costCodeSource?: string | null,
): string | null {
    if (explicitCostCodeId) return explicitCostCodeId;
    // "CLEAR THE PHASE" HAS TO CLEAR THE RESOLVED PHASE (round 42, item 2).
    //
    // A bookkeeper who clears the phase leaves `costCodeId: null` with
    // `costCodeSource: "manual-none"` — a decision, which every automated pass
    // is then forbidden to overwrite. But the ROW usually still carries the
    // `itemId` it was linked to, and this fallback happily read that item's
    // code instead: the variance report, the margin digest and the backfill's
    // coverage table all went on charging the phase the person had just
    // removed. The clear held in the column and did nothing anywhere it
    // mattered.
    //
    // `manual-none` therefore suppresses the fallback. The item LINK is kept on
    // purpose — it is real history, it is what billing and the estimate view
    // read, and dropping it would lose the connection between the spend and the
    // line it was bought for — but it no longer IMPLIES a phase, because a
    // person has said there is none.
    //
    // Only `manual-none`. A null source is "nobody has spoken", which is the
    // legacy majority and exactly the case the fallback exists for.
    if (costCodeSource === "manual-none") return null;
    return linkedItemCostCodeId ?? null;
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
            // NO ESTIMATE AT ALL (round 43, item 3). `{ estimate: { ... } }` is
            // a filter on a RELATED ROW: Prisma compiles it to an EXISTS, so it
            // requires an estimate to be there. A row with `estimateId: null`
            // matches no branch below and fell out of every caller — and
            // `ON DELETE SET NULL` (round 42, item 4b) creates exactly that
            // shape the moment an estimate is deleted. The tax report then
            // dropped a qualifying receipt silently, which is the one direction
            // an excise deduction must never fail in.
            { AND: [{ projectId: null }, { estimateId: null }] },
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
 * THE PRE-TAX REMAINDER A DEDUCTION BASE MUST FIT INSIDE, SIGNED.
 *
 * Stated exactly as `Expense_taxDeductibleBase_check` states it —
 * `amount - COALESCE(taxAmount, 0)` — rather than as `|amount| - |tax|`. The
 * two agree while the tax CHECK holds (same sign, smaller magnitude), and the
 * database's version is the one that actually refuses a write, so it is the
 * one worth mirroring.
 */
export function deductionCeiling(amount: number, taxAmount: number | null | undefined): number {
    return Math.round((amount - (taxAmount ?? 0)) * 100) / 100;
}

/**
 * DOES THIS DEDUCTION BASE FIT THIS ROW? ONE DEFINITION, SIGNED
 * (Codex round 40, item 2).
 *
 * Money on an Expense is SIGNED throughout Phase 3: a refund or a vendor
 * credit is a negative gross, its tax comes back with it, and the portion that
 * was resold is negative too. Three places checked that and a fourth did not:
 * the PUT's fast-fail compared `base > ceiling` UNSIGNED, so a perfectly valid
 * credit (amount -50, tax -4, base -40) failed `-40 > -46` and the route
 * answered 400 to a request that merely edited the vendor. The row it refused
 * to touch satisfies every other check in the system, including the database's
 * own CHECK, which is how a legitimate credit became permanently uneditable.
 *
 * The rule, mirroring `Expense_taxDeductibleBase_check` clause for clause:
 *   * NULL and 0 always fit -- there is nothing to violate;
 *   * otherwise the base points the same way as the AMOUNT (not the ceiling:
 *     a zero ceiling has sign 0 and would reject every base), and
 *   * its magnitude fits inside the pre-tax remainder's magnitude.
 *
 * Non-finite inputs never fit: a NaN comparison is false in both directions,
 * which is the one way an invariant can silently answer "fine".
 */
export function taxDeductibleBaseFits(
    base: number | null | undefined,
    amount: number,
    taxAmount: number | null | undefined,
): boolean {
    if (base === null || base === undefined || base === 0) return true;
    if (!Number.isFinite(base) || !Number.isFinite(amount)) return false;
    if (taxAmount !== null && taxAmount !== undefined && !Number.isFinite(taxAmount)) return false;
    const ceiling = deductionCeiling(amount, taxAmount);
    if (!Number.isFinite(ceiling)) return false;
    if (Math.sign(base) !== Math.sign(amount)) return false;
    return Math.abs(base) <= Math.abs(ceiling);
}

/** The tri-state a person can answer the installation question with. */
export type InstalledAnswer = boolean | null;

/** What a request said about acknowledging a tax review. */
export type TaxReviewAck =
    /** The key was absent. Not a review; the flag stands. */
    | { kind: "absent" }
    /** `taxReviewAck: false` — an explicit "I am not certifying anything". */
    | { kind: "declined" }
    /**
     * The PATCH's form: a bare `true`, certifying the figures carried in the
     * SAME request. `installedAtCustomer` is read off the body beside it,
     * because this route may write it.
     */
    | { kind: "flag" }
    /**
     * The PUT's form: an object naming the figures ALREADY on the row and the
     * total they were reviewed against. That route may not write the tax
     * columns, so its ack has to describe the row rather than replace it.
     */
    | {
        kind: "figures";
        amount: number;
        taxAmount: number | null;
        taxDeductibleBase: number | null;
        installedAtCustomer: InstalledAnswer;
    }
    | { kind: "invalid" };

export const TAX_REVIEW_ACK_MALFORMED_MESSAGE =
    "taxReviewAck must be true/false, or an object carrying amount, taxAmount, taxDeductibleBase and installedAtCustomer — the figures reviewed, and the total they were reviewed against.";

/**
 * THE ONE READING OF `taxReviewAck` (Codex round 43, item 1).
 *
 * Two shapes, because the two handlers can do different things and an ack has
 * to mean the same thing in both: "a person has re-checked THIS receipt's
 * whole tax classification".
 *
 *   * The PATCH writes the tax columns, so its ack is a bare `true` and the
 *     answers travel beside it in the same body.
 *   * The PUT may not write them, so its ack has to NAME them — the figures on
 *     the row and the gross they were judged against — and they are compared
 *     under the lock.
 *
 * What the two must never disagree about is COMPLETENESS, and they did:
 * `installedAtCustomer` was required in the PUT's object and optional in the
 * PATCH's, so a flagged row whose stored answer was already `true` could have
 * its review cleared by a request that never mentioned it. The tax report reads
 * exactly `installedAtCustomer: true` + `needsTaxReview: false`, so the receipt
 * was re-admitted to the excise return on an eligibility nobody re-checked.
 * `taxReviewAckIsComplete` is now the single answer to "is this enough to clear
 * a flag?", and both callers ask it.
 *
 * Anything that is neither shape is INVALID rather than ignored: ignoring it
 * looks exactly like a successful certification to the caller.
 */
export function parseTaxReviewAck(body: unknown, key = "taxReviewAck"): TaxReviewAck {
    if (!body || typeof body !== "object") return { kind: "absent" };
    if (!Object.prototype.hasOwnProperty.call(body, key)) return { kind: "absent" };
    const value = (body as Record<string, unknown>)[key];
    if (value === true) return { kind: "flag" };
    if (value === false) return { kind: "declined" };
    if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "invalid" };

    const ack = value as Record<string, unknown>;
    const finite = (input: unknown) => typeof input === "number" && Number.isFinite(input);
    const finiteOrNull = (input: unknown) => input === null || finite(input);
    const shaped =
        finite(ack.amount) &&
        finiteOrNull(ack.taxAmount) &&
        finiteOrNull(ack.taxDeductibleBase) &&
        (ack.installedAtCustomer === null || typeof ack.installedAtCustomer === "boolean");
    if (!shaped) return { kind: "invalid" };
    return {
        kind: "figures",
        amount: ack.amount as number,
        taxAmount: ack.taxAmount === null ? null : (ack.taxAmount as number),
        taxDeductibleBase:
            ack.taxDeductibleBase === null ? null : (ack.taxDeductibleBase as number),
        installedAtCustomer: (ack.installedAtCustomer as InstalledAnswer) ?? null,
    };
}

/**
 * Does this acknowledgement name every part of the classification it is
 * clearing?
 *
 * The flag means the WHOLE classification is in doubt, so certifying some of it
 * while staying silent about the rest is the half-answer the flag exists to
 * prevent. Three parts, and `installedAtCustomer` is not the optional one it
 * was treated as: it is the single field the excise report keys on, so an
 * omission there preserves a stored `true` and re-admits the receipt.
 *
 * A `null` installation answer IS an answer — "I do not know whether this was
 * resold" — and the report reads it as not deductible, which is the safe
 * direction. What is refused is SILENCE.
 */
export function taxReviewAckIsComplete(named: {
    taxAmount: boolean;
    taxDeductibleBase: boolean;
    installedAtCustomer: boolean;
}): boolean {
    return named.taxAmount && named.taxDeductibleBase && named.installedAtCustomer;
}

/** The columns a tax re-validation may clear, exactly as they are written. */
export interface TaxRevalidationClears {
    taxAmount?: null;
    taxAtSource?: false;
    installedAtCustomer?: null;
    taxDeductibleBase?: null;
    taxDeductibleBaseSource?: null;
    taxSource?: null;
}

export interface TaxRevalidationPlan {
    /** Columns to write alongside the new gross. Empty when nothing broke. */
    clears: TaxRevalidationClears;
    /** True when a person has to look at this row again. */
    needsTaxReview: boolean;
    /** WHICH rule fired. `null` means the classification survived intact. */
    reason: "tax-cannot-fit" | "base-cannot-fit" | "gross-moved" | null;
}

/**
 * A NEW GROSS, JUDGED AGAINST THE TAX FIGURES THE ROW ALREADY CARRIES
 * (Codex round 41, item 2).
 *
 * Three writers move `Expense.amount` and all three have to answer the same
 * question: do the tax figures still describe this receipt? The QBO sync
 * answered it (`planQboExpenseUpdate`), the rollout trigger transcribes that
 * answer, and the expense PUT — the ONE handler a person uses to correct a
 * total by hand — only ever raised `needsTaxReview`. It never handled a tax
 * that the new gross cannot carry, so editing a $207.74 receipt with $16.55 of
 * tax down to 0, to -5, or to any positive amount under $16.55 produced a row
 * that violates `Expense_taxAmount_check`; Postgres refused the UPDATE and the
 * handler's generic catch turned it into a 500. The unit tests missed it
 * because the fake `updateMany` enforces no CHECK constraints, and production
 * missed it because the compatibility trigger was silently repairing the row —
 * until `--post-deploy` drops it.
 *
 * The policy is the conservative one already agreed everywhere else: a figure
 * that cannot be true is CLEARED, together with the provenance that described
 * it, and the row is flagged. NOTHING IS EVER INVENTED — a guessed-down tax is
 * still a guess on a tax return.
 *
 *   1. The recorded tax cannot fit the new gross (wrong direction, or larger):
 *      every tax answer on the row goes, including `installedAtCustomer` and
 *      both provenances, and the row is flagged.
 *   2. The tax fits but the hand allocation no longer does: only the allocation
 *      and its provenance go. Clearing it silently would leave a row that still
 *      reads as a deduction of the WHOLE pre-tax total, which is MORE than the
 *      person allocated, so the flag is what keeps the report honest.
 *   3. Neither breaks, but the gross MOVED on a classified row: nothing is
 *      cleared (the figures may well still be right) and the row is flagged.
 *
 * `taxAtSource` is re-derived rather than assumed: it is defined as
 * `taxAmount IS NOT NULL AND taxAmount <> 0`, so clearing the tax must clear it
 * in the same statement or `Expense_taxAtSource_check` refuses the write.
 *
 * `costCodeSource` is deliberately untouched: which PHASE the money is on is a
 * separate question the gross does not bear on.
 */
export function planTaxRevalidation(
    row: TaxClassificationFacts & { taxAmount: number | null; taxDeductibleBase: number | null },
    nextAmount: number,
    options: { grossMoved: boolean },
): TaxRevalidationPlan {
    const tax = row.taxAmount;
    const base = row.taxDeductibleBase;

    // 1. The tax itself, against `Expense_taxAmount_check`: same direction as
    //    the money, never larger in magnitude.
    const taxCannotFitGross =
        tax !== null &&
        tax !== 0 &&
        (!Number.isFinite(nextAmount) ||
            Math.sign(tax) !== Math.sign(nextAmount) ||
            Math.abs(tax) > Math.abs(nextAmount));
    if (taxCannotFitGross) {
        return {
            clears: {
                taxAmount: null,
                taxAtSource: false,
                installedAtCustomer: null,
                taxDeductibleBase: null,
                taxDeductibleBaseSource: null,
                taxSource: null,
            },
            needsTaxReview: true,
            reason: "tax-cannot-fit",
        };
    }

    // 2. The allocation, against `Expense_taxDeductibleBase_check` — the same
    //    shared helper every other caller of that rule uses.
    if (!taxDeductibleBaseFits(base, nextAmount, tax)) {
        return {
            clears: { taxDeductibleBase: null, taxDeductibleBaseSource: null },
            needsTaxReview: true,
            reason: "base-cannot-fit",
        };
    }

    // 3. Nothing broke, but a classified row's gross moved.
    if (options.grossMoved && hasTaxClassification(row)) {
        return { clears: {}, needsTaxReview: true, reason: "gross-moved" };
    }
    return { clears: {}, needsTaxReview: false, reason: null };
}

/**
 * WHAT A REQUEST SAID ABOUT `costCodeId`, PARSED ONCE (Codex round 40, item 3).
 *
 * Three handlers read this key and all three read it differently. The PUT
 * collapsed every non-string to `null` and then wrote
 * `costCodeId: null, costCodeSource: "manual-none"` -- so a malformed payload
 * like `{ costCodeId: { id: "cc-1" } }` did not fail, it CLEARED the phase and
 * stamped it as a person's deliberate decision, which every automated pass is
 * then forbidden to repair. The POST treated the same shape as if the key had
 * never been sent, silently dropping an attribution the caller believed it had
 * supplied. Only the PATCH refused it.
 *
 * Four outcomes, and the distinction that matters is between the last two:
 *   * `untouched` -- the key is absent. Leave the column alone.
 *   * `clear` -- an explicit `null` (or an empty/whitespace string, which every
 *     one of these handlers has always treated as "none"). A person choosing
 *     no phase, recorded as `manual-none`.
 *   * `set` -- a non-empty string, trimmed.
 *   * `invalid` -- anything else. A 400, never a silent clear and never a
 *     silent omission.
 */
export type CostCodeIdEdit =
    | { kind: "untouched" }
    | { kind: "clear" }
    | { kind: "set"; costCodeId: string }
    | { kind: "invalid" };

export const COST_CODE_ID_INVALID_MESSAGE = "costCodeId must be a string, or null.";

export function parseCostCodeIdEdit(body: unknown, key = "costCodeId"): CostCodeIdEdit {
    if (!body || typeof body !== "object") return { kind: "untouched" };
    if (!Object.prototype.hasOwnProperty.call(body, key)) return { kind: "untouched" };
    const value = (body as Record<string, unknown>)[key];
    if (value === null) return { kind: "clear" };
    if (typeof value !== "string") return { kind: "invalid" };
    const trimmed = value.trim();
    return trimmed ? { kind: "set", costCodeId: trimmed } : { kind: "clear" };
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
 * THE ONE DEFINITION OF "SOMEBODY HAS ANSWERED THE TAX QUESTION ON THIS ROW"
 * (round 38, item 3).
 *
 * Three writers ask it and all three used to answer it differently:
 *
 *   * `planExpenseUpdate` (the QBO sync) counted a tax amount, a deduction
 *     base, an `installedAtCustomer` decision, or a HUMAN `taxSource`;
 *   * the expense PUT counted a tax amount, a base, or EITHER provenance —
 *     and omitted `installedAtCustomer` entirely, and did not even select it
 *     under the lock. So a row whose only classification was a bookkeeper's
 *     "yes, this was installed at the customer" had its gross edited with no
 *     `needsTaxReview` at all, while the sync and the rollout trigger both
 *     treat that row as classified. The excise report then reads a
 *     deduction certified against a total that no longer exists;
 *   * the rollout compatibility trigger transcribes the sync's version.
 *
 * A disagreement between them is not a style problem: whichever one is
 * narrowest decides which stale deductions reach a state filing.
 *
 * So there is one rule, and it reads the two KINDS of column differently
 * because they mean different things:
 *
 *   * A FIGURE — a tax amount, a deduction base, an installed-at-customer
 *     answer — counts whenever it is present at all. Who supplied it does not
 *     matter: a gross that moves underneath it makes it describe a purchase
 *     that no longer exists either way. `installedAtCustomer` is a tri-state
 *     and `null` is the "nobody has said" one, so it is compared against null
 *     and never for truthiness: an explicit FALSE is a person's answer exactly
 *     as much as an explicit TRUE, and it is the answer that keeps a receipt
 *     OUT of a filing.
 *   * A PROVENANCE counts only when it is a HUMAN one. `taxSource: "manual-none"`
 *     — a bookkeeper who looked and said this receipt carries no tax — leaves
 *     every figure NULL, so without this clause the single most reviewable row
 *     in the table would be the one row nothing ever asked about. A machine
 *     provenance is deliberately NOT a classification: an "ocr" source with no
 *     surviving figure is a guess with nothing left to invalidate, and flagging
 *     those would bury the rows a person actually needs to look at.
 */
export const TAX_CLASSIFICATION_FIGURE_COLUMNS = [
    "taxAmount",
    "taxDeductibleBase",
    "installedAtCustomer",
] as const;

/** Provenance columns: a HUMAN value here is itself an answer. See above. */
export const TAX_CLASSIFICATION_SOURCE_COLUMNS = [
    "taxSource",
    "taxDeductibleBaseSource",
] as const;

/** Every column the rule reads, figures first — the order the trigger states them in. */
export const TAX_CLASSIFICATION_COLUMNS = [
    ...TAX_CLASSIFICATION_FIGURE_COLUMNS,
    ...TAX_CLASSIFICATION_SOURCE_COLUMNS,
] as const;

/** The row facts `hasTaxClassification` reads. Decimals may arrive as anything. */
export interface TaxClassificationFacts {
    taxAmount?: unknown;
    taxDeductibleBase?: unknown;
    installedAtCustomer?: boolean | null;
    taxSource?: string | null;
    taxDeductibleBaseSource?: string | null;
}

/**
 * Has ANY tax answer been recorded on this row? See
 * `TAX_CLASSIFICATION_COLUMNS` for why this has exactly one definition.
 *
 * Callers pass the row as it is at the moment the decision is made ABOUT — for
 * a write that moves the gross, that is the row BEFORE the write, because the
 * question is whether a classification is being invalidated, not whether one
 * is being supplied.
 */
export function hasTaxClassification(row: TaxClassificationFacts): boolean {
    const read = (column: string) => (row as Record<string, unknown>)[column];
    if (TAX_CLASSIFICATION_FIGURE_COLUMNS.some(column => {
        const value = read(column);
        return value !== null && value !== undefined;
    })) {
        return true;
    }
    return TAX_CLASSIFICATION_SOURCE_COLUMNS.some(column =>
        (HUMAN_TAX_SOURCES as readonly string[]).includes(String(read(column) ?? "")),
    );
}

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
    expense: { projectId: string | null; estimateId: string | null },
): Promise<string | null> {
    if (expense.projectId) return expense.projectId;
    // NO ESTIMATE LEFT TO ASK (round 42, item 4b). `Expense.estimateId` is
    // nullable now and SET NULL on delete, so a row whose estimate is gone
    // answers through its own `projectId` or not at all — there is nothing to
    // lock and nothing to re-read.
    if (!expense.estimateId) return null;
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
/**
 * WHICH JOB IS THIS ESTIMATE ON — ASKED WITHOUT TAKING ANY LOCK (round 38,
 * item 1).
 *
 * A plain `SELECT`, deliberately with no `FOR SHARE`/`FOR UPDATE` clause, so
 * it may run BEFORE the canonical acquisition without contributing to it.
 *
 * It exists because of the implicit lock nobody writes down: an INSERT or
 * UPDATE that sets `Expense.projectId` makes Postgres take `FOR KEY SHARE` on
 * the referenced `Project` row to enforce the foreign key, and `FOR KEY SHARE`
 * conflicts with the `FOR UPDATE` a Project-first job editor holds. So a
 * transaction that share-locks an Estimate and only then writes `projectId` is
 * `Estimate -> Project` even though its source never names `"Project"`.
 *
 * The fix is to lock the project explicitly first, which needs its id first —
 * and reading it under a lock would be the very inversion being fixed. This
 * read is therefore an UNVERIFIED candidate: the caller passes it to
 * `lockAttributionParents`, re-reads the estimate under the lock that call
 * takes, and REFUSES if the two disagree. A disagreement means the estimate
 * moved in the microseconds between, and the row it would write belongs to a
 * job whose `Project` row this transaction is not holding.
 */
export async function peekEstimateProjectId(
    tx: ExpenseTxClient,
    estimateId: string,
): Promise<string | null> {
    const rows = (await tx.$queryRawUnsafe(
        `SELECT "projectId" FROM "Estimate" WHERE id = $1`,
        estimateId,
    )) as { projectId: string | null }[];
    return rows?.[0]?.projectId ?? null;
}

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

/** What a re-attribution did, or why it did nothing. */
export type ReattributionOutcome =
    | { moved: true; projectId: string; estimateId: string | null }
    | {
        moved: false;
        /**
         * "target-moved": the target job's estimate changed between the
         * lock-free peek and the re-read under lock, so the row this write
         * would derive from is one the lock set does not cover. A 409 for a
         * caller; the next attempt re-peeks against the truth.
         *
         * "source-moved": the job the expense is LEAVING changed under the
         * same peek. For a fallback-attributed row the job lives on the
         * estimate, so it can move without either of the expense's own columns
         * changing — the CAS would happily succeed on behalf of a caller
         * authorized against a job the row no longer belongs to.
         */
        reason:
            | "no-such-expense"
            | "already-there"
            | "lost-the-race"
            | "source-moved"
            | "target-moved";
    };

/** The transaction-client subset `reattributeExpense` needs. */
export interface ReattributeTxClient extends ExpenseTxClient {
    expense: {
        findUnique(args: {
            where: { id: string };
            select: Record<string, unknown>;
        }): Promise<{ projectId: string | null; estimateId: string | null } | null>;
        updateMany(args: {
            where: Record<string, unknown>;
            data: Record<string, unknown>;
        }): Promise<{ count: number }>;
    };
    estimate: {
        findFirst(args: {
            where: Record<string, unknown>;
            orderBy?: Record<string, unknown>;
            select: Record<string, unknown>;
        }): Promise<{ id: string } | null>;
    };
}

/**
 * MOVE AN EXPENSE TO ANOTHER JOB — BOTH HALVES, OR NEITHER
 * (Codex round 42, item 4a).
 *
 * `projectId` and `estimateId` are the same fact said twice: the job is the
 * answer, the estimate is where it came from. The migration's own note used to
 * say a human re-attribution deliberately KEEPS the estimate of the job it
 * left, and that is not a defensible resting state — it is the split-job row
 * this whole phase exists to prevent, entered on purpose. Every reader that
 * trusts the estimate (billing, the estimate view, `job-variance`'s
 * attribution-only pool) then reports the OLD job while `resolveExpenseProjectId`
 * reports the new one, and until round 42 the old estimate could also DELETE
 * the row outright.
 *
 * So there is one way to do it, and it moves both:
 *
 *   * `lockAttributionParents` first, in the canonical order, for BOTH the job
 *     the row is leaving and the job it is joining — the target's Project row
 *     is what the new `estimateId`'s foreign key will touch, and the source's
 *     is what the current one holds.
 *   * the target estimate is RESOLVED, not supplied: the caller names a job,
 *     and this picks that job's most recent eligible estimate. When the job has
 *     none, `estimateId` becomes NULL rather than staying on the old job's —
 *     which is exactly the shape `Expense.estimateId` now supports (round 42,
 *     item 4b) and which `resolveExpenseProjectId` answers from `projectId`.
 *   * the write is a compare-and-set on the attribution it was decided from, so
 *     a concurrent move loses rather than interleaving.
 *
 * NO CALLER TODAY. Stated plainly because it matters: no handler currently
 * offers re-attribution — the PUT and PATCH allowlists do not accept
 * `projectId`, and the QBO suggester, the receipt approve and the backfill all
 * write a phase or a first attribution rather than moving one. This exists so
 * the path that gets built next is the correct one rather than the obvious one,
 * and `tests/attribution-lock-order.test.ts` fails any write that moves
 * `projectId` on an already-attributed row without moving `estimateId` with it.
 */
export async function reattributeExpense(
    tx: ReattributeTxClient,
    input: {
        expenseId: string;
        toProjectId: string;
        /** Which estimate statuses may carry the money. Caller's policy. */
        eligibleEstimateStatuses?: readonly string[];
    },
): Promise<ReattributionOutcome> {
    const before = await tx.expense.findUnique({
        where: { id: input.expenseId },
        select: { projectId: true, estimateId: true },
    });
    if (!before) return { moved: false, reason: "no-such-expense" };
    if (before.projectId === input.toProjectId) return { moved: false, reason: "already-there" };

    // PEEK FIRST, LOCK ONCE, THEN RE-READ (round 43, item 2).
    //
    // Everything the lock set depends on is resolved WITHOUT taking a lock, so
    // the acquisition below can be a single pass in the global table order.
    // Two things have to be known before it:
    //
    //   * the job the row is LEAVING. A fallback-attributed row (no
    //     `projectId` of its own) answers through its estimate, and reading
    //     that under a lock would mean locking the estimate before the
    //     project — the inversion this helper exists to avoid.
    //   * the estimate it is JOINING. Picking it after the lock would select a
    //     row the lock set never covered, so an estimate inserted in between
    //     could be chosen and moved onto while nothing held it.
    //
    // `peekEstimateProjectId` and the peeked `findFirst` take no row locks, so
    // neither contributes to the order. Both answers are re-checked under the
    // lock below and a disagreement REFUSES rather than proceeding.
    const statuses = input.eligibleEstimateStatuses;
    const targetEstimateWhere = {
        projectId: input.toProjectId,
        archivedAt: null,
        ...(statuses?.length ? { status: { in: [...statuses] } } : {}),
    };
    const fromProjectId =
        before.projectId ??
        (before.estimateId ? await peekEstimateProjectId(tx, before.estimateId) : null);
    const peekedTarget = await tx.estimate.findFirst({
        where: targetEstimateWhere,
        orderBy: { createdAt: "desc" },
        select: { id: true },
    });

    // ONE PASS, ALL TABLES: every Project row before every Estimate row before
    // every EstimateItem row, ascending id within each. Both jobs and both
    // estimates go in together — the target job because the new `estimateId`'s
    // foreign key takes FOR KEY SHARE on it, the source job because the current
    // one holds it.
    await lockAttributionParents(tx, {
        projectIds: [fromProjectId, input.toProjectId],
        estimateIds: [before.estimateId, peekedTarget?.id ?? null],
    });

    // ...AND THE PEEK IS RE-ASKED UNDER THAT LOCK. If the answer moved, the row
    // this write would land on is one the lock set does not cover: an estimate
    // created after the peek, or the chosen one archived or moved to another
    // job. Refusing is the only safe answer — proceeding would write an
    // attribution derived from an unlocked row.
    // THE SOURCE IS RE-READ TOO (round 44, item 2).
    //
    // Only the target used to be re-checked, and the source peek is the one
    // that decides WHO IS ALLOWED to do this. For a fallback-attributed row the
    // job comes from the estimate, so if that estimate moves from job A to job
    // C in the gap, the expense's own two columns do not change at all: the CAS
    // below still matches, and a caller authorized against A silently moves an
    // expense that now belongs to C. The row never looked wrong; the authority
    // did.
    const lockedFromProjectId =
        before.projectId ??
        (before.estimateId ? await peekEstimateProjectId(tx, before.estimateId) : null);
    if (lockedFromProjectId !== fromProjectId) {
        return { moved: false, reason: "source-moved" };
    }

    const lockedTarget = await tx.estimate.findFirst({
        where: targetEstimateWhere,
        orderBy: { createdAt: "desc" },
        select: { id: true },
    });
    if ((lockedTarget?.id ?? null) !== (peekedTarget?.id ?? null)) {
        return { moved: false, reason: "target-moved" };
    }

    const written = await tx.expense.updateMany({
        // The attribution this decision was MADE on, both halves. A row that
        // moved underneath matches nothing rather than being moved twice.
        where: {
            id: input.expenseId,
            projectId: before.projectId,
            estimateId: before.estimateId,
        },
        data: { projectId: input.toProjectId, estimateId: lockedTarget?.id ?? null },
    });
    if (written.count === 0) return { moved: false, reason: "lost-the-race" };
    return { moved: true, projectId: input.toProjectId, estimateId: lockedTarget?.id ?? null };
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
