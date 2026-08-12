/**
 * Core logic behind markPurchaseReviewed (src/lib/actions.ts) — factored out
 * with dependency injection so the SyncToken fencing and concurrent-insert
 * no-op behavior are unit-testable without a live database or QBO connection
 * (same shape as src/lib/qbo-receipt-push.ts / qbo-expense-sync.ts).
 *
 * Authorization (financialReports permission) and reviewer-identity
 * resolution from the session stay in actions.ts, which is the only caller —
 * this module never trusts a caller-supplied reviewer identity, but it also
 * doesn't re-derive one; it takes an already-authorized `reviewer` as input.
 */

export interface PurchaseReviewRow {
    qboPurchaseId: string;
    qboSyncToken: string;
    reviewerName: string;
    reviewedAt: Date;
}

/** Minimal shape of the Prisma PurchaseReview delegate this module needs. */
export interface PurchaseReviewClient {
    create(args: {
        data: { qboPurchaseId: string; qboSyncToken: string; reviewerId: string; reviewerName: string };
    }): Promise<PurchaseReviewRow>;
    findUnique(args: {
        where: { qboPurchaseId_qboSyncToken: { qboPurchaseId: string; qboSyncToken: string } };
    }): Promise<PurchaseReviewRow | null>;
}

export type MarkPurchaseReviewedResult =
    | { ok: true; reviewedAt: string; reviewerName: string }
    | { ok: false; reason: "stale-sync-token"; currentSyncToken: string }
    | { ok: false; reason: "purchase-not-found" };

function isUniqueConstraintError(error: unknown): boolean {
    return !!error && typeof error === "object" && (error as { code?: unknown }).code === "P2002";
}

/**
 * Stamp a QBO Purchase as human-reviewed. Re-reads the purchase's CURRENT
 * SyncToken (via `getCurrentSyncToken`) before writing anything — a mismatch
 * against `expectedSyncToken` (the version the reviewer actually saw
 * rendered) means the record changed under them, so this rejects rather than
 * certifying a version they never saw. A concurrent duplicate insert for the
 * exact same (purchase, SyncToken) is a no-op, not an error — two reviewers
 * clicking at once both succeed with the same stamp.
 */
export async function markPurchaseReviewedCore(
    deps: {
        client: PurchaseReviewClient;
        getCurrentSyncToken: (qboPurchaseId: string) => Promise<string | null>;
    },
    reviewer: { id: string; name: string },
    qboPurchaseId: string,
    expectedSyncToken: string,
): Promise<MarkPurchaseReviewedResult> {
    const purchaseId = qboPurchaseId.trim();
    const syncToken = expectedSyncToken.trim();
    if (!purchaseId || !syncToken) {
        throw new Error("Purchase id and SyncToken are required");
    }

    const currentSyncToken = await deps.getCurrentSyncToken(purchaseId);
    if (currentSyncToken === null) {
        return { ok: false, reason: "purchase-not-found" };
    }
    if (currentSyncToken !== syncToken) {
        return { ok: false, reason: "stale-sync-token", currentSyncToken };
    }

    try {
        const review = await deps.client.create({
            data: {
                qboPurchaseId: purchaseId,
                qboSyncToken: syncToken,
                reviewerId: reviewer.id,
                reviewerName: reviewer.name,
            },
        });
        return { ok: true, reviewedAt: review.reviewedAt.toISOString(), reviewerName: review.reviewerName };
    } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        // Concurrent duplicate for the exact same (purchase, SyncToken) — a
        // no-op, not a failure. Re-read whichever row won the race.
        const existing = await deps.client.findUnique({
            where: { qboPurchaseId_qboSyncToken: { qboPurchaseId: purchaseId, qboSyncToken: syncToken } },
        });
        if (existing) {
            return { ok: true, reviewedAt: existing.reviewedAt.toISOString(), reviewerName: existing.reviewerName };
        }
        throw error;
    }
}
