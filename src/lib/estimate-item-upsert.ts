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
 * Upserts every incoming line item, parents before children (so a child's `parentId` FK always
 * resolves to an already-written row). Assumes the caller has already taken the
 * `Estimate.itemsRevision` compare-and-set — this function does not throw on conflicts because
 * there is nothing left to conflict with by the time it runs.
 *
 * - Existing row (`item.id && existingItemsMap.has(item.id)`): plain `update`.
 * - New row: `create`, id-specifying so undo-of-delete can re-create rows under their original
 *   ids.
 */
export async function upsertEstimateItems(
    tx: EstimateItemTxClient,
    { estimateId, items, existingItemsMap }: {
        estimateId: string;
        items: any[];
        existingItemsMap: Map<string, ExistingEstimateItem>;
    },
): Promise<void> {
    const parentItems = items.filter((i: any) => !i.parentId);
    const childItems = items.filter((i: any) => i.parentId);

    for (const group of [parentItems, childItems]) {
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
