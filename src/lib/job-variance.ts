// Job-cost variance: estimated vs actual, per PHASE and per ESTIMATE ITEM.
//
// This is the number Justin asked for: "are we profitable per job, and if not,
// why — at an estimate-item level, not by gut."
//
// Pure functions only (no Prisma), so every rule below is unit-tested without a
// database — same split as project-phases.ts / project-phases-db.ts.
//
// ── WHY THE OLD /manager/variance PAGE WAS WRONG ────────────────────────────
// It summed ONLY `timeEntry.laborCost + burdenCost` as "actual". Expenses were
// not in the query at all. On a remodel, materials and subs are most of the
// cost, so every job showed a large favourable variance that was really just
// unmeasured spend. A report that flatters the job is worse than no report —
// it fails the TRUST rule. This module counts BOTH sides.
//
// ── THE COVERAGE RULE (TRUST + AGENCY) ──────────────────────────────────────
// Actuals are only comparable to a budget when they are actually attributed.
// Prod today: 20/60 time entries and 89/562 expenses carry a cost code, and
// 0/562 expenses carry an item id. So every variance number MUST ship with the
// share of dollars it could not place. `unattributed` is not a footnote — it is
// the number that says how much to trust the rest. We never allocate unattributed
// spend across phases to make the report look complete; that would present a
// guess as a measurement.

/** A budget row: one estimate line item. Section headers must be EXCLUDED by the caller. */
export interface VarianceEstimateItem {
    id: string;
    name: string;
    /** null when the estimate still needs cleanup — surfaces as an "uncoded" bucket. */
    costCodeId: string | null;
    costCode: { code: string; name: string } | null;
    /** "Labor" splits from everything else; a null cost type falls back to `type`. */
    costTypeName: string | null;
    type: string | null;
    total: number;
}

/** An actual labor cost: one clocked shift. */
export interface VarianceTimeEntry {
    costCodeId: string | null;
    estimateItemId: string | null;
    laborCost: number;
    burdenCost: number;
}

/** An actual material/sub cost: one expense (a QuickBooks purchase, usually). */
export interface VarianceExpense {
    costCodeId: string | null;
    itemId: string | null;
    amount: number;
}

export interface PhaseVariance {
    costCodeId: string;
    code: string;
    name: string;
    laborBudget: number;
    materialBudget: number;
    totalBudget: number;
    actualLabor: number;
    actualMaterial: number;
    totalActual: number;
    /** budget − actual. NEGATIVE = over budget (the bad direction). */
    variance: number;
    /** actual / budget, or null when there is no budget to divide by. */
    percentUsed: number | null;
    /**
     * True when this phase's budget nets NEGATIVE (a discount/credit line under
     * the same cost code). `percentUsed` is null in that case, so without this
     * flag the UI would quietly drop the "% used" line and the "not in the
     * estimate" warning with no explanation. Peer-review finding.
     */
    hasNegativeBudget: boolean;
    items: ItemVariance[];
}

export interface ItemVariance {
    itemId: string;
    name: string;
    budget: number;
    /** Only labor/spend explicitly linked to THIS item. Never allocated down from the phase. */
    actual: number;
    variance: number;
    /**
     * True when the phase has actuals that are coded to the phase but not to any
     * item. The item-level number is then a floor, not a measurement — the UI
     * must say so rather than implying the item is under budget.
     */
    phaseHasUnassignedActuals: boolean;
}

export interface ProjectVariance {
    laborBudget: number;
    materialBudget: number;
    totalBudget: number;
    actualLabor: number;
    actualMaterial: number;
    totalActual: number;
    variance: number;
    percentUsed: number | null;
    phases: PhaseVariance[];
    /** Budgeted work whose estimate item carries no cost code — an estimate cleanup task. */
    uncodedBudget: number;
    coverage: VarianceCoverage;
}

/**
 * How much of the actual spend could NOT be placed. Every consumer must show
 * this next to the variance, because a tiny variance on 10%-attributed data
 * means nothing.
 */
export interface VarianceCoverage {
    /** Dollars of labor with no cost code and no estimate item. */
    unattributedLabor: number;
    /** Dollars of expense with no cost code. */
    unattributedMaterial: number;
    unattributedTotal: number;
    /** 0..1 — share of total actual dollars that DID land on a phase. */
    attributedShare: number;
    /** Actuals coded to a phase but not to a specific item, so item rows are floors. */
    phaseOnlyActuals: number;
    /**
     * Rows whose amount was not a finite number (corrupt/NaN). Peer-review
     * finding: `Number(x) || 0` turns garbage into a confident $0 of spend.
     * Given this module exists to never flatter a job, a corrupt amount must be
     * surfaced and counted, not silently vanish.
     */
    malformedRows: number;
}

/** "Labor" vs everything else. A null cost type falls back to the legacy `type` string. */
export function isLaborItem(item: Pick<VarianceEstimateItem, "costTypeName" | "type">): boolean {
    return (item.costTypeName ?? item.type ?? "") === "Labor";
}

const UNCODED = "__uncoded";

function emptyPhase(costCodeId: string, code: string, name: string): PhaseVariance {
    return {
        costCodeId, code, name,
        laborBudget: 0, materialBudget: 0, totalBudget: 0,
        actualLabor: 0, actualMaterial: 0, totalActual: 0,
        variance: 0, percentUsed: null, hasNegativeBudget: false, items: [],
    };
}

/**
 * actual/budget, or null when there is no usable budget — never Infinity or NaN.
 *
 * A NEGATIVE budget (a phase whose items net below zero via a discount or credit
 * line) is deliberately treated the same as no budget for the ratio, but callers
 * must distinguish the two: see `hasNegativeBudget` on PhaseVariance, which the
 * UI uses to say "check the estimate" instead of silently hiding the % used.
 */
function ratio(actual: number, budget: number): number | null {
    if (budget <= 0) return null;
    const value = actual / budget;
    return Number.isFinite(value) ? value : null;
}

/** A money value that is guaranteed finite; non-finite input is reported, not silently zeroed. */
function toAmount(value: unknown): { amount: number; malformed: boolean } {
    const n = Number(value);
    if (!Number.isFinite(n)) return { amount: 0, malformed: true };
    return { amount: n, malformed: false };
}

/** Keep a share inside 0..1 so no consumer can render an impossible percentage. */
function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 1;
    return Math.min(1, Math.max(0, value));
}

/**
 * Compute the whole variance picture for ONE project.
 *
 * Callers MUST pass only billable leaf rows in `items` — section headers mirror
 * their children's totals, so including one doubles its phase's budget (see
 * isEstimateSectionRow in estimate-item-payload.ts).
 */
export function computeProjectVariance(input: {
    items: VarianceEstimateItem[];
    timeEntries: VarianceTimeEntry[];
    expenses: VarianceExpense[];
    /**
     * Labels for cost codes that carry actuals but appear on NO estimate item —
     * unbudgeted work. Without this the phase renders as "N/A" and the biggest
     * surprises on a job are the least legible ones. Optional so existing
     * callers keep working; a missing entry still degrades to "N/A".
     */
    costCodeLabels?: Map<string, { code: string; name: string }>;
}): ProjectVariance {
    const phases = new Map<string, PhaseVariance>();
    const itemsById = new Map<string, ItemVariance & { costCodeId: string | null }>();
    let uncodedBudget = 0;
    let malformedBudgetRows = 0;

    /**
     * Get-or-create a phase for a cost code that carries ACTUALS but has no
     * budget line. Named from `costCodeLabels` when available so unbudgeted
     * work is identifiable instead of an anonymous "N/A" row.
     */
    const ensurePhase = (costCodeId: string): PhaseVariance => {
        let phase = phases.get(costCodeId);
        if (!phase) {
            const label = input.costCodeLabels?.get(costCodeId);
            phase = emptyPhase(costCodeId, label?.code ?? "N/A", label?.name ?? "Unbudgeted phase");
            phases.set(costCodeId, phase);
        }
        return phase;
    };

    // ── budget side ─────────────────────────────────────────────────────────
    for (const item of input.items) {
        const parsedBudget = toAmount(item.total);
        if (parsedBudget.malformed) malformedBudgetRows += 1;
        const budget = parsedBudget.amount;
        const itemRow = {
            itemId: item.id, name: item.name, budget, actual: 0, variance: budget,
            phaseHasUnassignedActuals: false, costCodeId: item.costCodeId,
        };
        itemsById.set(item.id, itemRow);

        if (!item.costCodeId) {
            // Deliberately NOT spread across phases. This is estimate cleanup
            // work, and hiding it inside a phase would misstate that phase.
            uncodedBudget += budget;
            continue;
        }
        const key = item.costCodeId;
        if (!phases.has(key)) {
            phases.set(key, emptyPhase(key, item.costCode?.code ?? "N/A", item.costCode?.name ?? "Unknown"));
        }
        const phase = phases.get(key)!;
        if (isLaborItem(item)) phase.laborBudget += budget;
        else phase.materialBudget += budget;
        phase.items.push(itemRow);
    }

    /**
     * Decide which phase a cost belongs to, and whether its item link may be
     * used — keeping the two CONSISTENT.
     *
     * Found in peer review: taking the explicit `costCodeId` for the phase while
     * still crediting a linked item that sits under a DIFFERENT phase put the
     * money on phase A's total and on an item under phase B. That breaks the
     * invariant "a phase's actuals ≥ the sum of its own items' actuals", and it
     * silently cleared the floor warning on an item nobody had measured.
     *
     * Resolution: the EXPLICIT cost code still wins for the phase (it is what the
     * crew actually picked at clock-in). But an item is only credited when it
     * genuinely belongs to that phase. A mismatched item link is dropped and the
     * cost is treated as phase-only — visible, conservative, and it keeps the
     * item row honestly marked as a floor.
     */
    const reconcileAttribution = (
        explicitCostCodeId: string | null | undefined,
        linkedItem: (ItemVariance & { costCodeId: string | null }) | undefined
    ): { costCodeId: string | null; item: (ItemVariance & { costCodeId: string | null }) | undefined } => {
        const costCodeId = explicitCostCodeId ?? linkedItem?.costCodeId ?? null;
        if (!costCodeId) return { costCodeId: null, item: undefined };
        // Only credit the item when it lives under the phase being charged.
        const item = linkedItem && linkedItem.costCodeId === costCodeId ? linkedItem : undefined;
        return { costCodeId, item };
    };

    // ── actual side: labor ──────────────────────────────────────────────────
    let unattributedLabor = 0;
    let phaseOnlyActuals = 0;
    let malformedRows = 0;
    // Coverage is measured over ABSOLUTE dollars. Peer-review finding:
    // Expense.amount is signed (refunds/credit memos are normal), so netting
    // could drive the denominator to ~0 and report "100% attributed" on data
    // that was 0% attributed. Magnitude of money moved is the honest base.
    let absAttributed = 0;
    let absUnattributed = 0;
    for (const entry of input.timeEntries) {
        const labor = toAmount(entry.laborCost);
        const burden = toAmount(entry.burdenCost);
        if (labor.malformed || burden.malformed) malformedRows += 1;
        const cost = labor.amount + burden.amount;
        if (cost === 0) continue;

        // An entry may carry an item, a phase, or neither.
        const { costCodeId, item: linkedItem } = reconcileAttribution(
            entry.costCodeId,
            entry.estimateItemId ? itemsById.get(entry.estimateItemId) : undefined
        );

        if (!costCodeId) {
            unattributedLabor += cost;
            absUnattributed += Math.abs(cost);
            continue;
        }
        absAttributed += Math.abs(cost);
        // Actuals on a phase with NO budget are real and important: work
        // happened that nobody estimated.
        const phase = ensurePhase(costCodeId);
        phase.actualLabor += cost;
        if (linkedItem) linkedItem.actual += cost;
        else phaseOnlyActuals += cost;
    }

    // ── actual side: materials / subs ───────────────────────────────────────
    let unattributedMaterial = 0;
    for (const expense of input.expenses) {
        const parsed = toAmount(expense.amount);
        if (parsed.malformed) malformedRows += 1;
        const amount = parsed.amount;
        if (amount === 0) continue;

        const { costCodeId, item: linkedItem } = reconcileAttribution(
            expense.costCodeId,
            expense.itemId ? itemsById.get(expense.itemId) : undefined
        );

        if (!costCodeId) {
            unattributedMaterial += amount;
            absUnattributed += Math.abs(amount);
            continue;
        }
        absAttributed += Math.abs(amount);
        const phase = ensurePhase(costCodeId);
        phase.actualMaterial += amount;
        if (linkedItem) linkedItem.actual += amount;
        else phaseOnlyActuals += amount;
    }

    // ── roll up ─────────────────────────────────────────────────────────────
    for (const phase of phases.values()) {
        phase.totalBudget = phase.laborBudget + phase.materialBudget;
        phase.totalActual = phase.actualLabor + phase.actualMaterial;
        phase.variance = phase.totalBudget - phase.totalActual;
        phase.percentUsed = ratio(phase.totalActual, phase.totalBudget);
        phase.hasNegativeBudget = phase.totalBudget < 0;

        // Flag every item under a phase carrying actuals that landed on no item:
        // those item rows are floors, and the UI must not imply otherwise.
        // Math.abs: peer-review finding — summing Decimal-derived floats leaves
        // sub-cent residue in EITHER direction, and a one-sided `> 0.005` test
        // could suppress a flag that should fire.
        const unassigned = phase.totalActual - phase.items.reduce((a, i) => a + i.actual, 0);
        for (const item of phase.items) {
            item.variance = item.budget - item.actual;
            item.phaseHasUnassignedActuals = Math.abs(unassigned) > 0.005;
        }
        phase.items.sort((a, b) => a.variance - b.variance);
    }

    const phaseList = [...phases.values()].sort((a, b) => {
        // Worst overrun first — the report opens on the problem, not on 01-DEMO.
        if (a.variance !== b.variance) return a.variance - b.variance;
        return a.code.localeCompare(b.code);
    });

    const laborBudget = phaseList.reduce((a, p) => a + p.laborBudget, 0);
    const materialBudget = phaseList.reduce((a, p) => a + p.materialBudget, 0);
    const actualLabor = phaseList.reduce((a, p) => a + p.actualLabor, 0) + unattributedLabor;
    const actualMaterial = phaseList.reduce((a, p) => a + p.actualMaterial, 0) + unattributedMaterial;

    // Uncoded budget IS part of what the job is supposed to cost — leaving it
    // out would understate the budget and manufacture a fake overrun.
    const totalBudget = laborBudget + materialBudget + uncodedBudget;
    const totalActual = actualLabor + actualMaterial;
    const unattributedTotal = unattributedLabor + unattributedMaterial;

    return {
        laborBudget, materialBudget, totalBudget,
        actualLabor, actualMaterial, totalActual,
        variance: totalBudget - totalActual,
        percentUsed: ratio(totalActual, totalBudget),
        phases: phaseList,
        uncodedBudget,
        coverage: {
            unattributedLabor,
            unattributedMaterial,
            unattributedTotal,
            // Clamped to 0..1. Peer-review finding: expenses can be NEGATIVE
            // (refunds, credits, voided purchases), so totalActual can net down
            // to near zero or below while unattributedTotal stays large. Unclamped
            // this produced shares like 1.4 or -3, which the UI renders as an
            // impossible progress bar and a nonsense "140% attributed".
            // Measured over ABSOLUTE dollars moved, so signed refunds cannot net
            // the denominator toward zero and fake a "100% attributed" result.
            attributedShare: clamp01(
                absAttributed + absUnattributed > 0
                    ? absAttributed / (absAttributed + absUnattributed)
                    : 1
            ),
            phaseOnlyActuals,
            malformedRows: malformedRows + malformedBudgetRows,
        },
    };
}
