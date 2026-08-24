import { prisma } from "@/lib/prisma";

export type CostCodeResolution =
    | { ok: true; costCodeId: string; costTypeId: string | null }
    | { ok: false; status: number; error: string };

/**
 * The read surface needed to resolve a cost code. Kept narrow so the resolver can be
 * tested without a database; production uses the Prisma-backed default below.
 */
export type CostCodeLookup = {
    costCode: {
        findUnique(args: {
            where: { id: string };
            select: { id: true; isActive: true };
        }): Promise<{ id: string; isActive: boolean } | null>;
    };
    estimateItem: {
        findUnique(args: {
            where: { id: string };
            select: {
                costCodeId: true;
                costTypeId: true;
                costCode: { select: { isActive: true } };
            };
        }): Promise<{
            costCodeId: string | null;
            costTypeId: string | null;
            costCode: { isActive: boolean } | null;
        } | null>;
    };
};

const prismaCostCodeLookup: CostCodeLookup = {
    costCode: {
        findUnique: (args) => prisma.costCode.findUnique(args),
    },
    estimateItem: {
        findUnique: (args) => prisma.estimateItem.findUnique(args),
    },
};

/**
 * Resolve and validate the cost code for a posting (time entry OR expense).
 *
 * Job-costing gate: a posting is "coded" iff it ends up pointing at an ACTIVE CostCode.
 * Precedence:
 *   1. An explicit `costCodeId` (validated for existence + active).
 *   2. Otherwise derive the code from the chosen estimate line item (`lineItemId`) — the
 *      item's linked cost code. This makes coding server-authoritative instead of relying
 *      on the client to match codes by string (the old mobile behaviour silently dropped
 *      the code when its fuzzy match missed).
 * If neither yields an active cost code, the posting is rejected so uncoded labour/spend
 * can never reach the job ledger.
 *
 * `lineItemId` is an EstimateItem id (mobile sends estimateItemId for time, itemId for
 * expenses — same table). Scoping the item to the right project/estimate is the caller's
 * job; this only guarantees the cost-code attribution.
 */
export async function resolveCostCode(
    input: {
        costCodeId?: string | null;
        lineItemId?: string | null;
    },
    db: CostCodeLookup = prismaCostCodeLookup
): Promise<CostCodeResolution> {
    if (input.costCodeId) {
        const cc = await db.costCode.findUnique({
            where: { id: input.costCodeId },
            select: { id: true, isActive: true },
        });
        if (!cc) return { ok: false, status: 400, error: "Cost code not found." };
        if (!cc.isActive) return { ok: false, status: 400, error: "That cost code is inactive." };
        return { ok: true, costCodeId: cc.id, costTypeId: null };
    }

    if (input.lineItemId) {
        const item = await db.estimateItem.findUnique({
            where: { id: input.lineItemId },
            select: {
                costCodeId: true,
                costTypeId: true,
                costCode: { select: { isActive: true } },
            },
        });
        if (!item) return { ok: false, status: 400, error: "Line item not found." };
        if (!item.costCodeId) {
            return {
                ok: false,
                status: 400,
                error:
                    "This line item isn't linked to a cost code. Pick a coded line item, or set its cost code on the estimate first.",
            };
        }
        if (item.costCode && !item.costCode.isActive) {
            return { ok: false, status: 400, error: "This line item's cost code is inactive." };
        }
        return { ok: true, costCodeId: item.costCodeId, costTypeId: item.costTypeId ?? null };
    }

    return {
        ok: false,
        status: 400,
        error:
            "A cost code is required so this can post to the job. Select a cost code or a coded line item.",
    };
}
