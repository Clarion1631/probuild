export type DepositReviewItem = {
    id: string;
    status: string;
    fileId: string | null;
    fileUrl: string | null;
    projectName: string | null;
    payerName: string | null;
    amountCents: number | null;
    checkDate: string | null;
    checkNumber: string | null;
    paymentScheduleId: string | null;
    qbPaymentId: string | null;
    officeTaskId: string | null;
    attempts: number;
    reason: string | null;
    updatedAt: string;
};

type DepositReviewSource = {
    id: string;
    status: string;
    extracted: string;
    paymentScheduleId: string | null;
    qbPaymentId: string | null;
    officeTaskId: string | null;
    attempts: number;
    lastError: string | null;
    createdAt: Date;
    updatedAt: Date;
};

type ExtractedDeposit = {
    fileId?: unknown;
    fileUrl?: unknown;
    projectName?: unknown;
    payerName?: unknown;
    amount?: unknown;
    checkDate?: unknown;
    checkNumber?: unknown;
};

function boundedText(value: unknown, max: number): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed && trimmed.length <= max ? trimmed : null;
}

function toCents(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
    const cents = Math.round(value * 100);
    return Math.abs(value * 100 - cents) <= 1e-6 && Number.isSafeInteger(cents) ? cents : null;
}

/**
 * Converts the bot's immutable JSON snapshot into display/API data. The snapshot
 * is untrusted historical input: parse failures and unexpected fields become
 * null, never an invented payment fact. This is deliberately read-only; humans
 * resolve a deposited exception through its Office task, not this surface.
 */
export function toDepositReviewItem(row: DepositReviewSource): DepositReviewItem {
    let extracted: ExtractedDeposit = {};
    try {
        const parsed: unknown = JSON.parse(row.extracted);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            extracted = parsed as ExtractedDeposit;
        }
    } catch {
        // A corrupt snapshot is a review fact, not a reason to hide the row.
    }

    return {
        id: row.id,
        status: row.status,
        fileId: boundedText(extracted.fileId, 200),
        fileUrl: boundedText(extracted.fileUrl, 2_000),
        projectName: boundedText(extracted.projectName, 300),
        payerName: boundedText(extracted.payerName, 300),
        amountCents: toCents(extracted.amount),
        checkDate: boundedText(extracted.checkDate, 10),
        checkNumber: boundedText(extracted.checkNumber, 100),
        paymentScheduleId: row.paymentScheduleId,
        qbPaymentId: row.qbPaymentId,
        officeTaskId: row.officeTaskId,
        attempts: row.attempts,
        reason: row.lastError,
        updatedAt: row.updatedAt.toISOString(),
    };
}
