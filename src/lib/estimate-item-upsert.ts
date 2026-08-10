/**
 * Line-item upsert for the estimate save path. Extracted out of `saveEstimate`
 * (`src/lib/actions.ts`) so the create-vs-update routing is unit-testable without a database —
 * see docs/specs/estimate-item-optimistic-concurrency.md for the full design.
 *
 * The field-shaping itself is NOT duplicated here — it lives in
 * `normalizeEstimateItemForSave` (`src/lib/estimate-item-payload.ts`), shared with the editor's
 * change-detection snapshot so the two can't drift (a snapshot missing a field `saveEstimate`
 * writes makes edits to it invisible, and the save silently no-ops). This module only decides
 * create-vs-update routing and calls that shared function for the payload shape.
 *
 * The optimistic-concurrency guard itself lives one level up, in `saveEstimate`: a single
 * `Estimate.itemsRevision` compare-and-set taken under the Estimate row's `FOR UPDATE` lock
 * (see `lockMoneyParents`) guards the whole item collection — adds, deletes, updates, reorders,
 * and wholesale rewrites — in one shot. This module just performs the writes once that guard has
 * already passed; it has no per-row conflict concept.
 */

import { normalizeEstimateItemForSave } from "./estimate-item-payload";

/** Thrown by `saveEstimate` when the incoming save carries a stale (or missing) `itemsRevision`. */
export class EstimateStaleSaveError extends Error {
    constructor() {
        super("Estimate save conflict: itemsRevision is stale or missing.");
        this.name = "EstimateStaleSaveError";
    }
}

/**
 * Structural subset of the Prisma transaction client this helper needs. Typed loosely (not
 * `Prisma.TransactionClient`) so a test can pass a hand-written fake `tx` that records calls,
 * without standing up a database. A real `prisma.$transaction` callback's `tx` satisfies this
 * structurally.
 */
export type EstimateItemTxClient = {
    estimateItem: {
        update: (args: any) => Promise<any>;
        create: (args: any) => Promise<any>;
    };
};

/** The subset of an existing row this helper reads (from `existingItemsMap`). */
export type ExistingEstimateItem = {
    id: string;
    name: string;
};

/**
 * Depth of every submitted row within the submitted tree: 0 for a row with no parent (or whose
 * parent is not in this payload, i.e. an already-persisted row), parent depth + 1 otherwise.
 *
 * Throws on any `parentId` cycle, of any length. The payload is the complete tree — `saveEstimate`
 * deletes every persisted row the payload omits — so a cycle anywhere in the saved estimate is
 * visible here.
 *
 * Two things ride on this one walk:
 *  - Cycle rejection. `computeEstimateItemTotals` survives cyclic data by valuing every row in the
 *    cycle at 0, so a cycle does not hang the app — it silently prices work at nothing, which then
 *    flows into totalAmount -> tax -> payment milestones. Cheaper to refuse the write.
 *  - Write order (see `upsertEstimateItems`). Grouping by depth writes every parent before its
 *    children at any nesting level.
 */
function resolveItemDepths(items: readonly { id?: string | null; parentId?: string | null }[]): number[] {
    const indexById = new Map<string, number>();
    items.forEach((item, index) => {
        const id = item.id ? String(item.id) : null;
        // Later duplicates lose, matching buildItemGraph in estimate-item-payload.
        if (id && !indexById.has(id)) indexById.set(id, index);
    });

    const depths = new Array<number>(items.length).fill(-1);
    for (let start = 0; start < items.length; start++) {
        if (depths[start] >= 0) continue;
        const path: number[] = [];
        const onPath = new Set<number>();
        let cursor: number | undefined = start;
        while (cursor !== undefined) {
            if (onPath.has(cursor)) {
                throw new Error("Estimate item parent chain is cyclic");
            }
            if (depths[cursor] >= 0) break;
            path.push(cursor);
            onPath.add(cursor);
            const parentId: string | null = items[cursor].parentId ? String(items[cursor].parentId) : null;
            cursor = parentId ? indexById.get(parentId) : undefined;
        }
        // path runs deepest-first (start ... topmost). Assign from the topmost down.
        let depth = cursor === undefined ? 0 : depths[cursor] + 1;
        for (let k = path.length - 1; k >= 0; k--) {
            depths[path[k]] = depth;
            depth++;
        }
    }
    return depths;
}

/**
 * Reject any submitted `parentId` that does not name a row of THIS estimate.
 *
 * `EstimateItem.parentId` is a self-referencing FK with no estimate-scope constraint, so the
 * database happily accepts a child whose parent lives in a different estimate. That is not a
 * cosmetic problem: `computeEstimateItemTotals` walks parent/child to roll section headers up,
 * the subtotal drives `totalAmount` -> tax -> payment milestones, and `selectedBillableRows`
 * resolves a selected header to its descendant leaves. A cross-estimate link therefore lets one
 * estimate's money be computed over another estimate's tree.
 *
 * In scope = the ids already persisted under this estimate, plus the ids submitted in this same
 * payload (a brand-new section and its brand-new children arrive together, and neither is
 * persisted yet). A submitted id that is really some other estimate's row cannot smuggle itself
 * in that way: it is absent from `existingItemsMap`, so it routes to `create`, and the create
 * fails on the primary-key unique constraint.
 *
 * Cycles are rejected too, by `resolveItemDepths` — a row that is its own parent gets its own
 * message because it is the one cycle a caller can produce by mis-wiring a single field.
 */
export function assertEstimateItemParentsInScope(
    items: readonly { id?: string | null; parentId?: string | null }[],
    existingItemIds: Iterable<string>,
): void {
    const inScope = new Set<string>(existingItemIds);
    for (const item of items) {
        if (item.id) inScope.add(String(item.id));
    }

    for (const item of items) {
        const parentId = item.parentId ? String(item.parentId) : null;
        if (!parentId) continue;
        if (item.id && String(item.id) === parentId) {
            throw new Error("Estimate item cannot be its own parent");
        }
        if (!inScope.has(parentId)) {
            throw new Error("Estimate item parent does not belong to this estimate");
        }
    }

    resolveItemDepths(items);
}

/**
 * Upserts every incoming line item, ancestors before descendants (so a child's `parentId` FK
 * always resolves to an already-written row). Assumes the caller has already taken the
 * `Estimate.itemsRevision` compare-and-set — this function does not throw on conflicts because
 * there is nothing left to conflict with by the time it runs.
 *
 * - Existing row (`item.id && existingItemsMap.has(item.id)`): plain `update`.
 * - New row: `create`, id-specifying so undo-of-delete can re-create rows under their original
 *   ids.
 *
 * Ordering is by tree depth, not by a flat roots-then-everything-else split. That split only ever
 * guaranteed ONE level: a brand-new three-level section (grandparent/parent/child all new) whose
 * rows happened to arrive deepest-first put the grandchild's `create` before its parent's, and
 * the FK rejected it. Depth grouping holds at any nesting level, whatever order the payload is in.
 *
 * The `order` fallback stays per-group, so it now restarts per depth level. It only applies when a
 * row carries no explicit `order`; the editor always sends one (`serializeEstimateItemsForSave`).
 */
export async function upsertEstimateItems(
    tx: EstimateItemTxClient,
    { estimateId, items, existingItemsMap }: {
        estimateId: string;
        items: any[];
        existingItemsMap: Map<string, ExistingEstimateItem>;
    },
): Promise<void> {
    const depths = resolveItemDepths(items);
    const groups: any[][] = [];
    items.forEach((item: any, index: number) => {
        (groups[depths[index]] ??= []).push(item);
    });

    for (const group of groups) {
        if (!group) continue;
        for (let idx = 0; idx < group.length; idx++) {
            const item = group[idx];
            const { id, ...itemData } = {
                ...normalizeEstimateItemForSave(item, idx),
                estimateId,
            };

            if (item.id && existingItemsMap.has(item.id)) {
                await tx.estimateItem.update({
                    where: { id: item.id },
                    data: itemData,
                });
            } else {
                await tx.estimateItem.create({
                    data: { id, ...itemData },
                });
            }
        }
    }
}
