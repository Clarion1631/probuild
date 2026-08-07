/**
 * Estimate line-item serialization — the single place that decides which rows are
 * section headers, what a section's total is, and what gets sent to `saveEstimate`.
 *
 * This logic used to be copy-pasted three times inside EstimateEditor (the change-detection
 * snapshot, the save payload, and the subtotal), which let the three copies drift. Three
 * defects came out of that shared ancestry:
 *
 *  1. Section detection was `!item.parentId && hasChildren`, so only ONE level of nesting
 *     rolled up: a nested section was treated as a plain billable row and its own children
 *     were ignored (and double-counted by the subtotal).
 *  2. Section detection was keyed off "has children", so deleting a section's last child
 *     turned the row back into a billable line — still carrying the mirrored former child
 *     total in `unitCost`, so it kept charging the deleted amount.
 *  3. Child totals were accumulated without a final rounding pass, so 0.10 + 0.20 produced
 *     0.30000000000000004.
 *
 * A row is a section if `type === "Section"` OR it has children. The `type` half is what
 * fixes (2) — every path that creates a section sets `type: "Section"` (Add Category,
 * saved assemblies, multi-phase templates, the AI transform), and both the MCP route and
 * Budget generation in `approveEstimate` already treat `type === "Section"` as
 * authoritative. The has-children half is kept so legacy rows that predate the type tag
 * still roll up. A legacy section that has no children and no type tag is indistinguishable
 * from a line item and is still treated as one — that is not recoverable from the data.
 */

/** Round to 2 decimal places to avoid IEEE 754 penny drift in money calculations */
export const rm = (n: number) => Math.round(n * 100) / 100;

/** The subset of an estimate item this module reads. Callers pass their own richer rows through. */
export type EstimateItemLike = {
    id?: string | null;
    parentId?: string | null;
    type?: string | null;
    quantity?: unknown;
    unitCost?: unknown;
};

export type EstimateItemTotal = {
    /** True when this row is a section header: its total is rolled up, not billed directly. */
    isSection: boolean;
    /** Rolled-up child total for sections, `qty * unitCost` for leaves. Always cent-rounded. */
    total: number;
};

function num(value: unknown): number {
    const parsed = typeof value === "number" ? value : parseFloat(String(value ?? ""));
    return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Per-row `{ isSection, total }`, index-aligned with `items`.
 *
 * Section totals aggregate recursively, so a section nested inside another section
 * contributes its own rolled-up total to its parent. Cyclic `parentId` data (which should
 * be impossible, but is not enforced at the DB level) is treated as contributing 0 rather
 * than recursing forever.
 */
export function computeEstimateItemTotals<T extends EstimateItemLike>(items: readonly T[]): EstimateItemTotal[] {
    const childIndexesByParent = new Map<string, number[]>();
    const indexById = new Map<string, number>();

    items.forEach((item, index) => {
        const id = item.id ? String(item.id) : null;
        // Later duplicates lose; ids are unique in practice, this just keeps lookup total.
        if (id && !indexById.has(id)) indexById.set(id, index);
        const parentId = item.parentId ? String(item.parentId) : null;
        if (!parentId) return;
        const siblings = childIndexesByParent.get(parentId);
        if (siblings) siblings.push(index);
        else childIndexesByParent.set(parentId, [index]);
    });

    const isSectionAt = (index: number): boolean => {
        const item = items[index];
        if (item.type === "Section") return true;
        const id = item.id ? String(item.id) : null;
        return !!id && childIndexesByParent.has(id);
    };

    // Rows whose parent chain loops instead of terminating at a root. Resolved up front so
    // the outcome does not depend on the order rows happen to appear in: every row in (or
    // hanging off) a cycle totals 0 and contributes 0, whichever end we start walking from.
    const ROOTED = 1;
    const UNROOTED = 2;
    const rootedness = new Array<number>(items.length).fill(0);
    for (let start = 0; start < items.length; start++) {
        if (rootedness[start] !== 0) continue;
        const path: number[] = [];
        const onPath = new Set<number>();
        let cursor: number | undefined = start;
        let verdict = ROOTED;
        while (cursor !== undefined) {
            if (onPath.has(cursor)) { verdict = UNROOTED; break; }
            if (rootedness[cursor] !== 0) { verdict = rootedness[cursor]; break; }
            path.push(cursor);
            onPath.add(cursor);
            const parentId: string | null = items[cursor].parentId ? String(items[cursor].parentId) : null;
            cursor = parentId ? indexById.get(parentId) : undefined;
        }
        for (const index of path) rootedness[index] = verdict;
    }

    const resolved = new Array<number | undefined>(items.length);

    const totalAt = (index: number): number => {
        const cached = resolved[index];
        if (cached !== undefined) return cached;
        // Reserve a value before recursing so a cycle can never re-enter this row.
        resolved[index] = 0;
        if (rootedness[index] === UNROOTED) return 0;

        const item = items[index];
        let total: number;
        if (isSectionAt(index)) {
            const id = item.id ? String(item.id) : null;
            const childIndexes = id ? childIndexesByParent.get(id) : undefined;
            // Round the accumulated sum, not just each product: 0.10 + 0.20 must be 0.30.
            total = rm((childIndexes ?? []).reduce((sum, childIndex) => sum + totalAt(childIndex), 0));
        } else {
            total = rm(num(item.quantity) * num(item.unitCost));
        }

        resolved[index] = total;
        return total;
    };

    return items.map((_item, index) => ({ isSection: isSectionAt(index), total: totalAt(index) }));
}

/**
 * Whether a single row is a section header, using the same rule as
 * `computeEstimateItemTotals`. Exported for consumers that read *stored* totals off a saved
 * estimate (the PDF) rather than recomputing them, so every reader agrees on which rows are
 * headers and which are billable.
 */
export function isEstimateSectionRow<T extends EstimateItemLike>(item: T, items: readonly T[]): boolean {
    if (item.type === "Section") return true;
    return !!item.id && items.some(other => other.parentId && String(other.parentId) === String(item.id));
}

/**
 * Tag every detected section with `type: "Section"`, leaving all other rows untouched.
 *
 * `serializeEstimateItemsForSave` normalizes the rows it *persists*, but it is deliberately
 * non-mutating, so the editor's in-memory rows keep whatever type they loaded with. For a
 * legacy row recognized as a section only because it has children, that gap is a money bug:
 * delete its last child in the same session and the stale in-memory row looks like a leaf
 * again, bills its mirrored unitCost, and the next save overwrites the tag that was just
 * persisted. Editors call this after a successful save so local state matches the database.
 *
 * Idempotent, and safe to apply to a `setState` updater's `prev` value.
 */
export function normalizeSectionTypes<T extends EstimateItemLike>(items: readonly T[]): T[] {
    const totals = computeEstimateItemTotals(items);
    return items.map((item, index) =>
        totals[index].isSection && item.type !== "Section" ? { ...item, type: "Section" } : item,
    );
}

/**
 * Estimate subtotal: leaf rows only. Section rows are excluded because their total is the
 * sum of rows already counted here.
 */
export function computeEstimateSubtotal<T extends EstimateItemLike>(items: readonly T[]): number {
    const totals = computeEstimateItemTotals(items);
    return rm(totals.reduce((sum, entry) => (entry.isSection ? sum : sum + entry.total), 0));
}

/**
 * The item payload for `saveEstimate`: every input field preserved, plus the row's list
 * `order` and its computed `total`. Section rows additionally get `unitCost` mirrored to
 * their rolled-up total, which is what the PDF and downstream readers display — so a
 * section that has lost all of its children mirrors to 0 rather than keeping the stale
 * total of the deleted children.
 *
 * Detected sections are also normalized to `type: "Section"`. Without this, a legacy row
 * recognized as a section only because it has children would silently become a billable
 * line the moment its last child is deleted — still carrying the mirrored child total.
 * Persisting the tag makes the row self-healing on its next save, and matches what the
 * consumers that filter strictly on type already expect (Budget generation in
 * `approveEstimate`, the MCP route).
 */
export function serializeEstimateItemsForSave<T extends EstimateItemLike>(
    items: readonly T[],
): (T & { order: number; total: number })[] {
    const totals = computeEstimateItemTotals(items);
    return items.map((item, index) => ({
        ...item,
        order: index,
        total: totals[index].total,
        ...(totals[index].isSection ? { type: "Section", unitCost: totals[index].total } : {}),
    }));
}
