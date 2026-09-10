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
import { requestIdFor } from "./receipt-request-cards";
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

export type ReceiptOutcomeEvidence = "absent" | "conflict" | "unavailable" | "verified";

/** A provider-verified request card that named this target. Nothing else about the card is exposed. */
export interface ReceiptOutcomeCardAssociation {
    cardId: string;
    requestId: string;
    threadName: string;
    messageName: string;
    postedAt: string;
    itemNumber: number;
    fingerprint: string;
}

export interface ReceiptOutcomeAssociations {
    /** null when association evidence is unavailable or conflicting (never a partial list). */
    cards: ReceiptOutcomeCardAssociation[] | null;
    cardEvidence: ReceiptOutcomeEvidence;
    /** Present only when the summariser accepted exactly one artifact for this target. createdAt is null if unparseable or future. */
    filedArtifact: { pdfId: string; createdAt: string | null } | null;
    artifactEvidence: ReceiptOutcomeEvidence;
}

export interface ReceiptOutcomeRow {
    targetKey: string;
    issueId: string | null;
    requestCardIds: string[];
    stage: string;
    postedToChat: boolean | null;
    deliveredToPurchaser: null;
    signedArtifactRecorded: boolean | null;
    filedInProbuild: boolean | null;
    bridgeAck: null;
    elapsedMs: number | null;
    flags: string[];
    associations: ReceiptOutcomeAssociations;
}

export interface ReceiptOutcomeReport {
    counts: ReceiptOutcomeCounts;
    rows: ReceiptOutcomeRow[];
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
                        // owner + pacificDate are read ONLY to derive requestId in normalizeCard; neither reaches the summariser.
                        owner: true,
                        pacificDate: true,
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

const OWNER_SHAPE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const DATE_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Validate inputs, then use the same request id helper as the bridge.
 * Returns null (never a guess) when owner or date is not a valid input for that contract.
 */
export function receiptRequestId(owner: unknown, pacificDate: unknown): string | null {
    if (typeof owner !== "string" || !OWNER_SHAPE.test(owner)) return null;
    if (typeof pacificDate !== "string") return null;
    const m = DATE_SHAPE.exec(pacificDate);
    if (!m) return null;
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    const t = new Date(Date.UTC(y, mo - 1, d));
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
    return requestIdFor(owner, pacificDate);
}

/** Server normalisation: replace owner/pacificDate with the derived requestId (or null). Any raw requestId is ignored. */
function normalizeCard(card: unknown): unknown {
    if (card === null || typeof card !== "object" || Array.isArray(card)) return card;
    const { owner, pacificDate, ...rest } = card as Record<string, unknown>;
    return { ...rest, requestId: receiptRequestId(owner, pacificDate) };
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
    const clock = dependencies.now ?? (() => new Date());
    // The snapshot clock is observed AFTER the read settles (success or failure):
    // capturedAt is the end-of-collection observation, not the transaction start,
    // so a card posted while the consistent read was running is never judged
    // "future". The injected clock is therefore called only after the await.
    const observeNow = (): string => clock().toISOString();
    const read = dependencies.readSnapshot ?? readProductionSnapshot;

    let raw: ReceiptOutcomeRawSnapshot;
    try {
        raw = await read();
    } catch {
        return unavailableReceiptOutcomeAudit(observeNow());
    }
    const nowISO = observeNow();
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
            cards: raw.cards.map(normalizeCard),
            artifacts: raw.artifacts,
        }));
        const report = summarize(snapshot, nowISO);
        return { ...report, collectionStatus: "available" };
    } catch {
        return unavailableReceiptOutcomeAudit(nowISO);
    }
}

/**
 * Per-target flags that mean two records contradict each other, so a human
 * must look. Deliberately excludes incompleteness-only states (no_request_card,
 * missing_issue, card_evidence_incomplete, *_evidence_unknown) and the
 * elapsed / timestamp-validity flags: those describe missing or odd timing
 * evidence, not a contradiction, and source-level problems are already counted
 * once through the global evidence errors below.
 */
const REVIEW_FLAGS: ReadonlySet<string> = new Set([
    "identity_conflict",
    "duplicate_open_issue",
    "artifact_conflict",
    "artifact_pdf_conflict",
    "artifact_pdf_mismatch",
    "resolution_without_artifact",
    "artifact_without_resolution",
    "artifact_without_issue",
    "memo_conflict",
    "issue_details_unknown",
    "posted_status_unverified",
    "card_status_unknown",
]);

/**
 * Evidence errors the summariser also records as a per-target flag. When a
 * counted target already carries the mapped flag, the error is the same
 * finding and is not counted a second time.
 */
const ERROR_TO_FLAGS: Readonly<Record<string, readonly string[]>> = {
    issue_identity_conflict: ["identity_conflict"],
    card_identity_conflict: ["identity_conflict"],
    artifact_identity_conflict: ["identity_conflict"],
    artifact_pdf_identity_conflict: ["artifact_pdf_conflict"],
    artifact_pdf_missing: ["artifact_conflict"],
    artifact_duplicate: ["artifact_conflict"],
    issue_details_malformed: ["issue_details_unknown"],
};

function isFlaggedRow(row: unknown): row is { targetKey: string; flags: string[] } {
    if (row === null || typeof row !== "object") return false;
    const r = row as { targetKey?: unknown; flags?: unknown };
    return typeof r.targetKey === "string" && r.targetKey.trim().length > 0
        && Array.isArray(r.flags)
        && r.flags.every(f => typeof f === "string");
}

/**
 * Distinct targets carrying at least one contradiction flag, plus each distinct
 * global evidence error not already represented by a flagged target. A target
 * with several flags, repeated rows for one target, or an error that is also a
 * flag on a counted target all count once. Counts only: never echoes keys, ids
 * or raw error text. Null (shown as "unknown") when the read failed.
 */
export function countRecordsNeedingReview(report: ReceiptOutcomeAudit): number | null {
    if (!report || report.collectionStatus === "unavailable") return null;
    if (!Array.isArray(report.rows) || !Array.isArray(report.evidenceErrors)) return null;
    const rows: unknown[] = Array.isArray(report.rows) ? report.rows : [];
    const errors: unknown[] = Array.isArray(report.evidenceErrors) ? report.evidenceErrors : [];

    const flaggedTargets = new Set<string>();
    const seenFlags = new Set<string>();
    let malformedRows = 0;
    for (const row of rows) {
        if (!isFlaggedRow(row)) { malformedRows = 1; continue; }
        const hits = row.flags.filter(f => REVIEW_FLAGS.has(f));
        if (hits.length === 0) continue;
        flaggedTargets.add(row.targetKey);
        for (const f of hits) seenFlags.add(f);
    }

    const countedErrors = new Set<string>();
    let unrecognized = 0;
    for (const err of errors) {
        if (typeof err !== "string") { unrecognized = 1; continue; }
        const mapped = Object.prototype.hasOwnProperty.call(ERROR_TO_FLAGS, err) ? ERROR_TO_FLAGS[err] : undefined;
        if (mapped && mapped.some(f => seenFlags.has(f))) continue;
        countedErrors.add(err);
    }
    return flaggedTargets.size + countedErrors.size + unrecognized + malformedRows;
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
        line("Records needing review", countRecordsNeedingReview(report)),
        evidenced("All requests needing a receipt", c.eligibleRequests),
        evidenced("Reached the purchaser", c.deliveredToPurchaser),
        evidenced("Return confirmation saved", c.bridgeAck),
        "  A signed statement on file does not confirm QuickBooks entry or finished job costing.",
        "  An automatic check running successfully does not mean the receipt work is finished.",
    );
    return lines.join("\n");
}
