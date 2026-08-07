// Shared normalization for the item <-> purchase order relationship on estimate items.
// EstimateItem.purchaseOrderId/purchaseOrder is the deprecated single-PO mirror; the
// many-to-many source of truth is item.purchaseOrderLinks. Until every item has been
// backfilled into the join table, an item may still only carry the legacy scalar link.
// This normalizes both shapes into one so every consumer (budget strip, AI lock, delete
// snapshot, expenses tab) can read `item.purchaseOrderLinks` and `link.purchaseOrder.id`
// uniformly, whether the link came from the join table or the legacy fallback.

/**
 * If `item.purchaseOrderLinks` is empty/absent and the legacy `item.purchaseOrder` scalar
 * mirror is set, synthesize a single-entry `purchaseOrderLinks` array from it. Must be
 * applied once at load (wherever server item data enters client state) — not at render
 * time — so every consumer (including snapshots taken for undo/AI-lock purposes) sees the
 * link.
 */
export function normalizeItemPoLinks<T extends { purchaseOrderLinks?: any[] | null; purchaseOrder?: any }>(item: T): T {
    if ((item.purchaseOrderLinks?.length ?? 0) > 0) return item;
    if (!item.purchaseOrder) return item;
    return {
        ...item,
        purchaseOrderLinks: [{ purchaseOrder: item.purchaseOrder }],
    };
}
