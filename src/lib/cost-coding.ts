// Cost-code attribution for anything that posts to the job ledger — a time
// entry OR an expense.
//
// Salvaged from PR #117 (`feat/job-costing-gates`), which is CONFLICTING and
// will not be merged: 49 of its 85 files already exist on `main` in some form,
// and it rewrites `api/time-entries/route.ts` + `lib/time-expense-actions.ts`,
// which the 2026-08 phase-only clock-in work replaced. Only this file's rule
// was worth keeping. See docs/HANDOFF-job-costing-variance.md.
//
// Two deliberate changes from #117's version:
//   1. Prisma is dependency-injected (`CostCodingDataSource`) instead of
//      imported, so these rules are unit-testable with no database — the same
//      split as project-phases.ts (pure) / project-phases-db.ts (I/O) and
//      phase-options.ts. #117's version imported `@/lib/prisma` directly and
//      was therefore untestable without a live database.
//   2. `EXPENSE_REVIEWER_ROLES` is not carried over here. It is an
//      authorization concern, not cost attribution, and lives with the expense
//      routes that enforce it.
//
// WHY THIS EXISTS (the TRUST rule, in code): an uncoded posting is worse than
// no posting. A time entry or expense with no cost code silently vanishes from
// every variance number — the job looks cheaper than it is, and the estimate
// item it belonged to looks on-budget. Rejecting at the door is the only way
// the variance report can be believed.

/** The estimate-item facts the derivation rule needs. */
export interface CostCodingLineItem {
    costCodeId: string | null;
    costTypeId: string | null;
    /** The linked cost code's active flag; null when the item has no cost code. */
    costCodeIsActive: boolean | null;
}

/** The cost-code facts the explicit-id rule needs. */
export interface CostCodingCostCode {
    id: string;
    isActive: boolean;
}

export type CostCodeResolution =
    | { ok: true; costCodeId: string; costTypeId: string | null; source: "explicit" | "line-item" }
    | { ok: false; status: number; error: string; code: CostCodeRejection };

/**
 * Machine-readable rejection reasons. Clients (the crew app especially) need to
 * tell "you picked something inactive" from "this estimate needs cleanup" —
 * the second is an office problem the crew cannot fix from a phone, and the app
 * should say so rather than showing a dead end. Mirrors the
 * `PHASE_NOT_ON_PROJECT` / `PHASE_REQUIRED` convention already used by
 * /api/time-entries.
 */
export type CostCodeRejection =
    | "COST_CODE_NOT_FOUND"
    | "COST_CODE_INACTIVE"
    | "LINE_ITEM_NOT_FOUND"
    | "LINE_ITEM_NOT_CODED"
    | "LINE_ITEM_COST_CODE_INACTIVE"
    | "COST_CODE_REQUIRED";

/** Injected reads, so the rules above stay database-free and unit-testable. */
export interface CostCodingDataSource {
    getCostCode(costCodeId: string): Promise<CostCodingCostCode | null>;
    getLineItem(lineItemId: string): Promise<CostCodingLineItem | null>;
}

/**
 * Resolve and validate the cost code for a posting.
 *
 * Precedence:
 *   1. An explicit `costCodeId` — validated for existence AND `isActive`.
 *   2. Otherwise DERIVE the code from the chosen estimate line item. This is
 *      what makes item-level capture cheap: prod measures only 1.0–2.1 estimate
 *      items per phase, so asking the crew for the finer grain yields the phase
 *      for free. One capture, both grains — no allocation, no guessing.
 *   3. Otherwise REJECT. Uncoded labor/spend never reaches the job ledger.
 *
 * Deriving server-side (rather than trusting a client-sent code) is deliberate:
 * the old mobile behaviour matched cost codes by string and silently dropped the
 * code when its fuzzy match missed, which is exactly how wrong and missing cost
 * codes got into production data.
 *
 * SCOPE: this guarantees cost-code ATTRIBUTION only. It does not check that the
 * code or item belongs to the right project — that is a separate permission
 * question answered by `isCostCodeAllowedForProject` (src/lib/project-phases.ts),
 * and callers must do both. "The cost code exists" is not a permission.
 */
export async function resolveCostCode(
    dataSource: CostCodingDataSource,
    input: { costCodeId?: string | null; lineItemId?: string | null }
): Promise<CostCodeResolution> {
    if (input.costCodeId) {
        const costCode = await dataSource.getCostCode(input.costCodeId);
        if (!costCode) {
            return {
                ok: false,
                status: 400,
                code: "COST_CODE_NOT_FOUND",
                error: "Cost code not found.",
            };
        }
        if (!costCode.isActive) {
            return {
                ok: false,
                status: 400,
                code: "COST_CODE_INACTIVE",
                error: "That cost code is inactive.",
            };
        }
        // An explicit code carries no cost type: only an estimate item knows
        // whether the money is Labor or Material. Returning null here rather
        // than inventing one keeps the AGENCY rule — never present a guess as
        // if it were measured.
        return { ok: true, costCodeId: costCode.id, costTypeId: null, source: "explicit" };
    }

    if (input.lineItemId) {
        const item = await dataSource.getLineItem(input.lineItemId);
        if (!item) {
            return {
                ok: false,
                status: 400,
                code: "LINE_ITEM_NOT_FOUND",
                error: "Line item not found.",
            };
        }
        if (!item.costCodeId) {
            return {
                ok: false,
                status: 400,
                code: "LINE_ITEM_NOT_CODED",
                error:
                    "This line item isn't linked to a cost code. Pick a coded line item, or set its cost code on the estimate first.",
            };
        }
        if (item.costCodeIsActive === false) {
            return {
                ok: false,
                status: 400,
                code: "LINE_ITEM_COST_CODE_INACTIVE",
                error: "This line item's cost code is inactive.",
            };
        }
        return {
            ok: true,
            costCodeId: item.costCodeId,
            costTypeId: item.costTypeId ?? null,
            source: "line-item",
        };
    }

    return {
        ok: false,
        status: 400,
        code: "COST_CODE_REQUIRED",
        error: "A cost code is required so this can post to the job. Select a cost code or a coded line item.",
    };
}
