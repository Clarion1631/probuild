// Shared transform: turns a phase-grouped estimate payload (the JSON shape ProBuild's
// AI estimate generator produces — and the same shape an external tool like ChatGPT can
// be asked to emit) into the grouped EstimateItem[] the estimate editor consumes.
// Used by both /api/ai-estimate (AI generation) and /api/ai-estimate/import (paste import)
// so the two paths can never drift.

export type CostCode = { id: string; code: string; name: string };
export type CostType = { id: string; name: string };

export type AiPhaseItem = {
    name?: string;
    description?: string;
    costType?: string;
    costCode?: string; // per-item cost code (e.g. "01-DEMO"); falls back to the phase's phaseCode
    quantity?: number | string;
    unit?: string;
    unitCost?: number | string;
};
export type AiPhase = {
    phaseName?: string;
    phaseCode?: string;
    items?: AiPhaseItem[];
};
export type AiMilestone = { name?: string; percentage?: number | string };
export type AiData = { phases?: AiPhase[]; paymentMilestones?: AiMilestone[] };

/** Coerce numbers tolerantly — accepts 1800, "1800", "$1,800", "240 sq ft" → 1800 / 240. */
function toNum(v: unknown): number {
    if (typeof v === "number") return isFinite(v) ? v : 0;
    if (typeof v === "string") {
        const n = parseFloat(v.replace(/[^0-9.\-]/g, ""));
        return isFinite(n) ? n : 0;
    }
    return 0;
}

/** Round to cents so Decimal columns never accumulate float drift. */
function toCents(n: number): number {
    return Math.round(n * 100) / 100;
}

function makeItem(i: {
    id: string; name: string; description: string; type: string;
    quantity: number; unitCost: number; total: number;
    parentId: string | null; costCodeId: string | null; costTypeId: string | null; order: number;
}) {
    return { ...i, markupPercent: 25, baseCost: null };
}

export type TransformedEstimate = {
    items: ReturnType<typeof makeItem>[];
    paymentMilestones: { id: string; name: string; percentage: string; amount: string; dueDate: string }[];
    count: number;
    totalEstimate: number;
};

export function transformPhasesToItems(
    aiData: AiData,
    costCodes: CostCode[] = [],
    costTypes: CostType[] = [],
): TransformedEstimate {
    const aiPhases: AiPhase[] = aiData.phases || [];
    const aiMilestones: AiMilestone[] = aiData.paymentMilestones || [];

    // Map cost codes and cost types (by their human labels) to internal IDs.
    const codeMap: Record<string, string> = {};
    for (const cc of costCodes) {
        if (cc.code) codeMap[cc.code] = cc.id;
    }
    const typeMap: Record<string, string> = {};
    for (const ct of costTypes) {
        if (ct.name) typeMap[ct.name] = ct.id;
    }

    const ts = Date.now();
    let order = 0;
    const estimateItems: ReturnType<typeof makeItem>[] = [];

    for (let pi = 0; pi < aiPhases.length; pi++) {
        const phase = aiPhases[pi];
        const parentId = `imp_${ts}_p${pi}`;
        const phaseItems = phase.items || [];
        const parentOrder = order++;

        // Child rows first: each line total is rounded to cents, and the phase total
        // is the sum of those rounded totals so parent and children always agree.
        const children: ReturnType<typeof makeItem>[] = [];
        for (let ii = 0; ii < phaseItems.length; ii++) {
            const item = phaseItems[ii];
            const qty = toNum(item.quantity) || 1;
            const uc = toCents(toNum(item.unitCost));
            children.push(makeItem({
                id: `imp_${ts}_p${pi}_i${ii}`,
                name: item.name || "Item",
                description: item.description || "",
                type: item.costType || "Material",
                quantity: qty,
                unitCost: uc,
                total: toCents(qty * uc),
                parentId,
                // An explicit item costCode wins outright: if it doesn't match a real
                // code the item stays uncoded (callers warn) rather than silently
                // inheriting the phase code. Only absent costCode falls back.
                costCodeId: item.costCode
                    ? (codeMap[item.costCode] ?? null)
                    : (phase.phaseCode ? (codeMap[phase.phaseCode] ?? null) : null),
                costTypeId: item.costType ? (typeMap[item.costType] ?? null) : null,
                order: order++,
            }));
        }
        const phaseTotal = toCents(children.reduce((s, c) => s + c.total, 0));

        // Parent row — phase header (type "Section" so editor renders it as a collapsible group).
        // unitCost = phaseTotal so qty(1) * unitCost = total survives the save-path recomputation.
        estimateItems.push(makeItem({
            id: parentId,
            name: phase.phaseName || `Phase ${pi + 1}`,
            description: "",
            type: "Section",
            quantity: 1,
            unitCost: phaseTotal,
            total: phaseTotal,
            parentId: null,
            costCodeId: phase.phaseCode ? (codeMap[phase.phaseCode] ?? null) : null,
            costTypeId: null,
            order: parentOrder,
        }));
        estimateItems.push(...children);
    }

    const totalEstimate = toCents(estimateItems
        .filter(i => !i.parentId) // sum phase totals only
        .reduce((s, i) => s + i.total, 0));

    // Milestone amounts are rounded to cents. When the percentages genuinely cover
    // the whole estimate, the last milestone absorbs the rounding residual so the
    // schedule sums to the estimate total exactly.
    // Round the percentage sum to 2dp before comparing so float noise (33.33*3
    // = 99.99000000000001) can't push a boundary case outside the tolerance.
    // Must stay consistent with the milestone validation in gpt-estimate.ts.
    const pcts = aiMilestones.map(m => toNum(m.percentage));
    const pctSum = toCents(pcts.reduce((s, p) => s + p, 0));
    const coversTotal = aiMilestones.length > 0 && Math.abs(pctSum - 100) <= 0.01;
    let allocated = 0;
    const paymentMilestones = aiMilestones.map((m, idx) => {
        const pct = pcts[idx];
        const isLast = idx === aiMilestones.length - 1;
        const amount = coversTotal && isLast
            ? toCents(totalEstimate - allocated)
            : toCents(pct / 100 * totalEstimate);
        allocated = toCents(allocated + amount);
        return {
            id: `pm_${ts}_${idx}`,
            name: m.name || `Payment ${idx + 1}`,
            percentage: String(pct || 0),
            amount: amount.toFixed(2),
            dueDate: "",
        };
    });

    return {
        items: estimateItems,
        paymentMilestones,
        count: estimateItems.length,
        totalEstimate,
    };
}
