import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isCronAuthorized } from "@/lib/cron-auth";
import { evaluateReviewIssue } from "@/lib/review-alert-lifecycle";
import { decodeReasonCodes } from "@/lib/review-alert-reasons";
import { RECEIPT_REQUEST_TARGET_TYPE, appendCardRecord } from "@/lib/receipt-requests";
import {
    CARD_OWNERS_ASKED,
    CARD_RATE_CEILING,
    buildCardFromItems,
    isPacificWeekday,
    pacificDate,
    postOwnerCard,
    selectOwnerItems,
    type CardCandidateIssue,
    type CardItem,
    type OwnerCard,
} from "@/lib/receipt-request-cards";
import { parseMissingReceiptDetails } from "@/app/automation/receipts-data";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Per-owner missing-receipt Chat digest (Phase 2 §4). Weekday mornings, 14:30
 * UTC (7:30 AM PDT; drifts to 6:30 in PST — accepted, same as every other cron
 * here).
 *
 * Ships DISABLED. `RECEIPT_REQUEST_CARDS_ENABLED` must be exactly "true", so
 * the matcher and the Receipts tab run silently for a shakedown week before
 * anyone's phone buzzes. Justin turns Beverly's own missing-receipt asks off in
 * the same step he flips this on — two chase surfaces at once is worse than
 * none (spec risk 5).
 *
 * IDEMPOTENCY IS A DATABASE CLAIM, NOT A CHAT FEATURE. An incoming webhook
 * offers no message-level idempotency; `threadKey` only guarantees a retry
 * lands in the same thread, never that it doesn't post twice into it. So
 * selection and the RECORD of selection happen in one transaction: a
 * `ReceiptRequestCard` row unique on (owner, pacificDate), holding the chosen
 * ReviewIssue ids immutably. A second concurrent run loses that insert and
 * posts nothing.
 *
 * THE ONE FAILURE WINDOW, documented rather than engineered away: the post
 * happens AFTER the claim commits, and `postedAt` is written after the webhook
 * answers. A crash in between leaves a claimed-but-unposted row, and the next
 * run re-posts that exact row (same ids, same order). Worst case is ONE
 * duplicate card; the alternative — marking sent before posting — silently
 * drops the day's chase, which is worse.
 *
 * NEVER emails anything. The whole point is a reply-in-thread chase.
 */

const CLAIM_LOCK_KEY = "receipt-request-cards";

/** Page size for the candidate scan. See scanCandidates for why it pages. */
const SCAN_PAGE_SIZE = 500;
/** Hard stop, so a pathological backlog cannot run the request out of time. */
const SCAN_MAX_PAGES = 20;

/**
 * How long a claimed-but-unposted row is left alone before another run will
 * re-post it.
 *
 * The advisory lock above is transaction-scoped and is released the moment the
 * CLAIM transaction commits — which is before any card is posted (the same
 * caveat the intake worker documents). So two overlapping invocations can both
 * get past it, and without this lease the second one would find the first's
 * still-in-flight row, "resume" it, and post the card twice. A row younger than
 * the lease is assumed to belong to a run that is still going.
 */
const RESUME_AFTER_MS = 10 * 60_000;

async function claim(): Promise<boolean> {
    return prisma.$transaction(async tx => {
        const [lock] = await tx.$queryRaw<{ locked: boolean }[]>(
            Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${CLAIM_LOCK_KEY}, 0)) AS locked`,
        );
        return lock?.locked === true;
    });
}

function str(value: unknown): string | null {
    return typeof value === "string" && value !== "" ? value : null;
}

function toCandidate(issue: {
    id: string; targetKey: string; reasonCodes: string; acknowledgedCodes: string; displayDetails: string | null;
}): CardCandidateIssue {
    const details = parseMissingReceiptDetails(issue.displayDetails);
    const currentCodes = decodeReasonCodes(issue.reasonCodes);
    const acked = new Set(decodeReasonCodes(issue.acknowledgedCodes));
    const cards = Array.isArray(details.cards) ? (details.cards as unknown[]) : [];
    return {
        id: issue.id,
        targetKey: issue.targetKey,
        owner: str(details.owner) ?? "unassigned",
        acknowledged: currentCodes.length > 0 && currentCodes.every(code => acked.has(code)),
        cardTail: str(details.cardTail),
        postedDate: str(details.postedDate) ?? "",
        amountCents: typeof details.amountCents === "number" ? details.amountCents : 0,
        payee: str(details.payee) ?? "",
        fingerprint: str(details.fingerprint) ?? `pb-${issue.targetKey}`,
        everCarded: cards.length > 0 || (details.card !== undefined && details.card !== null),
    };
}

/**
 * Collect enough candidates for every asked owner.
 *
 * WHY THIS PAGES INSTEAD OF `take: 200`. A flat cap ordered by age is a
 * starvation bug: `office` and `unassigned` items (which nobody is ever asked
 * about) are the majority of the queue and are also the oldest, so they filled
 * the window and CJ's and Richard's items never appeared on a card at all.
 *
 * The obvious fix — filter owner in SQL — is not available: `owner` lives
 * inside `displayDetails`, a TEXT column holding JSON, and casting it to jsonb
 * raises on a single malformed row, which would take the whole cron down. (The
 * page loader guards against exactly that.) `acknowledgedCodes` IS a real
 * column, so the acknowledged filter does run in the query; for this target
 * type the code set is always exactly ["MISSING_RECEIPT"], so "contains it" and
 * "acknowledged" are the same statement.
 *
 * So the scan pages oldest-first and stops as soon as every asked owner has a
 * full card's worth (or the queue is exhausted). Bounded either way.
 */
async function scanCandidates(): Promise<{ candidates: CardCandidateIssue[]; pages: number; exhausted: boolean }> {
    const candidates: CardCandidateIssue[] = [];
    const perOwner = new Map<string, number>(CARD_OWNERS_ASKED.map(owner => [owner, 0]));
    let cursor: string | undefined;
    let pages = 0;
    let exhausted = false;

    while (pages < SCAN_MAX_PAGES) {
        const page = await prisma.reviewIssue.findMany({
            where: {
                targetType: RECEIPT_REQUEST_TARGET_TYPE,
                clearedAt: null,
                // A real column, so this one genuinely narrows the query.
                NOT: { acknowledgedCodes: { contains: "MISSING_RECEIPT" } },
            },
            orderBy: [{ firstObservedAt: "asc" }, { id: "asc" }],
            take: SCAN_PAGE_SIZE,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            select: { id: true, targetKey: true, reasonCodes: true, acknowledgedCodes: true, displayDetails: true },
        });
        pages++;
        if (page.length === 0) { exhausted = true; break; }
        cursor = page[page.length - 1].id;

        for (const row of page) {
            const candidate = toCandidate(row);
            if (!CARD_OWNERS_ASKED.includes(candidate.owner as never)) continue;
            if (candidate.acknowledged) continue;
            candidates.push(candidate);
            perOwner.set(candidate.owner, (perOwner.get(candidate.owner) ?? 0) + 1);
        }
        if (page.length < SCAN_PAGE_SIZE) { exhausted = true; break; }
        // Enough for a full card each, INCLUDING the never-carded ordering
        // headroom (twice the ceiling), so the priority rule still has a real
        // choice to make rather than being decided by where the scan stopped.
        const enough = CARD_OWNERS_ASKED.every(owner => (perOwner.get(owner) ?? 0) >= CARD_RATE_CEILING * 2);
        if (enough) break;
    }

    return { candidates, pages, exhausted };
}

/** Parse a claimed row's immutable item snapshot back into card items. */
function parseItems(itemsJson: string): CardItem[] {
    try {
        const parsed: unknown = JSON.parse(itemsJson);
        return Array.isArray(parsed) ? (parsed as CardItem[]) : [];
    } catch {
        return [];
    }
}

/**
 * Record the thread each listed item was asked in, on the item's own issue.
 * This is history the sweep reads, not a claim — the claim is the outbox row —
 * and it rides `displayDetails`, which is deliberately not part of the reason
 * hash, so writing it opens no new generation and sends no second alert.
 */
async function recordCardOnIssues(card: OwnerCard, threadName: string | null, messageName: string | null, now: Date) {
    for (const item of card.items) {
        const issue = await prisma.reviewIssue.findUnique({
            where: { id: item.issueId },
            select: { displayDetails: true, reasonCodes: true, clearedAt: true },
        });
        if (!issue || issue.clearedAt !== null) continue;
        const details = appendCardRecord(
            parseMissingReceiptDetails(issue.displayDetails),
            { threadName, messageName, n: item.n, date: card.date, requestId: card.requestId },
            now,
        );
        await evaluateReviewIssue(
            RECEIPT_REQUEST_TARGET_TYPE,
            item.targetKey,
            decodeReasonCodes(issue.reasonCodes),
            details,
            { episodeStatus: "SUPPRESSED" },
        );
    }
}

function isUniqueConstraintError(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export async function GET(request: Request) {
    if (!isCronAuthorized(request)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (process.env.RECEIPT_REQUEST_CARDS_ENABLED !== "true") {
        return NextResponse.json({ ok: true, skipped: "disabled" });
    }
    const now = new Date();
    if (!isPacificWeekday(now)) {
        return NextResponse.json({ ok: true, skipped: "weekend" });
    }
    const webhookUrl = process.env.RECEIPTS_CHAT_WEBHOOK;
    if (!webhookUrl) {
        // Fail soft: the queue page still shows every one of these.
        return NextResponse.json({ ok: true, skipped: "no-webhook" });
    }
    if (!(await claim())) {
        return NextResponse.json({ ok: true, skipped: "locked" });
    }

    const date = pacificDate(now);
    const scan = await scanCandidates();
    const toPost: Array<{ card: OwnerCard; rowId: string; resumed: boolean }> = [];

    for (const owner of CARD_OWNERS_ASKED) {
        // RESUME FIRST. A claimed row with no postedAt is last run's crash
        // between commit and post; re-post it verbatim from its immutable
        // snapshot rather than re-selecting (which would renumber the items a
        // "sign 2" reply resolves against).
        const claimed = await prisma.receiptRequestCard.findUnique({
            where: { owner_pacificDate: { owner, pacificDate: date } },
            select: { id: true, itemsJson: true, overflow: true, postedAt: true, createdAt: true },
        });
        if (claimed) {
            if (claimed.postedAt !== null) continue; // already asked today
            // Younger than the lease: another invocation is mid-flight. Leave
            // it be — resuming here is how you post the same card twice.
            if (now.getTime() - claimed.createdAt.getTime() < RESUME_AFTER_MS) continue;
            const items = parseItems(claimed.itemsJson);
            if (items.length === 0) continue;
            toPost.push({ card: buildCardFromItems(owner, date, items, claimed.overflow), rowId: claimed.id, resumed: true });
            continue;
        }

        const { items, overflow } = selectOwnerItems(scan.candidates, owner);
        if (items.length === 0) continue;
        try {
            // THE CLAIM: selection and the record of it are one write. A
            // concurrent run loses the unique index and posts nothing.
            const row = await prisma.receiptRequestCard.create({
                data: { owner, pacificDate: date, itemsJson: JSON.stringify(items), overflow },
                select: { id: true },
            });
            toPost.push({ card: buildCardFromItems(owner, date, items, overflow), rowId: row.id, resumed: false });
        } catch (error) {
            if (isUniqueConstraintError(error)) continue; // the other run won
            throw error;
        }
    }

    const posted: Array<{ owner: string; items: number; threadName: string | null; resumed: boolean }> = [];
    for (const { card, rowId, resumed } of toPost.slice(0, CARD_RATE_CEILING)) {
        const result = await postOwnerCard(webhookUrl, card);
        if (!result) {
            await prisma.receiptRequestCard.update({
                where: { id: rowId },
                data: { attempts: { increment: 1 }, lastError: "post-failed" },
            });
            continue;
        }
        await prisma.receiptRequestCard.update({
            where: { id: rowId },
            data: {
                postedAt: new Date(),
                threadName: result.threadName,
                messageName: result.messageName,
                attempts: { increment: 1 },
                lastError: null,
            },
        });
        await recordCardOnIssues(card, result.threadName, result.messageName, now);
        posted.push({ owner: card.owner, items: card.items.length, threadName: result.threadName, resumed });
    }

    const summary = {
        ok: true,
        date,
        scanned: scan.candidates.length,
        scanPages: scan.pages,
        scanExhausted: scan.exhausted,
        claimed: toPost.length,
        posted,
    };
    if (toPost.length > 0) console.log("[cron/receipt-request-cards]", JSON.stringify(summary));
    return NextResponse.json(summary);
}
