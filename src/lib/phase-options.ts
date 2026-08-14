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
    /** Estimate.id — used to pick ONE canonical estimate when several Approved estimates exist on the project. */
    estimateId: string;
    /** Estimate.approvedAt if set, else Estimate.createdAt (ISO string) — the recency key for canonical-estimate selection. Lexicographic ISO-8601 comparison sorts chronologically. */
    estimateRecencyKey: string;
}

export interface PhaseOption {
    costCodeId: string;
    code: string;
    name: string;
    /** One representative EstimateItem for this cost code, picked deterministically. */
    estimateItemId: string;
}

/**
 * Distinct, active cost codes referenced by items on the ONE canonical
 * Approved (non-archived) estimate for the project, one representative item
 * per cost code (lowest order, then id), sorted by code.
 *
 * A project can carry more than one Approved estimate at once — merging
 * items across all of them would make the phase list flap as estimates are
 * approved/edited. Instead, pick a single canonical estimate deterministically
 * (most recently approved, falling back to most recently created via
 * estimateRecencyKey, then estimateId as a final tiebreak) and use only its
 * items.
 */
export function buildPhaseOptions(items: PhaseCandidateItem[]): PhaseOption[] {
    const eligible = items.filter(
        (i) => i.costCodeId && i.costCodeActive && i.estimateStatus === "Approved" && !i.estimateArchived
    );

    let canonicalEstimateId: string | null = null;
    let canonicalRecencyKey = "";
    for (const item of eligible) {
        const isMoreRecent = item.estimateRecencyKey > canonicalRecencyKey;
        const isTieBrokenLower =
            item.estimateRecencyKey === canonicalRecencyKey &&
            canonicalEstimateId !== null &&
            item.estimateId < canonicalEstimateId;
        if (canonicalEstimateId === null || isMoreRecent || isTieBrokenLower) {
            canonicalEstimateId = item.estimateId;
            canonicalRecencyKey = item.estimateRecencyKey;
        }
    }

    const fromCanonicalEstimate = eligible.filter((i) => i.estimateId === canonicalEstimateId);

    const sorted = [...fromCanonicalEstimate].sort((a, b) => {
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
