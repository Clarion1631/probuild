// Pure reduction for the mobile phase picker
// (src/app/api/mobile/projects/[id]/phases/route.ts). Kept free of Prisma/Next
// imports so the approved-only filtering and representative-item selection can
// be unit-tested directly (mirrors src/lib/overtime.ts's convention) — the
// route does the DB fetch and just passes in the candidate rows.

export interface PhaseCandidateItem {
    estimateItemId: string;
    /** EstimateItem.order — used to pick a deterministic representative item per cost code. */
    order: number;
    costCodeId: string | null;
    costCodeActive: boolean;
    costCodeCode: string;
    costCodeName: string;
    estimateStatus: string;
    estimateArchived: boolean;
}

export interface PhaseOption {
    costCodeId: string;
    code: string;
    name: string;
    /** One representative EstimateItem for this cost code, picked deterministically. */
    estimateItemId: string;
}

/**
 * Distinct, active cost codes referenced by items on Approved (non-archived)
 * estimates, one representative item per cost code (lowest order, then id),
 * sorted by code.
 */
export function buildPhaseOptions(items: PhaseCandidateItem[]): PhaseOption[] {
    const eligible = items.filter(
        (i) => i.costCodeId && i.costCodeActive && i.estimateStatus === "Approved" && !i.estimateArchived
    );

    const sorted = [...eligible].sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        return a.estimateItemId < b.estimateItemId ? -1 : a.estimateItemId > b.estimateItemId ? 1 : 0;
    });

    const byCostCode = new Map<string, PhaseOption>();
    for (const item of sorted) {
        if (!item.costCodeId) continue;
        if (byCostCode.has(item.costCodeId)) continue;
        byCostCode.set(item.costCodeId, {
            costCodeId: item.costCodeId,
            code: item.costCodeCode,
            name: item.costCodeName,
            estimateItemId: item.estimateItemId,
        });
    }

    return [...byCostCode.values()].sort((a, b) => a.code.localeCompare(b.code));
}
