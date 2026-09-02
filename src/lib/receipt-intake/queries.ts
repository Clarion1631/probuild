/**
 * The one place that decides which ReceiptIntake columns leave the server.
 *
 * Phase 2's /automation Receipts tab reuses this unchanged, so the list route
 * and the page can never disagree about what a row is. `readJson` is
 * deliberately absent: it is the raw model output, kept for audit, and nothing
 * outside the worker should read from it.
 */
import { prisma } from "@/lib/prisma";

export const RECEIPT_INTAKE_LIST_SELECT = {
    id: true,
    source: true,
    sourceRef: true,
    state: true,
    dryRun: true,
    stateReason: true,
    projectId: true,
    costCodeId: true,
    suggestedCostCodeId: true,
    suggestedConfidence: true,
    createdById: true,
    storagePath: true,
    fileName: true,
    mimeType: true,
    fileSize: true,
    fileSha256: true,
    vendor: true,
    txnDate: true,
    totalCents: true,
    taxCents: true,
    docType: true,
    refNumber: true,
    memo: true,
    readAt: true,
    dedupStrongKey: true,
    dedupWeakKey: true,
    duplicateOfId: true,
    qbPurchaseId: true,
    expenseId: true,
    archiveDriveFileId: true,
    attempts: true,
    lastError: true,
    nextRetryAt: true,
    bookedAt: true,
    createdAt: true,
    updatedAt: true,
} as const;

export const MAX_LIST_TAKE = 200;
export const DEFAULT_LIST_TAKE = 50;

export interface ListReceiptIntakesArgs {
    state?: string | null;
    projectId?: string | null;
    take?: number | null;
}

/** Newest first. `take` is clamped, never trusted from the query string. */
export async function listReceiptIntakes(args: ListReceiptIntakesArgs) {
    const take = Math.min(
        MAX_LIST_TAKE,
        Math.max(1, Number.isFinite(Number(args.take)) && Number(args.take) > 0
            ? Math.floor(Number(args.take))
            : DEFAULT_LIST_TAKE),
    );
    return prisma.receiptIntake.findMany({
        where: {
            ...(args.state ? { state: args.state } : {}),
            ...(args.projectId ? { projectId: args.projectId } : {}),
        },
        orderBy: { createdAt: "desc" },
        take,
        select: RECEIPT_INTAKE_LIST_SELECT,
    });
}

/** Dates out as ISO strings; there are no Decimals on this model, cents are Ints. */
export function serializeReceiptIntake<T extends Record<string, unknown>>(row: T) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
        out[key] = value instanceof Date ? value.toISOString() : value;
    }
    return out;
}
