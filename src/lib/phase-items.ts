// Which estimate line ITEMS sit under a phase the crew just picked?
//
// This is the second half of the "one capture, both grains" design. Measured on
// live prod (2026-08-19):
//
//     1 item in a phase : 40 phases (51.9%)   <- zero extra taps
//     2 items           : 27 phases (35.1%)
//     3 items           :  6 phases ( 7.8%)
//     4 items           :  3 phases ( 3.9%)
//     5 items           :  1 phase  ( 1.3%)
//
// So over half the time the item is IMPLIED by the phase and the crew is never
// asked. Otherwise they choose from 2-5 rows, not a 52-item scroll. Capturing
// the item yields the phase for free (resolveCostCode derives it), which is what
// makes per-item variance affordable without hurting ADOPTION.
//
// Rules live here as pure functions; the Prisma reader is injected, matching
// project-phases.ts / project-phases-db.ts. Deliberately built on
// project-phases.ts's ELIGIBLE-estimate rule set — the one the picker and the
// clock-in validator already share — NOT on phase-options.ts, whose
// canonical-single-estimate rule disagrees with it (see the drift-trap note
// there).

/** One selectable line item under a phase. */
export interface PhaseItemOption {
    estimateItemId: string;
    /** The line's own wording — this is what the crew reads to tell two items apart. */
    name: string;
    /** Ordering key from the estimate, so the list matches the printed bid. */
    order: number;
    /** Sell price of this line. Shown as context, never as a target to hit. */
    total: number;
}

export interface PhaseItemsDataSource {
    /**
     * Cost-coded, NON-SECTION items on the project's eligible estimates for one
     * cost code. Section-row exclusion belongs to the adapter, which has the
     * sibling set needed to detect them.
     */
    getItemsForPhase(projectId: string, costCodeId: string): Promise<PhaseItemOption[]>;
}

/**
 * Deterministic order for the item step: estimate order first (so it reads like
 * the bid), then id as a tiebreak so the list never reshuffles between renders.
 */
export function sortPhaseItems(items: PhaseItemOption[]): PhaseItemOption[] {
    return [...items].sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        return a.estimateItemId < b.estimateItemId ? -1 : a.estimateItemId > b.estimateItemId ? 1 : 0;
    });
}

/**
 * What the crew app should DO after a phase tap.
 *
 * - `auto`: exactly one item — attach it silently, zero extra taps. The
 *   dominant case (51.9% of prod phases).
 * - `choose`: 2+ items — show just those rows as a second step.
 * - `none`: no coded items under this phase (e.g. the Safety phase, which is
 *   deliberately not an estimate line). Clock in on the phase alone; this must
 *   never block a punch.
 *
 * ADOPTION rule in code: the crew is only ever asked when the answer is
 * genuinely ambiguous.
 */
export type PhaseItemDecision =
    | { kind: "auto"; item: PhaseItemOption }
    | { kind: "choose"; items: PhaseItemOption[] }
    | { kind: "none" };

export function decidePhaseItemStep(items: PhaseItemOption[]): PhaseItemDecision {
    const sorted = sortPhaseItems(items);
    if (sorted.length === 0) return { kind: "none" };
    if (sorted.length === 1) return { kind: "auto", item: sorted[0] };
    return { kind: "choose", items: sorted };
}

/** The items under one phase, ordered. Empty is a legitimate answer, not an error. */
export async function resolvePhaseItems(
    dataSource: PhaseItemsDataSource,
    projectId: string,
    costCodeId: string
): Promise<PhaseItemOption[]> {
    return sortPhaseItems(await dataSource.getItemsForPhase(projectId, costCodeId));
}
