// Pure reduction for the mobile phase picker
// (src/app/api/mobile/projects/[id]/phases/route.ts). Kept free of Prisma/Next
// imports so the canonical-estimate selection and representative-item
// selection can be unit-tested directly (mirrors src/lib/overtime.ts's
// convention) — the route does the DB fetches and just passes in the
// candidate rows.
//
// Two-step reduction, in this order:
//   1. selectCanonicalEstimateId() picks ONE canonical estimate id from
//      every Approved, non-archived estimate on the project — regardless of
//      whether that estimate's items currently have an active cost code.
//   2. buildPhaseOptions() reduces the (already estimate-scoped) items down
//      to distinct active cost codes.
// The order matters: picking the canonical estimate only from estimates
// whose items HAPPEN to have active cost codes would make a newer approved
// estimate with no active-cost-coded items invisible to selection, letting
// an older estimate's stale items leak through. An empty buildPhaseOptions()
// result for the canonical estimate is a legitimate empty phase list, not a
// signal to fall back to another estimate.

export interface EstimateCandidate {
    /** Estimate.id */
    estimateId: string;
    /** Estimate.approvedAt if set, else Estimate.createdAt (ISO string) — the recency key for canonical-estimate selection. Lexicographic ISO-8601 comparison sorts chronologically. */
    recencyKey: string;
}

/**
 * Pick ONE canonical estimate id from a set of Approved, non-archived
 * estimate candidates for a project (most recently approved, falling back to
 * most recently created via recencyKey, then estimateId as a final
 * tiebreak). Returns null when there are no candidates — a project with no
 * Approved estimate has no canonical estimate, and therefore no phase list.
 */
export function selectCanonicalEstimateId(estimates: EstimateCandidate[]): string | null {
    let canonicalEstimateId: string | null = null;
    let canonicalRecencyKey = "";
    for (const candidate of estimates) {
        const isMoreRecent = candidate.recencyKey > canonicalRecencyKey;
        const isTieBrokenLower =
            candidate.recencyKey === canonicalRecencyKey &&
            canonicalEstimateId !== null &&
            candidate.estimateId < canonicalEstimateId;
        if (canonicalEstimateId === null || isMoreRecent || isTieBrokenLower) {
            canonicalEstimateId = candidate.estimateId;
            canonicalRecencyKey = candidate.recencyKey;
        }
    }
    return canonicalEstimateId;
}

export interface PhaseCandidateItem {
    estimateItemId: string;
    /** EstimateItem.order — used to pick a deterministic representative item per cost code. */
    order: number;
    costCodeId: string | null;
    costCodeActive: boolean;
    costCodeCode: string;
    costCodeName: string;
}

export interface PhaseOption {
    costCodeId: string;
    code: string;
    name: string;
    /** One representative EstimateItem for this cost code, picked deterministically. */
    estimateItemId: string;
}

/**
 * Distinct, active cost codes referenced by items on a single (already
 * chosen) estimate, one representative item per cost code (lowest order,
 * then id), sorted by code.
 *
 * Callers are expected to have already picked the canonical estimate (see
 * selectCanonicalEstimateId) and scoped `items` to just that estimate's
 * items — this function has no estimate-level knowledge of its own, so an
 * empty or all-ineligible `items` array correctly yields an empty result
 * instead of silently reaching into another estimate.
 */
export function buildPhaseOptions(items: PhaseCandidateItem[]): PhaseOption[] {
    const eligible = items.filter((i) => i.costCodeId && i.costCodeActive);

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
