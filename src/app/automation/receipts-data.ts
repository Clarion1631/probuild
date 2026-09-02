/**
 * Receipts-tab data loader — the Prisma glue, kept out of `page.tsx` in the
 * same shape as `register-data.ts`.
 *
 * It reuses `RECEIPT_INTAKE_LIST_SELECT` from the Phase 1 intake module, which
 * exists for exactly this: the list API and this page can never disagree about
 * what a row is, because there is only one field list.
 */
import { prisma } from "@/lib/prisma";
import { RECEIPT_INTAKE_LIST_SELECT } from "@/lib/receipt-intake/queries";
import { POSSIBLE_ORPHAN_REASON } from "@/lib/receipt-intake/park";
import { decodeReasonCodes } from "@/lib/review-alert-reasons";
import { RECEIPT_REQUEST_TARGET_TYPE, effectiveOwner } from "@/lib/receipt-requests";
import { OPEN_PROJECT_STATUSES } from "@/lib/project-status";
import { missingReceiptMatchesFilters, ownerRank, type ReceiptFilters } from "./receipts-filters";

/** Per-group display cap. Badge counts come from count queries, never from these. */
export const RECEIPT_GROUP_TAKE = 100;

const NEEDS_REVIEW_STATES = ["NEEDS_REVIEW", "NON_RECEIPT"];
const BOOKED_STATES = ["BOOKED", "ARCHIVED"];

export type IntakeRow = {
    id: string;
    state: string;
    stateReason: string | null;
    source: string;
    projectId: string | null;
    projectName: string | null;
    costCodeId: string | null;
    vendor: string | null;
    txnDate: string | null;
    totalCents: number | null;
    fileName: string | null;
    storagePath: string;
    duplicateOfId: string | null;
    qbPurchaseId: string | null;
    /** A real QuickBooks Purchase for a row that was voided mid-send. Needs a
     * human to void it in QBO — nothing here can. */
    postVoidQbPurchaseId: string | null;
    attempts: number;
    lastError: string | null;
    nextRetryAt: string | null;
    bookedAt: string | null;
    createdAt: string;
    /**
     * The row version the human is looking at, ISO. Every queue action CASes on
     * it: the state alone cannot tell NEEDS_REVIEW from a later, different
     * NEEDS_REVIEW (the ABA problem), and a decision made about the first must
     * not silently apply to the second.
     */
    updatedAt: string;
};

export interface MissingReceiptRow {
    /** ReviewIssue id — the mark-reviewed contract's `id`. */
    id: string;
    version: number;
    reasonHash: string;
    acknowledged: boolean;
    /** BankLine id. */
    targetKey: string;
    owner: string;
    /** True when a human set the owner, not the descriptor. */
    ownerAssigned: boolean;
    cardTail: string | null;
    postedDate: string;
    amountCents: number;
    payee: string;
    rawDescriptor: string;
    fingerprint: string;
    /** Set once a Chat card listed this item. */
    threadName: string | null;
    /** Set once a memo was signed for it. */
    resolution: string | null;
    pdfUrl: string | null;
}

export type UncertainCardRow = {
    id: string;
    owner: string;
    /** YYYY-MM-DD Pacific — the day the card was for. */
    pacificDate: string;
    /** How many items the card listed. */
    items: number;
    attempts: number;
    lastError: string | null;
    /** The row version the human is looking at; the action CASes on it. */
    updatedAt: string;
};

export interface ReceiptQueue {
    needsJob: IntakeRow[];
    needsReview: IntakeRow[];
    booking: IntakeRow[];
    bookedToday: IntakeRow[];
    duplicates: IntakeRow[];
    /**
     * Rows carrying a QuickBooks Purchase that should not exist: the send went
     * out and the row was voided or re-classified before the booked write
     * landed. ANY state — most are VOID or DUPLICATE, which every other group
     * excludes, so before this group they were invisible and the orphaned
     * Purchase sat in QuickBooks forever.
     */
    exceptions: IntakeRow[];
    /**
     * Morning Chat cards we asked Google Chat to post and never got a confirmed
     * answer about. They are NEVER auto-retried — a duplicate chase card
     * teaches people the list is noise — so nothing clears them but a human
     * saying which way it went.
     */
    uncertainCards: UncertainCardRow[];
    missingReceipts: MissingReceiptRow[];
    counts: {
        needsJob: number;
        needsReview: number;
        booking: number;
        bookedToday: number;
        duplicates: number;
        exceptions: number;
        uncertainCards: number;
        /** The whole open missing-receipt queue, from a count query. */
        missingReceipts: number;
        /** How many of those this render is actually showing (owner filter + display cap). */
        missingReceiptsShown: number;
    };
}

/** A card row → the shape the tab renders. `itemsJson` is never sent to the browser. */
function toUncertainCardRow(row: {
    id: string; owner: string; pacificDate: string; itemsJson: string;
    attempts: number; lastError: string | null; updatedAt: Date;
}): UncertainCardRow {
    let items = 0;
    try {
        const parsed: unknown = JSON.parse(row.itemsJson);
        items = Array.isArray(parsed) ? parsed.length : 0;
    } catch {
        // A card whose snapshot will not parse still has to be resolvable — the
        // count is cosmetic, the row is not.
        items = 0;
    }
    return {
        id: row.id,
        owner: row.owner,
        pacificDate: row.pacificDate,
        items,
        attempts: row.attempts,
        lastError: row.lastError,
        updatedAt: row.updatedAt.toISOString(),
    };
}

const INTAKE_SELECT = {
    ...RECEIPT_INTAKE_LIST_SELECT,
    project: { select: { name: true } },
} as const;

type RawIntake = Awaited<ReturnType<typeof loadIntakes>>[number];

async function loadIntakes(where: Record<string, unknown>) {
    return prisma.receiptIntake.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: RECEIPT_GROUP_TAKE,
        select: INTAKE_SELECT,
    });
}

function toIntakeRow(row: RawIntake): IntakeRow {
    return {
        id: row.id,
        state: row.state,
        stateReason: row.stateReason,
        source: row.source,
        projectId: row.projectId,
        projectName: row.project?.name ?? null,
        costCodeId: row.costCodeId,
        vendor: row.vendor,
        txnDate: row.txnDate ? row.txnDate.toISOString().slice(0, 10) : null,
        totalCents: row.totalCents,
        fileName: row.fileName,
        storagePath: row.storagePath,
        duplicateOfId: row.duplicateOfId,
        qbPurchaseId: row.qbPurchaseId,
        postVoidQbPurchaseId: row.postVoidQbPurchaseId,
        attempts: row.attempts,
        lastError: row.lastError,
        nextRetryAt: row.nextRetryAt ? row.nextRetryAt.toISOString() : null,
        bookedAt: row.bookedAt ? row.bookedAt.toISOString() : null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

/**
 * Midnight Pacific as an instant, using the same en-CA / America/Los_Angeles
 * idiom page.tsx already uses to pick the register's end date. "Booked today"
 * has to mean the crew's today, not UTC's.
 */
export function pacificDayStart(now: Date = new Date()): Date {
    const ymd = now.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    // Offset for THAT date (so a DST boundary doesn't shift the start by an
    // hour): what UTC instant does Pacific midnight correspond to?
    const guess = new Date(`${ymd}T00:00:00Z`);
    const pacificOfGuess = new Date(guess.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
    const utcOfGuess = new Date(guess.toLocaleString("en-US", { timeZone: "UTC" }));
    return new Date(guess.getTime() + (utcOfGuess.getTime() - pacificOfGuess.getTime()));
}

/**
 * Parse a ReviewIssue's `displayDetails` blob defensively. It is a free-form
 * JSON string on a shared column — a corrupt or foreign shape must degrade to
 * a row with honest blanks, never throw and take the whole tab down.
 */
export function parseMissingReceiptDetails(json: string | null): Record<string, unknown> {
    if (!json) return {};
    try {
        const parsed: unknown = JSON.parse(json);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

function str(value: unknown): string | null {
    return typeof value === "string" && value !== "" ? value : null;
}

export function toMissingReceiptRow(issue: {
    id: string;
    targetKey: string;
    version: number;
    reasonHash: string;
    reasonCodes: string;
    acknowledgedCodes: string;
    displayDetails: string | null;
}): MissingReceiptRow {
    const details = parseMissingReceiptDetails(issue.displayDetails);
    const currentCodes = decodeReasonCodes(issue.reasonCodes);
    const acked = new Set(decodeReasonCodes(issue.acknowledgedCodes));
    const card = details.card && typeof details.card === "object" ? (details.card as Record<string, unknown>) : {};
    return {
        id: issue.id,
        version: issue.version,
        reasonHash: issue.reasonHash,
        // Mirrors decideLifecycle step 4 exactly — same test register-data.ts uses.
        acknowledged: currentCodes.length > 0 && currentCodes.every(code => acked.has(code)),
        targetKey: issue.targetKey,
        // ONE spelling of "whose is this", shared with the cron and matcher.
        owner: effectiveOwner(details),
        ownerAssigned: str(details.ownerOverride) !== null,
        cardTail: str(details.cardTail),
        postedDate: str(details.postedDate) ?? "",
        amountCents: typeof details.amountCents === "number" ? details.amountCents : 0,
        payee: str(details.payee) ?? "",
        rawDescriptor: str(details.rawDescriptor) ?? "",
        fingerprint: str(details.fingerprint) ?? `pb-${issue.targetKey}`,
        threadName: str(card.threadName),
        resolution: str(details.resolution),
        pdfUrl: str(details.pdfUrl),
    };
}

/** Page size for the owner-filtered scan. */
const ISSUE_SCAN_PAGE = 500;
/** Absolute stop, so a pathological backlog cannot hang a page render. */
const ISSUE_SCAN_MAX_PAGES = 40;

/**
 * Open missing-receipt issues, newest first, PAGED when an owner filter is set.
 *
 * Owner lives inside `displayDetails` — a TEXT column holding JSON — so it
 * cannot be a SQL predicate (a jsonb cast raises on one malformed row and would
 * take the whole tab down). Filtering a single 100-row page in memory therefore
 * rendered "no missing receipts for Richard" whenever his oldest item sat
 * outside the newest page: an empty queue that looked like good news.
 *
 * So an owner-filtered view keeps paging until it has a full display page for
 * that owner or the queue is exhausted, exactly as the card scan does.
 * Unfiltered, one page is the whole answer and nothing extra is read.
 */
async function scanMissingReceiptIssues(owner: string | null) {
    const where = { targetType: RECEIPT_REQUEST_TARGET_TYPE, clearedAt: null };
    const select = {
        id: true, targetKey: true, version: true, reasonHash: true,
        reasonCodes: true, acknowledgedCodes: true, displayDetails: true,
    } as const;

    if (owner === null) {
        return prisma.reviewIssue.findMany({ where, orderBy: { firstObservedAt: "desc" }, take: RECEIPT_GROUP_TAKE, select });
    }

    type IssueRow = { id: string; targetKey: string; version: number; reasonHash: string; reasonCodes: string; acknowledgedCodes: string; displayDetails: string | null };
    const matched: IssueRow[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < ISSUE_SCAN_MAX_PAGES && matched.length < RECEIPT_GROUP_TAKE; page++) {
        const rows = await prisma.reviewIssue.findMany({
            where,
            orderBy: [{ firstObservedAt: "desc" }, { id: "desc" }],
            take: ISSUE_SCAN_PAGE,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            select,
        });
        if (rows.length === 0) break;
        cursor = rows[rows.length - 1].id;
        for (const row of rows) {
            if (matched.length >= RECEIPT_GROUP_TAKE) break;
            if (effectiveOwner(parseMissingReceiptDetails(row.displayDetails)) === owner) matched.push(row);
        }
        if (rows.length < ISSUE_SCAN_PAGE) break;
    }
    return matched;
}

/**
 * The six groups plus their badge counts. Counts come from count queries so a
 * capped list can never understate the size of a queue.
 *
 * Filters are applied IN the query where they narrow a database read
 * (`projectId`), and in memory for the owner sub-grouping — a `ReviewIssue`'s
 * owner lives inside a JSON blob, which Postgres can't index here.
 */
export async function fetchReceiptQueue(filters: ReceiptFilters, now: Date = new Date()): Promise<ReceiptQueue> {
    const projectWhere = filters.projectId ? { projectId: filters.projectId } : {};
    const bookedSince = pacificDayStart(now);

    const needsJobWhere = { state: "NEEDS_JOB", ...projectWhere };
    const needsReviewWhere = { state: { in: NEEDS_REVIEW_STATES }, ...projectWhere };
    const bookingWhere = { state: "BOOKING", ...projectWhere };
    const bookedTodayWhere = { state: { in: BOOKED_STATES }, bookedAt: { gte: bookedSince }, ...projectWhere };
    const duplicatesWhere = { state: "DUPLICATE", ...projectWhere };
    // Deliberately NOT state-scoped: the whole point is the states the other
    // groups hide.
    //
    // TWO KINDS OF ORPHAN, and the second one is not optional. A row with
    // `postVoidQbPurchaseId` has a KNOWN Purchase behind it. A row parked by
    // hand after `sendAttempted` was set may have one — we never got the
    // response — so it kept its strong dedup key, and without surfacing it here
    // that quarantine would be invisible: the human would re-send the receipt,
    // watch it bounce as a duplicate, and have nothing telling them why.
    const exceptionsWhere = {
        OR: [
            { postVoidQbPurchaseId: { not: null } },
            { stateReason: { endsWith: `:${POSSIBLE_ORPHAN_REASON}` } },
        ],
        ...projectWhere,
    };
    const issueWhere = { targetType: RECEIPT_REQUEST_TARGET_TYPE, clearedAt: null };

    const [
        needsJob, needsReview, booking, bookedToday, duplicates, exceptions, issues,
        needsJobCount, needsReviewCount, bookingCount, bookedTodayCount, duplicatesCount, exceptionsCount, missingReceiptsCount,
        uncertainCardRows, uncertainCardCount,
    ] = await Promise.all([
        loadIntakes(needsJobWhere),
        loadIntakes(needsReviewWhere),
        loadIntakes(bookingWhere),
        loadIntakes(bookedTodayWhere),
        loadIntakes(duplicatesWhere),
        loadIntakes(exceptionsWhere),
        scanMissingReceiptIssues(filters.owner),
        prisma.receiptIntake.count({ where: needsJobWhere }),
        prisma.receiptIntake.count({ where: needsReviewWhere }),
        prisma.receiptIntake.count({ where: bookingWhere }),
        prisma.receiptIntake.count({ where: bookedTodayWhere }),
        prisma.receiptIntake.count({ where: duplicatesWhere }),
        prisma.receiptIntake.count({ where: exceptionsWhere }),
        prisma.reviewIssue.count({ where: issueWhere }),
        // NOT project-scoped: a card is per OWNER, not per job, so a project
        // filter cannot narrow it without hiding it entirely.
        prisma.receiptRequestCard.findMany({
            where: { status: "UNCERTAIN" },
            orderBy: [{ pacificDate: "desc" }, { owner: "asc" }],
            take: RECEIPT_GROUP_TAKE,
            select: {
                id: true, owner: true, pacificDate: true, itemsJson: true,
                attempts: true, lastError: true, updatedAt: true,
            },
        }),
        prisma.receiptRequestCard.count({ where: { status: "UNCERTAIN" } }),
    ]);

    const missingReceipts = issues
        // An issue whose codes decode to [] is "cleared" as far as the
        // lifecycle is concerned (decodeReasonCodes drops unknown codes) — it
        // must not render as an open chase.
        .filter(issue => decodeReasonCodes(issue.reasonCodes).length > 0)
        .map(toMissingReceiptRow)
        .filter(row => missingReceiptMatchesFilters(row, filters))
        .sort((a, b) => ownerRank(a.owner) - ownerRank(b.owner) || (a.postedDate < b.postedDate ? 1 : -1));

    return {
        needsJob: needsJob.map(toIntakeRow),
        needsReview: needsReview.map(toIntakeRow),
        booking: booking.map(toIntakeRow),
        bookedToday: bookedToday.map(toIntakeRow),
        duplicates: duplicates.map(toIntakeRow),
        exceptions: exceptions.map(toIntakeRow),
        uncertainCards: uncertainCardRows.map(toUncertainCardRow),
        missingReceipts,
        counts: {
            needsJob: needsJobCount,
            needsReview: needsReviewCount,
            booking: bookingCount,
            bookedToday: bookedTodayCount,
            duplicates: duplicatesCount,
            exceptions: exceptionsCount,
            uncertainCards: uncertainCardCount,
            // A real count query, like the other five. Deriving this from the
            // capped list understated the queue the moment it exceeded
            // RECEIPT_GROUP_TAKE — a 300-item backlog would have read as "100",
            // which is the specific failure the count-query rule exists to
            // prevent. The owner filter cannot go into SQL (owner lives inside
            // a JSON blob), so this counts the WHOLE open queue; the two
            // numbers are reconciled for the reader by `missingReceiptsShown`.
            missingReceipts: missingReceiptsCount,
            missingReceiptsShown: missingReceipts.length,
        },
    };
}

/** Open jobs for the "Set job" picker. Small, ordered, and cheap. */
export async function fetchJobOptions(): Promise<Array<{ id: string; name: string }>> {
    return prisma.project.findMany({
        where: { status: { in: OPEN_PROJECT_STATUSES } },
        orderBy: { name: "asc" },
        take: 200,
        select: { id: true, name: true },
    });
}
