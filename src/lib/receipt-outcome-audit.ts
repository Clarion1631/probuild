/**
 * Server wrapper for the receipt-outcome audit.
 *
 * The summariser is the pure module at scripts/lib/receipt-outcome-audit.mjs.
 * This file only (1) reads the narrow persisted cohort from Prisma inside a
 * read-only transaction, (2) hands a JSON-safe snapshot to the summariser and
 * (3) formats the result for the digest. Nothing here touches the database on
 * import: the Prisma client is imported lazily inside the production reader.
 *
 * Failure is never disguised as zero. A reader error yields null counts and
 * collectionStatus "unavailable" with a static message (no raw diagnostics).
 */
import { Prisma } from "@prisma/client";
import { auditReceiptOutcomes } from "../../scripts/lib/receipt-outcome-audit.mjs";

export const RECEIPT_OUTCOME_SCOPE = "persisted-request-cohort";
export const RECEIPT_OUTCOME_HEADING = "Receipt follow-up: what is finished?";
/** Operational limit, not a date/eligibility filter. Read one extra row to detect overflow.
 * At most 6,003 narrowly selected records can enter one scheduled audit.
 * Never summarize a truncated history: reaching this limit requires a scoped audit design.
 */
export const RECEIPT_OUTCOME_ROW_LIMIT = 2_000;
/** Static, PII-free. Raw reader errors are deliberately not surfaced. */
export const RECEIPT_OUTCOME_UNAVAILABLE = "receipt outcome evidence could not be read";

export interface ReceiptOutcomeCounts {
    eligibleRequests: number | null;
    observedTargets: number | null;
    postedToChat: number | null;
    deliveredToPurchaser: number | null;
    awaitingPurchaser: number | null;
    signedArtifactsRecorded: number | null;
    filedInProbuild: number | null;
    bridgeAck: number | null;
    unresolved: number | null;
    pending: number | null;
    retry: number | null;
    error: number | null;
    closedWithoutMemo: number | null;
}

export interface ReceiptOutcomeSnapshot {
    capturedAt: string;
    scope: string;
    issues: unknown[] | null;
    cards: unknown[] | null;
    artifacts: unknown[] | null;
}

export interface ReceiptOutcomeReport {
    counts: ReceiptOutcomeCounts;
    rows: unknown[];
    evidenceErrors: unknown[];
    [extra: string]: unknown;
}

export type ReceiptOutcomeAudit =
    | (ReceiptOutcomeReport & { collectionStatus: "available" })
    | (ReceiptOutcomeReport & { collectionStatus: "unavailable"; collectionError: string });

/** What the reader returns: the three narrow projections, Dates still live. */
export interface ReceiptOutcomeRawSnapshot {
    issues: unknown[];
    cards: unknown[];
    artifacts: unknown[];
}

export interface ReceiptOutcomeAuditDependencies {
    /** Test seam. Production reads via Prisma (lazily imported). */
    readSnapshot?: () => Promise<ReceiptOutcomeRawSnapshot>;
    now?: () => Date;
}

const summarize = auditReceiptOutcomes as (
    snapshot: ReceiptOutcomeSnapshot,
    nowISO: string,
) => ReceiptOutcomeReport;

/**
 * Read-only, narrow, bounded. Three SELECTs in one RepeatableRead transaction
 * so the cohort is a single consistent picture; SET TRANSACTION READ ONLY is
 * issued first so nothing in here can ever write.
 */
async function readProductionSnapshot(): Promise<ReceiptOutcomeRawSnapshot> {
    const { prisma } = await import("@/lib/prisma");
    return prisma.$transaction(
        async (tx: Prisma.TransactionClient) => {
            await tx.$executeRaw`SET TRANSACTION READ ONLY`;
            const [issues, cards, artifacts] = await Promise.all([
                tx.reviewIssue.findMany({
                    take: RECEIPT_OUTCOME_ROW_LIMIT + 1,
                    orderBy: { id: "asc" },
                    where: { targetType: "bank-line" },
                    select: {
                        id: true,
                        targetType: true,
                        targetKey: true,
                        displayDetails: true,
                        firstObservedAt: true,
                        clearedAt: true,
                        createdAt: true,
                    },
                }),
                tx.receiptRequestCard.findMany({
                    take: RECEIPT_OUTCOME_ROW_LIMIT + 1,
                    orderBy: { id: "asc" },
                    select: {
                        id: true,
                        itemsJson: true,
                        status: true,
                        postedAt: true,
                        threadName: true,
                        messageName: true,
                        attempts: true,
                        lastError: true,
                        resendQueuedAt: true,
                        createdAt: true,
                    },
                }),
                tx.receiptMemoArtifact.findMany({
                    take: RECEIPT_OUTCOME_ROW_LIMIT + 1,
                    orderBy: { id: "asc" },
                    where: { targetType: "bank-line" },
                    select: {
                        id: true,
                        pdfId: true,
                        targetType: true,
                        targetKey: true,
                        issueId: true,
                        createdAt: true,
                    },
                }),
            ]);
            return { issues, cards, artifacts };
        },
        {
            maxWait: 2_000,
            timeout: 8_000,
            isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        },
    );
}

/** The honest failure shape: every count null, never zero. */
export function unavailableReceiptOutcomeAudit(nowISO: string): ReceiptOutcomeAudit {
    const empty: ReceiptOutcomeSnapshot = {
        capturedAt: nowISO,
        scope: RECEIPT_OUTCOME_SCOPE,
        issues: null,
        cards: null,
        artifacts: null,
    };
    let report: ReceiptOutcomeReport;
    try {
        report = summarize(empty, nowISO);
    } catch {
        report = { counts: nullCounts(), rows: [], evidenceErrors: [] };
    }
    return { ...report, collectionStatus: "unavailable", collectionError: RECEIPT_OUTCOME_UNAVAILABLE };
}

function nullCounts(): ReceiptOutcomeCounts {
    return {
        eligibleRequests: null,
        observedTargets: null,
        postedToChat: null,
        deliveredToPurchaser: null,
        awaitingPurchaser: null,
        signedArtifactsRecorded: null,
        filedInProbuild: null,
        bridgeAck: null,
        unresolved: null,
        pending: null,
        retry: null,
        error: null,
        closedWithoutMemo: null,
    };
}

export async function loadReceiptOutcomeAudit(
    dependencies: ReceiptOutcomeAuditDependencies = {},
): Promise<ReceiptOutcomeAudit> {
    const nowISO = (dependencies.now ?? (() => new Date()))().toISOString();
    const read = dependencies.readSnapshot ?? readProductionSnapshot;

    let raw: ReceiptOutcomeRawSnapshot;
    try {
        raw = await read();
    } catch {
        return unavailableReceiptOutcomeAudit(nowISO);
    }
    if (!raw || !Array.isArray(raw.issues) || !Array.isArray(raw.cards) || !Array.isArray(raw.artifacts)) {
        return unavailableReceiptOutcomeAudit(nowISO);
    }
    if ([raw.issues, raw.cards, raw.artifacts].some(rows => rows.length > RECEIPT_OUTCOME_ROW_LIMIT)) {
        return { ...unavailableReceiptOutcomeAudit(nowISO), collectionError: "receipt-outcome-row-limit" };
    }

    // Date objects become ISO strings here, so the pure summariser only ever
    // sees the same JSON shape the CLI collector hands it.
    try {
        const snapshot: ReceiptOutcomeSnapshot = JSON.parse(JSON.stringify({
            capturedAt: nowISO,
            scope: RECEIPT_OUTCOME_SCOPE,
            issues: raw.issues,
            cards: raw.cards,
            artifacts: raw.artifacts,
        }));
        const report = summarize(snapshot, nowISO);
        return { ...report, collectionStatus: "available" };
    } catch {
        return unavailableReceiptOutcomeAudit(nowISO);
    }
}

function show(value: number | null | undefined): string {
    return value === null || value === undefined ? "unknown" : String(value);
}

function line(label: string, value: number | null | undefined, note?: string): string {
    return `  ${label}: ${show(value)}${note ? ` (${note})` : ""}`;
}

function evidenced(label: string, value: number | null | undefined): string {
    return value === null || value === undefined
        ? line(label, value, "not shown by these records")
        : line(label, value);
}

/**
 * Short plain-text block for the digest. No percentages, no IDs, no names:
 * counts only, with null shown as "unknown" so a broken reader can never
 * pass for a quiet night.
 */
export function formatReceiptOutcomeAudit(report: ReceiptOutcomeAudit): string {
    const c: Partial<ReceiptOutcomeCounts> = report?.counts ?? {};
    const lines: string[] = [RECEIPT_OUTCOME_HEADING];
    if (report?.collectionStatus === "unavailable") {
        lines.push(report.collectionError === "receipt-outcome-row-limit"
            ? "  UNAVAILABLE: too many records for this scheduled check. No partial totals are shown."
            : "  UNAVAILABLE: these records could not be checked. Counts below are unknown, not zero.");
    }
    lines.push(
        "  Covers charges already recorded in ProBuild; other requests may be missing.",
        line("Charges checked", c.observedTargets),
        line("Requests sent to Chat", c.postedToChat),
        line("Waiting for purchaser", c.awaitingPurchaser),
        line("Signed statements on file", c.filedInProbuild),
        line("Still open", c.unresolved),
        line("Waiting to resend", c.retry),
        line("Sending problems", c.error),
        line("Records needing review", report.collectionStatus === "unavailable" ? null : report.evidenceErrors.length),
        evidenced("All requests needing a receipt", c.eligibleRequests),
        evidenced("Reached the purchaser", c.deliveredToPurchaser),
        evidenced("Return confirmation saved", c.bridgeAck),
        "  A signed statement on file does not confirm QuickBooks entry or finished job costing.",
        "  An automatic check running successfully does not mean the receipt work is finished.",
    );
    return lines.join("\n");
}
